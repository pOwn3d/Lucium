// The default bar of a page that declares no colour: the grey of a dark window in a normal window, the colour
// of the window's theme in a private one. The engine test reads the colours back from a real window; this keeps the rule in the stylesheet, and
// draws the strip of a split pane with the real toolbar to see it wear the class the stylesheet paints.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { defaultTheme } from '@shared/theme'
import { Toolbar } from './Toolbar'

const css = readFileSync(fileURLToPath(new URL('./toolbar.css', import.meta.url)), 'utf8')
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
}

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {} })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

/** The classes of the bar drawn for a page, as a strip of a split pane or as the bar of the window. */
function barClasses(pane: boolean): string[] {
  const noop = (): void => undefined
  const markup = renderToStaticMarkup(
    createElement(Toolbar, {
      space: { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never,
      current: { id: 't', spaceId: 's', url: 'https://exemple.fr/', title: 'Exemple', pinned: false, createdAt: 1, lastActiveAt: 2 },
      runtime: { tabs: {}, canGoBack: false, canGoForward: false },
      sidebarVisible: true,
      fullUrl: false,
      draggable: false,
      canSplit: false,
      ...(pane ? { pane: { style: {}, focused: false, onSelect: noop, onClose: noop } } : {})
    })
  )
  return /class="(page-toolbar[^"]*)"/.exec(markup)![1]!.split(/\s+/).filter(Boolean)
}

describe('the default bar', () => {
  it('is the grey surface of the tokens (--surface-3 in a dark window, --surface-2 in a light one), without a texture, in a normal window', () => {
    expect(rule('.shell')).toContain('--toolbar-bg: var(--surface-3)')
    expect(rule('.shell')).toContain('--toolbar-texture: none')
    expect(rule('.shell.light')).toContain('--toolbar-bg: var(--surface-2)')
  })

  it("is the private window's theme colour #4147d3 in faint diagonal stripes there", () => {
    expect(rule('html.private .shell')).toContain('--toolbar-bg: #4147d3')
    expect(rule('html.private .shell')).toMatch(/--toolbar-texture: repeating-linear-gradient\(135deg/)
  })

  it('stays the dark surface, plain, in the strips of a split view whatever the window (they wear tk-dark)', () => {
    const pane = rule('.page-toolbar.pane')
    expect(pane).toContain('--toolbar-bg: var(--surface-3)')
    expect(pane).toContain('--toolbar-texture: none')
    expect(barClasses(true)).toEqual(expect.arrayContaining(['page-toolbar', 'pane', 'tk-dark']))
    expect(barClasses(false)).not.toContain('tk-dark')
  })

  it('paints the bar with the colour and the texture together', () => {
    expect(rule('.page-toolbar')).toMatch(/background-color: var\(--toolbar-bg\); background-image: var\(--toolbar-texture\)/)
  })
})
