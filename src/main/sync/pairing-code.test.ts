// The QR text and the typed code (docs/synchronisation.md §4.2, §4.3) against the shared vectors, and the way the Mac writes them.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { manualAddress, manualCode, qrText, readManualCode, readQr } from './pairing-code'
import { pairingVectors } from './sync-vectors.test-support'

describe('readQr: the vectors of the specification', () => {
  it.each(pairingVectors.qr.valid)('reads: $name', ({ text, expect: expected }) => {
    const reading = readQr(text)
    expect(reading.ok).toBe(true)
    if (!reading.ok) return
    expect({ fingerprintHex: reading.fingerprint.toString('hex'), secretHex: reading.secret.toString('hex'), port: reading.port, hosts: reading.hosts }).toEqual(expected)
  })

  it.each(pairingVectors.qr.invalid)('refuses: $name', ({ text, expect: expected }) => {
    expect(readQr(text)).toEqual({ ok: false, code: expected.code })
  })
})

describe('readQr: the last character of a base64url field carries bits that must be zero', () => {
  const text = pairingVectors.qr.valid[0]?.text ?? ''
  const [prefix, fingerprint, secret, ...rest] = text.split('/') as [string, string, string, ...string[]]
  const join = (fp: string, sec: string): string => [prefix, fp, sec, ...rest].join('/')

  it('refuses a fingerprint whose last character has a padding bit set (two bits are padding in 43 characters)', () => {
    expect(readQr(join(fingerprint, secret)).ok).toBe(true)
    expect(readQr(join(`${fingerprint.slice(0, -1)}9`, secret))).toEqual({ ok: false, code: 'invalid-code' })
  })

  it('refuses a secret whose last character has a padding bit set (four bits are padding in 22 characters)', () => {
    expect(readQr(join(fingerprint, `${secret.slice(0, -1)}x`))).toEqual({ ok: false, code: 'invalid-code' })
  })
})

describe('readManualCode: the vectors of the specification', () => {
  it.each(pairingVectors.manualCode.valid)('reads: $name', ({ input, expect: expected }) => {
    const reading = readManualCode(input)
    expect(reading.ok && reading.secret.toString('hex')).toBe(expected.secretHex)
  })

  it.each(pairingVectors.manualCode.invalid)('refuses: $name', ({ input, expect: expected }) => {
    expect(readManualCode(input)).toEqual({ ok: false, code: expected.code })
  })

  it('has the same secret in the QR and in the typed code of the vectors', () => {
    const qr = pairingVectors.qr.valid[0]?.expect.secretHex
    expect(pairingVectors.manualCode.valid.every((v) => v.expect.secretHex === qr)).toBe(true)
  })
})

describe('what the Mac writes', () => {
  it('writes the typed code of the vector from its secret: five characters, a dash, 26 in all', () => {
    const vector = pairingVectors.manualCode.valid[0]
    expect(manualCode(Buffer.from(vector?.expect.secretHex ?? '', 'hex'))).toBe(vector?.input)
  })

  it('writes the QR text of the vector from its content, byte for byte', () => {
    for (const vector of pairingVectors.qr.valid) {
      const { fingerprintHex, secretHex, port, hosts } = vector.expect
      expect(qrText({ fingerprint: Buffer.from(fingerprintHex, 'hex'), secret: Buffer.from(secretHex, 'hex'), port, hosts }), vector.name).toBe(vector.text)
    }
  })

  it('reads back what it writes, for secrets drawn at random', () => {
    for (let index = 0; index < 50; index++) {
      const secret = randomBytes(16)
      const typed = readManualCode(manualCode(secret))
      expect(typed.ok && typed.secret.equals(secret)).toBe(true)
      const reading = readQr(qrText({ fingerprint: randomBytes(32), secret, port: 49152 + index, hosts: ['192.168.1.20'] }))
      expect(reading.ok && reading.secret.equals(secret)).toBe(true)
    }
  })

  it('never shows a code nobody could read: a public host, no host, five hosts and a port out of range throw', () => {
    const base = { fingerprint: randomBytes(32), secret: randomBytes(16), port: 49213, hosts: ['192.168.1.20'] }
    expect(() => qrText({ ...base, hosts: ['8.8.8.8'] })).toThrow()
    expect(() => qrText({ ...base, hosts: [] })).toThrow()
    expect(() => qrText({ ...base, hosts: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'] })).toThrow()
    expect(() => qrText({ ...base, port: 0 })).toThrow()
    expect(() => qrText({ ...base, port: 65_536 })).toThrow()
  })

  it('refuses a secret that is not 16 bytes in the typed code', () => {
    expect(() => manualCode(Buffer.alloc(15))).toThrow()
  })

  it('writes the address beside the code, an IPv6 address between brackets', () => {
    expect(manualAddress('mac-de-test.local', 49213)).toBe('mac-de-test.local:49213')
    expect(manualAddress('fd12:3456:789a::1', 49213)).toBe('[fd12:3456:789a::1]:49213')
  })
})
