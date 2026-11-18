// A family of the reducer of the sidebar (sidebar.ts composes them in `reduceCore`): `sync/apply`, the one way a synchronisation session writes into the state
// (docs/synchronisation.md §8.5). It takes a patch the session worked out between the snapshot it froze and the merged one, and changes only what the patch names:
//
//   - a field is set only if the state still holds what it held when the session froze its snapshot (`expect`): what the person changed meanwhile keeps their change,
//     and the next session sends it;
//   - an entity is removed only if it is still as it was frozen;
//   - an entity that arrives is made with the defaults the model needs, then its fields; and then the whole state goes through `normalize`, which is the door every
//     state read from a file goes through: every field is cleaned and rebounded, an address that cannot be loaded drops its entity, a reference that points at nothing
//     is cut, and a state with no space gets one;
//   - the lists are reordered group by group (the spaces, the folders of a folder, the pinned tabs of a folder, the favourites of a profile), in the places the members
//     already hold, so that what is not synchronised (the Today tabs) does not move;
//   - the settings are the closed list of docs/synchronisation.md §10.3, and nothing else.
//
// Only the main process sends this action (`MAIN_ONLY_ACTIONS`, ipc-policy.ts): a page of the interface can never write a patch.

import { sameJson } from './sync-canonical'
import { defaultTheme } from './theme'
import type { SidebarState } from './model'
import type { Ctx, Action } from './sidebar-actions'
import { normalize } from './sidebar-state'

export type PatchKind = 'space' | 'folder' | 'tab' | 'favorite' | 'archived'

/** The settings a patch may set: the closed list of §10.3. A key outside it is ignored, whatever the patch says. */
export const SYNCED_SETTING_KEYS = ['httpsUpgrade', 'sendGpc', 'stripTrackingParams', 'stripCopiedLinks', 'protectionBaseline', 'autoArchiveHours', 'searchUrlTemplate', 'profileNames'] as const

export interface PatchUpsert {
  kind: PatchKind
  id: string
  /** The entity is new here: it is made, with its seed fields. */
  create: boolean
  /** The fields to set. */
  fields: Record<string, unknown>
  /** The fields to take away. */
  remove: string[]
  /** What each field named above held when the session froze its snapshot (absent: it was absent): the field is touched only while it still does. */
  expect: Record<string, unknown>
}

export interface PatchRemoval {
  kind: PatchKind
  id: string
  /** The synchronised fields the entity had when frozen: it is removed only while it still has exactly these. */
  expect: Record<string, unknown>
}

export interface SyncPatch {
  upserts: PatchUpsert[]
  removals: PatchRemoval[]
  /** List key → the ids in their new order. */
  order: Record<string, string[]>
  settings: Record<string, unknown>
}

type Entity = Record<string, unknown>

const COLLECTION = { space: 'spaces', folder: 'folders', tab: 'tabs', favorite: 'favorites', archived: 'archive' } as const

/** A key that is never written to an object: it would reach the prototype. */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

function made(kind: PatchKind, id: string, now: number): Entity {
  switch (kind) {
    case 'space':
      return { id, name: '', emoji: '🏠', theme: defaultTheme(), profileId: 'default' }
    case 'folder':
      return { id, spaceId: '', name: '', collapsed: false }
    case 'tab':
      return { id, spaceId: '', url: '', title: '', pinned: true, createdAt: now, lastActiveAt: now }
    case 'favorite':
      // On the default profile unless the fields say another one: a favourite with no profile would be given to every profile in use (`normalize`).
      return { id, url: '', title: '', profileId: 'default' }
    case 'archived':
      return { id, spaceId: '', url: '', title: '', archivedAt: now }
  }
}

/** Whether the entity still holds, for every name in `expect` and `names`, what the session froze. */
const unchanged = (entity: Entity, expect: Record<string, unknown>, names: readonly string[]): boolean => names.every((name) => sameJson(entity[name], Object.hasOwn(expect, name) ? expect[name] : undefined))

/** One collection while a patch is applied: a copy of its list, changed in place, and where each id sits in it (the first one met). */
interface Working {
  list: Entity[]
  index: Map<unknown, number>
}

