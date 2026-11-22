// Engine checks for accessibility and for the look of the window, run inside a real Electron.
//
//  1. The audit of every surface of the interface (sidebar and toolbar, each panel, each pane of Settings, the task manager): the
//     accessibility tree Chromium builds is read through the debugging protocol of the surface's own web contents (nothing else is
//     attached to, and the debugger is detached at once), and every control must have a name, every switch and tab its state; the
//     Tab key is pressed for real to read the tab order and to see that a focused control looks focused; the text contrast is measured
//     on the pixels (the text is hidden for the capture, so what is read is the real background, gradients and translucency included).
//  2. The readable mode (Dark and Light) on real pages (a light page, a dark page, an image that must keep its colours, sites of their own, the interface
//     being light, a page that tampers with its own world, the settings turned off again): the recolouring engine runs in the page's readable world.
//  3. The border of the window around the page, and the translucent window.
//
// With LUCIUM_A11Y_DUMP=<file>, the raw findings are written there as JSON (for docs/accessibilite.md); nothing is written otherwise.
// Called from the engine smoke test: `await smokeA11y(ctx, check)`.

import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow as ElectronWindow, Menu, nativeTheme, systemPreferences, type MenuItem, type WebContents, type WebContentsView } from 'electron'
import { MIN_TARGET_PX, auditAxTree, composite, contrastRatio, parseColor, requiredContrast, type AxFinding, type AxNode, type Rgba } from '@shared/a11y-audit'
import { PAGE_MARGIN, TOOLBAR_BAR_HEIGHT } from '@shared/ipc'
import type { OverlayRequest } from '@shared/ipc'
import type { SmokeContext } from './smoke'
import { systemScrollBars } from './shell/system-scroll-bars'
import { noteCheck, OPEN_MORE_SETTINGS, openSiteSections, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

// ---------- reading a surface ----------

const evaluate = <T>(wc: WebContents, js: string) => wc.executeJavaScript(js) as Promise<T>

/** Reads `script` in a web contents that is asked for a media feature (`prefers-contrast: more`): the debugger is attached for that only. */
async function withMedia<T>(wc: WebContents, feature: { name: string; value: string }, script: string): Promise<T> {
  const dbg = wc.debugger
  const attachedHere = !dbg.isAttached()
  if (attachedHere) dbg.attach('1.3')
  try {
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [feature] })
    await sleep(150)
    return await evaluate<T>(wc, script)
  } finally {
    if (dbg.isAttached()) {
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch((error: unknown) => console.warn('[a11y] cannot put the media features back:', error))
      if (attachedHere) dbg.detach()
    }
  }
}

const press = (wc: WebContents, keyCode: string, modifiers: Array<'shift'> = []) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  return sleep(90)
}

/**
 * The Return key as a keyboard sends it: the key going down, the character it types, the key going up. A button is clicked by Return on the character
 * (the `keypress` of the page), which a key going down and up alone does not make; a handler of `keydown` (a field, a list) hears it either way.
 */
const pressReturn = (wc: WebContents) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  return sleep(90)
}

/** The accessibility tree of a web contents, and the beginning of the markup of the nodes the rules flag. */
async function readAxTree(wc: WebContents, flagged: (nodes: AxNode[]) => AxFinding[]): Promise<{ nodes: number; findings: Array<AxFinding & { html: string }> }> {
  const dbg = wc.debugger
  const attachedHere = !dbg.isAttached()
  if (attachedHere) dbg.attach('1.3')
  try {
    await dbg.sendCommand('DOM.enable')
    await dbg.sendCommand('Accessibility.enable')
    const { nodes } = (await dbg.sendCommand('Accessibility.getFullAXTree')) as { nodes: AxNode[] }
    const findings = flagged(nodes)
    const out: Array<AxFinding & { html: string }> = []
    for (const finding of findings.slice(0, 40)) {
      let html = ''
      if (finding.backendDOMNodeId !== undefined) {
        try {
          html = ((await dbg.sendCommand('DOM.getOuterHTML', { backendNodeId: finding.backendDOMNodeId })) as { outerHTML: string }).outerHTML.slice(0, 200)
        } catch (error) {
          html = `(markup unavailable: ${error instanceof Error ? error.message : String(error)})`
        }
      }
      out.push({ ...finding, html })
    }
    return { nodes: nodes.filter((n) => !n.ignored).length, findings: out }
  } finally {
    if (attachedHere && dbg.isAttached()) dbg.detach()
  }
}

