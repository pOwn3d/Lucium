// The captures of the features page of the public site (lucium.app/fonctions/, /en/features/): one scenario for each card of the page, written as
// data. A card shows its feature in use when the demonstration profile can put it on screen (a panel, a sheet, the command bar, a state of the
// sidebar or of the toolbar, a window of its own); a feature that has nothing to show by nature (the network, privacy, a timer, a behaviour of the
// mouse) shows the closest thing a person can see of it: its row in the Settings window, or its command in the command bar. Each scenario says
// which (`evidence`), and the manifest written next to the images says it again for the site.
//
// scripts/site-captures.mjs `--features` reads this table, puts each scene in place with the means of the shots of the site (shots.ts `Scene`),
// captures the window, crops it to what matters (`crop`: an element of the window and the 16:10 box around it, the shape of the thumbnails of the
// page) and writes `<card>-<lang>-light.webp` (the site is light only) and manifest.json. `--dry-run` checks every scenario against the sources of
// the application and the pages of the site, without starting anything (`checkScenarios`).
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Lang, Localized, Scene, SettingsPaneKey, SettingsSubpageKey, WindowKind } from './shots'

/**
 * What the image of a card shows. `direct`: the feature in use. `setting`: its row in the Settings window (the feature acts where nothing shows, or
 * needs what the demonstration cannot give: a video playing, a download, a trackpad). `command`: its entry in the command bar. `shot`: a shot of
 * the site already shows it (shots.ts), and the card keeps that image. `none`: not captured yet, with the reason (`todo`).
 */
export type Evidence = 'direct' | 'setting' | 'command' | 'shot' | 'none'

/** The evidence that is not the feature itself: what the report and the manifest call indirect. */
export const INDIRECT: ReadonlySet<Evidence> = new Set<Evidence>(['setting', 'command'])

/** The site has no dark theme: its pictures are light. */
export const FEATURE_THEME = 'light'
/** The widest image the page needs: a thumbnail is at most about 420 CSS px wide, twice that on a Retina screen. Never enlarged. */
export const FEATURE_WIDTH = 960
/** The shape of the thumbnails of the page (assets/site.css, `.shot-thumb`: aspect-ratio 16 / 10). */
export const THUMB_ASPECT = 16 / 10

export interface CropTarget {
  /** The page the element is looked for in: the main window's interface, its overlay (panels, sheets, command bar), or the page of the captured window. */
  page: 'shell' | 'overlay' | 'window'
  /** CSS selectors, by preference: the first that finds an element with a size is the target. */
  selectors: readonly string[]
  /** The narrowest the box may be, in points (default 720: half the main window, enough to see where the element is). */
  minWidth?: number
  /** Room left around the element, in points. */
  pad?: number
  /**
   * `target` (default): the box is centred on the element. `top`: the box is the top of the window, as wide as it, the element brought just under
   * the head of the window first (the Settings window: its sidebar, the page lit, and the head of the page or of the subpage say where the row is).
   */
  anchor?: 'target' | 'top'
  /** false: the box holds the width of the element only, and keeps its top when it is taller (a sidebar: its top, not the whole window). */
  grow?: false
}

export interface FeatureScenario {
  /** The id of the card on the page (`fn-sleep`): the name of the images is made from it. */
  card: string
  /** The id of the feature in the registry (src/shared/features.ts, the card's `data-feature`), for the optional features. */
  feature?: string
  /** The title of the card, as the page writes it: the alternative texts are made from it. */
  title: Localized<string>
  evidence: Evidence
  /** The alternative text of the image, in both languages. */
  alt: Localized<string>
  /** For indirect evidence: why the feature itself cannot be shown (French, for the manifest and the report). */
  why?: string
  /** `shot`: the shot of shots.ts whose image the card keeps. */
  shot?: string
  /** `none`: why there is no capture yet. */
  todo?: string
  /** The window captured (the main window by default). */
  window?: WindowKind
  scene?: Scene
  /** The part of the window the image keeps; absent, the whole window (in its 16:10 box). */
  crop?: CropTarget
  /**
   * The words of the window the alternative text quotes (the name of a row of Réglages): the capture refuses an image whose target does not show
   * them, and settings-rows.test.ts checks them against the row the window draws.
   */
  quote?: Localized<string>
  /** The option the row of choices shows (a preset, a menu), quoted by the alternative text: settings-rows.test.ts checks it too. */
  choice?: Localized<string>
}

// ---------- the labels the alternative texts use ----------

/** The pages of Réglages, as the window names them (i18n `settings.cat-*`; features.test.ts compares). */
export const PANE_LABELS: Readonly<Record<SettingsPaneKey, Localized<string>>> = {
  home: { fr: 'Pour commencer', en: 'Start here' },
  appearance: { fr: 'Apparence', en: 'Appearance' },
  tabs: { fr: 'Onglets et fenêtres', en: 'Tabs and windows' },
  navigation: { fr: 'Navigation', en: 'Navigation' },
  protection: { fr: 'Vie privée et sécurité', en: 'Privacy and security' },
  files: { fr: 'Téléchargements et fichiers', en: 'Downloads and files' },
  tools: { fr: 'Extensions et outils', en: 'Extensions and tools' },
  keyboard: { fr: 'Clavier et souris', en: 'Keyboard and mouse' },
  profiles: { fr: 'Profils', en: 'Profiles' },
  features: { fr: 'Fonctions en option', en: 'Optional features' },
  about: { fr: 'À propos et mises à jour', en: 'About and updates' }
}

/** « Plus de réglages », the one fold at the foot of a page (i18n `settings.plus-de-reglages`; features.test.ts compares). */
export const MORE_LABEL: Localized<string> = { fr: 'Plus de réglages', en: 'More settings' }

/** The subpages of Réglages, as their head titles them (the `title` of SUBPAGES in src/shared/settings-subpages.ts; features.test.ts compares). */
export const SUBPAGE_LABELS: Readonly<Record<SettingsSubpageKey, Localized<string>>> = {
  contrast: { fr: 'Sites avec un contraste à part', en: 'Sites with their own contrast' },
  awake: { fr: 'Sites gardés éveillés', en: 'Sites kept awake' },
  containers: { fr: 'Vos conteneurs', en: 'Your containers' },
  sitesearches: { fr: 'Recherches par mot-clé', en: 'Keyword searches' },
  linkroutes: { fr: 'Diriger les liens de certains sites vers un espace', en: 'Send links from certain sites to a Space' },
  exceptions: { fr: 'Exceptions par site', en: 'Exceptions by site' },
  clearonclose: { fr: 'Effacer certains sites en partant', en: 'Clear some sites when you leave' },
  permissions: { fr: 'Autorisations mémorisées', en: 'Remembered permissions' },
  lockoptions: { fr: 'Options du verrouillage', en: 'Lock options' },
  filterlists: { fr: 'Listes de filtres', en: 'Filter lists' },
  network: { fr: 'DNS chiffré et proxy', en: 'Encrypted DNS and proxy' },
  extensionfolders: { fr: 'Extensions chargées depuis un dossier', en: 'Extensions loaded from a folder' },
  translatelists: { fr: 'Langues et sites', en: 'Languages and sites' },
  userscripts: { fr: 'Scripts importés', en: 'Imported scripts' },
  pagewatches: { fr: 'Pages surveillées', en: 'Watched pages' },
  focus: { fr: 'Mode concentration', en: 'Focus mode' },
  shortcuts: { fr: 'Raccourcis clavier', en: 'Keyboard shortcuts' },
  siteexclusions: { fr: 'Sites sans gestes ni touches Vim', en: 'Sites without gestures or Vim keys' },
  sync: { fr: 'Synchronisation', en: 'Synchronization' }
}

/**
 * The way to a row of Réglages, as the texts of the application write it (src/shared/settings-path.ts): the page, « Plus de réglages » when the row
 * waits there, the subpage it lives on. « Réglages › Vie privée et sécurité › DNS chiffré et proxy ».
 */
export function settingsPlace(pane: SettingsPaneKey, place: { fold?: true; sub?: SettingsSubpageKey } = {}): Localized<string> {
  const way = (lang: Lang): string =>
    [lang === 'fr' ? 'Réglages' : 'Settings', PANE_LABELS[pane][lang], ...(place.fold ? [MORE_LABEL[lang]] : []), ...(place.sub ? [SUBPAGE_LABELS[place.sub][lang]] : [])].join(' › ')
  return { fr: way('fr'), en: way('en') }
}

const t = (fr: string, en: string): Localized<string> => ({ fr, en })

