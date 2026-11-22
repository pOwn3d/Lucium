// The menus as they are built, kept on record: the menu bar (menu.ts, `buildMenu`) and the context menus of the sidebar (context-menus.ts,
// `menuItems`), for several states, written out entry by entry (every option of an entry, its icon, whether it has a click, its submenu) and
// compared with __snapshots__/menu-templates.test.ts.snap. The record was taken before the two builders were cut into one module per menu: it is
// what proves the cut moved code and changed no entry (order, label, key, greying, check marks, icons). A change of a menu that is meant shows
// here as a difference: read it, then take the record again (`npx vitest run -u src/main/shell/menu-templates.test.ts`).

import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { DownloadInfo, Settings, SidebarState } from '@shared/model'
import type { ExtensionInfo, MenuTarget } from '@shared/ipc'
import type { WindowEntry } from '@shared/window-names'
import type { MenuFacts } from '@shared/menu-state'
import { DEFAULT_OLLAMA_CONFIG } from '@shared/ollama'
import { MENU_ICON_PNG, MENU_ICON_RED_PNG } from './menu-icons-data'

// Electron's `Menu` hands the template back, and an icon keeps the picture it was made from (named below by the table of the icons).
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const nativeImage = {
    createFromBuffer: (bytes: Buffer) => {
      const icon = { base64: bytes.toString('base64'), template: false, isEmpty: () => false, setTemplateImage: (value: boolean) => void (icon.template = value) }
      return icon
    }
  }
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} }, nativeImage }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
// The menus of macOS on every runner: the record is the one of the system the application is published for.
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu, type MenuActions, type MenuOptions } from './menu'
import { menuItems, type MenuContext } from './context-menus'
import { setLockService } from '../lock-service'

afterEach(() => setLockService(null))

// ---- Writing a template out ----

const ICON_NAMES = new Map<string, string>()
for (const [name, base64] of Object.entries(MENU_ICON_RED_PNG)) ICON_NAMES.set(base64, `red:${name}`)
for (const [name, base64] of Object.entries(MENU_ICON_PNG)) if (!ICON_NAMES.has(base64)) ICON_NAMES.set(base64, name)

type Entry = Record<string, unknown>

const iconOf = (icon: unknown): string => {
  const { base64, template } = icon as { base64: string; template: boolean }
  return `${ICON_NAMES.get(base64) ?? 'unknown'}${template ? '(template)' : ''}`
}

/**
 * One line per entry, its submenu indented under it: every option it has, sorted (an option set to `undefined` too), its icon by name, and
 * `click` when it has one. `away`: a click that first brings the window back (MenuOptions.away) is written `click(brings back)`.
 */
function written(items: readonly Entry[], away = false, depth = 0): string[] {
  return items.flatMap((item) => {
    const options = Object.keys(item)
      .filter((key) => key !== 'submenu' && key !== 'click' && key !== 'icon')
      .sort()
      .map((key) => `${key}=${item[key] === undefined ? 'undefined' : JSON.stringify(item[key])}`)
    if ('icon' in item) options.push(`icon=${iconOf(item['icon'])}`)
    const click = item['click']
    if (typeof click === 'function') options.push(away && String(click).includes('reveal()') ? 'click(brings back)' : 'click')
    const line = `${'  '.repeat(depth)}- ${options.join(' ')}`
    const submenu = item['submenu']
    return Array.isArray(submenu) ? [line, ...written(submenu as Entry[], away, depth + 1)] : [line]
  })
}

// ---- The states ----

const withSettings = (state: SidebarState, patch: Partial<Settings>): SidebarState => ({ ...state, settings: { ...state.settings, ...patch } })

/** Every setting that adds an entry to a menu, on. */
const RICH_SETTINGS: Partial<Settings> = {
  nameWindows: true,
  guestProfile: true,
  privateTabs: true,
  tabContainers: true,
  pdfWithSource: true,
  passwordManager: true,
  bookmarkManager: true,
  liveFolders: true,
  webAppWindows: true,
  notes: true,
  tabSearch: true,
  shortcutHelp: true,
  compactMode: true,
  cookieManager: true,
  tabTree: true,
  webStoreInstall: true,
  qrCode: true,
  translateLocal: true,
  pageWatch: true,
  scrollSync: true,
  batterySaver: true,
  webPanels: true,
  aiSummary: true,
  ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true },
  boostSharing: true,
  openWithMemory: true,
  downloadPause: true,
  downloadResume: true,
  siteDataClearOnCloseEnabled: true,
  sleepExcludedKeepAll: true,
  profileNames: { work: 'Travail' },
  unpinnedExtensions: ['ext-b'],
  openWithApps: { pdf: '/Applications/Preview.app' }
}

