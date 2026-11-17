// The encrypted form of "Exporter les données": the JSON of the state, sealed with a passphrase. Node's own `crypto` only, no dependency.
//
// Format, version 1 (a JSON envelope, so that a file of the old plain kind and this one are told apart by one key):
//   { format: "lucium-export", version: 1,
//     kdf: { name: "scrypt", N, r, p, salt }, cipher: { name: "aes-256-gcm", nonce },
//     check, data }                       (every binary field is standard base64)
// - The key comes from scrypt over the NFKC-normalised passphrase and a random 16-byte salt: 64 bytes, the first 32 are the AES key and the
//   last 32 a MAC key. Default cost N = 2^17, r = 8, p = 1 (128 MiB, about a third of a second): the figure OWASP gives for scrypt.
// - `check` is HMAC-SHA256 of the header under the MAC key. It tells a wrong passphrase from a damaged file before anything is decrypted,
//   and it covers the parameters, so a file whose cost was rewritten is refused whatever the cost.
// - `data` is AES-256-GCM (random 12-byte nonce, the header as additional data) of a frame: a 4-byte length, the JSON, then zeros up to a
//   size that hides the exact length (the next multiple of at least 4 KiB, with a step of at most one eighth of the size).
// - A file is hostile input: the cost it asks for is bounded before any key is derived (SCRYPT_LIMITS), the sizes too, every field is checked.
// The passphrase is never logged, stored or put in an error message.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { t } from '@shared/i18n'
import { isRecord } from '@shared/record'

export const EXPORT_FORMAT = 'lucium-export'
export const EXPORT_VERSION = 1

export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** What a new export costs. */
export const SCRYPT_DEFAULT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }

/**
 * What a file may ask for. N is a power of two between the floor (no weaker than a file this application would write) and 2^18; the memory
 * (128 * N * r bytes) and the work (N * r * p) are capped as a whole, so that no combination costs more than about four times the default.
 */
export const SCRYPT_LIMITS = { minN: 2 ** 14, maxN: 2 ** 18, maxR: 16, maxP: 4, maxMemory: 256 * 1024 * 1024, maxWork: 2 ** 22 } as const

export const PASSPHRASE_MIN = 8
export const PASSPHRASE_MAX = 1024
/** A file larger than this is not an export of this application (the state is a few megabytes at most). */
export const EXPORT_FILE_MAX = 64 * 1024 * 1024

const SALT_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const PAD_FLOOR = 4096
const LENGTH_BYTES = 4

export type ExportCryptoErrorKind = 'weak-passphrase' | 'not-an-export' | 'unsupported' | 'too-costly' | 'wrong-passphrase' | 'tampered' | 'too-large'

/** An error with a kind the interface turns into a sentence (`exportErrorMessage`); its `message` never holds the passphrase. */
export class ExportCryptoError extends Error {
  constructor(readonly kind: ExportCryptoErrorKind, message: string) {
    super(message)
    this.name = 'ExportCryptoError'
  }
}

/** The sentence the user reads for each failure. */
export function exportErrorMessage(error: unknown): string {
  if (!(error instanceof ExportCryptoError)) return t('export-crypto.le-fichier-n-a-pas-pu-etre-lu')
  switch (error.kind) {
    case 'weak-passphrase':
      return t('export-crypto.la-phrase-secrete-doit-faire-au-moins', { PASSPHRASE_MIN })
    case 'not-an-export':
      return t('export-crypto.ce-fichier-n-est-pas-une-exportation-chiffree-d')
    case 'unsupported':
      return t('export-crypto.cette-exportation-chiffree-a-ete-faite-par-une')
    case 'too-costly':
      return t('vault-crypto.calcul-de-cle-demesure')
    case 'wrong-passphrase':
      return t('export-crypto.la-phrase-secrete-est-incorrecte-ou-l-en-tete')
    case 'tampered':
      return t('export-crypto.le-fichier-a-ete-altere-ou-est-incomplet')
    case 'too-large':
      return t('export-crypto.ce-fichier-est-trop-volumineux-pour-etre-une')
  }
}

/** The envelope as it is written; the binary fields are base64. */
export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT
  version: typeof EXPORT_VERSION
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: { name: 'aes-256-gcm'; nonce: string }
  check: string
  data: string
}

interface Parsed {
  params: ScryptParams
  salt: Buffer
  nonce: Buffer
  check: Buffer
  sealed: Buffer
}

