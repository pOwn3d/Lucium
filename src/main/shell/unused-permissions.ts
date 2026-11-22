// "Oublier les autorisations des sites non visités": one pass at launch and one a day while the setting is on (the gate), in the main window only.
// The pass asks the reducer to take the answers back (`permission/sweep`), and says what it took in a notice, with the sites named: what leaves
// must be known to the person. The visits themselves are written by the pages (browser-pages.ts) through `permission/visit`.

import type { ForgottenSite } from '@shared/unused-permissions'
import { dayOf, sweepUnused } from '@shared/unused-permissions'
import { t, tp } from '@shared/i18n'
import type { FeatureGates, GateStore } from './feature-gate'

/** Between two passes of a run that stays open. */
export const UNUSED_PERMISSIONS_PERIOD_MS = 24 * 60 * 60 * 1000
/** The sites a notice names; the others are counted. */
export const FORGOTTEN_SITES_NAMED = 3

export interface UnusedPermissionsDeps {
  store: GateStore
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  dispatch(action: { type: 'permission/sweep'; day: number }): void
  /** Tells what was taken back, site by site. */
  notify(forgotten: ForgottenSite[]): void
}

/** The notice that says what was taken back: the first sites by name, the others counted, and the delay that made them go. */
export function forgottenNotice(forgotten: readonly ForgottenSite[], days: number): string {
  const hosts = forgotten.map((site) => site.origin.replace(/^https?:\/\//, ''))
  const sites = hosts.slice(0, FORGOTTEN_SITES_NAMED).join(', ')
  const others = hosts.length - FORGOTTEN_SITES_NAMED
  return others > 0 ? tp('unused-permissions.notice-others', others, { sites, days: String(days) }) : t('unused-permissions.notice', { sites, days: String(days) })
}

/** Ties the passes to the setting: nothing is armed while it is 0. */
export function gateUnusedPermissions(gates: FeatureGates, deps: UnusedPermissionsDeps): void {
  gates.gate('forget-unused-permissions', {
    start() {
      const pass = (): void => {
        const { sitePermissions, siteVisits, settings } = deps.store.get()
        const day = dayOf(deps.now())
        // The same rule as the reducer's, read first so that the notice can name what the reducer is about to take.
        const { forgotten } = sweepUnused(sitePermissions, siteVisits, day, settings.forgetUnusedPermissionsDays)
        deps.dispatch({ type: 'permission/sweep', day })
        if (forgotten.length > 0) deps.notify(forgotten)
      }
      let timer: unknown = null
      const arm = (): void => {
        timer = deps.setTimer(() => {
          pass()
          arm()
        }, UNUSED_PERMISSIONS_PERIOD_MS)
      }
      pass()
      arm()
      return () => deps.clearTimer(timer)
    }
  })
}
