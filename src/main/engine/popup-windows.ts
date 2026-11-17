// Popup windows of pages (see shared/popup.ts for what is decided). A page that opens a window with a feature list gets a real window, so
// that `window.open` returns an object and `window.opener`, `postMessage` and `window.close()` work: sign-in with Google, Apple or
// Microsoft, PayPal and 3-D Secure all talk to the page that opened them that way.
//
// A popup is a web page and nothing more. It has no preload and no access to the interface (`window.lucium`), it is not a tab (nothing
// of it reaches the saved state, the extensions or the sidebar), it lives in the session of the page that opened it (the profile, or the
// memory-only session of a private window), and it goes through the hooks of that session like a tab does: permissions, downloads,
// request filter, privacy options. What a tab has on the web contents itself (certificate errors, error pages, HTTPS first, the key
// shortcuts) is given to it again here, since the page that opened it holds those for its own contents only.

import { BrowserWindow, screen, type HandlerDetails, type WebContents, type WindowOpenHandlerResponse } from 'electron'
import { parseErrorAction } from '@shared/error-pages'
import { externalLinkOf, GestureLedger, isPageOpenUrl, OPEN_GESTURE_WINDOW_MS, schemeOf } from '@shared/external-links'
import { pageDialogPreferences } from '@shared/page-dialog'
import { MAX_POPUPS_PER_TAB, POPUP_MIN_SIZE, PopupLimiter, planOpen, popupBounds, popupContentBounds, popupKey, popupTitle, type OpenPlan } from '@shared/popup'
import { isDocumentPipRequest } from '@shared/document-pip'
import type { AutoplayMode } from '@shared/autoplay'
import { webAutoplayPolicy } from './autoplay'
import { PageErrors } from './error-pages'
import type { HttpsUpgrades } from './https-upgrade'
import type { PageEvents } from './types'
import { currentPlatform } from '../platform'

/** The page (a tab, a Glance, a popup) that opens popups, and what they need of it. */
export interface PopupOwner {
  /** The tab every popup of this owner counts for: the popup of a popup counts for the tab it all started from. */
  key: string
  contents: WebContents
  /** The window the owner is in: a new popup is centred on it. */
  win: BrowserWindow
  /** Where a link inside a popup goes: it opens in the tab that opened the popup, as a link of that tab would. */
  events: PageEvents
  /** The private window the owner is in (the key of its session), or null for a normal one: a private window's popups are its own. */
  scope: string | null
}

interface Popup {
  win: BrowserWindow
  contents: WebContents
  id: number
  opener: number
  key: string
  scope: string | null
  gesture: GestureLedger
}

export class PopupWindows {
  private readonly limiter = new PopupLimiter()
  private readonly open = new Set<Popup>()

  constructor(
    private readonly upgrades: HttpsUpgrades,
    /** The user's general autoplay choice: a popup is made when the page asks, with no site of its own to look up. */
    private readonly autoplay: () => AutoplayMode,
    /** Get the toggleBlockException handler for a page/tab. */
    private readonly getToggleBlockHandler: (pageId: string) => ((url: string) => void) | undefined = () => undefined
  ) {}

  /** Starts listening for the windows `owner` opens (a window made without `request` saying yes never gets here: the handler denies the rest). */
  watch(owner: PopupOwner): void {
    owner.contents.on('did-create-window', (win) => this.adopt(owner, win))
  }

