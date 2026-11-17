// What the two suites of open questions (smoke-probes-web.ts, smoke-probes-ext.ts) decide with, apart from Electron: what a page said it read, what
// a request rule of an extension did, and how each observation becomes a check. Each of these suites answers a question nobody had measured (does a
// local page read another site, do the request rules of extensions apply at all, does a click on an icon hand the tab over...). A check of theirs is
// green or red for a reason its detail gives, so every observation is turned into words here, and the unit tests run these functions.
// The checks written for corrections that no engine had seen yet decide here too (the last part of the file), for those suites and for
// smoke-sec2.ts, smoke-market.ts and smoke-ollama.ts: each verdict is tested without Electron, with what it would say if the correction went away.
// The Client Hints check (smoke-client-hints.ts) keeps its pure part in the last section: what the server received and what the page read, side by side, and the verdict.
// No Electron here: only the suites import this file, so it lands in a smoke*.js chunk that the package leaves out.

import { createHash } from 'node:crypto'
import { MANIFEST_LIST_MAX } from '@shared/chrome-compat'
import { isPrivateNetworkAddress } from '@shared/ollama'
import { skippedBecause } from './smoke-kit'

// ---------------------------------------------------------------- what a page read ----------------------------------------------------------------

/**
 * A script for a page: reads `address` with fetch and answers one line, never throwing and never waiting more than three seconds.
 * `read:<text>` when the page holds the text, `opaque` when the answer came without its text, `refused:<error>` when the read was refused.
 * `how` is the way the page asks (the `mode` and the `credentials` of fetch), for the checks that try each of them.
 */
export const fetchScript = (address: string, how: { mode?: 'cors' | 'same-origin' | 'no-cors'; credentials?: 'include' } = {}): string =>
  `Promise.race([fetch(${JSON.stringify(address)}, ${JSON.stringify({ cache: 'no-store', ...how })}).then((r) => (r.type === 'opaque' ? 'opaque' : r.text().then((t) => 'read:' + t.slice(0, 200))), (e) => 'refused:' + (e && e.name) + ': ' + (e && e.message)), new Promise((done) => setTimeout(() => done('refused:no answer after 3 s'), 3000))])`

/** The same read with XMLHttpRequest. */
export const xhrScript = (address: string): string =>
  `new Promise((done) => { const x = new XMLHttpRequest(); x.onload = () => done('read:' + String(x.responseText).slice(0, 200)); x.onerror = () => done('refused:error event, status ' + x.status); x.ontimeout = () => done('refused:no answer after 3 s'); x.timeout = 3000; try { x.open('GET', ${JSON.stringify(address)}); x.send() } catch (e) { done('refused:' + (e && e.name) + ': ' + (e && e.message)) } })`

/** The same read through a frame: the page puts `address` in a frame and reads the text of its document. */
export const frameScript = (address: string): string =>
  `new Promise((done) => { const f = document.createElement('iframe'); f.onload = () => { try { const d = f.contentDocument; done(d && d.body ? 'read:' + String(d.body.textContent).slice(0, 200) : 'refused:the frame has no document the page can reach') } catch (e) { done('refused:' + (e && e.name) + ': ' + (e && e.message)) } }; f.src = ${JSON.stringify(address)}; document.body.append(f); setTimeout(() => done('refused:the frame did not load in 3 s'), 3000) })`

/** One read by a page, judged: whether the page got hold of `secret`, and the words for the detail of the check. */
export interface ReadVerdict {
  /** True when the page did not read the secret. */
  kept: boolean
  detail: string
}

/**
 * Judges what a page answered to one of the scripts above. The secret is kept when the answer does not hold it; an answer that is not one of the
 * three the scripts give (a script that threw, a page that was gone) is no proof of anything and is not counted as kept.
 */
export function readVerdict(answer: unknown, secret: string, serverHits: number | null = null): ReadVerdict {
  const said = typeof answer === 'string' ? answer : `not an answer of the script: ${String(answer)}`
  const reached = serverHits === null ? '' : ` (the request reached the server ${serverHits} time(s))`
  if (said.includes(secret)) return { kept: false, detail: `the page read the text: "${said.slice(0, 120)}"${reached}` }
  if (said === 'opaque' || said.startsWith('refused:') || said.startsWith('read:')) return { kept: true, detail: `the page got "${said.slice(0, 160)}"${reached}` }
  return { kept: false, detail: `${said.slice(0, 160)}${reached}` }
}

// ---------------------------------------------------------------- the probes of the extension suite ----------------------------------------------------------------

/** The probes smoke-probes-ext.ts loads itself, by the name of their manifest, and their folders in compat/. */
export const NET_PROBE = 'Lucium Net Rules Probe'
export const NET_PROBE_FOLDER = 'net-rules-probe'
export const TAB_PROBE = 'Lucium Active Tab Scripting Probe'
export const TAB_PROBE_FOLDER = 'active-tab-scripting-probe'
export const OPTIONAL_PROBE = 'Lucium Optional Permission Probe'
export const OPTIONAL_PROBE_FOLDER = 'optional-permission-probe'
/** What that probe lists as optional, and asks for: one permission and one site. */
export const OPTIONAL_PROBE_PERMISSION = 'bookmarks'
export const OPTIONAL_PROBE_ORIGIN = 'http://127.0.0.1/*'

// ---------------------------------------------------------------- the request rules of extensions ----------------------------------------------------------------

/** Every path of the server of the rule checks starts with this, and every rule of the probe names a path below it: no other request of the run is touched. */
export const NP = '/lucium-np'

