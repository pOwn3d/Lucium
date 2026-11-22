// The lock of one private window (shared/private-lock.ts holds the rules): the timer that looks at the window while the delay of the setting runs, and the state of the
// window. Nothing is made, listened to or timed while the setting is « never » or the lock is off: `follow` makes no timer then, and a locked window needs none (only the phrase opens it).
// The timer looks every `LOOK_MS`, never faster: a private window left alone locks within that much after the delay.

import { afterLook, freshPrivateLock, idleLockDue, locked, unlocked, type PrivateLockState } from '@shared/private-lock'

/** How often a window with a delay is looked at. */
export const LOOK_MS = 15_000

/** What the lock of a window needs of the application; a test gives its own. */
export interface PrivateLockHost {
  /** The setting `lockPrivateIdle`, in minutes (0: never). */
  minutes(): number
  /** The lock of the application is on and a phrase exists: without one, nothing could open the window again. */
  lockActive(): boolean
  /** The window has the keyboard focus. */
  focused(): boolean
  /** When the last click or key was anywhere in the application (engine.lastUserInput). */
  lastInputAt(): number
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  /** The window locked or was unlocked: the window shows the lock screen, drops its pages and publishes. */
  changed(): void
  log(line: string): void
}

export class PrivateWindowLock {
  private state: PrivateLockState
  private timer: unknown = null

  constructor(private readonly host: PrivateLockHost) {
    this.state = freshPrivateLock(host.now())
  }

  /** Whether the window is covered by its lock. */
  isLocked(): boolean {
    return this.state.locked
  }

  /** After a change of the settings or of the lock (and at the start): arms the timer while a delay is set and the window is open, and lets go of it otherwise. */
  follow(): void {
    // A window locked while the lock of the application is removed has nothing left to ask for: it opens, rather than staying shut for good.
    if (this.state.locked && !this.host.lockActive()) return this.unlock()
    const wanted = !this.state.locked && this.host.minutes() > 0 && this.host.lockActive()
    if (!wanted) return this.release()
    if (this.timer === null) this.timer = this.host.setTimer(() => this.look(), LOOK_MS)
  }

  /** The window got the focus: coming back to it is a visit. */
  focused(): void {
    if (this.state.locked) return
    this.state = afterLook(this.state, { now: this.host.now(), focused: true, lastInputAt: this.state.lastActiveAt }, true)
  }

  private look(): void {
    this.timer = null
    if (this.state.locked) return
    const now = this.host.now()
    this.state = afterLook(this.state, { now, focused: this.host.focused(), lastInputAt: this.host.lastInputAt() })
    if (idleLockDue(this.state, this.host.minutes(), now, this.host.lockActive())) {
      this.state = locked(this.state)
      this.host.log('[lock] a private window was left alone for the delay and is locked')
      this.host.changed()
      return
    }
    this.follow()
  }

  /** The phrase or Touch ID was right: the window opens, and the delay starts again. */
  unlock(): void {
    if (!this.state.locked) return
    this.state = unlocked(this.host.now())
    this.host.changed()
    this.follow()
  }

  /** Locks the window now (the lock of the application was asked for, a test). No effect without a lock to open it with. */
  lockNow(): void {
    if (this.state.locked || !this.host.lockActive()) return
    this.state = locked(this.state)
    this.release()
    this.host.changed()
  }

  /** The window is closed: nothing of it stays armed. */
  dispose(): void {
    this.release()
  }

  private release(): void {
    if (this.timer === null) return
    this.host.clearTimer(this.timer)
    this.timer = null
  }
}
