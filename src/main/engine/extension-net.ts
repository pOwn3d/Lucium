// The request rules and the request events of the extensions of one profile, applied by the application's own hooks (see shared/net-rules.ts for
// why Electron cannot apply them itself while the application watches the requests). One object per session of a profile. It holds, for each
// extension: its static rulesets (read from its folder, the enabled ones kept on the disk), its dynamic and session rules (the extension still
// registers them with Chromium, which stores them; its shim sends a copy here after every change and when its worker starts), and the listeners
// its contexts put on chrome.webRequest. The hooks of the session ask it what to do with a request and tell it what happened to one.
//
// Electron-free: the engine hands it requests as plain objects (electron-engine-network.ts), and the tests drive it the same way.
//
// A listener of chrome.webRequest is told about a request. A blocking one (a Manifest V2 extension that holds webRequestBlocking, on one of the
// four events that take an answer) is asked: the hook waits for the answers of the contexts that hold one, `BLOCKING_WAIT_MS` at most, and they
// are combined as Chromium combines them (shared/web-request-blocking.ts). Another extension's blocking listener (Manifest V3) is told only, and
// the journal says so once. chrome.declarativeNetRequest.getMatchedRules and onRuleMatchedDebug stay silent.

import { accessOf, hasHostAccess, matchPattern } from '@shared/extension-access'
import {
  applyHeaderChanges,
  combineOutcomes,
  headerRules,
  judge,
  NET_RESOURCE_TYPES,
  prepareRequest,
  readNetRule,
  RuleIndex,
  ruleCovers,
  type HeaderChanges,
  type NetRequest,
  type NetResourceType,
  type NetRule,
  type Outcome,
  type PreparedRequest,
  REGEX_URL_MAX,
  type RuleGivenUp,
  type RuleGivenUpListener,
  type RuleOwner
} from '@shared/net-rules'
import { t } from '@shared/i18n'
import {
  BLOCKING_WAIT_MS,
  isBlockableEvent,
  mayBlockRequests,
  mergeAuth,
  mergeBeforeRequest,
  mergeRequestHeaders,
  mergeResponseHeaders,
  PENDING_ASKS_MAX,
  readBlockingResponse,
  RESPONSES_MAX,
  SLOW_PAUSE_MS,
  SLOW_STRIKES,
  SlowListeners,
  AuthAnswers,
  type AuthAnswer,
  type BlockableEvent,
  type BlockingResponse,
  type ExtensionResponses,
  type Ignored,
  type RequestHeadersVerdict,
  type RequestVerdict,
  type ResponseHeadersVerdict
} from '@shared/web-request-blocking'

/**
 * The line the journal of an extension gets when one of its rules was kept from a request by its budget. It names the rule and never the
 * address or its length: said again for the same rule, it is the same sentence, which the journal keeps once.
 */
export function ruleGivenUpNote(ruleId: number, why: RuleGivenUp, limit: number): string {
  return why === 'steps' ? t('extpage.regle-reseau-hors-etapes', { id: String(ruleId) }) : t('extpage.regle-reseau-adresse-longue', { id: String(ruleId), limit: String(limit) })
}

/**
 * What the blocking listeners of onAuthRequired answered, by session, until the page that receives the answer of the server asks for the login
 * (electron-page.ts): the request is known by its id where the listeners are asked, and by its address alone where the login is asked.
 */
export const listenerLogins = new AuthAnswers<object>()

/** The events of chrome.webRequest. */
export const WEB_REQUEST_EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'] as const

export type WebRequestEvent = (typeof WEB_REQUEST_EVENTS)[number]

const EVENT_SET: ReadonlySet<string> = new Set(WEB_REQUEST_EVENTS)

/** The limits of the extension platform, kept here too: an extension cannot make the application hold more than it could make Chrome hold. */
export const NET_LIMITS = { sessionRules: 5000, dynamicRules: 30_000, staticRules: 330_000, disabledRules: 5000, rulesets: 100, enabledRulesets: 50, listenersPerContext: 64, rulesetBytes: 64 * 1024 * 1024 } as const

/** A document a request sits in: the frame that asks, then each frame above it. */
export interface FrameDocument {
  url: string
  top: boolean
}

/** A request as the hooks of the session hand it over. */
export interface HookRequest extends NetRequest {
  id: number
  /** The documents the request sits in, the nearest first. For the navigation of a frame: the frames above the one being loaded. */
  documents: readonly FrameDocument[]
  frameId: number
  parentFrameId: number
  timeStamp: number
}

/** What an event adds to the request it is about. */
export interface EventExtras {
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  statusCode?: number
  statusLine?: string
  ip?: string
  fromCache?: boolean
  redirectUrl?: string
  error?: string
}

