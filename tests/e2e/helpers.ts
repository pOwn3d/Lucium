// Helpers shared by the end-to-end tests: the application menu (clicked the way the user chooses an entry), the windows, the bridge the
// interface uses (`window.lucium`: the snapshot of the state and the actions), the state file of the data folder, and local pages.
// Nothing here reaches the Internet: the pages are served by a server of the test on 127.0.0.1.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { effectiveAccelerator } from '../../src/shared/keybindings'
import { screenOf, type PanelSizes, type ScreenInfo } from '../../src/shared/panel-scale'
import { platformOf } from '../../src/shared/platform'

/** The part of the state the tests read (the fields of `SidebarState`, `TabItem`, `Space`… of src/shared/model.ts). */
export interface TabSnapshot {
  id: string
  spaceId: string
  url: string
  title: string
  customTitle?: string
  pinned: boolean
  folderId?: string
  private?: boolean
}

export interface Snapshot {
  state: {
    activeSpaceId: string
    spaces: Array<{ id: string; name: string; emoji: string }>
    tabs: TabSnapshot[]
    folders: Array<{ id: string; name: string; spaceId: string; atBottom?: true; atTodayStart?: true }>
    archive: Array<{ id: string; url: string; title: string; spaceId: string }>
    favorites: Array<{ id: string; url: string; title: string }>
    bookmarks: Array<{ id: string; url: string; title: string }>
    readLater: Array<{ id: string; url: string; title: string }>
    splits: Array<{ id: string }>
    sessions: Array<{ id: string; name: string }>
    settings: { blockModeSites: Record<string, string>; [key: string]: unknown }
  }
}

/** The bridge of the interface, as the preload exposes it in each window (preload/index.ts). */
interface Bridge {
  lucium: {
    getSnapshot(): Promise<Snapshot>
    dispatch(action: Record<string, unknown>): Promise<void>
    searchHistory(query: string, limit?: number): Promise<Array<{ title: string; url: string }>>
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- the menu ----------

/**
 * The default shortcut of a command on the system the test runs on, as the menu carries it: the defaults differ by system (src/shared/platform.ts:
 * Windows adds Shift to the Ctrl+Alt+letter ones, which are AltGr there), so a test that picks an entry by its default asks for it here instead of
 * writing the macOS spelling.
 */
export function defaultShortcut(commandId: string): string {
  const accelerator = effectiveAccelerator(commandId, undefined, platformOf(process.platform))
  if (!accelerator) throw new Error(`${commandId} has no default shortcut on ${process.platform}`)
  return accelerator
}

/**
 * Chooses the entry of the application menu that has this accelerator (written as in src/shared/keybindings.ts, for example `CmdOrCtrl+T`), as
 * a click of the user does. The keys themselves are not sent: a synthesized key does not reach the menu of the system on macOS.
 * An entry that is found but disabled is looked at again for three seconds: the menu is rebuilt after the state that enables it (an archived tab for ⇧⌘T)
 * has changed, which a slower machine (a Windows runner) shows between the two.
 */
export async function chooseMenuEntry(app: ElectronApplication, accelerator: string): Promise<void> {
  const attempt = () => app.evaluate(({ Menu }, wanted: string) => {
    const norm = (text: string) => text.replace(/cmdorctrl|commandorcontrol|command|cmd/gi, 'mod').replace(/option/gi, 'alt').replace(/control/gi, 'ctrl').replace(/\s+/g, '').toLowerCase()
    type Entry = { accelerator?: string; enabled: boolean; click: () => void; submenu?: { items: Entry[] } }
    // The same accelerator can be written on several entries (one of them only a copy kept for a context menu): the first enabled one is chosen.
    const matches = (entries: Entry[]): Entry[] =>
      entries.flatMap((entry) => [...(entry.accelerator && norm(entry.accelerator) === norm(wanted) ? [entry] : []), ...(entry.submenu ? matches(entry.submenu.items) : [])])
    const found = matches((Menu.getApplicationMenu()?.items ?? []) as unknown as Entry[])
    if (found.length === 0) return 'missing'
    const entry = found.find((candidate) => candidate.enabled)
    if (!entry) return 'disabled'
    entry.click()
    return 'ok'
  }, accelerator)
  let outcome = await attempt()
  for (const deadline = Date.now() + 3000; outcome === 'disabled' && Date.now() < deadline; ) {
    await sleep(100)
    outcome = await attempt()
  }
  expect(outcome, `application menu entry ${accelerator}`).toBe('ok')
}

/** The accelerators of every entry of the application menu that has one (as Electron reports them). */
export async function menuAccelerators(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    type Entry = { accelerator?: string; submenu?: { items: Entry[] } }
    const collect = (entries: Entry[]): string[] => entries.flatMap((entry) => [...(entry.accelerator ? [entry.accelerator] : []), ...(entry.submenu ? collect(entry.submenu.items) : [])])
    return collect((Menu.getApplicationMenu()?.items ?? []) as unknown as Entry[])
  })
}

