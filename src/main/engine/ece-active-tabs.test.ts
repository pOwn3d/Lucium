import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { ActiveTabGrants } from '@shared/extension-access'
import { keepActiveTabPerWindow, restrictLibraryApis, tabMovedTo, windowFocusOf, type EceRouter } from './ece-router'
import { inertEngine } from '../profile-made.test-support'

// The library the engine makes for a profile (`ensureProfile`) is the one loaded below, over the same stand-in of Electron: the test that runs the engine is the last one.
const held = vi.hoisted(() => ({ library: undefined as unknown }))
vi.mock('electron', async () => (await import('../profile-made.test-support')).profileElectron())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: held.library }))
vi.mock('electron-chrome-web-store', () => ({}))

// The popup of Dashlane, closed and opened again in another window of the same profile, used to show its bars and nothing between them. These tests run the
// REAL electron-chrome-extensions (its store, its tabs and windows APIs, the way it builds a popup) on windows and tabs that are plain objects: there is no Electron process, so
// `electron` is a stub for the time the library is loaded. What is not checked here: a real window, a real popup page, and what Dashlane itself does with the answer.

const require = createRequire(import.meta.url)
const nodeModule = require('node:module') as { _load: (this: unknown, request: string, ...rest: unknown[]) => unknown }

class FakeWindow extends EventEmitter {
  destroyed = false
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isFocused(): boolean {
    return false
  }
  getPosition(): number[] {
    return [0, 0]
  }
  getSize(): number[] {
    return [900, 700]
  }
  getBounds() {
    return { x: 0, y: 0, width: 900, height: 700 }
  }
  getContentBounds() {
    return { x: 0, y: 28, width: 900, height: 672 }
  }
  isMaximized(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  isFullScreen(): boolean {
    return false
  }
  isAlwaysOnTop(): boolean {
    return false
  }
}

/** What the library makes for a popup: `new BrowserWindow(...)` with the window it hangs from in `parent`. Every one made is kept, to see none is reused. */
const madePopups: PopupWindow[] = []
class PopupWindow extends FakeWindow {
  readonly webContents = new PopupContents()
  readonly parent: FakeWindow
  constructor(options: { parent: FakeWindow }) {
    super(1000 + madePopups.length)
    this.parent = options.parent
    madePopups.push(this)
  }
  setBounds(): void {}
  show(): void {}
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
}

class PopupContents extends EventEmitter {
  readonly loaded: string[] = []
  private url = ''
  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    this.url = url
    return Promise.resolve()
  }
  getURL(): string {
    return this.url
  }
  isDevToolsOpened(): boolean {
    return false
  }
  isDestroyed(): boolean {
    return false
  }
}

class FakeTab extends EventEmitter {
  favicon: string | undefined
  constructor(
    readonly id: number,
    readonly url: string,
    readonly session: unknown
  ) {
    super()
  }
  isDestroyed(): boolean {
    return false
  }
  isCurrentlyAudible(): boolean {
    return false
  }
  isLoading(): boolean {
    return false
  }
  isLoadingMainFrame(): boolean {
    return false
  }
  getTitle(): string {
    return `Tab ${this.id}`
  }
  getURL(): string {
    return this.url
  }
  getType(): string {
    return 'webview'
  }
  get audioMuted(): boolean {
    return false
  }
}

const electronStub = new Proxy(
  {
    // Every library made over this stand-in listens to its `web-contents-created`: more than the ten an emitter allows are made in this file.
    app: Object.assign(new EventEmitter().setMaxListeners(0), { isReady: () => true, getAppPath: () => '/nonexistent' }),
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: Object.assign(PopupWindow, { getAllWindows: () => [], fromWebContents: () => null }),
    BaseWindow: { getAllWindows: () => [] },
    webContents: { fromId: () => undefined }
  } as Record<string, unknown>,
  { get: (target, name: string) => (name in target ? target[name] : class Unused {}) }
)

let Library: new (options: Record<string, unknown>) => ElectronChromeExtensions

beforeAll(() => {
  // The library asks the version of Electron when it builds a popup.
  Object.defineProperty(process.versions, 'electron', { value: '45.0.0', configurable: true, enumerable: true })
  const real = nodeModule._load
  nodeModule._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? electronStub : real.call(this, request, ...rest)
  }
  try {
    Library = (require('electron-chrome-extensions') as { ElectronChromeExtensions: typeof Library }).ElectronChromeExtensions
  } finally {
    nodeModule._load = real
  }
  held.library = Library
})

const sorted = (ids: number[]): number[] => [...ids].sort((one, other) => one - other)
afterAll(() => {
  delete (process.versions as Record<string, unknown>)['electron']
})

