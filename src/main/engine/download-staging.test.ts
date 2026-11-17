import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DownloadStaging, UnsavedRequests, stagedOutcome, stagingRootFor, type StagingFs } from './download-staging'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'staging-test-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('stagingRootFor', () => {
  it('differs for two data folders and stays inside the temporary folder', () => {
    const a = stagingRootFor('/data/a', '/tmp')
    const b = stagingRootFor('/data/b', '/tmp')
    expect(a).not.toBe(b)
    expect(a.startsWith('/tmp/lucium-')).toBe(true)
    expect(stagingRootFor('/data/a', '/tmp')).toBe(a)
  })
})

describe('DownloadStaging.allocate', () => {
  it('gives each download a folder of its own inside the root and a clean name', () => {
    const staging = new DownloadStaging(join(base, 'root'))
    const path = staging.allocate('dl-1', '../../evil.pdf')
    expect(path).toBe(join(base, 'root', 'dl-1', 'evil.pdf'))
    expect(existsSync(join(base, 'root', 'dl-1'))).toBe(true)
  })

  it('refuses an id that could name another place', () => {
    const staging = new DownloadStaging(join(base, 'root'))
    for (const id of ['', '..', '../x', 'a/b', 'a'.repeat(100)]) expect(() => staging.allocate(id, 'a.pdf')).toThrow(/Invalid download id/)
    expect(existsSync(join(base, 'x'))).toBe(false)
  })

  it('refuses a root that was replaced by a link to elsewhere', () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(base, 'root'))
    const staging = new DownloadStaging(join(base, 'root'))
    expect(() => staging.allocate('dl-1', 'a.pdf')).toThrow(/not a plain folder/)
    expect(existsSync(join(elsewhere, 'dl-1'))).toBe(false)
  })
})

describe('DownloadStaging.sweep', () => {
  it('empties the folder and keeps it', () => {
    const staging = new DownloadStaging(join(base, 'root'))
    writeFileSync(staging.allocate('dl-1', 'a.txt'), 'a')
    writeFileSync(staging.allocate('dl-2', 'b.txt'), 'b')
    const result = staging.sweep()
    expect(result).toEqual({ removed: 2, failures: [] })
    expect(existsSync(join(base, 'root'))).toBe(true)
    expect(existsSync(join(base, 'root', 'dl-1'))).toBe(false)
  })

  it('has nothing to do, and nothing to report, when the folder was never made', () => {
    expect(new DownloadStaging(join(base, 'never')).sweep()).toEqual({ removed: 0, failures: [] })
  })

  it('does not follow a link inside the folder: the target of the link stays', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    const staging = new DownloadStaging(join(base, 'root'))
    staging.allocate('dl-1', 'a.txt')
    symlinkSync(outside, join(base, 'root', 'link'))
    expect(staging.sweep().removed).toBe(2)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep')
  })

  it('does not sweep a root that is a link, and says so', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    symlinkSync(outside, join(base, 'root'))
    const result = new DownloadStaging(join(base, 'root')).sweep()
    expect(result.removed).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
  })

  it('reports each entry it could not remove with its path, and goes on with the others', () => {
    const entries = ['a', 'b', 'c']
    const gone: string[] = []
    const fs: StagingFs = {
      mkdir: () => undefined,
      readdir: () => entries,
      isRealFolder: () => true,
      remove: (path) => {
        if (path.endsWith('/b')) throw new Error('busy')
        gone.push(path)
      },
      rename: () => undefined,
      copy: () => undefined,
      unlink: () => undefined
    }
    const result = new DownloadStaging('/tmp/root', fs).sweep()
    expect(result.removed).toBe(2)
    expect(result.failures).toEqual([{ path: '/tmp/root/b', error: 'busy' }])
    expect(gone).toEqual(['/tmp/root/a', '/tmp/root/c'])
  })
})

