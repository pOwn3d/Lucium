// A layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md). Loading, listing and removing the extensions,
// their workers and their console.

import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { app, BrowserWindow, type ServiceWorkerMain, type Session, type WebContents } from 'electron'
import type { ExtensionInfo } from '@shared/ipc'
import { AUTH_ERRORS, readCommands } from '@shared/chrome-compat'
import { recentGesture } from '@shared/web-auth'
import { runWebAuthFlow } from './web-auth'
import { ExtensionLedger } from './extension-ledger'
import { OptionalGrants } from './optional-grants'
import { loadChecked } from './extension-load'
import { isPublicSuffix } from '@shared/party'
import { permissionsKey } from '@shared/tab-capture'
import { STORE_DIR } from './web-store-files'
import { prepareContentPreludeSafely } from './content-prelude'
import type { UpdateReport } from '@shared/web-store'
import { omniboxKeywordOf } from '@shared/omnibox'
import type { ExtensionConfig, ExtensionLogEntry, ExtensionMenuAction, ExtensionReviewAsk, WebAuthRequest } from './types'
import { t } from '@shared/i18n'
import { LOG_START } from './electron-engine-base'
import { ElectronEngineNetwork } from './electron-engine-network'

export abstract class ElectronEngineExtensions extends ElectronEngineNetwork {
  /** `chrome.permissions`: what each extension was granted in each profile of what its manifest lists as facultative (optional-grants.ts). */
  protected readonly optionalGrants = new OptionalGrants({
    manifestOf: (profileId, extensionId) => this.known.get(`${profileId}:${extensionId}`)?.manifest ?? undefined,
    nameOf: (profileId, extensionId) => this.known.get(`${profileId}:${extensionId}`)?.info.name ?? '',
    read: (profileId, extensionId) => this.extensionLedger().optionalGrant(profileId, extensionId),
    write: (profileId, extensionId, value) => this.extensionLedger().keepOptionalGrant(profileId, extensionId, value),
    // The same clock as a sign-in window an extension asks for: the question appears only because the person just did something.
    hadGesture: () => recentGesture(this.lastUserInput, Date.now()),
    ask: (profileId, extensionId, review, sender) => {
      if (!this.reviewHandler) return Promise.resolve(false)
      // The sheet belongs to the window of the tab that asked; a worker or a popup has none, and the tab the person last used in the profile stands in.
      const last = this.lastActivated.get(profileId)
      const pageId = this.pageIdOf(sender as WebContents) ?? (last === undefined ? undefined : this.pageIdOfTabNumber(last))
      return this.reviewHandler({ profileId, mode: 'optional', extensionId, review, ...(pageId !== undefined ? { pageId } : {}) })
    },
    changed: (profileId, extensionId) => {
      const key = `${profileId}:${extensionId}`
      const manifest = this.known.get(key)?.manifest
      // Every rule that reads the permissions of a loaded extension reads this table: the grant counts from the next call on.
      if (this.loaded.has(key) && manifest) this.manifests.set(key, this.optionalGrants.effective(profileId, extensionId, manifest))
      // An optional `tabCapture` the person took back (or that went with the grants of the extension) ends the capture it was running: the table above is what the engine reads.
      this.tabCaptures.reconsider()
      this.extensionsChanged()
    },
    emit: (profileId, extensionId, event, set) => this.profiles.get(profileId)?.router.sendEvent(extensionId, `permissions.${event}`, set),
    note: (profileId, extensionId, message) => this.extensionTools.note(profileId, extensionId, message),
    isSuffix: isPublicSuffix
  })

  async loadExtension(profileId: string, path: string): Promise<ExtensionInfo> {
    const profile = this.ensureProfile(profileId)
    const info = await this.loadInto(profileId, profile.session, path)
    this.extensionPaths.add(path)
    return info
  }

  /**
   * How many folders loaded by hand every profile created from now on loads too (see `ensureProfile`). A new profile with some of them has
   * a first extension to load at once, so its session carries the extension scripts from its creation; with none it carries none. Engine checks only.
   */
  inheritedExtensionFolders(): number {
    return this.extensionPaths.size
  }

  listExtensions(): ExtensionInfo[] {
    return [...this.loaded.values()]
  }

