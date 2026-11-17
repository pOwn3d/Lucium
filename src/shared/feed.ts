// Reading the answer of a live folder (live-folders.ts): an RSS 2.0, RSS 1.0 (RDF) or Atom feed, or the JSON of the GitHub API. The text is
// hostile, so nothing here builds a document tree or asks a library to: the XML is scanned in one pass by hand. A DOCTYPE is skipped and
// no entity it declares is ever expanded (only the five of XML and numeric references are read), so there is no external entity, no
// internal bomb and nothing to fetch. The depth, the number of elements read, the length of every tag and of every text are bounded.

import { LIVE_ITEMS_MAX, LIVE_TITLE_MAX, LIVE_URL_MAX, isFeedUrl, isGithubRepo, liveText, type GithubWhat, type LiveItem } from './live-folders'

/** The longest tag read, attributes included: a longer `<` is text. */
const TAG_MAX = 2048
/** The longest text kept for one field of an item (the rest is dropped; a title is cut again at `LIVE_TITLE_MAX`). */
const FIELD_MAX = 4000
/** Levels of elements followed; a file that nests deeper than any feed is not read further. */
export const FEED_DEPTH_MAX = 48
/** Items looked at, however many the file holds. */
export const FEED_SCAN_MAX = 200
/** Tags looked at in all: a file of nothing but tags is cut here. */
export const FEED_TAGS_MAX = 200_000

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The five entities of XML and numeric references; anything else (a declared entity, `&nbsp;`) stays as written. */
export function decodeXml(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,4}));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? whole
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
  })
}

interface Tag {
  /** The name without its prefix (`dc:date` is `date`), lower case. */
  name: string
  closing: boolean
  selfClosing: boolean
  attrs: string
  end: number
}

/**
 * The tag that starts at `xml[start] === '<'`, or null when it is not one (no name, or no `>` within the bound). `gt` is the index of the first `>`
 * at or after `start`, which the caller keeps so that a file of `<` that never close is not scanned again for each of them. Quoted values may hold a
 * `>`; a quote that is never closed does not swallow the rest of the file: the tag then ends at the first `>`.
 */
function tagAt(xml: string, start: number, gt: number): Tag | null {
  if (gt === -1 || gt - start > TAG_MAX) return null
  let i = start + 1
  const closing = xml[i] === '/'
  if (closing) i++
  const nameStart = i
  while (i < gt && i - nameStart < 100 && /[A-Za-z0-9:_.-]/.test(xml[i]!)) i++
  if (i === nameStart) return null
  const full = xml.slice(nameStart, i).toLowerCase()
  const name = full.includes(':') ? full.slice(full.lastIndexOf(':') + 1) : full
  const attrsStart = i
  const limit = Math.min(xml.length, start + TAG_MAX)
  let quote = ''
  for (; i < limit; i++) {
    const ch = xml[i]!
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') {
      const attrs = xml.slice(attrsStart, i)
      return { name, closing, selfClosing: !closing && attrs.trimEnd().endsWith('/'), attrs, end: i + 1 }
    }
  }
  const attrs = xml.slice(attrsStart, gt)
  return { name, closing, selfClosing: !closing && attrs.trimEnd().endsWith('/'), attrs, end: gt + 1 }
}

/** The value of an attribute (`href="…"`), entities decoded; undefined when absent. */
function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  const value = match ? (match[1] ?? match[2]) : undefined
  return value === undefined ? undefined : decodeXml(value)
}

/** Where a `<!DOCTYPE …>` ends: its internal subset (between brackets) may hold `>`. */
function doctypeEnd(xml: string, start: number): number {
  let depth = 0
  const limit = Math.min(xml.length, start + 16_384)
  for (let i = start; i < limit; i++) {
    const ch = xml[i]
    if (ch === '[') depth++
    else if (ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === '>' && depth === 0) return i + 1
  }
  // Never closed within the bound: nothing after it is read as a feed.
  return xml.length
}

/** The date fields of an item, the one to read first first (a feed that gives two means the later one by `updated`). */
const DATE_FIELDS = ['updated', 'pubdate', 'published', 'date', 'issued', 'modified']
const TEXT_FIELDS: ReadonlySet<string> = new Set(['title', 'link', 'guid', ...DATE_FIELDS])
const ITEM_NAMES: ReadonlySet<string> = new Set(['item', 'entry'])

