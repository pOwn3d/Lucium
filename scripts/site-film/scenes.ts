// The presentation film of the site, written as data: its fifteen scenes, what each one shows, when,
// and its texts in French and in English side by side. scripts/site-film/film.mjs resolves the images, timeline.ts computes the frames, and the
// page of montage/ draws them. Only this file is edited to change a text, a duration, a shot or the moment something happens.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Lang, Theme } from '../site-captures/shots'

/** A rectangle in fractions of an image: x, y, width, height (0 to 1, from its top-left corner). */
export type Rect = readonly [number, number, number, number]
/** A point in fractions of an image. */
export type Point = readonly [number, number]

/** A place of a shot that the film points at (a ring, a click). A pair gives a different place for each language when the texts move it. */
export type Spot = Rect | Point | { readonly fr: Rect | Point; readonly en: Rect | Point }

/** A line of text on screen, in both languages. `at`: when it appears, in seconds from the start of its scene. */
export interface Line {
  at: number
  fr: string
  en: string
  /** `small`: a line in small grey type under the others (the last line of the closing scene); `accent`: in the colour of the links. */
  style?: 'small' | 'accent'
}

/** How one scene gives way to the next: the transition into a scene, centred on the boundary between them. */
export type TransitionKind = 'cut' | 'fade' | 'zoom' | 'push-left' | 'push-up' | 'wipe' | 'blinds' | 'mosaic' | 'curtain'
export interface Transition {
  kind: TransitionKind
  /** Seconds; half before the boundary, half after. */
  duration: number
}

/**
 * Where the text and the images go. `center`: alone in the middle (the icon). `stack`: the text above, the window under it. `stack-bottom`: the
 * window above, the text under it. `panel-left` / `panel-right`: the text in a column on that side, the images in a rounded tile on the other.
 * The square version (1080 × 1080) puts the text above in every layout.
 */
export type Layout = 'center' | 'stack' | 'stack-bottom' | 'panel-left' | 'panel-right'

/**
 * What the page does with the scene. `window`: one window, its stills one after the other, a camera, rings, a cursor. `icon`: the icon of the application, alone.
 * `spaces`: windows side by side that slide like the spaces. `little`: a small window that opens above another one. `mosaic`: a grid of tiles
 * lit one after the other. `closing`: the icon and the last words.
 */
export type SceneKind = 'icon' | 'window' | 'spaces' | 'little' | 'mosaic' | 'closing'

/** The colour behind a scene: white, the light grey of the site's bands, or black (the dark passage). */
export type Backdrop = 'white' | 'band' | 'dark'

/**
 * One image of a scene. `shot`: an id of scripts/site-captures/shots.ts or of EXTRA_SHOTS below. `at`: when it replaces the previous one (the first
 * one shown is on screen from the start). `reveal`: only this place of the new image comes in, with a movement (`rise`: it slides up, `pop`: it
 * grows a little, `fade`), while the rest of the image fades: a panel that opens over a page stays the real panel. `ifMissing`: `skip` leaves the
 * step out when the capture does not exist yet (the previous image stays); `placeholder` (the default) draws a neutral window instead.
 */
export interface Still {
  shot: string
  at: number
  theme?: Theme
  reveal?: { spot: string; motion: 'rise' | 'pop' | 'fade' }
  /** Seconds of the crossfade (0.45 by default). */
  fade?: number
  ifMissing?: 'skip' | 'placeholder'
}

/**
 * A screen recording that replaces some stills when it exists (`<captures>/<lang>/<theme>/videos/<id>.mov`, `.mp4` or `.webm`), framed on the
 * window like the stills. It starts at `at`, plays at its own speed, and its last image stays until the next still that it does not replace.
 */
export interface Clip {
  id: string
  at: number
  replaces: readonly string[]
  theme?: Theme
}

/**
 * A position of the camera. `zoom`: on the base size of the window (1: as laid out). `focus`: the point of the window it looks at; `to`: where
 * that point goes, in fractions of the area of the images (by default it stays where it is laid out, so the camera zooms around it). The camera
 * eases from one key to the next.
 */
export interface CameraKey {
  at: number
  zoom: number
  focus?: Point
  to?: Point
}

/** A ring around a place of the window, from `from` to `to` (seconds of the scene). `veil`: the rest of the window is dimmed a little. */
export interface Ring {
  from: number
  to: number
  spot: string
  shot?: string
  veil?: boolean
}

