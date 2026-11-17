// The request rules of extensions (chrome.declarativeNetRequest), judged by Lucium itself. Electron gives a session one request proxy: its own
// (session.webRequest, which carries the guard of local files, the blocker and HTTPS-first) or the one of the extensions, never both for the same
// request (ElectronBrowserClient::WillCreateURLLoaderFactory asks the extensions only when session.webRequest has no listener). So the rules an
// extension registers are read by the application and applied in its own hooks (main/engine/extension-net.ts), after its own protections.
// This file is the pure part: what a rule says, which requests it covers, and what the rules of one extension make of a request.
//
// What is not read here, and so never applied: a condition on the headers of the answer (`responseHeaders`, `excludedResponseHeaders`), a
// regular expression the JavaScript engine does not take (the rules are written for RE2), and one it would take very long to run on an address
// chosen for it (shared/regex-guard.ts). Such a rule is left out and counted.
//
// The time a rule takes on one address is bounded, because a page chooses the addresses it asks for and the rules are judged in the main
// process: a `urlFilter` is compared by `matchFilter`, in a number of steps proportional to the two lengths, and a `regexFilter` is run only on
// an address short enough for its shape (`regexTextLimit`). Past either bound the rule does not cover the request.

import { regexHazard, regexTextLimit } from './regex-guard'

/** The resource types of the extension platform. */
export const NET_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'] as const

export type NetResourceType = (typeof NET_RESOURCE_TYPES)[number]

const TYPE_SET: ReadonlySet<string> = new Set(NET_RESOURCE_TYPES)

/** Electron's `resourceType` under the name the extension platform gives it. */
export function netResourceType(electronType: string): NetResourceType {
  switch (electronType) {
    case 'mainFrame':
      return 'main_frame'
    case 'subFrame':
      return 'sub_frame'
    case 'xhr':
      return 'xmlhttprequest'
    case 'cspReport':
      return 'csp_report'
    case 'webSocket':
      return 'websocket'
    default:
      return TYPE_SET.has(electronType) ? (electronType as NetResourceType) : 'other'
  }
}

/** A request, as the rules see it. */
export interface NetRequest {
  url: string
  /** Any case: it is compared in lower case. */
  method: string
  type: NetResourceType
  /** The origin (or the address) of the document or worker that asks; null when the browser itself asks. */
  initiator: string | null
  /** The tab the request belongs to, -1 for none. */
  tabId: number
}

export type RuleKind = 'block' | 'allow' | 'allowAllRequests' | 'upgradeScheme' | 'redirect' | 'modifyHeaders'

export interface HeaderOp {
  /** In lower case. */
  header: string
  operation: 'append' | 'set' | 'remove'
  value: string
}

interface UrlTransform {
  scheme?: string
  host?: string
  port?: string
  path?: string
  query?: string
  fragment?: string
  username?: string
  password?: string
  removeParams?: string[]
  addOrReplaceParams?: Array<{ key: string; value: string; replaceOnly: boolean }>
}

type Redirect = { url: string } | { extensionPath: string } | { transform: UrlTransform } | { regexSubstitution: string }

/** The `urlFilter` of a rule, read. */
export interface UrlFilter {
  body: string
  left: '' | '|' | '||'
  right: boolean
  /** Neither anchor nor wildcard: the body only has to be somewhere in the address. */
  plain: boolean
  /** The body cut at its `*`, made at the first request that needs it. */
  parts?: string[]
}

/** A rule that was read and found sound. */
export interface NetRule {
  id: number
  priority: number
  kind: RuleKind
  redirect?: Redirect
  requestHeaders?: HeaderOp[]
  responseHeaders?: HeaderOp[]
  /** The `urlFilter`, without its anchors, in lower case when the rule ignores case. Undefined for a rule with a `regexFilter` or with neither. */
  filter?: UrlFilter
  regexSource?: string
  /** The longest address the `regexFilter` is run on: what its shape allows (regex-guard.ts). */
  regexUrlMax?: number
  caseSensitive: boolean
  /** The `regexFilter`, built at the first request that needs it. False once it failed to build. */
  compiled?: RegExp | false
  /** A filter that ran out of steps on an address was said once. */
  outOfSteps?: boolean
  /** An address too long for the `regexFilter` was said once. */
  overLength?: boolean
  requestDomains?: string[]
  excludedRequestDomains?: string[]
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  types: ReadonlySet<string>
  methods?: ReadonlySet<string>
  excludedMethods?: ReadonlySet<string>
  domainType?: 'firstParty' | 'thirdParty'
  tabIds?: ReadonlySet<number>
  excludedTabIds?: ReadonlySet<number>
}

