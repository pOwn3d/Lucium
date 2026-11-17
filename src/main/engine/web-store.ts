// Installing extensions from the Chrome Web Store: the part of the engine that drives electron-chrome-web-store (MIT, pinned in
// package.json). The library does the work (the store page's `chrome.webstorePrivate` bridge, the download, the unpacking, the update
// protocol) and trusts more than it should: it checks the store's origin with `startsWith`, takes the manifest the sheet would show from
// the page, fetches whatever address the page names for an icon, reads packages of any size, uninstalls without asking and starts
// checking for updates by itself. This file puts the browser's own rules around it:
//
//  - the library is loaded lazily, only when the setting allows installing, with `fetch` replaced while it loads (web-store-network.ts), and
//    what that fetch sends goes out over Electron's network stack in the application's session (web-store-transport.ts), so that the user's
//    proxy and encrypted DNS apply, which the `fetch` of Node ignores;
//  - its IPC channels are registered through a gate: exact store origin, top frame, a tab of ours, a recent click, the setting on;
//  - the sheet shows the manifest of the package that was downloaded (into a staging folder), never the one the page claims, and
//    the package only moves into the profile's folder when the user agrees;
//  - an update that asks for more than the installed version is held back until the user has seen the difference;
//  - nothing goes to Google until the user acts (opening the store, clicking "Ajouter", asking for an update), unless they chose a schedule.

import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ipcMain, nativeImage, net, session as electronSession, webContents as webContentsApi, type IpcMainInvokeEvent, type Session, type WebContents, type WebFrameMain } from 'electron'
import type * as Library from 'electron-chrome-web-store'
import { addedAccess, cleanText, isExtensionId, reviewManifest, type ExtensionReview } from '@shared/extension-review'
import { isPublicSuffix } from '@shared/party'
import type { WebStoreUpdates } from '@shared/model'
import { STORE_ORIGIN, STORE_VERSION_REPORTED, isStoreOrigin, updateDue, updateSummary, versionForStore, type UpdateReport } from '@shared/web-store'
import { recentGesture } from '@shared/web-auth'
import type { CrxScan } from './crx-scan'
import type { ExtensionLedger } from './extension-ledger'
import type { ExtensionReviewAsk } from './types'
import { createStoreFetch, type StoreRequestInfo } from './web-store-network'
import { updaterSession, type UpdaterExtensions } from './web-store-updates'
import { createSessionTransport } from './web-store-transport'
import { STAGING_DIR, STORE_DIR, closeStoreDirectory, extensionDirectory, ownerOnlyDirectory, profileDirectory, storedExtensions, type StoredExtension } from './web-store-files'
import { t } from '@shared/i18n'
import { prepareContentPreludeSafely } from './content-prelude'
import { registerLimitedPreload } from './extension-runtime'
import { settingsPath } from '@shared/settings-path'
import { assertTestRun } from '../test-seam'

const PRELOAD_ID = 'electron-chrome-web-store'
/** The documents the script of the store is loaded into: the store's own origin, nothing that only starts like it. */
export const STORE_PAGES = `${STORE_ORIGIN}/*`
const VERSION_CHANNEL = 'chromeWebstore.getFullChromeVersion'
/** The channels the gate must have wrapped: if the library stops registering them through `ipcMain.handle`, it changed and nothing is installed. */
const REQUIRED_CHANNELS = ['chromeWebstore.beginInstall', 'chromeWebstore.getFullChromeVersion', 'chromeWebstore.getExtensionStatus', 'chrome.management.getAll', 'chrome.management.uninstall']
const UNINSTALL_CHANNEL = 'chrome.management.uninstall'
const BEGIN_INSTALL_CHANNEL = 'chromeWebstore.beginInstall'
/** The two calls that change what is installed: a store page may make them only just after a click or a key press of the user. */
const GESTURE_CHANNELS = new Set([BEGIN_INSTALL_CHANNEL, UNINSTALL_CHANNEL])
const ICON_MAX_BYTES = 512 * 1024
const MESSAGES_MAX_BYTES = 1024 * 1024
const UPDATE_CHECK_EVERY_MS = 3_600_000
const FIRST_CHECK_DELAY_MS = 60_000
/**
 * The folders of a partition where Chromium keeps an extension's `chrome.storage` areas, one database per extension named by its id.
 * `Extension State` is one database shared by all the extensions (keys prefixed with the id): it is not removed.
 */
