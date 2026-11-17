// Engine checks for the Markdown export, run inside a real Electron. A local server hands out a page with headings, lists, links, images,
// code, a quote, a table, a block to leave out and hidden things; a hostile page that poisons the page's own JavaScript, plants scripts
// and handlers and fires events of its own; and image addresses that answer badly. The picker is driven the way a user drives it: real
// mouse moves and clicks on the blocks, real keys for the bar (the bar is in a closed shadow root, so the keyboard reaches its buttons).
// Run alone with `LUCIUM_SMOKE_ONLY=markdown`. The clipboard is put back as it was found; the files go to a throw-away folder.

import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clipboard, Menu, session, webContents as allWebContents, type MenuItem, type WebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { MARKDOWN_WORLD } from './engine/markdown-picker'
import { setMarkdownUi, type MarkdownUi } from './shell/markdown-export'
import { getWindowManager } from './shell/windows'
import { closeLeftoverPanels, noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 60)

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Cours Markdown</title></head>
<body style="font:16px sans-serif;margin:0">
<nav id="nav" style="padding:8px"><a href="/other" id="navlink">Accueil</a> <a href="/about">À propos</a></nav>
<main>
<h1>Guide du Markdown</h1>
<p id="intro">Premier paragraphe avec du <b id="bold">gras</b>, de l’<i>italique</i> et un <a id="link" href="/doc?a=1&amp;b=2">lien utile</a>.</p>
<h2>Listes</h2>
<ul id="list"><li>un<ul><li>un-un</li></ul></li><li>deux</li></ul>
<ol start="3"><li>trois</li><li>quatre</li></ol>
<p><img id="cat" src="/img/cat.png" alt="Un chat" width="40" height="40"> <img id="gone" src="/img/gone.png" alt="Disparu" width="40" height="40"></p>
<pre id="code"><code class="language-js">const a = 1
if (a) {
  console.log(a)
}</code></pre>
<blockquote id="quote"><p>Une citation.</p></blockquote>
<table id="table"><thead><tr><th>Nom</th><th>Valeur</th></tr></thead><tbody><tr><td>x</td><td>1</td></tr></tbody></table>
<p><input id="field" value="champ"></p>
<p id="hidden" style="display:none">CACHE-DISPLAY</p>
<p aria-hidden="true">CACHE-ARIA</p>
</main>
<aside id="ad" style="padding:20px;background:#fee">PUBLICITE à exclure</aside>
<iframe src="about:blank" style="width:10px;height:10px"></iframe>
<button>BOUTON</button>
<script>window.clicks = 0; document.getElementById('link').addEventListener('click', () => { window.clicks++ })</script>
</body></html>`

const HOSTILE = `<!doctype html><html><head><meta charset="utf-8"><title>Piège</title>
<script>
// The page poisons its own world, as hard as it can.
window.__ran = 1
JSON.stringify = () => '{"pwned":1}'
Array.prototype.push = function () { window.__pushed = 1; return 0 }
Array.from = () => []
Element.prototype.getAttribute = () => 'javascript:void(0)'
Element.prototype.getBoundingClientRect = () => { throw new Error('pwned') }
window.getComputedStyle = () => ({ display: 'none' })
document.createElement = () => { throw new Error('pwned') }
</script>
<style>p::before{content:'CONTENU-CSS'}</style></head>
<body><p id="target">Texte visible du piège</p>
<script>window.__ran2 = 'SCRIPT-BODY-MARKER'</script>
<img src="/img/gone.png" onerror="window.__onerror = 'ONERROR-MARKER'">
<a href="javascript:void(0)" onclick="window.__clicked = 1">piège <b>gras</b></a>
<p>[clic](javascript:void(0)) et &lt;script&gt;texte-balise&lt;/script&gt;</p>
<template><p>TEMPLATE-MARKER</p></template><noscript>NOSCRIPT-MARKER</noscript>
<script>
// Events of its own while the picker is up: none of them is a person.
setInterval(() => {
  const target = document.getElementById('target')
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
  window.__forged = (window.__forged || 0) + 1
}, 40)
</script></body></html>`

const STRICT = `<!doctype html><title>Strict</title><body><p>Page à la politique stricte</p></body>`

/** `count` nested divs around some text, and many paragraphs: the walk must stop where the limits say, not hang or crash. */
const DEEP = `<!doctype html><title>Profonde</title><body>${'<div>'.repeat(150)}fond de la page${'</div>'.repeat(150)}<p>Haut de page</p></body>`

export async function smokeMarkdown(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store } = ctx
  const savedClipboard = await clipboard.readText()
  const folder = mkdtempSync(join(tmpdir(), 'lucium-markdown-'))
  const toastNow = () => browser.snapshot().toast?.message ?? ''

  // ---- the world around ----
  const imageRequests: Array<{ path: string; cookie: string; referer: string }> = []
  const note = (req: IncomingMessage) => imageRequests.push({ path: req.url ?? '', cookie: String(req.headers['cookie'] ?? ''), referer: String(req.headers['referer'] ?? '') })
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    if (path.startsWith('/img/')) note(req)
    if (path === '/page' || path === '/images') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      return void res.end(path === '/images' ? PAGE.replace('<title>Cours Markdown</title>', '<title>Images</title>').replace('<pre id="code">', '<p><img src="/img/fake.png" alt="Faux"><img src="/img/big.png" alt="Gros"><img src="/img/redir.png" alt="Redirigé"></p><pre id="code">') : PAGE)
    }
    if (path === '/hostile') return void res.setHeader('content-type', 'text/html; charset=utf-8').end(HOSTILE)
    if (path === '/strict') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'none'; script-src 'none'; require-trusted-types-for 'script'")
      return void res.end(STRICT)
    }
    if (path === '/deep') return void res.setHeader('content-type', 'text/html; charset=utf-8').end(DEEP)
    if (path === '/img/cat.png') return void res.setHeader('content-type', 'image/png').end(PNG)
    if (path === '/img/fake.png') return void res.setHeader('content-type', 'text/html').end('<script>alert(1)</script>')
    if (path === '/img/big.png') return void res.setHeader('content-type', 'image/png').end(Buffer.alloc(10 * 1024 * 1024 + 1, 1))
    if (path === '/img/redir.png') {
      res.statusCode = 302
      res.setHeader('location', 'file:///etc/hosts')
      return void res.end()
    }
    if (path === '/favicon.ico') return void res.writeHead(404).end()
    res.statusCode = path === '/img/gone.png' ? 404 : 200
    res.setHeader('content-type', 'text/html')
    res.end(`<title>other ${path}</title><body>other</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The dialogs answer for the user: what was asked is recorded, the answers are set by each check.
  const asked: string[] = []
  let answer: { images: 'zip' | 'md' | null; path: string | null } = { images: null, path: null }
  const fakeUi: MarkdownUi = {
    askImages: async (_win, count) => (asked.push(`images:${count}`), answer.images),
    chooseSave: async (_win, name, extension) => (asked.push(`save:${name}:${extension}`), answer.path),
    fail: (title, message) => asked.push(`fail:${title}:${message}`),
    reveal: () => undefined
  }
  const restoreUi = setMarkdownUi(fakeUi)

  const previousSpace = store.get().activeSpaceId
  browser.dispatch({ type: 'space/create', name: 'Markdown', emoji: '📝', hue: 200 })
  const spaceId = store.get().activeSpaceId
  const sleepAfter = store.get().settings.sleepAfterMinutes
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  const wcOf = (url: string) => allWebContents.getAllWebContents().find((w) => w.getURL() === url && !w.isDestroyed())
  const openTab = async (url: string, into = browser, space = spaceId): Promise<WebContents> => {
    into.dispatch({ type: 'tab/open', url, spaceId: space })
    await waitFor(() => wcOf(url) !== undefined && !wcOf(url)!.isLoading(), 10_000)
    const wc = wcOf(url)!
    await sleep(250)
    return wc
  }
  const inPage = <T>(wc: WebContents, script: string) => wc.executeJavaScript(script) as Promise<T>
  const inWorld = <T>(wc: WebContents, code: string) => wc.executeJavaScriptInIsolatedWorld(MARKDOWN_WORLD, [{ code }]) as Promise<T>
  const picking = (wc: WebContents) => inWorld<boolean>(wc, `typeof window.__luciumMarkdownStop === 'function'`).catch(() => false)
  const rectOf = (wc: WebContents, selector: string) =>
    inPage<{ x: number; y: number; w: number; h: number }>(wc, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const move = async (wc: WebContents, x: number, y: number) => {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    await sleep(120)
  }
  const click = async (wc: WebContents, x: number, y: number) => {
    await move(wc, x, y)
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(160)
  }
  /** A click in the middle of a part of the page (`at` is a point of its box, from 0 to 1 each way). */
  const clickOn = async (wc: WebContents, selector: string, at: [number, number] = [0.5, 0.5]) => {
    const r = await rectOf(wc, selector)
    await click(wc, r.x + r.w * at[0], r.y + r.h * at[1])
  }
  // Where the keyboard focus is: in the bar of the picker (the host of its closed shadow root is the page's active element), or on a page element.
  const focusTrace: string[] = []
  const focusInfo = async (wc: WebContents) => {
    const inBar = await inWorld<boolean>(wc, `(() => { const a = document.activeElement; return !!a && a === document.documentElement.lastElementChild && a.style.zIndex === '2147483647' })()`).catch(() => false)
    return inBar ? 'bar' : await inPage<string>(wc, `(() => { const a = document.activeElement; return a ? a.tagName + (a.id ? '#' + a.id : '') : 'none' })()`).catch(() => '?')
  }
  const key = async (wc: WebContents, keyCode: string, modifiers: Array<'shift'> = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Enter' || keyCode === 'Space') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(100)
    if (keyCode === 'Tab' || keyCode === 'Enter') focusTrace.push(`${modifiers.length ? 'shift+' : ''}${keyCode}->${await focusInfo(wc)}`)
  }
  // The bar is in a closed shadow root: its buttons are reached with the keyboard, which is the bar's from the moment the picker opens.
  // Counting Tab presses from the first button: in the blocks mode the order is Page entière, Sélection vide, Copier, Enregistrer…, Annuler
  // (a disabled button is skipped); with a selection it is Copier, Enregistrer…, Choisir des blocs, Annuler.
  const BLOCKS = { all: 0, none: 1, copy: 2, save: 3, cancel: 4 } as const
  const SELECTION = { copy: 0, save: 1, blocks: 2, cancel: 3 } as const
  const pressBarButton = async (wc: WebContents, tabs: number) => {
    for (let i = 0; i < tabs; i++) await key(wc, 'Tab')
    await key(wc, 'Enter')
  }

  /**
   * An export started directly ends when the person answers the picker. One that never ends (keys that never reach the page) must not hold the suite
   * past its own limit, as the menu path never does: after a minute, the steps go on and the checks after it say what is missing. A suite held there
   * ran its cleanup a quarter of an hour later, in the middle of another suite, and took that suite's space away (the run of 12 November).
   */
  const withinLimit = (exported: Promise<void>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn('[smoke markdown] an export did not end within 60 s: the checks go on without it')
        resolve()
      }, 60_000)
      exported.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  /** Starts an export (through the menu entry, or directly) and returns once the picker is up, with what resolves when it is over. */
  const start = async (wc: WebContents, via: 'menu' | 'api' = 'api') => {
    let finished: Promise<unknown>
    if (via === 'menu') fileMenuItem()!.click({} as never, undefined, undefined)
    else finished = withinLimit(browser.exportMarkdown())
    const up = await waitFor(() => picking(wc), 5000)
    await sleep(120)
    // Through the menu there is no promise to wait for: the picker going away, and the clipboard filling, are the end.
    if (via === 'menu') finished = waitFor(async () => !(await picking(wc)), 60_000).then(() => sleep(400))
    return { up, finished: finished! }
  }
  const fileMenuItem = (): MenuItem | undefined =>
    Menu.getApplicationMenu()
      ?.items.find((m) => m.label === 'Fichier')
      ?.submenu?.items.find((m) => m.label === 'Exporter la page en Markdown…')
  const reset = async () => {
    await clipboard.writeText('')
    asked.length = 0
    answer = { images: null, path: null }
  }
  // Electron 45's clipboard is asynchronous, reads included.
  const copied = () => clipboard.readText()
  // LUCIUM_MARKDOWN_SHOTS=<dir> keeps a picture of the picker over the test page (the page's own pixels: nothing of the user's).
  const shoot = async (wc: WebContents, name: string) => {
    const dir = process.env['LUCIUM_MARKDOWN_SHOTS']
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.png`), (await wc.capturePage()).toPNG())
  }

  try {
    // ---------------------------------------------------------------- the entries
    const web = await openTab(`${base}/page`)
    const tabId = store.get().tabs.find((t) => t.url === `${base}/page`)!.id
    const entry = fileMenuItem()
    check('markdown: File › "Exporter la page en Markdown…" exists, enabled on a web page, without a shortcut of its own', !!entry && entry.enabled && !entry.accelerator, `${entry?.enabled} ${entry?.accelerator}`)

    // ---------------------------------------------------------------- the text selection
    await reset()
    await inPage(web, `getSelection().selectAllChildren(document.getElementById('intro'))`)
    await browser.copySelectionAsMarkdown(tabId)
    check('markdown: a selected paragraph is copied as Markdown, without title or address', (await copied()) === `Premier paragraphe avec du **gras**, de l’*italique* et un [lien utile](${base}/doc?a=1&b=2).\n`, JSON.stringify((await copied())))
    check('markdown: the copy says so', toastNow() === 'Markdown copié', toastNow())

    await reset()
    await inPage(web, `getSelection().selectAllChildren(document.getElementById('code'))`)
    await browser.copySelectionAsMarkdown(tabId)
    check('markdown: a selection inside code stays code, with its language', (await copied()) === '```js\nconst a = 1\nif (a) {\n  console.log(a)\n}\n```\n', JSON.stringify((await copied())))

    await reset()
    await inPage(web, `(() => { const r = document.createRange(); r.setStart(document.querySelector('#list > li'), 0); r.setEnd(document.querySelector('ol li:last-child'), 1); getSelection().removeAllRanges(); getSelection().addRange(r) })()`)
    await browser.copySelectionAsMarkdown(tabId)
    check('markdown: a selection across list items keeps both lists', (await copied()) === '- un\n  - un-un\n- deux\n\n3. trois\n4. quatre\n', JSON.stringify((await copied())))

    await reset()
    await inPage(web, `(() => { const text = document.querySelector('#intro').firstChild; const r = document.createRange(); r.setStart(text, 8); r.setEnd(text, 18); getSelection().removeAllRanges(); getSelection().addRange(r) })()`)
    await browser.copySelectionAsMarkdown(tabId)
    check('markdown: a few words selected inside a paragraph stay a few words', (await copied()) === 'paragraphe\n', JSON.stringify((await copied())))

    await reset()
    await inPage(web, `getSelection().removeAllRanges()`)
    await browser.copySelectionAsMarkdown(tabId)
    check('markdown: with nothing selected, nothing is copied and the user is told', (await copied()) === '' && toastNow() === 'Aucun texte sélectionné à copier', `${JSON.stringify((await copied()))} / ${toastNow()}`)

    // The page menu offers the entry on a selection only.
    const popups: string[][] = []
    const realPopup = Menu.prototype.popup
    let lastMenu: Menu | null = null
    Menu.prototype.popup = function (this: Menu) {
      lastMenu = this
      popups.push(this.items.map((i) => i.label))
      return this
    } as never
    try {
      const params = (selectionText: string, extra: object = {}) => ({ linkURL: '', mediaType: 'none', srcURL: '', isEditable: false, selectionText, x: 5, y: 5, misspelledWord: '', dictionarySuggestions: [], ...extra })
      web.emit('context-menu', {}, params('un mot'))
      const withSelection = popups.at(-1) ?? []
      web.emit('context-menu', {}, params(''))
      const withoutSelection = popups.at(-1) ?? []
      web.emit('context-menu', {}, params('un mot', { isEditable: true }))
      const inField = popups.at(-1) ?? []
      check('markdown: the page menu offers "Copier en Markdown" on a selection, right after "Copier"', withSelection.indexOf('Copier en Markdown') !== -1 && withSelection.indexOf('Copier en Markdown') === withSelection.indexOf('Copier') + 1, withSelection.join(' | '))
      check('markdown: ...and not without a selection, nor in a text field', !withoutSelection.includes('Copier en Markdown') && !inField.includes('Copier en Markdown'), `${withoutSelection.join(' | ')} / ${inField.join(' | ')}`)
      await reset()
      await inPage(web, `getSelection().selectAllChildren(document.getElementById('quote'))`)
      web.emit('context-menu', {}, params('Une citation.'))
      lastMenu!.items.find((i) => i.label === 'Copier en Markdown')!.click({} as never, undefined, undefined)
      check('markdown: choosing it puts the selection on the clipboard', await waitFor(async () => (await (await copied())) === 'Une citation.\n', 5000), JSON.stringify((await copied())))
    } finally {
      Menu.prototype.popup = realPopup
    }

    // ---------------------------------------------------------------- the picker, with real clicks
    await reset()
    await inPage(web, `getSelection().removeAllRanges()`)
    const htmlBefore = await inPage<string>(web, `document.documentElement.outerHTML`)
    imageRequests.length = 0 // the page loaded its own images; from here on, only what the export asks for counts
    await inPage(web, `document.getElementById('field').focus()`)
    const run = await start(web, 'menu')
    check('markdown: the menu entry shows the picker over the page', run.up)
    check('markdown: the page cannot reach it: no variable, no open shadow root', await inPage<boolean>(web, `typeof window.__luciumMarkdownStop === 'undefined' && !document.documentElement.lastElementChild.shadowRoot`))

    // A click on a link is for the picker, not for the page. An inline element stands for the block it is in: this one is the paragraph.
    const addressBefore = web.getURL()
    await clickOn(web, '#link')
    check('markdown: a click on a link while picking does not follow it and does not reach the page', web.getURL() === addressBefore && (await inPage<number>(web, 'window.clicks')) === 0, `${web.getURL()} ${await inPage<number>(web, 'window.clicks')}`)
    await clickOn(web, '#link') // ...and a second click brings the paragraph back
    await clickOn(web, '#ad')
    await clickOn(web, '#nav', [0.9, 0.5])
    const lastItem = await rectOf(web, '#list > li:last-child')
    await move(web, lastItem.x + 8, lastItem.y + lastItem.h / 2)
    await key(web, 'Up') // from the item to its list (Electron names the arrow keys Up, Down, Left and Right)
    // The pointer has not moved: a click here is a click on the list (a move first would aim again at the item).
    web.sendInputEvent({ type: 'mouseDown', x: Math.round(lastItem.x + 8), y: Math.round(lastItem.y + lastItem.h / 2), button: 'left', clickCount: 1 })
    web.sendInputEvent({ type: 'mouseUp', x: Math.round(lastItem.x + 8), y: Math.round(lastItem.y + lastItem.h / 2), button: 'left', clickCount: 1 })
    await sleep(160)
    await shoot(web, 'picker-blocks')
    await pressBarButton(web, BLOCKS.copy)
    await run.finished
    const text = (await copied())
    check('markdown: the keyboard is the bar’s from the start (Tab walks its buttons), and goes back to where it was in the page when it closes', focusTrace.slice(0, 3).join(' ') === 'Tab->bar Tab->bar Enter->INPUT#field', focusTrace.join(' '))
    // The page has a level-1 heading of its own: the title of the tab is not put in front of it.
    check('markdown: the copy starts with the heading of the page (not the title again) and ends with its address', text.startsWith('# Guide du Markdown\n\n') && text.includes(frenchSpaces(`\n\nSource : <${base}/page>\n`)), JSON.stringify(text.slice(0, 80)))
    check('markdown: the headings, the bold, the italic and the link of the page are there', text.includes('# Guide du Markdown') && text.includes('**gras**') && text.includes('*italique*') && text.includes(`[lien utile](${base}/doc?a=1&b=2)`), JSON.stringify(text))
    check('markdown: the numbered list keeps its start, the code its language and indentation, the quote its marker, the table its rows', text.includes('3. trois\n4. quatre') && text.includes('```js\nconst a = 1\nif (a) {\n  console.log(a)\n}\n```') && text.includes('> Une citation.') && text.includes('| Nom | Valeur |\n| --- | --- |\n| x | 1 |'), JSON.stringify(text))
    check('markdown: the blocks clicked away are gone: the ad, the navigation, the whole list reached with the arrow key', !text.includes('PUBLICITE') && !text.includes('Accueil') && !text.includes('deux') && !text.includes('un-un'), JSON.stringify(text))
    check('markdown: hidden text, the iframe and the button are not exported', !text.includes('CACHE-DISPLAY') && !text.includes('CACHE-ARIA') && !text.includes('BOUTON'), JSON.stringify(text))
    check('markdown: the images are references listed after the address', text.includes('![Un chat][image-1]') && text.includes('![Disparu][image-2]') && text.includes(`[image-1]: ${base}/img/cat.png\n[image-2]: ${base}/img/gone.png\n`), JSON.stringify(text))
    check('markdown: an iframe the user kept is reported as not converted', toastNow().startsWith('Markdown copié') && toastNow().includes('iframe'), toastNow())
    check('markdown: the page is back exactly as it was (no style, no node left behind)', (await inPage<string>(web, `document.documentElement.outerHTML`)) === htmlBefore)
    check('markdown: the picker is gone', !(await picking(web)))
    check('markdown: a copy asks the network for nothing: the images stay links', imageRequests.length === 0, JSON.stringify(imageRequests))

    // Escape leaves, and nothing is copied.
    await reset()
    const leaving = await start(web)
    await key(web, 'Escape')
    await leaving.finished
    check('markdown: Escape leaves the picker, copies nothing, says nothing', !(await picking(web)) && (await copied()) === '' && asked.length === 0)

    // Asking again while the picker is up ends it.
    await reset()
    const again = await start(web)
    await browser.exportMarkdown()
    await again.finished
    check('markdown: asking again while picking ends the picker', !(await picking(web)) && (await copied()) === '')

    // Starting from nothing: keep one paragraph only.
    await reset()
    const fromNothing = await start(web)
    await pressBarButton(web, BLOCKS.none)
    await clickOn(web, '#intro', [0.1, 0.5])
    await key(web, 'Tab') // from "Sélection vide" to Copier, which was disabled until a block was kept
    await key(web, 'Enter')
    await fromNothing.finished
    check('markdown: from an empty selection, only the block clicked is exported', (await copied()).includes('Premier paragraphe') && !(await copied()).includes('Guide du Markdown') && !(await copied()).includes('PUBLICITE') && !(await copied()).includes('Accueil'), JSON.stringify((await copied())))

    // The selection is the starting point when there is one.
    await reset()
    await inPage(web, `getSelection().selectAllChildren(document.getElementById('quote'))`)
    const fromSelection = await start(web)
    await shoot(web, 'picker-selection')
    await pressBarButton(web, SELECTION.copy)
    await fromSelection.finished
    check('markdown: with a selection, the bar exports the selection as it is', (await copied()) === 'Une citation.\n', JSON.stringify((await copied())))

    // ---------------------------------------------------------------- saving
    await reset()
    await inPage(web, `getSelection().removeAllRanges()`)
    const toFile = join(folder, 'page.md')
    answer = { images: 'md', path: toFile }
    const saving = await start(web)
    await pressBarButton(web, BLOCKS.save)
    await saving.finished
    const saved = existsSync(toFile) ? readFileSync(toFile, 'utf8') : ''
    check('markdown: "Enregistrer…" asks about the images (there are two), then where, and writes the .md', asked.join(',') === 'images:2,save:Cours Markdown.md:md' && saved.includes('# Guide du Markdown') && saved.includes('Accueil') && saved.includes(`[image-1]: ${base}/img/cat.png`), `${asked.join(',')} ${saved.length}`)
    check('markdown: the file is the text a copy gives', saved.includes('# Guide du Markdown') && saved.endsWith(`[image-2]: ${base}/img/gone.png\n`))

    await reset()
    const gaveUp = await start(web)
    answer = { images: null, path: join(folder, 'never.md') }
    await pressBarButton(web, BLOCKS.save)
    await gaveUp.finished
    check('markdown: giving up at the question about the images writes nothing', !existsSync(join(folder, 'never.md')) && asked.join(',') === 'images:2', asked.join(','))

    // ---------------------------------------------------------------- the archive with the images
    const images = await openTab(`${base}/images`)
    await images.session.cookies.set({ url: base, name: 'sid', value: 'main-profile' })
    await reset()
    imageRequests.length = 0
    const zipPath = join(folder, 'images.zip')
    answer = { images: 'zip', path: zipPath }
    const archiving = await start(images)
    await pressBarButton(images, BLOCKS.save)
    await archiving.finished
    const zipOk = existsSync(zipPath)
    let listing = ''
    let pageMd = ''
    let bilan = ''
    try {
      listing = execFileSync('unzip', ['-t', zipPath]).toString()
      pageMd = execFileSync('unzip', ['-p', zipPath, 'page.md']).toString()
      bilan = execFileSync('unzip', ['-p', zipPath, 'bilan.txt']).toString()
    } catch (error) {
      listing = String((error as Error).message)
    }
    check('markdown: the archive is a valid ZIP (unzip -t) holding page.md, the image and the report', zipOk && /No errors detected/.test(listing) && listing.includes('page.md') && listing.includes('images/image-001.png') && listing.includes('bilan.txt'), listing.slice(0, 300))
    check('markdown: the image that came is a local file in the archive, the others stay links', pageMd.includes('[image-1]: images/image-001.png') && pageMd.includes(`[image-2]: ${base}/img/gone.png`) && pageMd.includes(`${base}/img/fake.png`), pageMd.slice(-400))
    check('markdown: the report says why the other images stayed links (404, not an image, too big, redirected away)', bilan.includes(frenchSpaces('gone.png : HTTP 404')) && bilan.includes(frenchSpaces('fake.png : la réponse n’est pas une image prise en charge')) && bilan.includes(frenchSpaces('big.png : image trop volumineuse')) && bilan.includes('redir.png'), bilan)
    check('markdown: the images were asked for with the cookies of the tab’s profile and the page as referrer', imageRequests.some((r) => r.path === '/img/cat.png' && r.cookie.includes('sid=main-profile') && r.referer === `${base}/images`), JSON.stringify(imageRequests.find((r) => r.path === '/img/cat.png')))
    check('markdown: only the addresses the page lists were requested', imageRequests.length > 0 && imageRequests.every((r) => ['/img/cat.png', '/img/gone.png', '/img/fake.png', '/img/big.png', '/img/redir.png'].includes(r.path)), JSON.stringify(imageRequests.map((r) => r.path)))
    check('markdown: the save says how many images it kept', toastNow().startsWith(frenchSpaces('Enregistré : images.zip · 1/5 images')), toastNow())

    // A private window: the same export, the images with its own session (no cookie of the main profile).
    const manager = getWindowManager()
    const opened = manager.openPrivate()
    const privateTab = await openTab(`${base}/images?private=1`, opened.browser, opened.store.get().spaces[0]!.id)
    check('markdown: the private page is in another session than the main one', privateTab.session !== images.session)
    await reset()
    imageRequests.length = 0
    const privateZip = join(folder, 'private.zip')
    answer = { images: 'zip', path: privateZip }
    const privateRun = opened.browser.exportMarkdown()
    await waitFor(() => picking(privateTab), 5000)
    await sleep(120)
    await pressBarButton(privateTab, BLOCKS.save)
    // Like every export started directly: one that never ends (the keys did not reach the picker of the new window) must not hold the suite to its own time limit.
    await withinLimit(privateRun)
    check('markdown: a private window can save, and its images go with its own session, not the cookies of the profile', existsSync(privateZip) && imageRequests.some((r) => r.path === '/img/cat.png' && !r.cookie.includes('sid=')), JSON.stringify(imageRequests.find((r) => r.path === '/img/cat.png')))
    opened.win.close()
    await waitFor(() => manager.privateWindows().length === 0, 8000)

    // The blocker of ads and trackers is a hook of the session: a download made with the session of a tab must go through it.
    const probe = session.fromPartition('markdown-probe')
    const hooked: string[] = []
    probe.webRequest.onBeforeRequest((details, callback) => {
      hooked.push(details.url)
      callback({ cancel: details.url.endsWith('/img/blocked.png') })
    })
    imageRequests.length = 0
    const through = await probe.fetch(`${base}/img/cat.png`).then((r) => r.status, () => 0)
    const stopped = await probe.fetch(`${base}/img/blocked.png`).then(() => 'answered', () => 'cancelled')
    check('markdown: a request made with the session of a tab goes through its request hooks (the blocker’s): what they cancel is never fetched', through === 200 && stopped === 'cancelled' && hooked.length === 2 && imageRequests.every((r) => r.path !== '/img/blocked.png'), JSON.stringify({ through, stopped, hooked, imageRequests }))

    // ---------------------------------------------------------------- a hostile page
    const hostile = await openTab(`${base}/hostile`)
    await reset()
    const trap = await start(hostile)
    // The witness: rounds of forged events the page dispatched with the picker up (it counts them, every 40 ms). An event the picker obeyed
    // would have ended it as it was dispatched (markdown-picker.ts, `finish`).
    const forgedAtStart = await inPage<number>(hostile, 'window.__forged ?? 0')
    const forgedSince = await waitFor(async () => (await inPage<number>(hostile, 'window.__forged ?? 0')) >= forgedAtStart + 5)
    check('markdown: events a page forges (clicks, Escape, moves) do not drive the picker', trap.up && forgedSince && (await picking(hostile)), `picker up: ${trap.up}, forged rounds seen: ${forgedSince}`)
    await pressBarButton(hostile, BLOCKS.copy)
    await trap.finished
    const hostileText = (await copied())
    check('markdown: a page that poisons its own JavaScript still gets its visible text exported', hostileText.includes('Texte visible du piège') && hostileText.includes('piège **gras**'), JSON.stringify(hostileText))
    check('markdown: its scripts, handlers, templates and hidden parts are not in the output', !/SCRIPT-BODY-MARKER|ONERROR-MARKER|TEMPLATE-MARKER|NOSCRIPT-MARKER|CONTENU-CSS|pwned|onerror|onclick/i.test(hostileText), JSON.stringify(hostileText))
    check('markdown: the text it writes as markup is escaped, so it cannot become a tag', hostileText.includes('\\<script>texte-balise\\</script>') && !/(^|[^\\])<script/.test(hostileText), JSON.stringify(hostileText))
    check('markdown: ...nor a link: a javascript: address is only text', hostileText.includes('\\[clic\\](javascript:void(0))') && !/(^|[^\\])\]\(javascript:/.test(hostileText), JSON.stringify(hostileText))
    check('markdown: the page’s own scripts ran in the page (the export did not stop them) and kept forging events', (await inPage<number>(hostile, 'window.__ran')) === 1 && (await inPage<number>(hostile, 'window.__forged')) > 5)

    // ---------------------------------------------------------------- a strict page, a deep page
    const strict = await openTab(`${base}/strict`)
    await reset()
    const strictRun = await start(strict)
    check('markdown: the picker shows on a page whose policy forbids scripts, styles and untrusted markup', strictRun.up)
    await pressBarButton(strict, BLOCKS.copy)
    await strictRun.finished
    check('markdown: ...and exports it', (await copied()).includes('Page à la politique stricte'), JSON.stringify((await copied())))

    const deep = await openTab(`${base}/deep`)
    await reset()
    const deepRun = await start(deep)
    await pressBarButton(deep, BLOCKS.copy)
    await deepRun.finished
    check('markdown: a page nested deeper than the limit is cut, not refused: the rest is exported and the cut announced', (await copied()).includes('Haut de page') && !(await copied()).includes('fond de la page') && toastNow().includes('tronqué'), `${JSON.stringify((await copied()))} / ${toastNow()}`)

    // ---------------------------------------------------------------- leaving the page, the command bar, other pages
    const leaves = await openTab(`${base}/page?leaves=1`)
    await reset()
    const left = browser.exportMarkdown()
    await waitFor(() => picking(leaves), 5000)
    await inPage(leaves, `location.href = ${JSON.stringify(`${base}/other`)}`).catch(() => undefined)
    const settled = await Promise.race([left.then(() => 'done'), sleep(8000).then(() => 'stuck')])
    check('markdown: leaving the page while the picker is up ends it', settled === 'done')

    const barPage = await openTab(`${base}/page?bar=1`)
    await reset()
    browser.openOverlay({ panel: 'commandbar', mode: 'current', initial: '' })
    await waitFor(() => browser.currentPanel() === 'commandbar', 5000)
    await sleep(500)
    await ctx.overlayView.webContents.executeJavaScript(`window.lucium.markdownExport()`)
    const pickerUp = await waitFor(() => picking(barPage), 6000)
    const barGone = browser.currentPanel() !== 'commandbar'
    // The bar is gone and the picker is up. A box that a page asked for while the bar was open (a sign-in box of a tab that an earlier suite left behind, reloaded by one
    // of the suites before this one) was queued behind the bar and opens as the bar closes: it is no part of this check, but it is named (here and in the log, so that the
    // suite that left the tab can be found), and put away, so that the keys below reach the page. Then nothing is left over the page.
    const otherBoxes = barGone ? closeLeftoverPanels(browser) : []
    if (otherBoxes.length > 0) console.warn(`[smoke-markdown] a box other than the command bar was up when the picker opened (a page asked for it meanwhile): ${otherBoxes.join(' | ')}`)
    check('markdown: the command bar’s action closes the bar, then shows the picker over the page', pickerUp && barGone && browser.currentPanel() === null, JSON.stringify({ pickerUp, barGone, panel: browser.currentPanel(), otherBoxes }))
    await key(barPage, 'Escape')
    await waitFor(async () => !(await picking(barPage)), 5000)

    browser.dispatch({ type: 'tab/open', url: 'about:blank', spaceId })
    await waitFor(() => store.get().tabs.some((t) => t.spaceId === spaceId && t.url === 'about:blank'), 5000)
    await sleep(400)
    const blankItem = fileMenuItem()
    check('markdown: the menu entry is off when the page is not a web page', blankItem?.enabled === false, String(blankItem?.enabled))
    await reset()
    await browser.exportMarkdown()
    check('markdown: asked anyway, the export says it needs a web page and shows no picker', toastNow() === 'L’export en Markdown n’est possible que pour une page web.' && asked.length === 0, toastNow())
  } finally {
    restoreUi()
    await clipboard.writeText(savedClipboard)
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: sleepAfter } })
    for (const tab of store.get().tabs.filter((t) => t.spaceId === spaceId)) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.dispatch({ type: 'space/select', id: previousSpace })
    browser.dispatch({ type: 'space/delete', id: spaceId })
    // Not awaited: the browser keeps its connections open, and the close would wait for them.
    server.close()
    server.closeAllConnections()
    rmSync(folder, { recursive: true, force: true })
  }
}

/** `LUCIUM_SMOKE_ONLY=markdown`: only these checks (the quick loop while working on them). */
export async function runMarkdownSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeMarkdown(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeMarkdown ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_MARKDOWN ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
