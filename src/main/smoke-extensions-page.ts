// Engine check for the Extensions page in a tab (docs/design/extensions-en-onglet.md), run inside a real Electron. It opens the page by the way every caller does
// (a panel request), reads the address the tab shows, the preload it was given, the snapshot it asks for, and that no window was made; then it sends a page of the web at
// it by a link, a script, a frame, a window and a server's redirect, and reads what that page can see of `window.lucium`. What no test without Electron can show is here:
// that the scheme loads with its modules and its fonts, that `matches` limits the preload, that `did-navigate-in-page` follows `history.pushState`, and what the engine
// hands a `protocol.handle` of the headers of the request.
// The page is served under a key (its files) and to the shell's own load (its document), not on headers that Chromium may not hand a protocol handler
// (`Sec-Fetch-*`, `Referer`): the checks below read what the handler really RECEIVED (`watchInternalRequests`) and then try, from a page of the web with the default
// referrer policy and with `no-referrer`, to load the document and the files by `<script>`, `<img>`, `<link>` and `<iframe>`: none may be served, and none may say `load`.
// `LUCIUM_SMOKE_ONLY=extensions-page`: only this check, with its own report. Not part of the chain: it was written for the change that made the page a tab, and has not
// been run yet (the run opens windows and is the maintainer's to start).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow, type WebContents } from 'electron'
import { displayAddress, isInternalPageUrl } from '@shared/internal-page'
import { headersGiven, watchInternalRequests, type InternalRequestRecord } from './engine/internal-pages'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(10_000, 80)
const PAGE = 'lucium-ui://extensions/'
const KEYED_FILE = /^lucium-ui:\/\/extensions\/([0-9a-f]{32})\/assets\/([A-Za-z0-9._-]+)$/

/**
 * Loads each address in a page of the web, by a script, an image, a style sheet and a frame, under one referrer policy ('' is the page's own), and tells what each
 * element reported: `load`, `error`, or `timeout`. A frame reports `load` even when what it was given is a refusal, so only the other three are read as proof.
 */
function probeScript(targets: string[], referrerPolicy: string): string {
  return `new Promise((resolve) => {
    const targets = ${JSON.stringify(targets)};
    const policy = ${JSON.stringify(referrerPolicy)};
    const fired = [];
    let pending = 0;
    const watch = (element, kind, url) => {
      pending++;
      let done = false;
      const end = (event) => { if (done) return; done = true; fired.push({ kind, url, event }); if (--pending === 0) resolve(fired); };
      element.addEventListener('load', () => end('load'));
      element.addEventListener('error', () => end('error'));
      setTimeout(() => end('timeout'), 2500);
    };
    for (const url of targets) {
      const script = document.createElement('script'); script.referrerPolicy = policy; watch(script, 'script', url); script.src = url; document.head.append(script);
      const image = new Image(); image.referrerPolicy = policy; watch(image, 'img', url); image.src = url;
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.referrerPolicy = policy; watch(link, 'link', url); link.href = url; document.head.append(link);
      const frame = document.createElement('iframe'); frame.referrerPolicy = policy; watch(frame, 'iframe', url); frame.src = url; document.body.append(frame);
    }
  })`
}

type Fired = Array<{ kind: string; url: string; event: string }>

const CALLS = ['extensionUpdates', 'extensionsPage', 'getSnapshot', 'onSnapshot', 'openLocalFiles', 'openOverlay', 'openWebStore', 'pathOfDroppedFile']

