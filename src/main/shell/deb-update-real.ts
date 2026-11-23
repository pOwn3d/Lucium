// The adviser of a .deb update made of the real parts (deb-update is told, never installed: app-update.ts, `offerDebUpdate`): Electron's network (`net.fetch`, no cookie, no
// credential), the temporary and the Downloads folders of the application, the system clipboard. The rules are in update-deb-file.ts and update-installer-file.ts.

import { app, net } from 'electron'
import { ownRequestHeaders } from '@shared/own-requests'
import { installerFolder, type InstallerFetch } from '../update-installer-file'
import { downloadDeb } from '../update-deb-file'
import { systemCopy, type DebAdviser } from './app-update'

const fetchDeb: InstallerFetch = (url, init) => net.fetch(url, init)

export function createDebAdviser(globalPrivacyControl: () => boolean): DebAdviser {
  return {
    arch: process.arch,
    downloads: () => app.getPath('downloads'),
    // Global Privacy Control goes with the download as with every request the application makes for itself (shared/own-requests.ts).
    download: (offer) => downloadDeb({ fetch: fetchDeb, headers: ownRequestHeaders({}, globalPrivacyControl()), workFolder: installerFolder(app.getPath('temp')), downloads: app.getPath('downloads'), arch: process.arch }, offer),
    copy: systemCopy
  }
}
