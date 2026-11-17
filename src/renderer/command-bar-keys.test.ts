// The command bar: Home and End go to the first and the last result once the caret is at that end of the text, and the notice of the
// suggestions asked of the search engine is shown in the bar of the mini window as well. The real component, drawn with no window: a key is sent by calling the
// handler the component gives its field, during the render of a probe (the component's hooks are the probe's, so a choice made by a key shows in the next pass).

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => Promise.resolve(undefined) }), useSnapshot: () => holder.snapshot }))

import { CommandBar } from './CommandBar'
import commandBarCss from './command-bar.css?raw'

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  vi.stubGlobal('requestAnimationFrame', () => 0)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

/** A window with a few tabs on one site, so that a word of that site gives several lines to choose from. */
function snapshotWith(patch: Partial<Settings> = {}): UiSnapshot {
  let state = createInitialState({ now: 1, newId: () => 'id' })
  const tabs = ['a', 'b', 'c', 'd'].map((letter) => ({ id: `t${letter}`, spaceId: state.activeSpaceId, url: `https://exemple.org/${letter}`, title: `Exemple ${letter}`, pinned: false, createdAt: 1, lastActiveAt: 1 }) as never)
  state = { ...state, tabs, settings: { ...state.settings, ...patch }, activeTabBySpace: { ...state.activeTabBySpace, [state.activeSpaceId]: 'ta' } }
  return { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [] } as unknown as UiSnapshot
}

const elementsOf = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elementsOf(element.props['children'] as ReactNode)]
}

interface Press {
  key: string
  /** Where the caret is in the field, from its text. */
  caret: (value: string) => [start: number, end: number]
  modifiers?: Partial<Record<'shiftKey' | 'metaKey' | 'altKey' | 'ctrlKey', boolean>>
}

const atStart: Press['caret'] = () => [0, 0]
const atEnd: Press['caret'] = (value) => [value.length, value.length]
const inside: Press['caret'] = (value) => [2, 2 + Math.min(1, value.length)]

/**
 * Types `initial` in the bar, then sends these keys one after the other, each to the handler of the render that follows the previous one. Answers, for
 * each key, whether the field was kept from moving its caret (`preventDefault`), and the line the bar highlights at the end, with how many lines it has.
 */
