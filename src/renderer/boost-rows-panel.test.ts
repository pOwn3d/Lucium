// A Tweak is deleted or renamed quickly from the list of the panel of the site, which used to only switch them on and off.
// The panel of the site and the Tweak editor are drawn with the real components (no window). A click, a key or a typed name is played the way a person
// would: the handler the component hands to its button is called during the render of a probe, so that the state it sets draws the component again.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { NEUTRAL_TINT, type Boost } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { renamedBoost } from '@shared/boost-rows'
import { sectionTitle } from '@shared/site-sections'
import editorCss from './boosts-editor.css?raw'
import panelCss from './site-panel.css?raw'

/** What the components asked of the bridge, in order. */
const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({
    dispatch: (action: unknown) => (holder.asked.push(action), Promise.resolve()),
    openOverlay: (request: unknown) => void holder.asked.push({ openOverlay: request }),
    closeOverlay: () => void holder.asked.push('closeOverlay')
  }),
  useSnapshot: () => holder.snapshot
}))

import { BoostEditor } from './BoostEditor'
import { SitePanel } from './SitePanel'

type Element = ReactElement<Record<string, unknown>>

/** Every element a tree draws, the function components called and what they return walked too. */
function expandedElements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(expandedElements)
  if (!isValidElement(node)) return []
  const element = node as Element
  const type = element.type as unknown
  // A memo component is its function under `type`.
  const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
  if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return [element, ...expandedElements((component as (props: unknown) => ReactNode)(element.props))]
  }
  return [element, ...expandedElements(element.props['children'] as ReactNode)]
}

/**
 * Draws `node` and plays the steps, one per drawing: a step finds an element and calls its handler during the render of the probe, and the state the handler
 * sets draws the component again for the next step. Gives back the elements of every drawing; every step must have run.
 */
