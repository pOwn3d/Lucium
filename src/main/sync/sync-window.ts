// The synchronisation window (docs/synchronisation.md §6.1, [Q5]): the only time the Mac listens. The person opens it by hand (« Ouvrir la synchronisation », or
// « Ajouter un iPhone »), and it closes by itself after ten minutes, when the page of the Settings is left, when the switch is cut, when Lucium locks, or when the
// person closes it. Outside a window no port is open: `close` stops the listener and every connection with it.
//
// The ten minutes are counted by the safe clock (safe-clock.ts), not by a timer alone: a timer stops with the Mac's sleep, and a clock put back must not stretch the
// window. « Prolonger » starts the ten minutes again. The window is the owner of the listener's life: `open` starts it, `close` stops it, and nothing else does.

import { WINDOW_MAX_MS } from './limits'

export type WindowCloseReason = 'timeout' | 'manual' | 'page-closed' | 'switch-off' | 'locked' | 'error'

export interface WindowState {
  open: boolean
  /** The milliseconds left before the window closes by itself (0 when it is closed). */
  remainingMs: number
}

/** What the window starts and stops: the listener of listener.ts, or a stand-in in a test. */
export interface Door {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface SyncWindowDeps {
  door: Door
  /** Elapsed milliseconds (a `SafeClock`'s `elapsed`). */
  elapsed: () => number
  /** Told at every change: opened, prolonged, closed (with why), and once a second while open is not needed: the page asks `state()`. */
  onChange?: (state: WindowState, reason?: WindowCloseReason) => void
  maxMs?: number
  /** How often the deadline is looked at, at most. */
  tickMs?: number
}

export class SyncWindow {
  private isOpen = false
  private deadline = 0
  private timer: NodeJS.Timeout | null = null
  private opening: Promise<void> | null = null
  private readonly maxMs: number
  private readonly tickMs: number

  constructor(private readonly deps: SyncWindowDeps) {
    this.maxMs = deps.maxMs ?? WINDOW_MAX_MS
    this.tickMs = deps.tickMs ?? 1000
  }

  state(): WindowState {
    return { open: this.isOpen, remainingMs: this.isOpen ? Math.max(0, this.deadline - this.deps.elapsed()) : 0 }
  }

  /**
   * Opens the window for the whole of its time (or prolongs it when it is open). Rejects when the door cannot open (the port, the identity): the window stays
   * closed. Two calls at once open it once, and both get the same answer.
   */
  async open(): Promise<void> {
    if (this.isOpen) return this.prolong()
    this.opening ??= this.start()
    await this.opening
  }

  private async start(): Promise<void> {
    try {
      await this.deps.door.start()
      this.isOpen = true
      this.deadline = this.deps.elapsed() + this.maxMs
      this.schedule()
      this.deps.onChange?.(this.state())
    } finally {
      this.opening = null
    }
  }

  /** « Prolonger »: ten minutes again from now. Nothing happens when the window is closed (a closed window is not brought back by a late click). */
  prolong(): void {
    if (!this.isOpen) return
    this.deadline = this.deps.elapsed() + this.maxMs
    this.deps.onChange?.(this.state())
  }

  async close(reason: WindowCloseReason): Promise<void> {
    // A close that arrives while the door is still opening waits for it: a window cut in the middle of its opening must not come up afterwards.
    if (this.opening !== null) {
      try {
        await this.opening
      } catch {
        // The door never opened, and the caller of `open` has the error: there is nothing to close.
        return
      }
    }
    if (!this.isOpen) return
    this.isOpen = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    await this.deps.door.stop()
    this.deps.onChange?.(this.state(), reason)
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.isOpen) return
      if (this.deps.elapsed() >= this.deadline) void this.close('timeout').catch((error: unknown) => console.error('[sync] the window could not be closed at its end:', error))
      else this.schedule()
    }, Math.max(1, Math.min(this.tickMs, this.deadline - this.deps.elapsed())))
    this.timer.unref()
  }
}
