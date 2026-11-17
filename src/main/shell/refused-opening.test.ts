// What the shell does after it asked for a tab that the state did not open. The state refuses some openings (an address too long to keep, a
// private tab while the setting is off, a locked space) and then holds the same tabs as before: the last tab of the state is one of the user's,
// with nothing to do with what was asked. Whoever wanted the new tab (to pair it in a split view, to write a summary in it) must then do nothing,
// and never take that tab instead. The real methods of the class Browser, on a stand-in; the menus of a favourite: context-menus.test.ts.

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { activeTab, createInitialState, reduce, splitFor, tabOpenedSince, type Action } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const TOO_LONG = `https://asked.example/#${'x'.repeat(70_000)}`

/** A window with two tabs, the first on screen and the second (the last of the state) elsewhere in the list. The actions are the real reducer's. */
function windowWithTwoTabs(settings: Partial<SidebarState['settings']> = {}, own: Record<string, unknown> = {}) {
  let n = 0
  const ctx = { now: 0, newId: () => `id-${n++}` }
  let state: SidebarState = createInitialState(ctx)
  const dispatched: Action[] = []
  const dispatch = (action: Action): void => {
    dispatched.push(action)
    state = reduce(state, action, ctx)
  }
  dispatch({ type: 'settings/update', patch: settings })
  dispatch({ type: 'tab/open', url: 'https://on-screen.example/' })
  dispatch({ type: 'tab/open', url: 'https://unrelated.example/', background: true })
  const [onScreen, unrelated] = state.tabs.map((t) => t.id) as [string, string]
  dispatched.length = 0
  const fake = fakeBrowser({
    store: { get: () => state },
    dispatch,
    isPrivate: () => false,
    pendingSplit: null,
    activePage: () => undefined,
    searchTemplateFor: shell['searchTemplateFor'],
    treeParent: () => ({}),
    ...own
  })
  return { fake, call: (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args), state: () => state, dispatched, onScreen, unrelated }
}

describe('the tab an action just opened', () => {
  it('is the one that was not there before, and none when the state opened nothing', () => {
    const w = windowWithTwoTabs()
    const before = w.state()
    expect(tabOpenedSince(before, before)).toBeUndefined()
    expect(tabOpenedSince(before, reduce(before, { type: 'tab/open', url: TOO_LONG }, { now: 1, newId: () => 'new' }))).toBeUndefined()
    expect(tabOpenedSince(before, reduce(before, { type: 'tab/select', id: w.unrelated }, { now: 1, newId: () => 'new' }))).toBeUndefined()
    expect(tabOpenedSince(before, reduce(before, { type: 'tab/open', url: 'https://new.example/' }, { now: 1, newId: () => 'new' }))?.id).toBe('new')
  })
})

describe('« Vue scindée » from the command bar', () => {
  it('pairs the tab on screen with the tab the address opened', () => {
    const w = windowWithTwoTabs()
    w.call('submitUrl', 'https://asked.example/', 'split')
    const opened = w.state().tabs.at(-1)!
    expect(opened.url).toBe('https://asked.example/')
    expect(splitFor(w.state(), w.onScreen)?.tabIds).toEqual([w.onScreen, opened.id])
  })

  it('pairs nothing when the address is refused: the last tab of the list is not taken in its place', () => {
    const w = windowWithTwoTabs()
    w.call('submitUrl', TOO_LONG, 'split')
    expect(w.state().tabs.map((t) => t.id)).toEqual([w.onScreen, w.unrelated])
    expect(w.dispatched.map((a) => a.type)).toEqual(['tab/open'])
    expect(w.state().splits).toEqual([])
    expect(activeTab(w.state())?.id).toBe(w.onScreen)
  })
})

describe('« Vue scindée » of a preview', () => {
  it('pairs the tab on screen with the tab the previewed page opened in', () => {
    const w = windowWithTwoTabs({}, { peek: { page: {}, url: 'https://previewed.example/' } })
    w.call('peekAction', 'open-in-split')
    const opened = w.state().tabs.at(-1)!
    expect(opened.url).toBe('https://previewed.example/')
    expect(splitFor(w.state(), w.onScreen)?.tabIds).toEqual([w.onScreen, opened.id])
  })

  it('pairs nothing when the page is refused its tab (a private preview, the private tabs switched off meanwhile)', () => {
    const w = windowWithTwoTabs({ privateTabs: false }, { peek: { page: {}, url: 'https://previewed.example/', private: true } })
    w.call('peekAction', 'open-in-split')
    expect(w.state().tabs.map((t) => t.id)).toEqual([w.onScreen, w.unrelated])
    expect(w.dispatched.map((a) => a.type)).toEqual(['tab/open'])
    expect(w.state().splits).toEqual([])
  })
})

describe('the summary in a tab of its own', () => {
  it('is tied to no tab when the window refused to open one (a locked space): the tab on screen is not taken for the tab of the summary', () => {
    const summaryTabs = new Set<string>()
    const summarizeTab = vi.fn(async () => ({ ok: false, error: 'never asked' }))
    // The window refuses the opening, as `Browser.dispatch` does for an action that concerns a locked space.
    const w = windowWithTwoTabs({}, { summaryTabs, summarizeTab, dispatch: () => undefined, openedBy: (_origin: string, open: () => void) => open() })
    expect(() => w.call('openSummaryTab')).not.toThrow()
    expect([...summaryTabs]).toEqual([])
    expect(summarizeTab).not.toHaveBeenCalled()
    expect(w.fake.names()).not.toContain('whenPage')
  })
})