/** A row given as a CSS selector (a part of a page that carries no key, such as the buttons of the export) rather than a key. */
export const isRowSelector = (row: string): boolean => /^[.#[]/.test(row)

/**
 * The rows of a key in the Settings window, by preference: its own row, then a group that lists it (SettingsWindow.tsx finds a result the same
 * way); a row given as a selector is that selector.
 */
export const rowSelectors = (row: string): string[] =>
  isRowSelector(row) ? [row] : [`.pref-row[data-setting~="${row}"]`, `.pref-row[data-search="${row}"]`, `[data-setting~="${row}"]`, `[data-search="${row}"]`]

// ---------- the kinds of scenario ----------

interface SettingOptions {
  /** Settings changed for the image (put back afterwards): a switch shown on, or a default the demonstration turns off. */
  patch?: Readonly<Record<string, unknown>>
  /** The row is shown on (`patch` turns it on): the alternative text says so. */
  on?: true
  why?: string
  /** The row at the foot of the image (the note under its group would name what the site does not). */
  place?: 'bottom'
  /** The row waits in « Plus de réglages » on its page (the fold is opened first); features.test.ts checks it against the map of the window. */
  fold?: true
  /** The subpage the row lives on, opened at its address; features.test.ts checks it against the map of the window. */
  sub?: SettingsSubpageKey
  /** The name of the row as the window writes it, when the card says it another way: the alternative text quotes the window. */
  label?: Localized<string>
  /** The option a row of choices shows (a preset, a menu), quoted after its name. */
  choice?: Localized<string>
  /** What the image shows when it is not a row with a name (a list, a form, a group of pictures): said instead of « la ligne « … » ». */
  shows?: Localized<string>
  /** With `shows`: words of the window the image holds (a title, a button), checked as the name of a row is. */
  quote?: Localized<string>
}

/**
 * The row of the feature on its page of Réglages, brought just under the head of the window. The alternative text says where it is, as the texts of
 * the application do (`settingsPlace`: the page, « Plus de réglages », the subpage), and quotes the name the row has in the window.
 */
function setting(card: string, feature: string | undefined, title: Localized<string>, pane: SettingsPaneKey, row: string, options: SettingOptions = {}): FeatureScenario {
  const where = settingsPlace(pane, options)
  const quote = options.shows ? options.quote : (options.label ?? title)
  const named = options.label ?? title
  const what: Localized<string> = options.shows ?? {
    fr: `la ligne « ${named.fr} »${options.choice ? `, sur « ${options.choice.fr} »` : ''}${options.on ? ', activée' : ''}`,
    en: `the “${named.en}” row${options.choice ? `, set to “${options.choice.en}”` : ''}${options.on ? ', switched on' : ''}`
  }
  return {
    card,
    ...(feature ? { feature } : {}),
    title,
    evidence: 'setting',
    alt: t(`${where.fr} : ${what.fr}`, `${where.en}: ${what.en}`),
    ...(options.why ? { why: options.why } : {}),
    window: 'settings',
    scene: {
      space: 'work',
      tab: 'notes',
      settings: { pane, ...(options.sub ? { sub: options.sub } : {}), row, ...(options.fold ? { fold: options.fold } : {}), ...(options.place ? { place: options.place } : {}) },
      ...(options.patch ? { patch: options.patch } : {})
    },
    // The top of the window: its title and the sidebar, the page of the row lit, then the row, brought just under the head of the page.
    crop: { page: 'window', selectors: rowSelectors(row), minWidth: 780, pad: 0, anchor: 'top' },
    ...(quote ? { quote } : {}),
    ...(options.choice ? { choice: options.choice } : {})
  }
}

/** Spaces of every kind as one, and no case: a text read on screen (`innerText`, French typography) compared with the words of a catalogue. */
const looseText = (text: string): string => text.replace(/[\s\u00a0\u202f]+/g, ' ').trim().toLocaleLowerCase()

/** Whether the text of the target of an image holds the words its alternative text quotes (`quote`): the capture refuses it otherwise. */
export const showsQuote = (shown: string, quote: string): boolean => looseText(shown).includes(looseText(quote))

/** A switch that only changes how something behaves (no picture of its own): its row. */
const behaviour = 'agit sur un comportement (clic, clavier, geste, ouverture d’un lien) qui ne se voit pas sur une image fixe'
const network = 'agit sur le réseau ou sur ce que les pages reçoivent : rien ne se voit à l’écran'
const background = 'agit en arrière-plan (minuterie, sauvegarde, mise à jour) : rien ne se voit à l’écran'
const needsMedia = 'a besoin d’une vidéo ou d’un son qui joue, que la démonstration n’a pas'
const needsDownload = 'agit sur un téléchargement, que la démonstration ne fait pas'
const needsExtension = 'a besoin d’une extension installée qui s’en sert'
const needsHardware = 'a besoin d’un matériel, d’un trackpad ou d’une autre application'

/** A shot of the site already shows the feature: the card keeps its image. */
const shot = (card: string, feature: string | undefined, title: Localized<string>, shotId: string, alt: Localized<string>): FeatureScenario => ({
  card,
  ...(feature ? { feature } : {}),
  title,
  evidence: 'shot',
  alt,
  shot: shotId
})

/** The feature in use in the main window (or the window it opens). */
const direct = (card: string, feature: string | undefined, title: Localized<string>, alt: Localized<string>, scene: Scene, crop?: CropTarget, extra: Partial<FeatureScenario> = {}): FeatureScenario => ({
  card,
  ...(feature ? { feature } : {}),
  title,
  evidence: 'direct',
  alt,
  scene,
  ...(crop ? { crop } : {}),
  ...extra
})

/** Its entry in the command bar, the words typed. */
const command = (card: string, feature: string | undefined, title: Localized<string>, alt: Localized<string>, text: Localized<string>, pick: Localized<string>, why: string, space: Scene['space'] = 'work', tab = 'notes'): FeatureScenario => ({
  card,
  ...(feature ? { feature } : {}),
  title,
  evidence: 'command',
  alt,
  why,
  scene: { space, tab, commandBar: { text, expect: 'rows', pick } },
  crop: { page: 'overlay', selectors: ['.palette'], minWidth: 820 }
})

const overlayCrop = (selector: string, minWidth = 760): CropTarget => ({ page: 'overlay', selectors: [selector], minWidth })
const sidebarCrop: CropTarget = { page: 'shell', selectors: ['.sidebar'], minWidth: 760, grow: false }

// ---------- the table: one scenario per card (in the order of the page before its redesign: the order of the captures) ----------

export const FEATURE_SCENARIOS: readonly FeatureScenario[] = [
  // ---- Onglets et pages ----
  shot('fn-barre-laterale', undefined, t('Barre latérale', 'Sidebar'), 'main-window', t(
    'La fenêtre de Lucium : l’espace Travail avec ses favoris, ses onglets épinglés, ses dossiers et ses onglets du jour, le carnet de notes à l’écran',
    'The Lucium window: the Work Space with its favorites, pinned tabs, folders and today’s tabs, the notebook on screen'
  )),
  shot('fn-espaces', undefined, t('Espaces', 'Spaces'), 'space-switch', t(
    'L’espace Maison, avec ses couleurs et ses onglets, les recettes de saison à l’écran',
    'The Home Space, with its colors and its tabs, seasonal recipes on screen'
  )),
  direct('fn-sessions', undefined, t('Sessions d’onglets', 'Tab sessions'), t(
    'Le panneau des sessions d’onglets : deux sessions enregistrées, que l’on rouvre d’un clic, et un nom prêt pour enregistrer les onglets de l’espace Travail',
    'The tab sessions panel: two saved sessions, each reopened in one click, and a name ready to save the tabs of the Work Space'
  ), {
    space: 'work',
    tab: 'notes',
    // The list the panel is made for: an empty one showed only the field that saves.
    sessions: [
      { name: { fr: 'Documentation du projet', en: 'Project documentation' }, tabs: ['style-guide', 'glossary', 'naming'] },
      { name: { fr: 'Réunions de la semaine', en: 'This week’s meetings' }, tabs: ['meeting', 'agenda-items', 'notes'] }
    ],
    overlay: { request: { panel: 'sessions', focus: 'save' }, wait: '.lp.sessions' }
  }, overlayCrop('.lp.sessions')),
  direct('fn-rechargement', undefined, t('Rechargement automatique', 'Auto-reload'), t(
    'Recharger automatiquement l’onglet de la météo : l’intervalle se choisit de 5 secondes à 24 heures',
    'Auto-reload for the weather tab: the interval is chosen from 5 seconds to 24 hours'
  ), { space: 'work', tab: 'weather', overlay: { request: { panel: 'autoreload', tabId: '$tab' }, wait: '.auto-reload' } }, overlayCrop('.auto-reload')),
  shot('fn-lecture', undefined, t('Mode lecture', 'Reader mode'), 'reader-mode', t(
    'Le mode lecture sur l’article « Le goût des cartes anciennes » : le texte seul, mis en page par Lucium, avec sa barre de réglages',
    'Reader mode on the article “The pull of old maps”: the text alone, laid out by Lucium, with its reading controls'
  )),
  direct('fn-lire-plus-tard', undefined, t('Lire plus tard', 'Read later'), t(
    'La liste Lire plus tard, avec trois pages mises de côté : un compte rendu de réunion, le guide de style et le glossaire du projet',
    'The Read later list, with three pages put aside: meeting notes, the style guide and the project glossary'
  ), { space: 'work', tab: 'notes', readLater: ['meeting', 'style-guide', 'glossary'], overlay: { request: { panel: 'readlater' }, wait: '.card.readlater' } }, overlayCrop('.card.readlater')),
  {
    card: 'fn-videos-protegees',
    title: t('Vidéos protégées', 'Protected video'),
    evidence: 'none',
    alt: t('La lecture d’une vidéo protégée dans Lucium', 'A protected video playing in Lucium'),
    todo:
      'la build de développement que l’outil pilote n’a pas le module de déchiffrement (seule la variante DRM empaquetée l’installe), et une vidéo protégée ' +
      'demande un service réel et un compte : la démonstration ne montre rien de juste ici'
  },
  shot('fn-sleep', 'sleep', t('Mettre en veille les onglets inactifs', 'Put inactive tabs to sleep'), 'resource-panel-asleep', t(
    'Le panneau des ressources juste après « Tout mettre en veille sauf l’onglet affiché » : 18 onglets mis en veille, leurs icônes pâlies, la mémoire plus basse',
    'The resource panel right after “Put every other tab to sleep”: 18 tabs put to sleep, their icons faded, memory lower'
  )),
  // The demonstration turns archiving off (demo.ts); the row shows the default of the application.
  setting('fn-auto-archive', 'auto-archive', t('Archiver les onglets du jour inactifs', 'Archive inactive tabs of the day'), 'tabs', 'autoArchiveHours', { label: t('Archiver les onglets du jour inactifs', 'Archive inactive Today tabs'), patch: { autoArchiveHours: 12 }, why: background }),
  // At the foot of the image, the rows of the split view above it: under it comes the group of the extension tab groups, whose row names the API of
  // the extensions by its name in code, which the site does not show.
  setting('fn-auto-pip', 'auto-pip', t('Image dans l’image en quittant un onglet vidéo', 'Picture in Picture when leaving a video tab'), 'tabs', 'autoPictureInPicture', { fold: true, why: needsMedia, place: 'bottom' }),
  setting('fn-media-player', 'media-player', t('Lecteur multimédia dans la barre latérale', 'Media player in the sidebar'), 'appearance', 'mediaPlayer', { fold: true, why: needsMedia }),
  setting('fn-tab-state-badges', 'tab-state-badges', t('États visibles sur les onglets', 'Visible tab states'), 'tabs', 'tabStateBadges', { fold: true, why: 'montre l’état d’un onglet (son, chargement, veille) au moment où il change, que la démonstration ne provoque pas' }),
  direct('fn-boosts', 'boosts', t('Retouches sur les sites visités', 'Tweaks on visited sites'), t(
    'L’éditeur de Retouches ouvert sur le site du carnet de notes, à côté de la page',
    'The Tweaks editor open on the notebook’s site, beside the page'
  ), { space: 'work', tab: 'notes', overlay: { request: { panel: 'boost', host: '$host' }, wait: '.bx-card' } }, overlayCrop('.bx-card', 900)),
  setting('fn-web-panels', 'web-panels', t('Volets web', 'Web Panels'), 'features', 'webPanels', { why: 'un volet web demande un site choisi par la personne' }),
  setting('fn-reopen-history', 'reopen-history', t('Rouvrir un onglet archivé avec ses pages précédentes', 'Reopen an archived tab with its previous pages'), 'tabs', 'reopenHistory', { fold: true, patch: { reopenHistory: true }, on: true, why: behaviour }),
  setting('fn-extension-data-apis', 'extension-data-apis', t('Historique, favoris et effacement pour les extensions', 'History, favorites and clearing for extensions'), 'tools', 'extensionDataApis', { fold: true, why: needsExtension }),
  setting('fn-extension-tab-capture', 'extension-tab-capture', t('Autoriser les extensions à capter le son d’un onglet', 'Let extensions capture a tab’s sound'), 'tools', 'extensionTabCapture', { fold: true, why: needsExtension }),
  setting('fn-user-scripts', 'user-scripts', t('Scripts utilisateur', 'User scripts'), 'features', 'userScripts', { patch: { userScripts: true }, on: true, why: 'un script utilisateur agit dans une page sans rien montrer de lui-même' }),
  setting('fn-auto-scroll', 'auto-scroll', t('Défilement automatique au clic du milieu', 'Auto-scroll on middle click'), 'keyboard', 'autoScroll', { label: t('Défilement automatique avec le clic du milieu', 'Auto-scroll with the middle click'), patch: { autoScroll: true }, on: true, why: behaviour }),
  // At the foot of the image, as fn-auto-pip, for the same reason.
  setting('fn-scroll-sync', 'scroll-sync', t('Défilement synchronisé des volets', 'Synchronized Scrolling of Panes'), 'tabs', 'scrollSync', { fold: true, label: t('Défilement synchronisé des volets d’une vue scindée', 'Synchronized scrolling of split view panes'), patch: { scrollSync: true }, on: true, why: behaviour, place: 'bottom' }),
  setting('fn-remember-scroll', 'remember-scroll', t('Retrouver la position de défilement des onglets', 'Restore the scroll position of tabs'), 'tabs', 'rememberScroll', { fold: true, patch: { rememberScroll: true }, on: true, why: behaviour }),
  setting('fn-mouse-gestures', 'mouse-gestures', t('Gestes de souris', 'Mouse gestures'), 'keyboard', 'mouseGestures', { patch: { mouseGestures: true }, on: true, why: behaviour }),
  setting('fn-space-swipe', 'space-swipe', t('Balayer à deux doigts pour changer d’espace', 'Swipe with two fingers to switch Spaces'), 'keyboard', 'spaceSwipe', { why: needsHardware }),
  setting('fn-page-content-index', 'page-content-index', t('Rechercher dans le contenu des pages visitées', 'Search the content of visited pages'), 'protection', 'pageContentIndex', { fold: true, why: background }),
  setting('fn-page-watch', 'page-watch', t('Surveiller des pages', 'Watch pages'), 'features', 'pageWatch', { why: background }),
  setting('fn-focus-mode', 'focus-mode', t('Mode concentration', 'Focus mode'), 'features', 'focusMode', { patch: { focusMode: true }, on: true, why: behaviour }),
  setting('fn-read-aloud', 'read-aloud', t('Lecture à voix haute', 'Read aloud'), 'features', 'readAloud', { patch: { readAloud: true }, on: true, why: 'se fait entendre, pas voir' }),
  setting('fn-tab-cycle-recent', 'tab-cycle-recent', t('⌃Tab dans l’ordre d’utilisation récente', '⌃Tab in order of recent use'), 'keyboard', 'tabCycleRecent', { label: t('⌃Tab suit l’ordre d’utilisation récente', '⌃Tab follows the order of recent use'), why: 'le panneau de ⌃Tab ne reste ouvert que tant que la touche est tenue' }),
  setting('fn-drag-to-split', 'drag-to-split', t('Glisser un onglet sur la page pour scinder', 'Drag a tab onto the page to split'), 'tabs', 'dragToSplit', { fold: true, why: 'se voit pendant un glisser-déposer, que l’outil ne fait pas' }),
  shot('fn-tab-search', 'tab-search', t('Recherche d’onglets', 'Tab search'), 'command-bar-tab', t(
    'La barre de commandes (⌘T) retrouve un onglet déjà ouvert, la météo de la semaine, sous « Onglets ouverts »',
    'The command bar (⌘T) finds a tab that is already open, this week’s weather, under “Open tabs”'
  )),
  setting('fn-vim-keys', 'vim-keys', t('Navigation au clavier de type Vim', 'Vim-style keyboard navigation'), 'keyboard', 'vimKeys', { fold: true, patch: { vimKeys: true }, on: true, why: behaviour }),
  // The feature itself: an extension of the demonstration groups the two tabs of the day of the space, and the group is a folder of the sidebar. (Its
  // row of Réglages names the API of the extensions by its name in code, which the site does not show.)
  direct('fn-tab-groups-ext', 'tab-groups-ext', t('Groupes d’onglets des extensions dans la barre latérale', 'Extension tab groups in the sidebar'), t(
    'La barre latérale : le groupe d’onglets « Cette semaine », créé par une extension, devenu un dossier qui tient ses deux onglets',
    'The sidebar: the “This week” tab group, made by an extension, shown as a folder that holds its two tabs'
  ), {
    space: 'work',
    tab: 'weather',
    patch: { tabGroupFolders: true },
    demoExtension: 'groups',
    tabGroup: { tabs: ['weather', 'naming'], title: t('Cette semaine', 'This week') }
    // The box around the tab on screen, in the folder: the name of the folder above it, the other tab of the group under it.
  }, { page: 'shell', selectors: ['.sidebar .tab.active'], minWidth: 760 }),
  direct('fn-find-regex', 'find-regex', t('Recherche par expression régulière', 'Regular expression search'), t(
    'La recherche dans la page en expression régulière : \\d+° trouve chaque température de la météo de la semaine',
    'Find in page with a regular expression: \\d+° finds every temperature of this week’s weather'
  ), { space: 'work', tab: 'weather', patch: { findRegex: true }, find: { text: t('\\d+°', '\\d+°'), regex: true } }, overlayCrop('.fb', 820)),
  setting('fn-tab-tree', 'tab-tree', t('Arbre d’onglets', 'Tab tree'), 'features', 'tabTree', { patch: { tabTree: true }, on: true, why: 'l’arbre se forme à partir des liens ouverts depuis un onglet, que la démonstration n’a pas' }),
  setting('fn-work-views', 'work-views', t('Vues de travail', 'Work views'), 'features', 'workViewsEnabled', { on: true, why: 'une vue de travail s’enregistre depuis une vue scindée ouverte ; la démonstration n’en a pas' }),
  setting('fn-containers', 'containers', t('Conteneurs d’onglets', 'Tab containers'), 'features', 'tabContainers', { patch: { tabContainers: true }, on: true, why: 'les conteneurs se créent à la main ; la démonstration n’en a pas' }),
  direct('fn-live-folders', 'live-folders', t('Dossiers en direct (flux RSS, dépôts GitHub publics)', 'Live folders (RSS feeds, public GitHub repositories)'), t(
    'La feuille d’un nouveau dossier en direct : l’adresse d’un flux RSS ou d’un dépôt public à suivre',
    'The sheet of a new live folder: the address of an RSS feed or a public repository to follow'
  ), { space: 'work', tab: 'notes', patch: { liveFolders: true }, overlay: { request: { panel: 'livefolder' }, wait: '.card.livefolder' } }, overlayCrop('.card.livefolder')),

  // ---- Vie privée et blocage ----
  direct('fn-fenetre-privee', undefined, t('Fenêtre privée', 'Private window'), t(
    'Une fenêtre privée de Lucium, ouverte avec sa barre de commandes',
    'A Lucium private window, opened with its command bar'
  ), { space: 'work', tab: 'notes', menu: { label: t('Nouvelle fenêtre privée', 'New Private Window'), opens: 'private' } }, undefined, { window: 'private' }),
  // The panel itself would be the image (`overlay: { request: { panel: 'sitedata' } }`), but its introduction names the engine (« Chromium ne sait pas
  // les effacer site par site »): its command.
  command('fn-effacer-site', undefined, t('Effacer les données d’un site', 'Clear a site’s data'), t(
    'La barre de commandes propose « Effacer les données du site » pour le carnet de notes à l’écran',
    'The command bar offers “Clear Site Data” for the notebook on screen'
  ), t('effacer les données', 'clear site data'), t('Effacer les données du site', 'Clear Site Data'), 'le panneau d’effacement dit, dans son introduction, ce que le moteur ne sait pas effacer en le nommant : sa commande en attendant'),
  shot('fn-block-ads', 'block-ads', t('Bloquer les publicités et les traqueurs', 'Block ads and trackers'), 'settings-privacy', t(
    'Réglages › Vie privée et sécurité : le niveau de protection en tête de la page, puis l’interrupteur « Bloquer les publicités et les traqueurs »',
    'Settings › Privacy and security: the protection level at the top of the page, then the “Block ads and trackers” switch'
  )),
  // The demonstration has the protection « Renforcée » of a new profile (demo.ts): the cookie banners, the GPC signal and the tracking parameters are on
  // as they ship, and shown so with no change.
  setting('fn-block-cookie-banners', 'block-cookie-banners', t('Bloquer les bannières de cookies', 'Block cookie banners'), 'protection', 'blockCookieBanners', { on: true, why: network }),
  setting('fn-block-scriptlets', 'block-scriptlets', t('Scriptlets et règles étendues du bloqueur', 'Blocker scriptlets and extended rules'), 'protection', 'blockScriptlets', { fold: true, why: network }),
  setting('fn-fingerprint', 'fingerprint', t('Protection contre l’empreinte numérique', 'Fingerprinting protection'), 'protection', 'reduceFingerprint', { patch: { reduceFingerprint: true }, on: true, why: network }),
  setting('fn-https-first', 'https-first', t('HTTPS d’abord', 'HTTPS first'), 'protection', 'httpsUpgrade', { fold: true, label: t('Toujours essayer HTTPS d’abord', 'Always try HTTPS first'), why: network }),
  setting('fn-global-privacy-control', 'global-privacy-control', t('Envoyer le signal Global Privacy Control', 'Send the Global Privacy Control signal'), 'protection', 'sendGpc', { fold: true, label: t('Demander aux sites de ne pas me suivre (signal GPC)', 'Ask sites not to track me (GPC signal)'), on: true, why: network }),
  setting('fn-third-party-cookies', 'third-party-cookies', t('Bloquer les cookies tiers', 'Block third-party cookies'), 'protection', 'blockThirdPartyCookies', { fold: true, patch: { blockThirdPartyCookies: true }, on: true, why: network }),
  setting('fn-block-pings', 'block-pings', t('Bloquer les pings de suivi', 'Block tracking pings'), 'protection', 'blockPings', { fold: true, patch: { blockPings: true }, on: true, why: network }),
  setting('fn-trim-referer', 'trim-referer', t('Ne pas envoyer le chemin de la page aux autres sites', 'Do not send the page path to other sites'), 'protection', 'trimReferer', { fold: true, patch: { trimReferer: true }, on: true, why: network }),
  setting('fn-https-only', 'https-only', t('Ouvrir uniquement des sites en HTTPS', 'Open HTTPS sites only'), 'protection', 'httpsOnly', { fold: true, patch: { httpsOnly: true }, on: true, why: network }),
  setting('fn-strip-tracking', 'strip-tracking', t('Retirer les paramètres de suivi des adresses', 'Remove tracking parameters from addresses'), 'protection', 'stripTrackingParams', { on: true, why: network }),
  // The demonstration asks no search engine anything (demo.ts): the row shows the default of the application; nothing is typed while it is on.
  setting('fn-search-suggestions', 'search-suggestions', t('Suggestions du moteur de recherche', 'Search engine suggestions'), 'navigation', 'searchSuggestions', { label: t('Inclure les suggestions de recherche', 'Include search suggestions'), patch: { searchSuggestions: true }, why: network }),
  setting('fn-theme-to-sites', 'theme-to-sites', t('Donner le thème de l’espace aux pages web', 'Give the Space theme to web pages'), 'appearance', 'allowThemeToSites', { fold: true, patch: { allowThemeToSites: true }, on: true, why: 'n’a d’effet que sur un site qui lit le thème proposé, que la démonstration n’a pas' }),
  setting('fn-screen-share', 'screen-share', t('Partage d’écran ou de fenêtre', 'Screen or window sharing'), 'protection', 'allowScreenShare', { fold: true, why: 'un partage demande un service de visioconférence et l’accord de macOS' }),
  setting('fn-strip-copied-links', 'strip-copied-links', t('Retirer les paramètres de suivi des liens copiés', 'Remove tracking parameters from copied links'), 'protection', 'stripCopiedLinks', { fold: true, on: true, why: 'agit sur le presse-papiers' }),
  setting('fn-history-off', 'history-off', t('Garder l’historique des pages visitées', 'Keep the history of visited pages'), 'protection', 'historyOff', { why: 'agit sur ce qui est écrit sur le disque' }),
  // Its row says « le moteur décide seul » now, and names no browser: it can be shown.
  setting('fn-doh', 'doh', t('DNS chiffré personnalisé', 'Custom encrypted DNS'), 'protection', 'dohCustom', { sub: 'network', label: t('Régler le DNS chiffré moi-même', 'Set up encrypted DNS myself'), why: network }),
  setting('fn-proxy', 'proxy', t('Proxy HTTP ou SOCKS', 'HTTP or SOCKS proxy'), 'protection', 'proxyEnabled', { sub: 'network', label: t('Utiliser un proxy HTTP ou SOCKS', 'Use an HTTP or SOCKS proxy'), why: network }),
  direct('fn-cookie-manager', 'cookie-manager', t('Cookies par site', 'Cookies by Site'), t(
    'Le panneau Cookies par site du profil de l’espace à l’écran : les sites, leurs cookies, ceux à garder',
    'The Cookies by Site panel for the profile of the Space on screen: the sites, their cookies, the ones to keep'
  ), { space: 'work', tab: 'notes', overlay: { request: { panel: 'cookies' }, wait: '.card.cookies' } }, overlayCrop('.card.cookies')),
  command('fn-private-tabs', 'private-tabs', t('Onglets privés dans une fenêtre normale', 'Private tabs in a regular window'), t(
    'La barre de commandes propose « Nouvel onglet privé », dans une fenêtre normale',
    'The command bar offers “New Private Tab”, in a regular window'
  ), t('onglet privé', 'private tab'), t('Nouvel onglet privé', 'New Private Tab'), 'un onglet privé ressemble à un autre onglet : sa commande dit ce qu’il est'),
  setting('fn-guest-profile', 'guest-profile', t('Profil invité', 'Guest profile'), 'features', 'guestProfile', { why: 'ouvre une fenêtre invité qui part avec tout ce qu’on y a fait' }),
  setting('fn-clear-on-close', 'clear-on-close', t('Effacer les données d’un site à la fermeture', 'Clear a site’s data on close'), 'protection', 'siteDataClearOnCloseEnabled', { sub: 'clearonclose', label: t('Effacer à la fermeture du dernier onglet du site', 'Clear when the site’s last tab closes'), patch: { siteDataClearOnCloseEnabled: true }, on: true, why: 'agit quand l’onglet se ferme' }),
  setting('fn-custom-filter-lists', 'custom-filter-lists', t('Listes de blocage personnalisées', 'Custom blocking lists'), 'protection', 'customFilterListsEnabled', { sub: 'filterlists', label: t('Listes personnalisées', 'Custom lists'), why: network }),
  setting('fn-lock', 'lock', t('Verrouillage de l’application et des espaces', 'App and Space locking'), 'protection', 'lockEnabled', { label: t('Verrouiller Lucium ou un espace', 'Lock Lucium or a Space'), why: 'le verrou se met avec une phrase de passe et Touch ID, que l’outil ne règle pas' }),
  shot('fn-password-manager', 'password-manager', t('Gestionnaire de mots de passe', 'Password manager'), 'vault-touch-id', t(
    'Le coffre de mots de passe, déverrouillé au-dessus du carnet de notes, avec cinq identifiants',
    'The password vault, unlocked over the notebook, with five logins'
  )),
  setting('fn-web-hardware', 'web-hardware', t('API matérielles du web (WebHID, WebUSB, Web Serial)', 'Web hardware APIs (WebHID, WebUSB, Web Serial)'), 'protection', 'webHardware', { fold: true, label: t('Autoriser les sites à demander l’accès à un appareil (WebHID, WebUSB, Web Serial)', 'Allow sites to request access to a device (WebHID, WebUSB, Web Serial)'), why: needsHardware }),

  // ---- Liens et fenêtres ----
  shot('fn-vue-scindee', undefined, t('Vue scindée', 'Split View'), 'split-view-4', t(
    'La vue scindée à quatre volets : la météo, un article, le tableau du projet et le carnet de notes côte à côte',
    'Split View with four panes: the weather, an article, the project board and the notebook side by side'
  )),
  setting('fn-routage', undefined, t('Routage des liens', 'Link routing'), 'navigation', 'linkRoutes', { sub: 'linkroutes', shows: t('le formulaire qui ajoute une règle : un site, et l’espace où s’ouvrent ses liens', 'the form that adds a rule: a site, and the Space its links open in'), why: 'agit quand un lien arrive d’une autre application' }),
  shot('fn-peek-shift', 'peek-shift', t('Coup d’œil avec ⇧-clic sur un lien', 'Glance with ⇧-click on a link'), 'peek', t(
    'Le Coup d’œil : un lien du carnet ouvert en aperçu par ⇧-clic, au-dessus de la page',
    'Glance: a link of the notebook opened as a preview with Shift-click, over the page'
  )),
  setting('fn-peek-external', 'peek-external', t('Coup d’œil pour les liens vers d’autres sites', 'Glance for links to other sites'), 'navigation', 'peekOnExternalLinks', { fold: true, patch: { peekOnExternalLinks: true }, on: true, why: behaviour }),
  shot('fn-external-links-little', 'external-links-little', t('Ouvrir les liens d’autres apps dans une mini-fenêtre', 'Open links from other apps in a mini window'), 'little-window', t(
    'Une mini-fenêtre : les horaires du musée ouverts à part, sans quitter l’espace',
    'A mini window: the museum hours opened apart, without leaving the Space'
  )),
  setting('fn-little-shortcut', 'little-shortcut', t('Raccourci de la mini-fenêtre dans toutes les apps', 'Mini window shortcut in all apps'), 'keyboard', 'littleArcShortcut', { label: t('Raccourci de la mini-fenêtre dans toutes les applications', 'Mini window shortcut in all apps'), why: needsHardware }),
  setting('fn-little-archive', 'little-archive', t('Fermer et archiver les mini-fenêtres oubliées', 'Close and archive forgotten mini windows'), 'navigation', 'littleArcArchiveHours', { fold: true, why: background }),
  setting('fn-little-modifier', 'little-modifier', t('Ouvrir un lien dans une mini-fenêtre avec ⌥⌘-clic', 'Open a link in a mini window with ⌥⌘-click'), 'navigation', 'littleArcModifier', { fold: true, patch: { littleArcModifier: true }, on: true, why: behaviour, place: 'bottom' }),
  setting('fn-little-new-tab-links', 'little-new-tab-links', t('Ouvrir en mini-fenêtre les liens qui ouvrent un nouvel onglet', 'Open links that open a new tab in a mini window'), 'navigation', 'littleArcNewTabLinks', { fold: true, why: behaviour }),
  setting('fn-little-download-bubble', 'little-download-bubble', t('Bulle d’actions après un téléchargement dans une mini-fenêtre', 'Actions bubble after a mini window download'), 'navigation', 'littleDownloadBubble', { fold: true, label: t('Afficher une bulle d’actions après un téléchargement', 'Show an actions bubble after a download'), patch: { littleDownloadBubble: true }, on: true, why: needsDownload, place: 'bottom' }),
  setting('fn-boost-sharing', 'boost-sharing', t('Partage de Retouches et de thèmes', 'Tweak and theme sharing'), 'tools', 'boostSharing', { fold: true, label: t('Activer le partage de Retouches et de thèmes', 'Turn on sharing of Tweaks and themes'), why: 'le partage passe par un code à copier, sans écran à lui' }),
  // The panel itself would be the image (`{ patch: { qrCode: true }, overlay: { request: { panel: 'qr', text: '$url' }, wait: '.qr-code' } }`, cropped to
  // `.qr-panel`), but it draws an unreadable code today: `.tk-panel svg` (renderer/templates/primitives.css) gives the path of the code a round stroke of
  // the colour of the text. Its row until that is fixed.
  setting('fn-qr-code', 'qr-code', t('Code QR d’une page ou d’un lien', 'QR code for a page or a link'), 'features', 'qrCode', {
    patch: { qrCode: true },
    on: true,
    why: 'le panneau du code QR dessine aujourd’hui un code illisible (trait de .tk-panel svg sur le chemin du code) : sa ligne en attendant'
  }),
  setting('fn-back-closes-tab', 'back-closes-tab', t('Précédent ferme l’onglet ouvert depuis un lien', 'Back closes a tab opened from a link'), 'tabs', 'backClosesOpenedTab', { fold: true, label: t('Le bouton Précédent ferme l’onglet ouvert depuis un lien', 'The Back button closes the tab opened from a link'), why: behaviour }),
  {
    card: 'fn-search-bangs',
    feature: 'search-bangs',
    title: t('Mots-clés « ! » dans la barre de commandes', '“!” keywords in the command bar'),
    evidence: 'none',
    alt: t('La barre de commandes et ses mots-clés « ! »', 'The command bar and its “!” keywords'),
    todo: 'sa ligne des Réglages et la barre de commandes listent les mots-clés par le nom des moteurs de recherche (dont ceux d’autres navigateurs), que le site ne nomme pas'
  },
  setting('fn-search-discovery', 'search-discovery', t('Proposer d’ajouter la recherche d’un site', 'Offer to add a site’s search'), 'navigation', 'searchDiscovery', { fold: true, why: 'la proposition vient d’un site qui déclare sa recherche, que la démonstration n’a pas', place: 'bottom' }),
  // The feature itself: the keyword of an extension of the demonstration, then a word, typed in the command bar. (Its row of Réglages names the API of
  // the extensions by its name in code, which the site does not show.)
  direct('fn-omnibox-keywords', 'omnibox-keywords', t('Mots-clés d’extension dans la barre de commandes', 'Extension keywords in the command bar'), t(
    'La barre de commandes : « glo » puis un mot, et la première ligne envoie ce mot à l’extension Glossaire, dont c’est le mot-clé',
    'The command bar: “glo” then a word, and the first row sends that word to the Glossary extension, whose keyword it is'
  ), {
    space: 'work',
    tab: 'notes',
    patch: { omniboxKeywords: true },
    demoExtension: 'keyword',
    commandBar: { text: t('glo sérendipité', 'glo serendipity'), expect: 'extension' }
  }, overlayCrop('.palette', 820)),
  setting('fn-independent-windows', 'independent-windows', t('Fenêtres aux onglets indépendants', 'Windows with independent tabs'), 'features', 'independentWindows', { why: 'demande de redémarrer l’application' }),
  setting('fn-pwa', 'pwa', t('Ouvrir un site comme application', 'Open a site as an app'), 'features', 'webAppWindows', { patch: { webAppWindows: true }, on: true, why: 'une application de site s’ouvre dans une fenêtre et une icône du Dock à elle' }),
  setting('fn-document-pip', 'document-pip', t('Image dans l’image des appels vidéo', 'Picture in Picture for video calls'), 'features', 'documentPictureInPicture', { why: 'la fenêtre ne s’ouvre que pendant un appel vidéo, que la démonstration n’a pas' }),

  // ---- Données et sauvegardes ----
  shot('fn-import-espaces', undefined, t('Import des espaces et des onglets', 'Import of Spaces and tabs'), 'import', t(
    'La feuille d’import : un fichier de signets prêt à importer, 12 signets dans 3 dossiers, et rien d’importé avant de confirmer',
    'The import sheet: a bookmarks file ready to import, 12 bookmarks in 3 folders, and nothing imported before you confirm'
  )),
  direct('fn-import-navigateurs', undefined, t('Import depuis d’autres navigateurs', 'Import from other browsers'), t(
    'La barre latérale juste après un import : le nouvel espace des signets importés, ses onglets épinglés et ses dossiers',
    'The sidebar right after an import: the new Space of the imported bookmarks, its pinned tabs and its folders'
  ), { space: 'work', tab: 'notes', importBookmarks: 'done' }, sidebarCrop),
  // The line of buttons of the export (ExportData.tsx, where a search for `exportData` lands), the only line of buttons of the page, in its fold.
  setting('fn-export-donnees', undefined, t('Export des données, chiffré si vous voulez', 'Data export, encrypted if you like'), 'files', '.pref-buttons', { fold: true, shows: t('le bouton « Exporter les données » et la case qui chiffre l’export avec une phrase secrète', 'the “Export Data” button and the box that encrypts the export with a passphrase'), quote: t('Exporter les données', 'Export Data'), why: 'l’export écrit un fichier : son réglage est ce qui se voit' }),
  setting('fn-export-signets', undefined, t('Export des signets', 'Bookmarks export'), 'files', 'exportBookmarks', { fold: true, label: t('Exporter les signets (HTML)', 'Export Bookmarks (HTML)'), why: 'l’export écrit un fichier : son réglage est ce qui se voit' }),
  command('fn-export-markdown', undefined, t('Export Markdown', 'Markdown export'), t(
    'La barre de commandes propose « Exporter la page en Markdown » pour le carnet de notes à l’écran',
    'The command bar offers “Export Page as Markdown” for the notebook on screen'
  ), t('markdown', 'markdown'), t('Exporter la page en Markdown', 'Export Page as Markdown'), 'l’export écrit un fichier : sa commande est ce qui se voit'),
  setting('fn-auto-backup', 'auto-backup', t('Copies automatiques de la session', 'Automatic session backups'), 'files', 'autoBackup', { label: t('Garder des copies automatiques de mes espaces et onglets', 'Keep automatic backups of my Spaces and tabs'), why: background }),
  setting('fn-favicons', 'favicons', t('Chercher l’icône des sites sans icône', 'Look up icons for sites without one'), 'files', 'resolveFavicons', { fold: true, label: t('Récupérer les icônes des favoris et des onglets sans icône', 'Fetch icons for favorites and tabs without one'), why: network }),
  setting('fn-tidy-downloads', 'tidy-downloads', t('Épurer le nom des téléchargements', 'Clean up download names'), 'files', 'tidyDownloads', { fold: true, patch: { tidyDownloads: true }, on: true, why: needsDownload }),
  setting('fn-native-hosts', 'native-hosts', t('Hôtes de messagerie native des autres navigateurs', 'Native messaging hosts of other browsers'), 'tools', 'chromeNativeHosts', { fold: true, label: t('Laisser les extensions joindre les programmes installés pour un autre navigateur (messagerie native)', 'Let extensions reach programs installed for another browser (native messaging)'), why: needsExtension }),
  setting('fn-download-pause', 'download-pause', t('Pause et reprise des téléchargements', 'Pause and resume downloads'), 'features', 'downloadPause', { patch: { downloadPause: true }, on: true, why: needsDownload }),
  setting('fn-download-resume', 'download-resume', t('Reprendre les téléchargements après un redémarrage', 'Resume downloads after a restart'), 'files', 'downloadResume', { fold: true, why: needsDownload }),
  setting('fn-download-ask-where', 'download-ask-where', t('Demander où enregistrer chaque fichier', 'Ask where to save each file'), 'files', 'downloadAskWhere', { patch: { downloadAskWhere: true }, on: true, why: needsDownload }),
  setting('fn-open-with', 'open-with', t('Mémoriser l’application d’ouverture par type', 'Remember the opening app by type'), 'files', 'openWithMemory', { fold: true, label: t('Mémoriser l’application d’ouverture par type de fichier', 'Remember the opening app for each file type'), patch: { openWithMemory: true }, on: true, why: needsDownload }),
  setting('fn-open-unsaved', 'open-unsaved', t('Ouvrir sans l’enregistrer', 'Open Without Saving'), 'features', 'openUnsaved', { patch: { openUnsaved: true }, on: true, why: needsDownload }),
  setting('fn-pdf-with-source', 'pdf-with-source', t('Enregistrer en PDF avec l’adresse', 'Save as PDF with the address'), 'features', 'pdfWithSource', { patch: { pdfWithSource: true }, on: true, why: 'agit sur le fichier PDF enregistré' }),
  setting('fn-tab-reminders', 'tab-reminders', t('Rappel d’onglet', 'Tab reminders'), 'features', 'tabReminders', { patch: { tabReminders: true }, on: true, why: 'agit à l’heure choisie (notification locale) : la démonstration ne peut pas attendre' }),
  direct('fn-bookmarks', 'bookmarks', t('Bibliothèque de signets avec étiquettes', 'Bookmark library with tags'), t(
    'La bibliothèque de signets : trois pages gardées avec leurs étiquettes, prêtes à chercher ou à trier',
    'The bookmark library: three pages kept with their tags, ready to search or sort'
  ), {
    space: 'work',
    tab: 'notes',
    patch: { bookmarkManager: true },
    bookmarks: [
      { tab: 'style-guide', tags: { fr: ['projet', 'référence'], en: ['project', 'reference'] } },
      { tab: 'glossary', tags: { fr: ['projet'], en: ['project'] } },
      { tab: 'naming', tags: { fr: ['lecture'], en: ['reading'] } }
    ],
    overlay: { request: { panel: 'bookmarks' }, wait: '.lp.bookmarks' }
  }, overlayCrop('.lp.bookmarks')),
  shot('fn-notes', 'notes', t('Notes rapides', 'Quick notes'), 'quick-notes', t(
    'Les notes rapides au-dessus des recettes de saison : deux notes de cette page, une de l’espace, une autre ailleurs',
    'Quick notes over the seasonal recipes: two notes on this page, one on the Space, another elsewhere'
  )),

  // ---- Interface ----
  shot('fn-barre-commandes', undefined, t('Barre de commandes', 'Command bar'), 'command-bar-calc', t(
    'La barre de commandes d’un nouvel onglet (⌘T) : le calcul 12*(3+4) et son résultat en première ligne',
    'The command bar of a new tab (⌘T): the calculation 12*(3+4) and its result on the first row'
  )),
  direct('fn-background-framing', undefined, t('Cadrage du fond vidéo d’un espace', 'Background video framing'), t(
    'Le cadre d’une vidéo de fond dans « Personnaliser l’espace » : la vidéo entière et le cadre de la forme de la barre latérale',
    'The frame of a background video in “Customize Space”: the whole video and the frame the shape of the sidebar'
  ), { space: 'projects', tab: 'maps', framing: { moves: 4 } }, { ...overlayCrop('.media-framing', 520), pad: 10 }),
  shot('fn-themes', undefined, t('Thèmes d’espace', 'Space themes'), 'space-themes', t(
    'Le panneau des thèmes de l’espace Projets : les thèmes prêts, la couleur de départ, la teinte, l’intensité et la texture',
    'The theme panel of the Projects Space: the ready-made themes, the starting color, hue, intensity and texture'
  )),
  command('fn-captures', undefined, t('Captures', 'Screenshots'), t(
    'La barre de commandes propose les captures : la partie visible, une zone ou la page entière',
    'The command bar offers the screenshots: the visible part, an area or the whole page'
  ), t('capturer', 'capture'), t('Capturer la partie visible', 'Capture Visible Area'), 'la capture elle-même passe par une sélection à la souris : ses commandes sont ce qui se voit'),
  setting('fn-raccourcis', undefined, t('Raccourcis modifiables', 'Custom shortcuts'), 'keyboard', 'keyBindings', { sub: 'shortcuts', shows: t('la liste de tous les raccourcis, chacun modifiable, et sa recherche', 'the list of every shortcut, each one changeable, and its search'), why: 'les raccourcis se modifient dans cette liste des Réglages' }),
  setting('fn-icone', undefined, t('Icône de l’app', 'App icon'), 'about', 'appIcon', { shows: t('le groupe « Icône de l’application », ses icônes au choix', 'the “App icon” group, its icons to choose from'), quote: t('Icône de l’application', 'App icon'), why: 'l’icône se choisit ici et s’affiche dans le Dock, hors de la fenêtre' }),
  // The demonstration turns the previews off (demo.ts): the row shows the default of the application.
  setting('fn-hover-cards', 'hover-cards', t('Aperçus au survol des onglets', 'Tab hover previews'), 'appearance', 'hoverCards', { fold: true, label: t('Afficher les aperçus au survol des onglets', 'Show previews when hovering over tabs'), patch: { hoverCards: true }, why: 'l’aperçu n’apparaît que sous le pointeur, que l’outil laisse au bord de l’écran' }),
  setting('fn-tidy-pinned-titles', 'tidy-pinned-titles', t('Épurer les titres des onglets épinglés', 'Clean up the titles of pinned tabs'), 'tabs', 'tidyPinnedTitles', {
    fold: true,
    patch: { tidyPinnedTitles: true },
    on: true,
    why: 'n’épure que les titres qui répètent le nom du site, que les pages de la démonstration n’ont pas'
  }),
  direct('fn-reload-all-button', 'reload-all-button', t('Bouton « Actualiser tous les onglets »', '“Reload All Tabs” button'), t(
    'Les boutons « Actualiser tous les onglets » et « Actualiser les onglets de cet espace » en haut de la barre latérale',
    'The “Reload all tabs” and “Reload this Space’s tabs” buttons at the top of the sidebar'
  ), { space: 'work', tab: 'notes', patch: { showReloadAllButton: true } }, { page: 'shell', selectors: ['.sidebar-reload-all'], minWidth: 720 }),
  direct('fn-full-url', 'full-url', t('Adresse complète dans la barre d’outils', 'Full address in the toolbar'), t(
    'La barre d’outils montre l’adresse complète de l’article « Bien nommer ses fichiers »',
    'The toolbar shows the full address of the article “Naming your files well”'
  ), { space: 'work', tab: 'naming', patch: { fullUrlInToolbar: true } }, { page: 'shell', selectors: ['.tb-address'], minWidth: 900 }),
  setting('fn-window-drag', 'window-drag', t('Déplacer la fenêtre depuis le haut des pages', 'Move the window from the top of pages'), 'tabs', 'dragWindowFromToolbar', { fold: true, why: behaviour }),
  direct('fn-sidebar-right', 'sidebar-right', t('Barre latérale à droite', 'Sidebar on the right'), t(
    'La fenêtre de Lucium avec la barre latérale à droite, le carnet de notes à l’écran',
    'The Lucium window with the sidebar on the right, the notebook on screen'
  ), { space: 'work', tab: 'notes', patch: { sidebarRight: true } }),
  setting('fn-tab-memory', 'tab-memory', t('Mémoire et processeur par onglet', 'Memory and CPU per tab'), 'features', 'showTabMemory', {
    patch: { showTabMemory: true },
    on: true,
    why: 'les mesures paraissent dans l’aperçu d’un onglet survolé, sous le pointeur, que l’outil laisse au bord de l’écran'
  }),
  setting('fn-download-status-chip', 'download-status-chip', t('Statut des téléchargements au pied de la barre', 'Download status at the foot of the sidebar'), 'files', 'downloadStatusChip', { fold: true, why: needsDownload }),
  direct('fn-favorite-names', 'favorite-names', t('Nom sous les icônes des favoris', 'Name under favorite icons'), t(
    'Les favoris en haut de la barre latérale, chacun avec son nom sous son icône',
    'The favorites at the top of the sidebar, each with its name under its icon'
  ), { space: 'work', tab: 'notes', patch: { favoriteNames: true } }, { page: 'shell', selectors: ['.favorites'], minWidth: 720 }),
  direct('fn-resource-gauge', 'resource-gauge', t('Jauge des ressources au pied de la barre latérale', 'Resource gauge at the foot of the sidebar'), t(
    'La jauge des ressources au pied de la barre latérale, ouverte : la mémoire et les onglets qui en prennent le plus',
    'The resource gauge at the foot of the sidebar, open: the memory and the tabs that take the most'
  ), { space: 'work', tab: 'board', resourcePanel: 'open' }, { page: 'shell', selectors: ['.rp-panel'], minWidth: 760 }),
  setting('fn-extension-overflow', 'extension-overflow', t('Menu des icônes d’extensions en trop', 'Extension icons overflow menu'), 'tools', 'extensionOverflow', { fold: true, why: needsExtension }),
  setting('fn-read-later-folders', 'read-later-folders', t('Dossiers dans Lire plus tard', 'Folders in Read Later'), 'files', 'useReadLaterFolders', { fold: true, label: t('Classer « Lire plus tard » dans des dossiers', 'Sort “Read Later” into folders'), patch: { useReadLaterFolders: true }, on: true, why: 'les dossiers se créent à la main dans la liste' }),
  command('fn-mode-lisible', undefined, t('Contraste de la page, site par site', 'Page Contrast, site by site'), t(
    'La barre de commandes propose le contraste de la page pour le site à l’écran : sombre, clair ou original',
    'The command bar offers the page contrast for the site on screen: dark, light or original'
  ), t('contraste de la page', 'page contrast'), t('Contraste de la page : sombre pour ce site', 'Page Contrast: Dark for This Site'), 'le choix se fait site par site : ses commandes le montrent mieux qu’une page déjà réglée'),
  direct('fn-card-outline', 'card-outline', t('Contour fin autour de la page', 'Thin outline around the page'), t(
    'La fenêtre de Lucium, un contour fin autour de la page du carnet de notes',
    'The Lucium window, a thin outline around the notebook page'
  ), { space: 'work', tab: 'notes', patch: { cardOutline: true } }),
  setting('fn-zoom-indicator', 'zoom-indicator', t('Repère du niveau de zoom', 'Zoom level indicator'), 'appearance', 'showZoomIndicator', { fold: true, label: t('Afficher le niveau de zoom dans la barre d’outils', 'Show the zoom level in the toolbar'), why: 'le repère ne paraît que sur une page agrandie, que l’outil ne zoome pas' }),
  direct('fn-name-windows', 'name-windows', t('Nommer les fenêtres', 'Name windows'), t(
    'La feuille « Nommer la fenêtre » : le nom s’affiche dans le menu Fenêtre',
    'The “Name window” sheet: the name shows in the Window menu'
  ), { space: 'work', tab: 'notes', patch: { nameWindows: true }, overlay: { request: { panel: 'windowname' }, wait: '.sh' } }, overlayCrop('.sh')),
  setting('fn-interface-language', 'interface-language', t('Interface traduite', 'Translated interface'), 'home', 'interfaceTranslated', { label: t('Langue de l’interface', 'Interface language'), why: 'la langue se voit partout : sa ligne dit d’où elle vient' }),
  // A page in the other language than the interface's, and the button of the toolbar that offers to translate it, clicked. (The full panel names
  // the server the models of the other engine come from.)
  direct('fn-translate-local', 'translate-local', t('Traduire une page sur cet ordinateur', 'Translate a page on this computer'), t(
    'Un article en anglais : le bouton de traduction de la barre d’outils propose de le traduire en français, sur ce Mac',
    'An article in French: the translation button of the toolbar offers to translate it into English, on this Mac'
  ), { space: 'projects', tab: 'maps', foreignPage: 'maps', click: { selector: '.tb-translate', wait: '.translate-pop' } }, overlayCrop('.translate-pop', 820)),
  direct('fn-command-bar-calc', 'command-bar-calc', t('Calculatrice dans la barre de commandes', 'Calculator in the command bar'), t(
    'La barre de commandes calcule (48+12)/4 et donne le résultat en première ligne',
    'The command bar works out (48+12)/4 and gives the result on the first row'
  ), { space: 'work', tab: 'notes', commandBar: { text: t('(48+12)/4', '(48+12)/4'), expect: 'calc' } }, overlayCrop('.palette', 820)),
  direct('fn-shortcut-help', 'shortcut-help', t('Aide des raccourcis', 'Shortcut help'), t(
    'L’aide des raccourcis : chaque raccourci de Lucium, rangé par contexte, avec sa recherche',
    'Shortcut help: every Lucium shortcut, grouped by context, with its search'
  ), { space: 'work', tab: 'notes', overlay: { request: { panel: 'shortcuts' }, wait: '.sk' } }, overlayCrop('.sk', 900)),
  direct('fn-compact-mode', 'compact-mode', t('Mode compact', 'Compact mode'), t(
    'La fenêtre de Lucium en mode compact, le carnet de notes à l’écran',
    'The Lucium window in compact mode, the notebook on screen'
  ), { space: 'work', tab: 'notes', patch: { compactMode: true } }),
  setting('fn-annotate-capture', 'annotate-capture', t('Annoter les captures avant de les enregistrer', 'Annotate captures before saving'), 'features', 'annotateCapture', { patch: { annotateCapture: true }, on: true, why: 'la feuille d’annotation suit une capture à la souris, que l’outil ne fait pas' }),

  // ---- Application ----
  shot('fn-extensions', undefined, t('Extensions', 'Extensions'), 'extensions', t(
    'La page Extensions, ouverte dans un onglet, avec l’extension Surligneur chargée depuis un dossier',
    'The Extensions page, open in a tab, with the Highlighter extension loaded from a folder'
  )),
  // The panel is cropped whole: its section of the extensions is the one unfolded, with the puzzle-piece button at the end of the row.
  direct('fn-extensions-page', undefined, t('Page Extensions depuis le panneau du site', 'Extensions page from the site panel'), t(
    'Le panneau « Infos et réglages du site » : la rangée des extensions et son bouton en pièce de puzzle qui ouvre la page Extensions',
    'The “Site Info and Settings” panel: the extensions row and its puzzle-piece button that opens the Extensions page'
  ), { space: 'work', tab: 'notes', siteExtensions: true }, overlayCrop('.scc')),
  direct('fn-gestionnaire-taches', undefined, t('Gestionnaire de tâches', 'Task manager'), t(
    'Le gestionnaire de tâches de Lucium : chaque onglet et chaque processus, avec sa mémoire et son processeur',
    'The Lucium task manager: each tab and each process, with its memory and CPU'
  ), { space: 'work', tab: 'notes', menu: { label: t('Ouvrir le gestionnaire de tâches', 'Open Task Manager'), opens: 'taskmanager' } }, undefined, { window: 'taskmanager' }),
  shot('fn-reglage-guide', undefined, t('Régler en quelques questions', 'Set up in a few questions'), 'settings-guide', t(
    '« Régler en quelques questions », lancé depuis Réglages › Pour commencer : la question de la vie privée « Que bloquer pendant que vous naviguez ? »',
    '“Set up in a few questions”, started from Settings › Start here: the privacy question “What to block while you browse?”'
  )),
  setting('fn-auto-update', 'auto-update', t('Rechercher les mises à jour automatiquement', 'Check for updates automatically'), 'about', 'autoUpdate', { why: background }),
  // The demonstration never asks before quitting (demo.ts): the row shows the default; it is put back before the application quits.
  setting('fn-warn-quit', 'warn-quit', t('Avertir avant de quitter', 'Warn before quitting'), 'tabs', 'warnBeforeQuitting', { patch: { warnBeforeQuitting: true }, why: 'agit au moment de quitter' }),
  setting('fn-restore-windows', 'restore-windows', t('Rouvrir les fenêtres de la session précédente', 'Reopen windows from the previous session'), 'tabs', 'restoreWindows', { label: t('Quand vous ouvrez Lucium', 'When you open Lucium'), choice: t('Rouvrir mes fenêtres, charger l’onglet affiché', 'Reopen my windows, load the tab shown'), patch: { loadAllTabsAtLaunch: false }, why: 'agit au lancement suivant' }),
  {
    card: 'fn-web-store',
    feature: 'web-store',
    // As the page writes it: the site never names the store.
    title: t('Installer depuis la boutique d’extensions en ligne', 'Install from the online extension store'),
    evidence: 'none',
    alt: t(
      'Réglages › Extensions et outils › Plus de réglages : l’installation depuis la boutique d’extensions en ligne',
      'Settings › Extensions and tools › More settings: installing from the online extension store'
    ),
    todo:
      'tout ce que la fonction montre nomme la boutique d’un autre navigateur (sa ligne et son aide dans les Réglages, la feuille d’installation, la commande ' +
      'qui ouvre la boutique), et la fiche de la boutique est une page de son éditeur, sur Internet : rien à montrer sans ce nom, que le site ne montre pas'
  },
  // At the foot of the image: the row of the translation under it names Apple (« Traduire d’abord avec macOS »), which the site does not; settings-rows.test.ts.
  setting('fn-battery-saver', 'battery-saver', t('Mode économie de batterie', 'Battery Saver Mode'), 'tools', 'batterySaver', { fold: true, why: 'agit sur batterie, selon l’état du Mac', place: 'bottom' }),
  setting('fn-warn-close-window', 'warn-close-window', t('Avertir avant de fermer une fenêtre de plusieurs onglets', 'Warn before closing a window with several tabs'), 'tabs', 'warnBeforeClosingWindow', { patch: { warnBeforeClosingWindow: true }, on: true, why: 'agit au moment de fermer la fenêtre' }),
  setting('fn-applescript', 'applescript', t('Commandes par adresse lucium:// (AppleScript, Raccourcis)', 'lucium:// address commands (AppleScript, Shortcuts)'), 'features', 'urlAutomation', { label: t('Commandes par adresse lucium:// (AppleScript, Raccourcis)', 'Commands by lucium:// address (AppleScript, Shortcuts)'), patch: { urlAutomation: true }, on: true, why: 'les commandes viennent d’une autre application' }),
  direct('fn-whats-new', 'whats-new', t('Nouveautés après une mise à jour', 'What’s new after an update'), t(
    'La feuille des nouveautés de la version, ouverte par Aide › Nouveautés : tous ses changements, lus dans un fichier livré avec l’application',
    'The sheet of the version’s news, opened from Help › What’s New: all its changes, read from a file shipped with the app'
  ), {
    space: 'work',
    tab: 'notes',
    menu: { label: t('Nouveautés', 'What’s New'), wait: '.card.news' },
    // The first points of 1.0.0 name the API of the extensions as code does (`chrome.webRequest`), the store of the extensions and the engine,
    // which the site does not show: the list is shown from a later point, the first « Certificat client » of the version (its section Changements).
    // A version that no longer has this one fails the scene, listing its points: choose another one then.
    newsFrom: t('Certificat client', 'Client certificate')
  }, overlayCrop('.card.news', 900))
]

// ---------- names, plan ----------

/** The image of a card in a language, as the site names it: `<card>-<lang>-light.webp`. */
export const outputName = (card: string, lang: Lang): string => `${card}-${lang}-${FEATURE_THEME}.webp`

/** The image a `shot` scenario keeps: the one the site already has, `<shot>-<lang>-light.webp` (README of the site, « Captures d’écran »). */
export const shotImageName = (shotId: string, lang: Lang): string => `${shotId}-${lang}-${FEATURE_THEME}.webp`

/** The scenarios the tool captures (the others keep a shot of the site, or wait). */
export const capturable = (scenario: FeatureScenario): boolean => scenario.evidence !== 'shot' && scenario.evidence !== 'none'

/** The window a scenario captures. */
export const windowOf = (scenario: FeatureScenario): WindowKind => scenario.window ?? 'main'

/**
 * The order of a session: the main window first, while it has the focus; then the windows that take it (a private window, the task manager);
 * then the Settings window, which keeps it once open. Within a kind, the order of the page.
 */
const WINDOW_ORDER: Readonly<Record<WindowKind, number>> = { main: 0, little: 1, private: 2, taskmanager: 3, settings: 4 }

export interface FeaturePlanOptions {
  langs: readonly Lang[]
  /** Card ids; empty or absent: every card. */
  only?: readonly string[]
  /** Leaves out a card whose image of the language is already there (`--missing`): the run picks up where it stopped. */
  done?: (card: string, lang: Lang) => boolean
}

export interface FeatureSession {
  lang: Lang
  scenarios: FeatureScenario[]
}

/** The sessions of a run: one per language, the capturable scenarios asked for, in the order of the windows. */
export function planFeatures(scenarios: readonly FeatureScenario[], options: FeaturePlanOptions): FeatureSession[] {
  const only = options.only ?? []
  const wanted = scenarios.filter((s) => capturable(s) && (only.length === 0 || only.includes(s.card)))
  const ordered = wanted.map((s, index) => ({ s, index })).sort((a, b) => WINDOW_ORDER[windowOf(a.s)] - WINDOW_ORDER[windowOf(b.s)] || a.index - b.index).map(({ s }) => s)
  return options.langs.map((lang) => ({ lang, scenarios: ordered.filter((s) => !(options.done?.(s.card, lang) ?? false)) })).filter((session) => session.scenarios.length > 0)
}

/** The cards `--only` names that the table does not have. */
export const unknownCards = (scenarios: readonly FeatureScenario[], only: readonly string[]): string[] => only.filter((card) => !scenarios.some((s) => s.card === card))

// ---------- the crop ----------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The part of the window an image keeps, in points: a 16:10 box (the thumbnails of the page) around the target, at least `minWidth` wide and as large
 * as the target with `pad` around it, within the window. A target taller than the largest box keeps its top. Never wider or taller than the window.
 */
export function cropRegion(target: Rect, window: { width: number; height: number }, options: { minWidth?: number; pad?: number; aspect?: number; grow?: boolean } = {}): Rect {
  const aspect = options.aspect ?? THUMB_ASPECT
  const pad = options.pad ?? 24
  const largest = Math.min(window.width, window.height * aspect)
  const tall = options.grow === false ? 0 : (target.height + 2 * pad) * aspect
  const width = Math.min(largest, Math.max(target.width + 2 * pad, options.minWidth ?? 720, tall))
  const height = width / aspect
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0))
  const x = clamp(target.x + target.width / 2 - width / 2, window.width - width)
  const y = clamp(target.height + 2 * pad <= height ? target.y + target.height / 2 - height / 2 : target.y - pad, window.height - height)
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/**
 * The box of a scenario in its window: around the target (`cropRegion`), the top of the window for `anchor: 'top'`, the whole window (in its 16:10
 * box, from the top) without a crop or a target.
 */
