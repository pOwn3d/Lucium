// Whether a host is a whole family of sites rather than one site. A Tweak matches its host and every subdomain, so a shared Tweak for
// `co.uk`, `github.io` or `blogspot.com` would style every site under that name: the public suffix list (the exact one, as in
// shared/party.ts) says which names are such suffixes. Main process only: it brings the list along.

import { parse } from 'tldts'

/**
 * True for a name that is a public suffix (ICANN or private) or a name the list does not know at all as a site (a bare TLD): it has
 * no registrable domain. Not true for `localhost` and IP addresses, which `parseShareHost` accepted knowingly.
 */
export function isWideHost(host: string): boolean {
  if (host === 'localhost') return false
  const parsed = parse(host, { allowPrivateDomains: true })
  return !parsed.isIp && parsed.domain === null
}
