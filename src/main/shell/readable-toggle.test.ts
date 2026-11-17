// A click on the toolbar button « Contraste de la page » in the main process (page-commands.ts `toggleReadableSite`): the page moves to the next mode, Original, then
// Dark, then Light, then Original again; the site's entry is taken out when the default says the same, and nothing is written for a PDF (by its address or
// by the viewer that draws it), a page that takes no mode, a private tab or window. The state is the real one: the actions the click dispatches are
// reduced, so the list of sites is what is read.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({}, { get: (_t, prop: string) => (inert(prop) ? undefined : stub) })
})

import { toggleReadableSite } from './page-commands'

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const onPage = (url: string, ...more: Action[]) => run(createInitialState(ctx), { type: 'tab/open', url }, ...more)

/** The window of a state: its store applies what is dispatched. `private`: a private window; `systemDark`: the appearance of the interface; `pdf`: the viewer draws the page. */
function window(initial: SidebarState, options: { private?: boolean; systemDark?: boolean; pdf?: boolean } = {}) {
  let state = initial
  const dispatched: Action[] = []
  const toasts: string[] = []
  const browser = {
    dispatch: (action: Action) => {
      dispatched.push(action)
      state = reduce(state, action, ctx)
    },
    showToast: (text: string) => void toasts.push(text),
    isPrivate: () => options.private === true,
    isSystemDark: () => options.systemDark === true,
    showsPdf: () => options.pdf === true
  }
  const store = { get: () => state }
  const click = (tabId = state.tabs[0]!.id) => toggleReadableSite(browser as never, store as never, tabId)
  return { click, dispatched, toasts, state: () => state, sites: () => state.settings.siteReadableMode }
}

describe('a click on the button', () => {
  it('goes through the three modes in turn and comes back to Original with no entry left: Dark, Light, then Original', () => {
    const state = onPage('https://www.example.org/page')
    const w = window(state)
    w.click()
    expect(w.dispatched.at(-1)).toEqual({ type: 'readable/site', site: 'example.org', mode: 'dark', tabId: state.tabs[0]!.id })
    expect(w.sites()).toEqual({ 'example.org': 'dark' })
    w.click()
    expect(w.sites()).toEqual({ 'example.org': 'light' })
    w.click()
    // The default is Original: the entry goes, rather than an Original that says what the default says.
    expect(w.dispatched.at(-1)).toMatchObject({ type: 'readable/site', site: 'example.org', mode: null })
    expect(w.sites()).toEqual({})
    // Each click says what it did, with the site's name.
    expect(w.toasts).toHaveLength(3)
    for (const toast of w.toasts) expect(toast).toContain('example.org')
  })

  it('starts from the mode the page has by the default: Dark goes Light, Light goes Original, Automatic by the appearance of the interface', () => {
    const dark = window(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'dark' } }))
    dark.click()
    expect(dark.sites()).toEqual({ 'example.org': 'light' })
    const light = window(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'light' } }))
    light.click()
    expect(light.sites()).toEqual({ 'example.org': 'original' })
    const autoDark = window(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'auto' } }), { systemDark: true })
    autoDark.click()
    expect(autoDark.sites()).toEqual({ 'example.org': 'light' })
    const autoLight = window(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'auto' } }), { systemDark: false })
    autoLight.click()
    expect(autoLight.sites()).toEqual({ 'example.org': 'dark' })
  })

  it('takes the entry out when the default is the next mode: the site follows it again, and its siblings keep theirs', () => {
    const w = window(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'dark' } }, { type: 'readable/site', site: 'example.org', mode: 'original' }, { type: 'readable/site', site: 'autre.example', mode: 'light' }))
    w.click()
    expect(w.dispatched).toMatchObject([{ type: 'readable/site', site: 'example.org', mode: null }])
    expect(w.sites()).toEqual({ 'autre.example': 'light' })
  })

  it('writes a mode of its own for a subdomain whose parent domain has one, and leaves the parent’s entry', () => {
    const w = window(onPage('https://blog.example.org/', { type: 'readable/site', site: 'example.org', mode: 'light' }))
    w.click()
    expect(w.sites()).toEqual({ 'example.org': 'light', 'blog.example.org': 'original' })
  })
})

describe('where a click does nothing', () => {
  const nothing = (state: SidebarState, options: Parameters<typeof window>[1] = {}, tabId?: string) => {
    const w = window(state, options)
    w.click(tabId)
    expect(w.dispatched).toEqual([])
    expect(w.toasts).toEqual([])
  }

  it('does nothing for a private tab', () => {
    const state = onPage('https://example.org/', { type: 'tab/open', url: 'https://secret.example/', private: true })
    const priv = state.tabs.find((tab) => tab.private === true)!
    nothing(state, {}, priv.id)
    nothing(run(state, { type: 'settings/update', patch: { readableMode: 'dark' } }), {}, priv.id)
  })

  it('does nothing in a private window', () => {
    nothing(onPage('https://example.org/'), { private: true })
    nothing(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'dark' } }), { private: true })
  })

  it('does nothing for a page that takes no mode: not a web page, a PDF by its address, a PDF the viewer draws whatever its address', () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', 'view-source:https://example.org/', 'https://example.org/rapport.pdf']) nothing(onPage(url))
    nothing(onPage('https://example.org/telecharger?id=12'), { pdf: true })
  })

  it('does nothing for a tab that does not exist', () => {
    nothing(onPage('https://example.org/'), {}, 'nope')
  })
})