export async function smokeExtensionsPage({ browser, store }: SmokeContext, check: Check): Promise<void> {
  // A page of the web, on a server of its own, that tries every road to the page and tells what it found of the bridge.
  let port = 0
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'close')
    if (req.url === '/redirect') {
      res.writeHead(302, { location: PAGE })
      res.end()
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><title>web page</title><iframe id="frame" src="${PAGE}"></iframe>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  const opened: string[] = []
  // What the handler of the scheme was given, as it was given it (engine/internal-pages.ts `watchInternalRequests`).
  const handled: InternalRequestRecord[] = []
  watchInternalRequests((record) => handled.push(record))
  try {
    const wcOf = (id: string): WebContents | undefined => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
    const internalTab = () => store.get().tabs.find((tab) => isInternalPageUrl(tab.url))
    const windowsBefore = BrowserWindow.getAllWindows().length

    // ---- the page opens in a tab, by the way every caller opens it ----
    browser.openOverlay({ panel: 'extensions' })
    const made = await waitFor(() => internalTab() !== undefined && wcOf(internalTab()!.id) !== undefined)
    const tab = internalTab()
    if (!made || !tab) return check('extensions-page: the page opens in a tab', false, JSON.stringify(store.get().tabs.map((item) => item.url)))
    opened.push(tab.id)
    const wc = wcOf(tab.id)!
    check('extensions-page: the page opens in a tab, at its own address, and the tab is the one shown', tab.url === PAGE && store.get().activeTabBySpace[tab.spaceId] === tab.id, tab.url)
    check('extensions-page: no window is made for it', BrowserWindow.getAllWindows().length === windowsBefore && !BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().includes('extensions.html')), String(BrowserWindow.getAllWindows().length))
    check('extensions-page: the address a person sees is chrome://extensions', displayAddress(tab.url) === 'chrome://extensions', displayAddress(tab.url))

    // ---- what the page was given ----
    const loaded = await waitFor(async () => (await wc.executeJavaScript(`document.querySelector('.xp-title')?.textContent ?? ''`)) !== '')
    check('extensions-page: the page is drawn (its document, its modules and its fonts loaded under the scheme)', loaded, wc.getURL())
    const named = await waitFor(() => internalTab()?.title === 'Extensions' || /^Extensions$/i.test(internalTab()?.title ?? ''))
    check('extensions-page: the tab is named Extensions, by the title of the page', named, internalTab()?.title)
    const keys = (await wc.executeJavaScript(`typeof window.lucium === 'object' ? Object.keys(window.lucium).sort() : typeof window.lucium`)) as unknown
    check('extensions-page: window.lucium is the eight calls of the page and nothing else', JSON.stringify(keys) === JSON.stringify(CALLS), JSON.stringify(keys))
    const snapshot = (await wc.executeJavaScript(`window.lucium.getSnapshot()`)) as { state?: { tabs?: unknown[]; favorites?: unknown[] }; extensions?: unknown[]; runtime?: { tabs?: object } } | null
    check('extensions-page: the snapshot it asks for is the reduced one: no tab, no favourite, no runtime', !!snapshot && Array.isArray(snapshot.extensions) && snapshot.state?.tabs?.length === 0 && snapshot.state?.favorites?.length === 0 && Object.keys(snapshot.runtime?.tabs ?? {}).length === 0, JSON.stringify(snapshot).slice(0, 200))
    const request = (await wc.executeJavaScript(`window.lucium.extensionsPage({ op: 'details' })`)) as { ok?: boolean } | undefined
    check('extensions-page: a request of the page is answered (the gate lets the page through)', request?.ok === true, JSON.stringify(request))

    // ---- what the handler of the scheme received, and what it relies on ----
    const document0 = handled.find((record) => record.status === 200 && record.url === PAGE)
    check('extensions-page: the handler was given the secret of the shell in the extra headers of its load, and served the document to it (the document is served to the load of the shell and to no other)', document0?.loadSecret === true, JSON.stringify(document0))
    const files = handled.filter((record) => record.url.includes('/<key>/assets/'))
    check('extensions-page: the files the document names were asked under the key of the session and served (the handler never sees them without it)', files.length > 0 && files.every((record) => record.status === 200), `${files.length} files, ${files.filter((record) => record.status !== 200).length} refused`)
    const heard = (name: 'sec-fetch-dest' | 'sec-fetch-mode' | 'sec-fetch-site' | 'referer' | 'origin'): string => `${name}: ${[...new Set(handled.map((record) => record.fetchHeaders[name]))].join(' | ')}`
    check('extensions-page: INFORMATION, always passes: which of the headers that tell who asks the engine hands the handler, for the document and the files it loads (null: not given; Chromium may give none, which is why the rule does not rest on them)', true, [heard('sec-fetch-dest'), heard('sec-fetch-mode'), heard('sec-fetch-site'), heard('referer'), heard('origin'), `referrer field of a file: ${files[0]?.referrer}`, `header names of a file: ${files[0]?.headerNames.join(',')}`].join(' ;; '))
    const realFile = (await wc.executeJavaScript(`document.querySelector('script[type=module]')?.src ?? ''`)) as string
    const keyed = KEYED_FILE.exec(realFile)
    check('extensions-page: the document names its script under a key of the session (lucium-ui://extensions/<key>/assets/<file>)', keyed !== null, realFile.replace(/[0-9a-f]{32}/, '<key>'))

    // ---- a reload is the shell's load again, and is served ----
    const served0 = handled.filter((record) => record.status === 200 && record.url === PAGE).length
    browser.pageFor(tab.id)?.reload()
    const reloaded = await waitFor(() => handled.filter((record) => record.status === 200 && record.url === PAGE).length > served0)
    check('extensions-page: a reload of the page asks for the document again with the secret of the shell, and is served (a reload does not rely on the headers of the entry)', reloaded && handled.filter((record) => record.url === PAGE).slice(served0).every((record) => record.loadSecret), JSON.stringify(handled.filter((record) => record.url === PAGE).slice(-2)))
    const drawnAgain = await waitFor(async () => (await wc.executeJavaScript(`document.querySelector('.xp-title')?.textContent ?? ''`)) !== '')
    check('extensions-page: the page is drawn again after the reload', drawnAgain, wc.getURL())

    // ---- opening it again, and moving in it ----
    browser.openOverlay({ panel: 'extensions', target: { view: 'shortcuts' } })
    const moved = await waitFor(() => internalTab()?.url === `${PAGE}shortcuts` && wc.getURL() === `${PAGE}shortcuts`)
    check('extensions-page: opened again, the same tab is selected and goes to the shortcuts, not a second tab', moved && store.get().tabs.filter((item) => isInternalPageUrl(item.url)).length === 1, internalTab()?.url)
    await wc.executeJavaScript(`history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate'))`)
    const followed = await waitFor(() => internalTab()?.url === PAGE)
    check('extensions-page: the page moves by history.pushState and the address of the tab follows it (did-navigate-in-page)', followed, internalTab()?.url)

    // ---- the tab goes to the web by an address typed in it, and comes back by Back ----
    // What this shows: the state follows the page both ways (a tab sent away is no longer the page, a tab that comes back to it is again), and the document served to the
    // history move is the one of the shell's load: the handler's record says whether the secret came with it (the entry replayed the header) or the engine loaded the page
    // again after a 403 (`internalDocument`), and the page is drawn either way.
    browser.setTabAddress(tab.id, `http://127.0.0.1:${port}/start`)
    const left = await waitFor(() => wc.getURL().startsWith(`http://127.0.0.1:${port}`) && !wc.isLoading())
    check('extensions-page: an address typed in the tab sends it to the web, and the state follows it (the tab is no longer the page)', left && !isInternalPageUrl(store.get().tabs.find((item) => item.id === tab.id)?.url ?? ''), store.get().tabs.find((item) => item.id === tab.id)?.url)
    const beforeBack = handled.length
    browser.pageFor(tab.id)?.goBack()
    const back = await waitFor(async () => wc.getURL() === PAGE && (await wc.executeJavaScript(`document.querySelector('.xp-title')?.textContent ?? ''`)) !== '')
    check('extensions-page: Back onto the page draws it again, and the state says the tab is on it again (not a blank page of a tab the state keeps on the site it left)', back && internalTab()?.id === tab.id, `${wc.getURL()} | ${store.get().tabs.find((item) => item.id === tab.id)?.url}`)
    const backRecords = handled.slice(beforeBack).filter((record) => record.url === PAGE)
    check('extensions-page: INFORMATION, always passes: how the document was asked for on that Back (loadSecret true on the first record: the entry replays the extra header of the load; false then true: the engine loaded the page again after a 403)', true, JSON.stringify(backRecords.map((record) => [record.status, record.loadSecret, record.why])))

    // ---- a page of the web, in a tab of its own, that tries every road ----
    browser.dispatch({ type: 'tab/open', url: `http://127.0.0.1:${port}/start` })
    const web = store.get().tabs.at(-1)!
    opened.push(web.id)
    const webWc = (): WebContents | undefined => wcOf(web.id)
    const ready = await waitFor(() => webWc()?.getURL().startsWith(`http://127.0.0.1:${port}`) === true && !webWc()!.isLoading())
    check('extensions-page: a page of the web opens in its tab', ready, webWc()?.getURL())
    if (ready) {
      const page = webWc()!
      check('extensions-page: it has no window.lucium', (await page.executeJavaScript(`typeof window.lucium`)) === 'undefined')
      const frames = page.mainFrame.framesInSubtree
      check('extensions-page: a frame of that page that asks for the Extensions page does not show it (no document at that address, no bridge)', frames.every((frame) => frame.url !== PAGE), JSON.stringify(frames.map((frame) => frame.url)))
      // The frame this page opens on the Extensions page at its start (see the server above) reached the handler, if at all, without the secret of the shell.
      const framed = handled.filter((record) => record.url === PAGE && !record.loadSecret)
      check('extensions-page: what the web page\'s own frame asked of the handler (if anything) was refused', framed.every((record) => record.status === 403), JSON.stringify(framed.map((record) => [record.status, record.why, record.fetchHeaders['sec-fetch-dest']])))
      // A page of the web loads the document and the files with `<script>`, `<img>`, `<link>` and `<iframe>`, under its default referrer policy and under `no-referrer`
      // (which leaves the request without `Referer`). Without the key and the secret none can be served, whatever the engine gives the handler.
      if (keyed !== null) {
        const name = keyed[2]!
        const targets = [PAGE, `${PAGE}shortcuts`, `lucium-ui://extensions/assets/${name}`, `lucium-ui://extensions/${'0'.repeat(32)}/assets/${name}`, `lucium-ui://extensions/${keyed[1]!.split('').reverse().join('')}/assets/${name}`]
        for (const policy of ['', 'no-referrer']) {
          const from = handled.length
          const fired = (await page.executeJavaScript(probeScript(targets, policy))) as Fired
          const seen = handled.slice(from)
          const label = policy === '' ? 'default referrer policy' : 'no-referrer'
          check(`extensions-page: from a web page (${label}), the document and the files, asked by script, image, style sheet and frame without the key or the secret, are not served`, seen.every((record) => record.status !== 200), JSON.stringify(seen.map((record) => [record.url, record.status, record.why])).slice(0, 400))
          check(`extensions-page: from a web page (${label}), none of those elements reports a load (a script, an image or a style sheet of the page cannot tell that Lucium or its build is there)`, fired.filter((item) => item.kind !== 'iframe').every((item) => item.event !== 'load'), JSON.stringify(fired.filter((item) => item.event === 'load')))
          check(`extensions-page: from a web page (${label}), what the engine handed the handler of those requests is told (${seen.length} requests)`, true, JSON.stringify(seen.map((record) => [record.url.slice(-40), record.status, record.fetchHeaders['sec-fetch-dest'], record.fetchHeaders['sec-fetch-site'], record.fetchHeaders.referer])).slice(0, 600))
          check(`extensions-page: from a web page (${label}), no frame of it shows the page`, page.mainFrame.framesInSubtree.every((frame) => !frame.url.startsWith('lucium-ui:')), JSON.stringify(page.mainFrame.framesInSubtree.map((frame) => frame.url)))
        }
        // THE FINDING (verified in a real Electron 45.2.1 on 13 November 2026): `protocol.handle` is given none of `Sec-Fetch-*`, `Origin`, `Referer`, so the key of the session and
        // the secret of the shell's load are the only walls, and a web page that knew the key could load a (public) file of the bundle. This is not a check that can fail on that:
        // it records, with the key known, what the engine handed the handler over the whole run, and SAYS (without failing) when a later Electron starts to hand some of it over, so
        // that the question is reopened (docs/design/extensions-en-onglet.md, decision 4): the headers would then be a second layer again. What must stay true without the key is
        // checked above (nothing is served, nothing loads), and what must stay true without the secret is the document's (the first probes).
        const from = handled.length
        const fired = (await page.executeJavaScript(probeScript([realFile], 'no-referrer'))) as Fired
        const seen = handled.slice(from)
        const given = headersGiven(handled)
        check(
          'extensions-page: FINDING, always passes: the handler of protocol.handle is given no Sec-Fetch-*, Origin or Referer (verified on Electron 45.2.1), so the key of the session and the secret of the shell\'s load are the only walls; the detail records what was given over the whole run and what a web page that knew the key got',
          true,
          JSON.stringify({ electron: process.versions.electron, requests: handled.length, given, keyKnown: { fired: fired.filter((item) => item.kind !== 'iframe').map((item) => [item.kind, item.event]), handler: seen.map((record) => [record.status, record.why, record.referrer]) } }).slice(0, 700)
        )
        if (given.length > 0) {
          console.warn(`[smoke] extensions-page SIGNAL: this Electron hands the handler of protocol.handle ${given.join(', ')}; the finding of 13 November 2026 (none) no longer holds: reopen decision 4 of docs/design/extensions-en-onglet.md`)
          check(`extensions-page: SIGNAL, always passes: this Electron (${process.versions.electron}) now hands the handler of protocol.handle ${given.join(', ')}: the finding "no header, the key is the only wall" no longer holds, reopen decision 4 of the design document (the headers can be a second layer again)`, true, JSON.stringify(given))
        }
      }
      const fetched = await page.executeJavaScript(`fetch('${PAGE}').then(() => 'answered', () => 'refused')`)
      check('extensions-page: it cannot read the page with fetch', fetched === 'refused', String(fetched))
      await page.executeJavaScript(`location.href = '${PAGE}'; true`)
      const stayed = await waitFor(() => page.getURL().startsWith(`http://127.0.0.1:${port}`) && !page.isLoading(), 4000)
      check('extensions-page: a link or a script cannot send the tab to the page', stayed && !isInternalPageUrl(store.get().tabs.find((item) => item.id === web.id)?.url ?? ''), page.getURL())
      const tabsBefore = store.get().tabs.length
      await page.executeJavaScript(`window.open('${PAGE}'); true`)
      const noneOpened = !(await waitFor(() => store.get().tabs.length > tabsBefore, 3000))
      check('extensions-page: window.open cannot open the page', noneOpened && store.get().tabs.filter((item) => isInternalPageUrl(item.url)).length === 1, String(store.get().tabs.length))
      await page.executeJavaScript(`location.href = '/redirect'; true`)
      const redirected = await waitFor(() => !page.isLoading() && page.getURL().length > 0, 4000)
      check('extensions-page: a redirect of a server to the page does not take the tab there, and gives it no bridge', redirected && !isInternalPageUrl(page.getURL()) && (await page.executeJavaScript(`typeof window.lucium`)) === 'undefined', page.getURL())
    }

    // ---- the page goes with its tab ----
    browser.dispatch({ type: 'tab/close', id: tab.id })
    const gone = await waitFor(() => wcOf(tab.id) === undefined && internalTab() === undefined)
    check('extensions-page: closing the tab ends the page', gone, JSON.stringify(store.get().tabs.map((item) => item.url)))
    browser.openOverlay({ panel: 'extensions' })
    const again = await waitFor(() => internalTab() !== undefined && wcOf(internalTab()!.id) !== undefined)
    if (internalTab()) opened.push(internalTab()!.id)
    check('extensions-page: it opens again after it was closed', again, internalTab()?.url)
  } finally {
    watchInternalRequests(null)
    for (const id of opened) browser.dispatch({ type: 'tab/close', id })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=extensions-page`: only this check, with its own report. */
export async function runExtensionsPageSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeExtensionsPage(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeExtensionsPage ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_EXTENSIONS_PAGE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
