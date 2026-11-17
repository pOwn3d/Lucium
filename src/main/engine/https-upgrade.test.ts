import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpsUpgrades, type UpgradeTarget } from './https-upgrade'

const PAGE = 7
const HTTP = 'http://exemple.fr/p?a=1'
const HTTPS = 'https://exemple.fr/p?a=1'

function target(patch: Partial<UpgradeTarget> = {}): UpgradeTarget & { navigated: string[]; hosts: string[]; stopped: number } {
  const state = { navigated: [] as string[], hosts: [] as string[], stopped: 0 }
  return Object.assign(state, {
    navigate: (url: string) => void state.navigated.push(url),
    isLoading: () => true,
    stop: () => void state.stopped++,
    fellBack: (host: string) => void state.hosts.push(host),
    ...patch
  })
}

describe('HttpsUpgrades', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('upgrades the address of a page it knows, and leaves the others', () => {
    const upgrades = new HttpsUpgrades()
    expect(upgrades.upgrade(PAGE, HTTP)).toBeNull()
    upgrades.attach(PAGE, target())
    expect(upgrades.upgrade(PAGE, HTTP)).toBe(HTTPS)
    expect(upgrades.upgrade(PAGE, 'http://localhost/')).toBeNull()
  })

  it('goes back to the http address when the upgraded load fails, once, telling the page', () => {
    const upgrades = new HttpsUpgrades()
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    expect(upgrades.failed(PAGE, HTTPS, -102)).toEqual({ kind: 'fell-back' })
    expect(page.navigated).toEqual([HTTP])
    expect(page.hosts).toEqual(['exemple.fr'])
    // The http load that follows goes through as it is; the next time round the site is tried over https again.
    expect(upgrades.upgrade(PAGE, HTTP)).toBeNull()
    upgrades.committed(PAGE)
    expect(upgrades.upgrade(PAGE, HTTP)).toBe(HTTPS)
  })

  // Someone on the way can make the https attempt fail with any certificate; that is never a reason to serve the page in clear.
  it('never goes back to http by itself for a certificate that is not valid: the error page offers the http address instead', () => {
    const upgrades = new HttpsUpgrades()
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    expect(upgrades.failed(PAGE, HTTPS, -202, true)).toEqual({ kind: 'refused', http: HTTP })
    expect(page.navigated).toEqual([])
    expect(page.hosts).toEqual([])
    // Nor later, when the delay of the upgrade would have run out.
    vi.advanceTimersByTime(60_000)
    expect(page.navigated).toEqual([])
  })

  it('goes to the http address on the user\'s click, once, without upgrading it and without a notice', () => {
    const upgrades = new HttpsUpgrades()
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    upgrades.failed(PAGE, HTTPS, -202, true)
    upgrades.committed(PAGE)
    upgrades.continueOverHttp(PAGE, HTTP)
    expect(page.navigated).toEqual([HTTP])
    expect(page.hosts).toEqual([])
    expect(upgrades.upgrade(PAGE, HTTP)).toBeNull()
    upgrades.committed(PAGE)
    expect(upgrades.upgrade(PAGE, HTTP)).toBe(HTTPS)
  })

  it('opens only an http address on that click, and only for a page it knows', () => {
    const upgrades = new HttpsUpgrades()
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.continueOverHttp(PAGE, 'https://exemple.fr/')
    upgrades.continueOverHttp(PAGE, 'javascript:alert(1)')
    upgrades.continueOverHttp(8, HTTP)
    expect(page.navigated).toEqual([])
  })

  it('does not loop when a site sends https visitors back to http', () => {
    const upgrades = new HttpsUpgrades()
    upgrades.attach(PAGE, target())
    upgrades.navigationStarted(PAGE, HTTP)
    expect(upgrades.upgrade(PAGE, HTTP)).toBe(HTTPS)
    // https://exemple.fr redirects to http://exemple.fr/p?a=1 : the same address comes back to the hook within one navigation.
    expect(upgrades.upgrade(PAGE, HTTP)).toBeNull()
  })

  it('starts the guard over with a new navigation', () => {
    const upgrades = new HttpsUpgrades()
    upgrades.attach(PAGE, target())
    expect(upgrades.upgrade(PAGE, HTTP)).toBe(HTTPS)
    upgrades.navigationStarted(PAGE, HTTP)
    expect(upgrades.upgrade(PAGE, HTTP)).toBe(HTTPS)
  })

  it('falls back when the site does not start answering within the delay', () => {
    const upgrades = new HttpsUpgrades(5000)
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    vi.advanceTimersByTime(4999)
    expect(page.navigated).toEqual([])
    vi.advanceTimersByTime(2)
    expect(page.stopped).toBe(1)
    expect(page.navigated).toEqual([HTTP])
    expect(page.hosts).toEqual(['exemple.fr'])
  })

  it('does not fall back once the page committed', () => {
    const upgrades = new HttpsUpgrades(5000)
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    upgrades.committed(PAGE)
    vi.advanceTimersByTime(60_000)
    expect(page.navigated).toEqual([])
    expect(upgrades.pendingCount()).toBe(0)
  })

  it('does not fall back when the page is no longer loading (a download, a navigation that ended)', () => {
    const upgrades = new HttpsUpgrades(5000)
    const page = target({ isLoading: () => false })
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    vi.advanceTimersByTime(60_000)
    expect(page.navigated).toEqual([])
    expect(page.stopped).toBe(0)
  })

  it('drops the upgrade when the user went somewhere else meanwhile', () => {
    const upgrades = new HttpsUpgrades(5000)
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    upgrades.navigationStarted(PAGE, 'https://autre.fr/')
    vi.advanceTimersByTime(60_000)
    expect(page.navigated).toEqual([])
    expect(upgrades.failed(PAGE, HTTPS, -102)).toEqual({ kind: 'none' })
  })

  it('does not treat a cancelled load as a failure of the site', () => {
    const upgrades = new HttpsUpgrades()
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    expect(upgrades.failed(PAGE, HTTPS, -3)).toEqual({ kind: 'none' })
    expect(page.navigated).toEqual([])
  })

  it('does not fall back for a failure on another host', () => {
    const upgrades = new HttpsUpgrades()
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    expect(upgrades.failed(PAGE, 'https://autre.fr/', -105)).toEqual({ kind: 'none' })
    expect(page.navigated).toEqual([])
  })

  it('keeps the pages apart', () => {
    const upgrades = new HttpsUpgrades()
    const a = target()
    const b = target()
    upgrades.attach(1, a)
    upgrades.attach(2, b)
    upgrades.upgrade(1, HTTP)
    expect(upgrades.failed(2, HTTPS, -102)).toEqual({ kind: 'none' })
    expect(b.navigated).toEqual([])
    expect(upgrades.failed(1, HTTPS, -102)).toEqual({ kind: 'fell-back' })
    expect(a.navigated).toEqual([HTTP])
  })

  it('forgets a page that went away, timer included', () => {
    const upgrades = new HttpsUpgrades(5000)
    const page = target()
    upgrades.attach(PAGE, page)
    upgrades.upgrade(PAGE, HTTP)
    upgrades.detach(PAGE)
    vi.advanceTimersByTime(60_000)
    expect(page.navigated).toEqual([])
    expect(upgrades.upgrade(PAGE, HTTP)).toBeNull()
  })
})
