// What a launch loads on a profile shaped like one used for months: four spaces, a hundred pinned tabs (most of them in nested folders, one space
// holding most of them), Today tabs hung in the tab tree, favourites with the tabs they opened, a split view, two more windows restored (one of
// them on the tab the main window shows), and seven sites never put to sleep, 22 tabs on six of them. Only the tab each window shows, the tabs
// marked "never put to sleep" and one tab per site never put to sleep that no window shows get a page; the others sleep until they are shown.
// Then "Actualiser tous les onglets" with « Réveiller aussi les onglets en veille »: every sleeping tab is loaded afresh and put back to sleep,
// a few at a time. Every tab and every address is made up by the test (pages served on 127.0.0.1); nothing leaves the machine. The tests print
// the pages and renderer processes they counted.

import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { RELOAD_ALL_AWAKE_MAX } from '../../src/shared/reload-all'
import { launchLucium, type Running } from './launch'
import { chooseMenuEntry, chooseMenuLabel, dispatch, editStateOnDisk, serveSite, snapshotOf, stateOnDisk, titledPage, waitForState, waitForStateFile, expectStays, type LocalSite, type Snapshot } from './helpers'

/** Pinned and Today tabs of each space: one space holds most of the pinned tabs, as a profile used for long does. */
const PINNED = [12, 70, 8, 10]
const TODAY = [7, 11, 2, 7]
const FAVORITES = 8
/** The folders of each space: a root folder, a folder in it and one in that one, then a root folder of its own; the last one stands at the bottom. */
const FOLDERS_PER_SPACE = 7
/** How long the picture of each tab's page takes to come: a page has finished loading only then, so that the pages of a run overlap as real ones do. */
const PICTURE_MS = 1500
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

let site: LocalSite
let pictures: { port: number; asked: number; close: () => Promise<void> }
let running: Running | undefined

type TabRow = Record<string, unknown> & { id: string }
type WithRuntime = Snapshot & { runtime: { tabs: Record<string, { awake: boolean } | undefined> } }

const pinnedId = (s: number, n: number) => `pin-${s}-${n}`
const todayId = (s: number, n: number) => `day-${s}-${n}`
const favoriteTabId = (s: number, k: number) => `fav-${s}-${k}`
const allIds = (): string[] => [
  ...PINNED.flatMap((count, s) => Array.from({ length: count }, (_, n) => pinnedId(s, n))),
  ...TODAY.flatMap((count, s) => Array.from({ length: count }, (_, n) => todayId(s, n))),
  ...[0, 1, 3].flatMap((s) => Array.from({ length: 3 }, (_, k) => favoriteTabId(s, k)))
]

/** The tab the main window shows (fourth space), and the one the restored window shows (third space). */
const SHOWN_MAIN = pinnedId(3, 5)
const SHOWN_SECOND = todayId(2, 0)
const MARKED_AWAKE = [pinnedId(1, 40), todayId(2, 1)]
/** On the sites the user never puts to sleep: test names that map to 127.0.0.1 (see launch.ts). 22 tabs on six sites; the seventh has none. */
const NEVER_ASLEEP_SITE: Record<string, string> = {
  // Seven tabs in three spaces: the one in the space the restored window shows comes first, though two spaces come before it in their order.
  ...Object.fromEntries([pinnedId(0, 1), pinnedId(1, 0), pinnedId(1, 1), pinnedId(1, 2), pinnedId(1, 3), todayId(1, 0), pinnedId(2, 1)].map((id) => [id, 'chat.e2e.test'])),
  // One of them in the space the main window shows.
  ...Object.fromEntries([pinnedId(1, 4), pinnedId(2, 0), pinnedId(1, 5), todayId(3, 0)].map((id) => [id, 'mail.e2e.test'])),
  // A subdomain is its site. The first in the order of the state stands in a folder at the bottom; the first of the sidebar is a loose pinned tab.
  [pinnedId(1, 6)]: 'app.docs.e2e.test',
  [pinnedId(1, 8)]: 'docs.e2e.test',
  [pinnedId(1, 19)]: 'docs.e2e.test',
  // The tab the main window shows is on this site: no other is loaded for it.
  ...Object.fromEntries([SHOWN_MAIN, pinnedId(1, 10), todayId(1, 3)].map((id) => [id, 'news.e2e.test'])),
  // A tab marked "never put to sleep" is on this one: no other is loaded for it, not even one that comes first in the sidebar.
  ...Object.fromEntries([pinnedId(1, 40), pinnedId(1, 11), pinnedId(0, 2)].map((id) => [id, 'video.e2e.test'])),
  // A favourite's tab comes before the rows of its space.
  [pinnedId(1, 12)]: 'music.e2e.test',
  [favoriteTabId(1, 0)]: 'music.e2e.test'
}
const EXCLUDED_HOSTS = ['chat.e2e.test', 'mail.e2e.test', 'docs.e2e.test', 'news.e2e.test', 'video.e2e.test', 'music.e2e.test', 'absent.e2e.test']
/**
 * One tab per site never put to sleep that no window shows and no marked tab is on: chat (in the space the restored window shows, which only a
 * launch that knows what the restored windows show prefers), mail (in the space of the main window), docs, music.
 */
