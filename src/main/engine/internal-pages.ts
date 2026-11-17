// The Extensions page, served to a tab. The page is the bundle of the interface (`extensions.html` and the files it loads), and a tab shows it at
// `lucium-ui://extensions/` (shared/internal-page.ts): each session of the application answers that scheme itself, with `protocol.handle`, and answers it for
// the page alone. A session of a profile serves the files; a private context and a tab container refuse every request, since the page never opens there.
//
// Who may ask is decided by shared/internal-serve.ts (which request is the page loading itself, which files it may load, what the answer carries), and the page
// is given `window.lucium` by a preload of its own that does nothing anywhere else (preload/internal-extensions.ts), registered here for the address of the
// page. Nothing is served from a folder the page names: the files are the ones the document lists, and the list is made from the built bundle.
//
// Two secrets are made for each session, when it starts to serve: the key its files are served under (the document is written with it, so only the document names
// a file) and the secret the shell adds to its own load of the page (`internalLoadHeaders`), without which the document is not served. Neither depends on a header
// the engine may not hand to a protocol handler. What the handler is given is told to whoever listens (`watchInternalRequests`: the engine check reads it).
//
// The same scheme serves one more document, to the engine alone: the empty page the helper of a capture of the sound of a tab is loaded from, which has to be a secure
// context (shared/capture-helper-page.ts). It has a secret of its own for each session, made when the session starts to serve, and nothing of the page above is read for it.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INTERNAL_PAGES_MATCH, INTERNAL_SCHEME } from '@shared/internal-page'
import { CAPTURE_HELPER_DOCUMENT, captureHelperHeaders, captureHelperRefusal, namesCaptureHelper } from '@shared/capture-helper-page'
import { INTERNAL_DOCUMENT, INTERNAL_LOAD_HEADER as INTERNAL_LOAD_HEADER_NAME, internalDocumentOf, internalFileList, internalFileOf, internalLoadHeader, internalRequestRefusal, internalResponseHeaders, type InternalAccess, type InternalFile } from '@shared/internal-serve'

export interface InternalPagesHome {
  /** The folder of the built pages (`out/renderer`). */
  rendererDir: string
  /** The development server, while the application is not packaged: the page is then asked of it, file by file. */
  devUrl?: string | undefined
  /** The folder of the project (the development server names the sources under `/@fs/<it>/src/`). */
  projectRoot: string
}

/** What the server reads and asks: the system's, or a test's. */
export interface InternalPagesIo {
  /** The text of a file of the bundle (relative to `rendererDir`), or null when it cannot be read. */
  readText(file: string): string | null
  has(file: string): boolean
  readBytes(file: string): Uint8Array
  /** One file of the development server. */
  fetchDev(address: string): Promise<Response>
}

export function systemIo(home: InternalPagesHome): InternalPagesIo {
  return {
    readText: (file) => {
      try {
        return readFileSync(join(home.rendererDir, file), 'utf8')
      } catch (error) {
        console.warn(`[internal-page] ${file} of the bundle could not be read to list what the page loads:`, error instanceof Error ? error.message : String(error))
        return null
      }
    },
    has: (file) => existsSync(join(home.rendererDir, file)),
    readBytes: (file) => readFileSync(join(home.rendererDir, file)),
    fetchDev: (address) => fetch(address)
  }
}

const refusal = (status: number): Response => new Response(null, { status })

/** The secrets of a session that serves the page: made once, from the system's source of randomness, and never written anywhere. */
export interface InternalSecrets {
  /** The key the files are served under. */
  key: string
  /** What the shell adds to its own load of the page. */
  load: string
}

export function newInternalSecrets(): InternalSecrets {
  return { key: randomBytes(16).toString('hex'), load: randomBytes(16).toString('hex') }
}

/** What the handler was given for one request, and what it answered: the engine check reads this to learn which headers the engine hands a protocol handler. */
export interface InternalRequestRecord {
  /** The address without its query, and with the key of the session as `<key>`. */
  url: string
  method: string
  status: number
  /** Why it was refused, or null. */
  why: string | null
  /** The headers that say where the request comes from, as the handler received them (null: not given). */
  fetchHeaders: Record<'sec-fetch-dest' | 'sec-fetch-mode' | 'sec-fetch-site' | 'sec-fetch-user' | 'origin' | 'referer', string | null>
  /** What the `Request` says of its referrer (the fetch API's own field), apart from the header. */
  referrer: string
  /** Whether the request carried the secret of the shell's load. */
  loadSecret: boolean
  /** The names of all the headers it carried. */
  headerNames: string[]
}

/**
 * Which of the headers that tell who asks the engine handed the handler, over these requests (the name of each one that was given at least once, and `referrer` when the
 * `Request` itself names one). Verified on Electron 45.2.1 (13 November 2026): none. The engine check reads this to say when a later Electron changes that, so that the
 * question of the headers as a second layer is reopened (docs/design/extensions-en-onglet.md, decision 4).
 */
