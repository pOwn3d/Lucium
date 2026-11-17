// The empty tabs (about:blank) of a window: the ones the user opened (⌘T, the command bar's new tab) and the ones a page opened, closed once they are
// left unused. The rules are in shared/blank-tabs.ts; this is their wiring for one window (browser.ts hands in what it knows of the window). Every step
// of the decision is traced ([blank-tab]), with the host only: a query can carry a token, and a page can write its own title.

import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import { blankTabExclusion, openedBlankTabsToClose, replacementAfterBlankClose, type OpenedBlankReason } from '@shared/blank-tabs'
import { setBounded } from '@shared/bounded'
import { logOrigin } from '@shared/url'

/** The ceiling of the reasons kept for unmarked tabs (the same as the other memories of the browser): a long session does not grow it. */
const MEMORY_MAX = 500

/** What the watch needs of its window. */
export interface BlankTabWatchDeps {
  /** The state of the window, as it is now. */
  store: { get(): SidebarState }
  /** Applies an action of the shell to the state of the window. */
  dispatch(action: Action): void
  /** Whether the tab is on screen in this window (the active tab, or a pane of its split view). */
  displayed(id: string): boolean
  /** Whether an overlay (the command bar, a panel) is open in this window: the user may be typing somewhere. */
  overlayOpen(): boolean
  /** Whether the tab is a summary tab: it stays on about:blank while its text is written into it. */
  isSummary(id: string): boolean
  /** The tabs the other windows of Lucium show: they are never the replacement of a closed empty tab. */
  shownElsewhere(): ReadonlySet<string>
}

export class BlankTabWatch {
  /** Empty tabs the user opened (⌘T, the command bar's new tab) and that never navigated: closed once left unused (shared/blank-tabs.ts). */
  private readonly userBlankTabs = new Set<string>()
  /** The tab that was shown before each tab, per space: where the window goes when an empty tab of that space closes. */
  private readonly usedBefore = new Map<string, string>()
  /** The empty tabs a page opened (about:blank): empty tab id -> the tab that opened it. They go when that tab is left or closed. */
  private readonly openerOfBlank = new Map<string, string>()
  /** The empty tabs a page made (not the user): their title may be written by the page. */
  private readonly pageBlankTabs = new Set<string>()
  /** Why an empty tab was unmarked (an address, a close, a gone tab): traced when a later decision finds it unmarked. */
  private readonly unmarked = new Map<string, string>()
  /** The tab the page's own window sharing took (shell/page-annotate.ts): not closed while shared. */
  private sharedTabId: string | null = null
  private readonly store: BlankTabWatchDeps['store']

  constructor(private readonly deps: BlankTabWatchDeps) {
    this.store = deps.store
  }

  /** Runs an action of the interface (`apply`). An empty tab it opened (⌘T, the command bar) is closed once left unused (see `watch`). */
  applyFromInterface(action: Action, apply: () => void): void {
    const tabsBefore = new Set(this.store.get().tabs.map((t) => t.id))
    apply()
    if (action.type === 'tab/open' && action.url === 'about:blank') {
      for (const t of this.store.get().tabs) if (!tabsBefore.has(t.id)) {
        this.userBlankTabs.add(t.id)
        console.info(`[blank-tab] created: tab ${t.id} (interface, space ${t.spaceId})`)
      }
    }
  }

  /**
   * Runs the opening of a tab for a link of the tab `openerId` (`open`). An empty tab a page opened (about:blank, `byPage`) is an empty tab, and it
   * remembers the tab that opened it: it goes when its opener is left, closed or loaded (see `watch`, `closeOpenedBy`), if it is still empty and unused.
   * The tab is the one whose id was not there before (the list is not assumed to grow at the end).
   */
  applyFromTab(openerId: string, url: string, byPage: boolean, open: () => void): void {
    const before = new Set(this.store.get().tabs.map((item) => item.id))
    open()
    if (url === 'about:blank') {
      const created = this.store.get().tabs.find((item) => !before.has(item.id) && item.url === 'about:blank')
      if (created) {
        this.userBlankTabs.add(created.id)
        if (byPage) {
          this.openerOfBlank.set(created.id, openerId)
          this.pageBlankTabs.add(created.id)
          // A page's empty tab goes at once, if it is still empty and unused (the risk for a popup is accepted). Next tick: the state of
          // the tab is settled first. An address (a popup that loads) or a field keeps it (the closing checks).
          console.info(`[blank-tab] closing scheduled: tab ${created.id} (création, vide), opened by tab ${openerId}`)
          setTimeout(() => this.closeUnused(created.id, 'création, vide'), 0).unref()
        }
      }
    }
  }

  /** The page's own window sharing took this tab: it is not closed while it is shared and on screen. */
  markShared(tabId: string): void {
    this.sharedTabId = tabId
  }

