// Engine checks for the layer of the page annotation (shared/page-annotate-layer.ts), run inside a real Electron: what a real page sees of it.
// A local server hands out a page that watches itself as hard as it can before the layer is there (a lure under the layer's own name, an
// `attachShadow` of its own that opens every shadow root, listeners on its document for every event of the pointer and of the keyboard), and a page
// with a strict content policy. The layer is driven through the port of the engine (`Page.runAnnotateLayer`), which is what the annotation calls
// (main/shell/page-annotate.ts, held by its unit tests), and by real mouse and key events. A session is started once, at the end, for what only a
// window shows of its bar: the hue it takes from the space on screen (the shortcut is not pressed here), and the automatic clearing of the setting (main's
// clock, the timer of the bar, its Annuler). No check waits a fixed time: what the layer did, and the picture that shows it, are waited for, and what the page must not have seen is read after it (the
// stroke or the text that is there is the witness that the events were delivered). Run alone with `LUCIUM_SMOKE_ONLY=annotate`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow, nativeImage, webContents as allWebContents, type WebContents } from 'electron'
import { PAGE_ANNOTATE_WORLD, pageLayerCall, type PageLayerConfig } from '@shared/page-annotate-layer'
import type { Page } from './engine/types'
import { notifyAnnotateRequest } from './shell/page-annotate'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, reportFact, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(10_000, 60)

const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'wheel']
const KEY_EVENTS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionend', 'paste']

/** The watching page. Everything it sets up is in place before the layer is made: a page cannot be more ready than that. */
const WATCHING = `<!doctype html><html><head><meta charset="utf-8"><title>Page qui regarde</title>
<script>
// A lure under the name the layer keeps its state under: a layer in the page's own world would take it for its own, or write over it.
window.__luciumAnnotate = { lure: true, input: {}, elements: ['lure'] }
window.__seen = { shadows: 0, document: [], windowFirst: [], where: [], mutations: 0 }
// Every change of the document the page can see (its tree, the attributes, the texts): the shadow root of the layer is closed to it.
new MutationObserver((records) => { window.__seen.mutations += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
// Every shadow root made with the page's own attachShadow is opened, and counted.
const realAttach = Element.prototype.attachShadow
Element.prototype.attachShadow = function (init) { window.__seen.shadows++; return realAttach.call(this, Object.assign({}, init, { mode: 'open' })) }
for (const type of ${JSON.stringify([...POINTER_EVENTS, ...KEY_EVENTS])}) {
  // On the document, in both phases: what any script of a page does.
  document.addEventListener(type, (event) => {
    window.__seen.document.push(type + (event.key ? ':' + event.key : '') + (event.data ? ':' + event.data : ''))
    // Where a pointer event was, for the detail of a check that fails: the drag of the test, or a pointer that is not the test's.
    if (typeof event.clientX === 'number') window.__seen.where.push(type + '@' + event.clientX + ',' + event.clientY)
  }, true)
  document.addEventListener(type, (event) => window.__seen.document.push(type + (event.key ? ':' + event.key : '') + (event.data ? ':' + event.data : '')))
  // On the window for the capture phase, before the layer exists: the one place a page can stand ahead of the layer (the limit the docs give).
  window.addEventListener(type, () => window.__seen.windowFirst.push(type), true)
}
</script></head>
<body style="margin:0;background:#ffffff;height:3000px"><p id="text" style="margin:0;padding:400px 20px 0">Texte de la page</p></body></html>`

const STRICT = `<!doctype html><title>Stricte</title><body style="margin:0;background:#ffffff"><p>Page à la politique stricte</p></body>`

const PEN: PageLayerConfig = { mode: 'draw', brush: { tool: 'pen', color: '#e53935', width: 8 } }
const ERASER: PageLayerConfig = { mode: 'draw', brush: { tool: 'eraser', color: '#e53935', width: 8 } }
const TEXT: PageLayerConfig = { mode: 'draw', brush: { tool: 'text', color: '#e53935', width: 4 } }
const PASS: PageLayerConfig = { mode: 'pass', brush: PEN.brush }

