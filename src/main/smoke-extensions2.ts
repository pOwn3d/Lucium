// Engine checks for extension features, run inside a real Electron:
//  - the data APIs (chrome.history, bookmarks, browsingData): two probes of compat/ (one with the permissions, one without) are driven by
//    a local page; what they get is what the extension API defines, scoped to its profile, and the one without the permission is refused
//    by the main process even when it goes round the namespace;
//  - the « menu of the toolbar: nine tiny extensions put icons in the bar, the window narrows, the plan hides the surplus, the menu
//    lists it, pinning and unpinning work from the icon's own menu, and with the setting off the bar is the library's own;
//  - the user-script manager: a script runs in the pages it names, only once switched on, never on a sign-in page, never in a private
//    window unless allowed, and a script that cannot even be parsed by the page is reported.
// Called from the engine smoke test: `await smokeExtensions2(ctx, check)`. `LUCIUM_SMOKE_ONLY=extensions2` runs it alone, with
// LUCIUM_EXTENSIONS=$PWD/compat/data-api-probe:$PWD/compat/data-api-denied-probe.

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow as ElectronWindow, Menu, session, webContents as allWebContents, type WebContents } from 'electron'
import type { ShimCall } from './engine/types'
import type { SmokeContext } from './smoke'
import { userScripts } from './userscripts'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void
type Reply = { ok: boolean; value?: any; error?: string }


const waitFor = waiterOf(10_000, 80)

const withDeadline = <T>(promise: Promise<T>, fallback: T, ms = 25_000): Promise<T> => Promise.race([promise, sleep(ms).then(() => fallback)])
const silent: Reply = { ok: false, error: 'no answer from the worker within 25 seconds' }

const RPC_PAGE = `<title>ext2-rpc</title><body>rpc page<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
</script></body>`

const userScript = (name: string, body: string, header = ''): string => `// ==UserScript==\n// @name ${name}\n// @match http://127.0.0.1/*\n// @grant none\n// @run-at document-end\n${header}// ==/UserScript==\n${body}\n`

