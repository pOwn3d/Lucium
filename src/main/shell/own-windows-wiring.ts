// A part of main() (index.ts), moved out as it was: the windows of their own, made at the start and opened on demand. The mini windows,
// the floating video (« Image dans l'image »), Réglages, the task manager and À propos, with what tells the browser and the
// engine how to open them. Called once, after the first window and its browser exist. (The Extensions page is no window: it is a tab, Browser.openExtensionsTab.)

import { BrowserWindow, nativeTheme, screen, WebContentsView, type WebContents, type WebPreferences } from 'electron'
import { FLOATING_MIN_WIDTH } from '@shared/floating-video'
import { t } from '@shared/i18n'
import type { SettingsAnchor, SettingsPane } from '@shared/ipc'
import { panelWindowBackground } from '@shared/panel-window'
import { settingsHash } from '@shared/settings-target'
import type { ElectronEngine } from '../engine/electron-engine'
import type { HistoryBook } from '../history'
import type { currentPlatform } from '../platform'
import type { StateStore, WindowView } from '../store'
import type { Browser } from './browser'
import { FloatingVideo } from './floating-video'
import { LittleArc } from './little'
import { electronDisplays, PanelScaling } from './panel-scaling'
import { setTaskManagerOpener } from './resource-ipc'
import { SETTINGS_WINDOW_OPTIONS, SettingsWindow } from './settings-window'
import type { Surface } from './surface-load'
import { TaskManager } from './task-manager'
import { getSyncService } from '../sync/registry'

export interface OwnWindowsDeps {
  engine: ElectronEngine
  /** The view of the first window on the shared state. */
  store: WindowView
  sharedStore: StateStore
  /** The browser of the first window. */
  browser: Browser
  history: HistoryBook
  /** Every window the engine can attach pages to. */
  windows: Map<string, BrowserWindow>
  /** The web contents of our own interface. */
  trusted: Set<number>
  focusMain: () => void
  webPreferences: WebPreferences
  platform: ReturnType<typeof currentPlatform>
  /** Loads a surface of the interface, locked to our own pages (index.ts, `load`). */
  load: (target: WebContents, surface: Surface) => void
}

export interface OwnWindows {
  little: LittleArc
  settings: SettingsWindow
  taskManager: TaskManager
  aboutWindow: TaskManager
}

