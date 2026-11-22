// A layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md). The policies of the network and the hooks of
// webRequest: the blocker, the response policy, the stand-ins, the page guard, WebRTC, the privacy headers, proxies, DNS, cookies, the data of a profile.

import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, session, ipcMain, type Session, type IpcMainEvent, type WebContents, type WebFrameMain } from 'electron'
import type { EngineInfo } from '@shared/ipc'
import { cleanMinimumFontSize } from '@shared/min-font-size'
import type { SiteDataResult } from '@shared/site-data'
import { NO_PLAN, PAGE_GUARD, guardPageUrl, type GuardPlan } from '@shared/page-guard'
import { pageOrigin } from '@shared/inner-guard'
import type { FingerprintConfig } from '@shared/fingerprint'
import { guardWorld } from '../../preload/guard-world'
import { InnerGuard, innerGuardFor, innerGuardOf } from './inner-guard'
import { ownSessionOf } from './own-session'
import { STAND_IN_SCHEME, standInServed, withStandInHost } from '@shared/redirect-resources'
import { safeRedirectTarget, withContentSecurityPolicy, type ResponseHeaders } from '@shared/blocker'
import { isMainFrameSender } from '@shared/surface-guard'
import { clearInterfaceIcons, clearInterfaceTraces, countSiteCookies, eraseSiteData, profileExtensionOrigins } from './site-data'
import type { AutoplayMode } from '@shared/autoplay'
import { profilePartition } from './profile-partition'
import { applyHostResolver, type ProxyFollow, type ProxySession } from './network'
import type { SignedSession } from './own-requests'
import { SiteIconCopies, type SiteIconDeps } from './site-icons'
import type { SiteIconOwner } from '@shared/site-icon'
import { listCookies as listJarCookies, removeCookies as removeJarCookies } from './cookie-book'
import { appliedFor, type ProxyPlan } from '@shared/proxy'
import type { HostResolverConfig } from '@shared/dns'
import type { CookieEntry, CookieRemoval } from '@shared/cookies'
import { readPageText, type ReadOutcome } from './page-reader'
import { rewriteNavigation, type PrivacyOptions } from '@shared/privacy'
import { takesNavigationHints, withNavigationHints, type ClientHintHeaders } from '@shared/client-hints'
import { SIGN_IN_PRELOAD_EXCLUDES, isSignInRequest, signInRequestHeaders } from '@shared/google-sign-in'
import { engineClientHints, type HintSource } from './engine-client-hints'
import { documentOfRequest, siteOf } from '@shared/party'
import { cookiesBlockedFor, withoutCookieHeader, withoutSetCookie } from '@shared/third-party-cookies'
import { netResourceType } from '@shared/net-rules'
import { isStorePage } from '@shared/web-store'
import { authChallenge, ExtensionNet, listenerLogins, NET_LIMITS, ruleGivenUpNote, type FrameDocument, type HookRequest, type WebRequestEvent } from './extension-net'
import { answerLocalFile, LOCAL_FILE_PATTERN, localPageRead, REFUSED_READ, sharedWithLocalPage } from './local-file-guard'
import { certificateExceptions } from './error-pages'
import { noteStrictTransportAnswer, strictTransportHosts } from './strict-transport'
import { strictTransportStore } from './strict-transport-store'
import { profileDirectory, STORE_DIR } from './web-store-files'
import { isProfileId } from '@shared/profiles'
import type { ExtensionTabHooks, InnerGuardProvider, PageGuardProvider, PermissionPolicy, RequestBlocker, ResponsePolicy, SiteDataEngineRequest } from './types'
import { t } from '@shared/i18n'
import { pageGuardPath, PAGE_GUARD_ID, PAGE_GUARD_WORKER_ID } from './electron-engine-base'
import { ElectronEnginePreloads } from './electron-engine-preloads'

/** What every hook of `session.webRequest` says of a request. */
export interface RequestDetails {
  id: number
  url: string
  method: string
  resourceType: string
  timestamp?: number
  initiatorOrigin?: string | undefined
  webContents?: WebContents | undefined
  frame?: WebFrameMain | null | undefined
}

/** What the extensions make of the headers of an answer: the headers, or a cancel, and the status line of a redirect a listener asked for. */
interface AnswerHeaders {
  headers: ResponseHeaders
  cancel?: true
  statusLine?: string
}

const isSignedSession = (ses: object): ses is SignedSession => typeof (ses as { webRequest?: { onBeforeSendHeaders?: unknown } }).webRequest?.onBeforeSendHeaders === 'function'

/**
 * Whether the application itself made the request (`session.fetch`): no page and no frame behind it, and no origin that asked for it. A page,
 * a worker of a site and a context of an extension all carry their origin, even when the tab or the frame is gone; the navigation of a tab is
 * the user's, and carries its page.
 */
export function isOwnRequest(details: RequestDetails): boolean {
  if (details.webContents || details.frame) return false
  if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') return false
  return details.initiatorOrigin === undefined || details.initiatorOrigin === ''
}

export abstract class ElectronEngineNetwork extends ElectronEnginePreloads {
  info(): EngineInfo {
    return { name: 'electron', version: process.versions.electron, chromium: process.versions.chrome }
  }

  setExtensionTabHooks(hooks: ExtensionTabHooks): void {
    this.hooks = hooks
  }

  setPermissionPolicy(policy: PermissionPolicy): void {
    this.policy = policy
  }

  setRequestBlocker(blocker: RequestBlocker | null): void {
    this.requestBlocker = blocker
    for (const { session: ses } of this.profiles.values()) this.installRequestBlocker(ses)
  }

  /** Who the state says shows an icon (`setSiteIconOwners`); null until the shell said. */
  private siteIconOwners: ((iconUrl: string) => SiteIconOwner | null) | null = null

  /**
   * The copies of the icons of sites the interface draws. An icon is downloaded through the session of the profile that shows it: the request has
   * the cookies of the profile, passes the hooks of its session (the blocker, the privacy headers) and is hidden from its extensions like the other
   * requests the application makes itself. The blocker is asked first, with the page the icon is shown for: the hook of the session sees a request
   * with no page behind it, and judges it as its own.
   */
  protected readonly siteIcons = new SiteIconCopies(this.siteIconDeps())

  /** What the copies are given of the engine: the session of a profile, the blocker of the pages, and what the shell says of the state. */
  protected siteIconDeps(): SiteIconDeps {
    return {
      fetch: (profileId, url, signal) => this.fetchSiteIcon(profileId, url, signal),
      blocked: (iconUrl, pageUrl) => this.siteIconBlocked(iconUrl, pageUrl),
      owner: (iconUrl) => this.siteIconOwners?.(iconUrl) ?? null,
      warn: (line) => console.warn(line)
    }
  }

