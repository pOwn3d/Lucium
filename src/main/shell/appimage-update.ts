// The update of Lucium installed as an AppImage (Linux): the same two clicks and the same checks as Windows (windows-update.ts, which this extends), with an AppImage
// in place of the NSIS installer:
//
// 1. « Installer » downloads the AppImage the signed feed of AppImages names, BESIDE the one that runs (update-appimage-file.ts: the same folder, so a rename), and keeps
//    it only if its size and its SHA-256 are the signed ones, made executable.
// 2. « Installer et relancer » (a second click) reads the feed once more for a withdrawal, checks the file again on the disk, swaps it in (the running AppImage is kept as
//    `.previous`), starts a detached helper that starts the new one when this one has ended (not `app.relaunch`, whose relauncher dies with the old AppImage's FUSE
//    runtime: appimage-relaunch.ts; a second instance started now would find the first and give up), then quits through the path of the update of the Mac (the state is
//    written first). The copy that was kept is removed by the new one, once it runs (`removePreviousAppImage`).
//
// A copy whose AppImage cannot be replaced (a folder the person cannot write, a link) installs nothing and is told the download page (`canReplaceAppImage`).

import { app, dialog, net } from 'electron'
import { ownRequestHeaders } from '@shared/own-requests'
import { t } from '@shared/i18n'
import { relaunchAppImageDetached } from './appimage-relaunch'
import { canReplaceAppImage, discardAppImageUpdate, discardAppImageUpdateNow, downloadAppImage, swapAppImage, undoSwapAppImage, verifyStagedAppImage } from '../update-appimage-file'
import type { InstallerFetch } from '../update-installer-file'
import { WindowsUpdateInstaller, type InstallerTexts } from './windows-update'

const TEXTS: InstallerTexts = {
  diskFailed: () => t('appimage-update.le-fichier-n-a-pas-pu-etre-enregistre'),
  notStarted: () => t('appimage-update.la-nouvelle-version-n-a-pas-pu-etre-mise-en-place'),
  restartDetail: (version) => t('appimage-update.lucium-se-ferme-l-appimage-est-remplace', { version })
}

/** `net.fetch` as the download reads it. */
const fetchAppImage: InstallerFetch = (url, init) => net.fetch(url, init)

/**
 * The real one. `file` is the AppImage that runs (`APPIMAGE`), `feed` the address of the feed of AppImages (null: nothing can be installed), `withdrawn` reads the feed
 * again at the click of « Installer et relancer », `prepareQuit` writes the state and lifts the questions of the quit.
 */
export function createAppImageUpdateInstaller(file: string, feed: () => string | null, prepareQuit: () => void, globalPrivacyControl: () => boolean, withdrawn: () => Promise<readonly string[] | null>): WindowsUpdateInstaller {
  return new WindowsUpdateInstaller(
    {
      // An AppImage that cannot be replaced installs nothing: no feed to install from, which the boxes answer with the download page.
      feed: () => (canReplaceAppImage(file) ? feed() : null),
      // Global Privacy Control goes with the download as with every request the application makes for itself (shared/own-requests.ts).
      download: (offer) => downloadAppImage({ fetch: fetchAppImage, headers: ownRequestHeaders({}, globalPrivacyControl()) }, offer, file),
      verify: (staged, offer) => verifyStagedAppImage(file, staged, offer),
      launch: async () => {
        await swapAppImage(file)
        try {
          // Started when this copy has ended, from the file that now holds the new version, by a helper that does not depend on this copy's runtime.
          await relaunchAppImageDetached(file)
        } catch (error) {
          // Nothing was asked to start: the AppImage the person had is put back, and the failure goes to the box of the installer.
          await undoSwapAppImage(file)
          throw error
        }
      },
      discard: () => discardAppImageUpdate(file),
      discardNow: () => discardAppImageUpdateNow(file),
      withdrawn,
      prepareQuit,
      quit: () => app.quit(),
      report: (reason) =>
        void dialog.showMessageBox({ type: 'warning', message: t('app-update.la-mise-a-jour-n-a-pas-pu-etre-installee'), detail: reason }).catch((error: unknown) => console.error('[update] the failure could not be shown:', error)),
      log: (line) => console.warn(line)
    },
    'appimage',
    TEXTS
  )
}
