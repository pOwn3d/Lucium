// What the blocking listeners of chrome.webRequest answer (`webRequestBlocking`, Manifest V2), read and combined as pure functions. The engine asks
// them in the request hooks of the session (main/engine/extension-net.ts), after the application's own protections and the declarative rules of the
// extensions, waits for them a bounded time, and applies what comes out of here.
//
// The order and the combination follow Chromium (extensions/browser/api/web_request/web_request_api_helpers.cc), in the order of precedence of the
// extensions: the one loaded last speaks first.
//  - A cancel wins over everything. A redirect to `data:` or `about:blank` is how an extension cancels in Chromium: it is a cancel here.
//  - Redirect: the first one in the order of precedence wins; another extension's different redirect is ignored and said in the journal.
//  - Headers: each answer is turned into what it changes against the headers the listener was told (set, removed). An answer that touches a header
//    an extension before it already changed differently, or that a declarative rule changed, is ignored as a whole, as Chromium does. A header the
//    network stack or the safety of the redirects owns (`FORBIDDEN_REQUEST_HEADERS`, `FORBIDDEN_RESPONSE_HEADERS`) is never changed: that change
//    alone is dropped.
//  - Credentials (onAuthRequired): the first one in the order of precedence.
//
// What is not taken: an answer field the event does not have (`redirectUrl` in onBeforeSendHeaders…), an answer that is not of the documented shape,
// a redirect anywhere but the web and the extension's own files (never `file:`, `chrome:`, another extension, a page of the application), a header
// value with a line break.

import { isRecord } from './record'

/** The events whose listeners may answer; the listeners of the others are told only. */
export const BLOCKABLE_EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onAuthRequired'] as const

export type BlockableEvent = (typeof BLOCKABLE_EVENTS)[number]

export const isBlockableEvent = (event: string): event is BlockableEvent => (BLOCKABLE_EVENTS as readonly string[]).includes(event)

/**
 * How long a request waits for the blocking listeners asked about it, from the moment it is asked. An answer travels to the extension and back by
 * IPC and runs a listener in between: a few milliseconds, a few hundred when the background page is busy (a blocker compiling its lists as it
 * starts). One second covers that with room, and stays short enough that a page whose extension hangs is slowed, not stuck: past it, the request
 * goes on without the answers still missing, and the journal says which extension was late. Chromium waits without a bound; a request here never
 * waits for ever.
 */
export const BLOCKING_WAIT_MS = 1000

/** An extension late this many times in a row is no longer waited for during `SLOW_PAUSE_MS`: a hung extension costs a few requests a second, not every request. */
export const SLOW_STRIKES = 3

export const SLOW_PAUSE_MS = 30_000

/** The asks waiting at once in a profile. Past it a request is told, not asked: a page that sends thousands of requests at once makes nothing grow. */
export const PENDING_ASKS_MAX = 512

/** The answers one context may send for one request (one per listener, at most). */
export const RESPONSES_MAX = 64

const HEADERS_MAX = 256
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/
const HEADER_VALUE_MAX = 8192
const URL_MAX = 8192
const CREDENTIAL_MAX = 1024

/**
 * The headers of a request no listener changes: Chromium writes them itself below the hooks (the length, the connection, the host, the handshake of
 * a WebSocket), and a proxy's credentials are not an extension's to give.
 */
export const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization', 'proxy-connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])

/**
 * The headers of an answer no listener changes: how the body is framed, the handshake of a WebSocket, and `Location`. A redirect goes through
 * `redirectUrl`, whose target is checked (`listenerRedirect`): a `Location` rewritten by hand would skip that check.
 */
export const FORBIDDEN_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-connection', 'location', 'sec-websocket-accept', 'sec-websocket-extensions'])

/** Whether the listeners of an extension may answer: a Manifest V2 extension that holds `webRequestBlocking` in its manifest. */
export function mayBlockRequests(manifest: unknown): boolean {
  if (!isRecord(manifest) || manifest['manifest_version'] !== 2) return false
  return Array.isArray(manifest['permissions']) && manifest['permissions'].includes('webRequestBlocking')
}

