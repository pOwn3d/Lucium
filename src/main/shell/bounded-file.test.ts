import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// `stat` can be made to lie for one path (the size a file had before it grew); everything else is the real thing.
const lies = vi.hoisted(() => ({ path: '' as string, size: 0, opened: 0, closed: 0, requested: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    stat: async (path: string, ...rest: unknown[]) => {
      const info = await (real.stat as (...args: unknown[]) => Promise<import('node:fs').Stats>)(path, ...rest)
      return path === lies.path ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { size: lies.size }) : info
    },
    // The files that are opened, and the most that any read of them asked for.
    open: async (...args: Parameters<typeof real.open>) => {
      lies.opened++
      const handle = await real.open(...args)
      const close = handle.close.bind(handle)
      ;(handle as unknown as { close: unknown }).close = () => {
        lies.closed++
        return close()
      }
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<unknown>
      ;(handle as unknown as { read: unknown }).read = (buffer: Buffer, offset: number, length: number, position: number) => {
        lies.requested += length
        return read(buffer, offset, length, position)
      }
      return handle
    }
  }
})

import { fileFailureMessage, readBoundedText } from './bounded-file'
import { frenchSpaces } from '@shared/french-typography'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-bounded-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  lies.path = ''
  lies.opened = 0
  lies.closed = 0
  lies.requested = 0
  vi.restoreAllMocks()
})

const file = (name: string, content: string | Buffer): string => {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('reading a file that may be hostile', () => {
  it('returns the text of a regular file, accents included', async () => {
    expect(await readBoundedText(file('ok.json', '{"é":"日本語"}\n'), 1000)).toEqual({ ok: true, text: '{"é":"日本語"}\n' })
    expect(await readBoundedText(file('empty.json', ''), 1000)).toEqual({ ok: true, text: '' })
  })

  it('follows a link to a regular file', async () => {
    const target = file('target.json', '{}')
    const link = join(dir, 'link.json')
    symlinkSync(target, link)
    expect(await readBoundedText(link, 1000)).toEqual({ ok: true, text: '{}' })
  })

  it('accepts a file of exactly the limit and refuses one byte more, by its size, without reading it', async () => {
    expect(await readBoundedText(file('exact.json', 'x'.repeat(100)), 100)).toMatchObject({ ok: true })
    expect(await readBoundedText(file('over.json', 'x'.repeat(101)), 100)).toEqual({ ok: false, reason: 'too-large' })
  })

  it('does not even open a file whose size is over the limit', async () => {
    expect(await readBoundedText(file('too-big.json', 'x'.repeat(5000)), 100)).toEqual({ ok: false, reason: 'too-large' })
    expect(lies.opened).toBe(0)
    expect(await readBoundedText(file('fits.json', 'x'.repeat(50)), 100)).toMatchObject({ ok: true })
    expect(lies.opened).toBe(1)
  })

  it('lets go of the file whatever it finds in it', async () => {
    await readBoundedText(file('closing-ok.json', '{}'), 100)
    await readBoundedText(file('closing-binary.json', Buffer.from([0xff, 0xfe])), 100)
    const grown = file('closing-grown.json', 'x'.repeat(5000))
    lies.path = grown
    lies.size = 10
    await readBoundedText(grown, 100)
    expect(lies.opened).toBe(3)
    expect(lies.closed).toBe(3)
  })

  it('counts bytes, not characters', async () => {
    expect(await readBoundedText(file('bytes.json', 'é'.repeat(60)), 100)).toEqual({ ok: false, reason: 'too-large' })
    expect(await readBoundedText(file('bytes-ok.json', 'é'.repeat(50)), 100)).toMatchObject({ ok: true })
  })

  it('refuses a file that grew after its size was looked at: it never reads more than the limit plus one byte', async () => {
    const path = file('grown.json', 'x'.repeat(5000))
    lies.path = path
    lies.size = 10
    expect(await readBoundedText(path, 100)).toEqual({ ok: false, reason: 'too-large' })
    // It asked for one byte more than the limit, and not for the file: that is all it ever holds in memory.
    expect(lies.requested).toBe(101)
  })

  it('does not wait for a pipe or read a device for ever, nor open a folder', async () => {
    const pipe = join(dir, 'pipe')
    execFileSync('mkfifo', [pipe])
    const folder = join(dir, 'folder')
    mkdirSync(folder)
    const started = Date.now()
    expect(await readBoundedText(pipe, 100)).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await readBoundedText('/dev/zero', 100)).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await readBoundedText('/dev/null', 100)).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await readBoundedText(folder, 100)).toEqual({ ok: false, reason: 'not-a-file' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('says a file is gone, in both ways a path can be', async () => {
    expect(await readBoundedText(join(dir, 'nothing.json'), 100)).toEqual({ ok: false, reason: 'not-found' })
    expect(await readBoundedText(join(dir, 'ok.json', 'inside'), 100)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('refuses bytes that are not UTF-8 text', async () => {
    expect(await readBoundedText(file('binary.json', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), 100)).toEqual({ ok: false, reason: 'not-text' })
    expect(await readBoundedText(file('latin1.json', Buffer.from('caf\xe9', 'latin1')), 100)).toEqual({ ok: false, reason: 'not-text' })
  })

  it.skipIf(process.getuid?.() === 0)('reports a file it may not read, with the code, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const path = file('locked.json', '{}')
    chmodSync(path, 0o000)
    const result = await readBoundedText(path, 100)
    chmodSync(path, 0o600)
    expect(result).toEqual({ ok: false, reason: 'unreadable', detail: 'EACCES' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot read'), expect.anything())
  })

  it('has a sentence for each failure', () => {
    for (const reason of ['not-found', 'not-a-file', 'too-large', 'not-text', 'unreadable'] as const) {
      const sentence = fileFailureMessage({ ok: false, reason, detail: 'EIO' }, 512 * 1024)
      expect(sentence.length, reason).toBeGreaterThan(15)
      expect(sentence.endsWith('.'), reason).toBe(true)
    }
    expect(fileFailureMessage({ ok: false, reason: 'too-large' }, 512 * 1024)).toContain(frenchSpaces('512 Ko'))
    expect(fileFailureMessage({ ok: false, reason: 'unreadable', detail: 'EIO' }, 1)).toContain('EIO')
  })
})
