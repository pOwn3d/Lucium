// Reading a file a person chose, when what it holds is not to be trusted: a Tweak or a theme sent by someone. The size is checked before
// the file is read and again while it is, so that a file that grows, a device that never ends or a pipe that never answers cannot make the
// application read without limit or wait for ever. Nothing here knows what the text means.

import { open, stat } from 'node:fs/promises'
import { t } from '@shared/i18n'

export type FileFailure = 'not-found' | 'not-a-file' | 'too-large' | 'not-text' | 'unreadable'

export type BoundedRead = { ok: true; text: string } | { ok: false; reason: FileFailure; detail?: string }

/** The sentence for a file that could not be read. */
export function fileFailureMessage(failure: Exclude<BoundedRead, { ok: true }>, maxBytes: number): string {
  switch (failure.reason) {
    case 'not-found':
      return t('bounded-file.ce-fichier-n-existe-plus')
    case 'not-a-file':
      return t('bounded-file.ce-n-est-pas-un-fichier-ordinaire-un-dossier-un')
    case 'too-large':
      return t('bounded-file.ce-fichier-est-trop-volumineux-la-limite-est-de', { size: Math.round(maxBytes / 1024) })
    case 'not-text':
      return t('bounded-file.ce-fichier-n-est-pas-un-texte-en-utf-8')
    case 'unreadable':
      return failure.detail ? t('bounded-file.ce-fichier-ne-peut-pas-etre-lu-detail', { detail: failure.detail }) : t('bounded-file.ce-fichier-ne-peut-pas-etre-lu')
  }
}

/**
 * The text of a regular file of at most `maxBytes` bytes, in UTF-8 (or as `decode` reads the bytes, when the caller accepts other
 * encodings: it then never refuses a file as "not text"). Never reads more than `maxBytes + 1` bytes.
 */
export async function readBoundedText(path: string, maxBytes: number, decode?: (bytes: Uint8Array) => string): Promise<BoundedRead> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { ok: false, reason: 'not-a-file' }
    if (info.size > maxBytes) return { ok: false, reason: 'too-large' }
    const handle = await open(path, 'r')
    try {
      // One byte more than allowed: a file that grew since `stat` is told apart from one that is exactly at the limit.
      const buffer = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > maxBytes) return { ok: false, reason: 'too-large' }
      try {
        return { ok: true, text: decode ? decode(buffer.subarray(0, length)) : new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) }
      } catch {
        return { ok: false, reason: 'not-text' }
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'not-found' }
    console.error(`[share] cannot read ${path}:`, error)
    return { ok: false, reason: 'unreadable', detail: code ?? String((error as Error).message ?? error).slice(0, 80) }
  }
}
