// The update of Lucium on Windows: « Installer » in the box (menu-actions.ts) or in the notice (auto-update.ts), then « Installer et relancer ». It does what
// Squirrel.Mac does on macOS (app-update.ts), with the installer the signed feed names in place of Squirrel:
//
// 1. The feed was read, was signed by a key of the application, is for win32-x64, is not older than the last one accepted and offers a version above the running
//    one (update-check.ts, update-target.ts, update-feed-date.ts): the offer given here has already been through all of that, and `download` asks again of the
//    offer what only the installer needs (an NSIS installer, an https address, a SHA-256 and a size: update-installer-file.ts).
// 2. `download` (only after the click) fetches the installer into a folder of its own and keeps the file only if its size and its SHA-256 are the signed ones.
//    Nothing is run by the download: the file waits.
// 3. `restart` (« Installer et relancer », a second click) asks the feed once more whether the version was withdrawn meanwhile, checks the file again on the
//    disk, runs the installer silently and detached, and quits through the path of the update of the Mac (the state is written first). No installer is run
//    without these two clicks, and none is run at a quit: « Plus tard » leaves the file where it is, and the next quit removes it.
//
// The installer is the NSIS one of electron-builder (oneClick: false, perMachine: false: an installation for the user, no elevation). Its silent arguments, read in
// the templates of app-builder-lib 26.18 (nsis/installSection.nsh, common.nsh, include/allowOnlyOneInstallerInstance.nsh): `/S` is NSIS's own silent mode;
// `--updated` makes it wait for the running Lucium to leave (a second, then it stops it) instead of asking, and keeps the shortcuts as they are;
// `--force-run` starts Lucium again once it is done (an assisted installer does so only when silent and forced).

import { spawn, type ChildProcess } from 'node:child_process'
import { droppedUpdateText, type DropOutcome } from '@shared/auto-update'
import { installFailureReason } from '@shared/update-install'
import { t } from '@shared/i18n'
import { compareVersions } from '@shared/versions'
import type { UpdateOffer } from '@shared/update-check'
import { installerClaim, type InstallerDownload } from '../update-installer-file'
import type { DownloadOutcome, Installer } from './app-update'

/** What the NSIS installer is run with (see the head of this file). */
export const INSTALLER_ARGUMENTS: readonly string[] = ['/S', '--updated', '--force-run']

/** What the installer needs of the system: the stand-ins of the tests go through here, so that no installer is ever run by a test. */
export interface WindowsUpdateDeps {
  /** The feed the installer installs from, asked at each demand (update-source.ts); null, and nothing can be installed. */
  feed: () => string | null
  /** The verified download of an offer (update-installer-file.ts). */
  download: (offer: UpdateOffer) => Promise<InstallerDownload>
  /** The last check of the file on the disk, just before it is run: true only when it is the installer `offer` names. */
  verify: (file: string, offer: UpdateOffer) => Promise<boolean>
  /** Runs the installer, detached; rejects when it could not be started. */
  launch: (file: string) => Promise<void>
  /** Takes the file (and its folder) away. */
  discard: () => Promise<void>
  /** The same at once, for the quit, which does not wait. */
  discardNow: () => void
  /** The versions the feed lists as withdrawn, read now; null when it could not be read (the reader says why in the log). */
  withdrawn: () => Promise<readonly string[] | null>
  /** `before-quit-for-update`: the quit goes through without any question, and the state is written (quit-flow.ts, `prepareQuitForUpdate`). */
  prepareQuit: () => void
  /** Quits the application. */
  quit: () => void
  /** A failure no download waits for (the file did not pass its last check, the installer did not start): told to the user. */
  report: (reason: string) => void
  log?: (line: string) => void
}

/** The sentence of a failed download, by the way it failed. */
function failureReason(download: Extract<InstallerDownload, { ok: false }>): string {
  const detail = `\n\n${t('update-install.detail-words', { words: download.detail })}`
  switch (download.kind) {
    case 'network':
      return t('update-install.le-serveur-des-mises-a-jour-est-injoignable') + detail
    case 'mismatch':
      return t('windows-update.le-fichier-telecharge-ne-correspond-pas') + detail
    case 'disk':
      return t('windows-update.le-fichier-n-a-pas-pu-etre-enregistre') + detail
    case 'offer':
      return t('windows-update.le-flux-ne-decrit-pas-un-installeur') + detail
  }
}

/** One installer per run: one download at a time, one file that waits. */
export class WindowsUpdateInstaller implements Installer {
  /** Nothing is installed at a quit: the installer runs only on the click of « Installer et relancer ». */
  readonly installsAtQuit = false
  private pending: Promise<DownloadOutcome> | null = null
  /** The installer that was downloaded and checked, and waits for « Installer et relancer ». */
  private ready: { offer: UpdateOffer; file: string } | null = null
  private installing = false

  constructor(private readonly deps: WindowsUpdateDeps) {}

  canInstall(): boolean {
    return this.deps.feed() !== null
  }

  isDownloading(): boolean {
    return this.pending !== null
  }

  isReady(): boolean {
    return this.ready !== null
  }

  readyVersion(): string {
    return this.ready?.offer.version ?? ''
  }

  isInstalling(): boolean {
    return this.installing
  }

