// « Effacer les données de ces sites à la fermeture de leur dernier onglet » with windows of their own: the real `Browser.dispatch` of two windows
// over the real views of one shared state (main/store.ts). The last tab of a listed site is the last one of the whole state: a tab of the site in
// another window keeps its data, and closing that one erases them. The rule alone: shared/site-clear.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, type Ctx } from '@shared/sidebar'
import { selectionOf } from '@shared/window-selection'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const { StateStore, WindowView } = await import('../store')
const shell = methodsOf(Browser.prototype)

afterEach(() => vi.restoreAllMocks())

/** Two windows of their own, each with a tab of shop.example, the site listed for an erasure at close. */
function twoWindows() {
  let n = 0
  const ctx: Ctx = { now: 1_000, newId: () => `t${++n}` }
  let state = createInitialState(ctx)
  state = { ...state, settings: { ...state.settings, independentWindows: true, siteDataClearOnCloseEnabled: true, siteDataClearOnClose: ['shop.example'] } }
  const shared = new StateStore(state, null)
  const views = new Set<InstanceType<typeof WindowView>>()
  const first = new WindowView(shared, selectionOf(shared.get()), views, true)
  const second = new WindowView(shared, selectionOf(shared.get()), views, false, 'window-1')
  first.dispatch({ type: 'tab/open', url: 'https://shop.example/cart' })
  second.dispatch({ type: 'tab/open', url: 'https://shop.example/account' })
  const [mine, theirs] = shared.get().tabs.map((tab) => tab.id) as [string, string]
  const erased: unknown[] = []
  const group = new Set<unknown>()
  const browserOf = (store: InstanceType<typeof WindowView>) => {
    const fake = fakeBrowser({
      store,
      group,
      isPrivate: () => false,
      dispatch: shell['dispatch'],
      tabsShownInGroup: shell['tabsShownInGroup'],
      closedHistoryCtx: () => undefined,
      reopenedWithHistory: () => null,
      reopened: { begin: () => null, end: () => {} },
      clearOnClose: shell['clearOnClose'],
      clearTail: Promise.resolve(),
      runClearJob: async (job: unknown) => void erased.push(job)
    })
    group.add(fake.self)
    return fake.self
  }
  const browsers = [browserOf(first), browserOf(second)]
  const dispatch = async (which: 0 | 1, action: unknown) => {
    shell['dispatch']!.call(browsers[which], action)
    await (browsers[which]!['clearTail'] as Promise<void>)
  }
  return { shared, second, mine, theirs, erased, dispatch }
}

describe('the erasure at close of the last tab of a site, with windows of their own', () => {
  it('waits while another window still has a tab on the site', async () => {
    const { shared, mine, erased, dispatch } = twoWindows()
    await dispatch(0, { type: 'tab/close', id: mine })
    expect(shared.get().tabs.map((tab) => tab.url)).toEqual(['https://shop.example/account'])
    expect(erased).toEqual([])
  })

  it('erases once the last tab of the site in any window is closed', async () => {
    const { mine, theirs, erased, dispatch } = twoWindows()
    await dispatch(0, { type: 'tab/close', id: mine })
    await dispatch(1, { type: 'tab/close', id: theirs })
    expect(erased).toEqual([expect.objectContaining({ request: expect.objectContaining({ hosts: ['shop.example'] }) })])
  })

  it('erases the site of a tab of another window that the sweep of this one archived', async () => {
    const { shared, second, mine, theirs, erased, dispatch } = twoWindows()
    await dispatch(0, { type: 'tab/close', id: mine })
    // The second window goes on to another site: its tab of the shop, left a day ago, is swept by the first window.
    second.dispatch({ type: 'tab/open', url: 'https://other.example/' })
    shared.replace({ ...shared.get(), tabs: shared.get().tabs.map((tab) => ({ ...tab, lastActiveAt: 1_000 })) })
    vi.spyOn(Date, 'now').mockReturnValue(1_000 + 24 * 3_600_000)
    await dispatch(0, { type: 'archive/sweep' })
    expect(shared.get().tabs.some((tab) => tab.id === theirs)).toBe(false)
    expect(erased).toEqual([expect.objectContaining({ request: expect.objectContaining({ hosts: ['shop.example'] }) })])
  })
})
