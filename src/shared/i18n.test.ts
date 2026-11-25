import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { fr } from './i18n-fr'
import { en } from './i18n-en'
import {
  CATALOGUES,
  LANGUAGES,
  applyLanguage,
  cleanLanguageSetting,
  createTranslator,
  diffCatalogues,
  format,
  getLanguage,
  isConsistent,
  languageOfLocale,
  placeholdersOf,
  resolveLanguage,
  setLanguage,
  t,
  tIn,
  tp
} from './i18n'

describe('the catalogues', () => {
  // The test the work was asked for: a catalogue with a key more or less than the French one fails here, with the keys named.
  it('give English exactly the keys of French, with the same variables and no blank text', () => {
    const diff = diffCatalogues(fr, en)
    expect(diff.missing, `Clés absentes du catalogue anglais : ${diff.missing.join(', ')}`).toEqual([])
    expect(diff.extra, `Clés en trop dans le catalogue anglais : ${diff.extra.join(', ')}`).toEqual([])
    expect(diff.placeholders, `Variables différentes : ${diff.placeholders.join(', ')}`).toEqual([])
    expect(diff.blank, `Textes vides : ${diff.blank.join(', ')}`).toEqual([])
  })

  it('compares any pair of catalogues, and says what is wrong with each', () => {
    const reference = { a: 'Un', b: 'Deux {n}', c: 'Trois' }
    expect(isConsistent(diffCatalogues(reference, { a: 'One', b: 'Two {n}', c: 'Three' }))).toBe(true)
    expect(diffCatalogues(reference, { a: 'One', b: 'Two {n}' }).missing).toEqual(['c'])
    expect(diffCatalogues(reference, { a: 'One', b: 'Two {n}', c: 'Three', d: 'Four' }).extra).toEqual(['d'])
    expect(diffCatalogues(reference, { a: 'One', b: 'Two {count}', c: 'Three' }).placeholders).toEqual(['b'])
    expect(diffCatalogues(reference, { a: 'One', b: 'Two', c: 'Three' }).placeholders).toEqual(['b'])
    expect(diffCatalogues(reference, { a: 'One', b: 'Two {n}', c: '  ' }).blank).toEqual(['c'])
    // The order of the variables in a sentence is the language's business: only the set must agree.
    expect(isConsistent(diffCatalogues({ a: '{x} puis {y}' }, { a: '{y} after {x}' }))).toBe(true)
  })

  it('keeps the two forms of a count in every language', () => {
    for (const [name, catalogue] of Object.entries(CATALOGUES) as Array<[string, Record<string, string>]>) {
      const ones = Object.keys(catalogue).filter((key) => key.endsWith('.one')).map((key) => key.slice(0, -4))
      const others = Object.keys(catalogue).filter((key) => key.endsWith('.other')).map((key) => key.slice(0, -6))
      expect(ones.sort(), name).toEqual(others.sort())
      for (const base of ones) expect(placeholdersOf(catalogue[`${base}.one`]!), `${name} ${base}`).toContain('count')
    }
  })

  it('has no French left in the English one (an accent, or an opening French quote, means a text that was not translated)', () => {
    // English quotes with “ ”; a lone » may stay, as the glyph of a button.
    const untranslated = Object.entries(en).filter(([, text]) => /[éèêëàâùûôîïçœÉÈÀÇ«]/.test(text)).map(([key]) => key)
    expect(untranslated).toEqual([])
  })

  it('has keys of the form area.name, and texts without the control characters a menu would misdraw', () => {
    for (const [key, text] of [...Object.entries(fr), ...Object.entries(en)]) {
      expect(key, key).toMatch(/^[a-z][a-z-]*\.[a-z0-9][a-z0-9.-]*$/)
      expect(/\p{Cc}/u.test(text), key).toBe(false)
    }
  })

  it('write no plural by hand: a text that counts is a pair .one / .other, never « onglet(s) »', () => {
    // "http(s)" names two schemes; nothing else may end a word with "(s)".
    for (const [name, catalogue] of Object.entries(CATALOGUES) as Array<[string, Record<string, string>]>) {
      const byHand = Object.entries(catalogue).filter(([, text]) => /\p{L}\(s\)/u.test(text.replaceAll('http(s)', ''))).map(([key]) => key)
      expect(byHand, name).toEqual([])
    }
  })

  it('keep one key for one sentence: a numbered copy of a key (« …-2 ») says something else than the key it copies', () => {
    // Seventeen browsers each had their own key for the same sentence of the import sheet: a correction had to be made seventeen times.
    const copies = Object.keys(fr).filter((key) => {
      const base = /^(.*)-\d+$/.exec(key)?.[1] as keyof typeof fr | undefined
      return base !== undefined && base in fr && fr[base] === fr[key as keyof typeof fr] && en[base] === en[key as keyof typeof en]
    })
    expect(copies).toEqual([])
  })

  it('agree a sentence with its count, in both languages, where a box or a notice used to say « 1 onglet(s) »', () => {
    const said = (language: 'fr' | 'en', key: Parameters<typeof tp>[0], count: number, vars?: Record<string, string>) => {
      setLanguage(language)
      try {
        return tp(key, count, vars).replaceAll(' ', ' ').replaceAll(' ', ' ')
      } finally {
        setLanguage('fr')
      }
    }
    expect(said('fr', 'app.onglets-archives-seront-oublies', 1)).toBe('1 onglet archivé sera oublié. Cette action est définitive.')
    expect(said('fr', 'app.onglets-archives-seront-oublies', 3)).toBe('3 onglets archivés seront oubliés. Cette action est définitive.')
    expect(said('en', 'app.onglets-archives-seront-oublies', 1)).toBe('1 archived tab will be forgotten. This can’t be undone.')
    expect(said('fr', 'ctx.onglets-seront-fermes', 1)).toBe('1 onglet sera fermé. Cette action est définitive.')
    expect(said('en', 'ctx.onglets-seront-fermes', 4)).toBe('4 tabs will be closed. This can’t be undone.')
    expect(said('fr', 'browser.donnees-de-conteneurs-supprimes-non-effacees', 1)).toBe('Les données de 1 conteneur supprimé n’ont pas pu être effacées.')
    expect(said('en', 'browser.donnees-de-conteneurs-supprimes-non-effacees', 2)).toBe('The data of 2 deleted containers couldn’t be cleared.')
    expect(said('fr', 'space-manage.espace-supprime', 1, { name: 'Travail' })).toBe('Espace « Travail » supprimé, 1 onglet fermé')
    expect(said('en', 'space-manage.espace-supprime', 5, { name: 'Work' })).toBe('Space “Work” deleted, 5 tabs closed')
  })

  it('give one French text one English wording, whatever the key: only the case of the surface, an article or the final « … » may differ', () => {
    // A French word that says two things has two English words: « Annuler » undoes in a menu and cancels in a box, « Quitter » quits the
    // application and leaves a mode. Any other French text that comes back under another key is the same thing, and reads the same.
    const twoMeanings = new Set([
      'Quitter', 'Rechercher', 'Annuler', 'Supprimer', 'Ignorer', 'Actualiser', 'Page précédente', 'Affichage', 'Rétablir', 'Lecture à voix haute',
      'Précédent', 'Suivant', 'Fine', 'Faible'
    ])
    const loose = (text: string): string => text.toLowerCase().replace(/\b(the|a|an|this) /g, '').replace(/…$/, '')
    const keysOf = new Map<string, string[]>()
    for (const [key, text] of Object.entries(fr)) keysOf.set(text, [...(keysOf.get(text) ?? []), key])
    const split: string[] = []
    const stale = new Set(twoMeanings)
    for (const [text, keys] of keysOf) {
      // The two forms of a count may share their French (« {count} processus ») and not their English.
      if (keys.length === 2 && keys[0]!.endsWith('.one') && keys[1] === `${keys[0]!.slice(0, -'.one'.length)}.other`) continue
      const wordings = new Set(keys.map((key) => loose(en[key as keyof typeof en])))
      if (wordings.size < 2) continue
      if (twoMeanings.has(text)) stale.delete(text)
      else split.push(`« ${text} »: ${keys.map((key) => `${key} = “${en[key as keyof typeof en]}”`).join(', ')}`)
    }
    expect(split).toEqual([])
    // A text of the list that has one wording again leaves the list.
    expect([...stale]).toEqual([])
  })

  it('call the « onglets du jour » by one English name, « Today tabs », in every text that speaks of them', () => {
    // They were also « tabs of the day » and « tabs of today »: three names made three things of the one list of the sidebar.
    const named = Object.keys(fr).filter((key) => /onglets? du jour/.test(fr[key as keyof typeof fr]))
    expect(named.length).toBeGreaterThan(10)
    expect(named.filter((key) => !/today tabs?\b/i.test(en[key as keyof typeof en]))).toEqual([])
    expect(Object.keys(en).filter((key) => /tabs? of (the day|today)/i.test(en[key as keyof typeof en]))).toEqual([])
  })

  it('lean on no space of their own: a text starts and ends with a character, except the known joints the code puts between two texts', () => {
    // A joint (« ; » between the items of a list, a bracket added after a sentence) carries its space; a sentence does not, or it is the
    // code that reads it which decides how two sentences are spaced. No new text joins this list: the code spaces what it assembles.
    const joints = [
      'blocking-settings.ceux-qu-elle-connait-ne-tournent-que-si', 'bookmarks.point-virgule', 'boostshare.avec-javascript', 'boostshare.host-entre-parentheses',
      'boostshare.javascript-desactive-suffix', 'boostshare.ligne-line', 'boostshare.nom-entre-guillemets', 'boostshare.point-virgule', 'boostshare.size-ko',
      'export-data.chiffre-garder-la-phrase', 'gestures.separateur', 'import-sheet.fichier-a-choisir', 'vim-keys.separateur'
    ]
    // Sentences that still end with the space of the sentence that follows them: to be assembled by the code, then taken off this list.
    const sentences = [
      'menu-actions.vous-utilisez-lucium-current-cette-version-n', 'persistence-notices.cette-version-peut-ne-pas-connaitre',
      'persistence-notices.le-fichier-file-est-illisible-reason-et', 'persistence-notices.le-fichier-file-est-illisible-reason-il-n-a-pas',
      'persistence-notices.le-fichier-file-thing-a-ete-ecrit-par-une', 'persistence-notices.le-fichier-mis-de-cote-peut-etre-repare-a-la-main',
      'persistence-notices.le-fichier-mis-de-cote-peut-etre-repare-aide', 'persistence-notices.lucium-n-arrive-pas-a-ecrire-une-copie-de',
      'persistence-notices.pour-retrouver-ces-donnees-relancez-la-version',
      'window-close.de-l-espace-space'
    ]
    const edged = (catalogue: Record<string, string>): string[] => Object.keys(catalogue).filter((key) => catalogue[key] !== catalogue[key]!.trim()).sort()
    expect(edged(fr)).toEqual([...joints, ...sentences].sort())
    // Two French joints open with the space French puts before « : »; their English opens with the colon itself.
    const beforeColon = ['blocking-settings.ceux-qu-elle-connait-ne-tournent-que-si', 'import-sheet.fichier-a-choisir']
    expect(edged(en)).toEqual(edged(fr).filter((key) => !beforeColon.includes(key)))
  })
})

