// Tab groups of extensions (chrome.tabGroups, chrome.tabs.group) shown as folders in the sidebar. The folders of the sidebar hold pinned tabs, so the
// tabs of a group are pinned into a folder of their own while the group lives, and put back where they were when it ends (the group is
// ungrouped, its tabs close, the extension goes, the setting is switched off). The folder is the extension's picture of its group, not a
// new thing to keep: the files the application writes never hold it (see `persistableState`), so that a quit or a crash cannot leave a
// folder of pinned tabs behind for a group that no longer exists.
//
// The extension is the master: its title becomes the folder's name and its `collapsed` the folder's state, when the extension changes
// them. What the user does to the folder is respected: a folder they delete is not built again for that group, a tab they drag out
// stays out, a name they type stays until the extension changes the title. Nothing goes back to the extension (a folder opened or closed
// by hand does not change `collapsed`).

import type { Action } from './sidebar'
import type { SidebarState, TabItem } from './model'
import { t } from './i18n'

/**
 * Where a tab was before a group took it into a folder: pinned or not, in which folder, and its place among the tabs of its kind in its
 * space (so that the tabs come back in the order they left, even with other tabs between them).
 */
export type Placement = { pinned: false; index: number } | { pinned: true; index: number; folderId?: string }

/** The folders that mirror groups, and for each the tabs it holds with the place each one came from. */
export type MirroredPlacements = ReadonlyMap<string, ReadonlyMap<string, Placement>>

/** The name of the folder for a group: its title, or a word when it has none. */
export const groupFolderDefaultName = (): string => t('group-folders.groupe')
export const GROUP_FOLDER_NAME_MAX = 120

export const groupFolderName = (title: string): string => {
  const clean = Array.from(title.replace(/\p{Cc}/gu, ' ').trim()).slice(0, GROUP_FOLDER_NAME_MAX).join('').trim()
  return clean === '' ? groupFolderDefaultName() : clean
}

/** What the extension-side model says about a group: enough to build its folder. */
export interface MirroredGroup {
  id: number
  title: string
  collapsed: boolean
  /** The ids of the tabs (pages) in the group. */
  tabs: readonly string[]
}

/** The part of the application the mirror needs: the state, and a way to change it as the user would. */
export interface GroupFolderPort {
  state(): SidebarState
  dispatch(action: Action): void
  /** Something went wrong in a way the user cannot see (a folder that could not be made). */
  report?(message: string): void
}

interface Mirror {
  folderId: string
  spaceId: string
  /** The name and state the extension last asked for: they are pushed again only when the extension changes them. */
  name: string
  collapsed: boolean
  /** The tabs this mirror put in the folder, and where each one was. */
  tabs: Map<string, Placement>
  /** Tabs the user took out of the folder while they are still in the group: they are not put back. */
  left: Set<string>
}

/** The place of a tab in `state`, to put it back to later. */
function placementOf(state: SidebarState, tab: TabItem): Placement {
  const index = state.tabs.filter((t) => t.spaceId === tab.spaceId && t.pinned === tab.pinned).findIndex((t) => t.id === tab.id)
  return tab.pinned ? { pinned: true, index, ...(tab.folderId !== undefined ? { folderId: tab.folderId } : {}) } : { pinned: false, index }
}

export class GroupFolders {
  /** One folder per group and per space: the tabs of a group in two spaces make two folders (a folder holds the tabs of its own space). */
  private readonly mirrors = new Map<string, Mirror>()
  /** Folders the user removed while their group lived: not built again until the group ends. */
  private readonly dismissed = new Set<string>()

  constructor(private readonly port: GroupFolderPort) {}

  /** The folders now standing for groups, with the tabs they hold and where those came from: what a file must be written without. */
  placements(): MirroredPlacements {
    return new Map([...this.mirrors.values()].map((mirror) => [mirror.folderId, new Map(mirror.tabs)]))
  }

  /** Brings the folders in line with the groups as they are now. Idempotent: calling it again with the same groups changes nothing. */
  sync(groups: readonly MirroredGroup[]): void {
    const state = this.port.state()
    const tabs = new Map(state.tabs.map((tab) => [tab.id, tab]))
    const wanted = new Map<string, { group: MirroredGroup; spaceId: string; ids: string[] }>()
    for (const group of groups) {
      for (const id of group.tabs) {
        const tab = tabs.get(id)
        // A private tab is never pinned, so it never joins a folder.
        if (!tab || tab.private === true) continue
        const key = `${group.id}@${tab.spaceId}`
        const entry = wanted.get(key) ?? { group, spaceId: tab.spaceId, ids: [] }
        entry.ids.push(id)
        wanted.set(key, entry)
      }
    }
    this.dissolve([...this.mirrors.keys()].filter((key) => !wanted.has(key)))
    for (const key of [...this.dismissed]) if (!wanted.has(key)) this.dismissed.delete(key)
    // Where each tab is put back to is read from the state as it was before this turn changed anything, so that every place counts the others.
    for (const [key, entry] of wanted) this.reconcile(key, entry.group, entry.spaceId, entry.ids, state)
  }

