// A part of main() (index.ts), moved out as it was: the service of « Importer depuis un autre navigateur… », with where it looks, where
// what it brings goes, and the dialog that asks for a file.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { dialog } from 'electron'
import { t } from '@shared/i18n'
import type { HistoryBook } from '../history'
import { countImportedHistory, mergeImportedHistory, mergeImportedHistoryTracked } from '../importers/history-target'
import { ImportService, setImportService } from '../importers/service'
import type { currentPlatform } from '../platform'
import type { readDevelopmentEnv } from '../runtime'
import { liveCtx, type WindowView } from '../store'
import { getLockService } from '../lock-service'
import { importUndoRefusal } from '@shared/lock'
import type { Browser } from './browser'
import * as menuDialogs from './menu-actions'
import type { WindowManager } from './windows'

export interface ImportServiceDeps {
  platform: ReturnType<typeof currentPlatform>
  /** The development variables (runtime.ts), ignored in the built application. */
  development: ReturnType<typeof readDevelopmentEnv>
  /** The browser of the first window, and its view of the state. */
  browser: Browser
  store: WindowView
  history: HistoryBook
  windowManager: WindowManager
}

export function installImportService({ platform, development, browser, store, history, windowManager }: ImportServiceDeps): void {
  // "Import from Another Browser…": the service finds what the other browsers hold; the sheet (overlay) asks which parts to bring.
  setImportService(
    new ImportService({
      home: homedir(),
      platform: platform.id,
      paths: { localAppData: process.env['LOCALAPPDATA'], appData: process.env['APPDATA'], xdgConfigHome: process.env['XDG_CONFIG_HOME'] },
      // The sheet names each browser as its application calls itself on this Mac (importers/app-names.ts). Outside the built application,
      // LUCIUM_IMPORT_APP_FOLDERS names other folders, or none (the screenshots of the site: every browser keeps its generic label).
      ...(platform.id === 'darwin' ? { applications: development.importAppFolders ?? ['/Applications', join(homedir(), 'Applications')] } : {}),
      ctx: liveCtx,
      dispatch: (action) => browser.dispatch(action),
      undoRefusal: () => importUndoRefusal(getLockService()?.lockedSpaces() ?? []),
      state: () => store.get(),
      // The pages join the history of the profile of the space the import was started in (the sheet says so).
      mergeHistory: (entries) => mergeImportedHistory(history, entries),
      // The preview counts, and "Annuler l'import" takes back, in that same profile.
      countHistory: (entries) => countImportedHistory(history, entries),
      mergeHistoryTracked: (entries) => mergeImportedHistoryTracked(history, entries),
      chooseFile: async (source, expected) => {
        const picked = await dialog.showOpenDialog(windowManager.focused().win, {
          title: t('app.choisir-le-fichier-de-name', { name: source.name }),
          message: t('app.choisissez-expected', { expected }),
          defaultPath: menuDialogs.importFolderOf(source.id, homedir(), platform.id, { localAppData: process.env['LOCALAPPDATA'], appData: process.env['APPDATA'], xdgConfigHome: process.env['XDG_CONFIG_HOME'] }),
          properties: ['openFile', 'showHiddenFiles']
        })
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      }
    })
  )
}
