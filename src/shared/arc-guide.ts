// The guide « Vous venez d’Arc ? »: for a person who has just imported from Arc, where the things they knew are in Lucium, name by name. It opens by
// itself once, when the sheet of an import from Arc is left (main/shell/browser-overlay.ts), and always from Aide › Vous venez d’Arc ?.
// Pure: the import service counts what it brought (main/importers/service.ts), this decides whether the guide opens and where its buttons lead.

import { counted } from './import-sources'
import type { OverlayRequest } from './ipc'
import type { Settings } from './model'

/** What the imports from Arc of this session brought, for the sentence of the guide (the parts of the import sheet's own account). */
export interface ArcImported {
  spaces: number
  tabs: number
  folders: number
  favorites: number
  splits: number
}

export const NOTHING_IMPORTED: ArcImported = { spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0 }

export function addImported(a: ArcImported, b: ArcImported): ArcImported {
  return { spaces: a.spaces + b.spaces, tabs: a.tabs + b.tabs, folders: a.folders + b.folders, favorites: a.favorites + b.favorites, splits: a.splits + b.splits }
}

/** The guide, as Aide › Vous venez d’Arc ? asks for it: no import to speak of. */
export const ARC_GUIDE_REQUEST: OverlayRequest = { panel: 'arcguide' }

/**
 * The guide that follows an import from Arc, or null: nothing came from Arc (`imported` is null), or the guide was seen already (it opens by itself once).
 * Seen from the menu counts as seen: the person knows where it is.
 */
export function arcGuideRequest(imported: ArcImported | null, settings: Pick<Settings, 'arcGuideSeen'>): OverlayRequest | null {
  if (imported === null || settings.arcGuideSeen) return null
  return { panel: 'arcguide', imported }
}

/** The parts of what came in, in the words of the import sheet ("3 espaces", "1 vue scindée"); a part that is zero is left out. */
export function importedParts(imported: ArcImported | undefined): string[] {
  if (!imported) return []
  return [
    imported.spaces > 0 ? counted('arc-summary.spaces', imported.spaces) : '',
    imported.tabs > 0 ? counted('arc-summary.tabs', imported.tabs) : '',
    imported.folders > 0 ? counted('import-summary.folder', imported.folders) : '',
    imported.favorites > 0 ? counted('arc-summary.favorites', imported.favorites) : '',
    imported.splits > 0 ? counted('arc-summary.splits', imported.splits) : ''
  ].filter((part) => part !== '')
}

/**
 * Where each button of the guide leads: requests the interface may send (main/shell/ipc.ts `validOverlay`, which a test checks). The Settings window
 * has no place of its own for the Tweaks, so their button opens the category that holds them; the mini window and the Glance share a group.
 */
export const ARC_GUIDE_PLACES = {
  /** A new mini window (the command bar in its `little` mode, which the main process shows in a window of its own). */
  miniWindow: { panel: 'commandbar', mode: 'little', initial: '' },
  tweaks: { panel: 'settings', pane: 'tools' },
  linkRouting: { panel: 'settings', pane: 'navigation', anchor: 'links' },
  glance: { panel: 'settings', pane: 'navigation', anchor: 'links' },
  spaces: { panel: 'spaces' },
  archive: { panel: 'archive' }
} as const satisfies Record<string, OverlayRequest>

export type ArcGuidePlace = keyof typeof ARC_GUIDE_PLACES
