// The Chrome Web Store, as far as Lucium is concerned: which page may install, which addresses the installer may reach, and when the
// installed extensions look for an update. Pure rules; the engine applies them (engine/web-store.ts, engine/web-store-network.ts).
//
// Reservation (docs/architecture.md): the terms of the Web Store do not name browsers other than
// Chrome, but define its products as made "for use with Google Chrome" and forbid reaching the store by a means other than its own
// interface unless Google agrees. Lucium therefore only opens the store's own pages in a tab, installs on a click the user makes
// there, and asks Google for nothing else without a user action. It is a grey area, not a licence; the switch in Settings is the way out.

import type { WebStoreUpdates } from './model'
import { t, tp } from './i18n'

/** The only origin whose pages may install an extension. An exact match: a host that merely starts with this name is another site. */
export const STORE_ORIGIN = 'https://chromewebstore.google.com'
/** Where "Ouvrir le Chrome Web Store" goes. */
export const STORE_URL = `${STORE_ORIGIN}/`

export const isStoreOrigin = (origin: unknown): boolean => origin === STORE_ORIGIN

/** Whether an address is a page of the store (what the menu entry shows next to). */
export function isStorePage(url: unknown): boolean {
  if (typeof url !== 'string' || !URL.canParse(url)) return false
  return isStoreOrigin(new URL(url).origin)
}

/**
 * Domains the installer may reach: the store's own, the update service, and the hosts Google serves packages and pictures from. Anything
 * else (an address a store page names for an icon, a redirect) is refused, so a page cannot make the installer fetch what it likes.
 */
export const STORE_HOST_SUFFIXES = ['google.com', 'googleapis.com', 'googleusercontent.com', 'gstatic.com'] as const

export function isStoreHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  return STORE_HOST_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))
}

export const UPDATE_INTERVAL_MS: Record<WebStoreUpdates, number | null> = { manual: null, daily: 24 * 3_600_000, weekly: 7 * 24 * 3_600_000 }

/** Whether the extensions should look for updates now. `manual` never does; the others when the last check is older than their interval. */
export function updateDue(mode: WebStoreUpdates, lastCheck: number | undefined, now: number): boolean {
  const interval = UPDATE_INTERVAL_MS[mode]
  if (interval === null) return false
  // A date in the future (the clock moved back) counts as due: waiting for it would postpone the check indefinitely.
  return lastCheck === undefined || lastCheck > now || now - lastCheck >= interval
}

export const WEB_STORE_UPDATE_LABELS: Record<WebStoreUpdates, string> = { get manual() { return t('web-store.a-la-demande') }, get daily() { return t('web-store.chaque-jour') }, get weekly() { return t('web-store.chaque-semaine') } }

/** How a run of the update check went: the names of the extensions updated, those that wait for the user's agreement, and why it failed, if it did. */
export interface UpdateReport {
  checked: number
  updated: string[]
  /** Updates that ask for more permissions than the installed version: never applied without the sheet. */
  waiting: string[]
  failed: string | null
}

/** The first few names of a list, and a mark when there are more: names of extensions, the same in every language. */
const firstNames = (names: readonly string[]): string => `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`

/** The sentence of the notice that ends a check (a manual one always says something; a scheduled one only when there is news). */
export function updateSummary(report: UpdateReport): string {
  if (report.failed !== null) return t('web-store.mise-a-jour-des-extensions-impossible-failed', { failed: report.failed })
  if (report.checked === 0) return t('web-store.aucune-extension-du-chrome-web-store-a-mettre-a')
  const updated = report.updated.length > 0 ? tp('web-store.count-extensions-mises-a-jour-names', report.updated.length, { names: firstNames(report.updated) }) : null
  const waiting = report.waiting.length > 0 ? tp('web-store.count-mises-a-jour-attendent-votre-accord-names', report.waiting.length, { names: firstNames(report.waiting) }) : null
  if (updated !== null && waiting !== null) return t('web-store.updated-waiting', { updated, waiting })
  const news = updated ?? waiting
  return news !== null ? `${news}.` : tp('web-store.count-extensions-verifiees-tout-est-a-jour', report.checked)
}

/**
 * The page of the store decides whether to install from two sources. From a Chrome of version 142.0.7430.0 or later it trusts a verdict
 * the store's server gives about the request (a flag in the page's data that is only true for what the server recognises as a Chrome);
 * for an older version it checks the shape of the user agent itself. The server does not recognise Lucium as a Chrome (Chromium without
 * Google's branding, and the headers a Chrome sends to Google are not ours to send), so the page shows "Passez à Chrome pour installer des
 * extensions et des thèmes" whatever the user agent, the client hints or the `chrome` object say. Telling the page that the version is the last one
 * before that threshold sends it to its own user-agent check, which a plain Chrome user agent passes.
 * It changes one answer, to the store's own origin: the version a page of the store reads through `chrome.webstorePrivate.getFullChromeVersion`.
 */
export const STORE_TRUST_THRESHOLD = '142.0.7430.0'
/** The version told to the store's page when the real one is at or above the threshold. */
export const STORE_VERSION_REPORTED = '141.0.7389.0'

const versionParts = (version: string): number[] => version.split('.').map((part) => Number.parseInt(part, 10) || 0)

/** -1, 0 or 1 as `a` is before, equal to or after `b`, comparing the four numbers of a Chromium version from the left. */
export function compareChromium(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

/** The version the store's page is told: `reported` when the real one reaches the threshold, the real one below it (no need to say less). */
export function versionForStore(real: string, reported: string = STORE_VERSION_REPORTED): string {
  return compareChromium(real, STORE_TRUST_THRESHOLD) >= 0 ? reported : real
}
