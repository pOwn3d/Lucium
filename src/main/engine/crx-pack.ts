// Packs an extension folder into a CRX3 file (a header that carries the signature, then a ZIP archive), the format Chromium installs.
// The private key is made here, on this Mac (RSA 2048), and kept next to the package as `<name>.pem` with the owner's rights only: it never goes anywhere
// else, and a package made again from the same file keeps the same key, so the extension keeps the same id. What is written is checked by `scanCrx`
// (crx-scan.ts), the reader that vets the packages of the Web Store, in this module's test. Pure Node (crypto, zlib, fs), no Electron.

import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto'
import { chmod, lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { t } from '@shared/i18n'

/** The folder is refused beyond these: nobody packs a hundred thousand files by hand, and the archive is held in memory. */
export const PACK_MAX_FILES = 20_000
export const PACK_MAX_BYTES = 128 * 1024 * 1024
/** What the package must never hold: the private key that signs it, and the packages themselves; files that start with a dot (`.git`, `.DS_Store`) are left out too. */
const NEVER_PACKED = new Set(['.pem', '.crx'])

export class PackError extends Error {}

const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2)
  out.writeUInt16LE(value)
  return out
}
const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value >>> 0)
  return out
}

/** The files to pack, as `[path inside the folder with slashes, absolute path]`, in a fixed order. Links are not followed: a link would carry a file from outside the folder into the package. */
export async function filesToPack(folder: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const names = (await readdir(dir)).sort()
    for (const name of names) {
      if (name.startsWith('.') || NEVER_PACKED.has(extname(name).toLowerCase())) continue
      const path = join(dir, name)
      // `lstat` does not follow a link: a link is neither a file nor a directory here, so it is left out.
      const info = await lstat(path)
      if (info.isDirectory()) await walk(path, `${prefix}${name}/`)
      else if (info.isFile()) {
        files.push([`${prefix}${name}`, path])
        if (files.length > PACK_MAX_FILES) throw new PackError(t('extpage.le-dossier-contient-trop-de-fichiers-pour-un-paquet'))
      }
    }
  }
  await walk(folder, '')
  return files
}

/** A ZIP archive of the entries (deflated; the checksum is the one the format carries and the readers verify). */
export function zipEntries(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const packed = deflateRawSync(data)
    const label = Buffer.from(name)
    const checksum = crc32(data)
    // Names are UTF-8 (bit 11 of the flags); times are left at the epoch of the format, so that two packings of the same folder give the same archive.
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(0x21), u32(checksum), u32(packed.length), u32(data.length), u16(label.length), u16(0), label])
    directory.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(0), u16(0x21), u32(checksum), u32(packed.length), u32(data.length), u16(label.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), label]))
    parts.push(local, packed)
    offset += local.length + packed.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)])
  return Buffer.concat([...parts, central, end])
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

/** A CRX3 package: `Cr24`, version 3, the header (the proof of the key, then the signed data that names the extension), then the archive. */
export function crx3Of(zip: Buffer, privateKeyPem: string): { crx: Buffer; publicKey: Buffer } {
  const privateKey = createPrivateKey(privateKeyPem)
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  // The id of the extension is the first sixteen bytes of the hash of the public key.
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16)
  const signedData = delimited(1, crxId)
  const signature = createSign('sha256').update(Buffer.from('CRX3 SignedData\0', 'latin1')).update(u32(signedData.length)).update(signedData).update(zip).sign(privateKey)
  const header = Buffer.concat([delimited(2, Buffer.concat([delimited(1, publicKey), delimited(2, signature)])), delimited(10000, signedData)])
  return { crx: Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, zip]), publicKey }
}

/** The key next to the package: the one from an earlier packing when the file is there, else a new one written with the owner's rights only. */
async function keyFor(keyPath: string): Promise<{ pem: string; created: boolean }> {
  try {
    return { pem: await readFile(keyPath, 'utf8'), created: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PackError(t('extpage.la-cle-privee-key-ne-peut-pas-etre-lue-message', { key: basename(keyPath), message: (error as Error).message }))
  }
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  // `wx`: never over a key that appeared in the meantime. The mode is set again after: the umask may have narrowed it, never widened.
  await writeFile(keyPath, pem, { mode: 0o600, flag: 'wx' })
  await chmod(keyPath, 0o600)
  return { pem, created: true }
}

/** Packs `folder` into `crxPath` (written aside and moved in place), with the key `<crxPath without .crx>.pem`. Rejects with a `PackError` that has a sentence for the person. */
export async function packExtensionFolder(folder: string, crxPath: string): Promise<{ crx: string; key: string; newKey: boolean }> {
  const files = await filesToPack(folder)
  const entries: Array<{ name: string; data: Buffer }> = []
  let total = 0
  for (const [name, path] of files) {
    const data = await readFile(path)
    total += data.length
    if (total > PACK_MAX_BYTES) throw new PackError(t('extpage.le-dossier-est-trop-gros-pour-un-paquet'))
    entries.push({ name, data })
  }
  if (!entries.some((entry) => entry.name === 'manifest.json')) throw new PackError(t('extpage.le-dossier-ne-contient-pas-de-manifest-json-lisible'))
  const target = extname(crxPath).toLowerCase() === '.crx' ? crxPath : `${crxPath}.crx`
  const keyPath = join(dirname(target), `${basename(target, extname(target))}.pem`)
  const key = await keyFor(keyPath)
  const { crx } = crx3Of(zipEntries(entries), key.pem)
  const aside = `${target}.tmp`
  await writeFile(aside, crx)
  await rename(aside, target)
  return { crx: target, key: keyPath, newKey: key.created }
}
