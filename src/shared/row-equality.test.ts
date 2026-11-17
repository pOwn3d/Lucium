import { describe, expect, it } from 'vitest'
import type { RuntimeState, TabItem } from './model'
import { rowsContextKey, sameData, sameSplitRow, sameTabRow, sameToolbar, type RowsContextData, type ToolbarInputs } from './row-equality'

const tab = (id: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId: 's', url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2, ...extra })
const runtime = (tabs: RuntimeState['tabs'] = {}): RuntimeState => ({ tabs, canGoBack: false, canGoForward: false })
const awake = { loading: false, audible: false, muted: false, awake: true }
/** What crossing the process boundary does to a snapshot: the same values in objects that are not the same objects. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('sameData', () => {
  it('holds for copies of the same data and fails for any difference', () => {
    const data = { a: [1, { b: 'x' }], c: null, d: undefined }
    expect(sameData(data, { a: [1, { b: 'x' }], c: null, d: undefined })).toBe(true)
    expect(sameData(data, { a: [1, { b: 'y' }], c: null, d: undefined })).toBe(false)
    expect(sameData(data, { a: [1, { b: 'x' }, 2], c: null, d: undefined })).toBe(false)
    expect(sameData([], {})).toBe(false)
    expect(sameData({ a: undefined }, { b: undefined })).toBe(false)
    expect(sameData(null, undefined)).toBe(false)
    expect(sameData(NaN, NaN)).toBe(true)
  })
})

describe('a tab row', () => {
  const base = () => ({ tab: tab('a', { autoReload: { minutes: 5 } as never }), active: false, inSplit: false, tabbable: false, tree: { depth: 1, below: 0, folded: false }, runtime: runtime({ a: awake, b: awake }) })

  it('is not drawn again for a new snapshot that says the same about it', () => {
    const before = base()
    expect(sameTabRow(before, copy(before))).toBe(true)
  })

  it('is not drawn again when another tab changes (its title, its sound, its turn in a reload of every tab)', () => {
    const before = base()
    const after = { ...copy(before), runtime: { ...runtime({ a: awake, b: { ...awake, audible: true, loading: true } }), reloadMarks: { b: 'running' as const } } }
    expect(sameTabRow(before, after)).toBe(true)
  })

  it.each([
    ['its title', (r: ReturnType<typeof base>) => ({ ...r, tab: { ...r.tab, title: 'Autre' } })],
    ['its icon', (r: ReturnType<typeof base>) => ({ ...r, tab: { ...r.tab, faviconUrl: 'https://a.example/i.png' } })],
    ['its address', (r: ReturnType<typeof base>) => ({ ...r, tab: { ...r.tab, url: 'https://a.example/other' } })],
    ['its automatic reload', (r: ReturnType<typeof base>) => ({ ...r, tab: { ...r.tab, autoReload: { minutes: 10 } as never } })],
    ['being the tab on screen', (r: ReturnType<typeof base>) => ({ ...r, active: true })],
    ['being in a split view', (r: ReturnType<typeof base>) => ({ ...r, inSplit: true })],
    ['being a stop of the Tab key', (r: ReturnType<typeof base>) => ({ ...r, tabbable: true })],
    ['its place in the tree', (r: ReturnType<typeof base>) => ({ ...r, tree: { depth: 1, below: 2, folded: true } })],
    ['leaving the tree', (r: ReturnType<typeof base>) => ({ ...r, tree: undefined })],
    ['its sound', (r: ReturnType<typeof base>) => ({ ...r, runtime: runtime({ a: { ...awake, audible: true }, b: awake }) })],
    ['going to sleep', (r: ReturnType<typeof base>) => ({ ...r, runtime: runtime({ a: { ...awake, awake: false }, b: awake }) })],
    ['loading', (r: ReturnType<typeof base>) => ({ ...r, runtime: runtime({ a: { ...awake, loading: true }, b: awake }) })],
    ['its turn in « Actualiser tous les onglets »', (r: ReturnType<typeof base>) => ({ ...r, runtime: { ...runtime({ a: awake, b: awake }), reloadMarks: { a: 'pending' as const } } })],
    ['the end of its reload countdown', (r: ReturnType<typeof base>) => ({ ...r, runtime: runtime({ a: { ...awake, reloadAt: 1_000 }, b: awake }) })],
    ['losing its runtime entry', (r: ReturnType<typeof base>) => ({ ...r, runtime: runtime({ b: awake }) })]
  ])('is drawn again when %s changes', (_what, change) => {
    const before = base()
    expect(sameTabRow(before, change(copy(before)))).toBe(false)
  })
})

describe('the row of a split view', () => {
  const base = () => ({ tabs: [tab('a'), tab('b')], anchor: 'a', activeId: 'a' as string | null | undefined, runtime: runtime({ a: awake, b: awake }) })

  it('is not drawn again for a copy, nor when a tab outside it changes', () => {
    const before = base()
    expect(sameSplitRow(before, copy(before))).toBe(true)
    expect(sameSplitRow(before, { ...copy(before), runtime: runtime({ a: awake, b: awake, c: { ...awake, audible: true } }) })).toBe(true)
  })

  it.each([
    ['a title', (r: ReturnType<typeof base>) => ({ ...r, tabs: [tab('a', { title: 'Autre' }), tab('b')] })],
    ['the tab on screen', (r: ReturnType<typeof base>) => ({ ...r, activeId: 'b' })],
    ['a tab going to sleep', (r: ReturnType<typeof base>) => ({ ...r, runtime: runtime({ a: awake, b: { ...awake, awake: false } }) })],
    ['the members', (r: ReturnType<typeof base>) => ({ ...r, tabs: [tab('a')] })]
  ])('is drawn again when %s changes', (_what, change) => {
    const before = base()
    expect(sameSplitRow(before, change(copy(before)))).toBe(false)
  })
})

describe('the toolbar', () => {
  const base = (): ToolbarInputs => ({ space: { profileId: 'default' }, current: tab('a'), runtime: runtime({ a: { ...awake, canGoBack: true }, b: awake }), sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true, zoomMark: null, sidebarRight: false, leading: 0 })

  it('is not drawn again for a copy, nor when another tab loads or plays', () => {
    const before = base()
    expect(sameToolbar(before, copy(before))).toBe(true)
    expect(sameToolbar(before, { ...copy(before), runtime: runtime({ a: { ...awake, canGoBack: true }, b: { ...awake, loading: true, audible: true } }) })).toBe(true)
  })

  it.each([
    ['the address of the page', (r: ToolbarInputs) => ({ ...r, current: tab('a', { url: 'https://a.example/next' }) })],
    ['the page it shows', (r: ToolbarInputs) => ({ ...r, current: tab('b') })],
    // Guard: the button « Annoter » appears when a page of the window shares it: the bar must render again. Without the field in the comparison,
    // the bar kept the old picture and the button never showed.
    ['the page annotation sharing this window', (r: ToolbarInputs) => ({ ...r, annotate: true })],
    ['no page', (r: ToolbarInputs) => ({ ...r, current: undefined })],
    ['what the page can do (back)', (r: ToolbarInputs) => ({ ...r, runtime: { ...r.runtime, canGoBack: true } })],
    ['what the page can do (forward)', (r: ToolbarInputs) => ({ ...r, runtime: { ...r.runtime, canGoForward: true } })],
    ['back closing the tab', (r: ToolbarInputs) => ({ ...r, runtime: { ...r.runtime, backCloses: true } })],
    ['the colour the page declares', (r: ToolbarInputs) => ({ ...r, runtime: runtime({ a: { ...awake, canGoBack: true, color: '#336699' }, b: awake }) })],
    ['the profile of the space', (r: ToolbarInputs) => ({ ...r, space: { profileId: 'work' } })],
    ['the sidebar being shown', (r: ToolbarInputs) => ({ ...r, sidebarVisible: false })],
    ['the zoom mark', (r: ToolbarInputs) => ({ ...r, zoomMark: '125 %' })],
    ['room for the traffic lights', (r: ToolbarInputs) => ({ ...r, leading: 70 })],
    ['the line of loading (tabStateBadges)', (r: ToolbarInputs) => ({ ...r, badges: true })],
    ['becoming a pane', (r: ToolbarInputs) => ({ ...r, pane: { style: { left: 0 }, focused: true } })]
  ])('is drawn again when %s changes', (_what, change) => {
    const before = base()
    expect(sameToolbar(before, change(copy(before)))).toBe(false)
  })

  it('tells the panes of a split view apart by their place and their focus', () => {
    const pane = { ...base(), pane: { style: { left: 0, width: 400 }, focused: true } }
    expect(sameToolbar(pane, copy(pane))).toBe(true)
    expect(sameToolbar(pane, { ...copy(pane), pane: { style: { left: 0, width: 500 }, focused: true } })).toBe(false)
    expect(sameToolbar(pane, { ...copy(pane), pane: { style: { left: 0, width: 400 }, focused: false } })).toBe(false)
  })
})

describe('the context of the rows', () => {
  const base = (): RowsContextData => ({ selected: new Set(['a', 'b']), dragging: new Set<string>(), mark: { at: 'tab:a', edge: 'before', target: { kind: 'tab', id: 'a' } }, developerHosts: ['localhost'], containers: [{ id: 'c1', name: 'Travail', color: '#fff' }], tree: false, compact: undefined })

  it('is the same for a copy of the same content (the sidebar builds a new object at each render)', () => {
    const before = base()
    expect(rowsContextKey({ ...copy({ ...before, selected: [], dragging: [] }), selected: new Set(['a', 'b']), dragging: new Set<string>() })).toBe(rowsContextKey(before))
    expect(rowsContextKey(base())).toBe(rowsContextKey(base()))
    // A mark that is not there is the same whether it is null or absent.
    expect(rowsContextKey({ ...base(), mark: null })).toBe(rowsContextKey({ ...base(), mark: undefined }))
    // No mark of a proxy is the same whether the map is empty or absent, and a copy of the same marks is the same.
    expect(rowsContextKey({ ...base(), proxyMarks: new Map() })).toBe(rowsContextKey(base()))
    expect(rowsContextKey({ ...base(), proxyMarks: new Map([['a', 'container']]) })).toBe(rowsContextKey({ ...base(), proxyMarks: new Map([['a', 'container']]) }))
    // The reason is part of the mark: its words change with it.
    expect(rowsContextKey({ ...base(), proxyMarks: new Map([['a', 'container']]) })).not.toBe(rowsContextKey({ ...base(), proxyMarks: new Map([['a', 'private']]) }))
  })

  it.each([
    ['the selection', (d: RowsContextData) => ({ ...d, selected: new Set(['a']) })],
    ['the order of the selection', (d: RowsContextData) => ({ ...d, selected: new Set(['b', 'a']) })],
    ['what is dragged', (d: RowsContextData) => ({ ...d, dragging: new Set(['a']) })],
    ['the insertion mark', (d: RowsContextData) => ({ ...d, mark: { at: 'tab:b', edge: 'after', target: { kind: 'tab', id: 'b' } } })],
    ['no mark', (d: RowsContextData) => ({ ...d, mark: null })],
    ['the developer sites', (d: RowsContextData) => ({ ...d, developerHosts: [] })],
    ['a container', (d: RowsContextData) => ({ ...d, containers: [{ id: 'c1', name: 'Perso', color: '#fff' }] })],
    ['the tab tree', (d: RowsContextData) => ({ ...d, tree: true })],
    ['the tabs that wear the mark of a profile’s proxy', (d: RowsContextData) => ({ ...d, proxyMarks: new Map([['a', 'container']]) })],
    ['the state marks of the rows (tabStateBadges)', (d: RowsContextData) => ({ ...d, badges: true })],
    ['the compact mode', (d: RowsContextData) => ({ ...d, compact: { fullUrl: false } })],
    ['the compact mode showing the whole address', (d: RowsContextData) => ({ ...d, compact: { fullUrl: true } })]
  ])('is another one when %s changes', (_what, change) => {
    expect(rowsContextKey(change(base()))).not.toBe(rowsContextKey(base()))
  })

  it('redraws a row when its page becomes frozen or fails to load (the flags are part of its runtime entry)', () => {
    const before = { tab: tab('a'), active: false, inSplit: false, runtime: runtime({ a: awake }) }
    expect(sameTabRow(before, { ...copy(before), runtime: runtime({ a: { ...awake, awake: false, frozen: true } }) })).toBe(false)
    expect(sameTabRow(before, { ...copy(before), runtime: runtime({ a: { ...awake, failed: true } }) })).toBe(false)
  })

  it('tells the compact mode with and without the whole address apart', () => {
    expect(rowsContextKey({ ...base(), compact: { fullUrl: true } })).not.toBe(rowsContextKey({ ...base(), compact: { fullUrl: false } }))
  })
})
