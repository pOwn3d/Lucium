// The three places that tell the state of the connection (the mark of the address row in compact mode, the mark of the pill when the toolbar is away,
// the footer of the site panel) follow `connectionState` (src/shared/url.ts, tested there): a page that is not on the web (`file:`, `about:blank`) has no
// connection to warn about, and a scheme written in capitals or behind `view-source:` is still the scheme it names. Drawn with the
// real components, no window.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { RuntimeState, SidebarState, TabItem } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { elementsOf, type Element } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { Sidebar } from './Sidebar'
import { SidebarUiContext, TabRow, type SidebarUi } from './SidebarRows'
import { SitePanel } from './SitePanel'
import { Toolbar } from './Toolbar'

/** An address of each kind: on the web with and without encryption (written as a user may type it), and pages with no connection. */
const SECURE = ['https://exemple.fr/', 'HTTPS://EXEMPLE.FR/a', 'view-source:https://exemple.fr/']
const INSECURE = ['http://exemple.fr/', 'HTTP://EXEMPLE.FR/', 'view-source:http://exemple.fr/']
const LOCAL = ['file:///Users/moi/page.html', 'about:blank']

const noop = (): void => undefined
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }

function ui(compact: boolean): SidebarUi {
  return { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop, ...(compact ? { compact: { fullUrl: false, edit: noop, siteInfo: noop } } : {}) }
}
const underUi = (compact: boolean) => (probe: ReactElement): ReactElement => createElement(SidebarUiContext.Provider, { value: ui(compact) }, probe)
const text = (element: Element | undefined): string => String(element?.props['children'] ?? '')

/** One window with one tab on `url`, on screen, the setting given. */
function stateOn(url: string, settings: Partial<SidebarState['settings']> = {}): SidebarState {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url, spaceId: state.spaces[0]!.id }, ctx)
  return reduce(state, { type: 'settings/update', patch: settings }, ctx)
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

describe('the mark of the connection', () => {
  it('is the mark of the address row of a tab in compact mode', () => {
    const mark = (url: string): string => {
      const tab: TabItem = { id: 't', spaceId: 's', url, title: 'Page', pinned: false, createdAt: 1, lastActiveAt: 2 }
      return text(elementsOf(createElement(TabRow, { tab, active: true, inSplit: false, runtime }), undefined, underUi(true)).find((element) => element.type === 'button' && String(element.props['className']).includes('site-info')))
    }
    for (const url of SECURE) expect(mark(url), url).toBe('🔒')
    for (const url of INSECURE) expect(mark(url), url).toBe('⚠')
    for (const url of LOCAL) expect(mark(url), url).toBe('ⓘ')
  })

  it('is the mark beside the pill of the address when the toolbar is away', () => {
    const mark = (url: string): string => {
      const state = stateOn(url, { showToolbar: false })
      const snapshot = { state, runtime, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false } as unknown as UiSnapshot
      const buttons = elementsOf(createElement(Sidebar, { snapshot, space: state.spaces[0]! }), undefined, underUi(false)).filter((element) => element.type === 'button' && element.props['title'] === `${t('toolbar.infos-et-reglages-du-site')} · ⇧⌘I`)
      expect(buttons, url).toHaveLength(1)
      return text(buttons[0])
    }
    for (const url of SECURE) expect(mark(url), url).toBe('🔒')
    for (const url of INSECURE) expect(mark(url), url).toBe('⚠')
    for (const url of LOCAL) expect(mark(url), url).toBe('ⓘ')
  })

  it('warns only for the state "insecure" in the footer of the site panel, and names a page with no connection for what it is', () => {
    const footer = (url: string): string => {
      holder.snapshot = { state: stateOn(url), extensions: [], runtime: { tabs: {} }, private: false }
      return /<span class="scc-secure[^"]*">[\s\S]*?<\/span>/.exec(renderToStaticMarkup(createElement(SitePanel)))?.[0] ?? ''
    }
    for (const url of SECURE) expect(footer(url), url).toMatch(new RegExp(`^<span class="scc-secure ">[\\s\\S]*${t('site-panel.securise')}</span>$`))
    for (const url of INSECURE) expect(footer(url), url).toMatch(new RegExp(`^<span class="scc-secure warning">[\\s\\S]*${t('site-panel.non-securise')}</span>$`))
    for (const url of LOCAL) expect(footer(url), url).toMatch(new RegExp(`^<span class="scc-secure ">[\\s\\S]*${t('site-panel.page-locale')}</span>$`))
  })

  // A certificate let through although it was not valid (« Continuer quand même », a site in Developer Mode): the main process says so in the
  // runtime of the tab, and every place that tells the connection says « Non sécurisé », never a padlock.
  describe('of a page shown over a certificate let through', () => {
    const URL_OF_PAGE = 'https://app.local:8443/'
    const tab: TabItem = { id: 't', spaceId: 's', url: URL_OF_PAGE, title: 'Préprod', pinned: false, createdAt: 1, lastActiveAt: 2 }
    const untrusted: RuntimeState = { tabs: { t: { loading: false, audible: false, muted: false, awake: true, untrustedCertificate: true } }, canGoBack: false, canGoForward: false }

    it('is the warning sign in the address row of a tab, not the padlock', () => {
      const mark = (state: RuntimeState): string =>
        text(elementsOf(createElement(TabRow, { tab, active: true, inSplit: false, runtime: state }), undefined, underUi(true)).find((element) => element.type === 'button' && String(element.props['className']).includes('site-info')))
      expect(mark(runtime)).toBe('🔒')
      expect(mark(untrusted)).toBe('⚠')
    })

    it('is the warning sign beside the pill of the address', () => {
      const state = stateOn(URL_OF_PAGE, { showToolbar: false })
      const id = state.tabs[0]!.id
      const snapshot = { state, runtime: { ...untrusted, tabs: { [id]: untrusted.tabs['t']! } }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false } as unknown as UiSnapshot
      const buttons = elementsOf(createElement(Sidebar, { snapshot, space: state.spaces[0]! }), undefined, underUi(false)).filter((element) => element.type === 'button' && element.props['title'] === `${t('toolbar.infos-et-reglages-du-site')} · ⇧⌘I`)
      expect(text(buttons[0])).toBe('⚠')
    })

    it('says « Non sécurisé » in words in the toolbar, and only then', () => {
      const bar = (state: RuntimeState): string => renderToStaticMarkup(createElement(Toolbar, { space: { profileId: 'default' } as never, current: tab, runtime: state, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false }))
      expect(bar(untrusted)).toContain(`<span class="tb-insecure" title="${t('toolbar.certificat-non-valide-accepte').replace(/"/g, '&quot;')}">${t('toolbar.non-securise')}</span>`)
      expect(bar(runtime)).not.toContain('tb-insecure')
    })

    it('says why in the footer of the site panel', () => {
      const state = stateOn(URL_OF_PAGE)
      holder.snapshot = { state, extensions: [], runtime: { tabs: { [state.tabs[0]!.id]: untrusted.tabs['t'] } }, private: false }
      const footer = /<span class="scc-secure[^"]*">[\s\S]*?<\/span>/.exec(renderToStaticMarkup(createElement(SitePanel)))?.[0] ?? ''
      expect(footer).toMatch(new RegExp(`^<span class="scc-secure warning">[\\s\\S]*${t('site-panel.non-securise-certificat-accepte')}</span>$`))
    })
  })
})
