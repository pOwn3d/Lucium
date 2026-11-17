// Engine checks for the overlay panels: the command bar, the site control center, downloads, find, Glance, the mini window, the Tweak editor,
// permission and sign-in prompts, links that leave the browser (mailto:, tel:). Real input (sendInputEvent) drives every panel; what is checked
// is what the panels do (they open, answer to keys and clicks, close), never their pixel measures.
// Called by index.ts after every other suite: `runIsoPanelsSmoke(ctx)` (its own report), also LUCIUM_SMOKE_ONLY=iso-panels (quick loop).

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { getWindowManager } from './shell/windows'
import { app, BrowserWindow as ElectronWindow, clipboard, nativeTheme, screen, shell, webContents as allWebContents, type WebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { noteCheck, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Rect {
  x: number
  y: number
  width: number
  height: number
}


const waitFor = waiterOf(6000, 60)

/** Within `tolerance` px of a number (two positions of the same element, measured twice; ours may be fractional). */
const near = (a: number | undefined, b: number, tolerance = 1) => a !== undefined && Math.abs(a - b) <= tolerance
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
/** The colour of the frame the Eraser mode draws on the page: how the suite tells that the mode is on (not a design measure). */
const ZAP_BLUE = '#2f39ff'
const dist = (a: string, b: string) => [1, 3, 5].reduce((worst, i) => Math.max(worst, Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))), 0)

export async function smokeIsoPanels(ctx: SmokeContext, check: Check): Promise<void> {
  // What the checks change outside themselves (the server, the console, the opening of links, the settings and the size of the window, tabs, a Tweak)
  // is put back here, in the reverse order, even when a step throws. A run of 12 November lost the capture of the window in the middle of the suite: the
  // console stayed captured, and a Tweak in capitals on 127.0.0.1 changed the pages of the suites after it.
  const undo: Array<() => void> = []
  try {
    await isoPanelsChecks(ctx, check, (step) => undo.push(step))
  } finally {
    for (const step of undo.reverse()) {
      try {
        step()
      } catch (error) {
        console.error('[smoke iso-panels] a step of the cleanup failed, what it puts back may be left for the suites after this one:', error)
      }
    }
  }
}

