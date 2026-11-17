// The links other applications send while Lucium cannot open them yet: before its window exists, and while it is locked. They wait, and
// open once it can. Any program of the machine may send as many as it likes: without a ceiling they would fill the memory while the user is
// away, then open all at once as so many tabs or mini windows at the unlocking.

import { TAB_URL_MAX } from './state-clean'

/** How many links wait at most. A person clicks a handful of links in other applications while the browser starts or is locked. */
export const WAITING_LINKS_MAX = 20

/**
 * The links that wait, in the order they came. The first ones are kept: they are what the user asked for before anything flooded the queue.
 * A link longer than a tab's address may be, and every link past the ceiling, is counted and dropped, and `take` says how many were.
 */
export class WaitingLinks {
  private links: string[] = []
  private dropped = 0

  constructor(initial: readonly string[] = []) {
    for (const url of initial) this.add(url)
  }

  /** False when the link was dropped. */
  add(url: string): boolean {
    if (typeof url !== 'string' || url.length > TAB_URL_MAX || this.links.length >= WAITING_LINKS_MAX) {
      this.dropped++
      return false
    }
    this.links.push(url)
    return true
  }

  /** The links to open now, and how many were dropped since the last time; the queue is empty afterwards. */
  take(): { links: string[]; dropped: number } {
    const taken = { links: this.links, dropped: this.dropped }
    this.links = []
    this.dropped = 0
    return taken
  }

  get size(): number {
    return this.links.length
  }
}
