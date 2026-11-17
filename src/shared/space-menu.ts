// The menu of a space, opened from its header in the sidebar: rename, customise, new folder, empty Today, hide the header,
// manage the spaces. A popover like the one of the "+" (plus-menu.ts), not a native menu: the right-click menu of the space (context-menus.ts) is a
// longer list that stays as it is. The entries that open the editor of the space ask for the existing `space` panel; the others are actions of the store.

import type { Action } from './sidebar'
import type { OverlayRequest } from './ipc'
import { effectiveAccelerator, formatAccelerator, type KeyBindings } from './keybindings'
import { t } from './i18n'
import type { PlatformId } from './platform'

export type SpaceMenuEntryId = 'rename' | 'customize' | 'folder' | 'clear' | 'header' | 'manage'

export interface SpaceMenuEntry {
  id: SpaceMenuEntryId
  label: string
  /** A few words in grey after the label (what "Personnaliser" holds). */
  hint?: string
  /** The command whose shortcut is shown at the right of the row (the one the user has bound). */
  command?: string
}

/** The rows, grouped: a separator sits between two groups. */
export function spaceMenuGroups(): ReadonlyArray<readonly SpaceMenuEntry[]> {
  return [
    [
      { id: 'rename', label: t('ctx.renommer-l-espace') },
      { id: 'customize', label: t('sidebar.personnaliser-l-espace'), hint: t('sidebar.icone-theme-profil') }
    ],
    [
      { id: 'folder', label: t('menu.nouveau-dossier-2'), command: 'newFolder' },
      { id: 'clear', label: t('cmd.vider-les-onglets-du-jour'), command: 'clearToday' },
      { id: 'header', label: t('ctx.masquer-l-en-tete-de-l-espace') }
    ],
    [{ id: 'manage', label: t('menu.gerer-les-espaces') }]
  ]
}

export const SPACE_MENU_ENTRIES = (): readonly SpaceMenuEntry[] => spaceMenuGroups().flat()

/** What the rows can do now: there is nothing to empty when Today has no tab, and a locked space keeps its name, its look and its header, and takes no new folder. */
export interface SpaceMenuContext {
  todayCount: number
  locked?: boolean
}

/**
 * The rows the lock refuses on a locked space (lock.ts), so they are greyed out there: what changes what a space is recognised by, and a new
 * folder, which would land in it.
 */
const LOCKED_ENTRIES: ReadonlySet<SpaceMenuEntryId> = new Set(['rename', 'customize', 'folder', 'header'])

export function spaceMenuEnabled(id: SpaceMenuEntryId, context: SpaceMenuContext): boolean {
  if (spaceMenuRefusal(id, context) !== null) return false
  return id === 'clear' ? context.todayCount > 0 : true
}

/** Why a row is greyed out by the lock (shown as its tooltip), or null when the lock leaves it alone. */
export function spaceMenuRefusal(id: SpaceMenuEntryId, context: SpaceMenuContext): string | null {
  return context.locked === true && LOCKED_ENTRIES.has(id) ? t('lock.deverrouillez-l-espace-d-abord') : null
}

/** The shortcut beside a row, as the user has bound it ("⇧⌘K"), or '' when the row has none or the user removed it. */
export function spaceMenuShortcut(entry: SpaceMenuEntry, bindings: KeyBindings | undefined, platform: PlatformId): string {
  if (!entry.command) return ''
  const accelerator = effectiveAccelerator(entry.command, bindings, platform)
  return accelerator ? formatAccelerator(accelerator, platform) : ''
}

/** What choosing a row does: ask for a panel (the menu is replaced by it), or run an action of the store and close the menu. */
export type SpaceMenuRun = { kind: 'overlay'; request: OverlayRequest } | { kind: 'dispatch'; action: Action }

export function spaceMenuRun(id: SpaceMenuEntryId, spaceId: string): SpaceMenuRun {
  switch (id) {
    // Both open the editor of the space: "Renommer" with the name field in focus, "Personnaliser" on the whole (icon, theme and profile).
    case 'rename':
      return { kind: 'overlay', request: { panel: 'space', spaceId, focus: 'name' } }
    case 'customize':
      return { kind: 'overlay', request: { panel: 'space', spaceId } }
    case 'folder':
      return { kind: 'dispatch', action: { type: 'folder/create', name: t('menu.nouveau-dossier-2'), spaceId } }
    case 'clear':
      return { kind: 'dispatch', action: { type: 'today/clear', spaceId } }
    case 'header':
      return { kind: 'dispatch', action: { type: 'space/header', id: spaceId, visible: false } }
    case 'manage':
      return { kind: 'overlay', request: { panel: 'spaces' } }
  }
}

/** Where the menu hangs: under the header button (its left edge on the button's, 4 px below), pulled back inside the window. */
export function spaceMenuPlacement(anchor: { x: number; y: number; width: number; height: number }, window: { width: number }, menuWidth: number): { left: number; top: number } {
  const GAP = 4
  const MARGIN = 8
  return { left: Math.max(MARGIN, Math.min(anchor.x, window.width - menuWidth - MARGIN)), top: anchor.y + anchor.height + GAP }
}

/** The row an arrow, Home or End moves to among the enabled ones (wraps around); `from` is the row now (-1 for none). -1 when no row can be chosen. */
export function stepSpaceMenu(enabled: readonly boolean[], from: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  const count = enabled.length
  if (key === 'Home') return enabled.indexOf(true)
  if (key === 'End') return enabled.lastIndexOf(true)
  const direction = key === 'ArrowDown' ? 1 : -1
  const start = from < 0 ? (direction === 1 ? -1 : count) : from
  for (let step = 1; step <= count; step++) {
    const index = (((start + direction * step) % count) + count) % count
    if (enabled[index]) return index
  }
  return -1
}

/** The next space the arrows of the footer move to (wraps around). */
export function stepSpaceTab(count: number, from: number, key: 'ArrowLeft' | 'ArrowRight'): number {
  if (count <= 0) return -1
  return (from + (key === 'ArrowRight' ? 1 : -1) + count) % count
}
