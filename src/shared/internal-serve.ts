// What a session serves under the `lucium-ui:` scheme (engine/internal-pages.ts): the files of the Extensions page, and only these. Pure rules: which request
// is one of the page, which files the page may load, what the answer carries.
//
// The page is the bundle of the interface (`extensions.html` and the files it loads) and holds nothing secret, but a web page must not be able to open it,
// embed it, read it or even tell that it is there (a `<script>`, an `<img>` or a `<link>` of a web page that loads one of its files, and an `onload` that says it
// did, names the application and its build). The engine may give a protocol handler none of the headers that would tell who asks (`Sec-Fetch-*`, `Referer` under
// `Referrer-Policy: no-referrer`), so the rule does not rest on them; two secrets of the session do, and the headers are a second layer where they come:
//   - the files are served under a key, `lucium-ui://extensions/<key>/assets/<name>`, that only the document of the page knows (the document is served with its
//     references written under the key: `internalDocumentOf`); a web page cannot name a file, so nothing it loads answers;
//   - the document is served to the load that carries the secret of the shell (`INTERNAL_LOAD_HEADER`, given by the shell to its own `loadURL` and to nobody
//     else): no `<iframe>`, `<script>` or `<img>` of a web page gets it, and a web page cannot read it anyway;
//   - the answer: `frame-ancestors 'none'` and `X-Frame-Options`, which Chromium applies to the document whoever asked, and `Cross-Origin-Resource-Policy`;
//   - the page: it is given no API unless its origin is exactly the page's and it is the top frame (preload/internal-extensions.ts), and the main process
//     checks the sender of every message again (shared/internal-gate.ts).
// On the development server the files are the server's own, at absolute paths that no key can precede: only the document is gated there.

import { INTERNAL_ORIGIN, internalPageParts } from './internal-page'

/** The document of the page in the built bundle (`out/renderer`) and on the development server. */
export const INTERNAL_DOCUMENT = 'extensions.html'

/** What a request names: the page itself, or a file of the bundle under `assets/` (as the bundler writes the files the page loads). */
export type InternalFile = { kind: 'page'; file: typeof INTERNAL_DOCUMENT } | { kind: 'asset'; file: string }

