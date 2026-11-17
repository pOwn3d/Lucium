// The popover of the "+" at the foot of the sidebar: a 209 px wide card that opens upwards, rows of 40 px,
// separators that take 17 px (8 + a 1 px line + 8).
// There is no "New Easel" row (Easels are left out of Lucium), so the first group stays "space, folder" and the card is 40 px
// shorter than the 290 px of six rows. "New Tab" is taken out too: the "Nouvel onglet" row of the list and ⌘T are the way to a new tab, the + no longer repeats it
// (a private window, which has no popover, still opens the command bar from the +).

import { effectiveAccelerator, formatAccelerator, type KeyBindings } from './keybindings'
import { hostnameOf } from './url'
import { t } from './i18n'

export type PlusEntryId = 'space' | 'folder' | 'boost' | 'split' | 'workview'

export interface PlusEntry {
  id: PlusEntryId
  label: string
  /**
   * The command whose shortcut is shown at the right of the row (the one the user has bound, not a fixed one). Absent where no shortcut is
   * shown: the "New Tweak" row carries no shortcut although the command exists.
   */
  command?: string
}

/** The rows, grouped: a separator sits between two groups. */
export const PLUS_GROUPS: ReadonlyArray<readonly PlusEntry[]> = [
  [
    { id: 'space', get label() { return t('cmd.nouvel-espace') }, command: 'newSpace' },
    { id: 'folder', get label() { return t('menu.nouveau-dossier-2') }, command: 'newFolder' }
  ],
  [{ id: 'boost', get label() { return t('boost-editor.nouvelle-retouche') } }],
  [{ id: 'split', get label() { return t('plus-menu.nouvelle-vue-scindee') }, command: 'addSplit' }]
]

/** « Nouvelle vue de travail… »: a work view made in its sheet, with no split view on screen. Only while the function `workViewsEnabled` is on. */
const WORK_VIEW_ENTRY: PlusEntry = { id: 'workview', get label() { return t('work-view.nouvelle-vue-de-travail-menu') } }

/**
 * The rows the card shows: `PLUS_GROUPS`, and « Nouvelle vue de travail… » just before « Nouvelle vue scindée » while the work views are on (the split view
 * stays the last row, the one preselected).
 */
export function plusGroups(context: Pick<PlusContext, 'workViews'>): ReadonlyArray<readonly PlusEntry[]> {
  if (context.workViews !== true) return PLUS_GROUPS
  return PLUS_GROUPS.map((group) => (group.some((entry) => entry.id === 'split') ? [WORK_VIEW_ENTRY, ...group] : group))
}

/** Card width, padding, row height, the space a separator takes and the gap between the card's foot and the button's top. */
export const PLUS_MENU = { width: 209, padding: 8, rowHeight: 40, separator: 17, gap: 16, radius: 12 } as const

/** Height of the card for these groups: 8 + 40 per row + 17 per separator + 8 (six rows and two separators would make 290). */
export function plusMenuHeight(groups: ReadonlyArray<readonly unknown[]> = PLUS_GROUPS): number {
  const rows = groups.reduce((sum, group) => sum + group.length, 0)
  return PLUS_MENU.padding * 2 + rows * PLUS_MENU.rowHeight + Math.max(0, groups.length - 1) * PLUS_MENU.separator
}

export interface PlusContext {
  /** The address of the tab on screen, or null when no tab is open. */
  tabUrl: string | null
  /** The space on screen is locked: a new folder would land in it, and the lock refuses it (lock.ts). */
  spaceLocked?: boolean
  /** The work views are on (setting `workViewsEnabled`): the card has « Nouvelle vue de travail… ». Absent: they are not. */
  workViews?: boolean
}

/**
 * "New Tweak" needs a site to tweak, "New Split" a tab to put beside the new one (both are greyed out otherwise), and "New Folder" a space on
 * screen that is not locked.
 */
export function plusEntryEnabled(id: PlusEntryId, context: PlusContext): boolean {
  if (id === 'boost') return context.tabUrl !== null && /^https?:/i.test(context.tabUrl) && hostnameOf(context.tabUrl) !== ''
  if (id === 'split') return context.tabUrl !== null
  return plusEntryRefusal(id, context) === null
}

/** Why a row is greyed out by the lock (shown as its tooltip), or null when the lock leaves it alone. */
export function plusEntryRefusal(id: PlusEntryId, context: PlusContext): string | null {
  return id === 'folder' && context.spaceLocked === true ? t('lock.deverrouillez-l-espace-d-abord') : null
}

/** The shortcut to show beside a row, its keys spaced ("⌃ ⇧ ="), or '' when the row has none or the user removed it. */
export function plusShortcut(entry: PlusEntry, bindings: KeyBindings | undefined): string {
  if (!entry.command) return ''
  const accelerator = effectiveAccelerator(entry.command, bindings)
  return accelerator ? [...formatAccelerator(accelerator)].join(' ') : ''
}

/**
 * The row the pointer or the arrows move to: the next enabled one in `direction`, wrapping around. `from` is the current row (-1 for none).
 * Returns -1 when no row can be chosen.
 */
export function stepPlusSelection(enabled: readonly boolean[], from: number, direction: 1 | -1): number {
  const count = enabled.length
  if (count === 0) return -1
  // With no current row, the first step lands on the first row going down and on the last one going up.
  const start = from < 0 ? (direction === 1 ? -1 : count) : from
  for (let step = 1; step <= count; step++) {
    const index = (((start + direction * step) % count) + count) % count
    if (enabled[index]) return index
  }
  return -1
}

/** The row that is selected when the card opens: the last enabled one. */
export function initialPlusSelection(enabled: readonly boolean[]): number {
  return enabled.lastIndexOf(true)
}

export interface PlusAnchor {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the card sits for a button at `anchor` (window coordinates): its right edge one pixel short of the button's (`rightEdge`, from the
 * window's left), its foot `PLUS_MENU.gap` above the button's top (`bottom`, the distance from the window's bottom). The sidebar is fixed to
 * the left and the bottom of the window, so these are the numbers that survive a resize.
 */
export function plusMenuPlacement(anchor: PlusAnchor, window: { height: number }): { rightEdge: number; bottom: number } {
  return { rightEdge: anchor.x + anchor.width - 1, bottom: window.height - (anchor.y - PLUS_MENU.gap) }
}

export function isPlusAnchor(value: unknown): value is PlusAnchor {
  const a = value as Partial<PlusAnchor> | null
  return !!a && [a.x, a.y, a.width, a.height].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000) && a.width! >= 0 && a.height! >= 0
}
