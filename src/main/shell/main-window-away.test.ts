// The main window closed on macOS while Lucium goes on: the real WindowManager over windows and browsers that are stand-ins. Closing
// it puts it away (hidden, its pages dropped) instead of destroying it, and the Dock, ⌘N, the window list and the quit find it again; nothing
// reads a destroyed window on the way. The rule itself: macos-window-lifecycle.test.ts; the wiring of index.ts: main-window-away-wiring.test.ts.

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { selectionOf } from '@shared/window-selection'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {},
  dialog: { showMessageBox: vi.fn() },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1600, height: 1000 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1600, height: 1000 } })
  }
}))
vi.mock('./ipc', () => ({ registerIpc: () => () => {} }))
vi.mock('./ipc-scope', () => ({ releaseIpcScope: () => {} }))

/** The browser of a window, as far as the window manager talks to it. */
class FakeBrowser {
  readonly away: boolean[] = []
  readonly overlays: unknown[] = []
  stopped = false
  constructor(readonly win: FakeWindow) {}
  joinGroup(): void {}
  onPublish(): void {}
  putAway(away: boolean): void {
    this.away.push(away)
  }
  openOverlay(request: unknown): void {
    this.overlays.push(request)
  }
  setLittleOpener(): void {}
  setSettingsOpener(): void {}
  setExtensionsOpener(): void {}
  setSystemDark(): void {}
  setWindowNames(): void {}
  setWindowMoves(): void {}
  start(): void {}
  stop(): void {
    this.stopped = true
  }
  republish(): void {}
}
vi.mock('./browser', () => ({ Browser: class extends FakeBrowser {}, NO_HISTORY: {} }))

let contentsIds = 0

/** A window as Electron gives it: `close()` asks the `close` listeners and goes unless one prevented it; a destroyed one throws when read. */
class FakeWindow extends EventEmitter {
  destroyed = false
  visible = true
  minimized = false
  fullScreen = false
  readonly calls: string[] = []
  readonly webContents = { id: ++contentsIds, once: () => {}, on: () => {} }
  private alive(): void {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    this.alive()
    return this.visible
  }
  isMinimized(): boolean {
    this.alive()
    return this.minimized
  }
  isFullScreen(): boolean {
    this.alive()
    return this.fullScreen
  }
  setFullScreen(value: boolean): void {
    this.alive()
    this.fullScreen = value
    if (!value) this.emit('leave-full-screen')
  }
  getBounds() {
    this.alive()
    return { x: 100, y: 100, width: 1200, height: 800 }
  }
  getTitle(): string {
    return 'Lucium'
  }
  setTitle(): void {}
  hide(): void {
    this.alive()
    this.calls.push('hide')
    this.visible = false
  }
  show(): void {
    this.alive()
    this.calls.push('show')
    this.visible = true
  }
  focus(): void {
    this.alive()
    this.calls.push('focus')
  }
  restore(): void {
    this.alive()
    this.calls.push('restore')
    this.minimized = false
  }
  /** Answers whether the window went. */
  close(): boolean {
    if (this.destroyed) return true
    let prevented = false
    const event = {
      preventDefault: () => void (prevented = true),
      get defaultPrevented() {
        return prevented
      }
    }
    this.emit('close', event)
    if (prevented) return false
    this.destroyed = true
    this.emit('closed')
    return true
  }
}

const { WindowManager, MAIN_WINDOW_ID } = await import('./windows')
const { StateStore, WindowView, liveCtx } = await import('../store')
const { prepareQuitForUpdate } = await import('./quit-flow')

