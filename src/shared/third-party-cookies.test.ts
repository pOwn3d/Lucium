import { describe, expect, it } from 'vitest'
import { cookiesBlockedFor, withoutCookieHeader, withoutSetCookie } from './third-party-cookies'
import { cleanThirdPartyCookieExceptions, NO_PRIVACY, anyPrivacy, privacyOptionsOf, THIRD_PARTY_COOKIE_EXCEPTIONS_MAX } from './privacy'

const on = { blockThirdPartyCookies: true, thirdPartyCookieExceptions: [] as string[] }
const ask = (url: string, topUrl: string | null, resourceType = 'script') => ({ url, resourceType, topUrl })

describe('cookiesBlockedFor', () => {
  it('cuts the cookies of a request to another site than the tab', () => {
    expect(cookiesBlockedFor(ask('https://tracker.example/pixel.gif', 'https://news.test/a'), on)).toBe(true)
    expect(cookiesBlockedFor(ask('https://ads.other.test/frame', 'https://news.test/a', 'subFrame'), on)).toBe(true)
  })

  it('keeps the cookies of the site itself and of its subdomains', () => {
    expect(cookiesBlockedFor(ask('https://news.test/app.js', 'https://news.test/a'), on)).toBe(false)
    expect(cookiesBlockedFor(ask('https://cdn.news.test/app.js', 'https://www.news.test/a'), on)).toBe(false)
  })

  it('does nothing while the option is off', () => {
    expect(cookiesBlockedFor(ask('https://tracker.example/p.gif', 'https://news.test/'), { ...on, blockThirdPartyCookies: false })).toBe(false)
  })

  it('never touches the navigation of the tab itself', () => {
    expect(cookiesBlockedFor(ask('https://other.test/', 'https://news.test/', 'mainFrame'), on)).toBe(false)
  })

  it('leaves a request alone when the page it belongs to is unknown', () => {
    expect(cookiesBlockedFor(ask('https://tracker.example/p.gif', null), on)).toBe(false)
    expect(cookiesBlockedFor(ask('https://tracker.example/p.gif', 'about:blank'), on)).toBe(false)
  })

  it('lets the cookies through on a site of the list, subdomains included', () => {
    const options = { ...on, thirdPartyCookieExceptions: ['news.test'] }
    expect(cookiesBlockedFor(ask('https://tracker.example/p.gif', 'https://www.news.test/a'), options)).toBe(false)
    expect(cookiesBlockedFor(ask('https://tracker.example/p.gif', 'https://other.test/a'), options)).toBe(true)
  })

  it('counts a private suffix as a site of its own', () => {
    expect(cookiesBlockedFor(ask('https://b.github.io/x.js', 'https://a.github.io/'), on)).toBe(true)
  })
})

describe('the headers', () => {
  it('drops Cookie whatever the case, and returns the same object when there is none', () => {
    expect(withoutCookieHeader({ cookie: 'a=1', Accept: '*/*' })).toEqual({ Accept: '*/*' })
    expect(withoutCookieHeader({ COOKIE: 'a=1' })).toEqual({})
    const plain = { Accept: '*/*' }
    expect(withoutCookieHeader(plain)).toBe(plain)
  })

  it('drops every Set-Cookie of an answer and keeps the other headers', () => {
    expect(withoutSetCookie({ 'set-cookie': ['a=1', 'b=2'], 'Content-Type': ['text/html'] })).toEqual({ 'Content-Type': ['text/html'] })
    expect(withoutSetCookie({ 'Set-Cookie': ['a=1'] })).toEqual({})
    const plain = { 'Content-Type': ['text/html'] }
    expect(withoutSetCookie(plain)).toBe(plain)
  })
})

describe('the options', () => {
  it('are read from the settings, anything but true being off', () => {
    expect(privacyOptionsOf({ blockThirdPartyCookies: true, thirdPartyCookieExceptions: ['a.test'] })).toMatchObject({ blockThirdPartyCookies: true, thirdPartyCookieExceptions: ['a.test'] })
    expect(privacyOptionsOf({ blockThirdPartyCookies: 'yes' as never }).blockThirdPartyCookies).toBe(false)
  })

  it('count as a privacy option on their own, so the engine hooks are installed only when it is on', () => {
    expect(anyPrivacy(NO_PRIVACY)).toBe(false)
    expect(anyPrivacy({ ...NO_PRIVACY, blockThirdPartyCookies: true })).toBe(true)
  })

  it('keep valid hosts only, each once, up to the bound', () => {
    expect(cleanThirdPartyCookieExceptions(['A.test', 'a.test', 'not a host', 3, 'b.test'])).toEqual(['a.test', 'b.test'])
    expect(cleanThirdPartyCookieExceptions('nope')).toEqual([])
    const many = Array.from({ length: THIRD_PARTY_COOKIE_EXCEPTIONS_MAX + 20 }, (_, i) => `site${i}.test`)
    expect(cleanThirdPartyCookieExceptions(many)).toHaveLength(THIRD_PARTY_COOKIE_EXCEPTIONS_MAX)
  })
})