// ---------------------------------------------------------------- an answer, read ----------------------------------------------------------------

export interface HeaderLine {
  name: string
  value: string
}

export interface Credentials {
  username: string
  password: string
}

/** One listener's answer, as far as its event takes it. */
export interface BlockingResponse {
  cancel?: true
  redirectUrl?: string
  requestHeaders?: HeaderLine[]
  responseHeaders?: HeaderLine[]
  authCredentials?: Credentials
}

const plainText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\r\n\0]/.test(value)

function readHeaders(value: unknown): HeaderLine[] | null {
  if (!Array.isArray(value) || value.length > HEADERS_MAX) return null
  const lines: HeaderLine[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || !HEADER_NAME.test(item['name'])) return null
    let text = item['value']
    // The platform also takes the value as bytes.
    const bytes = item['binaryValue']
    if (text === undefined && Array.isArray(bytes) && bytes.length <= HEADER_VALUE_MAX && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) text = String.fromCharCode(...(bytes as number[]))
    if (!plainText(text, HEADER_VALUE_MAX)) return null
    lines.push({ name: item['name'], value: text })
  }
  return lines
}

/**
 * One answer of a listener to `event`, or null when it is not of the shape the platform documents (Chromium refuses it as a whole too). Nothing
 * (`undefined`, `{}`) is an answer that changes nothing. A field the event does not take is left out.
 */
export function readBlockingResponse(event: BlockableEvent, raw: unknown): BlockingResponse | null {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) return null
  const response: BlockingResponse = {}
  if (raw['cancel'] !== undefined) {
    if (typeof raw['cancel'] !== 'boolean') return null
    if (raw['cancel']) response.cancel = true
  }
  if (raw['redirectUrl'] !== undefined && (event === 'onBeforeRequest' || event === 'onHeadersReceived')) {
    if (!plainText(raw['redirectUrl'], URL_MAX) || raw['redirectUrl'] === '') return null
    response.redirectUrl = raw['redirectUrl']
  }
  if (raw['requestHeaders'] !== undefined && event === 'onBeforeSendHeaders') {
    const lines = readHeaders(raw['requestHeaders'])
    if (!lines) return null
    response.requestHeaders = lines
  }
  if (raw['responseHeaders'] !== undefined && event === 'onHeadersReceived') {
    const lines = readHeaders(raw['responseHeaders'])
    if (!lines) return null
    response.responseHeaders = lines
  }
  if (raw['authCredentials'] !== undefined && event === 'onAuthRequired') {
    const credentials = raw['authCredentials']
    if (!isRecord(credentials) || typeof credentials['username'] !== 'string' || typeof credentials['password'] !== 'string' || credentials['username'].length > CREDENTIAL_MAX || credentials['password'].length > CREDENTIAL_MAX) return null
    response.authCredentials = { username: credentials['username'], password: credentials['password'] }
  }
  return response
}

// ---------------------------------------------------------------- a redirect ----------------------------------------------------------------

export type ListenerRedirect = { kind: 'redirect'; url: string } | { kind: 'cancel' } | { kind: 'same' } | { kind: 'refused' }

/**
 * Where a listener's `redirectUrl` may send a request. The web (`ws:` and `wss:` for a WebSocket only), and from onBeforeRequest the files of the
 * extension itself; `data:` and `about:blank` are a cancel (Chromium reads them so, and Electron does not follow a web request to them). Never a
 * local file, a page of the browser or of the application, a script address, another extension. The request's own address changes nothing
 * (`same`): following it would loop.
 */
