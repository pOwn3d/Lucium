import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { foldChar, foldText, matchesWords, prepareQuery, queryWords, rankUnits, searchSuggestions, stem, type RankOptions, type SearchFields, type SearchUnit } from './settings-search'

/** Whether a row that says `text` and carries `keys` answers every word of the query, by its words or by a synonym of one of its keys. */
const answers = (text: string, keys: string[], query: string): boolean => rankUnits([{ fields: { label: text }, ownKeys: keys }], query)[0]?.matched === queryWords(query).length
import { SEARCH_IDS, SETTINGS_SYNONYMS } from './settings-synonyms'

describe('the words of a search', () => {
  it('ignore case, accents and the dashes that split a word: "mini fenetre" finds "Mini-fenêtre"', () => {
    expect(foldText('Mini-fenêtre')).toBe('mini fenetre')
    expect(foldText('Réglages d’Lucium')).toBe("reglages d'lucium")
    expect(queryWords('  Mini-FENÊTRE ')).toEqual(['mini', 'fenetre'])
    expect(queryWords('   ')).toEqual([])
    expect(matchesWords('Ouvrir une Mini-fenêtre avec ⌥⌘N', queryWords('mini fenetre'))).toBe(true)
  })

  it('want every word, in any order, at the start of a word anywhere in the text', () => {
    const text = 'Mettre en veille les onglets inactifs · Mise en veille'
    expect(matchesWords(text, queryWords('onglets veille'))).toBe(true)
    expect(matchesWords(text, queryWords('veille onglets'))).toBe(true)
    expect(matchesWords(text, queryWords('veille cookies'))).toBe(false)
    expect(matchesWords(text, [])).toBe(true)
  })

  it('fold one character as the text is folded, so that a match in the folded text maps back to the screen', () => {
    expect([...'Mini-fenêtre Réglages'].map(foldChar).join('')).toBe(foldText('Mini-fenêtre Réglages'))
    expect(foldChar('ê')).toBe('e')
    expect(foldChar('’')).toBe("'")
  })

  it('offer the words that find something, then the names of the categories, never the word just typed', () => {
    const found = (word: string) => (word === 'veille' ? 3 : word === 'proxy' ? 1 : 0)
    expect(searchSuggestions('zzz', ['veille', 'cookies', 'proxy'], ['Onglets', 'Général'], found)).toEqual(['veille', 'proxy', 'Onglets', 'Général'])
    expect(searchSuggestions('Veille', ['veille', 'proxy'], ['Onglets'], found)).toEqual(['proxy', 'Onglets'])
    expect(searchSuggestions('zzz', ['veille', 'proxy'], ['Onglets', 'Général', 'Profils'], found, 3)).toEqual(['veille', 'proxy', 'Onglets'])
    expect(searchSuggestions('zzz', [], ['Général', 'général'], () => 0)).toEqual(['Général'])
  })
})

describe('the synonyms (settings-synonyms.ts)', () => {
  it('name settings that exist, or the few rows that are not a setting and carry a search id', () => {
    const known = new Set<string>([...Object.keys(defaultSettings()), ...SEARCH_IDS])
    for (const [word, targets] of Object.entries(SETTINGS_SYNONYMS)) {
      expect(foldText(word), word).toBe(word)
      expect(targets.length, word).toBeGreaterThan(0)
      for (const target of targets) expect(known.has(target), `${word} → ${target}`).toBe(true)
    }
  })

  it('find the choice of the update channel by the words people use for it: beta, canal, channel, and « mise à jour »', () => {
    const row = 'Recevoir les versions de test · Les versions de test arrivent avant la version stable ; elles peuvent contenir des défauts.'
    for (const query of ['beta', 'canal', 'channel', 'mise a jour']) expect(answers('Autre texte', ['updateChannel'], query), query).toBe(true)
    // Its own words find it too, and a row without the key does not answer to the synonyms.
    expect(answers(row, ['updateChannel'], 'versions de test')).toBe(true)
    expect(answers('Autre texte', ['warnBeforeQuitting'], 'beta')).toBe(false)
  })

  it('answer a word, the start of the last word typed (three letters or more), and a phrase the whole query holds', () => {
    const names = (query: string, at: number, key: string) => prepareQuery(query).named[at]?.has(key) ?? false
    expect(names('sauvegarde', 0, 'autoBackup')).toBe(true)
    expect(names('sauv', 0, 'autoBackup')).toBe(true)
    expect(prepareQuery('sa').named[0]!.size).toBe(0)
    expect(names('mot de passe', 1, 'passwordManager')).toBe(true)
    expect(names('passe', 0, 'passwordManager')).toBe(false)
    expect(prepareQuery('zzz').named[0]!.size).toBe(0)
    // A word that is not the last one typed is a whole word: « sauv » followed by another word names nothing.
    expect(names('sauv cookies', 0, 'autoBackup')).toBe(false)
    // The row a synonym is mostly about, when the query is that synonym.
    expect(prepareQuery('sauvegarde').exact.has('autoBackup')).toBe(true)
    expect(prepareQuery('sauvegarde auto').exact.has('autoBackup')).toBe(false)
  })

  it('find a row by its words, or by a synonym of its key: "sauvegarde" finds the automatic copies, "historique" the clearing of the data', () => {
    const backup = 'Garder des copies automatiques de mes espaces · Copies automatiques'
    expect(answers(backup, ['autoBackup'], 'sauvegarde')).toBe(true)
    expect(answers(backup, ['autoBackup'], 'copies')).toBe(true)
    expect(answers(backup, ['autoBackup'], 'cookies')).toBe(false)
    expect(answers('Effacer les données de navigation', ['clearProfileData'], 'historique')).toBe(true)
    // Every word must be answered, by the text or by a synonym of one of the row's keys.
    expect(answers('Effacer les données de navigation', ['clearProfileData'], 'effacer historique')).toBe(true)
    expect(answers('Effacer les données de navigation', ['clearProfileData'], 'effacer cookies veille')).toBe(false)
    // A row with no key is found by its words only.
    expect(answers('Effacer les données de navigation', [], 'historique')).toBe(false)
    // The buttons of the export of everything carry « exportData »: "sauvegarde" finds them, which their words ("Exporter les données") do not say.
    expect(answers('Exporter les données', ['exportData'], 'sauvegarde')).toBe(true)
    expect(answers('Exporter les données', [], 'sauvegarde')).toBe(false)
  })
})

