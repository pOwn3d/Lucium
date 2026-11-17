// Engine checks for the two extra sidebar functions, run inside a real Electron:
//  - the tab tree (Réglages › Fonctions › Arbre d’onglets): a tab opened by a real click on a link hangs under its opener, indented, with a
//    chevron that folds the branch; the menu entry, a drop on the middle of a row, closing the parent, and the setting switched off;
//  - the compact mode (Mode compact): the menu entry (hidden while the function is off), both bars away with one command, the floating
//    sidebar that shows the address in place of the tab on screen, a click on it that opens the command bar, and the way back.
// With both functions off the sidebar must be exactly the default one: no extra element in the rows, no entry in the menus, rows where they were.
// A local server, a space of its own (removed at the end), the settings put back. Rows are measured in pixels of page (Retina: 2 pixels each).
// The drag of the operating system cannot be driven by synthetic input (see smoke-navigation.ts): the drag events are dispatched on the real
// elements of the sidebar, which exercises the handlers, the places they work out (shared/dnd.ts) and the actions that come out.
// Called from the engine smoke test; `LUCIUM_SMOKE_ONLY=tabsui` runs only this file (see index.ts).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Menu, type MenuItem, type WebContents } from 'electron'
import { compactAddress } from '@shared/compact'
import { TREE_INDENT } from '@shared/tab-tree'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 60)

interface Box {
  x: number
  y: number
  w: number
  h: number
}
const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance
const sameBox = (a: Box | null | undefined, b: Box | null | undefined) => !!a && !!b && near(a.x, b.x, 0.5) && near(a.y, b.y, 0.5) && near(a.w, b.w, 0.5) && near(a.h, b.h, 0.5)
const show = (b: Box | null | undefined) => (b ? `${b.x},${b.y} ${b.w}x${b.h}` : 'null')

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

