// The packs on disk: one folder per pair of languages in the models folder (`<from>-<to>/`, with a `manifest.json` and the files it lists). Whatever is
// in that folder was put there by the user or downloaded on a click, and is read as untrusted: the manifest is parsed strictly, a file is read only if
// the manifest names it, and its size and SHA-256 fingerprint are checked before an engine is given it. Nothing here touches the network.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PACK_LIMITS,
  RUNTIME_FILE_NAME,
  RUNTIME_LIMITS,
  SAFE_FILE_NAME,
  isLanguageCode,
  missingRole,
  packFolder,
  parseManifest,
  roleOfFileName,
  type InstalledPack,
  type PackEngine,
  type PackFile,
  type PackManifest
} from '@shared/translate-local'

export const MANIFEST_NAME = 'manifest.json'

export type PackResult<T = undefined> = ({ ok: true } & (T extends undefined ? object : { value: T })) | { ok: false; reason: string }

/** The folder of a pair, inside the models folder: never built from anything but two checked language codes. */
export function packDir(root: string, from: string, to: string): string | null {
  return isLanguageCode(from) && isLanguageCode(to) && from !== to ? join(root, packFolder(from, to)) : null
}

/** A glossary that was there when a model of its pair was downloaded is kept beside it, in `<from>-<to>.glossary`: the glossary still serves when the model cannot. */
export const GLOSSARY_ASIDE = '.glossary'
const PACK_FOLDER = /^([a-z]{2,3})-([a-z]{2,3})(\.glossary)?$/

/** The folder of a listed pack (`InstalledPack.folder`), inside the models folder: only a name of the two shapes above, never a path. */
export function packDirOf(root: string, folder: string): string | null {
  const m = PACK_FOLDER.exec(folder)
  return m && m[1] !== m[2] ? join(root, folder) : null
}

/** Moves a glossary out of the way of a model about to take the pair's folder, unless a glossary is already kept aside (the older one then goes with the folder). */
export async function setGlossaryAside(root: string, from: string, to: string): Promise<void> {
  const dir = packDir(root, from, to)
  if (!dir || (await readManifest(dir, from, to))?.engine !== 'glossary') return
  const aside = `${dir}${GLOSSARY_ASIDE}`
  if ((await readManifest(aside, from, to)) !== null) return
  await rm(aside, { recursive: true, force: true })
  await rename(dir, aside)
}

/** What follows the name of a folder that was in the way of a pack and is not one: `<pair>.kept-<time>`. Never listed, never removed. */
export const FOREIGN_ASIDE = '.kept-'

/**
 * The models folder is the person's choice, and may be a folder that already held something named like a pair of languages (`fr-en`). A folder
 * in the place a pack is about to take that is not a pack of this pair (no manifest of ours) is not deleted: it is moved beside, under
 * `<pair>.kept-<time>`. Answers the new path, or null when there was nothing to move.
 */
export async function setForeignAside(root: string, from: string, to: string, now = Date.now()): Promise<string | null> {
  const dir = packDir(root, from, to)
  if (!dir || (await readManifest(dir, from, to)) !== null) return null
  try {
    await stat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const aside = `${dir}${FOREIGN_ASIDE}${now}`
  await rename(dir, aside)
  console.warn(`[translate] ${dir} was there and is not a pack of this application: it is kept as ${aside}`)
  return aside
}

/** Reads `manifest.json` of a pack folder: bounded, parsed strictly; null when it is missing or is not a manifest of this pair. */
export async function readManifest(dir: string, from?: string, to?: string): Promise<PackManifest | null> {
  let handle
  try {
    handle = await open(join(dir, MANIFEST_NAME), 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size > PACK_LIMITS.manifestBytes) return null
    const manifest = parseManifest(JSON.parse(await handle.readFile({ encoding: 'utf8' })))
    return manifest && (from === undefined || (manifest.from === from && manifest.to === to)) ? manifest : null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.warn(`[translate] cannot read the manifest in ${dir}:`, error instanceof Error ? error.message : String(error))
    return null
  } finally {
    await handle?.close()
  }
}

/** The SHA-256 of a file, read as a stream (a model is tens of megabytes), and its size. */
export async function fingerprint(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    size += chunk.length
    hash.update(chunk)
  }
  return { size, sha256: hash.digest('hex') }
}

