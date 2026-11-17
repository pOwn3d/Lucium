// A tab row of the sidebar: the row is not a button for assistive technology, it holds one, the button that opens the tab; the buttons beside it
// (the sound, for one) are its neighbours, not buttons nested in a button. Rendered to markup, which is what the assistive technology reads.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabItem } from '@shared/model'
import { Favicon, SidebarUiContext, TabRow, type SidebarUi } from './SidebarRows'

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = { lucium: { dispatch: vi.fn() } }
})

const tab = { id: 't1', url: 'https://one.example/', title: 'One', spaceId: 's1', pinned: false, faviconUrl: undefined } as unknown as TabItem

const ui: SidebarUi = {
  selected: new Set(),
  dragging: new Set(),
  mark: null,
  developerHosts: [],
  containers: [],
  badges: false,
  clickRow: () => undefined,
  menuRow: () => undefined,
  dragStartRow: () => undefined,
  dragStartFolder: () => undefined,
  dragEnd: () => undefined,
  clearSelection: () => undefined,
  hoverStart: () => undefined,
  hoverEnd: () => undefined
}

/** A row whose page makes a sound, so that the row has its sound button. */
const runtime = { tabs: { t1: { awake: true, audible: true, muted: false, loading: false } } } as never

const markup = (): string => renderToStaticMarkup(createElement(SidebarUiContext.Provider, { value: ui }, createElement(TabRow, { tab, active: true, inSplit: false, runtime })))

describe('a tab row of the sidebar', () => {
  it('is not a button itself: assistive technology reads the button inside it', () => {
    expect(markup()).not.toMatch(/role="button"/)
  })

  it('holds one button, the one that opens the tab, named by the title of the tab', () => {
    const html = markup()
    const opener = /<button\b[^>]*class="tab-main"[^>]*>/.exec(html)?.[0] ?? ''
    expect(opener).toMatch(/aria-label="One"/)
    expect(opener).toMatch(/aria-current="true"/)
  })

  it('keeps the sound button beside that one, not inside it', () => {
    const html = markup()
    const opener = html.indexOf('class="tab-main"')
    const closing = html.indexOf('</button>', opener)
    expect(html.indexOf('tab-sound')).toBeGreaterThan(closing)
  })
})

describe('a row that « Actualiser tous les onglets » covers', () => {
  /** The row of a sleeping tab (no page in this session), with its mark of the run and, when given, its own runtime entry. */
  const rowWith = (mark: 'pending' | 'running' | 'reloaded' | undefined, info?: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(SidebarUiContext.Provider, { value: ui }, createElement(TabRow, { tab, active: false, inSplit: false, runtime: { tabs: info ? { t1: info } : {}, canGoBack: false, canGoForward: false, ...(mark ? { reloadMarks: { t1: mark } } : {}) } as never })))
  const nameOf = (html: string): string => /<button\b[^>]*class="tab-main"[^>]*>/.exec(html)?.[0].match(/aria-label="([^"]*)"/)?.[1] ?? ''

  it('shows that its turn is to come, and says it in the name of the row', () => {
    const html = rowWith('pending')
    expect(html).toContain('class="tab-reload-mark pending"')
    expect(nameOf(html)).toBe('One, À actualiser')
    expect(html).not.toContain('class="spinner"')
  })

  it('shows the loading ring of the row while its turn goes on, before the page itself says it loads', () => {
    const html = rowWith('running')
    expect(html).toContain('class="spinner"')
    expect(nameOf(html)).toBe('One, Actualisation en cours')
    expect(html).not.toContain('tab-reload-mark')
  })

  it('keeps one loading ring when the page loads during its turn', () => {
    expect(rowWith('running', { awake: true, loading: true, audible: false, muted: false }).match(/class="spinner"/g)).toHaveLength(1)
  })

  it('shows « Actualisé » a moment after, asleep again, but not while the page still loads nor on a page that failed', () => {
    expect(rowWith('reloaded')).toContain('class="tab-reload-mark reloaded"')
    expect(nameOf(rowWith('reloaded'))).toBe('One, Actualisé')
    expect(rowWith('reloaded', { awake: true, loading: true, audible: false, muted: false })).not.toContain('tab-reload-mark')
    const failed = rowWith('reloaded', { awake: true, loading: false, failed: true, audible: false, muted: false })
    expect(failed).not.toContain('tab-reload-mark')
    expect(nameOf(failed)).toBe('One')
  })

  it('has no mark outside a run', () => {
    const html = rowWith(undefined)
    expect(html).not.toContain('tab-reload-mark')
    expect(html).not.toContain('class="spinner"')
  })
})

describe('the icon of a tab', () => {
  const icon = (url: string): string => renderToStaticMarkup(createElement(Favicon, { tab: { url, title: 'x', faviconUrl: undefined } }))

  it('is a puzzle piece for the Extensions page, which has no site to stand for it', () => {
    for (const url of ['lucium-ui://extensions/', 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${'a'.repeat(32)}`]) {
      const markup = icon(url)
      expect(markup, url).toContain('favicon-icon-fallback')
      expect(markup, url).toContain('viewBox="3 3 18 18"')
      expect(markup, url).not.toContain('monogram')
    }
  })

  it('is the letter of the site for a page of the web, and for an address that only looks like the page', () => {
    expect(icon('https://one.example/')).toContain('monogram')
    expect(icon('lucium-ui://extensions@evil/')).toContain('monogram')
    expect(icon('about:blank')).not.toContain('viewBox="3 3 18 18"')
  })
})
