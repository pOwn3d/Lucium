import { describe, expect, it } from 'vitest'
import { arcSummary, type ArcCounts } from './arc-report'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

/** The summary with the name the import sheet shows for the browser (its application's own name on this Mac). */
const summary = (c: ArcCounts, preview = false) => arcSummary(c, preview, 'Arc')

const counts = (extra: Partial<ArcCounts> = {}): ArcCounts => ({ asked: ['sidebar', 'history'], spaces: 4, tabs: 290, folders: 62, favorites: 8, splits: 2, present: 0, tabGroups: 0, skipped: 0, overLimit: 0, history: { read: 12_000, added: 11_827 }, missing: [], ...extra })

describe('arcSummary', () => {
  it('counts what came in: spaces, tabs, folders, favourites, split views and pages of history', () => {
    const { message } = summary(counts())
    expect(message).toMatch(/^Importé depuis Arc\u00a0: 4 espaces, 290 onglets, 62 dossiers, 8 favoris, 2 vues scindées, 11\s827 pages d’historique\.$/)
  })

  it('uses the singular for one and for none, and names only the parts that were asked for', () => {
    expect(summary(counts({ asked: ['sidebar'], spaces: 1, tabs: 1, folders: 0, favorites: 1, splits: 1, history: null })).message).toBe(frenchSpaces('Importé depuis Arc : 1 espace, 1 onglet, 0 dossier, 1 favori, 1 vue scindée.'))
    expect(summary(counts({ asked: ['history'], spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0, history: { read: 5, added: 0 } })).message).toBe(frenchSpaces('Importé depuis Arc : 0 page d’historique.'))
  })

  it('says nothing new came when everything was there already, and counts those', () => {
    const second = summary(counts({ spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0, present: 361, history: { read: 12_000, added: 0 } }))
    expect(second.message).toBe(frenchSpaces('Rien de nouveau depuis Arc : tout ce que ce fichier contient est déjà là.'))
    expect(second.details.join(' ')).toMatch(/361 éléments déjà importés auparavant\u00a0: laissés tels quels, sans doublon/)
    expect(summary(counts({ present: 1 })).details.join(' ')).toContain(frenchSpaces('1 élément déjà importé auparavant : laissé tel quel'))
  })

  it('says what was left aside and why: tab groups, pages that are not web pages, the limit', () => {
    const { details } = summary(counts({ tabGroups: 3, skipped: 9, overLimit: 2 }))
    expect(details).toContain(frenchSpaces('3 groupes d’onglets : les onglets sont repris, pas le groupe (Lucium n’a pas de groupes d’onglets).'))
    expect(details.join(' ')).toMatch(/9 éléments ignorés\u00a0: pages internes du navigateur ou d’une extension, vue scindée de moins de deux pages web/)
    expect(details.join(' ')).toMatch(/2 éléments non importés\u00a0: limite de 2\s000 atteinte\./)
    expect(summary(counts()).details.join(' ')).not.toMatch(/ignoré|groupe|limite/)
  })

  it('tells the history read and how many pages that added', () => {
    expect(summary(counts()).details.join(' ')).toMatch(/Historique\u00a0: 12\s000 pages lues, 11\s827 ajoutées ou mises à jour/)
  })

  it('says which file was not found', () => {
    const { details } = summary(counts({ history: null, missing: ['history'] }))
    expect(details).toContain(frenchSpaces('Historique : aucun fichier d’historique trouvé.'))
  })

  // The sidebar browser keeps no file of its Tweaks on the Mac: the import neither counts nor names them.
  it('speaks of no Tweak', () => {
    const all = summary(counts({ present: 2, tabGroups: 1, skipped: 1, overLimit: 1, missing: ['history'] }))
    expect([all.message, ...all.details].join(' ')).not.toMatch(/Retouche/)
  })
})

describe('arcSummary in English', () => {
  it('gives the headline and the details in English, with the singular and the plural of each count', () => {
    setLanguage('en')
    try {
      const one = summary(counts({ asked: ['sidebar'], spaces: 1, tabs: 1, folders: 0, favorites: 1, splits: 1, history: null }))
      expect(one.message).toBe('Imported from Arc: 1 Space, 1 tab, 0 folders, 1 favorite, 1 split view.')
      const many = summary(counts({ asked: ['sidebar'], spaces: 4, tabs: 290, folders: 62, favorites: 8, splits: 2, history: null, present: 1 }), true)
      expect(many.message).toBe('Ready to import from Arc: 4 Spaces, 290 tabs, 62 folders, 8 favorites, 2 split views.')
      expect(many.details).toEqual(['1 item already imported before: left as it is, no duplicate.'])
      expect(summary(counts({ spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0, present: 3, history: { read: 5, added: 0 } })).message).toBe('Nothing new from Arc: everything in this file is already here.')
    } finally {
      setLanguage('fr')
    }
    // Back in French, the sentences are the French ones.
    expect(summary(counts({ asked: ['sidebar'], spaces: 1, tabs: 1, folders: 0, favorites: 1, splits: 1, history: null })).message).toBe(frenchSpaces('Importé depuis Arc : 1 espace, 1 onglet, 0 dossier, 1 favori, 1 vue scindée.'))
  })
})

describe('arcSummary without the name of the application', () => {
  it('speaks of the generic label: no browser is named by the code', () => {
    expect(arcSummary(counts({ asked: ['sidebar'], spaces: 1, tabs: 1, folders: 0, favorites: 1, splits: 1, history: null })).message).toBe(frenchSpaces('Importé depuis Navigateur à barre latérale : 1 espace, 1 onglet, 0 dossier, 1 favori, 1 vue scindée.'))
  })
})

describe('arcSummary as a preview', () => {
  it('asks the question instead of reporting, with the same counts', () => {
    const { message } = summary(counts({ spaces: 1, tabs: 4, history: { read: 5, added: 3 } }), true)
    expect(message).toMatch(/^Prêt à importer depuis Arc\u00a0: 1 espace, 4 onglets/)
    expect(summary(counts({ spaces: 1, tabs: 4, history: { read: 5, added: 3 } })).message).toMatch(/^Importé depuis Arc\u00a0: /)
  })

  it('says there is nothing new in the same words, preview or not', () => {
    const same = counts({ present: 3, spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0, history: { read: 5, added: 0 } })
    expect(summary(same, true).message).toBe(summary(same).message)
  })
})
