// Engine checks for the work views (shared/work-views.ts): a split view of two local pages saved as a view from the menu of its options (the sheet, a
// name typed, Return), the tile that appears after the favourites with the layout drawn, a real click on it that opens the view again (the two sites in a
// split view at their proportions), a second click that opens nothing more, the removal from the tile's menu and its « Annuler », the entry of the menu
// of the Dock, the row of the + and the switch. Real input (sendInputEvent) drives the tile and the sheet; the native menus are built as the main
// process builds them. `LUCIUM_SMOKE_ONLY=work-views pnpm test:engine` runs only this file; it is part of the chain.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { SidebarState, SplitView } from '@shared/model'
import { menuItems } from './shell/context-menus'
import type { SmokeContext } from './smoke'
import { noteCheck, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void
type Item = MenuItemConstructorOptions

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const waitFor = waiterOf(6000, 50)

export async function smokeWorkViews(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const chrome = win.webContents
  const ui = overlayView.webContents
  const state = (): SidebarState => store.get()
  const evaluate = <T>(from: WebContents, script: string) => from.executeJavaScript(script) as Promise<T>
  const rect = (from: WebContents, selector: string) =>
    evaluate<Box | null>(from, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`)
  const click = async (from: WebContents, box: Box) => {
    const x = Math.round(box.x + box.w / 2)
    const y = Math.round(box.y + box.h / 2)
    // The pointer comes over the target before it presses, as a hand does: the hover of the tile is drawn first.
    from.sendInputEvent({ type: 'mouseMove', x, y })
    await sleep(40)
    from.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    from.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  // Return in a field submits its form only through the character event (the keypress of Chromium), as a typed letter does: a key down and a key up alone press nothing there.
  const submit = async () => {
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ui.sendInputEvent({ type: 'char', keyCode: '\r' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(80)
  }
  const typeText = async (text: string) => {
    for (const ch of text) {
      ui.sendInputEvent({ type: 'keyDown', keyCode: ch })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(40)
    }
    await sleep(150)
  }
  const menuOf = (target: Parameters<typeof menuItems>[0]): Item[] => menuItems(target, browser, store, win, { headers: false }) as Item[]
  const itemOf = (items: Item[], label: string): Item | undefined => items.find((item) => item.label === label)
  const press = (item: Item | undefined) => (item?.click as unknown as (() => void) | undefined)?.()
  const tabsOf = (spaceId: string) => state().tabs.filter((t) => t.spaceId === spaceId)
  const splitOfView = (viewId: string, spaceId: string): SplitView | undefined => state().splits.find((split) => split.viewId === viewId && split.spaceId === spaceId)
  const shownIn = (split: SplitView | undefined) => split !== undefined && split.tabIds.includes(state().activeTabBySpace[split.spaceId] ?? '')

  // ---- two local pages, in a space of their own, side by side at 60 / 40 ----
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html')
    res.end(`<title>vue ${req.url}</title><body>vue ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const previousSpace = state().activeSpaceId
  const previousSwitch = state().settings.workViewsEnabled
  const viewsBefore = state().workViews.map((view) => view.id)
  browser.dispatch({ type: 'settings/update', patch: { workViewsEnabled: true } })
  browser.dispatch({ type: 'space/create', name: 'Vues ISO', emoji: '🧪', hue: 200 })
  const spaceId = state().activeSpaceId
  try {
    browser.dispatch({ type: 'tab/open', url: `${base}/mail`, spaceId })
    browser.dispatch({ type: 'tab/open', url: `${base}/agenda`, spaceId })
    await waitFor(() => tabsOf(spaceId).filter((t) => t.title.startsWith('vue /')).length === 2, 10_000)
    const [mail, agenda] = tabsOf(spaceId)
    browser.dispatch({ type: 'split/create', tabId: mail!.id, withTabId: agenda!.id })
    const split = state().splits.find((each) => each.tabIds.includes(mail!.id))!
    browser.dispatch({ type: 'split/ratios', id: split.id, ratios: [0.6, 0.4] })
    await waitFor(() => state().splits.find((each) => each.id === split.id)?.ratios[0] === 0.6)

    // ---- 1. saved from the menu of the split view, with the sheet ----
    const saveEntry = itemOf(menuOf({ kind: 'split', id: mail!.id }), 'Enregistrer comme vue de travail…')
    check('save: the menu of the split view offers « Enregistrer comme vue de travail… », enabled', saveEntry !== undefined && saveEntry.enabled !== false)
    press(saveEntry)
    check('save: it opens the sheet of the view', await waitFor(() => browser.currentPanel() === 'workview'), JSON.stringify(browser.currentOverlay()))
    await waitFor(async () => (await evaluate<string | undefined>(ui, `document.activeElement?.tagName`)) === 'INPUT', 3000)
    await typeText('Matin')
    await submit()
    const saved = await waitFor(() => state().workViews.length === viewsBefore.length + 1)
    const view = state().workViews.find((each) => !viewsBefore.includes(each.id))
    check('save: Return saves a view named as typed, with the two sites in their order and their proportions', saved && view?.name === 'Matin' && view.panes.map((pane) => pane.url).join() === `${base}/mail,${base}/agenda` && view.ratios.map((r) => Math.round(r * 100)).join() === '60,40', JSON.stringify(view))
    check('save: the sheet closes, and the split view on screen is the view’s', browser.currentPanel() === null && splitOfView(view?.id ?? '', spaceId)?.id === split.id, JSON.stringify(state().splits))
    if (!view) return

    // ---- 2. the tile ----
    const tileSelector = `.favorites [data-work-view="${view.id}"]`
    check('tile: it appears in the grid of the favourites', await waitFor(async () => (await rect(chrome, tileSelector)) !== null), String(await rect(chrome, tileSelector)))
    const tileInfo = await evaluate<{ label: string; current: string | null; panes: number[][] } | null>(
      chrome,
      `(() => { const t = document.querySelector(${JSON.stringify(tileSelector)}); if (!t) return null; return { label: t.getAttribute('aria-label'), current: t.getAttribute('aria-current'), panes: [...t.querySelectorAll('.work-view-pane')].map((p) => { const r = p.getBoundingClientRect(); return [r.width, r.height] }) } })()`
    )
    check('tile: a button named for a screen reader (« Matin, vue de travail, 2 sites »), current while its split view is on screen', tileInfo?.label === 'Matin, vue de travail, 2 sites' && tileInfo.current === 'true', JSON.stringify(tileInfo))
    check('tile: it draws the two panes side by side, the first wider (60 / 40)', tileInfo?.panes.length === 2 && tileInfo.panes[0]![0]! > tileInfo.panes[1]![0]!, JSON.stringify(tileInfo?.panes))

    // ---- 3. a click opens the view again once its tabs are gone ----
    browser.dispatch({ type: 'tabs/archive-many', ids: split.tabIds })
    check('open: (control) the two tabs archived, the split view is gone', await waitFor(() => splitOfView(view.id, spaceId) === undefined))
    browser.dispatch({ type: 'tab/open', url: `${base}/autre`, spaceId })
    await waitFor(() => tabsOf(spaceId).some((t) => t.url === `${base}/autre`))
    const tabsBefore = state().tabs.length
    await click(chrome, (await rect(chrome, tileSelector))!)
    const opened = await waitFor(() => shownIn(splitOfView(view.id, spaceId)))
    const reopened = splitOfView(view.id, spaceId)
    check('open: a real click on the tile opens the two sites in a split view of this space, marked as the view’s, at 60 / 40', opened && state().tabs.length === tabsBefore + 2 && reopened?.ratios.map((r) => Math.round(r * 100)).join() === '60,40', JSON.stringify(reopened))
    check('open: the pages load in their panes', await waitFor(() => (reopened?.tabIds ?? []).every((id) => state().tabs.find((t) => t.id === id)?.title.startsWith('vue /') === true), 10_000))
    check('open: the tile is lit', await waitFor(async () => (await evaluate<string | null>(chrome, `document.querySelector(${JSON.stringify(tileSelector)})?.getAttribute('aria-current') ?? null`)) === 'true'))

    // ---- 4. a second click opens nothing more ----
    const other = tabsOf(spaceId).find((t) => t.url === `${base}/autre`)!
    browser.dispatch({ type: 'tab/select', id: other.id })
    await waitFor(() => !shownIn(splitOfView(view.id, spaceId)))
    const tabsNow = state().tabs.length
    await click(chrome, (await rect(chrome, tileSelector))!)
    check('second click: the same split view comes back, and no tab is opened', (await waitFor(() => shownIn(splitOfView(view.id, spaceId)))) && state().tabs.length === tabsNow && splitOfView(view.id, spaceId)?.id === reopened?.id, `${state().tabs.length} / ${tabsNow}`)

    // ---- 5. removed from the tile's menu, and « Annuler » ----
    const tileMenu = menuOf({ kind: 'workview', id: view.id })
    check('menu: the tile’s menu has Ouvrir, Modifier…, Enregistrer ce qui est affiché, Revenir aux adresses enregistrées and Retirer la vue de travail', ['Ouvrir', 'Modifier…', 'Enregistrer ce qui est affiché', 'Revenir aux adresses enregistrées', 'Retirer la vue de travail'].every((label) => itemOf(tileMenu, label) !== undefined), tileMenu.map((item) => item.label).join(' | '))
    const keptTabs = state().tabs.length
    press(itemOf(tileMenu, 'Retirer la vue de travail'))
    check('remove: the tile goes and the tabs stay, in an ordinary split view', (await waitFor(async () => (await rect(chrome, tileSelector)) === null)) && state().tabs.length === keptTabs && state().splits.some((each) => each.id === reopened?.id && each.viewId === undefined))
    const toast = browser.snapshot().toast
    check('remove: a notice says so and offers « Annuler »', toast?.action === 'Annuler' && /Matin/.test(toast.message), JSON.stringify(toast))
    if (toast) browser.runToastAction(toast.id)
    check('remove: « Annuler » puts the view back, its tile lit again', (await waitFor(() => state().workViews.some((each) => each.id === view.id) && splitOfView(view.id, spaceId)?.id === reopened?.id)) && (await waitFor(async () => (await rect(chrome, tileSelector)) !== null)))

    // ---- 6. the menu of the Dock ----
    if (process.platform === 'darwin' && app.dock) {
      const dockItems = () => (app.dock?.getMenu()?.items ?? []).filter((item) => item.type !== 'separator')
      check('Dock: the menu lists the view under « Vues de travail », with its icon', await waitFor(() => dockItems().some((item) => item.label === `${view.emoji} Matin`) && dockItems().some((item) => item.label === 'Vues de travail' && !item.enabled)), dockItems().map((item) => item.label).join(' | '))
      browser.dispatch({ type: 'tab/select', id: other.id })
      await waitFor(() => !shownIn(splitOfView(view.id, spaceId)))
      dockItems().find((item) => item.label === `${view.emoji} Matin`)?.click()
      check('Dock: its entry shows the view again in the window, without opening anything more', (await waitFor(() => shownIn(splitOfView(view.id, spaceId)))) && state().tabs.length === keptTabs)
    } else check('Dock: (skipped, no Dock here)', true)

    // ---- 7. the + makes a view from nothing ----
    const plus = await rect(chrome, '.footer-plus')
    if (plus) await click(chrome, plus)
    check('+: the popover has « Nouvelle vue de travail… »', await waitFor(async () => (await rect(ui, '.plus-row[data-entry="workview"]')) !== null))
    // The popover grows for 0.2 s (plus-grow): measured on its first frames the row is half its height and the click lands on the row below it on the final card (seen on the slow runner of the tag v1.1.6).
    await evaluate(ui, `Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))`)
    const row = await rect(ui, '.plus-row[data-entry="workview"]')
    if (row) await click(ui, row)
    check('+: it opens the whole sheet of a new view', await waitFor(() => JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'workview', full: true })), JSON.stringify(browser.currentOverlay()))
    check('+: the sheet has a field for each of the two sites to come', (await evaluate<number>(ui, `document.querySelectorAll('.work-view-sheet .wv-site input').length`)) === 2)
    browser.closeOverlay()
    await waitFor(() => browser.currentPanel() === null)

    // ---- 8. switched off: no tile, and nothing is erased ----
    browser.dispatch({ type: 'settings/update', patch: { workViewsEnabled: false } })
    check('off: the tile goes, the view stays in the state', (await waitFor(async () => (await rect(chrome, tileSelector)) === null)) && state().workViews.some((each) => each.id === view.id))
    check('off: the menu of the split view no longer offers to save it', itemOf(menuOf({ kind: 'split', id: reopened!.tabIds[0]! }), 'Enregistrer comme vue de travail…') === undefined)
    browser.dispatch({ type: 'settings/update', patch: { workViewsEnabled: true } })
    check('on again: the tile is back', await waitFor(async () => (await rect(chrome, tileSelector)) !== null))
  } finally {
    // ---- clean up: the views made here, the space, the switch, the server ----
    browser.closeOverlay()
    for (const made of state().workViews.filter((each) => !viewsBefore.includes(each.id))) browser.dispatch({ type: 'view/remove', id: made.id })
    browser.dispatch({ type: 'space/select', id: previousSpace })
    browser.dispatch({ type: 'space/delete', id: spaceId })
    browser.dispatch({ type: 'settings/update', patch: { workViewsEnabled: previousSwitch } })
    server.close()
  }
}

/** `LUCIUM_SMOKE_ONLY=work-views`: only these checks, with their own report. */
export async function runWorkViewsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeWorkViews(ctx, (name, ok, detail) => noteCheck(checks, name, ok, detail))
  } catch (error) {
    noteCheck(checks, 'smokeWorkViews ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_WORK_VIEWS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