export async function smokeExtensions2(ctx: SmokeContext, check: Check): Promise<'ran' | 'skipped'> {
  const { browser, store, engine, history, win } = ctx
  const named = (name: string) => engine.listExtensions().find((e) => e.name === name)
  const allowed = named('Lucium Data API Probe')
  const denied = named('Lucium Data API Denied Probe')
  if (!allowed || !denied) {
    console.log('[extensions2] skipped: compat/data-api-probe and compat/data-api-denied-probe are not in LUCIUM_EXTENSIONS')
    return 'skipped'
  }
  const startTabs = new Set(store.get().tabs.map((t) => t.id))
  const sleepAfter = store.get().settings.sleepAfterMinutes
  const originalSize = win.getSize()
  const originalSettings = store.get().settings
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    if (path === '/rpc') return void res.end(RPC_PAGE)
    res.end(`<title>e2 ${path}</title><body>e2 ${path}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const home = store.get().activeSpaceId
  const opened: string[] = []
  let secondSpace: string | undefined
  /** The favourite this suite adds to the other profile (removed at the end, wherever the run stops). */
  let otherFavouriteId: string | undefined
  const wcOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  const titleOf = (tabId: string) => store.get().tabs.find((t) => t.id === tabId)?.title ?? ''
  const openTab = async (url: string, readyTitle?: (t: string) => boolean, spaceId?: string): Promise<{ id: string; wc: WebContents }> => {
    browser.dispatch({ type: 'tab/open', url, ...(spaceId ? { spaceId } : {}) })
    const tab = store.get().tabs.at(-1)!
    opened.push(tab.id)
    await waitFor(() => wcOf(tab.id) !== undefined, 8000)
    if (readyTitle) await waitFor(() => readyTitle(titleOf(tab.id)), 8000)
    return { id: tab.id, wc: wcOf(tab.id)! }
  }
  const driver = (wc: WebContents, deadline = 25_000) => ({
    message: (ext: string, message: unknown): Promise<Reply> => withDeadline(wc.executeJavaScript(`window.rpc(${JSON.stringify(ext)}, ${JSON.stringify(message)})`) as Promise<Reply>, silent, deadline),
    call: (ext: string, path: string, ...args: unknown[]): Promise<Reply> => withDeadline(wc.executeJavaScript(`window.rpc(${JSON.stringify(ext)}, ${JSON.stringify({ type: 'call', path, args })})`) as Promise<Reply>, silent, deadline),
    raw: (ext: string, api: string, method: string, ...args: unknown[]): Promise<Reply> => withDeadline(wc.executeJavaScript(`window.rpc(${JSON.stringify(ext)}, ${JSON.stringify({ type: 'raw', api, method, args })})`) as Promise<Reply>, silent, deadline)
  })

  try {
    // ================= history, bookmarks, browsingData =================
    console.log('[extensions2] data APIs')
    const profile = 'default'
    // In the engine chain every suite shares one process: the history, the favourites and the pinned tabs of the suites before this one are
    // there, so everything below looks for a word nobody else uses ("zqxe2") and for exact addresses, never for a count of pages.
    const hasPage = (url: string, of = profile) => history.of(of).search('', 20_000).some((entry) => entry.url === url)
    history.of(profile).record(`${base}/page-one`, 'Zqxe2 Page One')
    history.of(profile).record(`${base}/page-two`, 'Zqxe2 Another Page')
    const favouritesBefore = store.get().favorites.length
    browser.dispatch({ type: 'favorite/add', url: `${base}/fav`, title: 'Zqxe2 Favourite' })
    const pinned = await openTab(`${base}/pinned`, (t) => t === 'e2 /pinned')
    browser.dispatch({ type: 'tab/pin', id: pinned.id })

    const rpcTab = await openTab(`${base}/rpc`, (t) => t === 'ext2-rpc')
    check('extensions2: the page that drives the probes loads', rpcTab.wc !== undefined && titleOf(rpcTab.id) === 'ext2-rpc')
    const rpc = driver(rpcTab.wc)

    const kinds = async (ext: string) => (await rpc.message(ext, { type: 'typeof', paths: ['history', 'history.search', 'bookmarks', 'bookmarks.getTree', 'browsingData', 'browsingData.remove'] })) as unknown as Record<string, string>
    const mine = await kinds(allowed.id)
    const theirs = await kinds(denied.id)
    check('extensions2 H: an extension that declared history, bookmarks and browsingData has the three namespaces', ['history', 'bookmarks', 'browsingData'].every((n) => mine[n] === 'object') && mine['history.search'] === 'function', JSON.stringify(mine))
    check('extensions2 H: one that declared none of them has none (they are not defined for everyone)', ['history', 'bookmarks', 'browsingData'].every((n) => theirs[n] === 'undefined'), JSON.stringify(theirs))

    await sleep(30)
    const found = await rpc.call(allowed.id, 'history.search', { text: 'zqxe2 one', maxResults: 10 })
    const item = found.ok && Array.isArray(found.value) ? (found.value as Array<Record<string, unknown>>).find((entry) => entry['url'] === `${base}/page-one`) : undefined
    check('extensions2 H: history.search finds the page of the profile by words of its title, in Chrome\'s shape (id, url, title, lastVisitTime, visitCount, typedCount)', !!item && JSON.stringify(Object.keys(item).sort()) === JSON.stringify(['id', 'lastVisitTime', 'title', 'typedCount', 'url', 'visitCount']) && item['title'] === 'Zqxe2 Page One' && typeof item['id'] === 'string' && typeof item['lastVisitTime'] === 'number' && (item['visitCount'] as number) >= 1 && item['typedCount'] === 0 && (found.value as unknown[]).length === 1, JSON.stringify(found).slice(0, 400))
    const everything = await rpc.call(allowed.id, 'history.search', { text: '' })
    const times = everything.ok && Array.isArray(everything.value) ? (everything.value as Array<{ lastVisitTime: number }>).map((entry) => entry.lastVisitTime) : []
    check('extensions2 H: an empty search lists the last day, most recent first', times.length >= 2 && times.every((time, i) => i === 0 || times[i - 1]! >= time), JSON.stringify(everything).slice(0, 300))
    const visits = await rpc.call(allowed.id, 'history.getVisits', { url: `${base}/page-one` })
    check('extensions2 H: history.getVisits shows the last visit', visits.ok && Array.isArray(visits.value) && visits.value.length === 1 && typeof visits.value[0].visitTime === 'number', JSON.stringify(visits))
    const deleteOne = await rpc.call(allowed.id, 'history.deleteUrl', { url: `${base}/page-one` })
    check('extensions2 H: deleting history is refused, with the reason, and the page is still there', !deleteOne.ok && /read-only/.test(deleteOne.error ?? '') && hasPage(`${base}/page-one`), JSON.stringify(deleteOne))

    const tree = await rpc.call(allowed.id, 'bookmarks.getTree')
    const flat = JSON.stringify(tree.value ?? null)
    check('extensions2 H: bookmarks.getTree holds the favourite and the pinned tab', tree.ok && flat.includes(`${base}/fav`) && flat.includes('Zqxe2 Favourite') && flat.includes(`${base}/pinned`), flat.slice(0, 400))
    const search = await rpc.call(allowed.id, 'bookmarks.search', 'zqxe2')
    check('extensions2 H: bookmarks.search finds the favourite and no folder', search.ok && Array.isArray(search.value) && search.value.length === 1 && search.value[0].url === `${base}/fav` && !('children' in search.value[0]), JSON.stringify(search))
    const create = await rpc.call(allowed.id, 'bookmarks.create', { title: 'x', url: 'https://example.com/' })
    check('extensions2 H: creating a bookmark is refused, and the favourites are as they were', !create.ok && /read-only/.test(create.error ?? '') && store.get().favorites.length === favouritesBefore + 1, JSON.stringify(create))

    // ---- browsingData: by origin, in the profile of the extension, nothing wider ----
    const jar = session.fromPartition(`persist:profile-${profile}`)
    const origin = base
    const otherOrigin = `http://localhost:${port}`
    await jar.cookies.set({ url: `${origin}/`, name: 'e2-a', value: '1' })
    await jar.cookies.set({ url: `${otherOrigin}/`, name: 'e2-b', value: '1' })
    const cookieNames = async () => (await jar.cookies.get({})).map((c) => c.name)
    const noOrigins = await rpc.call(allowed.id, 'browsingData.remove', {}, { cookies: true })
    check('extensions2 H: browsingData.remove without origins is refused and erases nothing', !noOrigins.ok && /origins/.test(noOrigins.error ?? '') && (await cookieNames()).includes('e2-a'), JSON.stringify(noOrigins))
    const passwords = await rpc.call(allowed.id, 'browsingData.remove', { origins: [origin] }, { passwords: true })
    check('extensions2 H: a kind of data Lucium does not erase for an extension is refused', !passwords.ok && /does not erase/.test(passwords.error ?? ''), JSON.stringify(passwords))
    const since = await rpc.call(allowed.id, 'browsingData.removeCookies', { origins: [origin], since: Date.now() - 1000 })
    check('extensions2 H: a start time is refused, because storage cannot be erased by date', !since.ok && /since/.test(since.error ?? '') && (await cookieNames()).includes('e2-a'), JSON.stringify(since))
    const removed = await rpc.call(allowed.id, 'browsingData.removeCookies', { origins: [origin] })
    check('extensions2 H: browsingData.removeCookies erases the cookies of the origin it names and of no other', removed.ok && !(await cookieNames()).includes('e2-a') && (await cookieNames()).includes('e2-b'), JSON.stringify({ removed, left: await cookieNames() }))
    const forgot = await rpc.call(allowed.id, 'browsingData.remove', { origins: [origin] }, { history: true })
    check('extensions2 H: asking for the history of a site forgets its pages in the history of the profile', forgot.ok && !hasPage(`${base}/page-one`) && !hasPage(`${base}/page-two`), JSON.stringify(forgot))
    history.of(profile).record(`${base}/page-one`, 'Zqxe2 Page One')

    // ---- the same calls, from an extension that declared nothing: refused by the main process even round the namespace ----
    const refused: Record<string, Reply> = {
      'history.search': await rpc.raw(denied.id, 'history', 'search', { text: '' }),
      'history.getVisits': await rpc.raw(denied.id, 'history', 'getVisits', { url: `${base}/page-one` }),
      'bookmarks.getTree': await rpc.raw(denied.id, 'bookmarks', 'getTree'),
      'bookmarks.search': await rpc.raw(denied.id, 'bookmarks', 'search', 'zqxe2'),
      'browsingData.settings': await rpc.raw(denied.id, 'browsingData', 'settings'),
      'browsingData.remove': await rpc.raw(denied.id, 'browsingData', 'remove', { origins: [otherOrigin] }, { cookies: true })
    }
    check('extensions2 H: without the permission every call is refused by the main process, namespace or not', Object.values(refused).every((r) => !r.ok && /no permission to use chrome\./.test(r.error ?? '')), JSON.stringify(refused))
    check('extensions2 H: ...and the refused browsingData.remove erased nothing', (await cookieNames()).includes('e2-b'))
    const sameCall = await rpc.raw(allowed.id, 'history', 'search', { text: 'zqxe2' })
    check('extensions2 H: the same raw call with the permission is answered', sameCall.ok && Array.isArray(sameCall.value) && sameCall.value.length >= 1, JSON.stringify(sameCall).slice(0, 300))

    // ---- another profile has a history of its own ----
    const urlsIn = (r: Reply): string[] => (r.ok && Array.isArray(r.value) ? (r.value as Array<{ url: string }>).map((i) => i.url) : [])
    const otherUrl = `${base}/other-profile-page`
    browser.dispatch({ type: 'space/create', name: 'Autre profil', emoji: '🧪', hue: 140 })
    secondSpace = store.get().activeSpaceId
    browser.dispatch({ type: 'space/update', id: secondSpace, patch: { profileId: 'extprofile' } })
    history.of('extprofile').record(otherUrl, 'Zqxe2 Only In The Other Profile')

    // What decides the profile is the profile of the call, which the engine takes from the session the extension runs in: the handler of the
    // main process is asked directly, as the engine does, so that this holds whether or not the worker of that profile has started yet.
    const shimHandler = (engine as unknown as { shimHandler: ((call: ShimCall) => Promise<unknown>) | null }).shimHandler
    const direct = async (profileId: string, api: string, method: string, ...args: unknown[]): Promise<Reply> => {
      if (!shimHandler) return { ok: false, error: 'the engine has no handler for the shims' }
      try {
        return { ok: true, value: await shimHandler({ extensionId: allowed.id, profileId, api, method, args, context: 'smoke:extensions2' }) }
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error) }
      }
    }
    const otherDirect = await direct('extprofile', 'history', 'search', { text: 'zqxe2' })
    const homeDirect = await direct(profile, 'history', 'search', { text: 'zqxe2' })
    check('extensions2 H: a call made for another profile reads that profile\'s history only, and the first profile\'s calls do not see its pages', urlsIn(otherDirect).includes(otherUrl) && !urlsIn(otherDirect).includes(`${base}/page-one`) && urlsIn(homeDirect).includes(`${base}/page-one`) && !urlsIn(homeDirect).includes(otherUrl), JSON.stringify({ otherDirect, homeDirect }).slice(0, 400))
    const homeSearch = await rpc.call(allowed.id, 'history.search', { text: 'zqxe2' })
    check('extensions2 H: ...and the extension of the first profile, through its own worker, does not see the other one\'s pages either', homeSearch.ok && !urlsIn(homeSearch).includes(otherUrl) && urlsIn(homeSearch).includes(`${base}/page-one`), JSON.stringify(homeSearch).slice(0, 300))
    // Favourites belong to a profile: a profile made by this suite starts with none, and the extension that runs in it reads its own, never the first profile's.
    // An address is looked for as a whole `"url":"…"` so that `/fav` does not match `/fav-other`.
    const hasUrl = (flat: string, url: string): boolean => flat.includes(`"url":"${url}"`)
    const otherTreeDirect = await direct('extprofile', 'bookmarks', 'getTree')
    const otherFlat = JSON.stringify(otherTreeDirect.value ?? null)
    check('extensions2 H: in the other profile the favourites of the first profile are not there, nor are its pinned tabs', otherTreeDirect.ok && !hasUrl(otherFlat, `${base}/fav`) && !otherFlat.includes(`${base}/pinned`), otherFlat.slice(0, 300))
    const otherFavouriteUrl = `${base}/fav-other`
    browser.dispatch({ type: 'favorite/add', url: otherFavouriteUrl, title: 'Zqxe2 Other Favourite', spaceId: secondSpace })
    otherFavouriteId = store.get().favorites.find((f) => f.url === otherFavouriteUrl)?.id
    const otherAfter = JSON.stringify((await direct('extprofile', 'bookmarks', 'getTree')).value ?? null)
    const homeAfter = JSON.stringify((await direct(profile, 'bookmarks', 'getTree')).value ?? null)
    check('extensions2 H: a favourite added in the other profile is in the bookmarks of that profile\'s extension, and not in the first profile\'s (which keeps its own)', otherFavouriteId !== undefined && hasUrl(otherAfter, otherFavouriteUrl) && !hasUrl(homeAfter, otherFavouriteUrl) && hasUrl(homeAfter, `${base}/fav`) && !hasUrl(otherAfter, `${base}/fav`), JSON.stringify({ otherAfter: otherAfter.slice(0, 200), homeAfter: homeAfter.slice(0, 200) }))
    if (otherFavouriteId !== undefined) browser.dispatch({ type: 'favorite/remove', id: otherFavouriteId })
    otherFavouriteId = undefined

    // The worker of that profile itself. The profile is made when its first page is, with the extensions of the others (the chain loads nine,
    // which takes longer than the two of a run alone): the page that drives the probe is loaded again once the probe is in the session, since
    // a page is given its way to an extension when it loads, and the calls are tried again for a while.
    const secondRpc = await openTab(`${base}/rpc`, (t) => t === 'ext2-rpc', secondSpace)
    browser.dispatch({ type: 'tab/select', id: secondRpc.id })
    const loadedThere = await waitFor(() => engine.listExtensions().some((e) => e.id === allowed.id && e.profileId === 'extprofile'), 30_000)
    check('extensions2 H: a profile created after startup gets the probe too', loadedThere, JSON.stringify(engine.listExtensions().filter((e) => e.profileId === 'extprofile').map((e) => e.name)))
    secondRpc.wc.reload()
    await sleep(300)
    await waitFor(() => !secondRpc.wc.isLoading() && titleOf(secondRpc.id) === 'ext2-rpc', 10_000)
    const second = driver(secondRpc.wc, 10_000)
    let otherSearch: Reply = silent
    for (let attempt = 0; attempt < 6 && !otherSearch.ok; attempt++) otherSearch = await second.call(allowed.id, 'history.search', { text: 'zqxe2' })
    check('extensions2 H: in another profile the extension, through its own worker, reads that profile\'s history only', otherSearch.ok && urlsIn(otherSearch).includes(otherUrl) && !urlsIn(otherSearch).includes(`${base}/page-one`), JSON.stringify({ otherSearch, tab: { url: secondRpc.wc.getURL(), title: titleOf(secondRpc.id) }, extensions: engine.listExtensions().filter((e) => e.profileId === 'extprofile').length }).slice(0, 400))
    browser.dispatch({ type: 'tab/close', id: secondRpc.id })
    browser.dispatch({ type: 'space/select', id: home })
    browser.dispatch({ type: 'space/delete', id: secondSpace })
    secondSpace = undefined

    // ---- the setting that gives these APIs: off, every call is refused ----
    browser.dispatch({ type: 'settings/update', patch: { extensionDataApis: false } })
    const off = await rpc.call(allowed.id, 'history.search', { text: '' })
    const offTree = await rpc.call(allowed.id, 'bookmarks.getTree')
    check('extensions2 H: with the setting off the extension that has the permission is refused too, with the reason', !off.ok && /switched off/.test(off.error ?? '') && !offTree.ok && /switched off/.test(offTree.error ?? ''), JSON.stringify({ off, offTree }))
    browser.dispatch({ type: 'settings/update', patch: { extensionDataApis: true } })
    check('extensions2 H: ...and works again when it is turned back on', (await rpc.call(allowed.id, 'history.search', { text: 'zqxe2' })).ok)
    browser.dispatch({ type: 'tab/unpin', id: pinned.id })
    // Only the favourite of this suite goes: the ones of the suites before it are not its to remove.
    const mineFavourite = store.get().favorites.find((f) => f.url === `${base}/fav`)
    if (mineFavourite) browser.dispatch({ type: 'favorite/remove', id: mineFavourite.id })

    // ================= the « menu =================
    console.log('[extensions2] overflow menu')
    const root = mkdtempSync(join(tmpdir(), 'lucium-ext2-icons-'))
    // The nine extensions stay loaded from this folder until the application quits (the suites after this one count them): it goes with the application.
    app.once('quit', () => rmSync(root, { recursive: true, force: true }))
    const iconIds: string[] = []
    for (let i = 0; i < 9; i++) {
      const dir = join(root, `icon${i}`)
      mkdirSync(dir)
      // An empty worker: an extension without one makes the engine wait ten seconds for it to announce that it was installed.
      writeFileSync(join(dir, 'worker.js'), '')
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: `Ext2 Icon ${i}`, version: '1.0.0', background: { service_worker: 'worker.js' }, action: { default_title: `Ext2 Icon ${i}` } }))
      iconIds.push((await engine.loadExtension('default', dir)).id)
    }
    const chrome = win.webContents
    const evaluate = <T>(code: string): Promise<T> => chrome.executeJavaScript(code) as Promise<T>
    const barState = () =>
      evaluate<{ total: number; visible: string[]; hidden: string[]; button: { x: number; y: number; width: number; height: number } | null; bar: number }>(`(() => {
        const list = document.querySelector('.page-toolbar browser-action-list')
        const nodes = [...(list?.shadowRoot?.querySelectorAll('.action') ?? [])]
        const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
        const button = document.querySelector('.tb-overflow')
        return { total: nodes.length, visible: nodes.filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.id), hidden: nodes.filter((n) => n.hidden).map((n) => n.id), button: button ? rect(button) : null, bar: document.querySelector('.page-toolbar').getBoundingClientRect().width }
      })()`)
    await waitFor(async () => (await barState()).total >= 9 + 2, 15_000)

    // Off: the bar is the library's own, whatever the width and whatever was unpinned.
    browser.dispatch({ type: 'settings/update', patch: { extensionOverflow: false, unpinnedExtensions: [iconIds[0]!] } })
    win.setSize(960, 700)
    await sleep(700)
    const off1 = await barState()
    check('extensions2 O: with the setting off nothing is hidden and there is no « button, narrow window and unpinned extension included', off1.total >= 11 && off1.hidden.length === 0 && off1.visible.length === off1.total && off1.button === null, JSON.stringify(off1))
    // ...and the menu of an icon is the extension's own: no entry to pin or unpin.
    const offMenus: string[][] = []
    const offPopup = Menu.prototype.popup
    Menu.prototype.popup = function (this: Menu) {
      offMenus.push(this.items.map((i) => i.label))
      return this
    } as typeof Menu.prototype.popup
    try {
      const first = await evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('.page-toolbar browser-action-list').shadowRoot.querySelector('.action').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      const [fx, fy] = [Math.round(first.x + first.width / 2), Math.round(first.y + first.height / 2)]
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) win.webContents.sendInputEvent({ type, x: fx, y: fy, button: 'right', clickCount: 1 })
      await waitFor(() => offMenus.length > 0, 4000)
    } finally {
      Menu.prototype.popup = offPopup
    }
    check('extensions2 O: with the setting off the right-click menu of an icon has no pin entry', offMenus.length === 1 && !offMenus[0]!.some((label) => /pingler/.test(label)), JSON.stringify(offMenus))
    browser.dispatch({ type: 'settings/update', patch: { unpinnedExtensions: [] } })

    // On, wide: nothing moves when everything fits (the window is as wide as the screen lets it be).
    browser.dispatch({ type: 'settings/update', patch: { extensionOverflow: true } })
    win.setSize(Math.max(originalSize[0] ?? 1200, 1400), 800)
    await sleep(900)
    const wide = await barState()
    const fits = wide.hidden.length === 0
    check('extensions2 O: with the setting on and room for every icon, no icon is hidden and there is no « button; when the window is too narrow for them all (many probes), a button takes the surplus', fits ? wide.button === null : wide.button !== null && wide.visible.length < wide.total, JSON.stringify(wide))

    // On, narrow: the surplus goes to the menu, the address keeps its room.
    // The bar has more buttons than it had (translation, readable mode…): at 960 px not one of the icons of the fourteen probes fits any more, they are all in the menu.
    // The narrow window is the widest of these that hides some and keeps some.
    let narrow = await barState()
    for (const width of [1150, 1050, 960]) {
      win.setSize(width, 700)
      await sleep(900)
      narrow = await barState()
      if (narrow.hidden.length > 0 && narrow.visible.length > 0) break
    }
    check('extensions2 O: in a narrow window some icons are hidden and a « button shows, in the 24 px of an icon', narrow.hidden.length > 0 && narrow.visible.length > 0 && narrow.visible.length < narrow.total && narrow.button !== null && Math.abs(narrow.button.width - 24) <= 1, JSON.stringify(narrow))
    const addressRoom = await evaluate<number>(`document.querySelector('.tb-address').getBoundingClientRect().width`)
    check('extensions2 O: ...and the room left to the address is at least its minimum (180 px)', addressRoom >= 180 - 1, `room ${addressRoom}px, groups ${JSON.stringify(await evaluate<string[]>(`[...document.querySelector('.page-toolbar').children].map((group) => group.className + ':' + group.getBoundingClientRect().width)`))}, ${narrow.visible.length} icon(s) kept of ${narrow.total}`)

    // The menu of the « button lists exactly the hidden icons, and a click on one activates that extension.
    const captured: Array<{ labels: string[]; click: (label: string) => void }> = []
    const realPopup = Menu.prototype.popup
    Menu.prototype.popup = function (this: Menu) {
      const items = this.items
      captured.push({ labels: items.map((i) => i.label), click: (label) => items.find((i) => i.label === label)?.click() })
      return this
    } as typeof Menu.prototype.popup
    const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number, button: 'left' | 'right' = 'left') => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount: 1 })
    const click = (rect: { x: number; y: number; width: number; height: number }, button: 'left' | 'right' = 'left') => {
      const [x, y] = [rect.x + rect.width / 2, rect.y + rect.height / 2]
      mouse('mouseMove', x, y)
      mouse('mouseDown', x, y, button)
      mouse('mouseUp', x, y, button)
    }
    const nameOf = (id: string) => engine.listExtensions().find((e) => e.id === id)?.name ?? id
    try {
      click(narrow.button!)
      await waitFor(() => captured.length > 0, 4000)
      // An extension that opens its side panel on a click of its icon has its panel opened instead (browser-commands.ts): the checks of the anchor take another.
      const hiddenTarget = narrow.hidden.find((id) => store.get().sidePanelBehavior[id] !== true) ?? narrow.hidden[0]!
      const shownNames = narrow.hidden.map(nameOf)
      check('extensions2 O: a click on the « button opens a menu with the name of every hidden extension, then the pin submenu and the link to the settings', captured.length === 1 && shownNames.every((n) => captured[0]!.labels.includes(n)) && captured[0]!.labels.includes('Épingler à la barre d’outils') && captured[0]!.labels.includes('Gérer les extensions…'), JSON.stringify(captured[0]?.labels))
      const activations: string[] = []
      const realActivate = browser.activateExtension.bind(browser)
      browser.activateExtension = (id: string) => {
        activations.push(id)
        return Promise.resolve()
      }
      captured[0]!.click(nameOf(hiddenTarget))
      browser.activateExtension = realActivate
      check('extensions2 O: choosing an extension in the menu activates it', activations.length === 1 && activations[0] === hiddenTarget, JSON.stringify(activations))

      // A hidden icon can still be activated, and its popup is anchored under the « button.
      const router = (engine as unknown as { profiles: Map<string, { router: { handlers: Map<string, { callback: (...args: any[]) => unknown }> } }> }).profiles.get('default')!.router
      const handler = router.handlers.get('browserAction.activate')!
      const originalCallback = handler.callback
      const seen: Array<{ extensionId: string; anchorRect: { x: number; y: number; width: number; height: number } }> = []
      handler.callback = (event: unknown, details: any) => {
        seen.push(details)
        return originalCallback(event, details)
      }
      await browser.activateExtension(hiddenTarget)
      handler.callback = originalCallback
      await sleep(300)
      const anchored = seen.find((s) => s.extensionId === hiddenTarget)
      check('extensions2 O: an extension that is in the menu is activated under the « button, not at the corner of the window', !!anchored && Math.abs(anchored.anchorRect.x - narrow.button!.x) <= 1 && anchored.anchorRect.width > 0, JSON.stringify(anchored))

      // The menu of an icon offers to unpin it; unpinning takes the icon out of the bar into the « menu, even where there is room.
      const target = narrow.visible[0]!
      const targetRect = await evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('.page-toolbar browser-action-list').shadowRoot.getElementById(${JSON.stringify(target)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      captured.length = 0
      click(targetRect, 'right')
      await waitFor(() => captured.length > 0, 4000)
      check('extensions2 O: the right-click menu of an icon offers to remove it from the bar', captured.length === 1 && captured[0]!.labels.includes('Désépingler de la barre d’outils'), JSON.stringify(captured[0]?.labels))
      captured[0]?.click('Désépingler de la barre d’outils')
      await waitFor(async () => store.get().settings.unpinnedExtensions.includes(target) && (await barState()).hidden.includes(target))
      const afterUnpin = await barState()
      check('extensions2 O: after "Désépingler" the icon is in the menu list and no longer in the bar, and the setting keeps it', store.get().settings.unpinnedExtensions.includes(target) && afterUnpin.hidden.includes(target) && !afterUnpin.visible.includes(target), JSON.stringify({ unpinned: store.get().settings.unpinnedExtensions, afterUnpin }))
      captured.length = 0
      click(afterUnpin.button!)
      await waitFor(() => captured.length > 0, 4000)
      check('extensions2 O: ...and the « menu now lists it', captured[0]?.labels.includes(nameOf(target)) === true, JSON.stringify(captured[0]?.labels))
      browser.setExtensionPinned(target, true)
      check('extensions2 O: pinning it again gives it its place back', await waitFor(async () => !store.get().settings.unpinnedExtensions.includes(target) && (await barState()).visible.includes(target)))
    } finally {
      Menu.prototype.popup = realPopup
    }

    // Wide again: the surplus comes back to the bar when there is room.
    win.setSize(Math.max(originalSize[0] ?? 1200, 1400), 800)
    await waitFor(async () => (await barState()).visible.length > narrow.visible.length)
    const back = await barState()
    check('extensions2 O: widening the window gives icons back to the bar', back.visible.length > narrow.visible.length, JSON.stringify({ narrow: narrow.visible.length, back: back.visible.length }))

    // ================= user scripts =================
    console.log('[extensions2] user scripts')
    win.setSize(originalSize[0] ?? 1200, originalSize[1] ?? 800)
    const manager = userScripts()
    const added = manager.add(userScript('E2 Marker', `document.title = 'ran:' + document.title`))
    if (!added.ok) throw new Error(added.error)
    const markerId = added.id
    const load = async (path: string) => {
      browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
      const tab = store.get().tabs.at(-1)!
      opened.push(tab.id)
      return tab.id
    }
    const titleIn = (tabId: string, from: { store: { get(): { tabs: Array<{ id: string; title: string }> } } } = { store }) => from.store.get().tabs.find((t) => t.id === tabId)?.title ?? ''
    /**
     * The title of the page's own document once the scripts of the shell have had their turn: the shell sends them at dom-ready, and a script of
     * ours sent once the load has ended goes the same way after them, so it reads what they did. The witness of a script that must not run.
     */
    const ownTitle = async (url: string): Promise<string> => {
      const page = () => allWebContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL() === url)
      if (!(await waitFor(() => page()?.isLoading() === false, 10_000))) return `no page at ${url} that has finished loading`
      return String(await page()!.executeJavaScript('document.title'))
    }

    browser.dispatch({ type: 'settings/update', patch: { userScripts: false } })
    manager.setEnabled(markerId, true)
    const offTab = await load('/us/off')
    await waitFor(() => titleIn(offTab).startsWith('e2 /us/off') || titleIn(offTab).startsWith('ran:'), 8000)
    const offTitle = await ownTitle(`${base}/us/off`)
    check('extensions2 U: with the manager switched off a script that is on does not run', offTitle === 'e2 /us/off', offTitle)

    browser.dispatch({ type: 'settings/update', patch: { userScripts: true } })
    const onTab = await load('/us/on')
    check('extensions2 U: with the manager on, a script that is on runs in the page it names', await waitFor(() => titleIn(onTab) === 'ran:e2 /us/on', 8000), titleIn(onTab))

    manager.setEnabled(markerId, false)
    const offScript = await load('/us/script-off')
    await waitFor(() => titleIn(offScript).startsWith('e2 /us/script-off'), 8000)
    const offScriptTitle = await ownTitle(`${base}/us/script-off`)
    check('extensions2 U: a script that is switched off does not run', offScriptTitle === 'e2 /us/script-off', offScriptTitle)
    manager.setEnabled(markerId, true)

    const other = manager.add(userScript('E2 Excluding', `document.title = 'second:' + document.title`, '// @exclude http://127.0.0.1/*/skip*\n'))
    if (!other.ok) throw new Error(other.error)
    manager.setEnabled(other.id, true)
    const both = await load('/us/both')
    await waitFor(() => titleIn(both).includes('e2 /us/both'), 8000)
    check('extensions2 U: two scripts run in the order they were added, each in a function of its own', await waitFor(() => titleIn(both) === 'second:ran:e2 /us/both', 5000), titleIn(both))
    const skip = await load('/us/skip-this')
    await waitFor(() => titleIn(skip).includes('e2 /us/skip-this'), 8000)
    const skipTitle = await ownTitle(`${base}/us/skip-this`)
    check('extensions2 U: an @exclude keeps one script out of a page the other still runs in', skipTitle === 'ran:e2 /us/skip-this', skipTitle)
    manager.remove(other.id)

    // A page that is a sign-in page by its host name is never touched (login.app.localhost is the loopback address for Chromium).
    const sensitive = userScripts().add(userScript('E2 Everywhere', `document.title = 'EVERYWHERE:' + document.title`).replace('http://127.0.0.1/*', '<all_urls>'))
    if (!sensitive.ok) throw new Error(sensitive.error)
    manager.setEnabled(sensitive.id, true)
    browser.dispatch({ type: 'tab/open', url: `http://login.app.localhost:${port}/us/signin` })
    const signin = store.get().tabs.at(-1)!
    opened.push(signin.id)
    await waitFor(() => titleIn(signin.id).includes('e2 /us/signin'), 10_000)
    const signinTitle = await ownTitle(`http://login.app.localhost:${port}/us/signin`)
    check('extensions2 U: a script that asks for every site does not run on a sign-in host, whatever its patterns', signinTitle === 'e2 /us/signin', signinTitle)
    const plainHost = await load('/us/plain')
    check('extensions2 U: ...but runs on an ordinary one', await waitFor(() => titleIn(plainHost).includes('EVERYWHERE:'), 8000), titleIn(plainHost))
    manager.remove(sensitive.id)

    // A script the page cannot even parse is reported, and the page still loads.
    const broken = manager.add(userScript('E2 Broken', 'function ('))
    if (!broken.ok) throw new Error(broken.error)
    manager.setEnabled(broken.id, true)
    const logged: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    let brokenTab = ''
    try {
      brokenTab = await load('/us/broken')
      await waitFor(() => manager.list().find((s) => s.id === broken.id)?.lastError !== undefined, 8000)
    } finally {
      console.error = realError
    }
    check('extensions2 U: a script with a syntax error leaves the page alone, is logged with its name and shows its error in the list', titleIn(brokenTab).includes('e2 /us/broken') && logged.some((l) => l.includes('[userscripts]') && l.includes('E2 Broken')) && !!manager.list().find((s) => s.id === broken.id)?.lastError, JSON.stringify({ title: titleIn(brokenTab), logged: logged.slice(0, 2), error: manager.list().find((s) => s.id === broken.id)?.lastError }))
    manager.remove(broken.id)

    // A private window runs nothing unless the script was allowed there.
    const manager2 = getWindowManager()
    const priv = manager2.openPrivate()
    try {
      priv.browser.dispatch({ type: 'tab/open', url: `${base}/us/private-a` })
      const privA = priv.store.get().tabs.at(-1)!
      await waitFor(() => titleIn(privA.id, priv).includes('e2 /us/private-a'), 10_000)
      const privateTitle = await ownTitle(`${base}/us/private-a`)
      check('extensions2 U: a private window does not run a script that was not allowed there', privateTitle === 'e2 /us/private-a', privateTitle)
      manager.setAllowPrivate(markerId, true)
      priv.browser.dispatch({ type: 'tab/open', url: `${base}/us/private-b` })
      const privB = priv.store.get().tabs.at(-1)!
      check('extensions2 U: ...and runs one that was', await waitFor(() => titleIn(privB.id, priv) === 'ran:e2 /us/private-b', 10_000), titleIn(privB.id, priv))
    } finally {
      priv.win.close()
      await waitFor(() => manager2.privateWindows().length === 0)
      await manager2.settled()
      manager.setAllowPrivate(markerId, false)
    }

    // The interface asks through the preload: a script comes in switched off, and a private window could not add one.
    const viaUi = await evaluate<{ ok: boolean; scripts: Array<{ name: string; enabled: boolean }>; id?: string }>(`window.lucium.userScripts({ kind: 'add', text: ${JSON.stringify(userScript('E2 From UI', 'void 0'))} })`)
    check('extensions2 U: the interface adds a script through its preload, switched off', viaUi.ok && viaUi.scripts.some((s) => s.name === 'E2 From UI' && s.enabled === false), JSON.stringify(viaUi))
    const refusedUi = await evaluate<{ ok: boolean; message?: string }>(`window.lucium.userScripts({ kind: 'set-enabled', id: 'not an id', enabled: true })`)
    check('extensions2 U: a request that is not valid is refused', refusedUi.ok === false && /invalide/.test(refusedUi.message ?? ''), JSON.stringify(refusedUi))
    if (viaUi.id) manager.remove(viaUi.id)

    // The Settings (« Fonctions en option » › Pages web): the line of the manager is there, off, with no row of the scripts while it is off; switched on, the
    // row of the subpage « Scripts importés » follows its line, and the sheet of the subpage reads a pasted script.
    browser.dispatch({ type: 'settings/update', patch: { userScripts: false } })
    browser.openOverlay({ panel: 'settings', pane: 'features' })
    const settingsWin = async () => {
      await waitFor(() => ElectronWindow.getAllWindows().some((w) => w.getTitle() === 'Réglages' && !w.isDestroyed()), 8000)
      return ElectronWindow.getAllWindows().find((w) => w.getTitle() === 'Réglages')?.webContents
    }
    const panel = await settingsWin()
    if (panel) {
      const inPanel = <T>(code: string) => panel.executeJavaScript(code) as Promise<T>
      await waitFor(() => inPanel<boolean>(`!!document.querySelector('.settings-content .pref-feature[data-setting="userScripts"]')`), 8000)
      const offView = await inPanel<{ line: boolean; switchOn: boolean; group: boolean; rows: number; importButton: boolean; entry: boolean }>(`(() => {
        const line = document.querySelector('.settings-content .pref-feature[data-setting="userScripts"]')
        const group = [...document.querySelectorAll('.pref-section')].find((s) => s.querySelector('h3 .pref-title')?.textContent === 'Scripts utilisateur')
        return { line: !!line, switchOn: !!line?.querySelector('input[role=switch]')?.checked, group: !!group, rows: document.querySelectorAll('.us-script').length, importButton: [...document.querySelectorAll('.settings-content button')].some((b) => b.textContent.startsWith('Importer un fichier')), entry: !!document.querySelector('[data-subpage-entry="userscripts"]') }
      })()`)
      check('extensions2 U: Settings › Fonctions en option has the line of the manager, off, and with the manager off lists no script and offers no import', offView.line && !offView.switchOn && !offView.group && offView.rows === 0 && !offView.importButton && !offView.entry, JSON.stringify(offView))
      browser.dispatch({ type: 'settings/update', patch: { userScripts: true } })
      // With the manager on, its line has the row of the subpage « Scripts importés », which holds the scripts and the import.
      check('extensions2 U: with the manager on its line offers the subpage of the scripts', await waitFor(() => inPanel<boolean>(`(() => { const b = document.querySelector('[data-subpage-entry="userscripts"] button'); if (!b) return false; b.click(); return true })()`), 8000))
      await waitFor(() => inPanel<boolean>(`document.querySelector('#pane-heading')?.textContent === 'Scripts importés'`), 4000)
      // Other groups of the pane have buttons of the same words ("Coller des règles…", "Coller une Retouche"): everything is looked for inside the subpage.
      const group = `document.querySelector('[data-subpage="userscripts"]')`
      const press = (label: string, exact = false) => inPanel<boolean>(`(() => { const b = [...(${group})?.querySelectorAll('button') ?? []].find((b) => ${exact ? `b.textContent === ${JSON.stringify(label)}` : `b.textContent.startsWith(${JSON.stringify(label)})`}); if (!b) return false; b.click(); return true })()`)
      const hasButton = (label: string) => inPanel<boolean>(`[...(${group})?.querySelectorAll('button') ?? []].some((b) => b.textContent.startsWith(${JSON.stringify(label)}))`)
      check('extensions2 U: with the manager on its subpage offers to paste a script', await waitFor(() => hasButton('Coller'), 8000))
      await press('Coller')
      await waitFor(() => inPanel<boolean>(`!!document.querySelector('textarea.us-paste')`), 4000)
      const pasted = userScript('E2 Pasted', 'document.title = "pasted"')
      const typed = await inPanel<boolean>(`(() => { const ta = document.querySelector('textarea.us-paste'); if (!ta) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(pasted)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      // The panel has the text once its button to read the script is no longer greyed out.
      await waitFor(() => inPanel<boolean>(`[...(${group})?.querySelectorAll('button') ?? []].some((b) => b.textContent === 'Lire le script' && !b.disabled)`))
      check('extensions2 U: the paste field opens and takes the script', typed && (await press('Lire le script', true)))
      await waitFor(() => inPanel<boolean>(`!!document.querySelector('.us-review .us-code')`), 4000)
      const review = await inPanel<{ code: string; title: string; addDisabled: boolean }>(`(() => ({ code: document.querySelector('.us-review .us-code')?.textContent ?? '', title: document.querySelector('.us-review .us-title')?.textContent ?? '', addDisabled: [...document.querySelectorAll('.us-review button')].find((b) => b.textContent.startsWith('Ajouter'))?.disabled ?? true }))()`)
      check('extensions2 U: the sheet shows the whole code and the name of a pasted script before it is added', review.code === pasted && review.title.includes('E2 Pasted') && review.addDisabled === false, JSON.stringify(review).slice(0, 300))
      check('extensions2 U: the sheet has its "Ajouter" button', await inPanel<boolean>(`(() => { const b = [...document.querySelectorAll('.us-review button')].find((b) => b.textContent.startsWith('Ajouter')); if (!b) return false; b.click(); return true })()`))
      check('extensions2 U: adding it puts it in the list switched off', await waitFor(() => inPanel<boolean>(`[...document.querySelectorAll('.us-script')].some((row) => row.textContent.includes('E2 Pasted') && row.querySelector('input[role=switch]').checked === false)`), 6000))
      const pastedId = manager.list().find((s) => s.name === 'E2 Pasted')?.id
      if (pastedId) manager.remove(pastedId)
    } else {
      check('extensions2 U: the Settings window opens', false)
    }
    for (const w of ElectronWindow.getAllWindows()) if (w.getTitle() === 'Réglages') w.close()
    manager.remove(markerId)
  } finally {
    if (otherFavouriteId !== undefined) browser.dispatch({ type: 'favorite/remove', id: otherFavouriteId })
    for (const id of opened) browser.dispatch({ type: 'tab/close', id })
    for (const id of store.get().tabs.map((t) => t.id).filter((id) => !startTabs.has(id) && !opened.includes(id))) browser.dispatch({ type: 'tab/close', id })
    if (secondSpace) {
      browser.dispatch({ type: 'space/select', id: home })
      browser.dispatch({ type: 'space/delete', id: secondSpace })
    }
    if (store.get().spaces.some((s) => s.id === home)) browser.dispatch({ type: 'space/select', id: home })
    win.setSize(originalSize[0] ?? 1200, originalSize[1] ?? 800)
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: sleepAfter, extensionOverflow: originalSettings.extensionOverflow, unpinnedExtensions: originalSettings.unpinnedExtensions, extensionDataApis: originalSettings.extensionDataApis, userScripts: originalSettings.userScripts } })
    server.close()
    server.closeAllConnections()
  }
  return 'ran'
}

/** `LUCIUM_SMOKE_ONLY=extensions2`: only these checks, with their own report. */
export async function runExtensions2Smoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const outcome = await smokeExtensions2(ctx, recorderOf(checks))
    if (outcome === 'skipped') noteCheck(checks, 'smokeExtensions2 found its probes (LUCIUM_EXTENSIONS=$PWD/compat/data-api-probe:$PWD/compat/data-api-denied-probe)', false)
  } catch (error) {
    noteCheck(checks, 'smokeExtensions2 ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_EXTENSIONS2 ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