export async function smokeAnnotate(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store } = ctx
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    if (path === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (path === '/strict') {
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'none'; script-src 'none'; require-trusted-types-for 'script'")
      return void res.end(STRICT)
    }
    res.end(WATCHING)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const previousSpace = store.get().activeSpaceId
  // A hue that is not the one the tokens start from (250): the bar of a session must show this one.
  browser.dispatch({ type: 'space/create', name: 'Annotation', emoji: '✏️', hue: 30 })
  const spaceId = store.get().activeSpaceId
  const sleepAfter = store.get().settings.sleepAfterMinutes
  const clearingBefore = { annotateAutoClear: store.get().settings.annotateAutoClear, annotateAutoClearSeconds: store.get().settings.annotateAutoClearSeconds, annotateLetterKeys: store.get().settings.annotateLetterKeys }
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  const wcOf = (url: string) => allWebContents.getAllWebContents().find((w) => w.getURL() === url && !w.isDestroyed())
  /** A tab on `url`: its web contents (the real mouse and keys, the page's own world) and its page of the engine (the layer's world). */
  const openTab = async (url: string): Promise<{ wc: WebContents; page: Page } | null> => {
    browser.dispatch({ type: 'tab/open', url, spaceId })
    await waitFor(() => wcOf(url) !== undefined && !wcOf(url)!.isLoading(), 10_000)
    const wc = wcOf(url)
    const tab = store.get().tabs.find((one) => one.spaceId === spaceId && one.url === url)
    const page = tab ? browser.pageFor(tab.id) : undefined
    return wc && page ? { wc, page } : null
  }
  /** The window of the bar of a session, while one runs. */
  const barWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes('page-annotate-command'))
  const inPage = <T>(wc: WebContents, script: string) => wc.executeJavaScript(script) as Promise<T>
  /** What the layer's own world answers: the state of the layer, which only main may read. */
  const inLayer = <T>(wc: WebContents, code: string) => wc.executeJavaScriptInIsolatedWorld(PAGE_ANNOTATE_WORLD, [{ code }]) as Promise<T>
  const layer = (page: Page, call: string): Promise<unknown> => (page.runAnnotateLayer ? page.runAnnotateLayer(call) : Promise.reject(new Error('this page has no world for the layer')))
  const drawnIn = (wc: WebContents) => inLayer<number>(wc, `window.__luciumAnnotate ? window.__luciumAnnotate.elements.length : -1`)
  const seen = (wc: WebContents) => inPage<{ shadows: number; document: string[]; windowFirst: string[]; where: string[]; mutations: number }>(wc, `JSON.parse(JSON.stringify(window.__seen))`)

  const mouse = (wc: WebContents, type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number, pressed = false) =>
    wc.sendInputEvent({ type, x, y, button: 'left', clickCount: type === 'mouseMove' ? 0 : 1, modifiers: pressed ? ['leftbuttondown'] : [] })
  /** A drag with the real mouse, from one point to another, in a few moves. */
  const drag = (wc: WebContents, from: [number, number], to: [number, number]): void => {
    mouse(wc, 'mouseMove', from[0], from[1])
    mouse(wc, 'mouseDown', from[0], from[1])
    for (let step = 1; step <= 6; step++) mouse(wc, 'mouseMove', Math.round(from[0] + ((to[0] - from[0]) * step) / 6), Math.round(from[1] + ((to[1] - from[1]) * step) / 6), true)
    mouse(wc, 'mouseUp', to[0], to[1])
  }
  const click = (wc: WebContents, x: number, y: number): void => {
    mouse(wc, 'mouseMove', x, y)
    mouse(wc, 'mouseDown', x, y)
    mouse(wc, 'mouseUp', x, y)
  }
  const type = (wc: WebContents, text: string): void => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
    }
  }
  /** The colour the picture of the page has at a point of it (CSS pixels): what a capture, or a shared window, shows there. */
  const pixel = async (wc: WebContents, page: Page, x: number, y: number): Promise<{ r: number; g: number; b: number }> => {
    const image = nativeImage.createFromBuffer(await page.capture(false))
    const width = await inPage<number>(wc, `window.innerWidth`)
    const scale = image.getSize().width / width
    const bitmap = image.toBitmap()
    const at = (Math.min(image.getSize().height - 1, Math.round(y * scale)) * image.getSize().width + Math.min(image.getSize().width - 1, Math.round(x * scale))) * 4
    // The bitmap is BGRA.
    return { r: bitmap[at + 2] ?? 0, g: bitmap[at + 1] ?? 0, b: bitmap[at] ?? 0 }
  }
  const isRed = (p: { r: number; g: number; b: number }): boolean => p.r > 180 && p.g < 110 && p.b < 110
  const isWhite = (p: { r: number; g: number; b: number }): boolean => p.r > 235 && p.g > 235 && p.b > 235
  /**
   * The colour at a point once the picture shows `wanted`, or the last one read when it never does. The picture is painted after the change of the
   * layer: a capture taken at once may still be the frame before it (white just after a stroke, red just after the eraser).
   */
  const pixelOnceShown = async (wc: WebContents, page: Page, x: number, y: number, wanted: (p: { r: number; g: number; b: number }) => boolean): Promise<{ r: number; g: number; b: number }> => {
    let last = await pixel(wc, page, x, y)
    await waitFor(async () => wanted((last = await pixel(wc, page, x, y))), 4000)
    return last
  }

  try {
    const opened = await openTab(`${base}/watching`)
    check('annotate world: the watching page is open, with its page of the engine', opened !== null)
    if (!opened) return
    const { wc, page } = opened
    wc.focus()

    // ---- the layer is made: the page finds an element over it, and nothing in it ----
    // What the page got before the layer was there is its own (the engine moves the pointer over a page that has just loaded under it, to know
    // what it hovers): it is reported, not judged, and the record starts again with the layer.
    reportFact('annotate.pageEventsBeforeLayer', (await seen(wc)).where)
    await inPage(wc, `window.__seen.document = []; window.__seen.windowFirst = []; window.__seen.where = []; window.__seen.mutations = 0; void 0`)
    check('annotate world: the layer is made on a page that watches itself', (await layer(page, pageLayerCall('mount', PEN))) === true)
    const lure = await inPage<string>(wc, `JSON.stringify(window.__luciumAnnotate)`)
    check('annotate world: the name the layer keeps its state under is still the page’s own in the page’s world (the lure is untouched)', lure === JSON.stringify({ lure: true, input: {}, elements: ['lure'] }), lure)
    check('annotate world: the state of the layer is in the layer’s world, empty for now', (await drawnIn(wc)) === 0, String(await drawnIn(wc)))
    check('annotate world: the layer did not use the `attachShadow` the page replaced', (await seen(wc)).shadows === 0, JSON.stringify(await seen(wc)))
    const host = await inPage<{ tag: string; root: boolean; children: number; html: string } | null>(
      wc,
      `(() => { const h = document.documentElement.lastElementChild; return h ? { tag: h.tagName, root: h.shadowRoot !== null, children: h.childNodes.length, html: h.innerHTML } : null })()`
    )
    check('annotate world: what the page finds is an element with nothing in it: its shadow root is closed to the page', host?.tag === 'DIV' && host.root === false && host.children === 0 && host.html === '', JSON.stringify(host))

    // ---- a stroke: drawn, in the picture, and unseen by the page ----
    drag(wc, [100, 100], [300, 300])
    check('annotate world: a stroke drawn with the real mouse is kept by the layer', await waitFor(async () => (await drawnIn(wc)) === 1, 4000), String(await drawnIn(wc)))
    // The engine may hand several moves of the mouse to the page as one: the press and one move at least.
    const points = await inLayer<number>(wc, `window.__luciumAnnotate.elements[0] ? window.__luciumAnnotate.elements[0].points.length : 0`)
    check('annotate world: …with the points of the drag', points >= 2, String(points))
    const onStroke = await pixelOnceShown(wc, page, 200, 200, isRed)
    check('annotate world: the stroke is in the picture of the page (a capture shows it, so does a shared window)', isRed(onStroke), JSON.stringify(onStroke))
    const afterStroke = await seen(wc)
    check('annotate world: the listeners of the page’s document got nothing of the pointer that drew', afterStroke.document.length === 0, JSON.stringify({ events: afterStroke.document.slice(0, 12), where: afterStroke.where.slice(0, 12) }))
    const found = await inPage<number>(wc, `document.querySelectorAll('svg, path').length + (document.documentElement.lastElementChild.shadowRoot ? 1 : 0)`)
    check('annotate world: the page finds no drawing in its document', found === 0, String(found))
    check('annotate world: the lure is still untouched after the stroke', (await inPage<string>(wc, `JSON.stringify(window.__luciumAnnotate)`)) === lure)

    // ---- the eraser ----
    await layer(page, pageLayerCall('apply', ERASER))
    drag(wc, [300, 100], [100, 300])
    check('annotate world: the eraser passed over the stroke takes it away', await waitFor(async () => (await drawnIn(wc)) === 0, 4000), String(await drawnIn(wc)))
    const erased = await pixelOnceShown(wc, page, 200, 200, isWhite)
    check('annotate world: …and the picture of the page is the page again', isWhite(erased), JSON.stringify(erased))
    check('annotate world: undo brings the stroke back', (await layer(page, pageLayerCall('undo'))) === true && (await drawnIn(wc)) === 1, String(await drawnIn(wc)))

    // ---- a text: typed, kept, and unread by the page ----
    await layer(page, pageLayerCall('apply', TEXT))
    click(wc, 120, 60)
    check('annotate world: a click with the text tool opens the text box, and the layer says the keys are its own', await waitFor(async () => (await layer(page, pageLayerCall('editing'))) === true, 4000))
    type(wc, 'Secret')
    // Enter as a keyboard types it: its press, the keypress it makes, and its release, which come after the box it ends is gone.
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'char', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    const textsOf = () => inLayer<string[]>(wc, `window.__luciumAnnotate.elements.filter((one) => one.kind === 'text').map((one) => one.text)`)
    check('annotate world: the text typed with the real keys is kept by the layer on Enter', await waitFor(async () => JSON.stringify(await textsOf()) === JSON.stringify(['Secret']), 4000), JSON.stringify(await textsOf()))
    const afterText = await seen(wc)
    check('annotate world: the listeners of the page’s document got no key and no text of the box', afterText.document.length === 0, JSON.stringify({ events: afterText.document.slice(0, 12), where: afterText.where.slice(0, 12) }))
    const read = await inPage<string>(wc, `document.documentElement.innerText + '|' + document.documentElement.outerHTML`)
    check('annotate world: the page reads the text nowhere in its document', !read.includes('Secret'))
    // The lure says a text box is open: a layer that read the page's world would answer that the keys are taken.
    check('annotate world: the page cannot answer in the layer’s place: with the box closed the layer says the keys are free, whatever the lure says', (await layer(page, pageLayerCall('editing'))) === false)

    // ---- the page tampers with what it can reach ----
    await inPage(wc, `window.__luciumAnnotate = undefined; delete window.__luciumAnnotate; void 0`)
    check('annotate world: the page dropping the name in its own world changes nothing for the layer', (await drawnIn(wc)) === 2, String(await drawnIn(wc)))
    check('annotate world: …which still answers main (undo takes the text away)', (await layer(page, pageLayerCall('undo'))) === true && (await drawnIn(wc)) === 1, String(await drawnIn(wc)))

    // ---- a text composed with an input method (Japanese, Chinese, Korean): its Enter and its Escape are the input method's ----
    // The composition is made through the DevTools protocol, the way an input method makes it in the engine: the keys sent meanwhile are marked
    // `isComposing` by the engine itself, and the commit ends the composition. Enter and Escape are sent with their own codes, not 229.
    await inPage(wc, `window.__seen.document = []; void 0`)
    click(wc, 120, 160)
    check('annotate world: a text box opens for a composed text', await waitFor(async () => (await layer(page, pageLayerCall('editing'))) === true, 4000))
    type(wc, 'Memo')
    const boxValue = () => inLayer<string | null>(wc, `window.__luciumAnnotate.input ? window.__luciumAnnotate.input.value : null`)
    await waitFor(async () => (await boxValue()) === 'Memo', 4000)
    const ownDebugger = !wc.debugger.isAttached()
    let composeFailure = ''
    try {
      if (ownDebugger) wc.debugger.attach('1.3')
      const press = async (name: 'Enter' | 'Escape'): Promise<void> => {
        const code = name === 'Enter' ? 13 : 27
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
      }
      await wc.debugger.sendCommand('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
      await waitFor(async () => (await boxValue()) === 'Memoにほん', 4000)
      await press('Enter')
      await press('Escape')
      const during = { editing: await layer(page, pageLayerCall('editing')), value: await boxValue(), texts: await textsOf() }
      check('annotate world: Enter and Escape typed while a text is composed leave the text box open, with the composition in it', during.editing === true && during.value === 'Memoにほん' && during.texts.length === 0, JSON.stringify(during))
      await wc.debugger.sendCommand('Input.insertText', { text: '日本' })
      await waitFor(async () => (await boxValue()) === 'Memo日本', 4000)
    } catch (error) {
      composeFailure = String((error as Error)?.message ?? error)
    } finally {
      if (ownDebugger && wc.debugger.isAttached()) wc.debugger.detach()
    }
    check('annotate world: the composition could be made through the DevTools protocol', composeFailure === '', composeFailure)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'char', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    check('annotate world: …and Enter once the composition is committed places the text whole, once', await waitFor(async () => JSON.stringify(await textsOf()) === JSON.stringify(['Memo日本']), 4000), JSON.stringify({ texts: await textsOf(), editing: await layer(page, pageLayerCall('editing')) }))
    const afterComposed = await seen(wc)
    const pageText = await inPage<string>(wc, `document.documentElement.innerText + '|' + document.documentElement.outerHTML`)
    check('annotate world: the page got nothing of the composition, and reads its text nowhere', afterComposed.document.length === 0 && !pageText.includes('日本') && !pageText.includes('にほん'), JSON.stringify(afterComposed.document.slice(0, 12)))
    check('annotate world: undo takes the composed text away', (await layer(page, pageLayerCall('undo'))) === true && (await drawnIn(wc)) === 1, String(await drawnIn(wc)))

    // ---- the automatic clearing, as the layer does it: main's clock is played here (ask the layer, wait what it answers, ask again) with a short delay,
    // which the layer takes from main's call as it is (the setting offers 3 s at least: the session below runs it); the page sees none of it ----
    const SHORT = 1200
    const CLEARING: PageLayerConfig = { ...PEN, autoClear: SHORT }
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const expire = (): Promise<unknown> => layer(page, pageLayerCall('expire'))
    const pageAnimations = () => inPage<number>(wc, `document.getAnimations().length + document.documentElement.lastElementChild.getAnimations({ subtree: true }).length`)
    // The witness of what the page sees of its document: it saw the host of the layer put in (an element over it, empty to its eyes), and nothing since.
    const witness = (await seen(wc)).mutations
    check('annotate clearing: the page’s record of its document works: it saw the host of the layer put in', witness > 0, String(witness))
    await layer(page, pageLayerCall('apply', CLEARING))
    await layer(page, pageLayerCall('clear'))
    await inPage(wc, `window.__seen.document = []; window.__seen.where = []; window.__seen.mutations = 0; void 0`)
    drag(wc, [100, 100], [300, 300])
    check('annotate clearing: a stroke is drawn with the clearing on', await waitFor(async () => (await drawnIn(wc)) === 1, 4000), String(await drawnIn(wc)))
    const early = await expire()
    check('annotate clearing: asked before the end of the delay, the layer keeps its marks and says what is left of it', typeof early === 'number' && early > 0 && early <= SHORT && (await drawnIn(wc)) === 1, String(early))
    // Main's clock: the layer answers the time to wait; the fade (400 ms) is seen on the way, and the page is asked what animations it can find meanwhile.
    let fadeSeen = false
    let animationsSeen = -1
    let ownAnimations = -1
    let wait: unknown = early
    const until = Date.now() + SHORT + 5000
    while ((await drawnIn(wc)) !== 0 && Date.now() < until) {
      await pause(typeof wait === 'number' && wait > 0 ? wait : 50)
      wait = await expire()
      if (wait === 400 && ownAnimations < 0) {
        // At the start of the fade, at the same moment: the layer's world finds the transition of its drawing, and the page is asked what it finds.
        ownAnimations = await inLayer<number>(wc, `window.__luciumAnnotate.svg.getAnimations().length`)
        animationsSeen = await pageAnimations()
        fadeSeen = await waitFor(async () => {
          const opacity = Number(await inLayer<string>(wc, `getComputedStyle(window.__luciumAnnotate.svg).opacity`))
          return opacity > 0 && opacity < 1
        }, 400)
      }
    }
    check('annotate clearing: the marks fade out (the engine draws the transition of the drawing, half transparent on the way)…', fadeSeen)
    check('annotate clearing: …and are cleared once the delay and the fade are over', (await drawnIn(wc)) === 0, String(await drawnIn(wc)))
    const clearedPixel = await pixelOnceShown(wc, page, 200, 200, isWhite)
    check('annotate clearing: …and the picture of the page is the page again', isWhite(clearedPixel), JSON.stringify(clearedPixel))
    const afterClearing = await seen(wc)
    check('annotate clearing: the layer’s world finds the transition of its drawing; the page finds none, from its document or from the host', ownAnimations > 0 && animationsSeen === 0, JSON.stringify({ ownAnimations, animationsSeen }))
    check(
      'annotate clearing: the page got no event and saw no change of its document while its marks faded and went',
      afterClearing.document.length === 0 && afterClearing.mutations === 0,
      JSON.stringify({ events: afterClearing.document.slice(0, 12), mutations: afterClearing.mutations })
    )
    check('annotate clearing: undo brings the cleared marks back', (await layer(page, pageLayerCall('undo'))) === true && (await drawnIn(wc)) === 1, String(await drawnIn(wc)))
    const afterUndo = await expire()
    // What is left of the delay, read three times: after the undo, after a pointer that wanders over the layer, after a stroke drawn with the real mouse.
    await pause(SHORT / 2)
    for (let step = 0; step < 6; step++) mouse(wc, 'mouseMove', 400 + step * 10, 150)
    const afterWander = await expire()
    drag(wc, [120, 320], [320, 420])
    await waitFor(async () => (await drawnIn(wc)) === 2, 4000)
    const afterStroke2 = await expire()
    check(
      'annotate clearing: the undo starts the delay again, a pointer that only wanders does not, a stroke does',
      typeof afterUndo === 'number' && typeof afterWander === 'number' && typeof afterStroke2 === 'number' && afterUndo > SHORT - 400 && afterWander < afterUndo - 300 && afterStroke2 > afterWander + 300,
      JSON.stringify({ afterUndo, afterWander, afterStroke2 })
    )
    await layer(page, pageLayerCall('apply', PEN))

    // ---- the pointer of the page stays the page's ----
    await layer(page, pageLayerCall('apply', PASS))
    click(wc, 60, 410)
    check('annotate world: in pass mode the clicks are the page’s again: its listeners get them', await waitFor(async () => (await seen(wc)).document.includes('click'), 4000), JSON.stringify((await seen(wc)).document.slice(0, 12)))

    // The limit the docs give, measured and not judged: a listener the page put on its window for the capture phase before the layer was made.
    reportFact('annotate.windowCaptureBeforeLayer', [...new Set((await seen(wc)).windowFirst)])

    check('annotate world: the layer is taken away', (await layer(page, pageLayerCall('remove'))) === true && (await drawnIn(wc)) === -1)
    check('annotate world: …and its element is gone from the page', (await inPage<string>(wc, `document.documentElement.lastElementChild.tagName`)) === 'BODY')

    // ---- a page with a strict policy ----
    const strict = await openTab(`${base}/strict`)
    check('annotate world: the strict page is open', strict !== null)
    if (strict) {
      strict.wc.focus()
      check('annotate world: a page that allows no script and no style of its own takes the layer all the same', (await layer(strict.page, pageLayerCall('mount', PEN))) === true)
      drag(strict.wc, [100, 100], [300, 300])
      check('annotate world: …and a stroke is drawn on it', await waitFor(async () => (await drawnIn(strict.wc)) === 1, 4000), String(await drawnIn(strict.wc)))
      const strictStroke = await pixelOnceShown(strict.wc, strict.page, 200, 200, isRed)
      check('annotate world: …and shown (the styles of the layer are not the page’s to refuse)', isRed(strictStroke), JSON.stringify(strictStroke))
      await layer(strict.page, pageLayerCall('remove'))
    }

    // ---- the bar of a session: its accent is the one of the space on screen ----
    const wantedHue = browser.annotationHue()
    check('annotate bar: the space of the test has a hue of its own', wantedHue !== null && wantedHue !== 250, String(wantedHue))
    // The session below clears its marks by itself, at the shortest delay of the setting; its page on screen is the watching page.
    browser.dispatch({ type: 'settings/update', patch: { annotateAutoClear: true, annotateAutoClearSeconds: 3 } })
    const watchingTab = store.get().tabs.find((one) => one.spaceId === spaceId && one.url === `${base}/watching`)
    if (watchingTab) browser.dispatch({ type: 'tab/select', id: watchingTab.id })
    notifyAnnotateRequest(browser.annotationSource())
    check('annotate bar: a session opens the bar', await waitFor(() => barWindow() !== undefined && !barWindow()!.webContents.isLoading(), 10_000))
    const bar = barWindow()
    if (bar) {
      const hueOfBar = (): Promise<string> => bar.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--hue').trim()`) as Promise<string>
      check('annotate bar: the root of the bar has the hue of the space on screen', await waitFor(async () => (await hueOfBar()) === String(wantedHue), 4000), await hueOfBar())
      // The accent the pressed tool is drawn with is worked out from that hue: it is not the one of the hue the tokens start from.
      const accents = (await bar.webContents.executeJavaScript(
        `(() => { const probe = (hue) => { const el = document.createElement('i'); el.className = 'tk-hue'; if (hue !== null) el.style.setProperty('--hue', hue); el.style.color = 'var(--accent)'; document.body.append(el); const color = getComputedStyle(el).color; el.remove(); return color }; return [probe(null), probe('250')] })()`
      )) as [string, string]
      check('annotate bar: its accent is the one of that hue, not of the hue the tokens start from', accents[0] !== accents[1], JSON.stringify(accents))
      // ---- the automatic clearing of a session: the setting at its shortest (3 s), main's clock, the timer of the bar and its Annuler ----
      check('annotate session: the page on screen has a layer', await waitFor(async () => (await drawnIn(wc)) === 0, 4000), String(await drawnIn(wc)))
      const timerOf = () =>
        bar.webContents.executeJavaScript(`(() => { const b = document.getElementById('page-annotate-timer'); return { on: b.dataset.on, label: b.getAttribute('aria-label'), text: b.textContent } })()`) as Promise<{ on: string; label: string; text: string }>
      check('annotate session: the timer of the bar shows the setting, on, with its delay', await waitFor(async () => { const timer = await timerOf(); return timer.on === 'true' && timer.text.includes('3') }, 4000), JSON.stringify(await timerOf()))
      wc.focus()
      await inPage(wc, `window.__seen.document = []; window.__seen.where = []; window.__seen.mutations = 0; void 0`)
      drag(wc, [100, 100], [300, 300])
      const drawnInSession = await waitFor(async () => (await drawnIn(wc)) === 1, 4000)
      const strokeAt = Date.now()
      check('annotate session: a stroke is drawn on the page of the session', drawnInSession, String(await drawnIn(wc)))
      // The page clears every timer it can name, in its own world: the clock of the clearing is main's, not one of them.
      await inPage(wc, `for (let id = 0; id < 50000; id++) { clearTimeout(id); clearInterval(id) } void 0`)
      const goneInSession = await waitFor(async () => (await drawnIn(wc)) === 0, 3000 + 400 + 5000)
      const elapsed = Date.now() - strokeAt
      check('annotate session: the marks go by themselves once 3 s have passed without activity, whatever timers the page clears', goneInSession && elapsed >= 3000, JSON.stringify({ gone: goneInSession, elapsed }))
      const seenInSession = await seen(wc)
      check(
        'annotate session: the page got no event and saw no change of its document meanwhile',
        seenInSession.document.length === 0 && seenInSession.mutations === 0,
        JSON.stringify({ events: seenInSession.document.slice(0, 12), mutations: seenInSession.mutations })
      )
      await bar.webContents.executeJavaScript(`document.getElementById('page-annotate-undo').click()`)
      check('annotate session: Annuler in the bar brings the cleared marks back', await waitFor(async () => (await drawnIn(wc)) === 1, 4000), String(await drawnIn(wc)))
      await bar.webContents.executeJavaScript(`document.getElementById('page-annotate-timer').click()`)
      check(
        'annotate session: a click on the timer goes to the next delay, in the settings and in the layer',
        await waitFor(async () => store.get().settings.annotateAutoClear && store.get().settings.annotateAutoClearSeconds === 5 && (await inLayer<number>(wc, `window.__luciumAnnotate.autoClear`)) === 5000, 4000),
        JSON.stringify({ on: store.get().settings.annotateAutoClear, seconds: store.get().settings.annotateAutoClearSeconds })
      )
      check('annotate session: …and the bar shows it', await waitFor(async () => (await timerOf()).text.includes('5'), 4000), JSON.stringify(await timerOf()))
      // ---- the keys of one letter (the tools, E, X): they act by default; switched off (Réglages › Fonctions en option) they are the page's, and the bar names none ----
      const toolTitle = () => bar.webContents.executeJavaScript(`document.querySelector('.page-annotate-tool[data-value="pen"]').title`) as Promise<string>
      const clearTitle = () => bar.webContents.executeJavaScript(`document.getElementById('page-annotate-clear-all').title`) as Promise<string>
      check('annotate letter keys: by default the bar names the letter of a tool and the X of « Tout »', (await toolTitle()).includes('(P)') && (await clearTitle()).includes('X)'), JSON.stringify({ tool: await toolTitle(), all: await clearTitle() }))
      // The page of the session has one mark (the undo above brought it back): a real X, sent to the page, clears every page of the session.
      wc.focus()
      type(wc, 'x')
      check('annotate letter keys: X, a real key sent to the page, clears the marks of the session while the letters act (the default)', await waitFor(async () => (await drawnIn(wc)) === 0, 4000), String(await drawnIn(wc)))
      await bar.webContents.executeJavaScript(`document.getElementById('page-annotate-undo').click()`)
      await waitFor(async () => (await drawnIn(wc)) === 1, 4000)
      browser.dispatch({ type: 'settings/update', patch: { annotateLetterKeys: false } })
      check('annotate letter keys: switched off, the open bar stops naming the letters', await waitFor(async () => !(await toolTitle()).includes('(P)') && !(await clearTitle()).includes('X)') && (await clearTitle()).includes('⇧⌥⌘⌫'), 4000), JSON.stringify({ tool: await toolTitle(), all: await clearTitle() }))
      wc.focus()
      type(wc, 'x')
      type(wc, 'e')
      await new Promise((resolve) => setTimeout(resolve, 800))
      check('annotate letter keys: switched off, X and E are left to the page: the mark stays', (await drawnIn(wc)) === 1, String(await drawnIn(wc)))
      await inPage(wc, `window.__seen.document = []; void 0`)
      type(wc, 'x')
      check('annotate letter keys: …and the page gets the key as it would without the annotation', await waitFor(async () => (await seen(wc)).document.some((event) => event.startsWith('keydown')), 4000), JSON.stringify((await seen(wc)).document.slice(0, 12)))
      // The keys with a modifier are still the annotation's: ⌥⌘⌫ clears the page on screen.
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace', modifiers: ['alt', 'meta'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace', modifiers: ['alt', 'meta'] })
      check('annotate letter keys: …while ⌥⌘⌫ still clears the page on screen', await waitFor(async () => (await drawnIn(wc)) === 0, 4000), String(await drawnIn(wc)))
      browser.dispatch({ type: 'settings/update', patch: { annotateLetterKeys: true } })
      notifyAnnotateRequest(browser.annotationSource())
      check('annotate bar: ending the session closes the bar', await waitFor(() => barWindow() === undefined, 4000))
    }
  } finally {
    // A session a failed check left open is ended: its bar must not stay over the next suite.
    if (barWindow() !== undefined) notifyAnnotateRequest(browser.annotationSource())
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: sleepAfter, ...clearingBefore } })
    for (const tab of store.get().tabs.filter((one) => one.spaceId === spaceId)) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.dispatch({ type: 'space/select', id: previousSpace })
    browser.dispatch({ type: 'space/delete', id: spaceId })
    // Not awaited: the browser keeps its connections open, and the close would wait for them.
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=annotate`: only these checks. */
export async function runAnnotateSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeAnnotate(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeAnnotate ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ANNOTATE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
