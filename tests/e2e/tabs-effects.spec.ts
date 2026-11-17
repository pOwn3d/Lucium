// The tabs and the sidebar, beyond tabs.spec.ts: what the functions of the tabs do to them. A link is clicked in the page of a tab the way the
// mouse does (with its keys), the menu entries are chosen as the user chooses them, and the effect is read in the state, in the sidebar and in
// the windows of the application. The delays counted in hours (archiving) are met by launching again on a state file whose dates are older.

import { expect, test } from '@playwright/test'
import { launchLucium, TEST_DOMAIN, type Running } from './launch'
import {
  activeTabId,
  chooseMenuEntry,
  dismissWelcome,
  dispatch,
  editStateOnDisk,
  menuEntryState,
  openTab,
  overlayShown,
  serveSite,
  setSettings,
  snapshotOf,
  stateOnDisk,
  tabAt,
  titledPage,
  waitForPanel,
  waitForState,
  waitForStateFile,
  waitForWindow,
  expectStays,
  type LocalSite
} from './helpers'

let site: LocalSite
let running: Running

/** A page of the test whose link opens `href` (in a tab of its own with `target="_blank"`). */
const linkPage = (title: string, href: string, blank = false) => titledPage(title, `<p><a id="link" href="${href}"${blank ? ' target="_blank"' : ''} style="display:inline-block;padding:20px">Le lien</a></p>`)

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A'), '/b': titledPage('Page B'), '/c': titledPage('Page C') })
})

test.afterAll(async () => {
  await site.close()
})

test.afterEach(async () => {
  await running?.close()
})

const url = (path: string) => `${site.origin}${path}`
/** The same server under a name that is another site than 127.0.0.1 for the application (see launch.ts). */
const otherSite = (path: string) => `http://other.${TEST_DOMAIN}:${site.port}${path}`

