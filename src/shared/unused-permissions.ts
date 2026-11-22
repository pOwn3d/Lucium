// "Oublier les autorisations des sites non visités": the answers remembered for a site (camera, position, notifications…) are taken back once the
// site was not visited for a chosen number of days. Off by default (`forgetUnusedPermissionsDays` is 0).
//
// What it keeps is one number per site that holds an answer: the day (days since 1970, UTC) of its last visit. A site without an answer has no line,
// and a visit already written for the day is no write at all (the reducer returns the same state), so the file is touched once a day per site at most.
// A site that holds an answer and has no visit written yet (the answer is older than the setting) is counted as visited the day the sweep first sees
// it: switching the setting on never takes anything back at once. The answer for every site (`ALL_SITES`) is the user's own menu, never a site, and stays.

import { ALL_SITES } from './permissions'
import { isRecordKey } from './state-clean'
import type { PermissionDecision } from './model'

type SitePermissions = Record<string, Record<string, PermissionDecision>>

/** The delays the setting offers, in days (0, "never", is the default and means the feature is off). */
export const UNUSED_PERMISSION_DAYS: readonly number[] = [30, 60, 90, 180, 365]
/** The setting once it is switched on from the feature list. */
export const UNUSED_PERMISSION_DAYS_DEFAULT = 90
/** How many sites keep a visit day: the same ceiling as the answers, since only a site that holds an answer has one. */
export const SITE_VISITS_MAX = 2000
/** The latest day a file may name (the year 4700): a number past it is not a day. */
const DAY_MAX = 1_000_000

const DAY_MS = 86_400_000

/** The day a moment falls in: days since 1970, UTC. */
export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS)

const isDay = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= DAY_MAX

/** The setting as a file may hold it: one of the delays above, else 0 (off). */
export const cleanUnusedPermissionDays = (value: unknown): number => (typeof value === 'number' && UNUSED_PERMISSION_DAYS.includes(value) ? value : 0)

/** The table of last visits as a state file may hold it: sites that hold an answer, with a day, within the ceiling (the last added go on). */
export function cleanSiteVisits(raw: unknown, sitePermissions: SitePermissions): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const entries = Object.entries(raw).filter(([origin, day]) => isRecordKey(origin) && holdsAnswer(sitePermissions, origin) && isDay(day)) as Array<[string, number]>
  return Object.fromEntries(entries.slice(-SITE_VISITS_MAX))
}

/** Whether a site holds an answer of its own (the only sites whose visits are written). */
export const holdsAnswer = (sitePermissions: SitePermissions, origin: string): boolean =>
  origin !== ALL_SITES && Object.hasOwn(sitePermissions, origin) && Object.keys(sitePermissions[origin]!).length > 0

/** The table once `origin` was visited on `day`: the same table when nothing changes (no answer for that site, or the day is already written, or later). */
export function withVisit(visits: Record<string, number>, sitePermissions: SitePermissions, origin: string, day: number): Record<string, number> {
  if (!isRecordKey(origin) || !isDay(day) || !holdsAnswer(sitePermissions, origin)) return visits
  const known = Object.hasOwn(visits, origin) ? visits[origin]! : undefined
  if (known !== undefined && known >= day) return visits
  // The site goes to the end of the table: what goes when the ceiling is reached is the longest unvisited.
  const { [origin]: _old, ...others } = visits
  return { ...others, [origin]: day }
}

/** What a sweep took back from one site: its address and the permissions that were remembered for it. */
export interface ForgottenSite {
  origin: string
  permissions: string[]
}

export interface SweepResult {
  sitePermissions: SitePermissions
  siteVisits: Record<string, number>
  forgotten: ForgottenSite[]
}

/**
 * The answers and the table once the sites not visited for `days` days (or more) are forgotten, and what was forgotten. `days` of 0 is off: nothing changes.
 * A site with an answer and no day yet is written down as visited `today`; a day written for a site that holds no answer any more is dropped.
 */
export function sweepUnused(sitePermissions: SitePermissions, visits: Record<string, number>, today: number, days: number): SweepResult {
  if (days <= 0 || !isDay(today)) return { sitePermissions, siteVisits: visits, forgotten: [] }
  const kept: SitePermissions = {}
  const siteVisits: Record<string, number> = {}
  const forgotten: ForgottenSite[] = []
  for (const [origin, answers] of Object.entries(sitePermissions)) {
    if (origin === ALL_SITES || !holdsAnswer(sitePermissions, origin)) {
      kept[origin] = answers
      continue
    }
    const last = Object.hasOwn(visits, origin) ? visits[origin]! : today
    if (today - last >= days) forgotten.push({ origin, permissions: Object.keys(answers) })
    else {
      kept[origin] = answers
      siteVisits[origin] = last
    }
  }
  const unchanged = forgotten.length === 0 && Object.keys(siteVisits).length === Object.keys(visits).length && Object.entries(siteVisits).every(([origin, day]) => visits[origin] === day)
  return unchanged ? { sitePermissions, siteVisits: visits, forgotten } : { sitePermissions: forgotten.length === 0 ? sitePermissions : kept, siteVisits, forgotten }
}

/** The origin of a page address a visit is written for: a web page only (`http:` or `https:`), else null. */
export function visitOrigin(url: string): string | null {
  if (!URL.canParse(url)) return null
  const { protocol, origin } = new URL(url)
  return protocol === 'http:' || protocol === 'https:' ? origin : null
}
