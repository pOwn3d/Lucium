// "Télécharger et installer", then "Installer et relancer": the update installed by Electron's autoUpdater, which drives the Squirrel.Mac framework
// the application carries (Contents/Frameworks/Squirrel.framework and its installer, ShipIt). Only in a built application with a built-in feed
// (update-source.ts); only when the user asks: the check of menu-actions.ts offers it in a box, the background look of auto-update.ts in a notice
// of the sidebar (`showUpdateNotice`, « Installer »). Nothing here downloads by itself.
//
// How Electron 45 does it on macOS (electron.d.ts, auto_updater_mac.mm, electron_api_auto_updater.cc):
// - `setFeedURL({ url, serverType: 'json' })` makes Squirrel read a static release file (`currentRelease`, `releases`); it throws when the running
//   application has no signature Squirrel can read. It is called again when the address changed since the last call (the user moved to the other
//   update channel meanwhile, update-source.ts), so that what Squirrel downloads is what the check just offered;
// - `checkForUpdates()` reads the file AND downloads the archive when it is newer: `update-available` (the download starts), then `update-downloaded`,
//   or `update-not-available`, or `error`. Called twice, it downloads twice: one download at a time here. Electron gives no progress on macOS;
// - `quitAndInstall()` emits `before-quit-for-update`, closes every window, then quits (ShipIt waits for the process to end, swaps the bundle and
//   opens it again). `before-quit` only comes after the windows are closed: the questions of the quit are lifted on `before-quit-for-update`
//   (quit-flow.ts, `prepareQuitForUpdate`);
// - the autoUpdater is an EventEmitter: an `error` with no listener is thrown in the main process. The listener is put before the first
//   `setFeedURL` and never taken off.
// A downloaded update that is not installed now is installed when Lucium quits (Squirrel.Mac), unless the feed, read again at the next look or at
// the quit, lists it as withdrawn: then Lucium drops it (`dropWithdrawn`, squirrel-staging.ts) and says so.

import { BrowserWindow, autoUpdater, clipboard, dialog, shell, type MessageBoxOptions } from 'electron'
import { downloadedVersion, type UpdateOffer } from '@shared/update-check'
import { UPDATE_NOTICE_MS, droppedUpdateText, updateNoticeText, type DropOutcome, type DroppedNotice, type InstallerState, type UpdateNotice } from '@shared/auto-update'
import { installFailureReason, type InstallError } from '@shared/update-install'
import { formatSize } from '@shared/translate-local'
import { t } from '@shared/i18n'
import { ownRequestHeaders } from '@shared/own-requests'
import { compareVersions } from '@shared/versions'
import { debFileName, debInstallCommand } from '@shared/linux-install'
import { installerClaim, type InstallerDownload } from '../update-installer-file'
import { failureReason } from './windows-update'
import { discardStagedUpdate, LUCIUM_BUNDLE_ID, systemStaging } from './squirrel-staging'

/** What the installer uses of Electron's autoUpdater. */
export interface NativeUpdater {
  on(event: string, listener: (...args: any[]) => void): unknown
  setFeedURL(options: { url: string; serverType: 'json'; headers?: Record<string, string> }): void
  checkForUpdates(): void
  quitAndInstall(): void
}

export type DownloadOutcome = { kind: 'downloaded' } | { kind: 'not-available' } | { kind: 'failed'; reason: string }

/**
 * What the boxes and the notice of an update ask of the installer of this run: Squirrel.Mac's (`UpdateInstaller`, below) or the NSIS one of Windows
 * (windows-update.ts). One of the two is made at start-up (main/index.ts), by the system.
 */
