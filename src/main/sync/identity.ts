// The identity of this Mac for the synchronisation (docs/synchronisation.md §3.2, §3.3): a P-256 key made on the device and never exported, its self-signed
// certificate (certificate.ts), and a device identifier of 16 random bytes. They are made the first time the synchronisation is switched on, kept in
// `sync-identity.json` of the data folder, and never renewed: replacing them is pairing again.
//
// The private key is sealed (secret-box.ts) before it is written: the file holds the certificate in the clear (it is public) and the sealed key. A restoration on
// another machine, a copy of the profile, or a keychain that refuses brings the file without a key that opens: the identity is then unusable, a new one is made
// at the next switching on, and the list of paired devices, which belonged to the old fingerprint, is forgotten by the caller (`IdentityLoad.replaced`).
//
// Everything read from the file is hostile input: bounded, checked, and the key must belong to the certificate.

import { randomBytes, X509Certificate, type KeyObject } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { replaceFileDurably } from '../durable-write'
import { readTextBounded, SMALL_FILE_MAX_BYTES } from '../persist'
import { DEVICE_ID_BYTES, MAX_DEVICE_ID_CHARS } from './limits'
import { fingerprintOf, keyMatchesCertificate, makeDeviceCertificate, privateKeyOf } from './certificate'
import type { SecretBox } from './secret-box'

const VERSION = 1
const CERTIFICATE_MAX_BYTES = 2048
const SEALED_KEY_MAX_BYTES = 4096
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface SyncIdentity {
  /** 16 random bytes in base64url (22 characters), linked to the fingerprint at pairing (§3.2). */
  deviceId: string
  certificate: Buffer
  /** The SHA-256 of the certificate in DER: what the other device pins. */
  fingerprint: Buffer
  /** Held in memory only for TLS; never written other than sealed. */
  privateKey: KeyObject
}

interface IdentityRecord {
  version: typeof VERSION
  deviceId: string
  createdAt: number
  certificate: string
  sealedKey: string
}

/** What `loadOrCreate` did: the identity, and whether it replaced one the file held but that could not be used (the paired devices went with it). */
export interface IdentityLoad {
  identity: SyncIdentity
  created: boolean
  replaced: boolean
}

const isBase64 = (value: unknown, maxBytes: number): value is string => typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length <= maxBytes

function parseRecord(text: string): IdentityRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    console.error('[sync] the identity file is not JSON:', error)
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r['version'] !== VERSION) return null
  const { deviceId, createdAt, certificate, sealedKey } = r
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId) || deviceId.length > MAX_DEVICE_ID_CHARS) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  if (!isBase64(certificate, CERTIFICATE_MAX_BYTES) || !isBase64(sealedKey, SEALED_KEY_MAX_BYTES)) return null
  return { version: VERSION, deviceId, createdAt, certificate, sealedKey }
}

export class IdentityStore {
  constructor(
    private readonly path: string,
    private readonly box: SecretBox,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether a file is there (usable or not). */
  exists(): boolean {
    return existsSync(this.path)
  }

  /**
   * The identifier the file holds, read WITHOUT opening the key (the key is sealed by the system, and opening it may ask the keychain): enough to follow the marks at the
   * launch without touching the keychain. Null when there is no usable file.
   */
  peekDeviceId(): string | null {
    if (!existsSync(this.path)) return null
    try {
      return parseRecord(readTextBounded(this.path, SMALL_FILE_MAX_BYTES))?.deviceId ?? null
    } catch (error) {
      console.error(`[sync] cannot read ${this.path}:`, error)
      return null
    }
  }

  /**
   * The identity the file holds, or null when there is none or it cannot be used here: no file, a file that is not ours, a certificate that does not parse, a key
   * that does not open or does not belong to the certificate. The reason is logged: the caller decides what null means (a first activation, or a replaced identity).
   */
  load(): SyncIdentity | null {
    if (!existsSync(this.path)) return null
    let record: IdentityRecord | null
    try {
      record = parseRecord(readTextBounded(this.path, SMALL_FILE_MAX_BYTES))
    } catch (error) {
      console.error(`[sync] cannot read ${this.path}:`, error)
      return null
    }
    if (record === null) {
      console.error(`[sync] ${this.path} is not an identity file this version can use`)
      return null
    }
    try {
      const certificate = Buffer.from(record.certificate, 'base64')
      // Parsed once here: a certificate Node cannot read would only fail later, in the middle of a handshake.
      new X509Certificate(certificate)
      const pkcs8 = this.box.open(Buffer.from(record.sealedKey, 'base64'))
      if (!keyMatchesCertificate(pkcs8, certificate)) {
        console.error(`[sync] the key of ${this.path} does not belong to its certificate`)
        return null
      }
      return { deviceId: record.deviceId, certificate, fingerprint: fingerprintOf(certificate), privateKey: privateKeyOf(pkcs8) }
    } catch (error) {
      console.error(`[sync] the identity of ${this.path} cannot be opened on this machine (another machine, or a keychain that refuses):`, error)
      return null
    }
  }

  /**
   * The identity, made when there is none. Throws when the system cannot seal a key (nothing is written then: a key is never kept in the clear), and when the file
   * cannot be written (the caller shows the error; the synchronisation stays off).
   */
  loadOrCreate(): IdentityLoad {
    const existing = this.load()
    if (existing !== null) return { identity: existing, created: false, replaced: false }
    if (!this.box.available()) throw new Error('the system cannot seal the key of the device: the synchronisation cannot be switched on')
    const replaced = this.exists()
    const made = makeDeviceCertificate()
    const deviceId = randomBytes(DEVICE_ID_BYTES).toString('base64url')
    const record: IdentityRecord = {
      version: VERSION,
      deviceId,
      createdAt: this.now(),
      certificate: made.certificate.toString('base64'),
      sealedKey: this.box.seal(made.privateKey).toString('base64')
    }
    replaceFileDurably(this.path, `${JSON.stringify(record)}\n`)
    return { identity: { deviceId, certificate: made.certificate, fingerprint: made.fingerprint, privateKey: privateKeyOf(made.privateKey) }, created: true, replaced }
  }

  /** Removes the identity: the next switching on makes a new one, and every device has to be paired again. */
  forget(): void {
    rmSync(this.path, { force: true })
  }
}
