// Safe browsing: before a page of the web opens, its host is compared with two lists that travel with the application (a snapshot of public
// lists of phishing hosts and of malware hosts, renewed with each version: docs/fonctions.md). The comparison happens on this machine; no address
// you visit is ever sent anywhere, and the feature opens no connection at all. Off by default. Pure rules; main/safe-browsing.ts reads the files,
// main/shell/browser-network.ts closes the main frame, engine/error-pages.ts shows the page that warns.
//
// What is compared: the host of an `http:` or `https:` address, exactly (a listed `sites.example` does not make `example` or `www.example` suspect:
// a list names hosts, and widening a name to its parents would flag every site of a hosting service). Never an internal page (`lucium:`, `file:`,
// `about:`), a name of the local network, or an address with a port on `localhost`.

import { BLOCK_EXCEPTIONS_MAX, isBlockingExempt, cleanBlockExceptions } from './blocker'
import type { Settings } from './model'
import { hasLocalOnlySuffix } from './url'

export type SafeCategory = 'phishing' | 'malware'

/** The sites where the warning is never shown: more than anyone writes by hand, and a bound for a hand-edited file. */
export const SAFE_BROWSING_EXCEPTIONS_MAX = BLOCK_EXCEPTIONS_MAX

/** The sites of the list as a saved file or a message may carry them: valid hosts, each once, at most `SAFE_BROWSING_EXCEPTIONS_MAX`. */
export const cleanSafeBrowsingExceptions = (raw: unknown): string[] => cleanBlockExceptions(raw)

/** What a verdict needs to look a host up: the two lists (each is a `has`), kept apart so that the page can say which kind of danger it is. */
export interface SafeLists {
  phishing: { has(host: string): boolean } | null
  malware: { has(host: string): boolean } | null
}

/** The host to compare for an address, or null when the address is not one the feature looks at (see the head of the file). */
export function hostToCheck(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.startsWith('[') || hasLocalOnlySuffix(host)) return null
  return host
}

export interface SafeVerdict {
  category: SafeCategory
  host: string
}

/**
 * Whether an address is on a list: the kind of danger and the host, or null. The sites the user excepted (and their subdomains) are never reported,
 * nor the hosts they allowed for this session (`allowed`, kept in memory by main/safe-browsing.ts and gone with the application).
 */
export function safeVerdict(url: string, lists: SafeLists, exceptions: readonly string[], allowed: ReadonlySet<string> = new Set()): SafeVerdict | null {
  const host = hostToCheck(url)
  if (host === null || allowed.has(host) || isBlockingExempt(url, exceptions)) return null
  if (lists.phishing?.has(host)) return { category: 'phishing', host }
  if (lists.malware?.has(host)) return { category: 'malware', host }
  return null
}

/** The safe browsing settings of a saved file: anything but `true` is off, so a damaged file never closes a page on its own. */
export function cleanSafeBrowsingSettings(settings: Partial<Pick<Settings, 'safeBrowsing' | 'safeBrowsingExceptions'>>): Pick<Settings, 'safeBrowsing' | 'safeBrowsingExceptions'> {
  return { safeBrowsing: settings.safeBrowsing === true, safeBrowsingExceptions: cleanSafeBrowsingExceptions(settings.safeBrowsingExceptions) }
}
