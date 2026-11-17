// What the search of the Settings says when a query names something that is not a setting: a command of a menu (importing, printing, the history),
// something done from the page (its zoom, its data, its permissions), or something Lucium does not have (a home page, a choice of font). The answer
// says where it is, with the menu and the shortcut in force, and offers the row of the Settings that comes closest; the rows the query finds are
// still shown under it. Pure.
//
// Every menu named here is checked against the real menu, in French and in English (src/main/shell/settings-answers-menu.test.ts): an answer never
// names an entry that does not exist.

import { t, type MessageKey } from './i18n'
import { shortcutSuffix, type KeyBindings } from './keybindings'
import type { PlatformId } from './platform'
import type { SettingKey } from './settings-catalog'
import { namingWords, phraseWords, queryWords, sameWord } from './settings-search'

export interface SettingsAnswer {
  id: string
  /** What names it, folded, in French and in English: a phrase is found when the query holds each of its words (the common ones aside). */
  phrases: readonly string[]
  /** Words that mean something else is meant: « importer une Retouche » is not the import from another browser. */
  unless?: readonly string[]
  /** The sentence, in the catalogues: `{menu}` is the way through the menus, `{shortcut}` the shortcut of `command` as it is set now (or nothing). */
  text: MessageKey
  /** The way through the menu bar to the entry (or to the menu that holds it), as the catalogues name each step. */
  menu?: readonly MessageKey[]
  /** The command of the entry (shared/keybindings.ts): its shortcut follows a change made in the Settings. */
  command?: string
  /** The setting that comes closest, offered as « Ouvrir dans … ». */
  open?: SettingKey
}