  /** Puts every tab back where it was and removes every folder: the setting is off, or the application is stopping. */
  release(): void {
    this.dissolve([...this.mirrors.keys()])
    this.dismissed.clear()
  }

  private reconcile(key: string, group: MirroredGroup, spaceId: string, ids: string[], origin: SidebarState): void {
    if (this.dismissed.has(key)) return
    const name = groupFolderName(group.title)
    const mirror = this.mirrors.get(key)
    if (!mirror) return this.build(key, group, spaceId, ids, name, origin)
    const state = this.port.state()
    const byId = new Map(state.tabs.map((tab) => [tab.id, tab]))
    const members = new Set(ids)
    const leaving: Array<[string, Placement]> = []
    for (const [id, placement] of [...mirror.tabs]) {
      const tab = byId.get(id)
      if (!tab) mirror.tabs.delete(id)
      else if (tab.folderId !== mirror.folderId) {
        // Dragged out by the user, or left loose by the removal of the folder (the tabs stay where that left them): they are theirs now,
        // and stay out while the group holds them.
        mirror.tabs.delete(id)
        if (members.has(id)) mirror.left.add(id)
      } else if (!members.has(id)) {
        // Out of the group: back where it was.
        mirror.tabs.delete(id)
        leaving.push([id, placement])
      }
    }
    this.restore(leaving)
    for (const id of [...mirror.left]) if (!members.has(id)) mirror.left.delete(id)
    const joining = ids.filter((id) => !mirror.tabs.has(id) && !mirror.left.has(id))
    if (joining.length > 0) {
      const places = new Map(joining.map((id) => [id, placementOf(origin.tabs.some((t) => t.id === id) ? origin : state, byId.get(id)!)]))
      this.port.dispatch({ type: 'tabs/move', ids: joining, toIndex: Number.MAX_SAFE_INTEGER, pinned: true, folderId: mirror.folderId })
      const after = new Map(this.port.state().tabs.map((tab) => [tab.id, tab]))
      for (const id of joining) if (after.get(id)?.folderId === mirror.folderId) mirror.tabs.set(id, places.get(id)!)
    }
    if (name !== mirror.name) {
      mirror.name = name
      this.port.dispatch({ type: 'folder/rename', id: mirror.folderId, name })
    }
    if (group.collapsed !== mirror.collapsed) {
      mirror.collapsed = group.collapsed
      const current = this.port.state().folders.find((f) => f.id === mirror.folderId)
      if (current && current.collapsed !== group.collapsed) this.port.dispatch({ type: 'folder/toggle', id: mirror.folderId })
    }
    // Nothing of the group is left in the folder (every tab was taken out by the user): the folder is empty for nothing, and not built again.
    if (mirror.tabs.size === 0) {
      this.dissolve([key])
      if (members.size > 0) this.dismissed.add(key)
    }
  }

  private build(key: string, group: MirroredGroup, spaceId: string, ids: string[], name: string, origin: SidebarState): void {
    const before = this.port.state()
    const known = new Set(before.folders.map((f) => f.id))
    const places = new Map(ids.map((id) => [id, placementOf(origin, origin.tabs.find((tab) => tab.id === id)!)]))
    this.port.dispatch({ type: 'folder/create-with', tabIds: ids, name })
    const after = this.port.state()
    const folder = after.folders.find((f) => !known.has(f.id) && f.spaceId === spaceId)
    if (!folder) {
      this.port.report?.(`[tab-groups] no folder could be made for the group ${group.id}`)
      this.dismissed.add(key)
      return
    }
    const tabs = new Map<string, Placement>()
    for (const tab of after.tabs) if (tab.folderId === folder.id && places.has(tab.id)) tabs.set(tab.id, places.get(tab.id)!)
    this.mirrors.set(key, { folderId: folder.id, spaceId, name, collapsed: false, tabs, left: new Set() })
    if (group.collapsed) {
      this.mirrors.get(key)!.collapsed = true
      this.port.dispatch({ type: 'folder/toggle', id: folder.id })
    }
  }