test.describe('in one window', () => {
  test.beforeEach(async () => {
    running = await launchLucium()
    // The guide of a new profile opens by itself in the layer of the panels a moment after the launch: left alone, it came over the Glance or
    // just after it, and a control that reads the layer as closed saw it instead.
    await dismissWelcome(running.app, running.page)
  })

  test('⌘D pins the tab on screen, and ⌘D again unpins it', async () => {
    const { id } = await openTab(running, url('/a'), 'Page A')
    await chooseMenuEntry(running.app, 'CmdOrCtrl+D')
    await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === id)?.pinned === true, 'pinned')
    await expect(running.page.locator(`.sidebar .pinned-rows [data-id="${id}"]`)).toBeVisible()
    // The menu is rebuilt when the tab on screen is pinned (its entry says "Désépingler"): the same key unpins.
    await expect.poll(async () => {
      await chooseMenuEntry(running.app, 'CmdOrCtrl+D')
      return (await snapshotOf(running.page)).state.tabs.find((tab) => tab.id === id)?.pinned
    }).toBe(false)
  })

  test('a folder can be renamed, a tab moved into it, and deleting it leaves its tabs in the pinned list', async () => {
    const a = await openTab(running, url('/a'), 'Page A')
    const b = await openTab(running, url('/b'), 'Page B')
    await dispatch(running.page, { type: 'folder/create-with', tabIds: [a.id], name: 'Dossier' })
    let state = await waitForState(running.page, (s) => s.state.folders.some((folder) => folder.name === 'Dossier'), 'folder')
    const folder = state.state.folders.find((item) => item.name === 'Dossier')!
    await dispatch(running.page, { type: 'folder/rename', id: folder.id, name: 'Lectures' })
    await waitForState(running.page, (s) => s.state.folders.find((item) => item.id === folder.id)?.name === 'Lectures', 'renamed')
    await expect(running.page.locator(`.sidebar [data-id="${folder.id}"]`)).toContainText('Lectures')

    await dispatch(running.page, { type: 'tab/move', id: b.id, toIndex: 0, pinned: true, folderId: folder.id })
    await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === b.id)?.folderId === folder.id, 'B in the folder')

    await dispatch(running.page, { type: 'folder/delete', id: folder.id })
    state = await waitForState(running.page, (s) => !s.state.folders.some((item) => item.id === folder.id), 'folder deleted')
    for (const id of [a.id, b.id]) expect(state.state.tabs.find((tab) => tab.id === id)).toMatchObject({ pinned: true })
    expect(state.state.tabs.filter((tab) => tab.folderId === folder.id)).toEqual([])
    await expect(running.page.locator(`.sidebar [data-id="${folder.id}"]`)).toHaveCount(0)
  })

  test('a split view shows its two pages side by side in the window', async () => {
    const first = await openTab(running, url('/a'), 'Page A')
    const second = await openTab(running, url('/b'), 'Page B')
    await dispatch(running.page, { type: 'split/create', tabId: first.id, withTabId: second.id })
    await waitForState(running.page, (s) => s.state.splits.length === 1, 'split view')
    const panes = () =>
      running.app.evaluate(({ BrowserWindow }, wanted: string[]) => {
        const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'))
        return (main?.contentView.children ?? [])
          .map((view) => ({ url: (view as unknown as { webContents?: { getURL(): string } }).webContents?.getURL() ?? '', bounds: view.getBounds(), visible: view.getVisible() }))
          .filter((view) => wanted.includes(view.url) && view.visible && view.bounds.width > 0)
          .sort((x, y) => x.bounds.x - y.bounds.x)
      }, [url('/a'), url('/b')])
    await expect.poll(async () => (await panes()).length).toBe(2)
    const [left, right] = await panes()
    expect(left!.bounds.x + left!.bounds.width).toBeLessThanOrEqual(right!.bounds.x)
    expect(Math.abs(left!.bounds.y - right!.bounds.y)).toBeLessThan(40)

    // Leaving the split view: one page on screen again.
    await dispatch(running.page, { type: 'split/remove', tabId: second.id })
    await expect.poll(async () => (await panes()).length).toBe(1)
  })

  test('read-later-folders: a folder of the read-later list can be made while on; off, the same action makes none', async () => {
    const folders = async () => ((await snapshotOf(running.page)).state as unknown as { readLaterFolders: Array<{ name: string }> }).readLaterFolders.map((folder) => folder.name)
    await setSettings(running.page, { useReadLaterFolders: false })
    await dispatch(running.page, { type: 'readlater-folder/create', name: 'Plus tard' })
    await expectStays(folders, [], 'no folder of the reading list is made while the function is off', 400)
    await setSettings(running.page, { useReadLaterFolders: true })
    await dispatch(running.page, { type: 'readlater-folder/create', name: 'Plus tard' })
    await expect.poll(folders).toEqual(['Plus tard'])
  })

  test('reopen-history: ⇧⌘T brings an archived tab back with its previous pages while on; off, without them', async () => {
    const backList = async (tabUrl: string) => (await waitForWindow(running.app, (address) => address === tabUrl)).evaluate(() => history.length)
    for (const on of [true, false]) {
      await setSettings(running.page, { reopenHistory: on })
      const page = on ? '/b' : '/c'
      const { id } = await openTab(running, url('/a'), 'Page A')
      await dispatch(running.page, { type: 'tab/select', id })
      // The tab goes from A to the second page: two pages in its history.
      await running.page.evaluate(([tabId, address]) => (globalThis as unknown as { lucium: { setTabAddress(id: string, input: string): void } }).lucium.setTabAddress(tabId!, address!), [id, url(page)])
      await waitForState(running.page, (s) => s.state.tabs.find((tab) => tab.id === id)?.url === url(page), 'second page')
      await expect.poll(() => backList(url(page))).toBe(2)
      await chooseMenuEntry(running.app, 'CmdOrCtrl+W')
      await waitForState(running.page, (s) => !s.state.tabs.some((tab) => tab.id === id), 'archived')
      await chooseMenuEntry(running.app, 'CmdOrCtrl+Shift+T')
      await waitForState(running.page, (s) => tabAt(s, url(page)) !== undefined, 'reopened')
      await expect.poll(() => backList(url(page))).toBe(on ? 2 : 1)
    }
  })

  test('tab-tree: a tab opened by a link of a page hangs under that page while on; off, it is a tab of its own', async () => {
    for (const on of [true, false]) {
      await setSettings(running.page, { tabTree: on })
      const target = on ? '/b' : '/c'
      const parentPath = `/tree-${on}`
      const local = await serveSite({ [parentPath]: linkPage('Parent', url(target), true) })
      try {
        const parent = await openTab(running, `${local.origin}${parentPath}`, 'Parent')
        await parent.page.click('#link')
        const state = await waitForState(running.page, (s) => tabAt(s, url(target)) !== undefined, 'the tab of the link')
        const child = tabAt(state, url(target)) as unknown as { id: string; parentId?: string }
        if (on) {
          expect(child.parentId).toBe(parent.id)
          await expect(running.page.locator(`.sidebar .tab[data-id="${child.id}"]`)).toHaveClass(/\btree-child\b/)
        } else {
          expect(child.parentId).toBeUndefined()
          await expect(running.page.locator(`.sidebar .tab[data-id="${child.id}"]`)).not.toHaveClass(/\btree-child\b/)
        }
      } finally {
        await local.close()
      }
    }
  })

  test('back-closes-tab: Back on a tab a link opened closes it and shows the page of the link while on; off, the tab stays', async () => {
    for (const on of [true, false]) {
      await setSettings(running.page, { backClosesOpenedTab: on })
      const target = on ? '/b' : '/c'
      const local = await serveSite({ '/opener': linkPage('Opener', url(target), true) })
      try {
        const opener = await openTab(running, `${local.origin}/opener`, 'Opener')
        await opener.page.click('#link')
        const state = await waitForState(running.page, (s) => tabAt(s, url(target))?.title !== undefined && tabAt(s, url(target))?.title !== '', 'the tab of the link')
        const child = tabAt(state, url(target))!
        await expect.poll(() => activeTabId(running.page)).toBe(child.id)
        if (on) {
          await chooseMenuEntry(running.app, 'CmdOrCtrl+[')
          await waitForState(running.page, (s) => !s.state.tabs.some((tab) => tab.id === child.id), 'the tab closed by Back')
          await expect.poll(() => activeTabId(running.page)).toBe(opener.id)
        } else {
          // Nothing to go back to in the tab: the entry is greyed out, and the tab stays where it is.
          await expect.poll(() => menuEntryState(running.app, 'CmdOrCtrl+[')).toBe('disabled')
          await expectStays(async () => (await snapshotOf(running.page)).state.tabs.some((tab) => tab.id === child.id), true, 'the tab the link opened stays while the function is off', 500)
        }
      } finally {
        await local.close()
      }
    }
  })

  test('peek-shift: ⇧-click on a link opens it in a Glance while on; off, in a tab', async () => {
    for (const on of [true, false]) {
      await setSettings(running.page, { peekWithShift: on })
      const target = on ? '/b' : '/c'
      const local = await serveSite({ '/links': linkPage('Liens', url(target)) })
      try {
        const page = await openTab(running, `${local.origin}/links`, 'Liens')
        await page.page.click('#link', { modifiers: ['Shift'] })
        if (on) {
          await waitForPanel(running.app, '.pk-card')
          await waitForWindow(running.app, (address) => address === url(target))
          expect(tabAt(await snapshotOf(running.page), url(target))).toBeUndefined()
          await running.page.evaluate(() => (globalThis as unknown as { lucium: { closeOverlay(): void } }).lucium.closeOverlay())
          await expect.poll(() => overlayShown(running.app)).toBe(false)
        } else {
          await waitForState(running.page, (s) => tabAt(s, url(target)) !== undefined, 'the link in a tab')
          expect(await overlayShown(running.app)).toBe(false)
        }
      } finally {
        await local.close()
      }
    }
  })

  test('peek-external: a link to another site that opens a tab opens it in a Glance while on; off, in a tab', async () => {
    // A link that opens a new tab on another site goes to a mini window by default (littleArcNewTabLinks, a rule of its own that comes after
    // the Glance in shared/little-modifier.ts `linkWindowDestination`): it is switched off here, so that with the Glance off the link opens
    // a tab. Without that the control waited for a tab that the application, rightly, never opened.
    await setSettings(running.page, { littleArcNewTabLinks: false })
    for (const on of [true, false]) {
      await setSettings(running.page, { peekOnExternalLinks: on })
      const target = otherSite(on ? '/b' : '/c')
      const local = await serveSite({ '/links': linkPage('Liens', target, true) })
      try {
        const page = await openTab(running, `${local.origin}/links`, 'Liens')
        await page.page.click('#link')
        if (on) {
          await waitForPanel(running.app, '.pk-card')
          await waitForWindow(running.app, (address) => address === target)
          expect(tabAt(await snapshotOf(running.page), target)).toBeUndefined()
          await running.page.evaluate(() => (globalThis as unknown as { lucium: { closeOverlay(): void } }).lucium.closeOverlay())
          await expect.poll(() => overlayShown(running.app)).toBe(false)
        } else {
          await waitForState(running.page, (s) => tabAt(s, target) !== undefined, 'the link in a tab')
          expect(await overlayShown(running.app)).toBe(false)
        }
      } finally {
        await local.close()
      }
    }
  })

  test('external-links-little: a link sent by another application opens in a mini window while on; off, in a tab of the window', async () => {
    const sendLink = (address: string) => running.app.evaluate(({ app }, link) => void app.emit('open-url', { preventDefault: () => undefined }, link), address)
    const littleWindows = () => running.app.windows().filter((page) => page.url().includes('littlearc')).length
    await setSettings(running.page, { externalLinksInLittleArc: true })
    await sendLink(url('/b'))
    await expect.poll(littleWindows).toBe(1)
    await waitForWindow(running.app, (address) => address === url('/b'))
    expect(tabAt(await snapshotOf(running.page), url('/b'))).toBeUndefined()

    await setSettings(running.page, { externalLinksInLittleArc: false })
    await sendLink(url('/c'))
    await waitForState(running.page, (s) => tabAt(s, url('/c')) !== undefined, 'the link in a tab')
    expect(littleWindows()).toBe(1)
  })

  test('little-modifier: ⌥⌘-click on a link opens it in a mini window while on; off, no mini window', async () => {
    const littleWindows = () => running.app.windows().filter((page) => page.url().includes('littlearc')).length
    for (const on of [false, true]) {
      await setSettings(running.page, { littleArcModifier: on })
      const target = on ? '/b' : '/c'
      const local = await serveSite({ '/links': linkPage('Liens', url(target)) })
      try {
        const page = await openTab(running, `${local.origin}/links`, 'Liens')
        // ⌥⌘ on macOS, Alt+Ctrl elsewhere: the key that opens a link in a new tab is Cmd on macOS and Ctrl on Windows and Linux, and `Meta` is the Super key there.
        await page.page.click('#link', { modifiers: ['Alt', 'ControlOrMeta'] })
        if (on) {
          await expect.poll(littleWindows).toBe(1)
          await waitForWindow(running.app, (address) => address === url(target))
        } else {
          await expectStays(littleWindows, 0, 'no mini window opens while the function is off', 1500)
        }
      } finally {
        await local.close()
      }
    }
  })
})

