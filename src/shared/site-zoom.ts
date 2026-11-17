// Page zoom remembered per site: ⌘+ and ⌘− on a site keep their level for that site, whatever
// the tab, and ⌘0 forgets it. Pure rules; the browser applies the factor to the pages (shell/browser-commands.ts, browser-site.ts) and the settings keep it.

import { t } from './i18n'

/** The steps ⌘+ and ⌘− go through: the ones Chromium's own zoom commands use. */
export const ZOOM_PRESETS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export const ZOOM_MIN = ZOOM_PRESETS[0]!
export const ZOOM_MAX = ZOOM_PRESETS[ZOOM_PRESETS.length - 1]!
/** Sites with a remembered zoom; beyond this the oldest go. */
export const SITE_ZOOM_MAX = 500

const EPSILON = 0.005

/** The next preset above (1) or below (-1) the current factor. A factor between two presets goes to the nearer one on that side; the ends stay. */
export function stepZoom(current: number, step: 1 | -1): number {
  const factor = Number.isFinite(current) ? current : 1
  const next = step === 1 ? ZOOM_PRESETS.find((p) => p > factor + EPSILON) : [...ZOOM_PRESETS].reverse().find((p) => p < factor - EPSILON)
  return next ?? (step === 1 ? ZOOM_MAX : ZOOM_MIN)
}

/** "110 %" (in English "110%"): how a factor is told to the user. */
export function zoomLabel(factor: number): string {
  return t('resources.pourcent', { n: Math.round(factor * 100) })
}

const HOST = /^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)$/

/** The key a site's zoom is kept under: its host name, without "www." (as a Tweak is matched), or null for an address that has none (a file, about:blank). */
export function zoomHostOf(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  return HOST.test(host) ? host : null
}

/** The factor remembered for the site of `url`; 1 when none, or when the address has no host. */
export function siteZoomOf(zoom: Record<string, number> | undefined, url: string): number {
  const host = zoomHostOf(url)
  const factor = host && zoom ? zoom[host] : undefined
  return typeof factor === 'number' && Number.isFinite(factor) ? factor : 1
}

/** A page as its zoom sees it: the address of its tab, and whether the tab is private. */
export interface ZoomedPage {
  url: string
  private?: boolean
}

/**
 * The site the zoom of a page is kept for (its host, saved with the settings and given to every tab of the site), or null when the zoom is the tab's own: a
 * page that has no host (about:blank, a page written by the page that opened it, a file) and a private tab, which saves nothing. The tab keeps its own zoom for
 * as long as its page lives (a reload or another document of it included), as a site keeps its zoom.
 */
export function zoomSiteOf(page: ZoomedPage): string | null {
  return page.private === true ? null : zoomHostOf(page.url)
}

/** The zoom the user chose for a page (⌘+ ⌘− ⌘0), before the text size of a Tweak: its site's, or the tab's own (`tabZoom`; 1 when it has none). */
export function chosenZoomOf(page: ZoomedPage, siteZoom: Record<string, number> | undefined, tabZoom: number | undefined): number {
  return zoomSiteOf(page) !== null ? siteZoomOf(siteZoom, page.url) : (tabZoom ?? 1)
}

/** The map with `factor` remembered for `host`; a factor of 100 % forgets the site. A new map: the settings are never changed in place. */
export function withSiteZoom(zoom: Record<string, number>, host: string, factor: number): Record<string, number> {
  const { [host]: _old, ...rest } = zoom
  if (Math.abs(factor - 1) < EPSILON) return rest
  return { ...rest, [host]: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 1000) / 1000)) }
}

/** The zoom map of a saved file: only valid hosts with a factor in range that is not 100 %, at most `SITE_ZOOM_MAX` of them. */
export function cleanSiteZoom(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const entries = Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, number] => {
    const [host, factor] = entry
    return HOST.test(host) && typeof factor === 'number' && Number.isFinite(factor) && factor >= ZOOM_MIN - EPSILON && factor <= ZOOM_MAX + EPSILON && Math.abs(factor - 1) >= EPSILON
  })
  return Object.fromEntries(entries.slice(-SITE_ZOOM_MAX).map(([host, factor]) => [host, Math.round(factor * 1000) / 1000]))
}

/**
 * The mark the toolbar shows while the page of `url` is not at 100 % ("125 %"), or null: at 100 %, for a page that has no host (its zoom
 * only lasts as long as the tab and is not kept), and whenever the setting is off. Nothing is drawn, and nothing is computed, in that case.
 */
export function zoomMark(settings: { showZoomIndicator: boolean; siteZoom: Record<string, number> }, url: string | undefined): string | null {
  if (!settings.showZoomIndicator || url === undefined) return null
  const factor = siteZoomOf(settings.siteZoom, url)
  return Math.abs(factor - 1) < EPSILON ? null : zoomLabel(factor)
}
