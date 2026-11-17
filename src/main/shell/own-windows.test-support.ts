// Test support (nothing of the application imports it): `createOwnWindows` (own-windows-wiring.ts), the part of main() that makes the windows of their
// own (mini windows, floating video, Réglages, the task manager, À propos), run over a stand-in of Electron whose classes and objects are inert,
// and over recorders for the engine and the browser (browser-fake.test-support.ts). A test file puts the stand-in in the place of Electron:
//   vi.mock('electron', async () => (await import('./own-windows.test-support')).windowsElectron())
// and reads what the windows were told: `engine.calls`, `browser.calls`.

import { EventEmitter } from 'node:events'
import { createInitialState } from '@shared/sidebar'
import type { Settings } from '@shared/model'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, type FakeBrowser } from './browser-fake.test-support'
import { fakeElectron } from './ipc-fake.test-support'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A screen as Electron's `screen` gives it: what identifies it for the settings, and the part of it a window may use. */
export interface WorldDisplay {
  label: string
  internal: boolean
  scaleFactor: number
  size: { width: number; height: number }
  bounds: Rect
  workArea: Rect
}

/** A display of this size (its work area leaves 25 points for the menu bar). */
export const displayOf = (label: string, width: number, height: number, internal = false, scaleFactor = 1): WorldDisplay => ({ label, internal, scaleFactor, size: { width, height }, bounds: { x: 0, y: 0, width, height }, workArea: { x: 0, y: 25, width, height: height - 25 } })

const inert: unknown = new Proxy(function () {}, { get: (_target, member) => (member === Symbol.toPrimitive ? () => 0 : member === Symbol.iterator ? function* () {} : member === 'then' || typeof member === 'symbol' ? undefined : inert), apply: () => inert })

/**
 * What the stand-in of Electron holds: the windows made (`new BrowserWindow(options)`), the screens, and the window the user is in. Kept on `globalThis`: a test
 * that loads the modules again (`vi.resetModules`, main-run.test-support.ts) keeps the stand-in it made first, and must read the one world.
 */
export const windowsWorld = ((globalThis as unknown as { __luciumWindowsWorld?: WindowsWorld }).__luciumWindowsWorld ??= {
  made: [] as MadeWindow[],
  display: displayOf('Built-in', 1440, 900, true, 2),
  primary: displayOf('Built-in', 1440, 900, true, 2),
  /** The bounds of the window of the application that has the focus (null: none). */
  focused: null as Rect | null,
  /** The bounds the screen was asked about (`screen.getDisplayMatching`), in order. */
  asked: [] as Rect[],
  reset(): void {
    this.made.length = 0
    this.asked.length = 0
    this.focused = null
    this.display = this.primary
  }
})

let nextContentsId = 1000

interface WindowsWorld {
  made: MadeWindow[]
  display: WorldDisplay
  primary: WorldDisplay
  focused: Rect | null
  asked: Rect[]
  reset(): void
}

