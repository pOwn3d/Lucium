// The first layer of ElectronPage (electron-page.ts): what a page holds (its view, its window, what it remembers of its document), what it
// says of itself, the frames it reaches, the style sheets it carries and where its view stands in the window. Cut out of electron-page.ts
// as it was: a file per responsibility, one object at run time. The layers, in order: base, navigation, content, media, lifecycle, ElectronPage.

import { BrowserWindow, type WebContents, type WebContentsView, type WebFrameMain } from 'electron'
import { DialogGuard } from '@shared/page-dialog'
import { LoadingTimer } from './loading-timer'
import { HeadingNavigation } from './heading-navigation'
import { PAGE_RADIUS } from '@shared/split'
import { GestureLedger, OPEN_GESTURE_WINDOW_MS } from '@shared/external-links'
import { PageErrors } from './error-pages'
import { LeaveGate } from './unload-guard'
import { ReaderMode } from './reader-mode'
import { NO_PAGE_TOOLS, type PageTools } from '@shared/page-tools'
import { MarkdownPicker } from './markdown-picker'
import { LanguageReads } from './language-reads'
import { ColorSchemeEmulation } from './color-scheme'
import { RegexFinder } from './regex-find'
import type { Bounds, CssSlot, PageEvents } from './types'
import { MEDIA_SCRIPT_TIMEOUT_MS } from './electron-page-scripts'

export abstract class ElectronPageBase {
  protected attached = false
  /** The window the view is lent to (`lendView`), with what ends the loan; null while the view is the tab's. */
  protected loan: { host: BrowserWindow; end: (why: 'gone' | 'crashed' | 'navigated' | 'given') => void } | null = null
  /** The user was told about a window this document tried to open without a click (once per document: see `PageEvents.popupBlocked`). */
  protected popupNoticed = false
  /** This document was asked about a link to another application that no click explained (once per document: see `openAppLink`). */
  protected appLinkAsked = false
  /** The same, for a link asked by a frame of another site or by nobody named: kept apart, so that such a frame cannot spend the page's one question. */
  protected frameAppLinkAsked = false
  /** A question about a link to another application is on show: a second link does not queue another behind it. */
  protected appLinkPending = false
  /** The corner radius the page's view has now (see `show`). */
  protected radius = PAGE_RADIUS
  protected closing = false
  /** A close for a sleep under way (`release`): answered by the end of the page, or by its refusal (`will-prevent-unload`). */
  protected releasing: { settle: (gone: boolean) => void; promise: Promise<boolean> } | null = null
  /** The last click or key in this page: what lets a `mailto:` or `tel:` link leave the browser, or `window.open` open a tab (see `openExternalLink`). */
  protected readonly gesture = new GestureLedger()
  /** The same input, kept apart for sharing the screen: a click that opened a window may also be the click on "Present", and neither must use the other up. */
  protected readonly shareGesture = new GestureLedger()
  /**
   * The last click anywhere in the tab, the frames of other sites included (`before-mouse-event`), which `gesture` does not hear. It only ever
   * opens a window for the frame that was clicked (`clickedFrameOpens`), and one click opens one window.
   */
  protected readonly frameGesture = new GestureLedger()
  protected readonly cssKeys = new Map<string, string>()
  private cssQueue: Promise<void> = Promise.resolve()
  /** Frozen through the DevTools protocol (see `freeze`). */
  protected frozen = false
  /** The camera, the microphone or the screen was given to this document (see `usesCapture`). */
  protected capturing = false
  /** Freezes and thaws run one after the other: a thaw asked while a freeze is under way must come after it. */
  protected lifecycle: Promise<unknown> = Promise.resolve()
  /** The error pages of this page: a failed load, a refused certificate, a crashed renderer. */
  protected errors!: PageErrors
  /** Reader mode: the article of the page on its own, in a cover (see ReaderMode). */
  protected reader!: ReaderMode
  /** Markdown export: the selection and the blocks picker, run in an isolated world of the page (see MarkdownPicker). */
  protected markdown!: MarkdownPicker
  /** The regular-expression search, made when it is first asked for: a tab nobody searched this way holds nothing for it (see RegexFinder). */
  protected regexFinder: RegexFinder | null = null
  /** The level of the tab for the media player (see `setVolume`); a new document asks for it when it starts. */
  protected volume = 1
  /** The previous / next track handlers the site registered with MediaSession, as its main frame reported them. */
  protected trackActions = { previous: false, next: false }
  /** The `prompt()` boxes this document has opened: what lets the user stop a page that keeps asking. A new document starts again. */
  protected readonly dialogGuard = new DialogGuard()
  /** What the page's `beforeunload` handler is answered with (see unload-guard.ts): a sheet of ours for the navigations the shell starts, the system box for the others. */
  protected leave!: LeaveGate
  /** The in-page tools this page is to carry, and the ones installed in the document on screen (a new document has none). */
  protected tools: PageTools = NO_PAGE_TOOLS
  protected readonly installedTools = new Set<keyof PageTools>()
  /** The secret the tools of this page sign their console lines with, drawn the first time one is needed. */
  protected toolNonce: string | null = null
  protected listeningForTools = false
  /** Reading the selection aloud is going on (the page tells when it ends). */
  protected speaking = false
  /**
   * The menu of a right click is held while the mouse gestures may be being drawn: it opens when the button is released without a gesture
   * (the script says so), or at once if the script never answers (see `holdMenu`).
   */
  protected held: { params: Electron.ContextMenuParams; timer: NodeJS.Timeout } | null = null
  /** The last button pressed in the page was the right one, and has not been released. */
  protected rightDown = false
  protected verdict: { plain: boolean; at: number } | null = null
  /** The listener of `watchKeys`, kept to be taken off again. */
  protected keyListener: ((event: Electron.Event, input: Electron.Input) => void) | null = null
  /** What hangs from the window of the page (the error pages, reader mode, the popups it opens): they follow it to another window (see `moveToWindow`). */
  protected readonly hangers: Array<{ win: BrowserWindow }> = []
  /** Forces the end of loading for SPAs (like WhatsApp) that don't fire did-stop-loading. */
  protected readonly loadingTimer = new LoadingTimer()
  /** The lang attribute of the page on screen ("" when it has none or it could not be read). */
  protected pageLang = ''
  /** The language last published for the document (`PageUpdate.pageLanguage`): '' for a page in the target language, which publishes nothing. */
  protected publishedLang = ''
  /** What the page reads of `prefers-color-scheme`, when the setting « Apparence demandée aux sites » is not Automatique (engine/color-scheme.ts). */
  protected colorScheme!: ColorSchemeEmulation
  /** An extension's protocol session (chrome.debugger) is on the page: the only session `debugSend` and `isDebugAttached` speak of. */
  protected extensionDebug = false
  /** Whether the page is on its way to the Extensions page, before its document commits: no extension session may be on the page until it is over. */
  protected readonly heading = new HeadingNavigation()
  /** Whether the language of the document on show is still to be read (once per document, see LanguageReads). */
  protected readonly langReads = new LanguageReads()

