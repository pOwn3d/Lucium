// The download of the .deb a person is told about (update-deb-file.ts), on real files in throw-away folders and a stand-in for the network: the file reaches the
// Downloads folder only once its size and SHA-256 are the signed ones, under Lucium's own name, and a file of that name that is not the same is never overwritten.
// Nothing reaches the network, and nothing is installed.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateOffer } from '@shared/update-check'
import { downloadDeb } from './update-deb-file'
import type { DownloadResponse, InstallerFetch } from './update-installer-file'

const BYTES = new TextEncoder().encode('!<arch>-the-deb-'.repeat(60))
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const URL_OF_FILE = 'https://lucium.app/updates/linux-x64/deb/Lucium-1.2.0-linux-amd64.deb'
const NAME = 'Lucium-1.2.0-linux-amd64.deb'

const offerFor = (bytes: Uint8Array, over: Partial<UpdateOffer> = {}): UpdateOffer => ({ version: '1.2.0', url: 'https://lucium.app/telecharger/', notes: '', archive: URL_OF_FILE, size: bytes.byteLength, sha256: sha(bytes), kind: 'deb', ...over })
const response = (bytes: Uint8Array): DownloadResponse => {
  let sent = false
  return {
    ok: true,
    status: 200,
    url: URL_OF_FILE,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.close()
        sent = true
        controller.enqueue(bytes)
      }
    })
  }
}
const serving = (bytes: Uint8Array) => vi.fn<InstallerFetch>(async () => response(bytes))

let temp: string
let downloads: string
let workFolder: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'lucium-deb-'))
  downloads = join(temp, 'Downloads')
  workFolder = join(temp, 'work', 'lucium-update')
  mkdirSync(downloads)
  mkdirSync(join(temp, 'work'))
})
afterEach(() => {
  rmSync(temp, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const deps = (fetch: InstallerFetch, arch = 'x64') => ({ fetch, workFolder, downloads, arch })

describe('downloadDeb: the signed .deb, in the Downloads folder, never installed', () => {
  it('puts the checked bytes in Downloads under Lucium’s own name, and leaves no working folder behind', async () => {
    const fetch = serving(BYTES)
    const done = await downloadDeb(deps(fetch), offerFor(BYTES))
    expect(done).toEqual({ ok: true, file: join(downloads, NAME), sha256: sha(BYTES) })
    expect(readFileSync(join(downloads, NAME))).toEqual(Buffer.from(BYTES))
    expect(readdirSync(downloads)).toEqual([NAME])
    expect(existsSync(workFolder)).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe(URL_OF_FILE)
    expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: 'no-store', credentials: 'omit' })
  })

  it('names the file from the signed version and the architecture of this copy, whatever the address says', async () => {
    const done = await downloadDeb(deps(serving(BYTES), 'arm64'), offerFor(BYTES, { archive: 'https://lucium.app/updates/x/..%2F..%2Fevil.deb' }))
    expect(done).toMatchObject({ ok: true, file: join(downloads, 'Lucium-1.2.0-linux-arm64.deb') })
    expect(readdirSync(downloads)).toEqual(['Lucium-1.2.0-linux-arm64.deb'])
  })

  it('writes nothing to Downloads for bytes that are not the signed ones, and removes its working folder', async () => {
    const other = BYTES.slice()
    other[3] = other[3]! ^ 0xff
    const done = await downloadDeb(deps(serving(other)), offerFor(BYTES))
    expect(done).toMatchObject({ ok: false, kind: 'mismatch' })
    expect(readdirSync(downloads)).toEqual([])
    expect(existsSync(workFolder)).toBe(false)
  })

  it('asks nothing of the network for an offer that is not a .deb it can name and check', async () => {
    for (const [over, arch] of [[{ kind: 'appimage' }, 'x64'], [{ version: '1.2.0-beta' }, 'x64'], [{ version: '../1.2.0' }, 'x64'], [{}, 'ia32'], [{ sha256: undefined }, 'x64'], [{ archive: 'http://lucium.app/a.deb' }, 'x64']] as [Partial<UpdateOffer>, string][]) {
      const fetch = serving(BYTES)
      const done = await downloadDeb(deps(fetch, arch), offerFor(BYTES, over))
      expect(done, JSON.stringify([over, arch])).toMatchObject({ ok: false, kind: 'offer' })
      expect(fetch).not.toHaveBeenCalled()
    }
    expect(readdirSync(downloads)).toEqual([])
  })

  it('keeps a file of the same name that is the same file (downloaded before), and does not write it again', async () => {
    writeFileSync(join(downloads, NAME), BYTES)
    const done = await downloadDeb(deps(serving(BYTES)), offerFor(BYTES))
    expect(done).toEqual({ ok: true, file: join(downloads, NAME), sha256: sha(BYTES) })
    expect(readFileSync(join(downloads, NAME))).toEqual(Buffer.from(BYTES))
    expect(existsSync(workFolder)).toBe(false)
  })

  it('never overwrites a file of the same name that is not the signed one: it is the person’s, and the failure says where to look', async () => {
    writeFileSync(join(downloads, NAME), 'a file of theirs')
    const done = await downloadDeb(deps(serving(BYTES)), offerFor(BYTES))
    expect(done).toMatchObject({ ok: false, kind: 'disk', detail: expect.stringContaining(join(downloads, NAME)) })
    expect(readFileSync(join(downloads, NAME), 'utf8')).toBe('a file of theirs')
    expect(existsSync(workFolder)).toBe(false)
  })

  it('says the disk failed when Downloads is not there, and removes its working folder', async () => {
    rmSync(downloads, { recursive: true })
    const done = await downloadDeb(deps(serving(BYTES)), offerFor(BYTES))
    expect(done).toMatchObject({ ok: false, kind: 'disk' })
    expect(existsSync(workFolder)).toBe(false)
  })
})
