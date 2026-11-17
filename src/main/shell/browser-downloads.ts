// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The extensions loaded at start, the downloads and
// the files they open, the PDF with its source, picture in picture.

import { app, dialog, shell } from 'electron'
import type { DownloadInfo } from '@shared/model'
import { activeProfileId, profileDownloadDir } from '@shared/profiles'
import { activeTab } from '@shared/sidebar'
import { logOrigin } from '@shared/url'
import { downloadUi } from './download-ui'
import { missingFileNotice, partialRemovalNotice, resumeAllowed } from '@shared/downloads-view'
import { discardPartialFile } from './download-partial'
import { describeLoadError } from '@shared/extension-page'
import { applicationName, fileTypeOf, isExecutableDownload, openPlan, rememberApplication } from '@shared/open-with'
import { pdfFileName, pdfPrintOptions } from '@shared/pdf-source'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { addBounded } from '@shared/bounded'
import { t } from '@shared/i18n'
import { MAX_DOWNLOADS_KEPT, MEMORY_MAX } from './browser-base'
import { BrowserPanels } from './browser-panels'
import type { TranslatePage } from '../translate/controller'

export abstract class BrowserDownloads extends BrowserPanels {
  // ---- extensions ----

  async loadExtensions(paths: string[], onError: (path: string, error: unknown) => void): Promise<void> {
    const profileIds = new Set(this.store.get().spaces.map((s) => s.profileId))
    for (const path of paths) {
      for (const profileId of profileIds) {
        try {
          await this.engine.loadExtension(profileId, path)
        } catch (error) {
          onError(path, error)
        }
      }
    }
    this.publish()
  }

  /** One folder in every profile: the sentence for the person of the first failure (the engine's error put in words), or null when it loaded. */
  async loadExtensionFolder(folder: string): Promise<string | null> {
    let failure: unknown = null
    await this.loadExtensions([folder], (_path, error) => void (failure ??= error))
    return failure === null ? null : describeLoadError(failure, folder)
  }

  // ---- downloads ----

  // The downloads of all the windows are listed in the main window's browser.
  downloadPath(id: string): string | undefined {
    return this.leader.downloads.find((d) => d.id === id)?.path
  }

  cancelDownload(id: string): void {
    this.engine.cancelDownload(id)
  }

  /** "Afficher dans le Finder" on a finished download: the folder of the file, or a word when the file is no longer there (the Finder would show the folder as if nothing was wrong). */
  revealDownload(id: string): void {
    const download = this.leader.downloads.find((d) => d.id === id)
    if (!download) return
    if (!existsSync(download.path)) return this.showToast(missingFileNotice(download.filename))
    shell.showItemInFolder(download.path)
  }

  clearDownload(id: string): void {
    const row = this.leader.downloads.find((d) => d.id === id)
    // A row that stopped before the end takes its partial file with it: Electron writes it under the final name, so it would pass for the real file. An interrupted
    // download Chromium could still resume is cancelled first (it deletes its own file); one that it could not has left its file where it was.
    if (row?.state === 'interrupted') {
      addBounded(this.leader.dismissedDownloads, id, MEMORY_MAX)
      this.engine.cancelDownload(id)
      if (row.recorded !== true) {
        const outcome = discardPartialFile(row)
        if (outcome.kind === 'failed') {
          console.error(`[downloads] cannot remove the partial file ${row.path}: ${outcome.reason}`)
          this.showToast(partialRemovalNotice(row.filename, outcome.reason))
        }
      }
    }
    this.leader.downloads = this.leader.downloads.filter((d) => d.id !== id)
    // A row the user removes is not coming back: its record on disk, and its partial file, go too (nothing happens for a row without a record).
    this.engine.forgetSavedDownload(id)
    this.publish()
  }

  /** The rows of the downloads that a record can carry on after a restart: put in front of the list, once. */
  protected adoptSavedDownloads(rows: readonly DownloadInfo[]): void {
    if (rows.length === 0) return
    const known = new Set(this.downloads.map((d) => d.id))
    this.downloads = [...this.downloads, ...rows.filter((row) => !known.has(row.id))].slice(0, MAX_DOWNLOADS_KEPT)
    this.publish()
  }

