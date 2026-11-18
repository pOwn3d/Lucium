// The shared vectors of the state the synchronisation reads and of the patch it writes (ios/Contracts/sync-state-vectors.json): the Mac's own code gives the expected
// values, LuciumKit (SyncStateTests.swift) plays the same file against its Swift twin. Change one side and the other fails.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SidebarState } from '@shared/model'
import type { SyncCategory } from '@shared/sync-ipc'
import type { SyncPatch } from '@shared/sidebar-sync'
import type { SyncSnapshot } from '@shared/sync-snapshot'
import { MarkBook } from './marks'
import { buildPatch } from './patch'
import { snapshotOf, trackedViewOf } from './state-view'

const NOW = 1_790_000_000_000

interface ViewVector {
  name: string
  state: unknown
  categories: SyncCategory[]
  withheld: string[]
  base: SyncSnapshot | null
  expect: { entities: Record<string, Record<string, Record<string, unknown>>>; order: Record<string, string[]> }
}

interface PatchVector {
  name: string
  frozen: SyncSnapshot
  merged: SyncSnapshot
  withheld: string[]
  expect: SyncPatch
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../../ios/Contracts/sync-state-vectors.json'), 'utf8')) as { view: ViewVector[]; patch: PatchVector[] }

describe('the state the synchronisation reads: the vectors shared with the iPhone', () => {
  it('has the cases the iPhone plays', () => {
    expect(vectors.view.length).toBeGreaterThanOrEqual(9)
  })

  it.each(vectors.view)('$name', (vector) => {
    const state = vector.state as SidebarState
    const marks = new MarkBook('mac')
    marks.update(trackedViewOf(state), NOW)
    const snapshot = snapshotOf(state, marks, { categories: new Set(vector.categories), withheld: new Set(vector.withheld), base: vector.base })
    const entities: Record<string, Record<string, unknown>> = {}
    for (const [kind, byId] of Object.entries(snapshot.entities)) {
      for (const [id, entity] of Object.entries(byId)) {
        ;(entities[kind] ??= {})[id] = entity.fields
        // A fresh book gives one mark to each field it follows, and the seeds go with the earliest of them: the marks name the fields, which is all the vector holds of them.
        expect(Object.keys(entity.stamps).sort(), `${kind}/${id}`).toEqual(Object.keys(entity.fields).sort())
      }
    }
    expect(entities).toEqual(vector.expect.entities)
    expect(snapshot.order).toEqual(vector.expect.order)
    expect(Object.keys(snapshot.orderStamps).sort()).toEqual(Object.keys(snapshot.order).sort())
    expect(snapshot.tombstones).toEqual({})
  })
})

const normalizedPatch = (patch: SyncPatch): unknown => ({
  ...patch,
  upserts: [...patch.upserts].map((one) => ({ ...one, remove: [...one.remove].sort() })).sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1)),
  removals: [...patch.removals].sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1))
})

describe('the patch a session writes: the vectors shared with the iPhone', () => {
  it('has the cases the iPhone plays', () => {
    expect(vectors.patch.length).toBeGreaterThanOrEqual(10)
  })

  it.each(vectors.patch)('$name', (vector) => {
    expect(normalizedPatch(buildPatch(vector.frozen, vector.merged, new Set(vector.withheld)))).toEqual(normalizedPatch(vector.expect))
  })
})
