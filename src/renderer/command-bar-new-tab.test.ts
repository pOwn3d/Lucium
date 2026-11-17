// The command bar of the interface is told what it was opened for: opened for a new tab or a split view, it opens a new tab with what is typed; and
// the row of the address it completed in the field leads the list Enter acts on. The ranking itself is tested in src/shared/command-bar-newtab.test.ts;
// here is the real bar, drawn with no window on a window that holds a tab, and the switch of « Aller à l'onglet déjà ouvert » in Réglages.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { interfaceMayDispatch } from '@shared/ipc-policy'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { elementsOf } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => Promise.resolve(undefined) }), useSnapshot: () => holder.snapshot }))

import { CommandBar } from './CommandBar'
import { SearchSettings } from './SearchSettings'

beforeAll(() => vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) }))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

/** A window with a tab on Hacker News and another one on screen, as when the user presses ⌘T. */
function window2(settings: Partial<Settings> = {}): SidebarState {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://news.ycombinator.com/' }, ctx)
  state = { ...state, tabs: state.tabs.map((t) => ({ ...t, title: 'Hacker News' })) }
  state = reduce(state, { type: 'tab/open', url: 'https://autre.exemple/' }, ctx)
  return reduce(state, { type: 'settings/update', patch: settings }, ctx)
}

/** The rows of the bar opened in `mode` on `typed`, in order: the label of each, and the hint of the first. */
function rows(mode: 'new' | 'split' | 'current', typed: string, state = window2()): { labels: string[]; hint: string } {
  holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [] } as unknown as UiSnapshot
  const markup = renderToStaticMarkup(createElement(CommandBar, { mode, initial: typed }))
  const options = [...markup.matchAll(/<li id="cb-option-\d+"[\s\S]*?<\/li>/g)].map((match) => match[0])
  const text = (html: string, name: string): string => new RegExp(`<span class="${name}">([^<]*)</span>`).exec(html)?.[1] ?? ''
  return { labels: options.map((html) => text(html, 'label')), hint: text(options[0] ?? '', 'hint') }
}

describe('the command bar of the interface', () => {
  it('tells the ranking that a bar opened for a new tab or a split view is for a new tab, and nothing else is', () => {
    // For a new tab, the plain search of the text leads; the tab that answers it follows, one arrow down.
    for (const mode of ['new', 'split'] as const) {
      const { labels } = rows(mode, 'hacker')
      expect(labels[0], mode).toBe('hacker')
      expect(labels.slice(1), mode).toContain('Hacker News')
    }
    // The bar of the address on screen goes to the open tab, as before.
    expect(rows('current', 'hacker').labels[0]).toBe('Hacker News')
    // With « Aller à l'onglet déjà ouvert », the bar of a new tab goes there too.
    expect(rows('new', 'hacker', window2({ goToOpenTab: true })).labels[0]).toBe('Hacker News')
  })

  it('puts the row of the completed address first in the list it shows and acts on', () => {
    // "news" completes to the address of the open tab in the field: Enter opens that address, the search of the letters is one arrow down.
    const { labels } = rows('new', 'news')
    expect(labels[0]).toBe('news.ycombinator.com')
    expect(labels[1]).toBe('news')
  })
})

describe('what the bar sends out', () => {
  // The two rules are tested in src/shared/private-tab.test.ts; the bar must go through them, with the pill of a site search and the tab of the line.
  it('asks suggestions and opens ⌘↩ through the rules that keep a site search and a private tab where they belong', () => {
    const source = readFileSync(new URL('./CommandBar.tsx', import.meta.url), 'utf8')
    expect(source).toContain('const text = suggestionQuery(query, { staysPrivate, genre: barScope, siteSearch: scope !== null })')
    expect(source).toMatch(/\.suggest\(text\)/)
    expect(source.match(/\.suggest\(/g)).toHaveLength(1)
    expect(source).toContain("const target = snapshot ? newTabOf(c, snapshot.state) : { how: 'run' as const }")
    expect(source).toContain("void api().dispatch({ type: 'tab/open', url: target.url, private: true })")
    expect(source.match(/submitUrl\([^)]*'new'\)/g)).toEqual(["submitUrl(target.url, 'new')"])
  })
})

describe('the switch « Aller à l’onglet déjà ouvert »', () => {
  const snapshotWith = (goToOpenTab: boolean): UiSnapshot => ({ state: window2({ goToOpenTab }), runtime: { tabs: {} }, extensions: [], downloads: [] }) as unknown as UiSnapshot

  it('is in the Settings window, shows the setting and writes it, as the interface may', () => {
    // From the marker of the row to its switch: the row keeps its text behind « En savoir plus », its label holds the name alone.
    const field = (goToOpenTab: boolean): string => /<input[^>]*>/.exec(/data-setting="goToOpenTab"[\s\S]*?<input[^>]*>/.exec(renderToStaticMarkup(createElement(SearchSettings, { snapshot: snapshotWith(goToOpenTab), update: () => undefined })))?.[0] ?? '')?.[0] ?? ''
    expect(field(true)).toMatch(/checked=""/)
    expect(field(false)).not.toMatch(/checked=""/)
    const updates: Partial<Settings>[] = []
    const row = elementsOf(createElement(SearchSettings, { snapshot: snapshotWith(false), update: (patch: Partial<Settings>) => void updates.push(patch) })).find((element) => element.props['settingKey'] === 'goToOpenTab')
    ;(row!.props['onChange'] as (on: boolean) => void)(true)
    expect(updates).toEqual([{ goToOpenTab: true }])
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { goToOpenTab: true } }, [])).toBe(true)
  })
})
