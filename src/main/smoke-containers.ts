// Engine checks for the tab containers and the windows with tabs of their own, run inside a real Electron against a local server:
//  - containers: the function is off and costs nothing by default; each container has a session of its own (the server sees the cookie of the right
//    container, localStorage, IndexedDB and Cache Storage are apart), kept on disk; permissions are remembered per container and never reach the
//    profile; a rule sends a site to a container; a link opened from a container's page stays in it; a tab moved into a container (and out) gets a page
//    in the right session; a deleted container is erased for real (cookies, storage of every kind, HTTP cache, read back through a fresh window on the
//    same partition), its folder is swept at the next launch, a failed erasure is told and logged; a private window has no container and writes none;
//    switched off again, rules stop but tabs keep their identity.
//  - windows with tabs of their own: with the setting on, a window lists the pinned tabs and its own, its pages live in its own browser, closing it hands its tabs to the first
//    window, no key is written to the state file; off, every window lists every tab again.
// Called from the engine smoke test: `await smokeContainers(ctx, check)`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Menu, app, session, type MenuItem, type WebContents } from 'electron'
import { containerPartition } from '@shared/container-id'
import type { SidebarState } from '@shared/model'
import type { SmokeContext } from './smoke'
import { MAIN_WINDOW_ID, getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

function findMenuItem(label: string): MenuItem | undefined {
  const walk = (items: readonly MenuItem[]): MenuItem | undefined => {
    for (const item of items) {
      if (item.label === label) return item
      const inner = item.submenu ? walk(item.submenu.items) : undefined
      if (inner) return inner
    }
    return undefined
  }
  return walk(Menu.getApplicationMenu()?.items ?? [])
}

/** What a page of the server reads back of its own storage: the value of localStorage, and how many IndexedDB databases and Cache Storage caches it sees. */
/**
 * The name of the cookie this suite sets. The chain runs every suite in one process, so the profile's jar may hold cookies of earlier suites for the
 * same host (cookies ignore the port): the suite reads its own cookie by name and never compares a whole `Cookie` header.
 */
const COOKIE = 'ctn-sid'
const cookieValue = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1]

const READ_STORAGE = `(async () => JSON.stringify({ ls: localStorage.getItem('k'), idb: (await indexedDB.databases()).length, caches: (await caches.keys()).length }))()`

