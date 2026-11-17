// A part of main() (index.ts), moved out as it was: the gate of « Ouvrir un site comme application ». Called once, where its lines were
// (after the gates exist, before the automatic update): what it installs comes in the same order as before.

import { BrowserWindow, screen, type WebContents, type WebPreferences } from 'electron'
import { littleWindowBounds } from '@shared/little-window'
import type { ElectronEngine } from '../engine/electron-engine'
import type { WindowView } from '../store'
import { Browser } from './browser'
import type { FeatureGates } from './feature-gate'
import type { Surface } from './surface-load'
import { WebAppWindows, webAppWindowFrame } from './web-apps'
import { currentPlatform } from '../platform'

export interface WebAppsDeps {
  gates: FeatureGates
  engine: ElectronEngine
  /** The view of the first window on the shared state. */
  store: WindowView
  /** The browser of the first window. */
  browser: Browser
  /** Every window the engine can attach pages to. */
  windows: Map<string, BrowserWindow>
  /** The web contents of our own interface. */
  trusted: Set<number>
  focusMain: () => void
  webPreferences: WebPreferences
  /** Loads a surface of the interface, locked to our own pages (index.ts, `load`). */
  load: (target: WebContents, surface: Surface) => void
}

/** Gates the manager of the application windows; answers the one that runs now, or null while the setting is off. */
export function installWebApps({ gates, engine, store, browser, windows, trusted, focusMain, webPreferences, load }: WebAppsDeps): () => WebAppWindows | null {
  // Settings › Fonctions › "Ouvrir un site comme application": the manager of the application windows exists while the setting is on (it listens to the
  // IPC of its windows and nothing else); switching the setting off closes the windows and removes the listener. A private window never opens one.
  let webApps: WebAppWindows | null = null
  gates.gate('pwa', {
    start: () => {
      const apps = new WebAppWindows({
        engine,
        store,
        browser,
        windows,
        trusted,
        focusMain,
        createWindow: (id, request) => {
          const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
          const aw = new BrowserWindow({
            ...littleWindowBounds(area),
            minWidth: 480,
            minHeight: 360,
            show: false,
            title: request.name,
            backgroundColor: '#17171c',
            // The lights are centred on the header (WEB_APP_HEADER_HEIGHT); elsewhere the system's title bar stays (the platform layer).
            ...webAppWindowFrame(currentPlatform()),
            webPreferences
          })
          load(aw.webContents, { page: 'littlearc', query: { id, app: '1' } })
          return aw
        }
      })
      Browser.setWebAppOpener((request) => apps.open(request))
      webApps = apps
      return () => {
        Browser.setWebAppOpener(null)
        apps.stop()
        if (webApps === apps) webApps = null
      }
    }
  })
  return () => webApps
}