/** What the markup of a surface says that the tree does not: the language, small targets, tab indexes above 0, live regions. */
const DOM_AUDIT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' }
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
  const SELECTOR = 'button, a[href], select, textarea, summary, input:not([type=hidden]), [role=button], [role=tab], [role=switch], [role=checkbox], [role=menuitem], [role=option], [role=radio], [role=link], [tabindex]:not([tabindex="-1"])'
  const small = []
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (!visible(el)) continue
    // A checkbox or switch inside a label: the label is the target.
    const target = el.matches('input') && el.closest('label') ? el.closest('label') : el
    const r = target.getBoundingClientRect()
    if (r.width < ${MIN_TARGET_PX} || r.height < ${MIN_TARGET_PX}) small.push({ d: describe(el), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 })
  }
  return {
    lang: document.documentElement.lang,
    title: document.title,
    small,
    positiveTabindex: [...document.querySelectorAll('[tabindex]')].filter((el) => Number(el.getAttribute('tabindex')) > 0).map(describe),
    liveRegions: document.querySelectorAll('[aria-live], [role=status], [role=alert], [role=log]').length
  }
})()`

/** One signature of how an element and its two parents are drawn; a focused control that looks the same is not seen to be focused. */
const FOCUS_PROBE = `(() => {
  const sig = (el) => { const s = getComputedStyle(el); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.backgroundColor, s.color, s.borderTopColor, s.textDecorationLine, s.opacity].join('|') }
  const chain = (el) => [el, el.parentElement, el.parentElement?.parentElement].filter(Boolean)
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
  window.__a11yBase = new Map()
  const SELECTOR = 'button, a[href], select, textarea, summary, input:not([type=hidden]), [role=button], [role=tab], [role=switch], [role=checkbox], [role=menuitem], [role=option], [role=radio], [tabindex]'
  for (const el of document.querySelectorAll(SELECTOR)) window.__a11yBase.set(el, chain(el).map(sig))
  window.__a11yStop = () => {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return null
    const base = window.__a11yBase.get(el)
    const now = chain(el).map(sig)
    const r = el.getBoundingClientRect()
    return { d: describe(el), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().slice(0, 40), looksFocused: base ? now.some((s, i) => s !== base[i]) : true, outlineNone: getComputedStyle(el).outlineStyle === 'none', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return true
})()`

interface TabStop {
  d: string
  role: string
  name: string
  looksFocused: boolean
  outlineNone: boolean
  x: number
  y: number
  w: number
  h: number
}

/** Presses Tab for real, up to `max` times, until the focus comes back to where it began or leaves the page. */
async function walkTabs(wc: WebContents, max: number): Promise<{ stops: TabStop[]; leftThePage: boolean; wrapped: boolean }> {
  wc.focus()
  await evaluate(wc, `(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`)
  await evaluate(wc, FOCUS_PROBE)
  const stops: TabStop[] = []
  let leftThePage = false
  let wrapped = false
  for (let i = 0; i < max; i++) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await sleep(35)
    const stop = await evaluate<TabStop | null>(wc, 'window.__a11yStop()')
    if (!stop) {
      leftThePage = true
      break
    }
    if (stops.length > 0 && stops[0]!.d === stop.d && stops[0]!.x === stop.x && stops[0]!.y === stop.y) {
      wrapped = true
      break
    }
    stops.push(stop)
  }
  await evaluate(wc, `(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`)
  return { stops, leftThePage, wrapped }
}

interface TextBox {
  text: string
  fg: string
  size: number
  weight: number
  opacity: number
  rects: Array<{ x: number; y: number; w: number; h: number }>
}

const TEXT_BOXES = `(() => {
  const out = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode()) && out.length < 400) {
    const text = node.textContent.replace(/\\s+/g, ' ').trim()
    if (text.length < 1) continue
    const el = node.parentElement
    if (!el || el.closest('script, style, noscript, [disabled], [aria-disabled=true]')) continue
    let opacity = 1, hidden = false
    for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden') hidden = true; opacity *= Number(s.opacity) }
    if (hidden || opacity === 0) continue
    const range = document.createRange(); range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter((r) => r.width >= 2 && r.height >= 4 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight).slice(0, 1)
    if (rects.length === 0) continue
    const s = getComputedStyle(el)
    out.push({ text: text.slice(0, 60), fg: s.color, size: parseFloat(s.fontSize), weight: Number(s.fontWeight) || 400, opacity, rects: rects.map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })) })
  }
  return { boxes: out, width: innerWidth, height: innerHeight }
})()`

const HIDE_TEXT = `(() => { const s = document.createElement('style'); s.id = '__a11y_hide'; s.textContent = '*, *::before, *::after { color: transparent !important; text-shadow: none !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important } ::placeholder { color: transparent !important }'; document.head.appendChild(s); return true })()`
const SHOW_TEXT = `(() => { document.getElementById('__a11y_hide')?.remove(); return true })()`

interface ContrastFailure {
  text: string
  ratio: number
  required: number
  fg: string
  bg: string
  size: number
}

/** The contrast of every visible text of the surface, on the background that is really behind it (read on a capture made with the text hidden). */
async function measureContrast(wc: WebContents): Promise<{ checked: number; failures: ContrastFailure[]; skipped: number } | null> {
  const { boxes, width } = await evaluate<{ boxes: TextBox[]; width: number; height: number }>(wc, TEXT_BOXES)
  if (boxes.length === 0) return { checked: 0, failures: [], skipped: 0 }
  await evaluate(wc, HIDE_TEXT)
  await sleep(120)
  let image
  try {
    image = await wc.capturePage()
  } finally {
    await evaluate(wc, SHOW_TEXT)
  }
  if (image.isEmpty()) return null
  const scale = image.getSize().width / width
  const bitmap = image.toBitmap()
  const stride = image.getSize().width * 4
  const pixel = (x: number, y: number): Rgba | null => {
    const px = Math.min(image.getSize().width - 1, Math.max(0, Math.round(x * scale)))
    const py = Math.min(image.getSize().height - 1, Math.max(0, Math.round(y * scale)))
    const at = py * stride + px * 4
    // BGRA on macOS.
    const a = bitmap[at + 3]! / 255
    return a < 0.98 ? null : { r: bitmap[at + 2]!, g: bitmap[at + 1]!, b: bitmap[at]!, a: 1 }
  }
  const failures: ContrastFailure[] = []
  let checked = 0
  let skipped = 0
  for (const box of boxes) {
    const fg = parseColor(box.fg)
    const rect = box.rects[0]!
    if (!fg || fg.a === 0) {
      skipped++
      continue
    }
    const samples = [
      [rect.x + 1, rect.y + 1], [rect.x + rect.w - 1, rect.y + 1], [rect.x + 1, rect.y + rect.h - 1], [rect.x + rect.w - 1, rect.y + rect.h - 1], [rect.x + rect.w / 2, rect.y + rect.h / 2]
    ].map(([x, y]) => pixel(x!, y!))
    const known = samples.filter((s): s is Rgba => s !== null)
    if (known.length === 0) {
      skipped++
      continue
    }
    checked++
    const text: Rgba = { ...fg, a: fg.a * box.opacity }
    const worst = known.map((bg) => ({ bg, ratio: contrastRatio(text, bg) })).sort((a, b) => a.ratio - b.ratio)[0]!
    const required = requiredContrast(box.size, box.weight)
    if (worst.ratio < required) {
      const shown = composite(text, worst.bg)
      failures.push({ text: box.text, ratio: Math.round(worst.ratio * 100) / 100, required, fg: `rgb(${Math.round(shown.r)} ${Math.round(shown.g)} ${Math.round(shown.b)})`, bg: `rgb(${worst.bg.r} ${worst.bg.g} ${worst.bg.b})`, size: box.size })
    }
  }
  return { checked, failures, skipped }
}

interface SurfaceReport {
  name: string
  nodes: number
  lang: string
  findings: Array<AxFinding & { html: string }>
  small: Array<{ d: string; w: number; h: number }>
  positiveTabindex: string[]
  liveRegions: number
  tabStops: number
  tabLeftThePage: boolean
  tabWrapped: boolean
  noFocusIndicator: string[]
  stops: string[]
  contrast: { checked: number; failures: ContrastFailure[]; skipped: number } | null
}

async function auditSurface(name: string, wc: WebContents, options: { tabs?: boolean; contrast?: boolean } = {}): Promise<SurfaceReport> {
  const tree = await readAxTree(wc, auditAxTree)
  const dom = await evaluate<{ lang: string; title: string; small: SurfaceReport['small']; positiveTabindex: string[]; liveRegions: number }>(wc, DOM_AUDIT)
  const walk = options.tabs === false ? { stops: [], leftThePage: false, wrapped: false } : await walkTabs(wc, 90)
  const contrast = options.contrast === false ? null : await measureContrast(wc)
  return {
    name,
    nodes: tree.nodes,
    lang: dom.lang,
    findings: tree.findings,
    small: dom.small,
    positiveTabindex: dom.positiveTabindex,
    liveRegions: dom.liveRegions,
    tabStops: walk.stops.length,
    tabLeftThePage: walk.leftThePage,
    tabWrapped: walk.wrapped,
    noFocusIndicator: walk.stops.filter((s) => !s.looksFocused).map((s) => `${s.d} "${s.name}"`),
    stops: walk.stops.slice(0, 40).map((s) => `${s.d}${s.role ? ` [${s.role}]` : ''} "${s.name}" ${s.w}x${s.h}`),
    contrast
  }
}

// ---------- the run ----------

const DARK_PAGE = '<!doctype html><title>dark</title><body style="margin:0;background:#101018;color:#eee"><p style="margin:40px">sombre</p>'
const LIGHT_PAGE = `<!doctype html><title>light</title><body style="margin:0;background:#fff;color:#111"><p style="margin:40px">clair</p><div style="position:absolute;left:300px;top:60px;width:120px;height:80px;background:#fff"><img id="red" alt="" style="width:120px;height:80px;display:block" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='%23ff0000'/%3E%3C/svg%3E"></div>`
const BARE_PAGE = '<!doctype html><title>bare</title><body>nu</body>'
// A page that breaks a function of its own world the probe calls: the probe runs in the readable world, where the page's change does not reach.
const HOSTILE_PAGE = '<!doctype html><title>hostile</title><body style="margin:0;background:#fff">hostile<script>document.elementFromPoint = () => { throw new Error("no") }</script>'

