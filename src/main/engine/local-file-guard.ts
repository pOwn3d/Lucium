// What a local file opened in a tab may load from the disk. The fuse `grantFileProtocolExtraPrivileges` stays on (electron-builder.yml): the
// interface is loaded from file:// inside app.asar, which only that fuse lets Electron read (AsarURLLoaderFactory), and castLabs' signing service
// signs no set of fuses where it is off (docs/drm.md, section 5). With it, Electron gives every `file:` document universal access and file access
// (OverrideWebPreferences): a page saved on the disk, reopened in a tab, could read any file of the Mac by `fetch` or by a frame, and send it away.
// Chrome refuses that read. The same refusal is made here, in the `onBeforeRequest` hook of every session of pages (electron-engine-network.ts);
// the interface is in the default session, which has no such hook, and keeps loading its own files.
//
// What still loads, so that a local page still shows: the document itself (a link, the address bar, a dropped file), the same file again (the PDF
// viewer reads the file it shows), and what a page displays — its images, styles, scripts, fonts, media and PDF frames, by their extension —
// when they are in the folder of the document or below it. A document lying directly in a wide folder (the home folder, Downloads, Desktop…, or a
// folder at the root of the disk) gets only the folder its browser saved beside it (`<name>_files/`). Everything else is refused: fetch and
// XMLHttpRequest, frames of other files, hidden files and folders, any other kind of request, and any file request of a page that is not local.
//
// The same fuse makes Chromium skip the same-origin rule for what a local document asks of the web: its `fetch` and its XMLHttpRequest read the
// answer of any site, a service of the machine or of the local network included. Chrome gives a local page the opaque origin "null", and such an
// answer only when the server shares it. The second half of this file makes the same judgement on the headers of the answer (the hooks
// `onBeforeSendHeaders` and `onHeadersReceived` of the session, electron-engine-network.ts). What a page shows without reading it (an image, a
// style sheet, a classic script, media, a frame) loads as before, as in a page saved from the web. Every other request is judged, however the
// page says it makes it: with universal access a `fetch` in the mode `same-origin` or `no-cors` leaves like any other and its answer is not
// opaque, so the mode a page chooses cannot be what exempts it. And a request of the web that comes from a local file with no page behind it
// (a shared worker) does not leave at all, as for the files of the disk.

import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'

/** The URL pattern the hook adds to its filter so that it sees the requests for local files. */
export const LOCAL_FILE_PATTERN = 'file:///*'

/** What the shown part of a local page may load, by the resource type of the request (Electron's names) and the extension of the file. */
const DISPLAYED: Record<string, ReadonlySet<string>> = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'apng']),
  stylesheet: new Set(['css']),
  // Only scripts by their name: Chromium reports a JSON or text module import as a script too, and that would hand the page the text of the file.
  script: new Set(['js', 'mjs']),
  font: new Set(['woff', 'woff2', 'ttf', 'otf']),
  media: new Set(['mp4', 'm4v', 'webm', 'mov', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'ogv', 'opus', 'wav', 'flac', 'vtt']),
  // A frame of another file is readable by the page (universal access): only a PDF, whose text the viewer keeps to itself.
  subFrame: new Set(['pdf']),
  object: new Set(['pdf'])
}

/** A request for a local file, as the hook sees it. */
export interface LocalFileRequest {
  url: string
  /** Electron's `resourceType`: mainFrame, subFrame, xhr, image… */
  resourceType: string
  /** The address of the top document of the page that asks (`webContents.getURL()`), or null when no page asks. */
  topUrl: string | null
}

/** The answer: refused, let through, or let through once the real path of `file` (links followed) is found inside the real path of `root`. */
export type LocalFileVerdict = { allow: false } | { allow: true; confine?: { file: string; root: string } }

const REFUSED: LocalFileVerdict = { allow: false }

/** The decoded segments of the path of a local file address, or null for anything that is not one or that hides a separator or a dot segment. */
export function localPathSegments(address: string): string[] | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  // A host would name another machine (a share): nothing of the sort is opened in a tab.
  if (url.protocol !== 'file:' || (url.host !== '' && url.host !== 'localhost')) return null
  const raw = url.pathname.split('/').slice(1)
  const segments: string[] = []
  for (const part of raw) {
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      return null
    }
    // `%2F` or `%5C` would turn one segment into two once the loader decodes it; a NUL ends the path early; `.`/`..` climb out of the folder.
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') || decoded === '.' || decoded === '..') return null
    segments.push(decoded)
  }
  return segments
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const stemOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/** A folder too wide for a document in it to reach all of it: the root and its direct folders, the home folder and its direct folders. */
export function isWideFolder(folder: readonly string[], home: readonly string[]): boolean {
  if (folder.length <= 2) return true
  const inHome = home.length > 0 && home.every((segment, index) => folder[index] === segment)
  return inHome && folder.length <= home.length + 1
}

