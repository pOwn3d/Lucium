// The menus of the application, as main() (index.ts) installs them: the menu bar, built from the window that has the focus, the menu of
// the Dock, and what rebuilds them when what they show changed (the state, the windows, the extensions). Installed once, right after the
// windows and the lock exist; answers the function that rebuilds the menus when their key changed, for the other callers of main().

import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { SidebarState } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import { applyLanguage, t, tp } from '@shared/i18n'
import { menuKey } from '@shared/menu-state'
import { dockWorkViews } from '@shared/work-views'
import { clearHistoryPrompt } from '@shared/history-scope'
import { defaultBrowserNotice, isDefaultBrowserNow, makeDefaultBrowser } from './default-browser'
import { systemDefaultBrowserPorts } from './default-browser-ports'
import { loadExtensionFromDialog } from './ipc'
import { buildMenu } from './menu'
import { applyAboutPanel } from './about'
import * as menuDialogs from './menu-actions'
import { whatsNewRequest } from './launch-sheets'
import { lockedMenu } from './lock-menu'
import { lockedView, shownState } from './lock-state'
import type { ElectronEngine } from '../engine/electron-engine'
import type { LockService } from '../lock-service'
import type { StateStore } from '../store'
import type { LittleArc } from './little'
import type { WindowManager } from './windows'
import type { Browser } from './browser'
import type { WindowShare } from './window-share'
import type { PageAnnotate } from './page-annotate'
import type { TaskManager } from './task-manager'

export interface AppMenuDeps {
  engine: ElectronEngine
  lock: LockService
  little: LittleArc
  windowManager: WindowManager
  /** The state of the main window, and its browser. The dialogs of the menu hang from the window it acts on (the main one may be put away). */
  store: StateStore
  browser: Browser
  annotateShare: WindowShare | null
  pageAnnotate: PageAnnotate | null
  aboutWindow: TaskManager
  taskManager: TaskManager
  /** When the session started (the menu Historique lists what was opened since). */
  sessionStart: number
}

