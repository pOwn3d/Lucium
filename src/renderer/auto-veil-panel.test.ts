// @vitest-environment happy-dom
// The veil measured from a file of the user's, in the panels: the measure itself around its reader of frames (the URL let go, the time limit, the
// safe veil and its line in the console when anything fails), the file added in the media panel (measured once, or not when the look it replaces was
// set by hand), and Personnaliser l'espace (a change by hand stops the measured look; « Revenir au réglage automatique » measures the file again).
// The frames themselves are decoded only by Chromium: smoke-auto-veil.ts checks that part in a real window.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { SidebarState, Space } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { AUTO_VEIL_FALLBACK, autoVeil, measureFrames, withAutoVeil, type AutoVeilLook, type FramePixels } from '@shared/auto-veil'
import type { SpaceBackground } from '@shared/space-media'
import type { SpaceBackgroundMediaReply } from '@shared/space-background-media'
import { builtinVideoFile } from '@shared/builtin-backgrounds'
import { button, installBridge, mount, settle, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({
  snapshot: null as unknown,
  dispatched: [] as unknown[],
  measureFile: null as null | ((filename: string) => Promise<{ look: AutoVeilLook; measured: boolean }>)
}))
vi.mock('./api', () => ({
  api: () => ({ dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()), closeOverlay: () => undefined, openOverlay: () => undefined }),
  useSnapshot: () => holder.snapshot
}))
// Personnaliser l'espace measures the file through this; the rest of the probe is the real one.
vi.mock('./background-probe', async (original) => ({ ...(await original<typeof import('./background-probe')>()), measureBackgroundFile: (filename: string) => holder.measureFile!(filename) }))

import { measureBackground } from './background-probe'
import { SpaceCustomize } from './SpaceCustomize'
import { SpaceMediaPanel } from './SpaceMediaPanel'

const probe = await vi.importActual<typeof import('./background-probe')>('./background-probe')

/** A frame of one colour. */
function plain(r: number, g: number, b: number): FramePixels {
  const data = new Uint8ClampedArray(4 * 4 * 4)
  for (let i = 0; i < 16; i++) data.set([r, g, b, 255], i * 4)
  return { data, width: 4, height: 4 }
}

const BYTES = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>
const USER_FILE = '1730000000000-0a1b2c3d.png'
const measuredLook = autoVeil({ meanY: 40, p95: 0.1, p05: 0.001 }).look
let warnings: unknown[][] = []
let mounted: Mounted | null = null

beforeEach(() => {
  setLanguage('fr')
  holder.dispatched.length = 0
  holder.measureFile = null
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args))
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${(blob as Blob).type}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
  delete (window as unknown as { lucium?: unknown }).lucium
})