/** Where the pointer is at `at`; `click`: it clicks there; `key`: a key held during the click (⇧ for a Shift-click). */
export interface CursorKey {
  at: number
  spot: string
  shot?: string
  click?: boolean
  key?: string
}

/** A line drawn on the window in the colour of the links, from `from` (it grows for half a second), to mark where it is about to split. */
export interface Mark {
  from: number
  to: number
  /** In fractions of the window: start and end. */
  line: readonly [number, number, number, number]
}

/** Keys drawn large over the window and pressed at `at` (⌘ T before the command bar), at a place of a shot. */
export interface Keys {
  at: number
  keys: readonly string[]
  spot: string
  shot?: string
}

/** A tile of the mosaic: its shot and its caption. */
export interface Tile {
  shot: string
  fr: string
  en: string
}

export interface SceneSpec {
  /** 1 to 15, as in the storyboard. */
  number: number
  /** A short name for the command line (`--from sidebar`) and the logs. */
  id: string
  /** What the scene shows, in French: what `--list` prints. */
  description: string
  duration: number
  kind: SceneKind
  layout: Layout
  backdrop: Backdrop
  /** The theme of the captures of the scene (light by default). */
  theme?: Theme
  /** The base size of the window: a fraction of the area of the images (0.9 by default), or `native`: one pixel of the capture per pixel of film. */
  fit?: number | 'native'
  stills?: readonly Still[]
  clips?: readonly Clip[]
  camera?: readonly CameraKey[]
  rings?: readonly Ring[]
  cursor?: readonly CursorKey[]
  marks?: readonly Mark[]
  keys?: readonly Keys[]
  tiles?: readonly Tile[]
  /** How the window comes in: `rise`, from under the frame to its place (scene 2). */
  enter?: 'rise'
  lines: readonly Line[]
  /** In a stacked text, the newest line is dark and the earlier ones turn grey (scene 4: pinned tabs, folders, Today). */
  focusLines?: boolean
  /** `fall`: the lines drop in from above, one by one (the dark passage). */
  textMotion?: 'rise' | 'fall'
  /** The transition into this scene (the first scene has none). */
  transition?: Transition
}

/** The size of a capture, in pixels of its image (1440 × 900 for the main window: the captures are at 1×). */
export interface Size {
  width: number
  height: number
}

/**
 * The shots the film needs that scripts/site-captures/shots.ts does not take: what each one shows, its size, and what has to be on screen. Until
 * they exist, the film draws a neutral window (or skips the step, see `Still.ifMissing`).
 */
export interface ExtraShot {
  id: string
  description: string
  size: Size
  /** The neutral drawing used while it is missing (see montage/montage.js, PLACEHOLDERS). */
  placeholder: string
}

/** The drawings for the shots of shots.ts, while their capture is missing (or while the shot is still marked `todo` there). */
export const SHOT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  'main-window': 'main',
  'space-switch': 'main',
  'space-projects': 'main',
  'command-bar-calc': 'command',
  'command-bar-tab': 'command',
  'split-view': 'split2',
  'split-view-4': 'split4',
  peek: 'peek',
  'resource-panel': 'resource',
  'resource-panel-asleep': 'resource',
  'little-window': 'little',
  'settings-privacy': 'settings',
  'settings-privacy-off': 'settings',
  'settings-home': 'settings',
  'settings-guide': 'guide',
  'settings-guide-recap': 'guide',
  'first-launch': 'sheet',
  import: 'sheet',
  'import-done': 'main',
  community: 'site',
  'community-voted': 'site-voted',
  'reader-mode': 'reader',
  'pdf-viewer': 'pdf',
  translate: 'translate',
  'quick-notes': 'notes',
  'space-themes': 'themes',
  'vault-touch-id': 'vault',
  extensions: 'extensions'
}

/** Only the shots that are no shot of shots.ts at all (an image from outside the application); a shot of shots.ts that is still `todo` stays there. */
export const EXTRA_SHOTS: readonly ExtraShot[] = [
  { id: 'other-app', description: 'Une autre application du Mac (Notes, Messages…) avec un lien à cliquer, sans aucun navigateur à l’écran. Facultative.', size: { width: 1100, height: 720 }, placeholder: 'other-app' }
]

