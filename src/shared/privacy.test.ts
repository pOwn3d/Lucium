import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { createInitialState, normalize, reduce, type Ctx } from './sidebar'
import {
  HTTPS_ONLY_EXCEPTIONS_MAX,
  HTTPS_UPGRADE_TIMEOUT_MS,
  NO_PRIVACY,
  anyPrivacy,
  cleanHttpsOnlyExceptions,
  cleanPrivacySettings,
  httpsFallbackNotice,
  httpsUpgradeOf,
  isTrackingParam,
  isUpgradableHost,
  privacyOptionsOf,
  rewriteNavigation,
  stripTrackingParams,
  trackingParamList,
  type PrivacyOptions
} from './privacy'
import { frenchSpaces } from './french-typography'
import { cleanBlockExceptions } from './blocker'

let counter = 0
const ctx: Ctx = { now: 0, newId: () => `id${++counter}` }

describe('the options', () => {
  it('are all on for a new profile (the protection « Renforcée »): HTTPS first, the signal, and the tracking parameters off the addresses opened and copied', () => {
    const settings = defaultSettings()
    expect(settings.httpsUpgrade).toBe(true)
    expect(settings.sendGpc).toBe(true)
    expect(settings.stripTrackingParams).toBe(true)
    expect(settings.stripCopiedLinks).toBe(true)
    expect(privacyOptionsOf(settings)).toEqual({ httpsUpgrade: true, globalPrivacyControl: true, stripTrackingParams: true, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [], trimReferer: false, httpsOnly: false, httpsOnlyExceptions: [] })
    expect(anyPrivacy(NO_PRIVACY)).toBe(false)
  })

  it('keep the value of a file saved before the default changed: HTTPS first stays off for a profile that had it off', () => {
    const saved = { ...createInitialState(ctx), settings: { ...defaultSettings(), httpsUpgrade: false } }
    expect(normalize(JSON.parse(JSON.stringify(saved))).settings.httpsUpgrade).toBe(false)
    expect(createInitialState(ctx).settings.httpsUpgrade).toBe(true)
  })

  it('count as on as soon as one of them is', () => {
    expect(anyPrivacy({ ...NO_PRIVACY, globalPrivacyControl: true })).toBe(true)
  })

  it('switch off in a damaged file: only a real true turns a rewrite on', () => {
    expect(cleanPrivacySettings({ httpsUpgrade: 'yes' as unknown as boolean, sendGpc: 1 as unknown as boolean, stripTrackingParams: true, stripCopiedLinks: 'oui' as unknown as boolean })).toEqual({ httpsUpgrade: false, sendGpc: false, stripTrackingParams: true, stripCopiedLinks: false, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [], blockPings: false, trimReferer: false, httpsOnly: false, httpsOnlyExceptions: [] })
    expect(cleanPrivacySettings({ stripCopiedLinks: true }).stripCopiedLinks).toBe(true)
  })

  it('keep the Referer, the pings and « HTTPS seul » off in a new profile and in a damaged file, and count the two the hooks read as on', () => {
    const settings = defaultSettings()
    expect([settings.blockPings, settings.trimReferer, settings.httpsOnly, settings.httpsOnlyExceptions]).toEqual([false, false, false, []])
    const damaged = cleanPrivacySettings({ blockPings: 'yes' as unknown as boolean, trimReferer: 1 as unknown as boolean, httpsOnly: 'true' as unknown as boolean, httpsOnlyExceptions: 'a.test' as unknown as string[] })
    expect([damaged.blockPings, damaged.trimReferer, damaged.httpsOnly, damaged.httpsOnlyExceptions]).toEqual([false, false, false, []])
    expect(cleanPrivacySettings({ blockPings: true, trimReferer: true, httpsOnly: true, httpsOnlyExceptions: ['a.test'] })).toMatchObject({ blockPings: true, trimReferer: true, httpsOnly: true, httpsOnlyExceptions: ['a.test'] })
    expect(anyPrivacy({ ...NO_PRIVACY, trimReferer: true })).toBe(true)
    expect(anyPrivacy({ ...NO_PRIVACY, httpsOnly: true })).toBe(true)
    expect(privacyOptionsOf({ trimReferer: true, httpsOnly: true, httpsOnlyExceptions: ['a.test'] })).toMatchObject({ trimReferer: true, httpsOnly: true, httpsOnlyExceptions: ['a.test'] })
  })

  it('bound the list of exceptions of « HTTPS seul » and keep valid hosts, each once', () => {
    const many = Array.from({ length: HTTPS_ONLY_EXCEPTIONS_MAX + 20 }, (_, i) => `site${i}.test`)
    expect(cleanHttpsOnlyExceptions(many)).toHaveLength(HTTPS_ONLY_EXCEPTIONS_MAX)
    expect(cleanHttpsOnlyExceptions(['a.test', 'A.test', 'http://b.test', 'not a host', 42, 'a.test'])).toEqual(cleanBlockExceptions(['a.test', 'A.test', 'http://b.test', 'not a host', 42, 'a.test']))
    expect(cleanHttpsOnlyExceptions(undefined)).toEqual([])
  })

  it('are kept by the reducer and cleaned there', () => {
    const state = createInitialState(ctx)
    const on = reduce(state, { type: 'settings/update', patch: { httpsUpgrade: true, sendGpc: true, stripTrackingParams: false } }, ctx)
    expect(privacyOptionsOf(on.settings)).toEqual({ httpsUpgrade: true, globalPrivacyControl: true, stripTrackingParams: false, blockThirdPartyCookies: false, thirdPartyCookieExceptions: [], trimReferer: false, httpsOnly: false, httpsOnlyExceptions: [] })
    const damaged = reduce(state, { type: 'settings/update', patch: { stripTrackingParams: 'x' as unknown as boolean } }, ctx)
    expect(damaged.settings.stripTrackingParams).toBe(false)
  })
})

