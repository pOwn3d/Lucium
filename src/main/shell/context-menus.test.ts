// The context menus of the sidebar, in blocks (the same entries, set in blocks). The menus are the real ones (`menuItems`), with Electron
// replaced by a record of what was asked of it. What is measured: every entry the menus had is still there (the lists below were read from the menus before
// they were set in blocks), the space has one entry to customize it, the blocks come in a fixed order with the destructive one last, every entry
// has an icon (red for the ones that erase or close), and a shortcut is shown only where it would do what the entry does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { t } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { MENU_ICON_PNG, MENU_ICON_RED_PNG } from './menu-icons-data'

const { boxes, boxAnswer } = vi.hoisted(() => ({ boxes: [] as unknown[], boxAnswer: { value: 1 } }))

interface FakeIcon {
  png: string
  template: boolean
}
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const nativeImage = {
    createFromBuffer: (bytes: Buffer): FakeIcon & { isEmpty(): boolean; setTemplateImage(value: boolean): void } => {
      const icon = { png: bytes.toString('base64'), template: false, isEmpty: () => false, setTemplateImage: (value: boolean) => void (icon.template = value) }
      return icon
    }
  }
  // The boxes asked for are recorded, and answered with what `boxAnswer` holds (1: Annuler).
  const dialog = { showMessageBoxSync: (_win: unknown, options: unknown) => (boxes.push(options), boxAnswer.value) }
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template }, nativeImage, dialog }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

import { menuItems, moveTabsToSpace, type MenuContext } from './context-menus'
import { frenchSpaces } from '@shared/french-typography'
import { setLockService } from '../lock-service'

type Item = Electron.MenuItemConstructorOptions & { icon?: FakeIcon }

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (s: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((acc, a) => reduce(acc, a, ctx), s)

function fakeBrowser(priv = false, windows: Array<{ id: string; label: string; title?: string }> = [], own: Record<string, unknown> = {}) {
  const dispatched: Action[] = []
  const overlays: unknown[] = []
  const sent: Array<[string, string]> = []
  const base: Record<string, unknown> = {
    isPrivate: () => priv,
    // The real browser answers no window from a private one (Browser.windowMoveChoices).
    windowMoveChoices: () => (priv ? [] : windows),
    sendTabToWindow: (tabId: string, windowId: string) => void sent.push([tabId, windowId]),
    dispatch: (action: Action) => void dispatched.push(action),
    openOverlay: (request: unknown) => void overlays.push(request),
    snapshot: () => ({ runtime: { tabs: {} }, extensions: [], downloads: [] }),
    livePageIds: () => [],
    sleepStateOf: () => 'awake',
    isShown: () => false,
    isScrollSynced: () => false,
    ...own
  }
  const browser = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : () => undefined) }) as never
  return { browser, dispatched, overlays, sent }
}

/**
 * Two spaces and every setting that adds an entry on. Four tabs, in the order a, b, c, d and the child of a: d is pinned and has left its address,
 * b and c are in a split view, a is on screen. One favourite, a folder and a live folder.
 */
function fixture() {
  let s = createInitialState(ctx)
  s = run(s, { type: 'settings/update', patch: { tabTree: true, webPanels: true, bookmarkManager: true, webAppWindows: true, tabContainers: true, liveFolders: true, boostSharing: true, siteDataClearOnCloseEnabled: true } })
  s = run(s, { type: 'container/create', name: 'Travail' })
  s = run(s, { type: 'space/create', name: 'Autre', emoji: '🎨', hue: 40 })
  s = run(s, { type: 'space/select', id: s.spaces[0]!.id })
  for (const host of ['a', 'b', 'c', 'd']) s = run(s, { type: 'tab/open', url: `https://${host}.example.org/`, background: true })
  const [a, b, c, d] = s.tabs.map((t) => t.id) as [string, string, string, string]
  s = run(s, { type: 'tab/pin', id: d }, { type: 'split/create', tabId: b, withTabId: c }, { type: 'favorite/add', url: 'https://fav.example.org/', title: 'Fav' }, { type: 'folder/create', name: 'Dossier' })
  s = run(s, { type: 'livefolder/create', source: { kind: 'feed', url: 'https://feed.example.org/rss' }, name: 'Live' })
  s = run(s, { type: 'tab/open', url: 'https://child.example.org/', background: true, parentId: a }, { type: 'tab/update', id: d, patch: { url: 'https://d.example.org/elsewhere' } }, { type: 'tab/select', id: a })
  const child = s.tabs.find((t) => t.url === 'https://child.example.org/')!.id
  return { state: s, a, b, c, d, child, space: s.spaces[0]!.id, other: s.spaces[1]!.id, favorite: s.favorites[0]!.id, folder: s.folders.find((f) => !f.live)!.id, live: s.folders.find((f) => f.live)!.id }
}

const WITH_HEADERS: MenuContext = { clipboardText: '', headers: true }
const WITHOUT_HEADERS: MenuContext = { clipboardText: '', headers: false }

function menu(target: Parameters<typeof menuItems>[0], state: SidebarState, context: MenuContext = WITH_HEADERS, priv = false, windows: Array<{ id: string; label: string; title?: string }> = []) {
  const { browser, dispatched, overlays, sent } = fakeBrowser(priv, windows)
  const items = menuItems(target, browser, { get: () => state } as never, {} as never, context) as Item[]
  return { items, dispatched, overlays, sent }
}

