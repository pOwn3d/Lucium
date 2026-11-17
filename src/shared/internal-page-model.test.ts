// What the model says of the Extensions page (`lucium-ui://extensions/`, internal-page.ts): the shell opens a tab on it, it survives a restart, and it goes
// nowhere else (no history, no archive, no session, no favourite, no container, no private tab, no page that sends a tab to it).

import { describe, expect, it } from 'vitest'
import { cleanClosedHistory, closedHistoryOf, isClosedPageUrl } from './closed-history'
import { interfaceMayDispatch } from './ipc-policy'
import { createInitialState, normalize, persistableState, reduce, type Action, type Ctx } from './sidebar'
import type { SidebarState, TabItem } from './model'
import { cleanSessionTab, isSessionUrl } from './sessions'
import { cleanTabUpdate } from './sidebar-helpers'
import { cleanArchive, cleanFavorites, cleanTabs, isLoadableUrl, isReadLaterUrl } from './state-clean'
import { isInternalPageUrl } from './internal-page'
import { isNavigableUrl, isViewSourceUrl } from './url'

const PAGE = 'lucium-ui://extensions/'
const ID = 'a'.repeat(32)

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}

const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

function opened(extra: Partial<Extract<Action, { type: 'tab/open' }>> = {}, url = PAGE): { ctx: Ctx; state: SidebarState } {
  const ctx = makeCtx()
  return { ctx, state: run(ctx, createInitialState(ctx), { type: 'tab/open', url, allowInternalPages: true, ...extra }) }
}

describe('opening the Extensions page in a tab', () => {
  it('only the shell opens it: without the flag the address is no address a tab can hold', () => {
    const ctx = makeCtx()
    expect(run(ctx, createInitialState(ctx), { type: 'tab/open', url: PAGE }).tabs).toHaveLength(0)
    expect(run(ctx, createInitialState(ctx), { type: 'tab/open', url: PAGE, allowInternalPages: false }).tabs).toHaveLength(0)
    // The flag for the page of an extension is not the flag for this one, and the other way round.
    expect(run(ctx, createInitialState(ctx), { type: 'tab/open', url: PAGE, allowExtensionPages: true }).tabs).toHaveLength(0)
    expect(run(ctx, createInitialState(ctx), { type: 'tab/open', url: `chrome-extension://${ID}/a.html`, allowInternalPages: true }).tabs).toHaveLength(0)
  })

  it('opens the page, and its details, at their canonical address, named for what it is', () => {
    const { state } = opened()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ url: PAGE, title: 'Extensions', pinned: false })
    for (const url of ['lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${ID}&profile=default`]) {
      expect(opened({}, url).state.tabs[0]?.url).toBe(url)
    }
  })

  it('refuses an address that only looks like the page, flag or not', () => {
    for (const url of ['lucium-ui://extensions@evil/', 'lucium-ui://evil/', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui:extensions', 'lucium-ui://extensions.evil.com/', 'lucium-ui://extensions:80/', 'lucium-ui://extensions\\@evil/', 'lucium-ui://extensions/assets/a.js', 'lucium-ui://extensions']) {
      expect(opened({}, url).state.tabs, url).toHaveLength(0)
    }
  })

  it('is never a private tab, and never in a container: its session is its profile’s', () => {
    expect(opened({ private: true }).state.tabs).toHaveLength(0)
    expect(opened({ container: 'work' }).state.tabs).toHaveLength(0)
    expect(opened({ container: null }).state.tabs).toHaveLength(1)
  })

  it('a tab already there cannot be moved into a container', () => {
    const ctx = makeCtx()
    const started = run(ctx, createInitialState(ctx), { type: 'settings/update', patch: { tabContainers: true } }, { type: 'container/create', name: 'Travail' })
    const container = started.settings.containers[0]!.id
    const there = run(ctx, started, { type: 'tab/open', url: PAGE, allowInternalPages: true })
    expect(run(ctx, there, { type: 'tab/set-container', id: there.tabs[0]!.id, container }).tabs[0]?.container).toBeUndefined()
    // The same action moves a tab of the web, so the refusal above is the page's.
    const web = run(ctx, started, { type: 'tab/open', url: 'https://example.org/' })
    expect(run(ctx, web, { type: 'tab/set-container', id: web.tabs[0]!.id, container }).tabs[0]?.container).toBe(container)
  })

  it('is refused whatever the interface says: the flag is the shell’s', () => {
    expect(interfaceMayDispatch({ type: 'tab/open', url: PAGE, allowInternalPages: true }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'tab/open', url: PAGE, allowInternalPages: false }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'tab/open', url: 'https://example.org/' }, [])).toBe(true)
  })
})

