// The bar opened on the address of the page on screen must select it whole, so that ⌘C copies it and ⌘V replaces it.
// The field only exists once the state has come (the bar returns nothing before); what is done to the field once it is there is `focusBarField`, called with
// a stand-in for the field since no key can be sent here. The same file wires the icon of the preview, the one chosen in shared/command-bar.ts.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))

import { CommandBar, focusBarField } from './CommandBar'
import { iconSource } from '@shared/site-icon'

beforeAll(() => vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) }))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

describe('the command bar opens with its address selected', () => {
  /** A stand-in for the field that tells what was done to it, in order. */
  const field = () => {
    const calls: string[] = []
    return { calls, focus: () => void calls.push('focus'), select: () => void calls.push('select') }
  }

  it('focuses the field then selects the text it opens on, an address', () => {
    const input = field()
    focusBarField(input, 'https://exemple.org/page')
    expect(input.calls).toEqual(['focus', 'select'])
  })

  it('only focuses an empty field: there is nothing to select', () => {
    const input = field()
    focusBarField(input, '')
    expect(input.calls).toEqual(['focus'])
  })

  it('does nothing while there is no field yet', () => {
    expect(() => focusBarField(null, 'https://exemple.org/page')).not.toThrow()
  })
})

describe('the preview of the command bar', () => {
  const ADDRESS = 'https://exemple.org/page'

  /** The preview column of the bar opened on this address, over a window that holds a tab on it (with its icon, unless asked). */
  function preview(options: { icon: boolean }): string {
    const base = createInitialState({ now: 1, newId: () => 'id' })
    const tab = { id: 't1', spaceId: base.activeSpaceId, url: ADDRESS, title: 'Une page', pinned: false, createdAt: 1, lastActiveAt: 2, ...(options.icon ? { faviconUrl: 'https://exemple.org/icon.png' } : {}) } as never
    holder.snapshot = { state: { ...base, tabs: [tab] }, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [] } as unknown as UiSnapshot
    const markup = renderToStaticMarkup(createElement(CommandBar, { mode: 'current', initial: ADDRESS }))
    return /<aside class="cb-preview"[\s\S]*?<\/aside>/.exec(markup)?.[0] ?? ''
  }

  it('shows the icon of the page when one is known, even on the line of a typed address', () => {
    expect(preview({ icon: true })).toContain(`<span class="cb-glyph"><img class="result-favicon" src="${iconSource('https://exemple.org/icon.png')}"`)
  })

  it('shows the glyph of the line when no icon is known', () => {
    const column = preview({ icon: false })
    expect(column).toContain('<span class="cb-glyph"><svg')
    expect(column).not.toContain('result-favicon')
  })
})
