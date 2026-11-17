// The main window put away on macOS, as the rest of the shell takes it: its browser drops its pages and makes none while away (the real
// methods of the class Browser on a stand-in), the menu brings it back before an entry acts on it, and main() reaches it through the window
// manager rather than through a window that may be gone. The window manager itself: main-window-away.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { createInitialState, reduce } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const { buildMenu } = await import('./menu')
const shell = methodsOf(Browser.prototype)

const ctx = { now: 1, newId: (() => { let n = 0; return () => `t${++n}` })() }
const stateWithTab = () => reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)

describe('the browser of a window put away', () => {
  function windowWithPages() {
    const state = stateWithTab()
    const pages = new Map([[state.tabs[0]!.id, {}], ['behind', {}]])
    const fake = fakeBrowser({ away: false, find: null, pages, store: { get: () => state }, isTabLocked: () => false, putAway: shell['putAway'], visibleIds: shell['visibleIds'] })
    const call = (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args)
    return { fake, call, state }
  }

  it('drops what it held, as a closed window, and shows nothing (no sync makes a page again) until it comes back', () => {
    const { fake, call, state } = windowWithPages()
    call('putAway', true)
    expect(fake.names()).toEqual(['closeOverlay', 'destroyPeek', 'destroySidePanel', 'destroyWebPanel', 'destroyPage', 'destroyPage', 'sync'])
    expect(fake.calls.filter((c) => c.name === 'destroyPage').map((c) => c.args[0])).toEqual([state.tabs[0]!.id, 'behind'])
    expect(call('visibleIds')).toEqual([])
    call('putAway', false)
    expect(fake.names().at(-1)).toBe('sync')
    expect(call('visibleIds')).toEqual([state.tabs[0]!.id])
  })

  it('does nothing when told what it already is', () => {
    const { fake, call } = windowWithPages()
    call('putAway', false)
    expect(fake.names()).toEqual([])
  })
})

describe('the menu while the main window is put away', () => {
  type Item = { label?: string; click?: () => void; enabled?: boolean; submenu?: Item[] }
  const leaves = (items: Item[]): Item[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))

  function menu(away?: () => void) {
    const order: string[] = []
    const browser = new Proxy({ openOverlay: (request: { panel: string }) => void order.push(`overlay:${request.panel}`), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
    // The entries the menu takes as they are (one function each, as main() gives them).
    const own = { windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}), newWindow: () => void order.push('newWindow'), privateWindow: () => void order.push('privateWindow'), checkForUpdates: () => void order.push('checkForUpdates') }
    const actions = new Proxy(own as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const state = stateWithTab()
    const items = leaves(buildMenu(browser as never, { get: () => state } as never, actions as never, away ? { away: () => (order.push('reveal'), away()) } : {}) as never)
    const item = (label: string) => items.find((entry) => entry.label === label)!
    return { order, item }
  }

  it('brings the window back before an entry acts on it: ⌘T, « Rechercher les mises à jour… »', () => {
    const { order, item } = menu(() => {})
    item(t('menu.nouvel-onglet')).click!()
    item(t('menu.rechercher-les-mises-a-jour')).click!()
    expect(order).toEqual(['reveal', 'overlay:commandbar', 'reveal', 'checkForUpdates'])
  })

  it('leaves it away for an entry that opens a window of its own (⌘N reveals it itself, a private window does not need it), and greys out the entries of the tab on screen', () => {
    const { order, item } = menu(() => {})
    item(t('menu.nouvelle-fenetre')).click!()
    item(t('menu.nouvelle-fenetre-privee')).click!()
    item(t('menu.reglages')).click!()
    expect(order).toEqual(['newWindow', 'privateWindow', 'overlay:settings'])
    expect(item(t('menu.archiver-l-onglet')).enabled).toBe(false)
  })

  it('is the usual menu while the window is there', () => {
    const { order, item } = menu()
    item(t('menu.nouvel-onglet')).click!()
    expect(order).toEqual(['overlay:commandbar'])
    expect(item(t('menu.archiver-l-onglet')).enabled).toBe(true)
  })
})

// That main() brings the main window back through the window manager (the Dock, a second launch, a command by address) and opens a window through newWindow: main-wiring.test.ts,
// where main() is run; ⌘N: app-menu-lock.test.ts; chrome.windows.create: the engine check `test:engine:extwindows` (smoke-extwindows.ts).
