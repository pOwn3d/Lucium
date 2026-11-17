// Popup windows of pages. A page that opens a window with a list of features (`window.open(url, name, 'width=500,height=600')`) wants a
// real window it can talk to (`window.opener`, `postMessage`, `window.close()`): that is how the sign-in pages of identity providers, PayPal or a 3-D Secure
// page sign someone in. A link, a script that gives no features and a Shift+click are not that: they stay a tab or a Glance.
// Everything here is pure: what the page asked for is read and bounded here, and the engine only applies the answer (electron-engine.ts).
// Which addresses a page or a popup may be on is `isPageOpenUrl` (external-links.ts): the web and the blank page, nothing else.

import { clamp } from './clamp'
import { t } from './i18n'

/** A tab holds at most this many popups at once (the popup of a popup counts for the tab it all started from). */
export const MAX_POPUPS_PER_TAB = 3

/** The size of a popup that asks for none, and the bounds of one that asks for something: a 1-pixel popup is a way to hide a window. */
export const POPUP_DEFAULT_SIZE = { width: 520, height: 640 } as const
export const POPUP_MIN_SIZE = { width: 240, height: 160 } as const

/** Of what a page writes in the feature list, only this much is read: it is attacker-controlled text. */
export const FEATURES_MAX_CHARS = 2048
export const FEATURES_MAX_ENTRIES = 64

/** The title bar and the border around the content of a window: kept inside the screen along with the content. */
export const POPUP_FRAME_HEIGHT = 40

/** What of the title the page gives is shown after the host of the page (the title bar is the only place that says whose page it is). */
export const POPUP_TITLE_MAX_CHARS = 80

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  x: number
  y: number
}

/** The features a page gave, as the HTML specification reads them (names in lower case, the last value of a repeated name wins). */
export interface Features {
  entries: ReadonlyMap<string, string>
  /** `noopener` or `noreferrer` was there: the new window must not get `window.opener`. */
  noOpener: boolean
}

const isSeparator = (char: string): boolean => char === '=' || char === ',' || /\s/.test(char)

/**
 * The feature list of `window.open`, read like the HTML specification ("tokenize the features argument"): names and values are separated
 * by whitespace, `=` and `,`. `noopener` and `noreferrer` are taken out (they say how to open, not what to open). Text beyond
 * `FEATURES_MAX_CHARS` and entries beyond `FEATURES_MAX_ENTRIES` are ignored; anything that is not text reads as an empty list.
 */
export function parseFeatures(raw: unknown): Features {
  const entries = new Map<string, string>()
  const text = typeof raw === 'string' ? raw.slice(0, FEATURES_MAX_CHARS) : ''
  let noOpener = false
  let at = 0
  while (at < text.length && entries.size < FEATURES_MAX_ENTRIES) {
    while (at < text.length && isSeparator(text[at]!)) at++
    let name = ''
    while (at < text.length && !isSeparator(text[at]!)) name += text[at++]
    while (at < text.length && /\s/.test(text[at]!)) at++
    let value = ''
    if (text[at] === '=') {
      at++
      while (at < text.length && isSeparator(text[at]!)) at++
      while (at < text.length && !isSeparator(text[at]!)) value += text[at++]
    }
    const key = name.toLowerCase()
    if (key === '') continue
    if (key === 'noopener' || key === 'noreferrer') {
      noOpener = true
      continue
    }
    entries.set(key, value)
  }
  return { entries, noOpener }
}

/** The whole-number prefix of a feature value, as the HTML "rules for parsing integers" read it (`500px` is 500, `1e9` is 1), or null. */
export function parseWholeNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const match = /^\s*([+-]?)(\d+)/.exec(value)
  if (!match) return null
  // Past nine digits the exact value does not matter, only that it is far beyond any screen (and `Number` would end in Infinity).
  if (match[2]!.length > 9) return match[1] === '-' ? -1_000_000_000 : 1_000_000_000
  return Number(`${match[1]}${match[2]}`)
}

/** What the handler of `window.open` does with the page's request. */
export type OpenPlan = { kind: 'popup'; opener: boolean; size: Partial<Size> } | { kind: 'tab'; mode: 'foreground' | 'background' | 'peek' }

/**
 * Chromium says what the page asked for in `disposition`: `new-window` is a popup (a feature list) or a Shift+click (none). So a popup is
 * a `new-window` that carries features other than `noopener` / `noreferrer`; a `new-window` without any stays a Glance, and every other
 * disposition keeps being a tab (a Cmd+click is a background tab, the rest a foreground one).
 */
export function planOpen(details: { disposition: unknown; features: unknown }): OpenPlan {
  const { entries, noOpener } = parseFeatures(details.features)
  if (details.disposition === 'new-window' && entries.size > 0) {
    const width = parseWholeNumber(entries.get('width') ?? entries.get('innerwidth'))
    const height = parseWholeNumber(entries.get('height') ?? entries.get('innerheight'))
    return { kind: 'popup', opener: !noOpener, size: { ...(width !== null ? { width } : {}), ...(height !== null ? { height } : {}) } }
  }
  if (details.disposition === 'new-window') return { kind: 'tab', mode: 'peek' }
  return { kind: 'tab', mode: details.disposition === 'background-tab' ? 'background' : 'foreground' }
}

