// IPC of the password manager: one channel, one request type (shared/passwords.ts). Registered for each window with the window's own scoped
// IPC and guard (see registerIpc): only the application's own surfaces get an answer, none while the application is locked. The service
// refuses a private window and a switched-off feature by itself; what is checked here is who asks and what shape the request has.
// A request holds phrases and passwords: nothing of it is logged here.

import { BrowserWindow, dialog, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { NO_PASSWORDS_VIEW, parsePasswordRequest, type PasswordReply } from '@shared/passwords'
import { fileFailureMessage, readBoundedText } from './bounded-file'
import { writePrivateFile } from '../password-vault'
import { getPasswordService, type PasswordFiles } from './password-service'
import type { ScopedIpc } from './ipc-scope'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

const REFUSED: PasswordReply = { ok: false, get message() { return t('feature.demande-refusee') }, view: NO_PASSWORDS_VIEW }

/** The extension an encrypted export is written with. The file is recognised by its content (PASSWORD_EXPORT_FORMAT), never by its extension. */
export const PASSWORD_EXPORT_EXTENSION = 'lucium-passwords'

/** The dialogs and the disk of the password manager, for the window that asked. */
export function passwordFiles(owner: BrowserWindow | null): PasswordFiles {
  const open = (options: Electron.OpenDialogOptions) => (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options))
  const save = (options: Electron.SaveDialogOptions) => (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options))
  return {
    async chooseToRead(kind) {
      const picked = await open(
        kind === 'csv'
          ? { title: t('password-ipc.importer-des-mots-de-passe-csv'), message: t('password-ipc.choisissez-le-fichier-csv-exporte-par-votre'), properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }, { name: t('feature.tous-les-fichiers'), extensions: ['*'] }] }
          : { title: t('password-ipc.importer-un-export-chiffre-de-mots-de-passe'), properties: ['openFile'], filters: [{ name: t('password-ipc.export-chiffre-d-lucium'), extensions: [PASSWORD_EXPORT_EXTENSION, 'json'] }, { name: t('feature.tous-les-fichiers'), extensions: ['*'] }] }
      )
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    async chooseToWrite() {
      const saved = await save({ title: t('password-ipc.exporter-les-mots-de-passe-chiffre'), defaultPath: `lucium-mots-de-passe.${PASSWORD_EXPORT_EXTENSION}`, filters: [{ name: t('password-ipc.export-chiffre-d-lucium'), extensions: [PASSWORD_EXPORT_EXTENSION] }] })
      return saved.canceled || !saved.filePath ? null : saved.filePath
    },
    async readText(path, maxBytes) {
      const read = await readBoundedText(path, maxBytes)
      return read.ok ? read : { ok: false, message: fileFailureMessage(read, maxBytes) }
    },
    writePrivate: writePrivateFile
  }
}

export function registerPasswordIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser): void {
  ipcMain.handle(Channel.passwords, async (e, raw: unknown): Promise<PasswordReply> => {
    if (!guard(e.sender, Channel.passwords)) return REFUSED
    const service = getPasswordService()
    const request = parsePasswordRequest(raw)
    if (!service || !request) return { ok: false, message: t('feature.demande-invalide'), view: NO_PASSWORDS_VIEW }
    // The files are chosen in dialogs of the main process: a path never comes from the interface.
    return service.handle(request, browser.passwordWindow(), passwordFiles(BrowserWindow.fromWebContents(e.sender)))
  })
}
