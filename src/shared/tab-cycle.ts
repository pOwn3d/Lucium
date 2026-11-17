// ⌃Tab in the order the tabs were used, with a panel of pictures while ⌃ is held.
// Pure rules: which tabs, in which order, where the selection goes, how big the panel is. The keys are read by the browser
// (shell/browser.ts) and the panel is drawn by the overlay (renderer/TabCycle.tsx).

import { acceleratorMatches, type KeyLayout } from './keybindings'
import { redactForLock, type LockView } from './lock'
import { splitFor } from './sidebar'
import { hostOf } from './url'
import { tabName, type GridSpan, type SidebarState, type SplitOrientation, type TabItem } from './model'
import { isGridCount } from './split'

/** One tab as the panel shows it. `thumb` is a `data:` picture of the last time the tab was on screen, or null (the icon and the title are shown instead). */
export interface CycleMember {
  id: string
  title: string
  /** The site of the page without "www." (the line under the title of a card), '' when the address is not one. */
  host: string
  faviconUrl?: string
  icon?: string
  thumb: string | null
}

/**
 * An entry of the panel: one tab, or the tabs of a split view together (a pair is a single entry). `id` is the tab a choice selects: for a
 * split view, the pane used last.
 */
export interface CycleCard {
  id: string
  members: CycleMember[]
  /** How the members of a split view are laid out in the picture. */
  orientation?: SplitOrientation
  /** The members of a split view are in a grid: 2 × 2, or three with one along `span`. */
  grid?: { span?: GridSpan }
}

/**
 * The panel: a head (title, count), a row of cards of 200 x 176 with a picture of 100 high, and a foot
 * (position, how to leave). The three parts add up to `height`; renderer/tab-cycle.css carries the same numbers (tab-cycle-panel.test.ts keeps them in step).
 */
export const CYCLE_PANEL = {
  head: 36,
  foot: 37,
  /** Between the cards and the edges of their row. */
  padding: 8,
  gap: 8,
  card: { width: 200, height: 176 },
  /** Head + (card + padding on both sides) + foot. */
  height: 265,
  /** Narrowest the panel gets: the head and the foot have to fit even with two cards. */
  minWidth: 480,
  /** The pictures of the first entries only are carried to the overlay: a long list stays light. */
  pictureLimit: 24,
  /** Room kept between the panel and the window's edges when many tabs are open (the cards then scroll). */
  windowMargin: 20,
  /** The transparent margin around the panel inside its overlay view, for its wide shadow. */
  shadow: 60
} as const

/** Width of the panel for `count` entries, kept inside a window of `windowWidth` px (632 for three entries). */
export function cyclePanelWidth(count: number, windowWidth: number): number {
  const { padding, gap, card, minWidth, windowMargin } = CYCLE_PANEL
  const n = Math.max(1, count)
  const wanted = Math.max(minWidth, padding * 2 + n * card.width + (n - 1) * gap)
  return Math.round(Math.min(wanted, Math.max(card.width + padding * 2, windowWidth - windowMargin * 2)))
}

/**
 * When a tab was last put to use: the latest of its creation, its last selection and the moment it was left (`usedAt`, kept by the window:
 * a tab that was on screen when others were opened is more recent than they are). A tab never visited counts from its creation.
 */
const stamp = (tab: TabItem, usedAt?: ReadonlyMap<string, number>): number => Math.max(tab.createdAt, tab.lastActiveAt, usedAt?.get(tab.id) ?? 0)

const member = (tab: TabItem, thumb: string | null): CycleMember => ({
  id: tab.id,
  title: tabName(tab) || tab.url,
  host: hostOf(tab.url),
  ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
  ...(tab.icon ? { icon: tab.icon } : {}),
  thumb
})

