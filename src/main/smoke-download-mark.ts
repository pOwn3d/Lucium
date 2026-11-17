// Engine check for the mark of macOS on a download that is still being written (engine/download-quarantine.ts, `EARLY_MARK_TRIES`), run inside a real
// Electron. A server announces more bytes than it sends, sends a whole archive, then holds the connection open: the file is on disk, whole for the
// Finder, while the download is still running. It must already carry the quarantine mark, under the name it is written to, so that opening it from the
// Finder before the end goes through the checks of the system. What the check also tells: the name Chromium writes it under while it runs.
// `LUCIUM_SMOKE_ONLY=download-mark`: only this check, with its own report.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, skippedBecause, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(10_000, 80)

/** A small archive: what is sent is whole, what is announced is twice as long. */
const BODY = Buffer.alloc(64 * 1024, 7)

/** The quarantine mark of the file, or why it could not be read. */
function markOf(path: string): string {
  try {
    return execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], { encoding: 'utf8' })
  } catch (error) {
    return `error: ${(error as Error).message}`
  }
}

export async function smokeDownloadMark({ browser, store }: SmokeContext, check: Check): Promise<void> {
  if (process.platform !== 'darwin') return check('download-mark: a download still being written carries the quarantine mark', true, skippedBecause('the mark is the one of macOS'))
  const held: ServerResponse[] = []
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    if (req.url === '/held.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="held.zip"', 'content-length': String(BODY.length * 2) })
      res.write(BODY)
      // The rest never comes: the connection stays open until the end of the check.
      held.push(res)
      return
    }
    res.setHeader('content-type', 'text/html')
    res.setHeader('connection', 'close')
    res.end('<!doctype html><title>download-mark</title><p>page</p>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const root = mkdtempSync(join(tmpdir(), 'download-mark-'))
  const folder = join(root, 'profile')
  mkdirSync(folder)
  const profilesBefore = store.get().settings.profiles
  browser.dispatch({ type: 'settings/update', patch: { profiles: { ...profilesBefore, default: { ...profilesBefore['default']!, downloadDir: folder } } } })
  let tabId: string | null = null
  // The downloads there were before the check: the ones it started are taken off the list at its end.
  let known: ReadonlySet<string> = new Set(browser.snapshot().downloads.map((d) => d.id))
  try {
    browser.dispatch({ type: 'tab/open', url: `${base}/page` })
    const tab = store.get().tabs.at(-1)!
    tabId = tab.id
    const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
    await waitFor(() => wcOf(tab.id) !== undefined && browser.snapshot().runtime.tabs[tab.id]?.loading === false)
    known = new Set(browser.snapshot().downloads.map((d) => d.id))
    wcOf(tab.id)!.downloadURL(`${base}/held.zip`)
    const running = () => browser.snapshot().downloads.find((d) => !known.has(d.id))
    const arrived = await waitFor(() => running()?.state === 'progressing' && (running()?.receivedBytes ?? 0) >= BODY.length)
    const download = running()
    check('download-mark: the server sends the whole archive and holds the download open', arrived, JSON.stringify(download))
    if (!download) return
    // The name the file is written under while it runs: its own, or Chromium's name of a download under way.
    const written = [download.path, `${download.path}.crdownload`].find((path) => existsSync(path))
    check('download-mark: the file being written is on disk', written !== undefined, `${download.path} (and .crdownload): ${written ?? 'neither'}`)
    if (written === undefined) return
    const marked = await waitFor(() => /^0083;[0-9a-f]+;Lucium;[0-9A-F-]{36}\n$/.test(markOf(written)), 5000)
    check(`download-mark: the file still being written already carries the quarantine mark of macOS (written as ${written === download.path ? 'its own name' : 'a .crdownload'})`, marked, markOf(written))
  } finally {
    // The download goes with the check: cancelled while it still runs, then taken off the list. Left to the end of its connection it was interrupted,
    // and an interrupted download keeps its bubble in the footer until someone answers it: the suites after this one read the button of the downloads.
    const started = () => browser.snapshot().downloads.filter((d) => !known.has(d.id))
    for (const download of started()) browser.cancelDownload(download.id)
    await waitFor(() => started().every((d) => d.state !== 'progressing'), 5000)
    for (const download of started()) browser.clearDownload(download.id)
    for (const res of held) res.destroy()
    if (tabId !== null) browser.dispatch({ type: 'tab/close', id: tabId })
    browser.dispatch({ type: 'settings/update', patch: { profiles: profilesBefore } })
    server.close()
    server.closeAllConnections()
    rmSync(root, { recursive: true, force: true })
  }
}

/** `LUCIUM_SMOKE_ONLY=download-mark`: only this check, with its own report. */
export async function runDownloadMarkSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeDownloadMark(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeDownloadMark ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_DOWNLOAD_MARK ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
