// « Découvrir Lucium » (shared/discover.ts) in the main process: the interface may open the panel, Aide › Découvrir Lucium opens it, a private window does not
// (its buttons lead to panels that window refuses), and every button of every card leads to a request the main process accepts, with the setting the card
// says it needs switched on, and no other: a card that forgot its `needs` would offer a button that does nothing.

import { describe, expect, it, vi } from 'vitest'
import { ALL_DISCOVER_ENTRIES, DISCOVER_REQUEST, discoverSettingsRequest, discoverWhere, menuPath } from '@shared/discover'
import { setLanguage, t } from '@shared/i18n'
import type { OverlayRequest } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { canOpenInPrivate } from '@shared/private-window'
import { createInitialState } from '@shared/sidebar'

// ipc.ts and menu.ts reach Electron only when a message arrives or a menu is built.
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (_t, prop: string) => (prop in target ? target[prop] : inert(prop) ? undefined : stub) })
})

const { validOverlay } = await import('./ipc')
const { buildMenu } = await import('./menu')

/** A store whose settings are the defaults with every switch of the registry off (`off`), then the given ones on. */
function storeWith(on: Partial<Settings> = {}, everythingOff = true) {
  const base = defaultSettings()
  const off: Record<string, unknown> = {}
  if (everythingOff) for (const [key, value] of Object.entries(base)) if (value === true) off[key] = false
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...base, ...(off as Partial<Settings>), ...on } }
  return { get: () => state }
}

describe('the panel and the interface', () => {
  it('may be asked for by the interface (a link of Pour commencer, of the welcome, the command bar)', () => {
    expect(validOverlay(DISCOVER_REQUEST, storeWith())).toBe(true)
    expect(validOverlay({ panel: 'discover' }, storeWith({}, false))).toBe(true)
  })

  it('is not opened in a private window: its buttons lead to panels that window does not open', () => {
    expect(canOpenInPrivate('discover')).toBe(false)
  })
})

describe('every button of every card', () => {
  const requests = ALL_DISCOVER_ENTRIES.flatMap((entry) => (entry.try.kind === 'open' ? [{ entry, request: entry.try.request }] : []))

  it('opens a request the main process accepts once the setting the card needs is on', () => {
    expect(requests.length).toBeGreaterThan(25)
    for (const { entry, request } of requests) {
      const settings: Partial<Settings> = entry.needs === undefined ? {} : { [entry.needs]: true }
      expect(validOverlay(request, storeWith(settings)), entry.id).toBe(true)
    }
  })

  it('names the setting it needs whenever the main process refuses the request without it', () => {
    for (const { entry, request } of requests) {
      if (!validOverlay(request, storeWith())) expect(entry.needs, `${entry.id} is refused with the function off, and says nothing of it`).toBeDefined()
    }
  })

  it('leads « Régler » to a page of the Settings the main process accepts, for every card', () => {
    expect(ALL_DISCOVER_ENTRIES.length).toBeGreaterThan(140)
    for (const entry of ALL_DISCOVER_ENTRIES) expect(validOverlay(discoverSettingsRequest(entry), storeWith()), entry.id).toBe(true)
  })

  it('refuses what is not a panel it knows: a damaged request does not open anything', () => {
    expect(validOverlay({ panel: 'discover-everything' }, storeWith())).toBe(false)
    expect(validOverlay(null, storeWith())).toBe(false)
  })
})

