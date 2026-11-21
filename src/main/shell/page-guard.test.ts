import { describe, expect, it, vi, type Mock } from 'vitest'
import { adsBlockingOn, adsBlockingPatch } from '@shared/blocker'
import { defaultSettings, type Settings } from '@shared/model'
import type { WebRtcPolicy } from '@shared/fingerprint'
import type { GuardPlan } from '@shared/page-guard'
import type { ScriptletCall } from '@shared/scriptlets'
import type { InnerGuardProvider, PageGuardProvider, ResponsePolicy } from '../engine/types'
import { PageGuard, SiteSeeds } from './page-guard'

function setup(initial: Partial<Settings> = {}) {
  let settings: Settings = { ...defaultSettings(), ...initial }
  const guards: Array<PageGuardProvider | null> = []
  const policies: Array<ResponsePolicy | null> = []
  const inners: Array<InnerGuardProvider | null> = []
  // The blocker answers with its rule only while the ads switch is on, as the real one does.
  const scriptlets = vi.fn((_url: string, s: Settings): ScriptletCall[] => (adsBlockingOn(s) ? [{ id: 'abort-on-property-read', args: ['adsbygoogle'] }] : []))
  const cspFor = vi.fn((_url: string, _settings: Settings): string | null => "script-src 'none'")
  type Entry = { page: { setWebRtcPolicy: Mock<(policy: WebRtcPolicy | null) => void> }; url: string | undefined }
  const pages = new Map<string, Entry>()
  const guard = new PageGuard({
    settings: () => settings,
    engine: { setPageGuard: (p) => void guards.push(p), setInnerGuard: (p) => void inners.push(p), setResponsePolicy: (p) => void policies.push(p) },
    blocker: () => ({ scriptletCalls: scriptlets, cspFor }),
    seeds: new SiteSeeds(() => Buffer.alloc(16, 7)),
    pages: () => [...pages].map(([id, value]) => ({ id, ...value }))
  })
  const page = (id: string, url: string | undefined) => {
    const entry: Entry = { page: { setWebRtcPolicy: vi.fn<(policy: WebRtcPolicy | null) => void>() }, url }
    pages.set(id, entry)
    return entry
  }
  return { guard, guards, policies, inners, scriptlets, cspFor, page, set: (patch: Partial<Settings>) => void (settings = { ...settings, ...patch }) }
}

const planOf = (provider: PageGuardProvider | null, url: string): GuardPlan => provider!({ pageUrl: url })

