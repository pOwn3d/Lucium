#!/usr/bin/env node
// Benchmark of the readable mode on public pages (a development tool: not run by the test suite, and it never opens a window).
//
//   node scripts/readable-bench.mjs --out <folder> [--only <name,name>] [--scroll]
//
// For each page of the list it loads the page in headless Chrome (Playwright, `channel: 'chrome'`), in a fresh context with no account, and
// measures three states: the page as it is, the inversion of phase 1 (the way back of the engine) and the recolouring engine. For each one it
// counts the visible texts under the WCAG contrast (4.5 : 1, 3 : 1 for large text) with its own computation (`audit` below: the computed
// styles, the effective background through the ancestors, images unknown), takes a screenshot of the viewport, and for the engine the time
// of its start (stylesheets and the first slice), the time until the first recoloured frame and the main-thread time of its whole work.
// The engine and the probe run in an isolated world made with the DevTools protocol (`Page.createIsolatedWorld`), as Electron's
// `executeJavaScriptInIsolatedWorld` runs them in the application. Nothing is clicked, typed or accepted on the pages: a consent banner that
// hides a page is measured as it is.
//
// axe-core is not a dependency of the project, so its color-contrast rule is not run here (adding it for a development script was not worth
// a dependency); the counts are this script's own.

import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DARK_PROBE_SCRIPT, READABLE_BUDGET, readableEngine, readableKit } from '../src/shared/readable-engine.ts'

const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('@playwright/test')

const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' }, scroll: { type: 'boolean' } } })
if (!values.out) {
  console.error('usage: node scripts/readable-bench.mjs --out <folder> [--only name,name] [--scroll]')
  process.exit(2)
}
const OUT = resolve(values.out)
mkdirSync(OUT, { recursive: true })

