import { describe, expect, it } from 'vitest'
import { cleanSafeBrowsingSettings, hostToCheck, safeVerdict, type SafeLists } from './safe-browsing'

const lists: SafeLists = {
  phishing: { has: (host) => ['phish.example', 'sites.host.test'].includes(host) },
  malware: { has: (host) => ['malware.example', '203.0.113.7'].includes(host) }
}

describe('which addresses are looked at', () => {
  it('takes the host of a web address, lower-cased, without its final dot', () => {
    expect(hostToCheck('https://Phish.Example./a?b=1')).toBe('phish.example')
    expect(hostToCheck('http://203.0.113.7:8080/x')).toBe('203.0.113.7')
  })

  it('leaves the internal pages, files, local names and local hosts alone', () => {
    for (const url of ['lucium://settings', 'file:///tmp/a.html', 'about:blank', 'http://localhost:3000/', 'http://nas.local/', 'http://[::1]/', 'not an address', 'javascript:alert(1)']) expect(hostToCheck(url), url).toBeNull()
  })
})

describe('the verdict', () => {
  it('names the kind of danger and the host for a listed address', () => {
    expect(safeVerdict('https://phish.example/login', lists, [])).toEqual({ category: 'phishing', host: 'phish.example' })
    expect(safeVerdict('http://203.0.113.7/a.exe', lists, [])).toEqual({ category: 'malware', host: '203.0.113.7' })
  })

  it('compares the host exactly: not its parent, not its subdomains', () => {
    expect(safeVerdict('https://host.test/', lists, [])).toBeNull()
    expect(safeVerdict('https://www.phish.example/', lists, [])).toBeNull()
    expect(safeVerdict('https://sites.host.test/', lists, [])).not.toBeNull()
  })

  it('never reports a site the user excepted, nor its subdomains', () => {
    expect(safeVerdict('https://phish.example/', lists, ['phish.example'])).toBeNull()
    expect(safeVerdict('https://a.phish.example/', { ...lists, phishing: { has: () => true } }, ['phish.example'])).toBeNull()
    expect(safeVerdict('https://phish.example/', lists, ['other.example'])).not.toBeNull()
  })

  it('never reports a host let through for this session', () => {
    expect(safeVerdict('https://phish.example/', lists, [], new Set(['phish.example']))).toBeNull()
  })

  it('reports nothing for an internal page or when a list is missing', () => {
    expect(safeVerdict('lucium://phish.example/', lists, [])).toBeNull()
    expect(safeVerdict('https://phish.example/', { phishing: null, malware: null }, [])).toBeNull()
  })
})

describe('the settings of a saved file', () => {
  it('is off unless the value is true, and keeps valid sites only', () => {
    expect(cleanSafeBrowsingSettings({ safeBrowsing: 'yes' as never, safeBrowsingExceptions: 'x' as never })).toEqual({ safeBrowsing: false, safeBrowsingExceptions: [] })
    expect(cleanSafeBrowsingSettings({ safeBrowsing: true, safeBrowsingExceptions: ['Exemple.org', 'exemple.org', '??', 3 as never] })).toEqual({ safeBrowsing: true, safeBrowsingExceptions: ['exemple.org'] })
    expect(cleanSafeBrowsingSettings({ safeBrowsingExceptions: Array.from({ length: 300 }, (_, i) => `s${i}.example`) }).safeBrowsingExceptions).toHaveLength(200)
  })
})
