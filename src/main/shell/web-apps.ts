import { copyableUrl } from '@shared/copy-url'
import { clipboard, dialog, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { Channel, WEB_APP_HEADER_HEIGHT, type LittleCommand, type LittleState } from '@shared/ipc'
import { littleKeyCommand, type KeyInput } from '@shared/little-bar'
import { devToolsRequestForKey, type DevToolsRequest } from '@shared/devtools-request'
import { runDevTools } from './devtools-command'
import { isMainFrameSender } from '@shared/surface-guard'
import { shutByLock } from './lock-gate'
import { WEB_APPS_MAX, isWebAppUrl, staysInApp, type WebAppRequest } from '@shared/web-apps'
import { isPageOpenUrl } from '@shared/external-links'
import type { Engine, Page, PageUpdate } from '../engine/types'
import type { ControlsOverlay, Platform, WindowFrame } from '../platform'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

/**
 * The title-bar options of an application window. macOS hides the bar and keeps the three lights centred on the header; Windows hides it too and lays the
 * system's three buttons over the right end of the header (`overlay`: the header is as high as they are); elsewhere the system's own bar stays, because a hidden
 * bar without buttons has none at all (the page draws none): a window that could not be closed or minimised.
 */
export function webAppWindowFrame(platform: Pick<Platform, 'windowFrame'>, overlay?: ControlsOverlay): WindowFrame {
  return platform.windowFrame({ x: 12, y: Math.round((WEB_APP_HEADER_HEIGHT - 14) / 2) }, overlay)
}

interface AppWindow {
  id: string
  win: BrowserWindow
  /** Read at creation: a closed window no longer lets us reach its webContents. */
  webContentsId: number
  page: Page
  state: LittleState
  /** The page the window opened on: a link to another site goes to the browser, not here. */
  startUrl: string
  /** The space the page came from: a lock on it closes the window. */
  spaceId: string
}

export interface WebAppDeps {
  engine: Engine
  store: StateStore
  browser: Browser
  /** Windows by id, shared with the engine so that pages can attach to them. */
  windows: Map<string, BrowserWindow>
  /** Webcontents allowed to call the privileged IPC. */
  trusted: Set<number>
  /** Creates the BrowserWindow of an application (preload, frame style) and loads its UI. */
  createWindow: (id: string, request: WebAppRequest) => BrowserWindow
  focusMain: () => void
}

/**
 * Sites in windows of their own ("Ouvrir comme application", setting `webAppWindows`). A window has no sidebar and no toolbar: a thin header
 * with the icon and the name of the site, back, forward and reload, and the page below it, in the session of the space it came from. Created
 * only while the function is on (the application gates this object), at most `WEB_APPS_MAX` at a time, and closed with the function.
 * Nothing is kept: a closed window leaves no archive, no history entry of its own and no record that it existed.
 */
export class WebAppWindows {
  private readonly windows = new Map<string, AppWindow>()
  private counter = 0
  private stopped = false
  private readonly onAction = (event: IpcMainEvent, id: unknown, command: unknown): void => {
    const app = typeof id === 'string' ? this.windows.get(id) : undefined
    // The mini windows share this channel: an id that is not an application window is theirs.
    if (!app) return
    // Only the window's own UI may drive it, and only through its top frame.
    if (!isMainFrameSender(event)) return void console.warn('[web-app] ignored a command from a subframe')
    if (typeof command !== 'string' || app.webContentsId !== event.sender.id || shutByLock(Channel.littleAction)) return
    this.act(app, command as LittleCommand)
  }

  constructor(private readonly deps: WebAppDeps) {
    ipcMain.on(Channel.littleAction, this.onAction)
  }

  /** The function was switched off, or the application is quitting: the windows close and nothing listens any more. */
  stop(): void {
    this.stopped = true
    ipcMain.removeListener(Channel.littleAction, this.onAction)
    for (const app of [...this.windows.values()]) if (!app.win.isDestroyed()) app.win.close()
    this.windows.clear()
  }

  count(): number {
    return this.windows.size
  }

  /**
   * A lock holds spaces shut (or the whole application): the windows made from them close, and their pages go with them. A window that shows a
   * live page is what the lock is there to hide, and its header would still answer (Ouvrir dans un onglet).
   */
  closeLocked(isLocked: (spaceId: string) => boolean): void {
    for (const app of [...this.windows.values()]) {
      if (!isLocked(app.spaceId)) continue
      if (!app.win.isDestroyed()) app.win.close()
      // The window's own `closed` event does the same; a window already gone must not keep its page.
      this.cleanup(app)
    }
  }

  /** States of the open windows, for the engine smoke test. */
  states(): LittleState[] {
    return [...this.windows.values()].map((w) => w.state)
  }

  /** Opens a window for the request; null (and a notice) when it cannot: too many open, or not a web address. */
  open(request: WebAppRequest): string | null {
    if (this.stopped) return null
    if (!isWebAppUrl(request.url)) {
      console.warn('[web-app] refused an address that is not a web page')
      return null
    }
    if (this.windows.size >= WEB_APPS_MAX) {
      this.deps.browser.showToast(t('web-apps.deja-web-apps-max-fenetres-d-application', { WEB_APPS_MAX }))
      return null
    }
    const id = `webapp-${++this.counter}`
    const { engine, store } = this.deps
    const win = this.deps.createWindow(id, request)
    this.deps.windows.set(id, win)
    this.deps.trusted.add(win.webContents.id)
    const update = (patch: PageUpdate): void => {
      const current = this.windows.get(id)
      if (!current || patch.url?.startsWith('chrome-error://')) return
      current.state = {
        ...current.state,
        url: patch.url ?? current.state.url,
        title: patch.title ?? current.state.title,
        canGoBack: patch.canGoBack ?? current.state.canGoBack,
        canGoForward: patch.canGoForward ?? current.state.canGoForward
      }
      this.push(current)
    }
    const noop = (): void => {}
    // The window is the page's only home: no other window shows its tab, and the profile is the one of the space it came from (its cookies and logins).
    const page = engine.createPage(
      { id, profileId: request.profileId, windowId: id },
      {
        update,
        // A link that opens a window stays here when it is the same site, and goes to the browser as a tab otherwise.
        openWindow: (target) => {
          if (!isPageOpenUrl(target)) return void console.warn(`[web-app] ignored a link to a non-web address: ${String(target).split(':')[0]}:`)
          if (staysInApp(request.url, target)) this.windows.get(id)?.page.loadURL(target)
          else {
            this.deps.browser.dispatch({ type: 'tab/open', url: target })
            this.deps.focusMain()
          }
        },
        focused: noop,
        // The page of this window hides ads and banners like a tab's does.
        domReady: () => this.deps.browser.hideAdsOn(id, page, () => this.windows.get(id)?.state.url, () => this.windows.get(id)?.page === page),
        found: noop,
        searchSelection: noop,
        copyLink: (target) => copyableUrl(target, store.get().settings.stripCopiedLinks),
        // A page that closes itself takes its window with it.
        closed: () => this.windows.get(id)?.win.close(),
        devToolsFailed: (message) => this.tellToolsFailed(id, message),
        shortcut: (input) => this.shortcut(id, input)
      }
    )
    const app: AppWindow = {
      id,
      win,
      webContentsId: win.webContents.id,
      page,
      startUrl: request.url,
      spaceId: request.spaceId,
      state: { id, url: request.url, title: request.name, canGoBack: false, canGoForward: false, bar: false, downloads: [], spaces: [], app: { name: request.name, ...(request.icon ? { icon: request.icon } : {}) } }
    }
    this.windows.set(id, app)
    win.on('resize', () => this.layout(app))
    win.on('closed', () => this.cleanup(app))
    // The window keeps the name of the site: the title of the header's own page must not replace it.
    win.on('page-title-updated', (event) => event.preventDefault())
    // Keys of the header are the window's shortcuts too, before the menu bar can take them for the main window.
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && this.shortcut(id, input)) event.preventDefault()
    })
    win.webContents.once('did-finish-load', () => this.push(app))
    this.layout(app)
    page.loadURL(request.url)
    win.show()
    return id
  }

  /** Closes a window (the engine test uses it). */
  close(id: string): void {
    this.windows.get(id)?.win.close()
  }

  /** Runs a header command on a window exactly as its UI would (the engine test uses it). */
  command(id: string, command: LittleCommand): void {
    const app = this.windows.get(id)
    if (app) this.act(app, command)
  }

  private shortcut(id: string, input: KeyInput): boolean {
    const app = this.windows.get(id)
    if (!app) return false
    // ⌥⌘I, ⌥⌘J, ⌥⌘C and F12 open the tools of this window's page: left to the menu bar they would open those of a tab of the main window.
    const tools = devToolsRequestForKey(input, this.deps.store.get().settings.keyBindings)
    if (tools) {
      this.openTools(app, tools)
      return true
    }
    const command = littleKeyCommand(input, this.deps.store.get().settings.keyBindings)
    if (!command) return false
    this.act(app, command)
    return true
  }

  /** The developer tools of the window's page. A window like this has no toast: what failed is said in a box on the window. */
  private openTools(app: AppWindow, request: DevToolsRequest): void {
    void runDevTools(app.page, request, (message) => this.tellToolsFailed(app.id, message))
  }

  private tellToolsFailed(id: string, message: string): void {
    const win = this.windows.get(id)?.win
    if (win && !win.isDestroyed()) void dialog.showMessageBox(win, { type: 'warning', message })
  }

  private layout(app: AppWindow): void {
    if (app.win.isDestroyed()) return
    const { width, height } = app.win.getContentBounds()
    app.page.show({ x: 0, y: WEB_APP_HEADER_HEIGHT, width: Math.max(0, width), height: Math.max(0, height - WEB_APP_HEADER_HEIGHT) })
  }

  private push(app: AppWindow): void {
    const wc = app.win.webContents
    if (!app.win.isDestroyed() && !wc.isDestroyed()) wc.send(Channel.littleState, app.state)
  }

  private act(app: AppWindow, command: LittleCommand): void {
    switch (command) {
      case 'back':
        return app.page.goBack()
      case 'forward':
        return app.page.goForward()
      case 'reload':
        return app.page.reload()
      case 'copy-url':
        // Electron 45's clipboard is asynchronous: the tick only shows once the address is really there.
        return void clipboard.writeText(copyableUrl(app.state.url, this.deps.store.get().settings.stripCopiedLinks)).then(
          () => {
            app.state = { ...app.state, copiedAt: Date.now() }
            this.push(app)
          },
          (error: unknown) => console.error('[web-app] cannot copy the address:', error instanceof Error ? error.message : String(error))
        )
      case 'open-in-main':
        return this.promote(app)
      case 'close':
        return app.win.close()
      // The header listens now: what was sent as its page loaded may have come before it listened.
      case 'ready':
        return this.push(app)
      default:
      // The other commands (the space picker, the tray, the bar) belong to mini windows: an application window has none of them.
    }
  }

  /** "Ouvrir dans un onglet": the page on screen becomes a tab of the main window and the application window closes. */
  private promote(app: AppWindow): void {
    if (!isWebAppUrl(app.state.url)) return
    this.deps.browser.dispatch({ type: 'tab/open', url: app.state.url })
    if (!app.win.isDestroyed()) app.win.close()
    this.deps.focusMain()
  }

  private cleanup(app: AppWindow): void {
    if (!this.windows.delete(app.id)) return
    this.deps.trusted.delete(app.webContentsId)
    this.deps.windows.delete(app.id)
    this.deps.browser.forgetBlockerCss(app.id)
    app.page.destroy()
  }
}
