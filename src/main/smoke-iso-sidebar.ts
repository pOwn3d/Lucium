// Engine checks for the sidebar, with a real mouse and keyboard: the rows and their buttons, renaming in place, the folders, the favourites,
// the footer, the split row, the hover card, the sound and developer badges, hiding the sidebar and the reduced-motion setting.
// Called from the engine smoke test: `await smokeIsoSidebar(ctx, check)`. `LUCIUM_SMOKE_ONLY=iso-sidebar` runs only this file.
//
// The main window is resized to a fixed size first (1680 x 888), so the layout does not depend on the screen the test runs on.
// Real mouse and keyboard input (sendInputEvent) drives the clicks, the hover and the typing. The native drag session of the operating system
// cannot be driven by synthetic input: the drag and drop events themselves are dispatched on the real elements (smoke-sidebar.ts does the same).

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { screen, systemPreferences } from 'electron'
import { prefersReducedMotion } from './shell/motion'
import { smokeSidebar } from './smoke-sidebar'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(5000, 40)

/** The width the sidebar is set to for the run. */
const SIDEBAR_WIDTH = 323

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A small coloured square: a favicon that shows up in a picture and has no network behind it. */
const favicon = (fill: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="${fill}"/><circle cx="16" cy="16" r="7" fill="#fff" opacity=".85"/></svg>`)}`

/** Within `tolerance` px (rounding, and sub-pixel layout). */
const near = (actual: number | undefined, expected: number, tolerance = 0.6) => actual !== undefined && Math.abs(actual - expected) <= tolerance
const fmt = (box: Box | null) => (box ? `${box.x},${box.y} ${box.w}x${box.h}` : 'absent')
/** `inner` lies within `outer` (rounding aside). */
const within = (inner: Box | null | undefined, outer: Box | null | undefined, slack = 0.6) =>
  !!inner && !!outer && inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack
/** The two boxes share some area. */
const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5
/** The alpha channel of a computed colour (1 when it has none). */
const alphaOf = (colour: string) => Number(colour.match(/^rgba\(.*,\s*([\d.]+)\)$/)?.[1] ?? colour.match(/\/\s*([\d.]+)\s*\)$/)?.[1] ?? 1)

