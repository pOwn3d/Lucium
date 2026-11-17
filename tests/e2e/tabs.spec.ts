// Tabs, folders, spaces, splits and the lists kept from a tab: each action is taken the way the interface takes it (the bridge, `dispatch`)
// or with the menu entry of the user (⌘W, ⇧⌘T), and the result is read in the state and, where it is shown, in the sidebar.
// The pages are served by the test (127.0.0.1); nothing leaves the machine.

import { expect, test } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { chooseMenuEntry, dispatch, serveSite, snapshotOf, stateOnDisk, tabAt, titledPage, waitForState, type LocalSite, type Snapshot } from './helpers'

let site: LocalSite
let running: Running

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A'), '/b': titledPage('Page B') })
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

/** Opens a page of the test in a tab, and waits until its title has come: the tab exists, loaded. Returns its id. */
async function openPage(path: string, title: string): Promise<{ id: string; url: string }> {
  const url = `${site.origin}${path}`
  await dispatch(running.page, { type: 'tab/open', url })
  const state = await waitForState(running.page, (s) => tabAt(s, url)?.title === title, `title of ${url}`)
  return { id: tabAt(state, url)!.id, url }
}

const tabsOf = (snapshot: Snapshot, url: string) => snapshot.state.tabs.filter((tab) => tab.url === url)

test('a page opened in a tab takes its title in the state and in the sidebar', async () => {
  const { id } = await openPage('/a', 'Page A')
  await expect(running.page.locator(`.sidebar [data-id="${id}"] .tab-title`)).toHaveText('Page A')
})

test('a name given to a tab replaces the page title, and an empty name gives the title back', async () => {
  const { id } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'tab/rename', id, title: 'Nom choisi' })
  await expect(running.page.locator(`.sidebar [data-id="${id}"] .tab-title`)).toHaveText('Nom choisi')
  await dispatch(running.page, { type: 'tab/rename', id, title: '' })
  await expect(running.page.locator(`.sidebar [data-id="${id}"] .tab-title`)).toHaveText('Page A')
})

test('a pinned tab is pinned in the state and drawn among the pinned tabs', async () => {
  const { id } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'tab/pin', id })
  await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === id)?.pinned === true, 'pinned')
  await expect(running.page.locator(`.sidebar .pinned-rows [data-id="${id}"]`)).toBeVisible()
  await dispatch(running.page, { type: 'tab/unpin', id })
  await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === id)?.pinned === false, 'unpinned')
})

test('⌘W archives the tab on screen, and ⇧⌘T brings the last archived tab back', async () => {
  const { id, url } = await openPage('/b', 'Page B')
  await chooseMenuEntry(running.app, 'CmdOrCtrl+W')
  const archived = await waitForState(running.page, (s) => s.state.archive.some((entry) => entry.url === url) && !tabAt(s, url), 'archived')
  expect(archived.state.archive.find((entry) => entry.url === url)?.title).toBe('Page B')
  await expect(running.page.locator(`.sidebar [data-id="${id}"]`)).toHaveCount(0)

  await chooseMenuEntry(running.app, 'CmdOrCtrl+Shift+T')
  await waitForState(running.page, (s) => tabAt(s, url) !== undefined, 'restored by ⇧⌘T')
})

test('archiving then restoring with the bridge keeps the address of the tab', async () => {
  const { id, url } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'tab/archive', id })
  await waitForState(running.page, (s) => !tabAt(s, url), 'archived')
  await dispatch(running.page, { type: 'archive/restore-last' })
  await waitForState(running.page, (s) => tabAt(s, url) !== undefined, 'restored')
})

test('a duplicated tab opens a second tab on the same address', async () => {
  const { id, url } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'tab/duplicate', id })
  await waitForState(running.page, (s) => tabsOf(s, url).length === 2, 'two tabs on the address')
})

test('a folder made with tabs holds them, and its name is drawn in the sidebar', async () => {
  const { id, url } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'folder/create-with', tabIds: [id], name: 'Dossier test' })
  const state = await waitForState(running.page, (s) => s.state.folders.some((folder) => folder.name === 'Dossier test'), 'folder')
  const folder = state.state.folders.find((item) => item.name === 'Dossier test')!
  await waitForState(running.page, (s) => tabAt(s, url)?.folderId === folder.id, 'tab in folder')
  await expect(running.page.locator('.sidebar')).toContainText('Dossier test')
})

