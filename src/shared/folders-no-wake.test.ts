import { describe, expect, it } from 'vitest'
import { noWakeTabIds } from './folders'
import { createInitialState, reduce } from './sidebar'
import type { Folder } from './model'

const folder = (id: string, patch: Partial<Folder> = {}): Folder => ({ id, spaceId: 's', name: id, collapsed: false, ...patch })

describe('the tabs that are never woken by themselves', () => {
  it('are those inside a folder marked, or inside a folder in it, and no others', () => {
    const folders = [folder('old', { noWake: true }), folder('sub', { parentId: 'old' }), folder('plain')]
    const tabs = [{ id: 'a', folderId: 'old' }, { id: 'b', folderId: 'sub' }, { id: 'c', folderId: 'plain' }, { id: 'd' }]
    expect([...noWakeTabIds({ tabs, folders })].sort()).toEqual(['a', 'b'])
  })

  it('are none when no folder is marked', () => {
    expect(noWakeTabIds({ tabs: [{ id: 'a', folderId: 'f' }], folders: [folder('f')] }).size).toBe(0)
  })
})

describe('the action that marks a folder', () => {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
  const withFolder = () => reduce(createInitialState(ctx), { type: 'folder/create', name: 'Anciens' }, ctx)

  it('marks it, unmarks it, and leaves the state alone when nothing changes or the folder is unknown', () => {
    const state = withFolder()
    const id = state.folders[0]!.id
    const marked = reduce(state, { type: 'folder/no-wake', id, on: true }, ctx)
    expect(marked.folders[0]?.noWake).toBe(true)
    expect(reduce(marked, { type: 'folder/no-wake', id, on: true }, ctx)).toBe(marked)
    const unmarked = reduce(marked, { type: 'folder/no-wake', id, on: false }, ctx)
    expect('noWake' in unmarked.folders[0]!).toBe(false)
    expect(reduce(state, { type: 'folder/no-wake', id: 'missing', on: true }, ctx)).toBe(state)
  })

  it('stays when the folder is moved', () => {
    const base = reduce(withFolder(), { type: 'folder/create', name: 'Autre' }, ctx)
    const id = base.folders[0]!.id
    const marked = reduce(base, { type: 'folder/no-wake', id, on: true }, ctx)
    expect(marked.folders.find((f) => f.id === id)?.noWake).toBe(true)
    const moved = reduce(marked, { type: 'folder/move', id, parentId: null, toIndex: Number.MAX_SAFE_INTEGER }, ctx)
    expect(moved.folders.find((f) => f.id === id)?.noWake).toBe(true)
  })
})
