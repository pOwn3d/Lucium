// The engine port implemented with Electron (types.ts is the port). The class ElectronEngine is a chain of layers, one file each, from
// electron-engine-base.ts to this one (the order: docs/architecture.md); this last one makes the pages and the private contexts.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session, WebContentsView, type Session } from 'electron'
import { pageDialogPreferences } from '@shared/page-dialog'
import { tabMovedTo } from './ece-router'
import { webAutoplayPolicy } from './autoplay'
import type { AutoplayMode } from '@shared/autoplay'
import { releaseSessionHooks } from './session-hooks'
import { sessionDecisions } from './error-pages'
import { containerIdOfDir, containerPartition, containerScopeKey, isContainerId } from '@shared/container-id'
import { containerFolderLastWrite, removeContainerFolders, wipeFailure, wipeSession } from './container-store'
import type { PrivacyOptions } from '@shared/privacy'
import { type EphemeralEngine, type Engine, type ExtensionTabHooks, type Page, type PageEvents, type InnerGuardProvider, type PageGuardProvider, type RequestBlocker, type ResponsePolicy, NO_DOWNLOAD_POLICY } from './types'
import { ElectronPage } from './electron-page'
import { installInternalPages } from './internal-pages'
import type { DocumentPipWindows } from './document-pip-windows'
import { ColorSchemePages, type PageColorScheme } from './color-scheme'
import { EphemeralScope } from './ephemeral-scope'
import { withDeclaredIcon, withJudgedIcon } from './declared-icon'
import { type Profile, type Scope } from './electron-engine-base'
import { ElectronEngineDownloads } from './electron-engine-downloads'

export { ElectronPage }
export { type Scope } from './electron-engine-base'

export class ElectronEngine extends ElectronEngineDownloads implements Engine {
  /** The web pages (not an extension's panel) and the colour scheme they are asked to read (engine/color-scheme.ts). */
  private readonly colorSchemes = new ColorSchemePages<ElectronPage>()

  setPageColorScheme(scheme: PageColorScheme | null): void {
    this.colorSchemes.set(scheme)
  }

