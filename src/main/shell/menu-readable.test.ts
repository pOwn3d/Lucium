// View › Appearance › "Contraste de la page pour ce site": the entries set the readable mode of the site on screen, check the one it has, and are greyed out where
// the choice cannot be made (no web page, a private tab, a private window). Same harness as menu-items.test.ts: the real menu, `Menu` replaced by a function
// that hands the template back.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

import { buildMenu } from './menu'

interface Item {
  label?: string
  type?: string
  checked?: boolean
  enabled?: boolean
  click?: () => void
  submenu?: Item[]
}

const find = (items: Item[], label: string): Item | undefined => {
  for (const item of items) {
    if (item.label === label) return item
    const inner = item.submenu ? find(item.submenu, label) : undefined
    if (inner) return inner
  }
  return undefined
}

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

function menuOf(state: SidebarState, options: { private?: boolean } = {}) {
  const dispatched: Action[] = []
  const toasts: string[] = []
  const browser = new Proxy(
    { dispatch: (action: Action) => void dispatched.push(action), showToast: (text: string) => void toasts.push(text), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const template = buildMenu(browser as never, store, actions as never, options) as unknown as Item[]
  const entry = find(template, 'Contraste de la page pour ce site')
  return { entry, choices: entry?.submenu ?? [], dispatched, toasts }
}

const onPage = (url: string, ...more: Action[]) => run(createInitialState(ctx), { type: 'tab/open', url }, ...more)
const tabId = (state: SidebarState) => state.tabs[0]!.id

describe('View › Appearance › Page Contrast for This Site', () => {
  it('offers the site’s choices — the other sites, Original, Sombre, Clair — as radio entries, always, since no switch gates it any more', () => {
    const { entry, choices } = menuOf(onPage('https://example.org/'))
    expect(entry?.enabled).toBe(true)
    expect(choices.map((c) => c.label)).toEqual(['Comme les autres sites', 'Original', 'Sombre', 'Clair'])
    expect(choices.every((c) => c.type === 'radio')).toBe(true)
  })

  it('checks "Comme les autres sites" for a site with no mode of its own, whatever the default is', () => {
    for (const readableMode of ['original', 'dark'] as const) {
      const { choices } = menuOf(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode } }))
      expect(choices.filter((c) => c.checked).map((c) => c.label), readableMode).toEqual(['Comme les autres sites'])
    }
  })

  it('checks the mode the site on screen has, its parent domain’s included', () => {
    const own = menuOf(onPage('https://example.org/', { type: 'readable/site', site: 'example.org', mode: 'light' }))
    expect(own.choices.filter((c) => c.checked).map((c) => c.label)).toEqual(['Clair'])
    const parent = menuOf(onPage('https://blog.example.org/', { type: 'readable/site', site: 'example.org', mode: 'dark' }))
    expect(parent.choices.filter((c) => c.checked).map((c) => c.label)).toEqual(['Sombre'])
  })

  it('sets the mode of the site on screen (by its host, without www) from the tab on screen, and says so', () => {
    const state = onPage('https://www.example.org/page')
    const expected: Array<[string, 'original' | 'dark' | 'light' | null]> = [['Original', 'original'], ['Sombre', 'dark'], ['Clair', 'light'], ['Comme les autres sites', null]]
    for (const [label, mode] of expected) {
      const { choices, dispatched, toasts } = menuOf(state)
      choices.find((c) => c.label === label)!.click!()
      expect(dispatched, label).toEqual([{ type: 'readable/site', site: 'example.org', mode, tabId: tabId(state) }])
      expect(toasts, label).toHaveLength(1)
      expect(toasts[0], label).toContain('example.org')
    }
  })

  it('is greyed out with no web page on screen, for a private tab, and in a private window', () => {
    expect(menuOf(onPage('about:blank')).entry?.enabled).toBe(false)
    expect(menuOf(onPage('file:///tmp/a.html')).entry?.enabled).toBe(false)
    const priv = onPage('https://example.org/', { type: 'tab/open', url: 'https://secret.example/', private: true })
    expect(priv.tabs.at(-1)?.private).toBe(true)
    expect(menuOf(priv).entry?.enabled).toBe(false)
    expect(menuOf(onPage('https://example.org/'), { private: true }).entry?.enabled).toBe(false)
  })

  it('does not set anything for a private tab even if its entry is clicked', () => {
    const priv = onPage('https://example.org/', { type: 'tab/open', url: 'https://secret.example/', private: true })
    const { choices, dispatched, toasts } = menuOf(priv)
    choices.find((c) => c.label === 'Sombre')!.click!()
    expect(dispatched).toEqual([])
    expect(toasts).toEqual([])
  })
})
