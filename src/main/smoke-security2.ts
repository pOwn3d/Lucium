// Engine checks for three security features, run inside a real Electron:
//  - the encrypted export: "Exporter les données" through the interface's own route (plain and sealed), the file on disk (a sealed envelope
//    that shows nothing, owner-only), the Settings controls (a real click and real keys), Help › Restore Data… with the passphrase panel (wrong
//    phrase, right phrase, giving up, an altered file), and the lock left out of the file;
//  - the lock of a space and of the application: pages gone and none made, the state the interface is given (a skeleton), the lock screen
//    and its phrase (real keys), the delay after wrong phrases, Touch ID simulated (no prompt of the system), the menu, the messages the interface
//    may no longer send, the power events, a private window, the file of the phrase, a restart, and the setting that cannot be changed from the interface;
//  - the pages of a reopened tab: `navigationHistory.restore` on this Electron, the bound of 20 pages, the setting off by default.
// A local server counts the requests of each page. Called from the engine smoke test: `await smokeSecurity2(ctx, check)`;
// `LUCIUM_SMOKE_ONLY=security2` runs only this file with its own report.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow as ElectronWindow, Menu, dialog, powerMonitor, type MenuItem, type WebContents } from 'electron'
import { parseSavedState } from '@shared/sidebar'
import type { Settings, SidebarState } from '@shared/model'
import type { LockReply } from '@shared/lock'
import { copyDataOf } from '@shared/session-backups'
import { EXPORT_FORMAT, encryptExport } from './export-crypto'
import { LockService, NO_TOUCH_ID, getLockService, type TouchIdPort } from './lock-service'
import { LockStore } from './lock-store'
import { restoreData } from './shell/menu-actions'
import { getWindowManager } from './shell/windows'
import type { SmokeContext } from './smoke'
import { noteCheck, OPEN_MORE_SETTINGS, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const stamp = (): string => new Date().toISOString().slice(11, 23)
/** What the suite is doing, with the time: the last line of a run that stops tells where. */
const trace = (message: string): void => console.log(`[security2] ${stamp()} ${message}`)

/** `promise`, or a rejection after `ms`: nothing the suite waits for can keep it waiting for ever. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

const waitFor = waiterOf(10_000, 60)

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const EVALUATE_MS = 20_000
const evaluate = <T>(wc: WebContents, script: string): Promise<T> => within(wc.executeJavaScript(script) as Promise<T>, EVALUATE_MS, `the page (${script.slice(0, 60).replace(/\s+/g, ' ')})`)

const rectOf = (wc: WebContents, selector: string, text?: string): Promise<Rect | null> =>
  evaluate(
    wc,
    `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = ${text === undefined ? 'els[0]' : `els.find((e) => (e.getAttribute('aria-label') || e.textContent).trim().includes(${JSON.stringify(text)}))`}
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`
  )

/** A left click with real mouse events, in the middle of the box. */
async function clickOn(wc: WebContents, selector: string, text?: string): Promise<boolean> {
  let rect: Rect | null = null
  for (let i = 0; i < 40 && !(rect && rect.width > 0); i++) {
    rect = await rectOf(wc, selector, text)
    if (!(rect && rect.width > 0)) await sleep(100)
  }
  if (!rect) return false
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  await sleep(200)
  return true
}

async function typeKeys(wc: WebContents, text: string): Promise<void> {
  for (const ch of text) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await sleep(15)
  }
  await sleep(80)
}

async function pressKey(wc: WebContents, keyCode: string): Promise<void> {
  wc.sendInputEvent({ type: 'keyDown', keyCode })
  wc.sendInputEvent({ type: 'keyUp', keyCode })
  await sleep(150)
}

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

const PHRASE = 'phrase du verrou numéro un'
const EXPORT_PHRASE = 'phrase pour exporter ceci'