/** Checks every file of a pack against the manifest: present, an ordinary file, of the size it says, with the fingerprint it says. */
export async function verifyPack(dir: string, manifest: PackManifest): Promise<PackResult> {
  for (const file of manifest.files) {
    const path = join(dir, file.name)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size !== file.size) return { ok: false, reason: `${file.name}: size` }
      if ((await fingerprint(path)).sha256 !== file.sha256) return { ok: false, reason: `${file.name}: fingerprint` }
    } catch (error) {
      return { ok: false, reason: `${file.name}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}` }
    }
  }
  return { ok: true }
}

/**
 * What a pack looks like on disk right now: the size, modification time and identity of its manifest and of every file it lists. Two equal signatures mean no
 * file was written or replaced in between, which is what lets a pack that was checked once be trusted until a file changes (the check reads every byte).
 */
export async function packSignature(dir: string, manifest: PackManifest): Promise<string> {
  const parts: string[] = []
  for (const name of [MANIFEST_NAME, ...manifest.files.map((file) => file.name)]) {
    try {
      const info = await stat(join(dir, name))
      parts.push(`${name}:${info.size}:${info.mtimeMs}:${info.ino}`)
    } catch {
      parts.push(`${name}:missing`)
    }
  }
  return parts.join('|')
}

/** The key a checked pack is remembered by: its folder and its version. */
export const verifiedKey = (folder: string, version: string): string => `${folder}@${version}`