/** The action types of chrome.declarativeNetRequest (RuleActionType), all of them. */
export const DNR_ACTIONS = ['block', 'allow', 'redirect', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests'] as const

/** The events of chrome.webRequest, all of them, in the order of the life of a request. */
export const WEB_REQUEST_EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'] as const

/** The header a modifyHeaders rule adds to the request, and the one it adds to the answer. */
export const NP_REQUEST_HEADER = 'x-lucium-np'
export const NP_RESPONSE_HEADER = 'x-lucium-np-response'

/** The paths the rules name. */
export const NP_PATHS = {
  /** Covered by no rule: it must arrive, or nothing below proves anything. */
  control: `${NP}/control`,
  block: `${NP}/block`,
  /** Covered by a block rule and by an allow rule of a higher priority. */
  allow: `${NP}/allow`,
  redirectFrom: `${NP}/redirect-from`,
  redirectTo: `${NP}/redirect-to`,
  upgrade: `${NP}/upgrade`,
  headers: `${NP}/headers`,
  /** The frame an allowAllRequests rule covers, and what the frame asks for, which a block rule covers. */
  frame: `${NP}/frame-allowed`,
  frameAsset: `${NP}/frame-asset`,
  dynamicBlock: `${NP}/dynamic-block`,
  staticBlock: `${NP}/static-block`,
  /** What the chrome.webRequest listeners are made to hear. */
  heardPlain: `${NP}/heard-plain`,
  heardRedirect: `${NP}/heard-redirect`,
  heardAuth: `${NP}/heard-auth`,
  heardError: `${NP}/heard-error`
} as const

/** A declarativeNetRequest rule as the probe is handed it. */
export interface NetRule {
  id: number
  priority: number
  action: { type: (typeof DNR_ACTIONS)[number]; [more: string]: unknown }
  condition: { urlFilter: string; resourceTypes?: string[] }
}

/** The session rules of the probe: one for each action type, and the two block rules that an allow and an allowAllRequests rule are set against. */
export const SESSION_RULES: readonly NetRule[] = [
  { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: NP_PATHS.block } },
  { id: 2, priority: 1, action: { type: 'block' }, condition: { urlFilter: NP_PATHS.allow } },
  { id: 3, priority: 2, action: { type: 'allow' }, condition: { urlFilter: NP_PATHS.allow } },
  { id: 4, priority: 1, action: { type: 'redirect', redirect: { transform: { path: NP_PATHS.redirectTo } } }, condition: { urlFilter: NP_PATHS.redirectFrom } },
  { id: 5, priority: 1, action: { type: 'upgradeScheme' }, condition: { urlFilter: NP_PATHS.upgrade } },
  {
    id: 6,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: NP_REQUEST_HEADER, operation: 'set', value: '1' }], responseHeaders: [{ header: NP_RESPONSE_HEADER, operation: 'set', value: '1' }] },
    condition: { urlFilter: NP_PATHS.headers }
  },
  { id: 7, priority: 1, action: { type: 'block' }, condition: { urlFilter: NP_PATHS.frameAsset } },
  { id: 8, priority: 2, action: { type: 'allowAllRequests' }, condition: { urlFilter: NP_PATHS.frame, resourceTypes: ['sub_frame'] } }
]

/** The dynamic rule of the probe (the kind that is kept on the disk). The static one is in compat/net-rules-probe/rules.json. */
export const DYNAMIC_RULES: readonly NetRule[] = [{ id: 21, priority: 1, action: { type: 'block' }, condition: { urlFilter: NP_PATHS.dynamicBlock } }]

/**
 * What was seen of one rule or one event:
 * - `applied`: it did what Chrome makes it do;
 * - `not-applied`: the request went as if the rule were not there (the event was not heard);
 * - `no-ground`: an allow rule can only be told from no rule at all when the block rule it overrides is applied, and that one is not;
 * - `unmeasured`: the measurement itself failed (no answer, an answer that is neither outcome).
 */
export type RuleState = 'applied' | 'not-applied' | 'no-ground' | 'unmeasured'

export interface Observation {
  state: RuleState
  /** What was seen, in words, for the detail of the check. */
  saw: string
}

/** What a page got back for a request of the rule checks. */
export interface Fetched {
  /** The text of the answer, or null when the request failed. */
  body: string | null
  /** The error of a request that failed. */
  error?: string
  /** The value of the header a modifyHeaders rule adds to the answer, as the page read it. */
  responseHeader?: string | null
}

/** A script for a page: asks for `address` and answers a `Fetched`, never throwing and never waiting more than four seconds. */
export const requestScript = (address: string): string =>
  `Promise.race([fetch(${JSON.stringify(address)}, { cache: 'no-store' }).then((r) => r.text().then((body) => ({ body, responseHeader: r.headers.get(${JSON.stringify(NP_RESPONSE_HEADER)}) })), (e) => ({ body: null, error: (e && e.name) + ': ' + (e && e.message) })), new Promise((done) => setTimeout(() => done({ body: null, error: 'no answer after 4 s' }), 4000))])`

const fetchedWords = (fetched: Fetched): string => (fetched.body === null ? `the page got the error "${fetched.error ?? 'none given'}"` : `the page got "${fetched.body.slice(0, 60)}"`)

/** A block rule: applied when the request never reached the server and the page got an error. */
export function blockObservation(serverHits: number, fetched: Fetched): Observation {
  const saw = `the server saw the request ${serverHits} time(s), ${fetchedWords(fetched)}`
  if (serverHits > 0) return { state: 'not-applied', saw }
  if (fetched.body === null) return { state: 'applied', saw }
  return { state: 'unmeasured', saw: `${saw}: an answer with no request` }
}

/**
 * A rule that lets a request through over a block rule (allow, allowAllRequests). `ground` is the block rule alone, measured on a request the
 * letting rule does not cover: without it, a request that arrives proves nothing.
 */
export function overBlockObservation(ground: Observation, serverHits: number): Observation {
  const saw = `the server saw the request ${serverHits} time(s); the block rule alone: ${ground.state} (${ground.saw})`
  if (ground.state === 'unmeasured') return { state: 'unmeasured', saw }
  if (ground.state !== 'applied') return { state: 'no-ground', saw }
  return { state: serverHits > 0 ? 'applied' : 'not-applied', saw }
}

