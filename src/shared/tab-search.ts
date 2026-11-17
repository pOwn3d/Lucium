// N4 · Recherche d'onglets (⌘⇧A): the "Onglets" mode of the command bar. The rules live here, with no window and no React, so that they are measured.
//
//  - what the list shows: the open tabs of EVERY space, grouped by space, then the archive (when asked for, or when a text is typed);
//  - the filters: one space, and states (asleep, sound, pinned, in a split view, archived), each with the number of lines it would leave;
//  - the duplicates: the same page open twice in the same profile and container, which tabs would close, which one is kept, and how to take it back.
//
// Nothing runs while the mode is closed, and nothing here keeps a state: every function reads the state it is given (the snapshot of the window,
// which already hides the tabs of a locked space) and answers.

import type { Action } from './sidebar'
import { foldedQuery, foldedText, scoreFolded } from './command-bar'
import { profileOfSpace } from './profiles'
import { splitFor } from './sidebar'
import { hostOf } from './url'
import { tabName, type ArchivedTab, type RuntimeState, type SidebarState, type TabItem } from './model'

/** The states a tab can be filtered on, in the order the chips show them. `archived` stands alone: the archive has no sleeping, sound or split tab. */
export const TAB_STATES = ['asleep', 'audio', 'pinned', 'split', 'archived'] as const
export type TabStateFilter = (typeof TAB_STATES)[number]

export interface TabSearchFilters {
  /** The space to look in, or null for all of them. */
  space: string | null
  /** The states a tab must all have (AND); `['archived']` alone shows the archive. */
  states: readonly TabStateFilter[]
}

export const NO_FILTERS: TabSearchFilters = { space: null, states: [] }

export const hasFilters = (filters: TabSearchFilters): boolean => filters.space !== null || filters.states.length > 0

/** A state chip pressed or released. "Archivés" excludes the others, and they exclude it. */
export function toggleStateFilter(filters: TabSearchFilters, state: TabStateFilter): TabSearchFilters {
  if (filters.states.includes(state)) return { ...filters, states: filters.states.filter((s) => s !== state) }
  return { ...filters, states: state === 'archived' ? ['archived'] : [...filters.states.filter((s) => s !== 'archived'), state] }
}

/** The space chip pressed: the same one again, or "Tous", lets go of the space. */
export const toggleSpaceFilter = (filters: TabSearchFilters, space: string | null): TabSearchFilters => ({ ...filters, space: filters.space === space ? null : space })

/** The archive lines shown at most: it holds thousands, the bar lists the most recent ones that answer. */
export const ARCHIVE_ROWS = 30
/** Archive lines offered while a text is typed with no state filter (below the open tabs). */
export const ARCHIVE_ROWS_ON_QUERY = 5

export interface TabSearchRow {
  kind: 'tab' | 'archived'
  /** The id of the tab, or of the archive entry (which is the id the tab had). */
  id: string
  spaceId: string
  title: string
  url: string
  faviconUrl?: string
  pinned: boolean
  asleep: boolean
  audible: boolean
  muted: boolean
  split: boolean
  /** The tab on screen. */
  current: boolean
  /** This tab would be closed by "Fermer les doublons". */
  duplicate: boolean
  /** The last time the tab was used, or the time it went to the archive. */
  at: number
}

export interface TabSearchGroup {
  /** The id of the space, or `archive`. */
  id: string
  kind: 'space' | 'archive'
  rows: TabSearchRow[]
  /** The number the header shows: the lines of the group, or for a cut archive how many there are in all. */
  total: number
}

export interface TabSearchResult {
  groups: TabSearchGroup[]
  /** The lines in the order they are drawn (what the arrows go through). */
  rows: TabSearchRow[]
  /** How many tabs are open (all spaces) and how many pages the archive holds: the line under the title of the bar. */
  open: number
  archived: number
  /** How many lines each chip would leave, with the text and the other filters as they are. */
  spaceCounts: Readonly<Record<string, number>>
  allSpacesCount: number
  stateCounts: Readonly<Record<TabStateFilter, number>>
  duplicates: DuplicatePlan
}

