import { setLanguage } from './i18n'
import { afterEach, describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { groupFolderDefaultName, GROUP_FOLDER_NAME_MAX, GroupFolders, clearGroupMirror, groupFolderName, setGroupMirror, withoutGroupFolders, withoutMirroredFolders, type MirroredGroup } from './group-folders'
import { createInitialState, persistableState, reduce, sidebarOrder, type Action } from './sidebar'

let counter = 0
const ctx = () => ({ now: 1000, newId: () => `id${++counter}` })

/** A store over the real reducer, and the actions the mirror sent to it. */
function setup(extra: Action[] = []) {
  let state: SidebarState = createInitialState(ctx())
  const sent: Action[] = []
  const reports: string[] = []
  const apply = (action: Action) => {
    sent.push(action)
    state = reduce(state, action, ctx())
  }
  for (const action of extra) state = reduce(state, action, ctx())
  const port = { state: () => state, dispatch: apply, report: (message: string) => void reports.push(message) }
  const mirror = new GroupFolders(port)
  return {
    mirror,
    sent,
    reports,
    get state() {
      return state
    },
    do: (action: Action) => void (state = reduce(state, action, ctx())),
    open(url: string, spaceId?: string): TabItem {
      state = reduce(state, { type: 'tab/open', url, ...(spaceId ? { spaceId } : {}) }, ctx())
      return state.tabs[state.tabs.length - 1]!
    },
    tab: (id: string) => state.tabs.find((t) => t.id === id)!,
    folders: () => state.folders
  }
}

const group = (id: number, tabs: readonly string[], extra: Partial<MirroredGroup> = {}): MirroredGroup => ({ id, title: '', collapsed: false, tabs, ...extra })

afterEach(() => {
  counter = 0
})

describe('the name of a folder', () => {
  it('is the title of the group, or a word when it has none', () => {
    expect(groupFolderName('Recherches')).toBe('Recherches')
    expect(groupFolderName('')).toBe(groupFolderDefaultName())
    expect(groupFolderName('   ')).toBe(groupFolderDefaultName())
    expect(groupFolderName('\u0000\u0007')).toBe(groupFolderDefaultName())
    // The word is read from the catalogue of the language in use.
    expect(groupFolderName('')).toBe('Groupe')
    setLanguage('en')
    try {
      expect(groupFolderName('')).toBe('Group')
    } finally {
      setLanguage('fr')
    }
  })

  it('is one line and no longer than a folder name may be', () => {
    expect(groupFolderName('a\nb\tc')).toBe('a b c')
    expect(Array.from(groupFolderName('x'.repeat(5000)))).toHaveLength(GROUP_FOLDER_NAME_MAX)
    expect(Array.from(groupFolderName('😀'.repeat(300)))).toHaveLength(GROUP_FOLDER_NAME_MAX)
  })
})

describe('a group shown as a folder', () => {
  it('becomes a folder named after it, holding its tabs pinned in the order the sidebar had them', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    const c = t.open('https://c.example/')
    t.mirror.sync([group(1, [c.id, a.id], { title: 'Recherches' })])
    expect(t.folders()).toHaveLength(1)
    const folder = t.folders()[0]!
    expect(folder.name).toBe('Recherches')
    expect(folder.collapsed).toBe(false)
    expect(t.tab(a.id)).toMatchObject({ pinned: true, folderId: folder.id, anchorUrl: 'https://a.example/' })
    expect(t.tab(c.id)).toMatchObject({ pinned: true, folderId: folder.id })
    expect(t.tab(b.id)).toMatchObject({ pinned: false })
    expect(t.tab(b.id).folderId).toBeUndefined()
    expect(sidebarOrder(t.state, t.state.activeSpaceId).slice(0, 2).map((x) => x.id)).toEqual([a.id, c.id])
  })

  it('takes the folder to the space of its tabs', () => {
    const t = setup()
    t.do({ type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 })
    const work = t.state.activeSpaceId
    const a = t.open('https://a.example/', work)
    t.mirror.sync([group(1, [a.id])])
    expect(t.folders()[0]!.spaceId).toBe(work)
    expect(t.folders()[0]!.name).toBe('Groupe')
  })

  it('makes one folder per space when the tabs of a group are in two', () => {
    const t = setup()
    const first = t.state.activeSpaceId
    t.do({ type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 })
    const second = t.state.activeSpaceId
    const a = t.open('https://a.example/', first)
    const b = t.open('https://b.example/', second)
    t.mirror.sync([group(1, [a.id, b.id], { title: 'Veille' })])
    expect(t.folders().map((f) => [f.spaceId, f.name]).sort()).toEqual([[first, 'Veille'], [second, 'Veille']].sort())
    expect(t.tab(a.id).folderId).not.toBe(t.tab(b.id).folderId)
  })

  it('does nothing twice: the same groups again send nothing', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id], { title: 'G', collapsed: true })])
    const sent = t.sent.length
    t.mirror.sync([group(1, [a.id], { title: 'G', collapsed: true })])
    t.mirror.sync([group(1, [a.id], { title: 'G', collapsed: true })])
    expect(t.sent).toHaveLength(sent)
  })

  it('leaves a private tab out, and a tab that is not there any more', () => {
    const t = setup([{ type: 'settings/update', patch: { privateTabs: true } }])
    t.do({ type: 'tab/open', url: 'about:blank', private: true })
    const secret = t.state.tabs.find((x) => x.private)!
    t.mirror.sync([group(1, [secret.id, 'gone'])])
    expect(t.folders()).toEqual([])
    expect(t.sent).toEqual([])
    expect(t.tab(secret.id).pinned).toBe(false)
  })

  it('shows nothing for a group with no tab', () => {
    const t = setup()
    t.mirror.sync([group(1, [])])
    expect(t.sent).toEqual([])
  })

  it('reports and goes on when the folder cannot be made', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    let state = t.state
    const refusing = new GroupFolders({ state: () => state, dispatch: () => void 0, report: (message) => void t.reports.push(message) })
    refusing.sync([group(7, [a.id])])
    expect(t.reports).toHaveLength(1)
    expect(t.reports[0]).toContain('group 7')
    // It is not tried again at every sync.
    refusing.sync([group(7, [a.id])])
    expect(t.reports).toHaveLength(1)
    state = t.state
  })
})

