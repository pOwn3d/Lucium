// Engine checks for the window frame, the toolbar, the split view and the native context menus: what the bar does with the colour a page
// declares, what its buttons do (reload, copy the address, back and forward with a long press), the address giving way to the buttons in a
// narrow window, the floating sidebar, the split view (panes, focus ring, layout bar, closing a pane), the tooltip's timing and content,
// and the entries of the context menus. Layout is checked as relations (nothing covered, clipped or overlapping), never as exact sizes.
// Real mouse input (sendInputEvent) drives the buttons.
// Called from the engine smoke test: `await smokeIsoToolbar(ctx, check)`. `runIsoToolbarSmoke` is the same with its own
// report, for LUCIUM_SMOKE_ONLY=iso-toolbar (quick loop while working on this file).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { clipboard, Menu, type MenuItemConstructorOptions, type WebContentsView } from 'electron'
import { menuItems } from './shell/context-menus'
import { FLOATING_INSET, TRAFFIC_LIGHTS } from '@shared/ipc'
import { SPLIT_GAP, SPLIT_RING } from '@shared/split'
import type { SmokeContext } from './smoke'
import { noteCheck, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Rect {
  x: number
  y: number
  width: number
  height: number
}


const waitFor = waiterOf(6000, 60)

const fmt = (r: Rect | null) => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'null')
/** Whether `inner` lies inside `outer` (nothing clipped), give or take `slack` px. */
const inside = (inner: Rect | null | undefined, outer: Rect | null | undefined, slack = 1) =>
  !!inner && !!outer && inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack
/** Whether `a` ends before `b` begins on the horizontal axis (no overlap, `a` on the left). */
const leftOf = (a: Rect | null | undefined, b: Rect | null | undefined, gap = 0) => !!a && !!b && a.x + a.width + gap <= b.x + 1
/** The brightness of a CSS colour like `rgb(r, g, b)` or `rgba(r, g, b, a)`, 0 (black) to 255 (white). */
const brightness = (css: string | undefined) => {
  const [r = 0, g = 0, b = 0] = (css?.match(/[\d.]+/g) ?? []).map(Number)
  return (r + g + b) / 3
}

