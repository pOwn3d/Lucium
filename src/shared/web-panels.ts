// Web panels ("Volets web"): a list of sites kept by space and opened one at a time in a panel beside the page, with the session of the
// space's profile. Pure rules for the list (what an address may be, how many there are, how the file is read back) and for the requests the
// interface makes; the panel itself is a native view docked like an extension's side panel (shell/browser.ts).

import type { Space, WebPanel } from './model'
import { hostnameOf } from './url'
import { t } from './i18n'
import { settingsPath } from './settings-path'

/** The most sites a space keeps. */
export const WEB_PANELS_MAX = 12
export const WEB_PANEL_TITLE_MAX = 80
export const WEB_PANEL_URL_MAX = 2048

const CONTROL = /\p{Cc}/u

/** The address of a web panel: an http(s) page, short enough to be kept whole, with no identifier typed in it and nothing unprintable. */
export function webPanelUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > WEB_PANEL_URL_MAX || value !== value.trim() || CONTROL.test(value)) return null
  if (!URL.canParse(value)) return null
  const url = new URL(value)
  // A login in the address would be shown nowhere and sent everywhere.
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '' || url.username !== '' || url.password !== '') return null
  return value
}

/**
 * The name over the open panel. A panel is a page like any other: a link, a redirect or a sign-in can take it to another site than the one it is
 * named for, and nothing else in the window says where it is. While it is on the site of its address the name is enough; elsewhere the name is
 * followed by the site the panel shows now.
 */
export function webPanelHeading(title: string, panelUrl: string, shownUrl: string | undefined): string {
  const shown = shownUrl === undefined ? '' : hostnameOf(shownUrl)
  return shown === '' || shown === hostnameOf(panelUrl) ? title : `${title} · ${shown}`
}

/** The name the list shows: the title it was given, else the site's name. */
export function webPanelTitle(title: unknown, url: string): string {
  const text = typeof title === 'string' ? title.replace(/\p{Cc}/gu, ' ').trim().slice(0, WEB_PANEL_TITLE_MAX).trim() : ''
  return text || hostnameOf(url) || url.slice(0, WEB_PANEL_TITLE_MAX)
}

/** The list a file holds, repaired: each entry needs an id and an address, an address is kept once, and the list stops at the limit. */
export function cleanWebPanels(raw: unknown): WebPanel[] {
  const out: WebPanel[] = []
  const ids = new Set<string>()
  const urls = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= WEB_PANELS_MAX) break
    if (typeof entry !== 'object' || entry === null) continue
    const { id, url, title } = entry as Record<string, unknown>
    const address = webPanelUrl(url)
    if (typeof id !== 'string' || id === '' || id.length > 256 || id === '__proto__' || ids.has(id) || address === null || urls.has(address)) continue
    ids.add(id)
    urls.add(address)
    out.push({ id, url: address, title: webPanelTitle(title, address) })
  }
  return out
}

/** Why a site could not be added; null when it can. */
export type WebPanelRefusal = 'invalid' | 'duplicate' | 'full'

export function webPanelRefusal(panels: readonly WebPanel[] | undefined, url: unknown): WebPanelRefusal | null {
  const address = webPanelUrl(url)
  if (address === null) return 'invalid'
  const list = panels ?? []
  if (list.some((p) => p.url === address)) return 'duplicate'
  return list.length >= WEB_PANELS_MAX ? 'full' : null
}

export const WEB_PANEL_REFUSALS: Record<WebPanelRefusal, string> = {
  get invalid() { return t('web-panels.seule-une-page-web-http-ou-https-peut-devenir') },
  get duplicate() { return t('web-panels.ce-site-est-deja-dans-les-volets-de-cet-espace') },
  get full() { return t('web-panels.un-espace-garde-max-volets-au-plus', { max: WEB_PANELS_MAX }) }
}

/** The space's list with a site added at the end; the list itself when the site cannot be added (`webPanelRefusal` says why). */
export function withWebPanel(space: Space, panel: { id: string; url: string; title?: string }): Space {
  if (webPanelRefusal(space.webPanels, panel.url) !== null) return space
  const url = panel.url
  return { ...space, webPanels: [...(space.webPanels ?? []), { id: panel.id, url, title: webPanelTitle(panel.title, url) }] }
}

/** The space without that site; without the key at all when it was the last, so that a space with no panels is a space as it was before. */
export function withoutWebPanel(space: Space, panelId: string): Space {
  if (!space.webPanels?.some((p) => p.id === panelId)) return space
  const { webPanels: _old, ...rest } = space
  const left = space.webPanels.filter((p) => p.id !== panelId)
  return left.length > 0 ? { ...rest, webPanels: left } : rest
}

/** What the interface may ask of the main process about web panels. */
export type WebPanelRequest =
  /** Opens (or, when it is the open one, closes) the panel of that id in the space on screen. */
  | { op: 'open'; panelId: string }
  /** Adds the page on screen to the space's list. */
  | { op: 'add' }
  /** Puts the open web panel away. */
  | { op: 'close' }

export function parseWebPanelRequest(raw: unknown): WebPanelRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r['op'] === 'add' || r['op'] === 'close') return { op: r['op'] }
  if (r['op'] === 'open' && typeof r['panelId'] === 'string' && r['panelId'] !== '' && r['panelId'].length <= 256) return { op: 'open', panelId: r['panelId'] }
  return null
}

/** The sentence under a refusal, as the interface and the menus say it. */
export const webPanelsOff = (): string => t('web-panels.les-volets-web-sont-desactives', { settingsPath: settingsPath('webPanels') })