const SETTINGS_FOLDERS = ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings']
/** A transparent picture of one pixel: what the library is handed instead of the picture the store page names (see `pictureOfPage`). */
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

/** What the library's `beforeInstall` receives (its type is not exported). `manifest` is what the store page claims: it is not trusted. */
interface InstallDetails {
  id: string
  localizedName: string
  manifest: unknown
  frame: WebFrameMain
}

export interface InstalledExtension {
  id: string
  name: string
  version: string
  manifest: unknown
  path: string
}

/** What the web store needs from the engine. */
export interface WebStoreHost {
  userData(): string
  ledger(): ExtensionLedger
  /** The profile a session belongs to. */
  profileOfSession(session: Session): string | undefined
  /** The page id of a tab's contents (undefined for anything that is not a tab: a panel, a popup, a private page). */
  pageIdOf(contents: WebContents): string | undefined
  /** When the user last pressed a key or a mouse button anywhere in the application. */
  lastUserInput(): number
  /** The extensions installed from the store in a profile, loaded or not. */
  installed(profileId: string): InstalledExtension[]
  isInstalled(profileId: string, extensionId: string): boolean
  /** Takes the extension out of the profile's session (it stays on disk). */
  unload(profileId: string, extensionId: string): void
  /** An extension is about to be loaded into the profile's session (an install, an update): the engine puts the scripts extensions need in it first. */
  prepareLoad(profileId: string): void
  /** The shell's sheet. */
  ask(ask: ExtensionReviewAsk): Promise<boolean>
  notify(message: string): void
  /** A store page asked to remove an extension: the shell confirms with the user, then calls `uninstall`. */
  requestUninstall(profileId: string, extensionId: string): void
}

/** The files of an extension that was just downloaded, as far as the sheet needs them. */
interface Staged {
  dir: string
  manifest: unknown
  review: ExtensionReview
  icon?: string
}

class UpdateNeedsApproval extends Error {
  constructor(readonly extensionId: string) {
    super(`the update of ${extensionId} asks for more than the installed version`)
    this.name = 'UpdateNeedsApproval'
  }
}

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type Library_ = typeof Library

const pending = (profileId: string, extensionId: string): string => `${profileId}:${extensionId}`

export class WebStore {
  private library_: Library_ | null = null
  private enabled = false
  private updates: WebStoreUpdates = 'manual'
  private readonly sessions = new Map<string, Session>()
  private readonly attached = new Set<string>()
  private readonly reviewing = new Set<string>()
  /** Set once the library's channels went through the gate. */
  private gated = false
  private broken = false
  private timer: NodeJS.Timeout | null = null
  private firstCheck: NodeJS.Timeout | null = null
  private checking: Promise<UpdateReport> | null = null
  /** Set while the library checks for updates: what is installed, to compare with what arrives. */
  private updating: { profileId: string; installed: Map<string, InstalledExtension> } | null = null
  /** What the guard held back during the check that is running (an update that asks for more), by `profile:extension`. */
  private readonly held = new Map<string, { version: string; name: string }>()
  /** Updates held back for the user's agreement, by `profile:extension`. */
  private readonly waiting = new Map<string, { version: string; name: string }>()
  private test: { transport?: typeof fetch; rewrite: (url: URL) => URL; publisherKeys?: ReadonlySet<string> } | null = null
  private transport_: typeof fetch | null = null
  /** Folders an install that never finished left behind are cleared once, as the first settings arrive. */
  private stagingCleared = false
  /** True only while the library's `beginInstall` runs its first, synchronous part (see `pictureOfPage`). */
  private installStarting = false
  /** The Chromium version the store's page is told (see `versionForStore`); null tells it the real one. */
  private reportedVersion: string | null = STORE_VERSION_REPORTED
  /** What went out to the network through the guard (the engine check reads it). */
  readonly requests: StoreRequestInfo[] = []
  /** The hosts the guard refused to contact (a picture the page named, a redirect elsewhere). */
  readonly refused: string[] = []

  constructor(private readonly host: WebStoreHost) {}

  // ---- configuration ----

  /**
   * Engine checks only: where the guard really sends its requests (the address is rewritten; the transport is Electron's own unless the
   * check gives one). The rules of the guard apply to the address the library wrote.
   */
  useTestNetwork(test: { transport?: typeof fetch; rewrite: (url: URL) => URL; publisherKeys?: ReadonlySet<string> } | null): void {
    assertTestRun('useTestNetwork')
    this.test = test
  }

