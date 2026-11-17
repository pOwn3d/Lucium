// The timed write of the history does not hold the process (HistoryStore with asyncWrites), and never lets an older text replace a newer one:
// a flush or an erasure that comes while it is in flight wins.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryStore } from './history'
import { takePersistenceNotices } from './persistence-notices'
import { tempDir } from './temp-dir'

const SAVE_DELAY_MS = 2000

/** Lets the real file system finish (the timers are faked, the disk is not). */
const settle = (ms = 300): Promise<void> =>
  new Promise((resolve) => {
    const start = Date.now()
    const tick = (): void => (Date.now() - start >= ms ? resolve() : void setImmediate(tick))
    tick()
  })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  takePersistenceNotices()
})

const store = (): { history: HistoryStore; path: string } => {
  const path = join(tempDir('lucium-history-async-'), 'h.json')
  return { history: new HistoryStore(path, { asyncWrites: true }), path }
}

describe('the timed write of the history', () => {
  it('leaves the process free while the disk takes the file, then puts the pages on disk', async () => {
    const { history, path } = store()
    history.record('https://a.fr/', 'A', 1)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    // The timer's callback has run and nothing has been written yet: the write is in the file system's hands.
    expect(existsSync(path)).toBe(false)
    await settle()
    expect(readFileSync(path, 'utf8')).toContain('https://a.fr/')
    expect(history.isDirty()).toBe(false)
    expect(existsSync(`${path}.tmp-async`)).toBe(false)
  })

  it('writes the pages that came in while a write was in flight', async () => {
    const { history, path } = store()
    history.record('https://a.fr/', 'A', 1)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    history.record('https://b.fr/', 'B', 2)
    await settle()
    expect(history.isDirty()).toBe(true)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    await settle()
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('https://a.fr/')
    expect(text).toContain('https://b.fr/')
    expect(history.isDirty()).toBe(false)
  })

  it('does not replace what a flush wrote while it was in flight with an older text', async () => {
    const { history, path } = store()
    history.record('https://a.fr/', 'A', 1)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    history.record('https://b.fr/', 'B', 2)
    expect(history.flush()).toBe(true)
    await settle()
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('https://a.fr/')
    expect(text).toContain('https://b.fr/')
    expect(existsSync(`${path}.tmp-async`)).toBe(false)
  })

  it('does not bring back the pages of a history that was erased while it was in flight', async () => {
    const { history, path } = store()
    history.record('https://a.fr/', 'A', 1)
    expect(history.flush()).toBe(true)
    history.record('https://b.fr/', 'B', 2)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(history.erase()).toBe(true)
    await settle()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.tmp-async`)).toBe(false)
    expect(history.size()).toBe(0)
  })
})

describe('the other writes of the history', () => {
  it('stay synchronous by default: the timer writes before it returns', () => {
    const path = join(tempDir('lucium-history-sync-'), 'h.json')
    const history = new HistoryStore(path)
    history.record('https://a.fr/', 'A', 1)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(readFileSync(path, 'utf8')).toContain('https://a.fr/')
  })
})
