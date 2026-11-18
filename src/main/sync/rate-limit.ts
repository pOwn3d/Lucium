// The limit of attempts per address (docs/synchronisation.md §6.1): from one address, `FAILURES_PER_MINUTE_BEFORE_REFUSAL` refused connections in a minute close
// the door on that address for a minute. The table holds at most `MAX_TRACKED_ADDRESSES` addresses, the oldest going first, so that a scan from thousands of
// addresses cannot grow it. The time is read from the clock handed in (elapsed milliseconds, safe-clock.ts).

import { FAILURES_PER_MINUTE_BEFORE_REFUSAL, FAILURE_WINDOW_MS, MAX_TRACKED_ADDRESSES, REFUSAL_MS } from './limits'

interface Entry {
  failures: number[]
  refusedUntil: number
}

export class AddressLimiter {
  /** Insertion order is the order of last use: the first key is the oldest. */
  private readonly table = new Map<string, Entry>()

  constructor(private readonly now: () => number) {}

  /** Whether connections from this address are being refused now. */
  isRefused(address: string): boolean {
    const entry = this.table.get(address)
    return entry !== undefined && this.now() < entry.refusedUntil
  }

  /** A connection from this address failed (not paired, a wrong proof, a bad frame, a handshake that never came): the tenth in a minute closes the door. */
  recordFailure(address: string): void {
    const now = this.now()
    const entry = this.table.get(address) ?? { failures: [], refusedUntil: 0 }
    this.table.delete(address)
    entry.failures = [...entry.failures.filter((at) => now - at < FAILURE_WINDOW_MS), now]
    if (entry.failures.length >= FAILURES_PER_MINUTE_BEFORE_REFUSAL) {
      // The failures that led here are not forgotten by hand: the refusal lasts as long as the window that counts them, so none is left when it ends.
      entry.refusedUntil = now + REFUSAL_MS
    }
    this.table.set(address, entry)
    for (const oldest of this.table.keys()) {
      if (this.table.size <= MAX_TRACKED_ADDRESSES) break
      this.table.delete(oldest)
    }
  }

  /** The number of addresses the table holds (a test reads it to see the bound). */
  size(): number {
    return this.table.size
  }
}