describe('what a page may tell about a tab', () => {
  const tabOn = (url: string): TabItem => ({ id: 't', spaceId: 's', url, title: 'x', pinned: false, createdAt: 0, lastActiveAt: 0 })

  it('the page moves between its own views, and nowhere else', () => {
    const tab = tabOn(PAGE)
    expect(cleanTabUpdate({ url: `lucium-ui://extensions/?id=${ID}` }, tab).url).toBe(`lucium-ui://extensions/?id=${ID}`)
    expect(cleanTabUpdate({ url: 'lucium-ui://extensions/shortcuts' }, tab).url).toBe('lucium-ui://extensions/shortcuts')
    for (const url of ['lucium-ui://extensions@evil/', 'lucium-ui://evil/', 'lucium-ui://extensions/assets/a.js', 'chrome://extensions', 'javascript:alert(1)']) {
      expect(cleanTabUpdate({ url }, tab).url, url).toBeUndefined()
    }
    // A page of the web that comes to say it is at the address of the page is not believed: the tab is not on it.
    for (const on of ['https://example.org/', 'about:blank', `chrome-extension://${ID}/a.html`]) expect(cleanTabUpdate({ url: PAGE }, tabOn(on)).url, on).toBeUndefined()
  })

  it('the page of an extension and the web keep the rules they had', () => {
    expect(cleanTabUpdate({ url: 'https://example.org/' }, tabOn(PAGE)).url).toBe('https://example.org/')
    expect(cleanTabUpdate({ url: 'https://example.org/' }, tabOn('https://other.example/')).url).toBe('https://example.org/')
  })
})

describe('a tab that comes back to the Extensions page', () => {
  const tabOn = (url: string, extra: Partial<TabItem> = {}): TabItem => ({ id: 't', spaceId: 's', url, title: 'x', pinned: false, createdAt: 0, lastActiveAt: 0, ...extra })

  it('is believed when the engine says it (the main process’ flag), at the address of the page and of its views', () => {
    for (const url of [PAGE, 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${ID}&profile=work`]) {
      expect(cleanTabUpdate({ url }, tabOn('https://example.org/'), true).url, url).toBe(url)
      // Without the flag a tab of the web that says it is on the page is not believed.
      expect(cleanTabUpdate({ url }, tabOn('https://example.org/')).url, url).toBeUndefined()
    }
  })

  it('is not believed for a tab that never shows the page (a private one, one of a container), nor for an address that only looks like it', () => {
    expect(cleanTabUpdate({ url: PAGE }, tabOn('https://example.org/', { private: true }), true).url).toBeUndefined()
    expect(cleanTabUpdate({ url: PAGE }, tabOn('https://example.org/', { container: 'work' }), true).url).toBeUndefined()
    for (const url of ['lucium-ui://extensions@evil/', 'lucium-ui://evil/', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui://extensions/assets/a.js', 'chrome://extensions', `chrome-extension://${ID}/a.html`]) {
      expect(cleanTabUpdate({ url }, tabOn('https://example.org/'), true).url, url).toBeUndefined()
    }
  })

  it('keeps the title and the icon rules when the flag is there: it changes nothing but this one address', () => {
    expect(cleanTabUpdate({ url: 'https://other.example/', title: 'Other' }, tabOn('https://example.org/'), true)).toEqual({ url: 'https://other.example/', title: 'Other' })
    expect(cleanTabUpdate({ url: 'javascript:alert(1)' }, tabOn('https://example.org/'), true).url).toBeUndefined()
  })

  it('is what the reducer does with the flag of the action, and nothing without it: Back onto the page after a tab went to the web', () => {
    const { ctx, state } = opened()
    const id = state.tabs[0]!.id
    const away = run(ctx, state, { type: 'tab/update', id, patch: { url: 'https://example.org/' } })
    expect(away.tabs[0]?.url).toBe('https://example.org/')
    expect(run(ctx, away, { type: 'tab/update', id, patch: { url: PAGE } }).tabs[0]?.url).toBe('https://example.org/')
    expect(run(ctx, away, { type: 'tab/update', id, patch: { url: PAGE }, allowInternalPages: false }).tabs[0]?.url).toBe('https://example.org/')
    expect(run(ctx, away, { type: 'tab/update', id, patch: { url: PAGE }, allowInternalPages: true }).tabs[0]?.url).toBe(PAGE)
    // A tab of the web the state holds as a private tab never becomes the page.
    const hidden = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://example.org/', private: true })
    expect(run(ctx, hidden, { type: 'tab/update', id: hidden.tabs[0]!.id, patch: { url: PAGE }, allowInternalPages: true }).tabs[0]?.url).toBe('https://example.org/')
  })

  it('is refused whatever the interface says: the flag is the shell’s', () => {
    expect(interfaceMayDispatch({ type: 'tab/update', id: 't', patch: { url: PAGE }, allowInternalPages: true }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'tab/update', id: 't', patch: { url: PAGE }, allowInternalPages: false }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'tab/update', id: 't', patch: { title: 'x' } }, [])).toBe(true)
    expect(interfaceMayDispatch({ type: 'tab/update', id: 't', patch: { url: 'https://example.org/' } }, [])).toBe(true)
  })
})

