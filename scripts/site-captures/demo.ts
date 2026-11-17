// The demonstration profile of the captures of the site: three spaces of distinct colours (Travail, Maison, Projets), their pinned tabs, folders and
// tabs of the day, the favourites, the settings that make the language and the theme, the place of the window, the quick notes, the logins of the
// vault, the extension the page of extensions shows (and two more for the features page), and the bookmarks file the import sheet reads (a file
// in the format every browser exports, which names no browser). Every page lives under the reserved domain `.example` and is served by the script on 127.0.0.1 (pages.ts draws them),
// but the Community page of the public site, read from a checkout of the site (community.ts): no real name, no real address, no personal data,
// nothing fetched from the Internet. The state is the format of `state.json` (src/shared/model.ts); demo.test.ts reads it back through the
// application's own `normalize`.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Favorite, Folder, Settings, Space, TabItem } from '../../src/shared/model'
import { PROTECTION_OF_NEW_PROFILES } from '../../src/shared/model-defaults'
import type { SpaceTheme } from '../../src/shared/theme'
import type { Site } from './pages'
import type { DemoExtensionKind, Lang, Localized, SpaceKey, Theme } from './shots'

export type PageKind = 'notes' | 'board' | 'weather' | 'recipes' | 'museum' | 'agenda' | 'checklist' | 'library' | 'trip' | 'article' | 'sowing' | 'roadmap' | 'palette' | 'pdf'

/** The glyph drawn on a favicon. */
export type IconGlyph = 'notes' | 'board' | 'sun' | 'bowl' | 'columns' | 'calendar' | 'check' | 'book' | 'pin' | 'doc' | 'leaf' | 'flag' | 'drops' | 'tool'

export interface PageDef {
  key: string
  kind: PageKind
  glyph: IconGlyph
  /** The colour of the favicon and of the accents of the page. */
  color: string
  /** The name under `.example` (`carnet` is `carnet.example`). */
  host: Localized<string>
  path: Localized<string>
  title: Localized<string>
}

const page = (key: string, kind: PageKind, glyph: IconGlyph, color: string, host: [string, string], path: [string, string], title: [string, string]): PageDef => ({
  key,
  kind,
  glyph,
  color,
  host: { fr: host[0], en: host[1] },
  path: { fr: path[0], en: path[1] },
  title: { fr: title[0], en: title[1] }
})

