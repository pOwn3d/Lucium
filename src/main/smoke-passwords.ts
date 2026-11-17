// Engine checks for the password manager (docs/gestionnaire-mots-de-passe.md), run inside a real Electron against a local site:
//  - switched off by default, and what that means (no listener on the bridge's channel, no preload registered, no menu entry, no panel);
//  - switched on: the vault is made over the real channel, in 0600, and holds nothing in the clear; the state the interface receives holds no secret;
//  - the fill, for real: the right form is filled and the events are seen by the page; the page's own trapped setter never sees the value on
//    its way in; a page of another origin (`localhost` for `127.0.0.1`, another port), a frame, a registration form, a form that posts
//    elsewhere, a hidden field: nothing is filled;
//  - the page bridge: a real click on a real submit button offers to save (a notice, no password in it); a form submitted by the page's own
//    script, with no user gesture, offers nothing; nothing is written before the answer; the answer is read back;
//  - a private window: no preload in its session, nothing offered, nothing filled, no panel;
//  - the lock, the switch going off (listener and preload gone, vault closed), and no log line holding a login;
//  - Touch ID: the engine test never runs the keychain helper (index.ts gives the keychain no runner under --smoke), so the panel is told Touch ID is
//    unavailable, and turning it on or opening the vault with it is refused before anything reaches the keychain. The requests that could reach it are
//    sent only once the reply said it is unavailable; `touch-id-off` is never sent.
// `LUCIUM_SMOKE_ONLY=passwords` runs only this file (see index.ts). The file dialogs are not driven here: the import and export are
// covered with stand-ins in shell/password-service.test.ts.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, Menu, webContents, type MenuItem, type WebContents } from 'electron'
import { PASSWORD_BRIDGE } from '@shared/passwords'
import type { SidebarState } from '@shared/model'
import type { SmokeContext } from './smoke'
import { getPasswordService } from './shell/password-service'
import { getWindowManager } from './shell/windows'
import { anySpace, noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

const PHRASE = 'phrase du coffre du test moteur'
const USER = 'smoke-user@example.test'
const SECRET = 'SMOKE-S3CRET-VALUE-77'
const CAPTURED_USER = 'captured-user'
const CAPTURED_SECRET = 'SMOKE-CAPTURED-9981'
const PRELOAD_ID = 'lucium-password-bridge'

/** A form with named fields; `extra` goes inside the page. */
const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
const LOGIN_FORM = `<form id="f" method="post" action="/session"><input id="user" name="email" type="text"><input id="pw" name="password" type="password"><button id="go" type="submit">Connexion</button></form>`

export async function smokePasswords(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, overlayView } = ctx
  const ui = overlayView.webContents
  const settings = () => store.get().settings
  const state = (): SidebarState => store.get()
  const set = (patch: Partial<SidebarState['settings']>) => browser.dispatch({ type: 'settings/update', patch })
  const before = settings().passwordManager
  const mine: string[] = []
  const dataDir = app.getPath('userData')
  const vaultPath = join(dataDir, 'passwords.vault')
  const scratch = mkdtempSync(join(tmpdir(), 'lucium-passwords-smoke-'))

  // Everything the main process writes to its log while this runs: a login must not be in it.
  const logged: string[] = []
  const real = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  for (const method of ['info', 'warn', 'error', 'debug'] as const) {
    console[method] = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}:${a.message}` : JSON.stringify(a))).join(' '))
      real[method](...args)
    }
  }

  // ---- two sites: the page's own, and another origin (another port) for the frame ----
  const posts: string[] = []
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cache-control', 'no-store')
    const html = (body: string) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    }
    if (req.method === 'POST') {
      posts.push(url.pathname)
      return html(page('posted', '<p>ok</p>'))
    }
    switch (url.pathname) {
      case '/login':
        return html(page('login', LOGIN_FORM))
      case '/trapped':
        // The page replaces the setter of the value in its own world, and writes down what it is given.
        return html(
          page(
            'trapped',
            `${LOGIN_FORM}<script>window.__leak = []; const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); Object.defineProperty(HTMLInputElement.prototype, 'value', { get: d.get, set(v) { window.__leak.push(String(v)); d.set.call(this, v) }, configurable: true }); window.__events = []; document.getElementById('pw').addEventListener('input', () => window.__events.push('input'))</script>`
          )
        )
      case '/register':
        return html(page('register', `<form method="post" action="/session"><input id="user" type="text" autocomplete="username"><input id="pw" type="password" autocomplete="new-password"><input id="pw2" type="password" autocomplete="new-password"></form>`))
      case '/offsite':
        return html(page('offsite', `<form method="post" action="http://127.0.0.1:1/collect"><input id="user" type="text"><input id="pw" type="password"></form>`))
      case '/hidden':
        return html(page('hidden', `<form><input id="user" type="text"><input id="pw" type="password" style="display:none"></form>`))
      case '/framed':
        return html(page('framed', `<form id="f"><input id="user" type="text"><input id="pw" type="password"></form><iframe id="inner" src="${otherBase}/login" width="400" height="200"></iframe>`))
      case '/script-submit':
        // No user gesture: the page fills its own fields and submits them from a timer.
        // It records what the page itself knew when it submitted: whether the browser counted a user gesture, and that the submit event happened.
        return html(page('script-submit', `${LOGIN_FORM}<script>window.__activation = 'not-run'; window.__submitted = false; document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__submitted = true }); setTimeout(() => { window.__activation = navigator.userActivation ? navigator.userActivation.isActive : 'unsupported'; document.getElementById('user').value = 'robot'; document.getElementById('pw').value = 'robot-secret'; document.getElementById('f').requestSubmit() }, 300)</script>`))
      default:
        return html(page('page', '<p>page</p>'))
    }
  }
  const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  const siteServer = createServer(handler)
  const otherServer = createServer(handler)
  let otherBase = ''
  const base = await listen(siteServer)
  otherBase = await listen(otherServer)
  const localhostBase = base.replace('127.0.0.1', 'localhost')

  // ---- helpers ----
  const evaluate = <T>(wc: WebContents, js: string) => wc.executeJavaScript(js) as Promise<T>
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const open = async (url: string, title: string, target = browser, targetStore = store): Promise<string> => {
    target.dispatch({ type: 'tab/open', url })
    const id = targetStore.get().tabs.at(-1)!.id
    mine.push(id)
    await waitFor(() => targetStore.get().tabs.find((t) => t.id === id)?.title === title && target.snapshot().runtime.tabs[id]?.loading === false)
    return id
  }
  const field = (wc: WebContents, id: string) => evaluate<string>(wc, `document.getElementById(${JSON.stringify(id)})?.value ?? '<none>'`)
  const ask = (request: unknown) => evaluate<{ ok: boolean; message?: string; view: { vault: string; entries: Array<{ id: string; host: string; username: string }>; capture: { host: string; username: string; kind: string; offer: number } | null; page: { matching: string[] } | null; touchId: { available: boolean; enabled: boolean } } }>(ui, `window.lucium.passwords(${JSON.stringify(request)})`)
  const click = async (wc: WebContents, selector: string) => {
    const point = await evaluate<{ x: number; y: number } | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (!point) return false
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    await sleep(150)
    return true
  }
  const menuItem = (label: string): MenuItem | undefined => {
    const walk = (items: MenuItem[]): MenuItem | undefined => {
      for (const item of items) {
        if (item.label === label) return item
        const inner = item.submenu ? walk(item.submenu.items) : undefined
        if (inner) return inner
      }
      return undefined
    }
    return walk(Menu.getApplicationMenu()?.items ?? [])
  }
  const bridgeIn = (wc: WebContents | undefined): boolean => wc?.session.getPreloadScripts().some((script) => script.id === PRELOAD_ID) === true
  const toast = () => browser.snapshot().toast?.message ?? ''

  try {
    // ======================= off by default =======================
    set({ passwordManager: false })
    await sleep(100)
    const first = await open(`${base}/login`, 'login')
    check('off: the setting is off by default in a fresh application', before === false, String(before))
    check('off: nothing listens on the channel of the page bridge', ipcMain.listenerCount(PASSWORD_BRIDGE.submitted) === 0)
    check('off: the page bridge is not registered in the session of a page', !bridgeIn(wcOf(first)))
    check('off: the entries of the menu are hidden and disabled', menuItem('Mots de passe…')?.visible === false && menuItem('Mots de passe…')?.enabled === false && menuItem('Remplir l’identifiant et le mot de passe')?.visible === false)
    browser.openOverlay({ panel: 'passwords' })
    check('off: the panel does not open', browser.currentPanel() !== 'passwords')
    check('off: a request of the interface is refused and says the manager is off', (await ask({ kind: 'status' })).ok === false)
    check('off: no vault file is made or read', !existsSync(vaultPath))

    // ======================= on =======================
    set({ passwordManager: true })
    check('on: the channel of the page bridge has its listener', await waitFor(() => ipcMain.listenerCount(PASSWORD_BRIDGE.submitted) === 1))
    check('on: the entries of the menu show', await waitFor(() => menuItem('Mots de passe…')?.visible === true && menuItem('Remplir l’identifiant et le mot de passe')?.visible === true))
    browser.openOverlay({ panel: 'passwords' })
    check('on: the panel opens', browser.currentPanel() === 'passwords')
    check('on: …and shows the creation of the vault, since there is none', await waitFor(async () => (await evaluate<string>(ui, `document.querySelector('.passwords h2')?.textContent ?? ''`)) === 'Mots de passe' && (await evaluate<boolean>(ui, `!!document.querySelector('#pw-again')`))))
    browser.closeOverlay()

    const status = await ask({ kind: 'status' })
    check('vault: over the real channel there is none yet', status.ok && status.view.vault === 'none')
    check('vault: a phrase that is too short is refused', (await ask({ kind: 'create', phrase: 'court' })).ok === false && !existsSync(vaultPath))
    const created = await ask({ kind: 'create', phrase: PHRASE })
    check('vault: it is created, and open', created.ok && created.view.vault === 'unlocked', JSON.stringify(created))
    check('vault: its file is private to the user (0600)', existsSync(vaultPath) && (statSync(vaultPath).mode & 0o777) === 0o600, existsSync(vaultPath) ? (statSync(vaultPath).mode & 0o777).toString(8) : 'missing')
    const added = await ask({ kind: 'add', address: base, username: USER, password: SECRET })
    check('vault: a login is added', added.ok && added.view.entries.length === 1, JSON.stringify(added))
    const file = readFileSync(vaultPath, 'utf8')
    check('vault: the file holds neither the username, the password nor the site in the clear', ![USER, SECRET, '127.0.0.1', PHRASE].some((text) => file.includes(text)))
    const snapshot = JSON.stringify(browser.snapshot())
    check('state: the snapshot the interface receives holds no login, no password, no phrase', ![USER, SECRET, PHRASE].some((text) => snapshot.includes(text)))
    const statePath = join(dataDir, 'state.json')
    check('state: …nor does the state in memory or the file of the state', ![USER, SECRET, PHRASE].some((text) => JSON.stringify(state()).includes(text)) && (!existsSync(statePath) || ![USER, SECRET, PHRASE].some((text) => readFileSync(statePath, 'utf8').includes(text))))
    check('vault: the replies of the channel never carry the password', !JSON.stringify(added).includes(SECRET) && !JSON.stringify(await ask({ kind: 'status' })).includes(SECRET))
    const entryId = added.view.entries[0]!.id

    // ======================= Touch ID, never the real keychain =======================
    const touchRecord = `${vaultPath}.touchid`
    const touchView = (await ask({ kind: 'status' })).view.touchId
    const touchOff = touchView?.available === false && touchView.enabled === false
    check('touch id: the engine test has no keychain helper: the panel is told Touch ID is unavailable and off', touchOff, JSON.stringify(touchView))
    if (touchOff) {
      const turnOn = await ask({ kind: 'touch-id-on', phrase: PHRASE })
      check('touch id: turning it on is refused with the sentence of an unavailable Touch ID, and no record is written', !turnOn.ok && /Touch ID n’est pas disponible/.test(turnOn.message ?? '') && !existsSync(touchRecord), JSON.stringify(turnOn.message))
      check('touch id: …and the vault stays open, with its logins', turnOn.view.vault === 'unlocked' && turnOn.view.entries.length === 1)
    }

    // ======================= filling =======================
    const login = await open(`${base}/login`, 'login')
    const loginWc = wcOf(login)!
    check('on: a page loaded now has the page bridge in its session', bridgeIn(loginWc))
    check('fill: the panel knows the entry matches the page', (await ask({ kind: 'status' })).view.page?.matching.includes(entryId) === true)
    const filled = await ask({ kind: 'fill', id: entryId })
    check('fill: the form of a page of exactly the entry\'s origin is filled', filled.ok && (await field(loginWc, 'user')) === USER && (await field(loginWc, 'pw')) === SECRET, JSON.stringify(filled))

    // The engine's own last look: a plan for another origin than the frame's is refused before any script is sent, whoever built it.
    const direct = (await (browser.pageFor(login) as unknown as { fillLogin(plan: unknown): Promise<{ ok: boolean; reason?: string }> }).fillLogin({ origin: localhostBase, username: 'x', password: 'y' }))
    check('engine: `fillLogin` itself refuses a plan whose origin is not the frame\'s, and writes nothing', direct.ok === false && direct.reason === 'origin' && (await field(loginWc, 'user')) === USER)

    // The page's own trapped setter does not see the value on its way in, and the page is told as for typing.
    const trapped = await open(`${base}/trapped`, 'trapped')
    const trappedWc = wcOf(trapped)!
    await ask({ kind: 'fill', id: entryId })
    check('fill: the value is written even when the page trapped the setter of the field…', (await field(trappedWc, 'pw')) === SECRET)
    check('fill: …the trap never saw it (the write goes through the native setter of the isolated world)…', (await evaluate<string>(trappedWc, 'JSON.stringify(window.__leak)')) === '[]')
    check('fill: …and the page heard an input event, as for typing', (await evaluate<string>(trappedWc, 'JSON.stringify(window.__events)')).includes('input'))

    // The same site under another name, and another port: other origins, nothing is filled.
    const lh = await open(`${localhostBase}/login`, 'login')
    const lhReply = await ask({ kind: 'fill', id: entryId })
    check('fill: `localhost` is not `127.0.0.1`: refused, with a sentence naming both', !lhReply.ok && /rien n’a été rempli/.test(lhReply.message ?? '') && (await field(wcOf(lh)!, 'pw')) === '', JSON.stringify(lhReply))
    const other = await open(`${otherBase}/login`, 'login')
    const otherReply = await ask({ kind: 'fill', id: entryId })
    check('fill: another port is another origin: refused', !otherReply.ok && (await field(wcOf(other)!, 'pw')) === '')

    // A frame of another origin inside a page of the entry's origin.
    const framed = await open(`${base}/framed`, 'framed')
    const framedWc = wcOf(framed)!
    await waitFor(async () => (await evaluate<number>(framedWc, 'document.getElementById("inner") ? 1 : 0')) === 1)
    await sleep(500)
    await ask({ kind: 'fill', id: entryId })
    const inner = framedWc.mainFrame.framesInSubtree.find((frame) => frame.url.startsWith(otherBase))
    const innerValue = inner ? await inner.executeJavaScript(`document.getElementById('pw')?.value ?? '<none>'`) : '<no frame>'
    check('fill: the page itself is filled', (await field(framedWc, 'pw')) === SECRET)
    check('fill: …and the frame of another origin that holds a form is not', innerValue === '', String(innerValue))

    // Forms that are not sign-in forms, a form that posts elsewhere, a hidden field.
    for (const [path, title, why] of [
      ['/register', 'register', 'a registration form (new-password)'],
      ['/offsite', 'offsite', 'a form that sends its fields to another origin'],
      ['/hidden', 'hidden', 'a password field the user cannot see']
    ] as const) {
      const tab = await open(`${base}${path}`, title)
      const reply = await ask({ kind: 'fill', id: entryId })
      const wc = wcOf(tab)!
      check(`fill: ${why} is not filled`, !reply.ok && (await field(wc, 'pw')) === '' && (await field(wc, 'user')) === '', JSON.stringify(reply))
    }

    // The explicit gestures: the menu entry fills the one entry the page has; the command bar lists it only on request.
    const again = await open(`${base}/login`, 'login')
    menuItem('Remplir l’identifiant et le mot de passe')?.click()
    check('fill: the menu entry fills the page when it has a single entry', await waitFor(async () => (await field(wcOf(again)!, 'pw')) === SECRET))
    const mismatch = await open(`${localhostBase}/login`, 'login')
    menuItem('Remplir l’identifiant et le mot de passe')?.click()
    check('fill: …and on a page of another origin says so and fills nothing', (await waitFor(() => /Aucun mot de passe|l’adresse diffère/.test(toast()))) && (await field(wcOf(mismatch)!, 'pw')) === '', toast())

    // ======================= the bridge: a login seen on a page =======================
    const seen = await open(`${base}/login`, 'login')
    const seenWc = wcOf(seen)!
    await evaluate(seenWc, `document.getElementById('user').value = ${JSON.stringify(CAPTURED_USER)}; document.getElementById('pw').value = ${JSON.stringify(CAPTURED_SECRET)}; true`)
    check('bridge: a click on the submit button submits the form', await click(seenWc, '#go'))
    check('bridge: a notice offers to save, naming the site', await waitFor(() => anySpace(/^Enregistrer le mot de passe pour 127\.0\.0\.1:\d+ \?$/).test(toast()), 6000), toast())
    check('bridge: the notice holds neither the username nor the password', !toast().includes(CAPTURED_USER) && !toast().includes(CAPTURED_SECRET) && browser.snapshot().toast?.action === 'Enregistrer…')
    const pending = await ask({ kind: 'status' })
    check('bridge: nothing was saved yet, and the panel is told the login waits (username and host, no password)', pending.view.entries.length === 1 && pending.view.capture?.username === CAPTURED_USER && !JSON.stringify(pending).includes(CAPTURED_SECRET), JSON.stringify(pending.view.capture))
    const confirmed = await ask({ kind: 'capture', op: 'confirm', offer: pending.view.capture?.offer })
    check('bridge: the answer saves it', confirmed.ok && confirmed.view.entries.length === 2 && confirmed.view.capture === null, JSON.stringify(confirmed))
    check('bridge: the file still holds none of it in the clear', !readFileSync(vaultPath, 'utf8').includes(CAPTURED_SECRET))
    check('bridge: the notice that offered it is gone once it was answered', !/Enregistrer le mot de passe/.test(toast()), toast())

    // No user gesture: the page's own script submits, in a tab of its own (a new document: no gesture of an earlier page counts).
    const before2 = (await ask({ kind: 'status' })).view.entries.length
    const scripted = await open(`${base}/script-submit`, 'script-submit')
    const scriptedWc = wcOf(scripted)!
    check('bridge: the page\'s own script submitted its form (the submit event happened)', await waitFor(async () => (await evaluate<boolean>(scriptedWc, 'window.__submitted')) === true, 5000))
    check('bridge: …and the browser counted no user gesture at that moment', (await evaluate<unknown>(scriptedWc, 'window.__activation')) === false, String(await evaluate<unknown>(scriptedWc, 'window.__activation')))
    await sleep(1200)
    const afterScript = await ask({ kind: 'status' })
    check('bridge: …so it offers nothing: no notice, nothing waiting, nothing saved', !/Enregistrer le mot de passe/.test(toast()) && afterScript.view.capture === null && afterScript.view.entries.length === before2, toast())

    // ======================= the private window =======================
    const manager = getWindowManager()
    const priv = manager.openPrivate()
    const privTab = await open(`${base}/login`, 'login', priv.browser, priv.store)
    // A private window is a group of its own: its pages are not found through the main window's browser.
    const privWc = (priv.browser.pageFor(privTab) as unknown as { webContents: WebContents } | undefined)?.webContents
    check('private: the page of the private window was found', privWc !== undefined)
    check('private: the session of a private window has no page bridge', privWc !== undefined && !bridgeIn(privWc), privWc ? String(privWc.session.getPreloadScripts().map((script) => script.id)) : 'no page')
    const service = getPasswordService()
    await service?.fillActive(priv.browser.passwordWindow())
    check('private: nothing is filled there, and the notice says why', !!privWc && (await field(privWc, 'pw')) === '' && /privé/.test(priv.browser.snapshot().toast?.message ?? ''), priv.browser.snapshot().toast?.message)
    priv.browser.openOverlay({ panel: 'passwords' })
    check('private: the panel does not open', priv.browser.currentPanel() !== 'passwords')
    const postsBefore = posts.length
    if (privWc) {
      await evaluate(privWc, `document.getElementById('user').value = 'priv-user'; document.getElementById('pw').value = 'priv-secret'; true`)
      await click(privWc, '#go')
    }
    // The witness: the form reaching the server; what a page tells the shell of a submission is sent as it submits, before the request leaves.
    await waitFor(() => posts.length > postsBefore)
    check('private: a form submitted there offers nothing and keeps nothing', !/Enregistrer le mot de passe/.test(priv.browser.snapshot().toast?.message ?? '') && (await ask({ kind: 'status' })).view.entries.length === 2)
    priv.win.close()
    await waitFor(() => manager.privateWindows().length === 0)
    await manager.settled()

    // A guest window is a private window underneath: the same rules hold (and its notices wear the guest's wording, so only the effects are looked at).
    const guestBefore = settings().guestProfile
    set({ guestProfile: true })
    const guestRecord = manager.openGuest({ commandBar: false })
    check('guest: a guest window opens while its setting is on', guestRecord !== null)
    if (guestRecord) {
      const guestTab = await open(`${base}/login`, 'login', guestRecord.browser, guestRecord.store)
      const guestWc = (guestRecord.browser.pageFor(guestTab) as unknown as { webContents: WebContents } | undefined)?.webContents
      check('guest: its session has no page bridge', guestWc !== undefined && !bridgeIn(guestWc))
      await service?.fillActive(guestRecord.browser.passwordWindow())
      check('guest: nothing is filled there', !!guestWc && (await field(guestWc, 'pw')) === '')
      guestRecord.browser.openOverlay({ panel: 'passwords' })
      check('guest: the panel does not open', guestRecord.browser.currentPanel() !== 'passwords')
      guestRecord.win.close()
      await waitFor(() => manager.guestWindows().length === 0)
      await manager.settled()
    }
    set({ guestProfile: guestBefore })

    // ======================= locking =======================
    service?.lock()
    const locked = await ask({ kind: 'status' })
    check('lock: locking closes the vault: no entry is given to the interface', locked.view.vault === 'locked' && locked.view.entries.length === 0)
    const refused = await ask({ kind: 'fill', id: entryId })
    check('lock: …and nothing is filled while it is closed', !refused.ok && (await field(wcOf(await open(`${base}/login`, 'login'))!, 'pw')) === '')
    check('lock: a wrong phrase is refused', (await ask({ kind: 'unlock', phrase: 'une mauvaise phrase du test' })).ok === false)
    if (touchOff) {
      const byTouch = await ask({ kind: 'unlock-touch-id' })
      check('touch id: opening the vault with it is refused, the vault stays locked, and the phrase is asked', !byTouch.ok && byTouch.view.vault === 'locked' && /saisissez la phrase/.test(byTouch.message ?? ''), JSON.stringify(byTouch.message))
    }
    check('lock: the right phrase opens it again, with the logins it had', (await ask({ kind: 'unlock', phrase: PHRASE })).view.entries.length === 2)

    // ======================= off again =======================
    set({ passwordManager: false })
    check('off again: the listener of the bridge is gone', await waitFor(() => ipcMain.listenerCount(PASSWORD_BRIDGE.submitted) === 0))
    const later = await open(`${base}/login`, 'login')
    check('off again: a page loaded now has no page bridge', !bridgeIn(wcOf(later)))
    check('off again: the vault is closed (and its file is kept)', existsSync(vaultPath) && (await ask({ kind: 'status' })).ok === false)
    check('off again: the menu entries are hidden', await waitFor(() => menuItem('Mots de passe…')?.visible === false))
    set({ passwordManager: true })
    const reopened = await ask({ kind: 'status' })
    check('on again: the vault is found locked, as it was kept', reopened.view.vault === 'locked')

    // ======================= the log =======================
    const text = logged.join('\n')
    check('log: no line of the log holds a username, a password or a phrase', ![USER, SECRET, PHRASE, CAPTURED_USER, CAPTURED_SECRET, 'priv-secret', 'robot-secret', 'une mauvaise phrase'].some((value) => text.includes(value)), text.split('\n').filter((line) => line.includes('SMOKE-')).slice(0, 3).join(' | '))
  } finally {
    Object.assign(console, real)
    set({ passwordManager: before })
    browser.closeOverlay()
    for (const id of mine) browser.dispatch({ type: 'tab/close', id })
    getPasswordService()?.stop()
    for (const wc of webContents.getAllWebContents()) if (wc.getURL().startsWith(base) || wc.getURL().startsWith(otherBase) || wc.getURL().startsWith(localhostBase)) wc.close()
    siteServer.closeAllConnections()
    siteServer.close()
    otherServer.closeAllConnections()
    otherServer.close()
    // The vault of this run was made in the throw-away data folder of the test; it goes with it, and the next suite finds none.
    rmSync(vaultPath, { force: true })
    rmSync(`${vaultPath}.touchid`, { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** `LUCIUM_SMOKE_ONLY=passwords`: only these checks, with their own report. */
export async function runPasswordsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokePasswords(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokePasswords ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PASSWORDS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
