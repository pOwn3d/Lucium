// « Régler en quelques questions »: fixed questions, written here as data. Each answer is a patch of real settings with one line of what it does;
// the answer the settings already hold is preselected (`answerOf`), the plan lists exactly the settings that change with the label of their row
// (`guidePlan`) and keeps the values that put them back (`undoPatch`). Pure: the Settings window draws it (renderer/GuideSettings.tsx) and writes
// the patch through `settings/update`, where the reducer cleans it like any other change.

import { LANGUAGE_NAMES, t, tp, type MessageKey } from './i18n'
import { SETTINGS_PANES, type OverlayRequest, type SettingsPane } from './ipc'
import { SEARCH_ENGINES, type Settings } from './model'
import { adsBlockingOn } from './privacy-dashboard'
import { profileLabel, type ProfileSettings } from './profiles'
import { READABLE_LABELS } from './readable-mode'
import { SLEEP_LEVELS } from './sleep'
import { WEB_STORE_UPDATE_LABELS } from './web-store'

export type GuideKey = keyof Settings

export interface GuideAnswer {
  id: string
  label: MessageKey
  /** One line: what the answer really does. */
  effect: MessageKey
  patch: Partial<Settings>
  recommended?: true
  /**
   * Whether the settings are this answer when they do not hold its patch to the letter: an alias (`blockTrackers`), or a value read the way its
   * row reads it (the language). Applying the patch always makes it true (settings-guide.test.ts).
   */
  holds?: (settings: Settings) => boolean
}

export interface GuideQuestion {
  id: string
  pane: SettingsPane
  /** A word or two for the card of the category. */
  topic: MessageKey
  title: MessageKey
  /** A line under the question. */
  hint?: MessageKey
  answers: readonly GuideAnswer[]
  /** Asked only when this holds for the settings as answered so far: the kind of sleep means nothing once the sleep is « Jamais ». */
  when?: (settings: Settings) => boolean
  /** The settings a profile may set on its own (shared/profiles.ts): a profile that does keeps its value, and the question says so. */
  profileKeys?: readonly (keyof ProfileSettings)[]
}

/** What opens the complete configuration: the Help menu, the first-launch sheet, the end of an import. */
export const GUIDED_SETUP_REQUEST: Extract<OverlayRequest, { panel: 'settings' }> = { panel: 'settings', pane: 'general', anchor: 'guide' }

const known = (url: string) => SEARCH_ENGINES.find((engine) => engine.url === url)
/** A known engine without suggestions (Qwant, Ecosia) makes the question about them pointless; an address of one's own may have some. */
const engineSuggests = (settings: Settings): boolean => {
  const engine = known(settings.searchUrlTemplate)
  return engine === undefined || engine.suggest !== undefined
}
const engineUrl = (name: string): string => SEARCH_ENGINES.find((engine) => engine.name === name)!.url
const shownLanguage = (settings: Settings): string => (settings.interfaceTranslated ? settings.language : 'fr')
const sleeping = (settings: Settings): boolean => settings.sleepAfterMinutes > 0

