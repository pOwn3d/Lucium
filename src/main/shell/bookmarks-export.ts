// "Exporter les signets (HTML)…": the pinned tabs, folders and favourites of every space, as the bookmarks file every browser reads.
// The text comes from shared/bookmarks-html.ts; this file asks where it goes and puts it there, and nowhere else: the one path is the one
// the user chose in the save dialog (the interface sends options, never a path), and the file is written in place rather than through a
// temporary file next to it. A private window keeps no space, pin or favourite: it exports nothing and opens no dialog.

import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import { bookmarksExportSummary, exportBookmarksHtml, type BookmarksExportOptions, type BookmarksExportOutcome } from '@shared/bookmarks-html'
import type { SidebarState } from '@shared/model'
import { writeFailureReason } from '../importers/read-error'
import { t } from '@shared/i18n'

// Functions, not constants: the language of the process is set after this module is loaded.
export const privateExportMessage = (): string => t('bookmarks-export.l-export-des-signets-n-est-pas-disponible')
export const lockedExportMessage = (): string => t('bookmarks-export.deverrouillez-vos-espaces-verrouilles-avant-d')
export const nothingToExportMessage = (): string => t('bookmarks-export.rien-a-exporter-aucun-onglet-epingle-dossier')

export interface BookmarksExportTarget {
  win: BrowserWindow
  state: SidebarState
  isPrivate: boolean
  /** The spaces a lock holds shut at this moment: the file lists the pins and folders of every space, so none may be locked. */
  lockedSpaces?: readonly string[]
}

export async function exportBookmarks(target: BookmarksExportTarget, options: BookmarksExportOptions): Promise<BookmarksExportOutcome> {
  if (target.isPrivate) return { path: null, message: privateExportMessage() }
  if ((target.lockedSpaces?.length ?? 0) > 0) return { path: null, message: lockedExportMessage() }
  const { html, counts } = exportBookmarksHtml(target.state, options)
  if (counts.links + counts.folders + counts.favorites + counts.today === 0) return { path: null, message: nothingToExportMessage() }
  const saved = await dialog.showSaveDialog(target.win, {
    title: t('settings.exporter-les-signets-html'),
    defaultPath: 'lucium-signets.html',
    filters: [{ name: t('bookmarks-export.signets-html'), extensions: ['html'] }]
  })
  // Giving up writes nothing and says nothing.
  if (saved.canceled || !saved.filePath) return { path: null, message: '' }
  try {
    await writeFile(saved.filePath, html, 'utf8')
  } catch (error) {
    console.error(`[bookmarks] cannot write ${saved.filePath}:`, error)
    return { path: null, message: t('signets.enregistrement-impossible-dans', { file: basename(saved.filePath), reason: writeFailureReason(error) }) }
  }
  return { path: saved.filePath, message: t('signets.enregistre-dans', { path: saved.filePath, summary: bookmarksExportSummary(counts, options.includeToday) }) }
}
