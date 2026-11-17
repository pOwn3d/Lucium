// What erasing a tab container really does, without Electron: the session is handed in as a stand-in so each rule is tested
// (container-store.test.ts), and the engine test (smoke-containers.ts) checks the same thing on a real session.

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CONTAINER_DIR_PREFIX, isContainerId } from '@shared/container-id'
import { t } from '@shared/i18n'

/** The part of an Electron `Session` that holds data a container keeps. */
export interface WipableSession {
  /** The folder of its data, null for a session that lives in memory. */
  getStoragePath(): string | null
  clearData(): Promise<void>
  clearStorageData(): Promise<void>
  clearCache(): Promise<void>
  clearCodeCaches(options: { urls: string[] }): Promise<void>
  clearAuthCache(): Promise<void>
  clearHostResolverCache(): Promise<void>
  clearSharedDictionaryCache(): Promise<void>
  closeAllConnections(): Promise<void>
  flushStorageData(): void
}

/** What was decided for a session and lives outside it: the invalid certificates let through (`CertificateExceptions`), the hosts held to strict transport security. */
export interface SessionDecisions {
  forget(session: WipableSession): void
}

/** A step of the erasure, by what it erases: the words the user reads are looked up when the sentence is made (`wipeFailure`). */
export type WipeStep = 'site-data' | 'storage' | 'cache' | 'code-cache' | 'http-auth' | 'dns-cache' | 'compression-dictionaries' | 'connections' | 'disk'

const STEP_NAMES: Record<WipeStep, () => string> = {
  'site-data': () => t('container-store.les-donnees-du-site'),
  storage: () => t('container-store.le-stockage'),
  cache: () => t('container-store.le-cache'),
  'code-cache': () => t('container-store.le-cache-de-code'),
  'http-auth': () => t('container-store.les-identifiants-http'),
  'dns-cache': () => t('container-store.le-cache-dns'),
  'compression-dictionaries': () => t('container-store.les-dictionnaires-de-compression'),
  connections: () => t('container-store.les-connexions'),
  disk: () => t('container-store.l-ecriture-sur-le-disque')
}

/**
 * Cookies, storage (local, session, IndexedDB, cache storage, service workers, file systems), HTTP cache, logins and connections of a
 * session. Every step is tried whatever happens to the others; the ones that failed are named in the answer (empty: all of it is gone),
 * each logged with the container it concerns. The session is flushed last, so that what was erased is erased on disk too.
 * The invalid certificates the user let through in the session are forgotten once its connections are closed: Electron hands the same session
 * back to a container that is opened again, and what was accepted before the erasure must be asked about again.
 */
export async function wipeSession(ses: WipableSession, what: string, decisions: SessionDecisions): Promise<WipeStep[]> {
  const steps: Array<[WipeStep, () => Promise<unknown>]> = [
    ['site-data', () => ses.clearData()],
    // The older call names the storages by kind: it also reaches what the new one's default may not list.
    ['storage', () => ses.clearStorageData()],
    ['cache', () => ses.clearCache()],
    // The compiled scripts of the pages visited are kept by address: they would tell which sites were.
    ['code-cache', () => ses.clearCodeCaches({ urls: [] })],
    ['http-auth', () => ses.clearAuthCache()],
    ['dns-cache', () => ses.clearHostResolverCache()],
    ['compression-dictionaries', () => ses.clearSharedDictionaryCache()],
    ['connections', () => ses.closeAllConnections()]
  ]
  const failed: WipeStep[] = []
  for (const [step, run] of steps) {
    try {
      await run()
    } catch (error) {
      failed.push(step)
      console.error(`[containers] cannot erase the ${step} of ${what}:`, error)
    }
  }
  try {
    decisions.forget(ses)
  } catch (error) {
    // What is kept beside the session is a file: one that cannot be removed is a failure of the disk, named to the user as such.
    failed.push('disk')
    console.error(`[containers] cannot forget what was decided for ${what}:`, error)
  }
  try {
    ses.flushStorageData()
  } catch (error) {
    failed.push('disk')
    console.error(`[containers] cannot flush the storage of ${what}:`, error)
  }
  return failed
}

/**
 * A sentence for the user about what could not be erased (the caller throws it, so that nobody says "erased" for a container that kept something).
 * Each step is named on its own, as an item of the list the sentence holds.
 */
export const wipeFailure = (name: string, failed: readonly WipeStep[]): Error =>
  new Error(t('container-store.impossible-d-effacer-what-du-conteneur-name', { what: failed.map((step) => STEP_NAMES[step]()).join(', '), name }))

/**
 * Removes the folders of containers from `Partitions/`. An id that is not a plain slug is refused (it could name a path outside the folder);
 * a folder that cannot be removed does not stop the others, and is logged with its id. Answers the ids removed and those that failed.
 */
export function removeContainerFolders(partitions: string, ids: readonly string[], remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })): { removed: string[]; failed: string[] } {
  const removed: string[] = []
  const failed: string[] = []
  for (const id of ids) {
    if (!isContainerId(id)) {
      console.error(`[containers] refused to remove the folder of an invalid container id: ${String(id).slice(0, 40)}`)
      failed.push(String(id))
      continue
    }
    try {
      remove(join(partitions, `${CONTAINER_DIR_PREFIX}${id}`))
      removed.push(id)
    } catch (error) {
      failed.push(id)
      console.error(`[containers] cannot remove the folder of container ${id}:`, error)
    }
  }
  return { removed, failed }
}

/** How deep the last write of a container's folder is looked for: the files Chromium rewrites while a session is used (cookies, storage, cache index) are within. */
const LAST_WRITE_DEPTH = 3

/**
 * When something was last written in the folder of a container (ms since the epoch): the newest modification time of the folder and of what it
 * holds, `LAST_WRITE_DEPTH` levels down. Null when it cannot be told: an id that is not a plain slug, no folder, or an entry that cannot be read
 * (logged with the container). A caller that removes folders by their age keeps one whose age is unknown.
 */
export function containerFolderLastWrite(partitions: string, id: string, fs: { readdirSync: typeof readdirSync; statSync: typeof statSync } = { readdirSync, statSync }): number | null {
  if (!isContainerId(id)) return null
  const newest = (path: string, depth: number): number => {
    const stat = fs.statSync(path)
    if (!stat.isDirectory() || depth >= LAST_WRITE_DEPTH) return stat.mtimeMs
    return Math.max(stat.mtimeMs, ...fs.readdirSync(path).map((name) => newest(join(path, name), depth + 1)))
  }
  try {
    return newest(join(partitions, `${CONTAINER_DIR_PREFIX}${id}`), 0)
  } catch (error) {
    console.error(`[containers] cannot tell when the folder of container ${id} was last written, it is kept:`, error)
    return null
  }
}
