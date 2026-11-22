// The tab overview (setting `tabGrid`): every open tab as a card of a grid, with the picture of its page, its title and its icon.
// Pure rules: which tabs carry a picture, how many, where the arrow keys go. The cards come from the search of tabs (shared/tab-search.ts, which
// already hides what the lock hides), the pictures from the ones the hover card takes (main/shell/thumbnails.ts), and the panel is drawn by
// renderer/TabGrid.tsx. Nothing here keeps a state.

import type { SidebarState, TabItem } from './model'

/** The pictures carried to the panel: the most recently used tabs only, so that a window of hundreds of tabs stays light (the others show their icon). */
export const GRID_PICTURE_LIMIT = 48

/**
 * The pictures of the tabs, as `data:` URLs by tab id: for the `GRID_PICTURE_LIMIT` tabs used last, and never for a private tab, nor for any tab
 * of a private window (`privateWindow`), nor for one the source has none for (it is the source that hides what the lock hides).
 */
export function gridPictures(state: Pick<SidebarState, 'tabs'>, thumb: (tabId: string) => string | null, privateWindow: boolean): Record<string, string> {
  if (privateWindow) return {}
  const byUse = (a: TabItem, b: TabItem) => b.lastActiveAt - a.lastActiveAt
  const pictures: Record<string, string> = {}
  let taken = 0
  for (const tab of [...state.tabs].filter((t) => t.private !== true).sort(byUse)) {
    if (taken >= GRID_PICTURE_LIMIT) break
    const picture = thumb(tab.id)
    if (picture === null) continue
    pictures[tab.id] = picture
    taken += 1
  }
  return pictures
}

/** Keys the grid moves the selection with. */
export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export const isGridKey = (key: string): key is GridKey => key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'

/**
 * Where a key takes the selection in a grid of `count` cards laid out in `columns` columns: left and right go one card (stopping at the ends), up and
 * down one row (staying where they are on the first and the last row), Home and End to the ends. With no card the answer is 0.
 */
export function moveGridSelection(index: number, count: number, columns: number, key: GridKey): number {
  if (count <= 0) return 0
  const last = count - 1
  const across = Math.max(1, Math.floor(columns))
  const at = Math.min(Math.max(index, 0), last)
  switch (key) {
    case 'ArrowLeft':
      return Math.max(at - 1, 0)
    case 'ArrowRight':
      return Math.min(at + 1, last)
    case 'ArrowUp':
      return at - across >= 0 ? at - across : at
    case 'ArrowDown':
      return at + across <= last ? at + across : at
    case 'Home':
      return 0
    case 'End':
      return last
  }
}

/**
 * The selection after the card at `closed` was closed: the card that took its place, or the new last one, or 0 when none is left. The panel stays
 * open on the next card, so that several tabs can be closed in a row.
 */
export function selectionAfterClose(closed: number, remaining: number): number {
  return remaining <= 0 ? 0 : Math.min(closed, remaining - 1)
}
