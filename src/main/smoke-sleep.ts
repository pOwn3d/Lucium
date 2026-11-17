// Engine checks for putting tabs to sleep: the sweep and what spares a tab (its mark, its site, sound, Picture in Picture, a download,
// text typed and not sent, a split view, a pinned tab), the tab menu entries, the "Geler" mode, the notice, and the Settings group.
// Real key events type into the pages; each protection is followed by a control (lift it and the tab does sleep), so a check cannot
// pass just because nothing ever sleeps. Called from the engine smoke test: `await smokeSleep(ctx, check)`.

import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow as ElectronWindow, type WebContents } from 'electron'
import type { Settings } from '@shared/model'
import { menuItems } from './shell/context-menus'
import type { SmokeContext } from './smoke'
import { sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

const SLEEP_KEYS = ['sleepAfterMinutes', 'sleepMode', 'sleepExcludedHosts', 'sleepSkipAudible', 'sleepSkipPinned', 'sleepNotify'] as const

export async function smokeSleep({ browser, store, win }: SmokeContext, check: Check): Promise<void> {
  const settings = () => store.get().settings
  const tabs = () => store.get().tabs
  const original = Object.fromEntries(SLEEP_KEYS.map((key) => [key, settings()[key]])) as Pick<Settings, (typeof SLEEP_KEYS)[number]>
  const section = async (name: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      check(`${name} runs to the end`, false, String(error))
    }
    // Whatever a section left open must not weigh on the next one.
    browser.dispatch({ type: 'sleep/exclude-site', site: 'localhost', excluded: false })
    for (const tab of tabs().filter((t) => mine.has(t.id))) browser.dispatch({ type: 'tab/unpin', id: tab.id })
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    mine.clear()
    await sleep(200)
  }

  // ---- the pages ----
  let slowDownload: ServerResponse | null = null
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/sl-slow') {
      // A download that stays "progressing" until the test lets it end.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="sl-slow.bin"', 'content-length': '2048' })
      res.write(Buffer.alloc(512))
      slowDownload = res
      return
    }
    res.setHeader('content-type', 'text/html')
    if (url.startsWith('/sl-audio')) {
      return res.end(`<title>sl audio</title><body>audio<script>
        const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.05
        osc.connect(gain); gain.connect(ctx.destination); osc.start(); ctx.resume()
      </script></body>`)
    }
    if (url.startsWith('/sl-pip')) {
      return res.end(`<title>sl pip</title><body><video id="v" muted autoplay playsinline width="320" height="180"></video><canvas id="c" width="320" height="180"></canvas>
        <script>const c = document.getElementById('c'); const g = c.getContext('2d'); setInterval(() => { g.fillStyle = 'hsl(' + (Date.now() / 20 % 360) + ',70%,50%)'; g.fillRect(0, 0, 320, 180) }, 50)
        const v = document.getElementById('v'); v.srcObject = c.captureStream(20); v.play()</script></body>`)
    }
    if (url.startsWith('/sl-form')) {
      return res.end(`<title>sl form</title><body><form id="f"><input id="q" type="text"><textarea id="t"></textarea></form>
        <script>document.getElementById('f').addEventListener('submit', (e) => e.preventDefault())
        // Fills the field itself, again and again (the watcher is only installed once the document is ready): none of it is the user's typing.
        if (location.search === '?prefilled') { const q = document.getElementById('q'); setInterval(() => { q.value = 'filled by the page ' + Date.now(); q.dispatchEvent(new Event('input', { bubbles: true })) }, 150) }</script></body>`)
    }
    if (url.startsWith('/sl-live')) {
      // Counts on a timer and keeps a value: a frozen page stops counting and keeps both.
      return res.end(`<title>sl live</title><body><input id="q" type="text"><script>window.ticks = 0; window.secret = 'kept-' + Math.random().toString(36).slice(2, 8); setInterval(() => window.ticks++, 20)</script></body>`)
    }
    res.end(`<title>sl ${url}</title><body>page ${url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const other = `http://localhost:${port}`

  // ---- helpers ----
  const mine = new Set<string>()
  const live = (id: string) => browser.livePageIds().includes(id)
  const runtimeOf = (id: string) => browser.snapshot().runtime.tabs[id]
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const select = (id: string) => browser.dispatch({ type: 'tab/select', id })
  const open = async (url: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = tabs().at(-1)!
    mine.add(tab.id)
    await waitFor(() => tabs().find((t) => t.id === tab.id)?.title.startsWith('sl ') === true)
    return tab.id
  }
  /**
   * The two answers that are the state of a slow machine and not a rule that keeps the tab awake: its page is still loading ("loading", a page that was just
   * made when its tab woke), or has not yet answered the question the sweep puts to it ("unchecked"). The product is right to wait in both cases; a check that
   * asks 150 ms after the wake is not. Measured on a GitHub runner: the blocker was "loading" with `runtime.loading` true, and "unchecked" with the machine busy.
   */
  const SETTLING = new Set<string | null>(['loading', 'unchecked'])
  const SETTLE_WITHIN_MS = 20_000
  /** The blocker of a tab, asked again while it is only that: until the page is loaded and answers, or after `SETTLE_WITHIN_MS` (the check then says what it saw). */
  const blockerOf = async (id: string) => {
    const deadline = Date.now() + SETTLE_WITHIN_MS
    let blocker = await browser.sleepBlockerOf(id)
    while (SETTLING.has(blocker) && Date.now() < deadline) {
      await sleep(250)
      blocker = await browser.sleepBlockerOf(id)
    }
    return blocker
  }
  /** Lets the delay pass (it is a few milliseconds here), waits for the pages of the checks to be loaded and to answer, then sweeps. */
  const sweep = async (): Promise<string[]> => {
    await sleep(200)
    for (const id of mine) if (live(id)) await blockerOf(id)
    return browser.sleepSweep()
  }
  /** Why the delay would leave the tab awake once its idle time has passed, or null when it would put it to sleep. */
  const why = async (id: string) => {
    await sleep(150)
    return blockerOf(id)
  }
  const menu = (id: string) => menuItems({ kind: 'tab', id }, browser, store, win, { headers: true })
  const entry = (id: string, label: string) => menu(id).find((i) => i.label === label)
  const click = (id: string, label: string) => (entry(id, label)?.click as (() => void) | undefined)?.()
  /** A script run in the page; a frozen page never answers, which is what this tells apart. */
  const ask = <T>(id: string, js: string): Promise<T | 'unanswered'> => {
    const wc = wcOf(id)
    return wc ? Promise.race([wc.executeJavaScript(js) as Promise<T>, sleep(1500).then(() => 'unanswered' as const)]) : Promise.resolve('unanswered' as const)
  }
  const typeKeys = async (wc: WebContents, text: string) => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(30)
    }
    await sleep(100)
  }
  const pressEnter = async (wc: WebContents) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(150)
  }
  /** Types into the first field of a form page the user is looking at, with real key events. Resolves what the field then holds. */
  const typeInto = async (id: string, text: string): Promise<string> => {
    select(id)
    const wc = wcOf(id)!
    wc.focus()
    await wc.executeJavaScript(`document.getElementById('q').focus()`)
    await typeKeys(wc, text)
    return (await wc.executeJavaScript(`document.getElementById('q').value`)) as string
  }

  // Tabs of the checks that ran before are not mine to put to sleep: mark them for the time of these checks.
  const preexisting = tabs().filter((t) => t.keepAwake !== true).map((t) => t.id)
  for (const id of preexisting) browser.dispatch({ type: 'tab/keep-awake', id, keep: true })
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0.001, sleepMode: 'discard', sleepExcludedHosts: [], sleepSkipAudible: true, sleepSkipPinned: false, sleepNotify: false } })

  await section('the sweep', async () => {
    const a = await open(`${base}/sl-a`)
    const b = await open(`${base}/sl-b`)
    check('the page of a background tab is alive before the sweep', live(a) && live(b) && runtimeOf(a)?.awake === true, JSON.stringify({ a: [live(a), runtimeOf(a)], b: [live(b), runtimeOf(b)] }))
    const blocker = await why(a)
    const slept = await sweep()
    check('the sweep puts the idle background tab to sleep and returns it', blocker === null && slept.includes(a) && !live(a), JSON.stringify({ blocker, slept }))
    check('and leaves the selected tab awake', live(b) && !slept.includes(b))
    check('the sidebar shows the sleeping tab as asleep', runtimeOf(a)?.awake === false)
    check('the sleeping tab keeps its place in the sidebar', tabs().some((t) => t.id === a))
    select(a)
    check('selecting a sleeping tab wakes it', live(a) && runtimeOf(a)?.awake === true)
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })
    select(b)
    // No wait: the setting and the selection are in the state as soon as they are dispatched, and the questions below are asked of it.
    check('with the delay set to "never", nothing sleeps', (await why(a)) === 'disabled' && (await browser.sleepSweep()).length === 0 && live(a))
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 30 } })
    const longWhy = await why(a)
    const longSwept = await browser.sleepSweep()
    check('with a long delay, a tab left a moment ago stays awake', longWhy === 'recent' && longSwept.length === 0 && live(a), JSON.stringify({ why: longWhy, swept: longSwept, live: live(a), runtime: runtimeOf(a) }))
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0.001 } })
    const controlSwept = await sweep()
    check('and sleeps once the delay is short (control)', controlSwept.includes(a), JSON.stringify({ swept: controlSwept, runtime: runtimeOf(a) }))
  })

  await section('the mark on a tab, from its menu', async () => {
    const x = await open(`${base}/sl-x`)
    await open(`${base}/sl-z`)
    check('the menu offers "Ne jamais mettre cet onglet en veille", unchecked', entry(x, 'Ne jamais mettre cet onglet en veille')?.type === 'checkbox' && entry(x, 'Ne jamais mettre cet onglet en veille')?.checked === false)
    click(x, 'Ne jamais mettre cet onglet en veille')
    check('choosing it marks the tab in the state, and the menu then shows it checked', tabs().find((t) => t.id === x)?.keepAwake === true && entry(x, 'Ne jamais mettre cet onglet en veille')?.checked === true)
    check('a marked tab is left awake by the sweep', (await why(x)) === 'keep-awake' && !(await sweep()).includes(x) && live(x))
    click(x, 'Ne jamais mettre cet onglet en veille')
    check('choosing it again removes the mark', tabs().find((t) => t.id === x)?.keepAwake === undefined)
    check('and the tab then sleeps (control)', (await sweep()).includes(x) && !live(x))
  })

  await section('the site, from the menu and from the list', async () => {
    const onList = await open(`${other}/sl-listed`)
    const elsewhere = await open(`${base}/sl-unlisted`)
    await open(`${base}/sl-z`)
    check('the menu offers "Garder un onglet de ce site éveillé", unchecked', entry(onList, 'Garder un onglet de ce site éveillé')?.type === 'checkbox' && entry(onList, 'Garder un onglet de ce site éveillé')?.checked === false && entry(onList, 'Garder un onglet de ce site éveillé')?.enabled !== false)
    click(onList, 'Garder un onglet de ce site éveillé')
    check('choosing it adds the host to the list, and the menu then shows it checked', settings().sleepExcludedHosts.join() === 'localhost' && entry(onList, 'Garder un onglet de ce site éveillé')?.checked === true, JSON.stringify(settings().sleepExcludedHosts))
    const slept = await sweep()
    check('a tab of the listed site is left awake while another site\'s tab sleeps', (await why(onList)) === 'excluded-site' && live(onList) && !slept.includes(onList) && slept.includes(elsewhere) && !live(elsewhere), JSON.stringify(slept))
    click(onList, 'Garder un onglet de ce site éveillé')
    check('choosing it again takes the host out', settings().sleepExcludedHosts.length === 0)
    check('and the tab then sleeps (control)', (await sweep()).includes(onList))
    // The entry is about a site: a page without a host (about:blank) cannot be listed.
    browser.dispatch({ type: 'tab/open', url: 'about:blank' })
    const blank = tabs().at(-1)!.id
    mine.add(blank)
    check('a page without a host cannot be excluded as a site', entry(blank, 'Garder un onglet de ce site éveillé')?.enabled === false)
  })

  await section('a tab that plays sound', async () => {
    // The audio page starts by itself: with Chromium's own autoplay rule (the default) it would stay silent, so this section lets it play.
    const autoplayBefore = store.get().settings.autoplayPolicy
    browser.dispatch({ type: 'settings/update', patch: { autoplayPolicy: 'allow' } })
    const audio = await open(`${base}/sl-audio`)
    const heard = await waitFor(() => runtimeOf(audio)?.audible === true, 10_000)
    await open(`${base}/sl-z`)
    check('a page playing sound is reported audible', heard)
    check('a tab playing sound is left awake', (await why(audio)) === 'audible' && !(await sweep()).includes(audio) && live(audio))
    browser.dispatch({ type: 'settings/update', patch: { sleepSkipAudible: false, autoplayPolicy: autoplayBefore } })
    check('and sleeps once the setting is off (control)', (await sweep()).includes(audio) && !live(audio))
    browser.dispatch({ type: 'settings/update', patch: { sleepSkipAudible: true } })
  })

  await section('a tab in Picture in Picture', async () => {
    const video = await open(`${base}/sl-pip`)
    await sleep(800)
    const entered = await browser.pictureInPicture(true)
    check('a playing video enters Picture in Picture', entered)
    await open(`${base}/sl-z`)
    check('a tab whose video floats is left awake', (await why(video)) === 'picture-in-picture' && !(await sweep()).includes(video) && live(video))
    const left = await browser.pageFor(video)?.setPictureInPicture(false)
    check('and sleeps once the video is back in its page (control)', left === true && (await sweep()).includes(video))
  })

  await section('a download in progress', async () => {
    const downloader = await open(`${base}/sl-down`)
    await open(`${base}/sl-z`)
    wcOf(downloader)!.downloadURL(`${base}/sl-slow`)
    check('a download starts and keeps running', await waitFor(() => browser.snapshot().downloads.some((d) => d.state === 'progressing')))
    check('the tab that started it is left awake', (await why(downloader)) === 'downloading' && !(await sweep()).includes(downloader) && live(downloader))
    ;(slowDownload as ServerResponse | null)?.end(Buffer.alloc(1536))
    check('the download ends', await waitFor(() => browser.snapshot().downloads.every((d) => d.state !== 'progressing')))
    check('and the tab then sleeps (control)', (await sweep()).includes(downloader))
  })

  await section('text typed and not sent', async () => {
    const typed = await open(`${base}/sl-form`)
    const held = await typeInto(typed, 'hello')
    check('real key events type into the field', held === 'hello', held)
    await open(`${base}/sl-z`)
    check('a tab holding text typed and not sent is left awake', (await why(typed)) === 'unsent-input' && !(await sweep()).includes(typed) && live(typed))

    // Sending it (Enter submits the form) makes the text "sent": the field may keep its content.
    select(typed)
    const wc = wcOf(typed)!
    wc.focus()
    await wc.executeJavaScript(`document.getElementById('q').focus()`)
    await pressEnter(wc)
    check('the text is still in the field after the form was submitted', (await wc.executeJavaScript(`document.getElementById('q').value`)) === 'hello')
    await open(`${base}/sl-z2`)
    check('and the tab then sleeps once the form was submitted (control)', (await why(typed)) === null && (await sweep()).includes(typed))

    // Emptying the field is enough too.
    const cleared = await open(`${base}/sl-form?second`)
    await typeInto(cleared, 'abc')
    const wc2 = wcOf(cleared)!
    for (let i = 0; i < 3; i++) {
      wc2.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc2.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      await sleep(40)
    }
    await open(`${base}/sl-z3`)
    check('a field typed in and emptied again does not hold the tab', (await wc2.executeJavaScript(`document.getElementById('q').value`)) === '' && (await why(cleared)) === null && (await sweep()).includes(cleared))

    // Text put there by the page itself is not the user's.
    const prefilled = await open(`${base}/sl-form?prefilled`)
    select(prefilled)
    await sleep(200)
    await open(`${base}/sl-z4`)
    check('a field filled by the page, not typed by the user, does not hold the tab', (await why(prefilled)) === null && (await sweep()).includes(prefilled))
  })

  await section('the split view and pinned tabs', async () => {
    const left = await open(`${base}/sl-left`)
    const right = await open(`${base}/sl-right`)
    const lone = await open(`${base}/sl-lone`)
    browser.dispatch({ type: 'split/create', tabId: left, withTabId: right })
    check('both panes of the split view are on screen', await waitFor(() => browser.visibleTabIds().includes(left) && browser.visibleTabIds().includes(right)))
    const reasons = [await why(left), await why(right)]
    const slept = await sweep()
    check('the panes of a visible split view are left awake while another idle tab sleeps', reasons.join() === 'selected,split-pane' && live(left) && live(right) && slept.includes(lone) && !slept.includes(left) && !slept.includes(right), JSON.stringify(slept))
    check('an extension asking to discard a pane on screen is refused too', (browser.sleepPage(right), live(right)))
    browser.dispatch({ type: 'split/remove', tabId: right })
    select(left)
    // The witness: the pane leaves the screen (its idle time starts then; the sweep lets the delay pass).
    await waitFor(() => !browser.visibleTabIds().includes(right))
    check('once out of the split view, the pane sleeps (control)', (await sweep()).includes(right))

    // Pinned tabs sleep like the others, unless the setting says otherwise.
    const pinned = await open(`${base}/sl-pinned`)
    await open(`${base}/sl-z`)
    browser.dispatch({ type: 'tab/pin', id: pinned })
    browser.dispatch({ type: 'settings/update', patch: { sleepSkipPinned: true } })
    check('with "ne pas mettre en veille les onglets épinglés", a pinned tab is left awake', (await why(pinned)) === 'pinned' && !(await sweep()).includes(pinned) && live(pinned))
    browser.dispatch({ type: 'settings/update', patch: { sleepSkipPinned: false } })
    check('and by default a pinned tab sleeps (control)', (await sweep()).includes(pinned) && !live(pinned) && tabs().some((t) => t.id === pinned && t.pinned))
  })

  await section('the tab menu', async () => {
    const x = await open(`${base}/sl-x`)
    const y = await open(`${base}/sl-y`)
    check('the entries are in their own block, "Veille", before the block that closes', (() => { const labels = menu(x).map((i) => i.label ?? '——'); const at = labels.indexOf('Mettre en veille'); return at > 0 && labels[at - 1] === 'Veille' && labels[at + 1] === 'Geler (garde la page en mémoire)' && labels[at + 2] === 'Ne jamais mettre cet onglet en veille' && labels[at + 3] === 'Garder un onglet de ce site éveillé' && labels[at + 4] === 'Archiver et fermer' && labels.indexOf('Fermer l’onglet') > at + 4 })(), menu(x).map((i) => i.label ?? '——').join(' | '))
    check('"Mettre en veille" and "Geler" are greyed out for the selected tab', entry(y, 'Mettre en veille')?.enabled === false && entry(y, 'Geler (garde la page en mémoire)')?.enabled === false)
    check('and available for another tab', entry(x, 'Mettre en veille')?.enabled !== false && entry(x, 'Geler (garde la page en mémoire)')?.enabled !== false)
    // The user asking beats what they protected: mark the tab and its site, then put it to sleep by hand.
    browser.dispatch({ type: 'tab/keep-awake', id: x, keep: true })
    browser.dispatch({ type: 'sleep/exclude-site', site: base, excluded: true })
    click(x, 'Mettre en veille')
    // The page is asked first whether it holds a draft it would lose (`release`), so it goes a moment after the click, not in it.
    check('"Mettre en veille" sleeps the tab at once, even marked and on a listed site', (await waitFor(() => !live(x))) && runtimeOf(x)?.awake === false && tabs().some((t) => t.id === x))
    check('a tab already asleep has nothing to put to sleep or freeze', entry(x, 'Mettre en veille')?.enabled === false && entry(x, 'Geler (garde la page en mémoire)')?.enabled === false)
    check('the checkboxes reflect the tab and the site', entry(x, 'Ne jamais mettre cet onglet en veille')?.checked === true && entry(x, 'Garder un onglet de ce site éveillé')?.checked === true)
    browser.dispatch({ type: 'sleep/exclude-site', site: base, excluded: false })
    // A pinned tab keeps its usual "Mettre en veille" (its close), and none is added.
    browser.dispatch({ type: 'tab/pin', id: y })
    const labels = menu(y).map((i) => i.label)
    check('a pinned tab has a single "Mettre en veille"', labels.filter((l) => l === 'Mettre en veille').length === 1 && labels.includes('Geler (garde la page en mémoire)'))
    browser.dispatch({ type: 'tab/unpin', id: y })
  })

  await section('freezing', async () => {
    const frozenTab = await open(`${base}/sl-live`)
    const wc = wcOf(frozenTab)!
    wc.focus()
    await wc.executeJavaScript(`document.getElementById('q').focus()`)
    await typeKeys(wc, 'kept')
    const before = (await wc.executeJavaScript(`({ ticks: window.ticks, secret: window.secret, typed: document.getElementById('q').value })`)) as { ticks: number; secret: string; typed: string }
    await open(`${base}/sl-z`)
    check('the page counts on a timer before it is frozen', before.ticks > 0 && before.typed === 'kept')
    click(frozenTab, 'Geler (garde la page en mémoire)')
    check('"Geler" freezes the tab: the page stays in memory and the sidebar shows it asleep', await waitFor(() => browser.sleepStateOf(frozenTab) === 'frozen') && live(frozenTab) && runtimeOf(frozenTab)?.awake === false)
    check('a frozen page runs nothing: it does not even answer a script', (await ask(frozenTab, '1')) === 'unanswered')
    check('freezing leaves no debugger session of its own attached (an extension can still attach)', browser.pageFor(frozenTab)?.isDebugAttached() === false)
    // A frozen tab's menu offers « Dégeler l’onglet » where an awake one offers « Geler » (it is thawed in place): freezing it again is not offered.
    check('a frozen tab can be put to sleep for good from the menu, and cannot be frozen again', entry(frozenTab, 'Mettre en veille')?.enabled === true && entry(frozenTab, 'Geler (garde la page en mémoire)') === undefined && entry(frozenTab, 'Dégeler l’onglet')?.enabled !== false)
    // Asking a frozen page would wait for the full time-out: the sweep must not.
    const sweepStart = Date.now()
    const swept = await sweep()
    check('a sweep leaves a frozen tab alone, without waiting for it', !swept.includes(frozenTab) && live(frozenTab) && Date.now() - sweepStart < 2500, `${Date.now() - sweepStart} ms`)
    select(frozenTab)
    check('selecting it wakes it at once', browser.sleepStateOf(frozenTab) === 'awake' && runtimeOf(frozenTab)?.awake === true)
    const after = await waitFor(async () => (await ask<{ ticks: number }>(frozenTab, `({ ticks: window.ticks })`)) !== 'unanswered', 5000)
    const state = (await ask<{ ticks: number; secret: string; typed: string }>(frozenTab, `({ ticks: window.ticks, secret: window.secret, typed: document.getElementById('q').value })`)) as { ticks: number; secret: string; typed: string }
    check('the thawed page answers again with the state it had: same variables, same text in the field', after && state.secret === before.secret && state.typed === 'kept' && state.ticks >= before.ticks, JSON.stringify({ before, state }))
    await sleep(400)
    const later = (await ask<number>(frozenTab, 'window.ticks')) as number
    check('and its timers run again', later > state.ticks, `${state.ticks} -> ${later}`)

    // A debugger session an extension holds is used, and left in place.
    const held = await open(`${base}/sl-held`)
    await open(`${base}/sl-z5`)
    browser.pageFor(held)!.debugAttach('1.3', () => {}, () => {}, () => true)
    click(held, 'Geler (garde la page en mémoire)')
    check('a page an extension debugs can be frozen, and its debugger session stays', (await waitFor(() => browser.sleepStateOf(held) === 'frozen')) && browser.pageFor(held)?.isDebugAttached() === true)
    // Loading a frozen page again (a Tweak changed, a pinned tab sent back to its address) gives it a live document.
    browser.pageFor(held)!.reload()
    check('a frozen page that is loaded again is awake again, in the sidebar and in fact', (await waitFor(() => browser.sleepStateOf(held) === 'awake' && runtimeOf(held)?.awake === true)) && (await waitFor(async () => (await ask(held, '1')) === 1, 6000)))
    browser.pageFor(held)?.debugDetach()

    // Selected while the protocol was still answering: the page must not stay frozen.
    const racing = await open(`${base}/sl-race`)
    await open(`${base}/sl-z6`)
    const pending = browser.sleepNow(racing, 'freeze')
    select(racing)
    check('a tab selected while it was being frozen is not left frozen', (await pending) === false && browser.sleepStateOf(racing) === 'awake' && (await waitFor(async () => (await ask(racing, '1')) === 1, 5000)))

    // The delay does it too when the mode says so. The tab with text typed in it is still held back.
    browser.dispatch({ type: 'settings/update', patch: { sleepMode: 'freeze' } })
    await open(`${base}/sl-z2`)
    check('whatever the mode, text typed and not sent still holds a tab', (await why(frozenTab)) === 'unsent-input')
    const slept = await sweep()
    check('with the mode "Geler", the sweep freezes the idle tab instead of closing its page', slept.includes(racing) && !slept.includes(frozenTab) && browser.sleepStateOf(racing) === 'frozen' && live(racing))
    check('and it does not answer scripts', (await ask(racing, '1')) === 'unanswered')
    browser.dispatch({ type: 'tab/close', id: racing })
    check('closing a frozen tab removes it', !tabs().some((t) => t.id === racing) && !live(racing))
    browser.dispatch({ type: 'settings/update', patch: { sleepMode: 'discard' } })
  })

  await section('the notice', async () => {
    browser.dispatch({ type: 'settings/update', patch: { sleepNotify: true } })
    const a = await open(`${base}/sl-n1`)
    await open(`${base}/sl-z`)
    const slept = await sweep()
    const toast = browser.snapshot().toast
    check('a tab put to sleep by the delay shows "Onglet mis en veille" with a "Réveiller" button', slept.join() === a && toast?.message === 'Onglet mis en veille' && toast.action === 'Réveiller', JSON.stringify(toast))
    browser.runToastAction(toast!.id)
    check('"Réveiller" selects the tab and wakes it', store.get().activeTabBySpace[tabs().find((t) => t.id === a)!.spaceId] === a && live(a) && browser.snapshot().toast === null)

    const b = await open(`${base}/sl-n2`)
    const c = await open(`${base}/sl-n3`)
    await open(`${base}/sl-z`)
    const several = await sweep()
    const message = browser.snapshot().toast
    check('several tabs at once give one notice with their number, and nothing single to wake', several.length >= 3 && several.includes(b) && several.includes(c) && message?.message === `${several.length} onglets mis en veille` && message.action === undefined, JSON.stringify(message))

    browser.dispatch({ type: 'settings/update', patch: { sleepNotify: false } })
    const d = await open(`${base}/sl-n4`)
    await open(`${base}/sl-z`)
    const lastToast = browser.snapshot().toast?.id
    await sweep()
    check('with the setting off (the default), a tab put to sleep says nothing', !live(d) && browser.snapshot().toast?.id === lastToast)

    // By hand, no notice either: the user did it.
    const e = await open(`${base}/sl-n5`)
    await open(`${base}/sl-z`)
    const toastBefore = browser.snapshot().toast?.id
    click(e, 'Mettre en veille')
    check('and putting a tab to sleep by hand says nothing', (await waitFor(() => !live(e))) && browser.snapshot().toast?.id === toastBefore)
  })

  // ---- the settings window ----
  await section('the Settings window', async () => {
    const windows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
    // The sleep options are in the Onglets category (Settings in eight categories).
    browser.openOverlay({ panel: 'settings', pane: 'tabs' })
    await waitFor(() => windows().length === 1)
    const wc = windows()[0]!.webContents
    const run = <T>(js: string) => wc.executeJavaScript(js) as Promise<T>
    await waitFor(async () => (await run<number>(`document.querySelectorAll('.pref-row').length`)) > 0)
    const rowOf = (text: string) => `[...document.querySelectorAll('.pref-row')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`
    // The title of a group carries the number of its settings (« Mise en veille9 »): they are read by their beginning.
    const groupTitles = await run<string[]>(`[...document.querySelectorAll('.pref-section h3')].map((h) => h.textContent)`)
    check('the Onglets pane has a "Mise en veille" group, with the row of the subpage of the sites kept awake', groupTitles.some((title) => title.startsWith('Mise en veille')) && (await run<boolean>(`(() => { const g = [...document.querySelectorAll('.pref-section')].find((s) => s.querySelector('h3')?.textContent.startsWith('Mise en veille')); return !!g?.querySelector('[data-subpage-entry="awake"]') })()`)), groupTitles.join(' | '))
    check('the delay row sits in the "Mise en veille" group', await run<boolean>(`(() => { const g = [...document.querySelectorAll('.pref-section')].find((s) => s.querySelector('h3')?.textContent.startsWith('Mise en veille')); return !!g && g.textContent.includes('Mettre en veille les onglets inactifs') })()`))

    const toggle = (text: string) => run<string>(`(() => { const input = ${rowOf(text)}?.querySelector('input[type=checkbox]'); if (!input) return 'missing'; input.click(); return 'ok' })()`)
    const wasAudible = settings().sleepSkipAudible
    await toggle('Ne pas mettre en veille les onglets qui jouent du son')
    check('the sound switch changes the setting', await waitFor(() => settings().sleepSkipAudible === !wasAudible))
    await toggle('Ne pas mettre en veille les onglets qui jouent du son')
    await toggle('Ne pas mettre en veille les onglets épinglés')
    check('the pinned-tabs switch changes the setting', await waitFor(() => settings().sleepSkipPinned === true))
    await toggle('Ne pas mettre en veille les onglets épinglés')
    await toggle('Prévenir à chaque mise en veille')
    check('the notice switch changes the setting', await waitFor(() => settings().sleepNotify === true))
    await toggle('Prévenir à chaque mise en veille')

    const setValue = (selector: string, value: string) =>
      run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const select = el instanceof HTMLSelectElement
        Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true })); return 'ok' })()`)
    await setValue('select[aria-label="Mode de veille"]', 'freeze')
    check('the mode choice sets "Geler"', await waitFor(() => settings().sleepMode === 'freeze'))
    check('and its hint says the page stays in memory', await waitFor(async () => (await run<string>(`${rowOf('Mode de veille')}?.textContent ?? ''`)).includes('reste en mémoire')))
    await setValue('select[aria-label="Mode de veille"]', 'discard')
    check('and "Libérer la mémoire" brings the other back', await waitFor(() => settings().sleepMode === 'discard'))

    // The sites kept awake are on their subpage: its row opens it.
    await run(`document.querySelector('[data-subpage-entry="awake"] button')?.click()`)
    check('the row « Sites gardés éveillés » opens its subpage, the list of sites under its title', await waitFor(async () => (await run<string>(`document.querySelector('#pane-heading')?.textContent ?? ''`)) === 'Sites gardés éveillés' && (await run<string[]>(`[...document.querySelectorAll('.pref-section h3')].map((h) => h.textContent)`)).some((title) => title.startsWith('Sites gardés éveillés, un onglet chacun'))))
    const field = 'input[aria-label="Site à garder éveillé"]'
    const addDisabled = () => run<boolean>(`(() => { const b = [...document.querySelectorAll('.pref-form .button')].find((x) => x.textContent.trim() === 'Ajouter'); return b ? b.disabled : true })()`)
    check('"Ajouter" is off while the field is empty', await addDisabled())
    await setValue(field, 'pas un site !')
    check('something that is not a site gives its message and cannot be added', (await waitFor(async () => (await run<string>(`document.querySelector('.pref-error')?.textContent ?? ''`)) === 'Cette adresse de site n’est pas valide.')) && (await addDisabled()))
    await setValue(field, 'https://www.Exemple.org/une/page')
    check('an address is read as its host and can be added', (await waitFor(async () => !(await addDisabled()))) && (await run<string>(`document.querySelector('.pref-error')?.textContent ?? ''`)) === '')
    await run(`[...document.querySelectorAll('.pref-form .button')].find((x) => x.textContent.trim() === 'Ajouter').click()`)
    check('adding puts the host in the settings and in the list, and empties the field', (await waitFor(() => settings().sleepExcludedHosts.join() === 'exemple.org')) && (await waitFor(async () => (await run<string>(`${rowOf('exemple.org')}?.textContent ?? ''`)).includes('exemple.org'))) && (await run<string>(`document.querySelector(${JSON.stringify(field)}).value`)) === '')
    await setValue(field, 'mail.exemple.org')
    check('a site its parent already covers is refused with a reason', await waitFor(async () => (await run<string>(`document.querySelector('.pref-error')?.textContent ?? ''`)) === frenchSpaces('Ce site est déjà couvert par « exemple.org ».')))
    await setValue(field, '')
    await run(`document.querySelector('button[aria-label="Retirer exemple.org"]')?.click()`)
    check('"Retirer" takes the host out', await waitFor(() => settings().sleepExcludedHosts.length === 0))
    check('and the list says there is no site', await waitFor(async () => (await run<string>(`[...document.querySelectorAll('.pref-section')].map((s) => s.textContent ?? '').join(' ')`)).includes('Aucun site')))
    for (const w of windows()) w.close()
  })

  // ---- put everything back ----
  browser.dispatch({ type: 'settings/update', patch: original })
  for (const id of preexisting) browser.dispatch({ type: 'tab/keep-awake', id, keep: false })
  slowDownload = null
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