export async function smokeTabsUi(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const chrome = win.webContents
  const state = () => store.get()
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>

  // ---- a server with a page that opens tabs ----
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/favicon.ico') return void res.writeHead(404).end()
    if (url.pathname === '/a') {
      return void res.end(`<title>A</title><body style="margin:0">
        <a id="blank" href="/b?k=blank" target="_blank" style="display:block;margin:10px;height:30px">blank</a></body>`)
    }
    res.end(`<title>page ${url.pathname}</title><body style="margin:0;background:#ffffff">${url.pathname}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- a space of its own ----
  const previousSpace = state().activeSpaceId
  const original = { ...state().settings }
  win.setSize(1280, 800)
  win.showInactive()
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, showToolbar: true, hoverCards: false, sleepAfterMinutes: 0, keyBindings: {}, compactMode: false, tabTree: false, fullUrlInToolbar: false } })
  browser.dispatch({ type: 'space/create', name: 'Onglets UI', emoji: '🌳', hue: 140 })
  const spaceId = state().activeSpaceId
  const tabsHere = () => state().tabs.filter((t) => t.spaceId === spaceId)
  const byName = (name: string) => tabsHere().find((t) => t.customTitle === name)
  const idsNow = () => new Set(tabsHere().map((t) => t.id))
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const loaded = (id: string) => waitFor(() => browser.snapshot().runtime.tabs[id]?.loading === false && wcOf(id)?.getURL().startsWith('http') === true)
  const openTab = async (path: string, name: string): Promise<string> => {
    const before = tabsHere().length
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    await waitFor(() => tabsHere().length === before + 1)
    const id = tabsHere().at(-1)!.id
    await loaded(id)
    browser.dispatch({ type: 'tab/rename', id, title: name })
    await sleep(150)
    return id
  }
  const rectIn = (wc: WebContents, selector: string) =>
    evaluate<{ x: number; y: number } | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const click = async (wc: WebContents, at: { x: number; y: number }) => {
    wc.focus()
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) {
      wc.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
      await sleep(30)
    }
  }
  /** A real click on a link of a page; the tab it opens is returned (it is on screen). */
  const openFrom = async (openerId: string, name: string): Promise<string> => {
    browser.dispatch({ type: 'tab/select', id: openerId })
    await loaded(openerId)
    await sleep(200)
    const before = idsNow()
    const at = await rectIn(wcOf(openerId)!, '#blank')
    if (!at) throw new Error('no link to click')
    await click(wcOf(openerId)!, at)
    await waitFor(() => tabsHere().some((t) => !before.has(t.id)))
    const tab = tabsHere().find((t) => !before.has(t.id))!
    await loaded(tab.id)
    browser.dispatch({ type: 'tab/rename', id: tab.id, title: name })
    await sleep(200)
    return tab.id
  }
  const rowBox = (name: string, from: WebContents = chrome) =>
    evaluate<Box | null>(from, `(() => { const el = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })()`)
  const titles = () => evaluate<string[]>(chrome, `[...document.querySelectorAll('.sidebar .tab .tab-title')].map((e) => e.textContent)`)
  const count = (selector: string, from: WebContents = chrome) => evaluate<number>(from, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const rowHas = (name: string, selector: string) =>
    evaluate<boolean>(chrome, `(() => { const el = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)}); return !!el?.querySelector(${JSON.stringify(selector)}) })()`)
  const rowClass = (name: string, cls: string) =>
    evaluate<boolean>(chrome, `(() => { const el = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)}); return !!el?.classList.contains(${JSON.stringify(cls)}) })()`)
  const hover = async (name: string) => {
    chrome.sendInputEvent({ type: 'mouseMove', x: 900, y: 400 })
    await sleep(120)
    const box = (await rowBox(name))!
    chrome.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) })
    await sleep(200)
    return box
  }
  const tabNamed = (name: string) => byName(name)
  const parentName = (name: string) => {
    const parent = tabNamed(name)?.parentId
    return parent === undefined ? null : state().tabs.find((t) => t.id === parent)?.customTitle ?? '?'
  }

  try {
    // ========================================================================
    // Both functions off: the sidebar is the default one
    // ========================================================================
    check('tabs-ui: both functions are off by default', original.compactMode === false && original.tabTree === false)
    const a = await openTab('/a', 'Origine')
    const other = await openFrom(a, 'Autre')
    check('tabs-ui: off: a tab opened from a link is an ordinary tab (no parent)', byName('Autre')?.parentId === undefined && byName('Autre')?.id === other)
    const baseline = await rowBox('Origine')
    const baselineOther = await rowBox('Autre')
    check('tabs-ui: off: no element of the tree in the rows (no chevron, no indentation, no marker on the rows)', (await count('.tree-toggle')) === 0 && (await count('.tab.tree-child')) === 0 && (await count('.tab[data-pinned]')) === 0 && (await count('.tab.address')) === 0)
    check('tabs-ui: off: the menus have no entry of the two functions (hidden)', findMenuItem('Passer en mode compact')?.visible === false && findMenuItem('Replier les onglets enfants')?.visible === false && findMenuItem('Sortir l’onglet de son parent')?.visible === false)
    const layoutBefore = { sidebar: state().settings.sidebarVisible, toolbar: state().settings.showToolbar }
    // No wait: the dispatch has changed the state, or refused to, before it returns.
    browser.dispatch({ type: 'compact/toggle' })
    check('tabs-ui: off: the compact command changes nothing', state().settings.sidebarVisible === layoutBefore.sidebar && state().settings.showToolbar === layoutBefore.toolbar)
    browser.dispatch({ type: 'tab/tree-collapse', id: a })
    check('tabs-ui: off: the fold command changes nothing', byName('Origine')?.treeCollapsed === undefined)

    // ========================================================================
    // The tab tree
    // ========================================================================
    browser.dispatch({ type: 'settings/update', patch: { tabTree: true } })
    await sleep(300)
    const stillThere = await rowBox('Origine')
    check('tabs-ui: tree: a row that is in no branch is where it was (same box as with the function off)', sameBox(stillThere, baseline) && sameBox(await rowBox('Autre'), baselineOther), `${show(stillThere)} against ${show(baseline)}`)
    check('tabs-ui: tree: every row says whether it is pinned (so that a drop on a pinned tab never means "under it")', (await count('.tab[data-pinned="false"]')) === 2)

    const child = await openFrom(a, 'Enfant')
    check('tabs-ui: tree: a tab opened by a click on a link hangs under its opener', byName('Enfant')?.id === child && parentName('Enfant') === 'Origine', JSON.stringify({ parent: parentName('Enfant') }))
    check('tabs-ui: tree: it is listed right under its parent, before the tab that was already there', (await titles()).join('|') === 'Origine|Enfant|Autre', (await titles()).join('|'))
    const parentBox = await rowBox('Origine')
    const childBox = await rowBox('Enfant')
    check('tabs-ui: tree: the child row is indented by one level (16 px, like the content of a folder) and keeps the height of a row', !!parentBox && !!childBox && near(childBox.x, parentBox.x + TREE_INDENT, 0.5) && near(childBox.h, parentBox.h, 0.5), `${show(parentBox)} / ${show(childBox)}`)
    await hover('Origine')
    check('tabs-ui: tree: the parent has the chevron of its branch, the child none, and the flat row still has none', (await rowHas('Origine', '.tree-toggle')) && !(await rowHas('Enfant', '.tree-toggle')) && !(await rowHas('Autre', '.tree-toggle')))
    check('tabs-ui: tree: the child row carries its level, and the parent and the flat row do not', (await rowClass('Enfant', 'tree-child')) && !(await rowClass('Origine', 'tree-child')) && !(await rowClass('Autre', 'tree-child')))
    check('tabs-ui: tree: the parent and the flat row have not moved', sameBox(await rowBox('Origine'), baseline), show(await rowBox('Origine')))

    // Fold with a real click on the chevron
    await hover('Origine')
    const toggle = await rectIn(chrome, '.tab:has(.tree-toggle) .tree-toggle')
    if (toggle) await click(chrome, toggle)
    check('tabs-ui: tree: a click on the chevron folds the branch: the child row goes, the parent says how many tabs it hides', await waitFor(async () => byName('Origine')?.treeCollapsed === true && !(await titles()).includes('Enfant')), (await titles()).join('|'))
    const folded = await evaluate<{ count: string; label: string | null } | null>(chrome, `(() => { const b = document.querySelector('.tree-toggle.folded'); return b ? { count: b.querySelector('.tree-count')?.textContent ?? '', label: b.getAttribute('aria-label') } : null })()`)
    check('tabs-ui: tree: a folded branch keeps its chevron visible, with the number of tabs it hides and an accessible name', folded?.count === '1' && /Déplier/.test(folded.label ?? ''), JSON.stringify(folded))

    // Unfold with the menu entry (Onglets › Déplier les onglets enfants)
    browser.dispatch({ type: 'tab/select', id: a })
    await waitFor(() => findMenuItem('Déplier les onglets enfants')?.visible === true)
    const unfold = findMenuItem('Déplier les onglets enfants')
    check('tabs-ui: tree: the menu entry is there, enabled for the parent on screen, and has no shortcut by default', unfold?.visible === true && unfold.enabled === true && !unfold.accelerator, JSON.stringify({ visible: unfold?.visible, enabled: unfold?.enabled, accelerator: unfold?.accelerator }))
    unfold?.click()
    check('tabs-ui: tree: the entry opens the branch again', await waitFor(async () => byName('Origine')?.treeCollapsed === undefined && (await titles()).includes('Enfant')))
    check('tabs-ui: tree: the entry is greyed out for a tab with no children', await (async () => {
      browser.dispatch({ type: 'tab/select', id: child })
      await waitFor(() => findMenuItem('Replier les onglets enfants')?.enabled === false)
      return findMenuItem('Replier les onglets enfants')?.enabled === false && findMenuItem('Sortir l’onglet de son parent')?.enabled === true
    })())

    // A drop on the middle of a row makes the dragged tab its last child
    browser.dispatch({ type: 'tab/select', id: a })
    await sleep(200)
    const drop = await evaluate<boolean>(
      chrome,
      `(() => {
        const dragged = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === 'Autre')
        if (!dragged) return false
        dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
        return true
      })()`
    )
    await sleep(150)
    const dropped = await evaluate<boolean>(
      chrome,
      `(() => {
        const rows = [...document.querySelectorAll('.tab')]
        const target = rows.find((t) => t.querySelector('.tab-title')?.textContent === 'Origine'), list = document.querySelector('.sidebar .scroll')
        if (!target || !list) return false
        const r = target.getBoundingClientRect()
        const dt = new DataTransfer()
        const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }
        list.dispatchEvent(new DragEvent('dragover', at))
        list.dispatchEvent(new DragEvent('drop', at))
        return true
      })()`
    )
    check('tabs-ui: tree: a drop on the middle of a row hangs the dragged tab under it, after its other children', drop && dropped && (await waitFor(() => parentName('Autre') === 'Origine')) && (await titles()).join('|') === 'Origine|Enfant|Autre', `${parentName('Autre')} ${(await titles()).join('|')}`)

    // Closing the parent keeps the children
    // No wait for the state: the dispatch has changed it before it returns. The rows, drawn from it by the sidebar, are waited for.
    browser.dispatch({ type: 'tab/archive', id: a })
    check('tabs-ui: tree: archiving the parent keeps its children, as tabs of their own', !byName('Origine') && !!byName('Enfant') && !!byName('Autre') && parentName('Enfant') === null && parentName('Autre') === null)
    check('tabs-ui: tree: and the rows are flat again', await waitFor(async () => (await count('.tab.tree-child')) === 0 && (await count('.tree-toggle')) === 0))

    // Switched off, the tree is flattened
    const root = await openTab('/a', 'Racine')
    await openFrom(root, 'Petit')
    check('tabs-ui: tree: another branch exists before the switch is turned off', parentName('Petit') === 'Racine' && (await count('.tab.tree-child')) === 1)
    browser.dispatch({ type: 'settings/update', patch: { tabTree: false } })
    check('tabs-ui: off again: no tab keeps a parent or a fold, and the rows are Arc’s again', await waitFor(async () => tabsHere().every((t) => t.parentId === undefined && t.treeCollapsed === undefined) && (await count('.tab.tree-child')) === 0 && (await count('.tab[data-pinned]')) === 0))

    // ========================================================================
    // The compact mode
    // ========================================================================
    const current = byName('Petit')!
    browser.dispatch({ type: 'tab/select', id: current.id })
    await sleep(300)
    const toolbarBefore = await count('.page-toolbar')
    browser.dispatch({ type: 'settings/update', patch: { compactMode: true } })
    await waitFor(() => findMenuItem('Passer en mode compact')?.visible === true)
    const entry = findMenuItem('Passer en mode compact')
    check('tabs-ui: compact: the Affichage entry shows with the function on, with no shortcut by default', entry?.visible === true && entry.enabled === true && !entry.accelerator, JSON.stringify({ visible: entry?.visible, accelerator: entry?.accelerator }))
    check('tabs-ui: compact: switching the function on changes nothing by itself (both bars are still there)', state().settings.sidebarVisible && state().settings.showToolbar && toolbarBefore === 1 && (await count('.page-toolbar')) === 1)
    entry?.click()
    check('tabs-ui: compact: one command puts the sidebar and the toolbar away', await waitFor(() => !state().settings.sidebarVisible && !state().settings.showToolbar))
    await sleep(500)
    const pageView = (browser.pageFor(current.id) as unknown as { view: Electron.View }).view.getBounds()
    const margin = state().settings.windowBorder
    check('tabs-ui: compact: the page card is against the window’s border on its top and left (no bar left)', pageView.x === margin && pageView.y === margin, JSON.stringify(pageView))
    check('tabs-ui: compact: the entry now offers the way back', await waitFor(() => findMenuItem('Quitter le mode compact')?.visible === true && findMenuItem('Passer en mode compact') === undefined))

    // The pointer at the edge brings the floating sidebar, which shows the address in place of the tab on screen
    browser.hotEdge(true)
    check('tabs-ui: compact: the pointer at the edge brings the floating sidebar', await waitFor(() => browser.isFloatingSidebarShown(), 3000))
    await sleep(500)
    const floatView = win.contentView.children.map((v) => v as Electron.WebContentsView).find((v) => v.webContents.getURL().includes('#float'))
    const float = floatView?.webContents
    const address = compactAddress(current.url, false)
    const shown = float ? await evaluate<{ title: string | null; urlbar: number; lock: boolean }>(float, `(() => { const row = document.querySelector('.tab.address'); return { title: row?.querySelector('.tab-title')?.textContent ?? null, urlbar: document.querySelectorAll('.urlbar').length, lock: !!row?.querySelector('.site-info') } })()`) : null
    check('tabs-ui: compact: in the floating sidebar the tab on screen shows its address, not its title, with the button of the site’s settings', shown?.title === address && shown.lock, JSON.stringify({ shown, address }))
    check('tabs-ui: compact: the address bar of the sidebar is not shown twice', shown?.urlbar === 0, JSON.stringify(shown))
    const others = float ? await evaluate<string[]>(float, `[...document.querySelectorAll('.tab:not(.address) .tab-title')].map((e) => e.textContent)`) : []
    check('tabs-ui: compact: the other tabs keep their titles', others.length > 0 && !others.includes(address), JSON.stringify(others))

    // A click on the address opens the command bar on it
    const row = float ? await rectIn(float, '.tab.address .tab-title') : null
    if (float && row) await click(float, row)
    const barOpen = await waitFor(() => browser.currentPanel() === 'commandbar', 3000)
    check('tabs-ui: compact: a click on the address opens the command bar, filled with the page’s address', barOpen && (browser.currentOverlay() as { initial?: string } | null)?.initial === current.url, JSON.stringify(browser.currentOverlay()))
    browser.closeOverlay()
    await sleep(300)

    // The way back
    await waitFor(() => findMenuItem('Quitter le mode compact')?.visible === true)
    findMenuItem('Quitter le mode compact')?.click()
    check('tabs-ui: compact: the same command brings both bars back', await waitFor(() => state().settings.sidebarVisible && state().settings.showToolbar))
    check('tabs-ui: compact: and the floating sidebar is gone', await waitFor(() => !browser.isFloatingSidebarShown()))

    // The function switched off while the window is compact: the default floating sidebar
    browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false, showToolbar: false } })
    await sleep(400)
    browser.dispatch({ type: 'settings/update', patch: { compactMode: false } })
    browser.hotEdge(true)
    await waitFor(() => browser.isFloatingSidebarShown(), 3000)
    await sleep(500)
    const arcs = float ? await evaluate<{ address: number; urlbar: number }>(float, `({ address: document.querySelectorAll('.tab.address').length, urlbar: document.querySelectorAll('.urlbar').length })`) : null
    check('tabs-ui: off again: the floating sidebar is Arc’s (the address bar of the toolbar-less sidebar, no address row)', arcs?.address === 0 && arcs.urlbar === 1, JSON.stringify(arcs))
    // No wait: the dispatch has changed the state, or refused to, before it returns.
    browser.dispatch({ type: 'compact/toggle' })
    check('tabs-ui: off again: the command does nothing', !state().settings.sidebarVisible && !state().settings.showToolbar)
    check('tabs-ui: off again: the entry is hidden', await waitFor(() => findMenuItem('Passer en mode compact')?.visible === false || findMenuItem('Quitter le mode compact')?.visible === false))
  } finally {
    browser.hotEdge(false)
    browser.closeOverlay()
    for (const t of state().tabs.filter((tab) => tab.spaceId === spaceId)) browser.dispatch({ type: 'tab/close', id: t.id })
    if (state().spaces.some((s) => s.id === spaceId)) browser.dispatch({ type: 'space/delete', id: spaceId })
    if (state().spaces.some((s) => s.id === previousSpace)) browser.dispatch({ type: 'space/select', id: previousSpace })
    browser.dispatch({
      type: 'settings/update',
      patch: { sidebarVisible: original.sidebarVisible, showToolbar: original.showToolbar, hoverCards: original.hoverCards, sleepAfterMinutes: original.sleepAfterMinutes, keyBindings: original.keyBindings, compactMode: original.compactMode, tabTree: original.tabTree, fullUrlInToolbar: original.fullUrlInToolbar }
    })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=tabsui`: only these checks, with their own report. */
export async function runTabsUiSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeTabsUi(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeTabsUi ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_TABSUI ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