interface Facts {
  asleep: boolean
  audible: boolean
  muted: boolean
  split: boolean
}

function factsOf(tab: TabItem, state: SidebarState, runtime: RuntimeState | undefined): Facts {
  const info = runtime?.tabs[tab.id]
  return { asleep: info !== undefined && !info.awake, audible: info?.audible === true, muted: info?.muted === true, split: splitFor(state, tab.id) !== undefined }
}

const hasState = (tab: TabItem, facts: Facts, wanted: TabStateFilter): boolean => {
  switch (wanted) {
    case 'asleep':
      return facts.asleep
    case 'audio':
      return facts.audible
    case 'pinned':
      return tab.pinned
    case 'split':
      return facts.split
    case 'archived':
      return false
  }
}

// ---------- the duplicates ----------

/** Pages are the same when they only differ by the scheme's case, `www.`, a bare trailing slash or the fragment. Only web pages count. */
export function normalizedAddress(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : ''
  return `${parsed.protocol}//${parsed.host.replace(/^www\./, '')}${path}${parsed.search}`
}

export type KeepReason = 'favorite' | 'pinned' | 'split' | 'current' | 'oldest'

export interface DuplicateGroup {
  address: string
  /** The tab that stays (the first of those that cannot close). */
  keep: string
  reason: KeepReason
  /** The tabs that would close, in the order of the list. */
  close: string[]
}

export interface DuplicatePlan {
  groups: DuplicateGroup[]
  /** Every tab that would close. */
  closeIds: string[]
}

/**
 * The same page open twice. A copy is only a copy for the same profile and the same container (the same site in two profiles is two accounts).
 * What cannot close: the page of a favourite, a pinned tab, a tab of a split view (closing it would change the layout) and the tab each space is
 * on. All of those stay; when none of them is in the group the oldest stays. A private tab is never looked at: it cannot be taken back from the archive.
 */
export function planDuplicates(state: SidebarState): DuplicatePlan {
  const onScreen = new Set(Object.values(state.activeTabBySpace).filter((id): id is string => typeof id === 'string'))
  const byPage = new Map<string, TabItem[]>()
  for (const tab of state.tabs) {
    if (tab.private === true) continue
    const address = normalizedAddress(tab.url)
    if (!address) continue
    const key = `${profileOfSpace(state, tab.spaceId)}\u0000${tab.container ?? ''}\u0000${address}`
    byPage.set(key, [...(byPage.get(key) ?? []), tab])
  }
  const groups: DuplicateGroup[] = []
  for (const [key, tabs] of byPage) {
    if (tabs.length < 2) continue
    const reasonOf = (tab: TabItem): KeepReason | null => (tab.favoriteId !== undefined ? 'favorite' : tab.pinned ? 'pinned' : splitFor(state, tab.id) ? 'split' : onScreen.has(tab.id) ? 'current' : null)
    const protectedTabs = tabs.filter((tab) => reasonOf(tab) !== null)
    // The oldest stays when nothing has to; ties keep the first in the list.
    const oldest = tabs.reduce((best, tab) => (tab.createdAt < best.createdAt ? tab : best), tabs[0]!)
    const kept = protectedTabs.length > 0 ? protectedTabs : [oldest]
    const first = kept[0]!
    const close = tabs.filter((tab) => !kept.includes(tab)).map((tab) => tab.id)
    if (close.length === 0) continue
    groups.push({ address: key.split('\u0000')[2]!, keep: first.id, reason: protectedTabs.length > 0 ? reasonOf(first)! : 'oldest', close })
  }
  // In the order the tabs are listed, not the order the map found the pages.
  const order = new Map(state.tabs.map((tab, i) => [tab.id, i]))
  groups.sort((a, b) => (order.get(a.close[0]!) ?? 0) - (order.get(b.close[0]!) ?? 0))
  return { groups, closeIds: groups.flatMap((group) => group.close) }
}

