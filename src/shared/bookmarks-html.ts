// Exporting the favourites, pinned tabs and folders to the bookmarks file every browser reads (the Netscape format: nested <DL> lists,
// <H3> for a folder, <A HREF> for a link). This is the way out for the data, and the way into any
// other browser. Pure: the main process asks for the text and writes it where the user chose (shell/bookmarks-export.ts).

import { tabName, type Bookmark, type Folder, type SidebarState, type TabItem } from './model'
import { t } from './i18n'
import { escapeHtml as escapeMarkup } from './html-escape'
import { counted } from './import-sources'

/** Longest address written: more than a web server would answer is a data URI in disguise or a damaged tab (same bound as the importers). */
const MAX_URL_LENGTH = 8192
const EXPORTABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'file:'])

export interface BookmarksExportOptions {
  /** The Today tabs too, in a folder of their own for each space. Off by default: they are what the day left open, not what was kept. */
  includeToday: boolean
}

export interface BookmarksExportCounts {
  spaces: number
  /** Pinned tabs and Today tabs written. */
  links: number
  folders: number
  favorites: number
  /** Today tabs among the links. */
  today: number
  /** Tabs and favourites not written because their address is not a web page or a file (internal pages, extensions, `javascript:`…). */
  skipped: number
}

export interface BookmarksExport {
  html: string
  counts: BookmarksExportCounts
}

/** What the interface gets back from "Exporter les signets" : where the file went (null when nothing was written) and a sentence for the user. */
export interface BookmarksExportOutcome {
  path: string | null
  message: string
}

/** What a request from the interface says, checked: a flag that is exactly `true` asks for the Today tabs; anything that is not an object asks for nothing. */
export function parseBookmarksExportRequest(raw: unknown): BookmarksExportOptions | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return { includeToday: (raw as Record<string, unknown>)['includeToday'] === true }
}

/** The address as it is written, or null when it is not one the file may hold: only http, https and file, no control character, bounded. */
export function exportableUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || /\p{Cc}/u.test(value) || !URL.canParse(value)) return null
  const url = new URL(value)
  return EXPORTABLE_PROTOCOLS.has(url.protocol) && url.href.length <= MAX_URL_LENGTH ? url.href : null
}

/** Text for an HTML element or a quoted attribute: control characters become spaces, then the five characters HTML reads are replaced. */
export function escapeHtml(text: string): string {
  return escapeMarkup(text.replace(/\p{Cc}/gu, ' '))
}

const seconds = (ms: number): string | null => (Number.isFinite(ms) && ms > 0 ? String(Math.floor(ms / 1000)) : null)

const INDENT = '    '
/**
 * How deep folders nest in the file. The sidebar makes four levels at most; a state that was damaged or forged may hold a chain of thousands, which
 * the writing of nested folders would follow until the stack ran out. Below this depth, the folders are written one level up, beside the others.
 */
export const BOOKMARKS_EXPORT_DEPTH_MAX = 32