/** Every page of the demonstration, by key. */
export const PAGES: readonly PageDef[] = [
  page('notes', 'notes', 'notes', '#e8a33d', ['carnet', 'notebook'], ['/', '/'], ['Carnet de notes', 'Notebook']),
  page('meeting', 'notes', 'notes', '#e8a33d', ['carnet', 'notebook'], ['/reunion-lundi', '/monday-meeting'], ['Compte rendu — lundi', 'Meeting notes — Monday']),
  page('agenda-items', 'checklist', 'check', '#3fa66b', ['carnet', 'notebook'], ['/ordre-du-jour', '/agenda'], ['Ordre du jour — jeudi', 'Thursday’s agenda']),
  page('style-guide', 'article', 'doc', '#5b6ee1', ['docs', 'docs'], ['/guide-de-style', '/style-guide'], ['Guide de style', 'Style guide']),
  page('glossary', 'article', 'doc', '#5b6ee1', ['docs', 'docs'], ['/glossaire', '/glossary'], ['Glossaire du projet', 'Project glossary']),
  page('weather', 'weather', 'sun', '#f2b72e', ['meteo', 'weather'], ['/semaine', '/week'], ['Météo de la semaine', 'This week’s weather']),
  page('naming', 'article', 'doc', '#8a63d2', ['lecture', 'reading'], ['/bien-nommer-ses-fichiers', '/naming-files'], ['Bien nommer ses fichiers', 'Naming your files well']),
  page('board', 'board', 'board', '#4c7cf0', ['projet', 'project'], ['/tableau', '/board'], ['Mosaïque — Tableau', 'Mosaic — Board']),
  page('recipes', 'recipes', 'bowl', '#e0683a', ['recettes', 'recipes'], ['/saison', '/seasonal'], ['Recettes de saison', 'Seasonal recipes']),
  page('sowing', 'sowing', 'leaf', '#47a85a', ['jardin', 'garden'], ['/semis', '/sowing'], ['Calendrier des semis', 'Sowing calendar']),
  page('trip', 'trip', 'pin', '#2f9fb3', ['voyage', 'trip'], ['/itineraire', '/itinerary'], ['Trois jours sur la côte', 'Three days on the coast']),
  page('weekend', 'checklist', 'check', '#3fa66b', ['carnet', 'notebook'], ['/week-end', '/weekend'], ['Idées pour le week-end', 'Weekend ideas']),
  page('shelf', 'article', 'tool', '#9a7b4f', ['bricolage', 'diy'], ['/etagere-murale', '/wall-shelf'], ['Fabriquer une étagère murale', 'Building a wall shelf']),
  page('roadmap', 'roadmap', 'flag', '#18a589', ['projet', 'project'], ['/feuille-de-route', '/roadmap'], ['Mosaïque — Feuille de route', 'Mosaic — Roadmap']),
  page('ideas', 'notes', 'notes', '#e8a33d', ['atelier', 'studio'], ['/idees', '/ideas'], ['Atelier — Idées en vrac', 'Studio — Loose ideas']),
  page('palette', 'palette', 'drops', '#d2508a', ['atelier', 'studio'], ['/palette', '/palette'], ['Palette de couleurs', 'Colour palette']),
  page('agenda', 'agenda', 'calendar', '#e25555', ['agenda', 'calendar'], ['/semaine', '/week'], ['Agenda de la semaine', 'Week planner']),
  page('groceries', 'checklist', 'check', '#3fa66b', ['courses', 'groceries'], ['/liste', '/list'], ['Liste de courses', 'Shopping list']),
  page('library', 'library', 'book', '#b5643c', ['bibliotheque', 'library'], ['/nouveautes', '/new'], ['Bibliothèque — Nouveautés', 'Library — New arrivals']),
  page('museum', 'museum', 'columns', '#7d5bbf', ['musee', 'museum'], ['/horaires', '/hours'], ['Musée — Horaires et expositions', 'Museum — Hours and exhibitions']),
  page('maps', 'article', 'book', '#8a63d2', ['lecture', 'reading'], ['/cartes-anciennes', '/old-maps'], ['Le goût des cartes anciennes', 'The pull of old maps']),
  page('report', 'pdf', 'doc', '#18a589', ['rapports', 'reports'], ['/bilan-trimestre.pdf', '/quarterly-review.pdf'], ['Mosaïque — Bilan du trimestre', 'Mosaic — Quarterly review'])
]

export const pageDef = (key: string): PageDef => {
  const found = PAGES.find((p) => p.key === key)
  if (!found) throw new Error(`page de démonstration inconnue : ${key}`)
  return found
}

/**
 * A tab whose page is not drawn by pages.ts: the Community page of the public site, read from a checkout of the site and shown under its own
 * address (community.ts, `communityUrl`). Its icon is the one the page declares, which the application takes when the page loads.
 */
export interface SiteTabDef {
  key: string
  url: Localized<string>
  title: Localized<string>
}

export const SITE_TABS: readonly SiteTabDef[] = [
  { key: 'community', url: { fr: 'https://lucium.app/communaute/', en: 'https://lucium.app/en/community/' }, title: { fr: 'Communauté — proposer et voter', en: 'Community — suggest and vote' } }
]

/** What a tab of the demonstration holds: the address, the title and (for a page of pages.ts) the icon. */
export function tabPage(key: string, lang: Lang): { url: string; title: string; faviconUrl?: string } {
  const site = SITE_TABS.find((tab) => tab.key === key)
  if (site) return { url: site.url[lang], title: site.title[lang] }
  const def = pageDef(key)
  return { url: pageUrl(key, lang), title: def.title[lang], faviconUrl: faviconUri(def) }
}

/** `https://carnet.example/` and so on: the address of a page in a language. */
export const pageUrl = (key: string, lang: Lang): string => {
  const def = pageDef(key)
  return `https://${def.host[lang]}.example${def.path[lang]}`
}