  /**
   * What the layers below the last one read. `errors`, `reader`, `markdown`, `leave` and `colorScheme` are made by the constructor of
   * ElectronPage, once, with the listeners it wires: nothing else assigns them.
   */
  constructor(
    readonly id: string,
    readonly view: WebContentsView,
    protected win: BrowserWindow,
    protected readonly events: PageEvents,
    /** The window a `moveToWindow` takes the page to (undefined: it cannot go there); none for a page that never leaves its window. */
    protected readonly relocate: ((windowId: string | undefined) => BrowserWindow | undefined) | undefined,
    /** The proxy change of the page's session that is still under way, if any: the first navigation waits for it. */
    protected readonly networkSettled: () => Promise<void> | undefined,
    /** The window of the application a `lendView` lends the view to (undefined: it cannot go there); none for a page that is never lent. */
    protected readonly lendHost: ((windowId: string) => BrowserWindow | undefined) | undefined
  ) {}

  get webContents(): WebContents {
    return this.view.webContents
  }

  /** The window the page was created for. */
  get window(): BrowserWindow {
    return this.win
  }

  /** The page's screen sharing took a window (`picked`, see the picker of getDisplayMedia): the browser decides whether it is one of Lucium's. */
  ownWindowShared(picked: string): void {
    this.events.ownWindowShared?.(picked)
  }

  /** Whether the user clicked or pressed a key in this page just now, and uses that input up: what lets a page ask to share the screen. */
  takeShareGesture(now: number): boolean {
    return this.shareGesture.take(now, OPEN_GESTURE_WINDOW_MS)
  }

  /** Whether the user clicked or pressed a key in this page within the last few seconds; the input is not used up. A page asking to use a device must have one. */
  hadRecentInput(now: number): boolean {
    return this.shareGesture.fresh(now, OPEN_GESTURE_WINDOW_MS)
  }

  /** The camera, the microphone or the screen was just given to this page (the permission handler of the engine says so). */
  noteCapture(): void {
    this.capturing = true
  }

  usesCapture(): boolean {
    return this.capturing && !this.gone
  }

  /**
   * A server asked this page for a client certificate and was given none (shell/certificates.ts): the shell says so in the window of the page.
   * False when nothing is wired to say it.
   */
  clientCertificateRefused(site: string): boolean {
    if (!this.events.clientCertificateRefused) return false
    this.events.clientCertificateRefused(site)
    return true
  }

