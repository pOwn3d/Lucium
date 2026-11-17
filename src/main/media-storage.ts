// Media storage for space backgrounds: upload, store, and serve media files (images, GIFs, videos)
// Media is stored in userData/media/ with generated filenames (timestamp-random.ext format)
// Supported formats: WebP, PNG, JPEG, GIF for images; MP4, WebM for videos
// Max sizes: 10MB for images, 50MB for videos. A video must start with the header of its format (ISO base media 'ftyp' or EBML), and a file is
// written under a temporary name, flushed, then renamed: a cut in the middle leaves no truncated file that would be served.

import { chmod, mkdir, readFile, rename, unlink } from 'fs/promises'
import { join } from 'path'
import crypto from 'crypto'
import { t } from '@shared/i18n'
import type { SpaceBackground } from '@shared/space-media'
import { isBuiltinBackgroundFile } from '@shared/builtin-backgrounds'
import { writeDurableFileAsync } from './durable-write'

/** The only names a media file has: the ones generateFilename makes (timestamp, 8 hex digits, a known extension). Anything else is refused. */
const MEDIA_NAME = /^\d{10,16}-[0-9a-f]{8}\.(webp|png|jpg|gif|mp4|webm)$/
/** The first bytes of a WebM file (the EBML header). */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

const MEDIA_MIME_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm'
}

/**
 * The path of a media file inside the media folder, or null when the name is not one a media file has. The pattern forbids any separator and
 * any `..`, so no name can reach a file outside the folder.
 */
export function resolveMediaPath(mediaDir: string, filename: string): string | null {
  return MEDIA_NAME.test(filename) ? join(mediaDir, filename) : null
}

/** The type a stored media file is served with, from its name. */
export function mimeTypeOfMedia(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream'
}

export class MediaStorage {
  private mediaDir: string

  /** `builtinDir`: the folder of the videos Lucium comes with (shared/builtin-backgrounds.ts); without it, none of them can be read. */
  constructor(
    userDataPath: string,
    private readonly builtinDir: string | null = null
  ) {
    this.mediaDir = join(userDataPath, 'media')
  }

  /** Generate a unique filename with timestamp and random bytes */
  private generateFilename(extension: string): string {
    const timestamp = Date.now()
    const random = crypto.randomBytes(4).toString('hex')
    return `${timestamp}-${random}.${extension}`
  }

  /** Extract file extension from MIME type or data URL */
  private getExtension(mimeType: string): string | null {
    const mimeMap: Record<string, string> = {
      'image/webp': 'webp',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm'
    }
    return mimeMap[mimeType] || null
  }

  /** Validate media file: check MIME type, size limits, and format support */
  private validateMedia(data: Buffer, mimeType: string, isVideo: boolean): { ok: boolean; error?: string } {
    const maxSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024 // 50MB for a video, 10MB for an image
    
    if (data.length > maxSize) {
      return { ok: false, error: t('space-media.trop-volumineux', { size: String(Math.round(maxSize / 1024 / 1024)) }) }
    }

    const ext = this.getExtension(mimeType)
    if (!ext) {
      return { ok: false, error: t('space-media.format-inconnu') }
    }

    // The header of a video must be the one of its format: an MP4 starts with 'ftyp' at byte 4, a WebM with the EBML magic.
    if (isVideo) {
      const isMp4 = data.length >= 8 && data.subarray(4, 8).toString('latin1') === 'ftyp'
      const isWebm = data.length >= 4 && data.subarray(0, 4).equals(EBML_MAGIC)
      if (ext === 'mp4' ? !isMp4 : !isWebm) return { ok: false, error: t('space-media.en-tete-video-invalide') }
    }

    // Basic magic number validation for images
    if (!isVideo) {
      const magic = data.slice(0, 8)
      const validMagics = [
        Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF (WebP, WAV, AVI)
        Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
        Buffer.from([0xff, 0xd8, 0xff]),       // JPEG
        Buffer.from([0x47, 0x49, 0x46])        // GIF
      ]
      
      const isValidImage = validMagics.some(m => magic.slice(0, m.length).equals(m))
      if (!isValidImage) {
        return { ok: false, error: t('space-media.en-tete-invalide') }
      }
    }

    return { ok: true }
  }

  /** Upload and store a media file, returning the filename on success */
  async uploadMedia(buffer: Buffer, mimeType: string): Promise<string> {
    // The folder is its owner's only, like the other folders of the data (session-backups, space images): made so, and set so when an earlier version made it with the umask.
    await mkdir(this.mediaDir, { recursive: true, mode: 0o700 })
    await chmod(this.mediaDir, 0o700).catch((error: unknown) => console.warn('[media] the media folder could not be made private:', error))
    
    // Validate media
    const isVideo = mimeType.startsWith('video/')
    const validation = this.validateMedia(buffer, mimeType, isVideo)
    if (!validation.ok) {
      throw new Error(validation.error)
    }

    // Generate filename and save
    const ext = this.getExtension(mimeType)
    if (!ext) {
      throw new Error(t('media-storage.extension-introuvable'))
    }

    const filename = this.generateFilename(ext)
    const filepath = join(this.mediaDir, filename)

    // Owner only, flushed to the disk, then renamed into place: a cut in the middle leaves no truncated file under the name the storage serves.
    // The background of a space is the user's own picture, not something the other accounts of the Mac should read.
    const temporary = `${filepath}.part`
    try {
      await writeDurableFileAsync(temporary, buffer)
      await rename(temporary, filepath)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    return filename
  }

  /** Read media file contents (for serving to renderer) */
  async readMedia(filename: string): Promise<Buffer> {
    // A video Lucium comes with, or its picture: read from the resources, by its exact name only.
    if (isBuiltinBackgroundFile(filename)) {
      if (!this.builtinDir) throw new Error(t('space-media.nom-invalide'))
      return await readFile(join(this.builtinDir, filename))
    }
    // Security: prevent directory traversal
    const filepath = resolveMediaPath(this.mediaDir, filename)
    if (!filepath) {
      throw new Error(t('space-media.nom-invalide'))
    }

    return await readFile(filepath)
  }

  /** Delete media file */
  async deleteMedia(filename: string): Promise<void> {
    // A video Lucium comes with stays: the space only stops naming it.
    if (isBuiltinBackgroundFile(filename)) return
    // Security: prevent directory traversal
    const filepath = resolveMediaPath(this.mediaDir, filename)
    if (!filepath) {
      throw new Error(t('space-media.nom-invalide'))
    }

    await unlink(filepath)
  }

  /** Get media URL for rendering (data: or file: protocol) */
  getMediaUrl(background: SpaceBackground): string | null {
    if (background.type === 'color') {
      return null // Colors are handled by CSS
    }

    if (!background.value) {
      return null
    }

    // Return a data URL path that the renderer can load via IPC
    // The renderer will request the media via IPC and convert to data URL
    return `media://${background.value}`
  }
}
