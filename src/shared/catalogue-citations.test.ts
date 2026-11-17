// A text that sends the reader somewhere names it: a menu entry, a category, a group or a row of Réglages. When that name changes, the text has to
// follow, or it sends the reader to something that is not there any more. These tests read the names the texts cite against the catalogues
// themselves, in both languages.

import { describe, expect, it } from 'vitest'
import { fr } from './i18n-fr'
import { en } from './i18n-en'
import type { MessageKey } from './i18n'

/**
 * Texts that quote a name word for word, and the keys of the names they quote. A rename of the entry, the row or the choice changes the text of
 * its key, and the quoting text fails here until it says the new name.
 */
const QUOTES: Readonly<Partial<Record<MessageKey, readonly MessageKey[]>>> = {
  // the mark of one tab, in the menu of the tab
  'settings.ne-sont-jamais-mis-en-veille-l-onglet': ['ctx.ne-jamais-mettre-cet-onglet-en-veille'],
  'settings.sites-gardes-eveilles-note': ['ctx.ne-jamais-mettre-cet-onglet-en-veille'],
  'settings.au-dela-l-onglet-quitte-depuis-le-plus': ['ctx.ne-jamais-mettre-cet-onglet-en-veille'],
  'settings.desactive-seuls-l-onglet-affiche-et-les': ['ctx.ne-jamais-mettre-cet-onglet-en-veille'],
  'resources.tout-endormir-hint': ['ctx.ne-jamais-mettre-cet-onglet-en-veille'],
  // a choice of the menu « Mode de veille » (a place of the Settings is a generated `{path}`: shared/settings-path.ts)
  'settings.un-onglet-cache-depuis-ce-delai-ne': ['settings.liberer-la-memoire'],
  // the entries of the menus
  'guest-settings.proposer-nouvelle-fenetre-invite-dans-le-menu': ['menu.nouvelle-fenetre-invite'],
  'guide.invite-non-effet': ['menu.nouvelle-fenetre-invite'],
  'web-tools-settings.ajoute-surveiller-cette-page-au-menu': ['menu.surveiller-cette-page', 'menu.surveiller-une-zone-de-la-page'],
  'lock-settings.le-menu-d-un-espace-clic-droit-sur-son': ['menu.verrouiller-maintenant'],
  'settings.lucium-cherche-une-nouvelle-version-au': ['menu.rechercher-les-mises-a-jour', 'auto-update.installer'],
  'menu-actions.a-votre-demande-seulement-le-chrome-web-store': ['menu.rechercher-les-mises-a-jour', 'auto-update.installer'],
  'menu-actions.sans-action-de-votre-part-partent-du-reseau': ['features.rechercher-les-mises-a-jour-automatiquement'],
  'features.ajoute-le-bouton-dans-l-en-tete-de-la-barre': ['menu.actualiser-tous-les-onglets'],
  'settings-illustrations.block-ads': ['menu.infos-et-reglages-du-site'],
  // the rows another row depends on
  'download-settings.l-adresse-souvent-avec-un-jeton-et-le': ['download-settings.demander-ou-enregistrer-chaque-fichier'],
  'guide.reprise-redemarrage-effet': ['download-settings.demander-ou-enregistrer-chaque-fichier'],
  'download-settings.un-bouton-dans-la-fenetre-des': ['download-settings.reprendre-les-telechargements-apres-un'],
  'features.montre-l-avancement-d-un-telechargement-au-pied': ['download-settings.pause-et-reprise-des-telechargements'],
  'blocking-settings.cache-ce-que-les-listes-designent': ['guard-settings.scriptlets-et-regles-etendues-du-bloqueur'],
  'little-arc-settings.le-delai-avant-l-archivage-d-une-fenetre': ['settings.fermer-et-archiver-les-mini-fenetres-oubliees'],
  'little-arc-settings.liens-nouvel-onglet-en-mini-fenetre-aide': ['settings.coup-d-oeil-pour-les-liens-vers-d-autres-sites'],
  'settings.par-defaut-lucium-les-ouvre-au-premier': ['little-arc-settings.liens-nouvel-onglet-en-mini-fenetre'],
  'settings.un-lien-ouvert-depuis-une-autre-app-mail': ['settings.les-liens-d-autres-apps-s-ouvrent-dans'],
  'readable-mode.sombre-quand-l-apparence-est-sombre-suit-le': ['settings.apparence'],
  'appearance-settings.aucun-site-n-a-de-mode-a-part': ['cmd.infos-et-reglages-du-site'],
  'appearance-settings.un-site-couvre-aussi-ses-sous-domaines-sauf': ['settings.retirer'],
  'settings.une-ligne-sur-la-carte-qui-s-ouvre-quand-le': ['tab-state.memoire-liberee']
}