export async function smokeContainers(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine, history } = ctx
  const state = (): SidebarState => store.get()
  const settings = () => state().settings
  const patch = (changes: Partial<SidebarState['settings']>) => browser.dispatch({ type: 'settings/update', patch: changes })
  const saved = { ...settings() }
  const manager = getWindowManager()
  const mine: string[] = []
  const errors: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    realError(...args)
  }

  // ---- a local site, reached by two names (127.0.0.1 and localhost are two sites for cookies, storage and rules) ----
  const seen: Array<{ path: string; cookie: string | undefined }> = []
  let cacheHits = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push({ path: url.pathname, cookie: req.headers.cookie })
    res.setHeader('content-type', 'text/html; charset=utf-8')
    switch (url.pathname) {
      case '/set':
        res.setHeader('set-cookie', `${COOKIE}=${url.searchParams.get('v') ?? 'x'}; Path=/; Max-Age=3600`)
        return void res.end('<title>set</title><body>cookie set</body>')
      case '/store':
        return void res.end(`<title>storing</title><body><script>(async () => {
          localStorage.setItem('k', 'VALUE')
          await (await caches.open('smoke-cache')).put('/x', new Response('x'))
          await new Promise((resolve, reject) => { const r = indexedDB.open('smoke-db', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { r.result.close(); resolve() }; r.onerror = () => reject(r.error) })
          await (await fetch('/cache-data')).text()
          await (await fetch('/cache-data')).text()
          document.title = 'stored'
        })()</script></body>`)
      case '/read':
        return void res.end(`<title>read</title><body>read</body>`)
      case '/geo':
        return void res.end('<title>asking</title><body><script>navigator.geolocation.getCurrentPosition(() => { document.title = "geo:ok" }, (e) => { document.title = "geo:" + e.code })</script></body>')
      case '/cache-data':
        cacheHits++
        res.setHeader('content-type', 'text/plain')
        res.setHeader('cache-control', 'public, max-age=3600')
        return void res.end('cached')
      case '/link':
        return void res.end('<title>link</title><body><a id="l" target="_blank" href="/inherited" style="position:fixed;left:0;top:0;width:300px;height:120px;display:block;background:#ccc">go</a></body>')
      default:
        return void res.end(`<title>${url.pathname.slice(1) || 'home'}</title><body>page</body>`)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const ruled = `http://127.0.0.1:${port}`
  const plain = `http://localhost:${port}`
  const lastCookie = (path: string) => cookieValue([...seen].reverse().find((s) => s.path === path)?.cookie, COOKIE)
  const ownCookies = async () => (await engine.listCookies('default')).filter((c) => c.name === COOKIE)
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const titleOf = (id: string) => state().tabs.find((t) => t.id === id)?.title
  const containerOf = (id: string) => state().tabs.find((t) => t.id === id)?.container

  const open = async (url: string, options: { container?: string; title?: string } = {}): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url, ...(options.container ? { container: options.container } : {}) })
    const id = state().tabs.at(-1)!.id
    mine.push(id)
    await waitFor(() => (options.title ? titleOf(id) === options.title : true) && browser.snapshot().runtime.tabs[id]?.loading === false)
    return id
  }
  const evaluate = async (id: string, js: string): Promise<unknown> => browser.pageFor(id)?.evaluate(js)
  const idOf = (name: string): string => state().settings.containers.find((c) => c.name === name)!.id
  const cookiesOf = async (containerId: string) => session.fromPartition(containerPartition(containerId)).cookies.get({})
  const storageOf = async (containerId: string): Promise<string> => {
    // A fresh window on the container's partition reads what its storage holds now.
    const probe = new BrowserWindow({ show: false, webPreferences: { partition: containerPartition(containerId) } })
    try {
      await probe.loadURL(`${plain}/read`)
      return String(await probe.webContents.executeJavaScript(READ_STORAGE))
    } finally {
      probe.destroy()
    }
  }
  const partitions = join(app.getPath('userData'), 'Partitions')

  try {
    // ======================= containers =======================
    // ---- off by default, and nothing runs for it ----
    check('containers: off by default, with no container and no context of any container open', settings().tabContainers === false && settings().containers.length === 0 && engine.containerCount() === 0)
    check('containers: …the entry of File is hidden', findMenuItem('Nouvel onglet dans un conteneur')?.visible === false)
    browser.dispatch({ type: 'container/create', name: 'Refusé' })
    check('containers: …and a container cannot be created', settings().containers.length === 0)
    const refused = await open(`${plain}/whoami`)
    browser.dispatch({ type: 'tab/set-container', id: refused, container: 'whatever-1' })
    check('containers: …nor a tab put in one', containerOf(refused) === undefined && engine.containerCount() === 0)
    browser.dispatch({ type: 'tab/close', id: refused })

    // ---- two containers ----
    patch({ tabContainers: true })
    browser.dispatch({ type: 'container/create', name: 'Travail', color: 'orange' })
    browser.dispatch({ type: 'container/create', name: 'Perso', color: 'purple' })
    const work = idOf('Travail')
    const perso = idOf('Perso')
    check('containers: switched on, two containers exist with their colours and a storage-safe id', settings().containers.length === 2 && settings().containers[0]!.color === 'orange' && /^[a-z0-9-]+$/.test(work), JSON.stringify(settings().containers))
    const labels = (): string[] => findMenuItem('Nouvel onglet dans un conteneur')?.submenu?.items.map((i) => i.label) ?? []
    check('containers: the entry of File lists them, and nothing was opened for them yet', (await waitFor(() => findMenuItem('Nouvel onglet dans un conteneur')?.visible === true && labels().join() === 'Travail,Perso')) && engine.containerCount() === 0, labels().join())

    // ---- one jar for the profile, one for each container ----
    const profileSet = await open(`${plain}/set?v=profile`, { title: 'set' })
    const workSet = await open(`${plain}/set?v=work`, { container: work, title: 'set' })
    const persoSet = await open(`${plain}/set?v=perso`, { container: perso, title: 'set' })
    check('containers: tabs opened in a container carry it, the profile’s tab does not', containerOf(workSet) === work && containerOf(persoSet) === perso && containerOf(profileSet) === undefined)
    check('containers: a context is open for each container used, and for no other', engine.containerCount() === 2)
    const profileWho = await open(`${plain}/whoami`, { title: 'whoami' })
    check('cookies: the profile’s page sends the profile’s cookie only', lastCookie('/whoami') === 'profile', String(lastCookie('/whoami')))
    await open(`${plain}/whoami`, { container: work, title: 'whoami' })
    check('cookies: a page of the first container sends its own cookie, not the profile’s', lastCookie('/whoami') === 'work', String(lastCookie('/whoami')))
    await open(`${plain}/whoami`, { container: perso, title: 'whoami' })
    check('cookies: a page of the second container sends its own', lastCookie('/whoami') === 'perso', String(lastCookie('/whoami')))
    const workJar = await cookiesOf(work)
    check('cookies: the jar of a container holds its cookie and no other, and it is kept on disk (not a session cookie)', workJar.length === 1 && workJar[0]!.name === COOKIE && workJar[0]!.value === 'work' && workJar[0]!.session === false, JSON.stringify(workJar.map((c) => [c.name, c.value, c.session])))
    check('cookies: …the profile’s jar was not touched by the containers', (await ownCookies()).length === 1)
    check('disk: the container has a folder of its own under Partitions, and the engine lists it', (await waitFor(() => existsSync(join(partitions, `container-${work}`)))) && engine.storedContainerIds().includes(work), engine.storedContainerIds().join(','))

    // ---- storage of every kind ----
    const storing = await open(`${plain}/store`, { container: work, title: 'stored' })
    check('storage: a page of a container writes localStorage, IndexedDB and Cache Storage', titleOf(storing) === 'stored')
    const readIn = async (container: string | undefined) => {
      const id = await open(`${plain}/read`, { ...(container ? { container } : {}), title: 'read' })
      return String(await evaluate(id, READ_STORAGE))
    }
    const readWork = await readIn(work)
    const readPerso = await readIn(perso)
    const readProfile = await readIn(undefined)
    check('storage: the same container reads it back', readWork === '{"ls":"VALUE","idb":1,"caches":1}', readWork)
    check('storage: the other container sees none of it', readPerso === '{"ls":null,"idb":0,"caches":0}', readPerso)
    check('storage: nor does the profile', readProfile === '{"ls":null,"idb":0,"caches":0}', readProfile)
    check('cache: the HTTP cache of the container served the second request', cacheHits === 1, String(cacheHits))

    // ---- permissions ----
    const geoWork = await open(`${plain}/geo`, { container: work })
    check('permissions: a page of a container asks (the profile’s answers are not looked at)', await waitFor(() => browser.currentPanel() === 'permission'))
    const overlay = browser.currentOverlay()
    check('permissions: …and the question knows its container', overlay?.panel === 'permission' && overlay.request.container === work, JSON.stringify(overlay))
    if (overlay?.panel === 'permission') browser.answerPermission(overlay.request.id, false, true)
    check('permissions: a refusal that is remembered goes to the container and not to the profile', (await waitFor(() => settings().containers.find((c) => c.id === work)?.permissions?.[plain]?.geolocation === 'deny')) && state().sitePermissions[plain] === undefined, JSON.stringify(settings().containers[0]))
    check('permissions: …the page was told no', await waitFor(() => titleOf(geoWork) === 'geo:1'), String(titleOf(geoWork)))
    const geoAgain = await open(`${plain}/geo`, { container: work })
    check('permissions: another page of the container is not asked again, it is refused as remembered', (await waitFor(() => titleOf(geoAgain) === 'geo:1')) && browser.currentPanel() !== 'permission', String(titleOf(geoAgain)))
    const geoPerso = await open(`${plain}/geo`, { container: perso })
    check('permissions: the other container is asked', await waitFor(() => browser.currentPanel() === 'permission'))
    const second = browser.currentOverlay()
    if (second?.panel === 'permission') browser.answerPermission(second.request.id, false, false)
    await waitFor(() => titleOf(geoPerso) === 'geo:1')
    const geoProfile = await open(`${plain}/geo`)
    check('permissions: so is the profile', await waitFor(() => browser.currentPanel() === 'permission'))
    const third = browser.currentOverlay()
    check('permissions: …and its question has no container', third?.panel === 'permission' && third.request.container === undefined)
    if (third?.panel === 'permission') browser.answerPermission(third.request.id, false, false)
    await waitFor(() => titleOf(geoProfile) === 'geo:1')
    check('permissions: an answer not to be remembered is remembered nowhere', settings().containers.find((c) => c.id === perso)?.permissions === undefined && state().sitePermissions[plain] === undefined)

    // ---- history ----
    await open(`${plain}/only-in-container`, { container: work, title: 'only-in-container' })
    await open(`${plain}/only-in-profile`, { title: 'only-in-profile' })
    check('history: a page of the profile reaches its history', await waitFor(() => history.of('default').search('only-in-profile').length > 0))
    check('history: a page of a container leaves no trace in it', history.of('default').search('only-in-container').length === 0)

    // ---- a link opened from a container's page stays in it ----
    const linkTab = await open(`${plain}/link`, { container: work, title: 'link' })
    const before = state().tabs.length
    const page = wcOf(linkTab)!
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) page.sendInputEvent({ type, x: 40, y: 40, button: 'left', clickCount: 1 })
    check('link: a link opened from a container’s page opens in the same container', (await waitFor(() => state().tabs.length === before + 1 && state().tabs.at(-1)?.url.endsWith('/inherited') === true)) && containerOf(state().tabs.at(-1)!.id) === work, JSON.stringify(state().tabs.at(-1)))
    mine.push(state().tabs.at(-1)!.id)

    // ---- a tab moved into a container, and out ----
    const moving = await open(`${plain}/whoami?m=1`, { title: 'whoami' })
    const firstPage = browser.pageFor(moving)
    browser.dispatch({ type: 'tab/set-container', id: moving, container: work })
    check('move: a tab put in a container gets a new page, which loads again with the container’s cookie', (await waitFor(() => lastCookie('/whoami') === 'work' && browser.pageFor(moving) !== firstPage)) && containerOf(moving) === work, String(lastCookie('/whoami')))
    browser.dispatch({ type: 'tab/set-container', id: moving, container: null })
    check('move: taken out, it loads again with the profile’s', (await waitFor(() => lastCookie('/whoami') === 'profile')) && containerOf(moving) === undefined, String(lastCookie('/whoami')))

    // ---- the rule of a site ----
    browser.dispatch({ type: 'container/rule', host: '127.0.0.1', container: perso })
    const ruledTab = await open(`${ruled}/whoami`, { title: 'whoami' })
    check('rule: a site with a rule opens in its container, whoever opens it', containerOf(ruledTab) === perso)
    const notRuled = await open(`${plain}/whoami?r=1`, { title: 'whoami' })
    check('rule: …and another site does not', containerOf(notRuled) === undefined)
    const forced = await open(`${ruled}/whoami?f=1`, { container: work, title: 'whoami' })
    check('rule: a container asked for wins over the rule', containerOf(forced) === work)

    // ---- the colour, the names ----
    browser.dispatch({ type: 'container/update', id: perso, patch: { name: 'Maison', color: 'green' } })
    check('rename: a container can be renamed and recoloured, its id and its tabs unchanged', settings().containers.find((c) => c.id === perso)?.name === 'Maison' && settings().containers.find((c) => c.id === perso)?.color === 'green' && containerOf(persoSet) === perso)
    browser.dispatch({ type: 'container/update', id: perso, patch: { name: 'Travail' } })
    check('rename: a name another container has is refused', settings().containers.find((c) => c.id === perso)?.name === 'Maison')

    // ---- the state file keeps the identity of a tab ----
    store.flush()
    const file = readFileSync(join(app.getPath('userData'), 'state.json'), 'utf8')
    check('state: the file keeps the containers, their rules and the container of each tab', file.includes(`"container":"${work}"`) && file.includes('"containerRules"') && file.includes('Maison'))

    // ---- a private window ----
    const priv = manager.openPrivate({ commandBar: false })
    priv.browser.dispatch({ type: 'container/create', name: 'Depuis le privé' })
    priv.browser.dispatch({ type: 'container/delete', id: work })
    // No wait after them: a dispatch is applied, or refused, before it returns.
    priv.browser.dispatch({ type: 'tab/open', url: `${plain}/whoami`, container: work })
    check('private: a private window has no container, creates none and deletes none', priv.store.get().settings.containers.length === 0 && settings().containers.length === 2 && priv.store.get().settings.tabContainers === false)
    check('private: …a tab opened there with a container is an ordinary private tab', priv.store.get().tabs.length === 1 && priv.store.get().tabs[0]!.container === undefined)
    check('private: …and nothing was opened or written for a container', engine.containerCount() === 2 && !engine.storedContainerIds().includes('depuis-le-prive'))
    priv.win.close()
    await waitFor(() => priv.win.isDestroyed())

    // ---- the engine test asks to forget a container whose erasure fails: told and logged ----
    const failing = engine as unknown as { eraseContainer: (id: string, name: string) => Promise<void> }
    const realErase = failing.eraseContainer.bind(engine)
    failing.eraseContainer = () => Promise.reject(new Error('Impossible d’effacer le cache du conteneur « Maison ».'))
    errors.length = 0
    browser.dispatch({ type: 'container/delete', id: perso })
    check('erase: when the data cannot be erased the user is told which container kept what', await waitFor(() => browser.snapshot().toast?.message === 'Impossible d’effacer le cache du conteneur « Maison ».'), JSON.stringify(browser.snapshot().toast))
    check('erase: …and the log names the container', errors.some((e) => e.includes('[containers]') && e.includes(perso)), JSON.stringify(errors.slice(0, 2)))
    failing.eraseContainer = realErase
    await realErase(perso, 'Maison')

    // ---- deleting a container erases it for real ----
    const workTabs = state().tabs.filter((t) => t.container === work).length
    const readBefore = await readIn(work)
    check('delete: the container has tabs open and data of every kind', workTabs >= 3 && readBefore === '{"ls":"VALUE","idb":1,"caches":1}' && (await cookiesOf(work)).length === 1, `${workTabs} ${readBefore}`)
    const hitsBefore = cacheHits
    browser.dispatch({ type: 'tab/archive', id: storing })
    browser.dispatch({ type: 'container/delete', id: work })
    await browser.containersSettled()
    check('delete: the container, its rules and its tabs are gone from the state, and the archive keeps none of its pages', !settings().containers.some((c) => c.id === work) && !settings().containerRules.some((r) => r.containerId === work) && state().tabs.every((t) => t.container !== work) && state().archive.every((a) => a.container !== work), JSON.stringify(settings().containers))
    check('delete: no page of the container is alive any more, and its context is closed', browser.livePageIds().every((id) => containerOf(id) !== work) && engine.containerCount() === 0, String(engine.containerCount()))
    check('delete: the user is told it is erased', browser.snapshot().toast?.message?.includes('supprimé') === true, JSON.stringify(browser.snapshot().toast))
    check('delete: its cookies are gone', (await cookiesOf(work)).length === 0)
    const storageAfter = await storageOf(work)
    check('delete: its localStorage, IndexedDB and Cache Storage are gone (read through a fresh window on the same partition)', storageAfter === '{"ls":null,"idb":0,"caches":0}', storageAfter)
    const probe = new BrowserWindow({ show: false, webPreferences: { partition: containerPartition(work) } })
    try {
      await probe.loadURL(`${plain}/read`)
      await probe.webContents.executeJavaScript(`fetch('/cache-data').then((r) => r.text())`)
    } finally {
      probe.destroy()
    }
    check('delete: its HTTP cache is gone (the same address is asked of the server again)', cacheHits === hitsBefore + 1, `${cacheHits} / ${hitsBefore}`)
    check('delete: the profile and the other tabs were not touched', (await ownCookies()).length === 1 && containerOf(profileWho) === undefined)

    // ---- the folder of a deleted container is swept at the next launch ----
    const ghost = 'fantome-00000'
    mkdirSync(join(partitions, `container-${ghost}`), { recursive: true })
    writeFileSync(join(partitions, `container-${ghost}`, 'Cookies'), 'x')
    // `true`: the state of this run is the one the store holds (the launch passes whether it read state.json).
    check('sweep: when the state was not read at this launch nothing is removed', browser.sweepStoredContainers(false).length === 0 && existsSync(join(partitions, `container-${ghost}`)))
    const swept = browser.sweepStoredContainers(true)
    check('sweep: the folder of a container the list does not name is removed at launch, and the others are not', swept.includes(ghost) && !existsSync(join(partitions, `container-${ghost}`)), JSON.stringify(swept))
    patch({ tabContainers: false })
    mkdirSync(join(partitions, `container-${ghost}`), { recursive: true })
    check('sweep: with the function off nothing is looked at', browser.sweepStoredContainers(true).length === 0 && existsSync(join(partitions, `container-${ghost}`)))
    patch({ tabContainers: true })
    browser.sweepStoredContainers(true)
    check('sweep: …and it is removed once the function is on', !existsSync(join(partitions, `container-${ghost}`)))

    // ---- a folder kept for a copy of the state goes thirty days after the last write in it ----
    const keptYoung = 'garde-11111'
    const keptOld = 'garde-22222'
    const longAgo = new Date(Date.now() - 40 * 24 * 3_600_000)
    for (const id of [keptYoung, keptOld]) {
      mkdirSync(join(partitions, `container-${id}`, 'Network'), { recursive: true })
      writeFileSync(join(partitions, `container-${id}`, 'Network', 'Cookies'), 'x')
    }
    for (const path of [join(partitions, `container-${keptOld}`, 'Network', 'Cookies'), join(partitions, `container-${keptOld}`, 'Network'), join(partitions, `container-${keptOld}`)]) utimesSync(path, longAgo, longAgo)
    const idleOld = engine.storedContainerIdleMs(keptOld)
    check('sweep: the engine tells how long ago the folder of a stored container was written', idleOld !== null && idleOld >= 39 * 24 * 3_600_000 && (engine.storedContainerIdleMs(keptYoung) ?? Infinity) < 3_600_000, String(idleOld))
    const sweptByAge = browser.sweepStoredContainers(true, () => new Set([keptYoung, keptOld]))
    check('sweep: a folder a copy of the state names goes after thirty days without a write, a recent one stays', sweptByAge.includes(keptOld) && !existsSync(join(partitions, `container-${keptOld}`)) && existsSync(join(partitions, `container-${keptYoung}`)), JSON.stringify(sweptByAge))
    browser.sweepStoredContainers(true)
    check('sweep: …and the recent one goes once no copy names it', !existsSync(join(partitions, `container-${keptYoung}`)))

    // ---- switched off again: rules stop, identities stay ----
    browser.dispatch({ type: 'container/create', name: 'Dernier' })
    const last = idOf('Dernier')
    browser.dispatch({ type: 'container/rule', host: '127.0.0.1', container: last })
    const stays = await open(`${ruled}/whoami?s=1`, { title: 'whoami' })
    patch({ tabContainers: false })
    const afterOff = await open(`${ruled}/whoami?s=2`, { title: 'whoami' })
    check('off again: a rule is no longer applied to a new tab', containerOf(stays) === last && containerOf(afterOff) === undefined)
    check('off again: the tab already in a container stays in it', containerOf(stays) === last && (await evaluate(stays, 'location.search')) === '?s=1')
    check('off again: the entry of File and the command bar offer nothing', (await waitFor(() => findMenuItem('Nouvel onglet dans un conteneur')?.visible === false)))
    browser.dispatch({ type: 'container/delete', id: last })
    await browser.containersSettled()
    check('off again: a container can still be deleted, with its data', !settings().containers.some((c) => c.id === last) && (await cookiesOf(last)).length === 0)

    // ======================= windows with tabs of their own =======================
    patch({ independentWindows: false })
    const pinned = await open(`${plain}/pinned`, { title: 'pinned' })
    const sharedTab = await open(`${plain}/shared`, { title: 'shared' })
    const win2 = manager.openWindow({ commandBar: false })
    await waitFor(() => !win2.win.webContents.isLoading())
    check('windows: by default a second window lists the same tabs as the first', win2.store.get().tabs.some((t) => t.id === sharedTab) && state().tabs.some((t) => t.id === sharedTab))
    patch({ independentWindows: true })
    browser.dispatch({ type: 'tab/pin', id: pinned })
    check('windows: with the setting on, the second window lists the pinned tabs and none of the first window’s others', await waitFor(() => win2.store.get().tabs.some((t) => t.id === pinned) && !win2.store.get().tabs.some((t) => t.id === sharedTab)), JSON.stringify(win2.store.get().tabs.map((t) => t.url)))
    win2.browser.dispatch({ type: 'tab/open', url: `${plain}/second-one` })
    const own = win2.store.get().tabs.at(-1)!.id
    await waitFor(() => win2.browser.ownsPage(own))
    check('windows: a tab opened there is listed by it alone', win2.store.get().tabs.some((t) => t.id === own) && !state().tabs.some((t) => t.id === own) && manager.list().find((r) => r.id === MAIN_WINDOW_ID)!.store.get().tabs.every((t) => t.id !== own))
    check('windows: …and its page lives in that window’s browser, not in the first one’s', win2.browser.ownsPage(own) && !browser.ownsPage(own))
    check('windows: …while the first window keeps its own tabs', state().tabs.some((t) => t.id === sharedTab))
    store.flush()
    check('windows: the state file holds every tab and no key of a window', !readFileSync(join(app.getPath('userData'), 'state.json'), 'utf8').includes('windowKey') && readFileSync(join(app.getPath('userData'), 'state.json'), 'utf8').includes('second-one'))
    win2.win.close()
    check('windows: closing the window hands its tabs to the first one', (await waitFor(() => win2.win.isDestroyed())) && (await waitFor(() => state().tabs.some((t) => t.id === own))))
    patch({ independentWindows: false })
    check('windows: switched off again, the first window still lists every tab', state().tabs.some((t) => t.id === own) && state().tabs.some((t) => t.id === sharedTab))
  } finally {
    console.error = realError
    // Put everything back: the tabs opened here, the containers, the settings.
    for (const id of mine) browser.dispatch({ type: 'tab/close', id })
    for (const container of [...settings().containers]) {
      browser.dispatch({ type: 'container/delete', id: container.id })
    }
    await browser.containersSettled()
    for (const record of manager.list()) if (record.id !== MAIN_WINDOW_ID && !record.win.isDestroyed()) record.win.close()
    await sleep(300)
    patch({ tabContainers: saved.tabContainers, containers: saved.containers, containerRules: saved.containerRules, independentWindows: saved.independentWindows })
    // The cookie set in the profile stays in the one jar the next suites share: it goes.
    const left = await ownCookies()
    if (left.length > 0) await engine.removeCookies('default', left)
    server.close()
  }
}

/** `LUCIUM_SMOKE_ONLY=containers`: only these checks, with their own report. */
export async function runContainersSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeContainers(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeContainers ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_CONTAINERS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
