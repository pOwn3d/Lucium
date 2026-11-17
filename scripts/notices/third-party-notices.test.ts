import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../../src/main/temp-dir'
import {
  NOTICES_FILE,
  installedReader,
  parseLock,
  readPackages,
  renderNotices,
  shippedPackages,
  sourceUrl,
  type InstalledPackage,
  type NoticedPackage,
  type PackageReader
} from './third-party-notices'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// A lockfile the way pnpm 12 writes it: its own document first, then the project's.
const LOCK = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 1.0.0
        version: 1.0.0

snapshots:

  pnpm@1.0.0: {}

---
lockfileVersion: '9.0'

patchedDependencies:
  patched@2.0.0: abc123

importers:

  .:
    dependencies:
      '@scope/app-lib':
        specifier: 1.0.0
        version: 1.0.0(peer@3.0.0)
      patched:
        specifier: 2.0.0
        version: 2.0.0
    devDependencies:
      builder:
        specifier: ^1.0.0
        version: 1.2.0

packages:

  '@bin/native-darwin-arm64@1.0.0':
    resolution: {integrity: sha512-a}
    cpu: [arm64]
    os: [darwin]

  '@bin/native-linux-x64@1.0.0':
    resolution: {integrity: sha512-b}
    cpu: [x64]
    os: [linux]

  '@scope/app-lib@1.0.0':
    resolution: {integrity: sha512-c}
    peerDependencies:
      peer: '*'

  leaf@0.1.0:
    resolution: {integrity: sha512-d}

snapshots:

  '@bin/native-darwin-arm64@1.0.0':
    optional: true

  '@bin/native-linux-x64@1.0.0':
    optional: true

  '@scope/app-lib@1.0.0(peer@3.0.0)':
    dependencies:
      aliased: real-name@4.0.0
      leaf: 0.1.0
      peer: 3.0.0
    optionalDependencies:
      '@bin/native-darwin-arm64': 1.0.0
      '@bin/native-linux-x64': 1.0.0
    transitivePeerDependencies:
      - supports-color

  builder@1.2.0:
    dependencies:
      dev-only: 9.0.0
      leaf: 0.1.0

  dev-only@9.0.0: {}

  leaf@0.1.0: {}

  patched@2.0.0: {}

  peer@3.0.0: {}

  real-name@4.0.0: {}
