// What every importer lets through. The files come from other programs (or from someone who edited them): an address or a title of
// any size, a character that cannot be shown, a scheme the browser must never open. Each importer filters here, so none of them
// builds an entry that the state would then have to repair or refuse.

import { t } from '@shared/i18n'
import { NAME_MAX, TITLE_MAX, printable } from '@shared/state-clean'
import { isNavigableUrl } from '@shared/url'

/**
 * Longest address kept. Browsers accept up to 2 MB, but no bookmark or visited page needs more than a web server would answer
 * (8 KB is where Apache and nginx stop); an address beyond it is a data URI in disguise or a damaged file.
 */
export const MAX_URL_LENGTH = 8192

const CONTROL = /\p{Cc}/u

/**
 * A web address (http or https) that the engine can open: it goes through `isNavigableUrl`, the single gate of every path that opens a
 * tab, and is limited to http(s) because `file:` and `about:` bookmarks are not web pages. A bare prefix check let `https://` through.
 */
export const isWebUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_URL_LENGTH && /^https?:\/\//i.test(value) && !CONTROL.test(value) && isNavigableUrl(value)

/**
 * The bidirectional formatting characters (embeddings, overrides and isolates): one U+202E in a title turns "fdp.exe" into "exe.pdf" on
 * screen and reorders the text next to it. Hebrew and Arabic need none of them (the letters carry their direction), and the marks
 * U+200E / U+200F, which text in both directions does use, are kept.
 */
const BIDI_FORMATTING = /[\u202a-\u202e\u2066-\u2069]/gu

/** A line of text shown in the sidebar, from a file nobody here wrote: control and bidirectional formatting characters out, cut at `max`. */
export const displayText = (value: unknown, max: number): string | null => {
  const text = printable(value, max)
  // A cut can leave half of a pair of UTF-16 units (an emoji at the limit) at the end: a lone one is shown as a broken character.
  return text === null ? null : text.replace(BIDI_FORMATTING, '').replace(/[\ud800-\udbff]$/, '')
}

/** The title of a link: its own text (control characters turned into spaces, cut at the state's limit), or else its address. */
export const linkTitle = (title: unknown, url: string): string => displayText(title, TITLE_MAX)?.trim() || url.slice(0, TITLE_MAX)

/** The name of a folder, with the same rules. */
export const folderName = (title: unknown, fallback = t('import.dossier-sans-nom')): string => displayText(title, NAME_MAX)?.trim() || fallback