/** A date field as milliseconds; undefined when it is not a date or lies more than a day ahead. */
export function feedDate(text: string, now: number): number | undefined {
  const ms = Date.parse(text.trim())
  return Number.isFinite(ms) && ms > 0 && ms <= now + 86_400_000 ? ms : undefined
}

/**
 * The items of a feed, in the order of the file, at most `LIVE_ITEMS_MAX`. `base` is the address the feed was read from: a relative link is
 * resolved against it. An item with no title or with no web address is left out. Never throws: a text that is no feed gives no item.
 */
export function parseFeed(xml: string, base: string, now = Date.now()): { title: string; items: LiveItem[] } {
  const items: LiveItem[] = []
  const stack: string[] = []
  // The item being read: the text of its direct children by element name, and its Atom link. `itemDepth` is the length of the stack just
  // inside the item: a direct child is the element whose opening makes the stack that long. The text goes to the direct child it is under (an XHTML
  // title holds markup), so `<source><title>` or `<author><name>` end up under `source` and `author`, which nothing reads.
  let fields: Record<string, string> | null = null
  let alternate = ''
  let itemDepth = 0
  let feedTitle = ''
  let feedTitleDepth = -1
  let scanned = 0
  let tags = 0
  let gt = -2

  const gather = (text: string): void => {
    if (fields !== null && stack.length >= itemDepth + 1) {
      const name = stack[itemDepth]!
      if (TEXT_FIELDS.has(name) && (fields[name]?.length ?? 0) < FIELD_MAX) fields[name] = ((fields[name] ?? '') + text).slice(0, FIELD_MAX)
    } else if (fields === null && feedTitleDepth === stack.length && feedTitle.length < FIELD_MAX) feedTitle = (feedTitle + text).slice(0, FIELD_MAX)
  }

  const finish = (): void => {
    const got = fields ?? {}
    fields = null
    scanned++
    const guid = (got['guid'] ?? '').trim()
    const href = alternate || (got['link'] ?? '').trim() || (/^https?:\/\//i.test(guid) ? guid : '')
    const title = liveText(decodeXml(got['title'] ?? '').replace(/<[^>]*>/g, ' '), LIVE_TITLE_MAX)
    const url = href !== '' && href.length <= LIVE_URL_MAX && URL.canParse(href, base) ? new URL(href, base).href : ''
    if (title === '' || !isFeedUrl(url)) return
    const raw = DATE_FIELDS.map((name) => got[name]).find((value) => value !== undefined && value.trim() !== '')
    const at = raw === undefined ? undefined : feedDate(raw, now)
    items.push({ title, url, ...(at !== undefined ? { at } : {}) })
  }

  /** Closes the element `name`: the innermost open one of that name (a file that nests badly does not unbalance the rest). */
  const close = (name: string): void => {
    const at = stack.lastIndexOf(name)
    if (at === -1) return
    stack.length = at
    if (feedTitleDepth > stack.length) feedTitleDepth = -1
    if (fields !== null && stack.length <= itemDepth - 1) finish()
  }

  let pos = 0
  while (pos < xml.length && items.length < LIVE_ITEMS_MAX && scanned < FEED_SCAN_MAX && tags < FEED_TAGS_MAX) {
    const lt = xml.indexOf('<', pos)
    const text = xml.slice(pos, lt === -1 ? xml.length : lt)
    if (text.trim() !== '') gather(decodeXml(text))
    if (lt === -1) break
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      pos = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      gather(xml.slice(lt + 9, end === -1 ? xml.length : end))
      pos = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      pos = end === -1 ? xml.length : end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      // A DOCTYPE: skipped whole, its declarations are never read.
      pos = doctypeEnd(xml, lt)
      continue
    }
    if (gt !== -1 && gt < lt) gt = xml.indexOf('>', lt)
    // No `>` left anywhere: whatever follows cannot hold a tag.
    if (gt === -1) break
    const tag = tagAt(xml, lt, gt)
    if (tag === null) {
      pos = lt + 1
      continue
    }
    pos = tag.end
    tags++
    if (tag.closing) {
      close(tag.name)
      continue
    }
    if (fields !== null && stack.length === itemDepth && tag.name === 'link') {
      // An Atom link: `rel` absent or "alternate" is the page of the item.
      const href = attribute(tag.attrs, 'href')
      const rel = attribute(tag.attrs, 'rel')
      if (href !== undefined && alternate === '' && (rel === undefined || rel.toLowerCase() === 'alternate')) alternate = href.trim()
    }
    if (tag.selfClosing) continue
    if (stack.length >= FEED_DEPTH_MAX) break
    if (fields === null && ITEM_NAMES.has(tag.name)) {
      stack.push(tag.name)
      itemDepth = stack.length
      fields = {}
      alternate = ''
      continue
    }
    // The title of the feed itself: the first `title` in the channel or the feed, before any item.
    if (fields === null && tag.name === 'title' && feedTitle === '' && feedTitleDepth === -1 && stack.length <= 2 && scanned === 0) feedTitleDepth = stack.length + 1
    stack.push(tag.name)
  }
  return { title: liveText(decodeXml(feedTitle).replace(/<[^>]*>/g, ' '), LIVE_TITLE_MAX), items }
}

