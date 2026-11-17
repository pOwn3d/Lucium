// The place where the address is read (the toolbar, the pill of the sidebar when the toolbar is away, the header of the mini window) says whose page it is.
// Three rules, drawn with the real components, no window: the title, which the page writes, never stands there; a host too long for the room gives way by
// its subdomains and keeps its registrable domain; and a page that came without encryption is said « Non sécurisé » in words.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { RuntimeState, SidebarState, TabItem } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { HostText } from './HostText'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'

const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }
const FORGED = 'accounts.example.com'
const LONG = 'https://accounts.example.com.session-check.evil.example/login'

const tabOn = (url: string, title = 'Page'): TabItem => ({ id: 't', spaceId: 's', url, title, pinned: false, createdAt: 1, lastActiveAt: 2 })
const bar = (tab: TabItem, fullUrl = false): string => renderToStaticMarkup(createElement(Toolbar, { space: { profileId: 'default' } as never, current: tab, runtime, sidebarVisible: true, fullUrl, draggable: false, canSplit: false }))
/** The button of the address in the toolbar: its name and what it draws. */
const addressOf = (markup: string): string => /<button class="tb-url"[\s\S]*?<\/button>/.exec(markup)?.[0] ?? ''

function pill(url: string, title: string): string {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
  let state: SidebarState = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url, spaceId: state.spaces[0]!.id }, ctx)
  state = { ...state, tabs: state.tabs.map((tab) => ({ ...tab, title })) }
  state = reduce(state, { type: 'settings/update', patch: { showToolbar: false } }, ctx)
  const snapshot = { state, runtime, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', private: false } as unknown as UiSnapshot
  return /<button class="url-pill"[\s\S]*?<\/button>/.exec(renderToStaticMarkup(createElement(Sidebar, { snapshot, space: state.spaces[0]! })))?.[0] ?? ''
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

describe('the place of the address', () => {
  it('never shows the title of a page that has no host: it shows what the address says', () => {
    for (const [url, shown] of [['about:blank', 'about:blank'], ['file:///Users/moi/page.html', 'page.html'], ['data:text/html,x', 'data:']] as const) {
      const address = addressOf(bar(tabOn(url, FORGED)))
      expect(address, url).not.toContain(FORGED)
      expect(address, url).toContain(`<span class="tb-host">${shown}</span>`)
      expect(address, url).toContain(`aria-label="${t('toolbar.modify-address', { host: shown })}"`)
      // The reducer opens no tab on a `data:` address: the pill is read for the two others.
      if (url.startsWith('data:')) continue
      const inPill = pill(url, FORGED)
      expect(inPill, url).not.toContain(FORGED)
      expect(inPill, url).toContain(`>${shown}</button>`)
    }
  })

  it('draws a long host in two parts, the registrable domain in the one that does not give way', () => {
    const split = '<span class="host-sub">accounts.example.com.session-check.</span><span class="host-domain">evil.example</span>'
    expect(addressOf(bar(tabOn(LONG)))).toContain(`<span class="host-split tb-host">${split}</span>`)
    expect(addressOf(bar(tabOn(LONG), true))).toContain(`<span class="host-split tb-host">${split}</span><span class="tb-rest">/login</span>`)
    expect(pill(LONG, 'Page')).toContain(`<span class="host-split">${split}</span>`)
    expect(renderToStaticMarkup(createElement(HostText, { host: 'exemple.fr', className: 'la-host' }))).toBe('<span class="host-split la-host"><span class="host-domain">exemple.fr</span></span>')
  })

  it('lets the subdomains shrink and never the domain, in the stylesheet', () => {
    const sheet = readFileSync(new URL('./host-text.css', import.meta.url), 'utf8')
    expect(sheet).toMatch(/\.host-sub \{[^}]*flex: 0 1 auto;[^}]*text-overflow: ellipsis/)
    expect(sheet).toMatch(/\.host-domain \{[^}]*flex: none;/)
  })

  it('keeps the host in the header of the mini window at every width, and takes it from the address alone', () => {
    const sheet = readFileSync(new URL('./little.css', import.meta.url), 'utf8')
    for (const rule of sheet.match(/@container la[^{]*\{[^}]*\{[^}]*\}/g) ?? []) expect(rule).not.toMatch(/\.la-host[^{]*\{[^}]*display: none/)
    const source = readFileSync(new URL('./littlearc.tsx', import.meta.url), 'utf8')
    expect(source).toContain('const host = state ? webHost || addressLabel(state.url) : \'\'')
    expect(source).toContain('<HostText host={webHost} className="la-host" />')
    expect(source).not.toMatch(/hostOf\(state\.url\) \|\| state\.title/)
  })

  it('says « Non sécurisé » in words in the toolbar for a page that came over http, and for no other', () => {
    const chip = `<span class="tb-insecure" title="${t('toolbar.connexion-http-sans-chiffrement')}">${t('toolbar.non-securise')}</span>`
    for (const url of ['http://exemple.fr/', 'HTTP://EXEMPLE.FR/', 'view-source:http://exemple.fr/']) expect(bar(tabOn(url)), url).toContain(chip)
    for (const url of ['https://exemple.fr/', 'file:///Users/moi/page.html', 'about:blank']) expect(bar(tabOn(url)), url).not.toContain('tb-insecure')
    // A page this very machine serves in plain http crosses no network: the words in red above every page being built would cry wolf.
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8080/a', 'http://[::1]:5173/', 'http://app.localhost/']) expect(bar(tabOn(url)), url).not.toContain('tb-insecure')
    // The local network is a network: a page of another machine of it is said.
    for (const url of ['http://192.168.1.20/', 'http://nas.local/', 'http://localhost.evil.example/']) expect(bar(tabOn(url)), url).toContain(chip)
  })
})
