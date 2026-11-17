// A text that names the key of a command takes it from the shortcuts in force: the tooltips of the sidebar, of the mini window and of the site
// panel, the hint of the empty window and of a setting carried the default key written out, which stayed after a change in Réglages ›
// Raccourcis. The sidebar is drawn for real; the catalogues are read so that no new text writes a changeable key again.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'
import type { SidebarState } from '@shared/model'
import { labelWithShortcut, shortcutSuffix } from '@shared/keybindings'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { UiSnapshot } from '@shared/ipc'
import little from './littlearc.tsx?raw'
import sitePanel from './SitePanel.tsx?raw'
import features from './FeaturesPage.tsx?raw'
import app from './App.tsx?raw'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({ spaceBackgroundMedia: async () => ({ ok: false }) }), useSnapshot: () => holder.snapshot }))

import { Sidebar } from './Sidebar'

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

/** The sidebar of a window with one page on screen and no toolbar (the sidebar then carries the button of the site). */
function sidebar(keyBindings: Record<string, string>, extra: Partial<UiSnapshot> = {}): string {
  const opened = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' })
  const state = run(opened, { type: 'settings/update', patch: { keyBindings, showToolbar: false, downloadStatusChip: false } })
  const snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', ...extra } as unknown as UiSnapshot
  return renderToStaticMarkup(createElement(Sidebar, { snapshot, space: state.spaces.find((sp) => sp.id === state.activeSpaceId)! }))
}

describe('the tooltips of the sidebar', () => {
  it('say the default shortcut of their command', () => {
    const markup = sidebar({})
    expect(markup).toContain('title="Masquer la barre latérale · ⌘S"')
    expect(markup).toContain('title="Infos et réglages du site · ⇧⌘I"')
    expect(markup).toContain('title="Vider les onglets du jour · ⇧⌘K"')
    expect(markup).toContain('data-tip="Téléchargements · ⇧⌘J"')
    expect(sidebar({}, { private: true })).toContain('data-tip="Nouvel onglet · ⌘T"')
  })

  it('follow a shortcut changed in the Settings', () => {
    const markup = sidebar({ toggleSidebar: 'CmdOrCtrl+Shift+L', siteInfo: 'CmdOrCtrl+Alt+Y', clearToday: 'CmdOrCtrl+Alt+K', downloads: 'CmdOrCtrl+Alt+L' })
    expect(markup).toContain('title="Masquer la barre latérale · ⇧⌘L"')
    expect(markup).toContain('title="Infos et réglages du site · ⌥⌘Y"')
    expect(markup).toContain('title="Vider les onglets du jour · ⌥⌘K"')
    expect(markup).toContain('data-tip="Téléchargements · ⌥⌘L"')
    expect(sidebar({ newTab: 'CmdOrCtrl+Alt+T' }, { private: true })).toContain('data-tip="Nouvel onglet · ⌥⌘T"')
  })

  it('say the name alone for a command left without a shortcut', () => {
    const markup = sidebar({ toggleSidebar: '', siteInfo: '', clearToday: '', downloads: '' })
    expect(markup).toContain('title="Masquer la barre latérale"')
    expect(markup).toContain('title="Infos et réglages du site"')
    expect(markup).toContain('title="Vider les onglets du jour"')
    expect(markup).toContain('data-tip="Téléchargements"')
    expect(sidebar({ newTab: '' }, { private: true })).toContain('data-tip="Nouvel onglet"')
  })
})

