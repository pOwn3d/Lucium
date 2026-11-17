import { describe, expect, it } from 'vitest'
import { createInitialState, normalize, reduce } from './sidebar'
import {
  DEFAULT_SITE_DATA_TYPES,
  ENGINE_SITE_DATA_TYPES,
  SITE_DATA_HOSTS_MAX,
  SITE_DATA_LABELS,
  SITE_DATA_RECENTS_MAX,
  SITE_DATA_TYPES,
  allSitesCleared,
  cleanSiteDataTypes,
  cookieBelongsToSite,
  describeSiteDataResult,
  hostBelongsToSite,
  isEngineSiteDataType,
  normalizeSiteDataPrefs,
  describeSiteDataNotice,
  parseSiteDataBatchRequest,
  parseSiteHost,
  quickClearRequest,
  rememberSiteHosts,
  reloadTarget,
  sessionStorageScript,
  siteHostOf,
  siteOrigins,
  siteScore,
  splitSiteHosts
} from './site-data'
import { frenchSpaces } from './french-typography'

describe('parseSiteHost', () => {
  it('accepts domains, localhost, single-label names and IPs, each with an optional port', () => {
    for (const ok of ['example.com', 'www.example.co.uk', 'localhost', 'localhost:3000', '127.0.0.1', '192.168.1.20:8080', 'a-b.example.org:443', 'nas', 'myapp:3000', 'xn--bcher-kva.example', 'sub.xn--p1ai', '[::1]', '[::1]:3000']) {
      expect(parseSiteHost(ok), ok).not.toBeNull()
    }
  })

  it('refuses what is not a host, so nothing odd is ever turned into an origin', () => {
    const bad = [
      '',
      ' example.com',
      'exa mple.com',
      'example.com/path',
      'https://example.com',
      'example.com:99999',
      'example.com:0',
      'example.com:',
      'example..com',
      '-example.com',
      'example-.com',
      'example.c',
      'example.123',
      '999.1.1.1',
      '1.2.3',
      '127.1',
      '0x7f',
      '127',
      '010.0.0.1',
      'a,b.com',
      'a.com, b.com',
      'x@example.com',
      '[::1',
      '[zz]',
      '[1]'
    ]
    for (const input of bad) expect(parseSiteHost(input), input).toBeNull()
    expect(parseSiteHost(undefined)).toBeNull()
    expect(parseSiteHost(42)).toBeNull()
    expect(parseSiteHost('a'.repeat(64) + '.com')).toBeNull()
  })

  it('returns the canonical host, the port and what kind of host it is', () => {
    expect(parseSiteHost('Example.COM:8443')).toEqual({ host: 'example.com:8443', hostname: 'example.com', port: 8443, kind: 'domain' })
    expect(parseSiteHost('127.0.0.1:80')).toEqual({ host: '127.0.0.1:80', hostname: '127.0.0.1', port: 80, kind: 'ip' })
    expect(parseSiteHost('[0:0:0:0:0:0:0:1]:3000')).toMatchObject({ host: '[::1]:3000', kind: 'ip' })
  })
})

describe('siteHostOf', () => {
  it('takes the host of a pasted web address and keeps a bare host as typed', () => {
    expect(siteHostOf('https://www.Example.com/a/b?q=1#x')).toBe('www.example.com')
    expect(siteHostOf('http://localhost:3000/app')).toBe('localhost:3000')
    expect(siteHostOf('  Example.com ')).toBe('example.com')
    expect(siteHostOf('localhost:3000')).toBe('localhost:3000')
  })

  it('keeps what is not a whole web address as typed, which parseSiteHost then refuses', () => {
    for (const typed of ['https://', 'http:/', 'chrome-extension://abcdef/popup.html', 'file:///etc/hosts']) {
      expect(siteHostOf(typed)).toBe(typed)
      expect(parseSiteHost(siteHostOf(typed)), typed).toBeNull()
    }
  })
})

