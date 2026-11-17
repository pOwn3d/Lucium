// The DOM side of drag and drop in the sidebar: reading where the rows are, and the picture that follows the pointer.
// What a drop means is decided in @shared/dnd.

import type { DragEvent } from 'react'
import { locateFavorite, locateFolderRow, locateRow, type FavoriteBox, type Located, type RowBox } from '@shared/dnd'

export const DRAG_TYPE = 'application/x-lucium-tab'
export const DRAG_FAVORITE_TYPE = 'application/x-lucium-favorite'
export const DRAG_FOLDER_TYPE = 'application/x-lucium-folder'

/** Rows are marked with `data-drop` (their kind) and `data-id`; folders also say `data-parent`, `data-first`, `data-collapsed` and, at the start of Today or under its tabs, `data-side` (`today-start`, `bottom`), the start of Today `data-before`, a tab of the tab tree `data-pinned`. */
function rowBoxes(list: HTMLElement): RowBox[] {
  const rows: RowBox[] = []
  for (const el of list.querySelectorAll<HTMLElement>('[data-drop]')) {
    const rect = el.getBoundingClientRect()
    if (rect.height === 0) continue
    const { drop, id, parent, first, before, collapsed, pinned, side } = el.dataset
    rows.push({ kind: drop as RowBox['kind'], id: id ?? '', top: rect.top, bottom: rect.bottom, parentId: parent ? parent : null, first: first === 'true', beforeId: before || undefined, collapsed: collapsed === 'true', pinned: pinned === 'true', side: side === 'bottom' || side === 'today-start' ? side : undefined })
  }
  return rows
}

export const locateInList = (list: HTMLElement, y: number, tree = false): Located | null => locateRow(rowBoxes(list), y, tree)

/** Where a dragged folder would land: only the folder rows count. */
export const locateInFolders = (list: HTMLElement, y: number): Located | null => locateFolderRow(rowBoxes(list), y)

/** Favourites are marked with `data-favorite` (their id). */
export function locateInFavorites(grid: HTMLElement, x: number, y: number): Located {
  const boxes: FavoriteBox[] = []
  for (const el of grid.querySelectorAll<HTMLElement>('[data-favorite]')) {
    const rect = el.getBoundingClientRect()
    boxes.push({ id: el.dataset.favorite ?? '', left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }
  return locateFavorite(boxes, x, y)
}

/**
 * The picture dragged along: a copy of the row (its icon and title, none of its buttons), held where the pointer took it.
 * With several tabs it carries their number and a second sheet behind it. It lives in the sidebar for the instant the browser needs to capture it.
 */
export function setDragGhost(event: DragEvent<HTMLElement>, count: number, kind: 'tab' | 'favorite' | 'folder'): void {
  const row = event.currentTarget
  const rect = row.getBoundingClientRect()
  const ghost = row.cloneNode(true) as HTMLElement
  ghost.className = `${kind === 'tab' ? 'tab' : kind === 'folder' ? 'folder-title' : 'favorite'} drag-ghost${count > 1 ? ' stack' : ''}`
  for (const key of Object.keys(ghost.dataset)) delete ghost.dataset[key]
  ghost.removeAttribute('draggable')
  ghost.removeAttribute('title')
  ghost.querySelectorAll('.hover-only, .spinner, .split-mark, .developer-badge, .tab-sound').forEach((node) => node.remove())
  ghost.style.width = `${rect.width}px`
  if (count > 1) {
    const badge = document.createElement('span')
    badge.className = 'drag-count'
    badge.textContent = String(count)
    ghost.appendChild(badge)
  }
  // Inside the sidebar so that its rules and the space's colours (custom properties) apply to it.
  ;(row.closest('.sidebar') ?? row.closest('.shell') ?? document.body).appendChild(ghost)
  event.dataTransfer.setDragImage(ghost, event.clientX - rect.left, event.clientY - rect.top)
  setTimeout(() => ghost.remove(), 0)
}