/** A redirect rule: the page asked for one path and got the text of the other. */
export function redirectObservation(fetched: Fetched, texts: { from: string; to: string }): Observation {
  const saw = fetchedWords(fetched)
  if (fetched.body === texts.to) return { state: 'applied', saw }
  if (fetched.body === texts.from) return { state: 'not-applied', saw }
  return { state: 'unmeasured', saw: `${saw}: neither the text of the path asked for nor that of the path of the rule` }
}

/** An upgradeScheme rule on a server that only speaks http: applied when the request never arrived as http and the page got an error. */
export function upgradeObservation(httpHits: number, fetched: Fetched): Observation {
  const saw = `the http server saw the request ${httpHits} time(s), ${fetchedWords(fetched)}`
  if (httpHits > 0) return { state: 'not-applied', saw }
  if (fetched.body === null) return { state: 'applied', saw: `${saw} (sent as https to a server that has none)` }
  return { state: 'unmeasured', saw: `${saw}: an answer with no request` }
}

/** A modifyHeaders rule: `value` is the header as the server received it (request) or as the page read it (answer); `arrived` says the request was made at all. */
export function headerObservation(value: string | null | undefined, arrived: boolean, where: 'the server received' | 'the page read'): Observation {
  if (!arrived) return { state: 'unmeasured', saw: 'the request did not arrive, so no header was read' }
  const saw = `${where} the header as ${value === null || value === undefined || value === '' ? 'absent' : `"${value}"`}`
  return { state: value === '1' ? 'applied' : 'not-applied', saw }
}

/** An event of chrome.webRequest: heard by the listener of the probe for the request made for it, or not. `made` says the request was made at all. */
export function eventObservation(event: string, heard: ReadonlyArray<{ event?: unknown; url?: unknown; failed?: unknown }>, path: string, made: boolean): Observation {
  const refused = heard.find((entry) => entry.event === event && typeof entry.failed === 'string')
  if (refused) return { state: 'not-applied', saw: `the listener could not be added: ${String(refused.failed)}` }
  if (!made) return { state: 'unmeasured', saw: `the request to ${path} that the event is expected for was not made` }
  const count = heard.filter((entry) => entry.event === event && typeof entry.url === 'string' && entry.url.includes(path)).length
  return { state: count > 0 ? 'applied' : 'not-applied', saw: `the listener heard ${event} ${count} time(s) for ${path}` }
}

/** The names of what is measured: a rule of each action type as a session rule, a block rule of the two other kinds, and every event. */
export const RULE_KEYS = [
  'dnr.session.block',
  'dnr.session.allow',
  'dnr.session.redirect',
  'dnr.session.upgradeScheme',
  'dnr.session.modifyHeaders.request',
  'dnr.session.modifyHeaders.response',
  'dnr.session.allowAllRequests',
  'dnr.dynamic.block',
  'dnr.static.block',
  ...WEB_REQUEST_EVENTS.map((event) => `webRequest.${event}` as const)
] as const

export type RuleKey = (typeof RULE_KEYS)[number]

/**
 * The keys that are known not to be applied, with their correction put off: none today. Electron leaves out the request rules of extensions, and
 * does not call their chrome.webRequest listeners, in a session that has a session.webRequest listener of the application, and the sessions of
 * pages have them (the guard of local files, the blocker, HTTPS first); the application applies the rules and feeds the listeners itself
 * (engine/extension-net.ts), and every key is a check like any other, red when the rule is not applied. A key put back in this set (a version
 * of the engine that breaks one, with its correction planned) is counted as skipped with what was seen, instead of failing the run.
 */
export const PUT_OFF: ReadonlySet<RuleKey> = new Set()

const PUT_OFF_REASON = 'this request rule or webRequest event of extensions is known not to be applied in this version, and its correction is put off'

/** The check an observation becomes: its name, whether it passed, and its detail (see `PUT_OFF` for what is skipped). */
export function ruleCheck(key: RuleKey, what: string, observation: Observation, putOff: ReadonlySet<string> = PUT_OFF): { name: string; ok: boolean; detail: string } {
  const name = `${key}: ${what}`
  const seen = `${observation.state}: ${observation.saw}`
  if (observation.state === 'applied') return { name, ok: true, detail: seen }
  if (observation.state === 'unmeasured' || !putOff.has(key)) return { name, ok: false, detail: seen }
  return { name, ok: true, detail: skippedBecause(`${PUT_OFF_REASON}. Seen: ${seen}`) }
}

/** The states by key, as the report of the run keeps them (`pnpm compat:compare` sets them against the reference). */
export const ruleStates = (observations: ReadonlyMap<RuleKey, Observation>): Record<string, RuleState> => Object.fromEntries([...observations].map(([key, observation]) => [key, observation.state]))

// ---------------------------------------------------------------- activeTab ----------------------------------------------------------------

/** What the probe answers to a chrome.scripting.executeScript on a tab. */
export interface Injection {
  ok: boolean
  value?: unknown
  error?: string
}

/** What the script the probe injects in the isolated world answers of the extension it runs for (compat/active-tab-scripting-probe/background.js). */
export interface RuntimeSeen {
  hasChrome?: boolean
  runtimeId?: string
  storage?: string
  onMessage?: string
  sendMessage?: string
  roundTrip?: { ok?: boolean; tabId?: number | null }
  roundTripError?: string
  storageBack?: unknown
  storageError?: string
  listening?: boolean
  listenError?: string
}

/** Whether the script of the probe ran in the page: it answers the title of the page, so anything else is no proof. */
export const injected = (reply: Injection | undefined, title: string): boolean => reply?.ok === true && reply.value === title

/** A refusal of the script, as opposed to no answer at all: the worker answered, and what it answered is an error of the API. */
export const refusedInjection = (reply: Injection | undefined): boolean => reply !== undefined && reply.ok === false && typeof reply.error === 'string' && !reply.error.startsWith('no answer')

