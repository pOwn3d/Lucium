// The pure work done for the state, measured without Electron on large states: what the reducer does at each change (a page's title, a click on a
// tab, ⇧⌘T), what the window works out for each snapshot it sends (the tabs Back would close), what the sidebar works out at each snapshot it draws, what
// the command bar does at each keystroke, and what the launch does once to find the tabs it wakes. The parts that need the application (the native views, the menu, the drawing of the rows) are not here: only `pnpm perf` sees them.
//
// It prints a table and asserts nothing about time, so it stays out of `pnpm test` (vitest.config.mts). Run it with `pnpm test:state-bench`.
// The numbers it gave are in docs/performance.md (« Le travail sur l'état »).

import { deserialize, serialize } from 'node:v8'
import { afterAll, describe, expect, it } from 'vitest'
import { isListedTab, type ArchivedTab, type Favorite, type Folder, type HistoryEntry, type RuntimeState, type SidebarState, type Space, type SplitView, type TabItem } from '@shared/model'
import { backClosesLookup, createInitialState, normalize, reduce, visibleTabOrder } from '@shared/sidebar'
import { menuKey } from '@shared/menu-state'
import { rankCandidates } from '@shared/command-bar'
import { tabsToWakeAtLaunch } from '@shared/sleep'
import { tidyCandidates } from '@shared/tab-grouping'
import { foldedAway, treeRows } from '@shared/tab-tree'
import { splitRows, type DrawnList } from '@shared/split-place'
import { favoritesOfSpace } from '@shared/favorite-scope'
import { sameTabRow } from '@shared/row-equality'

interface Shape {
  label: string
  tabs: number
  spaces: number
  /** The share of the tabs in the space on screen. */
  onScreen: number
  tree: boolean
}

const SHAPES: Shape[] = [
  { label: '500 onglets, 10 espaces', tabs: 500, spaces: 10, onScreen: 0.3, tree: true },
  { label: '2 000 onglets, 50 espaces', tabs: 2000, spaces: 50, onScreen: 0.2, tree: true },
  { label: '2 000 onglets, 50 espaces, sans arbre', tabs: 2000, spaces: 50, onScreen: 0.2, tree: false },
  { label: '2 000 onglets, 1 espace', tabs: 2000, spaces: 1, onScreen: 1, tree: true },
  { label: '5 000 onglets, 50 espaces', tabs: 5000, spaces: 50, onScreen: 0.2, tree: true },
  { label: '5 000 onglets, 1 espace', tabs: 5000, spaces: 1, onScreen: 1, tree: true }
]
const RUNS = 40
const WARMUP = 8

