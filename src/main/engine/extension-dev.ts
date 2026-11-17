// The developer's side of the extensions, for the Extensions page: the console of the service workers and of the pages of the extensions
// (recorded only while the page is open), the folders that would not load, the reload of an extension, and what the page shows of each
// one (manifest, folder, picture, state of the worker). Nothing here runs, listens or holds anything until the page asks: the engine
// creates the object at start, and an object with no listener and an empty journal costs nothing.

import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { app, nativeImage, webContents, type Session } from 'electron'
import { describeLoadError, describeManifest, type ExtensionDetail } from '@shared/extension-page'
import { ExtensionJournal, type JournalEntry, type JournalFilter } from '@shared/extension-journal'
import { ExtensionConsoleWatch, type ConsoleSource } from './extension-console'
import type { ExtensionInfo } from '@shared/ipc'
import { t } from '@shared/i18n'
import type { ExtensionDevTools } from './types'
import type { GrantedFacts } from '@shared/optional-permissions'

export type { ConsoleSource } from './extension-console'

const MESSAGES_MAX_BYTES = 1024 * 1024
const ICON_MAX_BYTES = 512 * 1024
/** How many pictures and texts of extensions are kept between two readings of the page (one each per extension and version). */
const CACHE_MAX = 200

/** A refusal that has a sentence for the person: the page shows it as it is. */
export class ExtensionDevError extends Error {}

export interface ExtensionDevHost {
  /** The session of each profile that exists. */
  sources(): ConsoleSource[]
  /** Every extension known, loaded in its profile or not. */
  known(): Array<{ info: ExtensionInfo; path: string; manifest: unknown }>
  isLoaded(profileId: string, extensionId: string): boolean
  workerRunning(profileId: string, extensionId: string): boolean
  unload(profileId: string, extensionId: string): void
  /** Loads the folder into the profile (the engine's own way: runtime scripts first, failures recorded). */
  load(profileId: string, path: string): Promise<ExtensionInfo>
  /** Takes the folder out of every profile and forgets it. */
  forgetFolder(path: string): void
  /** What the person granted the extension in the profile, on its request, of the permissions its manifest lists as facultative. */
  grantedOf(profileId: string, extensionId: string): GrantedFacts
  /** Takes one of them back. False when it was not held. */
  revokeGranted(profileId: string, extensionId: string, name: string): boolean
}

/** The texts of an extension's own language file, when its manifest names a default locale. */
async function catalogueOf(folder: string, manifest: unknown): Promise<unknown> {
  const locale = typeof manifest === 'object' && manifest !== null ? (manifest as { default_locale?: unknown }).default_locale : undefined
  if (typeof locale !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(locale)) return undefined
  const file = resolve(folder, '_locales', locale, 'messages.json')
  try {
    if ((await stat(file)).size > MESSAGES_MAX_BYTES) throw new Error('larger than 1 MiB')
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error) {
    console.warn(`[extensions] the texts of ${file} cannot be read; the description falls back to the manifest:`, (error as Error).message)
    return undefined
  }
}

/** The extension's own picture as a small `data:` URL, or undefined (a folder without icons is common: that is not worth a line in the log). */
async function iconOf(folder: string, manifest: unknown): Promise<string | undefined> {
  const icons = typeof manifest === 'object' && manifest !== null ? (manifest as { icons?: unknown }).icons : undefined
  if (typeof icons !== 'object' || icons === null) return undefined
  const best = Object.entries(icons as Record<string, unknown>)
    .filter(([size, file]) => /^\d{1,4}$/.test(size) && typeof file === 'string')
    .sort(([a], [b]) => Number(b) - Number(a))[0]
  if (!best) return undefined
  const path = resolve(folder, String(best[1]))
  if (!path.startsWith(`${resolve(folder)}${sep}`)) return undefined
  try {
    if ((await stat(path)).size > ICON_MAX_BYTES) throw new Error('larger than 512 KiB')
    const image = nativeImage.createFromBuffer(await readFile(path))
    return image.isEmpty() ? undefined : image.resize({ width: 64, height: 64 }).toDataURL()
  } catch (error) {
    console.warn(`[extensions] the icon ${path} cannot be used:`, (error as Error).message)
    return undefined
  }
}

export class ExtensionDev implements ExtensionDevTools {
  private readonly journal = new ExtensionJournal()
  private readonly watch: ExtensionConsoleWatch
  /** The last failed load of a folder in a profile, until a load of it works. At most one line per folder and profile. */
  private readonly failures = new Map<string, string>()
  private readonly cache = new Map<string, { icon?: string; catalogue: unknown }>()

  constructor(private readonly host: ExtensionDevHost) {
    this.watch = new ExtensionConsoleWatch(this.journal, {
      sources: () => host.sources(),
      // Electron's own: a page of the application is made, and the pages that exist now.
      onContentsCreated: (listener) => {
        app.on('web-contents-created', listener)
        return () => app.off('web-contents-created', listener)
      },
      contents: () => webContents.getAllWebContents()
    })
  }

  // ---- loads that failed ----

  /** A load did not work: the sentence goes to the journal (whoever is listening or not) and is kept as the state of that folder in that profile. */
  failed(profileId: string, path: string, extensionId: string | undefined, reason: unknown): string {
    // A sentence of ours is kept as it is; what Chromium said is put in words first.
    const message = typeof reason === 'string' ? reason : describeLoadError(reason, path)
    this.failures.set(`${profileId}\n${path}`, message)
    this.journal.add({ at: Date.now(), level: 'error', source: 'load', profileId, ...(extensionId !== undefined ? { extensionId } : {}), message, where: path })
    return message
  }

