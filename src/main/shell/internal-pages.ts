// The Extensions page in a tab, as one window of the application holds it (shell/browser.ts keeps one of these): which of its tabs are on the page and have a live page
// now, what the main process tells the gate about each web contents (internal-page-ipc.ts), the reduced snapshot sent to them as the state changes, and the console of the
// extensions, which is recorded for as long as such a page exists in the window and not otherwise.
//
// The page of a tab is made when the tab is shown and let go when it sleeps, closes, moves to another window or the window is gone: `reconcile` is called at each of those
// and puts the console watch where it belongs (started for a page that appeared, ended for one that went), so a window that shows no such page listens to nothing.

import { isInternalPageUrl } from '@shared/internal-page'
import { internalSnapshot, type InternalSnapshotSource } from '@shared/internal-snapshot'
import { InternalChannel } from '@shared/ipc'
import type { TabItem } from '@shared/model'
import type { InternalTabFacts } from './internal-page-ipc'

export interface InternalPagesDeps {
  /** The tabs this window lists. */
  tabs(): readonly Pick<TabItem, 'id' | 'url' | 'private' | 'container'>[]
  /** The tabs of this window that have a live page now. */
  livePageIds(): Iterable<string>
  /** A private or guest window: it has no extensions, so no page of this kind. */
  isPrivate(): boolean
  /** The number of the web contents of a live page (what the engine calls the tab number). */
  contentsIdOf(pageId: string): number | undefined
  /** Whether the web contents is in the session of a profile (a private context or a container is not). */
  inProfileSession(contentsId: number): boolean
  /** Sends a message to the document of the page of this tab, through the engine's page; false when the tab has no live page any more. */
  send(tabId: string, channel: string, payload: unknown): boolean
  /** Starts recording the console of the extensions; the function it returns ends it. */
  watchConsoles(): () => void
}

export class InternalPages {
  /** The console watch of each tab that has the page now (tab id → how to end it). */
  private readonly watching = new Map<string, () => void>()
  /** What each page was last sent (web contents → the snapshot as text): the same snapshot is not sent twice. */
  private readonly sent = new Map<number, string>()

  constructor(private readonly deps: InternalPagesDeps) {}

  /**
   * The tabs of this window that show the Extensions page with a live page: ordinary tabs of an ordinary window, never a private tab or a container's. Asked at
   * every publication of the window, so it reads the tabs once and costs nothing more than that while there is none.
   */
  private open(): Array<{ tabId: string; contentsId: number }> {
    if (this.deps.isPrivate()) return []
    const live = new Set(this.deps.livePageIds())
    if (live.size === 0) return []
    const found: Array<{ tabId: string; contentsId: number }> = []
    for (const tab of this.deps.tabs()) {
      if (!live.has(tab.id) || !isInternalPageUrl(tab.url) || tab.private === true || tab.container !== undefined) continue
      const contentsId = this.deps.contentsIdOf(tab.id)
      if (contentsId !== undefined) found.push({ tabId: tab.id, contentsId })
    }
    return found
  }

  /** The console is listened to for the tabs that have the page, and for no other. Idempotent. */
  reconcile(): void {
    const wanted = new Set(this.open().map((page) => page.tabId))
    for (const [tabId, stop] of this.watching) {
      if (wanted.has(tabId)) continue
      this.watching.delete(tabId)
      stop()
    }
    for (const tabId of wanted) if (!this.watching.has(tabId)) this.watching.set(tabId, this.deps.watchConsoles())
  }

  /** What the gate is told of a web contents of this window: its tab in the state, whatever address it is at now. Null for a web contents that is no live page of a tab here. */
  tabOf(contentsId: number): InternalTabFacts | null {
    const tabs = new Map(this.deps.tabs().map((tab) => [tab.id, tab]))
    for (const tabId of this.deps.livePageIds()) {
      if (this.deps.contentsIdOf(tabId) !== contentsId) continue
      const tab = tabs.get(tabId)
      if (!tab) return null
      return { url: tab.url, private: tab.private === true, container: tab.container !== undefined, profileSession: this.deps.inProfileSession(contentsId) }
    }
    return null
  }

  /** Sends the pages of this window the reduced snapshot of `source`, when it is not the one they have. Nothing at all when the window holds no such page. */
  publish(source: InternalSnapshotSource, locked: boolean): void {
    const pages = this.open()
    if (pages.length === 0) return void this.sent.clear()
    const snapshot = internalSnapshot(source, locked)
    const text = JSON.stringify(snapshot)
    const live = new Set<number>()
    for (const { tabId, contentsId } of pages) {
      live.add(contentsId)
      if (this.sent.get(contentsId) === text) continue
      if (!this.deps.send(tabId, InternalChannel.snapshot, snapshot)) continue
      this.sent.set(contentsId, text)
    }
    for (const contentsId of [...this.sent.keys()]) if (!live.has(contentsId)) this.sent.delete(contentsId)
  }

  /** The window is gone: no console is listened to any more. */
  dispose(): void {
    for (const stop of this.watching.values()) stop()
    this.watching.clear()
    this.sent.clear()
  }
}