const toPath = (segments: readonly string[]): string => `/${segments.join('/')}`

/** Whether a request of a page session for a local file may go (see the head of this file). `home` is the home folder of the user. */
export function localFileVerdict(request: LocalFileRequest, home: string): LocalFileVerdict {
  // The navigation of a tab: what opens a local file in a tab is judged before (the address bar, a link of a local page, a dropped file).
  if (request.resourceType === 'mainFrame') return { allow: true }
  const wanted = localPathSegments(request.url)
  const top = request.topUrl === null ? null : localPathSegments(request.topUrl)
  if (!wanted || !top || top.length === 0) return REFUSED
  // The same file as the document: the PDF viewer reads what it shows. Nothing is learnt that the page did not already hold.
  if (wanted.length === top.length && wanted.every((segment, index) => segment === top[index])) return { allow: true }
  const displayed = DISPLAYED[request.resourceType]
  const name = wanted[wanted.length - 1] ?? ''
  if (!displayed || !displayed.has(extensionOf(name))) return REFUSED
  const folder = top.slice(0, -1)
  if (wanted.length <= folder.length || !folder.every((segment, index) => wanted[index] === segment)) return REFUSED
  const below = wanted.slice(folder.length)
  // Hidden files and folders (.ssh, .config, .env…) are never part of what a page shows.
  if (below.some((segment) => segment.startsWith('.'))) return REFUSED
  let root = folder
  if (isWideFolder(folder, home.split(sep).filter((segment) => segment !== ''))) {
    // Only the folder a browser saves beside a page ("Page web, complète"): `page.html` and `page_files/`.
    const companion = `${stemOf(top[top.length - 1] ?? '')}_files`
    if (below.length < 2 || below[0] !== companion) return REFUSED
    root = [...folder, companion]
  }
  return { allow: true, confine: { file: toPath(wanted), root: toPath(root) } }
}

/** The real path of each, links followed: the file must still be inside the folder, so that a link saved beside a page cannot point elsewhere. */
export async function stillInside(confine: { file: string; root: string }, resolve: (path: string) => Promise<string> = realpath): Promise<boolean> {
  try {
    const [file, root] = await Promise.all([resolve(confine.file), resolve(confine.root)])
    if (!file.startsWith(`${root}${sep}`)) return false
    return !file.slice(root.length + 1).split(sep).some((segment) => segment.startsWith('.'))
  } catch {
    // A file that does not exist, or that cannot be read: there is nothing to let through.
    return false
  }
}

/** The answer of the hook for a local file, always given once: refused on any failure. */
export function answerLocalFile(request: LocalFileRequest, home: string, callback: (response: { cancel: boolean }) => void, resolve?: (path: string) => Promise<string>): void {
  let verdict: LocalFileVerdict
  try {
    verdict = localFileVerdict(request, home)
  } catch (error) {
    console.error('[engine] the local file guard failed, so the request is refused:', error instanceof Error ? error.message : error)
    verdict = REFUSED
  }
  if (!verdict.allow) {
    console.warn(`[engine] refused a ${request.resourceType} request of a page for a local file`)
    return callback({ cancel: true })
  }
  if (!verdict.confine) return callback({ cancel: false })
  void stillInside(verdict.confine, resolve).then((inside) => {
    if (!inside) console.warn('[engine] refused a local file outside the folder of the page that asked for it')
    callback({ cancel: !inside })
  })
}

// ---------------------------------------------------------------- what a local page reads of the web ----------------------------------------------------------------

type Headers = Record<string, string | string[]> | undefined

/** A request of a page for a web address, as the `onBeforeSendHeaders` hook sees it. */
export interface WebRequestOfPage {
  url: string
  /** Electron's `resourceType`. */
  resourceType: string
  /** The origin of the frame that asks (`WebFrameMain.origin`), or null when the request names no frame (a worker). */
  frameOrigin: string | null
  /** The address of the top document of the page that asks, or null when no page asks. */
  topUrl: string | null
  /** The origin that issued the request, as the browser knows it and not as the page says (Electron's `initiatorOrigin`); absent when it names none. */
  initiatorOrigin?: string | null | undefined
  requestHeaders: Headers
}

/** What is kept of a request between its headers leaving and its answer arriving. */
export interface LocalPageRead {
  /** The request carries what identifies the user to the server (cookies, an HTTP login). */
  credentials: boolean
}

const headerOf = (headers: Headers, name: string): string | null => {
  if (!headers) return null
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return (Array.isArray(value) ? value.join(', ') : String(value)).trim()
  }
  return null
}

