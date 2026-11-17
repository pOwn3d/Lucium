// The arrows in the radio groups drawn as buttons: the rule, on stand-ins for the buttons, then the real groups, each drawn with no window
// and asked for the handler it gives its keys.

import { createElement, type ReactElement } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { SETTINGS_PAGES, type UiSnapshot } from '@shared/ipc'
import { createInitialState, reduce } from '@shared/sidebar'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { NEUTRAL_TINT } from '@shared/model'
import { AnnotateSheet } from './AnnotateSheet'
import { BoostEditor, CodeView } from './BoostEditor'
import { TabEditor } from './ManagePanels'
import { radioGroupKeys, tabListKeys, toolbarKeys } from './radio-keys'
import { CategoryContent } from './SettingsCategories'
import { FoldPassContext } from './settings-context'
import { SpaceCustomize } from './SpaceCustomize'
import { ThemeEditor } from './ThemeEditor'

vi.setConfig({ testTimeout: 30_000 })

const noop = (): void => undefined
const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

/** A group of `count` radios (or tabs, or buttons of a toolbar: `keys` says which), the ones of `disabled` left out by the selector as the page leaves them out. */
function group(count: number, disabled: number[] = [], keys: typeof radioGroupKeys = radioGroupKeys) {
  const radios = Array.from({ length: count }, (_, index) => ({ index, focus: vi.fn(), click: vi.fn() }))
  const asked: string[] = []
  const currentTarget = {
    querySelectorAll: (selector: string) => {
      asked.push(selector)
      return radios.filter((radio) => !disabled.includes(radio.index))
    }
  } as never
  const press = (key: string, from: number | 'elsewhere') => {
    const event = { key, target: from === 'elsewhere' ? {} : radios[from], currentTarget, preventDefault: vi.fn() }
    const reached = keys(event) as unknown as { index: number } | null
    return { reached: reached?.index ?? null, taken: event.preventDefault.mock.calls.length > 0 }
  }
  return { radios, press, asked }
}

describe('an arrow in a group of radios', () => {
  it('goes to the next or the previous radio, round the ends, and Home and End to the first and the last', () => {
    const { press } = group(4)
    expect(press('ArrowRight', 0)).toEqual({ reached: 1, taken: true })
    expect(press('ArrowDown', 1).reached).toBe(2)
    expect(press('ArrowRight', 3).reached).toBe(0)
    expect(press('ArrowLeft', 0).reached).toBe(3)
    expect(press('ArrowUp', 2).reached).toBe(1)
    expect(press('Home', 2).reached).toBe(0)
    expect(press('End', 1).reached).toBe(3)
  })

  it('gives the radio reached the focus and chooses it, as a native radio does', () => {
    const { radios, press } = group(3)
    press('ArrowRight', 0)
    expect(radios.map((radio) => [radio.focus.mock.calls.length, radio.click.mock.calls.length])).toEqual([[0, 0], [1, 1], [0, 0]])
    // Home on the first radio: the key is the group's, and nothing is chosen again.
    expect(press('Home', 0)).toEqual({ reached: 0, taken: true })
    expect(radios[0]!.click).not.toHaveBeenCalled()
  })

  it('steps over a radio that cannot be chosen', () => {
    const { press, asked } = group(3, [1])
    expect(press('ArrowRight', 0).reached).toBe(2)
    expect(asked[0]).toBe('[role="radio"]:not(:disabled)')
  })

  it('leaves every other key alone, and a key pressed outside a radio', () => {
    const { radios, press } = group(3)
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape']) expect(press(key, 0), key).toEqual({ reached: null, taken: false })
    expect(press('ArrowRight', 'elsewhere')).toEqual({ reached: null, taken: false })
    expect(radios.flatMap((radio) => [...radio.focus.mock.calls, ...radio.click.mock.calls])).toEqual([])
  })
})

describe('an arrow in a row of tabs', () => {
  it('goes to the neighbour tab with ← and →, round the ends, and to the first and the last with Home and End', () => {
    const { press, asked } = group(3, [], tabListKeys)
    expect(press('ArrowRight', 0)).toEqual({ reached: 1, taken: true })
    expect(press('ArrowRight', 2).reached).toBe(0)
    expect(press('ArrowLeft', 0).reached).toBe(2)
    expect(press('Home', 2).reached).toBe(0)
    expect(press('End', 0).reached).toBe(2)
    expect(asked[0]).toBe('[role="tab"]:not(:disabled)')
  })

  it('shows the tab reached (its own click) and gives it the focus', () => {
    const { radios: tabs, press } = group(2, [], tabListKeys)
    press('ArrowRight', 0)
    expect(tabs.map((tab) => [tab.focus.mock.calls.length, tab.click.mock.calls.length])).toEqual([[0, 0], [1, 1]])
  })

  it('leaves ↑ and ↓ to what holds the row, and every key that is not an arrow', () => {
    const { press } = group(3, [], tabListKeys)
    for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Enter', ' ']) expect(press(key, 1), key).toEqual({ reached: null, taken: false })
  })
})