  createPage(opts: { id: string; profileId: string; extensionPanel?: boolean; windowId?: string; autoplay?: AutoplayMode }, events: PageEvents): Page {
    // A private context has no profile and no extensions: its pages are not tabs for the extension runtime.
    const scope = this.scopes.get(opts.profileId)
    const profile = scope ? undefined : this.ensureProfile(opts.profileId)
    const sessionOfPage = scope?.session ?? profile?.session
    const win = this.getWindow(opts.windowId)
    if (sessionOfPage) {
      this.mediaBridge.ensure(sessionOfPage)
      this.installDialogBridge(sessionOfPage)
      this.installChromeApp(sessionOfPage)
      // The form guard goes into every session while its setting is on, a private context's included.
      this.syncFormGuard(sessionOfPage)
      // A session made after the manager was switched on gets the bridge with its first page. A private context never does.
      if (!scope) this.syncPasswordBridge(sessionOfPage)
    }
    const view = new WebContentsView({
      // The policy is fixed when the page is made (Electron has no way to change it afterwards): see shared/autoplay.ts.
      webPreferences: { session: sessionOfPage, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, ...pageDialogPreferences(), autoplayPolicy: webAutoplayPolicy(opts.autoplay ?? this.defaultAutoplay), minimumFontSize: this.minimumFontSize }
    })
    const wc = view.webContents
    const contentsId = wc.id
    // A tab dragged onto another window takes its page there: the window, and the one the extension runtime of Lucium sees the tab in (`tabMeta`).
    const relocate = (windowId: string | undefined): BrowserWindow | undefined => {
      const next = this.getWindow(windowId)
      if (next.isDestroyed()) return undefined
      const meta = this.tabMeta.get(contentsId)
      if (meta) {
        this.tabMeta.set(contentsId, { ...meta, win: next })
        // The library of the profile keeps the window of a tab too: it must be told the one the tab is in now (see tabMovedTo).
        if (profile) tabMovedTo(profile.extensions, wc, next)
      }
      return next
    }
    // The floating video window borrows the view as it is (Page.lendView): the extension runtime keeps seeing the tab in its own window.
    const lendHost = (windowId: string): BrowserWindow | undefined => {
      const host = this.getWindow(windowId)
      return host.isDestroyed() ? undefined : host
    }
    // The icon the page declares is judged before anyone hears of it (declared-icon.ts). The blocker knows a page by the id the shell gave it, without the prefix of a context.
    const shellId = scope && opts.id.startsWith(scope.prefix) ? opts.id.slice(scope.prefix.length) : opts.id
    const pageUrl = (): string => (wc.isDestroyed() ? '' : wc.getURL())
    // An icon that passed is one the interface will ask the copy of: the engine remembers which profile shows it (site-icons.ts). Never for a private
    // context or a container: their icon is handed over as data by their own session (ephemeral-scope.ts), and nothing of it is asked outside it.
    const noted: PageEvents = scope ? events : withDeclaredIcon(events, (iconUrl) => this.siteIcons.declare(iconUrl, { profileId: opts.profileId, pageUrl: pageUrl() }))
    const judged = withJudgedIcon(noted, shellId, pageUrl, () => (scope ? scope.blocker : this.requestBlocker) ?? null)
    const page = new ElectronPage(opts.id, view, win, judged, this.upgrades, this.popups, scope?.key ?? null, this.unsaved, relocate, () => this.beforeNavigation(sessionOfPage, profile), (pageId) => this.blockExceptionHandlers.get(pageId), () => this.miniOpener, () => this.popupPolicy, lendHost, (scheme, clicked, asker) => (asker ? this.askAppLink(wc, scheme, clicked, asker) : this.askAppLink(wc, scheme, clicked)), this.documentPip)
    this.pages.set(opts.id, page)
    // The pages made while the setting is not Automatique read it from their first document (the session is attached at once, the page loads right after).
    if (!opts.extensionPanel) this.colorSchemes.add(page)
    // A panel hosting an extension page is not a tab: keep it out of chrome.tabs, but let it receive shim events.
    if (opts.extensionPanel) this.extensionFrames.add(view.webContents)
    else if (profile) {
      profile.extensions.addTab(view.webContents, win)
      // The first page of this profile in the window the user is in: only now does the library know the window (see `followFocusedWindow`).
      if (win.id === this.currentWindowId) profile.followWindow(win.id)
    }
    this.pageByContents.set(contentsId, opts.id)
    // The frames and the workers of the first document are protected from its first line: the session is attached before the page loads anything.
    if (!opts.extensionPanel) this.primeInnerGuard(wc)
    // Only a page that extensions see as a tab has a tab number worth resolving (not a panel, not a private page).
    if (profile && !opts.extensionPanel) {
      this.tabMeta.set(contentsId, { profileId: opts.profileId, win })
      // What an extension was lent of this tab (activeTab) ends when the tab shows a document of another origin.
      wc.on('did-navigate', (_event, url) => {
        this.activeTabs.navigated(contentsId, url)
        // A new document has none of the style sheets the extensions put in the last one.
        this.forgetLentStyles(contentsId)
        // Read after the hand-over was judged: a capture of the sound of the tab lasts while the extension still holds the tab (tab-capture.ts, `targetNavigated`).
        this.tabCaptures.targetNavigated(contentsId, url)
      })
    }
    wc.once('destroyed', () => {
      // `close()` is asynchronous: a page rebuilt under the same id is registered long before this one is gone, and must stay registered.
      if (this.pages.get(opts.id) === page) this.pages.delete(opts.id)
      this.colorSchemes.remove(page)
      this.pageByContents.delete(contentsId)
      this.extensionFrames.delete(wc)
      if (this.tabMeta.delete(contentsId)) {
        this.activeTabs.forgetTab(contentsId)
        this.forgetLentStyles(contentsId)
        for (const listener of this.tabClosedListeners) listener(contentsId)
      }
    })
    return page
  }

