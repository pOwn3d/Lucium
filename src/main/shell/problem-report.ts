// Aide › « Signaler un problème… » in the main process: the report in plain text (shared/problem-report.ts) is built here from what only this process knows
// (version, variant, system, extensions, the features that are on, the error log), given to the sheet that shows it, and kept for « Enregistrer… ».
// Nothing is sent: no request is made by any line of this file. The report leaves the application by the clipboard (the sheet's « Copier ») or by a file
// the user names in the save dialog; the link of the sheet opens the community page of the site in an ordinary tab, as a link of the About group does.

import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as electron from 'electron'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { getLanguage, t } from '@shared/i18n'
import { Channel, type ExtensionInfo } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { buildProblemReport, PROBLEM_SITE_URLS, reportFileName, type ProblemReportSave } from '@shared/problem-report'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import type { StateStore } from '../store'
import { errorLog } from '../error-log'
import { writeFailureReason } from '../importers/read-error'
import { componentsOf, type Components } from '../engine/widevine'
import { collectEngineHost } from './engine-status'

/** What the report is made from, as the process gives it. */
export interface ProblemReportSources {
  now: number
  appVersion: string
  versions: Readonly<Record<string, string | undefined>>
  platform: string
  /** `process.getSystemVersion()` ("15.1.0"), '' when the process cannot say. */
  systemVersion: string
  arch: string
  /** The `components` module of the castLabs build of Electron, or null on the Electron of the project (the DRM variant or not). */
  components: Components | null
  extensions: readonly Pick<ExtensionInfo, 'name' | 'version' | 'enabled'>[]
  settings: Settings
  log: readonly string[]
}

/** The report for these sources. */
export function problemReportOf(sources: ProblemReportSources): string {
  const host = collectEngineHost({ versions: sources.versions, arch: sources.arch, osRelease: '', components: sources.components, metrics: [], log: [] })
  return buildProblemReport({
    now: sources.now,
    appVersion: sources.appVersion,
    engine: { electron: host.electron, chromium: sources.versions['chrome'] ?? '' },
    variant: host.variant,
    widevine: host.widevine,
    platform: sources.platform,
    systemVersion: sources.systemVersion,
    arch: sources.arch,
    extensions: sources.extensions,
    settings: sources.settings,
    log: sources.log
  })
}

/** The report the sheet showed, as a person read it: what « Enregistrer… » writes. */
export interface ShownReport {
  text: string
  at: number
}

/** « Enregistrer… »: the save dialog of the window, then the text written where the user chose. Giving up writes nothing and says nothing. */
export async function saveProblemReport(owner: BrowserWindow | null, report: ShownReport): Promise<ProblemReportSave> {
  const options = { title: t('problem-report.enregistrer-le-rapport'), defaultPath: reportFileName(report.at), filters: [{ name: t('problem-report.texte-brut'), extensions: ['txt'] }] }
  const saved = await (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options))
  if (saved.canceled || !saved.filePath) return { status: 'canceled' }
  const file = basename(saved.filePath)
  try {
    // 0600: until the user decides to share it, only the user reads it.
    await writeFile(saved.filePath, report.text, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.error(`[report] cannot write ${file}:`, error)
    return { status: 'failed', message: t('problem-report.enregistrement-impossible-dans-file', { file, reason: writeFailureReason(error) }) }
  }
  return { status: 'saved', file }
}

/** What the three channels need from the application. */
export interface ProblemReportEnv {
  sources(): ProblemReportSources
  /** The window to put the save dialog on: the one of the sender. */
  owner(sender: WebContents): BrowserWindow | null
  /** The community page of the site, in a tab of this window group's browser. */
  openSite(): void
}

export function registerProblemReportIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, env: ProblemReportEnv): void {
  // The text the sheet was given last: « Enregistrer… » writes that one, so that the file is what was on screen and not another reading of the log.
  let shown: ShownReport | null = null

  ipcMain.handle(Channel.problemReport, (e): string | null => {
    if (!guard(e.sender, Channel.problemReport)) return null
    try {
      const sources = env.sources()
      shown = { text: problemReportOf(sources), at: sources.now }
      return shown.text
    } catch (error) {
      console.error('[report] cannot prepare the report:', error)
      shown = null
      return null
    }
  })

  ipcMain.handle(Channel.saveProblemReport, async (e): Promise<ProblemReportSave> => {
    if (!guard(e.sender, Channel.saveProblemReport) || shown === null) return { status: 'failed', message: t('problem-report.le-rapport-n-a-pas-pu-etre-prepare') }
    return saveProblemReport(env.owner(e.sender), shown)
  })

  ipcMain.on(Channel.openProblemSite, (e) => {
    if (guard(e.sender, Channel.openProblemSite)) env.openSite()
  })
}

/** The environment of a window group: its browser's extension engine, the settings of its state, the window to bring forward for the link. */
export function problemReportEnv(browser: Browser, store: StateStore, win: BrowserWindow): ProblemReportEnv {
  return {
    sources: () => ({
      now: Date.now(),
      appVersion: app.getVersion(),
      versions: process.versions,
      platform: process.platform,
      systemVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
      arch: process.arch,
      components: componentsOf(electron),
      extensions: browser.extensionEngine.listAllExtensions(),
      settings: store.get().settings,
      log: errorLog.lines()
    }),
    owner: (sender) => BrowserWindow.fromWebContents(sender) ?? (win.isDestroyed() ? null : win),
    openSite: () => {
      // An ordinary tab of the window, at the address of the language of the interface (shared/problem-report.ts).
      browser.dispatch({ type: 'tab/open', url: PROBLEM_SITE_URLS[getLanguage()] })
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
}
