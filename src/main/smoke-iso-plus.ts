// Engine checks for the popover of the + at the foot of the sidebar: it opens from the button as a popover of the overlay (never a native menu),
// its rows (space, folder, Tweak, split view) do what they say with a real click, the keyboard moves and takes the choice, Escape and a click outside
// close it, the rows that need a page are greyed out in a space with no tab, and it follows the button of the floating sidebar. Real mouse and keyboard
// input (sendInputEvent) drives the button and the rows. Called from the engine smoke test: `await smokeIsoPlus(ctx, check)`;
// `LUCIUM_SMOKE_ONLY=iso-plus` runs only this file. LUCIUM_ISO_PLUS_SHOTS=<dir> takes pictures of this process's window.

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Menu, screen, type WebContents } from 'electron'
import { FLOATING_INSET } from '@shared/ipc'
import { PLUS_MENU, plusMenuHeight } from '@shared/plus-menu'
import type { SmokeContext } from './smoke'
import { noteCheck, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Box {
  x: number
  y: number
  w: number
  h: number
}


const waitFor = waiterOf(4000, 40)

const near = (actual: number | undefined, expected: number, tolerance = 0.6) => actual !== undefined && Math.abs(actual - expected) <= tolerance
const fmt = (box: Box | null) => (box ? `${box.x},${box.y} ${box.w}x${box.h}` : 'absent')
/** `inner` lies within `outer` (rounding aside). */
const within = (inner: Box | null | undefined, outer: Box | null | undefined, slack = 0.6) =>
  !!inner && !!outer && inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack
/** The popover hangs from the button: above it, not covering it, its right edge at the button's right edge. */
const hangsFrom = (card: Box | null | undefined, button: Box | null | undefined) =>
  !!card && !!button && card.y + card.h <= button.y + 0.5 && Math.abs(card.x + card.w - (button.x + button.w)) <= 4

export async function smokeIsoPlus(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const chrome = win.webContents
  const ui = overlayView.webContents

  // Pictures for a look at the popover: the window of THIS process only, found by its PID, never another one.
  const shotsDir = process.env['LUCIUM_ISO_PLUS_SHOTS']
  const shot = (name: string) => {
    if (!shotsDir) return
    mkdirSync(shotsDir, { recursive: true })
    const script = `ObjC.import("CoreGraphics"); ObjC.import("stdlib"); const pid = Number($.getenv("PID")); const arr = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0); const n = $.CFArrayGetCount(arr); let out = ""; for (let i = 0; i < n; i++) { const w = ObjC.deepUnwrap(ObjC.castRefToObject($.CFArrayGetValueAtIndex(arr, i))); if (!out && w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 600) out = String(w.kCGWindowNumber); } out`
    const id = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { env: { ...process.env, PID: String(process.pid) } }).toString().trim()
    if (id) execFileSync('screencapture', ['-x', '-o', '-l', id, join(shotsDir, `${name}.png`)])
  }

  const evaluate = <T>(from: WebContents, script: string) =>
    (from.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${String(error)} -- in: ${script.replace(/\s+/g, ' ').slice(0, 200)}`)
    })
  const rect = (from: WebContents, selector: string, nth = 0) =>
    evaluate<Box | null>(from, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })()`)
  const rects = (from: WebContents, selector: string) =>
    evaluate<Box[]>(from, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })`)
  const style = (from: WebContents, selector: string, props: string[], nth = 0) =>
    evaluate<Record<string, string> | null>(from, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const s = getComputedStyle(el); return Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, s.getPropertyValue(p)])) })()`)
  const mouse = (from: WebContents, type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
    from.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  const click = async (from: WebContents, x: number, y: number) => {
    mouse(from, 'mouseMove', x, y)
    await sleep(40)
    mouse(from, 'mouseDown', x, y)
    await sleep(30)
    mouse(from, 'mouseUp', x, y)
    await sleep(200)
  }
  const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  const key = async (keyCode: string) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode })
    ui.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(80)
  }
  const selectedRow = () => evaluate<string | null>(ui, `document.querySelector('.plus-row.selected')?.dataset.entry ?? null`)
  const rowRect = (entry: string) => rect(ui, `.plus-row[data-entry="${entry}"]`)
  /** What a colour token of the interface comes to inside the card (`--plus-fill`, `--plus-line`, `--text-3`…): the card is drawn with tokens, so the checks compare with them. */
  const tokenColor = (token: string, property: 'background-color' | 'color' = 'background-color') =>
    evaluate<string>(ui, `(() => { const probe = document.createElement('div'); probe.style.setProperty(${JSON.stringify(property)}, 'var(${token})'); document.querySelector('.plus-menu').append(probe); const value = getComputedStyle(probe).getPropertyValue(${JSON.stringify(property)}); probe.remove(); return value })()`)

  // A fixed size, from the top left corner of the screen so the window is not squeezed by its lower edge.
  const savedBounds = win.getBounds()
  const previous = store.get().settings
  const previousSettings = { sidebarVisible: previous.sidebarVisible, sidebarWidth: previous.sidebarWidth, showToolbar: previous.showToolbar, workViewsEnabled: previous.workViewsEnabled }
  const workArea = screen.getPrimaryDisplay().workArea
  win.setBounds({ x: workArea.x, y: workArea.y, width: 1680, height: 888 })
  win.showInactive()
  // The four rows this suite was written for: « Nouvelle vue de travail… », the row the work views add while they are on, is checked by smoke-work-views.ts.
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, sidebarWidth: 323, showToolbar: true, workViewsEnabled: false } })
  await sleep(600)

  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html')
    res.end(`<title>plus ${req.url}</title><body>plus ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const previousSpace = store.get().activeSpaceId
  browser.dispatch({ type: 'space/create', name: 'Plus ISO', emoji: '➕', hue: 140 })
  const spaceId = store.get().activeSpaceId
  browser.dispatch({ type: 'tab/open', url: `${base}/page`, spaceId })
  await waitFor(() => store.get().tabs.some((t) => t.spaceId === spaceId && t.title === 'plus /page'), 8000)
  await sleep(500)
  const foldersOf = () => store.get().folders.filter((f) => f.spaceId === spaceId)

  // A native menu would be a failure: record the ones that open.
  const nativeMenus: string[][] = []
  const realPopup = Menu.prototype.popup
  Menu.prototype.popup = function (this: Menu) {
    nativeMenus.push(this.items.map((item) => item.label))
    return this
  } as never

  const plusButton = async () => (await rect(chrome, '.footer-plus'))!
  const openPlus = async () => {
    const button = await plusButton()
    await click(chrome, centre(button).x, centre(button).y)
    const open = await waitFor(() => browser.currentPanel() === 'plus')
    await sleep(450)
    return open
  }

  // ---- 1. the button and what a click on it does ----
  const button = await plusButton()
  check('before the click the + is a plus: not turned, nothing open', browser.currentPanel() === null && !browser.snapshot().plusOpen && (await style(chrome, '.footer-plus svg', ['transform']))?.['transform'] === 'none')
  check('a real click on the + opens the popover of the overlay, not a native menu', (await openPlus()) && nativeMenus.length === 0, JSON.stringify(nativeMenus))
  check('the request carries the button as the anchor of the popover', JSON.stringify((browser.currentOverlay() as { anchor?: unknown } | null)?.anchor) === JSON.stringify({ x: button.x, y: button.y, width: button.w, height: button.h }), JSON.stringify(browser.currentOverlay()))
  const turned = await waitFor(async () => (await style(chrome, '.footer-plus svg', ['transform']))?.['transform'] === 'matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)', 1500)
  check('while it is open the + has turned into a cross and says it is expanded', turned && browser.snapshot().plusOpen === true && (await evaluate<string>(chrome, `document.querySelector('.footer-plus').getAttribute('aria-expanded')`)) === 'true', JSON.stringify(await style(chrome, '.footer-plus svg', ['transform'])))

  // ---- 2. the card ----
  const card = await rect(ui, '.plus-menu')
  const height = plusMenuHeight()
  const content = win.getContentBounds()
  check(`the card has the size the main process reserves for it (at least ${PLUS_MENU.width} px wide, ${height} tall)`, !!card && card.w >= PLUS_MENU.width && near(card.h, height), fmt(card))
  check('it hangs from the button: above it, not covering it, inside the window', hangsFrom(card, button) && within(card, { x: 0, y: 0, w: content.width, h: content.height }), `${fmt(card)} / button ${fmt(button)}`)
  const cardFill = await style(ui, '.plus-menu', ['background-color'])
  // The card is a hint of the accent over the surface of the interface (`--plus-fill`, dark in the dark appearance the run pins).
  check('the card is the colour of the interface\'s surface with a hint of the space\'s colour (--plus-fill)', cardFill?.['background-color'] === (await tokenColor('--plus-fill')), JSON.stringify({ cardFill, fill: await tokenColor('--plus-fill') }))
  const arrow = await rect(ui, '.plus-arrow')
  check('a bump points at the button: under the card, over the button', !!card && !!arrow && near(arrow.y, card.y + card.h, 1) && arrow.x + arrow.w / 2 >= button.x && arrow.x + arrow.w / 2 <= button.x + button.w, fmt(arrow))

  const rows = await rects(ui, '.plus-row')
  // « Nouvel onglet » is not in the + any more (the row of the list and ⌘T are the way to a new tab): four rows, in three groups.
  check('four rows inside the card, one under the other without overlap', rows.length === 4 && rows.every((row, i) => within(row, card) && (i === 0 || row.y >= rows[i - 1]!.y + rows[i - 1]!.h - 0.5)), rows.map(fmt).join(' | '))
  const separators = await rects(ui, '.plus-separator')
  check('two separators divide the rows in three groups: the space and the folder, the Tweak, the split view', separators.length === 2 && rows.length === 4 && within(separators[0], card) && within(separators[1], card) && separators[0]!.y >= rows[1]!.y + rows[1]!.h - 0.5 && separators[0]!.y + separators[0]!.h <= rows[2]!.y + 0.5 && separators[1]!.y >= rows[2]!.y + rows[2]!.h - 0.5 && separators[1]!.y + separators[1]!.h <= rows[3]!.y + 0.5, `${JSON.stringify(separators)} ${rows.map(fmt).join(' | ')}`)
  const labels = await evaluate<string[]>(ui, `[...document.querySelectorAll('.plus-row')].map((row) => row.querySelector('.plus-label').textContent)`)
  check('the rows are the space, the folder, the Tweak and the split view, in that order and in French', JSON.stringify(labels) === JSON.stringify(['Nouvel espace', 'Nouveau dossier', 'Nouvelle Retouche', 'Nouvelle vue scindée']), JSON.stringify(labels))
  const keys = await evaluate<string[]>(ui, `[...document.querySelectorAll('.plus-row')].map((row) => row.querySelector('.plus-key')?.textContent ?? '')`)
  check('the shortcuts in force are shown at the right: ⌃ ⇧ = for the split, none for the rest (none on the Tweak row)', JSON.stringify(keys) === JSON.stringify(['', '', '', '⌃ ⇧ =']), JSON.stringify(keys))
  const parts = await evaluate<{ row: Box; icon: Box; label: Box; key: Box } | null>(ui, `(() => { const row = document.querySelector('.plus-row[data-entry="split"]'); if (!row) return null; const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }; return { row: box(row), icon: box(row.querySelector('.plus-icon')), label: box(row.querySelector('.plus-label')), key: box(row.querySelector('.plus-key')) } })()`)
  check('inside a row: the glyph, then the label, then the shortcut at the right, all within the row and none over another', !!parts && [parts.icon, parts.label, parts.key].every((b) => within(b, parts.row)) && parts.icon.x + parts.icon.w <= parts.label.x + 0.5 && parts.label.x + parts.label.w <= parts.key.x + 0.5, JSON.stringify(parts))
  shot('plus-open')

  // ---- 3. the choice: the last row is preselected; the pointer and the arrows move it ----
  check('the last row, "Nouvelle vue scindée", is preselected, with the --plus-line fill', (await selectedRow()) === 'split' && JSON.stringify(await style(ui, '.plus-row.selected', ['background-color'])) === JSON.stringify({ 'background-color': await tokenColor('--plus-line') }))
  const folderRow = (await rowRect('folder'))!
  mouse(ui, 'mouseMove', centre(folderRow).x - 20, centre(folderRow).y)
  mouse(ui, 'mouseMove', centre(folderRow).x, centre(folderRow).y)
  check('the pointer over a row selects it, and only that one', (await waitFor(async () => (await selectedRow()) === 'folder')) && (await evaluate<number>(ui, `document.querySelectorAll('.plus-row.selected').length`)) === 1)
  const walked: Array<string | null> = []
  for (const arrow of ['Down', 'Down', 'Down', 'Down', 'Up']) {
    await key(arrow)
    walked.push(await selectedRow())
  }
  check('the arrows go from row to row and wrap around (down from the folder: Tweak, split, then the first row, then the folder again; up: the first row)', JSON.stringify(walked) === JSON.stringify(['boost', 'split', 'space', 'folder', 'space']), JSON.stringify(walked))

  // ---- 4. each row, with a real click ----
  const folders = foldersOf().length
  await click(ui, centre((await rowRect('folder'))!).x, centre((await rowRect('folder'))!).y)
  check('a click on "Nouveau dossier" closes the popover and makes a folder in the space on screen', browser.currentPanel() === null && foldersOf().length === folders + 1 && foldersOf().some((f) => f.name === 'Nouveau dossier'), JSON.stringify(foldersOf().map((f) => f.name)))
  check('… and the cross goes back to a plus', (await waitFor(() => !browser.snapshot().plusOpen, 1500)) && (await waitFor(async () => (await style(chrome, '.footer-plus svg', ['transform']))?.['transform'] === 'none', 1500)))
  await openPlus()
  await click(ui, centre((await rowRect('space'))!).x, centre((await rowRect('space'))!).y)
  check('a click on "Nouvel espace" opens the space creation sheet', browser.currentPanel() === 'spacecreate', JSON.stringify(browser.currentOverlay()))
  browser.closeOverlay()
  await sleep(200)
  await openPlus()
  await click(ui, centre((await rowRect('boost'))!).x, centre((await rowRect('boost'))!).y)
  check('a click on "Nouvelle Retouche" opens the Tweak editor for the site on screen', JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'boost', host: '127.0.0.1' }), JSON.stringify(browser.currentOverlay()))
  browser.closeOverlay()
  await sleep(200)
  await openPlus()
  await click(ui, centre((await rowRect('split'))!).x, centre((await rowRect('split'))!).y)
  check('a click on "Nouvelle vue scindée" opens the command bar for a page beside this one', JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'commandbar', mode: 'split', initial: '' }), JSON.stringify(browser.currentOverlay()))
  browser.closeOverlay()
  await sleep(200)

  // ---- 5. the keyboard and the way out ----
  await openPlus()
  await key('Return')
  check('Return takes the preselected row: the command bar for a page beside this one', JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'commandbar', mode: 'split', initial: '' }), JSON.stringify(browser.currentOverlay()))
  browser.closeOverlay()
  await sleep(200)
  await openPlus()
  await key('Down')
  await key('Return')
  check('Down wraps to the first row and Return takes it: the space creation sheet', browser.currentPanel() === 'spacecreate', JSON.stringify(browser.currentOverlay()))
  browser.closeOverlay()
  await sleep(200)
  await openPlus()
  await key('Escape')
  check('Escape closes the popover and creates nothing', (await waitFor(() => browser.currentPanel() === null, 1500)) && foldersOf().length === folders + 1)
  check('… and the sidebar is told: the cross is a plus again', (await waitFor(() => !browser.snapshot().plusOpen, 1500)) && (await waitFor(async () => (await style(chrome, '.footer-plus svg', ['transform']))?.['transform'] === 'none', 1500)))
  await openPlus()
  await click(ui, 900, 300)
  check('a click outside closes it too, with no side effect', (await waitFor(() => browser.currentPanel() === null, 1500)) && foldersOf().length === folders + 1 && !browser.snapshot().plusOpen)
  await openPlus()
  // The overlay covers the window: the pointer reaches it, not the button below.
  await click(ui, centre(await plusButton()).x, centre(await plusButton()).y)
  check('a click on the cross (the + while the popover is open) closes it instead of opening another', (await waitFor(() => browser.currentPanel() === null, 1500)) && nativeMenus.length === 0)

  // ---- 6. a space with no tab: no site to tweak, no page to put a split beside ----
  browser.dispatch({ type: 'space/create', name: 'Plus vide', emoji: '⬜', hue: 20 })
  const emptySpace = store.get().activeSpaceId
  const emptyTabs = store.get().tabs.filter((t) => t.spaceId === emptySpace)
  for (const tab of emptyTabs) browser.dispatch({ type: 'tab/close', id: tab.id })
  await sleep(500)
  await openPlus()
  const disabled = await evaluate<string[]>(ui, `[...document.querySelectorAll('.plus-row[aria-disabled="true"]')].map((row) => row.dataset.entry)`)
  check('with no tab on screen, "Nouvelle Retouche" and "Nouvelle vue scindée" are greyed out', JSON.stringify(disabled) === JSON.stringify(['boost', 'split']), JSON.stringify(disabled))
  const greyed = await style(ui, '.plus-row[data-entry="boost"]', ['color'])
  check('… in the third text colour of the interface (--text-3)', greyed?.['color'] === (await tokenColor('--text-3', 'color')), JSON.stringify({ greyed, token: await tokenColor('--text-3', 'color') }))
  const boostRow = (await rowRect('boost'))!
  mouse(ui, 'mouseMove', centre(boostRow).x - 20, centre(boostRow).y)
  mouse(ui, 'mouseMove', centre(boostRow).x, centre(boostRow).y)
  // A fixed wait, for want of a witness: a move over a greyed row changes nothing, and the page says nothing of a move it ignored; another row
  // hovered after it would show its own selection, not whether this one was taken.
  await sleep(120)
  check('the pointer does not select a greyed row: the preselected one (the last enabled) stays', (await selectedRow()) === 'folder', String(await selectedRow()))
  const splitRow = (await rowRect('split'))!
  await click(ui, centre(boostRow).x, centre(boostRow).y)
  const afterBoost = JSON.stringify(browser.currentOverlay())
  await click(ui, centre(splitRow).x, centre(splitRow).y)
  check('a click on a greyed row does nothing: the popover stays, whichever the row', afterBoost.startsWith('{"panel":"plus"') && browser.currentPanel() === 'plus', `${afterBoost} then ${browser.currentPanel()}`)
  await key('Up')
  check('the arrows skip the greyed rows', (await selectedRow()) === 'space', String(await selectedRow()))
  shot('plus-greyed')
  browser.closeOverlay()
  await sleep(200)
  browser.dispatch({ type: 'space/delete', id: emptySpace })
  browser.dispatch({ type: 'space/select', id: spaceId })
  await sleep(300)

  // ---- 7. what the renderer may ask for ----
  const refused = await evaluate<boolean>(chrome, `(async () => { window.lucium.openOverlay({ panel: 'plus', anchor: { x: 'a', y: 1, width: 1, height: 1 } }); await new Promise((r) => setTimeout(r, 250)); return true })()`)
  check('a request for the popover with a malformed anchor is refused', refused && browser.currentPanel() === null, JSON.stringify(browser.currentOverlay()))
  await evaluate<boolean>(chrome, `(async () => { window.lucium.openOverlay({ panel: 'plus', anchor: { x: ${button.x}, y: ${button.y}, width: ${button.w}, height: ${button.h} } }); await new Promise((r) => setTimeout(r, 250)); return true })()`)
  check('… and one with a real anchor is accepted', browser.currentPanel() === 'plus')
  browser.closeOverlay()
  await sleep(200)

  // ---- 8. from the floating sidebar (the sidebar hidden): the button is further in, and the popover follows it ----
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
  await sleep(700)
  chrome.sendInputEvent({ type: 'mouseMove', x: 1, y: 300 })
  const floatShown = await waitFor(() => browser.isFloatingSidebarShown(), 3000)
  await sleep(500)
  const floatView = win.contentView.children.map((v) => v as Electron.WebContentsView).find((v) => v.webContents.getURL().includes('#float'))
  const floatButton = floatView ? await rect(floatView.webContents, '.footer-plus') : null
  if (floatView && floatButton) await click(floatView.webContents, centre(floatButton).x, centre(floatButton).y)
  const floatOpen = await waitFor(() => browser.currentPanel() === 'plus')
  await sleep(450)
  const floatCard = await rect(ui, '.plus-menu')
  check('opened from the floating sidebar, the popover hangs from that button (inset like the panel)', floatShown && floatOpen && !!floatButton && hangsFrom(floatCard, floatButton) && near(floatButton.x, button.x + FLOATING_INSET, 1.5), `${fmt(floatCard)} / button ${fmt(floatButton)}`)
  browser.closeOverlay()
  await sleep(200)
  browser.hotEdge(false)
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
  await sleep(600)

  // ---- clean up ----
  Menu.prototype.popup = realPopup
  for (const folder of foldersOf()) browser.dispatch({ type: 'folder/delete', id: folder.id } as never)
  browser.dispatch({ type: 'space/select', id: previousSpace })
  browser.dispatch({ type: 'space/delete', id: spaceId })
  browser.dispatch({ type: 'settings/update', patch: previousSettings })
  win.setBounds(savedBounds)
  server.close()
}

/** `LUCIUM_SMOKE_ONLY=iso-plus`: only these checks, with their own report (a quick loop while working on the popover). */
export async function runIsoPlusSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    const verbose = process.env['LUCIUM_ISO_PLUS_VERBOSE'] === '1'
    await smokeIsoPlus(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`ISO-PLUS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeIsoPlus ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ISO_PLUS ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
