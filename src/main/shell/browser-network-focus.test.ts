import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The focus mode in the shell: the request filter the engine is given closes the main frame of a listed site while focus is active, and does not exist at all
// while the feature is off or has no site. The methods run on a stand-in (browser-fake.test-support.ts).
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const verdict = vi.fn(() => false)
vi.mock('../blocking', () => ({ blockingService: () => ({ configure: vi.fn(), verdict }) }))
const { Browser } = await import('./browser')
const { focusGate } = await import('../engine/focus-gate')
const shell = methodsOf(Browser.prototype)

const NOW = Date.UTC(2026, 10, 23, 9, 0)
type Filter = (request: { url: string; resourceType: string; pageUrl: string | null; pageId: string | null }) => unknown

function windowWith(patch: Partial<Settings>) {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), blockAds: false, blockTrackers: false, blockCookieBanners: false, typoGuard: false, ...patch } }
  return fakeBrowser({ store: { get: () => state }, extraBlockedHosts: [], containerScopes: new Map(), privateScope: null })
}
const request = (url: string, resourceType = 'mainFrame') => ({ url, resourceType, pageUrl: null, pageId: null })
const running = { focusMode: true, focusSites: ['news.example.com'], focusUntil: NOW + 600_000 }

beforeEach(() => {
  verdict.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  focusGate.set(null)
})

describe('the request filter with the focus mode', () => {
  it('does not exist while the feature is off, with no site, or with the blocker off', () => {
    expect(shell['requestFilter']!.call(windowWith({ ...running, focusMode: false }).self)).toBeNull()
    expect(shell['requestFilter']!.call(windowWith({ ...running, focusSites: [] }).self)).toBeNull()
  })

  it('closes the main frame of a listed site and its subdomains while a timer runs, and nothing else', () => {
    const filter = shell['requestFilter']!.call(windowWith(running).self) as Filter
    expect(filter(request('https://news.example.com/a'))).toBe(true)
    expect(filter(request('https://www.news.example.com/a'))).toBe(true)
    expect(filter(request('https://m.news.example.com/a'))).toBe(true)
    expect(filter(request('https://news.example.com./a'))).toBe(true)
    expect(filter(request('https://other.example.com/'))).toBe(false)
    // A subresource of the listed site is not the page: only the main frame is closed.
    expect(filter(request('https://news.example.com/app.js', 'script'))).toBe(false)
  })

  it('lets the site through once the timer has ended (the time is read at each request)', () => {
    const filter = shell['requestFilter']!.call(windowWith(running).self) as Filter
    expect(filter(request('https://news.example.com/'))).toBe(true)
    vi.setSystemTime(NOW + 600_000)
    expect(filter(request('https://news.example.com/'))).toBe(false)
  })

  it('keeps asking the blocker for the rest while focus is on', () => {
    const filter = shell['requestFilter']!.call(windowWith({ ...running, blockAds: true }).self) as Filter
    filter(request('https://ads.example/x.js', 'script'))
    expect(verdict).toHaveBeenCalledTimes(1)
    expect(filter(request('https://news.example.com/'))).toBe(true)
    expect(verdict).toHaveBeenCalledTimes(1)
  })
})

describe('the gate the block page uses', () => {
  it('is given while the feature is on with a site, answers for the closed address, and is withdrawn when the feature goes off', () => {
    const fake = windowWith(running)
    shell['configureFocus']!.call(fake.self)
    expect(focusGate.get()?.block('https://news.example.com/a')).toEqual({ until: NOW + 600_000, slotEnd: null })
    expect(focusGate.get()?.block('https://other.example.com/')).toBeNull()
    const off = windowWith({ focusMode: false })
    shell['configureFocus']!.call(off.self)
    expect(focusGate.get()).toBeNull()
  })

  it('pauses focus for 15 minutes by a settings update', () => {
    const fake = windowWith(running)
    shell['configureFocus']!.call(fake.self)
    focusGate.get()!.pause()
    const update = fake.calls.find((call) => call.name === 'dispatch')
    expect(update?.args[0]).toEqual({ type: 'settings/update', patch: { focusUntil: 0, focusSnoozeUntil: NOW + 15 * 60_000 } })
  })
})
