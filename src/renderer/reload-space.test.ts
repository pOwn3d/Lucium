// Reloading one space only, with buttons whose difference is easy to tell. The buttons are the real
// sidebar's (drawn with no window, their handlers read from the elements it returns); the reload is the real method of the shell, on a stand-in for the window
// (browser.ts reaches Electron only when a method runs). The pure parts are measured in shared/reload-all.test.ts.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState, reduce } from '@shared/sidebar'
import { reloadAllNotice, reloadProgressNotice, scopedReloadNotice } from '@shared/reload-all'

/** What the sidebar asked of the bridge, and with what. */
const holder = vi.hoisted(() => ({ asked: [] as string[], args: [] as unknown[][] }))
vi.mock('./api', () => ({
  api: () =>
    new Proxy(
      {},
      {
        get: (_target, name: string) => (...args: unknown[]) => {
          holder.asked.push(name)
          holder.args.push(args)
        }
      }
    ),
  useSnapshot: () => null
}))
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

import { Sidebar } from './Sidebar'
import { frenchSpaces } from '@shared/french-typography'

const { Browser } = await import('../main/shell/browser')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** Every element a tree draws, the function components called and what they return walked too. */
function expanded(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(expanded)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  const type = element.type as unknown
  // A memo component is its function under `type`.
  const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
  if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return [element, ...expanded((component as (props: unknown) => ReactNode)(element.props))]
  }
  return [element, ...expanded(element.props['children'] as ReactNode)]
}

describe('from the sidebar', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
    vi.stubGlobal('location', { hash: '' })
    setLanguage('fr')
    holder.asked.length = 0
    holder.args.length = 0
  })
  afterEach(() => vi.unstubAllGlobals())

  /** Every element the sidebar draws, with the setting that shows the buttons on or off, and what the snapshot says beside the state. */
  function drawn(shown: boolean, extra: (spaceId: string) => Record<string, unknown> = () => ({})): ReactElement<Record<string, unknown>>[] {
    const state = createInitialState({ now: 1, newId: () => 'id' })
    const snapshot = { state: { ...state, settings: { ...state.settings, showReloadAllButton: shown } }, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false, ...extra(state.spaces[0]!.id) } as unknown as UiSnapshot
    let found: ReactElement<Record<string, unknown>>[] = []
    const Probe = (): null => {
      found = expanded(createElement(Sidebar, { snapshot, space: snapshot.state.spaces[0]! }))
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return found
  }

  /** The buttons of the reloads in the bar of the sidebar. */
  function reloadButtons(shown: boolean, extra?: (spaceId: string) => Record<string, unknown>): ReactElement<Record<string, unknown>>[] {
    return drawn(shown, extra).filter((element) => element.type === 'button' && String(element.props['className']).includes('sidebar-reload-all'))
  }

  it('is asked by its own button, beside the one that reloads every space, and both wake the sleeping tabs too', () => {
    const [all, space] = reloadButtons(true)
    expect(all?.props['className']).toBe('icon sidebar-reload-all')
    expect(space?.props['className']).toBe('icon sidebar-reload-all sidebar-reload-space')
    ;(space!.props['onClick'] as () => void)()
    ;(all!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual(['reloadSpaceTabs', 'reloadAllTabs'])
    // The button of every space says it is the button (ipc.ts then wakes the sleeping tabs whatever the setting); the channel of the space button always does.
    expect(holder.args).toEqual([[], [true]])
  })

  it('turns while its run goes on, fills its bar and says how far it is and that a click offers to stop it; the other one stays as it is', () => {
    const [all, space] = reloadButtons(true, () => ({ reloadRun: { done: 27, total: 135, phase: 'sleeping' } }))
    expect(all?.props['className']).toBe('icon sidebar-reload-all busy')
    expect(all?.props['aria-label']).toBe(frenchSpaces('Actualisation en cours : 27 sur 135. Un clic propose de l’arrêter.'))
    expect(all?.props['title']).toBe(all?.props['aria-label'])
    expect(all?.props['style']).toEqual({ '--reload-progress': 0.2 })
    expect(space?.props['className']).toBe('icon sidebar-reload-all sidebar-reload-space')
    expect(space?.props['aria-label']).toBe('Actualiser les onglets de cet espace seulement')
    // A click while it turns asks the shell again, which brings back the notice with « Arrêter » (reload-all-run.test.ts).
    ;(all!.props['onClick'] as () => void)()
    expect(holder.asked).toEqual(['reloadAllTabs'])
  })

  it('turns as the button of the space when the run is the one of the space on screen, and says when the run is stopping', () => {
    const [all, space] = reloadButtons(true, (spaceId) => ({ reloadRun: { done: 3, total: 4, phase: 'awake', spaceId, stopping: true } }))
    expect(all?.props['className']).toBe('icon sidebar-reload-all')
    expect(space?.props['className']).toBe('icon sidebar-reload-all sidebar-reload-space busy')
    expect(space?.props['aria-label']).toBe('Arrêt de l’actualisation…')
  })

  it('shows in its notice the line of the phase and a bar in place of the time line', () => {
    const toast = { id: 1, message: 'Actualisation des onglets : 27 sur 135…', detail: frenchSpaces('Onglets en veille : réveil et rechargement'), progress: { done: 27, total: 135 }, durationMs: 600_000, action: 'Arrêter' }
    const elements = drawn(true, () => ({ toast }))
    const byClass = (list: ReactElement<Record<string, unknown>>[], name: string) => list.filter((element) => element.props['className'] === name)
    expect(byClass(elements, 'toast-detail')[0]?.props['children']).toBe(frenchSpaces('Onglets en veille : réveil et rechargement'))
    expect(byClass(elements, 'toast-progress')[0]?.props).toMatchObject({ 'aria-hidden': 'true', style: { '--toast-progress': 0.2 } })
    expect(byClass(elements, 'toast-timer')).toEqual([])
    // A notice with no job keeps its time line.
    const plain = drawn(true, () => ({ toast: { id: 2, message: 'Onglet archivé', durationMs: 5000 } }))
    expect(byClass(plain, 'toast-timer')).toHaveLength(1)
    expect(byClass(plain, 'toast-progress')).toEqual([])
  })

  it('has no button while the setting is off', () => {
    expect(reloadButtons(false)).toEqual([])
  })
})

