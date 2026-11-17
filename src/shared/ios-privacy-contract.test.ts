// The iOS application (ios/) re-implements the privacy rules of the Mac in Swift (tracking parameters, HTTPS first, the one rewrite of a request).
// The two sides are held together by shared vectors: this suite runs ios/Contracts/privacy-vectors.json against src/shared/privacy.ts, the Swift
// tests of LuciumKit run the same file against TrackingParams, HttpsUpgrade and PrivacyRules.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { httpsUpgradeOf, isUpgradableHost, rewriteNavigation, stripTrackingParams, type PrivacyOptions } from './privacy'

interface Vectors {
  trackingParams: { url: string; expect: string | null }[]
  isUpgradableHost: { host: string; expect: boolean }[]
  httpsUpgrade: { url: string; expect: string | null }[]
  rewrite: { url: string; method?: string; isMainFrame?: boolean; options: PrivacyOptions; expect: string | null }[]
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/privacy-vectors.json'), 'utf8')) as Vectors

describe('iOS contract: privacy vectors', () => {
  it('has vectors to run (an empty file would pass for nothing)', () => {
    expect(vectors.trackingParams.length).toBeGreaterThan(15)
    expect(vectors.isUpgradableHost.length).toBeGreaterThan(20)
    expect(vectors.httpsUpgrade.length).toBeGreaterThan(10)
    expect(vectors.rewrite.length).toBeGreaterThan(5)
  })

  it.each(vectors.trackingParams)('stripTrackingParams($url)', ({ url, expect: expected }) => {
    expect(stripTrackingParams(url)).toBe(expected)
  })

  it.each(vectors.isUpgradableHost)('isUpgradableHost($host)', ({ host, expect: expected }) => {
    expect(isUpgradableHost(host)).toBe(expected)
  })

  it.each(vectors.httpsUpgrade)('httpsUpgradeOf($url)', ({ url, expect: expected }) => {
    expect(httpsUpgradeOf(url)).toBe(expected)
  })

  it.each(vectors.rewrite)('rewriteNavigation($url, $options)', ({ url, method, isMainFrame, options, expect: expected }) => {
    const request = { url, method: method ?? 'GET', isMainFrame: isMainFrame ?? true }
    expect(rewriteNavigation(request, options, httpsUpgradeOf)).toBe(expected)
  })
})
