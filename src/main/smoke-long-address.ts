// Engine check for a tab sent by a redirect to an address longer than the state keeps (`TAB_URL_MAX`, shared/state-clean.ts), run inside a real
// Electron. A page of one site goes to an address of its own server that answers with a redirect to another site, at an address of 70 000 characters
// (a fragment the server never sees). The tab must follow it, cut, to the site it is on: before, it went on naming the site it had left, its lock and
// its permissions included, above the page of the other one.
// `LUCIUM_SMOKE_ONLY=long-address`: only this check, with its own report.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebContents } from 'electron'
import { TAB_URL_MAX } from '@shared/state-clean'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(10_000, 80)

/** Longer than the state keeps, far shorter than what Chromium loads (2 MiB). */
const FRAGMENT_LENGTH = 70_000

export async function smokeLongAddress({ browser, store }: SmokeContext, check: Check): Promise<void> {
  let port = 0
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'close')
    if (req.url === '/jump') {
      // Another site (another host for the same server): the tab must not go on naming 127.0.0.1.
      res.writeHead(302, { location: `http://localhost:${port}/landing#${'x'.repeat(FRAGMENT_LENGTH)}` })
      res.end()
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><title>long-address ${req.url?.startsWith('/landing') ? 'landing' : 'start'}</title><p>${req.url?.slice(0, 40)}</p>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  let tabId: string | null = null
  try {
    browser.dispatch({ type: 'tab/open', url: `http://127.0.0.1:${port}/start` })
    const tab = store.get().tabs.at(-1)!
    tabId = tab.id
    const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
    const tabNow = () => store.get().tabs.find((item) => item.id === tab.id)
    const started = await waitFor(() => tabNow()?.title === 'long-address start' && wcOf(tab.id) !== undefined)
    check('long-address: the page of the first site opens', started, JSON.stringify(tabNow()?.url))
    if (!started) return
    const wc = wcOf(tab.id)!
    await wc.executeJavaScript(`location.href = '/jump'; true`)
    const landed = await waitFor(() => wc.getURL().startsWith(`http://localhost:${port}/landing#`) && tabNow()?.title === 'long-address landing')
    check('long-address: the redirect takes the page to the other site, at the whole long address', landed && wc.getURL().length > TAB_URL_MAX, `${wc.getURL().slice(0, 60)}… (${wc.getURL().length} characters)`)
    const url = tabNow()?.url ?? ''
    check('long-address: the tab names the site its page is on, not the one it left', url.startsWith(`http://localhost:${port}/landing`), url.slice(0, 80))
    check('long-address: the address the tab keeps is cut to what the state holds', url.length <= TAB_URL_MAX, `${url.length} characters`)
  } finally {
    if (tabId !== null) browser.dispatch({ type: 'tab/close', id: tabId })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=long-address`: only this check, with its own report. */
export async function runLongAddressSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeLongAddress(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeLongAddress ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_LONG_ADDRESS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
