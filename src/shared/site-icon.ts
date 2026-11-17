// The icon of a site as the interface draws it. The state names an icon by the address the page declared (`faviconUrl`); the interface never
// asks that address itself. It asks the main process, under a scheme only its own session serves, for the copy the main process downloaded
// once in the profile of the tab: with the cookies of that profile and behind its blocker, as the page itself would have loaded it. A private
// tab and a tab of a container never come here: their icon is handed over as data by their own session (engine/ephemeral-scope.ts).
//
// Pure: the addresses, who an icon is downloaded for, and what is served. The downloads are in main/engine/site-icons.ts.

import { FAVICON_URL_MAX, iconAllowedFor, iconTarget, isPublicHost, sniffImage, type SniffedFormat } from './favicon'
import type { SidebarState } from './model'
import { profileOfSpace } from './profiles'

/** The scheme the copies are served under. It is declared before the application is ready (main/index.ts) and served in the session of the interface only. */
export const ICON_SCHEME = 'lucium-icon'
/** `standard` so that the address is read like a web one (a host, a query); `secure` so that a page of the interface may always draw it. */
export const ICON_PRIVILEGES = { standard: true, secure: true } as const

const ICON_HOST = 'site'
const INLINE = /^data:image\//i
const REMOTE = /^https?:\/\//i

/**
 * What an `<img>` of the interface is given for an icon of the state: the picture itself when the state holds it as data, the address of
 * the main process's copy when the state names a web address, and nothing for anything else. Never the web address.
 */
export function iconSource(faviconUrl: string | null | undefined): string | undefined {
  if (typeof faviconUrl !== 'string' || faviconUrl === '') return undefined
  if (INLINE.test(faviconUrl)) return faviconUrl
  if (!REMOTE.test(faviconUrl) || faviconUrl.length > FAVICON_URL_MAX) return undefined
  return `${ICON_SCHEME}://${ICON_HOST}/?u=${encodeURIComponent(faviconUrl)}`
}

/** The web address of the icon a request of the interface asks the copy of, or null when the request is not one `iconSource` made. */
export function iconAddressOf(request: string): string | null {
  if (typeof request !== 'string' || request.length > FAVICON_URL_MAX * 4 || !URL.canParse(request)) return null
  const url = new URL(request)
  if (url.protocol !== `${ICON_SCHEME}:` || url.hostname !== ICON_HOST || url.pathname !== '/') return null
  const address = url.searchParams.get('u')
  if (address === null || address.length > FAVICON_URL_MAX || !URL.canParse(address)) return null
  const icon = new URL(address)
  if ((icon.protocol !== 'https:' && icon.protocol !== 'http:') || icon.hostname === '' || icon.username !== '' || icon.password !== '') return null
  return address
}

const SERVED_TYPES: Record<SniffedFormat, string> = { png: 'image/png', ico: 'image/x-icon', gif: 'image/gif', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' }

/** The type a copy is served with: what its first bytes are, never what the site said it was. Null for bytes that are no picture. */
export function servedIconType(bytes: Uint8Array): string | null {
  const format = sniffImage(bytes)
  return format === null ? null : SERVED_TYPES[format]
}

/** Who an icon is downloaded for: the profile whose session asks, and the page that shows it (what the blocker judges the picture against). */
export interface SiteIconOwner {
  profileId: string
  pageUrl: string
}

/** A profile id as the state writes it: anything else names no session. */
const PROFILE_ID = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Whether an icon the state names may be downloaded for the page that carries it. The state is a file: one restored from elsewhere could name
 * any address as an icon, and the download goes with the cookies of a profile. So the icon must be one the page could declare (`iconAllowedFor`),
 * and it must be on the public Internet or on the host of the page itself (the icon of a page of the local network is on that page's host).
 */
function mayStandFor(iconUrl: string, pageUrl: string): boolean {
  if (!iconAllowedFor(iconUrl, pageUrl)) return false
  const icon = new URL(iconUrl)
  return isPublicHost(icon.hostname) || iconTarget(pageUrl)?.host === icon.host
}

/**
 * Who the state says an icon belongs to, or null when nothing of the state shows it: the tab that carries it (the profile of its space), then
 * the favourite (its own profile), then a page read later or a bookmark, which belong to no profile and take the one of the space the first
 * window shows, where a click would open them. A private tab and a tab in a container are never owners: their icon is handed over as data by
 * their own session (engine/ephemeral-scope.ts), and nothing of them is asked with the cookies of the profile.
 * `states` are the views of the windows; the first is the main one.
 */
export function siteIconOwner(iconUrl: string, states: readonly SidebarState[]): SiteIconOwner | null {
  const owned = (profileId: string, pageUrl: string): SiteIconOwner | null => (PROFILE_ID.test(profileId) && mayStandFor(iconUrl, pageUrl) ? { profileId, pageUrl } : null)
  for (const state of states) {
    for (const tab of state.tabs) {
      if (tab.faviconUrl !== iconUrl || tab.private === true || tab.container !== undefined) continue
      const owner = owned(profileOfSpace(state, tab.spaceId), tab.url)
      if (owner) return owner
    }
  }
  const first = states[0]
  if (!first) return null
  for (const favorite of first.favorites) {
    if (favorite.faviconUrl !== iconUrl) continue
    const owner = owned(favorite.profileId ?? 'default', favorite.url)
    if (owner) return owner
  }
  const shown = profileOfSpace(first, first.activeSpaceId)
  for (const item of [...first.readLater, ...first.bookmarks]) {
    if (item.faviconUrl !== iconUrl) continue
    const owner = owned(shown, item.url)
    if (owner) return owner
  }
  return null
}