describe('Aide › Découvrir Lucium', () => {
  interface Item {
    label?: string
    role?: string
    enabled?: boolean
    click?: () => void
    submenu?: Item[]
  }

  function help(isPrivate = false): { labels: string[]; item: Item | undefined; opened: OverlayRequest[] } {
    const opened: OverlayRequest[] = []
    const browser = new Proxy(
      { openOverlay: (request: OverlayRequest) => void opened.push(request), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>,
      { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
    )
    const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }
    const template = buildMenu(browser as never, { get: () => state } as never, actions as never, isPrivate ? ({ private: true } as never) : undefined) as unknown as Item[]
    const submenu = template.find((entry) => entry.role === 'help')?.submenu ?? []
    return { labels: submenu.map((entry) => entry.label ?? ''), item: submenu.find((entry) => entry.label === t('discover.titre')), opened }
  }

  it('is an entry of the menu, right after « Premiers pas », that opens the panel', () => {
    const { item, opened, labels } = help()
    expect(item).toBeDefined()
    expect(labels.indexOf(t('menu.premiers-pas'))).toBe(0)
    expect(labels.indexOf(t('discover.titre'))).toBe(1)
    item!.click!()
    expect(opened).toEqual([DISCOVER_REQUEST])
  })

  it('is greyed out in a private window, which does not open it', () => {
    expect(help(false).item?.enabled).not.toBe(false)
    expect(help(true).item?.enabled).toBe(false)
  })
})

describe('the menu paths the cards announce', () => {
  interface Entry {
    label?: string
    submenu?: Entry[]
  }

  /** The menu bar as it is built with every setting on, the menu of the window as it is when a page is open and every optional action given. */
  function menuTree(): Entry[] {
    const browser = new Proxy(
      { isPrivate: () => false, menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }), windowSidebar: () => ({ side: 'left', docked: false }) } as Record<string, unknown>,
      { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
    )
    const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const base = defaultSettings()
    const on: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(base)) if (typeof value === 'boolean') on[key] = true
    const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...base, ...(on as Partial<Settings>), aiSummary: true } }
    return buildMenu(browser as never, { get: () => state, root: () => ({ get: () => state }) } as never, actions as never) as unknown as Entry[]
  }

  const plain = (label: string | undefined): string => (label ?? '').replace(/…$/, '')
  /** Whether the path leads, step by step, to an entry of the menu bar (a trailing ellipsis of a label is not part of its name). */
  function leadsTo(tree: readonly Entry[], path: readonly string[]): boolean {
    let level: readonly Entry[] = tree
    for (const [index, step] of path.entries()) {
      const entry = level.find((candidate) => plain(candidate.label) === step)
      if (entry === undefined) return false
      if (index < path.length - 1 && entry.submenu === undefined) return false
      level = entry.submenu ?? []
    }
    return true
  }

  it('lead, step by step, to an entry of the menu bar as it is built, in French and in English', () => {
    const announced = ALL_DISCOVER_ENTRIES.flatMap((entry) => Object.entries(entry.menus ?? {}).map(([name, keys]) => ({ id: `${entry.id}.${name}`, keys })))
    expect(announced.length).toBeGreaterThan(35)
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      const tree = menuTree()
      for (const { id, keys } of announced) {
        const path = menuPath(keys).split(' › ')
        expect(leadsTo(tree, path), `${id} (${language}): « ${path.join(' › ')} » is not a path of the menus`).toBe(true)
      }
    }
    setLanguage('fr')
  })

  it('refuse a path the menus do not have: the checker is not satisfied by a label that is a command and no entry', () => {
    setLanguage('fr')
    const tree = menuTree()
    expect(leadsTo(tree, ['Édition', 'Rechercher', 'Rechercher'])).toBe(true)
    expect(leadsTo(tree, ['Édition', t('cmd.rechercher-dans-la-page')])).toBe(false)
    expect(leadsTo(tree, ['Fichier', 'Inconnu'])).toBe(false)
  })

  it('say the path of the search in the page as the menu has it', () => {
    setLanguage('fr')
    const card = ALL_DISCOVER_ENTRIES.find((entry) => entry.id === 'find')!
    expect(discoverWhere(card)).toBe('Menu Édition › Rechercher, puis «\u00a0Rechercher…\u00a0».')
    setLanguage('en')
    expect(discoverWhere(card)).toBe('Edit › Find menu, then “Find…”.')
    setLanguage('fr')
  })
})
