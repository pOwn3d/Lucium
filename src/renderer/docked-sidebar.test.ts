// The docked sidebar (« barre collée ») as the window draws it, without a window: the real sidebar of a window that docked it is a column of tiles, the
// pinned tabs (the favourites when the space has none, never both, so no line between them); the site on screen is marked; the unread counts and dots are
// there; « Nouvel onglet » and « Déplier » at the foot. Every tile is a button with a name, and none of them (nor the column) opens the floating sidebar on
// a hover. The full sidebar has « Replier la barre », and a right click on either opens « Barre de cette fenêtre ».

import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { RuntimeState, SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { WindowSidebar } from '@shared/window-sidebar'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }))
vi.mock('./api', () => ({
  api: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, name: string) => (arg: unknown) => {
        holder.calls.push([name, arg])
        return name === 'dispatch' ? Promise.resolve() : undefined
      }
    }),
  useSnapshot: () => null
}))

import { Sidebar } from './Sidebar'
import { tileLabel } from './DockedSidebar'
import { SidebarUiContext, type SidebarUi } from './SidebarRows'
import { frenchSpaces } from '@shared/french-typography'

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const noop = (): void => undefined
const rowsUi: SidebarUi = { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop }
const underUi = (probe: ReactElement): ReactElement => createElement(SidebarUiContext.Provider, { value: rowsUi }, probe)

/** Two favourites (Mail, Agenda), two pinned tabs (Slack, WhatsApp) and a Today tab (Drive); Slack on screen. */
function fixture() {
  let state = run(createInitialState(ctx), { type: 'favorite/add', url: 'https://mail.example/', title: 'Mail' }, { type: 'favorite/add', url: 'https://agenda.example/', title: 'Agenda' })
  for (const [url, title] of [['https://slack.example/', 'Slack'], ['https://whatsapp.example/', 'WhatsApp'], ['https://drive.example/', 'Drive']]) {
    state = run(state, { type: 'tab/open', url: url!, background: true })
    const tab = state.tabs.find((t) => t.url === url)!
    state = run(state, { type: 'tab/update', id: tab.id, patch: { title: title! } })
  }
  const id = (title: string) => state.tabs.find((t) => t.title === title)!.id
  state = run(state, { type: 'tab/pin', id: id('Slack') }, { type: 'tab/pin', id: id('WhatsApp') }, { type: 'tab/select', id: id('Slack') })
  return { state, id }
}

/** The same window with no pinned tab (Slack and WhatsApp are in Today): the favourites, Mail and Agenda, are the column. */
function bareFixture() {
  const { state, id } = fixture()
  return { state: run(state, { type: 'tab/unpin', id: id('Slack') }, { type: 'tab/unpin', id: id('WhatsApp') }), id }
}

function snapshotOf(state: SidebarState, windowSidebar?: WindowSidebar, runtime: RuntimeState['tabs'] = {}): UiSnapshot {
  return {
    state,
    runtime: { tabs: runtime, canGoBack: false, canGoForward: false },
    engine: {},
    extensions: [],
    downloads: [],
    find: null,
    peek: null,
    sidePanel: null,
    toast: null,
    platform: 'darwin',
    private: false,
    ...(windowSidebar ? { windowSidebar } : {})
  } as unknown as UiSnapshot
}
const sidebar = (snapshot: UiSnapshot) => createElement(Sidebar, { snapshot, space: snapshot.state.spaces.find((s) => s.id === snapshot.state.activeSpaceId)! })
const markupOf = (snapshot: UiSnapshot) => renderToStaticMarkup(underUi(sidebar(snapshot)))
const tiles = (markup: string) => [...markup.matchAll(/<button[^>]*class="dock-tile[^"]*"[^>]*>/g)].map((match) => match[0])
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1]
const elements = (snapshot: UiSnapshot): Element[] => elementsOf(sidebar(snapshot), undefined, underUi)

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
  holder.calls.length = 0
})
afterEach(() => vi.unstubAllGlobals())

