// « Découvrir Lucium », the two guides above the cards: the tip of the day and the path « Parcours de découverte » (renderer/DiscoverTip.tsx and
// DiscoverPath.tsx draw them). Pure: no window, no clock (the caller gives the day), nothing is sent or counted. What they remember is three settings,
// all kept on this machine and cleaned when the state file is read (shared/sidebar-state.ts): `discoverTip` (the switch, on by default), `discoverTipDay`
// (the day the tip was put away) and `discoverPath` (the steps of the path that are ticked).
//
// This file never imports discover.ts at run time, so that the cleaning of the state file can use it without a cycle; the catalogue is handed in.

import type { Settings } from './model'

/**
 * The steps of the path, in order: the id of a card of the catalogue each (discover-tips.test.ts compares them). One for each thing a person does in the
 * first minutes: go to a site, keep tabs apart, keep a page, protect themselves. The last has no « Essayer » (it is a setting): « Régler » is its button.
 */
export const DISCOVER_PATH_STEPS = ['command-bar', 'spaces', 'capture', 'protection'] as const
export type DiscoverPathStep = (typeof DISCOVER_PATH_STEPS)[number]

const isStep = (value: unknown): value is DiscoverPathStep => typeof value === 'string' && (DISCOVER_PATH_STEPS as readonly string[]).includes(value)

/** The ticked steps of a saved file: known steps only, each once, in the order of the path. Anything else is dropped, the rest is kept. */
export function cleanDiscoverPath(raw: unknown): DiscoverPathStep[] {
  const ticked = new Set<unknown>(Array.isArray(raw) ? raw : [])
  return DISCOVER_PATH_STEPS.filter((step) => ticked.has(step))
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A day as `YYYY-MM-DD` (local time) when it is a real day of the calendar, else the empty text (« never »). */
export function cleanDiscoverDay(raw: unknown): string {
  const match = typeof raw === 'string' ? DAY.exec(raw) : null
  if (!match) return ''
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? (raw as string) : ''
}

/** The day of `date` where the person is (local time), as the settings write it. */
export function dayKey(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/** Days since 1970 of a cleaned day; NaN for anything else. */
function dayNumber(day: string): number {
  const match = DAY.exec(cleanDiscoverDay(day))
  return match ? Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000) : NaN
}

/**
 * The function of the day: the same all day, the next one of the pool the next day, round and round. The pool is the cards that can be tried now
 * (`isOff` leaves out a function switched off, whose button would do nothing). No random draw: the same day shows the same tip on every window, and a test can say which.
 */
export function discoverTipEntry<E>(entries: readonly E[], day: string, isOff: (entry: E) => boolean): E | null {
  const offer = entries.filter((entry) => !isOff(entry))
  const n = dayNumber(day)
  if (offer.length === 0 || Number.isNaN(n)) return null
  return offer[((n % offer.length) + offer.length) % offer.length]!
}

/** Whether the tip card is drawn: the switch is on and it was not put away today (« never twice the same day »). */
export function showTipToday(settings: Pick<Settings, 'discoverTip' | 'discoverTipDay'>, today: string): boolean {
  return settings.discoverTip === true && cleanDiscoverDay(settings.discoverTipDay) !== cleanDiscoverDay(today)
}

/** « Compris » and « Essayer » put the tip away for the day. */
export const putTipAwayPatch = (today: string): Pick<Settings, 'discoverTipDay'> => ({ discoverTipDay: cleanDiscoverDay(today) })

/** The one-click switch of the card (off) and the box of the page (on or off); turning it on forgets the day it was put away, so that it shows at once. */
export const tipSettingPatch = (on: boolean): Pick<Settings, 'discoverTip' | 'discoverTipDay'> | Pick<Settings, 'discoverTip'> => (on ? { discoverTip: true, discoverTipDay: '' } : { discoverTip: false })

/** The patch that ticks (or unticks) a step: the list stays clean and in the order of the path. */
export function tickStepPatch(path: readonly string[], step: string, on: boolean): Pick<Settings, 'discoverPath'> {
  const next = new Set<unknown>(path)
  if (isStep(step)) {
    if (on) next.add(step)
    else next.delete(step)
  }
  return { discoverPath: cleanDiscoverPath([...next]) }
}

/** « Recommencer »: nothing is ticked. */
export const resetPathPatch = (): Pick<Settings, 'discoverPath'> => ({ discoverPath: [] })

/** How far the person is; a saved step that no longer exists does not count. */
export function pathProgress(path: readonly string[]): { done: number; total: number; complete: boolean } {
  const done = cleanDiscoverPath(path).length
  return { done, total: DISCOVER_PATH_STEPS.length, complete: done === DISCOVER_PATH_STEPS.length }
}
