// WAVE (accessibility checker, a browser extension): its bar must show on the first click, hide on the second, and show again on the third.
// The unpacked folder is not in the repository (the extension is another publisher's, not ours to give out): set WAVE_EXTENSION_PATH to it (for
// example a copy of the extension downloaded from the Chrome Web Store), on a machine that has it.
//
// This is a check made by hand before a release, not a test of the nightly run: a runner can never have the extension, and a test skipped every
// night says nothing. So the test is declared only where it can run (the variable is set); elsewhere the file declares none, and the list of
// the tests does not count it. What keeps the fix every day is the unit test of the patch behind it (src/main/shell/extension-patch.test.ts:
// the loading of a frame inside a tab is not the loading of the tab), which runs with `pnpm test`.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { dispatch } from './helpers'
import { launchLucium, type Running } from './launch'

const waveDir = process.env['WAVE_EXTENSION_PATH']

let server: Server
let url: string

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html lang="en"><head><title>WAVE test</title></head><body><main><h1>Test page</h1><p>Some text.</p></main></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** How long WAVE may take to draw or to put away its bar after a click (its script is loaded by the first one). */
const BAR_LIMIT_MS = 15_000

/** The check itself. Declared below only with the extension at hand (see the head of the file). */
async function waveToggles(folder: string): Promise<void> {
  const running: Running = await launchLucium([folder])
  try {
    // The extension's own console (its service worker): its errors are the only trace of a click that did nothing.
    await running.app.evaluate(({ session }) => {
      const profile = session.fromPartition('persist:profile-default')
      profile.serviceWorkers.on('console-message', (...args: unknown[]) => console.log('[wave-sw]', JSON.stringify(args, (key, value) => (typeof value === 'function' || key === 'sender' ? undefined : value)).slice(0, 400)))
      profile.serviceWorkers.on('running-status-changed', (event) => console.log(`[wave-sw] status ${event.runningStatus}`))
    })
    await openTab(running, url)
    // On, off, on. The third click is the one that failed in use. Each click is followed until the bar is in the state it must reach.
    for (const [click, shown] of [true, false, true].entries()) {
      await clickWaveButton(running)
      const focused = await running.app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '(none)')
      console.log('[wave-e2e] focused page after the click:', focused)
      await expect.poll(async () => (await waveDetail(running, url)).bar, { message: `the bar of WAVE after click ${click + 1}`, timeout: BAR_LIMIT_MS }).toBe(shown)
      console.log(`[wave-e2e] click ${click + 1}:`, await waveDetail(running, url))
    }
  } finally {
    await running.close()
  }
}

if (waveDir) test('WAVE toggles on, off and on again from the toolbar', () => waveToggles(waveDir))

/** Opens a web page in a new tab of the current space, through the application's own store action. */
async function openTab(run: Running, address: string): Promise<void> {
  await dispatch(run.page, { type: 'tab/open', url: address, background: false })
  await run.app.evaluate(async ({ webContents }, target) => {
    for (let waited = 0; waited < 20_000; waited += 100) {
      if (webContents.getAllWebContents().some((contents) => contents.getURL() === target)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`the tab for ${target} did not open`)
  }, address)
}

/** Clicks the WAVE button of the toolbar with the mouse, as the user does: the coordinates of the button, then a real click. */
async function clickWaveButton(run: Running): Promise<void> {
  const box = await run.page.evaluate(() => {
    const list = document.querySelector('browser-action-list')
    const buttons = Array.from(list?.shadowRoot?.querySelectorAll('[id]') ?? []) as HTMLElement[]
    const wave = buttons.find((button) => /wave/i.test(button.getAttribute('title') ?? '') || /wave/i.test(button.id))
    if (!wave) return null
    const rect = wave.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, id: wave.id }
  })
  console.log('[wave-e2e] toolbar button:', box)
  expect(box, 'the WAVE button is in the toolbar').not.toBeNull()
  expect(box!.width, 'the WAVE button has a size (it is not in the overflow menu)').toBeGreaterThan(0)
  await run.page.mouse.click(box!.x, box!.y)
}

/** What WAVE has drawn in the page: its bar, and its script (the first click loads it). The bar is position: fixed, so offsetParent is always null for it: its size and display tell whether it is shown. */
async function waveDetail(run: Running, address: string): Promise<{ bar: boolean; script: boolean; tab: boolean }> {
  return run.app.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL() === target)
    if (!contents) return { bar: false, script: false, tab: false }
    return contents.executeJavaScript("(() => { const bar = document.getElementById('wave_sidebar_container'); const shown = !!bar && bar.getBoundingClientRect().width > 0 && getComputedStyle(bar).display !== 'none'; return { bar: shown, script: !!document.getElementById('wavescript'), tab: true } })()")
  }, address)
}
