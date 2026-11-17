// The envelope of the password vault and of its encrypted export. Same construction as the encrypted export of the data (export-crypto.ts,
// whose primitives are used here: scrypt over the NFKC passphrase, a MAC of the header under the second half of the derived key, AES-256-GCM
// with the header as additional data, a frame padded to hide the length), with two differences that come from what the file is:
//  - its own `format` name per file kind, authenticated in the header, so that a vault, an export of passwords and an export of the data
//    cannot be taken for one another;
//  - the key outlives one call. The vault is saved at every change, and deriving a key costs a third of a second and 128 MiB: the key is
//    derived once, when the vault is created or opened, kept (in memory only, `zero` wipes it) and each save only draws a new nonce.
//    A nonce is never used twice under a key: 96 random bits, and a salt that changes with the phrase.
// A file is hostile input: the cost it asks for is bounded before any key is derived (`paramsAllowed`), every field is checked.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { ExportCryptoError, SCRYPT_DEFAULT, deriveKeys, frame, fromBase64, macOf, paramsAllowed, unframe, type ScryptParams } from './export-crypto'
import { t } from '@shared/i18n'
import { isRecord } from '@shared/record'

export const VAULT_FORMAT = 'lucium-passwords'
export const PASSWORD_EXPORT_FORMAT = 'lucium-passwords-export'
export type SealedFormat = typeof VAULT_FORMAT | typeof PASSWORD_EXPORT_FORMAT

export const SEALED_VERSION = 1
/** A vault of 5 000 logins is about 2 MiB; nothing near this is a vault. */
export const SEALED_FILE_MAX = 16 * 1024 * 1024

const SALT_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** The key of a sealed file: kept while the vault is open, wiped by `zeroKeys`. */
export interface SealKeys {
  key: Buffer
  macKey: Buffer
  salt: Buffer
  params: ScryptParams
}

export interface SealOptions {
  params?: ScryptParams
  /** Where the salt and the nonce come from; a test puts its own. */
  random?: (bytes: number) => Buffer
}

/** A key from a passphrase and a fresh salt: for a vault being created, a phrase being changed, an export being made. */
export async function newSealKeys(passphrase: string, options: SealOptions = {}): Promise<SealKeys> {
  const params = options.params ?? SCRYPT_DEFAULT
  if (!paramsAllowed(params)) throw new ExportCryptoError('too-costly', 'key derivation parameters out of bounds')
  const salt = (options.random ?? randomBytes)(SALT_BYTES)
  const { key, macKey } = await deriveKeys(passphrase, salt, params)
  return { key, macKey, salt, params }
}

/** The keys a sealed file's own salt and cost give for a passphrase. The cost was bounded by `parseSealed`. */
export async function sealKeysFor(passphrase: string, sealed: ParsedSealed): Promise<SealKeys> {
  const { key, macKey } = await deriveKeys(passphrase, sealed.salt, sealed.params)
  return { key, macKey, salt: sealed.salt, params: sealed.params }
}

/** Wipes the key material (the buffers are the ones the vault held; a second call does nothing). */
export function zeroKeys(keys: SealKeys): void {
  keys.key.fill(0)
  keys.macKey.fill(0)
}

/** The size of what the keychain keeps for a sealed file (Touch ID, vault-keychain.ts): the key, then the MAC key. */
export const KEY_MATERIAL_BYTES = KEY_BYTES * 2

/** The 64 bytes of a key, for the keychain. A copy: the caller wipes it once it has been handed over. */
export function keyMaterialOf(keys: SealKeys): Buffer {
  return Buffer.concat([keys.key, keys.macKey])
}

/** The keys of a parsed file from 64 bytes the keychain gave back, with the file's own salt and cost. Copies: the caller wipes `material`. */
export function sealKeysFromMaterial(material: Buffer, sealed: ParsedSealed): SealKeys {
  if (material.length !== KEY_MATERIAL_BYTES) throw new ExportCryptoError('wrong-passphrase', 'not a key of this size')
  return { key: Buffer.from(material.subarray(0, KEY_BYTES)), macKey: Buffer.from(material.subarray(KEY_BYTES)), salt: sealed.salt, params: sealed.params }
}

const headerBytes = (format: SealedFormat, params: ScryptParams, salt: Buffer, nonce: Buffer): Buffer =>
  Buffer.from(JSON.stringify([format, SEALED_VERSION, 'scrypt', params.N, params.r, params.p, salt.toString('base64'), 'aes-256-gcm', nonce.toString('base64')]), 'utf8')

