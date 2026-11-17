// The sheet « Sites qui ne répondent plus » (DeadTabsSheet.tsx), drawn with no window on a snapshot (as tidy-panel.test.ts does): a row for each tab
// with its icon, its name, its address, its reason and its space, ticked at first; what « Fermer les onglets cochés », « Tout garder » and « Afficher »
// ask of the main process. Which tabs are offered: shared/dead-tabs.test.ts.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { DeadTabEntry } from '@shared/dead-tabs'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) }), useSnapshot: () => holder.snapshot }))

import { DeadTabsSheet } from './DeadTabsSheet'
import { frenchSpaces } from '@shared/french-typography'
import { iconSource } from '@shared/site-icon'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.asked = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

/** Two spaces; three tabs in « Perso »: a test server gone, a site that refuses, and one with an icon of its own. */
function fixture(): { state: SidebarState; ids: string[] } {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, ctx)
  const spaceId = state.spaces[1]!.id
  for (const url of ['https://staging.example/app', 'https://refuse.example/', 'https://icon.example/']) state = reduce(state, { type: 'tab/open', url, background: true, spaceId }, ctx)
  state = { ...state, tabs: state.tabs.map((tab, i) => ({ ...tab, title: ['Ancien test', 'Refus', 'Avec icône'][i]!, ...(i === 2 ? { faviconUrl: 'https://icon.example/favicon.ico' } : {}) })) }
  return { state, ids: state.tabs.map((tab) => tab.id) }
}

const ENTRIES = (ids: string[]): DeadTabEntry[] => [
  { id: ids[0]!, reason: 'not-found' },
  { id: ids[1]!, reason: 'refused' },
  { id: ids[2]!, reason: 'timed-out' }
]

function sheet(state: SidebarState, entries: DeadTabEntry[], off?: ReadonlySet<string>, extra: Record<string, unknown> = {}) {
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, ...extra }
  const props = { entries, ...(off ? { initialOff: off } : {}) }
  const markup = renderToStaticMarkup(createElement(DeadTabsSheet, props))
  const elements = elementsOf(createElement(DeadTabsSheet, props))
  const text = (element: Element): string => {
    const children = element.props['children']
    return (Array.isArray(children) ? children : [children]).filter((child) => typeof child === 'string').join('')
  }
  const button = (label: string): Element => elements.find((element) => element.type === 'button' && (text(element) === label || element.props['aria-label'] === label))!
  const submit = (): void => (elements.find((element) => element.type === 'form')!.props['onSubmit'] as (event: { preventDefault(): void }) => void)({ preventDefault: () => undefined })
  const dispatched = (): Action[] => holder.asked.filter(([name]) => name === 'dispatch').map(([, args]) => args[0] as Action)
  const escape = (): void => (elements.find((element) => element.type === 'form')!.props['onKeyDown'] as (event: unknown) => void)({ nativeEvent: { key: 'Escape', defaultPrevented: false }, stopPropagation: () => undefined })
  return { markup, button, submit, escape, dispatched, asked: () => holder.asked.map(([name]) => name) }
}

