// The emoji of a folder (`Folder.icon`): read back from a state file, set and taken away by `folder/icon`, and the guard that keeps anything else out of the state.

import { describe, expect, it } from 'vitest'
import { createInitialState, parseSavedState, persistableState, reduce } from './sidebar'
import type { SidebarState } from './model'
import { cleanFolders } from './state-clean'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const withFolder = (): { state: SidebarState; id: string } => {
  const state = reduce(createInitialState(ctx), { type: 'folder/create', name: 'Clients' }, ctx)
  return { state, id: state.folders[0]!.id }
}
const iconOf = (state: SidebarState, id: string): string | undefined => state.folders.find((f) => f.id === id)?.icon

describe('the folders of a state file', () => {
  const entry = { id: 'f', spaceId: 's', name: 'Clients', collapsed: false }

  it('read the same without an icon: a file saved before the choice existed has none and is valid', () => {
    const [folder] = cleanFolders([entry])
    expect(folder).toEqual(entry)
    expect('icon' in folder!).toBe(false)
  })

  it('keep an icon that is one emoji, a flag or a sequence of emoji included', () => {
    for (const icon of ['📚', '🇫🇷', '👩‍💻', '🏳️‍🌈', '1️⃣']) expect(cleanFolders([{ ...entry, icon }])[0]!.icon, icon).toBe(icon)
  })

  it('drop an icon that is not one emoji, and keep the folder', () => {
    for (const icon of ['', 'A', '7', 'Clients', '📚📚', ' 📚', 42, true, null, { emoji: '📚' }, ['📚']]) {
      const [folder] = cleanFolders([{ ...entry, icon }])
      expect(folder?.name, String(icon)).toBe('Clients')
      expect('icon' in folder!, String(icon)).toBe(false)
    }
  })

  it('keep the icon through the file the state is saved in', () => {
    const { state, id } = withFolder()
    const chosen = reduce(state, { type: 'folder/icon', id, icon: '🚀' }, ctx)
    const reloaded = parseSavedState(JSON.stringify(persistableState(chosen)))
    expect(iconOf(reloaded, id)).toBe('🚀')
    // And a file written before the choice existed (no `icon` anywhere) loads with the folder as it was.
    const old = parseSavedState(JSON.stringify(persistableState(state)))
    expect(old.folders).toHaveLength(1)
    expect(iconOf(old, id)).toBeUndefined()
  })
})

describe('the action that puts an emoji on a folder', () => {
  it('sets it, changes it, and takes it away', () => {
    const { state, id } = withFolder()
    const set = reduce(state, { type: 'folder/icon', id, icon: '📚' }, ctx)
    expect(iconOf(set, id)).toBe('📚')
    expect(iconOf(reduce(set, { type: 'folder/icon', id, icon: '🚀' }, ctx), id)).toBe('🚀')
    const removed = reduce(set, { type: 'folder/icon', id, icon: null }, ctx)
    // The key is gone, not left at undefined: the folder is the one that had no icon.
    expect('icon' in removed.folders[0]!).toBe(false)
  })

  it('changes nothing for the emoji the folder has, for none on a folder that has none, and for a folder that does not exist', () => {
    const { state, id } = withFolder()
    const set = reduce(state, { type: 'folder/icon', id, icon: '📚' }, ctx)
    expect(reduce(set, { type: 'folder/icon', id, icon: '📚' }, ctx)).toBe(set)
    expect(reduce(state, { type: 'folder/icon', id, icon: null }, ctx)).toBe(state)
    expect(reduce(state, { type: 'folder/icon', id: 'missing', icon: '📚' }, ctx)).toBe(state)
  })

  it('refuses what is not exactly one emoji: the state stays as it was', () => {
    const { state, id } = withFolder()
    const set = reduce(state, { type: 'folder/icon', id, icon: '📚' }, ctx)
    // The actions arrive over IPC: a value of the wrong type is as possible as a wrong text.
    for (const icon of ['', 'A', '7', 'Clients', '📚📚', '📚 ', '‍', 42, undefined, { emoji: '📚' }]) {
      expect(reduce(set, { type: 'folder/icon', id, icon } as never, ctx), String(icon)).toBe(set)
      expect(reduce(state, { type: 'folder/icon', id, icon } as never, ctx), String(icon)).toBe(state)
    }
  })

  it('touches no other folder', () => {
    const base = reduce(withFolder().state, { type: 'folder/create', name: 'Autre' }, ctx)
    const [first, second] = base.folders
    const set = reduce(base, { type: 'folder/icon', id: second!.id, icon: '🎧' }, ctx)
    expect(iconOf(set, first!.id)).toBeUndefined()
    expect(iconOf(set, second!.id)).toBe('🎧')
  })

  it('stays with the folder when it is moved, and is on its copy when it is duplicated', () => {
    const base = reduce(withFolder().state, { type: 'folder/create', name: 'Autre' }, ctx)
    const id = base.folders[0]!.id
    const set = reduce(base, { type: 'folder/icon', id, icon: '📚' }, ctx)
    const moved = reduce(set, { type: 'folder/move', id, parentId: null, toIndex: Number.MAX_SAFE_INTEGER }, ctx)
    expect(iconOf(moved, id)).toBe('📚')
    const copied = reduce(set, { type: 'folder/duplicate', id }, ctx)
    expect(copied.folders.filter((f) => f.icon === '📚')).toHaveLength(2)
  })

  it('serves a live folder like any other', () => {
    const live = reduce(
      { ...createInitialState(ctx), settings: { ...createInitialState(ctx).settings, liveFolders: true } },
      { type: 'livefolder/create', source: { kind: 'github', repo: 'owner/name', what: 'pulls' } },
      ctx
    )
    const folder = live.folders.find((f) => f.live !== undefined)
    expect(folder).toBeDefined()
    expect(iconOf(reduce(live, { type: 'folder/icon', id: folder!.id, icon: '🔔' }, ctx), folder!.id)).toBe('🔔')
  })
})
