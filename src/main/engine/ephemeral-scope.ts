// The engine as a private window sees it (`Engine.openEphemeral`): one in-memory session with its own hooks, kept by the engine for the window.
// Moved out of electron-engine.ts as it was.

import { type EngineInfo, type ExtensionInfo } from '@shared/ipc'
import type { DownloadInfo } from '@shared/model'
import type { SiteDataResult } from '@shared/site-data'
import { countSiteCookies, eraseSiteData } from './site-data'
import type { UpdateReport } from '@shared/web-store'
import { type AutoplayMode } from '@shared/autoplay'
import { wipeFailure, wipeSession } from './container-store'
import { type HardwareGrantRow } from '@shared/web-hardware'
import { type ProxyFollow, type ProxySession } from './network'
import { listCookies as listJarCookies, removeCookies as removeJarCookies } from './cookie-book'
import type { CookieEntry, CookieRemoval } from '@shared/cookies'
import { type ReadOutcome } from './page-reader'
import { type PrivacyOptions } from '@shared/privacy'
import { setBounded } from '@shared/bounded'
import type {
  DownloadPolicy,
  EphemeralEngine,
  Page,
  PageEvents,
  InnerGuardProvider,
  PageGuardProvider,
  PermissionPolicy,
  RequestBlocker,
  ResponsePolicy,
  SiteDataEngineRequest
} from './types'
import { NO_EXTENSION_TOOLS } from './types'
import { t } from '@shared/i18n'
import { sessionDecisions } from './error-pages'
import type { ElectronEngine, Scope } from './electron-engine'

const FAVICON_MAX_BYTES = 256 * 1024
/** How many fetched favicons a private context keeps (up to FAVICON_MAX_BYTES each): the oldest are fetched again if their page comes back. */
const FAVICON_CACHE_MAX = 128
const FAVICON_TIMEOUT_MS = 5000
const FAVICON_TYPES = /^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/

/**
 * The body of a favicon, or null when it is empty or larger than `max`. The size is judged before the body is held: by the length the server
 * declares, then chunk by chunk, and the rest of a body that is too large is never downloaded. A page chooses the address of its icon, so
 * the answer may be of any size: read whole, it would sit in the memory of the main process.
 */
async function readFavicon(response: Response, max: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (declared > max || !response.body) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return size > 0 ? Buffer.concat(chunks, size) : null
}

/**
 * The permission policy of a context, as the engine calls it. The engine knows the pages of a private or container context by their id with the
 * context's prefix (`ephemeral:1/<tab id>`); the shell that answers knows them by the tab's own id. Without this, a private window found none of its
 * own pages: the question of a tab went to a sheet of the system, never remembered, instead of the window's panel. A page of another context is no
 * page of this one (undefined), as for the downloads.
 */
export function scopedPermissionPolicy(policy: PermissionPolicy, prefix: string): PermissionPolicy {
  const local = (pageId: string | undefined): string | undefined => (pageId?.startsWith(prefix) ? pageId.slice(prefix.length) : undefined)
  const { hasPanel } = policy
  return {
    lookup: (origin, permission) => policy.lookup(origin, permission),
    ask: (origin, permission, pageId, detail) => policy.ask(origin, permission, local(pageId), detail),
    // Absent stays absent: the engine then puts every question in the panel, as before.
    ...(hasPanel
      ? {
          hasPanel: (pageId: string) => {
            const own = local(pageId)
            return own !== undefined && hasPanel.call(policy, own)
          }
        }
      : {}),
    screenShareAllowed: () => policy.screenShareAllowed()
  }
}

/** The engine as a private window sees it: see `Engine.openEphemeral`. */
export class EphemeralScope implements EphemeralEngine {
  private disposed = false
  /** Favicons already fetched through the private session (null: not an image, or unreachable). */
  private readonly favicons = new Map<string, string | null>()

  constructor(
    private readonly host: ElectronEngine,
    private readonly scope: Scope
  ) {}

  info(): EngineInfo {
    return this.host.info()
  }