export function listenerRedirect(target: string, requestUrl: string, extensionId: string, event: 'onBeforeRequest' | 'onHeadersReceived'): ListenerRedirect {
  const lower = target.trim().toLowerCase()
  if (lower.startsWith('data:') || lower === 'about:blank') return { kind: 'cancel' }
  if (!URL.canParse(target) || !URL.canParse(requestUrl)) return { kind: 'refused' }
  const url = new URL(target)
  const from = new URL(requestUrl)
  const socket = from.protocol === 'ws:' || from.protocol === 'wss:'
  const allowed =
    url.protocol === 'http:' ||
    url.protocol === 'https:' ||
    (socket && event === 'onBeforeRequest' && (url.protocol === 'ws:' || url.protocol === 'wss:')) ||
    // A 302 made from the headers of an answer cannot reach the files of an extension (Chromium calls that redirect unsafe): only the first hook can.
    (event === 'onBeforeRequest' && url.protocol === 'chrome-extension:' && url.host === extensionId)
  if (!allowed) return { kind: 'refused' }
  return url.href === from.href ? { kind: 'same' } : { kind: 'redirect', url: url.href }
}

// ---------------------------------------------------------------- the answers of several extensions ----------------------------------------------------------------

/** The answers of one extension to one request: one per listener that answered. */
export interface ExtensionResponses {
  extensionId: string
  responses: readonly BlockingResponse[]
}

export type IgnoredWhy = 'target' | 'redirect-conflict' | 'header-conflict' | 'forbidden-header' | 'credentials-conflict'

export interface Ignored {
  extensionId: string
  why: IgnoredWhy
}

/** What the listeners make of a request before it leaves. */
export interface RequestVerdict {
  cancel: boolean
  redirectUrl: string | null
  ignored: Ignored[]
}

/** The redirect of the answers, the first in the order of precedence; and whether one of them cancels by redirecting. */
function redirectOf(answers: readonly ExtensionResponses[], requestUrl: string, event: 'onBeforeRequest' | 'onHeadersReceived', ignored: Ignored[]): { cancel: boolean; url: string | null } {
  let url: string | null = null
  let cancel = false
  for (const { extensionId, responses } of answers) {
    for (const response of responses) {
      if (response.redirectUrl === undefined) continue
      const verdict = listenerRedirect(response.redirectUrl, requestUrl, extensionId, event)
      if (verdict.kind === 'cancel') cancel = true
      else if (verdict.kind === 'refused') ignored.push({ extensionId, why: 'target' })
      else if (verdict.kind === 'redirect') {
        if (url === null) url = verdict.url
        else if (url !== verdict.url) ignored.push({ extensionId, why: 'redirect-conflict' })
      }
    }
  }
  return { cancel, url }
}

const cancels = (answers: readonly ExtensionResponses[]): boolean => answers.some(({ responses }) => responses.some((response) => response.cancel === true))

/** onBeforeRequest: a cancel wins, then the first redirect. `answers` in the order of precedence (the extension loaded last first). */
export function mergeBeforeRequest(answers: readonly ExtensionResponses[], requestUrl: string): RequestVerdict {
  const ignored: Ignored[] = []
  const redirect = redirectOf(answers, requestUrl, 'onBeforeRequest', ignored)
  if (cancels(answers) || redirect.cancel) return { cancel: true, redirectUrl: null, ignored }
  return { cancel: false, redirectUrl: redirect.url, ignored }
}

export type HeaderBag = Record<string, string | string[]>

const valuesOf = (bag: HeaderBag, lower: string): string[] => {
  const found: string[] = []
  for (const [name, value] of Object.entries(bag)) if (name.toLowerCase() === lower) found.push(...(Array.isArray(value) ? value : [value]))
  return found
}

/** The names (in lower case) whose values differ between two sets of headers: what a declarative rule changed, for instance. */
export function touchedHeaders(before: HeaderBag, after: HeaderBag): Set<string> {
  const touched = new Set<string>()
  if (before === after) return touched
  const names = new Set([...Object.keys(before), ...Object.keys(after)].map((name) => name.toLowerCase()))
  for (const name of names) if (valuesOf(before, name).join('\n') !== valuesOf(after, name).join('\n')) touched.add(name)
  return touched
}

/** The headers as a list of lines, in the order of the platform. */
export const headerLines = (bag: HeaderBag): HeaderLine[] => {
  const lines: HeaderLine[] = []
  for (const [name, value] of Object.entries(bag)) for (const item of Array.isArray(value) ? value : [value]) lines.push({ name, value: String(item) })
  return lines
}