  /** What the guard sends with: Chromium's network stack, in the session of the application (it follows the global proxy; the DNS is the application's). */
  private ownTransport(): typeof fetch {
    return (this.transport_ ??= createSessionTransport((options) => net.request({ ...options, session: electronSession.defaultSession })))
  }

  configure(config: { install: boolean; updates: WebStoreUpdates }): void {
    if (!this.stagingCleared) {
      this.stagingCleared = true
      this.clearStaging().catch((error: unknown) => console.warn('[webstore] cannot clear the folders of installs that never finished:', error))
    }
    this.enabled = config.install
    this.updates = config.updates
    if (this.enabled) for (const profileId of this.sessions.keys()) this.attach(profileId)
    else for (const profileId of [...this.attached]) this.detach(profileId)
    this.schedule()
  }

  /** A profile's session exists: when the setting allows it, the store's pages can install into it. */
  addProfile(profileId: string, session: Session): void {
    this.sessions.set(profileId, session)
    if (this.enabled) this.attach(profileId)
  }

  isAttached(profileId: string): boolean {
    return this.attached.has(profileId)
  }

  /** Engine checks only: the version of Chromium the store's page is told, or null for the real one. */
  setReportedVersion(version: string | null): void {
    this.reportedVersion = version
  }

  pendingUpdate(profileId: string, extensionId: string): { version: string } | undefined {
    const waiting = this.waiting.get(pending(profileId, extensionId))
    return waiting ? { version: waiting.version } : undefined
  }

  /** The extensions installed in a profile, to be loaded when it is created. */
  stored(profileId: string): Promise<StoredExtension[]> {
    return storedExtensions(join(this.host.userData(), STORE_DIR), profileId)
  }

  /** Folders left by an install that never finished are of no use and are never loaded: clear them as the application starts. */
  async clearStaging(): Promise<void> {
    await rm(join(this.host.userData(), STAGING_DIR), { recursive: true, force: true })
    try {
      await closeStoreDirectory(join(this.host.userData(), STORE_DIR))
    } catch (error) {
      console.warn('[webstore] the folder of the installed extensions stays readable by the other accounts of this Mac:', (error as Error).message)
    }
  }

  // ---- the library, behind its guard ----

  private lib(): Library_ {
    if (this.library_) return this.library_
    const req = createRequire(__filename)
    // The library keeps the `fetch` of the moment it is evaluated: if it were loaded before, it would use the unguarded one.
    if (req.cache[req.resolve('electron-chrome-web-store')]) throw new Error('electron-chrome-web-store was loaded before its network guard')
    const store = this
    const guarded = createStoreFetch({
      // Read at each request: the engine check points them at a local server after the library is loaded.
      get transport() {
        return store.test?.transport ?? store.ownTransport()
      },
      get rewrite() {
        return store.test?.rewrite
      },
      // The fake store of the engine test signs with a key of its own; the real one is asked for everywhere else.
      get publisherKeys() {
        return store.test?.publisherKeys
      },
      onRequest: (info) => {
        this.requests.push(info)
        if (this.requests.length > 200) this.requests.shift()
      },
      onRefused: (url, reason) => {
        console.warn(`[webstore] request to ${url.hostname} refused: ${reason}`)
        this.refused.push(url.hostname)
        if (this.refused.length > 200) this.refused.shift()
      },
      inspectPackage: (scan, url) => this.inspect(scan, url),
      answerLocally: (_url, method) => this.pictureOfPage(method)
    })
    const original = globalThis.fetch
    globalThis.fetch = guarded
    try {
      this.library_ = req('electron-chrome-web-store') as Library_
    } finally {
      globalThis.fetch = original
    }
    return this.library_
  }

  /** The library's own `ipcMain.handle` registrations go through the gate, for as long as `run` takes to register them. */
  private gating<T>(run: () => T): { result: T; channels: Set<string> } {
    const target = ipcMain as unknown as { handle: typeof ipcMain.handle }
    const hadOwn = Object.hasOwn(target, 'handle')
    const previous = target.handle
    const channels = new Set<string>()
    target.handle = ((channel: string, listener: Listener) => {
      channels.add(channel)
      return previous.call(ipcMain, channel, this.gate(channel, listener))
    }) as typeof ipcMain.handle
    try {
      return { result: run(), channels }
    } finally {
      if (hadOwn) target.handle = previous
      else delete (target as { handle?: unknown }).handle
    }
  }

