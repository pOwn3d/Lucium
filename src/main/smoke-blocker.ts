// Engine checks for the ad and tracker blocker, inside a real Electron: the lists come from a local server (never the
// Internet), the pages from another; requests are really cancelled by Chromium and elements really hidden.
// The Settings window and the site control center are driven through their own DOM, the switch with a real mouse click.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, BrowserWindow as ElectronWindow, type WebContents } from 'electron'
import { FILTER_LISTS } from '@shared/filter-lists'
import { blockingService } from './blocking'
import { loadGhosteryBackend } from './blocking/ghostery-engine'
import { BlockingService } from './blocking/service'
import { getWindowManager } from './shell/windows'
import type { SmokeContext } from './smoke'
import { noteCheck, OPEN_MORE_SETTINGS, recorderOf, sleep, waiterOf } from './smoke-kit'
import { adsBlockingPatch } from '@shared/blocker'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 100)

// 1x1 transparent GIF.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const ADS_RULES = [
  '/smoke-ads/blocked.js',
  // Only for requests Chromium reports as "xhr": the same address loaded as an image must go through.
  '/smoke-ads/collect$xhr',
  // A rule that names the page the user opens: only a navigation could be hit by it, and a navigation is never blocked.
  '/self-blocked-page$document',
  // Whose request is it (Standard and Strict): rules that say nothing about it, and one that names the first party.
  '/smoke-1p/own.js',
  '/smoke-1p/third.js',
  '/smoke-1p/frame.js',
  '/smoke-1p/explicit.js$first-party',
  '###sponsor-box',
  '##.promo-banner',
  '127.0.0.1##.host-ad'
]
const COOKIE_RULES = ['/smoke-cmp/consent.js', '127.0.0.1###cookie-wall-smoke']

