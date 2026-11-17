import { describe, expect, it } from 'vitest'
import type { Folder } from './model'
import { FOLDERS_MAX, cleanFolders } from './state-clean'
import { FOLDER_MAX_DEPTH, canMoveFolder, folderAncestors, folderChildren, folderDepth, folderHeight, folderPlacement, folderRows, folderSubtreeIds, foldersToReveal, normalizeFolders } from './folders'

const folder = (id: string, parentId?: string, spaceId = 's', collapsed = false): Folder => ({ id, spaceId, name: id, collapsed, ...(parentId ? { parentId } : {}) })
const spaces = new Set(['s', 't'])

describe('folder tree walks', () => {
  const tree = [folder('a'), folder('b', 'a'), folder('c', 'b'), folder('d', 'a'), folder('e')]

  it('counts the levels, a root folder being level 1', () => {
    expect(folderDepth(tree, 'a')).toBe(1)
    expect(folderDepth(tree, 'c')).toBe(3)
    expect(folderDepth(tree, 'nope')).toBe(0)
  })

  it('stops on a loop instead of walking forever', () => {
    const loop = [folder('x', 'y'), folder('y', 'x')]
    expect(folderDepth(loop, 'x')).toBe(2)
    expect(folderSubtreeIds(loop, 'x')).toEqual(['x', 'y'])
    expect(folderAncestors(loop, 'x')).toEqual(['y'])
  })

  it('lists a folder and everything below it, depth first', () => {
    expect(folderSubtreeIds(tree, 'a')).toEqual(['a', 'b', 'c', 'd'])
    expect(folderSubtreeIds(tree, 'b')).toEqual(['b', 'c'])
    expect(folderSubtreeIds(tree, 'nope')).toEqual([])
  })

  it('lists the folders above one, nearest first', () => {
    expect(folderAncestors(tree, 'c')).toEqual(['b', 'a'])
    expect(folderAncestors(tree, 'a')).toEqual([])
  })

  it('finds the folders directly inside another, or at the root of one space', () => {
    expect(folderChildren(tree, 'a').map((f) => f.id)).toEqual(['b', 'd'])
    expect(folderChildren(tree, undefined).map((f) => f.id)).toEqual(['a', 'e'])
    expect(folderChildren([...tree, folder('z', undefined, 't')], undefined, 't').map((f) => f.id)).toEqual(['z'])
  })
})

describe('folder rows as the sidebar lists them', () => {
  it('puts each folder before the ones inside it, with its level', () => {
    const rows = folderRows([folder('a'), folder('e'), folder('b', 'a'), folder('c', 'b')], 's')
    expect(rows.map((r) => `${r.folder.id}:${r.depth}`)).toEqual(['a:0', 'b:1', 'c:2', 'e:0'])
  })

  it('marks what a collapsed folder hides, not the folder itself', () => {
    const rows = folderRows([folder('a', undefined, 's', true), folder('b', 'a'), folder('c', 'b'), folder('e')], 's')
    expect(rows.map((r) => [r.folder.id, r.hidden])).toEqual([['a', false], ['b', true], ['c', true], ['e', false]])
  })

  it('keeps to one space and still shows a folder whose parent is missing', () => {
    const rows = folderRows([folder('a'), folder('o', undefined, 't'), folder('lost', 'gone')], 's')
    expect(rows.map((r) => r.folder.id)).toEqual(['a', 'lost'])
  })
})

