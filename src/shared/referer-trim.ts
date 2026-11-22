// The Referer sent to another site: the address of the page a request comes from, which can carry a path, a query and a token the other site has no
// business knowing. With the option on, a request to another site carries the origin of the page alone (`https://site.example/`, what the policy
// `strict-origin-when-cross-origin` of Chromium keeps for a cross-origin request), and the requests inside a site keep the whole address. Pure; the
// header hook of the engine applies it (engine/electron-engine-network.ts). `document.referrer`, which a script reads, is not reached.

import { siteOf } from './party'

/**
 * The Referer a request to `url` should carry instead of `referer`, or null to leave it as it is: the Referer is no web address, the request goes to
 * the site of the page it names, or it is already an origin.
 */
export function refererSentTo(url: string, referer: string): string | null {
  if (!URL.canParse(referer)) return null
  // `siteOf` knows web addresses only: a Referer that is a file or an opaque address, and a request that is no web request, are left alone.
  const mine = siteOf(referer)
  const theirs = siteOf(url)
  if (mine === null || theirs === null || mine === theirs) return null
  const trimmed = `${new URL(referer).origin}/`
  return trimmed === referer ? null : trimmed
}

/** The request headers with the Referer trimmed for a request to `url`, whatever the case of the name. The same object when there is nothing to trim. */
export function withTrimmedReferer(url: string, headers: Record<string, string>): Record<string, string> {
  const name = Object.keys(headers).find((key) => key.toLowerCase() === 'referer')
  if (name === undefined) return headers
  const trimmed = refererSentTo(url, headers[name]!)
  return trimmed === null ? headers : { ...headers, [name]: trimmed }
}