describe('a group that changes', () => {
  it('takes a tab that joins into the folder, and puts back one that leaves', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    const c = t.open('https://c.example/')
    t.mirror.sync([group(1, [a.id, b.id])])
    const folderId = t.folders()[0]!.id
    t.mirror.sync([group(1, [b.id, c.id])])
    expect(t.tab(a.id).pinned).toBe(false)
    expect(t.tab(a.id).folderId).toBeUndefined()
    expect(t.tab(a.id).anchorUrl).toBeUndefined()
    expect(t.tab(b.id).folderId).toBe(folderId)
    expect(t.tab(c.id)).toMatchObject({ pinned: true, folderId })
    expect(t.folders()).toHaveLength(1)
  })

  it('removes the folder and unpins the tabs when the group is gone', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    t.mirror.sync([group(1, [a.id, b.id])])
    t.mirror.sync([])
    expect(t.folders()).toEqual([])
    for (const tab of [t.tab(a.id), t.tab(b.id)]) expect(tab).toMatchObject({ pinned: false })
    expect(t.tab(a.id).folderId).toBeUndefined()
  })

  it('puts a tab that was pinned before back among the pinned tabs, in the folder it was in', () => {
    const t = setup()
    t.do({ type: 'folder/create', name: 'Mes sites' })
    const mine = t.state.folders[0]!.id
    const p = t.open('https://p.example/')
    const q = t.open('https://q.example/')
    t.do({ type: 'tab/pin', id: p.id })
    t.do({ type: 'tabs/move', ids: [q.id], toIndex: 0, pinned: true, folderId: mine })
    t.mirror.sync([group(1, [p.id, q.id])])
    const mirrored = t.folders().find((f) => f.id !== mine)!.id
    expect(t.tab(p.id).folderId).toBe(mirrored)
    t.mirror.sync([])
    expect(t.tab(p.id)).toMatchObject({ pinned: true })
    expect(t.tab(p.id).folderId).toBeUndefined()
    expect(t.tab(q.id)).toMatchObject({ pinned: true, folderId: mine })
    expect(t.folders().map((f) => f.id)).toEqual([mine])
  })

  it('renames the folder when the extension changes the title, once', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id], { title: 'Avant' })])
    t.mirror.sync([group(1, [a.id], { title: 'Après' })])
    expect(t.folders()[0]!.name).toBe('Après')
    const sent = t.sent.length
    t.mirror.sync([group(1, [a.id], { title: 'Après' })])
    expect(t.sent).toHaveLength(sent)
  })

  it('keeps the name the user typed until the extension changes the title', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id], { title: 'Avant' })])
    t.do({ type: 'folder/rename', id: t.folders()[0]!.id, name: 'Le mien' })
    t.mirror.sync([group(1, [a.id], { title: 'Avant' })])
    expect(t.folders()[0]!.name).toBe('Le mien')
    t.mirror.sync([group(1, [a.id], { title: 'Après' })])
    expect(t.folders()[0]!.name).toBe('Après')
  })

  it('follows the collapsed state of the group, and leaves a folder the user opened or closed alone', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id], { collapsed: true })])
    expect(t.folders()[0]!.collapsed).toBe(true)
    t.mirror.sync([group(1, [a.id], { collapsed: false })])
    expect(t.folders()[0]!.collapsed).toBe(false)
    // The user closes it by hand: the group still says "open", and nothing reopens it.
    t.do({ type: 'folder/toggle', id: t.folders()[0]!.id })
    t.mirror.sync([group(1, [a.id], { collapsed: false })])
    expect(t.folders()[0]!.collapsed).toBe(true)
  })

  it('forgets a tab that was closed, and removes the folder with the last one', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    t.mirror.sync([group(1, [a.id, b.id])])
    t.do({ type: 'tabs/archive-many', ids: [a.id] })
    t.do({ type: 'tab/unpin', id: a.id })
    t.do({ type: 'tab/close', id: a.id })
    t.mirror.sync([group(1, [b.id])])
    expect(t.folders()).toHaveLength(1)
    t.do({ type: 'tab/unpin', id: b.id })
    t.do({ type: 'tab/close', id: b.id })
    t.mirror.sync([])
    expect(t.folders()).toEqual([])
  })
})

