// The windows of document Picture-in-Picture (document-pip-windows.ts) on fakes: the page's web contents is an event emitter that carries a listener
// standing for Electron's own listener of `-add-new-contents` (lib/browser/api/web-contents.ts in Electron 45.2.1: every disposition but four is
// prevented), and `handOver` does what Electron's C++ side does with the answer (`WebContents::AddNewContents`: a prevented event destroys the window).
// A real Electron is the engine check's (src/main/smoke-docpip.ts).

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_PIP_TICKET_MS } from '@shared/document-pip'
import type { Rect } from '@shared/popup'
import { FakePageContents } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())

const { ADD_NEW_CONTENTS, DocumentPipWindows } = await import('./document-pip-windows')

class FakePipWindow extends EventEmitter {
  destroyed = false
  readonly contentView = { addChildView: vi.fn() }
  readonly setAlwaysOnTop = vi.fn()
  readonly setVisibleOnAllWorkspaces = vi.fn()
  readonly showInactive = vi.fn()
  readonly setContentBounds = vi.fn()
  constructor(
    readonly bounds: Rect,
    readonly title: string
  ) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  /** As Electron's: the window goes, and says so. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
  getContentBounds(): Rect {
    return this.bounds
  }
}

const ELECTRON_HANDLES = ['foreground-tab', 'new-window', 'background-tab', 'save-to-disk']

/** The page of a tab, with Electron's listener of the internal event on it. */
function pageWithElectron(url = 'https://meet.example/abc') {
  const opener = new FakePageContents()
  opener.url = url
  const electron = vi.fn((event: { preventDefault(): void }, _contents: unknown, disposition: string) => {
    if (!ELECTRON_HANDLES.includes(disposition)) event.preventDefault()
  })
  opener.on(ADD_NEW_CONTENTS, electron)
  return { opener, electron }
}

/** The web contents Chromium made for the window: blank, in the session of the page unless a test says otherwise. */
function pipContents(opener: FakePageContents, session: object = opener.session): FakePageContents {
  const contents = new FakePageContents()
  Object.assign(contents, { url: 'about:blank', session })
  return contents
}

/** What Electron's C++ does with the window it made (`AddNewContents`): the event, then the window destroyed when the event was prevented. */
function handOver(opener: FakePageContents, contents: FakePageContents, disposition = 'other', size: [number, number] = [0, 0]): boolean {
  let prevented = false
  const event = { preventDefault: () => void (prevented = true) }
  opener.emit(ADD_NEW_CONTENTS, event, contents, disposition, true, 0, 0, size[0], size[1], '', '', { url: '', policy: 'default' }, '', null)
  if (prevented) {
    contents.destroyed = true
    contents.emit('destroyed')
  }
  return prevented
}

function windows(over: Record<string, unknown> = {}) {
  const made: FakePipWindow[] = []
  const views: Array<{ contents: unknown; setBounds: ReturnType<typeof vi.fn> }> = []
  let now = 1_000_000
  const docPip = new DocumentPipWindows({
    makeWindow: (bounds, title) => {
      const win = new FakePipWindow(bounds, title)
      made.push(win)
      return win as never
    },
    makeView: (contents) => {
      const view = { contents, setBounds: vi.fn() }
      views.push(view)
      return view as never
    },
    workArea: () => ({ x: 0, y: 25, width: 1600, height: 1000 }),
    now: () => now,
    platform: 'darwin',
    ...over
  })
  docPip.setEnabled(true)
  return { docPip, made, views, advance: (ms: number) => void (now += ms) }
}

/** A tab whose page was allowed a window, and the window it got. */
function opened(over: Record<string, unknown> = {}) {
  const all = windows(over)
  const { opener, electron } = pageWithElectron()
  const response = all.docPip.request(opener as never, 'tab-1')
  const contents = pipContents(opener)
  const destroyed = handOver(opener, contents, 'other', [480, 270])
  return { ...all, opener, electron, response, contents, destroyed, win: all.made[0] }
}

const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
beforeEach(() => {
  logs.info = vi.spyOn(console, 'info').mockImplementation(() => undefined) as never
  logs.warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as never
  logs.error = vi.spyOn(console, 'error').mockImplementation(() => undefined) as never
})
afterEach(() => vi.restoreAllMocks())

const lines = (spy: ReturnType<typeof vi.fn>): string[] => spy.mock.calls.map((call) => String(call[0]))

describe('the answer to a page allowed a window', () => {
  it('lets Chromium make it, as a page: sandboxed, isolated, without Node and without any preload', () => {
    const { response } = opened()
    expect(response).toMatchObject({ action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } } })
    expect(JSON.stringify(response)).not.toContain('preload')
  })

