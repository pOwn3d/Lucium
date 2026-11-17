// What dropping something on the sidebar does. The renderer finds the target under the pointer; this decides, from the
// state, which actions follow (and whether a drop there means anything, which is when the insertion mark shows).

import { isListedTab, tabName, type Folder, type SidebarState, type TabItem } from './model'
import { canMoveFolder, folderPlacement, sideOfFolder, type FolderSide } from './folders'
import { sidebarOrder, type Action } from './sidebar'
import { favoriteProfile, favoritesOf, favoritesOfSpace } from './favorite-scope'
import { branchIds, treeDropSlot } from './tab-tree'

/** A tab dragged from another window, as the window it lands in knows it: the tab may not be in that window's own view of the state (windows with tabs of their own). */
export interface WindowTab {
  id: string
  /** A private tab of a normal window: it never goes to the pinned list or a folder. */
  private?: true
}

/**
 * Dragged tabs (one, or the whole multiple selection), a favourite, or a folder (with what it holds). `window-tabs` are tabs another window of the
 * application is dragging (the main process told this window): `spaceId` is the space this window shows, where they would land.
 */
export type DragSource = { kind: 'tabs'; ids: string[] } | { kind: 'favorite'; id: string } | { kind: 'folder'; id: string } | { kind: 'window-tabs'; tabs: WindowTab[]; spaceId: string }

/**
 * The tabs a drag of one row takes: the whole split view when the row is one (both its tabs go together, in the order of the view), else the selection when
 * the row is in it, else the row alone. `selected` is the selection in the order of the list, or empty when the row is not in it.
 */
export function draggedIds(tabId: string, selected: readonly string[], together?: readonly string[]): string[] {
  if (together && together.includes(tabId)) return [...together]
  return selected.length > 0 ? [...selected] : [tabId]
}

export type DropEdge = 'before' | 'after'

export type DropTarget =
  /** The mark between two rows of the sidebar, before or after this tab. `inside` (only with the tab tree) makes the dragged tabs its children. */
  | { kind: 'tab'; id: string; edge: DropEdge | 'inside' }
  /** On a folder (`null`: the loose pinned tabs): the tab goes in, after the ones already there. */
  | { kind: 'folder'; id: string | null }
  /** Today, after its last tab. */
  | { kind: 'today' }
  /** Between two favourites (`id: null`: after the last one, or an empty row). */
  | { kind: 'favorite'; id: string | null; edge: DropEdge }
  /** An icon of the footer: the tabs go to that space. */
  | { kind: 'space'; id: string }
  /** A dragged folder, placed before or after this one (next to it) or inside it (as its last folder). */
  | { kind: 'folder-at'; id: string; edge: DropEdge | 'inside' }
  /** A dragged folder, put under the loose Today tabs (after the folders already there). */
  | { kind: 'folder-bottom' }
  /** A dragged folder, put at the start of Today: under its header and its "New tab" row, before the Today tabs (and before the folders already there). */
  | { kind: 'folder-today-start' }

export interface DropPlan {
  actions: Action[]
  /** Tabs to move to another space. Not an action: crossing profiles asks the user first, which only the main process can do. */
  moveToSpace?: { ids: string[]; spaceId: string }
  /** Tabs of another window dropped at this place. Not an action either: only the main process knows which tabs are being dragged, and it alone moves their pages. */
  fromWindow?: DropTarget
}

export const NO_DROP: DropPlan = { actions: [] }

/** Whether the zone under everything, where a folder is dropped to stand under the Today tabs, is on screen: only while a folder is being dragged. */
export const showsFolderBottomZone = (dragging: DragSource | null): boolean => dragging?.kind === 'folder'

/** True when dropping there does something: otherwise no mark is shown and the pointer says so. */
export const canDrop = (plan: DropPlan): boolean => plan.actions.length > 0 || plan.moveToSpace !== undefined || plan.fromWindow !== undefined

