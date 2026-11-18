// `sync/apply` after it was made linear (card 448): the same state as the slow reducer it replaced, on patches drawn at random, and fast on a large one.
import { describe, expect, it } from 'vitest'
import { applySyncPatch, type PatchKind, type SyncPatch } from '@shared/sidebar-sync'
import { referenceApplySyncPatch } from '@shared/sidebar-sync.reference.test-support'
import { NOW, stateOf } from './session-rig.test-support'

const ctx = { now: NOW, newId: () => 'unused' }

/** A small deterministic generator (mulberry32): a failure names its seed and is replayed by it. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function drawn(seed: number): { state: ReturnType<typeof stateOf>; patch: SyncPatch } {
  const r = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)] as T
  const spaces = ['sp-a', 'sp-b', 'sp-c'].slice(0, 1 + Math.floor(r() * 3)).map((id) => ({ id, name: id }))
  const folders = Array.from({ length: Math.floor(r() * 6) }, (_, n) => ({ id: `fo-${n}`, spaceId: pick(spaces).id, ...(n > 0 && r() < 0.4 ? { parentId: `fo-${n - 1}` } : {}) }))
  const tabs = Array.from({ length: Math.floor(r() * 14) }, (_, n) => ({ id: `tab-${n}`, spaceId: pick(spaces).id, pinned: r() < 0.8, ...(r() < 0.15 ? { private: true } : {}), ...(r() < 0.3 && folders.length > 0 ? { folderId: pick(folders).id } : {}) }))
  const favorites = Array.from({ length: Math.floor(r() * 6) }, (_, n) => ({ id: `fav-${n}`, profileId: pick(['default', 'work']) }))
  const state = stateOf({ spaces, folders: folders as never, tabs: tabs as never, favorites: favorites as never })
  const existing: Array<{ kind: PatchKind; id: string; fields: Record<string, unknown> }> = [
    ...state.spaces.map((one) => ({ kind: 'space' as const, id: one.id, fields: one as unknown as Record<string, unknown> })),
    ...state.folders.map((one) => ({ kind: 'folder' as const, id: one.id, fields: one as unknown as Record<string, unknown> })),
    ...state.tabs.map((one) => ({ kind: 'tab' as const, id: one.id, fields: one as unknown as Record<string, unknown> })),
    ...state.favorites.map((one) => ({ kind: 'favorite' as const, id: one.id, fields: one as unknown as Record<string, unknown> }))
  ]
  const patch: SyncPatch = { upserts: [], removals: [], order: {}, settings: {} }
  const changes = 1 + Math.floor(r() * 10)
  for (let n = 0; n < changes; n++) {
    const roll = r()
    if (roll < 0.3 && existing.length > 0) {
      const target = pick(existing)
      const field = pick(['name', 'customTitle', 'folderId', 'parentId', 'profileId', 'url', 'title', 'hideHeader'])
      const before = target.fields[field]
      patch.upserts.push({ kind: target.kind, id: target.id, create: false, fields: r() < 0.7 ? { [field]: `v${n}` } : {}, remove: r() < 0.3 ? [field] : [], expect: r() < 0.8 && before !== undefined ? { [field]: before } : {} })
    } else if (roll < 0.55) {
      const kind = pick(['tab', 'folder', 'favorite', 'space'] as const)
      const id = r() < 0.2 && existing.length > 0 ? pick(existing).id : `new-${kind}-${n}`
      const fields: Record<string, unknown> =
        kind === 'tab' ? { spaceId: pick(spaces).id, pinned: true, anchorUrl: `https://n${n}.example/`, ...(r() < 0.4 && folders.length > 0 ? { folderId: pick(folders).id } : {}) } : kind === 'folder' ? { spaceId: pick(spaces).id, name: `F${n}`, ...(r() < 0.3 && folders.length > 0 ? { parentId: pick(folders).id } : {}) } : kind === 'favorite' ? { url: `https://f${n}.example/`, title: `Fav ${n}`, profileId: pick(['default', 'work']) } : { name: `S${n}` }
      patch.upserts.push({ kind, id, create: true, fields, remove: [], expect: {} })
    } else if (roll < 0.75 && existing.length > 0) {
      const target = pick(existing)
      patch.removals.push({ kind: target.kind, id: r() < 0.9 ? target.id : 'nothing-here', expect: r() < 0.8 ? Object.fromEntries(Object.entries(target.fields).filter(([name]) => ['name', 'spaceId', 'url'].includes(name))) : { name: 'changed meanwhile' } })
    } else {
      const lists = ['spaces', ...spaces.flatMap((space) => ['folders', 'tabs'].flatMap((head) => [`${head}:${space.id}:-`, ...folders.map((folder) => `${head}:${space.id}:${folder.id}`)])), 'favorites:default', 'favorites:work', 'tabs:nowhere:-', 'folders:sp-a:a:b', 'favorites:a:b', 'elsewhere', 'spaces:x']
      const ids = [...existing.map((one) => one.id), 'unknown-id'].filter(() => r() < 0.7)
      for (let at = ids.length - 1; at > 0; at--) {
        const swap = Math.floor(r() * (at + 1))
        ;[ids[at], ids[swap]] = [ids[swap] as string, ids[at] as string]
      }
      patch.order[pick(lists)] = ids
    }
  }
  if (r() < 0.3) patch.settings = { sendGpc: r() < 0.5, autoArchiveHours: 5 }
  return { state, patch }
}

describe('sync/apply: the linear reducer against the slow one it replaced', () => {
  it('gives the same state on four hundred patches drawn at random, and does not change the state it is given', () => {
    let touched = 0
    for (let seed = 1; seed <= 400; seed++) {
      const { state, patch } = drawn(seed)
      const before = JSON.stringify(state)
      const fast = applySyncPatch(state, patch, ctx)
      expect(JSON.stringify(state), `seed ${seed}: the state it was given`).toBe(before)
      expect(fast, `seed ${seed}`).toEqual(referenceApplySyncPatch(state, patch, ctx))
      if (JSON.stringify(fast) !== before) touched++
    }
    // The draws must change things, or the comparison proves nothing.
    expect(touched).toBeGreaterThan(300)
  })

  it('orders the lists the way the slow one did: members move among their own places and the others stay put', () => {
    const state = stateOf({ spaces: [{ id: 'sp-a' }], tabs: [{ id: 'p1', spaceId: 'sp-a' }, { id: 'today', spaceId: 'sp-a', pinned: false }, { id: 'p2', spaceId: 'sp-a' }, { id: 'p3', spaceId: 'sp-a' }] })
    const patch: SyncPatch = { upserts: [], removals: [], order: { 'tabs:sp-a:-': ['p3', 'p1', 'p2'] }, settings: {} }
    expect(applySyncPatch(state, patch, ctx).tabs.map((tab) => tab.id)).toEqual(['p3', 'today', 'p1', 'p2'])
    expect(applySyncPatch(state, patch, ctx)).toEqual(referenceApplySyncPatch(state, patch, ctx))
  })
})

describe('sync/apply: the key of a list cannot name what an id with a colon is a member of', () => {
  it('leaves alone the folders of a parent whose id holds a colon, as the slow one did: the key reads back as another list', () => {
    const state = stateOf({ spaces: [{ id: 'sp-a' }], folders: [{ id: 'x:y', spaceId: 'sp-a' }, { id: 'c1', spaceId: 'sp-a', parentId: 'x:y' }, { id: 'c2', spaceId: 'sp-a', parentId: 'x:y' }] })
    expect(state.folders.map((folder) => folder.id)).toEqual(['x:y', 'c1', 'c2'])
    const patch: SyncPatch = { upserts: [], removals: [], order: { 'folders:sp-a:x:y': ['c2', 'c1'] }, settings: {} }
    const fast = applySyncPatch(state, patch, ctx)
    expect(fast.folders.map((folder) => folder.id)).toEqual(['x:y', 'c1', 'c2'])
    expect(fast).toEqual(referenceApplySyncPatch(state, patch, ctx))
  })
})

describe('sync/apply: a large patch does not hold the main process', () => {
  // About 3.4 s (creations) and several seconds (removals) with the list walked for each change, on a quiet machine; about a tenth of a second after. The bounds are generous,
  // so that a loaded machine does not fail them and the slow one still does.
  const tab = (n: number): { kind: PatchKind; id: string; create: boolean; fields: Record<string, unknown>; remove: string[]; expect: Record<string, unknown> } => ({
    kind: 'tab',
    id: `t${n}`,
    create: true,
    fields: { spaceId: 'sp-a', pinned: true, anchorUrl: `https://t${n}.example/` },
    remove: [],
    expect: {}
  })

  it('makes forty thousand pinned tabs', () => {
    const state = stateOf({ spaces: [{ id: 'sp-a' }] })
    const started = performance.now()
    const made = applySyncPatch(state, { upserts: Array.from({ length: 40_000 }, (_, n) => tab(n)), removals: [], order: {}, settings: {} }, ctx)
    const elapsed = performance.now() - started
    expect(made.tabs).toHaveLength(40_000)
    expect(elapsed).toBeLessThan(1500)
  })

  it('removes twenty thousand pinned tabs that are still as they were frozen', () => {
    const state = applySyncPatch(stateOf({ spaces: [{ id: 'sp-a' }] }), { upserts: Array.from({ length: 20_000 }, (_, n) => tab(n)), removals: [], order: {}, settings: {} }, ctx)
    expect(state.tabs).toHaveLength(20_000)
    const removals = Array.from({ length: 20_000 }, (_, n) => ({ kind: 'tab' as const, id: `t${n}`, expect: { spaceId: 'sp-a', pinned: true } }))
    const started = performance.now()
    const left = applySyncPatch(state, { upserts: [], removals, order: {}, settings: {} }, ctx)
    const elapsed = performance.now() - started
    expect(left.tabs).toHaveLength(0)
    expect(elapsed).toBeLessThan(1500)
  })
})
