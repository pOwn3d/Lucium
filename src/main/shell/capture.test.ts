import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayRequest } from '@shared/ipc'

const pictures = vi.hoisted(() => ({ dir: '', notices: [] as Array<{ title: string; body: string }> }))
const clipboardWrite = vi.hoisted(() => vi.fn(async (_items: unknown) => undefined))
vi.mock('electron', () => ({
  app: { getPath: () => pictures.dir },
  clipboard: { write: clipboardWrite },
  ClipboardItem: class {
    constructor(readonly items: unknown) {}
  },
  Notification: class {
    constructor(options: { title: string; body: string }) {
      pictures.notices.push(options)
    }
    on(): void {}
    show(): void {}
  },
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('./portrait', () => ({ renderPortrait: vi.fn() }))

import { CaptureShelf } from './capture-shelf'
import { captureSelectionOrTell, deliverCapture, finishAnnotation, saveCapture, type AnnotateHost } from './capture'
import { tempDir } from '../temp-dir'

beforeEach(() => {
  pictures.dir = tempDir('lucium-pictures-')
  pictures.notices.length = 0
  clipboardWrite.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('saveCapture', () => {
  it('keeps both of two captures of the same kind taken in the same second', async () => {
    const first = await saveCapture(Buffer.from('first'), '-zone')
    const second = await saveCapture(Buffer.from('second'), '-zone')
    const third = await saveCapture(Buffer.from('third'), '-zone')
    expect(new Set([first, second, third]).size).toBe(3)
    expect([first, second, third].map((p) => readFileSync(p, 'utf8'))).toEqual(['first', 'second', 'third'])
    expect(first.endsWith('capture-2026-10-24T10-00-00-zone.png')).toBe(true)
    expect(readdirSync(join(pictures.dir, 'Lucium'))).toHaveLength(3)
  })

  it('names captures of another kind, or of another second, by their own stamp', async () => {
    const a = await saveCapture(Buffer.from('a'), '')
    const b = await saveCapture(Buffer.from('b'), '-page-entiere')
    vi.setSystemTime(new Date('2026-10-24T10:00:01Z'))
    const c = await saveCapture(Buffer.from('c'), '')
    expect([a, b, c].map((p) => basename(p))).toEqual(['capture-2026-10-24T10-00-00.png', 'capture-2026-10-24T10-00-00-page-entiere.png', 'capture-2026-10-24T10-00-01.png'])
  })
})

describe('saveCapture options', () => {
  it('copies and says so by default, as every capture always did', async () => {
    const path = await saveCapture(Buffer.from('x'), '')
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(pictures.notices).toEqual([{ title: 'Capture enregistrée', body: `${path}\nCopiée dans le presse-papiers.`, silent: true }])
  })

  it('writes the file only when asked not to copy, and stays silent when asked not to notify', async () => {
    const path = await saveCapture(Buffer.from('x'), '-zone', { copy: false })
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(pictures.notices[0]?.body).toBe(path)
    pictures.notices.length = 0
    await saveCapture(Buffer.from('y'), '-zone', { copy: false, notify: false })
    expect(pictures.notices).toEqual([])
  })
})

// ---------- the annotation sheet ----------

function pngOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

/** A browser as the capture flow sees one: the real shelf, a panel that opens unless it is told not to, and the calls written down. */
function browser(enabled = true) {
  const t = {
    enabled,
    panel: null as OverlayRequest | null,
    refuseOverlay: false,
    calls: [] as string[],
    toasts: [] as string[],
    shared: [] as string[]
  }
  const shelf = new CaptureShelf(
    () => t.enabled,
    () => t.panel
  )
  const host: AnnotateHost = {
    holdCapture: (png, suffix) => shelf.hold(png, suffix),
    openOverlay: (request) => {
      t.calls.push(`open:${request.panel}`)
      if (!t.refuseOverlay) t.panel = request
    },
    currentOverlay: () => t.panel,
    dropCapture: (id) => {
      t.calls.push('drop')
      shelf.drop(id)
    },
    heldCapture: (id) => shelf.get(id),
    closeOverlay: () => {
      t.calls.push('close')
      t.panel = null
    },
    showToast: (message) => void t.toasts.push(message),
    shareFile: (path) => {
      t.calls.push('share')
      t.shared.push(path)
    },
    openFile: (path) => {
      t.calls.push('open')
      t.shared.push(path)
    }
  }
  return { t, host, shelf }
}

const files = () => readdirSync(join(pictures.dir, 'Lucium'))

describe('deliverCapture', () => {
  it('saves and copies at once when the sheet is off, and opens no panel: the direct flow', async () => {
    const b = browser(false)
    const path = await deliverCapture(b.host, pngOf(800, 600), '-zone')
    expect(path?.endsWith('-zone.png')).toBe(true)
    expect(files()).toHaveLength(1)
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(b.t.calls).toEqual([])
  })

  it('holds the capture and opens the sheet when it is on, and writes nothing yet', async () => {
    const b = browser()
    expect(await deliverCapture(b.host, pngOf(800, 600), '-zone')).toBeNull()
    expect(b.t.panel).toMatchObject({ panel: 'annotate', width: 800, height: 600 })
    expect(b.shelf.holding()).toBe(true)
    expect(() => files()).toThrow()
    expect(clipboardWrite).not.toHaveBeenCalled()
  })

  it('saves a picture the sheet cannot take as it always was', async () => {
    const b = browser()
    expect(await deliverCapture(b.host, pngOf(20_000, 20_000), '')).not.toBeNull()
    expect(files()).toHaveLength(1)
    expect(b.t.calls).toEqual([])
  })

  it('does not lose the capture when another panel keeps the place: it is saved, the hold is dropped and the log says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const b = browser()
    b.t.refuseOverlay = true
    expect(await deliverCapture(b.host, pngOf(800, 600), '')).not.toBeNull()
    expect(files()).toHaveLength(1)
    expect(b.shelf.holding()).toBe(false)
    expect(warn.mock.calls.join(' ')).toContain('could not open')
  })
})

describe('finishAnnotation', () => {
  /** The sheet is open on a capture; `png` is what it sends back. */
  async function opened(action: unknown = 'save', png: Uint8Array = pngOf(800, 600)) {
    const b = browser()
    await deliverCapture(b.host, pngOf(800, 600), '-zone')
    const id = (b.t.panel as { id: string }).id
    b.t.calls.length = 0
    return { ...b, request: { id, action, png } }
  }

  it('saves the picture drawn on, under its own name, without copying, and closes the sheet', async () => {
    const o = await opened('save')
    expect(await finishAnnotation(o.host, o.request)).toEqual({ ok: true })
    expect(files()).toEqual(['capture-2026-10-24T10-00-00-zone-annote.png'])
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(pictures.notices).toHaveLength(1)
    expect(o.t.calls).toEqual(['drop', 'close'])
    expect(o.shelf.holding()).toBe(false)
  })

  it('copies without writing a file, says so in the window and closes the sheet', async () => {
    const o = await opened('copy')
    expect(await finishAnnotation(o.host, o.request)).toEqual({ ok: true })
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(() => files()).toThrow()
    expect(o.t.toasts).toEqual(['Capture copiée dans le presse-papiers'])
    expect(o.t.calls).toEqual(['drop', 'close'])
  })

  it('shares from a saved file: the sheet goes first, then the menu opens on the file', async () => {
    const o = await opened('share')
    expect(await finishAnnotation(o.host, o.request)).toEqual({ ok: true })
    expect(o.t.calls).toEqual(['drop', 'close', 'share'])
    expect(o.t.shared).toHaveLength(1)
    expect(o.t.shared[0]).toBe(join(pictures.dir, 'Lucium', 'capture-2026-10-24T10-00-00-zone-annote.png'))
    expect(readFileSync(o.t.shared[0]!)).toEqual(pngOf(800, 600))
    expect(pictures.notices).toEqual([])
    expect(clipboardWrite).not.toHaveBeenCalled()
  })

  it('answers that the capture is gone when no sheet is open for it, and does nothing', async () => {
    const o = await opened()
    for (const id of ['11111111-1111-1111-1111-111111111111', undefined, 7]) {
      expect(await finishAnnotation(o.host, { ...o.request, id }), String(id)).toEqual({ ok: false, message: 'Cette capture n’est plus disponible.' })
    }
    expect(await finishAnnotation(o.host, null)).toMatchObject({ ok: false })
    o.t.panel = null
    expect(await finishAnnotation(o.host, o.request)).toMatchObject({ ok: false })
    expect(() => files()).toThrow()
    expect(o.t.calls).toEqual([])
  })

  it('refuses a request that is not the sheet’s: an unknown action, a picture of another size or that is not a PNG; writes nothing and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const o = await opened()
    const refused = { ok: false, message: 'L’image envoyée par la feuille n’est pas valide.' }
    expect(await finishAnnotation(o.host, { ...o.request, action: 'delete' })).toEqual(refused)
    expect(await finishAnnotation(o.host, { ...o.request, png: pngOf(10, 10) })).toEqual(refused)
    expect(await finishAnnotation(o.host, { ...o.request, png: Buffer.from('<html>not a picture, but long enough to have a header</html>') })).toEqual(refused)
    expect(() => files()).toThrow()
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(o.t.calls).toEqual([])
    expect(o.shelf.holding()).toBe(true)
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['[capture] the annotation sheet sent a request that was refused (action)', '[capture] the annotation sheet sent a request that was refused (picture)', '[capture] the annotation sheet sent a request that was refused (picture)'])
  })

  it('keeps the sheet and the capture when saving fails, tells the user why and logs the cause', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const o = await opened('save')
    // A file where the folder of the captures should be: the folder cannot be made.
    writeFileSync(join(pictures.dir, 'Lucium'), 'in the way')
    const reply = await finishAnnotation(o.host, o.request)
    expect(reply.ok).toBe(false)
    expect(!reply.ok && reply.message).toMatch(/^La capture n’a pas pu être enregistrée\./)
    expect(error.mock.calls[0]?.[0]).toBe('[capture] annotated capture: save failed:')
    expect(o.t.calls).toEqual([])
    expect(o.shelf.holding()).toBe(true)
  })

  it('keeps the sheet when the clipboard refuses, and does not say it copied', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const o = await opened('copy')
    clipboardWrite.mockRejectedValueOnce(new Error('clipboard busy'))
    const reply = await finishAnnotation(o.host, o.request)
    expect(reply).toEqual({ ok: false, message: 'La capture n’a pas pu être copiée. clipboard busy' })
    expect(o.t.toasts).toEqual([])
    expect(o.t.calls).toEqual([])
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('captureSelectionOrTell', () => {
  const RECT = { x: 10, y: 10, width: 100, height: 80 }
  /** A browser that holds nothing and takes the capture `region` gives (or fails with `error`). */
  const browserOf = (region: () => Promise<Buffer | null>) => ({ captureRegion: region, holdCapture: () => null }) as unknown as Parameters<typeof captureSelectionOrTell>[0]

  it('saves the picture and says nothing when it works', async () => {
    const toast = vi.fn()
    await captureSelectionOrTell(browserOf(async () => Buffer.from('png')), RECT, toast)
    expect(readdirSync(join(pictures.dir, 'Lucium'))).toHaveLength(1)
    expect(toast).not.toHaveBeenCalled()
  })

  it('tells the user, with a toast, when the capture fails: the selection layer is gone and nothing else would say that no picture was made', async () => {
    const toast = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await captureSelectionOrTell(
      browserOf(async () => {
        throw new Error('the page is gone')
      }),
      RECT,
      toast
    )
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![0]).toContain('capture')
    expect(error).toHaveBeenCalledWith('[capture] region capture failed:', expect.any(Error))
  })

  it('tells the user too when the picture cannot be written (a full disk)', async () => {
    const toast = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // A file where the parent of the folder should be: it cannot be made (ENOTDIR), on every system (a path under /dev/null would be a plain folder on Windows).
    const blocker = join(pictures.dir, 'blocker')
    writeFileSync(blocker, 'a file')
    pictures.dir = join(blocker, 'not-a-folder')
    await captureSelectionOrTell(browserOf(async () => Buffer.from('png')), RECT, toast)
    expect(toast).toHaveBeenCalledTimes(1)
  })
})
