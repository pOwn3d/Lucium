// Parts of main() (index.ts), moved out as they were: the window manager (every window that shows a browser), the windows an extension opens
// (chrome.windows.create), and a click on the icon of the Dock. Each function is called once, where its lines were, so that what it registers
// comes in the same order as before.

import { app, BrowserWindow, nativeTheme, WebContentsView, type WebContents, type WebPreferences } from 'electron'
import { t } from '@shared/i18n'
import { PRIVATE_BACKGROUND } from '@shared/private-window'
import { guestLabel } from '@shared/guest-window'
import { GUEST_QUERY, PRIVATE_QUERY, TRAFFIC_LIGHTS } from '@shared/ipc'
import { firstControlsOverlay } from '@shared/window-controls'
import type { ElectronEngine } from '../engine/electron-engine'
import type { HistoryBook } from '../history'
import type { currentPlatform } from '../platform'
import type { StateStore, WindowView } from '../store'
import { dockClickStep } from '../window-lifecycle'
import type { Browser } from './browser'
import type { LittleArc } from './little'
import type { OnDemandView } from './on-demand-view'
import type { SettingsWindow } from './settings-window'
import type { Surface } from './surface-load'
import { WindowManager } from './windows'

export interface WindowManagerWiring {
  engine: ElectronEngine
  sharedStore: StateStore
  views: Set<WindowView>
  history: HistoryBook
  /** Every window the engine can attach pages to. */
  windows: Map<string, BrowserWindow>
  webPreferences: WebPreferences
  platform: ReturnType<typeof currentPlatform>
  /** Loads a surface of the interface, locked to our own pages (index.ts, `load`). */
  load: (target: WebContents, surface: Surface) => void
  /** The floating sidebar of a window, made only while the window may show it (index.ts, `floatingSidebar`). */
  floatingSidebar: (webPreferences: WebPreferences, query?: Record<string, string>) => OnDemandView<WebContentsView>
  settings: SettingsWindow
  little: LittleArc
}

/** The window manager: the windows of the browser beside the first one (another window, a private one, a guest one), each with its interface. */
export function createWindowManager({ engine, sharedStore, views, history, windows, webPreferences, platform, load, floatingSidebar, settings, little }: WindowManagerWiring): WindowManager {
  return new WindowManager({
    engine,
    mainStore: sharedStore,
    views,
    history,
    windows,
    createChrome: (_id, bounds, privateWindow, guest = false) => {
      const extra = new BrowserWindow({
        ...bounds,
        minWidth: 720,
        minHeight: 480,
        show: false,
        title: guest ? guestLabel() : privateWindow ? t('menu.private-window-name') : 'Lucium',
        // A guest window is private underneath but wears nothing of the private look.
        backgroundColor: privateWindow && !guest ? PRIVATE_BACKGROUND : '#17171c',
        ...platform.windowFrame(TRAFFIC_LIGHTS, firstControlsOverlay(sharedStore.get().settings, { dark: nativeTheme.shouldUseDarkColors, privateBar: privateWindow && !guest })),
        webPreferences
      })
      const extraOverlay = new WebContentsView({ webPreferences })
      extraOverlay.setBackgroundColor('#00000000')
      // The query tells the UI (and its preload) it belongs to a private window.
      const query = privateWindow ? { [PRIVATE_QUERY]: '1', ...(guest ? { [GUEST_QUERY]: '1' } : {}) } : undefined
      const extraFloating = floatingSidebar(webPreferences, query)
      load(extra.webContents, { page: 'index', query })
      load(extraOverlay.webContents, { page: 'overlay', query })
      return { win: extra, overlay: extraOverlay, floating: extraFloating }
    },
    openSettings: (pane, anchor) => settings.open(pane, anchor),
    openLittle: (url, origin) => little.openLink(url, origin),
    systemDark: () => nativeTheme.shouldUseDarkColors,
    lastUserInputAt: () => engine.lastUserInputAt()
  })
}

/** chrome.windows.create: a popup is a small window of one page (the mini window's), anything else is a window of the browser. */
export function openExtensionWindows({ browser, windows, little, windowManager }: { browser: Browser; windows: Map<string, BrowserWindow>; little: LittleArc; windowManager: WindowManager }): void {
  browser.setExtensionWindows({
    create: async (details) => {
      if (details.type === 'popup') {
        const popup = windows.get(little.open(details.url ?? 'about:blank', details.profileId))
        if (!popup) throw new Error('The window was not created')
        if (details.width !== undefined && details.height !== undefined) popup.setContentSize(Math.max(480, Math.round(details.width)), Math.max(360, Math.round(details.height)))
        return popup.id
      }
      // The main window put away (macOS) comes back for it rather than a window beside a hidden one.
      const record = windowManager.newWindow({ commandBar: false })
      if (!record) throw new Error('The window was not created')
      await record.browser.openTabForExtension(details.url, true, details.profileId)
      if (details.focused) record.win.focus()
      return record.win.id
    },
    remove: (windowId) => BrowserWindow.fromId(windowId)?.close()
  })
}

/**
 * A click on the icon of the Dock while every window is minimized brings the last one back (macOS leaves them in the Dock), and the main window put away
 * when it was closed comes back with its state. The event also fires at launch, so nothing new is opened here: a new window is the Dock menu's
 * "Nouvelle fenêtre", ⌘N, or a second launch of the program.
 */
export function followDockClicks(windowManager: WindowManager): void {
  app.on('activate', () => {
    const step = dockClickStep(
      windowManager.list().map(({ win: each }) => {
        const destroyed = each.isDestroyed()
        return { destroyed, visible: !destroyed && each.isVisible(), minimized: !destroyed && each.isMinimized() }
      })
    )
    if (step === 'nothing') return
    // Every window is gone (the application is quitting): nothing to bring back (newWindow answers null then).
    if (step === 'open-window') {
      void windowManager.newWindow({ commandBar: false })
      return
    }
    const focused = windowManager.focused()
    if (focused.kind === 'main') return void windowManager.revealMain()
    const last = focused.win
    if (last.isDestroyed()) return
    if (last.isMinimized()) last.restore()
    last.show()
  })
}
