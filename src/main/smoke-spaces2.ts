// Engine checks for three optional functions, all off by default: a picture for a space, the sidebar at the right of the window
// and web panels. Run inside a real Electron, with real mouse and keyboard input (sendInputEvent) on the real surfaces, a
// local server for the pages, and the numbers of the window in CSS pixels (a Retina screen draws two device pixels for one: the pixels
// that are read back from a capture are divided by the scale of the capture). Called from the engine smoke test: `await smokeSpaces2(ctx, check)`.
// `LUCIUM_SMOKE_ONLY=spaces2` runs only this file.
//
// First, with the default settings, that none of it shows: the sidebar is where it always is, nothing is in the menus and the folder of the
// pictures does not exist. Then each function is switched on in the Settings window by a real click, used, and switched off again.

import { createServer, type IncomingMessage } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { app, BrowserWindow as ElectronWindow, Menu, nativeImage, screen, type WebContents, type WebContentsView } from 'electron'
import { FLOATING_INSET, PAGE_MARGIN, TRAFFIC_LIGHTS } from '@shared/ipc'
import { FLOAT_SHADOW, LIGHTS_CLEARANCE } from '@shared/frame-layout'
import { imageHeader, SPACE_IMAGE_FILE_MAX, SPACE_IMAGE_SIZE, spaceImageUnreadable } from '@shared/space-image'
import { webPanelsOff } from '@shared/web-panels'
import type { Settings } from '@shared/model'
import { showMenu } from './shell/context-menus'
import { setImageChooserForTest } from './shell/space-images-electron'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(6000, 60)

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const near = (actual: number | undefined, expected: number, tolerance = 1) => actual !== undefined && Math.abs(actual - expected) <= tolerance
const show = (r: Rect | null | undefined) => (r ? `${Math.round(r.x * 10) / 10},${Math.round(r.y * 10) / 10} ${Math.round(r.width * 10) / 10}x${Math.round(r.height * 10) / 10}` : 'absent')
const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** A 160 x 80 WebP (red to blue), made once with cwebp: Electron's nativeImage cannot write one. */
const WEBP_160x80 =
  'UklGRvIAAABXRUJQVlA4IOYAAAAQCACdASqgAFAAPp1Oo04lpCMiIKgAsBOJY27f8AWqybPh+XcqsAE97iLyzlGaUhjqpDHVSGOqkMdVIY6qQx1UhiLuqkMdVINAAP7uf5/+Yofn2D/9p+/6Gn/afvnC6ZWez9u5mc8N4aozyUnHxHgAfdq+U4y7WKjT5M1QO876heIuLHDL2sBl6lR9XIdXffB10AJeau9JxIXvmakInZZiqAEx4nZXQ49wbSUjjwZkDxuJm3akcpsxgPFfVeoJNaPydsY+JVjeeth96uDGEmm4OUYkWo6jrachPImVaRL2l5Y/csNAAA=='

/** A red-to-blue picture of this size as BGRA pixels. */
function gradient(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      pixels[at] = Math.round((255 * x) / (width - 1)) // blue grows to the right
      pixels[at + 1] = 40
      pixels[at + 2] = Math.round(255 * (1 - x / (width - 1))) // red fades
      pixels[at + 3] = 255
    }
  }
  return pixels
}