  listAllExtensions(): ExtensionInfo[] {
    return [...this.known.entries()].map(([key, entry]) => {
      const update = this.webStore.pendingUpdate(entry.info.profileId, entry.info.id)
      const granted = this.optionalGrants.granted(entry.info.profileId, entry.info.id)
      const grantedCount = granted.permissions.length + granted.origins.length
      return { ...(this.loaded.get(key) ?? entry.info), enabled: this.loaded.has(key), ...(update ? { update } : {}), ...(grantedCount > 0 ? { grantedCount } : {}) }
    })
  }

  configureExtensions(config: ExtensionConfig): void {
    this.disabled = new Map(Object.entries(config.disabled).map(([profileId, ids]) => [profileId, new Set(ids)]))
    // What the person let capture the sound of a tab: a capture that is no longer allowed ends with the change, not at its next step.
    this.tabCaptureAllowed = new Map(Object.entries(config.tabCapture).map(([profileId, ids]) => [profileId, new Set(ids)]))
    this.tabCaptureOn = config.tabCaptureOn
    this.tabCaptures.reconsider()
    this.webStore.configure({ install: config.webStoreInstall, updates: config.webStoreUpdates })
    // What changed is applied to the profiles that exist: a switched-off extension leaves the session, a switched-on one comes back.
    for (const [key, entry] of this.known) {
      const { profileId, id } = entry.info
      const profile = this.profiles.get(profileId)
      if (!profile) continue
      const off = this.isDisabled(profileId, id)
      if (off && this.loaded.has(key)) this.unloadExtension(profileId, id)
      else if (!off && !this.loaded.has(key)) {
        this.loadInto(profileId, profile.session, entry.path).catch((error: unknown) => {
          console.error(`[engine] extension ${entry.path} could not be switched on in profile ${profileId}:`, error)
          this.notice(t('engine.extension-non-reactivee', { name: entry.info.name }))
        })
      }
    }
  }

  onExtensionReview(handler: (ask: ExtensionReviewAsk) => Promise<boolean>): void {
    this.reviewHandler = handler
  }

  onExtensionNotice(listener: (message: string) => void): void {
    this.noticeListeners.push(listener)
  }

  onExtensionsChanged(listener: () => void): void {
    this.changeListeners.push(listener)
  }

  protected extensionsChanged(): void {
    for (const listener of this.changeListeners) listener()
  }

  onExtensionForgotten(listener: (profileId: string, extensionId: string) => void): void {
    this.forgottenListeners.push(listener)
  }

  /** The extension is gone from the profile (uninstalled, its folder forgotten), or is no longer the one that was chosen (its folder asks for other things, or comes back under another identifier). */
  protected extensionForgotten(profileId: string, extensionId: string): void {
    for (const listener of this.forgottenListeners) {
      try {
        listener(profileId, extensionId)
      } catch (error) {
        // What the person allowed it is not kept for the sake of a listener that fails: the others are told.
        console.error('[engine] a listener of the extensions that left failed:', error)
      }
    }
  }

  onExtensionMenu(listener: (action: ExtensionMenuAction, profileId: string, extensionId: string) => void): void {
    this.menuListeners.push(listener)
  }

  async uninstallExtension(profileId: string, extensionId: string): Promise<void> {
    await this.webStore.uninstall(profileId, extensionId)
    // What it had chosen of its static rulesets goes with it: installed again, its manifest decides.
    const ses = this.profiles.get(profileId)?.session
    if (ses) this.extensionNets.get(ses)?.forget(extensionId)
    // So does what the person granted it on request: installed again, it asks again.
    this.optionalGrants.forget(profileId, extensionId)
    this.known.delete(`${profileId}:${extensionId}`)
    this.extensionForgotten(profileId, extensionId)
    this.extensionsChanged()
  }

  checkExtensionUpdates(): Promise<UpdateReport> {
    return this.webStore.checkUpdates()
  }

  reviewExtensionUpdate(profileId: string, extensionId: string): Promise<'updated' | 'declined' | 'none'> {
    return this.webStore.reviewUpdate(profileId, extensionId)
  }

  protected isDisabled(profileId: string, extensionId: string): boolean {
    return this.disabled.get(profileId)?.has(extensionId) === true
  }

  protected notice(message: string): void {
    for (const listener of this.noticeListeners) listener(message)
  }

