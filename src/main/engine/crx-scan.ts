// Looks inside a downloaded extension package (a CRX3 file: a header, then a ZIP archive) before anything is unpacked. The library that
// installs from the Chrome Web Store hands the whole archive to a ZIP reader with no limit on size, entry count or path, and the
// archive comes from a network answer. This reads only the table of contents (and the manifest, with a bound on its size), refuses what
// no honest package looks like, checks the signatures of the header (the library only compares the hash of a key with the id asked for,
// so the archive itself was vouched for by nothing but the TLS connection), and reports the manifest so that the permissions of an update
// can be compared before it is applied.
// Pure Node (zlib, crypto), no Electron: tested with synthetic archives.

import { createHash, createPublicKey, createVerify } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

/** Largest package accepted. The biggest honest extensions are a few tens of megabytes. */
export const CRX_MAX_BYTES = 128 * 1024 * 1024
export const ZIP_MAX_ENTRIES = 20_000
export const ZIP_MAX_UNPACKED_BYTES = 512 * 1024 * 1024
const ZIP_MAX_ENTRY_BYTES = 256 * 1024 * 1024
export const MANIFEST_MAX_BYTES = 1024 * 1024
const CRX_HEADER_MAX = 1024 * 1024
/** A file that unpacks to more than this, from less than a thousandth of that, is a decompression bomb. */
const BOMB_RATIO = 1000
const BOMB_MIN_BYTES = 16 * 1024 * 1024

export type CrxRejection = 'too-big' | 'not-crx' | 'unsupported' | 'corrupt' | 'unsafe-path' | 'duplicate' | 'bomb' | 'no-manifest' | 'bad-manifest' | 'unsigned' | 'bad-signature' | 'not-from-store'

/**
 * The key the Chrome Web Store signs every package it serves with: the SHA-256 of its DER public key ("ecdsa_2017_public"), as Chromium writes it
 * (`kPublisherKeyHash`, components/crx_file/crx_verifier.cc). Chromium installs and updates nothing from the store without a valid proof by this
 * key; the key of the extension alone only says that the package is the one its owner signed, not that the store published it.
 */
export const STORE_PUBLISHER_KEY_SHA256 = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf' // gitleaks:allow (the published hash of the store's public key, not a secret)

export interface CrxScanOptions {
  /**
   * The SHA-256 (hex) of the keys one of which must have signed the package, beside the key of the extension: the store's publisher key for a
   * package of the store (`STORE_PUBLISHER_KEY_SHA256`). Absent: no such proof is asked (a package Lucium made itself, see crx-pack.ts).
   */
  publisherKeys?: ReadonlySet<string>
}

export class CrxRejected extends Error {
  constructor(
    readonly code: CrxRejection,
    message: string
  ) {
    super(message)
    this.name = 'CrxRejected'
  }
}

export interface CrxScan {
  /** The id the package declares in its signed header (32 letters from a to p); one of the keys that signed the package has this id. */
  extensionId: string
  manifest: unknown
  entries: number
  unpackedBytes: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

// Looser than the writer's (shared/zip.ts) on purpose: a package holds folder entries ("images/") and names that a writer of ours never makes.
/** A path inside the archive that stays inside the folder it is unpacked to, on every file system (Windows separators and drives included). */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  return !name.split('/').some((part) => part === '..')
}

function readVarint(buffer: Buffer, from: number): { value: number; next: number } {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = buffer[from + i]
    if (byte === undefined) break
    value += (byte & 0x7f) * 2 ** (7 * i)
    if ((byte & 0x80) === 0) return { value, next: from + i + 1 }
  }
  throw new CrxRejected('corrupt', 'the package header is damaged')
}

/** Every length-delimited field of a protobuf message, in order (a field may repeat). Anything else in the message is skipped. */
function lengthDelimitedFields(message: Buffer): Array<[number, Buffer]> {
  const fields: Array<[number, Buffer]> = []
  let at = 0
  while (at < message.length) {
    const tag = readVarint(message, at)
    at = tag.next
    const wire = tag.value & 7
    const field = Math.floor(tag.value / 8)
    if (wire === 2) {
      const length = readVarint(message, at)
      if (length.next + length.value > message.length) throw new CrxRejected('corrupt', 'the package header is damaged')
      fields.push([field, message.subarray(length.next, length.next + length.value)])
      at = length.next + length.value
    } else if (wire === 0) at = readVarint(message, at).next
    else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else throw new CrxRejected('corrupt', 'the package header is damaged')
  }
  return fields
}

/** The length-delimited fields of a protobuf message, by number (the first one when a field repeats). */
function lengthDelimited(message: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>()
  for (const [field, value] of lengthDelimitedFields(message)) if (!fields.has(field)) fields.set(field, value)
  return fields
}

