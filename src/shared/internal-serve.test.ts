import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INTERNAL_CSP, INTERNAL_DOCUMENT, INTERNAL_FILES_MAX, INTERNAL_LOAD_HEADER, internalContentType, internalDevPath, internalDocumentOf, internalFileList, internalFileOf, internalLoadHeader, internalRequestRefusal, internalResponseHeaders, type InternalAccess } from './internal-serve'

const PAGE = 'lucium-ui://extensions/'
// The two secrets of a session (engine/internal-pages.ts makes them at random): the key the files are served under, and what the shell adds to its own load.
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' // gitleaks:allow (invented for this test, the key of no session)
const LOAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const access: InternalAccess = { key: KEY, load: LOAD }
const ASSET = `lucium-ui://extensions/${KEY}/assets/extensions-CbXs4uTl.js`
const asset = (name: string): string => `lucium-ui://extensions/${KEY}/assets/${name}`
const fileOf = (url: unknown, given: Pick<InternalAccess, 'key' | 'projectRoot'> = access) => internalFileOf(url, given)
const refusal = (req: ReturnType<typeof request>, given: InternalAccess = access) => internalRequestRefusal(req, given)

function request(url: string, headers: Record<string, string> = {}, method = 'GET') {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  return { method, url, headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null } }
}
const loaded = { [INTERNAL_LOAD_HEADER]: LOAD }
const navigation = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', ...loaded }
const script = { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', origin: 'lucium-ui://extensions', referer: 'lucium-ui://extensions/' }

describe('internalFileOf', () => {
  it('names the page for its two paths, and a file of the bundle for what is under the key and assets/', () => {
    expect(fileOf(PAGE)).toEqual({ kind: 'page', file: INTERNAL_DOCUMENT })
    expect(fileOf('lucium-ui://extensions/shortcuts')).toEqual({ kind: 'page', file: INTERNAL_DOCUMENT })
    expect(fileOf(`${PAGE}?id=${'a'.repeat(32)}`)).toEqual({ kind: 'page', file: INTERNAL_DOCUMENT })
    expect(fileOf(ASSET)).toEqual({ kind: 'asset', file: 'assets/extensions-CbXs4uTl.js' })
    expect(fileOf(`${ASSET}?v=1`)).toEqual({ kind: 'asset', file: 'assets/extensions-CbXs4uTl.js' })
  })

  it('names no file of the bundle outside the key: not without it, not with another, not when the session has none', () => {
    const name = 'extensions-CbXs4uTl.js'
    expect(fileOf(`lucium-ui://extensions/assets/${name}`)).toBeNull()
    expect(fileOf(`lucium-ui://extensions/${'0'.repeat(32)}/assets/${name}`)).toBeNull()
    expect(fileOf(`lucium-ui://extensions/${KEY.toUpperCase()}/assets/${name}`)).toBeNull()
    expect(fileOf(`lucium-ui://extensions/${KEY.slice(0, 31)}/assets/${name}`)).toBeNull()
    expect(fileOf(`lucium-ui://extensions/${KEY}x/assets/${name}`)).toBeNull()
    expect(fileOf(`lucium-ui://extensions/${KEY}/${KEY}/assets/${name}`)).toBeNull()
    expect(fileOf(`lucium-ui://extensions/assets/${KEY}/${name}`)).toBeNull()
    expect(fileOf(ASSET, {})).toBeNull()
    // The page itself needs no key: it is the address the shell shows.
    expect(fileOf(PAGE, {})).toEqual({ kind: 'page', file: INTERNAL_DOCUMENT })
  })

  it('names nothing for another host, another path, a way out of the folder or an encoded name', () => {
    const refused = [
      'lucium-ui://evil/KEY/assets/a.js',
      'lucium-ui://extensions@evil/KEY/assets/a.js',
      'lucium-ui://extensions.evil.com/KEY/assets/a.js',
      'lucium-ui://extensions/KEY/assets/../index.html',
      'lucium-ui://extensions/KEY/assets/..',
      'lucium-ui://extensions/KEY/assets/.',
      'lucium-ui://extensions/KEY/assets/%2e%2e%2findex.html',
      'lucium-ui://extensions/KEY/assets/a%2fb.js',
      'lucium-ui://extensions/KEY/assets/sub/a.js',
      'lucium-ui://extensions/KEY/assets/',
      'lucium-ui://extensions/KEY/assets',
      'lucium-ui://extensions/KEY/index.html',
      'lucium-ui://extensions/KEY/settings.html',
      'lucium-ui://extensions/index.html',
      'lucium-ui://extensions/settings.html',
      'lucium-ui://extensions/extensions.html',
      'lucium-ui://extensions\\KEY\\assets\\a.js',
      'LUCIUM-UI://EXTENSIONS/KEY/assets/a.js',
      'lucium-ui://extensions/KEY/assets/a b.js',
      `lucium-ui://extensions/KEY/assets/${'a'.repeat(300)}.js`,
      'https://example.org/KEY/assets/a.js',
      ''
    ].map((url) => url.replace('KEY', KEY))
    for (const url of refused) expect(fileOf(url), url).toBeNull()
    for (const value of [undefined, null, 3, {}]) expect(fileOf(value)).toBeNull()
  })
})

describe('the files of the development server', () => {
  const root = '/Users/jane/lucium'
  const dev: InternalAccess = { projectRoot: root, load: LOAD }

  it('are files of the page only when the folder of the project is given', () => {
    expect(fileOf('lucium-ui://extensions/extensions.tsx')).toBeNull()
    expect(fileOf('lucium-ui://extensions/extensions.tsx', dev)).toEqual({ kind: 'asset', file: '/extensions.tsx' })
    expect(fileOf('lucium-ui://extensions/@vite/client', dev)).toEqual({ kind: 'asset', file: '/@vite/client' })
    expect(fileOf('lucium-ui://extensions/', dev)).toEqual({ kind: 'page', file: INTERNAL_DOCUMENT })
    expect(fileOf('lucium-ui://extensions/@fs/etc/passwd', dev)).toBeNull()
    expect(fileOf('lucium-ui://evil/extensions.tsx', dev)).toBeNull()
  })

  it('are judged by the same request policy, and the document is served to the shell’s load there too', () => {
    const asModule = { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', origin: 'lucium-ui://extensions' }
    expect(refusal(request('lucium-ui://extensions/extensions.tsx', asModule), dev)).toBeNull()
    expect(refusal(request('lucium-ui://extensions/extensions.tsx', asModule))).not.toBeNull()
    expect(refusal(request('lucium-ui://extensions/extensions.tsx', { ...asModule, 'sec-fetch-dest': 'empty' }), dev)).not.toBeNull()
    expect(refusal(request('lucium-ui://extensions/extensions.tsx', { ...asModule, origin: 'https://evil.example' }), dev)).not.toBeNull()
    expect(refusal(request(PAGE, navigation), dev)).toBeNull()
    expect(refusal(request(PAGE, { 'sec-fetch-dest': 'document' }), dev)).not.toBeNull()
  })
})

describe('internalRequestRefusal', () => {
  it('answers the page loading itself: the shell’s navigation, and what the page draws from', () => {
    expect(refusal(request(PAGE, navigation))).toBeNull()
    expect(refusal(request('lucium-ui://extensions/shortcuts', navigation))).toBeNull()
    expect(refusal(request(ASSET, script))).toBeNull()
    for (const destination of ['style', 'image', 'font']) expect(refusal(request(asset('a.css'), { ...script, 'sec-fetch-dest': destination }))).toBeNull()
    // The engine may give none of the Sec-Fetch headers to a protocol handler: the request is then judged by its address and the secret of the shell.
    expect(refusal(request(PAGE, loaded))).toBeNull()
    expect(refusal(request(ASSET))).toBeNull()
    expect(refusal(request(PAGE, loaded, 'HEAD'))).toBeNull()
  })

  it('serves the document to the load of the shell and to no other: a request without the secret, or with another, is refused whatever else it says', () => {
    // What a web page can do with `<iframe>`, `<script>`, `<img>` and `<link>` under any referrer policy: it cannot add the header.
    expect(refusal(request(PAGE))).not.toBeNull()
    expect(refusal(request(PAGE, { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }))).not.toBeNull()
    expect(refusal(request(PAGE, { [INTERNAL_LOAD_HEADER]: 'f'.repeat(32) }))).not.toBeNull()
    expect(refusal(request(PAGE, { [INTERNAL_LOAD_HEADER]: LOAD.slice(0, 31) }))).not.toBeNull()
    expect(refusal(request(PAGE, { [INTERNAL_LOAD_HEADER]: '' }))).not.toBeNull()
    expect(refusal(request('lucium-ui://extensions/shortcuts', { 'sec-fetch-dest': 'document' }))).not.toBeNull()
    expect(refusal(request(PAGE, loaded, 'HEAD'))).toBeNull()
    expect(refusal(request(PAGE, {}, 'HEAD'))).not.toBeNull()
  })

  it('serves nothing when the session holds no usable secret: a short one is no secret', () => {
    expect(refusal(request(PAGE, { [INTERNAL_LOAD_HEADER]: '' }), { key: KEY, load: '' })).not.toBeNull()
    expect(refusal(request(PAGE, { [INTERNAL_LOAD_HEADER]: 'abc' }), { key: KEY, load: 'abc' })).not.toBeNull()
  })

  it('does not ask a file of the bundle for the secret of the shell: the page does not hold it, and the key is what names a file', () => {
    expect(refusal(request(ASSET, script))).toBeNull()
    expect(refusal(request(ASSET, { ...script, ...loaded }))).toBeNull()
  })

  it('refuses a frame, an embed, an object and a fetch: a page cannot show the page or read it', () => {
    for (const destination of ['iframe', 'frame', 'embed', 'object', 'empty', 'worker', 'sharedworker', 'serviceworker', 'manifest', 'audio', 'video', 'track', 'report', 'xslt', 'fencedframe', 'webidentity', 'x']) {
      expect(refusal(request(PAGE, { ...navigation, 'sec-fetch-dest': destination })), destination).not.toBeNull()
      expect(refusal(request(ASSET, { ...script, 'sec-fetch-dest': destination })), destination).not.toBeNull()
    }
  })

  it('refuses a file of the page asked as the document, and the document asked as a file', () => {
    expect(refusal(request(ASSET, { ...script, 'sec-fetch-dest': 'document' }))).not.toBeNull()
    expect(refusal(request(PAGE, { ...navigation, 'sec-fetch-dest': 'script' }))).not.toBeNull()
  })

  it('refuses another mode, another site and another origin', () => {
    expect(refusal(request(PAGE, { ...navigation, 'sec-fetch-mode': 'cors' }))).not.toBeNull()
    expect(refusal(request(PAGE, { ...navigation, 'sec-fetch-mode': 'no-cors' }))).not.toBeNull()
    expect(refusal(request(ASSET, { ...script, 'sec-fetch-mode': 'navigate' }))).not.toBeNull()
    for (const site of ['cross-site', 'same-site', 'x']) {
      expect(refusal(request(PAGE, { ...navigation, 'sec-fetch-site': site })), site).not.toBeNull()
      expect(refusal(request(ASSET, { ...script, 'sec-fetch-site': site })), site).not.toBeNull()
    }
    // `none` is a person or the shell asking for a document, never a file of the page.
    expect(refusal(request(ASSET, { ...script, 'sec-fetch-site': 'none' }))).not.toBeNull()
    for (const origin of ['https://evil.example', 'null', 'lucium-ui://extensions.evil.com', 'lucium-ui://extensions/', 'lucium-ui://evil']) {
      expect(refusal(request(ASSET, { ...script, origin })), origin).not.toBeNull()
    }
  })

  it('refuses a request that another page led to, when the engine gives the header of it', () => {
    for (const referer of ['https://evil.example/', 'https://evil.example/page', 'lucium-ui://extensions.evil.com/', 'lucium-ui://evil/', 'null', '']) {
      expect(refusal(request(ASSET, { referer })), referer).not.toBeNull()
      expect(refusal(request(PAGE, { ...loaded, referer })), referer).not.toBeNull()
    }
    expect(refusal(request(ASSET, { origin: 'https://evil.example' }))).not.toBeNull()
    expect(refusal(request(ASSET, { referer: 'lucium-ui://extensions/shortcuts' }))).toBeNull()
  })

  it('refuses a request that writes, and an address that is no file of the page', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT']) expect(refusal(request(PAGE, navigation, method)), method).not.toBeNull()
    expect(refusal(request('lucium-ui://evil/', navigation))).not.toBeNull()
    expect(refusal(request(`lucium-ui://extensions/${KEY}/assets/../x`, script))).not.toBeNull()
  })

  it('gives the line a load adds to carry the secret', () => {
    expect(internalLoadHeader(LOAD)).toBe(`x-lucium-page-load: ${LOAD}`)
    expect(INTERNAL_LOAD_HEADER).toBe(INTERNAL_LOAD_HEADER.toLowerCase())
  })
})

describe('internalDocumentOf', () => {
  // The document of the build (vite writes the files the page loads as `./assets/<name>`), shortened.
  const html = '<!doctype html><html><head><script type="module" crossorigin src="./assets/extensions-BxahU_Tj.js"></script><link rel="modulepreload" crossorigin href="./assets/surface-O2BWw_uR.js"><link rel="stylesheet" crossorigin href="./assets/extensions-m73o7jIm.css"></head><body><div id="root"></div></body></html>'

  it('writes every file the document names under the key, and nothing else', () => {
    const written = internalDocumentOf(html, KEY)!
    expect(written).toContain(`src="./${KEY}/assets/extensions-BxahU_Tj.js"`)
    expect(written).toContain(`href="./${KEY}/assets/surface-O2BWw_uR.js"`)
    expect(written).toContain(`href="./${KEY}/assets/extensions-m73o7jIm.css"`)
    expect(written.replaceAll(`${KEY}/`, '')).toBe(html)
    // Each address it now names is one the policy serves.
    for (const named of written.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
      expect(fileOf(`lucium-ui://extensions/${named[1]}`), named[1]).not.toBeNull()
    }
  })

  it('writes the references of a style (`url(./assets/…)`) and of an absolute path too, and names no file of the bundle outside the key', () => {
    const written = internalDocumentOf(`<style>@font-face{src:url(./assets/a.woff2)}</style><script src='/assets/b.js'></script><script src="./assets/c.js"></script>`, KEY)!
    expect(written).toBe(`<style>@font-face{src:url(./${KEY}/assets/a.woff2)}</style><script src='/${KEY}/assets/b.js'></script><script src="./${KEY}/assets/c.js"></script>`)
    expect(written.match(/assets\//g)).toHaveLength(3)
    expect(written.match(new RegExp(`${KEY}/assets/`, 'g'))).toHaveLength(3)
  })

  it('puts the key in the references to its files and nowhere else, and has no link, form, frame, base or refresh that could carry it out', () => {
    const written = internalDocumentOf(html, KEY)!
    const references = [...written.matchAll(/\s(?:src|href)="[^"]*"/g)].map((found) => found[0])
    expect(references.length).toBeGreaterThan(0)
    for (const reference of references) expect(reference).toContain(`/${KEY}/assets/`)
    // Every place the key stands is one of those references.
    expect(written.split(KEY).length - 1).toBe(references.length)
    // The document of the build, as it is written in the repository (and so as the build keeps it): no element that goes anywhere but the files it loads.
    const source = readFileSync(fileURLToPath(new URL('../renderer/extensions.html', import.meta.url)), 'utf8')
    for (const text of [written, source]) {
      expect(text).not.toMatch(/<(a|form|iframe|frame|object|embed|img|video|audio|base)[\s>]/i)
      expect(text).not.toMatch(/http-equiv="refresh"/i)
    }
  })

  it('is served with a policy of referrer that sends nothing of the page out, and a policy of content that opens no connection', () => {
    expect(internalResponseHeaders({ kind: 'page', file: INTERNAL_DOCUMENT })['referrer-policy']).toBe('same-origin')
    // No host and no wildcard in the policy: nothing the page loads or connects to is outside its own origin.
    expect(INTERNAL_CSP).not.toMatch(/https?:|\*|connect-src|script-src/)
  })

  it('is no page when it names no file of the bundle', () => {
    expect(internalDocumentOf('<html><body>nothing</body></html>', KEY)).toBeNull()
    expect(internalDocumentOf('', KEY)).toBeNull()
  })
})

describe('internalContentType', () => {
  it('serves the kinds of file a bundle holds, and no other', () => {
    expect(internalContentType('assets/a.js')).toBe('text/javascript; charset=utf-8')
    expect(internalContentType('assets/a.css')).toBe('text/css; charset=utf-8')
    expect(internalContentType('extensions.html')).toBe('text/html; charset=utf-8')
    expect(internalContentType('assets/a.woff2')).toBe('font/woff2')
    expect(internalContentType('assets/a.PNG')).toBe('image/png')
    for (const file of ['assets/a.json', 'assets/a.map', 'assets/a.exe', 'assets/a', 'assets/a.constructor', 'assets/a.__proto__', 'assets/a.hasOwnProperty']) expect(internalContentType(file), file).toBeNull()
  })
})

describe('internalFileList', () => {
  const bundle: Record<string, string> = {
    'extensions.html': '<script type="module" crossorigin src="./assets/extensions-A.js"></script><link rel="modulepreload" href="./assets/surface-B.js"><link rel="stylesheet" href="./assets/extensions-C.css">',
    'assets/extensions-A.js': 'import{a}from"./root-D.js";import"./surface-B.js";const x="./assets/ghost-Z.js"',
    'assets/surface-B.js': 'export const t=1;const u=new URL("./inter-E.woff2",import.meta.url)',
    'assets/root-D.js': 'export const r=1;import("./late-F.js")',
    'assets/late-F.js': 'export const l=1',
    'assets/extensions-C.css': '@font-face{src:url(./inter-E.woff2)}.x{background:url(./sepia-G.png)}',
    'assets/inter-E.woff2': 'font bytes ./never-read.js',
    'assets/sepia-G.png': 'png bytes',
    // Files of other pages of the interface, which nothing the page loads names.
    'assets/settings-H.js': 'import"./extensions-A.js"',
    'assets/overlay-I.js': 'x',
    'assets/never-read.js': 'x',
    'index.html': '<script src="./assets/overlay-I.js">'
  }
  const read = (file: string): string | null => bundle[file] ?? null
  const has = (file: string): boolean => file in bundle

  it('is the document and what it loads, transitively, and no file of another page', () => {
    expect([...internalFileList(read, has)].sort()).toEqual(['assets/extensions-A.js', 'assets/extensions-C.css', 'assets/inter-E.woff2', 'assets/late-F.js', 'assets/root-D.js', 'assets/sepia-G.png', 'assets/surface-B.js', 'extensions.html'])
  })

  it('does not read a font or a picture for names, and lists a name that is no file of the bundle for nothing', () => {
    const list = internalFileList(read, has)
    expect(list.has('assets/never-read.js')).toBe(false)
    expect(list.has('assets/ghost-Z.js')).toBe(false)
    expect(list.has('assets/settings-H.js')).toBe(false)
    expect(list.has('index.html')).toBe(false)
  })

  it('lists the document alone when nothing can be read, and stops at its ceiling', () => {
    expect([...internalFileList(() => null, () => true)]).toEqual(['extensions.html'])
    const many = Array.from({ length: INTERNAL_FILES_MAX + 50 }, (_, i) => `f${i}.js`)
    const list = internalFileList((file) => (file === 'extensions.html' ? many.join(' ') : ''), () => true)
    expect(list.size).toBe(INTERNAL_FILES_MAX)
  })

  it('never lists a file the types do not serve', () => {
    const list = internalFileList((file) => (file === 'extensions.html' ? 'a.js b.json c.map d.node' : ''), () => true)
    expect([...list].sort()).toEqual(['assets/a.js', 'extensions.html'])
  })
})

describe('the answer', () => {
  it('keeps the page from being framed, read by another origin, sniffed or kept', () => {
    const page = internalResponseHeaders({ kind: 'page', file: INTERNAL_DOCUMENT })
    expect(page['content-type']).toBe('text/html; charset=utf-8')
    expect(page['content-security-policy']).toBe(INTERNAL_CSP)
    expect(INTERNAL_CSP).toContain("frame-ancestors 'none'")
    expect(page['x-frame-options']).toBe('DENY')
    expect(page['cross-origin-resource-policy']).toBe('same-origin')
    expect(page['x-content-type-options']).toBe('nosniff')
    expect(page['cache-control']).toBe('no-store')
    // What the page loads carries the address of the page (a second look for the engines that give the header), and nothing of it leaves the origin.
    expect(page['referrer-policy']).toBe('same-origin')
    expect(Object.keys(page).some((name) => name.startsWith('access-control-'))).toBe(false)
    const asset = internalResponseHeaders({ kind: 'asset', file: 'assets/a.js' })
    expect(asset['content-type']).toBe('text/javascript; charset=utf-8')
    expect(asset['cross-origin-resource-policy']).toBe('same-origin')
    expect(asset['x-content-type-options']).toBe('nosniff')
    expect(asset['content-security-policy']).toBeUndefined()
  })

  it('carries the policy of content of the document of the page, and one more directive', () => {
    const html = readFileSync(fileURLToPath(new URL('../renderer/extensions.html', import.meta.url)), 'utf8')
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]
    expect(meta).toBeDefined()
    expect(INTERNAL_CSP.startsWith(meta!)).toBe(true)
    expect(INTERNAL_CSP.slice(meta!.length)).toBe("; object-src 'none'; frame-ancestors 'none'")
    // No script of its own, no network, no frame: what the page needs is its own origin.
    expect(INTERNAL_CSP).toContain("default-src 'self'")
    expect(INTERNAL_CSP).not.toMatch(/unsafe-eval|script-src|connect-src|https?:|\*/)
  })
})

describe('internalDevPath', () => {
  const root = '/Users/jane/lucium'

  it('asks the development server for the document, its own client and the sources of the project', () => {
    expect(internalDevPath(PAGE, root)).toBe('/extensions.html')
    expect(internalDevPath('lucium-ui://extensions/shortcuts', root)).toBe('/extensions.html')
    expect(internalDevPath('lucium-ui://extensions/@vite/client', root)).toBe('/@vite/client')
    expect(internalDevPath('lucium-ui://extensions/@react-refresh', root)).toBe('/@react-refresh')
    expect(internalDevPath('lucium-ui://extensions/extensions.tsx', root)).toBe('/extensions.tsx')
    expect(internalDevPath('lucium-ui://extensions/ExtensionsPage.tsx?t=17', root)).toBe('/ExtensionsPage.tsx?t=17')
    expect(internalDevPath('lucium-ui://extensions/node_modules/.vite/deps/react.js?v=ab', root)).toBe('/node_modules/.vite/deps/react.js?v=ab')
    expect(internalDevPath(`lucium-ui://extensions/@fs${root}/src/shared/i18n.ts`, root)).toBe(`/@fs${root}/src/shared/i18n.ts`)
  })

  it('asks for the path the parser made, never the one the text spelled: a way out that comes back in is the file it comes to', () => {
    expect(internalDevPath('lucium-ui://extensions/a/../b.ts', root)).toBe('/b.ts')
    expect(internalDevPath('lucium-ui://extensions/a/%2e%2e/b.ts', root)).toBe('/b.ts')
  })

  it('does not ask it for a file outside the project’s sources, a way out of them, or another host', () => {
    const refused = [
      `lucium-ui://extensions/@fs/etc/passwd`,
      `lucium-ui://extensions/@fs${root}/.env`,
      `lucium-ui://extensions/@fs${root}/src/../.env`,
      `lucium-ui://extensions/@fs${root}/src/shared/%2e%2e/%2e%2e/.env`,
      `lucium-ui://extensions/@fs${root}-other/src/a.ts`,
      'lucium-ui://extensions//evil.example/a.ts',
      'lucium-ui://extensions/.env',
      'lucium-ui://extensions/package.json%00.ts',
      'lucium-ui://extensions/secrets.pem',
      'lucium-ui://evil/extensions.tsx',
      'lucium-ui://extensions@evil/extensions.tsx',
      'lucium-ui://extensions\\extensions.tsx',
      '',
      'https://example.org/extensions.tsx'
    ]
    for (const url of refused) expect(internalDevPath(url, root), url).toBeNull()
  })
})
