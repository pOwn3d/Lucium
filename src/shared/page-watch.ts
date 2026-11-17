// Watching a page for changes (as Visualping and the like do): a page is fetched again now and then, in a view nobody
// sees, with the session of its profile; what it shows is reduced to a fingerprint, and a system notice tells when the fingerprint is
// no longer the one seen last. Pure rules here: what a watch may hold, when the next look is due, what a look concludes, what the
// notice says. The load itself is the engine's (`readPageText`), the schedule the shell's (shell/page-watch.ts).

import type { PageWatch } from './model'
import { isProfileId } from './profiles'
import { cleanId, isRecord, printable } from './state-clean'
import { t } from './i18n'

/** The fewest minutes between two looks at one page: a lower number would hammer a site and the battery. */
export const PAGE_WATCH_MIN_MINUTES = 5
/** A week: past that a watch is forgotten more than watched. */
export const PAGE_WATCH_MAX_MINUTES = 7 * 24 * 60
export const PAGE_WATCH_DEFAULT_MINUTES = 60
/** At most this many pages watched: each look loads a whole page, one after the other, so the cost is bounded by this. */
export const PAGE_WATCH_MAX = 10
export const PAGE_WATCH_URL_MAX = 2048
export const PAGE_WATCH_SELECTOR_MAX = 200
export const PAGE_WATCH_TITLE_MAX = 200
/** The text of a page is cut here before it is fingerprinted: a page that long changes by itself (a feed), and the engine's answer stays small. */
export const PAGE_WATCH_TEXT_MAX = 200_000
/** A page that has not loaded after this long is a failed look. */
export const PAGE_WATCH_LOAD_TIMEOUT_MS = 45_000
/** After the page has loaded, scripts get this long to draw it. */
export const PAGE_WATCH_SETTLE_MS = 2000

/** Only the web: a watch on a file or an extension page would read the disk or run extension code on a timer. */
export function isWatchableUrl(url: unknown): url is string {
  return typeof url === 'string' && url.length <= PAGE_WATCH_URL_MAX && /^https?:\/\//i.test(url) && URL.canParse(url) && !/\p{Cc}/u.test(url)
}

const cleanSelector = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const selector = value.trim()
  return selector !== '' && selector.length <= PAGE_WATCH_SELECTOR_MAX && !/\p{Cc}/u.test(selector) ? selector : undefined
}

const FINGERPRINT = /^[0-9a-f]{16}$/

const stamp = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/** The minutes between two looks, within the bounds, whole. A value that is not a number is the default. */
export function cleanWatchMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PAGE_WATCH_DEFAULT_MINUTES
  return Math.min(PAGE_WATCH_MAX_MINUTES, Math.max(PAGE_WATCH_MIN_MINUTES, Math.round(value)))
}

/** The watches of a saved file: web pages only, each id once, no more than the bound. One bad entry costs only itself. */
export function cleanPageWatches(raw: unknown): PageWatch[] {
  const out: PageWatch[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= PAGE_WATCH_MAX) break
    if (!isRecord(entry)) continue
    const id = cleanId(entry['id'])
    if (id === null || seen.has(id) || !isWatchableUrl(entry['url']) || !isProfileId(entry['profileId'])) continue
    seen.add(id)
    const url = entry['url']
    const selector = cleanSelector(entry['selector'])
    const hash = typeof entry['hash'] === 'string' && FINGERPRINT.test(entry['hash']) ? entry['hash'] : undefined
    const checkedAt = stamp(entry['checkedAt'])
    const changedAt = stamp(entry['changedAt'])
    const failure = printable(entry['failure'], 200)?.trim()
    out.push({
      id,
      url,
      title: printable(entry['title'], PAGE_WATCH_TITLE_MAX)?.trim() || new URL(url).host,
      profileId: entry['profileId'],
      ...(selector ? { selector } : {}),
      minutes: cleanWatchMinutes(entry['minutes']),
      ...(hash ? { hash } : {}),
      ...(checkedAt !== undefined ? { checkedAt } : {}),
      ...(changedAt !== undefined ? { changedAt } : {}),
      ...(failure ? { failure } : {})
    })
  }
  return out
}

/** What the interface may ask for: a page, how often, and optionally a zone. */
export interface WatchRequest {
  url: string
  title: string
  profileId: string
  minutes: number
  selector?: string
}

/** The watch a request makes, or why it makes none. A page that is already watched (same address and zone) is not watched twice. */
export function addWatch(watches: readonly PageWatch[], request: WatchRequest, id: string): { watches: PageWatch[] } | { error: string } {
  if (!isWatchableUrl(request.url)) return { error: t('browser.seules-les-pages-web-http-ou-https-peuvent-etre') }
  if (!isProfileId(request.profileId)) return { error: t('engine.le-profil-de-cette-page-est-inconnu') }
  const selector = cleanSelector(request.selector)
  if (request.selector !== undefined && request.selector.trim() !== '' && !selector) return { error: t('page-watch.cette-zone-n-est-pas-un-selecteur-valide') }
  if (watches.some((w) => w.url === request.url && w.selector === selector)) return { error: t('page-watch.cette-page-est-deja-surveillee') }
  if (watches.length >= PAGE_WATCH_MAX) return { error: t('page-watch.vous-surveillez-deja-page-watch-max-pages', { PAGE_WATCH_MAX }) }
  const watch: PageWatch = {
    id,
    url: request.url,
    title: printable(request.title, PAGE_WATCH_TITLE_MAX)?.trim() || new URL(request.url).host,
    profileId: request.profileId,
    ...(selector ? { selector } : {}),
    minutes: cleanWatchMinutes(request.minutes)
  }
  return { watches: [...watches, watch] }
}

