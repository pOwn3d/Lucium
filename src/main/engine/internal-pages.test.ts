// The Extensions page as a session serves it: the files of the page for the page loading itself, a refusal for anything else, the preload for its address
// alone, and every request refused in a session that is private or a container's.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { CAPTURE_HELPER_DOCUMENT, CAPTURE_HELPER_URL } from '@shared/capture-helper-page'
import { INTERNAL_LOAD_HEADER } from '@shared/internal-serve'
import { posix } from '../windows.test-support'
import { INTERNAL_PRELOAD_ID, InternalPageServer, captureHelperLoadHeader, headersGiven, installInternalPages, internalLoadHeaders, internalPreloadPath, newInternalSecrets, setInternalPagesHome, watchInternalRequests, type InternalPagesHome, type InternalPagesIo, type InternalPagesSession, type InternalRequestRecord } from './internal-pages'

const PAGE = 'lucium-ui://extensions/'
// The secrets of the server under test; a session of the application makes its own at random.
const SECRETS = { key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', load: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' } // gitleaks:allow (invented for this test, the key of no session)
const KEY = SECRETS.key
const ASSET = `lucium-ui://extensions/${KEY}/assets/extensions-A.js`
const serverOf = (h: InternalPagesHome, i: InternalPagesIo): InternalPageServer => new InternalPageServer(h, i, SECRETS)
const home: InternalPagesHome = { rendererDir: '/app/out/renderer', projectRoot: '/Users/jane/lucium' }

const bundle: Record<string, string> = {
  'extensions.html': '<script type="module" src="./assets/extensions-A.js"></script><link rel="stylesheet" href="./assets/extensions-C.css">',
  'assets/extensions-A.js': 'import "./root-D.js"; export const page = 1',
  'assets/root-D.js': 'export const root = 1',
  'assets/extensions-C.css': '.x{color:red}',
  // Other pages of the interface, which the page does not load.
  'assets/overlay-I.js': 'export const overlay = 1',
  'index.html': '<html>the sidebar</html>',
  'settings.html': '<html>settings</html>'
}

function io(overrides: Partial<InternalPagesIo> = {}): InternalPagesIo {
  return {
    readText: (file) => bundle[file] ?? null,
    has: (file) => file in bundle,
    readBytes: (file) => {
      if (!(file in bundle)) throw new Error(`no ${file}`)
      return new TextEncoder().encode(bundle[file])
    },
    fetchDev: () => Promise.reject(new Error('no development server')),
    ...overrides
  }
}

const loaded = { [INTERNAL_LOAD_HEADER]: SECRETS.load }
const navigation = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', ...loaded }
const script = { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', origin: 'lucium-ui://extensions', referer: 'lucium-ui://extensions/' }
const ask = (url: string, headers: Record<string, string> = {}, method = 'GET'): Request => new Request(url, { method, headers })

let warn: MockInstance<(...args: unknown[]) => void>
let error: MockInstance<(...args: unknown[]) => void>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as unknown as MockInstance<(...args: unknown[]) => void>
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined) as unknown as MockInstance<(...args: unknown[]) => void>
})
afterEach(() => vi.restoreAllMocks())