describe('siteOrigins', () => {
  it('lists the https and http origins of the site, with its port', () => {
    expect(siteOrigins('example.com')).toEqual(['https://example.com', 'http://example.com'])
    expect(siteOrigins('localhost:3000')).toEqual(['https://localhost:3000', 'http://localhost:3000'])
    expect(siteOrigins('127.0.0.1:8080')).toEqual(['https://127.0.0.1:8080', 'http://127.0.0.1:8080'])
  })

  it('writes an origin the way the browser does, whatever the case or default port', () => {
    expect(siteOrigins('Example.com:443')).toEqual(['https://example.com', 'http://example.com:443'])
  })

  it('gives no origin for an invalid host', () => {
    expect(siteOrigins('example.com/evil')).toEqual([])
    expect(siteOrigins('')).toEqual([])
  })

  it('only adds subdomains when asked, and only the known ones of this site', () => {
    const known = ['a.example.com', 'b.a.example.com', 'example.com', 'badexample.com', 'a.example.com:8080', 'other.org', 'example.com.evil.org', 'not a host']
    expect(siteOrigins('example.com', { knownHosts: known })).toEqual(['https://example.com', 'http://example.com'])
    expect(siteOrigins('example.com', { subdomains: true, knownHosts: known })).toEqual([
      'https://example.com',
      'http://example.com',
      'https://a.example.com',
      'http://a.example.com',
      'https://b.a.example.com',
      'http://b.a.example.com'
    ])
  })

  it('keeps the port of the site when it looks for subdomains', () => {
    expect(siteOrigins('example.com:8080', { subdomains: true, knownHosts: ['a.example.com:8080', 'a.example.com', 'b.example.com:9090'] })).toEqual([
      'https://example.com:8080',
      'http://example.com:8080',
      'https://a.example.com:8080',
      'http://a.example.com:8080'
    ])
  })

  it('never invents subdomains of an IP address', () => {
    expect(siteOrigins('127.0.0.1', { subdomains: true, knownHosts: ['a.127.0.0.1', '127.0.0.1'] })).toEqual(['https://127.0.0.1', 'http://127.0.0.1'])
  })
})

describe('hostBelongsToSite', () => {
  it('matches the exact host, the port included', () => {
    expect(hostBelongsToSite('example.com', 'example.com', false)).toBe(true)
    expect(hostBelongsToSite('example.com:8080', 'example.com', false)).toBe(false)
    expect(hostBelongsToSite('www.example.com', 'example.com', false)).toBe(false)
  })

  it('matches subdomains only when asked', () => {
    expect(hostBelongsToSite('www.example.com', 'example.com', true)).toBe(true)
    expect(hostBelongsToSite('badexample.com', 'example.com', true)).toBe(false)
    expect(hostBelongsToSite('example.com', 'www.example.com', true)).toBe(false)
  })
})

describe('cookieBelongsToSite', () => {
  it('takes the cookies the site sends: its own, and those set for a parent domain', () => {
    expect(cookieBelongsToSite({ domain: 'www.example.com', hostOnly: true }, 'www.example.com', false)).toBe(true)
    expect(cookieBelongsToSite({ domain: '.example.com' }, 'www.example.com', false)).toBe(true)
    expect(cookieBelongsToSite({ domain: '.example.com' }, 'example.com:8080', false)).toBe(true)
  })

  it('leaves the cookies of other hosts alone, including a host-only cookie of a parent or a sibling', () => {
    expect(cookieBelongsToSite({ domain: 'example.com', hostOnly: true }, 'www.example.com', false)).toBe(false)
    expect(cookieBelongsToSite({ domain: 'api.example.com', hostOnly: true }, 'www.example.com', false)).toBe(false)
    expect(cookieBelongsToSite({ domain: '.other.com' }, 'www.example.com', false)).toBe(false)
    expect(cookieBelongsToSite({ domain: '.badexample.com' }, 'example.com', true)).toBe(false)
    expect(cookieBelongsToSite({ domain: '127.0.0.1', hostOnly: true }, 'localhost', false)).toBe(false)
  })

  it('takes the cookies of subdomains only when asked', () => {
    expect(cookieBelongsToSite({ domain: 'api.example.com', hostOnly: true }, 'example.com', false)).toBe(false)
    expect(cookieBelongsToSite({ domain: 'api.example.com', hostOnly: true }, 'example.com', true)).toBe(true)
    expect(cookieBelongsToSite({ domain: '.api.example.com' }, 'example.com', true)).toBe(true)
  })

  it('does not apply subdomains to an IP address', () => {
    expect(cookieBelongsToSite({ domain: '127.0.0.1', hostOnly: true }, '127.0.0.1:3000', true)).toBe(true)
    expect(cookieBelongsToSite({ domain: '1.127.0.0.1', hostOnly: true }, '127.0.0.1', true)).toBe(false)
  })

  it('refuses a cookie without a domain or a site that is not valid', () => {
    expect(cookieBelongsToSite({}, 'example.com', true)).toBe(false)
    expect(cookieBelongsToSite({ domain: '.example.com' }, 'not a host', true)).toBe(false)
  })
})