  private attach(profileId: string): void {
    if (this.attached.has(profileId) || this.broken) return
    const session = this.sessions.get(profileId)
    if (!session) return
    try {
      const library = this.lib()
      const install = (): Promise<void> =>
        library.installChromeWebStore({
          session,
          extensionsPath: profileDirectory(join(this.host.userData(), STORE_DIR), profileId),
          // The library would look for updates at launch and every few hours by itself: updates are ours to start.
          autoUpdate: false,
          // Loading is the engine's: it records what it loads (manifests, lifecycle) and skips what a profile has switched off.
          loadExtensions: false,
          minimumManifestVersion: 3,
          beforeInstall: (details) => this.beforeInstall(profileId, details as unknown as InstallDetails)
        })
      let done: Promise<void>
      if (this.gated) done = install()
      else {
        // The library registers its channels once, the first time: that is the time to put the gate in front of them.
        const { result, channels } = this.gating(install)
        done = result
        const missing = REQUIRED_CHANNELS.filter((channel) => !channels.has(channel))
        if (missing.length > 0) {
          this.broken = true
          throw new Error(`electron-chrome-web-store no longer registers ${missing.join(', ')} through ipcMain.handle: update src/main/engine/web-store.ts`)
        }
        this.gated = true
      }
      this.attached.add(profileId)
      // The library registered its page script from inside the package, which Chromium cannot read in a packaged app (app.asar).
      session.unregisterPreloadScript(PRELOAD_ID)
      // For the pages of the store only. The script of the library looks at the start of the address alone, so it also handed its objects to a
      // site whose name merely begins like the store's; and every page of the profile read and compiled a script that is of no use to it.
      registerLimitedPreload(session, { id: PRELOAD_ID, type: 'frame', filePath: this.preloadPath(), matches: [STORE_PAGES] }, (error) =>
        console.warn(`[webstore] the script of the store could not be limited to the pages of the store for profile ${profileId}; it runs in every page, as before:`, error)
      )
      done.catch((error: unknown) => {
        console.error(`[webstore] the store could not be set up for profile ${profileId}:`, error)
        this.host.notify(t('web-store.le-chrome-web-store-n-a-pas-pu-etre-active-pour'))
        this.detach(profileId)
      })
    } catch (error) {
      console.error(`[webstore] cannot enable the Chrome Web Store for profile ${profileId}:`, error)
      this.host.notify(t('web-store.le-chrome-web-store-n-a-pas-pu-etre-active-voir'))
    }
  }

  private detach(profileId: string): void {
    if (!this.attached.delete(profileId)) return
    try {
      this.sessions.get(profileId)?.unregisterPreloadScript(PRELOAD_ID)
    } catch (error) {
      console.warn(`[webstore] the store's page script of profile ${profileId} was already gone:`, (error as Error).message)
    }
  }

  private preloadPath(): string {
    return createRequire(__filename).resolve('electron-chrome-web-store/preload').replace('app.asar', 'app.asar.unpacked')
  }

  // ---- the gate on the library's IPC ----

  /** Why a call from a page is refused, or null when it may go on. */
  refusal(channel: string, event: Pick<IpcMainInvokeEvent, 'senderFrame' | 'sender'>): string | null {
    if (!this.enabled) return 'installing from the Chrome Web Store is switched off'
    const frame = event.senderFrame
    if (!frame) return 'no sender frame'
    if (!isStoreOrigin(frame.origin)) return `origin ${frame.origin} is not the store`
    if (frame.parent !== null) return 'not the top frame of the page'
    const profileId = this.host.profileOfSession(event.sender.session)
    if (!profileId || !this.attached.has(profileId)) return 'not a profile with the store enabled'
    if (this.host.pageIdOf(event.sender) === undefined) return 'not a tab'
    if (GESTURE_CHANNELS.has(channel) && !recentGesture(this.host.lastUserInput(), Date.now())) return 'no click or key press just before'
    return null
  }

