// Engine checks for the second privacy wave, run inside a real Electron: autoplay (Chromium's policy by default, a choice for the whole
// browser and for one site, a page rebuilt when a tab goes on to a site with another mode), the user's own filter lists (a file, pasted
// rules, a rule that would freeze the browser, a resource of a page that is cut) and "Effacer à la fermeture" (the data of a listed site
// goes with its last tab, another site is spared, a private window erases nothing, the quit erases the list, the extensions keep answering).
// A local server hands out the pages; hosts that are different sites of this one machine play different sites: 127.0.0.1 (A) and
// localhost (B), with p.localhost (P) as a site that is never on a list. Called from the engine test: `await smokePrivacy2(ctx, check)`.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { CUSTOM_LISTS_MAX } from '@shared/custom-filter-lists'
import { defaultSettings, type Settings } from '@shared/model'
import type { Action } from '@shared/sidebar'
import { sitesToClearOnQuit } from '@shared/site-clear'
import { blockingService } from './blocking'
import type { SmokeContext } from './smoke'
import { menuItems } from './shell/context-menus'
import { QUIT_CLEAR_MARKER, markQuitClear, replayQuitClear } from './shell/quit-clear'
import { getWindowManager } from './shell/windows'
import { clickOn, evaluate, waitFor } from './smoke-sitedata'
import { noteCheck, openSiteSections, recorderOf, sleep } from './smoke-kit'
import { adsBlockingPatch } from '@shared/blocker'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void

/** One second of 440 Hz, 8-bit mono: a sound a page can really play. */
function wav(): Buffer {
  const rate = 8000
  const buf = Buffer.alloc(44 + rate)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + rate, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(rate, 40)
  for (let i = 0; i < rate; i++) buf[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate))
  return buf
}

const PLAY = `(async () => { try { await new Audio('/a.wav').play(); return 'played' } catch (e) { return e.name } })()`