test('auto-archive: a tab of Today left aside longer than the delay is archived at launch; with "Jamais", it stays', async () => {
  running = await launchLucium()
  const stale = await openTab(running, url('/a'), 'Page A')
  await openTab(running, url('/b'), 'Page B')
  await waitForStateFile(running.dataDir)
  await expect.poll(() => stateOnDisk(running.dataDir).tabs.filter((tab) => tab['url'] === url('/a') || tab['url'] === url('/b')).length).toBe(2)
  const dataDir = running.dataDir
  await running.close({ keepData: true })

  // Two days without a look at page A; archiving set to "Jamais" (0): the tab must stay.
  const twoDaysAgo = Date.now() - 48 * 3600_000
  editStateOnDisk(dataDir, (state) => {
    for (const tab of state.tabs) if (tab['id'] === stale.id) tab['lastActiveAt'] = twoDaysAgo
    state.settings['autoArchiveHours'] = 0
  })
  running = await launchLucium({ dataDir })
  await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.id === stale.id), 'the state read again')
  const kept = async () => {
    const read = await snapshotOf(running.page)
    return { tab: read.state.tabs.some((tab) => tab.id === stale.id), archived: read.state.archive.some((entry) => entry.url === url('/a')) }
  }
  await expectStays(kept, { tab: true, archived: false }, 'the tab is not archived with archiving set to "Jamais"', 1500)
  let state = await snapshotOf(running.page)
  await running.close({ keepData: true })

  // The same tab, archiving after 12 hours: the pass made at launch archives it.
  editStateOnDisk(dataDir, (state) => {
    for (const tab of state.tabs) if (tab['id'] === stale.id) tab['lastActiveAt'] = twoDaysAgo
    state.settings['autoArchiveHours'] = 12
  })
  running = await launchLucium({ dataDir })
  state = await waitForState(running.page, (s) => s.state.archive.some((entry) => entry.url === url('/a')), 'archived at launch')
  expect(state.state.tabs.some((tab) => tab.id === stale.id)).toBe(false)
  expect(tabAt(state, url('/b'))).toBeDefined()
})