const SITES = ['lemonde', 'github', 'wikipedia', 'stackoverflow', 'youtube', 'nytimes', 'figma', 'notion', 'linear', 'vercel', 'mozilla', 'arstechnica']
/** An id of the shape the application gives (a UUID), but the same on every run. */
const idOf = (kind: string, n: number): string => `${kind.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/**
 * `shape.tabs` tabs, a share of them in the space on screen and the others spread over the other spaces; five folders per space (one inside another,
 * one under Today, every other one closed), a tenth of the tabs pinned into them; with the tree, a third of the Today tabs hang under one of the three
 * tabs before them, and one in thirty of those is folded. A split view of two tabs in each space with enough tabs, twenty favourites over two
 * profiles, a full archive. The tab on screen is near the end of its space (the worst place for a search from the start of the list).
 */
function bigState(shape: Shape): SidebarState {
  let n = 0
  const base = createInitialState({ now: 1_700_000_000_000, newId: () => idOf('space', n++) })
  const first = base.spaces[0]!
  const spaces: Space[] = Array.from({ length: shape.spaces }, (_, i) => (i === 0 ? first : { ...first, id: idOf('space', 100 + i), name: `Espace ${i + 1}`, profileId: i % 7 === 0 ? 'work' : 'default' }))
  const folders: Folder[] = spaces.flatMap((space, s) =>
    Array.from({ length: 5 }, (_, f) => ({ id: idOf('folder', s * 10 + f), spaceId: space.id, name: `Dossier ${f + 1}`, collapsed: f % 2 === 0, ...(f === 4 ? { parentId: idOf('folder', s * 10) } : {}), ...(f === 3 ? { atBottom: true as const } : {}) }))
  )
  const tabs: TabItem[] = []
  const onScreen = Math.round(shape.tabs * shape.onScreen)
  const todayOf = new Map<string, string[]>()
  for (let i = 0; i < shape.tabs; i++) {
    const s = i < onScreen ? 0 : 1 + ((i - onScreen) % Math.max(1, shape.spaces - 1))
    const space = spaces[Math.min(s, spaces.length - 1)]!
    const site = SITES[i % SITES.length]!
    const pinned = i % 10 === 0
    const id = idOf('tab', i)
    const today = todayOf.get(space.id) ?? []
    const parent = !pinned && shape.tree && i % 3 === 0 && today.length > 0 ? today[today.length - 1 - (i % Math.min(3, today.length))] : undefined
    tabs.push({
      id,
      spaceId: space.id,
      url: `https://www.${site}.com/articles/2026/11/some-page-${i}`,
      title: `Some page number ${i} - ${site}`,
      faviconUrl: `https://www.${site}.com/favicon.png`,
      pinned,
      ...(pinned ? { folderId: idOf('folder', Math.min(s, spaces.length - 1) * 10 + ((i / 10) % 5)) } : {}),
      ...(parent ? { parentId: parent } : {}),
      ...(parent && i % 30 === 0 ? { treeCollapsed: true as const } : {}),
      createdAt: 1_700_000_000_000 + i * 1000,
      lastActiveAt: 1_700_100_000_000 + i * 1000
    })
    if (!pinned) todayOf.set(space.id, [...today, id])
  }
  const splits: SplitView[] = [...todayOf].flatMap(([spaceId, ids]) => (ids.length >= 6 ? [{ id: `split-${spaceId}`, spaceId, tabIds: [ids[ids.length - 2]!, ids[ids.length - 1]!], orientation: 'horizontal' as const, ratios: [0.5, 0.5] }] : []))
  const favorites: Favorite[] = Array.from({ length: 20 }, (_, i) => ({ id: idOf('fav', i), url: `https://fav${i}.example/`, title: `Fav ${i}`, profileId: i % 4 === 0 ? 'work' : 'default' }))
  const archive: ArchivedTab[] = Array.from({ length: 500 }, (_, i) => ({ id: idOf('arch', i), spaceId: spaces[i % spaces.length]!.id, url: `https://old.example/${i}`, title: `Old ${i}`, archivedAt: 1_699_000_000_000 - i * 1000, source: 'auto' }))
  const shownToday = todayOf.get(first.id) ?? []
  return normalize({
    ...base,
    spaces,
    folders,
    tabs,
    splits,
    favorites,
    archive,
    settings: { ...base.settings, tabTree: shape.tree },
    activeSpaceId: first.id,
    activeTabBySpace: Object.fromEntries(spaces.map((space) => [space.id, (space.id === first.id ? shownToday[shownToday.length - 3] : todayOf.get(space.id)?.[0]) ?? null]))
  })
}

/** The median, in milliseconds, of `RUNS` timed runs after `WARMUP` that are not kept. */
function median(run: () => unknown, runs = RUNS, warmup = WARMUP): number {
  for (let i = 0; i < warmup; i++) run()
  const durations: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    run()
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)
  return durations[Math.floor(runs / 2)]!
}

/** What Sidebar.tsx works out at each snapshot for the space on screen, before drawing a row (the pure part, as it does it). */
function sidebarDerived(state: SidebarState, spaceId: string): unknown {
  const tabs = state.tabs.filter((t) => t.spaceId === spaceId)
  const listed = tabs.filter(isListedTab)
  const pinned = listed.filter((t) => t.pinned)
  const today = listed.filter((t) => !t.pinned)
  const folders = state.folders.filter((f) => f.spaceId === spaceId)
  const current = tabs.find((t) => t.id === state.activeTabBySpace[spaceId])
  const isFavorite = !!current && favoritesOfSpace(state, spaceId).some((f) => f.url === current.url)
  const splitTabIds = new Set(state.splits.flatMap((sp) => sp.tabIds))
  const treeInfo = state.settings.tabTree ? treeRows(today) : null
  const folded = state.settings.tabTree ? foldedAway(today) : null
  const shownToday = folded && folded.size > 0 ? today.filter((t) => !folded.has(t.id)) : today
  const order = visibleTabOrder(state, spaceId).map((t) => t.id)
  const addressRow = current !== undefined && order.includes(current.id) && !splitTabIds.has(current.id)
  const topFolders = folders.filter((f) => !f.parentId && !f.atBottom)
  const bottomFolders = folders.filter((f) => !f.parentId && f.atBottom)
  const loose = pinned.filter((t) => !t.folderId || !folders.some((f) => f.id === t.folderId))
  const folderLists = (folder: Folder): DrawnList<TabItem>[] => [{ tabs: pinned.filter((t) => t.folderId === folder.id), folder: true }, ...folders.filter((f) => f.parentId === folder.id).flatMap(folderLists)]
  const splitPlan = splitRows([{ tabs: loose, folder: false }, ...topFolders.flatMap(folderLists), { tabs: shownToday, folder: false }, ...bottomFolders.flatMap(folderLists)], state.splits)
  const tidyable = tidyCandidates(state, spaceId).length >= 2
  return [isFavorite, treeInfo, addressRow, splitPlan, tidyable]
}

