// Engine checks for the web hardware APIs (WebHID, WebUSB, Web Serial), run inside a real Electron. No device is needed and none is touched:
// the lists Electron would build are simulated by emitting its `select-*` events on the profile's session with a real frame and a real
// tab, and the native menu is replaced by a recorder (a test must never open a system menu). What is checked: the switch (off, nothing is
// installed on any session; on, the three pickers are), the picker (names the site, lists the devices that may be offered and not a security
// key, refuses a sub-frame and a private tab), the register (a pick shows in Settings › Vie privée et sécurité, "Retirer" takes it back), the real calls of a page
// (`requestDevice`, `requestPort` reject or reach a picker that names the site, never one for an iframe) and switching off. What a test cannot
// do without a device: have Electron call the device permission handler and see a revoked device refused (see docs/api-materielles.md).
// `LUCIUM_SMOKE_ONLY=webhardware` runs only this file (see index.ts).

import type { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow, Menu, session, type WebContents, type WebFrameMain } from 'electron'
import { defaultSettings } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import type { HardwareGrantRow } from '@shared/web-hardware'
import type { SmokeContext } from './smoke'
import { runningGates } from './shell/feature-gate'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

const SELECT_EVENTS = ['select-hid-device', 'select-usb-device', 'select-serial-port'] as const
const settingsWindows = () => BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')

const collection = (usagePage: number, usage: number) => ({ usagePage, usage, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] })
const FAKE_PAD = { deviceId: 'smoke-pad', vendorId: 0x046d, productId: 0xc52b, name: 'Manette de test', serialNumber: 'SMOKE0001', collections: [collection(0x01, 0x05)] }
const FAKE_FIDO = { deviceId: 'smoke-fido', vendorId: 0x1209, productId: 0x0001, name: 'Clé de test FIDO', serialNumber: 'KEY', collections: [collection(0xf1d0, 0x01)] }
const FAKE_KEYBOARD = { deviceId: 'smoke-kbd', vendorId: 0x05ac, productId: 0x0250, name: 'Clavier de test', collections: [collection(0x01, 0x06)] }
const FAKE_PORT = { portId: 'smoke-port', portName: '/dev/tty.smoke-test', displayName: 'Port de test', vendorId: '9025', productId: '67', serialNumber: '' }

interface Shown {
  labels: string[]
}

