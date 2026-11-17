import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import type { SidebarState, TabItem } from './model'
import { activeTab, createInitialState, parseSavedState, reduce, sidebarOrder, type Action, type Ctx } from './sidebar'
import {
  SESSIONS_MAX,
  SESSION_NAME_MAX,
  SESSION_TABS_MAX,
  SESSION_URL_MAX,
  autoSessionName,
  cleanSessionName,
  cleanSessions,
  isSessionUrl,
  restorableTabs,
  savableCount,
  sessionAge,
  tabsLabel
} from './sessions'
import { frenchSpaces } from './french-typography'

function makeCtx(now = 1_700_000_000_000): Ctx {
  let n = 0
  return { now, newId: () => `id${++n}` }
}

const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A space with two Today tabs, a pinned one and a pinned one in a folder, in that creation order. */
function workspace(ctx = makeCtx()) {
  let s = createInitialState(ctx)
  s = run(ctx, s, { type: 'tab/open', url: 'https://a.example/one', background: true }, { type: 'tab/open', url: 'https://b.example/two', background: true })
  const [a, b] = s.tabs
  s = run(ctx, s, { type: 'tab/update', id: a!.id, patch: { title: 'Titre A' } }, { type: 'tab/update', id: b!.id, patch: { title: 'Titre B' } })
  s = run(ctx, s, { type: 'tab/open', url: 'https://pin.example/home', background: true })
  const pinned = s.tabs.at(-1)!
  s = run(ctx, s, { type: 'tab/pin', id: pinned.id }, { type: 'tab/update', id: pinned.id, patch: { title: 'Épinglé' } })
  s = run(ctx, s, { type: 'tab/open', url: 'https://dir.example/doc', background: true })
  const filed = s.tabs.at(-1)!
  s = run(ctx, s, { type: 'folder/create-with', tabIds: [filed.id], name: 'Docs' }, { type: 'tab/update', id: filed.id, patch: { title: 'Dans un dossier' } })
  return { ctx, state: s, a: a!, b: b!, pinned, filed }
}

/** A tab added by hand: the reducer would refuse such an address, a damaged file or an older build might hold it. */
const rawTab = (state: SidebarState, url: string, over: Partial<TabItem> = {}): SidebarState => ({
  ...state,
  tabs: [...state.tabs, { id: `raw-${state.tabs.length}`, spaceId: state.activeSpaceId, url, title: url, pinned: false, createdAt: 1, lastActiveAt: 1, ...over }]
})