describe('types', () => {
  it('splits what the engine erases from what the shell handles, and covers every type once', () => {
    expect(ENGINE_SITE_DATA_TYPES.every((t) => SITE_DATA_TYPES.includes(t))).toBe(true)
    expect(SITE_DATA_TYPES.filter((t) => !isEngineSiteDataType(t))).toEqual(['sessionStorage', 'history'])
    expect(Object.keys(SITE_DATA_LABELS).sort()).toEqual([...SITE_DATA_TYPES].sort())
  })
})

describe('describeSiteDataResult', () => {
  it('says what happened, with the counts the engine could give', () => {
    expect(describeSiteDataResult({ type: 'cache', ok: true })).toBe('Effacé')
    expect(describeSiteDataResult({ type: 'cookies', ok: true, count: 1 })).toBe('1 cookie')
    expect(describeSiteDataResult({ type: 'cookies', ok: true, count: 3 })).toBe('3 cookies')
    expect(describeSiteDataResult({ type: 'cookies', ok: true, count: 0 })).toBe('Rien à effacer')
    expect(describeSiteDataResult({ type: 'history', ok: true, count: 2 })).toBe('2 pages oubliées')
    expect(describeSiteDataResult({ type: 'cookies', ok: false, error: 'boom' })).toBe(frenchSpaces('Échec : boom'))
    expect(describeSiteDataResult({ type: 'cookies', ok: false })).toBe('Échec')
  })
})

describe('reloadTarget', () => {
  it('goes back to the root of the site from a page deep inside it', () => {
    expect(reloadTarget('https://example.com/wp-admin/users?x=1#top')).toEqual({ kind: 'load', url: 'https://example.com/' })
    expect(reloadTarget('http://localhost:3000/app/login')).toEqual({ kind: 'load', url: 'http://localhost:3000/' })
    expect(reloadTarget('https://example.com/?q=1')).toEqual({ kind: 'load', url: 'https://example.com/' })
  })

  it('just reloads a tab that is already at the root, or on a page without a root', () => {
    expect(reloadTarget('https://example.com/')).toEqual({ kind: 'reload' })
    expect(reloadTarget('https://example.com')).toEqual({ kind: 'reload' })
    expect(reloadTarget('about:blank')).toEqual({ kind: 'reload' })
    expect(reloadTarget('not a url')).toEqual({ kind: 'reload' })
  })
})

describe('sessionStorageScript', () => {
  const run = (origins: string[], location: { origin: string }, store: Record<string, string>) => {
    const sessionStorage = {
      get length() {
        return Object.keys(store).length
      },
      clear: () => {
        for (const key of Object.keys(store)) delete store[key]
      }
    }
    return new Function('location', 'sessionStorage', `return ${sessionStorageScript(origins)}`)(location, sessionStorage) as number
  }

  it('empties the storage of a page on one of the origins and says how much it removed', () => {
    const store = { a: '1', b: '2' }
    expect(run(['https://example.com', 'http://example.com'], { origin: 'http://example.com' }, store)).toBe(2)
    expect(store).toEqual({})
  })

  it('leaves a page that has moved to another origin alone', () => {
    const store = { a: '1' }
    expect(run(['https://example.com'], { origin: 'https://example.com.evil.org' }, store)).toBe(0)
    expect(store).toEqual({ a: '1' })
  })
})

describe('saved selection', () => {
  it('keeps the known types, once each, in the panel’s order', () => {
    expect(cleanSiteDataTypes(['history', 'cookies', 'cookies', 'nope', 3])).toEqual(['cookies', 'history'])
  })

  it('falls back to the default when nothing usable was saved: every type but the history, as the extension ticks them', () => {
    for (const bad of [undefined, null, 'cookies', {}, [], ['nope'], [1, 2]]) expect(cleanSiteDataTypes(bad)).toEqual([...DEFAULT_SITE_DATA_TYPES])
    expect(DEFAULT_SITE_DATA_TYPES).toEqual(SITE_DATA_TYPES.filter((type) => type !== 'history'))
  })

  it('repairs the settings of an old or hand-edited file: http only when ticked by hand', () => {
    expect(normalizeSiteDataPrefs({})).toEqual({ siteDataTypes: [...DEFAULT_SITE_DATA_TYPES], siteDataSubdomains: false, siteDataReload: true, siteDataHttp: false })
    expect(normalizeSiteDataPrefs({ siteDataTypes: ['cache'], siteDataSubdomains: true, siteDataReload: false, siteDataHttp: true })).toEqual({ siteDataTypes: ['cache'], siteDataSubdomains: true, siteDataReload: false, siteDataHttp: true })
    expect(normalizeSiteDataPrefs({ siteDataSubdomains: 'true', siteDataReload: 0, siteDataHttp: 'yes' })).toMatchObject({ siteDataSubdomains: false, siteDataReload: true, siteDataHttp: false })
  })
})