/** The checks of `smokeIsoPanels`. `atEnd`: a step of the cleanup, run when the checks end or throw. */
async function isoPanelsChecks(ctx: SmokeContext, check: Check, atEnd: (step: () => void) => void): Promise<void> {
  const { browser, store, win, overlayView, little } = ctx
  const ui: WebContents = overlayView.webContents
  const state = () => store.get()

  // Credentials the local server accepts. The password is unique so that a search for it in logs and files cannot find anything else.
  const LOGIN = { user: 'ada', password: `pw${randomBytes(6).toString('hex')}` }
  const hits = { secret: 0, denied: 0, ok: 0, little: 0 }
  const nonce = randomBytes(8).toString('hex')
  const md5 = (text: string) => createHash('md5').update(text).digest('hex')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    const url = req.url ?? '/'
    // Basic: /secret (realm "Zone test") and /secret-b .. /secret-e (realms "Zone b" ..); Digest: /digest.
    const basic = (realm: string) => {
      const sent = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      hits.secret++
      if (sent && Buffer.from(sent, 'base64').toString() === `${LOGIN.user}:${LOGIN.password}`) {
        hits.ok++
        return res.end(`<title>secret ok</title><body>bienvenue ${LOGIN.user}</body>`)
      }
      hits.denied++
      res.statusCode = 401
      res.setHeader('www-authenticate', `Basic realm="${realm}"`)
      res.end('<title>refus 401</title><body>accès refusé</body>')
    }
    if (url === '/secret') return basic('Zone test')
    if (/^\/secret-[b-e]$/.test(url)) return basic(`Zone ${url.slice(-1)}`)
    if (url === '/digest') {
      const header = req.headers.authorization ?? ''
      const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`).exec(header)?.[1] ?? ''
      if (header.startsWith('Digest ') && field('username') === LOGIN.user) {
        const ha1 = md5(`${LOGIN.user}:Zone digest:${LOGIN.password}`)
        const expected = md5(`${ha1}:${nonce}:${field('nc')}:${field('cnonce')}:auth:${md5(`GET:${field('uri')}`)}`)
        if (field('response') === expected) return res.end('<title>digest ok</title><body>bienvenue</body>')
      }
      res.statusCode = 401
      res.setHeader('www-authenticate', `Digest realm="Zone digest", qop="auth", nonce="${nonce}", algorithm=MD5`)
      return res.end('<title>refus digest</title><body>accès refusé</body>')
    }
    if (url === '/fetches') {
      // Three requests of the page that each need a login: realm d, realm e, then realm d again.
      return res.end(`<title>fetches</title><body>x<script>
        window.__done = []
        for (const path of ['/secret-d', '/secret-e', '/secret-d']) fetch(path).then((r) => window.__done.push(path + ':' + r.status), () => window.__done.push(path + ':error'))
      </script></body>`)
    }
    if (url === '/links') {
      return res.end(`<title>links</title><body style="margin:0;background:#fff">
        <a id="mail" href="mailto:ada@example.com?subject=Bonjour" style="position:absolute;left:20px;top:20px;width:200px;height:30px;display:block">mail</a>
        <a id="tel" href="tel:+33123456789" style="position:absolute;left:20px;top:70px;width:200px;height:30px;display:block">tel</a>
        <a id="file" href="file:///etc/hosts" style="position:absolute;left:20px;top:120px;width:200px;height:30px;display:block">file</a>
        <a id="ssh" href="ssh://example.com" style="position:absolute;left:20px;top:170px;width:200px;height:30px;display:block">ssh</a>
        <a id="blank" target="_blank" href="mailto:blank@example.com" style="position:absolute;left:20px;top:220px;width:200px;height:30px;display:block">blank</a>
        <a id="custom" href="x-apple.systempreferences:com.apple.preference.security" style="position:absolute;left:20px;top:270px;width:200px;height:30px;display:block">prefs</a>
        <iframe id="frame" src="/links-frame" style="position:absolute;left:300px;top:20px;width:260px;height:80px;border:0"></iframe>
      </body>`)
    }
    if (url === '/little-a') {
      hits.little++
      return res.end('<title>little a</title><body style="margin:0"><a id="next" href="/little-b" style="display:block;width:300px;height:80px">vers b</a></body>')
    }
    if (url === '/zapmode') {
      return res.end(`<title>zapmode</title><body style="margin:0;background:#fff">
        <div id="a" style="position:absolute;left:30px;top:80px;width:200px;height:60px;background:#c33">A</div>
        <div id="b" style="position:absolute;left:30px;top:200px;width:200px;height:60px;background:#39c">B</div>
        <a id="lnk" href="/zapmode-next" style="position:absolute;left:300px;top:80px;width:100px;height:40px;display:block;background:#3c9">lien</a>
      </body>`)
    }
    if (url === '/zapmode-next') return res.end('<title>zapmode next</title><body>suite</body>')
    if (url === '/little-dl') return res.end('<title>little dl</title><body style="margin:0"><a id="dl" href="/download-little" download style="display:block;width:300px;height:80px">télécharger</a></body>')
    if (url === '/download-little') {
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="little-smoke.bin"')
      return res.end(Buffer.alloc(4096, 7))
    }
    if (url === '/little-b') return res.end('<title>little b</title><body>page b</body>')
    if (url === '/links-frame') return res.end('<body style="margin:0"><a id="inner" href="mailto:inner@example.com" style="display:block;width:240px;height:60px">dans un cadre</a></body>')
    if (url.startsWith('/white')) return res.end('<title>white</title><meta name="theme-color" content="#ffffff"><body style="margin:0;background:#fff">white</body>')
    res.end(`<title>page ${url}</title><meta name="theme-color" content="#212225"><body style="margin:0;background:#212225;color:#eee">${url} page page page</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  atEnd(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const evaluate = <T>(wc: WebContents, script: string) => wc.executeJavaScript(script) as Promise<T>
  const rectOf = (wc: WebContents, selector: string, index = 0) =>
    evaluate<Rect | null>(wc, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const styleOf = (wc: WebContents, selector: string, props: string[], index = 0) =>
    evaluate<Record<string, string> | null>(wc, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const s = getComputedStyle(el); const out = {}; for (const p of ${JSON.stringify(props)}) out[p] = s.getPropertyValue(p); return out })()`)

  const press = async (wc: WebContents, keyCode: string, times = 1) => {
    for (let i = 0; i < times; i++) {
      wc.sendInputEvent({ type: 'keyDown', keyCode })
      wc.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(40)
    }
  }
  const typeText = async (wc: WebContents, text: string) => {
    for (const ch of text) {
      const keyCode = ch === ' ' ? 'Space' : ch
      wc.sendInputEvent({ type: 'keyDown', keyCode })
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(50)
    }
    await sleep(300)
  }
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  const click = async (wc: WebContents, x: number, y: number) => {
    mouse(wc, 'mouseMove', x, y)
    mouse(wc, 'mouseDown', x, y)
    mouse(wc, 'mouseUp', x, y)
    await sleep(80)
  }
  const openPanel = async (request: Parameters<typeof browser.openOverlay>[0], selector: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay(request)
      if (await waitFor(async () => (await rectOf(ui, selector)) !== null, 2500)) break
    }
    await sleep(250)
  }
  void click

  // Everything printed during these checks, to look for what must never be printed (a password, an address).
  const logged: string[] = []
  const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : JSON.stringify(a))).join(' '))
      realConsole[level](...args)
    }
  }
  atEnd(() => Object.assign(console, realConsole))
  const realOpenExternal = shell.openExternal
  atEnd(() => ((shell as unknown as { openExternal: typeof realOpenExternal }).openExternal = realOpenExternal))
  const opened: string[] = []

  const before = { size: win.getSize(), settings: { sidebarVisible: state().settings.sidebarVisible, showToolbar: state().settings.showToolbar, searchSuggestions: state().settings.searchSuggestions } }
  atEnd(() => {
    browser.dispatch({ type: 'settings/update', patch: before.settings })
    win.setSize(before.size[0]!, before.size[1]!)
  })
  win.setSize(1680, 888)
  win.showInactive()
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, showToolbar: true, searchSuggestions: false } })
  const settle = async (path: string, title: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const id = state().tabs.at(-1)!.id
    await waitFor(() => state().tabs.find((t) => t.id === id)?.title === title)
    // The colour of the page reaches the interface a moment after it loads.
    await waitFor(() => browser.snapshot().runtime.tabs[id]?.color !== undefined)
    return id
  }
  const dark = await settle('/plain', 'page /plain')
  const cleanup: string[] = [dark]
  atEnd(() => {
    browser.dispatch({ type: 'tab/select', id: dark })
    for (const id of cleanup.filter((id) => id !== dark)) browser.dispatch({ type: 'tab/close', id })
  })
  await sleep(500)

  const W = win.getContentBounds().width
  const H = win.getContentBounds().height

  // ---------------------------------------------------------------------------------------------------------------------------
  // Command bar
  // ---------------------------------------------------------------------------------------------------------------------------
  await openPanel({ panel: 'commandbar', mode: 'new', initial: '' }, '.palette')
  await sleep(400)
  const card = (await rectOf(ui, '.palette'))!
  // The rows are the options of the list: the titles of the groups ("Onglets ouverts", "Historique"…) are list items too, but neither chosen nor counted.
  const rows = await evaluate<Rect[]>(ui, `[...document.querySelectorAll('.results li[role=option]')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })`)
  check('command bar: the card is inside the window and the list shows at least five rows, one under the other', card.x >= 0 && card.y >= 0 && card.x + card.width <= W && card.y + card.height <= H && rows.length >= 5 && rows.every((row, i) => i === 0 || row.y > rows[i - 1]!.y), JSON.stringify({ card, rows: rows.length, W, H }))
  const cardStyle = (await styleOf(ui, '.palette', ['transition-duration', 'animation-name']))!
  const rowAnimation = (await styleOf(ui, '.results li[role=option]', ['transition-duration', 'animation-name']))!
  check('command bar: no animation on the card or its rows (it opens in one frame)', cardStyle['animation-name'] === 'none' && /^0s(, 0s)*$/.test(cardStyle['transition-duration']!) && rowAnimation['animation-name'] === 'none' && /^0s(, 0s)*$/.test(rowAnimation['transition-duration']!), JSON.stringify({ cardStyle, rowAnimation }))
  const dim = (await styleOf(ui, '.backdrop', ['background-color']))!
  check('command bar: the page behind is not dimmed', dim['background-color'] === 'rgba(0, 0, 0, 0)', JSON.stringify(dim))

  // No hover effect: the pointer over the third line changes nothing; the arrows and the click do. The lines are the options of the list: the titles of the
  // genres ("Onglets récents", "Signets"…) are items of it too, and are not lines one can choose.
  const options = await evaluate<Rect[]>(ui, `[...document.querySelectorAll('.results li[role=option]')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })`)
  const selectedIndex = () => evaluate<number>(ui, `[...document.querySelectorAll('.results li[role=option]')].findIndex((li) => li.classList.contains('selected'))`)
  const hovered = options[2] ?? rows[2]!
  mouse(ui, 'mouseMove', hovered.x + 200, hovered.y + 20)
  await sleep(150)
  mouse(ui, 'mouseMove', hovered.x + 260, hovered.y + 24)
  await sleep(150)
  const hoverBackground = (await styleOf(ui, '.results li[role=option]', ['background-color'], 2))!['background-color']
  check('command bar: the pointer over a row does nothing (no highlight, no change of background)', options.length >= 3 && (await selectedIndex()) === 0 && hoverBackground === 'rgba(0, 0, 0, 0)', `options=${options.length} selected=${await selectedIndex()} bg=${hoverBackground}`)
  await press(ui, 'Down', 2)
  check('command bar: the arrows move the highlight', (await selectedIndex()) === 2, String(await selectedIndex()))
  await press(ui, 'Down', 8)
  const scrolled = await evaluate<{ top: number; list: Rect; row: Rect }>(ui, `(() => { const ul = document.querySelector('.results'); const li = ul.querySelector('li.selected'); const a = ul.getBoundingClientRect(); const b = li.getBoundingClientRect(); return { top: ul.scrollTop, list: { x: a.x, y: a.y, width: a.width, height: a.height }, row: { x: b.x, y: b.y, width: b.width, height: b.height } } })()`)
  check('command bar: the highlight stays inside the five-row window of the list when the arrows go further', scrolled.row.y >= scrolled.list.y - 0.5 && scrolled.row.y + scrolled.row.height <= scrolled.list.y + scrolled.list.height + 0.5, JSON.stringify(scrolled))
  const startTime = Date.now()
  await press(ui, 'Escape')
  const gone = await waitFor(() => browser.currentPanel() === null, 2000)
  check('command bar: Escape puts it away at once (no closing animation)', gone && Date.now() - startTime < 400, `${Date.now() - startTime} ms`)

  // Few answers: the card shrinks to its rows, down to the field alone.
  await openPanel({ panel: 'commandbar', mode: 'new', initial: '' }, '.palette')
  await typeText(ui, 'zqxjv')
  const small = (await rectOf(ui, '.palette'))!
  const smallRows = (await rectOf(ui, '.results'))!
  check('command bar: with one answer the card shrinks to its row and keeps its top edge', small.height < card.height && smallRows.height > 0 && near(small.y, card.y, 0.5), JSON.stringify({ small, smallRows, card }))
  browser.closeOverlay()

  // In a split view the card opens beside the middle of the window.
  await openPanel({ panel: 'commandbar', mode: 'split', initial: '' }, '.palette')
  const splitCard = (await rectOf(ui, '.palette'))!
  check('command bar in a split view: the card is inside the window', splitCard.x >= 0 && splitCard.y >= 0 && splitCard.x + splitCard.width <= W && splitCard.y + splitCard.height <= H, JSON.stringify(splitCard))
  browser.closeOverlay()

  // A white page, which stays the current tab for the panels below.
  const white = await settle('/white', 'white')
  cleanup.push(white)
  await sleep(500)

  // ---------------------------------------------------------------------------------------------------------------------------
  // Site control center, over the white page that is still the current tab
  // ---------------------------------------------------------------------------------------------------------------------------
  browser.openOverlay({ panel: 'site' })
  await waitFor(async () => (await rectOf(ui, '.scc')) !== null)
  await sleep(900)
  const scc = (await rectOf(ui, '.scc'))!
  check('site panel: the card is inside the window, at its right', scc.x >= 0 && scc.y >= 0 && scc.x + scc.width <= W && scc.x > W / 2, JSON.stringify(scc))
  // The four actions of the site, then « Traduire » and the QR code while their function is on (translation is on by default since 0.2.15).
  const tileTitles = await evaluate<string[]>(ui, `[...document.querySelectorAll('.scc-tiles .scc-tile')].map((el) => el.getAttribute('aria-label'))`)
  const wantedTiles = ['Partager', 'Retoucher ce site', 'Capturer…', 'Rechercher dans la page', ...(state().settings.translateLocal ? ['Traduire'] : []), ...(state().settings.qrCode ? ['Code QR'] : [])]
  check('site panel: the four buttons of the top row are there, then one for each web tool that is on (translation, QR code)', JSON.stringify(tileTitles) === JSON.stringify(wantedTiles), JSON.stringify({ tileTitles, wantedTiles }))
  // The panel is made of sections that fold, in the order of the panel: the blocker first, the extensions last; those of the permissions and of the Tweaks only
  // when the site has some. The panel remembers which are open.
  const sectionOrder = ['Blocage', 'Autorisations', 'Cookies et données', 'Affichage', 'Retouches', 'Extensions']
  const titles = await evaluate<string[]>(ui, `[...document.querySelectorAll('.scc-section-title')].map((el) => el.textContent)`)
  check(
    'site panel: the sections are "Blocage" first and "Extensions" last, "Cookies et données" then "Affichage" between them, in the order of the panel',
    titles[0] === 'Blocage' && titles.at(-1) === 'Extensions' && ['Cookies et données', 'Affichage'].every((title) => titles.includes(title)) && titles.every((title, i) => sectionOrder.includes(title) && (i === 0 || sectionOrder.indexOf(title) > sectionOrder.indexOf(titles[i - 1]!))),
    JSON.stringify(titles)
  )
  const sectionHead = (title: string) =>
    evaluate<(Rect & { open: boolean }) | null>(ui, `(() => { const s = [...document.querySelectorAll('.scc-section')].find((el) => el.querySelector('.scc-section-title')?.textContent === ${JSON.stringify(title)}); if (!s) return null; const h = s.querySelector('.scc-section-head'); h.scrollIntoView({ block: 'nearest' }); const r = h.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, open: s.classList.contains('open') } })()`)
  const sectionRows = (title: string) =>
    evaluate<Array<{ text: string } & Rect>>(ui, `(() => { const s = [...document.querySelectorAll('.scc-section')].find((el) => el.querySelector('.scc-section-title')?.textContent === ${JSON.stringify(title)}); return [...(s?.querySelectorAll('.scc-section-body .scc-setting') ?? [])].map((el) => { el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { text: el.querySelector('strong').textContent, x: r.x, y: r.y, width: r.width, height: r.height } }) })()`)
  // A folded section is opened by a real click on its title, and folded again at the end (what the panel remembers stays as it was).
  const unfolded: string[] = []
  const unfold = async (title: string) => {
    const head = await sectionHead(title)
    if (!head || head.open) return
    await click(ui, head.x + head.width / 2, head.y + head.height / 2)
    if (await waitFor(async () => (await sectionHead(title))?.open === true, 2000)) unfolded.push(title)
  }
  await unfold('Cookies et données')
  await unfold('Affichage')
  const dataRows = await sectionRows('Cookies et données')
  const displayRows = await sectionRows('Affichage')
  check(
    'site panel: "Affichage" starts with "Mode développeur" and holds the automatic picture in picture after it; "Effacer les données…" is in "Cookies et données"',
    displayRows[0]?.text === 'Mode développeur' && displayRows.findIndex((r) => r.text === 'Image dans l’image automatique') > 0 && dataRows.some((r) => r.text === 'Effacer les données…'),
    JSON.stringify({ display: displayRows.map((r) => r.text), data: dataRows.map((r) => r.text) })
  )
  // The "Mode développeur" row is a switch of this site. The panel scrolls inside its card: the row is brought into view before it is measured.
  const hostOfWhite = new URL(state().tabs.find((t) => t.id === white)!.url).hostname
  const clickDeveloper = async (): Promise<boolean> => {
    const script = (scroll: boolean) => `(() => { const el = [...document.querySelectorAll('.scc-setting')].find((e) => e.querySelector('strong')?.textContent === 'Mode développeur'); if (!el) return null; ${scroll ? "el.scrollIntoView({ block: 'nearest' });" : ''} const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`
    await evaluate<Rect | null>(ui, script(true))
    await sleep(150)
    const row = await evaluate<Rect | null>(ui, script(false))
    if (row) await click(ui, row.x + row.width / 2, row.y + row.height / 2)
    return row !== null
  }
  check('site panel: a click on "Mode développeur" turns it on for this site', (await clickDeveloper()) && (await waitFor(() => state().settings.developerHosts.includes(hostOfWhite))), JSON.stringify(state().settings.developerHosts))
  check('...and a second click turns it off again', (await clickDeveloper()) && (await waitFor(() => !state().settings.developerHosts.includes(hostOfWhite))), JSON.stringify(state().settings.developerHosts))
  for (const title of unfolded) {
    const head = await sectionHead(title)
    if (head?.open) await click(ui, head.x + head.width / 2, head.y + head.height / 2)
  }
  // Escape puts the card away.
  await press(ui, 'Escape')
  check('site panel: Escape closes it', await waitFor(() => browser.currentPanel() === null, 2000))
  browser.openOverlay({ panel: 'site' })
  await waitFor(async () => (await rectOf(ui, '.scc')) !== null)
  await sleep(500)
  await click(ui, 200, 500)
  check('site panel: a click outside closes it', await waitFor(() => browser.currentPanel() === null, 2000))

  // ---------------------------------------------------------------------------------------------------------------------------
  // HTTP authentication: a 401 (Basic, Digest) makes the sign-in panel appear; the credentials go to the request and nowhere else
  // ---------------------------------------------------------------------------------------------------------------------------
  const authRequest = () => {
    const current = browser.currentOverlay()
    return current?.panel === 'auth' ? current.request : null
  }
  const port = (server.address() as AddressInfo).port
  const titleOf = (id: string) => state().tabs.find((t) => t.id === id)?.title
  const openSecret = async (path: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const id = state().tabs.at(-1)!.id
    cleanup.push(id)
    return id
  }
  const basicTab = await openSecret('/secret')
  check('sign-in: a 401 with Basic makes the panel appear over the page', await waitFor(() => browser.currentPanel() === 'auth', 8000), `panel=${browser.currentPanel()}`)
  const asked = authRequest()
  check('sign-in: the panel names the server with its port, the realm and the scheme, and warns that http is not encrypted', asked?.host === `127.0.0.1:${port}` && asked.realm === 'Zone test' && asked.scheme === 'basic' && asked.secure === false, JSON.stringify(asked))
  await waitFor(async () => (await rectOf(ui, '.adlg-auth')) !== null)
  await sleep(250)
  const fields = await evaluate<Rect[]>(ui, `[...document.querySelectorAll('.adlg-field')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })`)
  const dialogText = await evaluate<string>(ui, `document.querySelector('.adlg-auth').innerText`)
  check('sign-in: the box has two fields, Annuler and Se connecter, names the server and the realm, and warns that http is not encrypted', fields.length === 2 && /Annuler/.test(dialogText) && /Se connecter/.test(dialogText) && /127\.0\.0\.1/.test(dialogText) && /Zone test/.test(dialogText) && /pas chiffrée/.test(dialogText), JSON.stringify({ fields: fields.length, dialogText }))
  check('sign-in: the field of the user name has the focus, the password is hidden', await evaluate<boolean>(ui, `document.activeElement === document.querySelector('input[name=username]') && document.querySelector('input[name=password]').type === 'password'`))
  await typeText(ui, LOGIN.user)
  await press(ui, 'Tab')
  await typeText(ui, LOGIN.password)
  await press(ui, 'Return')
  check('sign-in: Return answers the request: the page loads with the credentials and the panel is gone', (await waitFor(() => titleOf(basicTab) === 'secret ok', 8000)) && browser.currentPanel() === null, `title=${titleOf(basicTab)} panel=${browser.currentPanel()} ok=${hits.ok}`)
  const digestTab = await openSecret('/digest')
  // Over plain http a Digest answer is no protection: what is sent can be enough to find the password, and the panel says so in its own words.
  const digestAsked = (await waitFor(() => browser.currentPanel() === 'auth', 8000)) && authRequest()?.scheme === 'digest' && authRequest()?.secure === false
  await waitFor(async () => (await rectOf(ui, '.adlg-warning')) !== null)
  const digestWarning = await evaluate<string>(ui, `document.querySelector('.adlg-warning')?.innerText ?? ''`)
  check('sign-in: a 401 with Digest over http asks too, and warns that what is sent can be enough to find the password', digestAsked && /pas chiffrée/.test(digestWarning) && /retrouver/.test(digestWarning), JSON.stringify({ request: authRequest(), digestWarning }))
  await typeText(ui, LOGIN.user)
  await press(ui, 'Tab')
  await typeText(ui, LOGIN.password)
  await click(ui, ...(await (async () => { const r = (await rectOf(ui, '.adlg-confirm'))!; return [r.x + r.width / 2, r.y + r.height / 2] as const })()))
  check('sign-in: the button "Se connecter" answers a Digest challenge too', await waitFor(() => titleOf(digestTab) === 'digest ok', 8000), `title=${titleOf(digestTab)}`)
  // Cancel: Escape, or the panel put away without an answer, both give the request a refusal (the server's own 401 page shows).
  const escapeTab = await openSecret('/secret-b')
  await waitFor(() => browser.currentPanel() === 'auth', 8000)
  await press(ui, 'Escape')
  check('sign-in: Escape cancels: the page shows the server\'s refusal and the panel is gone', (await waitFor(() => titleOf(escapeTab) === 'refus 401', 8000)) && browser.currentPanel() === null, `title=${titleOf(escapeTab)} panel=${browser.currentPanel()}`)
  const closedTab = await openSecret('/secret-c')
  await waitFor(() => browser.currentPanel() === 'auth', 8000)
  browser.closeOverlay()
  check('sign-in: a panel closed without an answer is a cancellation, never a request left waiting', await waitFor(() => titleOf(closedTab) === 'refus 401', 8000), `title=${titleOf(closedTab)}`)
  // Cancel button by a real click.
  const cancelTab = await openSecret('/secret-b')
  await waitFor(() => browser.currentPanel() === 'auth', 8000)
  await sleep(250)
  const cancelButton = (await rectOf(ui, '.adlg-cancel'))!
  await click(ui, cancelButton.x + cancelButton.width / 2, cancelButton.y + cancelButton.height / 2)
  check('sign-in: the "Annuler" button cancels too', (await waitFor(() => titleOf(cancelTab) === 'refus 401', 8000)) && browser.currentPanel() === null)
  /**
   * The overlay draws the box of `realm` and has run what follows its drawing. The state of the main process names the next request a moment before
   * the box can answer it: its listener of Escape is set in an effect, after the render, for the id of its request. An Escape sent in between
   * reaches the listener of the box before (whose answer is ignored, it was given), and the request shown is never answered.
   */
  const authBoxOf = async (realm: string): Promise<boolean> => {
    const shown = await waitFor(async () => (await evaluate<boolean>(ui, `(document.querySelector('.adlg-auth')?.innerText ?? '').includes(${JSON.stringify(realm)})`)), 8000)
    // The effects of the render are run in a task of their own: one more task of the page, and they are done.
    await evaluate(ui, 'new Promise((done) => setTimeout(done, 0))')
    return shown
  }
  // One question at a time per page: three requests of one page, for the realms d, e and d again.
  const pageTab = await openSecret('/fetches')
  await waitFor(() => browser.currentPanel() === 'auth', 8000)
  const first = authRequest()
  // The witness: the three requests of the page have reached the shell, which holds each one behind the one before it (browser-dialogs.ts, `authenticate`).
  const waitingOfPage = () => (browser as unknown as { authPages: Map<string, { pending: number }> }).authPages.get(pageTab)?.pending ?? 0
  await waitFor(() => waitingOfPage() === 3, 8000)
  check('sign-in: one panel at a time for a page that has several requests waiting (the first realm is asked first)', first?.realm === 'Zone d' && authRequest()?.id === first.id, JSON.stringify({ first, now: authRequest(), waiting: waitingOfPage() }))
  await authBoxOf('Zone d')
  await press(ui, 'Escape')
  check('sign-in: after a refusal the next realm is asked', (await waitFor(() => browser.currentPanel() === 'auth' && authRequest()?.realm === 'Zone e', 8000)) && (await authBoxOf('Zone e')), JSON.stringify(authRequest()))
  await press(ui, 'Escape')
  await sleep(1500)
  const page = allWebContents.getAllWebContents().find((w) => w.getURL() === `${base}/fetches`)
  const done = page ? await evaluate<string[]>(page, `window.__done`) : []
  check('sign-in: the third request, for the realm already refused, is not asked again, and all three end', browser.currentPanel() === null && done.length === 3, `panel=${browser.currentPanel()} done=${JSON.stringify(done)}`)
  if (page) void evaluate(page, `fetch('/secret-d').then(() => {})`)
  check('sign-in: a later request for that realm is a new question', (await waitFor(() => browser.currentPanel() === 'auth' && authRequest()?.realm === 'Zone d', 8000)) && (await authBoxOf('Zone d')))
  await press(ui, 'Escape')
  await waitFor(() => browser.currentPanel() === null)
  // A shell that fails to ask is a refusal for the page, and the failure is logged without the credentials.
  const realAuthenticate = browser.authenticate.bind(browser)
  browser.authenticate = () => Promise.reject(new Error('the panel could not be shown'))
  const brokenTab = await openSecret('/secret-e')
  check('sign-in: when the panel cannot be shown the request is refused (the page shows the server\'s 401) and the failure is logged', (await waitFor(() => titleOf(brokenTab) === 'refus 401', 8000)) && logged.some((line) => /cannot ask for a login: the panel could not be shown/.test(line)), `title=${titleOf(brokenTab)}`)
  browser.authenticate = realAuthenticate
  // Closing a tab whose request waits cancels it.
  const doomed = await openSecret('/secret-e')
  await waitFor(() => browser.currentPanel() === 'auth', 8000)
  browser.dispatch({ type: 'tab/close', id: doomed })
  check('sign-in: closing the tab that waits for a login takes the panel away', await waitFor(() => browser.currentPanel() === null, 4000), `panel=${browser.currentPanel()}`)
  void pageTab
  // The credentials are nowhere: not in a log, not in the state, not in the history, not on disk.
  store.flush()
  const userData = app.getPath('userData')
  const onDisk: string[] = []
  const scan = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      let info
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) scan(path)
      else if (info.size < 64 * 1024 * 1024 && readFileSync(path).includes(LOGIN.password)) onDisk.push(path)
    }
  }
  scan(userData)
  check('sign-in: the password is in no log, no state, no file of the profile', !logged.some((line) => line.includes(LOGIN.password)) && !JSON.stringify(state()).includes(LOGIN.password) && onDisk.length === 0, JSON.stringify({ onDisk, logged: logged.filter((l) => l.includes(LOGIN.password)).length }))
  check('sign-in: the address of the tab does not carry the login', state().tabs.find((t) => t.id === basicTab)?.url === `${base}/secret`)

  // ---------------------------------------------------------------------------------------------------------------------------
  // mailto: and tel: links: handed to the system on a click, nothing else ever
  // ---------------------------------------------------------------------------------------------------------------------------
  ;(shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
    opened.push(url)
  }
  const linksTab = await openSecret('/links')
  await waitFor(() => titleOf(linksTab) === 'links', 8000)
  await sleep(500)
  const linkPage = allWebContents.getAllWebContents().find((w) => w.getURL() === `${base}/links`)!
  const clickIn = async (selector: string, inFrame = false) => {
    const r = await evaluate<Rect | null>(linkPage, inFrame
      ? `(() => { const f = document.getElementById('frame').getBoundingClientRect(); return { x: f.x + 100, y: f.y + 20, width: 1, height: 1 } })()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: 1, height: 1 } })()`)
    await click(linkPage, r!.x, r!.y)
    await sleep(400)
  }
  await clickIn('#mail')
  check('links: a click on a mailto: link hands it to the system, once', opened.length === 1 && opened[0] === 'mailto:ada@example.com?subject=Bonjour', JSON.stringify(opened))
  await clickIn('#tel')
  check('links: a click on a tel: link too', opened.length === 2 && opened[1] === 'tel:+33123456789', JSON.stringify(opened))
  await clickIn('#file')
  await clickIn('#ssh')
  await clickIn('#custom')
  check('links: file:, ssh: and a system-settings scheme are never handed over', opened.length === 2, JSON.stringify(opened))
  await clickIn('#blank')
  check('links: a mailto: link that opens in a new window goes to the system too', opened.length === 3 && opened[2] === 'mailto:blank@example.com', JSON.stringify(opened))
  await clickIn('', true)
  check('links: a mailto: link inside a frame of the page too', opened.length === 4 && opened[3] === 'mailto:inner@example.com', JSON.stringify(opened))
  check('links: the tab stayed where it was', state().tabs.find((t) => t.id === linksTab)?.url === `${base}/links`)
  await sleep(1700)
  void evaluate(linkPage, `location.href = 'mailto:script@example.com'`)
  // The witness: the line the engine writes as it refuses the link (electron-page.ts, `openExternalLink`).
  await waitFor(() => logged.some((line) => /ignored a mailto: link that no click explains/.test(line)))
  check('links: a script that navigates to mailto: without any click opens nothing', opened.length === 4 && logged.some((line) => /ignored a mailto: link that no click explains/.test(line)), JSON.stringify(opened))
  check('links: no log carries an address', !logged.some((line) => /@example\.com|\+33123456789/.test(line)))
  // A failure is told to the user, with the scheme alone.
  ;(shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async () => {
    throw new Error('no application for this link')
  }
  await clickIn('#mail')
  check('links: when the system cannot open the link, a notice says so (the scheme, not the address)', await waitFor(() => /mailto:/.test(browser.snapshot().toast?.message ?? '') && !/@/.test(browser.snapshot().toast?.message ?? ''), 3000), JSON.stringify(browser.snapshot().toast))
  ;(shell as unknown as { openExternal: typeof realOpenExternal }).openExternal = realOpenExternal

  // ---------------------------------------------------------------------------------------------------------------------------
  // Mini window: the first state (the command bar alone), then the page window and its shortcuts
  // ---------------------------------------------------------------------------------------------------------------------------
  const littleWc = (id: string, kind: 'header' | 'page') => allWebContents.getAllWebContents().find((w) => (kind === 'header' ? w.getURL().includes('littlearc') && w.getURL().includes(`id=${id}`) && !w.getURL().includes('picker') : w.getURL().startsWith(`${base}/little`)))
  const key = (wc: WebContents, keyCode: string, modifiers: Array<'meta' | 'shift' | 'alt'>) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const barId = little.openBar()
  const barWc = await (async () => {
    for (let i = 0; i < 80; i++) {
      const wc = littleWc(barId, 'header')
      if (wc && (await rectOf(wc, '.palette').catch(() => null))) return wc
      await sleep(100)
    }
    return undefined
  })()
  const barWin = barWc ? ElectronWindow.fromWebContents(barWc) : null
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  await sleep(500)
  const barBounds = barWin?.getBounds()
  check('little: the window of the first state opens inside the screen', !!barBounds && barBounds.x >= area.x && barBounds.y >= area.y && barBounds.x + barBounds.width <= area.x + area.width && barBounds.y + barBounds.height <= area.y + area.height, JSON.stringify({ barBounds, area }))
  // A mini window opens in the middle of the work area of the screen (PR #13): the centre of the card is the centre of the work area, to a pixel of rounding.
  check('little: the window of the first state opens in the middle of the work area', !!barBounds && near(barBounds.x + barBounds.width / 2, area.x + area.width / 2, 2) && near(barBounds.y + barBounds.height / 2, area.y + area.height / 2, 2), JSON.stringify({ barBounds, area }))
  check('little: the window of the first state is not resizable and has no page yet', !!barWin && barWin.isResizable() === false && little.states().find((st) => st.id === barId)?.bar === true && littleWc(barId, 'page') === undefined)
  const barParts = barWc ? await evaluate<{ input: boolean; close: boolean; rows: number }>(barWc, `({ input: !!document.querySelector('.palette-input'), close: !!document.querySelector('.palette-close'), rows: document.querySelectorAll('.results li[role="option"]').length })`) : null
  check('little: the first state shows the field, the close button and a list of answers', !!barParts && barParts.input && barParts.close && barParts.rows > 0, JSON.stringify(barParts))
  // Typing an address and Return: the window grows to hold the page, around its centre (it used to keep its top and right edge: a window opened in the middle of the
  // screen stays in the middle, and one the user moved stays where they put it).
  if (barWc && barBounds) {
    await typeText(barWc, `${base}/little-a`)
    await press(barWc, 'Return')
    check('little: Return on an address loads the page in the same window and the window leaves its first state', await waitFor(() => little.states().find((st) => st.id === barId)?.bar === false && little.states().find((st) => st.id === barId)?.url === `${base}/little-a`, 8000), JSON.stringify(little.states().find((st) => st.id === barId)))
    await sleep(600)
    const grown = barWin!.getBounds()
    const centre = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
    // The centre moves by half a pixel at most (the new origin is rounded), and the grown window stays inside the work area: the bar is in its middle, so nothing pushes it.
    const insideArea = grown.x >= area.x && grown.y >= area.y && grown.x + grown.width <= area.x + area.width && grown.y + grown.height <= area.y + area.height
    check('little: it grew around its centre: same centre, larger on every side, inside the work area, and now resizable', grown.width > barBounds.width && grown.height > barBounds.height && near(centre(grown).x, centre(barBounds).x, 1) && near(centre(grown).y, centre(barBounds).y, 1) && grown.x < barBounds.x && grown.y < barBounds.y && insideArea && barWin!.isResizable(), JSON.stringify({ grown, barBounds, area }))
    const header = await rectOf(barWc, '.la-header')
    check('little: then the header shows, with the page below it', !!header && header.height > 0, JSON.stringify(header))
    // The shortcuts, with the focus in the page.
    const pageWc = littleWc(barId, 'page')
    check('little: the page of the window is its own (not a tab of the main window)', !!pageWc && !state().tabs.some((t) => t.url === `${base}/little-a`), String(pageWc?.getURL()))
    if (pageWc) {
      const hitsBefore = hits.little
      key(pageWc, 'r', ['meta'])
      check('little: ⌘R in the page reloads that page, not the main window\'s', await waitFor(() => hits.little === hitsBefore + 1, 4000), `hits ${hitsBefore} -> ${hits.little}`)
      const link = (await evaluate<Rect>(pageWc, `(() => { const r = document.getElementById('next').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20, width: 1, height: 1 } })()`))
      await click(pageWc, link.x, link.y)
      check('little: a link of the page stays in the window', await waitFor(() => little.states().find((st) => st.id === barId)?.url === `${base}/little-b`, 5000), JSON.stringify(little.states().find((st) => st.id === barId)))
      key(pageWc, '[', ['meta'])
      check('little: ⌘[ goes back', await waitFor(() => little.states().find((st) => st.id === barId)?.url === `${base}/little-a`, 5000), JSON.stringify(little.states().find((st) => st.id === barId)))
      key(pageWc, ']', ['meta'])
      check('little: ⌘] goes forward', await waitFor(() => little.states().find((st) => st.id === barId)?.url === `${base}/little-b`, 5000), JSON.stringify(little.states().find((st) => st.id === barId)))
      await clipboard.writeText('rien')
      key(pageWc, 'c', ['meta', 'shift'])
      check('little: ⇧⌘C copies the address of the window\'s page', await waitFor(async () => (await clipboard.readText()) === `${base}/little-b`, 3000), await clipboard.readText())
      check('little: ...and the header shows its tick for a moment', await waitFor(async () => (await evaluate<boolean>(barWc, `!!document.querySelector('.la-copy svg path[d^="m3 8.500"]')`)) === true, 3000))
      const mainTabs = state().tabs.length
      key(pageWc, 'o', ['meta'])
      check('little: ⌘O opens the page as a tab of the main window and puts the mini window away', await waitFor(() => state().tabs.length === mainTabs + 1 && state().tabs.at(-1)?.url === `${base}/little-b` && little.states().every((st) => st.id !== barId), 6000), JSON.stringify({ tabs: state().tabs.length, was: mainTabs, last: state().tabs.at(-1)?.url }))
      cleanup.push(state().tabs.at(-1)!.id)
    }
  }
  // Escape in the first state closes the window; nothing was archived (no page was loaded).
  const barId2 = little.openBar()
  const barWc2 = await (async () => {
    for (let i = 0; i < 80; i++) {
      const wc = littleWc(barId2, 'header')
      if (wc && (await rectOf(wc, '.palette').catch(() => null))) return wc
      await sleep(100)
    }
    return undefined
  })()
  const archiveBefore = state().archive.length
  if (barWc2) {
    await sleep(300)
    await press(barWc2, 'Escape')
  }
  check('little: Escape in the first state closes the window, and nothing is archived', await waitFor(() => little.states().every((st) => st.id !== barId2), 4000) && state().archive.length === archiveBefore, JSON.stringify(little.states()))
  const barId3 = little.openBar()
  const barWc3 = await (async () => {
    for (let i = 0; i < 80; i++) {
      const wc = littleWc(barId3, 'header')
      if (wc && (await rectOf(wc, '.palette').catch(() => null))) return wc
      await sleep(100)
    }
    return undefined
  })()
  if (barWc3) {
    await sleep(300)
    const closeBox = (await rectOf(barWc3, '.palette-close'))!
    await click(barWc3, closeBox.x + 13, closeBox.y + 13)
  }
  check('little: the close button of the first state closes the window', await waitFor(() => little.states().every((st) => st.id !== barId3), 4000), JSON.stringify(little.states()))
  // The downloads tray of a mini window: the files its page downloaded, over the page at the bottom of the window.
  const downloadsFolder = mkdtempSync(join(tmpdir(), 'iso-little-downloads-'))
  const profilesBefore = state().settings.profiles
  browser.dispatch({ type: 'settings/update', patch: { profiles: { ...profilesBefore, default: { ...profilesBefore['default'], downloadDir: downloadsFolder } } } })
  const trayId = little.openBar()
  const trayHeader = await (async () => {
    for (let i = 0; i < 80; i++) {
      const wc = littleWc(trayId, 'header')
      if (wc && (await rectOf(wc, '.palette').catch(() => null))) return wc
      await sleep(100)
    }
    return undefined
  })()
  const trayWin = trayHeader ? ElectronWindow.fromWebContents(trayHeader) : null
  const trayView = () => trayWin?.contentView.children.find((v) => (v as unknown as { webContents?: WebContents }).webContents?.getURL().includes('tray=1')) as unknown as { webContents: WebContents; getBounds(): Rect } | undefined
  if (trayHeader) {
    // The keys go to the field of the bar once it has the focus; what was typed is read back before Return (a key sent too early is lost, and Return
    // would then open the first proposal instead of the page of the test).
    await waitFor(() => evaluate<boolean>(trayHeader, `document.activeElement === document.querySelector('.palette-input')`).catch(() => false), 4000)
    await typeText(trayHeader, `${base}/little-dl`)
    await waitFor(() => evaluate<boolean>(trayHeader, `document.querySelector('.palette-input')?.value === ${JSON.stringify(`${base}/little-dl`)}`).catch(() => false), 2000)
    await press(trayHeader, 'Return')
    await waitFor(() => little.states().find((st) => st.id === trayId)?.bar === false, 8000)
    await waitFor(() => little.states().find((st) => st.id === trayId)?.url === `${base}/little-dl`, 8000)
    await sleep(300)
  }
  check('little tray: no tray while the page has downloaded nothing', !!trayWin && trayView() === undefined && (little.states().find((st) => st.id === trayId)?.downloads.length ?? 1) === 0)
  // The page of this window by its own address: the pages of the windows before it (/little-a, /little-b) may still be live, one of them as a tab of the main window.
  const trayPage = allWebContents.getAllWebContents().find((w) => w.getURL() === `${base}/little-dl`)
  const openedPaths: string[] = []
  const revealed: string[] = []
  const realReveal = shell.showItemInFolder
  const realOpenPath = shell.openPath
  ;(shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = (p: string) => void revealed.push(p)
  ;(shell as unknown as { openPath: (p: string) => Promise<string> }).openPath = async (p: string) => {
    openedPaths.push(p)
    return ''
  }
  if (trayPage) {
    // The page of the window may still be loading when its bar has gone: its link is waited for (a run once reached it before it existed).
    await waitFor(() => evaluate<boolean>(trayPage, `!!document.getElementById('dl')`).catch(() => false), 8000)
    const link = await evaluate<Rect | null>(trayPage, `(() => { const el = document.getElementById('dl'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20, width: 1, height: 1 } })()`)
    if (link) await click(trayPage, link.x, link.y)
  }
  const trayPageUrl = little.states().find((st) => st.id === trayId)?.url
  check('little tray: a download started by the page of the window is listed for that window', await waitFor(() => little.states().find((st) => st.id === trayId)?.downloads.some((d) => d.filename === 'little-smoke.bin' && d.state === 'completed') === true, 10_000), `${JSON.stringify(little.states().find((st) => st.id === trayId)?.downloads)} page ${trayPageUrl}`)
  check('little tray: ...and by no other window', little.states().filter((st) => st.id !== trayId).every((st) => st.downloads.length === 0))
  await waitFor(() => trayView() !== undefined, 4000)
  await sleep(600)
  const tray = trayView()
  const windowSize = trayWin ? trayWin.getContentBounds() : { width: 0, height: 0 }
  const trayBox = tray?.getBounds()
  check('little tray: the card is in the bottom left corner of the window, over the page', !!trayBox && trayBox.x >= 0 && trayBox.x < windowSize.width / 2 && trayBox.y > windowSize.height / 2 && trayBox.y + trayBox.height <= windowSize.height, JSON.stringify({ trayBox, windowSize }))
  const trayRow = tray ? await evaluate<{ name: string; status: string; buttons: number } | null>(tray.webContents, `(() => { const row = document.querySelector('.lt-row'); return row ? { name: row.querySelector('.lt-name').textContent, status: row.querySelector('.lt-status').textContent, buttons: row.querySelectorAll('.lt-btn').length } : null })()`) : null
  check('little tray: the row names the file and its size, with reveal, open and remove', trayRow?.name === 'little-smoke.bin' && trayRow.status === frenchSpaces('4 Ko') && trayRow.buttons === 3, JSON.stringify(trayRow))
  check('little tray: the main window\'s list of downloads has the file too', browser.snapshot().downloads.some((d) => d.filename === 'little-smoke.bin'))
  if (tray) {
    const buttons = await evaluate<Rect[]>(tray.webContents, `[...document.querySelectorAll('.lt-btn')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })`)
    await click(tray.webContents, buttons[0]!.x + 13, buttons[0]!.y + 13)
    check('little tray: "Afficher dans le Finder" reveals the file', await waitFor(() => revealed.length === 1 && revealed[0]!.startsWith(downloadsFolder) && revealed[0]!.endsWith('little-smoke.bin'), 3000), JSON.stringify(revealed))
    await click(tray.webContents, buttons[1]!.x + 13, buttons[1]!.y + 13)
    check('little tray: "Ouvrir" opens it', await waitFor(() => openedPaths.length === 1 && openedPaths[0]!.endsWith('little-smoke.bin'), 3000), JSON.stringify(openedPaths))
    await click(tray.webContents, buttons[2]!.x + 13, buttons[2]!.y + 13)
    check('little tray: the cross takes the file out of the tray, which goes away with its last file', (await waitFor(() => trayView() === undefined, 3000)) && little.states().find((st) => st.id === trayId)?.downloads.length === 0)
  }
  ;(shell as unknown as { showItemInFolder: typeof realReveal }).showItemInFolder = realReveal
  ;(shell as unknown as { openPath: typeof realOpenPath }).openPath = realOpenPath
  little.close(trayId)
  await waitFor(() => little.count() === 0, 4000)
  browser.dispatch({ type: 'settings/update', patch: { profiles: profilesBefore } })
  rmSync(downloadsFolder, { recursive: true, force: true })

  // Nothing typed, nothing opened: an empty request from the window's UI loads no page.
  const barId4 = little.openBar()
  const barWc4 = await (async () => {
    for (let i = 0; i < 80; i++) {
      const wc = littleWc(barId4, 'header')
      if (wc && (await rectOf(wc, '.palette').catch(() => null))) return wc
      await sleep(100)
    }
    return undefined
  })()
  if (barWc4) {
    for (const input of ['', '   ', '\t']) await evaluate(barWc4, `window.lucium.littleAction(${JSON.stringify(barId4)}, ${JSON.stringify(`go:${input}`)})`)
    await sleep(800)
  }
  check('little: an empty request from the first state loads no page and leaves the window as it is', little.states().find((st) => st.id === barId4)?.bar === true && little.states().find((st) => st.id === barId4)?.url === '', JSON.stringify(little.states().find((st) => st.id === barId4)))
  little.close(barId4)
  // New Mini Window in the menu asks for the bar in "little" mode: it must open that window, not a panel over the main one.
  const littleBefore = little.count()
  browser.openOverlay({ panel: 'commandbar', mode: 'little', initial: '' })
  check('little: the menu entry for a new mini window opens that window, not a panel of the main window', (await waitFor(() => little.count() === littleBefore + 1, 4000)) && browser.currentPanel() === null, `count=${little.count()} panel=${browser.currentPanel()}`)
  for (const st of little.states()) little.close(st.id)
  await waitFor(() => little.count() === 0, 4000)

  // ---------------------------------------------------------------------------------------------------------------------------
  // Tweak editor and Eraser mode
  // ---------------------------------------------------------------------------------------------------------------------------
  const zapHost = new URL(base).hostname
  const zapTab = await openSecret('/zapmode')
  await waitFor(() => titleOf(zapTab) === 'zapmode', 8000)
  await sleep(600)
  const zapTweaks = () => state().boosts.filter((b) => b.host === zapHost).forEach((b) => browser.dispatch({ type: 'boost/delete', id: b.id }))
  zapTweaks()
  atEnd(zapTweaks)
  await openPanel({ panel: 'boost', host: zapHost }, '.bx')
  const bxCard = (await rectOf(ui, '.bx-card'))!
  check('boost editor: the header (Done, name, tabs, Undo), the colour pad with its tools, the font card, Size, Case and Eraser, and the foot are all there', await evaluate<boolean>(ui, `['.bx-done', '.bx-title', '.bx-tabs', '.bx-undo', '.bx-pad', '.bx-tool', '.bx-fonts', '.bx-size', '.bx-case', '.bx-zap', '.bx-state'].every((selector) => !!document.querySelector(selector))`) && bxCard.width > 0)
  // The ten fonts Lucium adds make thirty: the card keeps its box and scrolls, with a fade while there is more.
  const fontGrid = await evaluate<{ cells: number; scrolls: boolean; overflow: string; more: string | undefined; hitOnSize: boolean; box: Rect }>(ui, `(() => { const g = document.querySelector('.bx-fonts'); const s = document.querySelector('.bx-size').getBoundingClientRect(); const hit = document.elementFromPoint(s.x + s.width / 2, s.y + s.height / 2); const b = g.getBoundingClientRect(); return { cells: g.querySelectorAll('.bx-font').length, scrolls: g.scrollHeight > g.clientHeight, overflow: getComputedStyle(g).overflowY, more: g.dataset.more, hitOnSize: !!hit && !!hit.closest('.bx-size'), box: { x: b.x, y: b.y, width: b.width, height: b.height } } })()`)
  check('boost editor: thirty fonts in the card: it scrolls, fades while there is more, and nothing of it covers the Size button', fontGrid.cells === 30 && fontGrid.scrolls && fontGrid.overflow === 'auto' && fontGrid.more === 'true' && fontGrid.hitOnSize, JSON.stringify(fontGrid))
  const gridCentre = { x: fontGrid.box.x + fontGrid.box.width / 2, y: fontGrid.box.y + fontGrid.box.height / 2 }
  ui.sendInputEvent({ type: 'mouseMove', x: Math.round(gridCentre.x), y: Math.round(gridCentre.y) })
  for (let i = 0; i < 6; i++) {
    ui.sendInputEvent({ type: 'mouseWheel', x: Math.round(gridCentre.x), y: Math.round(gridCentre.y), deltaX: 0, deltaY: -240 })
    await sleep(60)
  }
  await sleep(500)
  const fontsScrolled = await evaluate<{ top: number; more: string | undefined; lastInside: boolean }>(ui, `(() => { const g = document.querySelector('.bx-fonts'); const last = g.querySelector('.bx-font:last-child').getBoundingClientRect(); const b = g.getBoundingClientRect(); return { top: g.scrollTop, more: g.dataset.more, lastInside: last.top >= b.top && last.bottom <= b.bottom + 0.5 } })()`)
  check('boost editor: a real wheel over the card brings the last fonts into it, and the fade goes', fontsScrolled.top > 0 && fontsScrolled.more === 'false' && fontsScrolled.lastInside, JSON.stringify(fontsScrolled))
  const lastFont = (await rectOf(ui, '.bx-font:last-child'))!
  const fontName = 'boost editor: a click on the last font (Atkinson Hyperlegible Next) chooses it, and a second click gives the page its own font back'
  // A font the card does not show is not clicked: the click would land on the control drawn there (Case, which turned a Tweak to capitals in a run).
  if (!fontsScrolled.lastInside) check(fontName, false, 'not measured: the last font is not inside the card, so a click at its place would reach another control')
  else {
    await click(ui, lastFont.x + lastFont.width / 2, lastFont.y + lastFont.height / 2)
    check(fontName, (await evaluate<boolean>(ui, `document.querySelector('.bx-font:last-child').getAttribute('aria-pressed') === 'true'`)) && (await (async () => { await click(ui, lastFont.x + lastFont.width / 2, lastFont.y + lastFont.height / 2); return evaluate<boolean>(ui, `document.querySelector('.bx-font:last-child').getAttribute('aria-pressed') === 'false'`) })()))
  }
  await evaluate(ui, `document.querySelector('.bx-fonts').scrollTop = 0`)
  // The Eraser mode: the Eraser button of the editor, a real click.
  const zapButton = (await rectOf(ui, '.bx-zap'))!
  await click(ui, zapButton.x + zapButton.width / 2, zapButton.y + zapButton.height / 2)
  check('zap: the editor stays but its layer shrinks to the panel, so the page can be clicked', await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap === true, 4000))
  await sleep(600)
  const layer = overlayView.getBounds()
  check('zap: the layer is the panel and the margin of its shadow, nothing of the page around it', layer.width < 520 && layer.height < H && layer.x > W / 2, JSON.stringify(layer))
  const zapPanel = (await rectOf(ui, '.bx'))!
  check('zap: the panel keeps its size and its place on the window, and its Eraser button is pressed', near(zapPanel.width, bxCard.width) && near(layer.x + zapPanel.x + zapPanel.width, bxCard.x + bxCard.width) && (await evaluate<boolean>(ui, `document.querySelector('.bx-zap').getAttribute('aria-pressed') === 'true'`)), JSON.stringify({ zapPanel, layer, bxCard }))
  const zapWc = allWebContents.getAllWebContents().find((w) => w.getURL() === `${base}/zapmode`)!
  const zapPixels = async () => {
    const image = await zapWc.capturePage()
    const size = image.getSize()
    const bitmap = image.toBitmap()
    // The picture has a pixel per device pixel (twice the size of the page on a Retina screen): the points are given in the page's pixels.
    const scale = size.width / (await evaluate<number>(zapWc, 'innerWidth'))
    return (x: number, y: number) => {
      const px = Math.round(x * scale)
      const py = Math.round(y * scale)
      return hex(bitmap[(py * size.width + px) * 4 + 2]!, bitmap[(py * size.width + px) * 4 + 1]!, bitmap[(py * size.width + px) * 4]!)
    }
  }
  let zp = await zapPixels()
  const pageSize = await evaluate<{ w: number; h: number }>(zapWc, `({ w: innerWidth, h: innerHeight })`)
  check('zap: the page shows a blue frame on its edges while erasing (and not inside)', dist(zp(1, 200), ZAP_BLUE) <= 4 && dist(zp(pageSize.w - 2, 200), ZAP_BLUE) <= 4 && dist(zp(300, 1), ZAP_BLUE) <= 4 && dist(zp(300, 200), '#ffffff') <= 2, JSON.stringify({ left: zp(1, 200), right: zp(pageSize.w - 2, 200), top: zp(300, 1), inside: zp(300, 200) }))
  const clickPage = async (selector: string) => {
    // A page that was followed away from (the picker did not swallow the click) has no such element any more: the checks below say so.
    const r = await evaluate<Rect | null>(zapWc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20, width: 1, height: 1 } })()`).catch(() => null)
    if (r) await click(zapWc, r.x, r.y)
  }
  await clickPage('#a')
  await clickPage('#lnk')
  const hiddenNow = await evaluate<string[]>(zapWc, `['a', 'b', 'lnk'].map((id) => document.getElementById(id) ? getComputedStyle(document.getElementById(id)).display : 'missing')`).catch(() => ['error'])
  check('zap: a click hides the element at once, a link is picked rather than followed, and what was not clicked stays', hiddenNow[0] === 'none' && hiddenNow[2] === 'none' && hiddenNow[1] !== 'none' && zapWc.getURL() === `${base}/zapmode`, JSON.stringify({ hiddenNow, url: zapWc.getURL() }))
  await clickPage('#b')
  // "Terminé", bottom right of the page: 10 px from the frame's corner.
  await click(zapWc, pageSize.w - 10 - 30, pageSize.h - 10 - 19)
  check('zap: "Terminé" ends the mode: the editor is back at its full layer with the picked elements in the Tweak', (await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap !== true && browser.currentPanel() === 'boost', 4000)) && (await waitFor(() => (state().boosts.find((b) => b.host === zapHost)?.zap.length ?? 0) === 3, 4000)), JSON.stringify(state().boosts.find((b) => b.host === zapHost)?.zap))
  const picks = state().boosts.find((b) => b.host === zapHost)!.zap
  check('zap: the selectors are the elements\' ids, in click order', JSON.stringify(picks) === JSON.stringify(['#a', '#lnk', '#b']), JSON.stringify(picks))
  await sleep(500)
  zp = await zapPixels()
  const hiddenAfter = await evaluate<string[]>(zapWc, `['a', 'b', 'lnk'].map((id) => getComputedStyle(document.getElementById(id)).display)`)
  check('zap: the frame is gone and the Tweak now hides the three elements', dist(zp(1, 200), ZAP_BLUE) > 20 && hiddenAfter.every((d) => d === 'none'), JSON.stringify({ edge: zp(1, 200), hiddenAfter }))
  const fullLayer = overlayView.getBounds()
  check('zap: the layer is the whole window again', near(fullLayer.width, W) && near(fullLayer.height, H), JSON.stringify(fullLayer))
  // The Eraser button of the editor, pressed, leaves the mode.
  const zapStart = (await rectOf(ui, '.bx-zap'))!
  await click(ui, zapStart.x + zapStart.width / 2, zapStart.y + zapStart.height / 2)
  await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap === true, 4000)
  await sleep(500)
  const zapPressed = (await rectOf(ui, '.bx-zap'))!
  await click(ui, zapPressed.x + zapPressed.width / 2, zapPressed.y + zapPressed.height / 2)
  check('zap: the Eraser button, pressed, leaves the mode: the editor comes back whole and the frame leaves the page', (await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap !== true && browser.currentPanel() === 'boost', 4000)) && near(overlayView.getBounds().width, W) && (await waitFor(async () => dist((await zapPixels())(1, 200), ZAP_BLUE) > 20, 3000)), JSON.stringify(browser.currentOverlay()))
  await sleep(300)
  // Escape in the page ends the mode too; closing the editor ends it and puts the page back.
  const boostId2 = state().boosts.find((b) => b.host === zapHost)!.id
  const zapButton2 = (await rectOf(ui, '.bx-zap'))!
  await click(ui, zapButton2.x + zapButton2.width / 2, zapButton2.y + zapButton2.height / 2)
  await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap === true, 4000)
  await sleep(500)
  key(zapWc, 'Escape', [])
  check('zap: Escape in the page ends the mode', await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap !== true && browser.currentPanel() === 'boost', 4000))
  await sleep(300)
  const zapButton3 = (await rectOf(ui, '.bx-zap'))!
  await click(ui, zapButton3.x + zapButton3.width / 2, zapButton3.y + zapButton3.height / 2)
  await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap === true, 4000)
  await sleep(500)
  zp = await zapPixels()
  const frameOn = dist(zp(1, 200), ZAP_BLUE) <= 4
  const doneBox = (await rectOf(ui, '.bx-done'))!
  await click(ui, doneBox.x + 20, doneBox.y + 20)
  check('zap: closing the editor while erasing ends the mode, puts the page back and closes everything', frameOn && (await waitFor(() => browser.currentPanel() === null, 4000)) && (await waitFor(async () => dist((await zapPixels())(1, 200), ZAP_BLUE) > 20, 3000)))
  // A page that leaves while the user erases ends the mode: the editor comes back, and the Eraser mode can start again.
  await openPanel({ panel: 'boost', host: zapHost, id: boostId2 }, '.bx')
  const zapButton4 = (await rectOf(ui, '.bx-zap'))!
  await click(ui, zapButton4.x + zapButton4.width / 2, zapButton4.y + zapButton4.height / 2)
  await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap === true, 4000)
  await sleep(400)
  void evaluate(zapWc, `location.href = '/zapmode-next'`)
  check('zap: a page that navigates away ends the mode and the editor comes back', await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap !== true && browser.currentPanel() === 'boost', 6000), JSON.stringify(browser.currentOverlay()))
  // A script that cannot run is an error that is logged, and the editor still comes back.
  const zapPage = browser.pageFor(zapTab)!
  const realEvaluate = zapPage.evaluate.bind(zapPage)
  zapPage.evaluate = () => Promise.reject(new Error('the page refused the script'))
  await sleep(500)
  const zapButton5 = (await rectOf(ui, '.bx-zap'))!
  await click(ui, zapButton5.x + zapButton5.width / 2, zapButton5.y + zapButton5.height / 2)
  check('zap: when the page cannot run the picker, the failure is logged and the editor comes back', (await waitFor(() => logged.some((line) => /\[boost\] the Eraser ended with an error: the page refused the script/.test(line)), 6000)) && (await waitFor(() => (browser.currentOverlay() as { zap?: boolean } | null)?.zap !== true && browser.currentPanel() === 'boost', 4000)), JSON.stringify(browser.currentOverlay()))
  zapPage.evaluate = realEvaluate
  browser.closeOverlay()
  state().boosts.filter((b) => b.id === boostId2).forEach((b) => browser.dispatch({ type: 'boost/delete', id: b.id }))

  // ---------------------------------------------------------------------------------------------------------------------------
  // Downloads popover, error pages and reader mode: the same dark glass, the same page colours in both appearances
  // ---------------------------------------------------------------------------------------------------------------------------
  browser.dispatch({ type: 'tab/select', id: white })
  await sleep(400)
  await openPanel({ panel: 'downloads' }, '.dlpop')
  await sleep(300)
  const dl = (await rectOf(ui, '.dlpop'))!
  check('downloads: the popover opens inside the window, above the downloads button', dl.x >= 0 && dl.y >= 0 && dl.x + dl.width <= W && dl.y + dl.height < H - 40, JSON.stringify({ dl, W, H }))
  await press(ui, 'Escape')
  await waitFor(() => browser.currentPanel() === null, 3000)
  const themeBefore = nativeTheme.themeSource
  const refusedPort = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port
      probe.close(() => resolve(p))
    })
  })
  browser.dispatch({ type: 'tab/open', url: `http://127.0.0.1:${refusedPort}/` })
  const refusedTab = state().tabs.at(-1)!.id
  cleanup.push(refusedTab)
  const errorWc = await (async () => {
    for (let i = 0; i < 80; i++) {
      const wc = allWebContents.getAllWebContents().find((w) => w.getURL().startsWith(`http://127.0.0.1:${refusedPort}/`))
      if (wc && (await evaluate<boolean>(wc, `!!document.querySelector('a.button')`).catch(() => false))) return wc
      await sleep(150)
    }
    return undefined
  })()
  if (errorWc) {
    nativeTheme.themeSource = 'dark'
    await sleep(500)
    const dark = await evaluate<string>(errorWc, `getComputedStyle(document.body).backgroundColor + '|' + getComputedStyle(document.querySelector('a.button')).backgroundColor`)
    nativeTheme.themeSource = 'light'
    await sleep(500)
    const light = await evaluate<string>(errorWc, `getComputedStyle(document.body).backgroundColor + '|' + getComputedStyle(document.querySelector('a.button')).backgroundColor`)
    nativeTheme.themeSource = themeBefore
    check('error page: its colours follow the appearance (dark and light give different page and button colours)', dark !== light && dark.split('|').every((colour, i) => colour !== light.split('|')[i]), JSON.stringify({ dark, light }))
  } else check('error page: a refused connection shows our page', false, 'no error page appeared')

  // ---------------------------------------------------------------------------------------------------------------------------
  // Find in page and Glance, with real keys and clicks
  // ---------------------------------------------------------------------------------------------------------------------------
  const findPage = await settle('/findme', 'page /findme')
  cleanup.push(findPage)
  const chromeStage = (await rectOf(win.webContents, '.stage'))!
  browser.openOverlay({ panel: 'find' })
  await waitFor(async () => (await rectOf(ui, '.fb')) !== null, 4000)
  await sleep(300)
  const findBox = (await rectOf(ui, '.fb'))!
  const findLayer = overlayView.getBounds()
  check('find: the panel sits inside the page card, at its top right', findLayer.x + findBox.x >= chromeStage.x && findLayer.x + findBox.x + findBox.width <= chromeStage.x + chromeStage.width && findLayer.y + findBox.y >= chromeStage.y && findBox.y < chromeStage.height / 2 && findLayer.x + findBox.x > chromeStage.x + chromeStage.width / 2, JSON.stringify({ findBox, findLayer, chromeStage }))
  check('find: the field has the focus', await evaluate<boolean>(ui, `document.activeElement === document.querySelector('.fb-input')`))
  await typeText(ui, 'page')
  const findCount = await evaluate<string>(ui, `document.querySelector('.fb-count')?.textContent ?? ''`)
  const findButtons = await evaluate<number>(ui, `document.querySelectorAll('.fb-btn').length`)
  check('find: typing searches at once: the counter reads 1/n and the panel has its arrows and its cross', /^1\/[1-9]\d*$/.test(findCount) && findButtons === 3, JSON.stringify({ findCount, findButtons }))
  await press(ui, 'Escape')
  check('find: Escape closes it', await waitFor(() => browser.currentPanel() === null, 3000))
  const peekTab = browser.snapshot()
  void peekTab
  browser.openPeek(`${base}/peeked`)
  await waitFor(async () => (await rectOf(ui, '.pk-card')) !== null, 6000)
  await sleep(500)
  const pk = (await rectOf(ui, '.pk-card'))!
  // The actions are written out in the header of the card, at its right: « Ouvrir dans un onglet ⌘↩ » (the accent), « Vue scindée », « Fermer Échap ».
  const pkButtons = await evaluate<Array<Rect & { kind: string; label: string }>>(ui, `[...document.querySelectorAll('.pk-card .pk-head .pk-btn')].map((el) => { const r = el.getBoundingClientRect(); return { kind: ['primary', 'split', 'quiet'].find((k) => el.classList.contains(k)) ?? '', label: el.textContent, x: r.x, y: r.y, width: r.width, height: r.height } })`)
  const pkHead = (await rectOf(ui, '.pk-card .pk-head'))
  const pkTitle = (await rectOf(ui, '.pk-card .pk-id'))
  const inside = (b: Rect) => b.x >= pk.x && b.x + b.width <= pk.x + pk.width && b.y >= pk.y && b.y + b.height <= pk.y + pk.height
  check(
    'peek: the card is inside the page card; its header holds the three actions written out (open in a tab, split view, close), in that order, at the right of the title',
    pk.x >= chromeStage.x && pk.x + pk.width <= chromeStage.x + chromeStage.width && pk.y >= chromeStage.y && pk.y + pk.height <= chromeStage.y + chromeStage.height &&
      !!pkHead && !!pkTitle && pkButtons.map((b) => b.kind).join(',') === 'primary,split,quiet' && pkButtons.every(inside) &&
      pkButtons[0]!.label.startsWith('Ouvrir dans un onglet') && pkButtons[1]!.label === 'Vue scindée' && pkButtons[2]!.label.startsWith('Fermer') &&
      pkButtons.every((b, i) => b.x >= pkTitle.x + pkTitle.width - 0.5 && b.y >= pkHead.y && b.y + b.height <= pkHead.y + pkHead.height + 0.5 && b.x + b.width <= pk.x + pk.width && (i === 0 || b.x >= pkButtons[i - 1]!.x + pkButtons[i - 1]!.width)),
    JSON.stringify({ pk, pkHead, pkTitle, pkButtons, chromeStage })
  )
  const tabsBeforePeek = state().tabs.length
  const openInTab = pkButtons.find((b) => b.kind === 'primary')
  if (openInTab) await click(ui, openInTab.x + openInTab.width / 2, openInTab.y + openInTab.height / 2)
  check('peek: « Ouvrir dans un onglet » opens the page as a tab and puts the preview away', !!openInTab && (await waitFor(() => browser.currentPanel() === null, 4000)) && (await waitFor(() => state().tabs.length === tabsBeforePeek + 1 && state().tabs.at(-1)?.url === `${base}/peeked`, 4000)), JSON.stringify({ tabs: state().tabs.length, was: tabsBeforePeek }))
  cleanup.push(state().tabs.at(-1)!.id)
  browser.openPeek(`${base}/peeked-again`)
  await waitFor(async () => (await rectOf(ui, '.pk-card')) !== null, 6000)
  await sleep(300)
  await press(ui, 'Escape')
  check('peek: Escape puts the preview away without opening anything', (await waitFor(() => browser.currentPanel() === null, 4000)) && !state().tabs.some((t) => t.url === `${base}/peeked-again`))

}

