import { isSiteAddress } from '@shared/site-search'
import { isOllamaAddress, listOllamaModels, testOllamaConnection } from '@shared/ollama'
import { writeFileSync } from 'node:fs'
import { BrowserWindow, clipboard, dialog, ipcMain as electronIpc, net, ShareMenu, type WebContents } from 'electron'
import {
  Channel,
  type CommandBarMode,
  type DownloadCommand,
  type MenuTarget,
  type NavCommand,
  COMMAND_BAR_MODES,
  isSettingsAnchor,
  SETTINGS_PANES,
  SPACE_EDITOR_FOCUS,
  PEEK_ACTIONS,
  type PeekAction,
  type OverlayRequest,
  type ExportReply
} from '@shared/ipc'
import { credentialsOf } from '@shared/http-auth'
import { parseBookmarksExportRequest } from '@shared/bookmarks-html'
import { PROMPT_CANCELLED, parsePromptAnswer } from '@shared/page-dialog'
import { OPEN_WHILE_LOCKED, hiddenIds } from '@shared/lock'
import { DownloadFolders, interfaceMayDispatch } from '@shared/ipc-policy'
import { isPlusAnchor } from '@shared/plus-menu'
import { isSplitDropZone } from '@shared/split-drop'
import { parseCycleKey } from '@shared/tab-cycle'
import { parseKeyLayout } from '@shared/keybindings'
import { setKeyboardLayout } from './keyboard-layout'
import { activeProfileId, isProfileId, profileSearch } from '@shared/profiles'
import { typedStaysPrivate } from '@shared/command-bar'
import { parsePurgeRequest } from '@shared/profile-purge'
import { isExtensionId } from '@shared/extension-review'
import { cleanExtensionsTarget } from '@shared/extension-page'
import { mayKillProcess, processRows, withoutHiddenTitles } from '@shared/processes'
import { tabName } from '@shared/model'
import { parseSiteDataBatchRequest, parseSiteHost } from '@shared/site-data'
import { persistableState, type Action } from '@shared/sidebar'
import { FIND_TEXT_MAX, parseFindOptions } from '@shared/regex-find'
import { fetchSuggestions } from '../suggestions'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { ollamaFetch } from './ollama-fetch'
import { appIconIssue } from './app-icon'
import { exportBookmarks } from './bookmarks-export'
import { captureFromLayer, captureSelectionOrTell } from './capture'
import { releaseIpcScope, scopedIpc } from './ipc-scope'
import { registerInternalPageIpc } from './internal-page-ipc'
import { registerFeatureIpc } from './feature-ipc'
import { registerAnnotateIpc } from './annotate-ipc'
import { processMeter } from './process-meter'
import { registerResourceIpc } from './resource-ipc'
import { registerLockIpc } from './lock-ipc'
import { registerSyncIpc } from './sync-ipc'
import { registerPasswordIpc } from './password-ipc'
import { getLockService } from '../lock-service'
import { ExportCryptoError, PASSPHRASE_MAX, exportErrorMessage } from '../export-crypto'
import { exportText, parseExportRequest } from '../export-file'
import { registerPrivacyIpc } from './privacy-ipc'
import { registerHardwareIpc } from './hardware-ipc'
import { registerClipboardIpc } from './clipboard-ipc'
import { registerUsageIpc } from './usage-ipc'
import { registerKeyExtIpc } from './key-ext-ipc'
import { registerAboutIpc } from './about'
import { registerScreensIpc } from './screens-ipc'
import { problemReportEnv, registerProblemReportIpc } from './problem-report'
import { registerExtensionsIpc } from './extensions-ipc'
import { ExtensionsService } from './extensions-service'
import { extensionsEnv } from './extensions-env'
import { moveTabsToSpace, showMenu } from './context-menus'
import { toggleReadableSite } from './page-commands'
import { notifyAnnotateRequest } from './page-annotate'
import { FeatureGates } from './feature-gate'
import { noteFailure } from './failure-notice'
import { Thumbnails, gateThumbnails } from './thumbnails'
import { rendererHosts } from './renderer-hosts'
import { t, tp } from '@shared/i18n'
import { LOCAL_FILES_MAX, localFileUrls } from '@shared/local-documents'
import { DROPPED_LINKS_MAX, droppedLinkUrls } from '@shared/dropped-links'
import { isHistoryDay } from '@shared/history-days'
import { HISTORY_URL_MAX } from '@shared/state-clean'
import type { DefaultBrowserOutcome } from '@shared/default-browser'
import { isDefaultBrowser, makeDefaultBrowser } from './default-browser'
import { systemDefaultBrowserPorts } from './default-browser-ports'
import { tabCloseAction } from '@shared/tab-close'
import { settingsPath } from '@shared/settings-path'

const HISTORY_LIMIT_MAX = 500
/** The QR panel says by itself when a text is too long for a code; this only bounds what crosses the channel. */
const QR_TEXT_MAX = 4096
/** A multiple selection or drag can hold many tabs, not an unbounded list. */
const TAB_IDS_MAX = 1000
const NAV_COMMANDS = new Set<NavCommand>(['back', 'forward', 'reload', 'stop'])
const DOWNLOAD_COMMANDS = new Set<DownloadCommand>(['open', 'reveal', 'cancel', 'clear', 'pause', 'resume', 'open-with'])
const MENU_KINDS = new Set<MenuTarget['kind']>(['tab', 'space', 'folder', 'download', 'split', 'nav', 'favorite', 'workview', 'extensions', 'readable'])