/** The 16 bytes of an extension id written with the letters a to p, as Chromium writes them. */
const idOfBytes = (bytes: Buffer): string => [...bytes.toString('hex')].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('')

/** The extension id in the signed part of a CRX3 header (`signed_header_data.crx_id`, 16 bytes), written with the letters a to p. */
export function extensionIdOfHeader(header: Buffer): string | undefined {
  const signed = lengthDelimited(header).get(10000)
  const crxId = signed ? lengthDelimited(signed).get(1) : undefined
  if (!crxId || crxId.length !== 16) return undefined
  return idOfBytes(crxId)
}

/** CRX3 header fields: the proofs signed with an RSA key, the proofs signed with an elliptic key, and the signed data (`crx_id`). */
const FIELD_RSA_PROOF = 2
const FIELD_ECDSA_PROOF = 3
const FIELD_SIGNED_DATA = 10000
const PROOFS_MAX = 8
/** What every CRX3 signature covers: this context, the length of the signed data, the signed data, then the archive. */
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'latin1')

/**
 * Checks the signatures of a CRX3 header against the archive, as Chromium does: every proof (`sha256_with_rsa`, `sha256_with_ecdsa`)
 * must verify over `"CRX3 SignedData\0" + length + signed header data + archive`, and the id the package declares must be the id of one
 * of the keys that signed (the first 16 bytes of the SHA-256 of its public key). So the archive is the one the owner of that key
 * signed, whatever route it took to get here. Returns that id; throws `CrxRejected` otherwise.
 */
function verifySignatures(header: Buffer, zip: Buffer, declaredId: string | undefined, publisherKeys?: ReadonlySet<string>): string {
  const fields = lengthDelimitedFields(header)
  const signedData = fields.find(([field]) => field === FIELD_SIGNED_DATA)?.[1]
  const proofs = fields.filter(([field]) => field === FIELD_RSA_PROOF || field === FIELD_ECDSA_PROOF)
  if (!signedData || declaredId === undefined || proofs.length === 0) throw new CrxRejected('unsigned', 'the package carries no signature of its extension')
  if (proofs.length > PROOFS_MAX) throw new CrxRejected('bad-signature', 'the package carries too many signatures')
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  let vouched = false
  let published = false
  for (const [field, proof] of proofs) {
    const parts = lengthDelimited(proof)
    const publicKey = parts.get(1)
    const signature = parts.get(2)
    if (!publicKey || !signature) throw new CrxRejected('bad-signature', 'a signature of the package is incomplete')
    let valid = false
    try {
      const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
      if (key.asymmetricKeyType !== (field === FIELD_RSA_PROOF ? 'rsa' : 'ec')) throw new Error('the key is not of the kind of its signature')
      valid = createVerify('sha256').update(SIGNATURE_CONTEXT).update(size).update(signedData).update(zip).verify(key, signature)
    } catch (error) {
      throw new CrxRejected('bad-signature', `a signature of the package cannot be checked: ${(error as Error).message}`)
    }
    if (!valid) throw new CrxRejected('bad-signature', 'a signature of the package does not match its content')
    const keyHash = createHash('sha256').update(publicKey).digest()
    if (idOfBytes(keyHash.subarray(0, 16)) === declaredId) vouched = true
    // Every proof has been checked against the archive above: a proof by the publisher's key counts only once it holds.
    if (publisherKeys?.has(keyHash.toString('hex')) === true) published = true
  }
  if (!vouched) throw new CrxRejected('bad-signature', 'no signature of the package comes from the key of the extension it declares')
  if (publisherKeys !== undefined && !published) throw new CrxRejected('not-from-store', 'the package does not carry the signature of the Chrome Web Store')
  return declaredId
}

function eocdOffset(zip: Buffer): number {
  const floor = Math.max(0, zip.length - 22 - 0xffff)
  for (let at = zip.length - 22; at >= floor; at--) {
    if (zip.readUInt32LE(at) === EOCD) return at
  }
  throw new CrxRejected('corrupt', 'the archive has no end-of-directory record')
}

