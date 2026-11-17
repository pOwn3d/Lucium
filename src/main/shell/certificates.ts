// Client certificates (mutual TLS). Without a handler, Electron presents the first certificate of the system keychain to any server that
// asks for one, which tells a site (and a page that makes the request) who the user is, without a word from them. Until there is a
// prompt to choose one, none is presented: the server is told the browser has no certificate, and the user is told why the site may fail,
// by a notice in the window of the page that names the site.

import { schemeOf } from '@shared/external-links'
import { t } from '@shared/i18n'

type CertificateRequest = (event: { preventDefault(): void }, contents: unknown, url: string, certificates: unknown[], callback: (certificate?: unknown) => void) => void

/** How many servers are remembered as already said, in one run: past that, the journal alone says the refusal. */
export const CERTIFICATE_NOTICES_MAX = 50

/** How long the notice stays: it explains a page that failed, and has no button to bring it back. */
export const CERTIFICATE_NOTICE_MS = 10_000

/**
 * What the user reads when a server asked for a certificate, with the host of that server. The notice is shown in the window of the page and
 * goes by itself: it is not a notice of the system, which would stay in the notification centre with the name of a site of a private tab.
 */
export const clientCertificateNotice = (site: string): string => t('certificates.site-demande-un-certificat', { site })

/** Says the refusal in the window of the page of `contents` (the web contents Electron names), for the server `site`; false when it could not. */
export type CertificateTell = (contents: unknown, site: string) => boolean

const serverOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : '')

/**
 * The answer to every request for a client certificate: none. `tell` has the notice shown, once for each server in a run (a page asks again at
 * every connection it opens); it returns false when the notice could not be shown (a request no page of a tab made), which the journal then says.
 */
export function refuseClientCertificate(tell?: CertificateTell): CertificateRequest {
  const told = new Set<string>()
  return (event, contents, url, certificates, callback) => {
    // Stops Electron from choosing for us; answering with nothing is what ends the request.
    event.preventDefault()
    console.warn(`[certificates] a ${schemeOf(url)} server asked for a client certificate (${certificates.length} in the keychain): none was presented`)
    callback()
    const server = serverOf(url)
    if (!tell || server === '' || told.has(server) || told.size >= CERTIFICATE_NOTICES_MAX) return
    told.add(server)
    let said = false
    try {
      said = tell(contents, server)
    } catch (error) {
      console.error('[certificates] the notice of a refused client certificate failed:', error instanceof Error ? error.message : String(error))
    }
    // Not said: the server may be told about again, by the next page that asks.
    if (!said) {
      told.delete(server)
      console.error('[certificates] could not tell the user that no client certificate was presented: no window shows the page that asked')
    }
  }
}

/** `app` (or any emitter of its events): from now on no client certificate is presented to a server, and `tell` says so to the user. */
export function refuseClientCertificates(host: NodeJS.EventEmitter, tell?: CertificateTell): void {
  host.on('select-client-certificate', refuseClientCertificate(tell))
}
