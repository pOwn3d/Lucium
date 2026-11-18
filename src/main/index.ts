import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as electronModule from 'electron'
import { app, BrowserWindow, dialog, nativeTheme, powerMonitor, protocol, screen, shell, systemPreferences, WebContentsView, type WebContents, type WebPreferences } from 'electron'
import { sweepStaleCopiesSoon } from './importers/sqlite'
import { ElectronEngine } from './engine/electron-engine'
import { setInternalPagesHome } from './engine/internal-pages'
import { appRoots } from './shell/surface-guard'
import { componentsOf, installWidevine } from './engine/widevine'
import { installErrorLog } from './error-log'
import { showSystemNotice } from './shell/system-notice'
import { systemScrollBars, systemScrollBarsSource } from './shell/system-scroll-bars'
import { applySingleStream } from './engine/single-stream'
import { HistoryBook } from './history'
import { Browser } from './shell/browser'
import { containersNamedBeforeRestore, mayDeleteBackgroundMedia, readSessionCopies, sweepBackgroundMedia } from './shell/background-media-sweep'
import { removeRetiredFiles } from './retired-files'
import { followAppIcon, takeAppIconOffForUpdate } from './shell/app-icon'
import { followAppearance } from './shell/appearance'
import { currentPlatform } from './platform'
import { createAutoUpdater, gateAutoUpdate, withdrawnInFeed } from './shell/auto-update'
import { cleanUpdateNotices, noticeWindowAllowed } from '@shared/auto-update'
import { FeatureGates } from './shell/feature-gate'
import { LittleShortcut, gateLittleShortcut } from './shell/little-shortcut'
import { PRIVILEGED_SCHEMES } from '@shared/privileged-schemes'
import { persistableState } from '@shared/sidebar'
import { profileRecordsHistory } from '@shared/profiles'
import { SessionWriter, gateWindowMemory, readSession } from './shell/session'
import { recoverMissingProfiles } from './shell/recover-profiles'
import { selectionOfSaved, sessionWindowCount } from '@shared/window-session'
import { registerIpc } from './shell/ipc'
import { installAppMenus } from './shell/app-menu-wiring'
import { createOwnWindows } from './shell/own-windows-wiring'
import { installPasswordVault } from './shell/password-wiring'
import { installImportService } from './shell/import-wiring'
import { openDebugPanelSoon } from './shell/dev-aids'
import { installAnnotation } from './shell/annotate-wiring'
import { installWebApps } from './shell/web-apps-wiring'
import { createWindowManager, followDockClicks, openExtensionWindows } from './shell/windows-wiring'
import { installExternalLinks } from './shell/external-links-wiring'
import { setKeyPlatform, t } from '@shared/i18n'
import { platformOf } from '@shared/platform'
import { firstControlsOverlay } from '@shared/window-controls'
import { WaitingLinks } from '@shared/waiting-links'
import { followSpellChecking, holdSpellDictionaries } from './shell/page-commands'
import { MAIN_WINDOW_ID } from './shell/windows'
import { OnDemandView } from './shell/on-demand-view'
import { loadSurface, type Surface } from './shell/surface-load'
import { refuseClientCertificates, type CertificateTell } from './shell/certificates'
import { isPrimaryInstance } from './shell/single-instance'
import { announcePersistenceNotices, newestCopyAt } from './shell/announce-persistence'
import { reportPersistenceNotice } from './persistence-notices'
import { copyBeforeRestore, lastSetAsideAt } from './persist'
import { scheduleLaunchSheet, showLaunchSheet } from './shell/launch-sheets'
import { SessionBackups, gateBackups, setSessionBackups } from './shell/backups'
import { configureUserScripts } from './userscripts'
import { configureNotes } from './notes-store'
import { BackupFiles } from './backup-store'
import { logUncaughtExceptions, logUnhandledRejections } from './rejection-log'
import { LockService, NO_TOUCH_ID, setLockService, type PowerEvent } from './lock-service'
import { LockStore } from './lock-store'
import { restoreRefusal } from '@shared/lock'
import { createBlockHandlerFollower } from './block-handlers'
import { lastWindowClosedStep } from './window-lifecycle'
import { installQuitFlow, prepareQuitForUpdate } from './shell/quit-flow'
import { createUpdateInstaller, setUpdateInstaller, updateInstaller } from './shell/app-update'
import { installPrepareBeforeQuit, installUpdateQuitCheck } from './shell/update-quit-check'
import { currentUpdateSources } from './shell/update-source'
import { dropDevelopmentEnv, isBuiltApp, isSmokeRun, readDevelopmentEnv, refusalMessage, refusedSwitches, smokeWindowOptions } from './runtime'
import { formatMarker } from '@shared/perf-core'
import { readState, StateStore, WindowView } from './store'
import { sitesToClearOnQuit } from '@shared/site-clear'
import { QUIT_CLEAR_MARKER, replayQuitClear } from './shell/quit-clear'
import { settingsPath } from '@shared/settings-path'
import { selectionOf } from '@shared/window-selection'
import { TRAFFIC_LIGHTS } from '@shared/ipc'
import { localFileUrl } from '@shared/local-documents'

