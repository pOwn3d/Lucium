// An address typed in the command bar that is one keystroke away from a site the person already uses (`gogle.com` for `google.com`) may be a typo, or a
// site made to catch it. The comparison is local: the sites are those of the person's own history, bookmarks, favourites and pinned tabs, and no list of
// other people's sites is read or sent. A pure decision, so that the threshold is tested on its own (typo-guard.test.ts).

import { siteOf } from './party'

/** A site of fewer characters than this (`x.com`, `t.co`) is one keystroke from too many others: never a reason to warn. */
export const TYPO_MIN_LENGTH = 8

/** Whether two strings are one edit apart: one letter added, dropped or changed, or two neighbouring letters swapped. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  if (a.length === b.length) {
    // One letter changed, or two neighbours swapped.
    let end = a.length - 1
    while (end > start && a[end] === b[end]) end--
    if (end === start) return !(/\d/.test(a[start]!) && /\d/.test(b[start]!))
    return end === start + 1 && a[start] === b[end] && a[end] === b[start]
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a]
  return long.slice(start + 1) === short.slice(start)
}

const siteOfHost = (host: string): string | null => siteOf(`https://${host}`)

/**
 * The site of the person that `typedHost` looks like, or null. Null when the typed site is itself one they use, when it shares its site with a known one
 * (`api.example.com` and `app.example.com` are one site), when the known site is short, and when the only difference is a digit for another (`web1` and
 * `web2`: servers are numbered). `knownHosts` may hold a host many times.
 */
export function lookalikeOf(typedHost: string, knownHosts: Iterable<string>): string | null {
  const typed = siteOfHost(typedHost.trim().toLowerCase().replace(/:\d+$/, ''))
  if (typed === null || !typed.includes('.') || /^[\d.]+$/.test(typed)) return null
  const known = new Set<string>()
  for (const host of knownHosts) {
    const site = siteOfHost(host.trim().toLowerCase().replace(/:\d+$/, ''))
    if (site !== null) known.add(site)
  }
  if (known.has(typed)) return null
  for (const site of known) if (site.length >= TYPO_MIN_LENGTH && oneEditApart(typed, site)) return site
  return null
}
