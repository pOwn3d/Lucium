// How the blocker downloads its lists: over the network for a user, never under a test (the engine test, the end-to-end tests).

import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from './list-updater'

vi.mock('electron', () => ({ app: { getPath: () => '/nowhere' }, net: { fetch: vi.fn() } }))

const { listFetch } = await import('./index')

const INIT = { headers: {}, signal: new AbortController().signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' } as const
const LIST = 'https://lists.example/easylist.txt'

function online(): { fetch: FetchLike; asked: string[] } {
  const asked: string[] = []
  return { asked, fetch: (url) => (asked.push(url), Promise.resolve(new Response('ok'))) }
}

describe('the download of the filter lists', () => {
  it('goes over the network for an application the user launched', async () => {
    const network = online()
    const response = await listFetch(['Lucium'], {}, network.fetch)(LIST, INIT)
    expect(await response.text()).toBe('ok')
    expect(network.asked).toEqual([LIST])
  })

  it('never leaves under the end-to-end tests (LUCIUM_E2E=1): the download fails with its reason, and the network is not asked', async () => {
    const network = online()
    await expect(listFetch(['electron', '.'], { LUCIUM_E2E: '1' }, network.fetch)(LIST, INIT)).rejects.toThrow(/end-to-end tests/)
    expect(network.asked).toEqual([])
  })

  it('never leaves under the engine test (--smoke)', async () => {
    const network = online()
    await expect(listFetch(['electron', '.', '--smoke'], {}, network.fetch)(LIST, INIT)).rejects.toThrow(/test du moteur/)
    expect(network.asked).toEqual([])
  })

  it('is cut by the value 1 only: a variable that is empty or says anything else leaves the downloads on', async () => {
    for (const value of ['', '0', 'false']) {
      const network = online()
      await listFetch(['Lucium'], { LUCIUM_E2E: value }, network.fetch)(LIST, INIT)
      expect(network.asked, `LUCIUM_E2E=${value}`).toEqual([LIST])
    }
  })
})
