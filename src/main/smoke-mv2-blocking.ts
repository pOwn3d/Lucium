// Engine checks of the blocking listeners of chrome.webRequest of a Manifest V2 extension (webRequestBlocking), run inside a real Electron with
// compat/mv2-blocking-probe, which the suite loads itself and takes out again (the other suites must not see it). The application asks those
// listeners in the request hooks of the session and applies what they answer (engine/extension-net.ts, shared/web-request-blocking.ts): a
// cancel, a redirect, a request header added and one removed, an answer header added and one removed. What it must not apply is checked too: a
// redirect to a local file, and an answer that comes after the time a request waits (BLOCKING_WAIT_MS). Each check is red when the engine does
// otherwise. A local server is the only outside world. `LUCIUM_SMOKE_ONLY=mv2-blocking` runs this file alone; LUCIUM_EXTENSIONS is not needed.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, webContents as allWebContents, type WebContents } from 'electron'
import { checkManifestText, filesNamedBy, legacyManifestLine } from '@shared/extension-page'
import { activeProfileId } from '@shared/profiles'
import { BLOCKING_WAIT_MS } from '@shared/web-request-blocking'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf, type CheckFn, type CheckRecord } from './smoke-kit'
import { settled } from './smoke-probe-kit'

const PROBE = 'Lucium MV2 Blocking Probe'
const PROBE_FOLDER = 'mv2-blocking-probe'
/** Every listener of the probe is about the paths under this one, and nothing else. */
const BASE = '/mv2bp/'

const waitFor = waiterOf(15_000, 150)

/** What the page got of a request: its text (null when it failed), the two headers of the answer the listener of the answers works on, and how long it took. */
interface Got {
  body: string | null
  error?: string
  answer?: string | null
  server?: string | null
  ms: number
}

/** A script for the page: asks for `address` with `headers` and answers a `Got`, never throwing and never waiting more than eight seconds. */
const fetchScript = (address: string, headers: Record<string, string> = {}): string =>
  `(() => { const started = performance.now(); return Promise.race([fetch(${JSON.stringify(address)}, { cache: 'no-store', headers: ${JSON.stringify(headers)} }).then((r) => r.text().then((body) => ({ body, answer: r.headers.get('x-mv2bp-answer'), server: r.headers.get('x-mv2bp-server'), ms: performance.now() - started })), (e) => ({ body: null, error: (e && e.name) + ': ' + (e && e.message), ms: performance.now() - started })), new Promise((done) => setTimeout(() => done({ body: null, error: 'no answer after 8 s', ms: 8000 }), 8000))]) })()`

interface Hit {
  path: string
  query: string
  added: string | null
  removed: string | null
}

