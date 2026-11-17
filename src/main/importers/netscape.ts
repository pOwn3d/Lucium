// Reads a bookmarks file in the Netscape format (what every browser exports: nested <DL> lists, <H3> for a folder, <A HREF> for a link),
// notably the one Lucium writes (shared/bookmarks-html.ts). The file is hostile input: tags are scanned by hand in one pass (a
// regular expression over a file of unclosed tags would take quadratic time), the length of every tag, title and level of nesting
// is bounded, and nothing in it is executed or fetched. Addresses are judged later, by the same filter as every other importer.

import { t } from '@shared/i18n'
import type { Ctx } from '@shared/sidebar'
import { buildBookmarkSpace, emptyBookmarkImport, unrecognizedBookmarkImport, type BookmarkImport, type BookmarkNode } from './bookmark-tree'

/** Longest tag read (attributes included): a longer one is text. */
const TAG_MAX = 16_384
/** Longest title or folder name looked for after its opening tag. */
const TEXT_MAX = 4096
/** Longest note (the text of a <DD>) and longest TAGS attribute kept; the library cuts them again. */
const NOTE_MAX = 1200
const TAGS_ATTRIBUTE_MAX = 2000

/** Levels of <DL> kept; deeper lists are read as part of the level above. */
export const NETSCAPE_MAX_DEPTH = 32
/** Elements (folders and links) read; the rest of a larger file is ignored. */
export const NETSCAPE_MAX_NODES = 100_000
/**
 * Tags looked at, and `<` that open none: the rest of a larger file is ignored. The import runs in the main process, and a file of tags the parse does
 * nothing with (`<p>`, `<dl>`, a lone `<`) took 1.3 to 1.7 s for the 100 Mo a file may weigh. A file of NETSCAPE_MAX_NODES links has about
 * four tags each.
 */
export const NETSCAPE_MAX_SCANNED = 2_000_000

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Text with its character references (`&amp;`, `&#39;`, `&#x1F600;`) replaced; an unknown or invalid one is left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? whole
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
  })
}

interface Tag {
  name: string
  closing: boolean
  attrs: string
  /** Index just after the `>`. */
  end: number
}

/**
 * The tag that starts at `html[start] === '<'`, or null when this is not a tag (no name, or no `>` within the bound). Quoted values may
 * hold a `>`; a quote that is never closed does not swallow the rest of the file: the tag then ends at the first `>`. `firstGt` is the
 * index of the first `>` at or after `start` (-1 when none), which keeps a file of tags that never close from being scanned again and again.
 */
function tagAt(html: string, start: number, firstGt: number): Tag | null {
  if (firstGt === -1 || firstGt - start > TAG_MAX) return null
  let i = start + 1
  const closing = html[i] === '/'
  if (closing) i++
  const nameStart = i
  while (i < html.length && /[A-Za-z0-9]/.test(html[i]!)) i++
  if (i === nameStart) return null
  const name = html.slice(nameStart, i).toLowerCase()
  const attrsStart = i
  const limit = Math.min(html.length, start + TAG_MAX)
  let quote = ''
  for (; i < limit; i++) {
    const ch = html[i]!
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return { name, closing, attrs: html.slice(attrsStart, i), end: i + 1 }
  }
  return { name, closing, attrs: html.slice(attrsStart, firstGt), end: firstGt + 1 }
}

/** The value of an attribute (`HREF="…"`, `href='…'` or `href=…`), entities decoded; undefined when absent. */
function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  const value = match ? (match[1] ?? match[2] ?? match[3]) : undefined
  return value === undefined ? undefined : decodeEntities(value)
}

const CLOSING = { h3: '<\\/h3\\s*>', a: '<\\/a\\s*>' }
type Closing = keyof typeof CLOSING

/**
 * The closing tags `</h3>` and `</a>` of a file, each found by one pass forward: the parse only moves forward, so the next one found is kept until
 * the parse goes past it, and a file that has none is searched once. Looking again from every opening tag (a window of TEXT_MAX each time) cost
 * 2.8 s for a megabyte of `<a>`.
 */
class ClosingTags {
  private readonly found = new Map<Closing, { from: number; match: { index: number; end: number } | null }>()
  constructor(private readonly html: string) {}

  /** The first `</name>` at or after `from`, or null when the file has none there. */
  next(name: Closing, from: number): { index: number; end: number } | null {
    const known = this.found.get(name)
    if (known && known.from <= from && (known.match === null || known.match.index >= from)) return known.match
    const pattern = new RegExp(CLOSING[name], 'gi')
    pattern.lastIndex = from
    const hit = pattern.exec(this.html)
    const match = hit ? { index: hit.index, end: hit.index + hit[0].length } : null
    this.found.set(name, { from, match })
    return match
  }
}

/** The text with its tags taken out, in one pass (`/<[^>]*>/g` would read the rest of the text again at each `<` that never closes). */
function withoutTags(raw: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const open = raw.indexOf('<', i)
    if (open === -1) break
    const close = raw.indexOf('>', open)
    if (close === -1) break
    out += raw.slice(i, open)
    i = close + 1
  }
  return out + raw.slice(i)
}

/**
 * The text up to the closing tag `</name>` (tags inside it dropped, entities decoded), and where that tag ends. With no closing tag within TEXT_MAX,
 * the text is what follows up to the next tag (at most TEXT_MAX), and the parse goes on from the opening tag.
 */