// ---------- windows ----------

/** The first window whose address matches, once it exists (windows are made asynchronously). */
export async function waitForWindow(app: ElectronApplication, match: (url: string) => boolean, timeoutMs = 15_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = app.windows().find((page) => match(page.url()))
    if (found) return found
    if (Date.now() > deadline) throw new Error('no window matched in time')
    await sleep(100)
  }
}

/**
 * The address of the page of the Settings window (`…/out/renderer/settings.html`, then `#page/subpage` once it shows one). The file name is what is
 * matched, not the word « settings » anywhere in the address: the folder a run happens in is part of every address (`file:///…/out/renderer/index.html`),
 * and a folder called `settings-…` (a worktree of the work on the Settings) made the interface itself pass for the Settings window.
 */
export const SETTINGS_WINDOW_URL = /\/settings\.html(?:[?#]|$)/

/** Whether the address of a window is the Settings window's. */
export const isSettingsWindowUrl = (url: string): boolean => SETTINGS_WINDOW_URL.test(url)

/** Opens the Settings window with its menu entry (⌘,) and returns its page once the categories are drawn. */
export async function openSettings(app: ElectronApplication): Promise<Page> {
  await chooseMenuEntry(app, 'CmdOrCtrl+,')
  const settings = await waitForWindow(app, isSettingsWindowUrl)
  await settings.locator('.settings-cat').first().waitFor()
  return settings
}

/** The pages of the Settings window, in the order of its sidebar (src/shared/ipc.ts, SETTINGS_PAGES). */
export const SETTINGS_PAGE_IDS = ['home', 'appearance', 'tabs', 'navigation', 'protection', 'files', 'tools', 'keyboard', 'profiles', 'features', 'about'] as const

/**
 * Goes to a page of the Settings by its entry in the sidebar, as the user does, and waits until the page is the one shown (its entry says so). The click
 * changes the address of the window and the page is drawn a moment after, not with the click: what a test reads or clicks right after it would be on the
 * page that was there before.
 */
export async function openSettingsPage(settings: Page, id: (typeof SETTINGS_PAGE_IDS)[number]): Promise<void> {
  await settings.locator(`.settings-cat[data-cat="${id}"]`).click()
  await expect(settings.locator(`.settings-cat[data-cat="${id}"]`)).toHaveAttribute('aria-current', 'page')
}

/**
 * Opens « Plus de réglages » of the page of the Settings shown, so that every row of the page is drawn (the window keeps it open while it stays open).
 * A page that holds nothing more has no fold to open.
 */
export async function openMoreSettings(settings: Page): Promise<void> {
  await settings.evaluate(() => {
    const toggle = document.querySelector<HTMLButtonElement>('main.settings-content .more-settings-toggle[aria-expanded="false"]')
    if (toggle && !toggle.closest('[data-empty]')) toggle.click()
  })
  await expect(settings.locator('main.settings-content .more-settings:not([data-empty]) .more-settings-toggle[aria-expanded="false"]')).toHaveCount(0)
}

/** The subpages whose row the page of the Settings shown draws (src/shared/settings-subpages.ts), by their name: the lists and the editors. */
export async function subpagesOf(settings: Page): Promise<string[]> {
  return settings.locator('main.settings-content [data-subpage-entry]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-subpage-entry') ?? '').filter(Boolean))
}

