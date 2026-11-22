// Third-party cookies: a cookie that goes to, or comes from, a site other than the one in the tab is not sent and not kept. Pure rules; the
// engine applies them to the headers of the requests (engine/electron-engine-network.ts). The cookies a script reads or writes itself
// (`document.cookie` in a frame of another site) are not reached: the headers are the only place the engine sees them.

import { isBlockingExempt, type ResponseHeaders } from './blocker'
import { siteOf } from './party'
import type { PrivacyOptions } from './privacy'

/** What `cookiesBlockedFor` needs to know of a request. */
export interface CookieRequest {
  url: string
  resourceType: string
  /** The address of the page in the tab the request belongs to: null when the session does not say (a request the browser made for itself). */
  topUrl: string | null
}

/**
 * Whether the cookies of this request are cut. Only a request of the web for a part of a page (an image, a script, a frame, a fetch…) whose
 * site differs from the tab's, on a page that is not on the list of exceptions. A navigation of the tab is the first party by definition, and a
 * request whose page is unknown is left alone: nothing is cut on the strength of an unknown.
 */
export function cookiesBlockedFor(request: CookieRequest, options: Pick<PrivacyOptions, 'blockThirdPartyCookies' | 'thirdPartyCookieExceptions'>): boolean {
  if (!options.blockThirdPartyCookies || request.resourceType === 'mainFrame') return false
  const mine = siteOf(request.topUrl)
  const theirs = siteOf(request.url)
  if (mine === null || theirs === null || mine === theirs) return false
  return !isBlockingExempt(request.topUrl, options.thirdPartyCookieExceptions)
}

/** The request headers without `Cookie`, whatever the case of the name. The same object when there is none. */
export function withoutCookieHeader(headers: Record<string, string>): Record<string, string> {
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'cookie')) return headers
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'cookie'))
}

/** The response headers without `Set-Cookie`, whatever the case of the name. The same object when there is none. */
export function withoutSetCookie(headers: ResponseHeaders): ResponseHeaders {
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'set-cookie')) return headers
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'set-cookie'))
}
