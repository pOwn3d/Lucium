// Visit history of other browsers. Each stores its pages in a SQLite file; sqlite.ts reads them and does the arithmetic on dates
// in SQL (those of Chromium-based browsers are microseconds since 1601, too large for a JavaScript integer), so every row arrives here as epoch milliseconds.

import type { HistoryEntry } from '@shared/model'
import { TITLE_MAX } from '@shared/state-clean'
import { displayText, isWebUrl } from './limits'

/** What the history store keeps at most (history.ts): a longer import would push out its own oldest pages. */
export const MAX_IMPORTED_PAGES = 20_000

export interface HistoryRow {
  url: unknown
  title: unknown
  visits: unknown
  /** Epoch milliseconds of the last visit. */
  ms: unknown
}

/** The pages worth keeping: web addresses only, once each (visits added, latest visit kept), newest first, never dated in the future. */
export function toHistoryEntries(rows: readonly HistoryRow[], now = Date.now()): HistoryEntry[] {
  const byUrl = new Map<string, HistoryEntry>()
  for (const row of rows) {
    if (!isWebUrl(row.url)) continue
    const ms = Number(row.ms)
    if (!Number.isFinite(ms) || ms <= 0) continue
    const visits = Math.max(1, Math.round(Number(row.visits)) || 1)
    const last = Math.min(ms, now)
    const known = byUrl.get(row.url)
    byUrl.set(row.url, {
      url: row.url,
      title: displayText(row.title, TITLE_MAX)?.trim() || known?.title || row.url.slice(0, TITLE_MAX),
      visitCount: (known?.visitCount ?? 0) + visits,
      lastVisitAt: Math.max(known?.lastVisitAt ?? 0, last)
    })
  }
  return [...byUrl.values()].sort((a, b) => b.lastVisitAt - a.lastVisitAt).slice(0, MAX_IMPORTED_PAGES)
}