const ONE_PER_SITE = [pinnedId(2, 1), todayId(3, 0), pinnedId(1, 19), favoriteTabId(1, 0)]
const EXPECTED = [SHOWN_MAIN, SHOWN_SECOND, ...MARKED_AWAKE, ...ONE_PER_SITE].sort()

test.beforeAll(async () => {
  pictures = await servePictures()
  const pages: Record<string, string> = {}
  for (const id of allIds()) pages[`/t/${id}`] = titledPage(`Onglet ${id}`, `<p>Texte de test.</p><img alt="" width="1" height="1" src="http://127.0.0.1:${pictures.port}/p/${id}.gif">`)
  for (let k = 0; k < FAVORITES; k++) pages[`/favorite/${k}`] = titledPage(`Favori ${k}`)
  site = await serveSite(pages)
})

test.afterAll(async () => {
  await site.close()
  await pictures.close()
})

test.afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A server of small pictures that answers each request after `PICTURE_MS`, never from a cache. */
async function servePictures(): Promise<{ port: number; asked: number; close: () => Promise<void> }> {
  const served = { asked: 0 }
  const server = createServer((_request, response) => {
    served.asked++
    setTimeout(() => {
      response.setHeader('content-type', 'image/gif')
      response.setHeader('cache-control', 'no-store')
      response.end(GIF)
    }, PICTURE_MS)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return Object.assign(served, {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  })
}

/** The web contents of the test's tabs, every web page of the application, and the renderer processes of the whole application. */
async function census(app: ElectronApplication): Promise<{ tabs: number; webPages: number; renderers: number }> {
  return app.evaluate(({ app: electronApp, webContents }, prefix: string) => {
    const live = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    return {
      tabs: live.filter((wc) => wc.getURL().includes(prefix)).length,
      webPages: live.filter((wc) => /^https?:/.test(wc.getURL())).length,
      renderers: electronApp.getAppMetrics().filter((metric) => metric.type === 'Tab').length
    }
  }, `:${site.port}/t/`)
}

/** The tabs whose page is alive now (a web contents on the tab's address), sorted. */
async function liveTabs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }, prefix: string) => {
    const ids = webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed())
      .map((wc) => wc.getURL())
      .filter((url) => url.includes(prefix))
      .map((url) => url.slice(url.indexOf(prefix) + prefix.length))
    return [...new Set(ids)].sort()
  }, `:${site.port}/t/`)
}

/** The tabs whose page the server was asked for since `from`, each once. */
function tabsAsked(from: number): string[] {
  return [...new Set(site.requests.slice(from).map((request) => /^\/t\/([\w-]+)$/.exec(request.path)?.[1]).filter((id): id is string => id !== undefined))].sort()
}