/** A file of the bundle, under the key of the session. */
const KEYED_ASSET = /^lucium-ui:\/\/extensions\/([A-Za-z0-9]{16,64})\/assets\/([A-Za-z0-9._-]{1,200})(?:\?[^#\s\\]*)?$/

/** What the engine adds to the load of the page by the shell, and to nothing else: `x-lucium-page-load: <secret>` (`internalLoadHeader`). */
export const INTERNAL_LOAD_HEADER = 'x-lucium-page-load'

/** The line of `extraHeaders` (`loadURL`) that makes a load the shell's. */
export function internalLoadHeader(load: string): string {
  return `${INTERNAL_LOAD_HEADER}: ${load}`
}

/** What a session holds to tell the page's own requests: the secrets, and where its files are. */
export interface InternalAccess {
  /** The secret the shell carries when it loads the page (`INTERNAL_LOAD_HEADER`), at least 16 characters: what no web page can give. */
  load: string
  /** The built bundle: the key its files are served under (`/<key>/assets/<name>`). Absent on the development server, whose paths are its own. */
  key?: string | undefined
  /** The folder of the project, given while the application runs on the development server: adds the files that server has for the page (`internalDevPath`). */
  projectRoot?: string | undefined
}

/**
 * The file a request address names, or null when it names none of the page: any other host, any other path, a file of the bundle outside the key, a path
 * with a dot only, an encoded name. A file of the bundle is only the one under the key of `access`; the files of the development server only with its project.
 */
export function internalFileOf(url: unknown, access: Pick<InternalAccess, 'key' | 'projectRoot'> = {}): InternalFile | null {
  if (internalPageParts(url) !== null) return { kind: 'page', file: INTERNAL_DOCUMENT }
  if (typeof url !== 'string') return null
  if (access.key !== undefined) {
    const found = url.length > 512 ? null : KEYED_ASSET.exec(url)
    if (found?.[1] === access.key && !/^\.+$/.test(found[2]!)) return { kind: 'asset', file: `assets/${found[2]}` }
  }
  const dev = access.projectRoot === undefined ? null : internalDevPath(url, access.projectRoot)
  return dev === null ? null : { kind: 'asset', file: dev }
}

/** The references of the document to the files of the bundle (`./assets/x.js`), which the document is served with under the key: nothing else names a file. */
const ASSET_REFERENCE = /(["'(])(\.?\/)assets\//g

/**
 * The document with every file it names written under the key of the session: `./assets/x.js` becomes `./<key>/assets/x.js`. What those files import is
 * relative to them, so it follows. A document that names no file of the bundle is not the page: null.
 */
export function internalDocumentOf(html: string, key: string): string | null {
  const written = html.replace(ASSET_REFERENCE, `$1$2${key}/assets/`)
  return written.includes(`/${key}/assets/`) ? written : null
}

/** The part of a request the policy reads (a `Request` of the fetch API fits). */
export interface InternalRequest {
  method: string
  url: string
  headers: { get(name: string): string | null }
}

/** What each kind of file may be asked as (`Sec-Fetch-Dest`): the page only as a document, the rest only as what a page draws itself from. */
const DESTINATIONS = { page: new Set(['document']), asset: new Set(['script', 'style', 'image', 'font']) } as const
const MODES = { page: new Set(['navigate']), asset: new Set(['no-cors', 'cors', 'same-origin']) } as const

/**
 * Why a request is refused, or null when it may be answered. The address says first: a file is served under the key of the session only, the document to the load
 * of the shell only. Then a header the engine does not give is not held against the request (the key and the secret stand); one it gives and that is not one of
 * the page loading itself is: an `iframe`, an `embed`, an `object` or a fetch (`empty`) is refused, and so is anything that comes from another origin or another
 * site.
 */
export function internalRequestRefusal(request: InternalRequest, access: InternalAccess): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return `the method ${request.method.slice(0, 16)} is not one of a page loading`
  const file = internalFileOf(request.url, access)
  if (file === null) return 'it names no file of the page'
  const header = (name: string): string | null => request.headers.get(name)
  // The document goes to the load the shell started, which alone carries the secret. A web page's own request for it (a frame, a script, an image) has none.
  if (file.kind === 'page' && (access.load.length < 16 || header(INTERNAL_LOAD_HEADER) !== access.load)) return 'the document is served to the load of the shell only'
  const destination = header('sec-fetch-dest')
  if (destination !== null && !DESTINATIONS[file.kind].has(destination)) return `a ${file.kind === 'page' ? 'page' : 'file'} is not asked as ${destination.slice(0, 24)}`
  const mode = header('sec-fetch-mode')
  if (mode !== null && !MODES[file.kind].has(mode)) return `the mode ${mode.slice(0, 24)} is not one of a page loading`
  // The shell loads the page (`none`: nothing led to it), and what the page loads comes from the page.
  const site = header('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && !(file.kind === 'page' && site === 'none')) return `the request comes from ${site.slice(0, 24)}`
  const origin = header('origin')
  if (origin !== null && origin !== INTERNAL_ORIGIN) return 'the request comes from another origin'
  const referer = header('referer')
  if (referer !== null && !referer.startsWith(`${INTERNAL_ORIGIN}/`)) return 'the request comes from another page'
  return null
}

// ---- what the page may load ----

/** The kinds of file the bundle holds, and the type each is served with. Any other is not served. */
const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon'
}

/** The type a file of the bundle is served with, from its name; null for a kind the page does not load. */
export function internalContentType(file: string): string | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase()
  return extension !== undefined && Object.hasOwn(TYPES, extension) ? TYPES[extension]! : null
}

/** The most files the page may load (the bundle of the page is some thirty). */
export const INTERNAL_FILES_MAX = 400
const READABLE = /\.(?:html|js|mjs|css)$/
const NAMED = /[A-Za-z0-9_@][A-Za-z0-9._@-]*\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)(?![A-Za-z0-9_-])/g

/**
 * The files of the bundle the page may load: the document, what it names, what those name in turn (a script imports another, a style names a font), as far as
 * the files exist. The bundler writes every file the page loads by its name in the files that load it, so reading the names is reading the page's own list; a name
 * that is no file of the bundle is nothing. Whatever else is in the folder (the other pages of the interface) is not on the list.
 * `read` gives the text of a file of the bundle (`assets/x.js`, or the document), null when it cannot be read; `has` says whether a file is there.
 */
export function internalFileList(read: (file: string) => string | null, has: (file: string) => boolean): Set<string> {
  const allowed = new Set<string>([INTERNAL_DOCUMENT])
  const queue = [INTERNAL_DOCUMENT]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (!READABLE.test(current)) continue
    const text = read(current)
    if (text === null) continue
    for (const named of text.matchAll(NAMED)) {
      if (allowed.size >= INTERNAL_FILES_MAX) break
      // `NAMED` only finds the kinds of file `TYPES` serves.
      const file = `assets/${named[0]}`
      if (allowed.has(file) || !has(file)) continue
      allowed.add(file)
      queue.push(file)
    }
  }
  return allowed
}