describe('what a query looks for', () => {
  it('leaves out the common words of French and English, and splits on an apostrophe', () => {
    expect(queryWords('taille du texte')).toEqual(['taille', 'texte'])
    expect(queryWords('ne pas me suivre')).toEqual(['suivre'])
    expect(queryWords('vider l’historique')).toEqual(['vider', 'historique'])
    expect(queryWords("page d'accueil")).toEqual(['page', 'accueil'])
    expect(queryWords('do not track')).toEqual(['track'])
    expect(queryWords('turn off the ads')).toEqual(['ads'])
    // A query of common words only is still looked for, and « son » (a sound) is not a common word.
    expect(queryWords('le')).toEqual(['le'])
    expect(queryWords('couper le son')).toEqual(['couper', 'son'])
  })

  it('finds a word at the start of a word of the row, not inside one: "id" finds Touch ID, not « rapide »', () => {
    expect(matchesWords('Utiliser Touch ID', queryWords('id'))).toBe(true)
    expect(matchesWords('Configuration rapide', queryWords('id'))).toBe(false)
    expect(matchesWords('Gestionnaire de mots de passe', queryWords('passe'))).toBe(true)
    expect(matchesWords('Mots-clés avec « ! »', queryWords('mot de passe'))).toBe(false)
  })

  it('takes a word for its plural, its feminine and its other endings, without widening its start', () => {
    expect(matchesWords('Mettre en veille les onglets', queryWords('onglet'))).toBe(true)
    expect(matchesWords('Masquer les encarts publicitaires', queryWords('publicités'))).toBe(true)
    expect(matchesWords('Dossier de téléchargement', queryWords('télécharger'))).toBe(true)
    expect(matchesWords('Pop-ups allowed', queryWords('pop-up'))).toBe(true)
    expect(matchesWords('Allowed pop-up windows', queryWords('pop-ups'))).toBe(true)
    // A longer ending taken off, or a start followed by more than an ending, is another word.
    expect(matchesWords('Envoi partiel', queryWords('partage'))).toBe(false)
    expect(matchesWords('Gestionnaire de mots de passe', queryWords('gestes'))).toBe(false)
    expect(stem('telechargement')).toBe(stem('telecharger'))
  })
})

/** A row as the search reads it, for the tests: its label, and what else is said. */
const row = (label: string, ownKeys: string[] = [], fields: Partial<SearchFields> = {}, groupKeys: string[] = []): SearchUnit => ({ fields: { label, ...fields }, ownKeys, groupKeys })
const ranked = (units: readonly SearchUnit[], query: string, options: RankOptions = {}): string[] => rankUnits(units, query, { synonyms: {}, ...options }).map((one) => one.unit.fields.label)