describe('the page guard of a window', () => {
  it('costs nothing while the features are off (blocking and fingerprint protection): the engine is not called, no page is touched, nothing is asked of the blocker', () => {
    const { guard, guards, policies, scriptlets, cspFor, page } = setup(adsBlockingPatch(false))
    const entry = page('a', 'https://news.test/')
    guard.configure()
    guard.applyToPage('a', entry.page, entry.url)
    guard.refreshPages()
    expect(guards).toEqual([])
    expect(policies).toEqual([])
    expect(entry.page.setWebRtcPolicy).not.toHaveBeenCalled()
    expect(scriptlets).not.toHaveBeenCalled()
    expect(cspFor).not.toHaveBeenCalled()
  })

  it('gives the engine a guard and a response policy when the scriptlets are on, and only then', () => {
    const { guard, guards, policies, set } = setup({ blockAds: true })
    // The switch alone is not enough without a blocking option: nothing to apply the rules of.
    set({ blockScriptlets: true, blockCookieBanners: false, ...adsBlockingPatch(false) })
    guard.configure()
    expect(guards).toEqual([])
    set(adsBlockingPatch(true))
    guard.configure()
    guard.configure()
    expect(guards).toHaveLength(1)
    expect(policies).toHaveLength(1)
    expect(policies[0]!({ url: 'https://news.test/' })).toBe("script-src 'none'")
  })

  it('is armed by the ads switch alone, for the YouTube player rules, with no response policy (blockScriptlets off)', () => {
    const { guard, guards, policies, set } = setup({ blockAds: true, blockScriptlets: false })
    guard.configure()
    expect(guards).toHaveLength(1)
    expect(policies).toEqual([])
    set(adsBlockingPatch(false))
    guard.configure()
    expect(guards).toEqual([expect.any(Function), null])
  })

  it('stops the scripts of a site whose JavaScript is off, with no blocker at all, and of that site only', () => {
    const { guard, policies, cspFor, set } = setup({ ...adsBlockingPatch(false), siteJavascriptOff: ['shop.test'] })
    guard.configure()
    guard.configure()
    expect(policies).toHaveLength(1)
    expect(policies[0]!({ url: 'https://shop.test/panier' })).toBe("script-src 'none'")
    expect(policies[0]!({ url: 'https://news.test/' })).toBeNull()
    expect(cspFor).not.toHaveBeenCalled()
    // A site added later is read from the settings of that moment: the hook is not installed again.
    set({ siteJavascriptOff: ['shop.test', 'news.test'] })
    guard.configure()
    expect(policies).toHaveLength(1)
    expect(policies[0]!({ url: 'https://news.test/' })).toBe("script-src 'none'")
  })

  it('joins the blocker\'s policy and the JavaScript one in a single value, and takes the hook away when the list is emptied', () => {
    const { guard, policies, cspFor, set } = setup({ blockAds: true, blockScriptlets: true, siteJavascriptOff: ['shop.test'] })
    cspFor.mockReturnValue("img-src 'self'")
    guard.configure()
    expect(policies[0]!({ url: 'https://shop.test/' })).toBe("img-src 'self'; script-src 'none'")
    expect(policies[0]!({ url: 'https://news.test/' })).toBe("img-src 'self'")
    set({ ...adsBlockingPatch(false), blockScriptlets: false, siteJavascriptOff: [] })
    guard.configure()
    expect(policies.map((p) => p !== null)).toEqual([true, false])
  })

  it('costs nothing with the list empty: no hook, nothing asked of the blocker', () => {
    const { guard, policies, cspFor } = setup({ ...adsBlockingPatch(false), siteJavascriptOff: [] })
    guard.configure()
    expect(policies).toEqual([])
    expect(cspFor).not.toHaveBeenCalled()
  })

  it('takes both away again when the features go off, and only once', () => {
    const { guard, guards, policies, set } = setup({ blockAds: true, blockScriptlets: true })
    guard.configure()
    set({ blockScriptlets: false, ...adsBlockingPatch(false) })
    guard.configure()
    guard.configure()
    expect(guards.map((g) => g !== null)).toEqual([true, false])
    expect(policies.map((p) => p !== null)).toEqual([true, false])
  })

  // The gate of the guard is the blocker's (shared/blocker.ts): `blockAds` and its alias `blockTrackers` either one, never `blockAds` alone.
  it.each([
    { blockAds: false, blockTrackers: false, armed: false },
    { blockAds: true, blockTrackers: false, armed: true },
    { blockAds: false, blockTrackers: true, armed: true },
    { blockAds: true, blockTrackers: true, armed: true }
  ])('the YouTube player rules arm the guard from the ads and trackers switch (blockAds $blockAds, blockTrackers $blockTrackers): armed $armed', ({ blockAds, blockTrackers, armed }) => {
    const { guard, guards } = setup({ blockAds, blockTrackers, blockScriptlets: false, blockCookieBanners: false, reduceFingerprint: false })
    guard.configure()
    expect(guards.map((g) => g !== null)).toEqual(armed ? [true] : [])
  })

  it.each([
    { blockAds: false, blockTrackers: false, blockCookieBanners: false, applied: false },
    { blockAds: false, blockTrackers: true, blockCookieBanners: false, applied: true },
    { blockAds: false, blockTrackers: false, blockCookieBanners: true, applied: true },
    { blockAds: true, blockTrackers: false, blockCookieBanners: false, applied: true }
  ])('the extended rules (scriptlets, response policy) need one of the two switches: ads $blockAds, trackers $blockTrackers, banners $blockCookieBanners: applied $applied', ({ applied, ...switches }) => {
    const { guard, policies } = setup({ ...switches, blockScriptlets: true, reduceFingerprint: false })
    guard.configure()
    expect(policies.map((p) => p !== null)).toEqual(applied ? [true] : [])
  })

  it('answers a document from the settings of that moment: its scriptlets, and its fingerprint figures when the protection is on', () => {
    const { guard, guards, set, scriptlets } = setup({ blockAds: true, blockScriptlets: true })
    guard.configure()
    expect(planOf(guards[0]!, 'https://news.test/')).toEqual({ scriptlets: [{ id: 'abort-on-property-read', args: ['adsbygoogle'] }], fingerprint: null })
    set({ reduceFingerprint: true })
    const plan = planOf(guards[0]!, 'https://news.test/a')
    expect(plan.fingerprint).toMatchObject({ level: 'standard' })
    // The blocker was asked with the settings of that moment.
    expect(scriptlets.mock.calls.at(-1)![1].reduceFingerprint).toBe(true)
    set({ fingerprintStrict: true })
    expect(planOf(guards[0]!, 'https://news.test/a').fingerprint).toMatchObject({ level: 'strict' })
  })

  it('serves the fingerprint protection alone, with no scriptlet asked for', () => {
    const { guard, guards, policies } = setup({ reduceFingerprint: true, ...adsBlockingPatch(false) })
    guard.configure()
    expect(guards).toHaveLength(1)
    expect(policies).toEqual([])
    expect(planOf(guards[0]!, 'https://news.test/')).toMatchObject({ scriptlets: [], fingerprint: { level: 'standard' } })
  })

  it('hands the engine what the frames and the workers get while the fingerprint protection is on, and takes it away with it: the scriptlets alone ask for none', () => {
    const { guard, inners, set } = setup({ blockAds: true, blockScriptlets: true })
    guard.configure()
    expect(inners).toEqual([])
    set({ reduceFingerprint: true })
    guard.configure()
    guard.configure()
    expect(inners).toHaveLength(1)
    // The strength is the one of the moment, and the seed is the session's, not a site's.
    const first = inners[0]!()
    expect(first).toMatchObject({ level: 'standard', maxCores: 8 })
    set({ fingerprintStrict: true })
    expect(inners[0]!()).toMatchObject({ level: 'strict', seed: first!.seed })
    set({ reduceFingerprint: false })
    // A provider still held while the setting goes off answers nothing.
    expect(inners[0]!()).toBeNull()
    guard.configure()
    expect(inners.map((p) => p !== null)).toEqual([true, false])
  })

  it('gives nothing to a site left out, nor to a page that is not a web page', () => {
    const { guard, guards } = setup({ reduceFingerprint: true, ...adsBlockingPatch(false), fingerprintExceptions: ['news.test'] })
    guard.configure()
    expect(planOf(guards[0]!, 'https://sub.news.test/')).toEqual({ scriptlets: [], fingerprint: null })
    expect(planOf(guards[0]!, 'about:blank').fingerprint).toBeNull()
    expect(planOf(guards[0]!, 'file:///tmp/a.html').fingerprint).toBeNull()
    expect(planOf(guards[0]!, 'https://other.test/').fingerprint).not.toBeNull()
  })

  it('gives the pages of the protected sites their WebRTC policy, takes it back from the others, and does not repeat itself', () => {
    const { guard, page, set } = setup({ reduceFingerprint: true, fingerprintExceptions: ['skip.test'] })
    const a = page('a', 'https://news.test/')
    const b = page('b', 'https://skip.test/')
    guard.configure()
    expect(a.page.setWebRtcPolicy).toHaveBeenCalledWith('default_public_interface_only')
    expect(b.page.setWebRtcPolicy).not.toHaveBeenCalled()
    guard.refreshPages()
    expect(a.page.setWebRtcPolicy).toHaveBeenCalledTimes(1)
    // The page moves to the site that is left out.
    a.url = 'https://skip.test/'
    guard.applyToPage('a', a.page, a.url)
    expect(a.page.setWebRtcPolicy).toHaveBeenLastCalledWith(null)
    // Switched off: the policy goes back to Chromium's.
    b.url = 'https://news.test/'
    guard.applyToPage('b', b.page, b.url)
    set({ reduceFingerprint: false })
    guard.configure()
    expect(b.page.setWebRtcPolicy).toHaveBeenLastCalledWith(null)
    expect(b.page.setWebRtcPolicy).toHaveBeenCalledTimes(2)
  })

  it('forgets a page that is gone, so a new page of the same id starts clean', () => {
    const { guard, page } = setup({ reduceFingerprint: true })
    const a = page('a', 'https://news.test/')
    guard.applyToPage('a', a.page, a.url)
    guard.forget('a')
    guard.applyToPage('a', a.page, a.url)
    expect(a.page.setWebRtcPolicy).toHaveBeenCalledTimes(2)
  })

  it('forgets the pages when the window closes, and leaves the engine to the window that takes over', () => {
    const { guard, guards, policies, page } = setup({ blockAds: true, blockScriptlets: true, reduceFingerprint: true })
    const a = page('a', 'https://news.test/')
    guard.configure()
    guard.stop()
    expect(guards.map((g) => g !== null)).toEqual([true])
    expect(policies.map((p) => p !== null)).toEqual([true])
    // A page of the same id in a window made afterwards starts clean.
    guard.applyToPage('a', a.page, a.url)
    expect(a.page.setWebRtcPolicy).toHaveBeenCalledTimes(2)
  })
})