// The built application starts with none of the switches that hand the profile to the command line (the engine test, the DevTools protocol, the
// ones that weaken TLS or the keychain: runtime.ts): the launch says which one and ends here, before the instance lock and before anything is read.
const refused = refusedSwitches(process.argv)
if (refused.length > 0) {
  console.error(refusalMessage(refused))
  app.exit(1)
}
// The engine test: from the sources only (runtime.ts).
const smoke = isSmokeRun(process.argv)
// The built application ignores LUCIUM_ANNOTATE, LUCIUM_UPDATE_FEED and the variables of the tests: they are taken out of the environment before anything reads them.
dropDevelopmentEnv()
const platform = currentPlatform()
// Outside the engine test (which must fail on it), a promise nobody handled is written to the log instead of opening Electron's alert.
if (!smoke) logUnhandledRejections()
// The same for an exception nothing caught; the policy (go on, write it, tell once) is in rejection-log.ts. The notice needs a window: main() sets it.
let tellUncaughtException: () => void = () => {}
if (!smoke) logUncaughtExceptions(process, undefined, undefined, () => setTimeout(() => tellUncaughtException(), 0))

// Resuming downloads after a restart needs each file written from its first byte to its last (see engine/single-stream.ts), and Chromium decides
// that before the settings are read: the only thing looked at here is whether the file of the resume records exists (it exists only if the
// setting was turned on). Nothing else is read or written for the function while it is off. The engine test asks for it in its own suites.
try {
  const only = process.env['LUCIUM_SMOKE_ONLY'] ?? ''
  applySingleStream({
    userDataDir: app.getPath('userData'),
    exists: existsSync,
    commandLine: app.commandLine,
    force: smoke && (only === '' || only === 'downloadresume')
  })
} catch (error) {
  console.error('[downloads] cannot decide whether downloads run in a single stream; downloads will not be recorded for a resumption:', error)
}

// No switch turns IPv6 off: `disable-ipv6`, which the DRM build was given for the `.local` hosts of a home network, is a name Chromium no
// longer reads (the engine's binary does not hold it), so it changed nothing. What a switch must be to be set here: src/main/chromium-switches.test.ts.
// `pnpm perf` (scripts/perf.mjs) runs the application as the engine test does, offline and in a data folder of its own, but with the gates that
// the engine test leaves out started, since they are part of what it measures (see smoke-perf.ts).
const measuring = smoke && process.env['LUCIUM_SMOKE_ONLY'] === 'perf'

// A test run drives menus that reveal files in the Finder or open links in other applications. It must never do that on the machine
// of whoever runs it (one run used to leave dozens of Finder windows behind): these calls only leave a line in the log.
if (smoke) {
  const skipped = (what: string) => console.log(`[smoke] skipped ${what}`)
  const quiet = shell as unknown as { showItemInFolder: (path: string) => void; openPath: (path: string) => Promise<string>; openExternal: (url: string) => Promise<void> }
  quiet.showItemInFolder = (path) => skipped(`showItemInFolder ${path.split('/').pop() ?? ''}`)
  quiet.openPath = async (path) => (skipped(`openPath ${path.split('/').pop() ?? ''}`), '')
  quiet.openExternal = async (url) => skipped(`openExternal ${url.split(':')[0]}:`)
  // Nor may it ask the macOS keychain for the key that encrypts the safeStorage of its throw-away profile: that opens a system dialog nobody is there to answer
  // (the first use of safeStorage then blocks the whole run). Chromium's stand-in keychain holds a key of its own, in memory.
  app.commandLine.appendSwitch('use-mock-keychain')
}

// macOS delivers links from other apps before the window exists: keep them until the browser is ready. Elsewhere they are in the command line
// of the first launch (a second launch hands its own to the first one, see 'second-instance').
const pendingExternalUrls = new WaitingLinks(platform.commandLineLinks(process.argv))
let openExternalUrl: ((url: string) => void) | null = null
let flushDeferredLinks: () => void = () => {}
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (openExternalUrl) openExternalUrl(url)
  else pendingExternalUrls.add(url)
})
// The Finder hands the files it opens with Lucium (a double-click on a page, « Ouvrir avec », the icon of the Dock) by their path, not as a link: they take
// the way of the links, as a `file:` address. Like 'open-url', this has to be heard before the application is ready.
app.on('open-file', (event, path) => {
  event.preventDefault()
  const url = localFileUrl(path)
  if (url === null) return console.warn(`[links] ignored a file Lucium does not open: ${path.split('/').pop() ?? ''}`)
  if (openExternalUrl) openExternalUrl(url)
  else pendingExternalUrls.add(url)
})