/** About thirty questions, three to five per category, in the order of the categories. */
export const GUIDE_QUESTIONS: readonly GuideQuestion[] = [
  // ---- Général ----
  {
    id: 'mises-a-jour',
    pane: 'general',
    topic: 'guide.mises-a-jour-sujet',
    title: 'guide.mises-a-jour',
    answers: [
      { id: 'auto', label: 'guide.mises-a-jour-auto', effect: 'guide.mises-a-jour-auto-effet', patch: { autoUpdate: true }, recommended: true },
      { id: 'demande', label: 'guide.mises-a-jour-demande', effect: 'guide.mises-a-jour-demande-effet', patch: { autoUpdate: false } }
    ]
  },
  {
    id: 'nouveautes',
    pane: 'general',
    topic: 'guide.nouveautes-sujet',
    title: 'guide.nouveautes',
    answers: [
      { id: 'montrer', label: 'guide.nouveautes-montrer', effect: 'guide.nouveautes-montrer-effet', patch: { whatsNewSheet: true }, recommended: true },
      { id: 'rien', label: 'guide.nouveautes-rien', effect: 'guide.nouveautes-rien-effet', patch: { whatsNewSheet: false } }
    ]
  },
  {
    id: 'quitter',
    pane: 'general',
    topic: 'guide.quitter-sujet',
    title: 'guide.quitter',
    answers: [
      { id: 'demander', label: 'guide.quitter-demander', effect: 'guide.quitter-demander-effet', patch: { warnBeforeQuitting: true }, recommended: true },
      { id: 'aussitot', label: 'guide.quitter-aussitot', effect: 'guide.quitter-aussitot-effet', patch: { warnBeforeQuitting: false } }
    ]
  },
  {
    id: 'langue',
    pane: 'general',
    topic: 'guide.langue-sujet',
    title: 'guide.langue',
    answers: [
      { id: 'systeme', label: 'guide.langue-systeme', effect: 'guide.langue-systeme-effet', patch: { interfaceTranslated: true, language: 'auto' }, recommended: true, holds: (s) => shownLanguage(s) === 'auto' },
      // As the Language row writes it: French is the interface with the translation off.
      { id: 'francais', label: 'guide.langue-francais', effect: 'guide.langue-francais-effet', patch: { interfaceTranslated: false }, holds: (s) => shownLanguage(s) === 'fr' },
      { id: 'anglais', label: 'guide.langue-anglais', effect: 'guide.langue-anglais-effet', patch: { interfaceTranslated: true, language: 'en' }, holds: (s) => shownLanguage(s) === 'en' }
    ]
  },
  // ---- Apparence ----
  {
    id: 'apparence',
    pane: 'appearance',
    topic: 'guide.apparence-sujet',
    title: 'guide.apparence',
    answers: [
      { id: 'systeme', label: 'guide.apparence-systeme', effect: 'guide.apparence-systeme-effet', patch: { interfaceAppearance: 'auto', websiteAppearance: 'auto' }, recommended: true },
      { id: 'clair', label: 'guide.apparence-clair', effect: 'guide.apparence-clair-effet', patch: { interfaceAppearance: 'light', websiteAppearance: 'auto' } },
      { id: 'sombre', label: 'guide.apparence-sombre', effect: 'guide.apparence-sombre-effet', patch: { interfaceAppearance: 'dark', websiteAppearance: 'auto' } }
    ]
  },
  {
    id: 'sites-sombres',
    pane: 'appearance',
    topic: 'guide.sites-sombres-sujet',
    title: 'guide.sites-sombres',
    answers: [
      { id: 'tels-quels', label: 'guide.sites-sombres-tels-quels', effect: 'guide.sites-sombres-tels-quels-effet', patch: { readableMode: 'original' }, recommended: true },
      { id: 'le-soir', label: 'guide.sites-sombres-le-soir', effect: 'guide.sites-sombres-le-soir-effet', patch: { readableMode: 'auto' } },
      { id: 'toujours', label: 'guide.sites-sombres-toujours', effect: 'guide.sites-sombres-toujours-effet', patch: { readableMode: 'dark' } }
    ]
  },
  {
    id: 'cote-barre',
    pane: 'appearance',
    topic: 'guide.cote-barre-sujet',
    title: 'guide.cote-barre',
    answers: [
      { id: 'gauche', label: 'guide.cote-barre-gauche', effect: 'guide.cote-barre-gauche-effet', patch: { sidebarRight: false }, recommended: true },
      { id: 'droite', label: 'guide.cote-barre-droite', effect: 'guide.cote-barre-droite-effet', patch: { sidebarRight: true } }
    ]
  },
  {
    id: 'compact',
    pane: 'appearance',
    topic: 'guide.compact-sujet',
    title: 'guide.compact',
    answers: [
      { id: 'non', label: 'guide.compact-non', effect: 'guide.compact-non-effet', patch: { compactMode: false }, recommended: true },
      { id: 'oui', label: 'guide.compact-oui', effect: 'guide.compact-oui-effet', patch: { compactMode: true } }
    ]
  },
  {
    id: 'taille',
    pane: 'appearance',
    topic: 'guide.taille-sujet',
    title: 'guide.taille',
    answers: [
      { id: 'normale', label: 'guide.taille-normale', effect: 'guide.taille-normale-effet', patch: { uiScale: 100 }, recommended: true },
      { id: 'plus-grande', label: 'guide.taille-plus-grande', effect: 'guide.taille-plus-grande-effet', patch: { uiScale: 115 } },
      { id: 'grande', label: 'guide.taille-grande', effect: 'guide.taille-grande-effet', patch: { uiScale: 130 } },
      { id: 'tres-grande', label: 'guide.taille-tres-grande', effect: 'guide.taille-tres-grande-effet', patch: { uiScale: 150 } }
    ]
  },
  // ---- Onglets et fenêtres ----
  {
    id: 'veille',
    pane: 'tabs',
    topic: 'guide.veille-sujet',
    title: 'guide.veille',
    answers: [
      { id: 'jamais', label: 'settings.jamais', effect: 'guide.veille-jamais-effet', patch: { sleepAfterMinutes: 0 } },
      { id: 'modere', label: 'settings.modere', effect: 'guide.veille-modere-effet', patch: { ...SLEEP_LEVELS.moderate } },
      { id: 'equilibre', label: 'settings.equilibre', effect: 'guide.veille-equilibre-effet', patch: { ...SLEEP_LEVELS.balanced }, recommended: true },
      { id: 'maximal', label: 'settings.maximal', effect: 'guide.veille-maximal-effet', patch: { ...SLEEP_LEVELS.maximum } }
    ]
  },
  {
    id: 'veille-mode',
    pane: 'tabs',
    topic: 'guide.veille-mode-sujet',
    title: 'guide.veille-mode',
    when: sleeping,
    answers: [
      { id: 'liberer', label: 'settings.liberer-la-memoire', effect: 'guide.veille-mode-liberer-effet', patch: { sleepMode: 'discard' }, recommended: true },
      { id: 'garder', label: 'settings.geler', effect: 'guide.veille-mode-garder-effet', patch: { sleepMode: 'freeze' } }
    ]
  },
  {
    id: 'archivage',
    pane: 'tabs',
    topic: 'guide.archivage-sujet',
    title: 'guide.archivage',
    profileKeys: ['autoArchiveHours'],
    answers: [
      { id: '12-heures', label: 'settings.apres-12-heures', effect: 'guide.archivage-12-heures-effet', patch: { autoArchiveHours: 12 }, recommended: true },
      { id: '1-jour', label: 'settings.apres-1-jour', effect: 'guide.archivage-1-jour-effet', patch: { autoArchiveHours: 24 } },
      { id: '7-jours', label: 'settings.apres-7-jours', effect: 'guide.archivage-7-jours-effet', patch: { autoArchiveHours: 168 } },
      { id: 'jamais', label: 'settings.jamais', effect: 'guide.archivage-jamais-effet', patch: { autoArchiveHours: 0 } }
    ]
  },
  {
    id: 'epingles',
    pane: 'tabs',
    topic: 'guide.epingles-sujet',
    title: 'guide.epingles',
    when: sleeping,
    answers: [
      { id: 'comme-les-autres', label: 'guide.epingles-comme-les-autres', effect: 'guide.epingles-comme-les-autres-effet', patch: { sleepSkipPinned: false }, recommended: true },
      { id: 'eveilles', label: 'guide.epingles-eveilles', effect: 'guide.epingles-eveilles-effet', patch: { sleepSkipPinned: true } }
    ]
  },
  {
    id: 'lancement',
    pane: 'tabs',
    topic: 'guide.lancement-sujet',
    title: 'guide.lancement',
    answers: [
      { id: 'affiches', label: 'guide.lancement-affiches', effect: 'guide.lancement-affiches-effet', patch: { restoreWindows: true, loadAllTabsAtLaunch: false }, recommended: true },
      { id: 'tous', label: 'guide.lancement-tous', effect: 'guide.lancement-tous-effet', patch: { restoreWindows: true, loadAllTabsAtLaunch: true } },
      { id: 'une-fenetre', label: 'guide.lancement-une-fenetre', effect: 'guide.lancement-une-fenetre-effet', patch: { restoreWindows: false, loadAllTabsAtLaunch: false } }
    ]
  },
  // ---- Navigation ----
  {
    id: 'moteur',
    pane: 'navigation',
    topic: 'guide.moteur-sujet',
    title: 'guide.moteur',
    profileKeys: ['searchUrlTemplate'],
    answers: [
      { id: 'duckduckgo', label: 'guide.moteur-duckduckgo', effect: 'guide.moteur-duckduckgo-effet', patch: { searchUrlTemplate: engineUrl('DuckDuckGo') }, recommended: true },
      { id: 'google', label: 'guide.moteur-google', effect: 'guide.moteur-google-effet', patch: { searchUrlTemplate: engineUrl('Google') } },
      { id: 'brave', label: 'guide.moteur-brave', effect: 'guide.moteur-brave-effet', patch: { searchUrlTemplate: engineUrl('Brave Search') } },
      { id: 'qwant', label: 'guide.moteur-qwant', effect: 'guide.moteur-qwant-effet', patch: { searchUrlTemplate: engineUrl('Qwant') } }
    ]
  },
  {
    id: 'suggestions',
    pane: 'navigation',
    topic: 'guide.suggestions-sujet',
    title: 'guide.suggestions',
    when: engineSuggests,
    profileKeys: ['searchSuggestions'],
    answers: [
      { id: 'oui', label: 'guide.suggestions-oui', effect: 'guide.suggestions-oui-effet', patch: { searchSuggestions: true }, recommended: true },
      { id: 'non', label: 'guide.suggestions-non', effect: 'guide.suggestions-non-effet', patch: { searchSuggestions: false } }
    ]
  },
  {
    id: 'barre-commandes',
    pane: 'navigation',
    topic: 'guide.barre-commandes-sujet',
    title: 'guide.barre-commandes',
    answers: [
      { id: 's', label: 'search-settings.petite-s', effect: 'guide.barre-commandes-s-effet', patch: { commandBarSize: 's' } },
      { id: 'm', label: 'search-settings.moyenne-m', effect: 'guide.barre-commandes-m-effet', patch: { commandBarSize: 'm' }, recommended: true },
      { id: 'l', label: 'search-settings.grande-l', effect: 'guide.barre-commandes-l-effet', patch: { commandBarSize: 'l' } },
      { id: 'xl', label: 'search-settings.tres-grande-xl', effect: 'guide.barre-commandes-xl-effet', patch: { commandBarSize: 'xl' } }
    ]
  },
  {
    id: 'liens',
    pane: 'navigation',
    topic: 'guide.liens-sujet',
    title: 'guide.liens',
    answers: [
      { id: 'mini', label: 'guide.liens-mini', effect: 'guide.liens-mini-effet', patch: { externalLinksInLittleArc: true, littleArcNewTabLinks: true }, recommended: true },
      { id: 'onglet', label: 'guide.liens-onglet', effect: 'guide.liens-onglet-effet', patch: { externalLinksInLittleArc: false, littleArcNewTabLinks: false } }
    ]
  },
  // ---- Vie privée et sécurité ----
  {
    id: 'bloqueur',
    pane: 'protection',
    topic: 'guide.bloqueur-sujet',
    title: 'guide.bloqueur',
    // The switch of the ads writes its alias too (privacy-dashboard.ts), and the blocker reads either.
    answers: [
      { id: 'pubs', label: 'guide.bloqueur-pubs', effect: 'guide.bloqueur-pubs-effet', patch: { blockAds: true, blockTrackers: true, blockCookieBanners: false }, holds: (s) => adsBlockingOn(s) && !s.blockCookieBanners },
      { id: 'cookies', label: 'guide.bloqueur-cookies', effect: 'guide.bloqueur-cookies-effet', patch: { blockAds: true, blockTrackers: true, blockCookieBanners: true }, recommended: true, holds: (s) => adsBlockingOn(s) && s.blockCookieBanners },
      { id: 'rien', label: 'guide.bloqueur-rien', effect: 'guide.bloqueur-rien-effet', patch: { blockAds: false, blockTrackers: false, blockCookieBanners: false }, holds: (s) => !adsBlockingOn(s) && !s.blockCookieBanners }
    ]
  },
  {
    id: 'site-casse',
    pane: 'protection',
    topic: 'guide.site-casse-sujet',
    title: 'guide.site-casse',
    hint: 'guide.site-casse-aide',
    when: adsBlockingOn,
    answers: [
      { id: 'site-par-site', label: 'guide.site-casse-site-par-site', effect: 'guide.site-casse-site-par-site-effet', patch: { blockMode: 'standard', blockCosmetic: true, blockScriptlets: false }, recommended: true },
      { id: 'plus-fort', label: 'guide.site-casse-plus-fort', effect: 'guide.site-casse-plus-fort-effet', patch: { blockMode: 'strict', blockCosmetic: true, blockScriptlets: true } },
      { id: 'moins', label: 'guide.site-casse-moins', effect: 'guide.site-casse-moins-effet', patch: { blockMode: 'standard', blockCosmetic: false, blockScriptlets: false } }
    ]
  },
  {
    id: 'pistage',
    pane: 'protection',
    topic: 'guide.pistage-sujet',
    title: 'guide.pistage',
    answers: [
      { id: 'rien', label: 'guide.pistage-rien', effect: 'guide.pistage-rien-effet', patch: { sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false, reduceFingerprint: false } },
      { id: 'adresses', label: 'guide.pistage-adresses', effect: 'guide.pistage-adresses-effet', patch: { sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true, reduceFingerprint: false }, recommended: true },
      { id: 'empreinte', label: 'guide.pistage-empreinte', effect: 'guide.pistage-empreinte-effet', patch: { sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true, reduceFingerprint: true } }
    ]
  },
  {
    id: 'historique',
    pane: 'protection',
    topic: 'guide.historique-sujet',
    title: 'guide.historique',
    profileKeys: ['historyOff'],
    answers: [
      { id: 'garder', label: 'guide.historique-garder', effect: 'guide.historique-garder-effet', patch: { historyOff: false }, recommended: true },
      { id: 'rien', label: 'guide.historique-rien', effect: 'guide.historique-rien-effet', patch: { historyOff: true } }
    ]
  },
  {
    id: 'mots-de-passe',
    pane: 'protection',
    topic: 'guide.mots-de-passe-sujet',
    title: 'guide.mots-de-passe',
    answers: [
      { id: 'ailleurs', label: 'guide.mots-de-passe-ailleurs', effect: 'guide.mots-de-passe-ailleurs-effet', patch: { passwordManager: false }, recommended: true },
      { id: 'coffre', label: 'guide.mots-de-passe-coffre', effect: 'guide.mots-de-passe-coffre-effet', patch: { passwordManager: true } }
    ]
  },
  // ---- Fichiers ----
  {
    id: 'ou-enregistrer',
    pane: 'files',
    topic: 'guide.ou-enregistrer-sujet',
    title: 'guide.ou-enregistrer',
    answers: [
      { id: 'dossier', label: 'guide.ou-enregistrer-dossier', effect: 'guide.ou-enregistrer-dossier-effet', patch: { downloadAskWhere: false }, recommended: true },
      { id: 'demander', label: 'guide.ou-enregistrer-demander', effect: 'guide.ou-enregistrer-demander-effet', patch: { downloadAskWhere: true } }
    ]
  },
  {
    id: 'noms-fichiers',
    pane: 'files',
    topic: 'guide.noms-fichiers-sujet',
    title: 'guide.noms-fichiers',
    answers: [
      { id: 'tels-quels', label: 'guide.noms-fichiers-tels-quels', effect: 'guide.noms-fichiers-tels-quels-effet', patch: { tidyDownloads: false }, recommended: true },
      { id: 'epurer', label: 'guide.noms-fichiers-epurer', effect: 'settings.nettoie-le-nom-des-fichiers-telecharges', patch: { tidyDownloads: true } }
    ]
  },
  {
    id: 'reprise',
    pane: 'files',
    topic: 'guide.reprise-sujet',
    title: 'guide.reprise',
    answers: [
      { id: 'rien', label: 'guide.reprise-rien', effect: 'guide.reprise-rien-effet', patch: { downloadPause: false, downloadResume: false } },
      { id: 'pause', label: 'guide.reprise-pause', effect: 'guide.reprise-pause-effet', patch: { downloadPause: true, downloadResume: false }, recommended: true },
      { id: 'redemarrage', label: 'guide.reprise-redemarrage', effect: 'guide.reprise-redemarrage-effet', patch: { downloadPause: true, downloadResume: true } }
    ]
  },
  {
    id: 'copies',
    pane: 'files',
    topic: 'guide.copies-sujet',
    title: 'guide.copies',
    answers: [
      { id: 'normal', label: 'guide.copies-normal', effect: 'guide.copies-normal-effet', patch: { autoBackup: true, autoBackupMinutes: 30, autoBackupKeep: 5 }, recommended: true },
      { id: 'souvent', label: 'guide.copies-souvent', effect: 'guide.copies-souvent-effet', patch: { autoBackup: true, autoBackupMinutes: 15, autoBackupKeep: 10 } },
      { id: 'non', label: 'guide.copies-non', effect: 'guide.copies-non-effet', patch: { autoBackup: false } }
    ]
  },
  // ---- Outils et extensions ----
  {
    id: 'web-store',
    pane: 'tools',
    topic: 'guide.web-store-sujet',
    title: 'guide.web-store',
    answers: [
      { id: 'a-la-demande', label: 'guide.web-store-a-la-demande', effect: 'guide.web-store-a-la-demande-effet', patch: { webStoreInstall: true, webStoreUpdates: 'manual' }, recommended: true },
      { id: 'chaque-semaine', label: 'guide.web-store-chaque-semaine', effect: 'guide.web-store-chaque-semaine-effet', patch: { webStoreInstall: true, webStoreUpdates: 'weekly' } },
      { id: 'non', label: 'guide.web-store-non', effect: 'guide.web-store-non-effet', patch: { webStoreInstall: false, webStoreUpdates: 'manual' } }
    ]
  },
  {
    id: 'outils',
    pane: 'tools',
    topic: 'guide.outils-sujet',
    title: 'guide.outils',
    answers: [
      { id: 'aucun', label: 'guide.outils-aucun', effect: 'guide.outils-aucun-effet', patch: { qrCode: false, readAloud: false, pageWatch: false }, recommended: true },
      { id: 'qr-voix', label: 'guide.outils-qr-voix', effect: 'guide.outils-qr-voix-effet', patch: { qrCode: true, readAloud: true, pageWatch: false } },
      { id: 'tous', label: 'guide.outils-tous', effect: 'guide.outils-tous-effet', patch: { qrCode: true, readAloud: true, pageWatch: true } }
    ]
  },
  {
    id: 'traduction',
    pane: 'tools',
    topic: 'guide.traduction-sujet',
    title: 'guide.traduction',
    answers: [
      { id: 'macos', label: 'guide.traduction-macos', effect: 'guide.traduction-macos-effet', patch: { translateLocal: true, translateSystemEngine: true }, recommended: true },
      { id: 'modeles', label: 'guide.traduction-modeles', effect: 'guide.traduction-modeles-effet', patch: { translateLocal: true, translateSystemEngine: false } },
      { id: 'non', label: 'guide.traduction-non', effect: 'guide.traduction-non-effet', patch: { translateLocal: false } }
    ]
  },
  {
    id: 'batterie',
    pane: 'tools',
    topic: 'guide.batterie-sujet',
    title: 'guide.batterie',
    answers: [
      { id: 'normal', label: 'guide.batterie-normal', effect: 'guide.batterie-normal-effet', patch: { batterySaver: false }, recommended: true },
      { id: 'econome', label: 'guide.batterie-econome', effect: 'features.moins-d-activite-en-arriere-plan-a-20-de', patch: { batterySaver: true } }
    ]
  },
  // ---- Profils ----
  {
    id: 'conteneurs',
    pane: 'profiles',
    topic: 'guide.conteneurs-sujet',
    title: 'guide.conteneurs',
    answers: [
      { id: 'non', label: 'guide.conteneurs-non', effect: 'guide.conteneurs-non-effet', patch: { tabContainers: false }, recommended: true },
      { id: 'oui', label: 'guide.conteneurs-oui', effect: 'features.un-onglet-peut-vivre-dans-une-identite-a-part', patch: { tabContainers: true } }
    ]
  },
  {
    id: 'invite',
    pane: 'profiles',
    topic: 'guide.invite-sujet',
    title: 'guide.invite',
    answers: [
      { id: 'non', label: 'guide.invite-non', effect: 'guide.invite-non-effet', patch: { guestProfile: false }, recommended: true },
      { id: 'oui', label: 'guide.invite-oui', effect: 'guide.invite-oui-effet', patch: { guestProfile: true } }
    ]
  },
  {
    id: 'onglets-prives',
    pane: 'profiles',
    topic: 'guide.onglets-prives-sujet',
    title: 'guide.onglets-prives',
    answers: [
      { id: 'oui', label: 'guide.onglets-prives-oui', effect: 'features.un-onglet-dont-la-session-reste-en-memoire-et', patch: { privateTabs: true }, recommended: true },
      { id: 'non', label: 'guide.onglets-prives-non', effect: 'guide.onglets-prives-non-effet', patch: { privateTabs: false } }
    ]
  }
]