/** "1 h", "30 min", "2 j": the interval as the list shows it. */
export function watchIntervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return t('page-watch.days-j', { days: minutes / 1440 })
  if (minutes % 60 === 0) return t('page-watch.hours-h', { hours: minutes / 60 })
  return t('page-watch.minutes-min', { minutes })
}

/** The intervals the list offers, with their names in the language of the interface. */
export function pageWatchChoices(): ReadonlyArray<[number, string]> {
  return [
    [5, t('page-watch.toutes-les-5-minutes')],
    [15, t('page-watch.toutes-les-15-minutes')],
    [30, t('page-watch.toutes-les-30-minutes')],
    [60, t('page-watch.toutes-les-heures')],
    [360, t('page-watch.toutes-les-6-heures')],
    [1440, t('blocking-settings.tous-les-jours')]
  ]
}

// ---------- the looks ----------

/** When a watch is due: five minutes at least after the last look, whatever happened; a watch never looked at is due now. */
export const dueAt = (watch: PageWatch): number => (watch.checkedAt === undefined ? 0 : watch.checkedAt + watch.minutes * 60_000)

/**
 * The watch to look at next: the one most overdue, and only when something is due. One at a time is the rule, so this answers a
 * single watch, not a list. `null` when nothing is due yet.
 */
export function nextDue(watches: readonly PageWatch[], now: number): PageWatch | null {
  let best: PageWatch | null = null
  for (const watch of watches) if (dueAt(watch) <= now && (!best || dueAt(watch) < dueAt(best))) best = watch
  return best
}

/** The time of the next look of any watch (`null` without watches), so that the schedule sleeps until then and not a moment before. */
export function nextWakeAt(watches: readonly PageWatch[]): number | null {
  return watches.length === 0 ? null : Math.min(...watches.map(dueAt))
}

/** The text reduced to what a reader sees: whitespace folded, the ends trimmed, cut at the bound. */
export function normalizeWatchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PAGE_WATCH_TEXT_MAX)
}

/** A 64-bit fingerprint (two FNV-1a passes) as 16 hex digits. It tells a text from another, nothing more: it is not a secret. */
export function fingerprint(text: string): string {
  let a = 0x811c9dc5
  let b = (0x01000193 ^ 0x9e3779b9) >>> 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0
    b = (b ^ (b >>> 13)) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export type WatchOutcome = 'first' | 'same' | 'changed'

/** What a look concludes from the text it saw: the first look only records, a different fingerprint is a change. */
export function judgeLook(watch: PageWatch, text: string): { outcome: WatchOutcome; hash: string } {
  const hash = fingerprint(normalizeWatchText(text))
  return { outcome: watch.hash === undefined ? 'first' : watch.hash === hash ? 'same' : 'changed', hash }
}

/** The watch after a look that read `hash`: dates moved, the failure of the last look forgotten. */
export function afterLook(watch: PageWatch, look: { outcome: WatchOutcome; hash: string }, now: number): PageWatch {
  const { failure: _failure, ...rest } = watch
  return { ...rest, hash: look.hash, checkedAt: now, ...(look.outcome === 'changed' ? { changedAt: now } : {}) }
}

/** The watch after a look that failed: the date moves (the next look is a full interval away) and the list says why. */
export function afterFailure(watch: PageWatch, message: string, now: number): PageWatch {
  return { ...watch, checkedAt: now, failure: printable(message, 200)?.trim() || t('page-watch.la-page-n-a-pas-pu-etre-lue') }
}

/** The system notice of a change: the name of the page only, never its text. */
export function changeNotice(watch: PageWatch): { title: string; body: string } {
  return { title: t('page-watch.page-modifiee'), body: watch.title }
}

/** The line a list shows under a watch: when it last changed, when it was last looked at, or what went wrong. */
export function watchStatus(watch: PageWatch, now: number): string {
  if (watch.failure) return t('page-watch.echec-failure', { failure: watch.failure })
  if (watch.checkedAt === undefined) return t('page-watch.pas-encore-verifiee')
  const ago = (at: number) => {
    const minutes = Math.max(0, Math.floor((now - at) / 60_000))
    if (minutes < 1) return t('sessions.a-l-instant')
    if (minutes < 60) return t('page-watch.il-y-a-minutes-min', { minutes })
    if (minutes < 1440) return t('page-watch.il-y-a-hours-h', { hours: Math.round(minutes / 60) })
    return t('page-watch.il-y-a-days-j', { days: Math.round(minutes / 1440) })
  }
  const checked = ago(watch.checkedAt)
  return watch.changedAt !== undefined ? t('page-watch.modifiee-changed-verifiee-checked', { changed: ago(watch.changedAt), checked }) : t('page-watch.inchangee-verifiee-checked', { checked })
}
