// The download of the installer of a Windows update (update-installer-file.ts), on real files in a throw-away folder and a stand-in for the network: the file is kept
// only when its size and its SHA-256 are the signed ones, under a name that is Lucium's own, in a folder that was made new. Nothing reaches the network.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateOffer } from '@shared/update-check'
import {
  INSTALLER_FILE_NAME,
  INSTALLER_FOLDER,
  INSTALLER_MAX_BYTES,
  discardInstallerFolder,
  discardInstallerFolderNow,
  downloadVerifiedInstaller,
  installerClaim,
  installerFolder,
  verifyInstallerFile,
  type DownloadResponse,
  type InstallerFetch
} from './update-installer-file'

const BYTES = new TextEncoder().encode('MZ-this-stands-for-the-installer-'.repeat(40))
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const URL_OF_FILE = 'https://lucium.app/updates/win32-x64/Lucium-Setup-1.2.0-x64.exe'

const offerFor = (bytes: Uint8Array, over: Partial<UpdateOffer> = {}): UpdateOffer => ({
  version: '1.2.0',
  url: 'https://lucium.app/telecharger/',
  notes: '',
  archive: URL_OF_FILE,
  size: bytes.byteLength,
  sha256: sha(bytes),
  kind: 'nsis',
  ...over
})

/** A body that arrives in pieces of `piece` bytes; `pulled` counts what was read of it, `cancelled` says whether the reader stopped it. */
function stream(bytes: Uint8Array, piece = 64) {
  const state = { pulled: 0, cancelled: false }
  let at = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close()
      controller.enqueue(bytes.slice(at, at + piece))
      at += piece
      state.pulled += 1
    },
    cancel() {
      state.cancelled = true
    }
  })
  return { body, state }
}

const answer = (body: ReadableStream<Uint8Array> | null, over: Partial<DownloadResponse> = {}): DownloadResponse => ({ ok: true, status: 200, url: URL_OF_FILE, headers: { get: () => null }, body, ...over })
const serving = (bytes: Uint8Array, over: Partial<DownloadResponse> = {}) => {
  const { body, state } = stream(bytes)
  const fetch = vi.fn<InstallerFetch>(async () => answer(body, over))
  return { fetch, state }
}