test('a folder under the Today tabs is dragged to the start of Today, under the "New tab" row, and stays there after a restart', async () => {
  const first = await openPage('/a', 'Page A')
  await openPage('/b', 'Page B')
  await dispatch(running.page, { type: 'folder/create', name: 'Dossier du bas' })
  const created = await waitForState(running.page, (s) => s.state.folders.some((folder) => folder.name === 'Dossier du bas'), 'folder')
  const folder = created.state.folders.find((item) => item.name === 'Dossier du bas')!
  // The place the folder could not be taken from: under the Today tabs, alone, with no other folder to drop it next to.
  await dispatch(running.page, { type: 'folder/bottom', id: folder.id, bottom: true })
  await waitForState(running.page, (s) => s.state.folders.find((item) => item.id === folder.id)?.atBottom === true, 'folder under the tabs')
  const sidebar = running.page.locator('.sidebar')
  const row = sidebar.locator(`.folder-title[data-id="${folder.id}"]`)
  const firstTab = sidebar.locator(`.tab[data-id="${first.id}"]`)
  const yOf = async (target: typeof row): Promise<number> => (await target.boundingBox())!.y
  expect(await yOf(row)).toBeGreaterThan(await yOf(firstTab))

  // A real drag: the drop code reads where the pointer is. The "New tab" row is where a dragged folder goes to the start of Today.
  await row.dragTo(sidebar.locator('.new-tab'))
  await waitForState(running.page, (s) => s.state.folders.find((item) => item.id === folder.id)?.atTodayStart === true, 'folder at the start of Today')
  const placed = (await snapshotOf(running.page)).state.folders.find((item) => item.id === folder.id)!
  expect(placed.atBottom).toBeUndefined()
  // Drawn after the "New tab" row and before the first Today tab.
  await expect.poll(async () => (await yOf(sidebar.locator('.new-tab'))) < (await yOf(row)) && (await yOf(row)) < (await yOf(firstTab))).toBe(true)

  // The place is kept: the folder file says it, and the sidebar draws it there after a restart.
  const dataDir = running.dataDir
  await running.close({ keepData: true })
  expect(stateOnDisk(dataDir)['folders']).toEqual(expect.arrayContaining([expect.objectContaining({ id: folder.id, atTodayStart: true })]))
  running = await launchLucium({ dataDir })
  const reread = running.page.locator(`.sidebar .folder-title[data-id="${folder.id}"]`)
  await expect(reread).toBeVisible()
  expect(await yOf(running.page.locator('.sidebar .new-tab'))).toBeLessThan(await yOf(reread))
  expect(await yOf(reread)).toBeLessThan(await yOf(running.page.locator(`.sidebar .tab[data-id="${first.id}"]`)))
})

test('a new space is kept in the state, and it can be selected', async () => {
  const before = await snapshotOf(running.page)
  await dispatch(running.page, { type: 'space/create', name: 'Espace test', emoji: '🧭', hue: 200 })
  const created = await waitForState(running.page, (s) => s.state.spaces.length === before.state.spaces.length + 1, 'space created')
  const space = created.state.spaces.find((item) => item.name === 'Espace test')
  expect(space).toBeDefined()
  await dispatch(running.page, { type: 'space/select', id: space!.id })
  await waitForState(running.page, (s) => s.state.activeSpaceId === space!.id, 'space selected')
})

test('a tab moves to another space, and leaves the first one', async () => {
  const { id, url } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'space/create', name: 'Autre espace', emoji: '🧭', hue: 120 })
  const state = await waitForState(running.page, (s) => s.state.spaces.some((space) => space.name === 'Autre espace'), 'space')
  const other = state.state.spaces.find((space) => space.name === 'Autre espace')!
  await dispatch(running.page, { type: 'tab/move-to-space', id, spaceId: other.id })
  await waitForState(running.page, (s) => tabAt(s, url)?.spaceId === other.id, 'tab moved')
})

test('two tabs can be paired in a split view', async () => {
  const first = await openPage('/a', 'Page A')
  const second = await openPage('/b', 'Page B')
  await dispatch(running.page, { type: 'split/create', tabId: first.id, withTabId: second.id })
  await waitForState(running.page, (s) => s.state.splits.length === 1, 'split view')
})

test('a bookmark keeps the address and the title of its tab', async () => {
  const { id, url } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'settings/update', patch: { bookmarkManager: true } })
  await dispatch(running.page, { type: 'bookmark/add', tabId: id })
  const state = await waitForState(running.page, (s) => s.state.bookmarks.length === 1, 'bookmark')
  expect(state.state.bookmarks[0]).toMatchObject({ url, title: 'Page A' })
})

test('a page kept for later is in the read-later list', async () => {
  const { id, url } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'readlater/add', tabId: id })
  const state = await waitForState(running.page, (s) => s.state.readLater.length === 1, 'read later')
  expect(state.state.readLater[0]?.url).toBe(url)
})

test('a favourite keeps the address it was given', async () => {
  const { url } = await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'favorite/add', url, title: 'Favori test' })
  const state = await waitForState(running.page, (s) => s.state.favorites.length === 1, 'favourite')
  expect(state.state.favorites[0]).toMatchObject({ url, title: 'Favori test' })
})

test('a session keeps the tabs of the space under its name', async () => {
  await openPage('/a', 'Page A')
  await dispatch(running.page, { type: 'session/save', name: 'Session test' })
  const state = await waitForState(running.page, (s) => s.state.sessions.length === 1, 'session')
  expect(state.state.sessions[0]?.name).toBe('Session test')
})