export async function smokePrivacy2(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  const ui = overlayView.webContents
  const manager = getWindowManager()
  const settings = (): Settings => store.get().settings
  const originals = { ...settings() }
  const defaults = defaultSettings()

  // ---------- the server: pages that try to play a sound, that load a tracker, that hold cookies ----------
  const hits = new Map<string, number>()
  const autoHits = new Map<string, number>()
  const hitsOf = (host: string): number => hits.get(host) ?? 0
  const server = createServer((req, res) => {
    const host = req.headers.host ?? ''
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const n = url.searchParams.get('n') ?? ''
    hits.set(`${host}${path}`, (hits.get(`${host}${path}`) ?? 0) + 1)
    if (path === '/a.wav') {
      res.setHeader('content-type', 'audio/wav')
      return res.end(wav())
    }
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    if (path === '/auto') {
      // One title per load (n.hit), so a reload is told from the load before it. The page does what a site does on its own at load: play a sound,
      // start a Web Audio context, start a muted video; it reports the verdict of each, and whether the document ever had a user activation.
      const hit = (autoHits.get(n) ?? 0) + 1
      autoHits.set(n, hit)
      return res.end(`<title>auto:${n}.${hit}:pending</title><body><script>(async () => { let r; try { await new Audio('/a.wav').play(); r = 'played' } catch (e) { r = e.name }; const ctx = new AudioContext(); const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.src = '/a.wav?m'; document.body.appendChild(v); await new Promise((s) => setTimeout(s, 900)); document.title = 'auto:${n}.${hit}:' + [r, ctx.state, v.paused ? 'muted-paused' : 'muted-playing', navigator.userActivation.hasBeenActive].join(':') })()</script></body>`)
    }
    if (path === '/hub') {
      // A page that is one big link: a click anywhere follows it, as a click on a link of a site does.
      return res.end(`<title>hub:${n}</title><body style="margin:0"><a href="${url.searchParams.get('to') ?? '/'}" style="position:fixed;inset:0;display:block;background:#ddd">go</a></body>`)
    }
    if (path === '/seed') {
      res.setHeader('set-cookie', 'srv=ok; Path=/')
      return res.end(`<title>seed:${n}</title><script>document.cookie = 'js=ok; path=/'; localStorage.setItem('ls', 'ok'); document.title = 'seeded:${n}'</script>`)
    }
    if (path === '/probe') {
      return res.end(`<title>probing</title><script>document.title = 'probe:${n}:' + JSON.stringify({ cookie: document.cookie, ls: localStorage.getItem('ls') })</script>`)
    }
    if (path === '/tracked') {
      // A page that loads a script and an image from two other hosts, and asks for an address that freezes a regular expression.
      const port = (server.address() as AddressInfo).port
      return res.end(`<title>tracked:${n}</title><script src="http://tracker.localhost:${port}/t.js"></script><img src="http://tracker.localhost:${port}/${'a'.repeat(60)}c.png"><img src="http://friendly.localhost:${port}/f.png"><script>document.title = 'tracked:${n}:' + (window.__trackerRan === true ? 'ran' : 'cut')</script>`)
    }
    if (path === '/t.js') {
      res.setHeader('content-type', 'text/javascript')
      return res.end('window.__trackerRan = true')
    }
    if (path.endsWith('.png')) {
      res.setHeader('content-type', 'image/png')
      return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    }
    res.end(`<title>root ${path}</title><body>root</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const A = `127.0.0.1:${port}`
  const B = `localhost:${port}`
  const P = `p.localhost:${port}`
  const urlOf = (host: string, path = '') => `http://${host}${path}`
  let counter = 0
  const nonce = (): string => String(++counter)

  const opened: string[] = []
  const titleOf = (id: string, state = store) => state.get().tabs.find((t) => t.id === id)?.title ?? ''
  const homeSpace = store.get().spaces.find((s) => s.profileId === 'default')!.id
  browser.dispatch({ type: 'space/select', id: homeSpace })
  const open = (url: string, using = browser, state = store): string => {
    using.dispatch({ type: 'tab/open', url })
    const id = state.get().tabs.at(-1)!.id
    if (using === browser) opened.push(id)
    return id
  }
  const closeTab = async (id: string, using = browser): Promise<void> => {
    using.dispatch({ type: 'tab/close', id })
    await using.clearingSettled()
  }
  /** Closes the tabs this suite opened so far: a site is only "closed" when none of its tabs is left. */
  const closeOpened = async (): Promise<void> => {
    for (const id of opened.splice(0)) if (store.get().tabs.some((t) => t.id === id)) browser.dispatch({ type: 'tab/close', id })
    await browser.clearingSettled()
  }
  const wcOf = (id: string, using = browser): WebContents | undefined => (using.pageFor(id) as unknown as { webContents?: WebContents } | undefined)?.webContents
  const cookies = (host: string): Promise<number> => engine.siteCookieCount('default', host, false)
  /** Opens `/seed` on a host and waits for it: the site now holds a cookie of the server, one of the page and a localStorage entry. */
  const seedTab = async (host: string): Promise<string> => {
    const n = nonce()
    const id = open(urlOf(host, `/seed?n=${n}`))
    check(`${host} holds data`, await waitFor(() => titleOf(id) === `seeded:${n}`, 12_000), titleOf(id))
    return id
  }
  /** What a load of the sound-playing page reports (see `/auto`): the verdict of its sound, of its Web Audio context and of its muted video, and whether the document ever had a user activation. */
  interface Report {
    play: string
    ctx: string
    muted: string
    active: string
  }
  const reportOf = (id: string, tag: string, state = store): Report | null => {
    const parts = titleOf(id, state).split(':')
    return parts[0] === 'auto' && parts[1] === tag && parts.length === 6 ? { play: parts[2]!, ctx: parts[3]!, muted: parts[4]!, active: parts[5]! } : null
  }
  const awaitReport = async (id: string, tag: string, state = store): Promise<Report | null> => ((await waitFor(() => reportOf(id, tag, state) !== null, 10_000)) ? reportOf(id, tag, state) : null)
  const autoplayOpening = async (host: string, using = browser, state = store): Promise<{ id: string; result: string; report: Report | null }> => {
    const n = nonce()
    const id = open(urlOf(host, `/auto?n=${n}`), using, state)
    const report = await awaitReport(id, `${n}.1`, state)
    return { id, result: report?.play ?? `no answer (${titleOf(id, state)})`, report }
  }
  /**
   * A real click in the middle of a page's top-left area: what a user does to follow a link or to give the page a gesture. `took` says whether the page saw it
   * (the link was followed, the page has a user activation). A click sent before the page can take it lands on nothing; measured on a runner, in four runs of
   * seven, the page followed no link and had no activation, whichever of the three clicks of the cases A, B and C it was. It is sent again, up to four times,
   * for as long as the page did not take it: a person clicks again too. The wait before the second click is long enough for a slow navigation to show.
   */
  const clickPage = async (id: string, took: () => boolean | Promise<boolean>): Promise<void> => {
    const wc = wcOf(id)
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc?.sendInputEvent({ type, x: 100, y: 100, button: 'left', clickCount: 1 })
      if (await waitFor(took, 2000)) break
    }
    await sleep(200)
  }
  const hasActivation = (id: string) => async (): Promise<boolean> => (await wcOf(id)?.executeJavaScript('navigator.userActivation.hasBeenActive').catch(() => false)) === true
  const reset = (): void => {
    browser.dispatch({
      type: 'settings/update',
      patch: {
        autoplayPolicy: defaults.autoplayPolicy,
        siteAutoplay: {},
        autoplayPerSite: true,
        customFilterListsEnabled: true,
        siteDataClearOnCloseEnabled: false,
        siteDataClearOnClose: [],
        siteDataClearOnQuit: false,
        siteDataTypes: ['cookies', 'localStorage'],
        siteDataSubdomains: false,
        siteDataNotify: false
      }
    })
  }
  /** The Settings window (a window of its own, titled "Réglages"), once it is open. */
  const settingsContents = (): WebContents | undefined => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')?.webContents
  /** The Settings window on a subpage of Vie privée et sécurité: the lists (the filter lists, the sites cleared on closing) are each on their own. */
  const openSettings = async (anchor: 'filterlists' | 'clearonclose'): Promise<WebContents | undefined> => {
    browser.openOverlay({ panel: 'settings', pane: 'protection', anchor })
    await waitFor(() => settingsContents() !== undefined, 8000)
    await sleep(800)
    return settingsContents()
  }
  const closeSettings = async (): Promise<void> => {
    for (const w of BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')) w.close()
    await waitFor(() => settingsContents() === undefined, 5000)
  }
  const extensionWorkers = (): string[] => engine.runningExtensionWorkers().filter((scope) => scope.startsWith('chrome-extension://'))
  const workersBefore = extensionWorkers()
  const dir = mkdtempSync(join(tmpdir(), 'lucium-privacy2-'))
  const realClearSiteData = engine.clearSiteData.bind(engine)
  const realError = console.error

  try {
    reset()

    // =====================================================================================================================
    // AUTOPLAY
    // =====================================================================================================================
    check('autoplay: the default is Chromium\'s policy, not Electron\'s', settings().autoplayPolicy === 'block' && Object.keys(settings().siteAutoplay).length === 0, JSON.stringify([settings().autoplayPolicy, settings().siteAutoplay]))

    // ---- Chromium's policy by default: a sound waits for a gesture ----
    const first = await autoplayOpening(A)
    check('autoplay: a page that plays a sound on its own is refused (NotAllowedError), as in Chromium', first.result === 'NotAllowedError', first.result)
    const firstContents = wcOf(first.id)
    const gesture = await firstContents?.executeJavaScript(PLAY, true)
    check('autoplay: after a gesture of the user the same page may play (the policy is not a ban)', gesture === 'played', String(gesture))

    // ---- Four cases: the same page, reached four ways ----
    check('autoplay: Chromium\'s policy also holds back a Web Audio context, and lets a muted video start in a tab on screen (as Arc does)', first.report?.ctx === 'suspended' && first.report.muted === 'muted-playing' && first.report.active === 'false', JSON.stringify(first.report))
    const linkN = nonce()
    const sameLink = open(urlOf(A, `/hub?n=${linkN}&to=${encodeURIComponent(`/auto?n=${linkN}`)}`))
    await waitFor(() => titleOf(sameLink) === `hub:${linkN}`, 10_000)
    await clickPage(sameLink, () => titleOf(sameLink) !== `hub:${linkN}`)
    const caseA = await awaitReport(sameLink, `${linkN}.1`)
    check('autoplay: case A, a page reached by a click on a link of the same origin plays by itself (the click is carried over), its audio context runs', caseA?.play === 'played' && caseA.ctx === 'running' && caseA.active === 'true', JSON.stringify(caseA))
    const otherN = nonce()
    const crossLink = open(urlOf(A, `/hub?n=${otherN}&to=${encodeURIComponent(urlOf(B, `/auto?n=${otherN}`))}`))
    await waitFor(() => titleOf(crossLink) === `hub:${otherN}`, 10_000)
    await clickPage(crossLink, () => titleOf(crossLink) !== `hub:${otherN}`)
    const caseB = await awaitReport(crossLink, `${otherN}.1`)
    check('autoplay: case B, a page reached from another origin has no gesture: the sound is refused, the audio context stays suspended', caseB?.play === 'NotAllowedError' && caseB.ctx === 'suspended' && caseB.active === 'false' && caseB.muted === 'muted-playing', JSON.stringify(caseB))
    await clickPage(crossLink, hasActivation(crossLink))
    const caseC = await wcOf(crossLink)?.executeJavaScript(PLAY)
    check('autoplay: case C, after a click in that page the sound plays', caseC === 'played', String(caseC))
    browser.dispatch({ type: 'tab/select', id: crossLink })
    browser.nav('reload')
    const caseD = await awaitReport(crossLink, `${otherN}.2`)
    check('autoplay: case D, after a reload the sound is refused again (a click does not survive a reload)', caseD?.play === 'NotAllowedError' && caseD.ctx === 'suspended' && caseD.active === 'false', JSON.stringify(caseD))

    // ---- looking at a tab, or leaving it, is not a click: neither the page shown nor the page left gets a user activation ----
    const shown = await autoplayOpening(A)
    const leaving = await autoplayOpening(A)
    const activationOf = async (id: string): Promise<string> => String(await wcOf(id)?.executeJavaScript('navigator.userActivation.hasBeenActive'))
    check('autoplay: a page that was shown, then left for another tab, has had no user activation and still refuses a sound', (await activationOf(shown.id)) === 'false' && (await wcOf(shown.id)?.executeJavaScript(PLAY)) === 'NotAllowedError' && shown.result === 'NotAllowedError', JSON.stringify([await activationOf(shown.id), shown.result]))
    check('autoplay: …and the page that was just shown has not either', (await activationOf(leaving.id)) === 'false' && leaving.result === 'NotAllowedError', JSON.stringify([await activationOf(leaving.id), leaving.result]))

    // ---- the choice for the whole browser: new pages get it ----
    const older = await autoplayOpening(A)
    const olderPage = browser.pageFor(older.id)
    const activation = (id: string): Promise<unknown> => wcOf(id)?.executeJavaScript(`JSON.stringify([navigator.userActivation.hasBeenActive, navigator.userActivation.isActive, document.visibilityState])`) ?? Promise.resolve('no page')
    const olderBefore = await wcOf(older.id)?.executeJavaScript(PLAY)
    const activationBefore = await activation(older.id)
    browser.dispatch({ type: 'settings/update', patch: { autoplayPolicy: 'allow' } })
    const afterSetting = await wcOf(older.id)?.executeJavaScript(PLAY)
    const allowed = await autoplayOpening(A)
    check('autoplay: with "Autoriser" for all sites, a new tab plays by itself', allowed.result === 'played', allowed.result)
    const activationAfter = await activation(older.id)
    const stillBlocked = await wcOf(older.id)?.executeJavaScript(PLAY)
    check('autoplay: a page made before the change keeps its policy (a change applies to pages made afterwards)', older.result === 'NotAllowedError' && olderBefore === 'NotAllowedError' && stillBlocked === 'NotAllowedError' && browser.pageFor(older.id) === olderPage && String(activationAfter).startsWith('[false,false'), JSON.stringify({ made: older.result, before: olderBefore, afterSetting, after: stillBlocked, samePage: browser.pageFor(older.id) === olderPage, activationBefore, activationAfter }))
    browser.dispatch({ type: 'settings/update', patch: { autoplayPolicy: 'block' } })

    // ---- the choice for one site, from the site control center ----
    const siteTab = open(urlOf(B, '/'))
    await waitFor(() => titleOf(siteTab) === 'root /')
    browser.dispatch({ type: 'tab/select', id: siteTab })
    browser.openOverlay({ panel: 'site' })
    await sleep(700)
    // The rows are in sections of the panel that are folded until they are opened.
    await openSiteSections((script) => evaluate(ui, script))
    check('autoplay: the site panel has the row', await clickOn(ui, '.scc-setting', 'Lecture automatique'))
    check('autoplay: a click on the row makes this site "Autoriser"', await waitFor(() => settings().siteAutoplay['localhost'] === 'allow'), JSON.stringify(settings().siteAutoplay))
    check('autoplay: and the row says so', await waitFor(async () => (await evaluate<string>(ui, `[...document.querySelectorAll('.scc-setting')].find((e) => e.textContent.includes('Lecture automatique'))?.textContent ?? ''`)).includes('Autoriser')))
    await clickOn(ui, '.scc-setting', 'Lecture automatique')
    check('autoplay: a second click makes it "Bloquer le son"', await waitFor(() => settings().siteAutoplay['localhost'] === 'block'), JSON.stringify(settings().siteAutoplay))
    await clickOn(ui, '.scc-setting', 'Lecture automatique')
    check('autoplay: a third click gives the site back to the general choice', await waitFor(() => settings().siteAutoplay['localhost'] === undefined), JSON.stringify(settings().siteAutoplay))
    browser.closeOverlay()

    // ---- a site that allows, a site that follows the general choice, in new tabs ----
    browser.dispatch({ type: 'autoplay/site', site: B, mode: 'allow' })
    const siteAllowed = await autoplayOpening(B)
    const otherBlocked = await autoplayOpening(A)
    check('autoplay: the site with "Autoriser" plays by itself while another site (general choice: Chromium) does not', siteAllowed.result === 'played' && otherBlocked.result === 'NotAllowedError', JSON.stringify([siteAllowed.result, otherBlocked.result]))

    // ---- the old switch of the per-site choices, kept off by an older state file: it is read by nothing, the site keeps its choice and its row ----
    browser.dispatch({ type: 'settings/update', patch: { autoplayPerSite: false } })
    const keptOff = await autoplayOpening(B)
    browser.dispatch({ type: 'tab/select', id: keptOff.id })
    browser.openOverlay({ panel: 'site' })
    await sleep(700)
    await openSiteSections((script) => evaluate(ui, script))
    const rowWhileKeptOff = await evaluate<boolean>(ui, `[...document.querySelectorAll('.scc-setting')].some((e) => e.textContent.includes('Lecture automatique'))`)
    browser.closeOverlay()
    check('autoplay: with the old per-site switch left off in the state, a site set to "Autoriser" still plays by itself, and the site panel keeps its row', keptOff.result === 'played' && rowWhileKeptOff, JSON.stringify([keptOff.result, rowWhileKeptOff]))
    browser.dispatch({ type: 'settings/update', patch: { autoplayPerSite: true } })

    // ---- general "Autoriser", one site that blocks ----
    browser.dispatch({ type: 'settings/update', patch: { autoplayPolicy: 'allow' } })
    browser.dispatch({ type: 'autoplay/site', site: B, mode: 'block' })
    const siteBlocked = await autoplayOpening(B)
    const otherAllowed = await autoplayOpening(A)
    check('autoplay: with "Autoriser" for all, a site set to "Bloquer le son" still waits for a gesture and the others play', siteBlocked.result === 'NotAllowedError' && otherAllowed.result === 'played', JSON.stringify([siteBlocked.result, otherAllowed.result]))

    // ---- a tab that goes on to a site with another mode gets a page of that mode, and keeps its history ----
    browser.dispatch({ type: 'settings/update', patch: { autoplayPolicy: 'block' } })
    browser.dispatch({ type: 'autoplay/site', site: B, mode: 'allow' })
    const walker = await autoplayOpening(A)
    const walkerId = walker.id
    const pageBefore = browser.pageFor(walkerId)
    const walkN = nonce()
    browser.dispatch({ type: 'tab/select', id: walkerId })
    browser.submitUrl(urlOf(B, `/auto?n=${walkN}`), 'current')
    const rebuilt = await waitFor(() => browser.pageFor(walkerId) !== undefined && browser.pageFor(walkerId) !== pageBefore, 10_000)
    const walked = await waitFor(() => titleOf(walkerId).startsWith(`auto:${walkN}.`) && titleOf(walkerId).split(':')[2] === 'played', 10_000)
    check('autoplay: a tab opened on a site that waits for a gesture, then sent to a site that allows, plays there', walker.result === 'NotAllowedError' && walked, JSON.stringify([walker.result, titleOf(walkerId)]))
    check('autoplay: …because its page was made again with that mode', rebuilt)
    const walkerHistory = browser.pageFor(walkerId)?.navigationEntries()
    check('autoplay: …and the history of the tab came with it (the first site, then the second)', walkerHistory?.entries.length === 2 && walkerHistory.index === 1 && walkerHistory.entries[0]?.url.includes(A) === true, JSON.stringify(walkerHistory))
    browser.nav('back')
    check('autoplay: Back still goes to the previous page', await waitFor(() => store.get().tabs.find((t) => t.id === walkerId)?.url.includes(A) === true), store.get().tabs.find((t) => t.id === walkerId)?.url)

    // ---- the page that was rebuilt under the same id is the one the engine knows (the old one dies a moment later, `close()` is asynchronous) ----
    {
      // Back may have rebuilt it once more: what counts is the page that is there now, after the old ones are gone.
      await sleep(1500)
      browser.dispatch({ type: 'tab/select', id: walkerId })
      const number = engine.tabNumberOf(walkerId)
      check('autoplay: the engine still knows the rebuilt page of the tab once the old one is destroyed (the extensions see it as a tab)', number !== undefined && number === wcOf(walkerId)?.id && engine.pageIdOfTabNumber(number) === walkerId, JSON.stringify({ number, wc: wcOf(walkerId)?.id }))
      const wc = wcOf(walkerId)
      await evaluate(wc!, `setTimeout(() => { window.__r = prompt('après reconstruction', 'x'); window.__after = 'ran' }, 30); 1`)
      const asked = await waitFor(() => browser.currentPanel() === 'dialog', 6000)
      const request = browser.currentOverlay()
      if (request?.panel === 'dialog') browser.answerDialog(request.request.id, { value: 'répondu', suppress: false })
      const done = await waitFor(async () => (await evaluate<string>(wc!, 'window.__after').catch(() => '')) === 'ran', 6000)
      check('autoplay: a prompt() in the rebuilt page reaches the shell and its answer comes back (the dialog bridge still finds the page)', asked && done && (await evaluate<string>(wc!, 'window.__r')) === 'répondu', JSON.stringify({ asked, done }))
      if (browser.currentPanel() === 'dialog') browser.closeOverlay()
      // The extension runtime's idea of the active tab is the new page, not the one that was destroyed.
      const activated = (engine as unknown as { lastActivated: Map<string, number> }).lastActivated.get('default')
      check('autoplay: the extensions are told the rebuilt page is the active tab', activated !== undefined && activated === number, JSON.stringify({ activated, number }))
      // A late event of the page that is gone (its `close()` was asynchronous) says nothing about the tab.
      const late = (pageBefore as unknown as { events: { update(patch: { title: string }): void } }).events
      // No wait after it: an update of a page is applied, or dropped, before the call returns (shell/browser-pages.ts).
      late.update({ title: 'titre-fantôme' })
      check('autoplay: a late update from the page that was destroyed does not touch the tab', titleOf(walkerId) !== 'titre-fantôme', titleOf(walkerId))
    }

    // ---- the private window: its own choice, nothing written ----
    {
      const priv = manager.openPrivate()
      const before = JSON.stringify(settings().siteAutoplay)
      priv.browser.dispatch({ type: 'autoplay/site', site: A, mode: 'allow' })
      check('autoplay: a private window takes a choice of its own', priv.store.get().settings.siteAutoplay['127.0.0.1'] === 'allow', JSON.stringify(priv.store.get().settings.siteAutoplay))
      check('autoplay: …which the shared settings never see', JSON.stringify(settings().siteAutoplay) === before, JSON.stringify(settings().siteAutoplay))
      const inPrivate = await autoplayOpening(A, priv.browser, priv.store)
      check('autoplay: and its pages follow it', inPrivate.result === 'played', inPrivate.result)
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
    }
    reset()
    await closeOpened()

    // =====================================================================================================================
    // THE USER'S OWN FILTER LISTS
    // =====================================================================================================================
    const service = blockingService()
    // The scriptlets switch of the blocker is another function's: it is off here whatever an earlier suite of the same process left it at.
    browser.dispatch({ type: 'settings/update', patch: { ...adsBlockingPatch(true), blockScriptlets: false, customFilterLists: [] } })
    await service.settled()
    const tracked = async (): Promise<string> => {
      const n = nonce()
      const id = open(urlOf(A, `/tracked?n=${n}`))
      await waitFor(() => titleOf(id).startsWith(`tracked:${n}:`), 10_000)
      await sleep(400)
      const outcome = titleOf(id).split(':')[2] ?? 'no answer'
      await closeTab(id)
      return outcome
    }
    const before = { tracker: hitsOf('tracker.localhost:' + port + '/t.js'), friendly: hitsOf(`friendly.localhost:${port}/f.png`) }
    check('lists: without a custom list the tracker script of the page runs', (await tracked()) === 'ran' && hitsOf(`tracker.localhost:${port}/t.js`) > before.tracker)

    // ---- pasted rules: a rule that cuts, a script, a regular expression that would freeze the browser, a line that is no rule ----
    // Line by line, as the compiler reads it today: the comment gives nothing; the rule that cuts is kept; the scriptlet is one of Lucium's own with
    // arguments of the right form, so it is kept too (it does nothing unless "Scriptlets et règles étendues" is on, which it is not here); the regular
    // expression is refused (ignored); the sentence has a space in its pattern (invalid). Two kept, one ignored, one invalid.
    const pasted = await browser.addFilterListText('Ma liste de test', `! Title: ignoré, le nom donné prime\n||tracker.localhost^$third-party\nlocalhost##+js(set-constant, __scriptletRan, true)\n/(a+)+$/\nceci n'est pas une règle\n`)
    check('lists: pasted rules are added, two kept (the cut and the scriptlet), one left out and one invalid', pasted.ok && pasted.rules === 2 && pasted.ignored === 1 && pasted.invalid === 1, JSON.stringify(pasted))
    await service.settled()
    const listId = pasted.ok ? pasted.list.id : ''
    const listFile = join(app.getPath('userData'), 'filters', 'lists', `${listId}.txt`)
    const onDisk = existsSync(listFile) ? readFileSync(listFile, 'utf8') : ''
    check('lists: the list is in the settings and its kept rules are on disk, without the regular expression and the sentence', settings().customFilterLists.length === 1 && onDisk.includes('||tracker.localhost^$third-party') && onDisk.includes('set-constant') && !onDisk.includes('(a+)+') && !onDisk.includes('ceci'), JSON.stringify([settings().customFilterLists, onDisk]))
    const status = browser.snapshot().blocking?.lists.find((l) => l.id === listId)
    check('lists: the snapshot shows it as the user\'s own, with its rule count and what was left out, with the lines', status?.custom === true && status.rules === 2 && status.review?.ignored === 1 && status.review.invalid === 1 && status.review.samples.map((s) => s.line).join() === '4,5', JSON.stringify(status))
    const started = Date.now()
    const cutBefore = { tracker: hitsOf(`tracker.localhost:${port}/t.js`), friendly: hitsOf(`friendly.localhost:${port}/f.png`) }
    const cut = await tracked()
    check('lists: the page loads in no time with the freezing regular expression in the list (it was refused), and its tracker is cut', Date.now() - started < 15_000 && cut === 'cut', `${Date.now() - started} ms, ${cut}`)
    check('lists: the tracker host never saw the script or the image, the friendly host did', hitsOf(`tracker.localhost:${port}/t.js`) === cutBefore.tracker && hitsOf(`friendly.localhost:${port}/f.png`) > cutBefore.friendly, JSON.stringify([hitsOf(`tracker.localhost:${port}/t.js`), cutBefore]))
    const scriptlet = await evaluate<string>(win.webContents, 'typeof window.__scriptletRan')
    check('lists: the script rule, kept but with the scriptlets switch off, did not run in the interface either', scriptlet === 'undefined', scriptlet)

    // ---- off, on, and again off: the setting follows ----
    browser.dispatch({ type: 'filterlist/enable', id: listId, enabled: false })
    await service.settled()
    check('lists: a list switched off no longer cuts', (await tracked()) === 'ran')
    browser.dispatch({ type: 'filterlist/enable', id: listId, enabled: true })
    await service.settled()
    check('lists: and cuts again once it is back on', (await tracked()) === 'cut')

    // ---- the switch of the function: off, nothing is compiled and nothing is added ----
    browser.dispatch({ type: 'settings/update', patch: { customFilterListsEnabled: false } })
    await service.settled()
    const refusedWhileOff = await browser.addFilterListText('x', '||autre.localhost^\n')
    check('lists: with the switch off the list no longer cuts, none can be added, and the rules are kept', (await tracked()) === 'ran' && !refusedWhileOff.ok && existsSync(listFile) && settings().customFilterLists.length === 1, JSON.stringify(refusedWhileOff))
    browser.dispatch({ type: 'settings/update', patch: { customFilterListsEnabled: true } })
    await service.settled()
    check('lists: and with the switch back on it cuts again', (await tracked()) === 'cut')

    // ---- the settings window shows it and removes it with a real click ----
    const sw = await openSettings('filterlists')
    const settingsText = (): Promise<string> => (sw ? evaluate<string>(sw, 'document.body.innerText') : Promise.resolve(''))
    check('lists: Settings › Vie privée et sécurité › Listes de filtres shows the list with its count and what was left out', sw !== undefined && (await waitFor(async () => (await settingsText()).includes('Ma liste de test') && (await settingsText()).includes('2 règles · 1 ignorée · 1 invalide'), 8000)), await (async () => {
      const text = await settingsText()
      const at = text.indexOf('Ma liste de test')
      return at < 0 ? `the list is not in the pane (${text.length} characters, from: ${text.slice(0, 80)})` : text.slice(Math.max(0, at - 40), at + 160)
    })())
    if (sw) {
      await evaluate(sw, `document.querySelector('button[aria-label="Retirer Ma liste de test"]')?.scrollIntoView({ block: 'center' })`)
      await sleep(300)
    }
    // « Retirer » asks first: the rules of a pasted list are kept nowhere else. The question is the standard box, whose red button removes.
    const question = (): Promise<string | null> => (sw ? evaluate<string | null>(sw, `document.querySelector('[role="alertdialog"]')?.getAttribute('aria-label') ?? null`) : Promise.resolve(null))
    const askedTitle = frenchSpaces('Retirer la liste « Ma liste de test » ?')
    const askRemoval = async (): Promise<boolean> => sw !== undefined && (await clickOn(sw, 'button[aria-label="Retirer Ma liste de test"]')) && (await waitFor(async () => (await question()) === askedTitle, 4000))
    const asked = await askRemoval()
    check('lists: a click on "Retirer" asks first, and the list is still there', asked && settings().customFilterLists.length === 1 && existsSync(listFile), `${String(await question())} ${JSON.stringify(settings().customFilterLists)}`)
    check('lists: …"Annuler" closes the question and keeps the list and its rules', sw !== undefined && asked && (await clickOn(sw, '[role="alertdialog"] .adlg-cancel')) && (await waitFor(async () => (await question()) === null, 4000)) && settings().customFilterLists.length === 1 && existsSync(listFile), `${String(await question())} ${JSON.stringify(settings().customFilterLists)}`)
    check('lists: "Retirer" in the question takes the list out of the settings', sw !== undefined && (await askRemoval()) && (await clickOn(sw, '[role="alertdialog"] .adlg-danger')) && (await waitFor(() => settings().customFilterLists.length === 0, 8000)), JSON.stringify(settings().customFilterLists))
    await waitFor(() => !existsSync(listFile), 8000)
    check('lists: …and deletes its rules from the disk', !existsSync(listFile))
    await service.settled()
    check('lists: and the tracker is loaded again', (await tracked()) === 'ran')
    await closeSettings()

    // ---- a file ----
    const file = join(dir, 'mes-regles.txt')
    writeFileSync(file, '[Adblock Plus 2.0]\n||tracker.localhost^$third-party\n')
    const fromFile = await browser.addFilterListFile(file)
    await service.settled()
    check('lists: a file is added under its own name, and cuts', fromFile.ok && fromFile.list.title === 'mes-regles' && fromFile.list.source === 'file' && fromFile.list.sourceName === 'mes-regles.txt' && (await tracked()) === 'cut', JSON.stringify(fromFile))
    const missing = await browser.addFilterListFile(join(dir, 'absent.txt'))
    check('lists: a file that cannot be read is told, and nothing is added', !missing.ok && missing.reason === 'Le fichier n’a pas pu être lu.' && settings().customFilterLists.length === 1, JSON.stringify(missing))
    const html = join(dir, 'page.txt')
    writeFileSync(html, '<html><body>Not found</body></html>')
    check('lists: a web page saved as a list is refused', JSON.stringify(await browser.addFilterListFile(html)) === JSON.stringify({ ok: false, reason: 'Ce texte est une page web, pas une liste de règles.' }))

    // ---- through the interface: the route works, a forged list does not ----
    const viaUi = await evaluate<{ ok: boolean; rules?: number }>(win.webContents, `window.lucium.addFilterListText('Depuis l’interface', '||autre.localhost^')`)
    check('lists: the interface\'s route adds a list too', viaUi.ok === true && viaUi.rules === 1 && settings().customFilterLists.length === 2, JSON.stringify(viaUi))
    const forged = { id: 'custom-deadbeef', title: 'Forgée', source: 'file' as const, sourceName: 'x.txt', enabled: true, addedAt: 1 }
    await evaluate(win.webContents, `window.lucium.dispatch(${JSON.stringify({ type: 'filterlist/add', list: forged } satisfies Action)})`)
    // No wait after them: each dispatch of the interface is answered once the main process has applied or refused it.
    await evaluate(win.webContents, `window.lucium.dispatch(${JSON.stringify({ type: 'settings/update', patch: { customFilterLists: [forged] } })})`)
    check('lists: the interface cannot add a list itself, nor replace the lists through the settings', settings().customFilterLists.length === 2 && !settings().customFilterLists.some((l) => l.id === 'custom-deadbeef'), JSON.stringify(settings().customFilterLists.map((l) => l.id)))
    for (const l of [...settings().customFilterLists]) await browser.removeFilterList(l.id)
    await browser.removeFilterList('../index')
    check('lists: the lists can be removed (and an id that is not one changes nothing)', settings().customFilterLists.length === 0)

    // ---- the limit, and the private window ----
    for (let i = 0; i < CUSTOM_LISTS_MAX; i++) await browser.addFilterListText(`l${i}`, `||s${i}.localhost^\n`)
    const overflow = await browser.addFilterListText('trop', '||trop.localhost^\n')
    check(`lists: ${CUSTOM_LISTS_MAX} lists at most`, settings().customFilterLists.length === CUSTOM_LISTS_MAX && !overflow.ok, JSON.stringify(overflow))
    for (const l of [...settings().customFilterLists]) await browser.removeFilterList(l.id)
    {
      const priv = manager.openPrivate()
      const refused = await priv.browser.addFilterListText('x', '||x.localhost^\n')
      check('lists: a private window adds none (the rules would stay on disk)', !refused.ok && settings().customFilterLists.length === 0, JSON.stringify(refused))
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
    }
    browser.dispatch({ type: 'settings/update', patch: adsBlockingPatch(false) })
    await service.settled()
    await closeOpened()

    // =====================================================================================================================
    // CLEARING A SITE'S DATA WHEN ITS LAST TAB CLOSES
    // =====================================================================================================================
    check('close: the function is off by default, with nothing listed', settings().siteDataClearOnCloseEnabled === false && settings().siteDataClearOnClose.length === 0 && settings().siteDataClearOnQuit === false)
    const probeSite = async (host: string): Promise<{ cookie: string; ls: string | null } | null> => {
      const n = nonce()
      const id = open(urlOf(host, `/probe?n=${n}`))
      const ok = await waitFor(() => titleOf(id).startsWith(`probe:${n}:`), 8000)
      const read = ok ? (JSON.parse(titleOf(id).slice(`probe:${n}:`.length)) as { cookie: string; ls: string | null }) : null
      browser.dispatch({ type: 'tab/close', id })
      await browser.clearingSettled()
      return read
    }

    // ---- off by default: closing the last tab of a site erases nothing ----
    const lone = await seedTab(A)
    check('close: the site holds its cookies', (await cookies(A)) >= 2, String(await cookies(A)))
    await closeTab(lone)
    check('close: with an empty list, closing the last tab of a site erases nothing', (await cookies(A)) >= 2, String(await cookies(A)))

    // ---- adding the site from the site control center ----
    const a1 = await seedTab(A)
    const a2 = await seedTab(A)
    let b1 = await seedTab(B)
    await seedTab(P)
    browser.dispatch({ type: 'tab/select', id: a1 })
    browser.openOverlay({ panel: 'site' })
    await sleep(700)
    await openSiteSections((script) => evaluate(ui, script))
    check('close: the site panel has the row', await clickOn(ui, '.scc-setting', 'Effacer à la fermeture'))
    check('close: a click lists the site of the page and switches the function on', await waitFor(() => settings().siteDataClearOnClose.join() === A && settings().siteDataClearOnCloseEnabled), JSON.stringify([settings().siteDataClearOnClose, settings().siteDataClearOnCloseEnabled]))
    check('close: and the row says it is on', await waitFor(async () => (await evaluate<string>(ui, `[...document.querySelectorAll('.scc-setting')].find((e) => e.textContent.includes('à la fermeture'))?.textContent ?? ''`)).includes('Activé')))
    browser.closeOverlay()

    await closeTab(a2)
    check('close: closing one of two tabs of the site erases nothing', (await cookies(A)) >= 2, String(await cookies(A)))
    await closeTab(a1)
    check('close: closing the last tab of the listed site erases its cookies', (await cookies(A)) === 0, String(await cookies(A)))
    check('close: …and the site that is not listed is spared', (await cookies(B)) >= 2 && (await cookies(P)) >= 2, JSON.stringify([await cookies(B), await cookies(P)]))
    const afterA = await probeSite(A)
    check('close: the localStorage went too (the types of the panel)', afterA?.ls === null && afterA.cookie === '', JSON.stringify(afterA))
    const afterB = await probeSite(B)
    check('close: and the spared site still has its localStorage', afterB?.ls === 'ok' && afterB.cookie.includes('srv=ok'), JSON.stringify(afterB))

    // ---- the switch: off, the list is kept and nothing is erased ----
    browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnCloseEnabled: false } })
    const whileOff = await seedTab(A)
    await closeTab(whileOff)
    check('close: with the switch off, closing the last tab of a listed site erases nothing', (await cookies(A)) >= 2 && settings().siteDataClearOnClose.includes(A), String(await cookies(A)))
    browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnCloseEnabled: true } })

    // ---- a tab that goes elsewhere is not a tab that closes (a sign-in goes through other hosts) ----
    const walkerA = await seedTab(A)
    browser.dispatch({ type: 'tab/select', id: walkerA })
    browser.submitUrl(urlOf(P, '/'), 'current')
    await waitFor(() => store.get().tabs.find((t) => t.id === walkerA)?.url.includes('p.localhost') === true)
    await sleep(500)
    await browser.clearingSettled()
    check('close: a tab that only navigates away from the listed site erases nothing', (await cookies(A)) >= 2, String(await cookies(A)))
    await closeTab(walkerA)

    // ---- a private tab of a normal window is not a tab of the profile ----
    {
      const privateTabsWas = settings().privateTabs
      browser.dispatch({ type: 'settings/update', patch: { privateTabs: true, siteDataClearOnCloseEnabled: false } })
      await closeTab(await seedTab(A))
      browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnCloseEnabled: true } })
      const held = await cookies(A)
      browser.dispatch({ type: 'tab/open', url: urlOf(A, `/seed?n=${nonce()}`), private: true })
      const privateOnA = store.get().tabs.at(-1)!.id
      await waitFor(() => titleOf(privateOnA).startsWith('seeded:'), 12_000)
      await closeTab(privateOnA)
      check('close: closing a private tab on a listed site leaves the profile\'s data of that site alone', held >= 2 && (await cookies(A)) === held, JSON.stringify([held, await cookies(A)]))

      // The active tab is a private one: the erasure of a normal tab still goes to the profile, not to the private context.
      const normalOnA = await seedTab(A)
      browser.dispatch({ type: 'tab/open', url: urlOf(P, '/'), private: true })
      const privateActive = store.get().tabs.at(-1)!.id
      await closeTab(normalOnA)
      check('close: with a private tab active, closing the last normal tab of a listed site still erases the profile\'s data', (await cookies(A)) === 0, String(await cookies(A)))

      // …and so does the erasure at quit.
      await seedTab(A)
      browser.dispatch({ type: 'tab/select', id: privateActive })
      browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnQuit: true } })
      const quitFailed = await browser.clearSitesOnQuit()
      check('close: with a private tab active, the erasure at quit still reaches the profile', quitFailed.length === 0 && (await cookies(A)) === 0, JSON.stringify([quitFailed, await cookies(A)]))
      browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnQuit: false } })
      await closeTab(privateActive)
      await closeOpened()
      browser.dispatch({ type: 'settings/update', patch: { privateTabs: privateTabsWas } })
    }

    // ---- the entry of the menu of a tab ----
    // The checks above closed every tab this suite had opened, this one with them.
    if (!store.get().tabs.some((t) => t.id === b1)) b1 = await seedTab(B)
    const labelOf = 'Effacer les données du site à la fermeture'
    const itemOf = (items: MenuItemConstructorOptions[]) => items.find((item) => item.label === labelOf)
    const entry = itemOf(menuItems({ kind: 'tab', id: b1 }, browser, store, win))
    check('close: the menu of a tab has the entry, unchecked', entry !== undefined && entry.type === 'checkbox' && entry.checked === false)
    ;(entry?.click as (() => void) | undefined)?.()
    check('close: the entry lists the site of the tab', settings().siteDataClearOnClose.includes(B) && itemOf(menuItems({ kind: 'tab', id: b1 }, browser, store, win))?.checked === true, JSON.stringify(settings().siteDataClearOnClose))
    const nonWeb = open('about:blank')
    check('close: a page that is not a site has no such entry', itemOf(menuItems({ kind: 'tab', id: nonWeb }, browser, store, win)) === undefined)
    browser.dispatch({ type: 'tab/close', id: nonWeb })

    // ---- the list in Settings: shown, and a real click removes a site ----
    const sw2 = await openSettings('clearonclose')
    check('close: Settings › Vie privée et sécurité › Effacer certains sites en partant lists the sites', sw2 !== undefined && (await waitFor(async () => (await evaluate<string>(sw2, 'document.body.innerText')).includes(B) && (await evaluate<string>(sw2, 'document.body.innerText')).includes('Effacer les données de ces sites à la fermeture'), 8000)))
    if (sw2) {
      await evaluate(sw2, `document.querySelector('button[aria-label="Retirer ${A}"]')?.scrollIntoView({ block: 'center' })`)
      await sleep(300)
    }
    const clicked = sw2 !== undefined && (await clickOn(sw2, `button[aria-label="Retirer ${A}"]`))
    check('close: a click on "Retirer" takes a site out of the list and leaves the other', clicked && (await waitFor(() => !settings().siteDataClearOnClose.includes(A) && settings().siteDataClearOnClose.includes(B), 8000)), JSON.stringify(settings().siteDataClearOnClose))
    await closeSettings()

    // ---- the failure of an erasure is told and logged ----
    const logged: string[] = []
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    engine.clearSiteData = () => Promise.reject(new Error('disque occupé'))
    await closeTab(b1)
    engine.clearSiteData = realClearSiteData
    console.error = realError
    const toast = browser.snapshot().toast?.message ?? ''
    check('close: when the erasure fails, a toast names the site', toast.startsWith('Effacement à la fermeture incomplet') && toast.includes('localhost:'), toast)
    check('close: …and the log says which sites and why', logged.some((line) => line.includes('[site]') && line.includes('localhost') && /disque occupé|not fully erased/.test(line)), logged.join(' | ').slice(0, 300))
    check('close: …and the data is still there, since nothing was erased', (await cookies(B)) >= 2, String(await cookies(B)))

    // ---- a restore of a backup closes nobody ----
    browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnCloseEnabled: true, siteDataClearOnClose: [A, B] } })
    const restored = await seedTab(A)
    const snapshot = store.get()
    browser.dispatch({ type: 'state/restore', state: { ...snapshot, tabs: snapshot.tabs.filter((t) => t.id !== restored) } })
    await browser.clearingSettled()
    check('close: restoring a backup whose tabs are others erases nothing', (await cookies(A)) >= 2, String(await cookies(A)))

    // ---- a private window erases nothing, offers nothing, and cannot list ----
    {
      const priv = manager.openPrivate()
      priv.browser.dispatch({ type: 'tab/open', url: urlOf(A, `/seed?n=private`) })
      const pTab = priv.store.get().tabs.at(-1)!.id
      await waitFor(() => titleOf(pTab, priv.store) === 'seeded:private', 12_000)
      const held = await priv.browser.siteCookieCount(A, false)
      priv.browser.dispatch({ type: 'tab/close', id: pTab })
      await priv.browser.clearingSettled()
      check('close: closing the last tab of a listed site in a private window erases nothing (its session is thrown away whole)', held >= 2 && (await priv.browser.siteCookieCount(A, false)) === held, String(held))
      const listBefore = JSON.stringify(priv.store.get().settings.siteDataClearOnClose)
      priv.browser.dispatch({ type: 'siteclear/site', site: P, on: true })
      priv.browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnClose: ['evil.example'], siteDataClearOnQuit: true } })
      check('close: a private window refuses to change the list', JSON.stringify(priv.store.get().settings.siteDataClearOnClose) === listBefore && priv.store.get().settings.siteDataClearOnQuit === settings().siteDataClearOnQuit, JSON.stringify(priv.store.get().settings.siteDataClearOnClose))
      priv.browser.dispatch({ type: 'tab/open', url: urlOf(A, '/') })
      const menuTab = priv.store.get().tabs.at(-1)!.id
      check('close: the menu of a tab of a private window has no such entry', itemOf(menuItems({ kind: 'tab', id: menuTab }, priv.browser, priv.store, priv.win)) === undefined)
      check('close: the quit erases nothing for a private window', (await priv.browser.clearSitesOnQuit()).length === 0 && (await priv.browser.siteCookieCount(A, false)) === held)
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
    }

    // ---- the quit ----
    await seedTab(B)
    await seedTab(P)
    check('quit: the sites hold data before the quit', (await cookies(A)) >= 2 && (await cookies(B)) >= 2 && (await cookies(P)) >= 2)
    check('quit: without the setting the quit erases nothing', (await browser.clearSitesOnQuit()).length === 0 && (await cookies(A)) >= 2 && (await cookies(B)) >= 2)
    browser.dispatch({ type: 'settings/update', patch: { siteDataClearOnQuit: true } })
    const failed = await browser.clearSitesOnQuit()
    check('quit: with the setting every listed site is erased and none fails', failed.length === 0 && (await cookies(A)) === 0 && (await cookies(B)) === 0, JSON.stringify([failed, await cookies(A), await cookies(B)]))
    check('quit: …and a site that is not listed is spared', (await cookies(P)) >= 2, String(await cookies(P)))

    // ---- a quit that was cut short is finished at the next launch ----
    {
      const marker = join(dir, QUIT_CLEAR_MARKER)
      await seedTab(A)
      check('resume: a listed site holds data again', (await cookies(A)) >= 2, String(await cookies(A)))
      markQuitClear(marker)
      const outcome = await replayQuitClear(marker, { enabled: () => sitesToClearOnQuit(store.get(), { private: false }).length > 0, clear: () => browser.clearSitesOnQuit() })
      check('resume: the marker left by a quit that was cut short makes the next launch erase the listed sites, then goes', outcome === 'done' && (await cookies(A)) === 0 && !existsSync(marker), JSON.stringify([outcome, await cookies(A), existsSync(marker)]))
      check('resume: …and a site that is not listed is spared', (await cookies(P)) >= 2, String(await cookies(P)))
    }

    // ---- the extensions of the profile never lost their service workers ----
    const workersAfter = extensionWorkers()
    check('the extensions loaded in the profile still have their service workers after all the erasures', workersAfter.length >= workersBefore.length, JSON.stringify([workersBefore, workersAfter]))
  } finally {
    console.error = realError
    engine.clearSiteData = realClearSiteData
    for (const id of opened) if (store.get().tabs.some((t) => t.id === id)) browser.dispatch({ type: 'tab/close', id })
    await browser.clearingSettled()
    browser.closeOverlay()
    await closeSettings()
    for (const l of [...settings().customFilterLists]) await browser.removeFilterList(l.id)
    browser.dispatch({
      type: 'settings/update',
      patch: {
        autoplayPolicy: originals.autoplayPolicy,
        siteAutoplay: originals.siteAutoplay,
        autoplayPerSite: originals.autoplayPerSite,
        customFilterListsEnabled: originals.customFilterListsEnabled,
        siteDataClearOnCloseEnabled: originals.siteDataClearOnCloseEnabled,
        siteDataClearOnClose: originals.siteDataClearOnClose,
        siteDataClearOnQuit: originals.siteDataClearOnQuit,
        siteDataTypes: originals.siteDataTypes,
        siteDataSubdomains: originals.siteDataSubdomains,
        siteDataNotify: originals.siteDataNotify,
        blockAds: originals.blockAds,
        blockTrackers: originals.blockTrackers,
        blockScriptlets: originals.blockScriptlets
      }
    })
    rmSync(dir, { recursive: true, force: true })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=privacy2`: only these checks, with their own report. */
export async function runPrivacy2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokePrivacy2(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokePrivacy2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PRIVACY2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