/** The dragged tabs that exist, from the space of the first one, in the order the sidebar shows them. */
export function draggedTabs(state: SidebarState, ids: string[]): TabItem[] {
  const wanted = new Set(ids)
  const first = state.tabs.find((t) => wanted.has(t.id))
  return first ? sidebarOrder(state, first.spaceId).filter((t) => wanted.has(t.id)) : []
}

/** `parentId` is given only with the tab tree (null: no parent); without it the action is the one a flat sidebar has always had. */
const moveAction = (ids: string[], toIndex: number, pinned: boolean, folderId?: string, parentId?: string | null): Action => {
  const tree = parentId !== undefined ? { parentId } : {}
  return ids.length === 1 ? { type: 'tab/move', id: ids[0]!, toIndex, pinned, folderId, ...tree } : { type: 'tabs/move', ids, toIndex, pinned, folderId, ...tree }
}

export function planDrop(state: SidebarState, source: DragSource, target: DropTarget): DropPlan {
  if (source.kind === 'window-tabs') return placeFromWindow(state, source.tabs, source.spaceId, target) ? { actions: [], fromWindow: target } : NO_DROP
  if (source.kind === 'favorite') return planFavoriteDrop(state, source.id, target)
  if (source.kind === 'folder') return planFolderDrop(state, source.id, target)
  return planTabsDrop(state, draggedTabs(state, source.ids), target)
}

function planFolderDrop(state: SidebarState, id: string, target: DropTarget): DropPlan {
  if (target.kind === 'folder-bottom') {
    const dragged = state.folders.find((f) => f.id === id)
    // A folder that already is a root folder under the tabs has nowhere to go here.
    if (!dragged || (dragged.atBottom === true && dragged.parentId === undefined)) return NO_DROP
    return { actions: [{ type: 'folder/move', id, parentId: null, toIndex: Number.MAX_SAFE_INTEGER, side: 'bottom' }] }
  }
  if (target.kind === 'folder-today-start') return planFolderToTodayStart(state, id)
  if (target.kind !== 'folder-at') return NO_DROP
  const folder = state.folders.find((f) => f.id === id)
  const ref = state.folders.find((f) => f.id === target.id)
  if (!folder || !ref || ref.id === folder.id || ref.spaceId !== folder.spaceId) return NO_DROP
  const others = (parentId: string | null) => state.folders.filter((f) => f.spaceId === ref.spaceId && (f.parentId ?? null) === parentId && f.id !== id)
  const parentId = target.edge === 'inside' ? ref.id : (ref.parentId ?? null)
  const toIndex = target.edge === 'inside' ? others(ref.id).length : others(parentId).findIndex((f) => f.id === ref.id) + (target.edge === 'after' ? 1 : 0)
  if (!canMoveFolder(state.folders, id, parentId)) return NO_DROP
  const here = folderPlacement(state.folders, id)
  // Next to a root folder the dragged one takes its side of the list (above the Today header, at the start of Today, or under its tabs); said only when that changes the folder's own.
  const side: FolderSide | undefined = parentId === null ? sideOfFolder(ref) : undefined
  const sideChanges = side !== undefined && side !== sideOfFolder(folder)
  // Dropping a folder where it already is changes nothing: no mark.
  if (here && here.parentId === parentId && here.index === toIndex && !sideChanges) return NO_DROP
  return { actions: [{ type: 'folder/move', id, parentId, toIndex, ...(sideChanges ? { side } : {}) }] }
}

