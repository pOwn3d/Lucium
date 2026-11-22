import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { packHosts } from '@shared/safe-set'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// Safe browsing in the shell: the request filter the engine is given closes the main frame of a listed host while the feature is on, and does not exist at all
// while it is off. The lists are read from a folder of the test (main/safe-lists.ts). The methods run on a stand-in (browser-fake.test-support.ts).
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const dir = mkdtempSync(join(tmpdir(), 'safe-shell-'))
writeFileSync(join(dir, 'phishing.bin'), packHosts(['phish.example']))
writeFileSync(join(dir, 'malware.bin'), packHosts(['malware.example']))
vi.mock('../safe-lists', async (original) => {
  const real = await original<typeof import('../safe-lists')>()
  return { ...real, safeLists: () => real.safeLists(dir) }
})
const verdict = vi.fn(() => false)
vi.mock('../blocking', () => ({ blockingService: () => ({ configure: vi.fn(), verdict }) }))
const { Browser } = await import('./browser')
const { safeGate } = await import('../engine/safe-gate')
const { safeListsLoaded, safeAllowedHosts } = await import('../safe-lists')
const shell = methodsOf(Browser.prototype)

type Filter = (request: { url: string; resourceType: string; pageUrl: string | null; pageId: string | null }) => unknown

function windowWith(patch: Partial<Settings>, extra: Record<string, unknown> = {}) {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), blockAds: false, blockTrackers: false, blockCookieBanners: false, ...patch } }
  return fakeBrowser({ store: { get: () => state }, extraBlockedHosts: [], containerScopes: new Map(), privateScope: null, ...extra })
}
const request = (url: string, resourceType = 'mainFrame') => ({ url, resourceType, pageUrl: null, pageId: null })

beforeEach(() => {
  verdict.mockClear()
  safeGate.set(null)
})

describe('the request filter with safe browsing', () => {
  it('does not exist while the feature is off (and the lookalike guard too), and reads no list', () => {
    expect(shell['requestFilter']!.call(windowWith({ safeBrowsing: false, typoGuard: false }).self)).toBeNull()
    expect(safeListsLoaded()).toBe(false)
  })

  it('closes the main frame of a listed host, of either list, and nothing else', () => {
    const filter = shell['requestFilter']!.call(windowWith({ safeBrowsing: true }).self) as Filter
    expect(filter(request('https://phish.example/login'))).toBe(true)
    expect(filter(request('http://malware.example/a.exe'))).toBe(true)
    expect(filter(request('https://good.example/'))).toBe(false)
    // A subresource of a listed host is not the page: only the main frame is closed.
    expect(filter(request('https://phish.example/app.js', 'script'))).toBe(false)
    // An internal page is never looked at.
    expect(filter(request('lucium://phish.example/'))).toBe(false)
  })

  it('lets a site the user excepted through, and reads the exceptions at each request', () => {
    const fake = windowWith({ safeBrowsing: true, safeBrowsingExceptions: ['phish.example'] })
    const filter = shell['requestFilter']!.call(fake.self) as Filter
    expect(filter(request('https://phish.example/'))).toBe(false)
  })

  it('keeps asking the blocker for the rest while it is on', () => {
    const filter = shell['requestFilter']!.call(windowWith({ safeBrowsing: true, blockAds: true }).self) as Filter
    filter(request('https://ads.example/x.js', 'script'))
    expect(verdict).toHaveBeenCalledTimes(1)
    expect(filter(request('https://phish.example/'))).toBe(true)
    expect(verdict).toHaveBeenCalledTimes(1)
  })
})

describe('the gate the warning page uses', () => {
  it('is given while the feature is on, answers for a listed address, lets a host through for the run, and is withdrawn when the feature goes off', () => {
    shell['configureSafeBrowsing']!.call(windowWith({ safeBrowsing: true }).self)
    expect(safeGate.get()?.verdict('https://phish.example/a')).toEqual({ category: 'phishing', host: 'phish.example' })
    expect(safeGate.get()?.verdict('https://good.example/')).toBeNull()
    safeGate.get()!.allow('https://phish.example/a?x=1')
    expect(safeAllowedHosts().has('phish.example')).toBe(true)
    expect(safeGate.get()?.verdict('https://phish.example/a')).toBeNull()
    shell['configureSafeBrowsing']!.call(windowWith({ safeBrowsing: false }).self)
    expect(safeGate.get()).toBeNull()
    expect(safeListsLoaded()).toBe(false)
    expect(safeAllowedHosts().size).toBe(0)
  })

  it('writes « Ne plus prévenir pour ce site » to the lasting exceptions, once, and the site is then let through', () => {
    const dispatch = vi.fn()
    shell['configureSafeBrowsing']!.call(windowWith({ safeBrowsing: true, safeBrowsingExceptions: ['old.example'] }, { dispatch, group: new Set() }).self)
    safeGate.get()!.except('https://Phish.example./a?x=1')
    expect(dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { safeBrowsingExceptions: ['old.example', 'phish.example'] } })
    dispatch.mockClear()
    shell['configureSafeBrowsing']!.call(windowWith({ safeBrowsing: true, safeBrowsingExceptions: ['phish.example'] }, { dispatch, group: new Set() }).self)
    safeGate.get()!.except('https://phish.example/')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not write to the saved settings a site a private window is on: it opens for this run only', () => {
    const dispatch = vi.fn()
    const privateWindow = { isPrivate: () => true, store: { get: () => ({ tabs: [] }) } }
    shell['configureSafeBrowsing']!.call(windowWith({ safeBrowsing: true }, { dispatch, group: new Set([privateWindow]) }).self)
    safeGate.get()!.except('https://phish.example/')
    expect(dispatch).not.toHaveBeenCalled()
    expect(safeAllowedHosts().has('phish.example')).toBe(true)
  })

  it('reads the lists when the feature goes on, so that Settings can tell at once whether they are there', () => {
    shell['configureSafeBrowsing']!.call(windowWith({ safeBrowsing: true }).self)
    expect(safeListsLoaded()).toBe(true)
  })
})
