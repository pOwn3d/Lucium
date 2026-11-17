// Engine checks for keyboard and extension features, run inside a real Electron with real keys and a
// local server (nothing leaves the machine):
//  - the Vim-style keys: off first (nothing installed, nothing happens), then on with real key events in a page (scrolling, gg and G, the link
//    hints with f and F, back and forward, the tab before and after, the search bar), the fields left alone, a site left out, the surfaces of the
//    interface that never carry the tool, and the switch off taking the tool out of a page that is already open;
//  - the tab groups of an extension as folders of the sidebar (driven through the Sec2 Driver Probe): off, nothing; on, a folder with the tabs
//    pinned in it, the title, the collapsed state, a tab that joins and one that leaves, what the user does to the folder, the files that never
//    hold it, the setting switched off putting everything back;
//  - the keyword of an extension in the command bar (Keyext Probe, keyword "kxp"): the API exists for the extension that declared
//    a keyword only, the row of the bar, Enter telling the extension "started" then "entered" with the text and the place, no suggestion asked for,
//    forged requests, the switch off.
// Needs the probes of compat/ in LUCIUM_EXTENSIONS (the `test:engine` script has them); `LUCIUM_SMOKE_ONLY=keyext` runs only this file.
// Called from the engine smoke test: `await smokeKeyExt(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebContents } from 'electron'
import { TOOLS_WORLD } from '@shared/page-tools'
import { persistableState, stepTab } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, requireProbes, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Reply {
  ok: boolean
  value?: any
  error?: string
}


/** What a worker that does not answer gives: a failed check, not a test that never ends. */
const withDeadline = <T>(promise: Promise<T>, fallback: T, ms = 25_000): Promise<T> => Promise.race([promise, sleep(ms).then(() => fallback)])
const silent: Reply = { ok: false, error: 'no answer from the worker within 25 seconds' }

const waitFor = waiterOf(8000, 60)

/** The page that drives the probes: it asks a worker to call a Chrome API, or to answer a question, and hands the answer back. */
const RPC_PAGE = `<title>keyext-rpc</title><body>rpc page<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
  window.call = (ext, path, ...args) => window.rpc(ext, { type: 'call', path, args })
</script></body>`

const PAGE_CSS = 'body{margin:0;font:16px sans-serif}'