const bareHost = (host: string): string => host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')

/** The page served at this host and path, in this language, or undefined. */
export function pageAt(host: string, path: string, lang: Lang): PageDef | undefined {
  const bare = bareHost(host)
  return PAGES.find((p) => `${p.host[lang]}.example` === bare && p.path[lang] === path)
}

/** What pages.ts `respond` serves: every page in both languages (no address is the same in the two), and their icons. */
export function demoSite(): Site {
  return {
    find: (host, path) => {
      for (const lang of ['fr', 'en'] as const) {
        const def = pageAt(host, path, lang)
        if (def) return { def, lang }
      }
      return undefined
    },
    first: (host) => PAGES.find((p) => (['fr', 'en'] as const).some((lang) => `${p.host[lang]}.example` === bareHost(host))),
    icon: (def) => ({ uri: faviconUri(def), svg: faviconSvg(def) }),
    urlOf: (key, lang) => pageUrl(key, lang)
  }
}

// ---------- favicons ----------

const GLYPHS: Readonly<Record<IconGlyph, string>> = {
  notes: '<rect x="10" y="8" width="12" height="16" rx="2" fill="none" stroke="#fff" stroke-width="2"/><path d="M13 13h6M13 17h6M13 21h3" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  board: '<rect x="8" y="9" width="4.5" height="14" rx="1.5" fill="#fff"/><rect x="13.75" y="9" width="4.5" height="10" rx="1.5" fill="#fff" opacity=".85"/><rect x="19.5" y="9" width="4.5" height="6" rx="1.5" fill="#fff" opacity=".7"/>',
  sun: '<circle cx="16" cy="16" r="4.5" fill="#fff"/><path d="M16 7v3M16 22v3M7 16h3M22 16h3M9.6 9.6l2.1 2.1M20.3 20.3l2.1 2.1M9.6 22.4l2.1-2.1M20.3 11.7l2.1-2.1" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  bowl: '<path d="M8 15h16a8 8 0 0 1-16 0Z" fill="#fff"/><path d="M13 8c-1 1.5 1 2.5 0 4M17 8c-1 1.5 1 2.5 0 4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  columns: '<path d="M7 12 16 7l9 5Z" fill="#fff"/><path d="M10 13v8M14 13v8M18 13v8M22 13v8" stroke="#fff" stroke-width="2.2"/><rect x="7" y="22" width="18" height="2.5" rx="1" fill="#fff"/>',
  calendar: '<rect x="8" y="9" width="16" height="15" rx="2.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M8 13.5h16M12 7v4M20 7v4" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="18.5" r="2" fill="#fff"/>',
  check: '<rect x="8" y="8" width="16" height="16" rx="4" fill="none" stroke="#fff" stroke-width="2"/><path d="m11.5 16.2 3 3 6-6.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  book: '<path d="M9 9.5c2.5-1 5-1 7 .5v14c-2-1.5-4.5-1.5-7-.5Z" fill="#fff"/><path d="M23 9.5c-2.5-1-5-1-7 .5v14c2-1.5 4.5-1.5 7-.5Z" fill="#fff" opacity=".8"/>',
  pin: '<path d="M16 25s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11Z" fill="#fff"/><circle cx="16" cy="14" r="2.3" fill="currentColor"/>',
  doc: '<path d="M11 7h7l5 5v13H11Z" fill="#fff"/><path d="M14 16h6M14 19.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  leaf: '<path d="M9 23c0-9 5-14 15-14 0 10-5 15-14 15" fill="#fff"/><path d="M10 23c3-4 6-7 10-9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  flag: '<path d="M10 7v19" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M11 8h11l-2.5 4 2.5 4H11Z" fill="#fff"/>',
  drops: '<circle cx="12.5" cy="13" r="4" fill="#fff"/><circle cx="19.5" cy="13" r="4" fill="#fff" opacity=".8"/><circle cx="16" cy="19" r="4" fill="#fff" opacity=".65"/>',
  tool: '<path d="M19.5 7.5a4.5 4.5 0 0 0-4.3 5.9l-7 7 2.4 2.4 7-7a4.5 4.5 0 0 0 5.9-4.3l-2.6 2.6-2.4-.6-.6-2.4Z" fill="#fff"/>'
}

