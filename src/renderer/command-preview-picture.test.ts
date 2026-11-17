// A page whose picture does not load gets a placeholder: the preview of the command bar drew the broken-image icon.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CandidatePreview } from '@shared/command-bar'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'

// A bare-bones state hook, for the components below that are called as functions (no window, no renderer to hold their state): while `active`, the value
// of each call outlives the draw, so that what an event stores is read by the next draw, and the effects do not run. Otherwise React's own hooks answer
// (the rendering to markup).
const hooks = vi.hoisted(() => ({ active: false, slots: [] as unknown[], cursor: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const useState = <T>(initial: T): [T, (next: T) => void] => {
    if (!hooks.active) return actual.useState(initial) as [T, (next: T) => void]
    const at = hooks.cursor++
    if (!(at in hooks.slots)) hooks.slots[at] = initial
    return [hooks.slots[at] as T, (next) => void (hooks.slots[at] = next)]
  }
  return { ...actual, useState, useEffect: (...args: Parameters<typeof actual.useEffect>) => (hooks.active ? undefined : actual.useEffect(...args)) }
})

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))

import { CommandBar, ResultFavicon } from './CommandBar'
import { CommandPreview, shownPicture } from './CommandPreview'
import { iconSource } from '@shared/site-icon'

beforeAll(() => vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) }))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

describe('the picture in the preview of the command bar', () => {
  it('is the one found, as long as the page can draw it', () => {
    expect(shownPicture('data:image/jpeg;base64,AAAA', null)).toBe('data:image/jpeg;base64,AAAA')
    expect(shownPicture('data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB')).toBe('data:image/jpeg;base64,AAAA')
  })

  it('gives way to the glyph of the line once the page could not draw it, and not for the next picture', () => {
    expect(shownPicture('data:image/jpeg;base64,BBBB', 'data:image/jpeg;base64,BBBB')).toBeNull()
    expect(shownPicture(null, 'data:image/jpeg;base64,BBBB')).toBeNull()
  })

  describe('in the preview', () => {
    const picture = 'data:image/jpeg;base64,AAAA'
    const preview: CandidatePreview = { glyph: 'page', title: 'Une page', address: 'exemple.org', note: '', chips: [], keys: [], thumbTabId: 't1' }

    /** Every element of a tree, depth first. */
    function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
      if (Array.isArray(node)) return node.flatMap(elementsOf)
      if (!isValidElement(node)) return []
      const element = node as ReactElement<Record<string, unknown>>
      return [element, ...elementsOf(element.props['children'] as ReactNode)]
    }

    /** One draw of the preview. Its first state is the picture of the tab, as the main process handed it over. */
    const drawn = (): ReactElement => {
      hooks.cursor = 0
      return CommandPreview({ preview, lead: 'GLYPH' }) as ReactElement
    }

    beforeEach(() => {
      hooks.active = true
      hooks.slots = [picture]
    })
    afterEach(() => void (hooks.active = false))

    it('draws the picture of the page, and gives way to the glyph of the line as soon as the image reports its failure', () => {
      const first = drawn()
      const image = elementsOf(first).find((element) => element.type === 'img')
      expect(image?.props['src']).toBe(picture)
      expect(renderToStaticMarkup(first)).not.toContain('cb-glyph')

      ;(image?.props['onError'] as () => void)()
      const second = renderToStaticMarkup(drawn())
      expect(second).not.toContain('<img')
      expect(second).toContain('<span class="cb-glyph">GLYPH</span>')
    })
  })
})

// A local address that gives no icon (Home Assistant): the line and the preview showed the broken-image icon, the first fix having been for the picture only.
describe('the favicon of a line of the command bar', () => {
  /** One draw of the component: what it returns, with the state that the previous draws left. */
  const drawn = (src: string): ReactElement<{ onError?: () => void; children?: unknown }> => {
    hooks.cursor = 0
    return ResultFavicon({ src, fallback: 'FALLBACK' }) as ReactElement<{ onError?: () => void; children?: unknown }>
  }

  beforeEach(() => {
    hooks.active = true
    hooks.slots = []
  })
  afterEach(() => void (hooks.active = false))

  it('is the icon of the page until it fails to load', () => {
    const first = drawn('https://ha.local/favicon.ico')
    expect(first.type).toBe('img')
    // The picture is the copy the main process keeps of the icon, asked under the scheme of the interface: never the address of the site.
    expect(first.props).toMatchObject({ className: 'result-favicon', src: 'lucium-icon://site/?u=https%3A%2F%2Fha.local%2Ffavicon.ico' })
  })

  it('falls back to the icon of the kind of line when it cannot be loaded, for that address only', () => {
    drawn('https://ha.local/favicon.ico').props.onError?.()
    expect(drawn('https://ha.local/favicon.ico').props.children).toBe('FALLBACK')
    // The failure is of that address: the same line given another icon draws it.
    expect(drawn('https://ha.local/other.ico').type).toBe('img')
  })
})

describe('what leads a line of the command bar', () => {
  const FAVICONS = { tab: 'https://tab.local/icon.png', bookmark: 'https://signet.local/icon.png', readlater: 'https://plus-tard.local/icon.png' }

  /** The bar drawn for a query, over a window that holds a tab, a bookmark and a page to read later (each with its icon, unless asked). */
  function lines(options: { icons: boolean }): string {
    const base = createInitialState({ now: 1, newId: () => 'id' })
    const icon = (kind: keyof typeof FAVICONS) => (options.icons ? { faviconUrl: FAVICONS[kind] } : {})
    const tab = { id: 't1', spaceId: base.activeSpaceId, url: 'https://tab.local/', title: 'Zebra onglet', pinned: false, createdAt: 1, lastActiveAt: 2, ...icon('tab') } as never
    const state = {
      ...base,
      tabs: [tab],
      settings: { ...base.settings, bookmarkManager: true },
      bookmarks: [{ id: 'b1', url: 'https://signet.local/', title: 'Zebra signet', tags: [], addedAt: 1, ...icon('bookmark') }],
      readLater: [{ id: 'r1', url: 'https://plus-tard.local/', title: 'Zebra lecture', savedAt: 1, ...icon('readlater') }]
    }
    holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [] } as unknown as UiSnapshot
    return renderToStaticMarkup(createElement(CommandBar, { mode: 'new', initial: 'Zebra' }))
  }

  it('is the icon of the page for a tab, a page to read later and a bookmark', () => {
    const markup = lines({ icons: true })
    for (const src of Object.values(FAVICONS)) expect(markup).toContain(`<img class="result-favicon" src="${iconSource(src)}"`)
    expect(markup).not.toMatch(/<img[^>]*src="https?:/)
  })

  it('is the glyph of the kind of line when the page has no icon', () => {
    expect(lines({ icons: false })).not.toContain('result-favicon')
  })
})
