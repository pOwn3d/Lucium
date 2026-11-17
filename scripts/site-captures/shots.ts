// The shots of the site, written as data: what each one shows, the state it needs, the window it captures, its size, and the languages and
// themes it is taken in. scripts/site-captures.mjs reads this list and puts each scene in place by the means the end-to-end tests use (the
// actions of the reducer, the requests of the interface, a Shift-click in a page); this file only says what to do, never how.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

export type Lang = 'fr' | 'en'
export type Theme = 'light' | 'dark'
export const LANGS: readonly Lang[] = ['fr', 'en']
export const THEMES: readonly Theme[] = ['light', 'dark']

/**
 * The window a shot captures: the main window, the Settings window, a mini window (mini-fenêtre), the window of the extensions, and for the captures
 * of the features page (features.ts) the task manager and a private window.
 */
export type WindowKind = 'main' | 'settings' | 'little' | 'taskmanager' | 'private'

/**
 * Where a shot is taken. `demo`: a profile filled with the demonstration state (spaces, tabs, folders, favourites). `fresh`: a profile with no
 * state file, as on the very first launch (the first-launch guide opens by itself only there).
 */
export type SessionKind = 'demo' | 'fresh'

export interface Size {
  width: number
  height: number
}

/** Logical points; the capture is made at the scale of the screen (2× on a Retina screen). */
export const MAIN_SIZE: Size = { width: 1440, height: 900 }
/** The size the Settings window opens at (SETTINGS_WINDOW_OPTIONS of src/main/shell/settings-window.ts). */
export const SETTINGS_SIZE: Size = { width: 780, height: 760 }
/** The largest a mini window opens at (LITTLE_SIZE_MAX of src/shared/little-window.ts). */
export const LITTLE_SIZE: Size = { width: 900, height: 650 }
/** The size the task manager opens at (the TaskManager of src/main/index.ts). */
export const TASK_MANAGER_SIZE: Size = { width: 720, height: 480 }

/** The pages of the Settings window (SETTINGS_PAGES of src/shared/ipc.ts; features.test.ts compares the two). */
export type SettingsPaneKey = 'home' | 'appearance' | 'tabs' | 'navigation' | 'protection' | 'files' | 'tools' | 'keyboard' | 'profiles' | 'features' | 'about'

/**
 * The subpages of the Settings window (SETTINGS_SUBPAGES of src/shared/ipc.ts; features.test.ts compares the two): a list or an editor that a row of
 * its page opens, on a page of its own. Its rows are drawn there only, so a scene that shows one opens the subpage at its address.
 */
export type SettingsSubpageKey =
  | 'contrast' | 'awake' | 'containers' | 'sitesearches' | 'linkroutes' | 'exceptions' | 'clearonclose' | 'permissions' | 'lockoptions' | 'filterlists'
  | 'network' | 'extensionfolders' | 'translatelists' | 'userscripts' | 'pagewatches' | 'shortcuts' | 'siteexclusions'

export type Localized<T> = Readonly<Record<Lang, T>>

/**
 * The address a scene of the Settings window opens (the hash of settings.html, src/shared/settings-target.ts): the page, or the page and its subpage.
 * The window is at the place of the scene when its address is this one exactly: `#protection` is not `#protection/network`.
 */
export const settingsAddress = (settings: { pane: SettingsPaneKey; sub?: SettingsSubpageKey }): string => (settings.sub ? `${settings.pane}/${settings.sub}` : settings.pane)

/**
 * The most questions the guide is walked through before giving up: it asks those of every category in turn (GUIDE_QUESTIONS of
 * src/shared/settings-guide.ts, fewer when a question means nothing with the settings of the moment; shots.test.ts compares).
 */
export const GUIDE_STEPS_MAX = 48

/** The keys of scripts/site-captures/demo.ts: its spaces and the pages of its tabs. */
export type SpaceKey = 'work' | 'home' | 'projects'
/** The extensions of the demonstration a scene of the features page loads (demo.ts `DEMO_EXTENSIONS`). */
export type DemoExtensionKind = 'keyword' | 'groups'