// ---------------------------------------------------------------- waiting for an answer ----------------------------------------------------------------

/**
 * The answer of a page or of a worker, never an exception and never a wait without end: a promise that fails or that says nothing for `ms`
 * resolves with `otherwise(why)`, so that the reason ends in the detail of the check that asked.
 */
export function settled<T>(promise: Promise<T>, otherwise: (why: string) => T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(otherwise(`no answer after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        resolve(otherwise(`failed: ${String((error as Error)?.message ?? error)}`))
      }
    )
  })
}

/** An observation counts only when the request no rule covers arrived: without it the server, the page or the network is what failed, not a rule. */
export const withControl = (controlArrived: boolean, observation: Observation): Observation =>
  controlArrived ? observation : { state: 'unmeasured', saw: `the control request did not arrive, so this proves nothing: ${observation.saw}` }

// ---------------------------------------------------------------- checks of corrections no engine had seen ----------------------------------------------------------------

/** What a verdict of the checks below says: whether the check passes, and what was seen, for its detail. */
export interface Verdict {
  ok: boolean
  detail: string
}

// ---- chrome.debugger: a drag that carries files (smoke-sec2.ts) ----

/** The text of the drag the page must get after the refused one: the witness that drops reach the page at all. */
export const DROP_WITNESS = 'lucium-drop-witness'

/** Installed in the page the debugger drives: every drop it gets, with the names of its files and its text, in `window.__drops`. */
export const DROP_WATCH = `(() => {
  window.__drops = []
  document.documentElement.style.minHeight = '100vh'
  document.body.style.minHeight = '100vh'
  addEventListener('dragenter', (e) => e.preventDefault())
  addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy' })
  addEventListener('drop', (e) => { e.preventDefault(); window.__drops.push({ files: [...(e.dataTransfer ? e.dataTransfer.files : [])].map((f) => f.name), text: e.dataTransfer ? e.dataTransfer.getData('text/plain') : '' }) })
  return true
})()`

/**
 * What the page got of the drags: none of them may carry a file, and the drag of text sent after the refused one must have come (without it the
 * page took no drop at all, and a page without files proves nothing).
 */
export function dropVerdict(drops: unknown, witness: string = DROP_WITNESS): Verdict {
  if (!Array.isArray(drops)) return { ok: false, detail: `the page did not hand back its drops: ${String(drops)}` }
  const seen = drops as Array<{ files?: unknown; text?: unknown }>
  const withFiles = seen.filter((drop) => Array.isArray(drop.files) && drop.files.length > 0)
  const came = seen.some((drop) => drop.text === witness)
  const said = JSON.stringify(seen).slice(0, 300)
  if (withFiles.length > 0) return { ok: false, detail: `the page got ${withFiles.length} drop(s) with files: ${said}` }
  if (!came) return { ok: false, detail: `not measured: the drag of text sent after the refused one never reached the page (${said})` }
  return { ok: true, detail: `the page got ${seen.length} drop(s), none with a file: ${said}` }
}

// ---- the listeners of a worker (smoke-probes-ext.ts) ----

/** Two probes the extension suite writes and loads itself: one whose worker listens to the changes of the cookies, one whose worker names the first in its listeners. */
export const LISTENER_OWNER_PROBE = 'Lucium Listener Owner Probe'
export const LISTENER_SPY_PROBE = 'Lucium Listener Spy Probe'
/**
 * The event the owner listens to, and the one the spy names in the owner's name. It must be one that no script of Lucium listens to in the worker of
 * every extension: the library sends the message of a listener once per event name and context, whatever extension it names, and takes it away
 * only with the last one. With `tabs.onUpdated`, which src/preload/sender-tab.ts follows in every worker, the spy's messages never left its worker,
 * nothing was there to refuse, and it counted its own updates as stolen (the run of 12 November).
 */
export const LISTENED_EVENT = 'cookies.onChanged'
/** The pages whose cookie the owner keeps: `/lw-<n>` on the server of the suite sets the cookie `lw-<n>`. */
export const LISTENED_PATH = '/lw-'

/** The `Set-Cookie` of the page `path` of the server of the suite, for a page under LISTENED_PATH; null for any other. */
export function listenedCookieOf(path: string): string | null {
  return path.startsWith(LISTENED_PATH) && /^\d+$/.test(path.slice(LISTENED_PATH.length)) ? `${path.slice(1)}=1; Path=/` : null
}

/** The files of a probe the suite writes in a folder of its own. */
export interface WrittenProbe {
  manifest: Record<string, unknown>
  worker: string
}

const drivenByPage = { matches: ['http://127.0.0.1/*'] }

/** It listens to the changes of the cookies of the server (it holds `cookies` and the host), and says which `/lw-` pages set theirs, and since when its worker runs. */
export const LISTENER_OWNER: WrittenProbe = {
  manifest: {
    manifest_version: 3,
    name: LISTENER_OWNER_PROBE,
    version: '0.1.0',
    description: 'Listens to the changes of the cookies, for the engine test of the listeners of a worker (smokeProbesExt).',
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ['cookies'],
    host_permissions: ['http://127.0.0.1/*'],
    externally_connectable: drivenByPage
  },
  worker: `// Written by smoke-probes-ext.ts: the pages ${LISTENED_PATH}<n> whose cookie this worker heard of, and a mark of this start of the worker.
const boot = Math.random().toString(36).slice(2)
const heard = []
chrome.cookies.onChanged.addListener((change) => {
  const name = String((change && change.cookie && change.cookie.name) || '')
  const page = '/' + name
  if (page.startsWith(${JSON.stringify(LISTENED_PATH)}) && !heard.includes(page)) heard.push(page)
})
chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message && message.type === 'ping') reply({ ok: true, boot })
  else if (message && message.type === 'heard') reply({ boot, heard: heard.slice() })
})
`
}

/**
 * It holds nothing, and its worker sends, through the library's own way of listening (`electron.addExtensionListener`), the messages that name
 * another extension: to listen to its events, and to take its listener away. It counts what it heard.
 */
export const LISTENER_SPY: WrittenProbe = {
  manifest: {
    manifest_version: 3,
    name: LISTENER_SPY_PROBE,
    version: '0.1.0',
    description: 'Names another extension in the listeners of its worker, for the engine test of the listeners of a worker (smokeProbesExt).',
    background: { service_worker: 'background.js', type: 'module' },
    externally_connectable: drivenByPage
  },
  worker: `// Written by smoke-probes-ext.ts: one listener, named in the name of the extension the page gives.
