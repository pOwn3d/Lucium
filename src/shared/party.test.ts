import { describe, expect, it } from 'vitest'
import { documentOfRequest, isOwnSite, siteOf } from './party'

describe('siteOf', () => {
  it('is the registrable domain, whatever the subdomain, the port or the case', () => {
    expect(siteOf('https://www.example.com/a?b=c')).toBe('example.com')
    expect(siteOf('https://shop.EXAMPLE.com:8443/')).toBe('example.com')
    expect(siteOf('https://a.b.c.example.com/')).toBe('example.com')
    expect(siteOf('wss://sock.example.com/live')).toBe('example.com')
    expect(siteOf('https://example.com./')).toBe('example.com')
  })

  it('knows the multi-label public suffixes', () => {
    expect(siteOf('https://www.example.co.uk/')).toBe('example.co.uk')
    expect(siteOf('https://a.b.example.com.au/')).toBe('example.com.au')
  })

  it('counts a private suffix such as github.io as a suffix: every user is a site of their own', () => {
    expect(siteOf('https://alice.github.io/')).toBe('alice.github.io')
    expect(siteOf('https://x.alice.github.io/')).toBe('alice.github.io')
    expect(siteOf('https://bob.github.io/')).toBe('bob.github.io')
  })

  it('reads the exact list: never takes an ordinary domain for a public suffix', () => {
    // Names the probabilistic variant of the list (a structure of hashes, with rare false positives) took for suffixes, found by comparing it with
    // the exact list on random names: with it, www.q8x.io and cdn.q8x.io were two sites.
    expect(siteOf('https://www.q8x.io/')).toBe('q8x.io')
    expect(siteOf('https://cdn.q8x.io/')).toBe('q8x.io')
    expect(siteOf('https://www.5cl.app/')).toBe('5cl.app')
    expect(siteOf('https://www.kygiuma7.app/')).toBe('kygiuma7.app')
    expect(siteOf('https://www.iziwq7pqf.io/')).toBe('iziwq7pqf.io')
  })

  it('takes a host without a registrable domain for its own site: an IP address, localhost, a bare name, a suffix', () => {
    expect(siteOf('http://127.0.0.1:8080/x')).toBe('127.0.0.1')
    expect(siteOf('http://[::1]:3000/')).toBe('[::1]')
    expect(siteOf('http://localhost:3000/')).toBe('localhost')
    expect(siteOf('http://intranet/')).toBe('intranet')
    expect(siteOf('https://co.uk/')).toBe('co.uk')
  })

  it('has no site for what is not a web address with a host', () => {
    for (const address of [null, undefined, '', 'not an address', 'about:blank', 'data:text/html,hi', 'file:///tmp/a.html', 'chrome-extension://abcdef/page.html', 'blob:https://example.com/uuid', 'javascript:void(0)']) {
      expect(siteOf(address), String(address)).toBeNull()
    }
  })
})

describe('isOwnSite', () => {
  it('is true for the same site, whatever the subdomain or the port', () => {
    expect(isOwnSite('https://example.com/a.js', 'https://example.com/')).toBe(true)
    expect(isOwnSite('https://cdn.example.com/a.js', 'https://www.example.com/page')).toBe(true)
    expect(isOwnSite('https://static.example.co.uk/a.js', 'https://www.example.co.uk/')).toBe(true)
    expect(isOwnSite('https://a.example.com.au/a.js', 'https://b.example.com.au/')).toBe(true)
    expect(isOwnSite('wss://example.com:9000/socket', 'https://example.com/')).toBe(true)
  })

  it('is false for another site, including one whose name merely contains the document\'s', () => {
    expect(isOwnSite('https://tracker.test/a.js', 'https://example.com/')).toBe(false)
    expect(isOwnSite('https://notexample.com/a.js', 'https://example.com/')).toBe(false)
    expect(isOwnSite('https://example.com.evil.test/a.js', 'https://example.com/')).toBe(false)
    expect(isOwnSite('https://other.co.uk/a.js', 'https://example.co.uk/')).toBe(false)
  })

  it('tells two github.io users apart, and keeps one user\'s subdomains together', () => {
    expect(isOwnSite('https://bob.github.io/a.js', 'https://alice.github.io/')).toBe(false)
    expect(isOwnSite('https://assets.alice.github.io/a.js', 'https://alice.github.io/')).toBe(true)
  })

  it('treats an IP address and localhost as sites of their own', () => {
    expect(isOwnSite('http://127.0.0.1:2/a.js', 'http://127.0.0.1:1/')).toBe(true)
    expect(isOwnSite('http://127.0.0.2/a.js', 'http://127.0.0.1/')).toBe(false)
    expect(isOwnSite('http://localhost:2/a.js', 'http://localhost:1/')).toBe(true)
    expect(isOwnSite('http://localhost:1/a.js', 'http://127.0.0.1:1/')).toBe(false)
    expect(isOwnSite('http://[::1]:2/a.js', 'http://[::1]:1/')).toBe(true)
  })

  it('claims nothing when the document is unknown, or when both sides are', () => {
    for (const unknown of [null, undefined, '', 'about:blank', 'chrome-extension://abcdef/page.html']) {
      expect(isOwnSite('https://example.com/a.js', unknown), String(unknown)).toBe(false)
    }
    // Two unknowns are not "the same site".
    expect(isOwnSite('about:blank', 'about:blank')).toBe(false)
    expect(isOwnSite('', '')).toBe(false)
    expect(isOwnSite('https://example.com/a.js', 'not an address')).toBe(false)
  })
})