/** The request types whose answer the page that asks gets to read, for a request that does not say how it was made (no `Sec-Fetch-Mode`). */
const READ_BY_THE_PAGE: ReadonlySet<string> = new Set(['xhr', 'font'])

/**
 * The request types of what a page shows without reading it, when the request says so (`Sec-Fetch-Mode: no-cors`): an image, a style sheet, a
 * classic script, media. A `fetch` in that mode is none of them (Electron names it `xhr`), and is judged.
 */
const ONLY_SHOWN: ReadonlySet<string> = new Set(['image', 'stylesheet', 'script', 'media'])

/** The request is of a local file with no page behind it, and must not leave. */
export const REFUSED_READ = 'refused'

/**
 * Whether a document of a local file is asking the web for an answer it would read: `fetch`, XMLHttpRequest, an event stream, a module, a font,
 * an image asked for with `crossorigin`, the script of a worker. Answers what to remember of the request until its answer comes; `REFUSED_READ`
 * for a request that names neither frame nor page and that a local file issued (a shared worker of a local page: nothing says which page, so
 * nothing is let out, as for the files of the disk); or null for a request that is not judged: one of a web document (a frame of a site inside
 * a local page included), a navigation, a websocket, or what a page only shows.
 *
 * The mode the request names (`Sec-Fetch-Mode`) exempts nothing by itself: a page chooses it (`fetch(url, { mode: 'same-origin' })`), and with
 * universal access Chromium sends such a request to any site and hands the answer back. Only `navigate` and `websocket`, which no `fetch` can
 * name, and `no-cors` for the kinds a page shows, are left alone.
 */
export function localPageRead(request: WebRequestOfPage): LocalPageRead | typeof REFUSED_READ | null {
  if (!/^https?:/i.test(request.url)) return null
  // The frame that asks is the witness. A request that names no frame (a worker) is judged on the top document of its page.
  const asker = request.frameOrigin ?? request.topUrl
  if (asker === null) return request.initiatorOrigin?.toLowerCase().startsWith('file:') === true ? REFUSED_READ : null
  if (!asker.startsWith('file:')) return null
  if (request.resourceType === 'mainFrame' || request.resourceType === 'subFrame') return null
  const mode = headerOf(request.requestHeaders, 'sec-fetch-mode')?.toLowerCase() ?? null
  if (mode === 'navigate' || mode === 'websocket') return null
  const shown = mode === null ? !READ_BY_THE_PAGE.has(request.resourceType) : mode === 'no-cors' && ONLY_SHOWN.has(request.resourceType)
  if (shown) return null
  return { credentials: headerOf(request.requestHeaders, 'cookie') !== null || headerOf(request.requestHeaders, 'authorization') !== null }
}

/**
 * The reads of local pages whose answer is awaited, by the id Electron gives a request. A request that never gets an answer leaves its entry behind,
 * so the oldest go once they are stale; and when there is no room left, a new read is refused rather than let through unjudged: a page must not be
 * able to push the read it wants to hide out of the memory by flooding it.
 */
export class PendingReads {
  private readonly waiting = new Map<number, { read: LocalPageRead; at: number }>()

  constructor(
    private readonly max = 2000,
    private readonly staleMs = 5 * 60_000
  ) {}

  /** Remembers a read. False when there is no room for it: the request must not leave. */
  note(id: number, read: LocalPageRead, now: number): boolean {
    this.waiting.delete(id)
    if (this.waiting.size >= this.max) {
      for (const [known, entry] of this.waiting) if (now - entry.at > this.staleMs) this.waiting.delete(known)
    }
    if (this.waiting.size >= this.max) return false
    this.waiting.set(id, { read, at: now })
    return true
  }

  /** The request under this id is not a read (any more): a redirect can turn it into something else. */
  forget(id: number): void {
    this.waiting.delete(id)
  }

  /** The read whose answer just came, forgotten from now on; undefined for a request that is not one. */
  take(id: number): LocalPageRead | undefined {
    const entry = this.waiting.get(id)
    this.waiting.delete(id)
    return entry?.read
  }
}

/**
 * Whether the server shares its answer with a local page, as the same-origin rule of the web reads the headers for the origin "null":
 * `Access-Control-Allow-Origin: *` or `null` for a request that carries nothing of the user, `Access-Control-Allow-Origin: null` with
 * `Access-Control-Allow-Credentials: true` for one that does. An answer that says nothing is not shared.
 */
export function sharedWithLocalPage(read: LocalPageRead, responseHeaders: Headers): boolean {
  const allowed = headerOf(responseHeaders, 'access-control-allow-origin')
  if (allowed === null) return false
  if (!read.credentials) return allowed === '*' || allowed === 'null'
  return allowed === 'null' && headerOf(responseHeaders, 'access-control-allow-credentials') === 'true'
}