// One running Lucium per profile directory: a second launch hands its links to the first, and starts nothing (see the end of this file).
// The engine test needs a data folder of its own (--user-data-dir=): without one it is refused, and ends with code 1.
// A refused launch asks for no lock: it must not take the place of the application, nor hand anything to the one that runs.
const primaryInstance = refused.length === 0 && isPrimaryInstance(smoke, () => app.requestSingleInstanceLock(), process.argv)
if (!primaryInstance) {
  if (smoke || refused.length > 0) app.exit(1)
  else app.quit()
}

// No client certificate of the keychain is presented to a server that asks, and a notice in the window of the page says so (see
// certificates.ts). The engine, which knows the page of a web contents, exists once the application is ready: before, nothing can ask.
let certificateRefused: CertificateTell | null = null
refuseClientCertificates(app, (contents, site) => certificateRefused?.(contents, site) ?? false)

// Away from macOS Chromium's own spell checker fetches the dictionary of a session's language from its CDN as soon as the session exists. Every session
// (the default one, the partitions of the profiles and containers, the private windows') is made without a language until the user switches the checker on
// in Edit › Spelling and Grammar, so nothing leaves the machine before that (shell/page-commands.ts). It has to be heard before the application is ready.
holdSpellDictionaries()

// The stand-in resources of the blocker's extended rules are served under a scheme of their own (a redirect to `data:` is aborted by Chromium).
// The name has to be declared before the application is ready, and `secure` so that a page on https may load it (no mixed content). This only
// names the scheme: nothing serves it, and no listener exists, until the extended rules are switched on (engine/electron-engine.ts, syncStandIns).
// The icons of sites are drawn by the interface from the copies the main process keeps (shared/site-icon.ts), under a scheme of their own that only the
// session of the interface serves (engine/electron-engine-base.ts). The schemes are declared once, in one call (shared/privileged-schemes.ts).
protocol.registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES])

// Every surface of our interface is loaded by `loadSurface` (shell/surface-load.ts), which locks it to our own pages before its first load.
function load(target: WebContents, surface: Surface): void {
  loadSurface(target, surface, { rendererDir: join(__dirname, '../renderer'), built: isBuiltApp() })
}

/** The floating sidebar of a window, made and loaded only while the window may show it (shell/on-demand-view.ts). */
function floatingSidebar(webPreferences: WebPreferences, query?: Record<string, string>): OnDemandView<WebContentsView> {
  return new OnDemandView(() => {
    const view = new WebContentsView({ webPreferences })
    // The panel is inset from the window's edge and has a shadow: what is around it is the window, not a rectangle of colour.
    view.setBackgroundColor('#00000000')
    load(view.webContents, { page: 'index', hash: 'float', ...(query ? { query } : {}) })
    return view
  })
}