export async function smokeA11y(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const chrome = win.webContents
  const ui = overlayView.webContents
  const state = () => store.get()
  const settings = () => state().settings
  const dump: Record<string, unknown> = {}
  // Run after other suites in one process: the window is shown (a hidden or minimized one draws no new frame, and every pixel read here would be an old one).
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'close')
    if (url.pathname === '/light') return void res.end(LIGHT_PAGE)
    if (url.pathname === '/dark') return void res.end(DARK_PAGE)
    if (url.pathname === '/bare') return void res.end(BARE_PAGE)
    if (url.pathname === '/hostile') return void res.end(HOSTILE_PAGE)
    res.end(`<!doctype html><title>ay ${url.pathname}</title><body>page</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const alias = `http://localhost:${port}`

  const mine = new Set<string>()
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const open = async (url: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = state().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => browser.snapshot().runtime.tabs[tab.id]?.loading === false && wcOf(tab.id)?.getURL().startsWith('http') === true)
    await sleep(250)
    return tab.id
  }
  /** The colour scheme of a page: the engine of the readable mode gives the page it recolours its scheme (the test pages declare none). */
  const schemeOf = (id: string) => evaluate<string>(wcOf(id)!, `getComputedStyle(document.documentElement).colorScheme`)
  const isRecoloured = async (id: string) => /^(dark|light)$/.test((await schemeOf(id)).trim())
  /** The colour of a pixel of the page as the user sees it (a capture shows what the compositor painted). */
  const pixelOf = async (id: string, x: number, y: number): Promise<{ r: number; g: number; b: number }> => {
    const image = await wcOf(id)!.capturePage({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 })
    const [b = 0, g = 0, r = 0] = [...image.toBitmap()]
    return { r, g, b }
  }
  type Pixel = { r: number; g: number; b: number }
  /**
   * A pixel of a page that is on screen, read until `ok` accepts it. Two things make a single read unreliable in a process that has run other
   * suites: a page of a tab that is not shown is not drawn again after its style changed (a capture of it gives its last frame, the old one), and
   * the compositor draws a changed page a frame or two later. So the tab is shown first, and the read is repeated; the last pixel read is returned.
   */
  const seen = async (id: string, x: number, y: number, ok: (pixel: Pixel) => boolean, timeoutMs = 6000): Promise<Pixel> => {
    browser.dispatch({ type: 'tab/select', id })
    await waitFor(() => state().activeTabBySpace[state().activeSpaceId] === id, 3000)
    const deadline = Date.now() + timeoutMs
    let pixel = await pixelOf(id, x, y)
    while (!ok(pixel) && Date.now() < deadline) {
      await sleep(150)
      pixel = await pixelOf(id, x, y)
    }
    return pixel
  }
  /** What is known about a page that was read: whether it is drawn at all (shown, visible, in a window that is on screen). Added to the detail of a check that fails. */
  const drawn = async (id: string): Promise<string> =>
    JSON.stringify({
      active: state().activeTabBySpace[state().activeSpaceId] === id,
      visibility: await evaluate<string>(wcOf(id)!, 'document.visibilityState').catch(() => 'unreadable'),
      window: { visible: win.isVisible(), minimized: win.isMinimized(), fullScreen: win.isFullScreen() }
    })
  const lum = ({ r, g, b }: { r: number; g: number; b: number }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const original = { ...settings() }
  const patch = (changes: Parameters<typeof browser.dispatch>[0] extends infer A ? (A extends { type: 'settings/update'; patch: infer P } ? P : never) : never) => browser.dispatch({ type: 'settings/update', patch: changes })
  const warnings: string[] = []
  const realWarn = console.warn

  try {
// ======================= 1. readable mode =======================
    check('a11y dark: the readable mode is Original by default, for every site, and no site has a mode of its own', original.readableMode === 'original' && Object.keys(original.siteReadableMode).length === 0)
    const light = await open(`${base}/light`)
    const dark = await open(`${base}/dark`)
    const bare = await open(`${base}/bare`)
    check('a11y dark: Original, a light page is left as it is (nothing recolours it)', !(await isRecoloured(light)) && !(await isRecoloured(dark)), `${await schemeOf(light)}`)
    const whiteBefore = await seen(light, 150, 300, (p) => lum(p) > 0.9)
    check('a11y dark: Original, the white page is white', lum(whiteBefore) > 0.9, JSON.stringify(whiteBefore))

    patch({ readableMode: 'dark' })
    check('a11y dark: Dark, a light page is recoloured dark, live (no reload)', await waitFor(async () => await isRecoloured(light), 6000), await schemeOf(light))
    check('a11y dark: …and a page that is dark already does not', !(await isRecoloured(dark)), await schemeOf(dark))
    const darkened = await seen(light, 150, 300, (p) => lum(p) < 0.2)
    check('a11y dark: …the white page is dark on screen (the recolouring is really painted)', lum(darkened) < 0.2, `${JSON.stringify(darkened)} ${await drawn(light)}`)
    const imageSeen = await seen(light, 360, 100, (p) => p.r > 190 && p.g < 90 && p.b < 90)
    check('a11y dark: …an image keeps its colours (red stays red)', imageSeen.r > 190 && imageSeen.g < 90 && imageSeen.b < 90, `${JSON.stringify(imageSeen)} ${await drawn(light)}`)
    const textOn = await evaluate<{ fg: string; bg: string }>(wcOf(light)!, `({ fg: getComputedStyle(document.querySelector('p')).color, bg: getComputedStyle(document.body).backgroundColor })`)
    const recolouredRatio = contrastRatio(parseColor(textOn.fg) ?? { r: 0, g: 0, b: 0, a: 1 }, parseColor(textOn.bg) ?? { r: 255, g: 255, b: 255, a: 1 })
    check('a11y dark: …its text reaches the 4.5 : 1 of WCAG on its recoloured background', recolouredRatio >= 4.5, JSON.stringify({ ...textOn, ratio: recolouredRatio }))
    const bareSeen = await seen(bare, 400, 400, (p) => lum(p) < 0.25)
    check('a11y dark: …a page with no background of its own is dark too (its canvas follows the dark scheme)', await isRecoloured(bare) && lum(bareSeen) < 0.25, `${await schemeOf(bare)} ${JSON.stringify(bareSeen)}`)
    const darkSeen = await seen(dark, 400, 400, (p) => lum(p) < 0.15)
    check('a11y dark: …a dark page keeps its own dark (and is not the black of an empty capture: it is #101018)', lum(darkSeen) < 0.15 && darkSeen.b > darkSeen.r, JSON.stringify(darkSeen))

    // Light is the opposite: a dark page is turned light, a light page is left alone.
    patch({ readableMode: 'light' })
    check('a11y light: Light, a dark page is recoloured light, live (no reload)', await waitFor(async () => await isRecoloured(dark), 6000), await schemeOf(dark))
    check('a11y light: …and a page that is light already does not', await waitFor(async () => !(await isRecoloured(light)) && !(await isRecoloured(bare)), 6000), `${await schemeOf(light)} ${await schemeOf(bare)}`)
    const lightened = await seen(dark, 400, 400, (p) => lum(p) > 0.6)
    check('a11y light: …the dark page is light on screen (the recolouring is really painted)', lum(lightened) > 0.6, `${JSON.stringify(lightened)} ${await drawn(dark)}`)
    patch({ readableMode: 'dark' })
    check('a11y light: back to Dark, the dark page gets its own colours back and the light page is recoloured', await waitFor(async () => !(await isRecoloured(dark)) && (await isRecoloured(light)), 6000))

    // A page that breaks the functions of its own world cannot fool the probe nor stop the engine: both run in the page's readable world.
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
      realWarn(...args)
    }
    const hostile = await open(`${base}/hostile`)
    check('a11y dark: a page that breaks `elementFromPoint` in its own world is still read, and recoloured', await waitFor(async () => await isRecoloured(hostile), 6000), await schemeOf(hostile))
    check('a11y dark: …and nothing about it is logged', !warnings.some((w) => w.includes('[dark-sites]') && w.includes(`tab ${hostile}`)), JSON.stringify(warnings))
    console.warn = realWarn

    // A mode of its own: localhost is another site than 127.0.0.1 though it is the same server.
    const sameServer = await open(`${alias}/light`)
    check('a11y dark: another host name of the same server is recoloured too', await waitFor(async () => await isRecoloured(sameServer), 6000))
    patch({ siteReadableMode: { localhost: 'original' } })
    check('a11y dark: a site set to Original gets its own colours back at once', await waitFor(async () => !(await isRecoloured(sameServer)), 6000), await schemeOf(sameServer))
    check('a11y dark: …and the other site keeps it', await isRecoloured(light))
    const reloaded = await open(`${alias}/light`)
    check('a11y dark: …and a new page of that site is not recoloured', !(await isRecoloured(reloaded)))
    patch({ siteReadableMode: {} })
    check('a11y dark: taking the site off the list recolours it again', await waitFor(async () => await isRecoloured(sameServer), 6000))

    // The default "Automatique": Dark while the interface is dark, nothing while it is light.
    patch({ readableMode: 'auto' })
    browser.setSystemDark(false)
    check('a11y dark: Automatique: a light interface leaves the sites alone', await waitFor(async () => !(await isRecoloured(light)), 6000), await schemeOf(light))
    browser.setSystemDark(true)
    check('a11y dark: …and a dark one recolours them again', await waitFor(async () => await isRecoloured(light), 6000))
    browser.setSystemDark(nativeTheme.shouldUseDarkColors)
    patch({ readableMode: 'dark' })

    // A reload is a new document: the engine starts again.
    wcOf(light)!.reload()
    await sleep(400)
    await waitFor(() => browser.snapshot().runtime.tabs[light]?.loading === false)
    check('a11y dark: after a reload the page is recoloured again', await waitFor(async () => await isRecoloured(light), 6000))

    // The View menu entry, and the control centre row.
    const menuItem = (label: string): MenuItem | undefined => {
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
    /** An entry of the submenu « Contraste de la page pour ce site » (« Sombre » and « Clair » are also the choices of the appearance menu). */
    const readableChoice = (label: string): MenuItem | undefined => menuItem('Contraste de la page pour ce site')?.submenu?.items.find((item) => item.label === label)
    browser.dispatch({ type: 'tab/select', id: light })
    check('a11y dark: the View menu offers the readable mode of the site on screen, whatever the default', await waitFor(() => menuItem('Contraste de la page pour ce site')?.enabled === true && readableChoice('Original') !== undefined, 4000))
    readableChoice('Original')?.click()
    check('a11y dark: …choosing Original puts the site on the list, takes the recolouring off, and checks the entry', (await waitFor(() => settings().siteReadableMode['127.0.0.1'] === 'original', 4000)) && (await waitFor(async () => !(await isRecoloured(light)), 6000)) && (await waitFor(() => readableChoice('Original')?.checked === true, 4000)), JSON.stringify(settings().siteReadableMode))
    readableChoice('Comme les autres sites')?.click()
    check('a11y dark: …and “Comme les autres sites” gives it back to the default', (await waitFor(() => Object.keys(settings().siteReadableMode).length === 0, 4000)) && (await waitFor(async () => await isRecoloured(light), 6000)))

    browser.openOverlay({ panel: 'site' })
    await waitFor(() => browser.currentPanel() === 'site')
    // The row is in a section of the panel that is folded until it is opened.
    await sleep(500)
    await openSiteSections((script) => evaluate(ui, script))
    const readableRow = `[...document.querySelectorAll('.scc-setting')].find((row) => row.textContent.includes('Contraste de la page'))`
    check('a11y dark: the control centre has a row « Contraste de la page » for the site, with the default it follows', await waitFor(async () => (await evaluate<string>(ui, `${readableRow}?.textContent ?? ''`)).includes('Par défaut · Sombre'), 4000))
    // The row picks the next mode from the state it shows: each click waits for the row to show the mode of the click before (the panel is told by the main
    // process a moment after the setting changes, and a click before the new state reached it would pick the same mode again).
    const rowSays = (mode: string) => waitFor(async () => (await evaluate<string>(ui, `${readableRow}?.querySelector('.scc-setting-text > span')?.textContent ?? ''`)) === mode, 4000)
    // What the panel and the page say, for the details of the checks below.
    const readableFacts = async () => JSON.stringify({ mode: settings().siteReadableMode, scheme: await schemeOf(light), panel: browser.currentPanel(), row: await evaluate<string>(ui, `${readableRow}?.textContent ?? null`) })
    await evaluate(ui, `${readableRow}?.click()`)
    check('a11y dark: …a click gives the site Sombre of its own', (await waitFor(() => settings().siteReadableMode['127.0.0.1'] === 'dark', 4000)) && (await rowSays('Sombre')), await readableFacts())
    await evaluate(ui, `${readableRow}?.click()`)
    check('a11y dark: …the next one gives it Clair, and a light page is then left as it is', (await waitFor(() => settings().siteReadableMode['127.0.0.1'] === 'light', 4000)) && (await rowSays('Clair')) && (await waitFor(async () => !(await isRecoloured(light)), 6000)), await readableFacts())
    await evaluate(ui, `${readableRow}?.click()`)
    check('a11y dark: …then Original, which leaves the page as it is', (await waitFor(() => settings().siteReadableMode['127.0.0.1'] === 'original', 4000)) && (await rowSays('Original')) && (await waitFor(async () => !(await isRecoloured(light)), 6000)), await readableFacts())
    await evaluate(ui, `${readableRow}?.click()`)
    check('a11y dark: …then back to the default: the site is recoloured again', (await waitFor(() => settings().siteReadableMode['127.0.0.1'] === undefined, 4000)) && (await rowSays('Par défaut · Sombre')) && (await waitFor(async () => await isRecoloured(light), 6000)), await readableFacts())
    browser.closeOverlay()
    patch({ siteReadableMode: {} })

    // The Settings: the groups of the websites and of the window are in Apparence (shared/settings-catalog.ts, SETTINGS_KEYS), not in « Pour commencer ».
    browser.openOverlay({ panel: 'settings', pane: 'appearance' })
    const settingsWindow = async (): Promise<WebContents> => {
      await waitFor(() => ElectronWindow.getAllWindows().some((w) => w.getTitle() === 'Réglages'))
      return ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')!.webContents
    }
    /** Whether the tile of the category `pane` is the current one, and says its short name. */
    const onCategory = (wc: WebContents, pane: string, label: string) =>
      evaluate<boolean>(wc, `(() => { const tile = document.querySelector('.settings-cat[aria-current=page]'); return tile?.getAttribute('data-cat') === ${JSON.stringify(pane)} && tile.textContent.includes(${JSON.stringify(label)}) })()`)
    const sw = await settingsWindow()
    await waitFor(() => onCategory(sw, 'appearance', 'Apparence'), 6000)
    // The rows of the websites and of the window wait in « Plus de réglages »: opened, so that they can be reached.
    await waitFor(() => evaluate<boolean>(sw, OPEN_MORE_SETTINGS), 3000)
    const menuOf = (label: string) => `[...document.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(label)})`
    await waitFor(() => evaluate<boolean>(sw, `!!${menuOf('Contraste de la page pour tous les sites')}`), 6000)
    /** Chooses an entry of a menu of the window (scrolled into view first); false when there is no such menu, so that the check fails instead of the run. */
    const chooseIn = (label: string, value: string) =>
      evaluate<boolean>(sw, `(() => { const s = ${menuOf(label)}; if (!s) return false; s.scrollIntoView({ block: 'center' }); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    check('a11y dark: Settings › Apparence has the menu “Contraste de la page pour tous les sites”, on Sombre', await evaluate<boolean>(sw, `${menuOf('Contraste de la page pour tous les sites')}?.value === 'dark'`))
    check('a11y dark: …Apparence holds the groups of the websites and of the window, and « Pour commencer » holds neither', await (async () => {
      const groups = (text: string) => [text.includes('Apparence des sites'), text.includes('Effet de verre de la fenêtre')]
      const inAppearance = groups(await evaluate<string>(sw, `document.querySelector('.settings-content')?.textContent ?? ''`))
      browser.openOverlay({ panel: 'settings', pane: 'home' })
      await waitFor(() => onCategory(sw, 'home', 'Pour commencer'), 6000)
      await sleep(300)
      const inGeneral = groups(await evaluate<string>(sw, `document.querySelector('.settings-content')?.textContent ?? ''`))
      browser.openOverlay({ panel: 'settings', pane: 'appearance' })
      await waitFor(() => onCategory(sw, 'appearance', 'Apparence'), 6000)
      await sleep(300)
      return inAppearance.every(Boolean) && !inGeneral.some(Boolean)
    })())
    // The list is a subpage of Apparence since 1.1.0 (shared/settings-subpages.ts, `contrast`), opened by its row at the top of the page, as a person does.
    const heading = () => evaluate<string>(sw, `document.querySelector('#pane-heading')?.textContent ?? ''`)
    const contrastRow = `document.querySelector('.settings-content [data-subpage-entry="contrast"] button')`
    await waitFor(() => evaluate<boolean>(sw, `!!${contrastRow}`), 6000)
    await evaluate(sw, `${contrastRow}?.click()`)
    const onContrast = await waitFor(async () => (await heading()) === 'Sites avec un contraste à part', 6000)
    check('a11y dark: …and the list of the sites with a mode of their own is there, empty, even where the mode is on', onContrast && (await evaluate<boolean>(sw, `document.body.textContent.includes('Sites avec un contraste de la page à part') && document.body.textContent.includes('Aucun site n’a de mode à part')`)), await heading())
    // The list takes a site typed in, edits it, and gives it up with “Retirer”.
    const typed = await evaluate<boolean>(sw, `(() => { const field = document.querySelector('input[aria-label="Site à régler"]'); if (!field) return false; field.scrollIntoView({ block: 'center' }); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'exemple.org'); field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    const added = typed && (await waitFor(() => evaluate<boolean>(sw, `(() => { const add = [...document.querySelectorAll('.pref-form .button')].find((b) => b.textContent.trim() === 'Ajouter' && !b.disabled && b.closest('.pref-form')?.querySelector('input[aria-label="Site à régler"]')); if (!add) return false; add.click(); return true })()`), 4000))
    check('a11y dark: …it takes a site typed in, with the opposite of the default (Original, since the default is Sombre)', added && (await waitFor(() => settings().siteReadableMode['exemple.org'] === 'original', 4000)), JSON.stringify(settings().siteReadableMode))
    check('a11y dark: …the menu of the site edits its mode', (await waitFor(() => chooseIn('Contraste de la page sur exemple.org', 'light'), 4000)) && (await waitFor(() => settings().siteReadableMode['exemple.org'] === 'light', 4000)), JSON.stringify(settings().siteReadableMode))
    const removed = await waitFor(() => evaluate<boolean>(sw, `(() => { const b = document.querySelector('button[aria-label="Retirer exemple.org"]'); if (!b) return false; b.click(); return true })()`), 4000)
    check('a11y dark: …and gives it up with “Retirer”', removed && (await waitFor(() => settings().siteReadableMode['exemple.org'] === undefined, 4000)), JSON.stringify(settings().siteReadableMode))
    // The menu for every site is on the page: back there by the way back of the subpage.
    await evaluate(sw, `document.querySelector('.subpage-back')?.click()`)
    await waitFor(async () => (await heading()) === 'Apparence', 6000)
    await waitFor(() => evaluate<boolean>(sw, `!!${menuOf('Contraste de la page pour tous les sites')}`), 6000)
    const toggled = await chooseIn('Contraste de la page pour tous les sites', 'original')
    check('a11y dark: choosing Original for every site turns the mode off everywhere, live', toggled && (await waitFor(() => settings().readableMode === 'original', 4000)) && (await waitFor(async () => !(await isRecoloured(light)) && !(await isRecoloured(sameServer)), 6000)))
    check('a11y dark: off again, no page keeps the recolouring (nothing is left behind)', await waitFor(async () => !(await isRecoloured(light)) && !(await isRecoloured(dark)) && !(await isRecoloured(bare)), 6000))


    // ======================= 2. the border and the look of the window =======================
    const activeId = () => state().activeTabBySpace[state().activeSpaceId]!
    const pageRect = () => {
      const view = win.contentView.children.map((v) => v as WebContentsView).find((v) => v.webContents === wcOf(activeId()))
      return view?.getBounds() ?? null
    }
    browser.dispatch({ type: 'tab/select', id: dark })
    await sleep(400)
    const content = () => win.getContentBounds()
    const margins = () => {
      const r = pageRect()
      const c = content()
      return r ? { top: r.y, left: r.x, right: c.width - (r.x + r.width), bottom: c.height - (r.y + r.height) } : null
    }
    const at = margins()
    check('a11y window: by default the page is inset 10 px from the right and the bottom', !!at && at.right === PAGE_MARGIN && at.bottom === PAGE_MARGIN, JSON.stringify(at))
    const barHeight = at ? at.top - PAGE_MARGIN : 0
    check('a11y window: …and the bar above it starts 10 px from the top', barHeight === TOOLBAR_BAR_HEIGHT || barHeight === TOOLBAR_BAR_HEIGHT + 1, String(barHeight))
    const sidebarLeft = at?.left ?? 0
    for (const border of [0, 4, 20]) {
      patch({ windowBorder: border })
      await sleep(350)
      const m = margins()
      check(`a11y window: a border of ${border} px puts the page ${border} px from the right, the bottom and (under the bar) the top`, !!m && m.right === border && m.bottom === border && m.top === border + barHeight && m.left === sidebarLeft, JSON.stringify(m))
      const css = await evaluate<{ stageTop: number; stageRight: number; var: string }>(chrome, `(() => { const s = document.querySelector('.stage'); const r = s.getBoundingClientRect(); return { stageTop: r.top, stageRight: innerWidth - r.right, var: document.querySelector('.shell').style.getPropertyValue('--window-border') } })()`)
      check(`a11y window: …and the interface agrees (the stage is at the same place)`, css.stageTop === border + TOOLBAR_BAR_HEIGHT && css.stageRight === border && css.var === (border === PAGE_MARGIN ? '' : `${border}px`), JSON.stringify(css))
    }
    patch({ sidebarVisible: false })
    patch({ windowBorder: 6 })
    await sleep(350)
    const hidden = margins()
    check('a11y window: with the sidebar hidden the page is 6 px from the left edge too', !!hidden && hidden.left === 6, JSON.stringify(hidden))
    patch({ sidebarVisible: true, windowBorder: PAGE_MARGIN })
    await sleep(350)
    const back = margins()
    check('a11y window: back to 10 px, the page is where it was', !!back && back.right === PAGE_MARGIN && back.bottom === PAGE_MARGIN && back.top === PAGE_MARGIN + barHeight, JSON.stringify(back))
    check('a11y window: …and the interface carries no variable or class of the look (its markup is the one of before)', await evaluate<boolean>(chrome, `(() => { const s = document.querySelector('.shell'); return !s.classList.contains('translucent') && !s.classList.contains('outlined') && s.style.getPropertyValue('--window-border') === '' && s.style.getPropertyValue('--window-alpha') === '' })()`))

    check('a11y window: the window starts with the default look (no material, opaque)', browser.currentWindowLook() === 'none|opaque', browser.currentWindowLook())
    patch({ sidebarOpacity: 50 })
    check('a11y window: an opacity alone changes nothing (without a material it would only darken the window)', browser.currentWindowLook() === 'none|opaque' && (await evaluate<boolean>(chrome, `!document.querySelector('.shell').classList.contains('translucent')`)))
    patch({ windowVibrancy: 'sidebar' })
    check('a11y window: a material with 50 % opacity makes the window translucent', await waitFor(() => browser.currentWindowLook() === 'sidebar|clear', 4000), browser.currentWindowLook())
    check('a11y window: …the interface draws its colours on a translucent layer', await waitFor(() => evaluate<boolean>(chrome, `(() => { const s = document.querySelector('.shell'); return s.classList.contains('translucent') && s.style.getPropertyValue('--window-alpha') === '0.5' && getComputedStyle(s).backgroundImage === 'none' && getComputedStyle(s, '::before').opacity === '0.5' })()`), 4000))
    await sleep(300)
    const probe = await chrome.capturePage({ x: 20, y: 400, width: 1, height: 1 })
    const alpha = [...probe.toBitmap()][3] ?? 255
    check('a11y window: …and the pixels of the sidebar are really translucent (the material can show through)', alpha < 255, `alpha ${alpha}`)
    patch({ windowVibrancy: 'none' })
    check('a11y window: the material off, the window is opaque again', await waitFor(async () => browser.currentWindowLook() === 'none|opaque' && (await evaluate<boolean>(chrome, `!document.querySelector('.shell').classList.contains('translucent')`)), 4000), browser.currentWindowLook())
    const opaque = await chrome.capturePage({ x: 20, y: 400, width: 1, height: 1 })
    check('a11y window: …and the pixel of the sidebar is opaque', ([...opaque.toBitmap()][3] ?? 0) === 255)
    patch({ sidebarOpacity: 100, cardOutline: true })
    check('a11y window: the hairline around the page is drawn only when asked for', await waitFor(() => evaluate<boolean>(chrome, `(() => { const s = document.querySelector('.shell'); return s.classList.contains('outlined') && getComputedStyle(document.querySelector('.stage'), '::before').boxShadow.includes('255') })()`), 4000))
    patch({ cardOutline: false })
    check('a11y window: …and gone when it is turned off', await waitFor(() => evaluate<boolean>(chrome, `!document.querySelector('.shell').classList.contains('outlined')`), 4000))

    // ======================= 3. the audit of the surfaces =======================
    const reports: SurfaceReport[] = []
    const surface = async (name: string, wc: WebContents, options?: { tabs?: boolean; contrast?: boolean }) => {
      try {
        reports.push(await auditSurface(name, wc, options))
      } catch (error) {
        check(`a11y audit: ${name} could be read`, false, String((error as Error)?.stack ?? error))
      }
    }
    const rootEmpty = () => evaluate<boolean>(ui, `document.querySelector('#root > *') === null`)
    const pressKey = (keyCode: string) => {
      ui.focus()
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
    }
    const overlay = async (name: string, request: OverlayRequest, ready: string, options?: { tabs?: boolean; contrast?: boolean; before?: () => Promise<void>; escape?: boolean }) => {
      const show = async (): Promise<boolean> => {
        browser.closeOverlay()
        await waitFor(rootEmpty, 3000)
        browser.openOverlay(request)
        return waitFor(async () => (await evaluate<number>(ui, `document.querySelectorAll('#root ${ready}').length`)) > 0, 4000)
      }
      try {
        // Escape with the keyboard where it was left on opening: the panel must close, whether or not it has a field to hold the focus.
        if (!(await show())) {
          check(`a11y audit: ${name} opened`, false, `no ${ready}`)
          return
        }
        await sleep(350)
        // (A permission banner and a sign-in box answer to their buttons; their requests here are made up, so there is nothing to answer.)
        if (options?.escape !== false) {
          pressKey('Escape')
          dump[`escape:${name}`] = await waitFor(() => browser.currentPanel() === null, 1500)
        }
        // The audit itself.
        await show()
        await sleep(350)
        await options?.before?.()
        await surface(name, ui, options)
      } catch (error) {
        check(`a11y audit: ${name} ran to the end`, false, String((error as Error)?.stack ?? error))
      } finally {
        browser.closeOverlay()
        await sleep(120)
      }
    }

    // Give the sidebar something to show: pinned and today tabs, a folder, a favourite, a second space.
    const first = state().tabs.filter((t) => mine.has(t.id)).slice(0, 2)
    for (const tab of first) browser.dispatch({ type: 'tab/pin', id: tab.id })
    browser.dispatch({ type: 'folder/create-with', tabIds: first.map((t) => t.id), name: 'Dossier' })
    browser.dispatch({ type: 'favorite/add', url: `${base}/light`, title: 'Favori clair' })
    browser.dispatch({ type: 'tab/select', id: light })
    await sleep(500)
    await surface('sidebar and toolbar', chrome)

    // ---- the tabs of the sidebar with the keyboard only ----
    const rowsNow = () => evaluate<Array<{ id: string; role: string | null; tabindex: string | null; label: string | null; current: string | null }>>(chrome, `[...document.querySelectorAll('.sidebar .tab > .tab-main')].map((r) => ({ id: r.closest('.tab').dataset.id, role: r.tagName === 'BUTTON' ? 'button' : r.getAttribute('role'), tabindex: r.getAttribute('tabindex'), label: r.getAttribute('aria-label'), current: r.getAttribute('aria-current') }))`)
    const focusedRow = () => evaluate<string | null>(chrome, `document.activeElement?.classList.contains('tab-main') ? document.activeElement.closest('.tab').dataset.id : null`)
    const rows = await rowsNow()
    check('a11y sidebar: every tab row is a button for assistive technology, with its title as its name', rows.length >= 3 && rows.every((r) => r.role === 'button' && !!r.label?.trim()), JSON.stringify(rows))
    check('a11y sidebar: the Tab key stops on one row only, the selected one, which is marked as the current item', rows.filter((r) => r.tabindex === '0').length === 1 && rows.find((r) => r.tabindex === '0')?.current === 'true' && rows.find((r) => r.tabindex === '0')?.id === light, JSON.stringify(rows.map((r) => [r.id.slice(0, 4), r.tabindex, r.current])))
    chrome.focus()
    await evaluate(chrome, `document.querySelector('.sidebar .tab > .tab-main[aria-current]').focus()`)
    const firstFocused = await focusedRow()
    await press(chrome, 'Down')
    const second = await focusedRow()
    check('a11y sidebar: the down arrow moves the focus to the next row', firstFocused === light && second !== null && second !== light, `${firstFocused} -> ${second}`)
    await press(chrome, 'Up')
    check('a11y sidebar: …and the up arrow back', (await focusedRow()) === light)
    await press(chrome, 'Down')
    const target = (await focusedRow())!
    // The row is a real <button> (SidebarRows.tsx): Return activates it through the character the key types, as a real keyboard sends it.
    await pressReturn(chrome)
    check('a11y sidebar: Return on a row selects its tab', await waitFor(() => state().activeTabBySpace[state().activeSpaceId] === target, 3000), `${target} ${state().activeTabBySpace[state().activeSpaceId]}`)
    const before = (await rowsNow()).map((r) => r.id)
    await evaluate(chrome, `document.querySelector('.sidebar .tab[data-id="${bare}"] > .tab-main')?.focus()`)
    await press(chrome, 'Delete')
    check('a11y sidebar: Delete on a Today row archives that tab, and the focus moves to a neighbour row instead of getting lost', (await waitFor(async () => !(await rowsNow()).some((r) => r.id === bare), 3000)) && (await rowsNow()).length === before.length - 1 && (await focusedRow()) !== null, `${await focusedRow()}`)

    // ---- "Increase contrast": the stylesheets follow the system setting (asked for through the media feature) ----
    // The greys of the sidebar are the translucent text colour of the space (`--text-on-space-2`); with the setting they are the text colour itself (sidebar.css,
    // tokens.css: `light-dark()` values). Each token is read as the colour it gives in the sidebar.
    const dimProbe = `(() => { const s = document.querySelector('.shell'); const p = document.createElement('span'); s.appendChild(p); const read = (v) => { p.style.color = 'var(' + v + ')'; return getComputedStyle(p).color }; const out = { dim: read('--sb-dim'), grey: read('--text-on-space-2'), text: read('--text-on-space') }; p.remove(); return out })()`
    const normalDim = await evaluate<{ dim: string; grey: string; text: string }>(chrome, dimProbe)
    const denseDim = await withMedia<{ dim: string; grey: string; text: string }>(chrome, { name: 'prefers-contrast', value: 'more' }, dimProbe)
    const [normalDimColour, denseDimColour, denseTextColour] = [parseColor(normalDim.dim), parseColor(denseDim.dim), parseColor(denseDim.text)]
    check(
      'a11y contrast: with "Increase contrast" the sidebar’s grey is denser (it becomes the text colour itself, opaque), and it is the translucent secondary grey without',
      normalDim.dim === normalDim.grey && !!normalDimColour && normalDimColour.a < 1 && normalDim.dim !== normalDim.text && denseDim.dim === denseDim.text && !!denseDimColour && !!denseTextColour && denseDimColour.a === 1 && JSON.stringify(denseDimColour) === JSON.stringify(denseTextColour),
      `${JSON.stringify(normalDim)} | ${JSON.stringify(denseDim)}`
    )

    const tabId = state().tabs.find((t) => mine.has(t.id))!.id
    const spaceId = state().activeSpaceId
    const favoriteId = state().favorites[0]?.id
    await overlay('command bar', { panel: 'commandbar', mode: 'new', initial: 'a' }, '.palette, .cb-input, input', { before: async () => void (await sleep(600)) })
    // The command bar is a combobox: the result chosen with the arrows is the one the field points at (what a screen reader reads).
    {
      browser.closeOverlay()
      await waitFor(rootEmpty, 3000)
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: 'a' })
      await waitFor(async () => (await evaluate<number>(ui, `document.querySelectorAll('.results li[role="option"]').length`)) > 1, 6000)
      await sleep(400)
      const pointed = () =>
        evaluate<{ role: string | null; expanded: string | null; active: string | null; selectedId: string | null; selectedAria: string | null; list: string | null }>(
          ui,
          `(() => { const i = document.querySelector('.palette-input'); const sel = document.querySelector('.results li.selected'); return { role: i.getAttribute('role'), expanded: i.getAttribute('aria-expanded'), active: i.getAttribute('aria-activedescendant'), selectedId: sel?.id ?? null, selectedAria: sel?.getAttribute('aria-selected') ?? null, list: document.querySelector('.results')?.getAttribute('role') ?? null } })()`
        )
      const first = await pointed()
      check('a11y command bar: the field is a combobox that is open and points at the selected result, in a listbox of options', first.role === 'combobox' && first.expanded === 'true' && first.list === 'listbox' && first.active !== null && first.active === first.selectedId && first.selectedAria === 'true', JSON.stringify(first))
      ui.focus()
      await press(ui, 'Down')
      const second = await pointed()
      check('a11y command bar: the down arrow moves the pointer to the next option', second.active !== null && second.active === second.selectedId && second.active !== first.active, JSON.stringify(second))
      browser.closeOverlay()
      await waitFor(rootEmpty, 3000)
    }
    await overlay('find', { panel: 'find' }, '.fb-input')
    await overlay('find and replace', { panel: 'findreplace' }, 'input')
    await overlay('import', { panel: 'import' }, 'button')
    await overlay('downloads', { panel: 'downloads' }, 'button, .card, div')
    await overlay('archive', { panel: 'archive' }, 'button, div')
    await overlay('history', { panel: 'history' }, 'input, button')
    await overlay('spaces', { panel: 'spaces' }, 'button')
    // « Découvrir Lucium »: written with the panel and not run (AGENTS.md §1); its row of docs/accessibilite.md says so.
    await overlay('discover', { panel: 'discover' }, 'input, button')
    await overlay('site control centre', { panel: 'site' }, '.scc-tile')
    await overlay('space editor', { panel: 'space', spaceId }, 'input, button')
    if (favoriteId) await overlay('favourite', { panel: 'favorite', favoriteId }, 'input')
    await overlay('new space', { panel: 'spacecreate' }, 'input, button')
    await overlay('plus menu', { panel: 'plus', anchor: { x: 283, y: 847, width: 32, height: 32 } }, 'button')
    await overlay('site data', { panel: 'sitedata' }, 'button')
    await overlay('sessions', { panel: 'sessions' }, 'input, button')
    await overlay('read later', { panel: 'readlater' }, 'button, div')
    await overlay('tab editor', { panel: 'tab', tabId }, 'input, button')
    await overlay('automatic reload', { panel: 'autoreload', tabId }, 'input, button')
    await overlay('theme editor', { panel: 'theme', spaceId }, 'button, input')
    await overlay('Tweak editor', { panel: 'boost', host: '127.0.0.1' }, 'button, input')
    await overlay('permission request', { panel: 'permission', request: { id: 'a11y-1', origin: base, permission: 'geolocation' } }, 'button', { escape: false })
    await overlay('sign-in request', { panel: 'auth', request: { id: 'a11y-2', host: '127.0.0.1', realm: 'Zone test', scheme: 'basic', isProxy: false, secure: false } }, 'input, button', { escape: false })

    // The Settings window, page by page: the 11 of the sidebar (shared/ipc.ts, SETTINGS_PAGES), each with the name of its entry.
    for (const [pane, label] of [['home', 'Pour commencer'], ['appearance', 'Apparence'], ['tabs', 'Onglets et fenêtres'], ['navigation', 'Navigation'], ['protection', 'Vie privée'], ['files', 'Téléchargements'], ['tools', 'Extensions et outils'], ['keyboard', 'Clavier et souris'], ['profiles', 'Profils'], ['features', 'Fonctions en option'], ['about', 'À propos']] as const) {
      browser.openOverlay({ panel: 'settings', pane })
      const wc = await settingsWindow()
      check(`a11y audit: Settings opens on its category “${label}”`, await waitFor(() => onCategory(wc, pane, label), 6000))
      await sleep(500)
      await surface(`Settings › ${label}`, wc)
    }

    // ---- a subpage of Settings opens from the keyboard with the focus on its name, and Escape gives the focus back to its row ----
    // The routes of the links (Navigation): their row is at the top of the page, and opens the subpage « Diriger les liens de certains sites vers un espace ».
    browser.openOverlay({ panel: 'settings', pane: 'navigation' })
    const sw2 = await settingsWindow()
    await waitFor(() => onCategory(sw2, 'navigation', 'Navigation'), 6000)
    sw2.focus()
    const entry = `document.querySelector('[data-subpage-entry="linkroutes"] button')`
    check('a11y subpage: (control) the row that opens the routes is shown', await waitFor(() => evaluate<boolean>(sw2, `${entry}?.offsetParent != null`), 4000))
    await evaluate(sw2, `${entry}?.focus()`)
    await press(sw2, 'Space')
    check('a11y subpage: the row opens its subpage from the keyboard, and the focus goes to its name', await waitFor(() => evaluate<boolean>(sw2, `document.activeElement?.id === 'pane-heading' && document.activeElement.textContent === 'Diriger les liens de certains sites vers un espace'`), 3000))
    check('a11y subpage: its way back names the page it leads to', (await evaluate<string>(sw2, `document.querySelector('.subpage-back')?.getAttribute('aria-label') ?? ''`)) === 'Revenir à Navigation')
    await press(sw2, 'Escape')
    check('a11y subpage: Escape leads back to the page, the focus on the row that opened it', await waitFor(() => evaluate<boolean>(sw2, `document.activeElement === ${entry} && document.querySelector('#pane-heading')?.textContent === 'Navigation'`), 3000), await evaluate<string>(sw2, `document.activeElement?.outerHTML.slice(0, 120) ?? ''`))

    // ---- the dialog of Settings keeps the focus inside while it is open, and gives it back ----
    // The dialog that creates a profile (Profils), opened by the button « Ajouter un profil » under the list.
    browser.openOverlay({ panel: 'settings', pane: 'profiles' })
    await waitFor(() => onCategory(sw2, 'profiles', 'Profils'), 6000)
    const openerLabel = 'Ajouter un profil'
    const opener = `document.querySelector('.profile-box-foot button[title=${JSON.stringify(openerLabel)}]')`
    check('a11y dialog: (control) the button that opens the dialog of a new profile is shown', await waitFor(() => evaluate<boolean>(sw2, `${opener}?.offsetParent != null`), 4000))
    await evaluate(sw2, `${opener}?.focus()`)
    await press(sw2, 'Space')
    check('a11y dialog: the Settings dialog opens from the keyboard and takes the focus', await waitFor(() => evaluate<boolean>(sw2, `!!document.activeElement?.closest('.dialog')`), 3000))
    let escaped = 0
    for (let i = 0; i < 8; i++) {
      await press(sw2, 'Tab', i % 2 === 1 ? ['shift'] : [])
      if (!(await evaluate<boolean>(sw2, `!!document.activeElement?.closest('.dialog')`))) escaped++
    }
    check('a11y dialog: …Tab and Shift+Tab stay inside it (focus trap)', escaped === 0, `${escaped} presses left the dialog`)
    await press(sw2, 'Escape')
    check('a11y dialog: Escape closes it and the focus goes back to the button that opened it', (await waitFor(() => evaluate<boolean>(sw2, `!document.querySelector('.dialog')`), 3000)) && (await evaluate<string>(sw2, `document.activeElement?.getAttribute('title') ?? ''`)) === openerLabel, await evaluate<string>(sw2, `document.activeElement?.outerHTML.slice(0, 120) ?? ''`))
    // The secondary text of Settings (`--s-muted`, the token `--text-3` of settings.css, a `light-dark()` value), the main text and the background of the window,
    // as the colours they resolve to in the appearance on screen.
    const mutedProbe = `(() => { const read = (property, value) => { const el = document.createElement('span'); el.style[property] = value; document.body.append(el); const colour = getComputedStyle(el)[property]; el.remove(); return colour }; return { muted: read('color', 'var(--s-muted)'), text: read('color', 'var(--text)'), ground: read('backgroundColor', 'var(--s-bg)') } })()`
    const normalMuted = await evaluate<{ muted: string; text: string; ground: string }>(sw2, mutedProbe)
    const denseMuted = await withMedia<{ muted: string; text: string; ground: string }>(sw2, { name: 'prefers-contrast', value: 'more' }, mutedProbe)
    const ratioOf = (reading: { muted: string; ground: string }) => {
      const [muted, ground] = [parseColor(reading.muted), parseColor(reading.ground)]
      return muted && ground ? contrastRatio(muted, ground) : 0
    }
    // How far the secondary text is from the main text, in red, green and blue.
    const distanceOf = (reading: { muted: string; text: string }) => {
      const [muted, text] = [parseColor(reading.muted), parseColor(reading.text)]
      return muted && text ? Math.hypot(muted.r - text.r, muted.g - text.g, muted.b - text.b) : Number.NaN
    }
    check(
      'a11y contrast: with "Increase contrast" the secondary text of Settings is denser (closer to the main text, 7 : 1 or more), and the normal grey, apart from the main text, still reaches the 4.5 : 1 of WCAG without',
      ratioOf(normalMuted) >= 4.5 && ratioOf(denseMuted) >= 7 && ratioOf(denseMuted) > ratioOf(normalMuted) && distanceOf(normalMuted) > 0 && distanceOf(denseMuted) < distanceOf(normalMuted),
      `${JSON.stringify(normalMuted)} ${ratioOf(normalMuted).toFixed(2)} | ${JSON.stringify(denseMuted)} ${ratioOf(denseMuted).toFixed(2)}`
    )

    // The task manager.
    Menu.getApplicationMenu()?.items.flatMap((i) => i.submenu?.items ?? []).flatMap((i) => (i.submenu ? i.submenu.items : [i])).find((i) => i.label === 'Ouvrir le gestionnaire de tâches')?.click()
    await waitFor(() => ElectronWindow.getAllWindows().some((w) => w.getTitle() === 'Gestionnaire de tâches'), 5000)
    const task = ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Gestionnaire de tâches')
    if (task) {
      await sleep(900)
      await surface('task manager', task.webContents)
      task.close()
    }

    // ---- what the rules say of all of them ----
    dump['reports'] = reports
    const named = (r: SurfaceReport) => r.findings.filter((f) => f.problem === 'unnamed')
    for (const r of reports) {
      check(`a11y: ${r.name}: every control, image and dialog has an accessible name`, named(r).length === 0, JSON.stringify(named(r).map((f) => ({ role: f.role, html: f.html }))))
      check(`a11y: ${r.name}: every switch, checkbox and tab says its state`, r.findings.filter((f) => f.problem === 'missing-state').length === 0, JSON.stringify(r.findings.filter((f) => f.problem === 'missing-state').map((f) => ({ role: f.role, name: f.name, html: f.html }))))
      check(`a11y: ${r.name}: nothing is focusable without a role`, r.findings.filter((f) => f.problem === 'focusable-without-role').length === 0, JSON.stringify(r.findings.filter((f) => f.problem === 'focusable-without-role').map((f) => f.html)))
      check(`a11y: ${r.name}: the page language is French and no tab index is above 0`, r.lang === 'fr' && r.positiveTabindex.length === 0, JSON.stringify({ lang: r.lang, positive: r.positiveTabindex }))
    }
    for (const [name, closed] of Object.entries(dump).filter(([k]) => k.startsWith('escape:'))) check(`a11y: Escape closes the panel “${name.slice(7)}”`, closed === true)

    const sidebar = reports.find((r) => r.name === 'sidebar and toolbar')
    check('a11y: the sidebar can be reached with the Tab key (its tabs, favourites and spaces are stops)', !!sidebar && sidebar.tabStops >= 8, String(sidebar?.tabStops))
    // ---- « Toujours afficher les barres de défilement »: the setting of the system reaches the document of the sidebar, and the list that hides its bar gives it back ----
    // The service is fed a stand-in of the system for the checks (read, then put back); what the real Mac says is read too, for the one check that needs it.
    const realScrollBars = systemPreferences.getUserDefault('AppleShowScrollBars', 'string')
    const scrollBarsOf = () => evaluate<{ attribute: string | null; width: string; gutter: number }>(chrome, `(() => { const list = document.querySelector('.sidebar .scroll'); const filler = document.createElement('div'); filler.style.height = '6000px'; list.append(filler); const gutter = list.offsetWidth - list.clientWidth; filler.remove(); return { attribute: document.documentElement.getAttribute('data-scrollbars'), width: getComputedStyle(list).scrollbarWidth, gutter } })()`)
    systemScrollBars().start({ read: () => 'Always', watch: () => () => undefined })
    check('a11y: scroll bars: the document of the sidebar takes data-scrollbars="always" while the system always shows the bars', await waitFor(async () => (await scrollBarsOf()).attribute === 'always', 4000), JSON.stringify(await scrollBarsOf()))
    const shown = await scrollBarsOf()
    check('a11y: scroll bars: …and the list of the tabs, which hides its bar, asks for the thin one of the system', shown.width === 'thin', JSON.stringify(shown))
    // A bar takes room in the list only when the Mac itself is set to « Toujours afficher les barres de défilement »: otherwise the system draws it over the list, when scrolling.
    if (realScrollBars === 'Always') check('a11y: scroll bars: …and it is there: the list that overflows has a gutter for it', shown.gutter > 0, JSON.stringify(shown))
    systemScrollBars().start({ read: () => 'Automatic', watch: () => () => undefined })
    check('a11y: scroll bars: the attribute goes when the system no longer always shows the bars, and the list hides its bar again', await waitFor(async () => (await scrollBarsOf()).attribute === null, 4000) && (await scrollBarsOf()).width !== 'thin', JSON.stringify(await scrollBarsOf()))
    systemScrollBars().stop()
    const toastCheck = await (async () => {
      browser.showToast('Message de contrôle')
      await sleep(300)
      return evaluate<{ live: boolean; text: string }>(chrome, `(() => { const live = document.querySelector('[role=status][aria-live=polite], [aria-live=polite][role=status]'); return { live: !!live && live.getAttribute('aria-atomic') === 'true', text: live?.textContent ?? '' } })()`)
    })()
    check('a11y: a notice (toast) is announced: its region exists before the message and says it is read whole', toastCheck.live && toastCheck.text.includes('Message de contrôle'), JSON.stringify(toastCheck))
  } finally {
    console.warn = realWarn
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    for (const folder of state().folders.filter((f) => f.name === 'Dossier')) browser.dispatch({ type: 'folder/delete', id: folder.id })
    for (const favorite of state().favorites.filter((f) => f.title === 'Favori clair')) browser.dispatch({ type: 'favorite/remove', id: favorite.id })
    browser.closeOverlay()
    for (const w of ElectronWindow.getAllWindows().filter((x) => x.getTitle() === 'Réglages')) w.close()
    patch({
      readableMode: original.readableMode,
      siteReadableMode: original.siteReadableMode,
      windowVibrancy: original.windowVibrancy,
      sidebarOpacity: original.sidebarOpacity,
      windowBorder: original.windowBorder,
      cardOutline: original.cardOutline,
      sidebarVisible: original.sidebarVisible
    })
    browser.setSystemDark(nativeTheme.shouldUseDarkColors)
    server.close()
    server.closeAllConnections()
    const target = process.env['LUCIUM_A11Y_DUMP']
    if (target) writeFileSync(target, JSON.stringify(dump, null, 2))
  }
}

/** `LUCIUM_SMOKE_ONLY=a11y`: only these checks, with their own report. */
export async function runA11ySmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeA11y(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeA11y ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_A11Y ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
