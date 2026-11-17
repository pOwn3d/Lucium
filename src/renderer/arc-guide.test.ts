// The guide « Vous venez d’Arc ? » (ArcGuide.tsx), drawn with no window on a snapshot (as dead-tabs-sheet.test.ts does): a row for each name that changed, the
// shortcut of the mini window read from the settings, what the import brought, what Lucium does not have, and the place each button opens.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARC_GUIDE_PLACES, type ArcGuidePlace, type ArcImported } from '@shared/arc-guide'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings, type SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) }), useSnapshot: () => holder.snapshot }))

import { ArcGuide } from './ArcGuide'
import { frenchSpaces } from '@shared/french-typography'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.asked = []
  holder.snapshot = null
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

const brought: ArcImported = { spaces: 3, tabs: 42, folders: 5, favorites: 0, splits: 1 }

function guide(settings: Partial<Settings> = {}, imported?: ArcImported) {
  const state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), ...settings } }
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false } }
  const props = imported ? { imported } : {}
  const markup = renderToStaticMarkup(createElement(ArcGuide, props))
  const elements = elementsOf(createElement(ArcGuide, props))
  const text = (element: Element): string => {
    const children = element.props['children']
    return (Array.isArray(children) ? children : [children]).filter((child) => typeof child === 'string').join('')
  }
  /** The buttons of the row that this heading names (aria-describedby), in order. */
  const buttonsOf = (row: string): Element[] => elements.filter((element) => element.type === 'button' && element.props['aria-describedby'] === `ag-${row}`)
  const click = (button: Element): void => (button.props['onClick'] as () => void)()
  const form = (): Element => elements.find((element) => element.type === 'form')!
  return { markup, elements, text, buttonsOf, click, form }
}

describe('the guide for people coming from Arc', () => {
  it('is a dialog titled for them, that draws nothing until the first snapshot has arrived', () => {
    holder.snapshot = null
    expect(renderToStaticMarkup(createElement(ArcGuide))).toBe('')
    const { markup } = guide()
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain('>Vous venez d’Arc\u202f?</h2>')
  })

  it('gives each name that changed its row: the old name, the name in Lucium, a line, and a button', () => {
    const { markup, buttonsOf } = guide()
    for (const [old, now] of [['Little Arc', 'Mini-fenêtre'], ['Boosts', 'Retouches'], ['Air Traffic Control', 'Où s’ouvrent les liens'], ['Peek', 'Coup d’œil']] as const) {
      expect(markup, old).toContain(frenchSpaces(`aria-label="Ancien nom : ${old}. Nom dans Lucium : ${now}."`))
      expect(markup, old).toContain(`>${old}</span>`)
      expect(markup, now).toContain(`>${now}</b>`)
    }
    for (const row of ['mini', 'tweaks', 'links', 'glance']) expect(buttonsOf(row), row).toHaveLength(1)
  })

  it('says what stays under its name, and what Lucium does not have with the reason of the roadmap', () => {
    const { markup, buttonsOf } = guide()
    expect(markup).toContain('Espaces, onglets épinglés, dossiers et onglets du jour')
    expect(buttonsOf('spaces')).toHaveLength(2)
    for (const words of ['Assistant IA', 'Ni discussion, ni agent qui agit sur les pages', 'Compte, synchronisation et partage cloud', 'Ils exigent un service en ligne.', 'Favoris vivants', 'Easels et notes de la barre latérale', 'Les Notes rapides de Lucium sont une fonction à part']) {
      expect(markup, words).toContain(words)
    }
    expect(markup.match(/<li><b>/g)).toHaveLength(4)
  })
})

describe('the shortcut of the mini window', () => {
  it('is the one the settings give: the default, a shortcut the user chose, and none when they removed it', () => {
    expect(guide().markup).toContain('Ouvrez-en une avec ⌥⌘N, ou par Fichier › Nouvelle mini-fenêtre.')
    expect(guide({ keyBindings: { newLittleArc: 'CmdOrCtrl+Shift+L' } }).markup).toContain('Ouvrez-en une avec ⇧⌘L, ou par Fichier › Nouvelle mini-fenêtre.')
    const removed = guide({ keyBindings: { newLittleArc: '' } }).markup
    expect(removed).toContain('Ouvrez-en une par Fichier › Nouvelle mini-fenêtre.')
    expect(removed).not.toContain('⌥⌘N')
    expect(removed).not.toContain('Ouvrez-en une avec')
  })
})

