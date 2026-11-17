// The only way the Web Store installer reaches the network. The library (electron-chrome-web-store) calls the `fetch` of the
// process for the package, the update check and the extension's icon, and takes the icon's address from the store page. This fetch
// stands in for it while the library is loaded (see web-store.ts): https only, Google's hosts only, every redirect checked, every
// answer bounded in size and time, and a package looked into (crx-scan.ts) before the library unpacks it.
// No Electron here: the transport is passed in, so the rules are tested against a local server.

import { isStoreHost } from '@shared/web-store'
import { CRX_MAX_BYTES, STORE_PUBLISHER_KEY_SHA256, scanCrx, type CrxScan } from './crx-scan'

/** The publisher key of the Chrome Web Store: a package it serves carries a proof by it, as Chromium requires. */
const STORE_PUBLISHER_KEYS: ReadonlySet<string> = new Set([STORE_PUBLISHER_KEY_SHA256])
import { readPiecesWithin } from '@shared/bounded-stream'

export class StoreNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StoreNetworkError'
  }
}

/** Gives up on a body that will not be read. Resolves to the reason it could not be closed, if any: the caller reports it with its own error. */
async function abandon(stream: { cancel(): Promise<void> } | null | undefined): Promise<unknown> {
  try {
    await stream?.cancel()
    return undefined
  } catch (error) {
    return error
  }
}

export const MAX_REDIRECTS = 5
export const JSON_MAX_BYTES = 1024 * 1024
export const ASSET_MAX_BYTES = 2 * 1024 * 1024
const PACKAGE_TIMEOUT_MS = 90_000
const SHORT_TIMEOUT_MS = 20_000
const REDIRECTS = new Set([301, 302, 303, 307, 308])
/** Answers that carry no body (a Response cannot be built with one). */
const NO_BODY = new Set([101, 204, 205, 304])

export interface StoreRequestInfo {
  method: string
  host: string
  /** The path without the query (the query holds the extension's id and the browser's version). */
  path: string
}

export interface StoreFetchOptions {
  /** The `fetch` that really goes to the network. */
  transport: typeof fetch
  /**
   * Engine tests only: where a request to an allowed address really goes. The allow-list is applied to the address the library wrote,
   * before this, so the rules run as they do in production.
   */
  rewrite?: (url: URL) => URL
  /** Called for each request that is sent (the checks read it; a log line is made from it). */
  onRequest?: (info: StoreRequestInfo) => void
  /** Called for a request that was refused before it was sent (an address that is not Google's, a redirect elsewhere, a port, credentials). */
  onRefused?: (url: URL, reason: string) => void
  /** Called with what a package holds, before the library unpacks it. Throwing refuses it. */
  inspectPackage?: (scan: CrxScan, url: URL) => void
  /**
   * The keys of the store, one of which must have signed every package (crx-scan.ts `publisherKeys`): the Chrome Web Store's own when absent. The
   * engine test serves packages signed by a key of its own.
   */
  publisherKeys?: ReadonlySet<string>
  /**
   * Called for the first address of a request the guard allows, before anything is sent and synchronously with the library's call: a
   * Response it returns is the answer, and nothing goes out (web-store.ts answers the picture a store page names this way).
   */
  answerLocally?: (url: URL, method: string) => Response | undefined
}

/** Whether the path is that of an extension package (the update service, or the blob it redirects to). */
const isPackagePath = (url: URL): boolean => url.pathname === '/service/update2/crx' || url.pathname.startsWith('/crx/')

/** The update check of the library (Omaha's JSON protocol). */
const isUpdateCheck = (url: URL): boolean => url.hostname.toLowerCase() === 'update.googleapis.com' && url.pathname === '/service/update2/json'

/**
 * The library marks its update check as coming from a development build ("testsource": "electron_dev") unless `NODE_ENV` is "production",
 * which nothing sets in the browser. The check goes out as the library's release build sends it, with the mark empty. A body that is not
 * the JSON expected is sent as it is (and said in the journal): the guard does not decide what the library asks.
 */
