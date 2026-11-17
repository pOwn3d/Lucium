import { describe, expect, it } from 'vitest'
import {
  LITTLE_LINK_DISPOSITION,
  NEW_TAB_DISPOSITION,
  asksForPopup,
  linkWindowDestination,
  littleLinkOpens,
  newTabLinkOpensLittle,
  type LinkWindowPrefs,
  type LinkWindowRequest,
  type LittleLinkRequest,
  type NewTabLinkRequest
} from './little-modifier'
import { defaultSettings } from './model'
import { isOwnSite } from './party'

describe('littleLinkOpens', () => {
  const request = (over: Partial<LittleLinkRequest> = {}): LittleLinkRequest => ({
    enabled: true,
    privateTab: false,
    url: 'https://example.com/page',
    byPage: true,
    chromium: LITTLE_LINK_DISPOSITION,
    ...over
  })

  it('opens a mini window for the window Chromium opens for ⌥⌘-clic', () => {
    expect(littleLinkOpens(request())).toBe(true)
    expect(LITTLE_LINK_DISPOSITION).toBe('other')
  })

  it('does nothing while the feature is off', () => {
    expect(littleLinkOpens(request({ enabled: false }))).toBe(false)
  })

  it('leaves the link of a private tab alone: a mini window is archived in the normal profile', () => {
    expect(littleLinkOpens(request({ privateTab: true }))).toBe(false)
  })

  it('leaves alone a window the page opened on its own, and a choice made in a menu', () => {
    expect(littleLinkOpens(request({ byPage: false }))).toBe(false)
  })

  it('leaves alone every other way a window opens: a plain link, ⌘, ⇧⌘, ⇧, a script', () => {
    for (const chromium of ['default', 'foreground-tab', 'background-tab', 'new-window', 'save-to-disk', '', undefined]) expect(littleLinkOpens(request({ chromium })), String(chromium)).toBe(false)
  })

  it('only takes a web address', () => {
    for (const url of ['about:blank', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'mailto:a@b.c', '']) expect(littleLinkOpens(request({ url })), url).toBe(false)
    expect(littleLinkOpens(request({ url: 'http://example.com/' }))).toBe(true)
  })
})

