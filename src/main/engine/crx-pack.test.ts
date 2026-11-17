import { createPrivateKey, createPublicKey, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACK_MAX_FILES, PackError, filesToPack, packExtensionFolder } from './crx-pack'
import { scanCrx } from './crx-scan'

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lucium-pack-'))
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

function extension(files: Record<string, string> = {}): string {
  const folder = join(work, 'ext')
  mkdirSync(folder, { recursive: true })
  const all = { 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Packed', version: '1.2.3' }), 'background.js': 'console.log(1)', 'sub/page.html': '<p>hi</p>', ...files }
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(join(folder, name, '..'), { recursive: true })
    writeFileSync(join(folder, name), text)
  }
  return folder
}

describe('packing a folder', () => {
  it('makes a CRX3 that the reader of the Web Store packages accepts: signature, id of the key and manifest', async () => {
    const folder = extension()
    const out = join(work, 'out', 'packed.crx')
    mkdirSync(join(work, 'out'))
    const made = await packExtensionFolder(folder, out)
    expect(made).toEqual({ crx: out, key: join(work, 'out', 'packed.pem'), newKey: true })
    const scan = scanCrx(readFileSync(out))
    expect(scan.manifest).toEqual({ manifest_version: 3, name: 'Packed', version: '1.2.3' })
    expect(scan.entries).toBe(3)
    // The id is the one of the key that was written next to the package.
    const publicKey = createPublicKey(createPrivateKey(readFileSync(made.key, 'utf8'))).export({ type: 'spki', format: 'der' })
    const expected = [...createHash('sha256').update(publicKey).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
    expect(scan.extensionId).toBe(expected)
  })

  it('keeps the key private: the owner alone can read it, and it is not in the package', async () => {
    const folder = extension({ 'old.pem': 'PRIVATE', 'earlier.crx': 'PACKAGE', '.git/config': 'x', '.DS_Store': 'x' })
    const made = await packExtensionFolder(folder, join(work, 'a.crx'))
    expect(statSync(made.key).mode & 0o777).toBe(0o600)
    const inside = readFileSync(made.crx).toString('latin1')
    for (const secret of ['PRIVATE', 'PACKAGE', 'BEGIN PRIVATE KEY']) expect(inside.includes(secret), secret).toBe(false)
    expect(scanCrx(readFileSync(made.crx)).entries).toBe(3)
  })

  it('keeps the same key, so the same id, when it is packed again; and the package is the same bytes', async () => {
    const folder = extension()
    const first = await packExtensionFolder(folder, join(work, 'a.crx'))
    const firstBytes = readFileSync(first.crx)
    const second = await packExtensionFolder(folder, join(work, 'a.crx'))
    expect(second.newKey).toBe(false)
    expect(scanCrx(readFileSync(second.crx)).extensionId).toBe(scanCrx(firstBytes).extensionId)
    expect(readFileSync(second.crx).equals(firstBytes)).toBe(true)
    expect(readdirSync(work).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('adds the .crx extension when the name has none, and names the key after it', async () => {
    const made = await packExtensionFolder(extension(), join(work, 'bare'))
    expect(made.crx).toBe(join(work, 'bare.crx'))
    expect(made.key).toBe(join(work, 'bare.pem'))
  })

  it('does not follow a link out of the folder, and leaves no mark of it', async () => {
    const folder = extension()
    writeFileSync(join(work, 'secret.txt'), 'outside')
    symlinkSync(join(work, 'secret.txt'), join(folder, 'link.txt'))
    const made = await packExtensionFolder(folder, join(work, 'a.crx'))
    expect(readFileSync(made.crx).toString('latin1').includes('outside')).toBe(false)
    expect(scanCrx(readFileSync(made.crx)).entries).toBe(3)
  })

  it('says why when there is no manifest', async () => {
    const folder = join(work, 'empty')
    mkdirSync(folder)
    writeFileSync(join(folder, 'a.js'), '1')
    await expect(packExtensionFolder(folder, join(work, 'a.crx'))).rejects.toThrow(PackError)
    await expect(packExtensionFolder(folder, join(work, 'a.crx'))).rejects.toThrow(/manifest\.json/)
    expect(existsSync(join(work, 'a.crx'))).toBe(false)
  })

  it('says why when the key next to it cannot be read, and writes nothing', async () => {
    const folder = extension()
    // A directory where the key should be: reading it fails with something other than "not there".
    mkdirSync(join(work, 'a.pem'))
    await expect(packExtensionFolder(folder, join(work, 'a.crx'))).rejects.toThrow(/clé privée/)
    expect(existsSync(join(work, 'a.crx'))).toBe(false)
  })

  it('refuses a folder with more files than a package may hold', async () => {
    const folder = join(work, 'many')
    mkdirSync(folder)
    for (let i = 0; i <= PACK_MAX_FILES; i++) writeFileSync(join(folder, `f${i}`), '')
    await expect(filesToPack(folder)).rejects.toThrow(/trop de fichiers/)
  }, 60_000)
})

describe('the archive', () => {
  it('is a ZIP the reader of packages opens, with the names and the sizes it was given', async () => {
    const folder = extension()
    const made = await packExtensionFolder(folder, join(work, 'a.crx'))
    const scan = scanCrx(readFileSync(made.crx))
    expect(scan.unpackedBytes).toBe(JSON.stringify({ manifest_version: 3, name: 'Packed', version: '1.2.3' }).length + 'console.log(1)'.length + '<p>hi</p>'.length)
  })

})
