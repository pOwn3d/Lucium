// The media files of the space backgrounds: only the names the storage makes are read or deleted, and a written file is
// readable by its owner only.
import { chmodSync, mkdirSync, statSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The durable write, watched: what it is asked to write and what the folder held at that moment. `cut` makes it stop halfway, as a full disk or a
// crash would, after half the bytes reached the file.
const durable = vi.hoisted(() => ({ cut: false, writes: [] as { path: string; before: string[] }[] }))
vi.mock('./durable-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./durable-write')>()
  const { readdirSync: list, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  return {
    ...actual,
    writeDurableFileAsync: async (path: string, data: string | Uint8Array) => {
      durable.writes.push({ path, before: list(dirname(path)) })
      if (!durable.cut) return actual.writeDurableFileAsync(path, data)
      writeFileSync(path, data.slice(0, Math.floor(data.length / 2)))
      throw new Error('ENOSPC: no space left on device')
    }
  }
})
afterEach(() => {
  durable.cut = false
  durable.writes.length = 0
})

import { MediaStorage } from './media-storage'
import { tempDir } from './temp-dir'
import { frenchSpaces } from '@shared/french-typography'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)])
/** An MP4 starts with its box size, then 'ftyp' at byte 4. */
const mp4 = (size: number) => Buffer.concat([Buffer.from('0000001866747970', 'hex'), Buffer.alloc(size - 8)])
/** A WebM starts with the EBML magic. */
const webm = (size: number) => Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(size - 4)])