export interface Installer extends InstallerState {
  /**
   * The update that was downloaded is installed by the system as Lucium ends, without another click (Squirrel.Mac does): the box says « À la prochaine
   * fermeture ». False when only « Installer et relancer » installs it (Windows): the box says « Plus tard », and a quit installs nothing.
   */
  readonly installsAtQuit: boolean
  /** Downloads the update `offer` names (`version`: the one the user was offered). A second call while one runs gets the same answer. */
  download(version: string, offer?: UpdateOffer): Promise<DownloadOutcome>
  /** « Installer et relancer »: true when the installation was begun. */
  restart(): boolean
  /** « Installer et relancer » was chosen in this run: the quit under way is the install's. */
  isInstalling(): boolean
  /** What must be done before the installation replaces the application. */
  prepareInstall(): Promise<void>
  dropWithdrawn(withdrawn: readonly string[]): Promise<DropOutcome>
  /** The application ends: what this installer keeps on the disk for an update that was not installed goes. */
  leave(): void
  /** What « Installer et relancer » says will happen, for an installer that does something other than Squirrel's or Windows' (the AppImage's swap). Absent, the box says what its kind says. */
  restartDetail?(version: string): string
}

export interface UpdateInstallerDeps {
  /**
   * The feed Squirrel installs from, asked at each demand (update-source.ts: the built-in address of the channel the setting follows now); null, and
   * nothing can be installed.
   */
  feed: () => string | null
  /** Read at the first download only: nothing of the autoUpdater is touched before the user asks. */
  updater: () => NativeUpdater
  /**
   * Whether Global Privacy Control is on, asked at each demand. Squirrel reads the feed with its own network code, which no hook of a session
   * sees: the header is given to it with the feed (shared/own-requests.ts). Absent, nothing is added.
   */
  globalPrivacyControl?: () => boolean
  /** `before-quit-for-update`: the quit goes through without any question, and the state is written (quit-flow.ts). */
  prepareQuit: () => void
  /** An error no download waits for (the relaunch failed after the windows closed): told to the user. */
  report: (reason: string) => void
  /**
   * Takes back what Squirrel staged for the update that waits (squirrel-staging.ts): rejects when a part of it stays. Absent, a withdrawn update
   * cannot be dropped, and says so.
   */
  discard?: () => Promise<void>
  /**
   * What must be done before Squirrel replaces the application (the custom icon taken off the bundle, app-icon.ts): waited for before « Installer et
   * relancer » and before the quit that installs a downloaded update (update-quit-check.ts). It never stops the installation: a failure is written to
   * the log. Absent, « Installer et relancer » installs at once.
   */
  beforeInstall?: () => Promise<void>
  log?: (line: string) => void
}

/** One installer per run: one download at a time, the listeners put once. */
export class UpdateInstaller implements Installer {
  /** Squirrel installs a downloaded update as the application ends. */
  readonly installsAtQuit = true
  private listening = false
  /** What the autoUpdater was last given (the address, marked when it went with the header of Global Privacy Control), null before the first download. */
  private fedWith: string | null = null
  private pending: Promise<DownloadOutcome> | null = null
  private settle: ((outcome: DownloadOutcome) => void) | null = null
  private ready = false
  /** The version the download under way was asked for, then the one that waits once downloaded: the one Squirrel names (`releaseName`), else the one asked ('' when neither). */
  private asked = ''
  private readyAs = ''
  /** « Installer et relancer » was chosen: the quit that follows is the install's, and nothing may hold it. */
  private installing = false

  constructor(private readonly deps: UpdateInstallerDeps) {}

  /** Whether this run can install an update (a built application on macOS, with a built-in https feed). */
  canInstall(): boolean {
    return this.deps.feed() !== null
  }

  isDownloading(): boolean {
    return this.pending !== null
  }

  /** An update was downloaded in this run: it waits for "Installer et relancer", or for the next quit. */
  isReady(): boolean {
    return this.ready
  }

  /** The version that was downloaded and waits ('' before, or when the download named none). */
  readyVersion(): string {
    return this.ready ? this.readyAs : ''
  }

