// Engine checks for "Lire plus tard" (the read-later list), run inside a real Electron: a real tab is saved (title and icon read from
// the page, tab closed), the state is read back from disk, the list is opened, filtered, emptied with real mouse and key events, and
// the entries of the File menu, the tab menu and the command bar are used. Called from the engine smoke test:
// `await smokeReadLater(ctx, check)`; `LUCIUM_SMOKE_ONLY=readlater` runs only this file (see index.ts).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, Menu, type MenuItem, type WebContents } from 'electron'
import { READ_LATER_LIMIT, type ReadLaterItem } from '@shared/model'
import { readLaterNotice } from '@shared/read-later'
import type { SmokeContext } from './smoke'
import { menuItems } from './shell/context-menus'
import { getWindowManager } from './shell/windows'
import { loadState } from './store'
import { noteCheck, sleep, waiterOf } from './smoke-kit'
import { iconSource } from '@shared/site-icon'
import { ACTION_NOTICE_MS } from '@shared/toast'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 60)

// A 1x1 PNG: the page's icon.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export async function smokeReadLater(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const ui = overlayView.webContents
  const state = () => store.get()
  const userData = app.getPath('userData')
  const statePath = join(userData, 'state.json')
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/icon.png') {
      res.setHeader('content-type', 'image/png')
      return res.end(PIXEL)
    }
    if (path === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (path === '/article') return void res.end('<title>Article à lire</title><link rel="icon" type="image/png" href="/icon.png"><body>un long article</body>')
    if (path === '/second') return void res.end('<title>Second article</title><body>sans icône</body>')
    res.end(`<title>page ${path}</title><body>${path}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`

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
  const fileEntry = (label: string) => menuItem('Fichier', label)
  const tabMenuEntry = (id: string, label: string) => menuItems({ kind: 'tab', id }, browser, store, win).find((i) => i.label === label)
  const chooseTabMenu = (id: string, label: string) => (tabMenuEntry(id, label)?.click as (() => void) | undefined)?.()
  const toast = () => browser.snapshot().toast
  const tabOf = (url: string) => state().tabs.find((t) => t.url === url)
  const mouse = async (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => {
    ui.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
    await sleep(30)
  }
  interface Box {
    x: number
    y: number
    w: number
    h: number
  }
  const clickBox = async (box: Box | null): Promise<boolean> => {
    if (!box) return false
    await mouse('mouseMove', box.x + box.w / 2, box.y + box.h / 2)
    await mouse('mouseDown', box.x + box.w / 2, box.y + box.h / 2)
    await mouse('mouseUp', box.x + box.w / 2, box.y + box.h / 2)
    await sleep(150)
    return true
  }
  /**
   * The notice of a deletion waits while the pointer or the focus is on it (ACTION_NOTICE_MS, renderer/notice-hold.ts): the pointer goes just above it
   * and the focus leaves it, as for a person who reads it from afar, so that the deletion is made when its time is over.
   */
  const leaveNotice = async (): Promise<void> => {
    const box = await evaluate<Box | null>(ui, `(() => { const el = document.querySelector('.readlater-undo'); if (!el) return null; if (el.contains(document.activeElement)) document.activeElement.blur(); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
    if (box) await mouse('mouseMove', box.x + box.w / 2, Math.max(0, box.y - 24))
  }
  /** A real click on the first element matching the selector (and containing the text, when given) of the overlay. */
  const clickIn = (selector: string, text = ''): Promise<boolean> =>
    evaluate<Box | null>(
      ui,
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`
    ).then(clickBox)
  /** A real click on the "Ouvrir" or "Supprimer" button of the row of the page with this title. */
  const clickRow = (title: string, action: 'open' | 'remove'): Promise<boolean> =>
    evaluate<Box | null>(
      ui,
      `(() => { const row = [...document.querySelectorAll('.readlater-row')].find((r) => r.querySelector('.readlater-title')?.textContent === ${JSON.stringify(title)}); const el = row?.querySelector('[data-action="${action}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`
    ).then(clickBox)
  const typeText = async (text: string) => {
    for (const ch of text) {
      const keyCode = ch === ' ' ? 'Space' : ch
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(40)
    }
    await sleep(250)
  }
  const keyPress = async (keyCode: string, times = 1) => {
    for (let i = 0; i < times; i++) {
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(60)
    }
  }
  const rows = () =>
    evaluate<Array<{ id: string; title: string; meta: string; icon: 'img' | 'letter'; iconSrc: string; loaded: boolean }>>(
      ui,
      `[...document.querySelectorAll('.readlater-row')].map((li) => { const img = li.querySelector('img.readlater-icon'); return { id: li.dataset.id, title: li.querySelector('.readlater-title')?.textContent ?? '', meta: li.querySelector('.readlater-meta')?.textContent ?? '', icon: img ? 'img' : 'letter', iconSrc: img ? img.src : (li.querySelector('.readlater-icon')?.textContent ?? ''), loaded: img ? img.complete && img.naturalWidth > 0 : false } })`
    )
  const panelText = () => evaluate<string>(ui, `document.querySelector('.readlater')?.textContent ?? ''`)
  /** A request sent while the overlay page is still starting is lost: ask again until the panel is drawn. */
  const openPanel = async (viaInterface = false) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (viaInterface) await evaluate(win.webContents, `window.lucium.openOverlay({ panel: 'readlater' })`)
      else browser.openOverlay({ panel: 'readlater' })
      // The panel of the last opening may still be in the page for a moment: wait for the one that shows the list as it is now.
      if (await waitFor(async () => browser.currentPanel() === 'readlater' && (await rows()).length === state().readLater.length && (await evaluate<boolean>(ui, `!!document.querySelector('.readlater')`)), 2500)) return true
    }
    return false
  }
  const savedBefore = state().readLater.length
  const previousSpace = state().activeSpaceId
  browser.dispatch({ type: 'space/create', name: 'Lire plus tard', emoji: '🔖', hue: 30 })
  const spaceId = state().activeSpaceId
  const openTab = async (path: string, title: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}`, spaceId })
    const ok = await waitFor(() => state().tabs.some((t) => t.url === `${base}${path}` && t.title === title))
    return ok ? tabOf(`${base}${path}`)! : undefined
  }

  // ---- 1. a real tab is saved through File › Lire plus tard ----
  const entry = fileEntry('Lire plus tard')
  check('the run starts from an empty list (a fresh profile)', savedBefore === 0, String(savedBefore))
  check('File has "Lire plus tard" and "Liste de lecture…", with no shortcut of their own (Arc has none)', !!entry && !!fileEntry('Liste de lecture…') && !entry.accelerator && !fileEntry('Liste de lecture…')?.accelerator, `${entry?.label} / ${fileEntry('Liste de lecture…')?.label}`)
  const article = await openTab('/article', 'Article à lire')
  check('a real tab loaded its title and its icon', !!article && (await waitFor(() => tabOf(`${base}/article`)?.faviconUrl === `${base}/icon.png`)), JSON.stringify(article))
  const articleId = article?.id ?? ''
  await waitFor(() => fileEntry('Lire plus tard')?.enabled === true)
  check('the entry is available for a web page on screen', fileEntry('Lire plus tard')?.enabled === true && state().activeTabBySpace[spaceId] === articleId)
  const before = Date.now()
  fileEntry('Lire plus tard')?.click()
  check('choosing it keeps the page: address, title as the page gave it, icon, date', state().readLater.length === savedBefore + 1 && state().readLater[0]?.url === `${base}/article` && state().readLater[0]?.title === 'Article à lire' && state().readLater[0]?.faviconUrl === `${base}/icon.png` && (state().readLater[0]?.savedAt ?? 0) >= before && (state().readLater[0]?.savedAt ?? Infinity) <= Date.now(), JSON.stringify(state().readLater[0]).slice(0, 240))
  check('…and closes the tab: gone from the state and its page destroyed', !state().tabs.some((t) => t.id === articleId) && (await waitFor(() => !browser.livePageIds().includes(articleId))))
  check('a notice says so, with a way to undo', toast()?.message === readLaterNotice('saved') && toast()?.action === 'Annuler' && toast()?.secondAction === 'Ouvrir la liste', JSON.stringify(toast()))

  // ---- 2. the state is read back from the disk ----
  check('the state is written', store.flush())
  const reread = loadState(statePath)
  check('read back from state.json, the list is the one in memory, in the same order', JSON.stringify(reread.readLater) === JSON.stringify(state().readLater) && reread.readLater[0]?.url === `${base}/article`, JSON.stringify(reread.readLater[0]).slice(0, 200))
  check('the file holds the saved entry as plain data', (JSON.parse(readFileSync(statePath, 'utf8')) as { readLater: ReadLaterItem[] }).readLater.some((r) => r.url === `${base}/article` && r.title === 'Article à lire'))

  // ---- 3. the same page again: no duplicate, the first entry stays, the tab still closes ----
  const firstId = state().readLater[0]!.id
  const firstDate = state().readLater[0]!.savedAt
  const again = await openTab('/article', 'Article à lire')
  await waitFor(() => fileEntry('Lire plus tard')?.enabled === true)
  fileEntry('Lire plus tard')?.click()
  check('saving the same address again adds nothing and keeps the first entry as it was', state().readLater.length === savedBefore + 1 && state().readLater[0]?.id === firstId && state().readLater[0]?.savedAt === firstDate)
  check('…the tab closes all the same, and the notice says it was already there', !!again && !state().tabs.some((t) => t.id === again.id) && toast()?.message === readLaterNotice('already') && toast()?.action === 'Ouvrir la liste' && toast()?.secondAction === undefined, JSON.stringify(toast()))

  // ---- 4. a second page, from the menu of its tab: no icon, newest first ----
  const second = await openTab('/second', 'Second article')
  await sleep(500)
  const secondEntry = second ? tabMenuEntry(second.id, 'Lire plus tard') : undefined
  check('the menu of a tab has "Lire plus tard" for a web page, above the entry that closes it', secondEntry?.enabled === true && (() => { const labels = menuItems({ kind: 'tab', id: second?.id ?? '' }, browser, store, win).map((i) => i.label); const closing = labels.findIndex((label) => label === 'Fermer l’onglet' || label === 'Archiver l’onglet'); return labels.includes('Lire plus tard') && closing > -1 && labels.indexOf('Lire plus tard') < closing })())
  if (second) chooseTabMenu(second.id, 'Lire plus tard')
  check('choosing it saves the page at the top of the list and closes its tab', state().readLater[0]?.url === `${base}/second` && state().readLater[0]?.title === 'Second article' && state().readLater.length === savedBefore + 2 && !state().tabs.some((t) => t.id === second?.id))
  check('a page that declares no icon keeps the default address the engine reports for it (the panel falls back to a letter)', state().readLater[0]?.faviconUrl === `${base}/favicon.ico`, JSON.stringify(state().readLater[0]).slice(0, 200))

  // ---- 5. what cannot be saved ----
  browser.dispatch({ type: 'tab/open', url: 'about:blank', spaceId })
  const blank = tabOf('about:blank')
  await waitFor(() => fileEntry('Lire plus tard')?.enabled === false)
  check('a page that is not on the web cannot be saved: the menu entries are greyed out', !!blank && fileEntry('Lire plus tard')?.enabled === false && tabMenuEntry(blank.id, 'Lire plus tard')?.enabled === false)
  const listBefore = JSON.stringify(state().readLater)
  browser.dispatch({ type: 'readlater/add', tabId: blank?.id ?? '' })
  check('…and asking all the same changes nothing: the tab stays, the list is the same, the notice says why', JSON.stringify(state().readLater) === listBefore && tabOf('about:blank') !== undefined && toast()?.message === readLaterNotice('unsupported'), JSON.stringify(toast()))
  // The interface is not trusted: whatever it sends, the state stays well formed.
  const hostile = [
    `{ type: 'readlater/add', tabId: 5 }`,
    `{ type: 'readlater/add', tabId: '__proto__' }`,
    `{ type: 'readlater/open', id: '__proto__' }`,
    `{ type: 'readlater/open', id: { toString: 1 } }`,
    `{ type: 'readlater/remove', id: null }`,
    `{ type: 'readlater/add' }`
  ]
  const outcomes: string[] = []
  // No wait after them: each dispatch of the interface is answered once the main process has handled it, a refusal included.
  for (const action of hostile) outcomes.push(await evaluate<string>(win.webContents, `window.lucium.dispatch(${action}).then(() => 'ok', (error) => 'rejected: ' + String(error).slice(0, 80))`))
  check('hostile requests from the interface are ignored', JSON.stringify(state().readLater) === listBefore && tabOf('about:blank') !== undefined, outcomes.join(' | '))
  if (blank) browser.dispatch({ type: 'tab/close', id: blank.id })

  // ---- 6. a state file with hostile entries loads without them ----
  const dir = join(userData, 'readlater-smoke')
  mkdirSync(dir, { recursive: true })
  const hostileFile = join(dir, 'state.json')
  const hostileState = {
    ...JSON.parse(readFileSync(statePath, 'utf8')),
    readLater: [
      { id: 'a', url: 'javascript:alert(1)', title: 'js', savedAt: 1 },
      { id: 'b', url: 'file:///etc/passwd', title: 'file', savedAt: 1 },
      { id: 'c', url: 'data:text/html,<script>1</script>', title: 'data', savedAt: 1 },
      { id: 'd', url: 'https://bon.example/', title: 'bon', savedAt: 1, faviconUrl: 'file:///etc/passwd' },
      { id: 'e', url: 'https://bon2.example/', title: 'bon 2', savedAt: 1, faviconUrl: 'data:text/html;base64,PGI+' }
    ]
  }
  writeFileSync(hostileFile, JSON.stringify(hostileState))
  const loaded = loadState(hostileFile)
  rmSync(dir, { recursive: true, force: true })
  check('a state file with a javascript:, file: or data: address and an icon that is a local file or not an image loads without them', JSON.stringify(loaded.readLater.map((r) => [r.url, 'faviconUrl' in r])) === JSON.stringify([['https://bon.example/', false], ['https://bon2.example/', false]]), JSON.stringify(loaded.readLater))

  // ---- 7. the list, opened from the menu bar and drawn in the overlay ----
  fileEntry('Liste de lecture…')?.click()
  check('File › Liste de lecture… opens the panel', await waitFor(() => browser.currentPanel() === 'readlater'))
  browser.closeOverlay()
  check('the panel is also asked for by the interface itself, through the validated channel', await openPanel(true))
  await waitFor(async () => (await rows())[0]?.icon === 'letter')
  let list = await rows()
  check('it lists the saved pages, newest first, one row each', list.length === state().readLater.length && list[0]?.title === 'Second article' && list[1]?.title === 'Article à lire', JSON.stringify(list.map((r) => r.title)))
  check('each row says the site and how long ago: "<hôte> · à l’instant"', list[0]?.meta === `${host} · à l’instant`, list[0]?.meta)
  check('the page whose icon loads shows it, the one whose icon is missing (404) falls back to the initial of its site', list[1]?.icon === 'img' && list[1]?.iconSrc === iconSource(`${base}/icon.png`) && list[1].loaded && list[0]?.icon === 'letter' && list[0].iconSrc === '1', JSON.stringify([list[0], list[1]]))
  check('the title shows the number of pages', (await evaluate<string>(ui, `document.querySelector('.readlater-count')?.textContent ?? ''`)) === String(state().readLater.length))
  check('the panel is a card in the overlay with its Ouvrir, Supprimer and Tout effacer buttons', (await evaluate<number>(ui, `document.querySelectorAll('.card.readlater .readlater-row [data-action="open"]').length`)) === list.length && (await evaluate<number>(ui, `document.querySelectorAll('.readlater-row [data-action="remove"]').length`)) === list.length && (await evaluate<boolean>(ui, `!!document.querySelector('.readlater [data-action="clear"]')`)))

  // ---- 8. filter ----
  await typeText('second')
  list = await rows()
  check('typing in the filter narrows the list (title or address)', list.length === 1 && list[0]?.title === 'Second article' && (await evaluate<string>(ui, `document.querySelector('.readlater-count')?.textContent ?? ''`)) === `1 / ${state().readLater.length}`, JSON.stringify(list.map((r) => r.title)))
  await typeText('zzz')
  check('a filter that matches nothing says so', (await rows()).length === 0 && (await panelText()).includes('Aucun résultat'))
  await keyPress('Backspace', 'secondzzz'.length)
  check('emptying the filter brings the whole list back', (await rows()).length === state().readLater.length)

  // ---- 9. open from the list: a new tab in the current space, the page stays in the list ----
  const countBefore = state().readLater.length
  const tabsBefore = state().tabs.length
  browser.dispatch({ type: 'space/select', id: spaceId })
  check('a real click on the "Ouvrir" of the older page', await clickRow('Article à lire', 'open'))
  const opened = state().tabs.at(-1)
  check('it opens the page in a new tab of the space on screen, selected, and closes the panel', state().tabs.length === tabsBefore + 1 && opened?.spaceId === spaceId && opened.url === `${base}/article` && state().activeTabBySpace[spaceId] === opened.id && (await waitFor(() => browser.currentPanel() === null)), JSON.stringify(opened))
  check('…and the page is still in the list (the Toolkit’s list does not remove it either)', state().readLater.length === countBefore && state().readLater.some((r) => r.url === `${base}/article`))
  check('the page really loads in that tab', await waitFor(() => state().tabs.find((t) => t.id === opened?.id)?.title === 'Article à lire'))

  // ---- 10. delete one, then the confirmation of "Tout effacer" ----
  await openPanel()
  // The page to remove is named by the list itself, then waited for in the panel: the overlay draws the panel again when it is asked for, and the rows
  // read in between were none (a run stopped here on a row that was not there yet).
  const removedId = state().readLater.find((r) => r.title === 'Second article')?.id
  check('the panel shows the row of the page to remove', removedId !== undefined && (await waitFor(async () => (await rows()).some((r) => r.id === removedId))), JSON.stringify(await rows()))
  // A deleted page leaves the panel at once and the list ACTION_NOTICE_MS later (more while the pointer or the focus is on the notice): until then the notice takes it back.
  await clickRow('Second article', 'remove')
  check('"Supprimer" takes that page out of the panel, which stays open, and deletes nothing yet', (await waitFor(async () => (await rows()).length === countBefore - 1)) && state().readLater.length === countBefore && browser.currentPanel() === 'readlater' && (await panelText()).includes('Page retirée de la liste'))
  await clickIn('[data-action="undo"]')
  check('"Annuler" of the notice brings the page back', (await waitFor(async () => (await rows()).some((r) => r.id === removedId))) && state().readLater.length === countBefore)
  await clickRow('Second article', 'remove')
  await leaveNotice()
  check('the page is deleted once the delay has passed, and that page only', (await waitFor(() => state().readLater.length === countBefore - 1, ACTION_NOTICE_MS + 4000)) && !state().readLater.some((r) => r.id === removedId) && state().readLater[0]?.title === 'Article à lire' && (await rows()).length === countBefore - 1)
  await clickIn('[data-action="clear"]')
  check('"Tout effacer" asks for a second click: nothing is erased yet', state().readLater.length === countBefore - 1 && (await evaluate<boolean>(ui, `!!document.querySelector('[data-action="clear-confirm"]')`)))
  check('"Annuler" stands where "Tout effacer" was: the second click of a double click lands on it', await evaluate<boolean>(ui, `document.querySelector('.readlater .row.between button')?.getAttribute('data-action') === 'clear-cancel'`))
  await clickIn('[data-action="clear-cancel"]')
  check('"Annuler" keeps the list and brings the first button back', state().readLater.length === countBefore - 1 && (await evaluate<boolean>(ui, `!!document.querySelector('[data-action="clear"]') && !document.querySelector('[data-action="clear-confirm"]')`)))
  await clickIn('[data-action="clear"]')
  await clickIn('[data-action="clear-confirm"]')
  check('the second click empties the panel, which then says it is empty, and the list can still be taken back', (await waitFor(async () => (await rows()).length === 0)) && (await panelText()).includes('Aucune page enregistrée') && state().readLater.length === countBefore - 1 && (await evaluate<boolean>(ui, `!!document.querySelector('[data-action="undo"]')`)))
  await leaveNotice()
  check('the list is emptied once the delay has passed', await waitFor(() => state().readLater.length === 0, ACTION_NOTICE_MS + 4000))
  await keyPress('Escape')
  check('Échap closes the panel', await waitFor(() => browser.currentPanel() === null))

  // ---- 11. the toast's "Annuler" takes the page back out and brings the tab back ----
  const undoTab = await openTab('/third', 'page /third')
  await waitFor(() => fileEntry('Lire plus tard')?.enabled === true)
  fileEntry('Lire plus tard')?.click()
  const undoToast = toast()
  check('saving a page leaves a toast with "Annuler"', state().readLater.length === 1 && undoToast?.action === 'Annuler' && !state().tabs.some((t) => t.id === undoTab?.id))
  browser.runToastAction(undoToast?.id ?? -1)
  check('"Annuler" removes the page from the list and opens its tab again in the same space', state().readLater.length === 0 && state().tabs.some((t) => t.url === `${base}/third` && t.spaceId === spaceId))
  for (const tab of state().tabs.filter((t) => t.spaceId === spaceId)) browser.dispatch({ type: 'tab/close', id: tab.id })

  // ---- 12. the limit ----
  const filler: ReadLaterItem[] = Array.from({ length: READ_LATER_LIMIT - 1 }, (_, i) => ({ id: `filler${i}`, url: `https://filler${i}.example/`, title: `Page ${i}`, savedAt: i }))
  browser.dispatch({ type: 'state/restore', state: { ...state(), readLater: filler } })
  const last = await openTab('/fourth', 'page /fourth')
  await waitFor(() => fileEntry('Lire plus tard')?.enabled === true)
  fileEntry('Lire plus tard')?.click()
  check('the page that fills the list is accepted', state().readLater.length === READ_LATER_LIMIT && state().readLater[0]?.url === `${base}/fourth` && !state().tabs.some((t) => t.id === last?.id))
  const over = await openTab('/fifth', 'page /fifth')
  await waitFor(() => fileEntry('Lire plus tard')?.enabled === true)
  fileEntry('Lire plus tard')?.click()
  check('the next one is refused: nothing is pushed out of the list and the tab stays open, with a notice', state().readLater.length === READ_LATER_LIMIT && !state().readLater.some((r) => r.url === `${base}/fifth`) && state().readLater.at(-1)?.id === `filler${READ_LATER_LIMIT - 2}` && tabOf(`${base}/fifth`)?.id === over?.id && toast()?.message === readLaterNotice('full'), JSON.stringify(toast()))
  if (over) browser.dispatch({ type: 'tab/close', id: over.id })
  browser.dispatch({ type: 'readlater/clear' })

  // ---- 13. the command bar ----
  const barTab = await openTab('/article', 'Article à lire')
  const barRows = () => evaluate<Array<{ label: string; detail: string; selected: boolean }>>(ui, `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', detail: li.querySelector('.detail')?.textContent ?? '', selected: li.classList.contains('selected') }))`)
  const openBar = async (text: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      if (await waitFor(() => evaluate<boolean>(ui, `document.activeElement === document.querySelector('.palette-input')`), 3000)) break
    }
    await sleep(200)
    await typeText(text)
  }
  const choose = async (label: string, detailStart = ''): Promise<boolean> => {
    const list2 = await barRows()
    const at = list2.findIndex((r) => r.label === label && r.detail.startsWith(detailStart))
    if (at < 0) return false
    await keyPress('Down', at - list2.findIndex((r) => r.selected))
    await keyPress('Return')
    return true
  }
  const suggestionsBefore = state().settings.searchSuggestions
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: false } })
  await openBar('lire plus')
  const actions = await barRows()
  check('typing “lire plus” offers the action "Lire plus tard" (not on an empty bar)', actions.some((r) => r.label === 'Lire plus tard'), JSON.stringify(actions.map((r) => r.label)))
  await choose('Lire plus tard')
  check('choosing it saves the page on screen and closes its tab', await waitFor(() => state().readLater.length === 1 && state().readLater[0]?.url === `${base}/article` && !state().tabs.some((t) => t.id === barTab?.id)))
  await waitFor(() => browser.currentPanel() === null)
  await openBar('article')
  const found = await barRows()
  const savedRow = found.find((r) => r.detail.startsWith('— Lire plus tard'))
  check('a saved page is a suggestion when its title is typed, marked "Lire plus tard · <hôte>"', !!savedRow && savedRow.label === 'Article à lire' && savedRow.detail === `— Lire plus tard · ${host}`, JSON.stringify(found))
  const tabsNow = state().tabs.length
  await choose('Article à lire', '— Lire plus tard')
  check('choosing it opens the page in a new tab, and it stays in the list', await waitFor(() => state().tabs.length === tabsNow + 1 && state().tabs.at(-1)?.url === `${base}/article`) && state().readLater.length === 1)
  await waitFor(() => browser.currentPanel() === null)
  await openBar('liste de lecture')
  await choose('Ouvrir la liste de lecture')
  check('“liste de lecture” offers "Ouvrir la liste de lecture", which opens the panel', await waitFor(() => browser.currentPanel() === 'readlater'))
  browser.closeOverlay()
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: suggestionsBefore } })

  // ---- 14. a private window keeps no list and offers no way to save ----
  const manager = getWindowManager()
  const priv = manager.openPrivate()
  priv.browser.dispatch({ type: 'tab/open', url: `${base}/article` })
  await waitFor(() => priv.store.get().tabs.some((t) => t.url === `${base}/article` && t.title === 'Article à lire'))
  const privTab = priv.store.get().tabs.find((t) => t.url === `${base}/article`)
  priv.browser.dispatch({ type: 'readlater/add', tabId: privTab?.id ?? '' })
  check('the private window refuses to save: the tab stays, the list stays empty', priv.store.get().readLater.length === 0 && priv.store.get().tabs.some((t) => t.id === privTab?.id))
  priv.browser.openOverlay({ panel: 'readlater' })
  check('…and does not open the list', priv.browser.currentPanel() === null)
  check('the menu of a tab of the private window has no "Lire plus tard"', !!privTab && menuItems({ kind: 'tab', id: privTab.id }, priv.browser, priv.store, priv.win).every((i) => i.label !== 'Lire plus tard'))
  priv.win.emit('focus')
  await waitFor(() => fileEntry('Lire plus tard')?.enabled === false)
  check('with the private window in front, both File entries are greyed out', fileEntry('Lire plus tard')?.enabled === false && fileEntry('Liste de lecture…')?.enabled === false)
  priv.win.close()
  await waitFor(() => manager.privateWindows().length === 0)
  await manager.settled()
  win.emit('focus')
  await waitFor(() => fileEntry('Liste de lecture…')?.enabled === true)
  check('with the main window back in front, they are available again', fileEntry('Liste de lecture…')?.enabled === true)

  // ---- leave the state as it was found ----
  browser.dispatch({ type: 'readlater/clear' })
  for (const tab of state().tabs.filter((t) => t.spaceId === spaceId)) browser.dispatch({ type: 'tab/close', id: tab.id })
  browser.dispatch({ type: 'space/select', id: previousSpace })
  browser.dispatch({ type: 'space/delete', id: spaceId })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  check('the list is left empty, as the run found it', state().readLater.length === 0)
}

/** The same checks with their own report, for `LUCIUM_SMOKE_ONLY=readlater` and for the local branching in index.ts. */
export async function runReadLaterSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    const verbose = process.env['LUCIUM_READLATER_VERBOSE'] === '1'
    await smokeReadLater(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`READ-LATER ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeReadLater ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_READ_LATER ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
