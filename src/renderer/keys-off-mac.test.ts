// Away from macOS the interface names its keys with Ctrl and Alt: no ⌘, ⌥, ⌃ or ⇧ is drawn on a window that runs on Linux or Windows, where those keys do not
// exist. The components that drew the shortcuts of macOS there (the sidebar, the command bar, the tab search, the Shortcuts pane, the row of the mini window in
// the Settings, the guide for people who come from Arc) are drawn here with no window, for each system, on the snapshot that says which one it is.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setKeyPlatform, setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import type { PlatformId } from '@shared/platform'
import { createInitialState, reduce } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => Promise.resolve(undefined) }), useSnapshot: () => holder.snapshot }))

import { ArcGuide } from './ArcGuide'
import { CommandBar } from './CommandBar'
import { LittleShortcutRow } from './LinksSettings'
import { ShortcutsPane } from './SettingsShortcuts'
import { Sidebar } from './Sidebar'
import { SidebarUiContext, type SidebarUi } from './SidebarRows'
import { TabSearch } from './TabSearch'

const noop = (): void => undefined
const rowsUi: SidebarUi = { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop }

/** The symbols of the modifier keys of macOS (Command, Option, Control, Shift): the characters no other system draws on a key. */
const MAC_SYMBOLS = /[⌘⌥⌃⇧]/

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
/** A window with a tab open on a page and another on screen. */
function windowWithTabs(): SidebarState {
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://news.ycombinator.com/' }, ctx)
  state = { ...state, tabs: state.tabs.map((t) => ({ ...t, title: 'Hacker News' })) }
  return reduce(state, { type: 'tab/open', url: 'https://autre.exemple/' }, ctx)
}

function snapshotOf(platform: PlatformId): UiSnapshot {
  const state = windowWithTabs()
  return {
    state,
    runtime: { tabs: {}, canGoBack: false, canGoForward: false },
    engine: {},
    extensions: [],
    downloads: [],
    windows: [],
    find: null,
    peek: null,
    sidePanel: null,
    toast: null,
    platform,
    private: false
  } as unknown as UiSnapshot
}

const SYSTEMS = ['linux', 'win32'] as const

const draw = (element: ReactElement): string => renderToStaticMarkup(element)

const surfaces: Array<[string, (snapshot: UiSnapshot) => ReactElement]> = [
  ['the sidebar', (snapshot) => createElement(SidebarUiContext.Provider, { value: rowsUi }, createElement(Sidebar, { snapshot, space: snapshot.state.spaces[0]! }))],
  ['the command bar opened for a tab', () => createElement(CommandBar, { mode: 'current', initial: 'rechercher' })],
  ['the command bar opened for a new tab', () => createElement(CommandBar, { mode: 'new', initial: '' })],
  ['the tab search', () => createElement(TabSearch)],
  ['the Shortcuts pane', (snapshot) => createElement(ShortcutsPane, { bindings: snapshot.state.settings.keyBindings, platform: snapshot.platform as PlatformId, keyboard: {}, update: noop })],
  ['the row of the mini window of the Settings', (snapshot) => createElement(LittleShortcutRow, { snapshot, update: noop } as never)],
  ['the guide for people who come from Arc', () => createElement(ArcGuide, {})]
]

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
  setKeyPlatform(undefined)
  holder.snapshot = null
})

/** What `useSnapshot` does when a snapshot reaches a view (the hook is mocked here): the system of the window is told to the texts. */
function show(snapshot: UiSnapshot): UiSnapshot {
  holder.snapshot = snapshot
  setKeyPlatform(snapshot.platform as PlatformId)
  return snapshot
}

describe('the keys drawn by the interface away from macOS', () => {
  for (const [name, surface] of surfaces) {
    for (const platform of SYSTEMS) {
      for (const language of ['fr', 'en'] as const) {
        it(`draw no symbol of macOS on ${name} on ${platform}, in ${language}`, () => {
          setLanguage(language)
          const snapshot = show(snapshotOf(platform))
          expect(draw(surface(snapshot))).not.toMatch(MAC_SYMBOLS)
        })
      }
    }
  }

  it('draw them on macOS, which is what the tests above do without (a drawing with no key at all would pass them)', () => {
    const snapshot = show(snapshotOf('darwin'))
    for (const [name, surface] of surfaces.filter(([title]) => title !== 'the guide for people who come from Arc')) expect(draw(surface(snapshot)), name).toMatch(MAC_SYMBOLS)
  })

  it('keep the note about the keys macOS gives to other commands for macOS: the Shortcuts pane does not say it elsewhere', () => {
    const note = 'prennent une touche que macOS donne'
    const pane = (platform: PlatformId) => {
      const snapshot = show(snapshotOf(platform))
      return draw(createElement(ShortcutsPane, { bindings: snapshot.state.settings.keyBindings, platform, keyboard: {}, update: noop }))
    }
    expect(pane('darwin')).toContain(note)
    expect(pane('linux')).not.toContain(note)
    expect(pane('win32')).not.toContain('macOS donne d’habitude')
    expect(pane('win32')).not.toContain('macOS garde ce raccourci')
  })

  it('name the shortcuts of the sidebar with Ctrl: « Nouvel onglet · Ctrl+T », the archive and the key of the footer', () => {
    const snapshot = show(snapshotOf('linux'))
    const markup = draw(createElement(SidebarUiContext.Provider, { value: rowsUi }, createElement(Sidebar, { snapshot, space: snapshot.state.spaces[0]! })))
    expect(markup).toContain('Ctrl+T')
    expect(markup).toMatch(/Archive[^"<]*Ctrl\+Alt\+A/)
  })

  it('name the key of a line of the command bar with Ctrl, and the key that opens a line in a new tab', () => {
    show(snapshotOf('linux'))
    const markup = draw(createElement(CommandBar, { mode: 'current', initial: 'rechercher dans la page' }))
    expect(markup).toContain('Action · Ctrl+F')
    expect(markup).toContain('<kbd>Ctrl+Entrée</kbd>')
  })

  it('name the key of « Ouvrir à côté » in the tab search with Ctrl and words', () => {
    show(snapshotOf('win32'))
    expect(draw(createElement(TabSearch))).toContain('<kbd>Ctrl+Entrée</kbd>')
    setLanguage('en')
    expect(draw(createElement(TabSearch))).toContain('<kbd>Ctrl+Enter</kbd>')
  })
})
