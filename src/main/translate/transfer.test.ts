import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATTACHMENTS_HOST, type TransferFile } from '@shared/translate-local'
import { transferFile } from './transfer'

// What the transfer writes, counted at the file handles: a check of a size after the fact cannot tell a file stopped at its size from a file written
// whole and refused afterwards (a bomb that filled the disk first).
const written = new Map<string, number>()
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      const path = String(args[0])
      const write = handle.write.bind(handle) as (data: Uint8Array) => Promise<unknown>
      ;(handle as unknown as { write: (data: Uint8Array) => Promise<unknown> }).write = async (data: Uint8Array) => {
        written.set(path, (written.get(path) ?? 0) + data.byteLength)
        return write(data)
      }
      return handle
    }
  }
})

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const dirs: string[] = []
afterEach(() => {
  written.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('decompressing a file', () => {
  it('stops writing at the size the record gives, however much the compressed file holds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lucium-transfer-'))
    dirs.push(root)
    const bomb = zstdCompressSync(Buffer.alloc(64 * 1024 * 1024))
    const file: TransferFile = { name: 'model.bin', size: 1000, sha256: 'a'.repeat(64), url: `https://${ATTACHMENTS_HOST}/x.zst`, transfer: { encoding: 'zstd', size: bomb.length, sha256: sha(bomb) } }
    const into = join(root, 'model.bin')
    const result = await transferFile(file, into, {
      fetch: async () => new Response(new Uint8Array(bomb), { status: 200 }),
      signal: new AbortController().signal,
      partialDir: join(root, '.partial')
    })
    expect(result).toEqual({ ok: false, reason: 'size' })
    // Less than one chunk of the decompressor beyond nothing: never the 64 MB the bomb would give.
    expect(written.get(into) ?? 0).toBeLessThanOrEqual(file.size)
    expect(readdirSync(root)).toEqual(['.partial'])
  })
})
