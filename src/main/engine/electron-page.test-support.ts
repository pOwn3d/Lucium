// Test support (nothing of the application imports it): a real `ElectronPage` (electron-page.ts) over a web contents that is an event emitter,
// in a window that is a plain object. The test file puts `electronStub()` in the place of Electron and a class without a library in the place of
// electron-chrome-extensions:
//   vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
//   vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
// What the page does is then read from what it tells the shell (`events`), the menus it builds (`menus`), and the calls on its web contents.

import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

/** One item of a menu the page built, as given to `Menu.buildFromTemplate`. */
export interface BuiltItem {
  label?: string
  role?: string
  type?: string
  click?: () => void
  submenu?: BuiltItem[]
}

/** The menus the page built, in order (`Menu.buildFromTemplate`). */
export const menus: BuiltItem[][] = []

export const openExternal = vi.fn(async (_url: string) => undefined)

/** What the page modules import from Electron (and `extra`). Anything else is an empty object: a page module that uses it in a test fails loudly. */
export function electronStub(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    Menu: {
      buildFromTemplate: (items: BuiltItem[]) => {
        menus.push(items)
        return { popup: () => undefined }
      }
    },
    MenuItem: class {},
    // A web contents of these fakes says which window it is in by its `window` (none: a sender whose window cannot be told).
    BrowserWindow: class {
      static fromWebContents(contents: { window?: unknown } | null | undefined): unknown {
        return contents?.window ?? null
      }
    },
    WebContentsView: FakeView,
    clipboard: { writeText: vi.fn() },
    shell: { openExternal },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }) },
    ...extra
  }
  return new Proxy(stub, { get: (target, name: string) => (name in target ? target[name] : {}) })
}

let nextContentsId = 1

/** The protocol session of a web contents (`webContents.debugger`): one at a time, as Electron's, recording what it is sent. Nobody is attached until a test says so. */
export class FakeProtocolSession extends EventEmitter {
  attached = false
  attaches = 0
  detaches = 0
  readonly commands: Array<{ method: string; params: unknown }> = []
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    if (this.attached) throw new Error('Another debugger is already attached to the target.')
    this.attached = true
    this.attaches++
  }
  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.detaches++
    this.emit('detach', {}, 'target closed')
  }
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push({ method, params })
    return {}
  }
}

