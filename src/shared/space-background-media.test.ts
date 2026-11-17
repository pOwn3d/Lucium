import { describe, expect, it } from 'vitest'
import { MAX_MEDIA_BYTES, parseSpaceBackgroundMediaRequest } from './space-background-media'

describe('parseSpaceBackgroundMediaRequest', () => {
  it('accepts an upload whose bytes are a Uint8Array, up to the largest file', () => {
    const data = new Uint8Array(16)
    expect(parseSpaceBackgroundMediaRequest({ op: 'upload', spaceId: 's1', data, mimeType: 'image/png' })).toEqual({ op: 'upload', spaceId: 's1', data, mimeType: 'image/png' })
    // The largest file itself is taken. A boolean, for the same reason as below.
    expect(parseSpaceBackgroundMediaRequest({ op: 'upload', spaceId: 's1', data: new Uint8Array(MAX_MEDIA_BYTES), mimeType: 'video/mp4' }) !== null).toBe(true)
  })

  // A boolean, not toBeNull(): a refused 50 MiB request must not be printed in full by a failing assertion.
  it('refuses an upload above the largest file, before anything is stored', () => {
    const data = new Uint8Array(MAX_MEDIA_BYTES + 1)
    expect(parseSpaceBackgroundMediaRequest({ op: 'upload', spaceId: 's1', data, mimeType: 'video/mp4' }) === null).toBe(true)
  })

  it('refuses an upload whose bytes are text, not bytes', () => {
    expect(parseSpaceBackgroundMediaRequest({ op: 'upload', spaceId: 's1', data: 'AAAA', mimeType: 'image/png' })).toBeNull()
  })
})