  /** The setting went off (or the window closes): the rows that stood for records are gone, and a running download is an ordinary one again. */
  protected dropSavedDownloads(): void {
    if (!this.downloads.some((d) => d.recorded === true)) return
    this.downloads = this.downloads
      .filter((d) => !(d.recorded === true && d.state !== 'progressing'))
      .map((d) => {
        if (d.recorded !== true) return d
        const { recorded: _recorded, ...rest } = d
        return rest
      })
    this.publish()
  }

  /** Pause and resume are offered by the setting `downloadPause`: with it off a request for them (the interface cannot make one) does nothing. */
  pauseDownload(id: string): void {
    if (this.store.get().settings.downloadPause) this.engine.pauseDownload(id)
  }

  /** A row that stands for a record is resumed by the setting that keeps the records; a running or paused download needs `downloadPause`. */
  resumeDownload(id: string): void {
    if (resumeAllowed(this.store.get().settings, this.leader.downloads.find((d) => d.id === id), this.isPrivate())) this.engine.resumeDownload(id)
  }

  /**
   * "Ouvrir" on a finished download: the application remembered for its type of file when the setting is on and the file may be handed to
   * one, else the system's own way. A remembered application that cannot be used is said so and the system opens the file instead.
   */
  async openDownload(id: string): Promise<void> {
    const download = this.leader.downloads.find((d) => d.id === id)
    if (!download || download.state !== 'completed') return
    if (!existsSync(download.path)) return this.showToast(missingFileNotice(download.filename))
    const plan = openPlan(this.store.get().settings, download.filename, download.mimeType)
    if (plan.kind === 'application') {
      const outcome = await downloadUi().openWith(plan.app, download.path, download.mimeType)
      if (outcome.ok) return
      console.error(`[downloads] cannot open ${download.path} with ${plan.app}: ${outcome.reason}`)
      this.showToast(t('browser.impossible-d-ouvrir-avec-app-ouverture-avec-le-systeme', { app: applicationName(plan.app) }))
    }
    const failure = await downloadUi().openFile(download.path)
    if (failure) {
      console.error(`[downloads] cannot open ${download.path}: ${failure}`)
      this.showToast(t('browser.impossible-d-ouvrir-filename', { filename: download.filename }))
    }
  }

  /**
   * "Ouvrir avec…": the user chooses an application, the file is opened with it, and (setting on, normal window, a type that is not
   * executable) the choice is kept for the type of file. A private window keeps nothing.
   */
  async openDownloadWith(id: string): Promise<void> {
    const settings = this.store.get().settings
    const download = this.leader.downloads.find((d) => d.id === id)
    if (!settings.openWithMemory || !download || download.state !== 'completed') return
    if (isExecutableDownload(download.filename, download.mimeType)) {
      this.showToast(t('browser.ce-type-de-fichier-ne-s-ouvre-pas-avec-une'))
      return
    }
    const app = await downloadUi().chooseApplication(this.win, download.filename)
    if (app === null) return
    const outcome = await downloadUi().openWith(app, download.path, download.mimeType)
    if (!outcome.ok) {
      console.error(`[downloads] cannot open ${download.path} with ${app}: ${outcome.reason}`)
      this.showToast(t('browser.impossible-d-ouvrir-filename-avec-app', { filename: download.filename, app: applicationName(app) }))
      return
    }
    const type = fileTypeOf(download.filename)
    if (this.isPrivate() || type === null) return
    const apps = rememberApplication(settings.openWithApps, type, app)
    if (apps[type] === app) this.dispatch({ type: 'settings/update', patch: { openWithApps: apps } })
  }

  /** Settings › Téléchargements et fichiers › Plus de réglages › Changer… : the application remembered for a type is chosen again. Does nothing in a private window or with the setting off. */
  async chooseOpenWithApplication(type: unknown): Promise<void> {
    const settings = this.store.get().settings
    if (this.isPrivate() || !settings.openWithMemory || typeof type !== 'string' || !Object.hasOwn(settings.openWithApps, type)) return
    const app = await downloadUi().chooseApplication(this.win, `.${type}`)
    if (app === null) return
    const apps = rememberApplication(settings.openWithApps, type, app)
    if (apps[type] === app) this.dispatch({ type: 'settings/update', patch: { openWithApps: apps } })
    else this.showToast(t('browser.cette-application-ne-peut-pas-etre-memorisee'))
  }