describe('what a session serves for the page', () => {
  it('serves the document and what the document loads, with the headers of the page', async () => {
    const server = serverOf(home, io())
    const page = await server.respond(ask(PAGE, navigation))
    expect(page.status).toBe(200)
    // The document names the files of the page under the key of the session: it is the only thing that does.
    const text = await page.text()
    expect(text).toContain(`./${KEY}/assets/extensions-A.js`)
    expect(text).toContain(`./${KEY}/assets/extensions-C.css`)
    expect(text).not.toMatch(/"\.\/assets\//)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const shortcuts = await server.respond(ask('lucium-ui://extensions/shortcuts', navigation))
    expect(await shortcuts.text()).toContain(`./${KEY}/assets/extensions-A.js`)
    const asset = await server.respond(ask(ASSET, script))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    // What the script imports is served too, and the style.
    expect((await server.respond(ask(`lucium-ui://extensions/${KEY}/assets/root-D.js`, script))).status).toBe(200)
    expect((await server.respond(ask(`lucium-ui://extensions/${KEY}/assets/extensions-C.css`, { ...script, 'sec-fetch-dest': 'style' }))).status).toBe(200)
  })

  it('serves nothing of the other pages of the interface, though they are in the same folder', async () => {
    const server = serverOf(home, io())
    expect((await server.respond(ask(`lucium-ui://extensions/${KEY}/assets/overlay-I.js`, script))).status).toBe(404)
    for (const url of ['lucium-ui://extensions/index.html', 'lucium-ui://extensions/settings.html', 'lucium-ui://extensions/extensions.html', `lucium-ui://extensions/${KEY}/assets/missing-Z.js`]) {
      expect((await server.respond(ask(url, navigation))).status, url).toBeGreaterThanOrEqual(400)
    }
  })

  it('knows no file of the development server when it is built: a source of the project is refused, not looked for', async () => {
    const server = serverOf(home, io())
    expect((await server.respond(ask('lucium-ui://extensions/extensions.tsx', script))).status).toBe(403)
    expect((await server.respond(ask('lucium-ui://extensions/@vite/client', script))).status).toBe(403)
  })

  it('refuses a frame, a fetch, an object, and a page of another origin, and says so in the log without its query', async () => {
    const server = serverOf(home, io())
    const bad: Array<Record<string, string>> = [{ ...navigation, 'sec-fetch-dest': 'iframe' }, { ...script, 'sec-fetch-dest': 'empty' }, { ...script, 'sec-fetch-dest': 'object' }, { ...script, origin: 'https://evil.example' }, { referer: 'https://evil.example/' }]
    for (const headers of bad) {
      const answer = await server.respond(ask(`${ASSET}?secret=1`, headers))
      expect(answer.status, JSON.stringify(headers)).toBe(403)
      expect(await answer.text()).toBe('')
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[internal-page] refused a request for lucium-ui://extensions/<key>/assets/extensions-A.js:'))
    // The key is a secret of the session: the log never has it.
    expect(warn.mock.calls.flat().join(' ')).not.toContain(KEY)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret=1')
    expect((await server.respond(ask(PAGE, navigation, 'POST'))).status).toBe(403)
  })

  it('answers a HEAD without a body, and a file it cannot read with a refusal and the cause in the log', async () => {
    const server = serverOf(home, io())
    const head = await server.respond(ask(PAGE, navigation, 'HEAD'))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const broken = serverOf(home, io({ readBytes: () => { throw new Error('disk gone') } }))
    expect((await broken.respond(ask(PAGE, navigation))).status).toBe(500)
    expect(error).toHaveBeenCalledWith('[internal-page] cannot serve extensions.html:', expect.objectContaining({ message: 'disk gone' }))
  })

  it('lists the files of the page once, and serves none when it cannot read the document', async () => {
    const readText = vi.fn((file: string) => bundle[file] ?? null)
    const server = serverOf(home, io({ readText }))
    await server.respond(ask(PAGE, navigation))
    const reads = readText.mock.calls.length
    await server.respond(ask(ASSET, script))
    await server.respond(ask(PAGE, navigation))
    expect(readText.mock.calls.length).toBe(reads)
    const blind = serverOf(home, io({ readText: () => null, has: () => false }))
    expect((await blind.respond(ask(ASSET, script))).status).toBe(404)
  })
})

describe('the development server', () => {
  const dev: InternalPagesHome = { ...home, devUrl: 'http://localhost:5173' }

  it('is asked for the document and the sources of the page, and answers with the headers of the page', async () => {
    const fetchDev = vi.fn((address: string) => Promise.resolve(new Response(address.endsWith('.html') ? '<html>dev</html>' : 'export {}', { headers: { 'content-type': address.endsWith('.html') ? 'text/html' : 'text/javascript' } })))
    const server = serverOf(dev, io({ fetchDev }))
    const page = await server.respond(ask(PAGE, navigation))
    expect(await page.text()).toBe('<html>dev</html>')
    expect(fetchDev).toHaveBeenCalledWith('http://localhost:5173/extensions.html')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    const source = await server.respond(ask('lucium-ui://extensions/extensions.tsx', { ...script, 'sec-fetch-dest': 'script' }))
    expect(fetchDev).toHaveBeenLastCalledWith('http://localhost:5173/extensions.tsx')
    expect(source.headers.get('content-type')).toBe('text/javascript')
    // The document keeps its own type, whatever the server says of it.
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('is not asked for a file the page has no business with, nor for a request that is refused', async () => {
    const fetchDev = vi.fn(() => Promise.resolve(new Response('x')))
    const server = serverOf(dev, io({ fetchDev }))
    expect((await server.respond(ask('lucium-ui://extensions/@fs/etc/passwd', script))).status).toBe(403)
    expect((await server.respond(ask('lucium-ui://extensions/.env', script))).status).toBe(403)
    expect((await server.respond(ask(PAGE, { ...navigation, 'sec-fetch-dest': 'iframe' }))).status).toBe(403)
    expect(fetchDev).not.toHaveBeenCalled()
  })

  it('says 404 for a file the server does not have, and 502 when it answers wrongly or not at all', async () => {
    const answer = (status: number) => serverOf(dev, io({ fetchDev: () => Promise.resolve(new Response('x', { status })) }))
    expect((await answer(404).respond(ask('lucium-ui://extensions/extensions.tsx', script))).status).toBe(404)
    expect((await answer(500).respond(ask(PAGE, navigation))).status).toBe(502)
    const down = serverOf(dev, io({ fetchDev: () => Promise.reject(new Error('ECONNREFUSED')) }))
    expect((await down.respond(ask(PAGE, navigation))).status).toBe(500)
    expect(error).toHaveBeenCalledWith('[internal-page] cannot serve extensions.html:', expect.objectContaining({ message: 'ECONNREFUSED' }))
  })
})

/** The header the shell adds to its own load of the page in a session that serves it. */
function loadOf(ses: object): Record<string, string> {
  const line = internalLoadHeaders(ses)
  if (line === null) throw new Error('this session does not serve the page')
  const [name, value] = line.split(': ')
  return { [name!]: value! }
}

/** A session that records what it was given. */
function fakeSession(failMatches = false) {
  const handlers = new Map<string, (request: Request) => Response | Promise<Response>>()
  const scripts: Array<{ id: string; type: string; filePath: string; matches?: string[] }> = []
  const ses: InternalPagesSession = {
    protocol: { handle: (scheme: string, handler: (request: Request) => Response | Promise<Response>) => void handlers.set(scheme, handler) },
    registerPreloadScript: (script) => {
      if (failMatches && script.matches) throw new Error('matches is not supported here')
      scripts.push(script)
      return script.id
    }
  }
  return { ses, handlers, scripts }
}

describe('a session of the application', () => {
  beforeEach(() => setInternalPagesHome(home, () => io()))

  it('serves the page and carries the preload for its address alone, in a session of a profile', async () => {
    const { ses, handlers, scripts } = fakeSession()
    installInternalPages(ses, 'serve')
    expect([...handlers.keys()]).toEqual(['lucium-ui'])
    expect((await handlers.get('lucium-ui')!(ask(PAGE, { ...navigation, ...loadOf(ses) }))).status).toBe(200)
    expect(scripts).toEqual([{ id: INTERNAL_PRELOAD_ID, type: 'frame', filePath: internalPreloadPath(), matches: ['lucium-ui://extensions/*'] }])
    expect(scripts[0]?.filePath).toMatch(/preload[\\/]internal-extensions\.js$/)
  })

  it('does not serve the page nor carry the preload in a private context or a container: every request is refused', async () => {
    const { ses, handlers, scripts } = fakeSession()
    installInternalPages(ses, 'refuse')
    for (const [url, headers] of [[PAGE, navigation], [ASSET, script], ['lucium-ui://extensions/shortcuts', navigation]] as const) {
      const answer = await handlers.get('lucium-ui')!(ask(url, headers))
      expect(answer.status, url).toBe(403)
      expect(await answer.text()).toBe('')
    }
    expect(scripts).toEqual([])
  })

  it('does not register the preload for every page when it cannot limit it to the address of the page: it registers none, and says so', () => {
    const { ses, scripts } = fakeSession(true)
    installInternalPages(ses, 'serve')
    expect(scripts).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not registered at all'), expect.objectContaining({ message: 'matches is not supported here' }))
  })

  it('is done once for a session', () => {
    const { ses, scripts } = fakeSession()
    const handle = vi.spyOn(ses.protocol, 'handle')
    installInternalPages(ses, 'serve')
    installInternalPages(ses, 'serve')
    installInternalPages(ses, 'refuse')
    expect(handle).toHaveBeenCalledTimes(1)
    expect(scripts).toHaveLength(1)
  })

  it('refuses every request, and says it, when the application did not say where the page is', async () => {
    vi.resetModules()
    const fresh = await import('./internal-pages')
    const { ses, handlers, scripts } = fakeSession()
    fresh.installInternalPages(ses, 'serve')
    expect(error).not.toHaveBeenCalled()
    expect((await handlers.get('lucium-ui')!(ask(PAGE, navigation))).status).toBe(403)
    expect(scripts).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('did not say where the Extensions page is'))
  })

  it('reads the preload from where Chromium can read it in a packaged application', () => {
    expect(posix(internalPreloadPath('/Applications/Lucium.app/Contents/Resources/app.asar/out/main'))).toBe('/Applications/Lucium.app/Contents/Resources/app.asar.unpacked/out/preload/internal-extensions.js')
    expect(posix(internalPreloadPath('/Users/jane/lucium/out/main'))).toBe('/Users/jane/lucium/out/preload/internal-extensions.js')
  })
})

describe('who is served', () => {
  it('serves the document to the load of the shell only, and a file only under the key: what a web page can ask for answers nothing', async () => {
    const server = serverOf(home, io())
    const sec = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }
    // `<iframe src>`, `<script src>`, `<img src>`, `<link href>` of a web page, under any referrer policy, with or without the Sec-Fetch headers: it has no secret.
    const asked: Array<Record<string, string>> = [{}, sec, { referer: '' }, { 'sec-fetch-dest': 'script' }, { [INTERNAL_LOAD_HEADER]: 'not-the-secret-not-the-secret' }]
    for (const headers of asked) {
      expect((await server.respond(ask(PAGE, headers))).status, JSON.stringify(headers)).toBe(403)
    }
    // It does not know the key either: the address of a file of the build names nothing, and neither does a guess.
    for (const url of ['lucium-ui://extensions/assets/extensions-A.js', 'lucium-ui://extensions/assets/extensions-C.css', `lucium-ui://extensions/${'0'.repeat(32)}/assets/extensions-A.js`, `lucium-ui://extensions/${KEY.slice(1)}/assets/extensions-A.js`]) {
      for (const headers of [{}, { 'sec-fetch-dest': 'script' }, { referer: '' }] as Array<Record<string, string>>) expect((await server.respond(ask(url, headers))).status, url).toBe(403)
    }
    expect((await server.respond(ask(PAGE, loaded))).status).toBe(200)
    expect((await server.respond(ask(ASSET, {}))).status).toBe(200)
  })

  it('makes secrets of its own for each session, long and not guessed from one another', () => {
    const first = newInternalSecrets()
    const second = newInternalSecrets()
    for (const value of [first.key, first.load, second.key, second.load]) expect(value).toMatch(/^[0-9a-f]{32}$/)
    expect(new Set([first.key, first.load, second.key, second.load]).size).toBe(4)
  })

  it('does not serve a document that names no file of the bundle, and says so', async () => {
    const bare: Record<string, string> = { ...bundle, 'extensions.html': '<html>no script</html>' }
    const server = serverOf(home, io({ readText: (file) => bare[file] ?? null, readBytes: (file) => new TextEncoder().encode(bare[file]) }))
    expect((await server.respond(ask(PAGE, navigation))).status).toBe(500)
    expect(error).toHaveBeenCalledWith('[internal-page] cannot serve extensions.html:', expect.objectContaining({ message: 'the document names no file of the bundle' }))
  })

  it('logs the first refusals and not the next ones: a page that asks over and over does not fill the log', async () => {
    const server = serverOf(home, io())
    for (let i = 0; i < 60; i++) await server.respond(ask(`lucium-ui://extensions/assets/f${i}.js`, {}))
    expect(warn).toHaveBeenCalledTimes(20)
    expect(warn.mock.calls.at(-1)?.[0]).toContain('(the next ones are not logged)')
  })
})

describe('what the handler tells of the requests it is given', () => {
  const seen: InternalRequestRecord[] = []
  beforeEach(() => {
    seen.length = 0
    watchInternalRequests((record) => seen.push(record))
  })
  afterEach(() => watchInternalRequests(null))

  it('gives the listener the headers that came, the secrets that did and what was answered, without the query nor the key', async () => {
    const server = serverOf(home, io())
    await server.respond(ask(PAGE, navigation))
    await server.respond(ask(`${ASSET}?v=1`, { ...script, 'sec-fetch-user': '?1' }))
    await server.respond(ask('lucium-ui://extensions/assets/extensions-A.js?token=secret', { referer: 'https://evil.example/page' }))
    expect(seen.map((record) => [record.url, record.status])).toEqual([[PAGE, 200], ['lucium-ui://extensions/<key>/assets/extensions-A.js', 200], ['lucium-ui://extensions/assets/extensions-A.js', 403]])
    expect(seen[0]).toMatchObject({ method: 'GET', why: null, loadSecret: true, fetchHeaders: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', origin: null, referer: null } })
    expect(seen[0]!.headerNames).toContain(INTERNAL_LOAD_HEADER)
    expect(seen[1]).toMatchObject({ loadSecret: false, fetchHeaders: { 'sec-fetch-dest': 'script', 'sec-fetch-user': '?1', origin: 'lucium-ui://extensions', referer: 'lucium-ui://extensions/' } })
    expect(seen[2]).toMatchObject({ status: 403, loadSecret: false, fetchHeaders: { referer: 'https://evil.example/page', 'sec-fetch-dest': null } })
    expect(typeof seen[2]!.why).toBe('string')
    expect(JSON.stringify(seen)).not.toContain(KEY)
    expect(JSON.stringify(seen)).not.toContain('token=secret')
    expect(typeof seen[0]!.referrer).toBe('string')
  })

  it('says nothing when nobody listens', async () => {
    watchInternalRequests(null)
    const server = serverOf(home, io())
    expect((await server.respond(ask(PAGE, navigation))).status).toBe(200)
    expect(seen).toEqual([])
  })
})

describe('the secret of the shell, session by session', () => {
  beforeEach(() => setInternalPagesHome(home, () => io()))

  it('is given for a session that serves the page, to nobody else: not a private one, not a container, not a session that is not one of ours', () => {
    const serving = fakeSession()
    installInternalPages(serving.ses, 'serve')
    const refusing = fakeSession()
    installInternalPages(refusing.ses, 'refuse')
    expect(internalLoadHeaders(serving.ses)).toMatch(new RegExp(`^${INTERNAL_LOAD_HEADER}: [0-9a-f]{32}$`))
    expect(internalLoadHeaders(refusing.ses)).toBeNull()
    expect(internalLoadHeaders({})).toBeNull()
  })

  it('opens the document of its own session only: the header of one session is not the secret of another', async () => {
    const one = fakeSession()
    const two = fakeSession()
    installInternalPages(one.ses, 'serve')
    installInternalPages(two.ses, 'serve')
    expect(internalLoadHeaders(one.ses)).not.toBe(internalLoadHeaders(two.ses))
    expect((await one.handlers.get('lucium-ui')!(ask(PAGE, loadOf(one.ses)))).status).toBe(200)
    expect((await one.handlers.get('lucium-ui')!(ask(PAGE, loadOf(two.ses)))).status).toBe(403)
    expect((await one.handlers.get('lucium-ui')!(ask(PAGE))).status).toBe(403)
  })

  it('serves a file of the build to the document of the session under its own key, which the document it served names', async () => {
    const { ses, handlers } = fakeSession()
    installInternalPages(ses, 'serve')
    const document = await (await handlers.get('lucium-ui')!(ask(PAGE, loadOf(ses)))).text()
    const named = /src="\.\/([0-9a-f]{32}\/assets\/extensions-A\.js)"/.exec(document)?.[1]
    expect(named).toBeDefined()
    expect((await handlers.get('lucium-ui')!(ask(`lucium-ui://extensions/${named}`, {}))).status).toBe(200)
    expect((await handlers.get('lucium-ui')!(ask('lucium-ui://extensions/assets/extensions-A.js', {}))).status).toBe(403)
    // The key of another session names nothing here.
    const other = fakeSession()
    installInternalPages(other.ses, 'serve')
    const otherNamed = /src="\.\/([0-9a-f]{32}\/assets\/extensions-A\.js)"/.exec(await (await other.handlers.get('lucium-ui')!(ask(PAGE, loadOf(other.ses)))).text())?.[1]
    expect(otherNamed).not.toBe(named)
    expect((await handlers.get('lucium-ui')!(ask(`lucium-ui://extensions/${otherNamed}`, {}))).status).toBe(403)
  })
})

describe('which headers the engine handed the handler (the finding of the engine check)', () => {
  const none: InternalRequestRecord['fetchHeaders'] = { 'sec-fetch-dest': null, 'sec-fetch-mode': null, 'sec-fetch-site': null, 'sec-fetch-user': null, origin: null, referer: null }
  const record = (fetchHeaders: Partial<InternalRequestRecord['fetchHeaders']> = {}, referrer = ''): Pick<InternalRequestRecord, 'fetchHeaders' | 'referrer'> => ({ fetchHeaders: { ...none, ...fetchHeaders }, referrer })

  it('says none when nothing came: what Electron 45.2.1 gives (verified on 13 November 2026), with the empty referrer and the fetch API’s default', () => {
    expect(headersGiven([])).toEqual([])
    expect(headersGiven([record(), record({}, ''), record({}, 'about:client')])).toEqual([])
  })

  it('names each header that came at least once, once, and the referrer when the Request itself names one', () => {
    expect(headersGiven([record({ 'sec-fetch-dest': 'script' }), record({ 'sec-fetch-dest': 'image', 'sec-fetch-site': 'same-origin' }), record()])).toEqual(['sec-fetch-dest', 'sec-fetch-site'])
    expect(headersGiven([record({ origin: 'lucium-ui://extensions' }), record({ referer: 'lucium-ui://extensions/' })])).toEqual(['origin', 'referer'])
    expect(headersGiven([record({}, 'lucium-ui://extensions/')])).toEqual(['referrer'])
    // A header given with an empty value was still given.
    expect(headersGiven([record({ referer: '' })])).toEqual(['referer'])
  })
})

describe('the helper page of a capture of the sound of a tab, as a session serves it', () => {
  beforeEach(() => setInternalPagesHome(home, () => io()))

  /** The headers of the engine's own load of the helper page, as the window it makes sends them. */
  const helperLoad = (ses: object): Record<string, string> => {
    const line = captureHelperLoadHeader(ses)!
    return { ...Object.fromEntries([line.split(': ')]), 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }
  }

  it('serves an empty document to the load that carries the secret of its session, with the headers of a page nothing can frame', async () => {
    const { ses, handlers } = fakeSession()
    installInternalPages(ses, 'serve')
    const answer = await handlers.get('lucium-ui')!(ask(CAPTURE_HELPER_URL, helperLoad(ses)))
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe(CAPTURE_HELPER_DOCUMENT)
    expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(answer.headers.get('x-frame-options')).toBe('DENY')
    expect(answer.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(answer.headers.get('cache-control')).toBe('no-store')
  })

  it('answers a HEAD without a body', async () => {
    const { ses, handlers } = fakeSession()
    installInternalPages(ses, 'serve')
    const answer = await handlers.get('lucium-ui')!(ask(CAPTURE_HELPER_URL, helperLoad(ses), 'HEAD'))
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('')
  })

  it('serves nothing to a page of the web, a frame, a script, an image, a fetch or an extension: no secret, no document, and nothing that says Lucium is there', async () => {
    const { ses, handlers } = fakeSession()
    installInternalPages(ses, 'serve')
    const handle = handlers.get('lucium-ui')!
    const cases: Array<Record<string, string>> = [{}, { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', origin: 'lucium-ui://capture-helper' }, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site', referer: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page.html' }]
    for (const headers of cases) {
      const answer = await handle(ask(CAPTURE_HELPER_URL, headers))
      expect(answer.status, JSON.stringify(headers)).toBe(403)
      expect(await answer.text()).toBe('')
    }
  })

  it('does not take the secret of the Extensions page, nor another session\'s, for its own: each has a secret of its own', async () => {
    const one = fakeSession()
    const two = fakeSession()
    installInternalPages(one.ses, 'serve')
    installInternalPages(two.ses, 'serve')
    const handle = one.handlers.get('lucium-ui')!
    expect(captureHelperLoadHeader(one.ses)).not.toBe(captureHelperLoadHeader(two.ses))
    expect((await handle(ask(CAPTURE_HELPER_URL, helperLoad(two.ses)))).status).toBe(403)
    expect((await handle(ask(CAPTURE_HELPER_URL, loadOf(one.ses)))).status).toBe(403)
    // And the secret of the helper page opens no document of the Extensions page.
    expect((await handle(ask(PAGE, helperLoad(one.ses)))).status).toBe(403)
    expect((await handle(ask(PAGE, { ...navigation, ...loadOf(one.ses) }))).status).toBe(200)
  })

  it('serves only its own address: a path, a query or another host on the scheme is refused, with the secret too', async () => {
    const { ses, handlers } = fakeSession()
    installInternalPages(ses, 'serve')
    for (const url of [`${CAPTURE_HELPER_URL}x`, `${CAPTURE_HELPER_URL}?a=1`, 'lucium-ui://capture-helper', 'lucium-ui://capture-helper:80/', 'lucium-ui://capture-helpers/']) {
      expect((await handlers.get('lucium-ui')!(ask(url, helperLoad(ses)))).status, url).toBe(403)
    }
  })

  it('is served in a session that serves the page, to nobody else: not a private one, not a container, not a session that is not one of ours', async () => {
    const serving = fakeSession()
    installInternalPages(serving.ses, 'serve')
    const refusing = fakeSession()
    installInternalPages(refusing.ses, 'refuse')
    expect(captureHelperLoadHeader(serving.ses)).toMatch(new RegExp(`^${INTERNAL_LOAD_HEADER}: [0-9a-f]{32}$`))
    expect(captureHelperLoadHeader(refusing.ses)).toBeNull()
    expect(captureHelperLoadHeader({})).toBeNull()
    const answer = await refusing.handlers.get('lucium-ui')!(ask(CAPTURE_HELPER_URL, { ...navigation }))
    expect(answer.status).toBe(403)
    // Not even to a load that carries the secret of another session.
    expect((await refusing.handlers.get('lucium-ui')!(ask(CAPTURE_HELPER_URL, helperLoad(serving.ses)))).status).toBe(403)
  })

  it('is served whether or not the application said where its pages are: it reads no file', async () => {
    vi.resetModules()
    const fresh = await import('./internal-pages')
    const { ses, handlers } = fakeSession()
    fresh.installInternalPages(ses, 'serve')
    const line = fresh.captureHelperLoadHeader(ses)!
    const headers = { ...Object.fromEntries([line.split(': ')]), 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }
    expect((await handlers.get('lucium-ui')!(ask(CAPTURE_HELPER_URL, headers))).status).toBe(200)
    // Its refusals are the same, and the Extensions page is still refused (the application did not say where it is).
    expect((await handlers.get('lucium-ui')!(ask(CAPTURE_HELPER_URL))).status).toBe(403)
    expect((await handlers.get('lucium-ui')!(ask(PAGE, navigation))).status).toBe(403)
  })

  it('has no preload: the one of the Extensions page is registered for its own address, which this is not', () => {
    const { ses, scripts } = fakeSession()
    installInternalPages(ses, 'serve')
    expect(scripts.every((script) => (script.matches ?? []).every((pattern) => !CAPTURE_HELPER_URL.startsWith(pattern.replace('*', ''))))).toBe(true)
  })

  it('logs the first refusals with their reason, and not the next ones: a page that asks over and over does not fill the log', async () => {
    const { ses, handlers } = fakeSession()
    installInternalPages(ses, 'serve')
    for (let i = 0; i < 60; i++) await handlers.get('lucium-ui')!(ask(CAPTURE_HELPER_URL))
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[capture-helper]'))
    expect(lines.length).toBeLessThanOrEqual(20)
    expect(lines[0]).toContain('served to the load of the engine only')
  })
})
