// The preferences the user can force: attributes of the root of every document, read by tokens.css like the media queries of the system.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import tokensCss from '../renderer/tokens.css?raw'
import { ACCESSIBILITY_ATTRIBUTES, applyAccessibility } from './accessibility'
import { tokenValues, type TokenContext } from './design-tokens'
import type { UiSnapshot } from './ipc'
import { createInitialState } from './sidebar'

// The snapshot reaches the surfaces through an effect (no window here): the effects of the hook run while it draws, so that the snapshot it is handed is drawn.
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), useEffect: (effect: () => void) => void effect() }))

import { followSnapshots, useSnapshot } from '../renderer/api'

function root() {
  const attributes = new Map<string, string>()
  return { attributes, setAttribute: (name: string, value: string) => void attributes.set(name, value), removeAttribute: (name: string) => void attributes.delete(name) }
}

describe('the forced preferences', () => {
  it('put an attribute on the root for each one that is on, and take it off when it goes off', () => {
    const element = root()
    applyAccessibility(element, { forceHighContrast: true, forceReduceMotion: true, forceReduceTransparency: false })
    expect([...element.attributes]).toEqual([['data-contrast', 'more'], ['data-motion', 'reduce']])
    applyAccessibility(element, { forceHighContrast: false, forceReduceMotion: true, forceReduceTransparency: true })
    expect([...element.attributes]).toEqual([['data-motion', 'reduce'], ['data-transparency', 'reduce']])
  })

  it('set the attribute that the reader of tokens.css answers for the contrast and the transparency (the real sheet is measured in design-tokens.test.ts)', () => {
    const forced: Array<[keyof typeof ACCESSIBILITY_ATTRIBUTES, Partial<TokenContext>]> = [
      ['forceHighContrast', { contrast: 'forced' }],
      ['forceReduceTransparency', { transparency: 'forced' }]
    ]
    for (const [key, context] of forced) {
      const [name, value] = ACCESSIBILITY_ATTRIBUTES[key]
      // A sheet that changes a token under the attribute the setting puts on the root, as tokens.css does.
      const sheet = `:root { --probe: 1; } :root[${name}='${value}'] { --probe: 2; }`
      expect(tokenValues(sheet, { scheme: 'light', hue: 0 }).get('--probe'), `${key} off`).toBe('1')
      expect(tokenValues(sheet, { scheme: 'light', hue: 0, ...context }).get('--probe'), `${key} on`).toBe('2')
    }
  })

  it('are answered by tokens.css: the attribute of each setting changes the tokens, as the media query of the system does', () => {
    for (const [name, value] of Object.values(ACCESSIBILITY_ATTRIBUTES)) expect(tokensCss, name).toContain(`[${name}='${value}']`)
    for (const scheme of ['light', 'dark'] as const) {
      const plain = tokenValues(tokensCss, { scheme, hue: 250 })
      for (const context of [{ contrast: 'forced' as const }, { transparency: 'forced' as const }]) {
        const forced = tokenValues(tokensCss, { scheme, hue: 250, ...context })
        const changed = [...forced].filter(([token, tokenValue]) => plain.get(token) !== tokenValue)
        expect(changed.length, `${scheme} ${JSON.stringify(context)}`).toBeGreaterThan(0)
      }
    }
    expect(tokensCss).toMatch(/:root\[data-motion='reduce'\] \*[^{]*\{[^}]*animation-duration: 0\.01ms !important/)
  })
})

describe('every surface that draws a snapshot', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sets the forced preferences of its settings on the root of its document', () => {
    const attributes = new Map<string, string>()
    const documentElement = { lang: '', hasAttribute: () => false, setAttribute: (name: string, value: string) => void attributes.set(name, value), removeAttribute: (name: string) => void attributes.delete(name) }
    vi.stubGlobal('document', { documentElement })
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    const state = createInitialState({ now: 1, newId: () => 'id' })
    const snapshot = { state: { ...state, settings: { ...state.settings, forceHighContrast: true, forceReduceMotion: false, forceReduceTransparency: true } } } as unknown as UiSnapshot
    // The bridge hands the snapshot once, as the main process pushes it.
    let pushed = false
    vi.stubGlobal('window', { lucium: { getSnapshot: () => new Promise(() => undefined), onSnapshot: (listener: (next: UiSnapshot) => void) => (pushed ? undefined : ((pushed = true), listener(snapshot)), () => undefined) } })
    let drawn: UiSnapshot | null = null
    const Surface = (): null => {
      drawn = useSnapshot()
      return null
    }
    // A view rendered to markup alone draws what its document keeps (no effect runs): the document follows the bridge, as a real one does.
    const stop = followSnapshots()
    renderToStaticMarkup(createElement(Surface))
    stop()
    expect(drawn).toBe(snapshot)
    expect([...attributes].sort()).toEqual([[...ACCESSIBILITY_ATTRIBUTES.forceHighContrast], [...ACCESSIBILITY_ATTRIBUTES.forceReduceTransparency]].sort())
  })
})