export function releaseUpdateBody(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    console.warn('[webstore] the update check is not JSON; it is sent as the library wrote it:', (error as Error).message)
    return body
  }
  const request = typeof parsed === 'object' && parsed !== null ? (parsed as { request?: unknown }).request : undefined
  if (typeof request !== 'object' || request === null || !('testsource' in request) || (request as { testsource?: unknown }).testsource === '') return body
  return JSON.stringify({ ...(parsed as object), request: { ...request, testsource: '' } })
}

export function capFor(url: URL): number {
  if (isPackagePath(url)) return CRX_MAX_BYTES
  return url.hostname.toLowerCase() === 'update.googleapis.com' ? JSON_MAX_BYTES : ASSET_MAX_BYTES
}

/** Throws unless the address is one the installer may reach. */
export function assertStoreUrl(url: URL, allowLoopback = false): void {
  if (url.username !== '' || url.password !== '') throw new StoreNetworkError(`address with credentials refused (${url.host})`)
  if (url.protocol !== 'https:') {
    // The engine check serves its fake store over http on the loopback: it asks for it explicitly.
    if (!(allowLoopback && url.protocol === 'http:')) throw new StoreNetworkError(`only https is allowed (${url.protocol}//${url.host})`)
  } else if (url.port !== '' && url.port !== '443') {
    throw new StoreNetworkError(`port ${url.port} refused (${url.host})`)
  }
  if (!isStoreHost(url.hostname)) throw new StoreNetworkError(`host not allowed: ${url.hostname}`)
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new StoreNetworkError(`answer larger than ${limit} bytes`, await abandon(response.body))
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = await readPiecesWithin(reader, limit)
  if (chunks === null) throw new StoreNetworkError(`answer larger than ${limit} bytes`, await abandon(reader))
  return Buffer.concat(chunks)
}

export function createStoreFetch(options: StoreFetchOptions): typeof fetch {
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input))
    let method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    let body = init?.body
    if (typeof body === 'string' && method === 'POST' && isUpdateCheck(url)) body = releaseUpdateBody(body)
    const headers = init?.headers
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        // Judged now, not when the guard was made: the engine check points `rewrite` at its local server after the library is loaded.
        assertStoreUrl(url, options.rewrite !== undefined)
      } catch (error) {
        options.onRefused?.(url, (error as Error).message)
        throw error
      }
      // Still in the caller's own turn (nothing was awaited yet): the answer can depend on what the caller is doing.
      const local = hop === 0 ? options.answerLocally?.(url, method) : undefined
      if (local) return local
      const target = options.rewrite ? options.rewrite(url) : url
      options.onRequest?.({ method, host: url.hostname, path: url.pathname })
      const cap = capFor(url)
      const response = await options.transport(target.href, {
        method,
        ...(headers ? { headers } : {}),
        ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(isPackagePath(url) ? PACKAGE_TIMEOUT_MS : SHORT_TIMEOUT_MS)
      })
      const location = response.headers.get('location')
      if (REDIRECTS.has(response.status) && location) {
        const failure = await abandon(response.body)
        if (failure !== undefined) console.warn(`[webstore] could not close the body of a redirect from ${url.hostname}:`, failure)
        // The next address is judged like the first: a redirect to another host is not a way round the list. One that cannot be read is refused as an
        // answer of the store, not thrown as a TypeError the callers do not expect.
        if (!URL.canParse(location, url)) throw new StoreNetworkError(`redirect to an address that cannot be read (${url.hostname})`)
        url = new URL(location, url)
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
        }
        continue
      }
      const bytes = await readBounded(response, cap)
      if (response.ok && bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'Cr24') {
        const scan = scanCrx(bytes, { publisherKeys: options.publisherKeys ?? STORE_PUBLISHER_KEYS })
        options.inspectPackage?.(scan, url)
      }
      const contentType = response.headers.get('content-type')
      return new Response(NO_BODY.has(response.status) ? null : new Uint8Array(bytes), {
        status: response.status,
        statusText: response.statusText,
        ...(contentType ? { headers: { 'content-type': contentType } } : {})
      })
    }
    throw new StoreNetworkError(`more than ${MAX_REDIRECTS} redirects`)
  }
}