/** Panels the renderer may open. `permission` is main-only: a page must never be able to forge a prompt. */
export function validOverlay(request: unknown, store: Pick<StateStore, 'get'>): request is OverlayRequest {
  const r = request as Partial<OverlayRequest> | null
  switch (r?.panel) {
    case 'commandbar':
      // The "Onglets" mode is the function `tabSearch`: with it off the request is refused, as the menu entry and its shortcut are dead.
      return (COMMAND_BAR_MODES as readonly unknown[]).includes(r.mode) && typeof r.initial === 'string' && (r.mode !== 'tabs' || store.get().settings.tabSearch)
    // The sheet of the shortcuts is the function `shortcutHelp`.
    case 'shortcuts':
      return store.get().settings.shortcutHelp
    // The notes panel is the function `notes`: with it off the request is refused, as the menu entry and its shortcut are. `compose` is true or absent;
    // `scope` is 'all' or absent (the one choice of the list a request may force: the others depend on the page on screen).
    case 'notes':
      return store.get().settings.notes && (r.compose === undefined || r.compose === true) && (r.scope === undefined || r.scope === 'all')
    case 'settings':
      return (r.pane === undefined || (SETTINGS_PANES as readonly unknown[]).includes(r.pane)) && (r.anchor === undefined || isSettingsAnchor(r.anchor))
    // The Extensions page: the target is the list, one extension's page or the shortcuts (an id that is not one gives the list).
    case 'extensions':
      return r.target === undefined || cleanExtensionsTarget(r.target) !== null
    case 'find':
    case 'findreplace':
    case 'import':
    case 'downloads':
    case 'archive':
    case 'history':
    case 'spaces':
    case 'capture':
    case 'sitedata':
    case 'readlater':
    case 'spacecreate':
    // Recent notices: the list is the window's own, filled in by the main process whatever the request carries.
    case 'notices':
      return true
    // "Créer un raccourci pour ce site": the address must be a web address the shortcut can open (https), the title is shown as the name.
    case 'shortcut':
      return isSiteAddress(r.url) && typeof r.title === 'string' && r.title.length <= 200
    // The view can be switched off in the settings; a private window has no profile to list the cookies of (see canOpenInPrivate).
    case 'cookies':
      return store.get().settings.cookieManager
    case 'sessions':
      return (r.focus === undefined || r.focus === 'save') && (r.tabIds === undefined || (Array.isArray(r.tabIds) && r.tabIds.length <= TAB_IDS_MAX && r.tabIds.every((id) => typeof id === 'string')))
    // The strip of the split pane it hangs from, when it was opened from one.
    case 'site':
      return r.anchor === undefined || isPlusAnchor(r.anchor)
    case 'plus':
      return isPlusAnchor(r.anchor)
    case 'spacemenu':
      return typeof r.spaceId === 'string' && store.get().spaces.some((s) => s.id === r.spaceId) && isPlusAnchor(r.anchor)
    // The proposal is worked out in the panel from the state it is shown; the request only names the space it is for.
    case 'tidy':
      return typeof r.spaceId === 'string' && store.get().spaces.some((s) => s.id === r.spaceId)
    case 'space':
      return typeof r.spaceId === 'string' && store.get().spaces.some((s) => s.id === r.spaceId) && (r.focus === undefined || (SPACE_EDITOR_FOCUS as readonly unknown[]).includes(r.focus))
    case 'favorite':
      return typeof r.favoriteId === 'string' && store.get().favorites.some((f) => f.id === r.favoriteId) && (r.anchor === undefined || isPlusAnchor(r.anchor))
    // The function off, no sheet; one that names a split view or a view names one that exists, and never both (a private window is refused: canOpenInPrivate).
    case 'workview':
      return (
        store.get().settings.workViewsEnabled &&
        !(r.splitId !== undefined && r.viewId !== undefined) &&
        (r.splitId === undefined || (typeof r.splitId === 'string' && store.get().splits.some((split) => split.id === r.splitId))) &&
        (r.viewId === undefined || (typeof r.viewId === 'string' && store.get().workViews.some((view) => view.id === r.viewId))) &&
        (r.full === undefined || r.full === true) &&
        (r.anchor === undefined || isPlusAnchor(r.anchor))
      )
    case 'tab':
      return typeof r.tabId === 'string' && store.get().tabs.some((t) => t.id === r.tabId) && (r.focus === undefined || r.focus === 'name' || r.focus === 'icon') && (r.anchor === undefined || isPlusAnchor(r.anchor))
    case 'windowname':
      return store.get().settings.nameWindows && (r.anchor === undefined || isPlusAnchor(r.anchor))
    // The library functions can be switched off in the settings; a private window keeps no bookmark and no folder (see canOpenInPrivate).
    case 'bookmarks':
      return store.get().settings.bookmarkManager
    case 'livefolder':
      return store.get().settings.liveFolders && (r.folderId === undefined || (typeof r.folderId === 'string' && store.get().folders.some((f) => f.id === r.folderId && f.live !== undefined)))
    // One folder that exists (a private window keeps no folder, see canOpenInPrivate).
    case 'foldericon':
      return typeof r.folderId === 'string' && store.get().folders.some((f) => f.id === r.folderId)
    case 'autoreload':
      return typeof r.tabId === 'string' && store.get().tabs.some((t) => t.id === r.tabId) && (r.anchor === undefined || isPlusAnchor(r.anchor))
    case 'theme':
      return typeof r.spaceId === 'string' && store.get().spaces.some((s) => s.id === r.spaceId) && (r.from === undefined || r.from === 'space')
    case 'boost':
      return typeof r.host === 'string' && r.host.length > 0 && r.host.length < 254 && (r.id === undefined || typeof r.id === 'string')
    // Local page translation: the panel exists only while the function is on (a private window may open it: it translates with the packs it has and writes nothing).
    case 'translate':
      return store.get().settings.translateLocal
    // Its popover, hung from the toolbar button: the same rule, and the place of the button.
    case 'translatepop':
      return store.get().settings.translateLocal && isPlusAnchor(r.anchor)
    case 'qr':
      return typeof r.text === 'string' && r.text.length > 0 && r.text.length <= QR_TEXT_MAX && store.get().settings.qrCode
    // Off by default; never in a private window (see canOpenInPrivate).
    case 'passwords':
      return store.get().settings.passwordManager
    default:
      return false
  }
}