/** A dragged folder dropped on the "New tab" row of Today: it goes to the start of Today, first of the folders that are there. */
function planFolderToTodayStart(state: SidebarState, id: string): DropPlan {
  const folder = state.folders.find((f) => f.id === id)
  if (!folder) return NO_DROP
  const atRoot = (f: Folder) => f.spaceId === folder.spaceId && f.parentId === undefined
  const there = state.folders.filter((f) => atRoot(f) && sideOfFolder(f) === 'today-start')
  // Already the first one there: nothing to do, so no mark.
  if (there[0]?.id === id) return NO_DROP
  // The places are those of `folder/move`: among the root folders of the space, counted without the dragged one. In front of the folder that is first there; with
  // none, the folder keeps its place in the list (or goes last, from inside another folder) and only its side changes.
  const roots = state.folders.filter((f) => atRoot(f) && f.id !== id)
  const toIndex = there[0] ? roots.indexOf(there[0]) : folder.parentId === undefined ? Math.min(folderPlacement(state.folders, id)?.index ?? 0, roots.length) : roots.length
  return { actions: [{ type: 'folder/move', id, parentId: null, toIndex, side: 'today-start' }] }
}

function planFavoriteDrop(state: SidebarState, id: string, target: DropTarget): DropPlan {
  if (target.kind !== 'favorite') return NO_DROP
  const favorite = state.favorites.find((f) => f.id === id)
  // The row on screen is the favourites of one profile: the places are counted among them.
  const mine = favorite ? favoritesOf(state, favoriteProfile(favorite)) : []
  const from = mine.findIndex((f) => f.id === id)
  if (from === -1 || target.id === id) return NO_DROP
  const others = mine.filter((f) => f.id !== id)
  const ref = target.id === null ? -1 : others.findIndex((f) => f.id === target.id)
  if (target.id !== null && ref === -1) return NO_DROP
  const at = target.id === null ? others.length : ref + (target.edge === 'after' ? 1 : 0)
  return at === from ? NO_DROP : { actions: [{ type: 'favorite/place', id, toIndex: at }] }
}

/** Where tabs dropped in a space take their place: the arguments of `tab/move` and `tabs/move`, and what else the drop does. */
export interface Placement {
  toIndex: number
  pinned: boolean
  folderId?: string
  /** Given only with the tab tree (null: no parent). */
  parentId?: string | null
  /** Actions that go with the move (a folded branch opens when a tab is dropped inside it). */
  follow: Action[]
}

/**
 * The place a drop on a row, a folder or Today gives tabs in `space`, or null when it means nothing there. `movedIds` are the dragged tabs: the
 * places are counted without them, so that dragging down lands where the mark was. They need not be in `state` (tabs of another window).
 */
function placeInSpace(state: SidebarState, space: string, movedIds: Set<string>, target: DropTarget): Placement | null {
  // With the tab tree a tab brings everything below it to Today; to the pinned list, to a favourite or to another space it goes alone.
  const tree = state.settings.tabTree === true
  const branch = tree ? branchIds(state.tabs, movedIds) : movedIds
  /**
   * The tabs of the destination group (pinned or Today) once the dragged ones are out of it. Only the tabs the sidebar lists: the page of an open favourite is
   * a tab of the space that no row shows, and `tab/move` counts the places without it - counted here, every drop above a row landed that many places too low.
   */
  const group = (pinned: boolean) => state.tabs.filter((t) => t.spaceId === space && t.pinned === pinned && isListedTab(t) && !(pinned ? movedIds : branch).has(t.id))

  switch (target.kind) {
    case 'tab': {
      const ref = state.tabs.find((t) => t.id === target.id)
      if (!ref || ref.spaceId !== space || movedIds.has(ref.id)) return null
      if (!ref.pinned && tree) {
        // On a tab of its own branch (a child of what is dragged) there is nowhere to go.
        const slot = treeDropSlot(state.tabs, branch, ref, target.edge)
        if (!slot) return null
        const follow: Action[] = target.edge === 'inside' && ref.treeCollapsed === true ? [{ type: 'tab/tree-collapse', id: ref.id, collapsed: false }] : []
        return { toIndex: slot.toIndex, pinned: false, parentId: slot.parentId, follow }
      }
      // Dropping *on* a row only means something in the tree, and only on a Today tab.
      if (target.edge === 'inside') return null
      const at = group(ref.pinned).findIndex((t) => t.id === ref.id) + (target.edge === 'after' ? 1 : 0)
      return { toIndex: at, pinned: ref.pinned, ...(ref.pinned && ref.folderId !== undefined ? { folderId: ref.folderId } : {}), follow: [] }
    }
    case 'folder': {
      const pinned = group(true)
      if (target.id === null) {
        const loose = pinned.filter((t) => !t.folderId || !state.folders.some((f) => f.id === t.folderId))
        return { toIndex: loose.length > 0 ? pinned.indexOf(loose[loose.length - 1]!) + 1 : pinned.length, pinned: true, follow: [] }
      }
      const folder = state.folders.find((f) => f.id === target.id)
      if (!folder || folder.spaceId !== space) return null
      const inside = pinned.filter((t) => t.folderId === folder.id)
      return { toIndex: inside.length > 0 ? pinned.indexOf(inside[inside.length - 1]!) + 1 : pinned.length, pinned: true, folderId: folder.id, follow: [] }
    }
    case 'today':
      return { toIndex: group(false).length, pinned: false, follow: [] }
    default:
      return null
  }
}

