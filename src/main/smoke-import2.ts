// Engine checks for the import from the other browsers: the preview before anything is written, the confirmation, the undo, the sources
// (a Chromium channel, a Firefox fork, "Autre navigateur"), the SQLite files read from inside Electron (a database whose newest rows are
// still in its write-ahead log, a file too big, a view in place of a table), the bridge's refusals (a private window, a key that is not
// one) and a live tab of an imported space when the import is taken back. A made-up home folder holds files shaped like the browsers';
// the real profiles of the user's browsers are never read. Called from the engine smoke test: `await smokeImport2(ctx, check)`;
// `LUCIUM_SMOKE_ONLY=import2` runs only this file.

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WebContents } from 'electron'
import { countImportedHistory, mergeImportedHistory, mergeImportedHistoryTracked } from './importers/history-target'
import { getImportService, ImportService, MAX_IMPORT_FILE_BYTES, setImportService } from './importers/service'
import { MAX_DB_BYTES } from './importers/sqlite'
import type { SmokeContext } from './smoke'
import { fakeApplications, TEST_BROWSERS } from './importers/app-bundles.test-support'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

const SUPPORT = 'Library/Application Support'
const micros = (ms: number) => (BigInt(ms) + 11_644_473_600_000n) * 1000n

export async function smokeImport2(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, history: historyBook, overlayView } = ctx
  const history = historyBook.of('default')
  const ui = overlayView.webContents
  const state = () => store.get()
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>

  const tmp = mkdtempSync(join(tmpdir(), 'lucium-smoke-import2-'))
  const home = join(tmp, 'home')
  const put = (relative: string, content: string | ((path: string) => void)) => {
    const path = join(home, relative)
    mkdirSync(dirname(path), { recursive: true })
    if (typeof content === 'string') writeFileSync(path, content)
    else content(path)
    return path
  }

  // A page on a local server, to have a live tab in an imported space.
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<title>import2 page</title><body>page</body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const WHEN = Date.now() - 86_400_000
  const link = (name: string, url: string) => ({ type: 'url', name, url })
  const CHROME_HOST = 'smoke-import2-chrome.example'
  const chromeBookmarks = (first: string) =>
    JSON.stringify({
      roots: { bookmark_bar: { type: 'folder', name: 'Barre', children: [link('Premier', first), link('Premier bis', first), { type: 'folder', name: 'Dossier import2', children: [link('Deuxième', `https://${CHROME_HOST}/deux`)] }, link('Piège', 'javascript:alert(1)')] } }
    })
  put(`${SUPPORT}/Google/Chrome/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' } } } }))
  put(`${SUPPORT}/Google/Chrome/Default/Bookmarks`, chromeBookmarks(`https://${CHROME_HOST}/un`))
  const urlsTable = 'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);'
  put(`${SUPPORT}/Google/Chrome/Default/History`, (path) => {
    const db = new DatabaseSync(path)
    db.exec(`${urlsTable}
      INSERT INTO urls VALUES (1, 'https://${CHROME_HOST}/page-un', 'Page un', 4, 0, ${micros(WHEN)}, 0), (2, 'https://${CHROME_HOST}/page-deux', 'Page deux', 1, 0, ${micros(WHEN - 5000)}, 0),
        (3, 'https://${CHROME_HOST}/cadre', 'Cadre', 1, 0, ${micros(WHEN - 9000)}, 1), (4, 'chrome://settings/', 'Réglages', 9, 0, ${micros(WHEN)}, 0);`)
    db.close()
  })
  put(`${SUPPORT}/Microsoft Edge Beta/Default/Bookmarks`, chromeBookmarks(`https://${CHROME_HOST}/edge`))

  // A Firefox fork whose newest rows are still in the write-ahead log, held open by a live writer as when the browser runs.
  const ZEN_PROFILE = 'abcd1234.Default (release)'
  const zenFile = put(`${SUPPORT}/zen/Profiles/${ZEN_PROFILE}/places.sqlite`, '')
  const zenWriter = new DatabaseSync(zenFile)
  zenWriter.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);
    INSERT INTO moz_places VALUES (1, 'https://smoke-import2-zen.example/', 'Zen', 3, ${WHEN * 1000}), (2, 'https://smoke-import2-zen.example/signet', 'Zen signet', 0, NULL);
    INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 0, 'toolbar'), (10, 1, 2, 3, 0, 'Signet zen');`)

  // Hostile files, chosen as "Autre navigateur".
  const huge = put('Desktop/enorme/History', (path) => {
    writeFileSync(path, '')
    truncateSync(path, MAX_DB_BYTES + 1)
  })
  const viewed = put('Desktop/vue/History', (path) => {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE reel (url TEXT); CREATE VIEW urls AS SELECT url, url AS title, 1 AS visit_count, 1 AS last_visit_time, 0 AS hidden FROM reel;')
    db.close()
  })
  const bigJson = put('Desktop/gros/Bookmarks', (path) => {
    writeFileSync(path, '{}')
    truncateSync(path, MAX_IMPORT_FILE_BYTES + 1)
  })

  let chosenFile: string | null = null
  const realService = getImportService()
  const service = new ImportService({
    home,
    ctx: () => ({ now: Date.now(), newId: () => crypto.randomUUID() }),
    dispatch: (action) => browser.dispatch(action),
    state: () => store.get(),
    mergeHistory: (entries) => mergeImportedHistory(historyBook, entries),
    countHistory: (entries) => countImportedHistory(historyBook, entries),
    mergeHistoryTracked: (entries) => mergeImportedHistoryTracked(historyBook, entries),
    chooseFile: async () => chosenFile,
    // The sheet names each browser by its application (importers/app-names.ts): pretend ones, so that the names below are the ones the sheet shows.
    applications: [fakeApplications(join(home, 'Applications'), [...TEST_BROWSERS, { id: 'com.microsoft.edgemac.Beta', display: 'Microsoft Edge Beta' }])]
  })
  setImportService(service)

  const sheetText = (selector: string) => evaluate<string>(ui, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent).join('|')`)
  const count = (selector: string) => evaluate<number>(ui, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const click = (selector: string, text = '') => evaluate<boolean>(ui, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true })()`)
  const reportText = () => sheetText('.import-report')
  const rowOf = (name: string) => evaluate<boolean>(ui, `[...document.querySelectorAll('.import-row')].some((e) => e.textContent.startsWith(${JSON.stringify(name)}))`)
  const buttons = () => sheetText('.import .button')
  const openSheet = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      browser.closeOverlay()
      await waitFor(async () => browser.currentPanel() === null && (await count('.import')) === 0, 5000)
      await sleep(500)
      browser.openOverlay({ panel: 'import' })
      if ((await waitFor(() => rowOf('Google Chrome'), 8000)) && (await sleep(500), await rowOf('Google Chrome'))) return true
    }
    return false
  }
  const shape = () => JSON.stringify({ spaces: state().spaces.map((s) => s.id), tabs: state().tabs.map((t) => t.id), folders: state().folders.map((f) => f.id), favorites: state().favorites.map((f) => f.id), active: state().activeSpaceId })
  const importedSpaces = () => state().spaces.filter((s) => s.name === 'Chrome')
  const mineHistory = () => history.search('smoke-import2', 50)

  const mineTabs = new Set<string>()
  const homeSpace = state().activeSpaceId
  try {
    // ======================= the sources =======================
    const listed = service.listSources()
    const names = listed.map((s) => s.name)
    check('import2: the sheet lists a Chromium channel and a Firefox fork found on the disk, the file sources always', ['Google Chrome', 'Microsoft Edge Beta', 'Zen', 'Fichier de signets (HTML)', 'Autre navigateur'].every((n) => names.includes(n)), names.join('|'))
    check('import2: …and not a browser that is not there', !names.includes('LibreWolf') && !names.includes('Brave Nightly'), names.join('|'))
    check('import2: the profile of the Firefox fork is named after its folder', JSON.stringify(listed.find((s) => s.id === 'zen')?.profiles) === JSON.stringify([{ id: ZEN_PROFILE, name: 'Default (release)' }]), JSON.stringify(listed.find((s) => s.id === 'zen')?.profiles))

    // ======================= the preview writes nothing =======================
    const before = shape()
    const historyBefore = history.size()
    const opened = await openSheet()
    check('import2: the sheet opens and lists Chrome', opened)
    await click('.import-row', 'Google Chrome')
    await waitFor(async () => (await count('.import-category')) === 2, 4000)
    check('import2: "Importer" shows a preview with the counts, the duplicate and what is not a web page', await click('.button.primary', 'Importer') && (await waitFor(async () => anySpace(/^Prêt à importer depuis Google Chrome : 2 signets \(onglets épinglés\) dans 1 dossier, 2 pages d’historique\. 1 élément ignoré/).test(await reportText()), 15_000)), await reportText())
    check('import2: …with the duplicate named in the details', /1 signet en double/.test(await sheetText('.import-details li')), await sheetText('.import-details li'))
    check('import2: …and the frame loaded in a page left out of the history count (2 pages, not 3)', /2 adresses web lues/.test(await sheetText('.import-details li')), await sheetText('.import-details li'))
    check('import2: …and nothing is written: no space, tab, folder, page of history', shape() === before && history.size() === historyBefore && importedSpaces().length === 0 && mineHistory().length === 0)
    const previewButtons = await buttons()
    check('import2: …the sheet offers to confirm, to go back, or to give up', ['Confirmer l’import', 'Retour', 'Annuler'].every((l) => previewButtons.includes(l)) && !previewButtons.includes('Annuler l’import'), previewButtons)

    // ---- going back, changing a choice
    await click('.button', 'Retour')
    check('import2: "Retour" withdraws the preview and offers "Importer" again', (await waitFor(async () => (await count('.import-report')) === 0, 4000)) && (await buttons()).includes('Importer'))
    await click('.button.primary', 'Importer')
    await waitFor(async () => /^Prêt à importer/.test(await reportText()), 15_000)
    await click('.import-category', 'Historique')
    check('import2: changing what is ticked withdraws a preview, so that "Confirmer" never confirms something else than what is on screen', await waitFor(async () => (await count('.import-report')) === 0, 4000) && !(await buttons()).includes('Confirmer'))
    await click('.import-category', 'Historique')

    // ======================= confirm, then take back =======================
    await click('.button.primary', 'Importer')
    await waitFor(async () => /^Prêt à importer/.test(await reportText()), 15_000)
    check('import2: "Confirmer l’import" brings in what the preview showed', (await click('.button.primary', 'Confirmer l’import')) && (await waitFor(async () => anySpace(/^Importé depuis Google Chrome : 2 onglets épinglés et 1 dossier, 2 pages d’historique\./).test(await reportText()), 15_000)), await reportText())
    const space = importedSpaces()[0]
    check('import2: the space “Chrome” holds the two bookmarks as pinned tabs, one in a folder', importedSpaces().length === 1 && state().tabs.filter((t) => t.spaceId === space?.id && t.pinned).length === 2 && state().folders.filter((f) => f.spaceId === space?.id).length === 1)
    check('import2: the two pages are in the history, the frame and the internal page are not', mineHistory().length === 2 && mineHistory().find((e) => e.url.endsWith('page-un'))?.visitCount === 4, JSON.stringify(mineHistory().map((e) => e.url)))
    const doneButtons = await buttons()
    check('import2: the sheet now offers to take the import back, and to finish', doneButtons.includes('Annuler l’import') && doneButtons.includes('Terminé') && !doneButtons.includes('Confirmer'), doneButtons)
    check('import2: "Annuler l’import" takes everything back: the sidebar is what it was and the pages are out of the history', (await click('.button', 'Annuler l’import')) && (await waitFor(async () => anySpace(/^Import annulé : 2 onglets épinglés et 1 dossier, 2 pages d’historique retirés\./).test(await reportText()), 15_000)) && shape() === before && history.size() === historyBefore && mineHistory().length === 0, `${await reportText()} ${shape() === before} ${history.size()}/${historyBefore}`)
    check('import2: …and the button is gone once it has been used', !(await buttons()).includes('Annuler l’import'))
    browser.closeOverlay()

    // ======================= an import is undone with a live tab in it =======================
    const live = await service.run({ source: 'chrome', profile: 'Default', categories: ['bookmarks'] })
    const liveSpace = importedSpaces()[0]
    check('import2: an import without the sheet gives a key to take it back', live.ok && typeof live.undoToken === 'string' && liveSpace !== undefined)
    // A bookmark that points at the local page is opened (it becomes a live page), then the import is undone.
    const imported = state().tabs.filter((t) => t.spaceId === liveSpace?.id)
    browser.dispatch({ type: 'space/select', id: liveSpace!.id })
    browser.dispatch({ type: 'tab/open', url: `${base}/live`, spaceId: liveSpace!.id, background: false })
    const liveTab = state().tabs.at(-1)!
    mineTabs.add(liveTab.id)
    await waitFor(() => browser.snapshot().runtime.tabs[liveTab.id] !== undefined, 8000)
    const hadView = browser.snapshot().runtime.tabs[liveTab.id] !== undefined
    check('import2: the imported pinned tabs are in the space, and a tab opened in it is a live page', imported.length === 2 && hadView)
    const undone = service.undo(live.undoToken!)
    await waitFor(() => browser.snapshot().runtime.tabs[liveTab.id] === undefined, 8000)
    check('import2: taking the import back closes the live page of its space (the engine follows the state)', undone.ok && browser.snapshot().runtime.tabs[liveTab.id] === undefined && !state().tabs.some((t) => t.id === liveTab.id) && importedSpaces().length === 0)
    check('import2: …and the sidebar shows another space, not a missing one', state().spaces.some((s) => s.id === state().activeSpaceId))
    check('import2: a second undo with the same key is refused', service.undo(live.undoToken!).ok === false)

    // ======================= the SQLite files, from inside Electron =======================
    const zenPreview = await service.preview({ source: 'zen', profile: ZEN_PROFILE, categories: ['bookmarks', 'history'] })
    check('import2: a Firefox fork is read from its profile, with the rows that are only in the write-ahead log of the running browser', zenPreview.ok && zenPreview.bookmarks === 1 && zenPreview.history === 1 && zenPreview.message.includes('depuis Zen'), zenPreview.message)
    check('import2: …and the live database was left alone (the writer still writes)', (() => { try { zenWriter.exec("INSERT INTO moz_places VALUES (3, 'https://smoke-import2-zen.example/apres', 'Après', 1, " + WHEN * 1000 + ')'); return true } catch { return false } })())

    chosenFile = huge
    const tooBig = await service.preview({ source: 'other', categories: ['history'] })
    check('import2: a database larger than the bound is refused by name, without copying it', !tooBig.ok && anySpace(/History : le fichier est trop volumineux/).test(tooBig.message), tooBig.message)
    chosenFile = viewed
    const view = await service.preview({ source: 'other', categories: ['history'] })
    check('import2: a view in place of the table is refused', !view.ok && anySpace(/table « urls » manque/).test(view.message), view.message)
    chosenFile = bigJson
    const tooBigJson = await service.preview({ source: 'other', categories: ['bookmarks'] })
    check('import2: a bookmarks file larger than the bound is refused without being read', !tooBigJson.ok && /trop volumineux/.test(tooBigJson.message), tooBigJson.message)
    chosenFile = join(home, `${SUPPORT}/Google/Chrome/Default/Bookmarks`)
    const other = await service.preview({ source: 'other', categories: ['bookmarks'] })
    check('import2: “Autre navigateur” reads a Chromium bookmarks file chosen by the user', other.ok && other.bookmarks === 2 && typeof other.token === 'string', other.message)
    check('import2: …and previewing writes nothing', importedSpaces().length === 0 && shape() === before)

    // ======================= the bridge =======================
    const answer = (script: string) => evaluate<{ ok: boolean; message: string }>(ui, script)
    const badKey = await answer(`window.lucium.importCommit('../../etc/passwd')`)
    const badUndo = await answer(`window.lucium.importUndo(42)`)
    const unknown = await answer(`window.lucium.importCommit('00000000-0000-0000-0000-000000000000')`)
    const badRequest = await answer(`window.lucium.importPreview({ source: 'chrome', categories: ['passwords'] })`)
    check('import2: a key that is not one, a request that asks for passwords, and a key nobody gave are refused with a sentence', !badKey.ok && !badUndo.ok && !unknown.ok && !badRequest.ok && /invalide/.test(badKey.message) && /invalide/.test(badUndo.message) && /plus valable/.test(unknown.message) && /invalide/.test(badRequest.message), JSON.stringify([badKey, badUndo, unknown, badRequest]))

    // ---- a private window
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    try {
      const surfaces = (): WebContents[] => [priv.win.webContents, ...priv.win.contentView.children.map((v) => (v as unknown as { webContents?: WebContents }).webContents).filter((wc): wc is WebContents => wc !== undefined)]
      const hasBridge = (wc: WebContents) => (wc.isLoading() ? Promise.resolve(false) : evaluate<boolean>(wc, `typeof window.lucium?.importPreview === 'function'`).catch(() => false))
      let privateUi: WebContents | undefined
      await waitFor(async () => {
        for (const wc of surfaces()) if (await hasBridge(wc)) privateUi = wc
        return privateUi !== undefined
      }, 10_000)
      if (!privateUi) throw new Error('no interface surface in the private window')
      // A preview and a key made in a normal window: the private window must not be able to use them.
      const prepared = await service.preview({ source: 'chrome', profile: 'Default', categories: ['bookmarks'] })
      const shapeBefore = shape()
      const preview = await evaluate<{ ok: boolean; message: string }>(privateUi, `window.lucium.importPreview({ source: 'chrome', categories: ['bookmarks'] })`)
      const commit = await evaluate<{ ok: boolean; message: string }>(privateUi, `window.lucium.importCommit(${JSON.stringify(prepared.token)})`)
      const run = await evaluate<{ ok: boolean; message: string }>(privateUi, `window.lucium.importRun({ source: 'chrome', categories: ['bookmarks'] })`)
      const sources = await evaluate<unknown[]>(privateUi, `window.lucium.importSources()`)
      check('import2: a private window can neither preview, confirm, import nor list the browsers', [preview, commit, run].every((r) => !r.ok && /fenêtre privée/.test(r.message)) && sources.length === 0, JSON.stringify([preview, commit, run, sources]))
      check('import2: …and nothing was written', shape() === shapeBefore && importedSpaces().length === 0)
      // The refusals did not use up the preview a normal window made.
      const confirmed = service.commit(prepared.token!)
      check('import2: …the preview of a normal window was not used up by the private window’s attempts, and still confirms', confirmed.ok && importedSpaces().length === 1, confirmed.message)
      const undoPrivate = await evaluate<{ ok: boolean; message: string }>(privateUi, `window.lucium.importUndo(${JSON.stringify(confirmed.undoToken)})`)
      check('import2: a private window cannot take an import back either', !undoPrivate.ok && /fenêtre privée/.test(undoPrivate.message) && importedSpaces().length === 1, JSON.stringify(undoPrivate))
      service.undo(confirmed.undoToken!)
    } finally {
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
      ctx.win.emit('focus')
    }
  } finally {
    zenWriter.close()
    if (realService) setImportService(realService)
    for (const id of mineTabs) browser.dispatch({ type: 'tab/close', id })
    for (const s of state().spaces.filter((s) => ['Chrome', 'Zen', 'Autre navigateur'].includes(s.name))) browser.dispatch({ type: 'space/delete', id: s.id })
    for (const entry of mineHistory()) history.remove(entry.url)
    if (state().spaces.some((sp) => sp.id === homeSpace)) browser.dispatch({ type: 'space/select', id: homeSpace })
    browser.closeOverlay()
    server.close()
    server.closeAllConnections()
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** `LUCIUM_SMOKE_ONLY=import2`: only these checks, with their own report. */
export async function runImport2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeImport2(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeImport2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_IMPORT2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
