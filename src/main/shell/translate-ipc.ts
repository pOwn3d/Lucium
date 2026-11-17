// The IPC of the panel "Traduire cette page" and of the toolbar button's popover: one channel, one validated request at a time (shared/translate-local.ts
// `parseTranslateRequest`), one view back. The controller of a window is made when the first request comes (from this channel, or from the window itself:
// the page's menu, File, a page that loads in a language always translated), and only while the function is on: a browser that never translates holds
// nothing for it.

import { app, BrowserWindow, dialog, net, shell, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Channel } from '@shared/ipc'
import { parseTranslateRequest } from '@shared/translate-local'
import { currentPlatform } from '../platform'
import { isBuiltApp } from '../runtime'
import { TranslateController } from '../translate/controller'
import type { Fetch } from '../translate/download'
import { translationEngines } from '../translate/engines'
import { sessionTranslations } from '../translate/memory'
import { systemTranslateHelperPath } from '../translate/system'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'

/**
 * What the engine test replaces: the network, the folder box, the default folder of the models, the folder of the engine's binary and the helper of
 * the system's translation. The real ones are Chromium's network stack, the system's box, userData/translation-models, userData/translation-engine
 * (fixed: no setting names it) and Contents/Helpers/LuciumTranslate.app (out-native/ from the sources).
 */
export const translateEnvironment: {
  fetch: Fetch
  chooseFolder: ((win: BrowserWindow) => Promise<string | null>) | null
  defaultDir: (() => string) | null
  engineDir: (() => string) | null
  systemHelper: (() => string | null) | null
} = {
  fetch: (url, init) => net.fetch(url, init),
  chooseFolder: null,
  defaultDir: null,
  engineDir: null,
  systemHelper: null
}

/** The helper of the system's translation, looked for at each request (never at start): null when the build has none. */
function locateSystemHelper(): string | null {
  if (translateEnvironment.systemHelper) return translateEnvironment.systemHelper()
  const helper = systemTranslateHelperPath({ built: isBuiltApp(), resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  return existsSync(helper) ? helper : null
}

/** Opens the pane of the system's settings where its translation languages are installed (macOS's Language & Region), on the panel's click. */
function systemSettingsOpener(): (() => void) | undefined {
  const link = currentPlatform().settingsLink('translation-languages')
  if (!link) return undefined
  return () => void shell.openExternal(link).catch((error: unknown) => console.error('[translate] cannot open System Settings:', error instanceof Error ? error.message : String(error)))
}

/** The system as Mozilla's record filters name it (`env.appinfo.OS`). */
const filterOs = (): string => (process.platform === 'win32' ? 'WINNT' : process.platform === 'linux' ? 'Linux' : 'Darwin')

async function chooseFolderWithBox(win: BrowserWindow): Promise<string | null> {
  const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return picked.canceled ? null : (picked.filePaths[0] ?? null)
}

export function registerTranslateIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, store: StateStore, win: BrowserWindow): void {
  let controller: TranslateController | null = null
  const make = (): TranslateController =>
    new TranslateController({
      settings: () => store.get().settings,
      page: () => browser.translatePage(),
      pageOf: (tabId) => browser.translatePageOf(tabId),
      tabChanged: (tabId, translation) => browser.showTabTranslation(tabId, translation),
      // Through the window's own dispatch: a private window keeps none of it (shared/private-window.ts).
      saveSettings: (patch) => browser.dispatch({ type: 'settings/update', patch }),
      systemNotice: () => browser.translationNotice(),
      readOnly: browser.isPrivate(),
      // Read when a request needs the folder, never when the controller is made: the controller of a window is made by the first menu or panel that asks, long
      // before the engine test says where its folders are (translateEnvironment), and a folder read then would be the real one for the whole run.
      get defaultDir() {
        return (translateEnvironment.defaultDir ?? (() => join(app.getPath('userData'), 'translation-models')))()
      },
      get engineDir() {
        return (translateEnvironment.engineDir ?? (() => join(app.getPath('userData'), 'translation-engine')))()
      },
      engines: translationEngines({ locate: locateSystemHelper, systemVersion: () => process.getSystemVersion() }),
      fetch: (url, init) => translateEnvironment.fetch(url, init),
      filterEnv: { channel: 'release', os: filterOs() },
      chooseFolder: () => (translateEnvironment.chooseFolder ?? chooseFolderWithBox)(win),
      saveFolder: (path) => browser.dispatch({ type: 'settings/update', patch: { translateModelsDir: path } }),
      systemLocale: () => app.getLocale(),
      openSystemSettings: systemSettingsOpener(),
      // The translations of this session, in memory, shared by the windows (a private window or tab neither reads nor adds to it).
      memory: sessionTranslations
    })
  // The window reaches the same controller (one-click translation from the page's menu and File, a page translated by itself as it loads).
  browser.useTranslator({ get: () => (store.get().settings.translateLocal ? (controller ??= make()) : null), made: () => controller })
  ipcMain.handle(Channel.translate, async (e, raw: unknown) => {
    if (!guard(e.sender, Channel.translate)) return null
    const request = parseTranslateRequest(raw)
    if (!request) {
      console.warn('[translate] a request the panel may not make was refused')
      return null
    }
    // The function being off is checked again by the controller; here only to hold nothing while it is.
    if (!store.get().settings.translateLocal) return null
    controller ??= make()
    return controller.handle(request)
  })
}
