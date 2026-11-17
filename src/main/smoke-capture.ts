// Engine checks for the capture and automation features, run inside a real Electron:
//  - annotating a capture: the capture flow as it always was while the setting is off (file and clipboard at once, no panel), then, with
//    the setting on, the sheet over the window (its tools, its picture, real mouse events drawing a rectangle, a mosaic and a text), undo, the
//    confirmation before giving up, Copier / Enregistrer / Partager… (what reaches the clipboard and the disk is the picture drawn on, at the
//    capture's size), Abandonner, the ids and requests the main process refuses, the sheet that another panel replaces, the region capture
//    through the real IPC, the full-page capture and the private window;
//  - commands by address (lucium://, and lucium:// kept): refused while the setting is off, then the three commands through the same entry as the system
//    ('open-url' of the app), the placement of the pages by the link rules, a link of another application still going the old way, hostile
//    addresses, the flood limit, and (in a packaged build) the scheme declared in Info.plist.
// Nothing leaves the machine: the pictures go to a temporary Pictures folder, the clipboard and the settings are put back, the share menu is
// replaced by a recorder. Called from the engine smoke test: `await smokeCapture(ctx, check)`. `runCaptureSmoke` is the same with its own
// report, for LUCIUM_SMOKE_ONLY=capture (quick loop).

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, clipboard, nativeImage, ShareMenu, type NativeImage, type WebContents } from 'electron'
import { AUTOMATION_COMMANDS, AUTOMATION_RATE } from '@shared/automation-url'
import { ANNOTATE_TOOL_LABELS } from '@shared/annotate'
import type { SidebarState } from '@shared/model'
import type { SmokeContext } from './smoke'
import { captureActivePage, captureActivePagePortrait } from './shell/capture'
import { getAutomation } from './shell/automation'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

const pngSize = (bytes: Buffer): { width: number; height: number } => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })

const isRed = (p: { r: number; g: number; b: number }) => p.r > 200 && p.g < 90 && p.b < 90