/** The screen recordings that make the gestures better than a chain of stills, for the session of captures. All of them are optional. */
export const CLIPS: ReadonlyArray<{ id: string; description: string; seconds: number }> = [
  { id: 'space-swipe', description: 'Balayage à deux doigts de Travail à Maison puis à Projets, la couleur de la fenêtre qui change.', seconds: 3 },
  { id: 'sidebar-tour', description: 'Clic sur le dossier Documentation qui s’ouvre, puis « Tout archiver » des onglets du jour.', seconds: 3 },
  { id: 'command-bar-typing', description: '⌘T, frappe de 12*(3+4), « = 84 », puis effacement et frappe de « météo » jusqu’à l’onglet retrouvé.', seconds: 4 },
  { id: 'split-four', description: 'Une page qui passe en vue scindée à deux, puis à quatre volets.', seconds: 3 },
  { id: 'peek-open', description: '⇧-clic sur le lien « prévisions de la semaine » du carnet : l’aperçu qui monte.', seconds: 2 },
  { id: 'little-window-open', description: 'Clic sur un lien dans une autre application : la mini-fenêtre qui s’ouvre.', seconds: 2 },
  { id: 'tabs-sleep', description: 'Panneau des ressources : « Tout mettre en veille sauf l’onglet affiché », les icônes qui pâlissent, la jauge qui descend.', seconds: 3 },
  { id: 'blocker-on', description: 'Réglages › Vie privée en sombre : l’interrupteur du bloqueur qui s’allume.', seconds: 2 },
  { id: 'guide-answer', description: '« Régler en quelques questions » : une réponse cochée, « Suivant », jusqu’au récapitulatif.', seconds: 4 },
  { id: 'import-arrive', description: 'La feuille d’import validée : les espaces et les onglets qui arrivent dans la barre latérale.', seconds: 3 },
  { id: 'community-vote', description: 'La page Communauté du site dans Lucium : le clic sur « Voter » et le compteur qui augmente.', seconds: 2 }
]

/**
 * The places the film points at, per shot, in fractions of the capture (1440 × 900 for the main window, 780 × 760 for Settings), measured on the
 * pixels of the captures of 4 November 2026 (session `seance-2`, both languages: a pair where the texts move a place). A shot that shows the same
 * window as another one reuses its places (`main-window` for the command bar, the peek…). The placeholders were drawn for the first places: a
 * place measured since may fall beside the matching part of a drawing, which only shows while a capture is missing.
 */
const MAIN_SPOTS: Readonly<Record<string, Spot>> = {
  sidebar: [0, 0, 0.2243, 1],
  web: [0.2243, 0.008, 0.7715, 0.984],
  pinned: [0.0125, 0.1544, 0.2083, 0.0911],
  folder: [0.0069, 0.2467, 0.2139, 0.1344],
  today: [0.0056, 0.4322, 0.2153, 0.1689],
  archiveAll: [0.1389, 0.4389, 0.0694, 0.0189],
  spaceHome: [0.1472, 0.9722],
  spaceProjects: [0.1708, 0.9722],
  resourceButton: [0.0868, 0.9722],
  peekLink: { fr: [0.752, 0.61], en: [0.673, 0.609] },
  contentLeft: [0.26, 0.15],
  splitLine: [0.6083, 0.5]
}