const WINDOWS = { A: 11, B: 12, C: 13 }
const X = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const Y = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
const MANIFESTS: Record<string, unknown> = { [X]: { permissions: ['tabs'], host_permissions: ['<all_urls>'] }, [Y]: { permissions: ['tabs'], host_permissions: ['<all_urls>'] } }
const INTERFACE = (window: number) => ({ kind: 'interface', window, session: 'the default session', getURL: () => 'file:///app/index.html' })

/** One profile with the library on it, and the windows of the application: `fix` is what the engine does when it makes a profile. */
function profile(fix: boolean, trace?: (message: string) => void) {
  const session = Object.assign(new EventEmitter(), {
    serviceWorkers: new EventEmitter(),
    protocol: { isProtocolHandled: () => false, handle() {} },
    getPreloads: () => [],
    setPreloads() {},
    getExtension: () => undefined,
    getAllExtensions: () => [],
    isPersistent: () => true,
    cookies: new EventEmitter()
  })
  const extensions = new Library({ license: 'GPL-3.0', session, createTab: async () => Promise.reject(new Error('unused')) })
  if (fix) keepActiveTabPerWindow(extensions)
  const router = (extensions as unknown as { ctx: { router: EceRouter } }).ctx.router
  const windows = new Map<number, FakeWindow>(Object.values(WINDOWS).map((id) => [id, new FakeWindow(id)]))
  const windowOfTab = new Map<number, number>()
  const tabsById = new Map<number, FakeTab>()
  const shown = new Map<number, number>()
  let next = 100

  /** A tab of the application is added to the library with its window; the one a window shows is told to it (the engine's `activatePage`). */
  const open = (window: number, show = true): number => {
    const tab = new FakeTab(++next, `https://site-${next}.example/`, session)
    tabsById.set(tab.id, tab)
    windowOfTab.set(tab.id, window)
    extensions.addTab(tab as never, windows.get(window) as never)
    if (show) display(tab.id)
    return tab.id
  }
  /** A tab dropped on another window takes its page there: the engine tells the library the window it is in now (see `tabMovedTo`). */
  const move = (tabId: number, window: number): void => {
    windowOfTab.set(tabId, window)
    tabMovedTo(extensions, tabsById.get(tabId) as never, windows.get(window) as never)
  }
  const display = (tabId: number): void => {
    shown.set(windowOfTab.get(tabId)!, tabId)
    extensions.selectTab(tabsById.get(tabId) as never)
  }
  const popups: Array<{ window: PopupWindow; parent: number; extension: string }> = []
  extensions.on('browser-action-popup-created', (popup: { browserWindow: PopupWindow; parent: FakeWindow; extensionId: string }) => popups.push({ window: popup.browserWindow, parent: popup.parent.id, extension: popup.extensionId }))

  const manifests = MANIFESTS
  restrictLibraryApis(router, {
    grants: new ActiveTabGrants(),
    tabUrl: (tab) => tabsById.get(tab)?.url,
    manifestOf: (id) => manifests[id],
    extensionIds: () => Object.keys(manifests),
    activated: () => {},
    fromInterface: (sender) => (sender as { kind?: string }).kind === 'interface',
    shownTabOfSender: (sender) => shown.get((sender as { window: number }).window),
    activeTabOfSender: (sender) => shown.get((sender as { window: number }).window),
    tabInWindowOfSender: (sender, tab) => windowOfTab.get(tab) === (sender as { window: number }).window,
    ...(trace ? { trace } : {})
  })
  // Each extension's worker sets the popup of its button (the manifest's default_popup, as the library would read it).
  for (const id of [X, Y]) void router.handlers.get('browserAction.setPopup')!.callback({ extension: { id, manifest: MANIFESTS[id] }, sender: { scope: `chrome-extension://${id}/` } }, { popup: 'popup.html' })

  /** What the interface of the window does when the user clicks the icon: the number the icon carries is the one the library's state gives. */
  const click = async (window: number, extension: string): Promise<(typeof popups)[number]> => {
    // The window the user is in (the engine does this when a window takes the focus).
    windowFocusOf(extensions).follow(window)
    const state = (await router.handlers.get('browserAction.getState')!.callback({ sender: INTERFACE(window) })) as { activeTabId?: number }
    // The library ignores a call that does not come from a frame (a page of the interface is one).
    const fromFrame = { type: 'frame', sender: INTERFACE(window) }
    await router.handlers.get('browserAction.activate')!.callback(fromFrame, { eventType: 'click', extensionId: extension, tabId: state.activeTabId ?? -1, anchorRect: { x: 800, y: 4, width: 24, height: 24 } })
    return popups[popups.length - 1]!
  }
  /** What the page of the popup asks first: the tab of the window it was opened in. */
  const popupAsks = async (popup: (typeof popups)[number], query: Record<string, unknown> = { active: true, currentWindow: true }): Promise<number[]> => {
    const asked = (await router.handlers.get('tabs.query')!.callback({ extension: { id: popup.extension, manifest: MANIFESTS[popup.extension] }, sender: popup.window.webContents }, query)) as Array<{ id: number }>
    return asked.map((tab) => tab.id)
  }
  const query = async (info: Record<string, unknown>): Promise<number[]> => ((await router.handlers.get('tabs.query')!.callback({ extension: { id: X, manifest: MANIFESTS[X] }, sender: { scope: `chrome-extension://${X}/` } }, info)) as Array<{ id: number }>).map((tab) => tab.id)
  return { extensions, open, move, display, click, popupAsks, query, popups, shown }
}

