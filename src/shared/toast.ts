// The notices that offer something to do ("Annuler", "Rouvrir"), wherever they are drawn (the foot of the sidebar, the Settings, the panels of a list, the
// tab search, the task manager): one duration, and one rule of pause (WCAG 2.2.1: time to act). A notice stays eight seconds, and waits while the pointer
// or the focus is on it. A notice with nothing to press is read at a glance and keeps its own shorter time.

/** A notice with nothing to press. */
export const TOAST_PLAIN_MS = 5000
/** How long a notice with an action stays: the one duration of all of them, paused while the pointer or the focus is on it. */
export const ACTION_NOTICE_MS = 8000

/**
 * How long a notice stays: what the caller asked for, else the plain or the action duration. A notice with an action is never shorter than
 * ACTION_NOTICE_MS (a caller may keep one longer: an offer to install an update).
 */
export function toastDurationMs(hasAction: boolean, requested?: number): number {
  const asked = requested !== undefined && Number.isFinite(requested) && requested > 0 ? requested : null
  if (hasAction) return Math.max(asked ?? 0, ACTION_NOTICE_MS)
  return asked ?? TOAST_PLAIN_MS
}

/** The time a notice has left. It stops while the pointer or the focus holds the notice, and goes on with what it had left. */
export class ToastClock {
  private deadline = 0
  private left: number | null = null

  start(durationMs: number, now: number): void {
    this.deadline = now + durationMs
    this.left = null
  }

  /** Stops the clock; false when it was stopped already. */
  hold(now: number): boolean {
    if (this.left !== null) return false
    this.left = Math.max(0, this.deadline - now)
    return true
  }

  /** Goes on; answers the time left, or null when the clock was not held. */
  release(now: number): number | null {
    if (this.left === null) return null
    const left = this.left
    this.left = null
    this.deadline = now + left
    return left
  }
}

/**
 * Whether the pointer or the focus holds a notice. Each of the two is kept apart, so that the pointer leaving a notice that still has the focus does not
 * let it go. `set` answers the new state when it changed, null when it did not.
 */
export class NoticeHolds {
  private pointer = false
  private focus = false

  get held(): boolean {
    return this.pointer || this.focus
  }

  set(by: 'pointer' | 'focus', inside: boolean): boolean | null {
    const before = this.held
    if (by === 'pointer') this.pointer = inside
    else this.focus = inside
    return this.held === before ? null : this.held
  }
}

export interface NoticeTimers {
  set(run: () => void, ms: number): ReturnType<typeof setTimeout>
  clear(timer: ReturnType<typeof setTimeout>): void
  /** The clock the pause reads; the date of the machine when a caller gives none. */
  now?(): number
}

const REAL_TIMERS: NoticeTimers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) }

/**
 * The time of one notice outside the main process: `expire` runs once, `durationMs` after `start`, and the time stops while the notice is held (`hold`) and
 * goes on with what it had left (`release`). The same clock as the notices of the sidebar. A notice that expired or was cancelled ignores every call.
 */
export class NoticeTimer {
  private readonly clock = new ToastClock()
  private timer: ReturnType<typeof setTimeout> | null = null
  private over = false
  private readonly timers: NoticeTimers

  constructor(
    private readonly durationMs: number,
    private readonly expire: () => void,
    timers: NoticeTimers = REAL_TIMERS
  ) {
    this.timers = timers
  }

  private now(): number {
    return this.timers.now?.() ?? Date.now()
  }

  start(): this {
    this.clock.start(this.durationMs, this.now())
    this.timer = this.timers.set(this.fire, this.durationMs)
    return this
  }

  hold(): void {
    if (this.over || !this.clock.hold(this.now())) return
    this.stop()
  }

  release(): void {
    if (this.over) return
    const left = this.clock.release(this.now())
    if (left !== null) this.timer = this.timers.set(this.fire, left)
  }

  /** The notice went before its time (taken back, replaced, or its panel closed): nothing runs. */
  cancel(): void {
    this.over = true
    this.stop()
  }

  private readonly fire = (): void => {
    this.timer = null
    if (this.over) return
    this.over = true
    this.expire()
  }

  private stop(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
