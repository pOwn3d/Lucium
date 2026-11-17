// What the downloads ask of the system, behind one seam: the save box, the box that chooses an application, opening a file, the
// application it is opened with. The engine test (smoke-downloads2.ts) puts its own in place and answers without a dialog, as the
// Markdown export does (see markdown-export.ts).

import { dialog, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { SaveRequest } from '../engine/types'
import { openWithApplication, type OpenWithOutcome } from './open-with'
import { t } from '@shared/i18n'
import { assertTestRun } from '../test-seam'

export interface DownloadUi {
  /** The system's save box, at the folder of the profile and with the clean name; null when the user gave up. */
  chooseSave(win: BrowserWindow | null, request: SaveRequest): Promise<string | null>
  /** The box that chooses an application (in /Applications); null when the user gave up. */
  chooseApplication(win: BrowserWindow | null, fileName: string): Promise<string | null>
  /** The system's own way of opening a file: '' when it worked, else the reason. */
  openFile(path: string): Promise<string>
  openWith(app: string, file: string, mimeType?: string): Promise<OpenWithOutcome>
}

const realUi: DownloadUi = {
  async chooseSave(win, request) {
    const options = { get title() { return t('download-ui.enregistrer-sous') }, defaultPath: join(request.folder, request.filename), message: request.url.slice(0, 200) }
    const saved = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return saved.canceled || !saved.filePath ? null : saved.filePath
  },
  async chooseApplication(win, fileName) {
    const options = {
      get title() { return t('download-ui.choisir-une-application') },
      message: t('download-ui.choisissez-l-application-qui-ouvre-filename', { filename: fileName }),
      defaultPath: '/Applications',
      buttonLabel: t('download-ui.ouvrir'),
      properties: ['openFile' as const],
      filters: [{ name: t('download-ui.applications'), extensions: ['app'] }]
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  },
  openFile: (path) => shell.openPath(path),
  openWith: (app, file, mimeType) => openWithApplication(app, file, mimeType)
}

let ui: DownloadUi = realUi

export const downloadUi = (): DownloadUi => ui

/** Replaces some of the system calls (engine test only); returns what puts the real ones back. */
export function setDownloadUi(replacement: Partial<DownloadUi>): () => void {
  assertTestRun('setDownloadUi')
  ui = { ...realUi, ...replacement }
  return () => {
    ui = realUi
  }
}
