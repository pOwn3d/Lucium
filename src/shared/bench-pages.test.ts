import { describe, expect, it } from 'vitest'
import { BeaconLog, MAX_PAGES, MAX_RUNS, PAGE_HEADERS, PAGE_KINDS, hostAllowed, missingPages, pageKind, pageUrl, renderPage, routeRequest } from './bench-pages'

const TOKEN = 'abcdef123456' // gitleaks:allow (invented for this test, the secret of no service)

describe('the pages', () => {
  it('cycle through five kinds, so that ten pages hold two of each and thirty hold six', () => {
    const kinds = (count: number) => Array.from({ length: count }, (_, i) => pageKind(i + 1))
    for (const kind of PAGE_KINDS) {
      expect(kinds(10).filter((k) => k === kind)).toHaveLength(2)
      expect(kinds(30).filter((k) => k === kind)).toHaveLength(6)
    }
    expect(kinds(30).slice(0, 10)).toEqual(kinds(10))
  })

  it('are the same at every request, and differ from one page to the next', () => {
    expect(renderPage(3, TOKEN)).toBe(renderPage(3, TOKEN))
    expect(renderPage(1, TOKEN)).not.toBe(renderPage(6, TOKEN))
    expect(renderPage(1, TOKEN)).not.toBe(renderPage(1, 'zzzzzzzz9999'))
  })

  it('ask nothing from outside the machine', () => {
    for (let n = 1; n <= 10; n++) {
      const html = renderPage(n, TOKEN)
      expect(html).not.toMatch(/https?:\/\//)
      expect(html).not.toMatch(/<(link|img|iframe|script)[^>]* (src|href)=/i)
    }
    const csp = PAGE_HEADERS['Content-Security-Policy'] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('*')
  })

  it('report themselves with their run and their number', () => {
    const html = renderPage(7, TOKEN)
    expect(html).toContain(`var T="${TOKEN}",N=7;`)
    expect(html).toContain("'/hello?p='+N")
    expect(html).toContain('visibilitychange')
  })

  it('have the weight of the kind they stand for', () => {
    expect(renderPage(1, TOKEN).length).toBeGreaterThan(20_000)
    expect((renderPage(3, TOKEN).match(/<li>/g) ?? []).length).toBe(1500)
    expect(renderPage(2, TOKEN)).toContain('setInterval')
    expect(renderPage(4, TOKEN)).toContain('<canvas')
    expect(renderPage(5, TOKEN)).toContain('animation:spin')
    expect(renderPage(1, TOKEN)).not.toContain('setInterval')
  })

  it('refuse a token or a number that would end up inside a script', () => {
    for (const token of ['', 'short', '"><script>alert(1)</script>', 'ABCDEFGH1234', 'abc def 12345', 'a'.repeat(33)]) expect(() => renderPage(1, token)).toThrow()
    for (const n of [0, -1, 1.5, MAX_PAGES + 1, Number.NaN]) expect(() => renderPage(n, TOKEN)).toThrow()
    expect(() => pageUrl('http://127.0.0.1:1', 'x', 1)).toThrow()
    expect(pageUrl('http://127.0.0.1:8123', TOKEN, 12)).toBe(`http://127.0.0.1:8123/r/${TOKEN}/p/12`)
  })
})

describe('the beacon log and the routes', () => {
  const at = 1000

  it('answers a page of an open run, and only a GET', () => {
    const log = new BeaconLog()
    log.open(TOKEN)
    const reply = routeRequest('GET', `/r/${TOKEN}/p/4`, log, at)
    expect(reply.status).toBe(200)
    expect(reply.type).toMatch(/^text\/html/)
    expect(reply.body).toBe(renderPage(4, TOKEN))
    expect(routeRequest('POST', `/r/${TOKEN}/p/4`, log, at).status).toBe(405)
  })

  it('knows nothing of a run that was not opened, which is how a tab restored from an earlier run counts for nothing', () => {
    const log = new BeaconLog()
    log.open(TOKEN)
    expect(routeRequest('GET', '/r/otherrun1234/p/1', log, at).status).toBe(404)
    expect(routeRequest('GET', '/r/otherrun1234/hello?p=1&v=visible', log, at).status).toBe(404)
    expect(log.loaded('otherrun1234')).toEqual([])
  })

  it('counts the pages that said hello, once each, and how many are shown', () => {
    const log = new BeaconLog()
    log.open(TOKEN)
    for (const n of [3, 1, 2, 2]) expect(routeRequest('GET', `/r/${TOKEN}/hello?p=${n}&v=${n === 1 ? 'visible' : 'hidden'}`, log, at).status).toBe(204)
    expect(log.loaded(TOKEN)).toEqual([1, 2, 3])
    expect(log.visibleCount(TOKEN)).toBe(1)
    routeRequest('POST', `/r/${TOKEN}/vis?p=2&v=visible`, log, at)
    routeRequest('POST', `/r/${TOKEN}/vis?p=1&v=hidden`, log, at)
    expect(log.visibleCount(TOKEN)).toBe(1)
    routeRequest('GET', `/r/${TOKEN}/vis?p=3&v=visible`, log, at)
    expect(log.visibleCount(TOKEN)).toBe(2)
  })

  it('counts the pings of the pages that refresh themselves', () => {
    const log = new BeaconLog()
    log.open(TOKEN)
    routeRequest('GET', `/r/${TOKEN}/hello?p=3&v=visible`, log, at)
    routeRequest('GET', `/r/${TOKEN}/ping?p=3`, log, at)
    routeRequest('GET', `/r/${TOKEN}/ping?p=3`, log, at)
    routeRequest('GET', `/r/${TOKEN}/ping?p=8`, log, at)
    expect(log.pings(TOKEN)).toBe(2)
  })

  it('refuses a page number that is not a page of the bench, and a method that is not one of a beacon', () => {
    const log = new BeaconLog()
    log.open(TOKEN)
    for (const query of ['', '?p=0', '?p=abc', `?p=${MAX_PAGES + 1}`, '?p=1.5']) expect(routeRequest('GET', `/r/${TOKEN}/hello${query}`, log, at).status).toBe(400)
    expect(log.loaded(TOKEN)).toEqual([])
    expect(routeRequest('PUT', `/r/${TOKEN}/hello?p=1`, log, at).status).toBe(405)
    expect(routeRequest('GET', `/r/${TOKEN}/p/${MAX_PAGES + 1}`, log, at).status).toBe(404)
  })

  it('answers 404 to every other address', () => {
    const log = new BeaconLog()
    log.open(TOKEN)
    for (const path of ['/', '/favicon.ico', `/r/${TOKEN}`, `/r/${TOKEN}/`, `/r/${TOKEN}/p/`, `/r/${TOKEN}/p/1/x`, `/r/${TOKEN}/../etc/passwd`, `/r/${TOKEN}/other`, '/r/../p/1', '//evil/r/x']) {
      expect(routeRequest('GET', path, log, at).status).toBe(404)
    }
  })

  it('opens a run only with a token of the right shape, and a bounded number of runs', () => {
    const log = new BeaconLog()
    expect(() => log.open('../x')).toThrow()
    for (let i = 0; i < MAX_RUNS; i++) log.open(`run${String(i).padStart(8, '0')}`)
    expect(() => log.open('onemore12345')).toThrow(/too many/)
    log.open('run00000000')
  })

  it('finds the pages that did not report themselves', () => {
    expect(missingPages([1, 2, 4], 5)).toEqual([3, 5])
    expect(missingPages([], 3)).toEqual([1, 2, 3])
    expect(missingPages([1, 2, 3], 3)).toEqual([])
  })

  it('accepts a request that came to the address of the bench, and no other name', () => {
    expect(hostAllowed('127.0.0.1:5000', 5000)).toBe(true)
    expect(hostAllowed('localhost:5000', 5000)).toBe(true)
    expect(hostAllowed('evil.example:5000', 5000)).toBe(false)
    expect(hostAllowed('127.0.0.1:5001', 5000)).toBe(false)
    expect(hostAllowed(undefined, 5000)).toBe(false)
  })
})