describe('which tab is "active", with several windows on one profile (the real library)', () => {
  it('premise: the library clears the flag of the tab on show in a window when a tab is activated in another one, and re-activating that tab does not bring it back', async () => {
    const world = profile(false)
    const a = world.open(WINDOWS.A)
    world.open(WINDOWS.B)
    const b2 = world.open(WINDOWS.B)
    expect(await world.query({ active: true })).toEqual([b2])
    expect(await world.query({ active: true, windowId: WINDOWS.A })).toEqual([])
    // The user comes back to window A and its tab is told to the library again: it is already the one on show there, the library returns early, nothing is repaired.
    world.display(a)
    expect(await world.query({ active: true, windowId: WINDOWS.A })).toEqual([])
  })

  it('keeps the tab on show in each window active, whichever window a tab was last activated in', async () => {
    const world = profile(true)
    const a = world.open(WINDOWS.A)
    const b = world.open(WINDOWS.B)
    const c = world.open(WINDOWS.C)
    expect(sorted(await world.query({ active: true }))).toEqual(sorted([a, b, c]))
    const b2 = world.open(WINDOWS.B)
    expect(sorted(await world.query({ active: true }))).toEqual(sorted([a, b2, c]))
    // Switching back to the first tab of B, then opening a new tab in C.
    world.display(b)
    const c2 = world.open(WINDOWS.C)
    expect(sorted(await world.query({ active: true }))).toEqual(sorted([a, b, c2]))
    for (const [name, id] of Object.entries(WINDOWS)) expect(await world.query({ active: true, windowId: id }), `window ${name}`).toEqual([world.shown.get(id)])
  })

  it('keeps the tab of a window active when another window opens a second tab and the user comes back to the first window', async () => {
    const world = profile(true)
    const a = world.open(WINDOWS.A)
    world.open(WINDOWS.B)
    world.open(WINDOWS.B)
    world.display(a)
    expect(await world.query({ active: true, windowId: WINDOWS.A })).toEqual([a])
  })
})

