// The life of the blocker service when the settings change while it works: a download in flight, a compilation in flight, a disk that refuses
// the index, lists of the user's alone. Local server only.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomFilterList } from '@shared/custom-filter-lists'
import type { BlockingConfig, FilterListSpec } from '@shared/filter-lists'
import { loadGhosteryBackend } from './ghostery-engine'
import type { FilterEngineBackend } from './filter-engine'
import type { FetchLike } from './list-updater'
import { BlockingService, type BlockedRequest, type BlockingSettings } from './service'
import { listText, startTestServer, type TestServer } from './test-server'

const ghostery = await loadGhosteryBackend()

let server: TestServer
let dir: string
const services: BlockingService[] = []

beforeEach(async () => {
  server = await startTestServer()
  dir = mkdtempSync(join(tmpdir(), 'lucium-lifecycle-'))
  for (const name of ['a', 'b', 'c']) server.routes.set(`/${name}.txt`, () => ({ body: listText(name, [], 5, `${name}ads`), headers: { etag: `"${name}"` } }))
})
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await server.close()
  try {
    chmodSync(join(dir, 'lists'), 0o700)
    chmodSync(dir, 0o700)
  } catch {
    // Nothing was made.
  }
  rmSync(dir, { recursive: true, force: true })
})

const spec = (id: string): FilterListSpec => ({ id, title: id, description: '', category: 'ads', url: `${server.origin}/${id}.txt`, homepage: '', license: 'test', licenseUrl: '', author: 'test' })
const catalog = () => ['a', 'b', 'c'].map(spec)
const config = (patch: Partial<BlockingConfig> = {}): BlockingConfig => ({ ads: true, cookieBanners: false, cosmetic: true, disabledLists: [], updateDays: 4, ...patch })
const settings = (patch: Partial<BlockingSettings> = {}): BlockingSettings => ({ blockAds: true, blockCookieBanners: false, blockCosmetic: true, blockExceptions: [], blockMode: 'standard', ...patch })
const request = (url: string): BlockedRequest => ({ url, resourceType: 'script', pageUrl: 'https://news.test/', pageId: 'tab-1' })

function make(overrides: Partial<ConstructorParameters<typeof BlockingService>[0]> = {}): BlockingService {
  const service = new BlockingService({ dir, fetch: (url, init) => fetch(url, init), backend: async () => ghostery, catalog: catalog(), now: () => 1_000_000, timeoutMs: 2_000, allowInsecure: true, ...overrides })
  services.push(service)
  return service
}