  /**
   * The answer to the one request the library makes in the synchronous part of `beginInstall`: the picture the store page names for its
   * dialog, which it fetches before anything else. The sheet shows the package's own icon (`iconOf`): the page's is never fetched, and the
   * library gets a blank picture instead. The guard has judged the address before this (a host that is not Google's is still refused).
   */
  pictureOfPage(method: string): Response | undefined {
    if (!this.installStarting || method !== 'GET') return undefined
    return new Response(new Uint8Array(BLANK_PNG), { status: 200, headers: { 'content-type': 'image/png' } })
  }

  private gate(channel: string, listener: Listener): Listener {
    return async (event, ...args) => {
      const why = this.refusal(channel, event)
      if (why !== null) {
        console.warn(`[webstore] ${channel} refused: ${why}`)
        return undefined
      }
      if (channel === UNINSTALL_CHANNEL) {
        // The library removes the extension without asking. The shell asks, then calls `uninstall`.
        const profileId = this.host.profileOfSession(event.sender.session)
        if (profileId && isExtensionId(args[0])) this.host.requestUninstall(profileId, args[0])
        return 'user_cancelled'
      }
      let pending: unknown
      // Only what the listener does before it first waits: the picture is its first request; the package comes later, from `beforeInstall`.
      this.installStarting = channel === BEGIN_INSTALL_CHANNEL
      try {
        pending = listener(event, ...args)
      } finally {
        this.installStarting = false
      }
      const result = await pending
      // The store's page decides from this version whether to trust the browser's own checks: see `versionForStore`.
      if (channel === VERSION_CHANNEL && this.reportedVersion !== null && typeof result === 'object' && result !== null) {
        const real = (result as { version_number?: unknown }).version_number
        return typeof real === 'string' ? { ...result, version_number: versionForStore(real, this.reportedVersion) } : result
      }
      return result
    }
  }

  // ---- install ----

  private async beforeInstall(profileId: string, details: InstallDetails): Promise<{ action: 'allow' | 'deny' }> {
    const deny = { action: 'deny' as const }
    const id = details.id
    const key = pending(profileId, id)
    // The gate has judged the call; the library hands the frame over again, and the answer must not depend on a single check.
    if (!this.enabled || !isExtensionId(id) || !isStoreOrigin(details.frame.origin) || !this.attached.has(profileId)) {
      console.warn(`[webstore] install of ${String(id)} refused before download (origin ${details.frame.origin})`)
      return deny
    }
    if (this.host.isInstalled(profileId, id)) {
      this.host.notify(t('web-store.cette-extension-est-deja-installee-dans-ce-profil', { settingsPath: settingsPath('extensions') }))
      return deny
    }
    if (this.reviewing.has(key)) return deny
    this.reviewing.add(key)
    const root = join(this.host.userData(), STORE_DIR)
    const stagingRoot = join(this.host.userData(), STAGING_DIR, profileId)
    const staged = join(stagingRoot, id)
    try {
      await this.downloadStaged(id, stagingRoot)
      const files = await this.readStaged(staged)
      if (!files.ok) {
        this.host.notify(files.reason)
        await rm(staged, { recursive: true, force: true })
        return deny
      }
      const contents = webContentsApi.fromFrame(details.frame)
      const pageId = contents ? this.host.pageIdOf(contents) : undefined
      const allowed = await this.host.ask({ profileId, ...(pageId ? { pageId } : {}), mode: 'install', extensionId: id, review: files.staged.review, ...(files.staged.icon ? { icon: files.staged.icon } : {}) })
      if (!allowed) {
        await rm(staged, { recursive: true, force: true })
        return deny
      }
      // The reviewed folder moves in as it is: the library then finds it installed and only loads it (no second download).
      const target = extensionDirectory(root, profileId, id)
      await mkdir(profileDirectory(root, profileId), { recursive: true, mode: 0o700 })
      await rm(target, { recursive: true, force: true })
      await rename(staged, target)
      await prepareContentPreludeSafely(target)
      // The library loads the extension as soon as this returns: the session must carry the scripts extensions need by then.
      this.host.prepareLoad(profileId)
      return { action: 'allow' }
    } catch (error) {
      console.error(`[webstore] cannot install ${id} in profile ${profileId}:`, error)
      this.host.notify(t('web-store.l-installation-a-echoue-message', { message: (error as Error).message }))
      await rm(staged, { recursive: true, force: true }).catch((cleanup: unknown) => console.warn(`[webstore] cannot clear ${staged}:`, cleanup))
      return deny
    } finally {
      this.reviewing.delete(key)
    }
  }

