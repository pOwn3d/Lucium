// The menu of the toolbar's button « Contraste de la page » (context-menus.ts, kind `readable`) and the builder it shares with View › Appearance › Contraste de la page
// pour ce site (readable-menu.ts): the three modes with the one the page has ticked, « Comme les autres sites (…) » only for a site that has a mode of its
// own, the same action and the same notice as the View menu, and no menu at all where the button is not drawn. Same harness as menu-readable.test.ts and
// context-menus.test.ts: the real menus, `Menu` replaced by a function that hands the template back.

import { describe, expect, it, vi } from 'vitest'
import { activeTab, createInitialState, reduce, type Action } from '@shared/sidebar'
import { setLanguage } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import type { ReadableMode } from '@shared/readable-mode'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, setTemplateImage: () => undefined }) }
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} }, nativeImage }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

import { menuItems } from './context-menus'
import { buildMenu } from './menu'
import { setReadableSite } from './page-commands'

interface Item {
  label?: string
  type?: string
  checked?: boolean
  enabled?: boolean
  click?: () => void
  submenu?: Item[]
}

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const onPage = (url: string, ...more: Action[]) => run(createInitialState(ctx), { type: 'tab/open', url }, ...more)

function fakeBrowser(options: { private?: boolean; systemDark?: boolean } = {}) {
  const dispatched: Action[] = []
  const toasts: string[] = []
  const base: Record<string, unknown> = {
    dispatch: (action: Action) => void dispatched.push(action),
    showToast: (text: string) => void toasts.push(text),
    isPrivate: () => options.private === true,
    isSystemDark: () => options.systemDark === true,
    menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false })
  }
  const browser = new Proxy(base, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
  return { browser, dispatched, toasts }
}

/** The menu of the toolbar's button for tab `id` (the first tab by default). */
function toolbarMenu(state: SidebarState, options: { private?: boolean; systemDark?: boolean; id?: string } = {}) {
  const { browser, dispatched, toasts } = fakeBrowser(options)
  const items = menuItems({ kind: 'readable', id: options.id ?? state.tabs[0]!.id }, browser as never, { get: () => state } as never, {} as never) as Item[]
  return { items, dispatched, toasts }
}

/** The submenu of View › Apparence › Contraste de la page pour ce site for the tab on screen. */
function viewMenu(state: SidebarState) {
  const { browser, dispatched, toasts } = fakeBrowser()
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const template = buildMenu(browser as never, { get: () => state } as never, actions as never, {}) as unknown as Item[]
  const find = (items: Item[]): Item | undefined => {
    for (const item of items) {
      if (item.label === 'Contraste de la page pour ce site') return item
      const inner = item.submenu ? find(item.submenu) : undefined
      if (inner) return inner
    }
    return undefined
  }
  return { items: find(template)?.submenu ?? [], dispatched, toasts }
}

const labels = (items: Item[]): string[] => items.filter((i) => i.type !== 'separator').map((i) => i.label!)
const ticked = (items: Item[]): string[] => items.filter((i) => i.checked).map((i) => i.label!)

