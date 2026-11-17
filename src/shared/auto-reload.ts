// A tab that reloads its page by itself at a regular interval (the "auto-refresh" module of the user's Chrome Toolkit, built in).
// Pure rules: the main process (shell/auto-reload.ts) keeps one countdown per tab, asks the page last, and applies the verdict;
// nothing here touches Electron.
//
// What is taken from the module: the countdown starts again at every load of the page (not at the previous reload), a field
// being typed in is never cut short (the tab is looked at again 5 seconds later), a page that cannot be reloaded (anything but
// the web and local files) is left alone, and the interval is chosen from a short list or typed in. What differs: the setting
// follows the tab, not the address, and the shortest interval is 5 seconds (the module accepts 1) so that a failing page is never
// hammered.

import type { AutoReload, RuntimeState, TabItem } from './model'
import { t, tp } from './i18n'

export const AUTO_RELOAD_MIN_SECONDS = 5
/** 24 hours. */
export const AUTO_RELOAD_MAX_SECONDS = 86_400
/** What the module proposes first, and what the custom panel starts from. */
export const AUTO_RELOAD_DEFAULT_SECONDS = 30
/** The module's list, shortest first. */
export const AUTO_RELOAD_PRESETS: readonly number[] = [5, 10, 30, 60, 120, 300, 600]
/** A tab that could not be reloaded now (typing, still loading) is looked at again after this long, not after a whole interval. */
export const AUTO_RELOAD_RETRY_MS = 5000
/** A page that has not said within this long whether a field is being typed in is hung: it is reloaded, which is what a hung page needs. */
export const AUTO_RELOAD_PROBE_TIMEOUT_MS = 3000

/** The whole seconds an interval stands for, or null when it is not a finite number within the bounds. */
export function autoReloadSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const seconds = Math.round(value)
  return seconds >= AUTO_RELOAD_MIN_SECONDS && seconds <= AUTO_RELOAD_MAX_SECONDS ? seconds : null
}

/** A saved tab's setting: a record with an interval within the bounds. Anything else is no setting (an out-of-range value is not repaired into a different interval). */
export function cleanAutoReload(value: unknown): AutoReload | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const seconds = autoReloadSeconds((value as { seconds?: unknown }).seconds)
  return seconds === null ? undefined : { seconds }
}

/** Pages the reload can act on: the web and local files. An extension page, a blank page or a source view is not reloaded. */
export function isAutoReloadable(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol } = new URL(url)
  return protocol === 'http:' || protocol === 'https:' || protocol === 'file:'
}

// ---------- what is said to the user ----------

/** An interval as a short phrase: "30 s", "1 min", "1 min 30 s", "1 h 30 min". */
export function autoReloadLabel(seconds: number): string {
  const s = (n: number): string => t('auto-reload.seconds-s', { seconds: n })
  const min = (n: number): string => t('auto-reload.minutes-min', { minutes: n })
  if (seconds < 60) return s(seconds)
  if (seconds < 3600) {
    const rest = seconds % 60
    return rest === 0 ? min(Math.floor(seconds / 60)) : `${min(Math.floor(seconds / 60))} ${s(rest)}`
  }
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [t('auto-reload.hours-h', { hours: Math.floor(seconds / 3600) }), minutes > 0 ? min(minutes) : '', rest > 0 ? s(rest) : ''].filter(Boolean).join(' ')
}

/** The tooltip of the mark on a tab's row. */
export const autoReloadTooltip = (seconds: number): string => t('auto-reload.recharge-toutes-les-interval', { interval: autoReloadLabel(seconds) })

/** The time left on a row's mark: "12 s" under a minute, "1:05" under an hour, "1:00:00" beyond. Rounded up (so "0 s" is only ever zero), never negative; empty when it is not a finite number. */
export function countdownText(msLeft: number): string {
  if (!Number.isFinite(msLeft)) return ''
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  if (total < 60) return t('auto-reload.seconds-s', { seconds: total })
  const two = (n: number): string => String(n).padStart(2, '0')
  return total < 3600 ? `${Math.floor(total / 60)}:${two(total % 60)}` : `${Math.floor(total / 3600)}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`
}

