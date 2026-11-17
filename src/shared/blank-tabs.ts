import type { TabItem } from './model'

/** What the shell knows about a tab beyond its stored fields (see shell/blank-tab-watch.ts, `closeUnused`). */
export interface BlankTabFacts {
  /** The tabs of the window: the last one is never closed. */
  tabCount: number
  /** The summary tab: it stays on about:blank while its text is written into it. */
  summary: boolean
  /** The tab the page's own window sharing took: it is never closed while it is shared. */
  shared: boolean
  /** The tab is on screen (or the sharing shows it): only a tab no one sees can go. */
  displayed: boolean
  /** An overlay (the command bar, a panel) is open: the user may be typing somewhere. */
  overlayOpen: boolean
  /** The tab was made by a page (window.open, a link without address): the page may write its title into it, which is not a use by the user. */
  fromPage?: boolean
}

/** Fields a user sets on a tab: a tab that carries one is kept, even empty. */
// The fields a user sets. `parentId` (the tree link) and `openerId` are not among them: a page's tab carries them (the tree of the tabs and Back link
// the page's tab to the one that opened it), so keeping on them would keep every tab a page made.
const KEPT_BY_FIELD: ReadonlyArray<keyof TabItem> = ['pinned', 'customTitle', 'icon', 'anchorUrl', 'keepAwake', 'autoReload', 'folderId', 'treeCollapsed', 'favoriteId']

/**
 * The tab to show when the window has to pick one in the space of a closed empty tab: the tab that was used before it in that space, while it
 * still exists there, else the most recently used tab of that space (`lastActiveAt`). Null when the space has no other tab.
 */
export function replacementAfterBlankClose(
  tabs: ReadonlyArray<Pick<TabItem, 'id' | 'spaceId' | 'lastActiveAt'>>,
  closed: Pick<TabItem, 'id' | 'spaceId'>,
  usedBefore: string | null,
  shownElsewhere: ReadonlySet<string> = new Set()
): string | null {
  // A tab that another window of Lucium shows is never the replacement: selecting it here takes it from that window (WindowView.dispatch), and the
  // popup of an extension then hangs from that other window (a click in the third window opened in the second).
  const sameSpace = tabs.filter((t) => t.spaceId === closed.spaceId && t.id !== closed.id && !shownElsewhere.has(t.id))
  if (usedBefore !== null && sameSpace.some((t) => t.id === usedBefore)) return usedBefore
  return [...sameSpace].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null
}

/**
 * Why an empty tab is kept, or null when it may close (the first rule that holds, in the order below). Traced by the browser ([blank-tab]).
 */
export function blankTabExclusion(tab: TabItem, facts: BlankTabFacts): string | null {
  if (tab.url !== 'about:blank') return 'address'
  // A title is a use of the tab, unless the page that made it wrote it (its script sets the title of the empty document it was given).
  if (!facts.fromPage && tab.title !== '' && tab.title !== 'about:blank') return 'title'
  const field = KEPT_BY_FIELD.find((name) => tab[name] !== undefined && tab[name] !== false)
  if (field !== undefined) return `field:${String(field)}`
  if (facts.summary) return 'summary'
  // Only a tab that is shown while its window is shared is kept (`shared` already says both). A tab on screen that no sharing shows is not kept:
  // the window goes to the last tab used in its space (shell/blank-tab-watch.ts, closeUnused).
  if (facts.shared) return 'shared'
  if (facts.overlayOpen) return 'overlay'
  if (facts.tabCount < 2) return 'last-tab'
  return null
}

/** Why an empty tab a page opened goes: its opener finished loading, was left by the user, or was closed. */
export type OpenedBlankReason = 'parent chargé' | 'parent quitté' | 'parent fermé'

/**
 * The empty tabs a page opened (`openers`: empty tab id -> the tab that opened it) that go now, with the reason: the opener has just finished
 * loading (`loaded`: its id, once per load), it was left by the user (it was on screen and now is not), or it is gone. A child that is gone is not
 * in the answer. An empty tab is not closed at its creation: a popup that loads next would be cut.
 */
export function openedBlankTabsToClose(
  openers: ReadonlyMap<string, string>,
  tabIds: ReadonlySet<string>,
  previous: string | null,
  shown: string | null,
  loaded: string | null = null
): Array<{ id: string; reason: OpenedBlankReason }> {
  const out: Array<{ id: string; reason: OpenedBlankReason }> = []
  for (const [child, parent] of openers) {
    if (!tabIds.has(child)) continue
    if (!tabIds.has(parent)) out.push({ id: child, reason: 'parent fermé' })
    else if (loaded === parent) out.push({ id: child, reason: 'parent chargé' })
    else if (previous === parent && shown !== parent) out.push({ id: child, reason: 'parent quitté' })
  }
  return out
}
