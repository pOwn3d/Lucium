// A form that holds a password and is sent to an `http:` address sends that password in the clear, for anyone on the way to read. The main process judges
// the message of the preload (form-guard-wire.ts) with this rule: it never takes the page's word for where the form goes. Pure.

import { isUpgradableHost } from './privacy'

/**
 * The host the password would travel to without encryption, or null when there is nothing to warn about: an address that is not `http:`, or a host of this
 * machine or of the local network (a router, a development server: no one can sign a certificate for them, `isUpgradableHost` reads the same list).
 * `action` is resolved against the address of the page that holds the form, as the browser does.
 */
export function insecureTarget(action: string, pageUrl: string): { host: string } | null {
  if (!URL.canParse(action, URL.canParse(pageUrl) ? pageUrl : undefined)) return null
  const target = new URL(action, URL.canParse(pageUrl) ? pageUrl : undefined)
  if (target.protocol !== 'http:' || !isUpgradableHost(target.hostname)) return null
  return { host: target.host }
}
