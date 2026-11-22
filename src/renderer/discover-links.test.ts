// The ways into « Découvrir Lucium » (shared/discover.ts) from the sheets people see first: « Pour commencer » of the Settings (next to the count of the
// optional functions), the welcome of the first launch, and the news of an update. Each is a real button that asks for the panel, and says why in words.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISCOVER_REQUEST } from '@shared/discover'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import type { UiSnapshot } from '@shared/ipc'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) }), useSnapshot: () => null }))
vi.mock('./use-platform', () => ({ usePlatform: () => 'darwin' }))

import { HomePage } from './SettingsHome'
import { WelcomeSheet, WelcomeView } from './WelcomeSheet'
import { WhatsNewSheet, WhatsNewView } from './WhatsNewSheet'

beforeEach(() => {
  setLanguage('fr')
  holder.asked = []
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

const noop = () => undefined
const buttonsLabelled = (elements: Element[], label: string): Element[] =>
  elements.filter((element) => element.type === 'button' && JSON.stringify(element.props['children']).includes(label))

describe('« Pour commencer »', () => {
  it('has a button that opens « Découvrir Lucium », next to the count of the optional functions', () => {
    const state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }
    const snapshot = { state, extensions: [], downloads: [] } as unknown as UiSnapshot
    const elements = elementsOf(createElement(HomePage, { snapshot, update: noop, goTo: noop }))
    const [discover] = buttonsLabelled(elements, 'Découvrir ce que Lucium sait faire')
    expect(discover).toBeDefined()
    ;(discover!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual([['openOverlay', [DISCOVER_REQUEST]]])
    expect(buttonsLabelled(elements, 'Voir les fonctions')).toHaveLength(1)
  })
})

describe('the welcome of the first launch', () => {
  const view = (patch: Partial<Parameters<typeof WelcomeView>[0]> = {}) => createElement(WelcomeView, { sources: [], appearance: 'auto', isDefault: true, onImport: noop, onAppearance: noop, onDefault: noop, onClose: noop, ...patch })

  it('offers « Voir ce que Lucium sait faire », a button that asks for the panel', () => {
    const onDiscover = vi.fn()
    const [button] = buttonsLabelled(elementsOf(view({ onDiscover })), 'Voir ce que Lucium sait faire')
    expect(button).toBeDefined()
    ;(button!.props['onClick'] as () => void)()
    expect(onDiscover).toHaveBeenCalledTimes(1)
  })

  it('is given its way by the sheet the application opens: the button asks for the panel', () => {
    const [shown] = elementsOf(createElement(WelcomeSheet)).filter((element) => element.type === WelcomeView)
    ;(shown!.props['onDiscover'] as () => void)()
    expect(holder.asked).toEqual([['openOverlay', [DISCOVER_REQUEST]]])
  })

  it('leaves the button out when it has nowhere to lead (the sheet drawn alone)', () => {
    expect(renderToStaticMarkup(view())).not.toContain('Voir ce que Lucium sait faire')
  })

  it('says it in English too', () => {
    setLanguage('en')
    expect(renderToStaticMarkup(view({ onDiscover: noop }))).toContain('See what Lucium can do')
  })
})

describe('the news of an update', () => {
  const sheet = { version: '1.2.0', featured: 4, fromUpdate: true, points: [{ title: 'Point', text: 'Texte' }] }
  const view = (patch: Partial<Parameters<typeof WhatsNewView>[0]> = {}) => createElement(WhatsNewView, { sheet, onClose: noop, onNever: noop, ...patch })

  it('offers « Voir ces fonctions dans Découvrir Lucium », a button that asks for the panel', () => {
    const onDiscover = vi.fn()
    const [button] = buttonsLabelled(elementsOf(view({ onDiscover })), 'Voir ces fonctions dans Découvrir Lucium')
    expect(button).toBeDefined()
    ;(button!.props['onClick'] as () => void)()
    expect(onDiscover).toHaveBeenCalledTimes(1)
  })

  it('is given its way by the sheet the application opens: the button asks for the panel', () => {
    const [shown] = elementsOf(createElement(WhatsNewSheet, { sheet })).filter((element) => element.type === WhatsNewView)
    ;(shown!.props['onDiscover'] as () => void)()
    expect(holder.asked).toEqual([['openOverlay', [DISCOVER_REQUEST]]])
  })

  it('leaves the button out when it has nowhere to lead, and when there is nothing to see', () => {
    expect(renderToStaticMarkup(view())).not.toContain('Découvrir Lucium')
    expect(renderToStaticMarkup(view({ onDiscover: noop, sheet: { ...sheet, points: [] } }))).not.toContain('Découvrir Lucium')
  })
})