function textUntil(html: string, from: number, name: Closing, closings: ClosingTags): { text: string; next: number } {
  const found = closings.next(name, from)
  const close = found && found.index - from <= TEXT_MAX ? found : null
  let raw: string
  if (close) {
    raw = html.slice(from, close.index)
  } else {
    const window = html.slice(from, from + TEXT_MAX)
    const tag = window.indexOf('<')
    raw = tag === -1 ? window : window.slice(0, tag)
  }
  return { text: decodeEntities(withoutTags(raw)).replace(/\s+/g, ' ').trim(), next: close ? close.end : from }
}

export interface NetscapeBookmarks {
  nodes: BookmarkNode[]
  /** Elements read: links and folders, and the anchors with no address (they count towards `NETSCAPE_MAX_NODES` too). */
  count: number
  /** The file holds more than `NETSCAPE_MAX_NODES` elements, or more than `NETSCAPE_MAX_SCANNED` tags: the rest was not read. */
  truncated: boolean
}

export interface NetscapeOptions {
  /** Also read what the bookmark library keeps beyond the address and the name: `TAGS`, `ADD_DATE` and the `<DD>` note. The import into the sidebar leaves them out. */
  details?: boolean
}

export function parseNetscapeBookmarks(html: string, options: NetscapeOptions = {}): NetscapeBookmarks {
  const details = options.details === true
  const root: BookmarkNode[] = []
  // Each open <DL> adds to the children of the folder named just before it; the first (the file's own list) adds to the root.
  const stack: BookmarkNode[][] = []
  let pending: string | null = null
  let lastLink: BookmarkNode | null = null
  let count = 0
  let truncated = false
  const closings = new ClosingTags(html)

  let firstGt = -2
  let scanned = 0
  for (let at = html.indexOf('<'); at !== -1 && !truncated; at = html.indexOf('<', at)) {
    if (++scanned > NETSCAPE_MAX_SCANNED) {
      truncated = true
      break
    }
    if (firstGt !== -1 && firstGt < at) firstGt = html.indexOf('>', at)
    const tag = tagAt(html, at, firstGt)
    if (!tag) {
      at++
      continue
    }
    at = tag.end
    // A note belongs to the link right above it: a folder, or the end of a list, closes that.
    if (tag.name === 'dl' || tag.name === 'h3') lastLink = null
    if (tag.name === 'dl') {
      if (tag.closing) {
        stack.pop()
        pending = null
        continue
      }
      const parent = stack.at(-1) ?? root
      if (pending !== null && stack.length < NETSCAPE_MAX_DEPTH) {
        const folder: BookmarkNode = { kind: 'folder', title: pending, children: [] }
        parent.push(folder)
        stack.push(folder.children)
      } else {
        // The file's own list, a list no folder introduces, or one too deep: read as part of the level it is in.
        stack.push(parent)
      }
      pending = null
    } else if (tag.name === 'h3' && !tag.closing) {
      const { text, next } = textUntil(html, tag.end, 'h3', closings)
      pending = text
      at = Math.max(at, next)
      count++
    } else if (tag.name === 'a' && !tag.closing) {
      const { text, next } = textUntil(html, tag.end, 'a', closings)
      at = Math.max(at, next)
      // Every anchor counts towards the bound, one with no address too: a file of those must not be read to its end.
      count++
      const url = attribute(tag.attrs, 'href')
      if (url !== undefined) {
        const tags = details ? attribute(tag.attrs, 'tags') : undefined
        const added = details ? Number(attribute(tag.attrs, 'add_date')) : NaN
        const link: BookmarkNode = { kind: 'link', title: text, url, ...(tags ? { tags: tags.slice(0, TAGS_ATTRIBUTE_MAX) } : {}), ...(Number.isFinite(added) && added > 0 ? { addedAt: added } : {}) }
        ;(stack.at(-1) ?? root).push(link)
        lastLink = link
      }
    } else if (details && tag.name === 'dd' && !tag.closing && lastLink?.kind === 'link') {
      // The note under a link: the text up to the next tag.
      const end = html.indexOf('<', tag.end)
      const raw = html.slice(tag.end, end === -1 ? Math.min(html.length, tag.end + NOTE_MAX) : Math.min(end, tag.end + NOTE_MAX))
      const note = decodeEntities(raw).replace(/\s+/g, ' ').trim()
      if (note) lastLink.note = note
      lastLink = null
    }
    if (count >= NETSCAPE_MAX_NODES) truncated = true
  }
  return { nodes: root, count, truncated }
}

/** A bookmarks file as a new space (pinned tabs and folders, nested as in the file), by the same rules as the other browsers' bookmarks. */
export function convertNetscapeBookmarks(html: string, ctx: Ctx, name = t('import.signets-importes'), identity?: string): BookmarkImport {
  const { nodes } = parseNetscapeBookmarks(html)
  if (nodes.length > 0) return buildBookmarkSpace(ctx, { name, emoji: '🔖', hue: 170 }, [{ nodes }], 0, identity)
  // An export of an empty library holds a list and no link: that is a bookmarks file with nothing in it. A text with neither is another file.
  return /<dl[\s>]/i.test(html) ? emptyBookmarkImport() : unrecognizedBookmarkImport()
}
