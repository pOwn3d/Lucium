// A fault of ours inside one list's update (not a failed download: `updateList` answers those itself) must be told on that list and must not
// stop the lists after it nor leave the settings showing a download that never ends.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilterListSpec } from '@shared/filter-lists'
import { loadGhosteryBackend } from './ghostery-engine'
import * as updater from './list-updater'
import { BlockingService } from './service'
import { listText, startTestServer, type TestServer } from './test-server'

vi.mock('./list-updater', async (original) => {
  const real = await original<typeof import('./list-updater')>()
  return { ...real, updateList: vi.fn(real.updateList) }
})

const ghostery = await loadGhosteryBackend()
let server: TestServer
let dir: string
let service: BlockingService | null = null

beforeEach(async () => {
  server = await startTestServer()
  dir = mkdtempSync(join(tmpdir(), 'lucium-fault-'))
  for (const name of ['a', 'b']) server.routes.set(`/${name}.txt`, () => ({ body: listText(name, [], 5, `${name}ads`) }))
})
afterEach(async () => {
  service?.dispose()
  service = null
  vi.mocked(updater.updateList).mockClear()
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

const spec = (id: string): FilterListSpec => ({ id, title: id, description: '', category: 'ads', url: `${server.origin}/${id}.txt`, homepage: '', license: 'test', licenseUrl: '', author: 'test' })

describe('an unexpected fault while updating one list', () => {
  it('is shown on that list, ends its "downloading" state, and the next list is still updated', async () => {
    service = new BlockingService({ dir, fetch: (url, init) => fetch(url, init), backend: async () => ghostery, catalog: [spec('a'), spec('b')], now: () => 1_000_000, timeoutMs: 2_000, allowInsecure: true })
    const real = (await vi.importActual<typeof import('./list-updater')>('./list-updater')).updateList
    vi.mocked(updater.updateList).mockImplementation(async (list, ctx) => {
      if (list.id === 'a') throw new Error('boom')
      return real(list, ctx)
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.configure({ ads: true, cookieBanners: false, cosmetic: true, disabledLists: [], updateDays: 4 })
    await service.settled()
    const told = errors.mock.calls.some((call) => String(call[0]).includes('the update of a failed unexpectedly'))
    errors.mockRestore()
    const lists = service.status().lists
    expect(told).toBe(true)
    expect(lists.find((l) => l.id === 'a')).toMatchObject({ installed: false, updating: false, error: { message: 'boom' } })
    expect(lists.find((l) => l.id === 'b')).toMatchObject({ installed: true, updating: false, error: null })
    expect(service.status().engineReady).toBe(true)
  })
})
