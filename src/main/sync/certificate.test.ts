// The certificate written by hand (docs/synchronisation.md §6.3) against the vector both sides follow, and read by Node's own parser, which is what TLS will use.
import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { assembleCertificate, fingerprintOf, keyMatchesCertificate, makeDeviceCertificate, randomSerial, signCertificate, toBeSigned } from './certificate'
import { pairingVectors } from './sync-vectors.test-support'

const fromHex = (hex: string): Buffer => Buffer.from(hex, 'hex')
const c = pairingVectors.certificate

describe('the certificate profile: the vector both sides follow', () => {
  it('builds the bytes to sign the vector gives, from the key and the serial alone', () => {
    expect(toBeSigned(fromHex(c.spkiHex), fromHex(c.serialHex)).toString('hex')).toBe(c.tbsHex)
  })

  it('has a fingerprint that is the SHA-256 of the DER of the sample, the same figure Node calls fingerprint256', () => {
    const der = fromHex(c.certificateDerHex)
    expect(fingerprintOf(der).toString('hex')).toBe(c.fingerprintHex)
    expect(new X509Certificate(der).fingerprint256.replaceAll(':', '').toLowerCase()).toBe(c.fingerprintHex)
  })

  it('assembles the sample from its bytes to sign and the signature it carries, byte for byte', () => {
    const sample = fromHex(c.certificateDerHex)
    const tbsEnd = sample.indexOf(fromHex(c.tbsHex)) + fromHex(c.tbsHex).length
    expect(assembleCertificate(fromHex(c.tbsHex), signatureOf(sample, tbsEnd)).toString('hex')).toBe(c.certificateDerHex)
  })
})

/** The DER signature of a certificate of this profile, after its bytes to sign: the algorithm (30 0a 06 08 + 8 bytes = 12), then a BIT STRING (03 len 00 signature). */
function signatureOf(certificate: Buffer, tbsEnd: number): Buffer {
  const bitString = tbsEnd + 12
  expect(certificate[bitString]).toBe(0x03)
  expect(certificate[bitString + 2]).toBe(0)
  return certificate.subarray(bitString + 3, bitString + 2 + (certificate[bitString + 1] as number))
}

describe('a certificate made on this profile', () => {
  const made = makeDeviceCertificate()
  const parsed = new X509Certificate(made.certificate)

  it('is read by Node: the name, the dates, the key and its own signature', () => {
    expect(parsed.subject).toBe('CN=lucium-sync')
    expect(parsed.issuer).toBe('CN=lucium-sync')
    expect(parsed.validFrom).toMatch(/1970/)
    expect(parsed.validTo).toMatch(/9999/)
    expect(parsed.ca).toBe(false)
    expect(parsed.verify(parsed.publicKey)).toBe(true)
    expect(parsed.publicKey.asymmetricKeyType).toBe('ec')
    expect(parsed.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
  })

  it('has the fingerprint of its DER, 32 bytes, and carries no extension', () => {
    expect(made.fingerprint).toEqual(fingerprintOf(made.certificate))
    expect(made.fingerprint.length).toBe(32)
    expect(parsed.fingerprint256.replaceAll(':', '').toLowerCase()).toBe(made.fingerprint.toString('hex'))
    // Version 3 with no extension field: the certificate ends with the signature, no [3] EXPLICIT block (tag a3) between the key and it.
    expect(parsed.subjectAltName).toBeUndefined()
    expect(parsed.keyUsage).toBeUndefined()
  })

  it('keeps the private key as PKCS#8 DER that belongs to the certificate, and to no other', () => {
    expect(keyMatchesCertificate(made.privateKey, made.certificate)).toBe(true)
    expect(keyMatchesCertificate(makeDeviceCertificate().privateKey, made.certificate)).toBe(false)
  })

  it('says so, and does not match, when the stored key cannot be read at all', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(keyMatchesCertificate(Buffer.from('not a key'), made.certificate)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[sync] a stored key could not be read'), expect.anything())
    log.mockRestore()
  })

  it('is signed by the key it holds: a signature of another key does not verify', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const forged = signCertificate(other.privateKey, createPublicKey(createPrivateKey({ key: made.privateKey, format: 'der', type: 'pkcs8' })), randomSerial())
    const forgedParsed = new X509Certificate(forged.certificate)
    expect(forgedParsed.verify(forgedParsed.publicKey)).toBe(false)
  })
})

describe('the serial', () => {
  it('is 16 bytes whose first is between 0x01 and 0x7F, a positive integer in minimal DER', () => {
    for (let index = 0; index < 500; index++) {
      const serial = randomSerial()
      expect(serial.length).toBe(16)
      expect(serial[0]).toBeGreaterThanOrEqual(0x01)
      expect(serial[0]).toBeLessThanOrEqual(0x7f)
    }
  })

  it('differs from one certificate to the next', () => {
    expect(randomSerial().equals(randomSerial())).toBe(false)
    expect(makeDeviceCertificate().fingerprint.equals(makeDeviceCertificate().fingerprint)).toBe(false)
  })
})
