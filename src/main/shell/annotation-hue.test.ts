// The hue the bar of the annotation takes: the one of the space on screen in the window that is annotated, read from the state at the time it is
// asked for. The real method runs on a stand-in for the window (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { themeFromHue, themeHue } from '@shared/theme'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const hueOf = (state: SidebarState): unknown => shell['annotationHue']!.call(fakeBrowser({ store: { get: () => state } }).self)

/** Two spaces of two hues far apart; the first one is on screen. */
function twoHues(): { state: SidebarState; first: string; second: string } {
  const made = [{ type: 'space/create', name: 'Chaud', emoji: '🔥', hue: 30 }, { type: 'space/create', name: 'Froid', emoji: '🧊', hue: 250 }].reduce((s, a) => reduce(s, a as Action, ctx), createInitialState(ctx))
  const [first, second] = made.spaces.slice(-2).map((space) => space.id) as [string, string]
  return { state: reduce(made, { type: 'space/select', id: first }, ctx), first, second }
}

describe('Browser.annotationHue', () => {
  it('is the hue of the space on screen, and follows the space when another one is shown', () => {
    const { state, second } = twoHues()
    const warm = themeHue(themeFromHue(30))
    const cold = themeHue(themeFromHue(250))
    expect(Math.abs(warm - cold)).toBeGreaterThan(100)
    expect(hueOf(state)).toBe(warm)
    expect(hueOf(reduce(state, { type: 'space/select', id: second }, ctx))).toBe(cold)
  })

  it('is the hue of the theme the space has now, not the one it was made with', () => {
    const { state, first } = twoHues()
    const repainted = reduce(state, { type: 'space/update', id: first, patch: { theme: themeFromHue(140) } }, ctx)
    expect(hueOf(repainted)).toBe(themeHue(themeFromHue(140)))
  })

  it('is none when no space is on screen (the bar then keeps its own accent)', () => {
    const { state } = twoHues()
    expect(hueOf({ ...state, activeSpaceId: 'gone' })).toBeNull()
  })
})
