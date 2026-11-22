// Engine checks that measure six things the list of missing functions called « à confirmer », run inside a real Electron. None has been run yet:
// docs/limites-web.md says « non mesuré » for each until a person has run `LUCIUM_SMOKE_ONLY=engine-facts` and written what it found there.
//  - 19  the media keys: does a page's media session take a title and the four handlers, and are the features of the keys and of the Control
//        Center left on? That a key acts and that the Control Center shows the page is for a person (recorded as skipped).
//  - 94  WebGPU: is there a `navigator.gpu`, an adapter (hardware or software), a device?
//  - 78  the device mode: does `enableDeviceEmulation` make a page read a phone's size and density, and what does it say of touch and pointer?
//  - 69  a PDF form: type into the field of a form in the viewer of Chromium, save, and look for the value in the saved file.
//  - 39  Encrypted Client Hello: one page of a third party (crypto.cloudflare.com) says whether the server name left encrypted. Off unless
//        LUCIUM_SMOKE_ECH=1: it is the only check that leaves this Mac.
//  - 73  parallel downloads: does Chromium fetch a file in parts when the resumption of downloads (which switches that feature off) is not on?
// A check is green when the measure could be made, whatever it found; the finding is its detail, and the line LUCIUM_SMOKE_ENGINE_FACTS printed
// at the end (also kept in the report of the run as `engineFacts`). The tab, the temporary folder of downloads and the server are the only outside
// world, and all are put back. The pure part is in smoke-engine-facts-kit.ts. `LUCIUM_SMOKE_ONLY=engine-facts` runs this file alone.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, webContents as allWebContents, type WebContents } from 'electron'
import { singleStreamActive } from './engine/single-stream'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, reportFact, skippedBecause, waiterOf, type CheckFn, type CheckRecord } from './smoke-kit'
import {
  ECH_PAGE,
  FORM_VALUE,
  PHONE,
  deviceReadScript,
  deviceVerdict,
  echVerdict,
  featuresOf,
  formPdf,
  mediaScript,
  mediaVerdict,
  parallelVerdict,
  pdfFormVerdict,
  webGpuScript,
  webGpuVerdict,
  type FactVerdict
} from './smoke-engine-facts-kit'

const waitFor = waiterOf(15_000, 100)

const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'
const MIB = 1024 * 1024
const BIG = Buffer.alloc(12 * MIB, 7)
const LAST_MODIFIED = 'Wed, 01 Jan 2025 00:00:00 GMT'

/** Everything the suite found, by measure: kept in the report of the run and printed in one line. */
export type EngineFacts = Record<string, { state: string; detail: string }>