describe('tracking parameters', () => {
  it.each(['utm_source', 'UTM_Medium', 'utm_campaign', 'fbclid', 'gclid', 'mc_eid', 'igshid', 'msclkid', 'yclid', '_hsenc', '_hsmi', 'mkt_tok', 'pk_campaign', 'dclid', 'gbraid'])('knows %s', (name) => {
    expect(isTrackingParam(name)).toBe(true)
  })

  it.each(['q', 'page', 'id', 'ref', 'source', 'utm', 'fb', 'campaign', 'v', 'tag'])('leaves %s alone: it can mean something to the page', (name) => {
    expect(isTrackingParam(name)).toBe(false)
  })

  it('knows Matomo’s campaign parameters by name, not every pk_ key (a page can need pk_live)', () => {
    expect(isTrackingParam('pk_kwd')).toBe(true)
    expect(isTrackingParam('pk_live')).toBe(false)
    expect(stripTrackingParams('https://exemple.fr/pay?pk_live=1&pk_campaign=x')).toBe('https://exemple.fr/pay?pk_live=1')
  })

  it('keeps every parameter that picks the page, the item or the language, whatever the list grows into', () => {
    const url = 'https://exemple.fr/watch?v=abc123&t=42s&list=PL1&page=2&q=chat+noir&lang=fr&id=7&ref=nav&source=feed&tag=a&sort=asc&redirect=%2Fhome'
    expect(stripTrackingParams(url)).toBeNull()
    expect(stripTrackingParams(`${url}&utm_medium=mail&fbclid=x`)).toBe(url)
  })

  it('lists its names for the documentation: exact names sorted, then the families', () => {
    const list = trackingParamList()
    expect(list).toContain('fbclid')
    expect(list).toContain('mc_eid')
    expect(list.at(-1)).toBe('utm_*')
    expect(list.slice(0, -1)).toEqual([...list.slice(0, -1)].sort())
    expect(list.slice(0, -1).every(isTrackingParam)).toBe(true)
  })

  it('removes them and keeps the other parameters, in order and as spelled', () => {
    expect(stripTrackingParams('https://exemple.fr/p?a=1&utm_source=nl&b=%2Fx+y&fbclid=zz&c')).toBe('https://exemple.fr/p?a=1&b=%2Fx+y&c')
  })

  it('drops the question mark when nothing is left, and keeps the fragment', () => {
    expect(stripTrackingParams('https://exemple.fr/p?gclid=1&utm_term=2#section')).toBe('https://exemple.fr/p#section')
  })

  it('returns null when there is nothing to remove, so the request is left alone', () => {
    expect(stripTrackingParams('https://exemple.fr/p?a=1&b=2')).toBeNull()
    expect(stripTrackingParams('https://exemple.fr/p')).toBeNull()
    expect(stripTrackingParams('https://exemple.fr/p?')).toBeNull()
  })

  it('reads an encoded name, and a name that is not valid encoding', () => {
    expect(stripTrackingParams('https://exemple.fr/?utm%5Fsource=a&k=1')).toBe('https://exemple.fr/?k=1')
    expect(stripTrackingParams('https://exemple.fr/?%E0%A4%A=1&utm_source=a')).toBe('https://exemple.fr/?%E0%A4%A=1')
  })

  it('only touches web addresses', () => {
    expect(stripTrackingParams('file:///tmp/a.html?utm_source=x')).toBeNull()
    expect(stripTrackingParams('pas une adresse?utm_source=x')).toBeNull()
  })
})