// ---------- GitHub (REST API v3, public repositories, no token) ----------

const firstLine = (text: unknown): string => (typeof text === 'string' ? (text.split('\n')[0] ?? '') : '')
const isoDate = (value: unknown, now: number): number | undefined => (typeof value === 'string' ? feedDate(value, now) : undefined)

/**
 * The items of a GitHub answer. Every address is built or checked here: it must be on `github.com/<repo>/` (a hostile answer cannot make
 * the sidebar open another site), so a title can say anything but a row only ever leads to the repository.
 */
export function parseGithub(text: string, repo: string, what: GithubWhat, now = Date.now()): LiveItem[] {
  if (!isGithubRepo(repo)) return []
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(json)) return []
  const home = `https://github.com/${repo}/`
  // Compared as the address is opened, not as it is written: `…/owner/repo/../../other/page` begins like the repository and leads out of it.
  const own = (url: unknown): string | null => {
    if (typeof url !== 'string' || url.length > LIVE_URL_MAX || !isFeedUrl(url)) return null
    const href = new URL(url).href
    return href.toLowerCase().startsWith(home.toLowerCase()) ? href : null
  }
  const items: LiveItem[] = []
  for (const raw of json.slice(0, FEED_SCAN_MAX)) {
    if (items.length >= LIVE_ITEMS_MAX) break
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    let title = ''
    let url: string | null = null
    let at: number | undefined
    switch (what) {
      case 'releases': {
        if (entry['draft'] === true) continue
        title = liveText(entry['name'], LIVE_TITLE_MAX) || liveText(entry['tag_name'], LIVE_TITLE_MAX)
        url = own(entry['html_url'])
        at = isoDate(entry['published_at'], now) ?? isoDate(entry['created_at'], now)
        break
      }
      case 'tags': {
        const name = liveText(entry['name'], LIVE_TITLE_MAX)
        title = name
        url = name ? own(`${home}releases/tag/${encodeURIComponent(name)}`) : null
        break
      }
      case 'commits': {
        const commit = typeof entry['commit'] === 'object' && entry['commit'] !== null ? (entry['commit'] as Record<string, unknown>) : {}
        title = liveText(firstLine(commit['message']), LIVE_TITLE_MAX)
        url = own(entry['html_url'])
        const author = typeof commit['author'] === 'object' && commit['author'] !== null ? (commit['author'] as Record<string, unknown>) : {}
        at = isoDate(author['date'], now)
        break
      }
      case 'issues':
      case 'pulls': {
        // The issues list also holds the pull requests (they carry a `pull_request` field): `issues` leaves them to `pulls`.
        if (what === 'issues' && entry['pull_request'] !== undefined) continue
        const number = typeof entry['number'] === 'number' && Number.isInteger(entry['number']) && entry['number'] > 0 ? entry['number'] : null
        const name = liveText(entry['title'], LIVE_TITLE_MAX)
        title = number !== null && name ? `#${number} ${name}` : ''
        url = own(entry['html_url'])
        at = isoDate(entry['updated_at'], now) ?? isoDate(entry['created_at'], now)
        break
      }
    }
    if (title === '' || url === null) continue
    items.push({ title: liveText(title, LIVE_TITLE_MAX), url, ...(at !== undefined ? { at } : {}) })
  }
  return items
}
