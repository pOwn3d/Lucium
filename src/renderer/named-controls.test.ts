// A button whose only content is a typographic character (« ✕ », « ‹ », « ★ ») is read as that character by a screen reader (« signe multiplication »,
// « étoile noire »): its `title` is only a description. Such a button carries its name in `aria-label`. And an edge that is dragged to resize
// something takes the keyboard too, as the dividers of a split view do.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { SIDE_PANEL_WIDTH_MAX, SIDE_PANEL_WIDTH_MIN, type RuntimeState, type SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { elementsOf, type Element } from './render.test-support'

vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => null }))

import { Sidebar } from './Sidebar'
import { SidebarUiContext, type SidebarUi } from './SidebarRows'
import { SidePanelFrame, sidePanelKeyWidth } from './SidePanelFrame'

const noop = (): void => undefined
const runtime: RuntimeState = { tabs: {}, canGoBack: true, canGoForward: true }
const sidebarUi: SidebarUi = { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop }
const underUi = (probe: ReactElement): ReactElement => createElement(SidebarUiContext.Provider, { value: sidebarUi }, probe)

/** The text a button shows, its elements hidden from the screen reader left out: what is read when the button has no `aria-label`. */
function readText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(readText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as Element).props
    return props['aria-hidden'] === true || props['aria-hidden'] === 'true' ? '' : readText(props['children'])
  }
  return ''
}
/** A button with no `aria-label` whose text holds no letter and no digit: a glyph, or nothing at all, names nothing. */
const namedByGlyph = (elements: Element[]): string[] =>
  elements.filter((element) => element.type === 'button' && !element.props['aria-label'] && !/[\p{L}\p{N}]/u.test(readText(element.props['children']))).map((element) => `« ${readText(element.props['children'])} » (${String(element.props['title'] ?? element.props['className'])})`)

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

describe('the sidebar when the toolbar is away', () => {
  function sidebar(favorite: boolean): Element[] {
    const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
    let state: SidebarState = createInitialState(ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://exemple.fr/', spaceId: state.spaces[0]!.id }, ctx)
    if (favorite) state = reduce(state, { type: 'favorite/add', url: 'https://exemple.fr/', title: 'Exemple', spaceId: state.spaces[0]!.id }, ctx)
    state = reduce(state, { type: 'settings/update', patch: { showToolbar: false } }, ctx)
    const snapshot = { state, runtime, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false } as unknown as UiSnapshot
    return elementsOf(createElement(Sidebar, { snapshot, space: state.spaces[0]! }), undefined, underUi)
  }
  const labelled = (elements: Element[], label: string): Element[] => elements.filter((element) => element.type === 'button' && element.props['aria-label'] === label)

  it('names Back, Forward, Reload, the site button and the favourite star in words', () => {
    const elements = sidebar(false)
    for (const key of ['sidebar.precedent', 'sidebar.suivant', 'sidebar.recharger', 'toolbar.infos-et-reglages-du-site', 'sidebar.ajouter-aux-favoris'] as const) expect(labelled(elements, t(key)), key).toHaveLength(1)
    expect(labelled(sidebar(true), t('sidebar.retirer-des-favoris'))).toHaveLength(1)
  })

  it('has no button named by a character alone', () => {
    expect(namedByGlyph(sidebar(false))).toEqual([])
    expect(namedByGlyph(sidebar(true))).toEqual([])
  })
})

describe('the panel docked beside the page', () => {
  const frame = (props: Partial<Parameters<typeof SidePanelFrame>[0]> = {}) => createElement(SidePanelFrame, { name: 'Notes', width: 400, margin: 8, panelAtLeft: false, onClose: noop, onWidth: noop, ...props })

  it('names its closing button « Fermer le panneau », not « ✕ »', () => {
    const elements = elementsOf(frame())
    expect(namedByGlyph(elements)).toEqual([])
    expect(renderToStaticMarkup(frame())).toContain(`aria-label="${t('app.fermer-le-panneau')}"`)
  })

  it('has an edge the keyboard reaches, read as a splitter with the width of the panel', () => {
    const markup = renderToStaticMarkup(frame())
    const edge = /<div class="side-panel-resize"[^>]*>/.exec(markup)?.[0] ?? ''
    expect(edge).toContain('role="separator"')
    expect(edge).toContain('tabindex="0"')
    expect(edge).toContain('aria-orientation="vertical"')
    expect(edge).toContain(`aria-label="${t('app.redimensionner-le-panneau')}"`)
    expect(edge).toContain('aria-valuenow="400"')
    expect(edge).toContain(`aria-valuemin="${SIDE_PANEL_WIDTH_MIN}"`)
    expect(edge).toContain(`aria-valuemax="${SIDE_PANEL_WIDTH_MAX}"`)
    expect(edge).toContain(`aria-valuetext="${t('app.largeur-du-panneau', { width: 400 })}"`)
  })

  it('moves its edge with the arrows: the key is taken and the new width sent; another key, or an arrow with ⌘, is left alone', () => {
    const sent: number[] = []
    const edge = elementsOf(frame({ onWidth: (width) => void sent.push(width) })).find((element) => element.props['role'] === 'separator')!
    const press = (key: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}): boolean => {
      let taken = false
      ;(edge.props['onKeyDown'] as (event: unknown) => void)({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers, preventDefault: () => void (taken = true) })
      return taken
    }
    expect(press('ArrowLeft')).toBe(true)
    expect(press('ArrowRight', { shiftKey: true })).toBe(true)
    expect(press('a')).toBe(false)
    expect(press('ArrowLeft', { metaKey: true })).toBe(false)
    expect(sent).toEqual([416, 336])
  })

  it('widens with the arrow that points away from the panel, and stops at the narrowest and the widest', () => {
    // The panel at the right of the page: its edge is its left side.
    expect(sidePanelKeyWidth(400, 'ArrowLeft', false)).toBe(416)
    expect(sidePanelKeyWidth(400, 'ArrowRight', false)).toBe(384)
    // Mirrored (the sidebar at the right, the panel at the left): its edge is its right side.
    expect(sidePanelKeyWidth(400, 'ArrowRight', true)).toBe(416)
    expect(sidePanelKeyWidth(400, 'ArrowLeft', true)).toBe(384)
    expect(sidePanelKeyWidth(400, 'ArrowLeft', false, true)).toBe(464)
    expect(sidePanelKeyWidth(SIDE_PANEL_WIDTH_MAX - 4, 'ArrowLeft', false)).toBe(SIDE_PANEL_WIDTH_MAX)
    expect(sidePanelKeyWidth(SIDE_PANEL_WIDTH_MIN + 4, 'ArrowRight', false)).toBe(SIDE_PANEL_WIDTH_MIN)
    expect(sidePanelKeyWidth(400, 'Home', false)).toBe(SIDE_PANEL_WIDTH_MIN)
    expect(sidePanelKeyWidth(400, 'End', false)).toBe(SIDE_PANEL_WIDTH_MAX)
    expect(sidePanelKeyWidth(400, 'Enter', false)).toBeNull()
  })
})