describe('the Extensions page as the anchor of a pinned tab', () => {
  const SPACE = 'sp'
  const file = (tabs: unknown[]): never => ({ spaces: [{ id: SPACE, name: 'Main', profileId: 'default', createdAt: 0 }], tabs }) as never
  const pinned = (id: string, url: string, anchorUrl: string, extra: Record<string, unknown> = {}) => ({ id, spaceId: SPACE, url, title: 'x', pinned: true, anchorUrl, createdAt: 0, lastActiveAt: 0, ...extra })
  const anchors = (tabs: TabItem[]): Array<string | undefined> => tabs.map((tab) => tab.anchorUrl)

  it('is the anchor of the tab that is on it, and of no other tab a file names: not one of the web, not one of a container', () => {
    const read = normalize(
      file([
        pinned('on-page', PAGE, PAGE),
        pinned('web', 'https://example.org/', PAGE),
        pinned('container', 'https://example.org/', PAGE, { container: 'cont-1' }),
        pinned('away', 'https://example.org/', `lucium-ui://extensions/shortcuts`),
        pinned('plain', 'https://example.org/', 'https://example.org/home')
      ])
    )
    expect(Object.fromEntries(read.tabs.map((tab) => [tab.id, tab.anchorUrl]))).toEqual({ 'on-page': PAGE, web: undefined, container: undefined, away: undefined, plain: 'https://example.org/home' })
  })

  it('is no anchor when the address only looks like the page’s', () => {
    for (const anchor of ['lucium-ui://extensions@evil/', 'lucium-ui://evil/', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui://extensions/assets/a.js']) {
      expect(anchors(normalize(file([pinned('on-page', PAGE, anchor)])).tabs), anchor).toEqual([undefined])
    }
  })

  /** A state that holds, in memory, a pinned tab whose anchor is the page: how it came there is not the question (a file read by an older build, an action that came late). */
  function holding(extra: Partial<TabItem>) {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const tab: TabItem = { id: 'p', spaceId: base.activeSpaceId, url: 'https://example.org/', title: 'x', pinned: true, anchorUrl: PAGE, createdAt: 0, lastActiveAt: 0, ...extra }
    return { ctx, state: { ...base, tabs: [tab], activeTabBySpace: { ...base.activeTabBySpace, [base.activeSpaceId]: 'p' } } as SidebarState }
  }
  const urlOf = (state: SidebarState, id = 'p'): string | undefined => state.tabs.find((tab) => tab.id === id)?.url

  it('does not send a tab of a container, or a private tab, to the page when it goes back to its anchor, is closed, is separated or is reset', () => {
    for (const extra of [{ container: 'cont-1' }, { private: true }]) {
      const { ctx, state } = holding(extra)
      const label = JSON.stringify(extra)
      expect(urlOf(run(ctx, state, { type: 'tab/back-to-anchor', id: 'p' })), label).toBe('https://example.org/')
      expect(urlOf(run(ctx, state, { type: 'tab/close', id: 'p' })), label).toBe('https://example.org/')
      expect(urlOf(run(ctx, state, { type: 'tabs/reset-pinned' })), label).toBe('https://example.org/')
      const separated = run(ctx, state, { type: 'tab/separate', id: 'p' })
      expect(separated.tabs.map((tab) => tab.url), label).toEqual(['https://example.org/'])
    }
  })

  it('still sends the tab that may show the page back to it', () => {
    const { ctx, state } = holding({})
    expect(urlOf(run(ctx, state, { type: 'tab/back-to-anchor', id: 'p' }))).toBe(PAGE)
    expect(urlOf(run(ctx, state, { type: 'tabs/reset-pinned' }))).toBe(PAGE)
    expect(urlOf(run(ctx, state, { type: 'tab/close', id: 'p' }))).toBe(PAGE)
    const separated = run(ctx, state, { type: 'tab/separate', id: 'p' })
    expect(separated.tabs.map((tab) => tab.url).sort()).toEqual(['https://example.org/', PAGE].sort())
  })

  it('leaves a tab of the web that has an anchor of the web as it was', () => {
    const { ctx, state } = holding({ anchorUrl: 'https://example.org/home', container: 'cont-1' })
    expect(urlOf(run(ctx, state, { type: 'tab/back-to-anchor', id: 'p' }))).toBe('https://example.org/home')
    expect(urlOf(run(ctx, state, { type: 'tabs/reset-pinned' }))).toBe('https://example.org/home')
  })
})

describe('the address of a file of the page', () => {
  const KEY = '0123456789abcdef0123456789abcdef' // gitleaks:allow (invented for this test, the key of no session)
  const FILE = `lucium-ui://extensions/${KEY}/assets/extensions-BxahU_Tj.js`

  it('is no address of the page, so it is never the address of a tab: the key it holds is not shown, copied, told to an extension or kept in the state', () => {
    expect(isInternalPageUrl(FILE)).toBe(false)
    const tab: TabItem = { id: 't', spaceId: 's', url: PAGE, title: 'x', pinned: false, createdAt: 0, lastActiveAt: 0 }
    expect(cleanTabUpdate({ url: FILE }, tab, true).url).toBeUndefined()
    expect(cleanTabUpdate({ url: FILE }, tab).url).toBeUndefined()
    const saved = normalize({ spaces: [{ id: 's', name: 'Main', profileId: 'default', createdAt: 0 }], tabs: [{ ...tab, url: FILE }] } as never)
    expect(saved.tabs).toHaveLength(0)
  })
})

describe('the Extensions page and what survives a restart', () => {
  it('is kept in the saved state, and read back at its address', () => {
    const { state } = opened()
    const saved = JSON.parse(JSON.stringify(persistableState(state)))
    expect(saved.tabs.map((tab: TabItem) => tab.url)).toEqual([PAGE])
    expect(normalize(saved).tabs.map((tab) => tab.url)).toEqual([PAGE])
  })

  it('a file that holds it in a private tab or in a container is read without that', () => {
    const { state } = opened()
    const base = JSON.parse(JSON.stringify(persistableState(state)))
    const withPrivate = { ...base, tabs: [{ ...base.tabs[0], private: true }] }
    expect(normalize(withPrivate).tabs).toHaveLength(0)
    const withContainer = normalize({ ...base, tabs: [{ ...base.tabs[0], container: 'c1' }] })
    expect(withContainer.tabs).toHaveLength(1)
    expect(withContainer.tabs[0]?.container).toBeUndefined()
  })

  it('a tab of a file is named for what it is, and is in no container, whatever the file says', () => {
    const raw = [{ id: 't1', spaceId: 's', url: PAGE, container: 'c1', createdAt: 1 }]
    const [tab] = cleanTabs(raw, new Set(['s']), new Map())
    expect(tab).toMatchObject({ url: PAGE, title: 'Extensions' })
    expect(tab?.container).toBeUndefined()
    // The same file line for a tab of the web keeps its container: the refusal is the page’s.
    expect(cleanTabs([{ ...raw[0], url: 'https://example.org/' }], new Set(['s']), new Map())[0]?.container).toBe('c1')
  })

  it('a file that holds an address that only looks like it loses the tab', () => {
    const { state } = opened()
    const base = JSON.parse(JSON.stringify(persistableState(state)))
    for (const url of ['lucium-ui://extensions@evil/', 'lucium-ui://evil/', 'lucium-ui://extensions/x.js', 'LUCIUM-UI://EXTENSIONS/']) {
      expect(normalize({ ...base, tabs: [{ ...base.tabs[0], url }] }).tabs, url).toHaveLength(0)
    }
  })

  it('a pinned page goes back to its own address, and only to the page', () => {
    const { ctx, state } = opened()
    const pinned = run(ctx, state, { type: 'tab/pin', id: state.tabs[0]!.id })
    const saved = JSON.parse(JSON.stringify(persistableState(pinned)))
    expect(normalize(saved).tabs[0]?.anchorUrl).toBe(PAGE)
    expect(normalize({ ...saved, tabs: [{ ...saved.tabs[0], anchorUrl: 'lucium-ui://evil/' }] }).tabs[0]?.anchorUrl).toBeUndefined()
  })
})

describe('the Extensions page is in no list of addresses', () => {
  it('the favourites, the archive and the saved sessions never hold it', () => {
    expect(isLoadableUrl(PAGE)).toBe(false)
    expect(cleanFavorites([{ id: 'f1', url: PAGE, title: 'x' }])).toEqual([])
    expect(cleanArchive([{ id: 'a1', spaceId: 's', url: PAGE, title: 'x', archivedAt: 1 }], new Set(['s']))).toEqual([])
    expect(isSessionUrl(PAGE)).toBe(false)
    expect(cleanSessionTab({ url: PAGE, title: 'x' })).toBeNull()
    expect(isNavigableUrl(PAGE)).toBe(false)
    expect(isViewSourceUrl(`view-source:${PAGE}`)).toBe(false)
  })

  it('a favourite cannot be made of it', () => {
    const { ctx, state } = opened()
    expect(run(ctx, state, { type: 'favorite/add', url: PAGE, title: 'x' }).favorites).toHaveLength(0)
  })

  it('the history of a closed tab, the history of the visits and the places to read later are the web’s alone', () => {
    expect(isClosedPageUrl(PAGE)).toBe(false)
    expect(closedHistoryOf([{ url: 'https://a.example/', title: 'a' }, { url: PAGE, title: 'e' }], 1, PAGE)).toBeUndefined()
    expect(cleanClosedHistory({ entries: [{ url: 'https://a.example/', title: 'a' }, { url: PAGE, title: 'e' }], index: 1 }, PAGE)).toBeUndefined()
    expect(isReadLaterUrl(PAGE)).toBe(false)
  })

  it('archiving the page leaves nothing in the archive, and an entry of a file that holds it opens nothing', () => {
    const { ctx, state } = opened()
    const web = run(ctx, state, { type: 'tab/open', url: 'https://example.org/', background: true })
    // The same action archives a tab of the web, so the empty archive below is the page’s.
    expect(run(ctx, web, { type: 'tab/archive', id: web.tabs[1]!.id }).archive).toHaveLength(1)
    const closed = run(ctx, state, { type: 'tab/archive', id: state.tabs[0]!.id })
    expect(closed.tabs).toHaveLength(0)
    expect(closed.archive).toHaveLength(0)
    const entry = { id: 'a1', spaceId: state.spaces[0]!.id, url: PAGE, title: 'x', archivedAt: 1 }
    const restored = run(ctx, { ...closed, archive: [entry] }, { type: 'archive/restore', id: 'a1' })
    expect(restored.tabs).toHaveLength(0)
    expect(restored.archive).toHaveLength(0)
  })

  it('a copy of the page is no second page: duplicating it does nothing', () => {
    const { ctx, state } = opened()
    expect(run(ctx, state, { type: 'tab/duplicate', id: state.tabs[0]!.id }).tabs).toHaveLength(1)
  })
})