  /** Puts tabs back, the one that was nearest the top first: each goes to its old place among the tabs that are there by then. */
  private restore(tabs: ReadonlyArray<readonly [string, Placement]>): void {
    for (const [id, placement] of [...tabs].sort((a, b) => a[1].index - b[1].index)) {
      this.port.dispatch({ type: 'tabs/move', ids: [id], toIndex: placement.index, pinned: placement.pinned, ...(placement.pinned && placement.folderId !== undefined ? { folderId: placement.folderId } : {}) })
    }
  }

  /** Groups have ended in these spaces: their tabs go back (all together, so that they find each other's places), then the folders go. */
  private dissolve(keys: readonly string[]): void {
    const ended = keys.flatMap((key) => this.mirrors.get(key) ?? [])
    if (ended.length === 0) return
    const byId = new Map(this.port.state().tabs.map((tab) => [tab.id, tab]))
    // The records go only once the work is done: if the store refuses half way, the folders are still known, and the files are still written without them.
    this.restore(ended.flatMap((mirror) => [...mirror.tabs].filter(([id]) => byId.get(id)?.folderId === mirror.folderId)))
    for (const mirror of ended) if (this.port.state().folders.some((f) => f.id === mirror.folderId)) this.port.dispatch({ type: 'folder/delete', id: mirror.folderId })
    for (const key of keys) this.mirrors.delete(key)
  }
}

// ---------- what the files must not hold ----------

/**
 * The state as a file must keep it: the folders that mirror groups are gone and their tabs are where they were before the group took them.
 * A tab the user put in such a folder by hand stays pinned at the root. Same object when there is nothing to take out.
 */
export function withoutMirroredFolders(state: SidebarState, mirrored: MirroredPlacements): SidebarState {
  if (mirrored.size === 0) return state
  const gone = new Set([...mirrored.keys()].filter((id) => state.folders.some((f) => f.id === id)))
  if (gone.size === 0) return state
  // A tab the user put in such a folder by hand has no place to go back to: it stays pinned, at the root of the pinned list.
  let tabs = state.tabs.map((tab): TabItem => {
    if (tab.folderId === undefined || !gone.has(tab.folderId)) return tab
    const { folderId: _in, ...rest } = tab
    return rest
  })
  const back: Array<[string, Placement]> = []
  for (const tab of state.tabs) {
    const place = tab.folderId !== undefined && gone.has(tab.folderId) ? mirrored.get(tab.folderId)?.get(tab.id) : undefined
    if (place) back.push([tab.id, place])
  }
  // One at a time and the nearest the top first, as the application puts them back: the order of the written tabs is the live one.
  for (const [id, place] of back.sort((a, b) => a[1].index - b[1].index)) {
    const tab = tabs.find((t) => t.id === id)!
    const { anchorUrl: _anchor, ...today } = tab
    const there: TabItem = place.pinned ? { ...tab, ...(place.folderId !== undefined && state.folders.some((f) => f.id === place.folderId && !gone.has(f.id)) ? { folderId: place.folderId } : {}) } : { ...today, pinned: false }
    const rest = tabs.filter((t) => t.id !== id)
    const group = rest.filter((t) => t.spaceId === tab.spaceId && t.pinned === place.pinned)
    const pivot = group[Math.max(0, Math.min(place.index, group.length))]
    const at = pivot ? rest.indexOf(pivot) : group.length > 0 ? rest.indexOf(group[group.length - 1]!) + 1 : rest.length
    tabs = [...rest.slice(0, at), there, ...rest.slice(at)]
  }
  const folders = state.folders
    .filter((f) => !gone.has(f.id))
    .map((f) => {
      if (f.parentId === undefined || !gone.has(f.parentId)) return f
      const { parentId: _up, ...root } = f
      return root
    })
  return { ...state, folders, tabs }
}

let source: (() => MirroredPlacements) | null = null

/** The main process tells here which folders mirror groups right now. Only it writes files, so only it sets this. */
export function setGroupMirror(placements: () => MirroredPlacements): void {
  source = placements
}

/** Ends the above, if `placements` is still the one in force (a mirror that was started again meanwhile is left alone). */
export function clearGroupMirror(placements: () => MirroredPlacements): void {
  if (source === placements) source = null
}

/** `withoutMirroredFolders` for the folders the application mirrors now: what `persistableState` applies. */
export function withoutGroupFolders(state: SidebarState): SidebarState {
  const mirrored = source?.()
  return mirrored ? withoutMirroredFolders(state, mirrored) : state
}
