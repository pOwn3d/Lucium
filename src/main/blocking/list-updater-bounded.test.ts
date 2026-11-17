// A list server that sends no length and never stops must not fill the memory: the body is read piece by piece and given up at the limit.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilterListSpec } from '@shared/filter-lists'
import { ListStore } from './list-store'
import { readBoundedText, updateList, type FetchLike } from './list-updater'

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'lucium-bounded-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const spec: FilterListSpec = { id: 'big', title: 'big', description: '', category: 'ads', url: 'http://lists.test/big.txt', homepage: '', license: 'test', licenseUrl: '', author: 'test' }
const MB = 1024 * 1024

/** A body of `total` megabytes in pieces of one, with no content-length; `pulled` counts the pieces the reader asked for. */
function endlessBody(total: number): { response: Response; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close()
      pulled++
      controller.enqueue(new Uint8Array(MB).fill(0x61))
    },
    cancel() {
      cancelled = true
    }
  })
  return { response: new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }), pulled: () => pulled, cancelled: () => cancelled }
}

describe('reading the body of a list', () => {
  it('gives up as soon as the body is longer than the limit, and cancels the connection', async () => {
    const body = endlessBody(200)
    expect(await readBoundedText(body.response, 5 * MB)).toBeNull()
    // Read up to the limit and one piece more, not the 200 MB the server offered.
    expect(body.pulled()).toBeLessThanOrEqual(8)
    expect(body.cancelled()).toBe(true)
  })

  it('returns the whole text of a body within the limit', async () => {
    expect(await readBoundedText(new Response('||ads.example^\n'), MB)).toBe('||ads.example^\n')
    expect(await readBoundedText(new Response('é'.repeat(10)), 20)).toBe('é'.repeat(10))
    expect(await readBoundedText(new Response('é'.repeat(10)), 19)).toBeNull()
  })

  it('refuses a list that streams without end: the update fails with a sentence, the installed copy is kept, and little is read', async () => {
    const store = new ListStore(dir)
    store.install('big', '||ads.example^\n', { checkedAt: 1, rules: 1 })
    const body = endlessBody(200)
    const fetchEndless: FetchLike = async () => body.response
    const outcome = await updateList(spec, { store, fetch: fetchEndless, now: () => 2, timeoutMs: 5_000, allowInsecure: true })
    expect(outcome).toBe('failed')
    expect(store.errorOf('big')?.message).toMatch(/anormalement volumineuse/)
    expect(store.read('big')).toBe('||ads.example^\n')
    // MAX_BYTES is 30 MB: the reader stopped there, long before the 200 MB.
    expect(body.pulled()).toBeLessThanOrEqual(33)
  })
})