describe('a name followed by the shortcut of its command', () => {
  it('carries the shortcut in force, between brackets, and nothing for a command without one', () => {
    expect(labelWithShortcut('Recharger', 'reload', {}, 'darwin')).toBe('Recharger (⌘R)')
    expect(labelWithShortcut('Recharger', 'reload', { reload: 'F5' }, 'darwin')).toBe('Recharger (F5)')
    expect(labelWithShortcut('Recharger', 'reload', { reload: '' }, 'darwin')).toBe('Recharger')
    expect(shortcutSuffix('developerMode', {}, 'darwin')).toBe(' (⌃D)')
    expect(shortcutSuffix('developerMode', { developerMode: '' }, 'darwin')).toBe('')
    expect(shortcutSuffix('reload', {}, 'win32')).toBe(' (Ctrl+R)')
  })

  it('fills the texts that name a key, which read well with and without it', () => {
    expect(t('site-panel.mode-developpeur-pour-ce-site-d', { shortcut: shortcutSuffix('developerMode', { developerMode: 'Ctrl+Alt+D' }, 'darwin') })).toMatch(/^Mode développeur pour ce site \(⌃⌥D\) : /)
    expect(t('site-panel.mode-developpeur-pour-ce-site-d', { shortcut: '' })).toMatch(/^Mode développeur pour ce site : /)
    expect(t('notes.bouton-toutes-les-notes-hint', { shortcut: shortcutSuffix('notes', {}, 'darwin') })).toContain('Fichier › Notes (⇧⌘E) l’ouvre sur celles de la page')
    expect(t('notes.bouton-toutes-les-notes-hint', { shortcut: '' })).toContain('Fichier › Notes l’ouvre sur celles de la page')
    expect(t('app.t-pour-ouvrir-un-onglet', { keys: '⌥⌘T' })).toBe('⌥⌘T pour ouvrir un onglet')
  })

  it('is what the mini window, the site panel, the setting of the notes and the empty window hand their texts', () => {
    for (const [label, command] of [['toolbar.precedent', 'back'], ['toolbar.suivant', 'forward'], ['sidebar.recharger', 'reload'], ['panels.copier-l-adresse', 'copyUrl']]) {
      expect(little, command).toContain(`withKey(t('${label}'), '${command}')`)
    }
    expect(little).toContain('labelWithShortcut(label, command, snapshot?.state.settings.keyBindings')
    expect(sitePanel).toContain("t('site-panel.mode-developpeur-pour-ce-site-d', { shortcut: shortcutSuffix('developerMode', state.settings.keyBindings")
    expect(features).toContain("t('notes.bouton-toutes-les-notes-hint', { shortcut: shortcutSuffix('notes', settings.keyBindings")
    expect(app).toContain("{newTabKeys && <p>{t('app.t-pour-ouvrir-un-onglet', { keys: formatAccelerator(newTabKeys, platform) })}</p>}")
  })
})

