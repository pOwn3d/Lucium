// Who gets the pages of a reopened tab. Reopening an archive entry (⇧⌘T, the archive panel) opens a tab; its page is made while the state is being
// applied, or later when the tab is in the background, and must then go back through the pages the entry kept (closed-history.ts) instead of
// loading its address alone. The reopening is told to the ledger before the state changes and ended after; a page asks the ledger what it
// owes its tab. A dispatch made *inside* the state change (the shell dispatches from its own listeners) must not end a reopening it did not begin.

import type { ClosedHistory } from '@shared/model'

export interface ReopenedEntry {
  url: string
  history: ClosedHistory
}

/** What `begin` hands back; only the call that got it ends it. */
export interface Reopening {
  before: ReadonlySet<string>
  entries: ReopenedEntry[]
}

export class ReopenLedger {
  private current: Reopening | null = null
  /** Tabs made by a reopening whose page does not exist yet (a tab opened in the background): their pages wait here. */
  private readonly waiting = new Map<string, ClosedHistory>()

  /** Starts a reopening of `entries` (the tabs that exist now are not its tabs). Null, and nothing started, when there is no entry. */
  begin(before: Iterable<string>, entries: readonly ReopenedEntry[]): Reopening | null {
    if (entries.length === 0) return null
    this.current = { before: new Set(before), entries: [...entries] }
    return this.current
  }

  /**
   * Ends `reopening`. The entries no page took (their tabs are in the background) are given to the new tabs that have the same address and no
   * page yet (`fresh`), to wait for it. A call that did not begin the reopening ends nothing.
   */
  end(reopening: Reopening | null, fresh: () => ReadonlyArray<{ id: string; url: string }>): void {
    if (reopening === null) return
    if (this.current === reopening) this.current = null
    if (reopening.entries.length === 0) return
    const tabs = fresh().filter((tab) => !reopening.before.has(tab.id))
    for (const entry of reopening.entries.splice(0)) {
      const tab = tabs.find((t) => t.url === entry.url && !this.waiting.has(t.id))
      if (tab) this.waiting.set(tab.id, entry.history)
    }
  }

  /** The pages `tab` goes back through when its page is made, if it is a reopened one; they are not offered twice. */
  take(tab: { id: string; url: string }): ClosedHistory | undefined {
    const waiting = this.waiting.get(tab.id)
    if (waiting) {
      this.waiting.delete(tab.id)
      return waiting
    }
    const reopening = this.current
    if (!reopening || reopening.before.has(tab.id)) return undefined
    const at = reopening.entries.findIndex((entry) => entry.url === tab.url)
    return at === -1 ? undefined : reopening.entries.splice(at, 1)[0]!.history
  }

  /** The tabs that are gone take what waited for them. */
  forget(live: ReadonlySet<string>): void {
    for (const id of this.waiting.keys()) if (!live.has(id)) this.waiting.delete(id)
  }
}
