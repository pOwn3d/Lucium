// Engine checks for the two additions to the sessions, run inside a real Electron:
//  - Espaces › Mettre l’espace de côté… (menu bar, space menu, command bar) and « Rouvrir » (panel, menu bar, command bar): a space becomes a
//    session and leaves the sidebar with its pages, keeps its theme, profile and link rules, comes back as it was, and survives a restart in between;
//  - the automatic copies of the session: made by hand and from the panel in the data folder, listed with their date and tabs, rotated, restored
//    after a copy of what they replace (and undone), a damaged copy left out with a line in the log, a private window that has none, and the
//    settings (Réglages › Téléchargements et fichiers › Copies automatiques) that survive a restart.
// Real tabs on a local server; the panel and the settings are driven with real mouse input. A restart is simulated the way smoke-sessions does it
// (the state written, then read back by the loader; a fresh service over the same folder).
// Called from the engine smoke test: `await smokeSessionsPlus(ctx, check)`; `LUCIUM_SMOKE_ONLY=sessionsplus` runs only this file.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow as ElectronWindow, Menu, app, dialog, type MenuItem, type WebContents } from 'electron'
import type { SidebarState } from '@shared/model'
import { BACKUP_KEEP_CHOICES } from '@shared/backup-settings'
import { backupId, copyDataOf, stampOfBackupId, type SessionCopyData } from '@shared/session-backups'
import { routeFor } from '@shared/routing'
import { reduce } from '@shared/sidebar'
import { BackupFiles } from './backup-store'
import { menuItems } from './shell/context-menus'
import { SessionBackups, getSessionBackups } from './shell/backups'
import { getWindowManager } from './shell/windows'
import { loadState, liveCtx, type StateStore } from './store'
import type { SmokeContext } from './smoke'
import { noteCheck, OPEN_MORE_SETTINGS, skippedBecause, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 60)

