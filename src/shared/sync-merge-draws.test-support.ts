// States nobody wrote, for the tests of the three-way merge (sync-merge.test.ts) and for the corpus that LuciumKit plays too
// (ios/Contracts/sync-merge-draws.json, written by sync-merge.test.ts): a common ancestor, then two devices that edit it as people do (change a field, move a
// tab, delete, add, reorder), and sometimes no ancestor at all. A seeded generator, so that a failure can be replayed.
//
// Test support only: the application never imports this file.
import type { JsonValue } from './sync-canonical'
import { emptySnapshot, type SyncEntity, type SyncSnapshot } from './sync-snapshot'

/** mulberry32: the same states at every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Draw {
  base: SyncSnapshot | null
  local: SyncSnapshot
  remote: SyncSnapshot
  withheld: string[]
}

type Rand = () => number
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
const chance = (rand: Rand, p: number): boolean => rand() < p

/** A mark in the form of §9.2, from a small set of times and counters so that equal times (settled by the device id) happen. */
function markOf(rand: Rand, device: string): string {
  const ms = 1790000000000 + 2 + Math.floor(rand() * 8)
  return `${String(ms).padStart(13, '0')}-${Math.floor(rand() * 2).toString(16).padStart(4, '0')}-${device}`
}

/** Fisher-Yates, so that the order does not depend on how an engine sorts with a comparator that answers at random. */
function shuffle<T>(rand: Rand, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function entity(fields: Record<string, JsonValue>, mark: string): SyncEntity {
  return { fields, stamps: Object.fromEntries(Object.keys(fields).map((name) => [name, mark])) }
}

const NAMES = ['Travail', 'Maison', 'Lecture', 'Meetings', 'Projets', '日本', '😀']
const URLS = ['https://a.example/', 'https://b.example/x', 'https://c.example/?q=1']

function listKey(kind: string, fields: Record<string, JsonValue>): string | null {
  const str = (name: string): string => (typeof fields[name] === 'string' ? (fields[name] as string) : '-')
  if (kind === 'space') return 'spaces'
  if (kind === 'folder') return `folders:${str('spaceId')}:${str('parentId')}`
  if (kind === 'tab') return `tabs:${str('spaceId')}:${str('folderId')}`
  if (kind === 'favorite') return `favorites:${str('profileId')}`
  return null
}

/** The lists of a snapshot, built from its entities (in id order) and then, sometimes, shuffled. */
function withOrder(rand: Rand, snapshot: SyncSnapshot, mark: string): SyncSnapshot {
  const lists = new Map<string, string[]>()
  for (const [kind, byId] of Object.entries(snapshot.entities)) {
    for (const [id, e] of Object.entries(byId)) {
      const key = listKey(kind, e.fields)
      if (key !== null) lists.set(key, [...(lists.get(key) ?? []), id])
    }
  }
  for (const [key, ids] of lists) {
    snapshot.order[key] = chance(rand, 0.3) ? shuffle(rand, ids) : ids
    if (chance(rand, 0.5)) snapshot.orderStamps[key] = mark
  }
  return snapshot
}

/** The common ancestor: spaces, folders (a parent is always an earlier folder of the same space), pinned tabs, favourites, settings, an archive. */
function ancestor(rand: Rand): SyncSnapshot {
  const mark = markOf(rand, 'mac')
  const snapshot = emptySnapshot()
  const put = (kind: string, id: string, e: SyncEntity): void => {
    ;(snapshot.entities[kind] ??= {})[id] = e
  }
  const spaces = ['s1', 's2', 's3'].filter(() => chance(rand, 0.85))
  if (spaces.length === 0) spaces.push('s1')
  for (const id of spaces) put('space', id, entity({ name: pick(rand, NAMES), emoji: pick(rand, ['📁', '🏠']) }, mark))
  const folders: { id: string; spaceId: string }[] = []
  for (const id of ['f1', 'f2', 'f3', 'f4'].filter(() => chance(rand, 0.6))) {
    const spaceId = pick(rand, spaces)
    const fields: Record<string, JsonValue> = { spaceId, name: pick(rand, NAMES) }
    const parents = folders.filter((f) => f.spaceId === spaceId)
    if (parents.length > 0 && chance(rand, 0.4)) fields['parentId'] = (pick(rand, parents) as { id: string }).id
    put('folder', id, entity(fields, mark))
    folders.push({ id, spaceId })
  }
  for (const id of ['t1', 't2', 't3', 't4', 't5', 't6'].filter(() => chance(rand, 0.65))) {
    const spaceId = pick(rand, spaces)
    const fields: Record<string, JsonValue> = { spaceId, pinned: true, anchorUrl: pick(rand, URLS) }
    const inSpace = folders.filter((f) => f.spaceId === spaceId)
    if (inSpace.length > 0 && chance(rand, 0.4)) fields['folderId'] = (pick(rand, inSpace) as { id: string }).id
    if (chance(rand, 0.2)) fields['future'] = pick(rand, [1, 'x', { z: [1, 2] }, null])
    put('tab', id, entity(fields, mark))
  }
  for (const id of ['v1', 'v2'].filter(() => chance(rand, 0.6))) put('favorite', id, entity({ url: pick(rand, URLS), title: pick(rand, NAMES), profileId: 'p1' }, mark))
  for (const id of ['a1', 'a2'].filter(() => chance(rand, 0.4))) put('archived', id, entity({ spaceId: pick(rand, spaces), url: pick(rand, URLS), title: pick(rand, NAMES), archivedAt: 1790000000000 }, mark))
  for (const id of ['httpsUpgrade', 'sendGpc'].filter(() => chance(rand, 0.5))) put('setting', id, entity({ value: chance(rand, 0.5) }, mark))
  if (chance(rand, 0.15)) put('widget', 'w1', entity({ x: pick(rand, [1, 2]) }, mark)) // a kind this version does not know
  return withOrder(rand, snapshot, mark)
}

const ALL_KINDS = ['space', 'folder', 'tab', 'favorite', 'archived', 'setting', 'widget']

/** What a person does on one device between two synchronisations, on a copy of the ancestor. */
function edit(rand: Rand, from: SyncSnapshot, device: string): SyncSnapshot {
  const s = clone(from)
  const mark = (): string => markOf(rand, device)
  const ids = (kind: string): string[] => Object.keys(s.entities[kind] ?? {})
  const dropFromLists = (id: string): void => {
    for (const [key, list] of Object.entries(s.order)) s.order[key] = list.filter((x) => x !== id)
  }
  const remove = (kind: string, id: string): void => {
    const e = (s.entities[kind] ?? {})[id]
    if (e === undefined) return
    delete (s.entities[kind] as Record<string, SyncEntity>)[id]
    ;(s.tombstones[kind] ??= {})[id] = mark()
    dropFromLists(id)
    // A device that deletes a space or a folder takes what is in it (the application does): no reference is left pointing at nothing on one device.
    if (kind === 'space') for (const k of ['folder', 'tab', 'archived']) for (const child of ids(k)) if ((s.entities[k] as Record<string, SyncEntity>)[child]?.fields['spaceId'] === id) remove(k, child)
    if (kind === 'folder') {
      for (const k of ['tab', 'folder']) for (const child of ids(k)) {
        const c = (s.entities[k] as Record<string, SyncEntity>)[child]
        if (c !== undefined && c.fields[k === 'tab' ? 'folderId' : 'parentId'] === id) remove(k, child)
      }
    }
  }
  const touch = (kind: string, id: string, name: string, value: JsonValue): void => {
    const e = (s.entities[kind] as Record<string, SyncEntity>)[id] as SyncEntity
    e.fields[name] = value
    e.stamps[name] = mark()
  }
  const steps = 1 + Math.floor(rand() * 4)
  for (let i = 0; i < steps; i++) {
    const kind = pick(rand, ALL_KINDS)
    const known = ids(kind)
    const action = pick(rand, ['change', 'change', 'delete', 'move', 'add', 'reorder', 'unknown', 'unset'] as const)
    if (action === 'add') {
      const id = `${device}-${Math.floor(rand() * 4)}-${kind}`
      if (kind === 'space') s.entities['space'] = { ...s.entities['space'], [id]: entity({ name: pick(rand, NAMES) }, mark()) }
      else if (kind === 'widget' || kind === 'setting' || kind === 'favorite') (s.entities[kind] ??= {})[id] = entity(kind === 'favorite' ? { url: pick(rand, URLS), title: pick(rand, NAMES), profileId: 'p1' } : { value: 1 }, mark())
      else {
        const spaces = ids('space')
        if (spaces.length === 0) continue
        const spaceId = pick(rand, spaces)
        const fields: Record<string, JsonValue> = kind === 'archived' ? { spaceId, url: pick(rand, URLS), title: pick(rand, NAMES), archivedAt: 1790000000001 } : kind === 'folder' ? { spaceId, name: pick(rand, NAMES) } : { spaceId, pinned: true, anchorUrl: pick(rand, URLS) }
        const folders = ids('folder').filter((f) => (s.entities['folder'] as Record<string, SyncEntity>)[f]?.fields['spaceId'] === spaceId)
        if (kind === 'tab' && folders.length > 0 && chance(rand, 0.5)) fields['folderId'] = pick(rand, folders)
        ;(s.entities[kind] ??= {})[id] = entity(fields, mark())
      }
      const added = (s.entities[kind] as Record<string, SyncEntity>)[id] as SyncEntity
      const key = listKey(kind, added.fields)
      if (key !== null) (s.order[key] ??= []).push(id)
      continue
    }
    if (known.length === 0) continue
    const id = pick(rand, known)
    const e = (s.entities[kind] as Record<string, SyncEntity>)[id] as SyncEntity
    if (action === 'delete') remove(kind, id)
    else if (action === 'change') {
      const names = Object.keys(e.fields).filter((n) => !['spaceId', 'parentId', 'folderId', 'profileId'].includes(n))
      if (names.length > 0) touch(kind, id, pick(rand, names), pick(rand, ['A', 'B', 'C', true, false, 3, NAMES[0] as string]))
    } else if (action === 'move' && kind === 'tab') {
      const spaceId = e.fields['spaceId']
      const folders = ids('folder').filter((f) => (s.entities['folder'] as Record<string, SyncEntity>)[f]?.fields['spaceId'] === spaceId)
      const oldKey = listKey('tab', e.fields)
      if (chance(rand, 0.3) || folders.length === 0) {
        delete e.fields['folderId']
        e.stamps['folderId'] = mark()
      } else touch('tab', id, 'folderId', pick(rand, folders))
      if (oldKey !== null) s.order[oldKey] = (s.order[oldKey] ?? []).filter((x) => x !== id)
      const newKey = listKey('tab', e.fields)
      if (newKey !== null) (s.order[newKey] ??= []).push(id)
    } else if (action === 'reorder') {
      const keys = Object.keys(s.order).filter((k) => (s.order[k] as string[]).length > 1)
      if (keys.length > 0) {
        const key = pick(rand, keys)
        s.order[key] = shuffle(rand, s.order[key] as string[])
        s.orderStamps[key] = mark()
      }
    } else if (action === 'unknown') touch(kind, id, 'future', pick(rand, [1, 2, 'y', { z: 1 }, [1, [2]]]))
    else if (action === 'unset') {
      const names = Object.keys(e.fields).filter((n) => !['spaceId', 'pinned', 'name'].includes(n))
      if (names.length > 0) {
        const name = pick(rand, names)
        delete e.fields[name]
        e.stamps[name] = mark()
      }
    }
  }
  for (const kind of Object.keys(s.entities)) if (Object.keys(s.entities[kind] as object).length === 0) delete s.entities[kind]
  for (const key of Object.keys(s.order)) if ((s.order[key] as string[]).length === 0) delete s.order[key]
  return s
}

/** One draw: an ancestor and two devices (the base is missing one time in five, as at a first exchange), and sometimes a space set aside. */
export function draw(rand: Rand): Draw {
  const base = ancestor(rand)
  const local = edit(rand, base, 'mac')
  const remote = edit(rand, base, 'phone')
  const spaces = Object.keys(base.entities['space'] ?? {})
  const withheld = chance(rand, 0.15) && spaces.length > 0 ? [pick(rand, spaces)] : []
  return { base: chance(rand, 0.2) ? null : base, local, remote, withheld }
}

export const draws = (seed: number, count: number): Draw[] => {
  const rand = seeded(seed)
  return Array.from({ length: count }, () => draw(rand))
}
