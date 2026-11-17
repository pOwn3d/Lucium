import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { SettingsAnchor, SettingsPane } from '@shared/ipc'
import { settingsHash, settingsResumePlace, showHashScript, type SettingsResumePlace } from '@shared/settings-target'
import type { Browser } from './browser'
import { currentPlatform } from '../platform'
import type { WindowSizes } from '@shared/panel-scale'
import { t } from '@shared/i18n'

/**
 * How the window looks: 684 x 650 was too small for the 14 categories (almost every pane scrolled, with a bar beside it), so it opens at 780 x 760 inside,
 * and one can resize it down to 684 x 650. The title and the tabs are drawn by the page under the traffic lights. Its colours are the tokens', light or dark
 * like the system: the background is not here, it is given when the window is created (`panelWindowBackground`), because the appearance is
 * known then and not before.
 */
export const SETTINGS_WINDOW_OPTIONS: BrowserWindowConstructorOptions & WindowSizes = {
  width: 780,
  height: 760,
  minWidth: 684,
  minHeight: 520,
  useContentSize: true,
  resizable: true,
  maximizable: false,
  fullscreenable: false,
  show: false,
  get title() { return t('settings.reglages') },
  ...currentPlatform().windowFrame({ x: 9, y: 9 })
}

export interface SettingsWindowDeps {
  browser: Browser
  /** Webcontents allowed to call the privileged IPC. */
  trusted: Set<number>
  /** Creates the window and loads the Settings UI on `pane`. */
  createWindow: (pane: SettingsPane, anchor?: SettingsAnchor) => BrowserWindow
  /** Called when a window opens, so the UI can come to the front. */
  onOpen?: () => void
}

/**
 * The Settings window: a window of its own, reused when it is already open. It renders the same state
 * snapshots as the main window and drives the same IPC, so it is a trusted surface while it exists.
 */
export class SettingsWindow {
  private win: BrowserWindow | null = null
  // The page and the subpage the window showed when it closed last, in this session only (nothing is written): asked for no place, it opens there again.
  private resume: SettingsResumePlace | null = null

  constructor(private readonly deps: SettingsWindowDeps) {}

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  /**
   * Opens the window at `pane` (and `anchor`): a menu, a link of a panel, a typed address always open the place they name. Asked for no place (Réglages…,
   * ⌘,), the window opens on the page and the subpage it showed when it was closed last in this session, « Pour commencer » the first time; already open,
   * it stays where it is.
   */
  open(pane?: SettingsPane, anchor?: SettingsAnchor): void {
    const existing = this.win
    if (existing && !existing.isDestroyed()) {
      // The UI listens to the URL hash for the pane to show (and sends the event itself when the hash is the one it already has).
      if (pane !== undefined) void existing.webContents.executeJavaScript(showHashScript(settingsHash(pane, anchor))).catch((error: unknown) => console.error('[settings] cannot switch pane:', error))
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const place = pane !== undefined ? { pane, anchor } : (this.resume ?? { pane: 'home' as const })
    const win = this.deps.createWindow(place.pane, place.anchor)
    this.win = win
    const id = win.webContents.id
    this.deps.trusted.add(id)
    this.deps.browser.addSurface(win.webContents)
    // ⌘W closes this window, not the tab of the main window behind it (menu shortcuts run before the page sees keys).
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key.toLowerCase() === 'w' && (input.meta || input.control)) {
        event.preventDefault()
        win.close()
      }
    })
    win.once('ready-to-show', () => win.show())
    // Read while the page is still there: the address says the page and the subpage it shows (the window keeps it up to date as one moves).
    win.on('close', () => {
      if (!win.webContents.isDestroyed()) this.resume = settingsResumePlace(win.webContents.getURL())
    })
    win.on('closed', () => {
      this.deps.trusted.delete(id)
      this.deps.browser.removeSurface(id)
      if (this.win === win) this.win = null
    })
  }

  close(): void {
    if (this.isOpen()) this.win!.close()
  }
}
