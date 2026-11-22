// Engine checks for download and reading functions, run inside a real Electron against a local server:
//   pause and resume (real clicks on the buttons of the popover, a slow big file, an interrupted file the server can continue),
//   asking where to save (the save box is answered by the test), "Ouvrir avec…" remembered by type of file,
//   opening a link without keeping the file (temporary folder, swept), PDF with the address (File menu),
//   folders in the read-later list (real clicks, dragged pages), and the groups of Settings › Fichiers et données that hold the switches.
// Every function is off by default and the checks start from that. The system's boxes and the opening of files are replaced by the
// test (setDownloadUi), the way smoke-markdown replaces its dialogs. Called from the engine smoke test: `await smokeDownloads2(ctx, check)`.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { app, BrowserWindow as ElectronWindow, Menu, type MenuItem, type WebContents } from 'electron'
import type { DownloadInfo, Settings } from '@shared/model'
import { parseSavedState } from '@shared/sidebar'
import { stagingRootFor } from './engine/download-staging'
import type { ExecutableRequest, SaveRequest } from './engine/types'
import { menuItems } from './shell/context-menus'
import { setDownloadUi } from './shell/download-ui'
import { getWindowManager } from './shell/windows'
import type { SmokeContext } from './smoke'
import { noteCheck, OPEN_MORE_SETTINGS, skippedBecause, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void
interface Rect {
  x: number
  y: number
  width: number
  height: number
}


const waitFor = waiterOf(10_000, 60)

const CHUNK = 64 * 1024
const BIG_CHUNKS = 40
/** A file the server hands out slowly, whose bytes tell which chunk they come from. */
const BIG = Buffer.concat(Array.from({ length: BIG_CHUNKS }, (_, i) => Buffer.alloc(CHUNK, (i * 7 + 3) % 256)))
const FLAKY = Buffer.concat(Array.from({ length: 8 }, (_, i) => Buffer.alloc(CHUNK, (i * 11 + 5) % 256)))
const DOC = Buffer.from(`%PDF-1.4\n${'a document that is not kept\n'.repeat(40)}%%EOF\n`)
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

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

export async function smokeDownloads2(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  const ui = overlayView.webContents
  const state = () => store.get()
  const settingsNow = (): Settings => state().settings
  const evaluate = <T>(wc: WebContents, script: string) => wc.executeJavaScript(script) as Promise<T>
  const rectOf = (wc: WebContents, selector: string, index = 0) =>
    evaluate<Rect | null>(wc, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const textOf = (wc: WebContents, selector: string) => evaluate<string>(wc, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const countOf = (wc: WebContents, selector: string) => evaluate<number>(wc, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  /** A real click at the middle of the element, as a person would make it. */
  const clickOn = async (wc: WebContents, selector: string, index = 0): Promise<boolean> => {
    const r = await rectOf(wc, selector, index)
    if (!r) return false
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    mouse(wc, 'mouseMove', x, y)
    mouse(wc, 'mouseDown', x, y)
    mouse(wc, 'mouseUp', x, y)
    await sleep(120)
    return true
  }
  const typeText = async (wc: WebContents, text: string) => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch === ' ' ? 'Space' : ch })
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch === ' ' ? 'Space' : ch })
      await sleep(35)
    }
    await sleep(120)
  }
  const pressKey = async (wc: WebContents, keyCode: string) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(120)
  }

  // ---- the server: a big slow file, a file the server can continue, a document, hostile names, a program ----
  const hits: string[] = []
  const ranges: Array<string | undefined> = []
  /** Connections of /flaky.bin still to drop: Chromium resumes an interrupted download five times by itself, and leaves it interrupted after that. */
  let flakyDrops = 6
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    hits.push(path)
    if (path === '/big.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG.length, 'content-disposition': 'attachment; filename="big.bin"', etag: '"big-1"' })
      let sent = 0
      const timer = setInterval(() => {
        if (res.destroyed || sent >= BIG_CHUNKS) {
          clearInterval(timer)
          if (!res.destroyed) res.end()
          return
        }
        res.write(BIG.subarray(sent * CHUNK, (sent + 1) * CHUNK))
        sent++
      }, 110)
      res.on('close', () => clearInterval(timer))
      return
    }
    if (path === '/flaky.bin') {
      const range = req.headers.range
      ranges.push(range)
      const base = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag: '"flaky-1"', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT', 'content-disposition': 'attachment; filename="flaky.bin"' }
      const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
      const code = from > 0 ? 206 : 200
      const headers = from > 0 ? { ...base, 'content-length': FLAKY.length - from, 'content-range': `bytes ${from}-${FLAKY.length - 1}/${FLAKY.length}` } : { ...base, 'content-length': FLAKY.length }
      res.writeHead(code, headers)
      if (flakyDrops > 0) {
        flakyDrops--
        // The connection drops after one more chunk: the download is interrupted, and the server can go on from where it stopped.
        res.write(FLAKY.subarray(from, from + CHUNK))
        setTimeout(() => res.destroy(), 150)
        return
      }
      return void res.end(FLAKY.subarray(from))
    }
    if (path === '/doc.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': DOC.length, 'content-disposition': 'attachment; filename="doc.pdf"' })
      return void res.end(DOC)
    }
    if (path === '/evil-name') {
      // A name with the character that reorders text on screen, as the page can make it.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''rep%E2%80%AEort.txt" })
      return void res.end('evil name')
    }
    if (path === '/prog.sh') {
      res.writeHead(200, { 'content-type': 'application/x-sh', 'content-disposition': 'attachment; filename="prog.sh"' })
      return void res.end('#!/bin/sh\necho never run\n')
    }
    if (path === '/run.sh') {
      res.writeHead(200, { 'content-type': 'application/x-sh', 'content-disposition': 'attachment; filename="run.sh"' })
      return void res.end('#!/bin/sh\necho never run\n')
    }
    if (path === '/warn.sh') {
      res.writeHead(200, { 'content-type': 'application/x-sh', 'content-disposition': 'attachment; filename="warn.sh"' })
      return void res.end('#!/bin/sh\necho never run\n')
    }
    if (path === '/photo.jpg') {
      // A harmless name on a program: the server says what it is.
      res.writeHead(200, { 'content-type': 'application/x-sh', 'content-disposition': 'attachment; filename="photo.jpg"' })
      return void res.end('#!/bin/sh\n')
    }
    if (path === '/traversal') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="../../escape-from-staging.txt"' })
      return void res.end('traversal')
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>Page de test des téléchargements</title><body style="margin:0"><h1>Téléchargements</h1><a id="doc" href="/doc.pdf" style="display:block;width:300px;height:40px">document</a></body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- what the engine test replaces: the boxes of the system and the opening of files ----
  const calls = { save: [] as SaveRequest[], warn: [] as ExecutableRequest[], chooseApp: [] as string[], openFile: [] as string[], openWith: [] as Array<[string, string]> }
  /** What the person answers to the warning before a file that can run is saved (true: « Enregistrer »; false: « Annuler »). */
  let warnAnswer = false
  let saveAnswer: (request: SaveRequest) => string | null | Promise<string | null> = () => null
  let chosenApplication: string | null = '/Applications/Preview.app'
  const restoreUi = setDownloadUi({
    chooseSave: async (_win, request) => {
      calls.save.push(request)
      return saveAnswer(request)
    },
    confirmExecutable: async (_win, request) => {
      calls.warn.push(request)
      return warnAnswer
    },
    chooseApplication: async (_win, name) => {
      calls.chooseApp.push(name)
      return chosenApplication
    },
    openFile: async (path) => {
      calls.openFile.push(path)
      return ''
    },
    openWith: async (appPath, file) => {
      calls.openWith.push([appPath, file])
      return { ok: true }
    }
  })
  const errors: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    realError(...args)
  }

  // ---- the places: the folder of the profile's downloads is a folder of the test ----
  const root = mkdtempSync(join(tmpdir(), 'downloads2-'))
  const profileFolder = join(root, 'profile')
  mkdirSync(profileFolder)
  const stagingRoot = stagingRootFor(app.getPath('userData'), app.getPath('temp'))
  const profilesBefore = settingsNow().profiles
  const original: Partial<Settings> = { profiles: profilesBefore }
  const patch = (changes: Partial<Settings>) => {
    for (const key of Object.keys(changes) as Array<keyof Settings>) if (!(key in original)) (original as Record<string, unknown>)[key] = structuredClone(settingsNow()[key])
    browser.dispatch({ type: 'settings/update', patch: changes })
  }
  patch({ profiles: { ...profilesBefore, default: { ...profilesBefore['default'], downloadDir: profileFolder } } })
  const seen: DownloadInfo[] = []
  let listening = true
  engine.onDownload((download) => {
    if (listening) seen.push(download)
  })

  const mine = new Set<string>()
  const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  browser.dispatch({ type: 'tab/open', url: `${base}/page` })
  const tab = state().tabs.at(-1)!
  mine.add(tab.id)
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  await waitFor(() => wcOf(tab.id) !== undefined && browser.snapshot().runtime.tabs[tab.id]?.loading === false)
  const page = wcOf(tab.id)!
  const downloadsNow = () => browser.snapshot().downloads
  const dlById = (id: string) => downloadsNow().find((d) => d.id === id)
  /** Starts a download from the page of the test and answers its id once the browser lists it. */
  const start = async (path: string, via: 'url' | 'menu' = 'url'): Promise<string | null> => {
    const known = new Set(downloadsNow().map((d) => d.id))
    if (via === 'url') page.downloadURL(`${base}${path}`)
    return (await waitFor(() => downloadsNow().some((d) => !known.has(d.id)), 8000)) ? downloadsNow().find((d) => !known.has(d.id))!.id : null
  }
  const finished = (id: string, timeout = 15_000) => waitFor(() => (dlById(id)?.state ?? 'progressing') !== 'progressing', timeout)
  const openPopover = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'downloads' })
      if (await waitFor(async () => (await rectOf(ui, '.dlpop')) !== null, 2500)) break
    }
    await sleep(300)
  }
  // The popover may hold the rows of other suites (the chain runs in one process): what is counted, read and clicked is the row of a file by its name.
  const rowOf = (filename: string) => `[...document.querySelectorAll('.dlpop-row')].find((row) => row.querySelector('.dlpop-name')?.textContent === ${JSON.stringify(filename)})`
  const buttonsInRow = (filename: string, action: 'pause' | 'resume') => evaluate<number>(ui, `(${rowOf(filename)})?.querySelectorAll('.dlpop-button[data-action="${action}"]').length ?? -1`)
  const statusInRow = (filename: string) => evaluate<string>(ui, `(${rowOf(filename)})?.querySelector('.dlpop-status')?.textContent ?? ''`)
  /** A real click on the button of a row, as clickOn does. */
  const clickInRow = async (filename: string, action: 'pause' | 'resume'): Promise<boolean> => {
    const r = await evaluate<Rect | null>(ui, `(() => { const b = (${rowOf(filename)})?.querySelector('.dlpop-button[data-action="${action}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    if (!r) return false
    mouse(ui, 'mouseMove', r.x + r.width / 2, r.y + r.height / 2)
    mouse(ui, 'mouseDown', r.x + r.width / 2, r.y + r.height / 2)
    mouse(ui, 'mouseUp', r.x + r.width / 2, r.y + r.height / 2)
    await sleep(120)
    return true
  }

  /** A page menu on a link, captured (a native menu cannot be clicked): returns what it holds and a way to choose an entry. */
  const linkMenu = async (linkURL: string) => {
    const real = Menu.prototype.popup
    let captured: Menu | null = null
    Menu.prototype.popup = function (this: Menu) {
      captured = this
      return this
    } as never
    try {
      page.emit('context-menu', {}, { linkURL, mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', x: 5, y: 5, misspelledWord: '', dictionarySuggestions: [] })
    } finally {
      Menu.prototype.popup = real
    }
    const menu = captured as Menu | null
    return { labels: menu ? menu.items.map((i) => i.label) : [], choose: (label: string) => menu?.items.find((i) => i.label === label)?.click({} as never, undefined, undefined) }
  }
  /** The menu of a row of the downloads popover, built the way the right-click builds it. */
  const downloadMenu = async (id: string) => {
    const items = menuItems({ kind: 'download', id }, browser, store, win)
    return { labels: items.map((i) => i.label ?? ''), item: (label: string) => items.find((i) => i.label === label) }
  }

  try {
    // ====================================================================================================================
    // Everything is off by default: the popover and the menus are the default ones
    // ====================================================================================================================
    const defaults = ['downloadPause', 'downloadAskWhere', 'openWithMemory', 'openUnsaved', 'pdfWithSource', 'useReadLaterFolders'] as const
    check('downloads2: the six functions are off by default', defaults.every((key) => settingsNow()[key] === false) && Object.keys(settingsNow().openWithApps).length === 0, JSON.stringify(defaults.map((k) => [k, settingsNow()[k]])))

    // ====================================================================================================================
    // pause and resume
    // ====================================================================================================================
    // Downloads of earlier suites are not this suite's business: their rows (an interrupted file can have a resume button) would be counted with ours.
    for (const stale of downloadsNow()) browser.clearDownload(stale.id)
    const slowId = await start('/big.bin')
    const slowName = 'big.bin'
    check('pause: a big slow file starts and the popover lists it', slowId !== null && (await waitFor(() => (dlById(slowId!)?.receivedBytes ?? 0) > 0)), String(slowId))
    await openPopover()
    check('pause: with the setting off the row has no pause button (Arc’s popover)', slowId !== null && (await buttonsInRow(slowName, 'pause')) === 0 && (await buttonsInRow(slowName, 'resume')) === 0)
    await win.webContents.executeJavaScript(`window.lucium.downloadAction(${JSON.stringify(slowId)}, 'pause')`)
    const grew1 = dlById(slowId!)?.receivedBytes ?? 0
    // The witness: the request is a message without an answer; a question asked after it on the same channel is answered only once the main
    // process has handled it, and a pause it let through marks the row at once (engine/electron-engine-downloads.ts, `pauseDownload`).
    await win.webContents.executeJavaScript('window.lucium.getSnapshot().then(() => 0)')
    const notPaused = dlById(slowId!)?.paused !== true
    const keptComing = await waitFor(() => (dlById(slowId!)?.receivedBytes ?? 0) > grew1)
    check('pause: ...and a request for it, from the interface, does nothing: the file keeps coming', notPaused && keptComing && dlById(slowId!)?.paused !== true, `${grew1} -> ${dlById(slowId!)?.receivedBytes}`)

    patch({ downloadPause: true })
    check('pause: with the setting on the row shows a pause button', await waitFor(async () => (await buttonsInRow(slowName, 'pause')) === 1, 4000))
    check('pause: a real click on it stops the file (the row says "En pause", the bytes stop growing)', (await clickInRow(slowName, 'pause')) && (await waitFor(() => dlById(slowId!)?.paused === true, 4000)))
    // What was already on its way when the pause came is still delivered; after that, nothing.
    await sleep(500)
    const stopped = dlById(slowId!)?.receivedBytes ?? 0
    // A fixed wait, for want of a witness: that no byte comes for a while is what is checked.
    await sleep(900)
    check('pause: ...and it stays stopped', (dlById(slowId!)?.receivedBytes ?? 0) === stopped && dlById(slowId!)?.state === 'progressing', `${stopped} -> ${dlById(slowId!)?.receivedBytes}`)
    check('pause: the popover shows "En pause", the resume button and not the pause one', (await waitFor(async () => (await statusInRow(slowName)).startsWith('En pause'), 3000)) && (await buttonsInRow(slowName, 'resume')) === 1 && (await buttonsInRow(slowName, 'pause')) === 0, `${await statusInRow(slowName)} / resume ${await buttonsInRow(slowName, 'resume')} / pause ${await buttonsInRow(slowName, 'pause')}`)
    check('pause: the menu of the row offers "Reprendre le téléchargement" and not "Mettre en pause"', await (async () => { const menu = await downloadMenu(slowId!); return menu.labels.includes('Reprendre le téléchargement') && !menu.labels.includes('Mettre en pause') })())
    check('pause: a real click on resume lets it go on to the end, byte for byte', (await clickInRow(slowName, 'resume')) && (await finished(slowId!, 25_000)) && dlById(slowId!)?.state === 'completed' && sha(readFileSync(dlById(slowId!)!.path)) === sha(BIG), JSON.stringify(dlById(slowId!)))
    check('pause: a download that ended has neither button', (await waitFor(async () => (await buttonsInRow(slowName, 'pause')) === 0 && (await buttonsInRow(slowName, 'resume')) === 0, 3000)), `pause ${await buttonsInRow(slowName, 'pause')} / resume ${await buttonsInRow(slowName, 'resume')} / state ${dlById(slowId!)?.state}`)

    // Turning the setting off while a file is paused lets it go on: nothing is left without a button to end its pause.
    const heldId = await start('/big.bin')
    await waitFor(() => (dlById(heldId!)?.receivedBytes ?? 0) > 0)
    browser.pauseDownload(heldId!)
    check('pause: the main process pauses a download when the setting is on', await waitFor(() => dlById(heldId!)?.paused === true, 4000))
    patch({ downloadPause: false })
    check('pause: turning the setting off lifts the pause, and the file ends', (await waitFor(() => dlById(heldId!)?.paused !== true, 4000)) && (await finished(heldId!, 25_000)) && dlById(heldId!)?.state === 'completed')

    // An interrupted file that the server can continue is resumed from where it stopped (a Range request), never from the start.
    patch({ downloadPause: true })
    const flakyId = await start('/flaky.bin')
    // The state read at the instant of the last drop may still be the one of the attempt before it: wait for the sixth request, let its connection drop, and look then.
    const interrupted = (await waitFor(() => flakyDrops === 0 && ranges.length >= 6, 25_000)) && (await sleep(1500), await waitFor(() => dlById(flakyId!)?.state === 'interrupted' && dlById(flakyId!)?.resumable === true, 15_000))
    check('pause: a dropped connection leaves the download interrupted and resumable', interrupted && dlById(flakyId!)?.resumable === true, JSON.stringify(dlById(flakyId!)))
    if (interrupted && dlById(flakyId!)?.resumable) {
      check('pause: the row says it can go on and offers the resume button', (await waitFor(async () => (await statusInRow('flaky.bin')).includes('peut reprendre'), 4000)) && (await buttonsInRow('flaky.bin', 'resume')) === 1)
      await clickInRow('flaky.bin', 'resume')
      // `finished` would answer at once: an interrupted download is not running. Wait for the end that matters.
      const done = await waitFor(() => dlById(flakyId!)?.state === 'completed', 20_000)
      check('pause: a real click on resume continues with a Range request and the file is whole', done && dlById(flakyId!)?.state === 'completed' && ranges.length >= 7 && ranges.at(-1)?.startsWith('bytes=') === true && sha(readFileSync(dlById(flakyId!)!.path)) === sha(FLAKY), JSON.stringify({ ranges, state: dlById(flakyId!)?.state, drops: flakyDrops }))
    }
    patch({ downloadPause: false })
    browser.closeOverlay()
    // ====================================================================================================================
    // asking where to save
    // ====================================================================================================================
    const plainId = await start('/doc.pdf')
    check('ask: with the setting off a file goes straight to the folder of the profile, with no question (Arc)', plainId !== null && (await finished(plainId)) && calls.save.length === 0 && dlById(plainId!)?.path === join(profileFolder, 'doc.pdf') && sha(readFileSync(join(profileFolder, 'doc.pdf'))) === sha(DOC), JSON.stringify(dlById(plainId!)))
    check('ask: ...and the temporary folder was not touched', !existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0)
    // Electron writes no "downloaded from the Internet" mark itself (download-quarantine.ts): a finished file must carry it before anyone opens it.
    if (process.platform === 'darwin' && plainId !== null) {
      const mark = (() => {
        try {
          return execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', dlById(plainId)!.path], { encoding: 'utf8' })
        } catch (error) {
          return `error: ${(error as Error).message}`
        }
      })()
      check('quarantine: a finished download carries the quarantine mark of macOS, written by Lucium', /^0083;[0-9a-f]+;Lucium;[0-9A-F-]{36}\n$/.test(mark), mark)
    }
    const profileFiles = () => readdirSync(profileFolder).sort().join()
    const filesAtStart = profileFiles()

    patch({ downloadAskWhere: true })
    const chosenPath = join(root, 'chosen', 'deeper', 'Mon document.pdf')
    saveAnswer = () => chosenPath
    seen.length = 0
    const askedId = await start('/doc.pdf')
    check('ask: with it on the box is asked once, with the clean name and the folder of the profile', askedId !== null && (await waitFor(() => calls.save.length === 1)) && calls.save[0]!.filename === 'doc.pdf' && calls.save[0]!.folder === profileFolder && calls.save[0]!.url.endsWith('/doc.pdf'), JSON.stringify(calls.save))
    check('ask: ...the file lands where the user put it (folders made), whole, under the name they gave', (await finished(askedId!)) && dlById(askedId!)?.state === 'completed' && dlById(askedId!)?.path === chosenPath && dlById(askedId!)?.filename === 'Mon document.pdf' && sha(readFileSync(chosenPath)) === sha(DOC), JSON.stringify(dlById(askedId!)))
    check('ask: ...while they were asked it waited in the temporary folder, not in the downloads', seen.filter((d) => d.id === askedId).some((d) => d.path.startsWith(`${stagingRoot}/`)) && profileFiles() === filesAtStart)
    check('ask: ...and nothing is left in the temporary folder', await waitFor(() => !existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, 3000))

    saveAnswer = () => null
    const gaveUp = await start('/doc.pdf')
    check('ask: giving up cancels the download and leaves no file', (await finished(gaveUp!)) && dlById(gaveUp!)?.state === 'cancelled' && profileFiles() === filesAtStart && (await waitFor(() => !existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, 3000)))

    errors.length = 0
    saveAnswer = () => {
      throw new Error('the box exploded')
    }
    const broken = await start('/doc.pdf')
    check('ask: a box that fails cancels the download, and the log names the download and the cause', (await finished(broken!)) && dlById(broken!)?.state === 'cancelled' && errors.some((e) => e.includes('the question before download') && e.includes(broken!) && e.includes('the box exploded')), JSON.stringify(errors.slice(-3)))

    errors.length = 0
    saveAnswer = () => 'relative/place.pdf'
    const relative = await start('/doc.pdf')
    check('ask: an answer that is not an absolute file path cancels the download, and the log says so', (await finished(relative!)) && dlById(relative!)?.state === 'cancelled' && errors.some((e) => e.includes('not a file path') && e.includes(relative!)) && !existsSync(join(profileFolder, 'relative')), JSON.stringify(errors.slice(-3)))

    errors.length = 0
    const blocker = join(root, 'a-file-not-a-folder')
    writeFileSync(blocker, 'x')
    saveAnswer = () => join(blocker, 'sub', 'a.pdf')
    const stuck = await start('/doc.pdf')
    check('ask: a file that cannot be put where it was chosen is reported interrupted and the log says where', (await finished(stuck!)) && dlById(stuck!)?.state === 'interrupted' && errors.some((e) => e.includes('cannot move download') && e.includes(stuck!) && e.includes(blocker)), JSON.stringify({ state: dlById(stuck!)?.state, errors: errors.slice(-3) }))
    engine.sweepDownloadStaging()

    // A page cannot choose the place: its name is cleaned and stays inside the temporary folder until the user chooses.
    saveAnswer = (request) => join(root, 'named', request.filename)
    seen.length = 0
    const bidi = await start('/evil-name')
    await finished(bidi!)
    check('ask: the name proposed has no character that reorders the text and no path', calls.save.length > 0 && !/[‪-‮⁦-⁩]/.test(calls.save.at(-1)!.filename) && !calls.save.at(-1)!.filename.includes('/'), calls.save.at(-1)?.filename)
    seen.length = 0
    saveAnswer = (request) => join(root, 'named2', request.filename)
    const traversal = await start('/traversal')
    await finished(traversal!)
    const stagedPaths = seen.filter((d) => d.id === traversal).map((d) => d.path)
    check('ask: a name made of ../ is proposed as a plain name and never leaves the temporary folder on the way', stagedPaths.length > 0 && stagedPaths.some((p) => p.startsWith(`${stagingRoot}/`)) && !existsSync(join(stagingRoot, '..', 'escape-from-staging.txt')) && !calls.save.at(-1)!.filename.includes('/') && calls.save.at(-1)!.filename !== '..', JSON.stringify({ stagedPaths, proposed: calls.save.at(-1)?.filename }))

    patch({ downloadAskWhere: false })
    const askedBefore = calls.save.length
    const quiet = await start('/doc.pdf')
    check('ask: with the setting off again the question is gone', (await finished(quiet!)) && calls.save.length === askedBefore)

    // ====================================================================================================================
    // the warning before a file that can run (« Enregistrer ce fichier ? »)
    // ====================================================================================================================
    // The run pins the setting off (PINNED_SETTINGS in smoke-kit.ts: the downloads of the other suites are .bin files, which count as programs and would
    // wait for a box nobody answers); this suite is the one that turns it on, and answers the box itself.
    check('warn: the run starts with the warning pinned off (see below)', settingsNow().warnExecutableDownload === false)
    patch({ warnExecutableDownload: true })
    const beforeWarn = profileFiles()
    const warnsBefore = calls.warn.length
    warnAnswer = false
    seen.length = 0
    const refused = await start('/warn.sh')
    check('warn: a file that can run asks first, with its name and the site it comes from', refused !== null && (await waitFor(() => calls.warn.length === warnsBefore + 1)) && calls.warn.at(-1)?.filename === 'warn.sh' && calls.warn.at(-1)?.host.startsWith('127.0.0.1') === true, JSON.stringify(calls.warn.at(-1)))
    check('warn: « Annuler » saves nothing: the download is cancelled and the downloads folder is as it was', (await finished(refused!)) && dlById(refused!)?.state === 'cancelled' && profileFiles() === beforeWarn && !existsSync(join(profileFolder, 'warn.sh')), JSON.stringify({ state: dlById(refused!)?.state, files: profileFiles() }))
    check('warn: ...while it was asked the file waited in the temporary folder, and nothing is left there', seen.filter((d) => d.id === refused).every((d) => d.path.startsWith(`${stagingRoot}/`)) && (await waitFor(() => !existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, 3000)))
    warnAnswer = true
    const accepted = await start('/warn.sh')
    check('warn: « Enregistrer » keeps the file, whole, in the downloads folder', accepted !== null && (await finished(accepted)) && dlById(accepted)?.state === 'completed' && calls.warn.length === warnsBefore + 2 && existsSync(join(profileFolder, 'warn.sh')) && sha(readFileSync(join(profileFolder, 'warn.sh'))) === sha('#!/bin/sh\necho never run\n'), JSON.stringify({ state: dlById(accepted!)?.state, asked: calls.warn.length - warnsBefore }))
    const warnsAfterAccepted = calls.warn.length
    const harmless = await start('/doc.pdf')
    check('warn: a document is not asked about', harmless !== null && (await finished(harmless)) && dlById(harmless)?.state === 'completed' && calls.warn.length === warnsAfterAccepted)
    patch({ warnExecutableDownload: false })
    const unasked = await start('/warn.sh')
    check('warn: with the setting off a file that can run is saved without the question', unasked !== null && (await finished(unasked)) && dlById(unasked)?.state === 'completed' && calls.warn.length === warnsAfterAccepted)

    // ====================================================================================================================
    // "Ouvrir avec…" remembered by type of file
    // ====================================================================================================================
    const open = (id: string) => win.webContents.executeJavaScript(`window.lucium.downloadAction(${JSON.stringify(id)}, 'open')`)
    calls.openFile.length = 0
    calls.openWith.length = 0
    calls.chooseApp.length = 0
    check('open-with: off, the menu of a finished download has no "Ouvrir avec…"', !(await downloadMenu(plainId!)).labels.includes('Ouvrir avec…'))
    await open(plainId!)
    check('open-with: ...and "Ouvrir" is the system’s own way', await waitFor(() => calls.openFile.length === 1 && calls.openWith.length === 0), JSON.stringify(calls))
    await win.webContents.executeJavaScript(`window.lucium.downloadAction(${JSON.stringify(plainId)}, 'open-with')`)
    // The witness: a question asked after the message on the same channel, answered once the main process has handled it (the box of the
    // applications would have been asked by then: browser-downloads.ts, `openDownloadWith`).
    await win.webContents.executeJavaScript('window.lucium.getSnapshot().then(() => 0)')
    check('open-with: ...a request for it from the interface asks for no application', calls.chooseApp.length === 0)

    patch({ openWithMemory: true })
    const menu = await downloadMenu(plainId!)
    check('open-with: on, the menu offers "Ouvrir avec…" (enabled)', menu.labels.includes('Ouvrir avec…') && (menu.item('Ouvrir avec…') as { enabled?: boolean }).enabled === true, menu.labels.join(' | '))
    ;(menu.item('Ouvrir avec…')!.click as () => void)()
    check('open-with: choosing opens the file with that application, and remembers it for .pdf', (await waitFor(() => calls.openWith.length === 1)) && calls.openWith[0]![0] === '/Applications/Preview.app' && calls.openWith[0]![1] === join(profileFolder, 'doc.pdf') && (await waitFor(() => settingsNow().openWithApps['pdf'] === '/Applications/Preview.app')), JSON.stringify({ calls, apps: settingsNow().openWithApps }))
    calls.openFile.length = 0
    await open(plainId!)
    check('open-with: afterwards "Ouvrir" uses the remembered application (not the system’s way)', await waitFor(() => calls.openWith.length === 2 && calls.openFile.length === 0), JSON.stringify(calls))
    const withForget = await downloadMenu(plainId!)
    check('open-with: the menu offers to forget it, naming the application', withForget.labels.includes('Ne plus ouvrir les fichiers .pdf avec Preview'), withForget.labels.join(' | '))
    // A damaged or edited list: an executable type or a path that is no application is never used or kept.
    patch({ openWithApps: { pdf: '/Applications/Preview.app', sh: '/Applications/Terminal.app', txt: '/bin/sh' } })
    check('open-with: the list is cleaned on its way in (no executable type, no path that is not an application)', JSON.stringify(settingsNow().openWithApps) === JSON.stringify({ pdf: '/Applications/Preview.app' }), JSON.stringify(settingsNow().openWithApps))
    // The interface can forget an application but cannot name one.
    // No wait after it: dispatch is a question, answered once the main process has handled (or refused) the action.
    await win.webContents.executeJavaScript(`window.lucium.dispatch({ type: 'settings/update', patch: { openWithApps: { pdf: '/Applications/Preview.app', txt: '/Applications/Evil.app' } } })`)
    check('open-with: the interface cannot add an application to the list (only the main process can, through the system’s box)', JSON.stringify(settingsNow().openWithApps) === JSON.stringify({ pdf: '/Applications/Preview.app' }), JSON.stringify(settingsNow().openWithApps))
    ;(withForget.item('Ne plus ouvrir les fichiers .pdf avec Preview')!.click as () => void)()
    check('open-with: forgetting empties the list', await waitFor(() => Object.keys(settingsNow().openWithApps).length === 0))

    // A type that can run is never opened by an application, nor remembered.
    const shId = await start('/run.sh')
    await finished(shId!)
    const shMenu = await downloadMenu(shId!)
    calls.chooseApp.length = 0
    await browser.openDownloadWith(shId!)
    check('open-with: a program (.sh) has "Ouvrir avec…" greyed out, and asking anyway opens no box and remembers nothing', (shMenu.item('Ouvrir avec…') as { enabled?: boolean }).enabled === false && calls.chooseApp.length === 0 && Object.keys(settingsNow().openWithApps).length === 0, JSON.stringify(calls.chooseApp))
    const jpgId = await start('/photo.jpg')
    await finished(jpgId!)
    patch({ openWithApps: { jpg: '/Applications/Preview.app' } })
    calls.openFile.length = 0
    calls.openWith.length = 0
    await open(jpgId!)
    check('open-with: a file the server says is a program is not handed to the remembered application, whatever its name', (await waitFor(() => calls.openFile.length === 1)) && calls.openWith.length === 0, JSON.stringify(calls))
    patch({ openWithApps: {} })

    // A private window opens with the chosen application once and remembers nothing.
    const manager = getWindowManager()
    const record = manager.openPrivate()
    try {
      await sleep(1200)
      record.browser.dispatch({ type: 'tab/open', url: `${base}/page` })
      const privateTab = record.store.get().tabs.at(-1)!
      await waitFor(() => (record.browser.pageFor(privateTab.id) as unknown as { webContents?: WebContents } | undefined)?.webContents !== undefined)
      const privatePage = (record.browser.pageFor(privateTab.id) as unknown as { webContents: WebContents }).webContents
      await waitFor(() => !privatePage.isLoading())
      privatePage.downloadURL(`${base}/doc.pdf`)
      const privateDownload = await waitFor(() => record.browser.snapshot().downloads.some((d) => d.state === 'completed'), 8000)
      calls.openWith.length = 0
      await record.browser.openDownloadWith(record.browser.snapshot().downloads[0]!.id)
      check('open-with: in a private window the file opens with the chosen application and nothing is remembered', privateDownload && calls.openWith.length === 1 && Object.keys(settingsNow().openWithApps).length === 0 && Object.keys(record.store.get().settings.openWithApps).length === 0, JSON.stringify({ privateDownload, calls: calls.openWith, main: settingsNow().openWithApps }))
    } finally {
      record.win.close()
      await waitFor(() => !manager.list().some((w) => w.id === record.id), 5000)
    }
    patch({ openWithMemory: false })

    // ====================================================================================================================
    // opening a link without keeping the file
    // ====================================================================================================================
    const filesBefore = readdirSync(profileFolder).sort().join()
    let link = await linkMenu(`${base}/doc.pdf`)
    check('unsaved: off, the menu of a link has no "Ouvrir sans l’enregistrer"', !link.labels.includes('Ouvrir sans l’enregistrer') && link.labels.includes('Copier l’adresse du lien'), link.labels.join(' | '))
    patch({ openUnsaved: true })
    link = await linkMenu(`${base}/doc.pdf`)
    check('unsaved: on, the menu of a web link offers it, right after "Copier l’adresse du lien"', link.labels.indexOf('Ouvrir sans l’enregistrer') === link.labels.indexOf('Copier l’adresse du lien') + 1 && link.labels.indexOf('Ouvrir sans l’enregistrer') > 0, link.labels.join(' | '))
    calls.openFile.length = 0
    seen.length = 0
    link.choose('Ouvrir sans l’enregistrer')
    const opened = await waitFor(() => calls.openFile.length === 1, 8000)
    const keptPath = calls.openFile[0] ?? ''
    check('unsaved: the file is downloaded to the temporary folder of the application and handed to the system to open', opened && keptPath.startsWith(`${stagingRoot}/`) && sha(readFileSync(keptPath)) === sha(DOC), keptPath)
    check('unsaved: ...nothing new is in the downloads folder', readdirSync(profileFolder).sort().join() === filesBefore)
    const tempRow = downloadsNow().find((d) => d.path === keptPath)
    check('unsaved: ...the popover lists it as opened without being kept', tempRow?.temporary === true && tempRow.state === 'completed')
    await openPopover()
    check('unsaved: ...and says so in its row', (await statusInRow(basename(keptPath))).includes('ouvert sans être gardé'), await statusInRow(basename(keptPath)))
    browser.closeOverlay()
    engine.sweepDownloadStaging()
    check('unsaved: when the application quits (the sweep) the file is gone', !existsSync(keptPath))

    // What a crashed session leaves is swept at the next launch, and nothing outside the folder is touched, links included.
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    mkdirSync(join(stagingRoot, 'dl-old'), { recursive: true })
    writeFileSync(join(stagingRoot, 'dl-old', 'left.txt'), 'left')
    symlinkSync(outside, join(stagingRoot, 'a-link'))
    engine.sweepDownloadStaging()
    check('unsaved: the leftovers of an earlier session are swept, and the target of a link inside is left alone', !existsSync(join(stagingRoot, 'dl-old')) && !existsSync(join(stagingRoot, 'a-link')) && readFileSync(join(outside, 'keep.txt'), 'utf8') === 'keep')

    calls.openFile.length = 0
    link = await linkMenu(`${base}/traversal`)
    link.choose('Ouvrir sans l’enregistrer')
    check('unsaved: a name made of ../ stays inside the temporary folder', (await waitFor(() => calls.openFile.length === 1, 8000)) && calls.openFile[0]!.startsWith(`${stagingRoot}/`) && !existsSync(join(stagingRoot, '..', 'escape-from-staging.txt')) && !existsSync(join(root, 'escape-from-staging.txt')), calls.openFile[0])
    engine.sweepDownloadStaging()

    calls.openFile.length = 0
    // A file of its own (run.sh was downloaded above, and would make this check pass whatever the engine does with the link).
    link = await linkMenu(`${base}/prog.sh`)
    link.choose('Ouvrir sans l’enregistrer')
    // No wait after it: whether a file is opened from here is decided when it starts (it is marked temporary), and the row that says it completed
    // is published by the same call that would open it (browser.ts).
    const programRow = await waitFor(() => downloadsNow().some((d) => d.filename === 'prog.sh' && d.state === 'completed' && d.path.startsWith(profileFolder)), 8000)
    engine.sweepDownloadStaging()
    check('unsaved: a program is saved like any download and never opened from here (it survives the sweep)', programRow && calls.openFile.length === 0 && existsSync(join(profileFolder, 'prog.sh')) && downloadsNow().find((d) => d.filename === 'prog.sh')?.temporary !== true)

    link = await linkMenu(`${base}/doc.pdf`)
    patch({ openUnsaved: false })
    const countBefore = downloadsNow().length
    calls.openFile.length = 0
    link.choose('Ouvrir sans l’enregistrer')
    // A fixed wait, for want of a witness: the entry asks the setting again when it is chosen, but a download it started would only show once the
    // server has answered, and nothing comes after it on the same way.
    await sleep(1200)
    check('unsaved: an entry chosen after the setting was turned off does nothing', downloadsNow().length === countBefore && calls.openFile.length === 0)

    // ====================================================================================================================
    // PDF with the address (File menu)
    // ====================================================================================================================
    browser.dispatch({ type: 'tab/select', id: tab.id })
    // A fixed wait, for want of a witness: the menu is rebuilt for the tab that comes on screen, and a rebuild that leaves the entry out says nothing.
    await sleep(300)
    check('pdf: off, the File menu has no "Enregistrer en PDF avec l’adresse…" (Arc’s menu)', findMenuItem('Enregistrer en PDF avec l’adresse…') === undefined)
    patch({ pdfWithSource: true })
    check('pdf: on, the entry appears in the File menu, enabled for a web page, with no shortcut of its own', (await waitFor(() => findMenuItem('Enregistrer en PDF avec l’adresse…') !== undefined, 4000)) && findMenuItem('Enregistrer en PDF avec l’adresse…')!.enabled === true && !findMenuItem('Enregistrer en PDF avec l’adresse…')!.accelerator)
    const printed: Array<Record<string, unknown>> = []
    const realPrint = page.printToPDF.bind(page)
    ;(page as unknown as { printToPDF: unknown }).printToPDF = (options: Record<string, unknown>) => {
      printed.push(options)
      return realPrint(options as never)
    }
    const pdfPath = join(root, 'page.pdf')
    calls.save.length = 0
    saveAnswer = () => pdfPath
    try {
      findMenuItem('Enregistrer en PDF avec l’adresse…')!.click()
      // The file exists as soon as it is opened for writing: it is written when it holds a whole PDF.
      const pdfWhole = () => {
        try {
          const bytes = readFileSync(pdfPath)
          return bytes.subarray(0, 5).toString() === '%PDF-' && bytes.subarray(-16).toString().includes('%%EOF')
        } catch {
          return false
        }
      }
      const written = await waitFor(pdfWhole, 15_000)
      check('pdf: choosing it asks where, with the title of the page as the name, and writes a PDF', written && calls.save.at(-1)?.filename === 'Page de test des téléchargements.pdf' && pdfWhole(), JSON.stringify(calls.save.at(-1)))
      const options = printed[0] ?? {}
      const footer = String(options['footerTemplate'] ?? '')
      check('pdf: the foot of every page carries the address of the page and the date', options['displayHeaderFooter'] === true && footer.includes(`${base}/page`) && footer.includes(new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })) && options['headerTemplate'] === '<span></span>', footer.slice(0, 200))
    } finally {
      ;(page as unknown as { printToPDF: unknown }).printToPDF = realPrint
    }
    // The saved PDF is opened in a tab and searched: the address is in the text of the page, not only in the request.
    {
      let served = false
      const pdfServer = createServer((_req, res) => {
        served = true
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline' })
        res.end(readFileSync(pdfPath))
      })
      await new Promise<void>((resolve) => pdfServer.listen(0, '127.0.0.1', resolve))
      browser.dispatch({ type: 'tab/open', url: `http://127.0.0.1:${(pdfServer.address() as AddressInfo).port}/saved.pdf` })
      const pdfTab = state().tabs.at(-1)!
      mine.add(pdfTab.id)
      await waitFor(() => served, 8000)
      await sleep(2500)
      const viewer = wcOf(pdfTab.id)
      const find = async (text: string): Promise<number> =>
        new Promise((resolve) => {
          if (!viewer) return resolve(-1)
          const timer = setTimeout(() => resolve(-1), 4000)
          viewer.once('found-in-page', (_e, result) => {
            clearTimeout(timer)
            resolve(result.matches)
          })
          viewer.findInPage(text)
        })
      const control = await find('Téléchargements')
      if (control > 0) {
        const hostPort = new URL(base).host
        const matches = await find(hostPort)
        check('pdf: the address is printed in the text of the saved PDF (found by the PDF viewer’s search)', matches > 0, `${hostPort}: ${matches} (control ${control})`)
      } else check('pdf: the address is printed in the text of the saved PDF (found by the PDF viewer’s search)', true, skippedBecause(`the search of the PDF viewer did not find the control text (${control}): the address was checked in the print request only`))
      viewer?.stopFindInPage('clearSelection')
      pdfServer.close()
      pdfServer.closeAllConnections()
    }
    saveAnswer = () => null
    rmSync(pdfPath, { force: true })
    findMenuItem('Enregistrer en PDF avec l’adresse…')!.click()
    // A fixed wait, for want of a witness: a file written in spite of the answer would come only once the page is printed, and nothing comes after.
    await sleep(800)
    check('pdf: giving up in the box writes nothing', !existsSync(pdfPath))
    browser.dispatch({ type: 'tab/open', url: 'about:blank' })
    const blank = state().tabs.at(-1)!
    mine.add(blank.id)
    check('pdf: for a page that is not on the web the entry is greyed out', await waitFor(() => findMenuItem('Enregistrer en PDF avec l’adresse…')?.enabled === false, 4000))
    patch({ pdfWithSource: false })
    check('pdf: off again, the entry is gone', await waitFor(() => findMenuItem('Enregistrer en PDF avec l’adresse…') === undefined, 4000))
    browser.dispatch({ type: 'tab/select', id: tab.id })

    // ====================================================================================================================
    // folders in the read-later list
    // ====================================================================================================================
    // The pages other suites may have left in the list are counted, not assumed away.
    const baseline = state().readLater.length
    for (const n of [1, 2, 3]) {
      browser.dispatch({ type: 'tab/open', url: `${base}/lire-${n}` })
      const t = state().tabs.at(-1)!
      browser.dispatch({ type: 'readlater/add', tabId: t.id })
    }
    const idOf = (n: number) => state().readLater.find((i) => i.url === `${base}/lire-${n}`)!.id
    const openList = async () => {
      browser.openOverlay({ panel: 'readlater' })
      await waitFor(async () => (await rectOf(ui, '.readlater')) !== null, 4000)
      await sleep(250)
    }
    const dnd = (sourceSelector: string, targetSelector: string) =>
      evaluate<boolean>(ui, `(() => {
        const source = document.querySelector(${JSON.stringify(sourceSelector)})
        const target = document.querySelector(${JSON.stringify(targetSelector)})
        if (!source || !target) return false
        const data = new DataTransfer()
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
        return true
      })()`)
    const rowSel = (n: number) => `.readlater-row[data-id="${idOf(n)}"]`
    await openList()
    check('folders: off, the list is flat as before: three rows, no folder control, rows not draggable, no folder menu', (await countOf(ui, '.readlater-row')) === baseline + 3 && (await countOf(ui, '[data-action="new-folder"]')) === 0 && (await countOf(ui, '.readlater-row[draggable="true"]')) === 0 && (await countOf(ui, '.readlater-folder-select')) === 0)
    browser.dispatch({ type: 'readlater-folder/create', name: 'Refusé' })
    check('folders: off, a request for a folder (from anywhere) changes nothing', state().readLaterFolders.length === 0)

    patch({ useReadLaterFolders: true })
    check('folders: on, the list offers "Nouveau dossier"', await waitFor(async () => (await countOf(ui, '[data-action="new-folder"]')) === 1, 4000))
    check('folders: a real click opens the name field, which has the keyboard', (await clickOn(ui, '[data-action="new-folder"]')) && (await waitFor(async () => (await countOf(ui, '[data-field="new-folder"]')) === 1, 3000)) && (await evaluate<boolean>(ui, `document.activeElement?.getAttribute('data-field') === 'new-folder'`)))
    await typeText(ui, 'A lire ce soir')
    await pressKey(ui, 'Return')
    check('folders: typing a name and pressing Return makes the folder (shown first)', (await waitFor(() => state().readLaterFolders.length === 1)) && state().readLaterFolders[0]!.name === 'A lire ce soir' && (await waitFor(async () => (await countOf(ui, '.readlater-folder')) === 1, 3000)), JSON.stringify(state().readLaterFolders))
    const folderId = state().readLaterFolders[0]!.id

    check('folders: dragging a page onto the header of a folder puts it in the folder', (await dnd(rowSel(1), '.readlater-folder-head')) && (await waitFor(() => state().readLater.find((i) => i.id === idOf(1))?.folderId === folderId, 3000)), JSON.stringify(state().readLater.map((i) => [i.url.slice(-6), i.folderId])))
    check('folders: ...the row is now inside the folder’s own list', await waitFor(async () => (await countOf(ui, `.readlater-folder[data-folder="${folderId}"] .readlater-row`)) === 1, 3000))
    check('folders: the pages still counted are all there (nothing lost)', state().readLater.length === baseline + 3 && (await textOf(ui, '.readlater-count')) === String(baseline + 3))
    const select = `${rowSel(2)} .readlater-folder-select`
    const moved = await evaluate<boolean>(ui, `(() => { const s = document.querySelector(${JSON.stringify(select)}); if (!s) return false; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(s, ${JSON.stringify(folderId)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    check('folders: the menu of a row (the keyboard way) puts a page in a folder too', moved && (await waitFor(() => state().readLater.find((i) => i.id === idOf(2))?.folderId === folderId, 3000)))
    // The panel draws a moment after the state changes: what follows drops on rows as they are drawn, so wait for the drawing, not only the state.
    await waitFor(async () => (await countOf(ui, `.readlater-folder[data-folder="${folderId}"] .readlater-row`)) === 2, 3000)
    const order = () => state().readLater.filter((i) => i.folderId === folderId).map((i) => i.id)
    const beforeOrder = order()
    check('folders: dropping a page on another row of the folder puts it before that one', beforeOrder.length === 2 && (await dnd(`.readlater-row[data-id="${beforeOrder[1]}"]`, `.readlater-row[data-id="${beforeOrder[0]}"]`)) && (await waitFor(() => order()[0] === beforeOrder[1], 3000)), JSON.stringify({ beforeOrder, after: order() }))
    check('folders: dragging a page out of a folder onto "Sans dossier" makes it loose again', (await waitFor(async () => (await countOf(ui, '.readlater-loose-head')) === 1, 3000)) && (await dnd(rowSel(2), '.readlater-loose-head')) && (await waitFor(() => state().readLater.find((i) => i.id === idOf(2))?.folderId === undefined, 3000)))

    check('folders: a real click on the fold button folds the folder and hides its pages', (await clickOn(ui, '[data-action="fold"]')) && (await waitFor(() => state().readLaterFolders[0]?.collapsed === true, 3000)) && (await waitFor(async () => (await countOf(ui, `.readlater-folder[data-folder="${folderId}"] .readlater-row`)) === 0, 3000)))
    check('folders: ...and a second click unfolds it', (await clickOn(ui, '[data-action="fold"]')) && (await waitFor(() => state().readLaterFolders[0]?.collapsed !== true, 3000)))

    check('folders: renaming goes through a real click, a typed name and Return', (await clickOn(ui, '[data-action="rename-folder"]')) && (await waitFor(async () => (await countOf(ui, 'input.readlater-folder-name')) === 1, 3000)))
    await evaluate(ui, `document.querySelector('input.readlater-folder-name').select()`)
    await typeText(ui, 'Lectures')
    await pressKey(ui, 'Return')
    check('folders: ...the folder has its new name', await waitFor(() => state().readLaterFolders[0]?.name === 'Lectures', 3000), JSON.stringify(state().readLaterFolders))

    store.flush()
    const onDisk = parseSavedState(readFileSync(join(app.getPath('userData'), 'state.json'), 'utf8'))
    check('folders: the folders and the place of each page are in the file and come back whole at the next start', onDisk.readLaterFolders.length === 1 && onDisk.readLaterFolders[0]!.name === 'Lectures' && onDisk.readLater.find((i) => i.id === idOf(1))?.folderId === folderId && onDisk.readLater.length === baseline + 3)

    patch({ useReadLaterFolders: false })
    check('folders: off again, the list is flat (every page, no folder control) and the pages keep their folder in the file', (await waitFor(async () => (await countOf(ui, '.readlater-folder')) === 0 && (await countOf(ui, '.readlater-row')) === baseline + 3, 4000)) && state().readLater.find((i) => i.id === idOf(1))?.folderId === folderId)
    browser.dispatch({ type: 'readlater/move', id: idOf(3), folderId, beforeId: undefined })
    check('folders: off, nothing can be put in a folder', state().readLater.find((i) => i.id === idOf(3))?.folderId === undefined)
    patch({ useReadLaterFolders: true })
    await waitFor(async () => (await countOf(ui, '.readlater-folder')) === 1, 4000)
    check('folders: back on, the folder and its page are back as they were', (await countOf(ui, `.readlater-folder[data-folder="${folderId}"] .readlater-row`)) === 1)
    check('folders: deleting a folder (real click) keeps its pages in the list, loose', (await clickOn(ui, '[data-action="delete-folder"]')) && (await waitFor(() => state().readLaterFolders.length === 0, 3000)) && state().readLater.length === baseline + 3 && state().readLater.every((i) => i.folderId === undefined) && (await waitFor(async () => (await countOf(ui, '.readlater-row')) === baseline + 3, 3000)))
    browser.closeOverlay()
    for (const n of [1, 2, 3]) browser.dispatch({ type: 'readlater/remove', id: idOf(n) })

    // ====================================================================================================================
    // Settings › Téléchargements et fichiers: the groups that hold the switches, and the list of remembered applications; the pause of the downloads,
    // « Ouvrir sans l’enregistrer » and the PDF with the address are features to add, lines of « Fonctions en option » › Fichiers
    // ====================================================================================================================
    patch({ openWithMemory: true, openWithApps: { pdf: '/Applications/Preview.app', txt: '/Applications/TextEdit.app' } })
    browser.openOverlay({ panel: 'settings', pane: 'features' })
    await waitFor(() => settingsWindows().length === 1)
    const settingsWc = settingsWindows()[0]!.webContents
    await waitFor(async () => (await countOf(settingsWc, '[role="switch"][aria-label="Pause et reprise des téléchargements"]')) === 1, 8000)
    const featureLabels = ['Pause et reprise des téléchargements', 'Ouvrir sans l’enregistrer', 'Enregistrer en PDF avec l’adresse']
    const sectionOf = (labels: readonly string[]) =>
      evaluate<Record<string, string>>(settingsWc, `Object.fromEntries(${JSON.stringify(labels)}.map((label) => { const section = document.querySelector('[role="switch"][aria-label="' + label + '"]')?.closest('.pref-section'); return [label, section?.querySelector('h3 .pref-title')?.textContent ?? 'absent'] }))`)
    const inFeatures = await sectionOf(featureLabels)
    check('settings: « Fonctions en option » has the pause, « Ouvrir sans l’enregistrer » and the PDF with its address, once each, in « Fichiers »', featureLabels.every((label) => inFeatures[label] === 'Fichiers'), JSON.stringify(inFeatures))
    await evaluate(settingsWc, `document.querySelector('[role="switch"][aria-label="Pause et reprise des téléchargements"]').scrollIntoView({ block: 'center' })`)
    // Not a wait for something that must not happen: it lets the scroll be drawn before the real click below, whose effect is waited for.
    await sleep(200)
    check('settings: a real click on a switch changes the setting', (await clickOn(settingsWc, '[role="switch"][aria-label="Pause et reprise des téléchargements"]')) && (await waitFor(() => settingsNow().downloadPause === true, 3000)))
    // Téléchargements et fichiers, from the sidebar of the window.
    await evaluate(settingsWc, `document.querySelector('.settings-cat[data-cat="files"]')?.click()`)
    await waitFor(async () => (await countOf(settingsWc, '[role="switch"][aria-label="Demander où enregistrer chaque fichier"]')) === 1, 8000)
    // The rows that wait in « Plus de réglages » are reached once it is open.
    await waitFor(() => evaluate<boolean>(settingsWc, OPEN_MORE_SETTINGS), 3000)
    await sleep(300)
    const labels = ['Demander où enregistrer chaque fichier', frenchSpaces('Classer « Lire plus tard » dans des dossiers'), 'Mémoriser l’application d’ouverture par type de fichier']
    // Réglages › Téléchargements et fichiers (DownloadSettings.tsx): the downloads and the read-later folders in « Téléchargements et lecture » (id "downloads"), the
    // opening of files in « Ouverture des fichiers », the group right after it. The title of a group is its .pref-title.
    const placed = await sectionOf(labels)
    const groupOf = (label: string) => placed[label]
    check(
      'settings: the Files pane has its three switches, once each: two in « Téléchargements et lecture » (ask where, read later folders), one in « Ouverture des fichiers » (remember the application)',
      (await Promise.all(labels.map((label) => countOf(settingsWc, `[role="switch"][aria-label=${JSON.stringify(label)}]`)))).every((n) => n === 1) &&
        [labels[0]!, labels[1]!].every((label) => groupOf(label) === 'Téléchargements et lecture') &&
        groupOf(labels[2]!) === 'Ouverture des fichiers',
      JSON.stringify(placed)
    )
    check('settings: the remembered applications are listed by type, with their name', (await textOf(settingsWc, '.pref-section')).length > 0 && (await evaluate<string>(settingsWc, `document.body.innerText`)).includes('.pdf · Preview') && (await evaluate<string>(settingsWc, `document.body.innerText`)).includes('.txt · TextEdit'))
    calls.chooseApp.length = 0
    chosenApplication = '/Applications/Skim.app'
    const changed = await evaluate<boolean>(settingsWc, `(() => { const row = [...document.querySelectorAll('.pref-row')].find((r) => r.textContent.includes('.pdf · Preview')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent === 'Changer…'); if (!b) return false; b.scrollIntoView({ block: 'center' }); return true })()`)
    const changeRect = await evaluate<Rect | null>(settingsWc, `(() => { const row = [...document.querySelectorAll('.pref-row')].find((r) => r.textContent.includes('.pdf · Preview')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent === 'Changer…'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    if (changed && changeRect) {
      await sleep(200)
      mouse(settingsWc, 'mouseMove', changeRect.x + changeRect.width / 2, changeRect.y + changeRect.height / 2)
      mouse(settingsWc, 'mouseDown', changeRect.x + changeRect.width / 2, changeRect.y + changeRect.height / 2)
      mouse(settingsWc, 'mouseUp', changeRect.x + changeRect.width / 2, changeRect.y + changeRect.height / 2)
    }
    check('settings: "Changer…" opens the system’s box and replaces the application of the type', changed && (await waitFor(() => settingsNow().openWithApps['pdf'] === '/Applications/Skim.app', 4000)) && calls.chooseApp.includes('.pdf'), JSON.stringify({ apps: settingsNow().openWithApps, asked: calls.chooseApp }))
    const forgetRect = await evaluate<Rect | null>(settingsWc, `(() => { const row = [...document.querySelectorAll('.pref-row')].find((r) => r.textContent.includes('.txt · TextEdit')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent === 'Retirer'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    await sleep(250)
    const forgetRect2 = await evaluate<Rect | null>(settingsWc, `(() => { const row = [...document.querySelectorAll('.pref-row')].find((r) => r.textContent.includes('.txt · TextEdit')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent === 'Retirer'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    void forgetRect
    if (forgetRect2) {
      mouse(settingsWc, 'mouseMove', forgetRect2.x + forgetRect2.width / 2, forgetRect2.y + forgetRect2.height / 2)
      mouse(settingsWc, 'mouseDown', forgetRect2.x + forgetRect2.width / 2, forgetRect2.y + forgetRect2.height / 2)
      mouse(settingsWc, 'mouseUp', forgetRect2.x + forgetRect2.width / 2, forgetRect2.y + forgetRect2.height / 2)
    }
    check('settings: "Retirer" (the interface may forget an application) takes one type out of the list', await waitFor(() => JSON.stringify(settingsNow().openWithApps) === JSON.stringify({ pdf: '/Applications/Skim.app' }), 4000), JSON.stringify(settingsNow().openWithApps))
    browser.closeOverlay()
    for (const w of settingsWindows()) w.close()
  } finally {
    listening = false
    console.error = realError
    restoreUi()
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    browser.closeOverlay()
    browser.dispatch({ type: 'settings/update', patch: { ...original, profiles: profilesBefore } })
    for (const d of downloadsNow()) browser.clearDownload(d.id)
    engine.sweepDownloadStaging()
    server.close()
    server.closeAllConnections()
    rmSync(root, { recursive: true, force: true })
  }
}

/** `LUCIUM_SMOKE_ONLY=downloads2`: only these checks, with their own report. */
export async function runDownloads2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const verbose = process.env['LUCIUM_DOWNLOADS2_VERBOSE'] === '1'
    await smokeDownloads2(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`DOWNLOADS2 ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeDownloads2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_DOWNLOADS2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
