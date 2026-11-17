import { describe, expect, it } from 'vitest'
import { READ_LATER_FOLDERS_LIMIT, READ_LATER_FOLDER_NAME_MAX, defaultSettings, type ReadLaterFolder, type ReadLaterItem, type SidebarState } from './model'
import { createPrivateState, privateAction, scrubPrivateState } from './private-window'
import { moveReadLater, readLaterGroups } from './read-later'
import { createInitialState, normalize, parseSavedState, reduce, type Action, type Ctx } from './sidebar'
import { cleanReadLater, cleanReadLaterFolders } from './state-clean'

const makeCtx = (): Ctx => {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}
const item = (n: number, over: Partial<ReadLaterItem> = {}): ReadLaterItem => ({ id: `rl${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, savedAt: n, ...over })
const folder = (id: string, over: Partial<ReadLaterFolder> = {}): ReadLaterFolder => ({ id, name: `Dossier ${id}`, ...over })

/** A state with the folders switched on (or off), holding these pages and folders. */
function stateWith(readLater: ReadLaterItem[], readLaterFolders: ReadLaterFolder[] = [], on = true): SidebarState {
  const state = createInitialState(makeCtx())
  return { ...state, readLater, readLaterFolders, settings: { ...state.settings, useReadLaterFolders: on } }
}
const run = (state: SidebarState, action: Action, ctx = makeCtx()): SidebarState => reduce(state, action, ctx)
const ids = (list: ReadLaterItem[]): string[] => list.map((i) => i.id)

describe('the setting', () => {
  it('is off by default: the list is flat as it was', () => {
    expect(defaultSettings().useReadLaterFolders).toBe(false)
    expect(createInitialState(makeCtx()).readLaterFolders).toEqual([])
  })

  it('makes every folder action do nothing while it is off', () => {
    const state = stateWith([item(1), item(2)], [folder('f1')], false)
    const actions: Action[] = [
      { type: 'readlater-folder/create', name: 'Nouveau' },
      { type: 'readlater-folder/rename', id: 'f1', name: 'Autre' },
      { type: 'readlater-folder/delete', id: 'f1' },
      { type: 'readlater-folder/collapse', id: 'f1', collapsed: true },
      { type: 'readlater/move', id: 'rl1', folderId: 'f1' }
    ]
    for (const action of actions) expect(run(state, action), action.type).toBe(state)
  })
})

describe('readlater-folder/create, rename, collapse', () => {
  it('creates a folder at the end of the others, with a clean name, and a blank name gives "Dossier"', () => {
    const ctx = makeCtx()
    let state = stateWith([])
    state = run(state, { type: 'readlater-folder/create', name: '  Lectures longues \n' }, ctx)
    state = run(state, { type: 'readlater-folder/create', name: '   ' }, ctx)
    expect(state.readLaterFolders.map((f) => f.name)).toEqual(['Lectures longues', 'Dossier'])
    expect(new Set(state.readLaterFolders.map((f) => f.id)).size).toBe(2)
  })

  it('bounds the name and the number of folders', () => {
    let state = run(stateWith([]), { type: 'readlater-folder/create', name: 'x'.repeat(500) })
    expect(state.readLaterFolders[0]!.name).toHaveLength(READ_LATER_FOLDER_NAME_MAX)
    const full = stateWith([], Array.from({ length: READ_LATER_FOLDERS_LIMIT }, (_, i) => folder(`f${i}`)))
    state = run(full, { type: 'readlater-folder/create', name: 'un de trop' })
    expect(state).toBe(full)
  })

  it('renames a folder, and keeps the old name for a blank one or a name that is not text', () => {
    const state = stateWith([], [folder('f1')])
    expect(run(state, { type: 'readlater-folder/rename', id: 'f1', name: 'À lire ce soir' }).readLaterFolders[0]!.name).toBe('À lire ce soir')
    expect(run(state, { type: 'readlater-folder/rename', id: 'f1', name: '  ' })).toBe(state)
    expect(run(state, { type: 'readlater-folder/rename', id: 'f1', name: 5 as unknown as string })).toBe(state)
    expect(run(state, { type: 'readlater-folder/rename', id: 'nope', name: 'x' })).toBe(state)
  })

  it('folds and unfolds, and does nothing when the folder is already so', () => {
    const state = stateWith([], [folder('f1')])
    const folded = run(state, { type: 'readlater-folder/collapse', id: 'f1', collapsed: true })
    expect(folded.readLaterFolders[0]!.collapsed).toBe(true)
    expect(run(folded, { type: 'readlater-folder/collapse', id: 'f1', collapsed: true })).toBe(folded)
    const open = run(folded, { type: 'readlater-folder/collapse', id: 'f1', collapsed: false })
    expect(open.readLaterFolders[0]).toEqual({ id: 'f1', name: 'Dossier f1' })
    expect(run(state, { type: 'readlater-folder/collapse', id: 'nope', collapsed: true })).toBe(state)
  })
})

describe('readlater-folder/delete', () => {
  it('removes the folder and sets its pages loose, in the same place of the list; the pages of other folders stay', () => {
    const state = stateWith([item(1, { folderId: 'f1' }), item(2, { folderId: 'f2' }), item(3, { folderId: 'f1' }), item(4)], [folder('f1'), folder('f2')])
    const next = run(state, { type: 'readlater-folder/delete', id: 'f1' })
    expect(next.readLaterFolders.map((f) => f.id)).toEqual(['f2'])
    expect(next.readLater.map((i) => [i.id, i.folderId])).toEqual([['rl1', undefined], ['rl2', 'f2'], ['rl3', undefined], ['rl4', undefined]])
    expect(next.readLater.every((i) => !('folderId' in i) || i.folderId === 'f2')).toBe(true)
  })

  it('does nothing for a folder that is not there', () => {
    const state = stateWith([item(1)], [folder('f1')])
    expect(run(state, { type: 'readlater-folder/delete', id: 'nope' })).toBe(state)
  })

  it('"Tout effacer" empties the pages and keeps the folders', () => {
    const state = stateWith([item(1, { folderId: 'f1' })], [folder('f1')])
    const next = run(state, { type: 'readlater/clear' })
    expect(next.readLater).toEqual([])
    expect(next.readLaterFolders).toHaveLength(1)
  })
})

describe('moveReadLater and readlater/move', () => {
  const folders = [folder('f1'), folder('f2')]
  const base = [item(1), item(2, { folderId: 'f1' }), item(3, { folderId: 'f1' }), item(4), item(5, { folderId: 'f2' })]

  it('puts a loose page first in a folder', () => {
    const next = moveReadLater(base, folders, 'rl4', 'f1')
    expect(ids(next)).toEqual(['rl1', 'rl4', 'rl2', 'rl3', 'rl5'])
    expect(next.find((i) => i.id === 'rl4')!.folderId).toBe('f1')
  })

  it('puts it before a given page of that folder, or last of the folder with null', () => {
    expect(ids(moveReadLater(base, folders, 'rl4', 'f1', 'rl3'))).toEqual(['rl1', 'rl2', 'rl4', 'rl3', 'rl5'])
    expect(ids(moveReadLater(base, folders, 'rl4', 'f1', null))).toEqual(['rl1', 'rl2', 'rl3', 'rl4', 'rl5'])
  })

  it('ignores an anchor that is not in the target folder, and goes first', () => {
    expect(ids(moveReadLater(base, folders, 'rl4', 'f1', 'rl5'))).toEqual(['rl1', 'rl4', 'rl2', 'rl3', 'rl5'])
    expect(ids(moveReadLater(base, folders, 'rl4', 'f1', 'nope'))).toEqual(['rl1', 'rl4', 'rl2', 'rl3', 'rl5'])
  })

  it('takes a page out of its folder (null) and reorders inside a folder', () => {
    const out = moveReadLater(base, folders, 'rl2', null)
    expect(out.find((i) => i.id === 'rl2')).toEqual(item(2))
    expect(ids(moveReadLater(base, folders, 'rl3', 'f1', 'rl2'))).toEqual(['rl1', 'rl3', 'rl2', 'rl4', 'rl5'])
  })

  it('returns the same list when nothing would change, or when the page or the folder is unknown', () => {
    expect(moveReadLater(base, folders, 'rl2', 'f1')).toBe(base)
    expect(moveReadLater(base, folders, 'rl1', null)).toBe(base)
    expect(moveReadLater(base, folders, 'nope', 'f1')).toBe(base)
    expect(moveReadLater(base, folders, 'rl1', 'nope')).toBe(base)
  })

  it('never loses or duplicates a page, whatever the moves', () => {
    let list = base
    const moves: Array<[string, string | null, (string | null)?]> = [['rl1', 'f2'], ['rl5', 'f1', 'rl2'], ['rl3', null], ['rl2', 'f2', null], ['rl4', 'f1', 'rl1'], ['rl1', null, 'rl3']]
    for (const [id, to, before] of moves) list = moveReadLater(list, folders, id, to, before)
    expect([...ids(list)].sort()).toEqual(['rl1', 'rl2', 'rl3', 'rl4', 'rl5'])
  })

  it('goes through the reducer, which leaves the state alone for a move to the same place', () => {
    const state = stateWith(base, folders)
    const next = run(state, { type: 'readlater/move', id: 'rl4', folderId: 'f2' })
    expect(next.readLater.find((i) => i.id === 'rl4')!.folderId).toBe('f2')
    expect(run(state, { type: 'readlater/move', id: 'rl2', folderId: 'f1' })).toBe(state)
  })
})

describe('readLaterGroups', () => {
  it('lists each folder with its pages, then the loose ones, and treats a page of a missing folder as loose', () => {
    const groups = readLaterGroups([item(1), item(2, { folderId: 'f1' }), item(3, { folderId: 'gone' }), item(4, { folderId: 'f1' })], [folder('f1'), folder('f2')])
    expect(groups.folders.map((g) => [g.folder.id, ids(g.items)])).toEqual([['f1', ['rl2', 'rl4']], ['f2', []]])
    expect(ids(groups.loose)).toEqual(['rl1', 'rl3'])
  })
})

describe('what a file may hold', () => {
  it('cleans the folders: ids once, a name that is a clean line, a flag only when true, at most the limit', () => {
    const raw = [
      { id: 'a', name: '  Un\u0000\ndossier ' },
      { id: 'a', name: 'doublon' },
      { id: 'b', name: '', collapsed: true },
      { id: 'c', name: 5, collapsed: 'oui' },
      null,
      7,
      { name: 'sans id' },
      { id: '__proto__', name: 'x' },
      ...Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, name: 'n' }))
    ]
    const out = cleanReadLaterFolders(raw)
    expect(out).toHaveLength(READ_LATER_FOLDERS_LIMIT)
    expect(out.slice(0, 3)).toEqual([{ id: 'a', name: 'Un  dossier' }, { id: 'b', name: 'Dossier', collapsed: true }, { id: 'c', name: 'Dossier' }])
    for (const raw of [undefined, null, 'x', 4, {}, true]) expect(cleanReadLaterFolders(raw)).toEqual([])
  })

  it('keeps the folder of a page only if that folder exists', () => {
    const out = cleanReadLater([item(1, { folderId: 'f1' }), item(2, { folderId: 'gone' }), item(3, { folderId: 5 as unknown as string }), item(4)], new Set(['f1']))
    expect(out.map((i) => i.folderId)).toEqual(['f1', undefined, undefined, undefined])
    expect(out.every((i) => !('folderId' in i) || typeof i.folderId === 'string')).toBe(true)
    // Without folders (the old way of calling), every page is loose.
    expect(cleanReadLater([item(1, { folderId: 'f1' })]).every((i) => i.folderId === undefined)).toBe(true)
  })

  it('migrates a list saved before the folders: every page loose, no folder, nothing lost, and a second pass changes nothing', () => {
    const old = createInitialState(makeCtx()) as unknown as Record<string, unknown>
    delete old['readLaterFolders']
    old['readLater'] = [item(1), item(2)]
    const loaded = parseSavedState(JSON.stringify(old))
    expect(loaded.readLaterFolders).toEqual([])
    expect(ids(loaded.readLater)).toEqual(['rl1', 'rl2'])
    expect(normalize(loaded)).toEqual(loaded)
  })

  it('drops a page whose folder was removed from the file, but keeps the page', () => {
    const doc = { ...createInitialState(makeCtx()), readLater: [item(1, { folderId: 'f1' })], readLaterFolders: [] }
    const loaded = normalize(doc)
    expect(loaded.readLater).toEqual([item(1)])
  })

  it('keeps folders and pages in them through a save and a load', () => {
    const state = stateWith([item(1, { folderId: 'f1' }), item(2)], [folder('f1', { collapsed: true })])
    expect(parseSavedState(JSON.stringify(state)).readLater).toEqual(state.readLater)
    expect(parseSavedState(JSON.stringify(state)).readLaterFolders).toEqual(state.readLaterFolders)
  })
})

describe('the private window', () => {
  it('refuses every folder action and keeps no folder', () => {
    for (const action of [{ type: 'readlater-folder/create', name: 'x' }, { type: 'readlater-folder/delete', id: 'f1' }, { type: 'readlater/move', id: 'rl1', folderId: null }] as Action[]) expect(privateAction(action), action.type).toBeNull()
    const main = stateWith([item(1)], [folder('f1')])
    const state = createPrivateState(main, makeCtx())
    expect(state.readLaterFolders).toEqual([])
    expect(scrubPrivateState({ ...state, readLaterFolders: [folder('f1')] }).readLaterFolders).toEqual([])
  })
})
