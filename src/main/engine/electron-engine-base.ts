// The first layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md): every field, the constructor,
// the module-level helpers the layers share, and the abstract declarations of what a lower layer calls higher up. The layers above only add methods.

import { statfsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, WebContentsView, type DownloadItem, ipcMain, type ServiceWorkerMain, type Session, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, webContents as allWebContents, type WebFrameMain } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import type { ExtensionInfo } from '@shared/ipc'
import type { DownloadInfo } from '@shared/model'
import { PAGE_DIALOG, type PageDialogKind } from '@shared/page-dialog'
import { PERMISSION_STATE } from '@shared/permission-state'
import { TabAnswers } from './tab-answers'
import { normalizeTabUrl } from '@shared/chrome-compat'
import { ActiveTabGrants } from '@shared/extension-access'
import { Channel } from '@shared/ipc-channels'
import { capturePcmSenderRefusal } from '@shared/capture-helper-page'
import { TAB_CAPTURE_ERRORS } from '@shared/tab-capture'
import { ScriptWorlds } from '@shared/active-tab-script'
import { isAuthContents } from './web-auth'
import { ExtensionLedger } from './extension-ledger'
import { type EceRouter } from './ece-router'
import { WebStore } from './web-store'
import { ExtensionPreloads } from './extension-runtime'
import { SwitchedPreload } from './switched-preload'
import { SIGN_IN_PRELOAD_EXCLUDES } from '@shared/google-sign-in'
import { SignInAgents } from './google-sign-in-agent'
import { ExtensionDev } from './extension-dev'
import { PopupWindows } from './popup-windows'
import { extensionOfUrl, type CaptureSender, type TabCaptures } from './tab-capture'
import type { LentTabs } from './lent-tabs'
import { DocumentPipWindows } from './document-pip-windows'
import { DEFAULT_AUTOPLAY, type AutoplayMode } from '@shared/autoplay'
import { anchorInPoints, type AnchorRect } from './popup-anchor'
import { ReservedPaths } from './download-paths'
import { DownloadStaging, UnsavedRequests } from './download-staging'
import { RequestedDownloads } from './requested-downloads'
import { ExtensionRelays } from './extension-relays'
import type { ExtensionNet } from './extension-net'
import { DownloadResume, describeError } from './download-resume'
import { WebHardware, type HardwareContents } from './web-hardware'
import { OwnSessions, ProxyApplier } from './network'
import { OwnRequestSigning } from './own-requests'
import { ICON_SCHEME } from '@shared/site-icon'
import type { SiteIconCopies } from './site-icons'
import { watchUserInput } from './user-input'
import type { OptionalGrants } from './optional-grants'
import type { ProxyPlan } from '@shared/proxy'
import { HttpsUpgrades } from './https-upgrade'
import type { PrivacyOptions } from '@shared/privacy'
import { PendingReads } from './local-file-guard'
import { type ActionMenuEntry, type DownloadPolicy, type ExtensionLogEntry, type ExtensionMenuAction, type ExtensionReviewAsk, type ExtensionTabHooks, type InnerGuardProvider, type PageGuardProvider, type PermissionPolicy, type RequestBlocker, type ResponsePolicy, type ShimHandler, type TabFacts, NO_DOWNLOAD_POLICY } from './types'
import { ElectronPage } from './electron-page'
import { EphemeralScope } from './ephemeral-scope'
import { refuseAlteredScripts, type PlainFs } from './unpacked-integrity'
import { t } from '@shared/i18n'
import type { HardwareChoice } from './web-hardware'
import type { ClosablePopup } from './action-popup'

export const SHIM_CALL_CHANNEL = 'lucium-shim'

export const SHIM_EVENT_CHANNEL = 'lucium-shim-event'

/** The `url` of a tabs.create / tabs.update call, when the call has one, with `chrome://newtab` made a blank page. */
export function normalizeTabCall(arg: unknown): unknown {
  if (typeof arg !== 'object' || arg === null || !('url' in arg)) return arg
  return { ...arg, url: normalizeTabUrl((arg as { url?: unknown }).url) }
}

/** Diagnostics switch: print the console of extension workers and pages (LUCIUM_EXT_LOG=1). */
export const EXTENSION_LOG = process.env['LUCIUM_EXT_LOG'] === '1'

export const LOG_START = Date.now()

/** Inside app.asar a preload cannot be read by Chromium: the packaged build unpacks it (see electron-builder.yml). */
export function shimsPreloadPath(): string {
  return join(__dirname, '../preload/extension-shims.js').replace('app.asar', 'app.asar.unpacked')
}