export interface CycleOptions {
  /** Tabs of other windows (a tab lives in one window at a time) that this window's ⌃Tab leaves out. */
  exclude?: ReadonlySet<string>
  /** The moment each tab was last left by this window (it is kept by the window, not saved). */
  usedAt?: ReadonlyMap<string, number>
  /** The last picture of a tab, null when there is none. */
  thumb?: (tabId: string) => string | null
}

/**
 * The entries of the panel for the space on screen: the tab on screen first (with its split view, if it has one), then the others from the
 * most recently used to the least. The tabs of a split view make one entry, placed at the one of them used last. Pictures are looked up
 * for the first `pictureLimit` entries only.
 */
export function recentCards(state: SidebarState, options: CycleOptions = {}): CycleCard[] {
  const exclude = options.exclude ?? new Set<string>()
  const current = state.activeTabBySpace[state.activeSpaceId]
  const tabs = state.tabs.filter((t) => t.spaceId === state.activeSpaceId && !exclude.has(t.id))
  const position = new Map(tabs.map((t, i) => [t.id, i]))
  // Most recent first; between two tabs of the same instant the later one in the list (the newer) goes first.
  const byRecency = (a: TabItem, b: TabItem) => stamp(b, options.usedAt) - stamp(a, options.usedAt) || position.get(b.id)! - position.get(a.id)!
  const groups: TabItem[][] = []
  const seen = new Set<string>()
  for (const tab of [...tabs].sort(byRecency)) {
    if (seen.has(tab.id)) continue
    const split = splitFor(state, tab.id)
    const members = split ? split.tabIds.map((id) => tabs.find((t) => t.id === id)).filter((t): t is TabItem => t !== undefined) : [tab]
    // A split view with a member gone is shown by the members that remain; with one left, that one alone.
    for (const m of members) seen.add(m.id)
    groups.push(members.length > 0 ? members : [tab])
  }
  const currentFirst = [...groups].sort((a, b) => Number(b.some((t) => t.id === current)) - Number(a.some((t) => t.id === current)))
  return currentFirst.map((members, index): CycleCard => {
    const withPicture = index < CYCLE_PANEL.pictureLimit
    const split = members.length > 1 ? splitFor(state, members[0]!.id) : undefined
    const used = [...members].sort(byRecency)[0]!
    return {
      id: used.id,
      members: members.map((t) => member(t, withPicture ? (options.thumb?.(t.id) ?? null) : null)),
      ...(split ? { orientation: split.orientation } : {}),
      ...(split?.grid && members.length === split.tabIds.length && isGridCount(members.length) ? { grid: split.grid.span && members.length === 3 ? { span: split.grid.span } : {} } : {})
    }
  })
}

/**
 * `recentCards` for what the interface is shown. The panel is drawn over the window, lock screen included: a tab the lock hides has no entry in it
 * (no title, no icon, no picture), and nothing at all is offered while the whole application is locked. `lock` absent: no lock is on.
 */
export function visibleRecentCards(state: SidebarState, lock: Pick<LockView, 'appLocked' | 'lockedSpaces'> | undefined, options: CycleOptions = {}): CycleCard[] {
  return recentCards(lock ? redactForLock(state, lock) : state, options)
}

/** Where the selection starts: the entry after the one on screen going forward, the last one going back. Null when there is nowhere to go. */
export function firstSelection(count: number, direction: 1 | -1): number | null {
  if (count < 2) return null
  return direction === 1 ? 1 : count - 1
}

/** One step further (1) or back (-1) through the entries, wrapping around. */
export function stepSelection(index: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0
  return (((index + direction) % count) + count) % count
}

/** A key press as the panel of ⌃Tab reports it to the shell (the panel has the keyboard while it is up, see `Browser.cycleKeyFromPanel`). */
export interface CycleKey {
  type: 'keyDown' | 'keyUp'
  code: string
  key: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat: boolean
}

const KEY_TEXT_MAX = 32

