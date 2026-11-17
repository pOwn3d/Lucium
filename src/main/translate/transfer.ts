// The transfer of one file of a download the user clicked (a file of a language pack, or the engine's binary): from the address of the plan and no other,
// redirects refused, no cookie. What arrives goes to a partial file named by the fingerprint it must have, in a `.partial` folder of the folder being filled:
// a download cut short (the network, a stop, the application quitting) leaves it there, and the next download of the same file asks only for the bytes
// that are missing (a Range request; a server that answers with the whole file is read from the start). The partial file is checked whole, size and
// SHA-256, then decompressed (zstd) into its place with the size and SHA-256 the plan gives for the decompressed file. Nothing reaches the network
// from here but that one request per file.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline, type Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { TransferFile } from '@shared/translate-local'

export interface FetchInit {
  signal: AbortSignal
  redirect: 'error'
  credentials: 'omit'
  /**
   * These requests go through the session of the interface, whose HTTP cache is on disk: a model (tens of megabytes, already written whole in the
   * folder of the models) would be kept a second time there, and the catalogue would leave in it which languages were looked up, after the model is removed.
   */
  cache: 'no-store'
  headers?: Record<string, string>
}
export type Fetch = (url: string, init: FetchInit) => Promise<Response>

/** The folder of the partial files, inside the folder a download fills. */
export const PARTIAL_DIR = '.partial'
const PARTIAL_NAME = /^[0-9a-f]{64}\.part$/
/** A partial file nobody came back for is removed after this long. */
export const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface TransferDeps {
  fetch: Fetch
  signal: AbortSignal
  /** The folder of the partial files (`<folder>/.partial`). */
  partialDir: string
  /** Bytes received from the network. */
  spend?(bytes: number): void
}

export type TransferResult = { ok: true } | { ok: false; reason: string }

/** What travels for a file: the compressed file when there is one, else the file itself. */
const wire = (file: TransferFile): { size: number; sha256: string } => file.transfer ?? { size: file.size, sha256: file.sha256 }

export const partialPath = (partialDir: string, file: TransferFile): string => join(partialDir, `${wire(file).sha256}.part`)

/** The SHA-256 and size of a file, read as a stream. */
async function digest(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    size += chunk.length
    hash.update(chunk)
  }
  return { size, sha256: hash.digest('hex') }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/**
 * Brings the partial file of `file` to its full size: nothing to do when it is there whole, the missing bytes when a part is there, else all of it.
 * Answers 'ok', or why not ('size', 'range', 'http 404'); a failure of the network or a stop throws, and leaves what arrived for the next time.
 */
async function fetchPart(file: TransferFile, part: string, deps: TransferDeps): Promise<'ok' | string> {
  const expected = wire(file)
  let have = await sizeOf(part)
  if (have > expected.size) {
    await rm(part, { force: true })
    have = 0
  }
  if (have === expected.size) return 'ok'
  const init: FetchInit = { signal: deps.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}) }
  const response = await deps.fetch(file.url, init)
  let append = false
  if (have > 0 && response.status === 206) {
    // The server goes on from where the file stopped, and says so in Content-Range; anything else starts it again.
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
    if (!range || Number(range[1]) !== have || Number(range[3]) !== expected.size) {
      // Cancelling a body that is not wanted can only fail when it is already closed: nothing is left to do then, so the error is dropped (here and below).
      await response.body?.cancel().catch(() => undefined)
      await rm(part, { force: true })
      return 'range'
    }
    append = true
  } else if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    return `http ${response.status}`
  }
  const remaining = expected.size - (append ? have : 0)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > remaining) {
    await response.body!.cancel().catch(() => undefined)
    if (!append) await rm(part, { force: true })
    return 'size'
  }
  // Made here, right before the file is: nothing can have removed it since.
  await mkdir(deps.partialDir, { recursive: true, mode: 0o700 })
  const handle = await open(part, append ? 'a' : 'w', 0o600)
  const reader = response.body!.getReader()
  let received = 0
  let tooBig = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      // The plan said how big the file is; more than that is not that file, and is not written.
      if (received + value.length > remaining) {
        tooBig = true
        break
      }
      await handle.write(value)
      received += value.length
      deps.spend?.(value.length)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    await handle.close()
  }
  if (tooBig) {
    await rm(part, { force: true })
    return 'size'
  }
  // A body that ended early leaves its bytes for the next time; the check below would refuse it now.
  return received === remaining ? 'ok' : 'size'
}