export interface Scene {
  /** The space on screen and its selected tab (a key of the demonstration pages). Every shot of a `demo` session names both. */
  space?: SpaceKey
  tab?: string
  /** A split view: the tabs put beside `tab`, in this order (three of them make the four panes the application allows at most). */
  split?: readonly string[]
  /**
   * The command bar of a new tab (⌘T), with what is typed in it and the line that must be listed before the capture: the result of a calculation,
   * an open tab, (`rows`) the commands the words find, the first one chosen, or the one labelled `pick`, or (`extension`) the line that hands the
   * words after the keyword of the extension of `demoExtension` to it, first.
   */
  commandBar?: { text: Localized<string>; expect: 'calc' | 'open-tab' | 'rows' | 'extension'; openTab?: string; pick?: Localized<string> }
  /** Glance: a Shift-click on this link of the page of `tab`. */
  peek?: { link: string }
  /** The resource panel of the foot of the sidebar, open; `asleep`: just after « Tout mettre en veille sauf l’onglet affiché ». */
  resourcePanel?: 'open' | 'asleep'
  /**
   * The import sheet reading the bookmarks file of the demonstration (demo.ts `bookmarksFile`, the answer of the file chooser; never the data of
   * this Mac). `preview`: what it would bring, nothing imported yet. `done`: confirmed, the sheet closed, the new space on screen.
   */
  importBookmarks?: 'preview' | 'done'
  /** The Community page of the public site in the tab `tab` (community.ts): `board`, its ideas; `voted`, just after the vote for the first one. */
  community?: 'board' | 'voted'
  /** The reader mode of the article of `tab` (Affichage › Mode lecture). */
  reader?: true
  /** The PDF of `tab`, in the PDF viewer of the engine. */
  pdf?: true
  /** The quick notes, over the page of `tab` (demo.ts `demoNotes`). */
  notes?: true
  /** The panel of the theme of the space on screen. */
  spaceTheme?: true
  /** The password vault, unlocked, with the logins of the demonstration (demo.ts `VAULT_LOGINS`), over the page of `tab`. */
  vault?: true
  /**
   * The Extensions page, in a tab of the window (chrome://extensions, `lucium-ui://extensions/`), once the extension of the demonstration (« Surligneur », with
   * its icon) is loaded the way a person does it (« Charger une extension non empaquetée »). It is no longer a window of its own.
   */
  extension?: true
  /**
   * The panel of the site (« Infos et réglages du site »), its section of the extensions unfolded, once the same extension is loaded: its row ends with the
   * puzzle-piece button that opens the Extensions page. The section is folded again afterwards.
   */
  siteExtensions?: true
  /**
   * « Personnaliser l'espace » of the space on screen, a video wider than the sidebar put in it (demo.ts `FRAMING_VIDEO`, through the panel's file field as a
   * person adds theirs), its frame moved to the right with the arrow keys `moves` times (`POSITION_STEP` of src/shared/space-media.ts, 5 % each): the frame
   * the shape of the sidebar over the whole video, and « Recentrer la vidéo », which only an off-centre frame offers. The space gets its own background back.
   */
  framing?: { moves: number }
  /** A mini window on this page (a key of the demonstration pages). */
  little?: string
  /**
   * The Settings window on a page (`settingsAddress`): `sub`, one of its subpages, opened at its address (`#protection/network`), since the rows of a
   * subpage are drawn there only. `blockerOff`: the blocker switched off first (and on again afterwards). `guide`: « Régler en quelques questions »,
   * whose one entry is on « Pour commencer » (`pane: 'home'`) and asks the questions of every category in turn: on the question titled `question`
   * (the ones before it passed with « Suivant », unanswered), or on its summary; `answers`: on the way, for each question, the first of these answers
   * it offers (the others keep the answer that matches the settings). Nothing is applied. `row`: a row of the page, by its `data-setting` key or its
   * `data-search` id (the way SettingsWindow.tsx finds a result), brought just under the head of the window (features.ts); `fold`: the row waits in
   * « Plus de réglages », which is opened first (features.test.ts checks it against the map of the window); `place: 'bottom'`: at the foot of the
   * image instead, the rows above it in view rather than the text under it.
   */
  settings?: {
    pane: SettingsPaneKey
    sub?: SettingsSubpageKey
    blockerOff?: true
    guide?: 'question' | 'recap'
    question?: Localized<string>
    answers?: readonly string[]
    row?: string
    fold?: true
    place?: 'bottom'
  }
  // ---- the captures of the features page (features.ts) ----
  /**
   * Settings changed for the shot through the reducer (`settings/update`), and put back to what they were afterwards. features.test.ts keeps them to
   * switches that cost nothing on the network and need no restart, or to the application's default of a setting the demonstration turns off.
   */
  patch?: Readonly<Record<string, unknown>>
  /**
   * A panel of the overlay, opened with the interface's own request (`openOverlay`), then `wait`, an element of the overlay, waited for. In the
   * strings of the request, `$tab` stands for the id of the tab on screen, `$url` for its address and `$host` for its host.
   */
  overlay?: { request: Readonly<Record<string, unknown>>; wait: string }
  /**
   * An extension of the demonstration (demo.ts `DEMO_EXTENSIONS`), loaded first the way a person does it (« Charger une extension non empaquetée »)
   * and switched off after the shot: `keyword` declares a keyword of the command bar, `groups` makes the tab group of `tabGroup`.
   */
  demoExtension?: DemoExtensionKind
  /** The group the extension `groups` makes of these pages of the space (open tabs), under this title, before the shot. */
  tabGroup?: { tabs: readonly string[]; title: Localized<string> }
  /** These pages of the space (pinned tabs, which stay) put in « Lire plus tard » first; the list is emptied after the shot. */
  readLater?: readonly string[]
  /** These pages of the space put in the bookmark library first, with their tags (the library must be on: `patch`). */
  bookmarks?: ReadonlyArray<{ tab: string; tags: Localized<readonly string[]> }>
  /** Sessions saved first, each under its name, from these pages of the space (the list of the Sessions panel); deleted after the shot. */
  sessions?: ReadonlyArray<{ name: Localized<string>; tabs: readonly string[] }>
  /**
   * The sheet of the news (opened by `menu`) with every point of the version listed (« Voir tout »), its list scrolled to the point of this title.
   * The first points of a version may name what an image of the site does not show (names.ts): the image shows the points from this one on.
   */
  newsFrom?: Localized<string>
  /** The find bar over the page of `tab`, with this typed; `regex`: its « .* » button pressed first (the setting `findRegex` must be on). */
  find?: { text: Localized<string>; regex?: true }
  /**
   * An item of the menu bar clicked (development build), by its label in the language of the run. `wait`: an element of the overlay to wait for;
   * `opens`: the window it opens, which is the one captured.
   */
  menu?: { label: Localized<string>; wait?: string; opens?: 'taskmanager' | 'private' }
  /**
   * A page of the demonstration (a key of demo.ts) opened in a new tab in the other language than the run's, selected, and closed after the shot:
   * a page in a foreign language, the one the translation offers to translate.
   */
  foreignPage?: string
  /** An element of the main window's interface clicked, as a person does (`selector`), then `wait`, an element of the overlay it opens. */
  click?: { selector: string; wait: string }
  /** The first-launch guide (only in a `fresh` session). */
  firstLaunch?: true
  /** The name of the only space of a fresh profile (the application names it "Perso" whatever the language). */
  freshSpaceName?: Localized<string>
}

