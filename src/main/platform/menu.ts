// The menu template written for macOS, made fit for the other systems. On macOS the template is returned as it is (the same object): the
// macOS menu must not move. Elsewhere the entries that only exist on macOS are taken out: a role the system does not know does
// nothing at best, and a submenu left with nothing to do (the Substitutions and Speech menus for the system's text services) is noise.

import type { MenuItemConstructorOptions } from 'electron'
import type { PlatformId } from '@shared/platform'

/** Roles that exist on macOS only (Electron's documentation of `MenuItem`): the application menu's own entries, the text services, the Window menu's `front` and `zoom`. */
export const MAC_ONLY_ROLES: ReadonlySet<string> = new Set([
  'services',
  'hide',
  'hideOthers',
  'unhide',
  'front',
  'zoom',
  'showSubstitutions',
  'startSpeaking',
  'stopSpeaking',
  'shareMenu',
  'toggleTabBar',
  'selectNextTab',
  'selectPreviousTab',
  'mergeAllWindows',
  'moveTabToNewWindow'
])

const isSeparator = (item: MenuItemConstructorOptions): boolean => item.type === 'separator'

/** Whether an entry does something the user can reach: not a separator, and not switched off for good. */
const isActionable = (item: MenuItemConstructorOptions): boolean => !isSeparator(item) && item.enabled !== false && item.visible !== false

function adaptItems(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const kept: MenuItemConstructorOptions[] = []
  for (const item of items) {
    if (item.role !== undefined && MAC_ONLY_ROLES.has(item.role)) continue
    if (!Array.isArray(item.submenu)) {
      kept.push(item)
      continue
    }
    const before = item.submenu as readonly MenuItemConstructorOptions[]
    const inside = adaptItems(before)
    const lostSome = inside.length < before.length
    // A submenu that lost an entry for being macOS-only and has nothing left to do goes too; one that never had such an entry stays, whatever its state.
    if (inside.length === 0 || (lostSome && !inside.some(isActionable))) continue
    kept.push({ ...item, submenu: inside })
  }
  return tidy(kept)
}

/** No separator first, last or twice in a row: taking entries out leaves them stranded. */
function tidy(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const result: MenuItemConstructorOptions[] = []
  for (const item of items) {
    if (isSeparator(item) && (result.length === 0 || isSeparator(result[result.length - 1]!))) continue
    result.push(item)
  }
  while (result.length > 0 && isSeparator(result[result.length - 1]!)) result.pop()
  return result
}

/** The template for this system. macOS gets the very array it gave. */
export function adaptMenuTemplate(platform: PlatformId, template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  if (platform === 'darwin') return template
  return adaptItems(template)
}