describe('in the shell', () => {
  /** A window with tabs in two spaces, every page in memory and none being edited; Travail is on screen. */
  function shell() {
    let n = 0
    const ctx = { now: 1, newId: () => `id${++n}` }
    let state = createInitialState(ctx)
    const work = state.spaces[0]!.id
    state = reduce(state, { type: 'space/update', id: work, patch: { name: 'Travail' } }, ctx)
    state = reduce(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, ctx)
    const home = state.spaces[1]!.id
    for (const [spaceId, url] of [[work, 'https://a.example/'], [home, 'https://b.example/'], [work, 'https://c.example/']] as const) state = reduce(state, { type: 'tab/open', url, spaceId, background: true }, ctx)
    state = reduce(state, { type: 'space/select', id: work }, ctx)
    const reloaded: string[] = []
    const toasts: string[] = []
    const pages = new Map(state.tabs.map((tab) => [tab.id, { reload: () => void reloaded.push(tab.url) }]))
    const self: Record<string, unknown> = {
      reloadRun: null,
      reloadEnded: null,
      deadFound: [],
      toast: null,
      publish: () => undefined,
      publishQueue: { soon: () => undefined },
      store: { get: () => state },
      pages,
      frozen: new Set<string>(),
      pageIsBeingEdited: async () => false,
      sleepingTabIds: () => [],
      // One window: the pages are its own, and none is locked.
      isTabLocked: () => false,
      ownerOf: (id: string) => (pages.has(id) ? self : undefined),
      showToast: (message: string) => {
        toasts.push(message)
        self['toast'] = { id: toasts.length, message }
      },
      reviseToast: () => false,
      // The sites that no longer answer are looked for in reload-all-run.test.ts.
      lookAtReloaded: async () => undefined,
      tellDeadTabs: () => undefined,
      offerFound: () => undefined
    }
    self['group'] = new Set([self])
    for (const name of ['runReload', 'startTurn', 'stepReload', 'publishMarks', 'keepLastMarks', 'tellReloadProgress', 'runNotice', 'showStopNotice', 'scopedNotice', 'spaceNameOf']) self[name] = shellMethods[name]
    const reload = (onlySpace: boolean) => shellMethods['reloadAllTabs']!.call(self, 0, false, onlySpace) as Promise<{ reloaded: number }>
    return { reload, reloaded, toasts }
  }

  it('reloads the tabs of the space on screen only, and says which space in its notice', async () => {
    const window = shell()
    expect(await window.reload(true)).toMatchObject({ reloaded: 2 })
    expect(window.reloaded).toEqual(['https://a.example/', 'https://c.example/'])
    // At the click, then at the end: both name the space.
    expect(window.toasts).toEqual([scopedReloadNotice('Travail', reloadProgressNotice(0, 2)), scopedReloadNotice('Travail', reloadAllNotice(2, 0, 0))])
  })

  it('reloads the tabs of every space for the other button, with the notice of every space', async () => {
    const window = shell()
    expect(await window.reload(false)).toMatchObject({ reloaded: 3 })
    expect([...window.reloaded].sort()).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/'])
    expect(window.toasts).toEqual([reloadProgressNotice(0, 3), reloadAllNotice(3, 0, 0)])
  })
})
