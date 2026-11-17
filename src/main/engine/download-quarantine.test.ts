// The "downloaded from the Internet" mark of a finished download: what is written, where, and what happens when it cannot be.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { EARLY_MARK_TRIES, QUARANTINE_AGENT, earlyQuarantine, quarantineDownload, quarantineValue } from './download-quarantine'

const UUID = '0123abcd-0000-4000-8000-0123456789ab'

describe('quarantineValue', () => {
  it('is written in the format of the attribute: flags, the time in hexadecimal seconds, the application, an identifier', () => {
    expect(quarantineValue(1_793_038_527_137, 'ID')).toBe(`0083;${(1_793_038_527).toString(16)};${QUARANTINE_AGENT};ID`)
  })
})

describe('quarantineDownload', () => {
  it('marks the file with the system\'s xattr on macOS, the path as one argument and no shell', async () => {
    const run = vi.fn(async () => undefined)
    await expect(quarantineDownload('/Users/x/Downloads/a b; rm -rf ~.dmg', { platform: 'darwin', now: () => 5000, uuid: () => UUID, run })).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;5;Lucium;${UUID.toUpperCase()}`, '/Users/x/Downloads/a b; rm -rf ~.dmg'])
  })

  it('does nothing, and runs nothing, on the other systems', async () => {
    const run = vi.fn(async () => undefined)
    for (const platform of ['linux', 'win32'] as const) await expect(quarantineDownload('/home/x/a.bin', { platform, run })).resolves.toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('says why when the mark cannot be written (a read-only volume, no xattr), and does not throw', async () => {
    const run = vi.fn(async () => {
      throw new Error('xattr: [Errno 30] Read-only file system')
    })
    await expect(quarantineDownload('/Volumes/ro/a.bin', { platform: 'darwin', run })).resolves.toEqual({ ok: false, reason: 'xattr: [Errno 30] Read-only file system' })
  })

  it('refuses a path that is not absolute, without running anything (a name starting with a dash is not an option)', async () => {
    const run = vi.fn(async () => undefined)
    await expect(quarantineDownload('-w', { platform: 'darwin', run })).resolves.toEqual({ ok: false, reason: 'the path of the file is not absolute' })
    expect(run).not.toHaveBeenCalled()
  })

  it('really writes the attribute on this machine (macOS only)', async () => {
    if (process.platform !== 'darwin') return
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const dir = mkdtempSync(join(tmpdir(), 'quarantine-'))
    try {
      const file = join(dir, 'a.bin')
      writeFileSync(file, 'x')
      await expect(quarantineDownload(file)).resolves.toEqual({ ok: true })
      expect(execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { encoding: 'utf8' })).toMatch(/^0083;[0-9a-f]+;Lucium;[0-9A-F-]{36}\n$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the mark of a download that is still running', () => {
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('is put once, as soon as something was written, on the file being written', async () => {
    const mark = vi.fn(async (_path: string) => ({ ok: true }) as const)
    const progress = earlyQuarantine(() => '/Users/x/Downloads/installeur.dmg', mark, () => undefined)
    progress(0)
    expect(mark).not.toHaveBeenCalled()
    progress(4096)
    await settle()
    progress(8192)
    progress(1_000_000)
    await settle()
    expect(mark).toHaveBeenCalledExactlyOnceWith('/Users/x/Downloads/installeur.dmg')
  })

  it('is tried again when the file is not there yet, a few times only, and each failure is logged with its reason', async () => {
    const mark = vi.fn(async (_path: string) => ({ ok: false, reason: 'No such file' }) as const)
    const logged: string[] = []
    const progress = earlyQuarantine(() => '/Users/x/Downloads/a.zip', mark, (message) => void logged.push(message))
    for (let i = 1; i <= EARLY_MARK_TRIES + 3; i++) {
      progress(i * 1000)
      await settle()
    }
    expect(mark).toHaveBeenCalledTimes(EARLY_MARK_TRIES)
    expect(logged).toHaveLength(EARLY_MARK_TRIES)
    expect(logged[0]).toContain('No such file')
  })

  it('is not asked for twice at the same time', async () => {
    let finish: (outcome: { ok: true }) => void = () => undefined
    const mark = vi.fn((_path: string) => new Promise<{ ok: true }>((resolve) => (finish = resolve)))
    const progress = earlyQuarantine(() => '/Users/x/Downloads/a.zip', mark, () => undefined)
    progress(10)
    progress(20)
    expect(mark).toHaveBeenCalledTimes(1)
    finish({ ok: true })
    await settle()
    progress(30)
    expect(mark).toHaveBeenCalledTimes(1)
  })

  // Only Electron runs a download; the call is read in the source, as for the rest of the wiring of the engine.
  it('is asked for at each sign of progress of a download, with the path it is written to', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'electron-engine-downloads.ts'), 'utf8')
    expect(source).toContain('const markEarly = earlyQuarantine(() => path)')
    const updated = source.slice(source.indexOf("item.on('updated'"))
    expect(updated.slice(0, 120)).toContain('markEarly(item.getReceivedBytes())')
  })
})
