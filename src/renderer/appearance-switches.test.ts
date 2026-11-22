// Three switches of the appearance that only change what the interface draws, drawn with the real components (no window): « Déplacer la fenêtre depuis la barre
// d'outils » (window-drag: the `draggable` class that the stylesheet turns into a drag region), « Noms des favoris » (favorite-names: the `named` class of the
// row of favorites) and « Jauge de ressources » (resource-gauge: the ring in the footer, which the setting alone puts there).

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { RuntimeState, SidebarState, TabItem } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { elementsOf } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { FooterResources } from './ResourcePanel'
import { Sidebar } from './Sidebar'
import { SidebarUiContext, type SidebarUi } from './SidebarRows'
import { Toolbar } from './Toolbar'

const noop = (): void => undefined

/** What the rows of the sidebar read from the sidebar that holds them. */
const ui = (compact: boolean): SidebarUi => ({ selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop, ...(compact ? { compact: { fullUrl: false, edit: noop, siteInfo: noop } } : {}) })
const underUi = (probe: ReactElement): ReactElement => createElement(SidebarUiContext.Provider, { value: ui(false) }, probe)
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

/** A state with one favorite and one tab on screen, the settings given. */
function stateWith(settings: Partial<SidebarState['settings']>): SidebarState {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://exemple.fr/', spaceId: state.spaces[0]!.id }, ctx)
  state = reduce(state, { type: 'favorite/add', url: 'https://exemple.fr/', title: 'Exemple', spaceId: state.spaces[0]!.id }, ctx)
  return reduce(state, { type: 'settings/update', patch: settings }, ctx)
}

const snapshotOf = (state: SidebarState): UiSnapshot => ({ state, runtime, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false }) as unknown as UiSnapshot

const sidebarElements = (settings: Partial<SidebarState['settings']>) => {
  const state = stateWith(settings)
  return elementsOf(createElement(Sidebar, { snapshot: snapshotOf(state), space: state.spaces[0]! }), undefined, underUi)
}

describe('the window dragged by the toolbar (window-drag)', () => {
  const tab: TabItem = { id: 't', spaceId: 's', url: 'https://exemple.fr/', title: 'Page', pinned: false, createdAt: 1, lastActiveAt: 2 }
  const bar = (draggable: boolean): string => renderToStaticMarkup(createElement(Toolbar, { space: { profileId: 'default' } as never, current: tab, runtime, sidebarVisible: true, fullUrl: false, draggable, canSplit: false }))

  it('marks the toolbar as a drag region only while the setting is on', () => {
    expect(bar(true)).toMatch(/class="page-toolbar [^"]*\bdraggable\b/)
    expect(bar(false)).not.toMatch(/class="page-toolbar [^"]*\bdraggable\b/)
  })
})

describe('the names of the favorites (favorite-names)', () => {
  const rowOfFavorites = (settings: Partial<SidebarState['settings']>) => sidebarElements(settings).find((element) => element.type === 'div' && /\bfavorites\b/.test(String(element.props['className'])))

  it('puts the name under the icons only while the setting is on', () => {
    expect(String(rowOfFavorites({ favoriteNames: true })?.props['className'])).toMatch(/\bnamed\b/)
    expect(String(rowOfFavorites({ favoriteNames: false })?.props['className'])).not.toMatch(/\bnamed\b/)
  })
})

describe('the gauge of resources (resource-gauge)', () => {
  const gaugeOf = (settings: Partial<SidebarState['settings']>) => sidebarElements(settings).find((element) => element.type === FooterResources)

  it('is handed the setting by the footer of the sidebar, on and off', () => {
    expect(gaugeOf({ resourceGauge: true })?.props['enabled']).toBe(true)
    expect(gaugeOf({ resourceGauge: false })?.props['enabled']).toBe(false)
  })

  it('draws no ring while the setting is off, and one with a name for a reader of the screen while it is on', () => {
    const draw = (enabled: boolean): string => renderToStaticMarkup(createElement(FooterResources, { enabled, gauge: undefined, shown: true, forceReduceMotion: false }))
    expect(draw(false)).toBe('')
    expect(draw(true)).toContain('aria-label="Ressources du navigateur"')
  })
})
