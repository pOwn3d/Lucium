// The windows of document Picture-in-Picture (`documentPictureInPicture.requestWindow()`, the floating window of a call), which Electron 45 does not show
// (electron/electron#39633). What is decided is in shared/document-pip.ts; this file does it with Electron.
//
// How Electron loses the window, read in Electron 45.2.1 (lib/browser/api/web-contents.ts, shell/browser/api/electron_api_web_contents.cc, and the
// strings of the installed framework): the page's request reaches `setWindowOpenHandler` with the disposition `other`; when the handler allows it,
// Chromium makes the window's web contents and hands it to the page's web contents through the internal event `-add-new-contents`
// (`WebContents::AddNewContents`); Electron's own listener of that event calls `event.preventDefault()` for every disposition but `foreground-tab`,
// `new-window`, `background-tab` and `save-to-disk`, and the C++ side then destroys the contents (`api_web_contents->Destroy()`).
//
// What this does: the first time a page of the tab is allowed such a window, Electron's listener of `-add-new-contents` on that page is replaced by one
// that takes the window the handler allowed (and that one only) and calls Electron's listener, unchanged, for everything else. The window taken is put,
// as it is, in a window of Lucium (`new WebContentsView({ webContents })`, Electron's documented way to adopt a web contents): it keeps the process,
// the session and the permissions of its page, it has no preload and no access to the interface (`window.lucium`), and it shows the one document its
// page writes into it. An Electron without that internal event (an update renamed it) is found before anything is allowed: the request is then
// refused, as it was before, with a line in the log.

import { BaseWindow, screen, WebContentsView, type WebContents, type WindowOpenHandlerResponse } from 'electron'
import { externalLinkOf, schemeOf } from '@shared/external-links'
import { pageDialogPreferences } from '@shared/page-dialog'
import { popupTitle, type Rect } from '@shared/popup'
import {
  adoptionVerdict,
  documentPipBounds,
  documentPipContentBounds,
  documentPipKey,
  DocumentPipTicket,
  DOCUMENT_PIP_DISPOSITION,
  DOCUMENT_PIP_MIN_SIZE,
  openerNavigationEnds,
  pipNavigationEnds
} from '@shared/document-pip'

/** Electron's internal event that hands a new window's web contents to the page that asked for it. Not documented: it may change with any version. */
export const ADD_NEW_CONTENTS = '-add-new-contents'

export interface DocumentPipDeps {
  /** Makes the window, not shown, whose content has `bounds`, with the site of the page in its title bar. */
  makeWindow(bounds: Rect, title: string): BaseWindow
  /** The view of Lucium the window shows: Electron adopts the web contents Chromium made, as it is. */
  makeView(contents: WebContents): WebContentsView
  /** The work area of the screen the user is on: the click that asked for the window was there. */
  workArea(): Rect
  now(): number
  platform: string
}

const electronDeps: DocumentPipDeps = {
  makeWindow: (bounds, title) =>
    new BaseWindow({
      ...bounds,
      useContentSize: true,
      minWidth: DOCUMENT_PIP_MIN_SIZE.width,
      minHeight: DOCUMENT_PIP_MIN_SIZE.height,
      show: false,
      title,
      fullscreenable: false,
      maximizable: false
    }),
  makeView: (contents) => new WebContentsView({ webContents: contents }),
  workArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
  now: () => Date.now(),
  platform: process.platform
}

interface Floating {
  key: string
  opener: WebContents
  contents: WebContents
  win: BaseWindow
  view: WebContentsView
  /** Takes back what was set on the page that opened the window. */
  unwatch: () => void
  over: boolean
}

type Listener = (...args: unknown[]) => unknown

const isContents = (value: unknown): value is WebContents =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number' && typeof (value as { isDestroyed?: unknown }).isDestroyed === 'function'

/** What the page's request reached Electron with, for the log (the window starts blank: there is no address to hide). */
const probeOf = (args: unknown[]): string => {
  const [, contents, disposition, userGesture, left, top, width, height, url, frameName] = args
  return JSON.stringify({
    disposition,
    userGesture,
    bounds: { left, top, width, height },
    url: typeof url === 'string' ? url.slice(0, 40) : typeof url,
    frameName: typeof frameName === 'string' ? frameName.slice(0, 40) : typeof frameName,
    contents: isContents(contents) ? `web contents ${contents.id}` : typeof contents
  })
}

export class DocumentPipWindows {
  private on = false
  /** The pages whose listener of `-add-new-contents` is ours already. */
  private readonly hooked = new WeakSet<WebContents>()
  /** The yes of the handler, page by page: one window per yes. */
  private readonly tickets = new WeakMap<WebContents, DocumentPipTicket>()
  /** The window of each tab: one at a time, a new one takes the place of the one before (as in Chromium). */
  private readonly open = new Map<string, Floating>()
  /** Where the user last left a window, and its size: the next one opens there (in this session). */
  private remembered: Rect | null = null
  private readonly deps: DocumentPipDeps

