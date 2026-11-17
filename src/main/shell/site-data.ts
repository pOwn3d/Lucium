// "Clear this site's data", the part that sits between the panel and the engine: which origins are meant, the types that
// live in the pages (sessionStorage) and in our own history, and the reload afterwards. No Electron here: everything it
// touches comes in through `SiteDataEnvironment`, so it is tested with stand-ins.

import {
  MEDIA_LICENSES,
  SITE_DATA_TYPES,
  SUBDOMAINS,
  allSitesCleared,
  describeSiteDataNotice,
  failedSites,
  hostBelongsToSite,
  isEngineSiteDataType,
  parseSiteHost,
  reloadTarget,
  sessionStorageScript,
  siteOrigins,
  type SiteDataBatchRequest,
  type SiteDataRequest,
  type SiteDataResult,
  type SiteDataResultType,
  type SiteDataSiteResult
} from '@shared/site-data'
import { OVERLAY_DONE_MS, OVERLAY_FADE_MS, OVERLAY_LOADER_MIN_MS, clearingOverlayScript, doneOverlayScript, type SiteDataAnimation } from '@shared/site-data-overlay'
import type { SiteDataEngineRequest } from '../engine/types'
import { t } from '@shared/i18n'
import { forgetTranslations } from './translation-traces'
import { NBSP } from '@shared/french-typography'

