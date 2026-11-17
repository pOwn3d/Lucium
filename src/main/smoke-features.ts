// Engine checks for the switches of the optional features (shared/features.ts, shell/feature-gate.ts), run inside a real Electron.
// The point is the rule "a feature that is off costs nothing": for each feature that is tied to its setting by a gate, the setting is
// switched off and the checks look for what could still be running for it: its timers and its subscriptions to the state (counted by
// wrapping setTimeout, setInterval and StateStore.subscribe while the suite runs, each entry tagged with the code that made it), its
// listeners on the window, and the requests it would make (a local server counts them). Then the setting goes back on and the feature must
// be back, so that the gate is shown to work both ways. The last part drives the switches of the features in the Settings window the way a user
// does: there is no "Fonctions" pane any more, each feature is switched in the category of its setting.
// `LUCIUM_SMOKE_ONLY=features` runs only this file (see index.ts).

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, net, session, type WebContents } from 'electron'
import { adsBlockingPatch } from '@shared/blocker'
import { costSentence, defaultFeaturesPatch, featureById, featurePatch, FEATURES, isFeatureOn, isFeatureShownOn, type FeatureId } from '@shared/features'
import { SETTINGS_PAGES, type SettingsPage } from '@shared/ipc'
import { MEDIA_BRIDGE } from '@shared/media-player'
import { defaultSettings, type Settings } from '@shared/model'
import { CATALOGUE_FEATURES, categoryResetPlan, FEATURE_ONLY_SWITCHES, isResettable, SETTINGS_KEYS, settingsPaneLabel, type SettingKey } from '@shared/settings-catalog'
import { BackupFiles } from './backup-store'
import type { SmokeContext } from './smoke'
import { AutoUpdater, gateAutoUpdate } from './shell/auto-update'
import { SessionBackups, gateBackups } from './shell/backups'
import { FeatureGates, runningGates } from './shell/feature-gate'
import { SessionWriter, gateWindowMemory } from './shell/session'
import { getWindowManager } from './shell/windows'
import { StateStore } from './store'
import { noteCheck, OPEN_MORE_SETTINGS, recorderOf, sleep, waiterOf } from './smoke-kit'
import { frenchSpaces } from '@shared/french-typography'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 60)

// ---------- what is running: timers and subscriptions, tagged with the code that made them ----------

interface Live {
  kind: 'timeout' | 'interval' | 'subscription'
  /** `gate:<feature>` (the feature whose gate started the code that made the entry, empty for none), the kind, then the source of the callback and
   *  the stack of the call that made the entry: what a pattern is matched against. */
  tag: string
}

/** What a pattern matches for a feature: the entries its gate made (see `trackResources`), or a name of its code (kept by a build that is not minified). */
const madeBy = (feature: FeatureId, name: string): RegExp => new RegExp(`^gate:${feature}\\n|${name}`)

/**
 * Wraps the timers of the main process and the subscriptions to the state store until `restore()`. A timer is live from its creation to its
 * firing or its clearing (an `unref`'d one counts too, which `process.getActiveResourcesInfo()` would not show).
 *
 * Each entry is tagged with the feature that made it. The names of the code are not enough: the build the engine tests run is minified
 * (electron.vite.config.ts), which drops the names of the callbacks and of the classes from their source and from the stacks unless it keeps them
 * (LUCIUM_KEEP_NAMES=1, which pnpm test:engine sets), and a build without them must not pass for a feature that owns nothing. So the start of a gate
 * (shell/feature-gate.ts, the `begin` of its gates) runs in a context named after its feature, which Node carries into the timers and the promises
 * that code makes; a listener of the state takes back the context of the code that subscribed it, and a change of the state itself belongs to no
 * feature (the save of the store, the listeners of others).
 */
function trackResources() {
  const live = new Map<object, Live>()
  const owner = new AsyncLocalStorage<FeatureId>()
  // The class of a gate is not exported: its prototype is that of a gate made on a store of nothing, at once disposed of.
  const sample = new FeatureGates({ get: () => ({ settings: { autoUpdate: false } }) as never, subscribe: () => () => undefined }).gate('auto-update', { start() {} })
  sample.dispose()
  const gateProto = Object.getPrototypeOf(sample) as { begin: (this: { id: FeatureId }) => void }
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
    subscribe: StateStore.prototype.subscribe,
    dispatch: StateStore.prototype.dispatch,
    replace: StateStore.prototype.replace,
    begin: gateProto.begin
  }
  gateProto.begin = function (this: { id: FeatureId }) {
    return owner.run(this.id, () => real.begin.call(this))
  }
  StateStore.prototype.dispatch = function (this: StateStore, ...args: Parameters<StateStore['dispatch']>) {
    return owner.exit(() => real.dispatch.apply(this, args))
  }
  StateStore.prototype.replace = function (this: StateStore, ...args: Parameters<StateStore['replace']>) {
    return owner.exit(() => real.replace.apply(this, args))
  }
  // The owner, the kind, then the name of the callback, its source and the stack of the call: a bundle built with the names kept (LUCIUM_KEEP_NAMES=1)
  // carries the names in the last three.
  const tagOf = (kind: Live['kind'], callback: unknown): string => `gate:${owner.getStore() ?? ''}\n${kind}\n${typeof callback === 'function' ? `${callback.name}\n${Function.prototype.toString.call(callback).slice(0, 600)}` : ''}\n${new Error().stack ?? ''}`
  const asAny = globalThis as unknown as Record<string, unknown>
  asAny['setTimeout'] = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer: object = real.setTimeout(((...rest: unknown[]) => {
      live.delete(timer)
      return callback(...rest)
    }) as never, ms, ...args) as unknown as object
    live.set(timer, { kind: 'timeout', tag: tagOf('timeout', callback) })
    return timer
  }
  asAny['setInterval'] = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = real.setInterval(callback as never, ms, ...args) as unknown as object
    live.set(timer, { kind: 'interval', tag: tagOf('interval', callback) })
    return timer
  }
  asAny['clearTimeout'] = (timer: object) => {
    live.delete(timer)
    return real.clearTimeout(timer as never)
  }
  asAny['clearInterval'] = (timer: object) => {
    live.delete(timer)
    return real.clearInterval(timer as never)
  }
  StateStore.prototype.subscribe = function (this: StateStore, listener) {
    const feature = owner.getStore()
    const heard: typeof listener = feature === undefined ? listener : (state) => owner.run(feature, () => listener(state))
    const undo = real.subscribe.call(this, heard)
    const entry = {}
    live.set(entry, { kind: 'subscription', tag: tagOf('subscription', listener) })
    return () => {
      live.delete(entry)
      undo()
    }
  }
  return {
    /** How many live timers and subscriptions were made by code that matches the pattern. */
    count: (pattern: RegExp) => [...live.values()].filter((entry) => pattern.test(entry.tag)).length,
    /** A short description of them, for the detail of a failed check. */
    // The owner (gate:<feature>), then the first frame of the stack that is not the wrapper of this file.
    describe: (pattern: RegExp) => [...live.values()].filter((entry) => pattern.test(entry.tag)).map((entry) => `${entry.kind}:${entry.tag.split('\n')[0]}:${(entry.tag.split('\n').find((l) => /\bat \S+/.test(l) && !/smoke-features/.test(l)) ?? '').trim()}`).join(' | '),
    restore() {
      Object.assign(asAny, { setTimeout: real.setTimeout, setInterval: real.setInterval, clearTimeout: real.clearTimeout, clearInterval: real.clearInterval })
      StateStore.prototype.subscribe = real.subscribe
      StateStore.prototype.dispatch = real.dispatch
      StateStore.prototype.replace = real.replace
      gateProto.begin = real.begin
    }
  }
}

