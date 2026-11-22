// The hosts the blocker cancelled requests for on one page ("Détail des traqueurs par site"): which hosts, and how many requests each. Counted in memory by
// the blocking service, from the page's last load, and read by the panel of the site while it is open; nothing is written, kept or sent (a private tab has none).

/** How many different hosts the list of one page holds: a page that talks to more still counts them, it only does not name the rest. */
export const BLOCKED_HOSTS_PER_PAGE_MAX = 100

/** A host a page's requests were cancelled for, and how many. */
export interface BlockedHost {
  host: string
  count: number
}