export interface Shot {
  /** The name of the files (English, as the images of the site). */
  id: string
  /** What the image shows, in French: the list printed by `--list` and the summary. */
  description: string
  session: SessionKind
  window: WindowKind
  size: Size
  langs: readonly Lang[]
  themes: readonly Theme[]
  scene: Scene
  /** Set when the shot cannot be taken yet: the reason, printed instead of a capture. */
  todo?: string
  /**
   * Set when the shot needs the development build, whose main process the script reaches (a file chooser answered with a file of the
   * demonstration, a click on a menu, the variables of the development): the reason, printed instead of a capture with `--app`.
   */
  developmentOnly?: string
  /**
   * The image may show no other browser's name (names.ts), as the public site names none: the script reads the text of the window first and
   * refuses the shot when one is there.
   */
  noBrowserNames?: true
}

const all = { langs: LANGS, themes: THEMES }

/** Why the shots that answer a file chooser are left out with `--app`: the packaged application lets no one reach its main process. */
const FILE_CHOOSER = 'le sélecteur de fichiers est répondu dans le processus principal, que seule la build de développement laisse atteindre'

/**
 * In the order they are taken within a session. The order matters: the shots of the main window come first, while it has the focus; the mini
 * window, the window of the extensions, then the Settings window, take the focus when they open (a window that has lost it shows grey traffic
 * lights). « Tout endormir » unloads the other tabs: its shot is the last one of the main window.
 */