/**
 * The answers marked « conseillé » that are not the defaults, and why. The others give back the defaults (settings-guide.test.ts holds both).
 */
export const RECOMMENDED_AWAY_FROM_DEFAULTS: Readonly<Record<string, string>> = {
  reprise: 'off by default only because the browser it follows has no pause button; the button costs nothing, and the resume after a restart (a file of addresses) stays a choice'
}

// ---------- the rows of « Ce qui va changer » ----------

interface GuideRow {
  /** The label of the row of the setting, as the category draws it. */
  label: MessageKey
  /** The settings the row shows (an alias with its setting). */
  keys: readonly GuideKey[]
  /** The value the row shows, before it is put in words. */
  read?: (settings: Settings) => unknown
  show: (value: unknown) => string
}

const yesNo = (value: unknown): string => t(value === true ? 'guide.oui' : 'guide.non')
const minutes = (value: unknown): string => (value === 0 ? t('settings.jamais') : t('guide.minutes', { count: Number(value) }))
const hours = (value: unknown): string => {
  const count = Number(value)
  if (count === 0) return t('settings.jamais')
  return count % 24 === 0 ? tp('guide.jours', count / 24) : t('guide.heures', { count })
}
const choice = (names: Readonly<Record<string, () => string>>) => (value: unknown): string => names[String(value)]?.() ?? String(value)
const flag = (label: MessageKey, key: GuideKey): GuideRow => ({ label, keys: [key], show: yesNo })

