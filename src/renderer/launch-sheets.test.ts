// The sheets of the launch, rendered to markup with the real components (no window): the welcome of the first launch, the news of an update, the
// question "Quitter ce site ?", and the group Accessibilité at the head of Apparence.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import type { ImportSourceInfo } from '@shared/import-sources'

vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => null }))

import { LeaveSheet } from './LeaveSheet'
import { CategoryContent } from './SettingsCategories'
import { FoldPassContext } from './settings-context'
import { WelcomeView } from './WelcomeSheet'
import { WhatsNewView } from './WhatsNewSheet'
import { frenchSpaces } from '@shared/french-typography'

afterEach(() => setLanguage('fr'))
const noop = () => undefined
const source = (id: string, name: string, found: boolean): ImportSourceInfo => ({ id, name, blurb: '', categories: ['bookmarks'], profiles: [], found })

describe('the welcome of the first launch', () => {
  const view = (patch: Partial<Parameters<typeof WelcomeView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(WelcomeView, { sources: [source('arc', 'Arc', true), source('chrome', 'Google Chrome', false), source('safari', 'Safari', true), source('brave', 'Brave', true)], appearance: 'auto', isDefault: false, onImport: noop, onAppearance: noop, onDefault: noop, onClose: noop, ...patch })
    )

  it('names the browsers it found among the four people come from, offers light, dark or the Mac, and the default browser', () => {
    const markup = view()
    expect(markup).toContain(frenchSpaces('Trouvés sur ce Mac : Arc, Safari.'))
    expect(markup).not.toContain('Brave')
    expect(markup.match(/name="welcome-look"/g)).toHaveLength(3)
    expect(markup).toMatch(/<input[^>]*checked=""[^>]*value="auto"|<input[^>]*value="auto"[^>]*checked=""/)
    expect(markup.match(/checked=""/g)).toHaveLength(1)
    expect(markup).toContain('Définir comme navigateur par défaut')
    expect(markup).toContain('Plus tard')
  })

  it('says so when no browser is found, and no longer offers the default browser once it is', () => {
    expect(view({ sources: [] })).toContain('Aucun autre navigateur trouvé sur ce Mac')
    const markup = view({ isDefault: true })
    expect(markup).toContain('Lucium est votre navigateur par défaut.')
    expect(markup).not.toContain('Définir comme navigateur par défaut')
  })
})

describe('the news of an update', () => {
  const sheet = (count: number, fromUpdate = true) => ({ version: '0.2.0', featured: 4, fromUpdate, points: Array.from({ length: count }, (_, i) => ({ title: `Point ${i + 1}`, text: `Texte ${i + 1}` })) })
  const view = (value: ReturnType<typeof sheet>) => renderToStaticMarkup(createElement(WhatsNewView, { sheet: value, onClose: noop, onNever: noop }))

  it('lists the first points, counts the others in "Voir tout", and offers "Ne plus montrer" only to the sheet an update opened', () => {
    const markup = view(sheet(7))
    expect(markup).toContain('Nouveautés de Lucium 0.2.0')
    expect(markup.match(/<li>/g)).toHaveLength(4)
    expect(markup).toContain('Voir tout (+3)')
    expect(markup).toContain('Ne plus montrer')
    const fromMenu = view(sheet(2, false))
    expect(fromMenu).not.toContain('Ne plus montrer')
    expect(fromMenu).not.toContain('Voir tout')
  })

  it('says it when the changelog holds nothing for the version', () => {
    expect(view(sheet(0))).toContain('Le journal des changements ne dit rien de cette version.')
  })
})

describe('"Quitter ce site ?"', () => {
  it('names the site, defaults to "Rester" (the primary button) and offers "Quitter" with its key', () => {
    const markup = renderToStaticMarkup(createElement(LeaveSheet, { request: { id: 'leave-1', site: 'exemple.fr' } }))
    expect(markup).toContain('role="alertdialog"')
    expect(markup).toContain('exemple.fr')
    expect(markup).toContain(frenchSpaces('Quitter ce site ?'))
    expect(markup).toMatch(/class="button primary"[^>]*>Rester<kbd>↩<\/kbd>/)
    expect(markup).toMatch(/class="button"[^>]*>Quitter<kbd>⌘↩<\/kbd>/)
    expect(markup).not.toContain('ne seront peut-être pas')
  })
})

describe('Apparence › Accessibilité', () => {
  it('is the first group of the category: the size of the interface, then the three preferences that can be forced', () => {
    const state = createInitialState({ now: 1, newId: () => 'id' })
    const snapshot = { state, extensions: [], downloads: [] } as unknown as UiSnapshot
    const markup = renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: 'all' as const }, createElement(CategoryContent, { pane: 'appearance', snapshot, update: noop, goTo: noop })))
    const order = ['uiScale', 'forceReduceMotion', 'forceHighContrast', 'forceReduceTransparency', 'hoverCards'].map((key) => markup.indexOf(`data-setting="${key}"`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(markup.indexOf('Accessibilité')).toBeLessThan(order[0]!)
  })
})