/** The media bridge is a frame preload like the shims, and just as unreadable for Chromium from inside app.asar. */
export function mediaBridgePath(): string {
  return join(__dirname, '../preload/media-bridge.js').replace('app.asar', 'app.asar.unpacked')
}

/** The page guard (scriptlets of the blocker, fingerprint protection) is a frame preload too, and unpacked for the same reason. */
export function pageGuardPath(): string {
  return join(__dirname, '../preload/page-guard.js').replace('app.asar', 'app.asar.unpacked')
}

export const PAGE_GUARD_ID = 'lucium-page-guard'
/** The same script again, in the service workers of the web (it asks the same question there and patches the worker's own objects). */
export const PAGE_GUARD_WORKER_ID = 'lucium-page-guard-sw'

/** The dialog bridge (the `alert()`, `confirm()` and `prompt()` of the pages) is a frame preload too, and unpacked for the same reason. */
export function dialogBridgePath(): string {
  return join(__dirname, '../preload/dialog-bridge.js').replace('app.asar', 'app.asar.unpacked')
}

/** The object `window.chrome.app` of the pages (src/preload/chrome-app.ts) is a frame preload too, and unpacked for the same reason. */
export function chromeAppPath(): string {
  return join(__dirname, '../preload/chrome-app.js').replace('app.asar', 'app.asar.unpacked')
}

/** The password bridge (submitted sign-in forms) is a frame preload too, loaded only while the password manager is on. */
export function passwordBridgePath(): string {
  return join(__dirname, '../preload/password-bridge.js').replace('app.asar', 'app.asar.unpacked')
}

/** The preload that gives the script an extension injects into a tab the user lent it its `chrome.runtime` and `chrome.storage` (src/preload/lent-tab.ts) is a frame preload too, and unpacked for the same reason. */
export function lentTabPath(): string {
  return join(__dirname, '../preload/lent-tab.js').replace('app.asar', 'app.asar.unpacked')
}

export const DOWNLOAD_EMIT_INTERVAL_MS = 250

/** How long the one-byte check before a resumption waits for the server. */
export const RESUME_PROBE_TIMEOUT_MS = 15_000

export interface Profile {
  session: Session
  extensions: ElectronChromeExtensions
  router: EceRouter
  /** The preload scripts of the extension runtime, put in the session when an extension is first loaded there (see extension-runtime.ts). */
  runtime: ExtensionPreloads
  /** While the folders this profile inherited are being loaded: what its pages wait for before their first navigation (see profile-ready.ts). Null when there is nothing to wait for. */
  ready: Promise<void> | null
  /** Tells the extension runtime of this profile which window the user is in (see `windowFocusOf`). */
  followWindow(windowId: number): void
}

/**
 * The state of one private browsing context. Its session lives in memory only; its hooks are its own, so a private
 * window never takes over the permission prompts, downloads or request filter of the shell.
 */
export interface Scope {
  /** Stands where a profile id would: pages created for it go to this scope's session. Not a valid profile id, so it cannot clash with one. */
  readonly key: string
  /** Prefixed to every page id of the scope, so ids chosen by the shell ("peek-1") cannot clash with another window's. */
  readonly prefix: string
  readonly windowId: string
  readonly session: Session
  policy: PermissionPolicy | null
  blocker: RequestBlocker | null
  responsePolicy: ResponsePolicy | null
  guard: PageGuardProvider | null
  innerGuard: InnerGuardProvider | null
  privacy: PrivacyOptions | null
  namer: ((filename: string, url: string) => string) | null
  dirResolver: ((profileId: string, sourcePageId?: string) => string | undefined) | null
  downloadPolicy: DownloadPolicy
  readonly downloadListeners: Array<(download: DownloadInfo, sourcePageId: string | undefined, profileId: string) => void>
}

/** A download in progress: the item, and what re-reads it into a DownloadInfo and tells the listeners (after a pause or a resume). */
export interface ActiveDownload {
  readonly item: DownloadItem
  refresh(): void
}

/** How many extension workers are remembered: the ones that are gone are dropped first, this is the ceiling when the library never says they went. */
export const WORKERS_MAX = 512