/** The packs in the models folder whose manifest is valid. A folder that is not a pack is not one, and is left alone; a folder set aside holds a glossary or nothing. */
export async function listPacks(root: string, verified: ReadonlySet<string> = new Set()): Promise<InstalledPack[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[translate] cannot list the models folder ${root}:`, error instanceof Error ? error.message : String(error))
    return []
  }
  const packs: InstalledPack[] = []
  for (const name of names.sort()) {
    const m = PACK_FOLDER.exec(name)
    if (!m) continue
    const manifest = await readManifest(join(root, name), m[1], m[2])
    if (!manifest || (m[3] !== undefined && manifest.engine !== 'glossary')) continue
    packs.push({
      from: manifest.from,
      to: manifest.to,
      engine: manifest.engine,
      version: manifest.version,
      bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
      verified: verified.has(verifiedKey(name, manifest.version)),
      folder: name
    })
  }
  return packs
}

/** The manifest of the files the user put in a pair's folder: the roles come from the file names, the sizes and fingerprints from the files themselves (read once, on a click). */
export async function adoptFolder(root: string, from: string, to: string, engine?: 'bergamot' | 'glossary'): Promise<PackResult<PackManifest>> {
  const dir = packDir(root, from, to)
  if (!dir) return { ok: false, reason: 'pair' }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { ok: false, reason: 'no-folder' }
  }
  const files: PackFile[] = []
  const roles = new Set<string>()
  for (const name of names.sort()) {
    const role = roleOfFileName(name)
    if (!role || roles.has(role) || !SAFE_FILE_NAME.test(name)) continue
    const info = await stat(join(dir, name))
    if (!info.isFile() || info.size === 0 || info.size > PACK_LIMITS.fileBytes) continue
    roles.add(role)
    files.push({ role, name, size: info.size, sha256: (await fingerprint(join(dir, name))).sha256 })
  }
  const kind = engine ?? (roles.has('glossary') ? 'glossary' : 'bergamot')
  if (missingRole(kind, files) !== null) return { ok: false, reason: 'incomplete' }
  const manifest = parseManifest({ schema: 1, engine: kind, from, to, version: '1', files })
  if (!manifest) return { ok: false, reason: 'invalid' }
  await writeManifest(dir, manifest)
  return { ok: true, value: manifest }
}

/** Writes the manifest last and atomically: a folder with a manifest is a complete pack. */
export async function writeManifest(dir: string, manifest: PackManifest | RuntimeManifest): Promise<void> {
  const temporary = join(dir, `.${MANIFEST_NAME}.${randomUUID()}`)
  await writeFile(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, join(dir, MANIFEST_NAME))
}

/**
 * Removes a pack of a pair (its folder and nothing else). With an engine, the pack of that engine: a glossary set aside or in the pair's folder, a model in
 * the pair's folder; a folder that holds the other engine's pack is left alone. Without one, the pair's folder, when it is a pack: a folder
 * of that name with no manifest of this pair is something the person had there, and is refused (`not-a-pack`), never deleted.
 */
export async function removePack(root: string, from: string, to: string, engine?: PackEngine): Promise<PackResult> {
  const dir = packDir(root, from, to)
  if (!dir) return { ok: false, reason: 'pair' }
  let target: string | null = dir
  if (engine !== undefined) {
    const candidates = engine === 'glossary' ? [`${dir}${GLOSSARY_ASIDE}`, dir] : [dir]
    target = null
    for (const candidate of candidates) {
      if ((await readManifest(candidate, from, to))?.engine === engine) {
        target = candidate
        break
      }
    }
    if (!target) return { ok: true }
  } else if ((await readManifest(dir, from, to)) === null) {
    try {
      await stat(dir)
    } catch (error) {
      // Nothing there: nothing to remove.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
      console.error(`[translate] cannot look at ${dir} before removing it:`, error)
      return { ok: false, reason: (error as NodeJS.ErrnoException).code ?? 'unreadable' }
    }
    console.warn(`[translate] ${dir} holds no pack of this application: it is not removed`)
    return { ok: false, reason: 'not-a-pack' }
  }
  try {
    await rm(target, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    console.error(`[translate] cannot remove the pack ${target}:`, error)
    return { ok: false, reason: (error as NodeJS.ErrnoException).code ?? 'unreadable' }
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

// ---------- the engine's binary ----------

/** The folder of the engine's binary inside the engine folder (userData/translation-engine: fixed, never chosen by the interface nor by the settings). */
export const RUNTIME_FOLDER = 'bergamot'

export interface RuntimeManifest {
  schema: 1
  version: string
  release: string
  file: { name: typeof RUNTIME_FILE_NAME; size: number; sha256: string }
}

/** The manifest of the engine's binary, read strictly; null for anything else. */
export function parseRuntimeManifest(raw: unknown): RuntimeManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (Object.keys(m).sort().join() !== 'file,release,schema,version' || m['schema'] !== 1) return null
  if (typeof m['version'] !== 'string' || !/^\d{1,4}(\.\d{1,4}){0,2}$/.test(m['version']) || typeof m['release'] !== 'string' || !/^[A-Za-z0-9.+_-]{0,40}$/.test(m['release'])) return null
  const f = m['file']
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null
  const file = f as Record<string, unknown>
  if (Object.keys(file).sort().join() !== 'name,sha256,size' || file['name'] !== RUNTIME_FILE_NAME) return null
  if (typeof file['size'] !== 'number' || !Number.isInteger(file['size']) || file['size'] <= 0 || file['size'] > RUNTIME_LIMITS.bytes || typeof file['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(file['sha256'])) return null
  return { schema: 1, version: m['version'], release: m['release'], file: { name: RUNTIME_FILE_NAME, size: file['size'], sha256: file['sha256'] } }
}

/** The manifest of the engine's binary in the engine folder; null when the binary was never downloaded (or its manifest is not one). */
export async function readRuntimeManifest(engineDir: string): Promise<RuntimeManifest | null> {
  let handle
  try {
    handle = await open(join(engineDir, RUNTIME_FOLDER, MANIFEST_NAME), 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size > PACK_LIMITS.manifestBytes) return null
    return parseRuntimeManifest(JSON.parse(await handle.readFile({ encoding: 'utf8' })))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.warn(`[translate] cannot read the manifest of the engine in ${engineDir}:`, error instanceof Error ? error.message : String(error))
    return null
  } finally {
    await handle?.close()
  }
}

/**
 * The engine's binary, read once and checked on the very bytes that are returned (what the engine gets is what was checked: no file can be swapped between
 * the check and the use). Throws `runtime-missing`, `runtime-size` or `runtime-fingerprint`.
 */
export async function readRuntime(engineDir: string): Promise<Uint8Array> {
  const manifest = await readRuntimeManifest(engineDir)
  if (!manifest) throw new Error('runtime-missing')
  return readChecked(join(engineDir, RUNTIME_FOLDER, manifest.file.name), manifest.file.size, manifest.file.sha256, 'runtime')
}

/** A file read whole (bounded by the size it should have) and checked against its fingerprint on those same bytes. Throws `<label>-missing`, `-size`, `-fingerprint`. */
export async function readChecked(path: string, size: number, sha256: string, label: string): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? `${label}-missing` : `${label}-unreadable (${code ?? 'error'})`)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== size) throw new Error(`${label}-size`)
    const bytes = new Uint8Array(size)
    let read = 0
    while (read < size) {
      const { bytesRead } = await handle.read(bytes, read, size - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    if (read !== size) throw new Error(`${label}-size`)
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`${label}-fingerprint`)
    return bytes
  } finally {
    await handle.close()
  }
}