// The sweep that puts tabs to sleep runs once a minute (SLEEP_SWEEP_MS, browser.ts): the test waits for one pass. The delay is set to a
// second (the setting takes any number of minutes; the Settings offer whole ones), so that the pass finds the tabs left aside idle enough.
test('sleep: a tab left aside longer than the delay is put to sleep by the next pass; a site excluded from the sleep stays awake', async () => {
  test.setTimeout(150_000)
  running = await launchLucium()
  const awake = async (id: string) => ((await snapshotOf(running.page)) as unknown as { runtime: { tabs: Record<string, { awake?: boolean }> } }).runtime.tabs[id]?.awake
  const sleeper = await openTab(running, url('/a'), 'Page A')
  const kept = await openTab(running, otherSite('/b'), 'Page B')
  await openTab(running, url('/c'), 'Page C')
  await dispatch(running.page, { type: 'sleep/exclude-site', site: `other.${TEST_DOMAIN}`, excluded: true })
  await setSettings(running.page, { sleepAfterMinutes: 1 / 60, sleepSkipPinned: false })
  expect(await awake(sleeper.id)).toBe(true)
  await expect.poll(() => awake(sleeper.id), { timeout: 75_000, intervals: [2000] }).toBe(false)
  expect(await awake(kept.id)).toBe(true)
})