export function regionFor(crop: CropTarget | undefined, target: Rect | null, window: { width: number; height: number }): Rect {
  const whole = { x: 0, y: 0, width: window.width, height: window.height }
  if (!crop || !target || crop.anchor === 'top') return cropRegion(whole, window, { minWidth: crop?.minWidth ?? window.width, pad: 0 })
  return cropRegion(target, window, { ...(crop.minWidth !== undefined ? { minWidth: crop.minWidth } : {}), ...(crop.pad !== undefined ? { pad: crop.pad } : {}), ...(crop.grow === false ? { grow: false } : {}) })
}

/** Whether the top of the target (its first 40 points, or all of it) is in the box: a row pushed out of the image is a failed capture. */
export const showsTarget = (region: Rect, target: Rect): boolean =>
  target.x >= region.x - 1 && target.x + target.width <= region.x + region.width + 1 && target.y >= region.y - 1 && target.y + Math.min(target.height, 40) <= region.y + region.height + 1

/** The region in the pixels of the capture (the window at the scale of the screen), within the image. */
export function pixelCrop(region: Rect, scale: number, image: { width: number; height: number }): Rect {
  const x = Math.min(Math.max(Math.round(region.x * scale), 0), image.width - 1)
  const y = Math.min(Math.max(Math.round(region.y * scale), 0), image.height - 1)
  return { x, y, width: Math.max(1, Math.min(Math.round(region.width * scale), image.width - x)), height: Math.max(1, Math.min(Math.round(region.height * scale), image.height - y)) }
}