/** What the headers of a request carry, then what the listeners did to them. */
export interface RequestHeadersVerdict {
  cancel: boolean
  /** The headers to send: `base` itself when no answer changed anything. */
  headers: Record<string, string>
  ignored: Ignored[]
}

/**
 * onBeforeSendHeaders. `told`: the headers the listeners were told (before the declarative rules); `base`: the headers once the declarative rules
 * have spoken. Each answer is what it changes against `told`; the changes are made on `base`. An answer that touches a header a declarative rule
 * changed, or that an extension before it changed differently, is ignored as a whole; a forbidden header is never touched.
 */
export function mergeRequestHeaders(answers: readonly ExtensionResponses[], told: Record<string, string>, base: Record<string, string>): RequestHeadersVerdict {
  const ignored: Ignored[] = []
  if (cancels(answers)) return { cancel: true, headers: base, ignored }
  const byRules = touchedHeaders(told, base)
  const set = new Map<string, HeaderLine>()
  const removed = new Set<string>()
  const toldLower = new Map(Object.entries(told).map(([name, value]) => [name.toLowerCase(), value]))
  for (const { extensionId, responses } of answers) {
    for (const response of responses) {
      if (!response.requestHeaders) continue
      // What this answer changes: a header it gives that differs (or is new), a header it no longer gives.
      const given = new Map<string, HeaderLine>()
      for (const line of response.requestHeaders) given.set(line.name.toLowerCase(), line)
      let mySet = [...given].filter(([lower, line]) => toldLower.get(lower) !== line.value)
      let myRemoved = [...toldLower.keys()].filter((lower) => !given.has(lower))
      const forbidden = (lower: string): boolean => FORBIDDEN_REQUEST_HEADERS.has(lower)
      if (mySet.some(([lower]) => forbidden(lower)) || myRemoved.some(forbidden)) {
        ignored.push({ extensionId, why: 'forbidden-header' })
        mySet = mySet.filter(([lower]) => !forbidden(lower))
        myRemoved = myRemoved.filter((lower) => !forbidden(lower))
      }
      const conflicts =
        mySet.some(([lower, line]) => byRules.has(lower) || removed.has(lower) || (set.has(lower) && set.get(lower)!.value !== line.value)) || myRemoved.some((lower) => byRules.has(lower) || set.has(lower))
      if (conflicts) {
        ignored.push({ extensionId, why: 'header-conflict' })
        continue
      }
      for (const [lower, line] of mySet) set.set(lower, line)
      for (const lower of myRemoved) removed.add(lower)
    }
  }
  if (set.size === 0 && removed.size === 0) return { cancel: false, headers: base, ignored }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    const lower = name.toLowerCase()
    if (!removed.has(lower) && !set.has(lower)) headers[name] = value
  }
  for (const line of set.values()) headers[line.name] = line.value
  return { cancel: false, headers, ignored }
}

/** What the headers of an answer carry once the listeners have spoken, and whether the answer turns into a redirect. */
export interface ResponseHeadersVerdict {
  cancel: boolean
  /** The headers the page reads: `base` itself when no answer changed anything. */
  headers: Record<string, string[]>
  /** Set when a listener redirects: the answer becomes a 302 to that address. */
  statusLine: string | null
  redirectUrl: string | null
  ignored: Ignored[]
}

const pairKey = (line: HeaderLine): string => `${line.name.toLowerCase()}\n${line.value}`

/**
 * onHeadersReceived. `told`: the headers of the answer as the server sent them (what the listeners were told); `base`: once the declarative rules
 * have spoken. A header of an answer may come several times, so an answer changes lines (a name and a value): the lines it adds, the lines it no
 * longer gives. As in Chromium, an answer is ignored as a whole when it removes a line another one removed already, or adds one another removed,
 * or when it touches a header a declarative rule changed. A redirect makes the answer a 302 to its target, the way Chromium does it.
 */
