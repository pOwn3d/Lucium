// The links another application drops on a window of Lucium (a link dragged from Safari, a mail, a terminal): they open in a new tab. The interface only reads
// the text of the drop and sends it, and the main process checks it again with the rules below. Nothing here trusts the sender: the text may be anything.
// The files of the disk have their own road (local-documents.ts).

import { isNavigableUrl } from './url'

/** How many tabs one drop opens at most: a text with a hundred links dragged by mistake must not open a hundred tabs. */
export const DROPPED_LINKS_MAX = 10

/** The longest address kept, in characters (the usual limit of a link). */
export const DROPPED_LINK_LENGTH_MAX = 2048

/** The most text a drop may carry, in bytes: a link is short, and what is longer than this is not a list of links. */
export const DROPPED_LINKS_TEXT_MAX = 16 * 1024

/** A NUL or any other control character, and the two separators of lines and paragraphs of Unicode: none of them belongs in an address. */
const CONTROL = /[\p{Cc}\u{2028}\u{2029}]/u
const CONTROL_EVERYWHERE = /[\p{Cc}\u{2028}\u{2029}]/gu

/** What an entry that is meant as an address starts with: a scheme and something after it (`javascript:alert(1)` is one, `Note: see below` is not). */
const SCHEME_FIRST = /^[a-z][a-z0-9+.-]*:\S/i

/**
 * The address to open for one dropped entry, or `null` when it is not one Lucium opens: not a text, empty, too long, with a control character or a blank,
 * not a `http:` or `https:` address, or with a user name or a password in it. The rest is the check of the address typed in the bar (`isNavigableUrl`), so
 * that a dropped link and a pasted one pass the same door. The address is written again by the parser: the tab is given what was understood, not the text
 * that was received.
 */
export function droppedLinkUrl(entry: unknown): string | null {
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > DROPPED_LINK_LENGTH_MAX || CONTROL.test(entry)) return null
  // The address of a link is always written without a blank (a space is %20): a blank in the middle is a sentence that begins with an address.
  if (/\s/.test(entry) || !URL.canParse(entry)) return null
  const url = new URL(entry)
  // Only the web: a `file:` address has its own road (the file is dropped, not its address), and `javascript:`, `data:`, `blob:`, `lucium:` and the
  // pages of the application never open from a drop.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // « https://bank.example@evil.example/ » shows one site and goes to another, and a name with its password would be kept in the tab and in the history.
  if (url.username !== '' || url.password !== '') return null
  return isNavigableUrl(url.href) ? url.href : null
}

/**
 * The addresses to open for the text of a drop, at most `DROPPED_LINKS_MAX`, and how many addresses were refused or left aside (not a web address, too
 * long, with a name and a password, with a control character or a blank, or past the ceiling). One entry a line, as `text/uri-list` has it (the lines that
 * begin with `#` are its comments); the same address twice opens once and is not counted. A line that is no address at all (any other text dragged
 * along, a blank line) is let go without a word: it was never a link, and a drop of a paragraph must not say that a link was refused. A value that is not
 * a text opens nothing; a text past `DROPPED_LINKS_TEXT_MAX` bytes opens nothing and counts as one refusal, its lines are not even looked at.
 */
export function droppedLinkUrls(raw: unknown): { urls: string[]; refused: number } {
  if (typeof raw !== 'string') return { urls: [], refused: 0 }
  // The cheap test first: a text that is longer in characters is longer in bytes too, and the encoder is not asked to read a megabyte.
  if (raw.length > DROPPED_LINKS_TEXT_MAX || new TextEncoder().encode(raw).length > DROPPED_LINKS_TEXT_MAX) return { urls: [], refused: 1 }
  const urls: string[] = []
  const seen = new Set<string>()
  let refused = 0
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const entry = line.trim()
    if (entry === '' || entry.startsWith('#')) continue
    // A control character in the middle of an address still makes it an address that is refused, not a text that is let go.
    if (!SCHEME_FIRST.test(entry.replace(CONTROL_EVERYWHERE, ''))) continue
    const url = droppedLinkUrl(entry)
    if (url === null) {
      refused++
      continue
    }
    if (seen.has(url)) continue
    seen.add(url)
    if (urls.length >= DROPPED_LINKS_MAX) refused++
    else urls.push(url)
  }
  return { urls, refused }
}