/** The icon of a page as a small SVG: a rounded square of its colour and a white glyph. */
export function faviconSvg(def: Pick<PageDef, 'glyph' | 'color'>): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" color="${def.color}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${def.color}"/><stop offset="1" stop-color="${def.color}" stop-opacity=".78"/></linearGradient></defs>` +
    `<rect width="32" height="32" rx="8" fill="url(#g)"/>${GLYPHS[def.glyph]}</svg>`
  )
}

/** The same icon as a `data:` address: what the state keeps for a tab and what the page declares. */
export const faviconUri = (def: Pick<PageDef, 'glyph' | 'color'>): string => `data:image/svg+xml,${encodeURIComponent(faviconSvg(def))}`

// ---------- the spaces ----------

interface SpaceDef {
  key: SpaceKey
  name: Localized<string>
  emoji: string
  colors: [string, string]
  pinned: string[]
  folders: Array<{ key: string; name: Localized<string>; collapsed: boolean; tabs: string[] }>
  today: string[]
  selected: string
}

export const SPACES: readonly SpaceDef[] = [
  {
    key: 'work',
    name: { fr: 'Travail', en: 'Work' },
    emoji: '💼',
    colors: ['#4f74f2', '#8a5cf0'],
    pinned: ['board', 'notes'],
    folders: [
      { key: 'meetings', name: { fr: 'Réunions', en: 'Meetings' }, collapsed: false, tabs: ['meeting', 'agenda-items'] },
      { key: 'docs', name: { fr: 'Documentation', en: 'Documentation' }, collapsed: true, tabs: ['style-guide', 'glossary'] }
    ],
    today: ['weather', 'naming'],
    selected: 'notes'
  },
  {
    key: 'home',
    name: { fr: 'Maison', en: 'Home' },
    emoji: '🏡',
    colors: ['#f0883e', '#e65c7b'],
    pinned: ['recipes', 'sowing'],
    folders: [{ key: 'getaway', name: { fr: 'Escapade', en: 'Getaway' }, collapsed: false, tabs: ['trip', 'weekend'] }],
    today: ['shelf'],
    selected: 'recipes'
  },
  {
    key: 'projects',
    name: { fr: 'Projets', en: 'Projects' },
    emoji: '🧩',
    colors: ['#1fae7e', '#2aa9c4'],
    pinned: ['roadmap', 'ideas'],
    folders: [{ key: 'studio', name: { fr: 'Atelier', en: 'Studio' }, collapsed: false, tabs: ['palette'] }],
    // The pages of the mosaic of the film (an article for the reader mode, a PDF) and the Community page of the site.
    today: ['maps', 'report', 'community'],
    selected: 'roadmap'
  }
]

/** The favourites of the default profile, shown as tiles on top of every space. */
export const FAVORITES: readonly string[] = ['agenda', 'groceries', 'library', 'museum']

export const spaceId = (key: SpaceKey): string => `demo-space-${key}`
/** The id of the tab of a page in a space (a page is in one space at most). */
export const tabId = (space: SpaceKey, page: string): string => `demo-${space}-${page}`

/** The space a page's tab is in, or undefined for a page that has no tab. */
export function spaceOfPage(key: string): SpaceKey | undefined {
  return SPACES.find((s) => [...s.pinned, ...s.folders.flatMap((f) => f.tabs), ...s.today].includes(key))?.key
}

/** The theme of a space: two colours of its own, with the texture of the default theme, following the appearance of the window. */
export function spaceTheme(colors: [string, string]): SpaceTheme {
  return { baseColors: [...colors], harmony: 'custom', angle: 155, intensity: 1, overlay: 'grain', noise: 0.06, translucency: 'light', vibrant: true, appearance: 'auto' }
}