describe('the media files', () => {
  it('refuses any name the storage did not make, in reading and in deleting', async () => {
    const storage = new MediaStorage(tempDir('media-'))
    await expect(storage.readMedia('secret.txt')).rejects.toThrow('Nom de fichier non valide')
    await expect(storage.deleteMedia('../../etc/passwd')).rejects.toThrow('Nom de fichier non valide')
  })

  it('writes a file readable by its owner only, under the name it made', async () => {
    const storage = new MediaStorage(tempDir('media-'))
    const name = await storage.uploadMedia(PNG, 'image/png')
    expect(name).toMatch(/^\d+-[0-9a-f]{8}\.png$/)
    expect(statSync(join(storage['mediaDir'], name)).mode & 0o777).toBe(0o600)
    expect((await storage.readMedia(name)).length).toBe(PNG.length)
    await storage.deleteMedia(name)
    expect(existsSync(join(storage['mediaDir'], name))).toBe(false)
  })

  it('keeps the media folder its owner’s only (0700), also when an earlier version made it with the umask', async () => {
    const fresh = new MediaStorage(tempDir('media-'))
    await fresh.uploadMedia(PNG, 'image/png')
    expect(statSync(fresh['mediaDir']).mode & 0o777).toBe(0o700)
    const older = new MediaStorage(tempDir('media-'))
    mkdirSync(older['mediaDir'], { mode: 0o755 })
    chmodSync(older['mediaDir'], 0o755)
    await older.uploadMedia(PNG, 'image/png')
    expect(statSync(older['mediaDir']).mode & 0o777).toBe(0o700)
  })

  it('accepts a video of 50 MB and refuses one byte more', () => {
    const storage = new MediaStorage(tempDir('media-'))
    const limit = 50 * 1024 * 1024
    expect(storage['validateMedia'](mp4(limit), 'video/mp4', true).ok).toBe(true)
    expect(storage['validateMedia'](mp4(limit + 1), 'video/mp4', true).ok).toBe(false)
  })

  it('refuses a video whose header is not the one of its format (a file of 50 MB named .mp4)', () => {
    const storage = new MediaStorage(tempDir('media-'))
    expect(storage['validateMedia'](Buffer.alloc(1024), 'video/mp4', true).ok).toBe(false)
    expect(storage['validateMedia'](PNG, 'video/mp4', true).ok).toBe(false)
    expect(storage['validateMedia'](webm(1024), 'video/mp4', true).ok).toBe(false)
    expect(storage['validateMedia'](mp4(1024), 'video/webm', true).ok).toBe(false)
    expect(storage['validateMedia'](Buffer.from('1a45', 'hex'), 'video/webm', true).ok).toBe(false)
  })

  it('says a video with a wrong header is not a valid video, and an image with one is not a valid image', () => {
    const storage = new MediaStorage(tempDir('media-'))
    expect(storage['validateMedia'](PNG, 'video/mp4', true).error).toBe('Le fichier n’est pas une vidéo valide.')
    expect(storage['validateMedia'](Buffer.alloc(64), 'image/png', false).error).toBe('Le fichier n’est pas une image valide.')
  })

  it('accepts a video that has the header of its format', () => {
    const storage = new MediaStorage(tempDir('media-'))
    expect(storage['validateMedia'](webm(1024), 'video/webm', true).ok).toBe(true)
    expect(storage['validateMedia'](mp4(1024), 'video/mp4', true).ok).toBe(true)
  })

  it('stores a video under its name only once it is whole, and leaves no temporary file behind', async () => {
    const storage = new MediaStorage(tempDir('media-'))
    const video = mp4(4096)
    const name = await storage.uploadMedia(video, 'video/mp4')
    const dir = storage['mediaDir']
    expect(readdirSync(dir)).toEqual([name])
    expect((await storage.readMedia(name)).equals(video)).toBe(true)
  })

  it('writes the video whole under a temporary name, then renames it (no truncated file under the served name)', async () => {
    const storage = new MediaStorage(tempDir('media-'))
    const name = await storage.uploadMedia(mp4(4096), 'video/mp4')
    const dir = storage['mediaDir']
    // One durable write, of a name that is not the served one, while the served one did not exist yet.
    expect(durable.writes).toHaveLength(1)
    expect(durable.writes[0]!.path).not.toBe(join(dir, name))
    expect(durable.writes[0]!.before).not.toContain(name)
    expect(readdirSync(dir)).toEqual([name])
  })

  it('leaves nothing, neither under the served name nor beside it, when the write stops halfway', async () => {
    const storage = new MediaStorage(tempDir('media-'))
    durable.cut = true
    await expect(storage.uploadMedia(mp4(4096), 'video/mp4')).rejects.toThrow('ENOSPC')
    expect(durable.writes).toHaveLength(1)
    expect(readdirSync(storage['mediaDir'])).toEqual([])
  })

  it('refuses a video without the right header before writing anything', async () => {
    const storage = new MediaStorage(tempDir('media-'))
    await expect(storage.uploadMedia(Buffer.alloc(1024), 'video/mp4')).rejects.toThrow()
    expect(readdirSync(storage['mediaDir'])).toEqual([])
  })

  it('refuses an image above 10 MB', () => {
    const storage = new MediaStorage(tempDir('media-'))
    const limit = 10 * 1024 * 1024
    expect(storage['validateMedia'](Buffer.concat([PNG, Buffer.alloc(limit - PNG.length)]), 'image/png', false).ok).toBe(true)
    expect(storage['validateMedia'](Buffer.concat([PNG, Buffer.alloc(limit + 1 - PNG.length)]), 'image/png', false).ok).toBe(false)
  })

  it('names the largest size in the error of an oversized video', async () => {
    const storage = new MediaStorage(tempDir('media-'))
    await expect(storage.uploadMedia(Buffer.alloc(50 * 1024 * 1024 + 1), 'video/webm')).rejects.toThrow(frenchSpaces('50 Mo au plus'))
  })
})

describe('the videos Lucium comes with', () => {
  const builtin = () => {
    const dir = tempDir('builtin-')
    writeFileSync(join(dir, 'lucium-village.mp4'), mp4(64))
    writeFileSync(join(dir, 'lucium-village.jpg'), PNG)
    return dir
  }

  it('are read from the folder of the resources, a video and its picture, by their exact name', async () => {
    const storage = new MediaStorage(tempDir('media-'), builtin())
    expect((await storage.readMedia('lucium-village.mp4')).length).toBe(64)
    expect((await storage.readMedia('lucium-village.jpg')).length).toBe(PNG.length)
    // A name of the same form that is not one of them reaches nothing.
    await expect(storage.readMedia('lucium-ailleurs.mp4')).rejects.toThrow('Nom de fichier non valide')
  })

  it('cannot be read without the folder of the resources', async () => {
    await expect(new MediaStorage(tempDir('media-')).readMedia('lucium-village.mp4')).rejects.toThrow('Nom de fichier non valide')
  })

  it('are never deleted: a space that leaves one only stops naming it', async () => {
    const dir = builtin()
    await new MediaStorage(tempDir('media-'), dir).deleteMedia('lucium-village.mp4')
    expect(readdirSync(dir).sort()).toEqual(['lucium-village.jpg', 'lucium-village.mp4'])
  })
})