export async function smokeSessionsPlus(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, overlayView, engine } = ctx
  const ui = overlayView.webContents
  const state = (): SidebarState => store.get()
  // The window's store is a view of the shared one: the shared one is what is written to disk.
  const shared = (store as unknown as { shared: StateStore }).shared
  const run = <T>(wc: WebContents, js: string) => wc.executeJavaScript(js) as Promise<T>
  const statePath = join(app.getPath('userData'), 'state.json')
  const copiesDir = join(app.getPath('userData'), 'session-backups')
  const service = getSessionBackups()
  if (!service) throw new Error('the copies service was not set up')
  const files = new BackupFiles(copiesDir)
  rmSync(copiesDir, { recursive: true, force: true })

  // What the line before this suite left: put back at the end.
  const original = copyDataOf(state())
  const originalSettings = { ...state().settings }
  const originalSessions = state().sessions.map((s) => s.id)
  const originalFavorites = JSON.stringify(state().favorites)

  // ---- the log: a line that says what happened to a copy that could not be used ----
  const logged: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
    realError(...args)
  }

  // ---- native question: answered by the test ----
  const box = dialog as unknown as { showMessageBoxSync: (...args: unknown[]) => number }
  const realBox = box.showMessageBoxSync
  const asked: Array<{ message: string; detail: string; buttons: string[] }> = []
  let answer = 0
  box.showMessageBoxSync = (...args: unknown[]) => {
    const options = (args.find((a) => typeof a === 'object' && a !== null && 'message' in (a as object)) ?? {}) as { message: string; detail: string; buttons: string[] }
    asked.push(options)
    return answer
  }

  // ---- a local site: every page has a title of its own, one sets a cookie ----
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/cookie')) res.setHeader('set-cookie', 'plus=1; Max-Age=3600; Path=/')
    res.end(`<title>plus ${req.url}</title><body>plus ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- menus ----
  const menu = () => Menu.getApplicationMenu()!
  const itemsOf = (label: string): MenuItem[] => menu().items.find((m) => m.label === label)?.submenu?.items ?? []
  const choose = (...path: [string, string]) => {
    const item = itemsOf(path[0]).find((i) => i.label === path[1])
    if (!item || !item.enabled) throw new Error(`menu entry missing or greyed out: ${path.join(' › ')}`)
    item.click()
  }

  // ---- the panel, with real input ----
  const key = async (keyCode: string) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode })
    ui.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(80)
  }
  const mouse = (wc: WebContents, type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  /** A real click on the first element matching `selector` in the panel just opened. */
  const click = async (selector: string, text = ''): Promise<boolean> => {
    const box = await run<{ x: number; y: number; w: number; h: number } | null>(
      ui,
      `(() => { const el = [...document.querySelectorAll('.sessions:not([data-stale]) ${selector}')].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`
    )
    if (!box) return false
    mouse(ui, 'mouseMove', box.x + box.w / 2, box.y + box.h / 2)
    await sleep(30)
    mouse(ui, 'mouseDown', box.x + box.w / 2, box.y + box.h / 2)
    mouse(ui, 'mouseUp', box.x + box.w / 2, box.y + box.h / 2)
    await sleep(160)
    return true
  }
  const panelText = (selector: string) => run<string | null>(ui, `document.querySelector('.sessions:not([data-stale]) ${selector}')?.textContent ?? null`)
  const open = async (opener: () => void): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await run(ui, `document.querySelectorAll('#root *').forEach((el) => el.setAttribute('data-stale', '1'))`)
      opener()
      if (await waitFor(async () => (await run<number>(ui, `document.querySelectorAll('.sessions:not([data-stale])').length`)) > 0, 2500)) {
        await sleep(200)
        return true
      }
    }
    return false
  }
  const backupRows = () =>
    run<Array<{ id: string; name: string; meta: string; button: string }>>(
      ui,
      `[...document.querySelectorAll('.sessions:not([data-stale]) .backups-row')].map((r) => ({ id: r.dataset.id, name: r.querySelector('.sessions-name')?.textContent ?? '', meta: r.querySelector('.sessions-meta')?.textContent ?? '', button: r.querySelector('button')?.textContent ?? '' }))`
    )
  const sessionRows = () =>
    run<Array<{ id: string; name: string; meta: string; aside: boolean; buttons: string[] }>>(
      ui,
      `[...document.querySelectorAll('.sessions:not([data-stale]) .sessions-row')].map((r) => ({ id: r.dataset.id, name: r.querySelector('.sessions-name')?.textContent ?? '', meta: r.querySelector('.sessions-meta')?.textContent ?? '', aside: r.dataset.aside === '1', buttons: [...r.querySelectorAll('button')].map((b) => b.textContent) }))`
    )

  const toast = () => browser.snapshot().toast
  const openLoaded = async (path: string, spaceId?: string, waitMs = 12_000): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}`, ...(spaceId ? { spaceId } : {}) })
    const id = state().tabs.at(-1)!.id
    await waitFor(() => state().tabs.find((t) => t.id === id)?.title === `plus ${path}`, waitMs)
    return id
  }
  const copyIds = () => files.ids()

  const startSpace = state().activeSpaceId

  // ======================= the test spaces =======================
  // "Plus A": a loose pin, a pin in a folder, two Today tabs (one renamed, one with a name and an icon of its own), its own colours, a link rule and a profile.
  browser.dispatch({ type: 'space/create', name: 'Plus A', emoji: '🅰️', hue: 160, profileName: 'Clients plus' })
  const spaceA = state().activeSpaceId
  browser.dispatch({ type: 'space/update', id: spaceA, patch: { theme: { intensity: 0.8, noise: 0.3 } } })
  browser.dispatch({ type: 'space/header', id: spaceA, visible: false })
  const aLoose = await openLoaded('/cookie-loose', spaceA)
  const aFiled = await openLoaded('/filed', spaceA)
  const aOne = await openLoaded('/one', spaceA)
  const aTwo = await openLoaded('/two', spaceA)
  browser.dispatch({ type: 'tab/pin', id: aLoose })
  browser.dispatch({ type: 'tab/pin', id: aFiled })
  browser.dispatch({ type: 'folder/create-with', tabIds: [aFiled], name: 'Dossier plus' })
  browser.dispatch({ type: 'tab/rename', id: aOne, title: 'Nom perso' })
  browser.dispatch({ type: 'tab/icon', id: aOne, icon: '🔥' })
  browser.dispatch({ type: 'tab/select', id: aTwo })
  browser.dispatch({ type: 'settings/update', patch: { linkRoutes: [...state().settings.linkRoutes, { host: 'plus-client.example', spaceId: spaceA }] } })
  browser.dispatch({ type: 'favorite/add', url: `${base}/favori`, title: 'Favori plus' })
  const profileA = state().spaces.find((s) => s.id === spaceA)!.profileId
  check('the test space has its own profile, so that its cookies can be followed', profileA === 'clients-plus', profileA)
  // A page of the space that holds a cookie, loaded in that profile.
  browser.dispatch({ type: 'tab/select', id: aLoose })
  await waitFor(() => browser.livePageIds().includes(aLoose))
  const cookies = (host = '127.0.0.1') => engine.siteCookieCount(profileA, host, false)
  // With compat/api-probe or compat/surface-probe loaded (the whole `test:engine` loads them) the first page of a profile made after the start
  // used to not load, and there was no cookie to follow: the page now waits for the folders its profile inherits
  // (engine/profile-ready.ts). If it still does not load, the two checks on that cookie are not run; alone, they are.
  const firstPageLoaded = state().tabs.find((t) => t.id === aLoose)?.title === 'plus /cookie-loose'
  if (engine.inheritedExtensionFolders() > 0) check('the first page of a profile made after the start loads although that profile inherits extensions loaded by hand (it waits for them)', firstPageLoaded, state().tabs.find((t) => t.id === aLoose)?.title)
  const cookieFollowed = firstPageLoaded || engine.listAllExtensions().every((e) => e.source === 'store')
  if (cookieFollowed) check('the page of the space set a cookie in its profile', await waitFor(async () => (await cookies()) >= 1, 8000), String(await cookies()))
  else check('the page of the space set a cookie in its profile', true, skippedBecause('the first page of the profile did not load next to the extension probes of the run (the check above fails for it); LUCIUM_SMOKE_ONLY=sessionsplus without LUCIUM_EXTENSIONS follows the cookie'))
  browser.dispatch({ type: 'tab/select', id: aTwo })

  // "Plus B": one tab, in the default profile.
  browser.dispatch({ type: 'space/create', name: 'Plus B', emoji: '🅱️', hue: 20 })
  const spaceB = state().activeSpaceId
  const bOne = await openLoaded('/b-one', spaceB)
  browser.dispatch({ type: 'space/select', id: spaceA })
  const beforeA = {
    space: state().spaces.find((s) => s.id === spaceA)!,
    place: state().spaces.findIndex((s) => s.id === spaceA),
    tabs: state().tabs.filter((t) => t.spaceId === spaceA),
    folders: state().folders.filter((f) => f.spaceId === spaceA),
    shown: state().activeTabBySpace[spaceA]
  }
  check('Plus A holds four tabs, a folder and its own colours before it is put aside', beforeA.tabs.length === 4 && beforeA.folders.length === 1 && beforeA.space.theme.intensity === 0.8 && beforeA.space.hideHeader === true && beforeA.shown === aTwo)

  // ======================= the entries =======================
  const spacesMenu = itemsOf('Espaces').map((i) => i.label || '——')
  const at = spacesMenu.indexOf('Gérer les espaces…')
  check('the Espaces menu keeps Arc’s entries in order and ends with "Mettre l’espace de côté…" and "Rouvrir un espace mis de côté", after "Gérer les espaces…"', at > 0 && spacesMenu.slice(at, at + 4).join('|') === 'Gérer les espaces…|——|Mettre l’espace de côté…|Rouvrir un espace mis de côté', spacesMenu.join(' | '))
  const aside = itemsOf('Espaces').find((i) => i.label === 'Mettre l’espace de côté…')!
  const reopenMenu = () => itemsOf('Espaces').find((i) => i.label === 'Rouvrir un espace mis de côté')!
  check('with no space put aside, the reopening entry is greyed out and says so', aside.enabled && reopenMenu().enabled === false && reopenMenu().submenu?.items.map((i) => i.label).join() === 'Aucun espace mis de côté')
  check('neither has a shortcut by default (Arc has none)', !aside.accelerator && !reopenMenu().accelerator)
  const spaceMenu = menuItems({ kind: 'space', id: spaceA }, browser, store, ctx.win).map((i) => i.label ?? '——')
  const spaceAside = menuItems({ kind: 'space', id: spaceA }, browser, store, ctx.win).find((i) => i.label === 'Mettre l’espace de côté…')
  check('the menu of a space offers it too, enabled, above "Gérer les espaces…", and the last entries (the « Supprimer » block) are where they were', spaceAside?.enabled === true && spaceMenu.indexOf('Mettre l’espace de côté…') < spaceMenu.indexOf('Gérer les espaces…') && spaceMenu.slice(-4).join('|') === 'Gérer les espaces…|Supprimer|Vider les onglets du jour|Supprimer l’espace…', spaceMenu.join(' | '))

  // ======================= putting a space aside =======================
  const favoritesBefore = JSON.stringify(state().favorites)
  const spacesBefore = state().spaces.map((s) => s.id)
  answer = 1
  // No wait: the entry asks (a box of the system, answered here at once) and acts on the answer before it returns (space-aside.ts).
  choose('Espaces', 'Mettre l’espace de côté…')
  check('the question names the space, its four tabs, and says what is lost if nothing was sent', asked.length === 1 && asked[0]!.message === frenchSpaces('Mettre l’espace « Plus A » de côté ?') && /Ses 4 onglets sont fermés/.test(asked[0]!.detail) && /saisi sans l’envoyer/.test(asked[0]!.detail) && asked[0]!.buttons[0] === 'Mettre de côté', JSON.stringify(asked[0]))
  check('"Annuler" changes nothing', state().spaces.some((s) => s.id === spaceA) && state().sessions.length === originalSessions.length && state().tabs.filter((t) => t.spaceId === spaceA).length === 4)

  const livePages = browser.livePageIds().filter((id) => beforeA.tabs.some((t) => t.id === id))
  check('some pages of the space are alive in memory before it is put aside', livePages.length >= 1, String(livePages.length))
  answer = 0
  choose('Espaces', 'Mettre l’espace de côté…')
  check('"Mettre de côté" takes the space out of the sidebar at once', await waitFor(() => !state().spaces.some((s) => s.id === spaceA)))
  const session = state().sessions.find((s) => s.space?.space.id === spaceA)!
  check('it is a session named after the space, newest first, that remembers the space', !!session && session.name === 'Plus A' && state().sessions[0]!.id === session.id && session.space!.tabs.length === 4)
  check('its pages left the memory: none of its tabs is in the state or has a live page', state().tabs.every((t) => t.spaceId !== spaceA) && beforeA.tabs.every((t) => !browser.livePageIds().includes(t.id)) && state().folders.every((f) => f.spaceId !== spaceA))
  check('the other spaces and their tabs are untouched', JSON.stringify(state().spaces.map((s) => s.id)) === JSON.stringify(spacesBefore.filter((id) => id !== spaceA)) && state().tabs.some((t) => t.id === bOne))
  check('the favourites stay common to everyone, as they were', JSON.stringify(state().favorites) === favoritesBefore && state().favorites.some((f) => f.title === 'Favori plus'))
  check('the space on screen is a neighbour', state().spaces.some((s) => s.id === state().activeSpaceId))
  check('its theme, header, profile and link rule are kept for when it comes back', JSON.stringify(session.space!.space) === JSON.stringify(beforeA.space) && state().settings.linkRoutes.some((r) => r.host === 'plus-client.example' && r.spaceId === spaceA))
  check('a notice says so and offers "Rouvrir"', await waitFor(() => toast()?.message === frenchSpaces('Espace « Plus A » mis de côté') && toast()?.action === 'Rouvrir'), JSON.stringify(toast()))
  check('the menu now lists it under "Rouvrir un espace mis de côté"', await waitFor(() => reopenMenu().enabled === true && reopenMenu().submenu?.items.map((i) => i.label).join() === '🅰️ Plus A'), reopenMenu().submenu?.items.map((i) => i.label).join())
  check('a link of the rule is not sent to a space that is not there (it opens where the user is), and the rule itself is kept', routeFor('https://plus-client.example/x', state().settings.linkRoutes, state().spaces) === undefined && state().settings.linkRoutes.some((r) => r.host === 'plus-client.example'))

  // The profile's cookies stay on disk: the clean-up of unused profiles leaves them alone.
  check('the profile of the space is on disk before the clean-up', engine.storedProfileIds().includes(profileA), engine.storedProfileIds().join())
  const cleaned = await browser.purgeUnusedProfiles(browser.unusedProfileIds())
  check('"Effacer les profils inutilisés" does not touch the profile of a space put aside, and its cookie is still there', engine.storedProfileIds().includes(profileA) && (!cookieFollowed || (await cookies()) >= 1), `${cleaned} cleaned; ${await cookies()} cookies`)

  // ======================= a restart in between =======================
  const flushed = store.flush()
  const reloaded = loadState(statePath)
  const reloadedSession = reloaded.sessions.find((s) => s.id === session.id)
  check('the state is written and read back with the session and without the space: quitting between loses nothing', flushed && !!reloadedSession && JSON.stringify(reloadedSession) === JSON.stringify(session) && !reloaded.spaces.some((s) => s.id === spaceA) && reloaded.tabs.every((t) => t.spaceId !== spaceA))
  const reopenedOffline = reduce(reloaded, { type: 'space/reopen', id: session.id }, liveCtx())
  check('and the space reopens from that file with all its tabs, as it was', reopenedOffline.spaces.some((s) => s.id === spaceA) && reopenedOffline.tabs.filter((t) => t.spaceId === spaceA).map((t) => t.id).join() === beforeA.tabs.map((t) => t.id).join())

  // ======================= the panel: Rouvrir =======================
  check('File › Sessions… lists the space as a session of its own kind, with "Rouvrir" and no "Restaurer"', (await open(() => choose('Fichier', 'Sessions…'))) && (await sessionRows()).some((r) => r.id === session.id && r.aside && r.buttons.includes('Rouvrir') && !r.buttons.includes('Restaurer') && /^Espace mis de côté · 4 onglets · /.test(r.meta)), JSON.stringify(await sessionRows()))
  check('"Rouvrir" brings the space back and closes the panel', (await click(`.sessions-row[data-id="${session.id}"] [data-action="reopen"]`)) && (await waitFor(() => state().spaces.some((s) => s.id === spaceA))) && (await waitFor(() => browser.currentPanel() === null)))
  const afterA = {
    space: state().spaces.find((s) => s.id === spaceA)!,
    place: state().spaces.findIndex((s) => s.id === spaceA),
    tabs: state().tabs.filter((t) => t.spaceId === spaceA),
    folders: state().folders.filter((f) => f.spaceId === spaceA),
    shown: state().activeTabBySpace[spaceA]
  }
  check('same id, name, icon, colours, header and profile', JSON.stringify(afterA.space) === JSON.stringify(beforeA.space))
  check('same place among the spaces, and it is the one on screen', afterA.place === beforeA.place && state().activeSpaceId === spaceA)
  check('same tabs, in the same order, with the same ids, pins, folder, names and icons', JSON.stringify(afterA.tabs.map((t) => [t.id, t.url, t.pinned, t.folderId, t.customTitle, t.icon])) === JSON.stringify(beforeA.tabs.map((t) => [t.id, t.url, t.pinned, t.folderId, t.customTitle, t.icon])), JSON.stringify(afterA.tabs.map((t) => t.url)))
  check('same folder, and the tab that was on screen is on screen again', JSON.stringify(afterA.folders) === JSON.stringify(beforeA.folders) && afterA.shown === beforeA.shown)
  check('the session is spent: the list no longer has it', !state().sessions.some((s) => s.id === session.id))
  check('a notice says it is open again', await waitFor(() => toast()?.message === frenchSpaces('Espace « Plus A » rouvert')), JSON.stringify(toast()))
  check('the pages are not loaded until they are shown (only the tab on screen is)', browser.livePageIds().includes(aTwo) && !browser.livePageIds().includes(aOne))
  browser.dispatch({ type: 'tab/select', id: aOne })
  check('showing one loads its page', (await waitFor(() => browser.livePageIds().includes(aOne))) && (await waitFor(async () => (await browser.evaluateInPage('location.href')) === `${base}/one`)))
  check('the link rule works again', routeFor('https://plus-client.example/x', state().settings.linkRoutes, state().spaces) === spaceA)
  check('the favourites did not move', JSON.stringify(state().favorites) === favoritesBefore)

  // ======================= the command bar =======================
  const barFocused = async () => run<boolean>(ui, `document.activeElement === document.querySelector('.palette-input')`)
  const openBar = async (text: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      if (await waitFor(barFocused, 3000)) break
    }
    await sleep(200)
    for (const ch of text) {
      const keyCode = ch === ' ' ? 'Space' : ch
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(45)
    }
    await sleep(450)
  }
  const barRows = () => run<Array<{ label: string; selected: boolean }>>(ui, `[...document.querySelectorAll('.results li[role="option"]')].map((li) => ({ label: li.querySelector('.label')?.textContent ?? '', selected: li.classList.contains('selected') }))`)
  const chooseRow = async (label: string): Promise<boolean> => {
    const rows = await barRows()
    const to = rows.findIndex((r) => r.label === label)
    if (to < 0) return false
    for (let i = rows.findIndex((r) => r.selected); i < to; i++) await key('Down')
    await key('Return')
    return true
  }
  const suggestions = state().settings.searchSuggestions
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: false } })
  browser.dispatch({ type: 'space/select', id: spaceB })
  await openBar('mettre de côté')
  check('typing "mettre de côté" offers the command', (await barRows()).some((r) => r.label === 'Mettre l’espace de côté'), JSON.stringify(await barRows()))
  answer = 0
  asked.length = 0
  check('Return on it closes the bar, asks, and puts the space on screen aside', (await chooseRow('Mettre l’espace de côté')) && (await waitFor(() => !state().spaces.some((s) => s.id === spaceB))) && asked.length === 1 && asked[0]!.message === frenchSpaces('Mettre l’espace « Plus B » de côté ?'), JSON.stringify(asked))
  check('the bar closed', await waitFor(() => browser.currentPanel() === null))
  const sessionB = state().sessions.find((s) => s.space?.space.id === spaceB)!
  await openBar('rouvrir')
  check('typing "rouvrir" offers "Rouvrir l’espace Plus B"', (await barRows()).some((r) => r.label === 'Rouvrir l’espace Plus B'), JSON.stringify(await barRows()))
  check('Return on it brings the space back', (await chooseRow('Rouvrir l’espace Plus B')) && (await waitFor(() => state().spaces.some((s) => s.id === spaceB))) && state().tabs.some((t) => t.id === bOne) && !state().sessions.some((s) => s.id === sessionB.id))
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: suggestions } })

  // ======================= the menu bar: Rouvrir =======================
  answer = 0
  browser.dispatch({ type: 'space/select', id: spaceA })
  choose('Espaces', 'Mettre l’espace de côté…')
  check('the menu puts Plus A aside again', await waitFor(() => !state().spaces.some((s) => s.id === spaceA)))
  const entry = await (async () => {
    await waitFor(() => reopenMenu().submenu?.items.some((i) => i.label === '🅰️ Plus A') === true)
    return reopenMenu().submenu!.items.find((i) => i.label === '🅰️ Plus A')!
  })()
  entry.click()
  check('and "Rouvrir un espace mis de côté › Plus A" brings it back', await waitFor(() => state().spaces.some((s) => s.id === spaceA)) && state().tabs.filter((t) => t.spaceId === spaceA).length === 4)

  // ======================= what it refuses =======================
  const sessionsBefore = state().sessions.length
  const fillers = Array.from({ length: 100 - sessionsBefore }, (_, i) => ({ id: `plus-fill-${i}`, name: `Remplissage ${i}`, createdAt: 1 + i, tabs: [{ url: `${base}/fill`, title: 'x' }] }))
  shared.replace({ ...state(), sessions: [...state().sessions, ...fillers] })
  const tabsBefore = state().tabs.length
  await run(ui, `window.lucium.asideSpace()`)
  await waitFor(() => (toast()?.message ?? '').startsWith('Limite de 100 sessions'), 3000)
  check('past 100 sessions nothing is put aside, nothing is asked, and a notice says why', state().spaces.some((s) => s.id === state().activeSpaceId) && state().tabs.length === tabsBefore && state().sessions.length === 100 && /^Limite de 100 sessions/.test(toast()?.message ?? ''), JSON.stringify(toast()))
  check('the menu entry is greyed out then', itemsOf('Espaces').find((i) => i.label === 'Mettre l’espace de côté…')?.enabled === false)
  shared.replace({ ...state(), sessions: state().sessions.filter((s) => !s.id.startsWith('plus-fill-')) })

  // The renderer cannot forge a copy.
  const forged = copyDataOf({ ...state(), tabs: [] })
  const tabsNow = JSON.stringify(state().tabs.map((t) => t.id))
  // No wait: the interface's dispatch is answered once the main process has handled it, a refusal included.
  await run(ui, `window.lucium.dispatch({ type: 'backup/restore', copy: ${JSON.stringify(forged)} })`)
  check('a copy dispatched from the interface is refused: the main process alone restores', JSON.stringify(state().tabs.map((t) => t.id)) === tabsNow)

  // ======================= the copies =======================
  browser.dispatch({ type: 'settings/update', patch: { autoBackupKeep: 3 } })
  check('the copies are on by default, five of them, one every half hour (this test lowers the number to three)', originalSettings.autoBackup === true && originalSettings.autoBackupKeep === 5 && originalSettings.autoBackupMinutes === 30)
  check('the panel opens with no copy yet and says so', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && (await backupRows()).length === 0 && /Aucune copie pour l’instant/.test((await panelText('[data-role="backups-empty"]')) ?? ''))
  check('"Faire une copie maintenant" writes a copy and lists it with its date and tabs', (await click('[data-action="back-up-now"]')) && (await waitFor(async () => (await backupRows()).length === 1)) && copyIds().length === 1)
  const first = (await backupRows())[0]!
  check('it says "Aujourd’hui à hh:mm", the tabs and spaces of the session, and why', /^Aujourd’hui à \d{2}:\d{2}$/.test(first.name) && first.meta === `${state().tabs.length} onglets · ${state().spaces.length} espaces · Copie manuelle`, JSON.stringify(first))
  const firstCopyId = copyIds()[0]!
  check('the file is in the data folder, private to the user, and holds exactly the spaces and tabs of the session', (readdirSync(copiesDir).length === 1) && (files.read(copyIds()[0]!).data.tabs.length === state().tabs.length) && JSON.stringify(files.read(copyIds()[0]!).data.spaces) === JSON.stringify(state().spaces))

  // Change the session, copy again, three more times. A copy made by hand is counted apart from the automatic ones: the four stay, whatever the settings say.
  const changes: string[] = []
  for (const path of ['/c2', '/c3', '/c4']) {
    await sleep(15)
    const id = await openLoaded(path, spaceB)
    changes.push(id)
    await click('[data-action="back-up-now"]')
    await waitFor(async () => (await run<number>(ui, `document.querySelectorAll('.sessions:not([data-stale]) [data-role="backup-note"]').length`)) > 0)
  }
  // The witness: the fourth copy on disk. A copy is written with the rotation of the others in one go (backups.ts, `backUp`): nothing goes after it.
  await waitFor(() => copyIds().length === 4)
  check('the copies made by hand are not pushed out by the number the settings say: the four stay, the first one too', copyIds().length === 4 && copyIds().includes(firstCopyId) && readdirSync(copiesDir).length === 4, copyIds().join())
  const rows = await backupRows()
  check('the panel lists the four, newest first', rows.length === 4 && rows.map((r) => r.id).join() === copyIds().join(), JSON.stringify(rows.map((r) => r.id)))
  check('the newest holds the latest tab, the third holds the first change only, and the oldest none of them', files.read(copyIds()[0]!).data.tabs.some((t) => t.id === changes[2]) && !files.read(copyIds()[2]!).data.tabs.some((t) => t.id === changes[2]) && files.read(copyIds()[2]!).data.tabs.some((t) => t.id === changes[0]) && copyIds()[3] === firstCopyId && !files.read(firstCopyId).data.tabs.some((t) => changes.includes(t.id)))

  // A page whose address differs between the copy and now must reload from the copy's.
  const wanderer = changes[0]!
  const wandererUrl = state().tabs.find((t) => t.id === wanderer)!.url
  const target = copyIds()[1]!
  const targetData = files.read(target).data
  check('the second copy holds the tab as it is now', targetData.tabs.some((t) => t.id === wanderer && t.url === wandererUrl))
  browser.dispatch({ type: 'tab/select', id: wanderer })
  await waitFor(() => browser.livePageIds().includes(wanderer))
  browser.dispatch({ type: 'tab/update', id: wanderer, patch: { url: `${base}/wandered` } })

  // ---- restoring one: confirmation, a copy of what it replaces, the result, the notice ----
  const beforeRestore = copyDataOf(state())
  const stateBeforeJson = JSON.stringify(state().tabs.map((t) => t.id))
  check('the panel asks for a confirmation: the first click on "Restaurer" only arms the button', (await click(`.backups-row[data-id="${target}"] [data-action="restore-backup"]`)) && (await waitFor(async () => (await backupRows()).find((r) => r.id === target)?.button === 'Confirmer')) && JSON.stringify(state().tabs.map((t) => t.id)) === stateBeforeJson)
  check('and says that the session is copied first', /d’abord copiés eux aussi/.test((await panelText('[data-role="backup-confirm"]')) ?? ''))
  const idsBefore = copyIds()
  check('the second click replaces the spaces and tabs with the copy’s', (await click(`.backups-row[data-id="${target}"] [data-action="restore-backup"]`)) && (await waitFor(() => JSON.stringify(state().tabs.map((t) => t.id)) === JSON.stringify(targetData.tabs.map((t) => t.id)))), JSON.stringify(state().tabs.length))
  check('the spaces, folders and what is on screen are the copy’s too', JSON.stringify(state().spaces.map((s) => s.id)) === JSON.stringify(targetData.spaces.map((s) => s.id)) && JSON.stringify(state().folders) === JSON.stringify(targetData.folders))
  check('the panel closed', await waitFor(() => browser.currentPanel() === null))
  const idsAfter = copyIds()
  const guard = idsAfter.map((id) => files.read(id)).find((c) => c.reason === 'before-restore')
  check('a copy of the session it replaced was made first: it holds the tabs that are gone', !!guard && JSON.stringify(guard.data.tabs.map((t) => t.id)) === JSON.stringify(beforeRestore.tabs.map((t) => t.id)) && idsAfter.length === 5 && idsAfter[0] !== idsBefore[0] && idsBefore.every((id) => idsAfter.includes(id)), idsAfter.join())
  check('the favourites, the settings and the sessions are not touched by it', JSON.stringify(state().favorites) === favoritesBefore && state().settings.autoBackupKeep === 3 && state().sessions.length === originalSessions.length)
  check('the notice says what came back and offers to undo', await waitFor(() => anySpace(/^Copie restaurée : \d+ onglets?, \d+ espaces?$/).test(toast()?.message ?? '') && toast()?.action === 'Annuler'), JSON.stringify(toast()))
  check('the page that was somewhere else than the copy says was closed, to reload from the copy’s address', !browser.livePageIds().includes(wanderer) && state().tabs.find((t) => t.id === wanderer)?.url === wandererUrl)

  // ---- undoing it ----
  browser.runToastAction(toast()!.id)
  check('"Annuler" puts the session back as it was before the restoration', await waitFor(() => JSON.stringify(state().tabs.map((t) => t.id)) === stateBeforeJson), JSON.stringify(state().tabs.length))
  check('with the address the tab had wandered to', state().tabs.find((t) => t.id === wanderer)?.url === `${base}/wandered`)

  // ---- a copy that cannot be read ----
  const damaged = backupId(Date.now() + 5000)
  writeFileSync(join(copiesDir, `${damaged}.json`), '{ "format": "lucium-session-copy", "version": 1, "data": ')
  check('the panel lists the readable copies and counts the damaged one', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && (await waitFor(async () => /1 copie illisible a été ignorée/.test((await panelText('[data-role="backups-unreadable"]')) ?? ''))) && (await backupRows()).length >= 2 && !(await backupRows()).some((r) => r.id === damaged), JSON.stringify(await backupRows()))
  check('the log names it and says why', logged.some((l) => l.includes(damaged) && /cannot be read/.test(l)), logged.filter((l) => l.includes('backups')).slice(-3).join(' | '))
  const survivors = await run<{ ok: boolean; message?: string }>(ui, `window.lucium.restoreBackup(${JSON.stringify(damaged)})`)
  check('restoring the damaged one says it is unreadable and changes nothing', survivors.ok === false && /illisible/.test(survivors.message ?? '') && JSON.stringify(state().tabs.map((t) => t.id)) === stateBeforeJson)
  const hostileAnswers: boolean[] = []
  for (const hostile of ['../state', '..', 'copie-1', backupId(1), '/etc/passwd', 5, null]) {
    const answerFor = await run<{ ok: boolean }>(ui, `window.lucium.restoreBackup(${JSON.stringify(hostile)})`)
    hostileAnswers.push(answerFor.ok)
  }
  check('an id that is not a copy’s, or names no copy, is refused and changes nothing', hostileAnswers.every((ok) => ok === false) && JSON.stringify(state().tabs.map((t) => t.id)) === stateBeforeJson, JSON.stringify(hostileAnswers))
  browser.closeOverlay()
  rmSync(join(copiesDir, `${damaged}.json`), { force: true })

  // ---- a restart: a fresh service over the same folder ----
  const fresh = new SessionBackups({
    files: new BackupFiles(copiesDir),
    state: () => shared.get(),
    subscribe: (listener) => shared.subscribe(() => listener()),
    apply: (copy: SessionCopyData) => browser.dispatch({ type: 'backup/restore', copy }),
    toast: (message, action) => browser.showToast(message, action)
  })
  check('after a restart the same copies are there, newest first', JSON.stringify(fresh.list().entries.map((e) => e.id)) === JSON.stringify(copyIds()) && fresh.list().enabled === true)
  const quitCopy = fresh.backUp('quit')
  check('a quit copy is made without error, by the new service over the old folder', quitCopy.ok)
  const again = fresh.backUp('quit')
  check('a second one right after, with nothing changed, writes nothing', again.ok && again.id === null)

  // ---- rotation: the automatic copies rotate among themselves, down to the three of the settings; the copies asked for are not counted with them ----
  const isAutomatic = (id: string) => ['auto', 'quit'].includes(files.read(id).reason)
  const askedCopies = copyIds().filter((id) => !isAutomatic(id))
  const automaticMade: string[] = quitCopy.ok && quitCopy.id ? [quitCopy.id] : []
  for (const path of ['/r1', '/r2', '/r3']) {
    // A copy is named after its millisecond: the next one waits for the clock to pass the newest, so that the names tell their order.
    await waitFor(() => Date.now() > stampOfBackupId(copyIds()[0]!))
    browser.dispatch({ type: 'tab/open', url: `${base}${path}`, background: true })
    const made = fresh.backUp('quit')
    if (made.ok && made.id) automaticMade.push(made.id)
  }
  const automaticLeft = copyIds().filter(isAutomatic)
  check('rotation keeps the number the settings say among the automatic copies: three, the oldest gone', automaticMade.length === 4 && automaticLeft.length === 3 && !automaticLeft.includes(automaticMade[0]!) && automaticLeft[0] === automaticMade[3], JSON.stringify([automaticMade, automaticLeft]))
  check('and takes none of the copies made by hand or before the restoration', askedCopies.length >= 5 && askedCopies.every((id) => copyIds().includes(id)), JSON.stringify([askedCopies, copyIds()]))

  // ---- the settings, and a restart of them ----
  browser.dispatch({ type: 'settings/update', patch: { autoBackupKeep: 10, autoBackupMinutes: 120 } })
  const written = store.flush()
  check('the number of copies and the delay survive a restart', written && loadState(statePath).settings.autoBackupKeep === 10 && loadState(statePath).settings.autoBackupMinutes === 120)
  const tampered = JSON.parse(readFileSync(statePath, 'utf8')) as { settings: Record<string, unknown> }
  tampered.settings['autoBackupKeep'] = 5000
  tampered.settings['autoBackupMinutes'] = 0.001
  tampered.settings['autoBackup'] = 'oui'
  const tamperedFile = join(app.getPath('userData'), 'state-tampered.json')
  writeFileSync(tamperedFile, JSON.stringify(tampered))
  const loaded = loadState(tamperedFile).settings
  rmSync(tamperedFile, { force: true })
  check('a file that asks for thousands of copies or one per millisecond is brought back to the choices, and the flag to its default', loaded.autoBackupKeep === BACKUP_KEEP_CHOICES.at(-1) && loaded.autoBackupMinutes === 5 && loaded.autoBackup === true, JSON.stringify([loaded.autoBackupKeep, loaded.autoBackupMinutes, loaded.autoBackup]))

  // ---- the settings window ----
  const settingsWindows = () => ElectronWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')
  await waitFor(() => toast() === null && browser.currentPanel() === null, 20_000)
  // The group is in the category « Téléchargements et fichiers »; the title of a group carries the number of its settings (« Copies automatiques3 »), so it is
  // read by its beginning. Its switch is at the top of the page, its two lists in « Plus de réglages » under the same title, opened here: `g` stands for both parts.
  browser.openOverlay({ panel: 'settings', pane: 'files' })
  await waitFor(() => settingsWindows().length === 1)
  const sw = settingsWindows()[0]!.webContents
  await waitFor(async () => (await run<boolean>(sw, `[...document.querySelectorAll('.pref-section > h3')].some((h) => h.textContent.startsWith('Copies automatiques'))`)), 8000)
  await waitFor(() => run<boolean>(sw, OPEN_MORE_SETTINGS), 3000)
  const group = (script: string) =>
    run<unknown>(sw, `(() => { const parts = [...document.querySelectorAll('.pref-section')].filter((s) => s.querySelector('h3')?.textContent.startsWith('Copies automatiques')); const g = { querySelector: (q) => parts.map((p) => p.querySelector(q)).find(Boolean) ?? null, querySelectorAll: (q) => parts.flatMap((p) => [...p.querySelectorAll(q)]), scrollIntoView: (o) => parts[0]?.scrollIntoView(o) }; ${script} })()`)
  const titles = await run<string[]>(sw, `[...document.querySelectorAll('.pref-section > h3')].map((h) => h.textContent)`)
  const copies = titles.length - 1 - [...titles].reverse().findIndex((title) => title.startsWith('Copies automatiques'))
  check('Réglages › Téléchargements et fichiers has the group "Copies automatiques", after "Signets", the last of the category', copies > titles.findIndex((title) => title.startsWith('Signets')) && copies === titles.length - 1, titles.join('|'))
  const shown = (await group(`return { on: g.querySelector('input[role=switch]').checked, selects: [...g.querySelectorAll('select')].map((s) => [s.getAttribute('aria-label'), s.value, s.disabled]) }`)) as { on: boolean; selects: Array<[string, string, boolean]> }
  check('the switch is on and the two lists show the settings (120 minutes, 10 copies)', shown.on === true && JSON.stringify(shown.selects) === JSON.stringify([['Délai entre deux copies', '120', false], ['Nombre de copies conservées', '10', false]]), JSON.stringify(shown))
  const switchBox = (await group(`const r = g.querySelector('input[role=switch]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }`)) as { x: number; y: number; w: number; h: number }
  const clickSwitch = async () => {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) mouse(sw, type, switchBox.x + switchBox.w / 2, switchBox.y + switchBox.h / 2)
    await sleep(250)
  }
  await run(sw, `document.querySelector('.settings-content').scrollTo(0, 0)`)
  const boxNow = (await group(`g.scrollIntoView({ block: 'center' }); const r = g.querySelector('input[role=switch]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }`)) as typeof switchBox
  Object.assign(switchBox, boxNow)
  await sleep(150)
  await clickSwitch()
  check('clicking the switch turns the copies off, and the two lists are disabled', await waitFor(() => state().settings.autoBackup === false) && ((await group(`return [...g.querySelectorAll('select')].every((s) => s.disabled)`)) as boolean))
  const countOff = copyIds().length
  browser.dispatch({ type: 'tab/open', url: `${base}/while-off`, background: true })
  check('with the copies off nothing is written at quit, and the panel says they are off but keeps the copies', (() => { const outcome = fresh.backUp('quit'); return outcome.ok && outcome.id === null })() && copyIds().length === countOff)
  await clickSwitch()
  check('clicking again turns them on', await waitFor(() => state().settings.autoBackup === true))
  if (settingsWindows()[0]) settingsWindows()[0]!.close()

  // ---- the panel when the copies are off ----
  browser.dispatch({ type: 'settings/update', patch: { autoBackup: false } })
  check('the panel says they are off and still lists the copies that exist', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && /désactivées/.test((await panelText('[data-role="backups-off"]')) ?? '') && (await backupRows()).length >= 1)
  browser.dispatch({ type: 'settings/update', patch: { autoBackup: true } })
  browser.closeOverlay()

  // ======================= the private window =======================
  const manager = getWindowManager()
  const opened = manager.openPrivate()
  try {
    const secret = `${base}/secret-private-tab`
    opened.browser.dispatch({ type: 'tab/open', url: secret })
    opened.browser.dispatch({ type: 'space/aside', id: opened.store.get().activeSpaceId })
    check('a private window cannot put its space aside (it has one, and keeps nothing)', opened.store.get().sessions.length === 0 && opened.store.get().spaces.length === 1)
    const wc = opened.win.webContents
    const copiesBefore = copyIds().length
    const listing = await run<{ enabled: boolean; entries: unknown[]; unreadable: number }>(wc, `window.lucium.sessionBackups()`)
    check('it lists no copy, whatever exists', listing.enabled === false && listing.entries.length === 0 && copyIds().length === copiesBefore)
    const mainTabs = JSON.stringify(state().tabs.map((t) => t.id))
    const refused = await run<{ ok: boolean }>(wc, `window.lucium.restoreBackup(${JSON.stringify(copyIds()[0])})`)
    check('it restores none, in its window or in the main one', refused.ok === false && JSON.stringify(state().tabs.map((t) => t.id)) === mainTabs && opened.store.get().tabs.length === 1 && opened.store.get().tabs[0]!.url === secret)
    const made = await run<{ ok: boolean }>(wc, `window.lucium.backUpNow()`)
    check('it makes none by hand either', made.ok === false && copyIds().length === copiesBefore)
    service.backUp('manual')
    const everything = copyIds().map((id) => readFileSync(join(copiesDir, `${id}.json`), 'utf8')).join('\n')
    check('and no copy anywhere holds a page of the private window', !everything.includes('secret-private-tab'))
    const questions = asked.length
    await run(wc, `window.lucium.asideSpace()`)
    // The witness: the request is a message without an answer; a question asked after it on the same channel is answered once the main process
    // has handled it.
    await run(wc, 'window.lucium.sessionBackups().then(() => 0)')
    check('asking from there to put a space aside asks nothing, says nothing and does nothing', asked.length === questions && opened.browser.snapshot().toast === null && opened.store.get().spaces.length === 1 && opened.store.get().sessions.length === 0 && state().sessions.length === originalSessions.length)
  } finally {
    opened.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()
  }

  // ======================= put everything back =======================
  browser.closeOverlay()
  box.showMessageBoxSync = realBox
  console.error = realError
  fresh.stop()
  service.stop()
  // The line before this suite left a state: spaces and tabs back to exactly what they were, the sessions and settings too.
  browser.dispatch({ type: 'backup/restore', copy: original })
  const originalFavoriteIds = new Set((JSON.parse(originalFavorites) as Array<{ id: string }>).map((f) => f.id))
  for (const favorite of state().favorites.filter((f) => !originalFavoriteIds.has(f.id))) browser.dispatch({ type: 'favorite/remove', id: favorite.id })
  for (const id of state().sessions.filter((s) => !originalSessions.includes(s.id)).map((s) => s.id)) browser.dispatch({ type: 'session/delete', id })
  browser.dispatch({ type: 'settings/update', patch: { autoBackup: originalSettings.autoBackup, autoBackupKeep: originalSettings.autoBackupKeep, autoBackupMinutes: originalSettings.autoBackupMinutes, linkRoutes: originalSettings.linkRoutes } })
  browser.dispatch({ type: 'space/select', id: startSpace })
  server.closeAllConnections()
  server.close()
  rmSync(copiesDir, { recursive: true, force: true })
  check('the test left the state as it found it: spaces, tabs, favourites, sessions and the copies’ settings', JSON.stringify(state().spaces.map((s) => s.id)) === JSON.stringify(original.spaces.map((s) => s.id)) && JSON.stringify(state().tabs.map((t) => t.id)) === JSON.stringify(original.tabs.map((t) => t.id)) && JSON.stringify(state().favorites) === originalFavorites && JSON.stringify(state().sessions.map((s) => s.id)) === JSON.stringify(originalSessions) && existsSync(copiesDir) === false)
}

export async function runSessionsPlusSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    await smokeSessionsPlus(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (process.env['LUCIUM_SESSIONSPLUS_VERBOSE'] === '1') console.log(`SESSIONSPLUS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeSessionsPlus ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SESSIONSPLUS ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
