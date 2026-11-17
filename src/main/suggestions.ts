import { SEARCH_ENGINES } from '@shared/model'
import { isTypedAddress } from '@shared/url'

const SUGGEST_TIMEOUT_MS = 1500
const MAX_SUGGESTIONS = 6

/** The suggestion endpoint of the configured search engine, or undefined when it has none. */
export function suggestEndpoint(searchUrlTemplate: string): string | undefined {
  return SEARCH_ENGINES.find((e) => e.url === searchUrlTemplate)?.suggest
}

/** OpenSearch suggestions: `[query, [suggestion, ...], ...]`. Anything else yields no suggestion. */
export function parseSuggestions(payload: unknown): string[] {
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) return []
  return payload[1].filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, MAX_SUGGESTIONS)
}

/**
 * What a suggestion request leaves on the machine and what it sends. It goes through the application's own session: without these, the
 * answer to what was typed would be kept in the disk cache, and the cookies of that session would travel with it. Nothing is cached and no
 * credentials are sent. A private window and a private tab ask nothing at all (`typedStaysPrivate`, applied by the handler in shell/ipc.ts).
 */
export const SUGGEST_FETCH_INIT = { cache: 'no-store', credentials: 'omit' } as const

type Fetcher = (url: string, init: typeof SUGGEST_FETCH_INIT & { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Asks the search engine for completions. A slow or failing engine must never block typing: it logs and answers []. */
export async function fetchSuggestions(searchUrlTemplate: string, query: string, fetcher: Fetcher): Promise<string[]> {
  const endpoint = suggestEndpoint(searchUrlTemplate)
  const text = query.trim()
  // The check lives here, in the main process: the interface is not trusted to have filtered what it asks for.
  if (!endpoint || text.length < 2 || isTypedAddress(text)) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS)
  try {
    const response = await fetcher(endpoint.replace('%s', encodeURIComponent(text)), { ...SUGGEST_FETCH_INIT, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseSuggestions(await response.json())
  } catch (error) {
    console.warn(`[suggest] no suggestions from ${new URL(endpoint).host}:`, error instanceof Error ? error.message : error)
    return []
  } finally {
    clearTimeout(timer)
  }
}