/** The arguments of ImageMagick that cut the region out of the capture and make the WebP of the site, `width` px wide at most (never enlarged). */
export function cropWebpArgs(input: string, output: string, crop: Rect, width: number = FEATURE_WIDTH): string[] {
  return [input, '-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage', '-resize', `${width}x>`, '-strip', '-quality', '84', '-define', 'webp:method=6', output]
}

/** The arguments of ImageMagick that cut the region out of the capture at its full size, for tesseract to read (a PNG, never kept). */
export const ocrCropArgs = (input: string, output: string, crop: Rect): string[] => [input, '-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage', output]

/**
 * The arguments of tesseract that read the text of that PNG and write it on its standard output. English is enough for the names (Latin letters),
 * and is the language Homebrew installs with it.
 */
export const tesseractArgs = (image: string): string[] => [image, 'stdout', '-l', 'eng']

/** The width and height of a WebP file, read from its header (VP8X, VP8L or VP8 chunk); null for anything else. */
export function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u24 = (at: number) => view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
  const chunk = ascii(12, 16)
  if (chunk === 'VP8X') return { width: 1 + u24(24), height: 1 + u24(27) }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  return null
}

// ---------- what the image shows, and the manifest ----------

/** What the image of a scenario shows, in French: the line of `--dry-run` and the `shows` of the manifest. */
export function shows(scenario: FeatureScenario): string {
  const scene = scenario.scene
  if (scenario.evidence === 'shot') return `l’image de la prise « ${scenario.shot} » du site`
  if (scenario.evidence === 'none') return 'pas encore de capture'
  if (scenario.evidence === 'setting' && scene?.settings) {
    const where = settingsPlace(scene.settings.pane, { ...(scene.settings.fold ? { fold: scene.settings.fold } : {}), ...(scene.settings.sub ? { sub: scene.settings.sub } : {}) }).fr
    return `${where}, la ligne « ${scene.settings.row} »${scene.patch ? ` (${Object.keys(scene.patch).join(', ')} changé pour l’image)` : ''}`
  }
  if (scenario.evidence === 'command' && scene?.commandBar) return `la barre de commandes, « ${scene.commandBar.text.fr} » tapé`
  const parts: string[] = []
  if (scene?.menu) parts.push(`menu « ${scene.menu.label.fr} »`)
  if (scene?.newsFrom) parts.push(`tous les points, à partir de « ${scene.newsFrom.fr} »`)
  if (scene?.sessions) parts.push(`${scene.sessions.length} sessions enregistrées`)
  if (scene?.demoExtension) parts.push(`extension de démonstration « ${scene.demoExtension} » chargée`)
  if (scene?.tabGroup) parts.push(`groupe d’onglets « ${scene.tabGroup.title.fr} » fait par l’extension`)
  if (scene?.overlay) parts.push(`panneau ${String(scene.overlay.request['panel'])}`)
  if (scene?.commandBar) parts.push(`barre de commandes « ${scene.commandBar.text.fr} »`)
  if (scene?.find) parts.push(`recherche « ${scene.find.text.fr} »`)
  if (scene?.foreignPage) parts.push(`page « ${scene.foreignPage} » dans l’autre langue`)
  if (scene?.click) parts.push(`clic sur ${scene.click.selector}`)
  if (scene?.patch) parts.push(`${Object.keys(scene.patch).join(', ')} activé`)
  if (scene?.importBookmarks) parts.push(`import ${scene.importBookmarks}`)
  if (scene?.resourcePanel) parts.push(`panneau des ressources ${scene.resourcePanel}`)
  return `${windowOf(scenario) === 'main' ? 'fenêtre principale' : `fenêtre ${windowOf(scenario)}`}${parts.length > 0 ? ` : ${parts.join(', ')}` : ''}`
}