export const SHOTS: readonly Shot[] = [
  {
    id: 'main-window',
    description: 'Fenêtre principale : l’espace Travail avec ses favoris, ses onglets épinglés, ses dossiers et ses onglets du jour, le carnet de notes à l’écran.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes' }
  },
  {
    id: 'command-bar-calc',
    description: 'Barre de commandes d’un nouvel onglet (⌘T) : le calcul 12*(3+4) et son résultat en première ligne.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', commandBar: { text: { fr: '12*(3+4)', en: '12*(3+4)' }, expect: 'calc' } }
  },
  {
    id: 'command-bar-tab',
    description: 'Barre de commandes (⌘T) qui retrouve un onglet déjà ouvert, la météo de la semaine, sous « Onglets ouverts » : sa ligne est choisie, l’aperçu montre l’onglet (pas le moteur de recherche de la première ligne).',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', commandBar: { text: { fr: 'météo', en: 'weather' }, expect: 'open-tab', openTab: 'weather' } }
  },
  {
    id: 'split-view',
    description: 'Vue scindée à deux volets : le tableau du projet et le carnet de notes côte à côte.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'board', split: ['notes'] }
  },
  {
    id: 'split-view-4',
    // The two tabs of the day first: a pinned tab that joins them stays where it is in the sidebar (src/shared/split-place.ts), the other way round it would be moved.
    description: 'Vue scindée à quatre volets, côte à côte : la météo, l’article « Bien nommer ses fichiers », le tableau du projet et le carnet de notes (l’application range les volets en une rangée, jamais en grille).',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'weather', split: ['naming', 'board', 'notes'] }
  },
  {
    id: 'peek',
    description: 'Coup d’œil : le lien « météo » du carnet ouvert en aperçu par ⇧-clic, au-dessus de la page.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', peek: { link: '#peek-link' } }
  },
  {
    id: 'resource-panel',
    description: 'Panneau des ressources ouvert au pied de la barre latérale : la mémoire et les onglets qui en consomment le plus.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'board', resourcePanel: 'open' }
  },
  {
    id: 'space-switch',
    description: 'Changement d’espace : l’espace Maison, ses couleurs et ses onglets, les recettes de saison à l’écran.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'home', tab: 'recipes' }
  },
  {
    id: 'space-projects',
    description: 'Troisième espace, Projets : ses couleurs vert et bleu, ses onglets (dont la page Communauté du site et un PDF), la feuille de route à l’écran.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'projects', tab: 'roadmap' }
  },
  {
    id: 'reader-mode',
    description: 'Mode lecture sur l’article « Le goût des cartes anciennes » de l’espace Projets : le texte seul, mis en page par Lucium, avec sa pastille de réglages.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'projects', tab: 'maps', reader: true },
    developmentOnly: 'le mode lecture ne s’ouvre que par le menu Affichage, cliqué dans le processus principal, que seule la build de développement laisse atteindre'
  },
  {
    id: 'pdf-viewer',
    description: 'Un PDF ouvert dans un onglet de l’espace Projets : le bilan du trimestre (un document de démonstration d’une page), dans le lecteur de PDF intégré.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'projects', tab: 'report', pdf: true }
  },
  {
    id: 'translate',
    description: 'Une page traduite sur ce Mac (traduction locale).',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'projects', tab: 'maps' },
    todo:
      'la traduction locale demande des modèles que l’outil ne télécharge pas (environ 42 Mo pris sur Internet au premier usage), ou le service de traduction de macOS, ' +
      'qui ne répond qu’à l’application empaquetée et signée et dont les langues installées dépendent du Mac ; le glossaire, seul moteur sans réseau, remplace mot à mot et n’est pas une traduction à montrer'
  },
  {
    id: 'quick-notes',
    description: 'Notes rapides ouvertes au-dessus des recettes de saison (espace Maison) : deux notes sur cette page, une sur l’espace, une autre ailleurs.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'home', tab: 'recipes', notes: true }
  },
  {
    id: 'space-themes',
    description: 'Le choix du thème d’un espace : le panneau des thèmes de l’espace Projets ouvert à côté de la barre latérale (thèmes prêts, couleur de départ, teinte, intensité, texture), rien de changé.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'projects', tab: 'roadmap', spaceTheme: true }
  },
  {
    id: 'vault-touch-id',
    description:
      'Le coffre de mots de passe déverrouillé au-dessus du carnet de notes, avec cinq identifiants de démonstration (l’identifiant du carnet en tête). ' +
      'Déverrouillé par sa phrase, dans un coffre jetable : la feuille de Touch ID appartient à macOS et n’est pas montrée.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', vault: true }
  },
  {
    id: 'extensions',
    description:
      'La page Extensions, ouverte dans un onglet de la fenêtre (chrome://extensions) : l’extension de démonstration « Surligneur », non empaquetée, sans permission ni marque, en mode développeur.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', extension: true },
    developmentOnly: FILE_CHOOSER
  },
  {
    id: 'community',
    description: 'Le site lucium.app ouvert dans Lucium, page Communauté : les idées les plus votées et leurs boutons de vote (copie locale du site, fausses idées, fausse API).',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'projects', tab: 'community', community: 'board' }
  },
  {
    id: 'community-voted',
    description: 'La même page juste après le vote pour la première idée : sa voix ajoutée (128 → 129), le bouton marqué, « Votre voix est comptée. ».',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'projects', tab: 'community', community: 'voted' }
  },
  {
    id: 'import',
    description:
      'Feuille d’import avec l’aperçu d’un fichier de signets HTML de démonstration (12 signets dans 3 dossiers) : rien n’est encore importé. ' +
      'Aucun nom d’autre navigateur : le navigateur de macOS sous son nom générique, la ligne « Autre navigateur », dont l’aide cite des formats de fichiers, retirée de l’image.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', importBookmarks: 'preview' },
    developmentOnly: FILE_CHOOSER,
    noBrowserNames: true
  },
  {
    id: 'import-done',
    description: 'Barre latérale juste après l’import : le nouvel espace « Signets importés », ses onglets épinglés et ses dossiers (« Lecture » ouvert), la météo à l’écran.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', importBookmarks: 'done' },
    developmentOnly: FILE_CHOOSER,
    noBrowserNames: true
  },
  {
    id: 'resource-panel-asleep',
    description: 'Panneau des ressources juste après « Tout mettre en veille sauf l’onglet affiché » : la notice des onglets mis en veille, les icônes pâlies, la mémoire plus basse.',
    session: 'demo',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { space: 'work', tab: 'board', resourcePanel: 'asleep' }
  },
  {
    id: 'little-window',
    description: 'Mini-fenêtre : les horaires du musée ouverts à part, sans quitter l’espace.',
    session: 'demo',
    window: 'little',
    size: LITTLE_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', little: 'museum' }
  },
  {
    id: 'settings-privacy-off',
    description:
      'Réglages › Vie privée et sécurité, le bloqueur encore désactivé (l’image d’avant celle où il s’allume) : le niveau de protection dit « Personnalisé », ' +
      'puisque chaque niveau bloque les publicités ; il est rallumé aussitôt après.',
    session: 'demo',
    window: 'settings',
    size: SETTINGS_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', settings: { pane: 'protection', blockerOff: true } }
  },
  {
    id: 'settings-privacy',
    description:
      'Réglages › Vie privée et sécurité : le niveau de protection en tête de la page, sur « Renforcée » comme pour un nouveau profil, puis l’interrupteur du ' +
      'bloqueur et les trois autres qu’il règle.',
    session: 'demo',
    window: 'settings',
    size: SETTINGS_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', settings: { pane: 'protection' } }
  },
  {
    // The film starts its scene of the guide here (scripts/site-film/scenes.ts, scene 12): the guide has no card on the other pages any more.
    id: 'settings-home',
    description: 'Réglages › Pour commencer : en tête de la page, la carte « Régler en quelques questions », seule entrée du guide, et son bouton « Commencer ».',
    session: 'demo',
    window: 'settings',
    size: SETTINGS_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', settings: { pane: 'home' } }
  },
  {
    id: 'settings-guide',
    description:
      '« Régler en quelques questions », lancé depuis Réglages › Pour commencer (sa seule entrée), sur la première question de la vie privée : que bloquer ' +
      'pendant que vous naviguez ; les questions d’avant sont passées sans réponse.',
    session: 'demo',
    window: 'settings',
    size: SETTINGS_SIZE,
    ...all,
    scene: {
      space: 'work',
      tab: 'notes',
      settings: { pane: 'home', guide: 'question', question: { fr: 'Que bloquer pendant que vous naviguez ?', en: 'What to block while you browse?' } }
    }
  },
  {
    id: 'settings-guide-recap',
    description:
      '« Régler en quelques questions », lancé depuis Réglages › Pour commencer : le récapitulatif après la dernière question de toutes les catégories, trois ' +
      'réponses changées depuis le niveau « Renforcée » d’un nouveau profil (bloquer plus fort, pistage jusqu’à l’empreinte, coffre de mots de passe), soit ' +
      'quatre réglages qui changeraient ; « Appliquer » n’est pas pressé.',
    session: 'demo',
    window: 'settings',
    size: SETTINGS_SIZE,
    ...all,
    scene: { space: 'work', tab: 'notes', settings: { pane: 'home', guide: 'recap', answers: ['plus-fort', 'empreinte', 'coffre'] } }
  },
  {
    id: 'first-launch',
    description: 'Feuille du premier lancement d’un profil neuf, qui propose de reprendre les signets et l’historique du navigateur de macOS, choisi, sous son nom générique (aucun nom d’autre navigateur).',
    session: 'fresh',
    window: 'main',
    size: MAIN_SIZE,
    ...all,
    scene: { firstLaunch: true, freshSpaceName: { fr: 'Perso', en: 'Personal' } },
    developmentOnly: 'les noms génériques des navigateurs viennent de la variable LUCIUM_IMPORT_APP_FOLDERS, que l’application empaquetée ignore',
    noBrowserNames: true
  }
]