describe('saved selection, as the app reads it', () => {
  const ctx = { now: 1, newId: () => 'id' }
  const settingsOf = (patch: Record<string, unknown>) => {
    const base = createInitialState(ctx)
    return normalize({ ...base, settings: { ...base.settings, ...patch } }).settings
  }

  it('starts as the extension does: every type but the history, http and subdomains off, the reload and the auto-close on, no confirmation, a notice, the spinner', () => {
    const { settings } = createInitialState(ctx)
    expect([settings.siteDataTypes, settings.siteDataHttp, settings.siteDataSubdomains, settings.siteDataReload, settings.siteDataAutoClose]).toEqual([[...DEFAULT_SITE_DATA_TYPES], false, false, true, true])
    expect(settings.siteDataTypes).not.toContain('history')
    expect([settings.siteDataConfirm, settings.siteDataNotify, settings.siteDataAnimation]).toEqual([false, true, 'spinner'])
  })

  it('repairs a saved file whose selection is missing or damaged', () => {
    expect(settingsOf({ siteDataTypes: 'cookies', siteDataSubdomains: 'yes', siteDataReload: null, siteDataHttp: 1, siteDataAnimation: 'disco' })).toMatchObject({ siteDataTypes: [...DEFAULT_SITE_DATA_TYPES], siteDataSubdomains: false, siteDataReload: true, siteDataHttp: false, siteDataAnimation: 'spinner' })
    expect(settingsOf({ siteDataHttp: true, siteDataAnimation: 'none' })).toMatchObject({ siteDataHttp: true, siteDataAnimation: 'none' })
    expect(settingsOf({ siteDataTypes: ['history', 'bogus', 'cookies'], siteDataSubdomains: true, siteDataReload: false })).toMatchObject({ siteDataTypes: ['cookies', 'history'], siteDataSubdomains: true, siteDataReload: false })
  })

  it('repairs a selection the panel sends through settings/update', () => {
    const after = reduce(createInitialState(ctx), { type: 'settings/update', patch: { siteDataTypes: ['nope'] as never, siteDataSubdomains: true } }, ctx)
    expect(after.settings.siteDataTypes).toEqual([...DEFAULT_SITE_DATA_TYPES])
    expect(reduce(after, { type: 'settings/update', patch: { siteDataAnimation: 'disco' as never } }, ctx).settings.siteDataAnimation).toBe('spinner')
    expect(reduce(after, { type: 'settings/update', patch: { siteDataAnimation: 'matrix' } }, ctx).settings.siteDataAnimation).toBe('matrix')
    expect(after.settings.siteDataSubdomains).toBe(true)
    expect(reduce(after, { type: 'settings/update', patch: { siteDataTypes: ['cache'] } }, ctx).settings.siteDataTypes).toEqual(['cache'])
  })
})