/** What the object needs of the world around it. */
export interface ExtensionNetHost {
  /** The JSON of a ruleset file of an extension, read from its folder. */
  readRuleset(path: string): Promise<unknown>
  /** What was kept for an extension the last time (`save`), if anything. */
  saved(extensionId: string): string | undefined
  save(extensionId: string, value: string | undefined): void
  /** The site of an address (its registrable domain), null for none. */
  siteOf(address: string): string | null
  /** The hooks the session needs have changed (`needs`). */
  changed(): void
  /**
   * Hands an event of chrome.webRequest to the contexts of an extension. `wake` when its worker listens but is stopped. `contexts`: the contexts
   * whose listeners cover the request. `ask`: the token the contexts with a blocking listener answer with (`answer`), when they are asked.
   */
  send(extensionId: string, event: WebRequestEvent, details: Record<string, unknown>, wake: boolean, contexts: readonly string[], ask?: string): void
  warn(message: string): void
  /**
   * A rule of an extension was kept from a request by its budget, for the first time: the journal of the extension says so, in the words the
   * person reads. `ruleId` is the id the extension gave the rule; `limit` is the longest address its expression is run on (`length` only).
   */
  ruleGivenUp(extensionId: string, ruleId: number, why: RuleGivenUp, addressLength: number, limit: number): void
}

interface Ruleset {
  path: string
  /** Null until its file was read. */
  index: RuleIndex | null
  count: number
  loading: boolean
}

interface Listener {
  event: WebRequestEvent
  urls: readonly string[]
  types: ReadonlySet<string> | null
  tabId: number | null
  requestHeaders: boolean
  responseHeaders: boolean
  /** It asked to block, and its answer is applied (see `mayBlockRequests`). */
  blocking: boolean
}

/** A request whose blocking listeners were asked, until they all answered or the time is up. */
interface PendingAsk {
  token: string
  event: BlockableEvent
  /** The contexts that still owe an answer, by extension. */
  waiting: Map<string, Set<string>>
  responses: Map<string, BlockingResponse[]>
  timer: ReturnType<typeof setTimeout> | null
  resolve: (result: AskResult) => void
}

/** What the blocking listeners answered, by extension in the order of precedence (the one loaded last first), and who was too late. */
export interface AskResult {
  answers: ExtensionResponses[]
  late: string[]
}

interface Entry {
  owner: RuleOwner
  folder: string
  rulesets: Map<string, Ruleset>
  enabled: Set<string>
  /** The rules of a static ruleset the extension switched off one by one, by ruleset. */
  disabledRules: Map<string, Set<number>>
  session: RuleIndex
  dynamic: RuleIndex
  /** The listeners of each context of the extension that is alive. */
  listeners: Map<string, Listener[]>
  /** The listeners of its worker when it last stopped: a request they cover starts it again. */
  asleep: Listener[]
  /** How many rules were left out, and why, for the journal. */
  refused: { malformed: number; unsupported: number; backtracking: number }
  /** The journal was told that this extension asks to block with a listener, which is not applied. */
  toldBlocking: boolean
  /** Its blocking listeners are asked (`mayBlockRequests`). */
  canBlock: boolean
  /** What the journal was told of its answers that were not applied (an event and a reason), once each. */
  toldIgnored: Set<string>
}

const EMPTY = new RuleIndex([])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Which hooks a session needs for its extensions. */
export interface NetNeeds {
  /** Some extension has a rule: the requests must be judged before they leave. */
  rules: boolean
  requestHeaders: boolean
  responseHeaders: boolean
  events: ReadonlySet<WebRequestEvent>
}

export class ExtensionNet {
  private readonly entries = new Map<string, Entry>()
  /** What the session was last told (the key of `announce`): at first, that nothing is needed. */
  private lastNeeds = 'false:false:false:'
  /** The requests whose blocking listeners are being waited for, by token. */
  private readonly asks = new Map<string, PendingAsk>()
  private askCount = 0
  private readonly slow = new SlowListeners()
  /** The journal was told that the asks waiting at once reached their bound (told again once it went down). */
  private toldCrowded = false

  constructor(private readonly host: ExtensionNetHost) {}

  // ---------------------------------------------------------------- the extensions of the profile ----------------------------------------------------------------

  /** An extension was loaded in the profile: its static rulesets are read, the ones it had enabled last time first. */
  add(extensionId: string, folder: string, manifest: unknown): void {
    const access = accessOf(manifest)
    const withRules = access.permissions.has('declarativeNetRequest')
    const own = `chrome-extension://${extensionId}`
    const owner: RuleOwner = {
      id: extensionId,
      canAccess: (address) => address === own || address.startsWith(`${own}/`) || hasHostAccess(access, address),
      hostAccessOnly: !withRules
    }
    const entry: Entry = {
      owner,
      folder,
      rulesets: new Map(),
      enabled: new Set(),
      disabledRules: new Map(),
      session: EMPTY,
      dynamic: EMPTY,
      listeners: new Map(),
      asleep: [],
      refused: { malformed: 0, unsupported: 0, backtracking: 0 },
      toldBlocking: false,
      canBlock: mayBlockRequests(manifest),
      toldIgnored: new Set()
    }
    this.entries.set(extensionId, entry)
    if (!withRules && !access.permissions.has('declarativeNetRequestWithHostAccess')) return
    const declared = isRecord(manifest) && isRecord(manifest['declarative_net_request']) ? manifest['declarative_net_request']['rule_resources'] : undefined
    const byManifest = new Set<string>()
    for (const resource of Array.isArray(declared) ? declared.slice(0, NET_LIMITS.rulesets) : []) {
      if (!isRecord(resource) || typeof resource['id'] !== 'string' || typeof resource['path'] !== 'string' || resource['id'].startsWith('_')) continue
      const path = insideFolder(folder, resource['path'])
      if (path === null) {
        this.host.warn(`the ruleset "${resource['id']}" of ${extensionId} names a file outside its folder, so it is left out`)
        continue
      }
      entry.rulesets.set(resource['id'], { path, index: null, count: 0, loading: false })
      if (resource['enabled'] === true) byManifest.add(resource['id'])
    }
    const kept = this.kept(extensionId)
    entry.enabled = new Set([...(kept?.enabled ?? byManifest)].filter((id) => entry.rulesets.has(id)).slice(0, NET_LIMITS.enabledRulesets))
    for (const [id, rules] of Object.entries(kept?.disabledRules ?? {})) if (entry.rulesets.has(id)) entry.disabledRules.set(id, new Set(rules))
    for (const id of entry.enabled) void this.loadRuleset(extensionId, entry, id)
    this.announce()
  }

