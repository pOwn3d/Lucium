// The unread-count switch of a site, in the shell: a change of the list makes every window of the group look at its rows again (so that a count already
// on screen goes at once); a choice that changes nothing touches nothing. The real `dispatch` of the shell, on a stand-in.

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

let counter = 0
const ctx = { now: 1, newId: () => `id${++counter}` }

function window() {
  let state: SidebarState = createInitialState(ctx)
  const refreshed = [vi.fn(), vi.fn()]
  const group = new Set<unknown>(refreshed.map((refreshAllUnread) => ({ refreshAllUnread })))
  const fake: ReturnType<typeof fakeBrowser> = fakeBrowser({
    isPrivate: () => false,
    store: { get: () => state, root: () => ({ get: () => state }), dispatch: (action: Action) => void (state = reduce(state, action, ctx)) },
    closedHistoryCtx: () => ctx,
    group
  })
  return { fake, refreshed, state: () => state }
}
const dispatch = (w: ReturnType<typeof window>, action: Action) => shell.dispatch!.call(w.fake.self, action)

describe('the shell applies the unread-count switch of a site', () => {
  it('makes every window of the group look at its rows again when the list changes', () => {
    const w = window()
    dispatch(w, { type: 'unread/site', site: 'https://murmure.example/', off: true })
    expect(w.state().settings.siteUnreadOff).toEqual(['murmure.example'])
    expect(w.refreshed.map((fn) => fn.mock.calls.length)).toEqual([1, 1])
    dispatch(w, { type: 'unread/site', site: 'murmure.example', off: false })
    expect(w.refreshed.map((fn) => fn.mock.calls.length)).toEqual([2, 2])
  })

  it('touches nothing when the choice changes nothing', () => {
    const w = window()
    dispatch(w, { type: 'unread/site', site: 'murmure.example', off: false })
    expect(w.refreshed.map((fn) => fn.mock.calls.length)).toEqual([0, 0])
  })
})