  /** The request of an icon: a GET of the session of the profile, with its cookies and without a Referer (the page that shows the icon is nobody's business but the user's). */
  protected fetchSiteIcon(profileId: string, url: string, signal: AbortSignal): Promise<Response> {
    // A profile that a space uses: its session is the one a tab of that space has (the shell names no other, and the state is checked the same way).
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(profileId)) return Promise.reject(new Error('unknown profile'))
    return this.ensureProfile(profileId).session.fetch(url, { signal, credentials: 'include', referrerPolicy: 'no-referrer', headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' } })
  }

  /** Whether the blocker of the pages stops this icon on that page: cancelled, or sent to a stand-in, the address is not to be contacted (as in declared-icon.ts). */
  protected siteIconBlocked(iconUrl: string, pageUrl: string): boolean {
    return this.requestBlocker !== null && this.requestBlocker({ url: iconUrl, resourceType: 'image', pageUrl, pageId: null, documentUrl: pageUrl, method: 'GET' }) !== false
  }

  setSiteIconOwners(find: ((iconUrl: string) => SiteIconOwner | null) | null): void {
    this.siteIconOwners = find
  }

  keepSiteIcon(iconUrl: string, bytes: Uint8Array, contentType: string | null): boolean {
    return this.siteIcons.keep(iconUrl, bytes, contentType)
  }

  setPrivacy(options: PrivacyOptions | null): void {
    this.privacy = options
    // What the application asks for itself says what the pages say (own-requests.ts).
    this.ownRequests.set(options?.globalPrivacyControl === true)
    for (const { session: ses } of this.profiles.values()) {
      this.installRequestBlocker(ses)
      // The answers lose their Set-Cookie in the response hook, which the request hook does not install.
      this.installResponsePolicy(ses, this.headerHooks.get(ses)?.policyOf ?? (() => null))
    }
  }

  setResponsePolicy(policy: ResponsePolicy | null): void {
    this.responsePolicy = policy
    for (const { session: ses } of this.profiles.values()) this.installResponsePolicy(ses, () => this.responsePolicy)
  }

  setPageGuard(provider: PageGuardProvider | null): void {
    this.guard = provider
    for (const { session: ses } of this.profiles.values()) this.syncPageGuard(ses, provider !== null)
    this.syncGuardListener()
  }

  setInnerGuard(provider: InnerGuardProvider | null): void {
    this.innerGuard = provider
    for (const { session: ses } of this.profiles.values()) this.syncInnerGuards(ses)
  }

  setHostResolver(config: HostResolverConfig | null): string | null {
    return applyHostResolver((options) => app.configureHostResolver(options), config)
  }

  async setProxies(plan: ProxyPlan | null): Promise<string[]> {
    // Off, and never on since the start: every session is on the system's proxy already, and nothing is called.
    if (plan === null && this.proxyPlan === null) return []
    this.proxyPlan = plan
    const jobs: Array<[string, Promise<string | null>]> = []
    for (const [id, profile] of this.profiles) jobs.push([`profile ${id}`, this.proxies.apply(profile.session, plan ? appliedFor(plan, id) : null, `profile ${id}`)])
    for (const scope of this.scopes.values()) jobs.push(['a private window', this.proxies.apply(scope.session, plan ? plan.global : null, scope.key)])
    // The application's own requests (suggestions, filter lists, updates) follow the global proxy: they would otherwise leave by the system's route.
    jobs.push(['the application', this.proxies.apply(session.defaultSession, plan ? plan.global : null, 'the application')])
    jobs.push(...this.ownSessions.reapply())
    const results = await Promise.all(jobs.map(async ([what, job]) => [what, await job] as const))
    return results.filter(([, failure]) => failure !== null).map(([what, failure]) => `${what} : ${failure}`)
  }

  followProxy(ses: ProxySession, what: string): ProxyFollow {
    const follow = this.ownSessions.follow(ses, what)
    // A session the shell asks sites with for itself: its requests carry the header of Global Privacy Control while the option is on. A stand-in
    // of a test that has no request hooks is followed for its proxy alone.
    const signed = isSignedSession(ses) ? ses : null
    if (signed) this.ownRequests.add(signed)
    return {
      settled: follow.settled,
      release: () => {
        follow.release()
        if (signed) this.ownRequests.remove(signed)
      }
    }
  }

  /** A session just made takes the proxy the settings give it (nothing at all while the option is off). */
  protected applyProxyTo(ses: Session, profileId: string | null, what: string): void {
    if (this.proxyPlan === null) return
    void this.proxies.apply(ses, appliedFor(this.proxyPlan, profileId), what)
  }

  listCookies(profileId: string): Promise<CookieEntry[]> {
    return listJarCookies(this.ensureProfile(profileId).session)
  }

  removeCookies(profileId: string, cookies: readonly CookieEntry[]): Promise<CookieRemoval> {
    return removeJarCookies(this.ensureProfile(profileId).session, cookies)
  }

  readPageText(profileId: string, url: string, options: { selector?: string; timeoutMs?: number; settleMs: number }): Promise<ReadOutcome> {
    // The shell only asks for a profile that a space uses: its session is the one a tab of that space would have.
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(profileId)) return Promise.resolve({ ok: false, error: t('engine.le-profil-de-cette-page-est-inconnu') })
    return readPageText(this.ensureProfile(profileId).session, url, options)
  }

  async clearCache(profileId: string): Promise<void> {
    await session.fromPartition(profilePartition(profileId, 'clearing a cache')).clearCache()
    // The copies of the icons were downloaded through that cache: they go with it, and are downloaded again when a row shows them.
    this.siteIcons.clear()
    await clearInterfaceIcons(session.defaultSession)
  }

  async clearProfileData(profileId: string): Promise<void> {
    const ses = session.fromPartition(profilePartition(profileId, 'clearing a profile'))
    // Extensions keep their storage and service workers in the same session: wiping them would break every extension of the profile.
    const excludeOrigins = profileExtensionOrigins(this.loaded, profileId)
    await ses.clearData(excludeOrigins.length > 0 ? { excludeOrigins } : {})
    // HTTP authentication (the box a 401 opens) is cached outside the data `clearData` covers: a cleared profile must not stay signed in.
    await ses.clearAuthCache()
    // The hosts held to strict transport security tell which sites were visited (by a digest of their name): they go with the rest.
    strictTransportStore.forget(ses)
    // The addresses recorded for a resumption hold tokens of that profile's sign-ins: they are erased with the rest.
    this.resume?.forgetProfile(profileId)
    this.siteIcons.clear()
    await clearInterfaceTraces(session.defaultSession)
  }

  /**
   * A deleted profile: everything its session holds, the storage of the extensions included, and the extensions installed in it from the Chrome Web
   * Store (each uninstalled with its folder, its storage and its chrome.storage, then the profile's folder of them). What Chromium keeps in the
   * partition folder beyond this goes at the next launch (`removeRetiredProfiles`), the id being retired meanwhile (shared/profile-retire.ts).
   */
  async deleteProfileData(profileId: string): Promise<void> {
    const ses = session.fromPartition(profilePartition(profileId, 'deleting a profile'))
    for (const { id } of this.storeExtensionsOf(profileId)) await this.webStore.uninstall(profileId, id)
    await rm(profileDirectory(join(app.getPath('userData'), STORE_DIR), profileId), { recursive: true, force: true })
    await ses.clearData()
    await ses.clearAuthCache()
    strictTransportStore.forget(ses)
    this.siteIcons.clear()
    this.resume?.forgetProfile(profileId)
    await clearInterfaceTraces(session.defaultSession)
  }

  /** The extensions of a profile installed from the Chrome Web Store, loaded in this run. */
  private storeExtensionsOf(profileId: string): Array<{ id: string }> {
    return [...this.known.entries()].filter(([key, entry]) => key.startsWith(`${profileId}:`) && entry.info.source === 'store').map(([, entry]) => ({ id: entry.info.id }))
  }