  /**
   * The answer to a `window.open` that asks for a popup: the options of the window Electron is to create (its size asked for and bounded,
   * centred on the opener, no preload), or null when the tab already has its share of popups. What the popup is then made into is `adopt`.
   */
  request(owner: PopupOwner, details: HandlerDetails, plan: Extract<OpenPlan, { kind: 'popup' }>): WindowOpenHandlerResponse | null {
    if (!this.limiter.canOpen(owner.key)) {
      console.warn(`[engine] refused a popup: the tab already has ${MAX_POPUPS_PER_TAB}`)
      return null
    }
    const parent = owner.win.getBounds()
    const bounds = popupBounds(plan.size, parent, screen.getDisplayMatching(parent).workArea)
    return {
      action: 'allow',
      // Closed with the page that opened it (and, one by one, the popups of that popup): the window of a tab that is closed leaves nothing behind.
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        ...bounds,
        useContentSize: true,
        // Content sizes (`useContentSize`): the page cannot ask for less than this, nor can the window be dragged below it.
        minWidth: POPUP_MIN_SIZE.width,
        minHeight: POPUP_MIN_SIZE.height,
        // Shown once it is wired (see `adopt`): a navigation guard that comes after the first load guards nothing.
        show: false,
        title: popupTitle(details.url, ''),
        autoHideMenuBar: true,
        fullscreenable: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, ...pageDialogPreferences(), autoplayPolicy: webAutoplayPolicy(this.autoplay()) }
      }
    }
  }

  /** Whether this web contents is a popup, and the tab that opened it: what a prompt or a download of a popup is shown under. */
  ownerKeyOf(contents: WebContents | null | undefined): string | undefined {
    if (!contents) return undefined
    for (const popup of this.open) if (popup.id === contents.id) return popup.key
    return undefined
  }

  /** The window of a popup, or undefined when this web contents is not one. */
  windowOf(contents: WebContents | null | undefined): BrowserWindow | undefined {
    if (!contents) return undefined
    for (const popup of this.open) if (popup.id === contents.id) return popup.win
    return undefined
  }

  /** The processes of the popups that are open, by the name the task manager shows. A private window's popups are listed for it alone (`scope`). */
  processes(scope: string | null): Array<{ pid: number; title: string }> {
    const rows: Array<{ pid: number; title: string }> = []
    for (const popup of this.open) {
      if (popup.scope !== scope || popup.win.isDestroyed() || popup.contents.isDestroyed()) continue
      const pid = popup.contents.getOSProcessId()
      if (pid > 0) rows.push({ pid, title: popup.win.getTitle() })
    }
    return rows
  }

  /** How many popups are open (the engine test reads it). */
  count(): number {
    return this.open.size
  }

  private adopt(owner: PopupOwner, win: BrowserWindow): void {
    const release = this.limiter.acquire(owner.key)
    if (!release) {
      // The window exists already: the handler's answer was not enough to stop it (two requests raced).
      console.warn(`[engine] closed a popup: the tab already has ${MAX_POPUPS_PER_TAB}`)
      win.destroy()
      return
    }
    const contents = win.webContents
    const popup: Popup = { win, contents, id: contents.id, opener: owner.contents.id, key: owner.key, scope: owner.scope, gesture: new GestureLedger() }
    this.open.add(popup)
    win.once('closed', () => {
      release()
      this.open.delete(popup)
      this.upgrades.detach(popup.id)
    })
    try {
      this.wire(owner, popup)
      // It may open popups of its own, which count for the same tab.
      this.watch({ ...owner, contents, win })
    } catch (error) {
      // A popup that is not wired is not shown: it is a page without its guards.
      console.error('[engine] closed a popup that could not be set up:', error instanceof Error ? error.message : String(error))
      win.destroy()
      return
    }
    win.show()
  }

  private wire(owner: PopupOwner, popup: Popup): void {
    const { win, contents, id } = popup
    // The title bar is the only thing that says whose page this is: the host first, then the page's own title.
    const retitle = (title: string = contents.getTitle()) => {
      if (!win.isDestroyed() && !contents.isDestroyed()) win.setTitle(popupTitle(contents.getURL(), title))
    }
    win.on('page-title-updated', (event, title) => {
      event.preventDefault()
      retitle(title)
    })
    contents.on('did-navigate', () => retitle())
    contents.on('did-navigate-in-page', () => retitle())
    retitle('')
    // No menu bar of its own (on macOS the menu is the application's, and there is no per-window one to remove).
    currentPlatform().removeWindowMenu(win)

    // A real input is what lets the page open another window (the same rule as for a tab).
    contents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown' || input.type === 'mouseUp' || input.type === 'keyDown' || input.type === 'rawKeyDown') popup.gesture.note(Date.now())
    })
    // The menu of the application belongs to the tabs: ⌘W closes this window, not the tab behind it.
    contents.on('before-input-event', (event, input) => {
      const action = popupKey(input, process.platform)
      if (action === 'pass') return
      event.preventDefault()
      if (action === 'close') win.close()
      else if (action === 'reload') contents.reload()
    })
    // The user closing the window is never held back by a page asking to confirm leaving it.
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    // `window.resizeTo` / `moveTo`: the page may size and place its window within the bounds it was made with (shared/popup.ts), not hide it or push it off the screen.
    contents.on('content-bounds-updated', (event, requested) => {
      event.preventDefault()
      if (win.isDestroyed()) return
      win.setContentBounds(popupContentBounds(requested, screen.getDisplayMatching(win.getBounds()).workArea))
    })

    // Only the web, and the blank page the window starts from: whatever sends the popup elsewhere (a link, a script, a redirect) is stopped.
    const guard = (event: { preventDefault(): void }, url: string): void => {
      // The buttons of an error page are links of ours, answered by `PageErrors`.
      if (isPageOpenUrl(url) || parseErrorAction(url) !== null) return
      event.preventDefault()
      console.warn(`[engine] kept a popup from going to ${schemeOf(url)}`)
    }
    contents.on('will-navigate', (event, url) => guard(event, url))
    contents.on('will-redirect', (event, url) => guard(event, url))
    // A frame inside the popup cannot hand an address to another application either: a popup opens no mail or telephone link.
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || !externalLinkOf(event.url)) return
      event.preventDefault()
      console.warn(`[engine] kept a frame of a popup from opening a ${schemeOf(event.url)} link`)
    })

    // No `login` handler on purpose: a login asked by a server (401, 407) would be shown in the window of the tab, behind this one, and Electron
    // refuses the request when nobody answers it (the page then shows what the server sent).

    // The error pages, the certificates the user has not agreed to, a page that crashed: what a tab shows, with the same words.
    const errors = new PageErrors(contents, {
      win,
      radius: 0,
      reload: () => contents.reload(),
      goBack: () => contents.navigationHistory.goBack(),
      announceUrl: () => retitle(),
      upgradeFailed: (url, code, certificate) => this.upgrades.failed(id, url, code, certificate),
      continueOverHttp: (http) => this.upgrades.continueOverHttp(id, http),
      toggleBlockException: (url) => {
        const handler = this.getToggleBlockHandler(owner.key)
        if (handler) handler(url)
      }
      // No `developerSite`: a popup has no address bar to say « Non sécurisé », so a certificate of a site in Developer Mode is asked for there.
    })
    const place = () => {
      if (win.isDestroyed()) return
      const [width, height] = win.getContentSize()
      errors.place({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 }, 0)
    }
    win.on('resize', place)
    place()
    win.once('closed', () => errors.dispose())

    // HTTPS first: the address of a popup is upgraded, and falls back to http, like a tab's.
    this.upgrades.attach(id, {
      navigate: (url) => void contents.loadURL(url).catch((error: unknown) => console.warn('[engine] a popup could not go back to http:', error instanceof Error ? error.message : String(error))),
      isLoading: () => !contents.isDestroyed() && contents.isLoading(),
      stop: () => contents.stop(),
      fellBack: (host) => owner.events.httpsFallback?.(host)
    })
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.upgrades.navigationStarted(id, details.url)
    })
    contents.on('did-navigate', () => this.upgrades.committed(id))

    // What the popup opens: another popup when it asks for one, else a link, which is the tab's to open.
    contents.setWindowOpenHandler((details) => {
      const { url } = details
      // A popup floats no document (`documentPictureInPicture.requestWindow()`): refused, and never made a blank tab of the window behind.
      if (isDocumentPipRequest(details)) console.warn('[engine] refused a document Picture-in-Picture window asked by a popup')
      else if (externalLinkOf(url)) console.warn(`[engine] blocked a popup opening a ${schemeOf(url)} link`)
      else if (!isPageOpenUrl(url)) console.warn(`[engine] blocked window.open to ${schemeOf(url)} from a popup`)
      else if (!popup.gesture.take(Date.now(), OPEN_GESTURE_WINDOW_MS)) console.warn('[engine] ignored a window.open in a popup that no click explains')
      else {
        const plan = planOpen(details)
        if (plan.kind === 'popup') {
          const response = this.request({ ...owner, contents, win }, details, plan)
          if (response) return response
        } else {
          owner.events.openWindow(url, plan.mode, true)
        }
      }
      return { action: 'deny' }
    })
  }
}