export interface SessionPlan {
  /** `fr/light/demo`: what the progress lines print. */
  key: string
  lang: Lang
  theme: Theme
  kind: SessionKind
  shots: Shot[]
}

export interface PlanOptions {
  langs: readonly Lang[]
  themes: readonly Theme[]
  /** Shot ids; empty or absent: every shot. */
  only?: readonly string[]
  /** The run drives a packaged application (`--app`): the shots marked `developmentOnly` are left out. */
  packaged?: boolean
  /** Shot ids left out whatever `only` says (the Community page without a checkout of the site). */
  without?: readonly string[]
}

/** The shots that need the checkout of the public site (`--site`): the Community page. */
export const SITE_SHOTS: readonly string[] = ['community', 'community-voted']

/**
 * The sessions to run, in order: for each language and theme, the demonstration profile, then the fresh one. A shot marked `todo` is left out,
 * and so is one marked `developmentOnly` when the run drives a packaged application.
 */
export function planSessions(shots: readonly Shot[], options: PlanOptions): SessionPlan[] {
  const wanted = (shot: Shot) =>
    shot.todo === undefined &&
    !(options.packaged === true && shot.developmentOnly !== undefined) &&
    !(options.without ?? []).includes(shot.id) &&
    (options.only === undefined || options.only.length === 0 || options.only.includes(shot.id))
  const plans: SessionPlan[] = []
  for (const lang of LANGS.filter((l) => options.langs.includes(l))) {
    for (const theme of THEMES.filter((t) => options.themes.includes(t))) {
      for (const kind of ['demo', 'fresh'] as const) {
        const list = shots.filter((shot) => shot.session === kind && wanted(shot) && shot.langs.includes(lang) && shot.themes.includes(theme))
        if (list.length > 0) plans.push({ key: `${lang}/${theme}/${kind}`, lang, theme, kind, shots: list })
      }
    }
  }
  return plans
}

