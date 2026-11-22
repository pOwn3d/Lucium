import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The gate of the blocker in the shell: the request filter the engine is given, and the configuration the lists are given. Both read the switches
// through shared/blocker.ts (`blockAds` or its alias `blockTrackers` for the ads and trackers, `blockCookieBanners` for the banners), never `blockAds` alone:
// with `blockAds` off and `blockTrackers` on, the Settings switch shows the trackers blocked, so the filter must be there.
// The methods run on a stand-in (browser-fake.test-support.ts): the shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const configure = vi.fn()
const verdict = vi.fn(() => false)
vi.mock('../blocking', () => ({ blockingService: () => ({ configure, verdict }) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

function windowWith(patch: Partial<Settings>) {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), typoGuard: false, ...patch } }
  const own: Record<string, unknown> = { store: { get: () => state }, extraBlockedHosts: ['ads.local'], containerScopes: new Map(), privateScope: null }
  const fake = fakeBrowser(own)
  // configureBlocker hands the engine what requestFilter answers: the real method runs on the same stand-in.
  own['requestFilter'] = () => shell['requestFilter']!.call(fake.self)
  return fake
}

const COMBINATIONS = [false, true].flatMap((blockAds) => [false, true].flatMap((blockTrackers) => [false, true].map((blockCookieBanners) => ({ blockAds, blockTrackers, blockCookieBanners }))))

beforeEach(() => {
  configure.mockClear()
  verdict.mockClear()
})

describe('the request filter of a window', () => {
  it.each(COMBINATIONS)('blockAds $blockAds, blockTrackers $blockTrackers, banners $blockCookieBanners: there is a filter when any of the ads and trackers pair or the banners is on, none otherwise', (switches) => {
    const filter = shell['requestFilter']!.call(windowWith(switches).self)
    expect(filter !== null).toBe(switches.blockAds || switches.blockTrackers || switches.blockCookieBanners)
  })

  it('asks the blocker with the settings of the moment and the extra hosts, request after request', () => {
    const fake = windowWith({ blockAds: false, blockTrackers: true, blockCookieBanners: false })
    const filter = shell['requestFilter']!.call(fake.self) as (request: unknown) => unknown
    const request = { url: 'https://ads.example/x.js', resourceType: 'script', pageUrl: 'https://news.test/', pageId: 'tab-1' }
    filter(request)
    expect(verdict).toHaveBeenCalledWith(request, expect.objectContaining({ blockAds: false, blockTrackers: true }), ['ads.local'])
  })
})

describe('the configuration the lists are given', () => {
  it.each(COMBINATIONS)('blockAds $blockAds, blockTrackers $blockTrackers, banners $blockCookieBanners: the ad and tracker lists are asked for when either of the pair is on, the banner lists with their own switch', (switches) => {
    const fake = windowWith(switches)
    shell['configureBlocker']!.call(fake.self)
    expect(configure).toHaveBeenCalledTimes(1)
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ ads: switches.blockAds || switches.blockTrackers, cookieBanners: switches.blockCookieBanners }))
    // The engine is given the filter that goes with it, in the same breath.
    const given = fake.calls.filter((call) => call.name === 'engine.setRequestBlocker')
    expect(given).toHaveLength(1)
    expect(given[0]!.args[0] !== null).toBe(switches.blockAds || switches.blockTrackers || switches.blockCookieBanners)
  })

  it('does not configure twice for a settings change that moves nothing the blocker reads (the pair written together)', () => {
    const fake = windowWith({ blockAds: true, blockTrackers: false })
    shell['configureBlocker']!.call(fake.self)
    const state = fake.self['store'] as { get: () => { settings: Settings } }
    state.get().settings.blockTrackers = true
    shell['configureBlocker']!.call(fake.self)
    expect(configure).toHaveBeenCalledTimes(1)
  })
})
