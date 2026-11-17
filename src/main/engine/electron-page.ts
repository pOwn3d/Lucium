// The page of a tab, a Glance, a panel or a popup: one WebContentsView and what Lucium does with it (navigation, menus, media, find, tools, sleep,
// capture). The engine (electron-engine.ts) makes and keeps them; it re-exports the class. Moved out of electron-engine.ts as it was.


import { isNormalPage } from '@shared/fake-fill'
import { pageLanguageOf } from '@shared/page-language'
import { translateEntryLabel } from '@shared/translate-quick'
import { getLanguage } from '@shared/i18n'
import { BrowserWindow, Menu, MenuItem, shell, WebContentsView, type HandlerDetails, type MenuItemConstructorOptions, type WindowOpenHandlerResponse } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { PAGE_RADIUS } from '@shared/split'
import { extensionMenuItems } from './ece-router'
import { ERROR_SCHEME, displaySite, parseErrorAction } from '@shared/error-pages'
import { GESTURE_WINDOW_MS, OPEN_GESTURE_WINDOW_MS, APP_SCHEME_MAX, appLinkOf, clickedFrameOpens, externalLinkOf, frameLinkClick, linkAsker, originOfFrame, isPageOpenUrl, isSavableImageUrl, schemeOf, type FocusedFrame, type LinkAsker } from '@shared/external-links'
import { PageErrors } from './error-pages'
import { LeaveGate } from './unload-guard'
import { VisitTracker } from './visit-tracker'
import { PopupWindows, type PopupOwner } from './popup-windows'
import { planOpen } from '@shared/popup'
import { documentPipVerdict, isDocumentPipRequest, type DocumentPipRefusal } from '@shared/document-pip'
import type { DocumentPipWindows } from './document-pip-windows'
import { UnsavedRequests } from './download-staging'
import { ReaderMode } from './reader-mode'
import { NO_MENU_OPTIONS } from './types'
import { TRANSLATE_WORLD, sampleScript } from '@shared/translate-page-script'
import { MarkdownPicker } from './markdown-picker'
import { MainNavigation, mayAskLogin } from './http-login'
import { listenerLogins } from './extension-net'
import { loginOfListeners } from '@shared/web-request-blocking'
import { ColorSchemeEmulation, emulationCommand } from './color-scheme'
import { ownSessionOf, sharedDebugger } from './own-session'
import { HttpsUpgrades } from './https-upgrade'
import type { Page, PageEvents } from './types'
import { t } from '@shared/i18n'
import { isInternalPageUrl, isInternalScheme } from '@shared/internal-page'
import { SELECTION_PREVIEW_CHARS, HELD_MENU_MAX_MS, HELD_MENU_FALLBACK_MS, VERDICT_FRESH_MS, copyText, isNavigable } from './electron-page-scripts'
import { ElectronPageLifecycle } from './electron-page-lifecycle'

export { RELEASE_ANSWER_MS, TRACK_INPUT } from './electron-page-scripts'

/** Why a document Picture-in-Picture window was refused, as the log says it. */
const DOCUMENT_PIP_REFUSALS: Readonly<Record<DocumentPipRefusal, string>> = {
  'switched-off': 'the feature document-pip is off',
  'not-a-web-page': 'the page is not a page of the web',
  'no-gesture': 'no click or key of the user explains it'
}

/** `net::ERR_HTTP_RESPONSE_CODE_FAILURE`: Chromium's code for an error status (403, 404...) that came with no body. */
const HTTP_RESPONSE_CODE_FAILURE = -379