describe('the measure of a file', () => {
  it('reads the frames from a blob URL of the bytes, works out the look, and lets the URL go', async () => {
    const read = vi.fn(async () => [plain(255, 255, 255)])
    const result = await measureBackground(BYTES, 'image/png', { read })
    expect(result).toEqual({ look: autoVeil(measureFrames([plain(255, 255, 255)])).look, measured: true })
    expect(result.look.veilColor).toBe('#f4f4f6')
    expect(read).toHaveBeenCalledWith('blob:image/png', BYTES, 'image/png', expect.any(AbortSignal))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image/png')
    expect(warnings).toEqual([])
  })

  it('gives the safe veil when the frames cannot be read, says why in the console, and lets the URL go', async () => {
    const result = await measureBackground(BYTES, 'video/mp4', { read: () => Promise.reject(new Error('the video did not decode (4 MEDIA_ERR_SRC_NOT_SUPPORTED)')) })
    expect(result).toEqual({ look: AUTO_VEIL_FALLBACK, measured: false })
    expect(String(warnings[0]?.[0])).toContain('[space media] the video/mp4 background could not be measured')
    expect(String(warnings[0]?.[1])).toContain('did not decode')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video/mp4')
  })

  it('stops a reading that takes too long, gives the safe veil, and tells the reader to let go', async () => {
    let signal: AbortSignal | null = null
    const result = await measureBackground(BYTES, 'video/webm', {
      timeoutMs: 20,
      read: (_url, _bytes, _type, given) => {
        signal = given
        return new Promise(() => undefined)
      }
    })
    expect(result).toEqual({ look: AUTO_VEIL_FALLBACK, measured: false })
    expect(signal!.aborted).toBe(true)
    expect(String(warnings[0]?.[1])).toContain('no frame after 20 ms')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video/webm')
  })

  it('gives the safe veil for frames that came out black, and says so', async () => {
    const result = await measureBackground(BYTES, 'video/mp4', { read: async () => [plain(0, 0, 0), plain(1, 1, 1)] })
    expect(result).toEqual({ look: AUTO_VEIL_FALLBACK, measured: false })
    expect(String(warnings[0]?.[0])).toContain('gave no frame to measure (2 read')
  })

  it('reads the file of a space again to measure it, and gives the safe veil when it cannot be read', async () => {
    installBridge({ spaceBackgroundMedia: async () => ({ ok: true, data: BYTES, mimeType: 'image/png' }) })
    expect(await probe.measureBackgroundFile(USER_FILE, { read: async () => [plain(20, 20, 30)] })).toMatchObject({ measured: true, look: { veilColor: '#0b0c12' } })
    installBridge({ spaceBackgroundMedia: async () => ({ ok: false, message: 'absent' }) })
    expect(await probe.measureBackgroundFile(USER_FILE, { read: async () => [plain(20, 20, 30)] })).toEqual({ look: AUTO_VEIL_FALLBACK, measured: false })
    expect(String(warnings.at(-1)?.[0])).toContain(`the background ${USER_FILE} could not be read to measure it`)
  })
})

