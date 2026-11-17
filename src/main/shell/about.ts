// "À propos": the system's About panel (Lucium › À propos de Lucium) and the two messages of the About group of the Settings window.
// The texts and addresses live in @shared/about; this file only hands them to Electron.

import { release } from 'node:os'
import * as electron from 'electron'
import { app, BrowserWindow, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { aboutEngine, aboutPanelOptions, aboutUrl, aboutVersion, parseAboutTarget, type AboutPanelOptions } from '@shared/about'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import type { StateStore } from '../store'
import { checkForUpdates, openDocumentation } from './menu-actions'
import { errorLog } from '../error-log'
import { componentsOf } from '../engine/widevine'
import { collectEngineHost } from './engine-status'

let applied: AboutPanelOptions | null = null

/** Gives the About panel of the menu its name, version, copyright, licence and site. Called once at start-up, before the menu is built. */
export function applyAboutPanel(version: string = app.getVersion()): AboutPanelOptions {
  const options = aboutPanelOptions(version)
  app.setAboutPanelOptions(options)
  applied = options
  return options
}

/** The options the panel was last given (null before `applyAboutPanel` ran): the engine test reads them, since the panel itself cannot be read. */
export const appliedAboutPanel = (): AboutPanelOptions | null => applied

/**
 * The version for the About group, and its links. A link arrives as one of four words (see parseAboutTarget); the address comes from the
 * constants of @shared/about, so the interface cannot make the browser open anything else through this channel.
 */
export function registerAboutIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, win: BrowserWindow, store: StateStore): void {
  ipcMain.handle(Channel.aboutVersion, (e) => (guard(e.sender, Channel.aboutVersion) ? aboutVersion(app.getVersion()) : ''))
  // The About window: the engine under the browser, and the look for a newer version, whose answer is a box of the system on that window.
  ipcMain.handle(Channel.aboutEngine, (e) => aboutEngine(guard(e.sender, Channel.aboutEngine) ? process.versions : {}, process.platform))
  ipcMain.handle(Channel.aboutCheckUpdates, async (e) => {
    if (!guard(e.sender, Channel.aboutCheckUpdates)) return
    const owner = BrowserWindow.fromWebContents(e.sender)
    if (!owner || owner.isDestroyed()) return
    try {
      // The button says « Recherche… » itself while it waits; a download it starts goes on after the answer (app-update.ts).
      await checkForUpdates({ win: owner, browser, store }, store.get().settings, { searching: false })
    } catch (error) {
      console.error('[about] the look for updates failed:', error)
    }
  })

  ipcMain.handle(Channel.clearErrorLog, (e) => {
    if (guard(e.sender, Channel.clearErrorLog)) errorLog.clear()
  })

  // The versions, the memory and the error log for Settings › Général › État de Lucium: read-only, and read only when the pane asks.
  ipcMain.handle(Channel.engineStatus, (e) =>
    guard(e.sender, Channel.engineStatus) ? collectEngineHost({ versions: process.versions, arch: process.arch, osRelease: release(), components: componentsOf(electron), metrics: app.getAppMetrics(), log: errorLog.lines() }) : null
  )

  ipcMain.on(Channel.openAbout, (e, raw: unknown) => {
    if (!guard(e.sender, Channel.openAbout)) return
    const target = parseAboutTarget(raw)
    if (!target) {
      console.warn('[about] ignored a link that is not one of the four:', typeof raw === 'string' ? raw.slice(0, 32) : typeof raw)
      return
    }
    const url = aboutUrl(target)
    if (url === null) {
      // The licences are a document of the documentation shipped with the application, opened the way Aide › Documentation opens its folder.
      void openDocumentation('folder').catch((error: unknown) => console.error('[about] cannot open the documentation:', error))
      return
    }
    // An ordinary tab of the main window: the Settings window is never navigated (it is locked to the application's own pages).
    browser.dispatch({ type: 'tab/open', url })
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}