  /** A file downloaded to be opened and not kept: opened as a plain download is (the remembered application of its type counts), and the row says what it is. */
  protected async openTemporary(download: DownloadInfo): Promise<void> {
    const settings = this.store.get().settings
    // Never a type that can run: the engine already kept such a file as a normal download, this is the second look.
    if (isExecutableDownload(download.filename, download.mimeType)) return
    const plan = openPlan(settings, download.filename, download.mimeType)
    if (plan.kind === 'application') {
      const outcome = await downloadUi().openWith(plan.app, download.path, download.mimeType)
      if (outcome.ok) return
      console.error(`[downloads] cannot open ${download.path} with ${plan.app}: ${outcome.reason}`)
    }
    const failure = await downloadUi().openFile(download.path)
    if (failure) {
      console.error(`[downloads] cannot open ${download.path}: ${failure}`)
      this.showToast(t('browser.impossible-d-ouvrir-filename', { filename: download.filename }))
    }
  }

  /** File › "Enregistrer en PDF avec l’adresse…": the page printed, with its address and the date in the foot of every page, to the file the user chooses. */
  async savePdfWithSource(): Promise<void> {
    if (!this.store.get().settings.pdfWithSource) return
    this.followPaneFocus()
    const tab = activeTab(this.store.get())
    const page = this.activePage()
    if (!tab || !page) return
    const options = pdfPrintOptions(tab.url, new Date())
    if (options === null) return this.showToast(t('browser.seules-les-pages-web-peuvent-etre-enregistrees'))
    const chosen = await downloadUi().chooseSave(this.win, { filename: pdfFileName(tab.title), folder: profileDownloadDir(this.store.get().settings, activeProfileId(this.store.get())) ?? app.getPath('downloads'), url: tab.url })
    if (chosen === null) return
    try {
      await writeFile(chosen, await page.printToPdf(options))
    } catch (error) {
      console.error(`[pdf] cannot save a page of ${logOrigin(tab.url)} to ${chosen}:`, error)
      dialog.showErrorBox(t('browser.enregistrement-impossible'), `${chosen}\n\n${String((error as Error).message ?? error)}`)
      return
    }
    this.showToast(t('browser.enregistre-name', { name: basename(chosen) }), { label: t('browser.afficher'), run: () => shell.showItemInFolder(chosen) })
  }

  /** Tab ids that currently own a live web view, in any window. */
  livePageIds(): string[] {
    return [...this.group].flatMap((browser) => [...browser.pages.keys()])
  }

  /** Whether the floating sidebar is currently slid over the page. Exposed for the engine smoke test. */
  isFloatingSidebarShown(): boolean {
    return this.floatVisible && !this.store.get().settings.sidebarVisible
  }

  /** Tab ids attached to the window right now (more than one in a split view). */
  visibleTabIds(): string[] {
    return [...this.visible]
  }

  /** Picture in Picture on the active tab's page. Exposed for the engine smoke test. */
  pictureInPicture(on: boolean): Promise<boolean> {
    return this.activePage()?.setPictureInPicture(on) ?? Promise.resolve(false)
  }

  // ---- internals ----

  /** The page on screen as the local translation sees it: its address, and a way to run its scripts in the page's translation world. Null when no page can run them. */
  translatePage(): TranslatePage | null {
    const tab = activeTab(this.store.get())
    return tab ? this.translatePageOf(tab.id) : null
  }

  /**
   * The page of a tab, on screen or not, as the local translation sees it (a page translated by itself as it loads, the page's menu): its tab, its address,
   * whether it is private (nothing of it is written to the settings), and its translation world. Null when the tab has no page that can run the scripts.
   */
  translatePageOf(tabId: string): TranslatePage | null {
    const tab = this.store.get().tabs.find((t) => t.id === tabId)
    const page = tab ? this.pages.get(tab.id) : undefined
    if (!tab || !page?.translateScript) return null
    return { id: tab.id, url: tab.url, private: this.isPrivate() || tab.private === true, run: (code) => page.translateScript!(code) }
  }
}
