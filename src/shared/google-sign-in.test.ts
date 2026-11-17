import { describe, expect, it } from 'vitest'
import {
  GOOGLE_SIGN_IN_HOSTS,
  SIGN_IN_PRELOAD_EXCLUDES,
  googleSignInIdentity,
  isGoogleSignInUrl,
  isSignInRequest,
  signInAgentChange,
  signInRequestHeaders,
  type GoogleSignInIdentity
} from './google-sign-in'

const PAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const ELECTRON = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lucium/1.1.0 Chrome/156.0.8078.48 Electron/45.2.1 Safari/537.36'
const identity: GoogleSignInIdentity = { agent: ELECTRON, pageAgent: PAGE }
const HINTS = { 'sec-ch-ua': '"Chromium";v="156"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' }

describe('the sign-in hosts of Google', () => {
  it('are accounts.google.com and accounts.youtube.com over https, whatever the path, the case, the final dot or the credentials', () => {
    for (const url of [
      'https://accounts.google.com/',
      'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=1',
      'https://ACCOUNTS.Google.COM/signin',
      'https://accounts.google.com./signin',
      'https://accounts.google.com:443/signin',
      'https://accounts.youtube.com/accounts/SetSID',
      'https://user:pass@accounts.google.com/'
    ])
      expect(isGoogleSignInUrl(url), url).toBe(true)
  })

  it('are not their neighbours, their look-alikes, plain http, another port or anything that is not an address', () => {
    for (const url of [
      'https://mail.google.com/mail/u/0/',
      'https://myaccount.google.com/',
      'https://www.google.com/',
      'https://google.com/',
      'https://youtube.com/',
      'https://www.youtube.com/',
      'https://accounts.google.com.example/',
      'https://accounts.google.com.evil.example/signin',
      'https://evilaccounts.google.com/',
      'https://sub.accounts.google.com/',
      'https://accounts-google.com/',
      'https://accounts.google.com@evil.example/',
      'https://evil.example/?next=https://accounts.google.com/',
      'https://evil.example/accounts.google.com',
      'https://accounts.google.com:8443/',
      'http://accounts.google.com/',
      'ftp://accounts.google.com/',
      'chrome-extension://abc/accounts.google.com',
      'lucium-ui://extensions/',
      'about:blank',
      'accounts.google.com',
      '',
      'not a url'
    ])
      expect(isGoogleSignInUrl(url), url).toBe(false)
    for (const value of [undefined, null, 42, {}, ['https://accounts.google.com/']]) expect(isGoogleSignInUrl(value), String(value)).toBe(false)
  })
})

describe('the identity of the sign-in pages', () => {
  it('is Electron’s own user agent, and the pages keep their own to go back to', () => {
    expect(googleSignInIdentity(ELECTRON, PAGE)).toEqual({ agent: ELECTRON, pageAgent: PAGE })
  })

  it('is none when there is nothing to change: the pages were not made a Chrome (no agent kept), or already say what Electron says', () => {
    expect(googleSignInIdentity(undefined, PAGE)).toBeNull()
    expect(googleSignInIdentity('', PAGE)).toBeNull()
    expect(googleSignInIdentity(PAGE, PAGE)).toBeNull()
  })
})

describe('the user agent a tab gets for its next main-frame address', () => {
  it('is Electron’s when a tab goes to the hosts, once: a tab that has it already keeps it', () => {
    expect(signInAgentChange(identity, 'https://accounts.google.com/v3/signin/identifier', false)).toEqual({ agent: ELECTRON, inSignIn: true })
    expect(signInAgentChange(identity, 'https://accounts.youtube.com/accounts/SetSID', false)).toEqual({ agent: ELECTRON, inSignIn: true })
    expect(signInAgentChange(identity, 'https://accounts.google.com/signin/v2/challenge/pwd', true)).toBeNull()
  })

  it('is the own agent of the pages when a tab that was on the hosts goes anywhere else, a neighbour of Google and a look-alike included; a tab that was never on them is left alone', () => {
    for (const url of ['https://mail.google.com/mail/u/0/', 'https://myaccount.google.com/', 'https://accounts.google.com.example/', 'https://site.example/', 'about:blank']) {
      expect(signInAgentChange(identity, url, true), url).toEqual({ agent: PAGE, inSignIn: false })
      expect(signInAgentChange(identity, url, false), url).toBeNull()
    }
  })
})

describe('what is a request of the sign-in', () => {
  it('is the navigation of the main frame to the hosts, and nothing else of a tab that is not on them', () => {
    expect(isSignInRequest({ url: 'https://accounts.google.com/', resourceType: 'mainFrame' }, false)).toBe(true)
    expect(isSignInRequest({ url: 'https://accounts.google.com/', resourceType: 'mainFrame' }, true)).toBe(true)
    // A frame of Google inside another site's page, and a script of another site that asks the hosts for something: the page around them has its own identity.
    expect(isSignInRequest({ url: 'https://accounts.google.com/gsi/iframe/select', resourceType: 'subFrame' }, false)).toBe(false)
    expect(isSignInRequest({ url: 'https://accounts.google.com/_/signin', resourceType: 'xhr' }, false)).toBe(false)
    expect(isSignInRequest({ url: 'https://mail.google.com/', resourceType: 'mainFrame' }, false)).toBe(false)
    expect(isSignInRequest({ url: 'https://mail.google.com/', resourceType: 'mainFrame' }, true)).toBe(false)
  })

  it('is every request, to any host, of a tab that is on the hosts, except the navigation of its main frame elsewhere', () => {
    for (const resourceType of ['subFrame', 'script', 'xhr', 'image', 'webSocket']) expect(isSignInRequest({ url: 'https://ssl.gstatic.com/x.js', resourceType }, true), resourceType).toBe(true)
  })
})

