import { describe, expect, it, vi } from 'vitest'
import { SITE_DATA_TYPES, type EngineSiteDataType } from '@shared/site-data'
import { assertWebOrigins, clearInterfaceIcons, clearInterfaceTraces, countSiteCookies, eraseSiteData, profileExtensionOrigins, type InterfaceSessionLike, type SessionLike, type StorageHostLister } from './site-data'
import { t } from '@shared/i18n'

type Cookie = { name: string; domain?: string; hostOnly?: boolean; path?: string; secure?: boolean }

/** A session that records what it is asked, and holds a cookie jar. Without a `folder` it is a session in memory, as a private window's. */
function fakeSession(cookies: Cookie[] = [], fail: Partial<Record<string, string>> = {}, folder: string | null = null) {
  const calls = { clearData: [] as Array<{ origins?: string[]; dataTypes?: string[] }>, clearStorageData: [] as Array<{ origin?: string; storages?: string[] }>, removed: [] as string[], flushed: 0, authCleared: 0 }
  const ses: SessionLike = {
    async clearData(options) {
      calls.clearData.push(options)
      if (fail[options.dataTypes[0]!]) throw new Error(fail[options.dataTypes[0]!])
    },
    async clearStorageData(options) {
      calls.clearStorageData.push(options)
      // Without a list of storages, the call is the one that takes the licences of protected video.
      const failure = fail[options.storages ? 'cacheStorage' : 'mediaLicenses']
      if (failure) throw new Error(failure)
    },
    async clearAuthCache() {
      calls.authCleared++
      if (fail['authCache']) throw new Error(fail['authCache'])
    },
    getStoragePath: () => folder,
    cookies: {
      get: async () => cookies,
      remove: async (url, name) => {
        calls.removed.push(`${url} ${name}`)
      },
      flushStore: async () => {
        calls.flushed++
      }
    }
  }
  return { ses, calls }
}

const ALL_ENGINE_TYPES = SITE_DATA_TYPES.filter((t): t is EngineSiteDataType => t !== 'sessionStorage' && t !== 'history')
const request = (over: Partial<Parameters<typeof eraseSiteData>[1]> = {}) => ({
  origins: ['https://example.com', 'http://example.com'],
  host: 'example.com',
  subdomains: false,
  types: ALL_ENGINE_TYPES,
  ...over
})

describe('assertWebOrigins', () => {
  it('refuses an empty list, which could be read as "everything"', () => {
    expect(() => assertWebOrigins([])).toThrow(/without an origin/)
  })

  it('refuses anything that is not a plain web origin, an extension’s above all', () => {
    for (const bad of ['chrome-extension://abcdefghijklmnop', 'file:///tmp', 'example.com', 'https://example.com/path', 'https://example.com/', 'HTTPS://EXAMPLE.COM', '*']) {
      expect(() => assertWebOrigins([bad]), bad).toThrow(/Refusing/)
    }
    expect(() => assertWebOrigins(['https://example.com', 'http://localhost:3000'])).not.toThrow()
  })
})