/** The answers, the more precise first: the first one the query names is the one shown. */
export const SETTINGS_ANSWERS: readonly SettingsAnswer[] = [
  { id: 'homepage', phrases: ['page d accueil', 'accueil', 'page de demarrage', 'homepage', 'home page', 'start page', 'startup page'], text: 'settings-search.answer-homepage', command: 'newTab', open: 'restoreWindows' },
  { id: 'reopen-closed', phrases: ['onglet ferme', 'closed tab'], text: 'settings-search.answer-reopen-closed', menu: ['menu.fichier', 'menu.rouvrir-le-dernier-onglet-ferme'], command: 'restoreClosed' },
  { id: 'new-tab', phrases: ['nouvel onglet', 'nouvelle page', 'new tab'], text: 'settings-search.answer-new-tab', command: 'newTab', open: 'suggestHistory' },
  { id: 'font', phrases: ['police', 'fonte', 'caracteres', 'font', 'typeface'], text: 'settings-search.answer-font', command: 'zoomIn', open: 'uiScale' },
  { id: 'import', phrases: ['importer', 'import', 'importation'], unless: ['retouche', 'tweak', 'script', 'javascript', 'theme', 'liste', 'list', 'filtre', 'filter'], text: 'settings-search.answer-import', menu: ['menu.lucium', 'menu.importer-depuis-un-autre-navigateur'], command: 'importData' },
  { id: 'default-browser', phrases: ['navigateur par defaut', 'default browser'], text: 'settings-search.answer-default-browser', menu: ['menu.lucium', 'menu.definir-comme-navigateur-par-defaut'] },
  { id: 'page-zoom', phrases: ['zoom', 'zoomer'], text: 'settings-search.answer-page-zoom', menu: ['menu.affichage', 'menu.zoom-avant'], command: 'zoomIn' },
  { id: 'spelling', phrases: ['orthographe', 'correcteur orthographique', 'grammaire', 'spelling', 'spell check', 'spellcheck', 'grammar'], text: 'settings-search.answer-spelling', menu: ['menu.edition', 'menu.orthographe-et-grammaire', 'menu.verifier-l-orthographe-lors-de-la-saisie'] },
  { id: 'history', phrases: ['afficher historique', 'voir historique', 'ouvrir historique', 'show history', 'view history', 'open history'], text: 'settings-search.answer-history', menu: ['menu.archive', 'menu.afficher-l-historique'], command: 'history', open: 'historyOff' },
  { id: 'downloads', phrases: ['afficher telechargements', 'voir telechargements', 'liste telechargements', 'show downloads', 'view downloads', 'list downloads'], text: 'settings-search.answer-downloads', menu: ['menu.archive', 'menu.afficher-les-telechargements'], command: 'downloads' },
  { id: 'site-data', phrases: ['donnees du site', 'donnees d un site', 'cookies du site', 'cookies d un site', 'site data', 'site cookies'], text: 'settings-search.answer-site-data', menu: ['menu.archive', 'menu.effacer-les-donnees-du-site'], command: 'clearSiteData' },
  { id: 'camera', phrases: ['camera', 'micro', 'microphone', 'webcam'], text: 'settings-search.answer-camera', menu: ['menu.affichage', 'toolbar.infos-et-reglages-du-site'], command: 'siteInfo' },
  { id: 'fullscreen', phrases: ['plein ecran', 'full screen', 'fullscreen'], text: 'settings-search.answer-fullscreen', menu: ['menu.affichage', 'menu.activer-le-mode-plein-ecran'], command: 'fullscreen' },
  { id: 'print', phrases: ['imprimer', 'impression', 'imprimante', 'print', 'printing', 'printer'], text: 'settings-search.answer-print', menu: ['menu.fichier', 'menu.imprimer'], command: 'print' },
  { id: 'reader', phrases: ['mode lecture', 'mode lecteur', 'reader mode', 'reader view', 'reading mode'], text: 'settings-search.answer-reader', menu: ['menu.affichage', 'menu.mode-lecture'], command: 'readerMode' },
  { id: 'sidebar-toggle', phrases: ['masquer barre laterale', 'cacher barre laterale', 'afficher barre laterale', 'hide sidebar', 'show sidebar'], text: 'settings-search.answer-sidebar-toggle', menu: ['menu.affichage'], command: 'toggleSidebar' },
  { id: 'toolbar-toggle', phrases: ['masquer barre outils', 'cacher barre outils', 'afficher barre outils', 'hide toolbar', 'show toolbar'], text: 'settings-search.answer-toolbar-toggle', menu: ['menu.affichage'], command: 'toggleToolbar' },
  { id: 'devtools', phrases: ['outils de developpement', 'outils developpeur', 'devtools', 'developer tools', 'inspecter', 'inspect'], text: 'settings-search.answer-devtools', menu: ['menu.affichage', 'menu.developpeur', 'menu.outils-de-developpement'], command: 'devTools' },
  { id: 'space-theme', phrases: ['theme espace', 'couleur espace', 'fond espace', 'space theme', 'space color', 'space colour'], text: 'settings-search.answer-space-theme', menu: ['menu.espaces', 'menu.modifier-le-theme'] }
]

/** The start of the last word typed that already names an answer: four letters, so that « imp » shows nothing yet. */
const ANSWER_PREFIX = 4

/**
 * The answer the query names, or null: the first of `SETTINGS_ANSWERS` whose phrase the query holds, each word the same word (endings aside), and none
 * of the words that mean something else.
 */
export function settingsAnswer(query: string, answers: readonly SettingsAnswer[] = SETTINGS_ANSWERS): SettingsAnswer | null {
  const words = queryWords(query)
  if (words.length === 0) return null
  const names = (phrase: string): boolean => namingWords(words, phraseWords(phrase), ANSWER_PREFIX).length > 0
  return answers.find((answer) => answer.phrases.some(names) && !(answer.unless ?? []).some((word) => words.some((typed) => sameWord(typed, word)))) ?? null
}

/** The way through the menus, as the menu bar names it in the language of the interface: « Lucium › Importer depuis un autre navigateur… ». */
export const answerMenu = (answer: SettingsAnswer): string => (answer.menu ?? []).map((key) => t(key)).join(' › ')

/** The sentence of an answer, with its menu and the shortcut of its command as the person has set it (nothing when they took it away). */
export function answerText(answer: SettingsAnswer, bindings: KeyBindings | undefined, platform: PlatformId = 'darwin'): string {
  return t(answer.text, { menu: answerMenu(answer), shortcut: answer.command ? shortcutSuffix(answer.command, bindings, platform) : '' })
}
