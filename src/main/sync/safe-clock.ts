// The clock that measures the windows of the synchronisation (docs/synchronisation.md §4.1, §6.1, §9.3): no security rule rests on the time of day, and a change of
// the Mac's clock must not stretch a window that the person opened. Milliseconds elapsed since the clock was made, never going backwards, advancing at least as
// fast as the monotonic clock AND as the wall clock: a wall clock put back changes nothing (the monotonic one goes on), and a wall clock put forward, or a Mac that
// slept (the monotonic clock stops during sleep, the wall clock does not), closes a window early. Early is the safe side: the person opens it again.

export interface ClockSources {
  /** A monotonic millisecond clock (`performance.now`). */
  monotonic: () => number
  /** The time of day in milliseconds (`Date.now`). */
  wall: () => number
}

export const SYSTEM_SOURCES: ClockSources = { monotonic: () => performance.now(), wall: () => Date.now() }

export class SafeClock {
  private readonly startMonotonic: number
  private readonly startWall: number
  private last = 0

  constructor(private readonly sources: ClockSources = SYSTEM_SOURCES) {
    this.startMonotonic = sources.monotonic()
    this.startWall = sources.wall()
  }

  /** The milliseconds elapsed since the clock was made. */
  elapsed(): number {
    this.last = Math.max(this.last, this.sources.monotonic() - this.startMonotonic, this.sources.wall() - this.startWall)
    return this.last
  }
}
