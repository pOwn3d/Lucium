// Engine checks for tabs that reload themselves, run inside a real Electron. A local server counts the requests of each page (with the
// time of each one), so a reload is seen from the server's side: the single timer reloads at the interval and no faster, a tab that is
// turned off stops, a field being typed in is never cut short (typed text in focus, typed text left behind, but not an empty
// field the page focused by itself), a sleeping or frozen tab is not woken, a failing page is retried no faster than the interval,
// the setting survives a restart, and the menus, the panel, the mark on the row and the private window do what they say.
// Real key events type into the pages and the panel; real mouse events click its buttons. Called from the engine smoke test:
// `await smokeAutoReload(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ipcMain, Menu, type MenuItem, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseSavedState } from '@shared/sidebar'
import type { SmokeContext } from './smoke'
import { menuItems } from './shell/context-menus'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const rectIn = (wc: WebContents, selector: string, text?: string): Promise<Rect | null> =>
  wc.executeJavaScript(
    `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.trim() === ${JSON.stringify(text)})`}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`
  ) as Promise<Rect | null>

/** A left click with real mouse events, in the middle of the box. */
async function clickOn(wc: WebContents, selector: string, text?: string): Promise<boolean> {
  let rect: Rect | null = null
  for (let i = 0; i < 40 && !(rect && rect.width > 0); i++) {
    rect = await rectIn(wc, selector, text)
    if (!(rect && rect.width > 0)) await sleep(100)
  }
  if (!rect) return false
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
  await sleep(200)
  return true
}

async function typeKeys(wc: WebContents, text: string): Promise<void> {
  for (const ch of text) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await sleep(30)
  }
  await sleep(100)
}

const INTERVAL = 5
/** The pages: each reports the number of the request that produced it, and some hold a field. */
const FIELD = `<input id="q" type="text">`

export async function smokeAutoReload(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const manager = getWindowManager()
  const tabs = () => store.get().tabs
  const originalSleep = store.get().settings.sleepAfterMinutes
  // Nothing may be put to sleep by the delay while the checks run: only the sleeps asked for.
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  // ---- the pages: every request is counted, with its time ----
  const hits = new Map<string, number[]>()
  const hitsOf = (id: string) => hits.get(id) ?? []
  /** The method of each request for the page a form is sent to, in order: a form sent again by a reload is one more POST. */
  const formRequests: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const key = url.searchParams.get('id') ?? url.pathname
    hits.set(key, [...hitsOf(key), Date.now()])
    if (url.pathname === '/ar-post') formRequests.push(req.method ?? '')
    if (url.pathname === '/ar-error') {
      // The connection is cut without an answer: the page that stands in for it is shown, and its address stays.
      res.socket?.destroy()
      return
    }
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    const n = hitsOf(key).length
    // A field the page fills and focuses itself: the text is there, but the user did not type it.
    if (url.pathname === '/ar-prefilled') return void res.end(`<title>ar ${key}</title><body>hit ${n}<input id="q" type="text" value="already here"><script>document.getElementById('q').focus()</script></body>`)
    // A page that takes two seconds to load: the countdown must start when it is done.
    if (url.pathname === '/ar-slow') return void setTimeout(() => res.end(`<title>ar ${key}</title><body>hit ${n}</body>`), 2000)
    if (url.pathname === '/ar-autofocus') return void res.end(`<title>ar ${key}</title><body>hit ${n}${FIELD}<script>document.getElementById('q').focus()</script></body>`)
    if (url.pathname === '/ar-field') return void res.end(`<title>ar ${key}</title><body>hit ${n}${FIELD}</body>`)
    // A form with nothing typed in it (a typed field would hold the reload back by itself), sent to a page that counts how it is asked for.
    if (url.pathname === '/ar-form') return void res.end(`<title>ar ${key}</title><body><form method="post" action="/ar-post?id=posted"><input type="hidden" name="order" value="1"></form></body>`)
    res.end(`<title>ar ${key}</title><body>hit ${n}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- helpers ----
  const mine = new Set<string>()
  /** The name each page reports to the server, by tab id. */
  const names = new Map<string, string>()
  const live = (id: string) => browser.livePageIds().includes(id)
  const runtimeOf = (id: string) => browser.snapshot().runtime.tabs[id]
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const select = (id: string) => browser.dispatch({ type: 'tab/select', id })
  const activeId = () => store.get().activeTabBySpace[store.get().activeSpaceId]
  const setInterval_ = (id: string, seconds: number | null) => browser.dispatch({ type: 'tab/auto-reload', id, seconds })
  const open = async (path: string, name: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}?id=${name}` })
    const tab = tabs().at(-1)!
    mine.add(tab.id)
    names.set(tab.id, name)
    await waitFor(() => hitsOf(name).length > 0 && runtimeOf(tab.id)?.loading === false)
    await sleep(150)
    return tab.id
  }
  /** Chromium sends a request again at once when the connection is cut without an answer: requests within a second are one attempt. */
  const attempts = (times: number[]) => times.filter((t, i) => i === 0 || t - times[i - 1]! > 1000)
  const hitsOfTab = (id: string) => attempts(hitsOf(names.get(id) ?? ''))
  const menu = (id: string) => menuItems({ kind: 'tab', id }, browser, store, win)
  const submenuOf = (id: string): MenuItemConstructorOptions[] => {
    const entry = menu(id).find((i) => i.label === 'Recharger automatiquement')
    return Array.isArray(entry?.submenu) ? (entry.submenu as MenuItemConstructorOptions[]) : []
  }
  const chooseFromMenu = (id: string, label: string) => (submenuOf(id).find((i) => i.label === label)?.click as (() => void) | undefined)?.()
  const gaps = (id: string, from: number) => hitsOfTab(id).slice(from).map((t, i, all) => (i === 0 ? Infinity : t - all[i - 1]!))
  const minGap = (id: string, from: number) => Math.min(...gaps(id, from).slice(1))
  const pressEnter = async (wc: WebContents) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(150)
  }

  try {
    // ---- the tabs ----
    const bg = await open('/ar', 'bg')
    const asleep = await open('/ar', 'asleep')
    const frozen = await open('/ar', 'frozen')
    const error = await open('/ar-error', 'error')
    const typing = await open('/ar-field', 'typing')
    select(typing)
    wcOf(typing)!.focus()
    await wcOf(typing)!.executeJavaScript(`document.getElementById('q').focus()`)
    await typeKeys(wcOf(typing)!, 'abc')
    const unsent = await open('/ar-field', 'unsent')
    select(unsent)
    wcOf(unsent)!.focus()
    await wcOf(unsent)!.executeJavaScript(`document.getElementById('q').focus()`)
    await typeKeys(wcOf(unsent)!, 'abc')
    // The field is left: it is not in focus any more, but the page still holds what was typed and not sent.
    await wcOf(unsent)!.executeJavaScript(`document.activeElement.blur()`)
    const empty = await open('/ar-autofocus', 'empty')
    const prefilled = await open('/ar-prefilled', 'prefilled')
    const slow = await open('/ar-slow', 'slow')
    const thaw = await open('/ar', 'thaw')
    const control = await open('/ar', 'control')
    const sel = await open('/ar', 'sel')
    check('autoreload: the pages are open, each with a live page, the typed text is where it was left', [bg, asleep, frozen, typing, unsent, empty, prefilled, slow, thaw, control, sel].every(live) && (await wcOf(typing)!.executeJavaScript(`document.getElementById('q').value`)) === 'abc' && (await wcOf(unsent)!.executeJavaScript(`document.getElementById('q').value`)) === 'abc')
    check('autoreload: the typed field is in focus on one page and was left on the other, as the checks below assume', (await wcOf(typing)!.executeJavaScript(`document.activeElement.id`)) === 'q' && (await wcOf(unsent)!.executeJavaScript(`document.activeElement.id`)) !== 'q')

    // ---- the menu: its entries, then the choice of the interval ----
    const items = submenuOf(sel)
    const labels = items.filter((i) => i.type !== 'separator').map((i) => i.label)
    check('autoreload: the tab menu has "Recharger automatiquement" with Désactivé, the module\'s intervals and Personnalisé…', JSON.stringify(labels) === JSON.stringify(['Désactivé', frenchSpaces('5 s'), frenchSpaces('10 s'), frenchSpaces('30 s'), frenchSpaces('1 min'), frenchSpaces('2 min'), frenchSpaces('5 min'), frenchSpaces('10 min'), 'Personnalisé…']), JSON.stringify(labels))
    check('autoreload: with nothing set, Désactivé is the one checked', items.filter((i) => i.checked === true).map((i) => i.label).join() === 'Désactivé')
    const reloadable = menu(sel).find((i) => i.label === 'Recharger automatiquement')
    browser.dispatch({ type: 'tab/open', url: 'about:blank' })
    const blank = tabs().at(-1)!
    mine.add(blank.id)
    const blankEntry = menu(blank.id).find((i) => i.label === 'Recharger automatiquement')
    browser.dispatch({ type: 'tab/close', id: blank.id })
    check('autoreload: the entry is greyed out for a page that cannot be reloaded (a blank tab)', reloadable?.enabled !== false && blankEntry?.enabled === false)
    select(sel)
    await sleep(300)

    // The tab that is on screen is set from the menu, the others from the state: all start counting together.
    const baseline = new Map([...names.keys()].map((id) => [id, hitsOfTab(id).length]))
    check('autoreload: a tab put to sleep and a tab frozen on request, as the checks below assume', await (async () => {
      const slept = await browser.sleepNow(asleep)
      const froze = await browser.sleepNow(frozen, 'freeze')
      return slept && froze && !live(asleep) && browser.sleepStateOf(frozen) === 'frozen'
    })())
    chooseFromMenu(sel, frenchSpaces('5 s'))
    for (const id of [bg, asleep, frozen, error, typing, unsent, empty, prefilled, slow, thaw]) setInterval_(id, INTERVAL)
    const t0 = Date.now()
    check('autoreload: choosing 5 s in the menu sets the tab, and the menu then checks it', tabs().find((t) => t.id === sel)?.autoReload?.seconds === 5 && submenuOf(sel).find((i) => i.checked === true)?.label === frenchSpaces('5 s'))
    check('autoreload: a single timer serves all the tabs of the window', browser.autoReloadState(sel).armed && [bg, typing, error].every((id) => (browser.autoReloadState(id).at ?? 0) > t0 && (browser.autoReloadState(id).at ?? 0) <= t0 + INTERVAL * 1000 + 200))
    check('autoreload: a sleeping tab and a frozen tab have no countdown', browser.autoReloadState(asleep).at === null && browser.autoReloadState(frozen).at === null)

    // ---- let two intervals pass (a tab is frozen when its countdown is running, to be thawed after it would have ended) ----
    // A fixed wait, for want of a witness: the tab is frozen part-way through its countdown, which is a matter of time.
    await sleep(1500)
    check('autoreload: a tab with a countdown can be frozen', await browser.sleepNow(thaw, 'freeze'))
    await sleep(12_000)
    const since = (id: string) => hitsOfTab(id).length - (baseline.get(id) ?? 0)
    const reloads = { sel: since(sel), bg: since(bg), empty: since(empty), prefilled: since(prefilled), slow: since(slow), thaw: since(thaw), typing: since(typing), unsent: since(unsent), asleep: since(asleep), frozen: since(frozen), error: since(error), control: since(control) }
    const twice = (n: number) => n >= 2 && n <= 3
    check('autoreload: the selected tab was reloaded at the interval (two or three times in 13 s)', twice(reloads.sel), JSON.stringify(reloads))
    check('autoreload: a tab in the background was reloaded too', twice(reloads.bg), JSON.stringify(reloads))
    check('autoreload: an empty field the page focused by itself does not hold the reload back', twice(reloads.empty), JSON.stringify(reloads))
    check('autoreload: a field with typed text in focus is never cut short', reloads.typing === 0 && (await wcOf(typing)!.executeJavaScript(`document.getElementById('q').value`)) === 'abc', JSON.stringify(reloads))
    check('autoreload: nor is text the page put in a field it focused (the user did not type it, but it is there)', reloads.prefilled === 0 && (await wcOf(prefilled)!.executeJavaScript(`document.getElementById('q').value`)) === 'already here', JSON.stringify(reloads))
    check('autoreload: the countdown starts when the page has finished loading (a page that takes 2 s is reloaded every 7 s, not every 5)', reloads.slow === 2 && minGap(slow, baseline.get(slow) ?? 0) >= 6500, `${JSON.stringify(reloads)} gaps ${JSON.stringify(gaps(slow, baseline.get(slow) ?? 0))}`)
    check('autoreload: a frozen tab whose countdown would have ended is not reloaded', reloads.thaw === 0 && browser.sleepStateOf(thaw) === 'frozen', JSON.stringify(reloads))
    check('autoreload: nor is text typed in a field that was left (the page still holds it)', reloads.unsent === 0 && (await wcOf(unsent)!.executeJavaScript(`document.getElementById('q').value`)) === 'abc', JSON.stringify(reloads))
    check('autoreload: a tab asleep is not woken by the countdown', reloads.asleep === 0 && !live(asleep), JSON.stringify(reloads))
    check('autoreload: a frozen tab is not reloaded', reloads.frozen === 0 && browser.sleepStateOf(frozen) === 'frozen', JSON.stringify(reloads))
    check('autoreload: a tab with no setting is left alone', reloads.control === 0, JSON.stringify(reloads))
    check('autoreload: a page that fails is tried again, no faster than the interval', twice(reloads.error) && minGap(error, baseline.get(error) ?? 0) >= INTERVAL * 1000 - 300, `${JSON.stringify(reloads)} gaps ${JSON.stringify(gaps(error, baseline.get(error) ?? 0))}`)
    check('autoreload: the address of the failing page is still the one asked for', tabs().find((t) => t.id === error)?.url.startsWith(`${base}/ar-error`) === true)
    check('autoreload: two reloads of a page are never closer than the interval', minGap(sel, baseline.get(sel) ?? 0) >= INTERVAL * 1000 - 300 && minGap(bg, baseline.get(bg) ?? 0) >= INTERVAL * 1000 - 300, JSON.stringify([gaps(sel, baseline.get(sel) ?? 0), gaps(bg, baseline.get(bg) ?? 0)]))

    // ---- turning off, finishing the typing, waking ----
    chooseFromMenu(sel, 'Désactivé')
    const selAtOff = hitsOfTab(sel).length
    check('autoreload: Désactivé clears the setting, and the menu checks it', tabs().find((t) => t.id === sel)?.autoReload === undefined && submenuOf(sel).find((i) => i.checked === true)?.label === 'Désactivé')
    await wcOf(typing)!.executeJavaScript(`document.getElementById('q').value = ''`)
    await wcOf(unsent)!.executeJavaScript(`document.getElementById('q').value = ''`)
    const typingBefore = hitsOfTab(typing).length
    const unsentBefore = hitsOfTab(unsent).length
    select(asleep)
    await waitFor(() => live(asleep))
    const wokenAt = Date.now()
    const asleepBefore = hitsOfTab(asleep).length
    select(frozen)
    select(thaw)
    const thawedAt = Date.now()
    check('autoreload: the tab thawed after its countdown would have ended does not reload at once: it has a whole interval again', browser.sleepStateOf(thaw) === 'awake' && (browser.autoReloadState(thaw).at ?? 0) >= thawedAt + INTERVAL * 1000 - 500 && hitsOfTab(thaw).length === (baseline.get(thaw) ?? 0), `${(browser.autoReloadState(thaw).at ?? 0) - thawedAt} ms`)
    check('autoreload: selecting a sleeping tab wakes it (the load is the page\'s own), and a frozen one runs again', live(asleep) && browser.sleepStateOf(frozen) === 'awake')
    check('autoreload: the woken tab has a whole interval before its first reload', (browser.autoReloadState(asleep).at ?? 0) >= wokenAt + INTERVAL * 1000 - 700)
    check('autoreload: once the typing is gone, the tab that was held back is reloaded (within the next interval and the 5 s it looks again after)', await waitFor(() => hitsOfTab(typing).length > typingBefore && hitsOfTab(unsent).length > unsentBefore, 14_000), `${hitsOfTab(typing).length - typingBefore} / ${hitsOfTab(unsent).length - unsentBefore}`)
    check('autoreload: the woken tab then reloads at the interval', await waitFor(() => hitsOfTab(asleep).length > asleepBefore + 1, 9_000))
    check('autoreload: the thawed tab then reloads at the interval too', await waitFor(() => hitsOfTab(frozen).length > (baseline.get(frozen) ?? 0), 9_000))
    check('autoreload: and the thawed tab then reloads at the interval', await waitFor(() => hitsOfTab(thaw).length > (baseline.get(thaw) ?? 0), 9_000))
    check('autoreload: the tab turned off stayed off the whole time', hitsOfTab(sel).length === selAtOff, `${hitsOfTab(sel).length} vs ${selAtOff}`)

    // ---- the state survives a restart; the tabs come back with the application ----
    const spaceTabs = tabs().filter((t) => t.autoReload)
    const restored = parseSavedState(JSON.stringify(store.get()))
    check('autoreload: the setting survives saving and reading the state back', spaceTabs.length >= 5 && spaceTabs.every((t) => restored.tabs.find((r) => r.id === t.id)?.autoReload?.seconds === t.autoReload?.seconds))
    select(sel)
    const slept = await browser.sleepNow(bg)
    const otherSlept = await browser.sleepNow(control)
    check('autoreload: a tab that reloads itself can still be put to sleep by hand', slept && otherSlept && !live(bg) && !live(control))
    const bgBefore = hitsOfTab(bg).length
    const shownBefore = activeId()
    browser.resumeAutoReload()
    check('autoreload: at start, the tabs that reload themselves get their page back (a sleeping tab without the setting does not)', live(bg) && !live(control) && (await waitFor(() => hitsOfTab(bg).length > bgBefore)))
    check('autoreload: and the tab on screen stays the one that was (the extension runtime calling the new page active selects nothing)', shownBefore === sel && activeId() === sel, `${names.get(activeId() ?? '')}`)
    check('autoreload: and reload at the interval from there', await waitFor(() => hitsOfTab(bg).length > bgBefore + 1, 9_000))

    // ---- sleep leaves such a tab alone ----
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 30 } })
    const blocker = await browser.sleepBlockerOf(bg)
    check('autoreload: the delay never puts a tab that reloads itself to sleep', blocker === 'auto-reload', `${blocker}; shown: ${names.get(activeId() ?? '')}`)
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

    // ---- the mark on the row ----
    const mark = (id: string) =>
      win.webContents.executeJavaScript(`(() => { const m = document.querySelector('.tab[data-id="${id}"] .auto-reload-mark'); if (!m) return null; const r = m.getBoundingClientRect(); const t = document.querySelector('.tab[data-id="${id}"] .tab-title').getBoundingClientRect(); return { title: m.getAttribute('title'), w: r.width, h: r.height, after: r.left >= t.right - 1 } })()`) as Promise<{ title: string; w: number; h: number; after: boolean } | null>
    chooseFromMenu(sel, frenchSpaces('30 s'))
    check('autoreload: the row of a tab that reloads itself wears a mark with the time left and the interval as its tooltip', await waitFor(async () => anySpace(/^Rechargement dans .+ \(toutes les 30 s\)\nArrêter le rechargement automatique$/).test((await mark(sel))?.title ?? '')), JSON.stringify(await mark(sel)))
    const m = await mark(sel)
    check('autoreload: the mark is 16 px high and sits after the title', m !== null && Math.round(m.h) === 16 && m.w >= 12 && m.after, JSON.stringify(m))
    check('autoreload: a row without the setting has no mark', (await mark(control)) === null)
    check('autoreload: the menu checks the interval, and 30 s is one of the module\'s', submenuOf(sel).find((i) => i.checked === true)?.label === frenchSpaces('30 s'))

    // ---- the View menu follows the tab on screen ----
    select(sel)
    const viewEntry = (): MenuItem | undefined => Menu.getApplicationMenu()?.items.find((i) => i.label === 'Affichage')?.submenu?.items.find((i) => i.label === 'Recharger automatiquement')
    check('autoreload: the View menu has the entry, enabled, with the interval of the tab on screen checked', await waitFor(() => viewEntry()?.enabled === true && viewEntry()?.submenu?.items.find((i) => i.checked)?.label === frenchSpaces('30 s')), frenchSpaces(`${viewEntry()?.submenu?.items.find((i) => i.checked)?.label}; shown: ${names.get(activeId() ?? '')}`))
    ;(viewEntry()?.submenu?.items.find((i) => i.label === frenchSpaces('1 min'))?.click as (() => void) | undefined)?.()
    check('autoreload: choosing in the View menu sets the tab on screen', tabs().find((t) => t.id === sel)?.autoReload?.seconds === 60)

    // ---- the panel ----
    const oc = overlayView.webContents
    // The overlay's page is replaced while a panel opens: a question put at that moment has no answer yet (null), it is asked again.
    const ask = <T>(js: string): Promise<T | null> => (oc.executeJavaScript(js) as Promise<T>).catch(() => null)
    const panelText = (selector: string) => ask<string | null>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`)
    const primaryDisabled = () => ask<boolean | null>(`document.querySelector('.auto-reload .tk-btn.primary')?.disabled ?? null`)
    const fieldValue = () => ask<string | null>(`document.querySelector('.auto-reload input')?.value ?? null`)
    /** Opens the panel and waits for a new instance of it: the one that was on screen before is marked, and does not count. */
    const openPanel = async (tabId: string): Promise<boolean> => {
      await ask(`document.querySelectorAll('.auto-reload').forEach((e) => e.setAttribute('data-stale', ''))`)
      browser.openOverlay({ panel: 'autoreload', tabId })
      return waitFor(async () => (await ask<boolean>(`document.querySelector('.auto-reload:not([data-stale]) input') !== null`)) === true)
    }
    const replaceField = async (text: string) => {
      await oc.executeJavaScript(`(() => { const i = document.querySelector('.auto-reload input'); i.focus(); i.select() })()`)
      await typeKeys(oc, text)
    }
    ;(submenuOf(sel).find((i) => i.label === 'Personnalisé…')?.click as (() => void) | undefined)?.()
    check('autoreload: Personnalisé… opens the panel of this tab', browser.currentPanel() === 'autoreload' && (await waitFor(async () => (await fieldValue()) !== null)))
    check('autoreload: it starts from the tab\'s own interval (1 minute)', (await fieldValue()) === '1' && (await ask(`document.querySelector('.auto-reload select').value`)) === 'minutes')
    await replaceField('3')
    await oc.executeJavaScript(`(() => { const s = document.querySelector('.auto-reload select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'seconds'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await waitFor(async () => (await panelText('.auto-reload [role=alert]')) === 'Au moins 5 secondes.')
    check('autoreload: an interval that is too short is explained, and cannot be applied', (await panelText('.auto-reload [role=alert]')) === 'Au moins 5 secondes.' && (await primaryDisabled()) === true, String(await panelText('.auto-reload [role=alert]')))
    await pressEnter(oc)
    check('autoreload: Enter does not apply it either', tabs().find((t) => t.id === sel)?.autoReload?.seconds === 60)
    await replaceField('90')
    check('autoreload: a valid interval takes the error away', (await panelText('.auto-reload [role=alert]')) === null && (await primaryDisabled()) === false)
    check('autoreload: the button applies it', (await clickOn(oc, '.auto-reload .tk-btn.primary')) && (await waitFor(() => tabs().find((t) => t.id === sel)?.autoReload?.seconds === 90)) && browser.currentPanel() === null)
    check('autoreload: 90 s is not one of the module\'s: the menu checks Personnalisé…, with the interval', (() => { const checked = submenuOf(sel).find((i) => i.checked === true); return checked?.label === frenchSpaces('Personnalisé… (1 min 30 s)') })())
    // As soon as a reload is scheduled the tooltip carries the time left, then the interval (see the check of the 30 s above).
    check('autoreload: the mark says so', await waitFor(async () => anySpace(/^Rechargement dans .+ \(toutes les 1 min 30 s\)\nArrêter le rechargement automatique$/).test((await mark(sel))?.title ?? '')))
    check('autoreload: reopened, the panel shows the interval in the unit that fits (90 seconds)', (await openPanel(sel)) && (await fieldValue()) === '90' && (await ask(`document.querySelector('.auto-reload select').value`)) === 'seconds', `${await fieldValue()}`)
    check('autoreload: Désactiver in the panel turns the setting off and closes it', (await clickOn(oc, '.auto-reload .tk-btn.danger')) && (await waitFor(() => tabs().find((t) => t.id === sel)?.autoReload === undefined)) && browser.currentPanel() === null)
    check('autoreload: a tab without the setting starts the panel at 30 seconds, and Désactiver is greyed out', (await openPanel(sel)) && (await fieldValue()) === '30' && (await ask(`document.querySelector('.auto-reload .tk-btn.danger').disabled`)) === true)
    check('autoreload: Annuler closes the panel and changes nothing', (await clickOn(oc, '.auto-reload .tk-btn', 'Annuler')) && browser.currentPanel() === null && tabs().find((t) => t.id === sel)?.autoReload === undefined)

    // ---- what the interface may ask: only the panel of a tab that exists ----
    const fromTopFrame = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    for (const tabId of ['ghost', 42, null, undefined, {}]) ipcMain.emit(Channel.openOverlay, fromTopFrame, { panel: 'autoreload', tabId })
    check('autoreload: a request for the panel of a tab that does not exist, or of no tab, opens nothing', browser.currentPanel() === null, String(browser.currentPanel()))
    ipcMain.emit(Channel.openOverlay, fromTopFrame, { panel: 'autoreload', tabId: sel })
    check('autoreload: ...while the same request for a tab that exists is answered (the control)', browser.currentPanel() === 'autoreload')
    browser.closeOverlay()

    // ---- the private window: in memory only ----
    const priv = manager.openPrivate()
    priv.browser.dispatch({ type: 'tab/open', url: `${base}/ar?id=private` })
    await waitFor(() => hitsOf('private').length > 0)
    const privTab = priv.store.get().tabs.at(-1)!
    await sleep(300)
    const privBase = hitsOf('private').length
    priv.browser.dispatch({ type: 'tab/auto-reload', id: privTab.id, seconds: INTERVAL })
    check('autoreload: a private window accepts the setting, in its own state and not in the main window\'s', priv.store.get().tabs.find((t) => t.id === privTab.id)?.autoReload?.seconds === INTERVAL && !tabs().some((t) => t.id === privTab.id))
    check('autoreload: and reloads the tab at the interval', await waitFor(() => hitsOf('private').length > privBase, 9_000))
    priv.browser.openOverlay({ panel: 'autoreload', tabId: privTab.id })
    check('autoreload: the panel opens in a private window too', priv.browser.currentPanel() === 'autoreload')
    priv.browser.closeOverlay()
    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()

    // ---- a page a form was sent to: the countdown must never send the form again (an order, a payment) ----
    // Written to settle what the engine does with `reload()` on such a page; the check fails if the form reaches the server a second time.
    const form = await open('/ar-form', 'form')
    select(form)
    await wcOf(form)!.executeJavaScript(`document.forms[0].submit()`)
    const sent = await waitFor(() => formRequests.length > 0 && tabs().find((t) => t.id === form)?.url.includes('/ar-post') === true && runtimeOf(form)?.loading === false)
    check('autoreload: the form was sent once, and its tab shows the answer (as the check below assumes)', sent && formRequests.join() === 'POST', formRequests.join())
    setInterval_(form, INTERVAL)
    const firstDue = browser.autoReloadState(form).at ?? 0
    // The witness that the countdown ended twice: each time it asks the page to reload, it starts again a whole interval later.
    const endedTwice = await waitFor(() => (browser.autoReloadState(form).at ?? 0) >= firstDue + 2 * INTERVAL * 1000 - 500 && runtimeOf(form)?.loading === false, 25_000)
    check('autoreload: the countdown of that tab ended twice (as the check below assumes)', firstDue > 0 && endedTwice, `${firstDue} then ${browser.autoReloadState(form).at}`)
    check('autoreload: a page a form was sent to is not sent again by the countdown (the server got the form once)', formRequests.filter((method) => method === 'POST').length === 1, `requests for the page, in order: ${formRequests.join()}`)
    setInterval_(form, null)

    // ---- everything off: the timer is let go ----
    for (const tab of tabs().filter((t) => t.autoReload)) setInterval_(tab.id, null)
    check('autoreload: with every tab turned off, nothing is left to reload and the timer is not armed', tabs().every((t) => !t.autoReload) && browser.autoReloadState(sel).armed === false)
    const settled = hitsOfTab(bg).length
    // A fixed wait, for want of a witness: that a whole interval passes with no reload is what is checked.
    await sleep(INTERVAL * 1000 + 1500)
    check('autoreload: and nothing reloads any more', hitsOfTab(bg).length === settled)
  } catch (error) {
    check('autoreload runs to the end', false, String((error as Error)?.stack ?? error))
  } finally {
    for (const tab of tabs().filter((t) => t.autoReload)) browser.dispatch({ type: 'tab/auto-reload', id: tab.id, seconds: null })
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    browser.closeOverlay()
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: originalSleep } })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=autoreload`: only these checks, with their own report (a quick loop while working on them). */
export async function runAutoReloadSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeAutoReload(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeAutoReload ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_AUTORELOAD ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