// ---------- a local site that counts what it is asked ----------

interface Site {
  base: string
  host: string
  hits: string[]
  server: Server
}

async function startSite(handler?: (req: IncomingMessage, res: ServerResponse) => void): Promise<Site> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/')
    if (handler) return handler(req, res)
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><html><head><title>Site</title><link rel="icon" href="/i.png"></head><body>x</body></html>')
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, hits, server }
}

const closeSite = (site: Site): Promise<void> =>
  new Promise((resolve) => {
    site.server.closeAllConnections()
    site.server.close(() => resolve())
  })

// ---------- the suite ----------

export async function smokeFeatures(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const settings = (): Settings => store.get().settings
  const set = (patch: Partial<Settings>) => browser.dispatch({ type: 'settings/update', patch })
  const keys = [...new Set(FEATURES.map((f) => f.key))] as Array<keyof Settings>
  const before = Object.fromEntries(keys.map((key) => [key, settings()[key]])) as Partial<Settings>
  // The archive delay can also be set by a profile: the checks below start from none, and put back what was there.
  const profilesBefore = settings().profiles
  const tracker = trackResources()
  const cleanups: Array<() => void | Promise<void>> = []

  try {
    // Every feature that has a cost is started in the state the run found it in: a default one is on, and these checks begin from there.
    set({ sleepAfterMinutes: 30, resolveFavicons: true, hoverCards: true, littleArcArchiveHours: 12, autoBackup: true, autoUpdate: true, restoreWindows: true, autoArchiveHours: 12, profiles: {}, mediaPlayer: true })

    /** Switch off, look for what is left, switch on, look for what came back. */
    const exercise = async (name: string, on: Partial<Settings>, off: Partial<Settings>, pattern: RegExp) => {
      // Off and on once first: what was started before the counting began is not in the counts, what the gate starts now is.
      set(off)
      set(on)
      const running = tracker.count(pattern)
      check(`${name}: while it is on, it owns timers or subscriptions`, running >= 1, `found ${running}`)
      set(off)
      await sleep(50)
      const left = tracker.count(pattern)
      check(`${name}: switched off, no timer and no subscription of it is left`, left === 0, `left: ${tracker.describe(pattern)}`)
      set(on)
      const back = tracker.count(pattern)
      check(`${name}: switched on again, it is back`, back >= 1, `found ${back}`)
    }

    // ---- 0. control: the counters see what is left behind, and whose it is ----
    // The probes write a property of their name: a minified build drops the name of a function, never that of a property.
    const probeMarks = { leakedTimerProbe: 0, leakedFeatureProbe: 0, gatedTimerProbe: 0, gatedLaterProbe: 0, stateListenerProbe: 0 }
    const leakedTimer = setInterval(function leakedTimerProbe() {
      probeMarks.leakedTimerProbe++
    }, 60_000)
    leakedTimer.unref()
    // A store of its own: the window's view wraps a listener in an arrow of its own, which would hide the name of the probe.
    const probeStore = new StateStore(store.get(), null)
    const leakedSubscription = probeStore.subscribe(function leakedFeatureProbe() {
      probeMarks.leakedFeatureProbe++
      return undefined
    })
    check('control: a timer left running is counted', tracker.count(/leakedTimerProbe/) >= 1, tracker.describe(/leakedTimerProbe/))
    check('control: a subscription to the state left open is counted', tracker.count(/leakedFeatureProbe/) >= 1, tracker.describe(/leakedFeatureProbe/))
    check('control: …neither is taken for a feature’s', tracker.count(/^gate:\n(interval|subscription)\n[\s\S]*(leakedTimerProbe|leakedFeatureProbe)/) === 2, tracker.describe(/leakedTimerProbe|leakedFeatureProbe/))
    // The probes are found by the property they write whatever the build; their own names (the line after the kind) say whether the bundle kept the names of
    // its code, which tell whose a timer is beside its gate (one made outside the start of a gate, by a handler the feature set up, is known by its name only).
    const namesKept = tracker.count(/^gate:\n(interval|subscription)\n(leakedTimerProbe|leakedFeatureProbe)\n/) === 2
    check('control: the main process was built with the names of its code kept, so they count beside the gates', namesKept, namesKept ? tracker.describe(/leakedTimerProbe|leakedFeatureProbe/) : 'the main process was built without its names (LUCIUM_KEEP_NAMES=1, set by pnpm test:engine): only the gates tell whose a timer is')
    clearInterval(leakedTimer)
    leakedSubscription()
    check('control: …and they are not once cleared', tracker.count(/leakedTimerProbe|leakedFeatureProbe/) === 0)
    // A gate of its own, on the throw-away store (whose settings say the copies are on): what its start makes is the feature's, and so is a timer
    // that a timer of the feature makes later. A change of the state the feature makes is not: a listener of the state that is nobody's makes a
    // timer of nobody, though the change came from the feature.
    const later: Array<ReturnType<typeof setTimeout>> = []
    const unlisten = probeStore.subscribe(() => {
      later.push(setTimeout(() => {
        probeMarks.stateListenerProbe++
      }, 60_000))
    })
    const probeGates = new FeatureGates(probeStore)
    probeGates.gate('auto-backup', {
      start() {
        const timer = setTimeout(() => {
          probeMarks.gatedTimerProbe++
          later.push(setTimeout(() => {
            probeMarks.gatedLaterProbe++
          }, 60_000))
        }, 1)
        probeStore.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: probeStore.get().settings.sleepAfterMinutes === 7 ? 8 : 7 } })
        return () => clearTimeout(timer)
      }
    })
    // The first timer holds the source of the second: it is gone from the count once it has fired, and only the second is left to be counted.
    const fired = await waitFor(() => probeMarks.gatedTimerProbe === 1, 2000)
    check('control: a timer that a timer of a gated feature makes is that feature’s', fired && tracker.count(/gatedTimerProbe/) === 0 && tracker.count(/^gate:auto-backup\ntimeout\n[\s\S]*gatedLaterProbe/) === 1, tracker.describe(/gatedTimerProbe|gatedLaterProbe/))
    check('control: …and a change of the state it makes is nobody’s (the listener of the state, not the feature, made that timer)', tracker.count(/^gate:\ntimeout\n[\s\S]*stateListenerProbe/) === 1 && tracker.count(/^gate:auto-backup\n[\s\S]*stateListenerProbe/) === 0, tracker.describe(/stateListenerProbe/))
    probeGates.disposeAll()
    unlisten()
    for (const timer of later) clearTimeout(timer)
    check('control: …all of it gone once cleared', tracker.count(/^gate:auto-backup\n|gatedLaterProbe|stateListenerProbe/) === 0, tracker.describe(/^gate:auto-backup\n|gatedLaterProbe|stateListenerProbe/))

    // ---- 1. the sleep sweep (Browser) ----
    await exercise('sleep', { sleepAfterMinutes: 30 }, { sleepAfterMinutes: 0 }, madeBy('sleep', 'sleepSweep'))

    // ---- 1b. the archive sweep: off only when the general delay and every profile's are "Jamais" ----
    const archiveSweep = madeBy('auto-archive', 'archiveSweepTick')
    await exercise('auto-archive', { autoArchiveHours: 12 }, { autoArchiveHours: 0 }, archiveSweep)
    set({ autoArchiveHours: 0, profiles: { 'smoke-archive': { autoArchiveHours: 6 } } })
    check('auto-archive: a profile with a delay of its own keeps the sweep though the general delay is "Jamais"', tracker.count(archiveSweep) >= 1, tracker.describe(archiveSweep))
    set({ profiles: {} })
    check('auto-archive: …and the sweep is gone once that delay is too', tracker.count(archiveSweep) === 0, tracker.describe(archiveSweep))
    set({ autoArchiveHours: 12 })

    // ---- 2. the little windows sweep ----
    await exercise('little-archive', { littleArcArchiveHours: 12 }, { littleArcArchiveHours: 0 }, madeBy('little-archive', 'littleArcSweep'))

    // ---- 3. the pictures of the hover cards (ipc.ts) ----
    const site = await startSite()
    cleanups.push(() => closeSite(site))
    const openedTabs: string[] = []
    cleanups.push(() => {
      for (const id of openedTabs) browser.dispatch({ type: 'tab/close', id })
    })
    await exercise('hover-cards', { hoverCards: true }, { hoverCards: false }, madeBy('hover-cards', 'Thumbnails'))
    // A page shown starts two shots while the cards are on; none while they are off, and nothing is answered to the sidebar.
    set({ hoverCards: true })
    browser.dispatch({ type: 'tab/open', url: `${site.base}/une-page` })
    const tab = store.get().tabs.at(-1)
    if (tab) openedTabs.push(tab.id)
    check('hover-cards: a page shown while they are on is shot after a delay', await waitFor(() => tracker.count(/this\.shoot\(/) >= 1, 3000), tracker.describe(/shoot/))
    set({ hoverCards: false })
    check('hover-cards: …and the shots that were waiting are cancelled when they go off', tracker.count(/this\.shoot\(/) === 0, tracker.describe(/shoot/))
    browser.dispatch({ type: 'tab/open', url: `${site.base}/une-autre` })
    const other = store.get().tabs.at(-1)
    if (other) openedTabs.push(other.id)
    // No wait: the shots are planned as the state changes, inside the dispatch (shell/thumbnails.ts, `onState`), or not at all.
    check('hover-cards: a page shown while they are off starts no shot', tracker.count(/this\.shoot\(/) === 0, tracker.describe(/shoot/))
    const picture = await win.webContents.executeJavaScript(`window.lucium.tabThumbnail(${JSON.stringify(other?.id ?? '')})`)
    check('hover-cards: …and the sidebar is told there is no picture', picture === null)
    set({ hoverCards: true })

    // ---- 4. the lookup of site icons (Browser): subscriptions, timers, requests ----
    await exercise('favicons', { resolveFavicons: true }, { resolveFavicons: false }, madeBy('favicons', 'FaviconService'))
    set({ resolveFavicons: true })
    check('favicons: the lookup exists while the setting is on', browser.faviconLookup() !== null)
    check('favicons: …and does not exist while it is off', (set({ resolveFavicons: false }), browser.faviconLookup() === null))
    const asked = await startSite()
    const notAsked = await startSite()
    cleanups.push(() => closeSite(asked), () => closeSite(notAsked))
    const favorites: string[] = []
    cleanups.push(() => {
      for (const id of favorites) browser.dispatch({ type: 'favorite/remove', id })
    })
    const addFavorite = (target: Site, title: string) => {
      browser.dispatch({ type: 'favorite/add', url: `${target.base}/section/page`, title })
      const added = store.get().favorites.find((f) => f.title === title)
      if (added) favorites.push(added.id)
    }
    // The setting is off: a favourite without an icon is not looked up.
    addFavorite(notAsked, 'Favori sans recherche')
    // A fixed wait, for want of a witness: what is checked is that time passes with no request, and nothing comes to say that none will.
    await sleep(3500)
    check('favicons: with the setting off, a favourite without an icon makes no request to its site', notAsked.hits.length === 0, notAsked.hits.join())
    // Switched on again, the lookup is new: told which local host it may ask (production never asks a host of this machine), it asks.
    set({ resolveFavicons: true })
    browser.faviconLookup()?.allowHostsForTest([asked.host, notAsked.host])
    addFavorite(asked, 'Favori avec recherche')
    check('favicons: with the setting on, the site of a favourite without an icon is asked', await waitFor(() => asked.hits.includes('/'), 8000), asked.hits.join())
    check('favicons: …and the favourite that waited while it was off is looked up as soon as it is back', await waitFor(() => notAsked.hits.includes('/'), 8000), notAsked.hits.join())
    const requestsOn = asked.hits.length
    set({ resolveFavicons: false })
    const more = await startSite()
    cleanups.push(() => closeSite(more))
    addFavorite(more, 'Favori ajouté en pause')
    // A fixed wait, for want of a witness: what is checked is that time passes with no request, and nothing comes to say that none will.
    await sleep(3500)
    check('favicons: switched off again, nothing more is asked of anyone', more.hits.length === 0 && asked.hits.length === requestsOn, `${more.hits.length} ${asked.hits.length}/${requestsOn}`)
    set({ resolveFavicons: true })

    // ---- 5. the automatic copies: a service of its own over the real store, tied to the setting the way index.ts does ----
    const copiesDir = mkdtempSync(join(tmpdir(), 'lucium-features-copies-'))
    cleanups.push(() => rmSync(copiesDir, { recursive: true, force: true }))
    const gates = new FeatureGates(store)
    cleanups.push(() => gates.disposeAll())
    const backups = new SessionBackups({
      files: new BackupFiles(join(copiesDir, 'copies')),
      state: () => store.get(),
      subscribe: (listener) => store.subscribe(() => listener()),
      apply: () => undefined,
      toast: () => undefined
    })
    gateBackups(gates, backups)
    await exercise('auto-backup', { autoBackup: true }, { autoBackup: false }, madeBy('auto-backup', 'SessionBackups'))
    check('auto-backup: the gate reports the copies as running only while the setting is on', runningGates().includes('auto-backup'))
    set({ autoBackup: false })
    check('auto-backup: …and not once it is off', !runningGates().includes('auto-backup'))
    set({ autoBackup: true })

    // ---- 6. the update look: a feed that is a local server, delays shortened to fractions of a second ----
    const feed = await startSite((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: 'v1.0.0', html_url: 'https://example.org/releases/1.0.0' }))
    })
    cleanups.push(() => closeSite(feed))
    const updater = new AutoUpdater({
      settings,
      version: '1.0.0',
      feed: (current) => (current.autoUpdate ? 'https://feed.example/latest' : null),
      delays: { firstMs: 150, periodMs: 400 },
      fetchFeed: async () => {
        // Asked the way the application asks its feed (net.fetch). Node's own fetch keeps the connection open for a few seconds under a timer of its
        // own, which is made while the gate runs and so counted as the feature's: « all off » then found a timer that no code of the feature owns.
        const answer = await net.fetch(`${feed.base}/latest`)
        return { ok: true as const, json: await answer.json() }
      },
      notify: () => true,
      remember: () => undefined
    })
    set({ autoUpdate: false })
    // No wait: the gate decides as it is made (feature-gate.ts), and the feed is asked only from the two timers it would start, counted here.
    gateAutoUpdate(gates, updater)
    check('auto-update: with the setting off the feed is never asked and no timer exists', feed.hits.length === 0 && tracker.count(/this\.check\(\)/) === 0, `${feed.hits.length} ${tracker.describe(/this\.check\(\)/)}`)
    set({ autoUpdate: true })
    check('auto-update: switched on, it owns its two timers', tracker.count(/this\.check\(\)/) === 2, tracker.describe(/this\.check\(\)/))
    check('auto-update: …and asks the feed soon, then again at each period', await waitFor(() => feed.hits.length >= 2, 4000), `${feed.hits.length} requests`)
    // No wait: switching off clears the two timers at once (auto-update.ts, `stop`), and they are the only way the feed is asked.
    set({ autoUpdate: false })
    const asks = feed.hits.length
    check('auto-update: switched off, no timer is left and the feed is not asked again', tracker.count(/this\.check\(\)/) === 0 && feed.hits.length === asks, `${feed.hits.length}/${asks} ${tracker.describe(/this\.check\(\)/)}`)
    set({ autoUpdate: true })
    check('auto-update: switched on again, it asks again', await waitFor(() => feed.hits.length > asks, 4000), `${feed.hits.length}/${asks}`)
    set({ autoUpdate: false })

    // ---- 7. the memory of the windows: the real window and the real manager, in a throw-away file ----
    const windowsFile = join(copiesDir, 'windows.json')
    const manager = getWindowManager()
    const writer = new SessionWriter(windowsFile, manager)
    const fakeApp = new (await import('node:events')).EventEmitter()
    const baseline = { resize: win.listenerCount('resize'), move: win.listenerCount('move'), close: win.listenerCount('close') }
    set({ restoreWindows: false })
    gateWindowMemory(gates, { win, app: fakeApp as never, windows: manager, writer })
    check('restore-windows: with the setting off the window has no listener of it', win.listenerCount('resize') === baseline.resize && win.listenerCount('move') === baseline.move && win.listenerCount('close') === baseline.close && fakeApp.listenerCount('before-quit') === 0)
    // The witness is the writer: a move heard plans its save at once (shell/session.ts, `changed`), so a move nobody listens to leaves it with none.
    const pendingSave = () => (writer as unknown as { timer: unknown }).timer !== null
    win.emit('move')
    check('restore-windows: …and a move writes nothing', !pendingSave() && !existsSync(windowsFile))
    set({ restoreWindows: true })
    check('restore-windows: switched on, the window is listened to', win.listenerCount('resize') === baseline.resize + 1 && win.listenerCount('move') === baseline.move + 1 && win.listenerCount('close') === baseline.close + 1 && fakeApp.listenerCount('before-quit') === 1)
    check('restore-windows: …and the windows are saved as they are at once', await waitFor(() => existsSync(windowsFile), 3000))
    set({ restoreWindows: false })
    check('restore-windows: switched off again, every listener is gone', win.listenerCount('resize') === baseline.resize && win.listenerCount('move') === baseline.move && win.listenerCount('close') === baseline.close && fakeApp.listenerCount('before-quit') === 0)
    set({ restoreWindows: true })

    // ---- 7b. the media player's script: in the sessions only while the player is on ----
    const defaultSession = session.fromPartition('persist:profile-default')
    const bridgeIn = (ses: typeof defaultSession) => ses.getPreloadScripts().some((script) => script.id === 'lucium-media-bridge')
    set({ mediaPlayer: true })
    check('media-player: while it is on, the pages of the profile carry the media bridge and its channels are served', bridgeIn(defaultSession) && ipcMain.listenerCount(MEDIA_BRIDGE.actions) === 1)
    set({ mediaPlayer: false })
    check('media-player: switched off, the session carries no bridge and its channels are not served', !bridgeIn(defaultSession) && ipcMain.listenerCount(MEDIA_BRIDGE.actions) === 0)
    set({ mediaPlayer: true })
    check('media-player: switched on again, the bridge and its channels are back', bridgeIn(defaultSession) && ipcMain.listenerCount(MEDIA_BRIDGE.actions) === 1)

    // ---- 7c. the scripts of the extension runtime: in a session only once an extension is to be loaded into it ----
    const runtimeScripts = ['lucium-shims-sw', 'lucium-shims-frame', 'crx-mv2-preload', 'crx-mv3-preload', 'lucium-patches-sw', 'lucium-patches-frame']
    const carried = (ses: typeof defaultSession) => ses.getPreloadScripts().map((script) => script.id).filter((id) => runtimeScripts.includes(id))
    // A profile made now also loads the folders loaded by hand in the others (the engine does that for each new profile). Where there are some
    // (the whole chain loads the probe extensions at launch, and other suites load more), the profile has an extension to load as it is made and
    // its session must carry the six scripts; where there are none, nothing is loaded into it and it must carry none.
    const inherited = ctx.engine.inheritedExtensionFolders()
    // Asking for the cookies of a profile makes its session, with the rest of what a profile has.
    await ctx.engine.siteCookieCount('smoke-zerocost', 'example.com', false)
    const fresh = session.fromPartition('persist:profile-smoke-zerocost')
    if (inherited === 0) check('extensions: a profile session that has loaded no extension carries none of the six scripts of their runtime', carried(fresh).length === 0, carried(fresh).join())
    else check(`extensions: a profile made while ${inherited} folder(s) loaded by hand exist loads them, and its session carries all six scripts, in order`, carried(fresh).join() === runtimeScripts.join(), carried(fresh).join())
    if (ctx.engine.listExtensions().some((extension) => extension.profileId === 'default')) {
      check('extensions: the default profile loaded one, and carries all six scripts', [...carried(defaultSession)].sort().join() === [...runtimeScripts].sort().join(), carried(defaultSession).join())
      check('extensions: …those of the library between the two passes of ours', carried(defaultSession).join() === runtimeScripts.join(), carried(defaultSession).join())
    }

    // ---- 8. everything off at once: nothing of the features that are tied to a gate is running ----
    set({ sleepAfterMinutes: 0, littleArcArchiveHours: 0, hoverCards: false, resolveFavicons: false, autoBackup: false, autoUpdate: false, restoreWindows: false, autoArchiveHours: 0 })
    // As for each feature above: a moment for what the stops end.
    await sleep(50)
    const all = /^gate:(sleep|auto-archive|little-archive|hover-cards|favicons|auto-backup|auto-update)\n|sleepSweep|littleArcSweep|Thumbnails|FaviconService|SessionBackups|this\.check\(\)|archiveSweepTick/
    check('all off: no timer and no subscription of any gated feature remains', tracker.count(all) === 0, tracker.describe(all))
    const stillGated = runningGates().filter((id) => ['sleep', 'auto-archive', 'little-archive', 'hover-cards', 'favicons', 'auto-backup', 'auto-update', 'restore-windows'].includes(id))
    check('all off: no gate reports its feature as running', stillGated.length === 0, stillGated.join())
    set({ sleepAfterMinutes: 30, littleArcArchiveHours: 12, hoverCards: true, resolveFavicons: true, autoBackup: true, autoUpdate: true, restoreWindows: true, autoArchiveHours: 12 })
    const back = { sleep: madeBy('sleep', 'sleepSweep'), archive: madeBy('auto-archive', 'archiveSweepTick'), little: madeBy('little-archive', 'littleArcSweep'), cards: madeBy('hover-cards', 'Thumbnails'), favicons: madeBy('favicons', 'FaviconService'), backups: madeBy('auto-backup', 'SessionBackups') }
    check('all on again: the same features are back', Object.values(back).every((pattern) => tracker.count(pattern) >= 1), JSON.stringify(Object.fromEntries(Object.entries(back).map(([name, pattern]) => [name, tracker.count(pattern)]))))
    gates.disposeAll()
    check('the exit of the application stops what the gates started', tracker.count(back.backups) === 0 && tracker.count(/this\.check\(\)/) === 0 && win.listenerCount('resize') === baseline.resize, tracker.describe(back.backups))

    // ---- 9. the switches in the Settings window ----
    await smokePane(ctx, check, set)
  } finally {
    tracker.restore()
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch((error: unknown) => console.error('[smoke-features] cleanup failed:', error))
    set({ ...before, profiles: profilesBefore })
  }
}

