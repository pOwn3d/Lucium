import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { COOKIE_KEEP_HOSTS_MAX, COOKIE_NAMES_MAX, COOKIE_SITES_MAX, cleanKeepHosts, cookieNamesOf, cookiesToClean, describeCookieCount, describeCookieOutcome, describeCookieRemoval, describeCookieTotals, formatBytes, groupCookieSites, isCookieKept, isSiteKept, keepHostOf, parseCookieSite, siteOfCookie, withKeptSite, type CookieEntry } from './cookies'
import { frenchSpaces } from './french-typography'

const cookie = (domain: string, name: string, over: Partial<CookieEntry> = {}): CookieEntry => ({ domain, name, path: '/', secure: true, session: false, hostOnly: !domain.startsWith('.'), size: name.length + 10, ...over })

describe('the cookies grouped by site', () => {
  it('counts and sizes each site, the leading dot of a domain cookie ignored, most cookies first', () => {
    const sites = groupCookieSites([cookie('.exemple.org', 'a'), cookie('exemple.org', 'bb'), cookie('autre.net', 'c'), cookie('.exemple.org', 'd'), cookie('www.exemple.org', 'e')])
    expect(sites).toEqual([
      { host: 'exemple.org', count: 3, bytes: 11 + 12 + 11 },
      { host: 'autre.net', count: 1, bytes: 11 },
      { host: 'www.exemple.org', count: 1, bytes: 11 }
    ])
  })

  it('carries at most COOKIE_SITES_MAX sites to the window, leaving out the smallest ones', () => {
    const padded = (i: number) => `s${String(i).padStart(4, '0')}.example`
    const jar = [...Array.from({ length: COOKIE_SITES_MAX + 10 }, (_, i) => cookie(padded(i), 'a')), cookie('zz.example', 'a'), cookie('zz.example', 'b')]
    const sites = groupCookieSites(jar)
    expect(sites).toHaveLength(COOKIE_SITES_MAX)
    // The site with the most cookies leads although it came last; past the bound, the sites with one cookie each go in the order of their names.
    expect(sites[0]).toEqual({ host: 'zz.example', count: 2, bytes: 22 })
    expect(sites.at(-1)!.host).toBe(padded(COOKIE_SITES_MAX - 2))
  })

  it('ignores a cookie with no domain and never reports a negative size', () => {
    expect(groupCookieSites([cookie('', 'x'), cookie('a.example', 'y', { size: -5 })])).toEqual([{ host: 'a.example', count: 1, bytes: 0 }])
  })

  it('names the cookies of a site without their values (the entry has none to give)', () => {
    const names = cookieNamesOf([cookie('.exemple.org', 'zeta'), cookie('exemple.org', 'alpha', { path: '/b' }), cookie('exemple.org', 'alpha', { path: '/a' }), cookie('autre.net', 'q')], 'exemple.org')
    expect(names.map((n) => `${n.name}${n.path}`)).toEqual(['alpha/a', 'alpha/b', 'zeta/'])
    expect(Object.keys(names[0]!).sort()).toEqual(['name', 'path', 'secure', 'session', 'size'])
    expect(cookieNamesOf(Array.from({ length: COOKIE_NAMES_MAX + 50 }, (_, i) => cookie('big.example', `c${i}`)), 'big.example')).toHaveLength(COOKIE_NAMES_MAX)
  })

  it('reads a site from the interface only as a plain host', () => {
    expect(parseCookieSite('Exemple.ORG')).toBe('exemple.org')
    expect(parseCookieSite('[::1]')).toBe('::1')
    expect(siteOfCookie('.Exemple.org')).toBe('exemple.org')
    for (const bad of ['exemple.org:8080', 'https://exemple.org', 'a b', '', 7, null, '../x']) expect(parseCookieSite(bad)).toBeNull()
  })
})

describe('the sites to keep', () => {
  it('are valid hosts, each once, bounded, and nothing else', () => {
    expect(cleanKeepHosts(['https://www.Exemple.org/page', 'exemple.org', 'autre.net', 'not a host', 12, null])).toEqual(['exemple.org', 'autre.net'])
    expect(cleanKeepHosts('x')).toEqual([])
    expect(cleanKeepHosts(Array.from({ length: COOKIE_KEEP_HOSTS_MAX + 20 }, (_, i) => `site${i}.example`))).toHaveLength(COOKIE_KEEP_HOSTS_MAX)
  })

  it('add and remove a site, a bad one changing nothing', () => {
    expect(withKeptSite([], 'www.exemple.org', true)).toEqual(['exemple.org'])
    expect(withKeptSite(['exemple.org', 'autre.net'], 'exemple.org', false)).toEqual(['autre.net'])
    expect(withKeptSite(['exemple.org'], '??', true)).toEqual(['exemple.org'])
    expect(keepHostOf('http://www.a.example/x')).toBe('a.example')
    expect(isSiteKept('mail.exemple.org', ['exemple.org'])).toBe(true)
    expect(isSiteKept('exemple.org.evil.net', ['exemple.org'])).toBe(false)
  })
})

