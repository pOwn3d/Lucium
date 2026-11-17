import { dialog, type BrowserWindow } from 'electron'
import type { BackupListing } from '@shared/session-backups'
import { noticeDialog, onPersistenceNotice } from '../persistence-notices'

/** When the newest automatic copy of the session was made, from the listing of the copies (newest first, see SessionBackups.list); null without one. */
export function newestCopyAt(listing: Pick<BackupListing, 'entries'>): number | null {
  return listing.entries[0]?.createdAt ?? null
}

/**
 * Shows a dialog for every file that could not be read or written (see persistence-notices.ts), those of the start-up included.
 * Call it once the first window exists; answers the function that stops it. `newestCopy` says when the newest automatic copy of the session was made, for the dialog of a state that could not be read.
 */
export function announcePersistenceNotices(win: BrowserWindow, newestCopy: () => number | null): () => void {
  return onPersistenceNotice((notice) => {
    const options = { type: 'warning' as const, ...noticeDialog(notice, newestCopy()) }
    // A sheet on a hidden window (the main window put away on macOS) is never seen: the box stands alone then. A window gone (the quit) asks nothing.
    if (win.isDestroyed()) return
    const shown = win.isVisible() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    void shown.catch((error: unknown) => console.error('[persistence] cannot show the notice:', error))
  })
}