  /**
   * Downloads the update the feed names (`version`: the one the user was offered, which the notice of a ready update names). A second call while one
   * runs gets the same answer, never a second download.
   */
  download(version = '', _offer?: UpdateOffer): Promise<DownloadOutcome> {
    const feed = this.deps.feed()
    if (feed === null) return Promise.resolve({ kind: 'failed', reason: installFailureReason(null) })
    if (this.ready) return Promise.resolve({ kind: 'downloaded' })
    if (this.pending) return this.pending
    const pending = new Promise<DownloadOutcome>((resolve) => {
      this.settle = resolve
    })
    this.pending = pending
    this.asked = version
    try {
      const updater = this.deps.updater()
      this.listen(updater)
      // The feed is given again when the option changed since: Squirrel keeps the headers it was given with the address.
      const signal = this.deps.globalPrivacyControl?.() === true
      const fed = `${signal ? 'gpc ' : ''}${feed}`
      if (this.fedWith !== fed) {
        updater.setFeedURL({ url: feed, serverType: 'json', ...(signal ? { headers: ownRequestHeaders({}, true) } : {}) })
        this.fedWith = fed
      }
      updater.checkForUpdates()
    } catch (error) {
      // setFeedURL throws when Squirrel cannot read the signature of the running application.
      this.finish({ kind: 'failed', reason: installFailureReason(error as InstallError) })
    }
    return pending
  }

  /** "Installer et relancer": only once an update was downloaded, and once what must be done before the installation is done. */
  restart(): boolean {
    if (!this.ready) return false
    this.installing = true
    if (!this.deps.beforeInstall) {
      this.deps.updater().quitAndInstall()
      return true
    }
    void this.prepareInstall()
      .then(() => this.deps.updater().quitAndInstall())
      .catch((error: unknown) => {
        this.installing = false
        this.deps.log?.(`[update] the installation could not start: ${error instanceof Error ? error.message : String(error)}`)
        this.deps.report(installFailureReason(error as InstallError))
      })
    return true
  }

  /** Does what must be done before Squirrel replaces the application (`beforeInstall`). Never rejects: a failure is written to the log, and the installation goes on. */
  async prepareInstall(): Promise<void> {
    try {
      await this.deps.beforeInstall?.()
    } catch (error) {
      this.deps.log?.(`[update] the application could not be prepared for the installation, which goes on: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** « Installer et relancer » was chosen in this run: the quit under way is the install's. */
  isInstalling(): boolean {
    return this.installing
  }

  /** Squirrel keeps its staging for the next quit, which installs it: nothing to take away. */
  leave(): void {}

  /**
   * The update that waits, when the feed read again lists its version among `withdrawn`: Squirrel's job and files for it are taken back, and this
   * run offers it no more, even when a part of it could not be removed (the next download, of the version the feed offers now, takes its place).
   * Kept when nothing waits, when the download named no version, or when the feed does not list it.
   */
  async dropWithdrawn(withdrawn: readonly string[]): Promise<DropOutcome> {
    const version = this.readyVersion()
    if (!version || !withdrawn.some((listed) => compareVersions(listed, version) === 0)) return { kind: 'kept' }
    this.ready = false
    this.readyAs = ''
    try {
      if (!this.deps.discard) throw new Error('this run has no way to take back what Squirrel staged')
      await this.deps.discard()
      this.deps.log?.(`[update] ${version} was withdrawn from the feed: the downloaded update was dropped and will not be installed`)
      return { kind: 'dropped', version }
    } catch (error) {
      this.deps.log?.(`[update] ${version} was withdrawn from the feed, but what Squirrel staged for it could not be removed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'failed', version }
    }
  }