/** The room left on the disk that holds `dir`, in bytes, or null when it cannot be asked (the folder is gone, the volume does not answer). */
export function freeBytesOf(dir: string): number | null {
  try {
    const stats = statfsSync(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch (error) {
    console.debug(`[downloads] cannot read the free room of ${dir}: ${describeError(error)}`)
    return null
  }
}

/**
 * The popup of an extension icon is placed from the rectangle of the icon, which the page measured in CSS pixels. With the interface
 * zoomed (Settings › Général › Taille de l’interface) those are `factor` times fewer than the points the window has: the rectangle is
 * scaled before the popup is first placed. At 100 % it is left alone.
 */
export function scalePopupAnchor(popup: unknown): void {
  const { parent, anchorRect } = popup as { parent?: BrowserWindow; anchorRect?: AnchorRect }
  if (!parent || parent.isDestroyed() || !anchorRect) return
  const scaledRect = anchorInPoints(anchorRect, parent.webContents.getZoomFactor())
  // The library keeps the rectangle it was given: it is rewritten in place.
  if (scaledRect !== anchorRect) Object.assign(anchorRect, scaledRect)
}

export abstract class ElectronEngineBase {
  protected readonly pages = new Map<string, ElectronPage>()
  /** Page id by web contents id, so the request filter finds the page of a request without walking `pages`. */
  protected readonly pageByContents = new Map<number, string>()
  protected readonly blockExceptionHandlers = new Map<string, (url: string) => void>()
  protected miniOpener: ((url: string) => void) | undefined
  protected popupPolicy: ((url: string) => boolean) | undefined
  protected readonly profiles = new Map<string, Profile>()
  /** WebHID, WebUSB and Web Serial for the profiles' sessions; owns nothing while the setting is off (see web-hardware.ts). */
  protected readonly hardware = new WebHardware({
    contentsOf: (frame) => allWebContents.fromFrame(frame as WebFrameMain) as unknown as HardwareContents | undefined,
    isTab: (contents) => {
      const wc = contents as unknown as WebContents
      return !isAuthContents(wc) && this.pageOfContents(wc) !== undefined
    },
    // Blink refuses requestDevice and requestPort without a user gesture; Electron does not do so for the screen, so the engine does not rely on it here either.
    userActed: (contents) => this.pageOfContents(contents as unknown as WebContents)?.hadRecentInput(Date.now()) === true,
    choose: (request) => this.chooseHardware(request),
    warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail))
  })
  /** Private browsing contexts by key (see `Scope`). They are kept out of `profiles`: nothing that walks the profiles can reach them. */
  protected readonly scopes = new Map<string, Scope>()
  /** The browsing contexts of the tab containers that are open, by container id (their `Scope`s are in `scopes` too, under `container:<id>`). */
  protected readonly containerScopes = new Map<string, EphemeralScope>()
  protected scopeCounter = 0
  protected readonly loaded = new Map<string, ExtensionInfo>()
  /** Every extension of every profile, loaded or switched off there, by `profile:id` (what Settings lists and what can be switched on again). */
  protected readonly known = new Map<string, { info: ExtensionInfo; path: string; manifest: unknown }>()
  /** The extensions switched off, by profile (see `configureExtensions`). */
  protected disabled = new Map<string, Set<string>>()
  protected reviewHandler: ((ask: ExtensionReviewAsk) => Promise<boolean>) | null = null
  protected readonly noticeListeners: Array<(message: string) => void> = []
  protected readonly changeListeners: Array<() => void> = []
  /** Told when an extension is gone from a profile, or is no longer the one the person chose: what the person allowed it goes (shell/browser-media.ts). */
  protected readonly forgottenListeners: Array<(profileId: string, extensionId: string) => void> = []
  protected readonly menuListeners: Array<(action: ExtensionMenuAction, profileId: string, extensionId: string) => void> = []
  protected readonly extensionPaths = new Set<string>()
  /** The reload, the journal and the details of the Extensions page: nothing runs or listens in it until the page opens (extension-dev.ts). */
  readonly extensionTools: ExtensionDev = new ExtensionDev({
    sources: () => [...this.profiles.entries()].map(([profileId, profile]) => ({ profileId, session: profile.session })),
    known: () => [...this.known.values()],
    isLoaded: (profileId, extensionId) => this.loaded.has(`${profileId}:${extensionId}`),
    workerRunning: (profileId, extensionId) => {
      const scope = `chrome-extension://${extensionId}/`
      return Object.values(this.profiles.get(profileId)?.session.serviceWorkers.getAllRunning() ?? {}).some((worker) => worker.scope === scope)
    },
    unload: (profileId, extensionId) => this.unloadExtension(profileId, extensionId),
    load: (profileId, path) => this.loadInto(profileId, this.ensureProfile(profileId).session, path),
    forgetFolder: (path) => this.forgetExtensionFolder(path),
    grantedOf: (profileId, extensionId) => this.optionalGrants.facts(profileId, extensionId),
    revokeGranted: (profileId, extensionId, name) => this.optionalGrants.revoke(profileId, extensionId, name)
  })
  /** Installing from the Chrome Web Store (public for the engine checks, which point it at a local server). */
  readonly webStore = new WebStore({
    userData: () => app.getPath('userData'),
    ledger: () => this.extensionLedger(),
    profileOfSession: (ses) => this.profileOfSession(ses),
    pageIdOf: (wc) => this.pageIdOf(wc),
    lastUserInput: () => this.lastUserInput,
    installed: (profileId) =>
      [...this.known.entries()]
        .filter(([key, entry]) => key.startsWith(`${profileId}:`) && entry.info.source === 'store')
        .map(([, entry]) => ({ id: entry.info.id, name: entry.info.name, version: entry.info.version, manifest: entry.manifest, path: entry.path })),
    isInstalled: (profileId, extensionId) => this.known.has(`${profileId}:${extensionId}`),
    unload: (profileId, extensionId) => this.unloadExtension(profileId, extensionId),
    prepareLoad: (profileId) => this.prepareExtensions(profileId),
    ask: (ask) => (this.reviewHandler ? this.reviewHandler(ask) : Promise.resolve(false)),
    notify: (message) => this.notice(message),
    requestUninstall: (profileId, extensionId) => this.menuAction('uninstall', profileId, extensionId)
  })
  /**
   * The manifest of each loaded extension, by `profile:id` like `loaded` and `known`: two profiles can hold two versions of one extension, and what
   * a call may do is read from the version of the profile it comes from, not from the one that was loaded last. It is the manifest the access rules
   * read: what the person granted the extension in that profile, on its request, is added to it (optional-grants.ts). `known` keeps the one of the files.
   */
  protected readonly manifests = new Map<string, { permissions?: unknown; host_permissions?: unknown; omnibox?: unknown; background?: unknown }>()
  /** The isolated world of the scripts each extension runs in a tab the user lent it. */
  protected readonly scriptWorlds = new ScriptWorlds()
  protected readonly downloads = new Map<string, ActiveDownload>()
  protected hooks: ExtensionTabHooks | null = null
  /** The window of the application that showed tabs and took the focus last (Electron's id): the window the user is in, whatever the extension runtime has seen of it. */
  protected currentWindowId: number | undefined
  protected policy: PermissionPolicy | null = null
  protected requestBlocker: RequestBlocker | null = null
  protected responsePolicy: ResponsePolicy | null = null
  protected guard: PageGuardProvider | null = null
  protected innerGuard: InnerGuardProvider | null = null
  /** The web contents that were given a guard for their frames and workers (engine/inner-guard.ts), to take it away when the protection goes off. */
  protected readonly innerGuarded = new Set<WebContents>()
  /** The sessions whose service workers load the page guard now, with what listens to their starts. */
  protected readonly workerGuards = new Map<Session, (details: { versionId: number; runningStatus: string }) => void>()
  /** The sessions that carry the page guard preload now (it is added and taken away with the provider, never registered twice). */
  protected readonly guardedSessions = new WeakSet<Session>()
  /** The sessions that serve the stand-in resources of the blocker now, and the word the addresses of each carry (see shared/redirect-resources.ts). */
  protected readonly standInSessions = new WeakSet<Session>()
  protected readonly standInWords = new WeakMap<Session, string>()
  /**
   * The sessions in which a local file was opened in a tab during this run: from then on their web requests are watched for what a local page
   * reads of another origin (local-file-guard.ts). A session that never showed a local file pays nothing for it.
   */
  protected readonly localPageSessions = new WeakSet<Session>()
  /** What each session of pages was last given for its header hooks: they are installed again, with the watch above, when the first local file opens. */
  protected readonly headerHooks = new WeakMap<Session, { privacyOf?: () => PrivacyOptions | null; policyOf?: () => ResponsePolicy | null }>()
  /** What each session of pages was last given for its `onBeforeRequest` hook: it is installed again when what its extensions need of it changes. */
  protected readonly requestHooks = new WeakMap<Session, { blockerOf: () => RequestBlocker | null; pagePrefix: string; privacyOf: () => PrivacyOptions | null }>()
  /** The request rules and the request listeners of the extensions of each profile session (extension-net.ts). A private context has none. */
  protected readonly extensionNets = new WeakMap<Session, ExtensionNet>()
  /** The style sheets inserted for an extension in a tab the user lent it (shared/active-tab-script.ts), by what was inserted: the key that removes each. */
  protected readonly lentStyles = new Map<string, string>()
  /** When the worker of an extension was last started for a request its listeners cover, by profile and extension: one start at a time. */
  protected readonly netWakes = new Map<string, number>()
  /** What each session of pages answers its permissions with: its policy, and whether an answer holds for the tab that asked (never in a private context). */
  protected readonly permissionSessions = new WeakMap<Session, { policyOf: () => PermissionPolicy | null; tabAnswers: boolean }>()
  /** The answers given to tabs without « Se souvenir » (tab-answers.ts). */
  protected readonly tabAnswers = new TabAnswers<Session>()
  /** The reads of local pages whose answer is awaited. */
  protected readonly localPageReads = new PendingReads()
  protected guardListening = false
  protected privacy: PrivacyOptions | null = null
  /** The proxy of each session (setting "Proxy"): null while the option is off, and then nothing is ever applied. */
  protected proxyPlan: ProxyPlan | null = null
  protected readonly proxies = new ProxyApplier()
  protected readonly ownSessions = new OwnSessions(this.proxies, () => this.proxyPlan?.global ?? null)
  /** The sessions the application asks the network with for itself: they carry `Sec-GPC: 1` while Global Privacy Control is on (own-requests.ts). */
  protected readonly ownRequests = new OwnRequestSigning()
  protected readonly upgrades = new HttpsUpgrades()
  /** What a web contents the shell does not create itself gets (a popup): the general choice of the user, Chromium's policy until the shell says. */
  protected defaultAutoplay: AutoplayMode = DEFAULT_AUTOPLAY
  /** The popup windows pages opened: real windows, in the session of the page that opened them (see popup-windows.ts). */
  protected readonly popups = new PopupWindows(this.upgrades, () => this.defaultAutoplay, (pageId) => this.blockExceptionHandlers.get(pageId))
  /** The windows of document Picture-in-Picture (the floating window of a call), off until the shell switches the feature on. */
  protected readonly documentPip = new DocumentPipWindows()
  protected downloadNamer: ((filename: string, url: string) => string) | null = null
  protected downloadDirResolver: ((profileId: string, sourcePageId?: string) => string | undefined) | null = null
  protected downloadCounter = 0
  protected downloadPolicy: DownloadPolicy = NO_DOWNLOAD_POLICY
  /** The temporary folder of downloads, made at the first use: an installation that never asks nor opens without keeping never touches it. */
  protected staging: DownloadStaging | null = null
  /** The links the user asked to open without keeping, waiting for their download to start. */
  protected readonly unsaved = new UnsavedRequests()
  /** Resuming downloads after a restart (setting `downloadResume`): null while the setting is off, and then nothing is read, written or recorded. */
  protected resume: DownloadResume | null = null
  /** The paths promised to downloads that are still running: two downloads of one name must not pick the same file. */
  protected readonly reservedPaths = new ReservedPaths()
  protected popupCount = 0
  protected shimHandler: ShimHandler | null = null
  protected actionMenu: ((profileId: string, extensionId: string) => ActionMenuEntry[]) | null = null
  protected readonly extensionWorkers = new Set<ServiceWorkerMain>()
  /** The profile each extension worker runs in. */
  protected readonly workerProfile = new WeakMap<ServiceWorkerMain, string>()
  protected readonly extensionFrames = new Set<WebContents>()
  /** The profile and window of each tab, by the tab number extensions know it by (web contents id). Panels and private pages are not tabs. */
  protected readonly tabMeta = new Map<number, { profileId: string; win: BrowserWindow }>()
  protected tabFacts: ((tabNumber: number) => TabFacts) | null = null
  /** Hidden pages of extensions that report the events Electron does not deliver to their worker. */
  protected readonly relays = new ExtensionRelays<WebContentsView>({
    create: (profileId) => {
      const profile = this.profiles.get(profileId)
      return profile ? new WebContentsView({ webPreferences: { session: profile.session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } }) : null
    },
    // Any file of the extension is a document with the extension's APIs; its manifest is one that always exists.
    load: (view, extensionId) => void view.webContents.loadURL(`chrome-extension://${extensionId}/manifest.json`).catch((error: unknown) => console.warn(`[engine] the relay page of ${extensionId} did not load:`, error)),
    register: (view, extensionId, name) => this.registerRelay(view, extensionId, name)
  })
  protected ledger: ExtensionLedger | null = null
  protected readonly tabClosedListeners: Array<(tabNumber: number) => void> = []
  /** The tabs the user handed to extensions by invoking them (see ActiveTabGrants). */
  protected readonly activeTabs = new ActiveTabGrants()
  /** The tab each profile is on, for an extension invoked without naming a tab. */
  protected readonly lastActivated = new Map<string, number>()
  /** When the user last clicked or pressed a key anywhere in the application: what lets an extension put a sign-in window in front of them. */
  protected lastUserInput = 0
  protected readonly contextGoneListeners: Array<(gone: { context?: string; extensionId?: string; profileId?: string }) => void> = []
  protected readonly watchedFrames = new WeakSet<WebContents>()
  protected heldWorkers = 0
  /** Downloads an extension asked for, waiting for the browser to start them: the address, what to name the file, and who gets the id. */
  protected readonly pendingDownloads = new RequestedDownloads<Session>()
  protected readonly consoleListeners: Array<(entry: ExtensionLogEntry) => void> = []
  protected readonly downloadListeners: Array<(download: DownloadInfo, sourcePageId: string | undefined, profileId: string) => void> = []

  /** `getWindow(id)` resolves a window by the opaque id the shell gave it; no id means the main window. */
  constructor(protected readonly getWindow: (windowId?: string) => BrowserWindow) {
    // Before any page exists: the preloads the package leaves outside app.asar are the ones it was sealed with, or nothing starts (unpacked-integrity.ts).
    refuseAlteredScripts({
      codePath: __dirname,
      // Electron's `fs` that does not look into archives: app.asar is read as the file it is.
      fs: () => createRequire(__filename)('original-fs') as PlainFs,
      tell: (files) => dialog.showErrorBox(t('engine.lucium-ne-peut-pas-demarrer'), `${t('engine.des-fichiers-de-l-application-ont-ete-modifies')}${files.length > 0 ? `\n\n${files.join('\n')}` : ''}`),
      warn: (message) => console.warn(message)
    })
    this.presentPagesAsChrome()
    this.signIn = this.presentSignInAsElectron()
    // The UI surfaces live in the default session: they load extension icons through the crx:// protocol.
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
    this.serveSiteIcons()
    // The media bridge of the pages (src/preload/media-bridge.ts) is on until the shell says the media player is off (`setMediaBridge`).
    this.listenToMediaBridge(true)
    // `alert()`, `confirm()` and `prompt()` of the pages (src/preload/dialog-bridge.ts). The page is waiting for the reply, so every message is answered,
    // and only the main frame of a tab of ours is listened to: not the interface, an extension, a preview, a popup window or a frame of a page.
    ipcMain.on(PAGE_DIALOG.alert, (event: IpcMainEvent, raw: unknown) => this.pageDialog('alert', event, raw))
    ipcMain.on(PAGE_DIALOG.confirm, (event: IpcMainEvent, raw: unknown) => this.pageDialog('confirm', event, raw))
    ipcMain.on(PAGE_DIALOG.prompt, (event: IpcMainEvent, raw: unknown) => this.pageDialog('prompt', event, raw))
    // What a page reads of a permission nobody answered (src/preload/permission-state.ts): the page is waiting here too, and every message is answered.
    ipcMain.on(PERMISSION_STATE.undecided, (event: IpcMainEvent, raw: unknown) => this.permissionUndecided(event, raw))
    // Calls from extension *pages* (service workers are handled per worker, see installShims).
    ipcMain.handle(SHIM_CALL_CHANNEL, (event, extensionId: string, api: string, method: string, args: unknown[]) => {
      const url = event.senderFrame?.url ?? ''
      if (!url.startsWith('chrome-extension://')) throw new Error('chrome.* shims are only available to extensions')
      const profileId = this.profileOfSession(event.sender.session)
      if (!profileId) throw new Error('chrome.* shims are only available in a profile')
      this.watchFrameContext(event.sender)
      return this.dispatchShim(new URL(url).host, profileId, extensionId, api, method, args, `frame:${event.sender.id}`, event.sender)
    })
    // The sound of a tab for a page of an extension (a popup, an options page, an offscreen document): who asks is read from the frame, never from the call. The
    // workers of the extensions ask on the same channels, handled per worker (see installShims).
    ipcMain.handle(Channel.extTabCaptureId, (event, raw: unknown) => this.tabCaptures.id(this.captureSender(event), raw))
    ipcMain.handle(Channel.extTabCaptureListen, (event, id: unknown) => this.tabCaptures.listen(this.captureSender(event), id))
    ipcMain.handle(Channel.extTabCaptureEnd, (event, raw: unknown) => this.tabCaptures.end(this.captureSender(event), raw))
    ipcMain.handle(Channel.extTabCaptureList, (event) => this.tabCaptures.list(this.captureSender(event)))
    // The one call of the helper page of a capture: a chunk of the sound, from the main frame of a helper page that exists and no other sender (the engine of the captures judges
    // the chunk). Nothing is answered: the page is told nothing of what became of it.
    ipcMain.on(Channel.capturePcm, (event, chunk: unknown) => this.takeSound(event, chunk))
    // The script an extension injects into a tab the user lent it with a click (src/preload/lent-tab.ts): the page that took its runtime says so, and the one call the script makes over the bridge.
    // Only the main frame of a tab is heard, and the call is read again for whose world it is and whether the tab is still lent (engine/lent-tabs.ts).
    ipcMain.on(Channel.lentTabAttached, (event, nonce: unknown, ok: unknown, reason: unknown) => this.lentTabs.attachedBy(event, nonce, ok, reason))
    ipcMain.handle(Channel.lentTabCall, (event, world: unknown, token: unknown, op: unknown, payload: unknown) => this.lentTabs.call(event, world, token, op, payload))
    // The last real click or key anywhere in the application (the pages of extensions and the interface included).
    // Not the input a debugger sends to the page (see watchUserInput).
    const noteInput = (wc: WebContents): void =>
      watchUserInput(wc, () => {
        this.lastUserInput = Date.now()
      })
    for (const wc of allWebContents.getAllWebContents()) noteInput(wc)
    // The same listener hands each new web contents to the sign-in identity of Google (nothing while `signIn` is null: the pages show Electron's identity everywhere).
    app.on('web-contents-created', (_event, wc) => {
      noteInput(wc)
      this.signIn?.watch(wc)
    })
    app.on('browser-window-focus', (_event, win) => this.followFocusedWindow(win.id))
  }

  /**
   * Who sent a call about the sound of a tab, read from the frame that sent it: the extension is the one whose address the frame has, in the profile of the session
   * it is in. A frame of the web, of the application, or in a private window is none of those and is refused.
   */
  protected captureSender(event: IpcMainInvokeEvent): CaptureSender {
    const frame = event.senderFrame
    const extensionId = frame ? extensionOfUrl(frame.url) : null
    const profileId = this.profileOfSession(event.sender.session)
    if (!frame || extensionId === null || profileId === undefined) throw new Error(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    // The main frame of the page: a frame inside it can go to another document with no word, and the sound is handed to the document that asked, never to another.
    if (frame.parent) throw new Error(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    this.watchFrameContext(event.sender)
    return { extensionId, profileId, context: `frame:${event.sender.id}`, frame: { processId: frame.processId, routingId: frame.routingId, contentsId: event.sender.id } }
  }

  /** A chunk of sound from a web contents: judged for who sent it, as Chromium reports the frame (never what the page says), then by the engine of the captures. */
  private takeSound(event: IpcMainEvent, chunk: unknown): void {
    let frame: IpcMainEvent['senderFrame']
    try {
      frame = event.senderFrame
    } catch (error) {
      // The frame is gone (the page was destroyed under the message): the sound has no sender.
      console.warn('[tab-capture] the frame of a chunk of sound is gone:', error instanceof Error ? error.message : String(error))
      return
    }
    const refusal = capturePcmSenderRefusal({ isHelper: this.tabCaptures.isHelper(event.sender.id), frameOrigin: frame?.origin, frameUrl: frame?.url, topFrame: frame !== null && frame !== undefined && frame.parent === null && frame === event.sender.mainFrame })
    if (refusal !== null) {
      console.warn(`[tab-capture] a chunk of sound from web contents ${event.sender.id} was refused: ${refusal}`)
      return
    }
    this.tabCaptures.pcm(event.sender.id, chunk)
  }

  /** The last write to the clipboard that was asked for (see `clipboardSettled`). */
  protected clipboardWrites: Promise<void> = Promise.resolve()

  /** The media bridge (src/preload/media-bridge.ts) in the sessions: there while the media player is on, in no session while it is off. */
  protected readonly mediaBridge = new SwitchedPreload<Session>({ id: 'lucium-media-bridge', type: 'frame', path: mediaBridgePath, excludeMatches: SIGN_IN_PRELOAD_EXCLUDES }, true)
  /**
   * The identity of the sign-in pages of Google (shared/google-sign-in.ts): Electron's own user agent in the tabs that are on them, and which tabs those are. Null when the
   * pages were not made a Chrome (an unexpected Chromium version): they show Electron's identity everywhere, and there is nothing to change.
   */
  protected signIn: SignInAgents | null = null
  /**
   * The sessions in which a tab was on the sign-in hosts of Google during this run: from then on their header hook sees every web request, as such a tab carries the
   * identity on all of them. A session that never showed these pages keeps the hook on the navigations alone.
   */
  protected readonly signInSessions = new WeakSet<Session>()
  /** Takes the two IPC channels of the media bridge away again; null while they are not served. */
  protected stopMediaChannels: (() => void) | null = null

  /** The sessions that already load the dialog bridge into their pages. */
  protected readonly dialogSessions = new WeakSet<Session>()

  /** The sessions that already load `window.chrome.app` into their pages. */
  protected readonly chromeAppSessions = new WeakSet<Session>()

  /** The sessions that load the password bridge into their pages now (the bridge is registered only while the password manager is on). */
  protected readonly passwordSessions = new Set<Session>()
  protected passwordBridgeOn = false
  protected readonly onPasswordSubmitted = (event: IpcMainEvent, raw: unknown): void => this.pageOfContents(event.sender)?.passwordSubmitted(event, raw)

  /** The listener of the page guard's channel (one function, so that `syncGuardListener` can take it off again). */
  protected readonly onGuardPlan = (event: IpcMainEvent, claimed?: unknown): void => this.answerGuardPlan(event, claimed)

  /** The web contents whose WebRTC policy was last set to the protected one by `syncWebRtc`. */
  protected readonly webRtcGuarded = new WeakSet<WebContents>()

  /** The sessions whose service workers' console is passed on to `consoleListeners`. */
  protected readonly consoleSessions = new WeakSet<Session>()

  // Defined by a layer above (electron-engine-*.ts) and called from this one or a lower one.
  protected abstract answerGuardPlan(event: IpcMainEvent, claimed?: unknown): void
  protected abstract chooseHardware(request: HardwareChoice): Promise<string | null>
  protected abstract closePopupOnPageClick(popup: ClosablePopup & { parent?: BrowserWindow }): void
  protected abstract dispatchShim(senderExtensionId: string, profileId: string, claimedId: string, api: string, method: string, args: unknown[], context: string, sender?: WebContents): Promise<unknown>
  protected abstract ensureProfile(profileId: string): Profile
  protected abstract extensionLedger(): ExtensionLedger
  protected abstract followFocusedWindow(windowId: number): void
  protected abstract forgetExtensionFolder(path: string): void
  protected abstract installDisplayMedia(ses: Session): void
  protected abstract installDownloads(ses: Session, profileId: string, scope?: Scope): void
  protected abstract installPermissions(ses: Session, policyOf?: () => PermissionPolicy | null, hardwareProfile?: string, tabAnswers?: boolean): void
  protected abstract listenToMediaBridge(on: boolean): void
  protected abstract loadInto(profileId: string, ses: Session, path: string): Promise<ExtensionInfo>
  protected abstract menuAction(action: ExtensionMenuAction, profileId: string, extensionId: string): void
  protected abstract notice(message: string): void
  protected abstract pageDialog(kind: PageDialogKind, event: IpcMainEvent, raw: unknown): void
  protected abstract pageIdOf(webContents: WebContents): string | undefined
  protected abstract pageOfContents(contents: WebContents): ElectronPage | undefined
  protected abstract permissionUndecided(event: IpcMainEvent, raw: unknown): void
  protected abstract prepareExtensions(profileId: string): void
  protected abstract presentPagesAsChrome(): void
  protected abstract presentSignInAsElectron(): SignInAgents | null

  /**
   * The icons of sites, served to the interface from the copies the engine keeps of them: the interface asks for no site (site-icons.ts). In the
   * session of the interface only: no page of a profile, and no private context, can ask for a copy.
   */
  protected serveSiteIcons(): void {
    session.defaultSession.protocol.handle(ICON_SCHEME, (request) => this.siteIcons.serve(request.url))
  }
  /** The copies of the icons of sites the interface draws (site-icons.ts): made by the layer that knows the sessions and the blocker. */
  protected abstract readonly siteIcons: SiteIconCopies
  protected abstract readonly optionalGrants: OptionalGrants
  protected abstract readonly tabCaptures: TabCaptures
  protected abstract readonly lentTabs: LentTabs
  protected abstract profileOfSession(ses: Session): string | undefined
  protected abstract registerRelay(view: WebContentsView, extensionId: string, name: string): void
  protected abstract requireHooks(): ExtensionTabHooks
  protected abstract unloadExtension(profileId: string, extensionId: string): void
  protected abstract watchFrameContext(wc: WebContents): void
}