/** One row per setting the questions write, keyed by that setting. */
export const GUIDE_ROWS: Readonly<Record<string, GuideRow>> = {
  autoUpdate: flag('features.rechercher-les-mises-a-jour-automatiquement', 'autoUpdate'),
  whatsNewSheet: flag('features.nouveautes-apres-une-mise-a-jour', 'whatsNewSheet'),
  warnBeforeQuitting: flag('settings.avertir-avant-de-quitter', 'warnBeforeQuitting'),
  language: {
    label: 'lang.interface',
    keys: ['interfaceTranslated', 'language'],
    read: shownLanguage,
    show: choice({ auto: () => t('lang.auto'), fr: () => LANGUAGE_NAMES.fr, en: () => LANGUAGE_NAMES.en })
  },
  interfaceAppearance: { label: 'settings.apparence', keys: ['interfaceAppearance'], show: choice({ auto: () => t('menu.automatique'), light: () => t('menu.clair'), dark: () => t('menu.sombre') }) },
  websiteAppearance: { label: 'settings.apparence-demandee-aux-sites', keys: ['websiteAppearance'], show: choice({ auto: () => t('menu.automatique'), light: () => t('menu.clair'), dark: () => t('menu.sombre') }) },
  readableMode: { label: 'appearance-settings.contraste-de-la-page-pour-tous-les-sites', keys: ['readableMode'], show: choice({ original: () => READABLE_LABELS.original.name, dark: () => READABLE_LABELS.dark.name, light: () => READABLE_LABELS.light.name, auto: () => READABLE_LABELS.auto.name }) },
  sidebarRight: { label: 'spaces-settings.placer-la-barre-laterale-a-droite-de-la-fenetre', keys: ['sidebarRight'], show: choice({ false: () => t('guide.cote-barre-gauche'), true: () => t('guide.cote-barre-droite') }) },
  compactMode: flag('features.mode-compact', 'compactMode'),
  uiScale: { label: 'settings.taille-de-l-interface', keys: ['uiScale'], show: (value) => t('guide.pourcentage', { count: Number(value) }) },
  sleepAfterMinutes: { label: 'settings.mettre-en-veille-les-onglets-inactifs', keys: ['sleepAfterMinutes'], show: minutes },
  sleepAwakeMax: { label: 'settings.onglets-eveilles-en-arriere-plan-au-plus', keys: ['sleepAwakeMax'], show: (value) => (value === 0 ? t('settings.sans-limite') : String(value)) },
  sleepFreezeAfterMinutes: { label: 'settings.geler-d-abord-les-onglets-caches', keys: ['sleepFreezeAfterMinutes'], show: minutes },
  sleepMode: { label: 'settings.mode-de-veille', keys: ['sleepMode'], show: choice({ discard: () => t('settings.liberer-la-memoire'), freeze: () => t('settings.geler') }) },
  autoArchiveHours: { label: 'settings-profiles.archiver-les-onglets-apres', keys: ['autoArchiveHours'], show: hours },
  sleepSkipPinned: flag('settings.ne-pas-mettre-en-veille-les-onglets-epingles', 'sleepSkipPinned'),
  restoreWindows: flag('settings.rouvrir-les-fenetres-de-la-session-precedente', 'restoreWindows'),
  loadAllTabsAtLaunch: flag('settings.charger-tous-les-onglets-au-lancement', 'loadAllTabsAtLaunch'),
  searchUrlTemplate: { label: 'settings-profiles.moteur-de-recherche', keys: ['searchUrlTemplate'], show: (value) => known(String(value))?.name ?? t('settings.personnalise') },
  searchSuggestions: flag('settings-profiles.inclure-les-suggestions-de-recherche', 'searchSuggestions'),
  commandBarSize: {
    label: 'search-settings.taille-de-la-barre-de-commandes',
    keys: ['commandBarSize'],
    show: choice({ s: () => t('search-settings.petite-s'), m: () => t('search-settings.moyenne-m'), l: () => t('search-settings.grande-l'), xl: () => t('search-settings.tres-grande-xl') })
  },
  externalLinksInLittleArc: flag('settings.les-liens-d-autres-apps-s-ouvrent-dans', 'externalLinksInLittleArc'),
  littleArcNewTabLinks: flag('little-arc-settings.liens-nouvel-onglet-en-mini-fenetre', 'littleArcNewTabLinks'),
  blockAds: { label: 'settings.bloquer-les-publicites-et-les-traqueurs', keys: ['blockAds', 'blockTrackers'], read: adsBlockingOn, show: yesNo },
  blockCookieBanners: flag('settings.bloquer-les-bannieres-de-cookies', 'blockCookieBanners'),
  blockMode: { label: 'blocking-settings.mode-de-blocage', keys: ['blockMode'], show: choice({ standard: () => t('blocking-settings.standard'), strict: () => t('blocking-settings.strict') }) },
  blockCosmetic: flag('blocking-settings.masquer-les-encarts-publicitaires-dans-les', 'blockCosmetic'),
  blockScriptlets: flag('guard-settings.scriptlets-et-regles-etendues-du-bloqueur', 'blockScriptlets'),
  sendGpc: flag('privacy-settings.envoyer-le-signal-global-privacy-control', 'sendGpc'),
  stripTrackingParams: flag('privacy-settings.retirer-les-parametres-de-suivi-des-adresses', 'stripTrackingParams'),
  stripCopiedLinks: flag('privacy-extra-settings.retirer-les-parametres-de-suivi-des-liens-copies', 'stripCopiedLinks'),
  reduceFingerprint: flag('guard-settings.protection-contre-l-empreinte-numerique', 'reduceFingerprint'),
  // The row says it in the affirmative (« Garder l’historique… »): the recap reads the setting the same way round.
  historyOff: { label: 'privacy-extra-settings.garder-l-historique-des-pages-visitees', keys: ['historyOff'], read: (settings) => !settings.historyOff, show: yesNo },
  passwordManager: flag('passwords-settings.gestionnaire-de-mots-de-passe', 'passwordManager'),
  downloadAskWhere: flag('download-settings.demander-ou-enregistrer-chaque-fichier', 'downloadAskWhere'),
  tidyDownloads: flag('settings.epurer-les-telechargements', 'tidyDownloads'),
  downloadPause: flag('download-settings.pause-et-reprise-des-telechargements', 'downloadPause'),
  downloadResume: flag('download-settings.reprendre-les-telechargements-apres-un', 'downloadResume'),
  autoBackup: flag('backup-settings.garder-des-copies-automatiques-de-mes-espaces', 'autoBackup'),
  autoBackupMinutes: { label: 'backup-settings.une-copie-au-plus-toutes-les', keys: ['autoBackupMinutes'], show: minutes },
  autoBackupKeep: { label: 'backup-settings.copies-conservees', keys: ['autoBackupKeep'], show: (value) => String(value) },
  webStoreInstall: flag('extension-settings.autoriser-l-installation-d-extensions-depuis-le', 'webStoreInstall'),
  webStoreUpdates: { label: 'extension-settings.mises-a-jour-des-extensions-du-web-store', keys: ['webStoreUpdates'], show: (value) => WEB_STORE_UPDATE_LABELS[value as Settings['webStoreUpdates']] ?? String(value) },
  qrCode: flag('web-tools-settings.code-qr-de-la-page-ou-d-un-lien', 'qrCode'),
  readAloud: flag('web-tools-settings.lecture-a-voix-haute', 'readAloud'),
  pageWatch: flag('web-tools-settings.surveiller-des-pages', 'pageWatch'),
  translateLocal: flag('translate.settings-switch', 'translateLocal'),
  translateSystemEngine: flag('translate.settings-system-switch', 'translateSystemEngine'),
  batterySaver: flag('menu.mode-economie-de-batterie', 'batterySaver'),
  tabContainers: flag('containers-settings.conteneurs-d-onglets', 'tabContainers'),
  guestProfile: flag('guest-settings.proposer-nouvelle-fenetre-invite-dans-le-menu', 'guestProfile'),
  privateTabs: flag('privacy-extra-settings.autoriser-les-onglets-prives-dans-une-fenetre', 'privateTabs')
}