/** The longest text a rule may hold in one field: what the platform itself refuses beyond is refused here too. */
const FIELD_MAX = 4096
/** The longest `regexFilter`. The platform bounds the memory of the compiled expression (2 kB); a text of this length is far beyond any it takes. */
export const REGEX_FILTER_MAX = 2048

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown, max = 100_000): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > max) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length <= FIELD_MAX)
}

const domains = (value: unknown): string[] | undefined => strings(value)?.map((domain) => domain.toLowerCase().replace(/^\.+|\.+$/g, ''))

const numbers = (value: unknown): ReadonlySet<number> | undefined => (Array.isArray(value) ? new Set(value.filter((item): item is number => Number.isInteger(item))) : undefined)

const DEFAULT_TYPES: ReadonlySet<string> = new Set(NET_RESOURCE_TYPES.filter((type) => type !== 'main_frame'))

function headerOps(value: unknown): HeaderOp[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null
  const ops: HeaderOp[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item['header'] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(item['header'])) return null
    const operation = item['operation']
    if (operation !== 'append' && operation !== 'set' && operation !== 'remove') return null
    const text = item['value']
    if (operation !== 'remove' && (typeof text !== 'string' || text.length > FIELD_MAX || /[\r\n\0]/.test(text))) return null
    ops.push({ header: item['header'].toLowerCase(), operation, value: operation === 'remove' ? '' : (text as string) })
  }
  return ops
}

function readTransform(value: Record<string, unknown>): UrlTransform | null {
  const transform: UrlTransform = {}
  for (const field of ['scheme', 'host', 'port', 'path', 'query', 'fragment', 'username', 'password'] as const) {
    const part = value[field]
    if (part === undefined) continue
    if (typeof part !== 'string' || part.length > FIELD_MAX) return null
    transform[field] = part
  }
  if (transform.scheme !== undefined && transform.scheme !== 'http' && transform.scheme !== 'https') return null
  if (transform.query !== undefined && transform.query !== '' && !transform.query.startsWith('?')) return null
  if (transform.fragment !== undefined && transform.fragment !== '' && !transform.fragment.startsWith('#')) return null
  const query = value['queryTransform']
  if (query !== undefined) {
    if (!isRecord(query) || transform.query !== undefined) return null
    const removed = strings(query['removeParams'], 1000)
    if (removed) transform.removeParams = removed
    const added = query['addOrReplaceParams']
    if (added !== undefined) {
      if (!Array.isArray(added) || added.length > 1000) return null
      transform.addOrReplaceParams = []
      for (const pair of added) {
        if (!isRecord(pair) || typeof pair['key'] !== 'string' || typeof pair['value'] !== 'string') return null
        transform.addOrReplaceParams.push({ key: pair['key'], value: pair['value'], replaceOnly: pair['replaceOnly'] === true })
      }
    }
  }
  return transform
}

function readRedirect(value: unknown, hasRegex: boolean): Redirect | null {
  if (!isRecord(value)) return null
  if (typeof value['url'] === 'string') return value['url'].length <= FIELD_MAX ? { url: value['url'] } : null
  if (typeof value['extensionPath'] === 'string') return value['extensionPath'].startsWith('/') && value['extensionPath'].length <= FIELD_MAX ? { extensionPath: value['extensionPath'] } : null
  if (typeof value['regexSubstitution'] === 'string') return hasRegex && value['regexSubstitution'].length <= FIELD_MAX ? { regexSubstitution: value['regexSubstitution'] } : null
  if (isRecord(value['transform'])) {
    const transform = readTransform(value['transform'])
    return transform ? { transform } : null
  }
  return null
}

/** Why a rule was left out, for the count the Extensions page and the journal show. */
export type RuleRefusal = 'malformed' | 'unsupported' | 'backtracking'

/**
 * Reads one rule as an extension wrote it. Answers the rule, or why it is left out: `malformed` for what the platform refuses too,
 * `unsupported` for what the platform takes and this file does not apply (see the head of the file), `backtracking` for a regular expression
 * that could take forever on some addresses here (regex-guard.ts).
 */
