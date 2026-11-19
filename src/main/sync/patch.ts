// What a session changes in the state (docs/synchronisation.md §8.5): the difference between the snapshot this device froze and the one the merge gave, as the patch the
// reducer applies (`sync/apply`, shared/sidebar-sync.ts). It carries, for each field it changes, what the field held when the snapshot was frozen: a field the person
// changed in the meantime keeps their change, and the next session sends it.
//
// What belongs to a space set aside (a locked one) is left out of the patch whatever the merge says: the merge took those spaces out of its three inputs, so it gives
// none of them back, and « not in the merged snapshot » would otherwise read as « deleted ».

import { sameJson } from '@shared/sync-canonical'
import type { PatchKind, PatchRemoval, PatchUpsert, SyncPatch } from '@shared/sidebar-sync'
import type { SyncEntity, SyncSnapshot } from '@shared/sync-snapshot'
import { SYNC_KINDS, isKind } from './field-classes'

const emptyPatch = (): SyncPatch => ({ upserts: [], removals: [], order: {}, settings: {} })

export const patchIsEmpty = (patch: SyncPatch): boolean => patch.upserts.length === 0 && patch.removals.length === 0 && Object.keys(patch.order).length === 0 && Object.keys(patch.settings).length === 0

/** Whether an entity belongs to a space that is set aside: the space itself, or what holds its `spaceId`. */
const setAside = (kind: string, id: string, entity: SyncEntity, withheld: ReadonlySet<string>): boolean => (kind === 'space' ? withheld.has(id) : typeof entity.fields['spaceId'] === 'string' && withheld.has(entity.fields['spaceId']))

/** The list keys that name a space set aside: its folders, its pinned tabs and its Today tabs (`today:<space>`, §27.3). */
const listOfSpaceAside = (key: string, withheld: ReadonlySet<string>): boolean => {
  const [head, space] = key.split(':')
  return (head === 'folders' || head === 'tabs' || head === 'today') && space !== undefined && withheld.has(space)
}

export function buildPatch(frozen: SyncSnapshot, merged: SyncSnapshot, withheld: ReadonlySet<string>): SyncPatch {
  const patch = emptyPatch()
  for (const kind of SYNC_KINDS) {
    const before = frozen.entities[kind] ?? {}
    const after = merged.entities[kind] ?? {}
    for (const [id, entity] of Object.entries(after)) {
      if (setAside(kind, id, entity, withheld)) continue
      const old = before[id]
      const change: PatchUpsert = { kind, id, create: old === undefined, fields: {}, remove: [], expect: {} }
      const names = new Set([...Object.keys(entity.fields), ...Object.keys(old?.fields ?? {})])
      for (const name of names) {
        const had = old?.fields[name]
        const has = entity.fields[name]
        if (old !== undefined && sameJson(had, has)) continue
        if (had !== undefined) change.expect[name] = had
        if (has === undefined) change.remove.push(name)
        else change.fields[name] = has
      }
      if (old === undefined || Object.keys(change.fields).length > 0 || change.remove.length > 0) patch.upserts.push(change)
    }
    for (const [id, entity] of Object.entries(before)) {
      if (after[id] !== undefined || setAside(kind, id, entity, withheld)) continue
      patch.removals.push({ kind, id, expect: { ...entity.fields } } satisfies PatchRemoval)
    }
  }
  for (const [key, ids] of Object.entries(merged.order)) {
    if (listOfSpaceAside(key, withheld) || sameJson(frozen.order[key], ids)) continue
    patch.order[key] = [...ids]
  }
  for (const [key, entity] of Object.entries(merged.entities['setting'] ?? {})) {
    const value = entity.fields['value']
    if (value !== undefined && !sameJson(frozen.entities['setting']?.[key]?.fields['value'], value)) patch.settings[key] = value
  }
  return patch
}

/** The kinds a patch can apply: a kind this version does not know crosses the merge and is not written into the state. */
export const appliesTo = (kind: string): kind is PatchKind => isKind(kind)