const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

/** Strict base64: the canonical form of exactly the bytes it decodes to (Buffer's own decoder skips whatever it does not understand). */
export function fromBase64(value: unknown, bytes?: { exactly?: number; atMost?: number }): Buffer | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value) return null
  if (bytes?.exactly !== undefined && buffer.length !== bytes.exactly) return null
  if (bytes?.atMost !== undefined && buffer.length > bytes.atMost) return null
  return buffer
}

/** Whether `value` (an already parsed JSON file) claims to be an encrypted export. Says nothing about its being valid. */
export const isEncryptedExport = (value: unknown): boolean => isRecord(value) && value['format'] === EXPORT_FORMAT

/** The cost a file may ask for: false for anything outside `SCRYPT_LIMITS`, however it is spelled. */
export function paramsAllowed(params: ScryptParams): boolean {
  const { N, r, p } = params
  const { minN, maxN, maxR, maxP, maxMemory, maxWork } = SCRYPT_LIMITS
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false
  return isPowerOfTwo(N) && N >= minN && N <= maxN && r <= maxR && p <= maxP && 128 * N * r <= maxMemory && N * r * p <= maxWork
}

/** The header the MAC and the cipher authenticate: everything of the envelope except `check` and `data`, in a fixed order. */
function headerBytes(params: ScryptParams, salt: Buffer, nonce: Buffer): Buffer {
  return Buffer.from(JSON.stringify([EXPORT_FORMAT, EXPORT_VERSION, 'scrypt', params.N, params.r, params.p, salt.toString('base64'), 'aes-256-gcm', nonce.toString('base64')]), 'utf8')
}

/** Reads and bounds the envelope; no key is derived here. */
function parseEnvelope(value: unknown): Parsed {
  if (!isEncryptedExport(value)) throw new ExportCryptoError('not-an-export', 'not an export')
  const envelope = value as Record<string, unknown>
  if (envelope['version'] !== EXPORT_VERSION) throw new ExportCryptoError('unsupported', 'unsupported version')
  const kdf = envelope['kdf']
  const cipher = envelope['cipher']
  if (!isRecord(kdf) || !isRecord(cipher) || kdf['name'] !== 'scrypt' || cipher['name'] !== 'aes-256-gcm') throw new ExportCryptoError('unsupported', 'unsupported algorithms')
  const params: ScryptParams = { N: kdf['N'] as number, r: kdf['r'] as number, p: kdf['p'] as number }
  if (!paramsAllowed(params)) throw new ExportCryptoError('too-costly', 'key derivation parameters out of bounds')
  const salt = fromBase64(kdf['salt'], { exactly: SALT_BYTES })
  const nonce = fromBase64(cipher['nonce'], { exactly: NONCE_BYTES })
  const check = fromBase64(envelope['check'], { exactly: KEY_BYTES })
  const sealed = fromBase64(envelope['data'], { atMost: EXPORT_FILE_MAX })
  if (!salt || !nonce || !check || !sealed || sealed.length < TAG_BYTES + LENGTH_BYTES) throw new ExportCryptoError('not-an-export', 'malformed envelope')
  return { params, salt, nonce, check, sealed }
}

/** Bounds an envelope without deriving a key: throws what `decryptExport` would throw first. The restore calls it before it asks for a passphrase. */
export function checkEnvelope(value: unknown): void {
  parseEnvelope(value)
}

/** What the passphrase is, once and for all: NFKC (the same letters typed on another keyboard or in another form give the same key), as UTF-8. */
function passphraseBytes(passphrase: string): Buffer {
  return Buffer.from(passphrase.normalize('NFKC'), 'utf8')
}

/** The passphrase is a text of at least `PASSPHRASE_MIN` characters (blank ones count: it is the user's secret, not ours to trim). */
export function checkPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFKC')].length < PASSPHRASE_MIN) throw new ExportCryptoError('weak-passphrase', 'passphrase too short')
  if (passphrase.length > PASSPHRASE_MAX) throw new ExportCryptoError('weak-passphrase', 'passphrase too long')
  return passphrase
}

