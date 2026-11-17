// What the application keeps between two launches, and what it makes of it: profiles (the cookies of each), the automatic copies of the
// session and their restoration, the windows put back where they were, the sheets of the first launch and of the news. Each test has its data
// folder (launchLucium); the ones that need a second launch quit, change the state file as the application could have written it, and launch
// again on the same folder.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { callBridge, dispatch, editStateOnDisk, openTab, overlayPage, serveSite, setSettings, stateOnDisk, tabAt, titledPage, waitForState, waitForStateFile, expectStays, snapshotOf, type LocalSite } from './helpers'

let site: LocalSite
let running: Running | undefined

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A'), '/b': titledPage('Page B'), '/cookie': { body: titledPage('Cookie posé'), headers: { 'set-cookie': 'e2e=1; Max-Age=3600; Path=/' } } })
})

test.afterAll(async () => {
  await site.close()
})

test.afterEach(async () => {
  await running?.close()
  running = undefined
})

const url = (path: string) => `${site.origin}${path}`

/** The cookies a profile keeps for an address (main process). */
function cookiesOf(app: ElectronApplication, profileId: string, address: string): Promise<string[]> {
  return app.evaluate(
    async ({ session }, [profile, target]) => (await session.fromPartition(`persist:profile-${profile}`).cookies.get({ url: target! })).map((cookie) => `${cookie.name}=${cookie.value}`),
    [profileId, address] as const
  )
}

interface Listing {
  enabled: boolean
  entries: Array<{ id: string; reason: string; tabs: number }>
}

test('a new profile: a space created with a profile of its own keeps the cookies of its pages apart from the default profile', async () => {
  running = await launchLucium()
  const run = running
  await dispatch(run.page, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 30, profileName: 'Profil travail' })
  const state = await waitForState(run.page, (s) => s.state.spaces.some((space) => space.name === 'Travail'), 'the space and its profile')
  const space = state.state.spaces.find((item) => item.name === 'Travail') as unknown as { id: string; profileId: string }
  expect(space.profileId).not.toBe('default')
  expect((state.state.settings['profileNames'] as Record<string, string>)[space.profileId]).toBe('Profil travail')

  await dispatch(run.page, { type: 'space/select', id: space.id })
  await waitForState(run.page, (s) => s.state.activeSpaceId === space.id, 'the space selected')
  await openTab(run, url('/cookie'), 'Cookie posé')
  await expect.poll(() => cookiesOf(run.app, space.profileId, url('/'))).toContain('e2e=1')
  expect(await cookiesOf(run.app, 'default', url('/'))).toEqual([])
})

test('auto-backup: switched on, a copy of the session is made at once; off, none is made, and a copy asked for can be restored', async () => {
  running = await launchLucium()
  const run = running
  const a = await openTab(run, url('/a'), 'Page A')
  await openTab(run, url('/b'), 'Page B')
  const list = () => callBridge<Listing>(run.page, 'sessionBackups')

  await setSettings(run.page, { autoBackup: false })
  await expect.poll(async () => (await list()).enabled).toBe(false)
  const before = (await list()).entries.length
  await openTab(run, url('/a?more'), 'Page A')
  await expectStays(async () => (await list()).entries.length, before, 'no copy of the session is made while the function is off', 800)

  // Switched on again: the first copy does not wait for the delay (30 minutes).
  await setSettings(run.page, { autoBackup: true })
  await expect.poll(async () => (await list()).entries.filter((entry) => entry.reason === 'auto').length).toBe(1)
  expect((await list()).entries.length).toBe(before + 1)

  // Restoration: a copy made now, a tab closed, the copy put back brings the tab back.
  const made = await callBridge<{ ok: boolean }>(run.page, 'backUpNow')
  expect(made.ok).toBe(true)
  const manual = (await list()).entries.find((entry) => entry.reason === 'manual')!
  await dispatch(run.page, { type: 'tab/close', id: a.id })
  await waitForState(run.page, (s) => tabAt(s, url('/a')) === undefined, 'page A closed')
  const restored = await callBridge<{ ok: boolean }>(run.page, 'restoreBackup', manual.id)
  expect(restored.ok).toBe(true)
  await waitForState(run.page, (s) => tabAt(s, url('/a')) !== undefined, 'page A back with the copy')
  // The session it replaced was copied first, to be put back in its turn.
  expect((await list()).entries.some((entry) => entry.reason === 'before-restore')).toBe(true)
})