export async function smokeSecurity2(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView, engine } = ctx
  const ui = win.webContents
  const overlay = overlayView.webContents
  const userData = app.getPath('userData')
  const work = mkdtempSync(join(tmpdir(), 'lucium-security2-'))
  const lock = getLockService()
  if (!lock) throw new Error('the lock service was not set up')

  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const key = `${url.pathname}${url.search}`
    hits.set(key, (hits.get(key) ?? 0) + 1)
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    res.end(`<title>sec ${key}</title><body>page ${key}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const hitsOf = (path: string) => hits.get(path) ?? 0

  const originalSpace = store.get().activeSpaceId
  const originalSettings: Settings = { ...store.get().settings }
  const mine = new Set<string>()
  const createdSpaces: string[] = []
  const listenersBefore = (['suspend', 'resume', 'lock-screen'] as const).map((event) => powerMonitor.listenerCount(event))
  const realDialogs = { open: dialog.showOpenDialog, save: dialog.showSaveDialog, error: dialog.showErrorBox, message: dialog.showMessageBox }
  let savePath: string | null = null
  let openPath: string | null = null
  const errors: Array<{ title: string; content: string }> = []
  Object.assign(dialog, {
    showSaveDialog: async () => ({ canceled: savePath === null, filePath: savePath ?? undefined }),
    showOpenDialog: async () => ({ canceled: openPath === null, filePaths: openPath ? [openPath] : [] }),
    showErrorBox: (title: string, content: string) => void errors.push({ title, content }),
    showMessageBox: async () => ({ response: 0, checkboxChecked: false })
  })

  const call = <T>(wc: WebContents, expression: string): Promise<T> => evaluate<T>(wc, expression)
  const lockCall = (config: unknown): Promise<LockReply> => call<LockReply>(ui, `window.lucium.lockConfigure(${JSON.stringify(config)})`)
  const unlockCall = (request: unknown): Promise<LockReply> => call<LockReply>(ui, `window.lucium.lockUnlock(${JSON.stringify(request)})`)
  const lockView = () => browser.snapshot().lock
  const plainTab = async (path: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const tab = store.get().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => hitsOf(path) > 0 && browser.snapshot().runtime.tabs[tab.id]?.loading === false)
    await sleep(120)
    return tab.id
  }
  const tabUrl = (id: string) => store.get().tabs.find((t) => t.id === id)?.url
  const loaded = async (id: string, path: string) => {
    await waitFor(() => tabUrl(id) === `${base}${path}` && browser.snapshot().runtime.tabs[id]?.loading === false)
    await sleep(100)
  }
  const navigate = async (id: string, path: string) => {
    browser.pageFor(id)!.loadURL(`${base}${path}`)
    await loaded(id, path)
  }
  const entriesOf = (id: string) => browser.pageFor(id)?.navigationEntries()
  const settingsWindow = () => ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')

  try {
    let tabForExport = ''
    const stateText = (path: string) => readFileSync(path, 'utf8')
    // A section that throws (a wait that never ends) is a failed check, and the next section still runs.
    /** Waits for a restore to end; when it does not, that is a failed check, the panel is closed (which answers "gave up"), and the suite goes on. */
    const finish = async (run: Promise<void>, what: string): Promise<void> => {
      try {
        await within(run, 30_000, what)
      } catch (error) {
        check(`restore: ${what} ended`, false, String((error as Error).message))
        browser.closeOverlay()
        await within(run, 5_000, `${what} after closing the panel`).catch((later: unknown) => trace(`still pending: ${String((later as Error).message)}`))
      }
    }
    const section = async (name: string, run: () => Promise<void>): Promise<void> => {
      trace(name)
      try {
        await run()
      } catch (error) {
        check(`${name}: ran to the end`, false, String((error as Error)?.stack ?? error))
        browser.closeOverlay()
      }
    }

    // ================= the encrypted export =================
    await section('n° 59 : the encrypted export', async () => {
      tabForExport = await plainTab('/export-secret-page')

      savePath = join(work, 'plain.json')
      const plainReply = await call<{ ok: boolean; path?: string; encrypted?: boolean }>(ui, 'window.lucium.exportData()')
      const plain = plainReply.ok ? (JSON.parse(stateText(savePath)) as { version?: number; settings?: Record<string, unknown> }) : null
      check('export: without a passphrase the file is the plain JSON of before', plainReply.ok === true && plainReply.encrypted === false && plain?.version === 1 && stateText(savePath).includes('export-secret-page'), JSON.stringify(plainReply))

      savePath = join(work, 'sealed.json')
      const sealedReply = await call<{ ok: boolean; path?: string; encrypted?: boolean; message?: string }>(ui, `window.lucium.exportData({ passphrase: ${JSON.stringify(EXPORT_PHRASE)} })`)
      const sealedText = existsSync(savePath) ? stateText(savePath) : ''
      const envelope = sealedText ? (JSON.parse(sealedText) as { format?: string; version?: number; kdf?: { N?: number; name?: string }; cipher?: { name?: string } }) : null
      check('export: with a passphrase the file is a versioned AES-256-GCM envelope with scrypt', sealedReply.ok === true && sealedReply.encrypted === true && envelope?.format === EXPORT_FORMAT && envelope.version === 1 && envelope.kdf?.name === 'scrypt' && envelope.kdf.N === 2 ** 17 && envelope.cipher?.name === 'aes-256-gcm', JSON.stringify(sealedReply))
      check('export: the sealed file shows neither the passphrase nor a word of the content', sealedText.length > 0 && !sealedText.includes('export-secret-page') && !sealedText.includes(EXPORT_PHRASE) && !sealedText.includes('Perso') && !sealedText.includes('127.0.0.1'))
      check('export: the file can be read by its owner only', existsSync(savePath) && (statSync(savePath).mode & 0o077) === 0, existsSync(savePath) ? (statSync(savePath).mode & 0o777).toString(8) : 'absent')

      savePath = join(work, 'weak.json')
      const weak = await call<{ ok: boolean; message?: string }>(ui, `window.lucium.exportData({ passphrase: 'court' })`)
      check('export: a passphrase that is too short is refused with a sentence, and no file is written', weak.ok === false && /au moins 8/.test(weak.message ?? '') && !existsSync(savePath), JSON.stringify(weak))
      const hostile = await call<{ ok: boolean }>(ui, `window.lucium.exportData({ passphrase: 42 })`)
      check('export: a request that is not a passphrase is refused', hostile.ok === false)
      savePath = null
      const cancelled = await call<unknown>(ui, 'window.lucium.exportData({ passphrase: "une phrase assez longue" })')
      check('export: cancelling the dialog writes nothing and answers null', cancelled === null)

      // The controls of Settings › Téléchargements et fichiers (the export is the last part of its « Plus de réglages »), with a real click and real keys.
      trace('The controls of Settings › Téléchargements et fichiers, with a real click and real keys.')
      savePath = join(work, 'from-settings.json')
      browser.openOverlay({ panel: 'settings', pane: 'files' })
      await waitFor(() => settingsWindow() !== undefined)
      const sw = settingsWindow()!.webContents
      await waitFor(async () => (await evaluate<boolean>(sw, `!!document.querySelector('input[aria-label="Chiffrer l’export avec une phrase secrète"]')`)) === true)
      await waitFor(() => evaluate<boolean>(sw, OPEN_MORE_SETTINGS), 3000)
      check('export: Settings › Téléchargements et fichiers offers to seal the export, and no passphrase field is there until it is asked for', (await evaluate<boolean>(sw, `!document.querySelector('input[aria-label="Phrase secrète"]')`)) === true)
      await clickOn(sw, 'input[aria-label="Chiffrer l’export avec une phrase secrète"]')
      const fieldsShown = await waitFor(async () => (await evaluate<boolean>(sw, `!!document.querySelector('input[aria-label="Phrase secrète"]') && !!document.querySelector('input[aria-label="Confirmer la phrase secrète"]')`)) === true)
      check('export: ticking the box shows the two password fields', fieldsShown)
      await clickOn(sw, 'input[aria-label="Phrase secrète"]')
      await typeKeys(sw, EXPORT_PHRASE)
      await clickOn(sw, 'input[aria-label="Confirmer la phrase secrète"]')
      await typeKeys(sw, `${EXPORT_PHRASE}x`)
      await clickOn(sw, 'button', 'Exporter les données')
      const mismatch = await waitFor(async () => /ne sont pas identiques/.test(await evaluate<string>(sw, `document.querySelector('.pref-error')?.textContent ?? ''`)))
      check('export: two different phrases are refused in the panel, before anything is sent', mismatch && !existsSync(savePath))
      await clickOn(sw, 'input[aria-label="Confirmer la phrase secrète"]')
      await pressKey(sw, 'End')
      await pressKey(sw, 'Backspace')
      await clickOn(sw, 'button', 'Exporter les données')
      const done = await waitFor(() => existsSync(savePath!))
      const noteText = () => evaluate<string>(sw, `[...document.querySelectorAll('.pref-note')].map((e) => e.textContent).join('\\n')`)
      check('export: a real click on "Exporter les données" with a good phrase writes the sealed file', done && (JSON.parse(stateText(savePath)) as { format?: string }).format === EXPORT_FORMAT)
      check('export: the panel says where it was saved and that the phrase cannot be found again', await waitFor(async () => /Enregistré dans .*from-settings\.json.*chiffré/.test(await noteText())), await noteText())
      const wiped = await evaluate<boolean>(sw, `[...document.querySelectorAll('input[type="password"]')].every((e) => e.value === '')`)
      check('export: the phrase is wiped from the page as soon as the export has answered', wiped)

      // Help › Restore Data… from a sealed file, with the passphrase panel. The file differs from the state in one harmless setting.
      trace('Help › Restore Data… from a sealed file, with the passphrase panel. Th')
      const flipped = !store.get().settings.tidyDownloads
      const toRestore = { ...JSON.parse(stateText(join(work, 'plain.json'))), settings: { ...(plain?.settings ?? {}), tidyDownloads: flipped } } as unknown
      const restorable = join(work, 'restorable.json')
      writeFileSync(restorable, await encryptExport(JSON.stringify(toRestore), EXPORT_PHRASE, { params: { N: 2 ** 14, r: 8, p: 1 } }))
      settingsWindow()?.close()
      openPath = restorable
      const copiesBefore = new Set(readdirSync(userData).filter((n) => n.includes('.avant-restauration-')))
      const focused = getWindowManager().focused()
      const restoring = restoreData({ win: focused.win, browser: focused.browser, store: focused.store })
      const asked = await waitFor(() => browser.currentPanel() === 'passphrase')
      check('restore: a sealed file makes the window ask for its passphrase in a panel', asked)
      // The panel is an invite of the templates (PassphrasePrompt.tsx): its banner says what went wrong.
      const panelText = () => evaluate<string>(overlay, `document.querySelector('.passphrase-prompt')?.innerText ?? ''`)
      check('restore: the panel is a password field, and nothing has been restored yet', (await evaluate<boolean>(overlay, `document.querySelector('input[name="passphrase"]')?.type === 'password'`)) && store.get().settings.tidyDownloads !== flipped)
      overlay.focus()
      await typeKeys(overlay, 'une mauvaise phrase')
      trace(`typed in the passphrase panel: ${await evaluate<number>(overlay, `document.querySelector('input[name="passphrase"]')?.value.length ?? -1`)} characters`)
      await pressKey(overlay, 'Return')
      const again = await waitFor(async () => browser.currentPanel() === 'passphrase' && /incorrecte/.test(await panelText()))
      check('restore: a wrong passphrase brings the panel back, saying so', again, await panelText())
      await typeKeys(overlay, EXPORT_PHRASE)
      await pressKey(overlay, 'Return')
      await finish(restoring, 'Help › Restore Data… (right passphrase)')
      check('restore: the right passphrase restores the file (a copy of what it replaces is made first)', store.get().settings.tidyDownloads === flipped && readdirSync(userData).some((n) => n.includes('.avant-restauration-') && !copiesBefore.has(n)), String(store.get().settings.tidyDownloads))
      check('restore: nothing of the passphrase is left in the state on disk', !JSON.stringify(store.get()).includes(EXPORT_PHRASE))
      browser.dispatch({ type: 'settings/update', patch: { tidyDownloads: originalSettings.tidyDownloads } })

      // Giving up, and an altered file.
      trace('Giving up, and an altered file.')
      const stateBefore = JSON.stringify(store.get().settings)
      const giving = restoreData({ win: focused.win, browser: focused.browser, store: focused.store })
      await waitFor(() => browser.currentPanel() === 'passphrase')
      overlay.focus()
      await pressKey(overlay, 'Escape')
      await finish(giving, 'Help › Restore Data… (giving up)')
      check('restore: giving up the question restores nothing and shows no error', JSON.stringify(store.get().settings) === stateBefore && errors.length === 0 && browser.currentPanel() === null, JSON.stringify(errors))
      const envelopeOfRestorable = JSON.parse(stateText(restorable)) as { data: string }
      const bytes = Buffer.from(envelopeOfRestorable.data, 'base64')
      bytes[12] = bytes[12]! ^ 1
      const altered = join(work, 'altered.json')
      writeFileSync(altered, JSON.stringify({ ...envelopeOfRestorable, data: bytes.toString('base64') }))
      openPath = altered
      const alteredRun = restoreData({ win: focused.win, browser: focused.browser, store: focused.store })
      await waitFor(() => browser.currentPanel() === 'passphrase')
      overlay.focus()
      await typeKeys(overlay, EXPORT_PHRASE)
      await pressKey(overlay, 'Return')
      await finish(alteredRun, 'Help › Restore Data… (altered file)')
      check('restore: an altered file is refused with the reason, and nothing is restored', errors.some((e) => /altéré/.test(e.content)) && JSON.stringify(store.get().settings) === stateBefore, JSON.stringify(errors))
      openPath = null
    })

    // ================= the pages of a reopened tab =================
    await section('n° 65 : the pages of a reopened tab', async () => {
      browser.dispatch({ type: 'tab/close', id: tabForExport })
      mine.delete(tabForExport)
      check('reopen: the setting is off by default and the archive keeps no page then', originalSettings.reopenHistory === false)
      const plainTabId = await plainTab('/h1')
      await navigate(plainTabId, '/h2')
      await navigate(plainTabId, '/h3')
      browser.dispatch({ type: 'tab/archive', id: plainTabId })
      mine.delete(plainTabId)
      const offEntry = store.get().archive[0]
      check('reopen: with the setting off, the archive entry has an address and no page list', offEntry?.url === `${base}/h3` && offEntry.history === undefined)
      browser.dispatch({ type: 'archive/restore-last' })
      const offTab = store.get().tabs.at(-1)!
      mine.add(offTab.id)
      await loaded(offTab.id, '/h3')
      check('reopen: with the setting off, the tab reopens as before, at its address alone', entriesOf(offTab.id)?.entries.length === 1 && entriesOf(offTab.id)?.index === 0, JSON.stringify(entriesOf(offTab.id)))
      browser.dispatch({ type: 'tab/close', id: offTab.id })
      browser.dispatch({ type: 'archive/clear' })
      mine.delete(offTab.id)

      browser.dispatch({ type: 'settings/update', patch: { reopenHistory: true } })
      const a = await plainTab('/r1')
      await navigate(a, '/r2')
      await navigate(a, '/r3')
      browser.dispatch({ type: 'tab/archive', id: a })
      mine.delete(a)
      const kept = store.get().archive[0]
      check('reopen: with the setting on, the archive entry keeps the three pages and where the tab was', kept?.history?.entries.map((e) => e.url).join() === [`${base}/r1`, `${base}/r2`, `${base}/r3`].join() && kept.history.index === 2, JSON.stringify(kept?.history))
      const before = { r1: hitsOf('/r1'), r2: hitsOf('/r2'), r3: hitsOf('/r3') }
      browser.dispatch({ type: 'archive/restore-last' })
      const b = store.get().tabs.at(-1)!
      mine.add(b.id)
      const replayed = await waitFor(() => (entriesOf(b.id)?.entries.length ?? 0) === 3 && browser.snapshot().runtime.tabs[b.id]?.loading === false)
      const replay = entriesOf(b.id)
      check('reopen: navigationHistory.restore on this Electron brings the three pages back, on the last one', replayed && replay?.index === 2 && replay.entries.map((e) => e.url).join() === [`${base}/r1`, `${base}/r2`, `${base}/r3`].join(), JSON.stringify(replay))
      check('reopen: only the page the tab is on was fetched again', hitsOf('/r3') === before.r3 + 1 && hitsOf('/r1') === before.r1 && hitsOf('/r2') === before.r2, JSON.stringify({ r1: hitsOf('/r1') - before.r1, r2: hitsOf('/r2') - before.r2, r3: hitsOf('/r3') - before.r3 }))
      check('reopen: the toolbar can go back, and Back lands on the previous page', browser.snapshot().runtime.tabs[b.id]?.canGoBack === true || (await waitFor(() => browser.snapshot().runtime.tabs[b.id]?.canGoBack === true)), JSON.stringify(browser.snapshot().runtime.tabs[b.id]))
      browser.nav('back')
      check('reopen: Back goes to the second page', await waitFor(() => tabUrl(b.id) === `${base}/r2`), tabUrl(b.id))
      check('reopen: the entry is spent and the archive no longer lists it', !store.get().archive.some((e) => e.id === kept?.id))
      browser.dispatch({ type: 'tab/close', id: b.id })
      mine.delete(b.id)

      // The bound, and the engine's own refusal of anything but web addresses.
      trace('The bound, and the engine’s own refusal of anything but web addresses.')
      const c = await plainTab('/long-0')
      for (let i = 1; i <= 24; i++) await navigate(c, `/long-${i}`)
      browser.dispatch({ type: 'tab/archive', id: c })
      mine.delete(c)
      const longEntry = store.get().archive[0]
      check('reopen: at most 20 pages are kept, ending on the page the tab was on', longEntry?.history?.entries.length === 20 && longEntry.history.entries.at(-1)?.url === `${base}/long-24` && longEntry.history.index === 19, String(longEntry?.history?.entries.length))
      browser.dispatch({ type: 'archive/restore-last' })
      const d = store.get().tabs.at(-1)!
      mine.add(d.id)
      await waitFor(() => (entriesOf(d.id)?.entries.length ?? 0) === 20 && browser.snapshot().runtime.tabs[d.id]?.loading === false)
      check('reopen: the 20 pages come back', entriesOf(d.id)?.entries.length === 20 && entriesOf(d.id)?.index === 19, JSON.stringify({ n: entriesOf(d.id)?.entries.length, index: entriesOf(d.id)?.index }))
      const refused = await browser
        .pageFor(d.id)!
        .restoreClosedHistory([{ url: 'file:///etc/hosts', title: 'x' }, { url: `${base}/ok`, title: 'y' }], 1)
        .then(() => 'accepted', (error: Error) => error.message)
      check('reopen: the engine refuses to replay a list that holds an address that is not a web page', /not a list of web addresses/.test(refused), refused)
      browser.dispatch({ type: 'tab/close', id: d.id })
      mine.delete(d.id)

      // A tab put to sleep has no page to read: its entry keeps the address alone, and nothing fails.
      trace('A tab put to sleep has no page to read: its entry keeps the address al')
      const e = await plainTab('/s1')
      await navigate(e, '/s2')
      // The tab on screen is never put to sleep: another one takes its place.
      const elsewhere = await plainTab('/s-elsewhere')
      const slept = await within(browser.sleepNow(e), 20_000, 'putting a tab to sleep')
      const warningsBefore = errors.length
      browser.dispatch({ type: 'tab/archive', id: e })
      mine.delete(e)
      check('reopen: a tab that was asleep is archived with its address alone', slept && !browser.livePageIds().includes(e) && store.get().archive[0]?.history === undefined && store.get().archive[0]?.url === `${base}/s2` && errors.length === warningsBefore, JSON.stringify({ slept, history: store.get().archive[0]?.history, url: store.get().archive[0]?.url, errors: errors.length - warningsBefore }))

      browser.dispatch({ type: 'tab/close', id: elsewhere })
      mine.delete(elsewhere)
      browser.dispatch({ type: 'settings/update', patch: { reopenHistory: false } })
      check('reopen: switching the setting off lets go of the pages kept in the archive', store.get().archive.every((entry) => entry.history === undefined))
      browser.dispatch({ type: 'archive/clear' })
    })

    // ================= the lock =================
    await section('n° 63 : the lock', async () => {
      check('lock: while it is off nothing about it reaches the interface and nothing listens', lockView() === undefined && lock.view() === undefined && (['suspend', 'resume', 'lock-screen'] as const).every((event, i) => powerMonitor.listenerCount(event) === listenersBefore[i]))
      check('lock: the menu has no "Verrouiller maintenant" while it is off', findMenuItem('Verrouiller maintenant') === undefined)

      const lockFile = join(userData, 'lock.json')
      const weakPhrase = await lockCall({ op: 'set-phrase', phrase: 'court' })
      check('lock: a phrase that is too short is refused', weakPhrase.ok === false && !existsSync(lockFile), JSON.stringify(weakPhrase))
      const set = await lockCall({ op: 'set-phrase', phrase: PHRASE })
      check('lock: choosing a phrase switches the lock on', set.ok === true && store.get().settings.lockEnabled === true && lockView()?.active === true, JSON.stringify(set))
      const lockText = existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : ''
      check('lock: the file holds a hash, owner-only, and not the phrase', lockText.includes('"hash"') && !lockText.includes(PHRASE) && !lockText.includes('verrou') && (statSync(lockFile).mode & 0o077) === 0)
      store.flush()
      const savedState = readFileSync(join(userData, 'state.json'), 'utf8')
      check('lock: nothing of the phrase or its hash is in the state on disk', !savedState.includes(PHRASE) && !savedState.includes(JSON.parse(lockText).hash as string))
      check('lock: now the menu offers "Verrouiller maintenant" and the interface knows the lock', findMenuItem('Verrouiller maintenant') !== undefined && lockView()?.appLocked === false)
      check('lock: its listeners are there now (suspend, resume, screen lock)', (['suspend', 'resume', 'lock-screen'] as const).every((event, i) => powerMonitor.listenerCount(event) === listenersBefore[i]! + 1))

      savePath = join(work, 'after-lock.json')
      await call(ui, 'window.lucium.exportData()')
      const exportedSettings = (JSON.parse(stateText(savePath)) as { settings: Record<string, unknown> }).settings
      check('lock: an export does not carry the lock (it is this installation\'s)', exportedSettings['lockEnabled'] === false && JSON.stringify(exportedSettings['lockedSpaces']) === '[]')

      // From the interface, the settings of the lock cannot be patched.
      trace('From the interface, the settings of the lock cannot be patched.')
      await call(ui, `window.lucium.dispatch({ type: 'settings/update', patch: { lockEnabled: false, lockedSpaces: [] } })`)
      check('lock: the interface cannot switch the lock off by patching the settings', store.get().settings.lockEnabled === true)

      // ---- a locked space ----
      trace('a locked space')
      browser.dispatch({ type: 'space/create', name: 'Espace verrouillé', emoji: '🔐', hue: 300 })
      const lockedSpace = store.get().activeSpaceId
      createdSpaces.push(lockedSpace)
      const w1 = await plainTab('/locked-page-1')
      const w2 = await plainTab('/locked-page-2')
      const pagesBefore = { w1: hitsOf('/locked-page-1'), w2: hitsOf('/locked-page-2') }
      check('lock: the pages of the space are live before it is locked', browser.livePageIds().includes(w1) && browser.livePageIds().includes(w2))
      // What else shows a live page of the space when the lock comes: a web panel beside the page, a window of its own, a ⌃Tab panel; and a tab closed while it sleeps.
      trace('a web panel and an application window of the space, then the lock')
      const w3 = await plainTab('/locked-page-3')
      browser.dispatch({ type: 'settings/update', patch: { webPanels: true, webAppWindows: true } })
      browser.dispatch({ type: 'space/panel-add', id: lockedSpace, panelId: 'lock-panel', url: `${base}/locked-panel`, title: 'Volet verrouillé' })
      browser.openWebPanel('lock-panel')
      const panelShown = await waitFor(() => browser.snapshot().webPanel?.id === 'lock-panel' && hitsOf('/locked-panel') > 0)
      const windowsBefore = ElectronWindow.getAllWindows().length
      browser.openAsApp(w1)
      const appOpened = await waitFor(() => ElectronWindow.getAllWindows().length === windowsBefore + 1)
      // The window loads the page anew: its request is waited for, so that one still on its way at the lock is not taken for a page the lock made.
      await waitFor(() => hitsOf('/locked-page-1') > pagesBefore.w1, 4000)
      check('lock: (control) a web panel and a window "Ouvrir comme application" of the space are open before the lock', panelShown && appOpened, JSON.stringify({ panelShown, appOpened }))
      const lockedReply = await lockCall({ op: 'space', spaceId: lockedSpace, locked: true })
      check('lock: locking a space answers ok and puts its pages to sleep at once', lockedReply.ok === true && !browser.livePageIds().includes(w1) && !browser.livePageIds().includes(w2) && browser.visibleTabIds().length === 0, JSON.stringify(lockedReply))
      // The window "Ouvrir comme application" of this test asked for the first page before the lock: the count that matters is the one at the lock.
      const hitsAtLock = { w1: hitsOf('/locked-page-1'), w2: hitsOf('/locked-page-2') }
      const shown = browser.snapshot()
      check('lock: the interface is given the state without the tabs of the locked space', shown.state.tabs.every((t) => t.spaceId !== lockedSpace) && shown.lock?.lockedSpaces.includes(lockedSpace) === true && store.get().tabs.some((t) => t.id === w1), JSON.stringify(shown.lock))
      const lockStageText = async () => (await waitFor(async () => (await evaluate<boolean>(ui, `!!document.querySelector('.lock-stage')`)) === true)) && (await evaluate<string>(ui, `document.querySelector('.lock-stage')?.innerText ?? ''`))
      const stageText = await lockStageText()
      check('lock: the window shows the lock screen of the space instead of its page, with no toolbar', typeof stageText === 'string' && /est verrouillé/.test(stageText) && (await evaluate<boolean>(ui, `!document.querySelector('.page-toolbar') && !document.body.innerText.includes('Titre')`)))
      check('lock: selecting the space again makes no page: the server sees no new request', hitsOf('/locked-page-1') === hitsAtLock.w1 && hitsOf('/locked-page-2') === hitsAtLock.w2, JSON.stringify({ atLock: hitsAtLock, now: { w1: hitsOf('/locked-page-1'), w2: hitsOf('/locked-page-2') } }))
      check('lock: a picture of one of its pages is refused', (await call<string | null>(ui, `window.lucium.tabThumbnail(${JSON.stringify(w1)})`)) === null)
      check('lock: the web panel of the space is closed with the lock, and the interface is no longer told of it', browser.snapshot().webPanel === undefined)
      check('lock: the window "Ouvrir comme application" of the space is closed with the lock', await waitFor(() => ElectronWindow.getAllWindows().length === windowsBefore))
      browser.openWebPanel('lock-panel')
      browser.openAsApp(w1)
      // No wait: both decide before they return, and one that opens has made its panel or its window by then (browser-panels.ts, web-apps.ts).
      check('lock: neither a web panel nor an application window can be opened from a locked space', browser.snapshot().webPanel === undefined && ElectronWindow.getAllWindows().length === windowsBefore)
      check('lock: the facts the interface is given about its tabs leave out the tabs it is not shown (their ids would give them away)', !(w1 in browser.snapshot().runtime.tabs) && !(w2 in browser.snapshot().runtime.tabs) && !(w3 in browser.snapshot().runtime.tabs))
      // ⌃Tab: the panel would draw the titles and pictures of the tabs over the lock screen.
      trace('⌃Tab over the lock screen')
      ui.focus()
      const viaKey = (type: 'keyDown' | 'keyUp', keyCode: string, modifiers: string[]) => ui.sendInputEvent({ type, keyCode, modifiers } as Electron.KeyboardInputEvent)
      // The witness: the Tab reaching a listener of the interface added after the browser's, which decides at once whether ⌃Tab opens its panel.
      let tabSeen = false
      const seeTab = (_event: Electron.Event, input: Electron.Input): void => {
        if (input.type === 'keyDown' && input.key === 'Tab') tabSeen = true
      }
      ui.on('before-input-event', seeTab)
      viaKey('keyDown', 'Control', ['control'])
      viaKey('keyDown', 'Tab', ['control'])
      const tabArrived = await waitFor(() => tabSeen)
      ui.off('before-input-event', seeTab)
      const panelOverLock = browser.currentCycle() !== null || browser.currentPanel() === 'tabcycle'
      check('lock: ⌃Tab on a locked space opens no panel: it would show the titles and pictures of its tabs over the lock screen', tabArrived && !panelOverLock && browser.isWatchingTabKeys(), JSON.stringify({ tabArrived, panelOverLock }))
      viaKey('keyUp', 'Tab', ['control'])
      viaKey('keyUp', 'Control', [])
      // Only lets the releases pass before what follows: Chromium tells the shell of no key that goes up after one the shell took, so there is
      // nothing to wait for.
      await sleep(200)
      // What the interface names without having been shown it: an id it could only have forged, or kept from before.
      trace('the interface names tabs it was not shown')
      const before = { tabs: JSON.stringify(store.get().tabs), readLater: store.get().readLater.length, bookmarks: store.get().bookmarks.length, sessions: store.get().sessions.length, archive: store.get().archive.length }
      for (const action of [
        { type: 'tab/move-to-space', id: w1, spaceId: originalSpace },
        { type: 'tab/duplicate', id: w1 },
        { type: 'tab/close', id: w2 },
        { type: 'tab/archive', id: w2 },
        { type: 'tab/select', id: w1 },
        { type: 'readlater/add', tabId: w1 },
        { type: 'bookmark/add', tabId: w1 },
        { type: 'session/save', tabIds: [w1, w2] }
      ]) await call(ui, `window.lucium.dispatch(${JSON.stringify(action)})`)
      await call(ui, `window.lucium.moveTabsToSpace(${JSON.stringify([w1])}, ${JSON.stringify(originalSpace)})`)
      // The witness: the dispatches above were answered one by one; the move is a message without an answer, so a question asked after it on the
      // same channel is answered only once the main process has handled it.
      await call(ui, 'window.lucium.getSnapshot().then(() => 0)')
      const after = { tabs: JSON.stringify(store.get().tabs), readLater: store.get().readLater.length, bookmarks: store.get().bookmarks.length, sessions: store.get().sessions.length, archive: store.get().archive.length }
      check('lock: the interface cannot move, copy, close, select, save or bookmark a tab of a locked space by naming it', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before: { ...before, tabs: before.tabs.length }, after: { ...after, tabs: after.tabs.length } }))
      // The shell closes a tab the lock hides while it sleeps: nothing of it stays in the facts about tabs.
      browser.dispatch({ type: 'tab/close', id: w3 })
      savePath = join(work, 'refused.json')
      const exportRefused = await call<{ ok: boolean; message?: string }>(ui, 'window.lucium.exportData()')
      check('lock: an export is refused while a space is locked, with the reason', exportRefused.ok === false && /Déverrouillez vos espaces/.test(exportRefused.message ?? '') && !existsSync(savePath))
      await call(ui, `window.lucium.dispatch({ type: 'space/delete', id: ${JSON.stringify(lockedSpace)} })`)
      check('lock: a locked space cannot be deleted without unlocking it', store.get().spaces.some((s) => s.id === lockedSpace))
      // What a locked space is recognised by waits for the phrase, from the interface and from the menus alike; its place in the list stays free.
      trace('the name, the look and the header of a locked space, and what replaces every space')
      const lookOf = () => JSON.stringify(store.get().spaces.find((s) => s.id === lockedSpace))
      const lookBefore = lookOf()
      for (const action of [
        { type: 'space/update', id: lockedSpace, patch: { name: 'Renommé sous le verrou' } },
        { type: 'space/update', id: lockedSpace, patch: { emoji: '🔓' } },
        { type: 'space/update', id: lockedSpace, patch: { theme: { intensity: 0.11 } } },
        { type: 'space/header', id: lockedSpace, visible: false },
        { type: 'space/apply-themes', entries: [{ id: lockedSpace, theme: { intensity: 0.12 } }] }
      ]) await call(ui, `window.lucium.dispatch(${JSON.stringify(action)})`)
      browser.dispatch({ type: 'space/image', id: lockedSpace, image: null })
      browser.dispatch({ type: 'space/header', id: lockedSpace, visible: false })
      check('lock: the name, the icon, the theme, the picture and the header of a locked space do not change without the phrase', lookOf() === lookBefore, lookOf())
      browser.closeOverlay()
      browser.openOverlay({ panel: 'space', spaceId: lockedSpace, focus: 'name' })
      const editorOverLock = browser.currentPanel()
      browser.openOverlay({ panel: 'theme', spaceId: lockedSpace })
      check('lock: neither the editor of a locked space nor the one of its theme opens', editorOverLock !== 'space' && browser.currentPanel() !== 'theme', JSON.stringify({ editorOverLock, now: browser.currentPanel() }))
      const placeBefore = store.get().spaces.findIndex((s) => s.id === lockedSpace)
      const placeAfter = placeBefore === 0 ? store.get().spaces.length - 1 : 0
      await call(ui, `window.lucium.dispatch(${JSON.stringify({ type: 'space/move', id: lockedSpace, toIndex: placeAfter })})`)
      check('lock: a locked space can still be moved in the list', placeAfter === placeBefore || store.get().spaces.findIndex((s) => s.id === lockedSpace) === placeAfter)
      browser.dispatch({ type: 'space/move', id: lockedSpace, toIndex: placeBefore })
      // What puts another set of spaces in the place of this one waits for the phrase too, as the export does.
      const wholeBefore = JSON.stringify({ spaces: store.get().spaces.map((s) => s.id), tabs: store.get().tabs.map((t) => t.id) })
      const emptied = { ...store.get(), tabs: [] }
      browser.dispatch({ type: 'state/restore', state: emptied })
      browser.dispatch({ type: 'backup/restore', copy: copyDataOf(emptied) })
      browser.dispatch({ type: 'import/revert', spaces: [lockedSpace], tabs: [], folders: [], favorites: [], splits: [], boosts: [] })
      check('lock: a state file, a copy of the session and the undo of an import replace nothing while a space is locked', JSON.stringify({ spaces: store.get().spaces.map((s) => s.id), tabs: store.get().tabs.map((t) => t.id) }) === wholeBefore)
      // A space that names a profile which is not a plain id: refused by the reducer, and by the engine if one ever got through.
      const profileBefore = store.get().spaces.find((s) => s.id === lockedSpace)!.profileId
      await call(ui, `window.lucium.dispatch({ type: 'space/update', id: ${JSON.stringify(lockedSpace)}, patch: { profileId: 'ephemeral:1' } })`)
      await call(ui, `window.lucium.dispatch({ type: 'space/update', id: ${JSON.stringify(lockedSpace)}, patch: { profileId: 'x/../../y' } })`)
      check('profile: the interface cannot give a space a profile that is not a plain id (another browsing context, a folder outside the profiles)', store.get().spaces.find((s) => s.id === lockedSpace)!.profileId === profileBefore)
      let refusedProfile = ''
      try {
        engine.createPage({ id: 'sec2-bad-profile', profileId: 'x/../../y' }, { update: () => {}, openWindow: () => {}, focused: () => {}, domReady: () => {}, found: () => {}, searchSelection: () => {}, closed: () => {} } as never)
      } catch (error) {
        refusedProfile = (error as Error).message
      }
      check('profile: the engine refuses to make a page for a profile id that is not a plain id', /not a plain id/.test(refusedProfile), refusedProfile)
      check('profile: ... and no page was made', engine.tabNumberOf('sec2-bad-profile') === undefined)
      const lockedSessions = store.get().sessions.length
      browser.dispatch({ type: 'session/save', name: 'copie' })
      check('lock: its tabs cannot be copied into a saved session while it is locked', store.get().sessions.length === lockedSessions)

      // The phrase, typed on the lock screen with real keys; wrong ones slow down.
      trace('The phrase, typed on the lock screen with real keys; wrong ones slow d')
      ui.focus()
      await clickOn(ui, '.lock-field')
      await typeKeys(ui, 'une mauvaise phrase')
      await pressKey(ui, 'Return')
      const wrongShown = await waitFor(async () => /incorrecte/.test(await evaluate<string>(ui, `document.querySelector('.lock-message')?.textContent ?? ''`)))
      check('lock: a wrong phrase typed on the lock screen is refused, saying how many tries are left', wrongShown && browser.visibleTabIds().length === 0)
      await unlockCall({ target: { scope: 'space', spaceId: lockedSpace }, phrase: 'encore une mauvaise' })
      await unlockCall({ target: { scope: 'space', spaceId: lockedSpace }, phrase: 'et une troisième' })
      const delayed = await unlockCall({ target: { scope: 'space', spaceId: lockedSpace }, phrase: PHRASE })
      check('lock: after three wrong phrases even the right one is refused for a moment (this is the delay)', delayed.ok === false && (delayed.retryInMs ?? 0) > 0 && /Réessayez dans/.test(delayed.ok ? '' : delayed.message) && (lockView()?.retryInMs ?? 0) > 0 && browser.visibleTabIds().length === 0, JSON.stringify(delayed))
      await sleep(1150)
      await clickOn(ui, '.lock-field')
      await typeKeys(ui, PHRASE)
      await pressKey(ui, 'Return')
      const opened = await waitFor(() => lockView()?.lockedSpaces.length === 0 && browser.visibleTabIds().length > 0)
      // The page is made at once, its request reaches the server a moment later: the count is waited for.
      const refetched = await waitFor(() => hitsOf('/locked-page-2') + hitsOf('/locked-page-1') > pagesBefore.w1 + pagesBefore.w2)
      check('lock: the right phrase, typed after the wait, opens the space: its page is made again', opened && refetched, JSON.stringify({ hits: [hitsOf('/locked-page-1'), hitsOf('/locked-page-2')], visible: browser.visibleTabIds() }))
      check('lock: the lock screen is gone and the tabs are back in what the interface is given', (await waitFor(async () => (await evaluate<boolean>(ui, `!document.querySelector('.lock-stage')`)) === true)) && browser.snapshot().state.tabs.some((t) => t.id === w1))
      check('lock: a sleeping tab that was closed leaves no entry in the facts about tabs (nothing grows with the tabs that came and went)', !(w3 in browser.snapshot().runtime.tabs) && !store.get().tabs.some((t) => t.id === w3))
      // The key does reach the shell: unlocked, ⌃Tab offers the tabs of the space.
      ui.focus()
      viaKey('keyDown', 'Control', ['control'])
      viaKey('keyDown', 'Tab', ['control'])
      const panelUnlocked = await waitFor(() => browser.currentPanel() === 'tabcycle', 3000)
      viaKey('keyUp', 'Tab', ['control'])
      viaKey('keyUp', 'Control', [])
      await waitFor(() => browser.currentPanel() === null, 3000)
      check('lock: (control) once the space is unlocked, ⌃Tab opens the panel again: the key does reach the shell', panelUnlocked)
      browser.closeOverlay()

      // Touch ID, simulated.
      trace('Touch ID, simulated.')
      let prompts = 0
      let accept = true
      const fake: TouchIdPort = {
        available: () => true,
        prompt: async () => {
          prompts++
          if (!accept) throw new Error('simulated fingerprint refused')
        }
      }
      lock.setTouchId(fake)
      // With Touch ID the lock screen opens the space again within a moment: the lock is seen as it happens.
      trace('With Touch ID the lock screen opens the space again within a moment: t')
      let sawLocked = false
      let pagesWhileLocked = -1
      const stopWatching = lock.subscribe(() => {
        if (lock.isSpaceLocked(lockedSpace) && !sawLocked) {
          sawLocked = true
          pagesWhileLocked = browser.visibleTabIds().length
        }
      })
      await lockCall({ op: 'lock-now' })
      check('lock: "lock now" locks the space again, with no page on screen while it is', sawLocked && pagesWhileLocked === 0, String(pagesWhileLocked))
      stopWatching()
      const touchOpened = await waitFor(() => lockView()?.lockedSpaces.length === 0 && browser.visibleTabIds().length > 0, 8000)
      check('lock: Touch ID (simulated) is asked for once when the lock screen appears, and opens the space without a phrase', touchOpened && prompts === 1, `prompts=${prompts}`)
      accept = false
      await lockCall({ op: 'lock-now' })
      await waitFor(() => prompts === 2)
      await waitFor(async () => /Touch ID n’a pas abouti/.test(await evaluate<string>(ui, `document.querySelector('.lock-message')?.textContent ?? ''`)))
      const refusedMessage = await evaluate<string>(ui, `document.querySelector('.lock-message')?.textContent ?? ''`)
      check('lock: a refused fingerprint leaves the space locked and says to type the phrase', lockView()?.lockedSpaces.includes(lockedSpace) === true && /Touch ID n’a pas abouti/.test(refusedMessage), refusedMessage)
      check('lock: the Touch ID button is on the lock screen where it is available', (await evaluate<boolean>(ui, `[...document.querySelectorAll('.lock-button')].some((b) => b.textContent.trim() === 'Touch ID')`)) === true)
      lock.setTouchId(NO_TOUCH_ID)
      check('lock: the lock screen offers no Touch ID where there is none', await waitFor(async () => lockView()?.touchId === false))
      await unlockCall({ target: { scope: 'space', spaceId: lockedSpace }, phrase: PHRASE })

      // ---- the application ----
      trace('the application')
      const wcSettingsBefore = settingsWindow()
      if (wcSettingsBefore) wcSettingsBefore.close()
      check('lock: turning the application lock on does not lock it yet', (await lockCall({ op: 'app', value: true })).ok === true && lockView()?.appLocked === false)
      browser.dispatch({ type: 'space/select', id: originalSpace })
      const appTab = await plainTab('/app-locked-page')
      browser.openOverlay({ panel: 'settings', pane: 'protection', anchor: 'lock' })
      await waitFor(() => settingsWindow() !== undefined)
      const secondWindow = getWindowManager().openPrivate()
      secondWindow.browser.dispatch({ type: 'tab/open', url: `${base}/private-locked-page` })
      await waitFor(() => secondWindow.browser.visibleTabIds().length > 0 && hitsOf('/private-locked-page') > 0)
      await sleep(400)
      const hitsPrivate = hitsOf('/private-locked-page')
      await lockCall({ op: 'lock-now' })
      const lockedAll = await waitFor(() => lockView()?.appLocked === true && browser.visibleTabIds().length === 0 && secondWindow.browser.visibleTabIds().length === 0)
      check('lock: locking the application drops the pages of every window, private ones included', lockedAll && !browser.livePageIds().includes(appTab) && secondWindow.browser.isPrivate())
      const appSnapshot = await call<{ state: SidebarState; lock?: { appLocked: boolean } }>(ui, 'window.lucium.getSnapshot()')
      const appText = JSON.stringify(appSnapshot.state)
      check('lock: the snapshot the interface can read is a skeleton: no tab, no name, no favourite, no host', appSnapshot.lock?.appLocked === true && appSnapshot.state.tabs.length === 0 && appSnapshot.state.favorites.length === 0 && appSnapshot.state.archive.length === 0 && !/Perso|Espace verrouillé|127\.0\.0\.1|locked-page/.test(appText), appText.slice(0, 200))
      const lockedDom = await waitFor(async () => (await evaluate<boolean>(ui, `!!document.querySelector('.lock-app')`)) === true)
      check('lock: the window is the lock screen and nothing else: no sidebar, no toolbar, nothing of a tab', lockedDom && (await evaluate<boolean>(ui, `!document.querySelector('.sidebar') && !document.querySelector('.page-toolbar') && !document.body.innerText.includes('app-locked-page')`)))
      check('lock: the settings window was closed with it', await waitFor(() => settingsWindow() === undefined))
      check('lock: the menu has nothing to open, show or change: only quitting, hiding and editing', findMenuItem('Nouvel onglet…') === undefined && findMenuItem('Réglages…') === undefined && findMenuItem('Quitter Lucium') !== undefined && findMenuItem('Coller') !== undefined)
      const tabsBeforeAttempts = store.get().tabs.length
      await call(ui, `window.lucium.dispatch({ type: 'tab/open', url: 'http://127.0.0.1/forged' })`)
      await call(ui, `window.lucium.openOverlay({ panel: 'archive' })`)
      const suggestions = await call<string[]>(ui, `window.lucium.suggest('x')`)
      const searched = await call<unknown[]>(ui, `window.lucium.searchHistory('127', 10)`)
      savePath = join(work, 'while-locked.json')
      const exportWhileLocked = await call<unknown>(ui, 'window.lucium.exportData()')
      check('lock: while the application is locked the interface can no longer dispatch, open a panel, search, or export', store.get().tabs.length === tabsBeforeAttempts && browser.currentPanel() === null && suggestions.length === 0 && searched.length === 0 && exportWhileLocked === null && !existsSync(savePath))
      const configWhileLocked = await lockCall({ op: 'disable', current: PHRASE })
      check('lock: the lock cannot be changed while it holds, even with the phrase', configWhileLocked.ok === false && store.get().settings.lockEnabled === true, JSON.stringify(configWhileLocked))
      check('lock: no page of a private window was made again while it is locked', hitsPrivate > 0 && hitsOf('/private-locked-page') === hitsPrivate, JSON.stringify({ before: hitsPrivate, now: hitsOf('/private-locked-page') }))
      // A link another application sends waits for the unlocking (checked at the unit level); the global shortcut does nothing.
      trace('A link another application sends waits for the unlocking (checked at t')

      ui.focus()
      await clickOn(ui, '.lock-field')
      await typeKeys(ui, PHRASE)
      await clickOn(ui, '.lock-button.primary')
      const reopened = await waitFor(() => lockView()?.appLocked === false && browser.visibleTabIds().length > 0)
      check('lock: the phrase typed on the lock screen opens the application, and the page of the tab on screen is made again', reopened && (await waitFor(async () => (await evaluate<boolean>(ui, `!document.querySelector('.lock-app') && !!document.querySelector('.sidebar')`)) === true)))
      check('lock: the menu is whole again', await waitFor(() => findMenuItem('Nouvel onglet…') !== undefined))
      check('lock: opening the application does not open the locked space (two levels)', lockView()?.lockedSpaces.includes(lockedSpace) === true || lockView()?.guardedSpaces.includes(lockedSpace) === true)

      // The Mac going to sleep or locking its screen.
      trace('The Mac going to sleep or locking its screen.')
      await unlockCall({ target: { scope: 'space', spaceId: lockedSpace }, phrase: PHRASE })
      powerMonitor.emit('lock-screen')
      check('lock: the screen lock of the Mac locks the application and the spaces again', await waitFor(() => lockView()?.appLocked === true && lockView()?.lockedSpaces.includes(lockedSpace) === true))
      await unlockCall({ target: { scope: 'app' }, phrase: PHRASE })
      await unlockCall({ target: { scope: 'space', spaceId: lockedSpace }, phrase: PHRASE })
      powerMonitor.emit('suspend')
      check('lock: going to sleep locks them again', await waitFor(() => lockView()?.appLocked === true))
      await unlockCall({ target: { scope: 'app' }, phrase: PHRASE })

      // The honest note in Settings, and the settings group.
      trace('The honest note in Settings, and the settings group.')
      browser.openOverlay({ panel: 'settings', pane: 'protection', anchor: 'lock' })
      await waitFor(() => settingsWindow() !== undefined)
      const sw2 = settingsWindow()!.webContents
      // The heading of a group holds its name (`.pref-title`) and the count of its rows (`.pref-count`): the name is read alone.
      await waitFor(async () => (await evaluate<boolean>(sw2, `document.querySelector('.pref-section#lock .pref-title')?.textContent === 'Verrouillage'`)) === true)
      // The note says one line; the rest of it (what is not encrypted, how to recover the phrase) waits behind « En savoir plus », in the same section.
      const lockNote = await evaluate<string>(sw2, `[...document.querySelectorAll('.pref-section#lock .pref-note')].map((note) => note.textContent).join(' ')`)
      check('lock: Settings says it is a lock of the interface, that it does not encrypt cookies, profiles or files, and how to recover a forgotten phrase', /verrou de l’interface/.test(lockNote) && /ne chiffre ni vos cookies, ni vos profils/.test(lockNote) && /supprimez ce fichier/.test(lockNote), lockNote.slice(0, 120))
      // The group is in Vie privée et sécurité, with the password manager right after it (the part "Verrouillage et mots de passe" of the category).
      const place = await evaluate<{ category: string | null; heading: string; next: string }>(
        sw2,
        `(() => { const names = [...document.querySelectorAll('.settings-content .pref-section')].map((s) => s.querySelector(':scope > h3 .pref-title')?.textContent ?? '').filter(Boolean); return { category: document.querySelector('.settings-cat[aria-current=page]')?.getAttribute('data-cat') ?? null, heading: document.querySelector('#pane-heading')?.textContent ?? '', next: names[names.indexOf('Verrouillage') + 1] ?? '' } })()`
      )
      check('lock: the group is in Vie privée et sécurité, right before the password manager', place.category === 'protection' && place.heading === 'Vie privée et sécurité' && place.next === 'Mots de passe', JSON.stringify(place))
      settingsWindow()?.close()

      // A restart: a new service over the same files starts as the settings and the file say.
      trace('A restart: a new service over the same files starts as the settings an')
      store.flush()
      const reloaded = parseSavedState(readFileSync(join(userData, 'state.json'), 'utf8'))
      const restarted = new LockService({ settings: () => reloaded.settings, spaceIds: () => reloaded.spaces.map((s) => s.id), files: new LockStore(lockFile), touchId: NO_TOUCH_ID, power: { on: () => {}, off: () => {} }, update: () => {} })
      restarted.start()
      check('lock: after a restart the application starts locked, the space too, and the phrase on disk opens it', restarted.isAppLocked() && restarted.isSpaceLocked(lockedSpace) && (await within(restarted.unlock({ target: { scope: 'app' }, phrase: PHRASE }), 20_000, 'unlocking the restarted service')).ok === true && !restarted.isAppLocked())
      const stranger = new LockService({ settings: () => reloaded.settings, spaceIds: () => [], files: new LockStore(lockFile), touchId: NO_TOUCH_ID, power: { on: () => {}, off: () => {} }, update: () => {} })
      stranger.start()
      check('lock: a wrong phrase does not open the restarted application', stranger.isAppLocked() && (await stranger.unlock({ target: { scope: 'app' }, phrase: 'pas la bonne phrase' })).ok === false && stranger.isAppLocked())

      // Taking the lock away needs the phrase.
      trace('Taking the lock away needs the phrase.')
      const noPhrase = await lockCall({ op: 'disable', current: 'pas la bonne phrase' })
      check('lock: switching it off with a wrong phrase is refused and leaves everything as it was', noPhrase.ok === false && store.get().settings.lockEnabled === true && existsSync(lockFile))
      const off = await lockCall({ op: 'disable', current: PHRASE })
      check('lock: switching it off with the phrase forgets the phrase, the locked spaces and the listeners', off.ok === true && !existsSync(lockFile) && store.get().settings.lockEnabled === false && store.get().settings.lockedSpaces.length === 0 && lockView() === undefined && (['suspend', 'resume', 'lock-screen'] as const).every((event, i) => powerMonitor.listenerCount(event) === listenersBefore[i]))
      check('lock: the menu has no "Verrouiller maintenant" again', await waitFor(() => findMenuItem('Verrouiller maintenant') === undefined))
      secondWindow.win.close()
    })
  } finally {
    // Whatever happened above, leave the application unlocked, the lock off, and the state as it was.
    try {
      lock.setTouchId(NO_TOUCH_ID)
      if (lock.isActive()) {
        if (lock.isAppLocked()) await within(lock.unlock({ target: { scope: 'app' }, phrase: PHRASE }), 20_000, 'unlocking at the end')
        await within(lock.configure({ op: 'disable', current: PHRASE }), 20_000, 'switching the lock off at the end')
      }
      rmSync(join(userData, 'lock.json'), { force: true })
    } catch (error) {
      console.error('[smoke-security2] cannot take the lock away:', error)
    }
    Object.assign(dialog, { showOpenDialog: realDialogs.open, showSaveDialog: realDialogs.save, showErrorBox: realDialogs.error, showMessageBox: realDialogs.message })
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    for (const id of createdSpaces) {
      for (const tab of store.get().tabs.filter((t) => t.spaceId === id)) browser.dispatch({ type: 'tab/close', id: tab.id })
      browser.dispatch({ type: 'space/delete', id })
    }
    if (store.get().spaces.some((s) => s.id === originalSpace)) browser.dispatch({ type: 'space/select', id: originalSpace })
    browser.dispatch({ type: 'archive/clear' })
    browser.closeOverlay()
    browser.dispatch({ type: 'settings/update', patch: { reopenHistory: false, tidyDownloads: originalSettings.tidyDownloads, lockApp: false, webPanels: originalSettings.webPanels, webAppWindows: originalSettings.webAppWindows } })
    for (const w of ElectronWindow.getAllWindows()) if (w.getTitle() === 'Réglages') w.close()
    for (const name of readdirSync(userData)) if (name.includes('.avant-restauration-')) rmSync(join(userData, name), { force: true })
    rmSync(work, { recursive: true, force: true })
    server.close()
    server.closeAllConnections()
  }
}

/** The whole suite has this long: well under the 10 minutes a run is given, so a suite that stalls reports where, instead of being killed without a word. */
const SUITE_DEADLINE_MS = 8 * 60_000

/** `LUCIUM_SMOKE_ONLY=security2`: only these checks, with their own report. */
export async function runSecurity2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const started = Date.now()
  trace('start')
  try {
    await within(
      smokeSecurity2(ctx, (name, ok, detail) => {
        noteCheck(checks, name, ok, detail)
        // Printed as it happens: the last line of a run that stops is the check that was waiting for the next one.
        console.log(`[check] ${stamp()} ${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : ` :: ${detail ?? ''}`}`)
      }),
      SUITE_DEADLINE_MS,
      `the security2 suite (after ${checks.length} checks, the last being "${checks.at(-1)?.name ?? 'none'}")`
    )
  } catch (error) {
    console.error('[security2] the suite stopped:', error)
    noteCheck(checks, 'smokeSecurity2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  trace(`end after ${Math.round((Date.now() - started) / 1000)} s`)
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SECURITY2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