/** A self-signed certificate for 127.0.0.1, made with the system's openssl in a throw-away folder. Null when openssl is not there. */
function selfSignedCertificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-spaces2-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
  } catch (error) {
    console.warn('[spaces2] cannot make a certificate:', error instanceof Error ? error.message : String(error))
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function smokeSpaces2(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const chrome = win.webContents
  const ui = overlayView.webContents
  const settings = () => store.get().settings
  const darwin = process.platform === 'darwin'
  const picturesDir = join(app.getPath('userData'), 'space-images')

  const evaluate = <T>(wc: WebContents, script: string): Promise<T> =>
    (wc.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${String(error)} -- in: ${script.replace(/\s+/g, ' ').slice(0, 200)}`)
    })
  const rectOf = (wc: WebContents, selector: string, nth = 0) =>
    evaluate<Rect | null>(wc, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const textOf = (wc: WebContents, selector: string) => evaluate<string>(wc, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const rectByText = (wc: WebContents, selector: string, text: string) =>
    evaluate<Rect | null>(wc, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const mouse = (wc: WebContents, type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  const clickAt = async (wc: WebContents, x: number, y: number) => {
    mouse(wc, 'mouseMove', x, y)
    await sleep(60)
    mouse(wc, 'mouseDown', x, y)
    mouse(wc, 'mouseUp', x, y)
    await sleep(120)
  }
  const clickRect = (wc: WebContents, r: Rect) => clickAt(wc, centre(r).x, centre(r).y)
  const typeKeys = async (wc: WebContents, text: string) => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(30)
    }
    await sleep(120)
  }
  const patch = (changes: Partial<Settings>) => browser.dispatch({ type: 'settings/update', patch: changes })

  // ---- the window: a size of its own, from the corner of the screen ----
  const savedBounds = win.getBounds()
  const original = { ...settings() }
  const workArea = screen.getPrimaryDisplay().workArea
  win.setBounds({ x: workArea.x, y: workArea.y, width: 1200, height: 800 })
  await sleep(600)
  patch({ sidebarVisible: true, sidebarWidth: 323, sidePanelWidth: 400, showToolbar: true, hoverCards: true, sleepAfterMinutes: 0, sidebarRight: false, spaceImages: false, webPanels: false })
  const W = await evaluate<number>(chrome, 'innerWidth')
  const H = await evaluate<number>(chrome, 'innerHeight')

  // ---- a local server: pages, a cookie, a page that echoes the cookie it receives ----
  const requests: string[] = []
  const handler = (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    requests.push(path)
    if (path === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (path === '/set-cookie') {
      res.setHeader('set-cookie', 'spaces2=partage-par-le-profil; Path=/')
      return void res.end('<title>Cookie posé</title><body>ok</body>')
    }
    if (path === '/wp-cookie') return void res.end(`<title>Volet cookie</title><body>cookie:${encodeURIComponent(req.headers.cookie ?? '')}:fin</body>`)
    if (path === '/wp-a') {
      return void res.end('<title>Volet A</title><body style="margin:0"><a id="l" href="/wp-b" target="_blank" style="position:absolute;left:10px;top:10px;width:160px;height:40px;display:block;background:#fc0">autre volet</a></body>')
    }
    res.end(`<title>Page ${path}</title><body>spaces2 ${path}</body>`)
  }
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const work = mkdtempSync(join(tmpdir(), 'lucium-spaces2-'))
  const previousSpace = store.get().activeSpaceId
  const createdSpaces: string[] = []
  const secure: Array<import('node:https').Server> = []
  let chooserCalls = 0
  let nextFile: string | null = null
  setImageChooserForTest(async () => {
    chooserCalls++
    return nextFile
  })

  const idOfSpace = () => store.get().activeSpaceId
  const spaceNow = () => store.get().spaces.find((s) => s.id === idOfSpace())!
  const tabViewOf = (tabId: string) => {
    const wc = (browser.pageFor(tabId) as unknown as { webContents: WebContents } | undefined)?.webContents
    return win.contentView.children.map((v) => v as WebContentsView).find((v) => v.webContents === wc)
  }
  const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  /** The menus a showMenu() would pop up, as nested label lists. */
  const recordMenus = async (run: () => void | Promise<void>): Promise<string[][]> => {
    const real = Menu.prototype.popup
    const opened: string[][] = []
    const labelsOf = (menu: Menu): string[] => menu.items.flatMap((item) => [item.label, ...(item.submenu ? labelsOf(item.submenu) : [])]).filter((l) => l !== '')
    Menu.prototype.popup = function (this: Menu) {
      opened.push(labelsOf(this))
      return this
    }
    try {
      await run()
      await sleep(300)
    } finally {
      Menu.prototype.popup = real
    }
    return opened
  }
  const appMenuHas = (label: string): boolean => {
    const walk = (items: readonly Electron.MenuItem[]): boolean => items.some((item) => item.label === label || (item.submenu ? walk(item.submenu.items) : false))
    return walk(Menu.getApplicationMenu()?.items ?? [])
  }

  try {
    // ---- a space of its own, with a page in it ----
    browser.dispatch({ type: 'space/create', name: 'Espace volets', emoji: '🧪', hue: 200 })
    createdSpaces.push(idOfSpace())
    const space = idOfSpace()
    browser.dispatch({ type: 'tab/open', url: `${base}/a` })
    const tab = store.get().tabs.at(-1)!
    await waitFor(() => tabViewOf(tab.id) !== undefined && browser.snapshot().runtime.tabs[tab.id]?.loading === false)
    // A fixed wait, for want of a witness: the window lays itself out for the new space and its page, which says nothing once it is drawn, and
    // the checks below measure that layout.
    await sleep(500)

    // =========================================================================================================
    // 1. Default settings: none of the three functions shows, and the window is the default one
    // =========================================================================================================
    check('defaults: the sidebar at the right and the web panels are off', !settings().sidebarRight && !settings().webPanels)
    const aside = await rectOf(chrome, 'aside.sidebar')
    check('defaults: the sidebar is at the left edge, 323 px wide and as high as the window', !!aside && near(aside.x, 0, 0.6) && near(aside.width, 323, 0.6) && near(aside.height, H, 0.6), show(aside))
    check('defaults: the window carries no mirror class', !(await evaluate<boolean>(chrome, `document.querySelector('.shell').classList.contains('sidebar-right')`)))
    const stageDom = await rectOf(chrome, 'main.stage')
    const card = tabViewOf(tab.id)!.getBounds()
    check('defaults: the page card starts at the sidebar (x = 323), under the toolbar, 10 px from the right and bottom edges', card.x === 323 && near(card.y, (stageDom?.y ?? 0), 1) && near(card.x + card.width, W - PAGE_MARGIN, 0) && near(card.y + card.height, H - PAGE_MARGIN, 0), JSON.stringify(card))
    const toggle = await rectOf(chrome, '.sidebar .sidebar-toggle')
    check('defaults: the sidebar button is after the traffic lights (x = 77), at the left', !!toggle && near(toggle.x, 77, 0.6), show(toggle))
    const back = await rectOf(chrome, 'button[aria-label="Précédent"]')
    check('defaults: the toolbar starts at the sidebar\'s edge and its first button is 5 px in (nothing is kept for the traffic lights)', !!back && near(back.x, 323 + 5, 0.6), show(back))
    if (darwin) check('defaults: the traffic lights are at Arc\'s place and shown with the sidebar', browser.trafficLights().visible && browser.trafficLights().position.x === TRAFFIC_LIGHTS.x && browser.trafficLights().position.y === TRAFFIC_LIGHTS.y)
    const header = await rectOf(chrome, '.space-header-emoji')
    const footerButton = await rectOf(chrome, '.sidebar .space.current')
    check('defaults: the space header emoji is a 26 x 26 box holding text (no picture), the footer button 34 x 32', !!header && near(header.width, 26, 0.6) && near(header.height, 26, 0.6) && !!footerButton && near(footerButton.width, 34, 0.6) && near(footerButton.height, 32, 0.6) && (await evaluate<number>(chrome, `document.querySelectorAll('.sidebar img.space-image').length`)) === 0, `${show(header)} | ${show(footerButton)}`)
    check('defaults: the dock has no header and no web panel is open', (await rectOf(chrome, '.side-panel-header')) === null && browser.snapshot().webPanel === undefined)

    const spaceMenus = await recordMenus(() => showMenu({ kind: 'space', id: space }, browser, store, win))
    check('defaults: the menu of a space offers no web panels', spaceMenus.length === 1 && spaceMenus[0]!.includes('Mettre l’espace de côté…') && !spaceMenus[0]!.includes('Volets web'), JSON.stringify(spaceMenus[0]))
    check('defaults: the Espaces menu offers no web panels', !appMenuHas('Volets web'))
    const refusedPick = await evaluate<{ ok: boolean; message: string }>(chrome, `window.lucium.spaceImage({ op: 'pick', spaceId: ${JSON.stringify(space)} })`)
    // The picture of a space is offered by the icon picker whatever the old setting says: the request is not refused, the dialog opens (and is closed here).
    check('defaults: a picture request from the interface is no longer refused by a setting: the dialog opens, and closing it says nothing', refusedPick.ok === false && refusedPick.message === '' && chooserCalls === 1, JSON.stringify(refusedPick))
    chooserCalls = 0
    const unreadable = await evaluate<{ ok: boolean; message: string }>(chrome, `window.lucium.spaceImage({ op: 'read', name: '0123456789abcdef01234567.png' })`)
    check('defaults: reading a picture that is not there is answered as unreadable', unreadable.ok === false && unreadable.message === spaceImageUnreadable())
    await evaluate(chrome, `window.lucium.webPanel({ op: 'add' })`)
    // The witness: the request is a message without an answer; a question asked after it on the same channel is answered once the main process
    // has handled it.
    await evaluate(chrome, 'window.lucium.getSnapshot().then(() => 0)')
    check('defaults: asking for a web panel changes nothing but a notice that the function is off', (store.get().spaces.find((s) => s.id === space)?.webPanels ?? []).length === 0 && browser.snapshot().toast?.message === webPanelsOff(), browser.snapshot().toast?.message)
    check('defaults: nothing was written for the pictures (the folder does not exist)', !existsSync(picturesDir))

    // The floating sidebar of the default layout, with a real pointer at the left edge (the mirrored one is checked below against it).
    patch({ sidebarVisible: false })
    await sleep(500)
    await clickAt(chrome, W / 2, 400)
    mouse(chrome, 'mouseMove', 1, 300)
    check('defaults: the pointer at the left edge shows the floating sidebar, a view from x = 0', await waitFor(() => browser.isFloatingSidebarShown(), 3000))
    await sleep(400)
    const floatView = win.contentView.children.map((v) => v as WebContentsView).find((v) => v.webContents.getURL().includes('#float'))
    check('defaults: the floating view is at the left edge, as wide as the panel, its inset and its shadow', floatView?.getBounds().x === 0 && floatView.getBounds().width === 323 + FLOATING_INSET + FLOAT_SHADOW, JSON.stringify(floatView?.getBounds()))
    // The pointer leaves the panel's own surface (the floating sidebar is a view of its own, which hears its own pointer).
    floatView?.webContents.sendInputEvent({ type: 'mouseMove', x: 100, y: 300 })
    await sleep(100)
    floatView?.webContents.sendInputEvent({ type: 'mouseLeave', x: 900, y: 400 })
    check('defaults: leaving the panel takes it away', await waitFor(() => !browser.isFloatingSidebarShown(), 3000))
    patch({ sidebarVisible: true })
    await sleep(500)

    // =========================================================================================================
    // 2. The Settings window: two switches, off, each flipped by a real click
    // =========================================================================================================
    // The group « Espaces et fenêtre » is in Réglages › Apparence (SpacesSettings.tsx); the web panels are a feature to add, a line of « Fonctions en
    // option » › Barre latérale et fenêtres (FeaturesPage.tsx). The picture of a space has no switch any more: it is chosen in « Personnaliser
    // l’espace » (Émoji / Lettre / Image), and the key `spaceImages` only stays so that an older state loads.
    browser.openOverlay({ panel: 'settings', pane: 'appearance' })
    await waitFor(() => settingsWindows().length === 1)
    const sw = settingsWindows()[0]!.webContents
    /**
     * Shows a page of the window with a click on its entry in the sidebar, and waits for its rows. The window has its title before its page draws anything:
     * the entry is waited for first, or the first click of the suite lands on an empty document.
     */
    const showPage = async (pane: string): Promise<boolean> => {
      const entry = `document.querySelector('.settings-cat[data-cat=${JSON.stringify(pane)}]')`
      await waitFor(() => evaluate<boolean>(sw, `!!${entry}`), 6000)
      await evaluate(sw, `${entry}?.click()`)
      const shown = await waitFor(async () => (await evaluate<string>(sw, `document.querySelector('.settings-cat[aria-current=page]')?.dataset.cat ?? ''`)) === pane, 6000)
      await waitFor(async () => (await evaluate<number>(sw, `document.querySelectorAll('.settings-content .pref-check').length`)) > 0, 6000)
      await sleep(500)
      return shown
    }
    // One switch remains: the picture of a space is no longer a setting (the icon picker of « Personnaliser l'espace » offers it, see section 3), and
    // the side of the sidebar is a menu of its two sides (checked below).
    const SWITCHES: Array<[string, keyof Settings, string]> = [['Volets web', 'webPanels', 'features']]
    // A row is a label, or a div with a label inside and a button "Voir l'effet" beside the switch when the setting has an illustration: both are `.pref-check`,
    // and the text of a row is that of its .pref-label (a line of « Fonctions en option » is one of the second kind).
    const rowScript = (label: string) => `[...document.querySelectorAll('.settings-content .pref-check')].find((r) => (r.querySelector('.pref-label')?.textContent ?? '').trim().startsWith(${JSON.stringify(label)}))`
    const switchRect = (label: string) => evaluate<Rect | null>(sw, `(() => { const row = ${rowScript(label)}; const el = row?.querySelector('input[role=switch]'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()`)
    for (const [label, key, pane] of SWITCHES) {
      check(`settings: the page ${pane} is shown`, await showPage(pane))
      const rect = await switchRect(label)
      check(`settings: "${label}…" is there, off`, !!rect && settings()[key] === false, show(rect))
      if (!rect) continue
      await clickRect(sw, rect)
      const on = await waitFor(() => settings()[key] === true, 3000)
      await clickRect(sw, (await switchRect(label)) ?? rect)
      const off = await waitFor(() => settings()[key] === false, 3000)
      check(`settings: a real click on "${label}…" turns ${key} on, and another off`, on && off)
    }
    // « Côté de la barre latérale »: a menu « À gauche / À droite » that writes sidebarRight, chosen as a person chooses an entry.
    check('settings: the page appearance is shown', await showPage('appearance'))
    const side = `document.querySelector('.settings-content .pref-row[data-setting="sidebarRight"]:not([data-mirror]) select')`
    const chooseSide = (value: 'true' | 'false') => evaluate<string>(sw, `(() => { const el = ${side}; if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok' })()`)
    const sideMenu = await evaluate<{ label: string; options: string[]; value: string } | null>(sw, `(() => { const el = ${side}; return el ? { label: el.getAttribute('aria-label') ?? '', options: [...el.options].map((o) => o.textContent), value: el.value } : null })()`)
    check('settings: « Côté de la barre latérale » is a menu « À gauche / À droite », on the left', sideMenu?.label === 'Côté de la barre latérale' && JSON.stringify(sideMenu.options) === JSON.stringify(['À gauche', 'À droite']) && sideMenu.value === 'false' && settings().sidebarRight === false, JSON.stringify(sideMenu))
    const right = (await chooseSide('true')) === 'ok' && (await waitFor(() => settings().sidebarRight === true, 3000))
    const left = (await chooseSide('false')) === 'ok' && (await waitFor(() => settings().sidebarRight === false, 3000))
    check('settings: « À droite » turns sidebarRight on, and « À gauche » off', right && left)
    /** The names of the switches of the group titled `title` on the page shown. */
    const switchesIn = (title: string) =>
      evaluate<string[]>(sw, `(() => { const section = [...document.querySelectorAll('.settings-content .pref-section')].find((s) => s.querySelector(':scope > h3 > .pref-title')?.textContent === ${JSON.stringify(title)}); return [...(section?.querySelectorAll('input[role=switch]') ?? [])].map((i) => i.getAttribute('aria-label')) })()`)
    // The window draws one page at a time: the group of the catalogue is read on the page « Fonctions en option ».
    await showPage('features')
    const panels = await switchesIn('Barre latérale et fenêtres')
    check('settings: the web panels are a line of « Fonctions en option » › Barre latérale et fenêtres', panels.includes('Volets web'), JSON.stringify(panels))
    await showPage('appearance')
    check('settings: there is no switch for the picture of a space any more (it is chosen in « Personnaliser l’espace »), and the old setting stays off', !(await evaluate<boolean>(sw, `!!${rowScript('Choisir une image pour un espace')}`)) && !(await evaluate<boolean>(sw, `!!document.querySelector('[data-setting~="spaceImages"]')`)) && settings().spaceImages === false)
    const titles = await evaluate<string[]>(sw, `[...document.querySelectorAll('.settings-content .pref-section > h3 > .pref-title')].map((h) => h.textContent)`)
    const spaces = await switchesIn('Espaces et fenêtre')
    const sideInGroup = await evaluate<boolean>(sw, `!!${side}?.closest('.pref-section')?.querySelector(':scope > h3 > .pref-title')?.textContent?.includes('Espaces et fenêtre')`)
    check('settings: the group « Espaces et fenêtre » sits in Réglages › Apparence with the side of the sidebar, without the web panels, and « À propos » is not in this pane', titles.includes('Espaces et fenêtre') && sideInGroup && !spaces.some((name) => /volets web/i.test(name ?? '')) && !titles.includes('À propos'), JSON.stringify({ titles, spaces, sideInGroup }))
    settingsWindows()[0]?.close()
    await sleep(300)

    // =========================================================================================================
    // 3. A picture for a space
    // =========================================================================================================
    const pictures = join(work, 'pictures')
    mkdirSync(pictures)
    const files = {
      png: join(pictures, 'vacances.png'),
      jpeg: join(pictures, 'portrait.jpg'),
      webp: join(pictures, 'banniere.webp'),
      text: join(pictures, 'notes.png'),
      svg: join(pictures, 'dessin.png'),
      huge: join(pictures, 'immense.png'),
      heavy: join(pictures, 'lourde.png'),
      truncated: join(pictures, 'coupee.png')
    }
    const bitmap = nativeImage.createFromBitmap(gradient(300, 200), { width: 300, height: 200 })
    writeFileSync(files.png, bitmap.toPNG())
    writeFileSync(files.jpeg, nativeImage.createFromBitmap(gradient(200, 300), { width: 200, height: 300 }).toJPEG(90))
    writeFileSync(files.webp, Buffer.from(WEBP_160x80, 'base64'))
    writeFileSync(files.text, 'ceci est du texte, pas une image')
    writeFileSync(files.svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')
    // A header that announces 20 000 x 10 pixels: refused before anything is decoded.
    const hugeHeader = Buffer.from(bitmap.toPNG())
    hugeHeader.writeUInt32BE(20_000, 16)
    writeFileSync(files.huge, hugeHeader)
    writeFileSync(files.heavy, bitmap.toPNG())
    truncateSync(files.heavy, SPACE_IMAGE_FILE_MAX + 10)
    // A real PNG cut in the middle of its data: the header is fine, the decoder cannot finish.
    writeFileSync(files.truncated, bitmap.toPNG().subarray(0, 45))

    browser.openOverlay({ panel: 'space', spaceId: space, focus: 'icon' })
    await waitFor(async () => (await rectByText(ui, '.ip-seg button', 'Image')) !== null, 4000)
    const imageTab = await rectByText(ui, '.ip-seg button', 'Image')
    if (imageTab) await clickRect(ui, imageTab)
    check('picture: the icon picker offers "Choisir une image…" in its Image tab, with no setting to switch on', await waitFor(async () => (await rectByText(ui, '.ip-drop-actions button', 'Choisir')) !== null, 4000))
    const stored = () => (existsSync(picturesDir) ? readdirSync(picturesDir).sort() : [])
    /** Clicks "Choisir une image…" with the dialog answering `file`; waits for the picture to change (the decoder takes its time), or for a moment when it should not. */
    const pick = async (file: string | null, changes = false): Promise<void> => {
      nextFile = file
      const was = spaceNow().image
      const button = await rectByText(ui, '.ip-drop-actions button', 'Choisir')
      if (button) await clickRect(ui, button)
      if (changes) await waitFor(() => spaceNow().image !== was, 8000)
      await sleep(changes ? 300 : 900)
    }
    const message = () => textOf(ui, '.ip-warn')

    await pick(files.png, true)
    const first = spaceNow().image
    check('picture: a real click on "Choisir une image…" gives the space a picture, named by 24 hex digits', typeof first === 'string' && /^[0-9a-f]{24}\.png$/.test(first), String(first))
    check('picture: only the shrunk copy is in the data folder', JSON.stringify(stored()) === JSON.stringify([first]), JSON.stringify(stored()))
    const header1 = first ? imageHeader(readFileSync(join(picturesDir, first))) : null
    check('picture: the copy is a PNG of 128 x 128 (the middle of the 300 x 200 original, cropped square)', header1?.format === 'png' && header1.width === SPACE_IMAGE_SIZE && header1.height === SPACE_IMAGE_SIZE, JSON.stringify(header1))
    check('picture: the state names the copy, and never the original\'s path or name', !JSON.stringify(store.get()).includes('vacances') && !JSON.stringify(store.get()).includes(pictures))
    check('picture: the copy holds no trace of the original\'s path either', first !== undefined && !readFileSync(join(picturesDir, first)).includes(Buffer.from(pictures)))

    // The sidebar shows it in place of the emoji, in the same boxes.
    await waitFor(async () => (await evaluate<number>(chrome, `document.querySelectorAll('.sidebar img.space-image').length`)) >= 2, 4000)
    const headerImage = await rectOf(chrome, '.space-header-emoji img.space-image')
    const footerImage = await rectOf(chrome, '.sidebar .space.current img.space-image')
    const headerBox = await rectOf(chrome, '.space-header-emoji')
    const footerBox = await rectOf(chrome, '.sidebar .space.current')
    check('picture: the header shows it inside the emoji\'s own 26 x 26 box, as a circle', !!headerImage && !!headerBox && headerImage.width <= 26 && headerImage.height <= 26 && near(headerBox.width, 26, 0.6) && near(headerBox.height, 26, 0.6) && (await evaluate<string>(chrome, `getComputedStyle(document.querySelector('.space-header-emoji img')).borderRadius`)) === '50%', `${show(headerImage)} in ${show(headerBox)}`)
    check('picture: the footer shows it in the 34 x 32 button of the emoji, unchanged', !!footerImage && !!footerBox && footerImage.width <= 24 && footerImage.height <= 24 && near(footerBox.width, 34, 0.6) && near(footerBox.height, 32, 0.6), `${show(footerImage)} in ${show(footerBox)}`)
    check('picture: the header row keeps its 36 px', near((await rectOf(chrome, '.space-header'))?.height, 36, 0.6))
    const natural = await evaluate<number>(chrome, `document.querySelector('.space-header-emoji img').naturalWidth`)
    check('picture: the interface loaded the 128 px copy', natural === SPACE_IMAGE_SIZE, String(natural))

    // What is drawn is the picture: red on its left side, blue on its right (the original runs from red to blue), whatever the scale of the screen.
    const probe = async (r: Rect) => {
      const cssWidth = Math.ceil(r.width)
      const cssHeight = Math.ceil(r.height)
      const grab = await chrome.capturePage({ x: Math.floor(r.x), y: Math.floor(r.y), width: cssWidth, height: cssHeight })
      const bgra = grab.toBitmap()
      // A capture has the screen's resolution (2 device pixels per CSS pixel on a Retina screen): the scale is read from its size, not assumed.
      const scale = Math.round(Math.sqrt(bgra.length / 4 / (cssWidth * cssHeight)) * 100) / 100
      const widthPx = Math.round(cssWidth * scale)
      const at = (fx: number) => {
        const px = Math.round(fx * r.width * scale)
        const py = Math.round((r.height / 2) * scale)
        const i = (py * widthPx + px) * 4
        return { b: bgra[i]!, r: bgra[i + 2]! }
      }
      return { left: at(0.3), right: at(0.7), scale }
    }
    if (headerImage) {
      const colours = await probe(headerImage)
      check(`picture: the header's pixels are the picture's, red at the left and blue at the right (capture scale ${colours.scale})`, colours.left.r > colours.left.b + 40 && colours.right.b > colours.right.r + 40, JSON.stringify(colours))
    }
    // The Image tab of the icon picker shows the picture in its 40 px mark, above its buttons (IconPicker.tsx, .ip-drop-mark).
    await waitFor(async () => (await rectOf(ui, '.ip-drop-mark img.space-image')) !== null, 4000)
    const preview = await rectOf(ui, '.ip-drop-mark img.space-image')
    check('picture: the editor previews it', !!preview && preview.width > 20, show(preview))

    // A picture of another format replaces it: JPEG, then WebP. The old copy goes with each change.
    await pick(files.jpeg, true)
    const second = spaceNow().image
    check('picture: a JPEG replaces it, and the old copy is deleted (one file left)', !!second && second !== first && JSON.stringify(stored()) === JSON.stringify([second]), `${first} -> ${second} ${JSON.stringify(stored())}`)
    check('picture: ...a portrait JPEG is cropped square at 128 x 128 too', second !== undefined && imageHeader(readFileSync(join(picturesDir, second)))?.width === SPACE_IMAGE_SIZE && imageHeader(readFileSync(join(picturesDir, second)))?.height === SPACE_IMAGE_SIZE)
    await pick(files.webp, true)
    const third = spaceNow().image
    check('picture: a WebP (which Electron\'s nativeImage cannot read) works as well', !!third && third !== second && JSON.stringify(stored()) === JSON.stringify([third]) && imageHeader(readFileSync(join(picturesDir, third)))?.width === SPACE_IMAGE_SIZE, `${second} -> ${third}`)

    // Refusals: a sentence in the editor, the space and the folder as they were, nothing left behind.
    const refusals: Array<[string, string, RegExp]> = [
      ['a text file named like a picture', files.text, /PNG, JPEG ou WebP/],
      ['an svg with a script, named like a picture', files.svg, /PNG, JPEG ou WebP/],
      ['a picture announcing 20 000 pixels', files.huge, /trop grande/],
      ['a file past 5 MB', files.heavy, /lourde/],
      ['a picture cut short', files.truncated, /pas pu être lue|abîmée/],
      ['a file that does not exist', join(pictures, 'absent.png'), /ouvert/]
    ]
    for (const [what, file, expected] of refusals) {
      await pick(file)
      const said = await message()
      check(`picture: ${what} is refused with a sentence, the space keeps its picture, the folder is as it was`, expected.test(said) && spaceNow().image === third && JSON.stringify(stored()) === JSON.stringify([third]), `${said} | ${spaceNow().image} | ${JSON.stringify(stored())}`)
    }
    await pick(null)
    check('picture: closing the dialog changes nothing and says nothing', spaceNow().image === third && (await message()) === '')
    // The request carries no path: the one the interface might add is never read.
    const sneaky = await evaluate<{ ok: boolean; message: string }>(chrome, `window.lucium.spaceImage({ op: 'pick', spaceId: ${JSON.stringify(space)}, path: '/etc/passwd' })`)
    check('picture: a path slipped into the request is ignored (the dialog answers, and nothing is read from it)', sneaky.ok === false && sneaky.message === '' && spaceNow().image === third, JSON.stringify(sneaky))
    check('picture: a name that is not one of ours is refused by the interface\'s channel', (await evaluate<{ ok: boolean }>(chrome, `window.lucium.spaceImage({ op: 'read', name: '../../etc/passwd' })`)).ok === false)

    // The interface cannot name a file itself.
    // No wait: the interface's dispatch is answered once the main process has handled it, a refusal included.
    await evaluate<void>(chrome, `window.lucium.dispatch({ type: 'space/image', id: ${JSON.stringify(space)}, image: '0123456789abcdef01234567.png' })`)
    check('picture: the interface cannot dispatch space/image (only the main process names a file)', spaceNow().image === third)

    // Taking it away.
    const removeButton = await rectByText(ui, '.ip-drop-actions button', 'Retirer')
    if (removeButton) await clickRect(ui, removeButton)
    check('picture: "Retirer l’image" puts the emoji back and deletes the copy', (await waitFor(() => spaceNow().image === undefined, 3000)) && (await waitFor(() => stored().length === 0, 3000)) && (await waitFor(async () => (await evaluate<number>(chrome, `document.querySelectorAll('.sidebar img.space-image').length`)) === 0, 3000)))

    // A copy that is damaged on the disk is let go of when it is asked for.
    await pick(files.png, true)
    const damaged = spaceNow().image!
    writeFileSync(join(picturesDir, damaged), 'abîmée sur le disque')
    const reply = await evaluate<{ ok: boolean; message: string }>(chrome, `window.lucium.spaceImage({ op: 'read', name: ${JSON.stringify(damaged)} })`)
    check('picture: a damaged copy is refused when asked for, the space shows its emoji again, the file is deleted', reply?.ok === false && (await waitFor(() => spaceNow().image === undefined, 3000)) && !stored().includes(damaged), JSON.stringify(reply))

    // A dialog that fails: the editor says so, the space is as it was.
    const keptBefore = spaceNow().image
    setImageChooserForTest(async () => {
      throw new Error('forced: the dialog failed')
    })
    const realLog = console.error
    const logged: string[] = []
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    try {
      const button = await rectByText(ui, '.ip-drop-actions button', 'Choisir')
      if (button) await clickRect(ui, button)
      await sleep(900)
    } finally {
      console.error = realLog
    }
    check('picture: when the request itself fails the editor says so and the space keeps what it had', (await message()) === 'L’image n’a pas pu être importée.' && spaceNow().image === keptBefore, await message())
    setImageChooserForTest(async () => {
      chooserCalls++
      return nextFile
    })

    // A new picture, for the checks that follow.
    await pick(files.png, true)
    const kept = spaceNow().image!
    check('picture: set again for the next checks', typeof kept === 'string' && stored().includes(kept))
    browser.closeOverlay()

    // The old setting gates nothing any more: with it off the picture still shows and is still served.
    patch({ spaceImages: false })
    // A fixed wait, for want of a witness: the sidebar is drawn again from the state it is sent, and says nothing once it has drawn it.
    await sleep(300)
    check('picture: with the old setting off the picture still shows in the sidebar, and the copy is kept', (await evaluate<number>(chrome, `document.querySelectorAll('.sidebar img.space-image').length`)) >= 2 && stored().includes(kept) && spaceNow().image === kept)
    const offReply = await evaluate<{ ok: boolean; message: string }>(chrome, `window.lucium.spaceImage({ op: 'read', name: ${JSON.stringify(kept)} })`)
    check('picture: ...and the main process serves it', offReply.ok === true)

    // Put aside and reopened, the space keeps it; deleted, it takes the copy with it.
    browser.dispatch({ type: 'space/create', name: 'Autre', emoji: '🪴', hue: 100 })
    createdSpaces.push(idOfSpace())
    const other = idOfSpace()
    browser.dispatch({ type: 'space/select', id: space })
    // No wait: the dispatch deletes the pictures that nothing names any more before it returns (browser-actions.ts, `sweepPictures`).
    browser.dispatch({ type: 'space/aside', id: space })
    check('picture: a space put aside keeps its copy', !store.get().spaces.some((s) => s.id === space) && stored().includes(kept))
    const session = store.get().sessions.find((s) => s.space?.space.id === space)!
    browser.dispatch({ type: 'space/reopen', id: session.id })
    check('picture: ...and shows it again when it is reopened', await waitFor(() => store.get().spaces.find((s) => s.id === space)?.image === kept))
    browser.dispatch({ type: 'space/select', id: other })
    browser.dispatch({ type: 'space/delete', id: space })
    createdSpaces.splice(createdSpaces.indexOf(space), 1)
    check('picture: a deleted space takes its copy with it', await waitFor(() => stored().length === 0, 3000), JSON.stringify(stored()))
    browser.dispatch({ type: 'space/delete', id: other })
    createdSpaces.splice(createdSpaces.indexOf(other), 1)
    patch({ spaceImages: false })

    // =========================================================================================================
    // 4. The sidebar at the right
    // =========================================================================================================
    // A space again, with a tab to look at.
    browser.dispatch({ type: 'space/create', name: 'Miroir', emoji: '🪞', hue: 300 })
    createdSpaces.push(idOfSpace())
    const mirrorSpace = idOfSpace()
    browser.dispatch({ type: 'tab/open', url: `${base}/miroir` })
    const mirrorTab = store.get().tabs.at(-1)!
    await waitFor(() => tabViewOf(mirrorTab.id) !== undefined && browser.snapshot().runtime.tabs[mirrorTab.id]?.loading === false)
    browser.dispatch({ type: 'tab/open', url: `${base}/deux`, background: true })
    await sleep(500)

    const before = { aside: await rectOf(chrome, 'aside.sidebar'), card: tabViewOf(mirrorTab.id)!.getBounds(), toggle: await rectOf(chrome, '.sidebar .sidebar-toggle') }
    patch({ sidebarRight: true })
    await sleep(600)
    const mirrored = await evaluate<boolean>(chrome, `document.querySelector('.shell').classList.contains('sidebar-right')`)
    const aside2 = await rectOf(chrome, 'aside.sidebar')
    check('mirror: the window carries the mirror class', mirrored)
    check('mirror: the sidebar is at the right edge, 323 px wide, as high as the window', !!aside2 && near(aside2.x, W - 323, 0.6) && near(aside2.width, 323, 0.6) && near(aside2.height, H, 0.6), show(aside2))
    const card2 = tabViewOf(mirrorTab.id)!.getBounds()
    check('mirror: the page card is at the left (x = 10), ends where the sidebar starts, 10 px from the top margin and bottom', card2.x === PAGE_MARGIN && near(card2.x + card2.width, W - 323, 0) && near(card2.y, before.card.y, 0) && near(card2.height, before.card.height, 0), JSON.stringify(card2))
    check('mirror: the card is the mirror image of Arc\'s (same width and height)', card2.width === before.card.width && card2.height === before.card.height, `${card2.width}x${card2.height} vs ${before.card.width}x${before.card.height}`)
    const toggle2 = await rectOf(chrome, '.sidebar .sidebar-toggle')
    check('mirror: the sidebar button is at the right end of the sidebar\'s top row (the traffic lights are not in it)', !!toggle2 && near(toggle2.x + toggle2.width, W - 9, 1), show(toggle2))
    const bar = await rectOf(chrome, '.page-toolbar')
    const back2 = await rectOf(chrome, 'button[aria-label="Précédent"]')
    check('mirror: the toolbar spans the card, its first button starts after the traffic lights\' room', !!bar && near(bar.x, PAGE_MARGIN, 0.6) && near(bar.width, card2.width, 1) && !!back2 && back2.x >= LIGHTS_CLEARANCE - 1, `${show(bar)} | ${show(back2)}`)
    if (darwin) check('mirror: the traffic lights stay at the window\'s left edge, shown', browser.trafficLights().visible && browser.trafficLights().position.x === TRAFFIC_LIGHTS.x && browser.trafficLights().position.y === TRAFFIC_LIGHTS.y)
    const icon = await evaluate<string>(chrome, `getComputedStyle(document.querySelector('.sidebar .sidebar-toggle svg')).transform`)
    check('mirror: the sidebar glyph is flipped to point to the right', icon === 'matrix(-1, 0, 0, 1, 0, 0)', icon)
    // The footer is not mirrored: its buttons keep their order from left to right (the archive first, then « Lire plus tard », the downloads, the spaces, then +):
    // the mirror moves the sidebar, not its contents.
    const footer = await evaluate<{ a: Rect; order: Array<Rect | null>; firstIsArchive: boolean } | null>(chrome, `(() => { const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }; const a = box('aside.sidebar'); if (!a) return null; return { a, order: ['.footer-archive', '.footer-downloads', '.footer .spaces', '.footer-plus'].map((s) => box('aside.sidebar ' + s)), firstIsArchive: !!document.querySelector('aside.sidebar footer.footer > button')?.classList.contains('footer-archive') } })()`)
    const footerOrder = footer?.order ?? []
    const footerInOrder = !!footer && footerOrder.length === 4 && footerOrder.every((r) => r !== null) && footerOrder.every((r, i) => i === 0 || r!.x >= footerOrder[i - 1]!.x + footerOrder[i - 1]!.width - 0.5)
    const [archiveBox, , , plusBox] = footerOrder
    check('mirror: the footer\'s order is the same (the archive first at the left of the sidebar, then the downloads and the spaces, + at its right end)', footerInOrder && footer!.firstIsArchive && archiveBox!.x > footer!.a.x && archiveBox!.x < footer!.a.x + 60 && plusBox!.x + plusBox!.width <= footer!.a.x + footer!.a.width && plusBox!.x + plusBox!.width > footer!.a.x + footer!.a.width - 60, JSON.stringify(footer))

    // A real drag of the sidebar's edge (its left edge now) resizes it.
    const handle = await rectOf(chrome, '.sidebar .resize-handle')
    check('mirror: the resize handle is on the sidebar\'s left edge', !!handle && near(handle.x, W - 323, 1.2), show(handle))
    if (handle) {
      const start = centre(handle)
      mouse(chrome, 'mouseMove', start.x, 300)
      mouse(chrome, 'mouseDown', start.x, 300)
      for (const dx of [-15, -30, -45, -60]) {
        await sleep(30)
        mouse(chrome, 'mouseMove', start.x + dx, 300)
      }
      await sleep(60)
      mouse(chrome, 'mouseUp', start.x - 60, 300)
      check('mirror: dragging the edge to the left widens the sidebar by as much', await waitFor(() => near(settings().sidebarWidth, 323 + 60 - 0, 8)), String(settings().sidebarWidth))
      // The page card is laid out again from the new width.
      await waitFor(() => {
        const laidOut = tabViewOf(mirrorTab.id)!.getBounds()
        return near(laidOut.x + laidOut.width, W - settings().sidebarWidth, 0)
      })
      const widened = tabViewOf(mirrorTab.id)!.getBounds()
      check('mirror: ...and the page card follows (it ends where the sidebar starts)', near(widened.x + widened.width, W - settings().sidebarWidth, 0), JSON.stringify(widened))
      patch({ sidebarWidth: 323 })
      await sleep(300)
    }

    // The hover card stays inside the sidebar.
    const row = await rectOf(chrome, '.sidebar .tab', 0)
    check('mirror: a tab row is in the sidebar, for the check of its hover card', !!row)
    if (row) {
      mouse(chrome, 'mouseMove', W / 2, 500)
      await sleep(100)
      mouse(chrome, 'mouseMove', centre(row).x, centre(row).y)
      const shown = await waitFor(async () => (await rectOf(chrome, '.sidebar .hover-card')) !== null, 4000)
      const hover = await rectOf(chrome, '.sidebar .hover-card')
      const sb = await rectOf(chrome, 'aside.sidebar')
      check('mirror: the hover card of a tab opens inside the sidebar, not off its edge', shown && !!hover && !!sb && hover.x >= sb.x && hover.x + hover.width <= sb.x + sb.width + 0.5, `${show(hover)} in ${show(sb)}`)
      mouse(chrome, 'mouseMove', W / 4, 500)
      await sleep(200)
    }

    // The popovers that hang from the toolbar or the footer.
    browser.openOverlay({ panel: 'site' })
    await waitFor(async () => (await rectOf(ui, '.scc')) !== null, 4000)
    await sleep(600)
    const scc = await rectOf(ui, '.scc')
    check('mirror: the site control centre hangs from the toolbar, 3 px inside the card\'s right edge (the sidebar\'s edge)', !!scc && near(scc.x + scc.width, W - 323 - 3, 1.5), show(scc))
    browser.closeOverlay()
    await sleep(300)
    browser.openOverlay({ panel: 'downloads' })
    await waitFor(async () => (await rectOf(ui, '.dlpop')) !== null, 4000)
    const downloads = await rectOf(ui, '.dlpop')
    check('mirror: the downloads popover sits above the downloads button, inside the sidebar (8 px from its left edge)', !!downloads && near(downloads.x, W - 323 + 8, 1.5), show(downloads))
    browser.closeOverlay()
    await sleep(300)
    browser.openOverlay({ panel: 'theme', spaceId: mirrorSpace })
    await waitFor(() => ui.getURL().length > 0, 2000)
    await sleep(500)
    const themeBounds = overlayView.getBounds()
    check('mirror: the theme editor is beside the sidebar, at the card\'s right end', near(themeBounds.x + themeBounds.width, W - 323 - 12, 1), JSON.stringify(themeBounds))
    browser.closeOverlay()
    await sleep(300)

    // The sidebar hidden: the floating copy comes from the right edge, the traffic lights stay, the toolbar holds the button.
    patch({ sidebarVisible: false })
    await sleep(600)
    const hidden = tabViewOf(mirrorTab.id)!.getBounds()
    check('mirror: with the sidebar hidden the card spans the window (10 px each side)', hidden.x === PAGE_MARGIN && near(hidden.width, W - 2 * PAGE_MARGIN, 0), JSON.stringify(hidden))
    const edge = await rectOf(chrome, '.hot-edge')
    check('mirror: the strip that opens the floating sidebar is at the right edge', !!edge && near(edge.x + edge.width, W, 0.6), show(edge))
    const showButton = await rectOf(chrome, '.page-toolbar .tb-button.show-sidebar')
    const bar2 = await rectOf(chrome, '.page-toolbar')
    check('mirror: the toolbar\'s button for the sidebar ends the bar (at its right), not the start', !!showButton && !!bar2 && near(showButton.x + showButton.width, bar2.x + bar2.width - 5, 1), `${show(showButton)} in ${show(bar2)}`)
    if (darwin) check('mirror: the traffic lights are still shown with the sidebar hidden (they belong to the window)', browser.trafficLights().visible === true)
    mouse(chrome, 'mouseMove', W / 2, 400)
    await sleep(100)
    mouse(chrome, 'mouseMove', W - 1, 300)
    check('mirror: a real pointer at the right edge shows the floating sidebar', await waitFor(() => browser.isFloatingSidebarShown(), 3000))
    await sleep(500)
    const floating = win.contentView.children.map((v) => v as WebContentsView).find((v) => v.webContents.getURL().includes('#float'))
    const floatWidth = 323 + FLOATING_INSET + FLOAT_SHADOW
    check('mirror: the floating view is at the right edge, as wide as the panel plus its inset and shadow', floating?.getBounds().x === W - floatWidth && floating.getBounds().width === floatWidth && floating.getBounds().height === H, JSON.stringify(floating?.getBounds()))
    const floatCard = floating ? await rectOf(floating.webContents, '.floating-shell .sidebar') : null
    check('mirror: the panel is inset 5 px from the right, top and bottom edges', !!floatCard && near(floatCard.x + floatCard.width, floatWidth - FLOATING_INSET, 1) && near(floatCard.y, FLOATING_INSET, 1) && near(floatCard.height, H - 2 * FLOATING_INSET, 1.2), show(floatCard))
    const animation = floating ? await evaluate<string>(floating.webContents, `getComputedStyle(document.querySelector('.floating-shell .sidebar')).animationName`) : ''
    check('mirror: it slides in from the right (its own keyframes)', animation === 'float-in-right', animation)
    check('mirror: it covers the page without pushing it', tabViewOf(mirrorTab.id)!.getBounds().width === hidden.width)
    floating?.webContents.sendInputEvent({ type: 'mouseMove', x: 100, y: 300 })
    await sleep(100)
    floating?.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 400 })
    check('mirror: leaving it takes it away', await waitFor(() => !browser.isFloatingSidebarShown(), 3000))
    // The toolbar's button brings the sidebar back, with a real click.
    const again = await rectOf(chrome, '.page-toolbar .tb-button.show-sidebar')
    if (again) await clickRect(chrome, again)
    check('mirror: a click on the toolbar\'s button shows the sidebar again', await waitFor(() => settings().sidebarVisible === true, 3000))
    await sleep(500)

    // Back to the default side: everything where it was.
    patch({ sidebarRight: false })
    await sleep(600)
    const back3 = { aside: await rectOf(chrome, 'aside.sidebar'), card: tabViewOf(mirrorTab.id)!.getBounds(), toggle: await rectOf(chrome, '.sidebar .sidebar-toggle') }
    check('mirror: switched off, the sidebar and the page card are back where they were', JSON.stringify(back3.card) === JSON.stringify(before.card) && show(back3.aside) === show(before.aside) && show(back3.toggle) === show(before.toggle), `${JSON.stringify(back3.card)} ${show(back3.aside)} ${show(back3.toggle)}`)
    check('mirror: ...and so is the toolbar (first button 5 px after the sidebar)', near((await rectOf(chrome, 'button[aria-label="Précédent"]'))?.x, 323 + 5, 0.6))

    // =========================================================================================================
    // 5. Web panels
    // =========================================================================================================
    patch({ webPanels: true })
    browser.dispatch({ type: 'tab/open', url: `${base}/set-cookie` })
    const cookieTab = store.get().tabs.at(-1)!
    await waitFor(() => browser.snapshot().runtime.tabs[cookieTab.id]?.loading === false)
    await sleep(400)
    // The page is added from a tab on screen: the command bar's route (the interface asks the main process) …
    browser.dispatch({ type: 'tab/open', url: `${base}/wp-a` })
    const tabA = store.get().tabs.at(-1)!
    await waitFor(() => browser.snapshot().runtime.tabs[tabA.id]?.loading === false)
    await sleep(300)
    await evaluate(ui, `window.lucium.webPanel({ op: 'add' })`)
    await sleep(500)
    const listed = store.get().spaces.find((s) => s.id === mirrorSpace)?.webPanels ?? []
    check('panels: "Ajouter la page en volet web" (the interface\'s request) adds the page on screen to the space\'s list, under its title', listed.length === 1 && listed[0]!.url === `${base}/wp-a` && listed[0]!.title === 'Volet A', JSON.stringify(listed))
    // … and the same page again says it is already there.
    browser.addWebPanelFromPage()
    check('panels: adding it twice changes nothing and says so', (store.get().spaces.find((s) => s.id === mirrorSpace)?.webPanels ?? []).length === 1 && /déjà/.test(browser.snapshot().toast?.message ?? ''), browser.snapshot().toast?.message)
    browser.dispatch({ type: 'tab/open', url: `${base}/wp-cookie` })
    const tabCookie = store.get().tabs.at(-1)!
    await waitFor(() => browser.snapshot().runtime.tabs[tabCookie.id]?.loading === false)
    browser.addWebPanelFromPage()
    const listed2 = store.get().spaces.find((s) => s.id === mirrorSpace)?.webPanels ?? []
    check('panels: a second site joins the list', listed2.length === 2 && listed2[1]!.title === 'Volet cookie', JSON.stringify(listed2))
    const panelA = listed2[0]!
    const panelCookie = listed2[1]!

    // The menus list them.
    const menusOn = await recordMenus(() => showMenu({ kind: 'space', id: mirrorSpace }, browser, store, win))
    check('panels: the menu of the space lists "Ouvrir « Volet A » en volet" and the other entries of the submenu', menusOn.length === 1 && ['Volets web', frenchSpaces('Ouvrir « Volet A » en volet'), frenchSpaces('Ouvrir « Volet cookie » en volet'), 'Ajouter la page en volet web', 'Retirer un volet web', 'Fermer le volet web'].every((l) => menusOn[0]!.includes(l)), JSON.stringify(menusOn[0]))
    check('panels: the Espaces menu has the same submenu', await waitFor(() => appMenuHas('Volets web') && appMenuHas(frenchSpaces('Ouvrir « Volet A » en volet')), 4000))

    // Opening one through the command bar, with the real keyboard.
    browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
    await waitFor(async () => (await rectOf(ui, '.palette-input')) !== null, 4000)
    await typeKeys(ui, 'ouvrir')
    const offered = await waitFor(async () => (await evaluate<string>(ui, `document.querySelector('.results')?.textContent ?? ''`)).includes('Ouvrir Volet A en volet'), 4000)
    check('panels: the command bar offers "Ouvrir Volet A en volet" for "ouvrir"', offered)
    const candidate = await rectByText(ui, '.results li', 'Ouvrir Volet A en volet')
    if (candidate) await clickRect(ui, candidate)
    await waitFor(() => browser.snapshot().webPanel !== undefined && browser.snapshot().webPanel !== null, 4000)
    const openPanel = browser.snapshot().webPanel
    check('panels: choosing it opens the panel, and the command bar goes', openPanel?.id === panelA.id && openPanel?.title === 'Volet A' && !win.contentView.children.includes(overlayView), JSON.stringify(openPanel))
    await sleep(900)

    // Where it sits: a native view at the right, under the header strip; the page card gave up its room.
    // The panel's view is the one that is neither a tab's page, nor the panels layer, nor the floating sidebar.
    const panelViewsOf = () => {
      const tabWcs = new Set(store.get().tabs.map((t) => (browser.pageFor(t.id) as unknown as { webContents?: WebContents } | undefined)?.webContents?.id).filter((id): id is number => id !== undefined))
      return win.contentView.children.map((v) => v as WebContentsView).filter((v) => !tabWcs.has(v.webContents.id) && v.webContents.id !== overlayView.webContents.id && !v.webContents.getURL().includes('#float'))
    }
    const panelView = () => panelViewsOf().find((v) => v.webContents.getURL().startsWith(`${base}/wp-a`))
    const pv = panelView()
    check('panels: the site is loaded in a view of its own, not in a tab', !!pv && pv.webContents.getURL() === `${base}/wp-a`, pv?.webContents.getURL())
    const pb = pv?.getBounds()
    check('panels: the view is docked at the right: 10 px from the window edge, 400 px wide, under the 40 px header, down to the bottom margin', !!pb && pb.x === W - PAGE_MARGIN - 400 && pb.width === 400 && pb.y === PAGE_MARGIN + 40 && pb.y + pb.height === H - PAGE_MARGIN, JSON.stringify(pb))
    const activeView = tabViewOf(store.get().activeTabBySpace[mirrorSpace]!)?.getBounds()
    check('panels: the page card gave up 400 px and a margin on each side of the panel', !!activeView && activeView.x === 323 && activeView.x + activeView.width === W - 400 - 2 * PAGE_MARGIN, JSON.stringify(activeView))
    const headerStrip = await rectOf(chrome, '.side-panel-header')
    check('panels: the header strip is drawn above it with the site\'s title', !!headerStrip && near(headerStrip.width, 400, 0.6) && near(headerStrip.height, 40, 0.6) && (await textOf(chrome, '.side-panel-title')) === 'Volet A', show(headerStrip))

    // The session of the space's profile: its cookie is the panel's.
    const cookieSession = (browser.pageFor(tabCookie.id) as unknown as { webContents: WebContents }).webContents.session
    check('panels: the panel page uses the session of the space\'s profile (the tabs\' own)', pv?.webContents.session === cookieSession)
    browser.openWebPanel(panelCookie.id)
    await sleep(900)
    const cookieView = panelViewsOf().find((v) => v.webContents.getURL().startsWith(`${base}/wp-cookie`))
    let echoed = ''
    if (cookieView) {
      await waitFor(async () => (await evaluate<string>(cookieView.webContents, `document.body?.textContent ?? ''`)).includes(':fin'), 5000)
      echoed = decodeURIComponent(/cookie:(.*):fin/.exec(await evaluate<string>(cookieView.webContents, `document.body.textContent`))?.[1] ?? '')
    }
    check('panels: opening another site replaces the first (one panel at a time), and it sends the cookie a tab of the space was given', browser.snapshot().webPanel?.id === panelCookie.id && !panelView() && echoed.includes('spaces2=partage-par-le-profil'), `${browser.snapshot().webPanel?.id} | ${echoed}`)
    browser.openWebPanel(panelA.id)
    await sleep(700)

    // Resizing the panel with a real drag of its edge.
    const grip = await rectOf(chrome, '.side-panel-resize')
    check('panels: a resize handle sits on the panel\'s left edge', !!grip && near(grip.x + grip.width, W - PAGE_MARGIN - 400, 9), show(grip))
    if (grip) {
      const start = centre(grip)
      mouse(chrome, 'mouseMove', start.x, 300)
      mouse(chrome, 'mouseDown', start.x, 300)
      for (const dx of [-15, -30, -45, -60]) {
        await sleep(30)
        mouse(chrome, 'mouseMove', start.x + dx, 300)
      }
      await sleep(60)
      mouse(chrome, 'mouseUp', start.x - 60, 300)
      await sleep(500)
      const width = settings().sidePanelWidth
      const resized = panelView()?.getBounds()
      check('panels: dragging the edge to the left widens the panel (the view follows)', width > 440 && width <= 470 && resized?.width === width && resized.x === W - PAGE_MARGIN - width, `${width} ${JSON.stringify(resized)}`)
      patch({ sidePanelWidth: 400 })
      await sleep(300)
    }

    // The hooks of any page: a script cannot take the panel to a file, and a link that wants a window gets a tab.
    const wcA = panelView()!.webContents
    // The witness: after the navigation to a file, the page asks for one to a web address of its own, which is stopped here before it loads.
    // A page's navigations reach the browser in the order it asks for them: once the witness is there, the one before it has arrived too (what
    // nothing refused of it is noted), or it was stopped inside the page.
    const witnessUrl = `${base}/wp-witness`
    const letThrough: string[] = []
    let witnessed = false
    const onNavigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
      if (witnessed || !event.isMainFrame) return
      if (event.url === witnessUrl) {
        witnessed = true
        event.preventDefault()
      } else if (!event.defaultPrevented) letThrough.push(event.url)
    }
    wcA.on('will-frame-navigate', onNavigate)
    try {
      await evaluate(wcA, `location.href = 'file:///etc/hosts'`)
      await evaluate(wcA, `location.href = ${JSON.stringify(witnessUrl)}`)
      await waitFor(() => witnessed)
    } finally {
      wcA.off('will-frame-navigate', onNavigate)
    }
    check('panels: the page cannot navigate itself to a file: address (it stays where it was)', witnessed && letThrough.length === 0 && wcA.getURL() === `${base}/wp-a`, `${wcA.getURL()}; the witness came: ${witnessed}; let through before it: ${JSON.stringify(letThrough)}`)
    const tabsBefore = store.get().tabs.length
    const link = await rectOf(wcA, '#l')
    if (link) await clickRect(wcA, link)
    check('panels: a link that opens a new window becomes a tab of the space, the panel stays', await waitFor(() => store.get().tabs.length === tabsBefore + 1 && store.get().tabs.at(-1)!.url === `${base}/wp-b` && store.get().tabs.at(-1)!.spaceId === mirrorSpace, 4000) && browser.snapshot().webPanel?.id === panelA.id)
    const material = selfSignedCertificate()
    check('panels: openssl is there to make a self-signed certificate for the test', material !== null)
    if (material) {
      const tls = createHttpsServer(material, (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<title>page sécurisée</title><body>contenu du site non vérifié</body>')
      })
      secure.push(tls)
      await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve))
      const secureUrl = `https://127.0.0.1:${(tls.address() as AddressInfo).port}/`
      browser.dispatch({ type: 'space/panel-add', id: mirrorSpace, panelId: 'tls', url: secureUrl, title: 'Certificat' })
      browser.openWebPanel('tls')
      await sleep(1500)
      const tlsView = panelViewsOf()[0]
      const body = tlsView ? await waitFor(async () => (await evaluate<string>(tlsView.webContents, `document.body?.innerText ?? ''`).catch(() => '')).includes('Votre connexion n’est pas privée'), 8000) : false
      const tlsText = tlsView ? await evaluate<string>(tlsView.webContents, `document.body?.innerText ?? ''`).catch(() => '') : ''
      check('panels: a site with an untrusted certificate shows the application\'s warning page, and nothing of the site', body && !tlsText.includes('contenu du site non vérifié'), tlsText.slice(0, 200))
      browser.dispatch({ type: 'space/panel-remove', id: mirrorSpace, panelId: 'tls' })
      check('panels: removing a site from the list closes its panel', await waitFor(() => browser.snapshot().webPanel === undefined))
    }

    // The engine refuses to load the site: the panel is undone, the notice says so, the log names the cause.
    const realCreate = ctx.engine.createPage.bind(ctx.engine)
    ctx.engine.createPage = ((opts: Parameters<typeof realCreate>[0], events: Parameters<typeof realCreate>[1]) => {
      const page = realCreate(opts, events)
      if (opts.id.includes('webpanel')) {
        page.loadURL = () => {
          throw new Error('forced: the engine refused the address')
        }
      }
      return page
    }) as typeof ctx.engine.createPage
    const engineLog: string[] = []
    const realEngineError = console.error
    console.error = (...args: unknown[]) => void engineLog.push(args.map(String).join(' '))
    const viewsBefore = win.contentView.children.length
    try {
      browser.openWebPanel(panelA.id)
      await sleep(500)
    } finally {
      console.error = realEngineError
      ctx.engine.createPage = realCreate as typeof ctx.engine.createPage
    }
    check('panels: a site the engine refuses to load is not left half open (no panel, no view), the notice says which, the log names the cause', browser.snapshot().webPanel === undefined && win.contentView.children.length === viewsBefore && /n’a pas pu s’ouvrir/.test(browser.snapshot().toast?.message ?? '') && engineLog.some((l) => l.includes('forced: the engine refused the address')), `${browser.snapshot().toast?.message} | ${engineLog.join(' / ').slice(0, 200)}`)
    // A request that makes no sense is ignored, and said so.
    const ignored: string[] = []
    const realIgnoreWarn = console.warn
    console.warn = (...args: unknown[]) => void ignored.push(args.map(String).join(' '))
    try {
      await evaluate(chrome, `window.lucium.webPanel({ op: 'remove', panelId: ${JSON.stringify(panelA.id)} })`)
      await evaluate(chrome, `window.lucium.webPanel('open')`)
      await sleep(300)
    } finally {
      console.warn = realIgnoreWarn
    }
    check('panels: a request that is not "open" or "add" does nothing, and the log says it was ignored', ignored.filter((l) => l.includes('web panel request')).length === 2 && browser.snapshot().webPanel === undefined && (store.get().spaces.find((s) => s.id === mirrorSpace)?.webPanels ?? []).length === 2, JSON.stringify(ignored))

    // Closing: the header's cross, with a real click.
    browser.openWebPanel(panelA.id)
    await sleep(700)
    const cross = await rectOf(chrome, '.side-panel-header button')
    if (cross) await clickRect(chrome, cross)
    check('panels: the header\'s ✕ closes the panel, destroys its view and gives the room back', (await waitFor(() => browser.snapshot().webPanel === undefined, 3000)) && !panelView() && (await rectOf(chrome, '.side-panel-header')) === null && tabViewOf(store.get().activeTabBySpace[mirrorSpace]!)?.getBounds().width === W - 323 - PAGE_MARGIN)
    // Opening the open one again puts it away; another space, the function off: also.
    browser.openWebPanel(panelA.id)
    await sleep(500)
    browser.openWebPanel(panelA.id)
    check('panels: choosing the open site again closes it', await waitFor(() => browser.snapshot().webPanel === undefined, 3000))
    browser.openWebPanel(panelA.id)
    await sleep(500)
    browser.dispatch({ type: 'space/create', name: 'Ailleurs', emoji: '🧭', hue: 10 })
    createdSpaces.push(idOfSpace())
    check('panels: going to another space closes the panel (its list and its session belong to the first space)', await waitFor(() => browser.snapshot().webPanel === undefined, 3000))
    const ailleurs = idOfSpace()
    const otherMenus = await recordMenus(() => showMenu({ kind: 'space', id: ailleurs }, browser, store, win))
    check('panels: a space without sites still offers to add one (and nothing to open)', otherMenus[0]?.includes('Volets web') === true && !otherMenus[0]!.some((l) => l.startsWith('Ouvrir «')), JSON.stringify(otherMenus[0]))
    browser.dispatch({ type: 'space/select', id: mirrorSpace })
    browser.openWebPanel(panelA.id)
    await sleep(500)
    patch({ webPanels: false })
    check('panels: switching the function off closes the panel and hides every entry', (await waitFor(() => browser.snapshot().webPanel === undefined, 3000)) && !(await recordMenus(() => showMenu({ kind: 'space', id: mirrorSpace }, browser, store, win))).flat().includes('Volets web'))
    // No wait: openWebPanel decides before it returns (browser-panels.ts), and a panel it opens is in the snapshot at once.
    browser.openWebPanel(panelA.id)
    check('panels: ...and a request while it is off opens nothing', browser.snapshot().webPanel === undefined && browser.snapshot().toast?.message === webPanelsOff())
    check('panels: the list is kept for when the function comes back', (store.get().spaces.find((s) => s.id === mirrorSpace)?.webPanels ?? []).length === 2)

    // The dock mirrored: with the sidebar at the right the panel is at the left.
    patch({ webPanels: true, sidebarRight: true })
    await sleep(500)
    browser.dispatch({ type: 'space/select', id: mirrorSpace })
    browser.openWebPanel(panelA.id)
    await sleep(900)
    const pbm = panelView()?.getBounds()
    check('mirror + panels: the panel is docked at the left (x = 10), 400 px wide, under the header', !!pbm && pbm.x === PAGE_MARGIN && pbm.width === 400 && pbm.y === PAGE_MARGIN + 40, JSON.stringify(pbm))
    const cardM = tabViewOf(store.get().activeTabBySpace[mirrorSpace]!)?.getBounds()
    check('mirror + panels: the page card sits between the panel and the sidebar', !!cardM && cardM.x === PAGE_MARGIN + 400 + PAGE_MARGIN && cardM.x + cardM.width === W - 323, JSON.stringify(cardM))
    const headerM = await rectOf(chrome, '.side-panel-header')
    const titleM = await rectOf(chrome, '.side-panel-title')
    check('mirror + panels: the header is above the panel and its title starts after the traffic lights\' room', !!headerM && near(headerM.x, 8, 2) && !!titleM && titleM.x >= LIGHTS_CLEARANCE - 1, `${show(headerM)} | ${show(titleM)}`)
    const gripM = await rectOf(chrome, '.side-panel-resize')
    check('mirror + panels: the resize handle is on the panel\'s right edge', !!gripM && near(gripM.x, PAGE_MARGIN + 400, 9), show(gripM))
    if (gripM) {
      const start = centre(gripM)
      mouse(chrome, 'mouseMove', start.x, 300)
      mouse(chrome, 'mouseDown', start.x, 300)
      for (const dx of [15, 30, 45, 60]) {
        await sleep(30)
        mouse(chrome, 'mouseMove', start.x + dx, 300)
      }
      await sleep(60)
      mouse(chrome, 'mouseUp', start.x + 60, 300)
      check('mirror + panels: dragging the edge to the right widens the panel', await waitFor(() => settings().sidePanelWidth > 440 && panelView()?.getBounds().width === settings().sidePanelWidth), String(settings().sidePanelWidth))
      patch({ sidePanelWidth: 400 })
    }
    browser.closeWebPanel()
    await waitFor(() => browser.snapshot().webPanel === undefined)
    // The state of the list: robust when it is replaced by a hostile one through the shell's own restore.
    check('state: STATE_VERSION is unchanged and the list is plain data', store.get().version === 1)
    patch({ sidebarRight: false })
    // Only lets the window lay itself out again before the suites that follow: no check reads it.
    await sleep(400)
  } finally {
    setImageChooserForTest(null)
    browser.closeWebPanel()
    browser.closeOverlay()
    for (const s of secure) s.close()
    for (const id of [...createdSpaces].reverse()) {
      if (store.get().spaces.some((s) => s.id === id) && store.get().spaces.length > 1) {
        if (store.get().activeSpaceId === id) browser.dispatch({ type: 'space/select', id: previousSpace })
        browser.dispatch({ type: 'space/delete', id })
      }
    }
    browser.dispatch({ type: 'space/select', id: previousSpace })
    patch({
      sidebarVisible: original.sidebarVisible,
      sidebarWidth: original.sidebarWidth,
      sidePanelWidth: original.sidePanelWidth,
      showToolbar: original.showToolbar,
      hoverCards: original.hoverCards,
      sleepAfterMinutes: original.sleepAfterMinutes,
      sidebarRight: original.sidebarRight,
      spaceImages: original.spaceImages,
      webPanels: original.webPanels
    })
    win.setBounds(savedBounds)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(work, { recursive: true, force: true })
  }
  // Nothing of the test is left in the data folder.
  check('cleanup: no picture is left in the data folder', !existsSync(picturesDir) || readdirSync(picturesDir).length === 0, existsSync(picturesDir) ? readdirSync(picturesDir).join() : 'no folder')
}

/** `LUCIUM_SMOKE_ONLY=spaces2`: only these checks, with their own report. */
export async function runSpaces2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeSpaces2(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeSpaces2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SPACES2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