describe('what the user does to the folder', () => {
  it('is respected when they delete it: the tabs stay where that left them, and the group is not shown again', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id])])
    t.do({ type: 'folder/delete', id: t.folders()[0]!.id })
    const sent = t.sent.length
    t.mirror.sync([group(1, [a.id])])
    t.mirror.sync([group(1, [a.id])])
    expect(t.sent).toHaveLength(sent)
    expect(t.folders()).toEqual([])
    expect(t.tab(a.id).pinned).toBe(true)
    // …until the group ends: the next group (a new id) is shown.
    t.mirror.sync([])
    t.mirror.sync([group(2, [a.id])])
    expect(t.folders()).toHaveLength(1)
  })

  it('is respected when they drag a tab out: it stays out while the group holds it, and nothing else is touched', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    t.mirror.sync([group(1, [a.id, b.id])])
    const folderId = t.folders()[0]!.id
    t.do({ type: 'tabs/move', ids: [a.id], toIndex: 0, pinned: false })
    t.mirror.sync([group(1, [a.id, b.id])])
    t.mirror.sync([group(1, [a.id, b.id])])
    expect(t.tab(a.id)).toMatchObject({ pinned: false })
    expect(t.tab(b.id).folderId).toBe(folderId)
    // Leaving the group later does not move it again.
    const sent = t.sent.length
    t.mirror.sync([group(1, [b.id])])
    expect(t.sent.slice(sent).some((action) => 'ids' in action && action.ids.includes(a.id))).toBe(false)
    expect(t.sent.slice(sent).some((action) => action.type === 'tab/unpin' && action.id === a.id)).toBe(false)
  })

  it('puts a tab that was taken out in the folder again when it leaves the group and joins it later', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    t.mirror.sync([group(1, [a.id, b.id])])
    t.do({ type: 'tabs/move', ids: [a.id], toIndex: 0, pinned: false })
    t.mirror.sync([group(1, [a.id, b.id])])
    t.mirror.sync([group(1, [b.id])])
    t.mirror.sync([group(1, [a.id, b.id])])
    expect(t.tab(a.id)).toMatchObject({ pinned: true, folderId: t.folders()[0]!.id })
  })

  it('does not put a tab back to its old place when the user moved it in the very turn the group ended', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.do({ type: 'tab/pin', id: a.id })
    const b = t.open('https://b.example/')
    t.mirror.sync([group(1, [a.id, b.id])])
    // Dragged to the loose tabs: the group ends before the mirror has seen it.
    t.do({ type: 'tabs/move', ids: [a.id], toIndex: 0, pinned: false })
    t.mirror.sync([])
    expect(t.tab(a.id)).toMatchObject({ pinned: false })
    expect(t.tab(b.id)).toMatchObject({ pinned: false })
    expect(t.folders()).toEqual([])
  })

  it('removes the folder, and builds it no more, when they took every tab out', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id])])
    t.do({ type: 'tabs/move', ids: [a.id], toIndex: 0, pinned: false })
    t.mirror.sync([group(1, [a.id])])
    expect(t.folders()).toEqual([])
    const sent = t.sent.length
    t.mirror.sync([group(1, [a.id])])
    expect(t.sent).toHaveLength(sent)
    expect(t.folders()).toEqual([])
  })
})

