// The partial file of an interrupted download goes with its row, and nothing else does.

import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discardPartialFile, type PartialFs, type PartialRow } from './download-partial'

const NOW = 1_800_000_000_000
const row = (patch: Partial<PartialRow> = {}): PartialRow => ({ path: '/dl/a.bin', receivedBytes: 2048, totalBytes: 10_000, startedAt: NOW, ...patch })
const fsOf = (stat: ReturnType<PartialFs['stat']>) => ({ stat: () => stat, unlink: vi.fn<(path: string) => void>() })
const partial = { isFile: true, size: 2048, mtimeMs: NOW + 5000 }

describe('discardPartialFile', () => {
  it('removes the file that is the partial one: an ordinary file of the size received, short of the size announced, written since the start', () => {
    const fs = fsOf(partial)
    expect(discardPartialFile(row(), fs)).toEqual({ kind: 'removed' })
    expect(fs.unlink).toHaveBeenCalledWith('/dl/a.bin')
  })

  it('removes it when the size announced is not known', () => {
    const fs = fsOf(partial)
    expect(discardPartialFile(row({ totalBytes: 0 }), fs)).toEqual({ kind: 'removed' })
  })

  it('leaves a file that is not surely the partial one: another size, a whole file, older than the download, a link or a folder', () => {
    for (const stat of [{ ...partial, size: 4096 }, { ...partial, size: 10_000 }, { ...partial, mtimeMs: NOW - 60_000 }, { ...partial, isFile: false }]) {
      const fs = fsOf(stat)
      expect(discardPartialFile(row(), fs), JSON.stringify(stat)).toEqual({ kind: 'kept' })
      expect(fs.unlink).not.toHaveBeenCalled()
    }
  })

  it('does nothing for a file that is already gone, a download that received nothing, or a path that is not absolute', () => {
    expect(discardPartialFile(row(), fsOf(null))).toEqual({ kind: 'none' })
    const fs = fsOf(partial)
    expect(discardPartialFile(row({ receivedBytes: 0 }), fs)).toEqual({ kind: 'none' })
    expect(discardPartialFile(row({ path: 'a.bin' }), fs)).toEqual({ kind: 'none' })
    expect(fs.unlink).not.toHaveBeenCalled()
  })

  it('takes a file that vanishes under it (Chromium deletes the file of a download it cancels) for nothing to do, not a failure', () => {
    const fs = fsOf(partial)
    fs.unlink.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, unlink '/dl/a.bin'"), { code: 'ENOENT' })
    })
    expect(discardPartialFile(row(), fs)).toEqual({ kind: 'none' })
  })

  it('says why when the file cannot be removed (the folder is read-only), for the caller to tell the user', () => {
    const fs = fsOf(partial)
    fs.unlink.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    expect(discardPartialFile(row(), fs)).toEqual({ kind: 'failed', reason: 'EACCES: permission denied' })
  })
})

describe('discardPartialFile on a real folder', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'partial-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('removes the partial file, and leaves a link alone', () => {
    const file = join(dir, 'a.bin')
    writeFileSync(file, Buffer.alloc(2048))
    const now = Date.now()
    utimesSync(file, now / 1000, now / 1000)
    expect(discardPartialFile({ path: file, receivedBytes: 2048, totalBytes: 10_000, startedAt: now - 1000 })).toEqual({ kind: 'removed' })
    expect(existsSync(file)).toBe(false)
    const target = join(dir, 'target.bin')
    writeFileSync(target, Buffer.alloc(2048))
    const link = join(dir, 'link.bin')
    symlinkSync(target, link)
    expect(discardPartialFile({ path: link, receivedBytes: 2048, totalBytes: 10_000, startedAt: now - 1000 })).toEqual({ kind: 'kept' })
    expect(existsSync(target)).toBe(true)
  })
})
