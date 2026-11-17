// The bookmark library ("Signets"): pages kept for good, with tags. Pure rules shared by the reducer (sidebar.ts), the menus, the command
// bar and the panel; the shape of an entry is in model.ts. It is not the favourites row nor the pinned tabs of the sidebar, which it never touches.
// Everything that comes from a file, a link or a page is hostile: addresses, titles, notes and tags are bounded and made printable here,
// and nothing in a bookmark is ever executed.

import { BOOKMARKS_LIMIT, BOOKMARK_NOTE_MAX, BOOKMARK_TAGS_MAX, BOOKMARK_TAG_MAX, BOOKMARK_TITLE_MAX, BOOKMARK_URL_MAX, tabName, type Bookmark, type TabItem } from './model'
import type { Ctx } from './sidebar'
import { finite, isWebAddress, printable, readLaterFavicon, uniqueRecords } from './state-clean'
import { hostOf } from './url'
import { t } from './i18n'
import { foldAccents } from './fold'
import { countText, counted } from './import-sources'

/** How many entries of an import are looked at: a file of hundreds of thousands of links is not read to the end. */
export const BOOKMARK_IMPORT_SCAN_MAX = 20_000

export const isBookmarkUrl = (value: unknown): value is string => isWebAddress(value, BOOKMARK_URL_MAX)

const CONTROL = /\p{Cc}/gu
const SEPARATORS = /[,;\u2028\u2029]/g

/** Lower case without accents: the form tags and searches are compared in. */
export const foldText = foldAccents

/** A tag as it is kept: no control character, no comma (the separator of a tag list), no leading "#", spaces collapsed, at most `BOOKMARK_TAG_MAX` characters. */
export function cleanTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(CONTROL, ' ').replace(SEPARATORS, ' ').replace(/^\s*#+/, '').replace(/\s+/g, ' ').trim()
  const cut = Array.from(text).slice(0, BOOKMARK_TAG_MAX).join('').trim()
  return foldText(cut) === '' ? null : cut
}

/** Tags from what a person typed ("a, b c, #d"): commas separate, a tag may hold spaces. */
export function parseTagInput(text: string): string[] {
  return cleanTags(text.split(','))
}

/** The tags of an entry: each once (the first spelling of a tag wins), the first `BOOKMARK_TAGS_MAX`. Not an array: none. */
export function cleanTags(raw: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    const tag = cleanTag(entry)
    if (tag === null || seen.has(foldText(tag))) continue
    seen.add(foldText(tag))
    out.push(tag)
    if (out.length >= BOOKMARK_TAGS_MAX) break
  }
  return out
}

/** The key two bookmarks of the same page share: the address as the URL parser prints it (so "https://Exemple.fr" and "https://exemple.fr/" are one page). */
export const bookmarkKey = (url: string): string => (URL.canParse(url) ? new URL(url).href : url)

/**
 * Why a bookmark cannot be given this address, as a sentence for the person who typed it, or null when it can: the address is not one of a web
 * page, or another bookmark of the library already has it (the library keeps each page once). The reducer refuses such an edit whole; the form
 * asks first, so that what was typed in its other fields is not thrown away without a word.
 */
export function bookmarkAddressProblem(bookmarks: readonly Pick<Bookmark, 'id' | 'url'>[], id: string, url: unknown): string | null {
  if (!isBookmarkUrl(url)) return t('bookmarks.cette-adresse-n-est-pas-celle-d-une-page-web')
  if (bookmarks.some((other) => other.id !== id && bookmarkKey(other.url) === bookmarkKey(url))) return t('bookmarks.un-autre-signet-a-deja-cette-adresse')
  return null
}

const titleOf = (value: unknown, url: string): string => printable(value, BOOKMARK_TITLE_MAX)?.trim() || (hostOf(url) || url).slice(0, BOOKMARK_TITLE_MAX)

const noteOf = (value: unknown): string | undefined => {
  const text = printable(value, BOOKMARK_NOTE_MAX)?.trim()
  return text ? text : undefined
}

/** One bookmark, repaired; null when it has no usable id or address. */
export function cleanBookmark(entry: Record<string, unknown>, id: string): Bookmark | null {
  const url = entry['url']
  if (!isBookmarkUrl(url)) return null
  const favicon = readLaterFavicon(entry['faviconUrl'])
  const note = noteOf(entry['note'])
  return {
    id,
    url,
    title: titleOf(entry['title'], url),
    tags: cleanTags(entry['tags']),
    ...(note ? { note } : {}),
    ...(favicon ? { faviconUrl: favicon } : {}),
    addedAt: finite(entry['addedAt'], 0)
  }
}

