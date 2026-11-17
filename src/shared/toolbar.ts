// What the toolbar above the page shows and how it is laid out.

import { DISPLAY_ORIGIN, displayAddress, isInternalPageUrl } from './internal-page'
import { registrableDomain } from './tab-grouping'
import { luminance } from './theme'

/** The address as the toolbar draws it: the host in bold, then (with "show the full URL") the rest in the regular weight. */
export interface ToolbarAddress {
  host: string
  rest: string
}

/**
 * `www.` and the scheme never show. By default only the host does; with the full URL the path, query and fragment follow,
 * without a lone trailing slash (`resources.arc.net/hc/en-us`, not `https://resources.arc.net/hc/en-us/`).
 */
export function toolbarAddress(url: string, fullUrl: boolean): ToolbarAddress {
  // The Extensions page has no host to put in bold: the bar says `chrome://extensions` (addressLabel) and, with the full URL, what follows it.
  if (isInternalPageUrl(url)) return { host: '', rest: fullUrl ? displayAddress(url).slice(DISPLAY_ORIGIN.length) : '' }
  if (!URL.canParse(url)) return { host: '', rest: '' }
  const parsed = new URL(url)
  const host = parsed.host.replace(/^www\./, '')
  if (!fullUrl || !host) return { host, rest: '' }
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return { host, rest: rest === '/' ? '' : rest.replace(/\/$/, '') }
}

/**
 * A host in two parts for a place that may be too narrow for it: the subdomains, which give way first, and the registrable domain with its port, which is
 * always drawn. Cut by its end, `accounts.example.com.session-check.evil.example` would read « accounts.example.com.sess… » and hide the one name that
 * says whose site it is. A host that is no domain (an IP address, `localhost`) is one part.
 */
export function hostParts(host: string): { sub: string; domain: string } {
  const port = host.startsWith('[') ? '' : (/:\d+$/.exec(host)?.[0] ?? '')
  const name = host.slice(0, host.length - port.length)
  const domain = registrableDomain(name)
  return { sub: name.slice(0, name.length - domain.length), domain: domain + port }
}

/** One `<meta name="theme-color">` of a page: its colour, and whether its `media` condition holds right now (always, when it has none). */
export interface ThemeColorMeta {
  content: string
  applies: boolean
}

/**
 * The colour a page asks for. Several tags may exist, each for a colour scheme (`media`): the first one that applies wins, as
 * in Chromium. Anything else about the page (its background) does NOT tint the bar: the toolbar stays #3f3f3f above a white
 * page that declares no colour.
 */
export function pickThemeColor(metas: readonly ThemeColorMeta[]): string | null {
  const found = metas.find((meta) => meta.applies && meta.content.trim() !== '')
  return found ? found.content.trim() : null
}

/**
 * The script that reads those tags in a page (run by the engine, then handed to `pickThemeColor`). The colour is resolved by a
 * canvas, which accepts every CSS spelling (`white`, `hsl(...)`) without touching the page's DOM; a value the canvas rejects
 * leaves its sentinel in place and reads as no colour.
 */
export const READ_THEME_COLORS_SCRIPT = `(() => {
  const ctx = document.createElement('canvas').getContext('2d')
  const resolve = (value) => { ctx.fillStyle = '#010203'; ctx.fillStyle = value; return ctx.fillStyle === '#010203' && value.trim().toLowerCase() !== '#010203' ? '' : ctx.fillStyle }
  return [...document.querySelectorAll('meta[name="theme-color" i]')].map((m) => ({ content: resolve(m.getAttribute('content') || ''), applies: !m.media || matchMedia(m.media).matches }))
})()`

/**
 * Whether the bar is a light one: the colour the page asked for, else the default bar of the window's appearance (#3f3f3f in a
 * dark one). A light bar has dark glyphs and a 1 px line under it (#f2f2f2 on white); a dark bar has neither the line nor dark glyphs.
 */
export function toolbarIsLight(color: string | undefined, appearance: 'light' | 'dark'): boolean {
  return color ? luminance(color) > 0.5 : appearance === 'light'
}
