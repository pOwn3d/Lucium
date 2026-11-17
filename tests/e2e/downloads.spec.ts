// Downloads, in a folder of the test: the downloads folder of the application is moved (main process, `app.setPath`) to a temporary folder
// before anything is downloaded, so that nothing reaches the Downloads folder of the Mac. The files come from a server of the test; the slow
// one sends its bytes over several seconds, so that a download is still running while the test looks at it.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { callBridge, openTab, setSettings, snapshotOf, titledPage, waitForWindow, expectStays, type Snapshot } from './helpers'

let server: Server
let origin: string
let running: Running
let folder: string

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/file') {
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader('content-disposition', 'attachment; filename="Mon_rapport_final (2).TXT"')
      response.end('contenu')
      return
    }
    if (path === '/slow') {
      // 40 chunks of 4 KB, one every 250 ms: about ten seconds.
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader('content-disposition', 'attachment; filename="lent.bin"')
      response.setHeader('content-length', String(40 * 4096))
      let sent = 0
      const timer = setInterval(() => {
        if (response.destroyed || sent >= 40) {
          clearInterval(timer)
          if (!response.destroyed) response.end()
          return
        }
        response.write(Buffer.alloc(4096, 1))
        sent++
      }, 250)
      request.on('close', () => clearInterval(timer))
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(titledPage('Téléchargements', '<a id="file" href="/file">Fichier</a> <a id="slow" href="/slow">Lent</a>'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test.beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'lucium-e2e-downloads-'))
  running = await launchLucium()
  await running.app.evaluate(({ app }, path) => app.setPath('downloads', path), folder)
})

test.afterEach(async () => {
  await running.close()
  rmSync(folder, { recursive: true, force: true })
})

type Download = { id: string; state: string; paused?: boolean; filename?: string }
const downloadsOf = async (): Promise<Download[]> => ((await snapshotOf(running.page)) as Snapshot & { downloads?: Download[] }).downloads ?? []
const filesInFolder = () => readdirSync(folder).filter((name) => !name.startsWith('.') && !name.endsWith('.crdownload'))

test('tidy-downloads: a file downloaded while on gets a tidy name; off, it keeps the name the site gave', async () => {
  const page = await openTab(running, `${origin}/`, 'Téléchargements')
  await setSettings(running.page, { tidyDownloads: false })
  await page.page.click('#file')
  await expect.poll(filesInFolder, { timeout: 15_000 }).toContain('Mon_rapport_final (2).TXT')

  await setSettings(running.page, { tidyDownloads: true })
  await page.page.click('#file')
  await expect.poll(filesInFolder, { timeout: 15_000 }).toContain('Mon rapport final.txt')
})

test('download-status-chip: a download that runs shows its ring in the sidebar while on; off, the plain button stays', async () => {
  const page = await openTab(running, `${origin}/`, 'Téléchargements')
  await setSettings(running.page, { downloadStatusChip: true })
  await page.page.click('#slow')
  await expect.poll(async () => (await downloadsOf()).some((download) => download.state === 'progressing'), { timeout: 10_000 }).toBe(true)
  await expect(running.page.locator('.sidebar .footer-downloads.dlc.busy')).toHaveCount(1)

  await setSettings(running.page, { downloadStatusChip: false })
  await expect(running.page.locator('.sidebar .footer-downloads.dlc')).toHaveCount(0)
  await expect(running.page.locator('.sidebar .footer-downloads')).toHaveCount(1)
})

test('download-pause: a running download can be paused while on; off, the request to pause it changes nothing', async () => {
  const page = await openTab(running, `${origin}/`, 'Téléchargements')
  const running1 = async () => (await downloadsOf()).find((download) => download.state === 'progressing')
  await setSettings(running.page, { downloadPause: false })
  await page.page.click('#slow')
  await expect.poll(async () => (await running1()) !== undefined, { timeout: 10_000 }).toBe(true)
  const first = (await running1())!
  await callBridge(running.page, 'downloadAction', first.id, 'pause')
  await expectStays(async () => (await downloadsOf()).find((download) => download.id === first.id)?.paused ?? false, false, 'the download is not paused while the function is off', 800)
  await callBridge(running.page, 'downloadAction', first.id, 'cancel')

  await setSettings(running.page, { downloadPause: true })
  await page.page.click('#slow')
  await expect.poll(async () => (await downloadsOf()).some((download) => download.state === 'progressing' && download.id !== first.id), { timeout: 10_000 }).toBe(true)
  const second = (await downloadsOf()).find((download) => download.state === 'progressing' && download.id !== first.id)!
  await callBridge(running.page, 'downloadAction', second.id, 'pause')
  await expect.poll(async () => (await downloadsOf()).find((download) => download.id === second.id)?.paused).toBe(true)
  await callBridge(running.page, 'downloadAction', second.id, 'cancel')

})

test('little-download-bubble: a file a mini window downloads raises its bubble of actions while on; off, no bubble', async () => {
  for (const on of [false, true]) {
    await setSettings(running.page, { littleDownloadBubble: on })
    // A link from another application opens in a mini window (the default of externalLinksInLittleArc).
    const address = `${origin}/?little=${on}`
    // The bubble is drawn in the tray of the downloads of the new window: the page of littlearc.html with `tray=1` that was not there before.
    const before = new Set(running.app.windows())
    await running.app.evaluate(({ app }, link) => void app.emit('open-url', { preventDefault: () => undefined }, link), address)
    const page = await waitForWindow(running.app, (url) => url === address)
    await page.click('#file')
    await expect.poll(filesInFolder, { timeout: 15_000 }).toContain(on ? 'Mon_rapport_final (2) (1).TXT' : 'Mon_rapport_final (2).TXT')
    const tray = () => running.app.windows().find((other) => !before.has(other) && other.url().includes('/littlearc.html') && other.url().includes('tray=1'))
    await expect.poll(() => tray() !== undefined, { message: 'the tray of the downloads of the window' }).toBe(true)
    if (on) await expect.poll(() => tray()!.locator('.lt-bubble').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    else await expectStays(() => tray()!.locator('.lt-bubble').count(), 0, 'no bubble comes in the tray while the function is off', 1000)
  }
})