/** True when the interval is one of the menu's presets (otherwise the menu checks "Personnalisé…"). */
export const isPresetInterval = (seconds: number): boolean => AUTO_RELOAD_PRESETS.includes(seconds)

// ---------- the custom interval ----------

export type IntervalUnit = 'seconds' | 'minutes' | 'hours'

export const INTERVAL_UNITS: ReadonlyArray<{ unit: IntervalUnit; label: string; seconds: number }> = [
  { unit: 'seconds', get label() { return t('auto-reload.secondes') }, seconds: 1 },
  { unit: 'minutes', get label() { return t('auto-reload.minutes') }, seconds: 60 },
  { unit: 'hours', get label() { return t('auto-reload.heures') }, seconds: 3600 }
]

const unitSeconds = (unit: IntervalUnit): number => INTERVAL_UNITS.find((u) => u.unit === unit)?.seconds ?? 1

/** What the custom panel shows for an interval: the biggest unit that divides it evenly. */
export function splitInterval(seconds: number): { value: string; unit: IntervalUnit } {
  if (seconds % 3600 === 0) return { value: String(seconds / 3600), unit: 'hours' }
  if (seconds % 60 === 0) return { value: String(seconds / 60), unit: 'minutes' }
  return { value: String(seconds), unit: 'seconds' }
}

/** A typed interval ("30", "1,5") in a unit, to whole seconds, or the sentence that says why not. */
export function parseAutoReloadInterval(text: string, unit: IntervalUnit): { seconds: number } | { error: string } {
  const typed = text.trim().replace(',', '.')
  if (typed === '') return { error: t('auto-reload.saisissez-une-duree') }
  if (!/^\d+(\.\d+)?$/.test(typed)) return { error: t('auto-reload.saisissez-un-nombre-par-exemple-30') }
  const total = Math.round(Number(typed) * unitSeconds(unit))
  if (total < AUTO_RELOAD_MIN_SECONDS) return { error: tp('auto-reload.au-moins-count-secondes', AUTO_RELOAD_MIN_SECONDS) }
  if (total > AUTO_RELOAD_MAX_SECONDS) return { error: tp('auto-reload.count-heures-au-plus', AUTO_RELOAD_MAX_SECONDS / 3600) }
  return { seconds: total }
}

// ---------- when a tab is reloaded ----------

/** Why a tab is left as it is for now. `unchecked`: every other rule let it through, but its page was not asked yet. */
export type AutoReloadBlocker = 'off' | 'no-page' | 'not-reloadable' | 'loading' | 'not-due' | 'unchecked' | 'editing'

export type AutoReloadVerdict = { reload: true } | { reload: false; reason: AutoReloadBlocker }

export interface AutoReloadFacts {
  /** The tab has a live page that is not frozen: a tab asleep is never woken by the countdown. */
  awake: boolean
  loading: boolean
  now: number
  /** When the countdown of the tab ends. */
  dueAt: number
  /** Absent until the page was asked (see `AUTO_RELOAD_EDITING_SCRIPT`): the verdict is then `unchecked`, so a caller that forgets to ask cannot cut a typing short. */
  editing?: boolean
}

const no = (reason: AutoReloadBlocker): AutoReloadVerdict => ({ reload: false, reason })

/**
 * Whether a tab is reloaded now, and if not, the first rule that says so. A page that is still loading is never reloaded (at most
 * one reload in flight per tab); the page is asked last, and only for a tab whose countdown has ended.
 */
