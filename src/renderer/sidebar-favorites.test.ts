// The sidebar reads the favourites of a profile, never the whole list: it draws, counts and toggles the favourites of the space it shows. The rules
// are tested in src/shared/favorite-scope.test.ts; here is the real sidebar (no window), its star clicked through the handler it hands the button.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { elementsOf } from './render.test-support'

const holder = vi.hoisted(() => ({ dispatched: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => new Proxy({ dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()) } as Record<string, unknown>, { get: (target, name: string) => target[name] ?? (() => undefined) }),
  useSnapshot: () => null
}))

import { Sidebar } from './Sidebar'
import { SidebarUiContext, type SidebarUi } from './SidebarRows'

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const noop = (): void => undefined
const rowsUi: SidebarUi = { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop }
const underUi = (probe: ReactElement): ReactElement => createElement(SidebarUiContext.Provider, { value: rowsUi }, probe)

/**
 * "Maison" on the default profile, on screen, with the toolbar away (the star sits beside the pill of the address); "Travail" on the profile "work".
 * Mail is a favourite of Maison; Courrier a favourite of Travail, and its address is the page open in Maison.
 */
function twoProfiles(): { state: SidebarState; home: string; mail: string } {
  let state = run(createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
  const home = state.spaces.find((s) => s.profileId === 'default')!.id
  const work = state.spaces.find((s) => s.profileId === 'work')!.id
  state = run(state, { type: 'space/select', id: home }, { type: 'settings/update', patch: { showToolbar: false } })
  state = run(state, { type: 'favorite/add', url: 'https://mail.example/', title: 'Mail', spaceId: home }, { type: 'favorite/add', url: 'https://courrier.example/', title: 'Courrier', spaceId: work })
  state = run(state, { type: 'tab/open', url: 'https://courrier.example/', spaceId: home })
  return { state, home, mail: state.favorites.find((f) => f.title === 'Mail')!.id }
}
const snapshotOf = (state: SidebarState): UiSnapshot =>
  ({ state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false }) as unknown as UiSnapshot
const sidebar = (state: SidebarState) => createElement(Sidebar, { snapshot: snapshotOf(state), space: state.spaces.find((s) => s.id === state.activeSpaceId)! })

/** The star beside the pill: its name, and what a click on it dispatches. */
function star(state: SidebarState): { label: unknown; dispatched: unknown[] } {
  const button = elementsOf(sidebar(state), undefined, underUi).find((element) => element.type === 'button' && (element.props['title'] === t('sidebar.ajouter-aux-favoris') || element.props['title'] === t('sidebar.retirer-des-favoris')))
  expect(button, 'the star is drawn').toBeDefined()
  holder.dispatched.length = 0
  ;(button!.props['onClick'] as () => void)()
  return { label: button!.props['title'], dispatched: [...holder.dispatched] }
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

describe('the favourites in the sidebar', () => {
  it('are those of the profile of the space it shows', () => {
    const { state } = twoProfiles()
    const markup = renderToStaticMarkup(underUi(sidebar(state)))
    expect([...markup.matchAll(/<button[^>]*class="favorite [^"]*"[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual(['Mail'])
    expect(markup).not.toContain('aria-label="Courrier"')
  })

  it('ask the star whether the page is a favourite of the profile of the space on screen, and add it there', () => {
    const { state, home } = twoProfiles()
    // The page is a favourite of the other profile only: here it is not one.
    expect(star(state)).toEqual({ label: t('sidebar.ajouter-aux-favoris'), dispatched: [{ type: 'favorite/add', url: 'https://courrier.example/', title: expect.any(String), faviconUrl: undefined, spaceId: home }] })
  })

  it('take a favourite of the profile away with the star', () => {
    const { state, mail } = twoProfiles()
    const onMail = run(state, { type: 'tab/open', url: 'https://mail.example/', spaceId: state.activeSpaceId })
    expect(star(onMail)).toEqual({ label: t('sidebar.retirer-des-favoris'), dispatched: [{ type: 'favorite/remove', id: mail }] })
  })
})
