// What the shell does with the address the engine reports for a tab (`handlePageUpdate`): a tab that comes back to the Extensions page, by a Back or a Forward after it went
// elsewhere, is on it again in the state, so that the page it shows is the page for its gate. The real method of the class Browser on a stand-in, over the real reducer.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action, type Ctx } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const PAGE = 'lucium-ui://extensions/'

function window_(options: { isPrivate?: boolean; tab?: Extract<Action, { type: 'tab/open' }> } = {}) {
  let n = 0
  const ctx: Ctx = { now: 1, newId: () => `tab-${++n}` }
  let state: SidebarState = createInitialState(ctx)
  const dispatched: Action[] = []
  state = reduce(state, options.tab ?? { type: 'tab/open', url: PAGE, allowInternalPages: true }, ctx)
  const id = state.tabs[0]?.id ?? 'tab-1'
  const dispatch = vi.fn((action: Action) => {
    dispatched.push(action)
    state = reduce(state, action, ctx)
  })
  const fake = fakeBrowser({
    store: { get: () => state, dispatch },
    isPrivate: () => options.isPrivate === true,
    runtime: { tabs: {}, canGoBack: false, canGoForward: false },
    committed: new Set<string>(),
    blankTabs: { addressCommitted: () => undefined },
    visible: new Set<string>(),
    colorUnread: new Set<string>(),
    pages: new Map(),
    autoplayRebuildWanted: () => false
  })
  return {
    id,
    update: (patch: Record<string, unknown>) => shell['handlePageUpdate']!.call(fake.self, id, patch),
    get state() {
      return state
    },
    dispatched
  }
}

describe('the address the engine reports for a tab', () => {
  it('follows the tab to the web and back to the Extensions page: after a Back onto it the tab is on it again', () => {
    const w = window_()
    w.update({ url: 'https://example.org/' })
    expect(w.state.tabs[0]?.url).toBe('https://example.org/')
    // Back: the document of the page commits in the tab again.
    w.update({ url: PAGE })
    expect(w.state.tabs[0]?.url).toBe(PAGE)
  })

  it('says so only for the address of the page, and to the reducer alone', () => {
    const w = window_()
    w.update({ url: 'https://example.org/' })
    w.update({ url: 'https://other.example/', title: 'x' })
    expect(w.dispatched.at(-1)).toMatchObject({ type: 'tab/update' })
    expect(w.dispatched.at(-1)).not.toHaveProperty('allowInternalPages')
    w.update({ url: `${PAGE}shortcuts` })
    expect(w.dispatched.at(-1)).toMatchObject({ type: 'tab/update', allowInternalPages: true })
  })

  it('does not take a private window’s tab for the page', () => {
    const w = window_({ isPrivate: true })
    w.update({ url: 'https://example.org/' })
    w.update({ url: PAGE })
    expect(w.dispatched.at(-1)).not.toHaveProperty('allowInternalPages')
    expect(w.state.tabs[0]?.url).toBe('https://example.org/')
  })

  it('does not take a look-alike for the page, even from the engine', () => {
    const w = window_()
    w.update({ url: 'https://example.org/' })
    for (const url of ['lucium-ui://extensions@evil/', 'lucium-ui://evil/', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui://extensions/assets/a.js']) {
      w.update({ url })
      expect(w.state.tabs[0]?.url, url).toBe('https://example.org/')
    }
  })
})
