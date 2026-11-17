// What the families of the reducer of the sidebar share (sidebar.ts composes them): selecting, archiving and moving tabs, the groups of a space, the
// tidied titles. Pure, like the reducer.

import { type ArchiveSource, type ArchivedTab, type SidebarState, type TabItem, isListedTab, tabName } from './model'
import { tidyTitle } from './tidy'
import { cutAddress, isExtensionPageUrl, isNavigableUrl, isViewSourceUrl } from './url'
import { isInternalPageUrl } from './internal-page'
import { branchIds } from './tab-tree'
import { ARCHIVE_LIMIT, cleanFaviconUrl, TAB_URL_MAX, TITLE_MAX, isRecord, printable } from './state-clean'
import { t } from './i18n'
import type { Action, Ctx } from './sidebar-actions'
import { pickNeighbor } from './sidebar-selectors'

/**
 * The reducer itself, for the families: an action that is made of others (a folder moved to a space of its own, a session reopened) runs them
 * through it. Passed in by sidebar.ts rather than imported, so that the families do not import the module that imports them.
 */
export interface Reducers {
  /** `reduce`: the action, then the invariants settled (the tree, the splits, the origins, the favourites). */
  reduce(state: SidebarState, action: Action, ctx: Ctx): SidebarState
  /** `reduceCore`: the action alone. */
  core(state: SidebarState, action: Action, ctx: Ctx): SidebarState
}

/** What a duplicated folder's name ends with (in the language of the interface). */
export const copySuffix = (): string => ` ${t('sidebar.copie')}`
/** What a command bar usage key starts with before the address (command-bar.ts `usageKey`). */
export const USAGE_KEY_PREFIX = 'url:'
/** The most themes one `space/apply-themes` reads: far more than anyone has spaces. */
export const MAX_THEME_ENTRIES = 200
export const HOUR_MS = 3_600_000

/** Whether two versions of a tab hold the same values (a record such as `autoReload` is carried over as it is by the spread, so it compares equal when untouched). */
export function sameTabFields(a: TabItem, b: TabItem): boolean {
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]))
}

export function replaceTab(state: SidebarState, id: string, fn: (t: TabItem) => TabItem): SidebarState {
  // A tab that is gone (a late event of its closed page) is no change: the same state, so that nothing is saved, published or drawn for it.
  if (!state.tabs.some((t) => t.id === id)) return state
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? fn(t) : t)) }
}

/** Whether a choice about a site is made from a private tab: the sites of the settings are kept in the state file, which a private tab must not add to. */
export const fromPrivateTab = (state: SidebarState, tabId: string | undefined): boolean => tabId !== undefined && state.tabs.some((t) => t.id === tabId && t.private === true)

/**
 * Whether every tab on a site is private. The actions that name a site without a tab (a favorite, the developer mode, the sleep exceptions) would write the
 * site of a private tab into the state file, which outlives the tab; a regular tab on the same site keeps the choice possible.
 */
export const onlyPrivateTabsOn = (state: SidebarState, onSite: (url: string) => boolean): boolean => {
  const shown = state.tabs.filter((t) => onSite(t.url))
  return shown.length > 0 && shown.every((t) => t.private === true)
}

/**
 * The anchor of a pinned tab as the reducer may send the tab back to it. An address of the Extensions page is one only for a tab that may show it: never a private tab nor a
 * tab of a container, whose session does not serve the page (the state of such a tab is read without it: `cleanTabs`, `tab/update`, and here for what a tab became after).
 */
export function anchorOf(tab: TabItem): string | undefined {
  const anchor = tab.anchorUrl
  return anchor !== undefined && isInternalPageUrl(anchor) && (tab.private === true || tab.container !== undefined) ? undefined : anchor
}

/** The part of a `chrome-extension://<id>` address that names the extension. */
export const extensionOrigin = (url: string): string => url.slice(0, 'chrome-extension://'.length + 32)

/**
 * What a page may tell about its tab: its address (a web page, the source view of one, or another page of the extension the tab is already on, or another
 * address of the Extensions page when the tab is already on it: the page moves between its views without reloading), its title and its icon. Every other field of a tab is the reducer's own. The main process sends this, but the interface can dispatch it too:
 * nothing in the patch is trusted, and a field that fails its rule is left out.
 * `allowInternalPages` is the main process' alone (`ipc-policy.ts` refuses it to the interface): the engine saw the document of the Extensions page commit in this tab (a Back
 * or a Forward onto it, after the tab went elsewhere), so the tab is on it again. It is never taken for a private tab or a tab of a container, which never show it.
 */
