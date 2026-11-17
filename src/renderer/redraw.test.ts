// What keeps the interface from drawing everything again at every snapshot: the rows and the toolbar are memoized by what they draw (the comparisons
// are tested in shared/row-equality.test.ts), the rows get a context that stays the same object while its content does, the language of the interface
// is in the keys (the texts come from t(), which the comparisons do not see), and the floating sidebar is not drawn while nothing floats. Drawn with the
// real components (no window); the passes of a probe stand for the snapshots that arrive one after the other.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { SidebarState, TabItem } from '@shared/model'
import { sameSplitRow, sameTabRow, sameToolbar } from '@shared/row-equality'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { expandedElements, rendersOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { Sidebar } from './Sidebar'
import { SidebarUiContext, SplitRow, TabRow, useStableUi, type SidebarUi } from './SidebarRows'
import { Toolbar } from './Toolbar'

const noop = (): void => undefined
const rows = new Set<unknown>([TabRow, SplitRow])
const ui = (patch: Partial<SidebarUi> = {}): SidebarUi => ({ selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop, ...patch })
const underUi = (probe: ReactElement): ReactElement => createElement(SidebarUiContext.Provider, { value: ui() }, probe)

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Three tabs of Today, the first two in a split view, the third on screen. */
function window3(): SidebarState {
  let state = createInitialState(ctx)
  for (const host of ['a', 'b', 'c']) state = run(state, { type: 'tab/open', url: `https://${host}.exemple.fr/` })
  const [a, b] = state.tabs.map((t) => t.id) as [string, string]
  return run(state, { type: 'split/create', tabId: a, withTabId: b })
}
const snapshotOf = (state: SidebarState, extra: Partial<UiSnapshot> = {}): UiSnapshot =>
  ({ state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false, ...extra }) as unknown as UiSnapshot
/** What the sidebar of `state` draws, its rows listed and not drawn. */
const sidebarOf = (state: SidebarState): Element[] => rendersOf(1, () => expandedElements(createElement(Sidebar, { snapshot: snapshotOf(state), space: state.spaces[0]! }), (type) => rows.has(type)), underUi)[0]!
const keysOf = (elements: Element[], type: unknown): string[] => elements.filter((element) => element.type === type).map((element) => String(element.key))

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the interface draws again only what changed', () => {
  it('draws a tab row, the row of a split view and the toolbar again only when what they draw changed', () => {
    const compare = (component: unknown): unknown => (component as { compare?: unknown }).compare
    expect(compare(TabRow)).toBe(sameTabRow)
    expect(compare(SplitRow)).toBe(sameSplitRow)
    expect(compare(Toolbar)).toBe(sameToolbar)
  })

  it('gives the rows a context that is the same object while its content is, whose functions call the latest of the sidebar', () => {
    const clicked: string[] = []
    const click = (name: string): SidebarUi['clickRow'] => () => void clicked.push(name)
    // Four renders: the same content twice (new functions each time, as the sidebar builds them), then a selection, then the same selection again.
    const given = [ui({ clickRow: click('first') }), ui({ clickRow: click('second') }), ui({ selected: new Set(['t']), clickRow: click('third') }), ui({ selected: new Set(['t']), clickRow: click('fourth') })]
    const [one, two, three, four] = rendersOf(given.length, (pass) => useStableUi(given[pass]!)) as [SidebarUi, SidebarUi, SidebarUi, SidebarUi]
    expect(two).toBe(one)
    expect(three).not.toBe(two)
    expect([...three.selected]).toEqual(['t'])
    expect(four).toBe(three)
    // The functions are fixed ones, which call those of the last render.
    expect(three.clickRow).toBe(one.clickRow)
    one.clickRow({ id: 't' } as TabItem, {} as never)
    expect(clicked).toEqual(['fourth'])
  })

  it('hands that context to the rows of the sidebar: two snapshots with the same content give the same object, a changed one a new object', () => {
    const state = window3()
    const snapshots = [state, structuredClone(state), run(state, { type: 'settings/update', patch: { tabStateBadges: !state.settings.tabStateBadges } })]
    const given = rendersOf(snapshots.length, (pass) => {
      const elements = expandedElements(createElement(Sidebar, { snapshot: snapshotOf(snapshots[pass]!), space: snapshots[pass]!.spaces[0]! }), (type) => rows.has(type))
      return elements.find((element) => element.type === SidebarUiContext.Provider)?.props['value'] as SidebarUi | undefined
    }, underUi)
    expect(given[0]).toBeDefined()
    expect(given[1]).toBe(given[0])
    expect(given[2]).not.toBe(given[1])
    expect(given[2]!.badges).toBe(!state.settings.tabStateBadges)
  })

  it('draws the rows of the sidebar again when the language of the interface changes', () => {
    const state = window3()
    // The third tab has a row of its own; the first two share the row of their split view.
    const c = state.tabs[2]!.id
    const split = state.splits[0]!.id
    const french = sidebarOf(state)
    expect(keysOf(french, TabRow)).toEqual([`${c}:fr`])
    expect(keysOf(french, SplitRow)).toEqual([`${split}:fr`])
    setLanguage('en')
    const english = sidebarOf(state)
    expect(keysOf(english, TabRow)).toEqual([`${c}:en`])
    expect(keysOf(english, SplitRow)).toEqual([`${split}:en`])
  })
})

