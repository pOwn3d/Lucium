// A picture chosen for a space, in place of its emoji. The user picks a file in a dialog of the main process; the main process reads it,
// checks it is a PNG, a JPEG or a WebP of a sane size, crops it to a square, shrinks it and keeps only its own copy in the data folder.
// The state holds the copy's name (never the path of the original), and the interface asks for the picture by that name. Everything the
// file says is hostile: sizes are read from the header before anything is decoded, and every name is checked before it meets a path.
// Pure rules (no Electron, no file access) shared by the main process, the state cleaner and the interface.

import type { SidebarState } from './model'
import { t } from './i18n'

/** The side of the stored picture, in pixels: 64 points on a Retina screen. */
export const SPACE_IMAGE_SIZE = 128
/** The most the chosen file may weigh. A bigger one is refused before it is read. */
export const SPACE_IMAGE_FILE_MAX = 5 * 1024 * 1024
/** The longest side the chosen picture may have: a small file can still unpack into hundreds of megabytes of pixels. */
export const SPACE_IMAGE_SIDE_MAX = 8192
/** …and the most pixels (the product of both sides) it may have. */
export const SPACE_IMAGE_PIXELS_MAX = 40_000_000
/** The most a stored picture may weigh when it is read back (ours weigh a few kilobytes). */
export const SPACE_IMAGE_STORED_MAX = 256 * 1024

/** A stored picture is named by 24 hex digits and `.png`: nothing a path could use to leave the folder. */
export const SPACE_IMAGE_NAME = /^[0-9a-f]{24}\.png$/

export function isSpaceImageName(value: unknown): value is string {
  return typeof value === 'string' && SPACE_IMAGE_NAME.test(value)
}

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface ImageHeader {
  format: ImageFormat
  width: number
  height: number
}

const u16be = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!
const u32be = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
const u16le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8)
const u24le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
const ascii = (b: Uint8Array, at: number, text: string): boolean => [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0))

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** The JPEG markers that start a frame and carry the picture's size (every start-of-frame but the table definitions 0xC4, 0xC8, 0xCC). */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
/** Markers without a length: a JPEG's header is read segment by segment and these stand alone. */
const JPEG_ALONE = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)

function pngHeader(b: Uint8Array): ImageHeader | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((v, i) => b[i] === v) || !ascii(b, 12, 'IHDR')) return null
  return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) }
}

function jpegHeader(b: Uint8Array): ImageHeader | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let at = 2
  // Segments are skipped by their length; the first start of frame says the size. A file that reaches the data (0xDA) first has none.
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (JPEG_ALONE(marker)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = u16be(b, at + 2)
    if (length < 2) return null
    if (JPEG_FRAMES.has(marker)) return at + 9 <= b.length ? { format: 'jpeg', width: u16be(b, at + 7), height: u16be(b, at + 5) } : null
    at += 2 + length
  }
  return null
}

function webpHeader(b: Uint8Array): ImageHeader | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null
  if (ascii(b, 12, 'VP8 ')) {
    // Lossy: a three-byte frame tag, the start code 9D 01 2A, then two 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (ascii(b, 12, 'VP8L')) {
    // Lossless: the signature byte 0x2F, then two 14-bit sizes (each minus one) packed in 28 bits.
    if (b[20] !== 0x2f) return null
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(b, 12, 'VP8X')) return { format: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  return null
}

/** The format and size a file's first bytes announce; null when they announce none of the three formats (the name of the file is never trusted). */
export function imageHeader(bytes: Uint8Array): ImageHeader | null {
  return pngHeader(bytes) ?? jpegHeader(bytes) ?? webpHeader(bytes)
}

/**
 * Why a chosen file cannot become a space's picture, as a sentence for the user; null when it can. `size` is the file's weight and `head` its
 * first bytes (a megabyte is plenty for any header): nothing is decoded before this passes.
 */
export function imageRefusal(size: number, head: Uint8Array): string | null {
  if (!Number.isFinite(size) || size <= 0) return t('space-image.ce-fichier-est-vide')
  if (size > SPACE_IMAGE_FILE_MAX) return t('space-image.cette-image-est-trop-lourde-5-mo-au-plus')
  const header = imageHeader(head)
  if (!header) return t('space-image.ce-fichier-n-est-pas-une-image-png-jpeg-ou-webp')
  if (header.width < 1 || header.height < 1) return t('space-image.cette-image-est-vide')
  if (header.width > SPACE_IMAGE_SIDE_MAX || header.height > SPACE_IMAGE_SIDE_MAX || header.width * header.height > SPACE_IMAGE_PIXELS_MAX) return t('space-image.cette-image-est-trop-grande-8-000-pixels-au')
  return null
}

/** The square taken from the middle of a picture of this size, before it is shrunk. */
export function squareCrop(width: number, height: number): { x: number; y: number; size: number } {
  const size = Math.max(1, Math.min(width, height))
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), size }
}

/**
 * The names of the pictures the state refers to: the spaces' own and the tabs' own, and those of the spaces put aside (a session keeps the whole
 * space, its picture and its tabs' included). A picture left out here is deleted from the disk.
 */
export function referencedImages(state: Pick<SidebarState, 'spaces' | 'sessions' | 'tabs'>): Set<string> {
  const names = new Set<string>()
  for (const space of state.spaces) if (isSpaceImageName(space.image)) names.add(space.image)
  for (const tab of state.tabs) if (isSpaceImageName(tab.image)) names.add(tab.image)
  for (const session of state.sessions) {
    const image = session.space?.space.image
    if (isSpaceImageName(image)) names.add(image)
    for (const tab of session.space?.tabs ?? []) if (isSpaceImageName(tab.image)) names.add(tab.image)
  }
  return names
}

/** Files of the pictures folder that nothing refers to any more. Only names of our own form are ever listed: anything else in the folder is left alone. */
export function orphanImages(files: readonly string[], referenced: ReadonlySet<string>): string[] {
  return files.filter((name) => isSpaceImageName(name) && !referenced.has(name))
}

/** What the interface may ask of the main process about space pictures. */
export type SpaceImageRequest =
  /** The user picks a file for this space (a dialog of the main process), which becomes its picture. */
  | { op: 'pick'; spaceId: string }
  /** The picture of this space goes back to its emoji; the stored copy is deleted. */
  | { op: 'clear'; spaceId: string }
  /** The user picks a file for this tab (the same dialog), which becomes its icon; it is taken away like an emoji (`tab/icon`). */
  | { op: 'pick-tab'; tabId: string }
  /** The stored picture of this name, as a `data:` URL. */
  | { op: 'read'; name: string }

const ID_MAX = 256

export function parseSpaceImageRequest(raw: unknown): SpaceImageRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const spaceId = r['spaceId']
  if ((r['op'] === 'pick' || r['op'] === 'clear') && typeof spaceId === 'string' && spaceId !== '' && spaceId.length <= ID_MAX) return { op: r['op'], spaceId }
  const tabId = r['tabId']
  if (r['op'] === 'pick-tab' && typeof tabId === 'string' && tabId !== '' && tabId.length <= ID_MAX) return { op: 'pick-tab', tabId }
  if (r['op'] === 'read' && isSpaceImageName(r['name'])) return { op: 'read', name: r['name'] }
  return null
}

/** `message` is empty when nothing is to be said (the user closed the dialog); `dataUrl` is set by `read` only. */
export type SpaceImageReply = { ok: true; dataUrl?: string } | { ok: false; message: string }

/** Why a stored picture is not shown, in the language of the interface when it is read. */
export const spaceImageUnreadable = (): string => t('space-image.cette-image-n-a-pas-pu-etre-lue')
