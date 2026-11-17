import { describe, expect, it } from 'vitest'
import { WEB_APP_NAME_MAX, WEB_APPS_MAX, isWebAppUrl, staysInApp, webAppName, webAppRequest } from './web-apps'
import type { SidebarState, TabItem } from './model'
import { createInitialState, reduce, type Ctx } from './sidebar'

let n = 0
const ctx = (): Ctx => ({ now: 1, newId: () => `id${++n}` })
function stateWith(url: string, over: Partial<TabItem> = {}, enabled = true): SidebarState {
  let state = createInitialState(ctx())
  state = { ...state, settings: { ...state.settings, webAppWindows: enabled } }
  state = reduce(state, { type: 'tab/open', url }, ctx())
  return { ...state, tabs: state.tabs.map((t) => ({ ...t, ...over })) }
}

describe('what may be opened as an application', () => {
  it('takes the tab on screen, with the site’s name, its icon and the profile of its space', () => {
    let state = stateWith('https://mail.example/inbox', { title: 'Boîte de réception (3) - Mail', faviconUrl: 'https://mail.example/i.png' })
    state = { ...state, spaces: state.spaces.map((s) => ({ ...s, profileId: 'travail' })) }
    expect(webAppRequest(state)).toEqual({ url: 'https://mail.example/inbox', name: 'Mail', icon: 'https://mail.example/i.png', profileId: 'travail', spaceId: state.spaces[0]!.id })
  })

  it('names the app after what the user called the tab, else the site’s name from the title, else the host', () => {
    expect(webAppName({ title: 'Page', customTitle: 'Mon app', url: 'https://a.example/' })).toBe('Mon app')
    expect(webAppName({ title: 'Boîte de réception - GitHub', url: 'https://github.com/' })).toBe('GitHub')
    expect(webAppName({ title: '', url: 'https://www.exemple.fr/x' })).toBe('exemple.fr')
    expect(webAppName({ title: 'x'.repeat(200), url: 'https://a.example/' })).toHaveLength(WEB_APP_NAME_MAX)
    expect(webAppName({ title: '\u0000\u001b', url: 'https://a.example/' })).not.toMatch(/\p{Cc}/u)
  })

  it('refuses with the function off, for a private tab, for a page that is not a web page, and for an address with a login', () => {
    expect(webAppRequest(stateWith('https://a.example/', {}, false))).toBeNull()
    expect(webAppRequest(stateWith('https://a.example/', { private: true }))).toBeNull()
    for (const url of ['about:blank', 'file:///etc/passwd', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html', 'view-source:https://a.example/', 'https://user:pass@a.example/']) {
      expect(webAppRequest(stateWith(url)), url).toBeNull()
    }
    const state = stateWith('https://a.example/')
    expect(webAppRequest(state, 'inconnu')).toBeNull()
    expect(webAppRequest(state, state.tabs[0]!.id)).not.toBeNull()
  })

  it('does not carry an icon that is not a picture or a web address', () => {
    expect(webAppRequest(stateWith('https://a.example/', { faviconUrl: 'javascript:alert(1)' }))?.icon).toBeUndefined()
    expect(webAppRequest(stateWith('https://a.example/', { faviconUrl: 'file:///etc/passwd' }))?.icon).toBeUndefined()
  })

  it('knows a web address from the rest', () => {
    for (const ok of ['https://a.example/', 'http://a.example:8080/x?y=1#z']) expect(isWebAppUrl(ok), ok).toBe(true)
    for (const bad of ['', 'javascript:1', 'ftp://a.example/', 'https://u:p@a.example/', 'https://' + 'a'.repeat(5000) + '.example/', 7, null]) expect(isWebAppUrl(bad), String(bad).slice(0, 30)).toBe(false)
    expect(WEB_APPS_MAX).toBeGreaterThan(1)
  })
})

describe('where a link goes', () => {
  it('stays in the window for the same site (any subdomain), and goes to the browser otherwise', () => {
    expect(staysInApp('https://mail.example.com/inbox', 'https://mail.example.com/other')).toBe(true)
    expect(staysInApp('https://mail.example.com/', 'https://accounts.example.com/login')).toBe(true)
    expect(staysInApp('https://mail.example.com/', 'https://evil.example.org/')).toBe(false)
    expect(staysInApp('https://mail.example.com/', 'javascript:alert(1)')).toBe(false)
    expect(staysInApp('https://mail.example.com/', 'not a url')).toBe(false)
    expect(staysInApp('https://a.github.io/', 'https://b.github.io/')).toBe(false)
  })
})
