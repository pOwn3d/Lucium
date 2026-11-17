// Engine checks for sharing Tweaks and themes, run inside a real Electron. A local server serves a page and counts what it is asked for:
// a Tweak is exported to a real file and imported back (a new Tweak, its script stored switched off), the page shows the effect of the
// imported CSS and does not run the imported script until the person turns it on in the editor, hostile files are refused without
// writing anything and without a single request reaching the server (while the same stylesheet written by the person does reach it:
// the control), a link goes through the real clipboard, the setting drops scripts, a private window takes nothing, the channel
// refuses a page that is not one of our surfaces, and every entry point (editor menu, command bar, Settings) sends its request.
// Called from the engine smoke test: `await smokeShare(ctx, check)`; `LUCIUM_SMOKE_ONLY=share` runs only this file (see index.ts).
// The system clipboard is saved first and put back at the end; no real dialog is ever opened (they are replaced, or the request is
// answered before it can open one).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow as ElectronWindow, clipboard, ipcMain, type WebContents } from 'electron'
import { SHARE_FILE_MAX_BYTES, parseBoostFile, themeFileText, type ImportPreview } from '@shared/boost-share'
import { Channel } from '@shared/ipc'
import { READY_THEMES } from '@shared/theme-presets'
import type { SmokeContext } from './smoke'
import { exportBoostToFile, importBoostFromClipboard, importBoostFromFile, importThemeFromFile, copyBoostLink, type ExportChoice, type ImportChoice, type ShareEnvironment } from './shell/boost-share'
import { shareEnvironment } from './shell/share-environment'
import { getWindowManager } from './shell/windows'
import { noteCheck, OPEN_MORE_SETTINGS, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

// A 1x1 PNG: what the server answers to a request for a picture.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const SCRIPT = `document.documentElement.setAttribute('data-boost-ran', '1')`

export async function smokeShare(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const ui = overlayView.webContents
  const state = () => store.get()
  const evaluate = <T>(from: WebContents, script: string) =>
    (from.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${String(error)} -- in: ${script.replace(/\s+/g, ' ').slice(0, 200)}`)
    })

  // ---- the server: a page to tweak, and a path any picture asked for by a stylesheet would reach ----
  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'close')
    if (url.pathname.startsWith('/leak')) {
      res.setHeader('content-type', 'image/png')
      return void res.end(PIXEL)
    }
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><title>share ${url.pathname}</title><body><p id="p">Bonjour le monde</p><div id="ad">publicité</div><div id="probe" style="width:40px;height:20px;background:rgb(200,0,0)"></div></body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const leaks = () => hits.get('/leak.png') ?? 0

  const folder = mkdtempSync(join(tmpdir(), 'lucium-share-smoke-'))
  const keptClipboard = await clipboard.readText()
  const settingsBefore = state().settings.boostScriptImport
  const boostsBefore = new Set(state().boosts.map((b) => b.id))
  const mine = new Set<string>()
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const open = async (): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}/page` })
    const tab = state().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => browser.snapshot().runtime.tabs[tab.id]?.loading === false && wcOf(tab.id)?.getURL().startsWith(base) === true)
    return tab.id
  }
  const look = (id: string) =>
    evaluate<{ color: string; probe: string; ad: string; transform: string; ran: string | null }>(
      wcOf(id)!,
      `(() => { const cs = (s) => getComputedStyle(document.querySelector(s)); return { color: cs('#p').color, probe: cs('#probe').backgroundColor, ad: cs('#ad').display, transform: cs('#p').textTransform, ran: document.documentElement.getAttribute('data-boost-ran') } })()`
    )

  // ---- the environment of the share module: the real one, with the dialogs replaced by recorded answers ----
  const real = shareEnvironment(browser, store, win)
  const log = { previews: [] as ImportPreview[], problems: [] as Array<{ title: string; sentence: string }>, exportSheets: 0, opened: 0 }
  let toOpen: string | null = null
  let toSave: string | null = null
  let importChoice: ImportChoice = 'install'
  let exportChoice: ExportChoice = 'with-script'
  const env: ShareEnvironment = {
    ...real,
    chooseOpenFile: async () => {
      log.opened++
      return toOpen
    },
    chooseSaveFile: async () => toSave,
    confirmImport: async (preview) => {
      log.previews.push(preview)
      return importChoice
    },
    confirmExportScript: async () => {
      log.exportSheets++
      return exportChoice
    },
    confirmThemeImport: async () => true,
    showProblem: async (title, sentence) => void log.problems.push({ title, sentence })
  }
  const boostsNow = () => JSON.stringify(state().boosts)
  const importFile = async (path: string) => {
    toOpen = path
    return importBoostFromFile(env)
  }

  const original = {
    id: 'share-smoke-original',
    host: '127.0.0.1',
    name: 'Partage',
    css: '#p { color: rgb(1, 2, 3) !important; letter-spacing: 3px }\n#probe { background-color: rgb(0, 128, 0) !important }',
    js: SCRIPT,
    zoom: 1.2,
    zap: ['#ad'],
    tint: { hue: 20, saturation: 1.1, brightness: 0.95, contrast: 1.05 },
    fontFamily: 'inter',
    textCase: 'upper' as const
  }
  const surfaceMessages: string[] = []
  const listen = (event: unknown, ...legacy: unknown[]) => void surfaceMessages.push(String((event as { message?: unknown })?.message ?? legacy[1]))
  ui.on('console-message', listen)
  const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
  const realBoostShare = handlers.get(Channel.boostShare)
  const realThemeCode = handlers.get(Channel.themeCode)
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }

  try {
    // ======================= out: a Tweak becomes a file =======================
    browser.dispatch({ type: 'boost/save', boost: original })
    const exportPath = join(folder, 'partage.lucium-boost')
    toSave = exportPath
    const exported = await exportBoostToFile(env, original.id)
    check('share: exporting a Tweak with a script says so first, then writes the file the person named', exported.ok && log.exportSheets === 1 && existsSync(exportPath), JSON.stringify(exported))
    const text = readFileSync(exportPath, 'utf8')
    const written = JSON.parse(text) as { format: number; kind: string; boost: Record<string, unknown> }
    check('share: the file is JSON of format 1 and kind boost, with the script (the person agreed) and with no id, no state and no setting', written.format === 1 && written.kind === 'boost' && written.boost['js'] === SCRIPT && !/"id"|enabled|jsEnabled|share-smoke-original/.test(text), text.slice(0, 200))
    check('share: …and reading it back gives the Tweak that was exported', JSON.stringify(parseBoostFile(text)) === JSON.stringify({ ok: true, boost: { name: 'Partage', host: '127.0.0.1', css: original.css, js: SCRIPT, zoom: 1.2, zap: ['#ad'], tint: original.tint, fontFamily: 'inter', textCase: 'upper' } }), text.slice(0, 200))

    // ======================= in: the file becomes a new Tweak, its script switched off =======================
    browser.dispatch({ type: 'boost/delete', id: original.id })
    const tab = await open()
    const before = await look(tab)
    check('share: control: without the Tweak the page is as its server wrote it (no colour, the ad is shown, no script)', before.color !== 'rgb(1, 2, 3)' && before.ad !== 'none' && before.probe === 'rgb(200, 0, 0)' && before.ran === null, JSON.stringify(before))

    const imported = await importFile(exportPath)
    const boost = state().boosts.find((b) => b.id === imported.boostId)
    check('share: importing the file shows a preview first (name, site, what it holds, the start of the script), then installs', imported.ok && log.previews.length === 1 && log.previews[0]!.message === frenchSpaces('Installer la Retouche « Partage » ?') && log.previews[0]!.detail.includes(frenchSpaces('Site : 127.0.0.1')) && log.previews[0]!.detail.includes(SCRIPT) && log.previews[0]!.hasScript, JSON.stringify({ imported, preview: log.previews[0]?.message }))
    check(
      'share: the Tweak is a new one (another id), switched on, with its CSS, zoom, erased elements, font, case and colours',
      !!boost && boost.id !== original.id && boost.enabled && boost.css === original.css && boost.zoom === 1.2 && JSON.stringify(boost.zap) === '["#ad"]' && boost.fontFamily === 'inter' && boost.textCase === 'upper' && JSON.stringify(boost.tint) === JSON.stringify(original.tint),
      JSON.stringify(boost)
    )
    check('share: its script is kept as text and stored switched off', !!boost && boost.js === SCRIPT && boost.jsEnabled === false, JSON.stringify(boost?.jsEnabled))

    check('share: the open page shows the effect of the imported CSS at once: colour, picture-free background, element erased, case', await waitFor(async () => (await look(tab)).color === 'rgb(1, 2, 3)'), JSON.stringify(await look(tab)))
    const after = await look(tab)
    check('share: …all of it (the stylesheet, the erased element, the case)', after.probe === 'rgb(0, 128, 0)' && after.ad === 'none' && after.transform === 'uppercase', JSON.stringify(after))
    check('share: …and the text size of the Tweak', Math.abs((wcOf(tab)?.getZoomFactor() ?? 0) - 1.2) < 0.01, String(wcOf(tab)?.getZoomFactor()))
    // A fixed wait, for want of a witness: a script that is let run makes the page load again for it (browser-site.ts), and a load asked by mistake
    // shows only once it lands.
    await sleep(900)
    check('share: the imported script has NOT run (the page was loaded with the Tweak, and it waited)', (await look(tab)).ran === null, JSON.stringify(await look(tab)))

    // ---- the person reads the code and turns it on, in the editor ----
    browser.openOverlay({ panel: 'boost', host: '127.0.0.1', id: boost!.id })
    check('share: the editor opens on the imported Tweak', await waitFor(() => evaluate<boolean>(ui, `!!document.querySelector('.bx')`)))
    await evaluate(ui, `document.querySelector('.bx-tabs button:nth-child(2)')?.click()`)
    await evaluate(ui, `[...document.querySelectorAll('.bx-seg button')].find((b) => b.textContent === 'JS')?.click()`)
    await sleep(200)
    const banner = await evaluate<{ shown: boolean; button: string; code: string }>(ui, `({ shown: !!document.querySelector('.bx-script-off'), button: document.querySelector('.bx-script-on')?.textContent ?? '', code: document.querySelector('.bx-text')?.value ?? '' })`)
    check('share: the JS tab shows the code and says it is not executed, with one button to turn it on', banner.shown && banner.button === 'Activer le JavaScript' && banner.code === SCRIPT, JSON.stringify(banner))
    await evaluate(ui, `document.querySelector('.bx-script-on')?.click()`)
    // The editor's own way out: back to the main view, then "Terminé" (the editor saves what was typed as it closes).
    await evaluate(ui, `document.querySelector('.bx-tabs button:nth-child(1)')?.click()`)
    await waitFor(() => evaluate<boolean>(ui, `!!document.querySelector('.bx-done')`))
    await evaluate(ui, `document.querySelector('.bx-done')?.click()`)
    check('share: turning it on and closing the editor stores a script that may run', await waitFor(() => state().boosts.find((b) => b.id === boost!.id)?.jsEnabled === undefined), JSON.stringify(state().boosts.find((b) => b.id === boost!.id)))
    check('share: …and the page, reloaded, runs it', await waitFor(async () => (await look(tab)).ran === '1', 15_000), JSON.stringify(await look(tab)))
    browser.dispatch({ type: 'boost/save', boost: { ...state().boosts.find((b) => b.id === boost!.id)!, jsEnabled: false } })
    await waitFor(async () => (await look(tab)).ran === null, 15_000)
    check('share: switching the script off again stops it (a page without the flag is a new document)', (await look(tab)).ran === null && state().boosts.find((b) => b.id === boost!.id)?.jsEnabled === false)
    // A save that says nothing of the script (a stale editor) does not wake it.
    const sleeping = state().boosts.find((b) => b.id === boost!.id)!
    const { jsEnabled: _flag, ...stale } = sleeping
    browser.dispatch({ type: 'boost/save', boost: { ...stale, name: 'Partage renommé' } })
    check('share: a save from a stale editor renames the Tweak but leaves the script off', state().boosts.find((b) => b.id === boost!.id)?.name === 'Partage renommé' && state().boosts.find((b) => b.id === boost!.id)?.jsEnabled === false)
    browser.dispatch({ type: 'boost/delete', id: boost!.id })

    // ======================= hostile files: refused, nothing written, nothing fetched =======================
    const hostile: Array<[string, unknown, RegExp]> = [
      ['@import', { host: '127.0.0.1', css: `@import url(${base}/leak.css);` }, /@import/],
      ['a url()', { host: '127.0.0.1', css: `#probe { background-image: url(${base}/leak.png?a=1) !important }` }, /url\(/],
      ['a url() written with an escape', { host: '127.0.0.1', css: `#probe { background-image: u\\72l(${base}/leak.png?b=1) !important }` }, /url\(/],
      ['an image-set()', { host: '127.0.0.1', css: `#probe { background-image: image-set("${base}/leak.png?c=1" 1x) !important }` }, /image-set/],
      ['a data: url()', { host: '127.0.0.1', css: `#probe { background-image: url(data:image/png;base64,AAAA) }` }, /url\(/],
      ['a public suffix as site', { host: 'co.uk', css: 'p { color: red }' }, /trop large/],
      ['a bare word as site', { host: 'com', css: 'p { color: red }' }, /nom de site/],
      ['a zoom out of range', { host: '127.0.0.1', zoom: 40 }, /taille du texte/]
    ]
    const snapshotBefore = boostsNow()
    const problemsBefore = log.problems.length
    const previewsBefore = log.previews.length
    let refusedAll = true
    for (const [name, boostFields, sentence] of hostile) {
      const path = join(folder, 'hostile.lucium-boost')
      writeFileSync(path, JSON.stringify({ format: 1, kind: 'boost', boost: { name: 'Hostile', ...(boostFields as object) } }))
      const reply = await importFile(path)
      const refused = !reply.ok && sentence.test(reply.message) && log.problems.at(-1)?.sentence === reply.message
      if (!refused) refusedAll = false
      if (!refused) check(`share: hostile file (${name}) is refused with its reason`, false, JSON.stringify(reply))
    }
    const bigPath = join(folder, 'big.lucium-boost')
    writeFileSync(bigPath, `{"format":1,"kind":"boost","boost":{"host":"127.0.0.1"},"padding":"${'x'.repeat(SHARE_FILE_MAX_BYTES)}"}`)
    const bigReply = await importFile(bigPath)
    const notJsonPath = join(folder, 'not.lucium-boost')
    writeFileSync(notJsonPath, '#probe { background: red }')
    const notJsonReply = await importFile(notJsonPath)
    check('share: each hostile file is refused with its reason shown to the person', refusedAll && log.problems.length === problemsBefore + hostile.length + 2, `${log.problems.length - problemsBefore} sentences`)
    check('share: a file over the size limit is refused before it is read', !bigReply.ok && /trop volumineux/.test(bigReply.message))
    check('share: a file that is not JSON is refused', !notJsonReply.ok && /n’est pas du JSON/.test(notJsonReply.message))
    check('share: nothing was shown as installable, and the Tweaks are exactly as they were', log.previews.length === previewsBefore && boostsNow() === snapshotBefore, `${log.previews.length - previewsBefore} previews`)
    const hostileTab = await open()
    // A fixed wait, for want of a witness: a request the stylesheet of a Tweak would make goes out when the page is styled, at no moment the page tells.
    await sleep(900)
    check('share: no request reached the server for a picture or a stylesheet: the hostile CSS never got into a Tweak', leaks() === 0 && !hits.has('/leak.css'), JSON.stringify([...hits]))
    check('share: …and the page is as the server wrote it', (await look(hostileTab)).probe === 'rgb(200, 0, 0)')

    // The control: the same stylesheet written by the person (the editor does not judge it) does reach the server. If this failed, the
    // check above would prove nothing.
    browser.dispatch({ type: 'boost/save', boost: { id: 'share-smoke-control', host: '127.0.0.1', name: 'Témoin', css: `#probe { background-image: url(${base}/leak.png?control=1) !important }` } })
    check('share: control: a stylesheet written by the person with a url() does fetch it (so the test above could fail)', await waitFor(() => leaks() > 0, 8000), `${leaks()} requests`)
    browser.dispatch({ type: 'boost/delete', id: 'share-smoke-control' })

    // ======================= a link, through the real clipboard =======================
    browser.dispatch({ type: 'boost/save', boost: { ...original, id: 'share-smoke-link', name: 'Pour le lien', js: SCRIPT } })
    exportChoice = 'without-script'
    const copied = await copyBoostLink(env, 'share-smoke-link')
    const link = await clipboard.readText()
    check('share: copying the link of a Tweak with a script asks, and puts a link of safe characters on the clipboard', copied.ok && /^lucboost1_[A-Za-z0-9_-]+$/.test(link) && !URL.canParse(link), link.slice(0, 40))
    check('share: …and without the script when the person chose that (it is not in the link)', !Buffer.from(link.slice(10).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').includes('data-boost-ran'))
    importChoice = 'install'
    const pasted = await importBoostFromClipboard(env)
    const fromLink = state().boosts.find((b) => b.id === pasted.boostId)
    check('share: pasting it installs a Tweak with the same CSS, erased elements and colours and no script', pasted.ok && !!fromLink && fromLink.css === original.css && fromLink.js === '' && fromLink.jsEnabled === undefined && JSON.stringify(fromLink.zap) === '["#ad"]', JSON.stringify(pasted))
    await clipboard.writeText(link.replace(/.$/, '!'))
    const brokenLink = await importBoostFromClipboard(env)
    await clipboard.writeText('lucboost1_' + Buffer.from(JSON.stringify({ format: 1, kind: 'boost', boost: { host: '127.0.0.1', css: `@import "${base}/leak.css"` } })).toString('base64url'))
    const hostileLink = await importBoostFromClipboard(env)
    check('share: a damaged link and a hostile link are refused with a reason, and install nothing', !brokenLink.ok && !hostileLink.ok && /@import/.test(hostileLink.message) && state().boosts.filter((b) => !boostsBefore.has(b.id)).length === 2, `${brokenLink.message} / ${hostileLink.message}`)
    browser.dispatch({ type: 'boost/delete', id: 'share-smoke-link' })
    if (fromLink) browser.dispatch({ type: 'boost/delete', id: fromLink.id })

    // ======================= the setting that keeps scripts out =======================
    browser.dispatch({ type: 'settings/update', patch: { boostScriptImport: 'never' } })
    const sheetsBefore = log.previews.length
    const dropped = await importFile(exportPath)
    const droppedBoost = state().boosts.find((b) => b.id === dropped.boostId)
    check('share: with the setting on "never" the preview says the script is not imported, and the Tweak arrives without it', dropped.ok && log.previews.length === sheetsBefore + 1 && log.previews.at(-1)!.scriptDropped && !log.previews.at(-1)!.detail.includes(SCRIPT) && droppedBoost?.js === '' && droppedBoost.css === original.css, JSON.stringify(droppedBoost))
    if (droppedBoost) browser.dispatch({ type: 'boost/delete', id: droppedBoost.id })
    browser.dispatch({ type: 'settings/update', patch: { boostScriptImport: 'ask' } })

    // ---- the sheet's other answers ----
    importChoice = 'cancel'
    const cancelledReply = await importFile(exportPath)
    importChoice = 'install-without-script'
    const withoutScript = await importFile(exportPath)
    const noScriptBoost = state().boosts.find((b) => b.id === withoutScript.boostId)
    check('share: closing the sheet installs nothing; "without the script" installs the Tweak without it', cancelledReply.cancelled === true && withoutScript.ok && noScriptBoost?.js === '' && noScriptBoost.jsEnabled === undefined)
    if (noScriptBoost) browser.dispatch({ type: 'boost/delete', id: noScriptBoost.id })
    importChoice = 'install'

    // ======================= themes as files =======================
    const spaceId = state().activeSpaceId
    const themeBefore = JSON.stringify(state().spaces.find((s) => s.id === spaceId)!.theme)
    const themePath = join(folder, 'theme.lucium-theme')
    writeFileSync(themePath, themeFileText(READY_THEMES[0]!.theme, 'Dracula'))
    toOpen = themePath
    const themeReply = await importThemeFromFile(env, spaceId)
    check('share: a theme file is shown, then applied to the space', themeReply.ok && JSON.stringify(state().spaces.find((s) => s.id === spaceId)!.theme) !== themeBefore)
    writeFileSync(themePath, JSON.stringify({ format: 1, kind: 'theme', code: 'luc1_bd93f9;}body{display:none}_custom_155_85_grain_10_light_vivid_dark' }))
    const themeAfter = JSON.stringify(state().spaces.find((s) => s.id === spaceId)!.theme)
    const badTheme = await importThemeFromFile(env, spaceId)
    check('share: a hostile theme file is refused and the theme stays', !badTheme.ok && JSON.stringify(state().spaces.find((s) => s.id === spaceId)!.theme) === themeAfter, badTheme.message)
    browser.dispatch({ type: 'space/update', id: spaceId, patch: { theme: JSON.parse(themeBefore) } })

    // ======================= a private window takes nothing =======================
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    let privateOpened = 0
    // Every dialog is replaced: if a private window ever got as far as one, the check fails instead of waiting for a person.
    const privEnv: ShareEnvironment = { ...shareEnvironment(priv.browser, priv.store, priv.win), chooseOpenFile: async () => (privateOpened++, exportPath), showProblem: async () => {}, confirmImport: async () => 'cancel', confirmThemeImport: async () => false }
    const mainBoosts = boostsNow()
    const privReply = await importBoostFromFile(privEnv)
    const fromFile = parseBoostFile(text)
    if (!fromFile.ok) throw new Error('the exported file does not read back')
    priv.browser.dispatch({ type: 'boost/import', id: 'private-1', boost: fromFile.boost })
    priv.browser.dispatch({ type: 'boost/save', boost: { id: 'private-2', host: '127.0.0.1', css: 'p{}' } })
    check('share: a private window refuses to import: no dialog, nothing read, no Tweak in the window, none in the main one', !privReply.ok && /fenêtre privée/.test(privReply.message) && privateOpened === 0 && priv.store.get().boosts.length === 0 && boostsNow() === mainBoosts, JSON.stringify(privReply))
    const privTheme = await importThemeFromFile({ ...privEnv, chooseOpenFile: async () => (privateOpened++, themePath) }, priv.store.get().spaces[0]!.id)
    check('share: …and a private window does not take a theme file either', !privTheme.ok && privateOpened === 0)
    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()
    win.emit('focus')

    // ======================= the switch: with sharing off nothing opens, nothing is read, nothing is written =======================
    browser.dispatch({ type: 'settings/update', patch: { boostSharing: false } })
    const opened = log.opened
    const offBoosts = boostsNow()
    const offReply = await importFile(exportPath)
    const offLink = await importBoostFromClipboard(env)
    browser.dispatch({ type: 'boost/import', id: 'off-1', boost: fromFile.boost })
    check('share: with the setting off, a request is refused with its reason, no dialog opens, and the reducer takes no Tweak', !offReply.ok && /désactivé/.test(offReply.message) && !offLink.ok && log.opened === opened && boostsNow() === offBoosts, JSON.stringify([offReply, offLink]))
    browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: 'importer une retouche' })
    await waitFor(() => evaluate<boolean>(ui, `document.querySelector('.palette-input')?.value.startsWith('importer une retouche') === true`), 4000)
    const barLabels = () => evaluate<string[]>(ui, `[...document.querySelectorAll('.results li .label')].map((el) => el.textContent)`)
    // The witness: the rows of that text drawn, which the bar ranks in one pass with the commands it offers (command-bar.ts).
    const ranked = await waitFor(async () => (await barLabels()).length > 0)
    check('share: …the command bar does not offer the commands', ranked && !(await barLabels()).some((label) => /Retouche copiée|Importer une Retouche|thème (depuis|de l’espace)/.test(label)), JSON.stringify(await barLabels()))
    browser.closeOverlay()
    browser.dispatch({ type: 'settings/update', patch: { boostSharing: true } })

    // ======================= the channel =======================
    check('share: the channels are registered handlers (the control for the next checks)', typeof realBoostShare === 'function' && typeof realThemeCode === 'function')
    browser.dispatch({ type: 'boost/save', boost: { id: 'share-smoke-ipc', host: '127.0.0.1', name: 'Canal', css: 'p { color: red }' } })
    const askUi = <T>(script: string) => evaluate<T>(ui, script)
    check('share: an unknown Tweak is answered "n’existe plus", without a dialog', JSON.stringify(await askUi(`window.lucium.boostShare({ kind: 'export-file', boostId: 'does-not-exist' })`)) === JSON.stringify({ ok: false, message: 'Cette Retouche n’existe plus.' }))
    check('share: a request with a path or a text in it is refused as invalid', JSON.stringify(await askUi(`window.lucium.boostShare({ kind: 'import-file', path: '/etc/passwd' })`)) === JSON.stringify({ ok: false, message: 'Demande invalide.' }) && JSON.stringify(await askUi(`window.lucium.boostShare({ kind: 'import-link', text: 'lucboost1_x' })`)) === JSON.stringify({ ok: false, message: 'Demande invalide.' }))
    check('share: a theme file request for a space that is gone is answered before any dialog, on the theme channel too', JSON.stringify(await askUi(`window.lucium.themeCode({ kind: 'import-file', spaceId: 'does-not-exist' })`)) === JSON.stringify({ ok: false, message: 'Cet espace n’existe plus.' }) && JSON.stringify(await askUi(`window.lucium.themeCode({ kind: 'export-file', spaceId: 'does-not-exist' })`)) === JSON.stringify({ ok: false, message: 'Cet espace n’existe plus.' }))
    const ipcCopy = await askUi<{ ok: boolean; message: string }>(`window.lucium.boostShare({ kind: 'copy-link', boostId: 'share-smoke-ipc' })`)
    check('share: copy-link through the channel puts a link that reads back as the Tweak on the clipboard', ipcCopy.ok && anySpace(/^Lien de la Retouche « Canal » copié$/).test(ipcCopy.message) && (await clipboard.readText()).startsWith('lucboost1_'), JSON.stringify(ipcCopy))
    browser.dispatch({ type: 'boost/delete', id: 'share-smoke-ipc' })

    // With the window's lock held by a request waiting for its file dialog, a request that would open a dialog is answered "en cours" instead:
    // nothing real opens while a page that is not ours asks.
    let release: (path: string | null) => void = () => {}
    const pending = new Promise<string | null>((resolve) => (release = resolve))
    const held = importBoostFromFile({ ...env, chooseOpenFile: () => pending })
    await sleep(80)
    const busyReply = await askUi<{ ok: boolean; message: string }>(`window.lucium.boostShare({ kind: 'import-file' })`)
    check('share: one request at a time: a second one is answered at once while a dialog is open', !busyReply.ok && /déjà en cours/.test(busyReply.message), JSON.stringify(busyReply))
    const stranger = new ElectronWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true } })
    try {
      await stranger.loadURL(`${base}/stranger`)
      const hasApi = await evaluate<boolean>(stranger.webContents, `typeof window.lucium?.boostShare === 'function'`)
      warnings.length = 0
      const refused = await evaluate<{ ok: boolean; message: string } | undefined>(stranger.webContents, `window.lucium.boostShare({ kind: 'import-file' })`)
      const refusedTheme = await evaluate<{ ok: boolean; message: string } | undefined>(stranger.webContents, `window.lucium.themeCode({ kind: 'import-file', spaceId: ${JSON.stringify(state().activeSpaceId)} })`)
      check('share: a page that is not one of our surfaces is refused on both channels (and the refusal is logged)', hasApi && refused === undefined && refusedTheme === undefined && warnings.filter((w) => w.includes('untrusted sender')).length >= 2, JSON.stringify([refused, refusedTheme, warnings.length]))
    } finally {
      stranger.destroy()
      release(null)
      await held
    }

    // ======================= every way in sends its request =======================
    const calls: unknown[] = []
    const themeCalls: unknown[] = []
    const recorder = async (_event: unknown, raw: unknown) => {
      calls.push(raw)
      return { ok: true, message: '' }
    }
    handlers.set(Channel.boostShare, recorder)
    handlers.set(Channel.themeCode, async (_event, raw) => {
      themeCalls.push(raw)
      return { ok: true, message: '' }
    })
    // The command bar.
    const barRows = () => evaluate<string[]>(ui, `[...document.querySelectorAll('.results li .label')].map((el) => el.textContent)`)
    const clickRow = (label: string) => evaluate<boolean>(ui, `(() => { const li = [...document.querySelectorAll('.results li[role="option"]')].find((el) => el.querySelector('.label')?.textContent === ${JSON.stringify(label)}); if (!li) return false; li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true })()`)
    const fromBar = async (query: string, label: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 4; attempt++) {
        // The bar of the check « with sharing off » was opened on the same words: once put away, it must be gone from the page before it is opened again, or
        // its field already holds the query and its rows (drawn again when sharing came back on) are taken for those of the new bar.
        browser.closeOverlay()
        await waitFor(() => evaluate<boolean>(ui, `!document.querySelector('.palette-input')`), 2000)
        browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: query })
        // The page keeps what it showed last until the request reaches it: its field must hold this query before the rows are believed.
        const fresh = await waitFor(() => evaluate<boolean>(ui, `document.querySelector('.palette-input')?.value.startsWith(${JSON.stringify(query)}) === true`), 4000)
        if (fresh && (await waitFor(async () => (await barRows()).includes(label), 4000))) return clickRow(label)
        console.error(`[smoke-share] the bar showed ${JSON.stringify(await barRows())} for "${query}" (attempt ${attempt + 1})`)
        browser.closeOverlay()
        await sleep(300)
      }
      return false
    }
    const importClicked = await fromBar('importer une retouche', 'Importer une Retouche…')
    check('share: the command bar offers "Importer une Retouche…" and sends the request', importClicked && (await waitFor(() => JSON.stringify(calls.at(-1)) === '{"kind":"import-file"}')), `clicked ${importClicked} ${JSON.stringify(calls)} panel ${browser.currentPanel()}`)
    await waitFor(() => browser.currentPanel() === null)
    check('share: …and "Coller une Retouche copiée"', (await fromBar('coller une retouche', 'Coller une Retouche copiée')) && (await waitFor(() => JSON.stringify(calls.at(-1)) === '{"kind":"import-link"}')), JSON.stringify(calls))
    await waitFor(() => browser.currentPanel() === null)
    const importTheme = (await fromBar('importer un thème', 'Importer un thème depuis un fichier…')) && (await waitFor(() => JSON.stringify(themeCalls.at(-1)) === JSON.stringify({ kind: 'import-file', spaceId })))
    await waitFor(() => browser.currentPanel() === null)
    const exportTheme = (await fromBar('exporter le thème', 'Exporter le thème de l’espace dans un fichier…')) && (await waitFor(() => JSON.stringify(themeCalls.at(-1)) === JSON.stringify({ kind: 'export-file', spaceId })))
    check('share: …and the two theme files, for the space on screen', importTheme && exportTheme, JSON.stringify(themeCalls))
    await waitFor(() => browser.currentPanel() === null)

    // The editor's title menu.
    browser.dispatch({ type: 'boost/save', boost: { id: 'share-smoke-menu', host: '127.0.0.1', name: 'Menu', css: 'p { color: red }' } })
    browser.openOverlay({ panel: 'boost', host: '127.0.0.1', id: 'share-smoke-menu' })
    await waitFor(() => evaluate<boolean>(ui, `!!document.querySelector('.bx-title')`))
    await evaluate(ui, `document.querySelector('.bx-title')?.click()`)
    const items = await evaluate<string[]>(ui, `[...document.querySelectorAll('.bx-menu-item')].map((b) => b.textContent)`)
    check(
      'share: the title menu keeps its five entries and its last, and gains the four sharing entries',
      items.slice(0, 5).join('|') === 'Renommer cette Retouche…|Mélanger|Réinitialiser toutes les modifications|Désactiver cette Retouche|Supprimer cette Retouche' &&
        items.at(-1) === 'Nouvelle Retouche' &&
        ['Exporter cette Retouche dans un fichier…', 'Copier le lien de cette Retouche', 'Importer une Retouche depuis un fichier…', 'Coller une Retouche copiée'].every((label) => items.includes(label)),
      items.join('|')
    )
    const press = async (label: string) => {
      await evaluate(ui, `(() => { if (!document.querySelector('.bx-menu')) document.querySelector('.bx-title')?.click() })()`)
      await sleep(80)
      await evaluate(ui, `[...document.querySelectorAll('.bx-menu-item')].find((b) => b.textContent === ${JSON.stringify(label)})?.click()`)
      await sleep(200)
    }
    await press('Exporter cette Retouche dans un fichier…')
    await press('Copier le lien de cette Retouche')
    await press('Importer une Retouche depuis un fichier…')
    await press('Coller une Retouche copiée')
    check(
      'share: each sharing entry of the editor sends its request (the Tweak is the one on screen)',
      JSON.stringify(calls.slice(-4)) === JSON.stringify([{ kind: 'export-file', boostId: 'share-smoke-menu' }, { kind: 'copy-link', boostId: 'share-smoke-menu' }, { kind: 'import-file' }, { kind: 'import-link' }]),
      JSON.stringify(calls.slice(-4))
    )
    // A request that fails in the main process: the editor and the command bar log it with its context, and Settings says so under its group.
    handlers.set(Channel.boostShare, async () => {
      throw new Error('forced: the share failed')
    })
    surfaceMessages.length = 0
    await press('Importer une Retouche depuis un fichier…')
    check('share: when the request fails, the editor logs it with its context (and stays open)', await waitFor(() => surfaceMessages.some((m) => m.includes('[boost] sharing failed:'))) && (await evaluate<boolean>(ui, `!!document.querySelector('.bx')`)), surfaceMessages.join(' | ').slice(0, 300))
    browser.closeOverlay()
    surfaceMessages.length = 0
    check('share: …and so does the command bar', (await fromBar('importer une retouche', 'Importer une Retouche…')) && (await waitFor(() => surfaceMessages.some((m) => m.includes('[boost] sharing failed:')))), surfaceMessages.join(' | ').slice(0, 300))
    await waitFor(() => browser.currentPanel() === null)
    browser.dispatch({ type: 'boost/delete', id: 'share-smoke-menu' })
    handlers.set(Channel.boostShare, recorder)

    // Settings › Extensions and tools › More settings › Tweak sharing.
    const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
    await waitFor(() => browser.snapshot().toast === null && browser.currentPanel() === null, 20_000)
    // The group is in the category « Extensions et outils », in « Plus de réglages » (opened); the title of a group carries the number of its settings
    // (« Partage des Retouches2 »), so it is read by its beginning.
    browser.openOverlay({ panel: 'settings', pane: 'tools', anchor: 'extensions' })
    await waitFor(() => settingsWindows().length === 1)
    const settingsWc = settingsWindows()[0]!.webContents
    await waitFor(async () => evaluate<boolean>(settingsWc, `[...document.querySelectorAll('.pref-section > h3')].some((h) => h.textContent.startsWith('Partage des Retouches'))`), 10_000)
    await waitFor(() => evaluate<boolean>(settingsWc, OPEN_MORE_SETTINGS), 3000)
    const groups = await evaluate<string[]>(settingsWc, `[...document.querySelectorAll('.pref-section > h3')].map((h) => h.textContent)`)
    const sharing = groups.findIndex((g) => g.startsWith('Partage des Retouches'))
    check('share: Réglages › Extensions et outils has the group “Partage des Retouches”, after the extensions', sharing > groups.findIndex((g) => g.startsWith('Extensions')) && sharing > -1, groups.join('|'))
    const clickButton = (label: string) => evaluate<boolean>(settingsWc, `(() => { const b = [...document.querySelectorAll('.pref-row .button')].find((el) => el.textContent === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true })()`)
    check('share: its two buttons send the import requests', (await clickButton('Importer une Retouche…')) && (await waitFor(() => JSON.stringify(calls.at(-1)) === '{"kind":"import-file"}')) && (await clickButton('Coller une Retouche')) && (await waitFor(() => JSON.stringify(calls.at(-1)) === '{"kind":"import-link"}')), JSON.stringify(calls.slice(-2)))
    handlers.set(Channel.boostShare, async () => {
      throw new Error('forced: the share failed')
    })
    await clickButton('Importer une Retouche…')
    // The group has other messages of the same role (« Tous mes boosts · N »): the sentence is looked for among all of them.
    check('share: when the request fails, Settings says so under its group', await waitFor(() => evaluate<boolean>(settingsWc, `[...([...document.querySelectorAll('.pref-section')].find((el) => el.querySelector('h3')?.textContent.startsWith('Partage des Retouches'))?.querySelectorAll('[role=status]') ?? [])].some((el) => el.textContent.includes('Le partage a échoué'))`)))
    const choose = (value: string) => evaluate(settingsWc, `(() => { const el = document.querySelector('select[aria-label="Importer une Retouche qui contient du JavaScript"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    const selected = () => evaluate<string>(settingsWc, `document.querySelector('select[aria-label="Importer une Retouche qui contient du JavaScript"]')?.value ?? ''`)
    const defaultChoice = await selected()
    await choose('never')
    check('share: the script setting is “ask” by default and “never” can be chosen', defaultChoice === 'ask' && (await waitFor(() => state().settings.boostScriptImport === 'never')) && (await waitFor(async () => (await selected()) === 'never')))
    await choose('ask')
    await waitFor(() => state().settings.boostScriptImport === 'ask')
    settingsWindows()[0]?.close()
    await waitFor(() => settingsWindows().length === 0)
  } finally {
    ui.off('console-message', listen)
    handlers.set(Channel.boostShare, realBoostShare as never)
    handlers.set(Channel.themeCode, realThemeCode as never)
    console.warn = realWarn
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    for (const b of state().boosts) if (!boostsBefore.has(b.id)) browser.dispatch({ type: 'boost/delete', id: b.id })
    browser.dispatch({ type: 'settings/update', patch: { boostScriptImport: settingsBefore } })
    browser.closeOverlay()
    await clipboard.writeText(keptClipboard)
    rmSync(folder, { recursive: true, force: true })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=share`: only these checks, with their own report. */
export async function runShareSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeShare(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeShare ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SHARE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
