import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packHosts } from '@shared/safe-set'

vi.mock('electron', () => ({ app: { getAppPath: () => '/nowhere' } }))
const { allowSafeHost, RETRY_AFTER_MS, releaseSafeLists, safeAllowedHosts, safeLists, safeListsLoaded, safeListsStatus } = await import('./safe-lists')

function folder(files: Record<string, Uint8Array | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'safe-lists-'))
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes)
  return dir
}

afterEach(() => {
  releaseSafeLists()
  vi.useRealTimers()
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

  it('says « unavailable » when a list is missing or damaged, and « ready » when both are read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeLists(folder({ 'phishing.bin': packHosts(['a.example']) }))
    expect(safeListsStatus()).toBe('unavailable')
    releaseSafeLists()
    safeLists(folder({ 'phishing.bin': packHosts(['a.example']), 'malware.bin': packHosts(['b.example']) }))
    expect(safeListsStatus()).toBe('ready')
  })

  it('does not keep a failure for the whole run: it reads again after a while, and finds a file put back', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dir = folder({ 'phishing.bin': packHosts(['a.example']) })
    expect(safeLists(dir).malware).toBeNull()
    // Within the delay the answer is the one in memory (no read at each page).
    writeFileSync(join(dir, 'malware.bin'), packHosts(['b.example']))
    vi.advanceTimersByTime(RETRY_AFTER_MS - 1)
    expect(safeLists(dir).malware).toBeNull()
    vi.advanceTimersByTime(1)
    expect(safeLists(dir).malware?.has('b.example')).toBe(true)
    expect(safeListsStatus()).toBe('ready')
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