export function readNetRule(raw: unknown): NetRule | RuleRefusal {
  if (!isRecord(raw) || !Number.isInteger(raw['id']) || (raw['id'] as number) < 1) return 'malformed'
  const action = raw['action']
  const condition = raw['condition'] === undefined ? {} : raw['condition']
  if (!isRecord(action) || !isRecord(condition)) return 'malformed'
  const kind = action['type']
  if (kind !== 'block' && kind !== 'allow' && kind !== 'allowAllRequests' && kind !== 'upgradeScheme' && kind !== 'redirect' && kind !== 'modifyHeaders') return 'malformed'
  const priority = raw['priority'] === undefined ? 1 : raw['priority']
  if (!Number.isInteger(priority) || (priority as number) < 1) return 'malformed'
  if (condition['responseHeaders'] !== undefined || condition['excludedResponseHeaders'] !== undefined) return 'unsupported'

  const rule: NetRule = { id: raw['id'] as number, priority: priority as number, kind, caseSensitive: condition['isUrlFilterCaseSensitive'] === true, types: DEFAULT_TYPES }

  const urlFilter = condition['urlFilter']
  const regexFilter = condition['regexFilter']
  if (urlFilter !== undefined && regexFilter !== undefined) return 'malformed'
  if (urlFilter !== undefined) {
    // The platform refuses an empty filter, one that is not ASCII, and one that starts with `||*`.
    if (typeof urlFilter !== 'string' || urlFilter === '' || urlFilter.length > FIELD_MAX || /[^\x20-\x7e]/.test(urlFilter) || urlFilter.startsWith('||*')) return 'malformed'
    const left = urlFilter.startsWith('||') ? '||' : urlFilter.startsWith('|') ? '|' : ''
    let body = urlFilter.slice(left.length)
    const right = body.endsWith('|')
    if (right) body = body.slice(0, -1)
    if (!rule.caseSensitive) body = body.toLowerCase()
    rule.filter = { body, left, right, plain: left === '' && !right && !/[*^]/.test(body) }
  }
  if (regexFilter !== undefined) {
    if (typeof regexFilter !== 'string' || regexFilter === '' || regexFilter.length > REGEX_FILTER_MAX || /[^\x20-\x7e]/.test(regexFilter)) return 'malformed'
    // Judged before anything is built from it: the expression of a rule that is refused is never run.
    if (regexHazard(regexFilter) !== null) return 'backtracking'
    // An expression that could only be run on addresses shorter than any real one covers nothing: it is left out, and counted, like the others.
    const longest = regexTextLimit(regexFilter, REGEX_URL_MAX)
    if (longest < REGEX_URL_MIN) return 'backtracking'
    rule.regexSource = regexFilter
    rule.regexUrlMax = longest
  }

  const requestDomains = domains(condition['requestDomains'])
  const excludedRequestDomains = domains(condition['excludedRequestDomains'])
  // `domains` and `excludedDomains` are the older names of the two initiator lists.
  const initiatorDomains = domains(condition['initiatorDomains'] ?? condition['domains'])
  const excludedInitiatorDomains = domains(condition['excludedInitiatorDomains'] ?? condition['excludedDomains'])
  // An empty list is refused by the platform: it would cover nothing.
  if (requestDomains?.length === 0 || initiatorDomains?.length === 0) return 'malformed'
  if (requestDomains) rule.requestDomains = requestDomains
  if (excludedRequestDomains?.length) rule.excludedRequestDomains = excludedRequestDomains
  if (initiatorDomains) rule.initiatorDomains = initiatorDomains
  if (excludedInitiatorDomains?.length) rule.excludedInitiatorDomains = excludedInitiatorDomains

  const included = strings(condition['resourceTypes'], 32)
  const excluded = strings(condition['excludedResourceTypes'], 32)
  if (included && excluded) return 'malformed'
  if (included) {
    if (included.length === 0 || included.some((type) => !TYPE_SET.has(type))) return 'malformed'
    rule.types = new Set(included)
  } else if (excluded) {
    if (excluded.some((type) => !TYPE_SET.has(type))) return 'malformed'
    rule.types = new Set(NET_RESOURCE_TYPES.filter((type) => !excluded.includes(type)))
  }
  if (kind === 'allowAllRequests' && (!included || included.some((type) => type !== 'main_frame' && type !== 'sub_frame'))) return 'malformed'

  const methods = strings(condition['requestMethods'], 32)
  const excludedMethods = strings(condition['excludedRequestMethods'], 32)
  if (methods?.length === 0) return 'malformed'
  if (methods) rule.methods = new Set(methods.map((method) => method.toLowerCase()))
  if (excludedMethods?.length) rule.excludedMethods = new Set(excludedMethods.map((method) => method.toLowerCase()))

  const domainType = condition['domainType']
  if (domainType !== undefined) {
    if (domainType !== 'firstParty' && domainType !== 'thirdParty') return 'malformed'
    rule.domainType = domainType
  }
  const tabIds = numbers(condition['tabIds'])
  const excludedTabIds = numbers(condition['excludedTabIds'])
  if (tabIds?.size === 0) return 'malformed'
  if (tabIds) rule.tabIds = tabIds
  if (excludedTabIds?.size) rule.excludedTabIds = excludedTabIds

  if (kind === 'redirect') {
    const redirect = readRedirect(action['redirect'], rule.regexSource !== undefined)
    if (!redirect) return 'malformed'
    rule.redirect = redirect
  }
  if (kind === 'modifyHeaders') {
    const requestHeaders = headerOps(action['requestHeaders'])
    const responseHeaders = headerOps(action['responseHeaders'])
    if (requestHeaders === null || responseHeaders === null || (!requestHeaders && !responseHeaders)) return 'malformed'
    if (requestHeaders) rule.requestHeaders = requestHeaders
    if (responseHeaders) rule.responseHeaders = responseHeaders
  }
  return rule
}