/**
 * Makes or changes one entity of `work`, which a whole patch shares: an entity is found by its place in the index, not by a walk of the list. A patch of forty thousand new
 * entities used to walk and copy the list for each of them, which held the main process for seconds (a device that sends them is not stopped by its digest: it works out the
 * same merge).
 */
function upsert(work: Working, change: PatchUpsert, now: number): void {
  const at = work.index.get(change.id)
  if (at === undefined) {
    if (!change.create) return
    const entity = made(change.kind, change.id, now)
    for (const [name, value] of Object.entries(change.fields)) if (!UNSAFE.has(name) && name !== 'id') entity[name] = value
    // A pinned tab that comes back without the page it was on (the other device kept it, this one deleted it and the merge gave it back: its seed fields are sent only with
    // a new entity) opens at the page it returns to.
    if (change.kind === 'tab' && entity['url'] === '' && typeof entity['anchorUrl'] === 'string') {
      entity['url'] = entity['anchorUrl']
      if (entity['title'] === '') entity['title'] = typeof entity['customTitle'] === 'string' && entity['customTitle'] !== '' ? entity['customTitle'] : entity['anchorUrl']
    }
    work.index.set(change.id, work.list.length)
    work.list.push(entity)
    return
  }
  const entity = { ...(work.list[at] as Entity) }
  for (const [name, value] of Object.entries(change.fields)) if (!UNSAFE.has(name) && name !== 'id' && unchanged(entity, change.expect, [name])) entity[name] = value
  for (const name of change.remove) if (!UNSAFE.has(name) && name !== 'id' && unchanged(entity, change.expect, [name])) delete entity[name]
  work.list[at] = entity
}

/** The members of a list key and where the list sits in the collection it orders, or null for a key that names nothing this version orders. */
function groupOf(key: string): ((collection: 'spaces' | 'folders' | 'tabs' | 'favorites', entity: Entity) => boolean) | null {
  const [head, ...rest] = key.split(':')
  const last = rest.pop()
  const middle = rest.join(':')
  const dash = (value: unknown): string => (typeof value === 'string' ? value : '-')
  if (head === 'spaces' && rest.length === 0 && last === undefined) return (collection) => collection === 'spaces'
  if (head === 'folders' && last !== undefined) return (collection, entity) => collection === 'folders' && entity['spaceId'] === middle && dash(entity['parentId']) === last
  if (head === 'tabs' && last !== undefined) return (collection, entity) => collection === 'tabs' && entity['pinned'] === true && entity['private'] !== true && entity['spaceId'] === middle && dash(entity['folderId']) === last
  if (head === 'favorites' && rest.length === 0 && last !== undefined) return (collection, entity) => collection === 'favorites' && (typeof entity['profileId'] === 'string' ? entity['profileId'] : 'default') === last
  return null
}

/** The collection a list key orders. */
const collectionOf = (key: string): 'spaces' | 'folders' | 'tabs' | 'favorites' | null => {
  const head = key.split(':')[0]
  return head === 'spaces' || head === 'folders' || head === 'tabs' || head === 'favorites' ? head : null
}

/** The key of the list an entity of a collection is a member of (the inverse of `groupOf`), or null when it is in none: an id with a colon cannot be told from the key. */
function groupKeyOf(collection: 'spaces' | 'folders' | 'tabs' | 'favorites', entity: Entity): string | null {
  const dash = (value: unknown): string => (typeof value === 'string' ? value : '-')
  const spaceId = entity['spaceId']
  switch (collection) {
    case 'spaces':
      return 'spaces'
    case 'folders': {
      const parent = dash(entity['parentId'])
      return typeof spaceId === 'string' && !parent.includes(':') ? `folders:${spaceId}:${parent}` : null
    }
    case 'tabs': {
      const folder = dash(entity['folderId'])
      return entity['pinned'] === true && entity['private'] !== true && typeof spaceId === 'string' && !folder.includes(':') ? `tabs:${spaceId}:${folder}` : null
    }
    case 'favorites': {
      const profile = typeof entity['profileId'] === 'string' ? entity['profileId'] : 'default'
      return profile.includes(':') ? null : `favorites:${profile}`
    }
  }
}

