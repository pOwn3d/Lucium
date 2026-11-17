// The profile of a space changed while another window shows one of its tabs: the window that changed it drops its pages at once
// (`Browser.dispatch`), and every other window, at its next sync, remakes the pages it holds in the session the tab no longer belongs to. The
// real methods of the class Browser on a stand-in; the containers keep the rule they had (a tab that enters or leaves one gets a new page).

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

function secondWindow() {
  let n = 0
  const ctx: Ctx = { now: 1, newId: () => `id${++n}` }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
  const [home, work] = state.spaces.map((space) => space.id) as [string, string]
  state = reduce(state, { type: 'tab/open', url: 'https://mail.example/', spaceId: work }, ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://news.example/', spaceId: home }, ctx)
  const [mail, news] = state.tabs.map((tab) => tab.id) as [string, string]
  let current = state
  const fake = fakeBrowser({
    store: { get: () => current },
    pages: new Map([[mail, {}], [news, {}]]),
    pageSession: new Map(),
    isPrivate: () => false,
    sessionKeyOf: shell['sessionKeyOf'],
    containerKeyOf: shell['containerKeyOf'],
    rebuildPagesOfChangedSession: shell['rebuildPagesOfChangedSession']
  })
  const self = fake.self as { pageSession: Map<string, string> }
  // The keys the pages were made with, as `ensurePage` records them.
  for (const id of [mail, news]) self.pageSession.set(id, shell['sessionKeyOf']!.call(fake.self, current.tabs.find((tab) => tab.id === id)) as string)
  return {
    fake,
    mail,
    news,
    work,
    change: (next: typeof state) => (current = next),
    state: () => current,
    sync: () => shell['rebuildPagesOfChangedSession']!.call(fake.self, current),
    destroyed: () => fake.calls.filter((call) => call.name === 'destroyPage').map((call) => call.args[0])
  }
}

describe('the pages a window holds when the profile of a space changes', () => {
  it('are remade for the tabs of that space only, by the window that did not change it', () => {
    const w = secondWindow()
    expect(w.fake.self['pageSession']).toEqual(new Map([[w.mail, 'profile:default'], [w.news, 'profile:default']]))
    w.change(reduce(w.state(), { type: 'space/update', id: w.work, patch: { profileId: 'travail' } }, { now: 2, newId: () => 'x' }))
    w.sync()
    expect(w.destroyed()).toEqual([w.mail])
  })

  it('are left alone while nothing about their session changed', () => {
    const w = secondWindow()
    w.sync()
    expect(w.destroyed()).toEqual([])
  })
})
