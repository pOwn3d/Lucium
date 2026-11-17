// The panel of the site (the padlock of the toolbar), drawn by the application: the row of a Tweak has its switch, then « Modifier »,
// « Exporter » and « Supprimer » side by side. Those buttons were laid at the same spot of the row, on top of one another, and drew one glyph
// nobody could read: their boxes are measured here where the application draws them, each one is used, and a picture of the row is kept with
// the results of the run (test-results/), over a light page and over a dark one, for a person to look at.
// The row of the extensions too: a tile per extension, « + », and the folder that loads an unpacked extension while « + » opens the Chrome Web
// Store; the menu of a tile switches the extension off and on and removes it after a question. Its extensions are folders made by the test.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { dismissWelcome, dispatch, openTab, overlayShown, requestPanel, serveSite, setSettings, snapshotOf, waitForPanel, waitForState, expectStays, type LocalSite } from './helpers'

let site: LocalSite
let running: Running | undefined

/** A page of one colour, which it declares (`theme-color`): the card of the panel takes its fill from the colour of the page behind it. */
const coloredPage = (title: string, ground: string, ink: string) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="theme-color" content="${ground}"><title>${title}</title></head><body style="margin:0;background:${ground};color:${ink}"><h1>${title}</h1></body></html>`

test.beforeAll(async () => {
  site = await serveSite({ '/light': coloredPage('Page claire', '#ffffff', '#16181f'), '/dark': coloredPage('Page sombre', '#212225', '#f1f2f6') })
})

test.afterAll(async () => {
  await site.close()
  for (const folder of madeFolders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test.afterEach(async () => {
  await running?.close()
  running = undefined
})

const TWEAK = 'Zoom'
/** The buttons of the row by their name, in French or in English (the interface follows the language of the system). */
const NAMES = {
  edit: new RegExp(`^(Modifier|Edit) ${TWEAK}$`),
  export: new RegExp(`^(Exporter|Export) ${TWEAK}$`),
  delete: new RegExp(`^(Supprimer|Delete) ${TWEAK}$`)
} as const
type Action = keyof typeof NAMES

type Box = { x: number; y: number; width: number; height: number }
const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox()
  expect(box, `the box of ${locator.toString()}`).not.toBeNull()
  return box!
}
const tweaks = async (page: Page) => ((await snapshotOf(page)).state as unknown as { boosts: Array<{ name: string; enabled: boolean }> }).boosts

/** Starts the application on a page of the local site that has one Tweak, opens the panel of the site and unfolds its Tweaks. */
async function panelWithTweak(colorScheme: 'light' | 'dark', boostSharing: boolean): Promise<{ overlay: Page; row: Locator }> {
  running = await launchLucium({ colorScheme })
  await dismissWelcome(running.app, running.page)
  await setSettings(running.page, { boostsEnabled: true, boostSharing })
  await dispatch(running.page, { type: 'boost/save', boost: { host: '127.0.0.1', name: TWEAK, enabled: true, css: 'body { zoom: 1.1 }' } })
  await waitForState(running.page, (s) => ((s.state as unknown as { boosts?: unknown[] }).boosts ?? []).length === 1, 'the Tweak saved')
  if (colorScheme === 'light') await openTab(running, `${site.origin}/light`, 'Page claire')
  else await openTab(running, `${site.origin}/dark`, 'Page sombre')
  await requestPanel(running.page, { panel: 'site' })
  const overlay = await waitForPanel(running.app, '.scc')
  const section = overlay.locator('.scc-section').filter({ has: overlay.locator('.scc-section-title', { hasText: /^(Retouches|Tweaks)$/ }) })
  const head = section.locator('.scc-section-head')
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  const row = section.locator('.scc-boost-row')
  await expect(row).toHaveCount(1)
  await row.scrollIntoViewIfNeeded()
  // The card grows out of the button and its content fades in: the boxes are measured once it has settled.
  await overlay.locator('.scc').evaluate((card) => Promise.allSettled(card.getAnimations({ subtree: true }).map((animation) => animation.finished)))
  return { overlay, row }
}

/** The buttons of the row are all there, in this order, each of a size a pointer hits, inside the row, after the switch, none over another. */
async function expectSideBySide(row: Locator, actions: readonly Action[]): Promise<void> {
  const shown = row.locator('.scc-boost-actions button')
  await expect(shown).toHaveCount(actions.length)
  const rowBox = await boxOf(row)
  const switchBox = await boxOf(row.getByRole('switch'))
  const boxes: Box[] = []
  for (const [index, action] of actions.entries()) {
    const button = row.getByRole('button', { name: NAMES[action], exact: true })
    await expect(button, action).toBeVisible()
    // In the order of the row: the n-th button is the one named so.
    await expect(shown.nth(index), action).toHaveAccessibleName(NAMES[action])
    await expect(button, action).toHaveAttribute('title', NAMES[action])
    const box = await boxOf(button)
    expect(box.width, `${action}: width`).toBeGreaterThanOrEqual(26)
    expect(box.height, `${action}: height`).toBeGreaterThanOrEqual(28)
    expect(box.x, `${action}: inside the row`).toBeGreaterThanOrEqual(rowBox.x - 0.5)
    expect(box.x + box.width, `${action}: inside the row`).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5)
    expect(box.y, `${action}: inside the row`).toBeGreaterThanOrEqual(rowBox.y - 0.5)
    expect(box.y + box.height, `${action}: inside the row`).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5)
    boxes.push(box)
  }
  // Each button ends before the next one starts; the switch (and the name in it) ends where the first button starts.
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i - 1]!.x + boxes[i - 1]!.width, `${actions[i - 1]} and ${actions[i]} side by side, not one over the other`).toBeLessThanOrEqual(boxes[i]!.x + 0.5)
  }
  expect(switchBox.x + switchBox.width, 'the switch leaves the buttons their room').toBeLessThanOrEqual(boxes[0]!.x + 0.5)
}

test('site panel: the row of a Tweak has « Modifier », « Exporter » and « Supprimer » side by side, each doing its work', async () => {
  const { overlay, row } = await panelWithTweak('light', true)
  await expectSideBySide(row, ['edit', 'export', 'delete'])
  await row.screenshot({ path: test.info().outputPath('boost-row-light.png') })

  // The order of the keyboard: the switch, then the three buttons.
  await row.getByRole('switch').focus()
  for (const action of ['edit', 'export', 'delete'] as const) {
    await overlay.keyboard.press('Tab')
    await expect(row.getByRole('button', { name: NAMES[action], exact: true }), action).toBeFocused()
  }

  // The bin under the pointer, and the picture of it.
  await row.getByRole('button', { name: NAMES.delete, exact: true }).hover()
  await row.screenshot({ path: test.info().outputPath('boost-row-light-delete-hover.png') })

  // « Supprimer » asks first; « Annuler » keeps the Tweak and puts the row back.
  await row.getByRole('button', { name: NAMES.delete, exact: true }).click()
  const question = overlay.locator('.scc-boost-confirm')
  await expect(question).toBeVisible()
  await question.getByRole('button', { name: /^(Annuler|Cancel)$/ }).click()
  await expect(overlay.locator('.scc-boost-row:not(.scc-boost-confirm)')).toHaveCount(1)
  expect((await tweaks(running!.page)).map((one) => one.name)).toEqual([TWEAK])

  // A double-click on the name renames the Tweak in place, and does not switch it off and on again.
  await row.locator('.scc-boost-name').dblclick()
  const field = overlay.locator('.scc-rename-field')
  await expect(field).toBeFocused()
  await overlay.locator('.scc-boost-rename').screenshot({ path: test.info().outputPath('boost-row-light-rename.png') })
  await expectStays(async () => (await tweaks(running!.page))[0]?.enabled, true, 'the Tweak stays on after the double-click', 800)
  await field.press('Escape')
  await expect(row.getByRole('switch')).toBeFocused()

  // « Modifier » opens the editor of that Tweak.
  await row.getByRole('button', { name: NAMES.edit, exact: true }).click()
  const editor = await waitForPanel(running!.app, '.bx')
  await expect(editor.locator('.bx-title')).toHaveText(TWEAK)
})

test('site panel: over a dark page the buttons of a Tweak are side by side, and « Exporter » is there only while the sharing of Tweaks is on', async () => {
  const { row } = await panelWithTweak('dark', true)
  await expectSideBySide(row, ['edit', 'export', 'delete'])
  await row.screenshot({ path: test.info().outputPath('boost-row-dark.png') })
  const withThree = (await boxOf(row.getByRole('switch'))).width

  await setSettings(running!.page, { boostSharing: false })
  await expect(row.getByRole('button', { name: NAMES.export, exact: true })).toHaveCount(0)
  await expectSideBySide(row, ['edit', 'delete'])
  await row.screenshot({ path: test.info().outputPath('boost-row-dark-no-sharing.png') })
  // The switch, and the name in it, takes the room the missing button leaves.
  expect((await boxOf(row.getByRole('switch'))).width).toBeGreaterThan(withThree + 20)
})

// ---------- the row of the extensions ----------

/** The folders of extensions this file made, removed after the last test. */
const madeFolders: string[] = []

/** A round picture of one colour, as a PNG (written by hand: the test needs no library for a few dots). */
function dotPng(size: number, [r, g, b]: readonly [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const middle = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // A soft edge of one pixel, so that the dot is round at every size it is drawn.
      const alpha = Math.max(0, Math.min(1, size / 2 - 1 - Math.hypot(x - middle, y - middle) + 0.5))
      raw.set([r, g, b, Math.round(alpha * 255)], y * (size * 4 + 1) + 1 + x * 4)
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])))
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const DOT_COLOURS = [[37, 99, 235], [22, 163, 74], [234, 88, 12], [147, 51, 234], [220, 38, 38], [13, 148, 136], [202, 138, 4]] as const
const EXTENSION_NAMES = ['Bleu', 'Vert', 'Orange', 'Violet', 'Rouge', 'Sarcelle', 'Moutarde'] as const

/** Folders of unpacked extensions (Manifest V3, a button in the toolbar, a round picture), named after their colour, from the `from`-th colour. */
function extensionFolders(count: number, from = 0): Array<{ path: string; name: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lucium-e2e-ext-'))
  madeFolders.push(root)
  return Array.from({ length: count }, (_unused, index) => {
    const name = `Pastille ${EXTENSION_NAMES[from + index]!}`
    const path = join(root, `ext-${from + index}`)
    mkdirSync(path)
    writeFileSync(join(path, 'icon.png'), dotPng(64, DOT_COLOURS[from + index]!))
    writeFileSync(join(path, 'manifest.json'), JSON.stringify({ manifest_version: 3, name, version: '1.0', icons: { '16': 'icon.png', '32': 'icon.png', '48': 'icon.png', '128': 'icon.png' }, action: { default_title: name } }))
    return { path, name }
  })
}

type ListedExtension = { id: string; name: string; enabled: boolean; profileId: string }
/** The extensions the main process lists, in every profile. */
const extensionsOf = async (page: Page): Promise<ListedExtension[]> => ((await snapshotOf(page)) as unknown as { extensions: ListedExtension[] }).extensions

const FOLDER_NAME = /^(Charger une extension non empaquetée…|Load an unpacked extension…)$/
const PLUS_NAME = /^(Ajouter une extension|Add Extension)$/
const PAGE_NAME = /^(Ouvrir la page Extensions|Open the Extensions page)$/
const MENU_ENTRY = {
  off: /^(Désactiver|Turn off)$/,
  on: /^(Activer|Turn on)$/,
  reload: /^(Recharger|Reload)$/,
  manage: /^(Gérer…|Manage…)$/,
  remove: /^(Retirer…|Remove…)$/
} as const
/** The name of a tile that is off, in French or in English. */
const offName = (name: string): RegExp => new RegExp(`^${name}, (désactivée|turned off)$`)

/** Starts the application with these unpacked extensions on a page of the local site, opens the panel of the site and unfolds its extensions. */
async function panelWithExtensions(colorScheme: 'light' | 'dark', folders: Array<{ path: string }>): Promise<{ overlay: Page; card: Locator; row: Locator; body: Locator }> {
  running = await launchLucium({ colorScheme, extensions: folders.map((folder) => folder.path) })
  await dismissWelcome(running.app, running.page)
  await expect.poll(async () => (await extensionsOf(running!.page)).filter((one) => one.profileId === 'default').length, { message: 'the extensions loaded' }).toBe(folders.length)
  if (colorScheme === 'light') await openTab(running, `${site.origin}/light`, 'Page claire')
  else await openTab(running, `${site.origin}/dark`, 'Page sombre')
  await requestPanel(running.page, { panel: 'site' })
  const overlay = await waitForPanel(running.app, '.scc')
  const section = overlay.locator('.scc-section').filter({ has: overlay.locator('.scc-section-title', { hasText: /^Extensions$/ }) })
  const head = section.locator('.scc-section-head')
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  const row = section.locator('.scc-extensions')
  await expect(row.locator('.scc-ext')).toHaveCount(folders.length)
  // The pictures are drawn (a picture that fails becomes the initial of the extension, which the screenshots would show instead).
  await expect.poll(() => row.locator('img.scc-ext-icon').evaluateAll((images) => images.length > 0 && images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), { message: 'the pictures of the extensions' }).toBe(true)
  await row.scrollIntoViewIfNeeded()
  await overlay.locator('.scc').evaluate((card) => Promise.allSettled(card.getAnimations({ subtree: true }).map((animation) => animation.finished)))
  return { overlay, card: overlay.locator('.scc'), row, body: section.locator('.scc-section-body') }
}

/** The tiles of the row (the extensions, « + », the folder) are inside the card, and no two of them share a pixel. */
async function expectTilesApart(card: Locator, row: Locator): Promise<Box[]> {
  const cardBox = await boxOf(card)
  const tiles = row.locator('.scc-tile')
  const boxes: Box[] = []
  for (let i = 0; i < (await tiles.count()); i++) boxes.push(await boxOf(tiles.nth(i)))
  for (const [i, box] of boxes.entries()) {
    expect(box.x, `tile ${i}: inside the card`).toBeGreaterThanOrEqual(cardBox.x)
    expect(box.x + box.width, `tile ${i}: inside the card`).toBeLessThanOrEqual(cardBox.x + cardBox.width)
    for (const [j, other] of boxes.entries()) {
      if (j <= i) continue
      const apart = box.x + box.width <= other.x + 0.5 || other.x + other.width <= box.x + 0.5 || box.y + box.height <= other.y + 0.5 || other.y + other.height <= box.y + 0.5
      expect(apart, `tiles ${i} and ${j} do not overlap`).toBe(true)
    }
  }
  return boxes
}

test('site panel: beside « + », the folder loads an unpacked extension, and is there only while « + » opens the Chrome Web Store', async () => {
  const { overlay, card, row } = await panelWithExtensions('light', extensionFolders(3))
  const plus = row.getByRole('button', { name: PLUS_NAME })
  const folder = row.getByRole('button', { name: FOLDER_NAME })
  await expect(folder).toBeVisible()
  await expect(folder).toHaveAttribute('title', FOLDER_NAME)
  const [plusBox, folderBox] = [await boxOf(plus), await boxOf(folder)]
  expect(plusBox.x + plusBox.width, 'the folder is after « + », not over it').toBeLessThanOrEqual(folderBox.x + 0.5)
  expect(folderBox.width).toBeGreaterThanOrEqual(26)
  await expectTilesApart(card, row)
  await row.screenshot({ path: test.info().outputPath('extensions-row-3-light.png') })

  // The order of the keyboard: « + », then the folder.
  await plus.focus()
  await overlay.keyboard.press('Tab')
  await expect(folder).toBeFocused()

  // The folder asks the main process for one: the box of the system is answered here with a folder the test made, which is loaded.
  const [added] = extensionFolders(1, 6)
  await running!.app.evaluate(({ dialog }, path) => {
    const seen = globalThis as unknown as { folderAsked: number }
    seen.folderAsked = 0
    dialog.showOpenDialog = (async () => {
      seen.folderAsked++
      return { canceled: false, filePaths: [path] }
    }) as typeof dialog.showOpenDialog
  }, added!.path)
  await folder.click()
  await expect.poll(() => running!.app.evaluate(() => (globalThis as unknown as { folderAsked: number }).folderAsked)).toBe(1)
  await expect(row.locator('.scc-ext')).toHaveCount(4)
  await expect(row.getByRole('button', { name: added!.name, exact: true })).toBeVisible()
  await waitForState(running!.page, (s) => ((s.state.settings['extensionPaths'] as string[] | undefined) ?? []).includes(added!.path), 'the folder kept in the settings')

  // With the installation from the Store off, « + » loads a folder itself: no second button for it.
  await setSettings(running!.page, { webStoreInstall: false })
  await expect(folder).toHaveCount(0)
  await expect(plus).toHaveAttribute('title', /^(Ajouter une extension…|Add Extension…)$/)
})

test('site panel: the last button of the row opens the Extensions page in a tab of the window, after « + » and the folder, inside the card', async () => {
  const { overlay, card, row } = await panelWithExtensions('light', extensionFolders(2))
  const [plus, folder, page] = [row.getByRole('button', { name: PLUS_NAME }), row.getByRole('button', { name: FOLDER_NAME }), row.getByRole('button', { name: PAGE_NAME })]
  await expect(page).toBeVisible()
  await expect(page).toHaveAttribute('title', PAGE_NAME)
  const [plusBox, folderBox, pageBox] = [await boxOf(plus), await boxOf(folder), await boxOf(page)]
  expect(plusBox.x + plusBox.width, 'the folder is after « + »').toBeLessThanOrEqual(folderBox.x + 0.5)
  expect(folderBox.x + folderBox.width, 'the page button is after the folder, not over it').toBeLessThanOrEqual(pageBox.x + 0.5)
  expect(pageBox.width, 'the same tile as its neighbours').toBeCloseTo(folderBox.width, 0)
  expect(pageBox.height).toBeCloseTo(folderBox.height, 0)
  await expectTilesApart(card, row)
  await row.screenshot({ path: test.info().outputPath('extensions-row-page-button-light.png') })

  // The order of the keyboard: the folder, then the page button.
  await folder.focus()
  await overlay.keyboard.press('Tab')
  await expect(page).toBeFocused()

  // It opens the page of the extensions (chrome://extensions, served as lucium-ui://extensions/) in a tab of the window, no window of its own, and the panel closes.
  const windowUrls = (): string[] => running!.app.windows().map((one) => one.url())
  const windowsBefore = windowUrls()
  await overlay.keyboard.press('Enter')
  await expect
    .poll(() => running!.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.getURL())), { message: 'the Extensions page in a tab' })
    .toContain('lucium-ui://extensions/')
  expect(running!.app.windows().some((one) => one.url().includes('extensions.html'))).toBe(false)
  expect(windowUrls(), 'no window of its own: the pages of the application are the same as before').toEqual(windowsBefore)
  await expect.poll(() => overlayShown(running!.app), { message: 'the panel closed' }).toBe(false)
})

test('site panel: the row of the extensions goes to the line with six of them, every tile in the card and none over another, over a light page and a dark one', async () => {
  const folders = extensionFolders(6)
  for (const scheme of ['light', 'dark'] as const) {
    const { card, row } = await panelWithExtensions(scheme, folders)
    const boxes = await expectTilesApart(card, row)
    // Six extensions, « + » and the folder: two lines.
    expect(boxes).toHaveLength(8)
    expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(2)
    await row.screenshot({ path: test.info().outputPath(`extensions-row-6-${scheme}.png`) })
    await running!.close()
    running = undefined
  }
})

test('site panel: the menu of an extension switches it off and on, removes it after a question that « Annuler » leaves alone, and is used from the keyboard', async () => {
  const folders = extensionFolders(3)
  const { overlay, card, row, body } = await panelWithExtensions('light', folders)
  const [first, second, third] = folders as [{ path: string; name: string }, { path: string; name: string }, { path: string; name: string }]
  const menu = overlay.getByRole('menu')
  const tileOf = (name: string) => row.getByRole('button', { name, exact: true })
  const moreOf = (name: string) => row.getByRole('button', { name: new RegExp(`^(Actions de « ${name} »|Actions for “${name}”)$`) })
  const enabledOf = async (name: string) => (await extensionsOf(running!.page)).find((one) => one.name === name && one.profileId === 'default')?.enabled

  // A right click opens the menu of the tile, under the row, its first entry focused.
  await tileOf(first.name).click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText([MENU_ENTRY.off, MENU_ENTRY.reload, MENU_ENTRY.manage, MENU_ENTRY.remove])
  await expect(menu.getByRole('menuitem', { name: MENU_ENTRY.off })).toBeFocused()
  const menuBox = await boxOf(overlay.locator('.scc-ext-pop'))
  for (const box of await expectTilesApart(card, row)) expect(menuBox.y, 'the menu is under the tiles, not over them').toBeGreaterThanOrEqual(box.y + box.height)
  await body.screenshot({ path: test.info().outputPath('extensions-menu-light.png') })

  // « Désactiver »: the extension is off in the profile; its tile stays, faded with its barred disc, and its name says it is off.
  await menu.getByRole('menuitem', { name: MENU_ENTRY.off }).click()
  await expect.poll(() => enabledOf(first.name)).toBe(false)
  const off = row.getByRole('button', { name: offName(first.name) })
  await expect(off).toBeVisible()
  await expect(off.locator('.scc-ext-off')).toBeVisible()
  await expect(row.locator('.scc-ext.off')).toHaveCount(1)
  await row.screenshot({ path: test.info().outputPath('extensions-row-off-light.png') })

  // A click on a tile that is off opens its menu, « Activer » first, instead of its action; « Activer » turns it on again.
  await off.click()
  await expect(menu.getByRole('menuitem').first()).toHaveText(MENU_ENTRY.on)
  await menu.getByRole('menuitem', { name: MENU_ENTRY.on }).click()
  await expect.poll(() => enabledOf(first.name)).toBe(true)
  await expect(tileOf(first.name)).toBeVisible()
  await expect(row.locator('.scc-ext.off')).toHaveCount(0)

  // From the keyboard: the tile, then its ⋯ (in view while it has the focus). Shift+F10 on the tile opens the menu, the arrows go through it,
  // Escape closes it, gives the focus back to the tile and leaves the panel open.
  await tileOf(second.name).focus()
  await overlay.keyboard.press('Tab')
  await expect(moreOf(second.name)).toBeFocused()
  expect(await moreOf(second.name).evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  expect(await moreOf(third.name).evaluate((element) => getComputedStyle(element).opacity), 'the ⋯ of another tile waits').toBe('0')
  await row.screenshot({ path: test.info().outputPath('extensions-row-more-focused-light.png') })
  await tileOf(second.name).focus()
  await overlay.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: MENU_ENTRY.off })).toBeFocused()
  await overlay.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: MENU_ENTRY.reload })).toBeFocused()
  await overlay.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(tileOf(second.name)).toBeFocused()
  expect(await overlayShown(running!.app), 'Escape closed the menu, not the panel').toBe(true)

  // « Retirer… » asks; « Annuler » has the focus, and Return on it removes nothing.
  await moreOf(third.name).click()
  await menu.getByRole('menuitem', { name: MENU_ENTRY.remove }).click()
  const question = overlay.locator('.scc-ext-confirm')
  await expect(question).toBeVisible()
  // The French quotes hold their name with thin spaces: the name is looked for, not the spacing.
  await expect(question.locator('strong')).toHaveText(new RegExp(`^(Retirer|Remove)\\s*[«“]\\s*${third.name}\\s*[»”]\\s*\\?$`))
  const cancel = question.getByRole('button', { name: /^(Annuler|Cancel)$/ })
  await expect(cancel).toBeFocused()
  await body.screenshot({ path: test.info().outputPath('extensions-question-light.png') })
  await overlay.keyboard.press('Enter')
  await expect(question).toHaveCount(0)
  await expectStays(async () => (await extensionsOf(running!.page)).some((one) => one.name === third.name), true, 'the extension stays after « Annuler »', 800)
  await expect(tileOf(third.name)).toBeFocused()

  // « Retirer »: the folder leaves the profile, its tile goes, and « + » has the focus.
  await moreOf(third.name).click()
  await menu.getByRole('menuitem', { name: MENU_ENTRY.remove }).click()
  await question.getByRole('button', { name: /^(Retirer|Remove)$/ }).click()
  await expect.poll(async () => (await extensionsOf(running!.page)).some((one) => one.name === third.name)).toBe(false)
  await expect(row.locator('.scc-ext')).toHaveCount(2)
  await expect(row.getByRole('button', { name: PLUS_NAME })).toBeFocused()
  await expect(overlay.locator('.scc-ext-done')).toContainText(third.name)

  // « Gérer… » opens the page of the extension in a tab of the window (chrome://extensions/?id=…, served as lucium-ui://extensions/?id=…), no window of its own.
  const windowsBefore = running!.app.windows().length
  await tileOf(second.name).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: MENU_ENTRY.manage }).click()
  const secondId = (await extensionsOf(running!.page)).find((one) => one.name === second.name && one.profileId === 'default')!.id
  await expect
    .poll(() => running!.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.getURL())), { message: 'the Extensions page in a tab' })
    .toContain(`lucium-ui://extensions/?id=${secondId}&profile=default`)
  expect(running!.app.windows().some((one) => one.url().includes('extensions.html'))).toBe(false)
  expect(running!.app.windows().length).toBe(windowsBefore)
})

test('site panel: over a dark page, the menu of an extension, a tile that is off and the question read as they do over a light one', async () => {
  const folders = extensionFolders(3)
  const { overlay, row, body } = await panelWithExtensions('dark', folders)
  const first = folders[0]!
  await row.screenshot({ path: test.info().outputPath('extensions-row-3-dark.png') })
  await row.getByRole('button', { name: first.name, exact: true }).click({ button: 'right' })
  await expect(overlay.getByRole('menu')).toBeVisible()
  await body.screenshot({ path: test.info().outputPath('extensions-menu-dark.png') })
  await overlay.getByRole('menuitem', { name: MENU_ENTRY.off }).click()
  const off = row.getByRole('button', { name: offName(first.name) })
  await expect(off).toBeVisible()
  await row.screenshot({ path: test.info().outputPath('extensions-row-off-dark.png') })
  await off.click()
  await overlay.getByRole('menuitem', { name: MENU_ENTRY.remove }).click()
  await expect(overlay.locator('.scc-ext-confirm')).toBeVisible()
  await body.screenshot({ path: test.info().outputPath('extensions-question-dark.png') })
})