/** A promise settled from outside. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {}
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

describe('switching the blocker off while it works', () => {
  it('stops downloading the lists that are left once both options are off, and installs none of them', async () => {
    const first = gate()
    const asked: string[] = []
    const held: FetchLike = async (url, init) => {
      asked.push(new URL(url).pathname)
      if (asked.length === 1) await first.promise
      return fetch(url, init)
    }
    const service = make({ fetch: held })
    service.configure(config())
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    // The user switches the blocker off while the first list is on its way.
    service.configure(config({ ads: false }))
    first.open()
    await service.settled()
    expect(asked).toEqual(['/a.txt'])
    expect(service.hasCompiledLists()).toBe(false)
    expect(service.filter(request('https://aads1.example/x.js'), settings({ blockAds: false }))).toBe(false)
  })

  it('does not fetch a list the user switched off one by one while the others were downloading', async () => {
    const first = gate()
    const asked: string[] = []
    const held: FetchLike = async (url, init) => {
      asked.push(new URL(url).pathname)
      if (asked.length === 1) await first.promise
      return fetch(url, init)
    }
    const service = make({ fetch: held })
    service.configure(config())
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    service.configure(config({ disabledLists: ['b'] }))
    first.open()
    await service.settled()
    expect(asked).not.toContain('/b.txt')
    expect(asked).toContain('/c.txt')
  })

  it('keeps no engine in memory when the options went off while the library was still loading', async () => {
    const library = gate()
    const slow: () => Promise<FilterEngineBackend> = async () => {
      await library.promise
      return ghostery
    }
    // The lists are on disk already (a previous launch): the engine is being built from them.
    const warm = make()
    warm.configure(config())
    await warm.settled()
    warm.dispose()

    const service = make({ backend: slow })
    service.configure(config())
    await new Promise((resolve) => setTimeout(resolve, 20))
    service.configure(config({ ads: false }))
    library.open()
    await service.settled()
    expect(service.hasCompiledLists()).toBe(false)
  })
})

// The superuser writes where a folder is read-only: these two cases cannot be set up as root.
const asRoot = process.getuid?.() === 0

describe('a disk that refuses the index', () => {
  it.skipIf(asRoot)('does not leave a list "updating" for ever, and still tells the failure', async () => {
    const service = make()
    service.configure(config())
    await service.settled()
    // The folder can no longer be written (read-only volume, quota): the next update fails, and so does the record of the failure.
    chmodSync(dir, 0o500)
    chmodSync(join(dir, 'lists'), 0o500)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    server.routes.set('/a.txt', () => ({ body: listText('a', [], 5, 'newads') }))
    await service.updateNow()
    errors.mockRestore()
    const states = service.status().lists
    expect(states.some((l) => l.updating)).toBe(false)
    expect(states.find((l) => l.id === 'a')?.error?.message).toBeTruthy()
  })
})

describe('a damaged copy on a disk that refuses the index', () => {
  it.skipIf(asRoot)('is told in the settings and does not stop the other lists', async () => {
    const service = make()
    service.configure(config())
    await service.settled()
    // The copy of the first list is damaged behind our back and the folder is read-only: forgetting the copy cannot be written down either.
    writeFileSync(join(dir, 'lists', 'a.txt'), 'garbage')
    chmodSync(dir, 0o500)
    chmodSync(join(dir, 'lists'), 0o500)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asked = server.requests.length
    await service.updateNow()
    const told = warnings.mock.calls.some((call) => String(call[0]).includes('cannot forget the damaged copy of a'))
    warnings.mockRestore()
    expect(told).toBe(true)
    // The other two lists were asked for (and refused by the disk, which is their own failure), not skipped.
    expect(server.requests.slice(asked).map((r) => r.path).sort()).toEqual(['/a.txt', '/b.txt', '/c.txt'])
    expect(service.status().lists.some((l) => l.updating)).toBe(false)
    expect(service.status().lists.find((l) => l.id === 'b')?.error?.message).toBeTruthy()
  })
})

describe('the compiled engine kept on disk, after the settings moved about', () => {
  /** A backend that counts what is built and what is loaded from the file. */
  const counting = () => {
    const counts = { built: 0, loaded: 0 }
    const backend: FilterEngineBackend = { ...ghostery, build: async (texts) => (counts.built++, ghostery.build(texts)), load: async (bytes) => (counts.loaded++, ghostery.load(bytes)) }
    return { counts, backend }
  }

  it('is the one loaded at the next launch when a list was switched off and on again, whatever the order of the changes', async () => {
    const first = make()
    first.configure(config())
    await first.settled()
    // Off, then on again, with no wait between the two (the settings window can do that): the last word is the one on disk.
    first.configure(config({ disabledLists: ['b'] }))
    first.configure(config())
    await first.settled()
    first.dispose()

    const { counts, backend } = counting()
    const second = make({ backend: async () => backend })
    second.configure(config())
    await second.settled()
    expect(counts).toEqual({ built: 0, loaded: 1 })
    expect(second.filter(request('https://aads1.example/x.js'), settings())).toBe(true)
  })

  it('is rebuilt only when the lists in use really differ from the ones it was made of', async () => {
    const first = make()
    first.configure(config())
    await first.settled()
    // The last word of the session: one list off. Its engine is the one on disk.
    first.configure(config({ disabledLists: ['b'] }))
    await first.settled()
    first.dispose()

    const { counts, backend } = counting()
    const second = make({ backend: async () => backend })
    second.configure(config())
    await second.settled()
    expect(counts).toEqual({ built: 1, loaded: 0 })
  })
})

describe('lists of the user\'s alone do not take the built-in list away', () => {
  const own = (): CustomFilterList => ({ id: 'custom-00000001', title: 'Mes règles', source: 'paste', sourceName: 'Règles collées', enabled: true, addedAt: 1 })

  it('keeps blocking the known ad networks while the catalog lists cannot be downloaded', async () => {
    const down: FetchLike = () => Promise.reject(new Error('hors ligne'))
    const service = make({ fetch: down })
    const verdict = await service.reviewCustomText('||mine.example^\n')
    if (!verdict.ok) throw new Error(verdict.reason)
    await service.installCustomList(own(), verdict.review)
    service.configure(config({ customLists: [own()] }))
    await service.settled()
    expect(service.filter(request('https://mine.example/x.js'), settings())).toBe(true)
    expect(service.filter(request('https://securepubads.g.doubleclick.net/t.js'), settings())).toBe(true)
  })
})