/** Throws `CrxRejected` for anything that is not a plain, bounded CRX3 package with a readable Manifest. */
export function scanCrx(buffer: Buffer, options: CrxScanOptions = {}): CrxScan {
  if (buffer.length > CRX_MAX_BYTES) throw new CrxRejected('too-big', `the package is larger than ${CRX_MAX_BYTES} bytes`)
  if (buffer.length < 16 || buffer.toString('latin1', 0, 4) !== 'Cr24') throw new CrxRejected('not-crx', 'not an extension package')
  if (buffer.readUInt32LE(4) !== 3) throw new CrxRejected('unsupported', 'only CRX3 packages are accepted')
  const headerSize = buffer.readUInt32LE(8)
  // A header that runs past the end of the file leaves no archive: the search for its directory below fails.
  if (headerSize > CRX_HEADER_MAX) throw new CrxRejected('corrupt', 'the package header is larger than any real one')
  const header = buffer.subarray(12, 12 + headerSize)
  const zip = buffer.subarray(12 + headerSize)
  const extensionId = extensionIdOfHeader(header)

  const end = eocdOffset(zip)
  const disk = zip.readUInt16LE(end + 4)
  const total = zip.readUInt16LE(end + 10)
  const directorySize = zip.readUInt32LE(end + 12)
  const directoryAt = zip.readUInt32LE(end + 16)
  if (disk !== 0 || total === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) throw new CrxRejected('unsupported', 'multi-part and ZIP64 archives are not accepted')
  if (total > ZIP_MAX_ENTRIES) throw new CrxRejected('bomb', `the archive lists ${total} files`)
  if (directoryAt + directorySize > end) throw new CrxRejected('corrupt', 'the archive directory is out of bounds')

  const seen = new Set<string>()
  let unpacked = 0
  let manifestEntry: { method: number; packed: number; size: number; localAt: number } | null = null
  let at = directoryAt
  for (let i = 0; i < total; i++) {
    if (at + 46 > directoryAt + directorySize || zip.readUInt32LE(at) !== CENTRAL) throw new CrxRejected('corrupt', 'the archive directory is damaged')
    const flags = zip.readUInt16LE(at + 8)
    const method = zip.readUInt16LE(at + 10)
    const packed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    const localAt = zip.readUInt32LE(at + 42)
    if (next > directoryAt + directorySize) throw new CrxRejected('corrupt', 'the archive directory is damaged')
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    if (!isSafeEntryName(name)) throw new CrxRejected('unsafe-path', 'the archive holds a path that leaves its folder')
    // File systems of the Mac do not tell `Manifest.json` from `manifest.json`: two entries that fold to one name could replace each other.
    const folded = name.toLowerCase()
    if (seen.has(folded)) throw new CrxRejected('duplicate', 'the archive holds the same path twice')
    seen.add(folded)
    if (flags & 1) throw new CrxRejected('unsupported', 'the archive is encrypted')
    if (method !== 0 && method !== 8) throw new CrxRejected('unsupported', `compression method ${method} is not accepted`)
    // An empty deflate stream is two bytes: a file that says it unpacks to nothing from more than that has a size that is a lie, and the
    // reader that unpacks it later trusts nothing else to bound the inflation.
    if (size === 0 && packed > 2) throw new CrxRejected('bomb', 'a file of the archive declares no content but holds data')
    if (size > ZIP_MAX_ENTRY_BYTES) throw new CrxRejected('bomb', 'a file of the archive is too large')
    if (size > BOMB_MIN_BYTES && size / Math.max(1, packed) > BOMB_RATIO) throw new CrxRejected('bomb', 'a file of the archive unpacks to a thousand times its size')
    unpacked += size
    if (unpacked > ZIP_MAX_UNPACKED_BYTES) throw new CrxRejected('bomb', 'the archive unpacks to too much data')
    if (name === 'manifest.json') manifestEntry = { method, packed, size, localAt }
    at = next
  }
  if (!manifestEntry) throw new CrxRejected('no-manifest', 'the package has no manifest.json at its root')
  if (manifestEntry.size > MANIFEST_MAX_BYTES) throw new CrxRejected('bad-manifest', 'the manifest is larger than 1 MiB')

  const local = manifestEntry.localAt
  if (local + 30 > directoryAt || zip.readUInt32LE(local) !== LOCAL) throw new CrxRejected('corrupt', 'the manifest entry is out of bounds')
  const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
  if (dataAt + manifestEntry.packed > directoryAt) throw new CrxRejected('corrupt', 'the manifest data is out of bounds')
  const raw = zip.subarray(dataAt, dataAt + manifestEntry.packed)
  let text: string
  try {
    text = (manifestEntry.method === 8 ? inflateRawSync(raw, { maxOutputLength: MANIFEST_MAX_BYTES }) : raw).toString('utf8')
  } catch {
    throw new CrxRejected('bad-manifest', 'the manifest cannot be unpacked')
  }
  let manifest: unknown
  try {
    // A byte order mark is skipped by its code point, written out so that no editor can drop it.
    manifest = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  } catch {
    throw new CrxRejected('bad-manifest', 'the manifest is not valid JSON')
  }
  // Last, so that what the structure refuses is named for what it is; nothing of the package is handed on before it is vouched for.
  return { extensionId: verifySignatures(header, zip, extensionId, options.publisherKeys), manifest, entries: total, unpackedBytes: unpacked }
}
