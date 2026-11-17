import { describe, expect, it } from 'vitest'
import { DEFAULT_SEARCH_URL } from './model'
import { createInitialState, reduce, type Ctx } from './sidebar'
import { isInternalPageUrl } from './internal-page'
import { CONNECTION_MARKS, addressLabel, connectionState, saysNotSecure, hostOf, hostnameOf, isNavigableUrl, isTypedAddress, isViewSourceUrl, logOrigin, matchesHost, resolveInput, urlHostname } from './url'

const resolve = (input: string) => resolveInput(input, DEFAULT_SEARCH_URL)

describe('resolveInput', () => {
  it('keeps full http(s) URLs as they are', () => {
    expect(resolve('https://example.com/a?b=1')).toEqual({ kind: 'url', url: 'https://example.com/a?b=1' })
  })

  it('adds https:// to bare domains', () => {
    expect(resolve('example.com/path')).toEqual({ kind: 'url', url: 'https://example.com/path' })
  })

  it('treats localhost and IPs as http, port included', () => {
    expect(resolve('localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000' })
    expect(resolve('192.168.1.10:8080/x')).toEqual({ kind: 'url', url: 'http://192.168.1.10:8080/x' })
  })

  it('searches for anything else, encoding the query', () => {
    expect(resolve('chat gpt & co')).toEqual({ kind: 'search', url: 'https://duckduckgo.com/?q=chat%20gpt%20%26%20co' })
  })

  it('never navigates to javascript:, data: or other non-web schemes', () => {
    for (const input of ['javascript://%0Aalert(1)', 'data://text/html,hi', 'chrome://settings', 'ftp://host/file']) {
      expect(resolve(input)?.kind).toBe('search')
    }
  })

  it('returns null on empty input', () => {
    expect(resolve('   ')).toBeNull()
  })

  it('searches for what only looks like an address and is none once its scheme is put before it', () => {
    for (const input of ['javascript:x.com', 'x.com:99999', 'localhost:99999', '127.0.0.1:70000/x']) expect(resolve(input)?.kind, input).toBe('search')
  })

  it('keeps an address typed with its scheme that cannot be read as an address, which no page may load (the caller tells the user)', () => {
    for (const input of ['http://exa mple.com', 'http://[::1', 'http://x.com:99999', 'https://a%00b']) {
      const resolved = resolve(input)
      expect(resolved?.kind, input).toBe('url')
      expect(isNavigableUrl(resolved!.url), input).toBe(false)
    }
  })
})

describe('isTypedAddress', () => {
  it('follows resolveInput: whatever the bar would open is an address, whatever it would search for is words', () => {
    for (const typed of ['example.com', 'intranet.corp/page', 'localhost:3000', '10.0.0.1', 'about:blank', 'file:///tmp/a.html']) expect(isTypedAddress(typed), typed).toBe(true)
    for (const typed of ['planète', 'comment ouvrir example.com', 'javascript: void', 'a.b']) expect(isTypedAddress(typed), typed).toBe(false)
  })

  it('counts a link of a scheme the browser does not open as an address too (it is no search)', () => {
    expect(resolveInput('ftp://files.example.org', DEFAULT_SEARCH_URL)?.kind).toBe('search')
    expect(isTypedAddress('ftp://files.example.org')).toBe(true)
    expect(isTypedAddress('myapp://open?id=1')).toBe(true)
  })
})

describe('isNavigableUrl', () => {
  it('accepts web, file and about:blank only', () => {
    expect(isNavigableUrl('https://a.fr')).toBe(true)
    expect(isNavigableUrl('file:///tmp/x.html')).toBe(true)
    expect(isNavigableUrl('about:blank')).toBe(true)
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false)
    expect(isNavigableUrl('chrome-error://chromewebdata/')).toBe(false)
    expect(isNavigableUrl('not a url')).toBe(false)
  })
})

describe('logOrigin', () => {
  it('keeps the scheme and the host, and nothing a token or a private name could be in', () => {
    expect(logOrigin('https://user:pass@files.example.com:8443/a/b.pdf?token=SECRET&x=1#frag')).toBe('https://files.example.com:8443')
    expect(logOrigin('http://localhost:3000/private/report?id=42')).toBe('http://localhost:3000')
  })

  it('says only the scheme of an address with no host, and that a text is not an address', () => {
    expect(logOrigin('data:text/plain;base64,U0VDUkVU')).toBe('data:')
    expect(logOrigin('blob:https://example.com/0b2b-uuid')).toBe('blob:')
    expect(logOrigin('pas une adresse')).toBe('(not an address)')
    expect(logOrigin('')).toBe('(not an address)')
  })
})