/** A link, or false when the system does not let this account make one (Windows without the privilege): the test that needs it is then skipped, not failed. */
function link(target: string, path: string, type: 'dir' | 'junction' | 'file'): boolean {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

let temp: string
let folder: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'lucium-installer-file-'))
  folder = installerFolder(temp)
})
afterEach(() => {
  rmSync(temp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('installerClaim: what an offer must say to be an installer', () => {
  it('reads the address, the sum and the size of an NSIS installer at an https address', () => {
    expect(installerClaim(offerFor(BYTES))).toEqual({ url: URL_OF_FILE, sha256: sha(BYTES), size: BYTES.byteLength })
  })

  it.each<[string, Partial<UpdateOffer>]>([
    ['a file of macOS (a zip)', { kind: 'zip' }],
    ['an offer with no kind (a feed written before the keys existed)', { kind: undefined }],
    ['an AppImage', { kind: 'appimage' }],
    ['no address', { archive: undefined }],
    ['an address that is not https', { archive: 'http://lucium.app/Lucium-Setup.exe' }],
    ['no sum', { sha256: undefined }],
    ['a sum in capitals', { sha256: sha(BYTES).toUpperCase() }],
    ['a sum of 63 digits', { sha256: sha(BYTES).slice(1) }],
    ['no size', { size: undefined }],
    ['a size of zero', { size: 0 }],
    ['a negative size', { size: -5 }],
    ['a size that is not whole', { size: 10.5 }],
    ['a size above the most an installer may weigh', { size: INSTALLER_MAX_BYTES + 1 }]
  ])('refuses %s', (_name, over) => {
    expect(installerClaim({ ...offerFor(BYTES), ...over })).toBeNull()
  })

  it('accepts the largest size allowed and refuses the next byte', () => {
    expect(installerClaim(offerFor(BYTES, { size: INSTALLER_MAX_BYTES }))?.size).toBe(INSTALLER_MAX_BYTES)
  })
})

describe('downloadVerifiedInstaller: a file that is the signed one', () => {
  it('keeps the bytes under Lucium’s own name in a folder of its own, with nothing else in it', async () => {
    const { fetch } = serving(BYTES)
    const done = await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))
    expect(done).toEqual({ ok: true, file: join(folder, INSTALLER_FILE_NAME), sha256: sha(BYTES) })
    expect(readFileSync(join(folder, INSTALLER_FILE_NAME))).toEqual(Buffer.from(BYTES))
    // No `.part` is left: a file that has its final name has been checked.
    expect(readdirSync(folder)).toEqual([INSTALLER_FILE_NAME])
    expect(folder).toBe(join(temp, INSTALLER_FOLDER))
  })

  it('asks the address of the signed feed, with no cookie, no cache and the headers it was given', async () => {
    const { fetch } = serving(BYTES)
    await downloadVerifiedInstaller({ fetch, folder, headers: { 'Sec-GPC': '1' } }, offerFor(BYTES))
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(URL_OF_FILE)
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', headers: { 'Sec-GPC': '1' } })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('names the file as Lucium does whatever the address says: the name comes from nowhere in the feed', async () => {
    for (const archive of ['https://lucium.app/updates/..%2F..%2Fevil.exe', 'https://lucium.app/a/b/..\\..\\evil.exe?x=1', 'https://lucium.app/updates/CON.exe']) {
      const { fetch } = serving(BYTES)
      const done = await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES, { archive }))
      expect(done).toMatchObject({ ok: true, file: join(folder, INSTALLER_FILE_NAME) })
      expect(readdirSync(folder)).toEqual([INSTALLER_FILE_NAME])
    }
  })

  it('takes away what an earlier download, or a program, left in the folder, and keeps nothing of it', async () => {
    mkdirSync(folder)
    writeFileSync(join(folder, INSTALLER_FILE_NAME), 'planted before the download')
    writeFileSync(join(folder, `${INSTALLER_FILE_NAME}.part`), 'a part left by a download cut short')
    writeFileSync(join(folder, 'other.dll'), 'a library')
    const { fetch } = serving(BYTES)
    const done = await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))
    expect(done.ok).toBe(true)
    expect(readdirSync(folder)).toEqual([INSTALLER_FILE_NAME])
    expect(readFileSync(join(folder, INSTALLER_FILE_NAME))).toEqual(Buffer.from(BYTES))
  })

  it('does not follow a link planted where the folder goes: the link is taken away, and what it pointed at is not touched', async (context) => {
    const elsewhere = join(temp, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'precious.txt'), 'not to be touched')
    // A junction: it needs no privilege on Windows, and is a plain link elsewhere.
    if (!link(elsewhere, folder, 'junction')) return context.skip()
    const { fetch } = serving(BYTES)
    const done = await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))
    expect(done.ok).toBe(true)
    expect(lstatSync(folder).isSymbolicLink()).toBe(false)
    expect(readdirSync(elsewhere)).toEqual(['precious.txt'])
    expect(readFileSync(join(elsewhere, 'precious.txt'), 'utf8')).toBe('not to be touched')
  })
})

