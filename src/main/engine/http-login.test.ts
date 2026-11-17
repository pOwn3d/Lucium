import { describe, expect, it } from 'vitest'
import { MainNavigation, mayAskLogin } from './http-login'

// The path from the events of a real ElectronPage to these rules is run in http-login-wiring.test.ts.

const PAGE = 'https://intranet.example/docs/index.html'

describe('mayAskLogin', () => {
  it('asks for the page itself, wherever its navigation leads', () => {
    expect(mayAskLogin({ url: 'https://intranet.example/', isRequestForNavigation: true, isProxy: false }, 'https://search.example/?q=intranet', 'https://intranet.example/')).toBe(true)
    // HTTPS first changed the scheme on the way, and the 401 comes from the address it went to.
    expect(mayAskLogin({ url: 'https://intranet.example/login', isRequestForNavigation: true, isProxy: false }, 'about:blank', 'http://intranet.example/login')).toBe(true)
  })

  // Electron calls a frame's navigation a navigation too. A frame of another site that answers 401 with a realm of its choosing
  // (« Connexion à votre banque ») must not put the login panel in the tab of the page around it.
  it('refuses a frame of another origin, while the page navigates elsewhere or not at all', () => {
    for (const navigation of [null, 'https://intranet.example/next']) {
      expect(mayAskLogin({ url: 'https://evil.example/401', isRequestForNavigation: true, isProxy: false }, 'https://bank.example/', navigation), String(navigation)).toBe(false)
      expect(mayAskLogin({ url: 'https://other.example/frame', isRequestForNavigation: true, isProxy: false }, PAGE, navigation), String(navigation)).toBe(false)
    }
  })

  it('asks for a frame of the origin of the page', () => {
    expect(mayAskLogin({ url: 'https://intranet.example/frame', isRequestForNavigation: true, isProxy: false }, PAGE)).toBe(true)
  })

  it('asks for a proxy, whatever the request is', () => {
    expect(mayAskLogin({ url: 'https://cdn.example/a.png', isRequestForNavigation: false, isProxy: true }, PAGE)).toBe(true)
  })

  it('asks for a subresource of the origin of the page', () => {
    expect(mayAskLogin({ url: 'https://intranet.example/api/list', isRequestForNavigation: false, isProxy: false }, PAGE)).toBe(true)
  })

  it('refuses a subresource of another origin: a picture that answers 401 does not get a login panel in the tab', () => {
    for (const url of ['https://attacker.example/pixel.png', 'http://intranet.example/api', 'https://intranet.example:8443/api', 'https://sub.intranet.example/x']) {
      expect(mayAskLogin({ url, isRequestForNavigation: false, isProxy: false }, PAGE), url).toBe(false)
    }
    // A subresource is no navigation, even of the host the main frame is going to.
    expect(mayAskLogin({ url: 'https://attacker.example/pixel.png', isRequestForNavigation: false, isProxy: false }, PAGE, 'https://attacker.example/')).toBe(false)
  })

  it('refuses a subresource when the page has no origin to compare with', () => {
    for (const page of ['about:blank', 'data:text/html,x', '', 'not a url']) {
      expect(mayAskLogin({ url: 'https://intranet.example/api', isRequestForNavigation: false, isProxy: false }, page), page).toBe(false)
    }
  })
})

describe('MainNavigation', () => {
  it('follows the navigation of the main frame, its redirects, until it ends', () => {
    const navigation = new MainNavigation()
    expect(navigation.current()).toBeNull()
    navigation.started('http://intranet.example/')
    navigation.started('https://sso.example/login')
    expect(navigation.current()).toBe('https://sso.example/login')
    navigation.ended()
    expect(navigation.current()).toBeNull()
  })
})
