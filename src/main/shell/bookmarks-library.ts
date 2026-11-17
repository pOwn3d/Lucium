// The file side of the bookmark library: "Importer…" reads a bookmarks file the user chose and "Exporter…" writes the library as one. The
// interface sends no path and no text: the dialogs are the main process', the file is read with a size bound (and never executed or fetched:
// only its links are kept, as data), and the entries go to the reducer, which checks each one again. A private window keeps no library, so it
// neither imports nor exports. What the file holds is hostile: see parseNetscapeBookmarks for the bounds on tags, depth and number of elements.

import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog, type BrowserWindow } from 'electron'
import { BOOKMARK_IMPORT_SCAN_MAX, bookmarkImportSummary, cleanTag, cleanTags, mergeBookmarks, type BookmarksTransferReply, type BookmarksTransferRequest, type ImportedBookmark } from '@shared/bookmarks'
import { exportLibraryHtml, libraryExportSummary } from '@shared/bookmarks-html'
import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import type { BookmarkNode } from '../importers/bookmark-tree'
import { parseNetscapeBookmarks } from '../importers/netscape'
import { writeFailureReason } from '../importers/read-error'
import { decodeFileText } from '../importers/text-encoding'
import { fileFailureMessage, readBoundedText } from './bounded-file'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

/** The largest bookmarks file read: browsers write a few hundred kilobytes for tens of thousands of bookmarks. */
export const BOOKMARKS_FILE_MAX_BYTES = 8 * 1024 * 1024

// Functions, not constants: the language of the process is set after this module is loaded.
export const libraryPrivateMessage = (): string => t('bookmarks-library.la-bibliotheque-de-signets-n-est-pas-disponible')
export const libraryOffMessage = (): string => t('bookmarks-library.la-bibliotheque-de-signets-est-desactivee', { settingsPath: settingsPath('bookmarkLibrary') })
export const libraryEmptyMessage = (): string => t('bookmarks-library.rien-a-exporter-la-bibliotheque-est-vide')

export interface LibraryFile {
  entries: ImportedBookmark[]
  /** The file holds more than the parser reads (see NETSCAPE_MAX_NODES): the end was not read. */
  truncated: boolean
}

/**
 * The links of a bookmarks file as entries of the library: the tags it gives (`TAGS="a,b"`), plus the name of the folder each link sits in
 * (a link in "Recettes" is tagged "Recettes", which keeps what the other browser's folders meant), and the date and note it holds.
 * At most BOOKMARK_IMPORT_SCAN_MAX entries are made.
 */
export function libraryEntriesFromHtml(html: string): LibraryFile {
  const { nodes, truncated } = parseNetscapeBookmarks(html, { details: true })
  const entries: ImportedBookmark[] = []
  const walk = (list: BookmarkNode[], folder: string | null): void => {
    for (const node of list) {
      if (entries.length >= BOOKMARK_IMPORT_SCAN_MAX) return
      if (node.kind === 'folder') {
        walk(node.children, node.title)
        continue
      }
      const fromFolder = folder === null ? null : cleanTag(folder)
      entries.push({ url: node.url, title: node.title, tags: cleanTags([...(node.tags ?? '').split(','), ...(fromFolder === null ? [] : [fromFolder])]), ...(node.note ? { note: node.note } : {}), ...(node.addedAt ? { addedAt: node.addedAt } : {}) })
    }
  }
  walk(nodes, null)
  return { entries, truncated: truncated || entries.length >= BOOKMARK_IMPORT_SCAN_MAX }
}

export interface LibraryTarget {
  win: BrowserWindow
  state: SidebarState
  isPrivate: boolean
  dispatch: (action: Action) => void
}

export async function transferBookmarks(target: LibraryTarget, request: BookmarksTransferRequest): Promise<BookmarksTransferReply> {
  if (target.isPrivate) return { ok: false, message: libraryPrivateMessage() }
  if (!target.state.settings.bookmarkManager) return { ok: false, message: libraryOffMessage() }
  return request.op === 'import' ? importLibrary(target) : exportLibrary(target)
}

async function importLibrary(target: LibraryTarget): Promise<BookmarksTransferReply> {
  const picked = await dialog.showOpenDialog(target.win, {
    title: t('bookmarks-library.importer-des-signets-html'),
    properties: ['openFile'],
    filters: [
      { name: t('bookmarks-library.signets-html'), extensions: ['html', 'htm'] },
      { name: t('feature.tous-les-fichiers'), extensions: ['*'] }
    ]
  })
  const [path] = picked.filePaths
  // Giving up changes nothing and says nothing.
  if (picked.canceled || !path) return { ok: false, message: '' }
  // Another program may have written it in UTF-16 or in Windows-1252: it is read as the file says it is, not refused for not being UTF-8.
  const read = await readBoundedText(path, BOOKMARKS_FILE_MAX_BYTES, decodeFileText)
  if (!read.ok) return { ok: false, message: fileFailureMessage(read, BOOKMARKS_FILE_MAX_BYTES) }
  const { entries, truncated } = libraryEntriesFromHtml(read.text)
  if (entries.length === 0) return { ok: false, message: t('signets.aucun-signet-dans-fichier', { file: basename(path) }) }
  // The same merge as the reducer's, to say what will happen (ids are not used here).
  const merge = mergeBookmarks(target.state.bookmarks, entries, { now: Date.now(), newId: () => randomUUID() })
  target.dispatch({ type: 'bookmarks/import', entries })
  return { ok: true, message: t('bookmarks-library.file-summary', { file: basename(path), summary: bookmarkImportSummary(merge, truncated) }) }
}

async function exportLibrary(target: LibraryTarget): Promise<BookmarksTransferReply> {
  const { html, count, skipped } = exportLibraryHtml(target.state.bookmarks)
  if (count === 0) return { ok: false, message: libraryEmptyMessage() }
  const saved = await dialog.showSaveDialog(target.win, {
    title: t('bookmarks-library.exporter-les-signets-de-la-bibliotheque-html'),
    defaultPath: 'lucium-bibliotheque-signets.html',
    filters: [{ name: t('bookmarks-library.signets-html'), extensions: ['html'] }]
  })
  if (saved.canceled || !saved.filePath) return { ok: false, message: '' }
  try {
    await writeFile(saved.filePath, html, 'utf8')
  } catch (error) {
    console.error(`[bookmarks] cannot write ${saved.filePath}:`, error)
    return { ok: false, message: t('signets.enregistrement-impossible-dans', { file: basename(saved.filePath), reason: writeFailureReason(error) }) }
  }
  return { ok: true, message: t('signets.enregistre-dans', { path: saved.filePath, summary: libraryExportSummary(count, skipped) }) }
}
