// The history a rebuilt page inherits (see Browser.rebuildForAutoplay): only the pages that can be loaded again, with the index of the page
// the tab was on. Kept apart from electron-engine.ts so the rule is tested without Electron.

export interface HistoryEntry {
  title: string
  url: string
}

export interface PageHistory {
  entries: HistoryEntry[]
  index: number
}

/**
 * The entries of `history` that `canLoad` accepts (an error page, an address of another scheme and a `view-source:` are not worth
 * restoring), with the index of the entry the tab was on, or of the last kept entry before it when that one was dropped. Null when
 * nothing is left to restore.
 */
export function restorableHistory(history: PageHistory, canLoad: (url: string) => boolean): PageHistory | null {
  const entries: HistoryEntry[] = []
  let index = 0
  history.entries.forEach((entry, at) => {
    if (typeof entry?.url !== 'string' || !canLoad(entry.url)) return
    if (at <= history.index) index = entries.length
    entries.push({ title: typeof entry.title === 'string' ? entry.title : '', url: entry.url })
  })
  return entries.length === 0 ? null : { entries, index }
}
