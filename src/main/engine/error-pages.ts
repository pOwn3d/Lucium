// Electron side of the error pages (see shared/error-pages.ts for what they say). One `PageErrors` per page:
//  - a main-frame load that failed gets its document replaced, in place, by our page: the tab keeps the address that was asked for,
//    reload retries it and history is untouched (Electron itself shows a blank document for a failed load);
//  - a certificate error is refused unless the user chose "continue anyway" for this host and this certificate in this session, or put the site
//    in Developer Mode; the page of a certificate let through says « Non sécurisé » (`certificateUntrusted`);
//  - a renderer that died gets a view laid over the dead page (there is no document left to rewrite), and so does one that no longer
//    answers (`unresponsive`) until it answers again (`responsive`), is waited for or is reloaded.
// The buttons are links to `lucium-error:` that are cancelled here and answered: no script runs in the error document, and a
// click only counts when it carries the nonce of the page on screen.

import { randomUUID } from 'node:crypto'
import { clipboard, shell, type BrowserWindow, type WebContents } from 'electron'
import {
  CertificateExceptions,
  mayProceed,
  DOCUMENT_FACTS_SCRIPT,
  documentFacts,
  errorName,
  errorPageDocument,
  exceptionHost,
  homeOf,
  isCertificateError,
  isBlankDocument,
  isCrash,
  isReportableFailure,
  isStatusFailure,
  isLocalNetworkFailure,
  LOCAL_NETWORK_SETTINGS_URL,
  parseErrorAction,
  renderErrorPage,
  type CertificateFacts,
  type ErrorAction,
  type ErrorPageModel
} from '@shared/error-pages'
import { isNavigableUrl } from '@shared/url'
import type { LoadFailure } from '@shared/dead-tabs'
import { certificateErrorListener } from './certificate-error'
import { strictTransportHosts } from './strict-transport'
import { strictTransportStore, type StoredSession } from './strict-transport-store'
import type { UpgradeFailure } from './https-upgrade'
import { PageCover } from './page-cover'
import type { Bounds } from './types'

/** After a hung renderer is ended on purpose to reload the page, the « gone » it reports within this long is ours, not a crash to show. */
const ENDED_ON_PURPOSE_MS = 5000

/** What the user agreed to trust in this run of the application. Not persisted; a private window's session has its own. */
export const certificateExceptions = new CertificateExceptions()

/** What is forgotten with the data of a session and lives outside it: the certificates let through, and the hosts held to strict transport security. */
export const sessionDecisions = {
  forget(session: StoredSession): void {
    certificateExceptions.forget(session)
    strictTransportStore.forget(session)
  }
}

export interface PageErrorsHost {
  win: BrowserWindow
  /** Corner radius of the page when it is made, which the cover of a crashed page shares (it follows the page's after that, see `place`). */
  radius: number
  reload(): void
  goBack(): void
  /** Chromium reports no navigation for a page that failed: the address that was asked for is told to the tab here. */
  announceUrl(url: string): void
  /**
   * HTTPS first: when the failed load was an upgraded address, the page goes back to http by itself (`fell-back`), or, for a certificate that is not
   * valid (`certificate`), the error page shows and offers the http address on a click (`refused`).
   */
  upgradeFailed(url: string, code: number, certificate: boolean): UpgradeFailure
  /** « Continuer en HTTP (non sécurisé) » on the page of a certificate an upgrade was refused: the page goes to that http address, without the upgrade. */
  continueOverHttp?(http: string): void
  /** Add or remove a domain from the ad/tracker blocker exceptions. */
  toggleBlockException(url: string): void
  /** Opens an address in a mini window; absent for a page that has no window of the browser to open it from (a popup). */
  openMini?(url: string): void
  /** The user clicked or typed in our page laid over the tab's (a crash): a press in the page, for its pane (`PageEvents.focused`); absent for a popup. */
  focused?(): void
  /** Whether an address is on a site in Developer Mode (`developerHosts`): its invalid certificate is let through without a question. Absent: none is. */
  developerSite?(url: string): boolean
  /** An invalid certificate was let through for this page or something it loads (see `certificateUntrusted`). */
  certificateAccepted?(): void
}