/** The key press that came through the interface, or null when it is not one: a surface of ours can be mistaken, and nothing else is let through. */
export function parseCycleKey(raw: unknown): CycleKey | null {
  if (typeof raw !== 'object' || raw === null) return null
  const k = raw as Record<string, unknown>
  const text = (value: unknown): value is string => typeof value === 'string' && value.length <= KEY_TEXT_MAX
  const flag = (value: unknown): value is boolean => typeof value === 'boolean'
  if ((k['type'] !== 'keyDown' && k['type'] !== 'keyUp') || !text(k['code']) || !text(k['key'])) return null
  if (!flag(k['meta']) || !flag(k['control']) || !flag(k['alt']) || !flag(k['shift']) || !flag(k['isAutoRepeat'])) return null
  return { type: k['type'], code: k['code'], key: k['key'], meta: k['meta'], control: k['control'], alt: k['alt'], shift: k['shift'], isAutoRepeat: k['isAutoRepeat'] }
}

/** What a key press means to ⌃Tab. */
export type CycleDecision =
  /** Not a key of the switcher: the page or the menu bar has it. */
  | { kind: 'ignore' }
  /** The shortcut was pressed with no panel up: the panel opens on the entry after (or before) the one on screen. */
  | { kind: 'start'; direction: 1 | -1; accelerator: string }
  | { kind: 'step'; direction: 1 | -1 }
  /** What ⌃ held is no longer held: the selected tab is shown. The key itself is left to the page. */
  | { kind: 'commit' }
  /** Escape: the panel goes, the tab on screen stays. */
  | { kind: 'cancel' }
  /** The Tab going up, or any other key the panel has no use for: spent, nothing to do. */
  | { kind: 'swallow' }

export interface CycleKeyContext {
  /** The setting. */
  enabled: boolean
  /** The modifiers whose release ends the panel, when it is up; null when it is not. */
  holding: ReadonlyArray<'control' | 'alt' | 'meta'> | null
  /** Another panel (the command bar, a menu…) is open: the keys are its own. */
  otherPanelOpen: boolean
  /** The accelerators of the two commands (undefined: the user turned it off). */
  forward: string | undefined
  back: string | undefined
  /**
   * The keyboard layout, when the interface has read it. A press with Option does not carry the letter of its key (⌥A gives « æ »): only the
   * layout says that the key at the place of Q is the A of a French keyboard.
   */
  layout?: KeyLayout | undefined
}

/**
 * What a key press does, given whether the panel is up. With the panel up, a key that no longer has ⌃ down ends it (whatever the key is: the
 * release of ⌃ itself, or any key after it in case that release was lost), Escape cancels it, the shortcut moves the selection. Without it,
 * the shortcut opens it, unless the setting is off or another panel is open.
 */
export function decideCycleKey(context: CycleKeyContext, key: CycleKey): CycleDecision {
  if (!context.enabled) return { kind: 'ignore' }
  // With the character typed: a shortcut is recorded by the letter the keyboard layout gives, and is recognised the same way.
  const pressed = { code: key.code, key: key.key, metaKey: key.meta, ctrlKey: key.control, altKey: key.alt, shiftKey: key.shift }
  const direction = acceleratorMatches(context.forward, pressed, context.layout) ? 1 : acceleratorMatches(context.back, pressed, context.layout) ? -1 : 0
  if (context.holding) {
    if (context.holding.some((modifier) => !key[modifier])) return { kind: 'commit' }
    if (key.type === 'keyUp') return key.code === 'Tab' ? { kind: 'swallow' } : { kind: 'ignore' }
    if (key.code === 'Escape') return { kind: 'cancel' }
    return direction === 0 ? { kind: 'ignore' } : { kind: 'step', direction }
  }
  if (key.type !== 'keyDown' || direction === 0 || context.otherPanelOpen) return { kind: 'ignore' }
  return { kind: 'start', direction, accelerator: (direction === 1 ? context.forward : context.back) ?? '' }
}