describe('the sheet of the tabs whose site no longer answers', () => {
  it('is a dialog with a row for each tab: its icon, its name, its address, why, its space, and a tick box that is ticked', () => {
    const { state, ids } = fixture()
    const { markup } = sheet(state, ENTRIES(ids))
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain('>Sites qui ne répondent plus</h2>')
    expect(markup).toContain('3 onglets')
    for (const words of ['Ancien test', 'staging.example/app', 'Adresse introuvable', 'Refus', 'Connexion refusée', 'Délai dépassé', '🏡 Perso']) expect(markup, words).toContain(words)
    // The picture is the copy the main process keeps of the icon: the sheet asks the site for nothing.
    expect(markup).toContain(`src="${iconSource('https://icon.example/favicon.ico')}"`)
    expect(markup).not.toContain('src="https://')
    expect(markup.match(/<input type="checkbox"[^>]*\bchecked=""/g)).toHaveLength(3)
    expect(markup).toContain(frenchSpaces('aria-label="Fermer « Ancien test »"'))
    expect(markup).toContain(frenchSpaces('aria-label="Afficher l’onglet « Refus »"'))
    expect(markup).toContain('>Fermer les onglets cochés</button>')
    expect(markup).toContain('>Tout garder</button>')
    expect(markup).toContain('3 onglets cochés')
  })

  it('does not name the space when the window has only one', () => {
    let n = 0
    const ctx = { now: 1, newId: () => `id${++n}` }
    const state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://alone.example/', background: true }, ctx)
    const { markup } = sheet(state, [{ id: state.tabs[0]!.id, reason: 'reset' }])
    expect(markup).toContain('Connexion réinitialisée')
    expect(markup).not.toContain('dt-space')
  })

  it('closes the ticked tabs the usual way (to the archive, with « Annuler »), keeps the others, and goes', () => {
    const { state, ids } = fixture()
    const view = sheet(state, ENTRIES(ids), new Set([ids[1]!]))
    expect(view.markup).toContain('2 onglets cochés')
    view.submit()
    expect(view.dispatched()).toEqual([{ type: 'tabs/archive-many', ids: [ids[0], ids[2]] }, { type: 'tabs/keep-dead', ids: [ids[1]] }])
    expect(view.asked()).toContain('closeOverlay')
  })

  it('closes one tab with its own button, without ticking, and the sheet stays for the others', () => {
    const { state, ids } = fixture()
    const view = sheet(state, ENTRIES(ids))
    ;(view.button(frenchSpaces('Fermer maintenant « Refus »')).props['onClick'] as () => void)()
    expect(view.dispatched()).toEqual([{ type: 'tabs/archive-many', ids: [ids[1]] }])
    expect(view.asked()).not.toContain('closeOverlay')
  })

  it('goes with the last tab it closes by its own button', () => {
    const { state, ids } = fixture()
    const view = sheet(state, ENTRIES(ids).slice(0, 1))
    ;(view.button(frenchSpaces('Fermer maintenant « Ancien test »')).props['onClick'] as () => void)()
    expect(view.dispatched()).toEqual([{ type: 'tabs/archive-many', ids: [ids[0]] }])
    expect(view.asked()).toContain('closeOverlay')
  })

  it('keeps them all with « Tout garder », and closes none', () => {
    const { state, ids } = fixture()
    const view = sheet(state, ENTRIES(ids))
    ;(view.button('Tout garder').props['onClick'] as () => void)()
    expect(view.dispatched()).toEqual([{ type: 'tabs/keep-dead', ids }])
    expect(view.asked()).toContain('closeOverlay')
  })

  it('cannot close anything once every row is unticked', () => {
    const { state, ids } = fixture()
    const { markup } = sheet(state, ENTRIES(ids), new Set(ids))
    expect(markup).toMatch(/<button type="submit" class="tk-btn primary" disabled="">Fermer les onglets cochés<\/button>/)
    expect(markup).toContain('0 onglet coché')
  })

  it('shows a tab behind the sheet with « Afficher », and the sheet stays', () => {
    const { state, ids } = fixture()
    const view = sheet(state, ENTRIES(ids))
    ;(view.button(frenchSpaces('Afficher l’onglet « Refus »')).props['onClick'] as () => void)()
    expect(view.dispatched()).toEqual([{ type: 'tab/select', id: ids[1] }])
    expect(view.asked()).not.toContain('closeOverlay')
  })

  it('leaves out a tab closed since the notice, and the page of a favourite', () => {
    const { state, ids } = fixture()
    const changed = { ...state, tabs: state.tabs.filter((tab) => tab.id !== ids[0]).map((tab) => (tab.id === ids[1] ? { ...tab, favoriteId: 'fav' } : tab)) }
    const { markup } = sheet(changed, ENTRIES(ids))
    expect(markup).not.toContain('Ancien test')
    expect(markup).not.toContain('Refus<')
    expect(markup).toContain('Avec icône')
  })

  it('lists the pinned tabs first, in a group of their own, then those of the day, each under its heading', () => {
    const { state, ids } = fixture()
    const pinned = { ...state, tabs: state.tabs.map((tab) => (tab.id === ids[2] ? { ...tab, pinned: true } : tab)) }
    const { markup } = sheet(pinned, ENTRIES(ids))
    const at = (words: string) => markup.indexOf(words)
    expect(at('>Onglets épinglés</h3>')).toBeGreaterThan(-1)
    expect(at('>Aujourd’hui</h3>')).toBeGreaterThan(at('>Onglets épinglés</h3>'))
    expect(at('Avec icône')).toBeGreaterThan(at('>Onglets épinglés</h3>'))
    expect(at('Avec icône')).toBeLessThan(at('>Aujourd’hui</h3>'))
    expect(at('Ancien test')).toBeGreaterThan(at('>Aujourd’hui</h3>'))
    // The pinned one is ticked as well: the button of the sheet asks first. Its box says that it leaves the pinned tabs.
    expect(markup.match(/<input type="checkbox"[^>]*\bchecked=""/g)).toHaveLength(3)
    expect(markup).toContain(frenchSpaces('aria-label="Retirer « Avec icône » des onglets épinglés"'))
    expect(markup).toContain(frenchSpaces('aria-label="Fermer « Ancien test »"'))
  })

  it('has no heading when no pinned tab is among the rows', () => {
    const { state, ids } = fixture()
    expect(sheet(state, ENTRIES(ids)).markup).not.toContain('<h3')
  })

  it('sends the ticked tabs to the archive in one go, a pinned one with them, so that one « Annuler » brings them all back', () => {
    const { state, ids } = fixture()
    const pinned = { ...state, tabs: state.tabs.map((tab) => (tab.id === ids[2] ? { ...tab, pinned: true } : tab)) }
    const view = sheet(pinned, ENTRIES(ids), new Set([ids[1]!]))
    view.submit()
    expect(view.dispatched()).toEqual([{ type: 'tabs/archive-many', ids: [ids[2], ids[0]], pinned: true }, { type: 'tabs/keep-dead', ids: [ids[1]] }])
  })

  it('adds at the end the tabs a run finds while it is open, and says that the run goes on', () => {
    const { state, ids } = fixture()
    const { markup } = sheet(state, [ENTRIES(ids)[0]!], undefined, { deadTabs: [ENTRIES(ids)[0]!, ENTRIES(ids)[2]!], reloadRun: { done: 3, total: 9, phase: 'sleeping' } })
    expect(markup).toContain('2 onglets')
    expect(markup.indexOf('Avec icône')).toBeGreaterThan(markup.indexOf('Ancien test'))
    expect(markup).not.toContain('Refus<')
    expect(markup).toContain(frenchSpaces('L’actualisation continue : la liste se complète au fil des résultats.'))
    expect(sheet(state, [ENTRIES(ids)[0]!]).markup).not.toContain('L’actualisation continue')
  })

  it('leaves with Escape without keeping anything: the next run offers them again (« Tout garder » keeps them thirty days)', () => {
    const { state, ids } = fixture()
    const view = sheet(state, ENTRIES(ids))
    view.escape()
    expect(view.dispatched()).toEqual([])
    expect(view.asked()).toEqual(['closeOverlay'])
  })

  it('is written in the language of the interface', () => {
    setLanguage('en')
    const { state, ids } = fixture()
    const { markup } = sheet(state, ENTRIES(ids))
    for (const words of ['>Sites that no longer respond</h2>', 'Address not found', '>Close the checked tabs</button>', '>Keep all</button>', '3 tabs checked']) expect(markup, words).toContain(words)
  })
})
