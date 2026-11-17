// The sweep that archives the tabs of Today nobody has looked at for a while (the rule is the reducer's: `archive/sweep` in shared/sidebar.ts).
// It runs only while archiving has something to do: the general delay or the delay of a profile is above "Jamais" (`archiveHasWork`).

import type { FeatureGates } from './feature-gate'

/** How often the sweep looks at the tabs. */
export const ARCHIVE_SWEEP_MS = 10 * 60_000

/**
 * Ties the sweep to its setting: one pass as it starts (at launch, and each time archiving comes back on), then one every ARCHIVE_SWEEP_MS.
 * Off, there is no timer and no pass; the delay itself is read by the reducer at each pass, so a changed delay needs nothing here.
 */
export function gateAutoArchive(gates: FeatureGates, sweep: () => void): void {
  gates.gate('auto-archive', {
    start() {
      const timer = setInterval(function archiveSweepTick() {
        sweep()
      }, ARCHIVE_SWEEP_MS)
      sweep()
      return () => clearInterval(timer)
    }
  })
}