export class ElectronPage extends ElectronPageLifecycle implements Page {
  constructor(
    id: string,
    view: WebContentsView,
    win: BrowserWindow,
    events: PageEvents,
    upgrades: HttpsUpgrades,
    popups: PopupWindows,
    scope: string | null,
    private readonly unsaved: UnsavedRequests,
    /** The window a `moveToWindow` takes the page to (undefined: it cannot go there); none for a page that never leaves its window. */
    relocate?: (windowId: string | undefined) => BrowserWindow | undefined,
    /** The proxy change of the page's session that is still under way, if any: the first navigation waits for it. */
    networkSettled: () => Promise<void> | undefined = () => undefined,
    /** Get the toggleBlockException handler for this page. */
    private readonly getToggleBlockHandler: (pageId: string) => ((url: string) => void) | undefined = () => undefined,
    /** How a mini window is opened, once the shell has registered it. */
    private readonly getMiniOpener: () => ((url: string) => void) | undefined = () => undefined,
    /** Which pages may open windows without a click (the user's « Toujours autoriser sur ce site »). */
    private readonly getPopupPolicy: () => ((url: string) => boolean) | undefined = () => undefined,
    /** The window of the application a `lendView` lends the view to (undefined: it cannot go there); none for a page that is never lent. */
    lendHost?: (windowId: string) => BrowserWindow | undefined,
    /**
     * Asks the user whether this page may open another application with a link of `scheme` (`zoommtg:`): the question of the permission
     * `openExternal`, which names the scheme. `clicked`: a click of the user explains the link, and the answer may then be kept for the site
     * and the scheme. `asker`, given when the page itself is not the one that asks (a frame of another site, or nobody named): the plain
     * question, under the site of that frame, which reads and keeps nothing. None: such a link opens nothing.
     */
    private readonly askAppLink?: (scheme: string, clicked: boolean, asker?: LinkAsker) => Promise<boolean>,
    /** The windows of document Picture-in-Picture (the floating window of a call); none: such a request is refused, without a tab. */
    private readonly documentPip?: DocumentPipWindows
  ) {
    super(id, view, win, events, relocate, networkSettled, lendHost)
    const wc = view.webContents
    const warn = (what: string, error: unknown): void => console.warn(`[engine] ${what} (page ${this.id}):`, error instanceof Error ? error.message : String(error))
    // The session is shared with the protection of the frames and workers (own-session.ts). When the colour scheme leaves it and the other stays,
    // the emulation does not go with the session: it is taken back by hand.
    const giveSchemeBack = (): void => {
      const { method, params } = emulationCommand(null)
      wc.debugger.sendCommand(method, params).catch((error: unknown) => {
        if (!this.gone) warn('cannot give the page back its own colour scheme', error)
      })
    }
    this.colorScheme = new ColorSchemeEmulation({
      debugger: sharedDebugger(ownSessionOf(wc, wc.debugger), wc.debugger, 'color-scheme', giveSchemeBack),
      owner: wc,
      alive: () => !this.gone,
      warn
    })
    view.setBorderRadius(this.radius)
    const history = () => ({
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    })

    wc.on('page-title-updated', (_e, title) => events.update({ title }))
    wc.on('page-favicon-updated', (_e, favicons) => {
      const [faviconUrl] = favicons
      if (faviconUrl) events.update({ faviconUrl })
    })
    const visits = new VisitTracker()
    // Whether the document on screen may have come over a certificate let through (« Non sécurisé »): told with each address the page commits.
    const untrusted = () => ({ untrustedCertificate: this.errors.certificateUntrusted() })
    wc.on('did-navigate', (_e, url) => {
      this.capturing = false
      visits.navigationCommitted()
      this.langReads.navigated()
      // A new document: the language published for the one before goes with it (the shell drops it with the translation of that document).
      this.publishedLang = ''
      events.update({ url, ...history(), ...untrusted(), newDocument: true })
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      visits.navigationCommitted()
      this.langReads.navigated()
      events.update({ url, ...history(), ...untrusted() })
    })
    // For SPAs like WhatsApp, force loading completion if Chromium doesn't fire did-stop-loading. A page that was closed or destroyed in the
    // meantime announces nothing.
    const forceLoadingEnd = (): void =>
      this.loadingTimer.start(
        () => this.gone || this.closing,
        () => events.update({ loading: false, visit: visits.loadStopped(), ...history() })
      )
    // Loading a page again replaces its frozen document with a live one.
    wc.on('did-start-loading', () => {
      const wasFrozen = this.frozen
      this.frozen = false
      visits.loadStarted()
      // The spinner of the row and the progress of the toolbar are for the page itself: a frame inside it that loads (an advertisement that
      // refreshes, a player) turned them on in a tab in the background for as long as it loaded. A frozen page that loads is told either way:
      // it is live again.
      if (wc.isLoadingMainFrame() || wasFrozen) events.update({ loading: true })
      forceLoadingEnd()
    })
    // Chromium announces `did-start-loading` only when nothing of the view was loading: a navigation of the page that starts while one of its
    // frames is still loading turns the spinner on here. When the view is not loading yet, `did-start-loading` follows and decides (a link to
    // another application, which loads nothing, turns nothing on).
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !wc.isLoading()) return
      events.update({ loading: true })
      forceLoadingEnd()
    })
    // `visit`: a frame inside the page (an advertisement, an embedded player) also starts and stops the loading; only a navigation of the page is a visit.
    wc.on('did-stop-loading', () => {
      // Nothing loads any more: no navigation to the Extensions page is under way (a refused or cancelled one ends here).
      if (!wc.isLoading()) this.heading.ended()
      // The page's own language (its lang attribute): the translation entry is offered only for another language. Read once per document
      // of the page (see LanguageReads), only while the translation is on, and in the translation's isolated world (the page cannot see it): a
      // frame that ends its loading after the page does not make the whole page be sampled again. The answer comes later: a navigation meanwhile
      // makes it the language of another document, which is neither kept nor published.
      const reading = this.langReads.document()
      const stale = (): boolean => !this.langReads.current(reading)
      if (this.langReads.take(events.readsLanguage?.() === true)) {
        wc.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD, [{ code: "document.documentElement.lang || ''" }]).then(
          (lang: unknown) => {
            if (stale()) return
            const declared = typeof lang === 'string' ? lang : ''
            // Without a lang attribute, a web page is judged by its visible text, read in the translation's isolated world (nothing leaves the machine).
            if (declared.trim() !== '' || !/^https?:/.test(wc.getURL())) {
              this.pageLang = pageLanguageOf(declared, '')
              this.publishLanguage()
              return
            }
            return wc.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD, [{ code: sampleScript() }]).then(
              (sample: unknown) => {
                if (stale()) return
                const text = typeof sample === 'object' && sample !== null && typeof (sample as { text?: unknown }).text === 'string' ? (sample as { text: string }).text : ''
                this.pageLang = pageLanguageOf(declared, text)
                this.publishLanguage()
              },
              (error: unknown) => {
                console.warn(`[engine] the text of page ${this.id} could not be sampled for its language; no translation is offered:`, error instanceof Error ? error.message : String(error))
                if (stale()) return
                this.pageLang = ''
                this.publishLanguage()
                this.langReads.failed()
              }
            )
          },
          (error: unknown) => {
            console.warn(`[engine] the language of page ${this.id} could not be read; no translation is offered:`, error)
            if (stale()) return
            this.pageLang = ''
            this.publishLanguage()
            this.langReads.failed()
          }
        )
      }
      this.loadingTimer.cancel()
      events.update({ loading: false, visit: visits.loadStopped(), ...history() })
    })
    wc.on('audio-state-changed', (e) => events.update({ audible: e.audible }))
    wc.on('media-started-playing', () => events.mediaChanged?.())
    // HTML full screen: Electron makes the window full screen but does not move the page's view, so the shell is told (`PageEvents.fullscreen`).
    wc.on('enter-html-full-screen', () => events.fullscreen?.(true))
    wc.on('leave-html-full-screen', () => events.fullscreen?.(false))
    wc.on('media-paused', () => events.mediaChanged?.())
    // A real click, not the `focus` event: Chromium also focuses a freshly attached view without any user action. `input-event` only hears the frames the
    // page's own process draws: a click in a frame of another site says nothing here (the commands then ask `hasFocus`, see shared/split.ts `commandPane`).
    wc.on('input-event', (_e, input) => {
      if (this.tools.mouseGestures) this.noteButton(input)
      if (input.type === 'mouseDown') events.focused()
      // Only what the user did: a script cannot make the page receive an input event.
      if (input.type === 'mouseDown' || input.type === 'mouseUp' || input.type === 'keyDown' || input.type === 'rawKeyDown') {
        this.gesture.note(Date.now())
        this.shareGesture.note(Date.now())
        // The page may ask again to be let go once the user has touched it (see unload-guard.ts).
        this.leave.noteInput()
      }
    })
    // A click in a frame of another site (a payment or sign-in button in a frame): `input-event` above says nothing of it, this event does, for
    // every frame of the tab. It does not say which frame was clicked: `windowOpenGesture` finds out.
    wc.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') this.frameGesture.note(Date.now())
    })
    wc.on('dom-ready', () => {
      // The colour scheme asked of the pages goes on with the navigation (the session stays); a session that was not free earlier is tried again.
      this.colorScheme.refresh()
      // A new document starts without the CSS we inserted into the previous one.
      this.cssKeys.clear()
      this.trackInput()
      // A new document has none of the tools: the ones this page is to carry are installed again, for the site it is on now.
      this.installedTools.clear()
      this.verdict = null
      this.releaseHeld(false)
      const wanted = events.pageTools?.()
      if (wanted) this.tools = { ...wanted }
      this.syncTools()
      events.domReady()
    })
    // A key comes to the page that has the keyboard, whichever frame of it holds it (one of another site included), and before the menu hears it: the pane
    // the user types in is the focused one before ⌘+, ⌘F or ⌘P act on the selected tab, as a click would have made it.
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown') events.focused()
    })
    if (events.escape) {
      wc.on('before-input-event', (_e, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') events.escape?.()
      })
    }
    if (events.shortcut) {
      wc.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return
        if (events.shortcut?.({ key: input.key, code: input.code, meta: input.meta, shift: input.shift, alt: input.alt, control: input.control })) e.preventDefault()
      })
    }
    // `window.close()`: the page is destroyed by Electron. Told after the fact, once nothing of it is left to touch.
    // The "close" event exists in Electron but is not in its typings.
    ;(wc as unknown as NodeJS.EventEmitter).once('close', () => {
      // Closed for a sleep (`release`): the tab stays, asleep.
      if (!this.closing && !this.releasing) setTimeout(() => events.closed?.(), 0)
    })
    wc.on('found-in-page', (_e, result) => events.found({ matches: result.matches, ordinal: result.activeMatchOrdinal }))
    this.errors = new PageErrors(wc, this.hang({
      win,
      radius: PAGE_RADIUS,
      reload: () => wc.reload(),
      goBack: () => wc.navigationHistory.goBack(),
      announceUrl: (url) => events.update({ url, ...history() }),
      // A site that does not answer over HTTPS gets its http address back (see HttpsUpgrades), and no error page.
      upgradeFailed: (url, code, certificate) => upgrades.failed(wc.id, url, code, certificate),
      continueOverHttp: (http) => upgrades.continueOverHttp(wc.id, http),
      toggleBlockException: (url) => {
        const handler = this.getToggleBlockHandler(this.id)
        if (handler) handler(url)
      },
      openMini: (url) => this.getMiniOpener()?.(url),
      // A click in our page over a crashed tab is a click in the tab, for its pane; so is one in the reader.
      focused: () => events.focused(),
      developerSite: (url) => events.developerSite?.(url) === true,
      // Something the page on screen loads came over a certificate let through: the page is not secure from now on.
      certificateAccepted: () => {
        if (this.errors.certificateUntrusted()) events.update({ untrustedCertificate: true })
      }
    }))
    this.reader = new ReaderMode(wc, this.hang({ win, radius: PAGE_RADIUS, navigate: (url) => this.loadURL(url), readAloud: () => events.menuOptions?.().readAloud === true, focused: () => events.focused() }))
    this.markdown = new MarkdownPicker(wc)
    // HTTPS first: the page tells the upgrade state when a navigation starts or commits, and can be sent back to http.
    upgrades.attach(wc.id, {
      navigate: (url) => this.loadURL(url),
      isLoading: () => !this.gone && wc.isLoading(),
      stop: () => wc.stop(),
      fellBack: (host) => events.httpsFallback?.(host)
    })
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.heading.announced(details.url)
      if (details.isMainFrame && !details.isSameDocument) upgrades.navigationStarted(wc.id, details.url)
      // What a regular-expression search painted is gone with the old document.
      if (details.isMainFrame && !details.isSameDocument) this.regexFinder?.reset()
      // A new document has registered nothing yet: what the previous one offered (its next track) is gone with it.
      if (details.isMainFrame && !details.isSameDocument && (this.trackActions.previous || this.trackActions.next)) {
        this.trackActions = { previous: false, next: false }
        events.update({ trackActions: this.trackActions })
      }
    })
    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      this.internalDocument(url, httpResponseCode)
      upgrades.committed(wc.id)
      this.dialogGuard.reset()
      this.popupNoticed = false
      this.appLinkAsked = false
      this.frameAppLinkAsked = false
    })
    wc.once('destroyed', () => upgrades.detach(wc.id))
    // Where the top frame goes when a link or a script sends it (`will-navigate`). A server's 302 to another application's scheme is not stopped here:
    // Chromium asks the user for `openExternal` (the prompt names the scheme and never remembers), which is how an app sign-in comes back to its app.
    const keepToWeb = (e: { preventDefault(): void; initiator?: { origin: string } | null }, url: string): void => {
      // The Extensions page goes nowhere by itself: it has no link, and a tab that went to the web from it would no longer be that page, with the preload and
      // the channels of it behind a web document. What a page sends is stopped; the shell is the one that loads this tab (`loadURL`, which fires no such event).
      if (isInternalPageUrl(wc.getURL())) {
        e.preventDefault()
        console.warn(`[engine] kept the Extensions page from going to ${schemeOf(url)}`)
        return
      }
      // The buttons of an error page are links of ours, answered by `PageErrors`: only a real one (a known action and a nonce) is left to it.
      if (!isNavigable(url) && parseErrorAction(url) === null) {
        e.preventDefault()
        // A frame of another site may send the whole tab away (`target=_top`): the frame that started the navigation is the one that asks.
        const asker = this.askerOf(e.initiator)
        // Mail and telephone links of the page go to the system, on a click; a link to another application, after the same question as the redirect
        // above. Asked by a frame of another site, either is the plain question under that frame's site.
        if (externalLinkOf(url) && asker.kind === 'page') this.openExternalLink(url, events)
        else this.openAppLink(url, events, asker)
      }
    }
    wc.on('will-navigate', (e, url) => keepToWeb(e, url))
    // No page of the web reaches the Extensions page by a redirect (a server's 302, a script's replace) or by a frame: the scheme is ours alone, and a document there
    // would be shown with what the page is given. The main frame by a link or a script is `keepToWeb` above (`isNavigable` does not know the scheme).
    wc.on('will-redirect', (e, url) => {
      if (!isInternalScheme(url)) return
      e.preventDefault()
      console.warn('[engine] kept a redirect from going to the Extensions page')
    })
    // A page that asks to confirm leaving it cannot hold the tab, and cannot lose what the user typed without a word: Electron has no box for the
    // question, so the shell asks (a sheet of Lucium, or the system box; "Quitter" or "Rester"). Ignoring the handler is what lets the page go; a page
    // that is not on screen has nobody to ask and goes (see unload-guard.ts).
    this.leave = new LeaveGate({ win: () => (this.attached ? this.win : null), site: () => displaySite(wc.getURL()), ...(events.askLeave ? { ask: (site: string) => events.askLeave!(site) } : {}) })
    wc.on('will-prevent-unload', (event) => {
      // A close for a sleep that the page refuses: the refusal is kept (the close does not happen) and the page stays awake, as it is.
      if (this.releasing) return this.releasing.settle(false)
      this.leave.onPrevent(event)
    })
    // A document that commits ends the navigation the shell started: the next refusal is the page's own (see `LeaveGate.committed`).
    wc.on('did-navigate', () => this.leave.committed())
    // The same for a link inside a frame of the page (will-navigate only speaks for the top frame).
    wc.on('will-frame-navigate', (e) => {
      if (e.isMainFrame) return
      if (isInternalScheme(e.url)) {
        e.preventDefault()
        console.warn('[engine] kept a frame from going to the Extensions page')
        return
      }
      // The buttons of an error page are only answered in the top frame of the page that shows it: a frame has no business with them.
      if (e.url.startsWith(ERROR_SCHEME)) {
        e.preventDefault()
        console.warn('[engine] blocked a frame navigation to an error page action')
        return
      }
      const link = externalLinkOf(e.url)
      if (!link) {
        // A link of a frame of another site to another application is asked about here, under the site of that frame, rather than left to
        // Chromium: the question then names the frame for sure, and what the user kept for the page does not answer for it. A frame of the
        // page's own site, or one without a web origin, is left to Chromium as before (its question keeps nothing).
        if (appLinkOf(e.url) === null) return
        const asker = this.askerOf(e.frame)
        if (asker.kind !== 'frame') return
        e.preventDefault()
        this.openAppLink(e.url, events, asker)
        return
      }
      e.preventDefault()
      // A frame of another site does not open the telephone or the mail with a click the user gave to the page: only with one given to it.
      const frameOrigin = originOfFrame(e.frame)
      const click = frameLinkClick(frameOrigin, this.pageOrigin(), this.focusedFrame())
      if (click === null) {
        console.warn(`[engine] ignored a ${schemeOf(link)} link of a frame of another site that no click in that frame explains`)
        return
      }
      // With the click in that frame, the link is still the frame's, not the page's: the plain question, under the frame's site.
      if (click === 'frame' && frameOrigin !== null) this.openAppLink(e.url, events, { kind: 'frame', origin: frameOrigin })
      else this.openExternalLink(e.url, events, click)
    })
    // HTTP authentication (401 from a server, 407 from a proxy): the shell asks the user. Without an answer the request is refused.
    // Electron says a request is a navigation, not of which frame: the navigation of the main frame under way is followed here (see mayAskLogin).
    const mainNavigation = new MainNavigation()
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) mainNavigation.started(details.url)
    })
    wc.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame) mainNavigation.started(details.url)
    })
    wc.on('did-navigate', () => mainNavigation.ended())
    wc.on('did-fail-load', (_e, code, _description, url, isMainFrame) => {
      if (isMainFrame) mainNavigation.ended()
      if (isMainFrame) this.heading.ended(url)
      // An answer of 403 with no body is a failed load for Chromium (ERR_HTTP_RESPONSE_CODE_FAILURE): the refusal of the Extensions page, as in `internalDocument`.
      if (isMainFrame && code === HTTP_RESPONSE_CODE_FAILURE) this.internalDocument(url, 403)
    })
    wc.on('login', (e, details, info, callback) => {
      e.preventDefault()
      const ask = events.authenticate
      if (!ask) return callback()
      // A frame or a subresource of another origin is refused without a question (see mayAskLogin). Answered once the event is over, as the
      // certificate errors are (certificate-error.ts): an answer given from inside an event Electron still has to finish is how 45.0.0 crashed.
      if (!mayAskLogin({ url: details.url, isRequestForNavigation: details.isRequestForNavigation, isProxy: info.isProxy }, wc.getURL(), mainNavigation.current())) return void setImmediate(() => callback())
      // What a blocking listener of chrome.webRequest.onAuthRequired answered for this answer of the server (extension-net.ts): a cancel ends the
      // login without a question; its credentials are given once, at the first attempt (a second challenge means they were wrong: the user is asked).
      const fromListeners = loginOfListeners(listenerLogins.take(wc.session, details.url, Date.now()), details.firstAuthAttempt)
      if (fromListeners === 'cancel') return void setImmediate(() => callback())
      if (fromListeners !== null) return void setImmediate(() => callback(fromListeners.username, fromListeners.password))
      ask({ host: info.host, port: info.port, scheme: info.scheme, realm: info.realm, isProxy: info.isProxy, url: details.url }).then(
        (credentials) => (credentials ? callback(credentials.username, credentials.password) : callback()),
        (error: unknown) => {
          // Never the credentials: the message of the error alone.
          console.error('[engine] cannot ask for a login:', error instanceof Error ? error.message : String(error))
          callback()
        }
      )
    })
    const owner: PopupOwner = this.hang({ key: id, contents: wc, win, events, scope })
    popups.watch(owner)
    wc.setWindowOpenHandler((details) => {
      const { url } = details
      // The Extensions page opens no window: it has no link, and a script that opens one is not the page's (see `keepToWeb`).
      if (isInternalPageUrl(wc.getURL())) {
        console.warn(`[engine] kept the Extensions page from opening a window on ${schemeOf(url)}`)
        return { action: 'deny' }
      }
      // `documentPictureInPicture.requestWindow()`: a window of its own or nothing, never a tab (a blank tab is what the plan of a link would make of it).
      if (isDocumentPipRequest(details)) return this.documentPipAnswer(details)
      // Shift+click reports `new-window` without features; Cmd/Ctrl+click and target=_blank report a foreground or background tab. A page that
      // gives a feature list (width, height, popup) asks for a window it can talk to: it gets one (see PopupWindows).
      if (externalLinkOf(url) || !isPageOpenUrl(url)) {
        // A page opens the web, and a blank page: not the files of the user, an extension, the developer tools. A link to another
        // application that opens in a new window (`target=_blank`) is asked about like any other, and opens no window. The request does not
        // say which frame made it: see `windowLinkAsker`.
        const asker = this.windowLinkAsker()
        if (externalLinkOf(url) && asker.kind === 'page') this.openExternalLink(url, events)
        else this.openAppLink(url, events, asker)
      } else if (!this.windowOpenGesture(details.referrer.url, Date.now()) && !(this.getPopupPolicy()?.(wc.getURL()) ?? false)) {
        // One click, one window: a script that opens windows on its own (or in a burst) is not the user. The user is told once per document:
        // a sign-in that opens its window too long after the click would otherwise be a button that does nothing.
        console.warn('[engine] ignored a window.open that no click explains')
        if (!this.popupNoticed) {
          this.popupNoticed = true
          events.popupBlocked?.(displaySite(wc.getURL()), url)
        }
      } else {
        const plan = planOpen(details)
        if (plan.kind === 'tab') events.openWindow(url, plan.mode, true, details.disposition, details.features)
        // Only a web page opens popups: the page of an extension (a side panel) keeps getting its links in a tab.
        else if (!isPageOpenUrl(wc.getURL())) events.openWindow(url, 'peek', true)
        else {
          const response = popups.request(owner, details, plan)
          if (response) return response
        }
      }
      return { action: 'deny' }
    })
    wc.on('context-menu', (_e, params) => this.onContextMenu(params, events))
  }

  /**
   * The answer to `documentPictureInPicture.requestWindow()` (shared/document-pip.ts): the window, when the feature is on, a click explains it and
   * Electron still hands it over (engine/document-pip-windows.ts); else a refusal, as before, with a line in the log. What Electron sent is written
   * first: the page's own text, cut short, and no address (the window starts blank).
   */
  /** Whether the shell already tried again to load the Extensions page since a document of it was served. */
  private internalRetried = false

  /**
   * The Extensions page is served to the load of the shell (engine/internal-pages.ts). A document of it that was refused (403) is a load that did not carry the secret
   * (the shell's own does): a Back or a Forward onto it that replays nothing of the entry, `chrome.tabs.reload`, a gesture. It is loaded again, by the shell's way, once:
   * a second refusal means the secret is not the session's, and the page stays as it is, said in the log. A document that was served ends the wait.
   */
  private internalDocument(url: string, code: number): void {
    if (!isInternalPageUrl(url) || this.gone) return
    if (code !== 403) {
      this.internalRetried = false
      return
    }
    if (this.internalRetried) {
      console.warn(`[engine] the Extensions page was refused again to a load of the shell: page ${this.id} keeps what it has`)
      return
    }
    this.internalRetried = true
    this.loadURL(url)
  }

  private documentPipAnswer(details: HandlerDetails): WindowOpenHandlerResponse {
    const wc = this.view.webContents
    const cut = (text: unknown, most: number): string => (typeof text === 'string' ? text.slice(0, most) : typeof text)
    console.info(`[pip] page ${this.id} asked for a document Picture-in-Picture window: ${JSON.stringify({ disposition: details.disposition, url: cut(details.url, 40), features: cut(details.features, 120), frameName: cut(details.frameName, 40) })}`)
    const verdict = documentPipVerdict({ on: this.documentPip?.enabled() === true, opener: wc.getURL(), gesture: () => this.windowOpenGesture(details.referrer.url, Date.now()) })
    if (verdict.kind === 'refuse') {
      console.warn(`[pip] refused the document Picture-in-Picture window of page ${this.id}: ${DOCUMENT_PIP_REFUSALS[verdict.reason]}`)
      return { action: 'deny' }
    }
    return this.documentPip?.request(wc, this.id) ?? { action: 'deny' }
  }

  /**
   * A `mailto:` or `tel:` link of the page, handed to the system, once per click: a navigation that no recent click of the user
   * explains (a script, a redirect) is dropped. The address never goes to a log.
   */
  private openExternalLink(url: string, events: PageEvents, click: 'page' | 'frame' = 'page'): void {
    const link = externalLinkOf(url)
    if (!link) return
    // The click in the page, or the one in the frame of another site that asks (`frameLinkClick`): one click opens one link.
    if (!(click === 'frame' ? this.frameGesture : this.gesture).take(Date.now(), GESTURE_WINDOW_MS)) {
      console.warn(`[engine] ignored a ${schemeOf(link)} link that no click explains`)
      return
    }
    // Through a promise so that a failure that is thrown and one that is rejected end the same way.
    void Promise.resolve()
      .then(() => shell.openExternal(link))
      .catch((error: unknown) => {
        console.error(`[engine] cannot open a ${schemeOf(link)} link:`, error instanceof Error ? error.message : String(error))
        events.externalLinkFailed?.(schemeOf(link))
      })
  }

  /**
   * A link of the top document to another application (`zoommtg:`, `msteams:`, `slack:`, `vscode:`…): the user is asked, with the scheme in the
   * question, and the address goes to the system on a yes. It used to be dropped without a word, and « Ouvrir dans l'application » did nothing.
   * Asked each time a click explains it; without a click (a page that sends to its application as it loads), once per document, so that a
   * script cannot put question after question. The one who asks is told whether a click explains the link: only then may the user have the
   * answer kept for the site and the scheme, and a link the user chose to always open still opens once per document without a click.
   * A scheme that never leaves (`appLinkOf`) is refused as before. The address never goes to a log.
   */
  private openAppLink(url: string, events: PageEvents, asker: LinkAsker = { kind: 'page' }): void {
    const scheme = schemeOf(url).slice(0, APP_SCHEME_MAX)
    const own = asker.kind === 'page'
    // A mail or telephone link that is not the page's own is asked about too (the page's own goes on a click, without a question).
    const link = appLinkOf(url) ?? (own ? null : externalLinkOf(url))
    if (!link || !this.askAppLink) return void console.warn(`[engine] blocked a page from going to ${scheme}`)
    if (this.appLinkPending) return void console.warn(`[engine] ignored a ${scheme} link: the user is being asked about another one`)
    const clicked = this.askerClicked(asker, Date.now())
    if (!clicked) {
      // Mail and telephone never leave without a click.
      if (!appLinkOf(url)) return void console.warn(asker.kind === 'frame' ? `[engine] ignored a ${scheme} link of a frame of another site that no click in that frame explains` : `[engine] ignored a ${scheme} link that no click explains`)
      if (own ? this.appLinkAsked : this.frameAppLinkAsked) return void console.warn(`[engine] ignored a ${scheme} link that no click explains: this document was asked about one already`)
      if (own) this.appLinkAsked = true
      else this.frameAppLinkAsked = true
    }
    this.appLinkPending = true
    const ask = this.askAppLink
    // Through a promise so that a question that throws and one that is rejected end the same way.
    void Promise.resolve()
      .then(() => (own ? ask(scheme, clicked) : ask(scheme, clicked, asker)))
      .then(
        (allowed) => {
          this.appLinkPending = false
          if (!allowed) return void console.info(`[engine] a ${scheme} link was not opened: the user said no, or nobody could be asked`)
          return Promise.resolve()
            .then(() => shell.openExternal(link))
            .catch((error: unknown) => {
              console.error(`[engine] cannot open a ${scheme} link:`, error instanceof Error ? error.message : String(error))
              events.externalLinkFailed?.(scheme)
            })
        },
        (error: unknown) => {
          this.appLinkPending = false
          console.error(`[engine] cannot ask about a ${scheme} link:`, error instanceof Error ? error.message : String(error))
        }
      )
  }

  /**
   * Whether a click or a key of the user explains the window a document of this page asks for, and uses that input up: one click, one window.
   * A click in the page itself, or in a frame its process draws, counts for the whole page, as it always did. A click in a frame of another site
   * counts for that frame alone (`clickedFrameOpens`). Both memories are emptied either way, so that a click never opens two windows.
   */
  private windowOpenGesture(referrer: string, now: number): boolean {
    const own = this.gesture.take(now, OPEN_GESTURE_WINDOW_MS)
    const framed = this.frameGesture.take(now, OPEN_GESTURE_WINDOW_MS)
    return own || (framed && clickedFrameOpens(referrer, this.focusedFrame()))
  }

  /**
   * Whether a click explains a link `asker` asks for, and uses it up. The page's own: a click in the page. A frame of another site: a click in
   * that very frame, the one that has the focus (as `frameLinkClick` names it), never one given to the page. Nobody named: any click in the tab.
   */
  private askerClicked(asker: LinkAsker, now: number): boolean {
    if (asker.kind === 'page') return this.gesture.take(now, GESTURE_WINDOW_MS)
    if (asker.kind === 'frame') {
      const focused = this.focusedFrame()
      return focused !== null && !focused.top && focused.origin === asker.origin && this.frameGesture.take(now, GESTURE_WINDOW_MS)
    }
    const own = this.gesture.take(now, GESTURE_WINDOW_MS)
    const framed = this.frameGesture.take(now, GESTURE_WINDOW_MS)
    return own || framed
  }

  /** The origin of the page's document, or null when it has no address that can be read. */
  private pageOrigin(): string | null {
    const url = this.view.webContents.getURL()
    return URL.canParse(url) ? new URL(url).origin : null
  }

  /**
   * Who asks for a navigation, from the frame that started it (`initiator`) or the frame that goes (`frame`), as Electron gives it: undefined or
   * null when it does not say, and a frame whose origin can no longer be read is nobody that can be named.
   */
  private askerOf(frame: { origin: string } | null | undefined): LinkAsker {
    const pageOrigin = this.pageOrigin()
    if (frame === null || frame === undefined) return linkAsker(null, pageOrigin, this.holdsOtherSiteFrames())
    const origin = originOfFrame(frame)
    return origin === null ? { kind: 'unsure' } : linkAsker(origin, pageOrigin, true)
  }

  /**
   * Who asks for a link that leaves the browser through `window.open`, whose request does not say which frame made it (its referrer is empty for
   * such a link). A click in a frame of another site, which gave that frame the focus and was not heard by the page, names that frame. Otherwise
   * the page is the asker only when it holds no frame of another site: a frame that rides on the page's click, or asks with none, cannot be told
   * from the page, so nothing the user kept for the page answers then.
   */
  private windowLinkAsker(): LinkAsker {
    const now = Date.now()
    const focused = this.focusedFrame()
    if (!this.gesture.fresh(now, GESTURE_WINDOW_MS) && this.frameGesture.fresh(now, GESTURE_WINDOW_MS) && focused !== null && !focused.top) {
      return linkAsker(focused.origin, this.pageOrigin(), true)
    }
    return linkAsker(null, this.pageOrigin(), this.holdsOtherSiteFrames())
  }

  /** Whether a frame of the page holds a document of another origin than the page's; true when the frames cannot be read (the safe side). */
  private holdsOtherSiteFrames(): boolean {
    try {
      const top = this.view.webContents.mainFrame
      return top.framesInSubtree.some((frame) => frame.parent !== null && frame.origin !== top.origin)
    } catch (error) {
      console.warn('[engine] cannot list the frames of a page, so a link that names nobody is not taken for the page\'s own:', error instanceof Error ? error.message : String(error))
      return true
    }
  }

  /** The frame of this page that has the focus, or null when none has or when it cannot be read (a frame that is going away). */
  private focusedFrame(): FocusedFrame | null {
    try {
      const frame = this.view.webContents.focusedFrame
      return frame ? { origin: frame.origin, top: frame.parent === null } : null
    } catch (error) {
      console.warn('[engine] cannot read which frame of a page has the focus, so a click in a frame opens no window:', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /**
   * A right click. With the mouse gestures on, a right click in the page itself may be the start of a gesture, so its menu is held until the
   * button is released: the script then says whether a gesture was drawn (no menu) or not (the menu opens, as it always did).
   */
  private onContextMenu(params: Electron.ContextMenuParams, events: PageEvents): void {
    const wc = this.webContents
    const gestures = this.tools.mouseGestures && this.installedTools.has('mouseGestures') && params.frame === wc.mainFrame
    if (!gestures) return this.showContextMenu(params, events)
    // On systems where the menu is asked for when the button is released, the script's answer is already here: a plain click opens the menu, a gesture drops it.
    const verdict = this.verdict
    if (verdict && Date.now() - verdict.at < VERDICT_FRESH_MS) {
      this.verdict = null
      if (verdict.plain) this.showContextMenu(params, events)
      return
    }
    // Not a right click (the keyboard, control-click): nothing to wait for.
    if (!this.rightDown) return this.showContextMenu(params, events)
    this.releaseHeld(false)
    this.held = { params, timer: setTimeout(() => this.releaseHeld(true), HELD_MENU_MAX_MS) }
  }

  /** Ends the hold on the menu: opened if `show`, dropped otherwise (a gesture took the click). */
  protected releaseHeld(show: boolean): void {
    const held = this.held
    if (!held) return
    this.held = null
    clearTimeout(held.timer)
    if (show && !this.gone) this.showContextMenu(held.params, this.events)
  }

  /** The state of the right button, from the input events of the page: a menu that waits for its release must not wait for ever. */
  private noteButton(input: Electron.InputEvent): void {
    const mouse = input as Electron.MouseInputEvent
    if (input.type === 'mouseDown') this.rightDown = mouse.button === 'right'
    else if (input.type === 'mouseUp') {
      this.rightDown = false
      // The script answers within a frame or two of the release; if it never does (a page that froze, a frame we have no script in), the menu opens anyway.
      const held = this.held
      if (held) {
        clearTimeout(held.timer)
        held.timer = setTimeout(() => this.releaseHeld(true), HELD_MENU_FALLBACK_MS)
      }
    }
  }

  private showContextMenu(params: Electron.ContextMenuParams, events: PageEvents): void {
    const wc = this.webContents
    const options = events.menuOptions?.() ?? NO_MENU_OPTIONS
    const items: Array<MenuItemConstructorOptions | MenuItem> = []
    const separator = () => {
      if (items.length > 0 && items.at(-1)?.type !== 'separator') items.push({ type: 'separator' })
    }

    if (params.linkURL) {
      // The address is the page's: only a web link can be opened from here (the same rule as window.open), any link can be copied.
      if (isPageOpenUrl(params.linkURL)) {
        items.push(
          { label: t('engine.ouvrir-le-lien-dans-un-nouvel-onglet'), click: () => events.openWindow(params.linkURL, 'foreground') },
          { label: t('engine.ouvrir-en-arriere-plan'), click: () => events.openWindow(params.linkURL, 'background') },
          { label: t('engine.apercu-du-lien-coup-d-oeil'), click: () => events.openWindow(params.linkURL, 'peek') },
          { label: t('engine.ouvrir-dans-une-mini-fenetre'), click: () => events.openWindow(params.linkURL, 'little') }
        )
      }
      items.push({ label: t('engine.copier-l-adresse-du-lien'), click: () => copyText(events.copyLink?.(params.linkURL) ?? params.linkURL) })
      if (options.qrCode && isPageOpenUrl(params.linkURL)) items.push({ label: t('engine.code-qr-de-ce-lien'), click: () => events.qrCode?.(params.linkURL) })
      // Only a web link, and only with the setting on (asked again when the item is chosen: the menu may have been open for a while).
      if (isPageOpenUrl(params.linkURL) && events.canOpenUnsaved?.()) {
        items.push({
          label: t('engine.ouvrir-sans-l-enregistrer'),
          click: () => {
            if (!events.canOpenUnsaved?.()) return
            this.unsaved.expect(wc.session, params.linkURL)
            wc.downloadURL(params.linkURL)
          }
        })
      }
      separator()
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ label: t('engine.copier-l-image'), click: () => wc.copyImageAt(params.x, params.y) })
      // The address is the page's: only what a page can show as an image is downloaded (never a `file:` or an application scheme).
      if (isSavableImageUrl(params.srcURL)) items.push({ label: t('engine.enregistrer-l-image-sous'), click: () => wc.downloadURL(params.srcURL) })
      items.push({ label: t('engine.copier-l-adresse-de-l-image'), click: () => copyText(params.srcURL) })
      separator()
    }
    if (params.isEditable) {
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) })
        }
        separator()
      }
      // Only in the main frame of a normal page: the coordinates are those of the frame that was clicked.
      if (events.fakeFill && params.frame === wc.mainFrame && isNormalPage(wc.getURL())) items.push({ label: t('fake-fill.menu'), click: () => events.fakeFill?.(params.x, params.y) })
      items.push({ role: 'cut', label: t('menu.couper') }, { role: 'copy', label: t('menu.copier') }, { role: 'paste', label: t('menu.coller') }, { role: 'selectAll', label: t('menu.tout-selectionner') })
      separator()
    } else if (params.selectionText.trim()) {
      const text = params.selectionText.trim()
      const preview = text.length > SELECTION_PREVIEW_CHARS ? `${text.slice(0, SELECTION_PREVIEW_CHARS)}…` : text
      items.push({ role: 'copy', label: t('menu.copier') })
      if (events.copyAsMarkdown) items.push({ label: t('engine.copier-en-markdown'), click: () => events.copyAsMarkdown?.() })
      items.push({ label: t('engine.rechercher-selection', { preview }), click: () => events.searchSelection(text) })
      if (options.readAloud) {
        items.push({ label: t('engine.lire-la-selection-a-voix-haute'), click: () => this.speak(text, null) })
        if (this.speaking) items.push({ label: t('menu.arreter-la-lecture-a-voix-haute'), click: () => this.stopSpeaking() })
      }
      separator()
    } else if (!params.linkURL && params.mediaType !== 'image') {
      items.push(
        { label: t('toolbar.precedent'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: t('toolbar.suivant'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: t('sidebar.recharger'), click: () => wc.reload() }
      )
      // Only on the page itself (not on a link or an image), where the extension this comes from puts its right-click entry.
      if (events.clearSiteData) items.push({ label: t('cmd.effacer-les-donnees-du-site'), click: () => events.clearSiteData?.() })
      if (events.createShortcut) items.push({ label: t('menu.raccourci-pour-ce-site'), click: () => events.createShortcut?.() })
      if (options.summary) {
        items.push({
          label: t('menu.resumer-la-page'),
          submenu: [
            { label: t('summary.court'), click: () => events.summarize?.('short') },
            { label: t('summary.normal'), click: () => events.summarize?.('normal') },
            { label: t('summary.detaille'), click: () => events.summarize?.('long') }
          ]
        })
      }
      if (options.readAloud && this.speaking) items.push({ label: t('menu.arreter-la-lecture-a-voix-haute'), click: () => this.stopSpeaking() })
      if (options.gestures) items.push({ label: options.gestures === 'on' ? t('engine.desactiver-les-gestes-de-souris-sur-ce-site') : t('engine.activer-les-gestes-de-souris-sur-ce-site'), click: () => events.toggleGestureSite?.() })
      separator()
    }
    // What the extensions of this page's own profile put in the menu (contextMenus), before the inspector. None on the Extensions page: it is the browser's own,
    // and a click on such an entry would tell the extension the address of the page (`pageUrl`) that it may not be told.
    const library = isInternalPageUrl(wc.getURL()) ? undefined : ElectronChromeExtensions.fromSession(wc.session)
    const fromExtensions = library ? extensionMenuItems<MenuItem>(library, wc, params, (message) => console.warn(message)) : []
    if (fromExtensions.length > 0) {
      separator()
      items.push(...fromExtensions)
    }
    // « Traduire en <langue> », done at once (no panel), for a page in another language than the target; « Afficher l'original » on a translated page. On the
    // page, on a selected text and on a link, never in a field being edited.
    const translateLabel = options.translate ? translateEntryLabel(this.pageLang, options.translateTarget ?? getLanguage(), options.translated === true) : null
    if (!params.isEditable && events.translatePage && translateLabel !== null) {
      separator()
      items.push({ label: translateLabel, click: () => events.translatePage?.() })
    }
    items.push({ label: t('engine.inspecter-l-element'), click: () => void this.inspectAt(params) })
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }
}
