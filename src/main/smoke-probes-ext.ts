// Engine checks that answer three open questions about extensions, run inside a real Electron with three probes of compat/ that the suite loads
// itself and takes out again (the other suites must not see them):
//  - compat/net-rules-probe: which request rules of an extension the engine applies. One check for each action of chrome.declarativeNetRequest
//    (block, allow, redirect, upgradeScheme, modifyHeaders on the request and on the answer, allowAllRequests) as a session rule, one for a block
//    rule of each other kind (dynamic, static), one for each event of chrome.webRequest, and one for a request of the worker of the extension
//    itself. Electron applies none of this in a session the application watches, so the application applies it (engine/extension-net.ts): each
//    is a check like any other, red when the rule is not applied, and the states go to the report of the run for `pnpm compat:compare`.
//    (A key that a later engine breaks, with its correction planned, can be put in `PUT_OFF` of smoke-probe-kit.ts: it is then counted as skipped.)
//  - compat/active-tab-scripting-probe: activeTab and scripting with no host permission. A click on the icon must let the extension run a script
//    in the tab on screen, and nothing else must: not before the click, not in another tab, not once the tab has gone to another site.
//  - compat/optional-permission-probe: nothing held by the manifest, one permission and one site listed as optional. A request is refused without a
//    click or a key, and for what the manifest does not list; after one, the sheet of the installation asks, and a yes is what chrome.permissions
//    answers, what the access rules count (the address of a tab, the API of the permission), what the Extensions page lists, and what is taken back.
// And corrections no engine had seen: a filter with several `*` on a long address (the main process must not stand still); the loan of activeTab,
// which must not come back with the tab to its origin; two probes the suite writes itself, whose workers check that one extension can neither
// listen in the name of another nor take its listener away; a folder whose manifest lists one site past the bound of the review, refused at its load.
// A local server is the only outside world. `LUCIUM_SMOKE_ONLY=probes-ext` runs this file alone; LUCIUM_EXTENSIONS is not needed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { app, webContents as allWebContents, type WebContents } from 'electron'
import { manifestTooLongMessage } from '@shared/extension-page'
import { LENT_BRIDGE_KEY, LENT_RUNTIME_KEY } from '@shared/lent-tab-runtime'
import { activeProfileId } from '@shared/profiles'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, reportFact, sleep, waiterOf, type CheckFn, type CheckRecord } from './smoke-kit'
import {
  blockObservation,
  BOUND_PROBE,
  BOUND_SITES,
  boundProbe,
  DYNAMIC_RULES,
  eventObservation,
  headerObservation,
  injected,
  LISTENED_EVENT,
  LISTENED_PATH,
  LISTENER_OWNER,
  LISTENER_SPY,
  listenedCookieOf,
  NET_PROBE,
  NET_PROBE_FOLDER,
  NP,
  NP_PATHS,
  NP_REQUEST_HEADER,
  OPTIONAL_PROBE,
  OPTIONAL_PROBE_FOLDER,
  OPTIONAL_PROBE_ORIGIN,
  OPTIONAL_PROBE_PERMISSION,
  overBlockObservation,
  ownerKept,
  pauseVerdict,
  redirectObservation,
  refusedInjection,
  requestScript,
  ruleCheck,
  ruleStates,
  SESSION_RULES,
  settled,
  SLOW_ADDRESS_PATH,
  SLOW_FILTER_RULE,
  TAB_PROBE,
  TAB_PROBE_FOLDER,
  upgradeObservation,
  WEB_REQUEST_EVENTS,
  withControl,
  type Fetched,
  type Injection,
  type RuntimeSeen,
  type Observation,
  type OwnerHeard,
  type RuleKey,
  type WrittenProbe
} from './smoke-probe-kit'


const waitFor = waiterOf(10_000, 80)

const RPC_PAGE = `<title>np-page</title><body>probe page<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
</script></body>`

/** What each key of the rule checks says when it holds. */
const WHAT: Record<RuleKey, string> = {
  'dnr.session.block': 'a block rule of the session stops the request it covers',
  'dnr.session.allow': 'an allow rule lets through a request that a block rule of a lower priority covers',
  'dnr.session.redirect': 'a redirect rule sends the request to the path it names',
  'dnr.session.upgradeScheme': 'an upgradeScheme rule sends an http request as https',
  'dnr.session.modifyHeaders.request': 'a modifyHeaders rule adds its header to the request the server receives',
  'dnr.session.modifyHeaders.response': 'a modifyHeaders rule adds its header to the answer the page reads',
  'dnr.session.allowAllRequests': 'an allowAllRequests rule on a frame lets through what the frame asks for, which a block rule covers',
  'dnr.dynamic.block': 'a block rule of the dynamic kind (kept on the disk) stops the request it covers',
  'dnr.static.block': 'a block rule of a static ruleset of the manifest stops the request it covers',
  'webRequest.onBeforeRequest': 'the listener of the extension hears a request before it is made',
  'webRequest.onBeforeSendHeaders': 'the listener of the extension hears the headers before they are sent',
  'webRequest.onSendHeaders': 'the listener of the extension hears the headers as they are sent',
  'webRequest.onHeadersReceived': 'the listener of the extension hears the headers of the answer',
  'webRequest.onAuthRequired': 'the listener of the extension hears a server that asks for a login',
  'webRequest.onBeforeRedirect': 'the listener of the extension hears a redirect of the server',
  'webRequest.onResponseStarted': 'the listener of the extension hears the start of the answer',
  'webRequest.onCompleted': 'the listener of the extension hears the end of the request',
  'webRequest.onErrorOccurred': 'the listener of the extension hears a request that fails'
}

