// What the error pages of the engine need of safe browsing (shared/safe-browsing.ts), which the shell owns: whether an address is on a list right now,
// and the way through of the warning page. Set once by the shell while the feature is on; absent, nothing is warned about and the page of a refused
// load is the ordinary one.

import type { SafeVerdict } from '@shared/safe-browsing'

export interface SafeGate {
  /** The list the address is on (and the host), or null: not listed, excepted, or let through for this session. */
  verdict(url: string): SafeVerdict | null
  /** « Continuer quand même » on the warning page: the host of this address opens for the rest of this run. */
  allow(url: string): void
  /** « Ne plus prévenir pour ce site » on the warning page: the host of this address joins the lasting exceptions of the settings. */
  except(url: string): void
}

let current: SafeGate | null = null

export const safeGate = {
  set(gate: SafeGate | null): void {
    current = gate
  },
  get(): SafeGate | null {
    return current
  }
}
