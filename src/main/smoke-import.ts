// Engine checks for the import from Arc and the export of the bookmarks, run inside a real Electron. A made-up home folder holds files shaped
// like Arc's (a sidebar with a split view and a tab group, Chromium SQLite histories of two profiles); the import sheet is driven the way
// a user drives it, the state and the history are read back, and the same import is run a second time. Arc keeps no file of its Tweaks
// on the Mac: the import offers no such part, and a file of them that the user picks is refused. The export is run through the interface, the Settings pane and the menu with the dialogs answered by recorders; the file it
// writes is read back with the importer's parser. No dialog is ever shown, and nothing outside the made-up home and a temporary folder is
// read or written. Called from the engine smoke test: `await smokeImport(ctx, check)`; `LUCIUM_SMOKE_ONLY=import` runs only this file.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BrowserWindow as ElectronWindow, dialog, Menu, type MenuItem, type WebContents } from 'electron'
import type { BookmarkNode } from './importers/bookmark-tree'
import { parseNetscapeBookmarks } from './importers/netscape'
import { getImportService, ImportService, setImportService } from './importers/service'
import type { SmokeContext } from './smoke'
import { fakeApplications, TEST_BROWSERS } from './importers/app-bundles.test-support'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

// ---- the made-up Arc ----

// The sidebar file interleaves ids and objects.
const item = (id: string, parentID: string | null, childrenIds: string[], data: object, title: string | null = null) => [id, { id, parentID, childrenIds, data, title, createdAt: 720_000_000 }]
const tabData = (url: string, title: string) => ({ tab: { savedURL: url, savedTitle: title, timeLastActiveAt: 720_000_100 } })

const SPACE_NAME = 'Import Smoke'
const HOSTILE_TITLE = '<script>alert(1)</script> Épinglé & « test »'
const FOLDER_NAME = 'Dossier "smoke"'

const arcSidebar = () => ({
  sidebar: {
    containers: [
      { global: {} },
      {
        topAppsContainerIDs: [{ default: true }, 'top'],
        spaces: ['sm-space', { id: 'sm-space', title: SPACE_NAME, customInfo: { iconType: { emoji_v2: '🧪' } }, containerIDs: ['pinned', 'pin', 'unpinned', 'today'] }],
        items: [
          ...item('top', null, ['fav'], { itemContainer: {} }),
          ...item('fav', 'top', [], tabData('https://smoke-import-favori.example/', 'Favori smoke')),
          ...item('pin', null, ['p', 'dossier'], { itemContainer: {} }),
          ...item('p', 'pin', [], tabData('https://smoke-import-p.example/', HOSTILE_TITLE)),
          ...item('dossier', 'pin', ['sv'], { list: {} }, FOLDER_NAME),
          ...item('sv', 'dossier', ['a', 'b'], { splitView: { layoutOrientation: 'vertical', itemWidthFactors: ['b', 0.7, 'a', 0.3], focusItemID: 'a', customInfo: null } }),
          ...item('a', 'sv', [], tabData('https://smoke-import-a.example/', 'Volet A')),
          ...item('b', 'sv', [], tabData('https://smoke-import-b.example/', 'Volet B')),
          ...item('today', null, ['grp', 'ext'], { itemContainer: {} }),
          ...item('grp', 'today', ['c', 'd'], { tabGroup: { title: 'Groupe' } }),
          ...item('c', 'grp', [], tabData('https://smoke-import-c.example/', 'Du jour C')),
          ...item('d', 'grp', [], tabData('https://smoke-import-d.example/', 'Du jour D')),
          ...item('ext', 'today', [], tabData('chrome-extension://smokeimport/page.html', 'Extension'))
        ]
      }
    ]
  }
})