export interface ManifestFile {
  file: string
  width: number | null
  height: number | null
}

export interface ManifestCard {
  card: string
  feature?: string
  evidence: Evidence
  /** What the image shows (French). */
  shows: string
  /** Why the feature itself is not what the image shows (indirect evidence). */
  why?: string
  /** `capture`: an image of this tool (out-captures/features/); `site`: an image the site already has (a shot of shots.ts). */
  source: 'capture' | 'site' | 'none'
  alt: Localized<string>
  /** The image of each language; null while it is not taken. */
  files: Record<Lang, ManifestFile | null>
  todo?: string
}

export interface Manifest {
  version: 1
  theme: typeof FEATURE_THEME
  /** The widest image, in pixels. */
  width: number
  cards: ManifestCard[]
}

/**
 * The manifest of the images of the features page, for every card of the table: its files (those that exist, with their size), its alternative text
 * in both languages, and what it shows. `sizeOf(name)`: the size of an image of the output folder, or null when it is not there.
 */
export function buildManifest(scenarios: readonly FeatureScenario[], sizeOf: (name: string) => { width: number; height: number } | null, langs: readonly Lang[] = ['fr', 'en']): Manifest {
  const cards = scenarios.map((scenario): ManifestCard => {
    const files = {} as Record<Lang, ManifestFile | null>
    for (const lang of langs) {
      if (scenario.evidence === 'shot' && scenario.shot) files[lang] = { file: shotImageName(scenario.shot, lang), width: null, height: null }
      else if (scenario.evidence === 'none') files[lang] = null
      else {
        const name = outputName(scenario.card, lang)
        const size = sizeOf(name)
        files[lang] = size ? { file: name, width: size.width, height: size.height } : null
      }
    }
    return {
      card: scenario.card,
      ...(scenario.feature ? { feature: scenario.feature } : {}),
      evidence: scenario.evidence,
      shows: shows(scenario),
      ...(scenario.why ? { why: scenario.why } : {}),
      source: scenario.evidence === 'shot' ? 'site' : scenario.evidence === 'none' ? 'none' : 'capture',
      alt: scenario.alt,
      files,
      ...(scenario.todo ? { todo: scenario.todo } : {})
    }
  })
  return { version: 1, theme: FEATURE_THEME, width: FEATURE_WIDTH, cards }
}