describe('a file added in the media panel', () => {
  const base = createInitialState({ now: 1, newId: () => 'id' }).spaces[0]!
  const spaceWith = (background: SpaceBackground | undefined): Space => ({ ...base, background }) as Space

  /** The panel of a space with this background; the file input given a picture; what the panel then passed on. */
  async function addPicture(background: SpaceBackground | undefined, measured: { look: AutoVeilLook; measured: boolean }) {
    installBridge({
      spaceBackgroundMedia: async (request: { op: string; filename?: string }): Promise<SpaceBackgroundMediaReply> => {
        if (request.op === 'upload') return { ok: true, filename: USER_FILE } as SpaceBackgroundMediaReply
        if (request.filename === USER_FILE || request.filename === background?.value) return { ok: true, data: BYTES, mimeType: 'image/png' } as SpaceBackgroundMediaReply
        return { ok: false, message: 'absent' } as SpaceBackgroundMediaReply
      }
    })
    const measure = vi.fn(async () => measured)
    const changes: unknown[] = []
    mounted = mount(createElement(SpaceMediaPanel, { space: spaceWith(background), onMediaChange: (media) => void changes.push(media), measure }))
    await settle()
    const input = mounted.container.querySelector<HTMLInputElement>('input[type="file"]')!
    const picture = { type: 'image/png', size: 3, arrayBuffer: async () => BYTES.buffer }
    Object.defineProperty(input, 'files', { configurable: true, value: { length: 1, item: () => picture } })
    await settle(() => void input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    return { measure, changes, note: () => mounted!.container.querySelector('.media-info[role="status"]')?.textContent ?? null }
  }

  it('is measured once, from the bytes the panel read back, and comes with its look', async () => {
    const { measure, changes, note } = await addPicture(undefined, { look: measuredLook, measured: true })
    expect(measure).toHaveBeenCalledTimes(1)
    expect(measure).toHaveBeenCalledWith(BYTES, 'image/png')
    expect(changes).toEqual([{ filename: USER_FILE, mimeType: 'image/png', look: measuredLook }])
    expect(note()).toBeNull()
  })

  it('is measured in place of a file whose look was measured', async () => {
    const { measure } = await addPicture({ type: 'image', value: 'old.png', ...measuredLook }, { look: measuredLook, measured: true })
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('is not measured in place of a file whose look was set by hand, and comes without a look (the one set by hand is kept)', async () => {
    const { measure, changes } = await addPicture({ type: 'image', value: 'old.png', veilColor: '#14213d', veil: 80 }, { look: measuredLook, measured: true })
    expect(measure).not.toHaveBeenCalled()
    expect(changes).toEqual([{ filename: USER_FILE, mimeType: 'image/png' }])
  })

  it('says, when it could not be measured, that a safe veil covers it', async () => {
    const { changes, note } = await addPicture(undefined, { look: AUTO_VEIL_FALLBACK, measured: false })
    expect(changes).toEqual([{ filename: USER_FILE, mimeType: 'image/png', look: AUTO_VEIL_FALLBACK }])
    expect(note()).toBe(t('space-media.veil-auto-failed'))
  })
})

describe('the veil in Personnaliser l’espace', () => {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }

  /** The panel of a space whose background is `background`; the state follows what the panel dispatches. */
  function open(background: SpaceBackground): { state: () => SidebarState; spaceId: string; redraw: (next: SidebarState) => void } {
    let state = createInitialState(ctx)
    const spaceId = state.spaces[0]!.id
    state = reduce(state, { type: 'space/update', id: spaceId, patch: { background } }, ctx)
    holder.snapshot = { state, extensions: [], downloads: [], runtime: { tabs: {} } }
    installBridge({ spaceBackgroundMedia: async () => ({ ok: false, message: 'absent' }) })
    mounted = mount(createElement(SpaceCustomize, { spaceId }))
    holder.dispatched.length = 0
    const redraw = (next: SidebarState) => {
      state = next
      holder.snapshot = { state, extensions: [], downloads: [], runtime: { tabs: {} } }
      mounted!.rerender(createElement(SpaceCustomize, { spaceId }))
    }
    return { state: () => state, spaceId, redraw }
  }
  const status = () => mounted!.container.querySelector('.space-veil-auto [role="status"]')?.textContent ?? null
  const restore = () => button(mounted!.container, t('space-media.veil-auto-restore'))
  const lastBackground = () => (holder.dispatched.at(-1) as Extract<Action, { type: 'space/update' }> | undefined)?.patch.background
  const measuredFile: SpaceBackground = { type: 'image', value: USER_FILE, ...measuredLook }

  it('says that the look was measured, and has nothing to bring back then: the button stays, greyed, and does nothing', async () => {
    holder.measureFile = vi.fn()
    open(measuredFile)
    expect(status()).toBe(t('space-media.veil-auto-on'))
    expect(restore().getAttribute('aria-disabled')).toBe('true')
    // Greyed with aria-disabled, not `disabled`: it keeps the focus of the keyboard where it is.
    expect(restore().hasAttribute('disabled')).toBe(false)
    expect(restore().type).toBe('button')
    restore().click()
    await settle()
    expect(holder.measureFile).not.toHaveBeenCalled()
    expect(holder.dispatched).toEqual([])
  })

  it('stops the measured look at a move of the slider, the strength kept as it is set', async () => {
    open(measuredFile)
    const slider = mounted!.container.querySelector<HTMLInputElement>('input[type="range"]')!
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await settle(() => {
      set.call(slider, '75')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const { veilAuto: _auto, ...byHand } = measuredFile
    expect(lastBackground()).toEqual({ ...byHand, veil: 75 })
  })

  it('stops the measured look at any other change of the look made by hand: veil colour, shape, text colour, shadow', async () => {
    const changes: Array<[string, () => Element]> = [
      ['veil colour', () => mounted!.container.querySelector(`[aria-label="${t('space-media.voile')}"] button[aria-checked="false"]:not(.none)`)!],
      ['no veil', () => button(mounted!.container, t('space-media.aucun'))],
      ['shape', () => button(mounted!.container, t('space-media.voile-uniforme'))],
      ['tone', () => button(mounted!.container, t('space-media.tone-dark'))],
      ['text colour', () => mounted!.container.querySelector(`[aria-label="${t('space-media.text-palette')}"] button[aria-checked="false"]:not(.none)`)!],
      ['shadow', () => mounted!.container.querySelector('.space-halo input')!]
    ]
    for (const [what, control] of changes) {
      open(measuredFile)
      ;(control() as HTMLElement).click()
      await settle()
      expect(lastBackground(), what).toBeDefined()
      expect(lastBackground(), what).not.toHaveProperty('veilAuto')
      mounted!.unmount()
      mounted = null
    }
  })

  it('brings the measure back with « Revenir au réglage automatique », saying it measures meanwhile', async () => {
    let answer: (value: { look: AutoVeilLook; measured: boolean }) => void = () => undefined
    holder.measureFile = vi.fn(() => new Promise<{ look: AutoVeilLook; measured: boolean }>((resolve) => (answer = resolve)))
    const handSet: SpaceBackground = { type: 'image', value: USER_FILE, veilColor: '#14213d', veil: 80, tone: 'light' }
    open(handSet)
    expect(status()).toBe(t('space-media.veil-auto-off'))
    expect(restore().getAttribute('aria-disabled')).toBe('false')
    restore().click()
    await settle()
    expect(holder.measureFile).toHaveBeenCalledWith(USER_FILE)
    expect(status()).toBe(t('space-media.veil-auto-measuring'))
    expect(restore().getAttribute('aria-disabled')).toBe('true')
    await settle(() => answer({ look: measuredLook, measured: true }))
    expect(lastBackground()).toEqual(withAutoVeil(handSet, measuredLook))
    expect(lastBackground()).toEqual({ type: 'image', value: USER_FILE, ...measuredLook })
  })

  it('brings the safe veil back when the file could not be measured, and says so', async () => {
    holder.measureFile = vi.fn(async () => ({ look: AUTO_VEIL_FALLBACK, measured: false }))
    open({ type: 'image', value: USER_FILE, veilColor: '#14213d' })
    restore().click()
    await settle()
    expect(lastBackground()).toEqual({ type: 'image', value: USER_FILE, ...AUTO_VEIL_FALLBACK })
    expect(status()).toBe(t('space-media.veil-auto-failed'))
  })

  it('writes nothing when the space has another file by the time the measure answers', async () => {
    let answer: (value: { look: AutoVeilLook; measured: boolean }) => void = () => undefined
    holder.measureFile = vi.fn(() => new Promise<{ look: AutoVeilLook; measured: boolean }>((resolve) => (answer = resolve)))
    const { state, spaceId, redraw } = open({ type: 'image', value: USER_FILE, veilColor: '#14213d' })
    restore().click()
    await settle()
    redraw(reduce(state(), { type: 'space/update', id: spaceId, patch: { background: { type: 'image', value: 'other.png' } } }, ctx))
    holder.dispatched.length = 0
    await settle(() => answer({ look: measuredLook, measured: true }))
    expect(holder.dispatched).toEqual([])
  })

  it('is offered for a file of the user’s only: a video of Lucium comes with its own look', () => {
    open(builtinBackgroundOf('village'))
    expect(mounted!.container.querySelector('.space-veil-auto')).toBeNull()
  })
})

function builtinBackgroundOf(id: 'village'): SpaceBackground {
  return { type: 'video', value: builtinVideoFile(id), muted: true, loop: true, veilColor: '#0b0c12', veil: 60, veilShape: 'text', textColor: '#ffffff', textHalo: true }
}
