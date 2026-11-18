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

function upsert(list: Entity[], change: PatchUpsert, now: number): Entity[] {
  const at = list.findIndex((entity) => entity['id'] === change.id)
  if (at < 0) {
    if (!change.create) return list
    const entity = made(change.kind, change.id, now)
    for (const [name, value] of Object.entries(change.fields)) if (!UNSAFE.has(name) && name !== 'id') entity[name] = value
    // A pinned tab that comes back without the page it was on (the other device kept it, this one deleted it and the merge gave it back: its seed fields are sent only with
    // a new entity) opens at the page it returns to.
    if (change.kind === 'tab' && entity['url'] === '' && typeof entity['anchorUrl'] === 'string') {
      entity['url'] = entity['anchorUrl']
      if (entity['title'] === '') entity['title'] = typeof entity['customTitle'] === 'string' && entity['customTitle'] !== '' ? entity['customTitle'] : entity['anchorUrl']
    }
    return [...list, entity]
  }
  const entity = { ...(list[at] as Entity) }
  for (const [name, value] of Object.entries(change.fields)) if (!UNSAFE.has(name) && name !== 'id' && unchanged(entity, change.expect, [name])) entity[name] = value
  for (const name of change.remove) if (!UNSAFE.has(name) && name !== 'id' && unchanged(entity, change.expect, [name])) delete entity[name]
  return list.map((one, index) => (index === at ? entity : one))
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

/** The members of one list put in `ids` order, in the places the members held; a member that `ids` does not name goes after those it does, in its own order. */
function reordered(list: Entity[], member: (entity: Entity) => boolean, ids: readonly string[]): Entity[] {
  const members = list.filter(member)
  if (members.length < 2) return list
  const rank = new Map(ids.map((id, index) => [id, index]))
  const sorted = [...members].sort((a, b) => (rank.get(a['id'] as string) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b['id'] as string) ?? Number.MAX_SAFE_INTEGER))
  let next = 0
  return list.map((entity) => (member(entity) ? (sorted[next++] as Entity) : entity))
}

/** The state after a patch. A patch that changes nothing gives back the state it was given. */
export function applySyncPatch(state: SidebarState, patch: SyncPatch, ctx: Ctx): SidebarState {
  const draft: Record<string, unknown> = { ...state }
  const lists = (): Record<(typeof COLLECTION)[PatchKind], Entity[]> => draft as never
  for (const change of patch.upserts) {
    const name = COLLECTION[change.kind]
    draft[name] = upsert(lists()[name], change, ctx.now)
  }
  for (const removal of patch.removals) {
    const name = COLLECTION[removal.kind]
    const entity = lists()[name].find((one) => one['id'] === removal.id)
    if (entity !== undefined && unchanged(entity, removal.expect, Object.keys(removal.expect))) draft[name] = lists()[name].filter((one) => one['id'] !== removal.id)
  }
  for (const [key, ids] of Object.entries(patch.order)) {
    const collection = collectionOf(key)
    const member = groupOf(key)
    if (collection === null || member === null || !Array.isArray(ids)) continue
    draft[collection] = reordered(draft[collection] as Entity[], (entity) => member(collection, entity), ids)
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
