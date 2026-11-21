// Focus mode: a list of sites that stay closed while a timer runs or a weekly time slot is on. Pure rules; the main process asks
// `focusBlock` for each navigation of a page's main frame and shows the page of `renderErrorPage` (kind 'focus') when it answers.
// A feature that is off costs nothing: the request filter is not even installed (browser-network.ts).

import { defaultSettings, type Settings } from './model'
import { cleanHostEntries, normalizeHostEntry } from './host-entry'
import { matchesHost } from './url'

export type FocusSettings = Pick<Settings, 'focusMode' | 'focusSites' | 'focusScheduleOn' | 'focusDays' | 'focusFrom' | 'focusTo' | 'focusMinutes' | 'focusUntil' | 'focusSnoozeUntil'>

/** Sites in the list: more than anyone writes by hand, and a bound for a hand-edited file. */
export const FOCUS_SITES_MAX = 200
/** The shortest and the longest timer, in minutes (a day). */
export const FOCUS_MINUTES_MIN = 1
export const FOCUS_MINUTES_MAX = 1440
/** What « Faire une pause » on the block page gives, in minutes. */
export const FOCUS_PAUSE_MINUTES = 15
const DAY_MINUTES = 1440
const MINUTE_MS = 60_000
const ADDRESS_MAX = 2048

/** The host a person typed or pasted, written one way; null when it is not a host. */
export const normalizeFocusSite = (input: unknown): string | null => normalizeHostEntry(input, ADDRESS_MAX)

/** What a saved list may hold: valid hosts only, each once. */
export const cleanFocusSites = (value: unknown): string[] => cleanHostEntries(value, normalizeFocusSite, FOCUS_SITES_MAX)

const integerIn = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback

/** The focus settings of a saved file: a value of the wrong kind falls back to the default instead of reaching the filter. */
export function cleanFocusSettings(settings: Settings): FocusSettings {
  const defaults = defaultSettings()
  const days: unknown = settings.focusDays
  const kept = Array.isArray(days) ? [...new Set(days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b) : null
  const instant = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
  return {
    focusMode: settings.focusMode === true,
    focusSites: cleanFocusSites(settings.focusSites),
    focusScheduleOn: settings.focusScheduleOn === true,
    focusDays: kept ?? defaults.focusDays,
    focusFrom: integerIn(settings.focusFrom, 0, DAY_MINUTES - 1, defaults.focusFrom),
    focusTo: integerIn(settings.focusTo, 0, DAY_MINUTES - 1, defaults.focusTo),
    focusMinutes: integerIn(settings.focusMinutes, FOCUS_MINUTES_MIN, FOCUS_MINUTES_MAX, defaults.focusMinutes),
    focusUntil: instant(settings.focusUntil),
    focusSnoozeUntil: instant(settings.focusSnoozeUntil)
  }
}

/** Whether the weekly slot holds `now` (local time). A slot that ends before it starts runs over midnight and belongs to the day it began. */
export function inFocusSlot(settings: Pick<Settings, 'focusDays' | 'focusFrom' | 'focusTo'>, now: Date): boolean {
  const { focusDays: days, focusFrom: from, focusTo: to } = settings
  if (from === to) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  const today = now.getDay()
  if (from < to) return days.includes(today) && minutes >= from && minutes < to
  return (days.includes(today) && minutes >= from) || (days.includes((today + 6) % 7) && minutes < to)
}

export type FocusState = { active: false } | { active: true; by: 'timer' | 'slot'; /** When the block ends (ms since the epoch) for a timer; null for a slot, whose end is read from the settings. */ until: number | null }

/** What focus is doing at `at` (ms since the epoch). A pause (« Faire une pause ») silences both the timer and the slot until it ends. */
export function focusState(settings: FocusSettings, at: number): FocusState {
  if (!settings.focusMode || settings.focusSites.length === 0) return { active: false }
  if (settings.focusSnoozeUntil > at) return { active: false }
  if (settings.focusUntil > at) return { active: true, by: 'timer', until: settings.focusUntil }
  if (settings.focusScheduleOn && inFocusSlot(settings, new Date(at))) return { active: true, by: 'slot', until: null }
  return { active: false }
}

/** Focus is switched on and has a site to close: what the request filter needs to exist at all. */
export const focusIsConfigured = (settings: Pick<Settings, 'focusMode' | 'focusSites'>): boolean => settings.focusMode && settings.focusSites.length > 0

/** What the block page says of a blocked address: the site that matched and how focus is on. Null: the address is not blocked. */
export function focusBlock(settings: FocusSettings, url: string, at: number): { site: string; state: Extract<FocusState, { active: true }> } | null {
  const state = focusState(settings, at)
  if (!state.active) return null
  const site = settings.focusSites.find((host) => matchesHost(host, url))
  return site === undefined ? null : { site, state }
}

/** The settings that start a timer of `minutes` now (and end a pause). */
export function startFocusPatch(minutes: number, at: number): Pick<Settings, 'focusMode' | 'focusUntil' | 'focusSnoozeUntil'> {
  return { focusMode: true, focusUntil: at + integerIn(minutes, FOCUS_MINUTES_MIN, FOCUS_MINUTES_MAX, defaultSettings().focusMinutes) * MINUTE_MS, focusSnoozeUntil: 0 }
}

/** The settings that end the timer and pause the slot for a while: the way out of the block page. */
export function pauseFocusPatch(at: number): Pick<Settings, 'focusUntil' | 'focusSnoozeUntil'> {
  return { focusUntil: 0, focusSnoozeUntil: at + FOCUS_PAUSE_MINUTES * MINUTE_MS }
}

/** The settings that end the timer and the pause: back to the plain slot. */
export const stopFocusPatch = (): Pick<Settings, 'focusUntil' | 'focusSnoozeUntil'> => ({ focusUntil: 0, focusSnoozeUntil: 0 })

/** « 09:00 » for a count of minutes since midnight. */
export function formatClock(minutes: number): string {
  const safe = integerIn(minutes, 0, DAY_MINUTES - 1, 0)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

/** The count of minutes since midnight of « HH:MM » (what an input of type time gives); null when it is not a time. */
export function parseClock(text: string): number | null {
  const found = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (found === null) return null
  const hours = Number(found[1])
  const minutes = Number(found[2])
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null
}