/** A window of their own as Electron makes it: what the scaling reads (its size, its zoom), and anything else is inert. */
export class MadeWindow extends EventEmitter {
  readonly webContents: EventEmitter & { zoom: number; id: number; session: unknown; isDestroyed(): boolean; getZoomFactor(): number; setZoomFactor(factor: number): void; loaded: Array<{ how: 'loadFile' | 'loadURL'; target: string }>; sent: unknown[][] }
  constructor(readonly options: Record<string, unknown>) {
    super()
    this.webContents = Object.assign(new EventEmitter(), {
      zoom: 1,
      id: (nextContentsId += 1),
      /** The session the contents was made in (`webPreferences.session`), as the library of the extensions compares it. */
      session: (options['webPreferences'] as { session?: unknown } | undefined)?.session,
      loaded: [] as Array<{ how: 'loadFile' | 'loadURL'; target: string }>,
      sent: [] as unknown[][],
      loadFile(this: { loaded: Array<{ how: 'loadFile' | 'loadURL'; target: string }> }, path: string) {
        this.loaded.push({ how: 'loadFile', target: path })
        return Promise.resolve()
      },
      loadURL(this: { loaded: Array<{ how: 'loadFile' | 'loadURL'; target: string }> }, url: string) {
        this.loaded.push({ how: 'loadURL', target: url })
        return Promise.resolve()
      },
      send(this: { sent: unknown[][] }, ...args: unknown[]) {
        this.sent.push(args)
      },
      isDestroyed: () => false,
      getZoomFactor(this: { zoom: number }) {
        return this.zoom
      },
      setZoomFactor(this: { zoom: number }, factor: number) {
        this.zoom = factor
      }
    })
    this.webContents = new Proxy(this.webContents, { get: (target, member, receiver) => (member in target ? (Reflect.get(target, member, receiver) as unknown) : typeof member === 'symbol' || member === 'then' ? undefined : inert) })
    windowsWorld.made.push(this)
    return new Proxy(this, { get: (target, member, receiver) => (member in target ? (Reflect.get(target, member, receiver) as unknown) : typeof member === 'symbol' || member === 'then' ? undefined : inert) })
  }
  /** What the window was asked to do to be seen (`show`, `hide`, `focus`, `restore`), in order. */
  readonly calls: string[] = []
  private visible = false
  show(): void {
    this.visible = true
    this.calls.push('show')
  }
  hide(): void {
    this.visible = false
    this.calls.push('hide')
  }
  focus(): void {
    this.calls.push('focus')
  }
  restore(): void {
    this.calls.push('restore')
  }
  isVisible(): boolean {
    return this.visible
  }
  isMinimized(): boolean {
    return false
  }
  isDestroyed(): boolean {
    return false
  }
  isMaximized(): boolean {
    return false
  }
  isFullScreen(): boolean {
    return false
  }
  getBounds(): Rect {
    return { x: Number(this.options['x'] ?? 0), y: Number(this.options['y'] ?? 0), width: Number(this.options['width'] ?? 0), height: Number(this.options['height'] ?? 0) }
  }
  getContentBounds(): Rect {
    return this.getBounds()
  }
  setContentSize(): void {}
  setMinimumSize(): void {}
  static getFocusedWindow(): { getBounds(): Rect } | null {
    const focused = windowsWorld.focused
    return focused ? { getBounds: () => focused } : null
  }
}

/** Electron with the names the windows reach: `ipcMain`, the clipboard and `Menu` of ipc-fake.test-support.ts, the windows and the screens of `windowsWorld`, and an inert object for every other. */
export function windowsElectron(): Record<string, unknown> {
  const own: Record<string, unknown> = {
    BrowserWindow: MadeWindow,
    screen: {
      getDisplayMatching: (bounds: Rect) => (windowsWorld.asked.push(bounds), windowsWorld.display),
      getPrimaryDisplay: () => windowsWorld.primary,
      getAllDisplays: () => [windowsWorld.primary, windowsWorld.display],
      getDisplayNearestPoint: () => windowsWorld.display,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: () => undefined,
      removeListener: () => undefined
    },
    nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
  }
  const base = fakeElectron()
  return new Proxy(base, { has: () => true, get: (target, member: string) => (member in own ? own[member] : (target[member] as unknown)) })
}

export interface OwnWindowsHarness {
  readonly engine: FakeBrowser
  readonly browser: FakeBrowser
  readonly windows: Map<string, unknown>
  /** What `createOwnWindows` gave back: the windows of their own. */
  readonly made: Record<string, unknown>
  /** A change of the shared settings, heard by whoever subscribed to the state. */
  readonly change: (patch: Partial<Settings>) => void
}

/** The windows of their own, made as main() makes them; `engineOwn` and `browserOwn` give members to the recorders of the engine and of the browser. */
export async function ownWindows(options: { engineOwn?: Record<string, unknown>; browserOwn?: Record<string, unknown>; load?: (target: unknown, surface: unknown) => void; settings?: Partial<Settings> } = {}): Promise<OwnWindowsHarness> {
  const { createOwnWindows } = await import('./own-windows-wiring')
  const initial = createInitialState({ now: 1, newId: () => 'x' })
  let state: SidebarState = { ...initial, settings: { ...initial.settings, ...options.settings } }
  const listeners = new Set<(state: SidebarState) => void>()
  const store = {
    get: () => state,
    subscribe: (listener: (state: SidebarState) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
  /** The settings change, as the shared state tells its subscribers. */
  const change = (patch: Partial<Settings>): void => {
    state = { ...state, settings: { ...state.settings, ...patch } }
    for (const listener of [...listeners]) listener(state)
  }
  const engine = fakeBrowser(options.engineOwn ?? {})
  const browser = fakeBrowser(options.browserOwn ?? {})
  const windows = new Map<string, unknown>()
  const made = createOwnWindows({
    engine: engine.self,
    store,
    sharedStore: store,
    browser: browser.self,
    history: {},
    windows,
    trusted: new Set(),
    focusMain: () => undefined,
    webPreferences: {},
    platform: {},
    load: options.load ?? (() => undefined)
  } as never)
  return { engine, browser, windows, made: made as unknown as Record<string, unknown>, change }
}