describe('the column of a docked sidebar', () => {
  it('takes the place of the full sidebar: the pinned tabs only, no favourite tile and no line, never a Today tab', () => {
    const { state } = fixture()
    const markup = markupOf(snapshotOf(state, { docked: true }))
    expect(markup).toContain('class="sidebar docked-sidebar at-left"')
    expect(markup).not.toContain('class="favorite ')
    expect(tiles(markup).map((tag) => attr(tag, 'aria-label'))).toEqual(['Slack', 'WhatsApp'])
    expect(tiles(markup).map((tag) => attr(tag, 'data-tile')!.split(':')[0])).toEqual(['tab', 'tab'])
    expect(markup).not.toContain('Mail')
    expect(markup).not.toContain('Agenda')
    expect(markup).not.toContain('role="separator"')
    expect(markup).not.toContain('Drive')
  })

  it('shows the favourites, still no line and no Today tab, when the space has no pinned tab: they are the column rather than nothing', () => {
    const { state } = bareFixture()
    const markup = markupOf(snapshotOf(state, { docked: true }))
    expect(tiles(markup).map((tag) => attr(tag, 'aria-label'))).toEqual(['Mail', 'Agenda'])
    expect(tiles(markup).map((tag) => attr(tag, 'data-tile')!.split(':')[0])).toEqual(['favorite', 'favorite'])
    expect(markup).not.toContain('role="separator"')
    expect(markup).not.toContain('Slack')
    expect(markup).not.toContain('Drive')
  })

  it('marks the site on screen, for the eye (a class) and for a screen reader (aria-current)', () => {
    const { state } = fixture()
    const marked = tiles(markupOf(snapshotOf(state, { docked: true }))).map((tag) => [attr(tag, 'aria-label'), / active"|class="dock-tile active/.test(tag), attr(tag, 'aria-current') ?? null])
    expect(marked).toEqual([['Slack', true, 'page'], ['WhatsApp', false, null]])
    // A favourite is a tile only without pinned tab: the one whose page is on screen is marked.
    const bare = bareFixture()
    const agenda = bare.state.favorites.find((f) => f.title === 'Agenda')!.id
    const opened = run(bare.state, { type: 'favorite/open', id: agenda, spaceId: bare.state.activeSpaceId })
    const favourites = tiles(markupOf(snapshotOf(opened, { docked: true }))).map((tag) => [attr(tag, 'aria-label'), / active"|class="dock-tile active/.test(tag), attr(tag, 'aria-current') ?? null])
    expect(favourites).toEqual([['Mail', false, null], ['Agenda', true, 'page']])
  })

  it('shows the unread count of a page, and says it in the name of the tile', () => {
    const { state, id } = fixture()
    const markup = markupOf(snapshotOf(state, { docked: true }, { [id('WhatsApp')]: { loading: false, audible: false, muted: false, awake: true, unread: 12 } }))
    expect(markup).toContain('aria-label="WhatsApp · 12 non lus"')
    expect(markup).toMatch(/<span class="dock-badge" aria-hidden="true">12<\/span>/)
    expect(tileLabel({ title: 'Mail', url: 'https://mail.example/', unread: 1, dot: false })).toBe('Mail · 1 non lu')
    expect(tileLabel({ title: 'Slack', url: 'https://slack.example/', dot: true })).toBe('Slack · du nouveau')
    expect(tileLabel({ title: '  ', url: 'https://slack.example/', dot: false })).toBe('https://slack.example/')
  })

  it('says the unread count of a favourite from the page it opened, in a space without pinned tab', () => {
    const { state } = bareFixture()
    const mail = state.favorites.find((f) => f.title === 'Mail')!.id
    const opened = run(state, { type: 'favorite/open', id: mail, spaceId: state.activeSpaceId })
    const page = opened.tabs.find((t) => t.favoriteId === mail)!.id
    const markup = markupOf(snapshotOf(opened, { docked: true }, { [page]: { loading: false, audible: false, muted: false, awake: true, unread: 3 } }))
    expect(markup).toContain('aria-label="Mail · 3 non lus"')
    expect(markup).toMatch(/<span class="dock-badge" aria-hidden="true">3<\/span>/)
  })

  it('shows the dot of an icon that changed (with the marks of the rows on)', () => {
    const { state, id } = fixture()
    const markup = markupOf(snapshotOf(state, { docked: true }, { [id('Slack')]: { loading: false, audible: false, muted: false, awake: true, changedIcon: true } }))
    expect(markup).toContain('<span class="dock-dot" aria-hidden="true"></span>')
    expect(markup).toContain('aria-label="Slack · du nouveau"')
  })

  it('has « Nouvel onglet » and « Déplier » at its foot, named for the keyboard and a screen reader', () => {
    const { state } = fixture()
    const markup = markupOf(snapshotOf(state, { docked: true }))
    expect(markup).toContain('aria-label="Nouvel onglet"')
    expect(markup).toContain('aria-label="Déplier la barre"')
    expect(markup).toContain(frenchSpaces('aria-label="Barre repliée : sites de l’espace'))
  })

  it('stands at the right of a window that put its sidebar there', () => {
    const { state } = fixture()
    expect(markupOf(snapshotOf(state, { docked: true, side: 'right' }))).toContain('class="sidebar docked-sidebar at-right"')
    // By the setting too, for a window that chose nothing but the column.
    expect(markupOf(snapshotOf(run(state, { type: 'settings/update', patch: { sidebarRight: true } }), { docked: true }))).toContain('at-right')
  })

  it('is not drawn while the sidebar is hidden (the edge opens the full floating sidebar)', () => {
    const { state } = fixture()
    const markup = markupOf(snapshotOf(run(state, { type: 'settings/update', patch: { sidebarVisible: false } }), { docked: true }))
    expect(markup).not.toContain('docked-sidebar')
    expect(markup).toContain('hot-edge')
  })

  it('shows the favourite a click on its tile opens (a space without pinned tab)', () => {
    const { state } = bareFixture()
    const all = elements(snapshotOf(state, { docked: true }))
    const button = (label: string) => all.find((element) => element.type === 'button' && element.props['aria-label'] === label)!
    ;(button('Agenda').props['onClick'] as () => void)()
    const favorite = state.favorites.find((f) => f.title === 'Agenda')!.id
    expect(holder.calls).toEqual([['dispatch', { type: 'favorite/open', id: favorite, spaceId: state.activeSpaceId }]])
  })

  it('shows a site on a click, asks the main process for the full sidebar back, and opens « Barre de cette fenêtre » on a right click', () => {
    const { state, id } = fixture()
    const all = elements(snapshotOf(state, { docked: true }))
    const button = (label: string) => all.find((element) => element.type === 'button' && element.props['aria-label'] === label)!
    ;(button('WhatsApp').props['onClick'] as () => void)()
    ;(button('Déplier la barre').props['onClick'] as () => void)()
    expect(holder.calls).toEqual([
      ['dispatch', { type: 'tab/select', id: id('WhatsApp') }],
      ['windowSidebar', { op: 'dock', docked: false }]
    ])
    holder.calls.length = 0
    const column = all.find((element) => element.type === 'nav')!
    ;(column.props['onContextMenu'] as (e: unknown) => void)({ target: { closest: () => null }, preventDefault: noop })
    expect(holder.calls).toEqual([['showMenu', { kind: 'space', id: state.activeSpaceId, sidebar: true }]])
    // A right click on a button of the column (« Nouvel onglet », « Déplier ») is not one on the column: no menu of the space.
    holder.calls.length = 0
    ;(column.props['onContextMenu'] as (e: unknown) => void)({ target: { closest: () => ({}) }, preventDefault: noop })
    expect(holder.calls).toEqual([])
  })

  it('opens the menu of a favourite (a space without pinned tab) or a tab on a right click on its tile, hung from the tile', () => {
    const { state, id } = fixture()
    const bare = bareFixture().state
    const buttonIn = (snapshot: UiSnapshot) => (label: string) => elements(snapshot).find((element) => element.type === 'button' && element.props['aria-label'] === label)!
    const tile = { getBoundingClientRect: () => ({ x: 8, y: 50, width: 40, height: 40 }) }
    const event = { currentTarget: tile, preventDefault: noop, stopPropagation: noop }
    ;(buttonIn(snapshotOf(bare, { docked: true }))('Mail').props['onContextMenu'] as (e: unknown) => void)(event)
    ;(buttonIn(snapshotOf(state, { docked: true }))('Slack').props['onContextMenu'] as (e: unknown) => void)(event)
    const mail = bare.favorites.find((f) => f.title === 'Mail')!.id
    const anchor = { x: 8, y: 50, width: 40, height: 40 }
    expect(holder.calls).toEqual([
      ['showMenu', { kind: 'favorite', id: mail, anchor }],
      ['showMenu', { kind: 'tab', id: id('Slack'), anchor }]
    ])
  })

  it('draws nothing at the edge of a docked window but the column: no strip, no resize handle, and the grip at the page-facing edge answers a double-click only', () => {
    const { state } = fixture()
    for (const side of [undefined, 'right'] as const) {
      const snapshot = snapshotOf(state, { docked: true, ...(side ? { side } : {}) })
      const markup = markupOf(snapshot)
      expect(markup).not.toContain('hot-edge')
      expect(markup).not.toContain('resize-handle')
      expect(markup.match(/class="dock-edge"/g)).toHaveLength(1)
      const grip = elements(snapshot).find((element) => element.props['className'] === 'dock-edge')!
      expect(Object.keys(grip.props).filter((name) => /^on(Mouse|Pointer|Drag|Touch)/.test(name) || name === 'onClick').sort()).toEqual([])
      ;(grip.props['onDoubleClick'] as () => void)()
      expect(holder.calls).toEqual([['windowSidebar', { op: 'dock', docked: false }]])
      holder.calls.length = 0
    }
    // The sheet gives the column no hover state for its edge, and no strip or handle of the full sidebar.
    const css = readFileSync(new URL('./docked-sidebar.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/\.dock-edge[^{]*:hover/)
    expect(css).not.toMatch(/hot-edge|resize-handle/)
  })

  it('is the column all the same with the compact mode on and the toolbar shown or not: nothing slides in from the edge, no strip is drawn', () => {
    const { state } = fixture()
    for (const showToolbar of [true, false]) {
      const compactOn = run(state, { type: 'settings/update', patch: { compactMode: true, showToolbar } })
      const markup = markupOf(snapshotOf(compactOn, { docked: true }))
      expect(markup).toContain('class="sidebar docked-sidebar at-left"')
      expect(markup).not.toContain('hot-edge')
      expect(tiles(markup).map((tag) => attr(tag, 'aria-label'))).toEqual(['Slack', 'WhatsApp'])
    }
  })

  it('opens no floating sidebar on a hover: no strip at its edge, and the pointer on a tile or a tool arms the bubble, never the edge', () => {
    vi.useFakeTimers()
    try {
      for (const { state } of [fixture(), bareFixture()]) {
        const snapshot = snapshotOf(state, { docked: true })
        expect(markupOf(snapshot)).not.toContain('hot-edge')
        holder.calls.length = 0
        const hover = { clientX: 20, clientY: 60 }
        for (const element of elements(snapshot)) {
          ;(element.props['onMouseEnter'] as ((e: unknown) => void) | undefined)?.(hover)
          ;(element.props['onMouseMove'] as ((e: unknown) => void) | undefined)?.(hover)
          vi.advanceTimersByTime(2000)
          ;(element.props['onMouseLeave'] as (() => void) | undefined)?.()
        }
        const names = holder.calls.map(([name]) => name)
        expect(names).not.toContain('hotEdge')
        // The bubbles still work: a tile or a tool says its name after the wait.
        expect(names).toContain('tooltip')
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the full sidebar of a window', () => {
  it('has « Replier la barre » at its top, which docks the sidebar of this window', () => {
    const { state } = fixture()
    const fold = elements(snapshotOf(state)).find((element) => element.type === 'button' && element.props['aria-label'] === 'Replier la barre')
    expect(fold?.props['className']).toBe('icon sidebar-dock')
    ;(fold!.props['onClick'] as () => void)()
    expect(holder.calls).toEqual([['windowSidebar', { op: 'dock', docked: true }]])
  })

  it('opens « Barre de cette fenêtre » before the menu of the space on a right click on itself', () => {
    const { state } = fixture()
    const aside = elements(snapshotOf(state)).find((element) => element.type === 'aside')!
    ;(aside.props['onContextMenu'] as (e: unknown) => void)({ target: { closest: () => null }, preventDefault: noop })
    expect(holder.calls).toEqual([['showMenu', { kind: 'space', id: state.activeSpaceId, sidebar: true }]])
  })

  it('docks on a double-click on the edge that resizes it', () => {
    const { state } = fixture()
    const edge = elements(snapshotOf(state)).find((element) => element.props['className'] === 'resize-handle')!
    ;(edge.props['onDoubleClick'] as () => void)()
    expect(holder.calls).toEqual([['windowSidebar', { op: 'dock', docked: true }]])
  })
})
