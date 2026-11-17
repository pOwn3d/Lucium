// Geometry of Glance, the link preview.

import type { PlatformId } from './platform'
import { toolbarAddress } from './toolbar'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The card is 88 % of the page card wide, centred, and 2 px short of its top and bottom edges. An 80 % card would leave room
 * on the right for three round buttons; the actions are written in the header, so the card takes that room.
 */
export const PEEK_WIDTH_RATIO = 0.88
export const PEEK_VERTICAL_INSET = 2

/** The edge of the card, in the colour of the space, and the corner radius of the card and of the page inside the edge. */
export const PEEK_BORDER = 2
export const PEEK_RADIUS = 8
export const PEEK_PAGE_RADIUS = PEEK_RADIUS - PEEK_BORDER

/** The Glance card (header included) over a page card. */
export function peekCardRect(stage: Rect): Rect {
  const width = Math.floor(stage.width * PEEK_WIDTH_RATIO)
  return {
    x: stage.x + Math.round((stage.width - width) / 2),
    y: stage.y + PEEK_VERTICAL_INSET,
    width,
    height: Math.max(0, stage.height - PEEK_VERTICAL_INSET * 2)
  }
}

/** Where the previewed page goes: inside the edge of the card, under the header. Sizes in the unit of `card` (points: the caller scales `header` and `border`). */
export function peekPageRect(card: Rect, header: number, border: number): Rect {
  return {
    x: card.x + border,
    y: card.y + border + header,
    width: Math.max(0, card.width - border * 2),
    height: Math.max(0, card.height - header - border * 2)
  }
}

/** The colour of the space for the edge of the card and the progress line: the accent of the design tokens, from the hue of the space. */
export function peekAccent(hue: number, dark: boolean): string {
  const h = Number.isFinite(hue) ? Math.round(((hue % 360) + 360) % 360) : 222
  return dark ? `hsl(${h} 80% 66%)` : `hsl(${h} 78% 44%)`
}

/** The ink on the accent: white, or the dark ink of the tokens on the accent of a dark window and on the greens and yellows (hues 60 to 170), where white would not read. */
export function peekOnAccent(hue: number, dark: boolean): string {
  const h = Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : 222
  return dark || (h >= 60 && h <= 170) ? '#0c0f1a' : '#ffffff'
}

/** ⌘↩ (Ctrl+Enter away from macOS), the key of "Ouvrir dans un onglet" (the header writes it on the button): the main modifier and Return alone, in the preview or in its header. */
export function isPeekOpenKey(input: { key: string; meta: boolean; shift: boolean; alt: boolean; control: boolean }, platform: PlatformId): boolean {
  const modifiers = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  return input.key === 'Enter' && modifiers && !input.shift && !input.alt
}

/**
 * The address as the header shows it, in parts. `host` is the host of the parsed address (never the « name@ » an address may carry before it, which
 * would read as the site: `https://bank.example@evil.example/` is a page of evil.example); the header draws it so that the registrable domain is
 * never cut (toolbar.ts `hostParts`). `rest` is the path and what follows, without a lone trailing slash. `insecure` says the page comes over plain
 * http, which the header writes out since the scheme is not shown. What is not an address is `rest` alone, as it is.
 */
export interface PeekAddress {
  host: string
  rest: string
  insecure: boolean
}

export function peekAddressParts(url: string): PeekAddress {
  const { host, rest } = toolbarAddress(url, true)
  if (host === '') return { host: '', rest: url, insecure: false }
  return { host, rest, insecure: new URL(url).protocol === 'http:' }
}

/** The address of the header as one text (the name of the dialog, the letter that stands for a missing icon): the host, then the path. */
export function peekAddress(url: string): string {
  const { host, rest } = peekAddressParts(url)
  return `${host}${rest}`
}