export async function smokeIsoSidebar(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const chrome = win.webContents
  const outDir = process.env['LUCIUM_ISO_SB_OUT']
  const evaluate = <T>(script: string) =>
    (chrome.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${String(error)} -- in: ${script.replace(/\s+/g, ' ').slice(0, 200)}`)
    })
  const shot = async (name: string, rect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 345, height: 888 }) => {
    if (!outDir) return
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `${name}.png`), (await chrome.capturePage(rect)).toPNG())
  }

  // A fixed size, from the top left corner of the screen so the window is not squeezed by its lower edge.
  const savedBounds = win.getBounds()
  const workArea = screen.getPrimaryDisplay().workArea
  const home = { x: workArea.x, y: workArea.y }
  win.setBounds({ ...home, width: 1680, height: 888 })
  await sleep(600)
  const windowHeight = await evaluate<number>('innerHeight')

  const server = createServer((req, res) => {
    // No favicon: the browser would otherwise take this page for one.
    if (req.url === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html')
    res.end(`<title>page ${req.url}</title><body>iso sidebar ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- a space of its own with every kind of row ----
  const previousSpace = store.get().activeSpaceId
  const previousSettings = { sidebarVisible: store.get().settings.sidebarVisible, sidebarWidth: store.get().settings.sidebarWidth, hoverCards: store.get().settings.hoverCards, developerHosts: store.get().settings.developerHosts }
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, sidebarWidth: SIDEBAR_WIDTH, hoverCards: false } })
  browser.dispatch({ type: 'space/create', name: 'Barre ISO', emoji: '🧭', hue: 220 })
  const spaceId = store.get().activeSpaceId
  const colours = ['#e5484d', '#f5a524', '#30a46c', '#0091ff', '#8e4ec6', '#12a594', '#e93d82', '#889096']
  colours.forEach((c, i) => browser.dispatch({ type: 'favorite/add', url: `${base}/fav-${i}`, title: `Favori ${i}`, faviconUrl: favicon(c) }))
  const tabsOf = () => store.get().tabs.filter((t) => t.spaceId === spaceId)
  const idOf = (name: string) => tabsOf().find((t) => t.customTitle === name)!.id
  const open = (name: string, colour: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}/${name.toLowerCase().replace(/\W+/g, '-')}`, background: true })
    const tab = tabsOf().at(-1)!
    browser.dispatch({ type: 'tab/rename', id: tab.id, title: name })
    browser.dispatch({ type: 'tab/update', id: tab.id, patch: { faviconUrl: favicon(colour) } })
    return tab.id
  }
  const pinnedLoose = open('Épinglé libre', '#0091ff')
  const inFolder1 = open('Dans le dossier', '#30a46c')
  const inFolder2 = open('Autre dans le dossier', '#f5a524')
  const inSub = open('Dans le sous-dossier', '#8e4ec6')
  const today = ['Un', 'Deux avec un titre très long qui doit être tronqué avec des points de suspension', 'Trois', 'Quatre', 'Cinq'].map((n, i) => open(n, colours[i]!))
  browser.dispatch({ type: 'tab/pin', id: pinnedLoose })
  browser.dispatch({ type: 'folder/create', name: 'Dossier', spaceId })
  const folder = store.get().folders.find((f) => f.spaceId === spaceId && !f.parentId)!
  browser.dispatch({ type: 'folder/create', name: 'Sous-dossier', spaceId, parentId: folder.id })
  const sub = store.get().folders.find((f) => f.parentId === folder.id)!
  for (const id of [inFolder1, inFolder2]) browser.dispatch({ type: 'tab/move', id, toIndex: 0, pinned: true, folderId: folder.id })
  browser.dispatch({ type: 'tab/move', id: inSub, toIndex: 0, pinned: true, folderId: sub.id })
  for (const f of [folder, sub]) if (store.get().folders.find((x) => x.id === f.id)?.collapsed) browser.dispatch({ type: 'folder/toggle', id: f.id })
  browser.dispatch({ type: 'tab/select', id: today[0]! })
  await sleep(800)

  // ---- helpers on the real sidebar ----
  const rect = (selector: string, nth = 0) =>
    evaluate<Box | null>(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })()`)
  const rectIn = (parent: string, selector: string) =>
    evaluate<Box | null>(`(() => { const el = ${parent}?.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })()`)
  const row = (name: string) => `[...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)})`
  const rowRect = (name: string) => evaluate<Box | null>(`(() => { const el = ${row(name)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })()`)
  const style = (selector: string, props: string[], nth = 0) =>
    evaluate<Record<string, string> | null>(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const s = getComputedStyle(el); return Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, s[p]])) })()`)
  const background = (name: string) => evaluate<string>(`getComputedStyle(${row(name)}).backgroundColor`)
  const mouse = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number, extra: Partial<Electron.MouseInputEvent> = {}) =>
    chrome.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra } as Electron.MouseInputEvent)
  /** The pointer comes from outside the sidebar, so the row sees a real enter. */
  const park = async () => {
    mouse('mouseMove', 900, 400)
    await sleep(150)
  }
  const pointOn = async (name: string, dx = 0.5, dy = 0.5) => {
    const r = (await rowRect(name))!
    return { x: r.x + r.w * dx, y: r.y + r.h * dy, rect: r }
  }
  const hoverRow = async (name: string, dx = 0.5) => {
    await park()
    const p = await pointOn(name, dx)
    mouse('mouseMove', p.x, p.y)
    await sleep(180)
    return p
  }
  const clickAt = async (x: number, y: number, clickCount = 1) => {
    mouse('mouseMove', x, y)
    for (let i = 1; i <= clickCount; i++) {
      mouse('mouseDown', x, y, { clickCount: i })
      mouse('mouseUp', x, y, { clickCount: i })
    }
    await sleep(250)
  }
  const type = async (text: string) => {
    for (const ch of text) {
      chrome.sendInputEvent({ type: 'keyDown', keyCode: ch } as Electron.KeyboardInputEvent)
      chrome.sendInputEvent({ type: 'char', keyCode: ch } as Electron.KeyboardInputEvent)
      chrome.sendInputEvent({ type: 'keyUp', keyCode: ch } as Electron.KeyboardInputEvent)
    }
    await sleep(80)
  }
  const press = async (keyCode: string) => {
    chrome.sendInputEvent({ type: 'keyDown', keyCode })
    chrome.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(150)
  }

  // ======== the sidebar and its rows ========
  const sidebar = await rect('.sidebar')
  check('the sidebar takes the width of its setting', near(sidebar?.w, SIDEBAR_WIDTH) && near(sidebar?.x, 0), fmt(sidebar))

  const tiles = await evaluate<Box[]>(`[...document.querySelectorAll('.favorite')].map((el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })`)
  check('the eight favourites are tiles inside the sidebar, none over another', tiles.length === 8 && tiles.every((t) => within(t, sidebar)) && tiles.every((t, i) => tiles.every((o, j) => i === j || !overlap(t, o))), tiles.map(fmt).join(' | '))

  const header = await rect('.space-header')
  const headerName = await evaluate<string>(`document.querySelector('.space-header-name')?.textContent ?? ''`)
  check('the space header shows the name of the space, under the favourites', headerName === 'Barre ISO' && !!header && tiles.every((t) => t.y + t.h <= header.y + 0.5), `${headerName} ${fmt(header)}`)

  const todayRows = await evaluate<Box[]>(`[...document.querySelectorAll('.new-tab ~ .tab')].map((el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })`)
  check('Today lists its five tabs', todayRows.length === 5, String(todayRows.length))
  check('its rows are inside the sidebar, one under the other without overlap', todayRows.every((r, i) => within(r, sidebar) && (i === 0 || r.y >= todayRows[i - 1]!.y + todayRows[i - 1]!.h - 0.5)), todayRows.map(fmt).join(' | '))
  const longTitle = await evaluate<{ clipped: boolean; ellipsis: string }>(`(() => { const t = ${row('Deux avec un titre très long qui doit être tronqué avec des points de suspension')}.querySelector('.tab-title'); return { clipped: t.scrollWidth > t.clientWidth, ellipsis: getComputedStyle(t).textOverflow } })()`)
  check('a long title ends with an ellipsis', longTitle.clipped && longTitle.ellipsis === 'ellipsis', JSON.stringify(longTitle))

  const loose = await rowRect('Épinglé libre')
  check('a pinned tab is indented deeper than a Today tab', !!loose && loose.x > todayRows[0]!.x && within(loose, sidebar), fmt(loose))
  const folderRows = await evaluate<Box[]>(`[...document.querySelectorAll('.folder-title')].map((el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })`)
  check('a folder and the folder inside it are rows of the list, the inner one indented deeper', folderRows.length === 2 && within(folderRows[0], sidebar) && within(folderRows[1], sidebar) && folderRows[1]!.x > folderRows[0]!.x, folderRows.map(fmt).join(' | '))
  const inside = await rowRect('Dans le dossier')
  const deeper = await rowRect('Dans le sous-dossier')
  check('the tabs of a folder are indented deeper than the folder, and those of a sub-folder deeper still', !!inside && !!deeper && inside.x > folderRows[0]!.x && deeper.x > inside.x, `${inside?.x} / ${deeper?.x}`)
  const noChevron = await evaluate<boolean>(`!document.querySelector('.folder-arrow, .folder-title svg path[d="M7 4l6 6-6 6"]')`)
  check('a folder has no chevron: the state is the icon', noChevron)

  const newTab = await rect('.new-tab')
  check('the "Nouvel onglet" row is the first row of the list, before the first Today tab', !!newTab && within(newTab, sidebar) && newTab.y < todayRows[0]!.y, `${newTab?.y} -> ${todayRows[0]?.y}`)

  const footer = await rect('.footer')
  const sides = await evaluate<Box[]>(`[...document.querySelectorAll('.footer-side')].map((el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })`)
  check('the footer is at the bottom of the window', near((footer?.y ?? 0) + (footer?.h ?? 0), windowHeight), fmt(footer))
  check('its footer actions are inside the footer', sides.length >= 3 && sides.every((b) => within(b, footer)), sides.map(fmt).join(' | '))
  const spaces = await evaluate<Box[]>(`[...document.querySelectorAll('.space')].map((el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })`)
  check('the space icons are inside the footer, clear of its buttons', spaces.length >= 2 && spaces.every((s) => within(s, footer) && sides.every((b) => !overlap(s, b))), `${spaces.map(fmt).join(' | ')} / ${sides.map(fmt).join(' | ')}`)
  const currentSpace = await style('.space.current', ['filter', 'opacity'])
  const otherSpace = await style('.space:not(.current)', ['filter', 'opacity'])
  check('the active space remains visually distinguished from the others', !!currentSpace && !!otherSpace && (currentSpace.filter !== otherSpace.filter || currentSpace.opacity !== otherSpace.opacity), JSON.stringify({ currentSpace, otherSpace }))
  const noEdge = await evaluate<boolean>(`!document.querySelector('.footer.edge')`)
  check('with room to spare the footer draws no line over itself', noEdge)

  await shot('light')

  // ---- the dark appearance: the states of a row follow the theme ----
  browser.dispatch({ type: 'space/update', id: spaceId, patch: { theme: { appearance: 'dark' } } })
  await sleep(500)
  await shot('dark')
  // « Un » is the tab on screen (selected again here: in the principal suite something before this point leaves another one selected).
  browser.dispatch({ type: 'tab/select', id: today[0]! })
  await sleep(300)
  await hoverRow('Trois')
  const hoverFill = await background('Trois')
  const activeFill = await background('Un')
  check('the row under the pointer is visually highlighted in the current theme', alphaOf(hoverFill) > 0, hoverFill)
  const activeTitle = store.get().tabs.find((t) => t.id === store.get().activeTabBySpace[spaceId])?.title
  const unClasses = await evaluate<string>(`${row('Un')}?.className ?? 'absent'`)
  check('an active row remains more prominent than a hovered one', alphaOf(activeFill) > alphaOf(hoverFill), `${activeFill} / ${hoverFill}; active tab ${activeTitle}; row Un: ${unClasses}`)
  check('a row the pointer is not on has no background', (await background('Quatre')) === 'rgba(0, 0, 0, 0)', await background('Quatre'))
  await shot('dark-hover')
  const hoveredTile = await evaluate<string>(`getComputedStyle(document.querySelector('.favorite')).backgroundColor`)
  const tilePoint = tiles[0]!
  mouse('mouseMove', tilePoint.x + 30, tilePoint.y + 20)
  await sleep(150)
  const hoveredTileAfter = await evaluate<string>(`getComputedStyle(document.querySelector('.favorite')).backgroundColor`)
  check('a favourite keeps its static fill under the pointer, without a hover effect', hoveredTile === hoveredTileAfter, `${hoveredTile} / ${hoveredTileAfter}`)
  mouse('mouseMove', newTab!.x + 100, newTab!.y + 18)
  check('the new-tab row shows a hover highlight without changing the label colour', (await waitFor(async () => (await style('.new-tab', ['backgroundColor']))?.backgroundColor !== 'rgba(0, 0, 0, 0)')) && (await style('.new-tab', ['color']))?.color !== 'rgba(0, 0, 0, 0)')
  await park()

  // ======== the cross of a row, the buttons at its right ========
  const p = await hoverRow('Trois')
  const cross = await rectIn(row('Trois'), '.tab-close')
  check('hovering a row shows its cross, inside the row', !!cross && cross.w > 0 && cross.h > 0 && within(cross, p.rect, 1), `${fmt(cross)} in ${fmt(p.rect)}`)
  const crossHidden = await evaluate<string>(`getComputedStyle(${row('Quatre')}.querySelector('.tab-close')).display`)
  check('a row the pointer is not on has none', crossHidden === 'none', crossHidden)
  check('and no pin button', await evaluate<boolean>(`!${row('Trois')}.querySelector('[title*="pingler"], [aria-label*="pingler"]')`))
  const crossTitle = await evaluate<string>(`${row('Trois')}.querySelector('.tab-close').getAttribute('title')`)
  check('the tooltip of the cross of a Today tab says it archives', crossTitle === 'Archiver cet onglet', crossTitle)
  const pinnedCrossTitle = await evaluate<string>(`${row('Épinglé libre')}.querySelector('.tab-close').getAttribute('title')`)
  check('and that of a pinned tab makes it clear it is pinned and recoverable from the archive', pinnedCrossTitle.includes('épinglé') || pinnedCrossTitle.includes('pinned'), pinnedCrossTitle)
  const archivedBefore = store.get().archive.length
  await clickAt(cross!.x + cross!.w / 2, cross!.y + cross!.h / 2)
  check('a click on the cross archives the tab', !tabsOf().some((t) => t.customTitle === 'Trois') && store.get().archive.length === archivedBefore + 1, String(store.get().archive.length - archivedBefore))
  check('and shows the toast that undoes it', browser.snapshot().toast?.action === 'Annuler')
  check('the toast sits above the footer, inside the sidebar', await waitFor(() => evaluate<boolean>(`(() => { const t = document.querySelector('.toast'); const f = document.querySelector('.footer'); const s = document.querySelector('.sidebar'); if (!t || !f || !s) return false; const a = t.getBoundingClientRect(); const b = f.getBoundingClientRect(); const c = s.getBoundingClientRect(); return a.bottom <= b.top + 1 && a.left >= c.left - 0.5 && a.right <= c.right + 0.5 })()`)))
  browser.runToastAction(browser.snapshot().toast!.id)
  await sleep(400)
  const restored = tabsOf().find((t) => t.url.endsWith('/trois'))
  if (restored) browser.dispatch({ type: 'tab/rename', id: restored.id, title: 'Trois' })
  check('"Annuler" brings it back', !!restored)
  await park()

  // ======== renaming in place: the hint of the card says "double-click", so it has to work ========
  const quatre = await pointOn('Quatre')
  await clickAt(quatre.x, quatre.y, 2)
  const editor = await evaluate<{ found: boolean; focused: boolean; from: number; to: number; length: number }>(`(() => { const input = document.querySelector('.tab.editing .tab-input'); return { found: !!input, focused: document.activeElement === input, from: input?.selectionStart ?? -1, to: input?.selectionEnd ?? -1, length: input?.value.length ?? -1 } })()`)
  check('a double-click on a tab turns its title into a field with the name selected', editor.found && editor.focused && editor.from === 0 && editor.to === editor.length, JSON.stringify(editor))
  await type('Renommé')
  await press('Return')
  check('typing a name and pressing Return renames the tab', tabsOf().find((t) => t.url.endsWith('/quatre'))?.customTitle === 'Renommé', tabsOf().find((t) => t.url.endsWith('/quatre'))?.customTitle)
  check('and the field is gone', await evaluate<boolean>(`!document.querySelector('.tab-input')`))
  const renamed = await pointOn('Renommé')
  await clickAt(renamed.x, renamed.y, 2)
  await type('Autre')
  await press('Escape')
  check('Escape keeps the old name', tabsOf().find((t) => t.url.endsWith('/quatre'))?.customTitle === 'Renommé' && (await evaluate<boolean>(`!document.querySelector('.tab-input')`)))
  browser.dispatch({ type: 'tab/rename', id: idOf('Renommé'), title: 'Quatre' })
  await sleep(200)
  await park()

  // ======== folders: click the row, the icon changes, the rows slide away and back ========
  const folderRow = (await evaluate<Box>(`(() => { const r = document.querySelector('.folder-title').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`))
  const heights: number[] = []
  const bodyHeight = () => evaluate<number>(`document.querySelector('.folder-body')?.getBoundingClientRect().height ?? -1`)
  const fullHeight = await bodyHeight()
  mouse('mouseMove', folderRow.x + 100, folderRow.y + 18)
  mouse('mouseDown', folderRow.x + 100, folderRow.y + 18)
  mouse('mouseUp', folderRow.x + 100, folderRow.y + 18)
  for (let i = 0; i < 14; i++) {
    heights.push(await bodyHeight())
    await sleep(20)
  }
  const closedFolder = store.get().folders.find((f) => f.id === folder.id)!
  check('clicking the row of a folder closes it', closedFolder.collapsed === true)
  check('its rows slide away instead of vanishing: some height in between, shrinking', heights.some((h) => h > 0 && h < fullHeight - 5) && heights.every((h, i) => i === 0 || h <= heights[i - 1]! + 0.5), heights.map((h) => Math.round(h)).join(','))
  check('and are gone once the fold ends', await waitFor(async () => (await bodyHeight()) === -1, 1500))
  check('a closed folder has the closed icon', !!(await rect('.folder-title .folder-glyph')) && (await evaluate<boolean>(`!document.querySelector('.folder-title .folder-glyph.open')`)))
  mouse('mouseDown', folderRow.x + 100, folderRow.y + 18)
  mouse('mouseUp', folderRow.x + 100, folderRow.y + 18)
  const grow: number[] = []
  for (let i = 0; i < 14; i++) {
    await sleep(20)
    grow.push(await bodyHeight())
  }
  check('clicking it again opens it: the rows slide back in, growing to their full height', grow.some((h) => h > 0 && h < fullHeight - 5) && grow.every((h, i) => i === 0 || h >= grow[i - 1]! - 0.5) && near(grow.at(-1), fullHeight, 1), grow.map((h) => Math.round(h)).join(','))
  check('the open folder has the open icon', await waitFor(() => evaluate<boolean>(`!!document.querySelector('.folder-title .folder-glyph.open')`)))
  await park()

  // ======== renaming a folder in place ========
  const folderEdit = await evaluate<Box>(`(() => { const r = document.querySelector('.folder-title').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  await clickAt(folderEdit.x + 100, folderEdit.y + 18, 2)
  const folderField = await evaluate<{ found: boolean; focused: boolean; from: number; to: number; length: number }>(`(() => { const input = document.querySelector('.folder-title .folder-input'); return { found: !!input, focused: document.activeElement === input, from: input?.selectionStart ?? -1, to: input?.selectionEnd ?? -1, length: input?.value.length ?? -1 } })()`)
  check('a double-click on a folder turns its name into a field with the name selected', folderField.found && folderField.focused && folderField.from === 0 && folderField.to === folderField.length, JSON.stringify(folderField))
  await type('Classeur')
  await press('Return')
  check('typing a name and pressing Return renames the folder', store.get().folders.find((f) => f.id === folder.id)?.name === 'Classeur', store.get().folders.find((f) => f.id === folder.id)?.name)
  const folderEdit2 = await evaluate<Box>(`(() => { const r = document.querySelector('.folder-title').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  await clickAt(folderEdit2.x + 100, folderEdit2.y + 18, 2)
  await type('Autre')
  await press('Escape')
  check('Escape keeps the old name', store.get().folders.find((f) => f.id === folder.id)?.name === 'Classeur' && (await evaluate<boolean>(`!document.querySelector('.folder-input')`)))
  browser.dispatch({ type: 'folder/rename', id: folder.id, name: 'Dossier' })
  await sleep(300)
  await park()
  check('the folder stays open after its rename (the double-click does not fold it twice)', store.get().folders.find((f) => f.id === folder.id)?.collapsed === false)

  // ======== "Tout archiver" lives in the Today header ========
  // The header of Today is a row of its own now (the title, then « Ranger » and « Tout archiver » at the right): the old line under it, which shortened when the pointer came, is gone.
  const headBox = await rect('.today-head')
  const clearBox = await rect('.today-all')
  check('the Today header is a row of the sidebar, with no divider line any more', within(headBox, sidebar) && (await evaluate<boolean>(`!document.querySelector('.section-divider')`)), fmt(headBox))
  check('the current action is the Today header button "Tout archiver", at the right end of that row', !!clearBox && !!headBox && clearBox.x > headBox.x + headBox.w / 2 && clearBox.x + clearBox.w <= headBox.x + headBox.w + 1, `${fmt(clearBox)} in ${fmt(headBox)}`)
  check('and there is no legacy per-line or per-header clear button in this runtime', await evaluate<boolean>(`!document.querySelector('.section-divider .space-clear') && !document.querySelector('.space-header .space-clear')`))
  await park()

  // ======== sound, developer tab, back to the pinned address ========
  const playing = tabsOf().find((t) => t.url.endsWith('/cinq'))!
  // A page is made when its tab is first shown: only a tab with a page can be muted.
  browser.dispatch({ type: 'tab/select', id: playing.id })
  await sleep(1200)
  browser.dispatch({ type: 'tab/select', id: today[0]! })
  await sleep(400)
  const page = browser as unknown as { onPageUpdate(id: string, patch: { audible?: boolean }): void }
  page.onPageUpdate(playing.id, { audible: true })
  await sleep(300)
  const sound = await rectIn(row('Cinq'), '.tab-sound')
  const cinqRow = await rowRect('Cinq')
  check('a tab that makes sound shows a speaker button inside the right half of its row, even without hover', !!sound && within(sound, cinqRow) && sound.x > cinqRow!.x + cinqRow!.w / 2, `${fmt(sound)} in ${fmt(cinqRow)}`)
  const bars = await evaluate<{ count: number; animation: string }>(`(() => { const bars = [...${row('Cinq')}.querySelectorAll('.tab-sound .equalizer .bar')]; return { count: bars.length, animation: bars[0] ? getComputedStyle(bars[0]).animationName : '' } })()`)
  check('a tab that plays shows three bars that move', bars.count === 3 && bars.animation === 'sidebar-equalizer', JSON.stringify(bars))
  // With the state badges of the tabs (the default) the button's name is drawn from its `data-label`; without them it is a `title`.
  const soundName = () => evaluate<string>(`(() => { const b = ${row('Cinq')}.querySelector('.tab-sound'); return b.getAttribute('data-label') ?? b.getAttribute('title') })()`)
  const soundTitle = await soundName()
  check('whose tooltip says what it does', soundTitle === 'Couper le son de l’onglet', soundTitle)
  await clickAt(sound!.x + 9, sound!.y + 9)
  check('a click on it mutes the tab, without selecting it', (browser.snapshot().runtime.tabs[playing.id]?.muted ?? false) !== false || (await waitFor(() => browser.snapshot().runtime.tabs[playing.id]?.muted === true, 1500)))
  check('the bars stop once the tab is muted: a crossed speaker takes their place', await evaluate<boolean>(`!${row('Cinq')}.querySelector('.tab-sound .equalizer') && !!${row('Cinq')}.querySelector('.tab-sound svg')`))
  check('and the button then says it can give the sound back', (await soundName()) === 'Réactiver le son de l’onglet')
  check('the tab that was clicked on the speaker stays not selected', store.get().activeTabBySpace[spaceId] !== playing.id)
  page.onPageUpdate(playing.id, { audible: false })
  await park()

  browser.dispatch({ type: 'settings/update', patch: { developerHosts: ['127.0.0.1'] } })
  await sleep(300)
  const badge = await rectIn(row('Deux avec un titre très long qui doit être tronqué avec des points de suspension'), '.developer-badge')
  const deviconBox = await rectIn(row('Deux avec un titre très long qui doit être tronqué avec des points de suspension'), '.tab-icon')
  check('a tab of a developer site wears a badge on the corner of its icon', !!badge && !!deviconBox && badge.x + badge.w > deviconBox.x + deviconBox.w - 3 && badge.y + badge.h > deviconBox.y + deviconBox.h - 3, `${fmt(badge)} / ${fmt(deviconBox)}`)
  check('which says "Mode développeur"', (await evaluate<string>(`document.querySelector('.developer-badge')?.getAttribute('aria-label') ?? ''`)) === 'Mode développeur')
  await shot('developer')
  browser.dispatch({ type: 'settings/update', patch: { developerHosts: [] } })
  check('and loses it when the site stops being one', await waitFor(() => evaluate<boolean>(`!document.querySelector('.developer-badge')`)))

  const anchor = store.get().tabs.find((t) => t.id === pinnedLoose)!.anchorUrl!
  browser.dispatch({ type: 'tab/update', id: pinnedLoose, patch: { url: `${base}/ailleurs` } })
  await sleep(200)
  const away = await hoverRow('Épinglé libre')
  const back = await rectIn(row('Épinglé libre'), 'button[title="Revenir à l’adresse épinglée"]')
  const looseRow = await rowRect('Épinglé libre')
  check('a pinned tab that left its address shows a "back" button on hover, inside the right half of its row', !!back && within(back, looseRow) && back.x > looseRow!.x + looseRow!.w / 2, `${fmt(back)} in ${fmt(looseRow)}`)
  await clickAt(back!.x + 9, back!.y + 9)
  check('which brings it back to the pinned address', store.get().tabs.find((t) => t.id === pinnedLoose)!.url === anchor, store.get().tabs.find((t) => t.id === pinnedLoose)!.url)
  void away
  await park()

  // ======== the split view row ========
  browser.dispatch({ type: 'split/create', tabId: idOf('Un'), withTabId: idOf('Deux avec un titre très long qui doit être tronqué avec des points de suspension') })
  await sleep(500)
  const splitRow = await rect('.split-row')
  const pills = await evaluate<Box[]>(`[...document.querySelectorAll('.split-pill')].map((el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })`)
  check('a split view is one row of the sidebar holding two pills', within(splitRow, sidebar) && pills.length === 2 && pills.every((b) => within(b, splitRow)), `${fmt(splitRow)} / ${pills.map(fmt).join(' | ')}`)
  // The row shares its width between the two pills (`flex: 1`), with the room of the split mark between them.
  check('side by side, the same width, with the room of the mark between them', pills.length === 2 && near(pills[0]!.w, pills[1]!.w, 1.5) && pills[1]!.x - (pills[0]!.x + pills[0]!.w) > 0, pills.map(fmt).join(' | '))
  await shot('split')
  browser.dispatch({ type: 'split/remove', tabId: idOf('Deux avec un titre très long qui doit être tronqué avec des points de suspension') })
  await sleep(300)

  // ======== the card of a tab: a bubble ========
  // The card is for a pointer that rests in a window that has the focus: another application taking it away (the machine runs other
  // tests too) ends the card, so the step is tried again, up to three times, before it is held against the sidebar.
  let target = await pointOn('Cinq', 0.4)
  let early = true
  let card: Box | null = null
  for (let attempt = 1; attempt <= 3 && !card; attempt++) {
    win.focus()
    await sleep(100)
    target = await hoverRow('Cinq', 0.4)
    await sleep(700)
    if (attempt === 1) early = await evaluate<boolean>(`!document.querySelector('.hover-card')`)
    await sleep(900)
    card = await rect('.hover-card')
  }
  check('no card yet after 0.9 s: the card waits for the pointer to rest', early)
  const cardStyle = await style('.hover-card', ['backgroundColor', 'borderTopColor'])
  const cardText = await evaluate<string>(`document.querySelector('.hover-card')?.innerText ?? ''`)
  check('after about 1.5 s a card shows the name of the tab and the hint to rename it', cardText.includes('Cinq') && cardText.includes('Double-cliquez pour renommer'), cardText)
  // The card is drawn with the tokens of the interface (`--overlay`, `--line`), not with colours of its own: they are read where the card is, so that they follow the theme.
  const cardTokens = await evaluate<{ backgroundColor: string; borderTopColor: string }>(`(() => { const probe = document.createElement('div'); probe.style.cssText = 'background: var(--overlay); border: 1px solid var(--line)'; document.querySelector('.hover-card').parentElement.append(probe); const s = getComputedStyle(probe); const found = { backgroundColor: s.backgroundColor, borderTopColor: s.borderTopColor }; probe.remove(); return found })()`)
  check('it is drawn with the overlay and line colours of the interface', cardStyle?.backgroundColor === cardTokens.backgroundColor && cardStyle.borderTopColor === cardTokens.borderTopColor, JSON.stringify({ cardStyle, cardTokens }))
  check('it appears at the row of its tab, not further down', !!card && card.y >= target.rect.y - 1 && card.y <= target.rect.y + target.rect.h + 1, `${fmt(card)} / row ${fmt(target.rect)}`)
  check('and stays inside the sidebar', !!card && card.x >= 0 && card.x + card.w <= SIDEBAR_WIDTH, fmt(card))
  await shot('card')
  await park()
  // It stays a moment (220 ms, HoverCard.tsx) so that the pointer can reach its buttons, then it goes.
  check('the card goes when the pointer leaves (after its short grace)', await waitFor(() => evaluate<boolean>(`!document.querySelector('.hover-card')`), 1000))

  // ======== an icon that cannot be loaded gives way to the initial of the site ========
  browser.dispatch({ type: 'tab/update', id: idOf('Cinq'), patch: { faviconUrl: `${base}/missing-icon.png` } })
  await sleep(700)
  const cinqIcon = await evaluate<{ broken: boolean; fallback: string }>(`(() => { const icon = ${row('Cinq')}.querySelector('.tab-icon'); return { broken: !!icon.querySelector('img'), fallback: icon.querySelector('.favicon.monogram')?.textContent ?? '' } })()`)
  check('a favicon that fails to load is replaced by the monogram of the site (no broken-image mark)', !cinqIcon.broken && cinqIcon.fallback.trim().length === 1, JSON.stringify(cinqIcon))
  browser.dispatch({ type: 'tab/update', id: idOf('Cinq'), patch: { faviconUrl: favicon('#8e4ec6') } })
  check('and a new address for the icon gets it another try', await waitFor(() => evaluate<boolean>(`!!${row('Cinq')}.querySelector('.tab-icon img')`)))

  // ======== a tab that was never shown is asleep: dimmed ========
  const sleeping = await evaluate<{ icon: string; title: string; awakeTitle: string; row: string }>(`({ icon: getComputedStyle(${row('Dans le dossier')}.querySelector('.tab-icon')).opacity, title: getComputedStyle(${row('Dans le dossier')}.querySelector('.tab-title')).color, awakeTitle: getComputedStyle(${row('Trois')}.querySelector('.tab-title')).color, row: getComputedStyle(${row('Dans le dossier')}).opacity })`)
  check('a sleeping tab has its icon dimmed and its title in the secondary colour, not its row', Number(sleeping.icon) < 1 && sleeping.title !== sleeping.awakeTitle && sleeping.row === '1', JSON.stringify(sleeping))

  // The media player at the foot of the sidebar has its own file: smoke-iso-media.ts.

  // ======== dragging a folder (the events are dispatched on the real rows; the system's drag session cannot be driven) ========
  browser.dispatch({ type: 'folder/create', name: 'Frère', spaceId })
  browser.dispatch({ type: 'folder/create', name: 'Cousin', spaceId })
  await sleep(300)
  const folderOf = (name: string) => store.get().folders.find((f) => f.spaceId === spaceId && f.name === name)!
  const shape = (parent?: string): string =>
    store.get().folders
      .filter((f) => f.spaceId === spaceId && f.parentId === parent)
      .map((f) => (store.get().folders.some((x) => x.parentId === f.id) ? `${f.name}(${shape(f.id)})` : f.name))
      .join(parent ? ',' : ' ')
  const titleOf = (name: string) => `[...document.querySelectorAll('.folder-title')].find((t) => t.querySelector('.folder-name')?.textContent === ${JSON.stringify(name)})`
  const dragFolder = (from: string, to: string, yFraction: number, drop: boolean) =>
    evaluate<{ prevented: boolean; mark: string }>(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const source = ${titleOf(from)}; const data = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
      await wait(80)
      const target = ${titleOf(to)}; const box = target.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 60, clientY: box.top + box.height * ${yFraction} }
      const over = new DragEvent('dragover', init)
      target.dispatchEvent(over)
      await wait(60)
      const mark = [...document.querySelectorAll('.folder-title')].filter((t) => /drop-(before|after|inside)/.test(t.className)).map((t) => t.className.match(/drop-(?:before|after|inside)/)[0] + ':' + t.textContent.trim()).join('|')
      if (${drop}) target.dispatchEvent(new DragEvent('drop', init))
      await wait(100)
      if (source.isConnected) source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
      await wait(120)
      return { prevented: over.defaultPrevented, mark }
    })()`)
  check('folders start as: Dossier(Sous-dossier) Frère Cousin', shape() === 'Dossier(Sous-dossier) Frère Cousin', shape())
  let dragged = await dragFolder('Cousin', 'Dossier', 0.1, false)
  check('a folder dragged over the top of another marks the gap before it', dragged.prevented && dragged.mark === 'drop-before:Dossier', JSON.stringify(dragged))
  check('and nothing moves until the drop', shape() === 'Dossier(Sous-dossier) Frère Cousin')
  await dragFolder('Cousin', 'Dossier', 0.1, true)
  check('dropping it there puts it before', shape() === 'Cousin Dossier(Sous-dossier) Frère', shape())
  dragged = await dragFolder('Frère', 'Cousin', 0.5, false)
  check('over the middle of a folder it lights the folder up: it would go inside', dragged.prevented && dragged.mark.startsWith('drop-inside:Cousin'), JSON.stringify(dragged))
  await dragFolder('Frère', 'Cousin', 0.5, true)
  check('dropping it there nests it', shape() === 'Cousin(Frère) Dossier(Sous-dossier)', shape())
  dragged = await dragFolder('Cousin', 'Frère', 0.5, false)
  check('a folder cannot be dropped into what it holds: no mark, no drop', !dragged.prevented && dragged.mark === '', JSON.stringify(dragged))
  dragged = await dragFolder('Dossier', 'Dossier', 0.5, false)
  check('nor on itself', !dragged.prevented && dragged.mark === '', JSON.stringify(dragged))
  await dragFolder('Sous-dossier', 'Cousin', 0.1, true)
  check('a sub-folder dropped next to a root folder leaves its parent for the root', shape() === 'Sous-dossier Cousin(Frère) Dossier', shape())
  check('with the tabs it holds', tabsOf().find((t) => t.customTitle === 'Dans le sous-dossier')?.folderId === folderOf('Sous-dossier').id)
  check('and the sidebar follows: the tab is indented under its folder', await (async () => {
    const f = await evaluate<Box>(`(() => { const r = ${titleOf('Sous-dossier')}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
    const t = await rowRect('Dans le sous-dossier')
    return !!t && t.x > f.x
  })())
  for (const name of ['Frère', 'Cousin']) browser.dispatch({ type: 'folder/delete', id: folderOf(name).id })
  await sleep(300)

  // ======== the line over the footer shows when the list runs under it ========
  const fillers = Array.from({ length: 16 }, (_, i) => open(`Remplissage ${i + 1}`, '#889096'))
  await sleep(600)
  const edge = await style('.footer', ['borderTopColor', 'borderTopWidth'])
  check('with more tabs than the list can show, the footer draws a line on its top edge', (await evaluate<boolean>(`!!document.querySelector('.footer.edge')`)) && parseFloat(edge?.borderTopWidth ?? '0') > 0 && edge?.borderTopColor !== 'rgba(0, 0, 0, 0)', JSON.stringify(edge))
  await shot('overflow')
  browser.dispatch({ type: 'tabs/archive-many', ids: fillers })
  check('and the line goes when they are gone', await waitFor(() => evaluate<boolean>(`!document.querySelector('.footer.edge')`)))
  await evaluate(`document.querySelector('.scroll').scrollTop = 0`)

  // ======== "Vider" in the header: with nothing pinned, the header is the line ========
  browser.dispatch({ type: 'space/create', name: 'Sans épingles', emoji: '🌿', hue: 120 })
  const bareSpace = store.get().activeSpaceId
  for (const n of ['a', 'b']) browser.dispatch({ type: 'tab/open', url: `${base}/bare-${n}`, background: true })
  // The sidebar has drawn the new space as the current one: what follows reads that drawing.
  await waitFor(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(`.space.current[data-space="${bareSpace}"]`)})`))
  check('with three spaces the icons are still inside the footer, clear of its buttons', await waitFor(async () => {
    const dock = await evaluate<Box[]>(`[...document.querySelectorAll('.space')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })`)
    const buttons = await evaluate<Box[]>(`[...document.querySelectorAll('.footer-side')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })`)
    const bar = await rect('.footer')
    return dock.length >= 3 && dock.every((d) => within(d, bar) && buttons.every((b) => !overlap(d, b)))
  }))
  const noLine = await evaluate<boolean>(`!document.querySelector('.section-divider')`)
  check('a space with nothing pinned has no line between pinned tabs and Today', noLine)
  mouse('mouseMove', 900, 400)
  await sleep(200)
  const clearHidden = await style('.today-all', ['opacity'])
  mouse('mouseMove', 160, 500)
  await sleep(250)
  const clearShown = await style('.today-all', ['opacity'])
  const clearRect = await rect('.today-all')
  check('the header keeps the archive action visible in the current UI, regardless of the pointer position in the sidebar', clearHidden?.opacity === clearShown?.opacity, `${clearHidden?.opacity} / ${clearShown?.opacity}`)
  check('the archive action is inside the sidebar, at the right of the header', !!clearRect && within(clearRect, sidebar) && clearRect.x > SIDEBAR_WIDTH / 2, fmt(clearRect))
  await shot('header-clear')
  await clickAt(clearRect!.x + 5, clearRect!.y + 5)
  check('and it archives the tabs of Today', store.get().tabs.filter((t) => t.spaceId === bareSpace && !t.pinned).length === 0, String(store.get().tabs.filter((t) => t.spaceId === bareSpace).length))
  browser.dispatch({ type: 'space/select', id: spaceId })
  browser.dispatch({ type: 'space/delete', id: bareSpace })
  await sleep(300)

  // ======== the sidebar keeps its width whatever the window ========
  for (const [w, h] of [[1200, 700], [900, 600]] as const) {
    win.setBounds({ ...home, width: w, height: h })
    await sleep(500)
    const sb = await rect('.sidebar')
    const stage = await rect('.stage')
    check(`at ${w} x ${h} the sidebar keeps the width of its setting and the card takes the rest of the window`, near(sb?.w, SIDEBAR_WIDTH) && near(stage?.x, SIDEBAR_WIDTH) && (stage?.w ?? 0) > 0 && (stage?.x ?? 0) + (stage?.w ?? 0) <= w + 0.5, `${fmt(sb)} / ${fmt(stage)}`)
    const bar = await rect('.footer')
    check(`and its footer follows the bottom of the window (${h} px)`, near((bar?.y ?? 0) + (bar?.h ?? 0), await evaluate<number>('innerHeight'), 1))
  }
  win.setBounds({ ...home, width: 1680, height: 888 })
  await sleep(500)

  // ======== hiding the sidebar: it slides away and the page card slides with it ========
  const placed = browser as unknown as { stageRect(): { x: number } }
  browser.slideEnabled = true
  const sample = async (count: number, every: number) => {
    const out: Array<{ t: number; sidebar: number; card: number }> = []
    const started = Date.now()
    for (let i = 0; i < count; i++) {
      out.push({ t: Date.now() - started, sidebar: await evaluate<number>(`document.querySelector('.sidebar')?.getBoundingClientRect().right ?? -999`), card: placed.stageRect().x })
      await sleep(every)
    }
    return out
  }
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
  const hiding = await sample(14, 12)
  const hiddenAt = hiding.at(-1)!.card
  const gone = await waitFor(() => evaluate<boolean>(`!document.querySelector('.sidebar')`), 800)
  check('hiding the sidebar moves the page card left, in steps, and it comes to rest', hiding[0]!.card < SIDEBAR_WIDTH && hiddenAt < SIDEBAR_WIDTH && hiding.some((p) => p.card > hiddenAt && p.card < SIDEBAR_WIDTH) && hiding.every((p, i) => i === 0 || p.card <= hiding[i - 1]!.card) && placed.stageRect().x === hiddenAt, hiding.map((p) => p.card).join(','))
  check('the sidebar slides away to the left and leaves the page', hiding.some((p) => p.sidebar > 0 && p.sidebar < SIDEBAR_WIDTH) && gone, hiding.map((p) => Math.round(p.sidebar)).join(','))
  check('a strip at the left edge takes its place', await evaluate<boolean>(`!!document.querySelector('.hot-edge')`))
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
  const showing = await sample(14, 12)
  check('showing it again moves the card back to the right of the sidebar', showing.at(-1)!.card === SIDEBAR_WIDTH && showing.some((p) => p.card > hiddenAt && p.card < SIDEBAR_WIDTH) && showing.every((p, i) => i === 0 || p.card >= showing[i - 1]!.card), showing.map((p) => p.card).join(','))
  check('and the sidebar comes back in', await waitFor(() => evaluate<boolean>(`document.querySelector('.sidebar')?.getBoundingClientRect().right === ${SIDEBAR_WIDTH}`), 800))
  // The edge of the sidebar dragged: no slide, the card follows at once.
  browser.dispatch({ type: 'settings/update', patch: { sidebarWidth: 380 } })
  check('a change of width is not animated', placed.stageRect().x === 380)
  browser.dispatch({ type: 'settings/update', patch: { sidebarWidth: SIDEBAR_WIDTH } })

  // With less motion asked, the card jumps and the interface follows.
  const animation = systemPreferences as unknown as { getAnimationSettings: () => { prefersReducedMotion: boolean } }
  const realSettings = animation.getAnimationSettings
  animation.getAnimationSettings = () => ({ prefersReducedMotion: true })
  check('the main process reads the system setting "reduce motion"', prefersReducedMotion() === true)
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
  check('with it, the card is at its place at once', placed.stageRect().x === hiddenAt, String(placed.stageRect().x))
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })
  await sleep(300)
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
  animation.getAnimationSettings = () => {
    throw new Error('no such setting')
  }
  const fallback = prefersReducedMotion()
  console.warn = realWarn
  animation.getAnimationSettings = realSettings
  check('when the system cannot say, the animation plays and the failure is logged', fallback === false && warnings.some((w) => w.includes('[motion]') && w.includes('no such setting')), warnings.join(' | '))
  browser.slideEnabled = false

  // The interface: the same, through the media query (a debugger session emulates it).
  chrome.debugger.attach('1.3')
  try {
    await chrome.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await sleep(100)
    const motion = await evaluate<{ folder: string; slot: string; card: string }>(`(() => {
      const probe = (cls) => { const el = document.createElement('div'); el.className = cls; document.querySelector('.sidebar').appendChild(el); const d = getComputedStyle(el).transitionDuration; el.remove(); return d }
      return { folder: probe('folder-body'), slot: getComputedStyle(document.querySelector('.sidebar-slot')).transitionDuration, card: getComputedStyle(document.querySelector('.stage')).transitionDuration }
    })()`)
    check('with less motion asked, folders and the slot of the sidebar do not animate', motion.folder === '0s' && motion.slot === '0s' && motion.card === '0s', JSON.stringify(motion))
    await chrome.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await sleep(100)
    const normal = await evaluate<string>(`(() => { const el = document.createElement('div'); el.className = 'folder-body'; document.querySelector('.sidebar').appendChild(el); const d = getComputedStyle(el).transitionDuration; el.remove(); return d })()`)
    check('and they do otherwise', normal !== '0s', normal)
  } finally {
    chrome.debugger.detach()
  }

  // ======== the footer buttons, and "Vider" on the line ========
  const downloadsButton = await rect('.footer-downloads')
  await clickAt(downloadsButton!.x + 16, downloadsButton!.y + 16)
  check('the button at the left of the footer opens the downloads', browser.currentPanel() === 'downloads', String(browser.currentPanel()))
  browser.closeOverlay()
  await sleep(300)
  // The button is always in view in the header of Today (there is no line to hover any more).
  const clear = (await rect('.today-all'))!
  await clickAt(clear.x + 20, clear.y + 10)
  const left = tabsOf().filter((t) => !t.pinned)
  check('the Today archive action clears the tabs of Today, keeps the one that is open, and leaves the pinned ones alone', left.length === 1 && left[0]!.id === store.get().activeTabBySpace[spaceId] && tabsOf().filter((t) => t.pinned).length >= 4, `${left.length} in Today, ${tabsOf().filter((t) => t.pinned).length} pinned`)

  // ---- a long title inside an opened folder must not widen the list (the list used to shift sideways when a folder opened) ----
  const longName = 'Un titre très long dans un dossier ouvert, plus large que la barre latérale'
  const longTab = open(longName, '#d6409f')
  browser.dispatch({ type: 'tab/move', id: longTab, toIndex: 0, pinned: true, folderId: folder.id })
  browser.dispatch({ type: 'tab/select', id: longTab })
  await sleep(600)
  const overflow = await evaluate<{ scrollWidth: number; clientWidth: number; scrollLeft: number; rowRight: number; scrollRight: number; ellipsis: string; clipped: boolean }>(`(() => {
    const scroll = document.querySelector('.sidebar .scroll')
    const title = ${row(longName)}.querySelector('.tab-title')
    const r = ${row(longName)}.getBoundingClientRect()
    return { scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, scrollLeft: scroll.scrollLeft, rowRight: r.right, scrollRight: scroll.getBoundingClientRect().right, ellipsis: getComputedStyle(title).textOverflow, clipped: title.scrollWidth > title.clientWidth }
  })()`)
  check('a long title in an opened folder is cut with an ellipsis inside the list: nothing wider than the list, the list not shifted', overflow.scrollWidth <= overflow.clientWidth && overflow.scrollLeft === 0 && overflow.rowRight <= overflow.scrollRight + 0.5 && overflow.clipped && overflow.ellipsis === 'ellipsis', JSON.stringify(overflow))
  // The same while a sub-folder unfolds (what the user saw: opening a folder inside a folder shifted the list ~16 px), sampled all along the animation.
  browser.dispatch({ type: 'folder/create', name: 'Sous-dossier à titre long', parentId: folder.id })
  const longSub = store.get().folders.find((f) => f.parentId === folder.id && f.name === 'Sous-dossier à titre long')!
  browser.dispatch({ type: 'tab/move', id: longTab, toIndex: 0, pinned: true, folderId: longSub.id })
  browser.dispatch({ type: 'tab/select', id: longTab })
  await sleep(400)
  if (!store.get().folders.find((f) => f.id === longSub.id)!.collapsed) browser.dispatch({ type: 'folder/toggle', id: longSub.id })
  await sleep(500)
  browser.dispatch({ type: 'folder/toggle', id: longSub.id })
  const subShifts: number[] = []
  for (let i = 0; i < 16; i++) {
    await sleep(50)
    subShifts.push(await evaluate<number>(`(() => { const s = document.querySelector('.sidebar .scroll'); return Math.max(s.scrollLeft, s.scrollWidth - s.clientWidth) })()`))
  }
  check('opening a sub-folder that holds a long title neither widens nor shifts the list, at any moment of the animation', Math.max(...subShifts) === 0, JSON.stringify(subShifts))
  browser.dispatch({ type: 'tab/close', id: longTab })
  browser.dispatch({ type: 'folder/delete', id: longSub.id })

  // ---- clean up ----
  browser.dispatch({ type: 'space/select', id: previousSpace })
  browser.dispatch({ type: 'space/delete', id: spaceId })
  for (const f of store.get().favorites.filter((f) => f.url.startsWith(base))) browser.dispatch({ type: 'favorite/remove', id: f.id })
  browser.dispatch({ type: 'settings/update', patch: previousSettings })
  win.setBounds(savedBounds)
  server.close()
}

/** `LUCIUM_SMOKE_ONLY=iso-sidebar`: only the sidebar checks, with their own report (a quick loop while working on them). */
export async function runIsoSidebarOnly(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  // What the page of the sidebar complains about is the first thing to read when a check fails.
  const complaints: string[] = []
  ctx.win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    // `LUCIUM_ISO_SB_WITH_OLD=1` runs the earlier sidebar checks (selection, folders, drag and drop, hover card) first, as the whole engine test does.
    if (process.env['LUCIUM_ISO_SB_WITH_OLD']) await smokeSidebar(ctx, recorderOf(checks))
    await smokeIsoSidebar(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'the sidebar checks run to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ISO_SIDEBAR ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
