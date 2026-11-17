// The scripts the package leaves outside app.asar (electron-builder.yml, `asarUnpack`): the preloads Chromium reads from disk, among them the one
// that reads the sign-in forms of every page (password-bridge) and the guard of the pages. The fuse that validates app.asar checks its header and
// what is read through it; a file of app.asar.unpacked is read by its own path, and macOS does not check the seal of the bundle at each launch. So
// whoever can write into the bundle could replace one of them without anything refusing it.
//
// The header of app.asar, which the fuse does validate, holds the SHA-256 of every file it lists, the unpacked ones included. At launch, each
// unpacked script is hashed and compared with it: an altered or missing script stops the launch, with a message. Compiled libraries (`.node`) are
// left out: they are signed after the archive is made, so their hash no longer matches, and macOS checks their signature when it loads them.
// Nothing is checked when the application does not run from an app.asar (a development build).

import { createHash } from 'node:crypto'
import { join, sep } from 'node:path'

/** The part of `fs` that is used: the one of Electron that does not look into archives (`original-fs`), or Node's in a test. */
export interface PlainFs {
  openSync(path: string, flags: 'r'): number
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  closeSync(fd: number): void
  readFileSync(path: string): Buffer
}

/** The header of this application is a few hundred kilobytes: a length far from it is not one. */
const HEADER_MAX = 64 * 1024 * 1024

export type UnpackedVerdict =
  /** The file is the one the archive was sealed with. */
  | 'intact'
  /** Its content is not the one the header holds. */
  | 'altered'
  /** The header lists it and it is not on disk. */
  | 'missing'
  /** The header holds no SHA-256 for it: nothing to compare with (a package made by another tool). */
  | 'unsealed'

export interface UnpackedCheck {
  /** The path inside the archive, with `/`. */
  path: string
  verdict: UnpackedVerdict
}

/** The archive a path of the running code is in: `…/Resources/app.asar` for a file of `…/Resources/app.asar/out/main`, null outside an archive. */
export function archiveOf(codePath: string): string | null {
  for (const marker of [`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`]) {
    const at = codePath.indexOf(marker)
    if (at !== -1) return `${codePath.slice(0, at)}${sep}app.asar`
  }
  return codePath.endsWith(`${sep}app.asar`) ? codePath : null
}

/** The scripts the header of an archive lists as unpacked, with the SHA-256 it holds for each (null: none). Throws when the file is not an archive. */
export function unpackedScripts(archive: string, fs: PlainFs): Array<{ path: string; sha256: string | null }> {
  const fd = fs.openSync(archive, 'r')
  let text: string
  try {
    const head = Buffer.alloc(16)
    if (fs.readSync(fd, head, 0, 16, 0) !== 16 || head.readUInt32LE(0) !== 4) throw new Error(`${archive} is not an asar archive`)
    const length = head.readUInt32LE(12)
    if (length === 0 || length > HEADER_MAX) throw new Error(`${archive} has a header of ${length} bytes`)
    const body = Buffer.alloc(length)
    if (fs.readSync(fd, body, 0, length, 16) !== length) throw new Error(`${archive} is shorter than its header says`)
    text = body.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
  const found: Array<{ path: string; sha256: string | null }> = []
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node !== 'object' || node === null) return
    const files = (node as { files?: unknown }).files
    if (typeof files !== 'object' || files === null) return
    for (const [name, child] of Object.entries(files as Record<string, unknown>)) {
      if (typeof child !== 'object' || child === null) continue
      const path = prefix === '' ? name : `${prefix}/${name}`
      if ('files' in child) walk(child, path)
      else if ((child as { unpacked?: unknown }).unpacked === true && /\.(js|cjs|mjs)$/.test(name)) {
        const integrity = (child as { integrity?: { algorithm?: unknown; hash?: unknown } }).integrity
        found.push({ path, sha256: integrity?.algorithm === 'SHA256' && typeof integrity.hash === 'string' ? integrity.hash.toLowerCase() : null })
      }
    }
  }
  walk(JSON.parse(text) as unknown, '')
  return found
}

/** Each unpacked script of an archive, compared with what its header holds. */
export function checkUnpackedScripts(archive: string, fs: PlainFs): UnpackedCheck[] {
  return unpackedScripts(archive, fs).map(({ path, sha256 }) => {
    if (sha256 === null) return { path, verdict: 'unsealed' }
    let content: Buffer
    try {
      content = fs.readFileSync(join(`${archive}.unpacked`, ...path.split('/')))
    } catch {
      // Not there, or not readable: either way the script the archive was sealed with cannot be the one that runs.
      return { path, verdict: 'missing' }
    }
    return { path, verdict: createHash('sha256').update(content).digest('hex') === sha256 ? 'intact' : 'altered' }
  })
}

export interface UnpackedGuardHost {
  /** A path of the running code (`__dirname`). */
  codePath: string
  fs: () => PlainFs
  /** Says to the user why the application does not start (a box of the system: no window exists that could be trusted to say it). */
  tell: (files: string[]) => void
  warn: (message: string) => void
}

/**
 * Stops the launch (throws, after telling the user) when a script outside the archive is not the one the archive was sealed with, or when the
 * archive cannot be read: its preloads would run in every page. A script the header holds no hash for is only reported: nobody who writes into
 * the bundle can make the header say so, since the fuse validates it.
 */
export function refuseAlteredScripts(host: UnpackedGuardHost): void {
  const archive = archiveOf(host.codePath)
  if (archive === null) return
  let checks: UnpackedCheck[]
  try {
    checks = checkUnpackedScripts(archive, host.fs())
  } catch (error) {
    host.tell([])
    throw new Error(`[engine] cannot read what ${archive} was sealed with: ${(error as Error).message}`)
  }
  const unsealed = checks.filter((check) => check.verdict === 'unsealed').map((check) => check.path)
  if (unsealed.length > 0) host.warn(`[engine] app.asar holds no hash for ${unsealed.join(', ')}: these scripts run unchecked`)
  const refused = checks.filter((check) => check.verdict === 'altered' || check.verdict === 'missing')
  if (refused.length === 0) return
  host.tell(refused.map((check) => check.path))
  throw new Error(`[engine] scripts outside app.asar are not the ones it was sealed with: ${refused.map((check) => `${check.path} (${check.verdict})`).join(', ')}`)
}