describe('hostOf', () => {
  it('strips www and tolerates garbage', () => {
    expect(hostOf('https://www.example.com/x')).toBe('example.com')
    expect(hostOf('pas une url')).toBe('')
  })
})

// The three names of a host, side by side: hostOf keeps the port, hostnameOf drops it, both drop "www."; urlHostname keeps "www." too.
describe('urlHostname', () => {
  it('is the hostname the parser gives: no port, "www." kept, lower case and punycode for the web', () => {
    expect(urlHostname('https://www.Example.com:8443/x?q=1')).toBe('www.example.com')
    expect(urlHostname('http://localhost:3000/app')).toBe('localhost')
    expect(urlHostname('https://café.example/')).toBe('xn--caf-dma.example')
    expect(hostOf('https://www.example.com:8443/x')).toBe('example.com:8443')
    expect(hostnameOf('https://www.example.com:8443/x')).toBe('example.com')
  })

  it('is empty for what does not parse, and for an address without a host', () => {
    expect(urlHostname('pas une url')).toBe('')
    expect(urlHostname('')).toBe('')
    expect(urlHostname('about:blank')).toBe('')
  })
})

describe('host matching for Tweaks', () => {
  it('ignores the port and www, so a boost on localhost reaches localhost:3000', () => {
    expect(hostnameOf('http://localhost:3000/app')).toBe('localhost')
    expect(hostnameOf('https://www.example.com/x')).toBe('example.com')
    expect(matchesHost('localhost', 'http://localhost:3000/app')).toBe(true)
  })

  it('matches subdomains but not look-alike hosts', () => {
    expect(matchesHost('example.com', 'https://docs.example.com/')).toBe(true)
    expect(matchesHost('example.com', 'https://notexample.com/')).toBe(false)
    expect(matchesHost('example.com', 'https://example.com.evil.io/')).toBe(false)
  })

  it('never matches an unparseable URL', () => {
    expect(matchesHost('example.com', 'pas une url')).toBe(false)
  })
})

describe('view-source addresses', () => {
  it('are those of a web page only; the command bar and links still cannot navigate to them', () => {
    expect(isViewSourceUrl('view-source:https://example.com/a?b=1')).toBe(true)
    expect(isViewSourceUrl('view-source:http://localhost:3000/')).toBe(true)
    for (const bad of ['view-source:file:///etc/passwd', 'view-source:javascript:alert(1)', 'view-source:', 'https://example.com', 'view-source:https://a b']) expect(isViewSourceUrl(bad), bad).toBe(false)
    expect(isNavigableUrl('view-source:https://example.com/')).toBe(false)
    expect(resolveInput('view-source:https://example.com/', DEFAULT_SEARCH_URL)?.kind).toBe('search')
  })

  it('open in a tab through tab/open, and nothing else that is not a web address does', () => {
    const ctx: Ctx = { now: 1, newId: () => 'tab1' }
    const start = createInitialState(ctx)
    expect(reduce(start, { type: 'tab/open', url: 'view-source:https://example.com/' }, ctx).tabs.map((t) => t.url)).toEqual(['view-source:https://example.com/'])
    expect(reduce(start, { type: 'tab/open', url: 'view-source:file:///etc/passwd' }, ctx).tabs).toEqual([])
  })
})

describe('saysNotSecure', () => {
  it('is true for a page that came over http from another machine, and for a certificate let through on any host', () => {
    for (const url of ['http://exemple.fr/', 'view-source:http://exemple.fr/', 'http://192.168.1.20:8080/', 'http://localhost.evil.example/']) expect(saysNotSecure(url), url).toBe(true)
    for (const url of ['https://exemple.fr/', 'https://localhost:8443/']) expect(saysNotSecure(url, true), url).toBe(true)
  })

  it('is false for a secure page, a page with no connection, and a page this very machine serves in plain http', () => {
    for (const url of ['https://exemple.fr/', 'file:///Users/moi/page.html', 'about:blank', 'pas une adresse']) expect(saysNotSecure(url), url).toBe(false)
    for (const url of ['http://localhost/', 'http://LOCALHOST:3000/a', 'http://127.0.0.1:8080/', 'http://127.8.9.1/', 'http://[::1]:5173/', 'http://app.localhost/', 'view-source:http://localhost/']) expect(saysNotSecure(url), url).toBe(false)
  })
})