export interface SiteDataEnvironment {
  /** The engine erasure for the profile of the window (its session, or the window's private one). */
  clear(request: SiteDataEngineRequest): Promise<SiteDataResult[]>
  history: { removeSite(host: string, subdomains: boolean): number; hosts(): string[] }
  /** The pages the closed tabs of this profile went through (their Back lists, in the archive and in the copies of the session): the site's go with its history. */
  closedPages: { removeSite(host: string, subdomains: boolean): void }
  /** The tabs of this profile that have a live page. sessionStorage belongs to a page, not to the profile. */
  tabs: Array<{ url: string; page: { evaluate(js: string): Promise<unknown> } }>
  /** The tab the user is looking at, if it has a page. */
  active: { url: string; page: { reload(): void; loadURL(url: string): void } } | null
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The host of a tab's address, or null when it is not a web page. */
const hostOfUrl = (url: string): string | null => (/^https?:\/\//i.test(url) && URL.canParse(url) ? new URL(url).host : null)

/**
 * Erases what the request asks for and answers one result per type, in the order asked. The tab is never closed; with
 * `reload`, and only when everything succeeded, the tab on the site goes back to its root (or reloads if already there).
 * Throws without erasing anything when the host is not valid.
 */
export async function clearSiteFor(env: SiteDataEnvironment, request: SiteDataRequest): Promise<SiteDataResult[]> {
  const site = parseSiteHost(request.host)
  if (!site) throw new Error(`Invalid site: ${request.host}`)
  // The texts of the pages translated in this session, those of this site among them (translation-traces.ts).
  forgetTranslations()

  // Only used when subdomains are asked for: `siteOrigins` ignores them otherwise.
  const knownHosts = [...env.tabs.map((tab) => hostOfUrl(tab.url)), ...env.history.hosts()].filter((h): h is string => h !== null)
  const origins = siteOrigins(site.host, { subdomains: request.subdomains, knownHosts, http: request.http })
  const byType = new Map<SiteDataResultType, SiteDataResult>()

  const engineTypes = request.types.filter(isEngineSiteDataType)
  if (engineTypes.length > 0) {
    try {
      for (const result of await env.clear({ origins, host: site.host, subdomains: request.subdomains, types: engineTypes })) byType.set(result.type, result)
    } catch (error) {
      // A refusal of the engine reaches the panel as a failure on every line it was asked for.
      for (const type of engineTypes) byType.set(type, { type, ok: false, error: errorText(error) })
    }
  }

  if (request.types.includes('sessionStorage')) byType.set('sessionStorage', await clearSessionStorage(env.tabs, origins))

  if (request.types.includes('history')) {
    try {
      byType.set('history', { type: 'history', ok: true, count: env.history.removeSite(site.host, request.subdomains) })
    } catch (error) {
      byType.set('history', { type: 'history', ok: false, error: errorText(error) })
    }
    // Whatever became of the visits: the pages of the site in the Back lists of the archived tabs are history too, and they are shown as not erased if they stayed.
    try {
      env.closedPages.removeSite(site.host, request.subdomains)
    } catch (error) {
      byType.set('history', { type: 'history', ok: false, error: errorText(error) })
    }
  }

  const results = SITE_DATA_TYPES.filter((type) => request.types.includes(type)).map((type): SiteDataResult => byType.get(type) ?? { type, ok: false, error: t('site-data.pas-de-reponse-du-moteur') })
  // The licences of protected video are no type of the request: the engine answers a line for them when the types asked let it erase them.
  const licences = byType.get(MEDIA_LICENSES)
  if (licences) results.push(licences)
  // Nor is the list of the subdomains that hold storage: the engine answers what it found, or that it could not look.
  const subdomains = byType.get(SUBDOMAINS)
  if (subdomains) results.push(subdomains)

  if (request.reload && results.every((r) => r.ok)) reloadActiveTab(env.active, [site.host], request.subdomains)
  return results
}

/** The tab the user is looking at goes back to the root of its site (or reloads if already there), when it is on one of `sites`. */
function reloadActiveTab(active: SiteDataEnvironment['active'], sites: readonly string[], subdomains: boolean): void {
  const activeHost = active ? hostOfUrl(active.url) : null
  if (!active || activeHost === null || !sites.some((site) => hostBelongsToSite(activeHost, site, subdomains))) return
  const target = reloadTarget(active.url)
  if (target.kind === 'load') active.page.loadURL(target.url)
  else active.page.reload()
}

/**
 * Erases the same types for several sites, one after the other, and answers one entry per site in the order asked (the panel's tags).
 * Each site goes through `clearSiteFor`, so each one is restricted to its own origins: a site that is not named is never touched.
 * A site whose run fails keeps its place with every type failed and the others still run. The reload happens once, at the end,
 * and only when every site went through. Throws without erasing anything when one of the hosts is not valid.
 */
export async function clearSitesFor(env: SiteDataEnvironment, request: SiteDataBatchRequest): Promise<SiteDataSiteResult[]> {
  const sites = request.hosts.map((host) => parseSiteHost(host))
  const invalid = request.hosts.find((_, i) => sites[i] === null)
  if (invalid !== undefined) throw new Error(`Invalid site: ${invalid}`)

  const out: SiteDataSiteResult[] = []
  for (const site of sites) {
    const host = site!.host
    try {
      out.push({ host, results: await clearSiteFor(env, { host, types: request.types, subdomains: request.subdomains, http: request.http, reload: false }) })
    } catch (error) {
      // The failure is the user's to see: the panel prints it on every line of this site.
      out.push({ host, results: request.types.map((type) => ({ type, ok: false, error: errorText(error) })) })
    }
  }
  if (request.reload && allSitesCleared(out)) reloadActiveTab(env.active, out.map((site) => site.host), request.subdomains)
  return out
}

/** sessionStorage is per tab: every open tab of the profile that is on one of the origins is emptied, the one the panel was opened from included. */
async function clearSessionStorage(tabs: SiteDataEnvironment['tabs'], origins: string[]): Promise<SiteDataResult> {
  const onSite = tabs.filter((tab) => hostOfUrl(tab.url) !== null && origins.includes(new URL(tab.url).origin))
  let count = 0
  try {
    for (const tab of onSite) count += Number(await tab.page.evaluate(sessionStorageScript(origins))) || 0
    return { type: 'sessionStorage', ok: true, count }
  } catch (error) {
    return { type: 'sessionStorage', ok: false, error: errorText(error) }
  }
}

/** The page a run draws its animation on: the tab it was started from (shared/site-data-overlay.ts). */
export interface AnimatedPage {
  runClearOverlay(code: string): Promise<unknown>
}

/** The page of a tab the animation may be drawn on: a web page the engine can draw on, never a start page, the settings, a file or an extension's page. */
export function animationPageOf(url: string | undefined, page: { runClearOverlay?: (code: string) => Promise<unknown> } | undefined): AnimatedPage | null {
  const draw = page?.runClearOverlay
  if (url === undefined || !draw || !/^https?:\/\//i.test(url)) return null
  return { runClearOverlay: (code) => draw.call(page, code) }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** What the animation of a run leans on, apart from the page: the panel that has to get out of the way, and the clock (the tests give their own). */
export interface PageAnimationOptions {
  /** Puts the panel the run was started from out of sight while the page animates; answers what brings it back, called once the animation is over (whatever became of the run). */
  stepAside?: () => () => void
  /** Waits `ms` milliseconds. */
  wait?: (ms: number) => Promise<void>
}

/** Draws `code` on the page; false when the page refused (logged) or has no drawing to end any more. The drawing is a decoration: a refusal never stops a run. */
async function draw(page: AnimatedPage, code: string, step: string): Promise<boolean> {
  try {
    return (await page.runClearOverlay(code)) !== false
  } catch (error) {
    console.warn(`[site] cannot draw the ${step} of the clearing animation on the page:`, errorText(error))
    return false
  }
}

/**
 * Runs `run` with the animation drawn on `page` (« Animation sur la page ») and in this order: the panel steps aside, the loader is drawn and stays
 * at least `OVERLAY_LOADER_MIN_MS` while `run` goes on (an erasure is too quick to be seen), then a tick when `succeeded` says so, a cross otherwise
 * or when the run throws (the error is passed on), for as long as it takes to fade; only then the panel comes back and the answer is given. Nothing
 * is drawn, and nothing waits, without a page or with `none` (reduced motion). A page that refuses the drawing is logged and the run goes on as if
 * it had been drawn, without the waits.
 */
export async function withPageAnimation<T>(page: AnimatedPage | null, animation: SiteDataAnimation, run: () => Promise<T>, succeeded: (result: T) => boolean, options: PageAnimationOptions = {}): Promise<T> {
  if (page === null || animation === 'none') return run()
  const wait = options.wait ?? sleep
  const comeBack = options.stepAside?.()
  try {
    const started = await draw(page, clearingOverlayScript(animation), 'start')
    const [outcome] = await Promise.allSettled([(async () => run())(), started ? wait(OVERLAY_LOADER_MIN_MS) : Promise.resolve()])
    if (await draw(page, doneOverlayScript(outcome.status === 'fulfilled' && succeeded(outcome.value)), 'end')) await wait(OVERLAY_DONE_MS + OVERLAY_FADE_MS)
    if (outcome.status === 'rejected') throw outcome.reason
    return outcome.value
  } finally {
    comeBack?.()
  }
}

/** How long the reload of the tab waits after the answer is given, so that the answer is on screen before the page goes. */
export const RELOAD_AFTER_ANSWER_MS = 150

/** Where a user-started run is animated (see `clearSitesWithAnimation`). */
export interface RunStage extends PageAnimationOptions {
  page: AnimatedPage | null
  animation: SiteDataAnimation
  /** The tab to send back to the root of its site, asked for when the time comes: the user may have gone elsewhere during the animation. */
  active?: () => SiteDataEnvironment['active']
}

/**
 * `clearSitesFor` for a run the user started (the sheet, the shortcut, a menu), with the animation of its setting. Without a page to draw on or with
 * `none` (what reduced motion gives) it is `clearSitesFor`, nothing waits and the tab goes back to the root at once. Otherwise the reload comes
 * after the animation and after the answer, never before: a tab sent back to the root is a new document, which would take the drawing with it.
 */
export async function clearSitesWithAnimation(env: SiteDataEnvironment, request: SiteDataBatchRequest, stage: RunStage): Promise<SiteDataSiteResult[]> {
  if (stage.page === null || stage.animation === 'none') return clearSitesFor(env, request)
  const sites = await withPageAnimation(stage.page, stage.animation, () => clearSitesFor(env, { ...request, reload: false }), allSitesCleared, stage)
  if (request.reload && allSitesCleared(sites)) {
    const wait = stage.wait ?? sleep
    void wait(RELOAD_AFTER_ANSWER_MS).then(() => {
      try {
        reloadActiveTab(stage.active ? stage.active() : env.active, sites.map((site) => site.host), request.subdomains)
      } catch (error) {
        // The tab may be gone by now: the erasure itself went through.
        console.warn('[site] cannot send the tab back to the root of the site after the animation:', errorText(error))
      }
    })
  }
  return sites
}

/** What `runAndTell` needs from the window that started a run. */
export interface RunReport {
  /** Runs the request in the profile of the window; rejects when it could not even start. */
  run(request: SiteDataBatchRequest): Promise<SiteDataSiteResult[]>
  /** Whether the setting asks for a notice of a run that went well (read when the run is over, not when it started). A failure is told whatever it says. */
  notify(): boolean
  /** A private window never names its sites in a notice. */
  private: boolean
  /** Hands a notice to the system; false when it could not. */
  notice(notice: { title: string; body: string }): boolean
  /** The window's own short notice, for when the system's is not available. */
  toast(message: string): void
}

/**
 * Runs a request nobody is watching (shortcut, menu, a panel that closed at once) and, when notices are on, says how it went.
 * A run that could not even start is told as a failure of every site it named, and logged. Without a notification centre the
 * same words go to the toast of the window, so the outcome is never silent.
 * The setting only silences the good news: a failure is always told. With notices off it goes to the toast of the window, not
 * to the system's notification centre, which the user asked not to be bothered with.
 */
export async function runAndTell(report: RunReport, request: SiteDataBatchRequest): Promise<void> {
  let sites: SiteDataSiteResult[]
  try {
    sites = await report.run(request)
  } catch (error) {
    console.error('[site] cannot clear site data:', error)
    sites = request.hosts.map((host) => ({ host, results: [] }))
  }
  const failed = failedSites(sites).length > 0
  const notify = report.notify()
  if (!notify && !failed) return
  const notice = describeSiteDataNotice(sites, { private: report.private })
  if (!notify || !report.notice(notice)) report.toast(`${notice.title}${NBSP}: ${notice.body}`)
}