/** Opens a subpage of the page shown by its row, as the user does, and waits for what it holds. */
export async function openSubpage(settings: Page, id: string): Promise<void> {
  await settings.locator(`main.settings-content [data-subpage-entry="${id}"] button`).click()
  await settings.locator(`main.settings-content [data-subpage="${id}"]`).first().waitFor()
}

/** Goes back from a subpage to its page by its way back. */
export async function leaveSubpage(settings: Page): Promise<void> {
  await settings.locator('main.settings-content .subpage-back').click()
  await expect(settings.locator('main.settings-content .subpage-back')).toHaveCount(0)
}

/**
 * Sets the size of the windows and panels to 100 % on every screen of the machine, as Settings › Apparence › Taille des fenêtres et des panneaux does.
 * The default, « Automatique », sizes them by the screen the run happens to be on: a window of its own (Réglages) is then zoomed and made larger, so a
 * picture of it depends on that screen, and Playwright, which measures the page in CSS pixels, captures only its top-left part when the zoom is above 100 %.
 */
export async function pinPanelSize(app: ElectronApplication, page: Page): Promise<void> {
  const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map((display) => ({ label: display.label, internal: display.internal, scaleFactor: display.scaleFactor, size: display.size })))
  const screens = displays.map(screenOf).filter((info): info is ScreenInfo => info !== null)
  expect(screens.length, 'the screens of the machine, as Lucium knows them').toBeGreaterThan(0)
  for (const info of screens) {
    await dispatch(page, { type: 'panel-size/set', screen: { label: info.label, internal: info.internal, width: info.width, height: info.height, scaleFactor: info.scaleFactor }, percent: 100 })
  }
  await waitForState(page, (s) => screens.every((info) => (s.state.settings['panelSizes'] as PanelSizes)[info.key]?.percent === 100), 'the panels at 100 % on every screen')
}

// ---------- the bridge of the interface ----------

/** The state the interface holds, as the main process last sent it. */
export async function snapshotOf(page: Page): Promise<Snapshot> {
  return page.evaluate(() => (globalThis as unknown as Bridge).lucium.getSnapshot())
}

/** Asks the main process to do what an action says, the way the interface does. */
export async function dispatch(page: Page, action: Record<string, unknown>): Promise<void> {
  await page.evaluate((sent) => (globalThis as unknown as Bridge).lucium.dispatch(sent), action)
}

/** The tab with this address (the first one), or undefined. */
export function tabAt(snapshot: Snapshot, url: string): TabSnapshot | undefined {
  return snapshot.state.tabs.find((tab) => tab.url === url)
}

/** The titles of the history entries that match the query (what the history search of the command bar finds). */
export async function searchHistoryTitles(page: Page, query: string): Promise<string[]> {
  const entries = await page.evaluate((text) => (globalThis as unknown as Bridge).lucium.searchHistory(text, 50), query)
  return entries.map((entry) => entry.title)
}

/** The width of the window's content, in CSS pixels. */
export async function viewportWidth(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
}

/** Waits until the state satisfies `check`, and returns the state that does. */
export async function waitForState(page: Page, check: (snapshot: Snapshot) => boolean, what: string, timeoutMs = 10_000): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  let last = await snapshotOf(page)
  while (!check(last)) {
    if (Date.now() > deadline) throw new Error(`state did not change in time: ${what}`)
    await sleep(100)
    last = await snapshotOf(page)
  }
  return last
}