// ---- what the answer carries ----

/**
 * The policy of content of the page: what its `<meta>` says (extensions.html), and the one directive a `<meta>` cannot carry, `frame-ancestors`, which keeps any
 * page from showing it in a frame. A test keeps the two in step.
 */
export const INTERNAL_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"

/** The headers of an answer. Nothing allows another origin to read it (no `Access-Control-Allow-Origin`), nothing frames it, nothing is sniffed or kept. */
export function internalResponseHeaders(file: InternalFile): Record<string, string> {
  const type = internalContentType(file.file)
  return {
    'content-type': type ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    // `same-origin`: what the page loads carries the address of the page (a second look at who asks, for the engines that give the header), and nothing leaves it.
    ...(file.kind === 'page' ? { 'content-security-policy': INTERNAL_CSP, 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' } : {})
  }
}

// ---- development ----

const DEV_PREFIXES = ['/@vite/', '/@id/', '/node_modules/.vite/'] as const
const DEV_SOURCE = /^\/[A-Za-z0-9_-][A-Za-z0-9_.@/-]*\.(?:tsx?|jsx?|css|svg|png|jpe?g|woff2?|json)$/

/**
 * Where the development server is asked for what the page loads while the application is not packaged: its path and query, or null for a file the page has no
 * business with. The page is its document; the server's own client, the dependencies it prepared and the sources of the project are the rest (the `@shared` modules
 * are outside the folder of the pages, so the server names them under `/@fs/`: only those of `src/` of the project).
 */
export function internalDevPath(url: unknown, projectRoot: string): string | null {
  if (internalPageParts(url) !== null) return `/${INTERNAL_DOCUMENT}`
  // The origin as a prefix leaves no other host, user or port. What is asked of the server is the path the parser made (a `..` or a `%2e%2e` is already collapsed in it),
  // and that is the path the list below judges.
  if (typeof url !== 'string' || url.length > 1024 || !url.startsWith(`${INTERNAL_ORIGIN}/`) || !URL.canParse(url)) return null
  const parsed = new URL(url)
  const path = parsed.pathname
  const allowed = path === '/@react-refresh' || DEV_PREFIXES.some((prefix) => path.startsWith(prefix)) || (path.startsWith(`/@fs${projectRoot}/src/`) && DEV_SOURCE.test(path.slice(`/@fs${projectRoot}`.length))) || DEV_SOURCE.test(path)
  return allowed ? `${path}${parsed.search}` : null
}
