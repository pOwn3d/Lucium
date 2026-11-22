import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The tracking pings in the shell: the request filter the engine is given cancels a ping to another site and counts it with the blocker's counter,
// whether or not the lists are on, and does not exist at all while nothing asks for it. The methods run on a stand-in (browser-fake.test-support.ts).
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const verdict = vi.fn(() => false)
const noteStopped = vi.fn()
const resetPageCount = vi.fn()
vi.mock('../blocking', () => ({ blockingService: () => ({ configure: vi.fn(), verdict, noteStopped, resetPageCount }) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

type Filter = (request: { url: string; resourceType: string; pageUrl: string | null; pageId: string | null; method?: string }) => unknown

function windowWith(patch: Partial<Settings>) {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), blockAds: false, blockTrackers: false, blockCookieBanners: false, ...patch } }
  return fakeBrowser({ store: { get: () => state }, extraBlockedHosts: [], containerScopes: new Map(), privateScope: null })
}
const ping = (url = 'https://tracker.example/collect', pageUrl: string | null = 'https://news.test/a', resourceType = 'ping') => ({ url, resourceType, pageUrl, pageId: 'tab-1', method: 'POST' })

beforeEach(() => {
  verdict.mockClear()
  noteStopped.mockClear()
  resetPageCount.mockClear()
})

describe('the request filter with the pings cut', () => {
  it('does not exist while the option is off, and the lists are off too: a request is not even heard', () => {
    expect(shell['requestFilter']!.call(windowWith({ blockPings: false }).self)).toBeNull()
  })

  it('cancels a ping to another site, counts it on its page, and asks the lists nothing when they are off', () => {
    const filter = shell['requestFilter']!.call(windowWith({ blockPings: true }).self) as Filter
    expect(filter(ping())).toBe(true)
    expect(noteStopped).toHaveBeenCalledWith('tab-1')
    expect(verdict).not.toHaveBeenCalled()
  })

  it('lets a ping of the site itself, another kind of request, and a site of the exceptions go through, counting nothing', () => {
    const filter = shell['requestFilter']!.call(windowWith({ blockPings: true, blockExceptions: ['news.test'] }).self) as Filter
    expect(filter(ping('https://news.test/hit'))).toBe(false)
    expect(filter(ping('https://tracker.example/x.gif', 'https://other.test/', 'image'))).toBe(false)
    expect(filter(ping('https://tracker.example/collect', 'https://news.test/a'))).toBe(false)
    expect(noteStopped).not.toHaveBeenCalled()
  })

  it('starts the counter of the page again at a navigation while the lists are off, and leaves it to the lists while they are on', () => {
    const alone = shell['requestFilter']!.call(windowWith({ blockPings: true }).self) as Filter
    alone({ url: 'https://news.test/b', resourceType: 'mainFrame', pageUrl: null, pageId: 'tab-1' })
    expect(resetPageCount).toHaveBeenCalledWith('tab-1')
    resetPageCount.mockClear()
    const both = shell['requestFilter']!.call(windowWith({ blockPings: true, blockAds: true }).self) as Filter
    both({ url: 'https://news.test/b', resourceType: 'mainFrame', pageUrl: null, pageId: 'tab-1' })
    expect(resetPageCount).not.toHaveBeenCalled()
  })

  it('keeps asking the lists for the rest while the option is on', () => {
    const filter = shell['requestFilter']!.call(windowWith({ blockPings: true, blockAds: true }).self) as Filter
    filter(ping('https://ads.example/x.js', 'https://news.test/a', 'script'))
    expect(verdict).toHaveBeenCalledTimes(1)
  })

  it('gives the engine a new filter when the option changes, and not before', () => {
    const base = createInitialState({ now: 0, newId: () => 'x' })
    let settings: Settings = { ...defaultSettings(), blockAds: false, blockTrackers: false, blockCookieBanners: false, blockPings: false }
    const fake = fakeBrowser({ store: { get: () => ({ ...base, settings }) }, extraBlockedHosts: [], containerScopes: new Map(), privateScope: null })
    const given = () => fake.calls.filter((call) => call.name === 'engine.setRequestBlocker').length
    shell['configureBlocker']!.call(fake.self)
    shell['configureBlocker']!.call(fake.self)
    expect(given()).toBe(1)
    settings = { ...settings, blockPings: true }
    shell['configureBlocker']!.call(fake.self)
    expect(given()).toBe(2)
  })
})