describe('HTTPS first', () => {
  it('upgrades a public http address, keeping path, query and fragment', () => {
    expect(httpsUpgradeOf('http://exemple.fr/a/b?c=1#d')).toBe('https://exemple.fr/a/b?c=1#d')
    expect(httpsUpgradeOf('http://exemple.fr:80/')).toBe('https://exemple.fr/')
  })

  it('leaves https and other schemes alone', () => {
    expect(httpsUpgradeOf('https://exemple.fr/')).toBeNull()
    expect(httpsUpgradeOf('file:///tmp/a.html')).toBeNull()
    expect(httpsUpgradeOf('ftp://exemple.fr/')).toBeNull()
  })

  it.each(['localhost', 'app.localhost', 'nas', 'imprimante.local', 'imprimante.local.', 'NAS.LAN', 'srv.internal', 'box.lan', 'routeur.home.arpa', '127.0.0.1', '10.0.0.5', '172.16.4.2', '172.31.255.255', '192.168.1.20', '169.254.1.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]'])(
    'never upgrades the local host %s',
    (host) => {
      expect(isUpgradableHost(host)).toBe(false)
      expect(httpsUpgradeOf(`http://${host}/`)).toBeNull()
    }
  )

  it.each(['exemple.fr', 'www.exemple.fr', 'exemple.fr.', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.255.255', '100.128.0.1', '[2001:db8::1]'])('upgrades the public host %s', (host) => {
    expect(isUpgradableHost(host)).toBe(true)
  })

  it('leaves an address with a port other than 80, or with a login', () => {
    expect(httpsUpgradeOf('http://exemple.fr:8080/')).toBeNull()
    expect(httpsUpgradeOf('http://moi:secret@exemple.fr/')).toBeNull()
  })

  it('words the notice for the page that stayed on http', () => {
    expect(httpsFallbackNotice('exemple.fr')).toBe(frenchSpaces('exemple.fr ne répond pas en HTTPS : la page s’ouvre en HTTP, sans chiffrement.'))
    expect(HTTPS_UPGRADE_TIMEOUT_MS).toBeGreaterThan(1000)
  })
})

describe('rewriteNavigation', () => {
  it('upgrades an http address in « HTTPS seul » as HTTPS first does, with HTTPS first off', () => {
    const only = { ...NO_PRIVACY, httpsOnly: true }
    expect(rewriteNavigation({ url: 'http://exemple.fr/a', method: 'GET', isMainFrame: true }, only, (u) => u.replace('http:', 'https:'))).toBe('https://exemple.fr/a')
    expect(rewriteNavigation({ url: 'http://exemple.fr/a', method: 'GET', isMainFrame: true }, NO_PRIVACY, (u) => u.replace('http:', 'https:'))).toBeNull()
  })

  const all: PrivacyOptions = { ...NO_PRIVACY, httpsUpgrade: true, globalPrivacyControl: true, stripTrackingParams: true }
  const accept = (url: string) => url.replace('http:', 'https:')
  const nav = (url: string, patch: Partial<{ method: string; isMainFrame: boolean }> = {}) => ({ url, method: 'GET', isMainFrame: true, ...patch })

  it('does nothing with every option off', () => {
    expect(rewriteNavigation(nav('http://exemple.fr/?utm_source=a'), NO_PRIVACY, accept)).toBeNull()
  })

  it('strips the parameters only when asked', () => {
    expect(rewriteNavigation(nav('https://exemple.fr/?utm_source=a&k=1'), { ...NO_PRIVACY, stripTrackingParams: true }, accept)).toBe('https://exemple.fr/?k=1')
    expect(rewriteNavigation(nav('https://exemple.fr/?utm_source=a&k=1'), { ...NO_PRIVACY, httpsUpgrade: true }, accept)).toBeNull()
  })

  it('upgrades only when asked, through the caller’s decision', () => {
    expect(rewriteNavigation(nav('http://exemple.fr/'), { ...NO_PRIVACY, httpsUpgrade: true }, accept)).toBe('https://exemple.fr/')
    expect(rewriteNavigation(nav('http://exemple.fr/'), { ...NO_PRIVACY, httpsUpgrade: true }, () => null)).toBeNull()
    expect(rewriteNavigation(nav('http://exemple.fr/'), { ...NO_PRIVACY, stripTrackingParams: true }, accept)).toBeNull()
  })

  it('strips, then upgrades the cleaned address, in one rewrite', () => {
    const seen: string[] = []
    const result = rewriteNavigation(nav('http://exemple.fr/p?fbclid=1&a=2'), all, (url) => (seen.push(url), accept(url)))
    expect(result).toBe('https://exemple.fr/p?a=2')
    expect(seen).toEqual(['http://exemple.fr/p?a=2'])
  })

  it('returns the stripped address when the upgrade is refused (a loop, a local host)', () => {
    expect(rewriteNavigation(nav('http://exemple.fr/p?fbclid=1&a=2'), all, () => null)).toBe('http://exemple.fr/p?a=2')
  })

  it('leaves what is not the document of a tab, or not a plain GET', () => {
    expect(rewriteNavigation(nav('http://exemple.fr/?utm_source=a', { isMainFrame: false }), all, accept)).toBeNull()
    expect(rewriteNavigation(nav('http://exemple.fr/?utm_source=a', { method: 'POST' }), all, accept)).toBeNull()
  })

  it('ends: a rewritten address is left alone the next time', () => {
    const first = rewriteNavigation(nav('http://exemple.fr/p?gclid=1'), all, (url) => httpsUpgradeOf(url))!
    expect(first).toBe('https://exemple.fr/p')
    expect(rewriteNavigation(nav(first), all, (url) => httpsUpgradeOf(url))).toBeNull()
  })
})