  /** An extension left the profile. Its choices stay on the disk unless it was removed for good (`forget`). The requests waiting for it go on without it. */
  remove(extensionId: string): void {
    this.slow.forget(extensionId)
    for (const pending of [...this.asks.values()]) {
      pending.responses.delete(extensionId)
      if (pending.waiting.delete(extensionId) && pending.waiting.size === 0) this.settle(pending)
    }
    if (this.entries.delete(extensionId)) this.announce()
  }

  /** An extension was uninstalled: the rulesets it had enabled are forgotten with it. */
  forget(extensionId: string): void {
    this.host.save(extensionId, undefined)
    this.remove(extensionId)
  }

  has(extensionId: string): boolean {
    return this.entries.has(extensionId)
  }

  private kept(extensionId: string): { enabled: string[]; disabledRules: Record<string, number[]> } | null {
    const text = this.host.saved(extensionId)
    if (text === undefined) return null
    try {
      const value: unknown = JSON.parse(text)
      if (!isRecord(value) || !Array.isArray(value['enabled'])) throw new Error('not the expected shape')
      const disabledRules: Record<string, number[]> = {}
      if (isRecord(value['disabledRules'])) for (const [id, rules] of Object.entries(value['disabledRules'])) if (Array.isArray(rules)) disabledRules[id] = rules.filter((rule): rule is number => Number.isInteger(rule)).slice(0, NET_LIMITS.disabledRules)
      return { enabled: value['enabled'].filter((id): id is string => typeof id === 'string'), disabledRules }
    } catch (error) {
      this.host.warn(`what ${extensionId} had enabled of its rulesets cannot be read, so its manifest decides again: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private keep(extensionId: string, entry: Entry): void {
    const disabledRules = Object.fromEntries([...entry.disabledRules].filter(([, rules]) => rules.size > 0).map(([id, rules]) => [id, [...rules]]))
    this.host.save(extensionId, JSON.stringify({ enabled: [...entry.enabled], disabledRules }))
  }

  private async loadRuleset(extensionId: string, entry: Entry, id: string): Promise<void> {
    const ruleset = entry.rulesets.get(id)
    if (!ruleset || ruleset.loading) return
    ruleset.loading = true
    let raw: unknown
    try {
      raw = await this.host.readRuleset(ruleset.path)
    } catch (error) {
      this.host.warn(`the ruleset "${id}" of ${extensionId} cannot be read, so none of its rules is applied: ${error instanceof Error ? error.message : String(error)}`)
      raw = []
    }
    ruleset.loading = false
    const disabled = entry.disabledRules.get(id)
    const rules = this.read(entry, Array.isArray(raw) ? raw : [], NET_LIMITS.staticRules).filter((rule) => !disabled?.has(rule.id))
    ruleset.index = new RuleIndex(rules)
    ruleset.count = rules.length
    this.announce()
  }

  private read(entry: Entry, raw: readonly unknown[], max: number): NetRule[] {
    const rules: NetRule[] = []
    /** The ids of the rules whose regular expression is refused, for the journal. */
    const slow: unknown[] = []
    for (const item of raw.slice(0, max)) {
      const rule = readNetRule(item)
      if (typeof rule !== 'string') rules.push(rule)
      else {
        entry.refused[rule] += 1
        if (rule === 'backtracking') slow.push(isRecord(item) ? item['id'] : undefined)
      }
    }
    // Said where the rules are read (a static ruleset, or the copy of the dynamic and session rules), once for the lot.
    if (slow.length > 0) this.host.warn(`${slow.length} rule(s) of ${entry.owner.id} are left out: their regular expression could take forever on some addresses (a repetition inside a repetition, a look-around, a back-reference, or too many repetitions one after the other); rule ids: ${slow.slice(0, 8).join(', ')}${slow.length > 8 ? '…' : ''}`)
    return rules
  }

  // ---------------------------------------------------------------- chrome.declarativeNetRequest, the part answered here ----------------------------------------------------------------

  /** The copy of the dynamic and session rules of an extension, as Chromium holds them after a change. */
  mirror(extensionId: string, copy: unknown): void {
    const entry = this.rulesEntry(extensionId)
    if (!isRecord(copy)) throw new Error('The rules were not handed over as lists.')
    entry.refused = { malformed: 0, unsupported: 0, backtracking: 0 }
    entry.session = new RuleIndex(this.read(entry, Array.isArray(copy['session']) ? copy['session'] : [], NET_LIMITS.sessionRules))
    // Only a session rule may name tabs.
    entry.dynamic = new RuleIndex(this.read(entry, Array.isArray(copy['dynamic']) ? copy['dynamic'] : [], NET_LIMITS.dynamicRules).filter((rule) => !rule.tabIds && !rule.excludedTabIds))
    if (entry.refused.unsupported > 0) this.host.warn(`${entry.refused.unsupported} rule(s) of ${extensionId} use a condition on the headers of the answer, which is not applied here: they are left out`)
    this.announce()
  }

  enabledRulesets(extensionId: string): string[] {
    return [...this.rulesEntry(extensionId).enabled]
  }

  updateEnabledRulesets(extensionId: string, options: unknown): void {
    const entry = this.rulesEntry(extensionId)
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
    const disable = isRecord(options) ? list(options['disableRulesetIds']) : []
    const enable = isRecord(options) ? list(options['enableRulesetIds']) : []
    for (const id of [...disable, ...enable]) if (!entry.rulesets.has(id)) throw new Error(`Invalid ruleset id: ${id}.`)
    const next = new Set(entry.enabled)
    for (const id of disable) next.delete(id)
    for (const id of enable) next.add(id)
    if (next.size > NET_LIMITS.enabledRulesets) throw new Error('The number of enabled static rulesets exceeds the enabled ruleset count limit.')
    entry.enabled = next
    this.keep(extensionId, entry)
    for (const id of enable) if (entry.rulesets.get(id)?.index === null) void this.loadRuleset(extensionId, entry, id)
    this.announce()
  }

  updateStaticRules(extensionId: string, options: unknown): void {
    const entry = this.rulesEntry(extensionId)
    const id = isRecord(options) ? options['rulesetId'] : undefined
    if (typeof id !== 'string' || !entry.rulesets.has(id)) throw new Error(`Invalid ruleset id: ${String(id)}.`)
    const ids = (value: unknown): number[] => (Array.isArray(value) ? value.filter((rule): rule is number => Number.isInteger(rule)) : [])
    const disabled = new Set(entry.disabledRules.get(id))
    for (const rule of ids((options as Record<string, unknown>)['disableRuleIds'])) disabled.add(rule)
    for (const rule of ids((options as Record<string, unknown>)['enableRuleIds'])) disabled.delete(rule)
    // The limit of the platform, for the whole extension: what is kept of its choices stays small.
    let others = 0
    for (const [ruleset, rules] of entry.disabledRules) if (ruleset !== id) others += rules.size
    if (others + disabled.size > NET_LIMITS.disabledRules) throw new Error('The number of disabled static rules exceeds the disabled rule count limit.')
    entry.disabledRules.set(id, disabled)
    this.keep(extensionId, entry)
    // The ruleset is read again without the rules that were switched off (or with the ones switched back on).
    const ruleset = entry.rulesets.get(id)
    if (ruleset) {
      ruleset.index = null
      if (entry.enabled.has(id)) void this.loadRuleset(extensionId, entry, id)
    }
  }

  disabledRuleIds(extensionId: string, options: unknown): number[] {
    const entry = this.rulesEntry(extensionId)
    const id = isRecord(options) ? options['rulesetId'] : undefined
    if (typeof id !== 'string' || !entry.rulesets.has(id)) throw new Error(`Invalid ruleset id: ${String(id)}.`)
    return [...(entry.disabledRules.get(id) ?? [])]
  }

  availableStaticRuleCount(extensionId: string): number {
    const entry = this.rulesEntry(extensionId)
    let used = 0
    for (const id of entry.enabled) used += entry.rulesets.get(id)?.count ?? 0
    return Math.max(0, NET_LIMITS.staticRules - used)
  }

  private rulesEntry(extensionId: string): Entry {
    const entry = this.entries.get(extensionId)
    if (!entry) throw new Error('The extension is not loaded in this profile.')
    return entry
  }

  // ---------------------------------------------------------------- chrome.webRequest: who listens ----------------------------------------------------------------

  /** A context of an extension listens to an event. `first` for the first listener of a context that has just started: what its worker held before is dropped. */
  listen(extensionId: string, context: string, event: unknown, filter: unknown, extra: unknown, first: boolean): void {
    const entry = this.rulesEntry(extensionId)
    if (typeof event !== 'string' || !EVENT_SET.has(event)) throw new Error(`chrome.webRequest has no event "${String(event)}".`)
    const urls = isRecord(filter) && Array.isArray(filter['urls']) ? filter['urls'].filter((url): url is string => typeof url === 'string').slice(0, 256) : []
    if (urls.length === 0) throw new Error("The filter of a webRequest listener needs 'urls'.")
    const types = isRecord(filter) && Array.isArray(filter['types']) ? new Set(filter['types'].filter((type): type is string => typeof type === 'string' && (NET_RESOURCE_TYPES as readonly string[]).includes(type))) : null
    const tabId = isRecord(filter) && Number.isInteger(filter['tabId']) ? (filter['tabId'] as number) : null
    const asked = Array.isArray(extra) ? extra : []
    const asksToBlock = asked.includes('blocking') || asked.includes('asyncBlocking')
    const blocking = asksToBlock && entry.canBlock && isBlockableEvent(event)
    if (asksToBlock && !blocking && !entry.toldBlocking) {
      // Once for the extension while it is loaded: its worker registers its listeners again at every start.
      entry.toldBlocking = true
      this.host.warn(
        entry.canBlock
          ? `${extensionId} put a blocking listener on chrome.webRequest.${event}, an event that takes no answer: it is told about the requests`
          : `${extensionId} put a blocking listener on chrome.webRequest.${event}: it is told about the requests, and what it answers is not applied (only a Manifest V2 extension that holds webRequestBlocking may answer)`
      )
    }
    if (first && context.startsWith('worker:')) entry.asleep = []
    const held = entry.listeners.get(context) ?? []
    if (held.length >= NET_LIMITS.listenersPerContext) throw new Error('Too many webRequest listeners in this context.')
    held.push({ event: event as WebRequestEvent, urls, types, tabId, requestHeaders: asked.includes('requestHeaders'), responseHeaders: asked.includes('responseHeaders'), blocking })
    entry.listeners.set(context, held)
    this.announce()
  }

  /** A context ended. The listeners of a worker are kept aside: the next request they cover starts the worker again, which registers them anew. A request waiting for its answer no longer does. */
  contextGone(context: string): void {
    for (const pending of [...this.asks.values()]) {
      for (const [extensionId, waiting] of pending.waiting) if (waiting.delete(context) && waiting.size === 0) pending.waiting.delete(extensionId)
      if (pending.waiting.size === 0) this.settle(pending)
    }
    let changed = false
    for (const entry of this.entries.values()) {
      const held = entry.listeners.get(context)
      if (!held) continue
      entry.listeners.delete(context)
      if (context.startsWith('worker:')) entry.asleep = held
      changed = true
    }
    if (changed) this.announce()
  }

  // ---------------------------------------------------------------- what the session needs ----------------------------------------------------------------

  private *indexes(entry: Entry): Iterable<RuleIndex> {
    if (entry.session.size > 0) yield entry.session
    if (entry.dynamic.size > 0) yield entry.dynamic
    for (const id of entry.enabled) {
      const index = entry.rulesets.get(id)?.index
      if (index && index.size > 0) yield index
    }
  }

  needs(): NetNeeds {
    let rules = false
    let requestHeaders = false
    let responseHeaders = false
    const events = new Set<WebRequestEvent>()
    for (const entry of this.entries.values()) {
      for (const index of this.indexes(entry)) {
        rules = true
        requestHeaders ||= index.requestHeaders
        responseHeaders ||= index.responseHeaders
      }
      for (const held of entry.listeners.values()) for (const listener of held) events.add(listener.event)
      for (const listener of entry.asleep) events.add(listener.event)
    }
    return { rules, requestHeaders, responseHeaders, events }
  }

  private announce(): void {
    const needs = this.needs()
    const key = `${needs.rules}:${needs.requestHeaders}:${needs.responseHeaders}:${[...needs.events].sort().join(',')}`
    if (key === this.lastNeeds) return
    this.lastNeeds = key
    this.host.changed()
  }

  // ---------------------------------------------------------------- a request ----------------------------------------------------------------

  /** Whether the rules and the listeners of this extension see the request at all: never one of another extension. */
  private sees(entry: Entry, request: PreparedRequest): boolean {
    if (request.initiator?.startsWith('chrome-extension://') && !request.initiator.startsWith(`chrome-extension://${entry.owner.id}`)) return false
    return true
  }

  private covering(entry: Entry, request: PreparedRequest): NetRule[] {
    const found: NetRule[] = []
    const givenUp = this.givenUpFor(entry)
    for (const index of this.indexes(entry)) found.push(...index.covering(request, givenUp))
    return found
  }

  /** Tells the host of a rule of this extension its budget kept from a request. A host that fails costs the line, never the request. */
  private givenUpFor(entry: Entry): RuleGivenUpListener {
    return (rule, why, addressLength) => {
      try {
        this.host.ruleGivenUp(entry.owner.id, rule.id, why, addressLength, rule.regexUrlMax ?? REGEX_URL_MAX)
      } catch (error) {
        this.host.warn(`the journal of ${entry.owner.id} could not be told that its rule ${rule.id} was given up: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** The highest priority of the allowAllRequests rules of an extension that cover a document the request sits in. */
  private framePriority(entry: Entry, request: HookRequest): number {
    let priority = 0
    const givenUp = this.givenUpFor(entry)
    for (const index of this.indexes(entry)) {
      if (index.frameRules.length === 0) continue
      request.documents.forEach((document, position) => {
        const above = request.documents[position + 1]
        const asked = prepareRequest({ url: document.url, method: 'get', type: document.top ? 'main_frame' : 'sub_frame', initiator: above?.url ?? null, tabId: request.tabId }, this.host.siteOf)
        if (!asked) return
        for (const rule of index.frameRules) if (rule.priority > priority && ruleCovers(rule, asked, givenUp)) priority = rule.priority
      })
    }
    return priority
  }

  private prepared(request: HookRequest): PreparedRequest | null {
    const prepared = prepareRequest(request, this.host.siteOf)
    // The rules are about the web: a request for anything else is none of theirs.
    return prepared && (prepared.web || /^wss?:/.test(prepared.lower)) ? prepared : null
  }

  /** What the rules of the extensions make of a request before it leaves. */
  beforeRequest(request: HookRequest): Outcome {
    const prepared = this.prepared(request)
    if (!prepared) return { action: 'none' }
    const outcomes: Outcome[] = []
    for (const entry of this.entries.values()) {
      if (!this.sees(entry, prepared)) continue
      const covering = this.covering(entry, prepared)
      const frame = this.framePriority(entry, request)
      if (covering.length === 0 && frame === 0) continue
      outcomes.push(judge(entry.owner, covering, prepared, frame).outcome)
    }
    return combineOutcomes(outcomes)
  }

  /** The headers of a request or of an answer once the header rules of the extensions have spoken; the same object when none did. */
  headers<T extends Record<string, string | string[]>>(request: HookRequest, headers: T, side: 'request' | 'response'): T {
    const prepared = this.prepared(request)
    if (!prepared) return headers
    const field = side === 'request' ? 'requestHeaders' : 'responseHeaders'
    const changes: HeaderChanges[] = []
    // The extension loaded last speaks first.
    for (const entry of [...this.entries.values()].reverse()) {
      if (!this.sees(entry, prepared)) continue
      const covering = this.covering(entry, prepared)
      if (!covering.some((rule) => rule[field] !== undefined)) continue
      const { allowPriority } = judge(entry.owner, covering, prepared, this.framePriority(entry, request))
      for (const rule of headerRules(entry.owner, covering, prepared, allowPriority, field)) changes.push({ ownerId: entry.owner.id, ops: rule[field] ?? [] })
    }
    return changes.length === 0 ? headers : applyHeaderChanges(headers, changes, side)
  }

  // ---------------------------------------------------------------- chrome.webRequest: what happened to a request ----------------------------------------------------------------

  /** Tells the extensions that listen to `event` about a request they may see: one they have host access to, and that is not another extension's. */
  heard(event: WebRequestEvent, request: HookRequest, extras: EventExtras = {}): void {
    void this.dispatch(event, request, extras, false)
  }

  /**
   * Tells the extensions that listen to `event` about a request, and asks the contexts whose blocking listeners cover it (`ask`). Answers null when
   * nobody was asked, so that a request no blocking listener covers is never held back; otherwise a promise that settles once each context asked
   * has answered, or after `BLOCKING_WAIT_MS` without the late ones. Never rejects.
   */
  private dispatch(event: WebRequestEvent, request: HookRequest, extras: EventExtras, ask: boolean): Promise<AskResult> | null {
    let prepared: PreparedRequest | null | undefined
    let pending: PendingAsk | null = null
    const now = Date.now()
    const sends: Array<{ extensionId: string; send: () => void }> = []
    for (const [extensionId, entry] of this.entries) {
      const asleep = entry.asleep.filter((listener) => listener.event === event)
      let any = asleep.length > 0
      for (const held of entry.listeners.values()) any ||= held.some((listener) => listener.event === event)
      if (!any) continue
      prepared ??= prepareRequest(request, this.host.siteOf)
      if (!prepared || !this.sees(entry, prepared) || !entry.owner.canAccess(request.url)) continue
      // Who asks must be within reach too, as on the extension platform: a request of a page the extension cannot read is not its business.
      if (request.type !== 'main_frame' && request.initiator !== null && !entry.owner.canAccess(request.initiator)) continue
      const covers = (listener: Listener): boolean =>
        (listener.tabId === null || listener.tabId === request.tabId) && (listener.types === null || listener.types.has(request.type)) && listener.urls.some((pattern) => pattern === '<all_urls>' || matchPattern(pattern, request.url))
      const told: Listener[] = []
      const contexts = new Set<string>()
      const blocking = new Set<string>()
      for (const [context, held] of entry.listeners) {
        for (const listener of held) {
          if (listener.event !== event || !covers(listener)) continue
          told.push(listener)
          contexts.add(context)
          if (listener.blocking) blocking.add(context)
        }
      }
      const wake = told.length === 0 && asleep.some(covers)
      if (told.length === 0 && !wake) continue
      let token: string | undefined
      if (ask && blocking.size > 0 && isBlockableEvent(event)) {
        if (!this.slow.waits(extensionId, now)) {
          // Late too often: told, not waited for (the journal said so when the pause began).
        } else if (pending === null && this.asks.size >= PENDING_ASKS_MAX) {
          if (!this.toldCrowded) {
            this.toldCrowded = true
            this.host.warn(`${PENDING_ASKS_MAX} requests are already waiting for blocking listeners in this profile: the next ones are told to the extensions without waiting for their answers`)
          }
        } else {
          pending ??= this.openAsk(event)
          pending.waiting.set(extensionId, blocking)
          token = pending.token
        }
      }
      const all = wake ? asleep : told
      const details = eventDetails(event, request, extras, all.some((listener) => listener.requestHeaders), all.some((listener) => listener.responseHeaders))
      const to = [...contexts]
      sends.push({ extensionId, send: () => this.host.send(extensionId, event, details, wake, to, token) })
    }
    // Every context is told only once the ask is complete: an answer that came back at once finds every extension it waits for.
    const result = pending ? this.arm(pending) : null
    for (const { extensionId, send } of sends) {
      try {
        send()
      } catch (error) {
        // An extension that could not be told cannot answer: the request does not wait for it, and the others are told all the same.
        this.host.warn(`cannot tell ${extensionId} about a request (chrome.webRequest.${event}): ${error instanceof Error ? error.message : String(error)}`)
        if (pending?.waiting.delete(extensionId) && pending.waiting.size === 0) this.settle(pending)
      }
    }
    return result
  }

  private openAsk(event: BlockableEvent): PendingAsk {
    const pending: PendingAsk = { token: `${++this.askCount}`, event, waiting: new Map(), responses: new Map(), timer: null, resolve: () => undefined }
    this.asks.set(pending.token, pending)
    return pending
  }

  private arm(pending: PendingAsk): Promise<AskResult> {
    return new Promise<AskResult>((resolve) => {
      pending.resolve = resolve
      pending.timer = setTimeout(() => this.expire(pending), BLOCKING_WAIT_MS)
    })
  }

  /** The time is up: the request goes on without the answers still missing, and the journal says whose. */
  private expire(pending: PendingAsk): void {
    if (this.asks.get(pending.token) !== pending) return
    const now = Date.now()
    for (const extensionId of pending.waiting.keys()) {
      const paused = this.slow.late(extensionId, now) === 'paused'
      this.host.warn(
        paused
          ? `${extensionId} did not answer chrome.webRequest.${pending.event} within ${BLOCKING_WAIT_MS} ms ${SLOW_STRIKES} times in a row: its blocking listeners are told without being waited for during ${SLOW_PAUSE_MS / 1000} s`
          : `${extensionId} did not answer chrome.webRequest.${pending.event} within ${BLOCKING_WAIT_MS} ms: the request went on without its answer`
      )
    }
    this.settle(pending)
  }

  private settle(pending: PendingAsk): void {
    if (this.asks.get(pending.token) !== pending) return
    this.asks.delete(pending.token)
    if (this.asks.size < PENDING_ASKS_MAX / 2) this.toldCrowded = false
    if (pending.timer !== null) clearTimeout(pending.timer)
    const late = [...pending.waiting.keys()]
    // The order of precedence: the extension loaded last speaks first.
    const answers = [...this.entries.keys()].reverse().flatMap((extensionId) => {
      const responses = pending.responses.get(extensionId)
      return responses && responses.length > 0 ? [{ extensionId, responses }] : []
    })
    pending.resolve({ answers, late })
  }

  /**
   * A context answers a request it was asked about (`token`): the answers of its blocking listeners, one each. Only a context asked, of the
   * extension asked, about a request still waiting is heard; anything else (late, unasked, of another profile) changes nothing.
   */
  answer(extensionId: string, context: string, token: unknown, raw: unknown): void {
    const pending = typeof token === 'string' ? this.asks.get(token) : undefined
    const waiting = pending?.waiting.get(extensionId)
    if (!pending || !waiting?.delete(context)) return
    this.slow.answered(extensionId)
    const responses = pending.responses.get(extensionId) ?? []
    const list = Array.isArray(raw) ? raw.slice(0, RESPONSES_MAX) : []
    let refused = Array.isArray(raw) ? 0 : 1
    for (const item of list) {
      const read = readBlockingResponse(pending.event, item)
      if (read === null) refused += 1
      else responses.push(read)
    }
    if (refused > 0) this.tellIgnored(extensionId, pending.event, 'malformed')
    pending.responses.set(extensionId, responses)
    if (waiting.size === 0) pending.waiting.delete(extensionId)
    if (pending.waiting.size === 0) this.settle(pending)
  }

  /** The journal is told, once per extension, event and reason while the extension is loaded, that an answer of its listeners was not applied. */
  private tellIgnored(extensionId: string, event: BlockableEvent, why: Ignored['why'] | 'malformed'): void {
    const entry = this.entries.get(extensionId)
    const key = `${event}:${why}`
    if (!entry || entry.toldIgnored.has(key)) return
    entry.toldIgnored.add(key)
    const reasons: Record<Ignored['why'] | 'malformed', string> = {
      malformed: 'it is not of the shape the platform documents',
      target: 'it redirects to an address a listener may not send a request to (only the web, and the files of the extension from onBeforeRequest)',
      'redirect-conflict': 'an extension loaded after it redirects the same request elsewhere',
      'header-conflict': 'it changes a header that a declarative rule or an extension loaded after it already changed',
      'forbidden-header': 'it changes a header the browser owns (its length, its connection, Location…), which stays as it was',
      'credentials-conflict': 'an extension loaded after it gives other credentials'
    }
    this.host.warn(`an answer of ${extensionId} to chrome.webRequest.${event} is not applied: ${reasons[why]}`)
  }

  private noteIgnored(event: BlockableEvent, ignored: readonly Ignored[]): void {
    for (const { extensionId, why } of ignored) this.tellIgnored(extensionId, event, why)
  }

  /** onBeforeRequest with its blocking listeners: null when none covers the request (it was told to the others), else what they make of it. */
  blockBeforeRequest(request: HookRequest): Promise<RequestVerdict> | null {
    return this.dispatch('onBeforeRequest', request, {}, true)?.then((result) => {
      const verdict = mergeBeforeRequest(result.answers, request.url)
      this.noteIgnored('onBeforeRequest', verdict.ignored)
      return verdict
    }) ?? null
  }

  /** onBeforeSendHeaders: `told` the headers as the page sent them (what the listeners are told), `base` once the declarative rules have spoken. */
  blockRequestHeaders(request: HookRequest, told: Record<string, string>, base: Record<string, string>): Promise<RequestHeadersVerdict> | null {
    return this.dispatch('onBeforeSendHeaders', request, { requestHeaders: told }, true)?.then((result) => {
      const verdict = mergeRequestHeaders(result.answers, told, base)
      this.noteIgnored('onBeforeSendHeaders', verdict.ignored)
      return verdict
    }) ?? null
  }

  /** onHeadersReceived: `extras.responseHeaders` as the server sent them, `base` once the declarative rules have spoken. */
  blockResponseHeaders(request: HookRequest, extras: EventExtras & { responseHeaders: Record<string, string[]> }, base: Record<string, string[]>): Promise<ResponseHeadersVerdict> | null {
    return this.dispatch('onHeadersReceived', request, extras, true)?.then((result) => {
      const verdict = mergeResponseHeaders(result.answers, extras.responseHeaders, base, request.url)
      this.noteIgnored('onHeadersReceived', verdict.ignored)
      return verdict
    }) ?? null
  }

  /** onAuthRequired, from the answer of a server that asks for a login: the cancel or the credentials of the listeners, null when they gave neither. */
  blockAuth(request: HookRequest, extras: EventExtras): Promise<AuthAnswer | null> | null {
    return this.dispatch('onAuthRequired', request, extras, true)?.then((result) => {
      const { answer, ignored } = mergeAuth(result.answers)
      this.noteIgnored('onAuthRequired', ignored)
      return answer
    }) ?? null
  }
}

/** The path of a file an extension names inside its folder, or null when the name leads out of it. */
export function insideFolder(folder: string, name: string): string | null {
  const parts = name.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..') || name.includes('\0')) return null
  return `${folder.replace(/\/+$/, '')}/${parts.join('/')}`
}

const headerList = (headers: Record<string, string | string[]> | undefined): Array<{ name: string; value: string }> => {
  const list: Array<{ name: string; value: string }> = []
  for (const [name, value] of Object.entries(headers ?? {})) for (const item of Array.isArray(value) ? value : [value]) list.push({ name, value: String(item) })
  return list
}

const headerOf = (headers: Record<string, string | string[]> | undefined, wanted: string): string | null => {
  for (const [name, value] of Object.entries(headers ?? {})) if (name.toLowerCase() === wanted) return Array.isArray(value) ? (value[0] ?? null) : value
  return null
}

/** Whether an answer asks the browser for a login: what chrome.webRequest.onAuthRequired is about. */
export function authChallenge(statusCode: number | undefined, responseHeaders: Record<string, string | string[]> | undefined, url: string): { isProxy: boolean; scheme: string; realm?: string; challenger: { host: string; port: number } } | null {
  if (statusCode !== 401 && statusCode !== 407) return null
  const isProxy = statusCode === 407
  const asked = headerOf(responseHeaders, isProxy ? 'proxy-authenticate' : 'www-authenticate')
  if (asked === null || !URL.canParse(url)) return null
  const scheme = (asked.trim().split(/\s+/)[0] ?? '').toLowerCase()
  // Only the schemes the browser answers itself (it asks the user, or the system): a site's own scheme, like "Bearer", asks the browser nothing.
  if (!['basic', 'digest', 'ntlm', 'negotiate'].includes(scheme)) return null
  const realm = /realm="([^"]*)"/i.exec(asked)?.[1]
  const target = new URL(url)
  return { isProxy, scheme, ...(realm !== undefined ? { realm } : {}), challenger: { host: target.hostname, port: Number(target.port) || (target.protocol === 'https:' || target.protocol === 'wss:' ? 443 : 80) } }
}

/** The details an extension receives for an event, in the shape of the extension platform. */
export function eventDetails(event: WebRequestEvent, request: HookRequest, extras: EventExtras, withRequestHeaders: boolean, withResponseHeaders: boolean): Record<string, unknown> {
  const details: Record<string, unknown> = {
    requestId: String(request.id),
    url: request.url,
    method: request.method,
    frameId: request.frameId,
    parentFrameId: request.parentFrameId,
    tabId: request.tabId,
    type: request.type satisfies NetResourceType,
    timeStamp: request.timeStamp,
    ...(request.initiator !== null ? { initiator: request.initiator } : {})
  }
  if (withRequestHeaders && extras.requestHeaders && (event === 'onBeforeSendHeaders' || event === 'onSendHeaders')) details['requestHeaders'] = headerList(extras.requestHeaders)
  if (extras.statusCode !== undefined) details['statusCode'] = extras.statusCode
  if (extras.statusLine !== undefined) details['statusLine'] = extras.statusLine
  if (withResponseHeaders && extras.responseHeaders) details['responseHeaders'] = headerList(extras.responseHeaders)
  if (extras.ip !== undefined) details['ip'] = extras.ip
  if (extras.fromCache !== undefined) details['fromCache'] = extras.fromCache
  if (extras.redirectUrl !== undefined) details['redirectUrl'] = extras.redirectUrl
  if (extras.error !== undefined) details['error'] = extras.error
  if (event === 'onAuthRequired') Object.assign(details, authChallenge(extras.statusCode, extras.responseHeaders, request.url) ?? {})
  return details
}
