import { describe, expect, it } from 'vitest'
import { defaultSettings, type SidebarState, type Space } from './model'
import { createInitialState } from './sidebar'
import {
  SPACE_IMAGE_FILE_MAX,
  SPACE_IMAGE_SIDE_MAX,
  imageHeader,
  imageRefusal,
  isSpaceImageName,
  orphanImages,
  parseSpaceImageRequest,
  referencedImages,
  squareCrop
} from './space-image'
import { defaultTheme } from './theme'

// ---------- headers, written byte by byte: what a file claims is all the code reads before deciding ----------

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

/** A JPEG whose first segment is a JFIF block of `skip` bytes, then a start of frame `marker` with the size. */
function jpeg(width: number, height: number, marker = 0xc0, skip = 16): Uint8Array {
  const b = new Uint8Array(2 + 2 + skip + 2 + 17)
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, skip])
  const at = 4 + skip
  b.set([0xff, marker, 0, 17, 8], at)
  new DataView(b.buffer).setUint16(at + 5, height)
  new DataView(b.buffer).setUint16(at + 7, width)
  return b
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

function webpLossy(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a])
  new DataView(b.buffer).setUint16(26, width, true)
  new DataView(b.buffer).setUint16(28, height, true)
  return b
}

function webpLossless(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8L'), 0, 0, 0, 0, 0x2f])
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  new DataView(b.buffer).setUint32(21, bits >>> 0, true)
  return b
}

function webpExtended(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 0, 0, 0, 0, 0, 0, 0, 0])
  for (const [at, value] of [[24, width - 1], [27, height - 1]] as const) b.set([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff], at)
  return b
}

describe('imageHeader', () => {
  it('reads the size a PNG announces', () => {
    expect(imageHeader(png(640, 480))).toEqual({ format: 'png', width: 640, height: 480 })
  })

  it('reads the size a JPEG announces, past the segments in front of its frame, for every kind of frame', () => {
    expect(imageHeader(jpeg(800, 600))).toEqual({ format: 'jpeg', width: 800, height: 600 })
    expect(imageHeader(jpeg(800, 600, 0xc2, 40))).toEqual({ format: 'jpeg', width: 800, height: 600 })
    expect(imageHeader(jpeg(32, 16, 0xcf))).toEqual({ format: 'jpeg', width: 32, height: 16 })
  })

  it('reads the size of the three kinds of WebP', () => {
    expect(imageHeader(webpLossy(300, 200))).toEqual({ format: 'webp', width: 300, height: 200 })
    expect(imageHeader(webpLossless(300, 200))).toEqual({ format: 'webp', width: 300, height: 200 })
    expect(imageHeader(webpExtended(1000, 2000))).toEqual({ format: 'webp', width: 1000, height: 2000 })
  })

  it('knows nothing of a file that is none of them, whatever its name would say', () => {
    expect(imageHeader(new Uint8Array(0))).toBeNull()
    expect(imageHeader(new Uint8Array(64))).toBeNull()
    expect(imageHeader(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'))).toBeNull()
    expect(imageHeader(new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000'))).toBeNull()
    expect(imageHeader(new TextEncoder().encode('#!/bin/sh\nrm -rf ~\n'))).toBeNull()
  })

  it('does not run past the end of a truncated header', () => {
    expect(imageHeader(png(10, 10).slice(0, 20))).toBeNull()
    expect(imageHeader(jpeg(10, 10).slice(0, 12))).toBeNull()
    expect(imageHeader(jpeg(10, 10).slice(0, 4 + 16 + 6))).toBeNull()
    expect(imageHeader(webpLossy(10, 10).slice(0, 27))).toBeNull()
  })

  it('gives up on a JPEG that reaches its data, or loops on a segment of no length, without a frame', () => {
    const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0])
    expect(imageHeader(noFrame)).toBeNull()
    const zeroLength = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0])
    expect(imageHeader(zeroLength)).toBeNull()
  })
})