// ---------------------------------------------------------------- which requests a rule covers ----------------------------------------------------------------

/** What `^` stands for in a filter: anything but a letter, a digit and `_ . % -`. */
const isSeparator = (char: string): boolean => !/[a-zA-Z0-9_.%-]/.test(char)

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** How a filter did on an address. `exhausted` when it was given up for want of steps: it then does not match. */
export interface FilterMatch {
  matched: boolean
  steps: number
  exhausted: boolean
}

/** The steps a filter may take on an address: a few per character of the two, so the time stays proportional to their lengths. */
export const filterStepBudget = (filterLength: number, addressLength: number): number => 1024 + 32 * (filterLength + addressLength)

/**
 * Whether the `urlFilter` of a rule matches an address: `*` is anything, `^` a separator or the end, `|` an end of the address, `||` the start
 * of a (sub)domain. `text` is the address, in lower case when the rule ignores case (the body of the filter then is too).
 *
 * No regular expression: one made of several `.*` goes back over its choices, and takes a time that grows as a power of the length of an
 * address made for it. The parts between the `*` are placed one after the other, each at the first place it fits after the one before, which
 * is enough: a part placed earlier leaves more of the address to the next ones. Nothing is ever undone, and the steps are counted: past
 * `filterStepBudget` the filter is given up and does not match.
 */
export function matchFilter(filter: UrlFilter, text: string): FilterMatch {
  const parts = (filter.parts ??= filter.body.split('*'))
  const length = text.length
  const budget = filterStepBudget(filter.body.length, length)
  let steps = 0
  /** Where the part ends when it sits at `at`, or -1. A `^` past the end of the address matches there, taking nothing. */
  const endAt = (part: string, at: number): number => {
    steps += 1
    for (let index = 0; index < part.length; index++) {
      steps += 1
      const wanted = part[index] as string
      const position = at + index
      if (position >= length) {
        if (wanted !== '^') return -1
      } else {
        const found = text[position] as string
        if (wanted === '^' ? !isSeparator(found) : wanted !== found) return -1
      }
    }
    return Math.min(at + part.length, length)
  }
  /** The end of the part at the first place it fits from `from` on, or -1. `toEnd` when it must reach the end of the address. */
  const place = (part: string, from: number, toEnd: boolean): number => {
    // A part that reaches the end starts in the last characters, or past them when it ends with `^`.
    for (let at = toEnd ? Math.max(from, length - part.length) : from; at <= length && steps <= budget; at++) {
      const end = endAt(part, at)
      if (end >= 0 && (!toEnd || end === length)) return end
    }
    return -1
  }
  const result = (matched: boolean): FilterMatch => ({ matched: matched && steps <= budget, steps, exhausted: steps > budget })

  const last = parts.length - 1
  const first = parts[0] as string
  const firstToEnd = last === 0 && filter.right
  let at: number
  if (filter.left === '|') {
    at = endAt(first, 0)
    if (firstToEnd && at !== length) at = -1
  } else if (filter.left === '||') {
    // The first part starts where the host does, or after one of the dots of the authority.
    const scheme = SCHEME.exec(text)
    if (!scheme) return result(false)
    at = -1
    let start = scheme[0].length
    while (steps <= budget) {
      const end = endAt(first, start)
      if (end >= 0 && (!firstToEnd || end === length)) {
        at = end
        break
      }
      // The next place: past the next dot, while the authority lasts.
      while (start < length && text[start] !== '.' && text[start] !== '/' && text[start] !== '?' && text[start] !== '#') {
        start += 1
        steps += 1
      }
      if (start >= length || text[start] !== '.') break
      start += 1
    }
  } else {
    at = place(first, 0, firstToEnd)
  }
  for (let index = 1; index <= last && at >= 0 && steps <= budget; index++) at = place(parts[index] as string, at, index === last && filter.right)
  return result(at >= 0)
}