describe('the language of the interface', () => {
  it('is French unless the function is on, whatever the system says', () => {
    for (const locale of ['en-US', 'de-DE', 'fr-FR', '']) {
      expect(resolveLanguage({ interfaceTranslated: false, language: 'en' }, locale)).toBe('fr')
      expect(resolveLanguage({ interfaceTranslated: false, language: 'auto' }, locale)).toBe('fr')
    }
  })

  it('follows the choice when the function is on, and the system for "auto"', () => {
    expect(resolveLanguage({ interfaceTranslated: true, language: 'en' }, 'fr-FR')).toBe('en')
    expect(resolveLanguage({ interfaceTranslated: true, language: 'fr' }, 'en-US')).toBe('fr')
    expect(resolveLanguage({ interfaceTranslated: true, language: 'auto' }, 'fr-FR')).toBe('fr')
    expect(resolveLanguage({ interfaceTranslated: true, language: 'auto' }, 'fr_CA')).toBe('fr')
    expect(resolveLanguage({ interfaceTranslated: true, language: 'auto' }, 'en-GB')).toBe('en')
    // No catalogue for German yet: English is the common ground.
    expect(resolveLanguage({ interfaceTranslated: true, language: 'auto' }, 'de-DE')).toBe('en')
  })

  it('reads a locale without taking "frontier" or "fra" for French', () => {
    expect(languageOfLocale('fr')).toBe('fr')
    expect(languageOfLocale('FR-be')).toBe('fr')
    expect(languageOfLocale('frp')).toBe('en')
    expect(languageOfLocale('fil-PH')).toBe('en')
  })

  it('reads a damaged setting as "auto"', () => {
    for (const bad of [undefined, null, 3, 'de', 'FR', {}, []]) expect(cleanLanguageSetting(bad)).toBe('auto')
    for (const good of ['auto', 'fr', 'en']) expect(cleanLanguageSetting(good)).toBe(good)
  })

  it('is on by default and follows the system: an English system gets English', () => {
    const settings = defaultSettings()
    expect(settings.interfaceTranslated).toBe(true)
    expect(settings.language).toBe('auto')
    expect(resolveLanguage(settings, 'en-US')).toBe('en')
  })

  it('applies to the process: texts follow the language set, and French is what a process starts in', () => {
    expect(getLanguage()).toBe('fr')
    try {
      expect(t('menu.nouvel-onglet')).toBe('Nouvel onglet…')
      expect(applyLanguage({ interfaceTranslated: true, language: 'en' }, 'fr-FR')).toBe('en')
      expect(t('menu.nouvel-onglet')).toBe('New Tab…')
      expect(tIn('fr', 'menu.nouvel-onglet')).toBe('Nouvel onglet…')
      expect(applyLanguage({ interfaceTranslated: false, language: 'en' }, 'en-US')).toBe('fr')
      expect(t('menu.nouvel-onglet')).toBe('Nouvel onglet…')
      // Anything that is not a language of the list is French.
      setLanguage('xx' as never)
      expect(getLanguage()).toBe('fr')
    } finally {
      setLanguage('fr')
    }
  })

  it('shows the French texts to the character: the catalogue holds the originals', () => {
    // A few texts that other tests and the measures of the original application rest on.
    expect(tIn('fr', 'menu.fichier')).toBe('Fichier')
    expect(tIn('fr', 'menu.edition')).toBe('Édition')
    expect(tIn('fr', 'menu.rechercher')).toBe('Rechercher')
    expect(tIn('fr', 'menu.verrouiller-maintenant')).toBe('Verrouiller maintenant')
    expect(tIn('fr', 'toolbar.copier-l-adresse')).toBe('Copier l’adresse')
    expect(tIn('fr', 'sidebar.nouvel-onglet')).toBe('Nouvel onglet')
    expect(tIn('fr', 'cmd.tab')).toBe('Tab ⇥')
    for (const language of LANGUAGES) expect(createTranslator(language)('menu.fichier')).toBe(CATALOGUES[language]!['menu.fichier'])
  })
})