describe('the clean-up', () => {
  const jar = [cookie('.exemple.org', 'session-id'), cookie('mail.exemple.org', 'mail'), cookie('autre.net', 'pub'), cookie('.tiers.com', 'pixel'), cookie('exemple.org.evil.net', 'trap')]

  it('spares the listed sites, their subdomains and the parent-domain cookies they are sent', () => {
    const kept = (host: string) => jar.filter((c) => isCookieKept(c, [host])).map((c) => c.name)
    expect(kept('exemple.org')).toEqual(['session-id', 'mail'])
    // The cookie of the parent domain is sent to the listed subdomain: removing it would sign the user out of the site that is kept.
    expect(kept('mail.exemple.org')).toEqual(['session-id', 'mail'])
    expect(kept('autre.net')).toEqual(['pub'])
  })

  it('removes every other cookie, and all of them when the list is empty', () => {
    expect(cookiesToClean(jar, ['exemple.org']).map((c) => c.name)).toEqual(['pub', 'pixel', 'trap'])
    expect(cookiesToClean(jar, [])).toHaveLength(jar.length)
  })

  it('never takes a look-alike domain for a listed site', () => {
    expect(isCookieKept(cookie('exemple.org.evil.net', 'x'), ['exemple.org'])).toBe(false)
    expect(isCookieKept(cookie('evilexemple.org', 'x'), ['exemple.org'])).toBe(false)
  })
})

describe('the words', () => {
  it('sizes and counts', () => {
    expect(formatBytes(512)).toBe(frenchSpaces('512 o'))
    expect(formatBytes(2048)).toBe(frenchSpaces('2,0 Ko'))
    expect(formatBytes(3 * 1024 * 1024)).toBe(frenchSpaces('3,0 Mo'))
    expect(describeCookieCount(0)).toBe('aucun cookie')
    expect(describeCookieCount(1)).toBe('1 cookie')
    expect(describeCookieCount(4)).toBe('4 cookies')
    expect(describeCookieRemoval(0, 'site')).toBe('Aucun cookie à retirer.')
    expect(describeCookieRemoval(1, 'site')).toBe('1 cookie retiré.')
    expect(describeCookieRemoval(3, 'site')).toBe('3 cookies retirés.')
    expect(describeCookieRemoval(1, 'clean')).toBe(frenchSpaces('1 cookie retiré ; les sites gardés n’ont pas été touchés.'))
    expect(describeCookieRemoval(3, 'clean')).toBe(frenchSpaces('3 cookies retirés ; les sites gardés n’ont pas été touchés.'))
  })

  it('agrees the cookies that could not be removed with their number', () => {
    expect(describeCookieOutcome(3, 0, 'site')).toBe(describeCookieRemoval(3, 'site'))
    expect(describeCookieOutcome(3, 1, 'site')).toBe(`${describeCookieRemoval(3, 'site')} 1 n’a pas pu l’être.`)
    expect(describeCookieOutcome(3, 2, 'clean')).toBe(`${describeCookieRemoval(3, 'clean')} 2 n’ont pas pu l’être.`)
  })

  it('counts the cookies and their sites in a sentence that starts with a number, and says nothing of a profile with no cookie', () => {
    expect(describeCookieTotals(12, 3)).toBe('12 cookies sur 3 sites.')
    expect(describeCookieTotals(1, 1)).toBe('1 cookie sur 1 site.')
    expect(describeCookieTotals(0, 0)).toBe('')
  })

  it('are those of the interface’s language', () => {
    setLanguage('en')
    try {
      expect([formatBytes(512), formatBytes(2048), formatBytes(3 * 1024 * 1024)]).toEqual(['512 B', '2.0 KB', '3.0 MB'])
      expect([describeCookieCount(0), describeCookieCount(1), describeCookieCount(4)]).toEqual(['no cookies', '1 cookie', '4 cookies'])
      expect(describeCookieRemoval(1, 'site')).toBe('1 cookie removed.')
      expect(describeCookieRemoval(3, 'clean')).toBe('3 cookies removed; kept sites weren’t touched.')
    } finally {
      setLanguage('fr')
    }
  })
})
