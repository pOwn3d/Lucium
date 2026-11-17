// The extension icons of the toolbar when there are too many for the width: the ones that do not fit, and the ones the user
// unpinned, go to a menu at the right of the icons. Pure rules; src/renderer/Toolbar.tsx measures and applies them. The settings of the
// extensions' bar (this overflow, the browsing-data APIs, the user-script manager) are cleaned here too, so that the reducer has one line.

import type { Settings } from './model'

/** An extension id as Chromium writes it: 32 letters from a to p. */
export const EXTENSION_ID = /^[a-p]{32}$/
export const UNPINNED_MAX = 200

/** Ids that can name an extension, each once; a list of anything else is the empty list. */
export function cleanUnpinned(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids: string[] = []
  for (const entry of raw) {
    if (ids.length >= UNPINNED_MAX) break
    if (typeof entry === 'string' && EXTENSION_ID.test(entry) && !ids.includes(entry)) ids.push(entry)
  }
  return ids
}

/** The settings of the extensions' bar and of what extensions are given; the same shape in, out. */
export type ExtensionBarSettings = Pick<Settings, 'extensionOverflow' | 'unpinnedExtensions' | 'extensionDataApis' | 'userScripts'>

export function cleanExtensionBarSettings(settings: ExtensionBarSettings): ExtensionBarSettings {
  return {
    // On unless it was switched off: the bar shows every icon until the icons really do not fit.
    extensionOverflow: settings.extensionOverflow !== false,
    unpinnedExtensions: cleanUnpinned(settings.unpinnedExtensions),
    extensionDataApis: settings.extensionDataApis !== false,
    // Runs code in pages: only when it was switched on.
    userScripts: settings.userScripts === true
  }
}

/** The list of unpinned extensions after the user pinned (`pinned` true) or unpinned one. */
export function withPinned(unpinned: readonly string[], id: string, pinned: boolean): string[] {
  if (!EXTENSION_ID.test(id)) return cleanUnpinned(unpinned)
  const rest = cleanUnpinned(unpinned).filter((one) => one !== id)
  return pinned ? rest : [...rest, id].slice(-UNPINNED_MAX)
}

// ---------- the list of icons of a window ----------

/**
 * The key of the toolbar's `<browser-action-list>` for a profile. The library's element registers with the runtime of its profile once, when
 * it is attached to the page. A window opened on a space whose profile has made no page yet in this run (three profiles in three windows) attaches
 * it before that runtime exists: the registration is lost ("No handler registered for 'crx-msg-remote'"), nothing tells the element what is
 * loaded there later, and it stays empty. Keyed by whether the profile has an extension, the element is made again, and registers, when the
 * first one arrives (an extension is only ever listed once its profile exists).
 */
export function actionListKey(partition: string, profileId: string, extensions: ReadonlyArray<{ profileId: string; enabled: boolean }>): string {
  return `${partition}:${extensions.some((e) => e.profileId === profileId && e.enabled) ? 'loaded' : 'none'}`
}

// ---------- room ----------

/** An extension icon: 24 px wide (toolbar.css). */
export const ACTION_ICON_WIDTH = 24
/** The gap the list leaves between two icons (toolbar.css, `.page-toolbar browser-action-list`). */
export const ACTION_ICON_GAP = 6
/** The « button, as wide as an icon. */
export const OVERFLOW_BUTTON_WIDTH = 24
/** The least room the address keeps between the two groups of buttons. */
export const MIN_ADDRESS_WIDTH = 180
/** The address sits 11 px inside the wider group on both sides (toolbar.css `.tb-address`). */
export const ADDRESS_GUTTER = 22

/**
 * The widest the group on the right may be before the address gets less than its minimum. The address is centred, so both groups
 * count as the wider one: the right group may grow up to the left group's width for nothing, then at half of what is left.
 * `bar` and `left` are the measured widths of the bar and of its left group.
 */
export function rightGroupRoom(bar: number, left: number): number {
  return Math.max(left, Math.floor((bar - ADDRESS_GUTTER - MIN_ADDRESS_WIDTH) / 2))
}

/** The width `count` icons take side by side, their gaps included. */
export function actionIconsWidth(count: number, iconWidth = ACTION_ICON_WIDTH, gap = ACTION_ICON_GAP): number {
  return count * iconWidth + Math.max(0, count - 1) * gap
}

export interface ActionBarPlan {
  /** The icons the bar keeps, in the order of the extensions. */
  shown: string[]
  /** The ones the menu lists, in the same order. */
  overflow: string[]
}

/**
 * Which icons stay in the bar. `order` is every extension action of the profile, `unpinned` the ones the user took out of the bar,
 * `room` the width left for the icons (and the « button when it is needed). Nothing moves while everything pinned fits and nothing is
 * unpinned: the bar is the plain one then. The gap between two icons counts: without it, every icon kept took 6 px more than planned and the
 * address was left with less than its minimum.
 */
export function planActionBar(order: readonly string[], unpinned: readonly string[], room: number, iconWidth = ACTION_ICON_WIDTH, overflowWidth = OVERFLOW_BUTTON_WIDTH, gap = ACTION_ICON_GAP): ActionBarPlan {
  const out = new Set(unpinned)
  const pinned = order.filter((id) => !out.has(id))
  if (pinned.length === order.length && actionIconsWidth(pinned.length, iconWidth, gap) <= room) return { shown: [...pinned], overflow: [] }
  // The « button takes its place as soon as something is in the menu: n icons and their n - 1 gaps fit in what it leaves.
  const capacity = Math.max(0, Math.floor((room - overflowWidth + gap) / (iconWidth + gap)))
  const shown = pinned.slice(0, capacity)
  const kept = new Set(shown)
  return { shown, overflow: order.filter((id) => !kept.has(id)) }
}

/** Whether two plans hide the same icons: the toolbar rewrites the page only when they differ. */
export function samePlan(a: ActionBarPlan | null, b: ActionBarPlan): boolean {
  return a !== null && a.shown.length === b.shown.length && a.overflow.length === b.overflow.length && a.shown.every((id, i) => id === b.shown[i]) && a.overflow.every((id, i) => id === b.overflow[i])
}