/**
 * A control where nothing must happen: `read` gives `expected` at every look for `forMs`, the last look once the time has passed. The first other
 * value fails the test at once and says when it was seen, so an effect that comes and goes within the time is caught too (a single look at the end
 * of a pause would miss it). Use it only when the application gives no sign that it is done with what it would have done; where it gives one, wait
 * for that sign instead.
 */
export async function expectStays<T>(read: () => T | Promise<T>, expected: T, what: string, forMs: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    const elapsed = Date.now() - started
    const seen: unknown = await read()
    expect(seen, `${what} (seen ${elapsed} ms after the action, watched for ${forMs} ms)`).toEqual(expected)
    if (elapsed >= forMs) return
    await sleep(Math.min(100, forMs - elapsed))
  }
}

// ---------- the state file ----------

/** Waits until the state file exists: the store creates it at its first save, a moment after the first change of the window. */
export async function waitForStateFile(dataDir: string): Promise<void> {
  const file = join(dataDir, 'state.json')
  await expect.poll(() => existsSync(file), { message: 'state.json written', timeout: 10_000 }).toBe(true)
}

/** The whole state file of the data folder, as the application wrote it. */
export function stateOnDisk(dataDir: string): Record<string, unknown> & { tabs: Array<Record<string, unknown>>; settings: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as ReturnType<typeof stateOnDisk>
}

/** Changes the state file of a data folder while the application is not running (to launch it again on a state it could have written). */
export function editStateOnDisk(dataDir: string, edit: (state: ReturnType<typeof stateOnDisk>) => void): void {
  const state = stateOnDisk(dataDir)
  edit(state)
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state))
}

/** The settings as the state file of the data folder holds them (the file the application writes, not the memory). */
export function settingsOnDisk(dataDir: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { settings?: Record<string, unknown> }
  return parsed.settings ?? {}
}

// ---------- local pages ----------

/** What the server answers for a path: a page (HTML), or a body of another type with headers of its own. */
export type Route = string | { body: string; type?: string; status?: number; headers?: Record<string, string> }

export interface LocalSite {
  /** `http://127.0.0.1:<port>`: the address of the test pages. */
  origin: string
  /** The port of the server: the test host names (`*.e2e.test`, see launch.ts) reach it too. */
  port: number
  /** The requests received, in order: the path (with its query; the whole address when the server is asked as a proxy) and the headers. */
  requests: Array<{ path: string; headers: IncomingMessage['headers'] }>
  /** Connections that did not speak HTTP (a TLS handshake: an attempt at https:// on the port of this http server). */
  tlsAttempts: number
  /** The hosts asked for with CONNECT (the server used as a proxy for https://): each one is refused. */
  connects: string[]
  close: () => Promise<void>
}

let testCertificate: { key: Buffer; cert: Buffer } | undefined

/**
 * A certificate for the test host names, made once with openssl (no network) and signed by nobody: the application accepts it only when launched
 * with `--ignore-certificate-errors` (see `launchLucium({ args })`), which only the tests that need a site in https:// pass.
 */
