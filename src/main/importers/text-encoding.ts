// The text of a file another program wrote: a bookmarks file exported on Windows or by an old browser is not always UTF-8 without a mark.
// `JSON.parse` refuses a byte order mark, and a UTF-16 file read as UTF-8 is NUL-spread noise: both would be "no bookmark", for a file
// that holds hundreds. Pure: bytes in, text out.

/** Windows-1252 is what a page without a declared charset was, and what the old exports of browsers wrote. */
const FALLBACK_CHARSET = 'windows-1252'

const decoder = (label: string, fatal = false): TextDecoder | null => {
  try {
    return new TextDecoder(label, { fatal })
  } catch {
    // A label the runtime does not know.
    return null
  }
}

/** The charset a bookmarks file declares in its first lines (`<META … CONTENT="text/html; charset=…">`), lower case; null when it declares none. */
function declaredCharset(bytes: Uint8Array): string | null {
  // The declaration is ASCII and sits at the top: look at the first 2 KB only.
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1')
  return /charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]{2,40})/i.exec(head)?.[1]?.toLowerCase() ?? null
}

/**
 * The text of a file's bytes: a byte order mark decides (UTF-8, UTF-16 little or big endian), then UTF-16 without a mark is recognised by
 * its zero bytes, then UTF-8 when the bytes are valid UTF-8, then the charset the file declares, then Windows-1252. The mark is not part of the text.
 */
export function decodeFileText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  // Without a mark, UTF-16 of Latin text has a zero byte in every other position of its first bytes.
  if (bytes.length >= 4) {
    if (bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0 && bytes[2] !== 0) return new TextDecoder('utf-16le').decode(bytes)
    if (bytes[0] === 0 && bytes[2] === 0 && bytes[1] !== 0 && bytes[3] !== 0) return new TextDecoder('utf-16be').decode(bytes)
  }
  const utf8 = decoder('utf-8', true)
  try {
    return utf8!.decode(bytes)
  } catch {
    // Not UTF-8: whatever the file says it is, then the old default.
    const declared = declaredCharset(bytes)
    const named = declared !== null && declared !== 'utf-8' && declared !== 'utf8' ? decoder(declared) : null
    return (named ?? decoder(FALLBACK_CHARSET)!).decode(bytes)
  }
}
