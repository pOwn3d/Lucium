// The private look, to markup: the "Privé" chip of the address bar is lit for a private tab. Whether the chip shows in a private window is the style
// sheet's rule (`html.private`), which a test without a browser cannot draw: the sheet is read as text, as stylesheets.test.ts does.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeState, TabItem } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { defaultTheme } from '@shared/theme'
import toolbarCss from './toolbar.css?raw'
import { Toolbar } from './Toolbar'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {} })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

const tab: TabItem = { id: 'a', spaceId: 's', url: 'https://notes.local/reunion', title: 'Notes', pinned: false, createdAt: 1, lastActiveAt: 2 }
const runtime: RuntimeState = { tabs: { a: { loading: false, audible: false, muted: false, awake: true } }, canGoBack: false, canGoForward: false }
const bar = (current: TabItem): string =>
  renderToStaticMarkup(createElement(Toolbar, { space: { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never, current, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true }))

/** The classes of the "Privé" chip of the bar. */
const chipClasses = (markup: string): string[] => (/<span class="([^"]*)">Privé<\/span>/.exec(markup)?.[1] ?? '').split(/\s+/).filter(Boolean)

describe('the "Privé" chip', () => {
  it('is lit on a private tab and left to the private window\'s own rule on any other', () => {
    expect(chipClasses(bar({ ...tab, private: true }))).toEqual(['tb-chip', 'on'])
    expect(chipClasses(bar(tab))).toEqual(['tb-chip'])
  })

  it('is hidden by default and shown by a private window or a lit chip', () => {
    expect(toolbarCss).toMatch(/\.tb-chip \{ display: none;/)
    expect(toolbarCss).toContain('html.private .tb-chip, .tb-chip.on { display: inline-flex; }')
  })
})
