// "Unread count" switch of a site: the sites on the list show no count and no mark on the row of their tabs, whatever their title says (a title
// that gives a wrong count is the reason to turn it off). Pure rules (what the list keeps, which page it covers, what a row then shows); the shell
// applies them when a title arrives and the site panel offers the switch. The global `tabStateBadges` switch is not involved.

import { autoplayHostOf, autoplayKeyOf } from './autoplay'

/** Sites on the list: more than anyone lists by hand, and a bound for a hand-edited file. */
export const SITE_UNREAD_OFF_MAX = 500

/** A saved or imported list: hosts written any way ("Example.com", "www.example.com") under their canonical key, each once, no more than `SITE_UNREAD_OFF_MAX`. */
export function cleanSiteUnreadOff(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const hosts = new Set<string>()
  for (const entry of raw) {
    const key = autoplayKeyOf(entry)
    if (key !== null) hosts.add(key)
    if (hosts.size >= SITE_UNREAD_OFF_MAX) break
  }
  return [...hosts]
}

/** The list with a site added (`off` true) or taken out. Something that is not a web host changes nothing; a full list refuses one more. */
export function withSiteUnreadOff(list: readonly string[], site: unknown, off: boolean): string[] {
  const key = autoplayKeyOf(site)
  if (key === null) return [...list]
  if (!off) return list.filter((entry) => entry !== key)
  return list.includes(key) || list.length >= SITE_UNREAD_OFF_MAX ? [...list] : [...list, key]
}

/** Whether the page at `url` is on the list: its own host or a parent domain ("mail.example.com" follows "example.com"; "notexample.com" does not). */
export function isUnreadOff(list: readonly string[], url: string): boolean {
  const host = autoplayHostOf(url)
  if (host === null) return false
  const labels = host.split('.')
  for (let at = 0; at < labels.length; at++) if (list.includes(labels.slice(at).join('.'))) return true
  return false
}
