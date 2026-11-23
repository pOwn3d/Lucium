// The files of an AppImage update (update-appimage-file.ts), on real files in a throw-away folder and a stand-in for the network: the download is written beside the
// running AppImage, kept only when it is the signed one, swapped in only on demand, and the copy it replaced is kept until the new one has run. Nothing reaches the
// network, and no AppImage is started.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appImageFiles } from '@shared/linux-install'
import type { UpdateOffer } from '@shared/update-check'
import {
  canReplaceAppImage,
  discardAppImageUpdate,
  discardAppImageUpdateNow,
  downloadAppImage,
  removePreviousAppImage,
  swapAppImage,
  undoSwapAppImage,
  verifyStagedAppImage
} from './update-appimage-file'
import type { DownloadResponse, InstallerFetch } from './update-installer-file'

const NEW_BYTES = new TextEncoder().encode('\x7fELF-the-new-appimage-'.repeat(50))
const OLD_BYTES = 'the appimage that runs'
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const URL_OF_FILE = 'https://lucium.app/updates/linux-x64/appimage/Lucium-1.2.0-linux-x64.AppImage'

const offerFor = (bytes: Uint8Array, over: Partial<UpdateOffer> = {}): UpdateOffer => ({
  version: '1.2.0',
  url: 'https://lucium.app/telecharger/',
  notes: '',
  archive: URL_OF_FILE,
  size: bytes.byteLength,
  sha256: sha(bytes),
  kind: 'appimage',
  ...over
})

const answer = (bytes: Uint8Array, over: Partial<DownloadResponse> = {}): DownloadResponse => {
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
    }),
    ...over
  }
}
const serving = (bytes: Uint8Array) => vi.fn<InstallerFetch>(async () => answer(bytes))

/** A link, or false when the system does not let this account make one (Windows without the privilege): the test that needs it is then skipped, not failed. */
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