  it('refuses, as Electron always did, when Electron hands new windows over another way (an update): the request is denied, with a line in the log', () => {
    const { docPip } = windows()
    const opener = new FakePageContents()
    expect(docPip.request(opener as never, 'tab-1')).toBeNull()
    expect(lines(logs.warn).some((line) => line.includes(`no listener of "${ADD_NEW_CONTENTS}"`))).toBe(true)
    // Nothing was put on the page.
    expect(opener.listenerCount(ADD_NEW_CONTENTS)).toBe(0)
  })
})

describe('the window Chromium hands over', () => {
  it('is taken: shown in a window of Lucium above the others, on every desktop, without taking the focus, and not destroyed', () => {
    const { destroyed, contents, views, win, electron, docPip } = opened()
    expect(destroyed).toBe(false)
    expect(contents.destroyed).toBe(false)
    expect(electron).not.toHaveBeenCalled()
    expect(views.map((view) => view.contents)).toEqual([contents])
    expect(win!.contentView.addChildView).toHaveBeenCalledWith(views[0])
    expect(win!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(win!.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { skipTransformProcessType: true })
    expect(win!.showInactive).toHaveBeenCalled()
    expect(docPip.count()).toBe(1)
    expect(docPip.windowOf('tab-1')?.contents).toBe(contents)
  })

  it('opens at the size the page asked for, in the bottom right corner, with the site of its page in the title bar', () => {
    const { win } = opened()
    expect(win!.bounds).toEqual({ x: 1600 - 480 - 16, y: 25 + 1000 - 270 - 16, width: 480, height: 270 })
    expect(win!.title).toBe('meet.example')
  })

  it('opens at the default size when Electron hands it over without a size, as Electron 45 does (0 × 0, whatever the page asked for)', () => {
    const { docPip, made } = windows()
    const { opener } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    handOver(opener, pipContents(opener), 'other', [0, 0])
    expect(made[0]!.bounds).toEqual({ x: 1600 - 400 - 16, y: 25 + 1000 - 300 - 16, width: 400, height: 300 })
  })

  it('writes what Electron handed over in the log (what the engine check reads as its probe)', () => {
    opened()
    const probe = lines(logs.info).find((line) => line.startsWith('[pip] Electron handed over'))
    expect(probe).toContain('"disposition":"other"')
    expect(probe).toContain('"userGesture":true')
    expect(probe).toContain('"width":480')
    expect(probe).toMatch(/"contents":"web contents \d+"/)
  })

  it('leaves every other new window to Electron, with the same arguments: a tab, a popup', () => {
    const { docPip } = windows()
    const { opener, electron } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    const popup = new FakePageContents()
    expect(handOver(opener, popup, 'new-window', [500, 600])).toBe(false)
    expect(electron).toHaveBeenCalledTimes(1)
    expect(electron.mock.calls[0]!.slice(1, 8)).toEqual([popup, 'new-window', true, 0, 0, 500, 600])
    expect(docPip.count()).toBe(0)
  })

  it('leaves to Electron, which destroys it, a window nobody allowed (the yes was used up)', () => {
    const { opener, electron, docPip } = opened()
    const again = pipContents(opener)
    expect(handOver(opener, again)).toBe(true)
    expect(electron).toHaveBeenCalledTimes(1)
    expect(again.destroyed).toBe(true)
    expect(docPip.count()).toBe(1)
    expect(lines(logs.warn).some((line) => line.includes('left a document Picture-in-Picture window to Electron') && line.includes('not-allowed'))).toBe(true)
  })

  it('leaves to Electron a window that comes past the time of the yes', () => {
    const { docPip, advance } = windows()
    const { opener, electron } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    advance(DOCUMENT_PIP_TICKET_MS + 1)
    const contents = pipContents(opener)
    expect(handOver(opener, contents)).toBe(true)
    expect(electron).toHaveBeenCalledTimes(1)
    expect(docPip.count()).toBe(0)
  })

  it('leaves to Electron a window of another session: a private page never has its window in another session', () => {
    const { docPip } = windows()
    const { opener } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    const elsewhere = pipContents(opener, {})
    expect(handOver(opener, elsewhere)).toBe(true)
    expect(docPip.count()).toBe(0)
    expect(lines(logs.warn).some((line) => line.includes('other-session'))).toBe(true)
  })

  it('leaves to Electron a window that comes after the feature was switched off', () => {
    const { docPip } = windows()
    const { opener } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    docPip.setEnabled(false)
    expect(handOver(opener, pipContents(opener))).toBe(true)
    expect(docPip.count()).toBe(0)
  })

  it('leaves to Electron, which closes it, a window it cannot show: the error is in the log, and no window of Lucium is left', () => {
    const { docPip, made } = windows({
      makeView: () => {
        throw new Error('options.webContents is already attached to a window')
      }
    })
    const { opener, electron } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    const contents = pipContents(opener)
    expect(handOver(opener, contents)).toBe(true)
    expect(electron).toHaveBeenCalledTimes(1)
    expect(contents.destroyed).toBe(true)
    expect(made).toEqual([])
    expect(docPip.count()).toBe(0)
    expect(logs.error).toHaveBeenCalledWith('[pip] cannot show a document Picture-in-Picture window:', 'options.webContents is already attached to a window')
  })

  it('closes the window of Lucium it made when what follows fails', () => {
    const { docPip, made } = windows()
    const { opener } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    const contents = pipContents(opener)
    contents.setWindowOpenHandler = () => {
      throw new Error('broken')
    }
    expect(handOver(opener, contents)).toBe(true)
    expect(made[0]!.destroyed).toBe(true)
    expect(docPip.count()).toBe(0)
    // Nothing is left listening on the page.
    expect(opener.listenerCount('did-start-navigation')).toBe(0)
    expect(opener.listenerCount('destroyed')).toBe(0)
  })

  it('puts its listener on a page once, however many windows the page asks for', () => {
    const { docPip } = windows()
    const { opener } = pageWithElectron()
    docPip.request(opener as never, 'tab-1')
    docPip.request(opener as never, 'tab-1')
    expect(opener.listenerCount(ADD_NEW_CONTENTS)).toBe(1)
  })
})

describe('one window a tab', () => {
  it('a new window of the tab takes the place of the one before, which closes', () => {
    const { docPip, opener, contents, win } = opened()
    docPip.request(opener as never, 'tab-1')
    const second = pipContents(opener)
    expect(handOver(opener, second)).toBe(false)
    expect(win!.destroyed).toBe(true)
    expect(contents.close).toHaveBeenCalled()
    expect(docPip.count()).toBe(1)
    expect(docPip.windowOf('tab-1')?.contents).toBe(second)
  })
})

describe('what ends the window', () => {
  it('closes with the tab that opened it (closed, asleep, locked away: its page is destroyed), and leaves nothing on the page', () => {
    const { opener, win, contents, docPip } = opened()
    opener.emit('destroyed')
    expect(win!.destroyed).toBe(true)
    expect(contents.close).toHaveBeenCalled()
    expect(docPip.count()).toBe(0)
    expect(opener.listenerCount('did-start-navigation')).toBe(0)
    expect(opener.listenerCount('render-process-gone')).toBe(0)
  })

  it('closes when the tab goes to another document, not when it changes its fragment', () => {
    const { opener, win, docPip } = opened()
    opener.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'https://meet.example/abc#x' })
    expect(win!.destroyed).toBe(false)
    opener.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://elsewhere.example/' })
    expect(win!.destroyed).toBe(true)
    expect(docPip.count()).toBe(0)
  })

  it('closes when the page closes it, and the window of Lucium goes with it', () => {
    const { contents, win, docPip } = opened()
    contents.destroyed = true
    contents.emit('destroyed')
    expect(win!.destroyed).toBe(true)
    expect(docPip.count()).toBe(0)
  })

  it('closes when the user closes it, and the page sees it closed', () => {
    const { contents, win, docPip } = opened()
    win!.destroy()
    expect(contents.close).toHaveBeenCalled()
    expect(docPip.count()).toBe(0)
  })

  it('closes, going nowhere, when something sends it to an address (another origin included)', () => {
    const { contents, win } = opened()
    expect(contents.navigateTo('https://elsewhere.example/')).toBe(true)
    expect(win!.destroyed).toBe(true)
  })

  it('closes when it goes to another document by any other way, not for its blank start or a frame', () => {
    const { contents, win } = opened()
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'about:blank' })
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://ads.example/' })
    expect(win!.destroyed).toBe(false)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://meet.example/other' })
    expect(win!.destroyed).toBe(true)
  })

  it('closes when the feature is switched off', () => {
    const { docPip, win } = opened()
    docPip.setEnabled(false)
    expect(win!.destroyed).toBe(true)
    expect(docPip.count()).toBe(0)
  })

  it('closes with ⌘W, which never reaches the tab behind; ⌘R reloads nothing (a reload would send it away)', () => {
    const { contents, win } = opened()
    const press = (key: string): boolean => {
      let prevented = false
      contents.emit('before-input-event', { preventDefault: () => void (prevented = true) }, { type: 'keyDown', key, meta: true, control: false, alt: false, shift: false })
      return prevented
    }
    expect(press('r')).toBe(true)
    expect(win!.destroyed).toBe(false)
    expect(press('w')).toBe(true)
    expect(win!.destroyed).toBe(true)
  })

  it('closes them all at once, and says how many', () => {
    const { docPip, win } = opened()
    expect(docPip.closeAll('the test')).toBe(1)
    expect(win!.destroyed).toBe(true)
    expect(docPip.closeAll('the test')).toBe(0)
  })
})

