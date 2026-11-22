// The lock of a private window left alone (shared/private-lock.ts) as the real WindowManager puts it on: a private window gets one, a guest window does not, it looks at the
// window only while a delay is set and the lock of the application is on, it locks the window when the delay is up (the window is told), and closing the window lets go of it.
// The rules: shared/private-lock.test.ts; the timer: private-lock.test.ts.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const lockFake = vi.hoisted(() => ({ appLocked: false, spaces: [] as string[], active: true }))
vi.mock('../lock-service', () => ({ getLockService: () => ({ isActive: () => lockFake.active, isAppLocked: () => lockFake.appLocked, lockedSpaces: () => lockFake.spaces, view: () => undefined }) }))
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
  inheritSettings(): void {}
  privateLock: unknown = 'unset'
  windowLockChanges = 0
  setPrivateLock(lock: unknown): void {
    this.privateLock = lock
  }
  windowLockChanged(): void {
    this.windowLockChanges += 1
  }
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
  focused = false
  isFocused(): boolean {
    return this.focused
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

/** What the application tells the lock of a window: when the last click or key was. */
const world = { lastInput: 0 }

function setup() {
  const shared = new StateStore(createInitialState(liveCtx()), null)
  const views = new Set<InstanceType<typeof WindowView>>()
  const mainView = new WindowView(shared, selectionOf(shared.get()), views, true)
  const manager = new WindowManager({
    engine: { openEphemeral: () => ({ dispose: () => Promise.resolve() }) } as never,
    mainStore: shared,
    views,
    history: {} as never,
    windows: new Map(),
    createChrome: () => ({
      win: new FakeWindow() as never,
      overlay: { webContents: { id: ++contentsIds, once: () => {}, isDestroyed: () => false, close: () => {} } } as never,
      floating: { trust: () => {}, release: () => {} } as never
    }),
    openSettings: () => {},
    openLittle: () => {},
    systemDark: () => false,
    platform: 'darwin',
    lastUserInputAt: () => world.lastInput
  })
  const mainBrowser = new FakeBrowser()
  manager.registerMain(new FakeWindow() as never, mainBrowser as never, mainView)
  return { manager, mainBrowser, shared }
}

const browserOf = (record: { browser: unknown }) => record.browser as unknown as FakeBrowser

const MIN = 60_000
const settingsOf = (manager: { list(): unknown[] }, shared: { dispatch(action: unknown): void }, minutes: number): void => {
  void manager
  shared.dispatch({ type: 'settings/update', patch: { lockPrivateIdle: minutes } })
}

beforeEach(() => {
  vi.useFakeTimers()
  lockFake.appLocked = false
  lockFake.spaces = []
  lockFake.active = true
  world.lastInput = 0
})
afterEach(() => vi.useRealTimers())

describe('the lock of a private window, as the window manager puts it on', () => {
  it('gives each private window a lock of its own, and a guest window none', () => {
    const { manager, shared } = setup()
    shared.dispatch({ type: 'settings/update', patch: { guestProfile: true } })
    const privateWindow = manager.openPrivate()
    expect(browserOf(privateWindow).privateLock).toMatchObject({ isLocked: expect.any(Function) })
    const guest = manager.openGuest()!
    expect(browserOf(guest).privateLock).toBeNull()
  })

  it('looks at nothing while the delay is « never » or the lock of the application is off', () => {
    const { manager, shared } = setup()
    let before = vi.getTimerCount()
    manager.openPrivate()
    expect(vi.getTimerCount()).toBe(before)
    settingsOf(manager, shared, 5)
    lockFake.active = false
    before = vi.getTimerCount()
    manager.openPrivate()
    expect(vi.getTimerCount()).toBe(before)
  })

  it('locks a window that was left alone for the delay, and tells the window', () => {
    const { manager, shared } = setup()
    settingsOf(manager, shared, 5)
    const before = vi.getTimerCount()
    const record = manager.openPrivate()
    expect(vi.getTimerCount()).toBe(before + 1)
    vi.advanceTimersByTime(4 * MIN)
    expect((browserOf(record).privateLock as { isLocked(): boolean }).isLocked()).toBe(false)
    expect(browserOf(record).windowLockChanges).toBe(0)
    vi.advanceTimersByTime(2 * MIN)
    expect((browserOf(record).privateLock as { isLocked(): boolean }).isLocked()).toBe(true)
    expect(browserOf(record).windowLockChanges).toBe(1)
  })

  it('does not lock a window the person keeps using (a click or a key while it has the focus)', () => {
    const { manager, shared } = setup()
    settingsOf(manager, shared, 5)
    const record = manager.openPrivate()
    ;(record.win as unknown as { focused: boolean }).focused = true
    for (let minute = 1; minute <= 12; minute += 1) {
      vi.advanceTimersByTime(MIN)
      world.lastInput = Date.now()
    }
    expect((browserOf(record).privateLock as { isLocked(): boolean }).isLocked()).toBe(false)
  })

  it('counts coming back to the window as a visit', () => {
    const { manager, shared } = setup()
    settingsOf(manager, shared, 5)
    const record = manager.openPrivate()
    vi.advanceTimersByTime(4 * MIN)
    record.win.emit('focus')
    vi.advanceTimersByTime(4 * MIN)
    expect((browserOf(record).privateLock as { isLocked(): boolean }).isLocked()).toBe(false)
  })

  it('lets go of its timer when the window is closed', () => {
    const { manager, shared } = setup()
    settingsOf(manager, shared, 5)
    const before = vi.getTimerCount()
    const record = manager.openPrivate()
    expect(vi.getTimerCount()).toBe(before + 1)
    record.win.close()
    expect(vi.getTimerCount()).toBe(before)
  })
})
