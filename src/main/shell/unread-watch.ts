// The unread messages of the tabs of a window, as their titles say them. The rules are in shared/tab-messages.ts (what a title says, how long a silence is
// held); this is their wiring for one window: a memory per tab, and the one timer that takes a held badge away when the title stays silent.
// Nothing but the count or the mark is kept, never the title.

import { setBounded } from '@shared/bounded'
import { nextUnread, readUnread, type UnreadMemory, type UnreadReading } from '@shared/tab-messages'

/** The ceiling of the memories (the same as the other memories of the browser): a long session does not grow it. */
const MEMORY_MAX = 500

export interface UnreadWatchDeps {
  now(): number
  /** Whether someone is looking at the tab: it is on screen, in the window that is in front. */
  attended(id: string): boolean
  /** What the tab shows changed without a title (a held badge ran out): the window publishes it. */
  changed(id: string): void
}

export class UnreadWatch {
  private readonly memory = new Map<string, UnreadMemory>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: UnreadWatchDeps) {}

  /** What the tab shows now: the last reading it kept. */
  current(id: string): UnreadReading | undefined {
    return this.memory.get(id)?.reading
  }

  /** A title arrived from the page at `url`: the tab shows what it says, or keeps what it showed for a moment. */
  title(id: string, title: string, url: string): UnreadReading | undefined {
    this.settle(id, readUnread(title, url))
    return this.current(id)
  }

  /** The tab came on screen: a badge the site has already taken back (held) goes now, one the title still says stays. True when something went. */
  appeared(id: string): boolean {
    if (this.memory.get(id)?.held !== true) return false
    this.stop(id)
    this.memory.delete(id)
    return true
  }

  /** The page of the tab is gone (closed, asleep, moved to another window): nothing is remembered of it, and no timer runs for it. */
  forget(id: string): void {
    this.stop(id)
    this.memory.delete(id)
  }

  private settle(id: string, reading: UnreadReading | null): void {
    const step = nextUnread(this.memory.get(id), reading, this.deps.now(), this.deps.attended(id))
    this.stop(id)
    if (step.memory === undefined) this.memory.delete(id)
    else setBounded(this.memory, id, step.memory, MEMORY_MAX)
    if (step.recheckInMs === null) return
    // A title that stays silent is looked at again when the hold is over; each title that says something starts the hold again.
    const timer = setTimeout(() => {
      this.timers.delete(id)
      const before = this.current(id)
      if (before === undefined) return
      this.settle(id, null)
      if (this.current(id) !== before) this.deps.changed(id)
    }, step.recheckInMs)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  private stop(id: string): void {
    const timer = this.timers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(id)
  }
}
