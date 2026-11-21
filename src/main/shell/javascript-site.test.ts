// The JavaScript switch of a site, in the shell: the response hook is brought in line, every tab on the site loads again (the policy comes with the
// answer of the server), a notice says so with a button that turns the scripts back on, and a choice that changes nothing touches nothing.
// The real `dispatch` of the shell, on a stand-in.

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

let counter = 0
const ctx = { now: 1, newId: () => `id${++counter}` }

/** A window with two tabs on `shop.example` and one on `news.example`; each page counts its reloads. */
function window() {
  let state: SidebarState = createInitialState(ctx)
  for (const url of ['https://shop.example/', 'https://shop.example/panier', 'https://news.example/']) state = reduce(state, { type: 'tab/open', url }, ctx)
  const reloads = new Map<string, number>()
  const pages = new Map(state.tabs.map((tab) => [tab.id, { reload: () => void reloads.set(tab.url, (reloads.get(tab.url) ?? 0) + 1) }]))
  const toasts: Array<{ text: string; action?: { label: string; run: () => void } }> = []
  const configured = { n: 0 }
  const fake: ReturnType<typeof fakeBrowser> = fakeBrowser({
    isPrivate: () => false,
    store: { get: () => state, root: () => ({ get: () => state }), dispatch: (action: Action) => void (state = reduce(state, action, ctx)) },
    closedHistoryCtx: () => ctx,
    pages,
    showToast: (text: string, action?: { label: string; run: () => void }) => void toasts.push({ text, action }),
    configureBlocker: () => void configured.n++,
    javascriptChanged: shell.javascriptChanged,
    dispatch: (action: Action) => shell.dispatch!.call(fake.self, action)
  })
  return { fake, reloads, toasts, configured, state: () => state, tab: (url: string) => state.tabs.find((tab) => tab.url === url)! }
}
const dispatch = (w: ReturnType<typeof window>, action: Action) => shell.dispatch!.call(w.fake.self, action)

describe('the shell applies the JavaScript switch of a site', () => {
  it('brings the hook in line, reloads the tabs of that site only, and says so with a way back', () => {
    const w = window()
    dispatch(w, { type: 'javascript/site', site: 'https://shop.example/', off: true, tabId: w.tab('https://shop.example/').id })
    expect(w.state().settings.siteJavascriptOff).toEqual(['shop.example'])
    expect(w.configured.n).toBe(1)
    expect([...w.reloads]).toEqual([['https://shop.example/', 1], ['https://shop.example/panier', 1]])
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]!.text).toContain('shop.example')
    // One click on the notice turns the scripts back on, and the pages load again.
    w.toasts[0]!.action!.run()
    expect(w.state().settings.siteJavascriptOff).toEqual([])
    expect(w.reloads.get('https://shop.example/')).toBe(2)
    expect(w.reloads.get('https://news.example/')).toBeUndefined()
  })

  it('reloads without a notice when the scripts come back, and does nothing for a choice that changes nothing or for a private tab', () => {
    const w = window()
    dispatch(w, { type: 'javascript/site', site: 'shop.example', off: false })
    dispatch(w, { type: 'javascript/site', site: 'lucium://settings', off: true })
    expect([w.configured.n, w.reloads.size, w.toasts.length]).toEqual([0, 0, 0])
    dispatch(w, { type: 'javascript/site', site: 'shop.example', off: true })
    w.toasts.length = 0
    dispatch(w, { type: 'javascript/site', site: 'shop.example', off: false })
    expect(w.toasts).toEqual([])
    expect(w.reloads.get('https://shop.example/')).toBe(2)
    dispatch(w, { type: 'tab/open', url: 'https://secret.example/', private: true })
    const before = w.configured.n
    dispatch(w, { type: 'javascript/site', site: 'secret.example', off: true, tabId: w.state().tabs.at(-1)!.id })
    expect([w.state().settings.siteJavascriptOff, w.configured.n]).toEqual([[], before])
  })
})