export function deriveKeys(passphrase: string, salt: Buffer, params: ScryptParams): Promise<{ key: Buffer; macKey: Buffer }> {
  return new Promise((resolve, reject) => {
    // Node refuses a cost above `maxmem`: the room asked for is the one the parameters need (already bounded), with a little to spare.
    const maxmem = 128 * params.N * params.r + 128 * params.r * params.p + 4 * 1024 * 1024
    scrypt(passphraseBytes(passphrase), salt, KEY_BYTES * 2, { N: params.N, r: params.r, p: params.p, maxmem }, (error, derived) => {
      if (error) return reject(error)
      resolve({ key: derived.subarray(0, KEY_BYTES), macKey: derived.subarray(KEY_BYTES) })
    })
  })
}

export const macOf = (macKey: Buffer, header: Buffer): Buffer => createHmac('sha256', macKey).update(header).digest()

/** The size a frame of `length` bytes is padded to. Never smaller than `length`, at most one eighth larger (or 4 KiB, if more). */
export function paddedLength(length: number): number {
  const step = Math.max(PAD_FLOOR, 2 ** (Math.floor(Math.log2(Math.max(length, 1))) - 3))
  return Math.ceil(length / step) * step
}

export function frame(plain: Buffer): Buffer {
  const out = Buffer.alloc(paddedLength(LENGTH_BYTES + plain.length))
  out.writeUInt32BE(plain.length, 0)
  plain.copy(out, LENGTH_BYTES)
  return out
}

export function unframe(framed: Buffer): Buffer {
  const length = framed.length >= LENGTH_BYTES ? framed.readUInt32BE(0) : Number.POSITIVE_INFINITY
  // The frame passed the authentication, so it is what this application wrote: a length that does not fit is a file made by hand.
  if (length > framed.length - LENGTH_BYTES || framed.length !== paddedLength(LENGTH_BYTES + length) || framed.subarray(LENGTH_BYTES + length).some((byte) => byte !== 0)) {
    throw new ExportCryptoError('tampered', 'bad frame')
  }
  return framed.subarray(LENGTH_BYTES, LENGTH_BYTES + length)
}

export interface EncryptOptions {
  /** Defaults to `SCRYPT_DEFAULT`; a test passes a cheaper one (it still has to be within the limits a file may ask for). */
  params?: ScryptParams
  /** Where the salt and the nonce come from; the tests of the nonce put their own. */
  random?: (bytes: number) => Buffer
}

/** The text of the encrypted file for `plain`. Throws `ExportCryptoError('weak-passphrase')` for a passphrase that is too short. */
export async function encryptExport(plain: string, passphrase: string, options: EncryptOptions = {}): Promise<string> {
  checkPassphrase(passphrase)
  const params = options.params ?? SCRYPT_DEFAULT
  if (!paramsAllowed(params)) throw new ExportCryptoError('too-costly', 'key derivation parameters out of bounds')
  const random = options.random ?? randomBytes
  // A new salt and a new nonce for every file: a key is never used for two files, and a nonce is never used twice under a key.
  const salt = random(SALT_BYTES)
  const nonce = random(NONCE_BYTES)
  const header = headerBytes(params, salt, nonce)
  const { key, macKey } = await deriveKeys(passphrase, salt, params)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(frame(Buffer.from(plain, 'utf8'))), cipher.final()])
  const envelope: ExportEnvelope = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    kdf: { name: 'scrypt', ...params, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', nonce: nonce.toString('base64') },
    check: macOf(macKey, header).toString('base64'),
    data: Buffer.concat([body, cipher.getAuthTag()]).toString('base64')
  }
  return `${JSON.stringify(envelope)}\n`
}

/**
 * The JSON text inside an encrypted export (an already parsed file). Throws `ExportCryptoError`: `too-costly` before anything is derived,
 * `wrong-passphrase` when the passphrase (or the header) is not the one the file was made with, `tampered` when the content was changed.
 */
export async function decryptExport(value: unknown, passphrase: string): Promise<string> {
  const { params, salt, nonce, check, sealed } = parseEnvelope(value)
  const header = headerBytes(params, salt, nonce)
  const { key, macKey } = await deriveKeys(typeof passphrase === 'string' ? passphrase : '', salt, params)
  const expected = macOf(macKey, header)
  if (expected.length !== check.length || !timingSafeEqual(expected, check)) throw new ExportCryptoError('wrong-passphrase', 'check mismatch')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  decipher.setAAD(header)
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  let framed: Buffer
  try {
    framed = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()])
  } catch {
    throw new ExportCryptoError('tampered', 'authentication failed')
  }
  return unframe(framed).toString('utf8')
}