/**
 * Three spaces (the third put aside), the first with a web panel; in it a (on screen, a child under it, reloading itself every 30 s), b and c
 * in a split view, d pinned in a folder and gone from its address; a favourite, a live folder, a tab archived in this session, a container.
 */
function fixture(settings: Partial<Settings> = RICH_SETTINGS) {
  let n = 0
  const ctx = { now: 1_000, newId: () => `id${++n}` }
  const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((acc, action) => reduce(acc, action, ctx), state)
  let s = withSettings(createInitialState(ctx), settings)
  s = run(s, { type: 'container/create', name: 'Banque' })
  const home = s.spaces[0]!.id
  s = run(s, { type: 'space/create', name: 'Autre', emoji: '🎨', hue: 40 }, { type: 'space/create', name: 'Lecture', emoji: '📚', hue: 200 })
  const [, other, reading] = s.spaces.map((space) => space.id) as [string, string, string]
  s = run(s, { type: 'space/update', id: other, patch: { profileId: 'work' } }, { type: 'space/select', id: home })
  for (const host of ['a', 'b', 'c', 'd', 'z']) s = run(s, { type: 'tab/open', url: `https://${host}.example.org/`, background: true })
  const id = (host: string) => s.tabs.find((tab) => tab.url === `https://${host}.example.org/`)!.id
  const [a, b, c, d, z] = ['a', 'b', 'c', 'd', 'z'].map(id) as [string, string, string, string, string]
  s = run(s, { type: 'tab/archive', id: z }, { type: 'tab/pin', id: d }, { type: 'split/create', tabId: b, withTabId: c })
  s = run(s, { type: 'favorite/add', url: 'https://fav.example.org/', title: 'Fav' }, { type: 'folder/create', name: 'Dossier' })
  const folder = s.folders[0]!.id
  s = run(s, { type: 'tab/move', id: d, toIndex: 0, pinned: true, folderId: folder })
  s = run(s, { type: 'livefolder/create', source: { kind: 'feed', url: 'https://feed.example.org/rss' }, name: 'Live' })
  s = run(s, { type: 'tab/open', url: 'https://child.example.org/', background: true, parentId: a }, { type: 'tab/update', id: d, patch: { url: 'https://d.example.org/elsewhere' } })
  s = run(s, { type: 'tab/auto-reload', id: a, seconds: 30 }, { type: 'space/panel-add', id: home, panelId: 'panel-1', url: 'https://panel.example.org/', title: 'Volet' })
  s = run(s, { type: 'space/aside', id: reading }, { type: 'space/select', id: home }, { type: 'tab/select', id: a })
  const child = s.tabs.find((tab) => tab.url === 'https://child.example.org/')!.id
  return { state: s, a, b, c, d, child, home, other, folder, live: s.folders.find((f) => f.live)?.id ?? '', favorite: s.favorites[0]!.id }
}

const EXTENSIONS: ExtensionInfo[] = [
  {
    id: 'ext-a',
    name: 'Alpha',
    version: '1.0',
    profileId: 'default',
    source: 'unpacked',
    enabled: true,
    commands: [
      { name: 'run', description: 'Lancer Alpha', accelerator: 'Alt+Shift+K', label: 'Lancer Alpha' },
      { name: 'clash', description: 'Prendre un raccourci de Lucium', accelerator: 'CmdOrCtrl+T', label: 'Prendre' },
      { name: '_execute_action', description: '', accelerator: 'Alt+Shift+J', label: 'Action' }
    ]
  },
  { id: 'ext-b', name: 'Beta', version: '2.0', profileId: 'default', source: 'store', enabled: true }
]

const WINDOWS: WindowEntry[] = [
  { id: 'main', kind: 'main', name: 'Travail', position: 1, focused: true },
  { id: 'w2', kind: 'window', position: 2, focused: false },
  { id: 'w3', kind: 'private', position: 3, focused: false }
]

const DOWNLOADS: DownloadInfo[] = [
  { id: 'dl-done', filename: 'rapport.pdf', url: 'https://files.example.org/rapport.pdf', path: '/tmp/rapport.pdf', state: 'completed', receivedBytes: 10, totalBytes: 10, startedAt: 1 },
  { id: 'dl-running', filename: 'film.mp4', url: 'https://files.example.org/film.mp4', path: '/tmp/film.mp4', state: 'progressing', receivedBytes: 5, totalBytes: 10, startedAt: 2 },
  { id: 'dl-paused', filename: 'image.iso', url: 'https://files.example.org/image.iso', path: '/tmp/image.iso', state: 'progressing', paused: true, receivedBytes: 5, totalBytes: 10, startedAt: 3 },
  { id: 'dl-cut', filename: 'archive.zip', url: 'https://files.example.org/archive.zip', path: '/tmp/archive.zip', state: 'interrupted', resumable: true, recorded: true, receivedBytes: 5, totalBytes: 10, startedAt: 4 },
  { id: 'dl-app', filename: 'installer.pkg', url: 'https://files.example.org/installer.pkg', path: '/tmp/installer.pkg', state: 'completed', mimeType: 'application/octet-stream', receivedBytes: 10, totalBytes: 10, startedAt: 5 }
]