/**
 * The settings of the demonstration. The language and the theme are the application's own settings (Réglages › Pour commencer › Langue, Apparence);
 * the rest keeps the shots clean: no question before quitting, no sheet of a first launch, no suggestion asked of a search engine, every tab awake.
 * The protection is the one a new profile starts with (« Renforcée », `PROTECTION_OF_NEW_PROFILES`), written out with the baseline of a new profile: a
 * state file that does not name those settings is read as a profile made before that default, which keeps « Standard » and takes it as its reference
 * (sidebar-state.ts), so the images would show the protection as changed. They show what a new user sees.
 */
export function demoSettings(lang: Lang, theme: Theme): Partial<Settings> {
  return {
    ...PROTECTION_OF_NEW_PROFILES,
    protectionBaseline: 'renforcee',
    interfaceTranslated: true,
    language: lang,
    interfaceAppearance: theme,
    warnBeforeQuitting: false,
    welcomeDone: true,
    firstLaunchDone: true,
    suggestionsNoticeSeen: true,
    searchSuggestions: false,
    loadAllTabsAtLaunch: true,
    sleepAfterMinutes: 0,
    sleepAwakeMax: 0,
    autoArchiveHours: 0,
    hoverCards: false
  }
}

export interface DemoState {
  version: 1
  spaces: Space[]
  tabs: TabItem[]
  folders: Folder[]
  favorites: Favorite[]
  activeSpaceId: string
  activeTabBySpace: Record<string, string | null>
  settings: Partial<Settings>
}

export interface DemoStateOptions {
  /** Tabs to leave out (the Community page when no checkout of the site is at hand: its tab would show the local server's 404). */
  leaveOut?: readonly string[]
}

/** The `state.json` of the demonstration profile. `now`: the moment of the run (the tabs were used a few minutes ago). */
export function demoState(lang: Lang, theme: Theme, now: number, options: DemoStateOptions = {}): DemoState {
  const spaces: Space[] = []
  const tabs: TabItem[] = []
  const folders: Folder[] = []
  const activeTabBySpace: Record<string, string | null> = {}
  const kept = (key: string) => !(options.leaveOut ?? []).includes(key)
  let minutes = 1
  const tab = (space: SpaceKey, key: string, pinned: boolean, folderId?: string): TabItem => {
    const { url, title, faviconUrl } = tabPage(key, lang)
    const at = now - minutes++ * 60_000
    return { id: tabId(space, key), spaceId: spaceId(space), url, title, ...(faviconUrl ? { faviconUrl } : {}), pinned, ...(folderId ? { folderId } : {}), createdAt: at - 3_600_000, lastActiveAt: at }
  }
  for (const s of SPACES) {
    spaces.push({ id: spaceId(s.key), name: s.name[lang], emoji: s.emoji, theme: spaceTheme(s.colors), profileId: 'default' })
    for (const key of s.pinned.filter(kept)) tabs.push(tab(s.key, key, true))
    for (const f of s.folders) {
      const id = `demo-folder-${f.key}`
      folders.push({ id, spaceId: spaceId(s.key), name: f.name[lang], collapsed: f.collapsed })
      for (const key of f.tabs.filter(kept)) tabs.push(tab(s.key, key, true, id))
    }
    for (const key of s.today.filter(kept)) tabs.push(tab(s.key, key, false))
    activeTabBySpace[spaceId(s.key)] = tabId(s.key, s.selected)
  }
  const favorites: Favorite[] = FAVORITES.map((key) => {
    const def = pageDef(key)
    return { id: `demo-favorite-${key}`, url: pageUrl(key, lang), title: def.title[lang], faviconUrl: faviconUri(def), profileId: 'default' }
  })
  return { version: 1, spaces, tabs, folders, favorites, activeSpaceId: spaceId('work'), activeTabBySpace, settings: demoSettings(lang, theme) }
}

/** `windows.json`: where the main window opens (Réglages › Onglets › Restaurer les fenêtres, on by default). */
export const demoWindows = (bounds: { x: number; y: number; width: number; height: number }) => ({ main: bounds, windows: [] as unknown[] })

// ---------- the quick notes (`notes.json` of the profile, the shot `quick-notes`) ----------

/** The page the shot `quick-notes` shows its notes over: two notes are about it, one about its space, one about another page. */
export const NOTES_PAGE = 'recipes'