export function autoReloadVerdict(tab: Pick<TabItem, 'url' | 'autoReload'>, facts: AutoReloadFacts): AutoReloadVerdict {
  if (!tab.autoReload) return no('off')
  if (!facts.awake) return no('no-page')
  if (!isAutoReloadable(tab.url)) return no('not-reloadable')
  if (facts.loading) return no('loading')
  if (facts.now < facts.dueAt) return no('not-due')
  if (facts.editing === undefined) return no('unchecked')
  if (facts.editing) return no('editing')
  return { reload: true }
}

// ---------- the countdowns ----------

/** The countdown of one tab: its interval, and when it ends (milliseconds since the epoch). */
export interface Countdown {
  seconds: number
  at: number
}

/** The countdown a tab has now: the one it had while its interval is the same, a new one (a whole interval from now) otherwise. */
export function countdownFor(previous: Countdown | undefined, seconds: number, now: number): Countdown {
  return previous && previous.seconds === seconds ? previous : { seconds, at: now + seconds * 1000 }
}

/** The countdown after the page finished loading: a whole interval from this moment. */
export const restartedCountdown = (seconds: number, now: number): Countdown => ({ seconds, at: now + seconds * 1000 })

/** When to look at the tab again after a verdict that did not reload it (`null`: there is nothing to look at, the countdown goes). */
export function recheckAt(reason: Exclude<AutoReloadBlocker, 'not-due'>, seconds: number, now: number): number | null {
  switch (reason) {
    case 'off':
    case 'no-page':
      return null
    case 'loading':
    case 'unchecked':
    case 'editing':
      return now + AUTO_RELOAD_RETRY_MS
    case 'not-reloadable':
      return now + seconds * 1000
  }
}

/**
 * The runtime the interface is given, with the end of each countdown on the tabs that have the setting: the row counts down by itself,
 * so nothing is published per second. A tab without the setting never carries one (a countdown left behind is not shown), nor a tab with no runtime entry.
 */
export function withReloadAt(runtime: RuntimeState, tabs: ReadonlyArray<Pick<TabItem, 'id' | 'autoReload'>>, endOf: (tabId: string) => number | undefined): RuntimeState {
  let next: RuntimeState['tabs'] | null = null
  for (const tab of tabs) {
    const entry = runtime.tabs[tab.id]
    const at = tab.autoReload ? endOf(tab.id) : undefined
    if (!entry || at === undefined) continue
    next ??= { ...runtime.tabs }
    next[tab.id] = { ...entry, reloadAt: at }
  }
  return next ? { ...runtime, tabs: next } : runtime
}

/** How long until the first countdown ends (0 when one already has), or null when there is none. */
export function wakeDelay(countdowns: Iterable<Countdown>, now: number): number | null {
  let soonest: number | null = null
  for (const { at } of countdowns) if (soonest === null || at < soonest) soonest = at
  return soonest === null ? null : Math.max(0, soonest - now)
}

// ---------- asking the page ----------

/**
 * Run in the page: whether the user is in the middle of a field. A focused field that holds text (typed or not), a focused
 * list, or a focused editable area with text counts; an empty field does not (a page that focuses its search box by itself
 * would otherwise never be reloaded, and nothing is lost by reloading an empty one). Shadow roots and same-origin frames are
 * looked into. The text typed in a field the user has left is the engine's own watcher's to tell (`probeForSleep`).
 */
export const AUTO_RELOAD_EDITING_SCRIPT = `(() => {
  const TEXT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/i
  let el = document.activeElement
  for (let depth = 0; el && depth < 8; depth++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue }
    if (el.tagName === 'IFRAME') {
      let inner = null
      try { inner = el.contentDocument && el.contentDocument.activeElement } catch (e) { inner = null }
      if (!inner) break
      el = inner
      continue
    }
    break
  }
  if (!el || el === document.body || el === document.documentElement) return false
  const tag = el.tagName
  if (tag === 'SELECT') return true
  if (tag === 'TEXTAREA') return String(el.value) !== ''
  if (tag === 'INPUT') return TEXT.test(el.type) && String(el.value) !== ''
  if (el.isContentEditable === true) return (el.textContent || '').trim() !== ''
  return false
})()`
