import { describe, expect, it } from 'vitest'
import { decodeFileText } from './text-encoding'

const utf16le = (text: string, mark = true) => Buffer.concat([mark ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')])
const utf16be = (text: string, mark = true) => {
  const le = Buffer.from(text, 'utf16le')
  const be = Buffer.alloc(le.length)
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1]!
    be[i + 1] = le[i]!
  }
  return Buffer.concat([mark ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), be])
}

const SAMPLE = '{"roots":{"bookmark_bar":{"children":[{"name":"Café ☕ שלום 🌍","url":"https://x.example/"}]}}}'

describe('the text of a bookmarks file', () => {
  it('reads UTF-8, with emoji and right-to-left text, as it is', () => {
    expect(decodeFileText(Buffer.from(SAMPLE, 'utf8'))).toBe(SAMPLE)
  })

  it('drops the byte order mark of a UTF-8 file: JSON.parse refuses it', () => {
    const text = decodeFileText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE, 'utf8')]))
    expect(text).toBe(SAMPLE)
    expect(() => JSON.parse(text)).not.toThrow()
  })

  it('reads UTF-16, little or big endian, with or without a mark', () => {
    for (const bytes of [utf16le(SAMPLE), utf16be(SAMPLE), utf16le(SAMPLE, false), utf16be(SAMPLE, false)]) expect(decodeFileText(bytes)).toBe(SAMPLE)
  })

  it('reads the old exports: Windows-1252 bytes, declared or not, are accents and not replacement characters', () => {
    const legacy = Buffer.from('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252"><A HREF="https://x.example/">Caf\xe9 \x80</A>', 'latin1')
    expect(decodeFileText(legacy)).toContain('Café €')
    expect(decodeFileText(Buffer.from('<A HREF="https://x.example/">Caf\xe9</A>', 'latin1'))).toContain('Café')
  })

  it('follows the charset a file declares when it is not UTF-8, and falls back to Windows-1252 for a label nobody knows', () => {
    const latin9 = Buffer.from('<META CONTENT="text/html; charset=ISO-8859-15">\xa4', 'latin1')
    // 0xA4 is the euro sign in ISO-8859-15 and the currency sign in Windows-1252.
    expect(decodeFileText(latin9)).toContain('€')
    const unknown = Buffer.from('<META CONTENT="text/html; charset=not-a-charset">\xe9', 'latin1')
    expect(decodeFileText(unknown)).toContain('é')
  })

  it('does not take a plain ASCII file with a declared legacy charset for anything else', () => {
    expect(decodeFileText(Buffer.from('<META CONTENT="text/html; charset=windows-1252"><A HREF="https://x.example/">x</A>'))).toContain('https://x.example/')
  })

  it('reads an empty file as an empty text', () => {
    expect(decodeFileText(new Uint8Array())).toBe('')
  })
})
