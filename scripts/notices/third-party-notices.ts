// The notices of the npm packages a built Lucium carries, written from the lockfile.
//
// What is shipped is what electron-builder puts in app.asar: the `dependencies` of package.json and everything they require, optional packages
// included. pnpm-lock.yaml says exactly which versions those are; the installed packages give the licence each declares and the text each ships.
// THIRD-PARTY-NOTICES.txt is the result, kept in the repository and copied into the application (electron-builder.yml). A test writes it again and
// refuses a copy that differs, so a dependency cannot be added, removed or moved to another version without its notice following.
//
// The text does not depend on the machine it is written on. A package bound to one system or processor (the prebuilt binary of koffi) is installed
// only where it runs: it is named under the package that requires it, without a text of its own, and the generator checks, where one is installed,
// that it declares the same licence as that package.
//
// Loaded by Node with type stripping (scripts/make-third-party-notices.mjs): no enum, no parameter property.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A map of a YAML file: the nested maps and the scalars of pnpm-lock.yaml, nothing else. */
interface YamlMap {
  [key: string]: YamlMap | string
}

export interface LockSnapshot {
  /** Name of the dependency → key of its snapshot (`name@version`, with the peers pnpm adds in brackets). */
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

export interface LockGraph {
  /** The `dependencies` of the project (never its devDependencies): name → key of the snapshot. */
  direct: Record<string, string>
  snapshots: Record<string, LockSnapshot>
  /** `name@version` of the packages the lockfile binds to a system or a processor (`os`, `cpu`). */
  platformBound: ReadonlySet<string>
  /** `name@version` of the packages a patch of the project modifies at install. */
  patched: ReadonlySet<string>
}

/** One shipped package, as the lockfile names it. */
export interface LockedPackage {
  name: string
  version: string
  /** The key of its snapshot. */
  key: string
  /** The package that requires it (the first one found), null for a dependency of the project. */
  parent: string | null
  platformBound: boolean
  patched: boolean
}

/**
 * Reads the nested maps of a YAML document written the way pnpm writes its lockfile: two spaces per level, `key: scalar` or `key:` followed by a
 * deeper map. A flow value (`{integrity: …}`, `[darwin]`) is kept as its text, `{}` is an empty map, the items of a list are passed over. Any other line is an error: a lockfile
 * this cannot read must not yield a shorter list of notices.
 */
function parseMaps(text: string): YamlMap {
  const root: YamlMap = {}
  const stack: { indent: number; map: YamlMap }[] = [{ indent: -1, map: root }]
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const body = line.slice(indent)
    // The items of a list (`transitivePeerDependencies`): names only, which say nothing of what is installed.
    if (body.startsWith('- ')) continue
    const quoted = /^'((?:[^']|'')*)':(?: (.*))?$/.exec(body) ?? /^"([^"]*)":(?: (.*))?$/.exec(body)
    const plain = quoted ? null : /^(.+?):(?: (.*))?$/.exec(body)
    const match = quoted ?? plain
    if (!match || match[1] === undefined) throw new Error(`pnpm-lock.yaml: a line that is not "key: value" cannot be read: ${JSON.stringify(raw)}`)
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop()
    const parent = stack[stack.length - 1]!.map
    const value = match[2]
    if (value === undefined || value === '' || value === '{}') {
      const child: YamlMap = {}
      parent[match[1]] = child
      if (value !== '{}') stack.push({ indent, map: child })
    } else {
      parent[match[1]] = value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
    }
  }
  return root
}

const asMap = (value: YamlMap | string | undefined): YamlMap => (typeof value === 'object' ? value : {})