export function cleanTabUpdate(raw: unknown, tab: TabItem, allowInternalPages = false): Partial<Pick<TabItem, 'url' | 'title' | 'faviconUrl'>> {
  const patch: Partial<Pick<TabItem, 'url' | 'title' | 'faviconUrl'>> = {}
  if (!isRecord(raw)) return patch
  const { url, title, faviconUrl } = raw
  // An address past `TAB_URL_MAX` is kept cut, never dropped (a page can write a 2 Mo address into its own history, and a redirect can send a tab to one):
  // the tab would otherwise go on naming the site it has left, above the page of another one.
  const address = typeof url === 'string' ? cutAddress(url, TAB_URL_MAX) : undefined
  if (address !== undefined && (isNavigableUrl(address) || isViewSourceUrl(address) || (isExtensionPageUrl(address) && isExtensionPageUrl(tab.url) && extensionOrigin(address) === extensionOrigin(tab.url)) || (isInternalPageUrl(address) && (isInternalPageUrl(tab.url) || (allowInternalPages && tab.private !== true && tab.container === undefined))))) patch.url = address
  const text = printable(title, TITLE_MAX)
  if (text !== null) patch.title = text
  const icon = cleanFaviconUrl(faviconUrl)
  if (icon !== undefined) patch.faviconUrl = icon
  // '' is "the page has no icon to show": the icon of the page before goes (`tab/update` takes the field away). Nothing to do for a tab without one.
  else if (faviconUrl === '' && tab.faviconUrl !== undefined) patch.faviconUrl = ''
  return patch
}

export function select(state: SidebarState, id: string, now: number): SidebarState {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab) return state
  const next = replaceTab(state, id, (t) => ({ ...t, lastActiveAt: now }))
  return {
    ...next,
    activeSpaceId: tab.spaceId,
    activeTabBySpace: { ...next.activeTabBySpace, [tab.spaceId]: id }
  }
}

/** Moves tabs to the archive, reselecting a neighbour in any space whose selected tab leaves. */
export function archiveTabs(state: SidebarState, ids: string[], source: ArchiveSource, ctx: Ctx): SidebarState {
  const leaving = new Set(ids)
  const going = state.tabs.filter((t) => leaving.has(t.id))
  // A private tab leaves like any other, but the archive never hears of it: its address would outlive the tab. Nor does it hear of the Extensions page: nothing opens it again but the shell.
  const entries: ArchivedTab[] = going
    .filter((t) => t.private !== true && !isInternalPageUrl(t.url))
    .map((t): ArchivedTab => {
      const history = ctx.closedHistory?.(t.id)
      return { id: t.id, spaceId: t.spaceId, url: t.url, title: tabName(t), archivedAt: ctx.now, source, ...(t.pinned ? { pinned: true as const, ...(t.anchorUrl ? { anchorUrl: t.anchorUrl } : {}), ...(t.folderId ? { folderId: t.folderId } : {}) } : {}), ...(history ? { history } : {}), ...(t.container !== undefined ? { container: t.container } : {}) }
    })
  if (going.length === 0) return state
  const remaining = { ...state, tabs: state.tabs.filter((t) => !leaving.has(t.id)) }
  const activeTabBySpace = { ...state.activeTabBySpace }
  for (const [spaceId, activeId] of Object.entries(state.activeTabBySpace)) {
    if (!activeId || !leaving.has(activeId)) continue
    const gone = state.tabs.find((t) => t.id === activeId)!
    const next = pickNeighbor({ ...state, tabs: remaining.tabs.concat(gone) }, gone)
    activeTabBySpace[spaceId] = next && !leaving.has(next) ? next : null
  }
  // An entry that already has the id of a tab leaving (a copy restored after the tab was archived once) is replaced: the archive keeps an id once.
  const older = entries.some((e) => state.archive.some((a) => a.id === e.id)) ? state.archive.filter((a) => !entries.some((e) => e.id === a.id)) : state.archive
  return { ...remaining, activeTabBySpace, archive: [...entries.reverse(), ...older].slice(0, ARCHIVE_LIMIT) }
}

/**
 * Puts tabs in the pinned list (in `folderId`, when that folder exists in their space) or in Today, as one block
 * before the tab that is at `toIndex` in the group once they are out of it. Only the tabs of the first one's space move.
 */