/**
 * The regular expression of a rule with a `regexFilter`. The rules are written for RE2; what the JavaScript engine reads otherwise or not at
 * all (a leading `(?i)` apart) leaves the rule out. Answers false when it cannot be built.
 */
function compiledOf(rule: NetRule): RegExp | false {
  if (rule.compiled !== undefined) return rule.compiled
  try {
    if (rule.regexSource !== undefined) {
      const inline = rule.regexSource.startsWith('(?i)')
      rule.compiled = new RegExp(inline ? rule.regexSource.slice(4) : rule.regexSource, rule.caseSensitive && !inline ? '' : 'i')
    } else rule.compiled = false
  } catch (error) {
    // Said once: the rule is never tried again.
    console.warn(`[net-rules] the rule ${rule.id} of an extension is left out, its expression cannot be read here: ${error instanceof Error ? error.message : String(error)}`)
    rule.compiled = false
  }
  return rule.compiled
}

const hostMatches = (host: string, list: readonly string[]): boolean => list.some((domain) => host === domain || host.endsWith(`.${domain}`))

/** What is worked out once for a request and read by every rule. */
export interface PreparedRequest extends NetRequest {
  lower: string
  host: string
  initiatorHost: string | null
  methodLower: string
  web: boolean
  /** Whether the request goes to another site than the one that asks. Null when nobody is known to ask. */
  thirdParty: boolean | null
}

const hostOf = (address: string | null): string | null => {
  if (!address || !URL.canParse(address)) return null
  return new URL(address).hostname.toLowerCase()
}

/**
 * Reads a request once. `siteOf` gives the site of an address (its registrable domain): it decides `domainType`. Null for an address that is
 * not one.
 */
export function prepareRequest(request: NetRequest, siteOf: (address: string) => string | null): PreparedRequest | null {
  if (!URL.canParse(request.url)) return null
  const url = new URL(request.url)
  const initiatorHost = hostOf(request.initiator)
  const web = url.protocol === 'http:' || url.protocol === 'https:'
  const mine = request.initiator === null ? null : siteOf(request.initiator)
  const theirs = siteOf(request.url)
  return { ...request, lower: request.url.toLowerCase(), host: url.hostname.toLowerCase(), initiatorHost, methodLower: request.method.toLowerCase(), web, thirdParty: mine === null || theirs === null ? null : mine !== theirs }
}

/** The longest address a regular expression of an extension is run on: these are not RE2, and a long text is where a slow one would cost. */
export const REGEX_URL_MAX = 4096
/** An expression whose shape allows no address of this length is left out: it would cover next to nothing. */
export const REGEX_URL_MIN = 64

/** Whether the regular expression of a rule may be run on this address at all. */
const regexMayRun = (rule: NetRule, address: string): boolean => address.length <= (rule.regexUrlMax ?? REGEX_URL_MAX)

/**
 * Why a rule was not tried on a request it might cover: its `urlFilter` ran out of steps on the address (`steps`), or the address is longer
 * than its `regexFilter` may be run on (`length`). Both are the price of a bounded time, and both mean a request the rule does not reach.
 */
export type RuleGivenUp = 'steps' | 'length'

/** Told the first time a rule is given up, once per rule and per reason: the journal of the extension gets a line, not one per request. */
export type RuleGivenUpListener = (rule: NetRule, why: RuleGivenUp, addressLength: number) => void