export async function smokeCapture(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const ui = overlayView.webContents
  const state = (): SidebarState => store.get()
  const patch = (settings: Partial<SidebarState['settings']>) => browser.dispatch({ type: 'settings/update', patch: settings })
  const saved = { ...state().settings }
  const mine: string[] = []
  const picturesBefore = app.getPath('pictures')
  const pictures = mkdtempSync(join(tmpdir(), 'lucium-smoke-pictures-'))
  app.setPath('pictures', pictures)
  const folder = () => join(pictures, 'Lucium')
  const files = (): string[] => {
    try {
      return readdirSync(folder()).sort()
    } catch {
      return []
    }
  }
  // A second save in the same second takes a "-1" before the extension rather than replacing the first.
  const isAnnotated = (name: string): boolean => /-annote(-\d+)?\.png$/.test(name)
  const clipboardBefore = await clipboard.readText()
  const sentinel = 'capture-smoke-sentinel'
  // Electron 45's clipboard is asynchronous: the types it holds, and the picture on it if there is one.
  const clipboardTypes = async (): Promise<string[]> => (await clipboard.read()).flatMap((item) => item.types)
  const clipboardPicture = async (): Promise<NativeImage | null> => {
    const item = (await clipboard.read()).find((entry) => entry.types.includes('image/png'))
    return item ? nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer())) : null
  }

  // A page that has just loaded is not always ready to be captured (the compositor answers "UnknownVizError" for a moment, above all when this suite
  // runs alone in a window that was only just shown): a capture that is refused is tried again, and the refusal is in the log.
  const shoot = async (take: () => Promise<string | null>): Promise<string | null> => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await take()
      } catch (error) {
        console.warn(`[smoke] capture refused (attempt ${attempt}):`, error instanceof Error ? error.message : error)
        await sleep(700)
      }
    }
    return take()
  }

  // The share menu is native and modal: a recorder takes its place for the time of the checks.
  const shareProto = ShareMenu.prototype as unknown as { popup: (...args: unknown[]) => void }
  const realPopup = shareProto.popup
  let shareCalls = 0
  shareProto.popup = () => {
    shareCalls++
  }

  // ---- a local site: a page with a colour, a block of fine stripes, and pages for the commands ----
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    switch (url.pathname) {
      case '/cap':
        // The picture is made of fractions of the viewport, so that the checks do not depend on the scale of the screen or the size of the window.
        return void res.end(`<title>cap page</title><body style="margin:0;background:#1e90ff;height:2600px">
          <div style="position:absolute;left:5vw;top:10vh;width:30vw;height:30vh;background:repeating-linear-gradient(90deg,#000 0 2px,#fff 2px 4px)"></div></body>`)
      case '/q':
        return void res.end(`<title>q ${url.searchParams.get('term') ?? ''}</title><body>search result</body>`)
      default:
        return void res.end(`<title>${decodeURIComponent(url.pathname.slice(1))}</title><body>page</body>`)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const open = async (path: string, title: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const id = state().tabs.at(-1)!.id
    mine.push(id)
    await waitFor(() => state().tabs.find((t) => t.id === id)?.title === title && browser.snapshot().runtime.tabs[id]?.loading === false)
    return id
  }

  // ---- the overlay as a user drives it ----
  const evaluate = <T>(wc: WebContents, js: string) => wc.executeJavaScript(js) as Promise<T>
  const mouse = async (x: number, y: number, ...steps: Array<'mouseMove' | 'mouseDown' | 'mouseUp'>) => {
    for (const type of steps) {
      ui.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
      await sleep(30)
    }
  }
  const dragOn = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await mouse(from.x, from.y, 'mouseMove', 'mouseDown')
    for (let i = 1; i <= 8; i++) await mouse(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, 'mouseMove')
    await mouse(to.x, to.y, 'mouseUp')
    await sleep(250)
  }
  const centreOf = (selector: string, text?: string) =>
    evaluate<{ x: number; y: number } | null>(
      ui,
      `(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${text === undefined ? 'all[0]' : `all.find((e) => e.textContent.trim() === ${JSON.stringify(text)})`}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
    )
  const press = async (selector: string, text?: string) => {
    const at = await centreOf(selector, text)
    if (at) await mouse(at.x, at.y, 'mouseMove', 'mouseDown', 'mouseUp')
    await sleep(150)
    return at !== null
  }
  const pressLabel = async (label: string) => {
    const at = await evaluate<{ x: number; y: number } | null>(ui, `(() => { const el = document.querySelector('[aria-label=${JSON.stringify(label)}]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (at) await mouse(at.x, at.y, 'mouseMove', 'mouseDown', 'mouseUp')
    await sleep(150)
    return at !== null
  }
  /** The canvas box on the sheet, in CSS pixels, and the size of the picture it holds. */
  const canvasBox = () =>
    evaluate<{ x: number; y: number; w: number; h: number; width: number; height: number } | null>(
      ui,
      `(() => { const c = document.querySelector('.annotate-canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, width: c.width, height: c.height } })()`
    )
  /** Where a fraction of the picture is on the sheet. */
  const at = async (fx: number, fy: number) => {
    const box = (await canvasBox())!
    return { x: box.x + box.w * fx, y: box.y + box.h * fy }
  }
  /** Pixels of the sheet's canvas around a point of the picture (RGBA, row by row). */
  const sheetPixels = async (x: number, y: number, w: number, h: number): Promise<Array<{ r: number; g: number; b: number }>> => {
    const raw = await evaluate<number[]>(ui, `(() => { const c = document.querySelector('.annotate-canvas'); return Array.from(c.getContext('2d').getImageData(${Math.round(x)}, ${Math.round(y)}, ${w}, ${h}).data) })()`)
    return Array.from({ length: raw.length / 4 }, (_, i) => ({ r: raw[i * 4]!, g: raw[i * 4 + 1]!, b: raw[i * 4 + 2]! }))
  }
  const spread = (pixels: Array<{ r: number; g: number; b: number }>) => {
    const lum = pixels.map((p) => 0.3 * p.r + 0.59 * p.g + 0.11 * p.b)
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length
    return Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length)
  }
  const isBlue = (p: { r: number; g: number; b: number }) => Math.abs(p.r - 0x1e) < 12 && Math.abs(p.g - 0x90) < 12 && Math.abs(p.b - 0xff) < 12
  const sheetId = () => {
    const open = browser.currentOverlay()
    return open?.panel === 'annotate' ? open.id : null
  }
  /** A key sent to the interface as the keyboard sends it (Electron's names: Right, Return, Escape, Tab…); what it does is waited for by the caller. */
  const key = (keyCode: string, modifiers: Array<'shift'> = []) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    ui.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  /** Tab until `selector` has the focus (a focus the keyboard gave, so :focus-visible holds), at most `max` presses. */
  const tabTo = async (selector: string, max = 30) => {
    const there = () => evaluate<boolean>(ui, `document.activeElement?.matches(${JSON.stringify(selector)}) === true`)
    for (let i = 0; i < max; i++) {
      if (await there()) return true
      const before = await evaluate<string>(ui, `document.activeElement?.outerHTML.slice(0, 200) ?? ''`)
      key('Tab')
      await waitFor(async () => (await evaluate<string>(ui, `document.activeElement?.outerHTML.slice(0, 200) ?? ''`)) !== before, 1000)
    }
    return there()
  }
  const waitSheet = async () => (await waitFor(() => browser.currentPanel() === 'annotate', 8000)) && (await waitFor(async () => (await canvasBox()) !== null, 4000)) && (await sleep(500), true)
  const note = () => evaluate<string>(ui, `document.querySelector('.annotate-note')?.textContent ?? ''`)

  // The settings a run changes, put back at the end.
  const savedAutomation = { urlAutomation: saved.urlAutomation, annotateCapture: saved.annotateCapture, searchUrlTemplate: saved.searchUrlTemplate, linkRoutes: saved.linkRoutes, externalLinksInLittleArc: saved.externalLinksInLittleArc }
  let extraSpace: string | null = null

  try {
    // The suites of the chain share one process: nothing a previous one left open is in the way.
    browser.closeOverlay()
    patch({ annotateCapture: false, urlAutomation: false })

    // ============================== annotating a capture ==============================
    const capTab = await open('/cap', 'cap page')
    check('annotate: both functions are off by default', saved.annotateCapture === false && saved.urlAutomation === false, JSON.stringify({ a: saved.annotateCapture, u: saved.urlAutomation }))

    check('capture: the page can be captured once it has loaded', await waitFor(async () => (await browser.capture(false).then((png) => png !== null).catch((error: unknown) => (console.warn('[smoke] page not capturable yet:', error instanceof Error ? error.message : error), false))) === true, 15_000))
    await clipboard.clear()
    const classic = await shoot(() => captureActivePage(browser, false))
    check('annotate off: a capture is saved at once, as it always was, and no panel opens', !!classic && files().length === 1 && browser.currentPanel() === null, JSON.stringify({ classic, files: files(), panel: browser.currentPanel() }))
    // The pasteboard belongs to the whole machine and Electron commits an async write through another process: on a loaded machine (several instances at once) the first read
    // can come before the write is visible, as for the check of "Copier" below that waits 300 ms. The write is waited for (3 s), never assumed; a capture that is not copied still fails.
    const copiedAtOnce = await waitFor(async () => (await clipboardTypes()).includes('image/png'), 3000)
    check('annotate off: and it is on the clipboard', copiedAtOnce, (await clipboardTypes()).join(','))

    patch({ annotateCapture: true })
    await clipboard.writeText(sentinel)
    const before = files().length
    check('annotate on: a capture opens the sheet and returns no file', (await shoot(() => captureActivePage(browser, false))) === null && (await waitSheet()), String(browser.currentPanel()))
    check('annotate on: nothing is written and the clipboard is untouched before the user chooses', files().length === before && (await clipboard.readText()) === sentinel)
    const request = browser.currentOverlay()
    const id = sheetId()!
    const box = await canvasBox()
    check('sheet: its canvas has the size of the capture', request?.panel === 'annotate' && box?.width === request.width && box?.height === request.height && request.width > 100, JSON.stringify({ request, box }))
    const tools = await evaluate<string[]>(ui, `[...document.querySelectorAll('[aria-label="Outil"] button')].map((b) => b.textContent.trim())`)
    check('sheet: five tools, in French', JSON.stringify(tools) === JSON.stringify(Object.values(ANNOTATE_TOOL_LABELS)), JSON.stringify(tools))
    const actions = await evaluate<string[]>(ui, `[...document.querySelectorAll('.annotate-actions button')].map((b) => b.textContent.trim())`)
    check('sheet: Abandonner, Copier, Partager…, Ouvrir avec Aperçu and Enregistrer', JSON.stringify(actions) === JSON.stringify(['Abandonner', 'Copier', 'Partager…', 'Ouvrir avec Aperçu', 'Enregistrer']), JSON.stringify(actions))
    const W = box!.width
    const H = box!.height
    const corner = await sheetPixels(Math.floor(W * 0.8), Math.floor(H * 0.8), 6, 6)
    check('sheet: the picture is the page (its colour is at the foot of the canvas)', corner.every(isBlue), JSON.stringify(corner[0]))

    // A rectangle, with real mouse events: the arrow is the first tool, so the rectangle is chosen.
    await press('[aria-label="Outil"] button', 'Rectangle')
    await dragOn(await at(0.5, 0.5), await at(0.9, 0.9))
    const edge = await sheetPixels(Math.round(W * 0.7) - 3, Math.round(H * 0.5) - 6, 6, 12)
    const inside = await sheetPixels(Math.round(W * 0.7), Math.round(H * 0.7), 6, 6)
    check('rectangle: its edge is drawn in red over the picture', edge.some(isRed), JSON.stringify(edge.slice(0, 3)))
    check('rectangle: and it is not filled', inside.every(isBlue), JSON.stringify(inside[0]))

    // The mosaic over the block of stripes: the contrast under it goes.
    const stripesBefore = spread(await sheetPixels(Math.round(W * 0.1), Math.round(H * 0.15), 40, 40))
    await press('[aria-label="Outil"] button', 'Flou')
    await dragOn(await at(0.04, 0.09), await at(0.36, 0.41))
    const stripesAfter = spread(await sheetPixels(Math.round(W * 0.1), Math.round(H * 0.15), 40, 40))
    check('mosaic: the fine stripes under it can no longer be told apart', stripesBefore > 60 && stripesAfter < stripesBefore / 3, `${stripesBefore.toFixed(1)} -> ${stripesAfter.toFixed(1)}`)

    // A text.
    await press('[aria-label="Outil"] button', 'Texte')
    const textAt = await at(0.1, 0.62)
    await mouse(textAt.x, textAt.y, 'mouseMove', 'mouseDown', 'mouseUp')
    check('text: a field opens where the click was', await waitFor(async () => (await evaluate<boolean>(ui, `document.activeElement?.classList.contains('annotate-text') === true`)) === true, 3000))
    for (const ch of 'OK') {
      ui.sendInputEvent({ type: 'keyDown', keyCode: ch })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(40)
    }
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(400)
    const textZone = () => sheetPixels(Math.round(W * 0.1), Math.round(H * 0.62), Math.round(W * 0.1), 40)
    const inked = (await textZone()).filter((p) => !isBlue(p)).length
    check('text: Return keeps it, drawn on the picture', inked > 20, String(inked))

    // Undo takes the text away again.
    check('undo: the last annotation goes (the text), the others stay', (await pressLabel('Annuler la dernière annotation')) && (await waitFor(async () => (await textZone()).every(isBlue), 3000)) && (await sheetPixels(Math.round(W * 0.7) - 3, Math.round(H * 0.5) - 6, 6, 12)).some(isRed))
    check('redo: and brings it back', (await pressLabel('Rétablir l’annotation')) && (await waitFor(async () => (await textZone()).some((p) => !isBlue(p)), 3000)))

    // From the keyboard: Tab reaches the picture, the first arrow shows a point in its middle (a ring seen only with the keyboard's focus),
    // the arrows move it, Return begins a rectangle there, the arrows stretch it and Return ends it. Placed above-left of the middle, where
    // the rectangle, the mosaic and the text above left the picture blue.
    await press('[aria-label="Outil"] button', 'Rectangle')
    check('keyboard: Tab reaches the picture of the sheet', await tabTo('canvas.annotate-canvas'), await evaluate<string>(ui, `document.activeElement?.outerHTML.slice(0, 80) ?? 'none'`))
    key('Right')
    const ring = () => evaluate<{ left: number; top: number; shown: boolean } | null>(ui, `(() => { const r = document.querySelector('.annotate-cursor'); return r ? { left: parseFloat(r.style.left), top: parseFloat(r.style.top), shown: getComputedStyle(r).display !== 'none' } : null })()`)
    await waitFor(async () => (await ring()) !== null, 2000)
    const first = await ring()
    const sheetBox = (await canvasBox())!
    const scale = sheetBox.w / sheetBox.width
    check('keyboard: the first arrow shows the point in the middle of the picture, its ring visible', first !== null && first.shown && Math.abs(first.left / scale - W / 2) <= 1 && Math.abs(first.top / scale - H / 2) <= 1, JSON.stringify({ first, W, H, scale }))
    // The point moves by a hundredth of the picture's longer side for each arrow: the keys are waited for by where it lands.
    const step = Math.max(2, Math.round(Math.max(W, H) / 100))
    const pointAt = (dx: number, dy: number) => waitFor(async () => {
      const now = await ring()
      return now !== null && Math.abs(now.left / scale - (W / 2 + dx * step)) <= 1.5 && Math.abs(now.top / scale - (H / 2 + dy * step)) <= 1.5
    }, 3000)
    for (let i = 0; i < 10; i++) key('Left')
    for (let i = 0; i < 8; i++) key('Up')
    await pointAt(-10, -8)
    const start = (await ring())!
    const from = { x: Math.round(start.left / scale), y: Math.round(start.top / scale) }
    key('Return')
    for (let i = 0; i < 8; i++) key('Right')
    for (let i = 0; i < 5; i++) key('Down')
    await pointAt(-2, -3)
    key('Return')
    const end = (await ring())!
    const to = { x: Math.round(end.left / scale), y: Math.round(end.top / scale) }
    const keyedEdge = () => sheetPixels(Math.round((from.x + to.x) / 2) - 3, from.y - 6, 6, 12)
    check('keyboard: Return, the arrows and Return draw a rectangle from the point', to.x > from.x + 4 && to.y > from.y + 4 && (await waitFor(async () => (await keyedEdge()).some(isRed), 3000)), JSON.stringify({ from, to, pixel: (await keyedEdge())[0] }))
    // A shape begun and dropped: Escape takes it away and leaves the sheet as it was, with no question. The witness that the keys were read is the
    // undo that follows them: it takes the keyed rectangle away, not a shape that Escape would have kept.
    key('Return')
    for (let i = 0; i < 4; i++) key('Down')
    await pointAt(-2, 1)
    key('Escape')
    await pressLabel('Annuler la dernière annotation')
    check('keyboard: Escape drops a shape under way, and the sheet stays without asking', browser.currentPanel() === 'annotate' && (await note()) === '' && (await waitFor(async () => !(await keyedEdge()).some(isRed), 3000)), JSON.stringify({ panel: browser.currentPanel(), note: await note() }))

    // Escape with work on the sheet asks first.
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(async () => /Abandonner la capture/.test(await note()), 3000)
    const focusedNow = () => evaluate<string>(ui, `(() => { const a = document.activeElement; return a ? a.tagName + '.' + a.className + (a.disabled ? ' [disabled]' : '') : 'none' })()`)
    check('escape: with annotations the sheet asks before giving up, and stays', /Abandonner la capture/.test(await note()) && browser.currentPanel() === 'annotate', JSON.stringify({ note: await note(), panel: browser.currentPanel(), focus: await focusedNow() }))
    check('escape: "continuez à annoter" takes the question away', (await press('.annotate-continue')) && (await note()) === '' && browser.currentPanel() === 'annotate', JSON.stringify({ note: await note(), panel: browser.currentPanel(), focus: await focusedNow() }))

    // What the main process refuses, with the sheet open.
    const forged = await evaluate<{ wrongId: unknown; badAction: unknown; badPicture: unknown; image: unknown; open: boolean }>(
      ui,
      `(async () => {
        const wrongId = await window.lucium.annotateDone({ id: '11111111-1111-1111-1111-111111111111', action: 'save', png: new Uint8Array(40) })
        const badAction = await window.lucium.annotateDone({ id: ${JSON.stringify(id)}, action: 'delete', png: new Uint8Array(40) })
        const badPicture = await window.lucium.annotateDone({ id: ${JSON.stringify(id)}, action: 'save', png: new Uint8Array(40) })
        const image = await window.lucium.annotateImage('11111111-1111-1111-1111-111111111111')
        window.lucium.openOverlay({ panel: 'annotate', id: 'x', width: 1, height: 1 })
        // The witness: openOverlay is a message without an answer; a question asked after it on the same channel is answered only once the main
        // process has handled it.
        await window.lucium.getSnapshot()
        return { wrongId, badAction, badPicture, image, open: true }
      })()`
    )
    check('ipc: another id, an unknown action and a picture that is not the capture’s are refused', (forged.wrongId as { ok: boolean }).ok === false && (forged.badAction as { ok: boolean }).ok === false && (forged.badPicture as { ok: boolean }).ok === false && forged.image === null, JSON.stringify(forged))
    check('ipc: nothing was written, and the sheet is still the one of the capture', files().length === before && sheetId() === id, JSON.stringify({ files: files(), now: sheetId() }))
    check('ipc: the interface cannot open the sheet on its own', sheetId() === id, String(sheetId()))

    // Copier: the picture drawn on goes to the clipboard, at the capture's size, and the sheet closes.
    await clipboard.writeText(sentinel)
    check('copy: Copier closes the sheet', (await press('.annotate-actions button', 'Copier')) && (await waitFor(() => browser.currentPanel() === null, 8000)))
    await sleep(300)
    const copied = (await clipboardPicture()) ?? nativeImage.createEmpty()
    const copiedSize = copied.getSize()
    check('copy: the clipboard holds the picture, at the capture’s size', copiedSize.width === W && copiedSize.height === H, JSON.stringify({ copiedSize, W, H }))
    const bitmap = copied.toBitmap()
    const pixelAt = (x: number, y: number) => ({ b: bitmap[(y * W + x) * 4]!, g: bitmap[(y * W + x) * 4 + 1]!, r: bitmap[(y * W + x) * 4 + 2]! })
    const copiedEdge = Array.from({ length: 12 }, (_, i) => pixelAt(Math.round(W * 0.7), Math.round(H * 0.5) - 6 + i))
    check('copy: and the rectangle is in it', copiedEdge.some(isRed), JSON.stringify(copiedEdge[0]))
    check('copy: no file was written', files().length === before)
    check('copy: and a notice says so', /Capture copiée/.test(browser.snapshot().toast?.message ?? ''), browser.snapshot().toast?.message)
    check('copy: the capture is let go (its id reads nothing any more)', browser.heldCapture(id) === null && (await evaluate<unknown>(ui, `window.lucium.annotateImage(${JSON.stringify(id)})`)) === null)

    // Enregistrer: a file of its own name, the clipboard left alone.
    await clipboard.writeText(sentinel)
    check('save: a new capture opens the sheet again', (await shoot(() => captureActivePage(browser, false))) === null && (await waitSheet()))
    await press('[aria-label="Outil"] button', 'Flèche')
    await dragOn(await at(0.2, 0.7), await at(0.6, 0.9))
    check('save: Enregistrer closes the sheet', (await press('.annotate-actions button', 'Enregistrer')) && (await waitFor(() => browser.currentPanel() === null, 8000)))
    const annotated = files().filter(isAnnotated)
    check('save: one file ending in -annote.png, the size of the capture', annotated.length === 1 && pngSize(readFileSync(join(folder(), annotated[0]!))).width === W && pngSize(readFileSync(join(folder(), annotated[0]!))).height === H, JSON.stringify(files()))
    check('save: the clipboard was not touched', (await clipboard.readText()) === sentinel)

    // Partager…: saved first, then the menu opens on the file.
    shareCalls = 0
    check('share: a new capture opens the sheet again', (await shoot(() => captureActivePage(browser, false))) === null && (await waitSheet()))
    check('share: Partager… closes the sheet and opens the share menu', (await press('.annotate-actions button', 'Partager…')) && (await waitFor(() => browser.currentPanel() === null && shareCalls === 1, 8000)), String(shareCalls))
    check('share: the picture was saved for it', files().filter(isAnnotated).length === 2, JSON.stringify(files()))

    // Abandonner without work: nothing saved, nothing held.
    const filesBefore = files().length
    check('abandon: a new capture opens the sheet', (await shoot(() => captureActivePage(browser, false))) === null && (await waitSheet()))
    const abandonId = sheetId()!
    check('abandon: Abandonner with nothing drawn closes the sheet at once', (await press('.annotate-actions button', 'Abandonner')) && (await waitFor(() => browser.currentPanel() === null, 4000)))
    check('abandon: nothing was saved or copied, and the capture is let go', files().length === filesBefore && browser.heldCapture(abandonId) === null)

    // Another panel replaces the sheet: the capture goes with it.
    check('replaced: a new capture opens the sheet', (await shoot(() => captureActivePage(browser, false))) === null && (await waitSheet()))
    const replacedId = sheetId()!
    browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
    check('replaced: the command bar takes its place and the capture is let go', browser.currentPanel() === 'commandbar' && browser.heldCapture(replacedId) === null)
    browser.closeOverlay()

    // The full page and the portrait go through the sheet too.
    check('full page: the whole page opens the sheet, taller than the window', (await shoot(() => captureActivePage(browser, true))) === null && (await waitSheet()) && ((await canvasBox())?.height ?? 0) > H * 1.5, JSON.stringify(await canvasBox()))
    await press('.annotate-actions button', 'Abandonner')
    await waitFor(() => browser.currentPanel() === null)
    check('portrait: the portrait capture opens the sheet', (await shoot(() => captureActivePagePortrait(browser))) === null && (await waitSheet()), String(browser.currentPanel()))
    await press('.annotate-actions button', 'Abandonner')
    await waitFor(() => browser.currentPanel() === null)

    // The region, through the real channel of the selection surface.
    const stageX = state().settings.sidebarWidth + 8 + 20
    browser.openOverlay({ panel: 'capture' })
    await sleep(500)
    await evaluate<void>(ui, `window.lucium.captureRegion({ x: ${stageX}, y: 80, width: 240, height: 140 })`)
    check('region: the selection opens the sheet, with a picture of the region’s proportions', (await waitSheet()) && Math.abs(((await canvasBox())!.width / (await canvasBox())!.height) - 240 / 140) < 0.03, JSON.stringify(await canvasBox()))
    await press('.annotate-actions button', 'Abandonner')
    await waitFor(() => browser.currentPanel() === null)

    // The region from the keyboard: the first arrow shows the middle half of the window, with the help still in sight, and Return takes it.
    browser.openOverlay({ panel: 'capture' })
    await waitFor(() => evaluate<boolean>(ui, `document.activeElement?.classList.contains('capture-surface') === true`), 4000)
    key('Right')
    await waitFor(() => evaluate<boolean>(ui, `document.querySelector('.capture-box') !== null`), 3000)
    const keyed = await evaluate<{ box: { x: number; y: number; w: number; h: number } | null; hint: boolean; ratio: number }>(
      ui,
      `(() => { const b = document.querySelector('.capture-box'); const r = b?.getBoundingClientRect(); return { box: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, hint: !!document.querySelector('.capture-hint'), ratio: innerWidth / innerHeight } })()`
    )
    check('region, keyboard: the first arrow shows a zone in the middle, and the help stays', keyed.box !== null && keyed.hint && Math.abs(keyed.box.w / keyed.box.h - keyed.ratio) < 0.05, JSON.stringify(keyed))
    key('Return')
    check('region, keyboard: Return captures the zone, the sheet opens with its proportions', (await waitSheet()) && Math.abs((await canvasBox())!.width / (await canvasBox())!.height - keyed.ratio) < 0.05, JSON.stringify(await canvasBox()))
    await press('.annotate-actions button', 'Abandonner')
    await waitFor(() => browser.currentPanel() === null)
    patch({ annotateCapture: false })
    browser.openOverlay({ panel: 'capture' })
    await sleep(500)
    const regionFiles = files().length
    await evaluate<void>(ui, `window.lucium.captureRegion({ x: ${stageX}, y: 80, width: 240, height: 140 })`)
    check('region, annotate off: the selection saves a file at once and opens no sheet', (await waitFor(() => files().length === regionFiles + 1, 8000)) && browser.currentPanel() === null, JSON.stringify(files().slice(-1)))

    // The private window: the sheet opens there too, and nothing is written before the choice.
    patch({ annotateCapture: true })
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    priv.browser.dispatch({ type: 'tab/open', url: `${base}/cap` })
    await waitFor(() => priv.store.get().tabs.some((t) => t.title === 'cap page'))
    await sleep(500)
    const privFiles = files().length
    check('private window: a capture opens the sheet (the setting is inherited)', (await shoot(() => captureActivePage(priv.browser, false))) === null && priv.browser.currentPanel() === 'annotate' && files().length === privFiles, String(priv.browser.currentPanel()))
    priv.browser.closeOverlay()
    check('private window: closing the sheet lets the capture go', files().length === privFiles)
    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()
    win.emit('focus')

    patch({ annotateCapture: false })
    browser.dispatch({ type: 'tab/select', id: capTab })

    // ============================== commands by address ==============================
    const automation = getAutomation()
    check('automation: the application has a runner for the commands', automation !== null)
    const tabCount = () => state().tabs.length
    const urlOf = (command: string) => `lucium://${command}`
    const system = (url: string) => app.emit('open-url', { preventDefault() {} } as never, url)

    // Off: refused, by the real entry as well as by the runner.
    const tabsBefore = tabCount()
    check('automation off: the runner refuses', automation?.handle(urlOf(`open?url=${encodeURIComponent(`${base}/auto-off`)}`)).ran === false)
    system(urlOf(`open?url=${encodeURIComponent(`${base}/auto-off`)}`))
    system(urlOf('new-tab'))
    // No wait: the system's entry decides and acts before it returns (index.ts, shell/automation.ts): a tab or a panel it opens is there at once.
    check('automation off: no tab opens and no panel, by the system’s entry either', tabCount() === tabsBefore && browser.currentPanel() === null, JSON.stringify({ tabs: tabCount() - tabsBefore, panel: browser.currentPanel() }))

    // On: the three commands, through 'open-url'.
    patch({ urlAutomation: true })
    system(urlOf(`open?url=${encodeURIComponent(`${base}/auto-open`)}`))
    check('automation: "open" opens the address in a tab, by the system’s entry', await waitFor(() => state().tabs.some((t) => t.url === `${base}/auto-open`), 6000))
    const opened = state().tabs.find((t) => t.url === `${base}/auto-open`)
    if (opened) mine.push(opened.id)
    check('automation: and the page loads', await waitFor(() => state().tabs.find((t) => t.id === opened?.id)?.title === 'auto-open', 8000))

    browser.closeOverlay()
    system(urlOf('new-tab'))
    check('automation: "new-tab" opens the command bar for a new tab', await waitFor(() => browser.currentOverlay()?.panel === 'commandbar' && (browser.currentOverlay() as { mode?: string }).mode === 'new', 4000), JSON.stringify(browser.currentOverlay()))
    browser.closeOverlay()

    patch({ searchUrlTemplate: `${base}/q?term=%s` })
    system(urlOf('search?q=hello%20world%20%26%20co'))
    check('automation: "search" searches with the engine of the profile, the text encoded', await waitFor(() => state().tabs.some((t) => t.url === `${base}/q?term=hello%20world%20%26%20co`), 6000), JSON.stringify(state().tabs.slice(-2).map((t) => t.url)))
    const searched = state().tabs.find((t) => t.url.startsWith(`${base}/q?term=`))
    if (searched) mine.push(searched.id)

    // The link rules decide the space, as for a link of another application.
    browser.dispatch({ type: 'space/create', name: 'Automation smoke', emoji: '🤖', hue: 120 })
    extraSpace = state().spaces.at(-1)!.id
    const home = state().spaces[0]!.id
    browser.dispatch({ type: 'space/select', id: home })
    patch({ linkRoutes: [{ host: '127.0.0.1', spaceId: extraSpace }] })
    system(urlOf(`open?url=${encodeURIComponent(`${base}/auto-routed`)}`))
    check('automation: a rule for the host picks the space, as for a link of another application', await waitFor(() => state().tabs.some((t) => t.url === `${base}/auto-routed` && t.spaceId === extraSpace), 6000), JSON.stringify(state().tabs.filter((t) => t.url.includes('auto-routed')).map((t) => t.spaceId)))
    patch({ linkRoutes: [], externalLinksInLittleArc: false })

    // A link of another application still goes the old way.
    system(`${base}/plain-link`)
    check('a link of another application is still opened in a tab (the old path is unchanged)', await waitFor(() => state().tabs.some((t) => t.url === `${base}/plain-link`), 6000))

    // A file the Finder opens with Lucium ('open-file'): a tab of the main window with its file address, even when the links of other applications go to
    // a mini window; a type a tab would download opens nothing. (Written to be run by the engine pass: not run when it was added.)
    const finderDir = mkdtempSync(join(tmpdir(), 'lucium-open-file-'))
    const finderPage = join(finderDir, 'ma page.html')
    writeFileSync(finderPage, '<title>from the finder</title><p>hello</p>')
    writeFileSync(join(finderDir, 'setup.dmg'), 'not a page')
    patch({ externalLinksInLittleArc: true })
    const finder = (path: string) => app.emit('open-file', { preventDefault() {} } as never, path)
    finder(finderPage)
    check('open-file: a page of the disk opens in a tab, by its file address (a space in its name kept)', await waitFor(() => state().tabs.some((t) => t.url === pathToFileURL(finderPage).href), 6000), JSON.stringify(state().tabs.slice(-2).map((t) => t.url)))
    const finderTab = state().tabs.find((t) => t.url === pathToFileURL(finderPage).href)
    if (finderTab) mine.push(finderTab.id)
    check('open-file: and the page loads', await waitFor(() => state().tabs.find((t) => t.id === finderTab?.id)?.title === 'from the finder', 8000))
    const tabsFinder = tabCount()
    finder(join(finderDir, 'setup.dmg'))
    finder('relative/page.html')
    // No wait: the entry decides and acts before it returns (index.ts): a tab it opens is there at once.
    check('open-file: a type a tab would download, and a path that is not absolute, open nothing', tabCount() === tabsFinder, String(tabCount() - tabsFinder))
    patch({ externalLinksInLittleArc: false })
    rmSync(finderDir, { recursive: true, force: true })

    // Hostile and malformed addresses: nothing opens.
    const warn = console.warn
    const logged: string[] = []
    console.warn = (...args: unknown[]) => void logged.push(args.join(' '))
    const tabsHostile = tabCount()
    const hostile = [
      urlOf('open?url=javascript%3Aalert(1)'),
      urlOf('open?url=file%3A%2F%2F%2Fetc%2Fhosts'),
      urlOf('open?url=data%3Atext%2Fhtml%2C%3Cb%3E1'),
      urlOf('open?url=lucium%3A%2F%2Fnew-tab'),
      urlOf(`open?url=${encodeURIComponent('https://user:secret@example.com/')}`),
      urlOf('clear'),
      urlOf('history'),
      urlOf('open'),
      urlOf(`open?url=${encodeURIComponent(`${base}/x`)}&url=${encodeURIComponent(`${base}/y`)}`),
      urlOf(`open?url=${encodeURIComponent(`${base}/x`)}&extra=1`),
      urlOf(`open?url=${encodeURIComponent(`${base}/${'a'.repeat(3000)}`)}`),
      urlOf('search?q='),
      urlOf('search?q=a%0Ab'),
      'lucium:open?url=x',
      'LUCIUM://',
      'lucium:open?url=x',
      'LUCIUM://'
    ]
    // No wait: each address is refused, and said in the log, before the entry returns.
    for (const url of hostile) system(url)
    console.warn = warn
    check('hostile addresses: not one opens a tab', tabCount() === tabsHostile, `${tabCount() - tabsHostile} tabs`)
    check('hostile addresses: each is in the log, and none shows what it carried', logged.filter((l) => l.includes('[automation] refused')).length === hostile.length && !logged.join('\n').includes('secret') && !logged.join('\n').includes('etc/hosts'), `${logged.length} lines`)

    // The flood limit.
    await sleep(AUTOMATION_RATE.windowMs + 300)
    let ran = 0
    for (let i = 0; i < AUTOMATION_RATE.max + 6; i++) if (automation?.handle(urlOf('new-tab')).ran) ran++
    browser.closeOverlay()
    check(`flood: ${AUTOMATION_RATE.max} commands pass in a window, the rest are refused`, ran === AUTOMATION_RATE.max, String(ran))
    // A fixed wait, for want of a witness: the window of the limit is time, and it has to pass.
    await sleep(AUTOMATION_RATE.windowMs + 300)
    check('flood: and the next window starts afresh', automation?.handle(urlOf('new-tab')).ran === true)
    browser.closeOverlay()

    // The list of commands is the one that is documented.
    check('commands: the list is open, new-tab and search', AUTOMATION_COMMANDS.map((c) => c.name).join(',') === 'open,new-tab,search')

    // Turning it off again stops it at once.
    patch({ urlAutomation: false })
    const tabsOff = tabCount()
    // No wait: the entry decides and acts before it returns.
    system(urlOf(`open?url=${encodeURIComponent(`${base}/auto-after-off`)}`))
    check('automation off again: the next command is refused', tabCount() === tabsOff)

    // That a packaged build declares the schemes to the system (CFBundleURLTypes of electron-builder.yml) is not looked at here: the package leaves
    // the engine suites out, so no run of this file ever sees a packaged Info.plist.
  } finally {
    patch({ annotateCapture: savedAutomation.annotateCapture, urlAutomation: savedAutomation.urlAutomation, searchUrlTemplate: savedAutomation.searchUrlTemplate, linkRoutes: savedAutomation.linkRoutes, externalLinksInLittleArc: savedAutomation.externalLinksInLittleArc })
    shareProto.popup = realPopup
    browser.closeOverlay()
    for (const tabId of mine) browser.dispatch({ type: 'tab/close', id: tabId })
    for (const tab of state().tabs.filter((t) => t.url.startsWith(base))) browser.dispatch({ type: 'tab/close', id: tab.id })
    if (extraSpace) browser.dispatch({ type: 'space/delete', id: extraSpace })
    await clipboard.writeText(clipboardBefore)
    app.setPath('pictures', picturesBefore)
    rmSync(pictures, { recursive: true, force: true })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=capture`: only these checks, with their own report. */
export async function runCaptureSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeCapture(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeCapture ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_CAPTURE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