export function headersGiven(records: ReadonlyArray<Pick<InternalRequestRecord, 'fetchHeaders' | 'referrer'>>): string[] {
  const given = new Set<string>()
  for (const record of records) {
    for (const [name, value] of Object.entries(record.fetchHeaders)) if (value !== null) given.add(name)
    // `about:client` is what the fetch API says when no referrer was set: it names nothing.
    if (record.referrer !== '' && record.referrer !== 'about:client') given.add('referrer')
  }
  return [...given].sort()
}

let sink: ((record: InternalRequestRecord) => void) | null = null

/** Tells `listener` every request a session of this process answers for the page, with the headers it was given (null: stop). For the engine check, which runs in a real Electron. */
export function watchInternalRequests(listener: ((record: InternalRequestRecord) => void) | null): void {
  sink = listener
}

/** The refusals the log tells in full: a page that asks over and over must not fill it. */
const REFUSALS_LOGGED = 20

/** Answers the requests of the page, in a session that serves it. */
export class InternalPageServer {
  private allowed: Set<string> | null = null
  private refused = 0

  constructor(
    private readonly home: InternalPagesHome,
    private readonly io: InternalPagesIo,
    private readonly secrets: InternalSecrets = newInternalSecrets()
  ) {}

  /** The line of extra headers that makes a load of the page the shell's. */
  loadHeader(): string {
    return internalLoadHeader(this.secrets.load)
  }

  private get access(): InternalAccess {
    // The development server names its own paths, which no key precedes: only the document is gated there.
    return this.home.devUrl === undefined ? { load: this.secrets.load, key: this.secrets.key } : { load: this.secrets.load, projectRoot: this.home.projectRoot }
  }

  /** What a session answers a request with: the file, or a refusal that says nothing (the log says why). */
  async respond(request: Request): Promise<Response> {
    const access = this.access
    const why = internalRequestRefusal(request, access)
    const answer = why === null ? await this.serve(request, access) : this.refuse(request, why)
    if (sink !== null) sink(this.recordOf(request, answer, why))
    return answer
  }

  private refuse(request: Request, why: string): Response {
    // The key is a secret of the session: a request that named it is told without it.
    if (this.refused++ < REFUSALS_LOGGED) console.warn(`[internal-page] refused a request for ${this.quiet(request.url)}: ${why}${this.refused === REFUSALS_LOGGED ? ' (the next ones are not logged)' : ''}`)
    return refusal(403)
  }

