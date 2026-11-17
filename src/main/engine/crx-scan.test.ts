import { describe, expect, it } from 'vitest'
import { CRX_MAX_BYTES, CrxRejected, MANIFEST_MAX_BYTES, ZIP_MAX_ENTRIES, extensionIdOfHeader, isSafeEntryName, scanCrx, type CrxRejection } from './crx-scan'
import { crxHeaderFor, crxOf, extensionIdOfKey, newTestKey, signedHeaderFor, zipOf, type TestEntry } from './crx-test-support'
import { createHash } from 'node:crypto'

const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'Exemple', version: '1.0', permissions: ['storage'] })
const good = (extra: TestEntry[] = []) => crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }, { name: 'background.js', data: 'console.log(1)' }, ...extra]))

function rejection(buffer: Buffer): CrxRejection | null {
  try {
    scanCrx(buffer)
    return null
  } catch (error) {
    if (error instanceof CrxRejected) return error.code
    throw error
  }
}

describe('scanCrx', () => {
  it('reads the manifest and the size of a plain package, deflated or stored', () => {
    for (const method of [8, 0] as const) {
      const scan = scanCrx(crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST, method }, { name: '_locales/fr/messages.json', data: '{}' }])))
      expect(scan.manifest).toMatchObject({ name: 'Exemple', permissions: ['storage'] })
      expect(scan.entries).toBe(2)
      expect(scan.unpackedBytes).toBe(MANIFEST.length + 2)
    }
  })

  it('reads a manifest that starts with a byte order mark', () => {
    expect(scanCrx(crxOf(zipOf([{ name: 'manifest.json', data: `\uFEFF${MANIFEST}` }]))).manifest).toMatchObject({ version: '1.0' })
  })

  it('refuses what is not a CRX3 package', () => {
    expect(rejection(Buffer.from('<html>404</html>'))).toBe('not-crx')
    expect(rejection(Buffer.alloc(0))).toBe('not-crx')
    const v2 = good()
    v2.writeUInt32LE(2, 4)
    expect(rejection(v2)).toBe('unsupported')
    const header = good()
    header.writeUInt32LE(0x7fffffff, 8)
    expect(rejection(header)).toBe('corrupt')
  })

  it('refuses a package larger than the limit before it reads anything', () => {
    expect(rejection(Buffer.alloc(CRX_MAX_BYTES + 1))).toBe('too-big')
  })

  it('refuses an archive cut short or with a damaged directory', () => {
    const whole = good()
    expect(rejection(whole.subarray(0, whole.length - 30))).toBe('corrupt')
    const damaged = Buffer.from(whole)
    // The signature of the first directory entry.
    damaged.writeUInt32LE(0, damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])))
    expect(rejection(damaged)).toBe('corrupt')
  })

  it('refuses, as a damaged package, an archive too short to hold its last record (22 bytes), whatever is left of it', () => {
    const whole = good()
    const archiveAt = 12 + whole.readUInt32LE(8)
    for (const left of [0, 1, 3, 4, 21]) expect(rejection(whole.subarray(0, archiveAt + left)), `${left} bytes`).toBe('corrupt')
    // The same with nothing but the sixteen bytes a package must have, the last record's signature among them.
    const bare = Buffer.alloc(16)
    bare.write('Cr24', 0, 'latin1')
    bare.writeUInt32LE(3, 4)
    bare.writeUInt32LE(0x06054b50, 12)
    expect(rejection(bare)).toBe('corrupt')
  })

  it('refuses a path that leaves the folder it is unpacked to, whatever the separator', () => {
    for (const name of ['../evil.js', 'a/../../evil.js', '/etc/passwd', 'a\\..\\evil.js', 'C:evil.js', 'c:/evil.js']) {
      expect(rejection(good([{ name, data: 'x' }])), name).toBe('unsafe-path')
    }
    expect(isSafeEntryName('images/icon-128.png')).toBe(true)
    expect(isSafeEntryName('..hidden/file')).toBe(true)
    expect(isSafeEntryName('')).toBe(false)
    expect(isSafeEntryName('a\0b')).toBe(false)
  })

  it('refuses two entries with the same path, even when only the case tells them apart (the Mac does not)', () => {
    expect(rejection(good([{ name: 'background.js', data: 'second' }]))).toBe('duplicate')
    expect(rejection(good([{ name: 'Manifest.JSON', data: '{"manifest_version":3,"name":"Autre","version":"9"}' }]))).toBe('duplicate')
  })

  it('refuses an encrypted archive and a compression it does not know', () => {
    expect(rejection(crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST, flags: 1 }])))).toBe('unsupported')
    const odd = crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }]))
    const directory = odd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    odd.writeUInt16LE(14, directory + 10)
    expect(rejection(odd)).toBe('unsupported')
  })

  it('refuses a decompression bomb however it is declared: one huge file, a huge ratio, a huge total, too many files', () => {
    expect(rejection(good([{ name: 'big.bin', data: 'x', claimedSize: 300 * 1024 * 1024 }]))).toBe('bomb')
    expect(rejection(good([{ name: 'ratio.bin', data: 'x', claimedSize: 100 * 1024 * 1024 }]))).toBe('bomb')
    // Each file is under the size that triggers the ratio test; only the sum (40 x 15 MiB) is over the limit.
    const sum = Array.from({ length: 40 }, (_, i) => ({ name: `part${i}.bin`, data: 'x', claimedSize: 15 * 1024 * 1024 }))
    expect(rejection(good(sum.slice(0, 20)))).toBeNull()
    expect(rejection(good(sum))).toBe('bomb')
    expect(rejection(crxOf(zipOf(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: '', method: 0 as const })))))).toBe('bomb')
  })

  it('refuses a package with no manifest at its root, an unreadable one and one that unpacks to more than the limit', () => {
    expect(rejection(crxOf(zipOf([{ name: 'sub/manifest.json', data: MANIFEST }])))).toBe('no-manifest')
    expect(rejection(crxOf(zipOf([{ name: 'manifest.json', data: '{ not json' }])))).toBe('bad-manifest')
    // A few kilobytes that unpack to a manifest larger than the limit: the bound stops the inflation.
    const huge = crxOf(zipOf([{ name: 'manifest.json', data: Buffer.alloc(MANIFEST_MAX_BYTES + 10, 0x20) }]))
    expect(huge.length).toBeLessThan(10_000)
    expect(rejection(huge)).toBe('bad-manifest')
  })

  it('does not trust the sizes in the directory for the manifest it inflates', () => {
    // The directory claims a small manifest, the data inflates to far more, and it is valid JSON: only the bound of the inflation stops it.
    const padded = JSON.stringify({ manifest_version: 3, name: 'Gros', version: '1', pad: ' '.repeat(MANIFEST_MAX_BYTES * 4) })
    expect(rejection(crxOf(zipOf([{ name: 'manifest.json', data: padded, claimedSize: 100 }])))).toBe('bad-manifest')
    // The directory claims a manifest larger than the limit: refused on the claim, although the data itself is small.
    expect(rejection(crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST, claimedSize: MANIFEST_MAX_BYTES + 1 }])))).toBe('bad-manifest')
  })

  /** The package with one field of the archive overwritten: `where` is relative to the signature found, `value` is written as 16 or 32 bits. */
  function forged(signature: number[], offset: number, value: number, bits: 16 | 32, entries?: TestEntry[]): Buffer {
    const crx = Buffer.from(entries ? crxOf(zipOf(entries)) : good())
    const at = crx.indexOf(Buffer.from(signature)) + offset
    if (bits === 16) crx.writeUInt16LE(value, at)
    else crx.writeUInt32LE(value, at)
    return crx
  }
  const EOCD = [0x50, 0x4b, 0x05, 0x06]
  const CENTRAL = [0x50, 0x4b, 0x01, 0x02]

  it('refuses multi-part and ZIP64 archives, each marker on its own', () => {
    expect(rejection(forged(EOCD, 4, 1, 16))).toBe('unsupported')
    expect(rejection(forged(EOCD, 10, 0xffff, 16))).toBe('unsupported')
    expect(rejection(forged(EOCD, 12, 0xffffffff, 32))).toBe('unsupported')
    expect(rejection(forged(EOCD, 16, 0xffffffff, 32))).toBe('unsupported')
  })

  it('refuses a directory that runs past the end of the archive, an entry that points outside it, and a size that does not fit', () => {
    const crx = good()
    const realSize = crx.readUInt32LE(crx.indexOf(Buffer.from(EOCD)) + 12)
    expect(rejection(forged(EOCD, 12, realSize + 1000, 32))).toBe('corrupt')
    // The manifest entry is the first of the directory: its local header offset, then its packed size.
    expect(rejection(forged(CENTRAL, 42, 0x7fffff00, 32))).toBe('corrupt')
    expect(rejection(forged(CENTRAL, 42, 3, 32))).toBe('corrupt')
    expect(rejection(forged(CENTRAL, 20, 0x00ffffff, 32))).toBe('corrupt')
  })

  it('refuses an entry whose local header is not one, even when its sizes would fit inside the archive', () => {
    const crx = good([{ name: 'pad.bin', data: Buffer.alloc(300), method: 0 }])
    // The packed data of pad.bin is a run of zeros: pointing the manifest there gives a "header" with no signature, no name and no extra field.
    const zipStart = 12 + 8
    const offset = crx.indexOf(Buffer.alloc(300)) - zipStart + 10
    crx.writeUInt32LE(offset, crx.indexOf(Buffer.from(CENTRAL)) + 42)
    expect(rejection(crx)).toBe('corrupt')
  })

  it('refuses a file that unpacks to more than one file may, although its ratio and the total are fine', () => {
    // 400 KB stored, claimed at 300 MiB: a ratio of 750 (under the limit) and a total under the limit; only the size of the one file is over.
    const filler = Buffer.alloc(400 * 1024, 7)
    expect(rejection(good([{ name: 'big.bin', data: filler, method: 0, claimedSize: 300 * 1024 * 1024 }]))).toBe('bomb')
    expect(rejection(good([{ name: 'ok.bin', data: filler, method: 0, claimedSize: 200 * 1024 * 1024 }]))).toBeNull()
  })

  it('refuses a header larger than any real one, although the archive after it is fine', () => {
    const header = Buffer.alloc(1024 * 1024 + 2)
    expect(rejection(crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }]), header))).toBe('corrupt')
    // A header of exactly the largest size is read (and found to be no signature), not refused for its size.
    expect(rejection(crxOf(zipOf([{ name: 'manifest.json', data: MANIFEST }]), Buffer.alloc(1024 * 1024)))).toBe('unsigned')
  })

  it('reads the id the package declares in its signed header, and none when there is none', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    const zip = zipOf([{ name: 'manifest.json', data: MANIFEST }])
    expect(extensionIdOfHeader(crxHeaderFor(id))).toBe(id)
    const key = newTestKey()
    expect(scanCrx(crxOf(zip, signedHeaderFor(zip, [key]))).extensionId).toBe(extensionIdOfKey(key))
    expect(extensionIdOfHeader(Buffer.alloc(8))).toBeUndefined()
    expect(() => extensionIdOfHeader(Buffer.from([0x80]))).toThrow(CrxRejected)
    expect(extensionIdOfHeader(Buffer.alloc(0))).toBeUndefined()
    // An id that is not 16 bytes long is not an id.
    const shortId = Buffer.concat([Buffer.from([0x82, 0xf1, 0x04, 0x11, 0x0a, 0x0f]), Buffer.alloc(15, 1)])
    expect(extensionIdOfHeader(shortId)).toBeUndefined()
    // A header cut in the middle of a field is a damaged package, not a package without an id.
    const cut = crxHeaderFor(id).subarray(0, 30)
    expect(rejection(crxOf(zip, cut))).toBe('corrupt')
  })

  it('refuses an entry that says it unpacks to nothing and holds more than an empty stream does', () => {
    // 64 KiB of zeros deflate to a few dozen bytes: the directory says 0, the reader that unpacks it later would inflate all of it unbounded.
    expect(rejection(good([{ name: 'zero.bin', data: Buffer.alloc(64 * 1024), claimedSize: 0 }]))).toBe('bomb')
    expect(rejection(good([{ name: 'zero.bin', data: Buffer.alloc(10, 1), method: 0, claimedSize: 0 }]))).toBe('bomb')
    // An empty file is an empty stream (two bytes deflated, none stored), and passes.
    expect(rejection(good([{ name: 'empty.txt', data: '' }]))).toBeNull()
    expect(rejection(good([{ name: 'empty.txt', data: '', method: 0 }]))).toBeNull()
  })
})