describe('documentOfRequest', () => {
  it('is the origin that issued the request, which also covers a worker and a frame with no address of its own', () => {
    expect(documentOfRequest({ resourceType: 'script', initiatorOrigin: 'https://player.test', frame: { url: 'https://player.test/embed?id=1' } })).toBe('https://player.test')
    // A service worker has no frame at all.
    expect(documentOfRequest({ resourceType: 'xhr', initiatorOrigin: 'https://news.test' })).toBe('https://news.test')
    // A srcdoc frame is "about:srcdoc": the origin it inherited is what says whose it is.
    expect(documentOfRequest({ resourceType: 'image', initiatorOrigin: 'https://news.test', frame: { url: 'about:srcdoc' } })).toBe('https://news.test')
  })

  it('falls back to the address of the frame when the origin is opaque (a sandboxed frame) or not a web origin', () => {
    expect(documentOfRequest({ resourceType: 'image', initiatorOrigin: 'null', frame: { url: 'https://embed.test/sandboxed' } })).toBe('https://embed.test/sandboxed')
    expect(documentOfRequest({ resourceType: 'image', initiatorOrigin: 'chrome-extension://abcdef', frame: { url: 'https://embed.test/x' } })).toBe('https://embed.test/x')
  })

  it('names the parent for a frame\'s own navigation: the frame being loaded is not the one asking', () => {
    const navigation = { resourceType: 'subFrame', frame: { url: 'https://child.test/already-there', parent: { url: 'https://parent.test/page' } } }
    expect(documentOfRequest(navigation)).toBe('https://parent.test/page')
    // Without the parent, the address of the frame being loaded would be a wrong answer: none is better.
    expect(documentOfRequest({ resourceType: 'subFrame', frame: { url: 'https://child.test/x', parent: null } })).toBeNull()
    // A sub-resource of that same frame is its own business: the frame itself answers.
    expect(documentOfRequest({ ...navigation, resourceType: 'image' })).toBe('https://child.test/already-there')
  })

  it('is null when the session says nothing usable', () => {
    expect(documentOfRequest({ resourceType: 'script' })).toBeNull()
    expect(documentOfRequest({ resourceType: 'script', initiatorOrigin: 'null', frame: null })).toBeNull()
    expect(documentOfRequest({ resourceType: 'script', initiatorOrigin: 'null', frame: { url: '' } })).toBeNull()
    expect(documentOfRequest({ resourceType: 'script', initiatorOrigin: undefined, frame: { url: 'about:blank' } })).toBeNull()
  })

  it('does without the frame when Electron refuses to answer for it (a frame that went away), and says the document is unknown', () => {
    const gone = (initiatorOrigin?: string) => ({
      resourceType: 'script',
      initiatorOrigin,
      get frame(): never {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    })
    // A usable origin is enough: the frame is not even asked.
    expect(documentOfRequest(gone('https://news.test'))).toBe('https://news.test')
    // With no usable origin, the document is unknown (the caller falls back to the tab's page), and nothing throws.
    expect(documentOfRequest(gone())).toBeNull()
    expect(documentOfRequest(gone('null'))).toBeNull()
  })
})
