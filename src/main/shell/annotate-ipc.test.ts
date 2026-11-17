// The two channels of the annotation sheet, as `registerIpc` registers them for a window: who gets the picture, and what the sheet's choice may
// reach. What a choice does to the picture is tested with the capture (capture.test.ts, `finishAnnotation`); here it is the handlers that are
// run, with the guard of the window in its real place and a browser that records what it is asked.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const popup = vi.fn()
  return {
    popup,
    // Electron builds these with `new`: plain functions, not arrows.
    ShareMenu: vi.fn(function ShareMenu() {
      return { popup }
    }),
    BrowserWindow: { fromWebContents: vi.fn() },
    shell: { openPath: vi.fn(async () => '') }
  }
})
vi.mock('electron', () => electron)

const finishAnnotation = vi.hoisted(() => vi.fn())
vi.mock('./capture', () => ({ finishAnnotation }))

import { Channel } from '@shared/ipc'
import { t } from '@shared/i18n'
import type { AnnotateHost } from './capture'
import { registerAnnotateIpc } from './annotate-ipc'
import type { ScopedIpc } from './ipc-scope'

type Handler = (event: { sender: object }, raw: unknown) => unknown

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const WINDOW = { the: 'window of the registration' }

/** The channels of one window: the guard answers `trusted`, the browser holds a capture under the id `held`. */
function windowSheet(options: { trusted?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = { on: () => undefined, handle: (channel, listener) => void handlers.set(channel, listener as unknown as Handler) }
  const guard = vi.fn(() => options.trusted ?? true)
  const browser = {
    heldCapture: vi.fn((id: unknown) => (id === 'held' ? { id: 'held', png: PNG, suffix: 'page' } : null)),
    holdCapture: vi.fn(() => 'new-id'),
    openOverlay: vi.fn(),
    currentOverlay: vi.fn(() => ({ kind: 'annotate' })),
    dropCapture: vi.fn(),
    closeOverlay: vi.fn(),
    showToast: vi.fn()
  }
  registerAnnotateIpc(ipc, guard, browser as never, WINDOW as never)
  const sender = { the: 'sender' }
  return { guard, browser, sender, ask: (channel: string, raw: unknown) => handlers.get(channel)!({ sender }, raw) }
}

beforeEach(() => {
  for (const mock of [electron.popup, electron.ShareMenu, electron.BrowserWindow.fromWebContents, electron.shell.openPath, finishAnnotation]) mock.mockClear()
  electron.BrowserWindow.fromWebContents.mockReturnValue(null)
  finishAnnotation.mockResolvedValue({ ok: true })
})

describe('the picture of the annotation sheet (annotate-image)', () => {
  it('is given, whole, for the capture the browser holds under that id', async () => {
    const window = windowSheet()
    expect(await window.ask(Channel.annotateImage, 'held')).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(window.guard).toHaveBeenCalledWith(window.sender, Channel.annotateImage)
  })

  it('is not given for another id, or for something that is not an id', async () => {
    const window = windowSheet()
    for (const id of ['other', '', null, undefined, 4, { id: 'held' }]) expect(await window.ask(Channel.annotateImage, id)).toBeNull()
  })

  it('is refused when the guard of the window says no: the capture is not even looked for', async () => {
    const window = windowSheet({ trusted: false })
    expect(await window.ask(Channel.annotateImage, 'held')).toBeNull()
    expect(window.browser.heldCapture).not.toHaveBeenCalled()
  })
})

describe('the choice of the annotation sheet (annotate-done)', () => {
  it('is refused when the guard of the window says no: nothing is copied, saved or shared', async () => {
    const window = windowSheet({ trusted: false })
    expect(await window.ask(Channel.annotateDone, { id: 'held', action: 'copy' })).toEqual({ ok: false, message: t('feature.demande-refusee') })
    expect(window.guard).toHaveBeenCalledWith(window.sender, Channel.annotateDone)
    expect(finishAnnotation).not.toHaveBeenCalled()
  })

  it('goes to the capture as it was sent, and its answer comes back to the sheet', async () => {
    const window = windowSheet()
    const answer = { ok: false, message: 'the picture could not be saved' }
    finishAnnotation.mockResolvedValue(answer)
    const raw = { id: 'held', action: 'save', png: new Uint8Array([1]) }
    expect(await window.ask(Channel.annotateDone, raw)).toBe(answer)
    expect(finishAnnotation.mock.calls[0]![1]).toBe(raw)
  })

  it('lets the capture act on this browser only: its held picture, its overlay and its toasts', async () => {
    const window = windowSheet()
    await window.ask(Channel.annotateDone, { id: 'held' })
    const host = finishAnnotation.mock.calls[0]![0] as AnnotateHost
    expect(host.heldCapture('held')).toEqual({ id: 'held', png: PNG, suffix: 'page' })
    expect(host.holdCapture(PNG, 'page')).toBe('new-id')
    expect(window.browser.holdCapture).toHaveBeenCalledWith(PNG, 'page')
    host.dropCapture('held')
    expect(window.browser.dropCapture).toHaveBeenCalledWith('held')
    host.closeOverlay()
    expect(window.browser.closeOverlay).toHaveBeenCalledTimes(1)
    host.showToast('Copié')
    expect(window.browser.showToast).toHaveBeenCalledWith('Copié')
    expect(host.currentOverlay()).toEqual({ kind: 'annotate' })
    host.openOverlay({ kind: 'annotate' } as never)
    expect(window.browser.openOverlay).toHaveBeenCalledWith({ kind: 'annotate' })
  })

  it('opens the share menu on the saved file, over the window the sheet is in, or over the window of the registration when that one is gone', async () => {
    const window = windowSheet()
    await window.ask(Channel.annotateDone, { id: 'held' })
    const host = finishAnnotation.mock.calls[0]![0] as AnnotateHost

    const asking = { the: 'window the sheet is in' }
    electron.BrowserWindow.fromWebContents.mockReturnValue(asking)
    host.shareFile('/Users/me/Pictures/Lucium/a.png')
    expect(electron.ShareMenu).toHaveBeenCalledWith({ filePaths: ['/Users/me/Pictures/Lucium/a.png'] })
    expect(electron.BrowserWindow.fromWebContents).toHaveBeenCalledWith(window.sender)
    expect(electron.popup).toHaveBeenLastCalledWith({ window: asking })

    electron.BrowserWindow.fromWebContents.mockReturnValue(null)
    host.shareFile('/Users/me/Pictures/Lucium/b.png')
    expect(electron.popup).toHaveBeenLastCalledWith({ window: WINDOW })
  })

  it('opens the saved file with the application the system gives it', async () => {
    const window = windowSheet()
    await window.ask(Channel.annotateDone, { id: 'held' })
    const host = finishAnnotation.mock.calls[0]![0] as AnnotateHost
    host.openFile('/Users/me/Pictures/Lucium/a.png')
    expect(electron.shell.openPath).toHaveBeenCalledWith('/Users/me/Pictures/Lucium/a.png')
  })
})
