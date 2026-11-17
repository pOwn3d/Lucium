// Nested folders of the pinned list: the tree is stored flat (`Folder.parentId`), these helpers walk it.
// Every walk is cycle-safe, because a hand-edited or imported file can hold anything.

import type { Folder } from './model'

/** Levels of folders one inside the other: a root folder is level 1. */
export const FOLDER_MAX_DEPTH = 4

/** Level of a folder (1 for a folder at the root), 0 when it does not exist. A chain that loops stops at the first folder seen twice. */
export function folderDepth(folders: Folder[], id: string): number {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const seen = new Set<string>()
  let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return seen.size
}

/** The folders directly inside `parentId` (`undefined`: the root), in display order. */
export function folderChildren(folders: Folder[], parentId: string | undefined, spaceId?: string): Folder[] {
  return folders.filter((f) => f.parentId === parentId && (spaceId === undefined || f.spaceId === spaceId))
}

/** A folder and everything below it, depth first (the order the sidebar shows them in). */
export function folderSubtreeIds(folders: Folder[], id: string): string[] {
  if (!folders.some((f) => f.id === id)) return []
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (current: string) => {
    if (seen.has(current)) return
    seen.add(current)
    out.push(current)
    for (const child of folders.filter((f) => f.parentId === current)) walk(child.id)
  }
  walk(id)
  return out
}

/** Levels from a folder down to the deepest folder inside it, the folder itself counting for 1 (0 when it does not exist). */
export function folderHeight(folders: Folder[], id: string): number {
  const seen = new Set<string>()
  const walk = (current: string): number => {
    if (seen.has(current)) return 0
    seen.add(current)
    let deepest = 0
    for (const child of folders.filter((f) => f.parentId === current)) deepest = Math.max(deepest, walk(child.id))
    return 1 + deepest
  }
  return folders.some((f) => f.id === id) ? walk(id) : 0
}

/**
 * Whether a folder may be moved under `parentId` (`null`: the root): in the same space, not into itself or into what is below it,
 * and only while the deepest folder it holds still fits in `FOLDER_MAX_DEPTH` levels.
 */
export function canMoveFolder(folders: Folder[], id: string, parentId: string | null): boolean {
  const folder = folders.find((f) => f.id === id)
  if (!folder) return false
  if (parentId === null) return true
  const parent = folders.find((f) => f.id === parentId)
  if (!parent || parent.spaceId !== folder.spaceId) return false
  if (folderSubtreeIds(folders, id).includes(parent.id)) return false
  return folderDepth(folders, parent.id) + folderHeight(folders, id) <= FOLDER_MAX_DEPTH
}

/** Where a folder stands among its siblings (the folders of its parent in its space): the parent (`null` at the root) and its index. */
export function folderPlacement(folders: Folder[], id: string): { parentId: string | null; index: number } | null {
  const folder = folders.find((f) => f.id === id)
  if (!folder) return null
  const siblings = folders.filter((f) => f.spaceId === folder.spaceId && (f.parentId ?? null) === (folder.parentId ?? null))
  return { parentId: folder.parentId ?? null, index: siblings.findIndex((f) => f.id === id) }
}

/** The folders above one, nearest first. */
export function folderAncestors(folders: Folder[], id: string): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: string[] = []
  let parent = byId.get(id)?.parentId
  while (parent && !out.includes(parent) && parent !== id) {
    out.push(parent)
    parent = byId.get(parent)?.parentId
  }
  return out
}

/** The tabs that are never woken by themselves: those inside a folder marked `noWake`, or inside a folder in one (shared/model.ts). */
export function noWakeTabIds(state: { tabs: ReadonlyArray<{ id: string; folderId?: string }>; folders: Folder[] }): Set<string> {
  const marked = new Set(state.folders.filter((f) => f.noWake === true).flatMap((f) => folderSubtreeIds(state.folders, f.id)))
  if (marked.size === 0) return new Set()
  return new Set(state.tabs.filter((tab) => tab.folderId !== undefined && marked.has(tab.folderId)).map((tab) => tab.id))
}

/** The collapsed folders to open so that a tab inside `folderId` can be seen: the folder itself and every ancestor. */
export function foldersToReveal(folders: Folder[], folderId: string | undefined): string[] {
  if (!folderId) return []
  const byId = new Map(folders.map((f) => [f.id, f]))
  return [folderId, ...folderAncestors(folders, folderId)].filter((id) => byId.get(id)?.collapsed)
}

export interface FolderRow {
  folder: Folder
  /** 0 for a root folder: the indentation is 16 px for each level. */
  depth: number
  /** The folder itself or one above it is collapsed: its tabs are not on screen. */
  hidden: boolean
}

