import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SMALL_FILE_MAX_BYTES } from './persist'
import { SCROLL_SAVE_DELAY_MS, ScrollMemoryStore } from './scroll-memory-store'

let dir: string
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'lucium-scroll-'))
})
afterEach(() => vi.useRealTimers())

describe('the scroll memory file', () => {
  it('gives a position back only to the tab and the address it was read on', () => {
    const store = new ScrollMemoryStore(null)
    store.remember('t1', 'https://a.example/x', 900)
    expect(store.positionFor('t1', 'https://a.example/x')).toBe(900)
    expect(store.positionFor('t1', 'https://a.example/other')).toBeUndefined()
    expect(store.positionFor('t2', 'https://a.example/x')).toBeUndefined()
  })

  it('forgets a tab that went back to the top, and the tabs that are gone', () => {
    const store = new ScrollMemoryStore(null)
    store.remember('t1', 'https://a.example/', 900)
    store.remember('t2', 'https://b.example/', 700)
    store.remember('t1', 'https://a.example/', 10)
    expect(store.positionFor('t1', 'https://a.example/')).toBeUndefined()
    store.forget(new Set())
    expect(store.positionFor('t2', 'https://b.example/')).toBeUndefined()
  })

  it('writes the file a few seconds after the last change, once, and survives a relaunch', () => {
    const path = join(dir, 'scroll.json')
    const store = new ScrollMemoryStore(path)
    store.remember('t1', 'https://a.example/', 900)
    store.remember('t1', 'https://a.example/', 1200)
    expect(existsSync(path)).toBe(false)
    vi.advanceTimersByTime(SCROLL_SAVE_DELAY_MS)
    const again = new ScrollMemoryStore(path)
    expect(again.positionFor('t1', 'https://a.example/')).toBe(1200)
    expect(readFileSync(path, 'utf8')).not.toContain('title')
  })

  it('writes at flush without waiting, and writes nothing when nothing changed', () => {
    const path = join(dir, 'scroll.json')
    const store = new ScrollMemoryStore(path)
    store.remember('t1', 'https://a.example/', 5)
    store.flush()
    expect(existsSync(path)).toBe(false)
    store.remember('t1', 'https://a.example/', 500)
    store.flush()
    expect(new ScrollMemoryStore(path).positionFor('t1', 'https://a.example/')).toBe(500)
  })

  it('sets a file that is not ours aside, says so, and starts from none', () => {
    const path = join(dir, 'scroll.json')
    writeFileSync(path, '{ not json')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = new ScrollMemoryStore(path)
    expect(store.positionFor('t1', 'https://a.example/')).toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(readdirSync(dir).some((name) => name.startsWith('scroll.json.corrupt'))).toBe(true)
    error.mockRestore()
  })

  it('does not read the file for a tab that closes: nothing is read until a position is asked for or reported', () => {
    const path = join(dir, 'scroll.json')
    writeFileSync(path, '{ not json')
    const store = new ScrollMemoryStore(path)
    store.forget(new Set())
    expect(readdirSync(dir)).toEqual(['scroll.json'])
  })

  it('sets aside a file of more than 1 MB without reading it, even when it is valid JSON', () => {
    const path = join(dir, 'scroll.json')
    const padding = ' '.repeat(SMALL_FILE_MAX_BYTES)
    writeFileSync(path, `{"version":1,"tabs":{"t1":{"url":"https://a.example/","y":900,"at":1}}}${padding}`)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = new ScrollMemoryStore(path)
    expect(store.positionFor('t1', 'https://a.example/')).toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(readdirSync(dir).some((name) => name.startsWith('scroll.json.corrupt'))).toBe(true)
    error.mockRestore()
  })
})