describe('imageRefusal', () => {
  it('lets a PNG, a JPEG and a WebP of a sane size through', () => {
    for (const head of [png(1000, 800), jpeg(1000, 800), webpLossy(1000, 800)]) expect(imageRefusal(200_000, head)).toBeNull()
  })

  it('refuses an empty file and one past the weight limit before looking inside', () => {
    expect(imageRefusal(0, png(10, 10))).toMatch(/vide/)
    expect(imageRefusal(SPACE_IMAGE_FILE_MAX + 1, png(10, 10))).toMatch(/lourde/)
    expect(imageRefusal(SPACE_IMAGE_FILE_MAX, png(10, 10))).toBeNull()
  })

  it('refuses a file that is not one of the three formats', () => {
    expect(imageRefusal(100, new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toMatch(/PNG, JPEG ou WebP/)
  })

  it('refuses a small file that would unpack into a huge picture, on either side or in all', () => {
    expect(imageRefusal(2000, png(SPACE_IMAGE_SIDE_MAX + 1, 10))).toMatch(/trop grande/)
    expect(imageRefusal(2000, png(10, SPACE_IMAGE_SIDE_MAX + 1))).toMatch(/trop grande/)
    expect(imageRefusal(2000, png(SPACE_IMAGE_SIDE_MAX, SPACE_IMAGE_SIDE_MAX))).toMatch(/trop grande/)
    // Each side is allowed, but their product is not.
    expect(imageRefusal(2000, png(7000, 6000))).toMatch(/trop grande/)
    expect(imageRefusal(2000, png(6000, 6000))).toBeNull()
  })

  it('refuses a picture with no pixels', () => {
    expect(imageRefusal(2000, png(0, 10))).toMatch(/vide/)
    expect(imageRefusal(2000, png(10, 0))).toMatch(/vide/)
  })
})

describe('isSpaceImageName', () => {
  it('accepts the names the store makes, and nothing a path could use', () => {
    expect(isSpaceImageName('0123456789abcdef01234567.png')).toBe(true)
    for (const bad of ['', '../0123456789abcdef01234567.png', '0123456789abcdef01234567.png/', '/etc/passwd', '0123456789abcdef01234567.PNG', '0123456789abcdef0123456.png', '0123456789abcdef012345678.png', '0123456789ABCDEF01234567.png', '0123456789abcdef01234567.png\n', 'a/../../b.png', '..', null, undefined, 12, {}]) { // gitleaks:allow (file names made of hexadecimal digits, not a key)
      expect(isSpaceImageName(bad), String(bad)).toBe(false)
    }
  })
})

describe('squareCrop', () => {
  it('takes the middle of a wide or a tall picture', () => {
    expect(squareCrop(400, 200)).toEqual({ x: 100, y: 0, size: 200 })
    expect(squareCrop(200, 400)).toEqual({ x: 0, y: 100, size: 200 })
    expect(squareCrop(300, 300)).toEqual({ x: 0, y: 0, size: 300 })
    expect(squareCrop(5, 2)).toEqual({ x: 1, y: 0, size: 2 })
  })
})

describe('referencedImages and orphanImages', () => {
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaa.png'
  const B = 'bbbbbbbbbbbbbbbbbbbbbbbb.png'
  const C = 'cccccccccccccccccccccccc.png'
  const space = (id: string, image?: string): Space => ({ id, name: id, emoji: '🏠', theme: defaultTheme(), profileId: 'default', ...(image ? { image } : {}) })

  it('counts the pictures of the spaces and of the spaces put aside', () => {
    const state: SidebarState = {
      ...createInitialState({ now: 0, newId: () => 'x' }),
      spaces: [space('one', A), space('two')],
      sessions: [{ id: 's', name: 'S', createdAt: 0, tabs: [], space: { space: space('aside', B), index: 1, folders: [], tabs: [], splits: [], selected: null, archive: [] } }]
    }
    expect([...referencedImages(state)].sort()).toEqual([A, B])
  })

  it('counts the pictures of the tabs too, open or in a space put aside: the sweep would delete them otherwise', () => {
    const tab = (id: string, image: string) => ({ id, spaceId: 'one', url: `https://${id}.example/`, title: id, pinned: false, createdAt: 0, lastActiveAt: 0, image })
    const state: SidebarState = {
      ...createInitialState({ now: 0, newId: () => 'x' }),
      spaces: [space('one')],
      tabs: [tab('t1', A)],
      sessions: [{ id: 's', name: 'S', createdAt: 0, tabs: [], space: { space: space('aside'), index: 1, folders: [], tabs: [tab('t2', B)], splits: [], selected: null, archive: [] } }]
    }
    expect([...referencedImages(state)].sort()).toEqual([A, B])
  })

  it('lists as orphans the pictures nothing refers to, and only files that are pictures of ours', () => {
    expect(orphanImages([A, B, C, 'notes.txt', '.DS_Store', 'photo.png', '../A.png'], new Set([A]))).toEqual([B, C])
    expect(orphanImages([A], new Set([A]))).toEqual([])
  })

  it('the defaults refer to nothing', () => {
    expect(referencedImages(createInitialState({ now: 0, newId: () => 'x' })).size).toBe(0)
    expect(defaultSettings().spaceImages).toBe(false)
  })
})

describe('parseSpaceImageRequest', () => {
  it('accepts the three requests, and nothing else', () => {
    expect(parseSpaceImageRequest({ op: 'pick', spaceId: 'sp-1' })).toEqual({ op: 'pick', spaceId: 'sp-1' })
    expect(parseSpaceImageRequest({ op: 'clear', spaceId: 'sp-1' })).toEqual({ op: 'clear', spaceId: 'sp-1' })
    expect(parseSpaceImageRequest({ op: 'read', name: '0123456789abcdef01234567.png' })).toEqual({ op: 'read', name: '0123456789abcdef01234567.png' })
    for (const bad of [null, undefined, 'pick', 3, [], {}, { op: 'pick' }, { op: 'pick', spaceId: '' }, { op: 'pick', spaceId: 7 }, { op: 'pick', spaceId: 'x'.repeat(300) }, { op: 'read', name: '../secret.png' }, { op: 'read', name: '/etc/passwd' }, { op: 'read' }, { op: 'delete', spaceId: 'a' }, { op: 'pick', path: '/Users/me/photo.png' }]) {
      expect(parseSpaceImageRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('never carries a path: whatever else the request holds is dropped', () => {
    expect(parseSpaceImageRequest({ op: 'pick', spaceId: 'sp-1', path: '/Users/me/photo.png' })).toEqual({ op: 'pick', spaceId: 'sp-1' })
  })
})
