import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { lockedView } from './lock-state'
import { t } from '@shared/i18n'

// The menu is the real one, with Electron's `Menu` replaced by a function that hands the template back (menu.ts only describes entries).
vi.mock('electron', () => {
  // Anything the menu's imports ask of Electron at load time is an inert function (never a thenable: the module is awaited).
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

// The menu bar of macOS on every runner: these checks read its roles and its shortcuts (the ones the application is published with). Another system has its
// own (shared/platform.ts, NON_MAC_DEFAULTS; platform/menu.test.ts adapts the template), which the tests of the platform layer play on their own.
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu } from './menu'

interface Item {
  label?: string
  type?: string
  enabled?: boolean
  visible?: boolean
  accelerator?: string
  registerAccelerator?: boolean
  toolTip?: string
  submenu?: Item[]
}

function leaves(items: Item[], path: string[] = []): Array<Item & { path: string }> {
  return items.flatMap((item) => {
    const here = [...path, item.label ?? '']
    return item.submenu ? leaves(item.submenu, here) : [{ ...item, path: here.join(' › ') }]
  })
}

/** A browser that is never asked anything of consequence: the menu only describes what a click will do. */
const browser = new Proxy({ menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, {
  get: (target, prop: string) => (prop in target ? target[prop] : () => false)
})

const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, {
  get: (target, prop: string) => (prop in target ? target[prop] : () => {})
})

function menuOf(state: SidebarState): Array<Item & { path: string }> {
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  return leaves(buildMenu(browser as never, store, actions as never) as unknown as Item[])
}

function withTab(): SidebarState {
  const base = createInitialState({ now: 1, newId: () => 'home' })
  const space = base.spaces[0]!
  return {
    ...base,
    tabs: [{ id: 't1', spaceId: space.id, url: 'https://example.com/', title: 'Example', pinned: false, createdAt: 1, lastActiveAt: 1 }],
    activeTabBySpace: { [space.id]: 't1' }
  }
}
const withoutTab = (): SidebarState => createInitialState({ now: 1, newId: () => 'home' })

/** The entries that act on the tab on screen: nothing to act on, nothing to click (they are greyed out, and their shortcuts do nothing). */
const TAB_ENTRIES = [
  'Fichier › Archiver l’onglet',
  'Fichier › Capturer…',
  'Fichier › Capturer la page entière',
  'Fichier › Capturer la partie visible',
  'Fichier › Capturer en mode portrait',
  'Fichier › Enregistrer la page sous…',
  'Fichier › Imprimer…',
  'Édition › Copier l’adresse',
  'Édition › Copier l’adresse en Markdown',
  'Édition › Copier l’adresse en citation',
  'Édition › Rechercher › Rechercher…',
  'Édition › Rechercher › Trouver et remplacer',
  'Édition › Rechercher › Utiliser la sélection pour rechercher',
  'Édition › Rechercher › Aller à la sélection',
  'Affichage › Actualiser la page',
  'Affichage › Actualisation forcée',
  'Affichage › Effacer les cookies et actualiser',
  'Affichage › Effacer le cache et actualiser',
  'Affichage › Taille réelle',
  'Affichage › Zoom avant',
  'Affichage › Zoom arrière',
  'Affichage › Développeur › Outils de développement',
  'Affichage › Développeur › Inspecter les éléments',
  'Affichage › Développeur › Console JavaScript',
  'Affichage › Développeur › Inspecteur réseau',
  'Affichage › Infos et réglages du site',
  'Affichage › Retoucher ce site…',
  'Onglets › Épingler l’onglet',
  'Onglets › Révéler l’onglet dans la barre latérale',
  'Archive › Effacer les données du site…',
  'Archive › Effacer les données du site maintenant'
]

describe('the menu bar greys out what has nothing to act on', () => {
  const entry = (menu: ReturnType<typeof menuOf>, path: string) => menu.find((item) => item.path === path)

  it.each(TAB_ENTRIES)('%s: greyed out without a tab on screen, available with one', (path) => {
    expect(entry(menuOf(withoutTab()), path), `${path} is missing`).toBeDefined()
    expect(entry(menuOf(withoutTab()), path)?.enabled, `${path} without a tab`).toBe(false)
    expect(entry(menuOf(withTab()), path)?.enabled, `${path} with a tab`).not.toBe(false)
  })

  it('keeps what does not depend on a tab available without one', () => {
    const menu = menuOf(withoutTab())
    for (const path of ['Fichier › Nouvel onglet…', 'Fichier › Nouvelle fenêtre', 'Fichier › Ouvrir la barre de commandes', 'Lucium › Réglages…', 'Archive › Afficher l’historique', 'Espaces › Nouvel espace…']) {
      expect(entry(menu, path)?.enabled, path).not.toBe(false)
    }
  })

  it('has the same entries greyed out for a locked space on screen as for an empty one: its tab is not in the menu’s reach', () => {
    const state = withTab()
    const locked = menuOf(lockedView({ get: () => state }, () => ({ appLocked: false, lockedSpaces: [state.activeSpaceId] })).get())
    for (const path of TAB_ENTRIES) expect(entry(locked, path)?.enabled, path).toBe(false)
  })

  it('greys out « Nouveau dossier » and « Nouveau dossier en direct » while the space on screen is locked, and says why under the pointer', () => {
    const state = { ...withTab(), settings: { ...withTab().settings, liveFolders: true } }
    const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
    const built = (lockedSpaces: string[]) => leaves(buildMenu(browser as never, store, actions as never, { lockedSpaces }) as unknown as Item[])
    const paths = ['Onglets › Nouveau dossier…', 'Onglets › Nouveau dossier en direct…']
    for (const path of paths) {
      expect(entry(built([]), path), path).toMatchObject({ enabled: true })
      expect(entry(built([]), path)?.toolTip, path).toBeUndefined()
      // Another space locked: the folder lands in the one on screen, which is free.
      expect(entry(built(['elsewhere']), path), path).toMatchObject({ enabled: true })
      expect(entry(built([state.activeSpaceId]), path), path).toMatchObject({ enabled: false, toolTip: t('lock.deverrouillez-l-espace-d-abord') })
    }
  })

  it('keeps the reload commands of View together: « Notifications récentes » is beside the things the window shows, not among them', () => {
    const view = menuOf(withTab()).filter((item) => item.path.startsWith('Affichage › ') && item.path.split(' › ').length === 2).map((item) => item.label)
    const at = (label: string): number => view.indexOf(label)
    expect(at('Notifications récentes')).toBeGreaterThan(-1)
    expect(view.slice(at('Arrêter le chargement'), at('Effacer le cache et actualiser') + 1)).toEqual([
      'Arrêter le chargement', 'Actualiser la page', 'Actualiser tous les onglets', 'Actualisation forcée', 'Effacer les cookies et actualiser', 'Effacer le cache et actualiser'
    ])
    expect(at('Notifications récentes')).toBeLessThan(at('Arrêter le chargement'))
  })

  // Two entries that did not do what they said: « Effacer les données du domaine » of the Extensions menu cleared the site of the page, which
  // Archive already offers under its own name, and « Afficher sur un autre écran… » could only say that Electron has no Cast router.
  it('offers the clearing of a site in Archive only, and nothing in View that would send the page to another screen', () => {
    const menu = menuOf(withTab())
    expect(menu.filter((item) => item.visible !== false && /^Effacer les données/.test(item.label ?? '')).map((item) => item.path)).toEqual(['Archive › Effacer les données du site…', 'Archive › Effacer les données du site maintenant'])
    expect(menu.filter((item) => item.path.startsWith('Extensions › ') && /données|domaine/i.test(item.label ?? '')).map((item) => item.path)).toEqual([])
    expect(menu.filter((item) => /autre écran|caster/i.test(item.label ?? '')).map((item) => item.path)).toEqual([])
    // No separator is left doubled, or at an end, where an entry went.
    for (const top of ['Affichage', 'Extensions']) {
      // The direct children of the menu, in order: a separator, or the name of an entry (a submenu is listed by its leaves, which share its name).
      const children = menu.filter((item) => item.path.startsWith(`${top} › `)).map((item) => (item.type === 'separator' && item.path.split(' › ').length === 2 ? '|' : item.path.split(' › ')[1]!))
      const row = children.filter((child, index) => index === 0 || child !== children[index - 1] || child === '|')
      expect(row.length, top).toBeGreaterThan(2)
      expect(row.some((child, index) => child === '|' && (index === 0 || index === row.length - 1 || row[index - 1] === '|')), `${top}: ${row.join(' ')}`).toBe(false)
    }
  })

  // The second key of a command is a copy of its entry that the menu bar does not show (hidden entries answer their key on macOS).
  it('gives the commands that have a second shortcut a hidden copy of their entry, greyed out with it, that holds that key', () => {
    const copies = (state: SidebarState) => menuOf(state).filter((item) => item.visible === false && typeof item.accelerator === 'string' && item.accelerator.startsWith('Ctrl+CmdOrCtrl+'))
    const menu = menuOf(withTab())
    expect(copies(withTab()).map((item) => `${item.path} ${item.accelerator}`)).toEqual([
      `Espaces › ${menu.find((item) => item.accelerator === 'Ctrl+1')!.label} Ctrl+CmdOrCtrl+1`,
      'Archive › Page précédente Ctrl+CmdOrCtrl+Left',
      'Archive › Page suivante Ctrl+CmdOrCtrl+Right',
      'Archive › Effacer les données du site… Ctrl+CmdOrCtrl+X'
    ])
    for (const copy of copies(withTab())) {
      const shown = menu.find((item) => item.path === copy.path && item.visible !== false)!
      expect(shown.accelerator, copy.path).not.toBe(copy.accelerator)
      expect(copy.enabled, copy.path).toBe(shown.enabled)
    }
    // Without a tab the entry that clears the site is greyed out, and so is its copy: the second key does nothing more than the first.
    expect(copies(withoutTab()).find((item) => item.accelerator === 'Ctrl+CmdOrCtrl+X')?.enabled).toBe(false)
    expect(menu.filter((item) => item.accelerator === 'CmdOrCtrl+Alt+K').map((item) => [item.path, item.visible])).toEqual([['Aide › Aide des raccourcis', false]])
  })

  it('leaves the second key to the command the user gave it to, and takes it away with a command that is switched off', () => {
    const bound = (keyBindings: Record<string, string>): SidebarState => ({ ...withTab(), settings: { ...withTab().settings, keyBindings } })
    const holders = (state: SidebarState, accelerator: string) => menuOf(state).filter((item) => item.accelerator === accelerator).map((item) => item.path)
    expect(holders(bound({ history: 'Ctrl+CmdOrCtrl+Left' }), 'Ctrl+CmdOrCtrl+Left')).toEqual(['Archive › Afficher l’historique'])
    expect(holders(bound({ back: '' }), 'Ctrl+CmdOrCtrl+Left')).toEqual([])
    expect(holders(bound({ back: '' }), 'Ctrl+CmdOrCtrl+Right')).toEqual(['Archive › Page suivante'])
  })

  it('gives no two entries the same shortcut (one of them would never run)', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const item of menuOf(withTab())) {
      // A hidden entry is counted too: it answers its key on macOS (the second key of a command, F12 for the tools).
      if (!item.accelerator || item.registerAccelerator === false) continue
      const key = item.accelerator.split('+').map((part) => part.toLowerCase().replace('commandorcontrol', 'cmdorctrl').replace('command', 'cmdorctrl')).sort().join('+')
      const other = seen.get(key)
      if (other) clashes.push(`${item.accelerator}: ${other} / ${item.path}`)
      else seen.set(key, item.path)
    }
    expect(clashes).toEqual([])
  })
})
