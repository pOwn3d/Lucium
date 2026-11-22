// File › Rouvrir la dernière fenêtre fermée: the real WindowManager over windows and browsers that are stand-ins. A window closed by the user is remembered in
// memory (bounds, tab shown, name, sidebar) and comes back; a private or guest window, a window of a locked space, a window closed while the application is
// locked and the windows closed by the quit are never kept. The rules of the list: shared/closed-windows.test.ts.

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { selectionOf } from '@shared/window-selection'
import type { Rect } from '@shared/window-layout'
import { cleanWindowSidebar, NO_WINDOW_SIDEBAR, type WindowSidebar } from '@shared/window-sidebar'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {},
  dialog: { showMessageBox: vi.fn() },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1600, height: 1000 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1600, height: 1000 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 25, width: 1600, height: 1000 } }]
  }
}))
// The lock, as far as the window manager asks it: the application locked, and the spaces that are.
const lockFake = vi.hoisted(() => ({ appLocked: false, spaces: [] as string[] }))
vi.mock('../lock-service', () => ({ getLockService: () => ({ isAppLocked: () => lockFake.appLocked, lockedSpaces: () => lockFake.spaces, view: () => undefined }) }))
vi.mock('./ipc', () => ({ registerIpc: () => () => {} }))
vi.mock('./ipc-scope', () => ({ releaseIpcScope: () => {} }))

/** The browser of a window, as far as the window manager talks to it: it keeps the window's choice, and records whether it was given before it started. */
class FakeBrowser {
  sidebar: WindowSidebar = NO_WINDOW_SIDEBAR
  started = false
  readonly givenBeforeStart: boolean[] = []
  joinGroup(): void {}
  onPublish(): void {}
  setLittleOpener(): void {}
  setSettingsOpener(): void {}
  setExtensionsOpener(): void {}
  setSystemDark(): void {}
  setWindowNames(): void {}
  setWindowMoves(): void {}
  start(): void {
    this.started = true
  }
  stop(): void {}
  republish(): void {}
  setPrivateLock(): void {}
  windowLockChanged(): void {}
  inheritSettings(): void {}
  windowSidebar(): WindowSidebar {
    return this.sidebar
  }
  setWindowSidebar(raw: unknown): void {
    this.givenBeforeStart.push(!this.started)
    this.sidebar = cleanWindowSidebar(raw) ?? NO_WINDOW_SIDEBAR
  }
}
vi.mock('./browser', () => ({ Browser: class extends FakeBrowser {}, NO_HISTORY: {} }))

let contentsIds = 0

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly webContents = { id: ++contentsIds, once: () => {}, on: () => {} }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return true
  }
  isMinimized(): boolean {
    return false
  }
  bounds: Rect = { x: 100, y: 100, width: 1200, height: 800 }
  getBounds(): Rect {
    return this.bounds
  }
  getTitle(): string {
    return 'Lucium'
  }
  setTitle(): void {}
  show(): void {}
  focus(): void {}
  close(): boolean {
    let prevented = false
    this.emit('close', { preventDefault: () => void (prevented = true), defaultPrevented: false })
    if (prevented) return false
    this.destroyed = true
    this.emit('closed')
    return true
  }
}

const { WindowManager } = await import('./windows')
const { StateStore, WindowView, liveCtx } = await import('../store')

/** Where each window was asked to be made. */
const placed: Rect[] = []

function setup() {
  placed.length = 0
  const shared = new StateStore(createInitialState(liveCtx()), null)
  const views = new Set<InstanceType<typeof WindowView>>()
  const mainView = new WindowView(shared, selectionOf(shared.get()), views, true)
  const manager = new WindowManager({
    engine: { openEphemeral: () => ({ dispose: () => Promise.resolve() }) } as never,
    mainStore: shared,
    views,
    history: {} as never,
    windows: new Map(),
    createChrome: (_id: string, at: Rect) => ({
      win: Object.assign(new FakeWindow(), { bounds: (placed.push(at), at) }) as never,
      overlay: { webContents: { id: ++contentsIds, once: () => {}, isDestroyed: () => false, close: () => {} } } as never,
      floating: { trust: () => {}, release: () => {} } as never
    }),
    openSettings: () => {},
    openLittle: () => {},
    systemDark: () => false,
    platform: 'darwin'
  })
  const mainBrowser = new FakeBrowser()
  manager.registerMain(new FakeWindow() as never, mainBrowser as never, mainView)
  return { manager, mainBrowser, shared }
}

