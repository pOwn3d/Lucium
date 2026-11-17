// The history panel in two columns: the days on the left, the pages of the chosen day on the right. The pages come from one
// search (the profile's history, newest first, or the best matches); the days are worked out here from their last visit, in the person's own time zone.
// Pure, so that "which day is this page on" and "which day is shown" are measured without a window.

import type { HistoryEntry } from './model'
import { getLanguage, t } from './i18n'

/** The column that lists every page found, whatever its day. */
export const ALL_DAYS = 'all'

export interface HistoryDay {
  /** The calendar day, `2026-10-28`: sorts as time does. */
  key: string
  label: string
  count: number
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The calendar day (local time) of a moment. */
export function dayKey(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const midnight = (time: number): number => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const locale = (): string => (getLanguage() === 'fr' ? 'fr-FR' : 'en-US')

/** "Aujourd’hui", "Hier", the weekday for the rest of the week, then the date (with the year when it is not this one). */
export function dayLabel(time: number, now: number): string {
  // A day is not always 24 hours long (clocks change): the difference is rounded.
  const ago = Math.round((midnight(now) - midnight(time)) / 86_400_000)
  if (ago <= 0) return t('history-days.aujourd-hui')
  if (ago === 1) return t('history-days.hier')
  const date = new Date(time)
  if (ago < 7) {
    const weekday = date.toLocaleDateString(locale(), { weekday: 'long' })
    return weekday.charAt(0).toUpperCase() + weekday.slice(1)
  }
  return date.toLocaleDateString(locale(), date.getFullYear() === new Date(now).getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The days that hold at least one page, the newest first, with how many pages each holds. */
export function historyDays(entries: readonly HistoryEntry[], now: number): HistoryDay[] {
  const days = new Map<string, HistoryDay>()
  for (const entry of entries) {
    const key = dayKey(entry.lastVisitAt)
    const day = days.get(key)
    if (day) day.count++
    else days.set(key, { key, label: dayLabel(entry.lastVisitAt, now), count: 1 })
  }
  return [...days.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
}

/** The pages of a day, in the order they came in (newest first, or best match first); `ALL_DAYS` is every page. */
export function entriesOfDay(entries: readonly HistoryEntry[], day: string): HistoryEntry[] {
  return day === ALL_DAYS ? [...entries] : entries.filter((entry) => dayKey(entry.lastVisitAt) === day)
}

/**
 * The column shown. The person's own choice stays while it still holds a page; otherwise the newest day, or every page while a search is under way
 * (a search must not hide its results behind a day that has none).
 */
export function shownDay(days: readonly HistoryDay[], chosen: string | null, searching: boolean): string {
  if (chosen === ALL_DAYS) return ALL_DAYS
  if (chosen !== null && days.some((day) => day.key === chosen)) return chosen
  return searching || days.length === 0 ? ALL_DAYS : days[0]!.key
}

/** The bounds of a calendar day (local time) given by its key: from its midnight (included) to the next one (excluded). Null for what is not a day's key. */
export function dayBounds(key: string): { from: number; to: number } | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!parts) return null
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const from = new Date(year, month - 1, day)
  // A date that does not exist (the 31st of a month of 30 days) rolls over to another day: it is no day's key.
  if (from.getFullYear() !== year || from.getMonth() !== month - 1 || from.getDate() !== day) return null
  return { from: from.getTime(), to: new Date(year, month - 1, day + 1).getTime() }
}

/** The longest a day lasts: 25 hours, when the clocks go back. */
const DAY_MAX_MS = 25 * 3_600_000

/** Whether `from` and `to` can be the bounds of one day: two moments in order, no further apart than a day is long. */
export function isHistoryDay(from: unknown, to: unknown): boolean {
  return typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to - from <= DAY_MAX_MS
}

/** The time of a visit, and with `withDay` its date before it (the column that lists every day). */
export function visitTime(time: number, withDay: boolean): string {
  const clock = new Date(time).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  return withDay ? `${new Date(time).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })} ${clock}` : clock
}

/** The id under which the undo queue hides every page of a day that was forgotten at once. */
export const DAY_UNDO = 'day:'

export interface HistoryColumns {
  /** The pages left once the ones forgotten for now (the undo queue's ids: a page's address, or `DAY_UNDO` and a day) are taken away. */
  alive: HistoryEntry[]
  days: HistoryDay[]
  /** The column shown: a day's key or `ALL_DAYS`. */
  day: string
  /** Its pages. */
  rows: HistoryEntry[]
}

/** What the panel draws from what the search found: the days, the column shown and its pages. */
export function historyColumns(entries: readonly HistoryEntry[], hidden: ReadonlySet<string>, chosen: string | null, searching: boolean, now: number): HistoryColumns {
  const alive = entries.filter((entry) => !hidden.has(entry.url) && !hidden.has(DAY_UNDO + dayKey(entry.lastVisitAt)))
  const days = historyDays(alive, now)
  const day = shownDay(days, chosen, searching)
  return { alive, days, day, rows: entriesOfDay(alive, day) }
}