  /** Tells the shell the system will not let the application see the screen (`openSettings`: the notice offers the system pane that changes it). */
  screenShareBlocked(notice: string, openSettings?: boolean): void {
    this.events.screenShareBlocked?.(notice, openSettings)
  }

  /** The web contents while it is alive: a page that closed itself or was destroyed has none, and the tab events of a closing tab still ask. */
  liveContents(): WebContents | undefined {
    const wc = this.view.webContents as WebContents | undefined
    return wc && !wc.isDestroyed() ? wc : undefined
  }

  /** After `close()`, Electron makes `view.webContents` undefined: asynchronous callbacks must check this first. */
  protected get gone(): boolean {
    const wc = this.view.webContents as WebContents | undefined
    return this.closing || !wc || wc.isDestroyed()
  }
  applyCss(css: string, slot: CssSlot = 'boost'): void {
    const wc = this.webContents
    // Serialized: two quick edits must not leave the first stylesheet behind.
    this.cssQueue = this.cssQueue
      .then(async () => {
        if (wc.isDestroyed()) return
        const previous = this.cssKeys.get(slot)
        if (previous) await wc.removeInsertedCSS(previous)
        this.cssKeys.delete(slot)
        // The blocker's rules are "display: none !important": as a user style sheet they also beat the page's own "!important" (an ad slot or a
        // consent wall that forces itself to "display: block !important" stays hidden), which an author style sheet does not. Every other slot
        // is an author sheet: Electron 45's removeInsertedCSS does not take a user-origin sheet out again (the engine test checks it), and
        // those slots are replaced and emptied all the time (the battery saver's goes when the mode ends).
        if (css.trim()) this.cssKeys.set(slot, await wc.insertCSS(css, slot === 'blocker' ? { cssOrigin: 'user' } : undefined))
      })
      .catch((error: unknown) => console.error(`[engine] cannot apply ${slot} CSS on page ${this.id}:`, error))
  }
  /** What `debugAttach` was told the page may be on, kept to check every command: a navigation can slip past the events. */
  protected debugAllowUrl: ((url: string) => boolean) | null = null
  /** The frames of the page that can still be addressed, the main one first. */
  protected liveFrames(): WebFrameMain[] {
    if (this.gone) return []
    return this.webContents.mainFrame.framesInSubtree.filter((frame) => !frame.isDestroyed() && !frame.detached)
  }
  /** The answer of a script in each live frame; null for a frame that did not answer (navigating, cross-process and gone, or silent for too long). */
  protected inFrames(script: string, userGesture: boolean): Promise<unknown[]> {
    return Promise.all(
      this.liveFrames().map((frame) => {
        let timer: NodeJS.Timeout | undefined
        const silence = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), MEDIA_SCRIPT_TIMEOUT_MS)
        })
        const answer = frame.executeJavaScript(script, userGesture).catch((error: unknown) => {
          if (!this.gone) console.debug(`[media] a frame of page ${this.id} did not answer:`, error instanceof Error ? error.message : String(error))
          return null
        })
        return Promise.race([answer, silence]).finally(() => clearTimeout(timer))
      })
    )
  }

  show(bounds: Bounds, radius = PAGE_RADIUS): void {
    // Lent to the floating window: the tab's window lays it out no more until it is given back.
    if (this.loan || this.win.isDestroyed()) return
    const wasDetached = !this.attached
    if (wasDetached) {
      this.win.contentView.addChildView(this.view)
      this.attached = true
    }
    if (radius !== this.radius) {
      this.radius = radius
      this.view.setBorderRadius(radius)
    }
    this.view.setBounds(bounds)
    // A page that loaded while it was not on screen (opened at the launch, reloaded behind another) can come on screen as a black rectangle until it
    // is reloaded: the compositor is asked to draw the whole page again as it is shown.
    if (wasDetached && !this.webContents.isDestroyed()) this.webContents.invalidate()
    this.errors.place(bounds, radius)
    this.reader.place(bounds, radius)
  }

  borderRadius(): number {
    return this.radius
  }

  raise(): void {
    if (!this.loan && this.attached && !this.win.isDestroyed()) {
      this.win.contentView.addChildView(this.view)
      this.errors.raise()
      this.reader.raise()
    }
  }

  hide(): void {
    if (this.loan || !this.attached) return
    this.attached = false
    this.errors.place(null)
    this.reader.place(null)
    // When the window itself is closing, its views go with it: touching `contentView` would throw.
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view)
  }

  protected hang<T extends { win: BrowserWindow }>(host: T): T {
    this.hangers.push(host)
    return host
  }
}
