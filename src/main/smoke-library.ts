// Engine checks for the library functions (bookmarks, live folders, sites as applications), run inside a real Electron. For each of the three:
// that it costs nothing and shows nothing while its switch is off (no menu entry, no panel, no timer, no request, no window), then that it works
// once on, with real clicks and a local server: the bookmark panel (add, edit, filter, remove, export and import through the main process'
// dialogs), the live folders (one single timer, one request per folder, none without a folder, no cookie, hostile feed cleaned, the
// sidebar unchanged when off), the application windows (a window without sidebar, the name and icon, the session of the tab,
// closed with the switch). `LUCIUM_SMOKE_ONLY=library` runs only this file (see index.ts).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItem, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { FEATURES } from '@shared/features'
import { defaultSettings, type Settings } from '@shared/model'
import type { SmokeContext } from './smoke'
import { runningGates } from './shell/feature-gate'
import { menuItems } from './shell/context-menus'
import { getWindowManager } from './shell/windows'
import { noteCheck, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 60)

const RSS = (items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Flux de test</title>${items.join('')}</channel></rss>`
const ITEM = (title: string, link: string) => `<item><title>${title}</title><link>${link}</link></item>`

export async function smokeLibrary(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const ui = overlayView.webContents
  const state = () => store.get()
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>
  const set = (patch: Partial<Settings>) => browser.dispatch({ type: 'settings/update', patch })
  const tmp = mkdtempSync(join(tmpdir(), 'lucium-library-'))
  const manager = getWindowManager()
  if (!manager) throw new Error('the window manager is not there')

  // ---- a local server: pages, a cookie, feeds (good, hostile, missing) ----
  const hits: Array<{ path: string; headers: IncomingHttpHeaders }> = []
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    hits.push({ path, headers: req.headers })
    const html = (body: string) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    }
    const xml = (body: string) => {
      res.setHeader('content-type', 'application/rss+xml; charset=utf-8')
      res.setHeader('set-cookie', 'feedcookie=1; Path=/')
      res.end(body)
    }
    const origin = `http://${req.headers.host}`
    if (path === '/feed.xml') return xml(RSS([ITEM('Premier billet', `${origin}/billet/1`), ITEM('Deuxième billet', `${origin}/billet/2`), ITEM('Troisième billet', `${origin}/billet/3`)]))
    if (path === '/evil.xml') {
      return xml(
        `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY big "${'x'.repeat(100)}">]><rss><channel><title>Mauvais</title>` +
          ITEM('&xxe; piège', `${origin}/billet/ok`) +
          ITEM('Script', 'javascript:alert(1)') +
          ITEM('Fichier', 'file:///etc/passwd') +
          ITEM(`T${'t'.repeat(5000)}`, `${origin}/billet/long`) +
          '</channel></rss>'
      )
    }
    if (path === '/set-cookie') {
      res.setHeader('set-cookie', 'session=du-profil; Path=/')
      return html('<title>cookie posé</title><body>ok</body>')
    }
    if (path === '/whoami') return html(`<title>Mon application</title><link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="><body>cookie ${req.headers.cookie ?? 'aucun'}</body>`)
    if (path === '/favicon.ico' || path === '/missing') return void res.writeHead(404).end()
    html(`<title>page ${path}</title><body>${path}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const host = `127.0.0.1:${port}`
  const hitsOn = (path: string) => hits.filter((h) => h.path === path)

  // ---- helpers over the real windows ----
  const menuItem = (...path: string[]): MenuItem | undefined => {
    let items: MenuItem[] = Menu.getApplicationMenu()?.items ?? []
    let found: MenuItem | undefined
    for (const label of path) {
      found = items.find((item) => item.label === label)
      items = found?.submenu?.items ?? []
    }
    return found
  }
  const tabMenu = (id: string) => menuItems({ kind: 'tab', id }, browser, store, win)
  const folderMenu = (id: string) => menuItems({ kind: 'folder', id }, browser, store, win)
  const mouse = async (target: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => {
    target.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
    await sleep(30)
  }
  interface Box {
    x: number
    y: number
    w: number
    h: number
  }
  /** A real click on the first element matching the selector (containing the text, when given) of a surface. */
  const clickIn = async (target: WebContents, selector: string, text = ''): Promise<boolean> => {
    const box = await evaluate<Box | null>(
      target,
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`
    )
    if (!box) return false
    await mouse(target, 'mouseMove', box.x + box.w / 2, box.y + box.h / 2)
    await mouse(target, 'mouseDown', box.x + box.w / 2, box.y + box.h / 2)
    await mouse(target, 'mouseUp', box.x + box.w / 2, box.y + box.h / 2)
    await sleep(150)
    return true
  }
  /** Types into a React field the way the page's own input event would. */
  const setField = (target: WebContents, selector: string, value: string) =>
    evaluate<boolean>(
      target,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
    )
  const text = (target: WebContents, selector: string) => evaluate<string>(target, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const count = (target: WebContents, selector: string) => evaluate<number>(target, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const openPanel = async (request: Parameters<typeof browser.openOverlay>[0], selector: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay(request)
      if (await waitFor(async () => browser.currentPanel() === request.panel && (await count(ui, selector)) > 0, 2500)) return true
    }
    return false
  }
  const toast = () => browser.snapshot().toast?.message ?? ''
  const openTab = async (path: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const tab = state().tabs.at(-1)!
    await waitFor(() => browser.snapshot().state.tabs.some((t) => t.id === tab.id))
    await sleep(400)
    return tab
  }
  /** Replaces the dialogs of the main process by answers the test chooses. */
  const real = { open: dialog.showOpenDialog, save: dialog.showSaveDialog }
  let openAnswer: string | null = null
  let saveAnswer: string | null = null
  let dialogCalls = 0
  Object.assign(dialog, {
    showOpenDialog: async () => {
      dialogCalls++
      return openAnswer === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [openAnswer] }
    },
    showSaveDialog: async () => {
      dialogCalls++
      return saveAnswer === null ? { canceled: true } : { canceled: false, filePath: saveAnswer }
    }
  })

  const before = { favorites: JSON.stringify(state().favorites), pinned: state().tabs.filter((t) => t.pinned).length }
  const section = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      check(`${name}: ran to the end`, false, String((error as Error).stack ?? error))
    }
  }
  const windowsOfApps = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('app=1'))

  try {
    // ======================= the registry =======================
    check('registry: bookmarks, live-folders and pwa are registered, and all three are off by default', ['bookmarks', 'live-folders', 'pwa'].every((id) => FEATURES.some((f) => f.id === id)) && !defaultSettings().bookmarkManager && !defaultSettings().liveFolders && !defaultSettings().webAppWindows)
    set({ bookmarkManager: false, liveFolders: false, webAppWindows: false })

    // ======================= everything off: nothing shows, nothing runs =======================
    await section('off', async () => {
      const page = await openTab('/page/off')
      await waitFor(() => menuItem('Fichier', 'Ajouter aux signets') !== undefined)
      check('off: the File entries are hidden (and the Tabs entry), with their shortcuts dead', ['Ajouter aux signets', 'Signets…', 'Ouvrir comme application'].every((l) => menuItem('Fichier', l)?.visible === false && menuItem('Fichier', l)?.enabled === false) && menuItem('Onglets', 'Nouveau dossier en direct…')?.visible === false)
      check('off: the menu of a tab has no entry for them', !tabMenu(page.id).some((i) => ['Ajouter aux signets', 'Ouvrir comme application'].includes(String(i.label))))
      browser.dispatch({ type: 'bookmark/add', tabId: page.id })
      browser.dispatch({ type: 'livefolder/create', source: { kind: 'feed', url: `${base}/feed.xml` } })
      check('off: the actions of the library change nothing', state().bookmarks.length === 0 && state().folders.every((f) => !f.live))
      browser.openOverlay({ panel: 'bookmarks' })
      browser.openOverlay({ panel: 'livefolder' })
      check('off: neither panel opens, from the menu or from the interface', browser.currentPanel() !== 'bookmarks' && browser.currentPanel() !== 'livefolder')
      await evaluate(win.webContents, `window.lucium.openOverlay({ panel: 'bookmarks' })`)
      // The witness: the request is a message without an answer; a question asked after it on the same channel is answered only once the main
      // process has handled it.
      await evaluate(win.webContents, 'window.lucium.getSnapshot().then(() => 0)')
      check('off: …the interface cannot ask for them either', browser.currentPanel() !== 'bookmarks')
      // No wait: openAsApp decides before it returns, and a window it opens is made by then (shell/browser.ts, shell/web-apps.ts).
      browser.openAsApp()
      check('off: no application window opens, and nothing of the three runs', windowsOfApps().length === 0 && !browser.liveFoldersRunning().running && !browser.liveFoldersArmed() && !runningGates().includes('pwa') && !runningGates().includes('live-folders'))
      browser.dispatch({ type: 'tab/close', id: page.id })
    })

    // ======================= the bookmark library =======================
    await section('bookmarks', async () => {
      set({ bookmarkManager: true })
      const page = await openTab('/page/signet')
      await waitFor(() => menuItem('Fichier', 'Ajouter aux signets')?.visible === true)
      check('bookmarks: the File entries are there, the shortcut of Arc (⌘D, pin) is untouched', menuItem('Fichier', 'Ajouter aux signets')?.visible === true && menuItem('Fichier', 'Signets…')?.visible === true && menuItem('Onglets', 'Épingler l’onglet')?.accelerator === 'CmdOrCtrl+D')
      check('bookmarks: the menu of a tab offers it', tabMenu(page.id).some((i) => i.label === 'Ajouter aux signets'))
      ;(menuItem('Fichier', 'Ajouter aux signets')?.click as () => void)()
      check('bookmarks: the page is kept, the tab stays open, a notice says so', (await waitFor(() => state().bookmarks.length === 1)) && state().tabs.some((t) => t.id === page.id) && (await waitFor(() => toast() === 'Ajouté aux signets')), toast())
      ;(menuItem('Fichier', 'Ajouter aux signets')?.click as () => void)()
      check('bookmarks: the same page again is not added twice', (await waitFor(() => toast() === 'Déjà dans les signets')) && state().bookmarks.length === 1)

      check('bookmarks: the panel opens and lists the bookmark', await openPanel({ panel: 'bookmarks' }, '.bookmark-row'))
      check('bookmarks: a real click on "Modifier" opens the form; tags and note are saved', await (async () => {
        if (!(await clickIn(ui, '[data-action="edit"]'))) return false
        await waitFor(async () => (await count(ui, '[data-field="tags"]')) === 1)
        await setField(ui, '[data-field="title"]', 'Mon signet')
        await setField(ui, '[data-field="tags"]', 'Lecture, outils, lecture')
        await setField(ui, '[data-field="note"]', 'à relire')
        await clickIn(ui, '[data-action="save"]')
        return waitFor(() => JSON.stringify(state().bookmarks[0]?.tags) === JSON.stringify(['Lecture', 'outils']) && state().bookmarks[0]?.title === 'Mon signet' && state().bookmarks[0]?.note === 'à relire')
      })(), JSON.stringify(state().bookmarks))
      browser.dispatch({ type: 'bookmarks/import', entries: [{ url: `${base}/page/deux`, title: 'Deuxième', tags: ['outils'] }] })
      check('bookmarks: the tag chips show the counts and a click on one narrows the list', await (async () => {
        await waitFor(async () => (await count(ui, '.bookmark-row')) === 2)
        const chips = await text(ui, '.bookmarks .lp-filters')
        await clickIn(ui, '[data-action="chip"]', 'Lecture')
        return chips.includes('#outils') && (await waitFor(async () => (await count(ui, '.bookmark-row')) === 1))
      })())
      check('bookmarks: the search field filters (a word starting with # is a tag)', await (async () => {
        await clickIn(ui, '[data-action="chip"]', 'Lecture')
        await setField(ui, '.bookmarks input[type="search"]', '#outils')
        const two = await waitFor(async () => (await count(ui, '.bookmark-row')) === 2)
        await setField(ui, '.bookmarks input[type="search"]', 'deuxi')
        const one = await waitFor(async () => (await count(ui, '.bookmark-row')) === 1)
        await setField(ui, '.bookmarks input[type="search"]', '')
        return two && one
      })())
      check('bookmarks: ↓ goes from the search to the first bookmark, then to the next', await (async () => {
        await clickIn(ui, '.bookmarks input[type="search"]')
        const focusedRow = () => evaluate<string | null>(ui, `document.activeElement?.classList.contains('lp-main') ? document.activeElement.closest('.bookmark-row')?.dataset.id ?? null : null`)
        const ids = await evaluate<string[]>(ui, `[...document.querySelectorAll('.bookmark-row')].map((row) => row.dataset.id)`)
        ui.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
        ui.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
        const first = await waitFor(async () => (await focusedRow()) === ids[0])
        ui.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
        ui.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
        return ids.length === 2 && first && (await waitFor(async () => (await focusedRow()) === ids[1]))
      })())
      check('bookmarks: "Supprimer" takes the row away at once and offers "Annuler"; ⌘Z brings it back; left without it, the bookmark is deleted', await (async () => {
        await clickIn(ui, '[data-action="remove"]')
        const gone = (await waitFor(async () => (await count(ui, '.bookmark-row')) === 1)) && (await text(ui, '.bookmarks .lp-undo')).includes('Annuler') && state().bookmarks.length === 2
        // ⌘Z, from a row (in the search it takes back what was typed).
        await evaluate(ui, `document.querySelector('.bookmark-row .lp-main')?.focus()`)
        ui.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['meta'] })
        ui.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['meta'] })
        const back = (await waitFor(async () => (await count(ui, '.bookmark-row')) === 2)) && (await count(ui, '.bookmarks .lp-undo')) === 0 && state().bookmarks.length === 2
        await clickIn(ui, '[data-action="remove"]')
        await waitFor(async () => (await count(ui, '.bookmark-row')) === 1)
        const waiting = state().bookmarks.length === 2
        // Leaving the panel makes the deletion that was waiting.
        browser.closeOverlay()
        const deleted = await waitFor(() => state().bookmarks.length === 1)
        return gone && back && waiting && deleted && (await openPanel({ panel: 'bookmarks' }, '.bookmark-row'))
      })())

      // Export, through the main process' dialog.
      const exported = join(tmp, 'bibliotheque.html')
      saveAnswer = exported
      await clickIn(ui, '[data-action="export"]')
      check('bookmarks: "Exporter…" writes the file at the path chosen, with the tags, and tells where', (await waitFor(() => existsSync(exported))) && /TAGS="outils"/.test(readFileSync(exported, 'utf8')) && readFileSync(exported, 'utf8').includes('Deuxième') && (await waitFor(async () => (await text(ui, '.bookmarks-message')).includes(exported))))

      // Import: a hostile file next to valid links.
      const hostile = join(tmp, 'importer.html')
      writeFileSync(
        hostile,
        `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Recettes</H3><DL><p><DT><A HREF="${base}/page/tarte" ADD_DATE="1600000000" TAGS="cuisine">Tarte</A><DT><A HREF="javascript:alert(1)">Piège</A><DT><A HREF="data:text/html,x">Données</A><DT><A HREF="file:///etc/passwd">Fichier</A></DL><p><DT><A HREF="${base}/page/${'x'.repeat(5000)}">Trop long</A></DL>`
      )
      openAnswer = hostile
      await clickIn(ui, '[data-action="import"]')
      const urls = () => state().bookmarks.map((b) => b.url)
      check('bookmarks: "Importer…" keeps the valid link (tagged by its folder) and none of the hostile ones', (await waitFor(() => urls().includes(`${base}/page/tarte`))) && urls().every((u) => /^https?:\/\//.test(u) && u.length <= 4096) && JSON.stringify(state().bookmarks.find((b) => b.url.endsWith('/tarte'))?.tags) === JSON.stringify(['cuisine', 'Recettes']), JSON.stringify(urls()))
      openAnswer = null
      const calls = dialogCalls
      await clickIn(ui, '[data-action="import"]')
      // The witness: the dialog was asked, and its answer (given up) ends the import without a word (shell/bookmarks-library.ts).
      const askedForFile = await waitFor(() => dialogCalls === calls + 1)
      check('bookmarks: giving up the dialog changes nothing', askedForFile && state().bookmarks.length === 2, String(dialogCalls - calls))

      // A private window imports and exports nothing.
      const priv = manager.openPrivate()
      try {
        await waitFor(async () => (await evaluate<boolean>(priv.win.webContents, `typeof window.lucium?.bookmarksTransfer === 'function'`).catch(() => false)))
        const calls2 = dialogCalls
        const reply = await evaluate<{ ok: boolean; message: string }>(priv.win.webContents, `window.lucium.bookmarksTransfer({ op: 'export' })`)
        check('bookmarks: a private window refuses the file of bookmarks: no dialog, a sentence', reply?.ok === false && /privée/.test(reply.message) && dialogCalls === calls2, JSON.stringify(reply))
        const bad = await evaluate<{ ok: boolean; message: string }>(priv.win.webContents, `window.lucium.bookmarksTransfer({ op: '/etc/passwd' })`)
        check('bookmarks: …and a request that is not "import" or "export" is refused', bad?.ok === false)
        check('bookmarks: …and the private window keeps no bookmark', priv.store.get().bookmarks.length === 0)
      } finally {
        priv.win.close()
        await waitFor(() => manager.privateWindows().length === 0)
        await manager.settled()
        win.emit('focus')
      }

      store.flush()
      const onDisk = JSON.parse(readFileSync(join(app.getPath('userData'), 'state.json'), 'utf8')) as { bookmarks?: Array<{ url: string }> }
      check('bookmarks: the library is in the state file', (onDisk.bookmarks ?? []).length === state().bookmarks.length)
      check('bookmarks: the favourites and pinned tabs of Arc were not touched by any of it', JSON.stringify(state().favorites) === before.favorites && state().tabs.filter((t) => t.pinned).length === before.pinned)
      browser.closeOverlay()
      set({ bookmarkManager: false })
      await waitFor(() => menuItem('Fichier', 'Signets…')?.visible === false)
      browser.openOverlay({ panel: 'bookmarks' })
      browser.dispatch({ type: 'bookmark/remove', id: state().bookmarks[0]!.id })
      check('bookmarks: switched off again, the entries are hidden, the panel refuses, nothing is removed (the data stays)', menuItem('Fichier', 'Signets…')?.visible === false && browser.currentPanel() !== 'bookmarks' && state().bookmarks.length === 2)
      browser.dispatch({ type: 'tab/close', id: page.id })
    })

    // ======================= live folders =======================
    await section('live folders', async () => {
      browser.setLiveFoldersTest({ gapMs: 300, allowHost: (h) => h === host })
      set({ liveFolders: true })
      check('live folders: the function is on and has no folder: no timer, no request', await waitFor(() => browser.liveFoldersRunning().running) && !browser.liveFoldersArmed() && runningGates().includes('live-folders'))
      // A fixed wait, for want of a witness: what is checked is that time passes with no request, and nothing comes to say that none will.
      await sleep(2500)
      check('live folders: …and still none a few seconds later', hitsOn('/feed.xml').length === 0 && !browser.liveFoldersArmed())
      check('live folders: the entry of the Tabs menu is there', menuItem('Onglets', 'Nouveau dossier en direct…')?.visible === true)

      // The sheet, with real clicks.
      check('live folders: the sheet opens', await openPanel({ panel: 'livefolder' }, '[data-field="source"]'))
      await setField(ui, '[data-field="source"]', 'pas une adresse')
      check('live folders: a source that is not one cannot be created', await waitFor(async () => (await evaluate<boolean>(ui, `document.querySelector('[data-action="submit"]')?.disabled === true`))))
      await setField(ui, '[data-field="source"]', `${base}/feed.xml`)
      await setField(ui, '[data-field="name"]', 'Mon flux')
      await clickIn(ui, '[data-action="submit"]')
      check('live folders: a folder is made, live', await waitFor(() => state().folders.some((f) => f.name === 'Mon flux' && f.live?.source.kind === 'feed')))
      const folder = state().folders.find((f) => f.name === 'Mon flux')!
      check('live folders: the single timer is armed for it', browser.liveFoldersArmed() || hitsOn('/feed.xml').length > 0)
      check('live folders: it is read, and the three items are in the folder', await waitFor(() => (state().folders.find((f) => f.id === folder.id)?.live?.items.length ?? 0) === 3, 12_000), JSON.stringify(state().folders.find((f) => f.id === folder.id)?.live))
      check('live folders: one request for it, without cookie, referrer or login', hitsOn('/feed.xml').length === 1 && hitsOn('/feed.xml').every((h) => h.headers.cookie === undefined && h.headers.referer === undefined && h.headers.authorization === undefined))
      check('live folders: the items are rows of the sidebar', await waitFor(async () => (await count(win.webContents, '[data-live-item]')) === 3), String(await count(win.webContents, '[data-live-item]')))
      const tabsBefore = state().tabs.length
      await clickIn(win.webContents, '[data-live-item]', 'Deuxième billet')
      check('live folders: a click opens the item in a new tab', await waitFor(() => state().tabs.length === tabsBefore + 1 && state().tabs.at(-1)?.url === `${base}/billet/2`))
      // The feed set a cookie: a second look must not send it back.
      browser.dispatch({ type: 'livefolder/refresh', id: folder.id })
      check('live folders: "Actualiser" looks again (after the pause), and the cookie the feed set is not sent back', (await waitFor(() => hitsOn('/feed.xml').length === 2, 12_000)) && hitsOn('/feed.xml')[1]!.headers.cookie === undefined, JSON.stringify(hitsOn('/feed.xml').map((h) => h.headers.cookie)))
      check('live folders: its menu offers the refresh and the source', folderMenu(folder.id).some((i) => i.label === 'Actualiser le dossier en direct') && folderMenu(folder.id).some((i) => i.label === 'Modifier la source…'))

      // A hostile feed, and a feed that is not there.
      browser.dispatch({ type: 'livefolder/create', source: { kind: 'feed', url: `${base}/evil.xml` }, name: 'Hostile' })
      browser.dispatch({ type: 'livefolder/create', source: { kind: 'feed', url: `${base}/missing` }, name: 'Absent' })
      const evil = () => state().folders.find((f) => f.name === 'Hostile')?.live
      const absent = () => state().folders.find((f) => f.name === 'Absent')?.live
      check('live folders: the hostile feed gives its safe item only: no script, no file, no entity read, bounded', (await waitFor(() => (evil()?.items.length ?? 0) > 0 && (evil()?.checkedAt ?? 0) > 0, 15_000)) && evil()!.items.every((i) => /^https?:\/\//.test(i.url) && i.title.length <= 200 && !i.title.includes('root:')), JSON.stringify(evil()))
      check('live folders: a feed that is not there is told in the folder', (await waitFor(() => absent()?.failure !== undefined, 15_000)) && (await waitFor(async () => (await text(win.webContents, `[data-live-status="${state().folders.find((f) => f.name === 'Absent')!.id}"]`)).includes('Lecture impossible'))), JSON.stringify(absent()))
      const log = hits.length

      // Switched off: nothing runs, and the folder is an ordinary one to the eye.
      browser.dispatch({ type: 'folder/create', name: 'Ordinaire' })
      const plain = state().folders.at(-1)!
      set({ liveFolders: false })
      check('live folders: switched off, the service and its timer are gone', await waitFor(() => !browser.liveFoldersRunning().running && !browser.liveFoldersArmed() && !runningGates().includes('live-folders')))
      browser.dispatch({ type: 'livefolder/refresh' })
      // A fixed wait, for want of a witness: a request asked for anyway would reach the server some time later, and nothing answers the refresh.
      await sleep(2500)
      check('live folders: …nothing is asked of the network any more', hits.length === log, `${hits.length - log} requests`)
      check('live folders: …the sidebar draws no item and no status line', (await count(win.webContents, '[data-live-item]')) === 0 && (await count(win.webContents, '[data-live-status]')) === 0)
      const shape = (id: string) => evaluate<{ html: string; height: number } | null>(win.webContents, `(() => { const t = document.querySelector('.folder-title[data-id=${JSON.stringify(id)}]'); const f = t?.closest('.folder'); return f ? { html: f.outerHTML.replace(/data-id="[^"]*"/g, '').replace(/data-parent="[^"]*"/g, '').replace(/data-first="[^"]*"/g, '').replace(${JSON.stringify(folder.name)}, 'NOM').replace('Ordinaire', 'NOM'), height: f.getBoundingClientRect().height } : null })()`)
      // The sidebar is drawn again after the setting went off: the two folders are compared once they look alike, or the check below says how they differ.
      await waitFor(async () => {
        const [live, ordinary] = [await shape(folder.id), await shape(plain.id)]
        return live !== null && ordinary !== null && live.html === ordinary.html && live.height === ordinary.height
      })
      const [liveShape, plainShape] = [await shape(folder.id), await shape(plain.id)]
      check('live folders: switched off, a live folder is the same DOM and the same height as an ordinary folder (Arc’s cotes)', liveShape !== null && plainShape !== null && liveShape.html === plainShape.html && liveShape.height === plainShape.height, JSON.stringify([liveShape, plainShape]).slice(0, 600))
      check('live folders: switched off, the menus offer nothing about them', menuItem('Onglets', 'Nouveau dossier en direct…')?.visible === false && !folderMenu(folder.id).some((i) => i.label === 'Modifier la source…'))

      // A private window: the function is on, a live folder cannot exist there, nothing is read.
      set({ liveFolders: true })
      const priv = manager.openPrivate()
      try {
        // No wait: a private window never makes the service, which is decided as the window is built (shell/browser.ts).
        check('live folders: a private window runs no service and has no live folder', !priv.browser.liveFoldersRunning().running && !priv.browser.liveFoldersArmed() && priv.store.get().folders.every((f) => !f.live))
        priv.browser.dispatch({ type: 'livefolder/create', source: { kind: 'feed', url: `${base}/feed.xml` } })
        check('live folders: …and refuses to make one', priv.store.get().folders.every((f) => !f.live))
      } finally {
        priv.win.close()
        await waitFor(() => manager.privateWindows().length === 0)
        await manager.settled()
        win.emit('focus')
      }
      set({ liveFolders: false })
    })

    // ======================= sites as applications =======================
    await section('applications', async () => {
      const listenersOff = ipcMain.listenerCount(Channel.littleAction)
      set({ webAppWindows: true })
      check('applications: the manager exists while the setting is on (one listener more), and the entry is there', await waitFor(() => runningGates().includes('pwa') && ipcMain.listenerCount(Channel.littleAction) === listenersOff + 1 && menuItem('Fichier', 'Ouvrir comme application')?.visible === true))
      // The session of the tab: a cookie set in its profile is sent by the window.
      const cookieTab = await openTab('/set-cookie')
      const tab = await openTab('/whoami')
      browser.dispatch({ type: 'tab/select', id: tab.id })
      await waitFor(() => state().tabs.find((t) => t.id === tab.id)?.title === 'Mon application')
      check('applications: the menu of the tab offers it', tabMenu(tab.id).some((i) => i.label === 'Ouvrir comme application'))
      const windowsBefore = BrowserWindow.getAllWindows().length
      const asked = hitsOn('/whoami').length
      ;(menuItem('Fichier', 'Ouvrir comme application')?.click as () => void)()
      check('applications: a window opens, its interface is the application header (no sidebar)', await waitFor(() => windowsOfApps().length === 1), String(windowsOfApps().length))
      const appWin = windowsOfApps()[0]!
      check('applications: …it has the name and the icon of the site, and nothing of the sidebar', await waitFor(async () => (await text(appWin.webContents, '.wa-name')) === 'Mon application') && (await count(appWin.webContents, '.wa-header')) === 1 && (await count(appWin.webContents, '.sidebar')) === 0, await text(appWin.webContents, '.wa-name'))
      check('applications: …its page carries the cookie of the profile of the tab (the session of the space)', await waitFor(() => hitsOn('/whoami').length > asked && String(hitsOn('/whoami').at(-1)!.headers.cookie ?? '').includes('session=du-profil')), JSON.stringify(hitsOn('/whoami').map((h) => h.headers.cookie)))
      check('applications: the main window is where it was (no tab added by opening)', BrowserWindow.getAllWindows().length === windowsBefore + 1 && state().tabs.some((t) => t.id === tab.id))
      // From the command bar's route, and a private window.
      const priv = manager.openPrivate()
      try {
        // No wait: openAsApp decides before it returns, and a private window asks for nothing (shell/browser.ts).
        priv.browser.openAsApp()
        check('applications: a private window opens none', windowsOfApps().length === 1)
      } finally {
        priv.win.close()
        await waitFor(() => manager.privateWindows().length === 0)
        await manager.settled()
        win.emit('focus')
      }
      set({ webAppWindows: false })
      check('applications: switched off, the window closes, the listener goes, the entry is hidden', await waitFor(() => windowsOfApps().length === 0 && !runningGates().includes('pwa') && ipcMain.listenerCount(Channel.littleAction) === listenersOff && menuItem('Fichier', 'Ouvrir comme application')?.visible === false))
      // No wait: openAsApp decides before it returns, and a window it opens is made by then (shell/web-apps.ts).
      browser.openAsApp()
      check('applications: …and nothing opens afterwards', windowsOfApps().length === 0)
      browser.dispatch({ type: 'tab/close', id: tab.id })
      browser.dispatch({ type: 'tab/close', id: cookieTab.id })
    })
  } finally {
    Object.assign(dialog, { showOpenDialog: real.open, showSaveDialog: real.save })
    // What this suite made does not stay for the suites after it: the bookmarks (removed with the function on), the folders and the tabs of its server.
    browser.closeOverlay()
    set({ bookmarkManager: true })
    for (const bookmark of [...state().bookmarks]) browser.dispatch({ type: 'bookmark/remove', id: bookmark.id })
    for (const folder of [...state().folders]) if (['Mon flux', 'Hostile', 'Absent', 'Ordinaire'].includes(folder.name)) browser.dispatch({ type: 'folder/delete', id: folder.id })
    for (const tab of [...state().tabs]) if (tab.url.startsWith(base)) browser.dispatch({ type: 'tab/close', id: tab.id })
    set({ bookmarkManager: false, liveFolders: false, webAppWindows: false })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The same checks with their own report, for `LUCIUM_SMOKE_ONLY=library` and for the chain in index.ts. */
export async function runLibrarySmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    const verbose = process.env['LUCIUM_LIBRARY_VERBOSE'] === '1'
    await smokeLibrary(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`LIBRARY ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeLibrary ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_LIBRARY ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