function press(presses: Press[], initial = 'exemple'): { taken: boolean[]; active: string | undefined; lines: number } {
  holder.snapshot = snapshotWith()
  const taken: boolean[] = []
  let tree: ReactNode = null
  const Probe = () => {
    tree = CommandBar({ mode: 'current', initial })
    const next = presses[taken.length]
    if (next) {
      const field = elementsOf(tree).find((element) => element.props['role'] === 'combobox')!
      const value = field.props['value'] as string
      const [selectionStart, selectionEnd] = next.caret(value)
      const event = { key: next.key, shiftKey: false, metaKey: false, altKey: false, ctrlKey: false, ...next.modifiers, currentTarget: { value, selectionStart, selectionEnd }, preventDefault: vi.fn() }
      ;(field.props['onKeyDown'] as (event: unknown) => void)(event)
      taken.push(event.preventDefault.mock.calls.length > 0)
    }
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  const elements = elementsOf(tree)
  const field = elements.find((element) => element.props['role'] === 'combobox')!
  return { taken, active: field.props['aria-activedescendant'] as string | undefined, lines: elements.filter((element) => element.props['role'] === 'option').length }
}

describe('Home and End in the field of the command bar', () => {
  it('has several lines to choose from for a word of the open tabs (the premise of the tests below)', () => {
    expect(press([]).lines).toBeGreaterThan(2)
  })

  it('go to the last line with End, then to the first with Home, when the caret is already at that end of the text', () => {
    const { lines } = press([])
    const end = press([{ key: 'End', caret: atEnd }])
    expect(end.taken).toEqual([true])
    expect(end.active).toBe(`cb-option-${lines - 1}`)
    const back = press([{ key: 'End', caret: atEnd }, { key: 'Home', caret: atStart }])
    expect(back.taken).toEqual([true, true])
    expect(back.active).toBe('cb-option-0')
  })

  it('leave the caret to move first: with it elsewhere in the text, or with some text selected, the key is the field’s', () => {
    for (const [key, caret] of [['End', atStart], ['End', inside], ['Home', atEnd], ['Home', inside]] as const) {
      const result = press([{ key, caret }])
      expect(result.taken, `${key} with the caret ${caret.name}`).toEqual([false])
      expect(result.active, key).toBe('cb-option-0')
    }
  })

  it('are the field’s with a modifier: ⇧ selects to the end, ⌘ and ⌥ jump by line or by word', () => {
    for (const modifier of ['shiftKey', 'metaKey', 'altKey', 'ctrlKey'] as const) {
      const result = press([{ key: 'End', caret: atEnd, modifiers: { [modifier]: true } }])
      expect(result.taken, modifier).toEqual([false])
      expect(result.active, modifier).toBe('cb-option-0')
    }
  })

  it('do nothing with no line to choose from', () => {
    const result = press([{ key: 'End', caret: atEnd }], '@zzzzzz')
    expect(result.lines).toBe(0)
    expect(result.taken).toEqual([false])
  })
})

describe('the count of the results', () => {
  const counted = (initial: string): [said: string | undefined, lines: number] => {
    holder.snapshot = snapshotWith()
    let tree: ReactNode = null
    const Probe = () => {
      tree = CommandBar({ mode: 'current', initial })
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    const elements = elementsOf(tree)
    const status = elements.find((element) => element.props['role'] === 'status' && element.props['className'] === 'cb-count')
    return [status?.props['children'] as string | undefined, elements.filter((element) => element.props['role'] === 'option').length]
  }

  it('is said in a status a screen reader hears when the list changes, in the language and with its plural', () => {
    const [said, lines] = counted('exemple')
    expect(lines).toBeGreaterThan(2)
    expect(said).toBe(`${lines} résultats`)
    expect(counted('@zzzzzz')).toEqual(['0 résultat', 0])
    setLanguage('en')
    expect(counted('exemple')[0]).toBe(`${lines} results`)
  })

  it('is off the screen, not hidden: `display: none` would take it away from the screen reader as well', () => {
    const rule = /\.cb-count \{([^}]*)\}/.exec(commandBarCss)?.[1] ?? ''
    expect(rule).toContain('clip-path: inset(50%)')
    expect(rule).not.toContain('display')
  })
})

describe('the notice of the suggestions asked of the search engine', () => {
  const draw = (patch: Partial<Settings>, props: { initial?: string; little?: boolean }): string => {
    holder.snapshot = snapshotWith(patch)
    return renderToStaticMarkup(createElement(CommandBar, { mode: 'current', initial: props.initial ?? 'exemple', ...(props.little ? { little: { id: 'little-1' } } : {}) }))
  }

  it('is shown under the results of the bar, and of the bar of the mini window, until it is taken in', () => {
    for (const little of [false, true]) {
      const markup = draw({}, { little })
      expect(markup, `little ${little}`).toContain('class="palette-note"')
      expect(markup, `little ${little}`).toContain('Lucium interroge votre moteur de recherche')
    }
  })

  it('says it in English, in the mini window too', () => {
    setLanguage('en')
    expect(draw({}, { little: true })).toContain('Lucium asks your search engine for suggestions.')
  })

  it('is not shown where nothing is asked of the engine: in a private window and over a private tab', () => {
    for (const little of [false, true]) {
      const normal = snapshotWith()
      holder.snapshot = { ...normal, private: true } as UiSnapshot
      const bar = () => renderToStaticMarkup(createElement(CommandBar, { mode: 'current', initial: 'exemple', ...(little ? { little: { id: 'little-1' } } : {}) }))
      expect(bar(), `private window, little ${little}`).not.toContain('palette-note')
      holder.snapshot = { ...normal, state: { ...normal.state, tabs: normal.state.tabs.map((tab) => (tab.id === 'ta' ? { ...tab, private: true } : tab)) } }
      expect(bar(), `private tab, little ${little}`).not.toContain('palette-note')
      // Another tab being private changes nothing: the rule is about the tab on screen.
      holder.snapshot = { ...normal, state: { ...normal.state, tabs: normal.state.tabs.map((tab) => (tab.id === 'tb' ? { ...tab, private: true } : tab)) } }
      expect(bar(), `private tab elsewhere, little ${little}`).toContain('palette-note')
    }
  })

  it('is not shown once it was taken in, with the suggestions off, or with nothing typed', () => {
    for (const little of [false, true]) {
      expect(draw({ suggestionsNoticeSeen: true }, { little }), 'seen').not.toContain('palette-note')
      expect(draw({ searchSuggestions: false }, { little }), 'off').not.toContain('palette-note')
      expect(draw({}, { little, initial: '' }), 'empty').not.toContain('palette-note')
    }
  })
})
