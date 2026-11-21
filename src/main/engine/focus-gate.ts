// What the error pages of the engine need of the focus mode (shared/focus-mode.ts), which the shell owns: whether an address is closed by it
// right now, and the way out of the block page. Set once by the shell while the feature is on; absent, nothing is blocked and the page of a
// refused load is the ordinary one.

export interface FocusBlockInfo {
  /** When the timer ends (ms since the epoch), or null when a weekly slot is what blocks. */
  until: number | null
  /** The minute of the day the slot ends, or null when a timer is what blocks. */
  slotEnd: number | null
}

export interface FocusGate {
  /** The focus block that holds for this address now, or null. */
  block(url: string): FocusBlockInfo | null
  /** « Faire une pause » on the block page: focus is paused for a while. */
  pause(): void
}

let current: FocusGate | null = null

export const focusGate = {
  set(gate: FocusGate | null): void {
    current = gate
  },
  get(): FocusGate | null {
    return current
  }
}
