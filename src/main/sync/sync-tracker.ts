// The marks follow the state while the synchronisation is on (docs/synchronisation.md §9.2): when the state changes, the book of marks is brought up to it a moment
// later (300 ms, the delay of the write of the state), so that a field gets the mark of the gesture and not of the session that happens to carry it away. Off, nothing is
// subscribed and no timer runs: the tracker is started by the switch and stopped by it. Nothing it writes is the state: it writes the book (`sync-marks.json`).

import type { SidebarState } from '@shared/model'
import type { MarkBook } from './marks'
import { trackedViewOf } from './state-view'

export const TRACK_DELAY_MS = 300

export interface TrackerDeps {
  state: () => SidebarState
  subscribe: (listener: () => void) => () => void
  marks: MarkBook
  save: () => void
  now: () => number
  /** A timer the test can run by hand. */
  setTimer?: (run: () => void, ms: number) => NodeJS.Timeout
}

export class MarkTracker {
  private stop: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: TrackerDeps) {}

  running(): boolean {
    return this.stop !== null
  }

  /** Follows the state from now on, after one look at it as it is (what changed while the application was closed is marked now). */
  start(): void {
    if (this.stop !== null) return
    this.catchUp()
    this.stop = this.deps.subscribe(() => this.schedule())
  }

  /** Stops following: the subscription is let go and a look that was waiting does not happen. */
  halt(): void {
    this.stop?.()
    this.stop = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
      this.timer = null
      this.catchUp()
    }, TRACK_DELAY_MS)
    this.timer.unref?.()
  }

  /** The book is brought up to the state and written. A write that fails is told in the log and tried again at the next change: the marks are in memory meanwhile. */
  catchUp(): void {
    this.deps.marks.update(trackedViewOf(this.deps.state()), this.deps.now())
    try {
      this.deps.save()
    } catch (error) {
      console.error('[sync] the marks could not be written; they are kept in memory and written at the next change:', error)
    }
  }
}
