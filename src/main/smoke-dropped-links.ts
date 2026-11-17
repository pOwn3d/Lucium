// Engine checks for a link another application drops on a window (`openDroppedLinks`, shell/ipc.ts), run inside a real Electron: the interface reads the text
// of the drop and sends it, and the main process reads it again, so the whole road is driven here: a drop made as a page receives one (a DragEvent that
// carries the data of a link, on the real interface of the main window, its preload and its channel; a real drop from another application cannot be simulated)
// and the channel called with what the interface would never send. A web address opens in a new tab of the space on show, with no opener; a script, a file, a
// blob, an address with a name and a password, any other text, a field of text and what is not a text open nothing; the drop is cancelled every time.
// It needs no screenshot (the capture suite does), only a server of its own and the tabs it opens, closed afterwards.
// `LUCIUM_SMOKE_ONLY=dropped-links`: only these checks, with their own report.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DROPPED_LINKS_MAX } from '@shared/dropped-links'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(10_000, 80)

export async function smokeDroppedLinks({ browser, store, win }: SmokeContext, check: Check): Promise<void> {
  const ui = win.webContents
  const state = () => store.get()
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'close')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><title>${decodeURIComponent((req.url ?? '/').slice(1))}</title><p>dropped link</p>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const linkTabs = (path: string) => state().tabs.filter((tab) => tab.url === `${base}${path}`)
  const tabCount = () => state().tabs.length
  /** The tab in front in the space on show. */
  const selectedTab = () => state().activeTabBySpace[state().activeSpaceId]
  try {
    // A drop on an element of the interface: the data by type, a field of text when asked, and whether the interface cancelled the drop.
    const dropOn = (data: Record<string, string>, field = false) =>
      ui.executeJavaScript(
        `(() => {
          const dt = new DataTransfer()
          for (const [type, text] of Object.entries(${JSON.stringify(data)})) dt.setData(type, text)
          const event = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
          const target = ${field ? "document.body.appendChild(document.createElement('textarea'))" : 'document.body'}
          target.dispatchEvent(event)
          if (${field}) target.remove()
          return event.defaultPrevented
        })()`
      ) as Promise<boolean>
    // Everything sent before it has been read once this link has opened: the messages of a channel are heard in order, so no fixed wait is needed to say that nothing else opened.
    const sentinel = async (name: string): Promise<boolean> => {
      await dropOn({ 'text/plain': `${base}/${name}` })
      return waitFor(() => linkTabs(`/${name}`).length === 1)
    }
    const displayedSpace = state().activeSpaceId

    // One link, as Safari or Mail gives it (a list of addresses and the text).
    const cancelled = await dropOn({ 'text/uri-list': `${base}/one`, 'text/plain': `${base}/one` })
    check('dropped-links: the interface cancels the drop of a link (it never navigates)', cancelled === true)
    check('dropped-links: a link opens in a new tab', await waitFor(() => linkTabs('/one').length === 1), JSON.stringify(state().tabs.slice(-2).map((tab) => tab.url)))
    const one = linkTabs('/one')[0]
    check('dropped-links: in the space on show, in front, with no opener and no parent', one?.spaceId === displayedSpace && selectedTab() === one?.id && one?.openerId === undefined && one?.parentId === undefined, JSON.stringify({ space: one?.spaceId, shown: displayedSpace, opener: one?.openerId }))
    check('dropped-links: the page loads', await waitFor(() => state().tabs.find((tab) => tab.id === one?.id)?.title === 'one', 8000))

    // A list, with a repeat and a comment: each address once, the first in front, the others behind; a link as text only (a terminal) opens too.
    await dropOn({ 'text/uri-list': `# a comment\r\n${base}/a\r\n${base}/a\r\n${base}/b\r\n` })
    check('dropped-links: a list opens each address once', await waitFor(() => linkTabs('/a').length === 1 && linkTabs('/b').length === 1), JSON.stringify(state().tabs.slice(-3).map((tab) => tab.url)))
    check('dropped-links: the first of the list is in front, the next one behind', selectedTab() === linkTabs('/a')[0]?.id)
    await dropOn({ 'text/plain': `${base}/text` })
    check('dropped-links: a link that came as plain text opens in a tab', await waitFor(() => linkTabs('/text').length === 1))

    // Past the ceiling: ten tabs and the rest left aside.
    const before = tabCount()
    await dropOn({ 'text/uri-list': Array.from({ length: DROPPED_LINKS_MAX + 3 }, (_, i) => `${base}/many${i}`).join('\r\n') })
    check('dropped-links: the ceiling opens at once', await waitFor(() => tabCount() === before + DROPPED_LINKS_MAX), String(tabCount() - before))
    check('dropped-links: and nothing more opens after the ceiling', (await sentinel('after-ceiling')) && tabCount() === before + DROPPED_LINKS_MAX + 1, String(tabCount() - before))

    // What is refused opens nothing: a script, a file, an address with a name and a password, a data page, an address of Lucium, a blob, any other text, a field.
    const quiet = tabCount()
    const refused = [
      await dropOn({ 'text/uri-list': 'javascript:alert(1)\r\nfile:///etc/hosts\r\nhttps://user:secret@example.com/\r\ndata:text/html,<b>1\r\nlucium://new-tab\r\nblob:https://example.com/1' }),
      await dropOn({ 'text/plain': 'Some text from another application.' }),
      await dropOn({ 'text/html': `<a href="${base}/html">x</a>` })
    ]
    check('dropped-links: the interface cancels a drop that opens nothing, too', refused.every((value) => value === true), JSON.stringify(refused))
    const overField = await dropOn({ 'text/plain': `${base}/field` }, true)
    check('dropped-links: a field of text takes the text itself: the interface leaves that drop alone', overField === false)
    // The interface would never send these: the main process does not take its word for the type or the size.
    await ui.executeJavaScript(`(() => {
      window.lucium.openDroppedLinks([${JSON.stringify(`${base}/array`)}])
      window.lucium.openDroppedLinks(7)
      window.lucium.openDroppedLinks(null)
      window.lucium.openDroppedLinks({ toString: undefined })
      window.lucium.openDroppedLinks('x'.repeat(20000) + '\\n${base}/long')
      window.lucium.openDroppedLinks('${base}/no\\u0000nul')
      window.lucium.openDroppedLinks('http://exa mple.com/ ' + '${base}/blank')
    })()`)
    check('dropped-links: what is refused, a text that is no link, a field and what is not a text open nothing', (await sentinel('after-refusals')) && tabCount() === quiet + 1, JSON.stringify(state().tabs.slice(quiet).map((tab) => tab.url)))
  } finally {
    for (const tab of state().tabs.filter((item) => item.url.startsWith(base))) browser.dispatch({ type: 'tab/close', id: tab.id })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=dropped-links`: only these checks, with their own report. */
export async function runDroppedLinksSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeDroppedLinks(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeDroppedLinks ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_DROPPED_LINKS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