/** The text of a sealed file for `plain`, with a new nonce. */
export function seal(format: SealedFormat, plain: string, keys: SealKeys, random: (bytes: number) => Buffer = randomBytes): string {
  const nonce = random(NONCE_BYTES)
  const header = headerBytes(format, keys.params, keys.salt, nonce)
  const cipher = createCipheriv('aes-256-gcm', keys.key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(frame(Buffer.from(plain, 'utf8'))), cipher.final()])
  const envelope = {
    format,
    version: SEALED_VERSION,
    kdf: { name: 'scrypt', ...keys.params, salt: keys.salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', nonce: nonce.toString('base64') },
    check: macOf(keys.macKey, header).toString('base64'),
    data: Buffer.concat([body, cipher.getAuthTag()]).toString('base64')
  }
  return `${JSON.stringify(envelope)}\n`
}

export interface ParsedSealed {
  format: SealedFormat
  params: ScryptParams
  salt: Buffer
  nonce: Buffer
  check: Buffer
  sealed: Buffer
}

/** Reads and bounds a sealed file's text; no key is derived. Throws `ExportCryptoError`: 'too-large', 'not-an-export', 'unsupported', 'too-costly'. */
export function parseSealed(format: SealedFormat, text: string): ParsedSealed {
  if (text.length > SEALED_FILE_MAX) throw new ExportCryptoError('too-large', 'file too large')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ExportCryptoError('not-an-export', 'not JSON')
  }
  if (!isRecord(value) || value['format'] !== format) throw new ExportCryptoError('not-an-export', 'wrong format')
  if (value['version'] !== SEALED_VERSION) throw new ExportCryptoError('unsupported', 'unsupported version')
  const kdf = value['kdf']
  const cipher = value['cipher']
  if (!isRecord(kdf) || !isRecord(cipher) || kdf['name'] !== 'scrypt' || cipher['name'] !== 'aes-256-gcm') throw new ExportCryptoError('unsupported', 'unsupported algorithms')
  const params: ScryptParams = { N: kdf['N'] as number, r: kdf['r'] as number, p: kdf['p'] as number }
  if (!paramsAllowed(params)) throw new ExportCryptoError('too-costly', 'key derivation parameters out of bounds')
  const salt = fromBase64(kdf['salt'], { exactly: SALT_BYTES })
  const nonce = fromBase64(cipher['nonce'], { exactly: NONCE_BYTES })
  const check = fromBase64(value['check'], { exactly: KEY_BYTES })
  const sealed = fromBase64(value['data'], { atMost: SEALED_FILE_MAX })
  if (!salt || !nonce || !check || !sealed || sealed.length < TAG_BYTES + 4) throw new ExportCryptoError('not-an-export', 'malformed envelope')
  return { format, params, salt, nonce, check, sealed }
}

/** The plain text inside a parsed file. Throws 'wrong-passphrase' when the keys are not the file's (or its header was changed), 'tampered' when the content was. */
export function openSealed(parsed: ParsedSealed, keys: SealKeys): string {
  const header = headerBytes(parsed.format, parsed.params, parsed.salt, parsed.nonce)
  const expected = macOf(keys.macKey, header)
  if (expected.length !== parsed.check.length || !timingSafeEqual(expected, parsed.check)) throw new ExportCryptoError('wrong-passphrase', 'check mismatch')
  const decipher = createDecipheriv('aes-256-gcm', keys.key, parsed.nonce, { authTagLength: TAG_BYTES })
  decipher.setAAD(header)
  decipher.setAuthTag(parsed.sealed.subarray(parsed.sealed.length - TAG_BYTES))
  let framed: Buffer
  try {
    framed = Buffer.concat([decipher.update(parsed.sealed.subarray(0, parsed.sealed.length - TAG_BYTES)), decipher.final()])
  } catch {
    throw new ExportCryptoError('tampered', 'authentication failed')
  }
  return unframe(framed).toString('utf8')
}

/** The sentence for a failure of the vault or of an export of passwords. Never holds the passphrase. */
export function vaultErrorMessage(error: unknown): string {
  if (!(error instanceof ExportCryptoError)) return t('vault-crypto.le-fichier-n-a-pas-pu-etre-lu')
  switch (error.kind) {
    case 'weak-passphrase':
      return t('vault-crypto.la-phrase-est-trop-courte')
    case 'not-an-export':
      return t('vault-crypto.ce-fichier-n-est-pas-un-fichier-de-mots-de')
    case 'unsupported':
      return t('vault-crypto.ce-fichier-a-ete-fait-par-une-version-d')
    case 'too-costly':
      return t('vault-crypto.calcul-de-cle-demesure')
    case 'wrong-passphrase':
      return t('vault-crypto.la-phrase-est-incorrecte-ou-l-en-tete-du')
    case 'tampered':
      return t('vault-crypto.fichier-altere')
    case 'too-large':
      return t('vault-crypto.ce-fichier-est-trop-volumineux-pour-etre-un')
  }
}