export function moveTabs(state: SidebarState, ids: string[], toIndex: number, pinned: boolean, folderId?: string, parentId?: string | null): SidebarState {
  const found = [...new Set(ids)].map((id) => state.tabs.find((t) => t.id === id)).filter((t): t is TabItem => !!t)
  const spaceId = found[0]?.spaceId
  // A private tab is never pinned (the pinned list is saved), nor put in a folder.
  let moving = found.filter((t) => t.spaceId === spaceId && !(pinned && t.private === true))
  if (moving.length === 0 || !Number.isFinite(toIndex)) return state
  // In the tree, a tab brings its branch along to Today (the branch is put back right under it afterwards, see `settleTree`); a pinned tab leaves its children where they are.
  const tree = state.settings.tabTree === true && !pinned
  let hung: string | undefined
  if (tree) {
    const chosen = new Set(moving.map((t) => t.id))
    const branch = branchIds(state.tabs, chosen)
    moving = [...moving, ...state.tabs.filter((t) => branch.has(t.id) && !chosen.has(t.id) && t.spaceId === spaceId)]
    if (typeof parentId === 'string') {
      const parent = state.tabs.find((t) => t.id === parentId)
      // A tab cannot hang under itself or under something of its own branch, nor under a pinned tab or a tab of another space.
      if (!parent || parent.pinned || parent.spaceId !== spaceId || moving.some((t) => t.id === parent.id)) return state
      hung = parent.id
    }
  }
  // A folder that does not exist (or belongs to another space) puts the tabs at the root of the pinned list.
  const inFolder = pinned && folderId !== undefined && state.folders.some((f) => f.id === folderId && f.spaceId === spaceId) ? folderId : undefined
  const inBranch = new Set(moving.map((t) => t.id))
  const updated = moving.map((tab): TabItem => {
    const moved: TabItem = { ...tab, pinned, folderId: inFolder, anchorUrl: pinned ? (tab.anchorUrl ?? tab.url) : undefined }
    // The tabs that were the roots of what moves take the new parent; the ones below them keep theirs.
    if (!tree || (tab.parentId !== undefined && inBranch.has(tab.parentId))) return moved
    const { parentId: _old, ...bare } = moved
    return hung !== undefined ? { ...bare, parentId: hung } : bare
  })
  const leaving = new Set(moving.map((t) => t.id))
  const rest = state.tabs.filter((t) => !leaving.has(t.id))
  const group = rest.filter((t) => t.spaceId === spaceId && t.pinned === pinned && isListedTab(t))
  const pivot = group[Math.max(0, Math.min(Math.trunc(toIndex), group.length))]
  const insertAt = pivot ? rest.indexOf(pivot) : group.length > 0 ? rest.indexOf(group[group.length - 1]!) + 1 : rest.length
  return { ...state, tabs: [...rest.slice(0, insertAt), ...updated, ...rest.slice(insertAt)] }
}

/** The ids given and the other panes of their split views: a pane is as much on screen as the one that has the focus. */
/** The tabs other windows show, as an action carries them (`shownElsewhere`): text only, and a bounded number (the interface may send anything). */
export const SHOWN_ELSEWHERE_MAX = 2000
export function shownElsewhereOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, SHOWN_ELSEWHERE_MAX) : []
}

export function withSplitPanes(state: SidebarState, ids: Iterable<string | null | undefined>): Set<string> {
  const shown = new Set<string>()
  for (const id of ids) if (typeof id === 'string') shown.add(id)
  for (const split of state.splits) if (split.tabIds.some((id) => shown.has(id))) split.tabIds.forEach((id) => shown.add(id))
  return shown
}

export function groupOf(state: SidebarState, spaceId: string, pinned: boolean): TabItem[] {
  return state.tabs.filter((t) => t.spaceId === spaceId && t.pinned === pinned && isListedTab(t))
}

export function tidyIfEnabled(state: SidebarState, title: string, url: string): string {
  return state.settings.tidyPinnedTitles ? tidyTitle(title, url) : title
}

export function moveToGroup(state: SidebarState, id: string, pinned: boolean): SidebarState {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab || tab.pinned === pinned) return state
  const rest = state.tabs.filter((t) => t.id !== id)
  const moved: TabItem = { ...tab, pinned }
  if (pinned) {
    // Pinned tabs go to the end of the pinned list, before the first Today tab of the space.
    const lastPinned = groupOf({ ...state, tabs: rest }, tab.spaceId, true).at(-1)
    const at = lastPinned ? rest.indexOf(lastPinned) + 1 : rest.findIndex((t) => t.spaceId === tab.spaceId)
    const insertAt = at === -1 ? rest.length : at
    return { ...state, tabs: [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)] }
  }
  // Unpinned tabs become the first Today tab so they stay where the user just looked.
  const firstToday = groupOf({ ...state, tabs: rest }, tab.spaceId, false)[0]
  const insertAt = firstToday ? rest.indexOf(firstToday) : rest.length
  return { ...state, tabs: [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)] }
}
