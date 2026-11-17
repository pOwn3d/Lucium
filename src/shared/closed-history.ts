// The pages a tab went through before it was archived (Réglages › Onglets et fenêtres › Plus de réglages › Rouvrir un onglet avec ses pages précédentes). When the setting is
// on, closing a tab keeps the web addresses of its Back / Forward list next to the archive entry, and reopening the entry puts that list back
// (Electron's `navigationHistory.restore`). Bounded on both sides: what is kept is at most 20 web pages of at most 2048 characters, and what
// comes from a file is rebuilt the same way, so a damaged or hostile state can neither grow the archive without limit nor make a tab load
// anything but a web address.

import type { ClosedHistory, ClosedPage } from './model'
import { hostBelongsToSite } from './site-data'

export const CLOSED_HISTORY_MAX = 20
export const CLOSED_URL_MAX = 2048
export const CLOSED_TITLE_MAX = 200

const CONTROL = /\p{Cc}/gu

/** An http or https address of at most `CLOSED_URL_MAX` characters: the only kind a closed tab brings back, here and in the engine. */
export const isClosedPageUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= CLOSED_URL_MAX && /^https?:\/\//i.test(value) && URL.canParse(value) && /^https?:$/.test(new URL(value).protocol)

const titleOf = (value: unknown): string => (typeof value === 'string' ? value.replace(CONTROL, ' ').slice(0, CLOSED_TITLE_MAX) : '')

/**
 * The pages to keep for a tab that is closing: `entries` is what the engine reports (oldest first) and `index` the page the tab is on.
 * Only web pages are kept; at most `CLOSED_HISTORY_MAX` of them, the window slid so that it holds the current page (with up to five pages
 * of the Forward list when the user had gone back). Undefined when there is nothing to bring back: fewer than two web pages, or a current
 * page that is not the address the tab is archived at (the archive entry would then open one page and the list end on another).
 */
export function closedHistoryOf(entries: ReadonlyArray<{ url: string; title: string }>, index: number, tabUrl: string): ClosedHistory | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) return undefined
  const kept: ClosedPage[] = []
  let current = -1
  entries.forEach((entry, at) => {
    if (!isClosedPageUrl(entry.url)) return
    if (at === index) current = kept.length
    kept.push({ url: entry.url, title: titleOf(entry.title) })
  })
  if (current === -1 || kept.length < 2 || kept[current]!.url !== tabUrl) return undefined
  const start = Math.max(0, Math.min(kept.length - CLOSED_HISTORY_MAX, current - (CLOSED_HISTORY_MAX - 6)))
  const window = kept.slice(start, start + CLOSED_HISTORY_MAX)
  return { entries: window, index: current - start }
}

/** A history read from a file, rebuilt: web pages only, within the bounds, ending on `tabUrl`. Undefined when nothing usable is left. */
export function cleanClosedHistory(raw: unknown, tabUrl: string): ClosedHistory | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { entries, index } = raw as { entries?: unknown; index?: unknown }
  if (!Array.isArray(entries) || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= entries.length || entries.length > CLOSED_HISTORY_MAX) return undefined
  const pages: ClosedPage[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !isClosedPageUrl((entry as { url?: unknown }).url)) return undefined
    pages.push({ url: (entry as { url: string }).url, title: titleOf((entry as { title?: unknown }).title) })
  }
  return pages.length >= 2 && pages[index]!.url === tabUrl ? { entries: pages, index } : undefined
}

// ---------- forgetting them ----------

/**
 * What forgetting the pages of closed tabs reaches: the archived tabs of the spaces of one profile (their Back lists, never the tabs themselves),
 * all of them, or only the pages of a site (its subdomains too when asked). "Effacer l'historique de navigation" forgets all of a profile's,
 * "Effacer les données du site…" with the history ticked forgets the site's.
 */
export interface ClosedPagesScope {
  profileId: string
  site?: { host: string; subdomains: boolean }
}

const onSite = (url: string, site: { host: string; subdomains: boolean }): boolean => URL.canParse(url) && hostBelongsToSite(new URL(url).host, site.host, site.subdomains)

/**
 * The Back list of a closed tab at `tabUrl` after a site's pages were forgotten (the whole list when `site` is undefined): undefined when nothing
 * is left to keep, the same object when none of its pages is on the site. The list ends on the tab's own page (`cleanClosedHistory` checks it), which
 * cannot stay when the tab is on the site: that tab loses its whole list, and stays in the archive with its address and title.
 */
export function closedHistoryAfter(history: ClosedHistory, tabUrl: string, site: ClosedPagesScope['site']): ClosedHistory | undefined {
  if (site === undefined) return undefined
  if (!history.entries.some((page) => onSite(page.url, site))) return history
  const kept = history.entries.filter((page) => !onSite(page.url, site))
  const index = history.entries.slice(0, history.index).filter((page) => !onSite(page.url, site)).length
  return cleanClosedHistory({ entries: kept, index }, tabUrl)
}

/** The part of an archived tab that this reads and changes. */
interface ArchivedLists {
  spaceId: string
  url: string
  history?: ClosedHistory
}

/**
 * The archive after `scope` forgot pages: the entries whose space `inProfile` says is the profile's lose their list (or the site's pages of it),
 * every other entry is untouched. The same array when nothing changed (the reducer returns the same state then).
 */
export function archiveAfterForgetting<T extends ArchivedLists>(archive: readonly T[], scope: ClosedPagesScope, inProfile: (spaceId: string) => boolean): readonly T[] {
  let changed = false
  const next = archive.map((entry) => {
    if (entry.history === undefined || !inProfile(entry.spaceId)) return entry
    const after = closedHistoryAfter(entry.history, entry.url, scope.site)
    if (after === entry.history) return entry
    changed = true
    const { history: _forgotten, ...rest } = entry
    return (after === undefined ? rest : { ...rest, history: after }) as T
  })
  return changed ? next : archive
}