export const HOTSPOTS: Readonly<Record<string, Readonly<Record<string, Spot>>>> = {
  'main-window': MAIN_SPOTS,
  'space-switch': MAIN_SPOTS,
  'space-projects': MAIN_SPOTS,
  'command-bar-calc': {
    ...MAIN_SPOTS,
    commandBar: [0.25, 0.14, 0.5, 0.3733],
    calcResult: [0.2563, 0.25, 0.4854, 0.13]
  },
  'command-bar-tab': {
    ...MAIN_SPOTS,
    // Taller than the calculation: the list has a group more (« Onglets ouverts »), and in English the word is completed into an address first.
    commandBar: [0.25, 0.14, 0.5, 0.4422],
    tabResult: { fr: [0.2563, 0.3467, 0.315, 0.0367], en: [0.2563, 0.4222, 0.315, 0.0367] }
  },
  'split-view': { ...MAIN_SPOTS, ratios: [0.504, 0.947, 0.204, 0.04] },
  'split-view-4': MAIN_SPOTS,
  peek: { ...MAIN_SPOTS, peekPanel: [0.2708, 0.05, 0.6771, 0.9367] },
  'resource-panel': {
    ...MAIN_SPOTS,
    resourcePanel: [0.0063, 0.57, 0.2125, 0.3733],
    memoryGauge: [0.0104, 0.6, 0.205, 0.035],
    sleepAll: [0.1490, 0.9058]
  },
  // The panel lists only the tabs still awake: it is shorter, and its gauge is lower in the window.
  'resource-panel-asleep': {
    ...MAIN_SPOTS,
    resourcePanel: [0.0056, 0.7322, 0.2132, 0.21],
    memoryGauge: [0.0104, 0.7656, 0.205, 0.035]
  },
  'settings-privacy': {
    blockerRow: [0.0256, 0.5237, 0.9333, 0.0632],
    blockerSection: [0.0256, 0.468, 0.9333, 0.23]
  },
  'settings-privacy-off': {
    blockerRow: [0.0256, 0.5237, 0.9333, 0.0632],
    blockerToggle: [0.923, 0.5545]
  },
  // The card of the guide at the top of « Pour commencer » and its « Commencer ». Not measured yet on a capture: placed from the stylesheet (the title
  // bar of 52 px, the sidebar of 204 px, the padding of the page, its head, the card under it), to be measured on the next session of captures.
  'settings-home': {
    guideCard: [0.2872, 0.1684, 0.6872, 0.0868],
    start: { fr: [0.897, 0.2118], en: [0.917, 0.2118] }
  },
  'settings-guide': {
    firstAnswer: [0.0256, 0.4737, 0.9487, 0.0789],
    next: { fr: [0.9295, 0.7645], en: [0.941, 0.7658] }
  },
  'settings-guide-recap': {},
  // The sheet is shorter in English (one line less of preview), and « Confirm Import » is narrower than « Confirmer l’import ».
  import: {
    sheet: { fr: [0.3333, 0.12, 0.3333, 0.5644], en: [0.3333, 0.12, 0.3333, 0.5478] },
    importButton: { fr: [0.6035, 0.6439], en: [0.6101, 0.6272] }
  },
  // The new space: its pinned tabs and its folders, from its name to the last folder.
  'import-done': { ...MAIN_SPOTS, imported: [0.0069, 0.1056, 0.2139, 0.4533] },
  // The vote is the button on the left of each idea, pointed at its arrow (the count under it stays in view). After the vote the line « Votre voix
  // est comptée » is taller than « 6 demandes »: the board moves down. The pointer rests in the empty end of that line, not on a button.
  community: { ...MAIN_SPOTS, contentLeft: [0.6, 0.28], idea: [0.2396, 0.3178, 0.4972, 0.1156], vote: [0.2802, 0.3594] },
  'community-voted': { ...MAIN_SPOTS, contentLeft: [0.6, 0.28], idea: [0.2396, 0.3444, 0.4972, 0.1156], vote: [0.2802, 0.3861] },
  'other-app': { link: [0.42, 0.46] }
}

/** The frame the poster is taken from: the window settled under its title, in scene 2. */
export const POSTER = { scene: 2, at: 2.2 }