// ---------- the switches in the Settings window ----------

const settingsWindows = () => BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Réglages')

/**
 * The features in the Settings window, driven the way a user does. The features to add are the lines of « Fonctions en option » (CATALOGUE_FEATURES),
 * each with its cost said in a sentence; the others are switched in the category of their setting, and the ones with no row of their own by a switch of
 * their own there (FEATURE_ONLY_SWITCHES), with no mark of their cost.
 */
async function smokePane(ctx: SmokeContext, check: Check, set: (patch: Partial<Settings>) => void): Promise<void> {
  const { browser, store } = ctx
  const run = <T>(wc: WebContents, script: string) => wc.executeJavaScript(script) as Promise<T>
  const settings = (): Settings => store.get().settings
  // The reset below acts on the whole of Onglets et fenêtres: what the category holds now is put back at the end.
  const tabsBefore = Object.fromEntries((SETTINGS_KEYS.tabs as readonly SettingKey[]).filter(isResettable).map((key) => [key, structuredClone(settings()[key])])) as Partial<Settings>
  set({ ...defaultFeaturesPatch(), sleepMode: 'freeze' })
  browser.openOverlay({ panel: 'settings', pane: 'home' })
  check('the Settings window opens', await waitFor(() => settingsWindows().length === 1))
  const wc = settingsWindows()[0]!.webContents
  const current = () => run<{ cat: string | null; heading: string }>(wc, `({ cat: document.querySelector('.settings-cat[aria-current=page]')?.getAttribute('data-cat') ?? null, heading: document.querySelector('#pane-heading')?.textContent ?? '' })`)
  /** Shows a page with a click on its entry in the sidebar, waits until its name heads the content, and opens its « Plus de réglages ». */
  const show = async (pane: SettingsPage): Promise<boolean> => {
    await run(wc, `document.querySelector('.settings-cat[data-cat=${JSON.stringify(pane)}]')?.click()`)
    const shown = await waitFor(async () => {
      const now = await current()
      return now.cat === pane && now.heading === settingsPaneLabel(pane)
    })
    return shown && (await waitFor(() => run<boolean>(wc, OPEN_MORE_SETTINGS), 3000))
  }
  check('…titled “Réglages”, on « Pour commencer »', (await waitFor(async () => (await run<string>(wc, `document.querySelector('.settings-title')?.textContent ?? ''`)) === 'Réglages')) && (await show('home')), JSON.stringify(await current()))

  const labelOf = (id: FeatureId) => featureById(id).label
  /** The first switch of the content with this name, as a script expression (null when there is none). */
  const switchOf = (label: string) => `[...document.querySelectorAll('.settings-content input[role=switch]')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(label)})`
  /** The switch of the row of a setting, as a script expression; `scope` narrows it (the results of a search). */
  const switchOfKey = (key: string, scope = '.settings-content') => `document.querySelector(${JSON.stringify(`${scope} .pref-row[data-setting~="${key}"]:not([hidden]) input[role=switch]`)})`

  // The preferences with no row of their own: each is drawn in its category, with its name and the state of its setting, and no mark of its cost.
  const onlyHere = Object.entries(FEATURE_ONLY_SWITCHES) as Array<[FeatureId, SettingsPage]>
  for (const pane of SETTINGS_PAGES) {
    const ids = onlyHere.filter(([, where]) => where === pane).map(([id]) => id)
    if (ids.length === 0) continue
    const name = settingsPaneLabel(pane)
    check(`${name}: the category is shown`, await show(pane), JSON.stringify(await current()))
    const rows = await run<Array<{ checked: boolean; mark: boolean } | null>>(
      wc,
      `${JSON.stringify(ids.map(labelOf))}.map((label) => { const s = [...document.querySelectorAll('.settings-content input[role=switch]')].find((x) => x.getAttribute('aria-label') === label); return s ? { checked: s.checked, mark: !!s.closest('.pref-row')?.querySelector('.cost-mark, .pref-cost') } : null })`
    )
    check(`${name}: each feature with no row of its own has its switch here, showing the state of its setting`, rows.every((row, n) => row !== null && row.checked === isFeatureShownOn(settings(), ids[n]!)), JSON.stringify(ids.map((id, n) => [id, rows[n]])))
    check(`${name}: …and says nothing of its cost (only « Fonctions en option » says it)`, rows.every((row) => row !== null && !row.mark), JSON.stringify(ids.map((id, n) => [id, rows[n]?.mark])))
  }

  // « Fonctions en option »: the 29 features to add, one line each, with the state of its setting and its cost said in a sentence.
  check('Fonctions en option is shown', await show('features'), JSON.stringify(await current()))
  const lines = await run<Array<{ key: string; checked: boolean; label: string; cost: string }>>(
    wc,
    `[...document.querySelectorAll('.settings-content .pref-feature')].map((row) => ({ key: row.dataset.setting, checked: row.querySelector('input[role=switch]').checked, label: row.querySelector('input[role=switch]').getAttribute('aria-label'), cost: row.querySelector('.pref-cost')?.textContent ?? '' }))`
  )
  const expected = CATALOGUE_FEATURES.map((id) => ({ key: featureById(id).key, checked: isFeatureShownOn(settings(), id), label: labelOf(id), cost: costSentence(featureById(id)) }))
  check('…one line for each feature to add, in its order, with its name, the state of its setting and its cost in a sentence', JSON.stringify(lines) === JSON.stringify(expected), JSON.stringify(lines.filter((line, n) => JSON.stringify(line) !== JSON.stringify(expected[n]))))

  // The lock changes only through its own handler (the interface is refused a patch that names it): Vie privée et sécurité shows it with a button that
  // asks for a phrase, never a switch the interface could flip.
  const lockBefore = settings().lockEnabled
  check('(control) the lock is off at this point of the run (the suite of the lock switches it off again)', lockBefore === false)
  check('Vie privée et sécurité is shown', await show('protection'), JSON.stringify(await current()))
  const lockRow = await run<{ switches: number; button: boolean } | null>(
    wc,
    `(() => { const group = document.querySelector('.pref-section#lock'); const row = group?.querySelector('.pref-row[data-setting~="lockEnabled"]'); return row ? { switches: group.querySelectorAll('input[role=switch]').length, button: [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Choisir une phrase…') } : null })()`
  )
  check('the lock has its row in the group “Verrouillage”, with a button that asks for a phrase and no switch', lockRow?.switches === 0 && lockRow.button === true, JSON.stringify(lockRow))
  const pressIn = (scope: string, text: string) => run<boolean>(wc, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true })()`)
  const asked = (await pressIn('.pref-section#lock', 'Choisir une phrase…')) && (await waitFor(() => run<boolean>(wc, `!!document.querySelector('.pref-section#lock input[aria-label="Nouvelle phrase du verrou"]')`), 3000))
  // The witness: what the click sent, it sent while it ran; a question asked after it on the same channel is answered once the main process has handled it.
  await run(wc, 'window.lucium.getSnapshot().then(() => 0)')
  check('…a click on it asks for the phrase and changes nothing by itself', asked && settings().lockEnabled === lockBefore)
  await pressIn('.pref-section#lock', 'Annuler')
  check('…and “Annuler” puts the button back', await waitFor(() => run<boolean>(wc, `!document.querySelector('.pref-section#lock input[aria-label="Nouvelle phrase du verrou"]')`), 3000))

  // Each control writes the setting of its feature. The sleep is a preset (PresetSettings.tsx): a group of radio buttons named as the feature, one
  // button per level, at the top of its group.
  check('Onglets et fenêtres is shown', await show('tabs'), JSON.stringify(await current()))
  const pick = (label: string, option: string) =>
    run<boolean>(wc, `(() => { const b = document.querySelector(${JSON.stringify(`.settings-content .preset-row [role=radiogroup][aria-label="${label}"] [role=radio][data-option="${option}"]`)}); if (!b) return false; b.click(); return true })()`)
  check('the buttons of the sleep of the tabs are there', await pick(labelOf('sleep'), 'jamais'))
  check('…and “Jamais” writes the delay 0 (the feature off)', await waitFor(() => settings().sleepAfterMinutes === 0), String(settings().sleepAfterMinutes))
  // The control draws the new level before the next click (a click on a level that still shows the old one is built on it).
  await waitFor(() => run<boolean>(wc, `document.querySelector('.settings-content .preset-row [role=radio][data-option="jamais"]')?.getAttribute('aria-checked') === 'true'`))
  await pick(labelOf('sleep'), 'equilibre')
  check('…and “Équilibré” writes 30', await waitFor(() => settings().sleepAfterMinutes === 30), String(settings().sleepAfterMinutes))
  // The tree of tabs is a feature to add: its switch is a line of « Fonctions en option ».
  check('Fonctions en option is shown again', await show('features'), JSON.stringify(await current()))
  const treeWasOn = isFeatureOn(settings(), 'tab-tree')
  const clickSwitch = (expression: string) => run<boolean>(wc, `(() => { const s = ${expression}; if (!s || s.disabled) return false; s.click(); return true })()`)
  check('the switch of the tree of tabs is clicked', await clickSwitch(switchOf(labelOf('tab-tree'))))
  check('…and it writes the setting its feature names', await waitFor(() => settings().tabTree === featurePatch('tab-tree', !treeWasOn)['tabTree']), String(settings().tabTree))
  // The category draws the new state before it is clicked again (a click on a switch that still shows the old one would repeat the old change).
  await waitFor(() => run<boolean>(wc, `${switchOf(labelOf('tab-tree'))}?.checked === ${!treeWasOn}`))
  await clickSwitch(switchOf(labelOf('tab-tree')))
  check('…and back when clicked again', await waitFor(() => settings().tabTree === treeWasOn), String(settings().tabTree))

  // The search of the window draws the rows of every category again, the real ones: a switch of a result and the one of the category agree.
  const type = (text: string) =>
    run(wc, `(() => { const i = document.querySelector('.settings-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const inResults = '.settings-results'
  // The ad blocker is on by default (and the reset to the defaults at the top of this part switched it on), and its one switch shows and writes blockAds and its
  // alias blockTrackers together (shared/blocker.ts, adsBlockingOn / adsBlockingPatch): both are switched off first, so that the switch starts off, and are put back afterwards.
  const blockerBefore = { blockAds: settings().blockAds, blockTrackers: settings().blockTrackers }
  set(adsBlockingPatch(false))
  await type('publicités')
  check('a search for “publicités” shows the switch of the ad blocker, off', await waitFor(() => run<boolean>(wc, `${switchOfKey('blockAds', inResults)}?.checked === false`)))
  await clickSwitch(switchOfKey('blockAds', inResults))
  check('…switched on in the results, it writes blockAds (and its alias blockTrackers)', await waitFor(() => settings().blockAds === true && settings().blockTrackers === true), JSON.stringify({ blockAds: settings().blockAds, blockTrackers: settings().blockTrackers }))
  await type('')
  await show('protection')
  check('…and Vie privée et sécurité shows it on, the two agreeing', await waitFor(() => run<boolean>(wc, `${switchOfKey('blockAds')}?.checked === true`)))
  await clickSwitch(switchOfKey('blockAds'))
  check('…switched off there, the setting follows (both of them)', await waitFor(() => settings().blockAds === false && settings().blockTrackers === false), JSON.stringify({ blockAds: settings().blockAds, blockTrackers: settings().blockTrackers }))
  await type('publicités')
  check('…and the result of the search shows it off', await waitFor(() => run<boolean>(wc, `${switchOfKey('blockAds', inResults)}?.checked === false`)))
  set(blockerBefore)

  // What a search keeps: the rows that name the words, case and accents aside; the window counts them in its heading.
  const units = `[...document.querySelectorAll('.settings-results :is(.pref-row, .pref-callout, .pref-buttons, .icon-grid)')]`
  const shown = () => run<string[]>(wc, `${units}.filter((u) => !u.hidden).map((u) => u.dataset.setting || u.dataset.search || u.textContent.trim().slice(0, 80)).sort()`)
  const total = () => run<number>(wc, `${units}.length`)
  const heading = () => run<string>(wc, `document.querySelector('.settings-results h2')?.textContent ?? ''`)
  /** Types the query and waits for the heading to name it: the window has filtered its rows by then. */
  const search = async (query: string): Promise<string[]> => {
    await type(query)
    await waitFor(async () => (await heading()).includes(frenchSpaces(`« ${query} »`)))
    await sleep(150)
    return shown()
  }
  const upper = await search('VEILLE')
  const lower = await search('veille')
  check(
    'a search keeps the rows that name it, case aside, among them the delay of the sleep',
    upper.length > 0 && upper.length < (await total()) && upper.includes('sleepAfterMinutes') && JSON.stringify(upper) === JSON.stringify(lower),
    `${upper.length} shown of ${await total()}; ${JSON.stringify(upper.slice(0, 8))}`
  )
  check('…and the heading counts them', (await heading()).startsWith(`${lower.length} réglage`), await heading())
  const accented = await search('mémoire')
  const plain = await search('MEMOIRE')
  check('…and accents aside (“mémoire” and “MEMOIRE” keep the same rows)', accented.length > 0 && JSON.stringify(accented) === JSON.stringify(plain), `${accented.length} / ${plain.length}`)
  await type('zzzz')
  check('a search that matches nothing says so', (await waitFor(async () => (await shown()).length === 0)) && (await waitFor(async () => (await run<string>(wc, `document.querySelector('.settings-empty')?.textContent ?? ''`)).includes(frenchSpaces('Rien ne correspond à « zzzz »')))))
  await type('')
  check('an empty search shows the category again', await waitFor(async () => (await run<boolean>(wc, `!document.querySelector('.settings-results')`)) && (await current()).cat === 'protection'))

  // "Rétablir les valeurs par défaut" of a category: its settings back to their default, the others untouched, and the notice can undo it.
  set({ sleepAfterMinutes: 0, tidyPinnedTitles: !defaultSettings().tidyPinnedTitles, blockAds: true, autoUpdate: false })
  check('Onglets et fenêtres is shown again', await show('tabs'), JSON.stringify(await current()))
  const plan = categoryResetPlan('tabs', settings())
  const info = () => run<string>(wc, `document.querySelector('.reset-bar #reset-info')?.textContent ?? ''`)
  check('the bar under the category counts its settings that left their default', !!plan && plan.keys.includes('sleepAfterMinutes') && plan.keys.includes('tidyPinnedTitles') && (await waitFor(async () => (await info()).startsWith(`${plan.keys.length} réglage`))), `${await info()} / ${JSON.stringify(plan?.keys)}`)
  const resetButton = `document.querySelector('.reset-bar .button')`
  const atDefaults = () => !!plan && plan.keys.every((key) => JSON.stringify(settings()[key]) === JSON.stringify(defaultSettings()[key]))
  check('its button is “Rétablir les valeurs par défaut”', (await run<string>(wc, `${resetButton}?.textContent.trim() ?? ''`)) === 'Rétablir les valeurs par défaut')
  await run(wc, `${resetButton}?.click()`)
  check('…it puts the settings of the category back to their default', await waitFor(atDefaults), JSON.stringify(plan?.keys.filter((key) => JSON.stringify(settings()[key]) !== JSON.stringify(defaultSettings()[key]))))
  check('…and touches no other category, nor the lock', settings().blockAds === true && settings().autoUpdate === false && settings().lockEnabled === lockBefore)
  const notice = () => run<string>(wc, `document.querySelector('.settings-toast')?.textContent ?? ''`)
  check('…and a notice says how many, with “Annuler”', await waitFor(async () => (await notice()).startsWith(frenchSpaces(`${plan?.keys.length ?? 0} réglage`)) && (await notice()).includes(frenchSpaces('« Onglets et fenêtres »')) && (await notice()).includes('Annuler')), await notice())
  await run(wc, `[...document.querySelectorAll('.settings-toast button')].find((b) => b.textContent.trim() === 'Annuler')?.click()`)
  check('…“Annuler” puts back what the category held', await waitFor(() => !!plan && plan.keys.every((key) => JSON.stringify(settings()[key]) === JSON.stringify(plan.undo[key]))))
  await waitFor(async () => (await info()).startsWith(`${plan?.keys.length ?? 0} réglage`))
  await run(wc, `${resetButton}?.click()`)
  await waitFor(atDefaults)
  check('with every setting of the category at its default, the bar says so and its button is disabled', await waitFor(async () => (await info()) === 'Rien n’a été modifié dans cette catégorie.' && (await run<boolean>(wc, `${resetButton}?.disabled === true`))), await info())

  settingsWindows().forEach((w) => w.close())
  await waitFor(() => settingsWindows().length === 0, 3000)
  set(tabsBefore)
}

export async function runFeaturesSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeFeatures(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeFeatures ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_FEATURES ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