/** The row that shows a setting: the one whose keys hold it. */
export function rowOfKey(key: GuideKey): string | undefined {
  return Object.keys(GUIDE_ROWS).find((row) => GUIDE_ROWS[row]!.keys.includes(key))
}

// ---------- the questions of a flow ----------

/** The questions of a category, or of every category in the order of the window for the complete configuration. */
export function guideQuestionsOf(scope: SettingsPane | 'all'): GuideQuestion[] {
  if (scope !== 'all') return GUIDE_QUESTIONS.filter((question) => question.pane === scope)
  return SETTINGS_PANES.flatMap((pane) => GUIDE_QUESTIONS.filter((question) => question.pane === pane))
}

export const questionById = (id: string): GuideQuestion | undefined => GUIDE_QUESTIONS.find((question) => question.id === id)

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Whether the settings are this answer. */
export function holdsAnswer(answer: GuideAnswer, settings: Settings): boolean {
  if (answer.holds) return answer.holds(settings)
  return (Object.keys(answer.patch) as GuideKey[]).every((key) => same(settings[key], answer.patch[key]))
}

/** The answer the settings already are, preselected; null when they are none of them (« réglage personnalisé »). */
export function answerOf(question: GuideQuestion, settings: Settings): GuideAnswer | null {
  return question.answers.find((answer) => holdsAnswer(answer, settings)) ?? null
}

