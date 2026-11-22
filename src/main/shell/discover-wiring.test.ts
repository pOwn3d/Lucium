// « Découvrir Lucium » (shared/discover.ts) in the main process: the interface may open the panel, Aide › Découvrir Lucium opens it, a private window does not
// (its buttons lead to panels that window refuses), and every button of every card leads to a request the main process accepts, with the setting the card
// says it needs switched on, and no other: a card that forgot its `needs` would offer a button that does nothing.

import { describe, expect, it, vi } from 'vitest'
import { DISCOVER_ENTRIES, DISCOVER_REQUEST, discoverSettingsRequest, otherFeatures } from '@shared/discover'
import { t } from '@shared/i18n'
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
  const requests = DISCOVER_ENTRIES.flatMap((entry) => (entry.try.kind === 'open' ? [{ entry, request: entry.try.request }] : []))

  it('opens a request the main process accepts once the setting the card needs is on', () => {
    expect(requests.length).toBeGreaterThan(15)
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

  it('leads « Régler » to a page of the Settings the main process accepts, for the cards and for the other functions', () => {
    for (const entry of DISCOVER_ENTRIES) expect(validOverlay(discoverSettingsRequest(entry), storeWith()), entry.id).toBe(true)
    const others = otherFeatures({ query: '', task: 'all', level: 'all' })
    expect(others.length).toBeGreaterThan(50)
    for (const row of others) expect(validOverlay(row.request, storeWith()), row.feature.id).toBe(true)
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
