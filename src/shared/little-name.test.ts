import { afterEach, describe, expect, it, vi } from 'vitest'
import { fr } from './i18n-fr'
import { en } from './i18n-en'
import { LITTLE_NAME, littleForms } from './little-name'

// What must not be shown to anyone: the name another browser gives to its own feature. Written without the space too ("LittleArc" is an
// identifier, never shown; "Little Arc" and "Little-Arc" are words).
const OLD_NAME = /\blittle[\s-]+arc\b/i

describe('the name of the mini window', () => {
  it('has its forms: a noun in a sentence, at the start of one, plural, and title case for an English menu', () => {
    expect(littleForms('fr')).toEqual({ s: 'mini-fenêtre', p: 'mini-fenêtres', S: 'Mini-fenêtre', title: 'Mini-fenêtre', titles: 'Mini-fenêtres' })
    expect(littleForms('en')).toEqual({ s: 'mini window', p: 'mini windows', S: 'Mini window', title: 'Mini Window', titles: 'Mini Windows' })
  })

  it('does not contain the name of the other browser, in either language', () => {
    for (const language of ['fr', 'en'] as const) {
      const { singular, plural } = LITTLE_NAME[language]
      expect(OLD_NAME.test(singular) || OLD_NAME.test(plural), language).toBe(false)
      expect(/\barc\b/i.test(singular + plural), language).toBe(false)
    }
  })
})

// The one text that shows the old name: the guide for people coming from that browser, beside the name Lucium gives the window. It is that name alone.
const SHOWS_OLD_NAME = 'arc-guide.ancien-little-arc'

describe('the texts of the interface', () => {
  const texts: Array<[string, string, string]> = [
    ...Object.entries(fr).map(([key, text]): [string, string, string] => ['fr', key, text]),
    ...Object.entries(en).map(([key, text]): [string, string, string] => ['en', key, text])
  ]

  it('never say "Little Arc" (French and English catalogues), but the one text of the guide for people coming from that browser', () => {
    const offending = texts.filter(([, key, text]) => key !== SHOWS_OLD_NAME && OLD_NAME.test(text)).map(([language, key]) => `${language}:${key}`)
    expect(offending).toEqual([])
    expect([fr[SHOWS_OLD_NAME], en[SHOWS_OLD_NAME]]).toEqual(['Little Arc', 'Little Arc'])
  })

  it('speak of the browser an import comes from by the name the sheet shows, never by a name of their own', () => {
    // These two once named another browser; they now say "the sidebar" and quote {browser} (src/main/brand-names.test.ts checks every text).
    expect(fr['features.un-panneau-de-signets-recherche-etiquettes']).not.toMatch(/\bArc\b/)
    expect(fr['import-sources.nous-pouvons-importer-vos-espaces-onglets']).toContain('{browser}')
  })

  it('name the window with the words of the constant, in every sentence that speaks of it', () => {
    const named = (language: 'fr' | 'en') => {
      const { singular, plural } = LITTLE_NAME[language]
      const catalogue: Record<string, string> = language === 'fr' ? fr : en
      return Object.entries(catalogue).filter(([, text]) => text.toLowerCase().includes(singular) || text.toLowerCase().includes(plural))
    }
    // The menu, the Dock, the settings, the registry of functions: at least these.
    for (const language of ['fr', 'en'] as const) {
      const keys = named(language).map(([key]) => key)
      for (const wanted of ['menu.nouvelle-mini-fenetre', 'dock.afficher-les-mini-fenetres', 'dock.fermer-les-mini-fenetres', 'ctx.ouvrir-dans-une-mini-fenetre', 'engine.ouvrir-dans-une-mini-fenetre', 'little-arc-settings.mini-fenetre', 'settings.little-shortcut-on']) {
        expect(keys, `${language} ${wanted}`).toContain(wanted)
      }
      expect(keys.length, language).toBeGreaterThanOrEqual(21)
    }
  })
})

describe('changing the name', () => {
  afterEach(() => {
    vi.doUnmock('./little-name')
    vi.resetModules()
  })

  it('is one edit: every catalogue sentence that named the window takes the new name, and none keeps the old one', async () => {
    const before = { fr: { ...fr } as Record<string, string>, en: { ...en } as Record<string, string> }
    const changed = { fr: { singular: 'fenêtrette', plural: 'fenêtrettes' }, en: { singular: 'wee window', plural: 'wee windows' } }
    vi.resetModules()
    vi.doMock('./little-name', async (importOriginal) => {
      const real = await importOriginal<typeof import('./little-name')>()
      return { ...real, littleForms: (language: 'fr' | 'en') => real.littleForms(language, changed) }
    })
    const after = { fr: (await import('./i18n-fr')).fr as Record<string, string>, en: (await import('./i18n-en')).en as Record<string, string> }
    for (const language of ['fr', 'en'] as const) {
      const old = LITTLE_NAME[language]
      let touched = 0
      for (const [key, text] of Object.entries(before[language])) {
        if (!text.toLowerCase().includes(old.singular) && !text.toLowerCase().includes(old.plural)) {
          // A text that never spoke of the window is the same.
          expect(after[language]![key], `${language} ${key}`).toBe(text)
          continue
        }
        touched++
        const next = after[language]![key]!.toLowerCase()
        expect(next.includes(old.singular) || next.includes(old.plural), `${language} ${key} still says ${old.singular}`).toBe(false)
        expect(next.includes(changed[language].singular) || next.includes(changed[language].plural), `${language} ${key}`).toBe(true)
      }
      expect(touched, language).toBeGreaterThanOrEqual(21)
    }
  })
})