/** The content size of a popup: what the page asked for (or the default), kept between the minimum and what fits the screen. */
export function popupSize(asked: Partial<Size>, workArea: Size): Size {
  const width = asked.width !== undefined && asked.width > 0 ? asked.width : POPUP_DEFAULT_SIZE.width
  const height = asked.height !== undefined && asked.height > 0 ? asked.height : POPUP_DEFAULT_SIZE.height
  return {
    width: Math.round(clamp(width, POPUP_MIN_SIZE.width, workArea.width)),
    height: Math.round(clamp(height, POPUP_MIN_SIZE.height, workArea.height - POPUP_FRAME_HEIGHT))
  }
}

/** Where the popup goes: centred on the window of the page that opened it, and wholly inside the work area of the screen. */
export function popupBounds(asked: Partial<Size>, parent: Rect, workArea: Rect): Rect {
  const size = popupSize(asked, workArea)
  const outerHeight = size.height + POPUP_FRAME_HEIGHT
  const x = clamp(Math.round(parent.x + (parent.width - size.width) / 2), workArea.x, workArea.x + workArea.width - size.width)
  const y = clamp(Math.round(parent.y + (parent.height - outerHeight) / 2), workArea.y, workArea.y + workArea.height - outerHeight)
  return { x, y, ...size }
}

/**
 * Where the content of a popup may be after its page called `window.resizeTo` / `moveTo` (what it asked for is `requested`): the same bounds as
 * when it was made. The size stays between the minimum and the screen, and the window, title bar included, stays inside the work area.
 */
export function popupContentBounds(requested: Rect, workArea: Rect): Rect {
  const size = popupSize(requested, workArea)
  // A position that is not a number (the page cannot send one, but the event is not ours) is the top left corner.
  const x = Number.isFinite(requested.x) ? requested.x : workArea.x
  const y = Number.isFinite(requested.y) ? requested.y : workArea.y
  return {
    x: Math.round(clamp(x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(y, workArea.y + POPUP_FRAME_HEIGHT, workArea.y + workArea.height - size.height)),
    ...size
  }
}

/** Bidirectional controls and other characters that let a title put words where they do not belong, or hide them. */
const UNSAFE_TITLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** The host of an address as the network sees it (punycode, with the port when there is one), or '' when it has none. */
export function hostOfPage(url: string): string {
  if (url === 'about:blank') return 'about:blank'
  return URL.canParse(url) && /^https?:$/.test(new URL(url).protocol) ? new URL(url).host : ''
}

/**
 * The title bar of a popup: the host of its page first (the part the page cannot choose), then the title it gave, cleaned and cut. A popup
 * has no address bar, so this line is how the user knows whose page it is.
 */
export function popupTitle(url: string, pageTitle: string): string {
  const host = hostOfPage(url) || t('web-auth.adresse-inconnue')
  const title = pageTitle.replace(UNSAFE_TITLE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (title === '' || title === host) return host
  return `${host} — ${title.length > POPUP_TITLE_MAX_CHARS ? `${title.slice(0, POPUP_TITLE_MAX_CHARS - 1)}…` : title}`
}

/** Which popups each tab has open: a few at most, a page cannot fill the screen with windows. */
export class PopupLimiter {
  private readonly open = new Map<string, number>()

  constructor(private readonly max: number = MAX_POPUPS_PER_TAB) {}

  count(owner: string): number {
    return this.open.get(owner) ?? 0
  }

  /** Whether one more popup may be opened for `owner` now. */
  canOpen(owner: string): boolean {
    return this.count(owner) < this.max
  }

  /** Counts a popup for `owner`; returns what ends it (once), or null when the tab has its share. */
  acquire(owner: string): (() => void) | null {
    if (!this.canOpen(owner)) return null
    this.open.set(owner, this.count(owner) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = this.count(owner) - 1
      if (left > 0) this.open.set(owner, left)
      else this.open.delete(owner)
    }
  }
}

/** What a key pressed in a popup does: it closes the window, reloads the page, is kept from the menu (which belongs to the tabs), or goes on. */
export type PopupKey = 'close' | 'reload' | 'block' | 'pass'

/** The commands of the application menu that are still right when the focus is in a popup: editing and the system's own (quit, hide, minimize). */
const POPUP_PASS_KEYS = new Set(['c', 'v', 'x', 'a', 'z', 'y', 'q', 'h', 'm'])

/**
 * The menu of the application acts on the tabs of the window the user was working in, not on the popup that has the focus: ⌘W would archive
 * the tab that opened it. So in a popup a ⌘ shortcut either does what it says for the popup (close, reload), is one of the editing commands
 * the system answers itself, or is kept from the menu. Without ⌘ (or Ctrl away from macOS) the key is the page's.
 */
export function popupKey(input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }, platform: string): PopupKey {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return 'pass'
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : ''
  const command = platform === 'darwin' ? input.meta : input.control
  // Ctrl+Tab and Ctrl+Shift+Tab switch tabs in the menu, on every platform.
  if (input.control && key === 'tab') return 'block'
  if (!command) return 'pass'
  if (input.alt) return 'block'
  if (key === 'w') return 'close'
  if (key === 'r' && !input.shift) return 'reload'
  return POPUP_PASS_KEYS.has(key) ? 'pass' : 'block'
}