/** `notes.json` (src/shared/notes.ts, `notesFileText`): notes written a few days before the run. */
export function demoNotes(lang: Lang, now: number): { version: 1; notes: Array<{ id: string; text: string; createdAt: number; updatedAt: number; link: { kind: 'page'; url: string } | { kind: 'space'; spaceId: string } }> } {
  const fr = lang === 'fr'
  const day = 86_400_000
  const note = (id: string, text: string, daysAgo: number, link: { kind: 'page'; url: string } | { kind: 'space'; spaceId: string }) => ({ id, text, createdAt: now - daysAgo * day - 3_600_000, updatedAt: now - daysAgo * day, link })
  const page = (key: string) => ({ kind: 'page' as const, url: pageUrl(key, lang) })
  return {
    version: 1,
    notes: [
      note('demo-gratin', fr ? 'Courses pour le gratin\n- un potimarron\n- de la crème\n- du fromage râpé' : 'Shopping for the gratin\n- one squash\n- cream\n- grated cheese', 0, page(NOTES_PAGE)),
      note('demo-soup', fr ? 'Soupe de saison : doubler les quantités pour samedi, on sera six.' : 'Seasonal soup: double the amounts for Saturday, there will be six of us.', 1, page(NOTES_PAGE)),
      note('demo-menus', fr ? 'Menus de la semaine\n- lundi : soupe\n- mercredi : tarte aux poireaux\n- vendredi : crumble' : 'Menus for the week\n- Monday: soup\n- Wednesday: leek tart\n- Friday: crumble', 2, { kind: 'space', spaceId: spaceId('home') }),
      note('demo-maps', fr ? 'Lire jusqu’au bout l’article sur les cartes anciennes.' : 'Finish the article on old maps.', 4, page('maps'))
    ]
  }
}

// ---------- the password vault (the shot `vault-touch-id`) ----------

/** The logins put in the throw-away vault of the profile, through the application's own requests. The passwords are drawn at random by the script. */
export const VAULT_LOGINS: ReadonlyArray<{ page: string; username: Localized<string> }> = [
  { page: 'notes', username: { fr: 'atelier@carnet.example', en: 'studio@notebook.example' } },
  { page: 'board', username: { fr: 'equipe.mosaique', en: 'mosaic.team' } },
  { page: 'agenda', username: { fr: 'agenda.maison', en: 'home.calendar' } },
  { page: 'library', username: { fr: 'lecteur-0427', en: 'reader-0427' } },
  { page: 'recipes', username: { fr: 'cuisine.du.dimanche', en: 'sunday.cooking' } }
]

/** The page the shot shows the vault over: its login is the one the panel puts first. */
export const VAULT_PAGE = 'notes'

// ---------- the demonstration extension (the shot `extensions`) ----------

/** The manifest of the unpacked extension the shot loads: no brand, no permission, nothing that runs; an icon of its own (`extensionIcon`). */
export function extensionManifest(lang: Lang): object {
  const fr = lang === 'fr'
  return {
    manifest_version: 3,
    name: fr ? 'Surligneur' : 'Highlighter',
    version: '1.2.0',
    description: fr ? 'Surligne les passages importants d’une page, en quatre couleurs.' : 'Highlights the important passages of a page, in four colors.',
    icons: { '128': 'icon-128.png' }
  }
}

/**
 * The icon of the extension, `size` × `size` RGBA pixels: a rounded square of a warm yellow and a white marker stroke across it, drawn from
 * distances (anti-aliased edges, transparent corners). The script makes a PNG of it (capture.ts `encodePng`).
 */
export function extensionIcon(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4)
  const half = size / 2
  const radius = size * 0.22
  const cover = (distance: number) => Math.min(1, Math.max(0, 0.5 - distance))
  // The marker: a segment with round ends.
  const [ax, ay, bx, by] = [size * 0.3, size * 0.68, size * 0.7, size * 0.32]
  const thickness = size * 0.075
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const qx = Math.abs(px - half) - (half - radius)
      const qy = Math.abs(py - half) - (half - radius)
      const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
      const background = cover(box)
      const t = Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
      const stroke = cover(Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))) - thickness) * background
      // From a light yellow at the top to an amber at the bottom.
      const mix = y / (size - 1)
      const base = [247 - 10 * mix, 205 - 40 * mix, 72 - 30 * mix]
      const at = (y * size + x) * 4
      for (let c = 0; c < 3; c++) pixels[at + c] = Math.round(base[c]! * (1 - stroke) + 255 * stroke)
      pixels[at + 3] = Math.round(background * 255)
    }
  }
  return pixels
}