describe('the popup of an extension icon, closed and opened again in other windows of one profile (the real library)', () => {
  /** Three windows with two tabs each; the tab on show in each window is the last one opened. */
  function threeWindows(fix = true) {
    const world = profile(fix)
    const tabs: Record<string, number[]> = { A: [], B: [], C: [] }
    for (const [name, id] of Object.entries(WINDOWS)) tabs[name]!.push(world.open(id), world.open(id))
    return { world, tabs }
  }

  it('builds a new popup for every click, hangs it from the window that was clicked, and finds the tab of that window', async () => {
    const { world, tabs } = threeWindows()
    const before = madePopups.length
    const steps: Array<[string, string]> = [['A', X], ['B', X], ['C', X], ['A', X], ['A', X], ['B', X], ['B', Y], ['C', Y], ['A', Y], ['C', X]]
    const seen: Array<{ popup: PopupWindow; parent: number; found: number[] }> = []
    for (const [step, [name, extension]] of steps.entries()) {
      const window = WINDOWS[name as keyof typeof WINDOWS]
      // The user changes tabs in the other windows between two clicks (the first tab of a window, then the second, and so on).
      for (const other of Object.keys(WINDOWS).filter((n) => n !== name)) world.display(tabs[other]![step % 2]!)
      const popup = await world.click(window, extension)
      seen.push({ popup: popup.window, parent: popup.parent, found: await world.popupAsks(popup) })
      expect(popup.parent, `${extension === X ? 'X' : 'Y'} in ${name}`).toBe(window)
      expect(popup.window.webContents.loaded, `${extension === X ? 'X' : 'Y'} in ${name}`).toEqual([`chrome-extension://${extension}/popup.html`])
      expect(await world.popupAsks(popup), `the tab the popup of ${extension === X ? 'X' : 'Y'} finds in ${name}`).toEqual([world.shown.get(window)])
      // The user closes it (a click elsewhere): the library destroys the window and the page with it.
      popup.window.destroy()
    }
    // Nothing is reused: one window and one page load per click.
    expect(madePopups.length - before).toBe(steps.length)
    expect(new Set(seen.map((s) => s.popup)).size).toBe(steps.length)
    expect(seen.every((s) => s.found.length === 1)).toBe(true)
  })

  it('does the same with the tab shown in a window changed in between, in the window clicked first and in a third one', async () => {
    const { world, tabs } = threeWindows()
    const first = await world.click(WINDOWS.A, X)
    expect(await world.popupAsks(first)).toEqual([world.shown.get(WINDOWS.A)])
    first.window.destroy()
    // Another window changes tabs, then the popup is opened there, then in a third window, then back in the first.
    world.display(tabs.B![0]!)
    for (const window of [WINDOWS.B, WINDOWS.C, WINDOWS.A, WINDOWS.A]) {
      const popup = await world.click(window, X)
      expect(await world.popupAsks(popup), `window ${window}`).toEqual([world.shown.get(window)])
      popup.window.destroy()
    }
  })

  it('premise: without the correction, the popup opened in a window whose tab is not the last one activated finds no tab', async () => {
    const { world } = threeWindows(false)
    // The three windows were filled one after the other: the tab on show in the last one is the only one the library calls active.
    const inLast = await world.click(WINDOWS.C, X)
    expect(await world.popupAsks(inLast)).toEqual([world.shown.get(WINDOWS.C)])
    inLast.window.destroy()
    const inFirst = await world.click(WINDOWS.A, X)
    expect(inFirst.parent).toBe(WINDOWS.A)
    expect(await world.popupAsks(inFirst)).toEqual([])
  })
})

describe('a tab dropped on another window of the profile (the real library)', () => {
  it('is the tab the popup of that window finds, and it is no longer in the window it left', async () => {
    const world = profile(true)
    const x = world.open(WINDOWS.A)
    const b1 = world.open(WINDOWS.B)
    const b2 = world.open(WINDOWS.B)
    world.move(x, WINDOWS.B)
    world.display(x)
    windowFocusOf(world.extensions).follow(WINDOWS.B)
    expect(await world.query({ active: true, currentWindow: true })).toEqual([x])
    expect(await world.query({ windowId: WINDOWS.B })).toEqual(sorted([x, b1, b2]))
    expect(await world.query({ windowId: WINDOWS.A })).toEqual([])
  })

  it('refuses to work when the library keeps its tabs somewhere else, instead of leaving the windows of its tabs wrong', () => {
    expect(() => tabMovedTo({} as never, { id: 1 }, { id: 2 })).toThrow('changed its internals')
  })

  // That the engine asks for it when a page changes window, with the library of its profile: popup-window-wiring.test.ts.
})

describe('keepActiveTabPerWindow', () => {
  const fake = (over: Record<string, unknown> = {}) => {
    const tab = (id: number, shownId: number) => ({ id, shownId, isDestroyed: () => false })
    const tabs = new Set([tab(1, 1), tab(2, 1), tab(3, 3)])
    const cache = new Map<number, { active: boolean }>([[1, { active: false }], [2, { active: false }], [3, { active: false }]])
    const tabsApi = { onActivated: vi.fn((_tabId: number) => 'done') }
    const library = { ctx: { store: { tabs, tabDetailsCache: cache, getActiveTabFromWebContents: (t: { shownId: number }) => ({ id: t.shownId }) } }, api: { tabs: tabsApi }, ...over }
    return { library, cache, tabsApi, original: tabsApi.onActivated }
  }

  it('puts the flag of every tab back to "is the one on show in its window" after the library activated a tab, and returns what the library returned', () => {
    const { library, cache, tabsApi, original } = fake()
    keepActiveTabPerWindow(library as never)
    expect(tabsApi.onActivated(2)).toBe('done')
    expect(original).toHaveBeenCalledWith(2)
    expect([...cache.values()].map((t) => t.active)).toEqual([true, false, true])
  })

  it('does it also when the library throws, and lets the error through', () => {
    const { library, cache, tabsApi } = fake()
    tabsApi.onActivated.mockImplementation(() => {
      throw new Error('Active tab has no parent window')
    })
    keepActiveTabPerWindow(library as never)
    expect(() => tabsApi.onActivated(2)).toThrow('Active tab has no parent window')
    expect([...cache.values()].map((t) => t.active)).toEqual([true, false, true])
  })

  it('leaves alone a tab that is gone, or that the cache has no details for', () => {
    const { library, cache, tabsApi } = fake()
    const store = (library.ctx.store as unknown as { tabs: Set<{ id: number; isDestroyed(): boolean }> }).tabs
    store.add({ id: 4, isDestroyed: () => true })
    store.add({ id: 5, isDestroyed: () => false })
    cache.set(4, { active: true })
    keepActiveTabPerWindow(library as never)
    tabsApi.onActivated(1)
    expect(cache.get(4)).toEqual({ active: true })
    expect(cache.has(5)).toBe(false)
  })

  it('fails loudly when the library keeps its tabs somewhere else, instead of leaving the flags wrong', () => {
    expect(() => keepActiveTabPerWindow({} as never)).toThrow('changed its internals')
    expect(() => keepActiveTabPerWindow(fake({ api: {} }).library as never)).toThrow('changed its internals')
    expect(() => keepActiveTabPerWindow(fake({ ctx: { store: { tabs: [], tabDetailsCache: new Map(), getActiveTabFromWebContents: () => undefined } } }).library as never)).toThrow('changed its internals')
  })

  // That the engine gives the router no trace while the log of the extensions is off: engine-security-wiring.test.ts.
})

