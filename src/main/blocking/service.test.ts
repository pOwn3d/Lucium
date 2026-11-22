import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomFilterList } from '@shared/custom-filter-lists'
import type { BlockingConfig, FilterListSpec } from '@shared/filter-lists'
import { loadGhosteryBackend } from './ghostery-engine'
import type { FetchLike } from './list-updater'
import { BlockingService, type BlockedRequest, type BlockingSettings } from './service'
import { expectMode } from '../windows.test-support'
import { listText, startTestServer, type TestServer } from './test-server'

const ghosteryBackend = await loadGhosteryBackend()

let server: TestServer
let dir: string
let clock: number
const services: BlockingService[] = []

beforeEach(async () => {
  server = await startTestServer()
  dir = mkdtempSync(join(tmpdir(), 'lucium-blocking-'))
  clock = 1_000_000
  // Lists: ads (two) and cookies (one). `||adsN.example^$third-party` blocks, `localhost##...` hides.
  server.routes.set('/ads.txt', () => ({ body: listText('Pubs', ['localhost##.promo', '##.generic-ad', '||doc.example^$document', '||collect.example/p$xhr'], 5), headers: { etag: '"ads1"' } }))
  server.routes.set('/more.txt', () => ({ body: listText('Plus', ['||tracker.example^$third-party'], 5) }))
  server.routes.set('/cookies.txt', () => ({ body: listText('Cookies', ['||consent.example^$third-party', 'localhost###cookie-wall'], 5, 'cmp') }))
})
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

const spec = (id: string, category: 'ads' | 'cookies', path: string): FilterListSpec => ({
  id, title: id, description: '', category, url: `${server.origin}${path}`, homepage: '', license: 'test', licenseUrl: '', author: 'test'
})
const catalog = () => [spec('pubs', 'ads', '/ads.txt'), spec('plus', 'ads', '/more.txt'), spec('cookies', 'cookies', '/cookies.txt')]

const realFetch: FetchLike = (url, init) => fetch(url, init)
/** The arguments of an engine test run: the only run in which the service lets its download be swapped. */
const SMOKE_RUN = ['electron', '.', '--smoke']
const config = (patch: Partial<BlockingConfig> = {}): BlockingConfig => ({ ads: true, cookieBanners: false, cosmetic: true, disabledLists: [], updateDays: 4, ...patch })
const settings = (patch: Partial<BlockingSettings> = {}): BlockingSettings => ({ blockAds: true, blockCookieBanners: false, blockCosmetic: true, blockExceptions: [], blockMode: 'standard', ...patch })

function make(overrides: Partial<ConstructorParameters<typeof BlockingService>[0]> = {}, where = dir): BlockingService {
  const service = new BlockingService({ dir: where, fetch: realFetch, backend: async () => ghosteryBackend, catalog: catalog(), now: () => clock, timeoutMs: 2_000, allowInsecure: true, ...overrides })
  services.push(service)
  return service
}
async function start(service: BlockingService, cfg = config()): Promise<void> {
  service.configure(cfg)
  await service.settled()
}
const request = (url: string, extra: Partial<BlockedRequest> = {}): BlockedRequest => ({ url, resourceType: 'script', pageUrl: 'https://news.test/', pageId: 'tab-1', ...extra })

describe('the swap of the download, for the engine test only', () => {
  it('refuses outside an engine test run, and leaves the service as it was: its lists are still fetched by the download it was made with', async () => {
    const fetched: string[] = []
    const service = make({ fetch: (url, init) => (fetched.push(url), realFetch(url, init)) })
    const down: FetchLike = () => Promise.reject(new Error('hors ligne'))
    expect(() => service.useForTests({ fetch: down, allowInsecure: false }, ['/Applications/Lucium.app/Contents/MacOS/Lucium'])).toThrow(/engine test only/)
    // The arguments of the test runner are not those of an engine test either.
    expect(() => service.useForTests({ fetch: down })).toThrow(/engine test only/)
    await start(service)
    expect(fetched.length).toBeGreaterThan(0)
    expect(service.hasCompiledLists()).toBe(true)
  })
})

describe('nothing happens until the user turns blocking on', () => {
  it('downloads nothing, compiles nothing, and blocks nothing while both options are off', async () => {
    const service = make()
    await start(service, config({ ads: false, cookieBanners: false }))
    expect(server.requests).toHaveLength(0)
    expect(service.hasCompiledLists()).toBe(false)
    expect(service.filter(request('https://ads0.example/x.js'), settings({ blockAds: false }))).toBe(false)
  })

  it('fetches only the lists of the category that is on', async () => {
    const service = make()
    await start(service, config({ ads: true, cookieBanners: false }))
    expect(server.requests.map((r) => r.path).sort()).toEqual(['/ads.txt', '/more.txt'])
    await start(service, config({ ads: false, cookieBanners: true }))
    expect(server.requests.map((r) => r.path)).toContain('/cookies.txt')
  })

  it('fetches a list the user switched off nowhere, and forgets its rules', async () => {
    const service = make()
    await start(service, config({ disabledLists: ['plus'] }))
    expect(server.requests.map((r) => r.path)).toEqual(['/ads.txt'])
    expect(service.filter(request('https://tracker.example/t.js'), settings())).toBe(false)
    expect(service.filter(request('https://ads0.example/x.js'), settings())).toBe(true)
  })
})