/** The window's browser: what the menus read of it while they are built. Anything else answers nothing. */
function fakeBrowser(state: SidebarState, own: Record<string, unknown> = {}) {
  const a = state.tabs.find((tab) => tab.url === 'https://a.example.org/')?.id
  const b = state.tabs.find((tab) => tab.url === 'https://b.example.org/')?.id
  const base: Record<string, unknown> = {
    isPrivate: () => false,
    menuFacts: (): MenuFacts => ({ canGoBack: true, canGoForward: false, loading: true, finding: true, scrollSynced: true, saverAsked: true, sound: 'muted', translate: { state: 'offered', to: 'en' } }),
    windowSidebar: () => ({ side: 'right', docked: true }),
    isDeveloperPage: () => true,
    snapshot: () => ({ runtime: { tabs: a ? { [a]: { muted: false, audible: true } } : {} }, extensions: EXTENSIONS, downloads: DOWNLOADS }),
    livePageIds: () => (a ? [a] : []),
    sleepStateOf: (tabId: string) => (tabId === a ? 'awake' : tabId === b ? 'frozen' : 'asleep'),
    isShown: (tabId: string) => tabId === a,
    isScrollSynced: () => true,
    isSystemDark: () => false,
    windowMoveChoices: () => [{ id: 'w2', label: 'Fenêtre 2', title: 'Une page' }],
    navigationHistory: (direction: 'back' | 'forward') =>
      direction === 'back'
        ? [
            { index: 0, title: 'Premier', url: 'https://one.example.org/' },
            { index: 1, title: '', url: 'https://two.example.org/path' }
          ]
        : [],
    ...own
  }
  return new Proxy(base, { get: (target, prop: string) => (prop in target ? target[prop] : () => undefined) }) as never
}

/** The actions of the menu bar, each a function of its own (the menu tells some of them apart by identity). `rich`: every optional one given. */
function menuActions(rich: boolean): MenuActions {
  return {
    importDialog: () => {},
    showFirstLaunch: () => {},
    showWelcome: () => {},
    showWhatsNew: () => {},
    exportBookmarks: () => {},
    loadExtension: () => {},
    clearHistory: () => {},
    clearEverything: () => {},
    newIdentity: () => {},
    setDefaultBrowser: () => {},
    isDefaultBrowser: () => rich,
    savePage: () => {},
    clearArchive: () => {},
    showDataFolder: () => {},
    copyInfo: () => {},
    openTaskManager: () => {},
    showAbout: () => {},
    newWindow: () => {},
    blankWindow: () => {},
    privateWindow: () => {},
    guestWindow: () => {},
    ...(rich ? { shareWindow: () => {}, annotatePage: () => {}, annotatingPage: () => true, lockNow: () => {} } : {}),
    closeWindow: () => {},
    extensions: () => (rich ? EXTENSIONS : []),
    checkForUpdates: () => {},
    showPrivacyPolicy: () => {},
    restoreData: () => {},
    recordTrace: () => {},
    isRecordingTrace: () => rich,
    openDocumentation: () => {},
    windows: () => (rich ? WINDOWS : []),
    focusWindow: () => {},
    setWindowName: () => {},
    window: () => ({}) as BrowserWindow,
    sessionStart: 0
  }
}

const store = (state: SidebarState) => ({ get: () => state }) as never

function menuBar(state: SidebarState, rich: boolean, options: MenuOptions = {}, own: Record<string, unknown> = {}): string {
  const template = buildMenu(fakeBrowser(state, own), store(state), menuActions(rich), options) as unknown as Entry[]
  return written(template, options.away !== undefined).join('\n')
}

function contextMenu(target: MenuTarget, state: SidebarState, context: MenuContext = { clipboardText: '', headers: true }, own: Record<string, unknown> = {}): string {
  return written(menuItems(target, fakeBrowser(state, own), store(state), {} as never, context) as unknown as Entry[]).join('\n')
}

// ---- The records ----

