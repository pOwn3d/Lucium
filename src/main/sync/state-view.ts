// The state of the Mac as the synchronisation reads it (docs/synchronisation.md §8.3, §10): the entities with their synchronised fields and the order of their lists, then
// the snapshot a session freezes from them with the marks the book gave.
//
//   trackedViewOf   everything that is synchronised, in every category, for the book of marks to follow;
//   snapshotOf      what one session sends: the categories both devices ticked, without the spaces set aside (§18 [Q4], the locked ones), without what the person must not
//                   see sent (a private tab, a tab that is not pinned), with the seed fields of the entities the other device does not have yet.
//
// Nothing here reads the disk or the clock; both are pure functions of what they are given.

import type { SidebarState } from '@shared/model'
import type { SyncCategory } from '@shared/sync-ipc'
import { ZERO_STAMP, type SyncEntity, type SyncFields, type SyncSnapshot } from '@shared/sync-snapshot'
import { ARCHIVE_PER_SPACE_SENT, FIELD_CLASSES, SYNCED_SETTINGS, isKind, type EntityKind } from './field-classes'
import { cutBytes } from '@shared/state-clean'
import { MAX_OPEN_TABS, MAX_OPEN_TAB_TITLE_BYTES, MAX_OPEN_TAB_URL_BYTES } from './limits'
import { earlier, listKindOf, type MarkBook, type TrackedView } from './marks'

type Entity = object

const record = (entity: Entity): Record<string, unknown> => entity as Record<string, unknown>

/** The fields the book follows: all but the identifier, the seeds, the local ones and what is `undefined` (a field that is not there is not a field). */
function followedFields(kind: EntityKind, entity: Entity): Record<string, unknown> {
  const classes = FIELD_CLASSES[kind]
  return Object.fromEntries(Object.entries(record(entity)).filter(([name, value]) => name !== 'id' && value !== undefined && !classes.local.includes(name) && !classes.seed.includes(name)))
}

/** The seed fields of an entity: copied when it is created on the other device, then local. */
function seedFields(kind: EntityKind, entity: Entity): Record<string, unknown> {
  return Object.fromEntries(FIELD_CLASSES[kind].seed.flatMap((name) => (record(entity)[name] !== undefined ? [[name, record(entity)[name]]] : [])))
}

/** Whether the book follows a field of an entity of this kind: what `adopt` is told. Fields of a kind this version does not know are followed as they come. */
export const follows = (kind: string, field: string): boolean => {
  if (kind === 'setting') return field === 'value'
  if (!isKind(kind)) return true
  const classes = FIELD_CLASSES[kind]
  return field !== 'id' && !classes.local.includes(field) && !classes.seed.includes(field)
}

const DASH = '-'

/** The key of the list a folder, a pinned tab or a favourite is in (§11.4). */
const folderList = (spaceId: string, parentId: string | undefined): string => `folders:${spaceId}:${parentId ?? DASH}`
const tabList = (spaceId: string, folderId: string | undefined): string => `tabs:${spaceId}:${folderId ?? DASH}`
const favoriteList = (profileId: string | undefined): string => `favorites:${profileId ?? 'default'}`

/** The pinned tabs that are synchronised: pinned, and never private. */
const isSyncedTab = (tab: SidebarState['tabs'][number]): boolean => tab.pinned && tab.private !== true

/** The archived tabs that are sent: the latest `ARCHIVE_PER_SPACE_SENT` of each space. */
function archivedSent(state: SidebarState): SidebarState['archive'] {
  const kept = new Map<string, number>()
  const newestFirst = [...state.archive].sort((a, b) => b.archivedAt - a.archivedAt || (a.id < b.id ? -1 : 1))
  return newestFirst.filter((entry) => {
    const count = (kept.get(entry.spaceId) ?? 0) + 1
    kept.set(entry.spaceId, count)
    return count <= ARCHIVE_PER_SPACE_SENT
  })
}