const boot = Math.random().toString(36).slice(2)
let stolen = 0
const listener = () => { stolen += 1 }
chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message && message.type === 'ping') return reply({ ok: true, boot })
  if (message && message.type === 'stolen') return reply({ boot, stolen })
  if (!message || (message.type !== 'add' && message.type !== 'remove')) return
  const electron = globalThis.electron
  const name = message.type === 'add' ? 'addExtensionListener' : 'removeExtensionListener'
  const how = electron && electron[name]
  if (typeof how !== 'function') return reply({ ok: false, error: 'the worker has no electron.' + name + ' (electron is ' + typeof electron + ')' })
  try {
    how.call(electron, message.extensionId, message.event, listener)
    reply({ ok: true })
  } catch (error) {
    reply({ ok: false, error: String((error && error.message) || error) })
  }
})
`
}

/** What the owner probe answers to `heard`. */
export interface OwnerHeard {
  boot?: string
  heard?: string[]
  error?: string
}

/**
 * Whether the owner still heard its own event for `page` after the spy named it, by the same start of its worker as the control: a worker started
 * again adds its listener anew, and would hear the page whatever the spy took away.
 */
export function ownerKept(control: OwnerHeard, after: OwnerHeard, page: string): Verdict {
  const said = `control ${JSON.stringify(control)}, after ${JSON.stringify(after)}`
  if (typeof control.boot !== 'string' || typeof after.boot !== 'string') return { ok: false, detail: `not measured: the owner did not answer (${said})` }
  if (control.boot !== after.boot) return { ok: false, detail: `not measured: the worker of the owner started again in between, and listened anew (${said})` }
  if (after.heard?.includes(page) !== true) return { ok: false, detail: `the owner no longer hears its own event: ${page} never reached it (${said})` }
  return { ok: true, detail: `the owner heard ${page}, by the same worker (${said})` }
}

// ---- a request rule with several `*` on a long address (smoke-probes-ext.ts) ----

/**
 * A block rule whose filter repeats a part between three `*`. Read as a regular expression (each `*` a `.*`, as before the correction), it took
 * 4.7 s in Node 24 on the address below, for one request, in the main process; compared part after part, a few thousand steps.
 */
export const SLOW_FILTER_RULE: NetRule = { id: 31, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/ad*/ad*/ad*.gif' } }

/** The path a page asks for: the parts of the filter, 450 times, and never the end the filter wants. The rule does not cover it: it must arrive. */
export const SLOW_ADDRESS_PATH = `${NP}/far${'/ad'.repeat(450)}`

/** The longest the main process may stand still while the request is judged: a freeze of the old matcher lasts seconds, its usual pauses milliseconds. */
export const LONGEST_PAUSE_MS = 1500

/** The request that repeats the filter: it must reach the server and its answer the page, and the main process must not have stood still meanwhile. */
export function pauseVerdict(longestPauseMs: number, serverHits: number, fetched: Fetched): Verdict {
  const saw = `the main process stood still ${Math.round(longestPauseMs)} ms at most (bound ${LONGEST_PAUSE_MS} ms), the server saw the request ${serverHits} time(s), ${fetchedWords(fetched)}`
  return { ok: longestPauseMs < LONGEST_PAUSE_MS && serverHits === 1 && fetched.body === 'arrived', detail: saw }
}

// ---- a folder of an extension past the bound of the review (smoke-probes-ext.ts) ----

export const BOUND_PROBE = 'Lucium Manifest Bound Probe'

/** A probe whose manifest lists `sites` host permissions, each of its own: past `MANIFEST_LIST_MAX`, no load may hand it to the engine. */
export function boundProbe(sites: number): WrittenProbe {
  return {
    manifest: {
      manifest_version: 3,
      name: BOUND_PROBE,
      version: '0.1.0',
      description: `Lists ${sites} sites, for the engine test of the bound of a manifest (smokeProbesExt).`,
      background: { service_worker: 'background.js', type: 'module' },
      host_permissions: Array.from({ length: sites }, (_, index) => `https://site-${index + 1}.lucium-bound.example/*`)
    },
    worker: '// Written by smoke-probes-ext.ts: nothing to do.\n'
  }
}

/** The number of sites of the folder that must be refused, and of the one that must load. */
export const BOUND_SITES = { over: MANIFEST_LIST_MAX + 1, at: MANIFEST_LIST_MAX } as const

// ---- a shared worker of a local page (smoke-probes-web.ts) ----

/**
 * A script for a local page: it starts a shared worker from a blob, which asks `address` and answers its own origin and what it read. Never
 * throws, and never waits more than four seconds.
 */
export const sharedWorkerScript = (address: string): string =>
  `new Promise((done) => {
    const code = 'onconnect = (e) => { const port = e.ports[0]; fetch(' + JSON.stringify(${JSON.stringify(address)}) + ', { cache: "no-store" }).then((r) => r.text().then((t) => port.postMessage({ origin: self.origin, read: "read:" + t.slice(0, 200) })), (err) => port.postMessage({ origin: self.origin, read: "refused:" + (err && err.name) + ": " + (err && err.message) })) }'
    try {
      const worker = new SharedWorker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
      worker.port.onmessage = (e) => done(e.data)
      worker.onerror = (e) => done({ error: 'the shared worker failed: ' + (e && e.message) })
      worker.port.start()
    } catch (e) {
      done({ error: 'no shared worker: ' + (e && e.name) + ': ' + (e && e.message) })
    }
    setTimeout(() => done({ error: 'no answer from the shared worker after 4 s' }), 4000)
  })`

