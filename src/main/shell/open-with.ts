// Hands a downloaded file to an application the user chose ("Ouvrir avec…"), with macOS's `open -a`. The application comes from a dialog
// or from the saved list, the file from the downloads: both are checked again here, right before the call, because the list is a file
// on disk and the name of the file is the page's. Nothing is run through a shell, and nothing that could execute is handed over.

import { execFile } from 'node:child_process'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { isApplicationPath, isExecutableDownload } from '@shared/open-with'

export type OpenWithOutcome = { ok: true } | { ok: false; reason: string }

/** The calls this module makes to the system: a seam for the tests that force each refusal and each failure. */
export interface OpenWithDeps {
  /** What the path is, without following a link: null when it does not exist. */
  inspect(path: string): { file: boolean; folder: boolean; link: boolean; mode: number } | null
  /** Whether the path (links followed) is a folder. */
  isFolder(path: string): boolean
  exists(path: string): boolean
  run(command: string, args: string[]): Promise<void>
}

const realDeps: OpenWithDeps = {
  inspect: (path) => {
    try {
      const stat = lstatSync(path)
      return { file: stat.isFile(), folder: stat.isDirectory(), link: stat.isSymbolicLink(), mode: stat.mode }
    } catch {
      // A path that cannot be examined is a path that is not there, for the one question asked of it: is it a file I may hand over.
      return null
    }
  },
  isFolder: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  exists: (path) => existsSync(path),
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 15_000 }, (error) => (error ? reject(error) : resolve()))
    })
}

/** Opens `file` with `app` (a `….app` bundle). Resolves with the reason in French-free plain text when it did not, for the log and the message. */
export async function openWithApplication(app: unknown, file: unknown, mimeType?: string, deps: OpenWithDeps = realDeps): Promise<OpenWithOutcome> {
  if (!isApplicationPath(app)) return { ok: false, reason: 'not an application path' }
  if (typeof file !== 'string' || !isAbsolute(file) || /\p{Cc}/u.test(file)) return { ok: false, reason: 'not a file path' }
  if (isExecutableDownload(basename(file), mimeType)) return { ok: false, reason: 'a file of that type is never opened this way' }
  if (!deps.isFolder(app) || !deps.exists(join(app, 'Contents', 'Info.plist'))) return { ok: false, reason: `${app} is not an application` }
  const found = deps.inspect(file)
  if (!found) return { ok: false, reason: 'the file is not there' }
  if (!found.file || found.link) return { ok: false, reason: 'not a plain file' }
  // A program has an execute bit; a downloaded document never does.
  if ((found.mode & 0o111) !== 0) return { ok: false, reason: 'the file is executable' }
  try {
    await deps.run('/usr/bin/open', ['-a', app, file])
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String((error as Error).message ?? error) }
  }
}