describe('what the import brought', () => {
  it('is said in the words of the import sheet when the guide follows an import', () => {
    expect(guide({}, brought).markup).toContain(frenchSpaces('Votre import a récupéré : 3 espaces, 42 onglets, 5 dossiers, 1 vue scindée.'))
  })

  it('is left out from the Help menu, and for an import that brought nothing to count', () => {
    expect(guide().markup).not.toContain('Votre import a repris')
    expect(guide({}, { spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0 }).markup).not.toContain('Votre import a repris')
  })
})

describe('what is off', () => {
  it('is said beside the line of the Tweaks and of the Glance, and only then', () => {
    const on = guide().markup
    expect(on).not.toContain('désactivées pour l’instant')
    expect(on).not.toContain('désactivé pour l’instant')
    const off = guide({ boostsEnabled: false, peekWithShift: false }).markup
    expect(off).toContain('Les Retouches sont désactivées pour l’instant.')
    expect(off).toContain('Le Coup d’œil est désactivé pour l’instant.')
  })
})

describe('the buttons', () => {
  const OPENS: Array<[string, number, string, ArcGuidePlace]> = [
    ['mini', 0, 'Ouvrir une mini-fenêtre', 'miniWindow'],
    ['tweaks', 0, 'Réglages › Extensions et outils', 'tweaks'],
    ['links', 0, 'Réglages › Navigation', 'linkRouting'],
    ['glance', 0, 'Réglages › Navigation', 'glance'],
    ['spaces', 0, 'Espaces', 'spaces'],
    ['spaces', 1, 'Archive', 'archive']
  ]

  it('open their place: the guide goes, then the place comes', () => {
    for (const [row, at, label, place] of OPENS) {
      const { buttonsOf, click, text } = guide()
      const button = buttonsOf(row)[at]!
      expect(text(button), `${row} ${label}`).toBe(label)
      expect(button.props['type'], label).toBe('button')
      holder.asked = []
      click(button)
      expect(holder.asked, label).toEqual([['closeOverlay', []], ['openOverlay', [ARC_GUIDE_PLACES[place]]]])
    }
  })

  it('are all of the guide’s buttons but its “Fermer”: one for each place', () => {
    const { elements, text } = guide()
    const labels = elements.filter((element) => element.type === 'button').map((element) => text(element))
    expect(labels).toEqual(OPENS.map(([, , label]) => label).concat('Fermer'))
  })

  it('leave the guide: “Fermer” and Escape close it and open nothing', () => {
    const { form } = guide()
    holder.asked = []
    ;(form().props['onSubmit'] as (event: { preventDefault(): void }) => void)({ preventDefault: () => undefined })
    ;(form().props['onKeyDown'] as (event: unknown) => void)({ nativeEvent: { key: 'Escape', defaultPrevented: false }, stopPropagation: () => undefined })
    expect(holder.asked).toEqual([['closeOverlay', []], ['closeOverlay', []]])
  })
})

describe('in English', () => {
  it('is all English, with the English names of the functions', () => {
    setLanguage('en')
    const { markup } = guide({}, brought)
    expect(markup).toContain('>Coming from Arc?</h2>')
    for (const words of ['Little Arc', 'Mini Window', 'Boosts', 'Tweaks', 'Air Traffic Control', 'Where Links Open', 'Peek', 'Glance', 'Open a Mini Window', 'Settings › Extensions and tools', 'Under another name', 'Not in Lucium', 'AI assistant', 'Your import brought in: 3 Spaces, 42 tabs, 5 folders, 1 split view.', 'Open one with ⌥⌘N, or from File › New Mini Window.']) {
      expect(markup, words).toContain(words)
    }
    for (const french of ['Vous venez', 'Sous un autre nom', 'Retouches', 'Ouvrir', 'Fermer', 'Réglages']) expect(markup, french).not.toContain(french)
  })
})