  constructor(deps: Partial<DocumentPipDeps> = {}) {
    this.deps = { ...electronDeps, ...deps }
  }

  /** The switch of the feature (`document-pip`). Off, nothing is allowed, and the windows that are open close. */
  setEnabled(on: boolean): void {
    this.on = on
    if (!on) this.closeAll('the feature was switched off')
  }

  enabled(): boolean {
    return this.on
  }

  /** How many windows are open (the engine check reads it). */
  count(): number {
    return this.open.size
  }

  /** The window of a tab and what it shows, if it has one (the engine check reads it). */
  windowOf(key: string): { win: BaseWindow; contents: WebContents } | undefined {
    const floating = this.open.get(key)
    return floating && !floating.over ? { win: floating.win, contents: floating.contents } : undefined
  }

  /** Closes every window; returns how many were open. */
  closeAll(why: string): number {
    const all = [...this.open.values()]
    for (const floating of all) this.end(floating, why)
    return all.length
  }

  /**
   * The handler's answer to a request the page may have (shared/document-pip.ts, `documentPipVerdict`): the options of the web contents Chromium is to
   * make, or null when this Electron gives no way to take the window (the request is then refused, as it always was).
   */
  request(opener: WebContents, key: string): WindowOpenHandlerResponse | null {
    if (!this.hook(opener)) return null
    let ticket = this.tickets.get(opener)
    if (!ticket) {
      ticket = new DocumentPipTicket()
      this.tickets.set(opener, ticket)
    }
    ticket.issue(this.deps.now(), key)
    return {
      action: 'allow',
      outlivesOpener: false,
      // The preferences of a page, said again: Electron gives the new contents these (`_setNextChildWebPreferences`), and no preload. The sandbox must be
      // the page's own: a different one would put the window in another process, without the page's hand on it.
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, ...pageDialogPreferences() }
      }
    }
  }

  /**
   * Puts our listener of `-add-new-contents` in the place of Electron's on this page, once: ours takes the window that was allowed and hands everything
   * else to Electron's listener, with the same arguments. False, with a line in the log, when Electron has no such listener (an update changed it).
   */
  private hook(opener: WebContents): boolean {
    if (this.hooked.has(opener)) return true
    const emitter = opener as unknown as NodeJS.EventEmitter
    const electrons = typeof emitter.rawListeners === 'function' ? (emitter.rawListeners(ADD_NEW_CONTENTS) as Listener[]) : []
    if (electrons.length === 0) {
      console.warn(`[pip] Electron has no listener of "${ADD_NEW_CONTENTS}" (an update changed how it hands new windows over): the document Picture-in-Picture window is refused, as before`)
      return false
    }
    emitter.removeAllListeners(ADD_NEW_CONTENTS)
    emitter.on(ADD_NEW_CONTENTS, (...args: unknown[]) => {
      if (this.handOver(opener, args)) return
      for (const listener of electrons) Reflect.apply(listener, opener, args)
    })
    this.hooked.add(opener)
    return true
  }

  /** A window Chromium hands to `opener`: true when it is ours and was taken, false to leave it to Electron (which destroys a document Picture-in-Picture window). */
  private handOver(opener: WebContents, args: unknown[]): boolean {
    const [, contents, disposition, , , , width, height] = args
    if (disposition !== DOCUMENT_PIP_DISPOSITION) return false
    console.info(`[pip] Electron handed over a document Picture-in-Picture window: ${probeOf(args)}`)
    const key = this.tickets.get(opener)?.take(this.deps.now()) ?? null
    const real = isContents(contents) && !contents.isDestroyed()
    const verdict = adoptionVerdict({ disposition, allowed: key !== null && this.on, contents: real, sameSession: real && contents.session === opener.session })
    if (!verdict.adopt || key === null || !real) {
      console.warn(`[pip] left a document Picture-in-Picture window to Electron, which closes it: ${verdict.adopt ? 'not allowed' : verdict.why}`)
      return false
    }
    try {
      // The size handed over with the window. Electron 45 hands 0 × 0 (the engine check's probe saw it): the size the page asked for travels in
      // Chromium's options of the window, which Electron does not pass on, so the window opens at the default size (shared/document-pip.ts).
      this.show(key, opener, contents, { width: typeof width === 'number' ? width : undefined, height: typeof height === 'number' ? height : undefined })
      return true
    } catch (error) {
      // Electron's listener then closes the window, as it would have without us: the page's request ends as it did before.
      console.error('[pip] cannot show a document Picture-in-Picture window:', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  private show(key: string, opener: WebContents, contents: WebContents, asked: { width: number | undefined; height: number | undefined }): void {
    const before = this.open.get(key)
    if (before) this.end(before, 'the page asked for another one')
    const view = this.deps.makeView(contents)
    const bounds = documentPipBounds({ ...(asked.width !== undefined ? { width: asked.width } : {}), ...(asked.height !== undefined ? { height: asked.height } : {}) }, this.deps.workArea(), this.remembered)
    const win = this.deps.makeWindow(bounds, popupTitle(opener.getURL(), ''))
    const floating: Floating = { key, opener, contents, win, view, unwatch: () => undefined, over: false }
    try {
      win.contentView.addChildView(view)
      this.wire(floating)
    } catch (error) {
      floating.unwatch()
      if (!win.isDestroyed()) win.destroy()
      throw error
    }
    this.open.set(key, floating)
    this.layout(floating)
    // Above the other windows, on every desktop (Space) of the Mac, as the floating video window; not above an application in full screen, which would have
    // Electron hide and show the Dock icon (`skipTransformProcessType`).
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
    // Shown without taking the focus: the user goes on in the call, in the window they were in.
    win.showInactive()
    console.info(`[pip] showed the document Picture-in-Picture window of tab ${key}`)
  }

  private wire(floating: Floating): void {
    const { contents, opener, win } = floating
    const end = (why: string) => () => this.end(floating, why)

    // The window shows the document its page writes into it: a navigation of its own closes it, as in Chromium, and goes nowhere.
    contents.on('will-navigate', (event) => {
      event.preventDefault()
      this.end(floating, 'it was sent to an address')
    })
    contents.on('did-start-navigation', (details) => {
      if (pipNavigationEnds(details)) this.end(floating, 'it went to another document')
    })
    // A frame inside it hands no address to another application.
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || !externalLinkOf(event.url)) return
      event.preventDefault()
      console.warn(`[pip] kept a frame of a document Picture-in-Picture window from opening a ${schemeOf(event.url)} link`)
    })
    // It opens no window: not a tab, not a popup, not another floating window.
    contents.setWindowOpenHandler((details) => {
      console.warn(`[pip] a document Picture-in-Picture window asked for a window (${String(details.disposition)}): refused`)
      return { action: 'deny' }
    })
    contents.on('before-input-event', (event, input) => {
      const action = documentPipKey(input, this.deps.platform)
      if (action === 'pass') return
      event.preventDefault()
      if (action === 'close') this.end(floating, 'the user closed it')
    })
    // The user closing it is never held back by the page.
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    // `resizeTo` / `moveTo`: within the bounds it opened with.
    contents.on('content-bounds-updated', (event, requested) => {
      event.preventDefault()
      if (!win.isDestroyed()) win.setContentBounds(documentPipContentBounds(requested, this.deps.workArea()))
    })
    // The page closed it (`pipWindow.close()`), or its process went.
    contents.once('destroyed', end('its page closed it'))
    contents.on('render-process-gone', end('its page crashed'))

    // It goes with the page that opened it: a tab closed, put to sleep or locked away (its page is destroyed), another document, a crash.
    const openerGone = end('its tab closed')
    const openerCrashed = end('its tab crashed')
    const openerNavigated = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (openerNavigationEnds(details)) this.end(floating, 'its tab went to another document')
    }
    opener.once('destroyed', openerGone)
    opener.on('render-process-gone', openerCrashed)
    opener.on('did-start-navigation', openerNavigated)
    floating.unwatch = () => {
      opener.removeListener('destroyed', openerGone)
      opener.removeListener('render-process-gone', openerCrashed)
      opener.removeListener('did-start-navigation', openerNavigated)
    }

    win.on('resize', () => {
      this.layout(floating)
      this.remember(floating)
    })
    win.on('move', () => this.remember(floating))
    win.on('closed', end('the user closed it'))
  }

  private layout(floating: Floating): void {
    if (floating.over || floating.win.isDestroyed()) return
    const { width, height } = floating.win.getContentBounds()
    floating.view.setBounds({ x: 0, y: 0, width, height })
  }

  private remember(floating: Floating): void {
    if (!floating.over && !floating.win.isDestroyed()) this.remembered = floating.win.getContentBounds()
  }

  /** Ends a window: the page sees it closed (as when it closes it itself), and nothing of it is left on the page that opened it. */
  private end(floating: Floating, why: string): void {
    if (floating.over) return
    floating.over = true
    if (this.open.get(floating.key) === floating) this.open.delete(floating.key)
    floating.unwatch()
    console.info(`[pip] the document Picture-in-Picture window of tab ${floating.key} closed: ${why}`)
    if (!floating.contents.isDestroyed()) floating.contents.close()
    if (!floating.win.isDestroyed()) floating.win.destroy()
  }
}
