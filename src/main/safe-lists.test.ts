import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packHosts } from '@shared/safe-set'

vi.mock('electron', () => ({ app: { getAppPath: () => '/nowhere' } }))
const { allowSafeHost, releaseSafeLists, safeAllowedHosts, safeLists, safeListsLoaded } = await import('./safe-lists')

function folder(files: Record<string, Uint8Array | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'safe-lists-'))
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes)
  return dir
}

afterEach(() => {
  releaseSafeLists()
  vi.restoreAllMocks()
})

describe('the lists on this machine', () => {
  it('reads nothing until asked, then both lists once', () => {
    const dir = folder({ 'phishing.bin': packHosts(['phish.example']), 'malware.bin': packHosts(['malware.example']) })
    expect(safeListsLoaded()).toBe(false)
    const lists = safeLists(dir)
    expect(lists.phishing?.has('phish.example')).toBe(true)
    expect(lists.malware?.has('malware.example')).toBe(true)
    expect(safeListsLoaded()).toBe(true)
    expect(safeLists(folder({}))).toBe(lists)
  })

  it('tells a missing or damaged file on the console and goes on without that list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const lists = safeLists(folder({ 'phishing.bin': 'not a list' }))
    expect(lists).toEqual({ phishing: null, malware: null })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]![0])).toContain('phishing.bin')
    expect(String(warn.mock.calls[1]![0])).toContain('malware.bin')
  })

  it('lets go of the lists and of the hosts let through when the feature goes off', () => {
    safeLists(folder({ 'phishing.bin': packHosts(['a.example']), 'malware.bin': packHosts(['b.example']) }))
    allowSafeHost('phish.example')
    expect(safeAllowedHosts().has('phish.example')).toBe(true)
    releaseSafeLists()
    expect(safeListsLoaded()).toBe(false)
    expect(safeAllowedHosts().size).toBe(0)
  })
})
