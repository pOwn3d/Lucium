// What the blocker costs with a list of the size of the real ones (150 000 rules): time to bring the engine up (compiled, then from the file kept on
// disk), memory the engines keep, time per request in each mode, and time per page for the hiding rules. The numbers are printed;
// the assertions are loose bounds, set well above what a development machine measures, so that they catch a
// change that makes the blocker several times slower and nothing else. Local server only.

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import { afterAll, describe, expect, it } from 'vitest'
import type { FilterListSpec } from '@shared/filter-lists'
import { loadGhosteryBackend } from './ghostery-engine'
import { BlockingService, type BlockedRequest, type BlockingSettings } from './service'
import { startTestServer } from './test-server'

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void
const backend = await loadGhosteryBackend()
const dir = mkdtempSync(join(tmpdir(), 'lucium-cost-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A list of `rules` rules in the proportions of EasyList plus EasyPrivacy: hosts, paths with options, hiding rules, exceptions. */
function listOf(rules: number): string {
  const lines: string[] = []
  for (let i = 0; i < rules * 0.4; i++) lines.push(`||ads${i}.example${i % 7}.com^$third-party`)
  for (let i = 0; i < rules * 0.2; i++) lines.push(`||cdn${i}.example.net/ads/*.js$script,domain=site${i % 500}.com`)
  for (let i = 0; i < rules * 0.15; i++) lines.push(`site${i % 3000}.com##.ad-${i}`)
  for (let i = 0; i < rules * 0.1; i++) lines.push(`##.sponsor-${i}`, `###promo-${i}`)
  for (let i = 0; i < rules * 0.01; i++) lines.push(`site${i}.com##+js(set-constant, adsOn${i}, false)`, `||p${i}.example.org^$removeparam=utm_${i}`)
  for (let i = 0; i < rules * 0.09; i++) lines.push(`@@||ok${i}.example.com^$script`)
  return lines.join('\n')
}

const MB = 1024 * 1024
const settings = (patch: Partial<BlockingSettings> = {}): BlockingSettings => ({ blockAds: true, blockCookieBanners: false, blockCosmetic: true, blockExceptions: [], blockMode: 'standard', ...patch })

/** A mix of what a page asks for: mostly allowed requests, some blocked, some to the page's own site. */
function traffic(count: number): BlockedRequest[] {
  const out: BlockedRequest[] = []
  for (let i = 0; i < count; i++) {
    const kind = i % 10
    const url = kind === 0 ? `https://ads${i % 5000}.example${i % 7}.com/x.js` : kind === 1 ? `https://cdn${i % 5000}.example.net/ads/a.js` : kind === 2 ? 'https://www.site7.com/static/app.js' : `https://cdn${i}.static-${i % 97}.org/img/${i}.png?v=${i}`
    out.push({ url, resourceType: kind === 3 ? 'image' : 'script', pageUrl: 'https://www.site7.com/article', pageId: `tab-${i % 20}` })
  }
  return out
}

describe('the cost of the blocker with 150 000 rules', () => {
  it('comes up from the file in a few milliseconds, keeps a bounded amount of memory, and answers a request in microseconds', async () => {
    const server = await startTestServer()
    const text = listOf(150_000)
    server.routes.set('/big.txt', () => ({ body: text }))
    const spec: FilterListSpec = { id: 'big', title: 'big', description: '', category: 'ads', url: `${server.origin}/big.txt`, homepage: '', license: 'test', licenseUrl: '', author: 'test' }
    const make = (where: string) => new BlockingService({ dir: where, fetch: (url, init) => fetch(url, init), backend: async () => backend, catalog: [spec], timeoutMs: 20_000, allowInsecure: true })
    const config = { ads: true, cookieBanners: false, cosmetic: true, disabledLists: [], updateDays: 4 }

    // The compiled lists live in typed arrays outside the JavaScript heap: both are counted.
    const kept = (): number => {
      const usage = process.memoryUsage()
      return usage.heapUsed + usage.external
    }
    gc()
    const baseHeap = kept()
    const first = make(dir)
    const t0 = performance.now()
    first.configure(config)
    await first.settled()
    const cold = performance.now() - t0
    gc()
    const afterCold = kept()
    const rssCold = process.memoryUsage().rss
    expect(first.status().engineReady).toBe(true)
    first.dispose()

    // The next launch: the lists are on disk and so is the compiled engine.
    gc()
    const beforeWarm = kept()
    const second = make(dir)
    const t1 = performance.now()
    second.configure({ ...config, updateDays: 365 })
    await second.settled()
    const warm = performance.now() - t1
    gc()
    const afterWarm = kept()
    expect(second.status().engineReady).toBe(true)

    const requests = traffic(20_000)
    const run = (mode: 'standard' | 'strict', extended: boolean): number => {
      const s = settings({ blockMode: mode, blockScriptlets: extended })
      for (const r of requests.slice(0, 2000)) second.verdict(r, s)
      const start = performance.now()
      let blocked = 0
      for (const r of requests) if (second.verdict(r, s) !== false) blocked++
      const per = ((performance.now() - start) * 1000) / requests.length
      expect(blocked).toBeGreaterThan(0)
      return per
    }
    const standard = run('standard', false)
    const strict = run('strict', false)
    const extended = run('standard', true)

    const hints = { classes: Array.from({ length: 2000 }, (_, i) => `sponsor-${i * 7}`), ids: Array.from({ length: 800 }, (_, i) => `promo-${i * 11}`), hrefs: [] }
    second.cosmeticCss('https://www.site7.com/article', settings(), hints)
    const c0 = performance.now()
    let css = ''
    for (let i = 0; i < 50; i++) css = second.cosmeticCss('https://www.site7.com/article', settings(), hints)
    const cosmetic = (performance.now() - c0) / 50
    const scripts0 = performance.now()
    for (let i = 0; i < 1000; i++) second.scriptletCalls('https://www.site7.com/article', settings({ blockScriptlets: true }))
    const scriptlets = ((performance.now() - scripts0) * 1000) / 1000

    const size = statSync(join(dir, 'engine-ads.bin')).size
    process.stdout.write(
      `[blocker cost] ${text.split('\n').length} rules, ${(text.length / 1e6).toFixed(1)} MB of text, engine file ${(size / MB).toFixed(1)} MB | first launch (read, compile, write) ${cold.toFixed(0)} ms | next launch (from the file) ${warm.toFixed(0)} ms | ` +
        `memory kept: ${((afterCold - baseHeap) / MB).toFixed(0)} MB after compiling, ${((afterWarm - beforeWarm) / MB).toFixed(0)} MB more for a second engine loaded from the file (rss of the test process ${(rssCold / MB).toFixed(0)} MB) | per request: standard ${standard.toFixed(1)} µs, strict ${strict.toFixed(1)} µs, extended rules ${extended.toFixed(1)} µs | ` +
        `hiding rules for a page with 2800 hints: ${cosmetic.toFixed(2)} ms (${css.length} characters) | scriptlets of a page ${scriptlets.toFixed(1)} µs\n`
    )
    second.dispose()
    await server.close()

    expect(warm).toBeLessThan(cold / 2)
    expect(warm).toBeLessThan(500)
    expect(standard).toBeLessThan(250)
    expect(strict).toBeLessThan(250)
    expect(extended).toBeLessThan(250)
    expect(cosmetic).toBeLessThan(50)
    expect((afterWarm - beforeWarm) / MB).toBeLessThan(400)
  }, 120_000)
})
