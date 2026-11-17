// The floating sidebar (the page `#float`: the sidebar of a window that hid it, slid over the page at the touch of the window's edge), drawn for real without a
// window. Its panel is inset 5 px from the window's edge and slides in (with a small overshoot) under a pointer resting at the edge, so the pointer is on the
// transparent margin of its view, then on the panel, then off it: the panel alone telling « in » and « out » made the copy hide and the strip of the edge open it
// again, over and over (a blink). The whole view tells it: the pointer is in the floating sidebar as long as it is over its view.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { expandedElements, rendersOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, calls: [] as Array<[string, unknown]> }))
vi.mock('./api', () => ({
  api: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, name: string) => (arg: unknown) => {
        holder.calls.push([name, arg])
        return name === 'dispatch' ? Promise.resolve() : undefined
      }
    }),
  useSnapshot: () => holder.snapshot
}))

const noop = (): void => undefined
let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

beforeEach(() => {
  holder.calls.length = 0
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

/** The floating page of a window whose sidebar is hidden (docked before or not), drawn while it floats: every element it draws, its rows left out. */
async function floatingElements(own: UiSnapshot['windowSidebar'], floats = true): Promise<Element[]> {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '#float' })
  vi.resetModules()
  const [{ App }, rows] = await Promise.all([import('./App'), import('./SidebarRows')])
  const state = run(createInitialState(ctx), { type: 'settings/update', patch: { sidebarVisible: false } }, { type: 'tab/open', url: 'https://a.example/' })
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false, ...(floats ? { floating: 'in' } : {}), ...(own ? { windowSidebar: own } : {}) } as unknown as UiSnapshot
  const kept = new Set<unknown>([rows.TabRow, rows.SplitRow])
  return rendersOf(1, () => expandedElements(createElement(App), (type) => kept.has(type)))[0]!
}

describe('the floating sidebar', () => {
  it('tells the main process the pointer is in it while it is over its view, margin included, and out only when it leaves the view', async () => {
    for (const own of [undefined, { docked: true } as const]) {
      const elements = await floatingElements(own)
      const shell = elements.find((element) => typeof element.props['className'] === 'string' && element.props['className'].includes('floating-shell'))!
      holder.calls.length = 0
      ;(shell.props['onMouseEnter'] as () => void)()
      ;(shell.props['onMouseLeave'] as () => void)()
      expect(holder.calls).toEqual([['hotEdge', true], ['hotEdge', false]])
    }
  })

  it('has the full sidebar for its panel (a docked window that hid its sidebar floats the full one), and the panel says nothing of the pointer by itself', async () => {
    for (const own of [undefined, { docked: true } as const]) {
      const elements = await floatingElements(own)
      const panel = elements.find((element) => element.type === 'aside')!
      expect(String(panel.props['className'])).toContain('sidebar floating')
      expect(String(panel.props['className'])).not.toContain('docked-sidebar')
      expect(elements.some((element) => element.type === 'nav' && String(element.props['className']).includes('docked-sidebar'))).toBe(false)
      // Moving from the margin onto the panel and off it again must not reach the main process: it hid the copy at every pass of the sliding panel.
      expect(panel.props['onMouseEnter']).toBeUndefined()
      expect(panel.props['onMouseLeave']).toBeUndefined()
    }
  })

  it('draws nothing, and nothing of the pointer, while nothing floats', async () => {
    const elements = await floatingElements({ docked: true }, false)
    expect(elements.some((element) => element.type === 'aside')).toBe(false)
  })
})