describe('parseSiteDataBatchRequest', () => {
  const ask = (over: Record<string, unknown> = {}) => ({ hosts: ['a.example', 'localhost:3000'], types: ['cookies', 'cache'], subdomains: true, http: true, reload: true, detached: true, ...over })

  it('accepts several sites with one choice of types, spelled once each as the URL parser prints them, types in the panel’s order', () => {
    expect(parseSiteDataBatchRequest(ask({ hosts: ['A.Example', 'localhost:3000', 'a.example', '192.168.1.20:8080'] }))).toEqual({
      hosts: ['a.example', 'localhost:3000', '192.168.1.20:8080'],
      types: ['cache', 'cookies'],
      subdomains: true,
      http: true,
      reload: true,
      detached: true
    })
  })

  it('takes the options as flags: only true counts', () => {
    expect(parseSiteDataBatchRequest(ask({ subdomains: 'yes', http: 'yes', reload: 1, detached: null }))).toMatchObject({ subdomains: false, http: false, reload: false, detached: false })
  })

  it('refuses the whole run when one site is not valid, so no site is erased on a doubt', () => {
    for (const bad of ['a b', 'https://x.example/path', 'example.com:99999', '', '127.1', 'a,b.com', 42, null, undefined, {}]) {
      expect(parseSiteDataBatchRequest(ask({ hosts: ['a.example', bad] })), String(bad)).toBeNull()
    }
  })

  it('refuses no site, too many sites and a list that is not a list', () => {
    expect(parseSiteDataBatchRequest(ask({ hosts: [] }))).toBeNull()
    expect(parseSiteDataBatchRequest(ask({ hosts: Array.from({ length: SITE_DATA_HOSTS_MAX + 1 }, (_, i) => `s${i}.example`) }))).toBeNull()
    expect(parseSiteDataBatchRequest(ask({ hosts: Array.from({ length: SITE_DATA_HOSTS_MAX }, (_, i) => `s${i}.example`) }))?.hosts).toHaveLength(SITE_DATA_HOSTS_MAX)
    for (const bad of ['a.example', { 0: 'a.example', length: 1 }, null, 7]) expect(parseSiteDataBatchRequest(ask({ hosts: bad }))).toBeNull()
  })

  it('refuses empty or unknown types and anything that is not an object', () => {
    for (const types of [[], ['nope'], ['cookies', 'nope'], 'cookies', null, [...SITE_DATA_TYPES, 'cookies']]) expect(parseSiteDataBatchRequest(ask({ types })), JSON.stringify(types)).toBeNull()
    for (const bad of [null, undefined, 'a.example', 3, []]) expect(parseSiteDataBatchRequest(bad)).toBeNull()
  })
})

describe('splitSiteHosts', () => {
  it('cuts a typed or pasted list at spaces, commas and semicolons, and reduces each web address to its host', () => {
    expect(splitSiteHosts('a.example, b.example;c.example  localhost:3000')).toEqual(['a.example', 'b.example', 'c.example', 'localhost:3000'])
    expect(splitSiteHosts('https://App.Example/x?y=1 http://localhost:8080/')).toEqual(['app.example', 'localhost:8080'])
  })

  it('drops empty parts and keeps what is not a host, for the panel to say so', () => {
    expect(splitSiteHosts(' , ;  ')).toEqual([])
    expect(splitSiteHosts('')).toEqual([])
    expect(splitSiteHosts('ok.example, pas/un/hote')).toEqual(['ok.example', 'pas/un/hote'])
  })
})

describe('rememberSiteHosts', () => {
  it('puts the sites just erased in front, in the order of the run, each once', () => {
    expect(rememberSiteHosts(['old.example', 'b.example'], ['a.example', 'b.example'])).toEqual(['a.example', 'b.example', 'old.example'])
  })

  it('keeps hosts valid and spelled as the URL parser prints them', () => {
    expect(rememberSiteHosts([], ['A.EXAMPLE', 'a b', 'https://x.example/', '127.0.0.1:8080', '[::1]:3000', 'Exemple.fr:443'])).toEqual(['a.example', '127.0.0.1:8080', '[::1]:3000', 'exemple.fr:443'])
  })

  it('keeps no more than the list bound, the newest first', () => {
    const used = Array.from({ length: SITE_DATA_RECENTS_MAX + 4 }, (_, i) => `site${i}.example`)
    const kept = rememberSiteHosts(['older.example'], used)
    expect(kept).toHaveLength(SITE_DATA_RECENTS_MAX)
    expect(kept[0]).toBe('site0.example')
    expect(kept).not.toContain('older.example')
  })

  it('does not change a list that already starts with the sites of the run, so nothing is saved for nothing', () => {
    const recents = ['a.example', 'b.example', 'c.example']
    expect(rememberSiteHosts(recents, ['a.example', 'b.example'])).toEqual(recents)
  })
})

describe('the result of a run', () => {
  const ok = (type: 'cookies' | 'cache') => ({ type, ok: true as const })
  const bad = (type: 'cookies' | 'cache') => ({ type, ok: false as const, error: 'boom' })

  it('scores a site as the operations that went through out of all of them', () => {
    expect(siteScore([ok('cache'), bad('cookies')])).toEqual({ ok: 1, total: 2 })
    expect(siteScore([])).toEqual({ ok: 0, total: 0 })
  })

  it('counts a run as cleared only when there is a site and every operation of every site went through', () => {
    expect(allSitesCleared([{ host: 'a', results: [ok('cache')] }, { host: 'b', results: [ok('cookies')] }])).toBe(true)
    expect(allSitesCleared([{ host: 'a', results: [ok('cache')] }, { host: 'b', results: [bad('cookies')] }])).toBe(false)
    expect(allSitesCleared([{ host: 'a', results: [ok('cache')] }, { host: 'b', results: [] }])).toBe(false)
    expect(allSitesCleared([])).toBe(false)
  })
})

