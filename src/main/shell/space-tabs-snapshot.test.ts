// « Gérer les espaces » with windows of their own: the snapshot of a window tells the tabs each space holds in every window, since deleting a space or
// putting it aside takes them all, while the window lists its own only. The method of the class Browser runs on a stand-in (browser-fake.test-support.ts)
// over the real views of one shared state (main/store.ts). The counts themselves: shared/window-tabs.test.ts and shared/space-manage.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import { selectionOf } from '@shared/window-selection'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({}, { get: (_t, prop) => (inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const { StateStore, WindowView } = await import('../store')
const shell = methodsOf(Browser.prototype)

function windows(independent: boolean) {
  let n = 0
  const ctx: Ctx = { now: 1_000, newId: () => `t${++n}` }
  let initial = createInitialState(ctx)
  initial = { ...initial, settings: { ...initial.settings, independentWindows: independent } }
  initial = reduce(initial, { type: 'tab/open', url: 'https://first-a.example/' }, ctx)
  initial = reduce(initial, { type: 'tab/open', url: 'https://first-b.example/' }, ctx)
  const shared = new StateStore(initial, null)
  const views = new Set<InstanceType<typeof WindowView>>()
  const first = new WindowView(shared, selectionOf(shared.get()), views, true)
  const second = new WindowView(shared, selectionOf(shared.get()), views, false, 'window-1')
  second.dispatch({ type: 'tab/open', url: 'https://second.example/' })
  const told = (store: InstanceType<typeof WindowView>, shown: SidebarState = store.get()) => shell['spaceTabsOfSnapshot']!.call(fakeBrowser({ store }).self, store.get(), shown) as { spaceTabs?: Record<string, number> }
  return { shared, first, second, told }
}

describe('the tabs of each space, in the snapshot of a window', () => {
  it('count the tabs of every window, which the window does not list', () => {
    const { shared, first, second, told } = windows(true)
    const space = shared.get().activeSpaceId
    expect(second.get().tabs.map((tab) => tab.url)).toEqual(['https://second.example/'])
    expect(told(second)).toEqual({ spaceTabs: { [space]: 3 } })
    expect(told(first)).toEqual({ spaceTabs: { [space]: 3 } })
  })

  it('are not told when the windows share their tabs: the window counts them itself', () => {
    const { second, told } = windows(false)
    expect(second.get().tabs).toHaveLength(3)
    expect(told(second)).toEqual({})
  })

  it('are not told while a lock hides part of the state: the numbers would tell what it hides', () => {
    const { second, told } = windows(true)
    expect(told(second, { ...second.get(), tabs: [] })).toEqual({})
  })
})