/** Registers IPC handlers. Only the UI surfaces we own may call them. Returns what lets go of what the window holds on the shared state once it is closed. */
export function registerIpc(browser: Browser, store: StateStore, win: BrowserWindow, trustedIds: Set<number>): () => void {
  // Called once per window group (the main window, each private window): a message goes to the registration of the window that sent it.
  const ipcMain = scopedIpc(electronIpc, trustedIds)
  const guard = (sender: WebContents, channel: string): boolean => {
    if (trustedIds.has(sender.id)) {
      // The application is locked: the interface may read the (skeleton) snapshot and unlock, and nothing else.
      return !getLockService()?.isAppLocked() || OPEN_WHILE_LOCKED.has(channel)
    }
    console.warn(`[ipc] ignored ${channel} from untrusted sender ${sender.getURL().split('?')[0]}`)
    return false
  }
  const on = <A extends unknown[]>(channel: string, handler: (...args: A) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (guard(e.sender, channel)) handler(...(args as A))
    })

  ipcMain.handle(Channel.getSnapshot, (e) => (guard(e.sender, Channel.getSnapshot) ? browser.snapshot() : null))

  // The download folders the user picked in the folder box (`chooseFolder`, below), and the ones the profiles already have.
  const downloadFolders = new DownloadFolders()
  // What the interface sends is `unknown` until it is checked: the type of an action is a promise only the main process' own code keeps.
  ipcMain.handle(Channel.dispatch, (e, action: unknown) => {
    if (!guard(e.sender, Channel.dispatch)) return
    downloadFolders.noteProfiles(store.get().settings.profiles)
    if (!interfaceMayDispatch(action, store.get().settings.extensionPaths, store.get().settings.openWithApps, downloadFolders)) {
      console.warn('[ipc] an action the interface may not dispatch was refused:', typeof action === 'object' && action !== null ? String((action as { type?: unknown }).type).slice(0, 64) : typeof action)
      return
    }
    browser.dispatchFromInterface(action as Action)
  })

  // `profileId` (optional): the profile the history panel listed, so that what it asks never lands on the profile of another space (see Browser.forgetHistory).
  ipcMain.handle(Channel.searchHistory, (e, query: unknown, limit?: unknown, profileId?: unknown) =>
    guard(e.sender, Channel.searchHistory) && typeof query === 'string'
      ? browser.searchHistory(query, typeof limit === 'number' && Number.isInteger(limit) ? Math.min(Math.max(limit, 1), HISTORY_LIMIT_MAX) : undefined, typeof profileId === 'string' ? profileId : undefined)
      : []
  )
  ipcMain.handle(Channel.forgetHistory, (e, url: unknown, profileId?: unknown, undoable?: unknown) => {
    if (guard(e.sender, Channel.forgetHistory) && typeof url === 'string') browser.forgetHistory(url, typeof profileId === 'string' ? profileId : undefined, undoable === true)
  })
  // « Annuler » after a page was forgotten: the address of a web page and the id of a profile, nothing else. The page itself (its title, its visits)
  // is the one the history kept aside: a message cannot write an entry of its own making.
  ipcMain.handle(Channel.putBackHistory, (e, url: unknown, profileId: unknown) => {
    if (!guard(e.sender, Channel.putBackHistory)) return false
    if (typeof url !== 'string' || url.length > HISTORY_URL_MAX || !/^https?:\/\//i.test(url) || !isProfileId(profileId)) {
      console.warn('[ipc] a request to put a page back in the history was refused: it names no web address, or no profile')
      return false
    }
    return browser.putBackHistory(url, profileId)
  })
  // « Oublier ce jour »: the bounds of one day, never a wider span (a message that names a year would empty the history), in a named profile.
  ipcMain.handle(Channel.forgetHistoryDay, (e, from: unknown, to: unknown, profileId: unknown) => {
    if (!guard(e.sender, Channel.forgetHistoryDay)) return 0
    if (typeof from !== 'number' || typeof to !== 'number' || !isHistoryDay(from, to) || typeof profileId !== 'string') {
      console.warn('[ipc] a request to forget a day of the history was refused: its bounds are not those of one day, or it names no profile')
      return 0
    }
    return browser.forgetHistoryDay(from, to, profileId)
  })

  ipcMain.handle(Channel.loadExtension, async (e) => {
    if (!guard(e.sender, Channel.loadExtension)) return
    await loadExtensionFromDialog(browser, store, win)
  })

  ipcMain.handle(Channel.defaultBrowser, async (e) => guard(e.sender, Channel.defaultBrowser) && (await isDefaultBrowser(systemDefaultBrowserPorts())))
  ipcMain.handle(Channel.setDefaultBrowser, async (e): Promise<DefaultBrowserOutcome> => (guard(e.sender, Channel.setDefaultBrowser) ? makeDefaultBrowser(systemDefaultBrowserPorts()) : 'failed'))
  ipcMain.handle(Channel.appIconIssue, (e) => (guard(e.sender, Channel.appIconIssue) ? appIconIssue() : null))
  ipcMain.handle(Channel.clearProfile, async (e, profileId: unknown) => {
    if (guard(e.sender, Channel.clearProfile) && typeof profileId === 'string') await browser.clearProfile(profileId)
  })
  ipcMain.handle(Channel.deleteProfile, async (e, profileId: unknown) => {
    if (guard(e.sender, Channel.deleteProfile) && typeof profileId === 'string') await browser.deleteProfile(profileId)
  })
  ipcMain.handle(Channel.chooseFolder, async (e) => {
    if (!guard(e.sender, Channel.chooseFolder)) return null
    const owner = BrowserWindow.fromWebContents(e.sender) ?? win
    const picked = await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'], title: t('ipc.choisir-un-dossier') })
    const folder = picked.canceled ? null : (picked.filePaths[0] ?? null)
    downloadFolders.note(folder)
    return folder
  })
  ipcMain.handle(Channel.exportData, async (e, raw: unknown): Promise<ExportReply> => {
    if (!guard(e.sender, Channel.exportData)) return null
    const request = parseExportRequest(raw)
    if (!request.ok) return { ok: false, message: request.message }
    // The file holds every space: while one is locked, its tabs would leave in it in the clear.
    if ((getLockService()?.lockedSpaces().length ?? 0) > 0) return { ok: false, message: t('ipc.deverrouillez-vos-espaces-avant-d-exporter') }
    // An empty passphrase is the plain export of before.
    const passphrase = request.passphrase === null || request.passphrase === '' ? null : request.passphrase
    const owner = BrowserWindow.fromWebContents(e.sender) ?? win
    const saved = await dialog.showSaveDialog(owner, {
      title: t('ipc.exporter-les-donnees'),
      defaultPath: passphrase === null ? 'lucium-donnees.json' : 'lucium-donnees-chiffrees.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (saved.canceled || !saved.filePath) return null
    try {
      // The state of every window: with windows of their own, this window's view lists its tabs only, and the file is what a restore reads back.
      const { text, encrypted } = await exportText(persistableState(store.root().get()), passphrase)
      // Only the user reads a file that holds a whole browsing session.
      writeFileSync(saved.filePath, text, { mode: 0o600 })
      return { ok: true, path: saved.filePath, encrypted }
    } catch (error) {
      // The message is the cause, never the request: the passphrase is not in any line this logs.
      console.error('[export] the data could not be exported:', error instanceof ExportCryptoError ? error.kind : error instanceof Error ? error.name : typeof error)
      return { ok: false, message: error instanceof ExportCryptoError ? exportErrorMessage(error) : t('ipc.exportation-echouee', { detail: String((error as Error).message ?? error) }) }
    }
  })
  on<[string, unknown]>(Channel.answerPassphrase, (id, passphrase) => {
    // The passphrase goes to the question that asked for it (the restore of an encrypted export) and nowhere else.
    if (typeof id === 'string' && (passphrase === null || (typeof passphrase === 'string' && passphrase.length <= PASSPHRASE_MAX))) browser.answerPassphrase(id, passphrase)
  })
  ipcMain.handle(Channel.exportBookmarks, async (e, raw: unknown) => {
    if (!guard(e.sender, Channel.exportBookmarks)) return { path: null, message: t('feature.demande-refusee') }
    const options = parseBookmarksExportRequest(raw)
    if (!options) return { path: null, message: t('ipc.demande-d-export-invalide') }
    // The state of every window, as « Exporter les données… »: with windows of their own, this window's view lists its own Today tabs only.
    return exportBookmarks({ win: BrowserWindow.fromWebContents(e.sender) ?? win, state: store.root().get(), isPrivate: browser.isPrivate(), lockedSpaces: getLockService()?.lockedSpaces() ?? [] }, options)
  })
  // Erasing a profile cannot be undone: the interface lists the unused ones, asks, and only then sends the ids the user agreed to.
  ipcMain.handle(Channel.unusedProfiles, (e) => (guard(e.sender, Channel.unusedProfiles) ? browser.unusedProfileIds() : []))
  ipcMain.handle(Channel.purgeProfiles, (e, profileIds: unknown) => {
    if (!guard(e.sender, Channel.purgeProfiles)) return 0
    // A request that is not a plain list of profile names erases nothing.
    const requested = parsePurgeRequest(profileIds)
    return requested === null ? 0 : browser.purgeUnusedProfiles(requested)
  })

  on<[NavCommand]>(Channel.nav, (command) => {
    if (NAV_COMMANDS.has(command)) browser.nav(command)
  })

  on<[unknown]>(Channel.openOverlay, (request) => {
    if (validOverlay(request, store)) browser.openOverlay(request)
  })

  on<[]>(Channel.closeOverlay, () => browser.closeOverlay())

  on<[string, CommandBarMode, boolean | undefined]>(Channel.submitUrl, (url, mode, instant) => {
    if (typeof url === 'string') browser.submitUrl(url, (COMMAND_BAR_MODES as readonly unknown[]).includes(mode) ? mode : 'new', instant === true)
  })

  on<[string, unknown]>(Channel.find, (text, options) => {
    if (typeof text === 'string') browser.findInPage(text.slice(0, FIND_TEXT_MAX), parseFindOptions(options))
  })

  on<[MenuTarget]>(Channel.showMenu, (target) => {
    // The menu of a tab, folder or split view a lock hides would copy its address and act on it: it is not offered.
    if (MENU_KINDS.has(target?.kind) && typeof target.id === 'string' && !browser.namesLockedTarget({ id: target.id })) showMenu(target, browser, store, win)
  })

  // The button ☰ of the toolbar (Windows: the window has no menu bar): the menu of the application, at the point the button names.
  on<[unknown]>(Channel.showAppMenu, (anchor) => {
    browser.popupAppMenu(anchor)
  })

  // The button « Contraste de la page » of the toolbar: a click on it. The tab is the interface's word, so a tab a lock hides is left alone, as for a menu.
  on<[string]>(Channel.toggleReadable, (id) => {
    if (typeof id === 'string' && !browser.namesLockedTarget({ id })) toggleReadableSite(browser, store, id)
  })

  on<[string, DownloadCommand]>(Channel.downloadAction, (id, command) => {
    if (typeof id !== 'string' || !DOWNLOAD_COMMANDS.has(command)) return
    const path = browser.downloadPath(id)
    if (command === 'cancel') browser.cancelDownload(id)
    else if (command === 'clear') browser.clearDownload(id)
    else if (command === 'pause') browser.pauseDownload(id)
    else if (command === 'resume') browser.resumeDownload(id)
    else if (path && command === 'reveal') browser.revealDownload(id)
    else if (path && command === 'open') void browser.openDownload(id).catch((error: unknown) => console.error(`[downloads] cannot open ${path}:`, error))
    else if (path && command === 'open-with') void browser.openDownloadWith(id).catch((error: unknown) => console.error(`[downloads] cannot open ${path} with an application:`, error))
  })

  on<[unknown]>(Channel.chooseOpenWith, (type) => {
    void browser.chooseOpenWithApplication(type).catch((error: unknown) => console.error('[downloads] cannot choose an application:', error))
  })

  on<[string, boolean, boolean]>(Channel.answerPermission, (id, allow, remember) => {
    if (typeof id === 'string') browser.answerPermissionFromPanel(id, allow === true, remember === true)
  })

  // The credentials stay in this handler's arguments: they are never logged, stored or put in the state.
  on<[string, unknown]>(Channel.answerAuth, (id, credentials) => {
    if (typeof id === 'string') browser.answerAuth(id, credentialsOf(credentials))
  })

  // The sheet of an extension (install or update from the Web Store): the answer of the window that shows it; any other id does nothing.
  on<[unknown, unknown]>(Channel.answerExtensionReview, (id, allow) => {
    if (typeof id === 'string' && typeof allow === 'boolean') browser.answerExtensionReview(id, allow)
  })

  // Files dropped on a window open in tabs of the main window. The interface sends paths and is not trusted: they are read again here, a type a tab
  // would download is refused, and the user is told when something was left out (the drop would otherwise do nothing, and look broken).
  on<[unknown]>(Channel.openLocalFiles, (paths) => {
    const { urls, refused } = localFileUrls(paths)
    urls.forEach((url, i) => browser.dispatch({ type: 'tab/open', url, background: i > 0, ...(browser.isPrivate() ? { private: true } : {}) }))
    if (refused > 0) browser.showToast(t('ipc.fichiers-non-ouverts', { max: LOCAL_FILES_MAX }))
  })

  // A link another application dropped on a window opens in new tabs of the window, in the space on show and with no opener (so no referrer): the way a link
  // from another application opens. The interface only sends the text of the drop, which is read again here: it is a text, at most 16 KB, and every address in it
  // is a web address with no name or password (shared/dropped-links.ts). Whatever is left out is counted, and the user is told.
  on<[unknown]>(Channel.openDroppedLinks, (text) => {
    const { urls, refused } = droppedLinkUrls(text)
    urls.forEach((url, i) => browser.dispatch({ type: 'tab/open', url, background: i > 0, ...(browser.isPrivate() ? { private: true } : {}) }))
    if (refused > 0) browser.showToast(tp('ipc.liens-deposes-non-ouverts', refused, { max: DROPPED_LINKS_MAX }))
  })

  on(Channel.openWebStore, () => {
    browser.openWebStore()
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  // Uninstalling and looking for updates are run by the main window's browser, which asks the user to confirm and tells how it went.
  on<[unknown, unknown]>(Channel.extensionUninstall, (profileId, extensionId) => {
    if (browser.isPrivate() || !isProfileId(profileId) || !isExtensionId(extensionId)) return
    void browser.extensionControl?.uninstall(profileId, extensionId)
  })
  on<[unknown]>(Channel.extensionUpdates, (target) => {
    if (browser.isPrivate()) return
    if (target === undefined || target === null) return void browser.extensionControl?.checkUpdates()
    const { profileId, extensionId } = (typeof target === 'object' ? target : {}) as { profileId?: unknown; extensionId?: unknown }
    if (isProfileId(profileId) && isExtensionId(extensionId)) void browser.extensionControl?.reviewUpdate(profileId, extensionId)
  })

  // The value typed in the box of a page's prompt() stays in this handler's arguments: it goes to the page, and is never logged or stored.
  on<[string, unknown]>(Channel.answerDialog, (id, answer) => {
    if (typeof id !== 'string') return
    const parsed = parsePromptAnswer(answer)
    // An answer that is not one is a cancel, not a box left open: the page is waiting for it.
    if (!parsed) console.warn('[dialog] the interface sent an answer that is not one; the box is cancelled')
    browser.answerDialog(id, parsed ?? PROMPT_CANCELLED)
  })

  on<[boolean]>(Channel.hotEdge, (inside) => browser.hotEdge(inside === true))

  // The pictures of the hover cards are taken (two shots per page shown, kept in memory) only while the cards are on.
  const gates = new FeatureGates(store)
  const thumbnails = gateThumbnails(gates, () => new Thumbnails(browser, store))
  // The panel of ⌃Tab shows the same pictures as the hover card (none while the cards are switched off). A picture of a page of a locked space is a
  // picture of what the lock hides: `Thumbnails.get` gives none, for the card as for the panel.
  browser.setThumbnailSource({ get: (tabId) => thumbnails.current()?.get(tabId) ?? null, forgetLocked: () => thumbnails.current()?.forgetLocked() })
  ipcMain.handle(Channel.tabThumbnail, (e, tabId: unknown) => (guard(e.sender, Channel.tabThumbnail) && typeof tabId === 'string' ? (thumbnails.current()?.get(tabId) ?? null) : null))

  ipcMain.handle(Channel.blockedCount, (e, tabId: unknown) => (guard(e.sender, Channel.blockedCount) && typeof tabId === 'string' ? browser.blockedCount(tabId) : 0))
  ipcMain.handle(Channel.sessionBlockedCount, (e) => (guard(e.sender, Channel.sessionBlockedCount) ? browser.sessionBlockedCount() : 0))
  // The address is checked first: the request is made here, by the main process, and only to an address of this Mac or to a private one of the
  // local network (the rule of the summary, isOllamaAddress). Any other host is asked nothing, not even its list of models.
  ipcMain.handle(Channel.ollamaTest, (e, url: unknown) => {
    if (!guard(e.sender, Channel.ollamaTest) || typeof url !== 'string') return { ok: false, error: 'invalid address' }
    if (!isOllamaAddress(url)) return { ok: false, error: t('summary.adresse-non-locale', { settingsPath: settingsPath('summary') }) }
    // The same way out as the summary (shell/ollama-fetch.ts), not the fetch of Node, and like it without the cookies or the HTTP credentials
    // of a session.
    return testOllamaConnection(url, ollamaFetch)
  })
  // The models of that server for the list of the settings: the same checks and the same way out, asked by a click of the AI settings only.
  ipcMain.handle(Channel.ollamaModels, (e, url: unknown) => {
    if (!guard(e.sender, Channel.ollamaModels) || typeof url !== 'string') return { ok: false, error: 'invalid address' }
    if (!isOllamaAddress(url)) return { ok: false, error: t('summary.adresse-non-locale', { settingsPath: settingsPath('summary') }) }
    return listOllamaModels(url, ollamaFetch)
  })
  ipcMain.handle(Channel.sessionBlockedByKind, (e) => (guard(e.sender, Channel.sessionBlockedByKind) ? browser.sessionBlockedByKind() : { ads: 0, banners: 0 }))
  ipcMain.handle(Channel.resetSessionBlockedCount, (e) => {
    if (guard(e.sender, Channel.resetSessionBlockedCount)) {
      browser.resetSessionBlockedCount()
      return true
    }
    return false
  })
  ipcMain.handle(Channel.updateFilterLists, async (e) => {
    if (guard(e.sender, Channel.updateFilterLists)) await browser.updateFilterLists()
  })

  on<[unknown, unknown]>(Channel.moveTabsToSpace, (ids, spaceId) => {
    // A tab the lock hides is not the interface's to move: it never saw it.
    if (Array.isArray(ids) && ids.length <= TAB_IDS_MAX && ids.every((id) => typeof id === 'string') && typeof spaceId === 'string' && !browser.namesLockedTarget({ ids })) moveTabsToSpace(browser, store, win, ids as string[], spaceId)
  })

  // Tab rows of the sidebar start or end a drag: the other windows take a drop of them (the drop names a place of the list, never the tabs).
  on<[unknown, unknown]>(Channel.tabDrag, (phase, ids) => {
    if (phase === 'start') browser.beginTabDrag(ids)
    else if (phase === 'end') browser.endTabDrag()
  })
  on<[unknown]>(Channel.dropWindowTabs, (target) => browser.dropForeignTabs(target))

  ipcMain.handle(Channel.suggest, (e, query: unknown) => {
    const state = store.get()
    const { url: searchUrlTemplate, suggestions } = profileSearch(state.settings, activeProfileId(state))
    if (!guard(e.sender, Channel.suggest) || typeof query !== 'string' || !suggestions) return []
    // What is typed in a private window, or over a private tab, goes nowhere. Decided here: the interface is not trusted to have held its question back.
    if (typedStaysPrivate(state, browser.isPrivate())) return []
    // Nothing cached and no credentials (see SUGGEST_FETCH_INIT): `net` is the application's own session.
    return fetchSuggestions(searchUrlTemplate, query, (url, init) => net.fetch(url, init))
  })

  on<[{ x: number; y: number; width: number; height: number }]>(Channel.captureRegion, (rect) => {
    const ok = [rect?.x, rect?.y, rect?.width, rect?.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    // Close the selection overlay first so the next frame is the page itself.
    browser.closeOverlay()
    if (ok && rect.width >= 4 && rect.height >= 4) {
      void captureSelectionOrTell(browser, rect, (message) => browser.showToast(message))
    }
  })

  // The toolbar's button of this window: the page annotation starts or ends here (shell/page-annotate.ts decides which window may).
  on<[]>(Channel.annotatePage, () => notifyAnnotateRequest(browser.annotationSource()))

  on<[]>(Channel.captureFullPage, () => void captureFromLayer(browser, true))

  on<[]>(Channel.captureVisible, () => void captureFromLayer(browser, false))

  ipcMain.handle(Channel.siteColor, (e) => (guard(e.sender, Channel.siteColor) ? browser.siteColor() : null))

  on<[string]>(Channel.openSidePanel, (extensionId) => {
    // Only an extension that asked for it opens its panel from a click on its icon.
    if (typeof extensionId !== 'string' || store.get().sidePanelBehavior[extensionId] !== true) return
    try {
      browser.openSidePanel(extensionId, undefined)
    } catch (error) {
      console.warn(`[side panel] ${extensionId} could not open from its icon:`, (error as Error).message)
    }
  })

  on<[string]>(Channel.activateExtension, (extensionId) => {
    // Only a loaded extension can be clicked. The overlay goes first so the popup opens on the page, not under the command bar.
    if (typeof extensionId !== 'string' || !browser.snapshot().extensions.some((e) => e.id === extensionId)) return
    browser.closeOverlay()
    void browser.activateExtension(extensionId).catch((error: unknown) => console.warn(`[extensions] ${extensionId} could not be activated:`, (error as Error).message))
  })

  // The processor in % of one core over each reader's own interval (shell/process-meter.ts): the task manager and the card of a tab each have their meter.
  const measureForTaskManager = processMeter()
  const measureForCard = processMeter()
  ipcMain.handle(Channel.listProcesses, async (e) => {
    if (!guard(e.sender, Channel.listProcesses)) return []
    const raw = measureForTaskManager()
    // A lock hides the tabs of its spaces from the interface, and this window is part of the interface: their titles stay behind it. A private tab is not named either.
    const state = store.get()
    const view = getLockService()?.view()
    const locked = view ? hiddenIds(state, view) : new Set<string>()
    const untitled = { locked, private: new Set(state.tabs.filter((t) => t.private === true).map((t) => t.id)) }
    const { pages, pageTabs, group, sleeping } = withoutHiddenTitles({ pages: browser.pageProcesses(), pageTabs: browser.pageTabs(), group: browser.rendererHosts(), sleeping: browser.sleepingTabs() }, untitled)
    // Every renderer is named after what it draws (the interface of a window, an extension, the frames of other sites of a tab, a worker…), never by an address.
    const hosts = await rendererHosts({
      group,
      pages,
      renderers: raw.filter((p) => p.type === 'Tab').map((p) => p.pid),
      tabOnOrigin: (origin) => {
        const tab = state.tabs.find((t) => t.private !== true && !locked.has(t.id) && URL.canParse(t.url) && new URL(t.url).origin === origin)
        return tab ? tabName(tab) : undefined
      }
    })
    const tabs = state.tabs
    // What "Fermer l’onglet" does is the rule of the sidebar's cross: a pinned tab is put to sleep, or leaves the pinned ones once asleep.
    const closeOf = (tabId: string, asleep: boolean) => {
      const tab = tabs.find((t) => t.id === tabId)
      return tab ? tabCloseAction(tab, asleep) : undefined
    }
    const live = processRows(raw, pages, hosts).map((row) => {
      const hit = row.kind === 'tab' ? pageTabs.get(row.pid) : undefined
      return hit ? { ...row, tabId: hit.tabId, space: hit.space, closeAction: closeOf(hit.tabId, false) } : row
    })
    // Sleeping tabs have no process: they get a negative pid of their own, no memory, and no way to be killed.
    const asleep = sleeping.map((tab, index) => ({ pid: -(index + 1), kind: 'tab' as const, name: tab.name, cpu: 0, memoryMb: 0, space: tab.space, tabId: tab.tabId, asleep: true, closeAction: closeOf(tab.tabId, true) }))
    return [...live, ...asleep]
  })
  // The card of a tab asks while it is open, a few times: the figures of the process of that tab's page, never another process's.
  ipcMain.handle(Channel.tabResources, (e, tabId: unknown) => {
    if (!guard(e.sender, Channel.tabResources)) return null
    return typeof tabId === 'string' ? browser.tabResources(tabId, measureForCard) : null
  })
  ipcMain.handle(Channel.killProcess, (e, pid: unknown) => {
    // Only the process of a tab's page can be ended from the task manager, never the browser, a service, or the renderer of an extension.
    if (!guard(e.sender, Channel.killProcess)) return
    if (mayKillProcess(pid, process.pid, browser.pageProcesses())) process.kill(pid)
  })

  on<[number, boolean?]>(Channel.toastAction, (id, second) => {
    if (Number.isInteger(id)) browser.runToastAction(id, second === true)
  })
  on<[number]>(Channel.toastDismiss, (id) => {
    if (Number.isInteger(id)) browser.dismissToastById(id)
  })
  on<[number, boolean]>(Channel.toastHold, (id, held) => {
    if (Number.isInteger(id)) browser.holdToast(id, held === true)
  })
  // "Quitter ce site ?": only an explicit true leaves the page; anything else is staying.
  on<[string, unknown]>(Channel.answerLeave, (id, leave) => {
    if (typeof id === 'string') browser.answerLeave(id, leave === true)
  })
  on<[]>(Channel.whatsNewDismiss, () => browser.dismissWhatsNew())

  on<[]>(Channel.shareSite, () => {
    const tab = browser.snapshot().state.tabs.find((t) => t.id === browser.snapshot().state.activeTabBySpace[browser.snapshot().state.activeSpaceId])
    if (tab && /^https?:/i.test(tab.url)) new ShareMenu({ urls: [tab.url] }).popup({ window: win })
  })
  on<[]>(Channel.openDevTools, () => browser.devTools('tools'))

  on<[]>(Channel.closeSidePanel, () => browser.closeSidePanel())

  on<[string, string]>(Channel.zapStart, (host, id) => {
    if (typeof host === 'string' && host.length > 0 && host.length < 254 && typeof id === 'string') void browser.startZap(host, id)
  })

  on<[]>(Channel.clearSiteData, () => {
    void browser.clearSiteData().catch((error: unknown) => console.error('[site] cannot clear site data:', error))
  })

  ipcMain.handle(Channel.siteCookieCount, (e, host: unknown, subdomains: unknown) =>
    guard(e.sender, Channel.siteCookieCount) && typeof host === 'string' && parseSiteHost(host) ? browser.siteCookieCount(host, subdomains === true) : 0
  )
  ipcMain.handle(Channel.clearSites, (e, request: unknown) => {
    if (!guard(e.sender, Channel.clearSites)) return []
    // Same distrust as for one site: any site or type that is not valid refuses the whole run, so nothing is erased on a doubt.
    const parsed = parseSiteDataBatchRequest(request)
    if (!parsed) throw new Error('Invalid site data request')
    if (!parsed.detached) return browser.clearSitesFor(parsed)
    // The panel has closed (or is about to): the run ends on its own and tells how it went.
    void browser.clearSitesInBackground(parsed).catch((error: unknown) => console.error('[site] cannot clear site data:', error))
    return []
  })
  on<[]>(Channel.clearSiteNow, () => {
    void browser.quickClearSite().catch((error: unknown) => console.error('[site] cannot clear site data:', error))
  })
  // The button of the space on screen is a button only: it reloads every tab of the space, the sleeping ones too, whatever `reloadAllWakes` says.
  on<[]>(Channel.reloadSpaceTabs, () => {
    void browser.reloadAllTabs(undefined, true, true).catch((error: unknown) => noteFailure('[reload-space] cannot reload the tabs:', error, (message) => browser.showToast(message), t('ipc.les-ongl-space')))
  })
  // The button of the sidebar says `true`: every tab, the sleeping ones too. The command bar says nothing, and the setting decides (as the menu does).
  // Only a real `true` counts: anything else the interface sends is the command.
  on<[unknown]>(Channel.reloadAllTabs, (everything) => {
    void browser.reloadAllTabs(undefined, everything === true ? true : undefined).catch((error: unknown) => noteFailure('[reload-all] cannot reload the tabs:', error, (message) => browser.showToast(message), t('ipc.les-onglets-n-ont-pas-pu-etre-actualises')))
  })

  // A tab row of the sidebar starts or ends a drag; the veil over the page answers with the zone of the drop. Anything else does nothing.
  on<[unknown, unknown]>(Channel.splitDrag, (phase, tabId) => {
    if (phase === 'start' && typeof tabId === 'string' && tabId.length > 0 && tabId.length <= 256) browser.beginSplitDrag(tabId)
    else if (phase === 'end') browser.endSplitDrag()
  })
  on<[unknown]>(Channel.splitDrop, (zone) => {
    if (isSplitDropZone(zone)) browser.dropOnPage(zone)
  })

  // The ⌃Tab panel has the keyboard while it is up: its keys come here, since the page is not told of the release of ⌃.
  on<[unknown]>(Channel.cycleKey, (raw) => {
    const key = parseCycleKey(raw)
    if (key) browser.cycleKeyFromPanel(key)
  })
  // The layout of the keyboard, read by the window: one keyboard for every window. What is not a layout changes nothing.
  on<[unknown]>(Channel.keyboardLayout, (raw) => {
    const characters = parseKeyLayout(raw)
    if (characters) setKeyboardLayout(characters)
  })

  on<[string]>(Channel.tabMute, (tabId) => {
    if (typeof tabId === 'string') browser.toggleMute(tabId)
  })
  // The mark of a floating tab in the sidebar, and the place of its page: its window comes to the front, or its video comes back to the tab.
  on<[unknown, unknown]>(Channel.floatingVideoTab, (tabId, command) => {
    if (typeof tabId === 'string' && (command === 'show' || command === 'back')) browser.floatingVideoTab(tabId, command)
  })
  // The mark of a tab an extension captures the sound of: the person stops the capture. Only a tab id is taken; the browser asks the engine what runs.
  on<[unknown]>(Channel.stopTabCapture, (tabId) => {
    if (typeof tabId === 'string' && tabId.length > 0 && tabId.length <= 256) browser.stopTabCapture(tabId)
  })
  on<[string]>(Channel.sleepTab, (tabId) => {
    if (typeof tabId === 'string') void browser.sleepNow(tabId)
  })
  on<[string]>(Channel.thawTab, (tabId) => {
    if (typeof tabId === 'string') void browser.thawTab(tabId)
  })
  on<[string, string]>(Channel.tabAddress, (tabId, input) => {
    if (typeof tabId === 'string' && typeof input === 'string') browser.setTabAddress(tabId, input.slice(0, 2048))
  })

  on<[PeekAction]>(Channel.peekAction, (action) => {
    if (PEEK_ACTIONS.includes(action)) browser.peekAction(action)
  })

  on<[string, boolean]>(Channel.setScrollSynced, (splitId, on) => {
    if (typeof splitId === 'string' && typeof on === 'boolean') browser.setScrollSynced(splitId, on)
  })

  registerFeatureIpc(ipcMain, guard, browser, store, win)
  registerAnnotateIpc(ipcMain, guard, browser, win)
  registerLockIpc(ipcMain, guard, browser)
  registerSyncIpc(ipcMain, guard, browser)
  registerPasswordIpc(ipcMain, guard, browser)
  registerPrivacyIpc(ipcMain, guard, browser, store)
  registerHardwareIpc(ipcMain, guard, browser)
  registerClipboardIpc(ipcMain, guard, clipboard)
  registerUsageIpc(ipcMain, guard, browser, store, win)
  registerKeyExtIpc(ipcMain, guard, browser, store)
  registerAboutIpc(ipcMain, guard, browser, win, store)
  registerScreensIpc(ipcMain, guard, win)
  registerProblemReportIpc(ipcMain, guard, problemReportEnv(browser, store, win))
  const releaseResources = registerResourceIpc(ipcMain, guard, browser)
  // The Extensions page: the boxes open over the window that asked (the page's own), which is the sender of the request being answered.
  let asking: WebContents | null = null
  const extensionsService = new ExtensionsService(extensionsEnv(browser, store, win, () => asking))
  registerExtensionsIpc(ipcMain, (sender, channel) => (asking = guard(sender, channel) ? sender : null) !== null, extensionsService)
  // The same page when it is a tab of this window: channels of its own, answered for the web contents of this window that show it, each message judged by the main
  // process (shell/internal-page-ipc.ts). The boxes of the service open over the window of the tab that asked.
  const internalPageSenders = { has: (id: number): boolean => (browser.internalPageTab(id) ?? null) !== null }
  registerInternalPageIpc(
    scopedIpc(electronIpc, internalPageSenders),
    {
      tabOf: (id) => browser.internalPageTab(id),
      isPrivate: () => browser.isPrivate(),
      snapshot: () => browser.snapshot(),
      appLocked: () => getLockService()?.isAppLocked() === true,
      openSettings: (pane, anchor) => browser.openOverlay({ panel: 'settings', pane, ...(anchor !== undefined ? { anchor } : {}) }),
      openWebStore: () => browser.openWebStore(),
      updates: (target) => void (target ? browser.extensionControl?.reviewUpdate(target.profileId, target.extensionId) : browser.extensionControl?.checkUpdates()),
      openFiles: (urls, refused) => {
        urls.forEach((url, i) => browser.dispatch({ type: 'tab/open', url, background: i > 0 }))
        if (refused > 0) browser.showToast(t('ipc.fichiers-non-ouverts', { max: LOCAL_FILES_MAX }))
      },
      asking: (sender) => void (asking = sender)
    },
    extensionsService
  )

  return () => {
    browser.setThumbnailSource(null)
    gates.disposeAll()
    releaseResources()
    releaseIpcScope(electronIpc, internalPageSenders)
  }
}

export async function loadExtensionFromDialog(browser: Browser, store: StateStore, win: BrowserWindow): Promise<void> {
  const picked = await dialog.showOpenDialog(win, {
    title: t('ipc.choisir-le-dossier-d-une-extension-non'),
    properties: ['openDirectory']
  })
  const [path] = picked.filePaths
  if (picked.canceled || !path) return
  let failure: unknown = null
  await browser.loadExtensions([path], (_p, error) => (failure = error))
  if (failure) {
    dialog.showErrorBox(t('ipc.extension-non-chargee'), `${path}\n\n${String((failure as Error).message ?? failure)}`)
    return
  }
  const known = store.get().settings.extensionPaths
  if (!known.includes(path)) browser.dispatch({ type: 'settings/update', patch: { extensionPaths: [...known, path] } })
}