/** The request each event of chrome.webRequest is expected for. */
const HEARD_PATH: Record<(typeof WEB_REQUEST_EVENTS)[number], string> = {
  onBeforeRequest: NP_PATHS.heardPlain,
  onBeforeSendHeaders: NP_PATHS.heardPlain,
  onSendHeaders: NP_PATHS.heardPlain,
  onHeadersReceived: NP_PATHS.heardPlain,
  onAuthRequired: NP_PATHS.heardAuth,
  onBeforeRedirect: NP_PATHS.heardRedirect,
  onResponseStarted: NP_PATHS.heardPlain,
  onCompleted: NP_PATHS.heardPlain,
  onErrorOccurred: NP_PATHS.heardError
}

interface Hit {
  path: string
  query: string
  header: string | null
}

export async function smokeProbesExt(ctx: SmokeContext, check: CheckFn): Promise<void> {
  const { store, engine } = ctx
  const profile = activeProfileId(store.get())

  // ---- the probes, loaded for this suite only: each one that does not load is a failed check with the reason the engine gave ----
  const loadedFolders: string[] = []
  const load = async (name: string, folder: string): Promise<{ id: string } | undefined> => {
    const path = join(app.getAppPath(), 'compat', folder)
    try {
      const info = await engine.loadExtension(profile, path)
      loadedFolders.push(path)
      check(`the probe extension "${name}" is loaded`, info.name === name, `${path} gave "${info.name}" (${info.id})`)
      return info.name === name ? info : undefined
    } catch (error) {
      check(`the probe extension "${name}" is loaded`, false, `${path}: ${String((error as Error)?.message ?? error)}`)
      return undefined
    }
  }
  const net = await load(NET_PROBE, NET_PROBE_FOLDER)
  const tabProbe = await load(TAB_PROBE, TAB_PROBE_FOLDER)
  const optionalProbe = await load(OPTIONAL_PROBE, OPTIONAL_PROBE_FOLDER)
  try {
    if (net || tabProbe || optionalProbe) await driveProbes(ctx, check, net, tabProbe, optionalProbe)
  } finally {
    // Whatever loaded leaves the profile, and is no inheritance for the profiles made after this suite: also a folder that gave another extension.
    const forget = engine as unknown as { forgetExtensionFolder(path: string): void }
    for (const path of loadedFolders) forget.forgetExtensionFolder(path)
  }
}

/** What the optional permission probe says of itself: what chrome.permissions answers, and what it can really do. */
interface OptionalState {
  containsPermission?: { ok: boolean; value?: unknown; error?: string }
  containsOrigin?: { ok: boolean; value?: unknown; error?: string }
  all?: { ok: boolean; value?: { permissions?: string[]; origins?: string[] }; error?: string }
  tabUrl?: string
  bookmarks?: { ok: boolean; value?: unknown; error?: string }
  events?: Array<{ event: string; permissions: string[]; origins: string[] }>
  error?: string
}