export async function smokeKeyExt(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView, engine } = ctx
  const ui = overlayView.webContents
  const state = (): SidebarState => store.get()
  const original = { ...state().settings }
  const set = (patch: Record<string, unknown>) => browser.dispatch({ type: 'settings/update', patch: patch as never })
  // The tabs the checks open stay awake; the keys and the groups are what is under test.
  // The suites before this one in the chain leave their own state behind: what these checks depend on is put as they need it (and back at the end).
  browser.closeOverlay()
  set({ sleepAfterMinutes: 0, vimKeys: false, vimKeysExcludedHosts: [], tabGroupFolders: false, omniboxKeywords: false, searchSuggestions: false, modifiedClickBackground: true, backClosesOpenedTab: false, autoScroll: false, mouseGestures: false, scrollSync: false })

  // ---- a server whose pages are the fixtures ----
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (url.pathname === '/rpc') return void res.end(RPC_PAGE)
    if (url.pathname === '/vim') {
      const height = Number(url.searchParams.get('h') ?? '9000')
      return void res.end(
        `<title>vim</title><style>${PAGE_CSS}</style><body><div style="height:${height}px;background:linear-gradient(#fff,#ccc)">haut</div>` +
          `<a id="a" href="/s/premier" style="position:absolute;top:60px;left:40px">premier</a>` +
          `<a id="b" href="/s/second" style="position:absolute;top:120px;left:40px">second</a>` +
          `<a id="c" href="/s/troisieme" style="position:absolute;top:180px;left:40px">troisième</a>` +
          `<input id="q" style="position:absolute;top:240px;left:40px;width:200px"></body>`
      )
    }
    return void res.end(`<title>${decodeURIComponent(url.pathname.slice(1).replace(/^s\//, '').replace(/-/g, ' '))}</title><style>${PAGE_CSS}</style><body>page</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- tabs and input ----
  const mine = new Set<string>()
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const loading = (id: string) => browser.snapshot().runtime.tabs[id]?.loading
  const open = async (path: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const tab = state().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => wcOf(tab.id) !== undefined && loading(tab.id) === false)
    await sleep(250)
    return { id: tab.id, wc: wcOf(tab.id)! }
  }
  const inPage = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>
  const inTools = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScriptInIsolatedWorld(TOOLS_WORLD, [{ code }]) as Promise<T>
  const toolsInstalled = (wc: WebContents): Promise<string[]> => inTools<string[]>(wc, `Object.keys(self.__lucium_tools || {}).filter((k) => typeof self.__lucium_tools[k] === 'object' && typeof self.__lucium_tools[k].off === 'function')`)
  const scrollY = (wc: WebContents) => inPage<number>(wc, 'Math.round(scrollY)')
  // The hints are drawn in a plain <div> put beside <head> and <body>, with no tag or attribute of ours: it is found by its place, which no element of the test pages has.
  const HINTS_HOST = ':root > div'
  const hostsOf = (wc: WebContents) => inTools<number>(wc, `document.querySelectorAll('${HINTS_HOST}').length`)
  const mouse = (wc: WebContents, type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
  /** A real click on an empty part of the page (its bottom right corner, whatever the size of the window): the page has the keyboard. */
  const focusPage = async (wc: WebContents) => {
    wc.focus()
    const corner = await inPage<{ x: number; y: number }>(wc, `({ x: innerWidth - 60, y: innerHeight - 40 })`)
    mouse(wc, 'mouseMove', corner.x, corner.y)
    mouse(wc, 'mouseDown', corner.x, corner.y)
    mouse(wc, 'mouseUp', corner.x, corner.y)
    await sleep(150)
  }
  /**
   * A key as the user presses it. Electron reads the key code of a letter in lower case whatever its case ("G" is the G key, unshifted: the page
   * would hear "g"): a capital letter is the key with Shift held, as on a keyboard.
   */
  const press = async (wc: WebContents, keyCode: string, wait = 160) => {
    const capital = /^[A-Z]$/.test(keyCode)
    const modifiers = capital ? (['shift'] as Array<'shift'>) : []
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    // Only a key that types a character has a char event (Escape does not).
    if (keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(wait)
  }
  const activeId = () => state().activeTabBySpace[state().activeSpaceId]
  const closeMine = () => {
    for (const id of mine) {
      if (state().tabs.find((t) => t.id === id)?.pinned) browser.dispatch({ type: 'tab/unpin', id })
      browser.dispatch({ type: 'tab/close', id })
    }
    mine.clear()
  }

  try {
    // ================================================================= Vim-style keyboard navigation
    await open('/s/autre')
    const vim = await open('/vim')
    await focusPage(vim.wc)

    check('vim: off, the page carries no tool', (await toolsInstalled(vim.wc)).length === 0)
    await press(vim.wc, 'j')
    await press(vim.wc, 'f')
    check('vim: off, j scrolls nothing and f labels nothing', (await scrollY(vim.wc)) === 0 && (await hostsOf(vim.wc)) === 0)

    set({ vimKeys: true })
    check('vim: switching it on installs the tool in the page that is already open', await waitFor(async () => (await toolsInstalled(vim.wc)).includes('vimKeys')))
    check('vim: ...in the isolated world of the tools, and only there (the page itself cannot see it)', (await inPage<string>(vim.wc, `typeof self.__lucium_tools`)) === 'undefined')
    check('vim: the surfaces of the interface (window, overlays) never carry it', (await inTools<string>(win.webContents, `typeof self.__lucium_tools`)) === 'undefined' && (await inTools<string>(ui, `typeof (self.__lucium_tools && self.__lucium_tools.vimKeys)`)) === 'undefined')

    // A key the page itself makes up (a script, a hostile page) is not the user's: it moves nothing and opens nothing.
    // No wait after it: the page dispatches its keys before the script returns, and the tool acts inside its listener (an instant scroll, its labels).
    await inPage(vim.wc, `for (const key of ['j', 'f', 'G']) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) }`)
    check('vim: keys made up by the page do nothing (no scroll, no label)', (await scrollY(vim.wc)) === 0 && (await hostsOf(vim.wc)) === 0)

    await press(vim.wc, 'j')
    check('vim: j scrolls the page down by 60 px', await waitFor(async () => (await scrollY(vim.wc)) === 60), String(await scrollY(vim.wc)))
    await press(vim.wc, 'k')
    check('vim: k scrolls it back up', await waitFor(async () => (await scrollY(vim.wc)) === 0))
    const half = await inPage<number>(vim.wc, 'Math.floor(innerHeight / 2)')
    await press(vim.wc, 'd')
    check('vim: d scrolls half a screen down', await waitFor(async () => (await scrollY(vim.wc)) === half), `${await scrollY(vim.wc)} / ${half}`)
    await press(vim.wc, 'u')
    check('vim: u scrolls half a screen up', await waitFor(async () => (await scrollY(vim.wc)) === 0))
    await press(vim.wc, 'G')
    const bottom = await inPage<number>(vim.wc, 'Math.round(document.documentElement.scrollHeight - innerHeight)')
    check('vim: G goes to the bottom of the page', await waitFor(async () => Math.abs((await scrollY(vim.wc)) - bottom) <= 1), `${await scrollY(vim.wc)} / ${bottom}`)
    await press(vim.wc, 'g', 60)
    await press(vim.wc, 'g')
    check('vim: gg goes back to the top', await waitFor(async () => (await scrollY(vim.wc)) === 0))
    await press(vim.wc, 'g')
    await sleep(1700)
    await press(vim.wc, 'g')
    check('vim: a g that waited too long is forgotten (a second g much later does not jump)', (await scrollY(vim.wc)) === 0)
    // That last g waits for a second one: a key that means nothing here ends the wait, so that the next key is read afresh.
    await press(vim.wc, 'x')

    // The link hints: f labels the links and the field in the order of the page (a, s, d, f); the letters typed follow one.
    await press(vim.wc, 'f')
    check('vim: f puts the labels on the page (one element of ours in the page, its content closed to the page)', (await hostsOf(vim.wc)) === 1 && (await inPage<number>(vim.wc, `document.querySelector('${HINTS_HOST}')?.shadowRoot ? 1 : 0`)) === 0)
    await press(vim.wc, 'Escape')
    check('vim: Escape takes them away', (await hostsOf(vim.wc)) === 0)
    await press(vim.wc, 'f')
    await press(vim.wc, 's')
    check('vim: f then the label of a link follows that link', await waitFor(() => vim.wc.getURL() === `${base}/s/second`, 8000), vim.wc.getURL())
    await waitFor(async () => (await toolsInstalled(vim.wc)).includes('vimKeys') && loading(vim.id) === false)
    await sleep(250)
    await focusPage(vim.wc)
    await press(vim.wc, 'H')
    check('vim: H goes back', await waitFor(() => vim.wc.getURL() === `${base}/vim`, 8000), vim.wc.getURL())
    await waitFor(async () => (await toolsInstalled(vim.wc)).includes('vimKeys') && loading(vim.id) === false)
    await sleep(250)
    await focusPage(vim.wc)
    await press(vim.wc, 'L')
    check('vim: L goes forward', await waitFor(() => vim.wc.getURL() === `${base}/s/second`, 8000), vim.wc.getURL())
    await waitFor(async () => (await toolsInstalled(vim.wc)).includes('vimKeys') && loading(vim.id) === false)
    await sleep(250)
    await focusPage(vim.wc)
    await press(vim.wc, 'H')
    await waitFor(() => vim.wc.getURL() === `${base}/vim`, 8000)
    await waitFor(async () => (await toolsInstalled(vim.wc)).includes('vimKeys') && loading(vim.id) === false)
    await sleep(250)
    await focusPage(vim.wc)

    // F: the link opens in a new tab, behind or in front as the settings of Liens say (behind by default, like a ⌘-click).
    const tabsBefore = state().tabs.length
    const activeBefore = activeId()
    await press(vim.wc, 'F')
    await press(vim.wc, 'a')
    check('vim: F then the label of a link opens that link in a new tab', await waitFor(() => state().tabs.length === tabsBefore + 1 && state().tabs.at(-1)?.url === `${base}/s/premier`), JSON.stringify(state().tabs.slice(tabsBefore).map((t) => t.url)))
    if (state().tabs.at(-1)) mine.add(state().tabs.at(-1)!.id)
    check('vim: ...behind the page (the setting of ⌘-click), and the page stays on screen', activeId() === activeBefore && vim.wc.getURL() === `${base}/vim`)
    check('vim: ...in the space of the page, and the page itself did not navigate', state().tabs.at(-1)?.spaceId === state().tabs.find((t) => t.id === vim.id)?.spaceId)

    // J and K: the tab before and after in the sidebar.
    browser.dispatch({ type: 'tab/select', id: vim.id })
    await waitFor(() => activeId() === vim.id)
    await focusPage(vim.wc)
    const nextTab = stepTab(state(), 1)
    await press(vim.wc, 'K')
    check('vim: K goes to the next tab', await waitFor(() => activeId() === nextTab), `${activeId()} / ${nextTab}`)
    browser.dispatch({ type: 'tab/select', id: vim.id })
    await waitFor(() => activeId() === vim.id)
    await focusPage(vim.wc)
    const previousTab = stepTab(state(), -1)
    await press(vim.wc, 'J')
    check('vim: J goes to the previous tab', await waitFor(() => activeId() === previousTab), `${activeId()} / ${previousTab}`)
    browser.dispatch({ type: 'tab/select', id: vim.id })
    await waitFor(() => activeId() === vim.id)
    await focusPage(vim.wc)

    await press(vim.wc, '/')
    check('vim: / opens the search bar of the browser', await waitFor(() => browser.currentPanel() === 'find'), String(browser.currentPanel()))
    browser.closeOverlay()
    await sleep(200)
    await focusPage(vim.wc)

    // A field keeps its keys. (The checks above left the page where they found it; if one failed on the way, the page is put back so that these do not fail with it.)
    if (vim.wc.getURL() !== `${base}/vim`) {
      await vim.wc.loadURL(`${base}/vim`)
      await waitFor(async () => (await toolsInstalled(vim.wc)).includes('vimKeys') && loading(vim.id) === false)
      await focusPage(vim.wc)
    }
    const field = await inPage<{ x: number; y: number }>(vim.wc, `(() => { const r = document.getElementById('q').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    mouse(vim.wc, 'mouseMove', field.x, field.y)
    mouse(vim.wc, 'mouseDown', field.x, field.y)
    mouse(vim.wc, 'mouseUp', field.x, field.y)
    await sleep(150)
    for (const letter of ['j', 'k', 'f', 'd']) await press(vim.wc, letter, 60)
    await press(vim.wc, 'G')
    check('vim: in a field the keys are typed, not obeyed (the page did not scroll and no label appeared)', (await inPage<string>(vim.wc, `document.getElementById('q').value`)) === 'jkfdG' && (await scrollY(vim.wc)) === 0 && (await hostsOf(vim.wc)) === 0, await inPage<string>(vim.wc, `document.getElementById('q').value`))
    await inPage(vim.wc, `document.getElementById('q').blur(); document.getElementById('q').value = ''`)
    await focusPage(vim.wc)

    // A site left out of the keys.
    set({ vimKeysExcludedHosts: ['127.0.0.1'] })
    check('vim: a site in the list loses the tool, in the page already open', await waitFor(async () => (await toolsInstalled(vim.wc)).length === 0))
    await press(vim.wc, 'j')
    check('vim: ...and j does nothing there', (await scrollY(vim.wc)) === 0)
    set({ vimKeysExcludedHosts: [] })
    check('vim: taking the site out of the list brings the tool back', await waitFor(async () => (await toolsInstalled(vim.wc)).includes('vimKeys')))
    await focusPage(vim.wc)
    await press(vim.wc, 'j')
    check('vim: ...and j scrolls again', await waitFor(async () => (await scrollY(vim.wc)) === 60))

    // Modifiers are the browser's: ⌘J is not j.
    vim.wc.sendInputEvent({ type: 'keyDown', keyCode: 'j', modifiers: ['meta'] })
    vim.wc.sendInputEvent({ type: 'keyUp', keyCode: 'j', modifiers: ['meta'] })
    // A fixed wait, for want of a witness: ⌘J is a shortcut of the menu (« Aller à la sélection »), so the page may never see the key at all.
    await sleep(200)
    check('vim: ⌘ and a letter is left to the browser (j with ⌘ does not scroll)', (await scrollY(vim.wc)) === 60)

    set({ vimKeys: false })
    check('vim: switching it off takes the tool out of the page that is open', await waitFor(async () => (await toolsInstalled(vim.wc)).length === 0))
    await press(vim.wc, 'j')
    check('vim: ...and j scrolls nothing any more', (await scrollY(vim.wc)) === 60)
    closeMine()

    // ================================================================= an extension's tab groups in the sidebar
    const driver = engine.listExtensions().find((e) => e.name === 'Sec2 Driver Probe')
    check('groups: the Sec2 Driver Probe is loaded (LUCIUM_EXTENSIONS=$PWD/compat/sec-driver-probe:...)', driver !== undefined)
    if (driver) {
      const rpcTab = await open('/rpc')
      const rpc = {
        message: (ext: string, message: unknown): Promise<any> => withDeadline(rpcTab.wc.executeJavaScript(`window.rpc(${JSON.stringify(ext)}, ${JSON.stringify(message)})`) as Promise<any>, silent),
        call: (path: string, ...args: unknown[]): Promise<Reply> => withDeadline(rpcTab.wc.executeJavaScript(`window.call(${JSON.stringify(driver.id)}, ${JSON.stringify(path)}, ...${JSON.stringify(args)})`) as Promise<Reply>, silent)
      }
      const tabs = [await open('/s/ga'), await open('/s/gb'), await open('/s/gc'), await open('/s/gd'), await open('/s/ge')]
      const [ta, tb, tc, td, te] = tabs
      const number = (id: string) => engine.tabNumberOf(id) ?? -1
      const tabOf = (id: string) => state().tabs.find((t) => t.id === id)
      const folderNamed = (name: string) => state().folders.find((f) => f.name === name)
      const foldersBefore = state().folders.length

      const made = await rpc.call('tabs.group', { tabIds: [number(ta!.id), number(tb!.id)] })
      const groupId = Number(made.value)
      check('groups: the extension makes a group of two tabs', made.ok && Number.isInteger(groupId), JSON.stringify(made))
      // No wait after it: the change is applied while the call is handled, and the folders follow it in a microtask, before the answer leaves.
      await rpc.call('tabGroups.update', groupId, { title: 'Veille', color: 'blue' })
      check('groups: with the function off, no folder appears and the tabs are not pinned', state().folders.length === foldersBefore && !tabOf(ta!.id)?.pinned && !tabOf(tb!.id)?.pinned)

      set({ tabGroupFolders: true })
      check('groups: switched on, the group already there becomes a folder with its title', await waitFor(() => folderNamed('Veille') !== undefined), JSON.stringify(state().folders.map((f) => f.name)))
      const folder = () => folderNamed('Veille') ?? folderNamed('Autre')
      check('groups: ...holding both tabs, pinned', tabOf(ta!.id)?.folderId === folder()?.id && tabOf(tb!.id)?.folderId === folder()?.id && tabOf(ta!.id)?.pinned === true && tabOf(tb!.id)?.pinned === true)
      check('groups: ...in the space of its tabs', folder()?.spaceId === tabOf(ta!.id)?.spaceId)
      const written = persistableState(state())
      check('groups: the files the application writes never hold that folder, and the tabs are written where they were', !written.folders.some((f) => f.name === 'Veille') && written.tabs.find((t) => t.id === ta!.id)?.pinned === false && written.tabs.find((t) => t.id === tb!.id)?.folderId === undefined)

      await rpc.call('tabGroups.update', groupId, { title: 'Autre' })
      check('groups: a new title renames the folder', await waitFor(() => folderNamed('Autre') !== undefined && folderNamed('Veille') === undefined))
      await rpc.call('tabGroups.update', groupId, { collapsed: true })
      check('groups: collapsed closes the folder', await waitFor(() => folder()?.collapsed === true))
      await rpc.call('tabGroups.update', groupId, { collapsed: false })
      check('groups: ...and the group opened again opens it', await waitFor(() => folder()?.collapsed === false))

      await rpc.call('tabs.group', { tabIds: [number(tc!.id)], groupId })
      check('groups: a tab that joins the group joins the folder', await waitFor(() => tabOf(tc!.id)?.folderId === folder()?.id && tabOf(tc!.id)?.pinned === true))
      await rpc.call('tabs.ungroup', [number(ta!.id)])
      check('groups: a tab that leaves the group leaves the folder and is a Today tab again', await waitFor(() => tabOf(ta!.id)?.pinned === false && tabOf(ta!.id)?.folderId === undefined))
      check('groups: ...while the folder keeps the others', tabOf(tb!.id)?.folderId === folder()?.id && tabOf(tc!.id)?.folderId === folder()?.id)

      // What the user does to the folder.
      browser.dispatch({ type: 'tabs/move', ids: [tb!.id], toIndex: 0, pinned: false })
      await rpc.call('tabGroups.update', groupId, { title: 'Encore' })
      check('groups: a tab the user drags out of the folder stays out, even when the group changes', await waitFor(() => folderNamed('Encore') !== undefined) && tabOf(tb!.id)?.pinned === false && tabOf(tb!.id)?.folderId === undefined)
      browser.dispatch({ type: 'folder/delete', id: folderNamed('Encore')!.id })
      // No wait after it: the folders follow the change in a microtask of the call, before its answer leaves.
      await rpc.call('tabGroups.update', groupId, { title: 'Une fois de plus' })
      check('groups: a folder the user deletes is not built again for that group', state().folders.length === foldersBefore, JSON.stringify(state().folders.map((f) => f.name)))
      if (tabOf(tc!.id)?.pinned) browser.dispatch({ type: 'tab/unpin', id: tc!.id })
      await rpc.call('tabs.ungroup', [number(tb!.id), number(tc!.id)])

      // A group that ends, and the function switched off with a group alive.
      const second = await rpc.call('tabs.group', { tabIds: [number(td!.id), number(te!.id)] })
      await rpc.call('tabGroups.update', Number(second.value), { title: 'Seconde' })
      check('groups: a second group becomes a second folder', await waitFor(() => folderNamed('Seconde') !== undefined && tabOf(td!.id)?.pinned === true && tabOf(te!.id)?.pinned === true))
      // Only these two tabs are compared: tabs that earlier suites left in Today move around them when these two come back to Today.
      const ofGroup = () => state().tabs.map((t) => t.id).filter((id) => id === td!.id || id === te!.id)
      const before = ofGroup()
      set({ tabGroupFolders: false })
      check('groups: switched off with the group alive, the folder goes and the tabs are Today tabs again', await waitFor(() => folderNamed('Seconde') === undefined && tabOf(td!.id)?.pinned === false && tabOf(te!.id)?.pinned === false && tabOf(td!.id)?.folderId === undefined))
      check('groups: ...in the order they had', ofGroup().join() === before.join(), `${before.join()} / ${ofGroup().join()}`)
      await rpc.call('tabs.ungroup', [number(td!.id), number(te!.id)])
      check('groups: nothing of the function is left in the state (no folder)', state().folders.length === foldersBefore)
      closeMine()
    }

    // ================================================================= an extension's keyword (chrome.omnibox)
    const probe = engine.listExtensions().find((e) => e.name === 'Keyext Probe')
    const none = engine.listExtensions().find((e) => e.name === 'Sec2 No Permission Probe')
    check('omnibox: the Keyext Probe is loaded (LUCIUM_EXTENSIONS=$PWD/compat/keyext-probe:...)', probe !== undefined)
    if (probe) {
      check('omnibox: the engine reads the keyword of the manifest', probe.omniboxKeyword === 'kxp', String(probe.omniboxKeyword))
      const rpcTab = await open('/rpc')
      const message = (ext: string, body: unknown): Promise<any> => withDeadline(rpcTab.wc.executeJavaScript(`window.rpc(${JSON.stringify(ext)}, ${JSON.stringify(body)})`) as Promise<any>, silent)
      const logOf = async (): Promise<Array<{ event: string; text?: string; disposition?: string }>> => {
        const log: unknown = await message(probe.id, { type: 'log' })
        return Array.isArray(log) ? (log as never) : []
      }
      const surface = await message(probe.id, { type: 'surface' })
      check('omnibox: chrome.omnibox exists for the extension that declared a keyword, with its events', surface?.omnibox === 'object' && surface?.started === 'function' && surface?.entered === 'function' && surface?.setDefaultSuggestion === 'function', JSON.stringify(surface))
      check('omnibox: ...with the three places of Chrome', surface?.disposition?.CURRENT_TAB === 'currentTab' && surface?.disposition?.NEW_FOREGROUND_TAB === 'newForegroundTab' && surface?.disposition?.NEW_BACKGROUND_TAB === 'newBackgroundTab', JSON.stringify(surface?.disposition))
      requireProbes(engine.listExtensions(), ['Sec2 No Permission Probe'], check)
      if (none) {
        const kinds = await message(none.id, { type: 'typeof', paths: ['omnibox'] })
        check('omnibox: ...and for no other (an extension with no keyword has no chrome.omnibox)', kinds?.omnibox === 'undefined', JSON.stringify(kinds))
      }
      // The log is emptied each time it is read: the checks keep here what they read.
      const pending: Array<{ event: string; text?: string; disposition?: string }> = []
      await logOf()

      // ---- the bar ----
      const key = async (keyCode: string) => {
        ui.sendInputEvent({ type: 'keyDown', keyCode })
        ui.sendInputEvent({ type: 'keyUp', keyCode })
        await sleep(60)
      }
      const typeText = async (text: string) => {
        for (const ch of text) {
          // A key code exists for letters, digits and the space; the other characters (à é) reach the field as typed text.
          if (/^[a-z0-9]$/i.test(ch) || ch === ' ') {
            const keyCode = ch === ' ' ? 'Space' : ch
            ui.sendInputEvent({ type: 'keyDown', keyCode })
            ui.sendInputEvent({ type: 'char', keyCode: ch })
            ui.sendInputEvent({ type: 'keyUp', keyCode })
          } else ui.sendInputEvent({ type: 'char', keyCode: ch })
          await sleep(30)
        }
        await sleep(350)
      }
      const focused = async () => (await ui.executeJavaScript(`document.activeElement === document.querySelector('.palette-input')`)) === true
      const openBar = async (text: string, mode: 'new' | 'current' = 'new') => {
        // A request sent while the overlay page is still starting is lost: ask again until the field has the focus, then type.
        for (let attempt = 0; attempt < 4; attempt++) {
          browser.openOverlay({ panel: 'commandbar', mode, initial: '' })
          if (await waitFor(focused, 3000)) break
        }
        await sleep(200)
        await typeText(text)
      }
      const rows = () =>
        ui.executeJavaScript(
          `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', detail: li.querySelector('.detail')?.textContent ?? '', hint: li.querySelector('.hint')?.textContent ?? '', search: !!li.querySelector('.result-icon path[d^="M9 15.5"]') }))`
        ) as Promise<Array<{ label: string; detail: string; hint: string; search: boolean }>>

      await openBar('kxp bonjour')
      let list = await rows()
      check('omnibox: off, "kxp bonjour" is only a web search', list[0]?.search === true && !list.some((r) => r.detail.includes('Mot-clé d’extension')), JSON.stringify(list.slice(0, 2)))
      browser.closeOverlay()
      await sleep(150)
      // Its witness is the next text the bar gives the extension, below: it takes the same way, after this one.
      await ui.executeJavaScript(`window.lucium.omniboxEnter({ extensionId: ${JSON.stringify(probe.id)}, text: 'forcé', disposition: 'currentTab' })`)

      set({ omniboxKeywords: true })
      await openBar('kxp bonjour tout le monde')
      list = await rows()
      check('omnibox: on, "kxp bonjour tout le monde" leads with the extension and the text', list[0]?.label === frenchSpaces('Keyext Probe : « bonjour tout le monde »') && list[0]?.detail === '— Mot-clé d’extension' && list[0]?.hint === 'Envoyer à l’extension', JSON.stringify(list.slice(0, 2)))
      check('omnibox: ...and the web search of the same words is not offered', !list.some((r) => r.search), JSON.stringify(list.slice(0, 3)))
      const tabsBefore = state().tabs.length
      await key('Return')
      check('omnibox: Enter closes the bar', await waitFor(() => browser.currentPanel() === null))
      check('omnibox: ...tells the extension that input started, then gives it the text and the place (a bar opened for a new tab: in a new tab)', await waitFor(async () => {
        const log = await logOf()
        pending.push(...log)
        return pending.some((l) => l.event === 'entered')
      }), JSON.stringify(pending))
      check('omnibox: off, a request sent to the main process anyway reaches no extension', !pending.some((l) => l.text === 'forcé'), JSON.stringify(pending))
      check('omnibox: ...started first, entered second, with the text exactly as typed after the keyword', pending[0]?.event === 'started' && pending[1]?.event === 'entered' && pending[1]?.text === 'bonjour tout le monde' && pending[1]?.disposition === 'newForegroundTab', JSON.stringify(pending))
      check('omnibox: ...no suggestion was asked for (onInputChanged never fired), nothing was cancelled', !pending.some((l) => l.event === 'changed' || l.event === 'cancelled'), JSON.stringify(pending))
      check('omnibox: ...and no tab was opened by the bar itself', state().tabs.length === tabsBefore)
      pending.length = 0

      await openBar('kxp à la page', 'current')
      await key('Return')
      check('omnibox: a bar opened on the current page gives "currentTab"', await waitFor(async () => {
        pending.push(...(await logOf()))
        return pending.some((l) => l.event === 'entered')
      }) && pending.find((l) => l.event === 'entered')?.disposition === 'currentTab' && pending.find((l) => l.event === 'entered')?.text === 'à la page', JSON.stringify(pending))
      pending.length = 0

      await openBar('KXP majuscules')
      list = await rows()
      check('omnibox: the keyword is read without regard to case', list[0]?.label === frenchSpaces('Keyext Probe : « majuscules »'), JSON.stringify(list.slice(0, 1)))
      browser.closeOverlay()
      await sleep(150)
      await openBar('kxp')
      list = await rows()
      check('omnibox: the keyword alone (no space yet) is an ordinary search', list[0]?.search === true && !list.some((r) => r.detail.includes('Mot-clé d’extension')), JSON.stringify(list.slice(0, 2)))
      browser.closeOverlay()
      await sleep(150)

      // A request that makes no sense, from a compromised interface: nothing is delivered.
      const forged: string[] = [
        `{ extensionId: ${JSON.stringify(probe.id)}, text: 'x', disposition: 'popup' }`,
        `{ extensionId: ${JSON.stringify(probe.id)}, text: 'x', disposition: 'currentTab', extra: true }`,
        `{ extensionId: 'abc', text: 'x', disposition: 'currentTab' }`,
        `{ extensionId: ${JSON.stringify(probe.id)}, text: 'x'.repeat(5000), disposition: 'currentTab' }`,
        `{ extensionId: ${JSON.stringify(probe.id)}, text: 42, disposition: 'currentTab' }`,
        `'kxp x'`
      ]
      if (none) forged.push(`{ extensionId: ${JSON.stringify(none.id)}, text: 'x', disposition: 'currentTab' }`)
      // A refusal is a console line in the main process, not an error in the page: a call that throws here is a failed check (the run stops with its stack).
      for (const request of forged) await ui.executeJavaScript(`window.lucium.omniboxEnter(${request})`)
      // The witness: a request that is exactly one, sent after them the same way, reaches the extension; whatever came before it would be there first.
      await ui.executeJavaScript(`window.lucium.omniboxEnter({ extensionId: ${JSON.stringify(probe.id)}, text: 'témoin', disposition: 'currentTab' })`)
      const delivered: Array<{ event: string; text?: string }> = []
      const witnessed = await waitFor(async () => {
        delivered.push(...(await logOf()))
        return delivered.some((l) => l.event === 'entered' && l.text === 'témoin')
      })
      check('omnibox: a request that is not exactly an extension, a text and a place reaches nobody; neither does one for an extension with no keyword', witnessed && delivered.filter((l) => l.event === 'entered').length === 1 && delivered.filter((l) => l.event === 'started').length <= 1, JSON.stringify(delivered))

      set({ omniboxKeywords: false })
      await openBar('kxp encore')
      list = await rows()
      check('omnibox: switched off again, the bar is the bar of Arc', list[0]?.search === true && !list.some((r) => r.detail.includes('Mot-clé d’extension')), JSON.stringify(list.slice(0, 2)))
      browser.closeOverlay()
      // The witness: switched on for it alone, a request sent after the bar reaches the extension the same way; what the bar sent while the
      // keywords were off would be there before it.
      set({ omniboxKeywords: true })
      await ui.executeJavaScript(`window.lucium.omniboxEnter({ extensionId: ${JSON.stringify(probe.id)}, text: 'témoin final', disposition: 'currentTab' })`)
      const whileOff: Array<{ event: string; text?: string }> = []
      const reachedAfter = await waitFor(async () => {
        whileOff.push(...(await logOf()))
        return whileOff.some((l) => l.event === 'entered' && l.text === 'témoin final')
      })
      set({ omniboxKeywords: false })
      check('omnibox: ...and nothing was delivered while it was off', reachedAfter && whileOff.every((l) => l.event === 'started' || (l.event === 'entered' && l.text === 'témoin final')) && whileOff.filter((l) => l.event === 'started').length <= 1, JSON.stringify(whileOff))
      closeMine()

      // ================================================================= an extension's access to sites
      // Not a feature: the proof that the engine has no way to hold an extension's host access back (docs/compat-extension-claude.md, « Accès aux sites »).
      // If a later Electron gives it one, this check fails and the document is out of date.
      const site = await open('/s/keyext-site-1')
      const injected = (wc: WebContents) => inPage<string | null>(wc, `document.documentElement.getAttribute('data-keyext-probe')`)
      check('site access: a content script declared in the manifest is injected into a page that matches it', await waitFor(async () => (await injected(site.wc)) === 'injected'), String(await injected(site.wc)))
      const rpcAgain = await open('/rpc')
      const withhold = (await withDeadline(rpcAgain.wc.executeJavaScript(`window.rpc(${JSON.stringify(probe.id)}, { type: 'withhold' })`) as Promise<any>, silent)) as { before?: unknown; removed?: unknown; after?: unknown }
      await site.wc.loadURL(`${base}/s/keyext-site-2`)
      await waitFor(() => loading(site.id) === false)
      check('site access: ...and still is after the extension took its host permission back with chrome.permissions.remove (what Chrome does for "on click"): Electron has no way to hold it back', await waitFor(async () => (await injected(site.wc)) === 'injected'), `permissions: ${JSON.stringify(withhold)}, attribute: ${String(await injected(site.wc))}`)
      closeMine()
    }
  } finally {
    set({
      sleepAfterMinutes: original.sleepAfterMinutes,
      vimKeys: original.vimKeys,
      vimKeysExcludedHosts: original.vimKeysExcludedHosts,
      tabGroupFolders: original.tabGroupFolders,
      omniboxKeywords: original.omniboxKeywords,
      searchSuggestions: original.searchSuggestions,
      modifiedClickBackground: original.modifiedClickBackground,
      backClosesOpenedTab: original.backClosesOpenedTab,
      autoScroll: original.autoScroll,
      mouseGestures: original.mouseGestures,
      scrollSync: original.scrollSync
    })
    browser.closeOverlay()
    closeMine()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export async function runKeyExtSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeKeyExt(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeKeyExt ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_KEYEXT ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