// ---------- the dry run: every scenario against the sources ----------

/** What the dry run checks the scenarios against, read from the sources of the application and the pages of the site (no module is loaded). */
export interface ScenarioSources {
  /** The keys whose row each page of Réglages draws (SETTINGS_KEYS of src/shared/settings-catalog.ts). */
  settingsKeys: Readonly<Record<string, readonly string[]>>
  /** The ids a row of Réglages may carry instead of a key (`data-search`, SEARCH_IDS of src/shared/settings-synonyms.ts). */
  searchIds: readonly string[]
  /** The subpages of Réglages, which an address may open (SETTINGS_SUBPAGES of src/shared/ipc.ts). */
  subpages: readonly string[]
  /** The keys of the settings that have no row (NO_CONTROL_KEYS): a patch may name them too. */
  otherKeys: readonly string[]
  /** The panels the interface may open (the cases of `validOverlay`, src/main/shell/ipc.ts). */
  overlayPanels: readonly string[]
  /** The ids of the optional features (src/shared/features.ts). */
  featureIds: readonly string[]
  /** The sources of the interface (src/renderer/**: .tsx and .css), where every class of a selector must be found. */
  renderer: string
  /** The texts of the catalogues (the values of src/shared/i18n-fr.ts and i18n-en.ts), where every label of a menu must be found. */
  catalogues: Readonly<Record<Lang, ReadonlySet<string>>>
  /** The shots of the site (shots.ts). */
  shotIds: readonly string[]
  /** The cards of the features page of the site, when a checkout of it is at hand. */
  cards?: ReadonlyArray<{ id: string; feature?: string }>
}