export async function smokeWebHardware(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const before = { ...store.get().settings }
  const originalSpace = store.get().activeSpaceId

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    if (req.url?.startsWith('/frame')) return void res.end('<title>hw frame</title><body>frame</body>')
    res.end('<title>hw main</title><body>hardware<iframe id="f" src="/frame"></iframe></body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`

  // The native menu is never shown: what would be shown is recorded, and `pick` says which line the "user" clicks (none: the menu is dismissed).
  const shown: Shown[] = []
  let pick: (labels: string[]) => string | null = () => null
  const proto = Menu.prototype as unknown as { popup: (this: Menu, options?: { callback?: () => void }) => void }
  const realPopup = proto.popup
  proto.popup = function (this: Menu, options) {
    const labels = this.items.map((item) => item.label)
    shown.push({ labels })
    const wanted = pick(labels)
    if (wanted !== null) this.items.find((item) => item.label === wanted && item.enabled)?.click()
    options?.callback?.()
  }

  const profile = activeProfileId(store.get())
  const mine = new Set<string>()
  /** The tab of the checks (set once it is open). */
  let wc!: WebContents
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const open = async (url: string, title: string, options: { private?: boolean } = {}): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url, ...(options.private ? { private: true } : {}) })
    const tab = store.get().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => store.get().tabs.find((t) => t.id === tab.id)?.title === title)
    await sleep(200)
    return tab.id
  }
  const listeners = (ses: Electron.Session) => SELECT_EVENTS.map((event) => ses.listenerCount(event))
  /** A real click in the tab: the engine only lets a page ask for a device just after one (the same input the page would get from the user). */
  const click = async (target: WebContents) => {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) target.sendInputEvent({ type, x: 30, y: 30, button: 'left', clickCount: 1 } as Electron.MouseInputEvent)
    await sleep(80)
  }
  /** Emits Electron's select event the way it does, and resolves with what the callback received. `clickIn`: the tab the user clicked in just before (none: no click). */
  const emitSelect = async (ses: Electron.Session, event: (typeof SELECT_EVENTS)[number], list: unknown[], frameOrContents: WebFrameMain | WebContents | null, clickIn: WebContents | null = wc) => {
    if (clickIn) await click(clickIn)
    return new Promise<{ answer: unknown; prevented: boolean }>((resolve) => {
      let prevented = false
      const e = { preventDefault: () => (prevented = true) }
      const done = (answer: unknown) => setTimeout(() => resolve({ answer, prevented }), 250)
      if (event === 'select-serial-port') ses.emit(event, e, list, frameOrContents, done)
      else ses.emit(event, e, { deviceList: list, frame: frameOrContents }, done)
    })
  }
  const grants = (): HardwareGrantRow[] => ctx.engine.webHardwareGrants()
  /**
   * A call of the page, made with a user gesture as the APIs require. What the page learns is the same whether the request was refused or the list
   * was closed with no choice (Chromium answers both alike): WebHID resolves with an empty array ('devices:0'), WebUSB and Web Serial reject with
   * NotFoundError. So 'a device was given' ('devices:<n>' with n above 0, or any other value) is the only outcome that tells a grant; whether a
   * request was refused or reached a picker is told by the events and the lists seen, never by this value.
   */
  const call = async (target: { executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }, expression: string, clickIn: WebContents | null = null) => {
    if (clickIn) await click(clickIn)
    return (await target.executeJavaScript(`(async () => { try { const r = await ${expression}; return Array.isArray(r) ? 'devices:' + r.length : 'resolved' } catch (e) { return e && e.name ? e.name : String(e) } })()`, true)) as string
  }
  const gaveDevice = (outcome: string): boolean => outcome === 'resolved' || (outcome.startsWith('devices:') && outcome !== 'devices:0')
  /** Counts the picker events a session emits while a check watches, and cancels them: a request the permission check refuses never gets this far. */
  const watchPickers = (session: Electron.Session) => {
    const ses = session as unknown as EventEmitter
    let seen = 0
    const spies = SELECT_EVENTS.map((event) => {
      const spy = (e: { preventDefault(): void }, ...args: unknown[]) => {
        seen++
        e.preventDefault()
        const callback = args.at(-1) as (answer?: string) => void
        callback(event === 'select-serial-port' ? '' : undefined)
      }
      ses.on(event, spy)
      return [event, spy] as const
    })
    return {
      seen: () => seen,
      stop: () => spies.forEach(([event, spy]) => ses.off(event, spy))
    }
  }
  const REQUESTS = ['navigator.hid.requestDevice({ filters: [] })', 'navigator.usb.requestDevice({ filters: [] })', 'navigator.serial.requestPort()']

  try {
    // Whatever a suite before left, the checks start from the switch off and the gate stopped.
    browser.dispatch({ type: 'settings/update', patch: { webHardware: false, privateTabs: true } })
    await waitFor(() => !runningGates().includes('web-hardware'))
    const tab = await open(`${base}/`, 'hw main')
    wc = wcOf(tab)!
    const ses = session.fromPartition(`persist:profile-${profile}`)
    check('hardware: the page is a tab of the profile’s session', wc.session === ses)

    // ---- off (the default): nothing is installed, every request is refused, no list is ever shown ----
    check('hardware off: the setting is off by default and no gate runs', defaultSettings().webHardware === false && !runningGates().includes('web-hardware'))
    check('hardware off: no picker is installed on the profile’s session', listeners(ses).every((n) => n === 0), JSON.stringify(listeners(ses)))
    check('hardware off: the three APIs exist in the page (a secure context) …', (await wc.executeJavaScript(`['hid','usb','serial'].every((k) => k in navigator)`)) === true)
    const spyOff = watchPickers(ses)
    const refusedOff: string[] = []
    for (const request of REQUESTS) refusedOff.push(await call(wc, request, wc))
    spyOff.stop()
    check('hardware off: … and no request gives the page a device, with no list on screen', refusedOff.every((r) => !gaveDevice(r)) && shown.length === 0, JSON.stringify({ refusedOff, shown: shown.length }))
    check('hardware off: … and none of them even reaches a picker event (the permission check refuses first)', spyOff.seen() === 0, String(spyOff.seen()))

    // ---- on ----
    browser.dispatch({ type: 'settings/update', patch: { webHardware: true } })
    check('hardware on: the gate runs and the three pickers are installed, once each', (await waitFor(() => runningGates().includes('web-hardware'))) && listeners(ses).every((n) => n === 1), JSON.stringify(listeners(ses)))
    check('hardware on: nothing is granted yet', grants().length === 0)

    // A pick: the first device of the list is clicked. The site is named, the security key and the keyboard are not offered.
    pick = (labels) => labels.find((l) => l.startsWith('Manette de test')) ?? null
    const picked = await emitSelect(ses, 'select-hid-device', [FAKE_PAD, FAKE_FIDO, FAKE_KEYBOARD], wc.mainFrame)
    const menu = shown.at(-1)?.labels ?? []
    check('hardware pick: the event is claimed and the page gets the device that was clicked', picked.prevented && picked.answer === 'smoke-pad', JSON.stringify(picked))
    check('hardware pick: the list names the site in its first line, and that line is not a device', menu[0] === frenchSpaces(`« 127.0.0.1:${port} (cet ordinateur) » veut se connecter à un appareil HID`), menu[0])
    check('hardware pick: the list offers the pad, not the security key or the keyboard, and says that two were left out', menu.some((l) => l.startsWith('Manette de test')) && !menu.some((l) => /FIDO|Clavier de test/.test(l)) && menu.some((l) => l.startsWith('2 appareils protégés ne sont jamais proposé')), JSON.stringify(menu))
    check('hardware pick: the list ends with “Annuler”', menu.at(-1) === 'Annuler')
    check('hardware pick: the device is registered for this site', grants().length === 1 && grants()[0]!.kind === 'hid' && grants()[0]!.origin === base, JSON.stringify(grants()))

    // A dismissed menu: nothing is given, nothing is registered.
    pick = () => null
    const dismissed = await emitSelect(ses, 'select-usb-device', [{ ...FAKE_PAD, deviceId: 'smoke-usb', deviceClass: 0xff, productName: 'USB de test', configurations: [{ interfaces: [{ alternates: [{ interfaceClass: 0xff }] }] }] }], wc.mainFrame)
    check('hardware pick: a menu closed with no choice gives the page nothing and registers nothing', dismissed.prevented && dismissed.answer === undefined && grants().length === 1, JSON.stringify(dismissed))

    // No click: a page that asks on its own (the last click is more than five seconds old) is refused with no list, even though Blink would let it ask.
    await sleep(5300)
    const listedBefore = shown.length
    const noClick = await emitSelect(ses, 'select-hid-device', [FAKE_PAD], wc.mainFrame, null)
    check('hardware pick: a request with no click or key in the tab just before is answered with nothing and shows no list', noClick.prevented && noClick.answer === undefined && shown.length === listedBefore && grants().length === 1, JSON.stringify({ noClick, listed: shown.length - listedBefore }))

    // A serial port: Electron names the tab's contents, not a frame.
    pick = (labels) => labels.find((l) => l.startsWith('Port de test')) ?? null
    const serialPick = await emitSelect(ses, 'select-serial-port', [FAKE_PORT], wc)
    check('hardware pick: a serial port is picked the same way, its cancel being an empty string', serialPick.answer === 'smoke-port' && grants().some((g) => g.kind === 'serial'), JSON.stringify(serialPick))

    // The sub-frame of the page: never asked.
    const shownBefore = shown.length
    const iframe = wc.mainFrame.frames[0]
    check('hardware iframe: the page has a sub-frame whose parent is the main frame (the rule reads exactly that)', iframe !== undefined && iframe.parent === wc.mainFrame && wc.mainFrame.parent === null)
    pick = (labels) => labels.find((l) => l.startsWith('Manette de test')) ?? null
    const fromFrame = await emitSelect(ses, 'select-hid-device', [{ ...FAKE_PAD, deviceId: 'smoke-pad-2', serialNumber: 'OTHER' }], iframe ?? null)
    check('hardware iframe: a request from the sub-frame is answered with nothing, shows no list and registers nothing', fromFrame.prevented && fromFrame.answer === undefined && shown.length === shownBefore && grants().length === 2, JSON.stringify({ fromFrame, grants: grants().length }))

    // The real calls of the page: with no device, a request ends in an error, and if a list is shown it names the site.
    pick = () => null
    const realMain = []
    for (const request of REQUESTS) {
      const count = shown.length
      const outcome = await call(wc, request, wc)
      realMain.push({ request, outcome, listed: shown.length - count, names: shown.slice(count).every((s) => s.labels[0]?.includes(`127.0.0.1:${port}`)) })
    }
    check('hardware real calls: the page’s requestDevice and requestPort give it no device when nothing is chosen (WebHID resolves with an empty list, the others reject), and any list shown names the site', realMain.every((r) => !gaveDevice(r.outcome) && r.names), JSON.stringify(realMain))
    check('hardware real calls: each of the three requests reached the picker, which named the site', realMain.every((r) => r.listed === 1), JSON.stringify(realMain))
    const frameCount = shown.length
    const realFrame: string[] = []
    for (const request of REQUESTS) realFrame.push(await call(iframe!, request, wc))
    check('hardware real calls: the sub-frame’s requests give it no device and show no list', realFrame.every((r) => !gaveDevice(r)) && shown.length === frameCount, JSON.stringify({ realFrame, listed: shown.length - frameCount }))

    // A private tab: no picker on its session, and its requests are refused.
    const privateTab = await open(`${base}/`, 'hw main', { private: true })
    const privateWc = wcOf(privateTab)!
    check('hardware private tab: the private tab lives in another session, with no picker', privateWc.session !== ses && listeners(privateWc.session).every((n) => n === 0), JSON.stringify(listeners(privateWc.session)))
    const privateCount = shown.length
    const privateOutcomes: string[] = []
    const spyPrivate = watchPickers(privateWc.session)
    for (const request of REQUESTS) privateOutcomes.push(await call(privateWc, request, privateWc))
    spyPrivate.stop()
    check('hardware private tab: its requests give the page no device, with no list on screen and no picker event', privateOutcomes.every((r) => !gaveDevice(r)) && shown.length === privateCount && spyPrivate.seen() === 0, JSON.stringify({ privateOutcomes, events: spyPrivate.seen() }))
    // `emit` says whether anything listens: nothing does on the private session, so a simulated pick would not even be heard.
    const heard = privateWc.session.emit('select-hid-device', { preventDefault() {} }, { deviceList: [FAKE_PAD], frame: privateWc.mainFrame }, () => undefined)
    check('hardware private tab: nobody listens for a pick there, and nothing is registered for it', heard === false && grants().length === 2, String(heard))

    // ---- Settings › Vie privée et sécurité: the list, and “Retirer” ----
    browser.openOverlay({ panel: 'settings', pane: 'protection' })
    check('hardware settings: the Settings window opens', await waitFor(() => settingsWindows().length === 1))
    const sw = settingsWindows()[0]!.webContents
    const run = <T>(script: string) => sw.executeJavaScript(script) as Promise<T>
    const rows = () => run<string[]>(`[...document.querySelectorAll('.pref-row, .pref-check')].map((r) => r.textContent).filter((t) => t.includes('Manette de test') || t.includes('Port de test'))`)
    await run(`window.dispatchEvent(new Event('focus'))`)
    check('hardware settings: “Appareils autorisés” lists the pad and the port, each with the site', await waitFor(async () => (await rows()).length === 2 && (await rows()).every((t) => t.includes(`127.0.0.1:${port}`))), JSON.stringify(await rows()))
    // Vie privée et sécurité: the group closes the permissions of the sites, right after « Autorisations des sites » (SettingsCategories.tsx, SitesCategory),
    // whose screen sharing waits in « Plus de réglages » with it (its rows at the top come first, under the same title); the remembered answers are on
    // their subpage. The title of a group is its .pref-title.
    const hardwareTitles = await run<string[]>(`[...document.querySelectorAll('.settings-content .pref-section > h3 > .pref-title')].map((h) => h.textContent)`)
    check('hardware settings: the group is in Vie privée et sécurité, right after “Autorisations des sites”', hardwareTitles.indexOf('API matérielles du web') > 0 && hardwareTitles.indexOf('API matérielles du web') === hardwareTitles.lastIndexOf('Autorisations des sites') + 1, hardwareTitles.join('|'))
    check('hardware settings: “Retirer” on the pad’s row', await run<boolean>(`(() => { const row = [...document.querySelectorAll('.pref-row')].find((r) => r.textContent.includes('Manette de test')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Retirer'); if (!b) return false; b.click(); return true })()`))
    check('hardware settings: … takes the pad back at once (the engine lists only the port) and the row goes', await waitFor(() => grants().length === 1 && grants()[0]!.kind === 'serial') && (await waitFor(async () => (await rows()).length === 1)), JSON.stringify(grants()))
    const viaInterface = await win.webContents.executeJavaScript(`window.lucium.webHardware({ kind: 'revoke', id: 'hw-999999' })`)
    check('hardware settings: a grant that does not exist is said not to exist, and nothing else is touched', viaInterface.ok === false && grants().length === 1, JSON.stringify(viaInterface))
    const forged = await win.webContents.executeJavaScript(`window.lucium.webHardware({ kind: 'revoke', id: '*' })`)
    check('hardware settings: a request that is not exactly one of the three is refused', forged.ok === false && forged.message === 'Demande invalide.' && grants().length === 1, JSON.stringify(forged))
    settingsWindows().forEach((w) => w.close())
    await waitFor(() => settingsWindows().length === 0, 3000)

    // ---- a grant lasts as long as its tab stays on the site ----
    pick = (labels) => labels.find((l) => l.startsWith('Manette de test')) ?? null
    await emitSelect(ses, 'select-hid-device', [FAKE_PAD], wc.mainFrame)
    check('hardware tab: a new pick is registered', grants().some((g) => g.kind === 'hid'))
    await wc.loadURL(`${base}/?again`)
    check('hardware tab: a reload on the same site keeps it', grants().some((g) => g.kind === 'hid'))
    await wc.loadURL('about:blank')
    check('hardware tab: leaving the site ends the grants of that tab', await waitFor(() => grants().length === 0), JSON.stringify(grants()))

    // ---- off again: the pickers go, the grants go, the notice says that open connections stay ----
    await wc.loadURL(`${base}/`)
    await emitSelect(ses, 'select-hid-device', [FAKE_PAD], wc.mainFrame)
    const toastBefore = browser.snapshot().toast?.id ?? 0
    browser.dispatch({ type: 'settings/update', patch: { webHardware: false } })
    check('hardware off again: the gate stops and the pickers are taken off the session', (await waitFor(() => !runningGates().includes('web-hardware'))) && listeners(ses).every((n) => n === 0), JSON.stringify(listeners(ses)))
    check('hardware off again: every grant is gone', grants().length === 0)
    check('hardware off again: the notice says that a connection already open stays until the tab reloads', await waitFor(() => (browser.snapshot().toast?.id ?? 0) > toastBefore && (browser.snapshot().toast?.message ?? '').includes('reste active jusqu’au rechargement')), browser.snapshot().toast?.message ?? '')
    const shownAfter = shown.length
    const spyAgain = watchPickers(ses)
    const refusedAgain: string[] = []
    for (const request of REQUESTS) refusedAgain.push(await call(wc, request, wc))
    spyAgain.stop()
    check('hardware off again: no request gives the page a device, with no list on screen', refusedAgain.every((r) => !gaveDevice(r)) && shown.length === shownAfter, JSON.stringify(refusedAgain))
    check('hardware off again: … and none of them reaches a picker event', spyAgain.seen() === 0, String(spyAgain.seen()))
  } finally {
    proto.popup = realPopup
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    settingsWindows().forEach((w) => w.close())
    if (store.get().spaces.some((s) => s.id === originalSpace)) browser.dispatch({ type: 'space/select', id: originalSpace })
    browser.dispatch({ type: 'settings/update', patch: { webHardware: before.webHardware, privateTabs: before.privateTabs } })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=webhardware`: only these checks, with their own report. */
export async function runWebHardwareSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeWebHardware(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeWebHardware ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_WEBHARDWARE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
