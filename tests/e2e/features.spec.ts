// The effect of optional features on a page of the test (served on 127.0.0.1): what the server receives, what the state keeps, what the
// sidebar shows. Each feature that is switched on has its control: the same page with the feature off, where the effect must be absent.

import { expect, test } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { chooseMenuEntry, dispatch, searchHistoryTitles, serveSite, titledPage, viewportWidth, waitForState, waitForWindow, expectStays, type LocalSite } from './helpers'

let site: LocalSite
let running: Running

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A'), '/b': titledPage('Page B') })
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  // The site is shared by the tests of the file: each test starts with no request of the previous ones.
  site.requests.length = 0
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

/** The paths the server received for a page, in order (the query is part of the path). */
const pathsReceived = (prefix: string) => site.requests.map((request) => request.path).filter((path) => path.startsWith(prefix))

/** Sets one setting, the way the Settings window does, and waits until the state has it. */
async function setting(key: string, value: boolean): Promise<void> {
  await dispatch(running.page, { type: 'settings/update', patch: { [key]: value } })
  await waitForState(running.page, (s) => s.state.settings[key] === value, `${key} = ${value}`)
}

test.describe('strip-tracking: the tracking parameters are removed before the page is asked for', () => {
  test('on: the server gets the address without utm_source, and keeps the other parameters', async () => {
    await setting('stripTrackingParams', true)
    await dispatch(running.page, { type: 'tab/open', url: `${site.origin}/a?utm_source=test&keep=1` })
    await expect.poll(() => pathsReceived('/a').length).toBeGreaterThan(0)
    expect(pathsReceived('/a')[0]).toBe('/a?keep=1')
  })

  test('off (control): the server gets the address as it was typed', async () => {
    await setting('stripTrackingParams', false)
    await dispatch(running.page, { type: 'tab/open', url: `${site.origin}/a?utm_source=test&keep=1` })
    await expect.poll(() => pathsReceived('/a').length).toBeGreaterThan(0)
    expect(pathsReceived('/a')[0]).toBe('/a?utm_source=test&keep=1')
  })
})

test.describe('global-privacy-control: the Sec-GPC signal goes with the requests', () => {
  test('on: the page request carries Sec-GPC: 1', async () => {
    await setting('sendGpc', true)
    await dispatch(running.page, { type: 'tab/open', url: `${site.origin}/a` })
    await expect.poll(() => site.requests.find((request) => request.path.startsWith('/a'))?.headers['sec-gpc']).toBe('1')
  })

  test('off (control): the page request has no Sec-GPC header', async () => {
    await setting('sendGpc', false)
    await dispatch(running.page, { type: 'tab/open', url: `${site.origin}/a` })
    await expect.poll(() => site.requests.some((request) => request.path.startsWith('/a'))).toBe(true)
    expect(site.requests.find((request) => request.path.startsWith('/a'))?.headers['sec-gpc']).toBeUndefined()
  })
})

test.describe('history-off: the pages visited are not kept in the history', () => {
  test('on: a visited page does not appear in the history search', async () => {
    await setting('historyOff', true)
    await dispatch(running.page, { type: 'tab/open', url: `${site.origin}/a` })
    await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.title === 'Page A'), 'page A loaded')
    await expectStays(() => searchHistoryTitles(running.page, 'Page A'), [], 'the page is not written in the history while the history is off', 1500)
  })

  test('off (control): the visited page appears in the history search', async () => {
    await setting('historyOff', false)
    await dispatch(running.page, { type: 'tab/open', url: `${site.origin}/a` })
    await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.title === 'Page A'), 'page A loaded')
    await expect.poll(() => searchHistoryTitles(running.page, 'Page A')).toContain('Page A')
  })
})

test.describe('sidebar-right: the sidebar moves to the right edge of the window', () => {
  const sidebarCenter = async () => {
    const box = await running.page.locator('.sidebar').boundingBox()
    return box ? box.x + box.width / 2 : NaN
  }

  test('on: the sidebar is in the right half of the window', async () => {
    await setting('sidebarRight', true)
    const width = await viewportWidth(running.page)
    await expect.poll(sidebarCenter).toBeGreaterThan(width / 2)
  })

  test('off (control): the sidebar is in the left half of the window', async () => {
    await setting('sidebarRight', false)
    const width = await viewportWidth(running.page)
    await expect.poll(sidebarCenter).toBeLessThan(width / 2)
  })
})

test('little-shortcut: ⌘⌥N opens the mini window, a window of its own', async () => {
  await chooseMenuEntry(running.app, 'CmdOrCtrl+Alt+N')
  await waitForWindow(running.app, (url) => url.includes('littlearc'))
})
