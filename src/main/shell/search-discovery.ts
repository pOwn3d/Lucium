// The search engines a site declares (OpenSearch), offered once per site (see shared/opensearch.ts for the rules and what is read).
// A notice says "Ajouter la recherche dans « Exemple » ?" with one button. The page is looked at once its load is over and only when the
// setting is on; nothing is requested from the network until the button is pressed, and then once, for the description file.

import { cleanDeclaredSearches, discoverableHost, discoveryOffer, OPENSEARCH_FETCH_TIMEOUT_MS, OPENSEARCH_FILE_MAX, parseOpenSearch, rememberSearchHost, siteSearchFromDescription, type DeclaredSearch } from '@shared/opensearch'
import type { SidebarState, SiteSearch } from '@shared/model'
import { SITE_SEARCHES_MAX } from '@shared/state-clean'
import { t } from '@shared/i18n'

/** How long the notice stays (the usual notices last 5 s: this one asks a question). */
export const DISCOVERY_NOTICE_MS = 12_000
/** Hosts examined during this session are not examined again; the list is dropped past this size. */
const CHECKED_MAX = 500

/** The part of a `Response` the reading of a description file uses. */
export interface FetchedResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}
export type DescriptionFetcher = (url: string, init: { cache: 'no-store'; credentials: 'omit'; redirect: 'error'; signal: AbortSignal }) => Promise<FetchedResponse>

/**
 * One GET for a description file: no cache, no cookie, no redirect (a file that moves elsewhere is not the site's own), a few seconds,
 * and no more than `OPENSEARCH_FILE_MAX` bytes. Rejects with the reason when any of that is not met.
 */
export async function fetchDescription(url: string, fetcher: DescriptionFetcher): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENSEARCH_FETCH_TIMEOUT_MS)
  try {
    const response = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const announced = Number(response.headers.get('content-length'))
    if (Number.isFinite(announced) && announced > OPENSEARCH_FILE_MAX) throw new Error(`file too large (${announced} bytes)`)
    if (!response.body) throw new Error('empty answer')
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > OPENSEARCH_FILE_MAX) {
        await reader.cancel().catch(() => {})
        throw new Error(`file too large (over ${OPENSEARCH_FILE_MAX} bytes)`)
      }
      parts.push(value)
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(parts))
  } finally {
    clearTimeout(timer)
  }
}

export interface DiscoveryHost {
  state(): SidebarState
  /** Keeps the host in `searchDiscoverySeen`. */
  remember(seen: string[]): void
  addSearch(site: SiteSearch): void
  notice(message: string, action?: { label: string; run: () => void }, durationMs?: number): void
  fetchDescription(url: string): Promise<string>
}

export class SearchDiscovery {
  private readonly checked = new Set<string>()

  constructor(private readonly host: DiscoveryHost) {}

  /**
   * Looks at the page that just finished loading, and offers its search when there is one to offer. `read` gives what the page declares
   * (the raw links of DECLARED_SEARCH_SCRIPT) and rejects when the page is gone. Never throws.
   */
  async check(pageUrl: string, read: () => Promise<unknown>): Promise<void> {
    const host = discoverableHost(pageUrl)
    if (host === null || !this.host.state().settings.searchDiscovery || this.checked.has(host) || this.host.state().settings.searchDiscoverySeen.includes(host)) return
    if (this.checked.size >= CHECKED_MAX) this.checked.clear()
    this.checked.add(host)
    let raw: unknown
    try {
      raw = await read()
    } catch (error) {
      // The page went away or navigated while it was read: nothing to offer, and the site will be looked at again next time.
      this.checked.delete(host)
      console.debug(`[search] cannot read what ${host} declares:`, error instanceof Error ? error.message : String(error))
      return
    }
    const offer = discoveryOffer(this.host.state(), pageUrl, cleanDeclaredSearches(raw, pageUrl))
    if (!offer) return
    // Once per site, whatever the answer: it is recorded as the notice appears.
    this.host.remember(rememberSearchHost(this.host.state().settings.searchDiscoverySeen, host))
    this.host.notice(t('search-discovery.ajouter-la-recherche-dans-title', { title: offer.title || host }), { label: t('settings.ajouter'), run: () => void this.accept(offer, host, pageUrl) }, DISCOVERY_NOTICE_MS)
  }

  private async accept(offer: DeclaredSearch, host: string, pageUrl: string): Promise<void> {
    try {
      const description = parseOpenSearch(await this.host.fetchDescription(offer.href), pageUrl)
      if (!description) throw new Error('the file declares no web search it can keep')
      const searches = this.host.state().settings.siteSearches
      if (searches.length >= SITE_SEARCHES_MAX) return this.host.notice(t('search-discovery.la-liste-des-recherches-dans-un-site-est-pleine'))
      const site = siteSearchFromDescription(description, offer, host, searches.map((s) => s.keyword))
      this.host.addSearch(site)
      this.host.notice(t('search-discovery.recherche-ajoutee-tapez-keyword-puis-tab-dans', { keyword: site.keyword }))
    } catch (error) {
      console.warn(`[search] cannot add the search of ${host}:`, error instanceof Error ? error.message : String(error))
      this.host.notice(t('search-discovery.cette-recherche-n-a-pas-pu-etre-ajoutee'))
    }
  }
}