  /**
   * At launch, before any page: the folders of the retired profiles (their partition, their Chrome Web Store extensions). Never the folder of a
   * profile whose session is open in this run. Answers the ids whose folders could not be removed.
   */
  removeRetiredProfiles(ids: readonly string[]): string[] {
    const failed: string[] = []
    for (const id of ids) {
      if (!isProfileId(id) || id === 'default' || this.profiles.has(id)) {
        console.error(`[profiles] refused to remove the folders of the profile ${JSON.stringify(id).slice(0, 40)}: not a retired profile, or its session is open`)
        failed.push(id)
        continue
      }
      try {
        rmSync(join(app.getPath('userData'), 'Partitions', `profile-${id}`), { recursive: true, force: true })
        rmSync(profileDirectory(join(app.getPath('userData'), STORE_DIR), id), { recursive: true, force: true })
      } catch (error) {
        console.error(`[profiles] cannot remove the folders of the deleted profile ${id}:`, error)
        failed.push(id)
      }
    }
    return failed
  }

  storedProfileIds(): string[] {
    const dir = join(app.getPath('userData'), 'Partitions')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((name) => name.startsWith('profile-')).map((name) => name.slice('profile-'.length))
  }

  /**
   * The one `onBeforeRequest` hook of a session of pages: it refuses what a local page may not read of the disk (local-file-guard.ts), cancels
   * what the blocker names and redirects the navigations the privacy options rewrite (HTTPS first, tracking parameters). The local files are
   * always watched; the web requests only while there is something to do with them: an idle listener would cost every request an IPC hop.
   * A session has a single such hook, so the three jobs share it.
   */
  protected installRequestBlocker(ses: Session, blockerOf: () => RequestBlocker | null = () => this.requestBlocker, pagePrefix = '', privacyOf: () => PrivacyOptions | null = () => this.privacy): void {
    this.requestHooks.set(ses, { blockerOf, pagePrefix, privacyOf })
    this.installPrivacyHeaders(ses, privacyOf)
    const rewrites = (): boolean => {
      const options = privacyOf()
      return options !== null && (options.httpsUpgrade || options.stripTrackingParams)
    }
    // The extensions of the session: their rules are judged here, after the application's own, and their listeners are told (extension-net.ts).
    const net = this.extensionNets.get(ses)
    const needs = net?.needs()
    const forExtensions = needs !== undefined && (needs.rules || needs.events.has('onBeforeRequest'))
    const urls = blockerOf() || rewrites() || forExtensions ? ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', LOCAL_FILE_PATTERN] : [LOCAL_FILE_PATTERN]
    ses.webRequest.onBeforeRequest({ urls }, (details, callback) => {
      if (details.url.startsWith('file:')) {
        // Before the document is let through, so that no line of it runs unwatched.
        if (details.resourceType === 'mainFrame') this.watchLocalPages(ses)
        return this.answerLocalFileRequest(details, callback)
      }
      // The callback is answered exactly once, and always: a filter that throws would leave the request suspended for ever.
      let answer: { cancel?: boolean; redirectURL?: string }
      try {
        const owner = details.webContents
        const alive = owner && !owner.isDestroyed()
        const pageUrl = alive ? owner.getURL() : null
        // A private context's pages carry its prefix in the engine; the shell knows them without it.
        const engineId = alive ? this.pageByContents.get(owner.id) : undefined
        const pageId = engineId?.startsWith(pagePrefix) ? engineId.slice(pagePrefix.length) : null
        const documentUrl = documentOfRequest(details)
        const verdict = blockerOf()?.({ url: details.url, resourceType: details.resourceType, pageUrl, pageId, documentUrl, method: details.method })
        const allowed = typeof verdict === 'object' && verdict !== null ? safeRedirectTarget(verdict.redirect) : null
        // A stand-in is asked for under the word of this session: a page that guesses the address finds nothing there.
        const target = allowed !== null && allowed.startsWith(`${STAND_IN_SCHEME}:`) ? withStandInHost(allowed, this.standInWord(ses)) : allowed
        if (verdict === true) {
          answer = { cancel: true }
        } else if (target !== null) {
          answer = { redirectURL: target }
        } else {
          if (typeof verdict === 'object' && verdict !== null) console.error('[engine] the request filter asked for an address that is not allowed; the request goes through unchanged:', String(verdict.redirect).slice(0, 80))
          const options = privacyOf()
          // Only the navigations of a page of ours are rewritten: never a worker's, an extension's or a subresource's request.
          const rewritten = alive && options ? rewriteNavigation({ url: details.url, method: details.method, isMainFrame: details.resourceType === 'mainFrame' }, options, (httpUrl) => this.upgrades.upgrade(owner.id, httpUrl)) : null
          answer = rewritten ? { redirectURL: rewritten } : { cancel: false }
        }
        if (net && forExtensions && !this.keptFromExtensions(details)) {
          const decided = this.withExtensionRules(net, details, answer)
          // The blocking listeners of an extension were asked: the request waits for them (BLOCKING_WAIT_MS at most), and is answered once.
          if (decided instanceof Promise) return void decided.then(callback)
          answer = decided
        }
      } catch (error) {
        console.error('[engine] the request filter failed, so the request goes through unfiltered:', error instanceof Error ? error.message : error)
        answer = { cancel: false }
      }
      callback(answer)
    })
  }

  /**
   * The rules of the extensions on a request the application lets through: they come after its own protections, so an extension can stop or
   * send elsewhere what the application lets go, and can never let through what the application stops. In this order: the guard of the local
   * files (before this), the blocker and the rewrites of the application, the declarative rules of the extensions, then the blocking listeners of
   * chrome.webRequest, asked only about a request the three before let go unchanged (in Chromium too a block or a redirect of a declarative rule
   * wins over what the listeners answer). Every listener hears the request either way. A promise when blocking listeners were asked: it settles with the answer for the hook, never rejects.
   */
  private withExtensionRules(net: ExtensionNet, details: RequestDetails, answer: { cancel?: boolean; redirectURL?: string }): { cancel?: boolean; redirectURL?: string } | Promise<{ cancel?: boolean; redirectURL?: string }> {
    try {
      const request = this.hookRequest(details)
      if (answer.cancel === true || answer.redirectURL !== undefined) {
        net.heard('onBeforeRequest', request)
        return answer
      }
      const outcome = net.beforeRequest(request)
      if (outcome.action === 'block' || outcome.action === 'redirect') {
        net.heard('onBeforeRequest', request)
        return outcome.action === 'block' ? { cancel: true } : { redirectURL: outcome.url }
      }
      const asked = net.blockBeforeRequest(request)
      if (asked)
        return asked.then(
          (verdict) => (verdict.cancel ? { cancel: true } : verdict.redirectUrl !== null ? { redirectURL: verdict.redirectUrl } : answer),
          (error: unknown) => {
            console.error('[engine] the answers of the blocking listeners failed on a request, which goes on as the application decided:', error instanceof Error ? error.message : error)
            return answer
          }
        )
    } catch (error) {
      console.error('[engine] the request rules of the extensions failed on a request, which goes on as the application decided:', error instanceof Error ? error.message : error)
    }
    return answer
  }

  /**
   * What the extensions neither judge nor hear. The requests the application makes itself in the session of a profile (the text of a page read
   * again, the images of a page saved, the probe of a download to resume), as in Chrome, which hides the browser's own requests from them: an
   * extension must not block, send elsewhere or read what the user asked the application for. And the pages of the Chrome Web Store with what
   * they ask for: an extension must not rewrite the page that installs extensions.
   */
  private keptFromExtensions(details: RequestDetails): boolean {
    if (isOwnRequest(details)) return true
    if (isStorePage(details.url)) return true
    const owner = details.webContents
    return owner !== undefined && owner !== null && !owner.isDestroyed() && isStorePage(owner.getURL())
  }