/** The answers chosen so far, by question: an answer id, or null for « leave it as it is ». A question not visited yet has none. */
export type GuideAnswers = Readonly<Record<string, string | null>>

const chosen = (question: GuideQuestion, answers: GuideAnswers): GuideAnswer | null => {
  const id = answers[question.id]
  return id ? (question.answers.find((answer) => answer.id === id) ?? null) : null
}

/**
 * The questions asked, in order: each one whose `when` holds for the settings as they would be with the answers before it. An answer to a question
 * no longer asked is dropped from the plan.
 */
export function askedQuestions(questions: readonly GuideQuestion[], settings: Settings, answers: GuideAnswers): GuideQuestion[] {
  const asked: GuideQuestion[] = []
  let draft = settings
  for (const question of questions) {
    if (question.when && !question.when(draft)) continue
    asked.push(question)
    const answer = chosen(question, answers)
    if (answer) draft = { ...draft, ...answer.patch }
  }
  return asked
}

/** The answer checked on a question: the one clicked, else the one the settings hold; null when they hold none and nothing was clicked. */
export function checkedOf(question: GuideQuestion, settings: Settings, answers: GuideAnswers): string | null {
  return Object.hasOwn(answers, question.id) ? (answers[question.id] ?? null) : (answerOf(question, settings)?.id ?? null)
}