/** The state of a profile used for long, written over the one a first launch made (its spaces, its settings). */
function longUsedProfile(state: ReturnType<typeof stateOnDisk>, spaces: string[], settings: Record<string, unknown>): void {
  const now = Date.now()
  const urlOf = (id: string) => `http://${NEVER_ASLEEP_SITE[id] ?? '127.0.0.1'}:${site.port}/t/${id}`
  const folders: Array<Record<string, unknown>> = []
  spaces.forEach((spaceId, s) => {
    for (let f = 0; f < FOLDERS_PER_SPACE; f++) {
      // f0 ⊃ f1 ⊃ f2, f3 ⊃ f4, f5 at the root, f6 at the root and at the bottom; one folder of two is folded.
      const parent = f === 1 ? 0 : f === 2 ? 1 : f === 4 ? 3 : undefined
      folders.push({
        id: `folder-${s}-${f}`,
        spaceId,
        name: `Dossier ${s}.${f}`,
        collapsed: f % 2 === 1,
        ...(parent !== undefined ? { parentId: `folder-${s}-${parent}` } : {}),
        ...(f === 6 ? { atBottom: true } : {})
      })
    }
  })
  const favorites = Array.from({ length: FAVORITES }, (_, k) => ({ id: `favorite-${k}`, url: `${site.origin}/favorite/${k}`, title: `Favori ${k}`, faviconUrl: `${site.origin}/favorite-${k}.png`, profileId: 'default' }))
  const base = (id: string, spaceId: string, n: number): TabRow => ({
    id,
    spaceId,
    url: urlOf(id),
    title: `Onglet ${id}`,
    // Most tabs have the icon of their site, a few an emoji or a name the user gave them.
    ...(n % 7 === 6 ? { icon: '⭐' } : { faviconUrl: `${site.origin}/icon-${id}.png` }),
    ...(n % 9 === 4 ? { customTitle: `Nom ${id}` } : {}),
    createdAt: now - 86_400_000,
    lastActiveAt: now - 3_600_000 - n * 1000
  })
  const tabs: TabRow[] = []
  spaces.forEach((spaceId, s) => {
    for (let n = 0; n < PINNED[s]!; n++) {
      const id = pinnedId(s, n)
      // Nine pinned tabs of ten are in a folder, spread over the folders of the space.
      tabs.push({ ...base(id, spaceId, n), pinned: true, anchorUrl: urlOf(id), ...(n % 10 !== 9 ? { folderId: `folder-${s}-${n % FOLDERS_PER_SPACE}` } : {}) })
    }
    for (let n = 0; n < TODAY[s]!; n++) {
      // The tab tree: the second and third Today tabs hang under the first, the fifth under the second (folded).
      const parent = n === 1 || n === 2 ? 0 : n === 4 ? 1 : undefined
      tabs.push({ ...base(todayId(s, n), spaceId, n), pinned: false, ...(parent !== undefined ? { parentId: todayId(s, parent) } : {}), ...(n === 1 ? { treeCollapsed: true } : {}) })
    }
  })
  // The tabs the favourites opened in three of the spaces: their tiles stand for them, no list shows them.
  for (const s of [0, 1, 3]) for (let k = 0; k < 3; k++) tabs.push({ ...base(favoriteTabId(s, k), spaces[s]!, k), pinned: false, favoriteId: `favorite-${k}` })
  for (const id of MARKED_AWAKE) tabs.find((tab) => tab.id === id)!['keepAwake'] = true
  state.tabs = tabs
  state['folders'] = folders
  state['favorites'] = favorites
  // A split view in a space no window shows: neither of its panes is on screen.
  state['splits'] = [{ id: 'split-1', spaceId: spaces[1], tabIds: [todayId(1, 5), todayId(1, 6)], orientation: 'horizontal', ratios: [0.5, 0.5] }]
  // The main window is on the fourth space; every space remembers a tab of its own (the second one, a pane of the split view).
  state['activeSpaceId'] = spaces[3]!
  state['activeTabBySpace'] = { [spaces[0]!]: todayId(0, 4), [spaces[1]!]: todayId(1, 5), [spaces[2]!]: pinnedId(2, 3), [spaces[3]!]: SHOWN_MAIN }
  Object.assign(state.settings, {
    warnBeforeQuitting: false,
    restoreWindows: true,
    tabTree: true,
    sleepMode: 'discard',
    sleepAfterMinutes: 30,
    sleepSkipPinned: false,
    sleepExcludedHosts: EXCLUDED_HOSTS,
    loadAllTabsAtLaunch: false,
    ...settings
  })
}

/**
 * A first launch makes the state of a profile and the windows file of three windows (the main one and two more); the state is then that of a
 * profile used for long, and the launch the test measures starts on it. Resolves the index of the first request of that launch.
 */
