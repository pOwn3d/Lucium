// The life of the pairing secret (docs/synchronisation.md §4.5). One secret per « Ajouter un iPhone »: it opens when the QR is made and is never used twice.
//
//   open      from the QR to one of the cases below
//   used      the first RIGHT proof, whatever becomes of the request afterwards (the person may refuse)   → pairing-used
//   expired   120 000 ms went by (« less than 120 000 » is still open)                                       → pairing-expired
//   locked    five wrong proofs                                                                              → pairing-locked
//   closed    the sheet was closed, the switch cut, or the Mac locked                                        → pairing-closed
//
// The order of the checks is closed, locked, expired, used, and only then the proof. A wrong proof does not burn the secret (a neighbour must not be able to stop
// a pairing by knocking), but five lock it. The time is read from a monotonic clock handed in: a change of the Mac's clock must not stretch the window.

import { MAX_INVALID_PROOFS, PAIRING_WINDOW_MS } from './limits'

export type PairingAnswer = 'accepted' | 'bad-proof' | 'pairing-expired' | 'pairing-used' | 'pairing-locked' | 'pairing-closed'

export class PairingSecret {
  private used = false
  private closed = false
  private invalid = 0
  private readonly openedAt: number

  /** `clock` is a monotonic millisecond clock (the caller's `performance.now()`); the window runs from the moment the secret is made. */
  constructor(readonly secret: Buffer, private readonly clock: () => number) {
    this.openedAt = clock()
  }

  /** The milliseconds left before the window ends (0 once it has). */
  remainingMs(): number {
    return Math.max(0, PAIRING_WINDOW_MS - (this.clock() - this.openedAt))
  }

  /** The sheet is closed, the switch is cut or the Mac is locked: nothing is accepted any more, whatever else is true. */
  close(): void {
    this.closed = true
  }

  /**
   * A request arrives. `proofIsRight` is asked only when the state allows the proof to count, so a closed, locked, expired or used secret never spends the
   * work of an HMAC on a request it has already refused.
   */
  attempt(proofIsRight: () => boolean): PairingAnswer {
    if (this.closed) return 'pairing-closed'
    if (this.invalid >= MAX_INVALID_PROOFS) return 'pairing-locked'
    if (this.clock() - this.openedAt >= PAIRING_WINDOW_MS) return 'pairing-expired'
    if (this.used) return 'pairing-used'
    if (proofIsRight()) {
      this.used = true
      return 'accepted'
    }
    this.invalid++
    return 'bad-proof'
  }
}