/** Every label of a menu, the entries of its submenus after their own, one level in (two spaces): the form of the lists below. */
const flat = (items: Item[]): string[] => items.filter((i) => i.type !== 'separator' && i.type !== 'header').flatMap((i) => [i.label ?? '?', ...(Array.isArray(i.submenu) ? (i.submenu as Item[]).filter((x) => x.label).map((x) => `  ${x.label}`) : [])])
/** The titles of the blocks of a menu, in order. */
const titles = (items: Item[]): string[] => items.filter((i) => i.type === 'header').map((i) => i.label!)
/** The entries of the block that starts at header `title`. */
const blockOf = (items: Item[], title: string): Item[] => {
  const from = items.findIndex((i) => i.type === 'header' && i.label === title)
  const rest = items.slice(from + 1)
  const end = rest.findIndex((i) => i.type === 'header')
  return end === -1 ? rest : rest.slice(0, end)
}
const find = (items: Item[], label: string): Item => {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no entry "${label}" in: ${flat(items).join(' | ')}`)
  return found
}
const press = (item: Item): void => (item.click as unknown as () => void)()

/** What every menu offered before it was set in blocks (labels, then those of the submenus, in the order they were shown). */
const BEFORE: Record<string, string[]> = {
  'space': [
    'Changer l’icône de l’espace…', 'Renommer l’espace…', 'Modifier la couleur du thème…', 'Définir le profil', '  Profil par défaut', '  Nouveau profil…',
    'Copier le thème', 'Coller le thème', 'Appliquer ce thème à tous les espaces', 'Exporter le thème dans un fichier…', 'Importer un thème depuis un fichier…',
    'Nouveau dossier', 'Masquer l’en-tête de l’espace', 'Aperçu dans la carte de survol', 'Vider les onglets du jour', 'Volets web',
    '  Ajouter la page en volet web', '  Retirer un volet web', '  Fermer le volet web', 'Mettre l’espace de côté…', 'Verrouiller l’espace…', 'Gérer les espaces…',
    'Supprimer l’espace…'
  ],
  'tab-normal': [
    'Copier le lien', 'Partager', 'Changer l’icône…', 'Renommer…', 'Couper le son', 'Ajouter une vue scindée', 'Dupliquer', 'Archiver l’onglet',
    'Archiver les autres onglets', 'Archiver les onglets en dessous', 'Archiver les onglets au-dessus', 'Épingler', 'Ajouter aux favoris',
    'Déplacer vers le haut', 'Déplacer vers le bas', 'Déplacer vers l’espace', '  🎨 Autre', 'Déplacer vers la fenêtre', '  Nouvelle fenêtre', 'Retirer de la vue scindée', 'Empiler les volets (vertical)', 'Enregistrer comme vue de travail…', 'Ajouter un onglet à la vue scindée',
    '  d.example.org', '  a.example.org', '  child.example.org', 'Recharger automatiquement', '  Désactivé', frenchSpaces('  5 s'), frenchSpaces('  10 s'), frenchSpaces('  30 s'), frenchSpaces('  1 min'), frenchSpaces('  2 min'),
    frenchSpaces('  5 min'), frenchSpaces('  10 min'), '  Personnalisé…', 'Mettre en veille', 'Geler (garde la page en mémoire)', 'Ne jamais mettre cet onglet en veille',
    'Garder un onglet de ce site éveillé', 'Effacer les données du site à la fermeture', 'Lire plus tard', 'Ouvrir dans un conteneur', '  Travail',
    '  Sans conteneur', 'Toujours ouvrir b.example.org dans', '  Travail', '  Aucun conteneur (retirer la règle)', 'Ajouter aux signets',
    'Ouvrir comme application', 'Fermer l’onglet', 'Fermer les autres onglets du jour'
  ],
  'tab-parent': [
    'Copier le lien', 'Partager', 'Changer l’icône…', 'Renommer…', 'Couper le son', 'Ajouter une vue scindée', 'Dupliquer', 'Archiver l’onglet',
    'Archiver les autres onglets', 'Archiver les onglets en dessous', 'Replier les onglets enfants', 'Archiver l’onglet et ses onglets enfants', 'Épingler',
    'Ajouter aux favoris', 'Déplacer vers le haut', 'Déplacer vers le bas', 'Déplacer vers l’espace', '  🎨 Autre', 'Déplacer vers la fenêtre', '  Nouvelle fenêtre', 'Vue scindée avec…', '  d.example.org', '  child.example.org', 'Recharger automatiquement',
    '  Désactivé', frenchSpaces('  5 s'), frenchSpaces('  10 s'), frenchSpaces('  30 s'), frenchSpaces('  1 min'), frenchSpaces('  2 min'), frenchSpaces('  5 min'), frenchSpaces('  10 min'), '  Personnalisé…', 'Mettre en veille',
    'Geler (garde la page en mémoire)', 'Ne jamais mettre cet onglet en veille', 'Garder un onglet de ce site éveillé',
    'Effacer les données du site à la fermeture', 'Lire plus tard', 'Ouvrir dans un conteneur', '  Travail', '  Sans conteneur',
    'Toujours ouvrir a.example.org dans', '  Travail', '  Aucun conteneur (retirer la règle)', 'Ajouter aux signets', 'Ouvrir comme application',
    'Fermer l’onglet', 'Fermer les autres onglets du jour'
  ],
  'tab-child': [
    'Copier le lien', 'Partager', 'Changer l’icône…', 'Renommer…', 'Couper le son', 'Ajouter une vue scindée', 'Dupliquer', 'Archiver l’onglet',
    'Archiver les autres onglets', 'Archiver les onglets en dessous', 'Archiver les onglets au-dessus', 'Sortir l’onglet de son parent', 'Épingler',
    'Ajouter aux favoris', 'Déplacer vers le haut', 'Déplacer vers le bas', 'Déplacer vers l’espace', '  🎨 Autre', 'Déplacer vers la fenêtre', '  Nouvelle fenêtre', 'Vue scindée avec…', '  d.example.org', '  a.example.org', 'Recharger automatiquement',
    '  Désactivé', frenchSpaces('  5 s'), frenchSpaces('  10 s'), frenchSpaces('  30 s'), frenchSpaces('  1 min'), frenchSpaces('  2 min'), frenchSpaces('  5 min'), frenchSpaces('  10 min'), '  Personnalisé…', 'Mettre en veille',
    'Geler (garde la page en mémoire)', 'Ne jamais mettre cet onglet en veille', 'Garder un onglet de ce site éveillé',
    'Effacer les données du site à la fermeture', 'Lire plus tard', 'Ouvrir dans un conteneur', '  Travail', '  Sans conteneur',
    'Toujours ouvrir child.example.org dans', '  Travail', '  Aucun conteneur (retirer la règle)', 'Ajouter aux signets', 'Ouvrir comme application',
    'Fermer l’onglet', 'Fermer les autres onglets du jour'
  ],
  'tab-pinned': [
    'Copier le lien', 'Partager', 'Changer l’icône…', 'Renommer…', 'Couper le son', 'Ajouter une vue scindée', 'Dupliquer', 'Mettre en veille', 'Désépingler',
    'Revenir à l’adresse épinglée', 'Remplacer l’adresse épinglée par la page actuelle', 'Séparer de l’onglet épinglé', 'Ajouter aux favoris',
    'Déplacer vers le haut', 'Déplacer vers le bas', 'Déplacer vers l’espace', '  🎨 Autre', 'Déplacer vers la fenêtre', '  Nouvelle fenêtre', 'Vue scindée avec…', '  a.example.org', '  child.example.org', 'Recharger automatiquement', '  Désactivé', frenchSpaces('  5 s'),
    frenchSpaces('  10 s'), frenchSpaces('  30 s'), frenchSpaces('  1 min'), frenchSpaces('  2 min'), frenchSpaces('  5 min'), frenchSpaces('  10 min'), '  Personnalisé…', 'Geler (garde la page en mémoire)',
    'Ne jamais mettre cet onglet en veille', 'Garder un onglet de ce site éveillé', 'Effacer les données du site à la fermeture', 'Lire plus tard',
    'Ouvrir dans un conteneur', '  Travail', '  Sans conteneur', 'Toujours ouvrir d.example.org dans', '  Travail', '  Aucun conteneur (retirer la règle)',
    'Ajouter aux signets', 'Ouvrir comme application', 'Fermer l’onglet', 'Fermer les autres onglets du jour'
  ],
  'favorite': [
    'Copier le lien', 'Partager', 'Renommer…', 'Couper le son', 'Modifier la page épinglée', '  Revenir à l’adresse épinglée',
    '  Remplacer l’adresse épinglée par la page actuelle', 'Ouvrir en vue scindée', 'Ouvrir dans une mini-fenêtre', 'Déplacer vers le haut', 'Déplacer vers le bas', 'Déplacer vers', '  🏠 Perso', '  🎨 Autre',
    'Retirer des favoris'
  ],
  'folder': [
    'Nouveau sous-dossier', frenchSpaces('Transformer « Dossier » en espace'), 'Copier tous les liens', 'Copier tous les liens en Markdown', 'Changer l’icône…', 'Renommer…', 'Dupliquer',
    'Mettre au début d’Aujourd’hui', 'Mettre en bas de la liste', 'Ne jamais réveiller automatiquement', 'Archiver le dossier', 'Supprimer le dossier (garder les onglets)'
  ],
  'folder-live': [
    'Nouveau sous-dossier', frenchSpaces('Transformer « Live » en espace'), 'Copier tous les liens', 'Copier tous les liens en Markdown', 'Changer l’icône…', 'Renommer…',
    'Actualiser le dossier en direct', 'Modifier la source…', 'Dupliquer', 'Mettre au début d’Aujourd’hui', 'Mettre en bas de la liste', 'Ne jamais réveiller automatiquement', 'Archiver le dossier', 'Supprimer le dossier (garder les onglets)'
  ],
  // « Empiler les volets (vertical) » became « Disposition », which offers the row, the column and the grid. « Enregistrer comme vue de travail… » came with
  // the work views, on by default.
  'split': [
    'Déplacer le volet vers la gauche', 'Déplacer le volet vers la droite', 'Ajouter une vue scindée', 'Disposition', '  Côte à côte', '  En colonne', '  Grille',
    'Enregistrer comme vue de travail…', 'Séparer cet onglet de la vue scindée', 'Copier le lien'
  ],
  'selection': [
    'Archiver 2 onglets', 'Nouveau dossier avec la sélection', 'Copier les liens en Markdown', 'Enregistrer comme session…', 'Épingler 2 onglets',
    'Déplacer vers l’espace', '  🎨 Autre', 'Fermer 2 onglets'
  ]
}
const sorted = (list: string[]): string[] => [...list].sort()

describe('the entries of the menus', () => {
  const f = fixture()
  const cases: Array<[string, Parameters<typeof menuItems>[0]]> = [
    ['tab-normal', { kind: 'tab', id: f.b }],
    ['tab-parent', { kind: 'tab', id: f.a }],
    ['tab-child', { kind: 'tab', id: f.child }],
    ['tab-pinned', { kind: 'tab', id: f.d }],
    ['favorite', { kind: 'favorite', id: f.favorite }],
    ['folder', { kind: 'folder', id: f.folder }],
    ['folder-live', { kind: 'folder', id: f.live }],
    ['split', { kind: 'split', id: f.b }],
    ['selection', { kind: 'tab', id: f.a, selection: [f.a, f.c] }]
  ]

  it.each(cases)('%s: every entry it had is still there, and none is new', (name, target) => {
    const { items } = menu(target, f.state)
    expect(sorted(flat(items))).toEqual(sorted(BEFORE[name]!))
  })

  it('space: the same entries, but one "Personnaliser l’espace…" in place of the icon and the theme colour', () => {
    const { items } = menu({ kind: 'space', id: f.space }, f.state)
    const expected = [...BEFORE['space']!.filter((label) => label !== 'Changer l’icône de l’espace…' && label !== 'Modifier la couleur du thème…'), 'Personnaliser l’espace…']
    expect(sorted(flat(items))).toEqual(sorted(expected))
    expect(flat(items)).not.toContain('Changer l’icône de l’espace…')
    expect(flat(items)).not.toContain('Modifier la couleur du thème…')
  })

  it('are the same with or without section headers: only the dividers differ', () => {
    for (const [name, target] of cases) {
      const withHeaders = menu(target, f.state, WITH_HEADERS).items
      const without = menu(target, f.state, WITHOUT_HEADERS).items
      expect(flat(without), name).toEqual(flat(withHeaders))
      expect(without.some((i) => i.type === 'header'), name).toBe(false)
      // One separator between two blocks, none at the start or the end, none twice in a row.
      expect(without.filter((i) => i.type === 'separator')).toHaveLength(titles(withHeaders).length - 1)
      expect(without[0]!.type).not.toBe('separator')
      expect(without.at(-1)!.type).not.toBe('separator')
      without.forEach((item, index) => index > 0 && expect([item.type, without[index - 1]!.type], name).not.toEqual(['separator', 'separator']))
    }
  })
})

describe('the blocks', () => {
  const f = fixture()

  it('the menu of a space: Personnaliser, Thème, Organiser, then Supprimer', () => {
    const { items } = menu({ kind: 'space', id: f.space }, f.state)
    expect(titles(items)).toEqual(['Personnaliser', 'Thème', 'Organiser', 'Supprimer'])
    expect(flat(blockOf(items, 'Personnaliser'))).toEqual(['Personnaliser l’espace…', 'Renommer l’espace…', 'Définir le profil', '  Profil par défaut', '  Nouveau profil…'])
    expect(flat(blockOf(items, 'Supprimer'))).toEqual(['Vider les onglets du jour', 'Supprimer l’espace…'])
  })

  it('the menu of a tab: Ouvrir, Personnaliser, Organiser, Veille, then Archiver et fermer', () => {
    expect(titles(menu({ kind: 'tab', id: f.b }, f.state).items)).toEqual(['Ouvrir', 'Personnaliser', 'Organiser', 'Veille', 'Archiver et fermer'])
    const { items } = menu({ kind: 'tab', id: f.a }, f.state)
    expect(flat(blockOf(items, 'Veille'))).toEqual(['Mettre en veille', 'Geler (garde la page en mémoire)', 'Ne jamais mettre cet onglet en veille', 'Garder un onglet de ce site éveillé'])
    expect(flat(blockOf(items, 'Archiver et fermer')).slice(-2)).toEqual(['Fermer l’onglet', 'Fermer les autres onglets du jour'])
  })

  it('names what the list of sites keeps awake: one tab of the site, or every one when Réglages keeps them all', () => {
    const all = { ...f.state, settings: { ...f.state.settings, sleepExcludedKeepAll: true } }
    expect(flat(blockOf(menu({ kind: 'tab', id: f.a }, f.state).items, 'Veille')).at(-1)).toBe('Garder un onglet de ce site éveillé')
    expect(flat(blockOf(menu({ kind: 'tab', id: f.a }, all).items, 'Veille')).at(-1)).toBe('Garder tous les onglets de ce site éveillés')
  })

  it('the menu of a folder: Créer et copier, Personnaliser, Organiser, Supprimer; a live folder adds Dossier en direct after the first', () => {
    expect(titles(menu({ kind: 'folder', id: f.folder }, f.state).items)).toEqual(['Créer et copier', 'Personnaliser', 'Organiser', 'Supprimer'])
    expect(titles(menu({ kind: 'folder', id: f.live }, f.state).items)).toEqual(['Créer et copier', 'Dossier en direct', 'Personnaliser', 'Organiser', 'Supprimer'])
  })

  it('the menu of a favourite: Ouvrir, Personnaliser, Organiser, then Retirer', () => {
    expect(titles(menu({ kind: 'favorite', id: f.favorite }, f.state).items)).toEqual(['Ouvrir', 'Personnaliser', 'Organiser', 'Retirer'])
  })

  it('the menu of a selection and of a split pane are in blocks too, the destructive one last', () => {
    expect(titles(menu({ kind: 'tab', id: f.a, selection: [f.a, f.c] }, f.state).items)).toEqual(['Organiser', 'Archiver et fermer'])
    expect(titles(menu({ kind: 'split', id: f.b }, f.state).items)).toEqual(['Ouvrir', 'Organiser', 'Retirer'])
  })

  it('a block with no entry is left out with its title: no "Dossier en direct" while the function is off, no web panels or containers when off', () => {
    const off = run(f.state, { type: 'settings/update', patch: { liveFolders: false, webPanels: false, tabContainers: false, boostSharing: false, bookmarkManager: false, webAppWindows: false } })
    expect(titles(menu({ kind: 'folder', id: f.live }, off).items)).toEqual(['Créer et copier', 'Personnaliser', 'Organiser', 'Supprimer'])
    const space = menu({ kind: 'space', id: f.space }, off).items
    expect(flat(space)).not.toContain('Volets web')
    expect(flat(blockOf(space, 'Thème'))).toEqual(['Copier le thème', 'Coller le thème', 'Appliquer ce thème à tous les espaces'])
    const tab = menu({ kind: 'tab', id: f.b }, off).items
    expect(flat(tab).some((label) => label.startsWith('Ouvrir dans un conteneur'))).toBe(false)
  })

  it('a private window has no menu of a space, and its tabs keep no list, bookmark or application window', () => {
    expect(menu({ kind: 'space', id: f.space }, f.state, WITH_HEADERS, true).items).toEqual([])
    const labels = flat(menu({ kind: 'tab', id: f.a }, f.state, WITH_HEADERS, true).items)
    for (const gone of ['Lire plus tard', 'Ajouter aux signets', 'Ouvrir comme application', 'Ne jamais mettre cet onglet en veille']) expect(labels).not.toContain(gone)
  })

  it('shows a title as a section header only where the system can (macOS 14), and by itself decides from the system it runs on', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    const version = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      ;(process as unknown as { getSystemVersion: () => string }).getSystemVersion = () => '14.4.1'
      const modern = menu({ kind: 'folder', id: f.folder }, f.state, { clipboardText: '' }).items
      expect(modern.filter((i) => i.type === 'header').map((i) => i.label)).toEqual(['Créer et copier', 'Personnaliser', 'Organiser', 'Supprimer'])
      expect(modern.some((i) => i.type === 'separator')).toBe(false)
      ;(process as unknown as { getSystemVersion: () => string }).getSystemVersion = () => '13.6.0'
      const old = menu({ kind: 'folder', id: f.folder }, f.state, { clipboardText: '' }).items
      expect(old.some((i) => i.type === 'header')).toBe(false)
      expect(old.filter((i) => i.type === 'separator')).toHaveLength(3)
    } finally {
      Object.defineProperty(process, 'platform', real)
      if (version) (process as unknown as { getSystemVersion?: () => string }).getSystemVersion = version
      else delete (process as unknown as { getSystemVersion?: () => string }).getSystemVersion
    }
  })
})

describe('the sleep of a frozen tab', () => {
  it('offers « Dégeler l’onglet » in place of « Geler », which thaws it where it is (not shown, not reloaded)', () => {
    const { state, a } = fixture()
    const thawed: string[] = []
    const { browser, dispatched } = fakeBrowser(false, [], { sleepStateOf: () => 'frozen', thawTab: async (id: string) => void thawed.push(id) })
    const items = menuItems({ kind: 'tab', id: a }, browser, { get: () => state } as never, {} as never, WITH_HEADERS) as Item[]
    const sleep = blockOf(items, 'Veille')
    expect(flat(sleep)).toEqual(['Mettre en veille', 'Dégeler l’onglet', 'Ne jamais mettre cet onglet en veille', 'Garder un onglet de ce site éveillé'])
    const entry = find(sleep, 'Dégeler l’onglet')
    expect(entry.enabled).not.toBe(false)
    press(entry)
    expect(thawed).toEqual([a])
    expect(dispatched).toEqual([])
  })
})

describe('« Disposition » in the menu of a split view', () => {
  const arrangements = (items: Item[]) => (find(blockOf(items, 'Organiser'), 'Disposition').submenu as Item[]).map((i) => ({ label: i.label, type: i.type, checked: i.checked, enabled: i.enabled !== false }))

  it('offers the row, the column and the grid as radio entries, the arrangement of the split view checked; no grid for two panes', () => {
    const f = fixture()
    expect(arrangements(menu({ kind: 'split', id: f.b }, f.state).items)).toEqual([
      { label: 'Côte à côte', type: 'radio', checked: true, enabled: true },
      { label: 'En colonne', type: 'radio', checked: false, enabled: true },
      { label: 'Grille', type: 'radio', checked: false, enabled: false }
    ])
    const stacked = run(f.state, { type: 'split/orientation', id: f.state.splits[0]!.id, orientation: 'vertical' })
    expect(arrangements(menu({ kind: 'split', id: f.b }, stacked).items).map((e) => e.checked)).toEqual([false, true, false])
  })

  it('switches a split view of three or four from one arrangement to another without dragging', () => {
    const f = fixture()
    const three = run(f.state, { type: 'split/create', tabId: f.b, withTabId: f.a })
    const id = three.splits[0]!.id
    const { items, dispatched } = menu({ kind: 'split', id: f.b }, three)
    const grid = (find(blockOf(items, 'Organiser'), 'Disposition').submenu as Item[]).find((i) => i.label === 'Grille')!
    expect(grid.enabled).not.toBe(false)
    press(grid)
    expect(dispatched).toEqual([{ type: 'split/layout', id, layout: 'grid' }])
    const inGrid = run(three, dispatched[0]!)
    expect(inGrid.splits[0]?.grid).toEqual({ column: 0.5, row: 0.5, span: 'bottom' })
    expect(arrangements(menu({ kind: 'split', id: f.b }, inGrid).items).map((e) => e.checked)).toEqual([false, false, true])
    // Back to a column from the grid.
    const back = menu({ kind: 'split', id: f.b }, inGrid)
    press((find(blockOf(back.items, 'Organiser'), 'Disposition').submenu as Item[]).find((i) => i.label === 'En colonne')!)
    expect(run(inGrid, back.dispatched[0]!).splits[0]).toMatchObject({ orientation: 'vertical', tabIds: three.splits[0]!.tabIds })
    expect(run(inGrid, back.dispatched[0]!).splits[0]?.grid).toBeUndefined()
  })
})

describe('"Personnaliser l’espace…"', () => {
  const f = fixture()

  it('opens the panel of the space, on the colour of the sidebar the user sees: the space is chosen first', () => {
    const { items, dispatched, overlays } = menu({ kind: 'space', id: f.other }, f.state)
    press(find(items, 'Personnaliser l’espace…'))
    expect(dispatched).toEqual([{ type: 'space/select', id: f.other }])
    expect(overlays).toEqual([{ panel: 'space', spaceId: f.other }])
  })

  it('leaves "Renommer l’espace…" on the name and "Nouveau profil…" on the profile', () => {
    const { items, overlays } = menu({ kind: 'space', id: f.space }, f.state)
    press(find(items, 'Renommer l’espace…'))
    press(find((find(items, 'Définir le profil').submenu as Item[]) ?? [], 'Nouveau profil…'))
    expect(overlays).toEqual([
      { panel: 'space', spaceId: f.space, focus: 'name' },
      { panel: 'space', spaceId: f.space, focus: 'profile' }
    ])
  })
})

describe('the sheets a menu opens hang from the row that was right-clicked', () => {
  const f = fixture()
  const row = { x: 12, y: 300, width: 220, height: 32 }

  it('passes the row to "Renommer…", "Changer l’icône…" and the typed interval of the automatic reload on a tab', () => {
    const { items, overlays } = menu({ kind: 'tab', id: f.b, anchor: row }, f.state)
    press(find(items, 'Renommer…'))
    press(find(items, 'Changer l’icône…'))
    press(find((find(items, 'Recharger automatiquement').submenu as Item[]) ?? [], 'Personnalisé…'))
    expect(overlays).toEqual([
      { panel: 'tab', tabId: f.b, focus: 'name', anchor: row },
      { panel: 'tab', tabId: f.b, focus: 'icon', anchor: row },
      { panel: 'autoreload', tabId: f.b, anchor: row }
    ])
  })

  it('passes the tile of a favourite to its "Renommer…"', () => {
    const { items, overlays } = menu({ kind: 'favorite', id: f.favorite, anchor: row }, f.state)
    press(find(items, 'Renommer…'))
    expect(overlays).toEqual([{ panel: 'favorite', favoriteId: f.favorite, anchor: row }])
  })

  it('opens the sheet centred, without an anchor, when the menu was not given a rectangle', () => {
    const tab = menu({ kind: 'tab', id: f.b, anchor: { x: Number.NaN, y: 0, width: 1, height: 1 } }, f.state)
    press(find(tab.items, 'Renommer…'))
    const favorite = menu({ kind: 'favorite', id: f.favorite }, f.state)
    press(find(favorite.items, 'Renommer…'))
    expect(tab.overlays).toEqual([{ panel: 'tab', tabId: f.b, focus: 'name' }])
    expect(favorite.overlays).toEqual([{ panel: 'favorite', favoriteId: f.favorite }])
  })
})

describe('the icons', () => {
  const f = fixture()
  const targets: Array<[string, Parameters<typeof menuItems>[0]]> = [
    ['space', { kind: 'space', id: f.space }],
    ['sidebar (the space, after « Barre de cette fenêtre »)', { kind: 'space', id: f.space, sidebar: true }],
    ['tab', { kind: 'tab', id: f.b }],
    ['tab with a tree', { kind: 'tab', id: f.a }],
    ['pinned tab', { kind: 'tab', id: f.d }],
    ['favourite', { kind: 'favorite', id: f.favorite }],
    ['folder', { kind: 'folder', id: f.live }],
    ['split pane', { kind: 'split', id: f.b }],
    ['selection', { kind: 'tab', id: f.a, selection: [f.a, f.c] }]
  ]
  let log: ReturnType<typeof vi.spyOn>
  beforeEach(() => void (log = vi.spyOn(console, 'error').mockImplementation(() => {})))
  afterEach(() => log.mockRestore())

  it.each(targets)('%s: every entry that is not a tick box has an icon, a picture of the table', (_name, target) => {
    const { items } = menu(target, f.state)
    const pictures = new Set<string>([...Object.values(MENU_ICON_PNG), ...Object.values(MENU_ICON_RED_PNG)])
    const entries = items.filter((i) => i.type !== 'separator' && i.type !== 'header' && i.type !== 'checkbox' && i.type !== 'radio')
    expect(entries.filter((i) => !i.icon).map((i) => i.label)).toEqual([])
    for (const item of entries) expect(pictures.has(item.icon!.png), item.label).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('has no icon on a tick box (the tick is its mark) and none on a header', () => {
    const { items } = menu({ kind: 'tab', id: f.b }, f.state)
    for (const item of items.filter((i) => i.type === 'checkbox' || i.type === 'header')) expect(item.icon, item.label).toBeUndefined()
  })

  it('draws the entries that erase, close or remove in red, as pictures that keep their colour, and the others as template images', () => {
    const red = new Set(['Vider les onglets du jour', 'Supprimer l’espace…', 'Fermer l’onglet', 'Fermer les autres onglets du jour', 'Fermer 2 onglets', 'Retirer des favoris', 'Supprimer le dossier (garder les onglets)'])
    const seen = new Set<string>()
    for (const [, target] of targets) {
      for (const item of menu(target, f.state).items) {
        if (!item.icon) continue
        if (red.has(item.label!)) {
          seen.add(item.label!)
          expect(item.icon.template, item.label).toBe(false)
          expect(Object.values(MENU_ICON_RED_PNG) as string[], item.label).toContain(item.icon.png)
        } else {
          expect(item.icon.template, item.label).toBe(true)
          expect(Object.values(MENU_ICON_PNG) as string[], item.label).toContain(item.icon.png)
        }
      }
    }
    expect([...seen].sort()).toEqual([...red].sort())
  })

  it('puts the red entries in the last block of the menu', () => {
    const lastBlock = (target: Parameters<typeof menuItems>[0]): string[] => {
      const { items } = menu(target, f.state)
      return flat(blockOf(items, titles(items).at(-1)!))
    }
    expect(lastBlock({ kind: 'space', id: f.space })).toEqual(['Vider les onglets du jour', 'Supprimer l’espace…'])
    expect(lastBlock({ kind: 'folder', id: f.folder })).toEqual(['Supprimer le dossier (garder les onglets)'])
    expect(lastBlock({ kind: 'favorite', id: f.favorite })).toEqual(['Retirer des favoris'])
    expect(lastBlock({ kind: 'tab', id: f.b }).slice(-2)).toEqual(['Fermer l’onglet', 'Fermer les autres onglets du jour'])
  })
})

describe('the icon of a folder', () => {
  const f = fixture()

  it('is chosen in a sheet of its own, from « Changer l’icône… », for an ordinary folder and for a live one', () => {
    for (const id of [f.folder, f.live]) {
      const { items, overlays, dispatched } = menu({ kind: 'folder', id }, f.state)
      press(find(blockOf(items, 'Personnaliser'), 'Changer l’icône…'))
      expect(overlays).toEqual([{ panel: 'foldericon', folderId: id }])
      // Nothing is changed by the menu itself: the sheet saves.
      expect(dispatched).toEqual([])
    }
  })

  it('is greyed out in a private window, which opens no such sheet', () => {
    const { items } = menu({ kind: 'folder', id: f.folder }, f.state, WITH_HEADERS, true)
    expect(find(blockOf(items, 'Personnaliser'), 'Changer l’icône…').enabled).toBe(false)
  })
})

describe('the place of a folder in the list', () => {
  const f = fixture()

  it('offers to put a root folder at the bottom of the list, and the dispatch is the action that does it', () => {
    const { items, dispatched } = menu({ kind: 'folder', id: f.folder }, f.state)
    const entry = find(blockOf(items, 'Organiser'), 'Mettre en bas de la liste')
    expect(flat(blockOf(items, 'Organiser'))).not.toContain('Mettre en haut de la liste')
    press(entry)
    expect(dispatched).toEqual([{ type: 'folder/bottom', id: f.folder, bottom: true }])
  })

  it('offers the way back once it is there: "Mettre en haut de la liste"', () => {
    const down = run(f.state, { type: 'folder/bottom', id: f.folder, bottom: true })
    const { items, dispatched } = menu({ kind: 'folder', id: f.folder }, down)
    expect(flat(blockOf(items, 'Organiser'))).not.toContain('Mettre en bas de la liste')
    press(find(blockOf(items, 'Organiser'), 'Mettre en haut de la liste'))
    expect(dispatched).toEqual([{ type: 'folder/bottom', id: f.folder, bottom: false }])
  })

  it('offers the start of Today, from the top and from the bottom, and the dispatch puts the folder first among the ones there', () => {
    for (const state of [f.state, run(f.state, { type: 'folder/bottom', id: f.folder, bottom: true })]) {
      const { items, dispatched } = menu({ kind: 'folder', id: f.folder }, state)
      press(find(blockOf(items, 'Organiser'), 'Mettre au début d’Aujourd’hui'))
      expect(dispatched).toEqual([{ type: 'folder/move', id: f.folder, parentId: null, toIndex: 0, side: 'today-start' }])
    }
  })

  it('offers, at the start of Today, the two other places: the top of the list and its bottom', () => {
    const start = run(f.state, { type: 'folder/move', id: f.folder, parentId: null, toIndex: 0, side: 'today-start' })
    const { items } = menu({ kind: 'folder', id: f.folder }, start)
    const labels = flat(blockOf(items, 'Organiser'))
    expect(labels).not.toContain('Mettre au début d’Aujourd’hui')
    const up = menu({ kind: 'folder', id: f.folder }, start)
    press(find(blockOf(up.items, 'Organiser'), 'Mettre en haut de la liste'))
    expect(up.dispatched).toEqual([{ type: 'folder/bottom', id: f.folder, bottom: false }])
    const down = menu({ kind: 'folder', id: f.folder }, start)
    press(find(blockOf(down.items, 'Organiser'), 'Mettre en bas de la liste'))
    expect(down.dispatched).toEqual([{ type: 'folder/bottom', id: f.folder, bottom: true }])
  })

  it('offers neither for a folder inside another one: it is placed with its parent', () => {
    const nested = run(f.state, { type: 'folder/create', name: 'Dedans', parentId: f.folder })
    const child = nested.folders.find((folder) => folder.name === 'Dedans')!
    const labels = flat(menu({ kind: 'folder', id: child.id }, nested).items)
    expect(labels).not.toContain('Mettre en bas de la liste')
    expect(labels).not.toContain('Mettre en haut de la liste')
    expect(labels).not.toContain('Mettre au début d’Aujourd’hui')
    expect(labels).toContain('Dupliquer')
  })

  it('gives the entries the icon of the table (an arrow down, an arrow up)', () => {
    const down = run(f.state, { type: 'folder/bottom', id: f.folder, bottom: true })
    const pictures = new Set<string>([...Object.values(MENU_ICON_PNG), ...Object.values(MENU_ICON_RED_PNG)])
    for (const [state, label] of [[f.state, 'Mettre en bas de la liste'], [down, 'Mettre en haut de la liste'], [f.state, 'Mettre au début d’Aujourd’hui']] as const) {
      const entry = find(menu({ kind: 'folder', id: f.folder }, state).items, label)
      expect(pictures.has(entry.icon!.png), label).toBe(true)
    }
  })
})

describe('the shortcuts shown at the right of an entry', () => {
  const f = fixture()

  it('are the user’s own, and appear only on the entries of the tab on screen: they act on that tab', () => {
    const onScreen = find(menu({ kind: 'tab', id: f.a }, f.state).items, 'Épingler')
    expect(onScreen.accelerator).toBe('CmdOrCtrl+D')
    expect(onScreen.registerAccelerator).toBe(false)
    const elsewhere = find(menu({ kind: 'tab', id: f.b }, f.state).items, 'Épingler')
    expect(elsewhere.accelerator).toBeUndefined()
    // The user's own shortcut, or none when it was taken away.
    const own = run(f.state, { type: 'settings/update', patch: { keyBindings: { pin: 'Ctrl+Alt+P', closeTab: '' } } })
    const items = menu({ kind: 'tab', id: f.a }, own).items
    expect(find(items, 'Épingler').accelerator).toBe('Ctrl+Alt+P')
    expect(find(items, 'Archiver l’onglet').accelerator).toBeUndefined()
  })

  it('on a space: only on the space on screen, except "Gérer les espaces…" which is not about one space', () => {
    const shown = menu({ kind: 'space', id: f.space }, f.state).items
    expect(find(shown, 'Vider les onglets du jour').accelerator).toBe('CmdOrCtrl+Shift+K')
    const away = menu({ kind: 'space', id: f.other }, f.state).items
    expect(find(away, 'Vider les onglets du jour').accelerator).toBeUndefined()
    expect(find(away, 'Mettre l’espace de côté…').accelerator).toBeUndefined()
    const bound = run(f.state, { type: 'settings/update', patch: { keyBindings: { manageSpaces: 'CmdOrCtrl+Alt+M' } } })
    expect(find(menu({ kind: 'space', id: f.other }, bound).items, 'Gérer les espaces…').accelerator).toBe('CmdOrCtrl+Alt+M')
  })
})

describe('the spaces the menus list', () => {
  it('show a space that wears coloured letters by its letters, not by the emoji it keeps for later', () => {
    const f = fixture()
    const state = run(f.state, { type: 'space/update', id: f.other, patch: { iconLetter: 'ac', iconKind: 'letter' } })
    const moveTo = find(menu({ kind: 'tab', id: f.a }, state).items, 'Déplacer vers l’espace')
    expect((moveTo.submenu as Item[]).map((entry) => entry.label)).toEqual(['AC Autre'])
    const favoriteMove = find(menu({ kind: 'favorite', id: f.favorite }, state).items, 'Déplacer vers')
    expect((favoriteMove.submenu as Item[]).map((entry) => entry.label)).toContain('AC Autre')
  })

  it('still show the emoji of a space that wears its emoji', () => {
    const f = fixture()
    const moveTo = find(menu({ kind: 'tab', id: f.a }, f.state).items, 'Déplacer vers l’espace')
    expect((moveTo.submenu as Item[]).map((entry) => entry.label)).toEqual(['🎨 Autre'])
  })
})

describe('moving a tab to a space of another profile', () => {
  it('says first that a call under way will be cut when the page is live, and moves nothing on Annuler', () => {
    let s = run(createInitialState(ctx), { type: 'space/create', name: 'Work', emoji: '💼', hue: 200, profileName: 'Travail' })
    const work = s.spaces.find((space) => space.name === 'Work')!.id
    s = run(s, { type: 'tab/open', url: 'https://meet.fr/', spaceId: s.spaces[0]!.id, background: true })
    const meet = s.tabs.find((tab) => tab.url === 'https://meet.fr/')!.id
    const store = { get: () => s } as never
    for (const live of [false, true]) {
      const { browser, dispatched } = fakeBrowser()
      ;(browser as unknown as Record<string, unknown>).hasLivePage = (ids: string[]) => live && ids.includes(meet)
      boxes.length = 0
      moveTabsToSpace(browser, store, {} as never, [meet], work)
      expect((boxes[0] as { message: string }).message === t('tabtransfer.page-rechargee-appel-coupe')).toBe(live)
      expect(dispatched).toEqual([])
    }
  })
})

describe('the reordering entries of the menus', () => {
  it('a tab at the top of its Today tabs cannot go up; the one under it goes down by a click, one place (tab/move)', () => {
    const f = fixture()
    const today = f.state.tabs.filter((t) => t.spaceId === f.space && !t.pinned && t.favoriteId === undefined).map((t) => t.id)
    // The child of the first tab cannot go above its parent: the second root of the list is the one that moves.
    const [top, , second] = today as [string, string, string]
    expect(find(menu({ kind: 'tab', id: top }, f.state).items, 'Déplacer vers le haut').enabled).toBe(false)
    const built = menu({ kind: 'tab', id: second }, f.state)
    expect(find(built.items, 'Déplacer vers le haut').enabled).not.toBe(false)
    press(find(built.items, 'Déplacer vers le bas'))
    expect(built.dispatched).toHaveLength(1)
    const after = run(f.state, ...built.dispatched)
    const order = after.tabs.filter((t) => t.spaceId === f.space && !t.pinned && t.favoriteId === undefined).map((t) => t.id)
    expect(order.indexOf(second)).toBe(today.indexOf(second) + 1)
  })

  it('a favourite alone in its profile cannot move: both entries are off', () => {
    const f = fixture()
    const items = menu({ kind: 'favorite', id: f.favorite }, f.state).items
    expect(find(items, 'Déplacer vers le haut').enabled).toBe(false)
    expect(find(items, 'Déplacer vers le bas').enabled).toBe(false)
  })
})

describe('"Déplacer vers la fenêtre" (a tab sent to another window)', () => {
  const f = fixture()
  const windows = [
    { id: 'window-1', label: 'Fenêtre 2', title: 'Courrier' },
    { id: 'window-2', label: 'Travail' }
  ]

  it('lists the other windows by the names the browser gives them, what they show under it, then a new window, in the block Organiser', () => {
    const { items } = menu({ kind: 'tab', id: f.b }, f.state, WITH_HEADERS, false, windows)
    const moveTo = find(blockOf(items, 'Organiser'), 'Déplacer vers la fenêtre')
    const sub = moveTo.submenu as Item[]
    expect(sub.map((entry) => entry.type ?? entry.label)).toEqual(['Fenêtre 2', 'Travail', 'separator', 'Nouvelle fenêtre'])
    expect(sub[0]!.sublabel).toBe('Courrier')
    expect(sub[1]!.sublabel).toBeUndefined()
  })

  it('sends the tab to the window picked, or to a new one; nothing is dispatched by the menu itself', () => {
    const built = menu({ kind: 'tab', id: f.a }, f.state, WITH_HEADERS, false, windows)
    const sub = find(built.items, 'Déplacer vers la fenêtre').submenu as Item[]
    press(find(sub, 'Travail'))
    press(find(sub, 'Nouvelle fenêtre'))
    expect(built.sent).toEqual([
      [f.a, 'window-2'],
      [f.a, 'new']
    ])
    expect(built.dispatched).toEqual([])
  })

  it('offers only a new window when no other window is open, with no divider before it', () => {
    const sub = find(menu({ kind: 'tab', id: f.d }, f.state).items, 'Déplacer vers la fenêtre').submenu as Item[]
    expect(sub.map((entry) => entry.type ?? entry.label)).toEqual(['Nouvelle fenêtre'])
  })

  it('is not in the menu of a tab of a private window: its tabs do not leave it', () => {
    const labels = flat(menu({ kind: 'tab', id: f.a }, f.state, WITH_HEADERS, true, windows).items)
    expect(labels).not.toContain('Déplacer vers la fenêtre')
    expect(labels).not.toContain('  Nouvelle fenêtre')
  })
})

describe('the shortcuts of "Déplacer vers le haut / le bas" in the menu of a tab', () => {
  const f = fixture()

  it('are ⌥⇧⌘↑ and ⌥⇧⌘↓ on the tab on screen, the user’s own when changed, and none on another tab', () => {
    const shown = menu({ kind: 'tab', id: f.a }, f.state).items
    expect(find(shown, 'Déplacer vers le haut').accelerator).toBe('CmdOrCtrl+Alt+Shift+Up')
    expect(find(shown, 'Déplacer vers le bas').accelerator).toBe('CmdOrCtrl+Alt+Shift+Down')
    expect(find(shown, 'Déplacer vers le bas').registerAccelerator).toBe(false)
    expect(find(menu({ kind: 'tab', id: f.b }, f.state).items, 'Déplacer vers le haut').accelerator).toBeUndefined()
    const own = run(f.state, { type: 'settings/update', patch: { keyBindings: { moveTabUp: 'Ctrl+Alt+Up', moveTabDown: '' } } })
    const items = menu({ kind: 'tab', id: f.a }, own).items
    expect(find(items, 'Déplacer vers le haut').accelerator).toBe('Ctrl+Alt+Up')
    expect(find(items, 'Déplacer vers le bas').accelerator).toBeUndefined()
  })
})

describe('« Barre de cette fenêtre », first in the menu of a right click on the sidebar', () => {
  const f = fixture()
  /** The menu of the space as a right click on the sidebar opens it, for a window whose own choice is `own`, with the setting's side `newWindowsRight`. */
  function sidebarMenu(own: Record<string, unknown>, options: { newWindowsRight?: boolean; hidden?: boolean; priv?: boolean; sidebar?: boolean } = {}) {
    const changes: unknown[] = []
    const state = run(f.state, { type: 'settings/update', patch: { sidebarRight: options.newWindowsRight === true, sidebarVisible: options.hidden !== true } })
    const { browser } = fakeBrowser(options.priv === true, [], { windowSidebar: () => own, changeWindowSidebar: (change: unknown) => void changes.push(change) })
    const target = options.sidebar === false ? { kind: 'space' as const, id: f.space } : { kind: 'space' as const, id: f.space, sidebar: true as const }
    const items = menuItems(target, browser, { get: () => state } as never, {} as never, WITH_HEADERS) as Item[]
    return { items, changes }
  }
  const ticks = (items: Item[]) => blockOf(items, 'Barre de cette fenêtre').filter((i) => i.type === 'checkbox').map((i) => [i.label, i.checked])

  it('comes before the blocks of the space, with the dock, the two sides and the side of new windows', () => {
    const { items } = sidebarMenu({})
    expect(titles(items)).toEqual(['Barre de cette fenêtre', 'Personnaliser', 'Thème', 'Organiser', 'Supprimer'])
    expect(flat(blockOf(items, 'Barre de cette fenêtre'))).toEqual(['Replier la barre (icônes seules)', 'À gauche', 'À droite', 'Comme les nouvelles fenêtres'])
  })

  it('is not in the menu of a space opened elsewhere (its icon in the footer, the header): the sidebar was not what was clicked', () => {
    expect(titles(sidebarMenu({}, { sidebar: false }).items)).toEqual(['Personnaliser', 'Thème', 'Organiser', 'Supprimer'])
  })

  it('ticks the side on screen, and « Comme les nouvelles fenêtres » while the window follows the setting', () => {
    expect(ticks(sidebarMenu({}).items)).toEqual([['À gauche', true], ['À droite', false], ['Comme les nouvelles fenêtres', true]])
    expect(ticks(sidebarMenu({}, { newWindowsRight: true }).items)).toEqual([['À gauche', false], ['À droite', true], ['Comme les nouvelles fenêtres', true]])
    expect(ticks(sidebarMenu({ side: 'right' }).items)).toEqual([['À gauche', false], ['À droite', true], ['Comme les nouvelles fenêtres', false]])
    expect(ticks(sidebarMenu({ side: 'left' }, { newWindowsRight: true }).items)).toEqual([['À gauche', true], ['À droite', false], ['Comme les nouvelles fenêtres', false]])
  })

  it('offers to give the full sidebar back from the column, with the keys of ⌃⌘S shown and not registered twice', () => {
    const docked = blockOf(sidebarMenu({ docked: true }).items, 'Barre de cette fenêtre')[0]!
    expect(docked.label).toBe('Déplier la barre')
    expect(docked).toMatchObject({ accelerator: 'Ctrl+CmdOrCtrl+S', registerAccelerator: false })
    // A hidden sidebar shows no column: the entry docks it (and the window shows it).
    expect(blockOf(sidebarMenu({ docked: true }, { hidden: true }).items, 'Barre de cette fenêtre')[0]!.label).toBe('Replier la barre (icônes seules)')
  })

  it('changes this window only, through its browser', () => {
    const { items, changes } = sidebarMenu({})
    const block = blockOf(items, 'Barre de cette fenêtre')
    for (const label of ['Replier la barre (icônes seules)', 'À droite', 'À gauche', 'Comme les nouvelles fenêtres']) press(find(block, label))
    expect(changes).toEqual([{ op: 'dock', docked: true }, { op: 'side', side: 'right' }, { op: 'side', side: 'left' }, { op: 'side', side: null }])
    const undock = sidebarMenu({ docked: true })
    press(find(blockOf(undock.items, 'Barre de cette fenêtre'), 'Déplier la barre'))
    expect(undock.changes).toEqual([{ op: 'dock', docked: false }])
  })

  it('is all a private window offers on its sidebar (it has no space menu), and nothing elsewhere', () => {
    const { items } = sidebarMenu({}, { priv: true })
    expect(titles(items)).toEqual(['Barre de cette fenêtre'])
    expect(sidebarMenu({}, { priv: true, sidebar: false }).items).toEqual([])
  })
})

// The window may refuse to open the tab a favourite asks for (its space is locked, say): the state then holds the same tabs as before, and its
// last tab is one of the user's. The entry then does nothing more: no split view with that tab, and the tile is not traded for it.
describe('a favourite whose tab is not opened', () => {
  const f = fixture()
  const FAV = 'https://fav.example.org/'

  /** The menu of the favourite on a window that runs the actions for real (`refuses`: the ones it drops, as a lock does). */
  function live(start: SidebarState, refuses: (action: Action) => boolean = () => false) {
    let state = start
    const dispatched: Action[] = []
    const { browser } = fakeBrowser(false, [], {
      dispatch: (action: Action) => {
        dispatched.push(action)
        if (!refuses(action)) state = run(state, action)
      }
    })
    const items = menuItems({ kind: 'favorite', id: f.favorite }, browser, { get: () => state } as never, {} as never, WITH_HEADERS) as Item[]
    return { items, dispatched, state: () => state }
  }
  const moveToOther = (items: Item[]): Item => find(find(items, 'Déplacer vers').submenu as Item[], '🎨 Autre')

  it('« Ouvrir en vue scindée » pairs the tab on screen with the tab of the favourite when it opens', () => {
    const m = live(f.state)
    press(find(m.items, t('ctx.ouvrir-en-vue-scindee')))
    const opened = m.state().tabs.at(-1)!
    expect(opened.url).toBe(FAV)
    expect(m.dispatched.at(-1)).toEqual({ type: 'split/create', tabId: f.a, withTabId: opened.id })
  })

  it('« Ouvrir en vue scindée » pairs nothing when the tab is refused: the last tab of the list is not taken in its place', () => {
    const m = live(f.state, (action) => action.type === 'tab/open')
    press(find(m.items, t('ctx.ouvrir-en-vue-scindee')))
    expect(m.state().tabs).toBe(f.state.tabs)
    expect(m.dispatched.map((a) => a.type)).toEqual(['tab/open'])
  })

  it('« Déplacer vers » an other space makes the tile a pinned tab of that space', () => {
    const m = live(f.state)
    press(moveToOther(m.items))
    const made = m.state().tabs.find((tab) => tab.url === FAV)!
    expect(made).toMatchObject({ spaceId: f.other, pinned: true })
    expect(m.state().favorites).toEqual([])
  })

  it('« Déplacer vers » keeps the tile when the tab is refused, even with a tab already at its address last in the list', () => {
    // The tab a look at the last tab of the state would have mistaken for the new one: same address, already there, not pinned.
    const withSame = run(f.state, { type: 'tab/open', url: FAV, background: true })
    const same = withSame.tabs.at(-1)!
    const m = live(withSame, (action) => action.type === 'tab/open')
    press(moveToOther(m.items))
    expect(m.dispatched.map((a) => a.type)).toEqual(['tab/open'])
    expect(m.state().favorites.map((favorite) => favorite.id)).toEqual([f.favorite])
    expect(m.state().tabs.find((tab) => tab.id === same.id)).toMatchObject({ pinned: false })
  })
})

describe('« Fermer l’onglet » and the count of a space that is deleted', () => {
  const f = fixture()

  it('archives a Today tab, so that « Rouvrir le dernier onglet fermé » brings it back; a pinned tab is put back to sleep', () => {
    const today = menu({ kind: 'tab', id: f.a }, f.state)
    press(find(today.items, 'Fermer l’onglet'))
    expect(today.dispatched).toEqual([{ type: 'tab/archive', id: f.a }])
    // The reducer then has the tab in the archive, where « Rouvrir » looks.
    expect(run(f.state, ...today.dispatched).archive.map((entry) => entry.id)).toContain(f.a)

    const pinned = menu({ kind: 'tab', id: f.d }, f.state)
    press(find(pinned.items, 'Fermer l’onglet'))
    expect(pinned.dispatched).toEqual([{ type: 'tab/close', id: f.d }])
  })

  it('archives each Today tab of a selection', () => {
    const selection = menu({ kind: 'tab', id: f.a, selection: [f.a, f.c] }, f.state)
    press(find(selection.items, 'Fermer 2 onglets'))
    expect(selection.dispatched).toEqual([{ type: 'tab/archive', id: f.a }, { type: 'tab/archive', id: f.c }])
  })

  it('counts, before a space is deleted, the tabs the other windows have in it (windows with tabs of their own)', () => {
    const independent = run(f.state, { type: 'settings/update', patch: { independentWindows: true } })
    const inSpace = independent.tabs.filter((tab) => tab.spaceId === f.space).length
    // This window lists every tab of the space but one, which belongs to another window.
    const view = { ...independent, tabs: independent.tabs.filter((tab) => tab.id !== f.a) }
    const shared = { ...independent, tabs: independent.tabs.map((tab) => (tab.id === f.a ? { ...tab, windowKey: 'window-1' } : tab)) }
    const { browser } = fakeBrowser()
    const items = menuItems({ kind: 'space', id: f.space }, browser, { get: () => view, root: () => ({ get: () => shared }) } as never, {} as never, WITH_HEADERS) as Item[]
    boxes.length = 0
    press(find(items, 'Supprimer l’espace…'))
    expect((boxes[0] as { detail: string }).detail).toBe(frenchSpaces(`${inSpace} onglets seront fermés. Cette action est définitive.`))
  })
})

describe('the menu of a locked space', () => {
  afterEach(() => setLockService(null))

  it('greys out « Nouveau dossier », which would land in the locked space, and says why under the pointer', () => {
    const f = fixture()
    const free = find(blockOf(menu({ kind: 'space', id: f.space }, f.state).items, 'Organiser'), 'Nouveau dossier')
    expect(free.enabled).not.toBe(false)
    expect(free.toolTip).toBeUndefined()

    setLockService({ isSpaceLocked: (id: string) => id === f.space, lockedSpaces: () => [f.space], isActive: () => true } as never)
    const locked = menu({ kind: 'space', id: f.space }, f.state)
    expect(find(blockOf(locked.items, 'Organiser'), 'Nouveau dossier')).toMatchObject({ enabled: false, toolTip: t('lock.deverrouillez-l-espace-d-abord') })
    // The entries the lock already greyed out say the same.
    expect(find(blockOf(locked.items, 'Personnaliser'), 'Renommer l’espace…')).toMatchObject({ enabled: false, toolTip: t('lock.deverrouillez-l-espace-d-abord') })
    // The other space is not locked: a folder can still be made in it.
    expect(find(blockOf(menu({ kind: 'space', id: f.other }, f.state).items, 'Organiser'), 'Nouveau dossier').enabled).not.toBe(false)
  })
})

describe('the work views in the menus', () => {
  const saveLabel = 'Enregistrer comme vue de travail…'

  it('the menu of a split view offers to save it as a work view, which opens its sheet', () => {
    const f = fixture()
    const { items, overlays } = menu({ kind: 'split', id: f.b }, f.state)
    const entry = find(blockOf(items, 'Organiser'), saveLabel)
    expect(entry.enabled).not.toBe(false)
    press(entry)
    expect(overlays).toEqual([{ panel: 'workview', splitId: f.state.splits[0]!.id }])
  })

  it('the menu of a tab of a split view offers it too, in the block Ouvrir, where a person looks for it, and opens the same sheet', () => {
    const f = fixture()
    const { items, overlays } = menu({ kind: 'tab', id: f.b }, f.state)
    const entry = find(blockOf(items, 'Ouvrir'), saveLabel)
    expect(entry.enabled).not.toBe(false)
    press(entry)
    expect(overlays).toEqual([{ panel: 'workview', splitId: f.state.splits[0]!.id }])
  })

  it('the menu of a tab that is in no split view does not offer it, and it is greyed out, with the reason, when a page of the split view could not be opened again', () => {
    const f = fixture()
    expect(flat(menu({ kind: 'tab', id: f.a }, f.state).items)).not.toContain(saveLabel)
    const blank = run(f.state, { type: 'tab/update', id: f.c, patch: { url: 'about:blank' } })
    expect(find(menu({ kind: 'tab', id: f.b }, blank).items, saveLabel)).toMatchObject({ enabled: false, toolTip: t('work-view.page-impossible-a-garder'), sublabel: t('work-view.page-impossible-a-garder') })
  })

  it('the menu of a tab has no entry with the function off, nor in a private window', () => {
    const f = fixture()
    const off = run(f.state, { type: 'settings/update', patch: { workViewsEnabled: false } })
    expect(flat(menu({ kind: 'tab', id: f.b }, off).items)).not.toContain(saveLabel)
    expect(flat(menu({ kind: 'tab', id: f.b }, f.state, WITH_HEADERS, true).items)).not.toContain(saveLabel)
  })

  it('greys the entry out, with the reason, for a split view with a page a view could not open again', () => {
    const f = fixture()
    const blank = run(f.state, { type: 'tab/update', id: f.c, patch: { url: 'about:blank' } })
    expect(find(menu({ kind: 'split', id: f.b }, blank).items, saveLabel)).toMatchObject({ enabled: false, toolTip: t('work-view.page-impossible-a-garder'), sublabel: t('work-view.page-impossible-a-garder') })
  })

  it('has no entry with the function off, nor in a private window', () => {
    const f = fixture()
    const off = run(f.state, { type: 'settings/update', patch: { workViewsEnabled: false } })
    expect(flat(menu({ kind: 'split', id: f.b }, off).items)).not.toContain(saveLabel)
    expect(flat(menu({ kind: 'split', id: f.b }, f.state, WITH_HEADERS, true).items)).not.toContain(saveLabel)
  })

  it('the menu of a tile opens, edits, saves what is shown, goes back to the addresses, moves and removes the view, in blocks, the removal last', () => {
    const f = fixture()
    const state = run(f.state, { type: 'view/save', splitId: f.state.splits[0]!.id, name: 'Matin' })
    const view = state.workViews[0]!
    const { items, dispatched, overlays } = menu({ kind: 'workview', id: view.id, anchor: { x: 1, y: 2, width: 70, height: 47 } }, state)
    expect(titles(items)).toEqual(['Ouvrir', 'Personnaliser', 'Organiser', 'Retirer'])
    expect(flat(items)).toEqual(['Ouvrir', 'Ouvrir dans une nouvelle fenêtre', 'Modifier…', 'Enregistrer ce qui est affiché', 'Revenir aux adresses enregistrées', 'Déplacer vers le haut', 'Déplacer vers le bas', 'Retirer la vue de travail'])
    // « Ouvrir » is also the title of the first block: the entry is the one inside it.
    press(find(blockOf(items, 'Ouvrir'), 'Ouvrir'))
    press(find(items, 'Retirer la vue de travail'))
    expect(dispatched).toEqual([{ type: 'view/open', id: view.id, spaceId: state.activeSpaceId }, { type: 'view/remove', id: view.id }])
    press(find(items, 'Modifier…'))
    expect(overlays).toEqual([{ panel: 'workview', viewId: view.id, full: true, anchor: { x: 1, y: 2, width: 70, height: 47 } }])
    // The removal is red; the reordering has nowhere to go with one view.
    expect(find(items, 'Retirer la vue de travail').icon?.png).toBe(MENU_ICON_RED_PNG.trash)
    expect(find(items, 'Déplacer vers le haut').enabled).toBe(false)
  })

  it('greys out what works on the split view of the view while the space shown has none open', () => {
    const f = fixture()
    const saved = run(f.state, { type: 'view/save', splitId: f.state.splits[0]!.id, name: 'Matin' })
    const elsewhere = run(saved, { type: 'space/select', id: f.other })
    const { items } = menu({ kind: 'workview', id: saved.workViews[0]!.id }, elsewhere)
    expect(find(items, 'Enregistrer ce qui est affiché').enabled).toBe(false)
    expect(find(items, 'Revenir aux adresses enregistrées').enabled).toBe(false)
  })

  it('is empty in a private window and with the function off', () => {
    const f = fixture()
    const saved = run(f.state, { type: 'view/save', splitId: f.state.splits[0]!.id, name: 'Matin' })
    const id = saved.workViews[0]!.id
    expect(menu({ kind: 'workview', id }, saved, WITH_HEADERS, true).items).toEqual([])
    expect(menu({ kind: 'workview', id }, run(saved, { type: 'settings/update', patch: { workViewsEnabled: false } })).items).toEqual([])
  })
})