describe('a translator', () => {
  const catalogues = { fr: { 'a.hello': 'Bonjour {name}', 'a.only-french': 'Seulement en français', 'a.n.one': '{count} chose', 'a.n.other': '{count} choses' }, xx: { 'a.hello': 'Hello {name}', 'a.n.one': '{count} thing', 'a.n.other': '{count} things' } }

  it('replaces the variables, and leaves one that was not given visible', () => {
    expect(format('Bonjour {name}', { name: 'Zoé' })).toBe('Bonjour Zoé')
    expect(format('{a} et {b}', { a: 1 })).toBe('1 et {b}')
    expect(format('{a}', { a: '{b}', b: 'piège' })).toBe('{b}')
    expect(format('Aucune variable', { a: 1 })).toBe('Aucune variable')
    expect(placeholdersOf('{x} {y} {x}')).toEqual(['x', 'y'])
  })

  it('does not take the name of an inherited property for a variable', () => {
    expect(format('{constructor} {toString}', {})).toBe('{constructor} {toString}')
  })

  it('reads a key the language lacks in French, and says so once', () => {
    const reports: string[] = []
    const tr = createTranslator('en', catalogues as never, (m) => reports.push(m))
    expect(tr('a.only-french' as never)).toBe('Seulement en français')
    expect(tr('a.only-french' as never)).toBe('Seulement en français')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('a.only-french')
  })

  it('shows an unknown key as itself and says so, never a blank', () => {
    const reports: string[] = []
    const tr = createTranslator('fr', catalogues as never, (m) => reports.push(m))
    expect(tr('a.nothing' as never)).toBe('a.nothing')
    expect(reports.join()).toContain('unknown key')
  })

  it('stays silent for French, where nothing is missing by definition', () => {
    const reports: string[] = []
    const tr = createTranslator('fr', catalogues as never, (m) => reports.push(m))
    expect(tr('a.hello' as never, { name: 'Zoé' })).toBe('Bonjour Zoé')
    expect(reports).toEqual([])
  })

  it('picks the form of a count by the rules of the language', () => {
    const french = createTranslator('fr', catalogues as never, () => undefined)
    const english = createTranslator('en', { fr: catalogues.fr, en: catalogues.xx } as never, () => undefined)
    expect([0, 1, 2, 5].map((n) => french.plural('a.n' as never, n))).toEqual(['0 chose', '1 chose', '2 choses', '5 choses'])
    expect([0, 1, 2, 5].map((n) => english.plural('a.n' as never, n))).toEqual(['0 things', '1 thing', '2 things', '5 things'])
  })

  it('counts as the code it replaced did: "onglet" up to one, "onglets" from two', () => {
    setLanguage('fr')
    expect([0, 1, 2].map((n) => tp('cmd.session-tabs', n))).toEqual(['Session · 0 onglet', 'Session · 1 onglet', 'Session · 2 onglets'])
    try {
      setLanguage('en')
      expect([0, 1, 2].map((n) => tp('cmd.session-tabs', n))).toEqual(['Session · 0 tabs', 'Session · 1 tab', 'Session · 2 tabs'])
    } finally {
      setLanguage('fr')
    }
  })
})