  createPage(opts: { id: string; profileId: string; extensionPanel?: boolean; windowId?: string; autoplay?: AutoplayMode }, events: PageEvents): Page {
    if (this.disposed) throw new Error('This private window is closed')
    // Whatever profile the shell asks for, the page goes to this window's own session.
    // The window of the page when the shell names one (private tabs of several normal windows share one context), else the context's own.
    return this.host.createPage({ id: this.scope.prefix + opts.id, profileId: this.scope.key, windowId: opts.windowId ?? this.scope.windowId, ...(opts.autoplay ? { autoplay: opts.autoplay } : {}) }, this.withInlineFavicons(events))
  }

  /** The popups of a private window take the general choice, which the main window sets. */
  setDefaultAutoplay(): void {}
  setMinimumFontSize(): void {}

  /** The media bridge follows the main window's setting for every session (see ElectronEngine.setMediaBridge). */
  setMediaBridge(): void {}

  /** A private context has no password manager: its sessions never load the bridge. */
  setPasswordBridge(): void {}

  /** The form guard follows the main window's setting for every session, private contexts included (see ElectronEngine.setInsecureFormGuard). */
  setInsecureFormGuard(): void {}

  /**
   * The sidebar UI loads favicons itself, in the application's own session: its HTTP cache is on disk and would remember
   * which sites a private window visited. The favicon is fetched here, through the private session, and handed over as data.
   */
  private withInlineFavicons(events: PageEvents): PageEvents {
    // Which icon the page is waiting for. An answer is only shown when nothing came after its request: a slow icon of the page before
    // would otherwise land on the page the tab shows now, or over a newer icon of the same page.
    let asked = 0
    return {
      ...events,
      update: (patch) => {
        // A new document, or an icon given another way: whatever is still on its way belongs to what the tab no longer shows.
        if (patch.newDocument === true || patch.faviconUrl !== undefined) asked++
        const url = patch.faviconUrl
        if (!url || url.startsWith('data:')) return events.update(patch)
        const { faviconUrl: _remote, ...rest } = patch
        if (Object.keys(rest).length > 0) events.update(rest)
        const mine = asked
        void this.fetchFavicon(url).then((data) => {
          if (data && !this.disposed && mine === asked) events.update({ faviconUrl: data })
        })
      }
    }
  }

