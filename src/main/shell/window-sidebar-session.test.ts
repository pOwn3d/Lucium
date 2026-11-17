// The sidebar each window chose for itself (« Barre de cette fenêtre »: its side, docked) and the memory of the windows: the real WindowManager over windows
// and browsers that are stand-ins. A restored window gets its choice back before it starts, windows.json lists each window's choice with the window (the
// first one's too), and a window closed takes its choice with it: a new window follows the setting again. The rules of the file: shared/window-session.test.ts.

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { selectionOf } from '@shared/window-selection'
import { cleanWindowSidebar, NO_WINDOW_SIDEBAR, type WindowSidebar } from '@shared/window-sidebar'

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
  getBounds() {
    return { x: 100, y: 100, width: 1200, height: 800 }
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

function setup() {
  const shared = new StateStore(createInitialState(liveCtx()), null)
  const views = new Set<InstanceType<typeof WindowView>>()
  const mainView = new WindowView(shared, selectionOf(shared.get()), views, true)
  const manager = new WindowManager({
    engine: {} as never,
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
    platform: 'darwin'
  })
  const mainBrowser = new FakeBrowser()
  manager.registerMain(new FakeWindow() as never, mainBrowser as never, mainView)
  return { manager, mainBrowser, shared }
}

const bounds = { x: 40, y: 40, width: 900, height: 600 }
const browserOf = (record: { browser: unknown }) => record.browser as unknown as FakeBrowser

describe('the sidebar of each window, remembered with the windows', () => {
  it('gives a restored window its choice back before it starts, and a new window none (it follows the setting, the full sidebar)', () => {
    const { manager, shared } = setup()
    const restored = manager.openWindow({ commandBar: false, restore: { bounds, selection: selectionOf(shared.get()), sidebar: { side: 'right', docked: true } } })
    expect(browserOf(restored).windowSidebar()).toEqual({ side: 'right', docked: true })
    expect(browserOf(restored).givenBeforeStart).toEqual([true])
    const fresh = manager.openWindow({ commandBar: false })
    expect(browserOf(fresh).windowSidebar()).toEqual({})
    expect(browserOf(fresh).givenBeforeStart).toEqual([])
  })

  it('lists the choice of each window with the window in windows.json, the first window’s too, and none for a window that chose nothing', () => {
    const { manager, mainBrowser } = setup()
    mainBrowser.sidebar = { docked: true }
    const docked = manager.openWindow({ commandBar: false })
    browserOf(docked).sidebar = { side: 'left', docked: true }
    manager.openWindow({ commandBar: false })
    const session = manager.sessionSnapshot()
    expect(session.mainSidebar).toEqual({ docked: true })
    expect(session.windows.map((w) => w.sidebar)).toEqual([{ side: 'left', docked: true }, undefined])
  })

  it('forgets the choice of a window that is closed: the list no longer has it, and the next window opens as the new windows', () => {
    const { manager } = setup()
    const first = manager.openWindow({ commandBar: false })
    browserOf(first).sidebar = { side: 'right' }
    const second = manager.openWindow({ commandBar: false })
    browserOf(second).sidebar = { docked: true }
    first.win.close()
    expect(manager.sessionSnapshot().windows.map((w) => w.sidebar)).toEqual([{ docked: true }])
    const next = manager.openWindow({ commandBar: false })
    expect(browserOf(next).windowSidebar()).toEqual({})
    expect(manager.sessionSnapshot().windows.map((w) => w.sidebar)).toEqual([{ docked: true }, undefined])
  })
})