describe('a link that would open a new tab', () => {
  const prefs = (over: Partial<LinkWindowPrefs> = {}): LinkWindowPrefs => ({ littleArcModifier: false, littleArcNewTabLinks: true, peekWithShift: true, peekOnExternalLinks: false, ...over })
  const request = (over: Partial<LinkWindowRequest> = {}): LinkWindowRequest => ({
    disposition: 'foreground',
    byPage: true,
    chromium: NEW_TAB_DISPOSITION,
    features: '',
    url: 'https://other.example/article',
    pageUrl: 'https://news.example/home',
    privateTab: false,
    littleAvailable: true,
    ...over
  })
  const where = (over: Partial<LinkWindowRequest> = {}, settings: Partial<LinkWindowPrefs> = {}) => linkWindowDestination(request(over), prefs(settings), isOwnSite)

  it('opens a target="_blank" link to another site in a mini window, with a plain click, by default', () => {
    expect(defaultSettings().littleArcNewTabLinks).toBe(true)
    expect(NEW_TAB_DISPOSITION).toBe('foreground-tab')
    expect(where()).toBe('little')
    // `noopener` / `noreferrer` say how to open, not that the page wants a popup.
    expect(where({ features: 'noopener,noreferrer' })).toBe('little')
  })

  it('keeps ⌘ + clic (and the middle click) a tab in the background', () => {
    expect(where({ disposition: 'background', chromium: 'background-tab' })).toBe('tab')
  })

  it('leaves a sign-in window a popup: a window.open with a size, a position or `popup` never becomes a mini window', () => {
    for (const features of ['width=500,height=600', 'popup', 'popup=1', 'left=10,top=10', 'innerWidth=400', 'noopener, height=700']) {
      expect(asksForPopup(features), features).toBe(true)
      expect(where({ features }), features).toBe('tab')
    }
    // What Chromium itself calls a popup ("new-window") is not a new tab either.
    expect(where({ chromium: 'new-window', features: 'width=500,height=600' })).toBe('tab')
    expect(asksForPopup('noopener')).toBe(false)
    expect(asksForPopup(undefined)).toBe(false)
  })

  it('keeps a link to the same site a tab, subdomains included', () => {
    expect(where({ url: 'https://news.example/other' })).toBe('tab')
    expect(where({ url: 'https://accounts.google.com/signin', pageUrl: 'https://mail.google.com/mail/u/0/' })).toBe('tab')
    expect(where({ url: 'https://www.news.example/x' })).toBe('tab')
  })

  // The Glance for « liens vers d’autres sites » compared hosts (www. apart), the mini window compared registrable domains.
  describe('« another site » means the same for the Glance and the mini window', () => {
    const peekOnExternal = { peekOnExternalLinks: true, littleArcNewTabLinks: false }
    const mini = { peekOnExternalLinks: false, littleArcNewTabLinks: true }

    it('opens neither for a link to another host of the same site, subdomains and public suffixes included', () => {
      for (const [url, pageUrl] of [
        ['https://accounts.google.com/signin', 'https://mail.google.com/mail/u/0/'],
        ['https://docs.news.example/a', 'https://news.example/'],
        ['https://b.example.co.uk/', 'https://a.example.co.uk/'],
        ['https://example.org:8443/x', 'https://example.org/']
      ] as const) {
        expect(where({ url, pageUrl }, peekOnExternal), `glance ${url}`).toBe('tab')
        expect(where({ url, pageUrl }, mini), `mini ${url}`).toBe('tab')
      }
    })

    it('opens a Glance, or a mini window, for a link to another site: the same links for both', () => {
      for (const [url, pageUrl] of [
        ['https://other.example/article', 'https://news.example/home'],
        ['https://b.github.io/', 'https://a.github.io/'],
        ['https://example.org/', 'https://example.com/']
      ] as const) {
        expect(where({ url, pageUrl }, peekOnExternal), `glance ${url}`).toBe('peek')
        expect(where({ url, pageUrl }, mini), `mini ${url}`).toBe('little')
      }
    })

    it('has no other site to name when the page of the link is gone: no Glance for it', () => {
      expect(where({ pageUrl: undefined }, peekOnExternal)).toBe('tab')
    })
  })

  it('leaves private tabs, private and guest windows as they are', () => {
    expect(where({ privateTab: true })).toBe('tab')
    // A private or a guest window has no mini window to open.
    expect(where({ littleAvailable: false })).toBe('tab')
  })

  it('leaves the pages of Lucium and every address that is not a web page alone', () => {
    for (const pageUrl of ['about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html', 'file:///Users/me/page.html', undefined]) expect(where({ pageUrl }), String(pageUrl)).toBe('tab')
    for (const url of ['about:blank', 'mailto:a@b.c', 'file:///etc/hosts']) expect(where({ url }), url).toBe('tab')
  })

  it('keeps a choice made in a menu, and a window no click explains', () => {
    expect(where({ byPage: false })).toBe('tab')
    expect(where({ byPage: false, chromium: undefined, features: undefined })).toBe('tab')
    expect(where({ disposition: 'little', byPage: false })).toBe('little')
    expect(where({ disposition: 'peek', byPage: false })).toBe('peek')
  })

  it('gives the way before back when the setting is off: a tab, and ⌥⌘-clic for a mini window', () => {
    expect(where({}, { littleArcNewTabLinks: false })).toBe('tab')
    expect(where({ chromium: LITTLE_LINK_DISPOSITION }, { littleArcNewTabLinks: false, littleArcModifier: true })).toBe('little')
    expect(where({ chromium: LITTLE_LINK_DISPOSITION }, { littleArcNewTabLinks: false, littleArcModifier: false })).toBe('tab')
  })

  it('lets the Glance the user asked for win: Shift + clic, and "Coup d’œil pour les liens vers d’autres sites"', () => {
    expect(where({}, { peekOnExternalLinks: true })).toBe('peek')
    expect(where({ disposition: 'peek', chromium: 'new-window' })).toBe('peek')
  })

  it('reads the same in the rule on its own', () => {
    const base: NewTabLinkRequest = { enabled: true, privateTab: false, url: 'https://b.example/', pageUrl: 'https://a.example/', byPage: true, chromium: 'foreground-tab', features: undefined, sameSite: isOwnSite }
    expect(newTabLinkOpensLittle(base)).toBe(true)
    expect(newTabLinkOpensLittle({ ...base, enabled: false })).toBe(false)
    expect(newTabLinkOpensLittle({ ...base, chromium: 'default' })).toBe(false)
  })
})