describe('the seeds of the noise', () => {
  const seeds = (byte = 1) => new SiteSeeds(() => Buffer.alloc(16, byte))

  it('is the same for a site wherever on it, different for another site, and different with another key', () => {
    const a = seeds()
    expect(a.seedFor('https://www.news.test/a')).toBe(a.seedFor('https://sub.news.test/b?x=1'))
    expect(a.seedFor('https://news.test/')).not.toBe(a.seedFor('https://other.test/'))
    expect(seeds(2).seedFor('https://news.test/')).not.toBe(a.seedFor('https://news.test/'))
    // Every `*.github.io` is a site of its own.
    expect(a.seedFor('https://one.github.io/')).not.toBe(a.seedFor('https://two.github.io/'))
  })

  it('is an unsigned 32-bit integer, also for a host without a registrable domain', () => {
    const a = seeds()
    for (const url of ['https://news.test/', 'http://localhost:3000/', 'http://192.168.0.1/', 'https://[::1]/']) {
      const seed = a.seedFor(url)
      expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, url).toBe(true)
    }
  })

  it('has a number of its own for the pages nobody heard of yet, which is the seed of no site and changes with the key', () => {
    const a = seeds()
    expect(a.salt()).toBe(a.salt())
    expect(Number.isInteger(a.salt()) && a.salt() >= 0 && a.salt() <= 0xffffffff).toBe(true)
    for (const url of ['https://news.test/', 'http://localhost/', '']) expect(a.salt()).not.toBe(a.seedFor(url))
    expect(seeds(2).salt()).not.toBe(a.salt())
  })

  it('draws its key once, when first asked, and from the random source it was given', () => {
    const random = vi.fn(() => Buffer.alloc(16, 9))
    const s = new SiteSeeds(random)
    expect(random).not.toHaveBeenCalled()
    s.seedFor('https://a.test/')
    s.seedFor('https://b.test/')
    expect(random).toHaveBeenCalledTimes(1)
    expect(random).toHaveBeenCalledWith(16)
  })

  it('draws a new key for each instance with the real source: two sessions share no noise', () => {
    expect(new SiteSeeds().seedFor('https://news.test/')).not.toBe(new SiteSeeds().seedFor('https://news.test/'))
  })
})