export async function smokeMv2Blocking(ctx: SmokeContext, check: CheckFn): Promise<void> {
  const { store, engine, browser } = ctx
  const profile = activeProfileId(store.get())
  const folder = join(app.getAppPath(), 'compat', PROBE_FOLDER)
  let probe: { id: string; name: string } | undefined
  try {
    probe = await engine.loadExtension(profile, folder)
  } catch (error) {
    check(`the probe extension "${PROBE}" is loaded`, false, `${folder}: ${String((error as Error)?.message ?? error)}`)
    return
  }
  const startTabs = new Set(store.get().tabs.map((t) => t.id))
  const prior = { sleepAfterMinutes: store.get().settings.sleepAfterMinutes }
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  // ---- the server: every request under /mv2bp/ is recorded with the two headers the listener of the request headers works on ----
  const hits: Hit[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cache-control', 'no-store')
    const header = (name: string): string | null => {
      const value = req.headers[name]
      return typeof value === 'string' ? value : null
    }
    if (url.pathname.startsWith(BASE)) hits.push({ path: url.pathname, query: url.search, added: header('x-mv2bp-added'), removed: header('x-mv2bp-remove') })
    if (url.pathname === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      return void res.end('<title>mv2bp-page</title><body>the page of the MV2 blocking checks</body>')
    }
    res.setHeader('content-type', 'text/plain')
    if (url.pathname === `${BASE}response-headers`) res.setHeader('x-mv2bp-server', 'from the server')
    res.end(url.pathname === `${BASE}redirect-to` ? 'to' : url.pathname === `${BASE}control` ? 'control' : 'arrived')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const count = (path: string, query?: string): number => hits.filter((hit) => hit.path === `${BASE}${path}` && (query === undefined || hit.query === query)).length

  try {
    check(`the probe extension "${PROBE}" is loaded`, probe.name === PROBE, `${folder} gave "${probe.name}" (${probe.id})`)
    if (probe.name !== PROBE) return
    // The Extensions page takes a Manifest V2 folder as Settings does (its first look no longer asks for Manifest V3, and it finds the background script the manifest
    // names), and the details the engine gives it for the loaded probe carry the old format, which the page warns of on its row and under "Détails".
    const first = checkManifestText(readFileSync(join(folder, 'manifest.json'), 'utf8'))
    const named = first.ok ? filesNamedBy(first.manifest) : []
    const detail = (await engine.extensionTools.details()).find((d) => d.profileId === profile && d.id === probe.id)
    check(
      'mv2 blocking: the Extensions page takes the probe folder (the first look of a folder accepts its Manifest V2, which names background.js) and warns of its old format',
      first.ok && named.includes('background.js') && detail?.facts?.manifestVersion === 2 && legacyManifestLine(detail.facts) !== null,
      first.ok ? `files named ${JSON.stringify(named)}; manifestVersion ${detail?.facts?.manifestVersion ?? 'no details'}` : first.message
    )
    const wcOf = (tabId: string): WebContents | undefined => {
      const number = engine.tabNumberOf(tabId)
      return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
    }
    browser.dispatch({ type: 'tab/open', url: `${base}/page` })
    const tab = store.get().tabs.at(-1)!
    const loaded = await waitFor(() => wcOf(tab.id) !== undefined && store.get().tabs.find((t) => t.id === tab.id)?.title === 'mv2bp-page')
    const page = wcOf(tab.id)
    check('mv2 blocking: the page that drives the checks loads', loaded && page !== undefined, `title "${store.get().tabs.find((t) => t.id === tab.id)?.title}"`)
    if (!page) return
    const request = (address: string, headers?: Record<string, string>): Promise<Got> =>
      settled(page.executeJavaScript(fetchScript(address, headers)) as Promise<Got>, (why) => ({ body: null, error: `the script of the page: ${why}`, ms: -1 }), 12_000)
    const said = (got: Got, path: string, query?: string): string => `the page got ${JSON.stringify(got)}, the server saw ${count(path, query)} request(s)`

    // The background page registers its listeners as it starts: the checks begin once its cancel is applied (each try that goes through is a request of its own).
    let attempt = 0
    const ready = await waitFor(async () => (await request(`${base}${BASE}cancel?ready-${++attempt}`)).body === null && count('cancel', `?ready-${attempt}`) === 0, 20_000)
    check('mv2 blocking: the background page of the probe is listening (its cancel is applied within 20 s of its load)', ready, `${attempt} attempt(s), the server saw ${count('cancel')} of them`)

    const control = await request(`${base}${BASE}control`)
    const controlArrived = control.body === 'control' && count('control') === 1
    check('mv2 blocking: the control request, which the listeners let go, reaches the server and the page reads its answer', controlArrived, said(control, 'control'))

    const cancelled = await request(`${base}${BASE}cancel?final`)
    check('mv2 blocking: a request the listener of onBeforeRequest cancels never reaches the server, and the page gets an error', controlArrived && cancelled.body === null && count('cancel', '?final') === 0, said(cancelled, 'cancel', '?final'))

    const redirected = await request(`${base}${BASE}redirect-from`)
    check(
      'mv2 blocking: a request the listener of onBeforeRequest redirects is sent where it says, and the page reads the answer of the new address',
      redirected.body === 'to' && count('redirect-from') === 0 && count('redirect-to') === 1,
      `${said(redirected, 'redirect-to')}; redirect-from reached the server ${count('redirect-from')} time(s)`
    )

    const toFile = await request(`${base}${BASE}redirect-file`)
    check('mv2 blocking: a redirect of a listener to a local file is refused, and the request goes on to its own address', toFile.body === 'arrived' && count('redirect-file') === 1, said(toFile, 'redirect-file'))

    const sentHeaders = await request(`${base}${BASE}request-headers`, { 'X-Mv2bp-Remove': 'from the page' })
    const headerHit = hits.find((hit) => hit.path === `${BASE}request-headers`)
    check(
      'mv2 blocking: the headers of a request carry what the listener of onBeforeSendHeaders added, and not what it removed',
      sentHeaders.body === 'arrived' && headerHit?.added === 'from the listener' && headerHit.removed === null,
      `${said(sentHeaders, 'request-headers')}; the server received ${JSON.stringify(headerHit ?? null)}`
    )

    const answered = await request(`${base}${BASE}response-headers`)
    check(
      'mv2 blocking: the page reads the answer header the listener of onHeadersReceived added, and not the one it removed',
      answered.body === 'arrived' && answered.answer === 'from the listener' && answered.server === null,
      said(answered, 'response-headers')
    )

    const late = await request(`${base}${BASE}late`)
    check(
      `mv2 blocking: a listener that answers after ${BLOCKING_WAIT_MS} ms does not hold the request: it goes on after that time, and its late cancel is not applied`,
      late.body === 'arrived' && count('late') === 1 && late.ms >= BLOCKING_WAIT_MS * 0.8 && late.ms < BLOCKING_WAIT_MS + 2000,
      said(late, 'late')
    )
  } catch (error) {
    check('mv2 blocking: the checks ran to the end', false, String((error as Error)?.stack ?? error))
  } finally {
    for (const tab of store.get().tabs) if (!startTabs.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.dispatch({ type: 'settings/update', patch: prior })
    server.close()
    server.closeAllConnections()
    // Nothing of the probe stays in the profile of the run, nor in the profiles made after this suite.
    ;(engine as unknown as { forgetExtensionFolder(path: string): void }).forgetExtensionFolder(folder)
  }
}

/** `LUCIUM_SMOKE_ONLY=mv2-blocking`: only these checks, with their own report (the detail of every check, passed or not, says what was seen). */
export async function runMv2BlockingSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  try {
    await smokeMv2Blocking(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeMv2Blocking ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_MV2_BLOCKING ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