/** The library of a file: as saved, each page once (the first entry of an address wins), at most `BOOKMARKS_LIMIT`. */
export function cleanBookmarks(raw: unknown): Bookmark[] {
  const out: Bookmark[] = []
  const keys = new Set<string>()
  for (const [entry, id] of uniqueRecords(raw)) {
    const bookmark = cleanBookmark(entry, id)
    if (!bookmark || keys.has(bookmarkKey(bookmark.url))) continue
    keys.add(bookmarkKey(bookmark.url))
    out.push(bookmark)
    if (out.length >= BOOKMARKS_LIMIT) break
  }
  return out
}

/** What saving a tab does to the library: a page already in it stays where it is (its tags are the owner's), a full library refuses the new one. */
export type BookmarkOutcome = 'saved' | 'already' | 'full' | 'unsupported'

export function bookmarkOutcome(list: readonly Bookmark[], tab: Pick<TabItem, 'url'>): BookmarkOutcome {
  if (!isBookmarkUrl(tab.url)) return 'unsupported'
  const key = bookmarkKey(tab.url)
  if (list.some((b) => bookmarkKey(b.url) === key)) return 'already'
  return list.length >= BOOKMARKS_LIMIT ? 'full' : 'saved'
}

/** The bookmark for a tab: the name the user sees for it (their own, else the page's title), its icon and the time. Null for a tab that cannot be kept. */
export function bookmarkOf(tab: TabItem, ctx: Ctx): Bookmark | null {
  return cleanBookmark({ url: tab.url, title: tabName(tab), faviconUrl: tab.faviconUrl, tags: [], addedAt: ctx.now }, ctx.newId())
}

export function bookmarkNotice(outcome: BookmarkOutcome): string {
  switch (outcome) {
    case 'saved':
      return t('bookmarks.ajoute-aux-signets')
    case 'already':
      return t('bookmarks.deja-dans-les-signets')
    case 'full':
      return t('bookmarks.la-bibliotheque-de-signets-est-pleine-max-signets', { max: countText(BOOKMARKS_LIMIT) })
    case 'unsupported':
      return t('bookmarks.seules-les-pages-web-peuvent-devenir-des-signets')
  }
}

/**
 * The bookmarks a search keeps. Every word of the query must be found (case and accents ignored) in the title, the address, the note or a
 * tag; a word that starts with "#" is a tag (its beginning is enough). `tags` are tags chosen in the panel: a bookmark must carry all of them.
 */
export function filterBookmarks(list: readonly Bookmark[], query: string, tags: readonly string[] = []): Bookmark[] {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  const wanted = tags.map(foldText)
  if (words.length === 0 && wanted.length === 0) return [...list]
  return list.filter((b) => {
    const own = b.tags.map(foldText)
    if (!wanted.every((tag) => own.includes(tag))) return false
    const haystack = foldText(`${b.title} ${b.url} ${b.note ?? ''} ${b.tags.join(' ')}`)
    return words.every((word) => (word.startsWith('#') ? (word.length > 1 ? own.some((tag) => tag.startsWith(word.slice(1))) : true) : haystack.includes(word)))
  })
}

export interface TagCount {
  tag: string
  count: number
}

