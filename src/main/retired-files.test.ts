// The keys of the online providers of the summary are not left on the disk once nothing reads them. A real folder, real files.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RETIRED_FILES, removeRetiredFiles } from './retired-files'

let folder = ''

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lucium-retired-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(folder, { recursive: true, force: true })
})

describe('the retired files of the data folder', () => {
  it('are removed, and nothing else is', () => {
    writeFileSync(join(folder, 'ai-keys.json'), '{"openai":"…"}')
    writeFileSync(join(folder, 'state.json'), '{}')
    removeRetiredFiles(folder)
    expect(existsSync(join(folder, 'ai-keys.json'))).toBe(false)
    expect(readdirSync(folder)).toEqual(['state.json'])
  })

  it('are no error when they are not there, the usual case', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileSync(join(folder, 'state.json'), '{}')
    expect(() => removeRetiredFiles(folder)).not.toThrow()
    expect(readdirSync(folder)).toEqual(['state.json'])
    expect(warned).not.toHaveBeenCalled()
  })

  it('say in the log which file could not be removed, and do not stop the launch', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('EPERM')
    const remove = vi.fn(() => {
      throw failure
    })
    expect(() => removeRetiredFiles(folder, remove)).not.toThrow()
    expect(remove).toHaveBeenCalledTimes(RETIRED_FILES.length)
    expect(remove).toHaveBeenCalledWith(join(folder, 'ai-keys.json'))
    expect(warned).toHaveBeenCalledWith('[retired-files] ai-keys.json could not be removed from the data folder:', failure)
  })
})