`

const MIT: Omit<InstalledPackage, 'version'> = { license: 'MIT', url: 'https://example.org/src', author: 'A. Author', texts: [{ file: 'LICENSE', text: 'MIT text' }] }

/** A reader over a made-up installation: `name` → what is read of it. A folder is the name of its package. */
function reader(installed: Record<string, InstalledPackage>): PackageReader {
  return {
    locate: (_from, name) => (name in installed ? name : null),
    read: (dir) => installed[dir]!
  }
}

/** Everything of LOCK installed, with the binary of one platform only. */
const installation = (binary: string, overrides: Record<string, Partial<InstalledPackage> | null> = {}): Record<string, InstalledPackage> => {
  const all: Record<string, InstalledPackage> = {
    '@scope/app-lib': { ...MIT, version: '1.0.0', license: 'MPL-2.0', texts: [{ file: 'LICENSE', text: 'MPL text' }] },
    [binary]: { ...MIT, version: '1.0.0', license: 'MPL-2.0', texts: [] },
    leaf: { ...MIT, version: '0.1.0' },
    patched: { ...MIT, version: '2.0.0' },
    peer: { ...MIT, version: '3.0.0', texts: [{ file: 'license.md', text: 'another MIT text' }] },
    'real-name': { ...MIT, version: '4.0.0', texts: [] }
  }
  for (const [name, change] of Object.entries(overrides)) {
    if (change === null) delete all[name]
    else all[name] = { ...all[name]!, ...change }
  }
  return all
}

const noticesOf = (installed: Record<string, InstalledPackage>): string => renderNotices(readPackages(parseLock(LOCK), '/project', reader(installed)))

describe('the packages a built Lucium carries, read from the lockfile', () => {
  const packages = shippedPackages(parseLock(LOCK))

  it('are the dependencies of the project and all they require, optional ones included, each once', () => {
    expect(packages.map(({ name, version }) => `${name}@${version}`)).toEqual([
      '@bin/native-darwin-arm64@1.0.0',
      '@bin/native-linux-x64@1.0.0',
      '@scope/app-lib@1.0.0',
      'leaf@0.1.0',
      'patched@2.0.0',
      'peer@3.0.0',
      'real-name@4.0.0'
    ])
  })

  it('never hold a development dependency, what only it requires, or the package manager', () => {
    const names = packages.map(({ name }) => name)
    for (const absent of ['builder', 'dev-only', 'pnpm']) expect(names, absent).not.toContain(absent)
  })

  it('name an aliased dependency by the package that is installed, and a package without the peers pnpm adds to its key', () => {
    expect(packages.find(({ name }) => name === 'real-name')).toMatchObject({ version: '4.0.0', parent: '@scope/app-lib@1.0.0' })
    expect(packages.find(({ name }) => name === '@scope/app-lib')).toMatchObject({ version: '1.0.0', key: '@scope/app-lib@1.0.0(peer@3.0.0)', parent: null })
  })

  it('mark the packages bound to a system or a processor, and the ones a patch of the project modifies', () => {
    expect(packages.filter(({ platformBound }) => platformBound).map(({ name }) => name)).toEqual(['@bin/native-darwin-arm64', '@bin/native-linux-x64'])
    expect(packages.filter(({ patched }) => patched).map(({ name }) => name)).toEqual(['patched'])
  })

  it('cannot be read from a lockfile that names a package without saying what it requires, or that has a line the reader does not know', () => {
    expect(() => shippedPackages(parseLock(LOCK.replace('  leaf@0.1.0: {}\n', '')))).toThrow(/no snapshot for leaf@0\.1\.0, required by @scope\/app-lib@1\.0\.0/)
    expect(() => parseLock(LOCK.replace('  peer@3.0.0: {}', '  peer@3.0.0 {}'))).toThrow(/cannot be read: " {2}peer@3\.0\.0 \{\}"/)
    expect(() => parseLock('lockfileVersion: 9\n')).toThrow(/no document with an "importers" section/)
  })
})

describe('the notices written from the installed packages', () => {
  it('list each package with its version, its declared licence and where its source is, and say which one is patched', () => {
    const text = noticesOf(installation('@bin/native-darwin-arm64'))
    expect(text).toContain('Packages (5)')
    expect(text).toContain('@scope/app-lib 1.0.0 | MPL-2.0 | https://example.org/src\n')
    expect(text).toContain('patched 2.0.0 | MIT | https://example.org/src | modified by a patch of this repository (patches/)\n')
  })

  it('are the same text whichever platform binary is installed: the binaries are named under their package, without a text of their own', () => {
    const onMac = noticesOf(installation('@bin/native-darwin-arm64'))
    expect(noticesOf(installation('@bin/native-linux-x64'))).toBe(onMac)
    expect(onMac).toContain('@scope/app-lib 1.0.0 (MPL-2.0):\n  @bin/native-darwin-arm64 1.0.0\n  @bin/native-linux-x64 1.0.0\n')
  })

  it('print a licence text once for the packages that share it', () => {
    const text = noticesOf(installation('@bin/native-darwin-arm64'))
    expect(text).toContain('MIT: leaf 0.1.0, patched 2.0.0\n(LICENSE)')
    expect(text.match(/^MIT text$/gm)).toHaveLength(1)
    expect(text).toContain('MIT: peer 3.0.0\n(license.md)')
  })

  it('write the standard MIT text, with the author of package.json and no year, for a MIT package that ships no licence file', () => {
    const text = noticesOf(installation('@bin/native-darwin-arm64'))
    expect(text).toContain('MIT: real-name 4.0.0\n(no licence file in the package: standard MIT text, holder named by its package.json, year not given by the package)')
    expect(text).toContain('MIT License\n\nCopyright (c) A. Author\n\nPermission is hereby granted, free of charge')
  })

  it('refuse a package without a licence file that is not MIT, or that names no author', () => {
    expect(() => noticesOf(installation('@bin/native-darwin-arm64', { 'real-name': { license: 'ISC' } }))).toThrow(/real-name@4\.0\.0 ships no licence file and declares ISC/)
    expect(() => noticesOf(installation('@bin/native-darwin-arm64', { 'real-name': { author: null } }))).toThrow(/real-name@4\.0\.0 ships no licence file and names no author/)
  })

  it('refuse a package of the lockfile that is not installed, unless it is the binary of another platform', () => {
    expect(() => noticesOf(installation('@bin/native-darwin-arm64', { leaf: null }))).toThrow(/leaf@0\.1\.0 is in pnpm-lock\.yaml and not installed/)
    expect(() => noticesOf(installation('@bin/native-darwin-arm64', { '@bin/native-darwin-arm64': null }))).not.toThrow()
  })

  it('refuse an installed version that is not the one of the lockfile', () => {
    expect(() => noticesOf(installation('@bin/native-darwin-arm64', { leaf: { version: '0.2.0' } }))).toThrow(/leaf is installed in 0\.2\.0 while pnpm-lock\.yaml says 0\.1\.0/)
  })

  it('refuse a package that declares no licence', () => {
    expect(() => noticesOf(installation('@bin/native-darwin-arm64', { peer: { license: '' } }))).toThrow(/peer@3\.0\.0 declares no licence/)
  })

  it('refuse a platform binary that declares another licence than the package it belongs to', () => {
    expect(() => noticesOf(installation('@bin/native-linux-x64', { '@bin/native-linux-x64': { license: 'Proprietary' } }))).toThrow(
      /@bin\/native-linux-x64 declares Proprietary while @scope\/app-lib@1\.0\.0, which it belongs to, declares MPL-2\.0/
    )
  })

  it('give an address a person can open for the ways a package.json writes its repository', () => {
    expect(sourceUrl('git+https://github.com/owner/name.git')).toBe('https://github.com/owner/name')
    expect(sourceUrl('git://github.com/owner/name.git')).toBe('https://github.com/owner/name')
    expect(sourceUrl('git@github.com:owner/name.git')).toBe('https://github.com/owner/name')
    expect(sourceUrl('github:owner/name')).toBe('https://github.com/owner/name')
    expect(sourceUrl('owner/name')).toBe('https://github.com/owner/name')
    expect(sourceUrl(undefined)).toBeNull()
  })
})

// Each test starts the script, a Node of its own, up to four times: a second and a half on a quiet machine, several times that when every core is taken.
describe('scripts/make-third-party-notices.mjs', { timeout: 30_000 }, () => {
  const script = join(ROOT, 'scripts', 'make-third-party-notices.mjs')
  const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

  /** A project folder with a lockfile of one dependency, installed or not. */
  function project(installed: boolean): string {
    const dir = tempDir('lucium-notices-cli-')
    writeFileSync(
      join(dir, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      only-one:\n        specifier: 1.0.0\n        version: 1.0.0\n\nsnapshots:\n\n  only-one@1.0.0: {}\n"
    )
    if (installed) {
      mkdirSync(join(dir, 'node_modules', 'only-one'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'only-one', 'package.json'), JSON.stringify({ name: 'only-one', version: '1.0.0', license: 'ISC', repository: 'owner/only-one' }))
      writeFileSync(join(dir, 'node_modules', 'only-one', 'LICENSE'), 'ISC text\r\n')
    }
    return dir
  }

  it('writes the file, then finds it up to date; finds it stale once it is changed, and says what to run', () => {
    const dir = project(true)
    expect(run(['--root', dir, '--check']).status).toBe(1)
    expect(run(['--root', dir]).status).toBe(0)
    const written = readFileSync(join(dir, NOTICES_FILE), 'utf8')
    expect(written).toContain('only-one 1.0.0 | ISC | https://github.com/owner/only-one\n')
    expect(written.endsWith('\nISC text\n')).toBe(true)
    expect(run(['--root', dir, '--check']).status).toBe(0)
    writeFileSync(join(dir, NOTICES_FILE), written.replace('1.0.0', '0.9.0'))
    const stale = run(['--root', dir, '--check'])
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain('is not what pnpm-lock.yaml gives: run node scripts/make-third-party-notices.mjs')
  })

  it('stops with the reason, and writes nothing, when the notices cannot be right', () => {
    const dir = project(false)
    const failed = run(['--root', dir])
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('make-third-party-notices: third-party notices: only-one@1.0.0 is in pnpm-lock.yaml and not installed')
    expect(existsSync(join(dir, NOTICES_FILE))).toBe(false)
  })
})

describe(NOTICES_FILE, () => {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  const committed = readFileSync(join(ROOT, NOTICES_FILE), 'utf8')
  // Read in the tests, not while the file is collected: a lockfile the installation no longer matches fails a test with its reason.
  let read: NoticedPackage[] | undefined
  const packages = (): NoticedPackage[] => (read ??= readPackages(parseLock(lock), ROOT, installedReader()))

  // The check that keeps the file honest: a dependency added, removed or moved to another version changes pnpm-lock.yaml, and this fails until
  // `node scripts/make-third-party-notices.mjs` has written the file again.
  it('is exactly what the generator writes from pnpm-lock.yaml: run `pnpm notices` after any change of the dependencies', () => {
    expect(committed).toBe(renderNotices(packages()))
  })

  it('names every dependency package.json declares, at the version the lockfile pins', () => {
    const declared = Object.keys((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies)
    expect(declared.length).toBeGreaterThan(0)
    for (const name of declared) {
      const entry = packages().find((candidate) => candidate.name === name && candidate.parent === null)
      expect(entry, name).toBeDefined()
      expect(committed).toContain(`\n${name} ${entry!.version} | `)
    }
  })

  it('names no development dependency', () => {
    const dev = Object.keys((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies)
    for (const name of dev) expect(committed, name).not.toMatch(new RegExp(`^${name.replace(/[/@.-]/g, '\\$&')} \\d`, 'm'))
  })

  it('carries a licence text for every package it lists', () => {
    for (const entry of packages().filter(({ platformBound }) => !platformBound)) {
      expect(committed, entry.name).toMatch(new RegExp(`^[A-Za-z0-9.+-]+: (?:.*, )?${`${entry.name} ${entry.version}`.replace(/[/@.+-]/g, '\\$&')}(?:,|$)`, 'm'))
    }
  })
})
