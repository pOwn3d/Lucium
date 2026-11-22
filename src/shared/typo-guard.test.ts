import { describe, expect, it } from 'vitest'
import { lookalikeOf, TYPO_MIN_LENGTH } from './typo-guard'

const MINE = ['google.com', 'www.paypal.com', 'mail.example.org', 'github.com', 'ebay.com', 'x.com', 'web1.corp-servers.net']

describe('an address one keystroke from a site the person uses', () => {
  it('is found for a letter dropped, added, changed or two neighbours swapped, and names the site', () => {
    expect(lookalikeOf('gogle.com', MINE)).toBe('google.com')
    expect(lookalikeOf('gooogle.com', MINE)).toBe('google.com')
    expect(lookalikeOf('goofle.com', MINE)).toBe('google.com')
    expect(lookalikeOf('googel.com', MINE)).toBe('google.com')
    expect(lookalikeOf('paypa1.com', MINE)).toBe('paypal.com')
  })

  it('is found for a subdomain of the lookalike, and for the one-letter change of a suffix', () => {
    expect(lookalikeOf('login.gogle.com', MINE)).toBe('google.com')
    expect(lookalikeOf('ebay.co', MINE)).toBe('ebay.com')
  })

  it('ignores the port and the case', () => {
    expect(lookalikeOf('GOGLE.com:8443', MINE)).toBe('google.com')
  })
})

describe('what is no warning', () => {
  it('a site the person already uses, however close it is to another', () => {
    expect(lookalikeOf('google.com', MINE)).toBeNull()
    expect(lookalikeOf('mail.google.com', MINE)).toBeNull()
    expect(lookalikeOf('gogle.com', [...MINE, 'gogle.com'])).toBeNull()
  })

  it('a site two keystrokes away, or more (the names of sites that are close but are not typos)', () => {
    for (const typed of ['gitlab.com', 'bing.com', 'google.fr', 'example.com', 'paypal.org', 'github.io']) expect(lookalikeOf(typed, MINE), typed).toBeNull()
  })

  it('another subdomain of a site that is already used', () => {
    expect(lookalikeOf('app.example.org', MINE)).toBeNull()
    expect(lookalikeOf('api.example.org', ['app.example.org'])).toBeNull()
  })

  it('numbered servers and a digit for another', () => {
    expect(lookalikeOf('web2.corp-servers.net', MINE)).toBeNull()
    expect(lookalikeOf('server2.net', ['server1.net'])).toBeNull()
    expect(lookalikeOf('example2.com', ['example1.com'])).toBeNull()
  })

  it(`a short site (under ${TYPO_MIN_LENGTH} characters) is one keystroke from too many others`, () => {
    expect(lookalikeOf('y.com', MINE)).toBeNull()
    expect(lookalikeOf('z.com', ['x.com'])).toBeNull()
    expect(lookalikeOf('arc.nt', ['arc.net'])).toBeNull()
  })

  it('an address that is no site: an IP address, a bare name, a local name, an empty history', () => {
    expect(lookalikeOf('192.168.1.1', ['192.168.1.11'])).toBeNull()
    expect(lookalikeOf('localhost', ['localhosts'])).toBeNull()
    expect(lookalikeOf('gogle.com', [])).toBeNull()
    expect(lookalikeOf('', MINE)).toBeNull()
  })
})