test('restore-windows: the window opens again where it was left while on; off, it opens at its default place', async () => {
  const mainBounds = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'))!.getBounds())
  running = await launchLucium()
  const dataDir = running.dataDir
  // A place inside the screen of the machine, whatever its size: macOS shortens a window that would go past the bottom of the screen and moves it under
  // the menu bar, so a place written for a large screen is not the place the window takes on a small one (the screen of a CI runner). Smaller than the
  // default window (1360 × 860) and never smaller than the smallest window (720 × 480), so it is a place of its own on any screen.
  const placed = await running.app.evaluate(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea
    return { x: area.x + 60, y: area.y + 40, width: Math.max(720, Math.min(1000, area.width - 120)), height: Math.max(480, Math.min(600, area.height - 80)) }
  })
  await setSettings(running.page, { restoreWindows: true })
  await running.app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'))!.setBounds(bounds), placed)
  await expect.poll(() => mainBounds(running!.app), { message: 'the window takes the place it is given' }).toEqual(placed)
  await waitForStateFile(dataDir)
  await expect.poll(() => existsSync(join(dataDir, 'windows.json')), { message: 'windows.json written' }).toBe(true)
  await running.close({ keepData: true })

  running = await launchLucium({ dataDir })
  await expect.poll(() => mainBounds(running!.app)).toEqual(placed)
  await running.close({ keepData: true })

  // The same folder, the function off: the place kept in windows.json is not used. The window is given its place when it is made, before its page
  // loads: it is watched for a moment all the same, in case something moved it afterwards.
  editStateOnDisk(dataDir, (state) => {
    state.settings['restoreWindows'] = false
  })
  running = await launchLucium({ dataDir })
  const sameAsPlaced = async () => JSON.stringify(await mainBounds(running!.app)) === JSON.stringify(placed)
  await expectStays(sameAsPlaced, false, 'the window is not put back where it was while the function is off', 800)
})

/** Launches once to have a state file, then again with the settings of the sheets as `edit` sets them. Returns the layer of the panels. */
async function relaunchWith(edit: (settings: Record<string, unknown>) => void): Promise<Awaited<ReturnType<typeof overlayPage>>> {
  running = await launchLucium()
  const dataDir = running.dataDir
  await setSettings(running.page, { sidebarRight: false })
  await waitForStateFile(dataDir)
  await expect.poll(() => typeof stateOnDisk(dataDir).settings['lastSeenVersion']).toBe('string')
  await running.close({ keepData: true })
  editStateOnDisk(dataDir, (state) => edit(state.settings))
  running = await launchLucium({ dataDir })
  return overlayPage(running.app)
}

/** The sheet the layer shows a moment after the launch: the welcome, the guide of the first launch, the news, or none. */
async function sheetShown(overlay: Awaited<ReturnType<typeof overlayPage>>): Promise<string> {
  return overlay.evaluate(() => (document.querySelector('.card.first-launch') ? 'first-launch' : document.querySelector('.card.news') ? 'news' : document.querySelector('.card.welcome') ? 'welcome' : 'none'))
}

/** The version of the application that runs: what the launch notes as seen (`lastSeenVersion`). */
const appVersion = (app: ElectronApplication) => app.evaluate(({ app: electronApp }) => electronApp.getVersion())

test('first launch: the first launch of a new profile opens the guide, once; a profile that was used gets no sheet by itself', async () => {
  // A data folder with no state file: a new profile.
  running = await launchLucium()
  const dataDir = running.dataDir
  let overlay = await overlayPage(running.app)
  await expect.poll(() => sheetShown(overlay), { timeout: 15_000 }).toBe('first-launch')
  // Noted at once, with the welcome and the version as seen: neither the guide, nor the welcome, nor the news comes at the next launch.
  const version = await appVersion(running.app)
  await waitForState(running.page, (s) => s.state.settings['firstLaunchDone'] === true && s.state.settings['welcomeDone'] === true && s.state.settings['lastSeenVersion'] === version, 'the guide noted as shown')
  await waitForStateFile(dataDir)
  await expect.poll(() => stateOnDisk(dataDir).settings['firstLaunchDone'], { message: 'the guide noted as shown in the state file' }).toBe(true)
  await running.close({ keepData: true })

  // The same folder as a file written before the flags existed would leave it: nothing seen. A state file exists, so this is a profile
  // that was used: neither the guide nor the welcome opens by itself (decision of 3 November 2026; Aide › Premier lancement opens the guide).
  // The launch notes the version once it has decided (a file with no version: nothing to tell): that note is the sign that it has decided.
  editStateOnDisk(dataDir, (state) => Object.assign(state.settings, { lastSeenVersion: '', welcomeDone: false, firstLaunchDone: false }))
  running = await launchLucium({ dataDir })
  overlay = await overlayPage(running.app)
  await waitForState(running.page, (s) => s.state.settings['lastSeenVersion'] === version, 'the launch has decided about its sheet', 15_000)
  expect(await sheetShown(overlay)).toBe('none')
  expect((await snapshotOf(running.page)).state.settings['firstLaunchDone']).toBe(false)
})

test('whats-new: the first launch of a new version shows its news while on; off, no sheet opens', async () => {
  let overlay = await relaunchWith((settings) => Object.assign(settings, { lastSeenVersion: '0.0.1', welcomeDone: true, whatsNewSheet: true }))
  await expect.poll(() => sheetShown(overlay), { timeout: 15_000 }).toBe('news')
  await running!.close()

  overlay = await relaunchWith((settings) => Object.assign(settings, { lastSeenVersion: '0.0.1', welcomeDone: true, whatsNewSheet: false }))
  // With the function off the launch writes nothing and opens nothing: there is no sign to wait for. The sheet comes 600 ms after the layer is ready.
  await expectStays(() => sheetShown(overlay), 'none', 'no sheet opens while the function is off', 3000)
})
