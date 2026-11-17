import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeStoreDirectory, compareVersionFolders, extensionDirectory, ownerOnlyDirectory, profileDirectory, storedExtensions } from './web-store-files'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lucium-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function install(profile: string, id: string, folder: string, manifest = true): string {
  const dir = join(root, profile, id, folder)
  mkdirSync(dir, { recursive: true })
  if (manifest) writeFileSync(join(dir, 'manifest.json'), '{}')
  return dir
}

describe('compareVersionFolders', () => {
  it('orders version folders numerically, then by their suffix', () => {
    const sorted = ['1.2.10_0', '1.2.9_0', '1.10_0', '1.2_1', '1.2_0', '2_0', '1.2.0.1_0'].sort(compareVersionFolders)
    expect(sorted).toEqual(['1.2_0', '1.2_1', '1.2.0.1_0', '1.2.9_0', '1.2.10_0', '1.10_0', '2_0'])
  })

  // The numbers are compared by shared/versions.ts: a folder name whose numbers are not a version (never kept by storedExtensions) ranks as
  // equal on them, and only its suffix tells.
  it('ranks the numbers that are not a version as equal, and lets the suffix decide', () => {
    expect(compareVersionFolders('1.2.3_0', '1.2.3_0')).toBe(0)
    expect(compareVersionFolders('1.2.3', '1.2.3_0')).toBe(0)
    expect(Math.sign(compareVersionFolders('x_1', '1_0'))).toBe(1)
    expect(Math.sign(compareVersionFolders('1.2.3.4.5_0', '9_0'))).toBe(0)
  })
})

describe('the folders of the store extensions', () => {
  it('names a folder only for a plain profile id and a well-formed extension id', () => {
    expect(profileDirectory(root, 'work')).toBe(join(root, 'work'))
    expect(extensionDirectory(root, 'work', A)).toBe(join(root, 'work', A))
    for (const profile of ['..', 'a/b', '', '__proto__', 'x'.repeat(33)]) expect(() => profileDirectory(root, profile), profile).toThrow(/profile id/)
    for (const id of ['../x', 'short', 'A'.repeat(32), `${A}/..`]) expect(() => extensionDirectory(root, 'work', id), id).toThrow(/extension id/)
  })

  it('lists the newest version of each extension of one profile, and only that profile\'s', async () => {
    const newest = install('work', A, '1.2.10_0')
    install('work', A, '1.2.9_0')
    const other = install('work', B, '3_0')
    install('home', B, '9_0')
    expect(await storedExtensions(root, 'work')).toEqual([
      { id: A, version: '1.2.10', path: newest },
      { id: B, version: '3', path: other }
    ])
    expect((await storedExtensions(root, 'home')).map((e) => e.id)).toEqual([B])
    expect(await storedExtensions(root, 'nobody')).toEqual([])
  })

  it('ignores what is not an extension: stray files, odd folder names, a folder that is not an id', async () => {
    const real = install('work', A, '1.0_0')
    install('work', 'not-an-id', '1.0_0')
    // Would sort above the real version if it were taken for one, and it has a manifest: it is the library's temporary folder.
    install('work', A, '99999.unpacking')
    writeFileSync(join(root, 'work', 'notes.txt'), 'x')
    expect(await storedExtensions(root, 'work')).toEqual([{ id: A, version: '1.0', path: real }])
  })

  it('falls back to the previous version when the newest was left without a manifest, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const previous = install('work', A, '1.0_0')
    const broken = install('work', A, '1.1_0', false)
    expect(await storedExtensions(root, 'work')).toEqual([{ id: A, version: '1.0', path: previous }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(broken), expect.any(String))
  })

  it('refuses a profile id that would leave the folder', async () => {
    await expect(storedExtensions(root, '../etc')).rejects.toThrow(/profile id/)
  })
})

describe('the folders of the store, closed to the other accounts of the Mac', () => {
  const modeOf = (path: string): number => statSync(path).mode & 0o777

  it('makes a folder only its owner can enter, whatever the umask', async () => {
    const before = process.umask(0o022)
    try {
      await ownerOnlyDirectory(join(root, 'store'))
    } finally {
      process.umask(before)
    }
    expect(modeOf(join(root, 'store'))).toBe(0o700)
  })

  it('closes a folder an earlier version left readable by everyone', async () => {
    mkdirSync(join(root, 'store'))
    chmodSync(join(root, 'store'), 0o755)
    await ownerOnlyDirectory(join(root, 'store'))
    expect(modeOf(join(root, 'store'))).toBe(0o700)
  })

  it('closes the folder of the installed extensions when there is one, and makes none otherwise', async () => {
    mkdirSync(join(root, 'store'))
    chmodSync(join(root, 'store'), 0o755)
    await closeStoreDirectory(join(root, 'store'))
    expect(modeOf(join(root, 'store'))).toBe(0o700)
    await closeStoreDirectory(join(root, 'never-installed'))
    expect(existsSync(join(root, 'never-installed'))).toBe(false)
  })
})