/**
 * « Suivant »: the answer checked is kept (the preselected one too, which changes nothing), then the next question asked is read from the list as
 * it is with that answer, since an answer can take later questions away (the sleep « Jamais »). `next` is null for « Ce qui va changer ».
 */
export function stepForward(questions: readonly GuideQuestion[], settings: Settings, answers: GuideAnswers, questionId: string): { answers: GuideAnswers; next: number | null } {
  const question = questions.find((candidate) => candidate.id === questionId)
  const kept = question ? { ...answers, [question.id]: checkedOf(question, settings, answers) } : answers
  const asked = askedQuestions(questions, settings, kept)
  const index = asked.findIndex((candidate) => candidate.id === questionId)
  return { answers: kept, next: index >= 0 && index < asked.length - 1 ? index + 1 : null }
}

/** The profiles that set their own value of what a question writes: they keep it, whatever the answer. */
export function profilesKeepingTheirOwn(question: GuideQuestion, settings: Settings): string[] {
  const keys = question.profileKeys ?? []
  if (keys.length === 0) return []
  return Object.entries(settings.profiles)
    .filter(([, own]) => keys.some((key) => own[key] !== undefined))
    .map(([id]) => profileLabel(settings, id))
}

// ---------- « Ce qui va changer » ----------

export interface GuideChange {
  row: string
  label: string
  before: string
  after: string
}

