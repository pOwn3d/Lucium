// Engine checks for extensions with several profiles in several windows, run inside a real Electron:
// three profiles, one window each (plus a second window on the first profile), an extension that exists in one profile only and one that exists
// in all three. What must hold: the toolbar of a window lists the extensions of the profile it shows and no others; a click on an icon opens
// the popup or the side panel in the window that was clicked; chrome.tabs / chrome.windows / tabs.sendMessage see the profile only; what an
// extension opens (tabs.create, windows.create) lands in its own profile; the badge is per tab and per window; the entry an extension puts in
// the right-click menu of pages is seen in the pages of its own profile; a notification and its click stay in the profile; uninstalling in one
// profile leaves the others; a folder taken out of Settings › Extensions leaves every profile, every toolbar and the Extensions menu at once, and
// comes back when it is put back. `LUCIUM_SMOKE_ONLY=extwindows` runs it alone; the probes are generated from compat/window-probe, so
// LUCIUM_EXTENSIONS is not needed. Everything the run opens (spaces, windows, tabs, extension copies) is removed afterwards.

import { createServer } from 'node:http'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, type WebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { getWindowManager, MAIN_WINDOW_ID, type WindowRecord } from './shell/windows'
import { anySpace, noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'
import { t } from '@shared/i18n'

type Check = (name: string, ok: boolean, detail?: string) => void
type Reply = { ok: boolean; value?: any; error?: string }


const waitFor = waiterOf(10_000, 80)

const withDeadline = <T>(promise: Promise<T>, fallback: T, ms = 25_000): Promise<T> => Promise.race([promise, sleep(ms).then(() => fallback)])
const silent: Reply = { ok: false, error: 'no answer from the worker within 25 seconds' }

const RPC_PAGE = `<title>ew-rpc</title><body>rpc page<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
</script></body>`

interface Seat {
  /** The window, the profile and the space it shows. */
  rec: WindowRecord
  profile: string
  space: string
  label: string
  /** The page that drives the extensions of the profile from this window (a tab of the window). */
  rpc: { id: string; wc: WebContents }
}

export async function smokeExtWindows(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, engine } = ctx
  const manager = getWindowManager()
  const home = store.get().activeSpaceId
  const homeProfile = store.get().spaces.find((s) => s.id === home)?.profileId ?? 'default'
  const sleepAfter = store.get().settings.sleepAfterMinutes
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  // ---- a server of its own (the range given to this run: 8880-8889) ----
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    if (path.endsWith('/rpc')) return void res.end(RPC_PAGE)
    res.end(`<title>ew ${path}</title><body>ew ${path}</body>`)
  })
  let port = 0
  for (let candidate = 8880; candidate <= 8889 && port === 0; candidate++) {
    port = await new Promise<number>((resolve) => {
      server.once('error', () => resolve(0))
      server.listen(candidate, '127.0.0.1', () => resolve(candidate))
    })
  }
  if (port === 0) port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
  const base = `http://127.0.0.1:${port}`

  // ---- the extensions: copies of compat/window-probe, one folder each ----
  const folder = mkdtempSync(join(tmpdir(), 'lucium-extwin-'))
  const probeSource = join(app.getAppPath(), 'compat', 'window-probe')
  const make = (label: string, edit: (manifest: Record<string, any>) => void = () => {}): string => {
    const target = join(folder, label)
    cpSync(probeSource, target, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as Record<string, any>
    manifest['name'] = `Probe ${label}`
    edit(manifest)
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return target
  }
  const paths = {
    A: make('A'),
    // No popup: its icon opens the side panel (setPanelBehavior is asked through the driver below).
    B: make('B', (m) => delete m['action'].default_popup),
    C: make('C'),
    S: make('S')
  }

  const tabs: string[] = []
  const spaces: string[] = []
  const windows: WindowRecord[] = []
  const popups: Array<{ profile: string; parent: number | undefined }> = []
  const unwatch: Array<() => void> = []
  const seats: Seat[] = []
  const obs: string[] = []
  const note = (line: string) => {
    obs.push(line)
    console.log(`[extwindows] ${line}`)
  }

  const waitPage = async (rec: WindowRecord, id: string): Promise<WebContents> => {
    await waitFor(() => rec.browser.ownsPage(id) && engine.tabNumberOf(id) !== undefined && rec.browser.snapshot().runtime.tabs[id]?.loading === false, 15_000)
    return (rec.browser.pageFor(id) as unknown as { webContents: WebContents }).webContents
  }
  const openIn = async (rec: WindowRecord, url: string): Promise<{ id: string; wc: WebContents }> => {
    rec.browser.dispatch({ type: 'tab/open', url })
    const tab = rec.store.get().tabs.at(-1)!
    tabs.push(tab.id)
    return { id: tab.id, wc: await waitPage(rec, tab.id) }
  }
  const ui = <T>(rec: WindowRecord, code: string): Promise<T> => rec.win.webContents.executeJavaScript(code) as Promise<T>
  const numberOf = (id: string): number => engine.tabNumberOf(id)!

  /** What an extension of a profile is asked, through the page of a window of that profile. */
  const ask = (seat: Seat, ext: string, message: unknown, deadline = 25_000): Promise<Reply> => withDeadline(seat.rpc.wc.executeJavaScript(`window.rpc(${JSON.stringify(ext)}, ${JSON.stringify(message)})`) as Promise<Reply>, silent, deadline)
  const call = (seat: Seat, ext: string, path: string, ...args: unknown[]): Promise<Reply> => ask(seat, ext, { type: 'call', path, args })
  const idOf = (profile: string, name: string): string | undefined => engine.listExtensions().find((e) => e.profileId === profile && e.name === `Probe ${name}`)?.id

  /** The icons a window's toolbar shows, by the profile (partition) of each list. */
  const toolbar = (rec: WindowRecord) => {
    // A window behind the others runs no animation frame, and the library draws the badge and the title of an icon from one: it is brought up before it is read.
    rec.win.moveTop()
    return ui<Array<{ partition: string; ids: string[]; badges: Record<string, string>; titles: Record<string, string> }>>(
      rec,
      `[...document.querySelectorAll('browser-action-list')].map((l) => ({ partition: l.getAttribute('partition'), ids: [...(l.shadowRoot?.querySelectorAll('.action') ?? [])].map((e) => e.id), badges: Object.fromEntries([...(l.shadowRoot?.querySelectorAll('.action') ?? [])].map((e) => [e.id, e.querySelector('.badge')?.textContent ?? ''])), titles: Object.fromEntries([...(l.shadowRoot?.querySelectorAll('.action') ?? [])].map((e) => [e.id, e.title])) }))`
    )
  }
  const iconsOf = async (rec: WindowRecord): Promise<string[]> => (await toolbar(rec)).flatMap((list) => list.ids).sort()
  const clickIcon = (rec: WindowRecord, id: string): Promise<boolean> => ui<boolean>(rec, `(() => { for (const l of document.querySelectorAll('browser-action-list')) { const b = l.shadowRoot?.getElementById(${JSON.stringify(id)}); if (b) { b.click(); return true } } return false })()`)
  const focusWindow = async (rec: WindowRecord): Promise<void> => {
    rec.win.show()
    rec.win.focus()
    // The focus event is what the extension runtime listens to; a window that cannot take the focus of the system (a run without a screen) says it the same way.
    if (!rec.win.isFocused()) rec.win.emit('focus')
    await sleep(150)
  }

  const profileOf = (id: string): string | undefined => engine.profileOfTab(numberOf(id))
  const shown = (rec: WindowRecord): { path: string; extensionId: string } | undefined => {
    const panel = rec.browser.snapshot().sidePanel
    return panel ? { path: panel.name, extensionId: (panel as { extensionId?: string }).extensionId ?? '' } : undefined
  }

  try {
    // ============ the three profiles, the four windows ============
    const profiles = { P1: homeProfile, P2: 'extwin-b', P3: 'extwin-c' }
    browser.dispatch({ type: 'space/create', name: 'Ext B', emoji: '🅱️', hue: 200, profileId: profiles.P2 })
    const spaceB = store.get().activeSpaceId
    browser.dispatch({ type: 'space/create', name: 'Ext C', emoji: '🅲', hue: 120, profileId: profiles.P3 })
    const spaceC = store.get().activeSpaceId
    spaces.push(spaceB, spaceC)
    browser.dispatch({ type: 'space/select', id: home })

    const mainRec = manager.list().find((r) => r.id === MAIN_WINDOW_ID)!
    const open = async (space: string): Promise<WindowRecord> => {
      const rec = manager.openWindow({ commandBar: false })
      windows.push(rec)
      rec.browser.dispatch({ type: 'space/select', id: space })
      await waitFor(() => !rec.win.webContents.isLoading(), 15_000)
      return rec
    }
    const w2 = await open(spaceB)
    const w3 = await open(spaceC)
    const w1b = await open(home)
    const layout: Array<[string, WindowRecord, string, string]> = [
      ['W1', mainRec, home, profiles.P1],
      ['W2', w2, spaceB, profiles.P2],
      ['W3', w3, spaceC, profiles.P3],
      ['W1b', w1b, home, profiles.P1]
    ]
    for (const [label, rec, space, profile] of layout) {
      const page = await openIn(rec, `${base}/${profile}/${label}/a`)
      const rpc = await openIn(rec, `${base}/${profile}/${label}/rpc`)
      await waitFor(() => rec.store.get().activeSpaceId === space, 4000)
      seats.push({ rec, profile, space, label, rpc })
      void page
    }
    const seat = (label: string): Seat => seats.find((s) => s.label === label)!
    check('extwindows: four windows, each showing the space of its profile, each with its own tabs', seats.every((s) => s.rec.store.get().activeSpaceId === s.space && profileOf(s.rpc.id) === s.profile), JSON.stringify(seats.map((s) => [s.label, s.rec.win.id, s.rec.store.get().activeSpaceId === s.space, profileOf(s.rpc.id)])))

    // ============ the extensions: A in P1 only, B in P2 only, C in P3 only, S in all three ============
    const profileNames = Object.values(profiles)
    await engine.loadExtension(profiles.P1, paths.A)
    await engine.loadExtension(profiles.P2, paths.B)
    await engine.loadExtension(profiles.P3, paths.C)
    for (const profile of profileNames) await engine.loadExtension(profile, paths.S)
    // What these folders are inherited by is for a profile created later: nothing of the run reads it (private to the engine: forgotten again below).
    const ids = { A: idOf(profiles.P1, 'A')!, B: idOf(profiles.P2, 'B')!, C: idOf(profiles.P3, 'C')!, S: idOf(profiles.P1, 'S')! }
    check('extwindows: the probes are loaded where they belong (A in P1, B in P2, C in P3 only; S in the three)', !!ids.A && !!ids.B && !!ids.C && !!ids.S && !idOf(profiles.P2, 'A') && !idOf(profiles.P3, 'A') && !idOf(profiles.P1, 'B') && !idOf(profiles.P3, 'B') && !idOf(profiles.P1, 'C') && !idOf(profiles.P2, 'C') && idOf(profiles.P2, 'S') === ids.S && idOf(profiles.P3, 'S') === ids.S)
    for (const s of seats) {
      const profile = engine.listExtensions().filter((e) => e.profileId === s.profile)
      void profile
    }

    // The popups of every profile: where each opened (the window it hangs from).
    for (const profile of profileNames) {
      const extensions = (engine as unknown as { profiles: Map<string, { extensions: { on: (e: string, l: (popup: { parent?: BrowserWindow }) => void) => void; off: (e: string, l: unknown) => void } }> }).profiles.get(profile)!.extensions
      const listener = (popup: { parent?: BrowserWindow }) => popups.push({ profile, parent: popup.parent?.id })
      extensions.on('browser-action-popup-created', listener)
      unwatch.push(() => extensions.off('browser-action-popup-created', listener))
    }

    // A profile that has just been made loads its extensions in the background, and the worker starts when first asked.
    const ready = async (s: Seat): Promise<boolean> => waitFor(async () => (await ask(s, ids.S, { type: 'sender' }, 8000)).ok, 40_000)
    for (const s of seats) await ready(s)
    // A content script runs in the pages that load after the extension (as the extension API defines): the pages made before are loaded again.
    for (const s of seats) {
      s.rpc.wc.reload()
      await waitFor(async () => (await s.rpc.wc.executeJavaScript('document.documentElement.dataset.windowProbe ?? ""').catch(() => '')) !== '', 10_000)
    }

    // ============ (1) the toolbar of each window lists the extensions of its profile ============
    const expectedIcons = (profile: string): string[] => engine.listExtensions().filter((e) => e.profileId === profile).map((e) => e.id).sort()
    for (const s of seats) {
      await focusWindow(s.rec)
      const ok = await waitFor(async () => JSON.stringify(await iconsOf(s.rec)) === JSON.stringify(expectedIcons(s.profile)), 8000)
      const got = await toolbar(s.rec)
      note(`toolbar ${s.label} (profile ${s.profile}): ${JSON.stringify(got.map((l) => [l.partition, l.ids.map((id) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id)]))}`)
      check(`extwindows (1): the toolbar of ${s.label} shows the extensions of its profile (${s.profile}) and no others`, ok && got.every((l) => l.partition === `persist:profile-${s.profile}`), JSON.stringify(got))
    }

    // ============ (2) a click opens the popup in the window that was clicked ============
    // Each window in turn gets the focus, then its icon of S (the extension that every profile has) is clicked.
    const closePopups = async (): Promise<void> => {
      for (const extra of BrowserWindow.getAllWindows()) if (extra.getParentWindow() && !windows.some((w) => w.win === extra) && extra !== mainRec.win) extra.destroy()
      await sleep(150)
    }
    for (const s of [seat('W1'), seat('W2'), seat('W3'), seat('W1b'), seat('W1')]) {
      await closePopups()
      const before = popups.length
      await focusWindow(s.rec)
      const clicked = await clickIcon(s.rec, ids.S)
      const arrived = await waitFor(() => popups.length > before, 6000)
      const got = popups[popups.length - 1]
      note(`popup of S clicked in ${s.label}: ${arrived ? JSON.stringify(got) : 'none'} (window ${s.rec.win.id})`)
      check(`extwindows (2): the popup of an icon clicked in ${s.label} hangs from ${s.label}, in its own profile`, clicked && arrived && got?.parent === s.rec.win.id && got?.profile === s.profile, JSON.stringify({ clicked, popup: got, window: s.rec.win.id }))
    }
    await closePopups()
    // The same, with the focus somewhere else: a click on a window that is not the one the extension runtime last saw focused.
    {
      const s = seat('W1b')
      const other = seat('W1')
      await focusWindow(s.rec)
      await focusWindow(other.rec)
      const before = popups.length
      const clicked = await clickIcon(s.rec, ids.S)
      const arrived = await waitFor(() => popups.length > before, 6000)
      const got = popups[popups.length - 1]
      note(`popup of S clicked in W1b while W1 had the focus last: ${JSON.stringify(got)}; W1b=${s.rec.win.id} W1=${other.rec.win.id}`)
      check('extwindows (2): a click on the icon of W1b hangs the popup from W1b, not from W1 (the other window of the same profile), even when W1 had the focus last', clicked && arrived && got?.parent === s.rec.win.id, JSON.stringify({ clicked, popup: got }))
      await closePopups()
    }

    // The side panel: B has no popup and asks for its panel to open on a click.
    {
      const s = seat('W2')
      const set = await call(s, ids.B, 'sidePanel.setPanelBehavior', { openPanelOnActionClick: true })
      check('extwindows (2): B can ask for its panel to open on a click (driver call)', set.ok, JSON.stringify(set))
      for (const target of [seat('W2')]) {
        await focusWindow(target.rec)
        await clickIcon(target.rec, ids.B)
        const opened = await waitFor(() => shown(target.rec) !== undefined, 6000)
        const others = seats.filter((o) => o.rec !== target.rec).map((o) => `${o.label}:${shown(o.rec)?.path ?? '-'}`)
        note(`side panel of B clicked in ${target.label}: here=${JSON.stringify(shown(target.rec))} others=${others.join(' ')}`)
        check(`extwindows (2): the icon of B clicked in ${target.label} opens its side panel there and in no other window`, opened && seats.every((o) => (o.rec === target.rec ? shown(o.rec) !== undefined : shown(o.rec) === undefined)), JSON.stringify({ others }))
        target.rec.browser.closeSidePanel()
      }
    }

    // ============ (3) what the extension sees: its profile only ============
    const urlsOf = (value: any): string[] => (Array.isArray(value) ? value.map((t: any) => String(t.url)).sort() : [])
    const wins = (profile: string): number[] => seats.filter((s) => s.profile === profile).map((s) => s.rec.win.id)
    for (const s of seats.filter((x) => x.label !== 'W1b')) {
      const everyone = await call(s, ids.S, 'tabs.query', {})
      const mine = urlsOf(everyone.value)
      note(`tabs.query({}) by S in ${s.profile}: ${JSON.stringify(mine)}`)
      check(`extwindows (3): tabs.query({}) of S in ${s.profile} lists the tabs of ${s.profile} and no other profile's`, everyone.ok && mine.length >= 2 && mine.every((u) => u.includes(`/${s.profile}/`)), JSON.stringify(everyone).slice(0, 400))
      const active = await call(s, ids.S, 'tabs.query', { active: true, currentWindow: true })
      const activeUrls = urlsOf(active.value)
      check(`extwindows (3): tabs.query({active:true,currentWindow:true}) of S in ${s.profile} is one tab of ${s.profile}`, active.ok && activeUrls.length === 1 && activeUrls[0]!.includes(`/${s.profile}/`), JSON.stringify(active).slice(0, 300))
      const all = await call(s, ids.S, 'windows.getAll', { populate: true })
      const listed: number[] = Array.isArray(all.value) ? all.value.map((w: any) => w.id) : []
      note(`windows.getAll by S in ${s.profile}: ${JSON.stringify(listed)} (windows of the profile: ${JSON.stringify(wins(s.profile))})`)
      check(`extwindows (3): windows.getAll of S in ${s.profile} lists the windows that show the profile and no others`, all.ok && listed.length === wins(s.profile).length && listed.every((id) => wins(s.profile).includes(id)), JSON.stringify({ listed, expected: wins(s.profile) }))
      const current = await call(s, ids.S, 'windows.getCurrent', {})
      const last = await call(s, ids.S, 'windows.getLastFocused', {})
      check(`extwindows (3): windows.getCurrent and getLastFocused of S in ${s.profile} are windows of ${s.profile}`, current.ok && last.ok && wins(s.profile).includes(current.value?.id) && wins(s.profile).includes(last.value?.id), JSON.stringify({ current: current.value?.id, last: last.value?.id }))
      for (const other of seats.filter((o) => o.profile !== s.profile)) {
        const foreign = numberOf(other.rpc.id)
        const sent = await call(s, ids.S, 'tabs.sendMessage', foreign, { type: 'where' })
        check(`extwindows (3): S in ${s.profile} cannot send a message to a tab of ${other.profile}`, !sent.ok && /No tab with id|Receiving end does not exist/i.test(sent.error ?? ''), JSON.stringify(sent))
        const got = await call(s, ids.S, 'tabs.get', foreign)
        // The library answers a tab it does not know with the id -1 (the documented API throws): either way nothing of the other profile's tab is shown.
        check(`extwindows (3): nor get it`, !got.ok || got.value?.id === -1, JSON.stringify(got))
        const win = await call(s, ids.S, 'windows.get', other.rec.win.id)
        check(`extwindows (3): nor get the window ${other.label} of ${other.profile}`, win.ok && win.value?.id === -1, JSON.stringify(win))
      }
      const own = numberOf(s.rpc.id)
      const sentOwn = await call(s, ids.S, 'tabs.sendMessage', own, { type: 'where' })
      check(`extwindows (3): tabs.sendMessage to a tab of its own profile reaches the content script there`, sentOwn.ok && sentOwn.value?.extension === ids.S && String(sentOwn.value?.href).includes(`/${s.profile}/`), JSON.stringify(sentOwn))
    }
    // Two windows of one profile: both are listed, and the tabs of both.
    {
      const s = seat('W1')
      const all = await call(s, ids.A, 'windows.getAll', {})
      const listed: number[] = Array.isArray(all.value) ? all.value.map((w: any) => w.id) : []
      check('extwindows (3): the two windows of P1 are both listed to A', all.ok && listed.length === 2 && wins(profiles.P1).every((id) => listed.includes(id)), JSON.stringify({ listed, expected: wins(profiles.P1) }))
      const everyone = urlsOf((await call(s, ids.A, 'tabs.query', {})).value)
      check('extwindows (3): and the tabs of both windows of P1 are listed to A', everyone.some((u) => u.includes('/W1/')) && everyone.some((u) => u.includes('/W1b/')) && everyone.every((u) => u.includes(`/${profiles.P1}/`)), JSON.stringify(everyone))
    }
    // runtime.getContexts: the contexts of the extension itself (its side panel here), of its profile.
    {
      const s2 = seat('W2')
      const s1 = seat('W1')
      s2.rec.browser.openSidePanel(ids.S, undefined)
      s1.rec.browser.openSidePanel(ids.S, undefined)
      await sleep(400)
      const fromP1 = await call(s1, ids.S, 'runtime.getContexts', { contextTypes: ['SIDE_PANEL'] })
      const windowsSeen: number[] = Array.isArray(fromP1.value) ? fromP1.value.map((c: any) => c.windowId).sort() : []
      note(`runtime.getContexts(SIDE_PANEL) by S in P1 with panels of S open in W1 (P1) and W2 (P2): windows ${JSON.stringify(windowsSeen)}`)
      check('extwindows (3): runtime.getContexts of S in P1 reports the side panel of its own profile (W1), not the one the same extension has open in P2 (W2)', fromP1.ok && windowsSeen.length === 1 && windowsSeen[0] === s1.rec.win.id, JSON.stringify({ fromP1, w1: s1.rec.win.id, w2: s2.rec.win.id }))
      s1.rec.browser.closeSidePanel()
      s2.rec.browser.closeSidePanel()
    }

    // ============ (4) what an extension opens lands in its own profile and window ============
    {
      // The user is in W1 (profile P1); the extension of P2 asks for a tab: it goes to W2, in a space of P2.
      await focusWindow(seat('W1').rec)
      const s = seat('W2')
      const created = await call(s, ids.B, 'tabs.create', { url: `${base}/${profiles.P2}/created-by-B`, active: false })
      const tabId = created.value?.id as number | undefined
      const landed = await waitFor(() => tabId !== undefined && engine.pageIdOfTabNumber(tabId) !== undefined, 8000)
      const pageId = tabId !== undefined ? engine.pageIdOfTabNumber(tabId) : undefined
      if (pageId) tabs.push(pageId)
      const ownerWindow = pageId ? seats.map((x) => x.rec).find((rec) => rec.browser.ownsPage(pageId)) : undefined
      note(`tabs.create by B (P2) while the user is in W1: tab ${tabId} in profile ${tabId !== undefined ? engine.profileOfTab(tabId) : '?'}, window ${ownerWindow?.win.id} (W2=${s.rec.win.id}, W1=${seat('W1').rec.win.id})`)
      check('extwindows (4): tabs.create by B (profile P2) while the user is in W1 opens in P2 and in W2', created.ok && landed && tabId !== undefined && engine.profileOfTab(tabId) === profiles.P2 && ownerWindow === s.rec && created.value?.windowId === s.rec.win.id, JSON.stringify({ created, owner: ownerWindow?.win.id }))
      // windows.create: a new window of the browser, showing a tab of the profile of the extension.
      const before = manager.extraWindows().length
      const createdWindow = await call(s, ids.B, 'windows.create', { url: `${base}/${profiles.P2}/window-by-B` })
      await waitFor(() => manager.extraWindows().length === before + 1, 8000)
      const fresh = manager.extraWindows().at(-1)
      if (fresh && !windows.includes(fresh)) windows.push(fresh)
      await waitFor(() => (fresh?.store.get().tabs ?? []).some((t) => t.url === `${base}/${profiles.P2}/window-by-B`), 6000)
      const tab = fresh?.store.get().tabs.find((t) => t.url === `${base}/${profiles.P2}/window-by-B`)
      if (tab) tabs.push(tab.id)
      const tabProfile = tab ? fresh?.store.get().spaces.find((sp) => sp.id === tab.spaceId)?.profileId : undefined
      await waitFor(() => !!tab && !!fresh?.browser.ownsPage(tab.id), 8000)
      const shownSpace = fresh?.store.get().activeSpaceId
      const shownProfile = fresh?.store.get().spaces.find((sp) => sp.id === shownSpace)?.profileId
      note(`windows.create by B (P2) while the user is in W1: new window shows space of profile ${shownProfile}, tab of profile ${tabProfile}, page alive ${tab ? fresh?.browser.ownsPage(tab.id) : false}`)
      check('extwindows (4): windows.create by B (profile P2) opens a window that shows a tab of P2 (its space is on screen, its page is alive)', createdWindow.ok && !!tab && tabProfile === profiles.P2 && shownProfile === profiles.P2 && fresh?.browser.ownsPage(tab.id) === true, JSON.stringify({ createdWindow, tabProfile, shownProfile }))
      if (fresh && !fresh.win.isDestroyed()) fresh.win.close()
    }

    // What an extension cannot do to the windows and tabs of another profile (the three profiles share one application).
    {
      const sB = seat('W2')
      const w1 = seat('W1')
      const w1Bounds = w1.rec.win.getBounds()
      const w1Tab = engine.pageIdOfTabNumber(numberOf(w1.rpc.id))
      const toForeign = await call(sB, ids.B, 'tabs.create', { url: `${base}/${profiles.P2}/into-W1`, windowId: w1.rec.win.id })
      // The library's preload gives an extension nothing back for a call the main process refused (the reason is in the log: No window with id).
      check('extwindows (4): tabs.create by B naming a window of P1 creates no tab, and W1 keeps showing its own space', (!toForeign.ok || toForeign.value === null) && !store.get().tabs.some((t) => t.url.includes('into-W1')) && w1.rec.store.get().activeSpaceId === w1.space, JSON.stringify(toForeign))
      const update = await call(sB, ids.B, 'windows.update', w1.rec.win.id, { left: 5, top: 5, width: 640, height: 480 })
      const same = JSON.stringify(w1.rec.win.getBounds()) === JSON.stringify(w1Bounds)
      check('extwindows (4): windows.update by B on a window of P1 moves and resizes nothing', same, JSON.stringify({ update, before: w1Bounds, after: w1.rec.win.getBounds() }))
      await call(sB, ids.B, 'windows.remove', w1.rec.win.id)
      await call(sB, ids.B, 'tabs.remove', numberOf(w1.rpc.id))
      // A fixed wait, for want of a witness: the answer to windows.remove is empty whether it was refused or done, and a window it closed would
      // only be gone some time after it (tabs.remove would have closed its tab before answering).
      await sleep(400)
      check('extwindows (4): windows.remove and tabs.remove by B on a window and a tab of P1 close nothing', !w1.rec.win.isDestroyed() && !!w1Tab && w1.rec.browser.ownsPage(w1.rpc.id) && store.get().tabs.some((t) => t.id === w1.rpc.id))
      // Its own options page opens in its own profile, in the window of that profile.
      const optionsBefore = store.get().tabs.length
      await focusWindow(w1.rec)
      const opened = await call(sB, ids.B, 'runtime.openOptionsPage')
      const optionsTab = await waitFor(() => store.get().tabs.some((t) => t.url.startsWith(`chrome-extension://${ids.B}/`)), 8000)
      const optionsTabItem = store.get().tabs.find((t) => t.url.startsWith(`chrome-extension://${ids.B}/`))
      if (optionsTabItem) tabs.push(optionsTabItem.id)
      const optionsProfile = optionsTabItem ? store.get().spaces.find((sp) => sp.id === optionsTabItem.spaceId)?.profileId : undefined
      note(`options page of B opened while the user is in W1: ${opened.ok} tab in profile ${optionsProfile} (tabs ${optionsBefore} -> ${store.get().tabs.length})`)
      check('extwindows (4): the options page of B (profile P2) opens as a tab of P2 while the user is in W1, not in W1', opened.ok && optionsTab && optionsProfile === profiles.P2 && !!optionsTabItem && w2.browser.ownsPage(optionsTabItem.id) && w1.rec.store.get().activeSpaceId === w1.space, JSON.stringify({ opened, optionsProfile }))
    }

    // ============ (5) badge, title, menu entry, notification ============
    // The badge of an action: per tab, and each window shows the one of its own tab.
    {
      const s1 = seat('W1')
      const s1b = seat('W1b')
      const tab1 = numberOf(s1.rec.store.get().tabs.find((t) => s1.rec.browser.ownsPage(t.id) && t.url.includes('/W1/rpc'))?.id ?? s1.rpc.id)
      const tab1b = numberOf(s1b.rpc.id)
      const shownTab = (rec: WindowRecord) => engine.tabNumberOf(rec.store.get().tabs.find((t) => t.id === rec.store.get().activeTabBySpace[rec.store.get().activeSpaceId])?.id ?? '')
      note(`active tab of W1 is ${shownTab(s1.rec)} (rpc ${tab1}), of W1b ${shownTab(s1b.rec)} (rpc ${tab1b})`)
      const badgeIn = async (rec: WindowRecord): Promise<string | undefined> => (await toolbar(rec)).find((l) => l.badges[ids.A] !== undefined)?.badges[ids.A]
      await call(s1, ids.A, 'action.setBadgeText', { text: '1', tabId: shownTab(s1.rec) })
      await call(s1b, ids.A, 'action.setBadgeText', { text: 'b', tabId: shownTab(s1b.rec) })
      await waitFor(async () => (await badgeIn(s1.rec)) === '1' && (await badgeIn(s1b.rec)) === 'b', 6000)
      const [b1, b1b] = [await badgeIn(s1.rec), await badgeIn(s1b.rec)]
      note(`badge of A: W1 shows "${b1}", W1b shows "${b1b}" (set "1" on the tab of W1 and "b" on the tab of W1b)`)
      check('extwindows (5): the badge of A is per tab: W1 shows the one of its own tab and W1b the one of its own', b1 === '1' && b1b === 'b', JSON.stringify({ b1, b1b }))
      // A badge for no tab in particular is the default of every tab; one for a tab beats it on that tab.
      await call(s1, ids.A, 'action.setBadgeText', { text: 'G' })
      await call(s1, ids.A, 'action.setBadgeText', { text: 'T', tabId: shownTab(s1.rec) })
      await waitFor(async () => (await badgeIn(s1.rec)) === 'T', 6000)
      const [t1, t1b] = [await badgeIn(s1.rec), await badgeIn(s1b.rec)]
      note(`badge of A after a global "G" and "T" on the tab of W1: W1 shows "${t1}", W1b shows "${t1b}" (its tab has "b")`)
      check('extwindows (5): a badge set for one tab beats the default on that tab, and the other window keeps its own', t1 === 'T' && t1b === 'b', JSON.stringify({ t1, t1b }))
      // The other profiles' windows do not show A at all, nor its badge.
      const w2 = await toolbar(seat('W2').rec)
      check('extwindows (5): the badge of A (profile P1) appears in no window of P2 or P3', w2.every((l) => l.badges[ids.A] === undefined) && (await toolbar(seat('W3').rec)).every((l) => l.badges[ids.A] === undefined))
      await call(s1, ids.A, 'action.setTitle', { title: 'Titre W1', tabId: shownTab(s1.rec) })
      const titleIn = async (rec: WindowRecord): Promise<string | undefined> => (await toolbar(rec)).find((l) => l.titles[ids.A] !== undefined)?.titles[ids.A]
      await waitFor(async () => (await titleIn(s1.rec)) === 'Titre W1', 6000)
      const [titles, titlesB] = [await titleIn(s1.rec), await titleIn(s1b.rec)]
      note(`title of A: W1 "${titles}", W1b "${titlesB}" (set "Titre W1" for the tab of W1)`)
      check('extwindows (5): the title of an action set for a tab is the one of that tab\'s window only', titles === 'Titre W1' && titlesB !== 'Titre W1', JSON.stringify({ titles, titlesB }))
    }

    // The entry an extension puts in the right-click menu of pages: shown in the pages of its own profile.
    {
      const menuOf = async (s: Seat): Promise<string[]> => {
        const page = (s.rec.browser.pageFor(s.rpc.id) as unknown as { webContents: WebContents }).webContents
        const real = Menu.prototype.popup
        let captured: Menu | null = null
        Menu.prototype.popup = function (this: Menu) {
          captured = this
          return this
        } as never
        try {
          page.emit('context-menu', {}, { linkURL: '', pageURL: page.getURL(), frameURL: '', mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', x: 5, y: 5, misspelledWord: '', dictionarySuggestions: [] })
        } finally {
          Menu.prototype.popup = real
        }
        const menu = captured as Menu | null
        const labels: string[] = []
        const walk = (items: Electron.MenuItem[]) => items.forEach((item) => (labels.push(item.label), item.submenu ? walk(item.submenu.items) : undefined))
        if (menu) walk(menu.items)
        return labels
      }
      const expected: Record<string, string[]> = { [profiles.P1]: ['Probe A', 'Probe S'], [profiles.P2]: ['Probe B', 'Probe S'], [profiles.P3]: ['Probe C', 'Probe S'] }
      for (const s of seats.filter((x) => x.label !== 'W1b')) {
        // The probes make their entry when installed; the worker has started above.
        const labels = await menuOf(s)
        const mine = labels.filter((l) => l.startsWith('Probe '))
        note(`right-click menu of a page in ${s.label} (${s.profile}): ${JSON.stringify(mine)}`)
        check(`extwindows (5): the right-click menu of a page of ${s.profile} lists the entries of its extensions (${expected[s.profile]!.join(', ')}) and only those`, JSON.stringify([...mine].sort()) === JSON.stringify(expected[s.profile]), JSON.stringify(labels))
      }
    }

    // A notification belongs to the profile that made it; its click goes back to that profile's extension.
    {
      const sA = seat('W1')
      const sB = seat('W2')
      const created = await call(sA, ids.A, 'notifications.create', 'n-a', { type: 'basic', iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', title: 'Probe A', message: 'extwindows', silent: true })
      const listedA = await call(sA, ids.A, 'notifications.getAll')
      const listedB = await call(sB, ids.B, 'notifications.getAll')
      check('extwindows (5): a notification of A is listed by A and by no extension of another profile', created.ok && Array.isArray(listedA.value) && listedA.value.includes('n-a') && Array.isArray(listedB.value) && listedB.value.length === 0, JSON.stringify({ created, listedA, listedB }))
      const registries = (id: string) => (engine as unknown as { profiles: Map<string, { extensions: { api: { notifications: { registry: Map<string, { emit: (e: string) => void; close: () => void }> } } } }> }).profiles.get(id)!.extensions.api.notifications.registry
      const live = registries(profiles.P1).get(`${ids.A}-n-a`)
      live?.emit('click')
      // The witness: the click reaching A, whose notification it is; the extensions of the other profiles are asked only then.
      const heardClick = (reply: { value?: unknown }): boolean => (reply.value as Array<{ name: string }> | undefined)?.some((e) => e.name === 'notifications.onClicked') === true
      await waitFor(async () => heardClick(await ask(sA, ids.A, { type: 'events' })))
      const eventsA = await ask(sA, ids.A, { type: 'events' })
      const eventsS2 = await ask(sB, ids.B, { type: 'events' })
      const clickedA = (eventsA.value as Array<{ name: string }> | undefined)?.some((e) => e.name === 'notifications.onClicked')
      const clickedB = (eventsS2.value as Array<{ name: string }> | undefined)?.some((e) => e.name === 'notifications.onClicked')
      check('extwindows (5): the click on the notification of A reaches A only, none of the extensions of the other profiles', clickedA === true && clickedB !== true && registries(profiles.P2).size === 0, JSON.stringify({ clickedA, clickedB }))
      await call(sA, ids.A, 'notifications.clear', 'n-a')
      live?.close()
    }

    // ============ (7) uninstalling in one profile leaves the others ============
    {
      const s1 = seat('W1')
      const before = engine.listExtensions().filter((e) => e.id === ids.S).map((e) => e.profileId).sort()
      // A folder loaded by hand is taken out of a profile the way the switch of the profile does it: S goes from P2 only.
      // From the menu of the icon of W2, with W2 in front: the notice ("désactivée dans le profil") is W2's, not the main window's. Which window the system
      // calls focused depends on the machine (a run in the background gets none), so the answer of each window is given here.
      const infront = new Map(seats.map((x) => [x.rec.win, x.label === 'W2'] as const))
      for (const [window, front] of infront) (window as unknown as { isFocused: () => boolean }).isFocused = () => front
      const noticeIn = (rec: WindowRecord): string => rec.browser.snapshot().toast?.message ?? ''
      try {
        browser.extensionControl!.setEnabled(profiles.P2, ids.S, false)
        await waitFor(() => !engine.listExtensions().some((e) => e.profileId === profiles.P2 && e.id === ids.S), 6000)
        check('extwindows (5): the notice of a switch made from the icon of W2 is shown in W2 (the window in front), not in the main window', noticeIn(seat('W2').rec).includes('Probe S') && !noticeIn(seat('W1').rec).includes('Probe S'), JSON.stringify({ w2: noticeIn(seat('W2').rec), w1: noticeIn(seat('W1').rec) }))
      } finally {
        for (const window of infront.keys()) delete (window as unknown as { isFocused?: () => boolean }).isFocused
      }
      const after = engine.listExtensions().filter((e) => e.id === ids.S).map((e) => e.profileId).sort()
      // The witness: the icon leaving the window of P2; the other windows are read once that change has been drawn.
      await waitFor(async () => !(await iconsOf(seat('W2').rec)).includes(ids.S))
      const stillThere = await Promise.all(seats.map(async (s) => [s.label, (await iconsOf(s.rec)).includes(ids.S)] as const))
      note(`S switched off in P2: loaded in ${JSON.stringify(after)} (before ${JSON.stringify(before)}); icon of S by window ${JSON.stringify(stillThere)}`)
      check('extwindows (7): taking S out of P2 leaves it in P1 and P3: still listed, icon still in W1, W1b and W3, gone from W2', before.length === 3 && after.join() === [profiles.P1, profiles.P3].sort().join() && stillThere.every(([label, has]) => (label === 'W2' ? !has : has)), JSON.stringify({ before, after, stillThere }))
      const alive = await call(s1, ids.S, 'tabs.query', {})
      check('extwindows (7): and the copy of S in P1 still answers', alive.ok, JSON.stringify(alive).slice(0, 200))
      browser.dispatch({ type: 'extension/set-enabled', profileId: profiles.P2, extensionId: ids.S, enabled: true })
      await waitFor(() => engine.listExtensions().some((e) => e.profileId === profiles.P2 && e.id === ids.S), 6000)
    }

    // ============ (8) a folder taken out of Settings › Extensions leaves every profile at once ============
    {
      // Where the engine is asked to load a folder because the list of Settings gained it (extension-folders.ts): counted, then handed back.
      const shell = browser as unknown as { loadExtensionFolder: (folder: string) => Promise<string | null> }
      const realLoad = shell.loadExtensionFolder.bind(browser)
      let loads = 0
      shell.loadExtensionFolder = (folder) => {
        loads++
        return realLoad(folder)
      }
      const copiesOfS = (): string[] => engine.listAllExtensions().filter((e) => e.id === ids.S).map((e) => e.profileId).sort()
      const menuLabels = (): string[] => Menu.getApplicationMenu()?.items.find((item) => item.label === t('menu.extensions'))?.submenu?.items.map((item) => item.label) ?? []
      const inheritance = (engine as unknown as { extensionPaths: Set<string> }).extensionPaths
      const toasts = (): string[] => seats.map((s) => s.rec.browser.snapshot().toast?.message ?? '')
      const listed = (): string[] => store.get().settings.extensionPaths
      const before = listed()
      const settingsWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows().find((w) => w.getTitle() === t('settings.reglages'))
      try {
        // The dialog writes a folder in the list once it has loaded it: the list gaining it loads nothing again. The store tells its listeners during
        // the dispatch, and a load the follower decides is asked for before its first wait: the count is final when the dispatch returns.
        browser.dispatch({ type: 'settings/update', patch: { extensionPaths: [...before, paths.S] } })
        check('extwindows (8): a folder already loaded that comes into Settings › Extensions is not loaded a second time', loads === 0 && copiesOfS().length === 3, JSON.stringify({ loads, copies: copiesOfS() }))
        const menuHadS = await waitFor(() => menuLabels().includes('Probe S'), 4000)

        // « Retirer » on its row, in the Settings window, as the person does it: the folders are on the subpage « Extensions chargées depuis un dossier ».
        browser.openOverlay({ panel: 'settings', pane: 'tools', anchor: 'extensionfolders' })
        await waitFor(() => settingsWindow() !== undefined, 8000)
        const wc = settingsWindow()?.webContents
        const label = t('settings.retirer-name', { name: paths.S })
        const button = `[...document.querySelectorAll('.settings-content button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})`
        const rowShown = wc ? await waitFor(async () => (await wc.executeJavaScript(`!!${button}`)) === true, 8000) : false
        const hintShown = wc ? ((await wc.executeJavaScript(`document.querySelector('.settings-content')?.textContent ?? ''`)) as string).includes(t('settings.l-extension-est-aussi-dechargee-tout-de-suite')) : false
        const clicked = wc ? ((await wc.executeJavaScript(`(() => { const b = ${button}; b?.click(); return !!b })()`)) as boolean) : false
        const leftList = await waitFor(() => !listed().includes(paths.S), 6000)
        const gone = await waitFor(() => copiesOfS().length === 0, 8000)
        const iconsGone = await waitFor(async () => (await Promise.all(seats.map(async (s) => (await iconsOf(s.rec)).includes(ids.S)))).every((has) => !has), 8000)
        const menuGone = await waitFor(() => !menuLabels().includes('Probe S'), 6000)
        const rowGone = wc ? await waitFor(async () => (await wc.executeJavaScript(`!${button}`)) === true, 6000) : false
        const others = engine.listExtensions().map((e) => e.id)
        note(`S removed in Settings: list ${JSON.stringify(listed())}, copies ${JSON.stringify(copiesOfS())}, menu ${JSON.stringify(menuLabels())}, inherited ${inheritance.has(paths.S)}`)
        check('extwindows (8): the folder of S has its row in Settings › Extensions et outils › Extensions chargées depuis un dossier, with the sentence that says the extension goes at once', rowShown && hintShown, JSON.stringify({ rowShown, hintShown }))
        check('extwindows (8): « Retirer » in Settings takes S out of the engine at once, in the three profiles, and a profile made later does not inherit it', clicked && leftList && gone && !inheritance.has(paths.S), JSON.stringify({ clicked, leftList, copies: copiesOfS(), inherited: inheritance.has(paths.S) }))
        check('extwindows (8): …its icon leaves the toolbar of every window, its row leaves Settings, and the Extensions menu is built again without it', iconsGone && rowGone && menuHadS && menuGone, JSON.stringify({ iconsGone, rowGone, menuHadS, menu: menuLabels() }))
        check('extwindows (8): …and the extensions of the other folders stay where they were (A in P1, B in P2, C in P3)', [ids.A, ids.B, ids.C].every((id) => others.includes(id)), JSON.stringify(others))
        settingsWindow()?.close()

        // Put back in the list (the main process does it, after the dialog or the Extensions page's « Annuler »): loaded again in every profile.
        browser.dispatch({ type: 'settings/update', patch: { extensionPaths: [...before, paths.S] } })
        const back = await waitFor(() => copiesOfS().length === 3, 10_000)
        const iconBack = await waitFor(async () => (await iconsOf(seat('W1').rec)).includes(ids.S), 8000)
        check('extwindows (8): a folder that comes back into the list is loaded again, in the three profiles, with its icon', back && iconBack && loads === 1, JSON.stringify({ copies: copiesOfS(), iconBack, loads }))

        // Its folder gone from the disk: taken out of the list without an error, and put back with a sentence that says why it is not loaded.
        rmSync(paths.S, { recursive: true, force: true })
        browser.dispatch({ type: 'settings/update', patch: { extensionPaths: before } })
        // The unload happens during the dispatch, and so would the notice of a failure: the toasts are read once it is done.
        const goneAgain = await waitFor(() => copiesOfS().length === 0, 8000)
        const quiet = toasts().every((message) => !anySpace(/« S »/).test(message))
        check('extwindows (8): an extension whose folder was deleted leaves the profiles without an error', goneAgain && quiet, JSON.stringify({ copies: copiesOfS(), toasts: toasts() }))
        browser.dispatch({ type: 'settings/update', patch: { extensionPaths: [...before, paths.S] } })
        const said = await waitFor(() => toasts().some((message) => anySpace(/« S » n’a pas été chargée\. Le dossier n’existe plus à cet endroit\./).test(message)), 8000)
        check('extwindows (8): a folder put back after it was deleted is not loaded, and a notice says so with its name and the reason in words', said && copiesOfS().length === 0, JSON.stringify({ toasts: toasts(), copies: copiesOfS() }))
      } finally {
        settingsWindow()?.close()
        browser.dispatch({ type: 'settings/update', patch: { extensionPaths: before } })
        delete (shell as { loadExtensionFolder?: unknown }).loadExtensionFolder
      }
    }
  } finally {
    for (const stop of unwatch) stop()
    for (const rec of windows) if (!rec.win.isDestroyed()) rec.win.close()
    await waitFor(() => windows.every((rec) => rec.win.isDestroyed()), 6000)
    for (const id of tabs) browser.dispatch({ type: 'tab/close', id })
    browser.dispatch({ type: 'space/select', id: home })
    for (const id of spaces) browser.dispatch({ type: 'space/delete', id })
    browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: sleepAfter } })
    // The folders loaded for this run are not an inheritance for the suites that follow.
    const loaded = (engine as unknown as { extensionPaths: Set<string> }).extensionPaths
    for (const path of Object.values(paths)) loaded.delete(path)
    server.close()
    server.closeAllConnections()
    rmSync(folder, { recursive: true, force: true })
  }
}

/** `LUCIUM_SMOKE_ONLY=extwindows`: only these checks, with their own report. */
export async function runExtWindowsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeExtWindows(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeExtWindows ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_EXTWINDOWS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