async function launchLongUsedProfile(settings: Record<string, unknown> = {}): Promise<number> {
  running = await launchLucium()
  const dataDir = running.dataDir
  for (const name of ['Deux', 'Trois', 'Quatre']) await dispatch(running.page, { type: 'space/create', name, emoji: name[0], hue: 60 })
  await waitForState(running.page, (s) => s.state.spaces.length === PINNED.length, 'four spaces')
  await dispatch(running.page, { type: 'settings/update', patch: { restoreWindows: true } })
  await chooseMenuEntry(running.app, 'CmdOrCtrl+N')
  await chooseMenuEntry(running.app, 'CmdOrCtrl+N')
  await expect.poll(() => running!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('/index.html')).length)).toBe(3)
  await waitForStateFile(dataDir)
  await expect.poll(() => (stateOnDisk(dataDir)['spaces'] as unknown[]).length).toBe(PINNED.length)
  await running.close({ keepData: true })
  running = undefined

  let spaces: string[] = []
  editStateOnDisk(dataDir, (state) => {
    spaces = (state['spaces'] as Array<{ id: string }>).map((space) => space.id)
    longUsedProfile(state, spaces, settings)
  })
  const path = join(dataDir, 'windows.json')
  const session = JSON.parse(readFileSync(path, 'utf8')) as { windows: Array<Record<string, unknown>> }
  expect(session.windows).toHaveLength(2)
  // One restored window on the third space (with a tab remembered in the first); the other on the tab the main window shows, which lives in one window only.
  session.windows[0] = { ...session.windows[0], spaceId: spaces[2], tabs: { [spaces[2]!]: SHOWN_SECOND, [spaces[0]!]: todayId(0, 2) } }
  session.windows[1] = { ...session.windows[1], spaceId: spaces[3], tabs: { [spaces[3]!]: SHOWN_MAIN } }
  writeFileSync(path, JSON.stringify(session))

  const asked0 = site.requests.length
  running = await launchLucium({ dataDir })

  // The state came back whole: every tab, folder and favourite is there (a profile the launch had trimmed would prove nothing).
  const snapshot = (await waitForState(running.page, (s) => s.state.tabs.length === allIds().length, 'every tab of the profile')) as WithRuntime
  expect(snapshot.state.tabs.filter((tab) => tab.pinned)).toHaveLength(PINNED.reduce((a, b) => a + b, 0))
  expect(snapshot.state.folders).toHaveLength(PINNED.length * FOLDERS_PER_SPACE)
  expect(snapshot.state.favorites).toHaveLength(FAVORITES)
  await expect.poll(() => running!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('/index.html')).length)).toBe(3)
  return asked0
}

test('a profile of four spaces and a hundred pinned tabs in folders, with two windows restored, loads at the launch what is shown, what is marked and one tab per site never put to sleep', async () => {
  const asked0 = await launchLongUsedProfile()

  await expect.poll(() => tabsAsked(asked0), { message: 'the pages of the launch', timeout: 30_000 }).toEqual(EXPECTED)
  // Time for anything else the launch would load (the lookup of icons starts after 1.5 s, the sweep of sleep after a minute).
  await expectStays(() => tabsAsked(asked0), EXPECTED, 'the launch asks for no other page', 5000)
  const counted = await census(running!.app)
  const listed = Object.keys(NEVER_ASLEEP_SITE).length
  console.log(`[launch-pinned] ${counted.tabs} tab page(s) of ${allIds().length} tabs (${listed} on ${EXCLUDED_HOSTS.length} sites never put to sleep), ${counted.webPages} web page(s), ${counted.renderers} renderer process(es)`)
  expect(counted.tabs).toBe(EXPECTED.length)
  // No other web page either (a favourite's own address, an icon lookup made as a page): the test's tabs are all the pages there are.
  expect(counted.webPages).toBe(EXPECTED.length)
  // The renderers: the pages, the three surfaces of each of the three windows, and a few more Chromium keeps (a spare one, a utility page).
  expect(counted.renderers).toBeLessThan(EXPECTED.length + 3 * 3 + 8)

  // A tab of a folder, a favourite's tab, a pane of the split view, and the other tabs of the sites never put to sleep sleep like a tab the delay put
  // to sleep; the tabs kept awake are awake.
  const now = (await snapshotOf(running!.page)) as WithRuntime
  for (const id of [pinnedId(1, 20), favoriteTabId(1, 1), todayId(1, 5), pinnedId(0, 1), pinnedId(1, 0), pinnedId(1, 6), pinnedId(0, 2), pinnedId(1, 10)]) expect(now.runtime.tabs[id]?.awake, id).toBe(false)
  for (const id of EXPECTED) expect(now.runtime.tabs[id]?.awake, id).toBe(true)
})