export async function smokeEngineFacts(ctx: SmokeContext, check: CheckFn, facts: EngineFacts): Promise<void> {
  const { browser, store, engine } = ctx

  // ---- the server: a page, a form PDF, a big file that honours Range (one stream per request, throttled so that parts overlap) ----
  const ranges: Array<string | undefined> = []
  let open = 0
  let mostOpen = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/form.pdf') {
      res.setHeader('content-type', 'application/pdf')
      return void res.end(formPdf())
    }
    if (url.pathname === '/big.bin') {
      const range = req.headers.range
      ranges.push(range)
      const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
      const from = match ? Number(match[1]) : 0
      const to = match?.[2] ? Math.min(Number(match[2]), BIG.length - 1) : BIG.length - 1
      res.writeHead(match ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="big.bin"',
        etag: '"engine-facts-1"',
        'last-modified': LAST_MODIFIED,
        'accept-ranges': 'bytes',
        'content-length': to - from + 1,
        ...(match ? { 'content-range': `bytes ${from}-${to}/${BIG.length}` } : {})
      })
      if (to - from + 1 <= 8) return void res.end(BIG.subarray(from, to + 1))
      let position = from
      open++
      mostOpen = Math.max(mostOpen, open)
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        clearInterval(timer)
        open--
      }
      const timer = setInterval(() => {
        if (res.destroyed) return close()
        const next = Math.min(position + 256 * 1024, to + 1)
        res.write(BIG.subarray(position, next))
        position = next
        if (position > to) {
          close()
          res.end()
        }
      }, 15)
      res.on('close', close)
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<title>engine facts</title><body>engine facts</body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- the places: a folder of downloads of its own (the person's is never written to), and the tabs this opens ----
  const folder = mkdtempSync(join(tmpdir(), 'engine-facts-'))
  const profilesBefore = store.get().settings.profiles
  browser.dispatch({ type: 'settings/update', patch: { profiles: { ...profilesBefore, default: { ...profilesBefore['default'], downloadDir: folder } } } })
  const opened: string[] = []
  const pageOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : allWebContents.fromId(number)
  }
  const openTab = async (url: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = store.get().tabs.at(-1)!
    opened.push(tab.id)
    await waitFor(() => pageOf(tab.id) !== undefined)
    await waitFor(() => browser.snapshot().runtime.tabs[tab.id]?.loading === false)
    return { id: tab.id, wc: pageOf(tab.id)! }
  }
  /** One measure: a throw is a failed check with its stack, never a silent gap. */
  const measure = async (key: string, name: string, run: () => Promise<FactVerdict>): Promise<void> => {
    try {
      const verdict = await run()
      facts[key] = { state: verdict.state, detail: verdict.detail }
      check(`${name}: ${verdict.state}`, verdict.ok, verdict.detail)
    } catch (error) {
      facts[key] = { state: 'threw', detail: String((error as Error)?.message ?? error) }
      check(`${name} could be measured`, false, String((error as Error)?.stack ?? error))
    }
  }

  try {
    const page = await openTab(`${base}/page`)

    // 19. the media keys
    await measure('mediaKeys', 'the media session of a page and the features of the media keys', async () => mediaVerdict(await page.wc.executeJavaScript(mediaScript(), true), featuresOf(app.commandLine.getSwitchValue('disable-features'))))
    check('a media key acts on the page, and the Control Center shows « Lecture en cours »', true, skippedBecause('a person presses play/pause on the keyboard with the page playing, then opens the Control Center; no test can press a hardware key'))

    // 94. WebGPU
    await measure('webgpu', 'WebGPU in a page', async () => webGpuVerdict(await page.wc.executeJavaScript(webGpuScript(), true)))

    // 78. the device mode
    await measure('deviceMode', 'the emulation of a phone', async () => {
      const read = (): Promise<{ width?: number }> => page.wc.executeJavaScript(deviceReadScript())
      const before = await read()
      page.wc.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: PHONE.width, height: PHONE.height }, viewPosition: { x: 0, y: 0 }, viewSize: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: PHONE.scaleFactor, scale: 1 })
      try {
        // The page is asked until it reads the phone's width; if it never does, the verdict says the size was not followed.
        await waitFor(async () => (await read()).width === PHONE.width, 5000)
        const during = await read()
        page.wc.disableDeviceEmulation()
        await waitFor(async () => (await read()).width === before.width, 5000)
        return deviceVerdict(before, during, await read())
      } finally {
        page.wc.disableDeviceEmulation()
      }
    })

    // 69. a PDF form
    await measure('pdfForm', `a value typed into a PDF form (« ${FORM_VALUE} »)`, async () => {
      const tab = await openTab(`${base}/form.pdf`)
      const viewer = () => tab.wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith(PDF_VIEWER))
      const loaded = await waitFor(() => viewer() !== undefined, 20_000)
      if (!loaded) return pdfFormVerdict({ viewer: false, saved: null })
      await waitFor(async () => Number(await viewer()?.executeJavaScript(`document.querySelector('embed') ? document.querySelector('embed').getBoundingClientRect().width : 0`).catch(() => 0)) > 0)
      const area = (await viewer()!.executeJavaScript(`(() => { const r = document.querySelector('embed').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)) as { x: number; y: number; w: number; h: number }
      // The field fills the sheet; the sheet is as wide as the plugin at the default zoom, and two thirds as tall: a click a third of the width down is in it.
      const x = Math.round(area.x + area.w / 2)
      const y = Math.round(area.y + Math.min(area.h / 2, area.w * 0.33))
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) tab.wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
      for (const character of FORM_VALUE) tab.wc.sendInputEvent({ type: 'char', keyCode: character })
      // The viewer answers after it has handled the keys sent before: a round trip, not a wait.
      await viewer()!.executeJavaScript('true')
      const before = browser.snapshot().downloads.length
      const press = (selector: string): Promise<unknown> =>
        viewer()!.executeJavaScript(`(() => { const root = document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot.querySelector('viewer-download-controls').shadowRoot; const el = root.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el })()`)
      await press('#save')
      let arrived = await waitFor(() => browser.snapshot().downloads.length > before && browser.snapshot().downloads[0]?.state === 'completed', 4000)
      // With edits the viewer may offer the edited and the original file in a menu: take the edited one.
      if (!arrived) {
        await press('[id*="edited" i]')
        arrived = await waitFor(() => browser.snapshot().downloads.length > before && browser.snapshot().downloads[0]?.state === 'completed', 10_000)
      }
      return pdfFormVerdict({ viewer: true, saved: arrived ? readFileSync(browser.snapshot().downloads[0]!.path) : null })
    })

    // 39. Encrypted Client Hello
    if (process.env['LUCIUM_SMOKE_ECH'] === '1') {
      await measure('ech', 'the server name of a TLS connection', async () => echVerdict(await (await openTab(ECH_PAGE)).wc.executeJavaScript('document.body ? document.body.innerText : null')))
    } else {
      facts['ech'] = { state: 'not-run', detail: 'LUCIUM_SMOKE_ECH is not 1' }
      check('the server name of a TLS connection leaves encrypted (Encrypted Client Hello)', true, skippedBecause(`set LUCIUM_SMOKE_ECH=1 to open ${ECH_PAGE}, a page of a third party: the only check of this suite that leaves this Mac`))
    }

    // 73. parallel downloads
    if (singleStreamActive()) {
      const verdict = parallelVerdict({ ranges: [], mostOpen: 0 }, true)
      facts['parallelDownloads'] = { state: verdict.state, detail: verdict.detail }
      check('Chromium fetches a file in parts', true, skippedBecause(verdict.detail))
    } else
      await measure('parallelDownloads', 'a big file fetched by Chromium', async () => {
      const before = browser.snapshot().downloads.length
      page.wc.downloadURL(`${base}/big.bin`)
      const done = await waitFor(() => browser.snapshot().downloads.length > before && ['completed', 'interrupted', 'cancelled'].includes(browser.snapshot().downloads[0]?.state ?? ''), 60_000)
      if (!done) return { ok: false, state: 'unreadable', detail: 'the download did not end in 60 s' }
      return parallelVerdict({ ranges, mostOpen }, false)
    })
  } finally {
    for (const id of opened.splice(0)) browser.dispatch({ type: 'tab/close', id })
    browser.dispatch({ type: 'settings/update', patch: { profiles: profilesBefore } })
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(folder, { recursive: true, force: true })
  }
}

/** `LUCIUM_SMOKE_ONLY=engine-facts`: these checks, and one line with everything they found. */
export async function runEngineFactsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  const facts: EngineFacts = {}
  try {
    await smokeEngineFacts(ctx, recorderOf(checks), facts)
  } catch (error) {
    noteCheck(checks, 'smokeEngineFacts ran to the end', false, String((error as Error)?.stack ?? error))
  }
  reportFact('engineFacts', facts)
  console.log(`LUCIUM_SMOKE_ENGINE_FACTS ${JSON.stringify(facts)}`)
  return checks.some((c) => !c.ok) ? 1 : 0
}