function planTabsDrop(state: SidebarState, moved: TabItem[], target: DropTarget): DropPlan {
  const first = moved[0]
  if (!first) return NO_DROP
  const space = first.spaceId
  const ids = moved.map((t) => t.id)
  const movedIds = new Set(ids)

  switch (target.kind) {
    case 'tab':
    case 'folder':
    case 'today': {
      const place = placeInSpace(state, space, movedIds, target)
      return place ? { actions: [moveAction(ids, place.toIndex, place.pinned, place.folderId, place.parentId), ...place.follow] } : NO_DROP
    }
    case 'favorite': {
      // The favourites of the profile of the tabs' space are the row they are dropped on.
      const mine = favoritesOfSpace(state, space)
      const fresh = moved.filter((t) => !mine.some((f) => f.url === t.url))
      if (fresh.length === 0) return NO_DROP
      const ref = target.id === null ? -1 : mine.findIndex((f) => f.id === target.id)
      const base = ref === -1 ? mine.length : ref + (target.edge === 'after' ? 1 : 0)
      // A tab dropped on the favourites becomes one and leaves the list (a pinned tab is unpinned first: closing it would only put it to sleep).
      return {
        actions: [
          ...fresh.map((t, i): Action => ({ type: 'favorite/add', url: t.url, title: tabName(t), ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}), toIndex: base + i, spaceId: space })),
          ...fresh.flatMap((t): Action[] => (t.pinned ? [{ type: 'tab/unpin', id: t.id }, { type: 'tab/close', id: t.id }] : [{ type: 'tab/close', id: t.id }]))
        ]
      }
    }
    case 'folder-at':
    case 'folder-bottom':
    case 'folder-today-start':
      return NO_DROP
    case 'space': {
      const leaving = moved.filter((t) => t.spaceId !== target.id).map((t) => t.id)
      return leaving.length > 0 && state.spaces.some((sp) => sp.id === target.id) ? { actions: [], moveToSpace: { ids: leaving, spaceId: target.id } } : NO_DROP
    }
  }
}

/**
 * The place tabs dragged from another window take in the space `spaceId` that this window shows, when dropped at `target` (a row, a folder or Today:
 * not the favourites nor the footer, where a window other than the one shown makes no sense). Null when the drop means nothing. Counted on this window's
 * own view of the state. A private tab never goes to the pinned list or a folder (the pinned list is saved), so a drop there is refused as a whole.
 */
export function placeFromWindow(state: SidebarState, tabs: readonly WindowTab[], spaceId: string, target: DropTarget): Placement | null {
  if (tabs.length === 0 || !state.spaces.some((sp) => sp.id === spaceId)) return null
  const place = placeInSpace(state, spaceId, new Set(tabs.map((t) => t.id)), target)
  return place && !(place.pinned && tabs.some((t) => t.private === true)) ? place : null
}