/** Whether a rule covers a request. `givenUp` hears of a rule its budget kept from the request, the first time. */
export function ruleCovers(rule: NetRule, request: PreparedRequest, givenUp?: RuleGivenUpListener): boolean {
  if (!rule.types.has(request.type)) return false
  if (rule.tabIds && !rule.tabIds.has(request.tabId)) return false
  if (rule.excludedTabIds?.has(request.tabId)) return false
  if (rule.methods || rule.excludedMethods) {
    // The methods are those of the web: a rule that names one covers nothing else.
    if (!request.web) return false
    if (rule.methods && !rule.methods.has(request.methodLower)) return false
    if (rule.excludedMethods?.has(request.methodLower)) return false
  }
  if (rule.requestDomains && !hostMatches(request.host, rule.requestDomains)) return false
  if (rule.excludedRequestDomains && hostMatches(request.host, rule.excludedRequestDomains)) return false
  if (rule.initiatorDomains && (request.initiatorHost === null || !hostMatches(request.initiatorHost, rule.initiatorDomains))) return false
  if (rule.excludedInitiatorDomains && request.initiatorHost !== null && hostMatches(request.initiatorHost, rule.excludedInitiatorDomains)) return false
  if (rule.domainType !== undefined) {
    // A request nobody is known to make is its own: it is a first party.
    const third = request.thirdParty === true
    if ((rule.domainType === 'thirdParty') !== third) return false
  }
  if (rule.filter?.plain) return (rule.caseSensitive ? request.url : request.lower).includes(rule.filter.body)
  if (rule.filter) {
    const match = matchFilter(rule.filter, rule.caseSensitive ? request.url : request.lower)
    if (match.exhausted && !rule.outOfSteps) {
      // Said once for the rule: an address made to be slow costs a line, not one line per request.
      rule.outOfSteps = true
      console.warn(`[net-rules] the rule ${rule.id} of an extension was given up on an address of ${request.url.length} characters: comparing them took more steps than a rule is given, so the rule does not cover that request`)
      givenUp?.(rule, 'steps', request.url.length)
    }
    return match.matched
  }
  if (rule.regexSource === undefined) return true
  if (!regexMayRun(rule, request.url)) {
    if (!rule.overLength) {
      // Said once for the rule, like a filter out of steps: every other condition of the rule held, and only the length kept it away.
      rule.overLength = true
      console.warn(`[net-rules] the rule ${rule.id} of an extension was not tried on an address of ${request.url.length} characters: its regular expression is run on ${rule.regexUrlMax ?? REGEX_URL_MAX} characters at most, so the rule does not cover that request`)
      givenUp?.(rule, 'length', request.url.length)
    }
    return false
  }
  const regex = compiledOf(rule)
  return regex !== false && regex.test(request.url)
}

// ---------------------------------------------------------------- an index, so that a request reads few rules ----------------------------------------------------------------

const TOKEN = /[a-z0-9]+/g

/** Words nearly every address holds: a rule filed under one of them would be read for every request. */
const COMMON: ReadonlySet<string> = new Set(['http', 'https', 'www', 'com', 'net', 'org', 'js', 'html', 'php', 'css', 'png', 'jpg', 'gif'])

/**
 * A word of the filter that any address the rule covers must hold as a whole word: letters and digits with, on each side in the filter,
 * something that is neither (and is not `*`, which could stand for more letters) or an anchored end. Null when the filter has none.
 */
export function filterToken(filter: UrlFilter): string | null {
  const body = filter.body.toLowerCase()
  let best: string | null = null
  for (const match of body.matchAll(TOKEN)) {
    const start = match.index
    const end = start + match[0].length
    const boundedLeft = start === 0 ? filter.left !== '' : body[start - 1] !== '*'
    const boundedRight = end === body.length ? filter.right : body[end] !== '*'
    if (!boundedLeft || !boundedRight || match[0].length < 2) continue
    const better = best === null || (COMMON.has(best) && !COMMON.has(match[0])) || (COMMON.has(best) === COMMON.has(match[0]) && match[0].length > best.length)
    if (better) best = match[0]
  }
  return best
}

/** The rules of one extension from one source (a static ruleset, the dynamic rules, the session rules), filed so that a request reads few of them. */
export class RuleIndex {
  private readonly byDomain = new Map<string, NetRule[]>()
  private readonly byToken = new Map<string, NetRule[]>()
  private readonly rest: NetRule[] = []
  readonly size: number
  /** Whether any rule rewrites the headers of the request, of the answer: what tells the session which hooks it needs. */
  readonly requestHeaders: boolean
  readonly responseHeaders: boolean
  /** The allowAllRequests rules: they are also asked about the documents a request sits in. */
  readonly frameRules: readonly NetRule[]

  constructor(rules: readonly NetRule[]) {
    this.size = rules.length
    this.frameRules = rules.filter((rule) => rule.kind === 'allowAllRequests')
    this.requestHeaders = rules.some((rule) => rule.requestHeaders !== undefined)
    this.responseHeaders = rules.some((rule) => rule.responseHeaders !== undefined)
    const file = (map: Map<string, NetRule[]>, key: string, rule: NetRule): void => {
      const list = map.get(key)
      if (list) list.push(rule)
      else map.set(key, [rule])
    }
    for (const rule of rules) {
      if (rule.requestDomains) {
        for (const domain of rule.requestDomains) file(this.byDomain, domain, rule)
        continue
      }
      const token = rule.filter ? filterToken(rule.filter) : null
      if (token !== null) file(this.byToken, token, rule)
      else this.rest.push(rule)
    }
  }

