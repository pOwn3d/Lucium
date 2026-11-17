// Engine checks for "Actualiser tous les onglets", run inside a real Electron. A local server counts the requests of each page, so a reload
// is seen from the server's side: the pages of every space are fetched again, a sleeping tab and a frozen one are not woken, a page with
// text typed in it is left alone and the toast says so, two requests at once make one run, and the View menu and the page of the
// interface (the command bar's route) both start it. Called from the engine smoke test: `await smokeReloadAll(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Menu, type MenuItem, type WebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

async function typeKeys(wc: WebContents, text: string): Promise<void> {
  for (const ch of text) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await sleep(30)
  }
  await sleep(100)
}

/** The menu item with this label, anywhere in the application menu. */
function findMenuItem(label: string): MenuItem | undefined {
  const walk = (items: readonly MenuItem[]): MenuItem | undefined => {
    for (const item of items) {
      if (item.label === label) return item
      const inner = item.submenu ? walk(item.submenu.items) : undefined
      if (inner) return inner
    }
    return undefined
  }
  return walk(Menu.getApplicationMenu()?.items ?? [])
}

export async function smokeReloadAll(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const originalSleep = store.get().settings.sleepAfterMinutes
  // Nothing may be put to sleep by the delay while the checks run: only the sleeps asked for.
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })
  const originalSpace = store.get().activeSpaceId

  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const key = url.searchParams.get('id') ?? url.pathname
    hits.set(key, (hits.get(key) ?? 0) + 1)
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/ra-field') return void res.end(`<title>ra ${key}</title><body>hit<input id="q" type="text"></body>`)
    res.end(`<title>ra ${key}</title><body>hit</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const mine = new Set<string>()
  const hitsOf = (name: string) => hits.get(name) ?? 0
  const runtimeOf = (id: string) => browser.snapshot().runtime.tabs[id]
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  /** A page whose new request has reached the server is done reloading once it no longer loads: that load ends after every request it made. */
  const reloaded = (id: string): boolean => wcOf(id)?.isLoading() === false
  const open = async (path: string, name: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}?id=${name}` })
    const tab = store.get().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => hitsOf(name) > 0 && runtimeOf(tab.id)?.loading === false)
    await sleep(150)
    return tab.id
  }
  const toastNow = () => browser.snapshot().toast?.message ?? ''
  const toastId = () => browser.snapshot().toast?.id ?? 0
  // Every notice shown, with its button. The notice of the end of a run does not stay: when tabs found no longer to answer (here, tabs that earlier suites left
  // behind, whose server is gone), « N sites ne répondent plus » replaces it at once (`offerFound`, by design, and a late look at an earlier run does the same).
  // The end of a run is read from what was shown, not from what is still on screen when the check looks.
  const noticesShown: Array<{ at: number; message: string; action?: string }> = []
  const realShowToast = browser.showToast.bind(browser)
  browser.showToast = (...args: Parameters<typeof browser.showToast>) => {
    noticesShown.push({ at: Date.now(), message: args[0], ...(args[1] ? { action: args[1].label } : {}) })
    realShowToast(...args)
  }
  const END_NOTICE = /actualisé|Aucun onglet|laissé/
  /**
   * A moment before a run starts: the end notice of that run is the first one shown after it. The moment is a place in the list of the notices, not a
   * time: the end notice of the run before, shown in the same millisecond as the mark, was taken for the end of this one.
   */
  const mark = () => ({ from: noticesShown.length })
  const endNotice = (since: { from: number }) => noticesShown.slice(since.from).find((n) => END_NOTICE.test(n.message))
  /** Waits for the notice that ends a run (the one made by this run, not an older one). */
  const runDone = async (since: { from: number }) => waitFor(() => endNotice(since) !== undefined, 20_000)

  let createdSpace: string | undefined
  try {
    // ---- the tabs: three in the current space (one asleep, one frozen), one with typed text, two in another space ----
    const a1 = await open('/ra', 'a1')
    const asleep = await open('/ra', 'asleep')
    const frozen = await open('/ra', 'frozen')
    const typing = await open('/ra-field', 'typing')
    const wcTyping = wcOf(typing)!
    wcTyping.focus()
    await wcTyping.executeJavaScript(`document.getElementById('q').focus()`)
    await typeKeys(wcTyping, 'abc')
    const slept = await browser.sleepNow(asleep)
    const froze = await browser.sleepNow(frozen, 'freeze')
    browser.dispatch({ type: 'space/create', name: 'Espace de test', emoji: '🔁', hue: 200 })
    createdSpace = store.get().activeSpaceId
    browser.dispatch({ type: 'space/select', id: createdSpace })
    const b1 = await open('/ra', 'b1')
    const b2 = await open('/ra', 'b2')
    check('reload-all: the pages are set up (two spaces, one tab asleep, one frozen, text typed in one)', slept && froze && createdSpace !== originalSpace && [a1, typing, b1, b2].every((id) => browser.livePageIds().includes(id)) && !browser.livePageIds().includes(asleep) && browser.sleepStateOf(frozen) === 'frozen')

    // ---- the menu item ----
    const item = findMenuItem('Actualiser tous les onglets')
    check('reload-all: the View menu offers "Actualiser tous les onglets"', item !== undefined)
    const before = new Map(hits)
    const since = (name: string) => hitsOf(name) - (before.get(name) ?? 0)
    const toastBefore = mark()
    item?.click()
    const done = await runDone(toastBefore)
    // The witness: the pages the run reloaded have reached the server and finished loading again (a second reload of the same page would have
    // reached the server before that end). The run decided for every tab at once (its notice counts them), so a tab it left alone is not coming later.
    await waitFor(() => [['a1', a1], ['b1', b1], ['b2', b2]].every(([name, id]) => since(name!) >= 1 && reloaded(id!)))
    const delta = { a1: since('a1'), b1: since('b1'), b2: since('b2'), asleep: since('asleep'), frozen: since('frozen'), typing: since('typing') }
    check('reload-all: the pages of every space are fetched again, once each', done && delta.a1 === 1 && delta.b1 === 1 && delta.b2 === 1, JSON.stringify(delta))
    check('reload-all: a sleeping tab and a frozen tab are not woken', delta.asleep === 0 && delta.frozen === 0 && !browser.livePageIds().includes(asleep) && browser.sleepStateOf(frozen) === 'frozen', JSON.stringify(delta))
    check('reload-all: a page with text typed in it is left alone', delta.typing === 0 && (await wcTyping.executeJavaScript(`document.getElementById('q').value`)) === 'abc', JSON.stringify(delta))
    check('reload-all: the notice counts the tabs reloaded and those left as they were (the one typed in here, and any a previous suite left with text in it)', /^\d+ onglets actualisés, \d+ laissés? tels? quels? \(saisie en cours\)$/.test(endNotice(toastBefore)?.message ?? ''), endNotice(toastBefore)?.message ?? toastNow())

    // ---- two requests at once make one run ----
    const base2 = new Map(hits)
    const [first, second] = await Promise.all([browser.reloadAllTabs(40), browser.reloadAllTabs(40)])
    // The witness: the reloads of the first run reaching the server; the second has answered that it reloaded nothing.
    await waitFor(() => hitsOf('a1') - (base2.get('a1') ?? 0) >= 1 && hitsOf('b1') - (base2.get('b1') ?? 0) >= 1 && reloaded(a1) && reloaded(b1))
    check('reload-all: a second request while a run is going on does nothing', first.reloaded >= 3 && second.reloaded === 0 && second.kept === 0 && hitsOf('a1') - (base2.get('a1') ?? 0) === 1 && hitsOf('b1') - (base2.get('b1') ?? 0) === 1, JSON.stringify({ first, second }))

    // ---- a page that cannot say whether it is being edited is reloaded, and the log says why ----
    const hung = browser.pageFor(b2) as unknown as { evaluate: (...args: unknown[]) => Promise<unknown> }
    const realEvaluate = hung.evaluate
    hung.evaluate = () => Promise.reject(new Error('page hung'))
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
    const base4 = new Map(hits)
    try {
      await browser.reloadAllTabs(0)
    } finally {
      console.warn = realWarn
      hung.evaluate = realEvaluate
    }
    // The witness: the reload of the page that could not answer reaching the server (the log line was written during the run).
    await waitFor(() => hitsOf('b2') - (base4.get('b2') ?? 0) >= 1 && reloaded(b2))
    check('reload-all: a page that cannot answer is reloaded anyway, and the log names the tab and the cause', hitsOf('b2') - (base4.get('b2') ?? 0) === 1 && warnings.some((w) => w.includes('[reload-all]') && w.includes(b2) && w.includes('page hung')), JSON.stringify({ b2: hitsOf('b2') - (base4.get('b2') ?? 0), warnings: warnings.slice(0, 2) }))

    // ---- the route of the command bar: the page of the interface asks through the preload ----
    const base3 = new Map(hits)
    const toast3 = mark()
    await win.webContents.executeJavaScript('window.lucium.reloadAllTabs()')
    const done3 = await runDone(toast3)
    // The witness: the reload of a page of the run reaching the server; the page typed in was left alone by the same run.
    await waitFor(() => hitsOf('b2') - (base3.get('b2') ?? 0) >= 1 && reloaded(b2))
    check('reload-all: the interface can start it too (the command bar action)', done3 && hitsOf('b2') - (base3.get('b2') ?? 0) === 1 && hitsOf('typing') === before.get('typing'), JSON.stringify({ done3, b2: hitsOf('b2') - (base3.get('b2') ?? 0) }))

    // ---- the button next to the sidebar button: a setting, off by default, and a real click ----
    // Two buttons now, after the sidebar button: every space (the one this check clicks) and this space only (sidebar.css `.sidebar-reload-space`).
    const buttonSelector = '.sidebar .toolbar button[aria-label="Actualiser les onglets de tous les espaces"]'
    const hasButton = () => win.webContents.executeJavaScript(`!!document.querySelector('${buttonSelector}')`) as Promise<boolean>
    check('reload-all: the sidebar header shows no such button until the setting asks for it (Arc has none)', store.get().settings.showReloadAllButton === false && !(await hasButton()))
    browser.dispatch({ type: 'settings/update', patch: { showReloadAllButton: true } })
    const shown = await waitFor(hasButton)
    check('reload-all: with the setting on, the buttons are in the header of the sidebar right after the sidebar button (every space, then this space), and not in the toolbar of the pages', shown && (await win.webContents.executeJavaScript(`(() => { const row = [...document.querySelectorAll('.sidebar .toolbar button.icon')].map((e) => e.getAttribute('aria-label')); const bar = [...document.querySelectorAll('.page-toolbar .tb-button')].map((e) => e.getAttribute('aria-label')); return row.indexOf('Masquer la barre latérale') === 0 && row[1] === 'Actualiser les onglets de tous les espaces' && row[2] === 'Actualiser les onglets de cet espace seulement' && !bar.some((label) => label?.startsWith('Actualiser les onglets')) })()`)))
    const buttonRect = (await win.webContents.executeJavaScript(`(() => { const r = document.querySelector('${buttonSelector}').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)) as { x: number; y: number; width: number; height: number }
    const base5 = new Map(hits)
    const toast5 = mark()
    const cx = Math.round(buttonRect.x + buttonRect.width / 2)
    const cy = Math.round(buttonRect.y + buttonRect.height / 2)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) win.webContents.sendInputEvent({ type, x: cx, y: cy, button: 'left', clickCount: 1 })
    const done5 = await runDone(toast5)
    // The witness: the reloads of the run reaching the server; the page typed in was left alone by the same run.
    await waitFor(() => hitsOf('b1') - (base5.get('b1') ?? 0) >= 1 && hitsOf('a1') - (base5.get('a1') ?? 0) >= 1 && reloaded(b1) && reloaded(a1))
    check('reload-all: a real click on the sidebar button reloads the pages of every space, not the one with text typed in', done5 && hitsOf('b1') - (base5.get('b1') ?? 0) === 1 && hitsOf('a1') - (base5.get('a1') ?? 0) === 1 && hitsOf('typing') === before.get('typing'), JSON.stringify({ b1: hitsOf('b1') - (base5.get('b1') ?? 0), a1: hitsOf('a1') - (base5.get('a1') ?? 0) }))

    // ---- the tabs that sleep: offered in the notice, woken by the offer, or by the run when the setting says so ----
    const offerBefore = toastId()
    await browser.reloadAllTabs(40)
    const offer = browser.snapshot().toast
    check('reload-all: with the setting off, the notice offers to wake the tabs that sleep', (offer?.id ?? 0) > offerBefore && /^Actualiser aussi (l’onglet|les \d+ onglets) en veille$/.test(offer?.action ?? ''), JSON.stringify(offer))
    const base6 = new Map(hits)
    const toast6 = mark()
    browser.runToastAction(offer?.id ?? -1)
    const done6 = await runDone(toast6)
    // Both tabs are loaded afresh, then put back to sleep: what the check reads is waited for.
    await waitFor(() => hitsOf('asleep') - (base6.get('asleep') ?? 0) >= 1 && hitsOf('frozen') - (base6.get('frozen') ?? 0) >= 1 && !browser.livePageIds().includes(asleep) && browser.sleepStateOf(frozen) !== 'awake')
    const delta6 = { asleep: hitsOf('asleep') - (base6.get('asleep') ?? 0), frozen: hitsOf('frozen') - (base6.get('frozen') ?? 0), a1: hitsOf('a1') - (base6.get('a1') ?? 0) }
    // Once loaded afresh, both go back to sleep (in the mode of the settings): the run leaves the memory as it found it.
    check('reload-all: the offer wakes the sleeping tab and the frozen one, loads each afresh, once, and puts them back to sleep', done6 && delta6.asleep === 1 && delta6.frozen === 1 && !browser.livePageIds().includes(asleep) && browser.sleepStateOf(frozen) !== 'awake' && delta6.a1 === 0, JSON.stringify({ done6, delta6, state: browser.sleepStateOf(frozen), asleepIsLive: browser.livePageIds().includes(asleep), notices: noticesShown.slice(toast6.from).map((n) => n.message) }))
    check('reload-all: the notice of the offer counts the woken tabs', /^\d+ onglets? actualisés?$/.test(endNotice(toast6)?.message ?? ''), endNotice(toast6)?.message ?? toastNow())
    check('reload-all: the tab shown stays the one that was shown (waking pages does not select them)', store.get().activeSpaceId === createdSpace && browser.snapshot().state.tabs.find((t) => t.id === b2) !== undefined)

    // The setting makes the run itself wake them (the tab is asleep again since the offer).
    const slept2 = !browser.livePageIds().includes(asleep)
    browser.dispatch({ type: 'settings/update', patch: { reloadAllWakes: true } })
    const base7 = new Map(hits)
    const toast7 = mark()
    await browser.reloadAllTabs(40)
    await runDone(toast7)
    // The sleeping tab is loaded afresh, then put back to sleep: what the check reads is waited for.
    await waitFor(() => hitsOf('asleep') - (base7.get('asleep') ?? 0) >= 1 && !browser.livePageIds().includes(asleep))
    check('reload-all: with the setting on, the run wakes the sleeping tab too, loads it afresh and puts it back to sleep, and the notice says so', slept2 && hitsOf('asleep') - (base7.get('asleep') ?? 0) === 1 && !browser.livePageIds().includes(asleep) && /dont \d+ réveillés?/.test(endNotice(toast7)?.message ?? '') && endNotice(toast7)?.action === undefined, JSON.stringify(endNotice(toast7) ?? toastNow()))
    browser.dispatch({ type: 'settings/update', patch: { reloadAllWakes: false } })
  } finally {
    browser.showToast = realShowToast
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    if (createdSpace) browser.dispatch({ type: 'space/delete', id: createdSpace })
    if (store.get().spaces.some((s) => s.id === originalSpace)) browser.dispatch({ type: 'space/select', id: originalSpace })
    browser.closeOverlay()
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: originalSleep, showReloadAllButton: false, reloadAllWakes: false } })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=reloadall`: only these checks, with their own report. */
export async function runReloadAllSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeReloadAll(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeReloadAll ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_RELOADALL ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