describe('blocking requests', () => {
  it('blocks a third-party request a rule names, and lets another through', async () => {
    const service = make()
    await start(service)
    expect(service.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
    expect(service.filter(request('https://tracker.example/t.js'), settings())).toBe(true)
    expect(service.filter(request('https://cdn.test/app.js'), settings())).toBe(false)
  })

  it('never blocks the page the user opened, even when a rule names it', async () => {
    const service = make()
    await start(service)
    const navigation = request('https://ads1.example/', { resourceType: 'mainFrame', pageUrl: 'https://news.test/' })
    expect(service.filter(navigation, settings())).toBe(false)
    // The same address as a subresource of another page is blocked: only the navigation is spared.
    expect(service.filter(request('https://ads1.example/'), settings())).toBe(true)
    // A rule that targets documents (uBlock's badware list has many) would block the page itself if it were asked.
    expect(service.filter(request('https://doc.example/', { resourceType: 'mainFrame', pageUrl: 'https://news.test/' }), settings())).toBe(false)
    expect(service.filter(request('https://doc.example/', { resourceType: 'mainFrame', pageUrl: null }), settings())).toBe(false)
  })

  it('reads the request type Electron reports, by the name the engine knows', async () => {
    const service = make()
    await start(service)
    const collect = (resourceType: string) => service.filter(request('https://collect.example/p', { resourceType }), settings())
    expect(collect('xhr')).toBe(true)
    expect(collect('script')).toBe(false)
    expect(collect('image')).toBe(false)
    expect(collect('somethingNew')).toBe(false)
  })

  it('lets a site load its own resources', async () => {
    const service = make()
    await start(service)
    expect(service.filter(request('https://ads1.example/x.js', { pageUrl: 'https://ads1.example/' }), settings())).toBe(false)
  })

  it('blocks nothing on a site with an exception, and again once the exception is removed', async () => {
    const service = make()
    await start(service)
    const ad = request('https://ads1.example/x.js', { pageUrl: 'https://www.exemple.org/page' })
    expect(service.filter(ad, settings())).toBe(true)
    expect(service.filter(ad, settings({ blockExceptions: ['exemple.org'] }))).toBe(false)
    expect(service.filter(request('https://tracker.example/t.js', { pageUrl: 'https://mail.exemple.org/' }), settings({ blockExceptions: ['exemple.org'] }))).toBe(false)
    expect(service.filter(ad, settings({ blockExceptions: ['autre.net'] }))).toBe(true)
    expect(service.filter(ad, settings())).toBe(true)
  })

  it('applies the cookie lists only when the banner option is on', async () => {
    const service = make()
    await start(service, config({ ads: true, cookieBanners: true }))
    const consent = request('https://consent.example/cmp.js')
    expect(service.filter(consent, settings({ blockCookieBanners: true }))).toBe(true)
    expect(service.filter(consent, settings({ blockCookieBanners: false }))).toBe(false)
    expect(service.filter(request('https://ads1.example/x.js'), settings({ blockAds: false, blockCookieBanners: true }))).toBe(false)
  })

  it('ignores an extra host unless ads are on', async () => {
    const service = make()
    await start(service)
    const local = request('http://localhost:9/x.js', { pageUrl: 'http://127.0.0.1:9/' })
    expect(service.filter(local, settings(), ['localhost'])).toBe(true)
    expect(service.filter(local, settings({ blockAds: false, blockCookieBanners: true }), ['localhost'])).toBe(false)
    // The hosts belong to the window that passes them: another window's request is not affected.
    expect(service.filter(local, settings())).toBe(false)
  })
})

describe('the short built-in list stands in until the lists are there', () => {
  it('blocks a known network while nothing is installed, and hands over once the lists are compiled', async () => {
    const down: FetchLike = () => Promise.reject(new Error('hors ligne'))
    const service = make({ fetch: down })
    await start(service)
    expect(service.hasCompiledLists()).toBe(false)
    expect(service.filter(request('https://securepubads.g.doubleclick.net/t.js'), settings())).toBe(true)
    expect(service.filter(request('https://ads1.example/x.js'), settings())).toBe(false)
    service.useForTests({ fetch: realFetch }, SMOKE_RUN)
    await service.updateNow()
    expect(service.hasCompiledLists()).toBe(true)
    expect(service.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
    // The compiled lists decide now: the built-in one no longer adds to them.
    expect(service.filter(request('https://securepubads.g.doubleclick.net/t.js'), settings())).toBe(false)
  })

  it('keeps the built-in cookie hosts while only the ads lists are compiled', async () => {
    const service = make()
    await start(service)
    expect(service.filter(request('https://cdn.cookielaw.org/otSDKStub.js'), settings({ blockCookieBanners: true }))).toBe(true)
  })
})

describe('updates', () => {
  it('keeps the previous lists when an update fails, and says so', async () => {
    const service = make()
    await start(service)
    const before = service.status().lists.find((l) => l.id === 'pubs')!
    expect(before).toMatchObject({ installed: true, error: null })
    server.routes.set('/ads.txt', () => ({ status: 500 }))
    clock += 1_000
    await service.updateNow()
    const after = service.status().lists.find((l) => l.id === 'pubs')!
    expect(after.error?.message).toContain('500')
    expect(after.installed).toBe(true)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.rules).toBe(before.rules)
    expect(service.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
    expect(service.status().lists.find((l) => l.id === 'plus')!.error).toBeNull()
  })

  it('uses a new copy of a list once the server has one', async () => {
    const service = make()
    await start(service)
    expect(service.filter(request('https://fresh.example/x.js'), settings())).toBe(false)
    server.routes.set('/more.txt', () => ({ body: listText('Plus', ['||fresh.example^$third-party'], 5) }))
    await service.updateNow()
    expect(service.filter(request('https://fresh.example/x.js'), settings())).toBe(true)
  })

  it('checks again only after the configured number of days, and then with a conditional request', async () => {
    server.routes.set('/ads.txt', (r) => (r.headers['if-none-match'] === '"ads1"' ? { status: 304 } : { body: listText('Pubs', [], 5), headers: { etag: '"ads1"' } }))
    const service = make()
    await start(service, config({ updateDays: 4 }))
    const afterFirst = server.requests.length
    clock += 3 * 86_400_000
    service.configure(config({ updateDays: 4 }))
    await service.settled()
    expect(server.requests).toHaveLength(afterFirst)
    clock += 2 * 86_400_000
    service.configure(config({ updateDays: 4 }))
    await service.settled()
    expect(server.requests.length).toBeGreaterThan(afterFirst)
    expect(server.requests.filter((r) => r.path === '/ads.txt').at(-1)!.headers['if-none-match']).toBe('"ads1"')
    expect(service.status().lists.find((l) => l.id === 'pubs')!.updatedAt).toBe(clock)
  })

  it('fetches a list again at once when "update now" is asked, whatever its age', async () => {
    const service = make()
    await start(service)
    const before = server.requests.length
    await service.updateNow()
    expect(server.requests.length).toBe(before + 2)
  })

  it('does nothing when asked to update while blocking is off', async () => {
    const service = make()
    await start(service, config({ ads: false }))
    await service.updateNow()
    expect(server.requests).toHaveLength(0)
  })
})

describe('the compiled engine is kept between launches', () => {
  it('comes back from the cache without any network and without compiling again', async () => {
    const first = make()
    await start(first)
    expect(first.hasCompiledLists()).toBe(true)
    const count = server.requests.length

    const build = vi.fn(ghosteryBackend.build)
    const load = vi.fn(ghosteryBackend.load)
    const offline: FetchLike = () => Promise.reject(new Error('hors ligne'))
    const second = make({ fetch: offline, backend: async () => ({ ...ghosteryBackend, build, load }) })
    await start(second)
    expect(load).toHaveBeenCalledTimes(1)
    expect(build).not.toHaveBeenCalled()
    expect(server.requests).toHaveLength(count)
    expect(second.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
    // Not yet due, so the offline fetch is not even tried.
    expect(second.status().lists.every((l) => l.error === null)).toBe(true)
  })

  it('compiles again when a list changed since the cache was written', async () => {
    const first = make()
    await start(first)
    server.routes.set('/more.txt', () => ({ body: listText('Plus', ['||fresh.example^$third-party'], 5) }))
    await first.updateNow()
    const build = vi.fn(ghosteryBackend.build)
    const second = make({ backend: async () => ({ ...ghosteryBackend, build }) })
    await start(second)
    expect(build).not.toHaveBeenCalled()
    expect(second.filter(request('https://fresh.example/x.js'), settings())).toBe(true)
  })

  it('does not reuse a cached engine that was made from other lists', async () => {
    const first = make()
    await start(first)
    const second = make()
    await start(second)
    expect(second.filter(request('https://fresh.example/x.js'), settings())).toBe(false)
    // The cache on disk still holds the engine of the old lists when the new ones arrive.
    server.routes.set('/more.txt', () => ({ body: listText('Plus', ['||fresh.example^$third-party'], 5) }))
    await second.updateNow()
    expect(second.filter(request('https://fresh.example/x.js'), settings())).toBe(true)
  })

  it('rebuilds from the lists when the cached engine cannot be read', async () => {
    const first = make()
    await start(first)
    const broken = { ...ghosteryBackend, load: vi.fn(() => Promise.reject(new Error('format changé'))) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = make({ backend: async () => broken })
    await start(second)
    expect(broken.load).toHaveBeenCalled()
    expect(second.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
    warn.mockRestore()
  })

  it('stops checking for updates once both options are switched off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const service = make()
      await start(service)
      expect(vi.getTimerCount()).toBe(1)
      service.configure(config({ ads: false, cookieBanners: false }))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fetches a list again, at once, when its file was damaged and the compiled engine is gone', async () => {
    await start(make())
    const before = server.requests.filter((r) => r.path === '/ads.txt').length
    writeFileSync(join(dir, 'lists', 'pubs.txt'), 'abîmé')
    rmSync(join(dir, 'engine-ads.bin'))
    const again = make()
    await start(again)
    expect(server.requests.filter((r) => r.path === '/ads.txt')).toHaveLength(before + 1)
    expect(again.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
  })

  it('lets go of the engines when both options are switched off', async () => {
    const service = make()
    await start(service)
    expect(service.hasCompiledLists()).toBe(true)
    service.configure(config({ ads: false, cookieBanners: false }))
    expect(service.hasCompiledLists()).toBe(false)
  })
})

describe('hiding elements', () => {
  it('hides what the lists name for a site, and the generic rules the markup calls for', async () => {
    const service = make()
    await start(service)
    const css = service.cosmeticCss('http://localhost:3000/', settings())
    expect(css).toContain('.promo')
    expect(css).not.toContain('.generic-ad')
    const withMarkup = service.cosmeticCss('http://localhost:3000/', settings(), { classes: ['generic-ad'], ids: [], hrefs: [] })
    expect(withMarkup).toContain('.generic-ad')
    expect(withMarkup).toContain('.promo')
  })

  it('hides nothing on a site with an exception', async () => {
    const service = make()
    await start(service)
    expect(service.cosmeticCss('http://localhost:3000/', settings({ blockExceptions: ['localhost'] }))).toBe('')
  })

  it('leaves ads alone when cosmetic filtering is off, but still hides cookie banners', async () => {
    const service = make()
    await start(service, config({ cookieBanners: true }))
    const off = settings({ blockCosmetic: false, blockCookieBanners: true })
    const css = service.cosmeticCss('http://localhost:3000/', off, { classes: ['generic-ad'], ids: [], hrefs: [] })
    expect(css).not.toContain('.promo')
    expect(css).not.toContain('.generic-ad')
    expect(css).toContain('#cookie-wall')
  })

  it('keeps hiding the known consent walls once the cookie lists are compiled: the lists answer some with scriptlets that are not run', async () => {
    const service = make()
    await start(service, config({ cookieBanners: true }))
    expect(service.hasCompiledLists()).toBe(true)
    const css = service.cosmeticCss('https://news.test/', settings({ blockAds: false, blockCookieBanners: true }))
    expect(css).toContain('[id^="sp_message_container"]')
    expect(css).toContain('html.sp-message-open body')
    // ...and what the lists themselves name is still there, for the sites they know.
    expect(service.cosmeticCss('http://localhost:3000/', settings({ blockAds: false, blockCookieBanners: true }))).toContain('#cookie-wall')
    // The blanket scroll unlock belongs to the stand-in only.
    expect(css).not.toMatch(/(^|\n)html, body \{/)
  })

  it('uses the built-in banner stylesheet until the cookie lists are compiled', async () => {
    const down: FetchLike = () => Promise.reject(new Error('hors ligne'))
    const service = make({ fetch: down })
    await start(service, config({ ads: false, cookieBanners: true }))
    expect(service.cosmeticCss('https://news.test/', settings({ blockAds: false, blockCookieBanners: true }))).toContain('#onetrust-banner-sdk')
    expect(service.cosmeticCss('https://news.test/', settings({ blockAds: false, blockCookieBanners: false }))).toBe('')
  })
})

describe('the counter of a page', () => {
  it('counts what is blocked on a page, and starts again when the page navigates', async () => {
    const service = make()
    await start(service)
    service.filter(request('https://ads1.example/a.js'), settings())
    service.filter(request('https://ads2.example/b.js'), settings())
    service.filter(request('https://cdn.test/ok.js'), settings())
    service.filter(request('https://ads1.example/c.js', { pageId: 'tab-2' }), settings())
    expect(service.blockedCount('tab-1')).toBe(2)
    expect(service.blockedCount('tab-2')).toBe(1)
    service.filter(request('https://news.test/autre', { resourceType: 'mainFrame' }), settings())
    expect(service.blockedCount('tab-1')).toBe(0)
    expect(service.blockedCount('tab-2')).toBe(1)
  })

  it('counts nothing for a request that belongs to no page, nor for a site with an exception', async () => {
    const service = make()
    await start(service)
    service.filter(request('https://ads1.example/a.js', { pageId: null }), settings())
    service.filter(request('https://ads1.example/a.js'), settings({ blockExceptions: ['news.test'] }))
    expect(service.blockedCount('tab-1')).toBe(0)
  })

  it('does not grow without bound', async () => {
    const service = make()
    await start(service)
    for (let i = 0; i < 700; i++) service.filter(request('https://ads1.example/a.js', { pageId: `tab-${i}` }), settings())
    expect(service.blockedCount('tab-0')).toBe(0)
    expect(service.blockedCount('tab-699')).toBe(1)
  })
})

describe('what the shell stops for a protection of its own (the pings)', () => {
  it('counts it on its page and in the session, like a block of the lists, and starts the page again at its next navigation', () => {
    const service = make()
    const before = service.sessionBlockedCount()
    service.noteStopped('tab-1')
    service.noteStopped('tab-1')
    service.noteStopped('tab-2')
    expect(service.blockedCount('tab-1')).toBe(2)
    expect(service.blockedCount('tab-2')).toBe(1)
    expect(service.sessionBlockedCount() - before).toBe(3)
    service.resetPageCount('tab-1')
    expect(service.blockedCount('tab-1')).toBe(0)
    expect(service.blockedCount('tab-2')).toBe(1)
  })

  it('counts nothing for a request that belongs to no page', () => {
    const service = make()
    service.noteStopped(null)
    expect(service.sessionBlockedCount()).toBe(0)
  })
})

describe('the status shown in the settings', () => {
  it('lists every list with what is known about it', async () => {
    const service = make()
    expect(service.status().lists.map((l) => l.id)).toEqual(['pubs', 'plus', 'cookies'])
    expect(service.status().lists.every((l) => !l.installed && l.updatedAt === null)).toBe(true)
    await start(service)
    const status = service.status()
    expect(status.engineReady).toBe(true)
    expect(status.lists.find((l) => l.id === 'pubs')).toMatchObject({ installed: true, updatedAt: clock, rules: 9, updating: false })
    expect(status.lists.find((l) => l.id === 'cookies')).toMatchObject({ installed: false, updatedAt: null })
  })

  it('tells the listeners when something changed', async () => {
    const service = make()
    const events: string[] = []
    service.subscribe((e) => events.push(e))
    await start(service)
    expect(events).toContain('status')
    expect(events).toContain('engine')
  })
})

describe('Standard and Strict modes: whose request is it', () => {
  // Rules written the way the real lists write them: most say nothing about whose requests they target, a few say "first party".
  beforeEach(() => {
    server.routes.set('/ads.txt', () => ({
      body: ['[Adblock Plus 2.0]', '! Title: modes', '||own.example/tracker.js', '||own.example/stats$1p', '||beacon.example^$~third-party', '||player.example/ads/manifest', '||news.test/tp.js$third-party', ''].join('\n')
    }))
    server.routes.set('/cookies.txt', () => ({ body: ['[Adblock Plus 2.0]', '! Title: cookies', '||own.example/cmp.js', ''].join('\n') }))
  })
  const standard = settings({ blockMode: 'standard' })
  const strict = settings({ blockMode: 'strict' })
  const own = (url: string, extra: Partial<BlockedRequest> = {}) => request(url, { pageUrl: 'https://www.own.example/home', ...extra })

  it('Standard leaves the requests of a site to itself alone; Strict applies the lists to them too', async () => {
    const service = make()
    await start(service)
    const tracker = own('https://cdn.own.example/tracker.js')
    expect(service.filter(tracker, standard)).toBe(false)
    expect(service.filter(tracker, strict)).toBe(true)
    // Another site asking for the same address is a third party in both modes.
    const elsewhere = request('https://cdn.own.example/tracker.js', { pageUrl: 'https://news.test/' })
    expect(service.filter(elsewhere, standard)).toBe(true)
    expect(service.filter(elsewhere, strict)).toBe(true)
  })

  it('keeps a rule that names the first party, in both modes', async () => {
    const service = make()
    await start(service)
    for (const mode of [standard, strict]) {
      expect(service.filter(own('https://own.example/stats'), mode)).toBe(true)
      expect(service.filter(request('https://beacon.example/p', { pageUrl: 'https://beacon.example/' }), mode)).toBe(true)
    }
    // ...and such a rule is no business of a third-party page.
    expect(service.filter(request('https://own.example/stats', { pageUrl: 'https://news.test/' }), standard)).toBe(false)
  })

  it('judges a request by the document that makes it: a player\'s own files are not cut because of the page around it', async () => {
    const service = make()
    await start(service)
    const manifest = request('https://player.example/ads/manifest.m3u8', { pageUrl: 'https://news.test/', documentUrl: 'https://player.example/embed/1' })
    expect(service.filter(manifest, standard)).toBe(false)
    expect(service.filter(manifest, strict)).toBe(true)
    // The same request from the page itself, or from a frame of yet another site, is a third party's.
    expect(service.filter({ ...manifest, documentUrl: 'https://news.test/' }, standard)).toBe(true)
    expect(service.filter({ ...manifest, documentUrl: 'https://other.example/embed' }, standard)).toBe(true)
    // The session may not say which document: the tab's page stands in.
    expect(service.filter({ ...manifest, documentUrl: null }, standard)).toBe(true)
    expect(service.filter({ url: manifest.url, resourceType: 'xhr', pageUrl: 'https://news.test/', pageId: 'tab-1' }, standard)).toBe(true)
  })

  it('also reads $third-party against that document: a frame is a third party to the page that embeds it', async () => {
    const service = make()
    await start(service)
    const fromFrame = request('https://news.test/tp.js', { pageUrl: 'https://news.test/', documentUrl: 'https://player.example/embed/1' })
    expect(service.filter(fromFrame, standard)).toBe(true)
    // Strict keeps judging by the page of the tab, as before: for it the frame's request goes to the tab's own site.
    expect(service.filter(fromFrame, strict)).toBe(false)
  })

  it('applies the cookie-banner lists to a site\'s own requests in both modes: a banner goes whoever serves it', async () => {
    const service = make()
    await start(service, config({ ads: true, cookieBanners: true }))
    const consent = own('https://own.example/cmp.js')
    for (const mode of [standard, strict]) expect(service.filter(consent, { ...mode, blockCookieBanners: true }), mode.blockMode).toBe(true)
    // With the banner option off, the cookie lists stay out of it, and the ad lists have no rule for this address.
    expect(service.filter(consent, { ...standard, blockCookieBanners: false })).toBe(false)
  })

  it('also decides for the cookie-banner lists alone: a frame is judged by its own document in Standard, by the page of the tab in Strict', async () => {
    // Settings › Vie privée et sécurité › Plus de réglages › Mode de blocage must stay a working choice when only the banners are blocked: the mode changes what `$third-party` is read against.
    server.routes.set('/cookies.txt', () => ({ body: ['[Adblock Plus 2.0]', '! Title: cookies', '||consent.example/cmp.js$third-party', ''].join('\n') }))
    const service = make()
    await start(service, config({ ads: false, cookieBanners: true }))
    const bannersOnly = { blockAds: false, blockCookieBanners: true }
    const fromItsFrame = request('https://consent.example/cmp.js', { pageUrl: 'https://news.test/', documentUrl: 'https://consent.example/embed' })
    expect(service.filter(fromItsFrame, { ...standard, ...bannersOnly })).toBe(false)
    expect(service.filter(fromItsFrame, { ...strict, ...bannersOnly })).toBe(true)
    // The page itself asking for it is a third party's request in both modes.
    const fromThePage = request('https://consent.example/cmp.js', { pageUrl: 'https://news.test/', documentUrl: 'https://news.test/' })
    for (const mode of [standard, strict]) expect(service.filter(fromThePage, { ...mode, ...bannersOnly }), mode.blockMode).toBe(true)
  })

  it('claims no own site when neither the document nor the page is known', async () => {
    const service = make()
    await start(service)
    // Nothing says the request is the site\'s own, so the lists decide as they do in Strict.
    const orphan: BlockedRequest = { url: 'https://own.example/tracker.js', resourceType: 'xhr', pageUrl: null, pageId: null, documentUrl: null }
    expect(service.filter(orphan, standard)).toBe(true)
    expect(service.filter(orphan, strict)).toBe(true)
  })

  it('takes any value but "strict" for Standard, which is the default', async () => {
    const service = make()
    await start(service)
    const tracker = own('https://cdn.own.example/tracker.js')
    expect(service.filter(tracker, settings({ blockMode: undefined as unknown as 'standard' }))).toBe(false)
  })

  it('judges a site by its own mode when it has one: Strict on one site with Standard as the general mode, and the reverse', async () => {
    const service = make()
    await start(service)
    const tracker = own('https://cdn.own.example/tracker.js')
    // The site's requests are spared by the general Standard mode, but Strict on this site applies the lists to them.
    expect(service.filter(tracker, { ...standard, blockModeSites: { 'own.example': 'strict' } })).toBe(true)
    // A subdomain of the site follows it; another site on the general mode is untouched.
    expect(service.filter({ ...tracker, pageUrl: 'https://m.own.example/' }, { ...standard, blockModeSites: { 'own.example': 'strict' } })).toBe(true)
    expect(service.filter({ ...tracker, pageUrl: 'https://news.test/' }, { ...standard, blockModeSites: { 'own.example': 'strict' } })).toBe(true)
    // Strict in general, with Standard set for the site: the site's own requests are spared again.
    expect(service.filter(tracker, { ...strict, blockModeSites: { 'own.example': 'standard' } })).toBe(false)
    // Without a site choice, the general mode decides, as before.
    expect(service.filter(tracker, { ...standard, blockModeSites: {} })).toBe(false)
    expect(service.filter(tracker, { ...strict, blockModeSites: {} })).toBe(true)
  })

  it('applies the same judgement to the extra hosts of a window (the engine test\'s ad network)', async () => {
    const service = make()
    await start(service)
    const fromItsFrame = request('https://adnet.example/x.js', { pageUrl: 'https://news.test/', documentUrl: 'https://adnet.example/frame' })
    expect(service.filter(fromItsFrame, strict, ['adnet.example'])).toBe(true)
    expect(service.filter(fromItsFrame, standard, ['adnet.example'])).toBe(false)
    expect(service.filter({ ...fromItsFrame, documentUrl: 'https://other.example/frame' }, standard, ['adnet.example'])).toBe(true)
  })

  it('applies the same judgement to the short built-in list: a network\'s frame loads its own files', async () => {
    const down: FetchLike = () => Promise.reject(new Error('hors ligne'))
    const service = make({ fetch: down })
    await start(service)
    expect(service.hasCompiledLists()).toBe(false)
    const frameFile = request('https://securepubads.g.doubleclick.net/pagead/ads.js', { pageUrl: 'https://news.test/', documentUrl: 'https://tpc.googlesyndication.com/safeframe/1/html/container.html' })
    // Not a network's own document: blocked in both modes.
    expect(service.filter(frameFile, standard)).toBe(true)
    const ownFile = { ...frameFile, documentUrl: 'https://googleads.g.doubleclick.net/pagead/ads?client=1' }
    expect(service.filter(ownFile, standard)).toBe(false)
    expect(service.filter(ownFile, strict)).toBe(true)
  })
})

describe('the user\'s own lists', () => {
  const own = (patch: Partial<CustomFilterList> = {}): CustomFilterList => ({ id: 'custom-00000001', title: 'Mes règles', source: 'paste', sourceName: 'Règles collées', enabled: true, addedAt: 1, ...patch })
  const ownConfig = (lists: CustomFilterList[], patch: Partial<BlockingConfig> = {}): BlockingConfig => config({ customLists: lists, ...patch })

  /** Reads and installs rules the way the settings do, then configures the service with the list. */
  async function addList(service: BlockingService, text: string, list = own(), patch: Partial<BlockingConfig> = {}): Promise<void> {
    const verdict = await service.reviewCustomText(text)
    if (!verdict.ok) throw new Error(verdict.reason)
    await service.installCustomList(list, verdict.review)
    await start(service, ownConfig([list], patch))
  }

  it('blocks and hides what a list of the user\'s names, next to the lists of the catalog, and downloads nothing for it', async () => {
    const service = make()
    await addList(service, '||perso.example^$third-party\nnews.test##.bandeau-perso\n')
    expect(service.filter(request('https://perso.example/x.js'), settings())).toBe(true)
    expect(service.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
    expect(service.filter(request('https://cdn.test/app.js'), settings())).toBe(false)
    expect(service.cosmeticCss('https://news.test/', settings())).toContain('.bandeau-perso')
    // The catalog's lists were fetched; a custom list has no address to fetch.
    expect(server.requests.map((r) => r.path).sort()).toEqual(['/ads.txt', '/more.txt'])
  })

  it('applies with the option "Bloquer les publicités" only, and stops when the list is switched off', async () => {
    const service = make()
    await addList(service, '||perso.example^$third-party\n')
    expect(service.filter(request('https://perso.example/x.js'), settings())).toBe(true)
    await start(service, ownConfig([own({ enabled: false })]))
    expect(service.filter(request('https://perso.example/x.js'), settings())).toBe(false)
    // With only the cookie option on (and its list unreachable), nothing is compiled: the custom list belongs to the ads option.
    server.routes.set('/cookies.txt', () => ({ status: 500, body: 'down' }))
    await start(service, ownConfig([own()], { ads: false, cookieBanners: true }))
    expect(service.filter(request('https://perso.example/x.js'), settings({ blockAds: false, blockCookieBanners: true }))).toBe(false)
    expect(service.hasCompiledLists()).toBe(false)
  })

  it('keeps the rules across a restart, from the disk, without reading the list again', async () => {
    const first = make()
    await addList(first, '||perso.example^$third-party\n')
    first.dispose()
    const second = make()
    await start(second, ownConfig([own()]))
    expect(second.filter(request('https://perso.example/x.js'), settings())).toBe(true)
  })

  it('forgets the rules of a list that is removed', async () => {
    const service = make()
    await addList(service, '||perso.example^$third-party\n')
    await service.removeCustomList('custom-00000001')
    await start(service, ownConfig([]))
    expect(service.filter(request('https://perso.example/x.js'), settings())).toBe(false)
    expect(service.status().lists.some((l) => l.id === 'custom-00000001')).toBe(false)
  })

  it('shows each list with its rules and what was left out, flagged as the user\'s', async () => {
    const service = make()
    await addList(service, '||perso.example^$third-party\n/(a+)+$/\nmauvais motif ici\n')
    const state = service.status().lists.find((l) => l.id === 'custom-00000001')!
    expect(state).toMatchObject({ custom: true, installed: true, rules: 1, error: null, review: { ignored: 1, invalid: 1 } })
    expect(state.review!.samples.map((s) => s.line)).toEqual([2, 3])
  })

  it('never lets a script rule of its own or a regular expression into the engine, whatever the text says', async () => {
    const service = make()
    await addList(service, '||perso.example^$third-party\nnews.test##+js(trusted-click-element, button)\nnews.test##+js(abort-on-property-read, adsEnabled)\n/(a+)+$/\n')
    // A scriptlet of the library is kept (it only runs with the extended rules on) but is never a style: the stylesheet has no trace of it.
    expect(service.cosmeticCss('https://news.test/', settings())).not.toContain('abort-on-property-read')
    expect(service.scriptletCalls('https://news.test/', settings({ blockScriptlets: true }))).toEqual([{ id: 'abort-on-property-read', args: ['adsEnabled'] }])
    const started = Date.now()
    // The address that makes `/(a+)+$/` take seconds, asked to the engine as a request would be.
    expect(service.filter(request(`https://perso.example/${'a'.repeat(60)}c`), settings())).toBe(true)
    expect(service.filter(request(`https://ads2.example/${'a'.repeat(60)}c`), settings())).toBe(true)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('reads a text without installing anything', async () => {
    const service = make()
    const verdict = await service.reviewCustomText('||perso.example^\n')
    expect(verdict).toMatchObject({ ok: true, review: { rules: 1 } })
    await start(service, ownConfig([own()]))
    expect(service.status().lists.find((l) => l.id === 'custom-00000001')).toMatchObject({ installed: false, rules: null })
    expect(service.filter(request('https://perso.example/x.js'), settings())).toBe(false)
  })

  it('refuses to install under an id that is not a custom list\'s, which would name any file of the filters folder', async () => {
    const service = make()
    const review = { text: '||perso.example^\n', rules: 1, ignored: 0, invalid: 0, samples: [] }
    await expect(service.installCustomList({ id: '../index' }, review)).rejects.toThrow('Invalid custom list id')
    await expect(service.installCustomList({ id: 'easylist' }, review)).rejects.toThrow('Invalid custom list id')
    await expect(service.removeCustomList('../index')).rejects.toThrow('Invalid custom list id')
  })

  it('leaves a list that breaks the compilation out, tells why, and keeps the others working', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const poisoned: typeof ghosteryBackend = { ...ghosteryBackend, build: async (texts) => (texts.some((t) => t.includes('POISON')) ? Promise.reject(new Error('moteur cassé')) : ghosteryBackend.build(texts)) }
    const service = make({ backend: async () => poisoned })
    const good = own({ id: 'custom-00000001', title: 'Bonne' })
    const bad = own({ id: 'custom-00000002', title: 'Piégée' })
    await service.installCustomList(good, { text: '||perso.example^$third-party\n', rules: 1, ignored: 0, invalid: 0, samples: [] })
    await service.installCustomList(bad, { text: '||poison.example^$third-party\n! POISON\n', rules: 1, ignored: 0, invalid: 0, samples: [] })
    await start(service, ownConfig([good, bad]))
    expect(service.filter(request('https://perso.example/x.js'), settings())).toBe(true)
    expect(service.filter(request('https://ads1.example/x.js'), settings())).toBe(true)
    expect(service.filter(request('https://poison.example/x.js'), settings())).toBe(false)
    const lists = service.status().lists
    expect(lists.find((l) => l.id === 'custom-00000002')?.error?.message).toContain('pas utilisée')
    expect(lists.find((l) => l.id === 'custom-00000001')?.error).toBeNull()
    expect(errors.mock.calls.some((call) => String(call[0]).includes('custom-00000002'))).toBe(true)
    errors.mockRestore()
  })

  it('rethrows a failure that is not the user\'s lists\' (the engine itself is broken), so the failure is the existing one', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: typeof ghosteryBackend = { ...ghosteryBackend, build: async () => Promise.reject(new Error('moteur cassé')) }
    const service = make({ backend: async () => broken })
    await start(service)
    expect(service.hasCompiledLists()).toBe(false)
    expect(errors.mock.calls.some((call) => String(call[0]).includes('update failed'))).toBe(true)
    errors.mockRestore()
  })
})

describe('the extended rules of the lists', () => {
  const EXTENDED_RULES = [
    '||redir.example/a.js$script,redirect=noopjs',
    '||redir.example/u.js$script,redirect=unknown-resource.js',
    '||params.example^$removeparam=fbclid',
    '||doc.example^$csp=script-src \'none\'',
    '||doc.example^$csp=script-src \'none\'; report-uri https://t.example/r',
    'news.test##+js(set-constant, adsEnabled, false)',
    'news.test##+js(trusted-click-element, button)',
    'news.test##+js(set-constant, other, alert(1))',
    'news.test##+js(aopr, adBlockDetected)'
  ]
  const on = (patch: Partial<BlockingSettings> = {}) => settings({ blockScriptlets: true, ...patch })

  async function ready(extra: string[] = EXTENDED_RULES): Promise<BlockingService> {
    server.routes.set('/ads.txt', () => ({ body: listText('Pubs', extra, 5) }))
    const service = make()
    await start(service)
    return service
  }

  it('does nothing different until the setting is on: a redirect rule cancels, nothing is cleaned, no scriptlet, no policy', async () => {
    const service = await ready()
    const off = settings()
    expect(service.verdict(request('https://redir.example/a.js'), off)).toBe(true)
    expect(service.verdict(request('https://params.example/p?fbclid=1', { resourceType: 'xhr' }), off)).toBe(false)
    expect(service.verdict(request('https://params.example/p?fbclid=1', { resourceType: 'mainFrame' }), off)).toBe(false)
    expect(service.scriptletCalls('https://news.test/', off)).toEqual([])
    expect(service.cspFor('https://doc.example/', off)).toBeNull()
    expect(service.filter(request('https://redir.example/a.js'), on())).toBe(true)
  })

  it('answers a redirect rule with a stand-in resource of Lucium\'s own, as an address of the scheme the engine serves', async () => {
    const service = await ready()
    const verdict = service.verdict(request('https://redir.example/a.js'), on())
    expect(verdict).toEqual({ redirect: 'lucium-stand-in://resource/noop.js' })
    expect(service.blockedCount('tab-1')).toBe(1)
  })

  it('cancels the request when the rule names a resource Lucium does not have', async () => {
    const service = await ready()
    expect(service.verdict(request('https://redir.example/u.js'), on())).toBe(true)
  })

  it('sends the page to the address without the parameters a rule removes, for a request that can be repeated', async () => {
    const service = await ready()
    expect(service.verdict(request('https://params.example/p?fbclid=1&keep=2', { resourceType: 'xhr', method: 'GET' }), on())).toEqual({ redirect: 'https://params.example/p?keep=2' })
    expect(service.verdict(request('https://params.example/p?fbclid=1', { resourceType: 'image' }), on())).toEqual({ redirect: 'https://params.example/p' })
    // A request that is not GET or HEAD is never sent elsewhere, and an address with nothing to clean stays as it is.
    expect(service.verdict(request('https://params.example/p?fbclid=1', { resourceType: 'xhr', method: 'POST' }), on())).toBe(false)
    expect(service.verdict(request('https://params.example/p?keep=2', { resourceType: 'xhr' }), on())).toBe(false)
    // Cleaning is not blocking: nothing is counted.
    expect(service.blockedCount('tab-1')).toBe(0)
  })

  it('cleans the address of a navigation too, but never blocks the page the user opened', async () => {
    const service = await ready()
    expect(service.verdict(request('https://params.example/article?fbclid=1', { resourceType: 'mainFrame' }), on())).toEqual({ redirect: 'https://params.example/article' })
    expect(service.verdict(request('https://redir.example/a.js', { resourceType: 'mainFrame' }), on())).toBe(false)
  })

  it('leaves a site with an exception alone, for requests, navigations, scriptlets and policies', async () => {
    const service = await ready()
    const exempt = on({ blockExceptions: ['news.test', 'params.example', 'doc.example'] })
    expect(service.verdict(request('https://redir.example/a.js', { pageUrl: 'https://another.test/' }), exempt)).toEqual({ redirect: expect.stringMatching(/^lucium-stand-in:\/\/resource\//) })
    expect(service.verdict(request('https://redir.example/a.js', { pageUrl: 'https://news.test/' }), exempt)).toBe(false)
    expect(service.verdict(request('https://params.example/a?fbclid=1', { resourceType: 'mainFrame' }), exempt)).toBe(false)
    expect(service.scriptletCalls('https://news.test/', exempt)).toEqual([])
    expect(service.cspFor('https://doc.example/', exempt)).toBeNull()
  })

  it('gives only the scriptlets of the library with good arguments, whatever the lists say', async () => {
    const service = await ready()
    expect(service.scriptletCalls('https://news.test/article', on())).toEqual([
      { id: 'set-constant', args: ['adsEnabled', 'false'] },
      { id: 'abort-on-property-read', args: ['adBlockDetected'] }
    ])
    expect(service.scriptletCalls('https://elsewhere.test/', on())).toEqual([])
  })

  it('gives the scriptlets of a list only when the option that list belongs to is on', async () => {
    const service = await ready()
    expect(service.scriptletCalls('https://news.test/', on({ blockAds: false }))).toEqual([])
  })

  it('gives a $csp policy of acceptable directives only', async () => {
    const service = await ready(['||doc.example^$csp=script-src \'none\'; report-uri https://t.example/r', '||ok.example^$csp=frame-src \'none\''])
    // The first rule would make the browser report to a third party: the engine hands it over, the service refuses it.
    expect(service.cspFor('https://doc.example/', on())).toBeNull()
    expect(service.cspFor('https://ok.example/', on())).toBe("frame-src 'none'")
  })

  it('keeps working with a backend that knows none of the extended rules', async () => {
    const plain: typeof ghosteryBackend = {
      ...ghosteryBackend,
      build: async (texts) => {
        const engine = await ghosteryBackend.build(texts)
        return { shouldBlock: (r) => engine.shouldBlock(r), cosmeticCss: (u, d) => engine.cosmeticCss(u, d), serialize: () => engine.serialize() }
      }
    }
    server.routes.set('/ads.txt', () => ({ body: listText('Pubs', EXTENDED_RULES, 5) }))
    const service = make({ backend: async () => plain })
    await start(service)
    expect(service.verdict(request('https://redir.example/a.js'), on())).toBe(true)
    expect(service.verdict(request('https://params.example/p?fbclid=1', { resourceType: 'xhr' }), on())).toBe(false)
    expect(service.scriptletCalls('https://news.test/', on())).toEqual([])
    expect(service.cspFor('https://doc.example/', on())).toBeNull()
  })
})

describe('the compiled engine file: when it is read, when it is written, what is said', () => {
  let info: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const told = (spy: ReturnType<typeof vi.spyOn>): string => (spy.mock.calls as unknown[][]).map((call) => call.join(' ')).join('\n')

  it('is neither read nor written while blocking is off, and the folder is not even made', async () => {
    const fresh = join(dir, 'never-enabled')
    const service = make({}, fresh)
    await start(service, config({ ads: false, cookieBanners: false }))
    service.status()
    expect(existsSync(fresh)).toBe(false)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves a file that is already there alone while blocking is off: it is not read (a damaged file would be told) and not removed', async () => {
    writeFileSync(join(dir, 'engine-ads.bin'), 'garbage that is not an engine')
    const service = make()
    await start(service, config({ ads: false, cookieBanners: false }))
    expect(warn).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'engine-ads.bin'), 'utf8')).toBe('garbage that is not an engine')
  })

  it('writes the engine the first time, owner-only, and says it had none', async () => {
    const service = make()
    await start(service)
    expect(told(info)).toMatch(/no usable compiled ads engine on disk/)
    expectMode(join(dir, 'engine-ads.bin'), 0o600)
  })

  it('reads it the next time without a word: no compiling, nothing told', async () => {
    await start(make())
    info.mockClear()
    const second = make()
    await start(second)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(second.hasCompiledLists()).toBe(true)
  })

  it('compiles again, and says the lists changed, when the file was made from other lists', async () => {
    await start(make())
    info.mockClear()
    server.routes.set('/more.txt', () => ({ body: listText('Plus', ['||tracker2.example^$third-party'], 5) }))
    // Later than the update delay: the new copy of the list is fetched, and the engine of the old one no longer matches.
    clock += 10 * 86_400_000
    await start(make())
    expect(told(info)).toMatch(/other lists or by another engine version/)
  })

  it('compiles again, and says so, when the file is damaged; the next launch finds a good one', async () => {
    await start(make())
    const file = join(dir, 'engine-ads.bin')
    const whole = readFileSync(file)
    writeFileSync(file, whole.subarray(0, whole.length - 50))
    const second = make()
    await start(second)
    expect(told(warn)).toMatch(/is cut short/)
    expect(second.filter(request('https://ads0.example/x.js'), settings())).toBe(true)
    warn.mockClear()
    await start(make())
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('the YouTube rules: only on youtube.com, only with the switches that ask for them', () => {
  const YT = 'https://www.youtube.com/watch?v=abc'
  const ad = (patch: Partial<BlockedRequest> = {}) => request('https://www.youtube.com/pagead/viewthroughconversion/1', { resourceType: 'xhr', pageUrl: YT, ...patch })
  const on = (patch: Partial<BlockingSettings> = {}) => settings({ blockScriptlets: true, ...patch })

  it('cancels the advertising paths of youtube.com on a YouTube page, its own document included', async () => {
    const service = make()
    await start(service)
    expect(service.filter(ad(), settings())).toBe(true)
    expect(service.filter(ad({ documentUrl: 'https://www.youtube.com/' }), settings())).toBe(true)
    expect(service.filter(request('https://www.youtube.com/api/stats/qoe?x=1', { resourceType: 'xhr', pageUrl: YT }), settings())).toBe(false)
  })

  it('does nothing on another site, nor when the ads switch is off, nor on a site with an exception', async () => {
    const service = make()
    await start(service)
    expect(service.filter(ad({ pageUrl: 'https://news.test/' }), settings())).toBe(false)
    expect(service.filter(ad(), settings({ blockAds: false, blockCookieBanners: false }))).toBe(false)
    expect(service.filter(ad(), settings({ blockAds: false, blockCookieBanners: true }))).toBe(false)
    expect(service.filter(ad(), settings({ blockExceptions: ['youtube.com'] }))).toBe(false)
  })

  it('gives the player rules on a YouTube page with the ads switch on, even when blockScriptlets is off (the default)', async () => {
    const service = make()
    await start(service)
    const names = (s: BlockingSettings, page = YT) => service.scriptletCalls(page, s).map((c) => c.id)
    expect(names(off())).toEqual(['json-prune', 'set-constant', 'set-constant', 'set-constant', 'prune-response'])
    expect(names(on())).toEqual(['json-prune', 'set-constant', 'set-constant', 'set-constant', 'prune-response'])
    expect(names(off(), 'https://news.test/')).toEqual([])
    expect(names(off(), 'https://elsewhere.test/')).toEqual([])
    expect(names(off({ blockAds: false }))).toEqual([])
    expect(names(on({ blockAds: false }))).toEqual([])
    // A site with an exception gets none of them, YouTube included.
    expect(names(off({ blockExceptions: ['youtube.com'] }))).toEqual([])
  })

  it('hides the advertising blocks on a YouTube page only, with the cosmetic and ads switches on', async () => {
    const service = make()
    await start(service)
    expect(service.cosmeticCss(YT, settings())).toContain('ytd-ad-slot-renderer')
    expect(service.cosmeticCss('https://news.test/', settings())).not.toContain('ytd-ad-slot-renderer')
    expect(service.cosmeticCss(YT, settings({ blockCosmetic: false }))).not.toContain('ytd-ad-slot-renderer')
    expect(service.cosmeticCss(YT, settings({ blockAds: false, blockCookieBanners: true }))).not.toContain('ytd-ad-slot-renderer')
  })

  function off(patch: Partial<BlockingSettings> = {}): BlockingSettings {
    return settings({ blockScriptlets: false, ...patch })
  }
})

// The two switches of the blocker and what each one filters (shared/blocker.ts: `adsBlockingOn`, `blockerIsOn`). The ads and trackers switch is
// `blockAds` and its alias `blockTrackers`, either one on; the cookie switch is `blockCookieBanners`. Every gate of the service reads them the same way.
describe('the ads and trackers switch (blockAds or its alias blockTrackers) and the cookie switch each filter their own lists', () => {
  const YT = 'https://www.youtube.com/watch?v=abc'
  const RULES = [
    'localhost##.promo',
    '||params.example^$removeparam=fbclid',
    '||doc.example^$csp=frame-src \'none\'',
    'news.test##+js(set-constant, adsEnabled, false)'
  ]
  const SWITCHES = [
    { blockAds: false, blockTrackers: false, ads: false },
    { blockAds: true, blockTrackers: false, ads: true },
    { blockAds: false, blockTrackers: true, ads: true },
    { blockAds: true, blockTrackers: true, ads: true }
  ]
  const ADS_REQUEST = 'https://ads1.example/x.js'
  const BANNER_REQUEST = 'https://consent.example/cmp.js'

  async function ready(): Promise<BlockingService> {
    server.routes.set('/ads.txt', () => ({ body: listText('Pubs', RULES, 5) }))
    const service = make()
    // Both categories compiled: what a switch reads is the switch, not what happens to be loaded.
    await start(service, config({ ads: true, cookieBanners: true }))
    return service
  }

  describe.each(SWITCHES)('blockAds $blockAds, blockTrackers $blockTrackers (ads and trackers: $ads), banners off', ({ ads, ...switches }) => {
    const mine = (patch: Partial<BlockingSettings> = {}) => settings({ ...switches, blockCookieBanners: false, ...patch })

    it('filters the requests of the ad and tracker lists when either one is on, and those lists only', async () => {
      const service = await ready()
      expect(service.filter(request(ADS_REQUEST), mine())).toBe(ads)
      expect(service.filter(request('https://tracker.example/t.js'), mine())).toBe(ads)
      // The cookie-banner lists are the other switch's: off here, whatever the ads and trackers switch says.
      expect(service.filter(request(BANNER_REQUEST), mine())).toBe(false)
    })

    it('hides the ads in the page, with the cosmetic option, and for YouTube too', async () => {
      const service = await ready()
      expect(service.cosmeticCss('http://localhost:3000/', mine()).includes('.promo')).toBe(ads)
      expect(service.cosmeticCss('http://localhost:3000/', mine({ blockCosmetic: false }))).toBe('')
      expect(service.cosmeticCss(YT, mine()).includes('ytd-ad-slot-renderer')).toBe(ads)
    })

    it('cancels the advertising paths of YouTube and gives its player rules, when either one is on', async () => {
      const service = await ready()
      expect(service.filter(request('https://www.youtube.com/pagead/viewthroughconversion/1', { resourceType: 'xhr', pageUrl: YT }), mine())).toBe(ads)
      expect(service.scriptletCalls(YT, mine()).length > 0).toBe(ads)
    })

    it('applies the extended rules of the ad lists (scriptlets, $csp, $removeparam) when either one is on', async () => {
      const service = await ready()
      const extended = mine({ blockScriptlets: true })
      expect(service.scriptletCalls('https://news.test/', extended).length > 0).toBe(ads)
      expect(service.cspFor('https://doc.example/', extended)).toBe(ads ? "frame-src 'none'" : null)
      expect(service.verdict(request('https://params.example/article?fbclid=1', { resourceType: 'mainFrame' }), extended)).toEqual(ads ? { redirect: 'https://params.example/article' } : false)
    })

    it('does not let the built-in short list stand in for a category that is off', async () => {
      const service = make()
      // Nothing compiled yet: the built-in list answers for what is switched on, and only for that.
      expect(service.filter(request('https://doubleclick.net/x.js'), mine())).toBe(ads)
      expect(service.filter(request('https://cookiebot.com/x.js'), mine())).toBe(false)
    })
  })

  describe.each(SWITCHES)('blockAds $blockAds, blockTrackers $blockTrackers (ads and trackers: $ads), banners on', ({ ads, ...switches }) => {
    const mine = (patch: Partial<BlockingSettings> = {}) => settings({ ...switches, blockCookieBanners: true, ...patch })

    it('filters the banner lists in every case, the ad lists only when the ads and trackers switch is on', async () => {
      const service = await ready()
      expect(service.filter(request(BANNER_REQUEST), mine())).toBe(true)
      expect(service.filter(request(ADS_REQUEST), mine())).toBe(ads)
      expect(service.cosmeticCss('http://localhost:3000/', mine()).includes('#cookie-wall')).toBe(true)
      expect(service.cosmeticCss('http://localhost:3000/', mine()).includes('.promo')).toBe(ads)
    })
  })

  it('counts nothing and filters nothing when both switches are off, whichever of the values the ads and trackers pair holds', async () => {
    const service = await ready()
    for (const switches of SWITCHES.filter((s) => !s.ads)) {
      expect(service.filter(request(ADS_REQUEST), settings({ ...switches, blockCookieBanners: false }))).toBe(false)
      expect(service.verdict(request(ADS_REQUEST), settings({ ...switches, blockCookieBanners: false }))).toBe(false)
    }
    expect(service.blockedCount('tab-1')).toBe(0)
    expect(service.sessionBlockedByKind()).toEqual({ ads: 0, banners: 0 })
  })

  it('counts a block by its list: the ads and trackers pair on the ads side, the banners on theirs', async () => {
    const service = await ready()
    service.filter(request(ADS_REQUEST), settings({ blockAds: false, blockTrackers: true, blockCookieBanners: true }))
    service.filter(request(BANNER_REQUEST), settings({ blockAds: false, blockTrackers: true, blockCookieBanners: true }))
    expect(service.blockedCount('tab-1')).toBe(2)
    expect(service.sessionBlockedByKind()).toEqual({ ads: 1, banners: 1 })
  })
})
