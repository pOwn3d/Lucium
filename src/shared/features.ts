// The optional features of Lucium: what a user may reasonably want to switch off, and what each one costs while it is on.
//
// One source of truth: the switch of a feature is an ordinary setting of `Settings` (model.ts), and the setting stays the key. This list only
// describes it (label, group, cost) and links it to the interface: the features to add are listed in « Fonctions en option » with their cost said in
// a sentence (`costSentence`), the others are switched in their category of the Settings (settings-catalog.ts). There is no second set of flags.
// Rule of design: a feature that is off costs nothing (no timer, listener, request, memory or code run at launch). Main-process code that
// has a cost binds itself to its setting through `FeatureGates` (main/shell/feature-gate.ts), which starts it and stops it with the setting.
//
// Adding a feature: add its setting to `Settings` (model.ts, `defaultSettings`, `coerceSettings` in state-clean.ts, state-robustness.test.ts), then
// one entry in FEATURES below, then a line in docs/fonctions.md. features.test.ts fails for a boolean setting that is neither registered here
// nor listed in NOT_OPTIONAL_SETTINGS (with the reason), and for a registered feature that docs/fonctions.md does not mention.

import { adsBlockingOn, adsBlockingPatch } from './blocker'
import { interfaceMayDispatch } from './ipc-policy'
import { defaultSettings, type Settings } from './model'
import { getLanguage, t, type MessageKey } from './i18n'
import { settingsPath } from './settings-path'
import { MIN_FONT_SIZE_ON } from './min-font-size'
import { UNUSED_PERMISSION_DAYS_DEFAULT } from './unused-permissions'

/** What a feature costs while it is active. `none` stands alone: nothing runs for it except a check when its event happens. */
export type FeatureCost = 'none' | 'timer' | 'listeners' | 'network' | 'memory' | 'process' | 'disk'

export type FeatureGroup = 'tabs' | 'privacy' | 'links' | 'data' | 'interface' | 'system'

/** The groups of the pane, in the order it shows them. */
export const FEATURE_GROUPS: ReadonlyArray<{ id: FeatureGroup; label: string }> = [
  { id: 'tabs', get label() { return t('features.onglets-et-pages') } },
  { id: 'privacy', get label() { return t('features.protection') } },
  { id: 'links', get label() { return t('features.liens-et-fenetres') } },
  { id: 'data', get label() { return t('features.donnees-et-sauvegardes') } },
  { id: 'interface', get label() { return t('features.interface') } },
  { id: 'system', get label() { return t('features.application') } }
]

type KeysOf<T> = { [K in keyof Settings]-?: Settings[K] extends T ? K : never }[keyof Settings]
export type BooleanSettingKey = KeysOf<boolean>
export type NumberSettingKey = KeysOf<number>

interface FeatureBase {
  /** Short, lower-case, with dashes: what `gate()` is given and what docs/fonctions.md names. Never changes once published. */
  id: string
  /** As the pane shows it, in the language of the interface: a getter that reads the catalogue (the language is set after this module loads). */
  label: string
  group: FeatureGroup
  /** One line, in the language of the interface (a getter, as `label`): what it does and where its details are set. */
  description: string
  /** What it costs while it is on (see FeatureCost). */
  cost: readonly [FeatureCost, ...FeatureCost[]]
  /** The change only takes effect after the application is restarted: the pane says so. */
  requiresRestart?: true
  /**
   * What the code behind the gate waits for, when that is more than the switch the pane shows. A delay that can also be set per profile has
   * work to do as long as any of them is above 0, though the general one says "never": the gate follows this, the pane follows the setting.
   */
  runsWhen?: (settings: Settings) => boolean
  /**
   * Where to set the feature when the pane cannot do it: the interface is refused a patch that names some settings (the lock's, which only
   * its own handler changes, after the passphrase). The pane then shows the state and this place; the reset button leaves the feature alone.
   */
  setIn?: string
  /**
   * The features this one does nothing without: it has an effect only while at least one of them is on (the extended rules of the blocker
   * apply to the lists of its two options; the user's own lists belong to the ads option). The pane greys the switch of a feature whose
   * needs are all off and says which ones; a feature already on can still be switched off. Ids of FEATURES (features.test.ts checks them).
   */
  needsAnyOf?: readonly string[]
  /**
   * The row names the feature in the affirmative of the opposite: « Garder l’historique » for the feature that records nothing. Its switch shows
   * and writes the opposite of `isFeatureOn`, which keeps the registry's own sense (what costs nothing) for the report, the documents and the gates.
   */
  turnedAround?: true
}

/** The setting is a flag: on is true. */
export interface SwitchFeature extends FeatureBase {
  kind?: 'switch'
  key: BooleanSettingKey
  /**
   * A switch that more than one setting holds (a setting and its alias): how it is read, and what it writes. Absent, `key` alone is the
   * switch. A switch that wrote `key` alone would show "off" while the code that reads the alias goes on working.
   */
  held?: { isOn: (settings: Settings) => boolean; patch: (on: boolean) => Partial<Settings> }
}

/** The setting is a delay or a count where 0 means "never" (sleep, archiving): on is above 0, the switch writes `onValue` (the setting's default when omitted) or 0. */
export interface ThresholdFeature extends FeatureBase {
  kind: 'threshold'
  key: NumberSettingKey
  onValue?: number
}

export type Feature = SwitchFeature | ThresholdFeature

