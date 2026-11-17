import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadGhosteryBackend } from './ghostery-engine'
import { ListStore } from './list-store'

// What keeping the compiled engine on disk is worth: compiling a list of the size of the real ones, against reading the file back. The numbers
// are printed (they go into docs/fonctions.md); the test only asks for a clear gain, since a time depends on the machine.

const backend = await loadGhosteryBackend()
const dir = mkdtempSync(join(tmpdir(), 'lucium-cache-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function listOf(rules: number): string {
  const lines: string[] = []
  for (let i = 0; i < rules * 0.4; i++) lines.push(`||ads${i}.example${i % 7}.com^$third-party`)
  for (let i = 0; i < rules * 0.2; i++) lines.push(`||cdn${i}.example.net/ads/*.js$script,domain=site${i % 500}.com`)
  for (let i = 0; i < rules * 0.27; i++) lines.push(`site${i % 3000}.com##.ad-${i}`)
  for (let i = 0; i < rules * 0.01; i++) lines.push(`site${i}.com##+js(set-constant, adsOn${i}, false)`, `||p${i}.example.org^$removeparam=utm_${i}`)
  for (let i = 0; i < rules * 0.11; i++) lines.push(`@@||ok${i}.example.com^$script`)
  return lines.join('\n')
}

const time = async <T>(run: () => Promise<T> | T): Promise<[T, number]> => {
  const started = performance.now()
  const result = await run()
  return [result, performance.now() - started]
}

describe('the compiled engine kept on disk', () => {
  it('comes back from the file much faster than the lists compile, and answers the same', async () => {
    const text = listOf(150_000)
    const [engine, compile] = await time(() => backend.build([text]))
    const store = new ListStore(dir)
    const [, write] = await time(() => store.writeEngine('ads', { key: 'k', bytes: engine.serialize() }))
    const [cached, read] = await time(() => store.readEngine('ads'))
    const [loaded, load] = await time(() => backend.load(cached!.bytes))
    const size = statSync(join(dir, 'engine-ads.bin')).size
    process.stdout.write(`[engine cache] ${text.split('\n').length} rules, ${(text.length / 1e6).toFixed(1)} MB of text -> ${(size / 1e6).toFixed(1)} MB on disk | compile ${compile.toFixed(0)} ms | serialize+write ${write.toFixed(0)} ms | read+checksum ${read.toFixed(0)} ms | load ${load.toFixed(0)} ms | reload total ${(read + load).toFixed(0)} ms\n`)
    expect(read + load).toBeLessThan(compile / 3)
    for (const url of ['https://ads5.example5.com/x', 'https://cdn7.example.net/ads/a.js', 'https://elsewhere.test/x']) {
      const request = { url, sourceUrl: 'https://site7.com/', kind: 'script' as const }
      expect(loaded.shouldBlock(request), url).toBe(engine.shouldBlock(request))
    }
    expect(loaded.shouldBlock({ url: 'https://ads5.example5.com/x', sourceUrl: 'https://site7.com/', kind: 'script' })).toBe(true)
  })
})
