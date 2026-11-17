// The archive sweep and « Vider Aujourd'hui » with several windows: the real `Browser.dispatch` of two windows over the real views
// of one shared state (main/store.ts). A tab another window shows is never archived from this one, and with windows of their own the tabs of the
// other windows are swept too. The rule of the reducer alone: shared/sidebar-r22.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
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
const HOUR = 3_600_000

/** Three tabs of Today opened a day ago; the first window shows `a`, the second `b`, nobody `c`. */
function twoWindows(settings: Record<string, unknown> = {}) {
  let n = 0
  const ctx: Ctx = { now: 1_000, newId: () => `t${++n}` }
  let state = createInitialState(ctx)
  state = { ...state, settings: { ...state.settings, ...settings } }
  for (const url of ['https://a.example/', 'https://b.example/', 'https://c.example/']) state = reduce(state, { type: 'tab/open', url }, ctx)
  const [a, b, c] = state.tabs.map((tab) => tab.id) as [string, string, string]
  state = reduce(state, { type: 'tab/select', id: a }, ctx)
  const shared = new StateStore(state, null)
  const views = new Set<InstanceType<typeof WindowView>>()
  const first = new WindowView(shared, selectionOf(shared.get()), views, true)
  const second = new WindowView(shared, selectionOf(shared.get()), views, false, 'window-1')
  second.dispatch({ type: 'tab/select', id: b })
  // Every tab was last used a day before the sweep (a selection stamps the time of the clock).
  shared.replace({ ...shared.get(), tabs: shared.get().tabs.map((tab) => ({ ...tab, lastActiveAt: 1_000 })) })
  const group = new Set<unknown>()
  const browserOf = (store: InstanceType<typeof WindowView>) => {
    const fake = fakeBrowser({ store, group, isPrivate: () => false, dispatch: shell['dispatch'], tabsShownInGroup: shell['tabsShownInGroup'], closedHistoryCtx: () => undefined, reopenedWithHistory: () => null, reopened: { begin: () => null, end: () => {} } })
    group.add(fake.self)
    return fake.self
  }
  const browsers = [browserOf(first), browserOf(second)]
  // A day later, by the clock of the sweep.
  vi.spyOn(Date, 'now').mockReturnValue(1_000 + 24 * HOUR)
  const dispatch = (which: 0 | 1, action: unknown) => shell['dispatch']!.call(browsers[which], action)
  return { shared, first, second, a, b, c, dispatch }
}

describe('the archive and the windows', () => {
  it('the sweep of the first window leaves the tab the second one shows', () => {
    const { shared, first, second, a, b, c, dispatch } = twoWindows()
    expect(first.get().activeTabBySpace[first.get().activeSpaceId]).toBe(a)
    expect(second.get().activeTabBySpace[second.get().activeSpaceId]).toBe(b)
    dispatch(0, { type: 'archive/sweep' })
    expect(shared.get().tabs.map((tab) => tab.id)).toEqual([a, b])
    expect(shared.get().archive.map((entry) => entry.url)).toEqual(['https://c.example/'])
    void c
  })

  it('« Vider Aujourd’hui » in one window leaves what the other one shows, whatever the interface sent', () => {
    const { shared, a, b, dispatch } = twoWindows()
    dispatch(0, { type: 'today/clear', shownElsewhere: [] })
    expect(shared.get().tabs.map((tab) => tab.id)).toEqual([a, b])
  })

  it('with windows of their own, the sweep reaches the tabs of the other windows too', () => {
    const { shared, second, a, dispatch } = twoWindows({ independentWindows: true })
    // Two tabs of the second window's own: `d`, left a day ago, and `e`, on screen there.
    second.dispatch({ type: 'tab/open', url: 'https://d.example/' })
    const d = shared.get().tabs.at(-1)!.id
    second.dispatch({ type: 'tab/open', url: 'https://e.example/' })
    const e = shared.get().tabs.at(-1)!.id
    shared.replace({ ...shared.get(), tabs: shared.get().tabs.map((tab) => (tab.id === d ? { ...tab, lastActiveAt: 1_000 } : tab)) })
    dispatch(0, { type: 'archive/sweep' })
    const left = shared.get().tabs.map((tab) => tab.id)
    expect(left).not.toContain(d)
    expect(left).toContain(e)
    expect(left).toContain(a)
  })
})

describe('what an action carries of the other windows', () => {
  it('is text only, and bounded', async () => {
    const { shownElsewhereOf, SHOWN_ELSEWHERE_MAX } = await import('@shared/sidebar-helpers')
    expect(shownElsewhereOf(['a', 1, null, 'b'])).toEqual(['a', 'b'])
    expect(shownElsewhereOf('a')).toEqual([])
    expect(shownElsewhereOf(Array.from({ length: SHOWN_ELSEWHERE_MAX + 5 }, (_, i) => `t${i}`))).toHaveLength(SHOWN_ELSEWHERE_MAX)
  })
})