/** Where the members of each list of a collection sit in it, in list order: one walk of the collection, however many lists the patch orders. */
function positionsByList(collection: 'spaces' | 'folders' | 'tabs' | 'favorites', list: readonly Entity[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  list.forEach((entity, at) => {
    const key = groupKeyOf(collection, entity)
    if (key === null) return
    const positions = groups.get(key)
    if (positions === undefined) groups.set(key, [at])
    else positions.push(at)
  })
  return groups
}

/** The members of one list put in `ids` order, in the places the members held; a member that `ids` does not name goes after those it does, in its own order. */
function reorder(list: Entity[], positions: readonly number[], ids: readonly string[]): void {
  if (positions.length < 2) return
  const rank = new Map(ids.map((id, index) => [id, index]))
  const sorted = positions.map((at) => list[at] as Entity).sort((a, b) => (rank.get(a['id'] as string) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b['id'] as string) ?? Number.MAX_SAFE_INTEGER))
  positions.forEach((at, next) => void (list[at] = sorted[next] as Entity))
}

/** The state after a patch. A patch that changes nothing gives back the state it was given. */
export function applySyncPatch(state: SidebarState, patch: SyncPatch, ctx: Ctx): SidebarState {
  const draft: Record<string, unknown> = { ...state }
  const lists = (): Record<(typeof COLLECTION)[PatchKind], Entity[]> => draft as never
  const working = new Map<string, Working>()
  // A collection is copied once, the first time the patch touches it, and what the patch changes is changed in that copy.
  const open = (name: (typeof COLLECTION)[PatchKind]): Working => {
    let work = working.get(name)
    if (work === undefined) {
      const list = [...lists()[name]]
      const index = new Map<unknown, number>()
      list.forEach((entity, at) => void (index.has(entity['id']) || index.set(entity['id'], at)))
      work = { list, index }
      working.set(name, work)
      draft[name] = list
    }
    return work
  }
  for (const change of patch.upserts) upsert(open(COLLECTION[change.kind]), change, ctx.now)
  // An entity is removed when it is still as it was frozen; every entity of that id goes, as before, but the list is walked once.
  const removed = new Map<(typeof COLLECTION)[PatchKind], Set<unknown>>()
  for (const removal of patch.removals) {
    const name = COLLECTION[removal.kind]
    const work = open(name)
    const at = work.index.get(removal.id)
    const entity = at === undefined ? undefined : work.list[at]
    if (entity === undefined || !unchanged(entity, removal.expect, Object.keys(removal.expect))) continue
    const ids = removed.get(name) ?? new Set<unknown>()
    ids.add(removal.id)
    removed.set(name, ids)
  }
  for (const [name, ids] of removed) draft[name] = lists()[name].filter((one) => !ids.has(one['id']))
  const positions = new Map<string, Map<string, number[]>>()
  for (const [key, ids] of Object.entries(patch.order)) {
    const collection = collectionOf(key)
    if (collection === null || groupOf(key) === null || !Array.isArray(ids)) continue
    const list = (positions.has(collection) ? draft[collection] : (draft[collection] = [...(draft[collection] as Entity[])])) as Entity[]
    if (!positions.has(collection)) positions.set(collection, positionsByList(collection, list))
    reorder(list, positions.get(collection)?.get(key) ?? [], ids)
  }
  // A profile lists a page once among its favourites (the same rule as `favorite/add`): two devices that each added the same page under another id keep the first.
  const seen = new Set<string>()
  draft['favorites'] = (draft['favorites'] as Entity[]).filter((favorite) => {
    const key = `${typeof favorite['profileId'] === 'string' ? favorite['profileId'] : 'default'} ${String(favorite['url'])}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
  const settings = { ...state.settings } as Record<string, unknown>
  for (const key of SYNCED_SETTING_KEYS) if (Object.hasOwn(patch.settings, key)) settings[key] = patch.settings[key]
  draft['settings'] = settings
  return normalize(draft as unknown as SidebarState)
}

/** The action of the family; undefined for every other one. */
export function reduceSync(state: SidebarState, action: Action, ctx: Ctx): SidebarState | undefined {
  if (action.type !== 'sync/apply') return undefined
  return applySyncPatch(state, action.patch, ctx)
}
