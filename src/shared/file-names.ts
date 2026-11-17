// A file name made from what a page says (a header, an address, a title). It may hold a path, control characters, characters that
// reorder text on screen, a name too long for the disk, or be a name the system reads as something else (".", ".."). What is offered is
// a plain file name; what the user types in a save dialog is theirs.
//
// The rules of macOS and Linux are the default. Windows (`platform: 'win32'`) adds its own, written from Microsoft's "Naming Files, Paths, and
// Namespaces" and NOT tried on a Windows machine (docs/plateformes.md): characters its file systems refuse, device names it reads as a device,
// and a length counted in UTF-16 units that leaves room for the folder.

import type { PlatformId } from './platform'

/** A file name is at most 255 bytes on the disks of macOS: keep a margin for the " (12)" that makes a name unique. */
export const FILE_NAME_MAX_BYTES = 240
/** A file name is at most 255 UTF-16 units on NTFS: the same margin. */
export const FILE_NAME_MAX_UNITS = 240
/** MAX_PATH is 260 units, the closing NUL included: the longest path an ordinary Windows program can open. */
export const WINDOWS_MAX_PATH = 259
/** What a number added to make a name unique takes: " (12345)". */
const UNIQUE_SUFFIX_UNITS = 8
/** A name is never cut shorter than this to fit a deep folder: past that, the folder alone breaks the limit and no name can help. */
const MIN_NAME_UNITS = 32
const FALLBACK_NAME = 'téléchargement'

// Control characters (C0, DEL, C1), line and paragraph separators, and the bidirectional formatting characters (U+202E turns "fdp.exe" into "exe.pdf" on screen).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

// What Windows refuses in a name (the slashes are already taken as separators). Each becomes an underscore: the name stays readable.
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*]/g
// The names Windows reads as a device, whatever follows the first dot ("nul.tar.gz" is the device too), in any case. COM0 and LPT0 are listed by Microsoft
// since 2023; the superscript digits stand for COM1 to COM3 and LPT1 to LPT3 there.
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

/** How a name is measured: in bytes where the disk counts bytes, in UTF-16 units (`String.length`) on Windows. */
type Measure = (text: string) => number
const unitLength: Measure = (text) => text.length

/** The extension of a name with its dot (".pdf"), or "" when it has none worth keeping. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/** `text` cut to at most `max` (in the unit of `measure`) without splitting a character. */
function cut(text: string, max: number, measure: Measure): string {
  let out = ''
  let used = 0
  for (const char of text) {
    used += measure(char)
    if (used > max) break
    out += char
  }
  return out
}

/** An underscore in front of a name Windows reads as a device ("CON.txt" → "_CON.txt"): the name stays readable and is no longer the device. */
function guardDeviceName(name: string): string {
  // The device is the part before the first dot, and spaces before that dot do not save it ("CON .txt" is the device as well).
  const stem = name.split('.')[0]!.replace(/ +$/, '')
  return WINDOWS_DEVICE_NAME.test(stem) ? `_${name}` : name
}

export interface FileNameOptions {
  /** The system the file is written on. macOS when left out (the rules of the other systems are only applied when asked for). */
  platform?: PlatformId
  /** The folder the file goes to, when known. On Windows the name is shortened so that the whole path stays under MAX_PATH. */
  folder?: string
}

/** The longest the name may be, in the unit of the platform. */
function maxLength(options: FileNameOptions): number {
  if (options.platform !== 'win32') return FILE_NAME_MAX_BYTES
  if (options.folder === undefined) return FILE_NAME_MAX_UNITS
  // The folder, a separator, the name and the number a duplicate gets; a folder given with its last separator is not counted twice.
  const folder = options.folder.replace(/[\\/]+$/, '')
  return Math.min(FILE_NAME_MAX_UNITS, Math.max(MIN_NAME_UNITS, WINDOWS_MAX_PATH - folder.length - 1 - UNIQUE_SUFFIX_UNITS))
}

/**
 * The name proposed in the save dialog: the last part of what the page said, cleaned, never empty, never a dot name, at most 240 bytes with its extension kept
 * (240 UTF-16 units on Windows, fewer when `folder` is deep). Called with a platform, it also holds that system's rules (see the top of the file).
 */
export function suggestedFileName(raw: unknown, options: FileNameOptions = {}): string {
  // A name is a short line: what comes from a page is cut before anything else is done to it.
  const text = typeof raw === 'string' ? raw.slice(0, 4096) : ''
  // Both separators count: a name made on another system can carry a path of the other kind.
  const last = text.split(/[\\/]/).pop() ?? ''
  const windows = options.platform === 'win32'
  const cleaned = last.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ')
  const name = (windows ? cleaned.replace(WINDOWS_FORBIDDEN_CHARS, '_') : cleaned).replace(/^[.\s]+/, '').replace(/[\s.]+$/, '').trim()
  if (name === '') return FALLBACK_NAME
  const measure = windows ? unitLength : byteLength
  const max = maxLength(options)
  const fitted = measure(name) <= max ? name : cutName(name, max, measure)
  return windows ? guardDeviceName(fitted) : fitted
}

/** `name` shortened to `max` with its extension kept. */
function cutName(name: string, max: number, measure: Measure): string {
  const ext = extensionOf(name)
  const keptExt = measure(ext) <= 16 ? ext : ''
  const stem = cut(name.slice(0, name.length - keptExt.length), max - measure(keptExt), measure).replace(/[\s.]+$/, '')
  return `${stem || FALLBACK_NAME}${keptExt}`
}