  private listen(updater: NativeUpdater): void {
    if (this.listening) return
    this.listening = true
    updater.on('error', (error: InstallError) => {
      const reason = installFailureReason(error)
      this.deps.log?.(`[update] the installer failed: ${typeof error?.message === 'string' ? error.message : String(error)}`)
      if (this.pending) this.finish({ kind: 'failed', reason })
      else this.deps.report(reason)
    })
    updater.on('update-downloaded', (_event: unknown, _notes: unknown, releaseName: unknown) => {
      this.ready = true
      // Squirrel reads the feed again at the click: what it downloaded may be newer than the offer read earlier (`asked`).
      const downloaded = downloadedVersion(releaseName)
      if (downloaded === null) {
        const named = typeof releaseName === 'string' ? JSON.stringify(releaseName.slice(0, 60)) : 'none'
        this.deps.log?.(`[update] the downloaded update names no readable version (release name: ${named}): the version the user was offered (${this.asked || 'none'}) stands for it`)
      }
      this.readyAs = downloaded ?? this.asked
      this.finish({ kind: 'downloaded' })
    })
    updater.on('update-not-available', () => this.finish({ kind: 'not-available' }))
    updater.on('before-quit-for-update', () => this.deps.prepareQuit())
  }

  private finish(outcome: DownloadOutcome): void {
    const settle = this.settle
    this.settle = null
    this.pending = null
    settle?.(outcome)
  }
}

let shared: Installer | null = null

/** The installer of this run, made by main() once the quit exists (null before, and in a run that never made one). */
export const updateInstaller = (): Installer | null => shared

/** Replaces the installer of this run (main(), and the tests). */
export function setUpdateInstaller(installer: Installer | null): void {
  shared = installer
}

/**
 * The installer as the quit handlers see it: only one that installs a downloaded update as the application ends (Squirrel.Mac). The look at the feed
 * before such a quit, and what is prepared for it (update-quit-check.ts), concern no other: Windows runs its installer on a click, never at a quit.
 */
export const installerAtQuit = (): Installer | null => (shared?.installsAtQuit === true ? shared : null)

/**
 * The real one: Electron's autoUpdater, a failure no box waits for told in a box of its own, and `beforeInstall` done before Squirrel replaces the
 * application.
 */
export function createUpdateInstaller(feed: () => string | null, prepareQuit: () => void, globalPrivacyControl: () => boolean, beforeInstall: () => Promise<void>): UpdateInstaller {
  return new UpdateInstaller({
    feed,
    globalPrivacyControl,
    updater: () => autoUpdater,
    prepareQuit,
    beforeInstall,
    discard: () => discardStagedUpdate(systemStaging(LUCIUM_BUNDLE_ID)),
    report: (reason) =>
      void dialog.showMessageBox({ type: 'warning', message: t('app-update.la-mise-a-jour-n-a-pas-pu-etre-installee'), detail: reason }).catch((error: unknown) => console.error('[update] the failure could not be shown:', error)),
    log: (line) => console.warn(line)
  })
}

// ---- What the user sees: the boxes and the notice of the download ----

/** How long the notice of the download stays (the box that follows says when it is over). */
export const DOWNLOAD_NOTICE_MS = 10_000
/** The notes of the feed shown in the offer: a few lines, never a page. */
const NOTES_MAX = 600

/** A button of a notice of the sidebar (Browser.showToast), and its second one. */
export interface ToastAction {
  label: string
  run: () => void
  second?: { label: string; run: () => void }
}

export interface ToastHost {
  showToast(message: string, action?: ToastAction, durationMs?: number): void
}

export interface InstallContext {
  /** The window that asked (the focused one, or the About window): the boxes hang from it while it is open. */
  win: BrowserWindow
  /** The sidebar that shows the notice of the download. */
  browser?: ToastHost
}

/** A box on the window that asked, or on the focused one when it was closed meanwhile, or on none. */
function box(context: InstallContext, options: MessageBoxOptions) {
  const live = (win: BrowserWindow | null | undefined): win is BrowserWindow => !!win && typeof win.isDestroyed === 'function' && !win.isDestroyed()
  const parent = live(context.win) ? context.win : BrowserWindow.getFocusedWindow()
  return live(parent) ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}

/**
 * The check found a newer version Squirrel can install: "Télécharger et installer" or "Plus tard". The download runs on after this returns (the
 * About window's button stops waiting), and its end is a box of its own: "Installer et relancer", or what went wrong with "Télécharger manuellement".
 */