  /** A request of a session hook as the rules and the listeners of the extensions read it: who asks, from which tab, inside which documents. */
  private hookRequest(details: RequestDetails): HookRequest {
    const type = netResourceType(details.resourceType)
    const owner = details.webContents
    const tabId = owner && !owner.isDestroyed() && this.tabMeta.has(owner.id) ? owner.id : -1
    const documents: FrameDocument[] = []
    let frameId = type === 'main_frame' ? 0 : -1
    let parentFrameId = -1
    try {
      const frame = details.frame ?? null
      if (frame && type !== 'main_frame') {
        frameId = frame.parent === null ? 0 : frame.frameTreeNodeId
        parentFrameId = frame.parent === null ? -1 : frame.parent.parent === null ? 0 : frame.parent.frameTreeNodeId
      }
      // The navigation of a frame is asked by the frame above it; anything else by the frame it is in. A navigation of the tab sits in no document.
      let at = type === 'main_frame' ? null : type === 'sub_frame' ? (frame?.parent ?? null) : frame
      for (let depth = 0; at && depth < 32; depth++) {
        documents.push({ url: at.url, top: at.parent === null })
        at = at.parent
      }
    } catch (error) {
      // A frame that went away while its request was leaving cannot be read: the request is judged without the documents above it.
      console.debug('[engine] cannot read the frames behind a request for the rules of the extensions:', error instanceof Error ? error.message : error)
    }
    const origin = typeof details.initiatorOrigin === 'string' && details.initiatorOrigin !== '' && details.initiatorOrigin !== 'null' ? details.initiatorOrigin : null
    const asking = origin ?? documents[0]?.url ?? null
    const initiator = asking !== null && URL.canParse(asking) && new URL(asking).origin !== 'null' ? new URL(asking).origin : asking
    return { id: details.id, url: details.url, method: details.method, type, initiator, tabId, documents, frameId, parentFrameId, timeStamp: details.timestamp ?? Date.now() }
  }

  /** The object that holds the rules and the listeners of the extensions of a profile session, made with the session. */
  protected extensionNetOf(ses: Session, profileId: string): ExtensionNet {
    const existing = this.extensionNets.get(ses)
    if (existing) return existing
    const net = new ExtensionNet({
      readRuleset: async (path) => {
        const info = await stat(path)
        if (!info.isFile() || info.size > NET_LIMITS.rulesetBytes) throw new Error(`it is not a file, or it is larger than the ${NET_LIMITS.rulesetBytes} bytes a ruleset may be`)
        return JSON.parse(await readFile(path, 'utf8')) as unknown
      },
      saved: (extensionId) => this.extensionLedger().netChoices(profileId, extensionId),
      save: (extensionId, value) => this.extensionLedger().keepNetChoices(profileId, extensionId, value),
      siteOf,
      changed: () => this.installExtensionHooks(ses),
      send: (extensionId, event, eventDetails, wake, contexts, ask) => this.sendRequestEvent(profileId, extensionId, event, eventDetails, wake, contexts, ask),
      warn: (message) => console.warn(`[net-rules] ${message}`),
      // The Extensions page shows the line under the extension: without it a rule that stopped covering a request does so without a word.
      ruleGivenUp: (extensionId, ruleId, why, _addressLength, limit) => this.extensionTools.note(profileId, extensionId, ruleGivenUpNote(ruleId, why, limit))
    })
    this.extensionNets.set(ses, net)
    return net
  }

  /** What the extensions of a session need of its hooks has changed: every hook is installed again with what it was last given. */
  private installExtensionHooks(ses: Session): void {
    const request = this.requestHooks.get(ses)
    // `installRequestBlocker` installs the hook of the request headers too.
    if (request) this.installRequestBlocker(ses, request.blockerOf, request.pagePrefix, request.privacyOf)
    this.installResponsePolicy(ses, this.headerHooks.get(ses)?.policyOf ?? (() => null))
    this.installRequestEvents(ses)
  }

  /**
   * An event of chrome.webRequest goes to the contexts of an extension; a worker that listens but is stopped is started for it, one start at a time.
   * `ask`: the token the contexts with a blocking listener answer with. The pages that listen and are not panels (a Manifest V2 background page)
   * are reached by their id.
   */
  private sendRequestEvent(profileId: string, extensionId: string, event: WebRequestEvent, details: Record<string, unknown>, wake: boolean, contexts: readonly string[] = [], ask?: string): void {
    if (!wake) {
      const args = ask === undefined ? [details] : [details, { ask }]
      this.emitShimEvent(extensionId, 'webRequest', event, args, profileId)
      return this.emitToExtensionPages(extensionId, profileId, contexts, 'webRequest', event, args)
    }
    const key = `${profileId}:${extensionId}`
    const now = Date.now()
    if (now - (this.netWakes.get(key) ?? 0) < 5000) return
    this.netWakes.set(key, now)
    this.deliverToWorker(extensionId, profileId, 'webRequest', event, [details]).catch((error: unknown) => console.warn(`[net-rules] the worker of ${extensionId} could not be started for a request it listens to:`, error instanceof Error ? error.message : error))
  }

  /**
   * The hooks that only watch (`onSendHeaders`, `onBeforeRedirect`, `onResponseStarted`, `onCompleted`, `onErrorOccurred`): each is on a session
   * exactly while an extension of it listens to the event of the same name, so that a profile without such an extension pays nothing.
   */
  protected installRequestEvents(ses: Session): void {
    const net = this.extensionNets.get(ses)
    if (!net) return
    const events = net.needs().events
    const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
    const tell = (event: WebRequestEvent, details: RequestDetails & { requestHeaders?: Record<string, string | string[]>; responseHeaders?: Record<string, string | string[]>; statusCode?: number; statusLine?: string; ip?: string; fromCache?: boolean; redirectURL?: string; error?: string }): void => {
      try {
        if (this.keptFromExtensions(details)) return
        net.heard(event, this.hookRequest(details), {
          ...(details.requestHeaders ? { requestHeaders: details.requestHeaders } : {}),
          ...(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {}),
          ...(details.statusCode !== undefined ? { statusCode: details.statusCode } : {}),
          ...(details.statusLine !== undefined ? { statusLine: details.statusLine } : {}),
          ...(details.ip !== undefined ? { ip: details.ip } : {}),
          ...(details.fromCache !== undefined ? { fromCache: details.fromCache } : {}),
          ...(details.redirectURL !== undefined ? { redirectUrl: details.redirectURL } : {}),
          ...(details.error !== undefined ? { error: details.error } : {})
        })
      } catch (error) {
        console.error(`[engine] cannot tell the extensions about a request (${event}):`, error instanceof Error ? error.message : error)
      }
    }
    if (events.has('onSendHeaders')) ses.webRequest.onSendHeaders(filter, (details) => tell('onSendHeaders', details))
    else ses.webRequest.onSendHeaders(null)
    if (events.has('onBeforeRedirect')) ses.webRequest.onBeforeRedirect(filter, (details) => tell('onBeforeRedirect', details))
    else ses.webRequest.onBeforeRedirect(null)
    if (events.has('onResponseStarted')) ses.webRequest.onResponseStarted(filter, (details) => tell('onResponseStarted', details))
    else ses.webRequest.onResponseStarted(null)
    if (events.has('onCompleted')) ses.webRequest.onCompleted(filter, (details) => tell('onCompleted', details))
    else ses.webRequest.onCompleted(null)
    if (events.has('onErrorOccurred')) ses.webRequest.onErrorOccurred(filter, (details) => tell('onErrorOccurred', details))
    else ses.webRequest.onErrorOccurred(null)
  }

