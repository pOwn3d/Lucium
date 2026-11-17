// The timed write of the state does not hold the process: the text is made at once, written aside while the application goes
// on, and put in place only if nothing newer was written meanwhile. A flush (the quit, a restoration) stays synchronous and always wins.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { takePersistenceNotices } from './persistence-notices'
import { StateStore, loadState } from './store'
import { tempDir } from './temp-dir'

const SAVE_DELAY_MS = 300
const RETRY_DELAY_MS = 5000

/** Lets the real file system finish (the timers are faked, the disk is not). */
const settle = (ms = 300): Promise<void> =>
  new Promise((resolve) => {
    const start = Date.now()
    const tick = (): void => (Date.now() - start >= ms ? resolve() : void setImmediate(tick))
    tick()
  })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  takePersistenceNotices()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  takePersistenceNotices()
})

const urlsOnDisk = (path: string): string[] => (JSON.parse(readFileSync(path, 'utf8')) as { tabs: Array<{ url: string }> }).tabs.map((tab) => tab.url)

describe('the timed write of the state', () => {
  it('leaves the process free while the disk takes the file, then puts the state on disk', async () => {
    const path = join(tempDir('lucium-store-async-'), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    // The timer's callback has run and nothing is in place yet: the write is in the file system's hands.
    expect(existsSync(path)).toBe(false)
    await settle()
    expect(urlsOnDisk(path)).toEqual(['https://a.fr/'])
    expect(existsSync(`${path}.tmp-async`)).toBe(false)
  })

  it('writes the changes that came in while a write was in flight', async () => {
    const path = join(tempDir('lucium-store-async-'), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    store.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
    // The timer of the second change comes while the first write is still in flight: it waits for it.
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    await settle()
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    await settle()
    expect(urlsOnDisk(path).sort()).toEqual(['https://a.fr/', 'https://b.fr/'])
    expect(existsSync(`${path}.tmp-async`)).toBe(false)
  })

  it('does not replace what a flush wrote while it was in flight with an older text', async () => {
    const path = join(tempDir('lucium-store-async-'), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    // The quit comes while the timed write (a.fr only) is in flight: the flush writes both tabs, and the older text must not come back over it.
    store.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
    expect(store.flush()).toBe(true)
    await settle()
    expect(urlsOnDisk(path).sort()).toEqual(['https://a.fr/', 'https://b.fr/'])
    expect(existsSync(`${path}.tmp-async`)).toBe(false)
    // Nothing is left to write: no other write is armed.
    vi.advanceTimersByTime(RETRY_DELAY_MS)
    await settle(50)
    expect(urlsOnDisk(path).sort()).toEqual(['https://a.fr/', 'https://b.fr/'])
  })

  it('does not throw when the disk refuses, tells the user once, leaves no temporary file, and tries again by itself', async () => {
    const folder = tempDir('lucium-store-async-')
    const parent = join(folder, 'pas-encore')
    const path = join(parent, 'state.json')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    await settle()
    expect(takePersistenceNotices()).toMatchObject([{ kind: 'save-failed', file: 'state.json', reason: expect.stringContaining('ENOENT') }])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('cannot write'), expect.anything())
    expect(store.get().tabs.map((tab) => tab.url)).toEqual(['https://a.fr/'])
    // The folder comes back: the retry armed after the failure writes the state, and says the file can be written again.
    mkdirSync(parent)
    vi.advanceTimersByTime(RETRY_DELAY_MS)
    await settle()
    expect(urlsOnDisk(path)).toEqual(['https://a.fr/'])
    expect(readdirSync(parent)).toEqual(['state.json'])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('can be written again'))
    expect(takePersistenceNotices()).toEqual([])
  })
})

describe('the other writes of the state', () => {
  it('a flush is synchronous: the file is in place when it answers', () => {
    const path = join(tempDir('lucium-store-sync-'), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    expect(store.flush()).toBe(true)
    expect(urlsOnDisk(path)).toEqual(['https://a.fr/'])
  })

  it('the timed writes stay synchronous when asked to', () => {
    const path = join(tempDir('lucium-store-sync-'), 'state.json')
    const store = new StateStore(loadState(path), path, undefined, { asyncWrites: false })
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(urlsOnDisk(path)).toEqual(['https://a.fr/'])
  })
})