describe('eraseSiteData', () => {
  it('erases nothing, and says so by rejecting, when there is no origin or an origin is not a web one', async () => {
    const { ses, calls } = fakeSession([{ name: 'a', domain: 'example.com', hostOnly: true }])
    await expect(eraseSiteData(ses, request({ origins: [] }))).rejects.toThrow(/without an origin/)
    await expect(eraseSiteData(ses, request({ origins: ['https://example.com', 'chrome-extension://abc'] }))).rejects.toThrow(/Refusing/)
    expect(calls).toEqual({ clearData: [], clearStorageData: [], removed: [], flushed: 0, authCleared: 0 })
  })

  it('refuses a host that is not valid, before touching anything', async () => {
    const { ses, calls } = fakeSession([{ name: 'a', domain: 'example.com', hostOnly: true }])
    await expect(eraseSiteData(ses, request({ host: 'example.com/x' }))).rejects.toThrow(/host/)
    expect(calls.clearData).toEqual([])
    expect(calls.removed).toEqual([])
  })

  it('restricts every storage erasure to the origins of the site, never to the whole session', async () => {
    const { ses, calls } = fakeSession()
    const results = await eraseSiteData(ses, request())
    expect(results.map((r) => [r.type, r.ok])).toEqual([...ALL_ENGINE_TYPES, 'mediaLicenses'].map((t) => [t, true]))
    // The sandboxed files of the site go with its IndexedDB, and its background fetches with its service workers; each call is restricted to the origins.
    expect(calls.clearData.map((c) => c.dataTypes)).toEqual([['cache'], ['localStorage'], ['indexedDB', 'fileSystems'], ['serviceWorkers', 'backgroundFetch']])
    for (const call of calls.clearData) expect(call.origins).toEqual(['https://example.com', 'http://example.com'])
    expect(calls.clearStorageData).toEqual([
      { origin: 'https://example.com', storages: ['cachestorage'] },
      { origin: 'http://example.com', storages: ['cachestorage'] },
      { origin: 'https://example.com' },
      { origin: 'http://example.com' }
    ])
    // No call of either kind is ever made without an origin: it would erase the whole session.
    for (const call of calls.clearStorageData) expect(call.origin).toMatch(/^https?:\/\/example\.com$/)
  })

  describe('the licences of protected video (DRM)', () => {
    const everyStorage = (calls: ReturnType<typeof fakeSession>['calls']) => calls.clearStorageData.filter((c) => c.storages === undefined)

    it('go with the site when everything the call takes was asked: every storage of each origin, in a call that names it (this fails if the licences are left)', async () => {
      const { ses, calls } = fakeSession()
      const results = await eraseSiteData(ses, request({ types: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] }))
      expect(results.at(-1)).toEqual({ type: 'mediaLicenses', ok: true })
      expect(everyStorage(calls)).toEqual([{ origin: 'https://example.com' }, { origin: 'http://example.com' }])
    })

    it('stay, with no line and no call, when one of those types was not asked: the call would erase what the user kept', async () => {
      for (const kept of ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] as const) {
        const { ses, calls } = fakeSession()
        const results = await eraseSiteData(ses, request({ types: ALL_ENGINE_TYPES.filter((type) => type !== kept) }))
        expect(results.map((r) => r.type), kept).not.toContain('mediaLicenses')
        expect(everyStorage(calls), kept).toEqual([])
      }
    })

    it('go for the subdomains too when they are asked, each origin in its own call', async () => {
      const { ses, calls } = fakeSession([{ name: 'a', domain: 'app.example.com', hostOnly: true }])
      await eraseSiteData(ses, request({ origins: ['https://example.com'], subdomains: true }))
      expect(everyStorage(calls).map((c) => c.origin)).toEqual(['https://example.com', 'https://app.example.com'])
    })

    it('say on a line of their own that they could not be erased, and the other types keep their own result', async () => {
      const { ses } = fakeSession([], { mediaLicenses: 'storage busy' })
      const results = await eraseSiteData(ses, request())
      expect(results.filter((r) => !r.ok)).toEqual([{ type: 'mediaLicenses', ok: false, error: 'storage busy' }])
      expect(results.filter((r) => r.ok).map((r) => r.type)).toEqual(ALL_ENGINE_TYPES)
    })
  })

  it('only erases the types asked for', async () => {
    const { ses, calls } = fakeSession([{ name: 'a', domain: 'example.com', hostOnly: true }])
    const results = await eraseSiteData(ses, request({ types: ['localStorage'] }))
    expect(results).toEqual([{ type: 'localStorage', ok: true }])
    expect(calls.clearData.map((c) => c.dataTypes)).toEqual([['localStorage']])
    expect(calls.clearStorageData).toEqual([])
    expect(calls.removed).toEqual([])
  })

  it('removes the cookies of the site and those of its parent domain, with the URL each one needs, and leaves the others', async () => {
    const jar: Cookie[] = [
      { name: 'sid', domain: 'www.example.com', hostOnly: true, path: '/', secure: true },
      { name: 'pref', domain: '.example.com', path: '/app' },
      { name: 'sibling', domain: 'api.example.com', hostOnly: true },
      { name: 'parent', domain: 'example.com', hostOnly: true },
      { name: 'other', domain: '.other.org' }
    ]
    const { ses, calls } = fakeSession(jar)
    const results = await eraseSiteData(ses, request({ host: 'www.example.com', origins: ['https://www.example.com', 'http://www.example.com'], types: ['cookies'] }))
    expect(results).toEqual([{ type: 'cookies', ok: true, count: 2 }])
    expect(calls.removed).toEqual(['https://www.example.com/ sid', 'http://example.com/app pref'])
    expect(calls.flushed).toBe(1)
  })

  it('forgets the HTTP authentication cache with the cookies of the site: a login typed in a 401 box is sign-in data too', async () => {
    const { ses, calls } = fakeSession([{ name: 'a', domain: 'example.com', hostOnly: true }])
    await eraseSiteData(ses, request({ types: ['cookies'] }))
    expect(calls.authCleared).toBe(1)
    const other = fakeSession()
    await eraseSiteData(other.ses, request({ types: ['localStorage', 'cache'] }))
    expect(other.calls.authCleared).toBe(0)
  })

  it('says on the cookies line that the sign-in cache could not be forgotten', async () => {
    const { ses } = fakeSession([], { authCache: 'session closed' })
    expect(await eraseSiteData(ses, request({ types: ['cookies', 'localStorage'] }))).toEqual([
      { type: 'cookies', ok: false, error: 'session closed' },
      { type: 'localStorage', ok: true }
    ])
  })

  it('takes the cookies of subdomains only when asked', async () => {
    const jar: Cookie[] = [
      { name: 'a', domain: 'example.com', hostOnly: true },
      { name: 'b', domain: 'api.example.com', hostOnly: true },
      { name: 'c', domain: '.cdn.example.com' }
    ]
    const without = fakeSession(jar)
    expect(await eraseSiteData(without.ses, request({ types: ['cookies'] }))).toEqual([{ type: 'cookies', ok: true, count: 1 }])
    const withSubs = fakeSession(jar)
    expect(await eraseSiteData(withSubs.ses, request({ types: ['cookies'], subdomains: true }))).toEqual([{ type: 'cookies', ok: true, count: 3 }])
    expect(withSubs.calls.removed).toEqual(['http://example.com/ a', 'http://api.example.com/ b', 'http://cdn.example.com/ c'])
  })

  it('adds the subdomains known from the cookie jar to the storage it erases, only when asked', async () => {
    const jar: Cookie[] = [
      { name: 'b', domain: 'api.example.com', hostOnly: true },
      { name: 'c', domain: '.evil-example.com' }
    ]
    const without = fakeSession(jar)
    await eraseSiteData(without.ses, request({ types: ['localStorage'] }))
    expect(without.calls.clearData[0]!.origins).toEqual(['https://example.com', 'http://example.com'])
    const withSubs = fakeSession(jar)
    await eraseSiteData(withSubs.ses, request({ types: ['localStorage'], subdomains: true }))
    expect(withSubs.calls.clearData[0]!.origins).toEqual(['https://example.com', 'http://example.com', 'https://api.example.com', 'http://api.example.com'])
  })

  it('erases the subdomains under the schemes asked for the site: https only when « Inclure HTTP » is off', async () => {
    const jar: Cookie[] = [{ name: 'b', domain: 'api.example.com', hostOnly: true }]
    const httpsOnly = fakeSession(jar)
    await eraseSiteData(httpsOnly.ses, request({ origins: ['https://example.com'], types: ['localStorage', 'cacheStorage'], subdomains: true }))
    expect(httpsOnly.calls.clearData[0]!.origins).toEqual(['https://example.com', 'https://api.example.com'])
    expect(httpsOnly.calls.clearStorageData.map((call) => call.origin)).toEqual(['https://example.com', 'https://api.example.com'])
  })

  describe('with « Sous-domaines », the subdomains that hold storage in the profile', () => {
    const lister = (hosts: string[], unread: string[] = []): StorageHostLister & { folders: string[] } => {
      const folders: string[] = []
      return Object.assign(async (folder: string) => (folders.push(folder), { hosts, unread }), { folders })
    }

    it('are erased though no tab, no visit and no cookie ever named them, and the line says how many were found', async () => {
      const { ses, calls } = fakeSession([], {}, '/profiles/default')
      const list = lister(['unseen.example.com', 'deep.unseen.example.com', 'example.com', 'example.org', 'notexample.com', 'unseen.example.com.evil.test'])
      const results = await eraseSiteData(ses, request({ origins: ['https://example.com'], types: ['localStorage', 'cacheStorage'], subdomains: true }), undefined, list)
      expect(list.folders).toEqual(['/profiles/default'])
      // Only the hosts under the site: a host that merely ends or starts like it belongs to someone else.
      const origins = ['https://example.com', 'https://deep.unseen.example.com', 'https://unseen.example.com']
      expect(calls.clearData[0]!.origins).toEqual(origins)
      expect(calls.clearStorageData.map((call) => call.origin)).toEqual(origins)
      expect(results).toEqual([
        { type: 'localStorage', ok: true },
        { type: 'cacheStorage', ok: true },
        { type: 'subdomains', ok: true, count: 2 }
      ])
    })

    it('join the ones the cookie jar knows, and lose their licences of protected video with the rest', async () => {
      const { ses, calls } = fakeSession([{ name: 'b', domain: 'api.example.com', hostOnly: true }], {}, '/profiles/default')
      const results = await eraseSiteData(ses, request({ origins: ['https://example.com'], types: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'], subdomains: true }), undefined, lister(['video.example.com']))
      const licences = calls.clearStorageData.filter((call) => call.storages === undefined).map((call) => call.origin)
      expect(licences).toEqual(['https://example.com', 'https://api.example.com', 'https://video.example.com'])
      expect(results.at(-1)).toEqual({ type: 'subdomains', ok: true, count: 1 })
    })

    it('are not looked for when subdomains are not asked, nor when only cookies are erased (they go by domain)', async () => {
      const list = lister(['unseen.example.com'])
      const plain = fakeSession([], {}, '/profiles/default')
      expect((await eraseSiteData(plain.ses, request({ types: ['localStorage'] }), undefined, list)).map((r) => r.type)).toEqual(['localStorage'])
      expect((await eraseSiteData(plain.ses, request({ types: ['cookies'], subdomains: true }), undefined, list)).map((r) => r.type)).toEqual(['cookies'])
      expect(list.folders).toEqual([])
      expect(plain.calls.clearData[0]!.origins).toEqual(['https://example.com', 'http://example.com'])
    })

    it('make the run incomplete when a record could not be read: what was found still goes, and the line names what was not read', async () => {
      const { ses, calls } = fakeSession([], {}, '/profiles/default')
      const results = await eraseSiteData(ses, request({ origins: ['https://example.com'], types: ['localStorage'], subdomains: true }), undefined, lister(['found.example.com'], ['Local Storage', 'QuotaManager']))
      expect(calls.clearData[0]!.origins).toEqual(['https://example.com', 'https://found.example.com'])
      expect(results).toEqual([
        { type: 'localStorage', ok: true },
        { type: 'subdomains', ok: false, error: t('site-data.la-liste-des-sous-domaines-n-a-pas-pu-etre-lue', { sources: 'Local Storage, QuotaManager' }) }
      ])
    })

    it('make the run incomplete when the search itself fails, and the site still goes', async () => {
      const { ses, calls } = fakeSession([], {}, '/profiles/default')
      const failing = vi.fn(async () => {
        throw new Error('EIO: i/o error')
      })
      const results = await eraseSiteData(ses, request({ origins: ['https://example.com'], types: ['localStorage'], subdomains: true }), undefined, failing)
      expect(calls.clearData[0]!.origins).toEqual(['https://example.com'])
      expect(results.at(-1)).toEqual({ type: 'subdomains', ok: false, error: 'EIO: i/o error' })
    })

    it('cannot be listed for a session in memory: the line says the subdomains seen only, never a count nor « Effacé »', async () => {
      const { ses, calls } = fakeSession([{ name: 'b', domain: 'api.example.com', hostOnly: true }])
      const list = lister(['unseen.example.com'])
      const results = await eraseSiteData(ses, request({ origins: ['https://example.com'], types: ['localStorage'], subdomains: true }), undefined, list)
      expect(list.folders).toEqual([])
      expect(calls.clearData[0]!.origins).toEqual(['https://example.com', 'https://api.example.com'])
      expect(results.at(-1)).toEqual({ type: 'subdomains', ok: true, seenOnly: true })
    })
  })

  it('reports a type that fails on its own line and carries on with the others', async () => {
    const { ses, calls } = fakeSession([], { indexedDB: 'disk full', cacheStorage: 'no access' })
    const results = await eraseSiteData(ses, request())
    expect(results.filter((r) => !r.ok)).toEqual([
      { type: 'indexedDB', ok: false, error: 'disk full' },
      { type: 'cacheStorage', ok: false, error: 'no access' }
    ])
    expect(results.filter((r) => r.ok).map((r) => r.type)).toEqual(['cache', 'cookies', 'localStorage', 'serviceWorkers', 'mediaLicenses'])
    expect(calls.clearData.map((c) => c.dataTypes![0])).toEqual(['cache', 'localStorage', 'indexedDB', 'serviceWorkers'])
  })
})

// The sidebar draws the icon of a tab with an <img> of the interface's own session: its HTTP cache on disk keeps the icon's address, the site with it.
describe('the icons the interface keeps of a site', () => {
  const interfaceSession = (fail?: string) => {
    const calls: Array<{ origins?: string[]; dataTypes: string[] }> = []
    const ses: InterfaceSessionLike = {
      async clearData(options) {
        calls.push(options)
        if (fail) throw new Error(fail)
      }
    }
    return { ses, calls }
  }

  it('go with the cache of the site, for the origins of the site only', async () => {
    const { ses } = fakeSession()
    const ui = interfaceSession()
    const results = await eraseSiteData(ses, request({ types: ['cache'] }), ui.ses)
    expect(results).toEqual([{ type: 'cache', ok: true }])
    expect(ui.calls).toEqual([{ origins: ['https://example.com', 'http://example.com'], dataTypes: ['cache'] }])
  })

  it('stay when the cache of the site is not erased', async () => {
    const { ses } = fakeSession()
    const ui = interfaceSession()
    await eraseSiteData(ses, request({ types: ['cookies', 'localStorage'] }), ui.ses)
    expect(ui.calls).toEqual([])
  })

  it('that could not be erased make the cache line fail, once', async () => {
    const { ses } = fakeSession()
    const results = await eraseSiteData(ses, request({ types: ['cache'] }), interfaceSession('locked').ses)
    expect(results).toEqual([{ type: 'cache', ok: false, error: 'locked' }])
  })

  it('all go with the cache or the data of a whole profile: Chromium cannot tell one profile’s icons from another’s', async () => {
    const ui = interfaceSession()
    await clearInterfaceIcons(ui.ses)
    expect(ui.calls).toEqual([{ dataTypes: ['cache'] }])
  })

  it('go with the cookie jar of that session when the data of a profile are erased: nothing else in the Settings empties it', async () => {
    const ui = interfaceSession()
    await clearInterfaceTraces(ui.ses)
    expect(ui.calls).toEqual([{ dataTypes: ['cache', 'cookies'] }])
  })
})

describe('countSiteCookies', () => {
  const jar: Cookie[] = [
    { name: 'a', domain: 'example.com', hostOnly: true },
    { name: 'b', domain: '.example.com' },
    { name: 'c', domain: 'api.example.com', hostOnly: true }
  ]

  it('counts what clearing would remove', async () => {
    expect(await countSiteCookies(fakeSession(jar).ses, 'example.com', false)).toBe(2)
    expect(await countSiteCookies(fakeSession(jar).ses, 'example.com', true)).toBe(3)
    expect(await countSiteCookies(fakeSession(jar).ses, 'other.org', true)).toBe(0)
  })

  it('counts nothing for a host that is not valid', async () => {
    expect(await countSiteCookies(fakeSession(jar).ses, 'not a host', true)).toBe(0)
  })
})

describe('the extensions a whole-profile erasure must spare', () => {
  // The engine keys what it loaded as `<profile>:<extension id>`.
  const loaded = new Map([
    ['default:abc', { id: 'abc' }],
    ['default:def', { id: 'def' }],
    ['work:ghi', { id: 'ghi' }]
  ])

  it('lists real extension origins, not the engine keys', () => {
    expect(profileExtensionOrigins(loaded, 'default')).toEqual(['chrome-extension://abc', 'chrome-extension://def'])
  })

  it('leaves out the extensions of the other profiles, and a profile whose name starts the same', () => {
    expect(profileExtensionOrigins(loaded, 'work')).toEqual(['chrome-extension://ghi'])
    expect(profileExtensionOrigins(new Map([['default-2:xyz', { id: 'xyz' }]]), 'default')).toEqual([])
  })
})