describe('switching the function off', () => {
  it('puts everything back and removes the folders', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    const before = JSON.stringify(t.state.tabs.map((x) => [x.id, x.pinned, x.folderId, x.anchorUrl]))
    t.mirror.sync([group(1, [a.id]), group(2, [b.id], { collapsed: true })])
    expect(t.folders()).toHaveLength(2)
    t.mirror.release()
    expect(t.folders()).toEqual([])
    expect(JSON.stringify(t.state.tabs.map((x) => [x.id, x.pinned, x.folderId, x.anchorUrl]))).toBe(before)
    expect(t.mirror.placements().size).toBe(0)
  })

  it('puts the tabs back in the order they left in, with other tabs between them', () => {
    const t = setup()
    const x = t.open('https://x.example/')
    const a = t.open('https://a.example/')
    const y = t.open('https://y.example/')
    const b = t.open('https://b.example/')
    const z = t.open('https://z.example/')
    const order = () => t.state.tabs.map((tab) => tab.id)
    const before = order()
    t.mirror.sync([group(1, [b.id, a.id])])
    expect(order()).not.toEqual(before)
    t.mirror.release()
    expect(order()).toEqual(before)
    expect([x, y, z].every((tab) => !t.tab(tab.id).pinned)).toBe(true)
  })

  it('puts the tabs of two groups back in their order when they all go back together', () => {
    const t = setup()
    const [a, x, b, y, c] = ['a', 'x', 'b', 'y', 'c'].map((name) => t.open(`https://${name}.example/`))
    const before = t.state.tabs.map((tab) => tab.id)
    t.mirror.sync([group(2, [b!.id]), group(1, [c!.id, a!.id])])
    t.mirror.sync([])
    expect(t.state.tabs.map((tab) => tab.id)).toEqual(before)
    expect([x, y].every((tab) => !t.tab(tab!.id).pinned)).toBe(true)
  })

  it('puts the tabs of a group that ends alone back among the tabs that are there, none of them pinned or lost', () => {
    const t = setup()
    const [a, x, b, y, c] = ['a', 'x', 'b', 'y', 'c'].map((name) => t.open(`https://${name}.example/`))
    t.mirror.sync([group(1, [c!.id, a!.id]), group(2, [b!.id])])
    t.mirror.sync([group(1, [c!.id, a!.id])])
    expect(t.tab(b!.id)).toMatchObject({ pinned: false })
    expect(t.tab(b!.id).folderId).toBeUndefined()
    expect(t.folders()).toHaveLength(1)
    expect([a, x, b, y, c].map((tab) => tab!.id).sort()).toEqual(t.state.tabs.map((tab) => tab.id).sort())
  })

  it('keeps its records when the store refuses half way, so that the files still do not hold the folders', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const state = () => t.state
    let refuse = false
    const mirror = new GroupFolders({
      state,
      dispatch: (action) => {
        if (refuse) throw new Error('refused')
        t.do(action)
      }
    })
    mirror.sync([group(1, [a.id])])
    expect(t.folders()).toHaveLength(1)
    refuse = true
    expect(() => mirror.release()).toThrow('refused')
    expect(mirror.placements().size).toBe(1)
    expect(withoutMirroredFolders(t.state, mirror.placements()).folders).toEqual([])
    // Once the store answers again, the work is finished.
    refuse = false
    mirror.release()
    expect(mirror.placements().size).toBe(0)
    expect(t.folders()).toEqual([])
  })

  it('shows the groups again when it is switched on again', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id])])
    t.mirror.release()
    t.mirror.sync([group(1, [a.id])])
    expect(t.folders()).toHaveLength(1)
  })
})