  private async fetchFavicon(url: string): Promise<string | null> {
    if (!/^https?:\/\//i.test(url)) return null
    const known = this.favicons.get(url)
    if (known !== undefined) return known
    let data: string | null = null
    try {
      const response = await this.scope.session.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS) })
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (response.ok && FAVICON_TYPES.test(type)) {
        const bytes = await readFavicon(response, FAVICON_MAX_BYTES)
        if (bytes !== null) data = `data:${type};base64,${bytes.toString('base64')}`
      } else await response.body?.cancel()
    } catch (error) {
      // A missing, slow or refused favicon only leaves the letter fallback. The line names the kind of failure and never the address:
      // it would write down a site a private window visited.
      console.debug(`[private] a favicon could not be fetched (${error instanceof Error ? error.name : 'Error'})`)
    }
    setBounded(this.favicons, url, data, FAVICON_CACHE_MAX)
    return data
  }

  popupProcesses(): Array<{ pid: number; title: string }> {
    return this.host.popupProcesses(this.scope.key)
  }

  setShimHandler(): void {}
  setActionMenuItems(): void {}
  emitShimEvent(): void {}
  sendExtensionEvent(): void {}
  updateContextMenuItem(): void {}
  deliverToWorker(): Promise<void> {
    return Promise.resolve()
  }
  relayNativeEvent(): void {}
  setTabFactsProvider(): void {}
  notifyTabChanged(): void {}
  onTabClosed(): void {}
  profileOfTab(): undefined {
    return undefined
  }
  windowOfTab(): undefined {
    return undefined
  }
  holdWorker(): () => void {
    return () => {}
  }
  onContextGone(): void {}
  mayCaptureTab(): boolean {
    return false
  }
  mayReadTab(): boolean {
    return false
  }
  mayActOnTab(): boolean {
    return false
  }
  writeClipboard(): Promise<void> {
    return Promise.reject(new Error('Extensions do not run in a private window'))
  }
  clipboardSettled(): Promise<void> {
    return Promise.resolve()
  }
  tabUrl(): undefined {
    return undefined
  }
  webAuthFlow(): Promise<string> {
    return Promise.reject(new Error('Extensions do not run in a private window'))
  }
  readPageText(): Promise<ReadOutcome> {
    // A private window keeps nothing, and nothing is watched from it: the pages that are watched belong to the profiles on disk.
    return Promise.resolve({ ok: false, error: t('engine.une-fenetre-privee-ne-surveille-aucune-page') })
  }
  startDownload(): Promise<string> {
    return Promise.reject(new Error('Extensions do not run in a private window'))
  }
  heldWorkerCount(): number {
    return 0
  }
  setExtensionTabHooks(): void {}

  // No extension runs in a private window: nothing is captured for one.
  onTabCapture(): void {}

  stopTabCapture(): boolean {
    return false
  }

  reconsiderTabCaptures(): void {}
  activatePage(): void {}
  onExtensionConsole(): void {}
  readonly extensionTools = NO_EXTENSION_TOOLS

  tabNumberOf(pageId: string): number | undefined {
    return this.host.tabNumberOf(this.scope.prefix + pageId)
  }

  pageIdOfTabNumber(tabNumber: number): string | undefined {
    const id = this.host.pageIdOfTabNumber(tabNumber)
    return id?.startsWith(this.scope.prefix) ? id.slice(this.scope.prefix.length) : undefined
  }

  /** A private or container scope keeps no site exception of the window's own: the policy of the main window applies to its pages only. */
  setPopupPolicy(_allowed: (url: string) => boolean): void {}

  /** The pages of a private context are made by the engine it is in, whose switch they follow (the setting is one for every window). */
  setDocumentPictureInPicture(_on: boolean): void {}

  /** The policy is asked with the id the shell gave the page, not the engine's: see `scopedPermissionPolicy`. */
  setPermissionPolicy(policy: PermissionPolicy): void {
    this.scope.policy = scopedPermissionPolicy(policy, this.scope.prefix)
  }

  // A private context is never given a device: a serial number is an identifier that would tie a private visit to a normal one.
  setWebHardware(): number {
    return 0
  }

  webHardwareGrants(): HardwareGrantRow[] {
    return []
  }

  revokeWebHardware(): number {
    return 0
  }

  setRequestBlocker(blocker: RequestBlocker | null): void {
    this.host.scopeSetBlocker(this.scope, blocker)
  }

  setPrivacy(options: PrivacyOptions | null): void {
    this.host.scopeSetPrivacy(this.scope, options)
  }

  setResponsePolicy(policy: ResponsePolicy | null): void {
    this.host.scopeSetResponsePolicy(this.scope, policy)
  }

  setPageGuard(provider: PageGuardProvider | null): void {
    this.host.scopeSetGuard(this.scope, provider)
  }

  setInnerGuard(provider: InnerGuardProvider | null): void {
    this.host.scopeSetInnerGuard(this.scope, provider)
  }

  // The DNS is the application's, and a private context follows the global proxy by itself (see ElectronEngine.setProxies).
  setHostResolver(): string | null {
    return null
  }

  // The colour scheme asked of the pages is the application's too: the pages of this context are made by the engine, which gives each one the scheme (a private window included).
  setPageColorScheme(): void {}

  setProxies(): Promise<string[]> {
    return Promise.resolve([])
  }

  followProxy(ses: ProxySession, what: string): ProxyFollow {
    return this.host.followProxy(ses, what)
  }

  /** A private context keeps no copy of an icon outside its own session (`withInlineFavicons`): nothing of the state is asked for it. */
  setSiteIconOwners(): void {}

  keepSiteIcon(): boolean {
    return false
  }

  listCookies(): Promise<CookieEntry[]> {
    return listJarCookies(this.scope.session)
  }

  removeCookies(_profileId: string, cookies: readonly CookieEntry[]): Promise<CookieRemoval> {
    return removeJarCookies(this.scope.session, cookies)
  }

  setDownloadDirResolver(resolver: ((profileId: string, sourcePageId?: string) => string | undefined) | null): void {
    this.scope.dirResolver = resolver
  }

  setDownloadNamer(namer: ((filename: string, url: string) => string) | null): void {
    this.scope.namer = namer
  }

  onDownload(listener: (download: DownloadInfo, sourcePageId: string | undefined, profileId: string) => void): void {
    const { prefix } = this.scope
    this.scope.downloadListeners.push((download, sourcePageId, profileId) => listener(download, sourcePageId?.startsWith(prefix) ? sourcePageId.slice(prefix.length) : undefined, profileId))
  }

  cancelDownload(id: string): void {
    this.host.cancelDownload(id)
  }

  pauseDownload(id: string): void {
    this.host.pauseDownload(id)
  }

  resumeDownload(id: string): void {
    // A private window has no record to resume from: only what runs.
    this.host.resumeLiveDownload(id)
  }

  startDownloadResume(): DownloadInfo[] {
    return []
  }

  stopDownloadResume(): void {}

  forgetSavedDownload(): void {}

  flushDownloadResume(): void {}

  // A session in memory keeps no file of the hosts held to strict transport security.
  flushStrictTransport(): void {}

  setDownloadPolicy(policy: DownloadPolicy): void {
    this.host.scopeSetDownloadPolicy(this.scope, policy)
  }

  sweepDownloadStaging(): void {
    this.host.sweepDownloadStaging()
  }

  loadExtension(): Promise<ExtensionInfo> {
    return Promise.reject(new Error('Extensions do not run in a private window'))
  }

  listExtensions(): ExtensionInfo[] {
    return []
  }

  listAllExtensions(): ExtensionInfo[] {
    return []
  }

  configureExtensions(): void {}
  onExtensionReview(): void {}
  onExtensionNotice(): void {}
  onExtensionsChanged(): void {}

  onExtensionForgotten(): void {}
  onExtensionMenu(): void {}

  uninstallExtension(): Promise<void> {
    return Promise.reject(new Error('Extensions do not run in a private window'))
  }

  checkExtensionUpdates(): Promise<UpdateReport> {
    return Promise.resolve({ checked: 0, updated: [], waiting: [], failed: null })
  }

  reviewExtensionUpdate(): Promise<'updated' | 'declined' | 'none'> {
    return Promise.resolve('none')
  }

  clearSiteData(_profileId: string, request: SiteDataEngineRequest): Promise<SiteDataResult[]> {
    return eraseSiteData(this.scope.session, request)
  }

  siteCookieCount(_profileId: string, host: string, subdomains: boolean): Promise<number> {
    return countSiteCookies(this.scope.session, host, subdomains)
  }

  async clearCache(): Promise<void> {
    await this.scope.session.clearCache()
  }

  async clearProfileData(): Promise<void> {
    await this.wipe()
  }

  async deleteProfileData(): Promise<void> {
    throw new Error('A private context has no profile to delete')
  }

  removeRetiredProfiles(ids: readonly string[]): string[] {
    return [...ids]
  }

  storedProfileIds(): string[] {
    return []
  }

  extensionPopupCount(): number {
    return 0
  }

  runningExtensionWorkers(): string[] {
    return []
  }

  openEphemeral(): EphemeralEngine {
    throw new Error('A private context cannot open another one')
  }

  openContainer(): EphemeralEngine {
    throw new Error('A private context cannot open a container')
  }

  eraseContainer(): Promise<void> {
    return Promise.reject(new Error('A private context cannot erase a container'))
  }

  storedContainerIds(): string[] {
    return []
  }

  storedContainerIdleMs(): number | null {
    return null
  }

  removeStoredContainers(): string[] {
    return []
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.host.scopeClose(this.scope)
    this.favicons.clear()
    await this.wipe()
  }

  /** Like `dispose`, for a container: the data is erased on the user's word, so what could not be erased is thrown at the end. */
  async erase(name: string): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.host.scopeClose(this.scope)
    this.favicons.clear()
    const failed = await wipeSession(this.scope.session, this.scope.key, sessionDecisions)
    if (failed.length > 0) throw wipeFailure(name, failed)
  }

  /** Cookies, storage, cache, logins and connections: the session is memory only, but it must not keep anything while it lives on. */
  private async wipe(): Promise<void> {
    const ses = this.scope.session
    const results = await Promise.allSettled([ses.clearData(), ses.clearAuthCache(), ses.clearHostResolverCache(), ses.clearSharedDictionaryCache(), ses.closeAllConnections()])
    for (const result of results) if (result.status === 'rejected') console.error('[engine] cannot fully erase a private session:', result.reason)
  }
}
