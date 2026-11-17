// Engine checks for the sessions of tabs (File › Sessions…, File › Enregistrer la session…), run inside a real Electron.
// The panel is driven the way a user drives it (real mouse and keys sent to the overlay page); a local server gives the pages real
// titles. Covered: saving (menu, field, Return, automatic name), the list, renaming and deleting, a restart of the state (the
// file written, read back by the loader), restoring into the current space, into a new space and from the command bar, the
// limits (100 sessions, 500 tabs), an address that is not a web page left out at restore, and the private window's refusals.
// Called from the engine smoke test: `await smokeSessions(ctx, check)`; `LUCIUM_SMOKE_ONLY=sessions` runs only this file.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Menu, app, type MenuItem, type WebContents } from 'electron'
import type { Session, SidebarState, TabItem } from '@shared/model'
import { SESSIONS_MAX, SESSION_TABS_MAX } from '@shared/sessions'
import { sidebarOrder } from '@shared/sidebar'
import { buildMenu, type MenuActions } from './shell/menu'
import { menuItems } from './shell/context-menus'
import { getWindowManager } from './shell/windows'
import { loadState, type StateStore } from './store'
import type { SmokeContext } from './smoke'
import { noteCheck, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'
import { anySpace } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 60)

export async function smokeSessions(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, overlayView } = ctx
  const ui = overlayView.webContents
  const state = (): SidebarState => store.get()
  // The window's store is a view of the shared one: this is the way to put in the state what the reducer would never build.
  const shared = (store as unknown as { shared: StateStore }).shared
  const run = <T>(wc: WebContents, js: string) => wc.executeJavaScript(js) as Promise<T>

  // ---- a local site: every page has a title of its own ----
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html')
    res.end(`<title>sessions ${req.url}</title><body>sessions ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- the application menu ----
  const menu = () => Menu.getApplicationMenu()!
  const itemsOf = (path: string): MenuItem[] => menu().items.find((m) => m.label === path)?.submenu?.items ?? []
  const choose = (...path: [string, string]) => {
    const item = itemsOf(path[0]).find((i) => i.label === path[1])
    if (!item || !item.enabled) throw new Error(`menu entry missing or greyed out: ${path.join(' › ')}`)
    item.click()
  }

  // ---- the panel, driven with real input ----
  const key = async (keyCode: string) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode })
    ui.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(80)
  }
  const typeText = async (text: string) => {
    for (const ch of text) {
      const keyCode = ch === ' ' ? 'Space' : ch
      ui.sendInputEvent({ type: 'keyDown', keyCode })
      ui.sendInputEvent({ type: 'char', keyCode: ch })
      ui.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(40)
    }
    await sleep(150)
  }
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) => ui.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  /** A real click on the first element matching `selector` (in the panel just opened) whose text contains `text`. */
  const click = async (selector: string, text = ''): Promise<boolean> => {
    const box = await run<{ x: number; y: number; w: number; h: number } | null>(
      ui,
      `(() => { const el = [...document.querySelectorAll('.sessions:not([data-stale]) ${selector}')].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`
    )
    if (!box) return false
    mouse('mouseMove', box.x + box.w / 2, box.y + box.h / 2)
    await sleep(30)
    mouse('mouseDown', box.x + box.w / 2, box.y + box.h / 2)
    mouse('mouseUp', box.x + box.w / 2, box.y + box.h / 2)
    await sleep(120)
    return true
  }
  const panelText = (selector: string) => run<string | null>(ui, `document.querySelector('.sessions:not([data-stale]) ${selector}')?.textContent ?? null`)
  const rowsOnScreen = () =>
    run<Array<{ id: string; name: string; meta: string }>>(
      ui,
      `[...document.querySelectorAll('.sessions:not([data-stale]) .sessions-row')].map((r) => ({ id: r.dataset.id, name: r.querySelector('.sessions-name')?.textContent ?? '', meta: r.querySelector('.sessions-meta')?.textContent ?? '' }))`
    )
  const fieldState = () =>
    run<{ focused: boolean; value: string; selected: number }>(
      ui,
      `(() => { const f = document.getElementById('sessions-name'); return { focused: document.activeElement === f, value: f?.value ?? '', selected: f ? f.selectionEnd - f.selectionStart : -1 } })()`
    )
  /** Opens the panel the way the caller does (a menu entry, a request) and waits for it to be there; a request sent while the overlay page still starts is asked again. */
  const open = async (opener: () => void): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await run(ui, `document.querySelectorAll('#root *').forEach((el) => el.setAttribute('data-stale', '1'))`)
      opener()
      if (await waitFor(async () => (await run<number>(ui, `document.querySelectorAll('.sessions:not([data-stale])').length`)) > 0, 2500)) {
        await sleep(150)
        return true
      }
    }
    return false
  }
  const urlsOf = (spaceId: string) => sidebarOrder(state(), spaceId).map((t) => t.url)
  const sessionNames = () => state().sessions.map((s) => s.name)

  const startSpace = state().activeSpaceId
  const startSessions = state().sessions.map((s) => s.id)
  const created: string[] = []

  // ---- a space with something to save: two Today tabs, a pinned one and a pinned one in a folder ----
  browser.dispatch({ type: 'space/create', name: 'Sessions ISO', emoji: '🗂', hue: 200 })
  const source = state().activeSpaceId
  created.push(source)
  const openLoaded = async (path: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const id = state().tabs.at(-1)!.id
    await waitFor(() => state().tabs.find((t) => t.id === id)?.title === `sessions ${path}`, 12_000)
    return id
  }
  const tabA = await openLoaded('/a')
  const tabB = await openLoaded('/b')
  const tabPin = await openLoaded('/pin')
  const tabDoc = await openLoaded('/doc')
  browser.dispatch({ type: 'tab/pin', id: tabPin })
  browser.dispatch({ type: 'folder/create-with', tabIds: [tabDoc], name: 'Docs' })
  const expectedPages = [`${base}/pin`, `${base}/doc`, `${base}/a`, `${base}/b`]
  check('the test space holds the four pages the session will keep, in the sidebar order', JSON.stringify(urlsOf(source)) === JSON.stringify(expectedPages), JSON.stringify(urlsOf(source)))

  // ======================= the menu entries =======================
  const file = itemsOf('Fichier').map((i) => i.label || '——')
  const at = (label: string) => file.indexOf(label)
  check(
    'File has "Sessions…" and "Enregistrer la session…" after "Nouveau profil" and before "Fermer la fenêtre", between separators',
    at('Nouveau profil…') >= 0 && file[at('Nouveau profil…') + 1] === '——' && file[at('Nouveau profil…') + 2] === 'Sessions…' && file[at('Nouveau profil…') + 3] === 'Enregistrer la session…' && file[at('Nouveau profil…') + 4] === '——' && file[at('Nouveau profil…') + 5] === 'Fermer la fenêtre',
    file.join(' | ')
  )
  check('both entries are on and have no shortcut of their own (Arc has none)', ['Sessions…', 'Enregistrer la session…'].every((label) => { const item = itemsOf('Fichier').find((i) => i.label === label); return item?.enabled === true && !item.accelerator }))

  // ======================= saving =======================
  check('"Enregistrer la session…" opens the panel', await open(() => choose('Fichier', 'Enregistrer la session…')) && browser.currentPanel() === 'sessions')
  const field = await fieldState()
  check('the name field has the focus, starts with the automatic name and has it selected, so that typing replaces it', field.focused && /^Session du \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(field.value) && field.selected === field.value.length, JSON.stringify(field))
  check('the panel says what will be saved: the four tabs of the space', anySpace(/4 onglets de l’espace « Sessions ISO » seront enregistrés/).test((await panelText('[data-role="hint"]')) ?? ''), String(await panelText('[data-role="hint"]')))
  await typeText('Projet X')
  check('typing replaces the automatic name', (await fieldState()).value === 'Projet X', JSON.stringify(await fieldState()))
  await key('Return')
  check('Return saves the session, under the name typed', await waitFor(() => sessionNames()[0] === 'Projet X'), sessionNames().join(' | '))
  const projet = state().sessions[0] as Session
  check(
    'it keeps the four pages in order, with titles, the pinned ones pinned and the folder by name',
    JSON.stringify(projet?.tabs) ===
      JSON.stringify([
        { url: `${base}/pin`, title: 'sessions /pin', pinned: true },
        { url: `${base}/doc`, title: 'sessions /doc', pinned: true, folder: 'Docs' },
        { url: `${base}/a`, title: 'sessions /a' },
        { url: `${base}/b`, title: 'sessions /b' }
      ]),
    JSON.stringify(projet?.tabs)
  )
  check('saving closes nothing and moves nothing', JSON.stringify(urlsOf(source)) === JSON.stringify(expectedPages))
  check('the list shows the session with its count and "à l’instant"', await waitFor(async () => (await rowsOnScreen()).some((r) => r.name === 'Projet X' && /^4 onglets · à l’instant$/.test(r.meta))), JSON.stringify(await rowsOnScreen()))
  check('and a confirmation under the field', /Session enregistrée \(4 onglets\)/.test((await panelText('[data-role="saved"]')) ?? ''))
  check('the field is empty again', (await fieldState()).value === '')

  // A blank name: the automatic one (the Toolkit's "Session du …"), by Return alone.
  check('"Sessions…" opens the same panel', await open(() => choose('Fichier', 'Sessions…')) && browser.currentPanel() === 'sessions')
  const empty = await fieldState()
  check('opened that way the field is empty and has the focus', empty.focused && empty.value === '', JSON.stringify(empty))
  await key('Return')
  check('Return on a blank field saves under the automatic name', await waitFor(() => state().sessions.length === startSessions.length + 2) && /^Session du \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(sessionNames()[0] ?? ''), sessionNames().join(' | '))
  created.push(state().sessions[0]!.id)

  // ======================= renaming =======================
  const autoId = state().sessions[0]!.id
  check('"Renommer" turns the name into a field, selected', (await click(`.sessions-row[data-id="${autoId}"] [data-action="rename"]`)) && (await waitFor(async () => (await run<boolean>(ui, `document.activeElement?.classList.contains('sessions-rename') === true`)))))
  await typeText('Veille tech')
  await key('Return')
  check('Return renames the session', await waitFor(() => state().sessions.find((s) => s.id === autoId)?.name === 'Veille tech'), sessionNames().join(' | '))
  check('and the list shows the new name', await waitFor(async () => (await rowsOnScreen()).some((r) => r.id === autoId && r.name === 'Veille tech')))
  await click(`.sessions-row[data-id="${autoId}"] [data-action="rename"]`)
  await waitFor(async () => run<boolean>(ui, `document.activeElement?.classList.contains('sessions-rename') === true`))
  await typeText('Autre')
  await key('Escape')
  check('Escape cancels the rename and leaves the panel open', browser.currentPanel() === 'sessions' && state().sessions.find((s) => s.id === autoId)?.name === 'Veille tech' && (await rowsOnScreen()).some((r) => r.id === autoId && r.name === 'Veille tech'))
  await click(`.sessions-row[data-id="${autoId}"] [data-action="rename"]`)
  await waitFor(async () => run<boolean>(ui, `document.activeElement?.classList.contains('sessions-rename') === true`))
  await key('Backspace')
  await key('Return')
  check('a blank name keeps the old one', state().sessions.find((s) => s.id === autoId)?.name === 'Veille tech')

  // ======================= a restart of the state =======================
  const statePath = join(app.getPath('userData'), 'state.json')
  const written = store.flush()
  const reloaded = loadState(statePath)
  check('the state is written and read back by the loader with the same sessions', written && JSON.stringify(reloaded.sessions) === JSON.stringify(state().sessions), `${written} ${JSON.stringify(reloaded.sessions).slice(0, 200)}`)
  // A file edited by hand: the pages that are not web pages do not survive the loader.
  const folder = mkdtempSync(join(tmpdir(), 'lucium-sessions-'))
  try {
    const hostile = { id: 'h', name: 'Piégée', createdAt: 1, tabs: [{ url: 'javascript:window.__pwn=1', title: 'x' }, { url: `${base}/ok`, title: 'ok' }, { url: 'data:text/html,<script>1</script>', title: 'x' }] }
    const file = join(folder, 'state.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), sessions: [hostile] }))
    const fromFile = loadState(file).sessions
    check('a file whose session holds a script address loads without it', fromFile.length === 1 && JSON.stringify(fromFile[0]!.tabs) === JSON.stringify([{ url: `${base}/ok`, title: 'ok' }]), JSON.stringify(fromFile))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }

  // ======================= restoring: into the current space =======================
  browser.dispatch({ type: 'space/create', name: 'Sessions cible', emoji: '🎯', hue: 20 })
  const target = state().activeSpaceId
  created.push(target)
  check('a panel opened in the target space lists both sessions', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && (await rowsOnScreen()).length >= 2)
  check('"Restaurer" opens the pages in the current space and closes the panel', (await click(`.sessions-row[data-id="${projet.id}"] [data-action="restore"]`)) && (await waitFor(() => urlsOf(target).length === 4)) && (await waitFor(() => browser.currentPanel() === null)), JSON.stringify(urlsOf(target)))
  check('in order, as they were', JSON.stringify(urlsOf(target)) === JSON.stringify(expectedPages), JSON.stringify(urlsOf(target)))
  const restored = sidebarOrder(state(), target)
  const docs = state().folders.find((f) => f.spaceId === target && f.name === 'Docs')
  check(
    'the pinned pages are pinned again on their own address, the folder is back and holds its page',
    restored.filter((t) => t.pinned).length === 2 && restored.every((t) => (t.pinned ? t.anchorUrl === t.url : t.anchorUrl === undefined)) && docs !== undefined && restored.find((t) => t.url === `${base}/doc`)?.folderId === docs.id,
    JSON.stringify(restored.map((t) => [t.url, t.pinned, t.folderId])))
  check('the titles come back with the pages', restored.map((t) => t.title).join('|') === 'sessions /pin|sessions /doc|sessions /a|sessions /b', restored.map((t) => t.title).join('|'))
  check('the first page is shown, since the space had none', state().activeTabBySpace[target] === restored[0]!.id)
  check('the notice says how many tabs came back', await waitFor(() => browser.snapshot().toast?.message === frenchSpaces('Session restaurée : 4 onglets')), String(browser.snapshot().toast?.message))
  check('the other space did not change', JSON.stringify(urlsOf(source)) === JSON.stringify(expectedPages))
  check('the session itself is still there', state().sessions.some((s) => s.id === projet.id))
  const restoredB = restored.find((t) => t.url === `${base}/b`) as TabItem
  browser.dispatch({ type: 'tab/select', id: restoredB.id })
  check('a restored tab loads its page when it is shown', (await waitFor(() => browser.livePageIds().includes(restoredB.id))) && (await waitFor(async () => (await browser.evaluateInPage('location.href')) === `${base}/b`)))
  const sleeping = restored.filter((t) => t.id !== restoredB.id && t.id !== restored[0]!.id && !browser.livePageIds().includes(t.id))
  check('and the others stay asleep until they are shown (restoring does not load every page)', sleeping.length >= 2, sleeping.length + ' asleep')

  // ======================= restoring: into a new space =======================
  const spacesBefore = state().spaces.length
  check('the panel offers to restore in a new space', await open(() => browser.openOverlay({ panel: 'sessions' })))
  check('ticking it and restoring opens a space named after the session', (await click('.sessions-target')) && (await click(`.sessions-row[data-id="${autoId}"] [data-action="restore"]`)) && (await waitFor(() => state().spaces.length === spacesBefore + 1)), String(state().spaces.length))
  const fresh = state().spaces.at(-1)!
  created.push(fresh.id)
  check('it is the space on screen, with the same profile, holding the four pages', fresh.name === 'Veille tech' && state().activeSpaceId === fresh.id && fresh.profileId === state().spaces.find((s) => s.id === target)!.profileId && JSON.stringify(urlsOf(fresh.id)) === JSON.stringify(expectedPages), `${fresh.name} ${JSON.stringify(urlsOf(fresh.id))}`)
  check('and shows its first page', state().activeTabBySpace[fresh.id] === sidebarOrder(state(), fresh.id)[0]?.id)
  check('the space it was made from is untouched', JSON.stringify(urlsOf(target)) === JSON.stringify(expectedPages))

  // ======================= the command bar =======================
  browser.dispatch({ type: 'space/select', id: target })
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
    await sleep(400)
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
  const noSuggestions = state().settings.searchSuggestions
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: false } })
  await openBar('projet')
  const projetRows = await barRows()
  check('typing a session name offers "Restaurer la session <nom>"', projetRows.some((r) => r.label === 'Restaurer la session Projet X'), JSON.stringify(projetRows))
  const beforeBar = urlsOf(target).length
  check('Return on it restores the pages in the current space', (await chooseRow('Restaurer la session Projet X')) && (await waitFor(() => urlsOf(target).length === beforeBar + 4)), String(urlsOf(target).length))
  check('without deduplicating: the pages already open are opened a second time, as the Toolkit does', urlsOf(target).filter((u) => u === `${base}/a`).length === 2)
  check('the bar closed', await waitFor(() => browser.currentPanel() === null))
  await openBar('enregistrer la session')
  check('typing "enregistrer la session" offers the command', (await barRows()).some((r) => r.label === 'Enregistrer la session'), JSON.stringify(await barRows()))
  await chooseRow('Enregistrer la session')
  check('which opens the panel with the automatic name', (await waitFor(() => browser.currentPanel() === 'sessions')) && (await waitFor(async () => /^Session du /.test((await fieldState()).value))))
  browser.closeOverlay()
  browser.dispatch({ type: 'settings/update', patch: { searchSuggestions: noSuggestions } })

  // ======================= deleting =======================
  check('a panel lists the sessions', await open(() => browser.openOverlay({ panel: 'sessions' })))
  const count = state().sessions.length
  const noticeText = () => panelText('.lp-undo')
  const focusedRow = () => run<string | null>(ui, `document.activeElement?.classList.contains('lp-main') ? document.activeElement.closest('.sessions-row')?.dataset.id ?? null : null`)
  // The arrows: from the name field down the sessions, and back.
  const onScreen = (await rowsOnScreen()).map((r) => r.id)
  await click('#sessions-name')
  await key('Down')
  const first = await focusedRow()
  await key('Down')
  const second = await focusedRow()
  await key('Up')
  check('↓ goes from the name field to the first session, then to the next, and ↑ comes back', onScreen.length >= 2 && first === onScreen[0] && second === onScreen[1] && (await focusedRow()) === onScreen[0], `${first} ${second} ${JSON.stringify(onScreen)}`)
  await click(`.sessions-row[data-id="${autoId}"] [data-action="delete"]`)
  check('"Supprimer" takes the row away at once and offers "Annuler"; nothing is deleted yet', (await waitFor(async () => !(await rowsOnScreen()).some((r) => r.id === autoId))) && /Annuler/.test((await noticeText()) ?? '') && state().sessions.length === count, String(await noticeText()))
  // ⌘Z, from a row (in the name field it takes back what was typed).
  await run(ui, `document.querySelector('.sessions:not([data-stale]) .sessions-row .lp-main')?.focus()`)
  ui.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['meta'] })
  ui.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['meta'] })
  check('⌘Z brings the session back and the notice goes', (await waitFor(async () => (await rowsOnScreen()).some((r) => r.id === autoId))) && (await noticeText()) === null && state().sessions.length === count)
  await click(`.sessions-row[data-id="${autoId}"] [data-action="delete"]`)
  await waitFor(async () => !(await rowsOnScreen()).some((r) => r.id === autoId))
  check('"Annuler" in the notice brings it back too', (await click('.lp-undo .tk-btn')) && (await waitFor(async () => (await rowsOnScreen()).some((r) => r.id === autoId))) && state().sessions.length === count)
  await click(`.sessions-row[data-id="${autoId}"] [data-action="delete"]`)
  await waitFor(async () => !(await rowsOnScreen()).some((r) => r.id === autoId))
  const waiting = state().sessions.length === count
  // Leaving the panel makes the deletion that was waiting.
  browser.closeOverlay()
  check('left without taking it back, the session is deleted, and only it', waiting && (await waitFor(() => state().sessions.length === count - 1)) && !state().sessions.some((s) => s.id === autoId) && state().sessions.some((s) => s.id === projet.id), sessionNames().join(' | '))
  check('a panel opened again no longer lists it', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && !(await rowsOnScreen()).some((r) => r.id === autoId))
  check('the tabs of the session were not touched', JSON.stringify(urlsOf(source)) === JSON.stringify(expectedPages))

  // ======================= an address that is not a web page, at restore =======================
  const hostileSession: Session = {
    id: 'smoke-hostile',
    name: 'Piégée',
    createdAt: 1,
    tabs: [
      { url: 'javascript:window.__pwn=1', title: 'x' },
      { url: `${base}/ok`, title: 'ok' },
      { url: 'data:text/html,<script>window.__pwn=1</script>', title: 'x' },
      { url: `chrome-extension://${'a'.repeat(32)}/options.html`, title: 'x' },
      { url: 'about:blank', title: 'x' }
    ]
  }
  // Put in the state by hand, past the loader: only the restore itself can stop these.
  shared.replace({ ...state(), sessions: [hostileSession, ...state().sessions] })
  created.push('smoke-hostile')
  browser.dispatch({ type: 'space/select', id: target })
  const openBefore = state().tabs.length
  browser.dispatch({ type: 'session/restore', id: 'smoke-hostile' })
  const added = state().tabs.slice(openBefore)
  check('restoring a session that holds script, data, extension and blank addresses opens only the web page', added.length === 1 && added[0]!.url === `${base}/ok`, JSON.stringify(added.map((t) => t.url)))
  // Only what this restore added: the suites that ran before leave tabs of their own (error pages, view-source…) in the same state.
  check('no tab the restore added holds an address that is not a web page', added.every((t) => /^(https?|file):/.test(t.url) || t.url === 'about:blank') && !added.some((t) => /^(javascript|data):/.test(t.url)))
  const good = added.find((t) => t.url === `${base}/ok`)
  if (good) {
    browser.dispatch({ type: 'tab/select', id: good.id })
    await waitFor(() => browser.livePageIds().includes(good.id))
  }
  check('nothing ran: the page that was restored did not see a script', (await browser.evaluateInPage('typeof window.__pwn')) === 'undefined')

  // ======================= the limits =======================
  const filler = state().sessions.length
  browser.dispatch({ type: 'space/select', id: source })
  for (let i = filler; i < SESSIONS_MAX; i++) browser.dispatch({ type: 'session/save', name: `Remplissage ${i}` })
  check(`${SESSIONS_MAX} sessions can be kept`, state().sessions.length === SESSIONS_MAX, String(state().sessions.length))
  browser.dispatch({ type: 'session/save', name: 'de trop' })
  check('the next one is refused, and none of the saved ones is pushed out', state().sessions.length === SESSIONS_MAX && !sessionNames().includes('de trop') && state().sessions.some((s) => s.id === projet.id))
  check('the panel says so and its button is off', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && /Limite de 100 sessions atteinte/.test((await panelText('[data-role="hint"]')) ?? '') && (await run<boolean>(ui, `document.querySelector('.sessions:not([data-stale]) [data-action="save"]').disabled`)))
  await click('#sessions-name')
  await typeText('encore')
  await key('Return')
  check('and Return in the field saves nothing, and claims nothing', state().sessions.length === SESSIONS_MAX && !sessionNames().includes('encore') && (await panelText('[data-role="saved"]')) === null)
  browser.closeOverlay()
  for (const s of state().sessions.filter((x) => x.name.startsWith('Remplissage '))) browser.dispatch({ type: 'session/delete', id: s.id })
  check('deleting makes room again', state().sessions.length < SESSIONS_MAX)

  browser.dispatch({ type: 'space/create', name: 'Sessions vide', emoji: '⬜', hue: 10 })
  created.push(state().activeSpaceId)
  const kept0 = state().sessions.length
  check('a space with no tab: the panel says there is nothing to keep and its button is off', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && /Aucun onglet à enregistrer/.test((await panelText('[data-role="hint"]')) ?? '') && (await run<boolean>(ui, `document.querySelector('.sessions:not([data-stale]) [data-action="save"]').disabled`)))
  await click('#sessions-name')
  await key('Return')
  check('and Return saves nothing there, and claims nothing', state().sessions.length === kept0 && (await panelText('[data-role="saved"]')) === null)
  browser.closeOverlay()

  browser.dispatch({ type: 'space/create', name: 'Sessions gros', emoji: '📚', hue: 300 })
  const big = state().activeSpaceId
  created.push(big)
  const bulk: TabItem[] = Array.from({ length: SESSION_TABS_MAX + 25 }, (_, i) => ({ id: `smoke-bulk-${i}`, spaceId: big, url: `${base}/bulk/${i}`, title: `Page ${i}`, pinned: false, createdAt: 1, lastActiveAt: 1 }))
  shared.replace({ ...state(), tabs: [...state().tabs, ...bulk] })
  check('a space of more than 500 tabs: the panel says only the first 500 are kept', (await open(() => browser.openOverlay({ panel: 'sessions' }))) && new RegExp(`Seuls les ${SESSION_TABS_MAX} premiers sont gardés`).test((await panelText('[data-role="hint"]')) ?? ''), String(await panelText('[data-role="hint"]')))
  await click('[data-action="save"]')
  check('and the session keeps exactly 500, the first ones', await waitFor(() => state().sessions[0]?.tabs.length === SESSION_TABS_MAX), String(state().sessions[0]?.tabs.length))
  const kept = state().sessions[0]!
  check('the 500 are the first 500 of the sidebar', kept.tabs[0]!.url === `${base}/bulk/0` && kept.tabs.at(-1)!.url === `${base}/bulk/${SESSION_TABS_MAX - 1}`)
  created.push(kept.id)
  browser.closeOverlay()

  // ======================= a multiple selection =======================
  browser.dispatch({ type: 'space/select', id: source })
  const group = [tabB, tabA]
  check('the panel opened for a selection says so', (await open(() => browser.openOverlay({ panel: 'sessions', focus: 'save', tabIds: group }))) && /2 onglets sélectionnés seront enregistrés/.test((await panelText('[data-role="hint"]')) ?? ''), String(await panelText('[data-role="hint"]')))
  await typeText('Sélection')
  await key('Return')
  const selected = await waitFor(() => state().sessions[0]?.name === 'Sélection')
  check('only the selected tabs are saved, in the sidebar order', selected && JSON.stringify(state().sessions[0]!.tabs.map((t) => t.url)) === JSON.stringify([`${base}/a`, `${base}/b`]), JSON.stringify(state().sessions[0]?.tabs.map((t) => t.url)))
  created.push(state().sessions[0]!.id)
  browser.closeOverlay()
  const groupMenu = menuItems({ kind: 'tab', id: tabA, selection: group }, browser, store, ctx.win).map((i) => i.label ?? '——')
  check('the menu of a multiple selection offers "Enregistrer comme session…"', groupMenu.includes('Enregistrer comme session…'), groupMenu.join(' | '))

  // ======================= the panel's request is checked =======================
  const bad = async (request: string) => {
    browser.closeOverlay()
    await run(ui, `window.lucium.openOverlay(${request})`)
    await sleep(250)
    return browser.currentPanel()
  }
  check(
    'a request for the panel with a focus or a selection of the wrong kind is refused',
    (await bad(`{ panel: 'sessions', focus: 'x' }`)) === null && (await bad(`{ panel: 'sessions', tabIds: [5] }`)) === null && (await bad(`{ panel: 'sessions', tabIds: 'a' }`)) === null,
    String(browser.currentPanel())
  )
  check('while the plain request is let through', (await bad(`{ panel: 'sessions' }`)) === 'sessions')
  browser.closeOverlay()

  // ======================= the private window =======================
  const manager = getWindowManager()
  const opened = manager.openPrivate()
  try {
    const sessionsBefore = state().sessions.length
    opened.browser.dispatch({ type: 'tab/open', url: `${base}/secret` })
    opened.browser.dispatch({ type: 'tab/open', url: `${base}/secret-2` })
    opened.browser.dispatch({ type: 'session/save', name: 'privée' })
    check('a private window saves no session, in its own state or in the main one', opened.store.get().sessions.length === 0 && state().sessions.length === sessionsBefore && !sessionNames().includes('privée'))
    opened.browser.dispatch({ type: 'session/restore', id: projet.id })
    check('and restores none of the main window’s', opened.store.get().sessions.length === 0 && opened.store.get().tabs.length === 2)
    opened.browser.dispatch({ type: 'session/delete', id: projet.id })
    check('nor deletes one', state().sessions.some((s) => s.id === projet.id))
    opened.browser.openOverlay({ panel: 'sessions' })
    check('the panel does not open there', opened.browser.currentPanel() === null)
    const [privateA, privateB] = opened.store.get().tabs.map((t) => t.id)
    const privateMenu = menuItems({ kind: 'tab', id: privateA!, selection: [privateA!, privateB!] }, opened.browser, opened.store, opened.win).map((i) => i.label ?? '——')
    check('the menu of a selection of two tabs there does not offer to save a session (it does offer the other group entries)', privateMenu.includes('Copier les liens en Markdown') && !privateMenu.includes('Enregistrer comme session…'), privateMenu.join(' | '))
    const stub = new Proxy({} as MenuActions, { get: (_target, name) => (name === 'sessionStart' ? 0 : name === 'extensions' ? () => [] : () => false) })
    const privateBar = buildMenu(opened.browser, opened.store, stub, { private: true })
    const privateFile = privateBar.items.find((m) => m.label === 'Fichier')!.submenu!.items
    check('and the File entries are greyed out', ['Sessions…', 'Enregistrer la session…'].every((label) => privateFile.find((i) => i.label === label)?.enabled === false))
  } finally {
    opened.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()
  }

  // ---- put everything back ----
  browser.closeOverlay()
  for (const id of created) {
    if (state().sessions.some((s) => s.id === id)) browser.dispatch({ type: 'session/delete', id })
    if (state().spaces.some((s) => s.id === id)) browser.dispatch({ type: 'space/delete', id })
  }
  for (const s of state().sessions.filter((x) => !startSessions.includes(x.id))) browser.dispatch({ type: 'session/delete', id: s.id })
  browser.dispatch({ type: 'space/select', id: startSpace })
  server.closeAllConnections()
  server.close()
  check('the sessions of the test were all removed', JSON.stringify(state().sessions.map((s) => s.id)) === JSON.stringify(startSessions))
}

export async function runSessionsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    await smokeSessions(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (process.env['LUCIUM_SESSIONS_VERBOSE'] === '1') console.log(`SESSIONS ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeSessions ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SESSIONS ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