  /**
   * After a sync of the window: an empty tab the user opened is closed at once when the user leaves it for another tab. No timer: an empty tab that is
   * left goes. The tabs that are gone are forgotten here.
   */
  watch(previous: string | null, shown: string | null): void {
    const state = this.store.get()
    for (const id of [...this.userBlankTabs]) if (!state.tabs.some((t) => t.id === id)) this.forget(id, 'tab gone')
    if (previous !== null && shown !== null && previous !== shown) {
      const space = state.tabs.find((t) => t.id === shown)?.spaceId
      if (space !== undefined) this.usedBefore.set(space, previous)
    }
    if (previous !== null && previous !== shown && this.userBlankTabs.has(previous)) {
      setTimeout(() => this.closeUnused(previous, 'left'), 0).unref()
    }
    // An empty tab a page opened goes when the tab that opened it is left (or closed), if it is still empty and unused.
    const ids = new Set(state.tabs.map((t) => t.id))
    for (const { id, reason } of openedBlankTabsToClose(this.openerOfBlank, ids, previous, shown)) {
      if (reason === 'parent fermé') this.openerOfBlank.delete(id)
      setTimeout(() => this.closeUnused(id, reason), 0).unref()
    }
    for (const id of [...this.openerOfBlank.keys()]) if (!ids.has(id)) this.openerOfBlank.delete(id)
  }

  /** The empty tabs a page opened, from the page that has just finished loading (`loadedId`): they go now, if still empty and unused. */
  closeOpenedBy(loadedId: string): void {
    const ids = new Set(this.store.get().tabs.map((t) => t.id))
    for (const { id, reason } of openedBlankTabsToClose(this.openerOfBlank, ids, null, null, loadedId)) {
      setTimeout(() => this.closeUnused(id, reason), 0).unref()
    }
  }

  /** The page of the tab committed an address. Any address but the blank one makes the tab a used one: it is never closed as an empty tab. */
  addressCommitted(id: string, url: string): void {
    if (url !== 'about:blank') this.forget(id, `address committed: ${url}`)
  }

  /** The page of the tab is gone: the reason of an empty tab that was unmarked is traced only while the tab exists. */
  dropTraceIfGone(id: string): void {
    if (!this.store.get().tabs.some((t) => t.id === id)) this.unmarked.delete(id)
  }

  /**
   * Closes an empty tab the user opened, if the rules still allow it (shared/blank-tabs.ts). When it was the tab its space had selected, the window
   * goes to the tab used before it in that space (or the most recently used one there), not to a neighbour in the list.
   */
  private closeUnused(id: string, reason: 'left' | 'création, vide' | OpenedBlankReason = 'left'): void {
    const state = this.store.get()
    const tab = state.tabs.find((t) => t.id === id)
    // Every step of the decision is traced: a tab that stays must say which step kept it.
    if (!tab) {
      console.info(`[blank-tab] not closed: tab ${id} (${reason}): the tab no longer exists`)
      return this.forget(id, 'tab gone')
    }
    if (!this.userBlankTabs.has(id)) {
      // The address and the title are not traced: a query can carry a token, and a page can write its own title. The host is enough.
      console.info(`[blank-tab] not closed: tab ${id} (${reason}): no longer marked as an empty tab (${this.unmarked.get(id) ?? 'never marked'}); host=${logOrigin(tab.url)}`)
      return
    }
    const displayed = this.deps.displayed(id)
    // The sharing of this tab excludes it while it is on screen only: Electron does not say when a sharing ends, and a tab that no one sees
    // any more is not in the picture (its exclusion would otherwise last until it is closed).
    const facts = { tabCount: state.tabs.length, summary: this.deps.isSummary(id), shared: displayed && this.sharedTabId === id, displayed, overlayOpen: this.deps.overlayOpen(), fromPage: this.pageBlankTabs.has(id) }
    console.info(`[blank-tab] deciding: tab ${id} (${reason}): host=${logOrigin(tab.url)} displayed=${facts.displayed} shared=${facts.shared} summary=${facts.summary} overlay=${facts.overlayOpen} tabs=${facts.tabCount} made-by-page=${facts.fromPage}`)
    const exclusion = blankTabExclusion(tab, facts)
    if (exclusion !== null) {
      console.info(`[blank-tab] kept: tab ${id} (${reason}) is not closed: ${exclusion}`)
      return
    }
    const wasSelected = state.activeTabBySpace[tab.spaceId] === id
    this.forget(id, 'closed')
    console.info(`[blank-tab] closed: tab ${id} (${reason}, ${state.tabs.length} tabs, space ${tab.spaceId})`)
    this.deps.dispatch({ type: 'tab/close', id })
    if (wasSelected) {
      // The tabs the other windows show are not candidates: a tab on screen elsewhere would be taken from its window (see replacementAfterBlankClose).
      const replacement = replacementAfterBlankClose(this.store.get().tabs, tab, this.usedBefore.get(tab.spaceId) ?? null, this.deps.shownElsewhere())
      if (replacement !== null) this.deps.dispatch({ type: 'tab/select', id: replacement })
    }
  }

  /** The tab is used (it has an address, or it was closed): it is no longer an empty tab the shell may close. */
  private forget(id: string, why: string): void {
    if (this.userBlankTabs.has(id)) {
      setBounded(this.unmarked, id, why, MEMORY_MAX)
      console.info(`[blank-tab] unmarked: tab ${id} (${why})`)
    }
    this.userBlankTabs.delete(id)
    this.openerOfBlank.delete(id)
    this.pageBlankTabs.delete(id)
    if (this.sharedTabId === id) this.sharedTabId = null
  }
}