describe('the files', () => {
  afterEach(() => {
    // Whatever a test set, the registry is empty for the next one.
    const source = () => new Map()
    setGroupMirror(source)
    clearGroupMirror(source)
  })

  it('never hold the folders of the groups: the tabs are written where they were', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const b = t.open('https://b.example/')
    t.do({ type: 'tab/pin', id: b.id })
    t.mirror.sync([group(1, [a.id, b.id], { title: 'Veille' })])
    const live = t.state
    expect(live.folders).toHaveLength(1)
    const written = withoutMirroredFolders(live, t.mirror.placements())
    expect(written.folders).toEqual([])
    expect(written.tabs.find((x) => x.id === a.id)).toMatchObject({ pinned: false })
    expect(written.tabs.find((x) => x.id === a.id)!.folderId).toBeUndefined()
    expect(written.tabs.find((x) => x.id === a.id)!.anchorUrl).toBeUndefined()
    expect(written.tabs.find((x) => x.id === b.id)).toMatchObject({ pinned: true })
    expect(written.tabs.find((x) => x.id === b.id)!.folderId).toBeUndefined()
    // …and the state in memory is the same as before.
    expect(t.state).toBe(live)
  })

  it('write the tabs in the order the application puts them back in', () => {
    const t = setup()
    const [x, a, y, b] = ['x', 'a', 'y', 'b'].map((name) => t.open(`https://${name}.example/`))
    const before = t.state.tabs.map((tab) => tab.id)
    t.mirror.sync([group(1, [a!.id, b!.id])])
    const written = withoutMirroredFolders(t.state, t.mirror.placements())
    expect(written.tabs.map((tab) => tab.id)).toEqual(before)
    t.mirror.release()
    expect(written.tabs.map((tab) => [tab.id, tab.pinned, tab.folderId])).toEqual(t.state.tabs.map((tab) => [tab.id, tab.pinned, tab.folderId]))
    expect([x, y].length).toBe(2)
  })

  it('go through the same door as everything that is written', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id])])
    const source = () => t.mirror.placements()
    expect(persistableState(t.state).folders).toHaveLength(1)
    setGroupMirror(source)
    expect(persistableState(t.state).folders).toEqual([])
    expect(withoutGroupFolders(t.state).folders).toEqual([])
    clearGroupMirror(source)
    expect(persistableState(t.state).folders).toHaveLength(1)
  })

  it('are not touched by a mirror that has been started again since: only the one in force is cleared', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    t.mirror.sync([group(1, [a.id])])
    const old = () => new Map()
    const current = () => t.mirror.placements()
    setGroupMirror(old)
    setGroupMirror(current)
    clearGroupMirror(old)
    expect(persistableState(t.state).folders).toEqual([])
    clearGroupMirror(current)
    expect(persistableState(t.state).folders).toHaveLength(1)
  })

  it('keep a tab the user put in the folder by hand pinned at the root, and a sub-folder they made inside it at the root of the space', () => {
    const t = setup()
    const a = t.open('https://a.example/')
    const mine = t.open('https://mine.example/')
    t.mirror.sync([group(1, [a.id])])
    const folderId = t.folders()[0]!.id
    t.do({ type: 'tabs/move', ids: [mine.id], toIndex: 0, pinned: true, folderId })
    t.do({ type: 'folder/create', name: 'Dedans', parentId: folderId })
    const written = withoutMirroredFolders(t.state, t.mirror.placements())
    expect(written.tabs.find((x) => x.id === mine.id)).toMatchObject({ pinned: true })
    expect(written.tabs.find((x) => x.id === mine.id)!.folderId).toBeUndefined()
    expect(written.folders.map((f) => [f.name, f.parentId])).toEqual([['Dedans', undefined]])
  })

  it('are the same state, object for object, when no folder mirrors a group', () => {
    const t = setup()
    t.open('https://a.example/')
    expect(withoutMirroredFolders(t.state, new Map())).toBe(t.state)
    expect(withoutMirroredFolders(t.state, new Map([['not-a-folder', new Map()]]))).toBe(t.state)
    expect(withoutGroupFolders(t.state)).toBe(t.state)
  })
})
