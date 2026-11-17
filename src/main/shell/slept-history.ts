// The Back / Forward list of a tab whose page was let go for a sleep. A page that is destroyed takes its list with it, and the page made when the
// tab is shown again would start at the tab's address alone: the list is read just before the page goes, kept here, and given to the next page of
// the tab (Electron's `navigationHistory.restore`). In memory only, for as long as the application runs: nothing of it is written, so it adds no
// address to the state file, and a relaunch starts every tab at its address as before. Bounded like the list of a closed tab (closed-history.ts:
// web pages only, 20 at most), and forgotten with the history of the profile or of a site.

import type { ClosedHistory } from '@shared/model'
import { closedHistoryAfter, closedHistoryOf, type ClosedPagesScope } from '@shared/closed-history'
import { setBounded } from '@shared/bounded'

/** How many sleeping tabs keep a list; past it the tabs that fell asleep first lose theirs. */
export const SLEPT_HISTORY_MAX = 500

interface Kept {
  /** The session the page was in (`sessionKeyOf`): a tab that changed session since gets nothing back. */
  session: string
  url: string
  history: ClosedHistory
}

export class SleptHistory {
  private readonly kept = new Map<string, Kept>()

  /**
   * Keeps the list of the page of `tab`, read with `read` (the page is about to be destroyed). A page with fewer than two web pages, or one that
   * is not on the tab's address, has nothing to bring back; a page that cannot answer is logged and keeps nothing.
   */
  keep(tab: { id: string; url: string }, session: string, read: () => { entries: ReadonlyArray<{ url: string; title: string }>; index: number }): void {
    this.kept.delete(tab.id)
    let history: ClosedHistory | undefined
    try {
      const { entries, index } = read()
      history = closedHistoryOf(entries, index, tab.url)
    } catch (error) {
      console.warn(`[sleep] the pages of tab ${tab.id} could not be read; it will wake at its address alone:`, (error as Error).message)
      return
    }
    if (history) setBounded(this.kept, tab.id, { session, url: tab.url, history }, SLEPT_HISTORY_MAX)
  }

  /** The list the new page of `tab` goes back through, once: only while the tab is at the address and in the session it fell asleep with. */
  take(tab: { id: string; url: string }, session: string): ClosedHistory | undefined {
    const kept = this.kept.get(tab.id)
    if (!kept) return undefined
    this.kept.delete(tab.id)
    return kept.session === session && kept.url === tab.url ? kept.history : undefined
  }

  /** The tabs that are gone take their lists with them. */
  forget(live: ReadonlySet<string>): void {
    for (const id of [...this.kept.keys()]) if (!live.has(id)) this.kept.delete(id)
  }

  /** The history of a profile, or of one of its sites, is forgotten: the lists of its sleeping tabs go the same way as those of its closed tabs. */
  forgetPages(scope: ClosedPagesScope): void {
    for (const [id, kept] of [...this.kept]) {
      if (kept.session !== `profile:${scope.profileId}`) continue
      const after = closedHistoryAfter(kept.history, kept.url, scope.site)
      if (after === undefined) this.kept.delete(id)
      else if (after !== kept.history) this.kept.set(id, { ...kept, history: after })
    }
  }

  get size(): number {
    return this.kept.size
  }
}