  /** What a page waits for before it navigates: the proxy change of its session, and the extensions its profile is still loading. Nothing most of the time. */
  private beforeNavigation(ses: Session | undefined, profile: Profile | undefined): Promise<void> | undefined {
    const pending = [ses ? this.proxies.settled(ses) : undefined, profile?.ready ?? undefined].filter((wait): wait is Promise<void> => wait !== undefined)
    return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined)
  }

  activatePage(pageId: string): void {
    const wc = this.pages.get(pageId)?.liveContents()
    if (!wc) return
    // Only the extension runtime of the page's own profile knows it: another profile's runtime refuses a foreign web contents.
    for (const [profileId, profile] of this.profiles) {
      if (profile.session !== wc.session) continue
      profile.extensions.selectTab(wc)
      if (this.tabMeta.has(wc.id)) this.lastActivated.set(profileId, wc.id)
    }
  }

  /** The task manager: the popups that are open, by process. A private window's popups (`scope`) are for its own task manager. */
  popupProcesses(scope: string | null = null): Array<{ pid: number; title: string }> {
    return this.popups.processes(scope)
  }

  setDocumentPictureInPicture(on: boolean): void {
    this.documentPip.setEnabled(on)
  }

  /** Diagnostics: the document Picture-in-Picture windows that are open, and the one of a page (the engine check reads them). */
  documentPipWindows(): DocumentPipWindows {
    return this.documentPip
  }

  /** Diagnostics: how many popup windows of pages are open (`extensionPopupCount` is the one of extension action popups). */
  pagePopupCount(): number {
    return this.popups.count()
  }

  openEphemeral(windowId: string): EphemeralEngine {
    const n = ++this.scopeCounter
    // No "persist:" prefix: Chromium keeps such a session in memory and never writes it.
    // A new partition for each private window, on purpose. Electron cannot free a session, so each one stays (emptied by `wipe`, its hooks
    // released by `scopeClose`) until the application quits; but handing a closed window's session to the next one would carry over what
    // `wipe` cannot erase (the certificate errors the user let through, a wipe that partly failed or has not finished yet): one private
    // window would then learn something of another.
    const ses = session.fromPartition(`ephemeral-${n}`)
    if (ses.isPersistent() || ses.getStoragePath() !== null) throw new Error('A private session must not be persistent')
    // The Extensions page never opens in a private window: whatever asks for it in this session is refused (engine/internal-pages.ts).
    installInternalPages(ses, 'refuse')
    const key = `ephemeral:${n}`
    const scope: Scope = { key, prefix: `${key}/`, windowId, session: ses, policy: null, blocker: null, responsePolicy: null, guard: null, innerGuard: null, privacy: null, namer: null, dirResolver: null, downloadPolicy: NO_DOWNLOAD_POLICY, downloadListeners: [] }
    this.applyProxyTo(ses, null, key)
    // No answer is held for a tab of a private context: what is answered there is used once and kept nowhere.
    this.installPermissions(ses, () => scope.policy, undefined, false)
    this.installDisplayMedia(ses)
    this.installDownloads(ses, key, scope)
    // From the start, before any blocker or privacy option reaches the scope: what a local page may read of the disk (local-file-guard.ts).
    this.installRequestBlocker(ses, () => scope.blocker, scope.prefix, () => scope.privacy)
    this.scopes.set(key, scope)
    return new EphemeralScope(this, scope)
  }

  /**
   * The browsing context of a tab container: a session of its own on disk (`persist:container-<id>`), so its cookies and storage outlive the
   * run, with no extensions and hooks of its own, like a private context. The same context is handed back while it is open.
   */
  openContainer(containerId: string, windowId: string): EphemeralEngine {
    if (!isContainerId(containerId)) throw new Error(`Invalid container id: ${String(containerId).slice(0, 40)}`)
    const open = this.containerScopes.get(containerId)
    if (open) return open
    const ses = session.fromPartition(containerPartition(containerId))
    if (!ses.isPersistent()) throw new Error('A container session must be persistent')
    // Nor in a tab container, whose session is not its profile's.
    installInternalPages(ses, 'refuse')
    const key = containerScopeKey(containerId)
    const scope: Scope = { key, prefix: `${key}/`, windowId, session: ses, policy: null, blocker: null, responsePolicy: null, guard: null, innerGuard: null, privacy: null, namer: null, dirResolver: null, downloadPolicy: NO_DOWNLOAD_POLICY, downloadListeners: [] }
    this.applyProxyTo(ses, null, key)
    this.installPermissions(ses, () => scope.policy)
    this.installDisplayMedia(ses)
    this.installDownloads(ses, key, scope)
    // From the start, before any blocker or privacy option reaches the scope: what a local page may read of the disk (local-file-guard.ts).
    this.installRequestBlocker(ses, () => scope.blocker, scope.prefix, () => scope.privacy)
    this.scopes.set(key, scope)
    const handle = new EphemeralScope(this, scope)
    this.containerScopes.set(containerId, handle)
    return handle
  }

  /**
   * Erases everything a container stored, open or not: cookies, storage of every kind, cache, logins. Its pages must be gone. Rejects, naming
   * what was kept, when something could not be erased.
   */
  async eraseContainer(containerId: string, name: string): Promise<void> {
    if (!isContainerId(containerId)) throw new Error(`Invalid container id: ${String(containerId).slice(0, 40)}`)
    const open = this.containerScopes.get(containerId)
    this.containerScopes.delete(containerId)
    if (open) return open.erase(name)
    const failed = await wipeSession(session.fromPartition(containerPartition(containerId)), `container ${containerId}`, sessionDecisions)
    if (failed.length > 0) throw wipeFailure(name, failed)
  }

  /** The containers that have a folder on disk, used or not. */
  storedContainerIds(): string[] {
    const dir = join(app.getPath('userData'), 'Partitions')
    if (!existsSync(dir)) return []
    return readdirSync(dir).flatMap((name) => {
      const id = containerIdOfDir(name)
      return id === null ? [] : [id]
    })
  }

  storedContainerIdleMs(id: string): number | null {
    const last = containerFolderLastWrite(join(app.getPath('userData'), 'Partitions'), id)
    return last === null ? null : Date.now() - last
  }

  /**
   * Removes the folders of containers that no longer exist. Only before the container's session is opened in this run (a folder in use is left
   * alone, and named in the answer), so this is for the launch, before any page. Answers the ids that could not be removed.
   */
  removeStoredContainers(ids: readonly string[]): string[] {
    const idle = ids.filter((id) => !this.containerScopes.has(id))
    const { failed } = removeContainerFolders(join(app.getPath('userData'), 'Partitions'), idle)
    return [...failed, ...ids.filter((id) => this.containerScopes.has(id))]
  }

  /** @internal For `EphemeralScope`. */
  scopeSetBlocker(scope: Scope, blocker: RequestBlocker | null): void {
    scope.blocker = blocker
    this.installRequestBlocker(scope.session, () => scope.blocker, scope.prefix, () => scope.privacy)
  }

  /** @internal For `EphemeralScope`. */
  scopeSetResponsePolicy(scope: Scope, policy: ResponsePolicy | null): void {
    scope.responsePolicy = policy
    this.installResponsePolicy(scope.session, () => scope.responsePolicy)
  }

  /** @internal For `EphemeralScope`. */
  scopeSetGuard(scope: Scope, provider: PageGuardProvider | null): void {
    scope.guard = provider
    this.syncPageGuard(scope.session, provider !== null)
    this.syncGuardListener()
  }

  /** @internal For `EphemeralScope`. */
  scopeSetInnerGuard(scope: Scope, provider: InnerGuardProvider | null): void {
    scope.innerGuard = provider
    this.syncInnerGuards(scope.session)
  }

  /** @internal For `EphemeralScope`. */
  scopeSetPrivacy(scope: Scope, options: PrivacyOptions | null): void {
    scope.privacy = options
    this.installRequestBlocker(scope.session, () => scope.blocker, scope.prefix, () => scope.privacy)
    this.installResponsePolicy(scope.session, () => scope.responsePolicy)
  }

  /** @internal For `EphemeralScope`. */
  scopeClose(scope: Scope): void {
    this.scopes.delete(scope.key)
    // The session outlives the window: its hooks, and what they close over (the private window's browser), must not.
    releaseSessionHooks(scope.session)
    scope.policy = null
    scope.blocker = null
    scope.responsePolicy = null
    this.syncStandIns(scope.session, false)
    this.syncPageGuard(scope.session, false)
    scope.guard = null
    scope.innerGuard = null
    this.syncInnerGuards(scope.session, false)
    this.syncGuardListener()
    scope.privacy = null
    scope.namer = null
    scope.dirResolver = null
    scope.downloadPolicy = NO_DOWNLOAD_POLICY
    scope.downloadListeners.length = 0
  }

  /** Diagnostics: pages alive in the engine, and private contexts open. */
  pageCount(): number {
    return this.pages.size
  }

  /** Private contexts open (a container's context is not one: see `containerCount`). */
  ephemeralCount(): number {
    return [...this.scopes.keys()].filter((key) => key.startsWith('ephemeral:')).length
  }

  /** Diagnostics: tab containers whose context is open. */
  containerCount(): number {
    return this.containerScopes.size
  }

  protected requireHooks(): ExtensionTabHooks {
    if (!this.hooks) throw new Error('Extension tab hooks are not installed')
    return this.hooks
  }
}