  protected menuAction(action: ExtensionMenuAction, profileId: string, extensionId: string): void {
    for (const listener of this.menuListeners) listener(action, profileId, extensionId)
  }

  protected extensionLedger(): ExtensionLedger {
    this.ledger ??= new ExtensionLedger(join(app.getPath('userData'), 'extension-versions.json'))
    return this.ledger
  }

  /** Takes an extension out of a profile's session; its files stay. */
  protected unloadExtension(profileId: string, extensionId: string): void {
    const extensions = this.profiles.get(profileId)?.session.extensions
    if (extensions?.getExtension(extensionId)) extensions.removeExtension(extensionId)
  }

  /**
   * An extension left the session of a profile (switched off, removed, or about to be replaced by its update): it is no longer loaded there, and its
   * manifest goes with it. What a call may do is read from that manifest: kept, a page of the extension that outlives it would still be answered,
   * and the table would grow with every extension ever loaded.
   */
  protected forgetLoaded(profileId: string, extensionId: string): void {
    this.loaded.delete(`${profileId}:${extensionId}`)
    this.manifests.delete(`${profileId}:${extensionId}`)
  }

  extensionPopupCount(): number {
    return this.popupCount
  }

  runningExtensionWorkers(): string[] {
    return [...this.profiles.values()].flatMap((p) => Object.values(p.session.serviceWorkers.getAllRunning()).map((w) => w.scope))
  }

  heldWorkerCount(): number {
    return this.heldWorkers
  }

  holdWorker(extensionId: string, profileId: string): () => void {
    const profile = this.profiles.get(profileId)
    const scope = `chrome-extension://${extensionId}/`
    let task: { end(): void } | null = null
    let released = false
    this.heldWorkers++
    const start = (worker: ServiceWorkerMain) => {
      if (released || worker.isDestroyed()) return
      task = worker.startTask()
    }
    const running = [...this.extensionWorkers].find((w) => !w.isDestroyed() && w.scope === scope && this.workerProfile.get(w) === profileId)
    if (running) start(running)
    else if (profile && !this.hasNoWorker(profileId, extensionId)) {
      profile.session.serviceWorkers.startWorkerForScope(scope).then(start, (error: unknown) => console.warn(`[engine] cannot hold the worker of ${extensionId}:`, error))
    }
    return () => {
      if (released) return
      released = true
      this.heldWorkers--
      task?.end()
    }
  }

  webAuthFlow(profileId: string, request: WebAuthRequest): Promise<string> {
    const profile = this.profiles.get(profileId)
    if (!profile) return Promise.reject(new Error('No such profile'))
    // A window that asks for a login appears only because the user just did something: an extension cannot put one in front of them on its own.
    if (request.interactive && !recentGesture(this.lastUserInput, Date.now())) return Promise.reject(new Error(AUTH_ERRORS.interactionRequired))
    return runWebAuthFlow(profile.session, request)
  }

  onExtensionConsole(listener: (entry: ExtensionLogEntry) => void): void {
    this.consoleListeners.push(listener)
    for (const { session: ses } of this.profiles.values()) this.watchWorkerConsole(ses)
  }

  /**
   * Hears the warnings and errors of the service workers of a session, for whoever asked (`onExtensionConsole`; only the engine tests do). Without
   * a listener the session is not listened to at all: every message of every site's worker would otherwise be carried to the main process for nothing.
   */
  protected watchWorkerConsole(ses: Session): void {
    if (this.consoleListeners.length === 0 || this.consoleSessions.has(ses)) return
    this.consoleSessions.add(ses)
    ses.serviceWorkers.on('console-message', (_e, details) => {
      if (details.level < 2) return
      const entry: ExtensionLogEntry = {
        level: details.level === 2 ? 'warning' : 'error',
        message: details.message,
        sourceUrl: details.sourceUrl
      }
      for (const listener of this.consoleListeners) listener(entry)
    })
  }

  /**
   * An extension is about to be loaded into this profile's session (by the engine, or by the Web Store through its host): the preload scripts
   * that extensions need go into the session now, before the extension's worker can start. Idempotent; a session that never loads one has none.
   */
  protected prepareExtensions(profileId: string): void {
    this.profiles.get(profileId)?.runtime.activate()
  }