export function createOwnWindows({ engine, store, sharedStore, browser, history, windows, trusted, focusMain, webPreferences, platform, load }: OwnWindowsDeps): OwnWindows {
  const little = new LittleArc({
    engine,
    store,
    browser,
    history,
    windows,
    trusted,
    focusMain,
    // The screen of the window the link comes from, else the one of the pointer (a link from another application has no window of ours).
    workArea: (near) => (near ? screen.getDisplayMatching(near) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea,
    createWindow: (id, bar, bounds) => {
      // The first state is the command bar alone (490 x 329); the window only gets its minimum size once a page is chosen.
      const lw = new BrowserWindow({
        ...bounds,
        minWidth: bar ? undefined : 480,
        minHeight: bar ? undefined : 360,
        resizable: !bar,
        show: false,
        backgroundColor: bar ? '#18171b' : '#17171c',
        ...platform.windowFrame({ x: 12, y: 16 }),
        webPreferences
      })
      load(lw.webContents, { page: 'littlearc', query: bar ? { id, bar: '1' } : { id } })
      return lw
    },
    createPicker: (id) => {
      const view = new WebContentsView({ webPreferences })
      view.setBackgroundColor('#00000000')
      load(view.webContents, { page: 'littlearc', query: { id, picker: '1' } })
      return view
    },
    createTray: (id) => {
      const view = new WebContentsView({ webPreferences })
      view.setBackgroundColor('#00000000')
      load(view.webContents, { page: 'littlearc', query: { id, tray: '1' } })
      return view
    }
  })
  browser.setLittleOpener((url, origin) => little.openLink(url, origin))
  // « Image dans l'image » asked from Lucium (the menu, the media player): the live view of the tab in a small window without a frame, above the others,
  // with a bar of controls over it (shell/floating-video.ts). One for the whole group of windows. Its own content is black and loads nothing: the page
  // is lent to it, and the bar is a view of the interface laid over the page.
  const floatingVideo = new FloatingVideo({
    windows,
    trusted,
    createWindow: (bounds) =>
      new BrowserWindow({
        ...bounds,
        minWidth: FLOATING_MIN_WIDTH,
        minHeight: Math.round(FLOATING_MIN_WIDTH / 4),
        frame: false,
        show: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: true,
        backgroundColor: '#000000',
        title: t('floating-video.titre-sans-site'),
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
      }),
    createBar: () => {
      const view = new WebContentsView({ webPreferences })
      view.setBackgroundColor('#00000000')
      load(view.webContents, { page: 'floating-video' })
      return view
    },
    workArea: (near) => (near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()).workArea
  })
  browser.setFloatingVideo(floatingVideo)
  // File › New Mini Window opens the window in its first state: a small window with the command bar alone.
  browser.setLittleBarOpener((from) => little.openBar(from))
  // An error page's « Ouvrir en mini-fenêtre » opens the address in one of these windows.
  engine.setMiniWindowOpener((url) => browser.openLittle(url))

  // The windows of their own (Réglages, the task manager, À propos) take the size the screen they open on gives the panels (Settings › Apparence):
  // their size is multiplied and their page zoomed by that factor, and they follow it while they are open (shell/panel-scaling.ts).
  const panelScaling = new PanelScaling({
    store: sharedStore,
    displays: electronDisplays(screen),
    around: () => BrowserWindow.getFocusedWindow()?.getBounds() ?? null,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout)
  })
  const settings = new SettingsWindow({
    browser,
    trusted,
    createWindow: (pane: SettingsPane, anchor?: SettingsAnchor) => {
      const sw = panelScaling.open(SETTINGS_WINDOW_OPTIONS, (options) => new BrowserWindow({ ...options, backgroundColor: panelWindowBackground(nativeTheme.shouldUseDarkColors), webPreferences }))
      load(sw.webContents, { page: 'settings', hash: settingsHash(pane, anchor) })
      return sw
    },
    // The Mac listens for the iPhone only while the page « Synchronisation » is open: the window closes with the Settings window (docs/synchronisation.md §6.1).
    onClosed: () => void getSyncService()?.leave().catch((error: unknown) => console.error('[sync] the window could not be closed with the Settings:', error))
  })
  browser.setSettingsOpener((pane, anchor) => settings.open(pane, anchor))
  const taskManager = new TaskManager({
    trusted,
    createWindow: () => {
      const tw = panelScaling.open(
        { width: 720, height: 480, minWidth: 420, minHeight: 260 },
        (size) =>
          new BrowserWindow({
            ...size,
            show: false,
            title: t('app.gestionnaire-de-taches'),
            backgroundColor: panelWindowBackground(nativeTheme.shouldUseDarkColors),
            webPreferences
          })
      )
      load(tw.webContents, { page: 'taskmanager' })
      return tw
    }
  })
  // « Gestionnaire complet… » of the resource panel of the sidebar opens the same window as the menu.
  setTaskManagerOpener(() => taskManager.open())

  // Lucium › À propos de Lucium: a small window in the theme, one at a time, trusted only while it exists (the same holder as the task manager's).
  const aboutWindow = new TaskManager({
    trusted,
    createWindow: () => {
      const aw = panelScaling.open(
        { width: 340, height: 520 },
        (size) =>
          new BrowserWindow({
            ...size,
            useContentSize: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            show: false,
            title: t('menu.a-propos-d-lucium'),
            backgroundColor: panelWindowBackground(nativeTheme.shouldUseDarkColors),
            webPreferences
          })
      )
      load(aw.webContents, { page: 'about' })
      return aw
    }
  })
  return { little, settings, taskManager, aboutWindow }
}