export async function smokeBlocker({ browser, store, overlayView }: SmokeContext, check: Check): Promise<void> {
  const service = blockingService()
  const hits = new Map<string, number>()
  const hit = (key: string) => hits.set(key, (hits.get(key) ?? 0) + 1)
  const count = (key: string) => hits.get(key) ?? 0
  let page = 0

  // What the list server answers for each list: replaced by a test to make it fail.
  const listReply = new Map<string, (request: IncomingMessage) => { status: number; body: string; etag?: string }>()
  const listBody = (id: string) => {
    const category = FILTER_LISTS.find((l) => l.id === id)?.category
    const rules = id === 'easylist' ? ADS_RULES : id === 'easylist-cookie' ? COOKIE_RULES : [`/smoke-other/${id}.js`]
    return ['[Adblock Plus 2.0]', `! Title: ${id} (${category})`, ...rules, ''].join('\n')
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    hit(path)
    const port = (server.address() as AddressInfo).port
    if (path.startsWith('/lists/')) {
      const id = path.slice('/lists/'.length).replace(/\.txt$/, '')
      const reply = listReply.get(id)?.(req) ?? { status: 200, body: listBody(id), etag: `"${id}-1"` }
      res.writeHead(reply.status, { 'content-type': 'text/plain', ...(reply.etag ? { etag: reply.etag } : {}) })
      return res.end(reply.body)
    }
    if (path === '/page') {
      const n = url.search
      res.setHeader('content-type', 'text/html')
      return res.end(`<title>smoke-blocker-pending</title><body>
        <div id="sponsor-box">sponsor</div><div class="host-ad">host</div><div id="keep-me">keep</div><div id="cookie-wall-smoke">cookies</div>
        <img id="pix" src="http://localhost:${port}/smoke-ok/pixel.gif${n}">
        <img id="collect-img" src="http://localhost:${port}/smoke-ads/collect?img${n.replace('?', '&')}">
        <script src="http://localhost:${port}/smoke-ads/blocked.js${n}"></script>
        <script src="http://localhost:${port}/smoke-cmp/consent.js${n}"></script>
        <script src="/smoke-first/first.js${n}"></script>
        <script>
          setTimeout(() => { const late = document.createElement('div'); late.className = 'promo-banner'; late.textContent = 'late'; document.body.append(late) }, 700)
          setTimeout(() => {
            const display = (selector) => { const el = document.querySelector(selector); return el ? getComputedStyle(el).display : 'missing' }
            const img = document.getElementById('collect-img')
            fetch('http://localhost:${port}/smoke-ads/collect?x=1${n.replace('?', '&')}').then(() => 'ok', () => 'blocked').then((xhr) => {
              document.title = 'r:' + [display('#sponsor-box'), display('.host-ad'), display('.promo-banner'), display('#keep-me'), display('#cookie-wall-smoke'), xhr, img.complete && img.naturalWidth ? 'img-ok' : 'img-no'].join(',')
            })
          }, 3000)
        </script></body>`)
    }
    // A page of 127.0.0.1 that asks for its own files and for a third party's (localhost), and embeds a frame of localhost that asks for its own.
    if (path === '/modes' || path === '/modes-frame') {
      const n = url.search
      res.setHeader('content-type', 'text/html')
      if (path === '/modes-frame') return res.end(`<title>modes-frame</title><script src="/smoke-1p/frame.js${n}"></script>`)
      return res.end(`<title>modes-pending</title><body>
        <script src="/smoke-1p/own.js${n}"></script>
        <script src="/smoke-1p/explicit.js${n}"></script>
        <script src="http://localhost:${port}/smoke-1p/third.js${n}"></script>
        <iframe src="http://localhost:${port}/modes-frame${n}"></iframe>
        <script>setTimeout(() => { document.title = 'modes-done' }, 2500)</script></body>`)
    }
    if (path === '/self-blocked-page') {
      res.setHeader('content-type', 'text/html')
      return res.end('<title>self-blocked-ok</title><body>ok</body>')
    }
    if (path === '/smoke-ads/collect') {
      if (url.searchParams.has('img')) {
        res.setHeader('content-type', 'image/gif')
        return res.end(GIF)
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
      return res.end('ok')
    }
    if (path.endsWith('.gif')) {
      res.setHeader('content-type', 'image/gif')
      return res.end(GIF)
    }
    res.setHeader('content-type', 'text/javascript')
    res.end('')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The application's own service, pointed at the local server: the real catalogue (so the settings show real lists), tiny copies.
  const catalog = FILTER_LISTS.map((list) => ({ ...list, url: `${origin}/lists/${list.id}.txt`, minRules: undefined }))
  service.useForTests({ fetch: (url, init) => fetch(url, init), catalog, allowInsecure: true, timeoutMs: 4000 })

  const restore = (): void => {
    browser.dispatch({ type: 'settings/update', patch: { ...adsBlockingPatch(false), blockCookieBanners: false, blockExceptions: [], disabledFilterLists: [], blockMode: 'standard' } })
    service.useForTests({ fetch: () => Promise.reject(new Error('Pas de réseau pendant le test du moteur.')), catalog: FILTER_LISTS })
    server.close()
    server.closeAllConnections()
  }
  try {
    const openPage = async (path = '/page'): Promise<{ id: string; report: () => string }> => {
      browser.dispatch({ type: 'tab/open', url: `${origin}${path}${path === '/page' ? `?n=${++page}` : ''}` })
      const tab = store.get().tabs.at(-1)!
      const titleOf = () => store.get().tabs.find((t) => t.id === tab.id)?.title ?? ''
      if (path === '/page') await waitFor(() => titleOf().startsWith('r:'), 15_000)
      else await waitFor(() => titleOf() === 'self-blocked-ok', 8000)
      return { id: tab.id, report: titleOf }
    }
    const settingsOf = () => store.get().settings

    // ---- off: nothing is fetched, nothing is compiled ----
    browser.dispatch({ type: 'settings/update', patch: { ...adsBlockingPatch(false), blockCookieBanners: false, blockExceptions: [], disabledFilterLists: [] } })
    // A fixed wait, for want of a witness: with both options off nothing starts at all, so nothing marks the end of the change.
    await sleep(500)
    check('with both blocking options off, no filter list is downloaded', [...hits.keys()].every((p) => !p.startsWith('/lists/')) && !service.status().engineReady)
    const withoutBlocking = await openPage()
    check('and the page shows everything: scripts load, nothing is hidden', count('/smoke-ads/blocked.js') === 1 && withoutBlocking.report() === 'r:block,block,block,block,block,ok,img-ok', `${withoutBlocking.report()} hits ${count('/smoke-ads/blocked.js')}`)

    // ---- on: the lists are fetched and compiled ----
    browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(true) })
    const compiled = await waitFor(() => service.status().engineReady, 15_000)
    check('turning ads blocking on downloads the ad lists and compiles them', compiled && count('/lists/easylist.txt') === 1 && count('/lists/ublock-unbreak.txt') === 1, JSON.stringify([...hits.entries()].filter(([p]) => p.startsWith('/lists/'))))
    check('...and leaves the cookie lists alone', count('/lists/easylist-cookie.txt') === 0 && count('/lists/ublock-cookies.txt') === 0)
    const status = service.status().lists.find((l) => l.id === 'easylist')
    check('the status says when a list was updated and how many rules it holds', !!status?.installed && typeof status.updatedAt === 'number' && status.rules === ADS_RULES.length && status.error === null, JSON.stringify(status))

    const blockedBefore = count('/smoke-ads/blocked.js')
    const first = await openPage()
    check('a third-party request a rule names never reaches the network, the others do', count('/smoke-ads/blocked.js') === blockedBefore && count('/smoke-ok/pixel.gif') >= 2 && count('/smoke-first/first.js') >= 2, `blocked ${count('/smoke-ads/blocked.js') - blockedBefore}, pixel ${count('/smoke-ok/pixel.gif')}`)
    const parts = first.report().replace(/^r:/, '').split(',')
    check('ad elements are hidden: by id, by host, and by class even when a script adds them late', parts[0] === 'none' && parts[1] === 'none' && parts[2] === 'none', first.report())
    check('an element no rule names stays', parts[3] === 'block', first.report())
    check('a rule for XHR cancels the fetch, and the same address loaded as an image goes through', parts[5] === 'blocked' && parts[6] === 'img-ok', first.report())
    check('the cookie list is not applied while its option is off', parts[4] === 'block' && count('/smoke-cmp/consent.js') >= 2, first.report())
    check('the tab counts what was blocked on it', browser.blockedCount(first.id) === 2, String(browser.blockedCount(first.id)))
    check('a counter belongs to the tab that asked: an unknown tab has none', browser.blockedCount('no-such-tab') === 0)

    // ---- the page the user opens is never blocked ----
    const selfBlocked = await openPage('/self-blocked-page')
    check('a page the lists name with a document rule still opens', selfBlocked.report() === 'self-blocked-ok', selfBlocked.report())
    check('...and a new page starts its counter again', browser.blockedCount(selfBlocked.id) === 0)

    // ---- a site without blocking ----
    browser.dispatch({ type: 'blocking/exempt-site', site: '127.0.0.1', exempt: true })
    check('an exception is stored for the host', settingsOf().blockExceptions.join() === '127.0.0.1')
    const blockedAtException = count('/smoke-ads/blocked.js')
    const exempt = await openPage()
    check('on a site with an exception everything loads and nothing is hidden', count('/smoke-ads/blocked.js') === blockedAtException + 1 && exempt.report() === 'r:block,block,block,block,block,ok,img-ok', exempt.report())
    check('...and nothing is counted', browser.blockedCount(exempt.id) === 0)
    browser.dispatch({ type: 'blocking/exempt-site', site: '127.0.0.1', exempt: false })
    const again = await openPage()
    check('removing the exception blocks again', count('/smoke-ads/blocked.js') === blockedAtException + 1 && again.report().startsWith('r:none,none,none'), again.report())

    // ---- Standard and Strict: a site's own requests, a third party's, and the frame of another site ----
    const openModes = async (): Promise<void> => {
      browser.dispatch({ type: 'tab/open', url: `${origin}/modes?n=${++page}` })
      const tab = store.get().tabs.at(-1)!
      await waitFor(() => (store.get().tabs.find((t) => t.id === tab.id)?.title ?? '') === 'modes-done', 15_000)
    }
    const modeHits = () => ({ own: count('/smoke-1p/own.js'), explicit: count('/smoke-1p/explicit.js'), third: count('/smoke-1p/third.js'), frame: count('/smoke-1p/frame.js') })
    const delta = (before: ReturnType<typeof modeHits>) => {
      const now = modeHits()
      return `own ${now.own - before.own}, explicit ${now.explicit - before.explicit}, third ${now.third - before.third}, frame ${now.frame - before.frame}`
    }
    check('Standard is the default mode', settingsOf().blockMode === 'standard', settingsOf().blockMode)
    const beforeStandard = modeHits()
    await openModes()
    const inStandard = delta(beforeStandard)
    check('Standard: the page\'s own file a rule names loads, the rule that names the first party still blocks, a third party\'s file is cancelled', inStandard.startsWith('own 1, explicit 0, third 0'), inStandard)
    check('Standard: a frame of another site loads its own file (judged by the document that asks, not by the tab)', inStandard.endsWith('frame 1'), inStandard)
    browser.dispatch({ type: 'settings/update', patch: { blockMode: 'strict' } })
    const beforeStrict = modeHits()
    await openModes()
    check('Strict: the page\'s own file is cancelled too, as is the first-party rule\'s, the third party\'s, and the frame\'s own file', delta(beforeStrict) === 'own 0, explicit 0, third 0, frame 0', delta(beforeStrict))
    browser.dispatch({ type: 'settings/update', patch: { blockMode: 'standard' } })

    // ---- the cookie category ----
    browser.dispatch({ type: 'settings/update', patch: { blockCookieBanners: true } })
    await waitFor(() => service.status().lists.find((l) => l.id === 'easylist-cookie')?.installed === true, 15_000)
    await waitFor(() => service.status().engineReady && service.status().updating === false)
    const consentBefore = count('/smoke-cmp/consent.js')
    const cookies = await openPage()
    check('with the banner option on, the cookie lists block the consent script and hide the wall', count('/smoke-cmp/consent.js') === consentBefore && cookies.report().split(',')[4] === 'none', cookies.report())

    // ---- the previous lists survive a failed update; the settings show it ----
    browser.dispatch({ type: 'settings/update', patch: { blockCookieBanners: false } })
    // The filter lists and the sites with no blocking are each on a subpage of Vie privée et sécurité; the mode waits in its « Plus de réglages ».
    browser.openOverlay({ panel: 'settings', pane: 'protection', anchor: 'filterlists' })
    const settingsWindow = async (): Promise<WebContents | undefined> => ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')?.webContents
    check('the Settings window opens', await waitFor(async () => (await settingsWindow()) !== undefined))
    const settingsUi = (await settingsWindow())!
    const inSettings = (script: string) => settingsUi.executeJavaScript(script) as Promise<unknown>
    const textOfSettings = async () => String(await inSettings(`document.body.innerText`))
    /** Takes the open window to the page (`anchor` absent: its fold opened) or to the subpage `anchor`, once its head says it. */
    const goSettings = async (anchor: 'filterlists' | 'exceptions' | undefined, heading: string) => {
      browser.openOverlay({ panel: 'settings', pane: 'protection', ...(anchor ? { anchor } : {}) })
      await waitFor(async () => (await inSettings(`document.querySelector('#pane-heading')?.textContent ?? ''`)) === heading)
      if (!anchor) await waitFor(async () => Boolean(await inSettings(OPEN_MORE_SETTINGS)))
    }
    await waitFor(async () => (await inSettings(`document.querySelector('#pane-heading')?.textContent ?? ''`)) === 'Listes de filtres')
    check('it lists the filter lists with the date of their last update', await waitFor(async () => /EasyList[\s\S]*Vérifiée le/.test(await textOfSettings())), (await textOfSettings()).slice(0, 300))
    check('the lists of a switched-off category are shown as unavailable', Boolean(await inSettings(`(() => { const row = [...document.querySelectorAll('label.pref-row')].find((r) => r.textContent.includes('EasyList Cookie List')); return !!row && row.classList.contains('shields-dim') && row.querySelector('input').disabled })()`)))

    await goSettings(undefined, 'Vie privée et sécurité')
    check('the settings offer the blocking mode, on Standard by default, with its sentence', await waitFor(async () => anySpace(/Standard : bloque les publicités et traqueurs tiers/).test(await textOfSettings()) && (await inSettings(`document.querySelector('select[aria-label="Mode de blocage"]')?.value`)) === 'standard'), (await textOfSettings()).slice(0, 300))
    await inSettings(`(() => { const select = document.querySelector('select[aria-label="Mode de blocage"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'strict'); select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    check('choosing Strict in the settings records it, and the sentence changes', (await waitFor(() => settingsOf().blockMode === 'strict')) && (await waitFor(async () => (await textOfSettings()).includes(frenchSpaces('Strict : bloque aussi les requêtes du site lui-même quand une liste le demande')))), settingsOf().blockMode)
    browser.dispatch({ type: 'settings/update', patch: { blockMode: 'standard' } })

    await goSettings('filterlists', 'Listes de filtres')
    listReply.set('easylist', () => ({ status: 500, body: 'erreur du serveur' }))
    const listHitsBefore = count('/lists/easylist.txt')
    await inSettings(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Mettre à jour maintenant'))?.click()`)
    check('"Mettre à jour maintenant" fetches the lists again', await waitFor(() => count('/lists/easylist.txt') > listHitsBefore))
    check('a failed update is shown in the settings', await waitFor(async () => (await textOfSettings()).includes('Échec de la dernière mise à jour') && (await textOfSettings()).includes('La copie précédente reste utilisée')), (await textOfSettings()).slice(0, 400))
    const afterFailure = service.status().lists.find((l) => l.id === 'easylist')!
    check('...the previous copy is kept (same date, same rules, still installed)', afterFailure.installed && afterFailure.updatedAt === status?.updatedAt && afterFailure.rules === status?.rules && afterFailure.error !== null, JSON.stringify(afterFailure))
    const blockedAfterFailure = count('/smoke-ads/blocked.js')
    const stillBlocked = await openPage()
    check('...and it keeps blocking', count('/smoke-ads/blocked.js') === blockedAfterFailure && stillBlocked.report().startsWith('r:none'), stillBlocked.report())
    // A captive portal answers 200 with a web page: the text, not the status, is what must be refused.
    listReply.set('easylist', () => ({ status: 200, body: '<!DOCTYPE html><html><body>Connectez-vous au réseau Wi-Fi</body></html>' }))
    const portalHits = count('/lists/easylist.txt')
    await service.updateNow()
    const afterPortal = service.status().lists.find((l) => l.id === 'easylist')!
    check('a web page served in place of a list is refused too, and the copy in use stays', count('/lists/easylist.txt') > portalHits && afterPortal.error?.message.includes('page web') === true && afterPortal.updatedAt === status?.updatedAt && afterPortal.rules === status?.rules, JSON.stringify(afterPortal))
    const blockedAfterPortal = count('/smoke-ads/blocked.js')
    const behindPortal = await openPage()
    check('...and it keeps blocking', count('/smoke-ads/blocked.js') === blockedAfterPortal && behindPortal.report().startsWith('r:none'), behindPortal.report())
    listReply.delete('easylist')

    // ---- settings: one list off, a site added ----
    await inSettings(`document.querySelector('input[aria-label="uBlock filters"]')?.click()`)
    check('switching a list off in the settings records it', await waitFor(() => settingsOf().disabledFilterLists.includes('ublock-filters')), JSON.stringify(settingsOf().disabledFilterLists))
    // The switch is a controlled input: the next click is only read for what it is once the Settings window has drawn the new state (a click that comes
    // before it flips the stale switch back to "off", and the list stays off, which the restart check below would then report as a rebuilt engine).
    const listSwitchIs = (on: boolean) => waitFor(async () => (await inSettings(`document.querySelector('input[aria-label="uBlock filters"]')?.checked`)) === on)
    await listSwitchIs(false)
    await inSettings(`document.querySelector('input[aria-label="uBlock filters"]')?.click()`)
    check('...and on again', await waitFor(() => settingsOf().disabledFilterLists.length === 0))
    await listSwitchIs(true)
    await goSettings('exceptions', 'Exceptions par site')
    await inSettings(`(() => { const input = document.querySelector('input[aria-label="Site à ne jamais bloquer"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://www.exemple.test/page'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await sleep(200)
    await inSettings(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Ajouter' && !b.disabled)?.click()`)
    check('a site typed in the settings joins the list as a host', await waitFor(() => settingsOf().blockExceptions.join() === 'exemple.test'), JSON.stringify(settingsOf().blockExceptions))
    browser.dispatch({ type: 'settings/update', patch: { blockExceptions: [] } })
    ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')?.close()

    // ---- the site control center ----
    await openPage()
    const tabId = store.get().tabs.at(-1)!.id
    browser.dispatch({ type: 'tab/select', id: tabId })
    browser.openOverlay({ panel: 'site' })
    const overlay = overlayView.webContents
    const inOverlay = (script: string) => overlay.executeJavaScript(script) as Promise<unknown>
    check('the site panel shows the shields with the tab\'s count', await waitFor(async () => /Blocage pour ce site[\s\S]*2 requêtes bloquées/.test(String(await inOverlay(`document.body.innerText`)))), String(await inOverlay(`document.body.innerText`)).slice(0, 400))
    // The panel unfolds when it opens: the switch is clicked where it rests (the same place twice, a moment apart), not where it was when the text first showed.
    const readRect = () => inOverlay(`(() => { const el = document.querySelector('.shields-row[role=switch]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`) as Promise<{ x: number; y: number; width: number; height: number } | null>
    let rect = await readRect()
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(150)
      const next = await readRect()
      const still = next !== null && rect !== null && next.x === rect.x && next.y === rect.y && next.width === rect.width && next.height === rect.height
      rect = next
      if (still) break
    }
    if (rect) {
      const x = Math.round(rect.x + rect.width / 2)
      const y = Math.round(rect.y + rect.height / 2)
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) overlay.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
    }
    check('a click on the switch adds the site to the exceptions', await waitFor(() => settingsOf().blockExceptions.join() === '127.0.0.1'), JSON.stringify(settingsOf().blockExceptions))
    check('...the panel says so and offers to reload', await waitFor(async () => /Désactivé pour ce site[\s\S]*Rechargez la page/.test(String(await inOverlay(`document.body.innerText`)))), String(await inOverlay(`document.body.innerText`)).slice(0, 400))
    browser.closeOverlay()
    browser.dispatch({ type: 'blocking/exempt-site', site: '127.0.0.1', exempt: false })

    // ---- a private window blocks too ----
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    const blockedBeforePrivate = count('/smoke-ads/blocked.js')
    priv.browser.dispatch({ type: 'tab/open', url: `${origin}/page?private` })
    const privTab = priv.store.get().tabs.at(-1)!
    const privTitle = () => priv.store.get().tabs.find((t) => t.id === privTab.id)?.title ?? ''
    await waitFor(() => privTitle().startsWith('r:'), 15_000)
    check('a private window blocks with the same lists', count('/smoke-ads/blocked.js') === blockedBeforePrivate && privTitle().startsWith('r:none,none,none'), privTitle())
    check('...and counts on its own tab', priv.browser.blockedCount(privTab.id) === 2, String(priv.browser.blockedCount(privTab.id)))
    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()

    // ---- the compiled engine comes back from disk ----
    let loaded = 0
    let built = 0
    const ghosteryBackend = await loadGhosteryBackend()
    const counting = { ...ghosteryBackend, load: async (bytes: Uint8Array) => (loaded++, ghosteryBackend.load(bytes)), build: async (texts: readonly string[]) => (built++, ghosteryBackend.build(texts)) }
    const restarted = new BlockingService({ dir: join(app.getPath('userData'), 'filters'), fetch: () => Promise.reject(new Error('hors ligne')), backend: async () => counting, catalog, allowInsecure: true })
    restarted.configure({ ads: true, cookieBanners: false, cosmetic: true, disabledLists: [], updateDays: 4 })
    await restarted.settled()
    const probe = { url: 'http://localhost:1/smoke-ads/blocked.js', resourceType: 'script', pageUrl: `${origin}/page`, pageId: null }
    check('after a restart the serialized engine is loaded, not rebuilt, and answers the same', loaded === 1 && built === 0 && restarted.filter(probe, { blockAds: true, blockCookieBanners: false, blockCosmetic: true, blockExceptions: [], blockMode: 'standard' }), `loaded ${loaded}, built ${built}`)
    restarted.dispose()

    // ---- back to a quiet state ----
    browser.dispatch({ type: 'settings/update', patch: { ...adsBlockingPatch(false), blockCookieBanners: false, blockExceptions: [], disabledFilterLists: [] } })
    check('turning both options off lets go of the compiled lists', await waitFor(() => !service.status().engineReady))
  } finally {
    restore()
  }
}

/**
 * The same checks with their own report, for the local branching in index.ts. Returns the exit code. It opens private windows:
 * run it after `runWindowsSmoke`, whose checks name the first private session ("ephemeral-1").
 */
export async function runBlockerSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeBlocker(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeBlocker ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_BLOCKER ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
