// The certificate of a device, written by hand (docs/synchronisation.md §6.3, [Q6]). Neither Node nor the APIs of Apple make an X.509 certificate, and TLS needs
// one on each side. The project writes the DER itself, on ONE profile that both sides follow and that a vector fixes (ios/Contracts/sync-pairing-vectors.json,
// `certificate`): a profile changed on one side fails the test of the other.
//
// The trust never comes from this certificate: each side pins the fingerprint of the other (the SHA-256 of the certificate in DER), and the code of the project
// compares it itself. So a certificate badly formed makes a pairing fail, it never weakens one. Hence also a validity from 1970 to 9999 (the date means
// nothing here), no extension, and a name that says nothing about a person or a device.
//
//   version      v3 (A0 03 02 01 02)
//   serial       16 random bytes, the first between 0x01 and 0x7F (a positive integer in minimal DER)
//   signature    ecdsa-with-SHA256 (1.2.840.10045.4.3.2), no parameters
//   issuer       = subject = CN=lucium-sync (UTF8String)
//   validity     700101000000Z (UTCTime) to 99991231235959Z (GeneralizedTime)
//   key          SubjectPublicKeyInfo, P-256, uncompressed point
//   extensions   none

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

const derLength = (length: number): Buffer => {
  if (length < 128) return Buffer.from([length])
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const oid = (bytes: readonly number[]): Buffer => der(0x06, Buffer.from(bytes))

/** ecdsa-with-SHA256, no parameters. */
const SIGNATURE_ALGORITHM = der(0x30, oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))
/** The one name, `CN=lucium-sync`, for the issuer and the subject. */
const NAME = der(0x30, der(0x31, der(0x30, oid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from('lucium-sync', 'utf8')))))
const VALIDITY = der(0x30, der(0x17, Buffer.from('700101000000Z')), der(0x18, Buffer.from('99991231235959Z')))
const VERSION_3 = Buffer.from('a003020102', 'hex')

/** The bytes the signature covers (`tbsCertificate`), from the key (`SubjectPublicKeyInfo` in DER) and the serial alone. A vector fixes them. */
export function toBeSigned(spki: Buffer, serial: Buffer): Buffer {
  return der(0x30, VERSION_3, der(0x02, serial), SIGNATURE_ALGORITHM, NAME, VALIDITY, NAME, spki)
}

/** The certificate in DER: the bytes to sign, the algorithm, and the signature as a bit string (no unused bits) of the DER form of the ECDSA signature. */
export function assembleCertificate(tbs: Buffer, signature: Buffer): Buffer {
  return der(0x30, tbs, SIGNATURE_ALGORITHM, der(0x03, Buffer.from([0]), signature))
}

/** The fingerprint of a certificate: the SHA-256 of its DER, 32 bytes. The same figure Node calls `fingerprint256` and Apple's `SecCertificateCopyData` hashes to. */
export const fingerprintOf = (certificate: Buffer): Buffer => createHash('sha256').update(certificate).digest()

/** A serial: 16 random bytes whose first is between 0x01 and 0x7F, so that the integer is positive and its DER minimal. */
export function randomSerial(): Buffer {
  const serial = randomBytes(16)
  serial[0] = (serial[0] as number) % 0x7f + 1
  return serial
}

/** What a device keeps of its identity: the certificate to present, the key it signs with (PKCS#8 DER: the caller seals it, it never goes to disk as it is), and the fingerprint. */
export interface DeviceCertificate {
  certificate: Buffer
  privateKey: Buffer
  fingerprint: Buffer
}

/** A new P-256 key and the certificate that goes with it. The key is made here and never leaves the device in any other form than the one the caller seals. */
export function makeDeviceCertificate(): DeviceCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { ...signCertificate(privateKey, publicKey, randomSerial()), privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }) }
}

/** The certificate for a key and a serial, signed with that key (ECDSA, SHA-256, DER signature). Split from `makeDeviceCertificate` so that a test fixes the serial. */
export function signCertificate(privateKey: KeyObject, publicKey: KeyObject, serial: Buffer): Pick<DeviceCertificate, 'certificate' | 'fingerprint'> {
  const tbs = toBeSigned(publicKey.export({ type: 'spki', format: 'der' }), serial)
  const certificate = assembleCertificate(tbs, sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' }))
  return { certificate, fingerprint: fingerprintOf(certificate) }
}

/** The private key of a sealed identity, back to a key object for TLS (the DER the caller opened). */
export const privateKeyOf = (pkcs8: Buffer): KeyObject => createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })

/** The public key a certificate holds is what the key it was made with gives: used to check that a certificate and a key read from disk belong together. */
export function keyMatchesCertificate(pkcs8: Buffer, certificate: Buffer): boolean {
  try {
    const wanted = createPublicKey(privateKeyOf(pkcs8)).export({ type: 'spki', format: 'der' })
    return certificate.includes(wanted)
  } catch (error) {
    // A key that cannot be read is a key that does not match: the identity is made again (identity.ts says so in the log), never used.
    console.error('[sync] a stored key could not be read, so it does not match its certificate:', error)
    return false
  }
}
