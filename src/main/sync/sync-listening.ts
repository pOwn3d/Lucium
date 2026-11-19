// The Mac's listening (docs/synchronisation.md §6.1, decided by the project lead on 19 November 2026: automatic synchronisation, which replaced the window of ten minutes
// of [Q5]). The Mac listens for as long as the synchronisation is switched on, Lucium is unlocked and an iPhone is paired (or a pairing is open: two minutes, §4.1). Whether it
// should is the service's decision (`SyncService.reconcileListening`); this class only holds the door: `open` starts the listener, `close` stops it and every connection with
// it, and nothing else does. There is no deadline here: what bounds the listening is its conditions, each of which closes it as soon as it stops holding.

export type ListeningCloseReason = 'switch-off' | 'locked' | 'no-device' | 'quit'

export interface ListeningState {
  open: boolean
}

/** What the listening starts and stops: the listener of listener.ts, or a stand-in in a test. */
export interface Door {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface SyncListeningDeps {
  door: Door
  /** Told at every change: opened, or closed (with why). */
  onChange?: (state: ListeningState, reason?: ListeningCloseReason) => void
}

export class SyncListening {
  private isOpen = false
  private opening: Promise<void> | null = null

  constructor(private readonly deps: SyncListeningDeps) {}

  state(): ListeningState {
    return { open: this.isOpen }
  }

  /** Opens the door; does nothing when it is open. Rejects when the door cannot open (the port, the identity): the listening stays closed. Two calls at once open it once, and both get the same answer. */
  async open(): Promise<void> {
    if (this.isOpen) return
    this.opening ??= this.start()
    await this.opening
  }

  private async start(): Promise<void> {
    try {
      await this.deps.door.start()
      this.isOpen = true
      this.deps.onChange?.(this.state())
    } finally {
      this.opening = null
    }
  }

  async close(reason: ListeningCloseReason): Promise<void> {
    // A close that arrives while the door is still opening waits for it: a listening cut in the middle of its opening must not come up afterwards.
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
    await this.deps.door.stop()
    this.deps.onChange?.(this.state(), reason)
  }
}