export function trackedViewOf(state: SidebarState): TrackedView {
  const entities: TrackedView['entities'] = { space: {}, folder: {}, tab: {}, favorite: {}, archived: {}, setting: {} }
  const order: TrackedView['order'] = { spaces: state.spaces.map((space) => space.id) }
  for (const space of state.spaces) (entities['space'] as Record<string, Record<string, unknown>>)[space.id] = followedFields('space', space)
  for (const folder of state.folders) {
    ;(entities['folder'] as Record<string, Record<string, unknown>>)[folder.id] = followedFields('folder', folder)
    ;(order[folderList(folder.spaceId, folder.parentId)] ??= []).push(folder.id)
  }
  for (const tab of state.tabs.filter(isSyncedTab)) {
    ;(entities['tab'] as Record<string, Record<string, unknown>>)[tab.id] = followedFields('tab', tab)
    ;(order[tabList(tab.spaceId, tab.folderId)] ??= []).push(tab.id)
  }
  for (const favorite of state.favorites) {
    ;(entities['favorite'] as Record<string, Record<string, unknown>>)[favorite.id] = followedFields('favorite', favorite)
    ;(order[favoriteList(favorite.profileId)] ??= []).push(favorite.id)
  }
  for (const entry of archivedSent(state)) (entities['archived'] as Record<string, Record<string, unknown>>)[entry.id] = followedFields('archived', entry)
  const settings = state.settings as unknown as Record<string, unknown>
  for (const key of SYNCED_SETTINGS) if (settings[key] !== undefined) (entities['setting'] as Record<string, Record<string, unknown>>)[key] = { value: settings[key] }
  return { entities, order }
}

export interface SnapshotOptions {
  /** The categories both devices ticked. */
  categories: ReadonlySet<SyncCategory>
  /** The spaces set aside for this session (the locked ones): nothing of them is sent. */
  withheld: ReadonlySet<string>
  /** The base of this device with that one: the entities it does not hold are new to the other device, and carry their seed fields. */
  base: SyncSnapshot | null
}

const STRUCTURE_KINDS: readonly string[] = ['space', 'folder', 'tab', 'favorite']

/** The kinds a session exchanges, for the categories both devices ticked (`structure`, `archive`, `settings`: what `snapshotOf` sends). */
const kindsOfCategories = (categories: ReadonlySet<SyncCategory>): ReadonlySet<string> =>
  new Set<string>([...(categories.has('structure') ? STRUCTURE_KINDS : []), ...(categories.has('archive') ? ['archived'] : []), ...(categories.has('settings') ? ['setting'] : [])])

/** Whether a session with these categories exchanges the kind: the kinds of the categories, and the kinds this version does not know (they cross whatever is ticked, §11.6). */
export const kindIsExchanged = (kind: string, categories: ReadonlySet<SyncCategory>): boolean => kindsOfCategories(categories).has(kind) || (!isKind(kind) && kind !== 'setting')

/**
 * What a device sent, cut down to the kinds this session exchanges (§5 [Q2], §11.6): an honest device sends nothing of a category that is not common, so what is left out
 * here came from one that does not keep to them, and it is not applied (the settings of privacy, the archive, the spaces of a device whose structure is not ticked here).
 * The kinds this version does not know cross whatever is ticked, as they do in `kindIsExchanged`; a list is of the kind it orders.
 */
export function onlyExchanged(snapshot: SyncSnapshot, categories: ReadonlySet<SyncCategory>): { snapshot: SyncSnapshot; refused: Array<{ kind: string; id: string; reason: 'not-synced' }> } {
  const refused: Array<{ kind: string; id: string; reason: 'not-synced' }> = []
  const kindKept = (kind: string): boolean => kindIsExchanged(kind, categories)
  const listKept = (key: string): boolean => {
    const kind = listKindOf(key)
    return kind === null || kindKept(kind)
  }
  const entities: SyncSnapshot['entities'] = {}
  for (const [kind, byId] of Object.entries(snapshot.entities)) {
    if (kindKept(kind)) entities[kind] = byId
    else for (const id of Object.keys(byId)) refused.push({ kind, id, reason: 'not-synced' })
  }
  const tombstones: SyncSnapshot['tombstones'] = {}
  for (const [kind, byId] of Object.entries(snapshot.tombstones)) {
    if (kindKept(kind)) tombstones[kind] = byId
    else for (const id of Object.keys(byId)) refused.push({ kind: 'tombstone', id: `${kind}/${id}`, reason: 'not-synced' })
  }
  const order: SyncSnapshot['order'] = {}
  for (const [key, ids] of Object.entries(snapshot.order)) {
    if (listKept(key)) order[key] = ids
    else refused.push({ kind: 'order', id: key, reason: 'not-synced' })
  }
  const orderStamps: SyncSnapshot['orderStamps'] = {}
  for (const [key, stamp] of Object.entries(snapshot.orderStamps)) if (listKept(key)) orderStamps[key] = stamp
  return { snapshot: { entities, tombstones, order, orderStamps }, refused }
}

