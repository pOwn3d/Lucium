import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { adsBlockingOn, adsBlockingPatch, blockerIsOn, countedTabs, protections, summarizeBlocked } from './privacy-dashboard'

describe('the privacy dashboard', () => {
  it('lists the seven protections with whether each is on, from the settings and nothing else', () => {
    const off = protections({ ...defaultSettings(), blockAds: false, blockTrackers: false, blockCookieBanners: false, reduceFingerprint: false, httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, dohCustom: false })
    expect(off.map((p) => p.id)).toEqual(['ads', 'banners', 'fingerprint', 'https', 'gpc', 'tracking-params', 'dns'])
    expect(off.every((p) => !p.on && p.label.length > 0)).toBe(true)
    const some = protections({ ...defaultSettings(), blockAds: true, blockCookieBanners: false, httpsUpgrade: true, sendGpc: false, reduceFingerprint: false, stripTrackingParams: false, dohCustom: false })
    expect(some.filter((p) => p.on).map((p) => p.id)).toEqual(['ads', 'https'])
  })

  it('turns the ads and the trackers off with one patch, whatever the alias held (the blocker reads either)', () => {
    expect(adsBlockingOn({ blockAds: false, blockTrackers: true })).toBe(true)
    // The defaults hold both keys on: one patch must turn off what the blocker reads.
    expect(adsBlockingOn({ ...defaultSettings(), ...adsBlockingPatch(false) })).toBe(false)
    expect(adsBlockingOn(adsBlockingPatch(true))).toBe(true)
  })

  it('says the blocker is off only when both its options are', () => {
    expect(blockerIsOn({ blockAds: false, blockCookieBanners: false })).toBe(false)
    expect(blockerIsOn({ blockAds: false, blockCookieBanners: true })).toBe(true)
  })

  it('counts the pages of the web only, never a private tab or an internal page', () => {
    const tabs = [
      { id: 'a', url: 'https://news.example/x' },
      { id: 'b', url: 'https://secret.example/', private: true },
      { id: 'c', url: 'lucium://newtab' },
      { id: 'd', url: 'file:///Users/me/doc.html' },
      { id: 'e', url: 'http://plain.example/' }
    ]
    expect(countedTabs(tabs)).toEqual([{ id: 'a', url: 'https://news.example/x' }, { id: 'e', url: 'http://plain.example/' }])
  })

  it('gathers the counters by site, the most blocked first, and names the sites left alone', () => {
    const tabs = [
      { id: '1', url: 'https://www.news.example/a' },
      { id: '2', url: 'https://news.example/b' },
      { id: '3', url: 'https://shop.example/' },
      { id: '4', url: 'https://quiet.example/' },
      { id: '5', url: 'https://friend.example/' }
    ]
    const summary = summarizeBlocked(tabs, { '1': 4, '2': 3, '3': 9, '5': 0 }, ['friend.example'])
    expect(summary.total).toBe(16)
    // `www.` is the same site; a page that blocked nothing is not listed, but a site where nothing is blocked is.
    expect(summary.sites).toEqual([
      { host: 'shop.example', blocked: 9, exempt: false },
      { host: 'news.example', blocked: 7, exempt: false },
      { host: 'friend.example', blocked: 0, exempt: true }
    ])
  })

  it('has nothing to list when no page was counted', () => {
    expect(summarizeBlocked([], {}, [])).toEqual({ total: 0, sites: [] })
  })
})
