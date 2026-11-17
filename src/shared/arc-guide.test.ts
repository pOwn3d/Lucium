import { afterEach, describe, expect, it } from 'vitest'
import { ARC_GUIDE_PLACES, ARC_GUIDE_REQUEST, NOTHING_IMPORTED, addImported, arcGuideRequest, importedParts, type ArcImported } from './arc-guide'
import { setLanguage } from './i18n'
import { en } from './i18n-en'
import { fr } from './i18n-fr'
import { SETTINGS_ANCHORS, SETTINGS_PANES } from './ipc'

afterEach(() => setLanguage('fr'))

const brought: ArcImported = { spaces: 3, tabs: 42, folders: 1, favorites: 6, splits: 1 }

describe('when the guide for people coming from Arc opens by itself', () => {
  it('opens after an import from Arc, with what the import brought', () => {
    expect(arcGuideRequest(brought, { arcGuideSeen: false })).toEqual({ panel: 'arcguide', imported: brought })
  })

  it('opens after nothing else: no import from Arc, no guide', () => {
    expect(arcGuideRequest(null, { arcGuideSeen: false })).toBeNull()
  })

  it('opens once: it was seen, by itself or from the Help menu, and it does not open again', () => {
    expect(arcGuideRequest(brought, { arcGuideSeen: true })).toBeNull()
  })

  it('is asked for by the Help menu with no import to speak of', () => {
    expect(ARC_GUIDE_REQUEST).toEqual({ panel: 'arcguide' })
  })
})

describe('what the import brought, in the words of the import sheet', () => {
  it('lists the parts in French, leaving out those that are zero', () => {
    expect(importedParts(brought)).toEqual(['3 espaces', '42 onglets', '1 dossier', '6 favoris', '1 vue scindée'])
    expect(importedParts({ ...NOTHING_IMPORTED, tabs: 1, splits: 1 })).toEqual(['1 onglet', '1 vue scindée'])
    expect(importedParts(NOTHING_IMPORTED)).toEqual([])
    expect(importedParts(undefined)).toEqual([])
  })

  it('lists them in English in English', () => {
    setLanguage('en')
    expect(importedParts(brought)).toEqual(['3 Spaces', '42 tabs', '1 folder', '6 favorites', '1 split view'])
  })

  it('adds two imports (the sheet may import the sidebar, then the history, then another sidebar)', () => {
    expect(addImported(brought, { ...NOTHING_IMPORTED, favorites: 5, spaces: 1 })).toEqual({ ...brought, favorites: 11, spaces: 4 })
    expect(addImported(NOTHING_IMPORTED, NOTHING_IMPORTED)).toEqual(NOTHING_IMPORTED)
  })
})

describe('where the buttons of the guide lead', () => {
  it('open the Settings on a category and a place the window knows', () => {
    for (const [name, place] of Object.entries(ARC_GUIDE_PLACES)) {
      if (place.panel !== 'settings') continue
      expect(SETTINGS_PANES as readonly string[], name).toContain(place.pane)
      if ('anchor' in place) expect(SETTINGS_ANCHORS as readonly string[], name).toContain(place.anchor)
    }
  })

  it('send the routing of links and the Glance to the group of the links, the Tweaks to the tools, the mini window to the command bar', () => {
    expect(ARC_GUIDE_PLACES.linkRouting).toEqual({ panel: 'settings', pane: 'navigation', anchor: 'links' })
    expect(ARC_GUIDE_PLACES.glance).toEqual({ panel: 'settings', pane: 'navigation', anchor: 'links' })
    expect(ARC_GUIDE_PLACES.tweaks).toEqual({ panel: 'settings', pane: 'tools' })
    expect(ARC_GUIDE_PLACES.miniWindow).toEqual({ panel: 'commandbar', mode: 'little', initial: '' })
  })
})

describe('the texts of the guide', () => {
  const keys = Object.keys(fr).filter((key) => key.startsWith('arc-guide.'))
  /** The names of the other browser's functions: written the same in both languages. */
  const SAME_IN_BOTH = ['arc-guide.ancien-air-traffic-control', 'arc-guide.ancien-boosts', 'arc-guide.ancien-little-arc', 'arc-guide.ancien-peek']

  it('exist in French and in English, the same ones', () => {
    expect(keys.length).toBeGreaterThan(25)
    expect(Object.keys(en).filter((key) => key.startsWith('arc-guide.'))).toEqual(keys)
    for (const key of keys) {
      expect(fr[key as keyof typeof fr], `fr ${key}`).not.toBe('')
      expect(en[key as keyof typeof en], `en ${key}`).not.toBe('')
    }
  })

  it('are translated: only the old names are written the same in both languages', () => {
    const same = keys.filter((key) => fr[key as keyof typeof fr] === en[key as keyof typeof en])
    expect(same.sort()).toEqual(SAME_IN_BOTH)
  })

  it('carry the same variables in both languages', () => {
    const variables = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()
    for (const key of keys) expect(variables(en[key as keyof typeof en]), key).toEqual(variables(fr[key as keyof typeof fr]))
  })
})
