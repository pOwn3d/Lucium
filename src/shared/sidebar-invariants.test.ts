// Property test of the sidebar reducer: random but reproducible sequences (one seed = one sequence) of EVERY action of sidebar.ts,
// and after each action the invariants the rest of the application relies on. A failure names the seed, the step and the action, so that
// it can be replayed with `PROP_SEED=<seed> npx vitest run src/shared/sidebar-invariants.test.ts`.
//
// What is checked after every action:
//  - no dangling reference (a tab in a folder or a space that does not exist, a folder of another space, a split view on a closed tab, a selection
//    that is not a tab of its space, a favourite page of a favourite that is gone, a lock on a space that is gone…), no duplicate id, no loop;
//  - the order the sidebar relies on (the tab tree is contiguous, a split view has 2 to 4 panes and ratios that add up to 1);
//  - nothing grows without bound (archive, sessions, usage, permissions…);
//  - `normalize` leaves the state as it is (idempotent: a state the reducer made is a state a file could hold), and the reducer neither mutates
//    its input nor returns a new object for an action that changed nothing (otherwise the state would be saved and drawn again for nothing).
//
// `GENERATORS` is typed on the Action union: a new action without a generator does not compile.

import { describe, expect, it } from 'vitest'
import { ARCHIVE_LIMIT } from './state-clean'
import { PANEL_SCREENS_MAX } from './panel-scale'
import { isClosedPageUrl } from './closed-history'
import { FOLDER_MAX_DEPTH, folderDepth, type FolderSide } from './folders'
import { LIVE_FOLDERS_MAX } from './live-folders'
import { SESSIONS_MAX, asideOf } from './sessions'
import { SPLIT_MAX_PANES, SPLIT_MIN_RATIO } from './split'
import { STATE_VERSION, type SidebarState, type SplitArrangement } from './model'
import type { JoinZone } from './split-grid'
import { favoriteProfile } from './favorite-scope'
import { knownProfiles } from './profiles'
import { createInitialState, normalize, persistableState, reduce, type Action, type Ctx } from './sidebar'
import { tidyCandidates } from './tab-grouping'

// ---------- a small seeded generator ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const URLS = [
  'https://a.example/',
  'https://b.example/page',
  'https://c.example/?q=1',
  'https://d.example/x/y',
  'http://e.example/',
  'https://www.youtube.com/watch?v=1',
  'file:///tmp/a.html',
  'chrome-extension://' + 'a'.repeat(32) + '/page.html',
  'javascript:alert(1)',
  'not a url',
  ''
]
const FEEDS = ['https://feed.example/rss', 'https://feed.example/atom.xml']
// A dozen and more screens, so that the bound on the remembered ones is reached; the last two are not screens at all.
const SCREENS = [
  ...Array.from({ length: 15 }, (_, i) => ({ key: `Moniteur ${i}|${1000 + i}x800@1`, label: `Moniteur ${i}`, internal: false, width: 1000 + i, height: 800, scaleFactor: 1 })),
  { key: 'built-in|1512x982@2', label: '', internal: true, width: 1512, height: 982, scaleFactor: 2 },
  { key: 'wrong', label: 'x', internal: false, width: 10, height: 10, scaleFactor: 1 },
  { key: 'built-in|0x0@1', label: '', internal: true, width: 0, height: 0, scaleFactor: 1 }
]
const PROFILES = ['default', 'work', 'perso', 'bad id!', '__proto__']
const SETTING_PATCHES: Array<Record<string, unknown>> = [
  { tabTree: true },
  { tabTree: false },
  { liveFolders: true },
  { liveFolders: false },
  { privateTabs: true },
  { privateTabs: false },
  { tabContainers: true },
  { tabContainers: false },
  { bookmarkManager: true },
  { useReadLaterFolders: true },
  { useReadLaterFolders: false },
  { webPanels: true },
  { spaceImages: true },
  { compactMode: true },
  { compactMode: false },
  { sidebarVisible: false },
  { sidebarVisible: true },
  { showToolbar: false },
  { showToolbar: true },
  { reopenHistory: false },
  { reopenHistory: true },
  { autoArchiveHours: 0 },
  { autoArchiveHours: 1 },
  { tidyPinnedTitles: true },
  { sidebarRight: true },
  { independentWindows: true },
  { sidebarWidth: 10_000 },
  { sidebarWidth: 'wide' }
]

/** The optional functions the actions need to do anything, and how often a run has them on. */
const FEATURES: ReadonlyArray<readonly [string, number]> = [
  ['tabTree', 0.7],
  ['liveFolders', 0.5],
  ['tabContainers', 0.5],
  ['bookmarkManager', 0.5],
  ['useReadLaterFolders', 0.5],
  ['webPanels', 0.5],
  ['spaceImages', 0.5],
  ['compactMode', 0.3]
]

class Gen {
  state: SidebarState
  /** The clock of the run, as `play` moves it: the reminders are set relative to it. */
  now = 1_700_000_000_000
  /** Earlier states, for the actions that bring a whole saved state back. */
  readonly history: SidebarState[] = []
  private serial = 0
  constructor(readonly rand: () => number, state: SidebarState) {
    this.state = state
  }
  chance(p: number): boolean {
    return this.rand() < p
  }
  int(max: number): number {
    return Math.floor(this.rand() * max)
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!
  }
  /** A fresh made-up id (never the id of anything in the state, unless a later action creates it). */
  ghost(prefix = 'ghost'): string {
    return `${prefix}-${++this.serial}`
  }
  /** An id from the list, or (one time in eight) one that names nothing. */
  idFrom(ids: readonly string[], prefix = 'ghost'): string {
    return ids.length > 0 && !this.chance(0.12) ? this.pick(ids) : this.ghost(prefix)
  }
  spaceId(): string {
    return this.idFrom(this.state.spaces.map((s) => s.id), 'space')
  }
  tabId(): string {
    return this.idFrom(this.state.tabs.map((t) => t.id), 'tab')
  }
  folderId(): string {
    return this.idFrom(this.state.folders.map((f) => f.id), 'folder')
  }
  favoriteId(): string {
    return this.idFrom(this.state.favorites.map((f) => f.id), 'fav')
  }
  archiveId(): string {
    return this.idFrom(this.state.archive.map((a) => a.id), 'arch')
  }
  splitId(): string {
    return this.idFrom(this.state.splits.map((s) => s.id), 'split')
  }
  sessionId(): string {
    return this.idFrom(this.state.sessions.map((s) => s.id), 'sess')
  }
  workViewId(): string {
    return this.idFrom(this.state.workViews.map((v) => v.id), 'view')
  }
  /** The sites of a work view as the sheet sends them: usually two to four fine addresses, now and then too few, too many or one that is not a page. */
  workViewPanes(): Array<{ url: string; title?: string }> {
    const count = this.pick([2, 2, 3, 4, 1, 5])
    return Array.from({ length: count }, () => ({ url: this.chance(0.9) ? this.goodUrl() : this.pick(['javascript:alert(1)', 'about:blank', 'data:text/html,x']), ...(this.chance(0.5) ? { title: this.text() } : {}) }))
  }
  containerId(): string {
    return this.idFrom(this.state.settings.containers.map((c) => c.id), 'cont')
  }
  /** The id of a tab that answers `wanted`, most of the time, so that the actions that need a particular kind of tab have one to act on. */
  tabWhere(wanted: (tab: SidebarState['tabs'][number]) => boolean): string {
    const found = this.state.tabs.filter(wanted)
    return found.length > 0 && !this.chance(0.25) ? this.pick(found).id : this.tabId()
  }
  tabIds(): string[] {
    return Array.from({ length: this.int(5) }, () => this.tabId())
  }
  url(): string {
    return this.pick(URLS)
  }
  /** A web address that is usually fine. */
  goodUrl(): string {
    return this.chance(0.9) ? this.pick(URLS.slice(0, 6)) : this.url()
  }
  maybeIndex(): number {
    return this.pick([0, 0, 1, 2, 3, 5, 99, -1, Number.MAX_SAFE_INTEGER, 1.5])
  }
  text(): string {
    return this.pick(['', ' ', 'Alpha', 'Beta', 'Gamma ', 'A very long name '.repeat(30), 'x', '📁', 'line\nbreak'])
  }
  theme(): Record<string, unknown> {
    return this.pick([{}, { hue: 300 }, { noise: 0.5 }, { primary: '#ff0000' }, { bogus: 1 }])
  }
}

type Generators = { [K in Action['type']]: (g: Gen) => Extract<Action, { type: K }> }