export class FakePageContents extends EventEmitter {
  readonly id = nextContentsId++
  url = 'https://site.example/'
  destroyed = false
  readonly session = {}
  /** The frames inside the page (`framesInSubtree` besides the top document), by the origin of their document: a test adds one of another site. */
  readonly subFrames: { origin: string }[] = []
  /**
   * The top document (`webContents.mainFrame`): its origin is the page's, and it lists itself and the frames inside it (`subFrames`). A test
   * may give it another list of its own (`Object.assign(wc.mainFrame, { framesInSubtree: [...] })`).
   */
  readonly mainFrame: { name: string; parent: null; readonly origin: string; framesInSubtree: unknown[] } = ((contents: FakePageContents) => {
    let given: unknown[] | null = null
    return {
      name: 'main',
      parent: null,
      get origin(): string {
        return URL.canParse(contents.url) ? new URL(contents.url).origin : 'null'
      },
      get framesInSubtree(): unknown[] {
        return given ?? [contents.mainFrame, ...contents.subFrames.map((frame) => ({ ...frame, parent: contents.mainFrame }))]
      },
      set framesInSubtree(frames: unknown[]) {
        given = frames
      }
    }
  })(this)
  readonly debugger = new FakeProtocolSession()
  /** The history of the page: `entries` and `active` stand for what Chromium keeps; the moves only record the call. */
  readonly navigationHistory = {
    entries: [] as Array<{ url: string; title: string }>,
    active: -1,
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    goBack: vi.fn(),
    goForward: vi.fn(),
    goToIndex: vi.fn(),
    getActiveIndex(): number {
      return this.active
    },
    getAllEntries(): Array<{ url: string; title: string }> {
      return this.entries
    },
    getEntryAtIndex(index: number): { url: string; title: string } | null {
      return this.entries[index] ?? null
    }
  }
  windowOpenHandler: ((details: Record<string, unknown>) => { action: string }) | null = null
  readonly executeJavaScript = vi.fn(async (_code: string): Promise<unknown> => undefined)
  readonly executeJavaScriptInIsolatedWorld = vi.fn(async (): Promise<unknown> => undefined)
  /** The whole page drawn again, asked as a page that loaded out of sight comes on screen (ElectronPage.show). */
  readonly invalidate = vi.fn()
  readonly loadURL = vi.fn(async (_url: string) => undefined)
  readonly downloadURL = vi.fn()
  /** `close(opts)`: what the page asked of Electron; the test emits `destroyed` or `will-prevent-unload` as Chromium would answer. */
  readonly close = vi.fn((_opts?: { waitForBeforeUnload: boolean }) => undefined)
  getURL(): string {
    return this.url
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  /** Whether something of the view loads (`isLoading`), and whether it is the page itself rather than a frame inside it (`isLoadingMainFrame`). */
  loading = false
  mainFrameLoading = true
  osProcessId = 4321
  isLoading(): boolean {
    return this.loading
  }
  isLoadingMainFrame(): boolean {
    return this.mainFrameLoading
  }
  getOSProcessId(): number {
    return this.osProcessId
  }
  reload(): void {}
  reloadIgnoringCache(): void {}
  stop(): void {}
  focus(): void {}
  setWindowOpenHandler(handler: (details: Record<string, unknown>) => { action: string }): void {
    this.windowOpenHandler = handler
  }
  /** The frame that has the focus (`webContents.focusedFrame`): the top document until a frame is clicked. A test may make reading it fail. */
  focusedFrame: { origin: string; parent: unknown } | null = null
  /** A real click of the user in the page (what lets it open a window or a link): Chromium tells of it twice, and the top document takes the focus. */
  click(): void {
    this.focusedFrame = { origin: new URL(this.url).origin, parent: null }
    this.emit('before-mouse-event', {}, { type: 'mouseDown' })
    this.emit('input-event', {}, { type: 'mouseDown' })
  }
  /** A real click in a frame of another site, which another process draws: `input-event` says nothing of it, and the frame takes the focus. */
  clickInFrame(origin: string): void {
    this.focusedFrame = { origin, parent: this.mainFrame }
    this.emit('before-mouse-event', {}, { type: 'mouseDown' })
    this.emit('before-mouse-event', {}, { type: 'mouseUp' })
  }
  /** `window.open` from a frame of the page whose document is at `from`. */
  openFromFrame(url: string, from: string): { action: string } {
    return this.open(url, { referrer: { url: from, policy: 'strict-origin-when-cross-origin' } })
  }
  /** `window.open` from the page, as Chromium hands it to the handler. */
  open(url: string, details: Record<string, unknown> = {}): { action: string } {
    return this.windowOpenHandler!({ url, disposition: 'foreground-tab', features: '', frameName: '', referrer: { url: '', policy: 'default' }, ...details })
  }
  /** A navigation of the top frame the page asks for: whether it was stopped. `initiator`: the frame that started it, as Electron names it. */
  navigateTo(url: string, initiator?: { origin: string } | null): boolean {
    let prevented = false
    this.emit('will-navigate', { preventDefault: () => (prevented = true), ...(initiator !== undefined ? { initiator } : {}) }, url)
    return prevented
  }
  /** The menu of a right click in the page, with what Chromium says of the place (the main frame unless told otherwise). */
  rightClick(params: Record<string, unknown>): BuiltItem[] {
    this.emit('context-menu', {}, { linkURL: '', srcURL: '', mediaType: 'none', isEditable: false, selectionText: '', misspelledWord: '', dictionarySuggestions: [], x: 10, y: 20, frame: this.mainFrame, ...params })
    return menus.at(-1)!
  }
}

/** The views Electron was asked to make (`new WebContentsView(options)`), each over a fake web contents. */
export const madeViews: FakeView[] = []

export class FakeView {
  readonly webContents = new FakePageContents()
  readonly setBorderRadius = vi.fn()
  readonly setBounds = vi.fn()
  constructor(readonly options: { webPreferences?: Record<string, unknown> }) {
    madeViews.push(this)
  }
}

export class FakeWindow extends EventEmitter {
  readonly id: number
  destroyed = false
  readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  constructor(id = 1) {
    super()
    this.id = id
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 100, y: 100, width: 1200, height: 800 }
  }
}

/** The window Electron makes for a `window.open` that `PopupWindows.request` allowed. */
export class FakePopupWindow extends FakeWindow {
  readonly webContents = new FakePageContents()
  readonly setContentBounds = vi.fn()
  /** Called where each window carries a menu bar (Linux, Windows), never on macOS: the platform layer decides. */
  readonly removeMenu = vi.fn()
  shown = false
  getContentSize(): number[] {
    return [500, 600]
  }
  getTitle(): string {
    return ''
  }
  setTitle(): void {}
  show(): void {
    this.shown = true
  }
  close(): void {}
  destroy(): void {
    this.destroyed = true
  }
}

/** What a page tells the shell: every event is a mock; a test adds the optional ones it needs. */
export function fakePageEvents(extra: Record<string, unknown> = {}) {
  return { update: vi.fn(), focused: vi.fn(), domReady: vi.fn(), searchSelection: vi.fn(), found: vi.fn(), openWindow: vi.fn(), ...extra }
}

/**
 * A real ElectronPage over fakes, made after the test file has put its mocks in place (the modules are loaded here, not at the top).
 * `networkSettled` is what the page waits for before it navigates (the engine gives it `beforeNavigation`).
 */
