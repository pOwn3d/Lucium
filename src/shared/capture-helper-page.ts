// The page of the helper of a capture of the sound of a tab (main/engine/tab-capture-helper.ts). A window that asks for a screen has to be a secure context, or the browser gives
// it no `navigator.mediaDevices` at all, and an `about:blank` window (an opaque origin) is not one (measured on Electron 45.2.1, 13 November 2026). The helper is loaded from a fixed
// address of the scheme the Extensions page is served under (shared/internal-page.ts: `standard` and `secure`), on a host of its own: an origin that is no page of the application,
// and a document that holds nothing, made of a constant text and no file.
//
// Who may ask for it is the question the Extensions page already answers (shared/internal-serve.ts): a web page must not load it, embed it, nor tell that it is there. The
// engine may give a protocol handler none of the headers that say who asks, so the rule rests on a secret of the session that only the engine's own load carries
// (`x-lucium-page-load`); the headers are a second look where they come. The address is that one and no other (no path, no query), and no other part of the application
// reads it as a page to open (`isInternalPageUrl`, `isShellNavigable` do not know the host).

import { INTERNAL_LOAD_HEADER, type InternalRequest } from './internal-serve'
import { INTERNAL_SCHEME } from './internal-page'

/** The host of the helper page, which is not the host of the Extensions page. */
const CAPTURE_HELPER_HOST = 'capture-helper'

/** The one address the helper page is loaded from. Its origin, as `location.origin` writes it, is the same without the slash. */
export const CAPTURE_HELPER_URL = `${INTERNAL_SCHEME}://${CAPTURE_HELPER_HOST}/`

/** What the page is: nothing. The script it runs is given by the engine (`executeJavaScript`), and no file is read for it. */
export const CAPTURE_HELPER_DOCUMENT = '<!doctype html><meta charset="utf-8"><title></title>'

/** Whether an address is the helper page's: exactly that text, as Chromium writes it for a request (a path, a query or a fragment makes it another address, which is served nothing). */
export function namesCaptureHelper(url: unknown): boolean {
  return url === CAPTURE_HELPER_URL
}

/** Why a request for the helper page is refused, or null when it may be answered: the load the engine started for its own window, and nothing else. */
export function captureHelperRefusal(request: InternalRequest, load: string): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return `the method ${request.method.slice(0, 16)} is not one of a page loading`
  const header = (name: string): string | null => request.headers.get(name)
  // The secret first: a web page's own request for the address (a frame, a script, an image) has none.
  if (load.length < 16 || header(INTERNAL_LOAD_HEADER) !== load) return 'the helper page is served to the load of the engine only'
  const destination = header('sec-fetch-dest')
  if (destination !== null && destination !== 'document') return `the helper page is not asked as ${destination.slice(0, 24)}`
  const mode = header('sec-fetch-mode')
  if (mode !== null && mode !== 'navigate') return `the mode ${mode.slice(0, 24)} is not one of a page loading`
  // The engine loads it itself (`none`: nothing led to it), from no page.
  const site = header('sec-fetch-site')
  if (site !== null && site !== 'none') return `the request comes from ${site.slice(0, 24)}`
  if (header('origin') !== null) return 'the request comes from an origin'
  if (header('referer') !== null) return 'the request comes from a page'
  return null
}

/** What the main process knows of the sender of a chunk of sound, read when it arrives: from the frame as Chromium reports it, never from what the page says. */
export interface CapturePcmSenderFacts {
  /** The web contents is a helper page that exists (the engine of the captures made it for a claim and has not destroyed it). */
  isHelper: boolean
  /** `senderFrame.origin`, or undefined when there is no sender frame. */
  frameOrigin: unknown
  /** `senderFrame.url`. */
  frameUrl: unknown
  /** The frame is the main frame of its web contents and has no parent. */
  topFrame: boolean
}

/** Why a chunk of sound is not taken from this sender, or null when it may be judged: only the helper page of a capture, its main frame, at its own address and origin. */
export function capturePcmSenderRefusal(facts: CapturePcmSenderFacts): string | null {
  if (!facts.isHelper) return 'the sender is no helper page'
  if (facts.frameOrigin === undefined || facts.frameOrigin === null) return 'no sender frame'
  if (facts.frameOrigin !== CAPTURE_HELPER_URL.slice(0, -1)) return 'the sender frame is not at the origin of the helper page'
  if (!facts.topFrame) return 'the sender is not the main frame of the helper page'
  if (!namesCaptureHelper(facts.frameUrl)) return 'the sender document is not at the address of the helper page'
  return null
}

/** The headers of the answer: nothing frames it, nothing is sniffed, kept or sent on. */
export function captureHelperHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
  }
}