export const SCENES: readonly SceneSpec[] = [
  {
    number: 1,
    id: 'opening',
    description: 'L’icône apparaît, sur fond blanc.',
    duration: 4,
    kind: 'icon',
    layout: 'center',
    backdrop: 'white',
    lines: [{ at: 1.7, fr: 'Lucium', en: 'Lucium' }]
  },
  {
    number: 2,
    id: 'sidebar',
    description: 'La fenêtre principale entre par le bas et se pose ; zoom lent sur la barre latérale, puis sur la page.',
    duration: 5,
    kind: 'window',
    layout: 'stack',
    backdrop: 'white',
    transition: { kind: 'fade', duration: 0.6 },
    enter: 'rise',
    stills: [{ shot: 'main-window', at: 0 }],
    // Back to the base framing before the end: scene 3 starts on the same window, and the fade only changes the text.
    camera: [
      { at: 1.3, zoom: 1, focus: [0.112, 0] },
      { at: 2.8, zoom: 1.1, focus: [0.112, 0] },
      { at: 3.8, zoom: 1.1, focus: [0.55, 0] },
      { at: 4.6, zoom: 1, focus: [0.55, 0] }
    ],
    rings: [
      { from: 1.3, to: 2.7, spot: 'sidebar', veil: true },
      { from: 2.9, to: 4.4, spot: 'web', veil: true }
    ],
    lines: [
      { at: 0.5, fr: 'Vos onglets à gauche.', en: 'Your tabs on the left.' },
      { at: 2.8, fr: 'Le web à droite.', en: 'The web on the right.' }
    ]
  },
  {
    number: 3,
    id: 'spaces',
    description: 'Les trois espaces glissent l’un après l’autre ; la couleur de la fenêtre change.',
    duration: 5,
    kind: 'spaces',
    layout: 'stack',
    backdrop: 'white',
    transition: { kind: 'fade', duration: 0.6 },
    stills: [
      { shot: 'main-window', at: 0 },
      { shot: 'space-switch', at: 1.4 },
      { shot: 'space-projects', at: 3.0, ifMissing: 'skip' }
    ],
    clips: [{ id: 'space-swipe', at: 1.2, replaces: ['space-switch', 'space-projects'] }],
    lines: [{ at: 0.3, fr: 'Un espace pour chaque partie de votre vie.', en: 'A space for every part of your life.' }]
  },
  {
    number: 4,
    id: 'sidebar-tour',
    description: 'Surlignage des épinglés, puis d’un dossier, puis des onglets du jour.',
    duration: 5,
    kind: 'window',
    layout: 'panel-left',
    backdrop: 'white',
    fit: 'native',
    transition: { kind: 'wipe', duration: 0.8 },
    stills: [{ shot: 'main-window', at: 0 }],
    clips: [{ id: 'sidebar-tour', at: 1.9, replaces: [] }],
    camera: [
      { at: 0, zoom: 1, focus: [0.112, 0.2], to: [0.3, 0.3] },
      { at: 2.0, zoom: 1.05, focus: [0.112, 0.3], to: [0.3, 0.36] },
      { at: 5.4, zoom: 1.12, focus: [0.112, 0.5], to: [0.3, 0.5] }
    ],
    rings: [
      { from: 0.5, to: 1.8, spot: 'pinned', veil: true },
      { from: 1.9, to: 3.1, spot: 'folder', veil: true },
      { from: 3.2, to: 4.9, spot: 'today', veil: true }
    ],
    focusLines: true,
    lines: [
      { at: 0.4, fr: 'Épinglés,', en: 'Pinned tabs,' },
      { at: 1.8, fr: 'dossiers,', en: 'folders,' },
      { at: 3.1, fr: 'onglets du jour rangés tout seuls.', en: 'and Today tabs that tidy themselves.' }
    ]
  },
  {
    number: 5,
    id: 'command-bar',
    description: '⌘T : la barre de commandes apparaît, le calcul 12*(3+4) donne 84, puis un onglet ouvert est retrouvé.',
    duration: 6,
    kind: 'window',
    layout: 'stack',
    backdrop: 'white',
    transition: { kind: 'push-up', duration: 0.8 },
    stills: [
      { shot: 'main-window', at: 0 },
      { shot: 'command-bar-calc', at: 1.0, reveal: { spot: 'commandBar', motion: 'pop' } },
      { shot: 'command-bar-tab', at: 3.5, reveal: { spot: 'commandBar', motion: 'fade' } }
    ],
    clips: [{ id: 'command-bar-typing', at: 0.9, replaces: ['command-bar-calc', 'command-bar-tab'] }],
    keys: [{ at: 0.75, keys: ['⌘', 'T'], spot: 'commandBar', shot: 'command-bar-calc' }],
    camera: [
      { at: 1.0, zoom: 1, focus: [0.5, 0] },
      { at: 5.6, zoom: 1.12, focus: [0.5, 0] }
    ],
    rings: [
      { from: 1.7, to: 3.3, spot: 'calcResult', shot: 'command-bar-calc' },
      { from: 3.9, to: 5.7, spot: 'tabResult', shot: 'command-bar-tab' }
    ],
    lines: [
      { at: 0.3, fr: '⌘T.', en: '⌘T.' },
      { at: 1.3, fr: 'Une adresse, un onglet, un calcul.', en: 'An address, a tab, a sum.' }
    ]
  },
  {
    number: 6,
    id: 'split',
    description: 'La page se scinde en deux, puis en quatre volets.',
    duration: 6,
    kind: 'window',
    layout: 'stack-bottom',
    backdrop: 'band',
    transition: { kind: 'blinds', duration: 0.9 },
    stills: [
      { shot: 'main-window', at: 0 },
      { shot: 'split-view', at: 1.5, fade: 0.5 },
      { shot: 'split-view-4', at: 3.7, fade: 0.5 }
    ],
    clips: [{ id: 'split-four', at: 0.8, replaces: ['split-view', 'split-view-4'] }],
    marks: [
      { from: 0.8, to: 1.7, line: [0.6083, 0.01, 0.6083, 0.99] },
      // Each pane splits in two again: four panes side by side (the application puts them in one row, never in a grid).
      { from: 3.0, to: 3.9, line: [0.4142, 0.01, 0.4142, 0.99] },
      { from: 3.0, to: 3.9, line: [0.8017, 0.01, 0.8017, 0.99] }
    ],
    camera: [
      { at: 0, zoom: 1, focus: [0.6, 0.5] },
      { at: 6.4, zoom: 1.06, focus: [0.6, 0.5] }
    ],
    lines: [{ at: 0.4, fr: 'Jusqu’à quatre pages côte à côte.', en: 'Up to four pages side by side.' }]
  },
  {
    number: 7,
    id: 'peek',
    description: '⇧-clic sur un lien : l’aperçu monte par-dessus la page.',
    duration: 5,
    kind: 'window',
    layout: 'panel-right',
    backdrop: 'white',
    fit: 'native',
    transition: { kind: 'push-left', duration: 0.8 },
    stills: [
      { shot: 'main-window', at: 0 },
      { shot: 'peek', at: 1.75, reveal: { spot: 'peekPanel', motion: 'rise' } }
    ],
    clips: [{ id: 'peek-open', at: 1.5, replaces: ['peek'] }],
    camera: [
      { at: 0, zoom: 1, focus: [0.62, 0.52], to: [0.5, 0.5] },
      { at: 5.4, zoom: 1.08, focus: [0.62, 0.5], to: [0.5, 0.5] }
    ],
    cursor: [
      { at: 0.5, spot: 'contentLeft' },
      { at: 1.4, spot: 'peekLink', click: true, key: '⇧' },
      { at: 2.6, spot: 'peekLink' }
    ],
    lines: [
      { at: 0.4, fr: 'Un aperçu,', en: 'A quick look,' },
      { at: 2.0, fr: 'sans quitter votre page.', en: 'without leaving your page.' }
    ]
  },
  {
    number: 8,
    id: 'little-window',
    description: 'Une mini-fenêtre s’ouvre au-dessus d’une autre application.',
    duration: 5,
    kind: 'little',
    layout: 'stack',
    backdrop: 'band',
    transition: { kind: 'fade', duration: 0.6 },
    stills: [
      { shot: 'other-app', at: 0 },
      { shot: 'little-window', at: 1.5 }
    ],
    clips: [{ id: 'little-window-open', at: 0.8, replaces: ['other-app', 'little-window'] }],
    cursor: [
      { at: 0.4, spot: 'link', shot: 'other-app' },
      { at: 1.3, spot: 'link', shot: 'other-app', click: true }
    ],
    lines: [
      { at: 0.3, fr: 'Les liens des autres apps', en: 'Links from other apps' },
      { at: 1.6, fr: 's’ouvrent à part.', en: 'open on their own.' }
    ]
  },
  {
    number: 9,
    id: 'resources',
    description: 'Le panneau des ressources monte ; les onglets s’endorment, la mémoire descend.',
    duration: 7,
    kind: 'window',
    layout: 'panel-left',
    backdrop: 'white',
    fit: 'native',
    transition: { kind: 'zoom', duration: 0.7 },
    stills: [
      { shot: 'main-window', at: 0 },
      { shot: 'resource-panel', at: 1.3, reveal: { spot: 'resourcePanel', motion: 'rise' } },
      { shot: 'resource-panel-asleep', at: 4.3, ifMissing: 'skip', reveal: { spot: 'resourcePanel', motion: 'fade' } }
    ],
    clips: [{ id: 'tabs-sleep', at: 3.9, replaces: ['resource-panel-asleep'] }],
    camera: [
      { at: 0, zoom: 1, focus: [0.11, 0.78], to: [0.3, 0.6] },
      { at: 2.0, zoom: 1.04, focus: [0.11, 0.76], to: [0.3, 0.6] },
      { at: 7.4, zoom: 1.12, focus: [0.11, 0.76], to: [0.32, 0.6] }
    ],
    cursor: [
      { at: 0.3, spot: 'today' },
      { at: 1.0, spot: 'resourceButton', click: true },
      { at: 3.5, spot: 'sleepAll', shot: 'resource-panel' },
      { at: 4.0, spot: 'sleepAll', shot: 'resource-panel', click: true }
    ],
    rings: [
      { from: 2.0, to: 3.3, spot: 'memoryGauge', shot: 'resource-panel' },
      { from: 4.6, to: 6.6, spot: 'memoryGauge', shot: 'resource-panel-asleep', veil: true }
    ],
    lines: [
      { at: 0.4, fr: 'Les onglets oubliés s’endorment.', en: 'Forgotten tabs go to sleep.' },
      { at: 4.4, fr: 'Votre Mac respire.', en: 'Your Mac breathes.' }
    ]
  },
  {
    number: 10,
    id: 'privacy',
    description: 'Passage en sombre : Réglages › Vie privée, le bloqueur activé ; les mots tombent un par un.',
    duration: 7,
    kind: 'window',
    layout: 'panel-right',
    backdrop: 'dark',
    theme: 'dark',
    fit: 1,
    transition: { kind: 'curtain', duration: 1.0 },
    stills: [
      { shot: 'settings-privacy-off', at: 0, ifMissing: 'skip' },
      { shot: 'settings-privacy', at: 3.5, fade: 0.35 }
    ],
    clips: [{ id: 'blocker-on', at: 3.0, replaces: ['settings-privacy'] }],
    camera: [
      { at: 0.4, zoom: 1, focus: [0.5, 0.5] },
      { at: 3.4, zoom: 1.04, focus: [0.5, 0.55] },
      { at: 7.4, zoom: 1.12, focus: [0.5, 0.55] }
    ],
    rings: [{ from: 3.6, to: 6.7, spot: 'blockerRow', shot: 'settings-privacy', veil: true }],
    focusLines: true,
    textMotion: 'fall',
    lines: [
      { at: 0.6, fr: 'Pas de compte.', en: 'No account.' },
      { at: 1.5, fr: 'Pas de télémétrie.', en: 'No telemetry.' },
      { at: 2.4, fr: 'Pas de pistage.', en: 'No tracking.' },
      { at: 3.6, fr: 'Le bloqueur est activé.', en: 'The blocker is on.' }
    ]
  },
  {
    number: 11,
    id: 'mosaic',
    description: 'Montage en mosaïque, une case par seconde : lecture, PDF, traduction, notes, thèmes, mots de passe, extensions.',
    duration: 7,
    kind: 'mosaic',
    layout: 'stack',
    backdrop: 'dark',
    // Light captures on the black of the dark passage: they read better than dark ones, and the passage ends on them.
    theme: 'light',
    transition: { kind: 'mosaic', duration: 1.0 },
    tiles: [
      { shot: 'reader-mode', fr: 'Mode lecture', en: 'Reader mode' },
      { shot: 'pdf-viewer', fr: 'PDF', en: 'PDF' },
      { shot: 'translate', fr: 'Traduction sur ce Mac', en: 'Translation on this Mac' },
      { shot: 'quick-notes', fr: 'Notes rapides', en: 'Quick notes' },
      { shot: 'space-themes', fr: 'Thèmes d’espace', en: 'Space themes' },
      { shot: 'vault-touch-id', fr: 'Mots de passe et Touch ID', en: 'Passwords and Touch ID' },
      { shot: 'extensions', fr: 'Extensions', en: 'Extensions' }
    ],
    lines: [{ at: 0.2, fr: 'Et tout le reste.', en: 'And everything else.' }]
  },
  {
    number: 12,
    id: 'guide',
    description: '« Régler en quelques questions », depuis sa carte de Réglages › Pour commencer, sa seule entrée : une question, une réponse cochée, le récapitulatif.',
    duration: 6,
    kind: 'window',
    layout: 'stack',
    backdrop: 'band',
    fit: 1,
    transition: { kind: 'curtain', duration: 1.0 },
    stills: [
      { shot: 'settings-home', at: 0 },
      { shot: 'settings-guide', at: 1.45, fade: 0.4 },
      { shot: 'settings-guide-recap', at: 4.3, ifMissing: 'skip' }
    ],
    clips: [{ id: 'guide-answer', at: 1.4, replaces: ['settings-guide', 'settings-guide-recap'] }],
    camera: [
      { at: 0.3, zoom: 1, focus: [0.5, 0] },
      { at: 6.4, zoom: 1.08, focus: [0.5, 0] }
    ],
    rings: [
      { from: 0.4, to: 1.3, spot: 'guideCard', shot: 'settings-home' },
      { from: 2.0, to: 3.7, spot: 'firstAnswer', shot: 'settings-guide', veil: true }
    ],
    cursor: [
      { at: 0.3, spot: 'guideCard', shot: 'settings-home' },
      { at: 1.2, spot: 'start', shot: 'settings-home', click: true },
      { at: 3.6, spot: 'next', shot: 'settings-guide' },
      { at: 4.1, spot: 'next', shot: 'settings-guide', click: true }
    ],
    lines: [
      { at: 0.4, fr: 'Tout se règle,', en: 'Set it all up' },
      { at: 1.5, fr: 'en quelques questions.', en: 'in a few questions.' }
    ]
  },
  {
    number: 13,
    id: 'import',
    description: 'La feuille d’import : des espaces et des onglets qui arrivent dans la barre latérale.',
    duration: 6,
    kind: 'window',
    layout: 'panel-left',
    backdrop: 'white',
    transition: { kind: 'push-left', duration: 0.8 },
    stills: [
      { shot: 'import', at: 0 },
      { shot: 'import-done', at: 2.6, fade: 0.5 }
    ],
    clips: [{ id: 'import-arrive', at: 2.2, replaces: ['import-done'] }],
    camera: [
      { at: 0, zoom: 1, focus: [0.5, 0.5] },
      { at: 2.4, zoom: 1.04, focus: [0.5, 0.5] },
      { at: 6.4, zoom: 1.1, focus: [0.15, 0.4] }
    ],
    cursor: [
      { at: 0.6, spot: 'sheet', shot: 'import' },
      { at: 2.0, spot: 'importButton', shot: 'import', click: true }
    ],
    rings: [{ from: 3.4, to: 5.6, spot: 'imported', shot: 'import-done', veil: true }],
    lines: [
      { at: 0.4, fr: 'Importez vos onglets', en: 'Bring your tabs over' },
      { at: 1.4, fr: 'depuis votre navigateur actuel.', en: 'from your current browser.' }
    ]
  },
  {
    number: 14,
    id: 'community',
    description: 'Le site, page Communauté : une idée, un vote qui s’ajoute.',
    duration: 6,
    kind: 'window',
    layout: 'stack',
    backdrop: 'white',
    transition: { kind: 'fade', duration: 0.6 },
    stills: [
      { shot: 'community', at: 0 },
      { shot: 'community-voted', at: 2.5, fade: 0.3 }
    ],
    clips: [{ id: 'community-vote', at: 2.2, replaces: ['community-voted'] }],
    camera: [
      { at: 0.4, zoom: 1, focus: [0.6, 0] },
      { at: 6.4, zoom: 1.12, focus: [0.6, 0] }
    ],
    rings: [{ from: 0.8, to: 2.2, spot: 'idea', shot: 'community', veil: true }],
    cursor: [
      { at: 0.6, spot: 'contentLeft', shot: 'community' },
      { at: 2.3, spot: 'vote', shot: 'community', click: true },
      // Off the button once the vote is counted: the new count shows, and the pointer rests by « Votre voix est comptée ».
      { at: 3.6, spot: 'contentLeft', shot: 'community-voted' }
    ],
    lines: [
      { at: 0.4, fr: 'La suite,', en: 'You vote' },
      { at: 1.3, fr: 'c’est vous qui la votez.', en: 'on what comes next.' }
    ]
  },
  {
    number: 15,
    id: 'closing',
    description: 'Retour au blanc : l’icône, « Gratuit. Libre. Pour Mac. », puis lucium.app.',
    duration: 8,
    kind: 'closing',
    layout: 'center',
    backdrop: 'white',
    transition: { kind: 'fade', duration: 0.8 },
    lines: [
      { at: 0.9, fr: 'Gratuit.', en: 'Free.' },
      { at: 1.35, fr: 'Libre.', en: 'Open.' },
      { at: 1.8, fr: 'Pour Mac.', en: 'For Mac.' },
      { at: 2.8, fr: 'lucium.app', en: 'lucium.app', style: 'accent' },
      { at: 3.5, fr: 'Mac à puce Apple', en: 'Mac with Apple silicon', style: 'small' }
    ]
  }
]

/** The text of a line, a tile or a localized value in a language. */
export const inLang = (value: { fr: string; en: string }, lang: Lang): string => value[lang]