/** The shots that are only written down for now, with the reason. */
export const todoShots = (shots: readonly Shot[]): Shot[] => shots.filter((shot) => shot.todo !== undefined)

/** The shots a run drives the packaged application without (`--app`), with the reason: they need the development build. */
export const developmentOnlyShots = (shots: readonly Shot[]): Shot[] => shots.filter((shot) => shot.todo === undefined && shot.developmentOnly !== undefined)

/** The widths of the WebP images for the site, in pixels (an image narrower than a width is kept at its own width, never enlarged). */
export const WEB_WIDTHS: readonly number[] = [1280, 2560]

export interface ShotFiles {
  /** With the shadow of macOS, on a transparent background. */
  shadow: string
  /** Without the shadow (`screencapture -o`). */
  flat: string
  /** The WebP images made from both, at each width. */
  web: Array<{ from: 'shadow' | 'flat'; width: number; path: string }>
}

/** Where the images of a shot go: `<root>/<lang>/<theme>/<id>.png`, `<id>-no-shadow.png`, and `web/<id>[-no-shadow]-<width>.webp`. */
export function shotFiles(root: string, lang: Lang, theme: Theme, id: string, widths: readonly number[] = WEB_WIDTHS): ShotFiles {
  const dir = `${root.replace(/\/+$/, '')}/${lang}/${theme}`
  const web: ShotFiles['web'] = []
  for (const from of ['shadow', 'flat'] as const) {
    for (const width of widths) web.push({ from, width, path: `${dir}/web/${id}${from === 'flat' ? '-no-shadow' : ''}-${width}.webp` })
  }
  return { shadow: `${dir}/${id}.png`, flat: `${dir}/${id}-no-shadow.png`, web }
}

/**
 * A list given on the command line (`fr,en`), checked against what is allowed. Throws with the first unknown value; an empty or absent value
 * gives `fallback`.
 */
export function parseChoice<T extends string>(raw: string | undefined, allowed: readonly T[], what: string, fallback: readonly T[] = allowed): T[] {
  if (raw === undefined || raw.trim() === '') return [...fallback]
  const values = raw.split(',').map((value) => value.trim()).filter((value) => value !== '')
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) throw new Error(`${what} : valeur inconnue « ${value} » (valeurs possibles : ${allowed.join(', ')})`)
  }
  return [...new Set(values)] as T[]
}

/** The widths of `--widths` (`1280,2560`): whole numbers from 64 to 8192 px. */
export function parseWidths(raw: string | undefined): number[] {
  if (raw === undefined || raw.trim() === '') return [...WEB_WIDTHS]
  const widths = raw.split(',').map((value) => Number(value.trim()))
  if (widths.length === 0 || widths.some((width) => !Number.isInteger(width) || width < 64 || width > 8192)) throw new Error(`largeurs invalides : « ${raw} » (des entiers de 64 à 8192, séparés par des virgules)`)
  return [...new Set(widths)].sort((a, b) => a - b)
}
