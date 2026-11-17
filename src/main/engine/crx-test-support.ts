// Builds small extension packages (CRX3: header + ZIP) for the tests and for the engine check that serves a fake store. A package is
// signed the way Chromium signs one (a proof per key over "CRX3 SignedData\0" + length + signed data + archive), with throw-away keys,
// since crx-scan.ts refuses one that is not; `crxOf` with a header of its own builds an envelope as given, signed or not.

import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
// The checksum the ZIP format carries for each file (the library that unpacks verifies it) is the one the export of a page writes.
import { crc32 } from '@shared/zip'

export interface TestEntry {
  name: string
  data: Buffer | string
  /** 0 stores, 8 deflates (default). */
  method?: 0 | 8
  flags?: number
  /** Written in the directory instead of the real sizes, to forge a bomb. */
  claimedSize?: number
}

function field(value: number, bytes: 2 | 4): Buffer {
  const out = Buffer.alloc(bytes)
  if (bytes === 2) out.writeUInt16LE(value)
  else out.writeUInt32LE(value >>> 0)
  return out
}

export function zipOf(entries: TestEntry[]): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const raw = Buffer.from(entry.data)
    const method = entry.method ?? 8
    const packed = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(entry.name)
    const flags = entry.flags ?? 0
    const crc = crc32(raw)
    const local = Buffer.concat([field(0x04034b50, 4), field(20, 2), field(flags, 2), field(method, 2), field(0, 2), field(0, 2), field(crc, 4), field(packed.length, 4), field(raw.length, 4), field(name.length, 2), field(0, 2), name])
    directory.push(
      Buffer.concat([field(0x02014b50, 4), field(20, 2), field(20, 2), field(flags, 2), field(method, 2), field(0, 2), field(0, 2), field(crc, 4), field(packed.length, 4), field(entry.claimedSize ?? raw.length, 4), field(name.length, 2), field(0, 2), field(0, 2), field(0, 2), field(0, 2), field(0, 4), field(offset, 4), name])
    )
    parts.push(local, packed)
    offset += local.length + packed.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.concat([field(0x06054b50, 4), field(0, 2), field(0, 2), field(entries.length, 2), field(entries.length, 2), field(central.length, 4), field(offset, 4), field(0, 2)])
  return Buffer.concat([...parts, central, end])
}

/** The id Chromium gives an extension: sixteen bytes of the SHA-256 of its public key, with 0-f written a-p. */
export function extensionIdOfKey(publicKeyDer: Buffer): string {
  return [...createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32)].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('')
}

/**
 * A CRX3 envelope around an archive. Without a `header` the package is signed by a throw-away key (the same one every time); with one,
 * the envelope is built as given: `header` is the protobuf block.
 */
export function crxOf(zip: Buffer, header?: Buffer): Buffer {
  const block = header ?? signedHeaderFor(zip, [defaultTestKey(), testPublisherKey()])
  return Buffer.concat([Buffer.from('Cr24'), field(3, 4), field(block.length, 4), block, zip])
}

function varint(value: number): Buffer {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

const delimited = (field: number, payload: Buffer): Buffer => Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload])

/** The protobuf header of a CRX3 that declares `extensionId` (32 letters a-p) in its signed data, as Chromium writes it. */
export function crxHeaderFor(extensionId: string): Buffer {
  const crxId = Buffer.from([...extensionId].map((c) => c.charCodeAt(0) - 97).reduce<string>((hex, digit) => hex + digit.toString(16), ''), 'hex')
  // A key proof first, as real packages have: the reader must walk past what it does not need.
  return Buffer.concat([delimited(2, Buffer.from('proof-of-a-key')), delimited(10000, delimited(1, crxId))])
}

const signingKeys = new Map<string, { privateKey: KeyObject; kind: 'rsa' | 'ec' }>()

/** A public key (DER) to give a test extension an id of its own; the same key for every version of that extension. Its private half stays here, to sign with. */
export function newTestKey(kind: 'rsa' | 'ec' = 'rsa'): Buffer {
  const pair = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 1024 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' })
  signingKeys.set(publicKey.toString('base64'), { privateKey: pair.privateKey, kind })
  return publicKey
}

let sharedKey: Buffer | null = null
const defaultTestKey = (): Buffer => (sharedKey ??= newTestKey())

let publisherKey: Buffer | null = null
/**
 * The key the fake store of the tests publishes with, in the place of the Chrome Web Store's (elliptic, like the store's): `crxOf` and `packageOf`
 * add its proof to every package, and a test that wants the store's rule hands `testPublisherKeys()` to the scan.
 */
export const testPublisherKey = (): Buffer => (publisherKey ??= newTestKey('ec'))
/** The SHA-256 of the publisher key of the tests, as crx-scan.ts `publisherKeys` takes it. */
export const testPublisherKeys = (): ReadonlySet<string> => new Set([createHash('sha256').update(testPublisherKey()).digest('hex')])

/** What every CRX3 signature covers, before the archive. */
const signedPrefix = (signedData: Buffer): Buffer => Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), field(signedData.length, 4), signedData])

/**
 * The CRX3 header that vouches for `zip`: one proof per key given (RSA or elliptic, by the kind `newTestKey` made it), and the signed
 * data that names `crxId` (by default the id of the first key).
 */
export function signedHeaderFor(zip: Buffer, keys: Buffer[], options: { crxId?: Buffer } = {}): Buffer {
  const crxId = options.crxId ?? createHash('sha256').update(keys[0]!).digest().subarray(0, 16)
  const signedData = delimited(1, crxId)
  const proofs = keys.map((key) => {
    const entry = signingKeys.get(key.toString('base64'))
    if (!entry) throw new Error('this key was not made by newTestKey')
    const signature = createSign('sha256').update(signedPrefix(signedData)).update(zip).sign(entry.privateKey)
    return delimited(entry.kind === 'rsa' ? 2 : 3, Buffer.concat([delimited(1, key), delimited(2, signature)]))
  })
  return Buffer.concat([...proofs, delimited(10000, signedData)])
}

/**
 * A package as the store serves one: a CRX3 header that carries the signature of the key and names its id, and the proof of the publisher of the
 * tests (`testPublisherKey`; `published: false` leaves it out, as on a package the store never published), then the archive.
 */
export function packageOf(options: { key: Buffer; manifest: Record<string, unknown>; files?: TestEntry[]; published?: boolean }): { id: string; crx: Buffer } {
  const id = extensionIdOfKey(options.key)
  const zip = zipOf([{ name: 'manifest.json', data: JSON.stringify(options.manifest) }, ...(options.files ?? [])])
  const keys = options.published === false ? [options.key] : [options.key, testPublisherKey()]
  return { id, crx: crxOf(zip, signedHeaderFor(zip, keys, { crxId: createHash('sha256').update(options.key).digest().subarray(0, 16) })) }
}