const positive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Archiving has something to do while the general delay or the delay of any profile is above 0 (a profile's own delay wins over the general one). */
export function archiveHasWork(settings: Settings): boolean {
  if (positive(settings.autoArchiveHours)) return true
  const profiles: unknown = settings.profiles
  return typeof profiles === 'object' && profiles !== null && Object.values(profiles).some((own: unknown) => typeof own === 'object' && own !== null && positive((own as { autoArchiveHours?: unknown }).autoArchiveHours))
}

export const FEATURES = [
  // ---- Onglets et pages ----
  {
    id: 'sleep',
    kind: 'threshold',
    key: 'sleepAfterMinutes',
    get label() { return t('settings.mettre-en-veille-les-onglets-inactifs') },
    group: 'tabs',
    get description() { return t('features.libere-la-memoire-d-un-onglet-laisse-de-cote-ou', { settingsPath: settingsPath('sleep') }) },
    cost: ['timer']
  },
  {
    id: 'auto-archive',
    kind: 'threshold',
    key: 'autoArchiveHours',
    get label() { return t('features.archiver-les-onglets-du-jour-inactifs') },
    group: 'tabs',
    get description() { return t('features.range-dans-l-archive-les-onglets-non-epingles') },
    cost: ['timer'],
    runsWhen: archiveHasWork
  },
  {
    id: 'auto-pip',
    key: 'autoPictureInPicture',
    get label() { return t('features.image-dans-l-image-en-quittant-un-onglet-video') },
    group: 'tabs',
    get description() { return t('features.une-video-que-vous-regardez-flotte-dans') },
    cost: ['none']
  },
  {
    id: 'media-player',
    key: 'mediaPlayer',
    get label() { return t('features.lecteur-multimedia-dans-la-barre-laterale') },
    group: 'tabs',
    get description() { return t('features.une-barre-au-pied-de-la-barre-laterale-pilote') },
    cost: ['listeners']
  },
  {
    id: 'tab-state-badges',
    key: 'tabStateBadges',
    get label() { return t('features.etats-visibles-sur-les-onglets') },
    group: 'tabs',
    get description() { return t('features.montre-sur-chaque-rangee-si-la-page-charge-dort') },
    // Classes on the rows and one legend line in the hover card, drawn by CSS from the runtime flags the shell already keeps: no timer, no listener.
    cost: ['none']
  },
  {
    id: 'boosts',
    key: 'boostsEnabled',
    get label() { return t('features.retouches-sur-les-sites-visites') },
    group: 'tabs',
    get description() { return t('features.applique-vos-styles-et-scripts-de-site') },
    cost: ['none']
  },

  // ---- Vie privée et blocage ----
  {
    id: 'block-ads',
    key: 'blockAds',
    // `blockTrackers` is its alias and the blocker reads either (shared/blocker.ts): off is both off.
    held: { isOn: adsBlockingOn, patch: adsBlockingPatch },
    get label() { return t('settings.bloquer-les-publicites-et-les-traqueurs') },
    group: 'privacy',
    get description() { return t('features.filtre-les-requetes-avec-les-listes-easylist') },
    cost: ['network', 'memory', 'listeners']
  },
  {
    id: 'block-cookie-banners',
    key: 'blockCookieBanners',
    get label() { return t('settings.bloquer-les-bannieres-de-cookies') },
    group: 'privacy',
    get description() { return t('settings.bloque-les-plateformes-de-consentement-et') },
    cost: ['network', 'memory', 'listeners']
  },
  {
    id: 'block-scriptlets',
    key: 'blockScriptlets',
    get label() { return t('guard-settings.scriptlets-et-regles-etendues-du-bloqueur') },
    group: 'privacy',
    get description() { return t('features.applique-les-regles-js-redirect-removeparam-et') },
    cost: ['listeners'],
    needsAnyOf: ['block-ads', 'block-cookie-banners']
  },
  {
    id: 'fingerprint',
    key: 'reduceFingerprint',
    get label() { return t('guard-settings.protection-contre-l-empreinte-numerique') },
    group: 'privacy',
    get description() { return t('features.bruit-leger-sur-le-canvas-webgl-et-l-audio-lus', { settingsPath: settingsPath('siteExceptions') }) },
    cost: ['listeners']
  },
  {
    id: 'https-first',
    key: 'httpsUpgrade',
    get label() { return t('features.https-d-abord') },
    group: 'privacy',
    get description() { return t('features.essaie-d-abord-la-version-https-d-une-adresse') },
    cost: ['listeners', 'timer']
  },
  {
    id: 'global-privacy-control',
    key: 'sendGpc',
    get label() { return t('privacy-settings.envoyer-le-signal-global-privacy-control') },
    group: 'privacy',
    get description() { return t('features.ajoute-sec-gpc-1-aux-requetes-pour-dire-aux') },
    cost: ['listeners']
  },
  {
    id: 'third-party-cookies',
    key: 'blockThirdPartyCookies',
    get label() { return t('privacy-settings.bloquer-les-cookies-tiers') },
    group: 'privacy',
    get description() { return t('features.ne-laisse-ni-partir-ni-rester-les-cookies-des', { settingsPath: settingsPath('thirdPartyCookies') }) },
    cost: ['listeners']
  },
  {
    id: 'safe-browsing',
    key: 'safeBrowsing',
    get label() { return t('privacy-settings.prevenir-avant-d-ouvrir-un-site-dangereux') },
    group: 'privacy',
    get description() { return t('features.compare-chaque-page-a-une-liste-de-sites', { settingsPath: settingsPath('safeBrowsing') }) },
    cost: ['listeners', 'memory']
  },
  {
    id: 'block-pings',
    key: 'blockPings',
    get label() { return t('privacy-settings.bloquer-les-pings-de-suivi') },
    group: 'privacy',
    get description() { return t('features.coupe-les-pings-de-suivi') },
    cost: ['listeners']
  },
  {
    id: 'trim-referer',
    key: 'trimReferer',
    get label() { return t('privacy-settings.rogner-le-referer') },
    group: 'privacy',
    get description() { return t('features.ne-donne-que-l-origine-de-la-page', { settingsPath: settingsPath('trimReferer') }) },
    cost: ['listeners']
  },
  {
    id: 'https-only',
    key: 'httpsOnly',
    get label() { return t('privacy-settings.https-seul') },
    group: 'privacy',
    get description() { return t('features.n-ouvre-que-du-https', { settingsPath: settingsPath('httpsOnly') }) },
    cost: ['listeners']
  },
  {
    id: 'typo-guard',
    key: 'typoGuard',
    get label() { return t('privacy-settings.faute-de-frappe-d-adresse') },
    group: 'privacy',
    get description() { return t('features.prevenir-d-une-adresse-qui-ressemble-a-un-site') },
    cost: ['listeners']
  },
  {
    id: 'warn-insecure-form',
    key: 'warnInsecureForm',
    get label() { return t('privacy-settings.mot-de-passe-http') },
    group: 'privacy',
    get description() { return t('features.demande-avant-d-envoyer-un-mot-de-passe-sans-chiffrement') },
    cost: ['listeners']
  },
  {
    id: 'strip-tracking',
    key: 'stripTrackingParams',
    get label() { return t('privacy-settings.retirer-les-parametres-de-suivi-des-adresses') },
    group: 'privacy',
    get description() { return t('features.enleve-utm-fbclid-gclid-des-adresses-avant-de') },
    cost: ['listeners']
  },
  {
    id: 'bypass-redirects',
    key: 'unwrapRedirects',
    get label() { return t('privacy-settings.contourner-les-redirections-de-suivi-et-les-pages-amp') },
    group: 'privacy',
    get description() { return t('features.ouvre-l-adresse-finale-d-un-lien-de-suivi-ou-d-une', { settingsPath: settingsPath('redirectBypass') }) },
    cost: ['listeners']
  },
  {
    id: 'search-suggestions',
    key: 'searchSuggestions',
    get label() { return t('settings-profiles.suggestions-du-moteur-de-recherche') },
    group: 'privacy',
    get description() { return t('features.demande-des-suggestions-au-moteur-de-recherche') },
    cost: ['network']
  },
  {
    id: 'theme-to-sites',
    key: 'allowThemeToSites',
    get label() { return t('features.donner-le-theme-de-l-espace-aux-pages-web') },
    group: 'privacy',
    get description() { return t('features.les-pages-recoivent-la-palette-de-l-espace-en') },
    cost: ['listeners']
  },

  // ---- Liens et fenêtres ----
  {
    id: 'peek-shift',
    key: 'peekWithShift',
    get label() { return t('features.coup-d-oeil-avec-maj-clic-sur-un-lien') },
    group: 'links',
    get description() { return t('features.previsualise-le-lien-dans-un-panneau-plutot-que') },
    cost: ['none']
  },
  {
    id: 'peek-external',
    key: 'peekOnExternalLinks',
    get label() { return t('features.coup-d-oeil-pour-les-liens-vers-d-autres-sites') },
    group: 'links',
    get description() { return t('features.un-lien-vers-un-autre-site-qui-ouvrirait-un-onglet') },
    cost: ['none']
  },
  {
    id: 'external-links-little',
    key: 'externalLinksInLittleArc',
    get label() { return t('features.ouvrir-les-liens-d-autres-applications-dans-une-mini-fenetre') },
    group: 'links',
    get description() { return t('features.un-lien-venu-de-mail-slack-s-ouvre-dans-une') },
    cost: ['none']
  },
  {
    id: 'little-shortcut',
    key: 'littleArcShortcut',
    get label() { return t('features.raccourci-de-la-mini-fenetre-dans-toutes-les-applications') },
    group: 'links',
    get description() { return t('features.le-raccourci-de-nouvelle-mini-fenetre') },
    cost: ['listeners']
  },
  {
    id: 'little-archive',
    kind: 'threshold',
    key: 'littleArcArchiveHours',
    get label() { return t('features.fermer-et-archiver-les-mini-fenetres-oubliees') },
    group: 'links',
    get description() { return t('features.une-mini-fenetre-laissee-ouverte-au-dela') },
    cost: ['timer']
  },
  {
    id: 'little-modifier',
    key: 'littleArcModifier',
    get label() { return t('little-arc-settings.ouvrir-un-lien-dans-une-mini-fenetre-avec-clic') },
    group: 'links',
    get description() { return t('features.un-clic-sur-un-lien-avec-enfoncees-ouvre-une') },
    cost: ['none']
  },
  {
    id: 'little-new-tab-links',
    key: 'littleArcNewTabLinks',
    get label() { return t('little-arc-settings.liens-nouvel-onglet-en-mini-fenetre') },
    group: 'links',
    get description() { return t('features.liens-nouvel-onglet-en-mini-fenetre') },
    cost: ['none']
  },
  {
    id: 'little-download-bubble',
    key: 'littleDownloadBubble',
    get label() { return t('features.bulle-d-actions-apres-un-telechargement-de') },
    group: 'links',
    get description() { return t('features.un-fichier-telecharge-par-une-mini-fenetre') },
    cost: ['timer']
  },

  // ---- Données et sauvegardes ----
  {
    id: 'auto-backup',
    key: 'autoBackup',
    get label() { return t('features.copies-automatiques-de-la-session') },
    group: 'data',
    get description() { return t('features.garde-quelques-copies-datees-des-espaces-et-des', { settingsPath: settingsPath('autoBackup') }) },
    cost: ['timer', 'listeners', 'disk']
  },
  {
    id: 'favicons',
    key: 'resolveFavicons',
    get label() { return t('features.chercher-l-icone-des-sites-sans-icone') },
    group: 'data',
    get description() { return t('features.va-chercher-sans-cookie-l-icone-des-favoris-et') },
    cost: ['network', 'timer', 'listeners', 'memory']
  },
  {
    id: 'tidy-downloads',
    key: 'tidyDownloads',
    get label() { return t('features.epurer-le-nom-des-telechargements') },
    group: 'data',
    get description() { return t('settings.nettoie-le-nom-des-fichiers-telecharges') },
    cost: ['none']
  },
  {
    id: 'native-hosts',
    key: 'chromeNativeHosts',
    get label() { return t('features.hotes-de-messagerie-native-d-un-autre-navigateur') },
    group: 'data',
    get description() { return t('features.permet-a-une-extension-de-joindre-l-application') },
    cost: ['process']
  },

  // ---- Interface ----
  {
    id: 'hover-cards',
    key: 'hoverCards',
    get label() { return t('features.apercus-au-survol-des-onglets') },
    group: 'interface',
    get description() { return t('features.une-carte-montre-le-titre-l-adresse-et-une') },
    // The pictures of the pages are also what the tab overview shows: they are taken while either of the two is on.
    runsWhen: (settings) => settings.hoverCards || settings.tabGrid,
    cost: ['timer', 'listeners', 'memory']
  },
  {
    id: 'tidy-pinned-titles',
    key: 'tidyPinnedTitles',
    get label() { return t('settings.epurer-les-titres-des-onglets-epingles') },
    group: 'interface',
    get description() { return t('settings.un-onglet-epingle-affiche-le-nom-du-site') },
    cost: ['none']
  },
  {
    id: 'reload-all-button',
    key: 'showReloadAllButton',
    get label() { return t('features.bouton-actualiser-tous-les-onglets') },
    group: 'interface',
    get description() { return t('features.ajoute-le-bouton-dans-l-en-tete-de-la-barre') },
    cost: ['none']
  },
  {
    id: 'full-url',
    key: 'fullUrlInToolbar',
    get label() { return t('features.adresse-complete-dans-la-barre-d-outils') },
    group: 'interface',
    get description() { return t('features.affiche-toute-l-adresse-plutot-que-le-nom-du') },
    cost: ['none']
  },
  {
    id: 'window-drag',
    key: 'dragWindowFromToolbar',
    get label() { return t('features.deplacer-la-fenetre-depuis-le-haut-des-pages') },
    group: 'interface',
    get description() { return t('features.la-fenetre-se-deplace-en-tirant-la-barre-d') },
    cost: ['none']
  },

  // ---- Application ----
  {
    id: 'auto-update',
    key: 'autoUpdate',
    get label() { return t('features.rechercher-les-mises-a-jour-automatiquement') },
    group: 'system',
    get description() { return t('features.lit-le-fichier-des-versions-a-l-adresse-des-mises-a-jour') },
    cost: ['network', 'timer']
  },
  {
    // The same look, for Windows alone (shared/platform.ts, `autoUpdateKey`): its own switch, off by default for everyone. The application gates this one on Windows and
    // `auto-update` everywhere else, so the one that is not the system's commands nothing.
    id: 'auto-update-windows',
    key: 'windowsAutoUpdate',
    get label() { return t('features.rechercher-les-mises-a-jour-automatiquement-windows') },
    group: 'system',
    get description() { return t('features.lit-le-fichier-des-versions-signe-de-windows') },
    cost: ['network', 'timer']
  },
  {
    id: 'warn-quit',
    key: 'warnBeforeQuitting',
    get label() { return t('settings.avertir-avant-de-quitter') },
    group: 'system',
    get description() { return t('features.demande-une-confirmation-avant-q') },
    cost: ['none']
  },
  {
    id: 'restore-windows',
    key: 'restoreWindows',
    get label() { return t('features.rouvrir-les-fenetres-de-la-session-precedente') },
    group: 'system',
    get description() { return t('features.au-lancement-les-fenetres-reviennent-ou-elles') },
    cost: ['listeners', 'disk']
  },
  // ---- Série 2 (inscrites à l'intégration : leur coût nul, coupées, est à vérifier au test global) ----
  {
    id: 'sidebar-right',
    key: 'sidebarRight',
    get label() { return t('features.barre-laterale-a-droite') },
    group: 'interface',
    get description() { return t('features.place-la-barre-laterale-a-droite-de-la-fenetre') },
    cost: ['none']
  },
  {
    id: 'web-panels',
    key: 'webPanels',
    get label() { return t('menu.volets-web') },
    group: 'tabs',
    get description() { return t('features.un-site-a-cote-de-la-page-depuis-une-liste-par') },
    cost: ['process', 'network']
  },
  {
    id: 'screen-share',
    key: 'allowScreenShare',
    get label() { return t('features.partage-d-ecran-ou-de-fenetre') },
    group: 'privacy',
    get description() { return t('features.autorise-la-demande-de-partage-d-une-page-web') },
    cost: ['none']
  },
  {
    id: 'tab-memory',
    key: 'showTabMemory',
    get label() { return t('features.memoire-et-processeur-par-onglet') },
    group: 'interface',
    get description() { return t('features.affiche-la-memoire-et-le-processeur-d-un-onglet') },
    // Nothing is launched: the card measures the page's process (app.getAppMetrics) every 3 s while it is open, and never otherwise.
    cost: ['timer']
  },
  {
    id: 'download-status-chip',
    key: 'downloadStatusChip',
    get label() { return t('features.statut-des-telechargements-au-pied-de-la-barre') },
    group: 'interface',
    get description() { return t('features.montre-l-avancement-d-un-telechargement-au-pied') },
    // Read from the downloads the snapshot already carries; the only timer is the 6 s of the bubble, armed after a download ends.
    cost: ['timer']
  },
  {
    id: 'favorite-names',
    key: 'favoriteNames',
    get label() { return t('features.nom-sous-les-icones-des-favoris') },
    group: 'interface',
    get description() { return t('features.affiche-le-nom-court-de-chaque-favori-sous-son') },
    cost: ['none']
  },
  {
    id: 'resource-gauge',
    key: 'resourceGauge',
    get label() { return t('features.jauge-des-ressources-au-pied-de-la-barre') },
    group: 'interface',
    get description() { return t('features.un-anneau-montre-la-part-de-la-memoire-du-mac') },
    // The ring is read at the beat of the sleep sweep (app.getAppMetrics, and sysctl for the pressure of macOS); the 2 s refresh exists only while its panel is open.
    cost: ['timer', 'process']
  },
  {
    id: 'boost-sharing',
    key: 'boostSharing',
    get label() { return t('features.partage-de-retouches-et-de-themes') },
    group: 'links',
    get description() { return t('features.fichiers-lucium-boost-et-lucium-theme-et') },
    cost: ['none']
  },
  {
    id: 'web-store',
    key: 'webStoreInstall',
    get label() { return t('features.installer-depuis-le-chrome-web-store') },
    group: 'system',
    get description() { return t('features.active-le-bouton-d-installation-des-fiches-du-store') },
    cost: ['network', 'listeners']
  },
  {
    id: 'strip-copied-links',
    key: 'stripCopiedLinks',
    get label() { return t('privacy-extra-settings.retirer-les-parametres-de-suivi-des-liens-copies') },
    group: 'privacy',
    get description() { return t('features.les-liens-copies-c-menus-perdent-utm-fbclid-et') },
    cost: ['none']
  },
  {
    // Named as its row says it, in the affirmative (« Garder l’historique des pages visitées », on while the history is kept). The registry keeps its
    // own sense: the feature is on while nothing is recorded (`historyOff`), which is what costs nothing; its id and its setting do not change.
    // Its switch is turned around, so that it shows what its label says.
    id: 'history-off',
    key: 'historyOff',
    turnedAround: true,
    get label() { return t('privacy-extra-settings.garder-l-historique-des-pages-visitees') },
    group: 'privacy',
    get description() { return t('features.plus-aucune-page-n-est-ajoutee-a-l-historique') },
    cost: ['none']
  },
  {
    id: 'doh',
    key: 'dohCustom',
    get label() { return t('features.dns-chiffre-personnalise') },
    group: 'privacy',
    get description() { return t('features.choisit-le-serveur-dns-sur-https-liste-fixe') },
    cost: ['network']
  },
  {
    id: 'proxy',
    key: 'proxyEnabled',
    get label() { return t('features.proxy-http-ou-socks') },
    group: 'privacy',
    get description() { return t('features.fait-passer-les-requetes-par-un-proxy-aussi-par') },
    cost: ['network']
  },
  {
    id: 'cookie-manager',
    key: 'cookieManager',
    get label() { return t('cmd.cookies-par-site') },
    group: 'privacy',
    get description() { return t('features.panneau-qui-liste-supprime-et-garde-les-cookies') },
    cost: ['none']
  },
  {
    id: 'private-tabs',
    key: 'privateTabs',
    get label() { return t('features.onglets-prives-dans-une-fenetre-normale') },
    group: 'privacy',
    get description() { return t('features.un-onglet-dont-la-session-reste-en-memoire-et') },
    cost: ['memory']
  },
  {
    id: 'guest-profile',
    key: 'guestProfile',
    get label() { return t('guest-settings.profil-invite') },
    group: 'privacy',
    get description() { return t('features.fichier-nouvelle-fenetre-invite-une-fenetre-sans') },
    cost: ['memory']
  },
  {
    id: 'clear-on-close',
    key: 'siteDataClearOnCloseEnabled',
    get label() { return t('features.effacer-les-donnees-d-un-site-a-la-fermeture') },
    group: 'privacy',
    get description() { return t('features.efface-les-donnees-des-sites-listes-quand-leur') },
    cost: ['listeners']
  },
  {
    id: 'custom-filter-lists',
    key: 'customFilterListsEnabled',
    get label() { return t('features.listes-de-blocage-personnalisees') },
    group: 'privacy',
    get description() { return t('features.ajoute-vos-propres-listes-au-bloqueur-fichier') },
    cost: ['disk', 'memory'],
    needsAnyOf: ['block-ads']
  },
  {
    id: 'lock',
    key: 'lockEnabled',
    get label() { return t('features.verrouillage-de-l-application-et-des-espaces') },
    group: 'privacy',
    get description() { return t('features.une-phrase-et-touch-id-verrouille-l-interface') },
    cost: ['listeners'],
    get setIn() { return settingsPath('lock') }
  },
  {
    id: 'password-manager',
    key: 'passwordManager',
    get label() { return t('passwords-settings.gestionnaire-de-mots-de-passe') },
    group: 'privacy',
    get description() { return t('features.un-coffre-local-chiffre-rempli-sur-demande') },
    cost: ['listeners', 'disk', 'timer']
  },
  {
    id: 'reopen-history',
    key: 'reopenHistory',
    get label() { return t('settings.rouvrir-un-onglet-archive-avec-ses-pages') },
    group: 'tabs',
    get description() { return t('features.garde-jusqu-a-20-pages-d-historique-par-onglet') },
    cost: ['memory']
  },
  {
    id: 'extension-overflow',
    key: 'extensionOverflow',
    get label() { return t('features.menu-des-icones-d-extensions') },
    group: 'interface',
    get description() { return t('features.range-dans-un-menu-les-icones-qui-ne-tiennent') },
    cost: ['listeners']
  },
  {
    id: 'extension-data-apis',
    key: 'extensionDataApis',
    get label() { return t('features.historique-favoris-et-effacement-pour-les') },
    group: 'tabs',
    get description() { return t('features.chrome-history-chrome-bookmarks-lecture-seule') },
    cost: ['none']
  },
  {
    id: 'extension-tab-capture',
    key: 'extensionTabCapture',
    get label() { return t('settings.autoriser-les-extensions-a-capter-le-son-d-un-onglet') },
    group: 'tabs',
    get description() { return t('features.les-extensions-qui-le-declarent-captent-le-son-d-un-onglet') },
    cost: ['none']
  },
  {
    id: 'user-scripts',
    key: 'userScripts',
    get label() { return t('user-scripts-settings.scripts-utilisateur') },
    group: 'tabs',
    get description() { return t('features.execute-des-scripts-user-js-que-vous-avez') },
    cost: ['memory']
  },
  {
    id: 'qr-code',
    key: 'qrCode',
    get label() { return t('features.code-qr-d-une-page-ou-d-un-lien') },
    group: 'links',
    get description() { return t('features.entrees-code-qr-dans-fichier-et-dans-le-menu-d') },
    cost: ['none']
  },
  {
    id: 'auto-scroll',
    key: 'autoScroll',
    get label() { return t('features.defilement-automatique-au-clic-du-milieu') },
    group: 'tabs',
    get description() { return t('features.le-clic-du-milieu-sur-une-page-lance-un') },
    cost: ['listeners']
  },
  {
    id: 'scroll-sync',
    key: 'scrollSync',
    get label() { return t('menu.defilement-synchronise-des-volets') },
    group: 'tabs',
    get description() { return t('features.les-volets-d-une-vue-scindee-defilent-ensemble') },
    cost: ['listeners']
  },
  {
    id: 'remember-scroll',
    key: 'rememberScroll',
    get label() { return t('features.retrouver-la-position-de-defilement-des-onglets') },
    group: 'tabs',
    get description() { return t('features.un-onglet-revient-la-ou-sa-page-etait-defilee') },
    // A script in each page (one scroll listener, one timer armed after a scroll) and a small file written a few seconds after a change.
    cost: ['listeners', 'timer', 'disk']
  },
  {
    id: 'work-views',
    key: 'workViewsEnabled',
    get label() { return t('features.vues-de-travail') },
    group: 'tabs',
    get description() { return t('features.une-tuile-apres-les-favoris-ouvre-en-un-clic') },
    cost: ['none']
  },
  {
    id: 'mouse-gestures',
    key: 'mouseGestures',
    get label() { return t('web-tools-settings.gestes-de-souris') },
    group: 'tabs',
    get description() { return t('features.un-geste-du-bouton-droit-arriere-avant-fermer') },
    cost: ['listeners']
  },
  {
    id: 'space-swipe',
    key: 'spaceSwipe',
    get label() { return t('settings.balayer-pour-changer-d-espace') },
    group: 'tabs',
    get description() { return t('features.deux-doigts-en-travers-de-la-liste-des-onglets', { settingsPath: settingsPath('trackpad') }) },
    cost: ['listeners']
  },
  {
    // Off by default (0): the history is kept until the person forgets it. On, a timer looks once an hour for the pages older than the delay.
    id: 'history-purge',
    kind: 'threshold',
    key: 'historyKeepDays',
    onValue: 30,
    get label() { return t('features.garder-l-historique-seulement-un-temps') },
    group: 'privacy',
    get description() { return t('features.oublie-les-pages-visitees-il-y-a-plus-de') },
    cost: ['timer']
  },
  {
    id: 'page-content-index',
    key: 'pageContentIndex',
    get label() { return t('features.recherche-dans-le-contenu-des-pages-visitees') },
    group: 'privacy',
    get description() { return t('features.garde-en-local-le-texte-des-pages-lues-pour') },
    cost: ['disk', 'listeners']
  },
  {
    id: 'page-watch',
    key: 'pageWatch',
    get label() { return t('web-tools-settings.surveiller-des-pages') },
    group: 'tabs',
    get description() { return t('features.relit-des-pages-de-temps-en-temps-10-au-plus-et') },
    cost: ['timer', 'network', 'process']
  },
  {
    id: 'focus-mode',
    key: 'focusMode',
    get label() { return t('focus.label') },
    group: 'tabs',
    get description() { return t('focus.description', { settingsPath: settingsPath('focusSites') }) },
    // While it is on, the request filter hears each request: one check of the address against a short list, only for the main frame of a page.
    cost: ['listeners']
  },
  {
    id: 'read-aloud',
    key: 'readAloud',
    get label() { return t('web-tools-settings.lecture-a-voix-haute') },
    group: 'tabs',
    get description() { return t('features.boutons-de-lecture-dans-le-mode-lecture-et-lire') },
    cost: ['none']
  },
  {
    id: 'battery-saver',
    key: 'batterySaver',
    get label() { return t('menu.mode-economie-de-batterie') },
    group: 'system',
    get description() { return t('features.moins-d-activite-en-arriere-plan-a-20-de') },
    cost: ['listeners', 'timer']
  },
  {
    id: 'download-pause',
    key: 'downloadPause',
    get label() { return t('download-settings.pause-et-reprise-des-telechargements') },
    group: 'data',
    get description() { return t('features.bouton-pause-reprise-dans-le-popover-des') },
    cost: ['none']
  },
  {
    id: 'download-resume',
    key: 'downloadResume',
    get label() { return t('download-settings.reprendre-les-telechargements-apres-un') },
    group: 'data',
    get description() { return t('features.garde-dans-un-fichier-prive-l-adresse-et-le') },
    cost: ['disk', 'network'],
    requiresRestart: true
  },
  {
    id: 'download-ask-where',
    key: 'downloadAskWhere',
    get label() { return t('download-settings.demander-ou-enregistrer-chaque-fichier') },
    group: 'data',
    get description() { return t('features.le-fichier-attend-dans-un-dossier-temporaire') },
    cost: ['disk']
  },
  {
    id: 'warn-executable-download',
    key: 'warnExecutableDownload',
    get label() { return t('download-settings.prevenir-avant-un-fichier-executable') },
    group: 'data',
    get description() { return t('features.demande-avant-d-enregistrer-un-fichier-qui-peut') },
    cost: ['none']
  },
  {
    id: 'open-with',
    key: 'openWithMemory',
    get label() { return t('features.memoriser-l-application-d-ouverture-par-type') },
    group: 'data',
    get description() { return t('features.ouvrir-avec-retient-l-application-choisie-pour') },
    cost: ['process']
  },
  {
    id: 'open-unsaved',
    key: 'openUnsaved',
    get label() { return t('engine.ouvrir-sans-l-enregistrer') },
    group: 'data',
    get description() { return t('features.entree-du-menu-d-un-lien-le-fichier-va-dans-un') },
    cost: ['disk']
  },
  {
    id: 'pdf-with-source',
    key: 'pdfWithSource',
    get label() { return t('features.enregistrer-en-pdf-avec-l-adresse') },
    group: 'data',
    get description() { return t('features.fichier-enregistrer-en-pdf-avec-l-adresse') },
    cost: ['none']
  },
  {
    id: 'read-later-folders',
    key: 'useReadLaterFolders',
    get label() { return t('features.dossiers-dans-lire-plus-tard') },
    group: 'interface',
    get description() { return t('features.range-la-liste-lire-plus-tard-dans-des-dossiers') },
    cost: ['memory']
  },
  {
    id: 'card-outline',
    key: 'cardOutline',
    get label() { return t('appearance-settings.contour-fin-autour-de-la-page') },
    group: 'interface',
    get description() { return t('features.dessine-un-filet-autour-de-la-carte-de-la-page') },
    cost: ['none']
  },
  {
    id: 'back-closes-tab',
    key: 'backClosesOpenedTab',
    get label() { return t('features.precedent-ferme-l-onglet-ouvert-depuis-un-lien') },
    group: 'links',
    get description() { return t('features.retour-sur-la-premiere-page-d-un-onglet-ouvert') },
    cost: ['none']
  },
  {
    id: 'tab-cycle-recent',
    key: 'tabCycleRecent',
    get label() { return t('features.tab-dans-l-ordre-d-utilisation-recente') },
    group: 'tabs',
    get description() { return t('features.panneau-de-vignettes-tenu-tant-que-est-enfonce') },
    cost: ['listeners']
  },
  {
    id: 'drag-to-split',
    key: 'dragToSplit',
    get label() { return t('features.glisser-un-onglet-sur-la-page-pour-scinder') },
    group: 'tabs',
    get description() { return t('features.glisser-un-onglet-de-la-barre-laterale-sur-la') },
    cost: ['none']
  },
  {
    id: 'warn-close-window',
    key: 'warnBeforeClosingWindow',
    get label() { return t('settings.avertir-avant-de-fermer-une-fenetre-de') },
    group: 'system',
    get description() { return t('features.demande-une-confirmation-avant-de-fermer-une') },
    cost: ['listeners']
  },
  {
    id: 'zoom-indicator',
    key: 'showZoomIndicator',
    get label() { return t('features.repere-du-niveau-de-zoom') },
    group: 'interface',
    get description() { return t('features.affiche-125-dans-la-barre-d-outils-quand-la') },
    cost: ['none']
  },
  {
    id: 'minimum-font-size',
    kind: 'threshold',
    key: 'minimumFontSize',
    onValue: MIN_FONT_SIZE_ON,
    get label() { return t('features.taille-minimale-du-texte-des-pages') },
    group: 'interface',
    get description() { return t('features.aucun-texte-de-page-n-est-dessine-plus-petit', { settingsPath: settingsPath('minimumFontSize') }) },
    cost: ['none']
  },
  {
    id: 'name-windows',
    key: 'nameWindows',
    get label() { return t('features.nommer-les-fenetres') },
    group: 'interface',
    get description() { return t('features.donne-un-nom-aux-fenetres-menu-fichier-le-menu') },
    cost: ['none']
  },
  {
    id: 'search-bangs',
    key: 'searchBangs',
    get label() { return t('features.mots-cles-dans-la-barre-de-commandes') },
    group: 'links',
    get description() { return t('features.w-mot-mot-w-w-une-recherche-dans-un-site-connu') },
    cost: ['none']
  },
  {
    id: 'search-discovery',
    key: 'searchDiscovery',
    get label() { return t('settings-profiles.proposer-d-ajouter-la-recherche-d-un-site') },
    group: 'links',
    get description() { return t('features.repere-le-moteur-declare-par-un-site-et-propose') },
    cost: ['memory', 'network']
  },
  {
    id: 'interface-language',
    key: 'interfaceTranslated',
    get label() { return t('features.interface-traduite') },
    group: 'interface',
    get description() { return t('features.affiche-les-menus-la-barre-laterale-la-barre-d', { settingsPath: settingsPath('language') }) },
    cost: ['none']
  },
  {
    id: 'translate-local',
    key: 'translateLocal',
    get label() { return t('features.traduire-une-page-sur-cet-ordinateur') },
    group: 'interface',
    get description() { return t('features.ajoute-traduire-cette-page-au-menu-fichier-le', { settingsPath: settingsPath('translate') }) },
    // `listeners`: the language of each loaded document is read for the page menu; `process`: the helper of macOS's translation and the Bergamot worker.
    cost: ['memory', 'network', 'listeners', 'process']
  },
  {
    id: 'command-bar-calc',
    key: 'commandBarCalc',
    get label() { return t('features.calculatrice-dans-la-barre-de-commandes') },
    group: 'interface',
    get description() { return t('features.12-3-4-affiche-84-en-tete-de-liste-entree') },
    cost: ['none']
  },
  {
    id: 'tab-search',
    key: 'tabSearch',
    get label() { return t('features.recherche-d-onglets') },
    group: 'tabs',
    get description() { return t('features.la-barre-de-commandes-en-mode-onglets-sur-tous-les') },
    cost: ['none']
  },
  {
    id: 'tab-grid',
    key: 'tabGrid',
    get label() { return t('features.vue-d-ensemble-des-onglets') },
    group: 'tabs',
    get description() { return t('features.tous-les-onglets-en-grille-de-vignettes-avec-recherche') },
    cost: ['memory']
  },
  {
    id: 'shortcut-help',
    key: 'shortcutHelp',
    get label() { return t('features.aide-des-raccourcis') },
    group: 'interface',
    get description() { return t('features.une-feuille-qui-liste-les-raccourcis-par-contexte') },
    cost: ['none']
  },
  {
    id: 'vim-keys',
    key: 'vimKeys',
    get label() { return t('key-ext-settings.navigation-au-clavier-de-type-vim') },
    group: 'tabs',
    get description() { return t('features.j-k-d-u-gg-g-font-defiler-f-repere-les-liens') },
    cost: ['listeners']
  },
  {
    id: 'tab-groups-ext',
    key: 'tabGroupFolders',
    get label() { return t('features.groupes-d-onglets-des-extensions-dans-la-barre') },
    group: 'tabs',
    get description() { return t('features.un-groupe-cree-par-une-extension-chrome') },
    cost: ['memory']
  },
  {
    id: 'omnibox-keywords',
    key: 'omniboxKeywords',
    get label() { return t('key-ext-settings.mots-cles-d-extension-dans-la-barre-de-commandes') },
    group: 'links',
    get description() { return t('features.le-mot-cle-d-une-extension-chrome-omnibox-un') },
    cost: ['none']
  },
  {
    id: 'find-regex',
    key: 'findRegex',
    get label() { return t('features.recherche-par-expression-reguliere') },
    group: 'tabs',
    get description() { return t('features.bouton-dans-la-recherche-dans-la-page-l') },
    cost: ['process']
  },
  {
    id: 'compact-mode',
    key: 'compactMode',
    get label() { return t('features.mode-compact') },
    group: 'interface',
    get description() { return t('features.une-commande-affichage-barre-de-commandes') },
    cost: ['none']
  },
  {
    id: 'tab-tree',
    key: 'tabTree',
    get label() { return t('features.arbre-d-onglets') },
    group: 'tabs',
    get description() { return t('features.un-onglet-ouvert-depuis-un-lien-se-range-sous') },
    cost: ['none']
  },
  {
    id: 'web-hardware',
    key: 'webHardware',
    get label() { return t('features.api-materielles-du-web-webhid-webusb-web-serial') },
    group: 'privacy',
    get description() { return t('features.un-site-securise-peut-apres-un-clic-demander-a', { settingsPath: settingsPath('webHardware') }) },
    cost: ['listeners']
  },
  {
    id: 'forget-unused-permissions',
    kind: 'threshold',
    key: 'forgetUnusedPermissionsDays',
    onValue: UNUSED_PERMISSION_DAYS_DEFAULT,
    get label() { return t('features.oublier-les-autorisations-des-sites-non-visites') },
    group: 'privacy',
    get description() { return t('features.un-site-que-vous-n-avez-pas-visite-depuis-le-delai-choisi-perd', { settingsPath: settingsPath('forgetUnusedPermissions') }) },
    // One pass at launch and one a day, in the main window only; the table of visits is written once a day per site at most.
    cost: ['timer']
  },
  {
    id: 'annotate-capture',
    key: 'annotateCapture',
    get label() { return t('features.annoter-les-captures-avant-de-les-enregistrer') },
    group: 'interface',
    get description() { return t('features.apres-une-capture-une-feuille-permet-de') },
    cost: ['memory']
  },
  {
    id: 'applescript',
    key: 'urlAutomation',
    get label() { return t('features.commandes-par-adresse-lucium-applescript') },
    group: 'system',
    get description() { return t('features.accepte-lucium-open-url-lucium-new-tab-et') },
    cost: ['none']
  },
  {
    id: 'containers',
    key: 'tabContainers',
    get label() { return t('containers-settings.conteneurs-d-onglets') },
    group: 'tabs',
    get description() { return t('features.un-onglet-peut-vivre-dans-une-identite-a-part') },
    cost: ['memory', 'disk']
  },
  {
    id: 'independent-windows',
    key: 'independentWindows',
    get label() { return t('features.fenetres-aux-onglets-independants') },
    group: 'links',
    get description() { return t('features.une-fenetre-ouverte-apres-la-premiere-montre') },
    cost: ['none']
  },
  {
    id: 'tab-reminders',
    key: 'tabReminders',
    get label() { return t('features.rappel-d-onglet') },
    group: 'tabs',
    get description() { return t('features.un-onglet-quitte-la-colonne-et-revient-a-l') },
    // One timer, armed for the earliest pending reminder only: none while nothing waits (main/shell/tab-reminders.ts).
    cost: ['timer']
  },
  {
    id: 'bookmarks',
    key: 'bookmarkManager',
    get label() { return t('features.bibliotheque-de-signets-avec-etiquettes') },
    group: 'data',
    get description() { return t('features.un-panneau-de-signets-recherche-etiquettes') },
    cost: ['none']
  },
  {
    id: 'notes',
    key: 'notes',
    get label() { return t('features.notes-rapides') },
    group: 'data',
    get description() { return t('features.des-notes-courtes-gardees-sur-ce-mac-liees-a') },
    // notes.json is read and written on a request of the panel only; nothing stays in memory between two, and nothing runs (notes-ipc.test.ts).
    cost: ['disk']
  },
  {
    id: 'live-folders',
    key: 'liveFolders',
    get label() { return t('features.dossiers-en-direct-flux-rss-depots-github') },
    group: 'tabs',
    get description() { return t('features.un-dossier-de-la-barre-laterale-se-remplit-des') },
    cost: ['timer', 'network', 'memory']
  },
  {
    id: 'whats-new',
    key: 'whatsNewSheet',
    get label() { return t('features.nouveautes-apres-une-mise-a-jour') },
    group: 'system',
    get description() { return t('features.une-feuille-liste-ce-qui-a-change-au-premier') },
    // One comparison of two version numbers at launch and one read of the changelog shipped in the bundle, once per version; no request. Off: neither is done.
    cost: ['none']
  },
  {
    id: 'pwa',
    key: 'webAppWindows',
    get label() { return t('features.ouvrir-un-site-comme-application') },
    group: 'links',
    get description() { return t('features.un-site-dans-une-fenetre-sans-barre-laterale') },
    cost: ['listeners']
  },
  {
    id: 'document-pip',
    key: 'documentPictureInPicture',
    get label() { return t('features.image-dans-l-image-des-appels-video') },
    group: 'links',
    get description() { return t('features.un-site-de-visioconference-peut-ouvrir') },
    // A check when a page asks for the window. Once a tab has had one, its page keeps our listener in the place of Electron's internal one, which
    // forwards everything else; an open window listens to its page (engine/document-pip-windows.ts). Off, nothing is installed and nothing is checked.
    cost: ['listeners']
  }
] as const satisfies readonly Feature[]

/** A feature as registered: its `id` is the literal one, so that `gate('typo')` does not compile. */
export type RegisteredFeature = (typeof FEATURES)[number]
export type FeatureId = RegisteredFeature['id']

/**
 * Boolean settings that are not features, with the reason. A new boolean setting must be registered in FEATURES or listed here: the
 * test of features.test.ts fails otherwise, so that no function is added without its switch being thought about.
 */
// `blockTrackers` is named beside the boolean keys: it is typed optional (a state file of an older version may not carry it), so the keys of
// the plain booleans do not hold it.
export const NOT_OPTIONAL_SETTINGS: Partial<Record<BooleanSettingKey | 'blockTrackers', string>> = {
  sitePictureInPictureInLucium: 'option de l’image dans l’image (`media-player`, `auto-pip`) : le bouton du site ouvre la fenêtre flottante de Lucium plutôt que celle du système ; un test quand le pont multimédia entend le bouton, rien ne tourne de plus ni de moins, et sans le pont (fonction `media-player` coupée) le bouton garde la fenêtre du système',
  translateSystemEngine: 'option de la traduction locale (`translate-local`) : choisit si macOS traduit d’abord les paires installées, sans rien coûter de plus ; coupée, la fonction passe par Bergamot ou un glossaire',
  translateSystemNoticeSeen: 'mémoire de l’avis de la traduction de macOS déjà donné (Apple peut compter son usage), pas une fonction : il ne paraît qu’une fois, la première fois que macOS traduit une page en un clic',
  aiSummary: 'sous-réglage du résumé de page (Réglages › IA) : l’entrée de menu et le résumé s’éteignent avec lui, sans fonction propre',
  annotateGlobalShortcut: 'option de l’annotation de la page : ⌥⌘M tenu pour tout le système au lieu du seul menu Fichier ; coupée par défaut, rien n’est tenu hors de Lucium',
  annotateAutoClear: 'option de l’annotation de la page : les traits d’une page s’effacent seuls après quelques secondes sans activité ; coupée par défaut, aucun minuteur ne tourne, et allumée, un minuteur par page annotée tant qu’elle a des traits',
  annotateLetterKeys: 'option de l’annotation de la page : les touches d’une seule lettre (les outils, E, X) agissent ; allumée par défaut, comme avant ; coupée, la barre n’en nomme aucune et la page garde ses lettres, sans que rien ne tourne de plus ou de moins',
  spaceImages: "deprecated: the picture of a space is now chosen in « Personnaliser l'espace » (Émoji / Lettre / Image); the key stays so that an older state file loads",
  reloadAllWakes: 'option de la commande « Actualiser tous les onglets » (menu Affichage, raccourci, barre de commande) : les boutons de la barre latérale réveillent toujours les onglets en veille ; sans effet seule',
  notesListButton: 'option des notes rapides (`notes`) : le bouton « Toutes les notes » de la barre d’outils, qui ouvre le panneau sur « Toutes » même quand la page affichée a des notes (Fichier › Notes, ⇧⌘E, l’ouvre sur celles de la page quand elle en a) ; sans effet quand les notes sont coupées, absent d’une fenêtre privée',
  readableToolbarButton: 'option du contraste de la page (réglages `readableMode`, `siteReadableMode`) : le bouton « Contraste de la page » de la barre d’outils, qui montre le mode du site affiché et ouvre le menu qui le change ; absent d’une page qui n’est pas web, d’un PDF, d’un onglet privé et d’une fenêtre privée',
  autoplayPerSite: 'deprecated: « Un réglage pour chaque site » of the autoplay is gone, the choice of a site always applies and the site panel always offers it; nothing reads the key, which stays so that an older state file loads',
  siteDataClearOnQuit: 'option de « Effacer les données d’un site à la fermeture » (clear-on-close)',
  siteDataClearOnQuitAll: 'option de « Effacer les données d’un site à la fermeture » (clear-on-close) : tous les sites à la fermeture de Lucium',
  lockApp: 'option du verrouillage (lock) : verrouille aussi au lancement et à la sortie de veille',
  passwordTouchIdOnFill: 'option du gestionnaire de mots de passe (`password-manager`) : la phrase ou l’empreinte du trousseau est redemandée avant chaque remplissage ; éteinte par défaut, rien ne tourne de plus ou de moins ; sans effet quand le gestionnaire est coupé',
  lockTouchId: 'option du verrouillage (lock) : Touch ID quand il est disponible',
  modifiedClickBackground: 'mode d’ouverture des liens (⌘-clic, clic du milieu), pas une fonction : le réglage choisit seulement si l’onglet s’ouvre au premier plan',
  blankLinkBackground: 'mode d’ouverture des liens (target="_blank"), pas une fonction : le réglage choisit seulement si l’onglet s’ouvre au premier plan',
  suggestHistory: 'source des propositions de la barre de commandes : l’historique',
  suggestTabs: 'source des propositions de la barre de commandes : les onglets',
  suggestArchive: 'source des propositions de la barre de commandes : l’archive',
  suggestReadLater: 'source des propositions de la barre de commandes : Lire plus tard',
  goToOpenTab: 'mode de la barre de commandes ouverte pour un nouvel onglet (Entrée ouvre un onglet, ou va à celui qui est déjà ouvert), pas une fonction : un test au moment du classement des propositions',
  sidebarVisible: 'état d’affichage de la fenêtre (menu Affichage), pas une fonction',
  showToolbar: 'état d’affichage de la fenêtre (menu Affichage › Masquer la barre d’outils), pas une fonction',
  showAdvancedSettings: 'ancien niveau de la fenêtre Réglages (Essentiel / Tous les réglages), retiré, pas une fonction : plus rien ne le lit, la clé reste pour qu’un ancien fichier d’état se charge',
  suggestionsNoticeSeen: 'mémoire d’une note déjà lue, pas une fonction',
  firstLaunchDone: 'mémoire de la feuille de premier lancement déjà montrée, pas une fonction',
  discoverTip: 'interrupteur de l’astuce du jour de « Découvrir Lucium » (`discover-tips.ts`), pas une fonction : une carte en tête de la page, activée par défaut, que la carte éteint d’un clic (« Ne plus afficher ») et que la case de la page rallume ; rien ne tourne, rien n’est compté ni envoyé',
  annotateBarHintSeen: 'mémoire de l’astuce montrée une fois au-dessus de la poignée de la barre d’annotation, pas une fonction',
  arcGuideSeen: 'mémoire du guide « Vous venez d’Arc ? » déjà montré, pas une fonction : il ne s’ouvre seul qu’après un import depuis Arc, une fois',
  forceHighContrast: 'préférence d’accessibilité (contraste), pas une fonction : une classe posée sur la racine des documents',
  forceReduceMotion: 'préférence d’accessibilité (mouvement), pas une fonction : une classe posée sur la racine des documents',
  forceReduceTransparency: 'préférence d’accessibilité (transparence), pas une fonction : une classe posée sur la racine des documents',
  focusScheduleOn: 'option du mode concentration (focus-mode) : la plage horaire hebdomadaire, en plus du minuteur',
  blockCosmetic: 'option de « Bloquer les publicités et les traqueurs » (block-ads), sans effet quand celui-ci est désactivé',
  blockTrackers: 'option de « Bloquer les publicités et les traqueurs » (block-ads), gardée comme alias explicite pour les traqueurs',
  raiseAllWindows: 'option des fenêtres (macOS) : un clic sur le Dock ou ⌘⇥ ramène toutes les fenêtres de Lucium au premier plan ; allumée par défaut, comme avant ; coupée, seule la dernière fenêtre utilisée revient, et rien ne tourne de plus ou de moins (deux écouteurs de l’application, lus à chaque événement)',
  sleepSkipAudible: 'option de la mise en veille (sleep)',
  sleepSkipPinned: 'option de la mise en veille (sleep)',
  sleepNotify: 'option de la mise en veille (sleep)',
  sleepExcludedKeepAll: 'option de la mise en veille (sleep) : tous les onglets des sites gardés éveillés restent éveillés, au lieu d’un par site',
  loadAllTabsAtLaunch: 'option du lancement (Réglages › Onglets et fenêtres › Mise en veille) : dit seulement quels onglets reçoivent une page quand l’application démarre ; rien ne tourne ensuite, activée ou non. Coupée (par défaut), seuls l’onglet affiché et les onglets à garder éveillés se chargent',
  siteDataSubdomains: 'mémoire des cases du panneau « Effacer les données du site », pas une fonction',
  siteDataReload: 'mémoire des cases du panneau « Effacer les données du site », pas une fonction',
  siteDataHttp: 'mémoire des cases du panneau « Effacer les données du site » (« Inclure HTTP » coché à la main), pas une fonction',
  siteDataConfirm: 'option de « Effacer les données du site » (Réglages › Vie privée et sécurité) : une question de plus avant d’effacer, rien ne tourne',
  siteDataAutoClose: 'mémoire des cases du panneau « Effacer les données du site », pas une fonction',
  siteDataNotify: 'option de « Effacer les données du site » (Réglages › Vie privée et sécurité) : une notification après un effacement sans le panneau, rien ne tourne',
  welcomeDone: 'mémoire de l\'ancienne feuille de bienvenue, pas une fonction',
  fingerprintStrict: "option de la protection contre l'empreinte numérique (fingerprint) : chiffres plus stricts, sans effet quand celle-ci est désactivée",
}

const BY_ID: ReadonlyMap<string, Feature> = new Map(FEATURES.map((feature) => [feature.id, feature]))

export const featureById = (id: FeatureId): Feature => BY_ID.get(id)!

/** Whether a feature is on in these settings (a setting that is not what it should be counts as off). */
export function isFeatureOn(settings: Settings, id: FeatureId): boolean {
  const feature = featureById(id)
  if (feature.kind !== 'threshold' && feature.held) return feature.held.isOn(settings) === true
  const value: unknown = settings[feature.key]
  return feature.kind === 'threshold' ? typeof value === 'number' && Number.isFinite(value) && value > 0 : value === true
}

/** Whether the switch of a feature's row shows it on: what its label says, which is `isFeatureOn` turned around for a feature named by its opposite. */
export function isFeatureShownOn(settings: Settings, id: FeatureId): boolean {
  const on = isFeatureOn(settings, id)
  return featureById(id).turnedAround ? !on : on
}

/** The change of settings that the switch of a feature's row makes when it is turned to `shownOn`. */
export function featureShownPatch(id: FeatureId, shownOn: boolean): Partial<Settings> {
  return featurePatch(id, featureById(id).turnedAround ? !shownOn : shownOn)
}

/**
 * Whether the code behind a feature's gate has work to do: its own rule when it has one (`runsWhen`), else the switch. Only a feature
 * that has more than one setting to follow differs from `isFeatureOn`.
 */
export function featureRuns(settings: Settings, id: FeatureId): boolean {
  const feature = featureById(id)
  return feature.runsWhen ? feature.runsWhen(settings) : isFeatureOn(settings, id)
}

/** The features `id` needs (see `needsAnyOf`) when none of them is on: empty when it needs nothing or has what it needs. */
export function unmetNeeds(settings: Settings, id: FeatureId): Feature[] {
  const needs = featureById(id).needsAnyOf
  if (!needs || needs.length === 0 || needs.some((need) => isFeatureOn(settings, need as FeatureId))) return []
  return needs.map((need) => featureById(need as FeatureId))
}

/** Whether the pane lets the user press the switch of a feature: it can be written, and it is not an "on" that would do nothing (an "on" that does nothing can still be switched off). */
export function featureSwitchable(settings: Settings, id: FeatureId): boolean {
  return featureWritable(id) && (isFeatureOn(settings, id) || unmetNeeds(settings, id).length === 0)
}

/** The value of its setting that a feature starts with: what the "Rétablir" button goes back to. */
export function featureDefault(id: FeatureId): boolean {
  return isFeatureOn(defaultSettings(), id)
}

/** The change of settings that switches a feature on or off: the same setting the original pane of the feature writes. */
export function featurePatch(id: FeatureId, on: boolean): Partial<Settings> {
  const feature = featureById(id)
  if (feature.kind !== 'threshold') return feature.held ? feature.held.patch(on) : { [feature.key]: on }
  return { [feature.key]: on ? (feature.onValue ?? defaultSettings()[feature.key]) : 0 }
}

const writable = new Map<string, boolean>()

/**
 * Whether the pane may switch a feature. The interface is refused a patch that names some settings (ipc-policy.ts: the lock's), so a switch
 * for one would do nothing, and a reset patch that held one would be refused whole: such a feature is shown, never written.
 */
export function featureWritable(id: FeatureId): boolean {
  let known = writable.get(id)
  if (known === undefined) {
    known = [true, false].every((on) => interfaceMayDispatch({ type: 'settings/update', patch: featurePatch(id, on) }, []))
    writable.set(id, known)
  }
  return known
}

/** The settings of every feature the pane may write set back to their defaults (the other settings are not touched). */
export function defaultFeaturesPatch(): Partial<Settings> {
  const defaults = defaultSettings()
  const patch: Partial<Settings> = {}
  for (const { id } of FEATURES) {
    if (!featureWritable(id)) continue
    const feature = featureById(id)
    // A switch held by several settings goes back with all of them; the others go back to the value of their one setting.
    Object.assign(patch, feature.kind !== 'threshold' && feature.held ? feature.held.patch(isFeatureOn(defaults, id)) : { [feature.key]: defaults[feature.key] })
  }
  return patch
}

/** The costs in the order a sentence says them: what reaches out of the Mac first, then what it keeps, then what merely runs. */
const COST_ORDER: ReadonlyArray<Exclude<FeatureCost, 'none'>> = ['network', 'memory', 'process', 'disk', 'timer', 'listeners']

/** What each cost does while the feature is on, as the end of « Allumée : … » (a verb whose subject is the feature). */
const COST_WORDS: Readonly<Record<Exclude<FeatureCost, 'none'>, MessageKey>> = {
  network: 'features-settings.cout-network',
  memory: 'features-settings.cout-memory',
  process: 'features-settings.cout-process',
  disk: 'features-settings.cout-disk',
  timer: 'features-settings.cout-timer',
  listeners: 'features-settings.cout-listeners'
}

/**
 * What a feature costs, said in one sentence (« Fonctions en option »): what it does while it is on, and nothing while it is off, which is the rule of
 * design of every feature (the header of this file); a feature that costs nothing even on says so.
 */
export function costSentence(feature: Feature): string {
  const costs = COST_ORDER.filter((cost) => feature.cost.includes(cost))
  if (costs.length === 0) return t('features-settings.cout-rien')
  return t('features-settings.cout-allumee', { costs: new Intl.ListFormat(getLanguage(), { type: 'conjunction' }).format(costs.map((cost) => t(COST_WORDS[cost]))) })
}

/**
 * The one line the Settings show for a feature whose description says more than a line: its row in a category, its line in « Fonctions en option ». The
 * whole description waits behind « En savoir plus » (FeaturesSettings.tsx), so nothing it says is lost.
 */
const SUMMARIES: Readonly<Partial<Record<FeatureId, MessageKey>>> = {
  'tab-tree': 'features.un-onglet-ouvert-depuis-un-lien-se-range',
  'tab-search': 'features.la-barre-de-commandes-cherche-parmi-les',
  'tab-groups-ext': 'features.les-groupes-d-onglets-crees-par-une',
  'reload-all-button': 'features.deux-boutons-en-tete-de-la-barre-laterale',
  'web-panels': 'features.un-site-s-ouvre-a-cote-de-la-page-dans-un',
  'independent-windows': 'features.chaque-nouvelle-fenetre-a-ses-propres',
  pwa: 'features.ouvre-un-site-dans-sa-propre-fenetre-avec',
  'document-pip': 'features.une-petite-fenetre-d-appel-video-qui-reste',
  containers: 'features.un-onglet-peut-vivre-a-part-avec-ses-propres',
  'private-tabs': 'features.un-onglet-dont-rien-n-est-garde-ni',
  'guest-profile': 'features.une-fenetre-sans-historique-ni-cookies',
  bookmarks: 'features.un-panneau-de-signets-avec-recherche',
  'live-folders': 'features.un-dossier-de-la-barre-laterale-suit-un-flux',
  notes: 'features.des-notes-courtes-gardees-sur-ce-mac-liees-a-en-bref',
  'page-watch': 'features.lucium-relit-des-pages-et-vous-previent',
  'annotate-capture': 'features.dessinez-sur-une-capture-avant-de-la-copier',
  'open-unsaved': 'features.ouvre-le-fichier-d-un-lien-sans-le-garder',
  'find-regex': 'features.cherchez-dans-la-page-avec-une-expression',
  'shortcut-help': 'features.une-feuille-liste-les-raccourcis-clavier-en-bref',
  applescript: 'features.des-scripts-et-l-application-raccourcis',
  'compact-mode': 'features.une-commande-cache-d-un-coup-la-barre',
  'media-player': 'features.une-barre-au-pied-de-la-barre-laterale',
  'resource-gauge': 'features.un-anneau-au-pied-de-la-barre-laterale',
  'tab-state-badges': 'features.chaque-onglet-montre-s-il-charge-dort-joue',
  'download-status-chip': 'features.l-avancement-d-un-telechargement-s-affiche',
  'whats-new': 'features.apres-une-mise-a-jour-une-feuille-liste-ce'
}

/** The short line of a feature, when its description says more than one (`SUMMARIES`); null for a feature whose first sentence is short enough. */
export const featureSummary = (feature: Feature): string | null => {
  const key = SUMMARIES[feature.id as FeatureId]
  return key === undefined ? null : t(key)
}

/** What the Settings say of a feature in one line: its short line, or the first sentence of its description. */
export const featureLine = (feature: Feature): string => featureSummary(feature) ?? firstSentence(feature.description)

/**
 * The first sentence of a text: up to the first full stop, question or exclamation mark or ellipsis that a capital letter follows (after a space, and an
 * opening quote or bracket); the whole text when it is one sentence. « Notes… ou la barre » and « l’adresse… » » go on: no capital follows.
 */
export function firstSentence(text: string): string {
  const end = /[.!?…](?=\s+[«“"(]?\s*\p{Lu})/u.exec(text)
  return end ? text.slice(0, end.index + 1) : text
}

