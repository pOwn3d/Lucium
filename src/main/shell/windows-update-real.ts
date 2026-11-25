// The installer of Windows made of the real parts: Electron's network (`net.fetch`, no cookie, no credential), the temporary folder of the application, the
// NSIS installer started by the system, a failure told in a box. The rules are in windows-update.ts and update-installer-file.ts, which tests drive with stand-ins.

import { join } from 'node:path'
import { app, dialog, net } from 'electron'
import { sweepInstallerLeftover } from '@shared/installer-leftover'
import { ownRequestHeaders } from '@shared/own-requests'
import { t } from '@shared/i18n'
import {
  discardInstallerFolder,
  discardInstallerFolderNow,
  downloadVerifiedInstaller,
  installerFolder,
  verifyInstallerFile,
  type InstallerFetch
} from '../update-installer-file'
import { WindowsUpdateInstaller, launchInstaller } from './windows-update'

/** `net.fetch` as the download reads it. */
const fetchInstaller: InstallerFetch = (url, init) => net.fetch(url, init)

/**
 * The real one. `feed` is the address the installer installs from (null: nothing can be installed), `withdrawn` reads the feed again at the click of
 * « Installer et relancer », `prepareQuit` writes the state and lifts the questions of the quit.
 */
export function createWindowsUpdateInstaller(feed: () => string | null, prepareQuit: () => void, globalPrivacyControl: () => boolean, withdrawn: () => Promise<readonly string[] | null>): WindowsUpdateInstaller {
  const folder = (): string => installerFolder(app.getPath('temp'))
  return new WindowsUpdateInstaller({
    feed,
    // Global Privacy Control goes with the download as with every request the application makes for itself (shared/own-requests.ts).
    download: (offer) => downloadVerifiedInstaller({ fetch: fetchInstaller, folder: folder(), headers: ownRequestHeaders({}, globalPrivacyControl()) }, offer),
    verify: (file, offer) => verifyInstallerFile(folder(), file, offer),
    launch: (file) => launchInstaller(file),
    discard: () => discardInstallerFolder(folder()),
    discardNow: () => discardInstallerFolderNow(folder()),
    withdrawn,
    prepareQuit,
    quit: () => app.quit(),
    report: (reason) =>
      void dialog.showMessageBox({ type: 'warning', message: t('app-update.la-mise-a-jour-n-a-pas-pu-etre-installee'), detail: reason }).catch((error: unknown) => console.error('[update] the failure could not be shown:', error)),
    log: (line) => console.warn(line)
  })
}

/**
 * At launch: the installer of the update that was run (Windows) is still in the temporary folder, because Lucium quit for it while the system held the file.
 * Nothing is downloaded or waiting at this point, so the folder is only leftover. Never throws; the outcome is in the log.
 */
export function sweepInstallerLeftoverAtLaunch(): Promise<unknown> {
  const temp = app.getPath('temp')
  return sweepInstallerLeftover({ temp, folder: installerFolder(temp), join, remove: discardInstallerFolder, log: (line) => console.warn(line) })
}
