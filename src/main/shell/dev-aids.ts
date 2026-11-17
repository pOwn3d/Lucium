// A part of main() (index.ts), moved out as it was: an aid of a run from the sources, never of the built application (runtime.ts reads the
// variable and ignores it there).

import { app, type BrowserWindow } from 'electron'
import { resolveSettingsTarget } from '@shared/settings-catalog'
import type { WindowView } from '../store'
import type { Browser } from './browser'
import type { LittleArc } from './little'
import type { WindowManager } from './windows'

// Dev aid for visual checks: open a panel shortly after start (LUCIUM_DEBUG_PANEL=downloads|space|theme|settings[:pane]|find|findreplace|import|commandbar|boost|peek|about|private|window|autoreload).
export function openDebugPanelSoon(debugPanel: string, { browser, store, win, windowManager, little }: { browser: Browser; store: WindowView; win: BrowserWindow; windowManager: WindowManager; little: LittleArc }): void {
  setTimeout(() => {
    if (debugPanel === 'space' || debugPanel === 'theme') browser.openOverlay({ panel: debugPanel, spaceId: store.get().activeSpaceId })
    else if (debugPanel === 'downloads' || debugPanel === 'find' || debugPanel === 'findreplace' || debugPanel === 'import' || debugPanel === 'archive' || debugPanel === 'site' || debugPanel === 'sitedata' || debugPanel === 'spacecreate' || debugPanel === 'spaces' || debugPanel === 'history' || debugPanel === 'readlater') browser.openOverlay({ panel: debugPanel })
    else if (debugPanel === 'sessions') browser.openOverlay({ panel: 'sessions' })
    else if (debugPanel === 'autoreload') {
      const tabId = store.get().activeTabBySpace[store.get().activeSpaceId]
      if (tabId) browser.openOverlay({ panel: 'autoreload', tabId })
    }
    // LUCIUM_DEBUG_PANEL=settings:privacy opens a category; an old name (settings:security, settings:shortcuts) leads to the category, and the group, that took its place.
    else if (debugPanel.startsWith('settings')) browser.openOverlay({ panel: 'settings', ...(resolveSettingsTarget(debugPanel.split(':')[1] ?? 'home') ?? { pane: 'home' }) })
    else if (debugPanel === 'click-extension') {
      // Same click a user makes on the first extension icon of the sidebar toolbar.
      void win.webContents
        .executeJavaScript(`(() => { const b = document.querySelector('browser-action-list')?.shadowRoot?.querySelector('button, .action, [part=action]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
        .then((point: { x: number; y: number } | null) => {
          if (!point) return console.warn('[debug] no extension icon found')
          for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) {
            win.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
          }
        })
    } else if (debugPanel === 'private') {
      windowManager.openPrivate().browser.dispatch({ type: 'tab/open', url: 'https://example.com/' })
    } else if (debugPanel === 'window') windowManager.openWindow({ commandBar: false })
    else if (debugPanel === 'little') little.open('https://example.com/')
    else if (debugPanel === 'boost') browser.openOverlay({ panel: 'boost', host: 'example.com' })
    else if (debugPanel === 'peek') browser.openPeek('https://example.com/')
    else if (debugPanel === 'about') app.showAboutPanel()
    else if (debugPanel === 'commandbar') browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: process.env['LUCIUM_DEBUG_QUERY'] ?? 'yt ' })
  }, 4000)
}