  /** Every rule that covers the request. `givenUp` hears of the rules their budget kept from it (`ruleCovers`). */
  covering(request: PreparedRequest, givenUp?: RuleGivenUpListener): NetRule[] {
    const found: NetRule[] = []
    const seen = new Set<NetRule>()
    const consider = (rules: readonly NetRule[] | undefined): void => {
      if (!rules) return
      for (const rule of rules) {
        if (seen.has(rule)) continue
        seen.add(rule)
        if (ruleCovers(rule, request, givenUp)) found.push(rule)
      }
    }
    if (this.byDomain.size > 0) {
      let host = request.host
      for (;;) {
        consider(this.byDomain.get(host))
        const dot = host.indexOf('.')
        if (dot < 0) break
        host = host.slice(dot + 1)
      }
    }
    if (this.byToken.size > 0) for (const token of new Set(request.lower.match(TOKEN) ?? [])) consider(this.byToken.get(token))
    consider(this.rest)
    return found
  }
}

// ---------------------------------------------------------------- what the rules of one extension make of a request ----------------------------------------------------------------

/** At the same priority: allow, then allowAllRequests, then block, then upgradeScheme, then redirect. */
const KIND_RANK: Record<Exclude<RuleKind, 'modifyHeaders'>, number> = { allow: 0, allowAllRequests: 1, block: 2, upgradeScheme: 3, redirect: 4 }

/** What an extension may reach, as far as the rules need it. */
export interface RuleOwner {
  id: string
  /** Whether the extension has host access to an address (its own pages count). */
  canAccess(address: string): boolean
  /** True for an extension that only holds `declarativeNetRequestWithHostAccess`: every rule of it then needs host access. */
  hostAccessOnly: boolean
}

/** Whether the owner may act on this request with a rule of this kind: a redirect and a header change always need host access, to the request and to who asks. */
function mayAct(owner: RuleOwner, kind: RuleKind, request: PreparedRequest): boolean {
  if (!owner.hostAccessOnly && kind !== 'redirect' && kind !== 'modifyHeaders') return true
  if (!owner.canAccess(request.url)) return false
  // A navigation of a tab is judged on its address alone.
  return request.type === 'main_frame' || request.initiator === null || owner.canAccess(request.initiator)
}

export type Outcome = { action: 'none' } | { action: 'allow' } | { action: 'block' } | { action: 'redirect'; url: string }

/** What the rules of one extension say of a request before it leaves, and the priority below which its header rules are silent. */
export interface Judgement {
  outcome: Outcome
  /** The highest priority of an allow or allowAllRequests rule that covers the request (0 for none). */
  allowPriority: number
}

/** The address a redirect rule sends a request to, or null when it gives none that may be followed. */
export function redirectTarget(rule: NetRule, request: PreparedRequest, ownerId: string): string | null {
  if (!request.web) return null
  let target: string | null
  if (rule.kind === 'upgradeScheme') {
    if (!request.lower.startsWith('http:')) return null
    target = `https:${request.url.slice(5)}`
  } else if (!rule.redirect) return null
  else if ('url' in rule.redirect) target = rule.redirect.url
  else if ('extensionPath' in rule.redirect) target = `chrome-extension://${ownerId}${rule.redirect.extensionPath}`
  else if ('regexSubstitution' in rule.redirect) {
    const regex = regexMayRun(rule, request.url) ? compiledOf(rule) : false
    const match = regex === false ? null : regex.exec(request.url)
    if (!match) return null
    target = rule.redirect.regexSubstitution.replace(/\\(\d)/g, (_all, digit: string) => match[Number(digit)] ?? '')
  } else target = transformed(request.url, rule.redirect.transform)
  if (!URL.canParse(target)) return null
  const url = new URL(target)
  // Only the web, and the files of the extension that owns the rule: never a script address, a local file or another extension.
  const allowed = url.protocol === 'http:' || url.protocol === 'https:' || (url.protocol === 'chrome-extension:' && url.host === ownerId)
  return allowed && url.href !== new URL(request.url).href ? url.href : null
}

function transformed(address: string, transform: UrlTransform): string {
  const url = new URL(address)
  if (transform.scheme !== undefined) url.protocol = `${transform.scheme}:`
  if (transform.host !== undefined) url.hostname = transform.host
  if (transform.port !== undefined) url.port = transform.port
  if (transform.path !== undefined) url.pathname = transform.path
  if (transform.query !== undefined) url.search = transform.query
  if (transform.fragment !== undefined) url.hash = transform.fragment
  if (transform.username !== undefined) url.username = transform.username
  if (transform.password !== undefined) url.password = transform.password
  for (const name of transform.removeParams ?? []) url.searchParams.delete(name)
  for (const pair of transform.addOrReplaceParams ?? []) {
    if (url.searchParams.has(pair.key)) url.searchParams.set(pair.key, pair.value)
    else if (!pair.replaceOnly) url.searchParams.append(pair.key, pair.value)
  }
  return url.href
}