/** The action that closes the duplicates: they go to the archive, where the tabs keep their identity, which is what "Annuler" brings back. */
export const closeDuplicatesAction = (plan: DuplicatePlan): Action | null => (plan.closeIds.length > 0 ? { type: 'tabs/archive-many', ids: plan.closeIds } : null)

/** What "Annuler" does: the archive entry of each tab that was closed goes back to its space. An entry that is gone (the archive was emptied) is skipped. */
export function reopenActions(closedIds: readonly string[], archive: readonly Pick<ArchivedTab, 'id'>[]): Action[] {
  const held = new Set(archive.map((entry) => entry.id))
  return closedIds.filter((id) => held.has(id)).map((id): Action => ({ type: 'archive/restore', id }))
}

// ---------- the list ----------

function rowOfTab(tab: TabItem, state: SidebarState, runtime: RuntimeState | undefined, closing: ReadonlySet<string>): TabSearchRow {
  const facts = factsOf(tab, state, runtime)
  return {
    kind: 'tab',
    id: tab.id,
    spaceId: tab.spaceId,
    title: tabName(tab) || hostOf(tab.url) || tab.url,
    url: tab.url,
    ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
    pinned: tab.pinned,
    ...facts,
    current: state.activeTabBySpace[state.activeSpaceId] === tab.id,
    duplicate: closing.has(tab.id),
    at: tab.lastActiveAt
  }
}

function rowOfArchived(entry: ArchivedTab): TabSearchRow {
  return { kind: 'archived', id: entry.id, spaceId: entry.spaceId, title: entry.title || hostOf(entry.url) || entry.url, url: entry.url, pinned: entry.pinned === true, asleep: false, audible: false, muted: false, split: false, current: false, duplicate: false, at: entry.archivedAt }
}

/** How well a tab answers the text: the title by any match, the address only by a real substring (a loose run of letters would match every address). */
function scoreOf(title: string, url: string, needle: string): number {
  const inTitle = scoreFolded(foldedText(title), needle)
  const inUrl = scoreFolded(foldedText(url), needle)
  return Math.max(inTitle, inUrl >= 50 ? inUrl : 0)
}

/**
 * The list of the bar in "Onglets" mode. Open tabs by space, in the order of the sidebar (best answer first when a text is typed); the archive after
 * them when the "Archivés" chip is on, or when a text is typed and no state is asked for (a few lines: the archive is searched, not browsed).
 */
