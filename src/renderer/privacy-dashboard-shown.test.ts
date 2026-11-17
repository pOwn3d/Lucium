// The privacy dashboard (session counters) is shown in the protection category. The category is drawn with the real components (no
// window), so a dashboard switched off in the code, or moved to another category, is seen on what the person reads.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { SETTINGS_PAGES, type SettingsPage, type UiSnapshot } from '@shared/ipc'
import { createInitialState, reduce } from '@shared/sidebar'
import { CategoryContent } from './SettingsCategories'
import { FoldPassContext } from './settings-context'

const ctx = { now: 1, newId: () => 'id' }
const noop = () => undefined

/** A window with one open page of the web, so that the dashboard has something to count. */
function snapshotWithAPage(): UiSnapshot {
  const initial = createInitialState(ctx)
  const state = reduce(initial, { type: 'tab/open', url: 'https://exemple.fr/a', spaceId: initial.spaces[0]!.id }, ctx)
  return { state, extensions: [], downloads: [] } as unknown as UiSnapshot
}

/** A category drawn whole (its top and its fold « Plus de réglages », as a search draws it): the dashboard may wait in the fold. */
const markup = (pane: SettingsPage): string =>
  renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: 'all' as const }, createElement(CategoryContent, { pane, snapshot: snapshotWithAPage(), update: noop, goTo: noop })))

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {} })
  setLanguage('fr')
})
afterAll(() => vi.unstubAllGlobals())

describe('the privacy dashboard', () => {
  it('is drawn in the protection category, with the counters of the open pages, and in no other category', () => {
    const drawn = SETTINGS_PAGES.filter((pane) => markup(pane).includes('Requêtes bloquées sur les pages ouvertes'))
    expect(drawn).toEqual(['protection'])
    expect(markup('protection')).toContain('<span class="pref-title">Tableau de bord</span>')
  })
})
