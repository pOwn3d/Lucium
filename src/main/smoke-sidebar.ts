// Engine checks for the sidebar interactions (multiple selection, nested folders, drag and drop, hover card).
// Run inside a real Electron by `pnpm test:engine` once `smokeSidebar` is called from smoke.ts.
//
// Real mouse input (sendInputEvent) drives the clicks and the hover. The native drag session of the operating system
// cannot be driven by synthetic input, so the drag and drop events themselves are dispatched on the real elements
// (dragstart, dragover, drop): that exercises the row positions, the insertion mark, the handlers and the whole path to the state.

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { clipboard, dialog, Menu } from 'electron'
import { FOLDER_MAX_DEPTH } from '@shared/folders'
import { activeTab } from '@shared/sidebar'
import { menuItems } from './shell/context-menus'
import type { SmokeContext } from './smoke'
import { skippedBecause, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'


const waitFor = waiterOf(5000, 60)

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export async function smokeSidebar(ctx: SmokeContext, check: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
  const { browser, store, win } = ctx
  const chrome = win.webContents
  const shotsDir = process.env.LUCIUM_SMOKE_SHOTS
  const shot = async (name: string) => {
    if (!shotsDir) return
    mkdirSync(shotsDir, { recursive: true })
    // Only the sidebar: that is where everything of this file happens.
    writeFileSync(join(shotsDir, `${name}.png`), (await chrome.capturePage({ x: 0, y: 0, width: 300, height: 600 })).toPNG())
  }

  // Pages with distinct addresses, so tabs, favourites and the Markdown copy have something to tell apart.
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>page ${req.url}</title><body>sidebar smoke ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // A space of its own, so the sidebar shows only these tabs; it is deleted at the end.
  const previousSpace = store.get().activeSpaceId
  browser.dispatch({ type: 'space/create', name: 'Sidebar test', emoji: '🧪', hue: 200 })
  const spaceId = store.get().activeSpaceId
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
  for (const n of names) browser.dispatch({ type: 'tab/open', url: `${base}/${n.toLowerCase()}`, background: true })
  const tabs = () => store.get().tabs.filter((t) => t.spaceId === spaceId)
  const idOf = (name: string) => tabs().find((t) => t.url.endsWith(`/${name.toLowerCase()}`))!.id
  for (const n of names) browser.dispatch({ type: 'tab/rename', id: idOf(n), title: n })
  browser.dispatch({ type: 'tab/select', id: idOf('Alpha') })
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, hoverCards: true } })
  await sleep(500)

  // ---- helpers on the real sidebar ----
  const evaluate = <T>(script: string) => chrome.executeJavaScript(script) as Promise<T>
  const rectOf = (selector: string) =>
    evaluate<Rect | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const rowRect = (name: string) =>
    evaluate<Rect | null>(`(() => { const el = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const titles = (selector: string) => evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.querySelector('.tab-title')?.textContent ?? '')`)
  const mouse = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number, modifiers: Array<'shift' | 'meta'> = []) =>
    chrome.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers } as Electron.MouseInputEvent)
  const clickRow = async (name: string, modifiers: Array<'shift' | 'meta'> = []) => {
    const r = await rowRect(name)
    if (!r) return false
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    mouse('mouseMove', x, y)
    mouse('mouseDown', x, y, modifiers)
    mouse('mouseUp', x, y, modifiers)
    await sleep(250)
    return true
  }
  const recordMenus = <T>(run: () => Promise<T>) => {
    const real = Menu.prototype.popup
    const opened: string[][] = []
    Menu.prototype.popup = function (this: Menu) {
      opened.push(this.items.map((item) => item.label))
      return this
    } as never
    return run().then(
      (value) => {
        Menu.prototype.popup = real
        return { value, opened }
      },
      (error: unknown) => {
        Menu.prototype.popup = real
        throw error
      }
    )
  }
  const rightClickRow = (name: string) =>
    recordMenus(async () => {
      await evaluate(`(() => { const el = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)}); el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })()`)
      await sleep(400)
    }).then((r) => r.opened[0] ?? [])
  const click = (items: Electron.MenuItemConstructorOptions[], label: string) => (items.find((i) => i.label === label)?.click as (() => void) | undefined)?.()
  const menu = (id: string, selection?: string[]) => menuItems({ kind: 'tab', id, selection }, browser, store, win)

  // Synthetic drag and drop on the real elements, with the pointer at a fraction of a target's size. `shotName` takes a picture of the sidebar mid-drag.
  const dragFlow = async (sourceSelector: string, targetSelector: string, yFraction: number, options: { drop: boolean; xFraction?: number; shotName?: string }) => {
    const over = await evaluate<{ prevented: boolean; mark: string }>(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const source = ${sourceSelector}
      const data = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
      await wait(80)
      // Some targets (the empty pinned zone) only exist once the drag has started.
      const target = ${targetSelector}
      const rect = target.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.left + rect.width * ${options.xFraction ?? 0.5}, clientY: rect.top + rect.height * ${yFraction} }
      const over = new DragEvent('dragover', init)
      target.dispatchEvent(over)
      await wait(80)
      window.__flow = { source, target, init, data }
      const mark = [...document.querySelectorAll('.drop-before, .drop-after, .drop-inside')].map((el) => (el.className.match(/drop-(?:before|after|inside)/) || [''])[0] + ':' + (el.querySelector?.('.tab-title')?.textContent || el.textContent.trim().slice(0, 14))).join('|')
      return { prevented: over.defaultPrevented, mark }
    })()`)
    if (options.shotName) await shot(options.shotName)
    await evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const { source, target, init, data } = window.__flow
      if (${options.drop}) target.dispatchEvent(new DragEvent('drop', init))
      await wait(120)
      // The browser always ends a drag on its source, when the source is still there.
      if (source.isConnected) source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
      await wait(150)
    })()`)
    return over
  }
  const rowEl = (name: string) => `[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)})`

  // ======== multiple selection ========
  check('the sidebar lists the six test tabs as rows', (await titles('.tab')).join() === names.join(), (await titles('.tab')).join())
  await clickRow('Bravo')
  check('a plain click shows the tab and selects nothing else', store.get().activeTabBySpace[spaceId] === idOf('Bravo') && (await titles('.tab.selected')).length === 0)
  await clickRow('Delta', ['meta'])
  check('⌘-click adds a tab to the selection, with the tab being shown', (await titles('.tab.selected')).join() === 'Bravo,Delta', (await titles('.tab.selected')).join())
  check('and leaves the page being shown alone', store.get().activeTabBySpace[spaceId] === idOf('Bravo'))
  await clickRow('Delta', ['meta'])
  check('⌘-click on a selected tab takes it out; one tab left is no selection', (await titles('.tab.selected')).length === 0, (await titles('.tab.selected')).join())
  await clickRow('Charlie', ['meta'])
  await clickRow('Echo', ['shift'])
  check('⇧-click selects the rows between the last clicked tab and the one clicked', (await titles('.tab.selected')).join() === 'Charlie,Delta,Echo', (await titles('.tab.selected')).join())
  const selectedRow = await evaluate<string>(`getComputedStyle(${rowEl('Delta')}).backgroundColor`)
  const activeRow = await evaluate<string>(`getComputedStyle(${rowEl('Bravo')}).backgroundColor`)
  check('a selected row has the background of the active one', selectedRow === activeRow && selectedRow !== 'rgba(0, 0, 0, 0)', `${selectedRow} / ${activeRow}`)
  await shot('selection')

  const groupLabels = await rightClickRow('Delta')
  check(
    'a right click inside the selection opens the group menu',
    groupLabels.includes('Archiver 3 onglets') && groupLabels.includes('Nouveau dossier avec la sélection') && groupLabels.includes('Copier les liens en Markdown') && groupLabels.includes('Épingler 3 onglets') && groupLabels.includes('Fermer 3 onglets') && !groupLabels.includes('Renommer…'),
    groupLabels.join(' | ')
  )
  check('and the selection is still there', (await titles('.tab.selected')).length === 3)
  const outside = await rightClickRow('Foxtrot')
  check('a right click outside the selection opens the tab menu and ends the selection', outside.includes('Renommer…') && (await titles('.tab.selected')).length === 0, outside.join(' | '))

  const group = [idOf('Charlie'), idOf('Delta'), idOf('Echo')]
  const groupMenu = menu(group[1]!, group)
  click(groupMenu, 'Copier les liens en Markdown')
  let copied = ''
  await waitFor(async () => (copied = await clipboard.readText()) !== '', 3000)
  check(
    '"Copier les liens en Markdown" copies one [title](url) per line',
    copied === group.map((id) => `[${tabs().find((t) => t.id === id)!.customTitle}](${tabs().find((t) => t.id === id)!.url})`).join('\n'),
    copied
  )
  check('a single tab uses the usual menu even if a selection is passed', menu(idOf('Foxtrot'), [idOf('Foxtrot')]).some((i) => i.label === 'Renommer…'))
  check('a selection that does not include the tab clicked is ignored', menu(idOf('Foxtrot'), [idOf('Alpha'), idOf('Bravo')]).some((i) => i.label === 'Renommer…'))
  check('and so are unknown ids', menu(idOf('Foxtrot'), ['nope', 'nada', idOf('Foxtrot')]).some((i) => i.label === 'Renommer…'))

  const archiveBefore = store.get().archive.length
  click(groupMenu, 'Archiver 3 onglets')
  check('"Archiver 3 onglets" archives them together', store.get().archive.length === archiveBefore + 3 && tabs().length === 3, `${store.get().archive.length - archiveBefore} archived, ${tabs().length} left`)
  check('and shows a toast with an undo', browser.snapshot().toast?.message === '3 onglets archivés' && browser.snapshot().toast?.action === 'Annuler', JSON.stringify(browser.snapshot().toast))
  browser.runToastAction(browser.snapshot().toast!.id)
  check('"Annuler" brings the three tabs back', tabs().length === 6 && store.get().archive.length === archiveBefore, `${tabs().length} tabs`)
  // The restored tabs are new tabs (the archive keeps the title, not a name the user gave): find them by address and name them again.
  const restored = ['Charlie', 'Delta', 'Echo'].map((n) => tabs().find((t) => t.url.endsWith(`/${n.toLowerCase()}`))?.id ?? '')
  check('and in the order they had', restored.every(Boolean) && tabs().filter((t) => restored.includes(t.id)).map((t) => t.id).join() === restored.join(), restored.join())
  ;['Charlie', 'Delta', 'Echo'].forEach((n, i) => browser.dispatch({ type: 'tab/rename', id: restored[i]!, title: n }))

  const folderMenu = menu(restored[1]!, restored)
  click(folderMenu, 'Nouveau dossier avec la sélection')
  const newFolder = store.get().folders.find((f) => f.spaceId === spaceId)
  check('"Nouveau dossier avec la sélection" makes a folder holding the three tabs, pinned', !!newFolder && restored.every((id) => store.get().tabs.find((t) => t.id === id)?.folderId === newFolder.id && store.get().tabs.find((t) => t.id === id)?.pinned))
  check('and the sidebar shows them inside it', await waitFor(async () => (await titles('.folder .folder-body .tab')).join() === 'Charlie,Delta,Echo'), (await titles('.folder .folder-body .tab')).join())

  // ======== nested folders ========
  const subMenu = menuItems({ kind: 'folder', id: newFolder!.id }, browser, store, win, { headers: true })
  const folderLabels = subMenu.map((i) => i.label ?? '——')
  check('the folder menu offers a sub-folder, the links, a copy, archiving and deletion, in blocks', JSON.stringify(folderLabels) === JSON.stringify(['Créer et copier', 'Nouveau sous-dossier', frenchSpaces('Transformer « Nouveau dossier » en espace'), 'Copier tous les liens', 'Copier tous les liens en Markdown', 'Personnaliser', 'Changer l’icône…', 'Renommer…', 'Organiser', 'Dupliquer', 'Mettre au début d’Aujourd’hui', 'Mettre en bas de la liste', 'Ne jamais réveiller automatiquement', 'Archiver le dossier', 'Supprimer', 'Supprimer le dossier (garder les onglets)']), folderLabels.join(' | '))
  click(subMenu, 'Nouveau sous-dossier')
  const child = store.get().folders.find((f) => f.parentId === newFolder!.id)
  check('"Nouveau sous-dossier" creates a folder inside it', !!child && child.spaceId === spaceId)
  await sleep(300)
  const indents = await evaluate<{ parent: number; child: number } | null>(`(() => { const titles = [...document.querySelectorAll('.folder-title')]; return titles.length >= 2 ? { parent: titles[0].getBoundingClientRect().left, child: titles[1].getBoundingClientRect().left } : null })()`)
  check('the sub-folder is indented by 16 px', !!indents && Math.round(indents.child - indents.parent) === 16, JSON.stringify(indents))
  await shot('nested-folders')
  const arrow = await evaluate<boolean>(`!!document.querySelector('.folder-title .folder-arrow')`)
  check('a folder has no fold arrow: Arc shows its state with the icon', !arrow && (await evaluate<boolean>(`!!document.querySelector('.folder-title .folder-glyph')`)))
  let deepest = child!.id
  for (let level = 3; level <= FOLDER_MAX_DEPTH; level++) {
    browser.dispatch({ type: 'folder/create', name: `Niveau ${level}`, parentId: deepest })
    deepest = store.get().folders.find((f) => f.parentId === deepest)!.id
  }
  check('the menu of a folder at the deepest level has no "Nouveau sous-dossier"', menuItems({ kind: 'folder', id: deepest }, browser, store, win).find((i) => i.label === 'Nouveau sous-dossier')?.enabled === false)
  const foldersBefore = store.get().folders.length
  browser.dispatch({ type: 'folder/create', name: 'trop profond', parentId: deepest })
  check('and the state refuses one more level', store.get().folders.length === foldersBefore)
  browser.dispatch({ type: 'folder/archive', id: child!.id })
  check('archiving a sub-folder removes it and the folders under it, keeping the parent and its tabs', store.get().folders.length === 1 && store.get().folders[0]!.id === newFolder!.id && restored.every((id) => store.get().tabs.some((t) => t.id === id)))

  // ======== drag and drop ========
  const inFolder = () => tabs().filter((t) => t.folderId === newFolder!.id).map((t) => t.customTitle)
  const today = () => tabs().filter((t) => !t.pinned).map((t) => t.customTitle)
  if (store.get().folders.find((f) => f.id === newFolder!.id)!.collapsed) browser.dispatch({ type: 'folder/toggle', id: newFolder!.id })
  // Charlie, Delta and Echo are in the folder; Alpha, Bravo and Foxtrot are in Today.
  check('the folder holds Charlie, Delta and Echo and Today the other three', await waitFor(() => inFolder().join() === 'Charlie,Delta,Echo' && today().join() === 'Alpha,Bravo,Foxtrot'), `${inFolder().join()} / ${today().join()}`)

  // A row dropped between two rows: the mark is drawn in the gap, and the drop reorders.
  let flow = await dragFlow(rowEl('Alpha'), rowEl('Foxtrot'), 0.8, { drop: false, shotName: 'drop-between-rows' })
  check('dragging over the lower half of a row marks the gap after it', flow.mark === 'drop-after:Foxtrot', flow.mark)
  check('and the drop is accepted there', flow.prevented)
  const markGeometry = await evaluate<{ top: number; height: number } | null>(`(async () => {
    const source = ${rowEl('Alpha')}; const target = ${rowEl('Bravo')}; const data = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    await new Promise((r) => setTimeout(r, 80))
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.left + 20, clientY: rect.top + 4 }))
    await new Promise((r) => setTimeout(r, 80))
    const style = getComputedStyle(target, '::before')
    const out = style.content === 'none' ? null : { top: parseFloat(style.top), height: parseFloat(style.height) }
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
    return out
  })()`)
  check('the insertion mark is a 2 px line in the gap between two rows', !!markGeometry && markGeometry.height === 2 && markGeometry.top < 0, JSON.stringify(markGeometry))
  check('dragging changes nothing until the drop', today().join() === 'Alpha,Bravo,Foxtrot', today().join())
  await dragFlow(rowEl('Alpha'), rowEl('Foxtrot'), 0.8, { drop: true })
  check('dropping Alpha on the lower half of Foxtrot puts it after Foxtrot', today().join() === 'Bravo,Foxtrot,Alpha', today().join())
  await dragFlow(rowEl('Alpha'), rowEl('Bravo'), 0.2, { drop: true })
  check('dropping it on the upper half of Bravo puts it before Bravo', today().join() === 'Alpha,Bravo,Foxtrot', today().join())

  // Dropping on a folder puts the tab in it; on a row of the folder, at that place.
  flow = await dragFlow(rowEl('Bravo'), `document.querySelector('.folder-title')`, 0.6, { drop: false, shotName: 'drop-on-folder' })
  check('dragging over a folder lights it up', flow.mark.startsWith('drop-inside:') && flow.prevented, flow.mark)
  await dragFlow(rowEl('Bravo'), `document.querySelector('.folder-title')`, 0.6, { drop: true })
  check('dropping a tab on a folder puts it inside, pinned, after the others', inFolder().join() === 'Charlie,Delta,Echo,Bravo' && tabs().find((t) => t.customTitle === 'Bravo')?.pinned === true, inFolder().join())
  await dragFlow(rowEl('Alpha'), rowEl('Delta'), 0.2, { drop: true })
  check('dropping a tab on the upper half of a row of the folder puts it there', inFolder().join() === 'Charlie,Alpha,Delta,Echo,Bravo', inFolder().join())
  await dragFlow(rowEl('Alpha'), rowEl('Foxtrot'), 0.8, { drop: true })
  check('dropping a folder tab between Today rows takes it out of the folder and unpins it', !inFolder().includes('Alpha') && today().join() === 'Foxtrot,Alpha' && tabs().find((t) => t.customTitle === 'Alpha')?.anchorUrl === undefined, `${inFolder().join()} / ${today().join()}`)

  // A dragged tab resting on a collapsed folder opens it (dragover repeats while the pointer stays, as it does in a real drag).
  browser.dispatch({ type: 'folder/toggle', id: newFolder!.id })
  check('the folder is collapsed for this check', store.get().folders.find((f) => f.id === newFolder!.id)?.collapsed === true && (await waitFor(async () => (await titles('.folder-body .tab')).length === 0)))
  await evaluate(`(async () => {
    const source = ${rowEl('Foxtrot')}; const target = document.querySelector('.folder-title'); const data = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    await new Promise((r) => setTimeout(r, 80))
    const rect = target.getBoundingClientRect()
    for (let i = 0; i < 12; i++) {
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.left + 40, clientY: rect.top + rect.height * 0.6 }))
      await new Promise((r) => setTimeout(r, 100))
    }
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
  })()`)
  check('a tab held over it for about 700 ms opens it', store.get().folders.find((f) => f.id === newFolder!.id)?.collapsed === false, String(store.get().folders.find((f) => f.id === newFolder!.id)?.collapsed))
  await sleep(200)

  // A multiple selection is dragged as one.
  await clickRow('Foxtrot')
  await clickRow('Alpha', ['meta'])
  check('two rows are selected to be dragged together', (await titles('.tab.selected')).join() === 'Foxtrot,Alpha', (await titles('.tab.selected')).join())
  const started = await evaluate<{ dragging: string; ghost: { className: string; text: string; hasClose: boolean; connected: boolean; width: number; badge: string | null } | null; ghostLeft: boolean }>(`(async () => {
    // What the browser is handed as the picture to drag along.
    const proto = DataTransfer.prototype
    const real = proto.setDragImage
    let ghost = null
    proto.setDragImage = function (el, x, y) {
      ghost = { className: el.className, text: el.textContent, hasClose: !!el.querySelector('.hover-only'), connected: el.isConnected, width: Math.round(el.getBoundingClientRect().width), badge: el.querySelector('.drag-count')?.textContent ?? null }
      return real.call(this, el, x, y)
    }
    const source = ${rowEl('Foxtrot')}; const data = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    proto.setDragImage = real
    await new Promise((r) => setTimeout(r, 120))
    const dragging = [...document.querySelectorAll('.tab.dragging')].map((el) => el.querySelector('.tab-title').textContent).join()
    const ghostLeft = !!document.querySelector('.drag-ghost')
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
    return { dragging, ghost, ghostLeft }
  })()`)
  check('dragging a selected row dims every row of the selection', started.dragging === 'Foxtrot,Alpha', started.dragging)
  check('the picture dragged along is a copy of the row without its close button, with the number of tabs', !!started.ghost && started.ghost.className.includes('drag-ghost') && started.ghost.connected && !started.ghost.hasClose && started.ghost.text.includes('Foxtrot') && started.ghost.badge === '2' && started.ghost.width > 150, JSON.stringify(started.ghost))
  check('and it is taken out of the page afterwards', !started.ghostLeft)
  await dragFlow(rowEl('Foxtrot'), `document.querySelector('.folder-title')`, 0.6, { drop: true })
  check('dropping one row of a selection moves the whole selection', inFolder().join() === 'Charlie,Delta,Echo,Bravo,Foxtrot,Alpha', inFolder().join())
  await clickRow('Charlie')

  // Pinning and unpinning a selection keeps the order of the sidebar.
  const trio = ['Charlie', 'Delta', 'Echo'].map(idOf)
  click(menu(trio[1]!, trio), 'Désépingler 3 onglets')
  check('"Désépingler 3 onglets" takes them out of the folder, in the order they had, at the top of Today', trio.every((id) => tabs().find((t) => t.id === id)?.pinned === false && !tabs().find((t) => t.id === id)?.folderId) && today().slice(0, 3).join() === 'Charlie,Delta,Echo', today().join())
  click(menu(trio[1]!, trio), 'Épingler 3 onglets')
  check('"Épingler 3 onglets" pins them again, in that order', trio.every((id) => tabs().find((t) => t.id === id)?.pinned === true) && tabs().filter((t) => t.pinned && !t.folderId).map((t) => t.customTitle).join() === 'Charlie,Delta,Echo', tabs().filter((t) => t.pinned && !t.folderId).map((t) => t.customTitle).join())

  // A drag the browser never ends (its source row replaced) is over at the next press, and cards come back.
  const stuck = await evaluate<boolean>(`(async () => { ${rowEl('Charlie')}.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); await new Promise((r) => setTimeout(r, 120)); return !!document.querySelector('.tab.dragging') })()`)
  await clickRow('Delta')
  check('a drag that never ended stops at the next click', stuck && !(await evaluate<boolean>(`!!document.querySelector('.tab.dragging')`)))

  // The pinned zone when nothing is pinned, and favourites.
  browser.dispatch({ type: 'folder/delete', id: newFolder!.id })
  for (const t of tabs().filter((x) => x.pinned)) browser.dispatch({ type: 'tab/unpin', id: t.id })
  await sleep(300)
  const pinZone = await evaluate<string>(`(async () => {
    const source = ${rowEl('Alpha')}; const data = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    await new Promise((r) => setTimeout(r, 120))
    const zone = document.querySelector('.pin-drop')?.textContent ?? ''
    const favorites = document.querySelector('.favorites.empty-drop')?.textContent ?? ''
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
    return zone + '|' + favorites
  })()`)
  check('while dragging, an empty pinned zone and an empty favourites row appear', pinZone === 'Épingler ici|Ajouter aux favoris', pinZone)
  check('and go away at the end of the drag', await waitFor(() => evaluate<boolean>(`!document.querySelector('.pin-drop') && !document.querySelector('.favorites')`)))
  const favoritesBefore = store.get().favorites.length
  await dragFlow(rowEl('Charlie'), `document.querySelector('.pin-drop')`, 0.5, { drop: true, shotName: 'pin-zone' })
  check('dropping a tab on the empty pinned zone pins it', tabs().find((t) => t.customTitle === 'Charlie')?.pinned === true && !tabs().find((t) => t.customTitle === 'Charlie')?.folderId)
  flow = await dragFlow(rowEl('Delta'), `document.querySelector('.favorites')`, 0.5, { drop: true, xFraction: 0.1, shotName: 'favorites-drop' })
  check('dragging a tab over the empty favourites row lights it up', flow.mark.startsWith('drop-inside:') && flow.prevented, flow.mark)
  check('dropping a tab on the favourites adds it, and the tab leaves the list (as in Arc)', store.get().favorites.length === favoritesBefore + 1 && store.get().favorites.some((f) => f.url.endsWith('/delta')) && !tabs().some((t) => t.customTitle === 'Delta'), JSON.stringify(store.get().favorites.map((f) => f.url)))
  browser.dispatch({ type: 'favorite/add', url: `${base}/second`, title: 'Second' })
  await sleep(300)
  const tileOrder = () => evaluate<string>(`[...document.querySelectorAll('.favorite')].map((el) => el.dataset.favorite).join(',')`)
  const favIds = store.get().favorites.map((f) => f.id)
  const dragFavorite = (from: string, to: string, xFraction: number) =>
    evaluate<boolean>(`(async () => {
      const source = document.querySelector('[data-favorite="${from}"]'); const target = document.querySelector('[data-favorite="${to}"]'); const data = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
      await new Promise((r) => setTimeout(r, 120))
      const rect = target.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.left + rect.width * ${xFraction}, clientY: rect.top + rect.height / 2 }
      const over = new DragEvent('dragover', init)
      target.dispatchEvent(over)
      const prevented = over.defaultPrevented
      target.dispatchEvent(new DragEvent('drop', init))
      return prevented
    })()`)
  const accepted = await dragFavorite(favIds[0]!, favIds[1]!, 0.8)
  check('dragging a favourite past another one reorders the favourites', accepted && (await waitFor(() => store.get().favorites.map((f) => f.id).join() === [favIds[1], favIds[0]].join())), store.get().favorites.map((f) => f.title).join())
  // The order is the state's at once; the tiles follow when the window has drawn the snapshot that carries it.
  check('and the row of tiles follows', await waitFor(async () => (await tileOrder()) === [favIds[1], favIds[0]].join()), await tileOrder())

  // Dropping on a space of the footer moves the tab there; outside any target nothing happens.
  browser.dispatch({ type: 'space/create', name: 'Cible', emoji: '🎯', hue: 20 })
  const targetSpace = store.get().activeSpaceId
  browser.dispatch({ type: 'space/select', id: spaceId })
  await sleep(400)
  flow = await dragFlow(rowEl('Echo'), `document.querySelector('.space[data-space="${targetSpace}"]')`, 0.5, { drop: false })
  check('a tab dragged over the icon of another space lights it up', flow.mark.startsWith('drop-inside:') && flow.prevented, flow.mark)
  const outsideFlow = await dragFlow(rowEl('Echo'), 'document.querySelector(".toolbar")', 0.5, { drop: true })
  check('a drop outside any target does nothing', !outsideFlow.prevented && tabs().some((t) => t.customTitle === 'Echo') && !(await evaluate<boolean>(`!!document.querySelector('.dragging, .drop-before, .drop-after, .drop-inside')`)), outsideFlow.mark)
  flow = await dragFlow(rowEl('Echo'), `document.querySelector('.space[data-space="${spaceId}"]')`, 0.5, { drop: false })
  check('the icon of the current space is not a target', !flow.prevented, flow.mark)
  flow = await dragFlow(rowEl('Echo'), `document.querySelector('.space[data-space="${targetSpace}"]')`, 0.5, { drop: true })
  check('dropping a tab on a space moves it there', await waitFor(() => store.get().tabs.find((t) => t.customTitle === 'Echo')?.spaceId === targetSpace, 4000), String(store.get().tabs.find((t) => t.customTitle === 'Echo')?.spaceId))
  check('and it leaves this sidebar', !(await titles('.tab')).includes('Echo'))

  // Dropping tabs on a space that uses another profile asks first (the same question as the menu), through the real IPC.
  browser.dispatch({ type: 'space/create', name: 'Autre profil', emoji: '🔒', hue: 40, profileId: 'work' })
  const workSpace = store.get().activeSpaceId
  browser.dispatch({ type: 'space/select', id: spaceId })
  await sleep(300)
  const stub = dialog as unknown as { showMessageBoxSync: (...args: unknown[]) => number }
  const realBox = stub.showMessageBoxSync
  const asked: string[] = []
  let answer = 1
  stub.showMessageBoxSync = (_window: unknown, options: unknown) => {
    asked.push((options as { message: string }).message)
    return answer
  }
  try {
    const ids = [idOf('Alpha'), idOf('Bravo')]
    await evaluate(`window.lucium.moveTabsToSpace(${JSON.stringify(ids)}, ${JSON.stringify(workSpace)})`)
    await waitFor(() => asked.length > 0, 3000)
    // The witness: the move is a message without an answer, handled in one go with its question (context-menus.ts); a question asked after it on
    // the same channel is answered once it has been handled.
    await evaluate('window.lucium.getSnapshot().then(() => 0)')
    check('moving tabs to a space of another profile asks once, naming the space', asked.length === 1 && asked[0]!.includes('Autre profil'), asked.join(' | '))
    check('and "Annuler" leaves the tabs where they are', ids.every((id) => store.get().tabs.find((t) => t.id === id)?.spaceId === spaceId))
    answer = 0
    await evaluate(`window.lucium.moveTabsToSpace(${JSON.stringify(ids)}, ${JSON.stringify(workSpace)})`)
    check('"Déplacer" moves them all', await waitFor(() => ids.every((id) => store.get().tabs.find((t) => t.id === id)?.spaceId === workSpace), 3000))
    asked.length = 0
    await evaluate(`window.lucium.moveTabsToSpace(${JSON.stringify([idOf('Foxtrot')])}, ${JSON.stringify(targetSpace)})`)
    check('a space of the same profile moves tabs without asking', await waitFor(() => store.get().tabs.find((t) => t.customTitle === 'Foxtrot')?.spaceId === targetSpace, 3000) && asked.length === 0, asked.join(' | '))
  } finally {
    stub.showMessageBoxSync = realBox
  }
  for (const t of store.get().tabs.filter((x) => x.spaceId === workSpace || x.spaceId === targetSpace)) browser.dispatch({ type: 'tab/move-to-space', id: t.id, spaceId })
  await sleep(300)

  // ======== hover card ========
  const bravo = await rowRect('Bravo')
  const card = () => evaluate<string>(`document.querySelector('.hover-card')?.innerText ?? ''`)
  check('the row of "Bravo" is in the sidebar, for the checks of the hover card', bravo !== null && bravo !== undefined)
  if (bravo) {
    // The pointer comes from outside the sidebar: a pointer already on the row (the layout moved under it) does not "enter" it.
    mouse('mouseMove', bravo.x + bravo.width + 400, 5)
    await sleep(200)
    mouse('mouseMove', bravo.x + 30, bravo.y + 10)
    // A fixed wait, for want of a witness: what is checked is that the card waits for the pointer to rest, so the time spent is the point.
    await sleep(350)
    check('no card yet before the pointer has rested', (await card()) === '')
    await waitFor(async () => (await card()).includes('Bravo'), 4000)
    const text = await card()

    check('after about 1.5 s on a tab the card shows its name, its address and the hint to rename it', text.includes('Bravo') && text.includes('127.0.0.1') && text.includes('Double-cliquez pour renommer'), text)
    // The card comes in with a short animation that lifts it by 2 px (sidebar.css, hover-card-in): its place is read once the animation is over.
    await waitFor(() => evaluate<boolean>(`(() => { const card = document.querySelector('.hover-card'); return !!card && card.getAnimations().length === 0 })()`), 3000)
    const geometry = await rectOf('.hover-card')
    const sidebar = await rectOf('.sidebar')
    check('the card stays inside the sidebar, over the last 11 px of the row', !!geometry && !!sidebar && geometry.x >= sidebar.x && geometry.x + geometry.width <= sidebar.x + sidebar.width && Math.abs(geometry.y - (bravo.y + bravo.height - 11)) <= 1.5, JSON.stringify({ geometry, sidebar, row: bravo }))
    mouse('mouseMove', bravo.x + bravo.width + 400, 5)
    check('the card goes when the pointer leaves the row', await waitFor(async () => (await card()) === ''))

    // The picture of the page: taken while a tab was on screen, so only some tabs have one.
    const pictureOf = (id: string) => evaluate<string | null>(`window.lucium.tabThumbnail(${JSON.stringify(id)})`)
    const known = await Promise.all(tabs().map(async (t) => ({ id: t.id, name: t.customTitle!, picture: await pictureOf(t.id) })))
    const shown = known.find((k) => k.picture)
    // The tab on screen is shown: its picture is taken a few seconds after it came on screen (thumbnails.ts, SHOT_DELAYS_MS), and may come between this
    // reading and its card. A tab never shown is one of the others.
    const onScreen = activeTab(store.get())?.id
    const unseen = known.find((k) => !k.picture && k.id !== onScreen)
    check('the pages that were on screen have a small picture of them', !!shown && shown.picture!.startsWith('data:image/jpeg;base64,'), JSON.stringify(known.map((k) => `${k.name}:${k.picture?.length ?? 0}`)))
    const hoverRow = async (name: string) => {
      mouse('mouseMove', bravo.x + bravo.width + 400, 5)
      await sleep(250)
      const r = (await rowRect(name))!
      mouse('mouseMove', r.x + 30, r.y + 10)
      await sleep(1900)
      return evaluate<{ thumb: string | null; text: string }>(`({ thumb: document.querySelector('.hover-card-thumb')?.getAttribute('src')?.slice(0, 23) ?? null, text: document.querySelector('.hover-card')?.innerText ?? '' })`)
    }
    if (shown) {
      const withPicture = await hoverRow(shown.name)
      check('the card of such a tab shows its picture above the name', withPicture.thumb === 'data:image/jpeg;base64,' && withPicture.text.includes(shown.name), JSON.stringify(withPicture))
      const geometryWithPicture = await rectOf('.hover-card')
      // Measured against the sidebar as it is drawn, as the card without a picture is above: its width is the user's (323 px by default).
      const sidebarNow = await rectOf('.sidebar')
      check('and still fits in the sidebar', !!geometryWithPicture && !!sidebarNow && geometryWithPicture.x >= sidebarNow.x && geometryWithPicture.x + geometryWithPicture.width <= sidebarNow.x + sidebarNow.width, JSON.stringify({ card: geometryWithPicture, sidebar: sidebarNow }))
      await shot('hover-card')
    }
    if (unseen) {
      const withoutPicture = await hoverRow(unseen.name)
      check('the card of a tab never shown has no picture, only text', withoutPicture.thumb === null && withoutPicture.text.includes(unseen.name), JSON.stringify(withoutPicture))
    } else check('the card of a tab never shown has no picture, only text', true, skippedBecause('every tab of the space has been on screen: none is left without a picture'))
    mouse('mouseMove', bravo.x + bravo.width + 400, 5)
    await sleep(250)
    browser.dispatch({ type: 'settings/update', patch: { hoverCards: false } })
    await sleep(300)
    mouse('mouseMove', bravo.x + 40, bravo.y + 12)
    await sleep(1900)
    const plain = await card()
    check('with "Aperçu dans la carte de survol" off the card is the bare bubble: the name and the hint, no address or picture', plain.includes('Bravo') && plain.includes('Double-cliquez pour renommer') && !plain.includes('127.0.0.1') && (await evaluate<boolean>(`!document.querySelector('.hover-card-thumb')`)), plain)
    check('and the row has no native tooltip of its own', (await evaluate<string>(`${rowEl('Bravo')}?.title ?? ''`)) === '')
    mouse('mouseMove', bravo.x + bravo.width + 400, 5)
    browser.dispatch({ type: 'settings/update', patch: { hoverCards: true } })
  } else check('the Bravo row can be found for the hover card', false)
  const spaceMenu = menuItems({ kind: 'space', id: spaceId }, browser, store, win)
  const toggle = spaceMenu.find((i) => i.label === 'Aperçu dans la carte de survol')
  check('the space menu has a checked "Aperçu dans la carte de survol"', toggle?.type === 'checkbox' && toggle.checked === true)
  ;(toggle?.click as (() => void) | undefined)?.()
  check('and choosing it turns the cards off', store.get().settings.hoverCards === false)
  browser.dispatch({ type: 'settings/update', patch: { hoverCards: true } })

  // A card for a row near the bottom opens above it, so the footer does not hide it.
  for (let i = 1; i <= 16; i++) {
    browser.dispatch({ type: 'tab/open', url: `${base}/filler-${i}`, background: true })
    browser.dispatch({ type: 'tab/rename', id: tabs().at(-1)!.id, title: `Filler ${i}` })
  }
  await sleep(500)
  // The last row on screen (the list scrolls): the card must not run into the footer under it.
  const lastTitle = await evaluate<string>(`(() => { const rows = [...document.querySelectorAll('.tab')].filter((t) => t.getBoundingClientRect().bottom < window.innerHeight - 70); return rows.at(-1).querySelector('.tab-title').textContent })()`)
  const lastRow = await rowRect(lastTitle)
  const cardAbove = async () => {
    mouse('mouseMove', 600, 5)
    await sleep(250)
    if (!lastRow) return null
    mouse('mouseMove', lastRow.x + 30, lastRow.y + 10)
    await sleep(1900)
    return { card: await rectOf('.hover-card'), row: await rowRect(lastTitle) }
  }
  const nearBottom = await cardAbove()
  check('a card for a row at the bottom of the sidebar opens above the row', !!nearBottom?.card && !!nearBottom.row && nearBottom.card.y + nearBottom.card.height <= nearBottom.row.y + 12, JSON.stringify(nearBottom))
  mouse('mouseMove', 600, 5)
  await sleep(250)

  // ---- clean up ----
  browser.dispatch({ type: 'space/select', id: previousSpace })
  for (const sp of store.get().spaces.filter((s) => ['Sidebar test', 'Cible', 'Autre profil'].includes(s.name))) browser.dispatch({ type: 'space/delete', id: sp.id })
  for (const f of store.get().favorites.filter((f) => f.url.startsWith(base))) browser.dispatch({ type: 'favorite/remove', id: f.id })
  server.close()
}