let folder: string
let appImage: string
let files: ReturnType<typeof appImageFiles>
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lucium-appimage-'))
  appImage = join(folder, 'Lucium.AppImage')
  files = appImageFiles(appImage)
  writeFileSync(appImage, OLD_BYTES)
})
afterEach(() => {
  chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('canReplaceAppImage: only a plain file in a folder the person can write', () => {
  it('is true for a regular file in a writable folder', () => {
    expect(canReplaceAppImage(appImage)).toBe(true)
  })

  it('is false for a file that is not there, and for a folder', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(canReplaceAppImage(join(folder, 'missing.AppImage'))).toBe(false)
    mkdirSync(join(folder, 'a-folder'))
    expect(canReplaceAppImage(join(folder, 'a-folder'))).toBe(false)
  })

  it('is false for a link: a file elsewhere that a link points to is not the person’s to swap, and the refusal is logged', (context) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const linked = join(folder, 'Linked.AppImage')
    if (!link(appImage, linked)) return context.skip()
    expect(canReplaceAppImage(linked)).toBe(false)
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    // The refusal that is not an error (a link) is still answered « no »; an error (no such file) says why.
    expect(warn).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('is false for a folder the person cannot write, and says why in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    chmodSync(folder, 0o555)
    expect(canReplaceAppImage(appImage)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain(appImage)
  })
})

describe('downloadAppImage: the signed AppImage, beside the one that runs', () => {
  it('keeps the bytes next to the AppImage as `.update`, executable, with nothing else beside it and the running file untouched', async () => {
    const fetch = serving(NEW_BYTES)
    const done = await downloadAppImage({ fetch }, offerFor(NEW_BYTES), appImage)
    expect(done).toEqual({ ok: true, file: files.staged, sha256: sha(NEW_BYTES) })
    expect(readFileSync(files.staged)).toEqual(Buffer.from(NEW_BYTES))
    expect(readdirSync(folder).sort()).toEqual(['Lucium.AppImage', 'Lucium.AppImage.update'])
    expect(readFileSync(appImage, 'utf8')).toBe(OLD_BYTES)
    if (process.platform !== 'win32') expect(statSync(files.staged).mode & 0o777).toBe(0o755)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe(URL_OF_FILE)
    expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: 'no-store', credentials: 'omit' })
  })

  it('takes away what an earlier download left (a download that waits, an unfinished one), and keeps nothing of it', async () => {
    writeFileSync(files.staged, 'a download that waited, and was never run')
    writeFileSync(files.part, 'a download cut short')
    const done = await downloadAppImage({ fetch: serving(NEW_BYTES) }, offerFor(NEW_BYTES), appImage)
    expect(done.ok).toBe(true)
    expect(readdirSync(folder).sort()).toEqual(['Lucium.AppImage', 'Lucium.AppImage.update'])
    expect(readFileSync(files.staged)).toEqual(Buffer.from(NEW_BYTES))
  })

  it('does not follow a link planted where the download goes: the link is taken away and what it pointed at is not touched', async (context) => {
    const precious = join(folder, 'precious.txt')
    writeFileSync(precious, 'not to be touched')
    if (!link(precious, files.part)) return context.skip()
    const done = await downloadAppImage({ fetch: serving(NEW_BYTES) }, offerFor(NEW_BYTES), appImage)
    expect(done.ok).toBe(true)
    expect(readFileSync(precious, 'utf8')).toBe('not to be touched')
    expect(lstatSync(files.staged).isSymbolicLink()).toBe(false)
  })

  it('refuses bytes that are not the signed ones (same size, another SHA-256), and leaves nothing that could be taken for a checked download', async () => {
    const other = NEW_BYTES.slice()
    other[5] = other[5]! ^ 0xff
    const done = await downloadAppImage({ fetch: serving(other) }, offerFor(NEW_BYTES), appImage)
    expect(done).toMatchObject({ ok: false, kind: 'mismatch' })
    expect(readdirSync(folder)).toEqual(['Lucium.AppImage'])
    expect(readFileSync(appImage, 'utf8')).toBe(OLD_BYTES)
  })

  it('refuses a file that is not the signed size, and a network that fails, and removes what it wrote', async () => {
    const short = await downloadAppImage({ fetch: serving(NEW_BYTES.slice(0, 100)) }, offerFor(NEW_BYTES), appImage)
    expect(short).toMatchObject({ ok: false, kind: 'mismatch' })
    const down = await downloadAppImage({ fetch: vi.fn<InstallerFetch>(async () => Promise.reject(new Error('offline'))) }, offerFor(NEW_BYTES), appImage)
    expect(down).toMatchObject({ ok: false, kind: 'network' })
    expect(readdirSync(folder)).toEqual(['Lucium.AppImage'])
  })

  it('asks nothing of the network for an offer that is not an AppImage with an https address, a sum and a size', async () => {
    for (const over of [{ kind: 'deb' }, { kind: 'nsis' }, { kind: undefined }, { archive: 'http://lucium.app/a.AppImage' }, { sha256: undefined }, { size: undefined }, { sha256: 'ABC' }] as Partial<UpdateOffer>[]) {
      const fetch = serving(NEW_BYTES)
      const done = await downloadAppImage({ fetch }, offerFor(NEW_BYTES, over), appImage)
      expect(done, JSON.stringify(over)).toMatchObject({ ok: false, kind: 'offer' })
      expect(fetch).not.toHaveBeenCalled()
    }
    expect(readdirSync(folder)).toEqual(['Lucium.AppImage'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says the disk failed when the folder cannot be written, and removes nothing it did not make', async () => {
    chmodSync(folder, 0o555)
    const done = await downloadAppImage({ fetch: serving(NEW_BYTES) }, offerFor(NEW_BYTES), appImage)
    expect(done).toMatchObject({ ok: false, kind: 'disk' })
    expect(readFileSync(appImage, 'utf8')).toBe(OLD_BYTES)
  })
})

describe('verifyStagedAppImage: the last check, on the disk, just before the swap', () => {
  const staged = async (): Promise<void> => {
    await downloadAppImage({ fetch: serving(NEW_BYTES) }, offerFor(NEW_BYTES), appImage)
  }

  it('accepts the file the download made', async () => {
    await staged()
    expect(await verifyStagedAppImage(appImage, files.staged, offerFor(NEW_BYTES))).toBe(true)
  })

  it('refuses a file that changed since (same size, other bytes; another size), and a file that is gone', async () => {
    await staged()
    const changed = NEW_BYTES.slice()
    changed[0] = changed[0]! ^ 1
    writeFileSync(files.staged, changed)
    expect(await verifyStagedAppImage(appImage, files.staged, offerFor(NEW_BYTES))).toBe(false)
    writeFileSync(files.staged, 'short')
    expect(await verifyStagedAppImage(appImage, files.staged, offerFor(NEW_BYTES))).toBe(false)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rmSync(files.staged)
    expect(await verifyStagedAppImage(appImage, files.staged, offerFor(NEW_BYTES))).toBe(false)
  })

  it('refuses a path that is not the `.update` beside this AppImage, even for the right bytes', async () => {
    await staged()
    const elsewhere = join(folder, 'elsewhere.AppImage')
    writeFileSync(elsewhere, NEW_BYTES)
    expect(await verifyStagedAppImage(appImage, elsewhere, offerFor(NEW_BYTES))).toBe(false)
    expect(await verifyStagedAppImage(join(folder, 'Another.AppImage'), files.staged, offerFor(NEW_BYTES))).toBe(false)
  })

  it('refuses a link put in the place of the file, and an offer that is not an AppImage', async (context) => {
    await staged()
    const real = join(folder, 'real.bin')
    writeFileSync(real, NEW_BYTES)
    rmSync(files.staged)
    if (!link(real, files.staged)) return context.skip()
    expect(await verifyStagedAppImage(appImage, files.staged, offerFor(NEW_BYTES))).toBe(false)
    rmSync(files.staged)
    writeFileSync(files.staged, NEW_BYTES)
    expect(await verifyStagedAppImage(appImage, files.staged, offerFor(NEW_BYTES, { kind: 'nsis' }))).toBe(false)
    expect(await verifyStagedAppImage(appImage, files.staged, offerFor(NEW_BYTES))).toBe(true)
  })
})

describe('swapAppImage: the download takes the place of the running file, which is kept', () => {
  const staged = async (): Promise<void> => {
    await downloadAppImage({ fetch: serving(NEW_BYTES) }, offerFor(NEW_BYTES), appImage)
  }

  it('renames the running file to `.previous` and the download to the running file’s name, in one folder', async () => {
    await staged()
    await swapAppImage(appImage)
    expect(readFileSync(appImage)).toEqual(Buffer.from(NEW_BYTES))
    expect(readFileSync(files.previous, 'utf8')).toBe(OLD_BYTES)
    expect(existsSync(files.staged)).toBe(false)
    expect(readdirSync(folder).sort()).toEqual(['Lucium.AppImage', 'Lucium.AppImage.previous'])
  })

  it('replaces a `.previous` an earlier swap left', async () => {
    await staged()
    writeFileSync(files.previous, 'an older copy')
    await swapAppImage(appImage)
    expect(readFileSync(files.previous, 'utf8')).toBe(OLD_BYTES)
  })

  it('puts the running file back when the download cannot be put in place, and says why', async () => {
    // No download was made: the second rename fails, so the first must be undone.
    await expect(swapAppImage(appImage)).rejects.toThrow()
    expect(readFileSync(appImage, 'utf8')).toBe(OLD_BYTES)
    expect(existsSync(files.previous)).toBe(false)
  })

  it('can be undone: the kept copy comes back in the running file’s place', async () => {
    await staged()
    await swapAppImage(appImage)
    await undoSwapAppImage(appImage)
    expect(readFileSync(appImage, 'utf8')).toBe(OLD_BYTES)
    expect(existsSync(files.previous)).toBe(false)
  })
})

describe('what is left on the disk when no swap is made', () => {
  it('takes the download that waits and its unfinished form away, asynchronously and at once (the quit does not wait)', async () => {
    for (const away of [() => discardAppImageUpdate(appImage), async () => discardAppImageUpdateNow(appImage)]) {
      writeFileSync(files.staged, 'waits')
      writeFileSync(files.part, 'part')
      await away()
      expect(readdirSync(folder)).toEqual(['Lucium.AppImage'])
    }
    // Nothing there is not a failure; the running file is never touched.
    await discardAppImageUpdate(appImage)
    discardAppImageUpdateNow(appImage)
    expect(readFileSync(appImage, 'utf8')).toBe(OLD_BYTES)
  })

  it('removes the copy a swap kept once the new one runs, and only when it is a plain file', async () => {
    const log = vi.fn()
    writeFileSync(files.previous, 'kept')
    await removePreviousAppImage(appImage, log)
    expect(existsSync(files.previous)).toBe(false)
    expect(log).not.toHaveBeenCalled()
    // Nothing kept is nothing to do.
    await removePreviousAppImage(appImage, log)
    expect(log).not.toHaveBeenCalled()
  })

  it('leaves a folder someone put where the kept copy goes, and says so', async () => {
    const log = vi.fn()
    mkdirSync(files.previous)
    writeFileSync(join(files.previous, 'theirs.txt'), 'not Lucium’s')
    await removePreviousAppImage(appImage, log)
    expect(existsSync(join(files.previous, 'theirs.txt'))).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('is not a file Lucium made'))
  })

  it('leaves a link, and what it points to, alone', async (context) => {
    const log = vi.fn()
    const target = join(folder, 'target.bin')
    writeFileSync(target, 'precious')
    if (!link(target, files.previous)) return context.skip()
    await removePreviousAppImage(appImage, log)
    expect(readFileSync(target, 'utf8')).toBe('precious')
    expect(lstatSync(files.previous).isSymbolicLink()).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('is not a file Lucium made'))
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says in the log when the kept copy cannot be removed, and leaves it for the next start', async () => {
    const log = vi.fn()
    writeFileSync(files.previous, 'kept')
    chmodSync(folder, 0o555)
    await removePreviousAppImage(appImage, log)
    expect(existsSync(files.previous)).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be removed'))
  })
})