const bounds = { x: 40, y: 40, width: 900, height: 600 }
const browserOf = (record: { browser: unknown }) => record.browser as unknown as FakeBrowser
const afterEachReset = () => {
  lockFake.appLocked = false
  lockFake.spaces = []
}

describe('reopening a closed window', () => {
  it('brings back the latest closed window where it was, with its name, its sidebar and the tab it showed', () => {
    afterEachReset()
    const { manager, shared } = setup()
    const tabId = shared.get().tabs[0]?.id ?? 'a-tab'
    const record = manager.openWindow({ commandBar: false, restore: { bounds, selection: { ...selectionOf(shared.get()), tabs: { [shared.get().activeSpaceId]: tabId } }, name: 'Courses', sidebar: { docked: true } } })
    expect(manager.canReopenClosed()).toBe(false)
    record.win.close()
    expect(manager.canReopenClosed()).toBe(true)
    const back = manager.reopenClosed()!
    // The window comes back where it was (the screen there is now holds it), not one step down from the focused window.
    expect(placed.at(-1)).toEqual(bounds)
    expect(back.win.getBounds()).toEqual(bounds)
    expect(back.name).toBe('Courses')
    expect(browserOf(back).windowSidebar()).toEqual({ docked: true })
    expect(back.id).not.toBe(record.id)
    // Once: the entry is used up.
    expect(manager.canReopenClosed()).toBe(false)
    expect(manager.reopenClosed()).toBeNull()
  })

  it('brings the windows back latest first, and keeps at most ten', () => {
    afterEachReset()
    const { manager, shared } = setup()
    for (let n = 1; n <= 12; n += 1) manager.openWindow({ commandBar: false, restore: { bounds, selection: selectionOf(shared.get()), name: `w${n}` } }).win.close()
    expect(manager.closedCount()).toBe(10)
    expect(manager.reopenClosed()?.name).toBe('w12')
    expect(manager.reopenClosed()?.name).toBe('w11')
  })

  it('keeps nothing of a private window, a guest window, or the first window', () => {
    afterEachReset()
    const { manager, shared } = setup()
    shared.dispatch({ type: 'settings/update', patch: { guestProfile: true } })
    manager.openPrivate().win.close()
    manager.openGuest()!.win.close()
    expect(manager.closedCount()).toBe(0)
    expect(manager.canReopenClosed()).toBe(false)
    expect(manager.reopenClosed()).toBeNull()
  })

  it('keeps nothing of the windows that close on the way out of the application', () => {
    afterEachReset()
    const { manager, shared } = setup()
    const record = manager.openWindow({ commandBar: false, restore: { bounds, selection: selectionOf(shared.get()) } })
    manager.markQuitting()
    record.win.close()
    expect(manager.closedCount()).toBe(0)
  })

  it('keeps nothing of a window of a locked space, nor of a window closed while the application is locked', () => {
    afterEachReset()
    const { manager, shared } = setup()
    const spaceId = shared.get().activeSpaceId
    lockFake.spaces = [spaceId]
    manager.openWindow({ commandBar: false, restore: { bounds, selection: selectionOf(shared.get()) } }).win.close()
    lockFake.spaces = []
    lockFake.appLocked = true
    manager.openWindow({ commandBar: false, restore: { bounds, selection: selectionOf(shared.get()) } }).win.close()
    lockFake.appLocked = false
    expect(manager.closedCount()).toBe(0)
  })

  it('does not bring back a window while the application is locked, nor one of a space that was locked since', () => {
    afterEachReset()
    const { manager, shared } = setup()
    manager.openWindow({ commandBar: false, restore: { bounds, selection: selectionOf(shared.get()) } }).win.close()
    lockFake.appLocked = true
    expect(manager.canReopenClosed()).toBe(false)
    expect(manager.reopenClosed()).toBeNull()
    lockFake.appLocked = false
    // The locked application left the list alone.
    expect(manager.canReopenClosed()).toBe(true)
    lockFake.spaces = [shared.get().activeSpaceId]
    expect(manager.canReopenClosed()).toBe(false)
    expect(manager.reopenClosed()).toBeNull()
  })

  it('forgets a close the guard held back: only the window that really closed is kept', () => {
    afterEachReset()
    const { manager, shared } = setup()
    const record = manager.openWindow({ commandBar: false, restore: { bounds, selection: selectionOf(shared.get()), name: 'kept' } })
    // A close that is prevented (the question before closing a window of several tabs): the window is still there.
    record.win.on('close', (event: { preventDefault: () => void }) => event.preventDefault())
    expect(record.win.close()).toBe(false)
    expect(manager.closedCount()).toBe(0)
  })
})