describe('quickClearRequest', () => {
  const prefs = { siteDataTypes: ['cookies', 'history'] as const, siteDataSubdomains: true, siteDataReload: false, siteDataHttp: false }
  const quick = (url: string, over: { private?: boolean; types?: readonly string[]; http?: boolean } = {}) =>
    quickClearRequest(url, { ...prefs, siteDataTypes: [...(over.types ?? prefs.siteDataTypes)] as never, siteDataHttp: over.http ?? false }, { private: over.private ?? false })

  it('is the site of the page with the choices the panel remembered', () => {
    expect(quick('https://www.example.com/a/b?c=1#d')).toEqual({ hosts: ['www.example.com'], types: ['cookies', 'history'], subdomains: true, http: false, reload: false, detached: false })
    expect(quick('http://localhost:3000/')?.hosts).toEqual(['localhost:3000'])
    expect(quick('http://192.168.1.20:8080/x')?.hosts).toEqual(['192.168.1.20:8080'])
  })

  it('includes the http origins for a page served over http, or when « Inclure HTTP » was ticked by hand, as the extension does', () => {
    expect(quick('http://localhost:3000/')?.http).toBe(true)
    expect(quick('https://example.com/')?.http).toBe(false)
    expect(quick('https://example.com/', { http: true })?.http).toBe(true)
  })

  it('has no subdomains for an IP address', () => {
    expect(quick('http://127.0.0.1:3000/')?.subdomains).toBe(false)
    expect(quick('http://[::1]:3000/')?.subdomains).toBe(false)
  })

  it('is nothing for a page that has no site: internal pages, files, extensions, sources', () => {
    for (const url of ['about:blank', 'file:///Users/moi/page.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'view-source:https://example.com/', 'devtools://devtools/bundled/inspector.html', '', 'pas une adresse']) {
      expect(quick(url), url).toBeNull()
    }
  })

  it('leaves the history out in a private window, and is nothing when that was all there was to erase', () => {
    expect(quick('https://example.com/', { private: true })?.types).toEqual(['cookies'])
    expect(quick('https://example.com/', { private: true, types: ['history'] })).toBeNull()
    expect(quick('https://example.com/', { types: ['history'] })?.types).toEqual(['history'])
  })
})

describe('describeSiteDataNotice', () => {
  const site = (host: string, failed = false) => ({ host, results: [{ type: 'cookies' as const, ok: !failed, ...(failed ? { error: 'x' } : {}) }] })

  it('names the site that was cleared', () => {
    expect(describeSiteDataNotice([site('example.com')], { private: false })).toEqual({ title: 'Données effacées', body: 'example.com' })
  })

  it('counts several sites and names the first ones', () => {
    expect(describeSiteDataNotice([site('a.example'), site('b.example')], { private: false }).body).toBe(frenchSpaces('2 sites : a.example, b.example'))
    expect(describeSiteDataNotice(['a', 'b', 'c', 'd', 'e'].map((h) => site(`${h}.example`)), { private: false }).body).toBe(frenchSpaces('5 sites : a.example, b.example, c.example et 2 autres'))
  })

  it('says it was incomplete and names the sites that failed, not the others', () => {
    expect(describeSiteDataNotice([site('a.example'), site('b.example', true)], { private: false })).toEqual({ title: 'Effacement incomplet', body: 'Échec pour b.example' })
  })

  it('counts a site with no answer at all as a failure', () => {
    expect(describeSiteDataNotice([{ host: 'a.example', results: [] }], { private: false })).toEqual({ title: 'Effacement incomplet', body: 'Échec pour a.example' })
  })

  it('never names a site of a private window: the notification centre is not private', () => {
    const notices = [describeSiteDataNotice([site('secret.example')], { private: true }), describeSiteDataNotice([site('secret.example', true)], { private: true })]
    expect(notices).toEqual([{ title: 'Données effacées', body: 'Fenêtre privée' }, { title: 'Effacement incomplet', body: 'Fenêtre privée' }])
    expect(JSON.stringify(notices)).not.toContain('secret')
  })
})