describe('the texts of the interface', () => {
  /**
   * The texts that write a key out, and why each may: a key no setting changes, or a sentence of explanation that names the default key of a
   * function (a page of the Settings, the list of the functions). A tooltip or a label of a command that can be changed is never one of them.
   */
  const WRITTEN_KEYS = new Set([
    // Keys that are not commands of the table: the editors of the annotation and of the notes, the find panel, the fixed entries of the menus.
    'annotate-sheet.annuler-la-derniere-annotation-z', 'annotate-sheet.retablir-z', 'find-replace.remplacer-toutes-les-occurrences', 'panels.occurrence-precedente',
    'annotate-sheet.au-clavier', 'panels.faites-glisser-pour-choisir-la-zone-a-capturer', 'boost-editor.tab-indente-sortie',
    'notes.gras', 'notes.italique', 'notes.liste-de-taches', 'notes.lien', 'notes.cmd-clic-pour-ouvrir-url', 'notes.cmd-clic-pour-ecrire-a', 'notes.le-markdown-se-met-en-forme',
    'space-manage.descendre-aide', 'space-manage.monter-aide', 'space-manage.glissez-une-ligne', 'floating-video.fermer-w', 'settings.rechercher-un-reglage-f-ou',
    'toolbar.contraste-de-la-page-description', 'window-share.raccourcis', 'page-annotate.note-raccourci', 'page-annotate.note-raccourci-partage', 'page-annotate.aide-maintien', 'window-share.raccourci-passage', 'window-share.raccourci-pris', 'window-share.raccourci-pris-annotation',
    'settings.annoter-depuis-toute-application', 'settings.annoter-depuis-toute-application-aide', 'settings.touches-d-une-lettre-pour-annoter-aide', 'littlearc.ouvrir-dans-la-fenetre-principale-o', 'littlearc.ouvrir-dans-name-o', 'littlearc.ouvrir-dans-un-onglet-o',
    'guide.quitter', 'guide.quitter-sujet', 'features.demande-une-confirmation-avant-q',
    // A click held with a modifier, not a shortcut.
    'features.un-clic-sur-un-lien-avec-enfoncees-ouvre-une', 'arc-guide.coup-d-oeil-texte', 'features.coup-d-oeil-avec-maj-clic-sur-un-lien', 'settings-illustrations.peek', 'settings.coup-d-oeil-avec-maj-clic-sur-un-lien', 'little-arc-settings.le-delai-avant-l-archivage-d-une-fenetre', 'little-arc-settings.maintenez-et-en-cliquant-sur-un-lien', 'little-arc-settings.ouvrir-un-lien-dans-une-mini-fenetre-avec-clic',
    'settings.ouvrir-en-arriere-plan-les-liens-ouverts', 'little-arc-settings.liens-nouvel-onglet-en-mini-fenetre-aide', 'features.liens-nouvel-onglet-en-mini-fenetre', 'key-ext-settings.keys-les-touches-sont-laissees-a-la-page',
    // Sentences of the Settings and of the list of the functions that explain a function by its default key.
    'features.la-barre-de-commandes-en-mode-onglets-sur-tous-les', 'features.les-liens-copies-c-menus-perdent-utm-fbclid-et', 'features.panneau-de-vignettes-tenu-tant-que-est-enfonce', 'features.tab-dans-l-ordre-d-utilisation-recente',
    'features.une-feuille-qui-liste-les-raccourcis-par-contexte', 'search-settings.info-regex', 'settings-illustrations.tab-cycle', 'settings.agrandit-la-barre-laterale-la-barre-d', 'settings.garde-avec-l-archive-jusqu-a-20-adresses',
    'settings.sur-la-premiere-page-d-un-onglet-ouvert', 'settings-shortcuts.ctrl-tab-ordre-recent', 'settings-shortcuts.ctrl-tab-ordre-recent-aide', 'settings-shortcuts.raccourcis-du-systeme-repris',
    'site-privacy-settings.desactive-par-defaut-quand-le-dernier', 'spaces-settings.la-fenetre-est-inversee-barre-laterale',
    // The one line of help of a row whose whole text above names the same key: a fixed key (⌥⌘M from any application, ⌥⌘-click), a modifier held
    // (the Vim keys), or the key the setting is about (⌃Tab, against ⌘Tab of macOS).
    'settings.m-annote-la-page-meme-depuis-une-autre', 'little-arc-settings.clic-sur-un-lien-l-ouvre-dans-une-mini', 'key-ext-settings.les-touches-restent-a-la-page-dans-un-champ', 'settings-shortcuts.tab-revient-a-l-onglet-utilise-juste-avant'
  ])
  const symbols = /[⌘⌥⌃⇧]/

  it('write a key out only where the list says why', () => {
    for (const catalogue of [fr, en]) {
      const written = Object.entries(catalogue).filter(([, text]) => symbols.test(String(text))).map(([key]) => key)
      expect(written.filter((key) => !WRITTEN_KEYS.has(key))).toEqual([])
    }
  })

  it('keep no entry of that list that writes no key any more', () => {
    const written = new Set(Object.entries(fr).filter(([, text]) => symbols.test(String(text))).map(([key]) => key))
    expect([...WRITTEN_KEYS].filter((key) => !written.has(key))).toEqual([])
  })
})