/** The checks themselves, once at least one of the probes is in the profile. */
async function driveProbes(ctx: SmokeContext, check: CheckFn, net: { id: string } | undefined, tabProbe: { id: string } | undefined, optionalProbe: { id: string } | undefined): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  const startTabs = new Set(store.get().tabs.map((t) => t.id))
  const prior = { sleepAfterMinutes: store.get().settings.sleepAfterMinutes, sidebarVisible: store.get().settings.sidebarVisible }
  // The pages that drive the probes must stay awake while the checks run.
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  // ---- the server: both `localhost` and `127.0.0.1` reach it (two sites for the tab that leaves its site) ----
  const hits: Hit[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    res.setHeader('cache-control', 'no-store')
    const text = (body: string): void => {
      res.setHeader('content-type', 'text/plain')
      res.end(body)
    }
    const html = (body: string): void => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    }
    if (path.startsWith(`${NP}/`)) {
      const header = req.headers[NP_REQUEST_HEADER]
      hits.push({ path, query: url.search, header: typeof header === 'string' ? header : null })
    }
    if (path === '/probe-page') return html(RPC_PAGE)
    if (path === NP_PATHS.control) return text('control')
    if (path === NP_PATHS.redirectFrom) return text('from')
    if (path === NP_PATHS.redirectTo) return text('to')
    if (path === NP_PATHS.frame) return html(`<title>np-frame</title><body>frame<script>fetch(${JSON.stringify(`${NP_PATHS.frameAsset}?in`)}, { cache: 'no-store' }).then(() => { document.title = 'np-frame: asset arrived' }, (e) => { document.title = 'np-frame: asset failed, ' + (e && e.name) })</script></body>`)
    if (path === NP_PATHS.heardRedirect) {
      res.statusCode = 302
      res.setHeader('location', `${NP_PATHS.heardPlain}?after`)
      return void res.end()
    }
    if (path === NP_PATHS.heardAuth) {
      res.statusCode = 401
      res.setHeader('www-authenticate', 'Basic realm="lucium-np"')
      return text('login asked')
    }
    if (path.startsWith(`${NP}/`)) return text('arrived')
    // A page the owner of the listeners hears of: it sets its own cookie (the event the owner listens to).
    const listened = listenedCookieOf(path)
    if (listened !== null) res.setHeader('set-cookie', listened)
    return html(`<title>at ${path}</title><body>at ${path}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const otherSite = `http://localhost:${port}`
  const count = (path: string, query?: string): number => hits.filter((hit) => hit.path === path && (query === undefined || hit.query === query)).length

  const wcOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  const titleOf = (tabId: string): string => store.get().tabs.find((t) => t.id === tabId)?.title ?? ''
  const openTab = async (url: string, title: string): Promise<{ id: string; wc: WebContents | undefined; loaded: boolean }> => {
    browser.dispatch({ type: 'tab/open', url })
    const tab = store.get().tabs.at(-1)!
    const loaded = (await waitFor(() => wcOf(tab.id) !== undefined)) && (await waitFor(() => titleOf(tab.id) === title))
    return { id: tab.id, wc: wcOf(tab.id), loaded }
  }

  try {
    const driver = await openTab(`${base}/probe-page`, 'np-page')
    check('probes-ext: the page that drives the probes loads', driver.loaded && driver.wc !== undefined, `title "${titleOf(driver.id)}"`)
    const page = driver.wc
    if (!page) return
    const run = <T>(script: string, otherwise: (why: string) => T, ms = 8000): Promise<T> => settled(page.executeJavaScript(script) as Promise<T>, otherwise, ms)
    const ask = <T>(extensionId: string, message: unknown, otherwise: (why: string) => T): Promise<T> => run(`window.rpc(${JSON.stringify(extensionId)}, ${JSON.stringify(message)})`, otherwise, 15_000)
    const request = (address: string): Promise<Fetched> => run<Fetched>(requestScript(address), (why) => ({ body: null, error: `the script of the page: ${why}` }))
    /** A worker that has just been loaded starts when it is first asked: it is asked until it answers. */
    const awake = (extensionId: string): Promise<boolean> => waitFor(async () => (await ask<{ ok?: boolean }>(extensionId, { type: 'ping' }, () => ({ ok: false }))).ok === true, 20_000)

    // ================= the request rules of an extension =================
    if (net) {
      try {
        check('net rules: the worker of the probe answers the page', await awake(net.id))
        const installed = await ask<Record<string, unknown>>(net.id, { type: 'install', session: SESSION_RULES, dynamic: DYNAMIC_RULES }, (why) => ({ fatal: why }))
        const said = JSON.stringify(installed)
        check(`net rules: the probe registered its ${SESSION_RULES.length} session rules (updateSessionRules, getSessionRules)`, installed['setSession'] === 'ok' && installed['session'] === SESSION_RULES.length, said)
        check('net rules: the probe registered its dynamic rule (updateDynamicRules, getDynamicRules)', installed['setDynamic'] === 'ok' && installed['dynamic'] === DYNAMIC_RULES.length, said)
        check('net rules: the static ruleset of its manifest is enabled (getEnabledRulesets)', Array.isArray(installed['rulesets']) && installed['rulesets'].includes('static'), said)
        await sleep(300)

        const control = await request(`${base}${NP_PATHS.control}`)
        const controlArrived = count(NP_PATHS.control) === 1 && control.body === 'control'
        check('net rules: the control request, which no rule covers, reaches the server and the page reads its answer', controlArrived, `the server saw it ${count(NP_PATHS.control)} time(s), the page got ${JSON.stringify(control)}`)

        const seen = new Map<RuleKey, Observation>()
        const note = (key: RuleKey, observation: Observation): Observation => {
          const kept = withControl(controlArrived, observation)
          seen.set(key, kept)
          return kept
        }
        // The request is made first, and the server is read once the page has its answer.
        const block = async (path: string): Promise<Observation> => {
          const fetched = await request(`${base}${path}`)
          return blockObservation(count(path), fetched)
        }

        const sessionBlock = note('dnr.session.block', await block(NP_PATHS.block))
        await request(`${base}${NP_PATHS.allow}`)
        note('dnr.session.allow', overBlockObservation(sessionBlock, count(NP_PATHS.allow)))
        note('dnr.session.redirect', redirectObservation(await request(`${base}${NP_PATHS.redirectFrom}`), { from: 'from', to: 'to' }))
        const upgraded = await request(`${base}${NP_PATHS.upgrade}`)
        note('dnr.session.upgradeScheme', upgradeObservation(count(NP_PATHS.upgrade), upgraded))
        const withHeaders = await request(`${base}${NP_PATHS.headers}`)
        const headerHit = hits.find((hit) => hit.path === NP_PATHS.headers)
        note('dnr.session.modifyHeaders.request', headerObservation(headerHit?.header, headerHit !== undefined, 'the server received'))
        note('dnr.session.modifyHeaders.response', headerObservation(withHeaders.responseHeader, withHeaders.body !== null, 'the page read'))
        // The same rule on a request the worker of the extension makes itself: an agent extension sets the headers of its own requests this way.
        const fromWorker = await ask<{ ok?: boolean; body?: string; error?: string }>(net.id, { type: 'fetch', url: `${base}${NP_PATHS.headers}?worker` }, (why) => ({ ok: false, error: why }))
        const workerHit = hits.find((hit) => hit.path === NP_PATHS.headers && hit.query === '?worker')
        check(
          'net rules: a modifyHeaders rule also adds its header to a request the worker of the extension makes itself',
          fromWorker.ok === true && workerHit?.header === '1',
          `the worker got ${JSON.stringify(fromWorker)}, the server received the header as ${workerHit === undefined ? 'no request at all' : JSON.stringify(workerHit.header)}`
        )

        // allowAllRequests: the block rule alone first (asked by the page itself), then the same path asked by a frame the rule covers.
        const assetFromTop = await request(`${base}${NP_PATHS.frameAsset}?top`)
        const assetBlocked = blockObservation(count(NP_PATHS.frameAsset, '?top'), assetFromTop)
        const frameLoaded = await run<string>(
          `new Promise((done) => { const f = document.createElement('iframe'); f.onload = () => setTimeout(() => done('loaded'), 900); f.src = ${JSON.stringify(NP_PATHS.frame)}; document.body.append(f); setTimeout(() => done('not loaded after 5 s'), 5000) })`,
          (why) => why
        )
        note(
          'dnr.session.allowAllRequests',
          count(NP_PATHS.frame) === 0 ? { state: 'unmeasured', saw: `the frame the rule covers did not reach the server (${frameLoaded})` } : overBlockObservation(assetBlocked, count(NP_PATHS.frameAsset, '?in'))
        )
        note('dnr.dynamic.block', await block(NP_PATHS.dynamicBlock))
        note('dnr.static.block', await block(NP_PATHS.staticBlock))

        // ---- chrome.webRequest: a plain request, a redirect, a server that asks for a login, a port nothing listens on ----
        await ask<unknown>(net.id, { type: 'heard' }, () => null)
        const closedPort = await new Promise<number>((resolve) => {
          const holder = createServer()
          holder.listen(0, '127.0.0.1', () => {
            const free = (holder.address() as AddressInfo).port
            holder.close(() => resolve(free))
          })
        })
        const made: Record<string, boolean> = {}
        made[NP_PATHS.heardPlain] = (await request(`${base}${NP_PATHS.heardPlain}`)).body === 'arrived'
        await request(`${base}${NP_PATHS.heardRedirect}`)
        made[NP_PATHS.heardRedirect] = count(NP_PATHS.heardRedirect) > 0
        // A server that asks for a login makes the window ask the user: the question is closed (a refusal), and the request ends on its 401.
        const loginAsked = request(`${base}${NP_PATHS.heardAuth}`)
        const panelShown = await waitFor(() => browser.currentPanel() === 'auth', 2500)
        if (panelShown) browser.closeOverlay()
        await loginAsked
        made[NP_PATHS.heardAuth] = count(NP_PATHS.heardAuth) > 0
        made[NP_PATHS.heardError] = (await request(`http://127.0.0.1:${closedPort}${NP_PATHS.heardError}`)).body === null
        await sleep(800)
        const heard = await ask<unknown>(net.id, { type: 'heard' }, (why) => why)
        for (const event of WEB_REQUEST_EVENTS) {
          const path = HEARD_PATH[event]
          note(`webRequest.${event}`, Array.isArray(heard) ? eventObservation(event, heard as Array<{ event?: unknown; url?: unknown; failed?: unknown }>, path, made[path] === true) : { state: 'unmeasured', saw: `the worker of the probe did not hand over what it heard: ${String(heard)}` })
        }

        for (const [key, observation] of seen) {
          const verdict = ruleCheck(key, WHAT[key], observation)
          check(verdict.name, verdict.ok, verdict.detail)
        }
        // The states go to the report of the run: `pnpm compat:compare` says which rule a later run lost.
        reportFact('extensionNetworkRules', ruleStates(seen))

        // ---- a filter with several `*` and a long address a page chooses: the main process judges it without standing still ----
        // In place of the rules above. Read as a regular expression (each `*` a `.*`), this filter held the main process for seconds on this
        // address, at every request; the check fails then on the pause, and on a request that never arrives.
        const slow = await ask<Record<string, unknown>>(net.id, { type: 'install', session: [SLOW_FILTER_RULE], dynamic: [] }, (why) => ({ fatal: why }))
        check(`net rules: the probe registered a block rule whose filter has several \`*\` (${SLOW_FILTER_RULE.condition.urlFilter})`, slow['setSession'] === 'ok' && slow['session'] === 1, JSON.stringify(slow))
        const pauses = monitorEventLoopDelay({ resolution: 10 })
        pauses.enable()
        const far = await request(`${base}${SLOW_ADDRESS_PATH}`)
        pauses.disable()
        const pause = pauseVerdict(pauses.max / 1e6, count(SLOW_ADDRESS_PATH), far)
        check(`net rules: a request of ${base.length + SLOW_ADDRESS_PATH.length} characters that repeats the parts of that filter is judged without the main process standing still, and arrives`, pause.ok, pause.detail)
        // The rules are taken out with the extension; the dynamic ones are written to the profile, so they are removed first.
        await ask<unknown>(net.id, { type: 'install', session: [], dynamic: [] }, () => null)
      } catch (error) {
        check('net rules: the checks ran to the end', false, String((error as Error)?.stack ?? error))
      }
    }

    // ================= activeTab: the access a click on the icon gives, and only that click =================
    if (tabProbe) {
      try {
        const target = await openTab(`${base}/at-a`, 'at /at-a')
        const other = await openTab(`${base}/at-b`, 'at /at-b')
        const targetNumber = engine.tabNumberOf(target.id) ?? -1
        const otherNumber = engine.tabNumberOf(other.id) ?? -1
        check('activeTab: the two pages of the check load', target.loaded && other.loaded && targetNumber >= 0 && otherNumber >= 0, `tabs ${targetNumber} and ${otherNumber}`)
        check('activeTab: the worker of the probe answers the page', await awake(tabProbe.id))
        const inject = (tabNumber: number): Promise<Injection> => ask<Injection>(tabProbe.id, { type: 'inject', tabId: tabNumber }, (why) => ({ ok: false, error: `no answer from the worker: ${why}` }))

        const before = await inject(targetNumber)
        check('activeTab: before any click on its icon, the extension is refused the script it asks to run in the tab', refusedInjection(before), JSON.stringify(before))

        // The click: the tab is on screen, and the icon of the toolbar is clicked the way the menu Extensions does it.
        browser.dispatch({ type: 'tab/select', id: target.id })
        await sleep(400)
        await browser.activateExtension(tabProbe.id)
        type Click = { tabId: number | null; hasUrl: boolean; inject: Injection }
        let clicks: Click[] = []
        const clicked = await waitFor(async () => {
          const answer = await ask<unknown>(tabProbe.id, { type: 'clicks' }, () => null)
          clicks = Array.isArray(answer) ? (answer as Click[]) : []
          return clicks.length > 0
        }, 8000)
        const click = clicks[0]
        check('activeTab: a click on the icon reaches the extension (action.onClicked), with the tab on screen', clicked && click?.tabId === targetNumber, `${JSON.stringify(clicks)} (the tab on screen is ${targetNumber})`)
        check(
          'activeTab: the click lets the extension run a script in that tab (chrome.scripting.executeScript, no host permission)',
          injected(click?.inject, 'at /at-a'),
          click ? JSON.stringify(click.inject) : 'the click never reached the extension, so the script was not tried'
        )
        const again = await inject(targetNumber)
        check('activeTab: ...and again a moment later, while the tab stays on the site', injected(again, 'at /at-a'), JSON.stringify(again))

        // What a script injected after the click has of the extension, in the isolated world (the default one): Chrome gives it the runtime, the storage and
        // the messages like a content script of the manifest, and an extension that injects its overlay on demand cannot start without them.
        const runtimeState = await ask<Injection>(tabProbe.id, { type: 'inject-runtime', tabId: targetNumber }, (why) => ({ ok: false, error: `no answer from the worker: ${why}` }))
        const seenByScript = (runtimeState.value ?? {}) as RuntimeSeen
        check(
          'activeTab: a script injected in the isolated world after the click has chrome.runtime.id, chrome.storage and chrome.runtime.onMessage',
          runtimeState.ok && seenByScript.runtimeId === tabProbe.id && seenByScript.storage === 'object' && seenByScript.onMessage === 'object' && seenByScript.sendMessage === 'function',
          JSON.stringify(runtimeState)
        )
        const workerHeard = await ask<Array<{ tabId: number | null; frameId: number | null; url: string | null; id: string | null }>>(tabProbe.id, { type: 'heard' }, () => [])
        check(
          'activeTab: ...its chrome.runtime.sendMessage reaches the worker of the extension, which answers it and sees the tab and the extension as the sender',
          seenByScript.roundTrip?.ok === true && seenByScript.roundTrip.tabId === targetNumber && workerHeard.some((entry) => entry.tabId === targetNumber && entry.frameId === 0 && entry.id === tabProbe.id && entry.url === `${base}/at-a`),
          `the script got ${JSON.stringify(seenByScript.roundTrip ?? seenByScript.roundTripError)}, the worker heard ${JSON.stringify(workerHeard)}`
        )
        const stored = await ask<{ ok: boolean; value?: unknown; error?: string }>(tabProbe.id, { type: 'stored' }, (why) => ({ ok: false, error: why }))
        check(
          "activeTab: ...its chrome.storage.local is the storage of the extension (what it writes, the worker reads)",
          seenByScript.storageBack === 'written by the tab' && stored.ok && stored.value === 'written by the tab',
          `the script read back ${JSON.stringify(seenByScript.storageBack ?? seenByScript.storageError)}, the worker reads ${JSON.stringify(stored)}`
        )
        const told = await ask<{ ok: boolean; value?: { ok?: boolean; heard?: unknown; title?: unknown; senderId?: unknown } | null; error?: string }>(tabProbe.id, { type: 'tell', tabId: targetNumber, value: 'hello tab' }, (why) => ({ ok: false, error: why }))
        check(
          'activeTab: ...a message of the worker (chrome.tabs.sendMessage) reaches its chrome.runtime.onMessage listener, and the answer comes back',
          told.ok && told.value?.ok === true && told.value.heard === 'hello tab' && told.value.title === 'at /at-a' && told.value.senderId === tabProbe.id,
          JSON.stringify(told)
        )
        const mainWorld = await settled(Promise.resolve(target.wc?.executeJavaScript(`JSON.stringify({ storage: typeof (globalThis.chrome && globalThis.chrome.storage), names: Object.getOwnPropertyNames(globalThis).filter((name) => ['${LENT_BRIDGE_KEY}', '${LENT_RUNTIME_KEY}', '__probeListening'].includes(name)) })`)), (why) => `no answer: ${why}`, 4000)
        check('activeTab: ...and none of it is given to the page itself (its main world has no chrome.storage, no bridge, no runtime and none of the names of the script)', mainWorld === '{"storage":"undefined","names":[]}', String(mainWorld))
        const elsewhere = await inject(otherNumber)
        check('activeTab: the click gives nothing on another tab', refusedInjection(elsewhere), JSON.stringify(elsewhere))
        // Another document of the same origin keeps the loan: what follows is about leaving the origin, not about any navigation.
        browser.pageFor(target.id)?.loadURL(`${base}/at-a2`)
        const moved = await waitFor(() => titleOf(target.id) === 'at /at-a2')
        const sameOrigin = await inject(targetNumber)
        check('activeTab: another document of the same origin in the tab keeps the loan', moved && injected(sameOrigin, 'at /at-a2'), `the tab moved: ${moved}, ${JSON.stringify(sameOrigin)}`)
        browser.pageFor(target.id)?.loadURL(`${otherSite}/at-c`)
        const left = await waitFor(() => titleOf(target.id) === 'at /at-c')
        const after = await inject(targetNumber)
        check('activeTab: once the tab has gone to another site, the extension is refused again', left && refusedInjection(after), `the tab left: ${left}, ${JSON.stringify(after)}`)
        // The loan ends for good when the tab leaves the origin: Back brings the tab to the origin it was lent on, and nothing comes back with it.
        // Before the correction the loan only slept while the tab was elsewhere, and woke up here with no click of the person.
        // Waited for by its address: a page the back-forward cache gives back may not send its title again.
        const tabContents = target.wc
        const backed = tabContents?.navigationHistory.canGoBack() === true
        if (backed) tabContents?.navigationHistory.goBack()
        const returned = backed && (await waitFor(() => tabContents?.isDestroyed() === false && tabContents.getURL() === `${base}/at-a2` && !tabContents.isLoading()))
        const comeBack = await inject(targetNumber)
        check('activeTab: back on the origin it was lent on (Back), with no new click, the extension is still refused', returned && refusedInjection(comeBack), `Back possible: ${backed}, the tab is back at ${tabContents?.isDestroyed() === false ? tabContents.getURL() : 'a page that is gone'}: ${returned}, ${JSON.stringify(comeBack)}`)
      } catch (error) {
        check('activeTab: the checks ran to the end', false, String((error as Error)?.stack ?? error))
      }
    }

    // ================= optional permissions: granted by the person only, on the sheet, and taken back =================
    if (optionalProbe) {
      try {
        const profile = activeProfileId(store.get())
        const driverNumber = engine.tabNumberOf(driver.id) ?? -1
        const wanted = { permissions: [OPTIONAL_PROBE_PERMISSION], origins: [OPTIONAL_PROBE_ORIGIN] }
        type Said = { ok: boolean; value?: unknown; error?: string }
        const stateNow = (): Promise<OptionalState> => ask<OptionalState>(optionalProbe.id, { type: 'state', tabId: driverNumber }, (why) => ({ error: why }))
        const request = (what: unknown): Promise<Said> => ask<Said>(optionalProbe.id, { type: 'request', what }, (why) => ({ ok: false, error: `no answer from the worker: ${why}` }))
        const journal = (): string[] => engine.extensionTools.readJournal({ profileId: profile, extensionId: optionalProbe.id }).map((entry) => entry.message)
        const grantedNow = (): string => String(engine.listAllExtensions().find((e) => e.id === optionalProbe.id && e.profileId === profile)?.grantedCount ?? 0)
        // The clock of the last click or key is the engine's own: put back to "never", so that what follows is a request no gesture explains.
        const clock = engine as unknown as { lastUserInput: number }
        const gesture = (): void => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
        const sheetShown = (ms: number): Promise<boolean> => waitFor(() => browser.currentPanel() === 'extreview', ms)
        const clickSheet = (label: string): Promise<boolean> =>
          overlayView.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.adlg-ext .adlg-btn')].find((x) => x.textContent.startsWith(${JSON.stringify(label)})); b?.click(); return !!b })()`) as Promise<boolean>

        check('optional permissions: the worker of the probe answers the page', await awake(optionalProbe.id))
        const before = await stateNow()
        check(
          'optional permissions: before anything is granted, the extension holds nothing: chrome.permissions says so, the address of a tab is hidden, the API of the optional permission is refused',
          before.containsPermission?.value === false && before.containsOrigin?.value === false && JSON.stringify(before.all?.value) === JSON.stringify({ permissions: [], origins: [] }) && before.tabUrl === 'hidden' && before.bookmarks?.ok === false && String(before.bookmarks?.error).includes('no permission'),
          JSON.stringify(before)
        )

        clock.lastUserInput = 0
        const unasked = await request(wanted)
        check('optional permissions: a request that follows no click or key is refused, and no sheet is shown', unasked.ok === false && String(unasked.error).includes('user gesture') && browser.currentPanel() !== 'extreview', JSON.stringify(unasked))
        check('optional permissions: the journal of the extension says why, in the words of the interface', journal().some((line) => line.includes(OPTIONAL_PROBE_PERMISSION) && line.includes('sans que vous ayez cliqué')), JSON.stringify(journal()))

        gesture()
        const tooMuch = await request({ permissions: ['history'] })
        check('optional permissions: after a key, a request for what the manifest does not list as optional is still refused without a sheet', tooMuch.ok === false && String(tooMuch.error).includes('specified in the manifest') && browser.currentPanel() !== 'extreview', JSON.stringify(tooMuch))

        // A no first: nothing is held.
        gesture()
        const refusing = request(wanted)
        const shownOnce = await sheetShown(8000)
        const sheet = shownOnce ? (browser.currentOverlay() as { request?: { mode?: string; profile?: string; review?: { name?: string; permissions?: Array<{ id: string; level: string }>; sites?: { patterns?: string[] } } } }).request : undefined
        check(
          'optional permissions: after a key, the sheet of the installation asks, for this extension, with only what is asked for',
          shownOnce && sheet?.mode === 'optional' && sheet.review?.name === OPTIONAL_PROBE && JSON.stringify(sheet.review.permissions?.map((p) => p.id)) === JSON.stringify([OPTIONAL_PROBE_PERMISSION]) && JSON.stringify(sheet.review.sites?.patterns) === JSON.stringify([OPTIONAL_PROBE_ORIGIN]),
          JSON.stringify(sheet ?? browser.currentPanel())
        )
        if (shownOnce) await clickSheet('Annuler')
        const refused = await refusing
        const afterNo = await stateNow()
        check('optional permissions: "Annuler" grants nothing', refused.ok === true && refused.value === false && afterNo.containsPermission?.value === false && afterNo.tabUrl === 'hidden' && grantedNow() === '0', JSON.stringify({ refused, afterNo }))

        // Then a yes.
        gesture()
        const granting = request(wanted)
        const shownTwice = await sheetShown(8000)
        if (shownTwice) await clickSheet('Autoriser')
        const granted = await granting
        // The event that tells the extension travels to its worker after the answer: it is waited for, not guessed at.
        let held = await stateNow()
        await waitFor(async () => (held = await stateNow()).events?.length === 1, 3000)
        check('optional permissions: "Autoriser" answers the request with a yes', shownTwice && granted.ok === true && granted.value === true, JSON.stringify(granted))
        check(
          'optional permissions: chrome.permissions.contains and getAll say what was granted, and onAdded told the extension',
          held.containsPermission?.value === true && held.containsOrigin?.value === true && JSON.stringify(held.all?.value) === JSON.stringify(wanted) && JSON.stringify(held.events) === JSON.stringify([{ event: 'added', ...wanted }]),
          JSON.stringify(held)
        )
        check(
          'optional permissions: what was granted enters the access rules: the address of the tab is read, and the API of the permission is no longer refused for want of it',
          held.tabUrl === 'read' && !String(held.bookmarks?.error ?? '').includes('no permission'),
          JSON.stringify({ tabUrl: held.tabUrl, bookmarks: held.bookmarks })
        )
        check('optional permissions: the list of the extensions counts the two grants, for the Extensions page', grantedNow() === '2', grantedNow())
        clock.lastUserInput = 0
        const again = await request(wanted)
        check('optional permissions: asked again for what it holds, the extension gets a yes with no sheet and no gesture', again.ok === true && again.value === true && browser.currentPanel() !== 'extreview', JSON.stringify(again))

        // The extension gives the permission back; the person takes the site back.
        const removed = await ask<Said>(optionalProbe.id, { type: 'remove', what: { permissions: [OPTIONAL_PROBE_PERMISSION] } }, (why) => ({ ok: false, error: why }))
        const revoked = engine.extensionTools.revokeGranted(profile, optionalProbe.id, OPTIONAL_PROBE_ORIGIN)
        let after = await stateNow()
        await waitFor(async () => (after = await stateNow()).events?.length === 3, 3000)
        check(
          'optional permissions: given back by the extension (remove) and taken back by the person (the Extensions page), nothing is held any more, and onRemoved told the extension each time',
          removed.ok === true && removed.value === true && revoked && after.containsPermission?.value === false && after.containsOrigin?.value === false && after.tabUrl === 'hidden' && String(after.bookmarks?.error).includes('no permission') && JSON.stringify(after.events?.slice(1)) === JSON.stringify([{ event: 'removed', permissions: [OPTIONAL_PROBE_PERMISSION], origins: [] }, { event: 'removed', permissions: [], origins: [OPTIONAL_PROBE_ORIGIN] }]) && grantedNow() === '0',
          JSON.stringify({ removed, revoked, after })
        )
      } catch (error) {
        check('optional permissions: the checks ran to the end', false, String((error as Error)?.stack ?? error))
      } finally {
        if (browser.currentPanel() === 'extreview') browser.closeOverlay()
        // Nothing of the probe stays in the profile of the run.
        for (const name of [OPTIONAL_PROBE_PERMISSION, OPTIONAL_PROBE_ORIGIN]) engine.extensionTools.revokeGranted(activeProfileId(store.get()), optionalProbe.id, name)
      }
    }

    // The probes below are written by the suite in a folder of its own, loaded, then taken out of the profile and removed with the folder.
    const writtenRoot = mkdtempSync(join(tmpdir(), 'lucium-probes-ext-'))
    const written: string[] = []
    const profileId = activeProfileId(store.get())
    const writeProbe = (folder: string, probe: WrittenProbe): void => {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify(probe.manifest, null, 2))
      writeFileSync(join(folder, 'background.js'), probe.worker)
    }
    /** Writes a probe and loads it; undefined, with a failed check that says why, when the engine does not take it. */
    const loadWritten = async (folder: string, probe: WrittenProbe): Promise<{ id: string } | undefined> => {
      writeProbe(folder, probe)
      const name = String(probe.manifest['name'])
      try {
        const info = await engine.loadExtension(profileId, folder)
        written.push(folder)
        check(`the probe extension "${name}" is loaded`, info.name === name, `${folder} gave "${info.name}" (${info.id})`)
        return info.name === name ? info : undefined
      } catch (error) {
        check(`the probe extension "${name}" is loaded`, false, `${folder}: ${String((error as Error)?.message ?? error)}`)
        return undefined
      }
    }
    try {
      // ================= the listeners of a worker: the events of its own extension, and no other's =================
      try {
        const owner = await loadWritten(join(writtenRoot, 'owner'), LISTENER_OWNER)
        const spy = await loadWritten(join(writtenRoot, 'spy'), LISTENER_SPY)
        if (owner && spy) {
          const realWarn = console.warn
          const warned: string[] = []
          try {
            check('worker listeners: the workers of the two probes answer the page', (await awake(owner.id)) && (await awake(spy.id)))
            const heardNow = (): Promise<OwnerHeard> => ask<OwnerHeard>(owner.id, { type: 'heard' }, (why) => ({ error: why }))
            const pageOf = (n: number): string => `${LISTENED_PATH}${n}`
            let control: OwnerHeard = {}
            const first = await openTab(`${base}${pageOf(1)}`, `at ${pageOf(1)}`)
            const heardFirst = await waitFor(async () => (control = await heardNow()).heard?.includes(pageOf(1)) === true)
            check('worker listeners (control): the worker of an extension hears the changes of the cookies it listens to', first.loaded && heardFirst, JSON.stringify(control))
            // Each refusal is a line of the main process: it is read there, and it also says that the message of the worker was handled.
            console.warn = (...args: unknown[]) => {
              warned.push(args.map(String).join(' '))
              realWarn(...args)
            }
            const refused = (what: string): boolean => warned.some((line) => line.includes(`refused ${what} of ${LISTENED_EVENT} in the name of ${owner.id} from the extension ${spy.id}`))
            type Said = { ok?: boolean; error?: string }
            const added = await ask<Said>(spy.id, { type: 'add', extensionId: owner.id, event: LISTENED_EVENT }, (why) => ({ ok: false, error: why }))
            const addRefused = added.ok === true && (await waitFor(() => refused('a listener'), 5000))
            check('worker listeners: a worker that names another extension to hear its events is refused, and the log says so', addRefused, JSON.stringify({ added, log: warned.slice(-3) }))
            const removed = await ask<Said>(spy.id, { type: 'remove', extensionId: owner.id, event: LISTENED_EVENT }, (why) => ({ ok: false, error: why }))
            const removeRefused = removed.ok === true && (await waitFor(() => refused('the removal of a listener'), 5000))
            check('worker listeners: ...and so is one that takes the listener of another extension away', removeRefused, JSON.stringify({ removed, log: warned.slice(-3) }))
            // Before the correction the library took the listener of the owner away for the spy: the owner then heard nothing more of its cookies.
            const second = await openTab(`${base}${pageOf(2)}`, `at ${pageOf(2)}`)
            let after: OwnerHeard = {}
            await waitFor(async () => (after = await heardNow()).heard?.includes(pageOf(2)) === true, 8000)
            const kept = ownerKept(control, after, pageOf(2))
            check('worker listeners: the extension the other one named still hears its own events afterwards', second.loaded && kept.ok, kept.detail)
            const stolen = await ask<{ stolen?: unknown }>(spy.id, { type: 'stolen' }, (why) => ({ stolen: why }))
            check('worker listeners: the worker that named the other extension heard none of its events', stolen.stolen === 0, JSON.stringify(stolen))
          } finally {
            console.warn = realWarn
            // The cookies of the two pages go: they hold for every port of 127.0.0.1, where the suites after this one have their servers.
            await run(`document.cookie = 'lw-1=; Max-Age=0; Path=/'; document.cookie = 'lw-2=; Max-Age=0; Path=/'`, () => undefined)
          }
        }
      } catch (error) {
        check('worker listeners: the checks ran to the end', false, String((error as Error)?.stack ?? error))
      }

      // ================= a folder whose manifest lists more than the review reads: refused by every load of the engine =================
      try {
        const over = join(writtenRoot, 'bound-over')
        const atBound = join(writtenRoot, 'bound-at')
        writeProbe(over, boundProbe(BOUND_SITES.over))
        writeProbe(atBound, boundProbe(BOUND_SITES.at))
        const said = manifestTooLongMessage()
        const refusal = await engine.loadExtension(profileId, over).then(
          (info) => {
            written.push(over)
            return `loaded as ${info.name} (${info.id})`
          },
          (error: unknown) => String((error as Error)?.message ?? error)
        )
        const handed = page.session.extensions.getAllExtensions().filter((extension) => extension.name === BOUND_PROBE).map((extension) => extension.path)
        check(`manifest bound: a folder whose manifest lists ${BOUND_SITES.over} sites is refused by the engine with the sentence of the Extensions page, and Chromium is never handed it`, refusal === said && handed.length === 0, `the load gave "${refusal}"; Chromium holds ${JSON.stringify(handed)}`)
        const journal = engine.extensionTools.readJournal({ profileId }).filter((entry) => entry.where === over).map((entry) => entry.message)
        check('manifest bound: ...and the journal of the extensions says why, for that folder', journal.includes(said), JSON.stringify(journal))
        const control = await engine.loadExtension(profileId, atBound).then(
          (info) => {
            written.push(atBound)
            return info.name
          },
          (error: unknown) => `refused: ${String((error as Error)?.message ?? error)}`
        )
        check(`manifest bound (control): the same folder with ${BOUND_SITES.at} sites, the bound itself, loads`, control === BOUND_PROBE, control)
      } catch (error) {
        check('manifest bound: the checks ran to the end', false, String((error as Error)?.stack ?? error))
      }
    } finally {
      const forget = engine as unknown as { forgetExtensionFolder(path: string): void }
      for (const folder of written) forget.forgetExtensionFolder(folder)
      rmSync(writtenRoot, { recursive: true, force: true })
    }
  } finally {
    if (browser.currentPanel() === 'auth') browser.closeOverlay()
    for (const tab of store.get().tabs) if (!startTabs.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.dispatch({ type: 'settings/update', patch: prior })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=probes-ext`: only these checks, with their own report (the detail of every check, passed or not, says what was seen). */
export async function runProbesExtSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  try {
    await smokeProbesExt(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeProbesExt ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_PROBES_EXT ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