describe('an arrow in a toolbar', () => {
  it('moves the focus to the neighbour button that can be pressed, and presses nothing', () => {
    const { radios: buttons, press, asked } = group(4, [2], toolbarKeys)
    expect(press('ArrowRight', 1)).toEqual({ reached: 3, taken: true })
    expect(press('ArrowLeft', 0).reached).toBe(3)
    expect(press('End', 0).reached).toBe(3)
    expect(asked[0]).toBe('button:not(:disabled)')
    expect(buttons.map((button) => button.click.mock.calls.length)).toEqual([0, 0, 0, 0])
    expect(buttons[3]!.focus).toHaveBeenCalled()
  })

  it('leaves ↑ and ↓ alone, and a key pressed in a field of the bar', () => {
    const { press } = group(3, [], toolbarKeys)
    expect(press('ArrowDown', 0)).toEqual({ reached: null, taken: false })
    expect(press('ArrowRight', 'elsewhere')).toEqual({ reached: null, taken: false })
  })
})

describe('the rows of tabs and the toolbars drawn as buttons', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
    setLanguage('fr')
  })
  afterAll(() => vi.unstubAllGlobals())

  const tabRows = (elements: Element[]): Element[] => elements.filter((element) => element.props['role'] === 'tablist')
  const tabsOf = (row: Element): Element[] => elementsOf(row).filter((element) => element.props['role'] === 'tab')

  it('answer ← and → in the Tweak editor, Style and Code, then CSS, JS and the Eraser; the tab shown is the one stop of Tab', () => {
    holder.snapshot = { state: { ...createInitialState(ctx), boosts: [] } }
    const draft = { name: 'Ma Retouche', enabled: true, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT }
    const code = { view: 'css' as const, draft, savedJs: '', previewNote: null, onView: noop, onEdit: noop, onSaveScript: noop, onPreview: noop, onZap: noop, onDevTools: noop }
    const rows = [...tabRows(elementsOf(createElement(BoostEditor, { host: 'exemple.fr' }))), ...tabRows(elementsOf(createElement(CodeView, code)))]
    expect(rows.map((row) => row.props['aria-label'])).toEqual(['Onglets de l’éditeur', 'Langage'])
    for (const row of rows) {
      expect(row.props['onKeyDown'], String(row.props['aria-label'])).toBe(tabListKeys)
      expect(tabsOf(row).map((tab) => [tab.props['aria-selected'], tab.props['tabIndex']])).toEqual(tabsOf(row).map((tab) => [tab.props['aria-selected'], tab.props['aria-selected'] ? 0 : -1]))
    }
    expect(tabsOf(rows[1]!).map((tab) => tab.props['tabIndex'])).toEqual([0, -1, -1])
  })

  it('answer ← and → in the bar of the annotation sheet', () => {
    const bars = elementsOf(createElement(AnnotateSheet, { id: 'capture-1', width: 100, height: 80 })).filter((element) => element.props['role'] === 'toolbar')
    expect(bars.map((bar) => [bar.props['aria-label'], bar.props['onKeyDown']])).toEqual([['Outils d’annotation', toolbarKeys]])
  })
})

describe('the groups of radios drawn as buttons', () => {
  const underLevel = (probe: ReactElement): ReactElement => createElement(FoldPassContext.Provider, { value: 'all' as const }, probe)
  /** The groups whose radios are buttons, among these elements: a group of native radios has the arrows already. */
  const buttonGroups = (elements: Element[]): Element[] => elements.filter((element) => element.props['role'] === 'radiogroup' && elementsOf(element).some((inner) => inner.type === 'button' && inner.props['role'] === 'radio'))

  beforeAll(() => {
    vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    setLanguage('fr')
  })
  afterAll(() => vi.unstubAllGlobals())

  it('all answer the arrows: the Settings (icon of the application, animation), a space’s background and its theme, the icon of a tab', () => {
    let state = createInitialState(ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://exemple.fr/a', spaceId: state.spaces[0]!.id }, ctx)
    state = { ...state, spaces: state.spaces.map((space, index) => (index === 0 ? { ...space, background: { type: 'image' as const, value: 'a.png', veilColor: '#0b0c12', textColor: '#ffffff' } } : space)) }
    const snapshot = { state, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
    holder.snapshot = snapshot
    const groups = [
      ...SETTINGS_PAGES.flatMap((pane) => buttonGroups(elementsOf(createElement(CategoryContent, { pane, snapshot, update: noop, goTo: noop }), undefined, underLevel))),
      ...buttonGroups(elementsOf(createElement(SpaceCustomize, { spaceId: state.spaces[0]!.id }))),
      ...buttonGroups(elementsOf(createElement(TabEditor, { tabId: state.tabs[0]!.id }))),
      ...buttonGroups(elementsOf(createElement(ThemeEditor, { spaceId: state.spaces[0]!.id })))
    ]
    const names = groups.map((element) => element.props['aria-label'])
    for (const name of ['Icône de l’application', 'Voile', 'Forme du voile', 'Couleur du texte', 'Couleur précise du texte', 'Icône de l’onglet', 'Harmonie']) expect(names, name).toContain(name)
    expect(groups.length).toBeGreaterThanOrEqual(8)
    expect(groups.filter((element) => element.props['onKeyDown'] !== radioGroupKeys).map((element) => element.props['aria-label'])).toEqual([])
  })
})
