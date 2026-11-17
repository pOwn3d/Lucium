// A file name made from what a page says (a header, an address, a title). It may hold a path, control characters, characters that
// reorder text on screen, a name too long for the disk, or be a name the system reads as something else (".", ".."). What is offered is
// a plain file name; what the user types in a save dialog is theirs.

/** A file name is at most 255 bytes on the disks of macOS: keep a margin for the " (12)" that makes a name unique. */
export const FILE_NAME_MAX_BYTES = 240
const FALLBACK_NAME = 'téléchargement'

// Control characters (C0, DEL, C1), line and paragraph separators, and the bidirectional formatting characters (U+202E turns "fdp.exe" into "exe.pdf" on screen).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

/** The extension of a name with its dot (".pdf"), or "" when it has none worth keeping. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/** `text` cut to at most `max` bytes without splitting a character. */
function cutBytes(text: string, max: number): string {
  let out = ''
  for (const char of text) {
    if (byteLength(out + char) > max) break
    out += char
  }
  return out
}

/** The name proposed in the save dialog: the last part of what the page said, cleaned, never empty, never a dot name, at most 240 bytes with its extension kept. */
export function suggestedFileName(raw: unknown): string {
  // A name is a short line: what comes from a page is cut before anything else is done to it.
  const text = typeof raw === 'string' ? raw.slice(0, 4096) : ''
  // Both separators count: a name made on another system can carry a path of the other kind.
  const last = text.split(/[\\/]/).pop() ?? ''
  const name = last.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').replace(/[\s.]+$/, '').trim()
  if (name === '') return FALLBACK_NAME
  if (byteLength(name) <= FILE_NAME_MAX_BYTES) return name
  const ext = extensionOf(name)
  const keptExt = byteLength(ext) <= 16 ? ext : ''
  const stem = cutBytes(name.slice(0, name.length - keptExt.length), FILE_NAME_MAX_BYTES - byteLength(keptExt)).replace(/[\s.]+$/, '')
  return `${stem || FALLBACK_NAME}${keptExt}`
}