describe('DownloadStaging.release and moveOut', () => {
  it('removes the folder of one download only', () => {
    const staging = new DownloadStaging(join(base, 'root'))
    const one = staging.allocate('dl-1', 'a.txt')
    const two = staging.allocate('dl-2', 'b.txt')
    writeFileSync(one, 'a')
    writeFileSync(two, 'b')
    staging.release(one)
    expect(existsSync(join(base, 'root', 'dl-1'))).toBe(false)
    expect(existsSync(two)).toBe(true)
  })

  it('refuses to remove or move what is outside the folder', () => {
    const staging = new DownloadStaging(join(base, 'root'))
    writeFileSync(join(base, 'mine.txt'), 'mine')
    expect(() => staging.release(join(base, 'mine.txt'))).toThrow(/outside/)
    expect(() => staging.release(join(base, 'root', '..', 'mine.txt'))).toThrow(/outside/)
    expect(() => staging.moveOut(join(base, 'mine.txt'), join(base, 'moved.txt'))).toThrow(/outside/)
    expect(() => staging.release(join(base, 'root'))).toThrow(/outside/)
    expect(readFileSync(join(base, 'mine.txt'), 'utf8')).toBe('mine')
  })

  it('moves a staged file to a folder that did not exist', () => {
    const staging = new DownloadStaging(join(base, 'root'))
    const staged = staging.allocate('dl-1', 'a.txt')
    writeFileSync(staged, 'data')
    const target = join(base, 'new', 'deeper', 'a.txt')
    staging.moveOut(staged, target)
    expect(readFileSync(target, 'utf8')).toBe('data')
    expect(existsSync(staged)).toBe(false)
  })

  it('copies then removes when the two places are on different disks, and passes any other error on', () => {
    const calls: string[] = []
    const failing = (code: string): StagingFs => ({
      mkdir: () => undefined,
      readdir: () => [],
      isRealFolder: () => true,
      remove: () => undefined,
      rename: () => {
        throw Object.assign(new Error('rename failed'), { code })
      },
      copy: (from, to) => void calls.push(`copy ${from} ${to}`),
      unlink: (path) => void calls.push(`unlink ${path}`)
    })
    new DownloadStaging('/tmp/root', failing('EXDEV')).moveOut('/tmp/root/dl-1/a', '/dest/a')
    expect(calls).toEqual(['copy /tmp/root/dl-1/a /dest/a', 'unlink /tmp/root/dl-1/a'])
    calls.length = 0
    expect(() => new DownloadStaging('/tmp/root', failing('EACCES')).moveOut('/tmp/root/dl-1/a', '/dest/a')).toThrow(/rename failed/)
    expect(calls).toEqual([])
  })
})

describe('UnsavedRequests', () => {
  const session = {}
  it('answers true once for the address of a request, in its session only', () => {
    const requests = new UnsavedRequests()
    requests.expect(session, 'https://a.example/file.pdf')
    expect(requests.take({}, ['https://a.example/file.pdf'])).toBe(false)
    expect(requests.take(session, ['https://other.example/x'])).toBe(false)
    expect(requests.take(session, ['https://a.example/file.pdf'])).toBe(true)
    expect(requests.take(session, ['https://a.example/file.pdf'])).toBe(false)
  })

  it('follows a redirection: any address of the chain counts', () => {
    const requests = new UnsavedRequests()
    requests.expect(session, 'https://a.example/go')
    expect(requests.take(session, ['https://a.example/go', 'https://cdn.example/real.pdf'])).toBe(true)
  })

  it('forgets a request whose download never came', () => {
    let now = 0
    const requests = new UnsavedRequests(() => now)
    requests.expect(session, 'https://a.example/page')
    now = 16_000
    expect(requests.size).toBe(0)
    expect(requests.take(session, ['https://a.example/page'])).toBe(false)
  })

  it('does not grow without bound', () => {
    const requests = new UnsavedRequests()
    for (let i = 0; i < 100; i++) requests.expect(session, `https://a.example/${i}`)
    expect(requests.size).toBe(20)
  })
})

describe('stagedOutcome', () => {
  it('ends as cancelled a download whose "Save as" was closed after Chromium had finished it: its staged file is removed', () => {
    expect(stagedOutcome('completed', true)).toBe('cancelled')
    expect(stagedOutcome('interrupted', true)).toBe('cancelled')
  })

  it("keeps Chromium's word when the user gave a place", () => {
    expect(stagedOutcome('completed', false)).toBe('completed')
    expect(stagedOutcome('interrupted', false)).toBe('interrupted')
    expect(stagedOutcome('cancelled', false)).toBe('cancelled')
  })
})