describe('scanCrx: the signatures of the header', () => {
  /** The signed data that ends a header: the tag of field 10000 (3 bytes), its length (1), then the tag and length of the id (2) and the id (16). */
  const SIGNED_DATA_BYTES = 22
  const zip = zipOf([{ name: 'manifest.json', data: MANIFEST }, { name: 'background.js', data: Buffer.from('console.log(1)'), method: 0 }])
  const signedBy = (...keys: Buffer[]) => crxOf(zip, signedHeaderFor(zip, keys))

  it('accepts a package signed by the key of the id it declares, with an RSA key or an elliptic one, alone or next to a second proof', () => {
    const rsa = newTestKey()
    const elliptic = newTestKey('ec')
    const publisher = newTestKey()
    expect(scanCrx(signedBy(rsa)).extensionId).toBe(extensionIdOfKey(rsa))
    expect(scanCrx(signedBy(elliptic)).extensionId).toBe(extensionIdOfKey(elliptic))
    // The proof of the key the id comes from need not be the first.
    expect(scanCrx(crxOf(zip, signedHeaderFor(zip, [publisher, rsa], { crxId: createHash('sha256').update(rsa).digest().subarray(0, 16) }))).extensionId).toBe(extensionIdOfKey(rsa))
  })

  it('asks, when told to, for a valid proof of the publisher\'s key beside the extension\'s own, as Chromium does for the store', () => {
    const own = newTestKey()
    const publisher = newTestKey('ec')
    const keys = new Set([createHash('sha256').update(publisher).digest('hex')])
    const idOf = { crxId: createHash('sha256').update(own).digest().subarray(0, 16) }
    const published = crxOf(zip, signedHeaderFor(zip, [own, publisher], idOf))
    expect(scanCrx(published, { publisherKeys: keys }).extensionId).toBe(extensionIdOfKey(own))
    // Signed by its own key only, or by another key that is not the publisher's: not published.
    const unpublished = signedBy(own)
    expect(() => scanCrx(unpublished, { publisherKeys: keys })).toThrow(expect.objectContaining({ code: 'not-from-store' }))
    expect(() => scanCrx(crxOf(zip, signedHeaderFor(zip, [own, newTestKey('ec')], idOf)), { publisherKeys: keys })).toThrow(expect.objectContaining({ code: 'not-from-store' }))
    // Without the option, a package Lucium made itself (crx-pack.ts) needs no publisher.
    expect(scanCrx(unpublished).extensionId).toBe(extensionIdOfKey(own))
    // The publisher's proof counts only when it holds: one that does not match the archive refuses the package.
    const forged = Buffer.from(published)
    const at = forged.indexOf(Buffer.from('console.log(1)'))
    forged[at + 8] = forged[at + 8]! ^ 1
    expect(() => scanCrx(forged, { publisherKeys: keys })).toThrow(expect.objectContaining({ code: 'bad-signature' }))
  })

  it('refuses a package nobody signed, or whose header carries an id and no proof', () => {
    expect(rejection(crxOf(zip, Buffer.alloc(8)))).toBe('unsigned')
    expect(rejection(crxOf(zip, crxHeaderFor('abcdefghijklmnopabcdefghijklmnop').subarray(-SIGNED_DATA_BYTES)))).toBe('unsigned')
    // A "proof" that is not a proof (the id, and a field 2 full of rubbish) is no better.
    expect(rejection(crxOf(zip, crxHeaderFor('abcdefghijklmnopabcdefghijklmnop')))).toBe('corrupt')
    // Proofs without the signed data that names the id.
    const proofsOnly = signedHeaderFor(zip, [newTestKey()])
    expect(rejection(crxOf(zip, proofsOnly.subarray(0, proofsOnly.length - SIGNED_DATA_BYTES)))).toBe('unsigned')
  })

  it('refuses an archive that was changed after it was signed, in one byte of a file, with the structure intact', () => {
    const crx = signedBy(newTestKey())
    const at = crx.indexOf(Buffer.from('console.log(1)'))
    expect(at).toBeGreaterThan(0)
    const changed = Buffer.from(crx)
    changed[at + 12] = changed[at + 12]! ^ 1
    // Everything the scan reads is as before: only the signature knows.
    expect(scanCrx(crx).manifest).toMatchObject({ name: 'Exemple' })
    expect(rejection(changed)).toBe('bad-signature')
  })

  it('refuses a package signed for a different archive, however well formed it is', () => {
    const key = newTestKey()
    const other = zipOf([{ name: 'manifest.json', data: MANIFEST }, { name: 'background.js', data: 'fetch("https://evil.example")' }])
    expect(rejection(crxOf(other, signedHeaderFor(zip, [key])))).toBe('bad-signature')
  })

  it('refuses a package whose declared id is not the id of any key that signed it', () => {
    const signer = newTestKey()
    const someoneElse = newTestKey()
    const victim = createHash('sha256').update(someoneElse).digest().subarray(0, 16)
    expect(rejection(crxOf(zip, signedHeaderFor(zip, [signer], { crxId: victim })))).toBe('bad-signature')
  })

  it('refuses a package when any of its proofs is bad, even if another one is good', () => {
    const developer = newTestKey()
    const second = newTestKey()
    const header = signedHeaderFor(zip, [developer, second])
    // Flip a bit inside the signature of the second proof: the last bytes before the signed data are its signature.
    const forged = Buffer.from(header)
    forged[forged.length - SIGNED_DATA_BYTES - 1] = forged[forged.length - SIGNED_DATA_BYTES - 1]! ^ 1
    expect(rejection(crxOf(zip, header))).toBeNull()
    expect(rejection(crxOf(zip, forged))).toBe('bad-signature')
  })

  it('refuses a key of the wrong kind for its proof, a key that is not one, an incomplete proof and too many proofs', () => {
    const elliptic = newTestKey('ec')
    const good = signedHeaderFor(zip, [elliptic])
    // An elliptic key and its signature, filed as an RSA proof (field 2 instead of field 3).
    const mislabelled = Buffer.from(good)
    mislabelled[0] = 0x12
    expect(rejection(crxOf(zip, mislabelled))).toBe('bad-signature')
    // A public key that is not a key, and a proof with only a key.
    const signedData = good.subarray(good.length - SIGNED_DATA_BYTES)
    const rubbish = Buffer.concat([Buffer.from([0x12, 0x0b, 0x0a, 0x04]), Buffer.from('nope'), Buffer.from([0x12, 0x03]), Buffer.from('sig'), signedData])
    expect(rejection(crxOf(zip, rubbish))).toBe('bad-signature')
    const keyOnly = Buffer.concat([Buffer.from([0x12, 0x06, 0x0a, 0x04]), Buffer.from('nope'), signedData])
    expect(rejection(crxOf(zip, keyOnly))).toBe('bad-signature')
    const many = Array.from({ length: 9 }, () => newTestKey())
    expect(rejection(crxOf(zip, signedHeaderFor(zip, many)))).toBe('bad-signature')
    expect(rejection(crxOf(zip, signedHeaderFor(zip, many.slice(0, 8))))).toBeNull()
  })

  it('judges the structure of the archive first, so that a broken archive is named for what it is', () => {
    const crx = signedBy(newTestKey())
    expect(rejection(crx.subarray(0, crx.length - 30))).toBe('corrupt')
    expect(rejection(Buffer.concat([crx, Buffer.from('x')]))).not.toBeNull()
  })
})
