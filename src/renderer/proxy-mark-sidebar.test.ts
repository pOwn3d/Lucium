// The sidebar marks the tabs that do not go through the proxy of their profile (shared/proxy-mark.ts): a container and a private tab leave by the general proxy.
// The sidebar is drawn for real, over a state with a profile that has a proxy of its own.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import sidebarCss from './sidebar.css?raw'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({ spaceBackgroundMedia: async () => ({ ok: false }) }), useSnapshot: () => holder.snapshot }))

import { Sidebar } from './Sidebar'

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

const WORK = { mode: 'manual', address: 'http://work.example:3128', bypass: '' } as const
const GENERAL = { mode: 'manual', address: 'http://general.example:8080', bypass: '' } as const

/** The sidebar of the space « Travail » (profile work) with an ordinary tab, a container tab and a private tab. */
function sidebar(settings: Partial<Settings> = {}, extra: Partial<UiSnapshot> = {}): string {
  let state = createInitialState(ctx)
  state = run(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 20, profileId: 'work' })
  const work = state.spaces[1]!.id
  state = run(state, { type: 'space/select', id: work })
  for (const url of ['https://ordinaire.example/', 'https://conteneur.example/', 'https://prive.example/']) state = run(state, { type: 'tab/open', url, spaceId: work, background: true })
  state = {
    ...state,
    tabs: state.tabs.map((tab) => (tab.url === 'https://conteneur.example/' ? { ...tab, container: 'bank' } : tab.url === 'https://prive.example/' ? { ...tab, private: true } : tab)),
    settings: { ...state.settings, showToolbar: false, downloadStatusChip: false, containers: [{ id: 'bank', name: 'Banque', color: 'blue' }], proxyEnabled: true, proxy: GENERAL, profiles: { work: { proxy: WORK } }, ...settings }
  }
  const snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', ...extra } as unknown as UiSnapshot
  holder.snapshot = snapshot
  return renderToStaticMarkup(createElement(Sidebar, { snapshot, space: state.spaces.find((space) => space.id === work)! }))
}

/** The row of a tab, by the address it shows: from its own `<div class="tab` to the next one. */
const rowOf = (markup: string, host: string): string => markup.split('<div class="tab').find((part) => part.includes(`aria-label="${host}"`)) ?? ''

describe('the tabs that do not go through the proxy of their profile', () => {
  it('wear a mark with a name and an infobulle that say why: a container, a private tab', () => {
    const markup = sidebar()
    const container = rowOf(markup, 'conteneur.example')
    const words = t('sidebar-icons.proxy-du-profil-conteneur')
    expect(container).toContain('class="proxy-badge"')
    expect(container).toContain(`title="${words}"`)
    expect(container).toContain(`aria-label="${words}"`)
    expect(container).toContain('role="img"')
    const priv = rowOf(markup, 'prive.example')
    expect(priv).toContain(`aria-label="${t('sidebar-icons.proxy-du-profil-prive')}"`)
    expect(words).not.toBe(t('sidebar-icons.proxy-du-profil-prive'))
  })

  // Guard: the tab that is in the session of its profile goes through the proxy of its profile: no mark. Without the context in the rule it would be marked too.
  it('are not marked when the tab is browsed in the session of its profile', () => {
    expect(rowOf(sidebar(), 'ordinaire.example')).not.toContain('proxy-badge')
  })

  it('are not marked while the option is off, or when the profile has no proxy of its own', () => {
    expect(sidebar({ proxyEnabled: false })).not.toContain('proxy-badge')
    expect(sidebar({ profiles: {} })).not.toContain('proxy-badge')
  })

  it('say it in English too', () => {
    setLanguage('en')
    const markup = sidebar()
    expect(rowOf(markup, 'conteneur.example')).toContain('This profile’s proxy does not apply to this tab: a container goes out through the general proxy.')
    expect(rowOf(markup, 'prive.example')).toContain('This profile’s proxy does not apply to this tab: a private tab goes out through the general proxy.')
  })

  // Guard: the colours of the mark are roles of the tokens. The stylesheet test refuses a written colour; this one finds the rule.
  it('are drawn in the warning role of the tokens, on the corner opposite the badges of the container and of the private tab', () => {
    const rule = /\.sidebar \.proxy-badge \{([^}]*)\}/.exec(sidebarCss)?.[1] ?? ''
    expect(rule).toContain('color: var(--warn)')
    expect(rule).toContain('background: var(--surface)')
    expect(rule).toMatch(/left: -4px; top: -4px/)
  })
})