const CATALOGUES = { fr, en } as const

/** A name without the ellipsis a menu entry ends with, the quotes around it, and its case: « Sessions… » is « sessions ». */
const fold = (text: string): string => text.replace(/[…«»“”]/g, '').trim().toLowerCase()

/** The words that may stand before the first › without being a name: a menu that is not one of ours (the menu of a tab), or a variable. */
const GENERIC_START = /(?:\bmenu(?: de l’onglet)?(?: \((?:clic droit|right-click)\))?|\{\w+\})$/i

/** Paths of macOS (its System Settings), not of Lucium: their names are the system's, in its language. Taken out before the search. */
const SYSTEM_PATH = /(?:Réglages Système|System Settings)(?: › (?:«[^»]*»|“[^”]*”|[^.;,«»“”()]+?))+(?=[.;,«»“”()]|$)/g

/** The names of a catalogue, the longest first, so that a name is found whole before a shorter one it starts with. */
const namesOf = (catalogue: Readonly<Record<string, string>>): string[] =>
  [...new Set(Object.values(catalogue).map(fold))].filter((name) => name.length >= 3 && !name.includes('{')).sort((a, b) => b.length - a.length)

const wordEnd = (text: string, at: number): boolean => at >= text.length || !/[\p{L}\p{N}]/u.test(text[at]!)

/** The parts of an « A › B › C » path that are the text of no key: the words before the first ›, and the ones after each ›. */
function unknownSteps(text: string, names: readonly string[]): string[] {
  const pieces = text.replace(SYSTEM_PATH, ' ').split(' › ')
  if (pieces.length < 2) return []
  const unknown: string[] = []
  const before = fold(pieces[0]!)
  const ends = names.some((name) => before.endsWith(name) && wordEnd(` ${before}`, before.length - name.length))
  if (!ends && !GENERIC_START.test(pieces[0]!.trim())) unknown.push(pieces[0]!.slice(-40))
  for (const piece of pieces.slice(1)) {
    const after = fold(piece)
    if (after.startsWith('{')) continue
    if (!names.some((name) => after.startsWith(name) && wordEnd(after, name.length))) unknown.push(piece.slice(0, 40))
  }
  return unknown
}

describe('the names the texts cite', () => {
  it('finds a step that names nothing, and lets a known one through', () => {
    const names = namesOf({ a: 'Fichier', b: 'Surveiller cette page', c: 'Sessions…' })
    expect(unknownSteps('Ouvrez-en une, puis Fichier › Surveiller cette page.', names)).toEqual([])
    expect(unknownSteps('Pour la remettre : menu Fichier › Sessions… la liste', names)).toEqual([])
    expect(unknownSteps('son menu (clic droit) › Surveiller cette page', names)).toEqual([])
    expect(unknownSteps('Ouvrez Fichier › Surveiller la page', names)).toEqual(['Surveiller la page'])
    expect(unknownSteps('Ouvrez Édition › Surveiller cette page', names)).toEqual(['Ouvrez Édition'])
    expect(unknownSteps('Ouvrez Réglages Système › Confidentialité et sécurité › Réseau local, puis Fichier › Sessions…', names)).toEqual([])
    expect(unknownSteps('dans Réglages Système › Général › « Langues pour la traduction… ».', names)).toEqual([])
  })

  it('quote the very name of the entry, the row or the choice they speak of', () => {
    const wrong = Object.entries(QUOTES).flatMap(([key, quoted]) =>
      Object.entries(CATALOGUES).flatMap(([language, catalogue]) =>
        quoted!.filter((name) => !catalogue[key as MessageKey].includes(catalogue[name])).map((name) => `${language}:${key} ne cite pas « ${catalogue[name]} » (${name})`)
      )
    )
    expect(wrong).toEqual([])
  })

  it('name, in every « A › B » path, a menu, a category, a group or a row that exists', () => {
    const wrong = Object.entries(CATALOGUES).flatMap(([language, catalogue]) => {
      const names = namesOf(catalogue)
      return Object.entries(catalogue).flatMap(([key, text]) => unknownSteps(text, names).map((step) => `${language}:${key} « ${step} »`))
    })
    expect(wrong).toEqual([])
  })
})
