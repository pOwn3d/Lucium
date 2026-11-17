import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilterListSpec } from '@shared/filter-lists'
import { ListStore } from './list-store'
import { updateList, type FetchLike, type UpdateContext } from './list-updater'
import { listText, startTestServer, type TestServer } from './test-server'

let server: TestServer
let dir: string
let clock = 1_000

beforeEach(async () => {
  server = await startTestServer()
  dir = mkdtempSync(join(tmpdir(), 'lucium-lists-'))
  clock = 1_000
})
afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

const spec = (overrides: Partial<FilterListSpec> = {}): FilterListSpec => ({
  id: 'ma-liste',
  title: 'Ma liste',
  description: '',
  category: 'ads',
  url: `${server.origin}/list.txt`,
  homepage: '',
  license: 'test',
  licenseUrl: '',
  author: 'test',
  ...overrides
})

const context = (store: ListStore, overrides: Partial<UpdateContext> = {}): UpdateContext => ({
  store,
  fetch: ((url, init) => fetch(url, init)) as FetchLike,
  now: () => ++clock,
  timeoutMs: 2_000,
  allowInsecure: true,
  ...overrides
})

describe('updating a list', () => {
  it('installs a valid list and remembers what the server said about it', async () => {
    server.routes.set('/list.txt', () => ({ body: listText('Ma liste', [], 5), headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' } }))
    const store = new ListStore(dir)
    expect(await updateList(spec(), context(store))).toBe('updated')
    expect(store.meta('ma-liste')).toMatchObject({ rules: 5, etag: '"v1"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' })
    expect(store.read('ma-liste')).toBe(listText('Ma liste', [], 5))
    expect(store.errorOf('ma-liste')).toBeUndefined()
  })

  it('asks again with its validators, and an unchanged list costs no new copy', async () => {
    server.routes.set('/list.txt', (request) => (request.headers['if-none-match'] === '"v1"' ? { status: 304 } : { body: listText('Ma liste'), headers: { etag: '"v1"' } }))
    const store = new ListStore(dir)
    await updateList(spec(), context(store))
    const first = store.meta('ma-liste')!
    expect(await updateList(spec(), context(store))).toBe('unchanged')
    expect(server.requests.at(-1)!.headers['if-none-match']).toBe('"v1"')
    // The date moves (the server confirmed it today), the content does not.
    expect(store.meta('ma-liste')!.checkedAt).toBeGreaterThan(first.checkedAt)
    expect(store.meta('ma-liste')!.hash).toBe(first.hash)
  })

  it('replaces a list when the server has a new one', async () => {
    server.routes.set('/list.txt', () => ({ body: listText('v1', [], 10) }))
    const store = new ListStore(dir)
    await updateList(spec(), context(store))
    server.routes.set('/list.txt', () => ({ body: listText('v2', ['||nouveau.example^'], 11) }))
    expect(await updateList(spec(), context(store))).toBe('updated')
    expect(store.read('ma-liste')).toContain('! Title: v2')
    expect(store.meta('ma-liste')!.rules).toBe(12)
  })

  it('sends a plain request: no cookie, no referrer, no credentials', async () => {
    server.routes.set('/list.txt', () => ({ body: listText('Ma liste') }))
    await updateList(spec(), context(new ListStore(dir)))
    const sent = server.requests[0]!.headers
    expect(sent.cookie).toBeUndefined()
    expect(sent.referer).toBeUndefined()
    expect(sent.authorization).toBeUndefined()
    expect(sent.accept).toContain('text/plain')
  })
})

describe('when the update fails, the previous list stays', () => {
  async function installedStore(): Promise<{ store: ListStore; before: string }> {
    server.routes.set('/list.txt', () => ({ body: listText('v1', [], 20), headers: { etag: '"v1"' } }))
    const store = new ListStore(dir)
    expect(await updateList(spec(), context(store))).toBe('updated')
    return { store, before: store.read('ma-liste')! }
  }

  const failures: Array<[string, () => void]> = [
    ['a server error', () => server.routes.set('/list.txt', () => ({ status: 500, body: 'oups' }))],
    ['a missing page', () => server.routes.set('/list.txt', () => ({ status: 404 }))],
    ['an HTML page with a 200 (captive portal)', () => server.routes.set('/list.txt', () => ({ body: '<!DOCTYPE html><html><body>Connectez-vous</body></html>' }))],
    ['an HTML content type', () => server.routes.set('/list.txt', () => ({ body: listText('v2', [], 20), headers: { 'content-type': 'text/html' } }))],
    ['an empty answer', () => server.routes.set('/list.txt', () => ({ body: '' }))],
    ['a truncated list', () => server.routes.set('/list.txt', () => ({ body: listText('v2', [], 4) }))],
    // uBlock's root files do this: the engine would not follow the include, and the list would silently lose most of its rules.
    ['a list that now hands part of its rules to another file (!#include)', () => server.routes.set('/list.txt', () => ({ body: `${listText('v2', [], 20)}\n!#include filters-2026.txt\n` }))]
  ]

  for (const [name, breakServer] of failures) {
    it(`keeps the installed copy after ${name}, and records the failure`, async () => {
      const { store, before } = await installedStore()
      const hashBefore = store.meta('ma-liste')!.hash
      breakServer()
      expect(await updateList(spec(), context(store))).toBe('failed')
      expect(store.read('ma-liste')).toBe(before)
      expect(store.meta('ma-liste')!.hash).toBe(hashBefore)
      expect(store.errorOf('ma-liste')?.message).toBeTruthy()
      // No temporary file is left behind by the attempt.
      expect(readdirSync(join(dir, 'lists')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    })
  }

  it('keeps the installed copy when the server is gone', async () => {
    const { store, before } = await installedStore()
    const url = spec().url
    await server.close()
    expect(await updateList(spec({ url }), context(store))).toBe('failed')
    expect(store.read('ma-liste')).toBe(before)
    expect(store.errorOf('ma-liste')?.message).toBeTruthy()
  })

  it('gives up on a server that never answers', async () => {
    const { store, before } = await installedStore()
    server.routes.set('/list.txt', () => ({ hang: true }))
    expect(await updateList(spec(), context(store, { timeoutMs: 100 }))).toBe('failed')
    expect(store.read('ma-liste')).toBe(before)
    expect(store.errorOf('ma-liste')?.message).toBe('Délai dépassé.')
  })

  it('keeps the installed copy when the new one cannot be written', async () => {
    const { store, before } = await installedStore()
    // A directory where the temporary file must go: the write fails halfway through the update.
    mkdirSync(join(dir, 'lists', 'ma-liste.txt.tmp'))
    server.routes.set('/list.txt', () => ({ body: listText('v2', [], 25) }))
    expect(await updateList(spec(), context(store))).toBe('failed')
    expect(store.read('ma-liste')).toBe(before)
    expect(store.meta('ma-liste')!.rules).toBe(20)
    expect(store.errorOf('ma-liste')?.message).toBeTruthy()
  })

  it('clears the failure once an update goes through', async () => {
    const { store } = await installedStore()
    server.routes.set('/list.txt', () => ({ status: 503 }))
    await updateList(spec(), context(store))
    expect(store.errorOf('ma-liste')).toBeDefined()
    server.routes.set('/list.txt', () => ({ body: listText('v3', [], 25) }))
    expect(await updateList(spec(), context(store))).toBe('updated')
    expect(store.errorOf('ma-liste')).toBeUndefined()
  })

  it('does not install a list too small for the real one (spec.minRules)', async () => {
    server.routes.set('/list.txt', () => ({ body: listText('Réponse bidon', [], 3) }))
    const store = new ListStore(dir)
    expect(await updateList(spec({ minRules: 100 }), context(store))).toBe('failed')
    expect(store.meta('ma-liste')).toBeUndefined()
    expect(store.read('ma-liste')).toBeNull()
  })
})

describe('only secure addresses', () => {
  it('refuses a plain http list without ever contacting the server', async () => {
    const store = new ListStore(dir)
    server.routes.set('/list.txt', () => ({ body: listText('Ma liste') }))
    expect(await updateList(spec(), context(store, { allowInsecure: false }))).toBe('failed')
    expect(server.requests).toHaveLength(0)
    expect(store.meta('ma-liste')).toBeUndefined()
  })

  it('refuses an https list that redirects to plain http', async () => {
    const store = new ListStore(dir)
    const downgraded: FetchLike = async () => Object.defineProperty(new Response(listText('Ma liste'), { status: 200 }), 'url', { value: 'http://exemple.test/list.txt' })
    expect(await updateList(spec({ url: 'https://exemple.test/list.txt' }), context(store, { fetch: downgraded, allowInsecure: false }))).toBe('failed')
    expect(store.errorOf('ma-liste')?.message).toContain('Redirection')
    expect(store.meta('ma-liste')).toBeUndefined()
  })

  it('accepts a secure address answered over https', async () => {
    const store = new ListStore(dir)
    const secure: FetchLike = async () => Object.defineProperty(new Response(listText('Ma liste'), { status: 200 }), 'url', { value: 'https://exemple.test/list.txt' })
    expect(await updateList(spec({ url: 'https://exemple.test/list.txt' }), context(store, { fetch: secure, allowInsecure: false }))).toBe('updated')
  })
})

describe('the list store', () => {
  it('survives a restart, and ignores a list whose file was changed behind its back', async () => {
    server.routes.set('/list.txt', () => ({ body: listText('Ma liste') }))
    const store = new ListStore(dir)
    await updateList(spec(), context(store))
    expect(new ListStore(dir).read('ma-liste')).toBe(listText('Ma liste'))
    const file = join(dir, 'lists', 'ma-liste.txt')
    expect(readFileSync(file, 'utf8')).toBe(listText('Ma liste'))
    // A damaged copy is not served: it reads as missing, and the next check fetches it again.
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(file, 'abîmé'))
    expect(new ListStore(dir).read('ma-liste')).toBeNull()
  })

  it('starts empty, without crashing, on a damaged index', async () => {
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(join(dir, 'index.json'), '{ pas du json'))
    expect(new ListStore(dir).meta('ma-liste')).toBeUndefined()
  })

  it('keeps an engine in one file with its key, and refuses a file without a key', async () => {
    const store = new ListStore(dir)
    store.writeEngine('ads', { key: 'k1', bytes: new Uint8Array([1, 2, 3, 10, 4]) })
    const back = store.readEngine('ads')
    expect(back?.key).toBe('k1')
    expect([...back!.bytes]).toEqual([1, 2, 3, 10, 4])
    expect(store.readEngine('cookies')).toBeNull()
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(join(dir, 'engine-ads.bin'), 'sans entête'))
    expect(store.readEngine('ads')).toBeNull()
  })
})