describe('normalizing the folder tree', () => {
  it('leaves folders saved before sub-folders existed exactly as they are', () => {
    const legacy = [folder('a'), folder('b')]
    const out = normalizeFolders(legacy, spaces)
    expect(out).toEqual(legacy)
    expect(out[0]).toBe(legacy[0])
    expect(out[0]).not.toHaveProperty('parentId')
  })

  it('sends a folder whose parent does not exist to the root', () => {
    const out = normalizeFolders([folder('a', 'ghost')], spaces)
    expect(out[0]).not.toHaveProperty('parentId')
  })

  it('does not let a folder sit inside a folder of another space', () => {
    const out = normalizeFolders([folder('a', undefined, 't'), folder('b', 'a', 's')], spaces)
    expect(out.find((f) => f.id === 'b')).not.toHaveProperty('parentId')
  })

  it('flattens a chain of tens of thousands of folders, each inside the one before, without running out of stack', () => {
    const chain = Array.from({ length: 50_000 }, (_, i) => folder(`c${i}`, i === 0 ? undefined : `c${i - 1}`))
    const out = normalizeFolders(chain, spaces)
    expect(out).toHaveLength(chain.length)
    // The first levels are kept, everything below sits at the deepest level allowed, under the same folder.
    expect(out.slice(0, FOLDER_MAX_DEPTH + 2).map((f) => f.parentId)).toEqual([undefined, 'c0', 'c1', 'c2', 'c2', 'c2'])
    expect(out.every((f, i) => i < FOLDER_MAX_DEPTH || f.parentId === 'c2')).toBe(true)
    // The same chain closed into a loop: cut at its first folder, flattened the same way.
    const loop = [folder('c0', 'c49999'), ...chain.slice(1)]
    expect(normalizeFolders(loop, spaces).map((f) => f.parentId).slice(0, 5)).toEqual([undefined, 'c0', 'c1', 'c2', 'c2'])
  })

  it('reads a bounded number of folders from a file, the first ones', () => {
    const raw = Array.from({ length: FOLDERS_MAX + 200 }, (_, i) => ({ id: `f${i}`, spaceId: 's', name: `F${i}`, collapsed: false }))
    const kept = cleanFolders(raw)
    expect(kept).toHaveLength(FOLDERS_MAX)
    expect(kept[0]!.id).toBe('f0')
    expect(kept.at(-1)!.id).toBe(`f${FOLDERS_MAX - 1}`)
    expect(cleanFolders(raw.slice(0, 10))).toHaveLength(10)
  })

  it('cuts a folder that is its own parent', () => {
    expect(normalizeFolders([folder('a', 'a')], spaces)[0]).not.toHaveProperty('parentId')
  })

  it('cuts a loop at its first folder and keeps every folder', () => {
    const out = normalizeFolders([folder('x', 'z'), folder('y', 'x'), folder('z', 'y')], spaces)
    expect(out).toHaveLength(3)
    expect(out.map((f) => folderDepth(out, f.id))).toEqual([1, 2, 3])
    expect(out[0]).not.toHaveProperty('parentId')
    expect(out[1]!.parentId).toBe('x')
  })

  it(`never goes deeper than ${FOLDER_MAX_DEPTH} levels: deeper folders move up beside the last allowed one`, () => {
    const chain = [folder('a'), folder('b', 'a'), folder('c', 'b'), folder('d', 'c'), folder('e', 'd'), folder('f', 'e')]
    const out = normalizeFolders(chain, spaces)
    expect(out).toHaveLength(6)
    for (const f of out) expect(folderDepth(out, f.id)).toBeLessThanOrEqual(FOLDER_MAX_DEPTH)
    expect(out.map((f) => f.parentId)).toEqual([undefined, 'a', 'b', 'c', 'c', 'c'])
  })

  it('drops the folders of a space that is gone and keeps the file order', () => {
    const out = normalizeFolders([folder('z', undefined, 't'), folder('a'), folder('o', undefined, 'gone'), folder('b')], spaces)
    expect(out.map((f) => f.id)).toEqual(['z', 'a', 'b'])
  })
})

describe('revealing a tab in nested folders', () => {
  const tree = [folder('a', undefined, 's', true), folder('b', 'a', 's', true), folder('c', 'b', 's', false)]

  it('opens the collapsed folder and every collapsed ancestor, and leaves the open ones alone', () => {
    expect(foldersToReveal(tree, 'c')).toEqual(['b', 'a'])
    expect(foldersToReveal(tree, 'b')).toEqual(['b', 'a'])
  })

  it('has nothing to open for a loose tab or an unknown folder', () => {
    expect(foldersToReveal(tree, undefined)).toEqual([])
    expect(foldersToReveal(tree, 'nope')).toEqual([])
  })
})

describe('moving a folder', () => {
  const tree = [folder('a'), folder('b', 'a'), folder('c', 'b'), folder('d', 'a'), folder('e'), folder('z', undefined, 't')]

  it('counts the levels from a folder down, itself included', () => {
    expect(folderHeight(tree, 'a')).toBe(3)
    expect(folderHeight(tree, 'b')).toBe(2)
    expect(folderHeight(tree, 'e')).toBe(1)
    expect(folderHeight(tree, 'nope')).toBe(0)
    expect(folderHeight([folder('x', 'y'), folder('y', 'x')], 'x')).toBe(2)
  })

  it('allows the root, and a folder that is neither the folder itself nor below it', () => {
    expect(canMoveFolder(tree, 'c', null)).toBe(true)
    expect(canMoveFolder(tree, 'e', 'a')).toBe(true)
    expect(canMoveFolder(tree, 'a', 'a')).toBe(false)
    expect(canMoveFolder(tree, 'a', 'c')).toBe(false)
    expect(canMoveFolder(tree, 'nope', null)).toBe(false)
    expect(canMoveFolder(tree, 'e', 'nope')).toBe(false)
  })

  it('refuses another space and anything that would go below the deepest level', () => {
    expect(canMoveFolder(tree, 'e', 'z')).toBe(false)
    // a is 3 levels high: inside e (level 1) it would reach level 4, which is the limit; inside c (level 3) it would reach 6.
    expect(canMoveFolder(tree, 'a', 'e')).toBe(true)
    const chain = [folder('p'), folder('q', 'p'), folder('r', 'q'), folder('s2', 'r'), folder('m'), folder('n', 'm')]
    expect(folderDepth(chain, 's2')).toBe(FOLDER_MAX_DEPTH)
    expect(canMoveFolder(chain, 'm', 'r')).toBe(false)
    expect(canMoveFolder(chain, 'm', 'q')).toBe(true)
  })

  it('tells where a folder stands among its siblings', () => {
    expect(folderPlacement(tree, 'a')).toEqual({ parentId: null, index: 0 })
    expect(folderPlacement(tree, 'e')).toEqual({ parentId: null, index: 1 })
    expect(folderPlacement(tree, 'd')).toEqual({ parentId: 'a', index: 1 })
    expect(folderPlacement(tree, 'z')).toEqual({ parentId: null, index: 0 })
    expect(folderPlacement(tree, 'nope')).toBeNull()
  })
})