async function main(): Promise<void> {
  // The last error lines stay in memory for Settings › Général › État de Lucium (the console still writes as before).
  installErrorLog()
  // The keys named inside the sentences (menus, dialogs) are those of the system this process runs on (shared/key-words.ts).
  setKeyPlatform(platformOf(process.platform))
  await app.whenReady()
  // On the castLabs build of Electron (docs/drm.md) the Widevine module is installed from here, without holding the start back; on the Electron of the project there is no
  // such module and nothing happens. A test run contacts nobody.
  if (!smoke) void installWidevine(componentsOf(electronModule), { log: (line) => console.log(line), notify: (notice) => void (showSystemNotice(notice) || console.error(`[widevine] could not tell the user: ${notice.body}`)) })
  // Quitting is confirmed once (setting "Warn before quitting"); closing the last window already is a decision to quit.
  let quitConfirmed = smoke

  // The engine test must never write into the real Downloads folder.
  if (smoke) app.setPath('downloads', join(app.getPath('userData'), 'downloads'))
  
  const statePath = join(app.getPath('userData'), 'state.json')
  // The version is given to both: the file says which version wrote it, and the first launch of another version keeps a copy of it before anything
  // is written (store.ts, `keepStateOfOtherVersion`).
  const loadedState = readState(statePath, app.getVersion())
  const sharedStore = new StateStore(loadedState.state, statePath, undefined, { appVersion: app.getVersion() })
  // What the state no longer names is deleted at this launch only when the state was read, was not written by a later version (which may name what
  // this one does not know), and no set-aside copy of it is kept beside it: otherwise what it named would be taken for unused. The same answer holds
  // for the background media here and the folders of deleted containers below.
  const stateTrusted = mayDeleteBackgroundMedia(statePath, loadedState.readable && !loadedState.fromNewerVersion, app.getVersion())
  // The background media nothing refers to any more: not in the smoke runs, which keep their own folders.
  if (!smoke && stateTrusted) sweepBackgroundMedia(app.getPath('userData'), sharedStore.get().spaces, readSessionCopies(app.getPath('userData')))
  else if (!smoke) console.warn('[media] no background is deleted at this launch: the state file was not read, or was written by a later version, or a set-aside copy of it is kept beside it')
  // The files of functions that no longer exist (the keys of the online providers of the summary).
  removeRetiredFiles(app.getPath('userData'))
  // The copies of another browser's history that an import cut short left in the temporary folder: up to a gigabyte each. Only those untouched
  // for an hour go, so that the copy of an import running in another instance is spared (importers/sqlite.ts). A little later, not before the window shows.
  sweepStaleCopiesSoon(tmpdir())
  // The main window is the first view of the shared state (its tabs, spaces and settings); File › New Window adds others.
  const views = new Set<WindowView>()
  const store = new WindowView(sharedStore, selectionOf(sharedStore.get()), views, true)
  // One history per profile; history.json, the file of the single history of earlier versions, is the default profile's (see HistoryBook).
  const history = new HistoryBook(app.getPath('userData'), (profileId) => profileRecordsHistory(sharedStore.get().settings, profileId), !smoke)
  const preload = join(__dirname, '../preload/index.js')
  const webPreferences = { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }

  // Settings › Onglets et fenêtres: the windows come back where they were. The first one is placed here, the others once the browser is running.
  const sessionPath = join(app.getPath('userData'), 'windows.json')
  const session = readSession(sessionPath, screen.getAllDisplays().map((display) => display.workArea), sharedStore.get())
  const restoreWindows = !smoke && sharedStore.get().settings.restoreWindows
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    ...(restoreWindows && session.main ? session.main : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#17171c',
    ...smokeWindowOptions(smoke),
    // Windows: the system's three buttons over the right end of the toolbar (the page draws the rest of the title bar); the layout follows what is behind them.
    ...platform.windowFrame(TRAFFIC_LIGHTS, firstControlsOverlay(sharedStore.get().settings, { dark: nativeTheme.shouldUseDarkColors })),
    webPreferences
  })
  const overlay = new WebContentsView({ webPreferences })
  overlay.setBackgroundColor('#00000000')
  // The sidebar again, slid over the page when the sidebar is hidden and the pointer touches the left edge: made only while the sidebar is hidden.
  const floating = floatingSidebar(webPreferences)

  // Every window the engine can attach pages to: the main one and the mini windows.
  const windows = new Map<string, BrowserWindow>([['main', win]])
  // Where the Extensions page (a tab at lucium-ui://extensions/) is served from: the built pages, or the development server while the application is not packaged.
  // Told before the engine makes its first session: each session of a profile answers the scheme with it (engine/internal-pages.ts).
  const rendererDir = join(__dirname, '../renderer')
  setInternalPagesHome({ rendererDir, devUrl: appRoots(rendererDir, isBuiltApp()).devUrl ?? undefined, projectRoot: app.getAppPath() })
  const engine = new ElectronEngine((id) => {
    const target = windows.get(id ?? 'main')
    if (!target) throw new Error(`Unknown window: ${id}`)
    return target
  })
  // What a previous session left in the temporary folder of downloads (files opened without keeping, files that waited for a place) goes now, and again when the application quits.
  engine.sweepDownloadStaging()
  app.on('will-quit', () => engine.sweepDownloadStaging())
  certificateRefused = (contents, site) => engine.clientCertificateRefused(contents, site)
  const browser = new Browser(win, overlay, floating, engine, store, history)
  const trusted = new Set([win.webContents.id, overlay.webContents.id])
  floating.trust(trusted)
  registerIpc(browser, store, win, trusted)

  // One handler per tab, registered once when the tab appears and forgotten when it is closed (not re-registered on every state change).
  const followBlockHandlers = createBlockHandlerFollower(
    (id) => engine.setBlockExceptionHandler(id, (url) => browser.toggleBlockException(url)),
    (id) => engine.clearBlockExceptionHandler(id)
  )
  const registerBlockExceptionHandlers = () => followBlockHandlers(store.get().tabs)
  registerBlockExceptionHandlers()
  store.subscribe(() => registerBlockExceptionHandlers())

  // Brings the main window to the front, back from being put away when it was closed on macOS (WindowManager.revealMain; `windowManager` exists by the first call).
  const focusMain = (): void => void windowManager.revealMain()
  // The windows of their own: the mini windows, the floating video, Réglages, Extensions, the task manager, À propos (shell/own-windows-wiring.ts).
  const { little, settings, taskManager, aboutWindow } = createOwnWindows({ engine, store, sharedStore, browser, history, windows, trusted, focusMain, webPreferences, platform, load })

  // The annotated window share and the annotation directly on the page (docs/design/annotation-partage-fenetre.md), and what follows their settings
  // (shell/annotate-wiring.ts). The window manager and the menu, made below, are read when they are needed.
  const { annotateShare, pageAnnotate } = installAnnotation({ sharedStore, load, preloadDir: join(__dirname, '../preload'), windowManager: () => windowManager, refreshMenu: () => refreshMenu() })

  // Every window that shows a browser: the main one, and the private ones opened from it (File › New Private Window); made in shell/windows-wiring.ts.
  const windowManager = createWindowManager({ engine, sharedStore, views, history, windows, webPreferences, platform, load, floatingSidebar, settings, little })
  windowManager.registerMain(win, browser, store)
  // The first exception nothing caught is told in the window the user works in, with the way to its lines (Settings › À propos et mises à jour › Plus de réglages › État de Lucium).
  tellUncaughtException = () => {
    const { browser: front } = windowManager.focused()
    front.showToast(t('app.erreur-interne-lucium-continue', { settingsPath: settingsPath('engineStatus') }), { label: t('app.voir-le-journal'), run: () => front.openOverlay({ panel: 'settings', pane: 'about', anchor: 'status' }) })
  }
  // Settings › Vie privée et sécurité › Verrouillage. Created before any page: an application set to start locked starts with none. Off, it holds nothing (see LockService.start).
  const lock = new LockService({
    settings: () => sharedStore.get().settings,
    spaceIds: () => sharedStore.get().spaces.map((space) => space.id),
    files: new LockStore(join(app.getPath('userData'), 'lock.json')),
    // The engine test never shows a prompt of the system: it puts a simulated Touch ID in place when it needs one.
    touchId: smoke ? NO_TOUCH_ID : platform.touchId(systemPreferences),
    power: { on: (event: PowerEvent, listener) => powerMonitor.on(event as 'suspend', listener), off: (event: PowerEvent, listener) => powerMonitor.off(event as 'suspend', listener) },
    // Past the interface's filter, which keeps these settings for the lock's own handler.
    update: (patch) => browser.dispatch({ type: 'settings/update', patch }),
    // A box the user closes (announce-persistence.ts), shown once a window is there: a lock that went off must not be said by a toast that passes.
    notify: (message) => reportPersistenceNotice({ kind: 'lock-off', reason: message })
  })
  setLockService(lock)
  lock.start()
  app.on('will-quit', () => lock.stop())
  // What costs something while it runs (timers, listeners, requests) is tied to its setting by these gates and stops with it (docs/fonctions.md).
  const gates = new FeatureGates(store)
  // Settings › Vie privée et sécurité › Mots de passe: the vault, its Touch ID, the gate of the page bridge, and what closes it (shell/password-wiring.ts). Its will-quit handler is installed here.
  installPasswordVault({ sharedStore, gates, engine, lock, win, platform, smoke })
  const sessionWriter = new SessionWriter(sessionPath, windowManager, restoreWindows ? sessionWindowCount(session) : null)
  if (!smoke || measuring) gateWindowMemory(gates, { win, app, windows: windowManager, writer: sessionWriter })
  // Settings › Téléchargements et fichiers › Copies automatiques: a few dated copies of the spaces and tabs in the data folder, and the panel that puts one back.
  // They follow the shared state of the normal windows; a private window has a store of its own that is never copied. The engine test makes its
  // copies by hand (no timer, nothing at quit) in its own throw-away data folder.
  const backups = new SessionBackups({
    // The copies made before a state file was set aside as unreadable are those of the session that was lost: they do not rotate with the new ones.
    files: new BackupFiles(join(app.getPath('userData'), 'session-backups'), () => lastSetAsideAt(statePath)),
    state: () => persistableState(sharedStore.get()),
    settings: () => sharedStore.get().settings,
    subscribe: (listener) => sharedStore.subscribe(() => listener()),
    refusal: () => restoreRefusal(lock.lockedSpaces()),
    apply: (copy) => browser.dispatch({ type: 'backup/restore', copy }),
    toast: (message, action) => browser.showToast(message, action)
  })
  setSessionBackups(backups)
  // The user scripts file is read when the first one is asked for (the manager is off by default): only its place is known now.
  configureUserScripts(join(app.getPath('userData'), 'userscripts.json'))
  // The same for the quick notes (notes.json): read on a request of their panel only, never while the function is off.
  configureNotes(join(app.getPath('userData'), 'notes.json'))
  if (!smoke || measuring) {
    gateBackups(gates, backups)
    // Quitting is certain at this point (the confirmation and a cancelled quit come before it). The last copy is made before the gates stop.
    app.on('will-quit', () => {
      backups.backUp('quit')
      gates.disposeAll()
      little.stop()
    })
  }
  // Settings › Fonctions › "Ouvrir un site comme application": the gate of the manager of the application windows (shell/web-apps-wiring.ts).
  const webApps = installWebApps({ gates, engine, store, browser, windows, trusted, focusMain, webPreferences, load })
  // Settings › General › "Rechercher les mises à jour automatiquement": a background look for a newer version at the address built into the build,
  // said in a notice of the sidebar. The notice shows only in the normal window the user works in, while it has the focus: never in a private
  // window, during a share of a window, or behind the lock (it waits for the next focus).
  if (!smoke || measuring)
    gateAutoUpdate(
      gates,
      createAutoUpdater({
        settings: () => store.get().settings,
        // Straight to the state: the main window may be closed while another one stays open.
        update: (patch) => store.dispatch({ type: 'settings/update', patch }),
        noticeWindow: () => {
          // The window that has the focus now, read from the system: `browser-window-focus` comes before WindowManager has noted the new window.
          // None (Lucium in the background), or one that is no browser window (Réglages, À propos, a mini window): the notice waits.
          const focused = BrowserWindow.getFocusedWindow()
          const front = focused ? windowManager.recordOf(focused) : undefined
          const allowed = noticeWindowAllowed({
            locked: lock.isAppLocked(),
            sharing: annotateShare?.isSharing() === true || pageAnnotate?.isPresenting() === true,
            front: front ? { kind: front.kind, alive: !front.win.isDestroyed(), focused: true } : null
          })
          return allowed && front ? { win: front.win, browser: front.browser } : null
        }
      })
    )
  // Settings › Links › "Mini window shortcut in all apps" (⌥⌘N): the command's shortcut is a system-wide one while the setting is on.
  if (!smoke) {
    const littleShortcut = new LittleShortcut(() => {
      // A shortcut that works from any application must not open the command bar over a locked Lucium.
      if (lock.isAppLocked()) return
      // The bar opens in a window of its own: a main window put away (macOS) stays so, one that is there comes forward as before; none once it is gone.
      if (!windowManager.isMainAway() && !windowManager.revealMain()) return
      app.focus({ steal: true })
      browser.openOverlay({ panel: 'commandbar', mode: 'little', initial: '' })
    })
    // Held, and the state followed for a change of its keys, only while the setting is on.
    gateLittleShortcut(gates, littleShortcut, store, () => platform.accelerator('newLittleArc', store.get().settings.keyBindings))
    app.on('will-quit', () => littleShortcut.stop())
  }
  // chrome.windows.create: a popup is a small window of one page (the mini window's), anything else is a window of the browser (shell/windows-wiring.ts).
  openExtensionWindows({ browser, windows, little, windowManager })

  // The development variables (runtime.ts), read once: ignored in the built application.
  const development = readDevelopmentEnv(platform.splitPathList)

  // "Import from Another Browser…" (shell/import-wiring.ts).
  installImportService({ platform, development, browser, store, history, windowManager })
  // Edit › Spelling: the choice of the last launch is applied from the start, and a click on the entry is kept in the settings of the main window.
  followSpellChecking(store.get().settings.spellCheck, (choice) => browser.dispatch({ type: 'settings/update', patch: { spellCheck: choice } }))
  const sessionStart = Date.now()

  // The menu bar and the menu of the Dock, built from the window that has the focus and rebuilt when what they show changed (shell/app-menu-wiring.ts).
  const { refreshMenu } = installAppMenus({ engine, lock, little, windowManager, store, browser, annotateShare, pageAnnotate, aboutWindow, taskManager, sessionStart })
  // The lock changed: the menu follows, and a locked application closes the windows that are not part of the locked ones (a window of settings, the task
  // manager, the mini windows show page names and live pages) and keeps the links other applications sent for when it is unlocked.
  lock.subscribe(() => {
    if (lock.isAppLocked()) {
      settings.close()
      taskManager.close()
      aboutWindow.close()
      annotateShare?.close()
      pageAnnotate?.stop()
      for (const state of little.states()) little.close(state.id)
    } else flushDeferredLinks()
    // The windows of "Ouvrir comme application" show live pages of the space they came from: they close with its lock, and their pages with them.
    webApps()?.closeLocked((spaceId) => lock.isAppLocked() || lock.isSpaceLocked(spaceId))
    refreshMenu()
  })

  // View › Appearance: Lucium's own (the Mac's, or forced light or dark: the only one that moves nativeTheme) and the one asked of the websites (given to the pages only).
  followAppearance(store, nativeTheme, engine)

  // Settings › Icon: the chosen icon is shown at each launch and at each choice, in the Dock and on the application bundle, so that the Dock, the
  // Finder and the Launchpad keep it once Lucium is closed (shell/app-icon.ts). It comes off the bundle before an update replaces it (below).
  followAppIcon(store)

  // « Toujours afficher les barres de défilement »: read at launch, followed when macOS says it changed and read again each time the application becomes active.
  if (process.platform === 'darwin') {
    systemScrollBars().start(systemScrollBarsSource(systemPreferences))
    app.on('did-become-active', () => systemScrollBars().refresh())
    app.on('will-quit', () => systemScrollBars().stop())
  }

  // The quit: the watch of a quit the system asks for, the last writes of will-quit, the question before quitting and the erasure of the sites
  // "à la fermeture de Lucium" (shell/quit-flow.ts). Installed here, after every other will-quit handler of main(): its last write runs after them.
  const quitClearMarker = join(app.getPath('userData'), QUIT_CLEAR_MARKER)
  const systemQuit = installQuitFlow({
    app,
    dialog,
    proc: process,
    power: powerMonitor,
    store,
    history,
    engine,
    windowManager,
    browser,
    smoke,
    quitClearMarker,
    copyOnExit: () => void backups.backUp('quit'),
    confirmed: () => quitConfirmed,
    confirm: () => {
      quitConfirmed = true
    }
  })
  // Lucium › Rechercher les mises à jour… › Installer et relancer: the installer of the built-in feed of the channel the setting follows (shell/app-update.ts,
  // null outside a built application that has one, and asked again at each download). Nothing of Electron's autoUpdater is touched before the user asks; its `before-quit-for-update` lets the quit through.
  setUpdateInstaller(
    createUpdateInstaller(
      () => currentUpdateSources(store.get().settings).install,
      () =>
        prepareQuitForUpdate({
          store,
          history,
          engine,
          windowManager,
          confirm: () => {
            quitConfirmed = true
          }
        }),
      () => store.get().settings.sendGpc === true,
      takeAppIconOffForUpdate
    )
  )
  // An update downloaded in this run is installed by Squirrel as Lucium ends: the feed is read once more before (shell/update-quit-check.ts),
  // and a version it now lists as withdrawn is dropped, then told at the next launch. After the handlers of the quit flow, which it waits for.
  installUpdateQuitCheck({
    app,
    installer: updateInstaller,
    allowed: () => store.get().settings.autoUpdate,
    withdrawn: () => withdrawnInFeed(currentUpdateSources(store.get().settings).install),
    remember: (dropped) => store.dispatch({ type: 'settings/update', patch: { updateNotices: { ...cleanUpdateNotices(store.get().settings.updateNotices), dropped } } }),
    system: () => systemQuit.isActive(),
    confirm: () => {
      quitConfirmed = true
    },
    log: (line) => console.warn(line)
  })
  // The update that waits is installed as Lucium ends: the custom icon comes off the bundle first (shell/update-quit-check.ts), after the look above.
  installPrepareBeforeQuit({
    app,
    installer: updateInstaller,
    system: () => systemQuit.isActive(),
    confirm: () => {
      quitConfirmed = true
    },
    log: (line) => console.warn(line)
  })


  // The Client Hints the pages' navigations carry are read from this page, the same Chromium as the pages, as soon as it commits. Handed in
  // before any tab is restored (browser.start below): the first navigations of the launch wait for them, two seconds at most.
  engine.learnClientHints(win.webContents)
  load(win.webContents, { page: 'index' })
  load(overlay.webContents, { page: 'overlay' })
  win.once('ready-to-show', () => {
    // The site-icon checks drive no mouse or key and read the sidebar from the page: their window is transparent and never takes the focus.
    if (smoke && ['favicons', 'favicons-measure'].includes(process.env['LUCIUM_SMOKE_ONLY'] ?? '') && process.env['LUCIUM_COMPARE_QUIET'] !== '0') {
      app.dock?.hide()
      win.setOpacity(0)
      win.setIgnoreMouseEvents(true)
      win.showInactive()
    } else win.show()
    if (measuring) console.log(formatMarker({ kind: 'shown', uptimeMs: process.uptime() * 1000 }))
    // A file that could not be read or written at start-up (or since) is told in a dialog on this window; the engine test has no one to answer it.
    if (!smoke) announcePersistenceNotices(win, () => newestCopyAt(backups.list()))
    // The welcome of the first launch, or the news of an update, once the overlay has drawn its first page (a request sent before that is lost).
    if (!smoke) {
      scheduleLaunchSheet(
        {
          windowGone: () => win.isDestroyed() || overlay.webContents.isDestroyed(),
          layerLoading: () => overlay.webContents.isLoading(),
          onceLayerLoaded: (listener) => void overlay.webContents.once('did-finish-load', listener)
        },
        () => void showLaunchSheet({ newProfile: loadedState.fresh, settings: () => store.get().settings, update: (patch) => browser.dispatch({ type: 'settings/update', patch }), open: (request) => browser.openOverlay(request) }, app.getVersion())
      )
    }
  })
  win.on('closed', () => {
    browser.stop()
    // The other windows belong to this session: they go with the main window.
    windowManager.closeOtherWindows()
  })
  app.on('before-quit', () => {
    store.flush()
    history.flush()
    // The downloads in progress leave their records up to date (nothing happens while the resumption of downloads is off).
    engine.flushDownloadResume()
    // The hosts held to strict transport security whose write still waited (a site first visited in the last second).
    engine.flushStrictTransport()
  })
  app.on('window-all-closed', () => {
    // macOS keeps the application running with no window (as its other applications do): ⌘Q quits it, and a click on the Dock reopens a window.
    if (lastWindowClosedStep(process.platform) === 'keep-running') return
    quitConfirmed = true
    app.quit()
  })

  browser.setSystemDark(nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => {
    for (const { browser: each } of windowManager.list()) each.setSystemDark(nativeTheme.shouldUseDarkColors)
  })
  // Before any page exists (a page would create a missing profile's storage again): spaces whose profile lost its data go back to the default one.
  // The state file is still the one that was read: it is copied first, so that a folder of profiles that comes back does not leave every space to be put back by hand.
  void recoverMissingProfiles(store, engine, win, () => copyBeforeRestore(statePath)).catch((error: unknown) => console.error('[profiles] cannot check the profiles:', error))
  // With tab containers on, the folders of containers deleted earlier whose data a crash left on disk go now, before any page opens their session
  // (not when the state was not read at this launch: see `stateTrusted`; nor the folder of a container that a copy of the state made before
  // Help › Restore Data still names: putting that copy back must find its cookies and storage).
  browser.sweepStoredContainers(stateTrusted, () => containersNamedBeforeRestore(app.getPath('userData')))
  // The folders of the profiles deleted earlier (their partition, their Chrome Web Store extensions) go now, before any page opens their session; their
  // ids are free again (shared/profile-retire.ts). Not when the state was not read at this launch.
  browser.sweepRetiredProfiles(stateTrusted)
  // An erasure "à la fermeture de Lucium" that the last quit cut short is done now, in the background, as the first pages open.
  if (!smoke) void replayQuitClear(quitClearMarker, { enabled: () => sitesToClearOnQuit(store.get(), { private: false }).length > 0, clear: () => browser.clearSitesOnQuit() }).catch((error: unknown) => console.error('[quit] cannot look for an erasure cut short at the last quit:', error))
  browser.start()

  if (restoreWindows) {
    // The names come back with the windows; they only show while windows can be named (a setting), and are kept either way. So does the sidebar each
    // window chose for itself (its side, docked to a column of icons): the first window's too.
    windowManager.setName(MAIN_WINDOW_ID, session.mainName)
    browser.setWindowSidebar(session.mainSidebar)
    for (const saved of session.windows) {
      windowManager.openWindow({ commandBar: false, restore: { bounds: saved.bounds, selection: selectionOfSaved(saved, store.get()), name: saved.name, ...(saved.sidebar ? { sidebar: saved.sidebar } : {}) } })
    }
  }
  // Every window shows its tab now (each one's sync gave it its page): the tabs the user keeps alive wake behind, one per site never put to
  // sleep that no window shows (shared/sleep.ts, `tabsToWakeAtLaunch`), the tabs that reload themselves with their countdowns.
  browser.wakeAtLaunch()

  // The links other applications send, the commands by address, the links that wait for the unlocking and a second launch of the program
  // (shell/external-links-wiring.ts): the two functions are held here before the first link is opened.
  const links = installExternalLinks({ browser, store, lock, little, windowManager, focusMain, pendingExternalUrls })
  flushDeferredLinks = links.flushDeferredLinks
  openExternalUrl = links.openExternalUrl
  links.listen()
  // A click on the icon of the Dock brings the last window back, or the main window put away (shell/windows-wiring.ts).
  followDockClicks(windowManager)
  // Unpackaged extensions from the environment, and the debug aids below, only outside the built application: the dialog stays the way to add one there.
  const fromEnv = development.extensions
  const extensionPaths = [...new Set([...store.get().settings.extensionPaths, ...fromEnv])]
  await browser.loadExtensions(extensionPaths, (path, error) =>
    console.error(`[extensions] ${path} failed to load:`, error)
  )
  refreshMenu()

  // Dev aid for visual checks of the dark and light appearances without touching the system setting (LUCIUM_DEBUG_APPEARANCE=dark|light).
  const forced = development.appearance
  if (forced === 'dark' || forced === 'light') nativeTheme.themeSource = forced

  // Dev aid for visual checks: open a panel shortly after start (LUCIUM_DEBUG_PANEL=downloads|space|theme|settings[:pane]|find|findreplace|import|commandbar|boost|peek|about|private|window|autoreload).
  const debugPanel = development.panel
  if (debugPanel) openDebugPanelSoon(debugPanel, { browser, store, win, windowManager, little })

  if (smoke) {
    // A main-process exception normally opens a native alert that nobody answers in a test: fail instead of hanging.
    process.on('uncaughtException', (error) => {
      console.error('[smoke] uncaught exception in the main process:', error)
      app.exit(1)
    })
    // The suites, their order and the exit code: smoke-run.ts, loaded only here.
    await (await import('./smoke-run')).runSmokeSuites({ browser, store, engine, history, win, overlayView: overlay, little }, fromEnv)
  }
}

// A launch that was refused the single-instance lock is on its way out: it must not load the state, install quit handlers that write it back
// or open a window of its own over the first instance's data.
if (primaryInstance) {
  main().catch((error: unknown) => {
    console.error('[main] fatal:', error)
    app.exit(1)
  })
}