function play(node: ReactElement, steps: Array<(elements: Element[]) => void>): Element[][] {
  const drawings: Element[][] = []
  let next = 0
  const Probe = (): null => {
    const elements = expandedElements(node)
    drawings.push(elements)
    if (next < steps.length) steps[next++]!(elements)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  expect(next, 'every step ran').toBe(steps.length)
  return drawings
}

const find = (elements: Element[], test: (props: Record<string, unknown>) => boolean): Element => {
  const found = elements.find((element) => typeof element.type === 'string' && test(element.props))
  expect(found, 'the element is drawn').toBeDefined()
  return found!
}
const handler = <T,>(element: Element, name: string) => element.props[name] as (event: T) => void
const textOf = (element: Element): string => [element.props['children']].flat().filter((child) => typeof child === 'string').join('')

const boost = (id: string, name: string): Boost => ({ id, name, host: 'exemple.fr', enabled: true, css: 'body { color: red }', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT })
const ctx = { now: 1, newId: () => 'tab' }

/** A window on a page of exemple.fr, the site having these Tweaks. */
function withBoosts(boosts: Boost[]): void {
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://www.exemple.fr/a', spaceId: state.spaces[0]!.id }, ctx)
  holder.snapshot = { state: { ...state, boosts }, extensions: [], runtime: { tabs: {} }, private: false }
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.asked.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the Tweaks of the panel of the site', () => {
  const zoom = boost('a', 'Zoom')
  const isTrash = (props: Record<string, unknown>) => props['aria-label'] === t('site-panel.supprimer-name', { name: 'Zoom' })
  // The name of the Tweak, whose double-click renames it (F2 does from the keyboard: site-panel-keyboard.test.ts).
  const isName = (props: Record<string, unknown>) => props['className'] === 'scc-boost-name'
  const isField = (props: Record<string, unknown>) => props['className'] === 'scc-rename-field'
  // The section of the Tweaks is folded when the panel opens: the person unfolds it first.
  const isBoostsHead = (props: Record<string, unknown>) =>
    props['className'] === 'scc-section-head' && props['aria-expanded'] === false && [props['children']].flat().some((child) => isValidElement(child) && (child.props as Record<string, unknown>)['children'] === sectionTitle('boosts'))
  const unfold = (elements: Element[]) => handler(find(elements, isBoostsHead), 'onClick')(undefined)

  it('are deleted only after the question, whose "Annuler" has the focus', () => {
    withBoosts([zoom])
    const drawings = play(createElement(SitePanel), [
      unfold,
      (elements) => handler(find(elements, isTrash), 'onClick')(undefined),
      (elements) => {
        // The trash button asked nothing of the state: it opened the question.
        expect(holder.asked).toEqual([])
        const cancel = find(elements, (props) => props['className'] === 'scc-mini')
        expect(cancel.props['autoFocus']).toBe(true)
        expect(textOf(cancel)).toBe(t('confirm-box.annuler'))
        handler(cancel, 'onClick')(undefined)
      },
      (elements) => {
        // "Annuler" put the row back, and deleted nothing.
        expect(holder.asked).toEqual([])
        handler(find(elements, isTrash), 'onClick')(undefined)
      },
      (elements) => handler(find(elements, (props) => props['className'] === 'scc-mini danger'), 'onClick')(undefined)
    ])
    expect(holder.asked).toEqual([{ type: 'boost/delete', id: 'a' }])
    // The question is gone after the answer: the row is back.
    expect(drawings.at(-1)!.some((element) => element.props['className'] === 'scc-mini danger')).toBe(false)
  })

  it('are renamed in place, saved on Enter with the name checked', () => {
    withBoosts([zoom])
    play(createElement(SitePanel), [
      unfold,
      (elements) => handler(find(elements, isName), 'onDoubleClick')(undefined),
      (elements) => {
        expect(find(elements, isField).props['value']).toBe('Zoom')
        handler<{ target: { value: string } }>(find(elements, isField), 'onChange')({ target: { value: '  Mode lecture  ' } })
      },
      (elements) => handler<{ key: string }>(find(elements, isField), 'onKeyDown')({ key: 'Enter' })
    ])
    expect(holder.asked).toEqual([{ type: 'boost/save', boost: { ...zoom, name: renamedBoost('  Mode lecture  ', 'Zoom') } }])
    expect(holder.asked).toEqual([{ type: 'boost/save', boost: { ...zoom, name: 'Mode lecture' } }])
  })

  it('save nothing on Enter for a name that says nothing new', () => {
    withBoosts([zoom])
    play(createElement(SitePanel), [
      unfold,
      (elements) => handler(find(elements, isName), 'onDoubleClick')(undefined),
      (elements) => handler<{ target: { value: string } }>(find(elements, isField), 'onChange')({ target: { value: '   ' } }),
      (elements) => handler<{ key: string }>(find(elements, isField), 'onKeyDown')({ key: 'Enter' }),
      // The field is gone: the row is back.
      (elements) => expect(elements.some((element) => element.props['className'] === 'scc-rename-field')).toBe(false)
    ])
    expect(holder.asked).toEqual([])
  })

  it('are left as they were on Escape, which goes no further than the field, or when the field loses the focus', () => {
    withBoosts([zoom])
    const escape = { key: 'Escape', stopPropagation: vi.fn() }
    play(createElement(SitePanel), [
      unfold,
      (elements) => handler(find(elements, isName), 'onDoubleClick')(undefined),
      (elements) => handler<{ target: { value: string } }>(find(elements, isField), 'onChange')({ target: { value: 'Autre nom' } }),
      (elements) => handler<typeof escape>(find(elements, isField), 'onKeyDown')(escape),
      (elements) => {
        expect(elements.some((element) => element.props['className'] === 'scc-rename-field')).toBe(false)
        handler(find(elements, isName), 'onDoubleClick')(undefined)
      },
      (elements) => handler(find(elements, isField), 'onBlur')(undefined),
      (elements) => expect(elements.some((element) => element.props['className'] === 'scc-rename-field')).toBe(false)
    ])
    expect(escape.stopPropagation).toHaveBeenCalledTimes(1)
    expect(holder.asked).toEqual([])
  })
})

