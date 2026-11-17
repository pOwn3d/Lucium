import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeTempDirs, tempDir } from './temp-dir'

describe('tempDir', () => {
  const seen: string[] = []

  it('makes an empty folder with the prefix asked for', () => {
    const dir = tempDir('lucium-temp-dir-test-')
    seen.push(dir)
    expect(existsSync(dir)).toBe(true)
    expect(dir).toContain('lucium-temp-dir-test-')
    writeFileSync(join(dir, 'file.txt'), 'x')
  })

  it('has removed the folder of the test before', () => {
    // The clean-up is the `afterEach` this file registers by importing the helper: the folder of the previous test must be gone.
    expect(seen).toHaveLength(1)
    expect(existsSync(seen[0]!)).toBe(false)
  })

  it('removes a folder a test locked on purpose', () => {
    const dir = tempDir('lucium-temp-dir-locked-')
    mkdirSync(join(dir, 'locked'))
    writeFileSync(join(dir, 'locked', 'file.txt'), 'x')
    chmodSync(join(dir, 'locked'), 0o500)
    expect(removeTempDirs()).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it('says so, and keeps going, when a folder cannot be removed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stuck = tempDir('lucium-temp-dir-stuck-')
    const other = tempDir('lucium-temp-dir-other-')
    const refuse = (dir: string) => {
      if (dir === stuck) throw new Error('EPERM')
      rmSync(dir, { recursive: true, force: true })
    }
    expect(removeTempDirs(refuse)).toEqual([stuck])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(stuck), expect.any(Error))
    expect(existsSync(other)).toBe(false)
    warn.mockRestore()
    // Left to the clean-up of the test, which does not refuse.
    expect(existsSync(stuck)).toBe(true)
  })
})