/**
 * The rules of one extension on one request. `covering` are its rules that cover the request; `frameAllowPriority` is the highest priority of
 * its allowAllRequests rules that cover a document the request sits in (0 for none).
 */
export function judge(owner: RuleOwner, covering: readonly NetRule[], request: PreparedRequest, frameAllowPriority = 0): Judgement {
  let best: NetRule | null = null
  let allowPriority = frameAllowPriority
  for (const rule of covering) {
    if (rule.kind === 'modifyHeaders' || !mayAct(owner, rule.kind, request)) continue
    if (rule.kind === 'allow' || rule.kind === 'allowAllRequests') allowPriority = Math.max(allowPriority, rule.priority)
    if (best === null || rule.priority > best.priority || (rule.priority === best.priority && KIND_RANK[rule.kind] < KIND_RANK[best.kind as Exclude<RuleKind, 'modifyHeaders'>])) best = rule
  }
  // An allowAllRequests rule on a frame above stands as an allow rule of its priority; at the same priority it comes before a block.
  if (best === null || frameAllowPriority > best.priority || (frameAllowPriority === best.priority && frameAllowPriority > 0 && best.kind !== 'allow')) return { outcome: frameAllowPriority > 0 ? { action: 'allow' } : { action: 'none' }, allowPriority }
  if (best.kind === 'allow' || best.kind === 'allowAllRequests') return { outcome: { action: 'allow' }, allowPriority }
  if (best.kind === 'block') return { outcome: { action: 'block' }, allowPriority }
  const url = redirectTarget(best, request, owner.id)
  return { outcome: url === null ? { action: 'none' } : { action: 'redirect', url }, allowPriority }
}

/** The header rules of one extension that speak for a request, the strongest first. */
export function headerRules(owner: RuleOwner, covering: readonly NetRule[], request: PreparedRequest, allowPriority: number, side: 'requestHeaders' | 'responseHeaders'): NetRule[] {
  return covering.filter((rule) => rule.kind === 'modifyHeaders' && rule[side] !== undefined && rule.priority > allowPriority && mayAct(owner, 'modifyHeaders', request)).sort((a, b) => b.priority - a.priority)
}

/** One extension's header changes, in the order they are applied. */
export interface HeaderChanges {
  ownerId: string
  ops: readonly HeaderOp[]
}

type HeaderBag = Record<string, string | string[]>

/**
 * Applies header changes to the headers of a request or of an answer, the strongest rule first, extension after extension. Once a header was
 * appended to, weaker rules may only append; once it was set, only the same extension may still append; once it was removed, nothing more.
 * Answers the same object when nothing changed.
 */
export function applyHeaderChanges<T extends HeaderBag>(headers: T, changes: readonly HeaderChanges[], side: 'request' | 'response'): T {
  const state = new Map<string, { how: 'append' | 'set' | 'remove'; by: string }>()
  let next: HeaderBag | null = null
  const nameOf = (bag: HeaderBag, header: string): string | undefined => Object.keys(bag).find((name) => name.toLowerCase() === header)
  for (const { ownerId, ops } of changes) {
    for (const op of ops) {
      const before = state.get(op.header)
      if (before) {
        if (before.how === 'remove') continue
        if (op.operation !== 'append') continue
        if (before.how === 'set' && before.by !== ownerId) continue
      }
      next ??= { ...headers }
      const name = nameOf(next, op.header)
      if (op.operation === 'remove') {
        if (name !== undefined) delete next[name]
      } else if (op.operation === 'set' || name === undefined) {
        if (name !== undefined) delete next[name]
        next[name ?? op.header] = side === 'response' ? [op.value] : op.value
      } else {
        const current = next[name] as string | string[]
        // A header of an answer may come several times; one of a request is a single line, its values separated the way the header wants.
        next[name] = Array.isArray(current) ? [...current, op.value] : side === 'response' ? [current, op.value] : `${current}${op.header === 'cookie' ? '; ' : ', '}${op.value}`
      }
      if (!before) state.set(op.header, { how: op.operation, by: ownerId })
    }
  }
  return (next ?? headers) as T
}

/** How the outcomes of several extensions combine: a block wins, then a redirect (the extension loaded last first), and an allow changes nothing. */
export function combineOutcomes(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.some((outcome) => outcome.action === 'block')) return { action: 'block' }
  for (let index = outcomes.length - 1; index >= 0; index--) {
    const outcome = outcomes[index]
    if (outcome?.action === 'redirect') return outcome
  }
  return { action: 'none' }
}
