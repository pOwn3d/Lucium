// Engine checks for the visit history of each profile, run inside a real Electron. A local server answers on several host names; two
// spaces of two profiles (and a third that shares the second profile) visit pages of it, in real tabs. Then: where each page was
// recorded (memory and files), what the history panel, the command bar (rows and inline completion), the interface's own IPC calls,
// "Effacer les données du site" and the menu's history entries show in each space, what erasing a profile, cleaning the unused profiles
// and a private window do. Called from the engine smoke test: `await smokeHistory(ctx, check)`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app, Menu, webContents as allWebContents, type MenuItem } from 'electron'
import type { HistoryEntry } from '@shared/model'
import { activeProfileId, profileLabel } from '@shared/profiles'
import type { SmokeContext } from './smoke'
import { HistoryBook, historyFileName } from './history'
import { mergeImportedHistory } from './importers/history-target'
import { getImportService, ImportService, setImportService } from './importers/service'
import { getWindowManager } from './shell/windows'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

/** The menu item with this label, anywhere in the application menu. */
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

export async function smokeHistory(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, history, win } = ctx
  const ui = ctx.overlayView.webContents
  const manager = getWindowManager()
  const userData = app.getPath('userData')
  const originalSpace = store.get().activeSpaceId
  const originalSuggestions = store.get().settings.searchSuggestions
  // What is typed in the command bar stays between the user and the bar: no request to a search engine.
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: false } })

  // The pages carry their name in the title and the query; their host tells the sites apart (the same server answers all of them).
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    // A page whose frame loads again and again (an advertisement that refreshes), and a page that names itself after its load.
    if (url.pathname === '/frames') return void res.end(`<title>hist frames</title><iframe id="f" src="/p?id=frame-0"></iframe><script>let i = 0; setInterval(() => { document.getElementById('f').src = '/p?id=frame-' + ++i }, 400)</script>`)
    // It names itself when the check says so, once its visit is recorded: a timer of its own could fire before the load ends on a loaded machine.
    if (url.pathname === '/late') return void res.end(`<title>hist late-initial</title><body>late</body>`)
    res.end(`<title>hist ${url.searchParams.get('id') ?? url.pathname}</title><body>history probe</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const ALPHA = `alpha.localhost:${port}`
  const BETA = `beta.localhost:${port}`
  const SHARED = `shared.localhost:${port}`
  const pageUrl = (host: string, id: string) => `http://${host}/p?id=${id}`

  const mine = new Set<string>()
  const createdSpaces: string[] = []
  const urlsOf = (profile: string): string[] => history.of(profile).search('', 100_000).map((entry) => entry.url)
  const entryOf = (profile: string, url: string): HistoryEntry | undefined => history.of(profile).search('', 100_000).find((entry) => entry.url === url)
  const has = (profile: string, ...urls: string[]) => urls.every((url) => urlsOf(profile).includes(url))
  const hasNone = (profile: string, ...urls: string[]) => urls.every((url) => !urlsOf(profile).includes(url))
  const filesOf = (profile: string): string | null => {
    const path = join(userData, historyFileName(profile))
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  const tabOf = (id: string) => store.get().tabs.find((tab) => tab.id === id)
  /** The web contents of the page of a tab, when it has one. */
  const pageOf = (id: string): Electron.WebContents | undefined => {
    const number = ctx.engine.tabNumberOf(id)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  /** Opens a page in a space and waits until it has loaded (its title is the name of the probe). */
  const visit = async (spaceId: string, url: string): Promise<string> => {
    browser.dispatch({ type: 'space/select', id: spaceId })
    browser.dispatch({ type: 'tab/open', url })
    const id = store.get().tabs.at(-1)!.id
    mine.add(id)
    await waitFor(() => (tabOf(id)?.title ?? '').startsWith('hist ') && browser.snapshot().runtime.tabs[id]?.loading === false)
    return id
  }
  const closeTabs = () => {
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    mine.clear()
  }
  const exec = <T>(contents: Electron.WebContents, js: string): Promise<T> => contents.executeJavaScript(js) as Promise<T>

  // ---- the panel and the bar, read from the overlay page ----
  const panelRows = () => exec<string[]>(ui, `[...document.querySelectorAll('.hist-pages .lp-title')].map((el) => el.textContent ?? '')`)
  const panelText = () => exec<string>(ui, `document.querySelector('.hist-panel')?.textContent ?? ''`)
  const ownerLine = () => exec<string>(ui, `document.querySelector('.hist-panel .tk-status')?.textContent ?? ''`)
  const typeInto = async (text: string): Promise<void> => {
    for (const ch of text) {
      ui.sendInputEvent({ type: 'keyDown', keyCode: ch === ' ' ? 'Space' : ch })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode: ch === ' ' ? 'Space' : ch })
      await sleep(40)
    }
    await sleep(400)
  }
  const searchValue = () => exec<string>(ui, `document.querySelector('.hist-panel input[type=search]')?.value ?? ''`)
  /** Whether the panel has drawn the answer of the history: until it comes, the panel says it is loading (`aria-busy`), with no row and no owner line. */
  const panelReady = () => exec<boolean>(ui, `(() => { const panel = document.querySelector('.hist-panel'); return !!panel && panel.getAttribute('aria-busy') !== 'true' })()`).catch(() => false)
  const openPanel = async (): Promise<void> => {
    browser.closeOverlay()
    browser.openOverlay({ panel: 'history' })
    await waitFor(() => exec<boolean>(ui, `document.activeElement === document.querySelector('.hist-panel input[type=search]')`).catch(() => false))
    await waitFor(panelReady)
  }
  /** The rows of the panel once they are the ones `wanted` describes (the list and each search are answered after a moment), or as they are when the wait ends. */
  const rowsWhen = async (wanted: (rows: string[]) => boolean): Promise<string[]> => {
    let rows: string[] = []
    await waitFor(async () => wanted((rows = await panelRows())))
    return rows
  }
  /** The search typed in the panel has been answered, and found nothing: no row, and the panel says so (not a list still loading). */
  const foundNothing = async (): Promise<boolean> => (await panelRows()).length === 0 && (await panelText()).includes('Aucun résultat')
  const fieldFocused = () => exec<boolean>(ui, `document.activeElement === document.querySelector('.palette-input')`).catch(() => false)
  const openBar = async (text: string): Promise<void> => {
    browser.closeOverlay()
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      if (await waitFor(fieldFocused, 3000)) break
    }
    await sleep(200)
    await typeInto(text)
  }
  const barRows = () =>
    exec<Array<{ label: string; detail: string }>>(
      ui,
      `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', detail: li.querySelector('.detail')?.textContent ?? '' }))`
    )
  const barHistory = async () => (await barRows()).filter((row) => row.detail.includes('Historique'))
  const barValue = () => exec<string>(ui, `document.querySelector('.palette-input')?.value ?? ''`)
  /** What the interface's own IPC answers: the way a page of the interface could ever ask for a history. */
  const askHistory = (query: string) => exec<HistoryEntry[]>(win.webContents, `window.lucium.searchHistory(${JSON.stringify(query)})`)

  try {
    // ---- two profiles, three spaces: home and its twin share a profile, the Pro space has another ----
    const home = originalSpace
    const homeProfile = activeProfileId(store.get())
    browser.dispatch({ type: 'space/create', name: 'Historique pro', emoji: '💼', hue: 200, profileName: 'Smoke pro' })
    const pro = store.get().activeSpaceId
    createdSpaces.push(pro)
    const proProfile = store.get().spaces.find((space) => space.id === pro)!.profileId
    browser.dispatch({ type: 'space/create', name: 'Historique pro bis', emoji: '📎', hue: 90, profileId: proProfile })
    const proTwin = store.get().activeSpaceId
    createdSpaces.push(proTwin)
    browser.dispatch({ type: 'space/create', name: 'Historique perso bis', emoji: '🏠', hue: 30, profileId: homeProfile })
    const homeTwin = store.get().activeSpaceId
    createdSpaces.push(homeTwin)
    check('history: two profiles, with a second space on each', homeProfile !== proProfile && store.get().spaces.find((s) => s.id === proTwin)?.profileId === proProfile && store.get().spaces.find((s) => s.id === homeTwin)?.profileId === homeProfile, `${homeProfile} / ${proProfile}`)
    // The suites of the chain share one process: a tab or a visit they left behind (an unknown host, a probe page) would take part
    // in the fuzzy matching below ("beta" finds "lucium-inexistant.invalid") and outrank the pages this suite checks.
    for (const tab of [...store.get().tabs]) if (!tab.pinned) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.eraseHistory(homeProfile)

    // ---- the pages go to the history of the profile of their space ----
    const alpha1 = pageUrl(ALPHA, 'alpha-1')
    const alpha2 = pageUrl(ALPHA, 'alpha-2')
    const beta1 = pageUrl(BETA, 'beta-1')
    const beta2 = pageUrl(BETA, 'beta-2')
    const shared = pageUrl(SHARED, 'shared')
    await visit(home, alpha1)
    await visit(home, alpha2)
    await visit(home, shared)
    const proShared = await visit(pro, shared)
    await visit(pro, beta1)
    await visit(pro, beta2)
    browser.dispatch({ type: 'tab/select', id: proShared })
    for (let i = 0; i < 2; i++) {
      const loadsBefore = entryOf(proProfile, shared)?.visitCount ?? 0
      browser.nav('reload')
      await waitFor(() => (entryOf(proProfile, shared)?.visitCount ?? 0) > loadsBefore)
    }
    check('history: a page lands in the history of the profile of its space, and in no other', has(homeProfile, alpha1, alpha2, shared) && hasNone(homeProfile, beta1, beta2) && has(proProfile, beta1, beta2, shared) && hasNone(proProfile, alpha1, alpha2), JSON.stringify({ [homeProfile]: urlsOf(homeProfile).length, [proProfile]: urlsOf(proProfile).length }))
    check('history: the same page visited in both profiles is counted in each one apart', (entryOf(proProfile, shared)?.visitCount ?? 0) > (entryOf(homeProfile, shared)?.visitCount ?? 99), `${entryOf(homeProfile, shared)?.visitCount} / ${entryOf(proProfile, shared)?.visitCount}`)

    // A page loaded while another space is shown belongs to the profile of its own space ("Actualiser tous les onglets" reloads the
    // tabs of every space, whichever is on screen).
    const backgroundUrl = pageUrl(BETA, 'beta-background')
    await visit(pro, backgroundUrl)
    const loadsBefore = entryOf(proProfile, backgroundUrl)?.visitCount ?? 0
    browser.dispatch({ type: 'space/select', id: home })
    await browser.reloadAllTabs(0)
    check(
      'history: a tab reloaded while another space is shown is recorded for the profile of its own space',
      (await waitFor(() => (entryOf(proProfile, backgroundUrl)?.visitCount ?? 0) > loadsBefore, 8000)) && hasNone(homeProfile, backgroundUrl) && store.get().activeSpaceId === home,
      `${loadsBefore} -> ${entryOf(proProfile, backgroundUrl)?.visitCount}`
    )

    // ---- what is not a visit, and the title a page ends with ----
    const framesUrl = `http://${ALPHA}/frames`
    const framesTab = await visit(home, framesUrl)
    // The witness: three loads of the frame ending, heard by a listener of the page added after the engine's, which tells the shell of each end
    // of loading, and whether it is a visit, as it hears it (the shell records a visit in that same step).
    const framesPage = pageOf(framesTab)
    let frameLoads = 0
    const onFrameLoad = (): void => void frameLoads++
    framesPage?.on('did-stop-loading', onFrameLoad)
    const reloaded = await waitFor(() => frameLoads >= 3)
    framesPage?.off('did-stop-loading', onFrameLoad)
    check('history: a frame that loads again and again inside a page does not visit it again', reloaded && entryOf(homeProfile, framesUrl)?.visitCount === 1, `${entryOf(homeProfile, framesUrl)?.visitCount} visit(s) after ${frameLoads} load(s) of the frame`)
    browser.dispatch({ type: 'tab/close', id: framesTab })
    const lateUrl = `http://${ALPHA}/late`
    const lateTab = await visit(home, lateUrl)
    // The load has ended and is recorded under the first title; then the page names itself, as a script of a single-page site does.
    const recordedFirst = await waitFor(() => entryOf(homeProfile, lateUrl)?.title === 'hist late-initial')
    const latePage = pageOf(lateTab)
    // What went wrong, if the page could not be renamed, is said in the detail of the check.
    const renamed: true | string = latePage === undefined ? 'no page for the tab' : await exec<boolean>(latePage, `(document.title = 'hist late-final') === 'hist late-final'`).then((done) => done || 'the title did not change', (error: unknown) => `the page could not be renamed: ${String(error)}`)
    const retitled = await waitFor(() => entryOf(homeProfile, lateUrl)?.title === 'hist late-final')
    check('history: a page that names itself after its load has that name in the history, and is not counted twice for it', recordedFirst && renamed === true && retitled && entryOf(homeProfile, lateUrl)?.visitCount === 1, `${JSON.stringify({ recordedFirst, renamed })} ${entryOf(homeProfile, lateUrl)?.title} / ${entryOf(homeProfile, lateUrl)?.visitCount}`)
    // An address nobody answers at (a port that was just closed): the page of the error is not a page that was visited.
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/dead`
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    browser.dispatch({ type: 'space/select', id: home })
    browser.dispatch({ type: 'tab/open', url: deadUrl })
    const deadTab = store.get().tabs.at(-1)!.id
    mine.add(deadTab)
    // No wait after it: the shell decides whether a load was a visit at the end of that load (browser-pages.ts, `handlePageUpdate`), the step that
    // also tells the runtime the load has ended.
    await waitFor(() => browser.snapshot().runtime.tabs[deadTab]?.loading === false && tabOf(deadTab)?.url === deadUrl)
    check('history: an address that does not answer is not recorded', entryOf(homeProfile, deadUrl) === undefined, entryOf(homeProfile, deadUrl)?.title)
    // The pages of this block leave the history as it was for the checks that follow.
    browser.dispatch({ type: 'tab/close', id: deadTab })
    for (const url of [framesUrl, lateUrl]) history.of(homeProfile).remove(url)

    // ---- the files: one per profile, history.json being the first profile's as ever ----
    check('history: the book writes what changed', history.flush())
    const homeFile = filesOf(homeProfile)
    const proFile = filesOf(proProfile)
    check('history: each profile has a file of its own, with its pages only', homeFile !== null && proFile !== null && homeFile.includes('alpha-1') && !homeFile.includes('beta-1') && proFile.includes('beta-1') && !proFile.includes('alpha-1'), `${historyFileName(homeProfile)} / ${historyFileName(proProfile)}`)
    check('history: the default profile keeps history.json, a plain array of pages', historyFileName('default') === 'history.json' && (homeProfile !== 'default' || (Array.isArray(JSON.parse(homeFile ?? 'null')) && !!(JSON.parse(homeFile ?? '[]') as HistoryEntry[])[0]?.url)))
    const restarted = new HistoryBook(userData)
    check('history: a start from the files finds each profile’s pages again', restarted.of(homeProfile).size() === history.of(homeProfile).size() && restarted.of(proProfile).size() === history.of(proProfile).size() && restarted.of(proProfile).search('', 100_000).every((e) => history.of(proProfile).search('', 100_000).some((x) => x.url === e.url)))

    // ---- the panel of each space ----
    closeTabs()
    browser.dispatch({ type: 'space/select', id: home })
    await openPanel()
    const homeList = (rows: string[]) => rows.some((r) => r.includes('alpha-1')) && rows.some((r) => r.includes('alpha-2')) && rows.some((r) => r.includes('shared')) && !rows.some((r) => r.includes('beta'))
    const homeRows = await rowsWhen(homeList)
    check('history: the panel of a space of the first profile lists its pages and none of the second profile', homeList(homeRows), JSON.stringify(homeRows))
    const homeOwner = frenchSpaces(`Profil « ${profileLabel(store.get().settings, homeProfile)} »`)
    check('history: with several profiles the panel says whose history it is', await waitFor(async () => (await ownerLine()) === homeOwner), await ownerLine())
    await typeInto('beta')
    check('history: searching the panel for a page of the other profile finds nothing', await waitFor(foundNothing), `${await searchValue()}: ${await panelText()}`)
    browser.closeOverlay()

    browser.dispatch({ type: 'space/select', id: pro })
    await openPanel()
    const proList = (rows: string[]) => rows.some((r) => r.includes('beta-1')) && rows.some((r) => r.includes('beta-2')) && rows.some((r) => r.includes('shared')) && !rows.some((r) => r.includes('alpha'))
    const proRows = await rowsWhen(proList)
    check('history: the panel of the other profile lists its own pages and none of the first', proList(proRows), JSON.stringify(proRows))
    check('history: …and names its profile', await waitFor(async () => (await ownerLine()) === frenchSpaces('Profil « Smoke pro »')), await ownerLine())
    // Matching is fuzzy: a name that nothing of this profile can spell out.
    await typeInto('alpha-1')
    check('history: …where a page of the first profile cannot be found', await waitFor(foundNothing), `${await searchValue()}: ${JSON.stringify(await panelRows())}`)
    browser.closeOverlay()

    browser.dispatch({ type: 'space/select', id: proTwin })
    await openPanel()
    const twinList = (rows: string[]) => rows.some((r) => r.includes('beta-1')) && rows.some((r) => r.includes('shared')) && !rows.some((r) => r.includes('alpha'))
    const twinRows = await rowsWhen(twinList)
    check('history: a second space of the same profile shows the same history', twinList(twinRows), JSON.stringify(twinRows))
    // "Oublier" in that panel forgets the page for the profile (so for both of its spaces), and for it alone, once the six seconds to take it back have passed.
    await typeInto('beta-2')
    await exec(ui, `[...document.querySelectorAll('.hist-pages li')].find((li) => (li.textContent ?? '').includes('beta-2'))?.querySelector('.lp-actions .tk-btn')?.click()`)
    check('history: “Oublier” forgets a page for the profile only', await waitFor(() => hasNone(proProfile, beta2)) && has(proProfile, beta1), JSON.stringify(urlsOf(proProfile)))
    browser.closeOverlay()
    browser.dispatch({ type: 'space/select', id: homeTwin })
    check('history: …the same address visited in the first profile would have been kept (the other profile’s “Oublier” does not reach it)', has(homeProfile, alpha1, alpha2, shared))

    // ---- the command bar of each space ----
    browser.dispatch({ type: 'space/select', id: home })
    await openBar('alpha')
    const homeBar = await barHistory()
    check('history: the command bar of the first profile suggests its pages', homeBar.some((r) => r.label.includes('alpha-1')) && homeBar.some((r) => r.label.includes('alpha-2')), JSON.stringify(homeBar))
    browser.closeOverlay()
    await openBar('beta-1')
    check('history: …and nothing visited in the other profile', (await barHistory()).length === 0, JSON.stringify(await barHistory()))
    browser.closeOverlay()
    await openBar('alp')
    check('history: the inline completion finishes the host of a page of this profile', (await barValue()) === `alpha.localhost:${port}`, await barValue())
    browser.closeOverlay()
    await openBar('bet')
    check('history: …and never completes to a site that only the other profile visited', (await barValue()) === 'bet', await barValue())
    browser.closeOverlay()

    browser.dispatch({ type: 'space/select', id: pro })
    await openBar('beta')
    const proBar = await barHistory()
    check('history: the command bar of the other profile suggests its pages', proBar.some((r) => r.label.includes('beta-1')) && !proBar.some((r) => r.label.includes('beta-2')), JSON.stringify(proBar))
    browser.closeOverlay()
    await openBar('alpha-1')
    check('history: …and none of the first profile’s', (await barHistory()).length === 0, JSON.stringify(await barHistory()))
    browser.closeOverlay()
    await openBar('bet')
    check('history: the inline completion of that profile finishes its own host', (await barValue()) === `beta.localhost:${port}`, await barValue())
    browser.closeOverlay()
    await openBar('alp')
    check('history: …and not the first profile’s', (await barValue()) === 'alp', await barValue())
    browser.closeOverlay()
    await openBar('shared')
    check('history: a page both profiles visited is suggested in each, from its own history', (await barHistory()).some((r) => r.label.includes('shared')))
    browser.closeOverlay()

    // ---- the calls of the interface itself: no way to name a profile, so no way to reach another one ----
    browser.dispatch({ type: 'space/select', id: home })
    check('history: the interface asking from a space of the first profile gets the first profile’s pages only', !(await askHistory('')).some((e) => e.url.includes(BETA)) && (await askHistory('alpha')).length >= 2 && (await askHistory('beta-1')).length === 0)
    await exec(win.webContents, `window.lucium.forgetHistory(${JSON.stringify(beta1)})`)
    check('history: …and forgetting an address that only the other profile visited does nothing there', has(proProfile, beta1))
    browser.dispatch({ type: 'space/select', id: pro })
    check('history: from a space of the other profile the same call answers that profile’s history', (await askHistory('beta')).some((e) => e.url === beta1) && (await askHistory('alpha-1')).length === 0)

    // ---- « Annuler » after a page was forgotten: the page comes back as it was, in the history of its own profile only ----
    const keptPage = JSON.stringify(entryOf(proProfile, beta1))
    const putBack = (profile: string) => exec<boolean>(win.webContents, `window.lucium.putBackHistory(${JSON.stringify(beta1)}, ${JSON.stringify(profile)})`)
    await exec(win.webContents, `window.lucium.forgetHistory(${JSON.stringify(beta1)}, ${JSON.stringify(proProfile)}, true)`)
    check('history: a page forgotten with a way back leaves the history of its profile', hasNone(proProfile, beta1))
    check('history: …it cannot be put back in the history of another profile', (await putBack(homeProfile)) === false && hasNone(homeProfile, beta1) && hasNone(proProfile, beta1))
    check('history: …and comes back in its own as it was (title, visits, date)', (await putBack(proProfile)) === true && JSON.stringify(entryOf(proProfile, beta1)) === keptPage, JSON.stringify(entryOf(proProfile, beta1)))
    check('history: …once, not twice', (await putBack(proProfile)) === false)
    check('history: a page that was never forgotten that way is not put back', (await exec<boolean>(win.webContents, `window.lucium.putBackHistory("https://never-visited.example/", ${JSON.stringify(proProfile)})`)) === false && hasNone(proProfile, 'https://never-visited.example/'))
    // The same in the command bar, with the keys: ⇧⌫ on the line chosen with the arrows, then ⌘Z while « Annuler » is offered.
    await openBar('beta-1')
    const lines = await barRows()
    const at = lines.findIndex((row) => row.label.includes('beta-1') && row.detail.includes('Historique'))
    const press = (keyCode: string, modifiers: Array<'shift' | 'meta'> = []): void => {
      ui.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      ui.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    // The line must be chosen with the arrows for ⇧⌫ to be about it: down to it, or down and back up when it is the first.
    for (let i = 0; i < Math.max(at, 1); i++) press('Down')
    if (at === 0) press('Up')
    await waitFor(() => exec<boolean>(ui, `(document.querySelector('.results li.selected .label')?.textContent ?? '').includes('beta-1')`))
    press('Backspace', ['shift'])
    check('history: ⇧⌫ in the command bar forgets the page and offers « Annuler »', at >= 0 && (await waitFor(() => hasNone(proProfile, beta1))) && (await waitFor(() => exec<boolean>(ui, `document.querySelector('.cb-undo button') !== null`))), JSON.stringify(lines))
    press('Z', ['meta'])
    check('history: ⌘Z puts it back as it was, and the row goes', (await waitFor(() => JSON.stringify(entryOf(proProfile, beta1)) === keptPage)) && (await waitFor(() => exec<boolean>(ui, `document.querySelector('.cb-undo') === null`))), JSON.stringify(entryOf(proProfile, beta1)))
    browser.closeOverlay()

    // ---- the menu ----
    const show = findMenuItem('Afficher l’historique')
    browser.closeOverlay()
    show?.click()
    check('history: Archive › Afficher l’historique opens the panel of the profile shown', show !== undefined && (await waitFor(() => browser.currentPanel() === 'history')) && (await waitFor(async () => (await panelRows()).some((r) => r.includes('beta-1')))), JSON.stringify(await panelRows()))
    browser.closeOverlay()
    check('history: Archive › Effacer l’historique de navigation… exists', findMenuItem('Effacer l’historique de navigation…') !== undefined)
    const scope = browser.historyScope()
    check('history: it works on the profile of the space shown, with that profile’s page count', scope.profileId === proProfile && scope.pages === history.of(proProfile).size(), JSON.stringify(scope))

    // ---- "Effacer les données du site…" ----
    const siteResults = await browser.clearSiteDataFor({ host: SHARED, types: ['history'], subdomains: false, http: true, reload: false })
    check('history: forgetting the pages of a site reaches the profile shown only', siteResults.every((r) => r.ok) && hasNone(proProfile, shared) && has(homeProfile, shared), JSON.stringify(siteResults))

    // ---- erasing from the menu: one profile's history, the other keeps its own ----
    const homePages = history.of(homeProfile).size()
    check('history: erasing the history of a profile empties it and its file, and leaves the other profile alone', browser.eraseHistory(proProfile) && history.of(proProfile).size() === 0 && filesOf(proProfile) === null && history.of(homeProfile).size() === homePages && filesOf(homeProfile) !== null)
    await visit(pro, pageUrl(BETA, 'beta-3'))
    check('history: the profile records again afterwards', has(proProfile, pageUrl(BETA, 'beta-3')))

    // ---- Settings › Profils › Effacer les données de navigation ----
    await visit(home, pageUrl(ALPHA, 'alpha-3'))
    history.flush()
    await exec(win.webContents, `window.lucium.clearProfile(${JSON.stringify(proProfile)})`)
    check('history: erasing the data of a profile also erases its history, and the first profile keeps its own', history.of(proProfile).size() === 0 && filesOf(proProfile) === null && has(homeProfile, pageUrl(ALPHA, 'alpha-3'), alpha1) && filesOf(homeProfile) !== null)
    await exec(win.webContents, `window.lucium.clearProfile('../x')`).then(
      () => check('history: a profile id that is not a plain name is refused', false),
      () => check('history: a profile id that is not a plain name is refused, and no history is touched', has(homeProfile, alpha1, pageUrl(ALPHA, 'alpha-3')))
    )

    // ---- cleaning the unused profiles ----
    const orphan = 'smoke-orphan'
    history.of(orphan).record(pageUrl(BETA, 'orphan-page'), 'Page orpheline', Date.now())
    await visit(pro, pageUrl(BETA, 'beta-4'))
    history.flush()
    check('history: a profile that no space uses is listed with its history', history.profiles().includes(orphan) && filesOf(orphan) !== null)
    const purged = await browser.purgeUnusedProfiles(browser.unusedProfileIds())
    check('history: cleaning the unused profiles erases the history of one no space uses', purged >= 1 && history.of(orphan).size() === 0 && filesOf(orphan) === null && !history.profiles().includes(orphan), String(purged))
    check('history: …and keeps the history of the profiles the spaces use', has(proProfile, pageUrl(BETA, 'beta-4')) && has(homeProfile, alpha1) && filesOf(homeProfile) !== null)

    // ---- an import from another browser joins the history of the profile of the space it is started from ----
    // A pretend home folder holding a Chrome history of one page; the sheet's own route (importRun) reads it, whatever space is shown.
    const importHome = mkdtempSync(join(tmpdir(), 'lucium-history-import-'))
    const chromeFolder = join(importHome, 'Library/Application Support/Google/Chrome/Default')
    mkdirSync(chromeFolder, { recursive: true })
    const IMPORTED = 'https://smoke-import.example/page'
    const database = new DatabaseSync(join(chromeFolder, 'History'))
    database.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES (1, '${IMPORTED}', 'Page importée', 3, 0, ${(BigInt(Date.UTC(2026, 3, 2, 10)) + 11_644_473_600_000n) * 1000n}, 0);`)
    database.close()
    writeFileSync(join(importHome, 'Library/Application Support/Google/Chrome/Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' } } } }))
    const realService = getImportService()
    setImportService(
      new ImportService({
        home: importHome,
        ctx: () => ({ now: Date.now(), newId: () => crypto.randomUUID() }),
        dispatch: (action) => browser.dispatch(action),
        state: () => store.get(),
        mergeHistory: (entries) => mergeImportedHistory(history, entries),
        chooseFile: async () => null
      })
    )
    try {
      const runImport = () => exec<{ ok: boolean; history: number }>(win.webContents, `window.lucium.importRun({ source: 'chrome', categories: ['history'] })`)
      browser.dispatch({ type: 'space/select', id: pro })
      const inPro = await runImport()
      check('history: an import started in a space of a profile adds its pages to that profile’s history and to no other', inPro.ok && inPro.history === 1 && has(proProfile, IMPORTED) && hasNone(homeProfile, IMPORTED), JSON.stringify(inPro))
      browser.dispatch({ type: 'space/select', id: home })
      const inHome = await runImport()
      check('history: started in the first profile, it adds them there', inHome.ok && inHome.history === 1 && has(homeProfile, IMPORTED) && entryOf(homeProfile, IMPORTED)?.visitCount === 3, JSON.stringify(inHome))
      const again = await runImport()
      check('history: importing the same history again changes nothing', !again.ok && again.history === 0 && history.of(homeProfile).merge(history.of(homeProfile).search('smoke-import')) === 0)
    } finally {
      if (realService) setImportService(realService)
      rmSync(importHome, { recursive: true, force: true })
    }

    // ---- a private window keeps nothing ----
    const secret = `private-${Date.now()}`
    const privateWindow = manager.openPrivate()
    await waitFor(() => exec<boolean>(privateWindow.win.webContents, '!!window.lucium').catch(() => false))
    privateWindow.browser.dispatch({ type: 'tab/open', url: pageUrl(ALPHA, secret) })
    const privateTab = privateWindow.store.get().tabs.at(-1)!.id
    check('history: a page opens in the private window', await waitFor(() => privateWindow.store.get().tabs.find((tab) => tab.id === privateTab)?.title === `hist ${secret}`))
    // The end of its load, where a visit would be recorded.
    await waitFor(() => privateWindow.browser.snapshot().runtime.tabs[privateTab]?.loading === false)
    history.flush()
    const everything = history.profiles().flatMap((profile) => urlsOf(profile))
    check('history: the private visit is in the history of no profile, in memory or on disk', !everything.some((url) => url.includes(secret)) && ![homeProfile, proProfile].some((profile) => filesOf(profile)?.includes(secret)), String(everything.length))
    check('history: the private window’s own interface gets no history to suggest', (await exec<HistoryEntry[]>(privateWindow.win.webContents, `window.lucium.searchHistory('')`)).length === 0 && privateWindow.browser.searchHistory('').length === 0)
    privateWindow.browser.openOverlay({ panel: 'history' })
    check('history: and cannot open the history panel', privateWindow.browser.currentPanel() === null)
    privateWindow.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()
    history.flush()
    check('history: closing the private window leaves no trace either', ![homeProfile, proProfile, orphan].some((profile) => urlsOf(profile).some((url) => url.includes(secret)) || filesOf(profile)?.includes(secret)))
  } finally {
    closeTabs()
    browser.closeOverlay()
    browser.dispatch({ type: 'space/select', id: originalSpace })
    for (const id of createdSpaces) browser.dispatch({ type: 'space/delete', id })
    browser.dispatch({ type: 'space/select', id: originalSpace })
    browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: originalSuggestions } })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=history`: only these checks, with their own report. */
export async function runHistorySmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeHistory(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeHistory ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_HISTORY ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