/** The keys of each page in the text of settings-catalog.ts (`SETTINGS_KEYS = { home: [...], ... }`). */
export function parseSettingsKeys(text: string): Record<string, string[]> {
  const start = text.indexOf('export const SETTINGS_KEYS')
  const end = text.indexOf('} as const satisfies Record<SettingsPage', start)
  const keys: Record<string, string[]> = {}
  if (start < 0 || end < 0) return keys
  let pane: string | null = null
  for (const line of text.slice(start, end).split('\n')) {
    const head = /^\s{2}(\w+): \[/.exec(line)
    if (head) pane = head[1] ?? null
    if (pane) for (const match of line.matchAll(/'([A-Za-z0-9]+)'/g)) (keys[pane] ??= []).push(match[1] ?? '')
  }
  return keys
}

/** The names of an object written `export const NAME = { key: …, … }` (one key per line), such as NO_CONTROL_KEYS. */
export function parseObjectKeys(text: string, name: string): string[] {
  const start = text.indexOf(`export const ${name} =`)
  if (start < 0) return []
  const end = text.indexOf('\n}', start)
  return [...text.slice(start, end).matchAll(/^\s{2}'?([A-Za-z0-9-]+)'?:/gm)].map((match) => match[1] ?? '')
}

/** The values of a list written `export const NAME = ['a', 'b'] as const`, such as SEARCH_IDS. */
export function parseConstList(text: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(text)
  return match ? [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '') : []
}

/** The panels `validOverlay` accepts: its `case '…':` lines, up to the end of the function. */
export function parseOverlayPanels(text: string): string[] {
  const start = text.indexOf('export function validOverlay')
  if (start < 0) return []
  const end = text.indexOf('\n}\n', start)
  return [...text.slice(start, end).matchAll(/case '([a-z]+)':/g)].map((match) => match[1] ?? '')
}

/** The ids of the features in the text of src/shared/features.ts (the entries of FEATURES). */
export function parseFeatureIds(text: string): string[] {
  const start = text.indexOf('export const FEATURES')
  return start < 0 ? [] : [...text.slice(start).matchAll(/^\s{4}id: '([a-z0-9-]+)',$/gm)].map((match) => match[1] ?? '')
}

/** The values of a catalogue (`'key': 'value',` lines of src/shared/i18n-*.ts), unescaped. */
export function parseCatalogue(text: string): Set<string> {
  return new Set([...text.matchAll(/^\s+'[^']+': '((?:[^'\\]|\\.)*)',?$/gm)].map((match) => (match[1] ?? '').replace(/\\(.)/g, '$1')))
}

/**
 * The cards of the features page: `<li class="fx-item …" id="fn-…" … data-feature="…">` since its redesign, `<li class="fn" id="…">` before. The
 * page orders them by theme, the essential ones first: the table keeps its own order (the order of the captures), the dry run compares the sets.
 */
export function parseCards(html: string): Array<{ id: string; feature?: string }> {
  return [...html.matchAll(/<li class="(?:fn|fx-item(?: [^"]*)?)" id="(fn-[^"]+)"([^>]*)>/g)].map((match) => {
    const feature = /data-feature="([^"]+)"/.exec(match[2] ?? '')?.[1]
    return { id: match[1] ?? '', ...(feature ? { feature } : {}) }
  })
}