/** The snapshot a session freezes and sends. The marks must be up to date (`MarkBook.update`) before it is made. */
export function snapshotOf(state: SidebarState, marks: MarkBook, options: SnapshotOptions): SyncSnapshot {
  const view = trackedViewOf(state)
  const kinds = new Set<string>(kindsOfCategories(options.categories))
  const withheldSpace = (kind: string, fields: Record<string, unknown>, id: string): boolean => (kind === 'space' ? options.withheld.has(id) : typeof fields['spaceId'] === 'string' && options.withheld.has(fields['spaceId']))
  const byId: Record<string, Record<string, Entity>> = {
    space: Object.fromEntries(state.spaces.map((one) => [one.id, one])),
    folder: Object.fromEntries(state.folders.map((one) => [one.id, one])),
    tab: Object.fromEntries(state.tabs.filter(isSyncedTab).map((one) => [one.id, one])),
    favorite: Object.fromEntries(state.favorites.map((one) => [one.id, one])),
    archived: Object.fromEntries(archivedSent(state).map((one) => [one.id, one]))
  }
  const entities: SyncSnapshot['entities'] = {}
  for (const kind of kinds) {
    for (const [id, fields] of Object.entries(view.entities[kind] ?? {})) {
      if (withheldSpace(kind, fields, id)) continue
      const stamps = marks.stampsOf(kind, id)
      const entity: SyncEntity = { fields: fields as SyncFields, stamps }
      // An entity the other device may not have: its seed fields go with it, marked with the earliest mark it has, so that no later change of its own is older than them.
      if (isKind(kind) && (options.base === null || options.base.entities[kind]?.[id] === undefined)) {
        const seeds = seedFields(kind, byId[kind]?.[id] as Entity)
        const first = Object.values(stamps).reduce(earlier, Object.values(stamps)[0] ?? ZERO_STAMP)
        for (const [name, value] of Object.entries(seeds)) {
          entity.fields[name] = value as never
          entity.stamps[name] = first
        }
      }
      ;(entities[kind] ??= {})[id] = entity
    }
  }
  const order: SyncSnapshot['order'] = {}
  const orderStamps: SyncSnapshot['orderStamps'] = {}
  for (const [key, ids] of Object.entries(view.order)) {
    const [head, space] = key.split(':')
    const kind = head === 'spaces' ? 'space' : head === 'folders' ? 'folder' : head === 'tabs' ? 'tab' : 'favorite'
    if (!kinds.has(kind) || (space !== undefined && head !== 'favorites' && options.withheld.has(space))) continue
    order[key] = ids.filter((id) => entities[kind]?.[id] !== undefined)
    orderStamps[key] = marks.orderStampOf(key)
  }
  const tombstones: SyncSnapshot['tombstones'] = {}
  for (const [kind, byIds] of Object.entries(marks.tombstonesOf())) if (kinds.has(kind) || !isKind(kind) && kind !== 'setting') tombstones[kind] = byIds
  return { entities, tombstones, order, orderStamps }
}

/** The ids of the spaces the person has locked and has not opened: a session sets them aside (§18 [Q4]). */
export const withheldSpaces = (state: SidebarState, isLocked: (spaceId: string) => boolean): string[] => state.spaces.filter((space) => isLocked(space.id)).map((space) => space.id)

/** A base the way it is kept: the seed fields are taken off, so that the next session does not see them as changes (they are copied once, when an entity is created). */
export function baseOf(merged: SyncSnapshot): SyncSnapshot {
  const entities: SyncSnapshot['entities'] = {}
  for (const [kind, byId] of Object.entries(merged.entities)) {
    for (const [id, entity] of Object.entries(byId)) {
      const keep = (name: string): boolean => follows(kind, name)
      ;(entities[kind] ??= {})[id] = { fields: Object.fromEntries(Object.entries(entity.fields).filter(([name]) => keep(name))), stamps: Object.fromEntries(Object.entries(entity.stamps).filter(([name]) => keep(name))) }
    }
  }
  return { ...merged, entities }
}

/** The tabs announced to the other device when « Onglets ouverts » is common (§10.4): web pages the person has open, never a private tab, never a tab of a locked space, the latest 200. */
export function openTabsOf(state: SidebarState, isSpaceLocked: (spaceId: string) => boolean): Array<{ id: string; spaceId: string; url: string; title: string; lastActiveAt: number }> {
  return state.tabs
    .filter((tab) => tab.private !== true && /^https?:\/\//i.test(tab.url) && !isSpaceLocked(tab.spaceId))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_OPEN_TABS)
    .map((tab) => ({ id: tab.id, spaceId: tab.spaceId, url: cutBytes(tab.url, MAX_OPEN_TAB_URL_BYTES), title: cutBytes(tab.title, MAX_OPEN_TAB_TITLE_BYTES), lastActiveAt: Math.max(0, Math.trunc(tab.lastActiveAt)) }))
}
