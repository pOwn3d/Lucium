// The purge of « Garder l'historique : N jours »: the pages last visited before the delay are forgotten, in every profile.
// It runs only while the delay is above 0 (`historyKeepDays`, 0 by default): no timer and no pass otherwise. The delay itself is read at each pass,
// so a shorter delay takes effect at the next hourly pass.

import type { FeatureGates } from './feature-gate'

/** How often the purge looks at the history: cheap (one pass over the pages in memory), and a changed delay is felt within the hour. */
export const HISTORY_PURGE_MS = 60 * 60_000

/** Ties the purge to its setting: one pass as it starts (at launch, and each time the delay comes back on), then one every HISTORY_PURGE_MS. */
export function gateHistoryPurge(gates: FeatureGates, purge: () => void): void {
  gates.gate('history-purge', {
    start() {
      const timer = setInterval(function historyPurgeTick() {
        purge()
      }, HISTORY_PURGE_MS)
      purge()
      return () => clearInterval(timer)
    }
  })
}