/**
 * Where a root folder stands: `top`, with the loose pinned tabs above the Today header (as folders always have), `today-start` (`atTodayStart`), under the
 * Today header and its "New tab" row but before the Today tabs, or `bottom` (`atBottom`), under the Today tabs. The sidebar draws them in that order.
 */
export type FolderSide = 'top' | 'today-start' | 'bottom'

export const isFolderSide = (value: unknown): value is FolderSide => value === 'top' || value === 'today-start' || value === 'bottom'

export const sideOfFolder = (folder: Pick<Folder, 'atBottom' | 'atTodayStart'>): FolderSide => (folder.atBottom === true ? 'bottom' : folder.atTodayStart === true ? 'today-start' : 'top')

/** The folder with the flag of `side` and no other: the one way a side is written, so that a folder never has two. */
export function withSide<T extends Folder>(folder: T, side: FolderSide): T {
  const { atBottom: _bottom, atTodayStart: _start, ...rest } = folder
  return { ...rest, ...(side === 'bottom' ? { atBottom: true as const } : side === 'today-start' ? { atTodayStart: true as const } : {}) } as T
}

/**
 * The folders of a space as the sidebar lists them: each folder followed by the ones inside it. With `side`, only the trees of the root folders on that
 * side of the list (all of them without it).
 */
export function folderRows(folders: Folder[], spaceId: string, side?: FolderSide): FolderRow[] {
  const mine = folders.filter((f) => f.spaceId === spaceId)
  const ids = new Set(mine.map((f) => f.id))
  const rows: FolderRow[] = []
  const seen = new Set<string>()
  const walk = (folder: Folder, depth: number, hiddenAbove: boolean) => {
    if (seen.has(folder.id)) return
    seen.add(folder.id)
    rows.push({ folder, depth, hidden: hiddenAbove })
    for (const child of mine.filter((f) => f.parentId === folder.id)) walk(child, depth + 1, hiddenAbove || folder.collapsed)
  }
  // A folder whose parent is missing is shown at the root rather than lost (normalize() repairs the data itself).
  for (const folder of mine.filter((f) => !f.parentId || !ids.has(f.parentId))) if (side === undefined || sideOfFolder(folder) === side) walk(folder, 0, false)
  return rows
}

/** Repairs the tree: a missing parent (or one in another space) sends the folder to the root, a loop is cut, and nothing goes deeper than `FOLDER_MAX_DEPTH`. */
export function normalizeFolders(folders: Folder[], spaceIds: Set<string>): Folder[] {
  const valid = folders.filter((f) => spaceIds.has(f.spaceId))
  const byId = new Map(valid.map((f) => [f.id, f]))
  const wanted = new Map<string, string | undefined>()
  for (const f of valid) {
    const parent = f.parentId ? byId.get(f.parentId) : undefined
    wanted.set(f.id, parent && parent.spaceId === f.spaceId ? parent.id : undefined)
  }
  const children = new Map<string | undefined, string[]>()
  for (const f of valid) {
    const siblings = children.get(wanted.get(f.id))
    if (siblings) siblings.push(f.id)
    else children.set(wanted.get(f.id), [f.id])
  }

  const final = new Map<string, string | undefined>()
  // A list of what is left to place, not a function that calls itself: a file can chain thousands of folders one inside the other, and a call per
  // level would overflow the stack before the repair could flatten them.
  const walk = (root: string, rootParent: string | undefined, rootDepth: number) => {
    const pending: Array<[id: string, parent: string | undefined, depth: number]> = [[root, rootParent, rootDepth]]
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [id, parent, depth] = next
      if (final.has(id)) continue
      final.set(id, parent)
      // Below the deepest level, folders are attached to the folder above their parent instead of going deeper.
      for (const child of children.get(id) ?? []) pending.push(depth >= FOLDER_MAX_DEPTH ? [child, parent, depth] : [child, id, depth + 1])
    }
  }
  for (const id of children.get(undefined) ?? []) walk(id, undefined, 1)
  // What no root reaches is part of a loop: the first of its folders (in file order) becomes a root and the loop is cut there.
  for (const f of valid) walk(f.id, undefined, 1)

  return valid.map((f) => {
    const parent = final.get(f.id)
    // Only a root folder has a side of the list: one that sits in another is placed with it.
    const sideless = parent !== undefined && (f.atBottom !== undefined || f.atTodayStart !== undefined)
    if (parent === f.parentId && !sideless) return f
    const { parentId: _old, ...rest } = f
    return parent ? withSide({ ...rest, parentId: parent }, 'top') : withSide(rest, sideOfFolder(f))
  })
}