export function searchTabs(state: SidebarState, runtime: RuntimeState | undefined, query: string, filters: TabSearchFilters): TabSearchResult {
  const needle = foldedQuery(query)
  const plan = planDuplicates(state)
  const closing = new Set(plan.closeIds)
  const archiveOnly = filters.states.includes('archived')
  const states = filters.states.filter((s) => s !== 'archived')
  const scoreCache = new Map<string, number>()
  const score = (id: string, title: string, url: string): number => {
    if (!needle) return 1
    let cached = scoreCache.get(id)
    if (cached === undefined) scoreCache.set(id, (cached = scoreOf(title, url, needle)))
    return cached
  }

  // Every open tab with what the filters ask about it, once; the counts below reuse them.
  const candidates = state.tabs.map((tab) => {
    const row = rowOfTab(tab, state, runtime, closing)
    return { tab, row, facts: factsOf(tab, state, runtime), score: score(tab.id, row.title, row.url) }
  })
  const answers = (c: (typeof candidates)[number], space: string | null, wanted: readonly TabStateFilter[]): boolean => c.score > 0 && (space === null || c.tab.spaceId === space) && wanted.every((s) => hasState(c.tab, c.facts, s))

  const spaceCounts: Record<string, number> = {}
  for (const space of state.spaces) spaceCounts[space.id] = archiveOnly ? 0 : candidates.filter((c) => answers(c, space.id, states)).length
  const stateCounts = {} as Record<TabStateFilter, number>
  for (const wanted of TAB_STATES) {
    if (wanted === 'archived') stateCounts.archived = state.archive.filter((a) => (filters.space === null || a.spaceId === filters.space) && (!needle || scoreOf(a.title, a.url, needle) > 0)).length
    else stateCounts[wanted] = candidates.filter((c) => answers(c, filters.space, states.includes(wanted) ? states : [...states, wanted])).length
  }

  const groups: TabSearchGroup[] = []
  if (!archiveOnly) {
    for (const space of state.spaces) {
      if (filters.space !== null && filters.space !== space.id) continue
      const matching = candidates.filter((c) => c.tab.spaceId === space.id && answers(c, space.id, states))
      // The sidebar's order, unless a text is typed: then the best answer first and, for equal ones, the tab used last.
      if (needle) matching.sort((a, b) => b.score - a.score || b.row.at - a.row.at)
      if (matching.length > 0) groups.push({ id: space.id, kind: 'space', rows: matching.map((c) => c.row), total: matching.length })
    }
  }
  if (archiveOnly || (needle && states.length === 0)) {
    const matching = state.archive.filter((a) => (filters.space === null || a.spaceId === filters.space) && (!needle || scoreOf(a.title, a.url, needle) > 0))
    if (needle) matching.sort((a, b) => scoreOf(b.title, b.url, needle) - scoreOf(a.title, a.url, needle) || b.archivedAt - a.archivedAt)
    const shown = matching.slice(0, archiveOnly ? ARCHIVE_ROWS : ARCHIVE_ROWS_ON_QUERY)
    if (shown.length > 0) groups.push({ id: 'archive', kind: 'archive', rows: shown.map(rowOfArchived), total: matching.length })
  }
  return {
    groups,
    rows: groups.flatMap((group) => group.rows),
    open: state.tabs.length,
    archived: state.archive.length,
    spaceCounts,
    allSpacesCount: Object.values(spaceCounts).reduce((sum, n) => sum + n, 0),
    stateCounts,
    duplicates: plan
  }
}

// ---------- what a line does ----------

/** What the keys do on a line of the bar. `beside` is ⌘↵ (the tab next to the one on screen, in a split view). */
export type TabSearchChoice = 'go' | 'beside'

/** The actions of a choice: go to the tab (its space comes with it), bring a page back from the archive, or put the tab beside the one on screen. */
export function choiceActions(state: SidebarState, row: TabSearchRow, choice: TabSearchChoice): Action[] {
  if (row.kind === 'archived') return [{ type: 'archive/restore', id: row.id }]
  if (choice === 'beside') {
    const shown = state.activeTabBySpace[state.activeSpaceId]
    const here = shown ? state.tabs.find((t) => t.id === shown) : undefined
    const there = state.tabs.find((t) => t.id === row.id)
    // A split view joins two tabs of one space; anything else is a plain "go".
    if (here && there && here.id !== there.id && here.spaceId === there.spaceId && !splitFor(state, there.id) && here.private !== true && there.private !== true) {
      return [{ type: 'split/create', tabId: here.id, withTabId: there.id }]
    }
  }
  return [{ type: 'tab/select', id: row.id }]
}

/** ⌫ on an empty field (⌘⌫ with a text): the tab goes to the archive, which can take it back. Not for a pinned tab, a private one or a line of the archive. */
export function canArchiveRow(row: TabSearchRow, state: SidebarState): boolean {
  if (row.kind !== 'tab' || row.pinned) return false
  const tab = state.tabs.find((t) => t.id === row.id)
  return tab !== undefined && tab.private !== true && tab.favoriteId === undefined
}

/**
 * ⌫ archives the highlighted tab on an empty field, and ⌘⌫ with a text in it. Never from a key held down: clearing a long text by holding ⌫ must stop
 * at the empty field, not go on to archive a tab.
 */
export function isArchiveKey(event: { key: string; metaKey: boolean; repeat: boolean }, query: string): boolean {
  return event.key === 'Backspace' && !event.repeat && (query === '' || event.metaKey)
}
