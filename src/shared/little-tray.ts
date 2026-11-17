// The downloads tray of a mini window: a small card at the bottom of the window, over the page, with the files that page
// downloaded. The cotes are ours, in the window's own look.

import type { DownloadInfo } from './model'
import type { Rect } from './peek'
import { sortDownloads } from './downloads-view'

export const LITTLE_TRAY = { width: 380, margin: 10, row: 54, padding: 6, maxRows: 3, kept: 20 } as const

/** What the tray lists: the newest downloads first, as many as it has room for. */
export function trayRows(downloads: readonly DownloadInfo[]): DownloadInfo[] {
  return sortDownloads(downloads).slice(0, LITTLE_TRAY.maxRows)
}

/** The window keeps the last few downloads of its page: a new one replaces the older entry of the same file, and the list is bounded. */
export function withDownload(downloads: readonly DownloadInfo[], download: DownloadInfo): DownloadInfo[] {
  return [download, ...downloads.filter((d) => d.id !== download.id)].slice(0, LITTLE_TRAY.kept)
}

/** Where the tray goes in a window of this (content) size: 10 px from the left and bottom, null when there is nothing to show. `extra` is the room of a card above the rows (the action bubble, little-bubble.ts). */
export function trayBounds(window: { width: number; height: number }, rows: number, extra = 0): Rect | null {
  if (rows <= 0) return null
  const { width, margin, row, padding, maxRows } = LITTLE_TRAY
  const shown = Math.min(rows, maxRows)
  const height = shown * row + padding * 2 + Math.max(0, extra)
  return { x: margin, y: Math.max(0, window.height - margin - height), width: Math.max(0, Math.min(width, window.width - margin * 2)), height }
}