export async function makePage(options: { events?: Record<string, unknown>; networkSettled?: () => Promise<void> | undefined; popupPolicy?: (url: string) => boolean; lendHost?: (windowId: string) => unknown; relocate?: (windowId: string | undefined) => unknown; askAppLink?: (scheme: string, clicked: boolean, asker?: unknown) => Promise<boolean>; documentPip?: unknown } = {}) {
  const { ElectronPage } = await import('./electron-page')
  const { HttpsUpgrades } = await import('./https-upgrade')
  const { PopupWindows } = await import('./popup-windows')
  const { UnsavedRequests } = await import('./download-staging')
  const wc = new FakePageContents()
  const win = new FakeWindow()
  const events = fakePageEvents(options.events)
  const view = { webContents: wc, setBorderRadius: vi.fn(), setBounds: vi.fn() }
  const upgrades = new HttpsUpgrades()
  const page = new ElectronPage(
    'tab-1',
    view as never,
    win as never,
    events as never,
    upgrades,
    new PopupWindows(upgrades, () => 'allow'),
    null,
    new UnsavedRequests(),
    options.relocate as never,
    options.networkSettled,
    undefined,
    undefined,
    options.popupPolicy ? () => options.popupPolicy : undefined,
    options.lendHost as never,
    options.askAppLink,
    options.documentPip as never
  )
  return { page, wc, win, events, view }
}

/**
 * An engine with what `ElectronEngine.createPage` reads, on which the real method runs: for a page of a private context (no `profile`) or of a
 * profile, whose library is a mock (`extensions`) and whose loads are `ready`. `create(id)` makes a page and gives the view Electron was asked for.
 */
export async function engineForPages(profile?: { ready: Promise<void> | null; currentWindowId?: number }) {
  const { ElectronEngine } = await import('./electron-engine')
  const { HttpsUpgrades } = await import('./https-upgrade')
  const { PopupWindows } = await import('./popup-windows')
  const { UnsavedRequests } = await import('./download-staging')
  const { ColorSchemePages } = await import('./color-scheme')
  const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
  const windows = new Map<string, FakeWindow>([['main', new FakeWindow(1)], ['other', new FakeWindow(2)]])
  const session = {}
  const upgrades = new HttpsUpgrades()
  const library = { addTab: vi.fn(), followWindow: vi.fn() }
  const engine = {
    scopes: new Map(profile ? [] : [['private', { session, key: 'private', guard: null }]]),
    ensureProfile: () => (profile ? { session, ready: profile.ready, extensions: library, followWindow: library.followWindow } : undefined),
    getWindow: (windowId?: string) => windows.get(windowId ?? 'main')!,
    mediaBridge: { ensure: vi.fn() },
    installDialogBridge: vi.fn(),
    installChromeApp: vi.fn(),
    syncPasswordBridge: vi.fn(),
    // The protection of the frames and workers of a page has its own tests (inner-guard-wiring.test.ts).
    primeInnerGuard: vi.fn(),
    defaultAutoplay: 'allow',
    tabMeta: new Map<number, { profileId: string; win: FakeWindow }>(),
    upgrades,
    popups: new PopupWindows(upgrades, () => 'allow'),
    unsaved: new UnsavedRequests(),
    proxies: { settled: (): Promise<void> | undefined => undefined },
    beforeNavigation(...args: unknown[]) {
      return methods['beforeNavigation']!.apply(this, args)
    },
    lentStyles: new Map<string, string>(),
    forgetLentStyles(...args: unknown[]) {
      return methods['forgetLentStyles']!.apply(this, args)
    },
    blockExceptionHandlers: new Map(),
    miniOpener: undefined,
    popupPolicy: undefined,
    pages: new Map<string, unknown>(),
    colorSchemes: new ColorSchemePages<{ setColorScheme(scheme: 'light' | 'dark' | null): void }>(),
    extensionFrames: new Set(),
    currentWindowId: profile?.currentWindowId,
    pageByContents: new Map(),
    activeTabs: { forgetTab: vi.fn(), navigated: vi.fn() },
    // The captures of the sound of a tab are told where a tab goes (tab-capture.ts).
    tabCaptures: { targetNavigated: vi.fn() },
    tabClosedListeners: []
  }
  const create = (id: string, windowId?: string, extensionPanel = false) => {
    const events = fakePageEvents()
    const page = methods['createPage']!.call(engine, { id, profileId: profile ? 'default' : 'private', windowId, ...(extensionPanel ? { extensionPanel } : {}) }, events) as {
      loadURL(url: string): void
      moveToWindow(windowId: string | undefined): boolean
    }
    return { page, view: madeViews.at(-1)!, events }
  }
  /** The colour scheme of the whole application, as the shell asks for it. */
  const setPageColorScheme = (scheme: 'light' | 'dark' | null): void => void methods['setPageColorScheme']!.call(engine, scheme)
  return { engine, create, library, windows, setPageColorScheme }
}

/** The item of `menu` whose label is `label`. */
export function itemLabelled(menu: BuiltItem[], label: string): BuiltItem | undefined {
  return menu.find((item) => item.label === label)
}

/** Lets the promises of the page settle. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
