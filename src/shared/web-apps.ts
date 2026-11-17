// "Ouvrir comme application" (setting `webAppWindows`): a site in a window of its own, without the sidebar, showing one site with its icon
// and its name, in the session of the space the tab came from (so its logins carry over). Pure rules: what may be opened, the name and the
// icon the header shows, and which links stay in the window. The window itself is main/shell/web-apps.ts. Main process only (it brings the
// public suffix list along, through party.ts): the interface reads the height of the header from ipc.ts.

import { activeTab } from './sidebar'
import type { SidebarState, TabItem } from './model'
import { siteOf } from './party'
import { profileOfSpace } from './profiles'
import { printable, readLaterFavicon } from './state-clean'
import { tidyTitle } from './tidy'
import { hostOf } from './url'

/** Windows open at once: each is a page of its own, and a site opened eight times is not a use that needs more. */
export const WEB_APPS_MAX = 8
export const WEB_APP_NAME_MAX = 40
export const WEB_APP_URL_MAX = 4096

export interface WebAppRequest {
  /** The page the window opens on (an http(s) address). */
  url: string
  name: string
  /** The icon of the site as the tab had it: a web address or a small `data:image/…`; absent when it had none. */
  icon?: string
  /** The profile (session) of the space the tab was in. */
  profileId: string
  /** The space the tab was in: the window closes when a lock holds that space shut. */
  spaceId: string
}

/** An http(s) address with no login in it, short enough to be kept whole. */
export function isWebAppUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > WEB_APP_URL_MAX || !/^https?:\/\//i.test(value) || !URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
}

/** The name the header shows: the one the user gave the tab, else the site's name taken from the title ("Boîte de réception (3) - Gmail" is "Gmail"), else its host. */
export function webAppName(tab: Pick<TabItem, 'title' | 'customTitle' | 'url'>): string {
  const own = printable(tab.customTitle, WEB_APP_NAME_MAX)?.trim()
  const tidy = printable(tidyTitle(tab.title, tab.url), WEB_APP_NAME_MAX)?.trim()
  return own || tidy || hostOf(tab.url).slice(0, WEB_APP_NAME_MAX) || 'Application'
}

/**
 * What opening a tab as an application asks for, or null when it cannot be one: the function is off, the tab is gone, private (its session is
 * thrown away and nothing of it is kept), or is not a web page. `tabId` absent means the tab on screen.
 */
export function webAppRequest(state: SidebarState, tabId?: string): WebAppRequest | null {
  if (!state.settings.webAppWindows) return null
  const tab = tabId === undefined ? activeTab(state) : state.tabs.find((t) => t.id === tabId)
  if (!tab || tab.private === true || !isWebAppUrl(tab.url)) return null
  const icon = readLaterFavicon(tab.faviconUrl)
  return { url: tab.url, name: webAppName(tab), ...(icon ? { icon } : {}), profileId: profileOfSpace(state, tab.spaceId), spaceId: tab.spaceId }
}

/** A link the page of the window opens in a new window: it stays in the application when it is the same site, else it goes to the browser, as a tab. */
export function staysInApp(startUrl: string, target: string): boolean {
  const site = siteOf(target)
  return site !== null && site === siteOf(startUrl)
}