describe('the menu bar, as built', () => {
  it('for a first launch: one space, no tab, every optional setting off', () => {
    expect(menuBar(createInitialState({ now: 1_000, newId: ((n) => () => `id${++n}`)(0) }), false, {}, { menuFacts: undefined, windowSidebar: () => null, isDeveloperPage: () => false })).toMatchSnapshot()
  })

  it('with every optional entry, a Today tab on screen', () => {
    expect(menuBar(fixture().state, true)).toMatchSnapshot()
  })

  it('with every optional entry, a pinned tab of a folder on screen', () => {
    const f = fixture()
    expect(menuBar({ ...f.state, activeTabBySpace: { ...f.state.activeTabBySpace, [f.home]: f.d } }, true)).toMatchSnapshot()
  })

  it('in a private window', () => {
    expect(menuBar(fixture().state, true, { private: true }, { isPrivate: () => true })).toMatchSnapshot()
  })

  it('for a main window put away, with the space on screen locked', () => {
    const f = fixture()
    expect(menuBar(f.state, true, { away: () => {}, lockedSpaces: [f.home] })).toMatchSnapshot()
  })

  it('with every optional setting off and windows that cannot be named', () => {
    expect(menuBar(fixture({}).state, false)).toMatchSnapshot()
  })
})

describe('the context menus of the sidebar, as built', () => {
  it('of a tab: on screen with a child, its child, a pinned one, one of a split view, a selection', () => {
    const f = fixture()
    expect(contextMenu({ kind: 'tab', id: f.a }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'tab', id: f.child }, f.state, { clipboardText: '', headers: false })).toMatchSnapshot()
    expect(contextMenu({ kind: 'tab', id: f.d }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'tab', id: f.b, anchor: { x: 10, y: 20, width: 200, height: 30 } }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'tab', id: f.a, selection: [f.a, f.child] }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'tab', id: 'gone' }, f.state)).toMatchSnapshot()
  })

  it('of a tab in a private window, and with every optional setting off', () => {
    const f = fixture()
    expect(contextMenu({ kind: 'tab', id: f.a }, f.state, undefined, { isPrivate: () => true })).toMatchSnapshot()
    const plain = fixture({})
    expect(contextMenu({ kind: 'tab', id: plain.a }, plain.state)).toMatchSnapshot()
  })

  it('of a favourite, of the history of back and forward, of the hidden extensions, of the readable button', () => {
    const f = fixture()
    expect(contextMenu({ kind: 'favorite', id: f.favorite }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'favorite', id: f.favorite }, f.state, undefined, { isPrivate: () => true })).toMatchSnapshot()
    expect(contextMenu({ kind: 'nav', id: 'back' }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'nav', id: 'forward' }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'extensions', id: 'overflow', hidden: ['ext-a', 'unknown'] }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'readable', id: f.a }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'readable', id: f.a }, f.state, undefined, { isPrivate: () => true })).toMatchSnapshot()
  })

  it('of each kind of download', () => {
    const f = fixture()
    for (const download of DOWNLOADS) expect(contextMenu({ kind: 'download', id: download.id }, f.state)).toMatchSnapshot()
    const plain = fixture({})
    expect(contextMenu({ kind: 'download', id: 'dl-done' }, plain.state)).toMatchSnapshot()
  })

  it('of a pane of a split view', () => {
    const f = fixture()
    expect(contextMenu({ kind: 'split', id: f.b }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'split', id: f.c }, fixture({}).state)).toMatchSnapshot()
  })

  it('of a space: on screen with a theme on the clipboard, from the sidebar itself, another one locked, in a private window', () => {
    const f = fixture()
    expect(contextMenu({ kind: 'space', id: f.home }, f.state, { clipboardText: '#3366ff', headers: true })).toMatchSnapshot()
    expect(contextMenu({ kind: 'space', id: f.home, sidebar: true }, f.state)).toMatchSnapshot()
    setLockService({ isSpaceLocked: (id: string) => id === f.other, lockedSpaces: () => [f.other], isActive: () => true } as never)
    expect(contextMenu({ kind: 'space', id: f.other }, withSettings(f.state, { lockedSpaces: [f.other] }))).toMatchSnapshot()
    setLockService(null)
    expect(contextMenu({ kind: 'space', id: f.home, sidebar: true }, f.state, undefined, { isPrivate: () => true })).toMatchSnapshot()
    expect(contextMenu({ kind: 'space', id: f.home }, f.state, undefined, { isPrivate: () => true })).toMatchSnapshot()
  })

  it('of a folder and of a live folder', () => {
    const f = fixture()
    expect(contextMenu({ kind: 'folder', id: f.folder }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'folder', id: f.live }, f.state)).toMatchSnapshot()
    expect(contextMenu({ kind: 'folder', id: f.live }, f.state, undefined, { isPrivate: () => true })).toMatchSnapshot()
  })
})