/** What the shared worker of a local page did: whether it ran at all, in which origin, and whether its request to a web site left and was read. */
export function sharedWorkerVerdict(answer: unknown, secret: string, serverHits: number): { ran: boolean; origin: string; kept: Verdict } {
  const said = typeof answer === 'object' && answer !== null ? (answer as { origin?: unknown; read?: unknown; error?: unknown }) : { error: String(answer) }
  const ran = typeof said.origin === 'string' && typeof said.read === 'string'
  const origin = typeof said.origin === 'string' ? said.origin : 'none'
  const words = `${JSON.stringify(said).slice(0, 240)}; the server saw the request ${serverHits} time(s)`
  if (!ran) return { ran, origin, kept: { ok: false, detail: `not measured: the shared worker did not run (${words})` } }
  const read = String(said.read)
  return { ran, origin, kept: { ok: serverHits === 0 && !read.includes(secret) && read.startsWith('refused:'), detail: words } }
}

// ---- the strict-transport hosts kept from one run to the next (smoke-market.ts) ----

/** What the file of a session (`Strict Transport Hosts.json`) says of a host: held (by the SHA-256 of its name) and whether its name is written in clear. */
export function strictHostsFile(text: string | null, host: string): { held: boolean; inClear: boolean; detail: string } {
  if (text === null) return { held: false, inClear: false, detail: 'there is no file' }
  const key = createHash('sha256').update(host).digest('hex')
  const inClear = text.includes(host)
  let parsed: { version?: unknown; hosts?: unknown }
  try {
    parsed = JSON.parse(text) as { version?: unknown; hosts?: unknown }
  } catch (error) {
    // A file that is not JSON holds nothing the next launch could read: the check says so, with the reason, instead of a bare "not held".
    return { held: false, inClear, detail: `the file is not JSON (${String((error as Error)?.message ?? error)}): ${text.slice(0, 200)}` }
  }
  const held = parsed.version === 1 && Array.isArray(parsed.hosts) && parsed.hosts.some((entry) => typeof entry === 'object' && entry !== null && (entry as { host?: unknown }).host === key)
  return { held, inClear, detail: text.slice(0, 300) }
}

// ---- Ollama of the local network named by a `.local` name (smoke-ollama.ts) ----

/** One request the stand-in model saw: what it asked, the Host header it carried, and the address of this Mac it came in on. */
export interface ModelHit {
  method: string
  path: string
  host: string
  local: string
}

/** An address as a socket gives it (`::ffff:192.168.1.5` for IPv4 on a dual-stack socket) in the form `URL` and the resolver write it. */
export const plainAddress = (address: string): string => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').toLowerCase()