test('« Actualiser tous les onglets » with « Réveiller aussi les onglets en veille » loads every sleeping tab afresh, a few at a time, and puts them back to sleep', async () => {
  test.setTimeout(240_000)
  const asked0 = await launchLongUsedProfile({ reloadAllWakes: true })
  await expect.poll(() => tabsAsked(asked0), { message: 'the pages of the launch', timeout: 30_000 }).toEqual(EXPECTED)
  await expect.poll(() => liveTabs(running!.app), { timeout: 30_000 }).toEqual(EXPECTED)

  // What stays awake once the run is over: what was awake, and the tabs it woke that the sleep spares (the sites never put to sleep).
  const kept = [...new Set([...EXPECTED, ...Object.keys(NEVER_ASLEEP_SITE)])].sort()
  const sleeping = allIds().filter((id) => !EXPECTED.includes(id))
  // The pages alive are counted every 20 ms in the main process, for the whole run: those that will be put back to sleep, and all of them.
  await running!.app.evaluate(({ webContents }, [prefix, keptIds]) => {
    const keep = new Set(keptIds)
    const peak = { asleepAgain: 0, all: 0, unnamed: 0, timer: undefined as NodeJS.Timeout | undefined }
    peak.timer = setInterval(() => {
      const urls = webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed())
        .map((wc) => wc.getURL())
      const tabs = urls.filter((url) => url.includes(prefix)).map((url) => url.slice(url.indexOf(prefix) + prefix.length))
      peak.asleepAgain = Math.max(peak.asleepAgain, tabs.filter((id) => !keep.has(id)).length)
      peak.all = Math.max(peak.all, tabs.length)
      // A page made a moment ago may not have an address yet: counted apart, so that it is seen if it ever piles up.
      peak.unnamed = Math.max(peak.unnamed, urls.filter((url) => url === '').length)
    }, 20)
    ;(globalThis as unknown as { reloadPeak: typeof peak }).reloadPeak = peak
  }, [`:${site.port}/t/`, kept] as const)
  const before = (await snapshotOf(running!.page)) as Snapshot & { state: { activeTabBySpace: Record<string, string | null> } }
  const picturesBefore = pictures.asked
  const asked1 = site.requests.length
  const startedAt = Date.now()
  // The entry of the View menu, in the language of the interface.
  const chosen = await chooseMenuLabel(running!.app, 'Actualiser tous les onglets')
  expect(chosen === 'ok' ? chosen : await chooseMenuLabel(running!.app, 'Reload All Tabs')).toBe('ok')

  // Every sleeping tab is loaded afresh, and the run ends with only the tabs kept awake alive.
  await expect.poll(() => sleeping.filter((id) => !tabsAsked(asked1).includes(id)), { message: 'the sleeping tabs loaded afresh', timeout: 180_000, intervals: [500] }).toEqual([])
  await expect.poll(() => liveTabs(running!.app), { message: 'only the tabs kept awake alive', timeout: 60_000, intervals: [500] }).toEqual(kept)
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  // Nothing wakes afterwards.
  await expectStays(() => liveTabs(running!.app), kept, 'no tab wakes afterwards', 3000)
  const peak = await running!.app.evaluate(() => {
    const found = (globalThis as unknown as { reloadPeak: { asleepAgain: number; all: number; unnamed: number; timer: NodeJS.Timeout } }).reloadPeak
    clearInterval(found.timer)
    return { asleepAgain: found.asleepAgain, all: found.all, unnamed: found.unnamed }
  })
  const counted = await census(running!.app)
  console.log(
    `[launch-pinned] reload all: ${sleeping.length} sleeping tabs loaded afresh in ${seconds} s (${pictures.asked - picturesBefore} pictures asked); at most ${peak.asleepAgain} page(s) awaiting their sleep at once (limit ${RELOAD_ALL_AWAKE_MAX}), at most ${peak.all} tab page(s) alive, ${peak.unnamed} page(s) without an address; at the end ${counted.tabs} tab page(s) (${kept.length} kept awake), ${counted.renderers} renderer process(es)`
  )
  // The pictures came (the pages took their time to load), so the run did have more pages waiting than it lets load at once.
  expect(pictures.asked - picturesBefore).toBeGreaterThanOrEqual(sleeping.length)
  expect(peak.asleepAgain).toBeGreaterThan(0)
  expect(peak.asleepAgain).toBeLessThanOrEqual(RELOAD_ALL_AWAKE_MAX)
  expect(peak.all).toBeLessThanOrEqual(kept.length + RELOAD_ALL_AWAKE_MAX)
  expect(counted.tabs).toBe(kept.length)

  // The tab shown is still the one shown: waking and putting to sleep select nothing.
  const after = (await snapshotOf(running!.page)) as typeof before
  expect(after.state.activeSpaceId).toBe(before.state.activeSpaceId)
  expect(after.state.activeTabBySpace[after.state.activeSpaceId]).toBe(before.state.activeTabBySpace[before.state.activeSpaceId])
})
