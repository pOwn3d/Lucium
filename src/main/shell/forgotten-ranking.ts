// What the command bar's ranking held for a page that was just forgotten with a way back (⇧⌫ in the bar, then « Annuler »): how often it was
// picked, per profile. Kept in memory only and for as long as the history keeps the page itself aside (history.ts, `removeKept`): the state file
// loses the address at once, and the count is dropped for good when the time is up.

import { FORGOTTEN_KEPT_MAX, FORGOTTEN_KEPT_MS } from '../history'

interface Kept {
  count: number
  until: number
  clock: ReturnType<typeof setTimeout>
}

const keyOf = (profileId: string, url: string): string => `${profileId}\n${url}`

export class ForgottenRanking {
  private readonly kept = new Map<string, Kept>()

  /** Keeps the count of a page aside; a count that is not one keeps nothing (and drops what was kept for the page). */
  keep(profileId: string, url: string, count: number, now = Date.now()): void {
    const key = keyOf(profileId, url)
    this.dropKey(key)
    if (!Number.isSafeInteger(count) || count < 1) return
    const clock = setTimeout(() => this.dropKey(key), FORGOTTEN_KEPT_MS)
    // A count that waits must not keep the application from quitting.
    clock.unref()
    this.kept.set(key, { count, until: now + FORGOTTEN_KEPT_MS, clock })
    if (this.kept.size > FORGOTTEN_KEPT_MAX) this.dropKey(this.kept.keys().next().value!)
  }

  /** The count kept for a page, which is then no longer kept: 0 when there is none, or when its time is up. */
  take(profileId: string, url: string, now = Date.now()): number {
    const key = keyOf(profileId, url)
    const found = this.kept.get(key)
    if (!found) return 0
    this.dropKey(key)
    return now > found.until ? 0 : found.count
  }

  /** Drops what is kept for one page: it was forgotten for good. */
  drop(profileId: string, url: string): void {
    this.dropKey(keyOf(profileId, url))
  }

  /** How many counts wait. */
  size(): number {
    return this.kept.size
  }

  private dropKey(key: string): void {
    const found = this.kept.get(key)
    if (!found) return
    clearTimeout(found.clock)
    this.kept.delete(key)
  }
}

/** One for the application: the history of a profile is shared by every window, and so is what was just forgotten of its ranking. */
export const forgottenRanking = new ForgottenRanking()
