// Battery saver mode: when the battery is low, or when the user asks,
// the browser does less in the background. What it does is limited to what Lucium can change in a page without breaking it: it stops CSS
// animations and transitions, puts idle tabs to sleep sooner, stops the tabs that reload themselves and the looks at watched pages, and stops
// taking the pictures of the hover cards. It promises no saving: the engine test (smoke-webtools.ts) measures the CPU of an animated page
// with and without the mode and prints both figures; JavaScript-driven animations are not touched. Pure here: when the mode is on, and what it changes; the shell reads the
// power source (shell/battery-saver.ts) and applies the changes.

/** Below or at this share of charge, on battery, the mode comes on by itself. */
import { t } from './i18n'

export const SAVER_THRESHOLD_PERCENT = 20
/** While it is on, an idle tab sleeps after this many minutes at the most. */
export const SAVER_SLEEP_MINUTES = 5
/** How often the charge is read while the computer runs on battery (and never on mains power). */
export const SAVER_POLL_MS = 120_000

export interface PowerFacts {
  onBattery: boolean
  /** The charge, 0 to 100; null when it cannot be read. */
  percent: number | null
}

/** Whether the mode is on: the setting must be on, and then either the user asked for it or the battery is low (a charge that cannot be read is not low). */
export function saverActive(enabled: boolean, asked: boolean, facts: PowerFacts): boolean {
  return enabled && (asked || (facts.onBattery && facts.percent !== null && facts.percent <= SAVER_THRESHOLD_PERCENT))
}

/** The charge in the text `pmset -g batt` prints ("… 17%; discharging; …"), or null when the text has no battery line. */
export function parsePmsetPercent(output: string): number | null {
  const match = /(\d{1,3})%;/.exec(output)
  if (!match) return null
  const percent = Number(match[1])
  return percent >= 0 && percent <= 100 ? percent : null
}

/** The charge in the `capacity` files of the batteries of Linux, under /sys/class/power_supply (each holds a number and a newline): the first one that is a charge, or null when none is. */
export function parseSysfsCapacity(texts: readonly string[]): number | null {
  for (const text of texts) {
    if (!/^\d{1,3}\s*$/.test(text)) continue
    const percent = Number(text.trim())
    if (percent >= 0 && percent <= 100) return percent
  }
  return null
}

/** The delay after which an idle tab sleeps while the mode is on: the user's own delay if it is shorter; "never" becomes the mode's delay. */
export function saverSleepMinutes(configured: number): number {
  return configured > 0 ? Math.min(configured, SAVER_SLEEP_MINUTES) : SAVER_SLEEP_MINUTES
}

/**
 * The stylesheet of the mode: animations and transitions run once, in a thousandth of a second, so the page ends where they lead and a
 * spinner or a marquee stops costing frames. It is an author sheet (a user-origin one cannot be taken out again, see electron-engine.ts): the
 * `!important` of a page's own rule of equal weight beats it, which is fine for a mode that only does its best.
 */
export const SAVER_CSS = '*,*::before,*::after{animation-duration:.001s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:.001s!important;transition-delay:0s!important;scroll-behavior:auto!important}'

export function saverNotice(on: boolean): string {
  return on ? t('battery-saver.mode-economie-de-batterie-active') : t('battery-saver.mode-economie-de-batterie-desactive')
}
