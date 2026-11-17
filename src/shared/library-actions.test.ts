import { describe, expect, it } from 'vitest'
import { interfaceMayDispatch, MAIN_ONLY_ACTIONS } from './ipc-policy'
import { BOOKMARKS_LIMIT, defaultSettings, type Bookmark, type SidebarState } from './model'
import { canOpenInPrivate, createPrivateState, privateAction, scrubPrivateState } from './private-window'
import { LIVE_FOLDERS_MAX, LIVE_ITEMS_MAX, type LiveFolder } from './live-folders'
import { createInitialState, normalize, parseSavedState, persistableState, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(now = 1_000_000): Ctx {
  let n = 0
  return { now, newId: () => `id${++n}` }
}
const bm = (n: number, over: Partial<Bookmark> = {}): Bookmark => ({ id: `b${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, tags: [], addedAt: n, ...over })

/** A state with the setting on and the given tabs open (the last selected). */
function open(urls: string[], settings: Partial<SidebarState['settings']> = { bookmarkManager: true }, ctx = makeCtx()): SidebarState {
  let state = createInitialState(ctx)
  state = { ...state, settings: { ...state.settings, ...settings } }
  for (const url of urls) state = reduce(state, { type: 'tab/open', url }, ctx)
  return state
}
const run = (state: SidebarState, action: Action, ctx = makeCtx()): SidebarState => reduce(state, action, ctx)

describe('bookmark actions', () => {
  it('are off by default and do nothing at all with the setting off, whatever the state holds', () => {
    expect(defaultSettings().bookmarkManager).toBe(false)
    const ctx = makeCtx()
    const state = { ...open(['https://a.example/'], { bookmarkManager: false }, ctx), bookmarks: [bm(1, { tags: ['x'] })] }
    const tabId = state.tabs[0]!.id
    const actions: Action[] = [
      { type: 'bookmark/add', tabId },
      { type: 'bookmark/open', id: 'b1' },
      { type: 'bookmark/edit', id: 'b1', patch: { title: 'Autre' } },
      { type: 'bookmark/remove', id: 'b1' },
      { type: 'bookmark/tag-rename', from: 'x', to: 'y' },
      { type: 'bookmark/tag-delete', tag: 'x' },
      { type: 'bookmarks/import', entries: [{ url: 'https://new.example/' }] }
    ]
    for (const action of actions) expect(run(state, action), action.type).toBe(state)
  })

  it('"Ajouter aux signets" keeps the page at the top of the library, with its name and icon, and the tab stays open', () => {
    const ctx = makeCtx(42)
    let state = open(['https://a.example/'], { bookmarkManager: true }, ctx)
    state = { ...state, tabs: state.tabs.map((t) => ({ ...t, title: 'Page A', faviconUrl: 'https://a.example/i.png' })) }
    const tab = state.tabs[0]!
    const saved = run(state, { type: 'bookmark/add', tabId: tab.id, tags: ['À lire', 'a lire', 'dev'] }, ctx)
    expect(saved.bookmarks).toEqual([{ id: expect.any(String), url: 'https://a.example/', title: 'Page A', tags: ['À lire', 'dev'], faviconUrl: 'https://a.example/i.png', addedAt: 42 }])
    expect(saved.tabs).toEqual(state.tabs)
    expect(saved.favorites).toEqual([])
    const second = run({ ...saved, tabs: [...saved.tabs, { ...tab, id: 't2', url: 'https://b.example/' }] }, { type: 'bookmark/add', tabId: 't2' }, ctx)
    expect(second.bookmarks.map((b) => b.url)).toEqual(['https://b.example/', 'https://a.example/'])
  })

  it('changes nothing for a page already there, a full library, a page that is not a web page, a private tab or an unknown tab', () => {
    const state = open(['https://a.example/', 'about:blank', 'https://p.example/'])
    const [a, blank, priv] = state.tabs as [typeof state.tabs[0], typeof state.tabs[0], typeof state.tabs[0]]
    const withA = run(state, { type: 'bookmark/add', tabId: a!.id })
    expect(run(withA, { type: 'bookmark/add', tabId: a!.id })).toBe(withA)
    expect(run(state, { type: 'bookmark/add', tabId: blank!.id })).toBe(state)
    expect(run({ ...state, tabs: state.tabs.map((t) => (t.id === priv!.id ? { ...t, private: true } : t)) }, { type: 'bookmark/add', tabId: priv!.id }).bookmarks).toEqual([])
    expect(run(state, { type: 'bookmark/add', tabId: 'inconnu' })).toBe(state)
    const full = { ...state, bookmarks: Array.from({ length: BOOKMARKS_LIMIT }, (_, i) => bm(i + 1)) }
    expect(run(full, { type: 'bookmark/add', tabId: a!.id })).toBe(full)
  })

  it('opens a bookmark in a new tab of the space and keeps it in the library', () => {
    const state = { ...open([]), bookmarks: [bm(1)] }
    const opened = run(state, { type: 'bookmark/open', id: 'b1' })
    expect(opened.tabs.map((t) => t.url)).toEqual(['https://site1.example/page'])
    expect(opened.bookmarks).toEqual(state.bookmarks)
    expect(run(state, { type: 'bookmark/open', id: 'inconnu' })).toBe(state)
  })

  it('edits the title, address, note and tags of a bookmark, repaired, and nothing else', () => {
    const state = { ...open([]), bookmarks: [bm(1, { note: 'vieille note' }), bm(2)] }
    const edited = run(state, { type: 'bookmark/edit', id: 'b1', patch: { title: 'Nouveau', url: 'https://nouveau.example/', tags: ['A', 'a', 'b,c', '#d'], note: '' } })
    expect(edited.bookmarks[0]).toEqual({ id: 'b1', url: 'https://nouveau.example/', title: 'Nouveau', tags: ['A', 'b c', 'd'], addedAt: 1 })
    expect(edited.bookmarks[1]).toBe(state.bookmarks[1])
  })

  it('refuses a title that is blank (the old one stays), an address that is not a web page or that another bookmark has, and a patch that is not one', () => {
    const state = { ...open([]), bookmarks: [bm(1), bm(2)] }
    expect(run(state, { type: 'bookmark/edit', id: 'b1', patch: { title: '   ' } })).toBe(state)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'pas une adresse', 'https://site2.example/page', 'HTTPS://SITE2.example/page']) {
      expect(run(state, { type: 'bookmark/edit', id: 'b1', patch: { url } }), url).toBe(state)
    }
    for (const patch of [null, 7, 'x', [], { title: 5, url: 5, tags: 5, note: 5 }]) expect(run(state, { type: 'bookmark/edit', id: 'b1', patch: patch as never }), String(patch)).toBe(state)
    expect(run(state, { type: 'bookmark/edit', id: 'inconnu', patch: { title: 'x' } })).toBe(state)
    expect(run(state, { type: 'bookmark/edit', id: 'b1', patch: { title: 'Page 1' } })).toBe(state)
  })

  it('removes a bookmark, renames a tag everywhere and takes a tag off everywhere', () => {
    const state = { ...open([]), bookmarks: [bm(1, { tags: ['x', 'y'] }), bm(2, { tags: ['x'] })] }
    expect(run(state, { type: 'bookmark/remove', id: 'b1' }).bookmarks.map((b) => b.id)).toEqual(['b2'])
    expect(run(state, { type: 'bookmark/remove', id: 'inconnu' })).toBe(state)
    expect(run(state, { type: 'bookmark/tag-rename', from: 'X', to: 'z' }).bookmarks.map((b) => b.tags)).toEqual([['z', 'y'], ['z']])
    expect(run(state, { type: 'bookmark/tag-delete', tag: 'x' }).bookmarks.map((b) => b.tags)).toEqual([['y'], []])
    expect(run(state, { type: 'bookmark/tag-delete', tag: 'inconnu' })).toBe(state)
  })

  it('takes an import as entries of its own, each checked again, and the interface cannot send one', () => {
    const state = { ...open([]), bookmarks: [bm(1)] }
    const imported = run(state, { type: 'bookmarks/import', entries: [{ url: 'https://new.example/', title: 'Neuf', tags: ['i'] }, { url: 'javascript:alert(1)' }, { url: 'https://site1.example/page', tags: ['plus'] }] })
    expect(imported.bookmarks.map((b) => [b.url, b.tags])).toEqual([['https://site1.example/page', ['plus']], ['https://new.example/', ['i']]])
    expect(run(state, { type: 'bookmarks/import', entries: [{ url: 'javascript:1' }] })).toBe(state)
    expect(run(state, { type: 'bookmarks/import', entries: 'x' as never })).toBe(state)
    expect(MAIN_ONLY_ACTIONS.has('bookmarks/import')).toBe(true)
    expect(interfaceMayDispatch({ type: 'bookmarks/import', entries: [] }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'bookmark/add', tabId: 'x' }, [])).toBe(true)
  })

  it('leave the favourites, the pinned tabs and the read-later list alone', () => {
    const ctx = makeCtx()
    let state = open(['https://a.example/'], { bookmarkManager: true }, ctx)
    state = run(state, { type: 'tab/pin', id: state.tabs[0]!.id }, ctx)
    state = run(state, { type: 'favorite/add', url: 'https://fav.example/', title: 'Fav' }, ctx)
    const before = { favorites: state.favorites, tabs: state.tabs, folders: state.folders, readLater: state.readLater }
    state = run(state, { type: 'bookmark/add', tabId: state.tabs[0]!.id }, ctx)
    state = run(state, { type: 'bookmark/remove', id: state.bookmarks[0]!.id }, ctx)
    expect({ favorites: state.favorites, tabs: state.tabs, folders: state.folders, readLater: state.readLater }).toEqual(before)
  })
})

describe('the library and the places that do not keep it', () => {
  it('survives the state file, and a damaged one is repaired entry by entry', () => {
    const state = { ...open([]), bookmarks: [bm(1, { tags: ['a'], note: 'n' })] }
    expect(parseSavedState(JSON.stringify(persistableState(state))).bookmarks).toEqual(state.bookmarks)
    const damaged = normalize({ ...state, bookmarks: [bm(1), { id: 'x', url: 'javascript:1', title: 't', tags: [], addedAt: 1 }, null, 7] as never })
    expect(damaged.bookmarks.map((b) => b.id)).toEqual(['b1'])
    expect(normalize({ ...state, bookmarks: 'x' as never }).bookmarks).toEqual([])
  })

  it('a private window refuses every action of the library, keeps none and opens no panel of it', () => {
    const actions: Action[] = [
      { type: 'bookmark/add', tabId: 't' },
      { type: 'bookmark/open', id: 'b' },
      { type: 'bookmark/edit', id: 'b', patch: {} },
      { type: 'bookmark/remove', id: 'b' },
      { type: 'bookmark/tag-rename', from: 'a', to: 'b' },
      { type: 'bookmark/tag-delete', tag: 'a' },
      { type: 'bookmarks/import', entries: [] },
      { type: 'livefolder/create', source: { kind: 'feed', url: 'https://a.example/f' } },
      { type: 'livefolder/edit', id: 'f' },
      { type: 'livefolder/refresh' },
      { type: 'livefolder/result', id: 'f', source: { kind: 'feed', url: 'https://a.example/f' }, items: [] }
    ]
    for (const action of actions) expect(privateAction(action), action.type).toBeNull()
    expect(canOpenInPrivate('bookmarks')).toBe(false)
    expect(canOpenInPrivate('livefolder')).toBe(false)
    const ctx = makeCtx()
    const main = { ...open([], { bookmarkManager: true, liveFolders: true }), bookmarks: [bm(1)] }
    expect(createPrivateState(main, ctx).bookmarks).toEqual([])
    const scrubbed = scrubPrivateState({ ...createPrivateState(main, ctx), bookmarks: [bm(1)] })
    expect(scrubbed.bookmarks).toEqual([])
    expect(scrubPrivateState(scrubbed)).toBe(scrubbed)
  })
})

describe('live folder actions', () => {
  const source = { kind: 'feed', url: 'https://a.example/feed' } as const
  const on = (ctx = makeCtx()) => open([], { liveFolders: true }, ctx)
  const created = (state: SidebarState, ctx = makeCtx()): SidebarState => run(state, { type: 'livefolder/create', source, name: 'Mon flux' }, ctx)

  it('are off by default and do nothing with the setting off, even for a live folder the state holds', () => {
    expect(defaultSettings().liveFolders).toBe(false)
    const state = created(on())
    const off = { ...state, settings: { ...state.settings, liveFolders: false } }
    const id = off.folders[0]!.id
    for (const action of [
      { type: 'livefolder/create', source } as Action,
      { type: 'livefolder/edit', id, name: 'x' } as Action,
      { type: 'livefolder/refresh' } as Action,
      { type: 'livefolder/result', id, source, items: [{ title: 't', url: 'https://a.example/1' }] } as Action
    ]) {
      expect(run(off, action), action.type).toBe(off)
    }
  })

  it('creates a folder of the space that fills itself from the source, and nothing else changes', () => {
    const base = on()
    const state = created(base)
    expect(state.folders).toEqual([{ id: expect.any(String), spaceId: base.activeSpaceId, name: 'Mon flux', collapsed: false, live: { source, items: [] } }])
    expect(state.tabs).toEqual(base.tabs)
    expect(created(on()).folders[0]!.live?.checkedAt).toBeUndefined()
  })

  it('names a folder after its source when the name is blank, and refuses a source that is not one', () => {
    const named = run(on(), { type: 'livefolder/create', source, name: '  ' })
    expect(named.folders[0]!.name).toBe('a.example')
    const state = on()
    for (const bad of [null, 'x', {}, { kind: 'feed', url: 'javascript:1' }, { kind: 'github', repo: '../x', what: 'releases' }]) expect(run(state, { type: 'livefolder/create', source: bad as never }), JSON.stringify(bad)).toBe(state)
  })

  it('stops at LIVE_FOLDERS_MAX live folders', () => {
    const ctx = makeCtx()
    let state = on(ctx)
    for (let i = 0; i < LIVE_FOLDERS_MAX + 3; i++) state = run(state, { type: 'livefolder/create', source: { kind: 'feed', url: `https://a.example/${i}` } }, ctx)
    expect(state.folders.filter((f) => f.live).length).toBe(LIVE_FOLDERS_MAX)
  })

  it('creates inside a folder that exists (in its space) and never in a space or a folder that does not', () => {
    const ctx = makeCtx()
    let state = on(ctx)
    state = run(state, { type: 'folder/create', name: 'Parent' }, ctx)
    const parent = state.folders[0]!
    const inside = run(state, { type: 'livefolder/create', source, parentId: parent.id }, ctx)
    expect(inside.folders.at(-1)).toMatchObject({ parentId: parent.id, spaceId: parent.spaceId })
    expect(run(state, { type: 'livefolder/create', source, parentId: 'inconnu' }, ctx)).toBe(state)
    const elsewhere = run(state, { type: 'livefolder/create', source, spaceId: 'inconnu' }, ctx)
    expect(elsewhere.folders.at(-1)!.spaceId).toBe(state.activeSpaceId)
  })

  it('records what a look found, for the source that was looked at only', () => {
    const state = created(on())
    const id = state.folders[0]!.id
    const items = [{ title: 'Un', url: 'https://a.example/1' }, { title: 'Piège', url: 'javascript:alert(1)' }]
    const worked = run(state, { type: 'livefolder/result', id, source, items }, makeCtx(5000))
    expect(worked.folders[0]!.live).toEqual({ source, items: [{ title: 'Un', url: 'https://a.example/1' }], checkedAt: 5000 })
    const failed = run(worked, { type: 'livefolder/result', id, source, failure: 'HTTP 500' }, makeCtx(6000))
    expect(failed.folders[0]!.live).toMatchObject({ items: [{ title: 'Un', url: 'https://a.example/1' }], checkedAt: 6000, failure: 'HTTP 500' })
    // The source was changed while the look was under way, the folder was deleted, or the answer names a source that is not the folder's: ignored.
    const other = { kind: 'feed', url: 'https://autre.example/feed' } as const
    expect(run(worked, { type: 'livefolder/result', id, source: other, items }, makeCtx(7000))).toBe(worked)
    expect(run(worked, { type: 'livefolder/result', id: 'inconnu', source, items })).toBe(worked)
    expect(run(worked, { type: 'livefolder/result', id: worked.folders[0]!.id, source: 'x' as never, items })).toBe(worked)
    expect(MAIN_ONLY_ACTIONS.has('livefolder/result')).toBe(true)
    expect(interfaceMayDispatch({ type: 'livefolder/result', id, source, items }, [])).toBe(false)
  })

  it('keeps at most LIVE_ITEMS_MAX items of a look', () => {
    const state = created(on())
    const many = Array.from({ length: LIVE_ITEMS_MAX + 20 }, (_, i) => ({ title: `T${i}`, url: `https://a.example/${i}` }))
    expect(run(state, { type: 'livefolder/result', id: state.folders[0]!.id, source, items: many }).folders[0]!.live!.items).toHaveLength(LIVE_ITEMS_MAX)
  })

  it('makes a folder due at once on refresh, only if it was looked at, and lets another source start afresh', () => {
    const ctx = makeCtx(100)
    let state = created(on(ctx), ctx)
    const id = state.folders[0]!.id
    expect(run(state, { type: 'livefolder/refresh', id })).toBe(state)
    state = run(state, { type: 'livefolder/result', id, source, items: [{ title: 'Un', url: 'https://a.example/1' }] }, ctx)
    const refreshed = run(state, { type: 'livefolder/refresh' })
    expect(refreshed.folders[0]!.live).toEqual({ source, items: [{ title: 'Un', url: 'https://a.example/1' }] })
    expect(run(state, { type: 'livefolder/refresh', id: 'inconnu' })).toBe(state)
    const other = { kind: 'github', repo: 'o/r', what: 'releases' } as const
    const edited = run(state, { type: 'livefolder/edit', id, source: other, name: 'Dépôt' })
    expect(edited.folders[0]).toMatchObject({ name: 'Dépôt', live: { source: other, items: [] } })
    expect(edited.folders[0]!.live!.checkedAt).toBeUndefined()
    expect(run(state, { type: 'livefolder/edit', id, source: { kind: 'feed', url: 'file:///x' } as never })).toBe(state)
    expect(run(state, { type: 'livefolder/edit', id, name: 'Autre' }).folders[0]!.live!.items).toHaveLength(1)
    expect(run(state, { type: 'livefolder/edit', id })).toBe(state)
  })

  it('does not touch an ordinary folder, and the usual folder actions keep the live part', () => {
    const ctx = makeCtx()
    let state = run(on(ctx), { type: 'folder/create', name: 'Ordinaire' }, ctx)
    const plain = state.folders[0]!
    expect(run(state, { type: 'livefolder/edit', id: plain.id, name: 'x' })).toBe(state)
    state = created(state, ctx)
    const live = state.folders[1]!
    expect(run(state, { type: 'folder/rename', id: live.id, name: 'Renommé' }, ctx).folders[1]!.live).toEqual(live.live)
    expect(run(state, { type: 'folder/duplicate', id: live.id }, ctx).folders[2]!.live).toEqual(live.live)
    expect(run(state, { type: 'folder/delete', id: live.id }, ctx).folders.map((f) => f.id)).toEqual([plain.id])
  })

  it('survives the state file; a source that is not one makes an ordinary folder of it', () => {
    const state = created(on())
    const id = state.folders[0]!.id
    const worked = run(state, { type: 'livefolder/result', id, source, items: [{ title: 'Un', url: 'https://a.example/1' }] }, makeCtx(5000))
    expect(parseSavedState(JSON.stringify(persistableState(worked))).folders).toEqual(worked.folders)
    const damaged = normalize({ ...worked, folders: worked.folders.map((f) => ({ ...f, live: { ...f.live!, source: { kind: 'feed', url: 'file:///etc/passwd' } } })) as never })
    expect(damaged.folders[0]!.live).toBeUndefined()
    expect(damaged.folders[0]!.name).toBe('Mon flux')
  })

  it('keeps the live part of the first LIVE_FOLDERS_MAX folders of a file and turns the others into ordinary folders', () => {
    const base = on()
    const folders = Array.from({ length: LIVE_FOLDERS_MAX + 4 }, (_, i): LiveFolder & { id: string } => ({ id: `f${i}`, source: { kind: 'feed', url: `https://a.example/${i}` }, items: [] }))
    const state = normalize({ ...base, folders: folders.map(({ id, ...live }) => ({ id, spaceId: base.activeSpaceId, name: id, collapsed: false, live })) })
    expect(state.folders).toHaveLength(LIVE_FOLDERS_MAX + 4)
    expect(state.folders.filter((f) => f.live).length).toBe(LIVE_FOLDERS_MAX)
  })
})