/** The tags in use with how many bookmarks carry each (spelled as the first bookmark that has it spells it), the most used first, then by name. */
export function tagCounts(list: readonly Bookmark[]): TagCount[] {
  const counts = new Map<string, TagCount>()
  for (const bookmark of list) {
    for (const tag of bookmark.tags) {
      const key = foldText(tag)
      const known = counts.get(key)
      if (known) known.count++
      else counts.set(key, { tag, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'fr'))
}

/** The tags of every bookmark with `from` replaced by `to` (merged into `to` when a bookmark has both). Same array when nothing carries `from` or `to` is not a tag. */
export function renameTag(list: Bookmark[], from: string, to: string): Bookmark[] {
  const target = cleanTag(to)
  const key = foldText(from)
  if (target === null || !list.some((b) => b.tags.some((t) => foldText(t) === key))) return list
  const next = list.map((b) => (b.tags.some((t) => foldText(t) === key) ? { ...b, tags: cleanTags(b.tags.map((t) => (foldText(t) === key ? target : t))) } : b))
  return JSON.stringify(next) === JSON.stringify(list) ? list : next
}

/** The library without the tag `tag` on any bookmark. Same array when nothing carries it. */
export function removeTag(list: Bookmark[], tag: string): Bookmark[] {
  const key = foldText(tag)
  if (!list.some((b) => b.tags.some((t) => foldText(t) === key))) return list
  return list.map((b) => (b.tags.some((t) => foldText(t) === key) ? { ...b, tags: b.tags.filter((t) => foldText(t) !== key) } : b))
}

/** One bookmark as an import reads it from a file (before any check). */
export interface ImportedBookmark {
  url: unknown
  title?: unknown
  tags?: unknown
  note?: unknown
  /** Seconds since 1970, as the Netscape format writes it. */
  addedAt?: unknown
}

export interface BookmarkMerge {
  list: Bookmark[]
  added: number
  /** Already in the library: the file only added tags. */
  merged: number
  /** Already in the library with nothing to add. */
  already: number
  /** Entries that are not web pages, or whose address is too long. */
  skipped: number
  /** Valid entries the limit of the library kept out. */
  overLimit: number
}

/** A date in seconds from a file, as milliseconds; a date that is not one (or not yet) is the moment of the import. */
const importedDate = (seconds: unknown, now: number): number => {
  const ms = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : NaN
  return ms > 0 && ms <= now ? Math.floor(ms) : now
}

/**
 * What an import adds to the library: each valid entry once (a page already there only gets the tags it lacked), after the existing
 * ones, in the order of the file, up to `BOOKMARKS_LIMIT`. Nothing already there is lost or reordered.
 */
export function mergeBookmarks(list: readonly Bookmark[], entries: readonly ImportedBookmark[], ctx: Ctx): BookmarkMerge {
  const next = [...list]
  const index = new Map(next.map((b, i) => [bookmarkKey(b.url), i]))
  const result: BookmarkMerge = { list: next, added: 0, merged: 0, already: 0, skipped: 0, overLimit: 0 }
  for (const entry of Array.isArray(entries) ? entries.slice(0, BOOKMARK_IMPORT_SCAN_MAX) : []) {
    if (typeof entry !== 'object' || entry === null || !isBookmarkUrl(entry.url)) {
      result.skipped++
      continue
    }
    const at = index.get(bookmarkKey(entry.url))
    if (at !== undefined) {
      const known = next[at]!
      const tags = cleanTags([...known.tags, ...cleanTags(entry.tags)])
      if (tags.length > known.tags.length) {
        next[at] = { ...known, tags }
        result.merged++
      } else result.already++
      continue
    }
    if (next.length >= BOOKMARKS_LIMIT) {
      result.overLimit++
      continue
    }
    const bookmark = cleanBookmark({ url: entry.url, title: entry.title, tags: cleanTags(entry.tags), note: entry.note, addedAt: importedDate(entry.addedAt, ctx.now) }, ctx.newId())
    if (!bookmark) {
      result.skipped++
      continue
    }
    index.set(bookmarkKey(bookmark.url), next.push(bookmark) - 1)
    result.added++
  }
  return result
}

/** The sentence after an import: one part per kind of entry, each counted by the plural rules of the language (French counts zero as one). */
export function bookmarkImportSummary(merge: Pick<BookmarkMerge, 'added' | 'merged' | 'already' | 'skipped' | 'overLimit'>, truncated = false): string {
  const parts = [counted('bookmarks.count-signets-ajoutes', merge.added)]
  if (merge.merged > 0) parts.push(counted('bookmarks.count-signets-deja-presents-ont-recu-de-nouvelles-etiquettes', merge.merged))
  if (merge.already > 0) parts.push(counted('bookmarks.count-deja-presents', merge.already))
  if (merge.skipped > 0) parts.push(counted('bookmarks.count-elements-laisses-de-cote', merge.skipped))
  if (merge.overLimit > 0) parts.push(counted('bookmarks.count-signets-refuses-la-bibliotheque-est-limitee-a-max', merge.overLimit, { max: countText(BOOKMARKS_LIMIT) }))
  if (truncated) parts.push(t('bookmarks.le-fichier-est-plus-long-que-la-limite-de-lecture'))
  return `${parts.join(t('bookmarks.point-virgule'))}.`
}

/** What the panel asks of the file of bookmarks: bring one in, or save the library as one. Anything else is no request. */
export type BookmarksTransferRequest = { op: 'import' } | { op: 'export' }

/** How it went: a sentence for the panel, and whether something was done (a cancelled dialog says nothing). */
export interface BookmarksTransferReply {
  ok: boolean
  message: string
}

export function parseBookmarksTransferRequest(raw: unknown): BookmarksTransferRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const op = (raw as Record<string, unknown>)['op']
  return op === 'import' || op === 'export' ? { op } : null
}