/** The classes a selector names (`.card.sessions [x]` → card, sessions). */
export const selectorClasses = (selector: string): string[] => [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1] ?? '')

const inSources = (renderer: string, name: string): boolean => new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(renderer)

/** The selectors a scenario relies on: its crop, and what its scene waits for. */
function selectorsOf(scenario: FeatureScenario): string[] {
  const scene = scenario.scene
  const list = [...(scenario.crop?.page === 'window' && scene?.settings?.row ? [] : (scenario.crop?.selectors ?? []))]
  if (scene?.overlay) list.push(scene.overlay.wait)
  if (scene?.menu?.wait) list.push(scene.menu.wait)
  if (scene?.click) list.push(scene.click.selector, scene.click.wait)
  return list
}

/**
 * Every scenario checked against the sources, without starting the application: one per card of the page (and only those), the feature of the card,
 * the page, the subpage and the row of a setting, the panel of a request, the classes of each selector, the labels of each menu, the keys of each patch, the
 * shot an image is kept from, and an alternative text in both languages. The problems found, in French; none: the run may start.
 */
export function checkScenarios(scenarios: readonly FeatureScenario[], sources: ScenarioSources): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const outputs = new Set<string>()
  const allKeys = new Set([...Object.values(sources.settingsKeys).flat(), ...sources.otherKeys])
  for (const s of scenarios) {
    const where = s.card
    if (seen.has(s.card)) problems.push(`${where} : deux scénarios pour la même carte`)
    seen.add(s.card)
    for (const lang of ['fr', 'en'] as const) {
      const name = outputName(s.card, lang)
      if (outputs.has(name)) problems.push(`${where} : le nom ${name} est déjà pris`)
      outputs.add(name)
      if (!s.alt[lang]?.trim()) problems.push(`${where} : pas de texte de remplacement en ${lang}`)
      if (!s.title[lang]?.trim()) problems.push(`${where} : pas de titre en ${lang}`)
    }
    if (s.alt.fr === s.alt.en) problems.push(`${where} : le texte de remplacement est le même dans les deux langues`)
    if (s.feature && !sources.featureIds.includes(s.feature)) problems.push(`${where} : la fonction ${s.feature} n’est pas dans src/shared/features.ts`)
    if (s.evidence === 'shot' && (!s.shot || !sources.shotIds.includes(s.shot))) problems.push(`${where} : la prise ${s.shot ?? '(aucune)'} n’est pas une prise de shots.ts`)
    if (s.evidence === 'none' && !s.todo?.trim()) problems.push(`${where} : pas de capture, sans raison`)
    if (INDIRECT.has(s.evidence) && !s.why?.trim()) problems.push(`${where} : une image indirecte (${s.evidence}) doit dire pourquoi`)
    if (!capturable(s)) continue
    const scene = s.scene
    if (!scene) {
      problems.push(`${where} : pas de scène`)
      continue
    }
    if (scene.settings) {
      const keys = sources.settingsKeys[scene.settings.pane]
      if (!keys) problems.push(`${where} : la page ${scene.settings.pane} n’existe pas dans Réglages`)
      const row = scene.settings.row
      if (row !== undefined && isRowSelector(row)) {
        for (const name of selectorClasses(row)) if (!inSources(sources.renderer, name)) problems.push(`${where} : la classe ${name} de la ligne ${row} n’est pas dans src/renderer`)
      } else if (row !== undefined && !(keys ?? []).includes(row) && !sources.searchIds.includes(row)) problems.push(`${where} : la ligne ${row} n’est pas dans Réglages › ${scene.settings.pane}`)
      if (scene.settings.sub !== undefined && !sources.subpages.includes(scene.settings.sub)) problems.push(`${where} : la sous-page ${scene.settings.sub} n’existe pas dans Réglages`)
      if (s.window !== 'settings') problems.push(`${where} : une scène des Réglages doit capturer la fenêtre des Réglages`)
    }
    if (scene.overlay) {
      const panel = String(scene.overlay.request['panel'] ?? '')
      if (!sources.overlayPanels.includes(panel)) problems.push(`${where} : l’interface ne peut pas ouvrir le panneau « ${panel} » (validOverlay)`)
    }
    for (const selector of selectorsOf(s)) {
      for (const name of selectorClasses(selector)) if (!inSources(sources.renderer, name)) problems.push(`${where} : la classe ${name} (${selector}) n’est pas dans src/renderer`)
    }
    if (scene.commandBar?.pick) {
      for (const lang of ['fr', 'en'] as const) if (!sources.catalogues[lang].has(scene.commandBar.pick[lang])) problems.push(`${where} : la commande « ${scene.commandBar.pick[lang]} » n’est dans aucun texte du catalogue ${lang}`)
    }
    if (scene.menu) {
      for (const lang of ['fr', 'en'] as const) if (!sources.catalogues[lang].has(scene.menu.label[lang])) problems.push(`${where} : « ${scene.menu.label[lang]} » n’est dans aucun texte du catalogue ${lang}`)
      if (scene.menu.opens && s.window !== scene.menu.opens) problems.push(`${where} : le menu ouvre ${scene.menu.opens}, la scène capture ${s.window ?? 'main'}`)
    }
    for (const key of Object.keys(scene.patch ?? {})) if (!allKeys.has(key)) problems.push(`${where} : le réglage ${key} n’existe pas`)
    if (!scene.space || !scene.tab) problems.push(`${where} : la scène ne dit pas son espace et son onglet`)
  }
  if (sources.cards) {
    const byId = new Map(scenarios.map((s) => [s.card, s]))
    for (const card of sources.cards) {
      const s = byId.get(card.id)
      if (!s) problems.push(`${card.id} : carte de la page sans scénario`)
      else if ((s.feature ?? '') !== (card.feature ?? '')) problems.push(`${card.id} : la carte dit la fonction ${card.feature ?? '(aucune)'}, le scénario ${s.feature ?? '(aucune)'}`)
    }
    for (const s of scenarios) if (!sources.cards.some((card) => card.id === s.card)) problems.push(`${s.card} : scénario sans carte sur la page`)
  }
  return problems
}