/** A Chromium history database (the `urls` table, dates in microseconds since 1601). */
const chromiumHistory = (rows: Array<[string, string, number]>) => (path: string) => {
  const db = new DatabaseSync(path)
  const when = (BigInt(Date.now() - 86_400_000) + 11_644_473_600_000n) * 1000n
  db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
    ${rows.map(([url, title, visits], i) => `INSERT INTO urls VALUES (${i + 1}, '${url}', '${title}', ${visits}, 0, ${when}, 0);`).join('\n')}`)
  db.close()
}

export async function smokeImport(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, history: historyBook, win, overlayView } = ctx
  // The import service of this suite merges into the history of the default profile.
  const history = historyBook.of('default')
  const ui = overlayView.webContents
  const state = () => store.get()
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>

  const tmp = mkdtempSync(join(tmpdir(), 'lucium-smoke-import-'))
  const home = join(tmp, 'home')
  const ARC = join(home, 'Library/Application Support/Arc')
  const put = (path: string, content: string | ((path: string) => void)) => {
    mkdirSync(dirname(path), { recursive: true })
    if (typeof content === 'string') writeFileSync(path, content)
    else content(path)
  }

  put(join(ARC, 'StorableSidebar.json'), JSON.stringify(arcSidebar()))
  put(join(ARC, 'User Data/Default/History'), chromiumHistory([['https://smoke-import-hist-un.example/', 'Histoire un', 3], ['https://smoke-import-hist-deux.example/', 'Histoire deux', 1], ['chrome://settings/', 'Réglages', 9]]))
  put(join(ARC, 'User Data/Profile 1/History'), chromiumHistory([['https://smoke-import-hist-trois.example/', 'Histoire trois', 2]]))
  // What a file of Tweaks would look like: Arc keeps none on the Mac, and the import refuses one the user picks.
  const boostsPath = join(tmp, 'boosts.json')
  put(boostsPath, JSON.stringify([{ host: '127.0.0.1', name: 'Smoke CSS', css: 'body { color: rgb(1, 2, 3) !important }' }]))

  // ---- the dialogs, answered by recorders ----
  let chosenFile: string | null = null
  let saveAt: string | null = null
  let ticked = false
  let dialogFails = false
  const asked: string[] = []
  const saveCalls: string[] = []
  const real = { save: dialog.showSaveDialog, msg: dialog.showMessageBox, error: dialog.showErrorBox }
  Object.assign(dialog, {
    showSaveDialog: async (...args: unknown[]) => {
      if (dialogFails) throw new Error('boîte de dialogue indisponible')
      saveCalls.push(JSON.stringify(args.find((a) => typeof a === 'object' && a !== null && 'defaultPath' in (a as object)) ?? {}))
      return { canceled: saveAt === null, filePath: saveAt ?? undefined }
    },
    showMessageBox: async (...args: unknown[]) => {
      asked.push(String((args.find((a) => typeof a === 'object' && a !== null && 'message' in (a as object)) as { message?: string } | undefined)?.message ?? ''))
      return { response: 0, checkboxChecked: ticked }
    },
    showErrorBox: (title: string) => void asked.push(`erreur : ${title}`)
  })

  const realService = getImportService()
  const service = new ImportService({
    home,
    ctx: () => ({ now: Date.now(), newId: () => crypto.randomUUID() }),
    dispatch: (action) => browser.dispatch(action),
    state: () => store.get(),
    mergeHistory: (entries) => history.merge(entries),
    chooseFile: async () => chosenFile,
    // The sheet names each browser by its application (importers/app-names.ts): pretend ones, so that the names below are the ones the sheet shows.
    applications: [fakeApplications(join(home, 'Applications'), TEST_BROWSERS)]
  })
  setImportService(service)

  // ---- helpers over the real interface ----
  const sheetText = (selector: string) => evaluate<string>(ui, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent).join('|')`)
  const count = (selector: string) => evaluate<number>(ui, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
  /** Clicks the first element of the selector whose text contains `text`. */
  const click = (selector: string, text = '') => evaluate<boolean>(ui, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true })()`)
  const arcRow = () => evaluate<boolean>(ui, `[...document.querySelectorAll('.import-row')].some((e) => e.textContent.startsWith('Arc'))`)
  /** Closes whatever panel is open, waits until it is gone (the overlay hides itself a moment later), then opens the sheet and waits until it stays. */
  const openSheet = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      browser.closeOverlay()
      await waitFor(async () => browser.currentPanel() === null && (await count('.import')) === 0, 5000)
      await sleep(500)
      browser.openOverlay({ panel: 'import' })
      if ((await waitFor(arcRow, 8000)) && (await sleep(500), await arcRow())) return true
    }
    return false
  }
  const reportText = () => sheetText('.import-report')
  const reportDone = (pattern: RegExp) => waitFor(async () => pattern.test(await reportText()), 15_000)
  /** "Importer" shows a preview of what would come in; "Confirmer l’import" brings it in. A failure, or an import with nothing new, has no preview and is the report. */
  const confirmPreview = async () => {
    if (await waitFor(async () => /^Prêt à importer/.test(await reportText()) || (await reportText()) !== '', 15_000)) {
      if (/^Prêt à importer/.test(await reportText())) await click('.button.primary', 'Confirmer l’import')
    }
  }
  const importNow = async () => {
    await click('.button.primary', 'Importer')
    await confirmPreview()
  }
  const categoryBoxes = () => evaluate<boolean[]>(ui, `[...document.querySelectorAll('.import-category')].map((l) => l.querySelector('input').checked)`)
  const mine = () => state().spaces.filter((s) => s.name === SPACE_NAME)
  const urlsOf = (spaceName: string, pinned: boolean) => {
    const space = state().spaces.find((s) => s.name === spaceName)
    return state().tabs.filter((t) => t.spaceId === space?.id && t.pinned === pinned).map((t) => t.url)
  }
  /** What the import brought, in a form two runs can be compared in. */
  const brought = () => JSON.stringify({ spaces: state().spaces.map((s) => s.id), tabs: state().tabs.filter((t) => t.url.includes('smoke-import-')), folders: state().folders, splits: state().splits, favorites: state().favorites, boosts: state().boosts, active: mine().map((sp) => state().activeTabBySpace[sp.id]), history: history.size() })

  const mineTabs = new Set<string>()
  try {
    // ======================= the sheet lists Arc and what it can give =======================
    check('import: the sheet opens and lists Arc (its sidebar file is there)', await openSheet() && (await sheetText('.import-row strong')).includes('Arc'))
    check('import: the sheet also offers a bookmarks file (HTML) as a source', (await sheetText('.import-row strong')).includes('Fichier de signets (HTML)'))
    await click('.import-row', 'Arc')
    await waitFor(async () => (await count('.import-category')) === 2, 4000)
    const labels = await sheetText('.import-category')
    check('import: Arc offers the sidebar and the history, both ticked, and no Tweaks (Arc keeps none on the Mac)', /Espaces, onglets, dossiers, favoris et vues scindées/.test(labels) && /Historique/.test(labels) && !/Retouches/.test(labels) && JSON.stringify(await categoryBoxes()) === '[true,true]', `${labels} ${JSON.stringify(await categoryBoxes())}`)

    // ======================= the first import =======================
    check('import: "Importer" starts it', await click('.button.primary', 'Importer'))
    check('import: it first shows what would come in, and has written nothing yet (no space, no page of history)', (await reportDone(anySpace(/^Prêt à importer depuis Arc : 1 espace, 5 onglets, 1 dossier, 1 favori, 1 vue scindée, 3 pages d’historique\./))) && mine().length === 0 && history.search('smoke-import-hist').length === 0, await reportText())
    const previewButtons = await sheetText('.import .button')
    check('import: …and offers to confirm, to go back, or to give up', ['Confirmer l’import', 'Retour', 'Annuler'].every((label) => previewButtons.includes(label)), previewButtons)
    await confirmPreview()
    check('import: the report counts spaces, tabs, folders, favourites, split views and pages of history', await reportDone(anySpace(/Importé depuis Arc : 1 espace, 5 onglets, 1 dossier, 1 favori, 1 vue scindée, 3 pages d’historique\./)), await reportText())
    const details = await sheetText('.import-details li')
    check('import: it says what the tab group became, what was left aside and why, and what the history held', anySpace(/1 groupe d’onglets : les onglets sont repris, pas le groupe/).test(details) && anySpace(/1 élément ignoré : pages internes/).test(details) && anySpace(/Historique : 4 pages lues, 3 ajoutées/).test(details), details)
    check('import: the report speaks of no Tweak', !/Retouche/.test(details), details)
    const space = mine()[0]
    check('import: the space comes in with its name and its emoji', mine().length === 1 && space?.emoji === '🧪')
    check('import: pinned tabs: the loose one first, then the two of the folder', JSON.stringify(urlsOf(SPACE_NAME, true)) === JSON.stringify(['https://smoke-import-p.example/', 'https://smoke-import-a.example/', 'https://smoke-import-b.example/']), JSON.stringify(urlsOf(SPACE_NAME, true)))
    check('import: the tabs of the tab group come in as Today tabs, in order, without the extension page', JSON.stringify(urlsOf(SPACE_NAME, false)) === JSON.stringify(['https://smoke-import-c.example/', 'https://smoke-import-d.example/']), JSON.stringify(urlsOf(SPACE_NAME, false)))
    const folder = state().folders.find((f) => f.spaceId === space?.id)
    check('import: the folder keeps its name, and the two tabs are in it', folder?.name === FOLDER_NAME && state().tabs.filter((t) => t.folderId === folder.id).length === 2)
    const split = state().splits.find((s) => s.spaceId === space?.id)
    const paneUrls = split?.tabIds.map((id) => state().tabs.find((t) => t.id === id)?.url)
    check('import: the split view has its two panes, stacked as Arc had them, in the shares Arc kept (told apart by tab, not by position)', split?.orientation === 'vertical' && JSON.stringify(paneUrls) === JSON.stringify(['https://smoke-import-a.example/', 'https://smoke-import-b.example/']) && Math.abs((split.ratios[0] ?? 0) - 0.3) < 1e-9 && Math.abs((split.ratios[1] ?? 0) - 0.7) < 1e-9, JSON.stringify(split))
    check('import: the favourite comes in', state().favorites.some((f) => f.url === 'https://smoke-import-favori.example/' && f.title === 'Favori smoke'))
    check('import: the title of a pinned tab is kept as text (markup and quotes intact)', state().tabs.find((t) => t.url === 'https://smoke-import-p.example/')?.title === HOSTILE_TITLE)
    check('import: the pages of the history of both profiles joined the history, the page that is not a web page did not', history.search('smoke-import-hist').length === 3 && history.search('chrome://settings').length === 0, String(history.search('smoke-import-hist').length))
    check('import: the three pages carry their visits', history.search('smoke-import-hist-un')[0]?.visitCount === 3 && history.search('smoke-import-hist-trois')[0]?.visitCount === 2)
    const afterFirst = brought()
    for (const t of state().tabs.filter((t) => t.spaceId === space?.id)) mineTabs.add(t.id)

    // ======================= the same import a second time =======================
    const reopened = await openSheet()
    const rowsSeen = await sheetText('.import-row strong')
    const clickedArc = await click('.import-row', 'Arc')
    const gotCategories = await waitFor(async () => (await count('.import-category')) === 2, 4000)
    await importNow()
    check('import: a second run says there is nothing new', await reportDone(/Rien de nouveau depuis Arc/), `reopened=${reopened} rows=${rowsSeen} clickedArc=${clickedArc} categories=${gotCategories} chosen=${await sheetText('.import-row.chosen')} :: ${await reportText()} :: ${await sheetText('.import')} :: ${await evaluate<string>(ui, `[...document.querySelectorAll('.import .button')].map((b) => b.textContent + (b.disabled ? '(off)' : '')).join('|')`)}`)
    check('import: …and counts what was already there', anySpace(/éléments déjà importés auparavant : laissés tels quels, sans doublon/).test(await sheetText('.import-details li')), await sheetText('.import-details li'))
    check('import: …and changes nothing at all (no space, tab, folder, split view or favourite twice; the history unchanged)', brought() === afterFirst && mine().length === 1)

    // ======================= the user changes something, then imports again =======================
    const tabC = state().tabs.find((t) => t.url === 'https://smoke-import-c.example/')!
    browser.dispatch({ type: 'tab/rename', id: tabC.id, title: 'Mon nom' })
    browser.dispatch({ type: 'space/update', id: space!.id, patch: { name: SPACE_NAME } })
    const renamed = brought()
    await service.run({ source: 'arc', categories: ['sidebar', 'history'] })
    check('import: what the user changed in an imported tab is left alone by a new import', brought() === renamed && state().tabs.find((t) => t.id === tabC.id)?.customTitle === 'Mon nom')

    // ======================= files that are wrong =======================
    const before = brought()
    chosenFile = boostsPath
    const refused = await service.run({ source: 'arc', categories: ['sidebar', 'history'], pick: true })
    check('import: a file of Tweaks the user picks for Arc is refused, and imports nothing', refused.ok === false && /boosts\.json n’est pas un fichier que cet import sait lire/.test(refused.message) && brought() === before && !state().boosts.some((b) => b.name.startsWith('Smoke')), refused.message)
    const sidebarFile = join(ARC, 'StorableSidebar.json')
    const goodSidebar = readFileSync(sidebarFile, 'utf8')
    writeFileSync(sidebarFile, '{ ceci n’est pas du json')
    const brokenSidebar = await service.run({ source: 'arc', categories: ['sidebar'] })
    writeFileSync(sidebarFile, goodSidebar)
    check('import: a sidebar file that is not JSON changes nothing and the report names the file', brokenSidebar.ok === false && /StorableSidebar\.json/.test(brokenSidebar.message) && brought() === before, brokenSidebar.message)
    const profile2 = join(ARC, 'User Data/Profile 2/History')
    put(profile2, 'pas une base SQLite')
    const historySize = history.size()
    const brokenHistory = await service.run({ source: 'arc', categories: ['history'] })
    rmSync(join(ARC, 'User Data/Profile 2'), { recursive: true, force: true })
    check('import: a history file that cannot be read adds no page and the report names it', history.size() === historySize && /Profile 2\/History n’est pas une base de données lisible/.test(brokenHistory.message), brokenHistory.message)

    // ======================= a private window imports nothing and exports nothing =======================
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    try {
      // A surface of the private window's interface (its sidebar page or its overlay), which has the same bridge to the main process as every surface.
      const surfaces = (): WebContents[] => [priv.win.webContents, ...priv.win.contentView.children.map((v) => (v as unknown as { webContents?: WebContents }).webContents).filter((wc): wc is WebContents => wc !== undefined)]
      const hasBridge = (wc: WebContents) => (wc.isLoading() ? Promise.resolve(false) : evaluate<boolean>(wc, `typeof window.lucium?.importRun === 'function'`).catch(() => false))
      let privateUi: WebContents | undefined
      await waitFor(async () => {
        for (const wc of surfaces()) if (await hasBridge(wc)) privateUi = wc
        return privateUi !== undefined
      }, 10_000)
      check('private: the private window has an interface surface with the bridge', privateUi !== undefined, String(surfaces().map((wc) => wc.getURL().split('?')[0])))
      if (!privateUi) throw new Error('no interface surface in the private window')
      const calls = saveCalls.length
      const filesBefore = readdirSync(tmp).length
      const importAnswer = await evaluate<{ ok: boolean; message: string }>(privateUi, `window.lucium.importRun({ source: 'arc', categories: ['sidebar'] })`)
      const exportAnswer = await evaluate<{ path: string | null; message: string }>(privateUi, `window.lucium.exportBookmarks({ includeToday: true })`)
      check('import: a private window refuses the import (it keeps no space, pin or history)', importAnswer?.ok === false && /fenêtre privée/.test(importAnswer.message) && brought() === before, JSON.stringify(importAnswer))
      check('export: a private window refuses the export: no dialog, no file, a sentence that says why', exportAnswer?.path === null && /fenêtre privée/.test(exportAnswer.message) && saveCalls.length === calls && readdirSync(tmp).length === filesBefore, JSON.stringify(exportAnswer))
      priv.win.emit('focus')
      const entry = () => menuItem('Lucium', 'Exporter les signets (HTML)…')
      await waitFor(() => entry()?.enabled === false)
      check('export: with a private window in front, the menu entry is greyed out', entry()?.enabled === false)
    } finally {
      priv.win.close()
      await waitFor(() => manager.privateWindows().length === 0)
      await manager.settled()
      win.emit('focus')
    }

    // ======================= the export of the bookmarks =======================
    const outDir = join(tmp, 'out')
    mkdirSync(outDir)
    const exportTo = (name: string | null, includeToday: boolean) => {
      saveAt = name === null ? null : join(outDir, name)
      return evaluate<{ path: string | null; message: string }>(ui, `window.lucium.exportBookmarks({ includeToday: ${includeToday} })`)
    }
    /** The folders and links of one space in the file, found by the space's name. */
    const spaceNodes = (html: string, name: string): BookmarkNode[] => {
      const found = parseNetscapeBookmarks(html).nodes.find((n) => n.kind === 'folder' && n.title === name)
      return found?.kind === 'folder' ? found.children : []
    }
    const links = (nodes: BookmarkNode[]): string[] => nodes.flatMap((n) => (n.kind === 'link' ? [n.url] : links(n.children)))

    const plain = await exportTo('signets.html', false)
    const html = plain.path ? readFileSync(plain.path, 'utf8') : ''
    check('export: the interface asks for a file, which is written where the user said and nowhere else', plain.path === join(outDir, 'signets.html') && readdirSync(outDir).join() === 'signets.html' && /Enregistré dans/.test(plain.message), JSON.stringify(plain))
    check('export: the save dialog was given a name and the HTML filter, and no path came from the interface', saveCalls.at(-1)?.includes('lucium-signets.html') === true && saveCalls.at(-1)?.includes('"html"') === true, saveCalls.at(-1))
    check('export: the file is a bookmarks file (Netscape format, UTF-8)', html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>') && html.includes('charset=UTF-8'))
    const nodes = spaceNodes(html, SPACE_NAME)
    check('export: the space holds its loose pinned tab, then its folder with the two tabs of the split view, nested as in the sidebar', JSON.stringify(nodes) === JSON.stringify([{ kind: 'link', title: HOSTILE_TITLE, url: 'https://smoke-import-p.example/' }, { kind: 'folder', title: FOLDER_NAME, children: [{ kind: 'link', title: 'Volet A', url: 'https://smoke-import-a.example/' }, { kind: 'link', title: 'Volet B', url: 'https://smoke-import-b.example/' }] }]), JSON.stringify(nodes))
    check('export: the Today tabs are not in it unless asked', !html.includes('smoke-import-c.example') && !html.includes('smoke-import-d.example'))
    check('export: the favourites are in a folder of their own', links(parseNetscapeBookmarks(html).nodes.filter((n) => n.kind === 'folder' && n.title === 'Favoris')).includes('https://smoke-import-favori.example/'))
    check('export: a title with markup is escaped: the file holds no script tag of the page', !/<script/i.test(html) && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    // Every pinned web tab and favourite of the state is in the file, once: nothing lost.
    const wanted = [...state().tabs.filter((t) => t.pinned && /^(https?|file):/.test(t.url)).map((t) => new URL(t.url).href), ...state().favorites.filter((f) => /^(https?|file):/.test(f.url)).map((f) => new URL(f.url).href)].sort()
    check('export: every pinned tab and favourite of the browser is in the file exactly once', JSON.stringify(links(parseNetscapeBookmarks(html).nodes).sort()) === JSON.stringify(wanted), `${wanted.length} / ${links(parseNetscapeBookmarks(html).nodes).length}`)

    const withToday = await exportTo('avec-aujourdhui.html', true)
    const htmlToday = withToday.path ? readFileSync(withToday.path, 'utf8') : ''
    const todayFolder = spaceNodes(htmlToday, SPACE_NAME).find((n) => n.kind === 'folder' && n.title === 'Aujourd’hui')
    check('export: with the option, the Today tabs of the space are in a folder of their own', todayFolder?.kind === 'folder' && JSON.stringify(todayFolder.children.map((n) => n.kind === 'link' && n.url)) === JSON.stringify(['https://smoke-import-c.example/', 'https://smoke-import-d.example/']), JSON.stringify(todayFolder))

    const gaveUp = await exportTo(null, false)
    check('export: giving up the dialog writes nothing and says nothing', gaveUp.path === null && gaveUp.message === '' && readdirSync(outDir).length === 2, JSON.stringify(gaveUp))
    saveAt = join(outDir, 'absent', 'signets.html')
    const failed = await evaluate<{ path: string | null; message: string }>(ui, `window.lucium.exportBookmarks({ includeToday: false })`)
    check('export: a file that cannot be written is reported with its name and the reason, and nothing is created', failed.path === null && /Enregistrement impossible dans signets\.html/.test(failed.message) && readdirSync(outDir).length === 2, failed.message)
    const bad = await evaluate<{ path: string | null; message: string }>(ui, `window.lucium.exportBookmarks('/etc/passwd')`)
    check('export: a request that is not an options object is refused without a dialog', bad.path === null && /invalide/.test(bad.message))

    // ---- the Settings pane ----
    browser.closeOverlay()
    browser.openOverlay({ panel: 'settings', pane: 'files' })
    const settings = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
    await waitFor(() => settings().length === 1)
    const sw = settings()[0]!.webContents
    // The title of a group carries the number of its settings (« Signets2 »): it is read by its beginning.
    await waitFor(async () => (await evaluate<boolean>(sw, `!![...document.querySelectorAll('.pref-section > h3')].find((h) => h.textContent.startsWith('Signets'))`)), 10_000)
    const titles = await evaluate<string[]>(sw, `[...document.querySelectorAll('.pref-section > h3')].map((h) => h.textContent)`)
    check('export: Settings › Téléchargements et fichiers has a “Signets” card, after the downloads and the opening of files', titles.some((t) => t.startsWith('Signets')) && titles.findIndex((t) => t.startsWith('Signets')) > titles.findIndex((t) => t.startsWith('Téléchargements')), titles.join('|'))
    check('export: the bar of the export holds the one button “Exporter les données” (the “Plus de réglages…” button is gone: each setting has its row in its own category)', JSON.stringify(await evaluate<string[]>(sw, `[...document.querySelectorAll('.pref-buttons .button')].map((b) => b.textContent.trim())`)) === JSON.stringify(['Exporter les données']))
    check('export: the option for the Today tabs is there and off', await evaluate<boolean>(sw, `(() => { const box = [...document.querySelectorAll('input[role=switch]')].find((i) => i.getAttribute('aria-label') === 'Inclure aussi les onglets du jour'); return !!box && box.checked === false })()`))
    const pressExport = () => evaluate(sw, `[...document.querySelectorAll('.pref-row .button')].find((b) => b.textContent.includes('Exporter les signets (HTML)')).click()`)
    const note = () => evaluate<string>(sw, `[...document.querySelectorAll('.pref-note')].map((n) => n.textContent).join('|')`)
    // A failure of the main process reaches the card as a sentence, and is logged by the page, instead of leaving a button that does nothing.
    dialogFails = true
    await pressExport()
    // The card says that it failed, in a sentence of its own: the reason of the failure is logged by the page (settings.export-impossible-erreur), not written on the card.
    check('export: when the export fails in the main process, the card says so', await waitFor(async () => (await note()).includes(frenchSpaces('Export impossible : une erreur inattendue est survenue.')), 8000), await note())
    dialogFails = false
    saveAt = join(outDir, 'reglages.html')
    await pressExport()
    check('export: the button writes the file and the card says where', await waitFor(async () => (await note()).includes('Enregistré dans'), 8000) && readdirSync(outDir).includes('reglages.html'))
    check('export: that file has no Today tab (the option was off)', !readFileSync(join(outDir, 'reglages.html'), 'utf8').includes('smoke-import-c.example'))
    settings()[0]?.close()
    await waitFor(() => settings().length === 0)

    // ---- the menu ----
    ticked = true
    saveAt = join(outDir, 'menu.html')
    const entry = menuItem('Lucium', 'Exporter les signets (HTML)…')
    check('export: the Lucium menu has “Exporter les signets (HTML)…”, enabled in a normal window, right after the import entry', entry?.enabled === true && menuIndex('Lucium', 'Exporter les signets (HTML)…') === menuIndex('Lucium', 'Importer depuis un autre navigateur…') + 1)
    entry?.click()
    check('export: the menu asks about the Today tabs, then writes the file and says so in a notice', (await waitFor(() => readdirSync(outDir).includes('menu.html'))) && asked.includes('Exporter les signets (HTML)') && (await waitFor(() => (browser.snapshot().toast?.message ?? '').includes('Enregistré dans'), 5000)))
    check('export: the box was ticked, so the Today tabs are in the file', readFileSync(join(outDir, 'menu.html'), 'utf8').includes('smoke-import-c.example'))
  } finally {
    ticked = false
    Object.assign(dialog, { showSaveDialog: real.save, showMessageBox: real.msg, showErrorBox: real.error })
    if (realService) setImportService(realService)
    // Leave the state as it was found.
    for (const id of mineTabs) browser.dispatch({ type: 'tab/close', id })
    for (const boost of state().boosts.filter((b) => b.name.startsWith('Smoke'))) browser.dispatch({ type: 'boost/delete', id: boost.id })
    for (const s of state().spaces.filter((s) => s.name === SPACE_NAME)) browser.dispatch({ type: 'space/delete', id: s.id })
    for (const f of state().favorites.filter((f) => f.url.includes('smoke-import-'))) browser.dispatch({ type: 'favorite/remove', id: f.id })
    for (const entry of history.search('smoke-import', 50)) history.remove(entry.url)
    browser.closeOverlay()
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The item with this label under the menu of this name. */
function menuItem(menu: string, label: string): MenuItem | undefined {
  return Menu.getApplicationMenu()?.items.find((item) => item.label === menu)?.submenu?.items.find((item) => item.label === label)
}

function menuIndex(menu: string, label: string): number {
  return Menu.getApplicationMenu()?.items.find((item) => item.label === menu)?.submenu?.items.findIndex((item) => item.label === label) ?? -1
}

/** `LUCIUM_SMOKE_ONLY=import`: only these checks, with their own report. */
export async function runImportSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeImport(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeImport ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_IMPORT ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