/** The Host header of a request made to an address and a port: `[...]` around an IPv6 address. */
export const hostHeaderOf = (address: string, port: number): string => (address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`)

/**
 * The requests for `path`: there is one at least, and each came in on a private address of this Mac with that address as its Host. A request that
 * named the `.local` name (the name handed to the network as it is) or that came on the loopback (this Mac named as itself) fails it.
 */
export function modelHitsVerdict(hits: readonly ModelHit[], method: string, path: string, port: number): Verdict {
  const asked = hits.filter((hit) => hit.method === method && hit.path === path)
  const said = JSON.stringify(asked).slice(0, 300)
  if (asked.length === 0) return { ok: false, detail: `the stand-in model never got ${method} ${path}` }
  const wrong = asked.filter((hit) => !isPrivateNetworkAddress(plainAddress(hit.local)) || hit.host.toLowerCase() !== hostHeaderOf(plainAddress(hit.local), port))
  return { ok: wrong.length === 0, detail: wrong.length === 0 ? `every ${method} ${path} came to a private address of this Mac, with that address as its Host: ${said}` : `${wrong.length} request(s) not sent to the checked private address: ${said}` }
}

// ---- the Client Hints the pages send and read (smoke-client-hints.ts) ----
// What the server of the suite received on each request, and what the page read of `navigator.userAgentData`, kept side by side (`summarizeHints`,
// a measurement), and what the decision of 13 November asks of them (`judgeHints`: the three default hints on the navigations too, with the
// values Chromium gives the rest, and nothing more).

/** The three pages of the site of the suite, in the order they are opened: a plain one, one whose answer asks for more hints, and the one after it. */
export const HINT_PHASES = ['baseline', 'ask', 'after'] as const
export type HintPhase = (typeof HINT_PHASES)[number]

/** What each page asks for: itself, an image and a script of its own site, and an image of the other site (localhost and 127.0.0.1 are two sites). */
export const HINT_WHATS = ['page', 'img', 'script', 'cross-img'] as const
export type HintWhat = (typeof HINT_WHATS)[number]

const HINT_FILE: Readonly<Record<HintWhat, string>> = { page: 'page', img: 'img.gif', script: 'sub.js', 'cross-img': 'cross.gif' }

/** The path of one request of the plan: `/ask/img.gif` is the image of the page that asks for more hints. */
export const hintPath = (phase: HintPhase, what: HintWhat): string => `/${phase}/${HINT_FILE[what]}`

/** The place of a request in the plan, from its path; null for any other path (the icon of the site, a stray request), which the server does not record. */
export function hintRequestOf(path: string): { phase: HintPhase; what: HintWhat } | null {
  const match = /^\/([a-z]+)\/([a-z.]+)$/.exec(path)
  const phase = HINT_PHASES.find((candidate) => candidate === match?.[1])
  const what = HINT_WHATS.find((candidate) => HINT_FILE[candidate] === match?.[2])
  return phase !== undefined && what !== undefined ? { phase, what } : null
}

/** The answer of the page that asks for more: the four hints a page may ask for beyond the three a Chromium sends by default. */
export const ACCEPT_CH = 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Model'
export const ASKED_HINTS: readonly string[] = ACCEPT_CH.split(', ').map((name) => name.toLowerCase())
/** What a Chromium sends to every site that can be trusted, with no question asked. */
export const DEFAULT_HINTS: readonly string[] = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']
/** What the page asks `getHighEntropyValues` for: every hint the interface knows. */
export const HIGH_ENTROPY_HINTS: readonly string[] = ['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64']

/** One request as the server of the suite kept it: its place in the plan, and every header as it arrived (names in lower case, in the order they came). */
export interface SeenRequest {
  n: number
  phase: HintPhase
  what: HintWhat
  method: string
  host: string
  headers: Record<string, string>
}

/** The headers of a Node request as one string each (a header that came twice is joined with ", "), in the order they arrived. */
export function flatHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(', ') : value
  return flat
}

/** The Client Hints of a request: every `sec-ch-*` header (not `sec-fetch-*`, not `sec-gpc`). */
export const hintsOf = (headers: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('sec-ch-')))

export interface Brand {
  brand: string
  version: string
}

/**
 * The brands a `Sec-CH-UA` header lists (`"Chromium";v="156", "Not)A;Brand";v="8"`): a brand may hold a `;` or a `)`, so the quotes decide, not the commas.
 * Null when there is no header; an empty list when the header holds no brand.
 */
export function brandsOfHeader(value: string | undefined): Brand[] | null {
  if (value === undefined) return null
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"\s*;\s*v="((?:[^"\\]|\\.)*)"/g)].map((found) => ({ brand: found[1]!, version: found[2]! }))
}

export type BrandRelation = 'neither' | 'header-only' | 'page-only' | 'same' | 'different'

/** How the brands of the header and those the page reads stand: the same list (in any order), two lists, only one of them, or none. */
export function brandRelation(header: readonly Brand[] | null, page: readonly Brand[] | null): BrandRelation {
  const key = (list: readonly Brand[]): string => list.map((entry) => `${entry.brand};${entry.version}`).sort().join('|')
  const inHeader = header !== null && header.length > 0
  const inPage = page !== null && page.length > 0
  if (!inHeader && !inPage) return 'neither'
  if (!inPage) return 'header-only'
  if (!inHeader) return 'page-only'
  return key(header) === key(page) ? 'same' : 'different'
}

/** What the page read of itself, as the script below answers it. A key that is missing was not read; an `…Error` says why. */
export interface PageRead {
  secure?: boolean
  userAgent?: string
  legacyPlatform?: string
  /** `typeof navigator.userAgentData`: `object`, or `undefined` when the page has none. */
  present?: string
  brands?: Brand[]
  mobile?: boolean
  platform?: string
  json?: unknown
  high?: Record<string, unknown>
  lowError?: string
  jsonError?: string
  highError?: string
  /** The script itself failed (or said nothing): nothing else was read. */
  error?: string
}

/** A script for a page: reads the user agent, `navigator.userAgentData` and `getHighEntropyValues`, each in a `try` of its own, and answers a `PageRead`. */
export const clientHintsReadScript = (): string => `(async () => {
  const out = { secure: window.isSecureContext, userAgent: navigator.userAgent, legacyPlatform: navigator.platform, present: typeof navigator.userAgentData }
  const fail = (e) => String(e && e.name) + ': ' + String(e && e.message)
  const data = navigator.userAgentData
  if (data) {
    try { out.brands = data.brands.map((b) => ({ brand: b.brand, version: b.version })); out.mobile = data.mobile; out.platform = data.platform } catch (e) { out.lowError = fail(e) }
    try { out.json = data.toJSON() } catch (e) { out.jsonError = fail(e) }
    try { out.high = await data.getHighEntropyValues(${JSON.stringify(HIGH_ENTROPY_HINTS)}) } catch (e) { out.highError = fail(e) }
  }
  return out
})()`

/** What the requests and the page of one window say together, for whoever reads the report: nothing in it is a verdict. */
export interface HintSummary {
  /** How many of the twelve requests of the plan the server saw, and the ones it did not (`phase/what`). */
  seen: number
  missing: string[]
  /** The names of the `sec-ch-*` headers each request carried (the first one the server saw for that place of the plan). */
  hintsSent: Record<string, string[]>
  anyHintSent: boolean
  /** Of the four hints the page asked for, those that arrived, on the requests that came after its answer (`ask` and `after`). */
  askedArrived: Record<string, string[]>
  /** The requests to the other site that carried one of the four hints asked for: they must not (a hint asked for by a site is for that site). */
  askedToOtherSite: string[]
  /** Every distinct `User-Agent` the server received, the one the page reads, and whether they are all that one (null when the page read none). */
  userAgentHeaders: string[]
  userAgentOfPage: string | null
  userAgentAgrees: boolean | null
  userAgentMajor: string | null
  brands: { header: Brand[] | null; page: Brand[] | null; relation: BrandRelation }
  platform: { header: string | null; page: string | null; legacy: string | null }
  mobile: { header: string | null; page: boolean | null }
  /** `Sec-GPC` on the first page request: the protection the window really sent. */
  globalPrivacyControl: string | null
}

export function summarizeHints(requests: readonly SeenRequest[], page: PageRead | null): HintSummary {
  const keyOf = (request: { phase: string; what: string }): string => `${request.phase}/${request.what}`
  const planned = HINT_PHASES.flatMap((phase) => HINT_WHATS.map((what) => `${phase}/${what}`))
  const first = new Map<string, SeenRequest>()
  for (const request of requests) if (!first.has(keyOf(request))) first.set(keyOf(request), request)
  const hintsSent: Record<string, string[]> = {}
  const askedArrived: Record<string, string[]> = {}
  const askedToOtherSite: string[] = []
  for (const key of planned) {
    const request = first.get(key)
    if (!request) continue
    hintsSent[key] = Object.keys(hintsOf(request.headers))
    const asked = ASKED_HINTS.filter((name) => name in request.headers)
    if (request.phase !== 'baseline') askedArrived[key] = asked
    if (request.what === 'cross-img' && asked.length > 0) askedToOtherSite.push(`${key}: ${asked.join(', ')}`)
  }
  const navigation = first.get('baseline/page')?.headers ?? {}
  const userAgentHeaders = [...new Set(requests.map((request) => request.headers['user-agent']).filter((value): value is string => value !== undefined))]
  const userAgentOfPage = page?.userAgent ?? null
  const pageBrands = page?.brands ?? null
  const header = brandsOfHeader(navigation['sec-ch-ua'])
  return {
    seen: planned.filter((key) => first.has(key)).length,
    missing: planned.filter((key) => !first.has(key)),
    hintsSent,
    anyHintSent: Object.values(hintsSent).some((names) => names.length > 0),
    askedArrived,
    askedToOtherSite,
    userAgentHeaders,
    userAgentOfPage,
    userAgentAgrees: userAgentOfPage === null ? null : userAgentHeaders.length > 0 && userAgentHeaders.every((value) => value === userAgentOfPage),
    userAgentMajor: /Chrome\/(\d+)/.exec(userAgentOfPage ?? '')?.[1] ?? null,
    brands: { header, page: pageBrands, relation: brandRelation(header, pageBrands) },
    platform: { header: navigation['sec-ch-ua-platform'] ?? null, page: page?.platform ?? null, legacy: page?.legacyPlatform ?? null },
    mobile: { header: navigation['sec-ch-ua-mobile'] ?? null, page: page?.mobile ?? null },
    globalPrivacyControl: navigation['sec-gpc'] ?? null
  }
}

/**
 * What the decision of 13 November asks of the hints of one window, where the summary above only measures: the request of each page carries the
 * three default hints (shared/client-hints.ts adds them, Chromium leaves them out of the navigations), with the values Chromium puts on the image,
 * the script and the image of the other site; the brands, the system and the mobile flag of the header are those the page reads of
 * `navigator.userAgentData` (the same brands in the same order); no detailed hint a site asks for leaves, and no brand names a product.
 */
export interface HintsVerdict {
  /** The page requests (`phase/page`) that lack one of the three, with the ones they lack. */
  navigationsMissing: string[]
  /** The three hints Chromium put on the image of the first page: what every request is held to. Null when that image carried none of them. */
  reference: Record<string, string> | null
  /** Every request of the plan whose three hints are not the reference (`phase/what`). */
  differing: string[]
  brandsAgree: boolean
  platformAgrees: boolean
  mobileAgrees: boolean
  /** The detailed hints that left, wherever (`phase/what: names`). */
  detailedSent: string[]
  /** The brands of a product found in a `Sec-CH-UA` header or in what the page reads: Lucium, Electron, Google Chrome. */
  productBrands: string[]
}

const PRODUCT_BRAND = /lucium|electron|google chrome/i

export function judgeHints(requests: readonly SeenRequest[], page: PageRead | null): HintsVerdict {
  const first = new Map<string, SeenRequest>()
  for (const request of requests) if (!first.has(`${request.phase}/${request.what}`)) first.set(`${request.phase}/${request.what}`, request)
  const defaults = (headers: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(DEFAULT_HINTS.filter((name) => name in headers).map((name) => [name, headers[name]!]))
  const image = first.get('baseline/img')
  const reference = image && Object.keys(defaults(image.headers)).length === DEFAULT_HINTS.length ? defaults(image.headers) : null
  const navigationsMissing: string[] = []
  const differing: string[] = []
  const detailedSent: string[] = []
  const productBrands = new Set<string>()
  for (const [key, request] of first) {
    const own = defaults(request.headers)
    const lacking = DEFAULT_HINTS.filter((name) => !(name in own))
    if (request.what === 'page' && lacking.length > 0) navigationsMissing.push(`${key}: ${lacking.join(', ')}`)
    if (reference === null || JSON.stringify(own) !== JSON.stringify(reference)) differing.push(key)
    const detailed = ASKED_HINTS.filter((name) => name in request.headers)
    if (detailed.length > 0) detailedSent.push(`${key}: ${detailed.join(', ')}`)
    for (const entry of brandsOfHeader(request.headers['sec-ch-ua']) ?? []) if (PRODUCT_BRAND.test(entry.brand)) productBrands.add(entry.brand)
  }
  for (const entry of page?.brands ?? []) if (PRODUCT_BRAND.test(entry.brand)) productBrands.add(entry.brand)
  const navigation = first.get('baseline/page')?.headers ?? {}
  const header = brandsOfHeader(navigation['sec-ch-ua'])
  const pageBrands = page?.brands ?? null
  const listOf = (list: readonly Brand[]): string => JSON.stringify(list.map((entry) => [entry.brand, entry.version]))
  return {
    navigationsMissing,
    reference,
    differing,
    brandsAgree: header !== null && header.length > 0 && pageBrands !== null && listOf(header) === listOf(pageBrands),
    platformAgrees: typeof page?.platform === 'string' && navigation['sec-ch-ua-platform'] === JSON.stringify(page.platform),
    mobileAgrees: typeof page?.mobile === 'boolean' && navigation['sec-ch-ua-mobile'] === (page.mobile ? '?1' : '?0'),
    detailedSent,
    productBrands: [...productBrands]
  }
}

/** The line the suite writes at its end: the tag, then everything it saw as one line of JSON (JSON.stringify never writes a line break). */
export const CLIENT_HINTS_TAG = 'LUCIUM_SMOKE_CLIENT_HINTS'
export const clientHintsLine = (report: unknown): string => `${CLIENT_HINTS_TAG} ${JSON.stringify(report)}`
