import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { project, selectionOf, blankSelection } from './window-selection'
import { changesSession, decideTransfer, leavesWindowEmpty, tabIsLive, type TransferOrder, type TransferRequest } from './tab-transfer'
import type { DropTarget } from './dnd'

let counter = 0
const ctx: Ctx = { now: 1_000_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

/**
 * Two windows over one state. The "Communication" window shows its space (profile `default`), the "Work" window shows another space of its own
 * profile; "Famille" is a third space on the profile of Communication. Communication holds the tabs a, b, c (b pinned in a folder "Docs"), Work holds w1, w2 (w1 pinned) and Famille f1.
 */
function setup(extra: { independent?: boolean } = {}) {
  counter = 0
  let s = createInitialState(ctx)
  const comm = s.activeSpaceId
  s = run(s, { type: 'space/create', name: 'Work', emoji: '💼', hue: 200, profileName: 'Travail' })
  const work = s.spaces.find((sp) => sp.name === 'Work')!.id
  s = run(s, { type: 'space/create', name: 'Famille', emoji: '🏠', hue: 20, profileId: 'default' })
  const family = s.spaces.find((sp) => sp.name === 'Famille')!.id
  s = run(s, { type: 'folder/create', name: 'Docs', spaceId: comm }, { type: 'folder/create', name: 'Dossier', spaceId: work })
  const docs = s.folders.find((f) => f.name === 'Docs')!.id
  const folder = s.folders.find((f) => f.name === 'Dossier')!.id
  for (const [name, spaceId] of [['a', comm], ['b', comm], ['c', comm], ['w1', work], ['w2', work], ['f1', family]] as const) s = run(s, { type: 'tab/open', url: `https://${name}.fr/`, spaceId, background: true })
  const id = (n: string) => s.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
  s = run(s, { type: 'tab/move', id: id('b'), toIndex: 0, pinned: true, folderId: docs }, { type: 'tab/move', id: id('w1'), toIndex: 0, pinned: true })
  if (extra.independent) s = { ...s, settings: { ...s.settings, independentWindows: true } }
  /** The view of the window that shows `spaceId`. */
  const view = (state: SidebarState, spaceId: string) => project(state, blankSelection(state, spaceId))
  const request = (over: Partial<TransferRequest> & { ids: string[]; target: DropTarget }, spaceId: string = work): TransferRequest => ({
    shared: s,
    view: view(s, spaceId),
    from: { key: 'main', private: false },
    to: { key: 'window-1', private: false },
    ...over
  })
  return { s, comm, work, family, docs, folder, id, view, request }
}

const order = (decision: ReturnType<typeof decideTransfer>): TransferOrder => {
  expect(decision.ok, JSON.stringify(decision)).toBe(true)
  return decision as TransferOrder
}

describe('which windows may exchange tabs', () => {
  it('refuses a private window, and a guest one, on either side', () => {
    const { id, request } = setup()
    const target: DropTarget = { kind: 'today' }
    expect(decideTransfer(request({ ids: [id('a')], target, from: { key: 'private-1', private: true } }))).toEqual({ ok: false, reason: 'private-window' })
    expect(decideTransfer(request({ ids: [id('a')], target, to: { key: 'guest-1', private: true } }))).toEqual({ ok: false, reason: 'private-window' })
  })

  it('refuses a drop on the window the tabs come from: that is an ordinary drag', () => {
    const { id, request } = setup()
    expect(decideTransfer(request({ ids: [id('a')], target: { kind: 'today' }, to: { key: 'main', private: false } }))).toEqual({ ok: false, reason: 'same-window' })
  })
})

describe('which tabs are moved', () => {
  it('keeps the order it was given and moves a tab once', () => {
    const { id, request } = setup()
    const out = order(decideTransfer(request({ ids: [id('c'), id('a'), id('c')], target: { kind: 'today' } })))
    expect(out.ids).toEqual([id('c'), id('a')])
    expect(out.select).toBe(id('c'))
  })

  it('leaves out what does not exist and the page of a favourite, which has no row', () => {
    const { s, comm, id, request } = setup()
    const added = run(s, { type: 'favorite/add', url: 'https://fav.fr/', title: 'Fav', spaceId: comm })
    const withFavorite = run(added, { type: 'favorite/open', id: added.favorites[0]!.id, spaceId: comm })
    const favoriteTab = withFavorite.tabs.find((t) => t.favoriteId !== undefined)
    // The page of a favourite is a tab, but it is its tile that is dragged, never a row.
    expect(favoriteTab).toBeDefined()
    const out = order(decideTransfer({ ...request({ ids: [id('a'), 'nope', favoriteTab!.id], target: { kind: 'today' } }), shared: withFavorite }))
    expect(out.ids).toEqual([id('a')])
    expect(decideTransfer(request({ ids: ['nope'], target: { kind: 'today' } }))).toEqual({ ok: false, reason: 'no-tabs' })
    expect(decideTransfer(request({ ids: [], target: { kind: 'today' } }))).toEqual({ ok: false, reason: 'no-tabs' })
  })

  it('moves a tab that is already in the space the other window shows: it only changes window', () => {
    const { work, id, request } = setup()
    const out = order(decideTransfer(request({ ids: [id('w2')], target: { kind: 'today' } })))
    expect(out.spaceId).toBe(work)
    expect(out.respace).toEqual([])
    expect(out.newSession).toEqual([])
  })
})

describe('the profile of the space the tabs land in', () => {
  it('keeps the session of a tab that goes to a space of the same profile, and its history with it', () => {
    const { family, id, request } = setup()
    const out = order(decideTransfer(request({ ids: [id('a'), id('c')], target: { kind: 'today' } }, family)))
    expect(out.respace).toEqual([id('a'), id('c')])
    expect(out.newSession).toEqual([])
    expect(out.keepHistory).toEqual([id('a'), id('c')])
  })

  it('makes the page again in the other profile\'s session, from its address alone', () => {
    const { id, request } = setup()
    const out = order(decideTransfer(request({ ids: [id('a'), id('c')], target: { kind: 'today' } })))
    expect(out.respace).toEqual([id('a'), id('c')])
    expect(out.newSession).toEqual([id('a'), id('c')])
    expect(out.keepHistory).toEqual([])
  })

  it('does not call a private tab or a tab of a container a change of session: its page never used the profile', () => {
    const { s, id, request } = setup()
    let mixed = run(s, { type: 'tab/open', url: 'https://secret.fr/', spaceId: s.spaces[0]!.id, private: true, background: true })
    const secret = mixed.tabs.find((t) => t.url === 'https://secret.fr/')!.id
    mixed = { ...mixed, settings: { ...mixed.settings, tabContainers: true, containers: [{ id: 'bank', name: 'Banque', color: 'blue' }] }, tabs: mixed.tabs.map((t) => (t.id === id('c') ? { ...t, container: 'bank' } : t)) }
    const out = order(decideTransfer({ ...request({ ids: [id('a'), secret, id('c')], target: { kind: 'today' } }), shared: mixed }))
    expect(out.respace).toEqual([id('a'), secret, id('c')])
    expect(out.newSession).toEqual([id('a')])
    expect(out.keepHistory).toEqual([secret, id('c')])
  })

  it('lets the page of a tab moved to another space of one window live on when the profile stays (the menu "Déplacer vers")', () => {
    const { s, family, work, id } = setup()
    const a = s.tabs.find((t) => t.id === id('a'))!
    expect(changesSession(s, a, family)).toBe(false)
    expect(changesSession(s, a, work)).toBe(true)
  })

  it('calls a page live while it plays sound or a media element of it plays, so that its reload is asked first', () => {
    const idle = { loading: false, audible: false, muted: false, awake: true }
    expect(tabIsLive(undefined)).toBe(false)
    expect(tabIsLive(idle)).toBe(false)
    expect(tabIsLive({ ...idle, audible: true })).toBe(true)
    expect(tabIsLive({ ...idle, playing: true })).toBe(true)
  })
})

describe('the place in the sidebar of the target window', () => {
  it('puts the tabs after the last of Today, or before the row they were dropped on', () => {
    const { id, request } = setup()
    expect(order(decideTransfer(request({ ids: [id('a')], target: { kind: 'today' } }))).placement).toMatchObject({ toIndex: 1, pinned: false })
    expect(order(decideTransfer(request({ ids: [id('a')], target: { kind: 'tab', id: id('w2'), edge: 'before' } }))).placement).toMatchObject({ toIndex: 0, pinned: false })
    expect(order(decideTransfer(request({ ids: [id('a')], target: { kind: 'tab', id: id('w2'), edge: 'after' } }))).placement).toMatchObject({ toIndex: 1, pinned: false })
  })

  it('pins the tabs dropped on a pinned row, and puts them in the folder they were dropped on', () => {
    const { folder, id, request } = setup()
    expect(order(decideTransfer(request({ ids: [id('a')], target: { kind: 'tab', id: id('w1'), edge: 'after' } }))).placement).toMatchObject({ toIndex: 1, pinned: true })
    const inFolder = order(decideTransfer(request({ ids: [id('a'), id('c')], target: { kind: 'folder', id: folder } })))
    expect(inFolder.placement).toMatchObject({ pinned: true, folderId: folder })
    expect(order(decideTransfer(request({ ids: [id('a')], target: { kind: 'folder', id: null } }))).placement).toMatchObject({ pinned: true })
  })

  it('refuses a place that means nothing: a folder or a row of another space, a row that is not there', () => {
    const { docs, id, request } = setup()
    for (const target of [{ kind: 'folder', id: docs }, { kind: 'tab', id: id('c'), edge: 'before' }, { kind: 'tab', id: 'nope', edge: 'before' }, { kind: 'folder', id: 'nope' }] satisfies DropTarget[]) {
      expect(decideTransfer(request({ ids: [id('a')], target })), JSON.stringify(target)).toEqual({ ok: false, reason: 'no-place' })
    }
  })

  it('refuses the favourites and the footer: only the list of tabs takes a tab from another window', () => {
    const { work, id, request } = setup()
    for (const target of [{ kind: 'favorite', id: null, edge: 'after' }, { kind: 'space', id: work }, { kind: 'folder-at', id: 'x', edge: 'inside' }] satisfies DropTarget[]) {
      expect(decideTransfer(request({ ids: [id('a')], target })), target.kind).toEqual({ ok: false, reason: 'no-place' })
    }
  })

  it('refuses a drop beside one of the dragged tabs themselves', () => {
    const { id, request } = setup()
    expect(decideTransfer(request({ ids: [id('w2')], target: { kind: 'tab', id: id('w2'), edge: 'after' } }))).toEqual({ ok: false, reason: 'no-place' })
  })

  it('never pins a private tab, alone or in a selection: the drop is refused as a whole, and Today takes it', () => {
    const { s, work, id, request } = setup()
    const withPrivate = run(s, { type: 'tab/open', url: 'https://secret.fr/', spaceId: s.spaces[0]!.id, private: true, background: true })
    const secret = withPrivate.tabs.find((t) => t.url === 'https://secret.fr/')!.id
    const asked = (ids: string[], target: DropTarget) => decideTransfer({ ...request({ ids, target }), shared: withPrivate, view: project(withPrivate, blankSelection(withPrivate, work)) })
    expect(asked([secret], { kind: 'tab', id: id('w1'), edge: 'after' })).toEqual({ ok: false, reason: 'no-place' })
    expect(asked([id('a'), secret], { kind: 'folder', id: null })).toEqual({ ok: false, reason: 'no-place' })
    expect(asked([secret], { kind: 'today' }).ok).toBe(true)
    expect(asked([id('a'), secret], { kind: 'today' }).ok).toBe(true)
  })
})

describe('windows with tabs of their own', () => {
  it('hands the tabs to the window they land in, only while the setting is on', () => {
    const on = setup({ independent: true })
    expect(order(decideTransfer(on.request({ ids: [on.id('a')], target: { kind: 'today' } }))).ownerKey).toBe('window-1')
    const off = setup()
    expect(order(decideTransfer(off.request({ ids: [off.id('a')], target: { kind: 'today' } }))).ownerKey).toBeNull()
  })

  it('counts the places on what the target window lists, not on the tabs of the other windows', () => {
    const { s, work, id, request } = setup({ independent: true })
    // w2 belongs to the first window: the window of Work does not list it, so Today is empty there and the new tab is its first.
    const owned = { ...s, tabs: s.tabs.map((t) => (t.id === id('w2') ? { ...t, windowKey: 'window-3' } : t)) }
    const out = order(decideTransfer({ ...request({ ids: [id('a')], target: { kind: 'today' } }), shared: owned, view: project(owned, { ...blankSelection(owned, work) }, 'window-1') }))
    expect(out.placement).toMatchObject({ toIndex: 0, pinned: false })
  })

  it('reads the space the target window shows from its own view', () => {
    const { s, comm, work, id, request } = setup()
    const out = order(decideTransfer({ ...request({ ids: [id('w2')], target: { kind: 'today' } }), view: project(s, { ...selectionOf(s), spaceId: comm }) }))
    expect(out.spaceId).toBe(comm)
    expect(out.respace).toEqual([id('w2')])
    expect(work).not.toBe(comm)
  })
})

describe('the window the tabs leave', () => {
  // Windows with tabs of their own: "window-1" owns w1 and w2, "main" owns the rest.
  const own = (extra: { independent?: boolean } = { independent: true }) => {
    const w = setup(extra)
    const owned = { ...w.s, tabs: w.s.tabs.map((t) => (t.spaceId === w.work ? { ...t, windowKey: 'window-1' } : t)) }
    // Nothing pinned but w1 (the setup pins b too): a pinned tab is listed by every window.
    return { ...w, owned: { ...owned, tabs: owned.tabs.map((t) => (t.id === w.id('b') ? { ...t, pinned: false } : t)) } }
  }
  /** The shared state after the tabs `ids` went to `key`. */
  const given = (state: SidebarState, ids: string[], key: string): SidebarState => ({ ...state, tabs: state.tabs.map((t) => (ids.includes(t.id) ? { ...t, windowKey: key } : t)) })

  it('closes when the move took its last tab', () => {
    const { owned, id } = own()
    // w1 is pinned (shared by every window): the only tab left to window-1 is w2, unpinned first.
    const state = given({ ...owned, tabs: owned.tabs.map((t) => (t.id === id('w1') ? { ...t, pinned: false } : t)) }, [id('w1'), id('w2')], 'main')
    expect(leavesWindowEmpty('moved', state, 'window-1')).toBe(true)
  })

  it('stays open while it keeps a tab, and when the dragged tabs are only some of its own', () => {
    const { owned, id } = own()
    const unpinned = { ...owned, tabs: owned.tabs.map((t) => (t.id === id('w1') ? { ...t, pinned: false } : t)) }
    expect(leavesWindowEmpty('moved', given(unpinned, [id('w2')], 'main'), 'window-1')).toBe(false)
  })

  it('stays open on a pinned tab: pinned tabs are everybody\'s, the window still lists it', () => {
    const { owned, id } = own()
    expect(leavesWindowEmpty('moved', given(owned, [id('w2')], 'main'), 'window-1')).toBe(false)
  })

  it('never closes after a refused or a failed move: no tab is lost', () => {
    const { owned, id } = own()
    const empty = given({ ...owned, tabs: owned.tabs.map((t) => (t.id === id('w1') ? { ...t, pinned: false } : t)) }, [id('w1'), id('w2')], 'main')
    expect(leavesWindowEmpty('refused', empty, 'window-1')).toBe(false)
    expect(leavesWindowEmpty('failed', empty, 'window-1')).toBe(false)
  })

  it('never closes the main window, even left empty', () => {
    const { owned } = own()
    const state = { ...owned, tabs: owned.tabs.map((t) => ({ ...t, windowKey: 'window-1', pinned: false })) }
    expect(leavesWindowEmpty('moved', state, 'main')).toBe(false)
  })

  it('stays open when every window lists the same tabs (the setting off): nothing leaves it', () => {
    const { s } = setup()
    expect(leavesWindowEmpty('moved', s, 'window-1')).toBe(false)
  })
})
