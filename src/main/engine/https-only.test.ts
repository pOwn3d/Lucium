// « HTTPS seul » in the memory of the upgrades (https-upgrade.ts): the same upgrade as HTTPS first, but no fall back to http by itself, whatever the failure
// (a site that does not answer, a certificate, a site that sends its https visitors back to http), a refusal for an http address that cannot be upgraded,
// and the way through only on a click (« Continuer en HTTP »).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpsUpgrades, type UpgradeTarget } from './https-upgrade'

const PAGE = 7
const HTTP = 'http://exemple.fr/p?a=1'
const HTTPS = 'https://exemple.fr/p?a=1'
const NONE: readonly string[] = []

function target(): UpgradeTarget & { navigated: string[]; hosts: string[]; stopped: number } {
  const state = { navigated: [] as string[], hosts: [] as string[], stopped: 0 }
  return Object.assign(state, { navigate: (url: string) => void state.navigated.push(url), isLoading: () => true, stop: () => void state.stopped++, fellBack: (host: string) => void state.hosts.push(host) })
}
const attached = () => {
  const upgrades = new HttpsUpgrades()
  const page = target()
  upgrades.attach(PAGE, page)
  return { upgrades, page }
}

describe('onlyVerdict', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends an http address of a public site to https, and leaves a page it does not know alone', () => {
    const { upgrades } = attached()
    expect(upgrades.onlyVerdict(PAGE, HTTP, NONE)).toEqual({ redirect: HTTPS })
    expect(upgrades.onlyVerdict(99, HTTP, NONE)).toBeNull()
  })

  it('leaves alone what is not http, the local network and this machine, and the sites of the list of exceptions (subdomains included)', () => {
    const { upgrades } = attached()
    expect(upgrades.onlyVerdict(PAGE, 'https://exemple.fr/', NONE)).toBeNull()
    for (const local of ['http://localhost:3000/', 'http://192.168.1.20/', 'http://nas.local/', 'http://intranet/']) expect(upgrades.onlyVerdict(PAGE, local, NONE), local).toBeNull()
    expect(upgrades.onlyVerdict(PAGE, 'http://www.exemple.fr/a', ['exemple.fr'])).toBeNull()
    expect(upgrades.onlyVerdict(PAGE, 'http://autre.fr/a', ['exemple.fr'])).toEqual({ redirect: 'https://autre.fr/a' })
  })

  it('refuses an http address of a public site that cannot be upgraded (a port, a login in the address), instead of letting it open', () => {
    const { upgrades } = attached()
    expect(upgrades.onlyVerdict(PAGE, 'http://exemple.fr:8080/', NONE)).toBe('refuse')
    expect(upgrades.onlyVerdict(PAGE, 'http://moi:mdp@exemple.fr/', NONE)).toBe('refuse')
  })

  it('refuses the second time a site sends its https visitors back to http, where HTTPS first would let the page open', () => {
    const { upgrades } = attached()
    expect(upgrades.onlyVerdict(PAGE, HTTP, NONE)).toEqual({ redirect: HTTPS })
    expect(upgrades.onlyVerdict(PAGE, HTTP, NONE)).toBe('refuse')
    expect(upgrades.upgrade(PAGE, 'http://autre.fr/')).toBe('https://autre.fr/')
    expect(upgrades.upgrade(PAGE, 'http://autre.fr/')).toBeNull()
  })

  it('does not fall back to http when the site does not answer: the load is left to fail, and the failure asks for the page of the warning', () => {
    const { upgrades, page } = attached()
    upgrades.onlyVerdict(PAGE, HTTP, NONE)
    vi.advanceTimersByTime(60_000)
    expect(page.navigated).toEqual([])
    expect(page.stopped).toBe(0)
    expect(upgrades.failed(PAGE, HTTPS, -102)).toEqual({ kind: 'refused', http: HTTP, only: true })
    expect(page.navigated).toEqual([])
    expect(page.hosts).toEqual([])
  })

  it('does not fall back to http for a certificate that is not valid either: the error page offers the address on a click', () => {
    const { upgrades, page } = attached()
    upgrades.onlyVerdict(PAGE, HTTP, NONE)
    expect(upgrades.failed(PAGE, HTTPS, -202, true)).toEqual({ kind: 'refused', http: HTTP, only: true })
    expect(page.navigated).toEqual([])
  })

  it('asks for the page of the warning when the refused address fails to load, and only for that address', () => {
    const { upgrades } = attached()
    expect(upgrades.onlyVerdict(PAGE, 'http://exemple.fr:8080/x', NONE)).toBe('refuse')
    expect(upgrades.failed(PAGE, 'http://exemple.fr:8080/other', -20)).toEqual({ kind: 'none' })
    expect(upgrades.onlyVerdict(PAGE, 'http://exemple.fr:8080/x', NONE)).toBe('refuse')
    expect(upgrades.failed(PAGE, 'http://exemple.fr:8080/x', -20)).toEqual({ kind: 'refused', http: 'http://exemple.fr:8080/x', only: true })
  })

  it('opens the http address on the click, once, and asks again for the next one', () => {
    const { upgrades, page } = attached()
    upgrades.onlyVerdict(PAGE, 'http://exemple.fr:8080/x', NONE)
    upgrades.failed(PAGE, 'http://exemple.fr:8080/x', -20)
    upgrades.continueOverHttp(PAGE, 'http://exemple.fr:8080/x')
    expect(page.navigated).toEqual(['http://exemple.fr:8080/x'])
    expect(upgrades.onlyVerdict(PAGE, 'http://exemple.fr:8080/x', NONE)).toBeNull()
    expect(upgrades.onlyVerdict(PAGE, 'http://exemple.fr:8080/x', NONE)).toBe('refuse')
  })

  it('leaves HTTPS first as it was: the timer falls back to http, no refusal', () => {
    const { upgrades, page } = attached()
    upgrades.upgrade(PAGE, HTTP)
    vi.advanceTimersByTime(6000)
    expect(page.navigated).toEqual([HTTP])
    expect(upgrades.failed(PAGE, HTTPS, -102)).toEqual({ kind: 'none' })
  })
})
