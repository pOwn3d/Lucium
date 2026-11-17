// A button a list repeats on each of its rows (« Retirer », « Modifier », « Oublier ») is named after its row: a screen reader lists the buttons
// of a page by their names alone, and ten « Retirer » say nothing of what each one removes. The categories of the Settings are drawn for real
// (no window) on a state that holds two rows of every list the state can fill, and no two of their row buttons may share a name.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { frenchSpaces } from '@shared/french-typography'
import { SETTINGS_PAGES, type SettingsPage, type UiSnapshot } from '@shared/ipc'
import { historyColumns } from '@shared/history-days'
import type { HistoryEntry, Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { FindReplace } from './FindReplace'
import { LinkRoutes } from './LinksSettings'
import { HistoryView } from './ManagePanels'
import { CategoryContent } from './SettingsCategories'
import { FoldPassContext } from './settings-context'

// Whole categories of the Settings are drawn, every component in them called: more than the 5 s of a test when every core is taken.
vi.setConfig({ testTimeout: 30_000 })

const noop = (): void => undefined

/** A state with two rows in every list of the Settings that the state alone fills. */
function filled(): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const boost = (id: string, name: string) => ({ id, name, host: 'exemple.fr', enabled: true, css: 'a{}', js: '' })
  const extension = (id: string, name: string) => ({ id, name, version: '1.0', profileId: 'default', source: 'store' as const, enabled: true, update: { version: '2.0' } })
  const settings: Partial<Settings> = {
    linkRoutes: [{ host: 'a.exemple.fr', spaceId: state.spaces[0]!.id }, { host: 'b.exemple.fr', spaceId: state.spaces[0]!.id }],
    openWithMemory: true,
    openWithApps: { pdf: '/Applications/Preview.app', zip: '/Applications/Archive.app' },
    extensionPaths: ['/tmp/une', '/tmp/autre'],
    siteSearches: [{ keyword: 'w', name: 'Wikipédia', url: 'https://fr.wikipedia.org/wiki/%s' }, { keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?q=%s' }]
  }
  return {
    state: {
      ...state,
      settings: { ...state.settings, ...settings },
      boosts: [boost('b1', 'Sans bandeau'), boost('b2', 'Texte large')],
      sitePermissions: { 'https://a.exemple.fr': { notifications: 'allow', geolocation: 'deny' }, 'https://b.exemple.fr': { geolocation: 'deny' } }
    },
    extensions: [extension('e1', 'Bloqueur'), extension('e2', 'Coffre')],
    downloads: []
  } as unknown as UiSnapshot
}

const underLevel = (probe: ReactElement): ReactElement => createElement(FoldPassContext.Provider, { value: 'all' as const }, probe)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as Element).props['children'])
  return ''
}

/** The names of the row buttons of a category: `aria-label` when there is one, else the text. */
function rowButtons(pane: SettingsPage, snapshot: UiSnapshot): string[] {
  return elementsOf(createElement(CategoryContent, { pane, snapshot, update: noop, goTo: noop }), undefined, underLevel)
    .filter((element) => element.type === 'button' && element.props['className'] === 'link-button')
    .map((element) => (element.props['aria-label'] as string | undefined) ?? textOf(element.props['children']))
}

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
})
afterAll(() => vi.unstubAllGlobals())

describe('the buttons a list of the Settings repeats on its rows', () => {
  const names = new Map<SettingsPage, string[]>()
  const all = (): string[] => {
    if (names.size === 0) for (const pane of SETTINGS_PAGES) names.set(pane, rowButtons(pane, filled()))
    return [...names.values()].flat()
  }

  it('are named after their row: what the button does, then what it does it to', () => {
    const drawn = all()
    const expected = [
      'Désactiver : Sans bandeau',
      'Modifier : Texte large',
      // The ellipsis of the visible word (« Changer… ») is not read in the middle of a name.
      'Changer : .pdf',
      'Retirer .zip',
      'Retirer /tmp/une',
      'Retirer Wikipédia',
      'Retirer YouTube',
      'Oublier : a.exemple.fr, Notifications',
      'Oublier : a.exemple.fr, Position',
      'Oublier : b.exemple.fr, Position',
      'Désinstaller : Bloqueur dans le profil « Profil par défaut »',
      'Examiner la mise à jour : Coffre dans le profil « Profil par défaut »'
    ].map(frenchSpaces)
    for (const name of expected) expect(drawn, name).toContain(name)
  })

  it('never share a name inside a category', () => {
    all()
    for (const [pane, drawn] of names) {
      const twice = drawn.filter((name, index) => drawn.indexOf(name) !== index)
      expect(twice, pane).toEqual([])
    }
  })
})

describe('the other repeated buttons', () => {
  it('« Oublier » of a page of the history says which page', () => {
    const entries = [{ url: 'https://a.exemple.fr/', title: 'Une page', lastVisitAt: 1, visitCount: 1 }, { url: 'https://b.exemple.fr/', title: '', lastVisitAt: 1, visitCount: 1 }] as unknown as HistoryEntry[]
    const buttons = elementsOf(createElement(HistoryView, { columns: historyColumns(entries, new Set(), null, false, 2), query: '', onPick: noop, onOpen: noop, onForget: noop })).filter((element) => element.type === 'button' && element.props['children'] === 'Oublier')
    expect(buttons.map((element) => element.props['aria-label'])).toEqual([frenchSpaces('Oublier : Une page'), frenchSpaces('Oublier : https://b.exemple.fr/')])
  })

  it('« Retirer » of a rule that sends the links of a site to a space says which site', () => {
    const buttons = elementsOf(createElement(LinkRoutes, { snapshot: filled(), update: noop }), undefined, underLevel).filter((element) => element.type === 'button' && element.props['className'] === 'link-button')
    expect(buttons.map((element) => element.props['aria-label'])).toEqual(['Retirer a.exemple.fr', 'Retirer b.exemple.fr'])
  })

  it('« Tout » of the replacement is named « Tout remplacer »: its tooltip was no part of its name', () => {
    holder.snapshot = { ...filled(), find: null }
    const markup = renderToStaticMarkup(createElement(FindReplace))
    expect(markup).toMatch(/<button class="fr-text"[^>]*aria-label="Tout remplacer"[^>]*>Tout<\/button>/)
  })
})
