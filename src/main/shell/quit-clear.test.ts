import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIT_CLEAR_MARKER, finishQuitClear, markQuitClear, replayQuitClear } from './quit-clear'
import { expectMode, onWindows } from '../windows.test-support'

let dir: string
let marker: string
let logged: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-quitclear-'))
  marker = join(dir, QUIT_CLEAR_MARKER)
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the marker of an erasure at quit', () => {
  it('is written for its owner alone, and removed when the erasure was whole', () => {
    expect(markQuitClear(marker, 1234)).toBe(true)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ at: 1234 })
    expectMode(marker, 0o600)
    finishQuitClear(marker)
    expect(existsSync(marker)).toBe(false)
    // Nothing to remove is not an error.
    finishQuitClear(marker)
    expect(logged).not.toHaveBeenCalled()
  })

  // Windows: `chmod 500` does not make a folder refuse a new file there (it only sets the read-only flag, which a folder's contents ignore).
  it.skipIf(onWindows)('says so, and returns false, when it cannot be written', () => {
    chmodSync(dir, 0o500)
    expect(markQuitClear(marker)).toBe(false)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('will not be resumed'), expect.anything())
  })

  it('says so when it cannot be removed', () => {
    // A folder stands where the file would be: removing it without `recursive` fails.
    mkdirSync(join(marker, 'inside'), { recursive: true })
    finishQuitClear(marker)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('cannot remove'), expect.anything())
  })
})

describe('resuming at launch', () => {
  it('does nothing, and asks nothing of the engine, when no erasure was cut short', async () => {
    const clear = vi.fn(async () => [])
    expect(await replayQuitClear(marker, { enabled: () => true, clear })).toBe('none')
    expect(clear).not.toHaveBeenCalled()
  })

  it('erases the listed sites again when the last quit left the marker, then removes it', async () => {
    markQuitClear(marker)
    const clear = vi.fn(async () => [])
    expect(await replayQuitClear(marker, { enabled: () => true, clear })).toBe('done')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(existsSync(marker)).toBe(false)
    expect(logged).not.toHaveBeenCalled()
  })

  it('erases nothing, and only removes the marker, when the erasure at quit is no longer asked for', async () => {
    markQuitClear(marker)
    const clear = vi.fn(async () => [])
    expect(await replayQuitClear(marker, { enabled: () => false, clear })).toBe('dropped')
    expect(clear).not.toHaveBeenCalled()
    expect(existsSync(marker)).toBe(false)
  })

  it('names the sites that were not fully erased, and does not retry at every launch', async () => {
    markQuitClear(marker)
    expect(await replayQuitClear(marker, { enabled: () => true, clear: async () => ['shop.example'] })).toBe('incomplete')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('resumed'), 'shop.example')
    expect(existsSync(marker)).toBe(false)
  })

  it('logs an erasure that throws, and removes the marker all the same', async () => {
    markQuitClear(marker)
    const boom = new Error('disque occupé')
    expect(
      await replayQuitClear(marker, {
        enabled: () => true,
        clear: async () => {
          throw boom
        }
      })
    ).toBe('incomplete')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('cannot resume'), boom)
    expect(existsSync(marker)).toBe(false)
  })
})