export function mergeResponseHeaders(answers: readonly ExtensionResponses[], told: Record<string, string[]>, base: Record<string, string[]>, requestUrl: string): ResponseHeadersVerdict {
  const ignored: Ignored[] = []
  const redirect = redirectOf(answers, requestUrl, 'onHeadersReceived', ignored)
  if (cancels(answers) || redirect.cancel) return { cancel: true, headers: base, statusLine: null, redirectUrl: null, ignored }
  const byRules = touchedHeaders(told, base)
  const toldLines = headerLines(told)
  const added: HeaderLine[] = []
  const removedKeys = new Set<string>()
  const removedLines: HeaderLine[] = []
  for (const { extensionId, responses } of answers) {
    for (const response of responses) {
      if (!response.responseHeaders) continue
      // A multiset difference: each line of the answer accounts for one line of what was told.
      const left = new Map<string, number>()
      for (const line of response.responseHeaders) left.set(pairKey(line), (left.get(pairKey(line)) ?? 0) + 1)
      let myRemoved: HeaderLine[] = []
      for (const line of toldLines) {
        const key = pairKey(line)
        const count = left.get(key) ?? 0
        if (count > 0) left.set(key, count - 1)
        else myRemoved.push(line)
      }
      let myAdded: HeaderLine[] = []
      const spent = new Map<string, number>()
      for (const line of response.responseHeaders) {
        const key = pairKey(line)
        const extra = left.get(key) ?? 0
        const used = spent.get(key) ?? 0
        if (used < extra) {
          myAdded.push(line)
          spent.set(key, used + 1)
        }
      }
      const forbidden = (line: HeaderLine): boolean => FORBIDDEN_RESPONSE_HEADERS.has(line.name.toLowerCase())
      if (myAdded.some(forbidden) || myRemoved.some(forbidden)) {
        ignored.push({ extensionId, why: 'forbidden-header' })
        myAdded = myAdded.filter((line) => !forbidden(line))
        myRemoved = myRemoved.filter((line) => !forbidden(line))
      }
      const conflicts =
        myRemoved.some((line) => removedKeys.has(pairKey(line)) || byRules.has(line.name.toLowerCase())) || myAdded.some((line) => removedKeys.has(pairKey(line)) || byRules.has(line.name.toLowerCase()))
      if (conflicts) {
        ignored.push({ extensionId, why: 'header-conflict' })
        continue
      }
      for (const line of myRemoved) {
        removedKeys.add(pairKey(line))
        removedLines.push(line)
      }
      added.push(...myAdded)
    }
  }
  if (added.length === 0 && removedLines.length === 0 && redirect.url === null) return { cancel: false, headers: base, statusLine: null, redirectUrl: null, ignored }
  const headers: Record<string, string[]> = Object.fromEntries(Object.entries(base).map(([name, values]) => [name, [...values]]))
  const nameIn = (lower: string): string | undefined => Object.keys(headers).find((name) => name.toLowerCase() === lower)
  for (const line of removedLines) {
    const name = nameIn(line.name.toLowerCase())
    if (name === undefined) continue
    const values = headers[name]!
    const at = values.indexOf(line.value)
    if (at >= 0) values.splice(at, 1)
    if (values.length === 0) delete headers[name]
  }
  for (const line of added) {
    const name = nameIn(line.name.toLowerCase())
    if (name === undefined) headers[line.name] = [line.value]
    else headers[name]!.push(line.value)
  }
  if (redirect.url === null) return { cancel: false, headers, statusLine: null, redirectUrl: null, ignored }
  const location = nameIn('location')
  if (location !== undefined) delete headers[location]
  headers['Location'] = [redirect.url]
  return { cancel: false, headers, statusLine: 'HTTP/1.1 302 Found', redirectUrl: redirect.url, ignored }
}

export type AuthAnswer = { cancel: true } | { credentials: Credentials }