  /**
   * What the hook of the headers of an answer does for the extensions: their listeners hear the answer, their rules rewrite its headers, then their
   * blocking listeners are asked (they are told the headers the server sent; a header a rule changed is not theirs to change again). A server that
   * asks for a login asks the blocking listeners of onAuthRequired next: what they answer waits for the page's question (`listenerLogins`).
   * A promise when listeners were asked; it never rejects.
   */
  private answerForExtensions(ses: Session, net: ExtensionNet, details: RequestDetails & { statusCode: number; statusLine: string }, headers: ResponseHeaders): AnswerHeaders | Promise<AnswerHeaders> {
    const unchanged: AnswerHeaders = { headers }
    try {
      if (this.keptFromExtensions(details)) return unchanged
      const request = this.hookRequest(details)
      const extras = { statusCode: details.statusCode, statusLine: details.statusLine, responseHeaders: headers }
      const ruled = net.headers(request, headers, 'response')
      const asked = net.blockResponseHeaders(request, extras, ruled)
      const challenged = authChallenge(details.statusCode, headers, details.url) !== null
      const login = (): Promise<void> | null => {
        if (!challenged) return null
        const answered = net.blockAuth(request, extras)
        return answered?.then((answer) => void (answer !== null && listenerLogins.keep(ses, details.url, answer, Date.now()))) ?? null
      }
      if (!asked) {
        const waited = login()
        return waited ? waited.then(() => ({ headers: ruled }), (error: unknown) => this.extensionAnswerFailed(error, { headers: ruled })) : { headers: ruled }
      }
      return asked
        .then(async (verdict): Promise<AnswerHeaders> => {
          if (verdict.cancel) return { headers: ruled, cancel: true }
          // A login is asked only of an answer that stays the server's: not of one a listener turned into a redirect (Chromium tells nobody then).
          if (verdict.statusLine === null) await login()
          return verdict.statusLine === null ? { headers: verdict.headers } : { headers: verdict.headers, statusLine: verdict.statusLine }
        })
        .catch((error: unknown) => this.extensionAnswerFailed(error, { headers: ruled }))
    } catch (error) {
      console.error('[engine] the header rules of the extensions failed on an answer, which keeps its headers:', error instanceof Error ? error.message : error)
      return unchanged
    }
  }

  private extensionAnswerFailed<T>(error: unknown, fallback: T): T {
    console.error('[engine] the answers of the blocking listeners failed on a request, which goes on without them:', error instanceof Error ? error.message : error)
    return fallback
  }

  /** The same for the headers of a request that is leaving. Null: a blocking listener cancels it. */
  private requestForExtensions(net: ExtensionNet, details: RequestDetails, headers: Record<string, string>): Record<string, string> | null | Promise<Record<string, string> | null> {
    try {
      if (this.keptFromExtensions(details)) return headers
      const request = this.hookRequest(details)
      const ruled = net.headers(request, headers, 'request')
      const asked = net.blockRequestHeaders(request, headers, ruled)
      if (!asked) return ruled
      return asked.then(
        (verdict) => (verdict.cancel ? null : verdict.headers),
        (error: unknown) => this.extensionAnswerFailed(error, ruled)
      )
    } catch (error) {
      console.error('[engine] the header rules of the extensions failed on a request, which keeps its headers:', error instanceof Error ? error.message : error)
      return headers
    }
  }

  /** A request of a page for a file of the disk: judged against the top document of the page that asks, and answered exactly once. */
  private answerLocalFileRequest(details: { url: string; resourceType: string; webContents?: WebContents | undefined }, callback: (response: { cancel: boolean }) => void): void {
    let topUrl: string | null = null
    try {
      const owner = details.webContents
      topUrl = owner && !owner.isDestroyed() ? owner.getURL() : null
    } catch (error) {
      // No top document known: the request is refused (answerLocalFile refuses a local file no local page asks for).
      console.error('[engine] cannot tell which page asks for a local file, so it is refused:', error instanceof Error ? error.message : error)
    }
    answerLocalFile({ url: details.url, resourceType: details.resourceType, topUrl }, app.getPath('home'), callback)
  }

  /**
   * A local file opens in a tab of this session: from now on its header hooks also watch what a local page reads of the web (local-file-guard.ts).
   * The watch stays for the rest of the run; a session that never opens a local file never has it.
   */
  private watchLocalPages(ses: Session): void {
    if (this.localPageSessions.has(ses)) return
    this.localPageSessions.add(ses)
    const hooks = this.headerHooks.get(ses)
    this.installPrivacyHeaders(ses, hooks?.privacyOf ?? (() => null))
    this.installResponsePolicy(ses, hooks?.policyOf ?? (() => null))
  }

  /**
   * A tab of this session went onto the sign-in hosts of Google (google-sign-in-agent.ts): from now on the header hook of the session sees every web request, as the
   * tab carries the identity of the sign-in on all of them. It stays so for the rest of the run, as for the local files; a session that never shows these pages never pays
   * for it. A session without the hook of the pages (it never came through `installRequestBlocker`) is left alone: its hook, if it has one, is not ours to replace.
   */
  protected watchSignInPages(ses: Session): void {
    if (this.signInSessions.has(ses)) return
    const privacyOf = this.headerHooks.get(ses)?.privacyOf
    if (privacyOf === undefined) return
    this.signInSessions.add(ses)
    this.installPrivacyHeaders(ses, privacyOf)
  }

  /** The headers of a web request are leaving: a read of a local page is remembered until its answer comes. False when the request must not leave. */
  private noteLocalPageRead(details: { id: number; url: string; resourceType: string; requestHeaders?: Record<string, string | string[]>; webContents?: WebContents | undefined; frame?: { origin: string } | null | undefined; initiatorOrigin?: string | undefined }): boolean {
    try {
      const owner = details.webContents
      const topUrl = owner && !owner.isDestroyed() ? owner.getURL() : null
      let frameOrigin: string | null = null
      try {
        frameOrigin = details.frame?.origin ?? null
      } catch (error) {
        // A frame that went away while its request was leaving cannot be read: the request is judged on the top document of its page.
        console.warn('[engine] cannot read the frame behind a web request, so it is judged on the top document of its page:', error instanceof Error ? error.message : error)
        frameOrigin = null
      }
      const read = localPageRead({ url: details.url, resourceType: details.resourceType, frameOrigin, topUrl, initiatorOrigin: details.initiatorOrigin, requestHeaders: details.requestHeaders })
      if (read === REFUSED_READ) {
        this.localPageReads.forget(details.id)
        console.warn(`[engine] refused a ${details.resourceType} request of the web that a local file made with no page behind it (a shared worker)`)
        return false
      }
      // A request sent again (a redirect) is judged again under the same id.
      if (!read) {
        this.localPageReads.forget(details.id)
        return true
      }
      if (this.localPageReads.note(details.id, read, Date.now())) return true
      console.warn('[engine] refused a read of the web by a local page: too many of its reads are still waiting for their answer')
      return false
    } catch (error) {
      console.error('[engine] cannot tell whether a local page is reading the web, so this request is not judged:', error instanceof Error ? error.message : error)
      return true
    }
  }