describe('session/save', () => {
  it('saves the tabs of the current space in the sidebar order: pinned, pinned in folders, then Today', () => {
    const { ctx, state } = workspace()
    const saved = run(ctx, state, { type: 'session/save', name: 'Projet X' })
    expect(saved.sessions).toHaveLength(1)
    const session = saved.sessions[0]!
    expect(session).toMatchObject({ name: 'Projet X', createdAt: ctx.now })
    expect(session.id).toMatch(/^id\d+$/)
    expect(session.tabs).toEqual([
      { url: 'https://pin.example/home', title: 'Épinglé', pinned: true },
      { url: 'https://dir.example/doc', title: 'Dans un dossier', pinned: true, folder: 'Docs' },
      { url: 'https://a.example/one', title: 'Titre A' },
      { url: 'https://b.example/two', title: 'Titre B' }
    ])
    // Saving changes nothing else: the tabs stay where they are.
    expect({ ...saved, sessions: [] }).toEqual({ ...state, sessions: [] })
  })

  it('keeps the name the user gave a tab, not the title of its page', () => {
    const { ctx, state, a } = workspace()
    const saved = run(ctx, state, { type: 'tab/rename', id: a.id, title: 'Mon onglet' }, { type: 'session/save', name: 's' })
    expect(saved.sessions[0]!.tabs.find((t) => t.url === a.url)!.title).toBe('Mon onglet')
  })

  it('keeps the page a pinned tab is pinned to, not the one it wandered off to, so that restoring never moves a pin', () => {
    const { ctx, state, pinned } = workspace()
    const wandered = run(ctx, state, { type: 'tab/update', id: pinned.id, patch: { url: 'https://pin.example/elsewhere/deep', title: 'Ailleurs' } }, { type: 'session/save', name: 's' })
    const tab = wandered.sessions[0]!.tabs.find((t) => t.pinned && !t.folder)!
    expect(tab).toEqual({ url: 'https://pin.example/home', title: 'pin.example', pinned: true })
  })

  it('leaves out what is not a web page or a local file (about:blank, the application\'s pages, view-source), as the Toolkit does', () => {
    const { ctx, state } = workspace()
    let dirty = state
    for (const url of ['about:blank', 'view-source:https://a.example/', `chrome-extension://${'a'.repeat(32)}/options.html`, 'devtools://devtools/bundled/inspector.html']) dirty = rawTab(dirty, url)
    dirty = rawTab(dirty, 'file:///Users/moi/notes.html')
    const saved = run(ctx, dirty, { type: 'session/save', name: 's' })
    expect(saved.sessions[0]!.tabs.map((t) => t.url)).toEqual(['https://pin.example/home', 'https://dir.example/doc', 'https://a.example/one', 'https://b.example/two', 'file:///Users/moi/notes.html'])
  })

  it('never keeps a script address, even one a damaged state holds in a tab', () => {
    const { ctx, state } = workspace()
    const saved = run(ctx, rawTab(rawTab(state, 'javascript:alert(1)'), 'data:text/html,<script>alert(1)</script>'), { type: 'session/save', name: 's' })
    expect(saved.sessions[0]!.tabs.map((t) => t.url).filter((u) => !/^https?:|^file:/.test(u))).toEqual([])
  })

  it('does not keep the tabs of the other spaces', () => {
    const { ctx, state } = workspace()
    const other = run(ctx, state, { type: 'space/create', name: 'Autre', emoji: '🧪', hue: 100 }, { type: 'tab/open', url: 'https://other.example/', background: true })
    expect(run(ctx, other, { type: 'session/save', name: 's' }).sessions[0]!.tabs.map((t) => t.url)).toEqual(['https://other.example/'])
  })

  it('names a session saved without a name after the date, as the Toolkit does', () => {
    const { ctx, state } = workspace()
    for (const name of [undefined, '', '   ', '\n\t']) {
      const saved = run(ctx, state, { type: 'session/save', ...(name === undefined ? {} : { name }) })
      expect(saved.sessions[0]!.name).toMatch(/^Session du \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
    }
  })

  it('trims the name, turns control characters into spaces and cuts it at the limit', () => {
    const { ctx, state } = workspace()
    expect(run(ctx, state, { type: 'session/save', name: '  Veille tech  ' }).sessions[0]!.name).toBe('Veille tech')
    expect(run(ctx, state, { type: 'session/save', name: 'a\u0000b\nc' }).sessions[0]!.name).toBe('a b c')
    const long = run(ctx, state, { type: 'session/save', name: 'x'.repeat(SESSION_NAME_MAX + 50) }).sessions[0]!.name
    expect(long).toHaveLength(SESSION_NAME_MAX)
    // A name that is not a text is a blank one.
    expect(run(ctx, state, { type: 'session/save', name: 42 as unknown as string }).sessions[0]!.name).toMatch(/^Session du /)
  })

  it('puts the newest session first and lets two sessions share a name and two tabs share an address (the Toolkit does not deduplicate)', () => {
    const { ctx, state } = workspace()
    const twice = rawTab(state, 'https://a.example/one')
    const saved = run(ctx, twice, { type: 'session/save', name: 'Même nom' }, { type: 'session/save', name: 'Même nom' })
    expect(saved.sessions.map((s) => s.name)).toEqual(['Même nom', 'Même nom'])
    expect(new Set(saved.sessions.map((s) => s.id)).size).toBe(2)
    expect(saved.sessions[0]!.tabs.filter((t) => t.url === 'https://a.example/one')).toHaveLength(2)
    const third = run(ctx, saved, { type: 'session/save', name: 'Dernière' })
    expect(third.sessions.map((s) => s.name)).toEqual(['Dernière', 'Même nom', 'Même nom'])
  })

  it('saves nothing, and returns the same state, when the space has no page to keep', () => {
    const ctx = makeCtx()
    const empty = createInitialState(ctx)
    expect(run(ctx, empty, { type: 'session/save', name: 'vide' })).toBe(empty)
    const blank = rawTab(empty, 'about:blank')
    expect(run(ctx, blank, { type: 'session/save', name: 'vide' })).toBe(blank)
  })

  describe('limits', () => {
    it(`keeps the first ${SESSION_TABS_MAX} tabs of a bigger space`, () => {
      const ctx = makeCtx()
      let s = createInitialState(ctx)
      s = { ...s, tabs: Array.from({ length: SESSION_TABS_MAX + 40 }, (_, i): TabItem => ({ id: `t${i}`, spaceId: s.activeSpaceId, url: `https://many.example/${i}`, title: `Page ${i}`, pinned: false, createdAt: 1, lastActiveAt: 1 })) }
      expect(savableCount(sidebarOrder(s, s.activeSpaceId))).toBe(SESSION_TABS_MAX + 40)
      const tabs = run(ctx, s, { type: 'session/save', name: 'gros' }).sessions[0]!.tabs
      expect(tabs).toHaveLength(SESSION_TABS_MAX)
      expect(tabs[0]!.url).toBe('https://many.example/0')
      expect(tabs.at(-1)!.url).toBe(`https://many.example/${SESSION_TABS_MAX - 1}`)
    })

    it(`refuses a session past ${SESSIONS_MAX} and keeps the ones saved (nothing is pushed out silently)`, () => {
      const { ctx, state } = workspace()
      let s = state
      for (let i = 0; i < SESSIONS_MAX; i++) s = run(ctx, s, { type: 'session/save', name: `Session ${i}` })
      expect(s.sessions).toHaveLength(SESSIONS_MAX)
      const refused = run(ctx, s, { type: 'session/save', name: 'de trop' })
      expect(refused).toBe(s)
      expect(refused.sessions.some((x) => x.name === 'de trop')).toBe(false)
      expect(refused.sessions.at(-1)!.name).toBe('Session 0')
      // Deleting one makes room again.
      const room = run(ctx, s, { type: 'session/delete', id: s.sessions[5]!.id }, { type: 'session/save', name: 'enfin' })
      expect(room.sessions).toHaveLength(SESSIONS_MAX)
      expect(room.sessions[0]!.name).toBe('enfin')
    })

    it('refuses addresses too long to be kept', () => {
      expect(isSessionUrl(`https://a.example/${'x'.repeat(SESSION_URL_MAX)}`)).toBe(false)
      expect(isSessionUrl(`https://a.example/${'x'.repeat(100)}`)).toBe(true)
    })
  })

  describe('from a multiple selection', () => {
    it('saves only the selected tabs, in the sidebar order whatever the order of the ids', () => {
      const { ctx, state, a, b, filed } = workspace()
      const saved = run(ctx, state, { type: 'session/save', name: 'sélection', tabIds: [b.id, filed.id, a.id] })
      expect(saved.sessions[0]!.tabs.map((t) => t.url)).toEqual(['https://dir.example/doc', 'https://a.example/one', 'https://b.example/two'])
    })

    it('takes the space of the selection, whichever space is on screen', () => {
      const { ctx, state, a } = workspace()
      const elsewhere = run(ctx, state, { type: 'space/create', name: 'Autre', emoji: '🧪', hue: 100 })
      expect(run(ctx, elsewhere, { type: 'session/save', name: 's', tabIds: [a.id] }).sessions[0]!.tabs.map((t) => t.url)).toEqual([a.url])
    })

    it('saves nothing for ids that name no tab, rather than the whole space', () => {
      const { ctx, state } = workspace()
      expect(run(ctx, state, { type: 'session/save', name: 's', tabIds: ['nope'] })).toBe(state)
      expect(run(ctx, state, { type: 'session/save', name: 's', tabIds: [] })).toBe(state)
      expect(run(ctx, state, { type: 'session/save', name: 's', tabIds: 'a' as unknown as string[] })).toBe(state)
      expect(run(ctx, state, { type: 'session/save', name: 's', tabIds: [5, null] as unknown as string[] })).toBe(state)
    })
  })
})

describe('session/restore', () => {
  /** The workspace saved as "Projet X", then every tab closed: what a later visit starts from. */
  function saved() {
    const w = workspace()
    const withSession = run(w.ctx, w.state, { type: 'session/save', name: 'Projet X' })
    const closed: SidebarState = { ...withSession, tabs: [], folders: [], activeTabBySpace: { [withSession.activeSpaceId]: null } }
    return { ...w, state: withSession, closed, id: withSession.sessions[0]!.id }
  }

  it('opens every page as a tab of the current space, in order, with the saved titles', () => {
    const { ctx, closed, id } = saved()
    const back = run(ctx, closed, { type: 'session/restore', id })
    expect(sidebarOrder(back, back.activeSpaceId).map((t) => [t.url, t.title, t.pinned])).toEqual([
      ['https://pin.example/home', 'Épinglé', true],
      ['https://dir.example/doc', 'Dans un dossier', true],
      ['https://a.example/one', 'Titre A', false],
      ['https://b.example/two', 'Titre B', false]
    ])
    expect(back.tabs.every((t) => t.spaceId === back.activeSpaceId)).toBe(true)
    // The session itself stays, to be restored again.
    expect(back.sessions).toEqual(closed.sessions)
  })

  it('pins the pinned pages again, on the page they were pinned to, in a folder of the same name (created when the space has none)', () => {
    const { ctx, closed, id } = saved()
    const back = run(ctx, closed, { type: 'session/restore', id })
    const pinned = back.tabs.filter((t) => t.pinned)
    expect(pinned.map((t) => t.anchorUrl)).toEqual(['https://pin.example/home', 'https://dir.example/doc'])
    expect(pinned[0]!.folderId).toBeUndefined()
    expect(back.folders.map((f) => [f.name, f.spaceId, f.parentId])).toEqual([['Docs', back.activeSpaceId, undefined]])
    expect(pinned[1]!.folderId).toBe(back.folders[0]!.id)
    expect(back.tabs.filter((t) => !t.pinned).every((t) => t.folderId === undefined && t.anchorUrl === undefined)).toBe(true)
  })

  it('reuses the folder of that name the space already has instead of making a second one', () => {
    const { ctx, closed, id } = saved()
    const withFolder = run(ctx, closed, { type: 'folder/create', name: 'Docs' })
    const back = run(ctx, withFolder, { type: 'session/restore', id })
    expect(back.folders).toHaveLength(1)
    expect(back.tabs.find((t) => t.url === 'https://dir.example/doc')!.folderId).toBe(withFolder.folders[0]!.id)
  })

  it('selects the first page when the space shows nothing, and keeps the page on screen otherwise', () => {
    const { ctx, closed, id } = saved()
    const empty = run(ctx, closed, { type: 'session/restore', id })
    expect(activeTab(empty)?.url).toBe('https://pin.example/home')

    const open = run(ctx, closed, { type: 'tab/open', url: 'https://courant.example/' })
    const onScreen = activeTab(open)!.id
    const back = run(ctx, open, { type: 'session/restore', id })
    expect(activeTab(back)?.id).toBe(onScreen)
    expect(back.tabs).toHaveLength(5)
  })

  it('does not deduplicate, as the Toolkit does: restoring twice opens the pages twice', () => {
    const { ctx, closed, id } = saved()
    const twice = run(ctx, closed, { type: 'session/restore', id }, { type: 'session/restore', id })
    expect(twice.tabs.filter((t) => t.url === 'https://a.example/one')).toHaveLength(2)
  })

  it('opens the pages in a new space named after the session when asked, and leaves the current space alone', () => {
    const { ctx, state, id } = saved()
    const home = state.spaces[0]!
    const back = run(ctx, state, { type: 'session/restore', id, target: 'new-space' })
    expect(back.spaces).toHaveLength(2)
    const created = back.spaces[1]!
    expect(created.name).toBe('Projet X')
    expect(back.activeSpaceId).toBe(created.id)
    expect(created.profileId).toBe(home.profileId)
    expect(back.tabs.filter((t) => t.spaceId === created.id)).toHaveLength(4)
    // The tabs of the first space did not move.
    expect(back.tabs.filter((t) => t.spaceId === home.id).map((t) => t.id)).toEqual(state.tabs.map((t) => t.id))
    expect(activeTab(back)?.spaceId).toBe(created.id)
    expect(back.folders.filter((f) => f.spaceId === created.id).map((f) => f.name)).toEqual(['Docs'])
    expect(back.folders.filter((f) => f.spaceId === home.id)).toHaveLength(1)
  })

  it('takes any other target for the current space', () => {
    const { ctx, closed, id } = saved()
    const back = run(ctx, closed, { type: 'session/restore', id, target: 'ailleurs' as never })
    expect(back.spaces).toHaveLength(1)
    expect(back.tabs).toHaveLength(4)
  })

  it('leaves out an address that is not a page of the web or a local file, even in a state that holds one', () => {
    const { ctx, closed } = saved()
    const hostile = {
      ...closed,
      sessions: [
        {
          id: 'h1',
          name: 'Piégée',
          createdAt: 1,
          tabs: [
            { url: 'javascript:alert(document.cookie)', title: 'x' },
            { url: 'https://ok.example/', title: 'Bon' },
            { url: 'data:text/html,<script>alert(1)</script>', title: 'x', pinned: true },
            { url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html', title: 'x' },
            { url: 'about:blank', title: 'x' },
            { url: 'view-source:https://ok.example/', title: 'x' },
            { url: 'JavaScript:alert(1)', title: 'x' },
            { url: ' javascript:alert(1)', title: 'x' },
            { url: 'https://ok.example/\u0000x', title: 'x' },
            { url: `https://long.example/${'a'.repeat(SESSION_URL_MAX)}`, title: 'x' }
          ]
        }
      ]
    }
    const back = run(ctx, hostile, { type: 'session/restore', id: 'h1' })
    expect(back.tabs.map((t) => t.url)).toEqual(['https://ok.example/'])
    // Nothing to open at all: nothing changes.
    const nothing = { ...hostile, sessions: [{ ...hostile.sessions[0]!, tabs: hostile.sessions[0]!.tabs.filter((t) => t.url !== 'https://ok.example/') }] }
    expect(run(ctx, nothing, { type: 'session/restore', id: 'h1' })).toBe(nothing)
    expect(run(ctx, nothing, { type: 'session/restore', id: 'h1', target: 'new-space' })).toBe(nothing)
    expect(restorableTabs(hostile.sessions[0]!)).toHaveLength(1)
  })

  it('does nothing for a session that does not exist', () => {
    const { ctx, closed } = saved()
    expect(run(ctx, closed, { type: 'session/restore', id: 'nope' })).toBe(closed)
  })
})

describe('session/rename and session/delete', () => {
  it('renames a session: trimmed, cut at the limit, a blank name keeps the old one', () => {
    const { ctx, state } = workspace()
    const s = run(ctx, state, { type: 'session/save', name: 'Ancien' })
    const id = s.sessions[0]!.id
    expect(run(ctx, s, { type: 'session/rename', id, name: '  Veille tech ' }).sessions[0]!.name).toBe('Veille tech')
    expect(run(ctx, s, { type: 'session/rename', id, name: 'y'.repeat(500) }).sessions[0]!.name).toHaveLength(SESSION_NAME_MAX)
    for (const name of ['', '   ', '\n']) expect(run(ctx, s, { type: 'session/rename', id, name })).toBe(s)
    expect(run(ctx, s, { type: 'session/rename', id, name: 7 as unknown as string })).toBe(s)
    expect(run(ctx, s, { type: 'session/rename', id, name: 'Ancien' })).toBe(s)
    expect(run(ctx, s, { type: 'session/rename', id: 'nope', name: 'x' })).toBe(s)
  })

  it('renaming touches only that session and keeps its tabs and date', () => {
    const { ctx, state } = workspace()
    const s = run(ctx, state, { type: 'session/save', name: 'A' }, { type: 'session/save', name: 'B' })
    const [b, a] = s.sessions
    const renamed = run(ctx, s, { type: 'session/rename', id: a!.id, name: 'A2' })
    expect(renamed.sessions.map((x) => x.name)).toEqual(['B', 'A2'])
    expect(renamed.sessions[1]).toEqual({ ...a, name: 'A2' })
    expect(renamed.sessions[0]).toBe(b)
  })

  it('deletes a session and only that one; an unknown id changes nothing', () => {
    const { ctx, state } = workspace()
    const s = run(ctx, state, { type: 'session/save', name: 'A' }, { type: 'session/save', name: 'B' }, { type: 'session/save', name: 'C' })
    const gone = run(ctx, s, { type: 'session/delete', id: s.sessions[1]!.id })
    expect(gone.sessions.map((x) => x.name)).toEqual(['C', 'A'])
    expect(run(ctx, s, { type: 'session/delete', id: 'nope' })).toBe(s)
    // The tabs are not the session's: deleting it closes nothing.
    expect(gone.tabs).toEqual(s.tabs)
  })
})

describe('sessions read from a file', () => {
  const tab = (url: string, over: Record<string, unknown> = {}) => ({ url, title: 'T', ...over })

  it('keeps a good session as it is and gives an old file (no sessions at all) an empty list', () => {
    const { ctx, state } = workspace()
    const s = run(ctx, state, { type: 'session/save', name: 'Projet X' })
    expect(cleanSessions(JSON.parse(JSON.stringify(s.sessions)))).toEqual(s.sessions)
    const { sessions: _sessions, ...old } = JSON.parse(JSON.stringify(s)) as Record<string, unknown>
    expect(parseSavedState(JSON.stringify(old)).sessions).toEqual([])
  })

  it('survives a restart: the state written, read back and restored gives the same pages', () => {
    const { ctx, state } = workspace()
    const s = run(ctx, state, { type: 'session/save', name: 'Veille tech' }, { type: 'session/save', name: 'Projet X', tabIds: [state.tabs[0]!.id] })
    const reloaded = parseSavedState(JSON.stringify(s))
    expect(reloaded.sessions).toEqual(s.sessions)
    const closed: SidebarState = { ...reloaded, tabs: [], folders: [], activeTabBySpace: { [reloaded.activeSpaceId]: null } }
    const back = run(ctx, closed, { type: 'session/restore', id: reloaded.sessions[1]!.id })
    expect(back.tabs.map((t) => t.url)).toContain('https://dir.example/doc')
    expect(back.tabs).toHaveLength(4)
  })

  it('drops the pages a session may not hold, and a session left with none', () => {
    const cleaned = cleanSessions([
      { id: 'a', name: 'A', createdAt: 5, tabs: [tab('javascript:alert(1)'), tab('https://ok.example/'), tab('data:text/html,x'), tab('about:blank'), tab('chrome://settings'), tab(5 as unknown as string), 'x', null] },
      { id: 'b', name: 'B', createdAt: 5, tabs: [tab('javascript:alert(1)')] },
      { id: 'c', name: 'C', createdAt: 5, tabs: 'pas une liste' },
      { id: 'd', name: 'D', createdAt: 5 }
    ])
    expect(cleaned.map((s) => s.id)).toEqual(['a'])
    expect(cleaned[0]!.tabs).toEqual([{ url: 'https://ok.example/', title: 'T' }])
  })

  it('repairs what can be repaired: name, date, titles, flags, folders', () => {
    const [session] = cleanSessions([
      {
        id: 's',
        name: '   ',
        createdAt: 'hier',
        extra: 'inconnu',
        tabs: [
          tab('https://a.example/x', { title: 'a\u0000b\nc', pinned: 'oui', folder: 'Perdu' }),
          tab('https://b.example/', { title: '', pinned: true, folder: '  Docs  ' }),
          tab('https://c.example/', { title: 12, pinned: true, folder: 7 }),
          tab('https://d.example/', { title: 'x'.repeat(5000) })
        ]
      }
    ])
    expect(session).toEqual({
      id: 's',
      name: 'Session',
      createdAt: 0,
      tabs: [
        { url: 'https://a.example/x', title: 'a b c' },
        { url: 'https://b.example/', title: 'b.example', pinned: true, folder: 'Docs' },
        { url: 'https://c.example/', title: 'c.example', pinned: true },
        { url: 'https://d.example/', title: 'x'.repeat(1000) }
      ]
    })
  })

  it('keeps the first of two sessions with one id, drops an id nobody can use, and stops at the limits', () => {
    const many = Array.from({ length: SESSIONS_MAX + 20 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, createdAt: i, tabs: [tab(`https://a.example/${i}`)] }))
    const cleaned = cleanSessions([{ ...many[0]!, name: 'premier' }, { ...many[0]!, name: 'doublon' }, { ...many[1]!, id: '' }, { ...many[1]!, id: '__proto__' }, ...many.slice(1)])
    expect(cleaned).toHaveLength(SESSIONS_MAX)
    expect(cleaned[0]!.name).toBe('premier')
    expect(new Set(cleaned.map((s) => s.id)).size).toBe(cleaned.length)

    const huge = cleanSessions([{ id: 'h', name: 'gros', createdAt: 1, tabs: Array.from({ length: SESSION_TABS_MAX + 30 }, (_, i) => tab(`https://a.example/${i}`)) }])
    expect(huge[0]!.tabs).toHaveLength(SESSION_TABS_MAX)
  })

  it('reads anything that is not a list as no session', () => {
    for (const raw of [undefined, null, 'x', 5, {}, { id: 'a' }, [[]], [null, 1, 'a']]) expect(cleanSessions(raw)).toEqual([])
  })

  it('gives the same sessions when cleaned a second time', () => {
    const once = cleanSessions([{ id: 'a', name: ' Nom\u0007 ', createdAt: 1, tabs: [tab('https://a.example/ x', { title: ' t ' }), tab('file:///tmp/a b.html', { title: '' })] }])
    expect(cleanSessions(once)).toEqual(once)
    expect(cleanSessions(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })
})

describe('what a session shows', () => {
  it('writes the automatic name as the Toolkit does: date then time, and in English with the month as a word (figures alone do not say which is the day)', () => {
    expect(autoSessionName(new Date(2026, 9, 24, 14, 5).getTime())).toBe('Session du 24/10/2026 14:05')
    expect(autoSessionName(new Date(2026, 0, 3, 9, 7).getTime())).toBe('Session du 03/01/2026 09:07')
    setLanguage('en')
    try {
      expect(autoSessionName(new Date(2026, 0, 3, 9, 7).getTime())).toBe('Session from 03 Jan 2026 at 09:07')
      expect(autoSessionName(new Date(2026, 10, 10, 14, 32).getTime())).toBe('Session from 10 Nov 2026 at 14:32')
    } finally {
      setLanguage('fr')
    }
  })

  it('cleans a name', () => {
    expect(cleanSessionName('  a  ')).toBe('a')
    expect(cleanSessionName(null)).toBe('')
    expect(cleanSessionName('\u0000')).toBe('')
  })

  it('says how long ago a session was saved', () => {
    const now = 1_700_000_000_000
    expect(sessionAge(now - 5_000, now)).toBe('à l’instant')
    expect(sessionAge(now + 5_000, now)).toBe('à l’instant')
    expect(sessionAge(now - 5 * 60_000, now)).toBe(frenchSpaces('il y a 5 min'))
    expect(sessionAge(now - 3 * 3_600_000, now)).toBe(frenchSpaces('il y a 3 h'))
    expect(sessionAge(now - 2 * 86_400_000, now)).toBe(frenchSpaces('il y a 2 j'))
    expect(sessionAge(now - 30 * 86_400_000, now)).toMatch(/\d{4}/)
  })

  it('counts tabs, by the plural rules of French (zero takes the singular)', () => {
    expect([tabsLabel(1), tabsLabel(2), tabsLabel(0)]).toEqual(['1 onglet', '2 onglets', '0 onglet'])
  })

  it('says the age and the count in the interface’s language', () => {
    const now = 1_700_000_000_000
    setLanguage('en')
    try {
      expect([sessionAge(now - 5_000, now), sessionAge(now - 5 * 60_000, now), sessionAge(now - 3 * 3_600_000, now), sessionAge(now - 2 * 86_400_000, now)]).toEqual(['just now', '5 min ago', '3 h ago', '2 d ago'])
      expect([tabsLabel(1), tabsLabel(2)]).toEqual(['1 tab', '2 tabs'])
    } finally {
      setLanguage('fr')
    }
  })
})