// ---------- the extensions of the features page (features.ts, `demoExtension`) ----------

/** The keyword the extension `keyword` declares (`omnibox.keyword` of its manifest): typed in the command bar, then a word. */
export const DEMO_KEYWORD = 'glo'

/**
 * The worker of the extension `groups`: a page of the demonstration asks it (the script, through `chrome.runtime.sendMessage`) to make one group of
 * the tabs at these addresses, under this title; it answers the id of the group, or why there is none. It does nothing else, and only when asked.
 */
export const GROUPS_WORKER = `// Makes the tab group a page of the demonstration asks for: the tabs at these addresses, under this title.
chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.kind !== 'group' || !Array.isArray(message.urls) || typeof message.title !== 'string') return false
  chrome.tabs
    .query({})
    .then(async (tabs) => {
      const ids = message.urls.map((url) => tabs.find((tab) => tab.url === url)?.id)
      const missing = message.urls.filter((_url, index) => ids[index] === undefined)
      if (missing.length > 0) return reply({ ok: false, error: 'no tab at ' + missing.join(', ') + ' among ' + tabs.map((tab) => tab.url).join(', ') })
      const groupId = await chrome.tabs.group({ tabIds: ids })
      await chrome.tabGroups.update(groupId, { title: message.title, color: 'blue' })
      reply({ ok: true, groupId })
    })
    .catch((error) => reply({ ok: false, error: String(error?.message ?? error) }))
  return true
})
`

export interface DemoExtensionDef {
  /** Its name in each language: how the script finds it in the extensions of the application. */
  name: Localized<string>
  /** Its files in a language, by name: the manifest, and the worker of `groups`. */
  files: (lang: Lang) => Record<string, string>
}

/**
 * The extensions the features page loads for the image of a feature that needs one (features.ts `demoExtension`): no brand, no icon, no host
 * permission; `keyword` declares a keyword and runs nothing, `groups` holds the permissions of the tab groups and answers only the pages of the
 * demonstration.
 */
export const DEMO_EXTENSIONS: Readonly<Record<DemoExtensionKind, DemoExtensionDef>> = {
  keyword: {
    name: { fr: 'Glossaire', en: 'Glossary' },
    files: (lang) => ({
      'manifest.json': JSON.stringify(
        {
          manifest_version: 3,
          name: DEMO_EXTENSIONS.keyword.name[lang],
          version: '1.0.0',
          description: lang === 'fr' ? 'Cherche un mot dans le glossaire du projet : « glo » puis le mot, dans la barre de commandes.' : 'Looks up a word in the project glossary: “glo” then the word, in the command bar.',
          omnibox: { keyword: DEMO_KEYWORD }
        },
        null,
        2
      )
    })
  },
  groups: {
    name: { fr: 'Rangement des onglets', en: 'Tab Tidy' },
    files: (lang) => ({
      'manifest.json': JSON.stringify(
        {
          manifest_version: 3,
          name: DEMO_EXTENSIONS.groups.name[lang],
          version: '1.0.0',
          description: lang === 'fr' ? 'Range les onglets d’une même tâche dans un groupe.' : 'Puts the tabs of one task in a group.',
          permissions: ['tabs', 'tabGroups'],
          background: { service_worker: 'worker.js' },
          // Only the pages of the demonstration may ask (every host of the language, each named).
          externally_connectable: { matches: [...new Set(PAGES.map((def) => `https://${def.host[lang]}.example/*`))] }
        },
        null,
        2
      ),
      'worker.js': GROUPS_WORKER
    })
  }
}

// ---------- the bookmarks file (the import sheet reads it from a made-up home folder) ----------

