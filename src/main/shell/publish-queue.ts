// The window's state goes to the interface in one message per turn of the event loop, not one per change: a page that updates its title
// makes the store publish, then the page handler publish again with the runtime state it has just changed, and a download reports four
// times a second. Everything requested in the same turn is sent once, with the state as it is at the end of the turn. What a page in the
// background changes (its title, its icon, its loading) waits a little longer (`soon`), so that a burst of such events is sent once.

/** How long what a page in the background changed may wait for the next publication. */
export const PUBLISH_SOON_MS = 200

export class PublishQueue {
  private pending = false
  private soonTimer: ReturnType<typeof setTimeout> | null = null
  private sentCount = 0
  private requestedCount = 0

  constructor(
    private readonly send: () => void,
    /** Where the deferred send runs: the end of the current turn (a microtask), so that it goes out before anything else in the event loop. */
    private readonly defer: (task: () => void) => void = (task) => queueMicrotask(task)
  ) {}

  /** How many times `send` ran, and how many publications were asked for (the difference is the work saved). */
  get stats(): { sent: number; requested: number } {
    return { sent: this.sentCount, requested: this.requestedCount }
  }

  /** Asks for a publication; many asks in one turn make one. */
  request(): void {
    this.requestedCount++
    if (this.pending) return
    this.pending = true
    this.defer(() => this.flush())
  }

  /**
   * Asks for a publication within `PUBLISH_SOON_MS`: for what a page in the background changed. Any publication before that (the user acts, the
   * page on screen changes) carries it, since a publication sends the whole state as it is.
   */
  soon(): void {
    this.requestedCount++
    if (this.pending || this.soonTimer) return
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null
      this.run()
    }, PUBLISH_SOON_MS)
  }

  /** Sends now what is waiting, if anything: for a message that must reach the interface after the state it was sent with. */
  flush(): void {
    if (!this.pending && !this.soonTimer) return
    this.pending = false
    this.run()
  }

  /** Sends now whether or not something waited, and forgets what waited (it is part of this send). */
  now(): void {
    this.pending = false
    this.run()
  }

  /** The window is going away: what waited is not sent. */
  cancel(): void {
    this.pending = false
    this.stopSoon()
  }

  private stopSoon(): void {
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.soonTimer = null
  }

  private run(): void {
    // This send carries what waited for a later one.
    this.stopSoon()
    this.sentCount++
    try {
      this.send()
    } catch (error) {
      // From a microtask nobody could catch it, and one failed publication must not stop the next ones.
      console.error('[publish] cannot send the state to the interface:', error)
    }
  }
}