export async function smokeIsoToolbar(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const chrome = win.webContents

  // Pages: no colour, a white `theme-color`, a red one, a white body that declares no colour (the bar must stay dark above it),
  // two tags for the two colour schemes, and a counter of loads (a click on reload is one more).
  let reloads = 0
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    const url = req.url ?? '/'
    if (url.startsWith('/whitebody')) return res.end('<title>whitebody</title><body style="margin:0;background:#fff">no declared colour</body>')
    if (url.startsWith('/white')) return res.end('<title>white</title><meta name="theme-color" content="#ffffff"><body style="margin:0;background:#fff">white</body>')
    if (url.startsWith('/plain')) return res.end('<title>plain</title><body style="margin:0">plain</body>')
    if (url.startsWith('/color')) return res.end('<title>color</title><meta name="theme-color" content="#c8102e"><body style="margin:0;background:#c8102e">color</body>')
    if (url.startsWith('/scheme')) return res.end('<title>scheme</title><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="navy" media="(prefers-color-scheme: dark)"><body style="margin:0">scheme</body>')
    if (url.startsWith('/reload')) {
      reloads++
      return res.end(`<title>reload ${reloads}</title><body style="margin:0">reload</body>`)
    }
    res.end(`<title>page ${url}</title><body style="margin:0">${url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const evaluate = <T>(script: string, from = chrome) => from.executeJavaScript(script) as Promise<T>
  const rectOf = (selector: string, index = 0, from = chrome) =>
    evaluate<Rect | null>(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`, from)
  const rectsOf = (selector: string, from = chrome) =>
    evaluate<Rect[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })`, from)
  const styleOf = (selector: string, props: string[], index = 0, pseudo = '') =>
    evaluate<Record<string, string> | null>(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const s = getComputedStyle(el, ${JSON.stringify(pseudo || null)}); const out = {}; for (const p of ${JSON.stringify(props)}) out[p] = s.getPropertyValue(p); return out })()`)
  const barColor = async () => (await styleOf('.page-toolbar', ['background-color']))?.['background-color']
  /** What a token of the interface comes to, read where nothing tints it (on the page, not on a bar): the default bar and its glyphs are drawn with tokens, so the checks compare with them. */
  const pageToken = (token: string, property: 'background-color' | 'color' = 'background-color') =>
    evaluate<string>(`(() => { const probe = document.createElement('div'); probe.style.setProperty(${JSON.stringify(property)}, 'var(${token})'); document.body.append(probe); const value = getComputedStyle(probe).getPropertyValue(${JSON.stringify(property)}); probe.remove(); return value })()`)
  /** What a token of the bar (--tb-text, --tb-icon, --tb-icon-off, --tb-hover…) comes to inside the first bar, which is the default one while the page declares no colour. */
  const barToken = (token: string, property: 'background-color' | 'color' = 'background-color') =>
    evaluate<string>(`(() => { const probe = document.createElement('div'); probe.style.setProperty(${JSON.stringify(property)}, 'var(${token})'); document.querySelector('.page-toolbar').append(probe); const value = getComputedStyle(probe).getPropertyValue(${JSON.stringify(property)}); probe.remove(); return value })()`)
  const rectByLabel = (label: string) => rectOf(`.page-toolbar [aria-label=${JSON.stringify(label)}]`)
  const mouse = async (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => {
    chrome.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(30)
  }
  const click = async (x: number, y: number) => {
    await mouse('mouseMove', x, y)
    await mouse('mouseDown', x, y)
    await mouse('mouseUp', x, y)
    await sleep(120)
  }
  const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  const clickRect = async (r: Rect | null) => {
    if (!r) return false
    const c = centre(r)
    await click(c.x, c.y)
    return true
  }
  const moveOver = async (r: Rect | null) => {
    if (r) await mouse('mouseMove', centre(r).x, centre(r).y)
  }
  const pageViews = (): Array<{ view: WebContentsView; bounds: Rect }> =>
    win.contentView.children
      .map((v) => v as WebContentsView)
      .filter((v) => /^http:\/\/127\.0\.0\.1/.test(v.webContents.getURL()))
      .map((view) => ({ view, bounds: view.getBounds() }))
  const activeTabId = () => store.get().activeTabBySpace[store.get().activeSpaceId]!
  const activeTabState = () => store.get().tabs.find((t) => t.id === activeTabId())!
  const open = async (path: string, title: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const ok = await waitFor(() => activeTabState().url.endsWith(path) && activeTabState().title === title)
    await sleep(700)
    return ok
  }
  const recordMenus = async (run: () => Promise<void>) => {
    const real = Menu.prototype.popup
    const opened: string[][] = []
    Menu.prototype.popup = function (this: Menu) {
      opened.push(this.items.map((item) => item.label))
      return this
    } as never
    try {
      await run()
    } finally {
      Menu.prototype.popup = real
    }
    return opened
  }

  const fullUrlOn = (on: boolean) => browser.dispatch({ type: 'settings/update', patch: { fullUrlInToolbar: on } })
  const labelsOf = (items: MenuItemConstructorOptions[]) => items.map((i) => (i.type === 'separator' ? '——' : (i.label ?? '?')))
  const menuOf = (target: Parameters<typeof menuItems>[0]) => menuItems(target, browser, store, win, { headers: true })
  const press = (items: MenuItemConstructorOptions[] | undefined, label: string) => (items?.find((i) => i.label === label)?.click as (() => void) | undefined)?.()
  const itemOf = (items: MenuItemConstructorOptions[], label: string) => items.find((i) => i.label === label)

  async function smokeMenus(): Promise<void> {
    const previousSpace = store.get().activeSpaceId
    browser.dispatch({ type: 'space/create', name: 'Menus ISO', emoji: '🧪', hue: 200 })
    const spaceId = store.get().activeSpaceId
    const spaceTabs = () => store.get().tabs.filter((t) => t.spaceId === spaceId)

    // The tab menu of a space with a single tab: it offers only "Archive Tabs Below", greyed out.
    browser.dispatch({ type: 'tab/open', url: `${base}/m1`, spaceId, background: true })
    const only = spaceTabs()[0]!
    const alone = menuOf({ kind: 'tab', id: only.id })
    // The entries are all there, set in blocks: the blocks come in one order, the archiving and closing one last, and "Archive Tabs Below" is greyed out.
    check('tab menu, one tab: the blocks Ouvrir, Personnaliser, Organiser, Veille, Archiver et fermer; "Archive Tabs Below" greyed out', JSON.stringify(alone.filter((i) => i.type === 'header').map((i) => i.label)) === JSON.stringify(['Ouvrir', 'Personnaliser', 'Organiser', 'Veille', 'Archiver et fermer']) && JSON.stringify(labelsOf(alone).slice(0, 6)) === JSON.stringify(['Ouvrir', 'Ajouter une vue scindée', 'Dupliquer', 'Copier le lien', 'Partager', 'Personnaliser']) && JSON.stringify(labelsOf(alone).slice(labelsOf(alone).indexOf('Archiver l’onglet'), labelsOf(alone).indexOf('Archiver l’onglet') + 2)) === JSON.stringify(['Archiver l’onglet', 'Archiver les onglets en dessous']) && itemOf(alone, 'Archiver les onglets en dessous')?.enabled === false, labelsOf(alone).join(' | '))
    check('… with no "Archive Other Tabs" and no "Archive Tabs Above" while there is nothing to archive', !itemOf(alone, 'Archiver les autres onglets') && !itemOf(alone, 'Archiver les onglets au-dessus'))
    // A page that is loaded and silent: Mute is greyed out; once the tab is muted, the entry offers to give the sound back.
    browser.dispatch({ type: 'tab/open', url: `${base}/live`, spaceId })
    await waitFor(() => activeTabState().url.endsWith('/live') && activeTabState().title === 'page /live')
    await sleep(500)
    const live = activeTabState()
    check('tab menu: "Couper le son" is greyed out for a loaded page that makes no sound', itemOf(menuOf({ kind: 'tab', id: live.id }), 'Couper le son')?.enabled === false)
    browser.toggleMute(live.id)
    await sleep(300)
    const mutedEntry = itemOf(menuOf({ kind: 'tab', id: live.id }), 'Réactiver le son')
    check('… and it is on again, as "Réactiver le son", for a muted tab', mutedEntry?.enabled === true)
    browser.toggleMute(live.id)
    await sleep(200)
    const share = itemOf(alone, 'Partager')
    check('tab menu: "Partager" is the system\'s share submenu for the page\'s address', share?.role === 'shareMenu' && JSON.stringify(share.sharingItem?.urls) === JSON.stringify([only.url]), JSON.stringify(share))
    check('tab menu: "Couper le son" is greyed out for a page that makes no sound', itemOf(alone, 'Couper le son')?.enabled === false)
    for (const n of ['m2', 'm3']) browser.dispatch({ type: 'tab/open', url: `${base}/${n}`, spaceId, background: true })
    const all = spaceTabs()
    const [first, middle, last] = [all[0], all[1], all.at(-1)]
    const firstMenu = menuOf({ kind: 'tab', id: first!.id })
    const middleMenu = menuOf({ kind: 'tab', id: middle!.id })
    const lastMenu = menuOf({ kind: 'tab', id: last!.id })
    check('tab menu, several tabs: the archive group is "tab, others, below, above" with only what applies (first: no "above"; last: "below" greyed out)', JSON.stringify(labelsOf(firstMenu).slice(labelsOf(firstMenu).indexOf('Archiver l’onglet'), labelsOf(firstMenu).indexOf('Archiver l’onglet') + 3)) === JSON.stringify(['Archiver l’onglet', 'Archiver les autres onglets', 'Archiver les onglets en dessous']) && !itemOf(firstMenu, 'Archiver les onglets au-dessus') && JSON.stringify(labelsOf(middleMenu).slice(labelsOf(middleMenu).indexOf('Archiver l’onglet'), labelsOf(middleMenu).indexOf('Archiver l’onglet') + 4)) === JSON.stringify(['Archiver l’onglet', 'Archiver les autres onglets', 'Archiver les onglets en dessous', 'Archiver les onglets au-dessus']) && itemOf(lastMenu, 'Archiver les onglets en dessous')?.enabled === false && itemOf(lastMenu, 'Archiver les onglets au-dessus')?.enabled !== false, `${labelsOf(firstMenu).join(' | ')} // ${labelsOf(lastMenu).join(' | ')}`)

    // The space menu gets "Manage Spaces…" in front of the deletion.
    const spaceMenu = menuOf({ kind: 'space', id: spaceId })
    const spaceLabels = labelsOf(spaceMenu)
    check('space menu, in blocks: Personnaliser (Personnaliser l’espace…, name, profile), Thème, Organiser (… Manage Spaces…), Supprimer (Clear Today, Delete)', spaceLabels.filter((l) => l !== '——').slice(0, 4).join('|') === 'Personnaliser|Personnaliser l’espace…|Renommer l’espace…|Définir le profil' && spaceLabels.slice(-3).join('|') === 'Supprimer|Vider les onglets du jour|Supprimer l’espace…' && spaceLabels.includes('Gérer les espaces…'), spaceLabels.join(' | '))
    press(spaceMenu, 'Gérer les espaces…')
    check('… and "Gérer les espaces…" opens the spaces panel', (browser.currentOverlay() as { panel?: string } | null)?.panel === 'spaces')
    browser.closeOverlay()

    // The folder menu.
    browser.dispatch({ type: 'folder/create', name: 'Docs', spaceId })
    const folder = store.get().folders.find((f) => f.spaceId === spaceId && f.name === 'Docs')!
    for (const t of [first!, middle!]) browser.dispatch({ type: 'tab/move', id: t.id, toIndex: 0, pinned: true, folderId: folder.id })
    const folderMenu = menuOf({ kind: 'folder', id: folder.id })
    // The menu is in titled blocks now (Créer et copier, Personnaliser, Organiser, Supprimer), and has the entries of the folder that is never woken and put at the bottom of the list.
    check('folder menu, in blocks: create and copy (sub-folder, turn into space, copy links, Markdown links), customise (rename), organise (duplicate, bottom of the list, never woken, archive), delete', JSON.stringify(labelsOf(folderMenu)) === JSON.stringify(['Créer et copier', 'Nouveau sous-dossier', frenchSpaces('Transformer « Docs » en espace'), 'Copier tous les liens', 'Copier tous les liens en Markdown', 'Personnaliser', 'Renommer…', 'Organiser', 'Dupliquer', 'Mettre au début d’Aujourd’hui', 'Mettre en bas de la liste', 'Ne jamais réveiller automatiquement', 'Archiver le dossier', 'Supprimer', 'Supprimer le dossier (garder les onglets)']), labelsOf(folderMenu).join(' | '))
    await clipboard.writeText('')
    press(folderMenu, 'Copier tous les liens')
    check('"Copier tous les liens" puts the folder\'s addresses on the clipboard, one per line', await waitFor(async () => (await clipboard.readText()).split('\n').length === 2 && (await clipboard.readText()).includes('/m1')), await clipboard.readText())
    // The menu of a folder is opened on its row: the row of the folder made above is waited for in the sidebar (the menu renames the row it finds there).
    const folderRow = await waitFor(() => evaluate<boolean>(`!!document.querySelector('.folder-title[data-id=${JSON.stringify(folder.id)}]')`), 3000)
    press(folderMenu, 'Renommer…')
    check('"Renommer…" puts the folder\'s row in editing, in place', folderRow && (await waitFor(async () => (await evaluate<boolean>(`!!document.querySelector('.folder-title.editing input, .folder-title.editing')`)), 3000)), `row ${folderRow}`)
    await evaluate(`document.querySelector('.folder-title.editing input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    const spacesBefore = store.get().spaces.length
    press(folderMenu, frenchSpaces('Transformer « Docs » en espace'))
    check('"Transformer « Docs » en espace" makes a space of it: the folder goes, its tabs are pinned in the new space', store.get().spaces.length === spacesBefore + 1 && store.get().spaces.at(-1)?.name === 'Docs' && !store.get().folders.some((f) => f.id === folder.id) && store.get().tabs.filter((t) => t.spaceId === store.get().spaces.at(-1)!.id && t.pinned).length === 2, JSON.stringify(store.get().spaces.map((s) => s.name)))

    // The favourite's menu.
    browser.dispatch({ type: 'favorite/add', url: `${base}/fav`, title: 'Favori ISO' })
    const favorite = store.get().favorites.find((f) => f.url.endsWith('/fav'))!
    browser.dispatch({ type: 'space/select', id: spaceId })
    browser.dispatch({ type: 'tab/select', id: last!.id })
    const favMenu = menuOf({ kind: 'favorite', id: favorite.id })
    check('favourite menu, in blocks: open (beside, mini window), copy and share, customise (rename, mute greyed out, edit the pinned page ▸), organise (move up, down, to ▸, remove), remove from the favourites', JSON.stringify(labelsOf(favMenu)) === JSON.stringify(['Ouvrir', 'Ouvrir en vue scindée', 'Ouvrir dans une mini-fenêtre', 'Copier le lien', 'Partager', 'Personnaliser', 'Renommer…', 'Modifier la page épinglée', 'Couper le son', 'Organiser', 'Déplacer vers le haut', 'Déplacer vers le bas', 'Déplacer vers', 'Retirer', 'Retirer des favoris']) && itemOf(favMenu, 'Couper le son')?.enabled === false, labelsOf(favMenu).join(' | '))
    const pinnedPage = (itemOf(favMenu, 'Modifier la page épinglée')?.submenu ?? []) as MenuItemConstructorOptions[]
    check('favourite menu: "Edit the pinned page" offers going back to the pinned address and replacing it with the current page', JSON.stringify(labelsOf(pinnedPage)) === JSON.stringify(['Revenir à l’adresse épinglée', 'Remplacer l’adresse épinglée par la page actuelle']), labelsOf(pinnedPage).join(' | '))
    press(pinnedPage, 'Remplacer l’adresse épinglée par la page actuelle')
    check('… "Remplacer l’adresse épinglée par la page actuelle" gives the favourite the address of the page on screen', store.get().favorites.find((f) => f.id === favorite.id)?.url === last!.url, JSON.stringify(store.get().favorites.map((f) => f.url)))
    press(favMenu, 'Renommer…')
    check('… "Renommer…" opens the favourite\'s name editor', JSON.stringify(browser.currentOverlay()) === JSON.stringify({ panel: 'favorite', favoriteId: favorite.id }), JSON.stringify(browser.currentOverlay()))
    browser.closeOverlay()
    const splitsBefore = store.get().splits.length
    press(menuOf({ kind: 'favorite', id: favorite.id }), 'Ouvrir en vue scindée')
    check('… "Ouvrir en vue scindée" opens it beside the page on screen', store.get().splits.length === splitsBefore + 1)
    const moveTo = (itemOf(menuOf({ kind: 'favorite', id: favorite.id }), 'Déplacer vers')?.submenu ?? []) as MenuItemConstructorOptions[]
    const otherSpace = store.get().spaces.find((sp) => sp.id !== spaceId)!
    press(moveTo, `${otherSpace.emoji} ${otherSpace.name}`)
    check('… "Déplacer vers" a space makes the tile a pinned tab of it', !store.get().favorites.some((f) => f.id === favorite.id) && store.get().tabs.some((t) => t.spaceId === otherSpace.id && t.pinned && t.url === last!.url), JSON.stringify(store.get().favorites))

    // The same menus from a real right click on the sidebar's own elements (the pointer, not a call into the menu builder).
    browser.dispatch({ type: 'space/select', id: spaceId })
    for (const sp of [...store.get().splits]) browser.dispatch({ type: 'split/remove', tabId: sp.tabIds[0]! })
    browser.dispatch({ type: 'tab/open', url: `${base}/rc-tab`, spaceId, background: true })
    browser.dispatch({ type: 'folder/create', name: 'RC', spaceId })
    browser.dispatch({ type: 'favorite/add', url: `${base}/rc`, title: 'RC' })
    await sleep(500)
    const rightClick = async (selector: string) => {
      const r = await rectOf(selector)
      if (!r) return null
      const c = centre(r)
      const opened = await recordMenus(async () => {
        await mouse('mouseMove', c.x, c.y)
        chrome.sendInputEvent({ type: 'mouseDown', x: Math.round(c.x), y: Math.round(c.y), button: 'right', clickCount: 1 })
        await sleep(40)
        chrome.sendInputEvent({ type: 'mouseUp', x: Math.round(c.x), y: Math.round(c.y), button: 'right', clickCount: 1 })
        await sleep(500)
      })
      return opened[0] ?? null
    }
    const tabClick = await rightClick('.tab')
    check('a real right click on a tab row opens the tab menu (copy, share …)', !!tabClick && tabClick.includes('Copier le lien') && tabClick.includes('Partager') && tabClick.includes('Archiver l’onglet'), JSON.stringify(tabClick))
    const folderClick = await rightClick('.folder-title')
    check('a real right click on a folder row opens the folder menu', !!folderClick && folderClick.includes('Nouveau sous-dossier') && folderClick.some((l) => l.startsWith('Transformer')), JSON.stringify(folderClick))
    const favClick = await rightClick('.favorite')
    check('a real right click on a favourite tile opens the favourite menu', !!favClick && favClick.includes('Copier le lien') && favClick.includes('Partager') && favClick.includes('Retirer des favoris'), JSON.stringify(favClick))
    for (const f of store.get().favorites.filter((x) => x.url.endsWith('/rc'))) browser.dispatch({ type: 'favorite/remove', id: f.id })

    // Clean up: the spaces made here go, and the space that was open comes back.
    for (const sp of store.get().spaces.filter((x) => x.name === 'Menus ISO' || x.name === 'Docs')) browser.dispatch({ type: 'space/delete', id: sp.id })
    browser.dispatch({ type: 'space/select', id: previousSpace })
    await sleep(300)
  }

  // View › Appearance › Dark (the application keeps nativeTheme in step with this setting: setting nativeTheme itself would be undone).
  const appearanceBefore = store.get().settings.interfaceAppearance
  browser.dispatch({ type: 'settings/update', patch: { interfaceAppearance: 'dark' } })
  // The « Contraste de la page » button widens the right group of every web page and crowds the address: it is put away for this run.
  const readableButtonBefore = store.get().settings.readableToolbarButton
  browser.dispatch({ type: 'settings/update', patch: { readableToolbarButton: false } })
  win.setSize(1680, 888)
  win.showInactive()
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, showToolbar: true, fullUrlInToolbar: false } })
  await sleep(600)
  const sidebarWidth = store.get().settings.sidebarWidth

  // ---- 1. the bar of a page that declares no colour: the default bar, the page right below it ----
  check('plain page opened', await open('/plain', 'plain'))
  const bar = await rectOf('.page-toolbar')
  const barStyle = await styleOf('.page-toolbar', ['background-color'])
  check('toolbar: the default dark bar (the --surface-3 colour) above a page that declares no colour', barStyle?.['background-color'] === (await pageToken('--surface-3')), JSON.stringify({ barStyle, token: await pageToken('--surface-3') }))
  const stage = pageViews()[0]?.bounds ?? null
  check('page: starts right under the bar, not covered by it, and as wide as the bar', !!bar && !!stage && Math.abs(stage.y - (bar.y + bar.height)) <= 1 && Math.abs(stage.x - bar.x) <= 1 && Math.abs(stage.width - bar.width) <= 1, `${fmt(bar)} | ${fmt(stage)}`)

  const back = await rectByLabel('Précédent')
  const forward = await rectByLabel('Suivant')
  const reload = await rectByLabel('Actualiser')
  check('toolbar: back, forward and reload are in the bar, in this order, without overlapping', inside(back, bar) && inside(forward, bar) && inside(reload, bar) && leftOf(back, forward) && leftOf(forward, reload), `${fmt(back)} | ${fmt(forward)} | ${fmt(reload)}`)
  const control = await rectByLabel('Infos et réglages du site')
  const splitButton = await rectByLabel('Ajouter une vue scindée')
  check('toolbar: the control centre and the split button are in the bar, in this order, without overlapping', inside(control, bar) && inside(splitButton, bar) && leftOf(control, splitButton), `${fmt(control)} | ${fmt(splitButton)}`)
  const link = await rectByLabel('Copier l’adresse')
  const urlText = await rectOf('.tb-host')
  check('toolbar: the link glyph comes right before the address text, both inside the bar', inside(link, bar) && inside(urlText, bar) && leftOf(link, urlText), `${fmt(link)} | ${fmt(urlText)}`)
  const disabled = await styleOf('.page-toolbar [aria-label="Précédent"]', ['color'])
  const enabled = await styleOf('.page-toolbar [aria-label="Actualiser"]', ['color'])
  check('toolbar: a button that cannot act is drawn in the muted glyph colour (--tb-icon-off), an active one in the normal glyph colour (--tb-icon)', disabled?.['color'] === (await barToken('--tb-icon-off', 'color')) && enabled?.['color'] === (await barToken('--tb-icon', 'color')), JSON.stringify({ disabled, enabled, off: await barToken('--tb-icon-off', 'color'), on: await barToken('--tb-icon', 'color') }))

  // ---- 2. the bar takes the colour a page DECLARES, and only that ----
  check('white page opened', await open('/white', 'white'))
  const whiteBar = await barColor()
  const whiteGlyph = await styleOf('.page-toolbar [aria-label="Actualiser"]', ['color'])
  check('a page with theme-color #ffffff: a white bar, with glyphs darker than the bar', whiteBar === 'rgb(255, 255, 255)' && !!whiteGlyph && brightness(whiteGlyph['color']) < brightness(whiteBar), JSON.stringify({ whiteBar, whiteGlyph }))
  const whiteToolbar = await rectOf('.page-toolbar')
  const whiteStage = pageViews().find((p) => p.view.webContents.getURL().endsWith('/white'))?.bounds ?? null
  check('… and the page is not covered by the bar or its line', !!whiteToolbar && !!whiteStage && whiteStage.y >= whiteToolbar.y + whiteToolbar.height - 1, `${fmt(whiteToolbar)} | ${fmt(whiteStage)}`)
  check('red page opened', await open('/color', 'color'))
  const redGlyph = await styleOf('.page-toolbar [aria-label="Actualiser"]', ['color'])
  check('a page with theme-color #c8102e: a red bar, with glyphs lighter than the bar', (await barColor()) === 'rgb(200, 16, 46)' && !!redGlyph && brightness(redGlyph['color']) > brightness('rgb(200, 16, 46)'), JSON.stringify({ redGlyph }))
  check('a white page that declares no colour keeps the default dark bar (--surface-3 above a white page)', (await open('/whitebody', 'whitebody')) && (await barColor()) === (await pageToken('--surface-3')), `${await barColor()} ${JSON.stringify(Object.entries(browser.snapshot().runtime.tabs).map(([id, t]) => [id.slice(0, 4), t.color]))} active ${activeTabId().slice(0, 4)}`)
  check('two theme-color tags, one per colour scheme: the one of the window\'s scheme wins (dark: navy)', (await open('/scheme', 'scheme')) && (await waitFor(async () => (await barColor()) === 'rgb(0, 0, 128)', 2000)), await barColor())

  // ---- 2b. narrower windows: the sidebar keeps its width, the card gives way, and the address gives way to the buttons ----
  await open('/plain', 'plain')
  fullUrlOn(true)
  browser.submitUrl(`${base}/a-very/long/path/that/goes/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on`, 'current')
  await waitFor(() => activeTabState().url.includes('a-very'))
  await sleep(600)
  win.setSize(900, 600)
  await sleep(700)
  const narrowView = async () => ({
    bar: await rectOf('.page-toolbar'),
    link: await rectByLabel('Copier l’adresse'),
    text: await rectOf('.tb-url'),
    split: await rectByLabel('Ajouter une vue scindée'),
    left: await rectOf('.tb-left'),
    right: await rectOf('.tb-right'),
    icons: await rectOf('.page-toolbar browser-action-list')
  })
  // The extensions loaded for the run (the engine test loads four probes) put their icons in the right group, and the address gives way to
  // them: that is the behaviour, but how many icons there are depends on the environment. So the layout is checked twice: as it is here,
  // whatever the number of icons, then with the icons out of the layout.
  const crowded = await narrowView()
  check('900 px wide, with the extension icons of this run: the address sits between the two groups of buttons', !!crowded.bar && !!crowded.link && !!crowded.text && leftOf(crowded.left, crowded.link, 6) && leftOf(crowded.text, crowded.right, 6), JSON.stringify(crowded))
  await evaluate(`document.querySelectorAll('.page-toolbar browser-action-list').forEach((el) => { el.style.display = 'none' })`)
  await sleep(500)
  const narrow = await narrowView()
  const { bar: narrowBar, link: narrowLink, text: narrowText, split: narrowRight } = narrow
  check('900 px wide: the sidebar keeps its width, the bar (the card) gives way and stays inside the window', !!narrowBar && !!bar && Math.abs(narrowBar.x - bar.x) <= 0.5 && narrowBar.width < bar.width && narrowBar.x + narrowBar.width <= 900 + 0.5, JSON.stringify({ narrowBar, wide: bar }))
  check('900 px wide: the address starts after the buttons on the left and ends before the buttons on the right', leftOf(narrow.left, narrowLink) && leftOf(narrowText, narrow.right), JSON.stringify(narrow))
  check('900 px wide: the text is cut with an ellipsis instead of running under a button', (await evaluate<boolean>(`(() => { const el = document.querySelector('.tb-rest'); return !!el && el.scrollWidth > el.clientWidth })()`)))
  check('900 px wide: the split button stays inside the bar', inside(narrowRight, narrowBar), JSON.stringify({ narrowRight, narrowBar }))
  await evaluate(`document.querySelectorAll('.page-toolbar browser-action-list').forEach((el) => { el.style.display = '' })`)
  win.setSize(1680, 888)
  fullUrlOn(false)
  await sleep(700)

  // ---- 3. the buttons, with the real mouse ----
  await open('/plain', 'plain')
  await moveOver(await rectByLabel('Actualiser'))
  await sleep(150)
  const hovered = await styleOf('.page-toolbar [aria-label="Actualiser"]', ['background-color'])
  check('hovering a button fills it with the hover colour of the bar (--tb-hover)', hovered?.['background-color'] === (await barToken('--tb-hover')), JSON.stringify({ hovered, token: await barToken('--tb-hover') }))
  await open('/white', 'white')
  // The pointer comes from off the button again: the bar of the new page may have drawn the button anew under a pointer that did not move.
  const reloadButton = await rectByLabel('Actualiser')
  if (reloadButton) await mouse('mouseMove', centre(reloadButton).x, centre(reloadButton).y + 60)
  await sleep(100)
  await moveOver(reloadButton)
  await sleep(150)
  const whiteHovered = await styleOf('.page-toolbar [aria-label="Actualiser"]', ['background-color'])
  check('… and it is filled on a white bar too', !!whiteHovered && whiteHovered['background-color'] !== 'rgba(0, 0, 0, 0)' && whiteHovered['background-color'] !== 'transparent', JSON.stringify(whiteHovered))

  await open('/reload', 'reload 1')
  const before = reloads
  await clickRect(await rectByLabel('Actualiser'))
  check('a real click on reload loads the page again', await waitFor(() => reloads === before + 1), `${reloads} loads, expected ${before + 1}`)

  await clipboard.writeText('')
  await clickRect(await rectByLabel('Copier l’adresse'))
  check('a click on the link glyph copies the page address', await waitFor(async () => (await clipboard.readText()).endsWith('/reload')), await clipboard.readText())

  await clickRect(await rectOf('.tb-url'))
  check('a click on the address opens the command bar over the window', await waitFor(() => win.contentView.children.includes(ctx.overlayView), 2000))
  browser.closeOverlay()
  await sleep(200)

  // ---- 4. back and forward: a click goes, a long press lists the history without going ----
  await open('/one', 'page /one')
  for (const path of ['/two', '/three', '/four']) {
    browser.submitUrl(`${base}${path}`, 'current')
    await waitFor(() => activeTabState().url.endsWith(path))
    await sleep(500)
  }
  const iconOn = await barToken('--tb-icon', 'color')
  await waitFor(async () => (await styleOf('.page-toolbar [aria-label="Précédent"]', ['color']))?.['color'] === iconOn, 2000)
  check('back is enabled once the tab has a history', (await styleOf('.page-toolbar [aria-label="Précédent"]', ['color']))?.['color'] === iconOn)
  const longPress = await recordMenus(async () => {
    const c = centre((await rectByLabel('Précédent'))!)
    await mouse('mouseMove', c.x, c.y)
    await mouse('mouseDown', c.x, c.y)
    await sleep(750)
    await mouse('mouseUp', c.x, c.y)
    await sleep(300)
  })
  check('a long press on back lists the pages of the tab', longPress.length === 1 && longPress[0]!.length === 3, JSON.stringify(longPress))
  check('… and releasing it is not a click: the page did not go back', activeTabState().url.endsWith('/four'), activeTabState().url)
  await clickRect(await rectByLabel('Précédent'))
  check('a short click on back goes back', await waitFor(() => activeTabState().url.endsWith('/three')), activeTabState().url)
  await clickRect(await rectByLabel('Suivant'))
  check('a click on forward goes forward again', await waitFor(() => activeTabState().url.endsWith('/four')), activeTabState().url)
  const rightClick = await recordMenus(async () => {
    await evaluate(`document.querySelector('.page-toolbar [aria-label="Précédent"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
    await sleep(300)
  })
  check('a right click on back lists the history too', rightClick.length === 1 && rightClick[0]!.length === 3, JSON.stringify(rightClick))

  // ---- 5. the sidebar hidden: the bar spans the card, the sidebar button comes first, the traffic lights go ----
  const darwin = process.platform === 'darwin'
  if (darwin) check('traffic lights: shown with the sidebar, at their rest place', browser.trafficLights().visible === true && browser.trafficLights().position?.x === TRAFFIC_LIGHTS.x && browser.trafficLights().position?.y === TRAFFIC_LIGHTS.y, JSON.stringify(browser.trafficLights().position))
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
  await sleep(700)
  const hiddenBar = await rectOf('.page-toolbar')
  const sidebarButton = await rectByLabel('Afficher la barre latérale')
  const hiddenBack = await rectByLabel('Précédent')
  check('sidebar hidden: the bar takes the room of the sidebar, and its sidebar button comes first, before back', !!hiddenBar && !!bar && hiddenBar.x < bar.x && hiddenBar.width > bar.width && inside(sidebarButton, hiddenBar) && inside(hiddenBack, hiddenBar) && leftOf(sidebarButton, hiddenBack), `${fmt(hiddenBar)} | ${fmt(sidebarButton)} | ${fmt(hiddenBack)}`)
  if (darwin) check('sidebar hidden: the traffic lights are hidden too (the bar\'s sidebar button takes their place)', browser.trafficLights().visible === false)
  const hiddenStage = pageViews()[0]?.bounds ?? null

  // The pointer at the very left edge brings the floating sidebar, which does not move the card; leaving it takes it away.
  await mouse('mouseMove', 1, 300)
  check('the pointer at the left edge shows the floating sidebar', await waitFor(() => browser.isFloatingSidebarShown(), 3000))
  await sleep(500)
  const floatView = win.contentView.children.map((v) => v as WebContentsView).find((v) => v.webContents.getURL().includes('#float'))
  const floatBounds = floatView?.getBounds() ?? null
  check('floating sidebar: a view from the window\'s top-left corner, over its whole height, wide enough for the panel', !!floatBounds && floatBounds.x === 0 && floatBounds.y === 0 && floatBounds.height === win.getContentSize()[1] && floatBounds.width >= sidebarWidth, fmt(floatBounds))
  const card = floatView ? await rectOf('.floating-shell .sidebar', 0, floatView.webContents) : null
  check('floating sidebar: the panel is drawn inside its view, as wide as the sidebar', !!card && !!floatBounds && inside(card, { x: 0, y: 0, width: floatBounds.width, height: floatBounds.height }) && Math.abs(card.width - sidebarWidth) <= 1, `${fmt(card)} in ${fmt(floatBounds)}`)
  const floatingStage = pageViews()[0]?.bounds ?? null
  check('floating sidebar: it covers the page, it does not push it', !!floatingStage && !!hiddenStage && floatingStage.x === hiddenStage.x && floatingStage.width === hiddenStage.width, `${fmt(floatingStage)} | ${fmt(hiddenStage)}`)
  if (darwin) check('floating sidebar: the traffic lights come back, shifted with the panel by its inset', browser.trafficLights().visible === true && browser.trafficLights().position?.x === TRAFFIC_LIGHTS.x + FLOATING_INSET && browser.trafficLights().position?.y === TRAFFIC_LIGHTS.y + FLOATING_INSET, JSON.stringify(browser.trafficLights().position))
  const slides = floatView ? await waitFor(async () => (await evaluate<string>(`getComputedStyle(document.querySelector('.floating-shell .sidebar')).animationName`, floatView.webContents)) === 'float-in', 600) : false
  check('floating sidebar: it slides in (a keyframe animation plays on the panel)', slides)
  // The pointer leaves the panel's own surface (the floating sidebar is a view of its own, which hears its own pointer).
  floatView?.webContents.sendInputEvent({ type: 'mouseMove', x: 100, y: 300 })
  await sleep(100)
  floatView?.webContents.sendInputEvent({ type: 'mouseLeave', x: 900, y: 400 })
  check('leaving the panel takes it away within a few tenths of a second', await waitFor(() => !browser.isFloatingSidebarShown(), 2500))
  if (darwin) check('… and the traffic lights go with it', await waitFor(() => browser.trafficLights().visible === false, 1000))
  // Nothing floats now: the hidden copy of the sidebar is not drawn (it would draw every tab row again at each snapshot, for nobody to see).
  const nothingDrawn = floatView ? await waitFor(async () => (await evaluate<boolean>(`document.querySelector('.floating-shell .sidebar') === null`, floatView.webContents)) === true, 1500) : false
  check('the floating sidebar is not drawn while nothing floats', nothingDrawn)
  // Showing the real sidebar while the floating one is out ends the floating one for good: hiding it again does not bring it back by itself.
  // The pointer must be away from the edge by then: a pointer resting on the edge (it counts as asking) brings the panel back as soon as the
  // sidebar is hidden, which is the right thing for it to do and is not what is checked here.
  await mouse('mouseMove', 900, 400)
  await sleep(100)
  await mouse('mouseMove', 1, 300)
  check('(again) the pointer at the left edge shows the floating sidebar', await waitFor(() => browser.isFloatingSidebarShown(), 3000))
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
  await sleep(500)
  await mouse('mouseMove', 900, 400)
  await sleep(300)
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
  // A fixed wait, for want of a witness: the floating sidebar comes when the pointer asks for it, and nothing is said when nobody asked.
  await sleep(700)
  check('showing the sidebar ends the floating one: hiding it again shows nothing until the pointer asks', !browser.isFloatingSidebarShown() && (!darwin || browser.trafficLights().visible === false))
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
  await sleep(600)
  if (darwin) check('sidebar shown again: the traffic lights are back at their rest place', browser.trafficLights().visible === true && browser.trafficLights().position?.x === TRAFFIC_LIGHTS.x)

  // ---- 6. the split view ----
  await open('/plain', 'plain')
  const first = activeTabState()
  await open('/white', 'white')
  const second = activeTabState()
  browser.dispatch({ type: 'split/create', tabId: first.id, withTabId: second.id })
  await waitFor(() => store.get().splits.length === 1)
  await sleep(1000)
  const bars = await rectsOf('.page-toolbar')
  const [contentWidth = 0, contentHeight = 0] = win.getContentSize()
  check('split view: two bars side by side in one row, with room for the divider between them', bars.length === 2 && Math.abs(bars[0]!.y - bars[1]!.y) <= 0.5 && leftOf(bars[0], bars[1], SPLIT_GAP), JSON.stringify(bars))
  const visibleRings = () => evaluate<Rect[]>(`[...document.querySelectorAll('.pane-ring')].filter((el) => el.style.visibility === 'visible').map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })`)
  const rings = await visibleRings()
  const ringStyle = await styleOf('.pane-ring', ['border-top-color'])
  check('split view: one ring, wrapping the focused pane\'s bar and page and no other bar, in the focus colour (--focus)', rings.length === 1 && bars.filter((b) => inside(b, rings[0])).length === 1 && ringStyle?.['border-top-color'] === (await pageToken('--focus', 'color')), JSON.stringify({ rings, ringStyle }))
  // The handle in the gap between two panes is visible at rest, not a thin grip too small to see.
  const gripStyle = await styleOf('.divider', ['background-color'], 0, '::after')
  const gripBox = await rectOf('.divider')
  check('split view: the handle between the panes is visible at rest (not transparent, not the old #37393c)', !!gripStyle && !!gripBox && gripStyle['background-color'] !== 'rgb(55, 57, 60)' && gripStyle['background-color'] !== 'rgba(0, 0, 0, 0)', JSON.stringify({ gripStyle, gripBox }))
  const barBox = await rectOf('.split-bar')
  const barButtons = await evaluate<string[]>(`[...document.querySelectorAll('.split-bar button')].map((b) => b.textContent.trim())`)
  check('split view: the layout bar is inside the window, with 30 / 70, 50 / 50, 70 / 30 and Échanger (no "Défilement synchronisé" while the setting is off)', inside(barBox, { x: 0, y: 0, width: contentWidth, height: contentHeight }) && barButtons.join('|') === '30 / 70|50 / 50|70 / 30|Échanger', JSON.stringify({ barBox, barButtons }))
  const ringed = rings[0]!
  const views = pageViews().map((p) => p.bounds).sort((a, b) => a.x - b.x)
  const focusedView = views.find((v) => v.x >= ringed.x && v.x < ringed.x + ringed.width)
  check('split view: the focused page is inset by the ring (by its width on the sides and at the bottom) so that it shows around the page, and starts right under its bar', !!focusedView && focusedView.x === ringed.x + SPLIT_RING && focusedView.width === ringed.width - SPLIT_RING * 2 && focusedView.y === bars[0]!.y + bars[0]!.height && focusedView.y + focusedView.height === ringed.y + ringed.height - SPLIT_RING, JSON.stringify({ ringed, views }))
  const unfocused = views.find((v) => v !== focusedView)
  check('split view: the other page fills its pane under its bar and ends above the layout bar', !!unfocused && !!barBox && unfocused.y === bars[0]!.y + bars[0]!.height && unfocused.y + unfocused.height <= barBox.y + 1, JSON.stringify({ views, barBox }))
  const barColors = await evaluate<string[]>(`[...document.querySelectorAll('.page-toolbar')].map((el) => getComputedStyle(el).backgroundColor)`)
  const dark = await pageToken('--surface-3')
  check('split view: the strips are dark whatever the page (--surface-3): a page declaring white does not turn them white', barColors.every((c) => c === dark), JSON.stringify({ barColors, dark }))
  const strips = await evaluate<string[][]>(`[...document.querySelectorAll('.page-toolbar')].map((el) => [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')))`)
  const focusedStrip = strips.findIndex((labels) => labels.includes('Infos et réglages du site'))
  const otherStrip = focusedStrip === 0 ? 1 : 0
  check('split view: the focused strip carries the control centre and the split options; the other one the address and ✕ only (both have back, forward, reload)', focusedStrip >= 0 && strips[focusedStrip]!.includes('Options de la vue scindée') && !strips[otherStrip]!.includes('Options de la vue scindée') && !strips[otherStrip]!.includes('Infos et réglages du site') && strips[otherStrip]!.includes('Précédent') && strips[otherStrip]!.includes('Fermer ce volet'), JSON.stringify(strips))

  // Stacked instead of side by side: each pane has its bar right above its own page.
  const splitId = store.get().splits[0]!.id
  browser.dispatch({ type: 'split/orientation', id: splitId, orientation: 'vertical' })
  await sleep(1000)
  const stackedBars = (await rectsOf('.page-toolbar')).sort((a, b) => a.y - b.y)
  const stackedPages = pageViews().map((p) => p.bounds).sort((a, b) => a.y - b.y)
  const stackedLayoutBar = await rectOf('.split-bar')
  check('split view, stacked: two bars of the same width, and each page right under its own bar, clear of the next bar', stackedBars.length === 2 && stackedPages.length === 2 && Math.abs(stackedBars[0]!.width - stackedBars[1]!.width) <= 1 && stackedPages[0]!.y === stackedBars[0]!.y + stackedBars[0]!.height && stackedPages[1]!.y === stackedBars[1]!.y + stackedBars[1]!.height && stackedBars[1]!.y >= stackedPages[0]!.y + stackedPages[0]!.height + SPLIT_GAP, JSON.stringify({ stackedBars, stackedPages }))
  check('split view, stacked: the last page ends above the layout bar', !!stackedLayoutBar && stackedPages.length === 2 && stackedPages[1]!.y + stackedPages[1]!.height <= stackedLayoutBar.y + 1, JSON.stringify({ stackedPages, stackedLayoutBar }))
  browser.dispatch({ type: 'split/orientation', id: splitId, orientation: 'horizontal' })
  await sleep(800)

  // A press on the other pane's strip makes it the focused one; ✕ closes a pane.
  const otherBar = bars[otherStrip]!
  const focusBefore = activeTabId()
  await click(otherBar.x + otherBar.width / 2, otherBar.y + 4)
  check('split view: a click on the other strip focuses its pane', await waitFor(() => activeTabId() !== focusBefore), activeTabId())
  const closeRects = await rectsOf('.page-toolbar [aria-label="Fermer ce volet"]')
  const barsNow = await rectsOf('.page-toolbar')
  check('split view: ✕ sits inside each strip', closeRects.length === 2 && barsNow.length === 2 && closeRects.every((r) => barsNow.some((b) => inside(r, b))), JSON.stringify({ closeRects, barsNow }))
  await clickRect(closeRects[1]!)
  check('split view: a click on ✕ closes that pane and leaves a single page', await waitFor(() => store.get().splits.length === 0), JSON.stringify(store.get().splits))
  check('… with no ring left around it', await waitFor(async () => (await visibleRings()).length === 0), JSON.stringify(await visibleRings()))
  await sleep(500)

  // ---- 7. the tooltip: a capsule after the pointer rests ----
  await open('/plain', 'plain')
  const reloadAgain = await rectByLabel('Actualiser')
  browser.showTooltip(null)
  await sleep(200)
  await moveOver(reloadAgain)
  const restedAt = Date.now()
  const capsule = await waitFor(() => browser.tooltipWindowForTest()?.isVisible() === true, 8000)
  check('tooltip: a capsule appears when the pointer rests on a button (after about a second)', capsule && Date.now() - restedAt >= 900, `${Date.now() - restedAt} ms; window ${browser.tooltipWindowForTest() ? 'made' : 'none'}`)
  const tip = browser.tooltipWindowForTest()
  check('tooltip: the "Actualiser" button and the window of the capsule are there, for the checks of its text and its place', !!tip && !!reloadAgain)
  if (tip && reloadAgain) {
    const tipText = await tip.webContents.executeJavaScript(`document.getElementById('text').textContent + '|' + [...document.querySelectorAll('.key')].map((k) => k.textContent).join('')`)
    check('tooltip: it names the action and shows the shortcut as keycaps', tipText === 'Actualiser la page|⌘R', String(tipText))
    const content = win.getContentBounds()
    const tipBounds = tip.getBounds()
    const capsuleBox = await tip.webContents.executeJavaScript(`(() => { const r = document.getElementById('tip').getBoundingClientRect(); return { x: r.x, y: r.y } })()`)
    const pointer = centre(reloadAgain)
    check('tooltip: right of and below the pointer, so it does not cover what the pointer rests on', tipBounds.x + capsuleBox.x >= content.x + pointer.x && tipBounds.y + capsuleBox.y >= content.y + pointer.y, `${JSON.stringify(tipBounds)} capsule ${JSON.stringify(capsuleBox)} pointer ${JSON.stringify(pointer)}`)
  }
  await mouse('mouseMove', 900, 500)
  check('tooltip: it goes when the pointer leaves', await waitFor(() => browser.tooltipWindowForTest()?.isVisible() === false, 1500))
  if (reloadAgain) {
    await moveOver(reloadAgain)
    await sleep(300)
    await mouse('mouseDown', centre(reloadAgain).x, centre(reloadAgain).y)
    await mouse('mouseUp', centre(reloadAgain).x, centre(reloadAgain).y)
    // A fixed wait, for want of a witness: a tooltip shows after a second of hovering (renderer/tooltip.ts, `TOOLTIP.delayMs`), and the timer a
    // click cancels says nothing; the wait is longer than that delay.
    await sleep(1400)
    check('tooltip: a press on the button cancels it (nothing appears after a click)', browser.tooltipWindowForTest()?.isVisible() !== true)
  }

  // ---- 8. the context menus, entry for entry ----
  await smokeMenus()

  server.close()
  browser.dispatch({ type: 'settings/update', patch: { interfaceAppearance: appearanceBefore, readableToolbarButton: readableButtonBefore } })
  await sleep(400)
}

/** The same checks with their own report, for LUCIUM_SMOKE_ONLY=iso-toolbar. */
export async function runIsoToolbarSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const verbose = process.env['LUCIUM_ISO_VERBOSE'] === '1'
    await smokeIsoToolbar(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`ISO-TOOLBAR ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeIsoToolbar ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ISO_TOOLBAR ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