describe('addressLabel', () => {
  it('is the host of a web page, and what the address itself says for an address that has none', () => {
    expect(addressLabel('https://www.exemple.fr/a?b#c')).toBe('exemple.fr')
    expect(addressLabel('http://localhost:3000/')).toBe('localhost:3000')
    expect(addressLabel('about:blank')).toBe('about:blank')
    expect(addressLabel('file:///Users/moi/Mes%20pages/page.html')).toBe('page.html')
    expect(addressLabel('file:///')).toBe('file:')
    expect(addressLabel('data:text/html,<title>accounts.example.com</title>')).toBe('data:')
    expect(addressLabel('blob:https://exemple.fr/0a1b')).toBe('blob:')
    expect(addressLabel('')).toBe('')
    expect(addressLabel('pas une adresse')).toBe('')
  })
})

describe('connectionState', () => {
  it('is secure for https: and a warning for http:, whatever the case of the scheme, the port or the host', () => {
    for (const url of ['https://example.com/', 'HTTPS://EXAMPLE.COM/a?b=1#c', 'https://localhost:8443/']) expect(connectionState(url), url).toBe('secure')
    for (const url of ['http://example.com/', 'HTTP://EXAMPLE.COM', 'http://localhost:3000/', 'http://192.168.1.10:8080/x']) expect(connectionState(url), url).toBe('insecure')
  })

  it('judges nothing for a page that has no connection: a file, about:blank, a page of an extension, data:, our own error page, an empty or half-typed address', () => {
    const urls = ['file:///Users/me/notes.html', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'data:text/html,hi', 'lucium-error:retry?n=1', 'blob:https://example.com/1234', '', 'exemple', 'http//oops']
    for (const url of urls) expect(connectionState(url), url).toBe('none')
  })

  it('is a warning for an https page shown over a certificate let through although it was not valid: never a padlock', () => {
    for (const url of ['https://app.local:8443/', 'https://192.168.1.1/', 'view-source:https://app.local/']) expect(connectionState(url, true), url).toBe('insecure')
    // http is a warning either way; a page with no connection stays one.
    expect(connectionState('http://app.local/', true)).toBe('insecure')
    expect(connectionState('file:///a.html', true)).toBe('none')
    expect(connectionState('https://app.local/', false)).toBe('secure')
  })

  it('judges the source of a page by the page it shows', () => {
    expect(connectionState('view-source:https://example.com/')).toBe('secure')
    expect(connectionState('view-source:http://example.com/')).toBe('insecure')
    expect(connectionState('view-source:file:///etc/hosts')).toBe('none')
    expect(connectionState('view-source:')).toBe('none')
  })

  it('has a mark for each state, and the warning sign is the mark of http: alone', () => {
    expect(CONNECTION_MARKS.insecure).toBe('⚠')
    expect(new Set(Object.values(CONNECTION_MARKS)).size).toBe(3)
    expect(CONNECTION_MARKS[connectionState('file:///a.html')]).not.toBe(CONNECTION_MARKS.insecure)
    expect(CONNECTION_MARKS[connectionState('about:blank')]).not.toBe(CONNECTION_MARKS.secure)
  })
})

describe('the Extensions page, at lucium-ui://extensions/', () => {
  const page = 'lucium-ui://extensions/'

  it('is no address a person can type or a page can open: what the command bar resolves it to is a search', () => {
    for (const input of [page, 'lucium-ui://extensions', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui://extensions/shortcuts']) {
      expect(resolve(input)?.kind, input).toBe('search')
      expect(isNavigableUrl(input), input).toBe(false)
      expect(isTypedAddress(input), input).toBe(true)
    }
  })

  it('has no host, so that nothing kept by site (zoom, permissions, boosts) is shared with a site of a local network that is called extensions', () => {
    expect(hostOf(page)).toBe('')
    expect(hostOf('lucium-ui://extensions/?id=x')).toBe('')
    expect(hostnameOf(page)).toBe('')
    expect(urlHostname(page)).toBe('')
    expect(matchesHost('extensions', page)).toBe(false)
    expect(hostOf('http://extensions/')).toBe('extensions')
    expect(hostnameOf('http://extensions/')).toBe('extensions')
    expect(urlHostname('http://extensions/')).toBe('extensions')
    // An address that only looks like the page is read like any address.
    expect(hostOf('lucium-ui://extensions@evil/')).toBe('evil')
    expect(hostnameOf('lucium-ui://extensions@evil/')).toBe('evil')
    expect(hostOf('lucium-ui://extensions.evil.com/')).toBe('extensions.evil.com')
  })

  it('is said chrome://extensions where an address is read, and claims no connection', () => {
    expect(addressLabel(page)).toBe('chrome://extensions')
    expect(addressLabel('lucium-ui://extensions/shortcuts')).toBe('chrome://extensions')
    expect(addressLabel('lucium-ui://extensions@evil/')).toBe('evil')
    expect(connectionState(page)).toBe('none')
    expect(saysNotSecure(page)).toBe(false)
    expect(isInternalPageUrl(page)).toBe(true)
  })
})