function certificateForTests(): { key: Buffer; cert: Buffer } {
  if (testCertificate) return testCertificate
  const dir = mkdtempSync(join(tmpdir(), 'lucium-e2e-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=e2e.test'], { stdio: 'ignore' })
    testCertificate = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
    return testCertificate
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Serves the pages of a test on 127.0.0.1. An unknown path gets a 404 page. The server also answers as a proxy (absolute addresses).
 * `secure`: the same in https:// (a certificate of the tests, see `certificateForTests`), for what accepts only https:// addresses.
 */
export async function serveSite(pages: Record<string, Route>, { secure = false } = {}): Promise<LocalSite> {
  const requests: LocalSite['requests'] = []
  const connects: string[] = []
  const answer = (request: IncomingMessage, response: ServerResponse) => {
    const raw = request.url ?? '/'
    // A proxy is asked for the whole address: the page is looked up by its path all the same.
    const path = (/^https?:\/\//i.test(raw) ? new URL(raw).pathname : raw.split('?')[0]) ?? '/'
    requests.push({ path: raw, headers: request.headers })
    const route = pages[path]
    const found = typeof route === 'string' ? { body: route } : route
    response.setHeader('content-type', found?.type ?? 'text/html; charset=utf-8')
    for (const [name, value] of Object.entries(found?.headers ?? {})) response.setHeader(name, value)
    response.statusCode = found === undefined ? 404 : (found.status ?? 200)
    response.end(found?.body ?? '<!doctype html><title>404</title>')
  }
  const server: Server = secure ? createSecureServer(certificateForTests(), answer) : createServer(answer)
  const site = { tlsAttempts: 0 }
  // A TLS handshake on the http port is not HTTP: Node reports it as a client error.
  server.on('clientError', (_error, socket) => {
    site.tlsAttempts++
    socket.destroy()
  })
  server.on('connect', (request, socket) => {
    connects.push(request.url ?? '')
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const origin = `${secure ? 'https' : 'http'}://127.0.0.1:${port}`
  return Object.assign(site, {
    origin,
    port,
    requests,
    connects,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  })
}

/** A minimal page with a title, for the tests that need a page to load. */
export function titledPage(title: string, body = '<p>Texte de test.</p>'): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`
}

/** The paths the server received that start with `prefix` (the query is part of the path), in order. */
export function pathsReceived(site: LocalSite, prefix: string): string[] {
  return site.requests.map((request) => request.path).filter((path) => path.startsWith(prefix))
}

// ---------- settings and the first launch ----------

/** Sets settings the way the Settings window does (the same action), and waits until the state has them. */
export async function setSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await dispatch(page, { type: 'settings/update', patch })
  await waitForState(page, (s) => Object.entries(patch).every(([key, value]) => JSON.stringify(s.state.settings[key]) === JSON.stringify(value)), `settings ${Object.keys(patch).join(', ')}`)
}

/**
 * A first launch greets the user with a sheet in the layer of the panels (WelcomeSheet). It comes a moment after the window: wait for it and
 * close it, so that what the test opens in that layer (the command bar, a panel) is not replaced by it.
 */
export async function dismissWelcome(app: ElectronApplication, page: Page): Promise<void> {
  const overlay = await overlayPage(app)
  await expect.poll(() => overlay.evaluate(() => document.querySelector('.card.welcome, .card.first-launch, .card.news') !== null), { message: 'the sheet of the first launch', timeout: 15_000 }).toBe(true)
  await page.evaluate(() => (globalThis as unknown as { lucium: { closeOverlay(): void } }).lucium.closeOverlay())
  await expect.poll(() => overlayShown(app), { message: 'the sheet of the first launch closed' }).toBe(false)
}

// ---------- the layer of the panels (overlay.html) ----------

/** The page of the layer that holds the command bar and the panels (a view of the main window, drawn over the page). */
export function overlayPage(app: ElectronApplication): Promise<Page> {
  return waitForWindow(app, (url) => url.endsWith('/overlay.html'))
}

/** Whether the layer is in the main window: a panel (the command bar, a sheet…) is open. */
export async function overlayShown(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'))
    return (main?.contentView.children ?? []).some((view) => (view as unknown as { webContents?: { getURL(): string } }).webContents?.getURL().endsWith('/overlay.html') === true)
  })
}

/** Asks the main process for a panel, the way the interface does (a stale shortcut or a button would send the same request). */
export async function requestPanel(page: Page, request: Record<string, unknown>): Promise<void> {
  await page.evaluate((sent) => (globalThis as unknown as { lucium: { openOverlay(request: unknown): void } }).lucium.openOverlay(sent), request)
}

/** Calls a method of the bridge of the interface (preload/index.ts) and returns its answer. */
export async function callBridge<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([name, values]) => (globalThis as unknown as { lucium: Record<string, (...rest: unknown[]) => unknown> }).lucium[name as string]!(...(values as unknown[])),
    [method, args] as const
  ) as Promise<T>
}

/** Waits until an element matching `selector` is drawn in the layer, the layer being shown. */
export async function waitForPanel(app: ElectronApplication, selector: string, timeoutMs = 10_000): Promise<Page> {
  const overlay = await overlayPage(app)
  await expect.poll(async () => (await overlayShown(app)) && (await overlay.locator(selector).count()) > 0, { message: `panel ${selector}`, timeout: timeoutMs }).toBe(true)
  return overlay
}

/** One line of the command bar's list, with the title of the genre it is listed under ("Onglets ouverts", "Historique"…). */
export interface BarRow {
  label: string
  detail: string
  hint: string
  group: string
  selected: boolean
}

/** The title the bar gives its open tabs (French, the interface of the tests, or English). */
export const OPEN_TABS_GROUP = /^(Onglets ouverts|Open tabs)$/

/** Opens the command bar with the menu entry of `accelerator` (⌘T: a new tab, ⌘L: the tab on screen) and returns the layer once its field has the focus. */
export async function openCommandBar(app: ElectronApplication, accelerator = 'CmdOrCtrl+T'): Promise<Page> {
  await chooseMenuEntry(app, accelerator)
  const overlay = await waitForPanel(app, '.palette .palette-input')
  await expect.poll(() => overlay.evaluate(() => document.activeElement?.classList.contains('palette-input') === true), { message: 'the field of the command bar has the focus' }).toBe(true)
  return overlay
}

/** The lines the command bar shows, in order. */
export function barRows(overlay: Page): Promise<BarRow[]> {
  return overlay.evaluate(() => {
    const rows: Array<{ label: string; detail: string; hint: string; group: string; selected: boolean }> = []
    let group = ''
    for (const li of document.querySelectorAll('.results li')) {
      if (li.classList.contains('group-title')) group = li.textContent ?? ''
      else if (li.getAttribute('role') === 'option')
        rows.push({
          label: li.querySelector('.label')?.textContent ?? '',
          detail: li.querySelector('.detail')?.textContent ?? '',
          hint: li.querySelector('.hint')?.textContent ?? li.querySelector('.chip')?.textContent ?? '',
          group,
          selected: li.classList.contains('selected')
        })
    }
    return rows
  })
}

/**
 * Types in the field of the command bar, as the keyboard does, and waits until the field holds `shown` (the text typed, unless the bar turned a
 * part of it into something else: a site keyword and its space become a pill, and the field keeps only the words after it).
 */
export async function typeInBar(overlay: Page, text: string, shown = text): Promise<void> {
  await overlay.keyboard.type(text, { delay: 20 })
  await expect.poll(() => overlay.evaluate(() => (document.querySelector('.palette-input') as unknown as { value: string } | null)?.value ?? '')).toBe(shown)
}

/** Moves the highlight of the command bar to the first line that passes `match`, then presses Enter. */
export async function chooseBarRow(overlay: Page, match: (row: BarRow) => boolean): Promise<void> {
  let rows: BarRow[] = []
  await expect.poll(async () => (rows = await barRows(overlay)).some(match), { message: 'the line wanted is in the command bar' }).toBe(true)
  const at = rows.findIndex(match)
  const from = rows.findIndex((row) => row.selected)
  for (let step = from; step < at; step++) await overlay.keyboard.press('ArrowDown')
  await expect.poll(async () => (await barRows(overlay)).findIndex((row) => row.selected)).toBe(at)
  await overlay.keyboard.press('Enter')
}

// ---------- the pages of the tabs ----------

/** The page of the tab on this address (each tab is a view of the window, which Playwright lists with the windows). */
export function tabPage(app: ElectronApplication, url: string, timeoutMs = 15_000): Promise<Page> {
  return waitForWindow(app, (address) => address === url, timeoutMs)
}

/** Opens a page of the test in a tab and waits until its title has come. Returns the id of the tab and its page. */
export async function openTab(running: { app: ElectronApplication; page: Page }, url: string, title: string): Promise<{ id: string; page: Page }> {
  await dispatch(running.page, { type: 'tab/open', url })
  const state = await waitForState(running.page, (s) => s.state.tabs.some((tab) => tab.url === url && tab.title === title), `title of ${url}`)
  return { id: state.state.tabs.find((tab) => tab.url === url)!.id, page: await tabPage(running.app, url) }
}

/** The tab on screen in the current space. */
export async function activeTabId(page: Page): Promise<string | undefined> {
  const snapshot = (await snapshotOf(page)) as Snapshot & { state: { activeTabBySpace: Record<string, string> } }
  return snapshot.state.activeTabBySpace[snapshot.state.activeSpaceId]
}

// ---------- the application menu, by its state ----------

/** What the menu holds for an accelerator: no entry, an entry the user cannot choose (hidden or greyed out), or one they can. */
export async function menuEntryState(app: ElectronApplication, accelerator: string): Promise<'missing' | 'disabled' | 'enabled'> {
  return app.evaluate(({ Menu }, wanted: string) => {
    const norm = (text: string) => text.replace(/cmdorctrl|commandorcontrol|command|cmd/gi, 'mod').replace(/option/gi, 'alt').replace(/control/gi, 'ctrl').replace(/\s+/g, '').toLowerCase()
    type Entry = { accelerator?: string; enabled: boolean; visible: boolean; submenu?: { items: Entry[] } }
    const matches = (entries: Entry[]): Entry[] =>
      entries.flatMap((entry) => [...(entry.accelerator && norm(entry.accelerator) === norm(wanted) ? [entry] : []), ...(entry.submenu ? matches(entry.submenu.items) : [])])
    const found = matches((Menu.getApplicationMenu()?.items ?? []) as unknown as Entry[])
    if (found.length === 0) return 'missing'
    return found.some((entry) => entry.enabled && entry.visible) ? 'enabled' : 'disabled'
  }, accelerator)
}

/**
 * Chooses the entry of the application menu whose label holds `text` (for an entry whose label is the user's own words, such as the title of a
 * web panel, which no shortcut names). Answers what was found, as `chooseMenuEntry` does: `missing`, `disabled` or `ok`.
 */
export async function chooseMenuLabel(app: ElectronApplication, text: string, { click = true } = {}): Promise<'missing' | 'disabled' | 'ok'> {
  return app.evaluate(
    ({ Menu }, [wanted, choose]) => {
      type Entry = { label: string; enabled: boolean; visible: boolean; click: () => void; submenu?: { items: Entry[] } }
      const all = (entries: Entry[]): Entry[] => entries.flatMap((entry) => [entry, ...(entry.submenu ? all(entry.submenu.items) : [])])
      const found = all((Menu.getApplicationMenu()?.items ?? []) as unknown as Entry[]).filter((entry) => entry.label.includes(wanted as string))
      if (found.length === 0) return 'missing'
      const entry = found.find((candidate) => candidate.enabled && candidate.visible)
      if (!entry) return 'disabled'
      if (choose) entry.click()
      return 'ok'
    },
    [text, click] as const
  )
}

/**
 * Gives a command of the catalogue (src/shared/keybindings.ts) a shortcut, the way Settings › Raccourcis does: the commands that have none by
 * default can then be chosen in the menu by their accelerator, whatever the language of the interface.
 */
export async function bindShortcut(page: Page, commandId: string, accelerator: string): Promise<void> {
  const current = ((await snapshotOf(page)).state.settings['keyBindings'] ?? {}) as Record<string, string>
  await setSettings(page, { keyBindings: { ...current, [commandId]: accelerator } })
}