describe('the menu of the button « Contraste de la page »', () => {
  it('lists Original, Sombre and Clair as radio entries, with the mode of the page ticked', () => {
    const { items } = toolbarMenu(onPage('https://example.org/'))
    expect(labels(items)).toEqual(['Original', 'Sombre', 'Clair'])
    expect(items.every((i) => i.type === 'radio')).toBe(true)
    expect(ticked(items)).toEqual(['Original'])
  })

  it('ticks the default of a site that has no mode of its own, and offers nothing to give it back', () => {
    for (const [readableMode, name] of [['dark', 'Sombre'], ['light', 'Clair'], ['original', 'Original']] as const) {
      const { items } = toolbarMenu(onPage('https://example.org/', { type: 'settings/update', patch: { readableMode } }))
      expect(ticked(items), readableMode).toEqual([name])
      expect(items.some((i) => i.type === 'separator'), readableMode).toBe(false)
      expect(labels(items).some((label) => label.startsWith('Comme les autres sites')), readableMode).toBe(false)
    }
  })

  it('ticks what Automatic comes to: Sombre while the interface is dark, Original while it is light', () => {
    const state = onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'auto' } })
    expect(ticked(toolbarMenu(state, { systemDark: true }).items)).toEqual(['Sombre'])
    expect(ticked(toolbarMenu(state, { systemDark: false }).items)).toEqual(['Original'])
  })

  it('ticks the mode of the site over the default, its parent domain’s included', () => {
    expect(ticked(toolbarMenu(onPage('https://example.org/', { type: 'readable/site', site: 'example.org', mode: 'light' })).items)).toEqual(['Clair'])
    expect(ticked(toolbarMenu(onPage('https://blog.example.org/', { type: 'readable/site', site: 'example.org', mode: 'dark' })).items)).toEqual(['Sombre'])
    const against = onPage('https://example.org/', { type: 'settings/update', patch: { readableMode: 'dark' } }, { type: 'readable/site', site: 'example.org', mode: 'original' })
    expect(ticked(toolbarMenu(against).items)).toEqual(['Original'])
  })

  it('adds, for a site with a mode of its own, a separator and « Comme les autres sites » with the default in brackets', () => {
    const own = (readableMode: 'original' | 'dark' | 'light' | 'auto') => onPage('https://example.org/', { type: 'settings/update', patch: { readableMode } }, { type: 'readable/site', site: 'example.org', mode: 'light' })
    for (const [readableMode, name] of [['original', 'Original'], ['dark', 'Sombre'], ['light', 'Clair'], ['auto', 'Automatique']] as const) {
      const { items } = toolbarMenu(own(readableMode))
      expect(items.map((i) => i.type === 'separator' ? '-' : i.label), readableMode).toEqual(['Original', 'Sombre', 'Clair', '-', `Comme les autres sites (${name})`])
      expect(items.at(-1)!.type, 'a command, not a tick').not.toBe('radio')
    }
  })

  it('speaks English with the English labels', () => {
    setLanguage('en')
    try {
      const { items } = toolbarMenu(onPage('https://example.org/', { type: 'readable/site', site: 'example.org', mode: 'dark' }))
      expect(items.map((i) => i.type === 'separator' ? '-' : i.label)).toEqual(['Original', 'Dark', 'Light', '-', 'Same as Other Sites (Original)'])
    } finally {
      setLanguage('fr')
    }
  })

  it('sets the mode of the site of the tab by its host, without www, with the action and the notice of the View menu', () => {
    const state = onPage('https://www.example.org/page', { type: 'readable/site', site: 'example.org', mode: 'light' })
    const expected: Array<[string, ReadableMode | null]> = [['Original', 'original'], ['Sombre', 'dark'], ['Clair', 'light'], ['Comme les autres sites (Original)', null]]
    for (const [label, mode] of expected) {
      const { items, dispatched, toasts } = toolbarMenu(state)
      items.find((i) => i.label === label)!.click!()
      expect(dispatched, label).toEqual([{ type: 'readable/site', site: 'example.org', mode, tabId: state.tabs[0]!.id }])
      expect(toasts, label).toHaveLength(1)
      expect(toasts[0], label).toContain('example.org')
    }
  })

  it('is the View menu’s own set of entries: the same labels, and the same action and notice for the same choice', () => {
    const state = onPage('https://www.example.org/page', { type: 'readable/site', site: 'example.org', mode: 'light' })
    const view = viewMenu(state)
    const toolbar = toolbarMenu(state)
    // The three modes are the same entries; the View menu puts « Comme les autres sites » first, the toolbar’s last and with the default named.
    expect(labels(view.items).slice(1)).toEqual(labels(toolbar.items).slice(0, 3))
    for (const label of ['Original', 'Sombre', 'Clair']) {
      const fromView = viewMenu(state)
      const fromToolbar = toolbarMenu(state)
      fromView.items.find((i) => i.label === label)!.click!()
      fromToolbar.items.find((i) => i.label === label)!.click!()
      expect(fromToolbar.dispatched, label).toEqual(fromView.dispatched)
      expect(fromToolbar.toasts, label).toEqual(fromView.toasts)
    }
    const giveBackView = viewMenu(state)
    const giveBackToolbar = toolbarMenu(state)
    giveBackView.items.find((i) => i.label === 'Comme les autres sites')!.click!()
    giveBackToolbar.items.find((i) => i.label === 'Comme les autres sites (Original)')!.click!()
    expect(giveBackToolbar.dispatched).toEqual(giveBackView.dispatched)
    expect(giveBackToolbar.toasts).toEqual(giveBackView.toasts)
  })

  it('works on the tab the button is on, not on the one on screen', () => {
    const state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://one.example/' }, { type: 'tab/open', url: 'https://two.example/', background: true })
    const [one, two] = [state.tabs[0]!, state.tabs[1]!]
    const { items, dispatched } = toolbarMenu(state, { id: two.id })
    items.find((i) => i.label === 'Sombre')!.click!()
    expect(dispatched).toEqual([{ type: 'readable/site', site: 'two.example', mode: 'dark', tabId: two.id }])
    expect(one.id).not.toBe(two.id)
  })
})

describe('where the menu of the button gives nothing', () => {
  it('has no entry for a page that takes no mode: not a web page, a PDF', () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', 'view-source:https://example.org/', 'https://example.org/rapport.pdf']) {
      expect(toolbarMenu(onPage(url)).items, url).toEqual([])
    }
  })

  it('has no entry for a private tab', () => {
    const priv = onPage('https://example.org/', { type: 'tab/open', url: 'https://secret.example/', private: true })
    expect(priv.tabs.at(-1)?.private).toBe(true)
    expect(toolbarMenu(priv, { id: priv.tabs.at(-1)!.id }).items).toEqual([])
    // The normal tab of the same window still has its menu.
    expect(toolbarMenu(priv, { id: priv.tabs[0]!.id }).items.length).toBeGreaterThan(0)
  })

  it('has no entry in a private window', () => {
    expect(toolbarMenu(onPage('https://example.org/'), { private: true }).items).toEqual([])
  })

  it('has no entry for a tab that does not exist: nothing is set for an identifier made up', () => {
    expect(toolbarMenu(onPage('https://example.org/'), { id: 'nope' }).items).toEqual([])
  })

  it('sets nothing for a private tab it is given, even while the tab on screen is a normal one (the choice is never written for a private tab)', () => {
    const state = onPage('https://example.org/', { type: 'tab/open', url: 'https://secret.example/', private: true, background: true })
    const priv = state.tabs.find((tab) => tab.private === true)!
    expect(activeTab(state)?.private).not.toBe(true)
    const { browser, dispatched, toasts } = fakeBrowser()
    setReadableSite(browser as never, { get: () => state } as never, 'dark', priv)
    expect(dispatched).toEqual([])
    expect(toasts).toEqual([])
  })

  it('sets nothing for a tab that is not a web page either', () => {
    const state = onPage('about:blank')
    const { browser, dispatched } = fakeBrowser()
    setReadableSite(browser as never, { get: () => state } as never, 'dark', state.tabs[0])
    expect(dispatched).toEqual([])
  })
})
