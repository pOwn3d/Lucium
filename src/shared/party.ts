// Whose request is it? The blocker's Standard mode leaves a request alone when it goes to the site of the document that makes
// it (a site loading its own scripts, a player loading its own video): only third parties are filtered.
// Pure on purpose: the session hands over addresses, this file decides which document and which site they stand for.
// Imported by the main process only (it brings the public suffix list along): the settings code reads `blocker.ts` instead.
// The exact list (`tldts`), not the probabilistic one the filter engine carries (`tldts-experimental`): that one takes rare ordinary domains for
// suffixes (`q8x.io`), which would split a site in two here, and these answers decide what the blocker lets through and what the vault calls a neighbour.

import { getDomain, parse } from 'tldts'

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])

/**
 * The site an address belongs to: its registrable domain, the public suffix list counting private suffixes (every `*.github.io` is
 * a site of its own, as in the browser). A host that has none (an IP address, `localhost`, a bare name) is its own site. Null when
 * the address is not a web address with a host, so that nothing is ever called "the same site" on the strength of two unknowns.
 */
export function siteOf(address: string | null | undefined): string | null {
  if (!address || !URL.canParse(address)) return null
  const url = new URL(address)
  if (!WEB_PROTOCOLS.has(url.protocol)) return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  return getDomain(host, { allowPrivateDomains: true }) ?? host
}

/** Whether a request goes to the site of the document that makes it. False as soon as one of the two is unknown. */
export function isOwnSite(requestUrl: string, documentUrl: string | null | undefined): boolean {
  const mine = siteOf(documentUrl)
  return mine !== null && mine === siteOf(requestUrl)
}

/** The part of Electron's `onBeforeRequest` details that says who makes the request. */
export interface RequestOrigin {
  resourceType: string
  /** The origin that issued the request: the document's, or the worker's. "null" for a sandboxed document, absent for a request the browser started. */
  initiatorOrigin?: string | null
  /** The frame the request comes from. For a frame's own navigation that is the frame being loaded, whose parent is the one asking. */
  frame?: { url: string; parent?: { url: string } | null } | null
}

/** The address of the document that makes the request, or null when the session does not say. Electron-free: it reads plain properties. */
export function documentOfRequest(origin: RequestOrigin): string | null {
  // The origin is the best witness: it also covers workers, which have no frame, and a srcdoc or blank frame, which have no address of their own.
  if (origin.initiatorOrigin && siteOf(origin.initiatorOrigin) !== null) return origin.initiatorOrigin
  // A sandboxed document has an opaque origin, and a request the browser started has none: the frame still knows the address it was loaded from.
  let frameUrl: string | undefined
  try {
    // A frame that went away while the request was being made can refuse to answer.
    frameUrl = (origin.resourceType === 'subFrame' ? origin.frame?.parent?.url : origin.frame?.url) || undefined
  } catch {
    frameUrl = undefined
  }
  return frameUrl && siteOf(frameUrl) !== null ? frameUrl : null
}

/** Whether a host name is itself a public suffix (`com`, `co.uk`): every name under it is somebody else's site. Private suffixes (`github.io`) are not counted. */
export function isPublicSuffix(host: string): boolean {
  const name = host.toLowerCase()
  if (name === '' || name === 'localhost' || parse(name).isIp === true) return false
  // A name of one label is a top-level domain, known to the list or not.
  if (!name.includes('.')) return true
  // The list is asked about a name one label below: when that name is a whole site (or has none: a wildcard rule), `host` is a suffix.
  const site = getDomain(`x.${name}`)
  return site === null || site === `x.${name}`
}