  /** The answer to a web request has come: true when it is the answer to a read of a local page that the server does not share with it. */
  private keptFromLocalPage(details: { id: number; responseHeaders?: Record<string, string | string[]> }): boolean {
    const read = this.localPageReads.take(details.id)
    if (!read) return false
    if (sharedWithLocalPage(read, details.responseHeaders)) return false
    console.warn('[engine] kept the answer of a web site from a local page: the server does not share it with other origins')
    return true
  }

  /**
   * The one `onHeadersReceived` hook of a session of pages. The `$csp` rules of the lists: a Content-Security-Policy added to the main documents
   * the policy answers for. And, once a local file was opened in the session, the answers a local page may not read (`watchLocalPages`). And the
   * hosts that ask for strict transport security (strict-transport.ts): a certificate error on one of them is not clicked through afterwards,
   * in this run and in the next ones (strict-transport-store.ts).
   * The hook is always there for that last one; with nothing else to do it only looks at main documents.
   */
  protected installResponsePolicy(ses: Session, policyOf: () => ResponsePolicy | null): void {
    this.headerHooks.set(ses, { ...this.headerHooks.get(ses), policyOf })
    // A session that keeps its data on disk reads back, once, the hosts an earlier run held as strict, before any answer is looked at.
    strictTransportStore.attach(ses)
    // The extended rules of the blocker are on for this session exactly while it has a policy: the stand-in resources are served then, and only then.
    this.syncStandIns(ses, policyOf() !== null)
    const local = this.localPageSessions.has(ses)
    const privacyOf = this.headerHooks.get(ses)?.privacyOf
    const cookieCut = privacyOf?.()?.blockThirdPartyCookies === true
    const net = this.extensionNets.get(ses)
    const needs = net?.needs()
    const forExtensions = needs !== undefined && (needs.responseHeaders || needs.events.has('onHeadersReceived') || needs.events.has('onAuthRequired'))
    // The handshake of a WebSocket carries the cookies and may set some: it is looked at as soon as the cookies are cut.
    const filter = forExtensions || cookieCut ? { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] } : local ? { urls: ['http://*/*', 'https://*/*'] } : policyOf() ? { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame' as const] } : { urls: ['https://*/*'], types: ['mainFrame' as const] }
    ses.webRequest.onHeadersReceived(filter, (details, callback) => {
      if (local && this.keptFromLocalPage(details)) return callback({ cancel: true })
      const sent = (details.responseHeaders ?? {}) as ResponseHeaders
      // Read as the server sent it, before the rules of an extension rewrite the headers; never from a host whose certificate was let through.
      noteStrictTransportAnswer(strictTransportHosts, (host) => certificateExceptions.wasLetThrough(ses, host), ses, details)
      // The rules and the listeners of the extensions first, the policy of the application last: an extension cannot take away the policy the blocker adds.
      const finish = (fromExtensions: AnswerHeaders): void => {
        if (fromExtensions.cancel) return callback({ cancel: true })
        let headers = fromExtensions.headers
        if (details.resourceType === 'mainFrame') {
          // Answered exactly once and always: a policy that throws leaves the headers as they are.
          try {
            const policy = policyOf()?.({ url: details.url }) ?? null
            headers = withContentSecurityPolicy(headers, policy)
          } catch (error) {
            console.error('[engine] the response policy failed, so the document keeps the headers it came with:', error instanceof Error ? error.message : error)
          }
        }
        // A third-party answer is kept without its cookies.
        if (cookieCut && details.resourceType !== 'mainFrame' && this.thirdPartyCookiesCut(details, privacyOf?.() ?? null)) headers = withoutSetCookie(headers)
        callback(fromExtensions.statusLine !== undefined ? { responseHeaders: headers, statusLine: fromExtensions.statusLine } : headers !== sent ? { responseHeaders: headers } : {})
      }
      const fromExtensions = net && forExtensions ? this.answerForExtensions(ses, net, details, sent) : { headers: sent }
      if (fromExtensions instanceof Promise) return void fromExtensions.then(finish)
      finish(fromExtensions)
    })
  }

  /**
   * Whether the cookies of this request are cut (third-party-cookies.ts). The page of the tab is read from its web contents; a request without one
   * (the browser's own) is left alone, and so is one whose page cannot be read, with a line in the log: nothing is cut on the strength of an unknown.
   */
  private thirdPartyCookiesCut(details: RequestDetails, options: PrivacyOptions | null): boolean {
    if (options === null || !options.blockThirdPartyCookies) return false
    let topUrl: string | null = null
    try {
      const owner = details.webContents
      topUrl = owner && !owner.isDestroyed() ? owner.getURL() : null
    } catch (error) {
      console.error('[privacy] cannot tell which page a request belongs to, so its cookies are left alone:', error instanceof Error ? error.message : error)
    }
    return cookiesBlockedFor({ url: details.url, resourceType: details.resourceType, topUrl }, options)
  }

  /**
   * The word the stand-in addresses of a session carry: drawn when first needed, kept in memory only. One word per session, so that nothing
   * is common to a profile, a container and a private window of the same launch.
   */
  private standInWord(ses: Session): string {
    let word = this.standInWords.get(ses)
    if (word === undefined) this.standInWords.set(ses, (word = randomBytes(12).toString('hex')))
    return word
  }

  /**
   * Chromium aborts a redirect from a web address to a `data:` address and follows one to a scheme the session serves itself, so the stand-in
   * resources of the blocker are served under their own scheme (`session.protocol.handle`) while the extended rules are on, and the handler is
   * taken away when they are not.
   */
  protected syncStandIns(ses: Session, wanted: boolean): void {
    if (wanted === this.standInSessions.has(ses)) return
    try {
      if (wanted) ses.protocol.handle(STAND_IN_SCHEME, (request) => this.serveStandIn(ses, request.url))
      else ses.protocol.unhandle(STAND_IN_SCHEME)
      if (wanted) this.standInSessions.add(ses)
      else this.standInSessions.delete(ses)
    } catch (error) {
      console.error(`[blocking] cannot ${wanted ? 'serve' : 'stop serving'} the stand-in resources of a session:`, error instanceof Error ? error.message : error)
    }
  }

