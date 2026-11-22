// "JavaScript" switch of a site: the sites on the list load their pages without running any script. Pure rules (which address is
// covered, what the list keeps, what is added to the answer of the server); the main process adds the policy to the main document of the
// listed sites (PageGuard) and the site panel offers the switch. Lucium's own pages (lucium://) never reach it: they are not web addresses.

import { parseSiteHost } from './site-data'

/** Sites on the list: more than anyone lists by hand, and a bound for a hand-edited file. */
export const SITE_JAVASCRIPT_MAX = 500

/**
 * What is added to the main document of a listed site. `script-src 'none'` stops every script the page holds or loads (inline, external, event
 * handlers, `javascript:` addresses, `eval`) of the main document. It is a Content-Security-Policy, so it adds to the site's own policy and can
 * only make it stricter. A frame the page embeds comes from its own answer and keeps its own scripts; `<noscript>` fallbacks are not shown.
 */
export const JAVASCRIPT_OFF_POLICY = "script-src 'none'; script-src-elem 'none'; script-src-attr 'none'"

/** The host of a web page's address (port included), or null for anything else: a start page, a file, the settings, a lucium:// page. */
export function javascriptHostOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return null
  return parseSiteHost(new URL(url).host)?.host ?? null
}

/** A saved or imported list: valid hosts only, spelled as the URL parser prints them, each once, no more than `SITE_JAVASCRIPT_MAX`. */
export function cleanSiteJavascriptOff(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const hosts = new Set<string>()
  for (const entry of raw) {
    const site = typeof entry === 'string' ? parseSiteHost(entry) : null
    if (site) hosts.add(site.host)
    if (hosts.size >= SITE_JAVASCRIPT_MAX) break
  }
  return [...hosts]
}

/** Whether JavaScript is off for the site of `url` (its exact host: a subdomain is another site). */
export function isJavascriptOff(list: readonly string[], url: string): boolean {
  const host = javascriptHostOf(url)
  return host !== null && list.includes(host)
}

/**
 * The list with a site added (`off` true) or taken out. `site` is a host or a whole address; something that is not a web host changes nothing,
 * and neither does adding a site already on the list or taking out one that is not. A list that is full refuses one more.
 */
export function setJavascriptOff(list: readonly string[], site: unknown, off: boolean): string[] {
  const host = typeof site === 'string' ? (javascriptHostOf(site) ?? parseSiteHost(site)?.host ?? null) : null
  if (host === null) return [...list]
  if (!off) return list.filter((entry) => entry !== host)
  return list.includes(host) || list.length >= SITE_JAVASCRIPT_MAX ? [...list] : [...list, host]
}

/** The policy to add to the main document at `url`: the one that stops scripts for a listed site, nothing for any other address. */
export function javascriptPolicyFor(list: readonly string[], url: string): string | null {
  return isJavascriptOff(list, url) ? JAVASCRIPT_OFF_POLICY : null
}