interface Row {
  shape: string
  title: number
  select: number
  reopen: number
  menu: number
  back: number
  barEmpty: number
  barE: number
  launch: number
  sidebar: number
  treeRows: number
  rows: number
  snapshot: number
}

const rows: Row[] = []
const ms = (value: number): string => value.toFixed(value < 1 ? 3 : 2).replace('.', ',')

describe('the work on the state, on large states', () => {
  for (const shape of SHAPES) {
    it(shape.label, () => {
      const state = bigState(shape)
      expect(state.tabs).toHaveLength(shape.tabs)
      const ctx = { now: 1_800_000_000_000, newId: () => 'new-id' }
      const spaceId = state.activeSpaceId
      // A tab of another space (else of this one) whose page changes its title: the most frequent change.
      const background = state.tabs.find((t) => !t.pinned && t.spaceId !== spaceId) ?? state.tabs.find((t) => !t.pinned && t.id !== state.activeTabBySpace[spaceId])!
      const today = state.tabs.filter((t) => t.spaceId === spaceId && isListedTab(t) && !t.pinned)
      let k = 0
      const history: HistoryEntry[] = Array.from({ length: 200 }, (_, i) => ({ url: `https://hist${i}.example/page`, title: `History ${i} github`, visitCount: i % 7, lastVisitAt: i }))
      const runtime: RuntimeState = { tabs: Object.fromEntries(state.tabs.map((t, i) => [t.id, { loading: false, audible: false, muted: false, awake: i % 10 === 0 }])), canGoBack: false, canGoForward: false }
      // What the interface holds after the next snapshot: the same data, other objects (it crossed a process).
      const received = deserialize(serialize({ state, runtime })) as { state: SidebarState; runtime: RuntimeState }
      const todayReceived = received.state.tabs.filter((t) => t.spaceId === spaceId && isListedTab(t) && !t.pinned)
      // One tab opened from a link, still on its first page (the setting that lets Back close it is on by default): the window flags it at each snapshot.
      const opened: SidebarState = { ...state, tabs: state.tabs.map((t) => (t === background ? { ...t, openerId: state.activeTabBySpace[spaceId] ?? undefined } : t)) }
      rows.push({
        shape: shape.label,
        title: median(() => reduce(state, { type: 'tab/update', id: background.id, patch: { title: `Title ${k++}` } }, ctx)),
        select: median(() => reduce(state, { type: 'tab/select', id: today[k++ % today.length]!.id }, ctx)),
        // « Rouvrir le dernier onglet fermé » (⇧⌘T): the newest entry of the archive comes back.
        reopen: median(() => reduce(state, { type: 'archive/restore-last' }, ctx)),
        menu: median(() => menuKey(state, ['a', 'b', 'c'])),
        // As `withBackCloses` (browser-commands.ts) does it for the snapshot of a window.
        back: median(() => {
          const closes = backClosesLookup(opened)
          return opened.tabs.filter((t) => runtime.tabs[t.id] !== undefined && closes(t.id, runtime.tabs[t.id]?.canGoBack)).map((t) => t.id)
        }),
        barEmpty: median(() => rankCandidates('', state, history)),
        barE: median(() => rankCandidates('e', state, history)),
        launch: median(() => tabsToWakeAtLaunch(state, { spaces: [spaceId], shown: new Set([state.activeTabBySpace[spaceId] ?? '']) }), 10, 2),
        sidebar: median(() => sidebarDerived(state, spaceId)),
        treeRows: median(() => treeRows(today)),
        rows: median(() => today.every((tab, i) => sameTabRow({ tab, active: false, inSplit: false, runtime }, { tab: todayReceived[i]!, active: false, inSplit: false, runtime: received.runtime }))),
        snapshot: median(() => deserialize(serialize({ state, runtime })), 10, 2)
      })
    }, 120_000)
  }

  afterAll(() => {
    // One table for the whole run; docs/performance.md keeps the figures with the date and the machine.
    const head = ['État', 'Titre (réducteur)', 'Clic (réducteur)', '⇧⌘T (réducteur)', 'Clé du menu', 'Retour qui ferme', 'Barre vide', 'Barre « e »', 'Lancement', 'Barre latérale', 'dont treeRows', 'Rangées comparées', 'Instantané copié']
    const lines = rows.map((r) => [r.shape, ms(r.title), ms(r.select), ms(r.reopen), ms(r.menu), ms(r.back), ms(r.barEmpty), ms(r.barE), ms(r.launch), ms(r.sidebar), ms(r.treeRows), ms(r.rows), ms(r.snapshot)])
    console.log([`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...lines.map((cells) => `| ${cells.join(' | ')} |`)].join('\n'))
  })
})