/**
 * The checks that open a private window: they run after the suites that expect to find the first ephemeral session (smoke-windows
 * looks for `ephemeral-1`), hence this file runs last (see index.ts).
 */
export async function smokeIsoPanelsLate(ctx: SmokeContext, check: Check): Promise<void> {
  ctx.win.showInactive()
  // A new private window opens with the command bar.
  const manager = getWindowManager()
  const privateRecord = manager.openPrivate({ commandBar: true })
  check('a private window opened with the command bar asked for shows it at once', await waitFor(() => privateRecord.browser.currentPanel() === 'commandbar', 8000), String(privateRecord.browser.currentPanel()))
  privateRecord.win.close()
  await waitFor(() => privateRecord.win.isDestroyed(), 5000)
  const plainPrivate = manager.openPrivate()
  // A fixed wait, for want of a witness: a window that asks for the command bar gets it a moment after its panels layer has loaded (windows.ts,
  // `openCommandBarWhenReady`), and nothing says it will not come to one that did not ask. The load is waited for, then more than that moment.
  const plainOverlay = () => plainPrivate.win.contentView.children.map((view) => (view as unknown as { webContents?: WebContents }).webContents).find((wc) => wc?.getURL().includes('overlay'))
  await waitFor(() => plainOverlay() !== undefined && !plainOverlay()!.isLoading(), 8000)
  await sleep(600)
  check('...and one opened without asking (the checks of the other suites) does not', plainPrivate.browser.currentPanel() === null)
  plainPrivate.win.close()
  await waitFor(() => plainPrivate.win.isDestroyed(), 5000)

}

/** Every check of this file with its own report: the last suite of the engine test, and LUCIUM_SMOKE_ONLY=iso-panels (quick loop). */
export async function runIsoPanelsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const verbose = process.env['LUCIUM_ISOP_VERBOSE'] === '1'
    const record = (name: string, ok: boolean, detail?: string) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`ISO-PANELS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    }
    await smokeIsoPanels(ctx, record)
    await smokeIsoPanelsLate(ctx, record)
  } catch (error) {
    noteCheck(checks, 'smokeIsoPanels ran to the end', false, String((error as Error)?.stack ?? error))
    console.log(`ISO-PANELS FAIL smokeIsoPanels ran to the end -- ${String((error as Error)?.stack ?? error)}`)
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ISO_PANELS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