/** The pages: light ones for Dark, dark ones for Light (`scheme` is what the context tells the page it prefers). */
const PAGES = [
  { name: 'encyclopedie', url: 'https://en.wikipedia.org/wiki/Lighthouse', mode: 'dark', scheme: 'light' },
  { name: 'encyclopedie-longue', url: 'https://en.wikipedia.org/wiki/World_War_II', mode: 'dark', scheme: 'light' },
  { name: 'actualites', url: 'https://www.bbc.com/news', mode: 'dark', scheme: 'light' },
  { name: 'depot-de-code', url: 'https://github.com/microsoft/vscode', mode: 'dark', scheme: 'light' },
  { name: 'documentation', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/color_value', mode: 'dark', scheme: 'light' },
  // The site answers a first visit with a check page that goes away by itself: it is waited for longer.
  { name: 'questions-reponses', url: 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array', mode: 'dark', scheme: 'light', settle: 9000 },
  { name: 'forum', url: 'https://news.ycombinator.com/', mode: 'dark', scheme: 'light' },
  { name: 'html-simple', url: 'https://info.cern.ch/hypertext/WWW/TheProject.html', mode: 'dark', scheme: 'light' },
  { name: 'application-web', url: 'https://www.openstreetmap.org/', mode: 'dark', scheme: 'light' },
  { name: 'specification-longue', url: 'https://html.spec.whatwg.org/multipage/parsing.html', mode: 'dark', scheme: 'light' },
  { name: 'depot-de-code-sombre', url: 'https://github.com/microsoft/vscode', mode: 'light', scheme: 'dark' },
  { name: 'documentation-sombre', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/color_value', mode: 'light', scheme: 'dark' },
  { name: 'boutique-sombre', url: 'https://store.steampowered.com/app/620/Portal_2/', mode: 'light', scheme: 'light' },
  // A page of this script (served on 127.0.0.1): what a page does after it loaded, measured from the engine's start (see DYNAMIC_PAGE).
  { name: 'dynamique', url: 'local:/dynamic', mode: 'dark', scheme: 'light', dynamic: true }
]

/**
 * A light page that changes after the engine started: a component with an open shadow root and its own sheet, rules a script inserts with
 * `insertRule` (as CSS-in-JS libraries do, without any change of the DOM), elements added with inline colours, a class switched on the body,
 * and a grey text under the contrast on purpose. `window.__changes()` makes the changes; the bench then waits for the engine to be idle.
 */
const DYNAMIC_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dynamic</title><style>
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #fafafa; color: #222 }
header { background: #fff; border-bottom: 1px solid #ddd; padding: 16px 32px }
.card { background: #fff; border: 1px solid #e3e3e3; border-radius: 8px; padding: 16px; margin: 16px 32px; box-shadow: 0 1px 3px rgba(0,0,0,.12) }
.muted { color: #9a9a9a }
body.alt .card { background: #fff8e1; border-color: #ffe08a }
a { color: #0b57d0 }
</style><style id="cssinjs"></style></head><body>
<header><strong>Dynamic page</strong> <a href="#">a link</a></header>
<div class="card"><p>Text in a card.</p><p class="muted">A grey text under the contrast on purpose.</p></div>
<x-badge></x-badge>
<main id="feed"></main>
<script>
customElements.define('x-badge', class extends HTMLElement {
  constructor() { super(); const root = this.attachShadow({ mode: 'open' }); root.innerHTML = '<style>.b { display: inline-block; margin: 0 32px; padding: 4px 10px; border-radius: 12px; background: #e8f0fe; color: #1a3e8a; border: 1px solid #c6dafc }</style><span class="b">In a shadow root</span>' }
})
window.__changes = () => {
  const sheet = document.getElementById('cssinjs').sheet
  sheet.insertRule('.inserted { background: #ffffff; color: #333333; border: 1px solid #cccccc; padding: 12px; margin: 8px 32px }', 0)
  const feed = document.getElementById('feed')
  for (let i = 0; i < 200; i++) {
    const item = document.createElement('div')
    item.className = i % 2 ? 'inserted' : 'card'
    item.innerHTML = i % 3 ? '<p>Item ' + i + ' added later</p>' : '<p style="background:#ffffff;color:#555555;padding:4px">Item ' + i + ' with inline colours</p>'
    feed.appendChild(item)
  }
  document.body.classList.add('alt')
}
</script></body></html>`

/** The inversion of phase 1 (what `invertCss()` of dark-sites.ts gives a page that has a background), the way back of the engine. */
const INVERT_CSS = 'html { filter: invert(1) hue-rotate(180deg) contrast(0.9); }\nimg, video, picture, canvas, svg image { filter: invert(1) hue-rotate(180deg); }'

/**
 * Runs in the page (isolated world): the visible texts and how many are under the WCAG contrast. `invert`: the colours as the inversion filter
 * shows them (invert, hue-rotate 180°, contrast 90 %, computed in sRGB as Chromium applies these filter functions). Self-contained.
 */
function audit(win, kit, invert) {
  const doc = win.document
  const cs = (el) => win.getComputedStyle(el)
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null
  const filter = (c) => {
    if (!invert) return c
    const r = 1 - c.r / 255, g = 1 - c.g / 255, b = 1 - c.b / 255
    const m = [-0.574 * r + 1.43 * g + 0.144 * b, 0.426 * r + 0.43 * g + 0.144 * b, 0.426 * r + 1.43 * g - 0.856 * b]
    const [x, y, z] = m.map((v) => Math.min(1, Math.max(0, (Math.min(1, Math.max(0, v)) - 0.5) * 0.9 + 0.5)) * 255)
    return { r: x, g: y, b: z, a: c.a }
  }
  const declared = (el) => { const c = kit.parse(cs(el).backgroundColor); return c && c.a >= 0.5 ? c : null }
  const canvas = (doc.documentElement && declared(doc.documentElement)) || (doc.body && declared(doc.body)) || (/dark/.test(cs(doc.documentElement).colorScheme) ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 })
  /** What is behind `el`'s text: the opaque colours under it (a gradient gives its stops), null for an image. */
  const behind = (el) => {
    const layers = []
    let fade = 1
    for (let at = el; at; at = parentOf(at)) {
      const s = cs(at)
      const image = s.backgroundImage
      if (image && image !== 'none') {
        if (/url\(|image-set\(/.test(image)) return null
        const stops = [...image.matchAll(/(?:rgba?|color|oklch|oklab|lab|lch|hsla?)\([^()]*\)/g)].map((m) => kit.parse(m[0])).filter(Boolean)
        if (stops.length) {
          const bg = kit.parse(s.backgroundColor)
          return { list: stops.map((c) => { let base = layers.reduceRight((acc, l) => kit.over(l, acc), kit.over(bg && bg.a > 0 ? bg : { r: 0, g: 0, b: 0, a: 0 }, canvas)); return kit.over(c, base) }), fade }
        }
      }
      const c = kit.parse(s.backgroundColor)
      if (c && c.a > 0) {
        if (c.a >= 0.99) {
          let base = c
          for (let i = layers.length - 1; i >= 0; i--) base = kit.over(layers[i], base)
          return { list: [base], fade }
        }
        layers.unshift(c)
      }
      if (layers.length === 0 && (!c || c.a < 0.99)) fade *= parseFloat(s.opacity)
    }
    let base = canvas
    for (let i = layers.length - 1; i >= 0; i--) base = kit.over(layers[i], base)
    return { list: [base], fade }
  }
  const out = { texts: 0, fails: 0, unknown: 0, samples: [] }
  const visit = (root) => {
    const walker = doc.createTreeWalker(root, 1)
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (el.shadowRoot) visit(el.shadowRoot)
      if (el.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE|HEAD)$/.test(el.tagName)) continue
      let text = false
      for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.data)) { text = true; break }
      if (!text) continue
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      const box = el.getBoundingClientRect()
      if (box.width < 2 || box.height < 2) continue
      const s = cs(el)
      const fg = kit.parse(s.color)
      if (!fg || fg.a === 0) continue
      out.texts++
      const under = behind(el)
      if (!under) { out.unknown++; continue }
      const size = parseFloat(s.fontSize)
      const target = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700) ? 3 : 4.5
      const ratio = Math.min(...under.list.map((b) => kit.contrastOver(filter(fg), filter(b), fg.a * under.fade)))
      if (ratio < target - 0.005) {
        out.fails++
        if (out.samples.length < 6) out.samples.push(`${el.tagName.toLowerCase()} ${ratio.toFixed(2)} ${kit.format(fg)} on ${kit.format(under.list[0])}: ${(el.textContent || '').trim().slice(0, 40)}`)
      }
    }
  }
  if (doc.body) visit(doc.body)
  return out
}

const call = (fn, ...args) => `(${fn.toString()})(window, (${readableKit.toString()})(), ${args.map((a) => JSON.stringify(a)).join(', ')})`

async function isolatedWorld(page) {
  const cdp = await page.context().newCDPSession(page)
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'readable-bench' })
  return async (expression) => {
    const answer = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result.value
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function shoot(page, file) {
  await page.screenshot({ path: join(OUT, `${file}.png`) })
  if (values.scroll) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.4))
    await sleep(300)
    await page.screenshot({ path: join(OUT, `${file}-bas.png`) })
    await page.evaluate(() => window.scrollTo(0, 0))
    await sleep(200)
  }
}

async function measure(browser, spec, local) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: spec.scheme, locale: 'en-GB', userAgent })
  const page = await context.newPage()
  const row = { name: spec.name, url: spec.url, mode: spec.mode }
  try {
    await page.goto(spec.url.replace('local:', local), { waitUntil: 'load', timeout: 45_000 }).catch(async (error) => {
      // A page whose `load` never comes (a request that hangs) is measured as far as it got.
      console.warn(`${spec.name}: no load event (${error instanceof Error ? error.message.split('\n')[0] : error}), measured as it is`)
      await page.waitForLoadState('domcontentloaded')
    })
    await sleep(spec.settle ?? 2500)
    const run = await isolatedWorld(page)
    row.elements = await page.evaluate(() => document.getElementsByTagName('*').length)
    const look = await run(DARK_PROBE_SCRIPT)
    const sorted = [...look.samples].sort((a, b) => a - b)
    row.verdict = sorted[Math.floor(sorted.length / 2)] < 0.18 ? 'dark' : 'light'
    row.before = await run(call(audit, false))
    await shoot(page, `${spec.name}-1-avant`)
    // The inversion, as the shell would give it (an author sheet; images, videos and canvases turned back).
    await run(`(() => { const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(INVERT_CSS)}); window.__benchInvert = s; document.adoptedStyleSheets = [...document.adoptedStyleSheets, s] })()`)
    await sleep(300)
    row.invert = await run(call(audit, true))
    await shoot(page, `${spec.name}-2-inversion`)
    await run(`document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== window.__benchInvert)`)
    await sleep(200)
    const config = { scheme: spec.mode, fallbackCss: INVERT_CSS, budget: READABLE_BUDGET }
    row.start = await run(`(async () => { const t0 = performance.now(); const r = ${call(readableEngine, 'start', config)}; await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); return { ...r, paintMs: performance.now() - t0 } })()`)
    const t0 = Date.now()
    let stats = null
    while (Date.now() - t0 < 20_000) {
      stats = await run(call(readableEngine, 'stats', null))
      if (!stats || stats.pending === 0) break
      await sleep(200)
    }
    row.idleMs = Date.now() - t0
    if (spec.dynamic) {
      // The page changes now: the time until the engine has read every change, and what it costs.
      const before = stats
      const t1 = Date.now()
      await page.evaluate(() => window.__changes())
      await sleep(50)
      while (Date.now() - t1 < 20_000) {
        stats = await run(call(readableEngine, 'stats', null))
        if (!stats || stats.pending === 0) break
        await sleep(50)
      }
      row.dynamic = { settledMs: Date.now() - t1, busyMs: stats && before ? stats.busyMs - before.busyMs : null, sheetsMs: stats && before ? stats.sheetsMs - before.sheetsMs : null }
      await sleep(300)
    }
    row.stats = stats
    await sleep(400)
    row.engine = await run(call(audit, false))
    await shoot(page, `${spec.name}-3-moteur`)
  } catch (error) {
    row.error = error instanceof Error ? error.message.split('\n')[0] : String(error)
  } finally {
    await context.close()
  }
  return row
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
// The user agent of the browser, without the word that makes some sites answer a headless one with another page.
const userAgent = await browser.newPage().then(async (p) => {
  const ua = await p.evaluate(() => navigator.userAgent)
  await p.close()
  return ua.replace('HeadlessChrome', 'Chrome')
})
const only = values.only ? new Set(values.only.split(',')) : null
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(request.url === '/dynamic' ? DYNAMIC_PAGE : '<!doctype html><title>none</title>')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const local = `http://127.0.0.1:${server.address().port}`
const rows = []
for (const spec of PAGES) {
  if (only && !only.has(spec.name)) continue
  const row = await measure(browser, spec, local)
  rows.push(row)
  const f = (a) => (a ? `${a.fails}/${a.texts}${a.unknown ? ` (?${a.unknown})` : ''}` : '-')
  console.log(`${spec.name.padEnd(24)} ${spec.mode.padEnd(5)} ${String(row.verdict ?? '').padEnd(5)} el ${String(row.elements ?? '').padStart(6)}  avant ${f(row.before).padEnd(16)} inversion ${f(row.invert).padEnd(16)} moteur ${f(row.engine).padEnd(16)} début ${row.start?.startMs?.toFixed(1) ?? '-'} ms, 1re image ${row.start?.paintMs?.toFixed(1) ?? '-'} ms, travail total ${row.stats?.busyMs?.toFixed(0) ?? '-'} ms${row.dynamic ? `, changements lus en ${row.dynamic.settledMs} ms (${row.dynamic.busyMs?.toFixed(0)} ms de travail)` : ''}${row.start && !row.start.ok ? ` ÉCHEC ${row.start.reason}` : ''}${row.error ? ` ERREUR ${row.error}` : ''}`)
}
await browser.close()
server.close()
writeFileSync(join(OUT, 'resultats.json'), JSON.stringify(rows, null, 2))
console.log(`\n${join(OUT, 'resultats.json')}`)
