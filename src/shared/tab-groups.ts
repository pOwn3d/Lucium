// The tab groups of the extension API (chrome.tabGroups, chrome.tabs.group): the model behind them, as pure functions.
//
// Lucium's sidebar has no tab groups: they exist for extensions. An agent extension such as Claude puts the tabs it may act on
// in a group and refuses to touch a tab outside it, so the membership has to be real (a tab reports its group, a query by group
// returns only that group) even though the sidebar does not draw it.

import { globMatch } from './extension-access'

export const TAB_GROUP_ID_NONE = -1

/** A group title is a few words; an extension cannot make it a megabyte that every later query has to read. */
export const MAX_GROUP_TITLE = 256

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

/** The shape `chrome.tabGroups` returns. */
export interface TabGroup {
  id: number
  windowId: number
  title: string
  color: GroupColor
  collapsed: boolean
}

export interface GroupState {
  nextId: number
  groups: Record<number, TabGroup>
  /** The group of each grouped tab, by tab number. */
  members: Record<number, number>
}

export const emptyGroups = (): GroupState => ({ nextId: 1, groups: {}, members: {} })

/** What a change did, for the events an extension listens to. */
export interface GroupChange {
  /** Tabs whose group id changed (chrome.tabs.onUpdated with `groupId`). */
  tabs: number[]
  created: TabGroup[]
  removed: TabGroup[]
  updated: TabGroup[]
}

const noChange = (): GroupChange => ({ tabs: [], created: [], removed: [], updated: [] })

export interface GroupResult<T = void> {
  state: GroupState
  change: GroupChange
  value: T
}

export function groupOf(state: GroupState, tab: number): number {
  return state.members[tab] ?? TAB_GROUP_ID_NONE
}

export function membersOf(state: GroupState, groupId: number): number[] {
  return Object.entries(state.members)
    .filter(([, id]) => id === groupId)
    .map(([tab]) => Number(tab))
}

function requireGroup(state: GroupState, groupId: number): TabGroup {
  const group = state.groups[groupId]
  if (!group) throw new Error(`No group with id: ${groupId}.`)
  return group
}

/** Takes tabs out of whatever group they are in, and drops the groups that end up empty. Mutates `draft`. */
function leave(draft: GroupState, tabs: number[], change: GroupChange): void {
  const touched = new Set<number>()
  for (const tab of tabs) {
    const id = draft.members[tab]
    if (id === undefined) continue
    delete draft.members[tab]
    touched.add(id)
    change.tabs.push(tab)
  }
  for (const id of touched) {
    if (membersOf(draft, id).length > 0) continue
    const group = draft.groups[id]
    if (group) change.removed.push(group)
    delete draft.groups[id]
  }
}

const clone = (state: GroupState): GroupState => ({ nextId: state.nextId, groups: { ...state.groups }, members: { ...state.members } })

/**
 * chrome.tabs.group: puts tabs in an existing group, or in a new one when `groupId` is not given. `windowOf` tells the window of a
 * tab (undefined when it does not exist). Every tab must be in one window, the group's own: a tab cannot be moved between windows.
 */
export function groupTabs(
  state: GroupState,
  tabs: number[],
  target: { groupId?: number; windowId?: number },
  windowOf: (tab: number) => number | undefined
): GroupResult<number> {
  const unique = [...new Set(tabs)]
  if (unique.length === 0) throw new Error('No tabs specified.')
  const windows = new Set<number>()
  for (const tab of unique) {
    const windowId = windowOf(tab)
    if (windowId === undefined) throw new Error(`No tab with id: ${tab}.`)
    windows.add(windowId)
  }
  const draft = clone(state)
  const change = noChange()
  let group: TabGroup
  if (target.groupId !== undefined) {
    group = requireGroup(draft, target.groupId)
    if (windows.size !== 1 || !windows.has(group.windowId)) throw new Error('Tabs must be in the same window as the group.')
  } else {
    if (windows.size !== 1) throw new Error('Tabs must all be in the same window to be grouped.')
    const windowId = target.windowId ?? [...windows][0]!
    if (!windows.has(windowId)) throw new Error('Tabs must be in the window the group is created in.')
    group = { id: draft.nextId++, windowId, title: '', color: 'grey', collapsed: false }
    draft.groups[group.id] = group
    change.created.push(group)
  }
  // A tab already in the target group stays; the others leave their group first (a group left empty goes away).
  const moving = unique.filter((tab) => draft.members[tab] !== group.id)
  leave(draft, moving, change)
  for (const tab of moving) draft.members[tab] = group.id
  // `leave` lists the tab once for the group it left; it also changed to the new one, which is the same tab: keep one entry.
  change.tabs = [...new Set([...change.tabs, ...moving])]
  return { state: draft, change, value: group.id }
}

/** chrome.tabs.ungroup. Tabs that are in no group are ignored, as in the chrome.tabs API. */
export function ungroupTabs(state: GroupState, tabs: number[]): GroupResult {
  const draft = clone(state)
  const change = noChange()
  leave(draft, [...new Set(tabs)], change)
  return { state: draft, change, value: undefined }
}

/** A tab was closed: it leaves its group like an ungrouped one. */
export function forgetTab(state: GroupState, tab: number): GroupResult {
  return ungroupTabs(state, [tab])
}

export interface GroupUpdate {
  title?: string
  color?: string
  collapsed?: boolean
}

/** chrome.tabGroups.update. */
export function updateGroup(state: GroupState, groupId: number, patch: GroupUpdate): GroupResult<TabGroup> {
  const current = requireGroup(state, groupId)
  if (patch.color !== undefined && !(GROUP_COLORS as readonly string[]).includes(patch.color)) throw new Error(`Invalid color: ${patch.color}.`)
  const next: TabGroup = {
    ...current,
    ...(patch.title !== undefined ? { title: String(patch.title).slice(0, MAX_GROUP_TITLE) } : {}),
    ...(patch.color !== undefined ? { color: patch.color as GroupColor } : {}),
    ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed === true } : {})
  }
  const changed = next.title !== current.title || next.color !== current.color || next.collapsed !== current.collapsed
  const draft = clone(state)
  draft.groups[groupId] = next
  return { state: draft, change: { ...noChange(), updated: changed ? [next] : [] }, value: next }
}

export interface GroupQuery {
  collapsed?: boolean
  color?: string
  title?: string
  windowId?: number
}

/** A title pattern: `*` matches any run of characters, the rest is literal (the way the chrome.tabGroups API matches it). Linear, see `globMatch`. */
function matchesTitle(pattern: string, title: string): boolean {
  return globMatch(pattern, title)
}

/** chrome.tabGroups.query. `currentWindow` resolves the window id the extension means by "the current one". */
export function queryGroups(state: GroupState, query: GroupQuery, currentWindow?: number): TabGroup[] {
  return Object.values(state.groups).filter((group) => {
    if (query.collapsed !== undefined && query.collapsed !== group.collapsed) return false
    if (query.color !== undefined && query.color !== group.color) return false
    if (query.title !== undefined && !matchesTitle(query.title, group.title)) return false
    if (query.windowId !== undefined) {
      const wanted = query.windowId === -2 ? currentWindow : query.windowId
      if (wanted !== group.windowId) return false
    }
    return true
  })
}

export function getGroup(state: GroupState, groupId: number): TabGroup {
  return requireGroup(state, groupId)
}
