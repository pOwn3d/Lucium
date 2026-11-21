import { describe, expect, it } from 'vitest'
import { TOTP_LIMITS, decodeBase32, encodeBase32, parseTotpInput, storedTotp } from './totp'

const KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // "12345678901234567890"
const ok = (input: unknown) => {
  const parsed = parseTotpInput(input)
  if (!parsed.ok) throw new Error(`refused: ${parsed.problem}`)
  return parsed.config
}

describe('base32', () => {
  it('decodes the RFC 4648 vectors and takes the case, the spaces, the hyphens and the padding as they come', () => {
    const text = (value: string) => new TextDecoder().decode(decodeBase32(value) ?? new Uint8Array())
    expect(text('MZXW6YTBOI======')).toBe('foobar')
    expect(text('mzxw6ytboi')).toBe('foobar')
    expect(text('MZXW 6YTB-OI')).toBe('foobar')
    expect(text('MY======')).toBe('f')
  })

  it('refuses a character outside the alphabet, an empty text and a length no encoding gives', () => {
    for (const bad of ['', '   ', 'MZXW6YT1', 'MZXW6YT!', 'M', 'MZX', 'MZXW6Y']) expect(decodeBase32(bad), bad).toBeNull()
  })

  it('refuses what only becomes base32 once the case is changed (« ß » is « SS », « ﬁ » is « FI » in upper case)', () => {
    expect(decodeBase32('MZXW6YTBOI======')).not.toBeNull()
    for (const bad of ['ßßßßßßßßßß', 'MZXW6YTBﬁ', 'MZXW6YTBOß']) expect(decodeBase32(bad), bad).toBeNull()
    expect(parseTotpInput('ßßßßßßßßßßßßßßßßßßßß')).toEqual({ ok: false, problem: 'invalid' })
  })

  it('round-trips bytes of every length', () => {
    for (let length = 1; length <= 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff)
      expect(Array.from(decodeBase32(encodeBase32(bytes)) ?? [])).toEqual(Array.from(bytes))
    }
  })
})

describe('a key typed or pasted', () => {
  it('is read as base32 with the usual defaults (SHA-1, 6 digits, 30 s), spaces and case ignored, and kept in one form', () => {
    expect(ok('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual({ secret: KEY, algorithm: 'SHA1', digits: 6, period: 30 })
    expect(ok(` ${KEY}== `).secret).toBe(KEY)
  })

  it('is read from an otpauth address with its parameters, and ignores the label and the issuer', () => {
    expect(ok(`otpauth://totp/Exemple:ana%40exemple.fr?secret=${KEY}&issuer=Exemple&algorithm=SHA256&digits=8&period=60`)).toEqual({ secret: KEY, algorithm: 'SHA256', digits: 8, period: 60 })
    expect(ok(`OTPAUTH://TOTP/x?secret=${KEY}&algorithm=sha512`).algorithm).toBe('SHA512')
  })

  it('refuses a counter-based key as unsupported, and every other form of otpauth as invalid', () => {
    expect(parseTotpInput(`otpauth://hotp/x?secret=${KEY}&counter=1`)).toEqual({ ok: false, problem: 'unsupported' })
    expect(parseTotpInput(`otpauth://other/x?secret=${KEY}`)).toEqual({ ok: false, problem: 'invalid' })
    expect(parseTotpInput('otpauth://totp/x')).toEqual({ ok: false, problem: 'invalid' })
    expect(parseTotpInput('otpauth:')).toEqual({ ok: false, problem: 'invalid' })
  })

  it('refuses a key that is too short, too long, not base32, or not a text', () => {
    expect(parseTotpInput('MZXW6YTBOI').ok).toBe(false) // 6 bytes
    expect(parseTotpInput(encodeBase32(new Uint8Array(TOTP_LIMITS.secretBytesMin - 1).fill(7))).ok).toBe(false)
    expect(parseTotpInput(encodeBase32(new Uint8Array(TOTP_LIMITS.secretBytesMin).fill(7))).ok).toBe(true)
    expect(parseTotpInput(encodeBase32(new Uint8Array(TOTP_LIMITS.secretBytesMax).fill(7))).ok).toBe(true)
    expect(parseTotpInput(encodeBase32(new Uint8Array(TOTP_LIMITS.secretBytesMax + 1).fill(7))).ok).toBe(false)
    for (const bad of ['', '   ', 'not a key at all 1', 42, null, undefined, {}, []]) expect(parseTotpInput(bad).ok, String(bad)).toBe(false)
  })

  it('refuses parameters out of their bounds or not plain numbers', () => {
    const uri = (query: string) => parseTotpInput(`otpauth://totp/x?secret=${KEY}&${query}`).ok
    expect(uri('digits=6')).toBe(true)
    expect(uri('digits=8')).toBe(true)
    for (const bad of ['digits=5', 'digits=9', 'digits=', 'digits=0x8', 'digits=6.0', 'digits=-6', 'period=9', 'period=301', 'period=', 'period=1e1', 'period=+30', 'algorithm=MD5', 'algorithm=', 'algorithm=SHA-1']) expect(uri(bad), bad).toBe(false)
  })

  it('refuses a text longer than the bound before reading it', () => {
    expect(parseTotpInput(`otpauth://totp/${'a'.repeat(TOTP_LIMITS.inputMax)}?secret=${KEY}`).ok).toBe(false)
  })

  it('never repeats what it refused', () => {
    const secretText = 'SUPERSECRETVALUE1234!'
    expect(JSON.stringify(parseTotpInput(secretText))).not.toContain('SUPERSECRET')
    expect(JSON.stringify(parseTotpInput(`otpauth://hotp/x?secret=${secretText}`))).not.toContain('SUPERSECRET')
  })
})

describe('a stored key', () => {
  const good = { secret: KEY, algorithm: 'SHA1', digits: 6, period: 30 }

  it('is accepted exactly in the form the vault writes', () => {
    expect(storedTotp(good)).toEqual(good)
  })

  it('is refused when a field is wrong, missing or added, or the key is not in its one form', () => {
    for (const bad of [
      { ...good, secret: KEY.toLowerCase() },
      { ...good, secret: `${KEY}====` },
      { ...good, secret: 'AAAA' },
      { ...good, algorithm: 'MD5' },
      { ...good, digits: 5 },
      { ...good, digits: '6' },
      { ...good, period: 9 },
      { ...good, period: 30.5 },
      { ...good, extra: 1 },
      { secret: KEY, algorithm: 'SHA1', digits: 6 },
      null,
      [],
      'text',
      undefined
    ]) expect(storedTotp(bad), JSON.stringify(bad)).toBeNull()
  })
})