export interface GuidePlanItem {
  question: GuideQuestion
  answer: GuideAnswer
  changes: GuideChange[]
  /** The profiles that keep their own value of it. */
  profiles: string[]
}

export interface GuidePlan {
  /** The questions whose answer changes something, in the order asked. */
  items: GuidePlanItem[]
  /** What « Appliquer » writes: only the settings that change. */
  patch: Partial<Settings>
  /** Their values before, for « Annuler ». */
  undo: Partial<Settings>
  /** How many rows change. */
  count: number
}

/**
 * What the answers change, question by question: the rows whose value moves, before and after, in the words of their row. A question whose
 * answer the settings already hold, or left without an answer, is not listed and writes nothing.
 */
export function guidePlan(questions: readonly GuideQuestion[], settings: Settings, answers: GuideAnswers): GuidePlan {
  const items: GuidePlanItem[] = []
  const patch: Record<string, unknown> = {}
  const undo: Record<string, unknown> = {}
  for (const question of askedQuestions(questions, settings, answers)) {
    const answer = chosen(question, answers)
    if (!answer) continue
    const after: Settings = { ...settings, ...answer.patch }
    const changes: GuideChange[] = []
    const rows = [...new Set((Object.keys(answer.patch) as GuideKey[]).map((key) => rowOfKey(key) ?? key))]
    for (const id of rows) {
      const row = GUIDE_ROWS[id]
      if (!row) continue
      const read = row.read ?? ((s: Settings) => s[row.keys[0]!])
      const [was, will] = [read(settings), read(after)]
      if (same(was, will)) continue
      changes.push({ row: id, label: t(row.label), before: row.show(was), after: row.show(will) })
      for (const key of row.keys) {
        if (!Object.hasOwn(answer.patch, key)) continue
        patch[key] = answer.patch[key]
        undo[key] = settings[key]
      }
    }
    if (changes.length > 0) items.push({ question, answer, changes, profiles: profilesKeepingTheirOwn(question, settings) })
  }
  return { items, patch: patch as Partial<Settings>, undo: undo as Partial<Settings>, count: items.reduce((sum, item) => sum + item.changes.length, 0) }
}

/** What was applied last, kept until the window closes or other answers are applied. */
export interface GuideRecord {
  scope: SettingsPane | 'all'
  patch: Partial<Settings>
  undo: Partial<Settings>
  count: number
}

/**
 * What « Annuler » writes: the previous values of the settings that still hold what the answers gave them. A setting changed by hand since keeps the
 * new value: undoing the answers never undoes a later choice.
 */
export function undoPatch(record: Pick<GuideRecord, 'patch' | 'undo'>, current: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record.undo) as GuideKey[]) {
    if (same(current[key], record.patch[key])) out[key] = record.undo[key]
  }
  return out as Partial<Settings>
}