describe('the ranking of the rows', () => {
  it('puts the exact label first, then a label that starts with the query, then a label that holds it', () => {
    const units = [row('Utiliser un proxy HTTP', ['a']), row('Proxy du profil', ['b']), row('Proxy', ['c'])]
    expect(ranked(units, 'proxy')).toEqual(['Proxy', 'Proxy du profil', 'Utiliser un proxy HTTP'])
  })

  it('puts the exact label before a row the same word names through a synonym', () => {
    const units = [row('Utiliser un proxy', ['p']), row('Proxy', ['c'])]
    expect(ranked(units, 'proxy', { synonyms: { proxy: ['p'] } })).toEqual(['Proxy', 'Utiliser un proxy'])
  })

  it('shows the rows a word names (label, choice of a menu) and leaves out those that only mention it in their hint', () => {
    const units = [row('Bordure', ['a'], { hint: 'Un mode sombre pour la bordure' }), row('Apparence de Lucium', ['b'], { options: 'Automatique Clair Sombre' })]
    expect(ranked(units, 'sombre')).toEqual(['Apparence de Lucium'])
    // With no row that names it, the mentions are what there is.
    expect(ranked([units[0]!], 'sombre')).toEqual(['Bordure'])
  })

  it('reads the choices of the menus, and not what is said of a choice', () => {
    expect(ranked([row('Apparence de Lucium', ['a'], { options: 'Automatique Clair Sombre' })], 'sombre')).toEqual(['Apparence de Lucium'])
  })

  it('names first the row a synonym is mostly about, and most of all when the query is that synonym', () => {
    const synonyms = { sauvegarde: ['copies', 'export'] }
    const units = [row('Exporter les données', ['export']), row('Garder des copies automatiques', ['copies'])]
    expect(ranked(units, 'sauvegarde', { synonyms })).toEqual(['Garder des copies automatiques', 'Exporter les données'])
    // A synonym of the key of the group finds the rows of the group, as the title of the group does: after a row named by its own key.
    const group = [row('Partage d’écran', ['screen'], {}, ['permissions']), row('Notifications', ['notif'])]
    expect(ranked(group, 'caméra', { synonyms: { camera: ['permissions'] } })).toEqual(['Partage d’écran'])
  })

  it('keeps the rows the most words name: « mot de passe » is not « Mots-clés »', () => {
    const units = [row('Mots-clés avec « ! »', ['a']), row('Gestionnaire de mots de passe', ['b'])]
    expect(ranked(units, 'mot de passe')).toEqual(['Gestionnaire de mots de passe'])
    // A word that names no row does not empty the results: the others still find theirs.
    expect(ranked(units, 'changer gestionnaire')).toEqual(['Gestionnaire de mots de passe'])
  })

  it('puts a setting before a row that carries no key (an entry of a list, a summary, a copy), and drops such a row that repeats a setting', () => {
    const units = [row('Proxy'), row('Utiliser un proxy HTTP', ['proxy'])]
    expect(ranked(units, 'proxy')).toEqual(['Utiliser un proxy HTTP', 'Proxy'])
    const summary = [row('Bloquer les publicités'), row('Bloquer les publicités', ['blockAds'])]
    expect(rankUnits(summary, 'bloquer les publicités', { synonyms: {} }).map((one) => one.unit.ownKeys)).toEqual([['blockAds']])
  })

  it('leaves out a row whose score is under half of the best one', () => {
    // The exact label scores 10, the other label 6, the choice of a menu 3.
    const units = [row('Durée', ['d'], { options: 'Veille courte' }), row('Veille', ['a']), row('Mettre en veille', ['c'])]
    expect(ranked(units, 'veille')).toEqual(['Veille', 'Mettre en veille'])
  })

  it('leaves out the rows of a group named when rows are named themselves, even by a choice of their menu', () => {
    const units = [row('Autre', ['b'], { group: 'Mise en veille' }), row('Durée', ['d'], { options: 'Veille courte' })]
    expect(ranked(units, 'veille')).toEqual(['Durée'])
    expect(ranked([units[0]!], 'veille')).toEqual(['Autre'])
  })

  it('prefers a row a word names to a row that only mentions every word', () => {
    const units = [row('Icônes des sites', ['favicons'], { hint: 'Sa page d’accueil, puis son icône' }), row('Ouvrir la page dans un nouvel onglet', ['tab'])]
    expect(ranked(units, 'page d’accueil')).toEqual(['Ouvrir la page dans un nouvel onglet'])
  })

  it('beside an answer of its own, shows only the rows every word names', () => {
    const mention = [row('Icônes des sites', ['favicons'], { hint: 'Sa page d’accueil, puis son icône' })]
    expect(ranked(mention, 'page d’accueil')).toEqual(['Icônes des sites'])
    expect(ranked(mention, 'page d’accueil', { answered: true })).toEqual([])
    const units = [...mention, row('Ouvrir la page dans un nouvel onglet', ['tab']), row('Onglets privés', ['private'])]
    expect(ranked(units, 'nouvel onglet', { answered: true })).toEqual(['Ouvrir la page dans un nouvel onglet'])
  })

  it('finds nothing for a query of nothing', () => {
    expect(rankUnits([row('Proxy', ['a'])], '   ')).toEqual([])
  })
})
