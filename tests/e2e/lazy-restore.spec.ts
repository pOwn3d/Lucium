// What a launch on a profile with many tabs loads: the tab each window shows (both panes of a split view on screen) and the tabs the user keeps
// awake, nothing else. The other tabs sleep, with the title and icon of the state, until they are shown. The profile is made by the test
// (30 tabs in 3 spaces, pages served on 127.0.0.1); nothing leaves the machine. Each test prints the pages and renderer processes it counted.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { chooseMenuEntry, dispatch, editStateOnDisk, serveSite, snapshotOf, stateOnDisk, titledPage, waitForState, waitForStateFile, waitForWindow, expectStays, type LocalSite, type Snapshot } from './helpers'

const SPACES = 3
const TABS_PER_SPACE = 10
const ALL_TABS = SPACES * TABS_PER_SPACE

let site: LocalSite
let running: Running | undefined

test.beforeAll(async () => {
  const pages: Record<string, string> = {}
  for (let s = 0; s < SPACES; s++) for (let n = 0; n < TABS_PER_SPACE; n++) pages[`/s${s}/t${n}`] = titledPage(`Espace ${s} onglet ${n}`)
  site = await serveSite(pages)
})

test.afterAll(async () => {
  await site.close()
})

test.afterEach(async () => {
  await running?.close()
  running = undefined
})

type WithRuntime = Snapshot & { runtime: { tabs: Record<string, { loading: boolean; audible: boolean; muted: boolean; awake: boolean } | undefined> } }

/** The web contents of the tabs of the test (their address is on the test's server), and the renderer processes of the whole application. */
async function census(app: ElectronApplication): Promise<{ pages: number; renderers: number }> {
  return app.evaluate(({ app: electronApp, webContents }, prefix: string) => {
    const pages = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().includes(prefix)).length
    const renderers = electronApp.getAppMetrics().filter((metric) => metric.type === 'Tab').length
    return { pages, renderers }
  }, `:${site.port}/s`)
}

/** The paths of the test's pages the server was asked for since `from` (the index of the first request to look at), each once. */
function pagesAsked(from: number): string[] {
  return [...new Set(site.requests.slice(from).map((request) => request.path).filter((path) => /^\/s\d\/t\d$/.test(path)))].sort()
}

/** What the launch loaded, once it had the time to load anything it would: the pages asked of the server, and the count of pages and processes. */
async function afterLaunch(label: string, expected: string[]): Promise<{ pages: number; renderers: number }> {
  await expect.poll(() => pagesAsked(asked0), { message: `the pages of the launch (${label})`, timeout: 30_000 }).toEqual(expected)
  // Time for anything else the launch would load.
  await expectStays(() => pagesAsked(asked0), expected, `the launch asks for no other page (${label})`, 2500)
  const counted = await census(running!.app)
  console.log(`[lazy-restore] ${label}: ${counted.pages} tab page(s) of ${ALL_TABS}, ${counted.renderers} renderer process(es)`)
  return counted
}

let asked0 = 0

/**
 * Launches once to get a state file (and, with `secondWindow`, a windows.json with a second window), writes 30 tabs in 3 spaces into the state
 * (each with a title and an icon, as a profile that was used has them), and launches again on it: the launch the test measures.
 */
async function launchOnManyTabs(options: { settings?: Record<string, unknown>; edit?: (state: ReturnType<typeof stateOnDisk>, spaces: string[]) => void; secondWindow?: (spaces: string[]) => Record<string, string | null> } = {}): Promise<string[]> {
  running = await launchLucium()
  const dataDir = running.dataDir
  await dispatch(running.page, { type: 'space/create', name: 'Deux', emoji: '2', hue: 120 })
  await dispatch(running.page, { type: 'space/create', name: 'Trois', emoji: '3', hue: 240 })
  await waitForState(running.page, (s) => s.state.spaces.length === SPACES, 'three spaces')
  if (options.secondWindow) {
    await dispatch(running.page, { type: 'settings/update', patch: { restoreWindows: true } })
    await chooseMenuEntry(running.app, 'CmdOrCtrl+N')
    await expect.poll(() => running!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('/index.html')).length)).toBe(2)
  }
  await waitForStateFile(dataDir)
  await expect.poll(() => (stateOnDisk(dataDir)['spaces'] as unknown[]).length).toBe(SPACES)
  await running.close({ keepData: true })
  running = undefined
  let spaceIds: string[] = []
  editStateOnDisk(dataDir, (state) => {
    spaceIds = (state['spaces'] as Array<{ id: string }>).map((space) => space.id)
    const now = Date.now()
    state.tabs = spaceIds.flatMap((spaceId, s) =>
      Array.from({ length: TABS_PER_SPACE }, (_, n) => ({
        id: `lazy-${s}-${n}`,
        spaceId,
        url: `${site.origin}/s${s}/t${n}`,
        title: `Espace ${s} onglet ${n}`,
        faviconUrl: `${site.origin}/favicon-${s}-${n}.png`,
        pinned: n < 2,
        createdAt: now - 60_000,
        lastActiveAt: now - 60_000
      }))
    )
    // The first space is on screen, with its fourth tab; each other space remembers a tab of its own.
    state['activeSpaceId'] = spaceIds[0]!
    state['activeTabBySpace'] = Object.fromEntries(spaceIds.map((spaceId, s) => [spaceId, `lazy-${s}-3`]))
    Object.assign(state.settings, { warnBeforeQuitting: false, restoreWindows: options.secondWindow !== undefined, ...options.settings })
    options.edit?.(state, spaceIds)
  })
  if (options.secondWindow) {
    const path = join(dataDir, 'windows.json')
    const session = JSON.parse(readFileSync(path, 'utf8')) as { windows: Array<Record<string, unknown>> }
    expect(session.windows).toHaveLength(1)
    session.windows[0] = { ...session.windows[0], spaceId: spaceIds[1], tabs: options.secondWindow(spaceIds) }
    writeFileSync(path, JSON.stringify(session))
  }
  asked0 = site.requests.length
  running = await launchLucium({ dataDir })
  return spaceIds
}

