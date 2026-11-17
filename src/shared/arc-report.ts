// The account of an import of a sidebar of spaces, written for the person who ran it: what came in, what an earlier import had already brought,
// what was left out and why. Pure: the main process counts, this turns the counts into the sentences the import sheet shows.

import { t } from './i18n'
import { MAX_IMPORTED_LINKS, counted, countText, importSource, type ImportCategory } from './import-sources'

export interface ArcCounts {
  /** Which parts the user asked for. */
  asked: readonly ImportCategory[]
  /** New in this run (not counting what an earlier import left in the sidebar). */
  spaces: number
  tabs: number
  folders: number
  favorites: number
  splits: number
  /** Spaces, tabs, folders, favorites and split views that an earlier import (or the same file read twice) had already brought: left as the user has them. */
  present: number
  /** Tab groups of the file: the tabs came in, the group did not. */
  tabGroups: number
  skipped: number
  overLimit: number
  /** Pages of the history file, and how many were added or updated. */
  history: { read: number; added: number } | null
  /** Parts asked for whose file was not found. */
  missing: readonly ImportCategory[]
}

/**
 * The headline and the detail lines of an import of a sidebar. With `preview`, the headline is the question put before anything is written.
 * `source` is the name the import sheet shows for the browser (its application's own name on this Mac, or the generic label).
 */
export function arcSummary(c: ArcCounts, preview = false, source = importSource('arc')?.name ?? ''): { message: string; details: string[] } {
  const parts: string[] = []
  if (c.asked.includes('sidebar')) {
    parts.push(counted('arc-summary.spaces', c.spaces), counted('arc-summary.tabs', c.tabs), counted('import-summary.folder', c.folders), counted('arc-summary.favorites', c.favorites), counted('arc-summary.splits', c.splits))
  }
  if (c.history) parts.push(counted('import-summary.history', c.history.added))
  const nothingNew = c.spaces + c.tabs + c.folders + c.favorites + c.splits + (c.history?.added ?? 0) === 0
  const message =
    nothingNew && c.present > 0 ? t('arc-summary.nothing-new', { source }) : t(preview ? 'arc-summary.preview-headline' : 'arc-summary.headline', { source, parts: parts.join(', ') })

  const details: string[] = []
  if (c.present > 0) details.push(counted('arc-summary.present', c.present))
  if (c.tabGroups > 0) details.push(counted('arc-summary.tab-groups', c.tabGroups))
  if (c.skipped > 0) details.push(counted('arc-summary.skipped', c.skipped))
  if (c.overLimit > 0) details.push(counted('import-summary.over-limit', c.overLimit, { limit: countText(MAX_IMPORTED_LINKS) }))
  if (c.history) details.push(t('arc-summary.history-detail', { read: counted('arc-summary.pages-read', c.history.read), added: counted('arc-summary.pages-added', c.history.added) }))
  if (c.missing.includes('history')) details.push(t('arc-summary.history-missing'))
  return { message, details }
}