  /**
   * A line of the browser itself in the journal of an extension: something it asked for and was refused, in the words the person reads.
   * Said again, the same sentence is one line, the newest.
   */
  note(profileId: string, extensionId: string, message: string): void {
    const same = this.journal.list({ profileId, extensionId }).filter((entry) => entry.source === 'browser' && entry.message === message)
    if (same.length > 0) this.journal.remove(same.map((entry) => entry.id))
    this.journal.add({ at: Date.now(), level: 'warning', source: 'browser', profileId, extensionId, message })
  }

  loaded(profileId: string, path: string): void {
    this.failures.delete(`${profileId}\n${path}`)
  }

  failure(profileId: string, path: string): string | undefined {
    return this.failures.get(`${profileId}\n${path}`)
  }

  // ---- the console ----

  watchConsoles(): () => void {
    return this.watch.start()
  }

  attach(profileId: string, session: Session): void {
    this.watch.attach({ profileId, session })
  }

  isWatching(): boolean {
    return this.watch.isWatching()
  }

  readJournal(filter: JournalFilter & { since?: number } = {}): JournalEntry[] {
    return this.journal.list(filter)
  }

  lastJournalId(): number {
    return this.journal.lastId()
  }

  clearJournal(filter: JournalFilter = {}): number {
    return this.journal.clear(filter)
  }

  /** Forgets the entries with these numbers, and no other. */
  removeJournalEntries(ids: readonly number[]): void {
    this.journal.remove(ids)
  }

  // ---- what the page shows ----

  async details(): Promise<ExtensionDetail[]> {
    return Promise.all(
      this.host.known().map(async ({ info, path, manifest }): Promise<ExtensionDetail> => {
        const key = `${path}\n${info.version}`
        let cached = this.cache.get(key)
        if (!cached) {
          cached = { catalogue: await catalogueOf(path, manifest), ...(await iconOf(path, manifest).then((icon) => (icon === undefined ? {} : { icon }))) }
          if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string)
          this.cache.set(key, cached)
        }
        const failure = this.failure(info.profileId, path)
        const granted = this.host.grantedOf(info.profileId, info.id)
        return {
          profileId: info.profileId,
          id: info.id,
          path,
          facts: manifest === null || manifest === undefined ? null : describeManifest(manifest, cached.catalogue),
          workerRunning: this.host.workerRunning(info.profileId, info.id),
          ...(cached.icon !== undefined ? { icon: cached.icon } : {}),
          ...(failure !== undefined ? { failure } : {}),
          ...(granted.permissions.length > 0 || granted.origins.length > 0 ? { granted } : {})
        }
      })
    )
  }

  folderOf(profileId: string, extensionId: string): { path: string; name: string; version: string; source: ExtensionInfo['source'] } | null {
    const entry = this.host.known().find((e) => e.info.profileId === profileId && e.info.id === extensionId)
    return entry ? { path: entry.path, name: entry.info.name, version: entry.info.version, source: entry.info.source } : null
  }

  // ---- reload and removal ----

  failureOf(profileId: string, extensionId: string): string | undefined {
    const entry = this.host.known().find((e) => e.info.profileId === profileId && e.info.id === extensionId)
    return entry && !this.host.isLoaded(profileId, extensionId) ? this.failure(profileId, entry.path) : undefined
  }

  /**
   * Unloads the extension from the profile and loads its folder again: what a developer does after an edit. An extension that is not loaded because its
   * last load failed is only loaded (the developer fixed the folder and tries again). One the user switched off is not touched. Rejects with a sentence for the person.
   */
  async reload(profileId: string, extensionId: string): Promise<ExtensionInfo> {
    const entry = this.host.known().find((e) => e.info.profileId === profileId && e.info.id === extensionId)
    if (!entry) throw new ExtensionDevError(t('extpage.cette-extension-n-est-pas-chargee-dans-ce-profil'))
    if (this.host.isLoaded(profileId, extensionId)) this.host.unload(profileId, extensionId)
    else if (this.failure(profileId, entry.path) === undefined) throw new ExtensionDevError(t('extpage.activez-l-extension-avant-de-la-recharger'))
    return this.host.load(profileId, entry.path)
  }

  revokeGranted(profileId: string, extensionId: string, name: string): boolean {
    return this.host.revokeGranted(profileId, extensionId, name)
  }

  /** The folder of an extension loaded from a folder, once it is out of every profile; null for an extension that is not one (the Web Store's are uninstalled, not forgotten). */
  removeFolder(extensionId: string): { path: string; name: string } | null {
    const entry = this.host.known().find((e) => e.info.id === extensionId && e.info.source === 'unpacked')
    return entry ? this.removeFolderAt(entry.path) : null
  }

  /** The same, named by the folder (a folder taken out of Settings): null when no extension known in any profile comes from it, as when it was removed already. */
  removeFolderAt(path: string): { path: string; name: string } | null {
    const entry = this.host.known().find((e) => e.path === path && e.info.source === 'unpacked')
    if (!entry) return null
    this.host.forgetFolder(path)
    return { path, name: entry.info.name }
  }
}