describe('what the floating document may do', () => {
  it('opens no window: not a tab, not a popup, not another floating window', () => {
    const { contents } = opened()
    expect(contents.open('https://elsewhere.example/')).toEqual({ action: 'deny' })
    expect(contents.open('about:blank', { disposition: 'other' })).toEqual({ action: 'deny' })
  })

  it('is never held open by its page asking to stay', () => {
    const { contents } = opened()
    let prevented = false
    contents.emit('will-prevent-unload', { preventDefault: () => void (prevented = true) })
    expect(prevented).toBe(true)
  })

  it('may size and move its window within the bounds it opened with, never off the screen', () => {
    const { contents, win } = opened()
    let prevented = false
    contents.emit('content-bounds-updated', { preventDefault: () => void (prevented = true) }, { x: -5000, y: -5000, width: 1, height: 1 })
    expect(prevented).toBe(true)
    expect(win!.setContentBounds).toHaveBeenCalledWith({ x: 0, y: 65, width: 240, height: 120 })
  })

  it('lets no frame inside it hand an address to another application', () => {
    const { contents } = opened()
    let prevented = false
    contents.emit('will-frame-navigate', { isMainFrame: false, url: 'mailto:someone@example.com', preventDefault: () => void (prevented = true) })
    expect(prevented).toBe(true)
  })
})
