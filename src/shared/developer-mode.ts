// Developer Mode, per site (View › Developer › "Turn On Developer Mode for This Site", ⌃D; a row in the site's control center).
//
// The mode is a per-host list. On a developer site the page is reloaded without the HTTP cache (what a developer wants after editing
// a file), switching the row of the site panel on shows the developer tools, the site is marked in the sidebar data (`isDeveloperTab`), and
// its invalid certificate goes through without the error page (a preproduction on `.local`, `localhost` or a private address; see
// engine/certificate-error.ts), the tab then saying « Non sécurisé ». It is the only place where Lucium lets a certificate through unasked.

import { normalizeBlockHost } from './blocker'
import { t } from './i18n'
import type { Action } from './sidebar'

/** Sites in the list: a bound for a hand-edited file, far more than anyone marks. */
export const DEVELOPER_HOSTS_MAX = 100

/** What a saved list may hold: valid hosts only, each once, in order. */
export function cleanDeveloperHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts = new Set<string>()
  for (const entry of value) {
    const host = normalizeBlockHost(entry)
    if (host) hosts.add(host)
    if (hosts.size >= DEVELOPER_HOSTS_MAX) break
  }
  return [...hosts]
}

const covers = (entry: string, host: string) => host === entry || host.endsWith(`.${entry}`)

/** Whether a page (its address) is on a listed host or one of its subdomains. */
export function isDeveloperUrl(pageUrl: string | null | undefined, hosts: readonly string[]): boolean {
  if (hosts.length === 0 || !pageUrl || !URL.canParse(pageUrl)) return false
  const host = new URL(pageUrl).hostname.replace(/^www\./, '')
  return hosts.some((entry) => covers(entry, host))
}

/** The list with a site turned on or off. Turning off removes every entry that covers the site, a parent domain included. */
export function setDeveloperHost(hosts: readonly string[], site: string, enabled: boolean): string[] {
  const host = normalizeBlockHost(site)
  if (!host) return [...hosts]
  if (!enabled) return hosts.filter((entry) => !covers(entry, host))
  return hosts.some((entry) => covers(entry, host)) ? [...hosts] : cleanDeveloperHosts([...hosts, host])
}

/** The label of the menu entry (two wordings), for the page it acts on. */
export function developerModeLabel(on: boolean): string {
  return on ? t('menu.disable-developer-mode') : t('menu.enable-developer-mode')
}

/**
 * Whether an action from the interface that was just applied also shows the page's developer tools: the Developer Mode row of the site panel,
 * switched ON (the list of sites changed: a refused action opens nothing). Switching it off leaves the tools as they are. The menu and ⌃D
 * dispatch from the shell and do not go through here.
 */
export function developerModeOpensTools(action: Action, before: readonly string[], after: readonly string[]): boolean {
  return action.type === 'developer/site' && action.enabled === true && (after.length !== before.length || after.some((host, i) => host !== before[i]))
}
