// What the Extensions page's service needs from the system: the boxes (over the window that holds the tab of the page), the files of a folder, the tab of an options
// page, the loading of a folder. Electron's; the service itself is tested without it (extensions-service.test.ts).

import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { BrowserWindow, clipboard, dialog } from 'electron'
import type { WebContents } from 'electron'
import { t } from '@shared/i18n'
import type { Browser } from './browser'
import type { StateStore } from '../store'
import type { ExtensionsServiceEnv } from './extensions-service'
import { packExtensionFolder } from '../engine/crx-pack'

const MANIFEST_MAX_BYTES = 1024 * 1024

/** `sender` is the web contents of the page that asked: the boxes open over the window it is in (over another window they could be behind the page). */
export function extensionsEnv(browser: Browser, store: StateStore, win: BrowserWindow, sender: () => WebContents | null): ExtensionsServiceEnv {
  const owner = (): BrowserWindow => {
    const asked = sender()
    return (asked ? BrowserWindow.fromWebContents(asked) : null) ?? win
  }
  return {
    engine: browser.extensionEngine,
    state: () => store.get(),
    dispatch: (action) => browser.dispatch(action),
    isPrivate: () => browser.isPrivate(),
    confirm: async ({ message, detail, ok }) => (await dialog.showMessageBox(owner(), { type: 'warning', message, detail, buttons: [ok, t('confirm-box.annuler')], defaultId: 1, cancelId: 1 })).response === 0,
    chooseFolder: async () => {
      const picked = await dialog.showOpenDialog(owner(), { title: t('ipc.choisir-le-dossier-d-une-extension-non'), properties: ['openDirectory'] })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    readManifest: async (folder) => {
      const file = join(folder, 'manifest.json')
      try {
        const info = await stat(file)
        if (!info.isFile()) return null
        if (info.size > MANIFEST_MAX_BYTES) throw new Error('manifest.json is larger than 1 MiB')
        return await readFile(file, 'utf8')
      } catch (error) {
        // A folder with no manifest is an answer (null: the page says so); anything else (no right to read it, too large) is the page's to report.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null
        throw error
      }
    },
    fileExists: async (folder, relative) => {
      const file = resolve(folder, relative)
      if (!file.startsWith(`${resolve(folder)}${sep}`)) return false
      return stat(file).then((info) => info.isFile(), () => false)
    },
    loadFolder: (folder) => browser.loadExtensionFolder(folder),
    copyText: (text) => clipboard.writeText(text),
    openExtensionTab: async (profileId, url) => void (await browser.openTabForExtension(url, true, profileId)),
    pack: async (folder, name) => {
      const saved = await dialog.showSaveDialog(owner(), { title: t('extpage.empaqueter-l-extension'), defaultPath: `${name.replace(/[\\/:*?"<>|\s]+/g, '-').toLowerCase() || 'extension'}.crx`, filters: [{ name: 'Extension (CRX)', extensions: ['crx'] }] })
      return saved.canceled || !saved.filePath ? null : packExtensionFolder(folder, saved.filePath)
    }
  }
}