/** onAuthRequired: a cancel wins, then the first credentials in the order of precedence; null when no listener answered either. */
export function mergeAuth(answers: readonly ExtensionResponses[]): { answer: AuthAnswer | null; ignored: Ignored[] } {
  const ignored: Ignored[] = []
  if (cancels(answers)) return { answer: { cancel: true }, ignored }
  let credentials: Credentials | null = null
  for (const { extensionId, responses } of answers) {
    for (const response of responses) {
      if (!response.authCredentials) continue
      if (credentials === null) credentials = response.authCredentials
      else if (credentials.username !== response.authCredentials.username || credentials.password !== response.authCredentials.password) ignored.push({ extensionId, why: 'credentials-conflict' })
    }
  }
  return { answer: credentials ? { credentials } : null, ignored }
}

/**
 * What the page's login question gets of the listeners' answer: a cancel ends it without a question; credentials are given at the first attempt
 * only (a second challenge of the same server means they were wrong, and the listener would give them again for ever: the user is asked). Null:
 * the user is asked.
 */
export function loginOfListeners(kept: AuthAnswer | null, firstAttempt: boolean): 'cancel' | Credentials | null {
  if (kept === null) return null
  if ('cancel' in kept) return 'cancel'
  return firstAttempt ? kept.credentials : null
}

// ---------------------------------------------------------------- the time an extension is given ----------------------------------------------------------------

/**
 * Which extensions are waited for. Late `SLOW_STRIKES` times in a row, an extension is no longer waited for during `SLOW_PAUSE_MS` (its listeners
 * are still told); an answer in time wipes its strikes.
 */
export class SlowListeners {
  private readonly strikes = new Map<string, number>()
  private readonly pausedUntil = new Map<string, number>()

  waits(extensionId: string, now: number): boolean {
    const until = this.pausedUntil.get(extensionId)
    if (until === undefined) return true
    if (now < until) return false
    this.pausedUntil.delete(extensionId)
    return true
  }

  answered(extensionId: string): void {
    this.strikes.delete(extensionId)
  }

  /** The extension was late: `paused` when this strike stops the waiting for it. */
  late(extensionId: string, now: number): 'late' | 'paused' {
    const strikes = (this.strikes.get(extensionId) ?? 0) + 1
    if (strikes < SLOW_STRIKES) {
      this.strikes.set(extensionId, strikes)
      return 'late'
    }
    this.strikes.delete(extensionId)
    this.pausedUntil.set(extensionId, now + SLOW_PAUSE_MS)
    return 'paused'
  }

  forget(extensionId: string): void {
    this.strikes.delete(extensionId)
    this.pausedUntil.delete(extensionId)
  }
}

// ---------------------------------------------------------------- what onAuthRequired answered, until the login is asked ----------------------------------------------------------------

/** How long the answer of the listeners to a login waits for the question of the browser that follows the answer of the server. */
export const AUTH_ANSWER_TTL_MS = 30_000

const AUTH_ANSWERS_MAX = 64

/**
 * The answers of the listeners of onAuthRequired, by session and by address. The answer of the server is read in one hook (where the request is
 * known by its id and the listeners are asked); the browser asks for the login in another place, the page's `login` event, which names the address
 * only. What is kept is taken once, and forgotten after `AUTH_ANSWER_TTL_MS`. One store per session: nothing of a profile reaches another.
 */
export class AuthAnswers<Scope extends object> {
  private readonly held = new WeakMap<Scope, Map<string, { answer: AuthAnswer; at: number }>>()

  keep(scope: Scope, url: string, answer: AuthAnswer, now: number): void {
    let byUrl = this.held.get(scope)
    if (!byUrl) this.held.set(scope, (byUrl = new Map()))
    for (const [address, kept] of byUrl) if (now - kept.at > AUTH_ANSWER_TTL_MS) byUrl.delete(address)
    byUrl.delete(url)
    byUrl.set(url, { answer, at: now })
    while (byUrl.size > AUTH_ANSWERS_MAX) byUrl.delete(byUrl.keys().next().value as string)
  }

  take(scope: Scope, url: string, now: number): AuthAnswer | null {
    const byUrl = this.held.get(scope)
    const kept = byUrl?.get(url)
    if (!byUrl || !kept) return null
    byUrl.delete(url)
    return now - kept.at > AUTH_ANSWER_TTL_MS ? null : kept.answer
  }
}
