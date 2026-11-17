// Space background media: images, GIFs, and videos for space sidebar backgrounds
// Separate from space-image.ts (which handles space icon pictures)

/** The bytes of a media file as the IPC carries them (a copy, never shared memory). */
export type MediaBytes = Uint8Array<ArrayBuffer>

export type SpaceBackgroundMediaRequest =
  /** Upload a new background media file: its bytes, not a base64 text (the IPC carries them as they are) */
  | { op: 'upload'; spaceId: string; data: MediaBytes; mimeType: string }
  /** Delete background media for a space */
  | { op: 'delete'; spaceId: string }
  /** Read background media: its bytes and type; the renderer makes a blob URL of them */
  | { op: 'read'; filename: string }

/** The largest file accepted (a video, 50 MiB, main/media-storage.ts). Larger data is refused before it is stored. */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024

export function parseSpaceBackgroundMediaRequest(raw: unknown): SpaceBackgroundMediaRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  const spaceId = r['spaceId']
  if (r['op'] === 'upload' && typeof spaceId === 'string' && r['data'] instanceof Uint8Array && typeof r['mimeType'] === 'string') {
    if (r['data'].byteLength > MAX_MEDIA_BYTES) return null
    return { op: 'upload', spaceId, data: r['data'] as MediaBytes, mimeType: r['mimeType'] }
  }

  if (r['op'] === 'delete' && typeof spaceId === 'string') {
    return { op: 'delete', spaceId }
  }

  if (r['op'] === 'read' && typeof r['filename'] === 'string') {
    return { op: 'read', filename: r['filename'] }
  }

  return null
}

/** Response from background media request: `data` and `mimeType` are set by `read` only */
export type SpaceBackgroundMediaReply = { ok: true; data?: MediaBytes; mimeType?: string; filename?: string } | { ok: false; message: string }