  /** Reads what the sheet shows from the folder the library unpacked: the manifest, the texts of the default language, the icon. */
  /**
   * Downloads and unpacks an extension under `<stagingRoot>/<id>`, in place of what an earlier try left there. The library makes the folders it
   * needs with the rights of the umask: the one in front of them is ours, and closed to the other accounts of the Mac.
   */
  private async downloadStaged(id: string, stagingRoot: string): Promise<void> {
    await rm(join(stagingRoot, id), { recursive: true, force: true })
    await ownerOnlyDirectory(join(this.host.userData(), STAGING_DIR))
    await this.lib().downloadExtension(id, stagingRoot)
  }

  private async readStaged(dir: string): Promise<{ ok: true; staged: Staged } | { ok: false; reason: string }> {
    const folder = await this.versionFolder(dir)
    if (!folder) return { ok: false, reason: t('web-store.le-paquet-telecharge-ne-contient-pas-d-extension') }
    let manifest: unknown
    try {
      // A byte order mark is skipped by its code point, written out so that no editor can drop it.
      manifest = JSON.parse((await readFile(join(folder, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''))
    } catch (error) {
      console.warn(`[webstore] the manifest of ${folder} cannot be read:`, error)
      return { ok: false, reason: t('web-store.le-manifeste-du-paquet-est-illisible') }
    }
    const catalogue = await this.catalogueOf(folder, manifest)
    const outcome = reviewManifest(manifest, catalogue, isPublicSuffix)
    if (!outcome.ok) return { ok: false, reason: outcome.reason }
    const icon = await this.iconOf(folder, manifest)
    return { ok: true, staged: { dir: folder, manifest, review: outcome.review, ...(icon ? { icon } : {}) } }
  }

  /** The `<version>_0` folder the library made under `<staging>/<id>`. */
  private async versionFolder(idDir: string): Promise<string | null> {
    const names = await readdir(idDir).catch((error: unknown) => {
      console.warn(`[webstore] ${idDir} was not written:`, (error as Error).message)
      return [] as string[]
    })
    const name = names.find((entry) => /^\d[\d.]*_\d+$/.test(entry))
    return name ? join(idDir, name) : null
  }

  private async catalogueOf(folder: string, manifest: unknown): Promise<unknown> {
    const locale = typeof manifest === 'object' && manifest !== null ? (manifest as { default_locale?: unknown }).default_locale : undefined
    if (typeof locale !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(locale)) return undefined
    const file = join(folder, '_locales', locale, 'messages.json')
    try {
      if ((await stat(file)).size > MESSAGES_MAX_BYTES) throw new Error('larger than 1 MiB')
      return JSON.parse(await readFile(file, 'utf8')) as unknown
    } catch (error) {
      console.warn(`[webstore] the texts of ${file} cannot be read; the name falls back to the manifest:`, (error as Error).message)
      return undefined
    }
  }

  /** The package's own icon, as a small picture the sheet can draw (the page's idea of the icon is not used). */
  private async iconOf(folder: string, manifest: unknown): Promise<string | undefined> {
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
      console.warn(`[webstore] the icon ${path} cannot be used:`, (error as Error).message)
      return undefined
    }
  }

  // ---- uninstall ----

  async uninstall(profileId: string, extensionId: string): Promise<void> {
    const target = extensionDirectory(join(this.host.userData(), STORE_DIR), profileId, extensionId)
    if (!this.host.installed(profileId).some((e) => e.id === extensionId)) throw new Error('This extension was not installed from the Chrome Web Store in this profile')
    this.host.unload(profileId, extensionId)
    await rm(target, { recursive: true, force: true })
    this.waiting.delete(pending(profileId, extensionId))
    this.host.ledger().forget(profileId, extensionId)
    // Its own storage and worker data go too, and only theirs: the origin is the extension's.
    await this.sessions.get(profileId)?.clearStorageData({ origin: `chrome-extension://${extensionId}` }).catch((error: unknown) => console.warn(`[webstore] cannot clear the data of ${extensionId}:`, error))
    await this.clearSettings(profileId, extensionId)
  }

  /**
   * `chrome.storage` is not web storage of the extension's origin: Chromium keeps it in folders of the partition, which `clearStorageData`
   * leaves alone. Settings and tokens would stay on disk and come back with a new install. Only the extension's own folders go, named by its
   * id, under the partition of the profile.
   */
  private async clearSettings(profileId: string, extensionId: string): Promise<void> {
    const partition = this.sessions.get(profileId)?.getStoragePath()
    if (!partition || !isExtensionId(extensionId)) return
    for (const folder of SETTINGS_FOLDERS) {
      const target = join(partition, folder, extensionId)
      await rm(target, { recursive: true, force: true }).catch((error: unknown) => console.warn(`[webstore] cannot remove ${folder} of ${extensionId} in profile ${profileId}:`, error))
    }
  }

  // ---- updates ----

  /** Called by the library's fetch for every package it downloads. During an update check, one that asks for more is refused. */
  private inspect(scan: CrxScan, url: URL): void {
    const context = this.updating
    if (!context) return
    const id = scan.extensionId
    // A package that does not say what it is cannot be compared with what is installed: it is not applied.
    if (!id) throw new Error(`the update at ${url.hostname} does not name its extension`)
    const installed = context.installed.get(id)
    if (installed === undefined) return
    const manifest = scan.manifest as { manifest_version?: unknown; version?: unknown }
    if (manifest.manifest_version !== 3) throw new Error(`the update of ${installed.name} is not a Manifest V3 package`)
    if (addedAccess(installed.manifest, scan.manifest, undefined, isPublicSuffix)) {
      this.held.set(pending(context.profileId, id), { version: cleanText(manifest.version, 40), name: installed.name })
      throw new UpdateNeedsApproval(id)
    }
  }

  checkUpdates(): Promise<UpdateReport> {
    this.checking ??= this.runUpdates().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async runUpdates(): Promise<UpdateReport> {
    const report: UpdateReport = { checked: 0, updated: [], waiting: [], failed: null }
    if (!this.enabled) return { ...report, failed: t('web-store.le-chrome-web-store-est-desactive-dans-les-reglages') }
    for (const profileId of this.attached) {
      const session = this.sessions.get(profileId)
      const installed = this.host.installed(profileId)
      if (!session || installed.length === 0) continue
      // The library looks only at the extensions loaded in the session: one switched off is not checked, and is not counted as checked.
      const loaded = installed.filter((e) => session.extensions.getExtension(e.id))
      if (loaded.length === 0) continue
      // The library is loaded for the first profile that has something to update: with nothing installed from the store it is never read.
      const library = this.lib()
      report.checked += loaded.length
      const before = new Map(installed.map((e) => [e.id, e.version]))
      this.updating = { profileId, installed: new Map(installed.map((e) => [e.id, e])) }
      const notLoaded: string[] = []
      // The library applies what it finds by itself: it is handed the session's extensions through `updaterSession`, so that an update loads
      // with its content prelude, and a version that does not load gives its place back to the installed one.
      const updater = updaterSession(
        session.extensions as unknown as UpdaterExtensions,
        {
          prepare: async (path) => {
            await prepareContentPreludeSafely(path)
            this.host.prepareLoad(profileId)
          },
          unload: (extensionId) => this.host.unload(profileId, extensionId),
          failed: (extensionId, error, restored) => {
            console.error(`[webstore] the update of ${extensionId} in profile ${profileId} did not load; the installed version ${restored ? 'is restored' : 'could not be restored'}:`, error)
            notLoaded.push(installed.find((e) => e.id === extensionId)?.name ?? extensionId)
          }
        },
        profileDirectory(join(this.host.userData(), STORE_DIR), profileId)
      )
      try {
        await library.updateExtensions(updater as unknown as Session)
      } catch (error) {
        console.error(`[webstore] the update check failed for profile ${profileId}:`, error)
        report.failed = (error as Error).message
      } finally {
        this.updating = null
      }
      if (notLoaded.length > 0) this.host.notify(t('web-store.mise-a-jour-non-chargee-names', { names: notLoaded.join(', ') }))
      for (const extension of this.host.installed(profileId)) {
        if (before.get(extension.id) !== extension.version) report.updated.push(extension.name)
        const key = pending(profileId, extension.id)
        const held = this.held.get(key)
        this.held.delete(key)
        if (held && held.version !== extension.version) {
          this.waiting.set(key, held)
          report.waiting.push(held.name)
        }
      }
    }
    this.host.ledger().recordUpdateCheck(Date.now())
    return report
  }

  /**
   * What the schedule does each hour and a minute after launch: a check when the mode asks for one and the last was long enough ago.
   * A scheduled check speaks only when it has news (an update applied, one that waits for the user), or fails.
   */
  async checkIfDue(now = Date.now()): Promise<UpdateReport | null> {
    if (!this.enabled || !updateDue(this.updates, this.host.ledger().lastUpdateCheck(), now)) return null
    try {
      const report = await this.checkUpdates()
      if (report.failed !== null) console.warn(`[webstore] the scheduled update check failed: ${report.failed}`)
      if (report.updated.length > 0 || report.waiting.length > 0) this.host.notify(updateSummary(report))
      return report
    } catch (error) {
      console.error('[webstore] the scheduled update check failed:', error)
      return null
    }
  }

  /** Whether a check is scheduled (the engine check reads it). */
  isScheduled(): boolean {
    return this.timer !== null
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstCheck) clearTimeout(this.firstCheck)
    this.timer = null
    this.firstCheck = null
    if (!this.enabled || this.updates === 'manual') return
    const due = (): void => void this.checkIfDue()
    this.timer = setInterval(due, UPDATE_CHECK_EVERY_MS)
    this.timer.unref()
    this.firstCheck = setTimeout(due, FIRST_CHECK_DELAY_MS)
    this.firstCheck.unref()
  }

  /** The user opens the sheet of an update that was held back: it shows only what is new, and the update goes in when they accept. */
  async reviewUpdate(profileId: string, extensionId: string): Promise<'updated' | 'declined' | 'none'> {
    const key = pending(profileId, extensionId)
    const session = this.sessions.get(profileId)
    const current = this.host.installed(profileId).find((e) => e.id === extensionId)
    if (!this.enabled || !this.waiting.has(key) || !session || !current) return 'none'
    const root = join(this.host.userData(), STORE_DIR)
    const stagingRoot = join(this.host.userData(), STAGING_DIR, profileId)
    const staged = join(stagingRoot, extensionId)
    try {
      await this.downloadStaged(extensionId, stagingRoot)
      const files = await this.readStaged(staged)
      if (!files.ok) {
        this.host.notify(files.reason)
        return 'declined'
      }
      if (files.staged.review.version === current.version) {
        this.waiting.delete(key)
        return 'none'
      }
      const difference = addedAccess(current.manifest, files.staged.manifest, undefined, isPublicSuffix) ?? files.staged.review
      const allowed = await this.host.ask({ profileId, mode: 'update', extensionId, review: difference, ...(files.staged.icon ? { icon: files.staged.icon } : {}) })
      if (!allowed) return 'declined'
      const folder = files.staged.dir
      const destination = join(extensionDirectory(root, profileId, extensionId), folder.split(sep).pop()!)
      this.host.unload(profileId, extensionId)
      try {
        await rm(destination, { recursive: true, force: true })
        await rename(folder, destination)
      } catch (error) {
        // The new version could not be put in place (a full disk, a folder that cannot be written): the installed one was unloaded a line above
        // and would stay so until the next launch. It is loaded again, and the user is told; the update keeps waiting for another try.
        console.error(`[webstore] the update of ${extensionId} in profile ${profileId} could not be put in place, the installed version is loaded again:`, error)
        await session.extensions.loadExtension(current.path)
        this.host.notify(t('web-store.la-mise-a-jour-n-a-pas-pu-etre-chargee-la-version'))
        return 'declined'
      }
      await prepareContentPreludeSafely(destination)
      this.host.prepareLoad(profileId)
      try {
        await session.extensions.loadExtension(destination)
      } catch (error) {
        // The new version does not load: the installed one comes back, and the user is told.
        console.error(`[webstore] the update of ${extensionId} did not load, the installed version is restored:`, error)
        await session.extensions.loadExtension(current.path)
        await rm(destination, { recursive: true, force: true })
        this.host.notify(t('web-store.la-mise-a-jour-n-a-pas-pu-etre-chargee-la-version'))
        return 'declined'
      }
      if (current.path !== destination) await rm(current.path, { recursive: true, force: true })
      this.waiting.delete(key)
      return 'updated'
    } finally {
      await rm(staged, { recursive: true, force: true }).catch((error: unknown) => console.warn(`[webstore] cannot clear ${staged}:`, error))
    }
  }
}