export async function offerInstall(context: InstallContext, offer: UpdateOffer, current: string, installer: Installer): Promise<void> {
  if (installer.isReady()) return askRestart(context, installer.readyVersion() || offer.version, installer)
  if (installer.isDownloading()) {
    await box(context, { type: 'info', message: t('app-update.le-telechargement-de-lucium-version-est-deja', { version: offer.version }), detail: t('app-update.lucium-vous-previent-des-que-la-mise-a-jour-est-prete') })
    return
  }
  const notes = offer.notes.trim()
  const detail = [
    t('app-update.vous-utilisez-lucium-current', { current }),
    offer.size ? t('app-update.telechargement-size', { size: formatSize(offer.size) }) : '',
    notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX)}…` : notes
  ]
    .filter(Boolean)
    .join('\n\n')
  const { response } = await box(context, {
    type: 'info',
    message: t('app-update.la-version-version-est-disponible', { version: offer.version }),
    detail,
    buttons: [t('app-update.telecharger-et-installer'), t('menu-actions.plus-tard')],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) startDownload(context, offer, current, installer)
}

/**
 * The check found that the running version was withdrawn: the box says so and names the version to install. `available` is the installer this run
 * would install an update with (null: it installs none). « Télécharger et installer » only when the version to install is above the running one
 * and the feed names its archive; else « Télécharger manuellement », the download page: Squirrel.Mac installs no older version, so the way back to
 * an earlier one is the disk image.
 */
export async function offerWithdrawn(context: InstallContext, found: { offer: UpdateOffer; current: string; newer: boolean }, available: Installer | null): Promise<void> {
  const { offer, current } = found
  const installer = found.newer && offer.archive && available?.canInstall() ? available : null
  if (installer?.isReady()) return askRestart(context, installer.readyVersion() || offer.version, installer)
  if (installer?.isDownloading()) {
    await box(context, { type: 'info', message: t('app-update.le-telechargement-de-lucium-version-est-deja', { version: offer.version }), detail: t('app-update.lucium-vous-previent-des-que-la-mise-a-jour-est-prete') })
    return
  }
  const { response } = await box(context, {
    type: 'warning',
    message: t('app-update.cette-version-a-ete-retiree'),
    detail: t('app-update.lucium-current-a-ete-retire-installez-version', { current, version: offer.version }),
    buttons: [installer ? t('app-update.telecharger-et-installer') : t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) return
  if (installer) startDownload(context, offer, current, installer)
  else await shell.openExternal(offer.url)
}

/**
 * The download the user just accepted (« Télécharger et installer » in the box, « Installer » in the notice): the notice of the download, then a box at
 * its end. An update that is ready already is offered at once; a download under way is not started twice.
 */
export function startDownload(context: InstallContext, offer: UpdateOffer, current: string, installer: Installer): void {
  if (installer.isReady()) {
    void askRestart(context, installer.readyVersion() || offer.version, installer).catch((error: unknown) => console.error('[update] the restart could not be offered:', error))
    return
  }
  if (installer.isDownloading()) return
  context.browser?.showToast(
    offer.size ? t('app-update.telechargement-de-lucium-version-size', { version: offer.version, size: formatSize(offer.size) }) : t('app-update.telechargement-de-lucium-version', { version: offer.version }),
    undefined,
    DOWNLOAD_NOTICE_MS
  )
  void installer
    .download(offer.version, offer)
    .then((outcome) => afterDownload(context, offer, current, outcome, installer))
    .catch((error: unknown) => console.error('[update] the end of the download could not be shown:', error))
}

/**
 * The notice of the background look (auto-update.ts), at the foot of the sidebar of the window in front: « Lucium X est disponible » with « Installer »
 * (the download, then « Installer et relancer »), « Installer et relancer » for an update already downloaded, or the download page for a run that
 * installs nothing; and « Plus tard », which only closes it. Never a box: the typing goes on.
 */
export function showUpdateNotice(context: InstallContext & { browser: ToastHost }, notice: UpdateNotice | DroppedNotice, installer: Installer | null): void {
  // A dropped update with nothing else to install: the sentence alone, with nothing to choose.
  if (notice.kind === 'dropped') return context.browser.showToast(droppedUpdateText(notice.dropped), undefined, UPDATE_NOTICE_MS)
  const text = updateNoticeText(notice.kind, notice.version, notice.kind === 'restart' ? undefined : notice.offer.size, notice.withdrawn === true, notice.dropped, notice.urgent === true)
  const act = (): void => {
    notice.accepted()
    // A .deb is never installed by Lucium: the notice leads to the box that gives the command (offerDebUpdate), not to the download page.
    const adviser = debAdviser()
    if (adviser && notice.offer.kind === 'deb') {
      void offerDebUpdate(context, notice.offer, notice.current, adviser).catch((error: unknown) => console.error('[update] the notice of the .deb could not be shown:', error))
      return
    }
    if (notice.kind === 'page' || !installer) {
      void shell.openExternal(notice.offer.url).catch((error: unknown) => console.error('[update] the download page could not be opened:', error))
      return
    }
    if (notice.kind === 'restart' && installer.restart()) return
    startDownload(context, notice.offer, notice.current, installer)
  }
  // A .deb notice leads to the box with the command, not to a page: its button says so.
  const action = debAdviser() && notice.offer.kind === 'deb' ? t('deb-update.voir-la-commande') : text.action
  context.browser.showToast(text.message, { label: action, run: act, second: { label: text.later, run: () => undefined } }, UPDATE_NOTICE_MS)
}

async function afterDownload(context: InstallContext, offer: UpdateOffer, current: string, outcome: DownloadOutcome, installer: Installer): Promise<void> {
  if (outcome.kind === 'downloaded') return askRestart(context, installer.readyVersion() || offer.version, installer)
  if (outcome.kind === 'not-available') {
    await box(context, { type: 'info', message: t('menu-actions.lucium-est-a-jour'), detail: t('app-update.le-serveur-ne-propose-pas-de-version-plus-recente', { current }) })
    return
  }
  const { response } = await box(context, {
    type: 'warning',
    message: t('app-update.la-mise-a-jour-n-a-pas-pu-etre-telechargee'),
    detail: outcome.reason,
    buttons: [t('menu-actions.telecharger-manuellement'), t('app-update.fermer')],
    defaultId: 1,
    cancelId: 1
  })
  if (response === 0) await shell.openExternal(offer.url)
}

/** "Lucium X est prête": "Installer et relancer" now, or at the next quit (Squirrel installs a downloaded update when the application ends). */
async function askRestart(context: InstallContext, version: string, installer: Installer): Promise<void> {
  const { response } = await box(context, {
    type: 'question',
    message: t('app-update.lucium-version-est-pret', { version }),
    detail: installer.restartDetail ? installer.restartDetail(version) : installer.installsAtQuit ? t('app-update.lucium-se-ferme-se-remplace-puis-se-rouvre', { version }) : t('windows-update.lucium-se-ferme-l-installeur-le-remplace', { version }),
    buttons: [t('app-update.installer-et-relancer'), installer.installsAtQuit ? t('app-update.a-la-prochaine-fermeture') : t('menu-actions.plus-tard')],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) installer.restart()
}

// ---- A .deb: told, never installed ----

/** What the notice of a .deb update needs of the system: the verified download into the Downloads folder, and the clipboard. Absent, a .deb copy is sent to the download page. */
export interface DebAdviser {
  /** The architecture of this copy (`process.arch`): it names the file. */
  arch: string
  /** The Downloads folder of the person. */
  downloads: () => string
  /** Downloads the .deb `offer` names, checks it and puts it in Downloads (update-deb-file.ts). */
  download: (offer: UpdateOffer) => Promise<InstallerDownload>
  copy: (text: string) => Promise<void>
}

let adviser: DebAdviser | null = null

/** Replaces the adviser of this run (main(), and the tests). */
export function setDebAdviser(next: DebAdviser | null): void {
  adviser = next
}

/** The adviser of this run: null off a .deb install. */
export const debAdviser = (): DebAdviser | null => adviser

/** The real one: the system clipboard (the command is copied only when the person asks). */
export const systemCopy = (text: string): Promise<void> => clipboard.writeText(text)

/**
 * The check found a newer version and this copy is a .deb. Installing a package asks for root, and Lucium never raises its own privileges on the strength of a file it
 * downloaded: the box gives the version, the SHA-256 the feed signs and the exact command, and « Télécharger le paquet » fetches the file (checked against the signed size
 * and sum) into Downloads for the person to install with that command. Nothing is installed, and nothing is run.
 */
export async function offerDebUpdate(context: InstallContext, offer: UpdateOffer, current: string, deb: DebAdviser): Promise<void> {
  const claim = installerClaim(offer, 'deb')
  const fileName = debFileName(offer.version, deb.arch)
  if (!claim || !fileName) {
    // The feed does not describe a package that can be checked: the download page is the way.
    const { response } = await box(context, {
      type: 'info',
      message: t('app-update.la-version-version-est-disponible', { version: offer.version }),
      detail: t('menu-actions.vous-utilisez-current-cette-version-n-installe-pas', { current }),
      buttons: [t('menu-actions.telecharger-manuellement'), t('menu-actions.plus-tard')],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) await shell.openExternal(offer.url)
    return
  }
  const command = debInstallCommand(fileName)
  const { response } = await box(context, {
    type: 'info',
    message: t('app-update.la-version-version-est-disponible', { version: offer.version }),
    detail: [t('deb-update.avis-intro', { current }), t('deb-update.avis-telechargement', { size: formatSize(claim.size) }), command, t('deb-update.avis-somme', { sha256: claim.sha256 })].join('\n\n'),
    buttons: [t('deb-update.telecharger-le-paquet'), t('deb-update.copier-la-commande'), t('menu-actions.plus-tard')],
    defaultId: 0,
    cancelId: 2
  })
  if (response === 1) return copyCommand(deb, command)
  if (response !== 0) return
  context.browser?.showToast(t('app-update.telechargement-de-lucium-version-size', { version: offer.version, size: formatSize(claim.size) }), undefined, DOWNLOAD_NOTICE_MS)
  const done = await deb.download(offer)
  if (!done.ok) {
    console.warn(`[update] the .deb of ${offer.version} was not kept (${done.kind}): ${done.detail}`)
    const failed = await box(context, {
      type: 'warning',
      message: t('app-update.la-mise-a-jour-n-a-pas-pu-etre-telechargee'),
      detail: failureReason(done, { diskFailed: () => t('deb-update.le-fichier-n-a-pas-pu-etre-enregistre', { folder: deb.downloads() }) }),
      buttons: [t('menu-actions.telecharger-manuellement'), t('app-update.fermer')],
      defaultId: 1,
      cancelId: 1
    })
    if (failed.response === 0) await shell.openExternal(offer.url)
    return
  }
  const after = await box(context, {
    type: 'info',
    message: t('deb-update.paquet-telecharge', { version: offer.version }),
    detail: [t('deb-update.paquet-pret', { folder: deb.downloads(), sha256: done.sha256 }), command, t('deb-update.paquet-pas-installe')].join('\n\n'),
    buttons: [t('deb-update.copier-la-commande'), t('app-update.fermer')],
    defaultId: 1,
    cancelId: 1
  })
  if (after.response === 0) await copyCommand(deb, command)
}

/** The command on the clipboard; a clipboard that refuses is logged (the box showed the command, so the person can still copy it by hand). */
const copyCommand = (deb: DebAdviser, command: string): Promise<void> => deb.copy(command).catch((error: unknown) => console.error('[update] the command could not be copied:', error))