  protected async loadInto(profileId: string, ses: Session, path: string): Promise<ExtensionInfo> {
    this.prepareExtensions(profileId)
    // An extension of the Web Store gets the few lines that give its content scripts chrome.storage.sync (see content-prelude.ts); a folder the user loaded is left as it is.
    if (path.startsWith(`${join(app.getPath('userData'), STORE_DIR)}${sep}`)) await prepareContentPreludeSafely(path)
    let extension: Electron.Extension
    try {
      // A folder is held to the bound of the review sheet like a package of the Web Store: the engine would apply the whole of a longer manifest.
      extension = await loadChecked(path, { readManifest: (folder) => this.readManifest(folder), load: (folder) => ses.extensions.loadExtension(folder, { allowFileAccess: false }) })
    } catch (error) {
      // The Extensions page says why a folder is not loaded: the sentence is kept (and written in the journal) before the caller deals with the rejection.
      this.extensionTools.failed(profileId, path, this.extensionLedger().idOfPath(path), error)
      throw error
    }
    this.extensionTools.loaded(profileId, path)
    return this.registerLoaded(profileId, extension)
  }

  /** Takes the folder out of every profile and forgets it: an extension the user removed from the Extensions page (the files are not touched). */
  protected forgetExtensionFolder(path: string): void {
    this.extensionPaths.delete(path)
    for (const [key, entry] of [...this.known]) {
      if (entry.path !== path) continue
      this.unloadExtension(entry.info.profileId, entry.info.id)
      this.known.delete(key)
      this.loaded.delete(key)
      this.extensionForgotten(entry.info.profileId, entry.info.id)
    }
    this.extensionsChanged()
  }

  /**
   * Records an extension a session has loaded, whoever loaded it: the engine (a folder, a stored extension) or the Web Store library
   * (an install, an update). Called for the session's `extension-loaded` event and after a load; the second call changes nothing.
   */
  protected registerLoaded(profileId: string, extension: Electron.Extension): ExtensionInfo {
    const key = `${profileId}:${extension.id}`
    const already = this.loaded.get(key)
    if (already && already.version === extension.version) return already
    const sidePanelPath = (extension.manifest as { side_panel?: { default_path?: string } }).side_panel?.default_path
    const commands = readCommands(extension.manifest)
    // The manifest the access rules read: with what the person granted this extension in this profile, on its request.
    this.manifests.set(key, this.optionalGrants.effective(profileId, extension.id, extension.manifest as { permissions?: unknown; host_permissions?: unknown; omnibox?: unknown; background?: unknown }))
    const source = extension.path.startsWith(`${join(app.getPath('userData'), STORE_DIR)}${sep}`) ? 'store' : 'unpacked'
    // A folder is whatever its files say today: one that comes back asking for other things, or under another identifier, is not the extension the person chose (the updates of the
    // Web Store have a review of their own).
    if (source === 'unpacked') this.forgetIfNotTheSame(profileId, extension)
    const omniboxKeyword = omniboxKeywordOf(extension.manifest)
    const info: ExtensionInfo = { id: extension.id, name: extension.name, version: extension.version, profileId, source, enabled: true, ...(sidePanelPath ? { sidePanelPath } : {}), ...(commands.length > 0 ? { commands } : {}), ...(omniboxKeyword ? { omniboxKeyword } : {}) }
    this.loaded.set(key, info)
    this.known.set(key, { info, path: extension.path, manifest: extension.manifest })
    // Its static rulesets are read, and its rules are applied by the hooks of the session from now on (extension-net.ts).
    const ses = this.profiles.get(profileId)?.session
    if (ses) this.extensionNets.get(ses)?.add(extension.id, extension.path, extension.manifest)
    if (source === 'unpacked') this.extensionLedger().rememberPath(extension.path, extension.id)
    this.announceLifecycle(profileId, extension.id, extension.version)
    this.extensionsChanged()
    return info
  }

  /** What the person allowed an extension of a folder is gone when the folder asks for other permissions than the copy that was known, and for the old identifier when the folder has another. */
  private forgetIfNotTheSame(profileId: string, extension: Electron.Extension): void {
    const before = this.known.get(`${profileId}:${extension.id}`)
    const was = before === undefined ? null : permissionsKey(before.manifest)
    if (was !== null && was !== permissionsKey(extension.manifest)) this.extensionForgotten(profileId, extension.id)
    for (const other of this.known.values()) {
      if (other.info.profileId === profileId && other.path === extension.path && other.info.id !== extension.id) this.extensionForgotten(profileId, other.info.id)
    }
  }