  private async serve(request: Request, access: InternalAccess): Promise<Response> {
    const file = internalFileOf(request.url, access)!
    try {
      if (this.home.devUrl !== undefined) return await this.fromDevServer(file)
      // Built: only a file the document lists, read once and for all from the bundle.
      this.allowed ??= internalFileList(this.io.readText, this.io.has)
      if (!this.allowed.has(file.file)) {
        console.warn(`[internal-page] ${file.file} is no file of the page`)
        return refusal(404)
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: internalResponseHeaders(file) })
      const bytes = this.io.readBytes(file.file)
      if (file.kind === 'asset') return new Response(bytes as BodyInit, { status: 200, headers: internalResponseHeaders(file) })
      // The document names its files under the key of the session: it is the only thing that does.
      const document = internalDocumentOf(new TextDecoder().decode(bytes), this.secrets.key)
      if (document === null) throw new Error('the document names no file of the bundle')
      return new Response(document, { status: 200, headers: internalResponseHeaders(file) })
    } catch (error) {
      console.error(`[internal-page] cannot serve ${file.file}:`, error)
      return refusal(500)
    }
  }

  /** An address as the log and the record tell it: no query, no key. */
  private quiet(url: string): string {
    return (url.split(/[?#]/)[0] ?? '').replaceAll(this.secrets.key, '<key>').slice(0, 120)
  }

  private recordOf(request: Request, answer: Response, why: string | null): InternalRequestRecord {
    const header = (name: string): string | null => request.headers.get(name)
    return {
      url: this.quiet(request.url),
      method: request.method,
      status: answer.status,
      why,
      fetchHeaders: { 'sec-fetch-dest': header('sec-fetch-dest'), 'sec-fetch-mode': header('sec-fetch-mode'), 'sec-fetch-site': header('sec-fetch-site'), 'sec-fetch-user': header('sec-fetch-user'), origin: header('origin'), referer: header('referer') },
      referrer: request.referrer,
      loadSecret: header(INTERNAL_LOAD_HEADER_NAME) === this.secrets.load,
      headerNames: [...request.headers.keys()].sort()
    }
  }

  private async fromDevServer(file: InternalFile): Promise<Response> {
    // The request policy already judged the address (`internalFileOf` with the folder of the project): a file of the development server is its path and query.
    const path = file.kind === 'page' ? `/${INTERNAL_DOCUMENT}` : file.file.startsWith('/') ? file.file : `/${file.file}`
    const answer = await this.io.fetchDev(`${this.home.devUrl}${path}`)
    if (!answer.ok) return refusal(answer.status === 404 ? 404 : 502)
    // The server knows the type of what it serves (a `.tsx` is a script); the rest of the answer is ours.
    const headers = internalResponseHeaders(file)
    const type = answer.headers.get('content-type')
    if (type !== null && file.kind === 'asset') headers['content-type'] = type
    return new Response(answer.body, { status: 200, headers })
  }
}

/** The script of the page as a frame preload, and unpacked from app.asar as the others are (Chromium reads it from disk). */
export function internalPreloadPath(mainDir: string = __dirname): string {
  return join(mainDir, '../preload/internal-extensions.js').replace('app.asar', 'app.asar.unpacked')
}

export const INTERNAL_PRELOAD_ID = 'lucium-internal-extensions'

/** The part of Electron's `Session` this needs. */
export interface InternalPagesSession {
  protocol: { handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void }
  registerPreloadScript(script: { id: string; type: 'frame'; filePath: string; matches: string[] }): string
}

const installed = new WeakSet<object>()
/** The secret of each session that serves the helper page: what the engine's own load of it carries. */
const helperLoads = new WeakMap<object, string>()
let helperRefusals = 0
/** The servers of the sessions that serve the page: what the shell asks for the line it adds to its own load. */
const servers = new WeakMap<object, InternalPageServer>()

/**
 * The extra header that makes a load of the page the shell's, for a session that serves it (`loadURL`'s `extraHeaders`); null for any other session, whose page
 * is refused anyway. Only the engine's own load of a tab asks for it.
 */
export function internalLoadHeaders(ses: object): string | null {
  return servers.get(ses)?.loadHeader() ?? null
}

/**
 * The extra header that makes a load of the helper page the engine's, for a session that serves it; null for any other session (a private context, a container, one that is
 * not ours), where the helper page is refused anyway.
 */
export function captureHelperLoadHeader(ses: object): string | null {
  const load = helperLoads.get(ses)
  return load === undefined ? null : internalLoadHeader(load)
}

/** The answer for the helper page when the request names its address, or null for any other request (the page of Extensions, or nothing of ours). */
export function captureHelperAnswer(request: Request, load: string): Response | null {
  if (!namesCaptureHelper(request.url)) return null
  const why = captureHelperRefusal(request, load)
  if (why !== null) {
    if (helperRefusals++ < REFUSALS_LOGGED) console.warn(`[capture-helper] refused a request for the helper page: ${why}${helperRefusals === REFUSALS_LOGGED ? ' (the next ones are not logged)' : ''}`)
    return refusal(403)
  }
  return new Response(request.method === 'HEAD' ? null : CAPTURE_HELPER_DOCUMENT, { status: 200, headers: captureHelperHeaders() })
}

let home: InternalPagesHome | null = null
let makeIo: (home: InternalPagesHome) => InternalPagesIo = systemIo

/** Where the page is, told once by the application when it starts (before any page is made). */
export function setInternalPagesHome(value: InternalPagesHome, io: (home: InternalPagesHome) => InternalPagesIo = systemIo): void {
  home = value
  makeIo = io
}

/**
 * Makes a session answer the scheme of the page: `serve` for the session of a profile (the files, and the preload for the address of the page), `refuse` for the
 * session of a private context or a container (every request is refused, whoever asks). Once for a session. A preload that cannot be limited to the address of the
 * page is not registered at all, and the error says so: a script that ran in every page of the session would be what the limit was there to avoid.
 */
export function installInternalPages(ses: InternalPagesSession, mode: 'serve' | 'refuse'): void {
  if (installed.has(ses)) return
  installed.add(ses)
  if (mode === 'refuse') {
    ses.protocol.handle(INTERNAL_SCHEME, () => refusal(403))
    return
  }
  // The helper page of a capture needs no file and no knowledge of where the pages are: its session has its secret whatever the rest does.
  const helperLoad = randomBytes(16).toString('hex')
  helperLoads.set(ses, helperLoad)
  if (home === null) {
    // Said when the page is asked for, not when the session is made: a test of the engine makes sessions, and the application says where the page is before its first page.
    ses.protocol.handle(INTERNAL_SCHEME, (request) => {
      const helper = captureHelperAnswer(request, helperLoad)
      if (helper !== null) return helper
      console.error('[internal-page] the application did not say where the Extensions page is: every request for it is refused')
      return refusal(403)
    })
    return
  }
  const server = new InternalPageServer(home, makeIo(home))
  servers.set(ses, server)
  ses.protocol.handle(INTERNAL_SCHEME, (request) => captureHelperAnswer(request, helperLoad) ?? server.respond(request))
  try {
    ses.registerPreloadScript({ id: INTERNAL_PRELOAD_ID, type: 'frame', filePath: internalPreloadPath(), matches: [INTERNAL_PAGES_MATCH] })
  } catch (error) {
    console.error('[internal-page] the script of the Extensions page could not be registered for its address, so it is not registered at all (it would run in every page of the session): the page will have no window.lucium and shows nothing:', error)
  }
}