/** The drop target a message from the interface names, or null: only the places a tab from another window can take (see `placeFromWindow`) are accepted, with the bounds of what crosses the channel. */
export function parseDropTarget(raw: unknown): DropTarget | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  switch (r.kind) {
    case 'today':
      return { kind: 'today' }
    case 'tab':
      return id(r.id) && (r.edge === 'before' || r.edge === 'after' || r.edge === 'inside') ? { kind: 'tab', id: r.id, edge: r.edge } : null
    case 'folder':
      return r.id === null ? { kind: 'folder', id: null } : id(r.id) ? { kind: 'folder', id: r.id } : null
    default:
      return null
  }
}

/** True when some of these tabs would change profile (other cookies and logins) by going to that space: the user is asked first. */
export function movesAcrossProfiles(state: SidebarState, ids: string[], spaceId: string): boolean {
  const target = state.spaces.find((sp) => sp.id === spaceId)
  if (!target) return false
  const moving = state.tabs.filter((t) => ids.includes(t.id) && t.spaceId !== spaceId)
  return moving.some((t) => state.spaces.find((sp) => sp.id === t.spaceId)?.profileId !== target.profileId)
}

// ---- where the pointer is: the rectangles of the rows come from the DOM, the decision is made here so it can be tested ----

/** A row of the sidebar that can receive a drop, with its position on screen. Rows are listed top to bottom. */
export interface RowBox {
  kind: 'tab' | 'folder' | 'pin-zone' | 'today-start' | 'folder-bottom'
  /** The tab or folder shown. For a split view, the tab the row stands at. */
  id: string
  top: number
  bottom: number
  /** Folder: the folder it is in (`null` at the root), and whether it is the first folder of that parent. */
  parentId?: string | null
  first?: boolean
  /** Today start: the first Today row, which a drop there goes in front of. */
  beforeId?: string
  /** Folder: whether it is closed (a dragged folder dropped on its lower part goes after it, not into it). */
  collapsed?: boolean
  /**
   * Folder: the side of a root folder that is not above the Today header. Under the Today tabs (`bottom`) the end of what is above its first one is Today, not
   * the loose pinned tabs; at the start of Today (`today-start`) it is neither of them, so no part of its first row means "after something above it".
   */
  side?: 'today-start' | 'bottom'
  /** Tab: it is a pinned tab (which cannot have children, so no part of its row means "inside"). Only read with the tab tree. */
  pinned?: boolean
}

/** Where a drop would land and how to mark it: `at` names the row to draw the mark on, `edge` the side of it. */
export interface Located {
  target: DropTarget
  at: string
  edge: DropEdge | 'inside'
}

/** The part of a folder's header (from its top) where a drop means "next to the folder" rather than "in it". */
export const FOLDER_HEADER_EDGE = 0.25

/** With the tab tree, the part of a row (from its top, and from its bottom) where a drop means "next to the tab" rather than "under it". */
export const TAB_EDGE = 0.3

/**
 * Finds the row closest to the pointer. The few pixels between two rows belong to the nearer one, and below the last
 * row the pointer still means "after it", so there is no dead zone to drop in.
 */