// The Tweaks already on the site are in view while a new one is created: they were only in the menu of the title.
describe('the strip of the Tweaks of the site in the editor, drawn', () => {
  const editor = (boosts: Boost[], id?: string) => {
    withBoosts(boosts)
    return createElement(BoostEditor, { host: 'www.exemple.fr', ...(id ? { id } : {}) })
  }
  const isStrip = (props: Record<string, unknown>) => props['className'] === 'bx-sites'

  it('is drawn under the title when the site has Tweaks, and not for a site that has none', () => {
    expect(renderToStaticMarkup(editor([boost('a', 'Zoom')], 'a'))).toContain(`<nav class="bx-sites" aria-label="${t('boost-editor.retouches-de-ce-site')}">`)
    expect(renderToStaticMarkup(editor([]))).not.toContain('bx-sites')
    expect(editorCss).toMatch(/\.bx-sites \{ display: flex; flex-wrap: wrap/)
  })

  it('deletes another Tweak of the site after a question whose "Annuler" has the focus, and the open one by closing the editor', () => {
    const cross = (name: string) => (props: Record<string, unknown>) => props['className'] === 'bx-site-x' && props['aria-label'] === t('site-panel.supprimer-name', { name })
    play(editor([boost('a', 'Zoom'), boost('b', 'Lecture')], 'b'), [
      (elements) => handler(find(elements, cross('Zoom')), 'onClick')(undefined),
      (elements) => {
        expect(holder.asked).toEqual([])
        const strip = find(elements, isStrip)
        const cancel = expandedElements(strip.props['children'] as ReactNode).find((element) => element.type === 'button' && element.props['autoFocus'] === true)
        expect(textOf(cancel!)).toBe(t('confirm-box.annuler'))
        handler(find(elements, (props) => props['className'] === 'bx-site danger'), 'onClick')(undefined)
      }
    ])
    expect(holder.asked).toEqual([{ type: 'boost/delete', id: 'a' }])
    holder.asked.length = 0
    play(editor([boost('a', 'Zoom'), boost('b', 'Lecture')], 'b'), [
      (elements) => handler(find(elements, cross('Lecture')), 'onClick')(undefined),
      (elements) => handler(find(elements, (props) => props['className'] === 'bx-site danger'), 'onClick')(undefined)
    ])
    expect(holder.asked).toEqual([{ type: 'boost/delete', id: 'b' }, 'closeOverlay'])
  })

  it('goes to another Tweak of the site, or to a new one, by a click', () => {
    play(editor([boost('a', 'Zoom'), boost('b', 'Lecture')], 'b'), [(elements) => handler(find(elements, (props) => props['className'] === 'bx-site' && props['disabled'] === false), 'onClick')(undefined)])
    expect(holder.asked).toEqual([{ openOverlay: { panel: 'boost', host: 'exemple.fr', id: 'a' } }])
    holder.asked.length = 0
    play(editor([boost('a', 'Zoom'), boost('b', 'Lecture')], 'b'), [(elements) => handler(find(elements, (props) => props['className'] === 'bx-site new'), 'onClick')(undefined)])
    expect(holder.asked).toEqual([{ openOverlay: { panel: 'boost', host: 'exemple.fr', id: undefined } }])
  })
})

// The buttons of a Tweak were laid at the same spot of the row, on top of one another: their glyphs made one that nobody could read. Before
// that they appeared only under the pointer. Where they land is measured in the application (tests/e2e/site-panel.spec.ts); this is the rule.
describe('the buttons of a Tweak in the panel of the site', () => {
  /** The rules of the sheet for the row of a Tweak and its buttons, comments left out. */
  const rowRules = (css: string) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! })).filter(({ selector }) => /\.scc-boost-(row|actions?)\b/.test(selector))

  it('are in the flow of the row, side by side, in view without the pointer, and the name leaves them their room', () => {
    const rules = rowRules(panelCss)
    expect(rules.length).toBeGreaterThan(0)
    for (const { selector, body } of rules) {
      expect(body, selector).not.toMatch(/position:\s*absolute/)
      expect(body, selector).not.toMatch(/opacity:/)
    }
    expect(panelCss).toMatch(/body\.overlay \.scc-boost-actions \{ display: flex; flex: none;/)
    // The switch shrinks to what the buttons leave: the name ends in an ellipsis instead of pushing them out of the card.
    expect(panelCss).toMatch(/body\.overlay \.scc-boost-row \.scc-setting \{[^}]*flex: 1; min-width: 0;/)
  })

  it('measure what they say: buttons laid at one spot of the row, or that wait for the pointer, are refused', () => {
    const stacked = `${panelCss}\nbody.overlay .scc-boost-action { position: absolute; right: 0; top: 0; }`
    expect(() => rowRules(stacked).forEach(({ selector, body }) => expect(body, selector).not.toMatch(/position:\s*absolute/))).toThrow()
    const hidden = `${panelCss}\nbody.overlay .scc-boost-row .scc-boost-action { opacity: 0; }`
    expect(() => rowRules(hidden).forEach(({ selector, body }) => expect(body, selector).not.toMatch(/opacity:/))).toThrow()
  })
})