test('a launch loads the tab on screen only: the other 29 tabs sleep, with their title and icon, and load when they are shown', async () => {
  await launchOnManyTabs()
  const counted = await afterLaunch('defaults', ['/s0/t3'])
  expect(counted.pages).toBe(1)

  // A tab never loaded since the launch is asleep exactly as one the delay put to sleep: the state's title and icon, the entry of a sleeping tab.
  const snapshot = (await snapshotOf(running!.page)) as WithRuntime
  const sleeping = snapshot.state.tabs.find((tab) => tab.id === 'lazy-1-5') as Snapshot['state']['tabs'][number] & { faviconUrl?: string }
  expect(sleeping.title).toBe('Espace 1 onglet 5')
  expect(sleeping.faviconUrl).toBe(`${site.origin}/favicon-1-5.png`)
  expect(snapshot.runtime.tabs['lazy-1-5']).toEqual({ loading: false, audible: false, muted: false, awake: false })
  expect(snapshot.runtime.tabs['lazy-0-3']?.awake).toBe(true)
  // Its row is dimmed and wears the "zz" of a sleeping tab (states of the tabs, on by default), as the row of a tab put to sleep does. The sidebar
  // of the window, not the one that slides over the page (the first view Playwright hands out may be either).
  const sidebar = await waitForWindow(running!.app, (url) => url.endsWith('/index.html'))
  const row = sidebar.locator('.sidebar .tab[data-id="lazy-0-5"]')
  await expect(row).toHaveClass(/\basleep\b/)
  await expect(row.locator('.tab-zz')).toHaveCount(1)

  // Shown, a sleeping tab loads (a click on its row, a shortcut, the search of tabs and ⌃Tab all select it), and only that one.
  await dispatch(running!.page, { type: 'tab/select', id: 'lazy-0-7' })
  await expect.poll(() => pagesAsked(asked0)).toEqual(['/s0/t3', '/s0/t7'])
  await waitForState(running!.page, (s) => (s as WithRuntime).runtime?.tabs['lazy-0-7']?.awake === true, 'the tab shown is awake')
  // Another space: the tab it remembers loads with it.
  await dispatch(running!.page, { type: 'space/select', id: snapshot.state.spaces[2]!.id })
  await expect.poll(() => pagesAsked(asked0)).toEqual(['/s0/t3', '/s0/t7', '/s2/t3'])
})

test('a launch loads the tabs the user keeps awake: a site never put to sleep, a tab marked so', async () => {
  // The list holds hosts; the test's pages are all on 127.0.0.1, so the listed host is a test name that maps there (see launch.ts).
  await launchOnManyTabs({
    edit: (state) => {
      const tab = state.tabs.find((t) => t['id'] === 'lazy-2-6')!
      tab['url'] = `http://messages.e2e.test:${site.port}/s2/t6`
      state.tabs.find((t) => t['id'] === 'lazy-1-8')!['keepAwake'] = true
      state.settings['sleepExcludedHosts'] = ['messages.e2e.test']
    }
  })
  const counted = await afterLaunch('a site never put to sleep and a marked tab', ['/s0/t3', '/s1/t8', '/s2/t6'])
  expect(counted.pages).toBe(3)
  // Woken behind, they did not take the screen: the tab on screen is the one the state says.
  const snapshot = (await snapshotOf(running!.page)) as WithRuntime
  expect((snapshot.state as unknown as { activeTabBySpace: Record<string, string> }).activeTabBySpace[snapshot.state.activeSpaceId]).toBe('lazy-0-3')
  expect(snapshot.runtime.tabs['lazy-2-6']?.awake).toBe(true)
})

test('a launch loads both panes of the split view on screen, and the tab a restored window shows', async () => {
  await launchOnManyTabs({
    edit: (state, spaces) => {
      state['splits'] = [{ id: 'lazy-split', spaceId: spaces[0], tabIds: ['lazy-0-3', 'lazy-0-4'], orientation: 'horizontal', ratios: [0.5, 0.5] }]
    },
    secondWindow: (spaces) => ({ [spaces[1]!]: 'lazy-1-6' })
  })
  const counted = await afterLaunch('a split view and a restored window', ['/s0/t3', '/s0/t4', '/s1/t6'])
  expect(counted.pages).toBe(3)
})

test('« Charger tous les onglets au lancement » loads every tab of every space at the launch', async () => {
  await launchOnManyTabs({ settings: { loadAllTabsAtLaunch: true } })
  const every = Array.from({ length: SPACES }, (_, s) => Array.from({ length: TABS_PER_SPACE }, (_, n) => `/s${s}/t${n}`)).flat().sort()
  const counted = await afterLaunch('« Charger tous les onglets au lancement »', every)
  expect(counted.pages).toBe(ALL_TABS)
  // Loaded behind, the tabs did not take the screen.
  const snapshot = (await snapshotOf(running!.page)) as Snapshot & { state: { activeTabBySpace: Record<string, string> } }
  expect(snapshot.state.activeTabBySpace[snapshot.state.activeSpaceId]).toBe('lazy-0-3')
})