describe('the headers of a request', () => {
  const asked = { 'Upgrade-Insecure-Requests': '1', 'User-Agent': PAGE, Accept: 'text/html' }

  it('the navigation to the hosts carries Electron’s user agent, and the hints Chromium put on a request stay as Chromium put them', () => {
    const request = { url: 'https://accounts.google.com/v3/signin/identifier', resourceType: 'mainFrame' }
    expect(signInRequestHeaders(identity, request, asked, false)).toEqual({ 'Upgrade-Insecure-Requests': '1', Accept: 'text/html', 'User-Agent': ELECTRON })
    const withHints = { ...HINTS, ...asked }
    expect(signInRequestHeaders(identity, { url: 'https://accounts.google.com/x.js', resourceType: 'script' }, withHints, true)).toEqual({ ...HINTS, 'Upgrade-Insecure-Requests': '1', Accept: 'text/html', 'User-Agent': ELECTRON })
  })

  it('every spelling of the old user agent goes, and the other headers stay', () => {
    const request = { url: 'https://accounts.google.com/', resourceType: 'mainFrame' }
    const result = signInRequestHeaders(identity, request, { 'user-agent': 'old', 'USER-AGENT': 'older', 'Sec-Fetch-Site': 'none', Accept: '*/*' }, false)
    expect(result).toEqual({ 'Sec-Fetch-Site': 'none', Accept: '*/*', 'User-Agent': ELECTRON })
  })

  it('gives back the same object when the request has the identity already, and a new one when the name is not spelled as the header is', () => {
    const request = { url: 'https://accounts.google.com/', resourceType: 'mainFrame' }
    const same = { Accept: '*/*', 'User-Agent': ELECTRON }
    expect(signInRequestHeaders(identity, request, same, false)).toBe(same)
    const lower = { Accept: '*/*', 'user-agent': ELECTRON }
    expect(signInRequestHeaders(identity, request, lower, false)).toEqual({ Accept: '*/*', 'User-Agent': ELECTRON })
    expect(signInRequestHeaders(identity, request, lower, false)).not.toBe(lower)
  })

  it('leaves alone a frame of Google or a request to the hosts inside the page of another site', () => {
    const framed = { url: 'https://accounts.google.com/gsi/iframe/select', resourceType: 'subFrame' }
    const loud = { ...HINTS, ...asked }
    expect(signInRequestHeaders(identity, framed, loud, false)).toBe(loud)
    expect(signInRequestHeaders(identity, { url: 'https://accounts.google.com/_/signin', resourceType: 'xhr' }, loud, false)).toBe(loud)
  })

  it('gives the page’s user agent back to a navigation out of the hosts that still carries Electron’s (a redirect followed before the tab got its own back)', () => {
    const leaving = { url: 'https://mail.google.com/mail/u/0/', resourceType: 'mainFrame' }
    expect(signInRequestHeaders(identity, leaving, { ...asked, 'User-Agent': ELECTRON }, true)).toEqual({ 'Upgrade-Insecure-Requests': '1', Accept: 'text/html', 'User-Agent': PAGE })
    expect(signInRequestHeaders(identity, leaving, { ...asked, 'user-agent': ELECTRON }, false)).toEqual({ 'Upgrade-Insecure-Requests': '1', Accept: 'text/html', 'User-Agent': PAGE })
  })

  it('never touches a navigation elsewhere that has its own user agent, nor a request that is not a navigation and is not of a tab of the sign-in', () => {
    const elsewhere = { url: 'https://site.example/', resourceType: 'mainFrame' }
    expect(signInRequestHeaders(identity, elsewhere, asked, false)).toBe(asked)
    expect(signInRequestHeaders(identity, elsewhere, asked, true)).toBe(asked)
    const script = { url: 'https://site.example/a.js', resourceType: 'script' }
    const loud = { ...HINTS, ...asked }
    expect(signInRequestHeaders(identity, script, loud, false)).toBe(loud)
    // Electron’s own agent on a subresource of a tab that is not in the sign-in is none of its business either.
    const stray = { ...asked, 'User-Agent': ELECTRON }
    expect(signInRequestHeaders(identity, script, stray, false)).toBe(stray)
  })
})

describe('where the preloads of Lucium must not run', () => {
  it('is the two hosts, over https, and nothing else', () => {
    expect(SIGN_IN_PRELOAD_EXCLUDES).toEqual(['https://accounts.google.com/*', 'https://accounts.youtube.com/*'])
    expect(SIGN_IN_PRELOAD_EXCLUDES).toHaveLength(GOOGLE_SIGN_IN_HOSTS.length)
  })
})