function setup(platform = 'darwin') {
  const shared = new StateStore(createInitialState(liveCtx()), null)
  const views = new Set<InstanceType<typeof WindowView>>()
  const mainView = new WindowView(shared, selectionOf(shared.get()), views, true)
  const made: Array<{ bounds: unknown; win: FakeWindow }> = []
  const manager = new WindowManager({
    engine: {} as never,
    mainStore: shared,
    views,
    history: {} as never,
    windows: new Map(),
    createChrome: (_id, bounds) => {
      const win = new FakeWindow()
      made.push({ bounds, win })
      return { win: win as never, overlay: { webContents: { id: ++contentsIds, once: () => {}, isDestroyed: () => false, close: () => {} } } as never, floating: { trust: () => {}, release: () => {} } as never }
    },
    openSettings: () => {},
    openLittle: () => {},
    systemDark: () => false,
    platform
  })
  const mainWin = new FakeWindow()
  const mainBrowser = new FakeBrowser(mainWin)
  manager.registerMain(mainWin as never, mainBrowser as never, mainView)
  return { manager, mainWin, mainBrowser, made, shared }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('closing the main window on macOS', () => {
  it('puts it away: hidden instead of destroyed, its pages dropped, the windows opened from it closed with it', () => {
    const { manager, mainWin, mainBrowser, made } = setup()
    const other = manager.openWindow({ commandBar: false })
    expect(mainWin.close()).toBe(false)
    expect(mainWin.isDestroyed()).toBe(false)
    expect(mainWin.visible).toBe(false)
    expect(mainBrowser.away).toEqual([true])
    expect(made[0]!.win.isDestroyed()).toBe(true)
    expect(manager.list().map((record) => record.id)).toEqual([MAIN_WINDOW_ID])
    expect(manager.isMainAway()).toBe(true)
    expect(other.win.isDestroyed()).toBe(true)
    expect(manager.focused().id).toBe(MAIN_WINDOW_ID)
  })

  it('leaves full screen before it hides (a window hidden in full screen leaves an empty space)', () => {
    const { mainWin } = setup()
    mainWin.fullScreen = true
    mainWin.close()
    expect(mainWin.fullScreen).toBe(false)
    expect(mainWin.visible).toBe(false)
  })

  it('comes back with its state from the Dock (revealMain): shown, focused, its tab given its page again', () => {
    const { manager, mainWin, mainBrowser, shared } = setup()
    const before = shared.get()
    mainWin.close()
    const back = manager.revealMain()
    expect(back?.id).toBe(MAIN_WINDOW_ID)
    expect(back?.browser).toBe(mainBrowser)
    expect(mainWin.visible).toBe(true)
    expect(mainWin.calls.slice(-2)).toEqual(['show', 'focus'])
    expect(mainBrowser.away).toEqual([true, false])
    expect(manager.isMainAway()).toBe(false)
    expect(shared.get()).toBe(before)
  })

  it('restores a minimized main window as it shows it', () => {
    const { manager, mainWin } = setup()
    mainWin.minimized = true
    manager.revealMain()
    expect(mainWin.calls).toEqual(['restore', 'show', 'focus'])
  })

  it('comes back for ⌘N (with the command bar) instead of a new window beside a hidden one; once back, ⌘N opens a new window', () => {
    const { manager, mainWin, mainBrowser, made } = setup()
    mainWin.close()
    const record = manager.newWindow({ commandBar: true })
    expect(record?.id).toBe(MAIN_WINDOW_ID)
    expect(made).toHaveLength(0)
    expect(mainWin.visible).toBe(true)
    expect(mainBrowser.overlays).toEqual([{ panel: 'commandbar', mode: 'new', initial: '' }])
    const next = manager.newWindow({ commandBar: false })
    expect(next?.id).toBe('window-1')
    expect(made).toHaveLength(1)
    // One step down and to the right of the main window.
    expect(made[0]!.bounds).toEqual({ x: 128, y: 128, width: 1200, height: 800 })
  })

  it('comes back when the window list of the menu names it', () => {
    const { manager, mainWin } = setup()
    mainWin.close()
    expect(manager.focusWindow(MAIN_WINDOW_ID)).toBe(true)
    expect(mainWin.visible).toBe(true)
    expect(manager.isMainAway()).toBe(false)
  })

  it('is not put away while the question of the close guard holds the close (the guard, switched on later, still listens first)', async () => {
    const { manager, mainWin, mainBrowser, shared } = setup()
    for (const url of ['https://a.example/', 'https://b.example/']) shared.dispatch({ type: 'tab/open', url })
    manager.openWindow({ commandBar: false })
    const asked: string[] = []
    let answer!: (value: { close: boolean; stopAsking: boolean }) => void
    manager.closeGuard.ask = (_win, warning) => (asked.push(warning.message), new Promise((resolve) => (answer = resolve)))
    // « Avertir avant de fermer une fenêtre de plusieurs onglets »: its listener comes after the one of the window manager.
    shared.dispatch({ type: 'settings/update', patch: { warnBeforeClosingWindow: true } })
    manager.revealMain()
    expect(mainWin.close()).toBe(false)
    expect(asked).toHaveLength(1)
    expect(mainWin.visible).toBe(true)
    expect(mainBrowser.away).toEqual([])
    // « Fermer »: the window closes again, and only now is it put away.
    answer({ close: true, stopAsking: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mainWin.visible).toBe(false)
    expect(mainBrowser.away).toEqual([true])
    expect(manager.isMainAway()).toBe(true)
  })
})

describe('the quit, and the other systems', () => {
  it('closes the main window for real once the quit is decided', () => {
    const { manager, mainWin } = setup()
    manager.markQuitting()
    expect(mainWin.close()).toBe(true)
    expect(mainWin.isDestroyed()).toBe(true)
  })

  it('lets « Installer et relancer » close a main window put away: before-quit-for-update marks the quit, then every window closes', () => {
    const { manager, mainWin } = setup()
    mainWin.close()
    const flushed: string[] = []
    prepareQuitForUpdate({ store: { flush: () => void flushed.push('state') } as never, history: { flush: () => void flushed.push('history') }, engine: { flushDownloadResume: () => void flushed.push('downloads'), flushStrictTransport: () => void flushed.push('strict hosts') }, windowManager: manager, confirm: () => {} })
    // What autoUpdater.quitAndInstall does after its event: close every window, then quit once none is left.
    expect(manager.list().every((record) => (record.win as unknown as FakeWindow).close())).toBe(true)
    expect(mainWin.isDestroyed()).toBe(true)
    expect(flushed).toEqual(['state', 'history', 'downloads', 'strict hosts'])
  })

  it('closes it on the systems where closing the last window quits', () => {
    const { manager, mainWin } = setup('linux')
    expect(mainWin.close()).toBe(true)
    expect(manager.isMainAway()).toBe(false)
  })

  it('reads no destroyed window afterwards: a window asked for then is placed on the main screen, and nothing comes back', () => {
    const { manager, mainWin, made } = setup()
    manager.markQuitting()
    mainWin.close()
    expect(manager.revealMain()).toBeNull()
    expect(manager.newWindow({ commandBar: true })).toBeNull()
    expect(manager.focusWindow(MAIN_WINDOW_ID)).toBe(false)
    // An extension's chrome.windows.create, or the session restored, still asks openWindow: no "Object has been destroyed".
    expect(() => manager.openWindow({ commandBar: false })).not.toThrow()
    expect(made.at(-1)!.bounds).toEqual({ x: 120, y: 95, width: 1360, height: 860 })
  })
})