export function locateRow(rows: RowBox[], y: number, tree = false): Located | null {
  let best: RowBox | null = null
  let bestDistance = Infinity
  for (const row of rows) {
    const distance = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0
    if (distance < bestDistance) {
      best = row
      bestDistance = distance
    }
  }
  if (!best) return null
  const height = best.bottom - best.top
  const position = height > 0 ? Math.min(1, Math.max(0, (y - best.top) / height)) : 0.5

  switch (best.kind) {
    case 'tab': {
      // In the tree the middle of a Today row is "under this tab"; the quarter above and the quarter below are the places next to it.
      const edge: DropEdge | 'inside' = tree && !best.pinned ? (position < TAB_EDGE ? 'before' : position > 1 - TAB_EDGE ? 'after' : 'inside') : position < 0.5 ? 'before' : 'after'
      return { target: { kind: 'tab', id: best.id, edge }, at: `tab:${best.id}`, edge }
    }
    case 'folder': {
      // The top of the first folder is the end of what is above it (the loose pinned tabs, or, for the first folder under the Today tabs, Today); anywhere else on a folder is "in the folder".
      // For the first folder at the start of Today it is the "New tab" row, which a tab dropped there reaches by that row itself: so it is "in the folder" there too.
      const atTop = position < FOLDER_HEADER_EDGE && best.first && best.side !== 'today-start'
      if (atTop && best.side === 'bottom') return { target: { kind: 'today' }, at: `folder:${best.id}`, edge: 'before' }
      return atTop
        ? { target: { kind: 'folder', id: best.parentId ?? null }, at: `folder:${best.id}`, edge: 'before' }
        : { target: { kind: 'folder', id: best.id }, at: `folder:${best.id}`, edge: 'inside' }
    }
    // Only a dragged folder shows this zone, and a dragged folder looks for folder rows alone (`locateFolderRow`).
    case 'folder-bottom':
      return null
    case 'pin-zone':
      return { target: { kind: 'folder', id: null }, at: 'pin-zone', edge: 'inside' }
    case 'today-start':
      return best.beforeId
        ? { target: { kind: 'tab', id: best.beforeId, edge: 'before' }, at: `tab:${best.beforeId}`, edge: 'before' }
        : { target: { kind: 'today' }, at: 'today-start', edge: 'inside' }
  }
}

/** The part of a folder row (from its top, and from its bottom when it is closed) where a dragged folder goes next to it rather than into it. */
export const FOLDER_SLOT_EDGE = 0.3

/**
 * Where a dragged folder would land: only the folder rows, the zone under everything and the "New tab" row of Today count, the nearest one to the pointer. The
 * Today tabs between the last two are not places for it: a folder goes to the start of Today or under its tabs, and the pointer over them means the nearer.
 */
export function locateFolderRow(rows: RowBox[], y: number): Located | null {
  let best: RowBox | null = null
  let bestDistance = Infinity
  for (const row of rows) {
    if (row.kind !== 'folder' && row.kind !== 'folder-bottom' && row.kind !== 'today-start') continue
    const distance = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0
    if (distance < bestDistance) {
      best = row
      bestDistance = distance
    }
  }
  if (!best) return null
  if (best.kind === 'folder-bottom') return { target: { kind: 'folder-bottom' }, at: 'folder-bottom', edge: 'inside' }
  // The folder goes under the "New tab" row: the mark is the line under it.
  if (best.kind === 'today-start') return { target: { kind: 'folder-today-start' }, at: 'today-start', edge: 'after' }
  const height = best.bottom - best.top
  const position = height > 0 ? Math.min(1, Math.max(0, (y - best.top) / height)) : 0.5
  const edge: DropEdge | 'inside' = position < FOLDER_SLOT_EDGE ? 'before' : position > 1 - FOLDER_SLOT_EDGE && best.collapsed ? 'after' : 'inside'
  return { target: { kind: 'folder-at', id: best.id, edge }, at: `folder:${best.id}`, edge }
}

export interface FavoriteBox {
  id: string
  left: number
  right: number
  top: number
  bottom: number
}

/** The favourite nearest the pointer, and the side of it: left half is before, right half after. No favourite at all means "at the end". */
export function locateFavorite(boxes: FavoriteBox[], x: number, y: number): Located {
  let best: FavoriteBox | null = null
  let bestDistance = Infinity
  for (const box of boxes) {
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0
    // Same row first: a pointer between two rows of tiles belongs to the nearer row, then to the nearer tile in it.
    const distance = dy * 1000 + dx
    if (distance < bestDistance) {
      best = box
      bestDistance = distance
    }
  }
  if (!best) return { target: { kind: 'favorite', id: null, edge: 'after' }, at: 'favorites', edge: 'inside' }
  const edge: DropEdge = x < (best.left + best.right) / 2 ? 'before' : 'after'
  return { target: { kind: 'favorite', id: best.id, edge }, at: `favorite:${best.id}`, edge }
}