  /** Nothing is done to the application before the installer runs (no custom icon of a bundle on Windows). */
  async prepareInstall(): Promise<void> {}

  /**
   * Downloads the installer `offer` names, and keeps it only when it is the signed one. A second call while one runs gets the same answer, never a second
   * download; an installer that is ready already is not downloaded again.
   */
  download(_version: string, offer?: UpdateOffer): Promise<DownloadOutcome> {
    if (this.deps.feed() === null) return Promise.resolve({ kind: 'failed', reason: installFailureReason(null) })
    if (this.ready) return Promise.resolve({ kind: 'downloaded' })
    if (this.pending) return this.pending
    if (!offer || installerClaim(offer) === null) return Promise.resolve({ kind: 'failed', reason: t('windows-update.le-flux-ne-decrit-pas-un-installeur') })
    const pending = this.run(offer).finally(() => {
      this.pending = null
    })
    this.pending = pending
    return pending
  }

  private async run(offer: UpdateOffer): Promise<DownloadOutcome> {
    try {
      const done = await this.deps.download(offer)
      if (!done.ok) {
        this.deps.log?.(`[update] the installer of ${offer.version} was not kept (${done.kind}): ${done.detail}`)
        return { kind: 'failed', reason: failureReason(done) }
      }
      this.ready = { offer, file: done.file }
      return { kind: 'downloaded' }
    } catch (error) {
      this.deps.log?.(`[update] the download of the installer failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'failed', reason: installFailureReason({ message: error instanceof Error ? error.message : String(error) }) }
    }
  }

  /**
   * « Installer et relancer »: only once an installer was downloaded and checked. The feed is read once more (a version withdrawn since is dropped and
   * not run), the file is checked once more, the installer is started, and only then does the application quit: a failure before the start leaves Lucium
   * open and untouched, with the reason in a box. True when the installation was begun (it goes on after this returns).
   */
  restart(): boolean {
    if (!this.ready || this.installing) return false
    this.installing = true
    void this.install(this.ready).catch((error: unknown) => {
      this.installing = false
      this.deps.log?.(`[update] the installation could not start: ${error instanceof Error ? error.message : String(error)}`)
      this.deps.report(t('windows-update.l-installeur-n-a-pas-pu-etre-lance') + `\n\n${t('update-install.detail-words', { words: error instanceof Error ? error.message : String(error) })}`)
    })
    return true
  }

  private async install(ready: { offer: UpdateOffer; file: string }): Promise<void> {
    const withdrawn = await this.deps.withdrawn()
    if (withdrawn?.some((listed) => compareVersions(listed, ready.offer.version) === 0)) {
      this.installing = false
      const removed = await this.drop(ready.offer.version)
      this.deps.report(droppedUpdateText({ version: ready.offer.version, failed: !removed }))
      return
    }
    if (withdrawn === null) this.deps.log?.('[update] the feed was not read before the installation (no valid answer): the downloaded installer is run as it is')
    if (!(await this.deps.verify(ready.file, ready.offer))) {
      this.installing = false
      this.ready = null
      await this.deps.discard().catch((error: unknown) => this.deps.log?.(`[update] the installer that failed its last check could not be removed: ${error instanceof Error ? error.message : String(error)}`))
      this.deps.report(t('windows-update.le-fichier-telecharge-ne-correspond-pas'))
      return
    }
    // Started first: when it cannot start, Lucium is still as it was. It waits for Lucium to leave (`--updated`), and the state is written below, in the same turn.
    await this.deps.launch(ready.file)
    this.deps.prepareQuit()
    this.deps.quit()
  }

  /** Forgets the installer that waits (it is never run again by this run) and takes its file away; false when the file could not be removed, which the log says. */
  private async drop(version: string): Promise<boolean> {
    this.ready = null
    try {
      await this.deps.discard()
      this.deps.log?.(`[update] ${version} was withdrawn from the feed: the downloaded installer was dropped and will not be run`)
      return true
    } catch (error) {
      this.deps.log?.(`[update] ${version} was withdrawn from the feed, but its installer could not be removed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** The installer that waits, when the feed lists its version among `withdrawn`: dropped (the file is removed), and this run offers it no more. */
  async dropWithdrawn(withdrawn: readonly string[]): Promise<DropOutcome> {
    const version = this.readyVersion()
    if (!version || !withdrawn.some((listed) => compareVersions(listed, version) === 0)) return { kind: 'kept' }
    return (await this.drop(version)) ? { kind: 'dropped', version } : { kind: 'failed', version }
  }

  /** The application ends without having run the installer: its file goes with it, at once (the quit does not wait for what is asked after it). */
  leave(): void {
    if (this.installing || !this.ready) return
    this.ready = null
    try {
      this.deps.discardNow()
    } catch (error) {
      this.deps.log?.(`[update] the installer that waited could not be removed at the quit: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Runs the NSIS installer: silent, detached from Lucium (it outlives it), without a console window, never through a shell (the path is one argument, not a
 * line). Resolves once the system has started it, rejects when it could not be.
 */
export function launchInstaller(file: string, start: typeof spawn = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = start(file, [...INSTALLER_ARGUMENTS], { detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    } catch (error) {
      return reject(error instanceof Error ? error : new Error(String(error)))
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
