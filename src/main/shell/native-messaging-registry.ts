// Windows: where the manifests of Chrome's native messaging hosts are, according to the registry (the keys are in shared/native-messaging.ts). Read only,
// and without a native module: the system's own reg.exe writes a key to a file of a throw-away folder (`reg export`), and the file is read here. `reg query`
// would print the value in the console's code page (850 in France, not UTF-8), which turns a path with an accent into another path; the file of `reg export`
// is UTF-16 whatever the language of the system.

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type HostRegistryKey, isRegistryManifestPath, nativeHostRegistryKeys, parseRegistryExport } from '@shared/native-messaging'
import type { PlatformId } from '@shared/platform'
import { readBoundedText } from './bounded-file'

/** reg.exe answers at once; one that does not is stopped, and the lookup fails rather than waits. */
const REG_TIMEOUT_MS = 5000
/** The export of a key with its sub-keys: a host's key holds the manifest's path and nothing else, so this is far more than it takes. */
const MAX_EXPORT_BYTES = 256 * 1024

/** What `execFile` does, reduced to what is used here (so that a test can stand in for the program). */
export type RunProgram = (file: string, args: string[], options: { windowsHide: true; timeout: number }, done: (error: (Error & { code?: unknown; killed?: boolean }) | null) => void) => unknown

/**
 * The text of the `reg export` of one key, or null when the key is not there (the normal case: a host is registered under one root, not under every one).
 * Throws when reg.exe could not run or did not finish, or when its file cannot be read: that is not "no such host", the extension is told the start failed.
 */
export async function exportRegistryKey(key: HostRegistryKey, run: RunProgram = execFile as RunProgram): Promise<string | null> {
  const folder = await mkdtemp(join(tmpdir(), 'lucium-reg-'))
  try {
    const file = join(folder, 'key.reg')
    // By its full path: a program found through the search path is whichever comes first in it.
    const reg = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe')
    const exit = await new Promise<number>((resolve, reject) => {
      run(reg, ['export', `${key.hive}\\${key.key}`, file, '/y', `/reg:${key.view}`], { windowsHide: true, timeout: REG_TIMEOUT_MS }, (error) => {
        if (!error) return resolve(0)
        // A number is the exit status of reg.exe (1 for a key that is not there); a timeout or a program that does not exist is not an answer.
        if (typeof error.code === 'number' && !error.killed) return resolve(error.code)
        reject(error)
      })
    })
    if (exit !== 0) return null
    const read = await readBoundedText(file, MAX_EXPORT_BYTES, (bytes) => new TextDecoder('utf-16le', { fatal: true }).decode(bytes))
    if (!read.ok) throw new Error(`the export of ${key.hive}\\${key.key} cannot be read (${read.reason}${read.detail ? `: ${read.detail}` : ''})`)
    return read.text
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/**
 * The manifests the registry names for a host, one at a time and in Chrome's order, so that the keys after the one that answers are not asked for.
 * A value that is not a local path is ignored with a line in the journal (`isRegistryManifestPath`). Nothing is asked unless the user allowed Chrome's
 * hosts and the system is Windows (`nativeHostRegistryKeys`).
 */
export async function* registeredManifests(
  hostName: string,
  includeChrome: boolean,
  platform: PlatformId,
  exportKey: (key: HostRegistryKey) => Promise<string | null> = exportRegistryKey
): AsyncGenerator<string> {
  const seen = new Set<string>()
  for (const key of nativeHostRegistryKeys(hostName, includeChrome, platform)) {
    const text = await exportKey(key)
    const value = text === null ? null : parseRegistryExport(text)
    if (value === null) continue
    if (!isRegistryManifestPath(value)) {
      console.warn(`[native] ${key.hive}\\${key.key} (${key.view}-bit view) names "${value}", which is not a local path: ignored`)
      continue
    }
    if (seen.has(value)) continue
    seen.add(value)
    yield value
  }
}