export class PageErrors {
  /** The error page on screen: its buttons answer to its nonce only. */
  private shown: ErrorPageModel | null = null
  /** A failure whose error document has not been committed yet. */
  private pending: ErrorPageModel | null = null
  /** The main document that answered 4xx or 5xx: once loaded, it is looked at, and if it shows nothing our page covers it (see `showBlankStatus`). */
  private statusToCheck: { url: string; status: number } | null = null
  /** The error status the main document on screen answered (4xx, 5xx), whatever it shows; null once a document answered otherwise. */
  private failedStatus: number | null = null
  /** The last certificate the network stack refused for a main frame, which the page of that failure shows. */
  private lastCertificate: { host: string; facts: CertificateFacts } | null = null
  private cover: PageCover | null = null
  /** Where the page is on screen, null while it is hidden. */
  private bounds: Bounds | null = null
  /** The page's corner radius now (a cover made after a change must start with it). */
  private radius: number
  /** When the renderer of a hung page was ended to reload it (ms since the epoch), null if it was not. */
  private endedOnPurposeAt: number | null = null

  constructor(
    private readonly wc: WebContents,
    private readonly host: PageErrorsHost
  ) {
    this.radius = host.radius
    wc.on(
      'certificate-error',
      certificateErrorListener({
        exceptions: certificateExceptions,
        session: () => wc.session,
        pageUrl: () => wc.getURL(),
        developerSite: (url) => host.developerSite?.(url) === true,
        strictTransport: (site) => strictTransportHosts.isStrict(wc.session, site),
        refused: (site, facts) => {
          this.lastCertificate = { host: site, facts }
        },
        accepted: () => host.certificateAccepted?.()
      })
    )
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => this.onFailedLoad(code, description, url, isMainFrame))
    // The error document is committed after the failure is reported; `did-finish-load` is the fallback if dom-ready was missed.
    wc.on('dom-ready', () => this.injectPending())
    wc.on('did-finish-load', () => this.injectPending())
    wc.on('did-finish-load', () => void this.showBlankStatus())
    // A page that loaded replaces whatever error was on screen. One that answered an error status is looked at once it has loaded.
    wc.on('did-navigate', (_event, url, status) => {
      this.shown = null
      const web = /^https?:\/\//i.test(url)
      this.statusToCheck = isStatusFailure(status) && web ? { url, status } : null
      this.failedStatus = isStatusFailure(status) && web ? status : null
    })
    wc.on('did-start-loading', () => this.dismissCover())
    // A failure belongs to the navigation that failed: once another one starts, its error page must not be written into whatever loads next.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.pending = null
    })
    wc.on('will-navigate', (event, url) => {
      const request = parseErrorAction(url)
      if (!request) return
      event.preventDefault()
      this.answer(request.action, request.nonce)
    })
    wc.on('render-process-gone', (_event, details) => {
      if (isCrash(details.reason) && !this.endedOnPurpose()) this.showCrash(details.reason)
    })
    // A renderer that does not answer: said at once, and taken back the moment it answers again (a page that is only busy comes back by itself).
    wc.on('unresponsive', () => this.showHung())
    wc.on('responsive', () => {
      if (this.shown?.kind === 'hung') this.dismissCover()
    })
  }

  /** Where the page is on screen (null: hidden), and its corner radius. The cover of a crashed page follows both. */
  place(bounds: Bounds | null, radius?: number): void {
    this.bounds = bounds
    if (radius !== undefined) this.radius = radius
    this.cover?.place(bounds, radius)
  }

  /** The page was brought above the other views: so is its cover. */
  raise(): void {
    this.cover?.raise()
  }

  /** Whether the keyboard is in our page laid over the page (a crash, a status page that showed nothing). */
  hasFocus(): boolean {
    return this.cover?.hasFocus() === true
  }

  dispose(): void {
    this.dismissCover()
    this.shown = null
    this.pending = null
  }

  /**
   * How the last load of the page ended badly: the network error of a load that failed (the site does not answer), the certificate refused, or the
   * error status its main document answered (a 404 that shows a page of its own too). Null for a page that loaded, and for a crash.
   */
  loadFailure(): LoadFailure | null {
    const model = this.pending ?? this.shown
    if (model?.kind === 'load') return { kind: 'network', name: model.name }
    if (model?.kind === 'certificate') return { kind: 'certificate', name: model.name }
    return this.failedStatus === null ? null : { kind: 'status', status: this.failedStatus }
  }

  /**
   * Whether the page on screen may have come over a certificate that was not valid: one was let through in this session for a page of its host (the
   * user's « Continuer quand même », or a site in Developer Mode). The address bar then says « Non sécurisé », never a padlock.
   */
  certificateUntrusted(): boolean {
    return !this.wc.isDestroyed() && certificateExceptions.isUntrusted(this.wc.session, exceptionHost(this.wc.getURL()))
  }

  /** Whether one of our error pages is on screen or on its way: its buttons carry the nonce that lets a certificate error through, which the DevTools protocol could read. */
  showsErrorPage(): boolean {
    return this.shown !== null || this.pending !== null
  }

  private onFailedLoad(code: number, description: string, url: string, isMainFrame: boolean): void {
    if (!isReportableFailure({ code, isMainFrame, url })) return
    const name = errorName(code, description)
    const upgrade = this.host.upgradeFailed(url, code, isCertificateError(name))
    if (upgrade.kind === 'fell-back') return
    if (isNavigableUrl(url)) this.host.announceUrl(url)
    const nonce = randomUUID()
    if (isCertificateError(name)) {
      const seen = this.lastCertificate?.host === exceptionHost(url) ? this.lastCertificate : null
      // What was refused belongs to this failure only: a later one without its own certificate must not borrow it.
      this.lastCertificate = null
      // An address the user asked for in http, tried over https first: the page may go back to it, on a click only (« Continuer en HTTP »).
      const http = upgrade.kind === 'refused' && this.host.continueOverHttp ? { http: upgrade.http } : {}
      // A host that asked for strict transport security: the page offers no way through (see strict-transport.ts).
      const strict = strictTransportHosts.isStrict(this.wc.session, exceptionHost(url)) ? { strict: true as const } : {}
      this.pending = { kind: 'certificate', url, name, nonce, canGoBack: false, certificate: seen?.facts ?? null, ...http, ...strict }
    } else {
      this.pending = { kind: 'load', url, name, nonce }
    }
  }

  private injectPending(): void {
    const model = this.pending
    if (!model || this.wc.isDestroyed()) return
    this.pending = null
    const shown: ErrorPageModel = model.kind === 'certificate' ? { ...model, canGoBack: this.wc.navigationHistory.canGoBack() } : model
    this.shown = shown
    const page = renderErrorPage(shown)
    const markup = `<head>${page.head}</head><body>${page.body}</body>`
    // innerHTML does not run scripts and does not fire another load: it cannot loop back into this handler.
    // Only into the document Chromium commits for a failed load (`chrome-error:`): checked in the document itself, at the moment of the
    // write, because by the time this runs a page that loaded since may be the one on screen, and it must not be overwritten.
    this.wc
      .executeJavaScript(`(() => { if (location.protocol !== 'chrome-error:') return false; document.documentElement.lang = 'fr'; document.documentElement.innerHTML = ${JSON.stringify(markup)}; return true })()`)
      .then((written: unknown) => {
        if (written !== true) console.warn('[engine] dropped an error page: the document on screen is not the one that failed')
      })
      .catch((error: unknown) => {
        if (!this.wc.isDestroyed()) console.warn('[engine] cannot show the error page:', (error as Error).message)
      })
  }

  /** A click on a button of the page on screen. Anything that does not carry its nonce, or does not belong to it, is ignored. */
  private answer(action: ErrorAction, nonce: string): void {
    const shown = this.shown
    if (!shown || shown.nonce !== nonce) return
    if (action === 'reload' && shown.kind === 'crash') {
      this.dismissCover()
      this.host.reload()
    } else if (action === 'reload' && shown.kind === 'hung') {
      this.dismissCover()
      if (this.wc.isDestroyed()) return
      // A renderer that does not answer would never run the reload: it is ended first (Electron's way to recover from `unresponsive`), and the reload starts a new one.
      this.endedOnPurposeAt = Date.now()
      this.wc.forcefullyCrashRenderer()
      this.host.reload()
    } else if (action === 'wait' && shown.kind === 'hung') {
      this.dismissCover()
    } else if (action === 'retry' && shown.kind !== 'crash') {
      this.host.reload()
    } else if (action === 'back' && (shown.kind === 'certificate' || shown.kind === 'status')) {
      this.host.goBack()
    } else if (action === 'home' && shown.kind === 'status') {
      // The home of the site the answer came from (its origin, a web address by construction): the page that answered goes, and so does our page with it.
      const home = homeOf(shown.url)
      if (home) this.wc.loadURL(home).catch((error: unknown) => console.warn('[engine] cannot open the home of the site:', (error as Error).message))
    } else if (action === 'network-settings' && shown.kind === 'load' && process.platform === 'darwin' && isLocalNetworkFailure(shown.name, shown.url)) {
      // The pane of the permission « Réseau local »: a constant address, offered only on the page of a device of the local network that macOS refused.
      shell.openExternal(LOCAL_NETWORK_SETTINGS_URL).catch((error: unknown) => console.warn('[engine] cannot open the settings of the local network:', (error as Error).message))
    } else if (action === 'copy-address' && (shown.kind === 'load' || shown.kind === 'status')) {
      // Copy the address to clipboard
      clipboard.writeText(shown.url).catch((error: unknown) => console.warn('[engine] cannot copy the address of the page:', (error as Error).message))
    } else if (action === 'open-mini-window' && (shown.kind === 'load' || shown.kind === 'status')) {
      // Only a web address opens there (`openLittle` checks it); the page that failed stays where it is.
      this.host.openMini?.(shown.url)
    } else if (action === 'toggle-blocker' && (shown.kind === 'load' || shown.kind === 'status')) {
      // Disable the ad/tracker blocker for this site
      this.host.toggleBlockException(shown.url)
      this.host.reload()
    } else if (action === 'http' && shown.kind === 'certificate' && shown.http !== undefined) {
      // The address the user asked for, in http, as it was before HTTPS first tried it: nothing of the page decides where it goes.
      this.host.continueOverHttp?.(shown.http)
    } else if (action === 'proceed' && shown.kind === 'certificate' && mayProceed(shown) && shown.certificate && !strictTransportHosts.isStrict(this.wc.session, exceptionHost(shown.url))) {
      certificateExceptions.allow(this.wc.session, exceptionHost(shown.url), shown.certificate.fingerprint)
      this.host.reload()
    }
  }

  // ---- a page whose process is gone, and a page that answered an error and shows nothing ----

  private showCrash(reason: string): void {
    this.dismissCover()
    const model: ErrorPageModel = { kind: 'crash', url: this.wc.getURL(), reason, nonce: randomUUID() }
    this.shown = model
    this.coverWith(model)
  }

  /** The page does not answer: our page over it says so, unless it is gone or already under a page of ours. */
  private showHung(): void {
    if (this.wc.isDestroyed() || this.shown !== null) return
    const model: ErrorPageModel = { kind: 'hung', url: this.wc.getURL(), nonce: randomUUID() }
    this.shown = model
    this.coverWith(model)
  }

  /** Whether the renderer that reports being gone was ended by `answer` to reload a hung page. */
  private endedOnPurpose(): boolean {
    const at = this.endedOnPurposeAt
    if (at === null) return false
    this.endedOnPurposeAt = null
    return Date.now() - at < ENDED_ON_PURPOSE_MS
  }

  /**
   * A document that answered 4xx or 5xx with nothing to show (an empty body: Chromium puts its own page there, Electron leaves it blank, and
   * the tab would say nothing at all). Looked at once loaded: only a document with no text, no image, no frame and no script is covered by
   * our page; a page that says something of its own (the usual 404 of a site) is left alone, and so is an application that draws itself.
   * The page underneath is not touched: the cover is a view of ours over it, with an address of its own, and goes when the tab navigates.
   */
  private async showBlankStatus(): Promise<void> {
    const check = this.statusToCheck
    this.statusToCheck = null
    if (!check || this.wc.isDestroyed()) return
    let facts: unknown
    try {
      facts = await this.wc.executeJavaScript(DOCUMENT_FACTS_SCRIPT)
    } catch (error) {
      // The page left meanwhile, or does not answer: it stays as it is (blank, as before), and the log says why.
      if (!this.wc.isDestroyed()) console.warn(`[engine] cannot tell whether the page of an HTTP ${check.status} is blank:`, (error as Error).message)
      return
    }
    // It must still be the document that answered the error, and nothing else must have started loading.
    if (this.wc.isDestroyed() || this.wc.isLoading() || this.wc.getURL() !== check.url || !isBlankDocument(documentFacts(facts))) return
    this.dismissCover()
    const model: ErrorPageModel = { kind: 'status', url: check.url, status: check.status, nonce: randomUUID(), canGoBack: this.wc.navigationHistory.canGoBack(), at: Date.now() }
    this.shown = model
    this.coverWith(model)
  }

  /** Lays our page for `model` over the page: its buttons are answered here, by nonce, like the ones of a failed load. */
  private coverWith(model: ErrorPageModel): void {
    const cover = new PageCover(this.host.win, this.wc.session, this.radius, this.host.focused)
    cover.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      const request = parseErrorAction(url)
      if (request) this.answer(request.action, request.nonce)
    })
    cover.load(errorPageDocument(model)).catch((error: unknown) => console.warn(`[engine] cannot show the ${model.kind} page:`, (error as Error).message))
    this.cover = cover
    cover.place(this.bounds)
  }

  private dismissCover(): void {
    const cover = this.cover
    if (!cover) return
    this.cover = null
    if (this.shown?.kind === 'crash' || this.shown?.kind === 'status' || this.shown?.kind === 'hung') this.shown = null
    cover.dispose()
  }
}