const GENERATORS: Generators = {
  'space/create': (g) => ({
    type: 'space/create',
    name: g.text(),
    emoji: g.pick(['🏠', '', '💼']),
    hue: g.int(360),
    ...(g.chance(0.5) ? { profileId: g.pick(PROFILES) } : {}),
    ...(g.chance(0.2) ? { profileName: g.pick(['Travail', 'Perso', '', 'Travail']) } : {}),
    ...(g.chance(0.2) ? { theme: g.theme() } : {})
  }),
  'space/select': (g) => ({ type: 'space/select', id: g.spaceId() }),
  'space/delete': (g) => ({ type: 'space/delete', id: g.spaceId() }),
  'space/update': (g) => ({ type: 'space/update', id: g.spaceId(), patch: { ...(g.chance(0.5) ? { name: g.text() } : {}), ...(g.chance(0.3) ? { emoji: g.pick(['🚀', '', ' ']) } : {}), ...(g.chance(0.5) ? { profileId: g.pick(PROFILES) } : {}), ...(g.chance(0.3) ? { theme: g.theme() } : {}), ...(g.chance(0.15) ? { background: g.pick([{ type: 'video' as const, value: 'v.mp4' }, { type: 'video' as const, value: 'w.webm', position: { x: 20, y: 80 } }, { type: 'image' as const, value: 'p.png' }]) } : {}) } }),
  // Mostly a space that has a video behind it (the run starts with one, and `space/update` above now and then gives or takes one); a value out of range or that is not a number is part of the draw.
  'space/background-position': (g) => {
    const withVideo = g.state.spaces.filter((sp) => sp.background?.type === 'video')
    return { type: 'space/background-position', id: withVideo.length > 0 && !g.chance(0.2) ? g.pick(withVideo).id : g.spaceId(), x: g.pick([0, 12, 50, 100, 33.3, 150, -5, Number.NaN]), y: g.pick([0, 40, 50, 77, 100, 250, -1, Number.NaN]) }
  },
  'space/apply-themes': (g) => ({ type: 'space/apply-themes', entries: Array.from({ length: g.int(4) }, () => ({ id: g.spaceId(), theme: g.theme() })) }),
  'space/move': (g) => ({ type: 'space/move', id: g.spaceId(), toIndex: g.maybeIndex() }),
  'space/header': (g) => ({ type: 'space/header', id: g.spaceId(), visible: g.chance(0.5) }),
  'space/image': (g) => ({ type: 'space/image', id: g.spaceId(), image: g.chance(0.4) ? null : g.pick(['0123456789abcdef01234567.png', 'bad.png']) }),
  'space/panel-add': (g) => ({ type: 'space/panel-add', id: g.spaceId(), panelId: g.pick(['p1', 'p2', 'p3', '']), url: g.goodUrl(), ...(g.chance(0.5) ? { title: g.text() } : {}) }),
  'space/panel-remove': (g) => {
    const space = g.state.spaces.find((sp) => (sp.webPanels?.length ?? 0) > 0)
    return { type: 'space/panel-remove', id: space && !g.chance(0.2) ? space.id : g.spaceId(), panelId: space?.webPanels ? g.pick(space.webPanels).id : 'p9' }
  },
  'tab/open': (g) => ({
    type: 'tab/open',
    url: g.goodUrl(),
    ...(g.chance(0.3) ? { spaceId: g.spaceId() } : {}),
    ...(g.chance(0.3) ? { background: g.chance(0.5) } : {}),
    ...(g.chance(0.2) ? { allowExtensionPages: true } : {}),
    ...(g.chance(0.1) ? { private: true } : {}),
    ...(g.chance(0.1) ? { container: g.chance(0.2) ? null : g.containerId() } : {}),
    ...(g.chance(0.4) ? { openerId: g.tabId() } : {}),
    ...(g.chance(0.4) ? { parentId: g.tabId() } : {})
  }),
  'tab/set-container': (g) => ({ type: 'tab/set-container', id: g.tabId(), container: g.chance(0.3) ? null : g.containerId() }),
  'container/create': (g) => ({ type: 'container/create', name: g.pick(['Banque', 'Travail', 'Achats', 'Jeux', '']), ...(g.chance(0.5) ? { color: g.pick(['blue', 'red', 'nope']) } : {}) }),
  'container/update': (g) => ({ type: 'container/update', id: g.containerId(), patch: { ...(g.chance(0.6) ? { name: g.pick([`Nom ${g.int(1000)}`, '']) } : {}), ...(g.chance(0.4) ? { color: g.pick(['green', 'nope']) } : {}) } }),
  'container/delete': (g) => ({ type: 'container/delete', id: g.containerId() }),
  'container/rule': (g) => ({ type: 'container/rule', host: g.pick(['a.example', 'b.example', '']), container: g.chance(0.3) ? null : g.containerId() }),
  'container/permission': (g) => ({ type: 'container/permission', id: g.containerId(), origin: g.pick(['https://a.example', 'https://b.example']), permission: g.pick(['camera', 'geolocation']), decision: g.pick(['allow', 'deny', null]) }),
  'tab/forget-origin': (g) => ({ type: 'tab/forget-origin', id: g.tabId() }),
  // A tab that has an origin when there is one: a tab picked at random almost never has, so the action would only do something by luck of the seeds (and a new
  // action type, which shifts the draws of every run, made it vanish from the run).
  'tab/back-to-origin': (g) => ({ type: 'tab/back-to-origin', id: g.idFrom(g.state.tabs.filter((t) => t.openerId !== undefined).map((t) => t.id), 'tab') }),
  'tab/select': (g) => ({ type: 'tab/select', id: g.tabId() }),
  'tab/close': (g) => ({ type: 'tab/close', id: g.tabId() }),
  'tab/pin': (g) => ({ type: 'tab/pin', id: g.tabId() }),
  'tab/unpin': (g) => ({ type: 'tab/unpin', id: g.tabId() }),
  'tab/move': (g) => ({ type: 'tab/move', id: g.tabId(), toIndex: g.maybeIndex(), pinned: g.chance(0.5), ...(g.chance(0.5) ? { folderId: g.folderId() } : {}), ...(g.chance(0.5) ? { parentId: g.chance(0.2) ? null : g.tabId() } : {}) }),
  'tabs/move': (g) => ({ type: 'tabs/move', ids: g.tabIds(), toIndex: g.maybeIndex(), pinned: g.chance(0.5), ...(g.chance(0.5) ? { folderId: g.folderId() } : {}), ...(g.chance(0.5) ? { parentId: g.chance(0.2) ? null : g.tabId() } : {}) }),
  'tab/tree-collapse': (g) => ({ type: 'tab/tree-collapse', id: g.tabWhere((t) => g.state.tabs.some((c) => c.parentId === t.id)), ...(g.chance(0.6) ? { collapsed: g.chance(0.5) } : {}) }),
  'tab/tree-detach': (g) => ({ type: 'tab/tree-detach', id: g.tabWhere((t) => t.parentId !== undefined) }),
  'compact/toggle': () => ({ type: 'compact/toggle' }),
  'tab/update': (g) => ({ type: 'tab/update', id: g.tabWhere((t) => t.pinned && g.chance(0.5)), patch: { ...(g.chance(0.5) ? { url: g.url() } : {}), ...(g.chance(0.5) ? { title: g.text() } : {}), ...(g.chance(0.3) ? { faviconUrl: g.pick(['https://a.example/i.png', 'file:///x', 'data:image/png;base64,AAAA']) } : {}) } }),
  'tab/rename': (g) => ({ type: 'tab/rename', id: g.tabId(), title: g.text() }),
  'tab/icon': (g) => ({ type: 'tab/icon', id: g.tabId(), icon: g.pick(['🔥', '', 'abc', '👨‍👩‍👧']) }),
  'tab/image': (g) => ({ type: 'tab/image', id: g.tabId(), image: g.pick(['0123456789abcdef01234567.png', null, '../evil.png', '']) }),
  'tab/move-to-space': (g) => ({ type: 'tab/move-to-space', id: g.tabId(), spaceId: g.spaceId() }),
  'tab/duplicate': (g) => ({ type: 'tab/duplicate', id: g.tabId() }),
  'tab/close-others': (g) => ({ type: 'tab/close-others', id: g.tabId() }),
  'tab/archive': (g) => ({ type: 'tab/archive', id: g.tabId() }),
  'tab/remove-pinned': (g) => ({ type: 'tab/remove-pinned', id: g.tabId() }),
  'tab/archive-group': (g) => ({ type: 'tab/archive-group', id: g.tabId(), scope: g.pick(['above', 'below', 'others'] as const) }),
  'tabs/archive-many': (g) => ({ type: 'tabs/archive-many', ids: g.tabIds() }),
  'tabs/keep-dead': (g) => ({ type: 'tabs/keep-dead', ids: g.tabIds() }),
  'tab/separate': (g) => ({ type: 'tab/separate', id: g.tabWhere((t) => t.pinned && t.anchorUrl !== undefined && t.url !== t.anchorUrl) }),
  'tab/back-to-anchor': (g) => ({ type: 'tab/back-to-anchor', id: g.tabWhere((t) => t.pinned && t.anchorUrl !== undefined && t.url !== t.anchorUrl) }),
  'tab/replace-anchor': (g) => ({ type: 'tab/replace-anchor', id: g.tabId() }),
  'tab/keep-awake': (g) => ({ type: 'tab/keep-awake', id: g.tabId(), keep: g.chance(0.5) }),
  'tab/auto-reload': (g) => ({ type: 'tab/auto-reload', id: g.tabId(), seconds: g.pick([null, 5, 60, 1, 1e9, 30]) }),
  'sleep/exclude-site': (g) => ({ type: 'sleep/exclude-site', site: g.pick(['a.example', 'b.example', '']), excluded: g.chance(0.5) }),
  'blocking/exempt-site': (g) => ({ type: 'blocking/exempt-site', site: g.pick(['a.example', 'b.example']), exempt: g.chance(0.5), ...(g.chance(0.5) ? { tabId: g.tabId() } : {}) }),
  'blocking/site-mode': (g) => ({ type: 'blocking/site-mode', site: g.pick(['a.example', 'b.example']), mode: g.pick(['standard', 'strict', null]), ...(g.chance(0.5) ? { tabId: g.tabId() } : {}) }),
  'autoplay/site': (g) => ({ type: 'autoplay/site', site: g.pick(['a.example', 'b.example']), mode: g.pick(['allow', 'block', null] as const), ...(g.chance(0.5) ? { tabId: g.tabId() } : {}) }),
  'readable/site': (g) => ({ type: 'readable/site', site: g.pick(['a.example', 'b.example']), mode: g.pick(['original', 'dark', 'light', null] as const), ...(g.chance(0.5) ? { tabId: g.tabId() } : {}) }),
  'javascript/site': (g) => ({ type: 'javascript/site', site: g.pick(['a.example', 'b.example']), off: g.chance(0.5), ...(g.chance(0.5) ? { tabId: g.tabId() } : {}) }),
  'siteclear/site': (g) => ({ type: 'siteclear/site', site: g.pick(['a.example', 'b.example']), on: g.chance(0.5), ...(g.chance(0.5) ? { tabId: g.tabId() } : {}) }),
  'filterlist/add': (g) => {
    const id = `custom-${g.int(4).toString(16).padStart(8, '0')}`
    return { type: 'filterlist/add', list: { id, title: 'Liste', source: 'paste', sourceName: 'collée', enabled: true, addedAt: 1 } }
  },
  'filterlist/remove': (g) => ({ type: 'filterlist/remove', id: `custom-${g.int(4).toString(16).padStart(8, '0')}` }),
  'filterlist/enable': (g) => ({ type: 'filterlist/enable', id: `custom-${g.int(4).toString(16).padStart(8, '0')}`, enabled: g.chance(0.5) }),
  'profile/used': (g) => ({ type: 'profile/used', id: g.pick(PROFILES) }),
  // Mostly a profile some space really uses, so that the action changes something in the run (a blind pick among five names rarely meets one).
  'profile/revert-missing': (g) => ({ type: 'profile/revert-missing', ids: [g.chance(0.7) ? g.pick(g.state.spaces.map((space) => space.profileId)) : g.pick(PROFILES)] }),
  'developer/site': (g) => ({ type: 'developer/site', site: g.pick(['a.example', 'b.example']), enabled: g.chance(0.5) }),
  'extension/set-enabled': (g) => ({ type: 'extension/set-enabled', profileId: g.pick(PROFILES), extensionId: 'a'.repeat(32), enabled: g.chance(0.5) }),
  'today/clear': (g) => ({ type: 'today/clear', ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'archive/sweep': () => ({ type: 'archive/sweep' }),
  'archive/restore': (g) => ({ type: 'archive/restore', id: g.archiveId() }),
  'archive/restore-last': (g) => ({ type: 'archive/restore-last', ...(g.chance(0.5) ? { count: g.pick([1, 2, 5, 0, -3, 1000]) } : {}) }),
  'archive/clear': () => ({ type: 'archive/clear' }),
  'archive/forget-pages': (g) => ({ type: 'archive/forget-pages', profileId: g.pick(PROFILES), ...(g.chance(0.6) ? { site: { host: g.pick(['a.example', 'b.example', 'c.example', 'bad host!', '']), subdomains: g.chance(0.5) } } : {}) }),
  'archive/add': (g) => ({ type: 'archive/add', url: g.goodUrl(), title: g.text(), ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}), source: g.pick(['auto', 'manual', 'little'] as const) }),
  'readlater/add': (g) => ({ type: 'readlater/add', tabId: g.tabId() }),
  'readlater/open': (g) => ({ type: 'readlater/open', id: g.idFrom(g.state.readLater.map((i) => i.id)) }),
  'readlater/remove': (g) => ({ type: 'readlater/remove', id: g.idFrom(g.state.readLater.map((i) => i.id)) }),
  // Relative to the clock of the run, which moves forward between steps: some reminders come due, and the odd one is already past.
  'reminder/add': (g) => ({ type: 'reminder/add', tabId: g.tabWhere((tab) => tab.private !== true && /^https?:/.test(tab.url)), dueAt: g.chance(0.15) ? g.pick([0, 1, Number.NaN]) : g.now + g.pick([10 ** 5, 10 ** 6, 10 ** 7, 3 * 10 ** 7]) }),
  'reminder/cancel': (g) => ({ type: 'reminder/cancel', id: g.idFrom(g.state.tabReminders.map((r) => r.id)) }),
  'reminder/open': (g) => ({ type: 'reminder/open', id: g.idFrom(g.state.tabReminders.map((r) => r.id)) }),
  'reminder/fire': () => ({ type: 'reminder/fire' }),
  'readlater/clear': () => ({ type: 'readlater/clear' }),
  'readlater-folder/create': (g) => ({ type: 'readlater-folder/create', name: g.text() }),
  'readlater-folder/rename': (g) => ({ type: 'readlater-folder/rename', id: g.idFrom(g.state.readLaterFolders.map((f) => f.id)), name: g.text() }),
  'readlater-folder/delete': (g) => ({ type: 'readlater-folder/delete', id: g.idFrom(g.state.readLaterFolders.map((f) => f.id)) }),
  'readlater-folder/collapse': (g) => ({ type: 'readlater-folder/collapse', id: g.idFrom(g.state.readLaterFolders.map((f) => f.id)), collapsed: g.chance(0.5) }),
  'readlater/move': (g) => ({ type: 'readlater/move', id: g.idFrom(g.state.readLater.map((i) => i.id)), folderId: g.chance(0.3) ? null : g.idFrom(g.state.readLaterFolders.map((f) => f.id)), ...(g.chance(0.5) ? { beforeId: g.chance(0.3) ? null : g.idFrom(g.state.readLater.map((i) => i.id)) } : {}) }),
  'bookmark/add': (g) => ({ type: 'bookmark/add', tabId: g.tabId(), ...(g.chance(0.7) ? { tags: ['a', 'b', 'A'] } : {}) }),
  'bookmark/open': (g) => ({ type: 'bookmark/open', id: g.idFrom(g.state.bookmarks.map((b) => b.id)) }),
  'bookmark/edit': (g) => ({ type: 'bookmark/edit', id: g.idFrom(g.state.bookmarks.map((b) => b.id)), patch: { ...(g.chance(0.5) ? { title: g.text() } : {}), ...(g.chance(0.3) ? { url: g.url() } : {}), ...(g.chance(0.3) ? { tags: ['x', 'y'] } : {}), ...(g.chance(0.3) ? { note: g.text() } : {}) } }),
  'bookmark/remove': (g) => ({ type: 'bookmark/remove', id: g.idFrom(g.state.bookmarks.map((b) => b.id)) }),
  'bookmark/tag-rename': (g) => ({ type: 'bookmark/tag-rename', from: g.pick(['a', 'b', 'i']), to: g.pick(['b', 'z', '']) }),
  'bookmark/tag-delete': (g) => ({ type: 'bookmark/tag-delete', tag: g.pick(['a', 'b', 'x']) }),
  'bookmarks/import': (g) => ({ type: 'bookmarks/import', entries: Array.from({ length: g.int(4) }, () => ({ url: g.url(), title: g.text(), tags: ['i'] })) }),
  'livefolder/create': (g) => ({
    type: 'livefolder/create',
    source: g.chance(0.5) ? { kind: 'feed', url: g.pick(FEEDS) } : { kind: 'github', repo: g.pick(['owner/repo', 'bad repo']), what: 'releases' },
    ...(g.chance(0.5) ? { name: g.text() } : {}),
    ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}),
    ...(g.chance(0.4) ? { parentId: g.folderId() } : {})
  }),
  'livefolder/edit': (g) => ({ type: 'livefolder/edit', id: g.idFrom(g.state.folders.filter((f) => f.live).map((f) => f.id), 'folder'), ...(g.chance(0.5) ? { source: { kind: 'feed' as const, url: g.pick(FEEDS) } } : {}), ...(g.chance(0.5) ? { name: g.text() } : {}) }),
  'livefolder/refresh': (g) => ({ type: 'livefolder/refresh', ...(g.chance(0.6) ? { id: g.idFrom(g.state.folders.filter((f) => f.live).map((f) => f.id), 'folder') } : {}) }),
  'livefolder/result': (g) => {
    const folder = g.state.folders.find((f) => f.live)
    const source = folder?.live?.source ?? { kind: 'feed' as const, url: FEEDS[0]! }
    return g.chance(0.3)
      ? { type: 'livefolder/result', id: folder?.id ?? g.folderId(), source, failure: 'down' }
      : { type: 'livefolder/result', id: folder?.id ?? g.folderId(), source, items: Array.from({ length: g.int(20) }, (_, i) => ({ title: `Item ${i}`, url: `https://feed.example/${i}` })) }
  },
  'folder/create': (g) => ({ type: 'folder/create', name: g.text(), ...(g.chance(0.4) ? { spaceId: g.spaceId() } : {}), ...(g.chance(0.5) ? { parentId: g.folderId() } : {}) }),
  'folder/create-with': (g) => ({ type: 'folder/create-with', tabIds: g.tabIds(), ...(g.chance(0.5) ? { name: g.text() } : {}) }),
  'folder/bottom': (g) => ({ type: 'folder/bottom', id: g.folderId(), bottom: g.chance(0.6) }),
  'folder/no-wake': (g) => ({ type: 'folder/no-wake', id: g.folderId(), on: g.chance(0.5) }),
  // An emoji, nothing, or what a hand-edited message could hold: the reducer must keep the state valid whichever it gets.
  'folder/icon': (g) => ({ type: 'folder/icon', id: g.folderId(), icon: g.pick(['📚', '🏳️‍🌈', null, 'x', '', '📚📚']) }),
  'tabs/tidy': (g) => {
    // What the panel sends: groups of the Today tabs of the space on screen (a name now and then that a folder already has, a tab that cannot move, a name that is no text).
    const pool = tidyCandidates(g.state, g.state.activeSpaceId).map((tab) => tab.id)
    const groups = Array.from({ length: g.int(4) }, () => ({
      name: g.chance(0.3) && g.state.folders.length > 0 ? g.pick(g.state.folders).name : g.text(),
      tabIds: [...Array.from({ length: g.int(4) }, () => (pool.length > 0 && !g.chance(0.1) ? g.pick(pool) : g.tabId()))]
    }))
    return { type: 'tabs/tidy', groups, ...(g.chance(0.2) ? { spaceId: g.spaceId() } : {}), ...(g.chance(0.5) ? { atBottom: g.chance(0.7) } : {}) }
  },
  'tabs/untidy': (g) => {
    // What the notice's "Annuler" sends: tabs that were put in folders, with the place they had, and the folders that were made.
    const filed = g.state.tabs.filter((tab) => tab.pinned && tab.folderId !== undefined)
    return {
      type: 'tabs/untidy',
      tabs: Array.from({ length: g.int(4) }, () => {
        const tab = filed.length > 0 && !g.chance(0.15) ? g.pick(filed) : undefined
        return { id: tab?.id ?? g.tabId(), folderId: tab?.folderId ?? g.folderId(), index: g.pick([0, 0, 1, 2, 5, 99]) }
      }),
      folderIds: g.chance(0.7) ? [g.folderId(), ...(g.chance(0.3) ? [g.folderId()] : [])] : []
    }
  },
  'folder/archive': (g) => ({ type: 'folder/archive', id: g.folderId() }),
  'folder/toggle': (g) => ({ type: 'folder/toggle', id: g.folderId() }),
  'folder/collapse-all': (g) => ({ type: 'folder/collapse-all', ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'tabs/reset-pinned': (g) => ({ type: 'tabs/reset-pinned', ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'folder/delete': (g) => ({ type: 'folder/delete', id: g.folderId() }),
  'folder/duplicate': (g) => ({ type: 'folder/duplicate', id: g.folderId() }),
  'folder/rename': (g) => ({ type: 'folder/rename', id: g.folderId(), name: g.text() }),
  'folder/to-space': (g) => ({ type: 'folder/to-space', id: g.folderId() }),
  'folder/move': (g) => {
    const id = g.folderId()
    // The side, taken from the id rather than drawn: a draw more would shift every sequence of the run (a generator that stops reaching a rare action fails the last check). Now and
    // then it is none, or a word that is none (the renderer is not trusted).
    const side = [undefined, 'top', 'today-start', 'bottom', 'today-start', 'sideways'][id.length % 6] as FolderSide | undefined
    return { type: 'folder/move', id, parentId: g.chance(0.3) ? null : g.folderId(), toIndex: g.maybeIndex(), ...(side !== undefined ? { side } : {}) }
  },
  'split/create': (g) => {
    // Now and then onto a split view, at a side or in a corner (a grid), or at a zone that is not one.
    const host = g.state.splits.length > 0 && g.chance(0.5) ? g.pick(g.state.splits) : undefined
    const withTabId = host ? g.pick(host.tabIds) : g.tabId()
    const zone = g.chance(0.6) ? { zone: g.pick(['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle'] as const) as JoinZone } : {}
    return { type: 'split/create', tabId: g.tabId(), withTabId, ...(g.chance(0.5) ? { orientation: g.pick(['horizontal', 'vertical'] as const) } : {}), ...(g.chance(0.5) ? { focus: g.pick(['first', 'second'] as const) } : {}), ...zone }
  },
  'split/remove': (g) => ({ type: 'split/remove', tabId: g.tabWhere((t) => g.state.splits.some((sp) => sp.tabIds.includes(t.id))) }),
  'split/orientation': (g) => {
    const split = g.state.splits.length > 0 ? g.pick(g.state.splits) : undefined
    return { type: 'split/orientation', id: split ? split.id : g.splitId(), orientation: split?.orientation === 'horizontal' ? 'vertical' : 'horizontal' }
  },
  'split/layout': (g) => {
    const split = g.state.splits.length > 0 ? g.pick(g.state.splits) : undefined
    return { type: 'split/layout', id: split && !g.chance(0.1) ? split.id : g.splitId(), layout: g.pick(['horizontal', 'vertical', 'grid', 'grid', 'diagonal'] as const) as SplitArrangement }
  },
  'split/grid': (g) => {
    const split = g.state.splits.find((sp) => sp.grid !== undefined) ?? g.state.splits[0]
    const share = () => (g.chance(0.15) ? g.pick([0.01, 0.99, Number.NaN]) : 0.12 + g.rand() * 0.76)
    return { type: 'split/grid', id: split && !g.chance(0.1) ? split.id : g.splitId(), column: share(), row: share() }
  },
  'split/move': (g) => ({ type: 'split/move', tabId: g.tabWhere((t) => g.state.splits.some((sp) => sp.tabIds.includes(t.id))), direction: g.pick([-1, 1] as const) }),
  'split/ratios': (g) => {
    const split = g.state.splits[g.int(g.state.splits.length || 1)]
    const n = split ? split.tabIds.length : 2
    const raw = Array.from({ length: n }, () => 0.1 + g.rand())
    return { type: 'split/ratios', id: split && !g.chance(0.1) ? split.id : g.splitId(), ratios: g.chance(0.15) ? [0.01, 0.99] : raw }
  },
  'split/restore': (g) => {
    // What the notice of a closed pane puts back: two tabs of one space that are in no split view (or, one time in seven, ones that are not free or do not exist).
    const free = g.state.tabs.filter((t) => !g.state.splits.some((sp) => sp.tabIds.includes(t.id)))
    const first = free.length > 0 ? g.pick(free) : undefined
    const mate = first ? free.find((t) => t.id !== first.id && t.spaceId === first.spaceId) : undefined
    const tabIds = first && mate && !g.chance(0.15) ? [first.id, mate.id] : [g.tabId(), g.tabId()]
    return { type: 'split/restore', split: { id: g.chance(0.2) ? g.splitId() : g.ghost('split'), spaceId: first?.spaceId ?? g.spaceId(), tabIds, orientation: g.pick(['horizontal', 'vertical'] as const), ratios: g.chance(0.3) ? [0.01, 0.99] : [0.4, 0.6] } }
  },
  'boost/save': (g) => ({ type: 'boost/save', boost: { host: g.pick(['a.example', 'b.example', 'com', '']), ...(g.chance(0.5) ? { id: g.idFrom(g.state.boosts.map((b) => b.id), 'boost') } : {}), css: 'a{}', js: g.pick(['', 'alert(1)']) } }),
  'boost/import': (g) => ({ type: 'boost/import', id: g.ghost('boost'), boost: { name: 'Shared', host: 'a.example', css: 'a{}', js: g.pick(['', '1']), zoom: 1, zap: [], tint: { hue: 0, saturation: 1, brightness: 1, contrast: 1 } } }),
  'boost/delete': (g) => ({ type: 'boost/delete', id: g.idFrom(g.state.boosts.map((b) => b.id), 'boost') }),
  'commandbar/used': (g) => ({ type: 'commandbar/used', key: `url:${g.pick(URLS)}${g.int(400)}` }),
  'commandbar/forget': (g) => {
    // A profile that has a ranking and one of its pages, most of the time: the rest is what a wrong sender would name.
    const profileId = g.idFrom(Object.keys(g.state.commandBarUsage), 'profile')
    const ranked = Object.keys(g.state.commandBarUsage[profileId] ?? {}).map((key) => key.slice('url:'.length))
    return { type: 'commandbar/forget', profileId, urls: g.chance(0.9) ? [g.idFrom(ranked, 'https://never.example/'), g.pick(URLS)] : (7 as unknown as string[]) }
  },
  'commandbar/put-back': (g) => ({ type: 'commandbar/put-back', profileId: g.pick(['default', 'work', 'gone', '__proto__']), url: `${g.pick(URLS)}${g.int(400)}`, count: g.pick([1, 3, 0, -2, 1.5, Number.NaN, 1e12]) }),
  'sidepanel/behavior': (g) => ({ type: 'sidepanel/behavior', extensionId: g.pick(['ext1', 'ext2']), openOnActionClick: g.chance(0.5) }),
  'permission/visit': (g) => ({ type: 'permission/visit', origin: `https://o${g.int(30)}.example`, day: g.int(30_000) }),
  'permission/sweep': (g) => ({ type: 'permission/sweep', day: g.int(30_000) }),
  'permission/set': (g) => ({ type: 'permission/set', origin: `https://o${g.int(30)}.example`, permission: g.pick(['camera', 'geolocation', 'notifications']), decision: g.pick(['allow', 'deny', null] as const) }),
  'favorite/add': (g) => ({ type: 'favorite/add', url: g.goodUrl(), title: g.text(), ...(g.chance(0.3) ? { faviconUrl: 'https://a.example/i.png' } : {}), ...(g.chance(0.5) ? { toIndex: g.maybeIndex() } : {}), ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'favorite/place': (g) => ({ type: 'favorite/place', id: g.favoriteId(), toIndex: g.maybeIndex() }),
  'favorite/remove': (g) => ({ type: 'favorite/remove', id: g.favoriteId() }),
  'favorite/open': (g) => ({ type: 'favorite/open', id: g.favoriteId(), ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'favorite/move': (g) => ({ type: 'favorite/move', id: g.favoriteId(), direction: g.pick([-1, 1] as const) }),
  'favorite/edit': (g) => ({ type: 'favorite/edit', id: g.favoriteId(), patch: { ...(g.chance(0.5) ? { title: g.text() } : {}), ...(g.chance(0.5) ? { url: g.url() } : {}) } }),
  'settings/update': (g) => ({ type: 'settings/update', patch: g.pick(SETTING_PATCHES) as never }),
  'panel-size/set': (g) => ({ type: 'panel-size/set', screen: g.pick(SCREENS), percent: g.pick([null, 80, 100, 125, 160, 400, -5, 112.4]) }),
  'panel-size/noticed': (g) => ({ type: 'panel-size/noticed', screen: g.pick(SCREENS) }),
  'import/merge': (g) => {
    // What an importer hands over: some ids new, some already in the state, some tabs and folders that point at nothing.
    const spaceIds = [...g.state.spaces.map((s) => s.id), g.ghost('imp-space'), g.ghost('imp-space')]
    const folderIds = [...g.state.folders.map((f) => f.id), g.ghost('imp-folder'), g.ghost('imp-folder')]
    const now = 1
    return {
      type: 'import/merge',
      spaces: Array.from({ length: g.int(3) }, () => ({ id: g.chance(0.3) ? g.spaceId() : g.ghost('imp-space'), name: g.text(), emoji: '📥', theme: normalize(createInitialState({ now, newId: () => 'x' })).spaces[0]!.theme, profileId: g.pick(PROFILES) })),
      tabs: Array.from({ length: g.int(5) }, () => ({ id: g.chance(0.3) ? g.tabId() : g.ghost('imp-tab'), spaceId: g.pick(spaceIds), url: g.goodUrl(), title: 'Imported', pinned: g.chance(0.6), ...(g.chance(0.5) ? { folderId: g.pick(folderIds) } : {}), ...(g.chance(0.2) ? { parentId: g.tabId() } : {}), createdAt: now, lastActiveAt: now })),
      folders: Array.from({ length: g.int(4) }, () => ({ id: g.chance(0.3) ? g.folderId() : g.ghost('imp-folder'), spaceId: g.pick(spaceIds), name: g.text(), collapsed: g.chance(0.3), ...(g.chance(0.5) ? { parentId: g.pick(folderIds) } : {}), ...(g.chance(0.3) ? { atBottom: true as const } : {}) })).map((folder, i) => (i % 2 === 1 ? { ...folder, atTodayStart: true as const } : folder)),
      favorites: Array.from({ length: g.int(3) }, () => ({ id: g.chance(0.2) ? g.favoriteId() : g.ghost('imp-fav'), url: g.goodUrl(), title: 'Fav', ...(g.chance(0.5) ? { profileId: g.pick(PROFILES) } : {}) })),
      splits: g.chance(0.3) ? [{ id: g.ghost('imp-split'), spaceId: g.pick(spaceIds), tabIds: g.tabIds(), orientation: 'horizontal' as const, ratios: [0.5, 0.5] }] : []
    }
  },
  'import/revert': (g) => ({
    type: 'import/revert',
    spaces: g.chance(0.3) ? [g.spaceId()] : [],
    tabs: g.tabIds(),
    folders: g.chance(0.5) ? [g.folderId()] : [],
    favorites: g.chance(0.5) ? [g.favoriteId()] : [],
    splits: g.chance(0.3) ? [g.splitId()] : [],
    boosts: []
  }),
  'state/restore': (g) => ({ type: 'state/restore', state: g.history.length > 0 && !g.chance(0.2) ? g.pick(g.history) : g.state }),
  'session/save': (g) => ({ type: 'session/save', ...(g.chance(0.5) ? { name: g.text() } : {}), ...(g.chance(0.3) ? { tabIds: g.tabIds() } : {}) }),
  'session/restore': (g) => ({ type: 'session/restore', id: g.sessionId(), ...(g.chance(0.4) ? { target: 'new-space' as const } : {}) }),
  'session/rename': (g) => ({ type: 'session/rename', id: g.sessionId(), name: g.text() }),
  'session/delete': (g) => ({ type: 'session/delete', id: g.sessionId() }),
  'space/aside': (g) => ({ type: 'space/aside', id: g.spaceId() }),
  'space/reopen': (g) => ({ type: 'space/reopen', id: g.sessionId() }),
  // A space of the state itself, as a transfer file would hold it: its ids are taken, so the import has to make them anew.
  'space/import': (g) => ({ type: 'space/import', aside: asideOf(g.state, g.spaceId()) ?? { space: g.state.spaces[0]!, index: 0, folders: [], tabs: [], splits: [], selected: null, archive: [] } }),
  'backup/restore': (g) => {
    const from = g.history.length > 0 && !g.chance(0.2) ? g.pick(g.history) : g.state
    const { spaces, tabs, folders, activeSpaceId, activeTabBySpace, splits, archive } = from
    return { type: 'backup/restore', copy: { spaces, tabs, folders, activeSpaceId, activeTabBySpace, splits, archive } }
  },
  'view/save': (g) => ({ type: 'view/save', splitId: g.splitId(), ...(g.chance(0.7) ? { name: g.text() } : {}), ...(g.chance(0.5) ? { emoji: g.pick(['☀️', '', 'pas un emoji']) } : {}) }),
  'view/create': (g) => ({
    type: 'view/create',
    view: { name: g.text(), panes: g.workViewPanes(), ...(g.chance(0.3) ? { orientation: 'vertical' as const } : {}), ...(g.chance(0.3) ? { target: g.pick([{ kind: 'window' as const }, { kind: 'new-space' as const }, { kind: 'space' as const, spaceId: g.spaceId() }]) } : {}) },
    ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {})
  }),
  'view/edit': (g) => ({
    type: 'view/edit',
    id: g.workViewId(),
    patch: {
      ...(g.chance(0.5) ? { name: g.text() } : {}),
      ...(g.chance(0.3) ? { panes: g.workViewPanes() } : {}),
      ...(g.chance(0.3) ? { ratios: g.pick([[0.6, 0.4], [0.01, 0.99], [0.25, 0.25, 0.5]]) } : {}),
      ...(g.chance(0.2) ? { grid: g.pick([null, { column: 0.3, row: 0.7 }]) } : {}),
      ...(g.chance(0.3) ? { target: g.pick([null, { kind: 'window' as const }, { kind: 'new-space' as const }, { kind: 'space' as const, spaceId: g.spaceId() }]) } : {})
    }
  }),
  'view/open': (g) => ({ type: 'view/open', id: g.workViewId(), ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'view/capture': (g) => ({ type: 'view/capture', id: g.workViewId(), ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'view/reset': (g) => ({ type: 'view/reset', id: g.workViewId(), ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}) }),
  'view/move': (g) => ({ type: 'view/move', id: g.workViewId(), direction: g.pick([-1, 1] as const) }),
  'view/remove': (g) => ({ type: 'view/remove', id: g.workViewId() }),
  'sync/apply': (g) => {
    // What a session works out: entities that arrive (some with fields that are not fine), fields that change or go, entities that are removed (some that changed since the
    // freeze, so that their `expect` is stale), lists in a new order (with ids that name nothing), and settings (some outside the closed list).
    const kinds = ['space', 'folder', 'tab', 'favorite', 'archived'] as const
    const upserts = Array.from({ length: g.int(5) }, () => {
      const kind = g.pick(kinds)
      const existing = { space: g.spaceId(), folder: g.folderId(), tab: g.tabId(), favorite: g.favoriteId(), archived: g.archiveId() }[kind]
      return {
        kind,
        id: g.chance(0.5) ? existing : g.ghost('sync'),
        create: g.chance(0.6),
        fields: { ...(g.chance(0.5) ? { name: g.text() } : {}), ...(g.chance(0.6) ? { url: g.url() } : {}), ...(g.chance(0.4) ? { title: g.text() } : {}), ...(g.chance(0.5) ? { spaceId: g.spaceId() } : {}), ...(g.chance(0.3) ? { folderId: g.folderId() } : {}), ...(g.chance(0.4) ? { pinned: true } : {}), ...(g.chance(0.2) ? { theme: g.theme() } : {}), ...(g.chance(0.1) ? { ['__proto__']: { polluted: true } } : {}) },
        remove: g.chance(0.3) ? [g.pick(['anchorUrl', 'icon', 'customTitle', 'hideHeader'])] : [],
        expect: g.chance(0.5) ? {} : { name: g.text() }
      }
    })
    const removals = Array.from({ length: g.int(3) }, () => ({ kind: g.pick(kinds), id: g.chance(0.5) ? g.tabId() : g.spaceId(), expect: g.chance(0.5) ? {} : { name: g.text() } }))
    const spaceIds = g.state.spaces.map((s) => s.id)
    const order: Record<string, string[]> = {}
    if (g.chance(0.5)) order['spaces'] = [...spaceIds, g.ghost('space')].reverse()
    if (g.chance(0.5)) order[`tabs:${g.spaceId()}:-`] = [g.tabId(), g.tabId(), g.ghost('tab')]
    if (g.chance(0.3)) order[`folders:${g.spaceId()}:-`] = [g.folderId(), g.folderId()]
    if (g.chance(0.3)) order[`favorites:${g.pick(PROFILES)}`] = [g.favoriteId(), g.favoriteId()]
    if (g.chance(0.2)) order['nonsense'] = [g.tabId()]
    const settings: Record<string, unknown> = {}
    if (g.chance(0.4)) settings['httpsUpgrade'] = g.pick([true, false, 'yes', 3])
    if (g.chance(0.3)) settings['autoArchiveHours'] = g.pick([0, 12, -3, Number.NaN, 'x'])
    if (g.chance(0.3)) settings['profileNames'] = g.pick([{}, { work: 'Travail' }, { work: 3 }, 'x'])
    if (g.chance(0.2)) settings['lockEnabled'] = g.pick([true, false])
    if (g.chance(0.2)) settings['proxyEnabled'] = true
    return { type: 'sync/apply', patch: { upserts, removals, order, settings } }
  },
  'view/restore': (g) => {
    // A view removed earlier in the run, as the notice kept it, or one made up.
    const gone = g.history.flatMap((earlier) => earlier.workViews).filter((view) => !g.state.workViews.some((each) => each.id === view.id))
    const view = gone.length > 0 && !g.chance(0.2) ? g.pick(gone) : { id: g.ghost('view'), name: g.text(), emoji: '☀️', profileId: g.pick(PROFILES), panes: [{ url: g.goodUrl(), title: 'A' }, { url: g.goodUrl(), title: 'B' }], orientation: 'horizontal' as const, ratios: [0.5, 0.5] }
    return { type: 'view/restore', view, index: g.maybeIndex(), splitIds: g.chance(0.5) ? [g.splitId()] : [] }
  },
  'favicon/fill': (g) => ({ type: 'favicon/fill', entries: Array.from({ length: g.int(3) }, () => ({ kind: g.pick(['favorite', 'tab'] as const), id: g.pick([g.tabId(), g.favoriteId()]), origin: 'https://a.example', faviconUrl: 'https://a.example/i.png' })) }),
  'extension/set-tab-capture': (g) => ({ type: 'extension/set-tab-capture', profileId: g.pick(PROFILES), extensionId: 'a'.repeat(32), allowed: g.chance(0.5) })
}

const ACTION_TYPES = Object.keys(GENERATORS) as Array<Action['type']>

// ---------- the invariants ----------

/** JSON with sorted keys and without undefined fields: two states that hold the same things give the same text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v))
}

const dup = (ids: readonly string[]): string | undefined => ids.find((id, i) => ids.indexOf(id) !== i)

export function violations(state: SidebarState): string[] {
  const out: string[] = []
  const bad = (message: string) => out.push(message)
  if (state.version !== STATE_VERSION) bad('version')
  const spaceIds = new Set(state.spaces.map((s) => s.id))
  if (state.spaces.length === 0) bad('no space left')
  const d1 = dup(state.spaces.map((s) => s.id))
  if (d1) bad(`duplicate space ${d1}`)
  if (!spaceIds.has(state.activeSpaceId)) bad(`activeSpaceId ${state.activeSpaceId} is not a space`)

  const tabById = new Map(state.tabs.map((t) => [t.id, t]))
  const d2 = dup(state.tabs.map((t) => t.id))
  if (d2) bad(`duplicate tab ${d2}`)
  const folderById = new Map(state.folders.map((f) => [f.id, f]))
  const d3 = dup(state.folders.map((f) => f.id))
  if (d3) bad(`duplicate folder ${d3}`)

  // selection
  for (const [spaceId, id] of Object.entries(state.activeTabBySpace)) {
    if (!spaceIds.has(spaceId)) bad(`activeTabBySpace keeps the deleted space ${spaceId}`)
    else if (id !== null && tabById.get(id)?.spaceId !== spaceId) bad(`space ${spaceId} shows ${id}, which is not one of its tabs`)
  }
  for (const id of spaceIds) if (!(id in state.activeTabBySpace)) bad(`space ${id} has no selection entry`)

  // tabs
  for (const tab of state.tabs) {
    if (!spaceIds.has(tab.spaceId)) bad(`tab ${tab.id} is in the missing space ${tab.spaceId}`)
    if (tab.folderId !== undefined) {
      const folder = folderById.get(tab.folderId)
      if (!folder) bad(`tab ${tab.id} is in the missing folder ${tab.folderId}`)
      else if (folder.spaceId !== tab.spaceId) bad(`tab ${tab.id} is in folder ${folder.id} of another space`)
      if (!tab.pinned) bad(`unpinned tab ${tab.id} sits in a folder`)
    }
    if (!tab.pinned && tab.anchorUrl !== undefined) bad(`unpinned tab ${tab.id} has an anchor`)
    if (tab.pinned && tab.private === true) bad(`private tab ${tab.id} is pinned`)
    if (tab.openerId !== undefined && (!tabById.has(tab.openerId) || tab.openerId === tab.id || tab.pinned)) bad(`tab ${tab.id} has a wrong opener ${tab.openerId}`)
    if (tab.favoriteId !== undefined) {
      const favorite = state.favorites.find((f) => f.id === tab.favoriteId)
      if (!favorite) bad(`tab ${tab.id} is the page of the missing favourite ${tab.favoriteId}`)
      else if (favoriteProfile(favorite) !== state.spaces.find((s) => s.id === tab.spaceId)?.profileId) bad(`tab ${tab.id} is the page of a favourite of another profile`)
      if (tab.pinned) bad(`tab ${tab.id} is pinned and a favourite page`)
    }
    if (tab.container !== undefined && !state.settings.containers.some((c) => c.id === tab.container)) bad(`tab ${tab.id} is in the missing container ${tab.container}`)
    if (tab.container !== undefined && tab.private === true) bad(`private tab ${tab.id} is in a container`)
    if (tab.parentId !== undefined) {
      const parent = tabById.get(tab.parentId)
      if (!state.settings.tabTree) bad(`tab ${tab.id} has a parent while the tab tree is off`)
      else if (!parent || parent.spaceId !== tab.spaceId || parent.pinned || tab.pinned || parent.id === tab.id) bad(`tab ${tab.id} hangs under ${tab.parentId}, which cannot be its parent`)
    }
    if (tab.treeCollapsed !== undefined && !state.tabs.some((t) => t.parentId === tab.id)) bad(`tab ${tab.id} is folded and has no child`)
    if (tab.windowKey !== undefined) bad(`tab ${tab.id} has a window key (only the main process gives one)`)
  }
  // tree order: the branch of a tab is contiguous among the Today tabs of its space, and no loop
  for (const spaceId of spaceIds) {
    const today = state.tabs.filter((t) => t.spaceId === spaceId && !t.pinned)
    const index = new Map(today.map((t, i) => [t.id, i]))
    for (const tab of today) {
      if (tab.parentId === undefined) continue
      const at = index.get(tab.id)!
      const from = index.get(tab.parentId)
      if (from === undefined || from >= at) {
        bad(`tab ${tab.id} comes before its parent ${tab.parentId}`)
        continue
      }
      for (let i = from + 1; i < at; i++) {
        let up: string | undefined = today[i]!.parentId
        let hops = 0
        while (up !== undefined && up !== tab.parentId && hops++ <= today.length) up = tabById.get(up)?.parentId
        if (up !== tab.parentId) {
          bad(`the branch of ${tab.parentId} is not contiguous (${today[i]!.id} is inside it)`)
          break
        }
      }
    }
  }

  // folders
  for (const folder of state.folders) {
    if (!spaceIds.has(folder.spaceId)) bad(`folder ${folder.id} is in the missing space ${folder.spaceId}`)
    if (folder.parentId !== undefined) {
      const parent = folderById.get(folder.parentId)
      if (!parent) bad(`folder ${folder.id} sits in the missing folder ${folder.parentId}`)
      else if (parent.spaceId !== folder.spaceId) bad(`folder ${folder.id} sits in a folder of another space`)
    }
    // Only a root folder has a side of the list, its mark is a `true` or nothing, and it is one mark: never the bottom and the start of Today together.
    if (folder.atBottom !== undefined && (folder.atBottom !== true || folder.parentId !== undefined)) bad(`folder ${folder.id} has a side (${String(folder.atBottom)}) it cannot have`)
    if (folder.atTodayStart !== undefined && (folder.atTodayStart !== true || folder.parentId !== undefined)) bad(`folder ${folder.id} has a side (${String(folder.atTodayStart)}) it cannot have`)
    if (folder.atBottom !== undefined && folder.atTodayStart !== undefined) bad(`folder ${folder.id} has two sides`)
    const depth = folderDepth(state.folders, folder.id)
    if (depth > FOLDER_MAX_DEPTH) bad(`folder ${folder.id} is ${depth} levels deep`)
    // a loop: walking up never ends without the guard
    const seen = new Set<string>()
    for (let up: string | undefined = folder.id; up !== undefined; up = folderById.get(up)?.parentId) {
      if (seen.has(up)) {
        bad(`folder loop through ${up}`)
        break
      }
      seen.add(up)
    }
  }
  if (state.folders.filter((f) => f.live !== undefined).length > LIVE_FOLDERS_MAX) bad('more live folders than the limit')

  // splits
  const inSplit = new Set<string>()
  const d4 = dup(state.splits.map((s) => s.id))
  if (d4) bad(`duplicate split ${d4}`)
  for (const split of state.splits) {
    if (split.tabIds.length < 2 || split.tabIds.length > SPLIT_MAX_PANES) bad(`split ${split.id} has ${split.tabIds.length} panes`)
    if (split.ratios.length !== split.tabIds.length) bad(`split ${split.id} has ${split.ratios.length} ratios for ${split.tabIds.length} panes`)
    if (Math.abs(split.ratios.reduce((a, b) => a + b, 0) - 1) > 1e-6 || split.ratios.some((r) => !(r >= SPLIT_MIN_RATIO - 1e-6))) bad(`split ${split.id} has ratios ${split.ratios.join(',')}`)
    if (!spaceIds.has(split.spaceId)) bad(`split ${split.id} is in the missing space`)
    // A grid has three or four panes, a side for one of them exactly when there are three, and shares that leave each column and row its minimum.
    const grid = split.grid
    if (grid) {
      if (split.tabIds.length !== 3 && split.tabIds.length !== 4) bad(`split ${split.id} is a grid of ${split.tabIds.length} panes`)
      if ((grid.span !== undefined) !== (split.tabIds.length === 3)) bad(`split ${split.id} is a grid of ${split.tabIds.length} panes with the side ${String(grid.span)}`)
      if ([grid.column, grid.row].some((share) => !(share >= SPLIT_MIN_RATIO - 1e-6 && share <= 1 - SPLIT_MIN_RATIO + 1e-6))) bad(`split ${split.id} has the grid shares ${grid.column}, ${grid.row}`)
    }
    for (const id of split.tabIds) {
      const tab = tabById.get(id)
      if (!tab) bad(`split ${split.id} holds the closed tab ${id}`)
      else if (tab.spaceId !== split.spaceId) bad(`split ${split.id} holds ${id} of another space`)
      if (inSplit.has(id)) bad(`tab ${id} is in two split views`)
      inSplit.add(id)
    }
  }

  // favourites: each has a profile; it is one a space can show (or one the user named); no address twice in a profile
  const d5 = dup(state.favorites.map((f) => f.id))
  if (d5) bad(`duplicate favourite ${d5}`)
  const profiles = new Set(knownProfiles(state))
  const seenFavorites = new Set<string>()
  for (const favorite of state.favorites) {
    if (favorite.profileId === undefined) bad(`favourite ${favorite.id} has no profile`)
    else if (!profiles.has(favorite.profileId)) bad(`favourite ${favorite.id} belongs to the unknown profile ${favorite.profileId}`)
    const key = `${favoriteProfile(favorite)} ${favorite.url}`
    if (seenFavorites.has(key)) bad(`the profile ${favoriteProfile(favorite)} has ${favorite.url} twice as a favourite`)
    seenFavorites.add(key)
  }

  // work views: each of a profile that exists, 2 to 4 sites, shares in bounds; a split view marked by a view of its space's profile, once per space
  const d8 = dup(state.workViews.map((v) => v.id))
  if (d8) bad(`duplicate work view ${d8}`)
  if (state.workViews.length > 50) bad(`${state.workViews.length} work views`)
  for (const view of state.workViews) {
    if (!profiles.has(view.profileId)) bad(`work view ${view.id} belongs to the unknown profile ${view.profileId}`)
    if (view.panes.length < 2 || view.panes.length > SPLIT_MAX_PANES) bad(`work view ${view.id} has ${view.panes.length} sites`)
    if (view.ratios.length !== view.panes.length || view.ratios.some((r) => r < SPLIT_MIN_RATIO - 1e-6)) bad(`work view ${view.id} has the shares ${view.ratios.join()}`)
    if (view.target?.kind === 'space') {
      const spaceId = view.target.spaceId
      if (!state.spaces.some((space) => space.id === spaceId && space.profileId === view.profileId)) bad(`work view ${view.id} opens in the space ${spaceId}, gone or of another profile`)
    }
  }
  const marks = new Set<string>()
  for (const split of state.splits) {
    if (split.viewId === undefined) continue
    const view = state.workViews.find((each) => each.id === split.viewId)
    const space = state.spaces.find((each) => each.id === split.spaceId)
    if (!view || view.profileId !== space?.profileId) bad(`split ${split.id} is marked by the work view ${split.viewId}, gone or of another profile`)
    if (marks.has(`${split.spaceId} ${split.viewId}`)) bad(`two split views of ${split.spaceId} are marked by the work view ${split.viewId}`)
    marks.add(`${split.spaceId} ${split.viewId}`)
  }

  // archive
  const d6 = dup(state.archive.map((a) => a.id))
  if (d6) bad(`duplicate archive entry ${d6}`)
  if (state.archive.length > ARCHIVE_LIMIT) bad(`archive holds ${state.archive.length} entries`)
  for (const entry of state.archive) {
    if (!spaceIds.has(entry.spaceId)) bad(`archive entry ${entry.id} is of the missing space ${entry.spaceId}`)
  }

  // the rest of what points at a space
  for (const id of state.settings.lockedSpaces) if (!spaceIds.has(id)) bad(`locked space ${id} is gone`)
  // A link rule to a space that is gone, and a space put aside that a restored copy also holds, are by design (routing.ts, sessions.ts `reopenAside`): not checked.
  for (const folder of state.readLater.flatMap((i) => (i.folderId !== undefined ? [i.folderId] : []))) if (!state.readLaterFolders.some((f) => f.id === folder)) bad(`a saved page is in the missing folder ${folder}`)
  const d7 = dup(state.sessions.map((s) => s.id))
  if (d7) bad(`duplicate session ${d7}`)

  // bounds
  if (state.sessions.length > SESSIONS_MAX) bad(`${state.sessions.length} sessions`)
  if (Object.values(state.commandBarUsage).some((usage) => Object.keys(usage).length > 300)) bad('command bar usage grew past its bound')
  if (Object.keys(state.sitePermissions).length > 2000) bad('site permissions grew past their bound')
  if (Object.keys(state.siteVisits).length > 2000) bad('site visits grew past their bound')
  if (Object.keys(state.siteVisits).some((origin) => !Object.hasOwn(state.sitePermissions, origin))) bad('a visit is written for a site that holds no answer')
  if (state.readLater.length > 500) bad('read-later list grew past its bound')
  if (state.bookmarks.length > 5000) bad('bookmarks grew past their bound')
  if (Object.keys(state.settings.panelSizes).length > PANEL_SCREENS_MAX) bad('the remembered screens grew past their bound')
  return out
}

// ---------- the runs ----------

function context(): Ctx & { now: number } {
  let n = 0
  const ctx = { now: 1_700_000_000_000, newId: () => `id${++n}` }
  return ctx
}

interface Failure {
  seed: number
  step: number
  action: Action
  problems: string[]
}

/**
 * Plays one sequence and returns the first failure (or null). With `survey`, it goes on after a failure (from the repaired state) and
 * hands every failure to the callback, which is how the kinds of failure of a run are counted.
 */
export function play(seed: number, steps: number, survey?: (failure: Failure) => void, observe?: (action: Action, before: SidebarState, after: SidebarState) => void): Failure | null {
  const rand = mulberry32(seed)
  const ctx = context()
  const gen = new Gen(rand, createInitialState(ctx))
  // A tab that is archived brings the pages it went through (the setting `reopenHistory` is on in the shell): the lists the state holds are real ones.
  ctx.closedHistory = (tabId) => {
    const url = gen.state.tabs.find((tab) => tab.id === tabId)?.url
    return url !== undefined && isClosedPageUrl(url) ? { entries: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/page', title: '' }, { url, title: 'T' }], index: 2 } : undefined
  }
  const types = ACTION_TYPES
  // Start from a small populated state, so that the first actions have something to act on, with a random choice of the optional functions on.
  const patch = Object.fromEntries(FEATURES.filter(([, odds]) => gen.chance(odds)).map(([key]) => [key, true]))
  gen.state = reduce(gen.state, { type: 'settings/update', patch }, ctx)
  gen.state = [0, 1, 2, 3, 4, 5].reduce<SidebarState>((s, i) => reduce(s, { type: 'tab/open', url: URLS[i]!, background: true }, ctx), gen.state)
  // One space has a video behind it from the start, so that the framing of a video has one to act on.
  const firstSpace = gen.state.spaces[0]
  if (firstSpace) gen.state = reduce(gen.state, { type: 'space/update', id: firstSpace.id, patch: { background: { type: 'video', value: 'v.mp4' } } }, ctx)
  // What the state already violates (reported where it appeared, not again at every step after it) and its text, both carried from step to step.
  let known = violations(gen.state)
  if (known.length > 0) return { seed, step: -1, action: { type: 'archive/sweep' }, problems: known }
  let beforeText = canonical(gen.state)
  for (let step = 0; step < steps; step++) {
    ctx.now += gen.int(3 * 3_600_000)
    gen.now = ctx.now
    // Mostly the actions of everyday use, now and then any other.
    const type = gen.chance(0.7) ? gen.pick(EVERYDAY) : gen.pick(types)
    const action = GENERATORS[type](gen) as Action
    const before = gen.state
    let after: SidebarState
    try {
      after = reduce(before, action, ctx)
    } catch (error) {
      return { seed, step, action, problems: [`the reducer threw: ${error instanceof Error ? error.stack : String(error)}`] }
    }
    const afterViolations = violations(after)
    const problems = afterViolations.filter((p) => !known.includes(p))
    const afterText = after === before ? beforeText : canonical(after)
    if (after === before ? false : canonical(before) !== beforeText) problems.push('the reducer changed its input')
    if (after !== before && afterText === beforeText) problems.push('the action changed nothing but returned a new state object')
    // A state the reducer made is a state a file could hold: normalising it changes nothing (and so is idempotent on it).
    const repaired = normalize(after)
    const fixed = canonical(repaired)
    if (fixed !== afterText) problems.push(`normalize changes the state the reducer made: ${firstDifference(afterText, fixed)}`)
    if (persistableState(after).tabs.some((t) => t.private === true)) problems.push('persistableState keeps a private tab')
    if (problems.length > 0) {
      if (!survey) return { seed, step, action, problems }
      survey({ seed, step, action, problems })
      gen.state = repaired
      known = violations(repaired)
      beforeText = fixed
      continue
    }
    observe?.(action, before, after)
    gen.state = after
    known = afterViolations
    beforeText = afterText
    if (step % 7 === 0) {
      gen.history.push(after)
      if (gen.history.length > 6) gen.history.shift()
    }
  }
  return null
}

function firstDifference(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return `…${a.slice(Math.max(0, i - 60), i + 80)}  ≠  …${b.slice(Math.max(0, i - 60), i + 80)}`
}

/** The actions of everyday use, played more often than the rest. */
const EVERYDAY: Array<Action['type']> = [
  'tab/open', 'tab/open', 'tab/open', 'tab/open', 'tab/open', 'tab/open', 'tab/update', 'tab/update', 'tab/move', 'tabs/move', 'folder/create', 'tab/pin', 'tab/pin', 'tab/select', 'tab/close', 'tab/pin', 'tab/unpin', 'tab/move', 'tabs/move', 'tab/archive', 'tab/duplicate', 'tab/move-to-space', 'tab/rename',
  'folder/create', 'folder/create-with', 'folder/move', 'folder/delete', 'folder/duplicate', 'folder/to-space', 'folder/toggle', 'folder/bottom', 'folder/bottom', 'tabs/tidy', 'tabs/tidy', 'tabs/tidy', 'tabs/untidy', 'tabs/untidy',
  'space/create', 'space/select', 'space/update', 'space/move',
  'reminder/add', 'reminder/fire', 'reminder/open',
  'favorite/add', 'favorite/open', 'favorite/remove', 'favorite/place', 'favorite/move',
  'split/create', 'split/create', 'split/create', 'split/remove', 'split/move', 'split/ratios', 'split/orientation', 'split/orientation', 'split/restore', 'split/layout', 'split/layout', 'split/grid', 'split/grid',
  'archive/restore', 'archive/restore-last', 'archive/sweep', 'tab/tree-collapse', 'tab/tree-detach', 'settings/update', 'tab/back-to-origin', 'import/merge', 'import/revert',
  'container/create', 'container/update', 'container/rule', 'container/permission', 'container/delete', 'tab/set-container', 'space/panel-add', 'space/panel-remove', 'bookmark/add', 'bookmark/tag-rename', 'bookmark/tag-delete', 'bookmark/edit', 'readlater/add', 'readlater/move', 'readlater-folder/create', 'readlater-folder/collapse', 'tabs/reset-pinned', 'tab/back-to-anchor', 'tab/separate', 'tab/replace-anchor', 'livefolder/result', 'livefolder/refresh', 'livefolder/edit', 'livefolder/edit', 'livefolder/create', 'filterlist/add', 'filterlist/enable', 'filterlist/remove', 'favicon/fill', 'tab/forget-origin',
  'session/save', 'session/restore', 'space/reopen', 'livefolder/create',
  'view/save', 'view/save', 'view/open', 'view/open', 'view/edit', 'view/capture', 'view/capture', 'view/reset', 'view/move', 'view/remove', 'view/restore', 'view/create',
  'sync/apply', 'sync/apply', 'sync/apply'
]

function report(failure: Failure): string {
  return `seed ${failure.seed}, step ${failure.step}, action ${JSON.stringify(failure.action).slice(0, 400)}\n  - ${failure.problems.join('\n  - ')}`
}

// The shared sources are also type-checked for the interface, which has no Node types: the environment is read through the global.
const env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const SEED = env['PROP_SEED'] !== undefined ? Number(env['PROP_SEED']) : undefined
const SEEDS = Number(env['PROP_SEEDS'] ?? 60)
const STEPS = Number(env['PROP_STEPS'] ?? 250)

describe('the sidebar reducer, on random sequences of every action', () => {
  it('has a generator for every action of the reducer (the table is typed on the Action union)', () => {
    expect(ACTION_TYPES.length).toBeGreaterThan(100)
    expect(new Set(ACTION_TYPES).size).toBe(ACTION_TYPES.length)
  })

  it('keeps every invariant after every action (references, order, bounds, normalize, purity), and every action does something in the run', () => {
    const failures: string[] = []
    const effective = new Set<string>()
    const seeds = SEED !== undefined ? [SEED] : Array.from({ length: SEEDS }, (_, i) => 1000 + i)
    for (const seed of seeds) {
      const failure = play(seed, STEPS, undefined, (action, before, after) => before !== after && effective.add(action.type))
      if (failure) failures.push(report(failure))
      if (failures.length >= 5) break
    }
    expect(failures.join('\n')).toBe('')
    // A generator that never gets its action to change anything tests nothing: every action type must have done something somewhere in the run.
    if (SEED === undefined && SEEDS >= 40) expect(ACTION_TYPES.filter((type) => !effective.has(type))).toEqual([])
    // A long run (PROP_SEEDS=2000) takes minutes: the default of the suite is a few seconds.
  }, 600_000)

  it('gets the sequences it plays reproducibly: the same seed gives the same final state', () => {
    const final = (seed: number) => {
      const rand = mulberry32(seed)
      const ctx = context()
      const gen = new Gen(rand, createInitialState(ctx))
      for (let i = 0; i < 80; i++) {
        ctx.now += gen.int(3_600_000)
        gen.state = reduce(gen.state, GENERATORS[gen.pick(ACTION_TYPES)](gen) as Action, ctx)
      }
      return canonical(gen.state)
    }
    expect(final(7)).toBe(final(7))
    expect(final(7)).not.toBe(final(8))
  })
})

// The checker the random runs lean on: if one of its conditions were always true, every run would pass without proving anything. Each broken
// state below is one defect, and the checker names it.
describe('the invariants checker', () => {
  const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `c${++n}` })() }
  const good = (): SidebarState => reduce(reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx), { type: 'tab/open', url: 'https://b.example/' }, ctx)

  it('finds nothing in a state the reducer made', () => {
    expect(violations(good())).toEqual([])
  })

  it('names each defect it is shown', () => {
    const state = good()
    const [a, b] = state.tabs
    const cases: Array<[SidebarState, RegExp]> = [
      [{ ...state, version: STATE_VERSION + 1 } as unknown as SidebarState, /^version$/],
      [{ ...state, activeSpaceId: 'nowhere' }, /activeSpaceId nowhere is not a space/],
      [{ ...state, tabs: [a!, { ...b!, id: a!.id }] }, /duplicate tab/],
      [{ ...state, tabs: [a!, { ...b!, spaceId: 'gone' }] }, /is in the missing space gone/],
      [{ ...state, tabs: [a!, { ...b!, windowKey: 'window-1' }] }, /has a window key/],
      [{ ...state, tabs: [a!, { ...b!, container: 'none' }] }, /is in the missing container none/],
      [{ ...state, tabs: [a!, { ...b!, pinned: true, private: true }] }, /is pinned/]
    ]
    for (const [broken, message] of cases) expect(violations(broken), String(message)).toContainEqual(expect.stringMatching(message))
  })
})