/** The key of the snapshot a dependency line names: `name@version`, or the value itself when it is an alias (`alias: real-name@1.2.3`). */
function snapshotKey(name: string, version: string): string {
  const bare = version.replace(/\(.*$/, '')
  return /^@?[^@]+@/.test(bare) ? version : `${name}@${version}`
}

/** `name@version` without the peers in brackets. */
const bareId = (key: string): string => key.replace(/\(.*$/, '')

function splitId(key: string): { name: string; version: string } {
  const id = bareId(key)
  const at = id.lastIndexOf('@')
  if (at <= 0) throw new Error(`pnpm-lock.yaml: ${JSON.stringify(key)} is not "name@version"`)
  return { name: id.slice(0, at), version: id.slice(at + 1) }
}

/** Reads the dependency graph of the project from the text of pnpm-lock.yaml. */
export function parseLock(text: string): LockGraph {
  // pnpm 12 writes two documents: the lock of the package manager itself, then the lock of the project. The project's is the last one.
  const documents = text.split(/^---$/m).filter((part) => /^importers:/m.test(part))
  const document = documents[documents.length - 1]
  if (document === undefined) throw new Error('pnpm-lock.yaml: no document with an "importers" section')
  const lock = parseMaps(document)
  const project = asMap(asMap(lock.importers)['.'])
  if (typeof project.dependencies !== 'object') throw new Error('pnpm-lock.yaml: the project has no "dependencies" section')

  const direct: Record<string, string> = {}
  for (const [name, entry] of Object.entries(project.dependencies)) {
    const version = asMap(entry).version
    if (typeof version !== 'string') throw new Error(`pnpm-lock.yaml: the dependency ${name} has no version`)
    direct[name] = snapshotKey(name, version)
  }

  const snapshots: Record<string, LockSnapshot> = {}
  for (const [key, entry] of Object.entries(asMap(lock.snapshots))) {
    const keysOf = (section: YamlMap | string | undefined): Record<string, string> =>
      Object.fromEntries(Object.entries(asMap(section)).map(([name, version]) => [name, snapshotKey(name, String(version))]))
    snapshots[key] = { dependencies: keysOf(asMap(entry).dependencies), optionalDependencies: keysOf(asMap(entry).optionalDependencies) }
  }

  const platformBound = new Set<string>()
  for (const [id, entry] of Object.entries(asMap(lock.packages))) {
    if ('os' in asMap(entry) || 'cpu' in asMap(entry)) platformBound.add(id)
  }
  return { direct, snapshots, platformBound, patched: new Set(Object.keys(asMap(lock.patchedDependencies))) }
}

const byNameThenVersion = (a: { name: string; version: string }, b: { name: string; version: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0

/** Every package the dependencies of the project bring, optional ones included, each once, sorted by name. */
export function shippedPackages(graph: LockGraph): LockedPackage[] {
  const found = new Map<string, LockedPackage>()
  const queue: { key: string; parent: string | null }[] = Object.values(graph.direct).map((key) => ({ key, parent: null }))
  for (let at = 0; at < queue.length; at += 1) {
    const { key, parent } = queue[at]!
    const id = bareId(key)
    if (found.has(id)) continue
    const snapshot = graph.snapshots[key]
    if (!snapshot) throw new Error(`pnpm-lock.yaml: no snapshot for ${key}${parent ? `, required by ${parent}` : ''}`)
    found.set(id, { ...splitId(key), key, parent, platformBound: graph.platformBound.has(id), patched: graph.patched.has(id) })
    for (const next of [...Object.values(snapshot.dependencies), ...Object.values(snapshot.optionalDependencies)]) queue.push({ key: next, parent: id })
  }
  return [...found.values()].sort(byNameThenVersion)
}

/** What the generator reads of an installed package. */
export interface InstalledPackage {
  version: string
  /** The `license` of its package.json, as written. */
  license: string
  /** Where its source is: the repository of its package.json, else its homepage. */
  url: string | null
  /** The `author` of its package.json, without an address. */
  author: string | null
  /** Its licence and notice files (LICENSE*, COPYING*, NOTICE*, COPYRIGHT*), sorted by name. */
  texts: { file: string; text: string }[]
}

/** Reads the installed packages. `root` is the folder of the project; a package is looked for the way Node resolves it from the one that requires it. */
export interface PackageReader {
  /** The folder of the package `name` required from the folder `from`, or null when it is not installed. */
  locate(from: string, name: string): string | null
  read(dir: string): InstalledPackage
}

/** A package with what was read of it. `installed` is null for a package bound to another system, which is not on this machine. */
export interface NoticedPackage extends LockedPackage {
  installed: InstalledPackage | null
}

/**
 * Reads every shipped package where it is installed. Refuses (throws) what would make the notices wrong: a package that is not installed while it
 * should be, another version than the lockfile's, no declared licence, and a platform binary that declares another licence than the package it
 * belongs to.
 */
export function readPackages(graph: LockGraph, root: string, reader: PackageReader): NoticedPackage[] {
  const packages = shippedPackages(graph)
  const dirs = new Map<string, string | null>()
  const read = new Map<string, InstalledPackage | null>()
  // Parents first: a package is found from the folder of the one that requires it.
  const pending = [...packages]
  while (pending.length > 0) {
    const at = pending.findIndex((entry) => entry.parent === null || dirs.has(entry.parent))
    if (at === -1) throw new Error(`third-party notices: no installed parent for ${pending.map((entry) => entry.name).join(', ')}`)
    const entry = pending.splice(at, 1)[0]!
    const id = `${entry.name}@${entry.version}`
    const from = entry.parent === null ? root : dirs.get(entry.parent)
    const dir = from ? reader.locate(from, entry.name) : null
    dirs.set(id, dir)
    if (dir === null) {
      if (!entry.platformBound) throw new Error(`third-party notices: ${id} is in pnpm-lock.yaml and not installed: run pnpm install --frozen-lockfile`)
      read.set(id, null)
      continue
    }
    const installed = reader.read(dir)
    if (installed.version !== entry.version) {
      throw new Error(`third-party notices: ${entry.name} is installed in ${installed.version} while pnpm-lock.yaml says ${entry.version}: run pnpm install --frozen-lockfile`)
    }
    if (installed.license === '') throw new Error(`third-party notices: ${id} declares no licence in its package.json: read its terms and decide before shipping it`)
    read.set(id, installed)
  }
  for (const entry of packages) {
    const installed = read.get(`${entry.name}@${entry.version}`) ?? null
    if (!entry.platformBound || installed === null) continue
    const owner = entry.parent === null ? null : read.get(entry.parent)
    if (!owner) throw new Error(`third-party notices: the platform package ${entry.name} is required by no installed package: its licence cannot be tied to one`)
    if (owner.license !== installed.license) {
      throw new Error(`third-party notices: ${entry.name} declares ${installed.license} while ${entry.parent}, which it belongs to, declares ${owner.license}: it needs an entry of its own`)
    }
  }
  return packages.map((entry) => ({ ...entry, installed: read.get(`${entry.name}@${entry.version}`) ?? null }))
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/**
 * The text printed for a package: its own files, or, for a package that ships none and declares MIT, the standard MIT text with the author its
 * package.json names (no year: the package gives none, and none is invented). Any other package without a text is refused.
 */
function textOf(entry: NoticedPackage, installed: InstalledPackage): { label: string; text: string } {
  if (installed.texts.length > 0) {
    return {
      label: installed.texts.map(({ file }) => file).join(' + '),
      text: installed.texts.map(({ text }) => text).join('\n\n')
    }
  }
  if (installed.license !== 'MIT' || installed.author === null) {
    throw new Error(
      `third-party notices: ${entry.name}@${entry.version} ships no licence file and ${installed.license === 'MIT' ? 'names no author' : `declares ${installed.license}`}: its text has to be found and written by hand`
    )
  }
  return {
    label: 'no licence file in the package: standard MIT text, holder named by its package.json, year not given by the package',
    text: `MIT License\n\nCopyright (c) ${installed.author}\n\n${MIT_TEXT}`
  }
}

export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt'

/** Writes the notices: the list of the packages, the platform binaries under the package they belong to, then every distinct licence text once. */
export function renderNotices(packages: readonly NoticedPackage[]): string {
  const own = packages.filter((entry) => !entry.platformBound)
  const bound = packages.filter((entry) => entry.platformBound)
  const lines: string[] = [
    'Lucium: notices of the npm packages it carries',
    '==============================================',
    '',
    'Generated by `node scripts/make-third-party-notices.mjs` from pnpm-lock.yaml. Do not edit by hand:',
    'scripts/notices/third-party-notices.test.ts refuses a copy that is not what the generator writes.',
    '',
    'These are the npm packages a built Lucium carries: the dependencies of package.json and everything they',
    'require. Each line gives the version the lockfile pins, the licence the package declares and where its',
    'source is. The licence texts follow, each printed once. Every package is also on the npm registry under',
    'the name and version given here.',
    '',
    'What does not come from npm is elsewhere: the licence of Lucium in LICENSE, its notice in NOTICE, Electron',
    'in LICENSE.electron.txt, Chromium and what it carries in LICENSES.chromium.html, the fonts in',
    'fonts/LICENSES.md, and the rest (media, filter lists, translation models) in docs/licences-tierces.md.',
    '',
    `Packages (${own.length})`,
    '-------------',
    ''
  ]
  const texts = new Map<string, { label: string; license: string; ids: string[] }>()
  for (const entry of own) {
    // readPackages refuses a package that is not installed unless it is bound to a platform: every package here was read.
    const installed = entry.installed!
    const id = `${entry.name} ${entry.version}`
    lines.push(`${id} | ${installed.license} | ${installed.url ?? `https://www.npmjs.com/package/${entry.name}`}${entry.patched ? ' | modified by a patch of this repository (patches/)' : ''}`)
    const { label, text } = textOf(entry, installed)
    const known = texts.get(text)
    if (known) known.ids.push(id)
    else texts.set(text, { label, license: installed.license, ids: [id] })
  }
  if (bound.length > 0) {
    lines.push('', 'Prebuilt binaries, one package per system and processor. A build carries the one of the system it is made', 'for. Each is under the licence of the package it belongs to, whose text applies:', '')
    for (const owner of own) {
      const binaries = bound.filter((entry) => entry.parent === `${owner.name}@${owner.version}`)
      if (binaries.length === 0) continue
      lines.push(`${owner.name} ${owner.version} (${owner.installed!.license}):`, ...binaries.map((entry) => `  ${entry.name} ${entry.version}`))
    }
  }
  lines.push('', 'Licence texts', '-------------')
  for (const [text, { label, license, ids }] of texts) {
    lines.push('', '='.repeat(100), `${license}: ${ids.join(', ')}`, `(${label})`, '='.repeat(100), '', text)
  }
  return `${lines.join('\n')}\n`
}

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice|copyright)/i

/** The reader of the packages pnpm installed under `node_modules`. */
export function installedReader(): PackageReader {
  return {
    locate(from, name) {
      // The way Node looks a package up: node_modules of the folder, then of each folder above. Under pnpm, the dependencies of a package are its
      // neighbours in the node_modules folder that holds it.
      for (let dir = from; ; dir = dirname(dir)) {
        const candidate = join(dir, 'node_modules', name)
        if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
        if (dirname(dir) === dir) return null
      }
    },
    read(dir) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        version?: string
        license?: unknown
        repository?: string | { url?: string }
        homepage?: string
        author?: string | { name?: string }
      }
      const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
      const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
      return {
        version: manifest.version ?? '',
        license: typeof manifest.license === 'string' ? manifest.license : '',
        url: sourceUrl(repository) ?? manifest.homepage ?? null,
        author: author ? author.replace(/\s*<[^>]*>/, '').replace(/\s*\([^)]*\)/, '').trim() || null : null,
        texts: readdirSync(dir, { withFileTypes: true })
          .filter((file) => file.isFile() && NOTICE_FILE.test(file.name))
          .map((file) => file.name)
          .sort()
          .map((file) => ({ file, text: tidy(readFileSync(join(dir, file), 'utf8')) }))
      }
    }
  }
}

/** A repository written the way package.json allows (`git+https://….git`, `github:owner/name`, `owner/name`) as an address a person can open. */
export function sourceUrl(repository: string | undefined): string | null {
  if (!repository) return null
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(repository)
  if (short) return `https://github.com/${short[1]}`
  return repository
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
}

/** A licence text with one kind of line end and no space left at the end of a line or of the text: the same on every system. */
const tidy = (text: string): string =>
  text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