describe('the trace of a question about "the tab" that found none (LUCIUM_EXT_LOG=1)', () => {
  /** Window A shows its tab, then window B switches tabs: the situation in which the library answers "no tab" for A unless it is corrected. */
  async function askedInA(fix: boolean, trace?: (message: string) => void) {
    const world = profile(fix, trace)
    world.open(WINDOWS.A)
    world.open(WINDOWS.B)
    world.open(WINDOWS.B)
    windowFocusOf(world.extensions).follow(WINDOWS.A)
    return world.query({ active: true, currentWindow: true })
  }

  it('says which question, which extension, and where the tabs the library answered with are', async () => {
    const lines: string[] = []
    expect(await askedInA(false, (message) => lines.push(message))).toEqual([])
    expect(lines).toEqual([`tabs.query {"active":true,"currentWindow":true} by ${X} found no tab: the library answered with 1 (in windows [${WINDOWS.B}]), current window ${WINDOWS.A}`])
  })

  it('writes nothing when the engine did not ask for a trace, nor for a question that found its tab', async () => {
    const lines: string[] = []
    expect(await askedInA(false)).toEqual([])
    expect(await askedInA(true, (message) => lines.push(message))).toHaveLength(1)
    expect(lines).toEqual([])
  })
})

describe('the library of a profile the engine makes (ensureProfile, run over the real library)', () => {
  it('keeps the tab on show in each window active: what a popup opened in the first window asks, after a second window switched tabs', async () => {
    const { ElectronEngine } = await import('./electron-engine')
    const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
    const urls = new Map<number, string>()
    const engine = Object.assign(
      Object.create(ElectronEngine.prototype) as object,
      inertEngine({
        loaded: new Map([[`default:${X}`, { id: X }]]),
        manifests: new Map([[`default:${X}`, MANIFESTS[X]]]),
        activeTabs: new ActiveTabGrants(),
        pages: new Map(),
        profileOfTab: () => 'default',
        tabUrl: (tab: number) => urls.get(tab)
      })
    )
    const made = methods['ensureProfile']!.call(engine, 'default') as { session: unknown; extensions: ElectronChromeExtensions; router: EceRouter }
    const windows = { A: new FakeWindow(WINDOWS.A), B: new FakeWindow(WINDOWS.B) }
    const open = (window: FakeWindow, id: number): FakeTab => {
      const tab = new FakeTab(id, `https://site-${id}.example/`, made.session)
      urls.set(id, tab.url)
      made.extensions.addTab(tab as never, window as never)
      made.extensions.selectTab(tab as never)
      return tab
    }
    const a = open(windows.A, 101)
    open(windows.B, 201)
    open(windows.B, 202)
    const query = async (info: Record<string, unknown>): Promise<number[]> =>
      ((await made.router.handlers.get('tabs.query')!.callback({ extension: { id: X, manifest: MANIFESTS[X] }, sender: { scope: `chrome-extension://${X}/` } }, info)) as Array<{ id: number }>).map((tab) => tab.id)
    // Window B switched tabs after window A showed its tab: without the correction the library calls the tab of A inactive.
    expect(await query({ active: true, windowId: WINDOWS.A })).toEqual([a.id])
    expect(sorted(await query({ active: true }))).toEqual(sorted([101, 202]))
  })
})