  private serveStandIn(ses: Session, address: string): Response {
    const resource = standInServed(address, this.standInWord(ses))
    if (!resource) {
      // Only a page guessing at the address gets here, or an address Chromium wrote differently from ours: either way it is worth a line.
      console.warn('[blocking] a request for a stand-in resource that does not exist or carries another word:', address.slice(0, 80))
      return new Response(null, { status: 404 })
    }
    const type = resource.mime.startsWith('text/') || resource.mime === 'application/json' ? `${resource.mime}; charset=utf-8` : resource.mime
    return new Response(resource.binary ? Buffer.from(resource.body, 'base64') : resource.body, { headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }

  /** Adds the page guard preload to a session while there is a provider for it, and takes it away when there is not. Never twice. */
  protected syncPageGuard(ses: Session, wanted: boolean): void {
    const has = this.guardedSessions.has(ses)
    if (wanted === has) return
    try {
      if (wanted) ses.registerPreloadScript({ id: PAGE_GUARD_ID, type: 'frame', filePath: pageGuardPath(), excludeMatches: [...SIGN_IN_PRELOAD_EXCLUDES] })
      else ses.unregisterPreloadScript(PAGE_GUARD_ID)
      if (wanted) this.guardedSessions.add(ses)
      else this.guardedSessions.delete(ses)
    } catch (error) {
      console.error(`[guard] cannot ${wanted ? 'add' : 'remove'} the page guard of a session:`, error instanceof Error ? error.message : error)
    }
  }

  /** The channel the page guard asks on exists only while some context has a provider. */
  protected syncGuardListener(): void {
    const wanted = this.guard !== null || [...this.scopes.values()].some((scope) => scope.guard !== null)
    if (wanted === this.guardListening) return
    this.guardListening = wanted
    if (wanted) ipcMain.on(PAGE_GUARD.plan, this.onGuardPlan)
    else ipcMain.removeListener(PAGE_GUARD.plan, this.onGuardPlan)
  }

  /** The preload waits for the answer (the page must not run before it is protected): this always sets `returnValue`, and answers "nothing" for anything that is not a tab of ours. */
  protected answerGuardPlan(event: IpcMainEvent, claimed?: unknown): void {
    let plan: GuardPlan = NO_PLAN
    try {
      const provider = this.guardProviderOf(event.sender.session)
      // A tab, and the popup a page opened with `window.open`: a window made by a page is a page like any other, and a script that needs only one user
      // click to open one must not find the canvas, the audio and WebRTC unprotected there.
      const popup = this.popups.ownerKeyOf(event.sender) !== undefined
      // The blank window a page writes into has no address of its own: it gets what its opener gets (see `guardPageUrl`).
      const url = isMainFrameSender(event) && (popup || this.pageOfContents(event.sender)) ? guardPageUrl(claimed, event.senderFrame?.url, event.sender.opener?.url) : ''
      if (provider && url !== '') plan = provider({ pageUrl: url })
      // A page that is not a tab (a popup, a preview, a mini window, an application) has no entry in the `PageGuard` of its window: its WebRTC policy is set here.
      if (url !== '') this.syncWebRtc(event.sender, plan.fingerprint !== null)
      // The frames and the workers of this document get what the document gets; a page that is not a web page (no address here) gives them nothing.
      if (isMainFrameSender(event) && (popup || this.pageOfContents(event.sender))) this.syncInnerGuard(event.sender, url, plan.fingerprint)
    } catch (error) {
      console.error('[guard] cannot work out what a page gets, so it gets nothing:', error instanceof Error ? error.message : error)
    }
    event.returnValue = plan
  }

  /**
   * The WebRTC policy of the document a page starts: the protected one while the document is protected, Chromium's own again when it is not (it may navigate to a site left out).
   * Only what changed is set; a tab's policy is also kept by `PageGuard`, from the same settings, so the two agree.
   */
  private syncWebRtc(contents: WebContents, wanted: boolean): void {
    if (contents.isDestroyed() || wanted === this.webRtcGuarded.has(contents)) return
    try {
      contents.setWebRTCIPHandlingPolicy(wanted ? 'default_public_interface_only' : 'default')
      if (wanted) this.webRtcGuarded.add(contents)
      else this.webRtcGuarded.delete(contents)
    } catch (error) {
      console.warn('[guard] cannot set the WebRTC policy of a page:', error instanceof Error ? error.message : error)
    }
  }

  private guardProviderOf(ses: Session): PageGuardProvider | null {
    for (const scope of this.scopes.values()) if (scope.session === ses) return scope.guard
    return this.guard
  }

  private innerProviderOf(ses: Session): InnerGuardProvider | null {
    for (const scope of this.scopes.values()) if (scope.session === ses) return scope.innerGuard
    return this.innerGuard
  }

  /** The strength of the moment for the pages of a session, or null while its protection is off (or cannot be worked out, which is told). */
  private innerFallbackOf(ses: Session): FingerprintConfig | null {
    try {
      return this.innerProviderOf(ses)?.() ?? null
    } catch (error) {
      console.error('[guard] cannot work out what the frames and the workers of a page get, so they get nothing:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /** The guard of the frames and workers of a web contents, made when it is first needed (`make`) or only looked up. */
  private innerGuardOfContents(contents: WebContents, make: boolean): InnerGuard | undefined {
    if (!make) return innerGuardOf(contents)
    return innerGuardFor(contents, () => {
      this.innerGuarded.add(contents)
      contents.once('destroyed', () => this.innerGuarded.delete(contents))
      return new InnerGuard({
        debugger: contents.debugger,
        session: ownSessionOf(contents, contents.debugger),
        guardText: String(guardWorld),
        alive: () => !contents.isDestroyed(),
        warn: (what, error) => console.warn(`[guard] ${what}:`, error instanceof Error ? error.message : String(error))
      })
    })
  }

  /**
   * A page was made: its guard is attached before it loads anything, with no page known yet (the strength of the moment serves until the first one
   * asks). A session made after the protection was switched on gets the preload of its service workers here, with its first page.
   */
  protected primeInnerGuard(contents: WebContents): void {
    this.syncWorkerGuard(contents.session, this.innerProviderOf(contents.session) !== null)
    const fallback = this.innerFallbackOf(contents.session)
    if (fallback) this.innerGuardOfContents(contents, true)?.set({ current: null, fallback })
  }

  /** The main frame of a page starts a document at `pageUrl` ('' when it is not a web page) that gets `config`: its frames and workers follow. */
  protected syncInnerGuard(contents: WebContents, pageUrl: string, config: FingerprintConfig | null): void {
    if (contents.isDestroyed()) return
    const fallback = this.innerFallbackOf(contents.session)
    this.innerGuardOfContents(contents, fallback !== null)?.set(fallback ? { current: { origin: pageOrigin(pageUrl), config }, fallback } : null)
  }

  /**
   * The protection of a session was switched: its service workers get the preload or lose it, and the pages that lost theirs give their session
   * back. `wanted` is said by the caller for a context that is closing: it is no longer among the contexts, and must not be read as a profile.
   */
  protected syncInnerGuards(ses: Session, wanted = this.innerProviderOf(ses) !== null): void {
    this.syncWorkerGuard(ses, wanted)
    if (wanted) return
    for (const contents of this.innerGuarded) if (!contents.isDestroyed() && contents.session === ses) innerGuardOf(contents)?.set(null)
  }

  /**
   * The page guard in the service workers of a session, while its fingerprint protection is on: Electron has a preload for them, and the
   * script asks its question on the worker's own channel, which exists once the worker is starting.
   */
  protected syncWorkerGuard(ses: Session, wanted: boolean): void {
    if (wanted === this.workerGuards.has(ses)) return
    try {
      if (!wanted) {
        ses.serviceWorkers.removeListener('running-status-changed', this.workerGuards.get(ses)!)
        this.workerGuards.delete(ses)
        ses.unregisterPreloadScript(PAGE_GUARD_WORKER_ID)
        return
      }
      const answered = new WeakSet<object>()
      const onStatus = ({ versionId, runningStatus }: { versionId: number; runningStatus: string }): void => {
        if (runningStatus !== 'starting') return
        const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
        // The workers of extensions are not pages to hide from, and a worker is given its channel once.
        if (!worker || !/^https?:\/\//i.test(worker.scope) || answered.has(worker)) return
        answered.add(worker)
        worker.ipc.on(PAGE_GUARD.plan, (event) => {
          event.returnValue = this.workerGuardPlan(ses, worker.scope)
        })
      }
      ses.serviceWorkers.on('running-status-changed', onStatus)
      this.workerGuards.set(ses, onStatus)
      ses.registerPreloadScript({ id: PAGE_GUARD_WORKER_ID, type: 'service-worker', filePath: pageGuardPath(), excludeMatches: [...SIGN_IN_PRELOAD_EXCLUDES] })
    } catch (error) {
      console.error(`[guard] cannot ${wanted ? 'add' : 'remove'} the page guard of the service workers of a session:`, error instanceof Error ? error.message : error)
    }
  }

  /** What a service worker of the web gets: the fingerprint protection of the site its scope is on, and nothing else (the scriptlets are for documents). Never throws: the worker waits for the answer. */
  protected workerGuardPlan(ses: Session, scope: string): GuardPlan {
    try {
      const provider = this.guardProviderOf(ses)
      if (!provider || this.innerProviderOf(ses) === null) return NO_PLAN
      return { ...NO_PLAN, fingerprint: provider({ pageUrl: scope }).fingerprint }
    } catch (error) {
      console.error('[guard] cannot work out what a service worker gets, so it gets nothing:', error instanceof Error ? error.message : error)
      return NO_PLAN
    }
  }

  /**
   * The one `onBeforeSendHeaders` hook of a session of pages, always there. The three Client Hints Chromium leaves out of the navigations
   * (`navigationHints`, shared/client-hints.ts): with nothing else to do the hook sees the navigations of the web alone. Global Privacy Control: `Sec-GPC: 1`
   * on every web request while the option is on, the handshake of a WebSocket included. And, once a local file was opened in the session, the
   * note of what a local page asks the web to read (`watchLocalPages`). And, once a tab was on the sign-in hosts of Google, the user agent of the
   * application on every request of such a tab, and none of the hints above on them (`watchSignInPages`).
   */
  private installPrivacyHeaders(ses: Session, privacyOf: () => PrivacyOptions | null): void {
    this.headerHooks.set(ses, { ...this.headerHooks.get(ses), privacyOf })
    const signal = privacyOf()?.globalPrivacyControl === true
    const cookieCut = privacyOf()?.blockThirdPartyCookies === true
    const local = this.localPageSessions.has(ses)
    const net = this.extensionNets.get(ses)
    const needs = net?.needs()
    const forExtensions = needs !== undefined && (needs.requestHeaders || needs.events.has('onBeforeSendHeaders'))
    // The handshake of a WebSocket is a request of the web too: it carries the signal, and an extension may read its headers. The hints alone ask
    // for the navigations only: Chromium puts them on everything else, and a request of an image or a script costs nothing here.
    // The identity of the sign-in pages of Google (shared/google-sign-in.ts) is on every request of a tab that is on them: the hook sees them all, but only in a session where such a tab was.
    const trial = this.signIn
    const onSignIn = trial !== null && this.signInSessions.has(ses)
    const filter: { urls: string[]; types?: Array<'mainFrame' | 'subFrame'> } =
      forExtensions || signal || cookieCut ? { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] } : local || onSignIn ? { urls: ['http://*/*', 'https://*/*'] } : { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] }
    ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      // The method of every main-frame request, told before anything else can answer it: the redirect that follows is of this request, and a redirect that follows a POST is never taken over (google-sign-in-agent.ts).
      if (trial !== null && details.resourceType === 'mainFrame') trial.noteRequest(details.webContents?.id, details.method)
      if (local && !this.noteLocalPageRead(details)) return callback({ cancel: true })
      // The identity of the sign-in first of all: what a request of the sign-in says of the browser is settled before the hints, the rules and the listeners see it, and none of our hints goes on it.
      const inSignIn = trial !== null && trial.has(details.webContents?.id)
      const signInRequest = trial !== null && isSignInRequest(details, inSignIn)
      const asked = trial === null ? details.requestHeaders : signInRequestHeaders(trial.identity, details, details.requestHeaders, inSignIn)
      // Chromium's hints first, as Chromium adds them to the other requests before any extension sees them: an extension may read, change or
      // remove them, as in Chrome. Then the rules and the listeners of the extensions; the signal of the application last: an extension cannot take it away.
      const go = (hints: ClientHintHeaders | null): void => {
        const sent = hints === null ? asked : withNavigationHints(details, asked, hints)
        const finish = (rewritten: Record<string, string> | null): void => {
          if (rewritten === null) return callback({ cancel: true })
          // Whatever case a rule wrote the name in: the request carries the signal once.
          const headers = signal && /^(https?|wss?):/i.test(details.url) ? { ...Object.fromEntries(Object.entries(rewritten).filter(([name]) => name.toLowerCase() !== 'sec-gpc')), 'Sec-GPC': '1' } : rewritten
          // Last of all, as the signal: what an extension added is cut too. A request whose cookies are cut leaves without the header.
          const sentOut = cookieCut && this.thirdPartyCookiesCut(details, privacyOf()) ? withoutCookieHeader(headers) : headers
          callback(sentOut !== details.requestHeaders ? { requestHeaders: sentOut } : {})
        }
        const rewritten = net && forExtensions ? this.requestForExtensions(net, details, sent) : sent
        if (rewritten instanceof Promise) return void rewritten.then(finish)
        finish(rewritten)
      }
      if (!takesNavigationHints(details) || signInRequest) return go(null)
      // At the launch, a navigation waits for the hints of the engine (a short while at most, engine-client-hints.ts): it never leaves with a guess.
      const hints = this.navigationHints()
      if (hints instanceof Promise) return void hints.then(go)
      go(hints)
    })
  }

  /**
   * The hints the header hook of a session of pages adds to a navigation: those the engine gave a page of the interface, a promise of them while
   * they are awaited at the launch, or null when they are not known.
   */
  protected navigationHints(): ClientHintHeaders | null | Promise<ClientHintHeaders | null> {
    return engineClientHints.forNavigation()
  }

  /**
   * The Client Hints of the engine are read from a page of the interface, the same Chromium as the pages (engine-client-hints.ts): the main window
   * hands in its web contents before its first page loads and before any tab is restored, and they are read as soon as that page commits; the
   * navigations wait for them until then, `HINTS_WAIT_MS` at most.
   */
  learnClientHints(ui: HintSource): void {
    engineClientHints.learnFrom(ui)
  }

  /** The quit: the hosts held to strict transport security whose write waited are written now, for every session that keeps a file. */
  flushStrictTransport(): void {
    strictTransportStore.flushPending()
  }

  clearSiteData(profileId: string, request: SiteDataEngineRequest): Promise<SiteDataResult[]> {
    // The copies of the icons the interface draws (site-icons.ts) go with the data of the site: all of them, since a copy does not say which site it is of
    // beyond its address, and one that is still shown is downloaded again.
    this.siteIcons.clear()
    // What the session of the interface may still hold of icons it loaded itself (a version before the copies) goes with the site's cache (see eraseSiteData).
    return eraseSiteData(this.ensureProfile(profileId).session, request, session.defaultSession)
  }

  setDefaultAutoplay(mode: AutoplayMode): void {
    this.defaultAutoplay = mode
  }

  setMinimumFontSize(size: number): void {
    this.minimumFontSize = cleanMinimumFontSize(size)
  }

  siteCookieCount(profileId: string, host: string, subdomains: boolean): Promise<number> {
    return countSiteCookies(this.ensureProfile(profileId).session, host, subdomains)
  }
}
