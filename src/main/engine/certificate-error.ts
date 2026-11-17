// The `certificate-error` listener of a page (see error-pages.ts for what the user sees): a certificate the user chose to trust is let
// through, and so is one of a site the user put in Developer Mode; what was refused is handed over for the error page that follows the
// failed load. Nothing is let through in silence: the page of a certificate let through says « Non sécurisé » (markUntrusted).
//
// Two bounds, as in the other browsers:
//  - Developer Mode lets a certificate through only for this machine and the local network. A site of the internet the user listed (to reload it
//    without the cache) keeps its error page: there, an invalid certificate is an interception until the user says otherwise, for that certificate.
//  - a host that asked for strict transport security (strict-transport.ts) gets no exception at all: the choice of the user is not offered, and one
//    made before the host asked is no longer honoured.

import { type CertificateExceptions, type CertificateFacts, canBypassCertificateError, errorName, exceptionHost, isOwnNetworkUrl } from '@shared/error-pages'

/** The part of Electron's `Certificate` that is read. */
export interface CertificateLike {
  fingerprint: string
  subjectName: string
  issuerName: string
  validStart: number
  validExpiry: number
}

export interface CertificateErrorListenerOptions {
  exceptions: CertificateExceptions
  /** The session of the page, read when the event arrives (a page can be moved to another one). */
  session: () => object
  /** The address of the page the request belongs to (its main frame), read when the event arrives. */
  pageUrl: () => string
  /**
   * Whether an address is on a site the user put in Developer Mode (⌃D, the setting `developerHosts`), read when the event arrives. Only there is an
   * invalid certificate let through without a question, and only when the address is one of this machine or of the local network
   * (`isOwnNetworkUrl`): a preproduction on `.local`, `localhost` or a private address that the user listed.
   */
  developerSite: (url: string) => boolean
  /** Whether a host asked for strict transport security: no exception is honoured for it. Absent: none did. */
  strictTransport?: (host: string) => boolean
  /** A certificate refused for the main frame: the page that follows the failure shows it. */
  refused: (host: string, facts: CertificateFacts) => void
  /** An invalid certificate was let through for a page of `pageHost` (its own, or one of what it loads): the page is not secure. */
  accepted?: (pageHost: string) => void
  /** How the answer is postponed. Only the tests change it. */
  defer?: (run: () => void) => void
}

export type CertificateErrorListener = (
  event: { preventDefault(): void },
  url: string,
  error: string,
  certificate: CertificateLike,
  callback: (isTrusted: boolean) => void,
  isMainFrame: boolean
) => void

export function certificateErrorListener(options: CertificateErrorListenerOptions): CertificateErrorListener {
  const defer = options.defer ?? ((run: () => void) => void setImmediate(run))
  return (event, url, error, certificate, callback, isMainFrame) => {
    const site = exceptionHost(url)
    const facts: CertificateFacts = {
      fingerprint: certificate.fingerprint,
      subject: certificate.subjectName,
      issuer: certificate.issuerName,
      validFrom: certificate.validStart,
      validUntil: certificate.validExpiry
    }
    const pageUrl = options.pageUrl()
    // A site in Developer Mode: the tab opened on it (the main frame), and what a page of such a site loads from another one of them (the API of a
    // preproduction, its WebSocket). A page from anywhere else loading something from a listed site gets no such pass: its request is refused like
    // any other. An error nobody may click through (a revoked certificate, a pinned key) is refused there too.
    const developerPass = (address: string) => options.developerSite(address) && isOwnNetworkUrl(address)
    const developer = developerPass(url) && (isMainFrame || developerPass(pageUrl)) && canBypassCertificateError(errorName(0, error))
    const excepted = options.exceptions.isAllowed(options.session(), site, facts.fingerprint) && options.strictTransport?.(site) !== true
    if (developer || excepted) {
      event.preventDefault()
      // The page this certificate belongs to says « Non sécurisé » from now on, never a padlock (see CertificateExceptions.markUntrusted).
      const pageHost = isMainFrame ? site : exceptionHost(pageUrl)
      options.exceptions.markUntrusted(options.session(), pageHost)
      // And what this host answers from now on is not believed when it asks for strict transport security (strict-transport.ts).
      options.exceptions.markLetThrough(options.session(), site)
      options.accepted?.(pageHost)
      // Answered once the event is over, never from inside it: the answer resumes the request in Chromium, and Electron 45.0.0 still has
      // to hand this same event to `app` afterwards. Done in the listener, the application died there (SIGSEGV in
      // App::AllowCertificateError) each time the user clicked "Continuer quand même" for a certificate with a chain.
      defer(() => callback(true))
      return
    }
    // Left alone, the event refuses the certificate. The page that follows the failure shows what was refused.
    if (isMainFrame) options.refused(site, facts)
  }
}