describe('the window', () => {
  /**
   * The App of a window, imported with the address its page has (the floating sidebar is a page of its own, `#float`), and the components of that
   * import (the modules are loaded again, so the rows, the toolbar and the language of the interface are new objects too).
   */
  async function appOf(hash: string) {
    vi.stubGlobal('location', { hash })
    vi.resetModules()
    const [{ App }, rowsModule, { Toolbar: AppToolbar }, i18n] = await Promise.all([import('./App'), import('./SidebarRows'), import('./Toolbar'), import('@shared/i18n')])
    const kept = new Set<unknown>([rowsModule.TabRow, rowsModule.SplitRow, AppToolbar])
    const elements = (): Element[] =>
      rendersOf(1, () => expandedElements(createElement(App), (type) => kept.has(type)), (probe) => createElement(rowsModule.SidebarUiContext.Provider, { value: ui() }, probe))[0]!
    return { App, AppToolbar, elements, setAppLanguage: i18n.setLanguage }
  }

  it('draws the toolbar of the page and those of a split view again when the language of the interface changes', async () => {
    const { AppToolbar, elements, setAppLanguage } = await appOf('')
    const toolbars = (state: SidebarState): string[] => {
      holder.snapshot = snapshotOf(state)
      return keysOf(elements(), AppToolbar)
    }
    const split = window3()
    const [a, b] = split.tabs.map((t) => t.id) as [string, string]
    const single = run(split, { type: 'tab/select', id: split.tabs[2]!.id })
    expect(toolbars(single)).toEqual(['fr'])
    expect(toolbars(run(split, { type: 'tab/select', id: a }))).toEqual([`${a}:fr`, `${b}:fr`])
    setAppLanguage('en')
    expect(toolbars(single)).toEqual(['en'])
    expect(toolbars(run(split, { type: 'tab/select', id: a }))).toEqual([`${a}:en`, `${b}:en`])
  })

  it('does not draw the floating sidebar while nothing floats', async () => {
    const { App } = await appOf('#float')
    const state = window3()
    const drawn = (floating: UiSnapshot['floating']): string => {
      holder.snapshot = snapshotOf(state, { floating })
      return renderToStaticMarkup(createElement(App))
    }
    expect(drawn('in')).toMatch(/^<div class="shell floating-shell[^"]*"[^>]*><(aside|div|nav)/)
    expect(drawn(undefined)).toMatch(/^<div class="shell floating-shell[^"]*"[^>]*><\/div>$/)
  })
})
