// "Effacer l'historique" over a span of time (the last hour, today, 7 days, 4 weeks, everything) and the automatic purge ("garder N jours").
// The interface names a span by one of five words, never by two moments: the main process works the bounds out itself, so that a message cannot
// ask for any span but these (the same care as `isHistoryDay`). Pure, so that the bounds are measured without a window.

import type { MessageKey } from './i18n'

export const HISTORY_RANGES = ['hour', 'today', 'week', 'month', 'all'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

export const isHistoryRange = (value: unknown): value is HistoryRange => typeof value === 'string' && (HISTORY_RANGES as readonly string[]).includes(value)

const HOUR_MS = 3_600_000

/**
 * The span a range covers, from `from` (included) to `to` (excluded), at `now`. `to` is one millisecond past `now`: a page visited this very
 * instant goes with it. « Aujourd’hui » starts at the local midnight, « 7 jours » and « 4 semaines » are counted back from now.
 */
export function historyRangeBounds(range: HistoryRange, now: number): { from: number; to: number } {
  const to = now + 1
  switch (range) {
    case 'hour':
      return { from: now - HOUR_MS, to }
    case 'today': {
      const date = new Date(now)
      return { from: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(), to }
    }
    case 'week':
      return { from: now - 7 * 24 * HOUR_MS, to }
    case 'month':
      return { from: now - 28 * 24 * HOUR_MS, to }
    case 'all':
      return { from: 0, to }
  }
}

/** The numbers of days « Garder l'historique » offers; 0 is « toujours » (no purge, the default). */
export const HISTORY_KEEP_CHOICES = [0, 7, 30, 90, 365] as const

/** A number of days to keep: a whole number from 1 to 3650, or 0 for « no purge ». What the file says otherwise is no purge. */
export const cleanKeepDays = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : 0)

/** The moment before which a page is purged (its last visit is older), or null while nothing is purged. */
export function purgeCutoff(keepDays: number, now: number): number | null {
  const days = cleanKeepDays(keepDays)
  return days === 0 ? null : now - days * 24 * HOUR_MS
}

/** What each span is called in the menu, and what the notice says once it is forgotten. */
export const HISTORY_RANGE_TEXTS: Readonly<Record<HistoryRange, { label: MessageKey; done: MessageKey }>> = {
  hour: { label: 'history-days.periode-heure', done: 'history-days.periode-heure-oubliee' },
  today: { label: 'history-days.periode-aujourdhui', done: 'history-days.periode-aujourdhui-oubliee' },
  week: { label: 'history-days.periode-semaine', done: 'history-days.periode-semaine-oubliee' },
  month: { label: 'history-days.periode-mois', done: 'history-days.periode-mois-oubliee' },
  all: { label: 'history-days.periode-tout', done: 'history-days.periode-tout-oubliee' }
}

/** The labels of the delays « Garder l'historique » offers. */
export const HISTORY_KEEP_LABELS: Readonly<Record<(typeof HISTORY_KEEP_CHOICES)[number], MessageKey>> = {
  0: 'history-days.garder-toujours',
  7: 'history-days.garder-7',
  30: 'history-days.garder-30',
  90: 'history-days.garder-90',
  365: 'history-days.garder-365'
}
