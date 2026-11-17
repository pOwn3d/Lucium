// IPC of the features of the menu that have a panel: the import sheet and Find and Replace. Registered for each window with the
// window's own scoped IPC and guard (see registerIpc).

import { join } from 'node:path'
import { BrowserWindow, dialog, shell, app, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { isBuiltApp } from '../runtime'
import { parseReplaceRequest } from '@shared/find-replace'
import { isCalcCopy } from '@shared/calc'
import { parseTooltip } from '@shared/tooltip'
import { parseMediaRequest } from '@shared/media-player'
import { parseThemeRequest } from '@shared/theme-code'
import { parseBoostShareRequest, type ShareReply } from '@shared/boost-share'
import type { ScriptPreviewReply } from '@shared/boost'
import { BOOST_ID } from '@shared/sidebar-state'
import { DISK_ACCESS_SETTINGS_URL, noReport } from '@shared/import-sources'
import { activeProfileId } from '@shared/profiles'
import { confirmImport, importRequest, listImportSources, undoImport, type ImportEnv } from '../importers/requests'
import { getImportService } from '../importers/service'
import type { ScopedIpc } from './ipc-scope'
import { registerTranslateIpc } from './translate-ipc'
import { registerNotesIpc } from './notes-ipc'
import type { Browser } from './browser'
import { runThemeRequest } from './theme-actions'
import { themeEnvironment } from './theme-environment'
import { answering, runBoostShareRequest, runThemeFileRequest } from './boost-share'
import { shareEnvironment } from './share-environment'
import type { StateStore } from '../store'
import { NO_BACKUPS } from '@shared/session-backups'
import { getSessionBackups } from './backups'
import { asideSpace } from './space-aside'
import { parseUserScriptRequest, type UserScriptReply } from '@shared/userscript'
import { readScriptFile, userScripts } from '../userscripts'
import { handleUserScriptRequest, scriptFileTooBig } from './userscripts-service'
import { parseSpaceImageRequest } from '@shared/space-image'
import { parseWebPanelRequest } from '@shared/web-panels'
import { parseBookmarksTransferRequest } from '@shared/bookmarks'
import { transferBookmarks } from './bookmarks-library'
import { runSpaceImageRequest } from './space-images'
import { chooseImageFile, spaceImages, sweepSpaceImages } from './space-images-electron'
import { parseSpaceBackgroundMediaRequest } from '@shared/space-background-media'
import { runSpaceBackgroundMediaRequest } from './space-background-media-service'
import { getLockService } from '../lock-service'
import { t } from '@shared/i18n'

export function registerFeatureIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, store: StateStore, win: BrowserWindow): void {
  registerTranslateIpc(ipcMain, guard, browser, store, win)
  registerNotesIpc(ipcMain, guard, browser, store)
  // The messages of the import sheet: what they do is in importers/requests.ts (private window, request checked, profile of the history), where it is tested.
  const importEnv = (): ImportEnv => ({ service: getImportService(), isPrivate: browser.isPrivate(), historyProfile: activeProfileId(store.get()) })
  ipcMain.handle(Channel.importSources, (e) => (guard(e.sender, Channel.importSources) ? listImportSources(importEnv()) : []))
  ipcMain.handle(Channel.importRun, async (e, raw: unknown) => (guard(e.sender, Channel.importRun) ? importRequest(importEnv(), 'run', raw) : noReport(t('feature.demande-refusee'))))
  ipcMain.handle(Channel.importPreview, async (e, raw: unknown) => (guard(e.sender, Channel.importPreview) ? importRequest(importEnv(), 'preview', raw) : noReport(t('feature.demande-refusee'))))
  ipcMain.handle(Channel.importCommit, (e, raw: unknown) => (guard(e.sender, Channel.importCommit) ? confirmImport(importEnv(), raw) : noReport(t('feature.demande-refusee'))))
  ipcMain.handle(Channel.importUndo, (e, raw: unknown) => (guard(e.sender, Channel.importUndo) ? undoImport(importEnv(), raw) : noReport(t('feature.demande-refusee'))))

  // First-launch guide: preview and confirm the import it offers (the sources come from importSources, as for the import sheet).
  ipcMain.handle(Channel.firstLaunchPreview, async (e, raw: unknown) => (guard(e.sender, Channel.firstLaunchPreview) ? importRequest(importEnv(), 'preview', raw) : noReport(t('feature.demande-refusee'))))
  ipcMain.handle(Channel.firstLaunchConfirm, (e, raw: unknown) => (guard(e.sender, Channel.firstLaunchConfirm) ? confirmImport(importEnv(), raw) : noReport(t('feature.demande-refusee'))))

  // The user's own filter lists: the file dialog is the main process', so the interface never names a path; the text it pastes is checked again.
  ipcMain.handle(Channel.addFilterListFile, async (e) => {
    if (!guard(e.sender, Channel.addFilterListFile)) return { ok: false, reason: t('feature.demande-refusee') }
    if (browser.isPrivate()) return { ok: false, reason: t('feature.les-listes-personnalisees-ne-sont-pas') }
    const options = {
      title: t('feature.choisir-une-liste-de-filtres'),
      properties: ['openFile' as const],
      filters: [
        { name: t('feature.listes-de-filtres'), extensions: ['txt', 'list', 'adblock', 'filters'] },
        { name: t('feature.tous-les-fichiers'), extensions: ['*'] }
      ]
    }
    const owner = BrowserWindow.fromWebContents(e.sender)
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const [path] = picked.filePaths
    if (picked.canceled || !path) return { ok: false, reason: '', canceled: true }
    return browser.addFilterListFile(path)
  })
  ipcMain.handle(Channel.addFilterListText, (e, title: unknown, text: unknown) =>
    guard(e.sender, Channel.addFilterListText) ? browser.addFilterListText(title, text) : { ok: false, reason: t('feature.demande-refusee') }
  )
  ipcMain.handle(Channel.removeFilterList, async (e, id: unknown) => {
    if (guard(e.sender, Channel.removeFilterList)) await browser.removeFilterList(id)
  })

  ipcMain.on(Channel.openDiskAccessSettings, (e) => {
    if (!guard(e.sender, Channel.openDiskAccessSettings)) return
    void shell.openExternal(DISK_ACCESS_SETTINGS_URL).catch((error: unknown) => console.error('[import] cannot open System Settings:', error))
  })

  // The capsule of a toolbar button: a request that is not a short label at a real point ends the tooltip.
  ipcMain.on(Channel.tooltip, (e, raw: unknown) => {
    if (guard(e.sender, Channel.tooltip)) browser.showTooltip(parseTooltip(raw))
  })

  // The buttons of a media player: a request that is not a known command on a tab id (or a volume from 0 to 1) does nothing.
  ipcMain.on(Channel.media, (e, raw: unknown) => {
    if (!guard(e.sender, Channel.media)) return
    const request = parseMediaRequest(raw)
    if (request) browser.mediaRequest(request)
  })

  ipcMain.on(Channel.copyUrl, (e) => {
    if (guard(e.sender, Channel.copyUrl)) void browser.copyUrl('plain').catch((error: unknown) => console.error('[toolbar] cannot copy the address:', error))
  })

  // The window the sheets of a share belong to: the one that holds the surface asking; a surface with no window of its own asks in the window of the group.
  const ownerOf = (sender: WebContents): BrowserWindow => BrowserWindow.fromWebContents(sender) ?? win

  // The answer of the command bar's calculator: only a number as the calculator writes it reaches the clipboard.
  ipcMain.on(Channel.copyCalcResult, (e, text: unknown) => {
    if (!guard(e.sender, Channel.copyCalcResult)) return
    if (!isCalcCopy(text)) return void console.warn('[calc] a result that is not a number was refused:', typeof text === 'string' ? text.slice(0, 40) : typeof text)
    void browser.copyCalcResult(text).catch((error: unknown) => console.error('[calc] cannot copy the result:', error))
  })

  // The theme editor's code fields: a request that is not exactly one of the five kinds is refused with a sentence, never acted on.
  ipcMain.handle(Channel.themeCode, async (e, raw: unknown) => {
    if (!guard(e.sender, Channel.themeCode)) return { ok: false, message: t('feature.demande-refusee') }
    const request = parseThemeRequest(raw)
    if (!request) return { ok: false, message: t('feature.demande-invalide') }
    if (request.kind === 'export-file' || request.kind === 'import-file') return answering(() => runThemeFileRequest(shareEnvironment(browser, store, ownerOf(e.sender)), request), (message) => browser.showToast(message))
    return runThemeRequest(themeEnvironment(browser, store), request)
  })

  // The buttons that share a Tweak: a request that is not exactly one of the four kinds is refused with a sentence. The interface never sends
  // the text to read or a path: the shell asks for the file in a dialog and reads the clipboard itself.
  ipcMain.handle(Channel.boostShare, async (e, raw: unknown): Promise<ShareReply> => {
    if (!guard(e.sender, Channel.boostShare)) return { ok: false, message: t('feature.demande-refusee') }
    const request = parseBoostShareRequest(raw)
    if (!request) return { ok: false, message: t('feature.demande-invalide') }
    return answering(() => runBoostShareRequest(shareEnvironment(browser, store, ownerOf(e.sender)), request), (message) => browser.showToast(message))
  })

  // "Lancer l’aperçu" of the Tweak editor: the interface names the Tweak, never the code. The shell reads the script in the state and runs it
  // in the page shown; anything that is not the id of a Tweak is refused with a sentence.
  ipcMain.handle(Channel.boostPreview, (e, id: unknown): ScriptPreviewReply => {
    if (!guard(e.sender, Channel.boostPreview)) return { ok: false, message: t('feature.demande-refusee') }
    if (typeof id !== 'string' || !BOOST_ID.test(id)) return { ok: false, message: t('feature.demande-invalide') }
    return browser.previewBoostScript(id)
  })

  // The bookmark library's file of bookmarks: the dialogs are the main process', the interface names no path. A request that is not exactly
  // "import" or "export" is refused with a sentence; the setting and the private window are checked again where the file is handled.
  ipcMain.handle(Channel.bookmarksTransfer, async (e, raw: unknown) => {
    if (!guard(e.sender, Channel.bookmarksTransfer)) return { ok: false, message: t('feature.demande-refusee') }
    const request = parseBookmarksTransferRequest(raw)
    if (!request) return { ok: false, message: t('feature.demande-invalide') }
    return transferBookmarks({ win: ownerOf(e.sender), state: store.get(), isPrivate: browser.isPrivate(), dispatch: (action) => browser.dispatch(action) }, request)
  })

  // "Ouvrir comme application" from the command bar: the bar goes first, so that the window of the site has the keyboard.
  ipcMain.on(Channel.openAsApp, (e) => {
    if (!guard(e.sender, Channel.openAsApp)) return
    browser.closeOverlay()
    browser.openAsApp()
  })

  // The command bar's "Exporter la page en Markdown": the bar goes first, so that the page has the keyboard when its picker opens.
  ipcMain.on(Channel.markdownExport, (e) => {
    if (!guard(e.sender, Channel.markdownExport)) return
    browser.closeOverlay()
    void browser.exportMarkdown().catch((error: unknown) => console.error('[markdown] cannot export the page:', error))
  })

  // The automatic copies of the session: the files belong to the normal windows' state, so a private window lists none and restores none.
  ipcMain.handle(Channel.sessionBackups, (e) => (guard(e.sender, Channel.sessionBackups) && !browser.isPrivate() ? (getSessionBackups()?.list() ?? NO_BACKUPS) : NO_BACKUPS))

  ipcMain.handle(Channel.restoreBackup, (e, id: unknown) => {
    const service = getSessionBackups()
    if (!guard(e.sender, Channel.restoreBackup) || browser.isPrivate() || !service) return { ok: false, message: t('feature.les-copies-ne-sont-pas-disponibles-ici') }
    return service.restore(id)
  })

  ipcMain.handle(Channel.backUpNow, (e) => {
    const service = getSessionBackups()
    if (!guard(e.sender, Channel.backUpNow) || browser.isPrivate() || !service) return { ok: false, message: t('feature.les-copies-ne-sont-pas-disponibles-ici') }
    const outcome = service.backUp('manual')
    if (!outcome.ok) return { ok: false, message: t('feature.la-copie-n-a-pas-pu-etre-enregistree-reason', { reason: outcome.reason }) }
    return outcome.id ? { ok: true, message: t('feature.copie-enregistree') } : { ok: false, message: t('feature.aucun-onglet-a-copier') }
  })

  ipcMain.on(Channel.asideSpace, (e) => {
    if (!guard(e.sender, Channel.asideSpace) || browser.isPrivate()) return
    // The bar that asked is closed first: the question must not sit under it.
    browser.closeOverlay()
    asideSpace(browser, store, BrowserWindow.fromWebContents(e.sender) ?? undefined, store.get().activeSpaceId)
  })

  // The picture of a space: the request names a space or a stored picture, never a path; the file is the one the user picks in a dialog of ours.
  ipcMain.handle(Channel.spaceImage, async (e, raw: unknown) => {
    if (!guard(e.sender, Channel.spaceImage)) return { ok: false, message: t('feature.demande-refusee') }
    const request = parseSpaceImageRequest(raw)
    if (!request) return { ok: false, message: t('feature.demande-invalide') }
    return runSpaceImageRequest(spaceImages(), {
      spaces: () => store.get().spaces,
      tabs: () => store.get().tabs,
      dispatch: (action) => browser.dispatch(action),
      chooseFile: (target) => chooseImageFile(BrowserWindow.fromWebContents(e.sender) ?? undefined, target),
      sweep: () => void sweepSpaceImages(store.get()),
      isPrivate: () => browser.isPrivate(),
      lockedSpaces: () => getLockService()?.lockedSpaces() ?? []
    }, request)
  })

  // Background media for spaces: upload, delete, or read image/GIF/video backgrounds
  ipcMain.handle(Channel.spaceBackgroundMedia, async (e, raw: unknown) => {
    if (!guard(e.sender, Channel.spaceBackgroundMedia)) return { ok: false, message: t('feature.demande-refusee') }
    const request = parseSpaceBackgroundMediaRequest(raw)
    if (!request) return { ok: false, message: t('feature.demande-invalide') }
    // A private window keeps nothing on disk: its spaces get no picture or video file.
    if (request.op === 'upload' && browser.isPrivate()) return { ok: false, message: t('space-media.pas-en-prive') }
    return runSpaceBackgroundMediaRequest({
      state: () => store.get(),
      userDataPath: app.getPath('userData'),
      builtinDir: builtinBackgroundsDir(),
      lockedSpaces: () => getLockService()?.lockedSpaces() ?? []
    }, request)
  })

  // Web panels: a request that is not "open this site of the list" or "add the page on screen" does nothing.
  ipcMain.on(Channel.webPanel, (e, raw: unknown) => {
    if (!guard(e.sender, Channel.webPanel)) return
    const request = parseWebPanelRequest(raw)
    if (!request) return console.warn('[ipc] a web panel request that makes no sense was ignored')
    // The command bar that asked is closed first: the panel opens beside the page, not under a dimmed layer.
    browser.closeOverlay()
    browser.webPanelRequest(request)
  })

  ipcMain.handle(Channel.findReplace, async (e, raw: unknown) => {
    if (!guard(e.sender, Channel.findReplace)) return ''
    const request = parseReplaceRequest(raw)
    return request ? browser.replaceInPage(request) : t('feature.rien-a-remplacer')
  })

  // The user-script manager. The picture of a script (its code, its patterns) is read from its text each time; nothing is kept in the page.
  ipcMain.handle(Channel.userScripts, async (e, raw: unknown): Promise<UserScriptReply> => {
    if (!guard(e.sender, Channel.userScripts)) return { ok: false, message: t('feature.demande-refusee'), scripts: [] }
    // The manager is switched off: its file stays closed whatever is asked (the panel asks only while it is on; the setting is read at each request).
    if (!store.get().settings.userScripts) return { ok: false, message: t('userscripts-service.les-scripts-utilisateur-sont-desactives'), scripts: [] }
    const request = parseUserScriptRequest(raw)
    const scripts = userScripts()
    if (!request) return { ok: false, message: t('feature.demande-invalide'), scripts: scripts.list() }
    const owner = BrowserWindow.fromWebContents(e.sender)
    return handleUserScriptRequest(request, {
      scripts,
      isPrivate: browser.isPrivate(),
      pickFile: async () => {
        const chosen = await (owner ? dialog.showOpenDialog(owner, SCRIPT_DIALOG) : dialog.showOpenDialog(SCRIPT_DIALOG))
        const path = chosen.filePaths[0]
        if (chosen.canceled || !path) return null
        try {
          const text = readScriptFile(path)
          return text === null ? { error: scriptFileTooBig() } : { fileName: path.split('/').pop() ?? path, text }
        } catch (error) {
          console.error(`[userscripts] cannot read ${path}:`, error)
          return { error: t('feature.lecture-du-fichier-impossible', { detail: (error as Error).message ?? String(error) }) }
        }
      }
    })
  })
}

/** The folder of the videos Lucium comes with: in the application's resources, or in the project while it is developed (as app-icon.ts finds its icons). */
function builtinBackgroundsDir(): string {
  return join(isBuiltApp() ? process.resourcesPath : app.getAppPath(), isBuiltApp() ? 'backgrounds' : 'resources/backgrounds')
}

const SCRIPT_DIALOG = { get title() { return t('feature.importer-un-script-utilisateur') }, properties: ['openFile'] as Array<'openFile'>, get filters() { return [{ name: t('feature.scripts-utilisateur'), extensions: ['js'] }] } }