/** Installs the menu bar and the menu of the Dock, and keeps them up to date; answers the function that rebuilds them when what they show changed. */
export function installAppMenus(deps: AppMenuDeps): { refreshMenu: () => void } {
  const { engine, lock, little, windowManager, store, browser, annotateShare, pageAnnotate, aboutWindow, taskManager, sessionStart } = deps
  // The menu acts on the window that has the focus, so it is built from that window's browser and state.
  // The Extensions menu lists what runs in the profile of the space the focused window is on: an extension of another profile has no icon here.
  const extensionsOfProfile = (state: SidebarState) => engine.listExtensions().filter((e) => e.profileId === activeProfileId(state))
  // The window the work views of the Dock are for: the normal window in front, else the main one. Never a private or a guest window, which keeps no view
  // (the rule of the links that come from another application).
  const dockWindow = () => {
    const front = windowManager.focused()
    return front.kind === 'private' ? (windowManager.list().find((record) => record.kind === 'main') ?? front) : front
  }
  // The menu of the Dock (right click on the icon): two entries for windows, the work views of the profile shown, and two for the mini window. The list
  // of the windows above them (each is titled by its page or its name, see WindowManager) and what is below (Options, Show All Windows, Hide, Quit) are
  // the system's own.
  const installDockMenu = (): void => {
    if (process.platform !== 'darwin' || !app.dock) return
    // Locked, the Dock offers no window, as the menu bar offers nothing (lockedMenu): a new window would be a way round the lock screen.
    if (lock.isAppLocked()) return app.dock.setMenu(Menu.buildFromTemplate([]))
    const littleOpen = little.count() > 0
    const target = dockWindow()
    // A view comes from the user's own list: no address comes from elsewhere, so nothing is asked. Its window comes to the front first.
    const views = dockWorkViews(target.store.get()).map((view): MenuItemConstructorOptions => ({
      label: view.label,
      click: () => {
        if (!windowManager.focusWindow(target.id)) return
        target.browser.dispatch({ type: 'view/open', id: view.id, spaceId: target.store.get().activeSpaceId })
      }
    }))
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: t('menu.nouvelle-fenetre'), click: () => void windowManager.newWindow({ commandBar: true }) },
        { label: t('menu.nouvelle-fenetre-privee'), click: () => void windowManager.openPrivate({ commandBar: true }) },
        ...(views.length > 0 ? ([{ type: 'separator' }, { label: t('work-view.groupe-vues-de-travail'), enabled: false }, ...views] satisfies MenuItemConstructorOptions[]) : []),
        { type: 'separator' },
        { label: t('dock.afficher-les-mini-fenetres'), enabled: littleOpen, click: () => void little.showAll() },
        { label: t('dock.fermer-les-mini-fenetres'), enabled: littleOpen, click: () => void little.closeAll() }
      ])
    )
  }
  const installMenu = (): void => {
    // The labels of every menu are read in the language of the settings (shared/i18n.ts); menuKey rebuilds the menu when they change it.
    applyLanguage(windowManager.focused().store.get().settings, app.getLocale())
    // Lucium › À propos de Lucium shows the version, the copyright and the licence (its entry is the system's own, see menu.ts), in the same language.
    applyAboutPanel()
    // Locked, the menu has nothing that could show or change what is hidden.
    if (lock.isAppLocked()) return Menu.setApplicationMenu(lockedMenu())
    const target = windowManager.focused()
    Menu.setApplicationMenu(
      // Built from the state the interface is given: a locked space's tab on screen is not in the menu's reach either (lock-state.ts).
      buildMenu(target.browser, lockedView(target.store, () => lock.view()), {
        importDialog: () => target.browser.openOverlay({ panel: 'import' }),
        showFirstLaunch: () => target.browser.openOverlay({ panel: 'firstlaunch' }),
        showWelcome: () => target.browser.openOverlay({ panel: 'welcome' }),
        showWhatsNew: () => target.browser.openOverlay(whatsNewRequest(app.getVersion(), false)),
        exportBookmarks: () => void menuDialogs.exportBookmarksFromMenu(target, lock.lockedSpaces()),
        checkForUpdates: () => void menuDialogs.checkForUpdates(target, target.store.get().settings),
        showPrivacyPolicy: () => menuDialogs.showPrivacyPolicy(target),
        restoreData: () => void menuDialogs.restoreData(target),
        recordTrace: () => void menuDialogs.recordTrace(target, () => installMenu()),
        isRecordingTrace: menuDialogs.isRecordingTrace,
        openDocumentation: (what) => void menuDialogs.openDocumentation(what),
        isDefaultBrowser: () => isDefaultBrowserNow(systemDefaultBrowserPorts()),
        windows: () => windowManager.entries(),
        focusWindow: (id) => void windowManager.focusWindow(id),
        setWindowName: (id, name) => void windowManager.setName(id, name),
        window: () => target.win,
        sessionStart,
        loadExtension: () => void loadExtensionFromDialog(browser, store, target.win),
        extensions: () => (target.kind === 'private' ? [] : extensionsOfProfile(target.store.get())),
        lockNow: lock.isActive() ? () => lock.lockNow() : undefined,
        newWindow: () => void windowManager.newWindow({ commandBar: true }),
        blankWindow: () => void windowManager.newWindow({ commandBar: false }),
        privateWindow: () => void windowManager.openPrivate({ commandBar: true }),
        shareWindow: annotateShare ? () => annotateShare.open() : undefined,
        annotatePage: pageAnnotate ? () => pageAnnotate.toggle() : undefined,
        annotatingPage: pageAnnotate ? () => pageAnnotate.isOn() : undefined,
        guestWindow: () => void windowManager.openGuest({ commandBar: true }),
        // With no window in front, the window the menu acts on; none while the main window is put away (closing it again would close the windows opened since).
        closeWindow: () => {
          const front = BrowserWindow.getFocusedWindow()
          if (front) front.close()
          else if (!windowManager.isMainAway()) windowManager.focused().win.close()
        },
        setDefaultBrowser: () =>
          void makeDefaultBrowser(systemDefaultBrowserPorts()).then((outcome) => dialog.showMessageBoxSync(target.win, defaultBrowserNotice(outcome))),
        clearHistory: () => {
          // The history of the profile of the space shown in the window the menu acts on: the other profiles keep theirs.
          const { profileId, pages } = target.browser.historyScope()
          const prompt = clearHistoryPrompt(target.store.get(), profileId, pages)
          const answer = dialog.showMessageBoxSync(target.win, { type: 'warning', buttons: [t('app.effacer'), t('confirm-box.annuler')], defaultId: 1, cancelId: 1, message: prompt.message, detail: prompt.detail })
          if (answer === 0) target.browser.eraseHistory(profileId)
        },
        clearArchive: () => {
          // The count is of what « Vider l'archive » removes: the entries of a locked space stay, and are not counted.
          const count = shownState(store.get(), lock.view()).archive.length
          const answer = dialog.showMessageBoxSync(target.win, {
            type: 'warning',
            buttons: [t('sidebar.vider'), t('confirm-box.annuler')],
            defaultId: 1,
            cancelId: 1,
            message: t('app.vider-l-archive'),
            detail: tp('app.onglets-archives-seront-oublies', count)
          })
          if (answer === 0) browser.dispatch({ type: 'archive/clear' })
        },
        savePage: () => {
          const { browser: current, win: owner } = windowManager.focused()
          const title = current.activePageTitle()
          if (title === null) return
          void dialog
            .showSaveDialog(owner, { title: t('app.enregistrer-la-page-sous'), defaultPath: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'page'}.html` })
            .then(({ canceled, filePath }) => (canceled || !filePath ? undefined : current.savePage(filePath)))
            .catch((error: unknown) => dialog.showErrorBox(t('app.enregistrement-impossible'), String((error as Error).message ?? error)))
        },
        // The task manager lists the tabs of every window: a guest window does not open it (nor the Settings, see windows.ts).
        showAbout: () => aboutWindow.open(),
        openTaskManager: () => (target.guest === true ? target.browser.showToast(t('app.le-gestionnaire-de-taches-n-est-pas-disponible')) : taskManager.open()),
        showDataFolder: () => shell.showItemInFolder(join(app.getPath('userData'), 'state.json')),
        copyInfo: () => {
          const info = engine.info()
          void clipboard.writeText([`Lucium ${app.getVersion()}`, `${info.name} ${info.version} · Chromium ${info.chromium}`, `${process.platform} ${process.arch}`, app.getPath('userData')].join('\n')).catch((error: unknown) => console.error('[menu] cannot copy the app info:', error))
        }
      }, { private: target.kind === 'private', lockedSpaces: lock.lockedSpaces(), ...(target.kind === 'main' && windowManager.isMainAway() ? { away: () => void windowManager.revealMain() } : {}) })
    )
  }
  installMenu()
  installDockMenu()
  little.onCountChange(installDockMenu)
  // The menu shows shortcuts, spaces, profiles, extensions and the archive of the focused window: rebuild it only when one of them changed.
  const menuKeyOfFocused = (): string => {
    const target = windowManager.focused()
    // The work views of the Dock are those of the window it opens them in, which may not be the one in front (a private window lists none).
    const dockViews = JSON.stringify(dockWorkViews(dockWindow().store.get()))
    return `${target.id}|${windowManager.isMainAway()}|${menuKey(shownState(target.store.get(), lock.view()), target.kind === 'private' ? [] : extensionsOfProfile(target.store.get()).map((e) => e.id), target.browser.menuFacts(), sessionStart, `${menuDialogs.isRecordingTrace()}|lock:${lock.isAppLocked()}:${lock.isActive()}:${lock.lockedSpaces().join(',')}|${windowManager.namesKey()}|dock:${dockViews}`)}`
  }
  let shownMenu = menuKeyOfFocused()
  // A rebuild can be asked again while one is running: a native event raised inside `Menu.setApplicationMenu` (Windows resizes the window for the menu bar),
  // a listener that changes the state while the template is read, a call made from outside the main thread's own turn. A nested rebuild would install the
  // newer menu, and the first one would then install its older template over it with the newer key recorded as shown: the entry « Rouvrir le dernier onglet
  // fermé » stayed greyed out after ⌘W until another change of the key. So a call made meanwhile is only noted, and the key is read again once the menu is in.
  let rebuilding = false
  let askedAgain = false
  const REBUILD_PASSES_MAX = 5
  const refreshMenu = (): void => {
    if (rebuilding) {
      askedAgain = true
      return
    }
    rebuilding = true
    try {
      for (let pass = 1; ; pass++) {
        askedAgain = false
        const key = menuKeyOfFocused()
        if (key === shownMenu) return
        shownMenu = key
        installMenu()
        installDockMenu()
        if (!askedAgain) return
        if (pass === REBUILD_PASSES_MAX) {
          // The state keeps changing under every build: stop here, and let the next change (or call) find the menu behind and build it again.
          console.warn(`[menu] the menu changed again during each of its ${REBUILD_PASSES_MAX} rebuilds; it is built again at the next change`)
          shownMenu = ''
          return
        }
      }
    } finally {
      rebuilding = false
    }
  }
  store.subscribe(refreshMenu)
  windowManager.onChange(refreshMenu)
  // An extension installed, updated, uninstalled or switched off changes the Extensions menu.
  engine.onExtensionsChanged(refreshMenu)
  return { refreshMenu }
}
