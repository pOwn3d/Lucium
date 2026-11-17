// The edge of the sidebar that is dragged to resize it (and double-clicked to dock the sidebar of the window) is an 8 px strip along the sidebar's
// edge. The toolbar, the list and the footer are laid over the whole width of the sidebar at z-index 1: a strip that does not sit above them cannot be
// grabbed at all (the engine test found the list under the pointer at the edge: a drag on it never started).

import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '@shared/model'
import { elementsOf } from './render.test-support'
import sidebarCss from './sidebar.css?raw'

const sent = vi.hoisted(() => ({ actions: [] as unknown[] }))
vi.mock('./api', () => ({ api: () => ({ dispatch: (action: unknown) => void sent.actions.push(action) }) }))

import { ResizeHandle, sidebarKeyWidth } from './SidebarResizeHandle'

/** The z-index declared by the rule whose selector list contains `selector` (the first such rule), or null. */
function zIndexOf(css: string, selector: string): number | null {
  for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors!.split(',').some((one) => one.trim() === selector)) continue
    const found = /(?:^|;|\s)z-index:\s*(-?\d+)/.exec(body!)
    if (found) return Number(found[1])
  }
  return null
}

describe('the resize handle of the sidebar', () => {
  it('sits above the parts of the sidebar that cover its whole width', () => {
    const handle = zIndexOf(sidebarCss, '.sidebar .resize-handle')
    expect(handle).not.toBeNull()
    for (const covering of ['.sidebar .toolbar', '.sidebar .scroll', '.sidebar .footer']) {
      expect(zIndexOf(sidebarCss, covering), covering).not.toBeNull()
      expect(handle!, covering).toBeGreaterThan(zIndexOf(sidebarCss, covering)!)
    }
  })
})

// No other control sets the width of the sidebar: an edge that only a pointer can move leaves the keyboard without a way to widen it.
describe('the edge of the sidebar, from the keyboard', () => {
  const edge = (right = false, width = 300) => elementsOf(createElement(ResizeHandle, { right, width })).find((element) => element.props['className'] === 'resize-handle')!
  const press = (handle: ReturnType<typeof edge>, key: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}): boolean => {
    let taken = false
    ;(handle.props['onKeyDown'] as (event: unknown) => void)({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers, preventDefault: () => void (taken = true) })
    return taken
  }
  beforeEach(() => {
    sent.actions.length = 0
  })

  it('is a splitter the keyboard reaches, named, that says the width and its bounds', () => {
    expect(edge().props).toMatchObject({
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-label': t('sidebar.redimensionner-la-barre-laterale'),
      'aria-valuenow': 300,
      'aria-valuemin': SIDEBAR_WIDTH_MIN,
      'aria-valuemax': SIDEBAR_WIDTH_MAX,
      'aria-valuetext': t('sidebar.largeur-de-la-barre-laterale', { width: 300 })
    })
  })

  it('sends the new width for an arrow, Home or End, and leaves any other key, and an arrow with ⌘, alone', () => {
    const handle = edge()
    expect(press(handle, 'ArrowRight')).toBe(true)
    expect(press(handle, 'ArrowLeft', { shiftKey: true })).toBe(true)
    expect(press(handle, 'End')).toBe(true)
    expect(press(handle, 'a')).toBe(false)
    expect(press(handle, 'ArrowRight', { metaKey: true })).toBe(false)
    expect(sent.actions).toEqual([316, 236, SIDEBAR_WIDTH_MAX].map((sidebarWidth) => ({ type: 'settings/update', patch: { sidebarWidth } })))
  })

  it('widens with the arrow that points away from the sidebar, and stops at the narrowest and the widest', () => {
    // The sidebar at the left of the window: its edge is its right side.
    expect(sidebarKeyWidth(300, 'ArrowRight', false)).toBe(316)
    expect(sidebarKeyWidth(300, 'ArrowLeft', false)).toBe(284)
    // At the right: its edge is its left side.
    expect(sidebarKeyWidth(300, 'ArrowLeft', true)).toBe(316)
    expect(sidebarKeyWidth(300, 'ArrowRight', true)).toBe(284)
    expect(sidebarKeyWidth(300, 'ArrowRight', false, true)).toBe(364)
    expect(sidebarKeyWidth(SIDEBAR_WIDTH_MAX - 4, 'ArrowRight', false)).toBe(SIDEBAR_WIDTH_MAX)
    expect(sidebarKeyWidth(SIDEBAR_WIDTH_MIN + 4, 'ArrowLeft', false)).toBe(SIDEBAR_WIDTH_MIN)
    expect(sidebarKeyWidth(300, 'Home', false)).toBe(SIDEBAR_WIDTH_MIN)
    expect(sidebarKeyWidth(300, 'End', false)).toBe(SIDEBAR_WIDTH_MAX)
    expect(sidebarKeyWidth(300, 'Enter', false)).toBeNull()
  })

  it('shows where the focus is', () => {
    expect(sidebarCss).toMatch(/\.sidebar \.resize-handle:focus-visible \{[^}]*outline: var\(--focus-width\) solid var\(--focus\)/)
  })
})