/** The text of the bookmarks file for the pinned tabs, folders (nested as they are), and favourites of every space. */
export function exportBookmarksHtml(state: SidebarState, options: BookmarksExportOptions): BookmarksExport {
  const counts: BookmarksExportCounts = { spaces: 0, links: 0, folders: 0, favorites: 0, today: 0, skipped: 0 }
  const out: string[] = []
  const line = (depth: number, text: string) => out.push(`${INDENT.repeat(depth)}${text}`)

  /** Writes one link; false (and counted as left aside) when its address is not one the file may hold. */
  const link = (depth: number, entry: { url: string; title: string; addedAt?: number; usedAt?: number }): boolean => {
    const href = exportableUrl(entry.url)
    if (href === null) {
      counts.skipped++
      return false
    }
    const added = seconds(entry.addedAt ?? NaN)
    const used = seconds(entry.usedAt ?? NaN)
    const title = entry.title.replace(/\p{Cc}/gu, ' ').trim() || href
    line(depth, `<DT><A HREF="${escapeHtml(href)}"${added ? ` ADD_DATE="${added}"` : ''}${used ? ` LAST_MODIFIED="${used}"` : ''}>${escapeHtml(title)}</A>`)
    return true
  }
  const tabLink = (depth: number, tab: TabItem): boolean => link(depth, { url: tab.url, title: tabName(tab), addedAt: tab.createdAt, usedAt: tab.lastActiveAt })

  const folder = (depth: number, name: string, body: () => void): void => {
    line(depth, `<DT><H3>${escapeHtml(name.replace(/\p{Cc}/gu, ' ').trim() || t('import.dossier-sans-nom'))}</H3>`)
    line(depth, '<DL><p>')
    body()
    line(depth, '</DL><p>')
  }

  line(0, '<!DOCTYPE NETSCAPE-Bookmark-file-1>')
  line(0, '<!-- This is an automatically generated file.')
  line(0, '     It will be read and overwritten.')
  line(0, '     DO NOT EDIT! -->')
  line(0, '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
  line(0, `<TITLE>${escapeHtml(t('bookmarks-html.signets-de-lucium'))}</TITLE>`)
  line(0, `<H1>${escapeHtml(t('bookmarks-html.signets-de-lucium'))}</H1>`)
  line(0, '<DL><p>')
  if (state.favorites.length > 0) {
    // Each profile has its own favourites, and a file has one folder of them: an address that several profiles have is written once.
    const written = new Set<string>()
    folder(1, t('bookmarks-html.favoris'), () => {
      for (const favorite of state.favorites) {
        if (written.has(favorite.url)) continue
        written.add(favorite.url)
        if (link(2, { url: favorite.url, title: favorite.title })) counts.favorites++
      }
    })
  }
  for (const space of state.spaces) {
    counts.spaces++
    const folders = state.folders.filter((f) => f.spaceId === space.id)
    const known = new Set(folders.map((f) => f.id))
    const seen = new Set<string>()
    // A private tab is written nowhere (model.ts): the state a window shows lists them, a file never does, pinned or not.
    const tabs = state.tabs.filter((t) => t.spaceId === space.id && t.private !== true)
    const pinnedIn = (folderId: string | undefined) => tabs.filter((t) => t.pinned && (folderId === undefined ? !t.folderId || !known.has(t.folderId) : t.folderId === folderId))
    const writeFolder = (depth: number, f: Folder): void => {
      // The tree is repaired when a state is loaded; a loop in one that was not would otherwise never end.
      if (seen.has(f.id)) return
      seen.add(f.id)
      counts.folders++
      folder(depth, f.name, () => {
        for (const tab of pinnedIn(f.id)) if (tabLink(depth + 1, tab)) counts.links++
        // Past the bound, the folders below are left to the loop of the stray ones (each written from one level up): none is lost, the stack stays small.
        if (depth >= BOOKMARKS_EXPORT_DEPTH_MAX) return
        for (const child of folders.filter((c) => c.parentId === f.id)) writeFolder(depth + 1, child)
      })
    }
    folder(1, space.name, () => {
      // Loose pinned tabs first, then the folders, as the sidebar lists them (a tab or a folder whose folder is gone is loose).
      for (const tab of pinnedIn(undefined)) if (tabLink(2, tab)) counts.links++
      for (const root of folders.filter((f) => !f.parentId || !known.has(f.parentId))) writeFolder(2, root)
      // Folders only a loop leads to have no root above them: written here rather than lost with their tabs.
      for (const stray of folders) writeFolder(2, stray)
      const today = options.includeToday ? tabs.filter((t) => !t.pinned) : []
      if (today.length > 0) folder(2, t('bookmarks-html.aujourd-hui'), () => today.forEach((tab) => tabLink(3, tab) && counts.today++))
    })
  }
  line(0, '</DL><p>')
  return { html: `${out.join('\n')}\n`, counts }
}

/** The sentence after an export: what the file holds, and what it left out. */
export function bookmarksExportSummary(counts: BookmarksExportCounts, includeToday: boolean): string {
  const parts = [counted('signets.onglets-epingles', counts.links), counted('signets.dossiers', counts.folders), counted('signets.favoris', counts.favorites)]
  if (includeToday) parts.push(counted('signets.onglets-du-jour', counts.today))
  const skipped = counts.skipped > 0 ? ` ${counted('signets.laisses-de-cote', counts.skipped)}` : ''
  return `${t('signets.resume-export', { parts: parts.join(', '), spaces: counted('signets.espaces', counts.spaces) })}${skipped}`
}

/** What exporting the bookmark library writes. */
export interface LibraryExport {
  html: string
  /** Bookmarks written. */
  count: number
  /** Bookmarks left out because their address is not one the file may hold. */
  skipped: number
}

/**
 * The bookmark library as a bookmarks file: one flat list, each link with its date (`ADD_DATE`), its tags (`TAGS="a,b"`, what some browsers and
 * the bookmark services read) and its note under it (`<DD>`). The library's own reader (the import of "Signets") reads the same file back.
 */
export function exportLibraryHtml(bookmarks: readonly Bookmark[]): LibraryExport {
  const heading = escapeHtml(t('bookmarks-html.signets-de-lucium'))
  const out: string[] = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<!-- This is an automatically generated file.', '     It will be read and overwritten.', '     DO NOT EDIT! -->', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', `<TITLE>${heading}</TITLE>`, `<H1>${heading}</H1>`, '<DL><p>']
  let count = 0
  let skipped = 0
  for (const bookmark of bookmarks) {
    const href = exportableUrl(bookmark.url)
    if (href === null) {
      skipped++
      continue
    }
    const added = seconds(bookmark.addedAt)
    const title = bookmark.title.replace(/\p{Cc}/gu, ' ').trim() || href
    const tags = bookmark.tags.filter((tag) => !/[,\p{Cc}]/u.test(tag))
    out.push(`${INDENT}<DT><A HREF="${escapeHtml(href)}"${added ? ` ADD_DATE="${added}"` : ''}${tags.length > 0 ? ` TAGS="${escapeHtml(tags.join(','))}"` : ''}>${escapeHtml(title)}</A>`)
    if (bookmark.note) out.push(`${INDENT}<DD>${escapeHtml(bookmark.note)}`)
    count++
  }
  out.push('</DL><p>')
  return { html: `${out.join('\n')}\n`, count, skipped }
}

/** The sentence after exporting the library. */
export function libraryExportSummary(count: number, skipped: number): string {
  const left = skipped > 0 ? ` ${counted('signets.signets-laisses', skipped)}` : ''
  return `${counted('signets.signets', count)}.${left}`
}