/** A link of the bookmarks file: a page of the demonstration (served, so that its tab shows it) or another address under `.example`. */
export type BookmarkLink = { page: string } | { url: string; title: Localized<string> }

export interface BookmarkFolderDef {
  title: Localized<string>
  links: BookmarkLink[]
}

/** At the top of the file, then in folders. The first link is the tab `import-done` shows; none is a pinned tab of the demonstration. */
export const BOOKMARK_LINKS: readonly BookmarkLink[] = [
  { page: 'weather' },
  { page: 'shelf' },
  { url: 'https://journal.example/', title: { fr: 'Le journal du matin', en: 'The morning paper' } }
]

export const BOOKMARK_FOLDERS: readonly BookmarkFolderDef[] = [
  {
    title: { fr: 'Lecture', en: 'Reading' },
    links: [
      { url: 'https://lecture.example/marcher-en-ville', title: { fr: 'Marcher en ville', en: 'Walking in the city' } },
      { url: 'https://lecture.example/histoire-des-cartes', title: { fr: 'Une histoire des cartes', en: 'A history of maps' } },
      { url: 'https://lecture.example/le-bruit-du-vent', title: { fr: 'Le bruit du vent', en: 'The sound of the wind' } }
    ]
  },
  {
    title: { fr: 'Voyages', en: 'Travel' },
    links: [
      { url: 'https://voyage.example/carnet', title: { fr: 'Carnet de voyage', en: 'Travel journal' } },
      { url: 'https://trains.example/horaires', title: { fr: 'Horaires des trains', en: 'Train times' } },
      { url: 'https://voyage.example/montagne', title: { fr: 'Une semaine en montagne', en: 'A week in the mountains' } }
    ]
  },
  {
    title: { fr: 'Cuisine', en: 'Cooking' },
    links: [
      { url: 'https://cuisine.example/pain', title: { fr: 'Pain au levain', en: 'Sourdough bread' } },
      { url: 'https://cuisine.example/soupes', title: { fr: 'Soupes d’hiver', en: 'Winter soups' } },
      { url: 'https://marche.example/saison', title: { fr: 'Fruits et légumes de saison', en: 'Fruit and vegetables in season' } }
    ]
  }
]

/** The address and the title of a link of the file, in a language. */
export function bookmarkLink(link: BookmarkLink, lang: Lang): { url: string; title: string } {
  return 'page' in link ? { url: pageUrl(link.page, lang), title: pageDef(link.page).title[lang] } : { url: link.url, title: link.title[lang] }
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The bookmarks file of the demonstration, in the Netscape format every browser exports (a `<DL>` list, `<H3>` for a folder, `<A HREF>` for a
 * link): what « Fichier de signets (HTML) » of the import sheet reads. Neither its name nor its text says a browser's name; the importer makes
 * of it one new space, « Signets importés ».
 */
export function bookmarksFile(lang: Lang): { name: string; html: string } {
  const added = 1_790_000_000
  const anchor = (link: BookmarkLink, indent: string): string => {
    const { url, title } = bookmarkLink(link, lang)
    return `${indent}<DT><A HREF="${escapeHtml(url)}" ADD_DATE="${added}">${escapeHtml(title)}</A>`
  }
  const heading = lang === 'fr' ? 'Signets' : 'Bookmarks'
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${heading}</TITLE>`,
    `<H1>${heading}</H1>`,
    '<DL><p>',
    ...BOOKMARK_LINKS.map((link) => anchor(link, '    ')),
    ...BOOKMARK_FOLDERS.flatMap((folder) => [
      `    <DT><H3 ADD_DATE="${added}">${escapeHtml(folder.title[lang])}</H3>`,
      '    <DL><p>',
      ...folder.links.map((link) => anchor(link, '        ')),
      '    </DL><p>'
    ]),
    '</DL><p>',
    ''
  ]
  return { name: lang === 'fr' ? 'signets.html' : 'bookmarks.html', html: lines.join('\n') }
}

/** Where the made-up home folder keeps the bookmarks file: the file chooser of the import is answered with it. */
export const bookmarksPath = (home: string, lang: Lang): string => `${home.replace(/\/+$/, '')}/Documents/${bookmarksFile(lang).name}`