/** Writes the partial file, decompressed when it travelled compressed, into `into`, never more than `size` bytes; answers what was written. */
async function unpack(part: string, into: string, file: TransferFile): Promise<{ size: number; sha256: string } | 'size'> {
  const hash = createHash('sha256')
  let total = 0
  const out = await open(into, 'wx', 0o600)
  try {
    const source = createReadStream(part)
    // pipeline() passes an error of either stream on to the one read below, and destroys both when the reading stops.
    const stream: Readable = file.transfer ? pipeline(source, createZstdDecompress(), () => undefined) : source
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length
      // A file that decompresses into more than the record says is refused there, before it fills the disk.
      if (total > file.size) {
        stream.destroy()
        return 'size'
      }
      hash.update(chunk)
      await out.write(chunk)
    }
  } finally {
    await out.close()
  }
  return { size: total, sha256: hash.digest('hex') }
}

/**
 * Fetches one file of a plan into `into` (a path that does not exist yet, in the staging folder of the download), checked twice: the bytes that came
 * (size and SHA-256 of the compressed file), then the file written (size and SHA-256 of the decompressed file). A partial file that does not match is
 * removed, so the next attempt starts again. The partial file of a good transfer stays until `forgetPartials`, so that a later file failing does not
 * cost this one again.
 */
export async function transferFile(file: TransferFile, into: string, deps: TransferDeps): Promise<TransferResult> {
  const part = partialPath(deps.partialDir, file)
  const fetched = await fetchPart(file, part, deps)
  if (fetched !== 'ok') return { ok: false, reason: fetched }
  // The whole file read again: a resumed one is the bytes of two answers.
  const arrived = await digest(part)
  const expected = wire(file)
  if (arrived.size !== expected.size || arrived.sha256 !== expected.sha256) {
    await rm(part, { force: true })
    return { ok: false, reason: arrived.size !== expected.size ? 'size' : 'fingerprint' }
  }
  let written: { size: number; sha256: string } | 'size'
  try {
    written = await unpack(part, into, file)
  } catch (error) {
    // The compressed file matched its fingerprint and still does not decompress: it is not kept for another try.
    await rm(part, { force: true })
    await rm(into, { force: true })
    console.warn(`[translate] ${file.name} does not decompress:`, error instanceof Error ? error.message : String(error))
    return { ok: false, reason: 'decompress' }
  }
  if (written === 'size' || written.size !== file.size || written.sha256 !== file.sha256) {
    await rm(part, { force: true })
    await rm(into, { force: true })
    return { ok: false, reason: written === 'size' || written.size !== file.size ? 'size' : 'fingerprint' }
  }
  return { ok: true }
}

/** Removes the partial files of a download that ended well, and the folder when nothing else is in it. Never throws: a file left is logged. */
export async function forgetPartials(partialDir: string, files: readonly TransferFile[]): Promise<void> {
  for (const file of files) {
    await rm(partialPath(partialDir, file), { force: true }).catch((error: unknown) => console.warn(`[translate] cannot remove the partial file of ${file.name}:`, error instanceof Error ? error.message : String(error)))
  }
  await dropIfEmpty(partialDir)
}

/** Removes the folder of the partial files when it is empty (a download that failed before any byte came leaves nothing behind). */
export async function dropIfEmpty(partialDir: string): Promise<void> {
  try {
    await rmdir(partialDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') console.warn(`[translate] cannot remove ${partialDir}:`, error instanceof Error ? error.message : String(error))
  }
}

/** Removes the partial files older than PARTIAL_MAX_AGE_MS (a download nobody resumed). Never throws; answers how many went. */
export async function sweepPartials(partialDir: string, now = Date.now()): Promise<number> {
  let names: string[]
  try {
    names = await readdir(partialDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[translate] cannot look for old partial files in ${partialDir}:`, error instanceof Error ? error.message : String(error))
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!PARTIAL_NAME.test(name)) continue
    const path = join(partialDir, name)
    try {
      if (now - (await stat(path)).mtimeMs > PARTIAL_MAX_AGE_MS) {
        await rm(path, { force: true })
        removed++
      }
    } catch (error) {
      console.warn(`[translate] cannot remove the old partial file ${path}:`, error instanceof Error ? error.message : String(error))
    }
  }
  await dropIfEmpty(partialDir)
  return removed
}