  /**
   * An extension of a profile that is switched off there is not loaded. Its id is known before the load for a stored extension (its
   * folder is named after it) and for a folder that was loaded before (the ledger remembers it); a folder loaded for the first time
   * is loaded, and unloaded at once by the `extension-loaded` handler if it turns out to be switched off.
   */
  protected loadFirst(profileId: string, ses: Session, path: string, knownId: string | undefined): Promise<void> {
    if (knownId !== undefined && this.isDisabled(profileId, knownId)) {
      this.known.set(`${profileId}:${knownId}`, this.known.get(`${profileId}:${knownId}`) ?? { info: this.placeholder(profileId, knownId, path), path, manifest: this.readManifest(path) })
      this.extensionsChanged()
      return Promise.resolve()
    }
    return this.loadInto(profileId, ses, path).then(
      () => undefined,
      (error: unknown) => console.error(`[engine] extension ${path} failed to load in profile ${profileId}:`, error)
    )
  }

  /** What Settings shows for an extension that has not been loaded in this process: its name and version from its manifest. */
  protected placeholder(profileId: string, id: string, path: string): ExtensionInfo {
    const manifest = this.readManifest(path) as { name?: unknown; version?: unknown } | null
    const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value.slice(0, 80) : fallback)
    const source = path.startsWith(`${join(app.getPath('userData'), STORE_DIR)}${sep}`) ? 'store' : 'unpacked'
    return { id, name: text(manifest?.name, id), version: text(manifest?.version, ''), profileId, source, enabled: false }
  }

  private readManifest(path: string): unknown {
    try {
      return JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as unknown
    } catch (error) {
      console.warn(`[engine] the manifest of ${path} cannot be read:`, (error as Error).message)
      return null
    }
  }

  /** Diagnostics (LUCIUM_EXT_LOG=1): everything extension service workers and extension pages print, and the life of the workers. */
  protected logExtensionActivity(ses: Session): void {
    const levels = ['verbose', 'info', 'warning', 'error']
    const t = () => `+${((Date.now() - LOG_START) / 1000).toFixed(1)}s`
    ses.serviceWorkers.on('console-message', (_e, details) => {
      console.log(`${t()} [ext-worker ${levels[details.level] ?? details.level}] ${details.message} (${details.sourceUrl}:${details.lineNumber})`)
    })
    ses.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
      const scope = ses.serviceWorkers.getWorkerFromVersionID(versionId)?.scope ?? `version ${versionId}`
      if (scope.startsWith('chrome-extension://') || scope.startsWith('version')) console.log(`${t()} [ext-worker ${runningStatus}] ${scope}`)
    })
    ses.on('extension-loaded', (_e, extension) => console.log(`${t()} [ext] loaded ${extension.name} ${extension.version} (${extension.id})`))
    app.on('web-contents-created', (_e, wc) => {
      if (wc.session !== ses) return
      wc.on('console-message', (event) => {
        if (!wc.getURL().startsWith('chrome-extension://')) return
        console.log(`${t()} [ext-page ${event.level}] ${event.message} (${wc.getURL().slice(0, 80)})`)
      })
      wc.on('did-fail-load', (_ev, code, description, url) => {
        if (url.startsWith('chrome-extension://')) console.log(`[ext-page] load failed ${code} ${description} ${url}`)
      })
    })
  }

  protected pageIdOf(webContents: WebContents): string | undefined {
    for (const [id, page] of this.pages) if (page.webContents === webContents) return id
    return undefined
  }

  /** The window an extension of this profile means by `windowId` (or by the focused one), if it shows a tab of the profile. */
  protected windowOfProfile(profileId: string, windowId: unknown): BrowserWindow | undefined {
    const wanted = typeof windowId === 'number' && windowId > 0 ? windowId : BrowserWindow.getFocusedWindow()?.id
    if (wanted === undefined) return undefined
    for (const meta of this.tabMeta.values()) if (meta.profileId === profileId && !meta.win.isDestroyed() && meta.win.id === wanted) return meta.win
    return undefined
  }
}