describe('downloadVerifiedInstaller: refuses everything that is not the signed file, and leaves nothing that could be run', () => {
  const noTrace = (): void => expect(existsSync(folder)).toBe(false)

  it('refuses bytes of the signed size with another SHA-256, and removes them', async () => {
    const other = BYTES.slice()
    other[10] = other[10]! ^ 0xff
    const { fetch } = serving(other)
    const done = await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))
    expect(done).toMatchObject({ ok: false, kind: 'mismatch' })
    noTrace()
  })

  it('refuses bytes that are fewer than the signed size, even when they were all sent', async () => {
    const { fetch } = serving(BYTES.slice(0, BYTES.byteLength - 1))
    expect(await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))).toMatchObject({ ok: false, kind: 'mismatch' })
    noTrace()
  })

  it('refuses bytes fewer than the signed size even when their SHA-256 is the signed one: the size is checked on its own', async () => {
    const short = BYTES.slice(0, BYTES.byteLength - 1)
    const { fetch } = serving(short)
    expect(await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES, { sha256: sha(short) }))).toMatchObject({ ok: false, kind: 'mismatch' })
    noTrace()
  })

  it('stops at the first byte beyond the signed size: nothing more is read, and the file is removed', async () => {
    const more = new Uint8Array(BYTES.byteLength + 64 * 50)
    more.set(BYTES)
    const { fetch, state } = serving(more)
    const done = await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))
    expect(done).toMatchObject({ ok: false, kind: 'mismatch' })
    expect(state.cancelled).toBe(true)
    // The signed size is 1 280 bytes, read by pieces of 64: the 21st piece is the first beyond it, and the 50 more are never pulled (a few may be queued ahead).
    expect(state.pulled).toBeLessThan(30)
    noTrace()
  })

  it('refuses a server that declares more bytes than the feed signs, before reading any', async () => {
    const { fetch, state } = serving(BYTES, { headers: { get: (name) => (name === 'content-length' ? String(BYTES.byteLength + 1) : null) } })
    expect(await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))).toMatchObject({ ok: false, kind: 'mismatch' })
    // The body is cancelled, not read (a stream may have queued its first piece by itself).
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBeLessThanOrEqual(1)
    noTrace()
  })

  it('accepts a declared length that is the signed one, or none', async () => {
    const { fetch } = serving(BYTES, { headers: { get: (name) => (name === 'content-length' ? String(BYTES.byteLength) : null) } })
    expect((await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))).ok).toBe(true)
  })

  it('refuses a download redirected to plain http, an answer that is not ok, and an answer with no body: the network failed', async () => {
    const cases: Array<Partial<DownloadResponse>> = [{ url: 'http://lucium.app/Lucium-Setup.exe' }, { ok: false, status: 404 }, { body: null }]
    for (const over of cases) {
      const { body } = stream(BYTES)
      const fetch = vi.fn<InstallerFetch>(async () => answer(over.body === null ? null : body, over))
      expect(await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES)), JSON.stringify(over)).toMatchObject({ ok: false, kind: 'network' })
      noTrace()
    }
  })

  it('says a request that fails is the network, with the engine’s words', async () => {
    const fetch = vi.fn<InstallerFetch>(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    })
    expect(await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))).toEqual({ ok: false, kind: 'network', detail: 'net::ERR_INTERNET_DISCONNECTED' })
    noTrace()
  })

  it('says a body that breaks half-way is the network, and removes what was written', async () => {
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(BYTES.slice(0, 100))
          return
        }
        controller.error(new Error('connection reset'))
      }
    })
    const fetch = vi.fn<InstallerFetch>(async () => answer(body))
    expect(await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES))).toMatchObject({ ok: false, kind: 'network', detail: 'connection reset' })
    noTrace()
  })

  it('asks nothing of the network for an offer that is not an installer', async () => {
    const { fetch } = serving(BYTES)
    for (const over of [{ kind: 'zip' as const }, { sha256: undefined }, { archive: 'http://lucium.app/Lucium-Setup.exe' }]) {
      expect(await downloadVerifiedInstaller({ fetch, folder }, offerFor(BYTES, over))).toMatchObject({ ok: false, kind: 'offer' })
    }
    expect(fetch).not.toHaveBeenCalled()
    noTrace()
  })

  it('says a disk that cannot be written is the disk: the folder of the temporary files is not there', async () => {
    const { fetch } = serving(BYTES)
    const done = await downloadVerifiedInstaller({ fetch, folder: join(temp, 'missing', INSTALLER_FOLDER) }, offerFor(BYTES))
    expect(done).toMatchObject({ ok: false, kind: 'disk' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('verifyInstallerFile: the last check, on the file as it is on the disk', () => {
  const offer = offerFor(BYTES)
  const placed = async (): Promise<string> => {
    const { fetch } = serving(BYTES)
    const done = await downloadVerifiedInstaller({ fetch, folder }, offer)
    if (!done.ok) throw new Error('the download of the test failed')
    return done.file
  }

  it('says yes for the file that was downloaded', async () => {
    expect(await verifyInstallerFile(folder, await placed(), offer)).toBe(true)
  })

  it('says no when the bytes changed, even to the same size', async () => {
    const file = await placed()
    const changed = Buffer.from(BYTES)
    changed[0] = changed[0]! ^ 0xff
    writeFileSync(file, changed)
    expect(await verifyInstallerFile(folder, file, offer)).toBe(false)
  })

  it('says no when the size changed', async () => {
    const file = await placed()
    writeFileSync(file, Buffer.concat([Buffer.from(BYTES), Buffer.from('x')]))
    expect(await verifyInstallerFile(folder, file, offer)).toBe(false)
  })

  it('says no when the size is not the signed one even though the SHA-256 is: the size is checked on its own', async () => {
    const file = await placed()
    const longer = Buffer.concat([Buffer.from(BYTES), Buffer.from('x')])
    writeFileSync(file, longer)
    expect(await verifyInstallerFile(folder, file, { ...offer, sha256: sha(longer) })).toBe(false)
  })

  it('says no for another file than the one of the folder, with the same good bytes (a copy elsewhere, another name)', async () => {
    const file = await placed()
    const copy = join(temp, INSTALLER_FILE_NAME)
    writeFileSync(copy, BYTES)
    expect(await verifyInstallerFile(folder, copy, offer)).toBe(false)
    writeFileSync(join(folder, 'copy.exe'), BYTES)
    expect(await verifyInstallerFile(folder, join(folder, 'copy.exe'), offer)).toBe(false)
    expect(await verifyInstallerFile(folder, join(folder, '..', INSTALLER_FOLDER, INSTALLER_FILE_NAME), offer)).toBe(true)
    expect(file).toBe(join(folder, INSTALLER_FILE_NAME))
  })

  it('says no for a link that points at good bytes elsewhere', async (context) => {
    const file = await placed()
    const real = join(temp, 'real.exe')
    writeFileSync(real, BYTES)
    rmSync(file)
    if (!link(real, file, 'file')) return context.skip()
    expect(await verifyInstallerFile(folder, file, offer)).toBe(false)
  })

  it('says no for a file that is not there, and for an offer that is not an installer', async () => {
    const file = await placed()
    expect(await verifyInstallerFile(folder, join(folder, 'missing', INSTALLER_FILE_NAME), offer)).toBe(false)
    expect(await verifyInstallerFile(folder, file, { ...offer, kind: 'zip' })).toBe(false)
    expect(await verifyInstallerFile(folder, file, { ...offer, sha256: sha(new Uint8Array([1])) })).toBe(false)
    rmSync(file)
    expect(await verifyInstallerFile(folder, file, offer)).toBe(false)
  })
})

describe('discardInstallerFolder', () => {
  it('takes the folder and what it holds away, and is not a failure when it is not there', async () => {
    mkdirSync(folder)
    writeFileSync(join(folder, INSTALLER_FILE_NAME), BYTES)
    await discardInstallerFolder(folder)
    expect(existsSync(folder)).toBe(false)
    await expect(discardInstallerFolder(folder)).resolves.toBeUndefined()
  })

  it('takes it away at once for the quit, and does not fail when it is not there', () => {
    mkdirSync(folder)
    writeFileSync(join(folder, INSTALLER_FILE_NAME), BYTES)
    discardInstallerFolderNow(folder)
    expect(existsSync(folder)).toBe(false)
    expect(() => discardInstallerFolderNow(folder)).not.toThrow()
  })
})
