// The panel of the site, opened from a pane of a split view, hangs from that pane. The toolbar and the backdrop of the layer are drawn with the real components
// (no window), and the anchor the shell finds for ⌘I is the real method of the shell on a stand-in for the window (browser.ts reaches Electron only when a
// method runs). The pure parts are measured in shared/site-request.test.ts.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paneRightInset } from '@shared/frame-layout'
import { setLanguage } from '@shared/i18n'
import type { RuntimeState, TabItem } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { defaultTheme } from '@shared/theme'

vi.mock('./api', () => ({ api: () => window.lucium, useSnapshot: () => null }))
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

import { SideBackdrop } from './OverlayHost'
import { Toolbar } from './Toolbar'

const { Browser } = await import('../main/shell/browser')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

type Element = ReactElement<Record<string, unknown>>

/** Every element a tree draws, the function components called and what they return walked too. */
function expanded(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(expanded)
  if (!isValidElement(node)) return []
  const element = node as Element
  const type = element.type as unknown
  // A memo component is its function under `type`.
  const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
  if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return [element, ...expanded((component as (props: unknown) => ReactNode)(element.props))]
  }
  return [element, ...expanded(element.props['children'] as ReactNode)]
}

describe('the way the anchor reaches the popover', () => {
  const opened: unknown[] = []
  beforeEach(() => {
    opened.length = 0
    vi.stubGlobal('window', { innerWidth: 1440, matchMedia: () => ({ matches: false }), lucium: { openOverlay: (request: unknown) => void opened.push(request) } })
    setLanguage('fr')
  })
  afterEach(() => vi.unstubAllGlobals())

  const tab: TabItem = { id: 'a', spaceId: 's', url: 'https://notes.local/reunion', title: 'Notes', pinned: false, createdAt: 1, lastActiveAt: 2 }
  const runtime: RuntimeState = { tabs: { a: { loading: false, audible: false, muted: false, awake: true } }, canGoBack: false, canGoForward: false }

  /** The elements of a toolbar: the main one, or the strip of a pane of a split view. */
  function toolbar(pane?: { focused: boolean }): Element[] {
    let elements: Element[] = []
    const Probe = (): null => {
      elements = expanded(createElement(Toolbar, { space: { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never, current: tab, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true, ...(pane ? { pane: { style: {}, focused: pane.focused, onSelect: () => undefined, onClose: () => undefined } } : {}) }))
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return elements
  }
  const siteButtons = (elements: Element[]) => elements.filter((element) => element.type === 'button' && element.props['className'] === 'tb-button tb-control')

  it('leaves the button of the focused pane with the strip of that pane', () => {
    const elements = toolbar({ focused: true })
    // The strip's root is where the page shows it: here, the right pane of a window 1440 wide.
    const root = elements.find((element) => typeof element.type === 'string' && String(element.props['className']).startsWith('page-toolbar') && typeof element.props['ref'] === 'object' && element.props['ref'] !== null)
    expect(root, 'the root of the strip holds a ref').toBeDefined()
    ;(root!.props['ref'] as { current: unknown }).current = { getBoundingClientRect: () => ({ x: 840, y: 0, width: 600, height: 40 }) }
    const [button] = siteButtons(elements)
    ;(button!.props['onClick'] as () => void)()
    expect(opened).toEqual([{ panel: 'site', anchor: { x: 840, y: 0, width: 600, height: 40 } }])
  })

  it('has no button on the strip of the other pane, and the main toolbar leaves the anchor to the shell', () => {
    expect(siteButtons(toolbar({ focused: false }))).toEqual([])
    const [button] = siteButtons(toolbar())
    ;(button!.props['onClick'] as () => void)()
    expect(opened).toEqual([{ panel: 'site' }])
  })


  it('hangs the popover from the right edge of that strip, and from its usual place without one', () => {
    const backdrop = (strip?: { x: number; width: number }) => renderToStaticMarkup(createElement(SideBackdrop, { className: 'backdrop', onKeyDown: () => undefined, onMouseDown: () => undefined, ...(strip ? { strip } : {}), children: null }))
    expect(backdrop({ x: 0, width: 600 })).toContain(`style="--popover-right:${paneRightInset({ x: 0, width: 600 }, 1440)}px"`)
    expect(backdrop()).toBe('<div class="backdrop"></div>')
  })
})

// The panel opened by ⌘I (or the menu) in a split view used to hang from the window's right edge, over the other pane.
describe('the panel of the site opened by the shortcut or the menu', () => {
  /** A window whose stage is 1200 x 800 under a strip of 40, its active tab `focus` of `tabs` (split when there are two). */
  function anchorFor(split: boolean, focus: 'first' | 'second' = 'second') {
    let n = 0
    const ctx = { now: 1, newId: () => `id${++n}` }
    let state = createInitialState(ctx)
    for (const url of ['https://a.example/', 'https://b.example/']) state = reduce(state, { type: 'tab/open', url, spaceId: state.spaces[0]!.id }, ctx)
    const [first, second] = state.tabs.slice(-2).map((tab) => tab.id) as [string, string]
    if (split) state = reduce(state, { type: 'split/create', tabId: first, withTabId: second, focus }, ctx)
    else state = reduce(state, { type: 'tab/select', id: second }, ctx)
    const stand = { store: { get: () => state }, stageRect: () => ({ x: 0, y: 40, width: 1200, height: 800 }), k: () => 1 }
    const self = new Proxy(stand, { get: (target, key) => (key in target ? target[key as keyof typeof target] : shellMethods[key as string]) })
    return shellMethods['withPaneAnchor']!.call(self, { panel: 'site' }) as { panel: 'site'; anchor?: { x: number; y: number; width: number; height: number } }
  }

  it('takes the strip of the focused pane of a split view as its anchor', () => {
    const right = anchorFor(true, 'second')
    const left = anchorFor(true, 'first')
    expect(right.anchor).toBeDefined()
    expect(left.anchor).toBeDefined()
    // The two panes share the stage: the left one starts at its edge, the right one further on, and each is a part of its width.
    expect(left.anchor!.x).toBe(0)
    expect(right.anchor!.x).toBeGreaterThan(left.anchor!.x)
    expect(right.anchor!.x + right.anchor!.width).toBeLessThanOrEqual(1200)
    expect(left.anchor!.width).toBeLessThan(1200)
  })

  it('keeps its usual place for a tab that is in no split view', () => {
    expect(anchorFor(false)).toEqual({ panel: 'site' })
  })
})
