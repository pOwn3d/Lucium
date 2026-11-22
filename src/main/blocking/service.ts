// The ad and tracker blocker: keeps the filter lists up to date, compiles them into one engine per category, and
// answers for each request and each page. Electron-free (the download and the engine are injected), so it is tested
// against a local server and tiny lists, never the Internet.
//
// Opt-in: nothing is read, compiled or downloaded until a blocking option is switched on, and nothing is kept in memory
// once both are off. The only network traffic is a GET of each active list from its own host.

import { BLOCKED_HOSTS_PER_PAGE_MAX, type BlockedHost } from '@shared/blocked-hosts'
import { adsBlockingOn, blockModeFor, blockedByHosts, consentWallCss, cookieBannerCss, isBlockingExempt, shouldBlock, toRequestKind, type RequestVerdict } from '@shared/blocker'
import { cleanReviewSummary, isCustomListId, reviewCustomList, type CustomListVerdict, type CustomFilterList, type ReviewSummary } from '@shared/custom-filter-lists'
import { activeLists, FILTER_LISTS, type BlockingConfig, type BlockingStatus, type FilterListCategory, type FilterListSpec } from '@shared/filter-lists'
import { cleanCspPolicy } from '@shared/extended-rules'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/model'
import { isOwnSite } from '@shared/party'
import { redirectTargetOf } from '@shared/redirect-resources'
import { cleanScriptletCalls, parseScriptletCall, type ScriptletCall } from '@shared/scriptlets'
import { YOUTUBE_COSMETIC_CSS, YOUTUBE_SCRIPTLETS, isYouTubeAdRequest, isYouTubePage } from '@shared/youtube-rules'
import type { DomHints, EngineRequest, FilterEngine, FilterEngineBackend, NetworkVerdict } from './filter-engine'
import { ListStore } from './list-store'
import { describeFailure, updateList, type FetchLike, type UpdateOutcome } from './list-updater'

export interface BlockingDeps {
  /** Where the lists and the compiled engines are kept. */
  dir: string
  fetch: FetchLike
  /** Loads the engine implementation. Called when something first needs it, so it costs nothing while blocking is off. */
  backend: () => Promise<FilterEngineBackend>
  catalog?: readonly FilterListSpec[]
  now?: () => number
  timeoutMs?: number
  /** Accept lists served over plain http. Tests only. */
  allowInsecure?: boolean
}

/**
 * The settings the service reads on each request or page; the exceptions are read live, so a change needs no reconfiguration.
 * `blockScriptlets` is the switch of the extended rules (scriptlets, stand-in resources, `$removeparam`, `$csp`): absent means off.
 */
export type BlockingSettings = Pick<Settings, 'blockAds' | 'blockTrackers' | 'blockCookieBanners' | 'blockCosmetic' | 'blockExceptions' | 'blockMode'> & Partial<Pick<Settings, 'blockScriptlets' | 'blockModeSites'>>

export interface BlockedRequest {
  url: string
  resourceType: string
  /** The page the user opened (the tab's address): the site exceptions and the "never block the page itself" rule are about it. */
  pageUrl: string | null
  /** The page (tab) that makes the request, for the per-tab counter. */
  pageId: string | null
  /** The document that makes the request (a frame's, a worker's origin), when it is not the tab's page. Standard mode judges "whose request" by it. */
  documentUrl?: string | null
  /** The HTTP method, when the session says it: an address is only rewritten for a request that can be repeated (GET, HEAD). */
  method?: string
}

export type BlockingEvent = 'status' | 'engine'

const DAY_MS = 86_400_000
// An hourly look, not an hourly download: a list is fetched again only once its `filterUpdateDays` (4 by default) have passed since it was
// last checked, or when the user asks for it.
const CHECK_EVERY_MS = 3_600_000
const COUNTERS_MAX = 500

interface Compiled {
  engine: FilterEngine
  key: string
  /** Made from at least one list of the catalog. An engine of the user's own lists alone does not stand for the built-in list: the networks it names stay covered. */
  catalog: boolean
}

const CATEGORIES: readonly FilterListCategory[] = ['ads', 'cookies']

/** Block beats a stand-in, which beats a cleaned address: the strongest answer of the lists wins. */
const rank = (verdict: NetworkVerdict): number => (verdict.action === 'block' ? 3 : verdict.action === 'redirect' ? 2 : verdict.action === 'rewrite' ? 1 : 0)

/** A list of the user's as the catalog's lists are seen by the engine code. Its `url` is empty: it is never downloaded. */
function customSpec(list: CustomFilterList): FilterListSpec {
  return { id: list.id, title: list.title, description: list.sourceName, category: 'ads', url: '', homepage: '', license: '', licenseUrl: '', author: '' }
}

export class BlockingService {
  private readonly store: ListStore
  private catalog: readonly FilterListSpec[]
  private now: () => number
  private config: BlockingConfig | null = null
  private readonly engines = new Map<FilterListCategory, Compiled>()
  private backend: FilterEngineBackend | null = null
  private readonly counts = new Map<string, number>()
  /** The hosts behind those counts, page by page: in memory only, emptied when the page navigates, never written anywhere. */
  private readonly hosts = new Map<string, Map<string, number>>()
  private sessionTotal = 0
  /** The session's blocks by what list stopped them: the ad lists (and the built-in ad list), the cookie-banner lists. */
  private sessionByKind = { ads: 0, banners: 0 }
  private readonly listeners = new Set<(event: BlockingEvent) => void>()
  private readonly updating = new Set<string>()
  private running: Promise<void> | null = null
  private rerun = false
  private forceUpdate = false
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private deps: BlockingDeps) {
    this.store = new ListStore(deps.dir)
    this.catalog = deps.catalog ?? FILTER_LISTS
    this.now = deps.now ?? Date.now
  }

  // ---------- configuration ----------

  /** Applies the settings. Starts the work (cache, downloads, compilation) in the background and returns at once. */
  configure(config: BlockingConfig): void {
    if (this.disposed) return
    this.config = config
    if (!config.ads && !config.cookieBanners) {
      // Nothing to block: let go of the engines (some 10 MB of buffers with the full lists, 20 to 30 MB of resident memory: docs/performance.md) and of the timer.
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      if (this.engines.size > 0) {
        this.engines.clear()
        this.emit('engine')
      }
      this.emit('status')
      return
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.run(), CHECK_EVERY_MS)
      this.timer.unref?.()
    }
    void this.run()
  }

  /**
   * Swaps the download, the catalog or the clock of a running service. The engine test points the application's service at a local server.
   * Nothing in the application calls it, and outside an engine test run (`--smoke`, as blocking/index.ts reads it) it refuses, as the
   * favicon lookup does for its own: any code of the main process could otherwise make the blocker take its lists over plain http.
   */
  useForTests(overrides: Partial<Pick<BlockingDeps, 'fetch' | 'catalog' | 'now' | 'allowInsecure' | 'timeoutMs'>>, argv: readonly string[] = process.argv): void {
    if (!argv.includes('--smoke')) throw new Error('useForTests is for the engine test only')
    this.deps = { ...this.deps, ...overrides }
    if (overrides.catalog) this.catalog = overrides.catalog
    if (overrides.now) this.now = overrides.now
  }

  /** "Mettre à jour maintenant": fetches every active list again, whatever its age. Resolves when the work is done. */
  async updateNow(): Promise<void> {
    if (!this.config || (!this.config.ads && !this.config.cookieBanners)) return
    this.forceUpdate = true
    await this.run()
  }

  /** Resolves when the work in progress (and what was asked while it ran) is done. Tests use it. */
  async settled(): Promise<void> {
    while (this.running) await this.running
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
  }

  subscribe(listener: (event: BlockingEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: BlockingEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  // ---------- work: cache, downloads, compilation ----------

  /** Runs the work once at a time; a request that arrives meanwhile makes it run again from the start. */
  private run(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    const work = (async () => {
      try {
        do {
          this.rerun = false
          await this.reconcile()
        } while (this.rerun && !this.disposed)
      } catch (error) {
        console.error('[blocking] update failed:', error)
      } finally {
        this.running = null
        this.emit('status')
      }
    })()
    this.running = work
    return work
  }

  private wanted(category: FilterListCategory): FilterListSpec[] {
    const config = this.config
    if (!config) return []
    const own = category === 'ads' && config.ads ? (config.customLists ?? []).filter((l) => l.enabled).map(customSpec) : []
    return [...activeLists(this.catalog, config).filter((l) => l.category === category), ...own]
  }

  private async reconcile(): Promise<void> {
    // Before any download, bring up what is already on disk: protection from the first request of a launch.
    for (const category of CATEGORIES) await this.compile(category)
    const config = this.config
    if (!config || this.disposed) return
    const force = this.forceUpdate
    this.forceUpdate = false
    const due = (list: FilterListSpec, days: number): boolean => {
      const meta = this.store.meta(list.id)
      return force || !meta || this.now() - meta.checkedAt >= days * DAY_MS
    }
    let changed = false
    for (const list of activeLists(this.catalog, config)) {
      if (this.disposed) break
      // The settings are read again for each list: the downloads take a while, and a blocker switched off (or a list switched off) while the
      // first ones came in must not go on fetching the next ones.
      const live = this.config
      if (!live || !activeLists(this.catalog, live).some((l) => l.id === list.id) || !due(list, live.updateDays)) continue
      this.updating.add(list.id)
      this.emit('status')
      const before = this.store.meta(list.id)?.hash
      let outcome: UpdateOutcome
      try {
        outcome = await updateList(list, { store: this.store, fetch: this.deps.fetch, now: this.now, timeoutMs: this.deps.timeoutMs ?? 60_000, allowInsecure: this.deps.allowInsecure })
      } catch (error) {
        // `updateList` answers its own failures: this is a fault of ours. The list shows it, and the lists after it are still updated.
        console.error(`[blocking] the update of ${list.id} failed unexpectedly:`, error)
        this.store.fail(list.id, describeFailure(error), this.now())
        outcome = 'failed'
      }
      // Whatever happened, the list is not "downloading" any more: the settings must not show a spinner for ever.
      this.updating.delete(list.id)
      if (outcome === 'updated' && this.store.meta(list.id)?.hash !== before) changed = true
      this.emit('status')
    }
    if (changed) for (const category of CATEGORIES) await this.compile(category)
  }

  /** The engine of a category for the lists installed now: from the cache when it matches, else compiled and cached. */
  private async compile(category: FilterListCategory): Promise<void> {
    const lists = this.wanted(category).filter((l) => this.store.meta(l.id))
    if (lists.length === 0) {
      if (this.engines.delete(category)) this.emit('engine')
      return
    }
    const backend = (this.backend ??= await this.deps.backend())
    const key = [backend.id, ...lists.map((l) => `${l.id}:${this.store.meta(l.id)!.hash}`).sort()].join('|')
    if (this.engines.get(category)?.key === key) return

    let engine: FilterEngine | null = null
    const cached = this.store.readEngine(category)
    if (cached?.key === key) {
      try {
        engine = await backend.load(cached.bytes)
      } catch (error) {
        console.warn(`[blocking] cached ${category} engine unusable, rebuilding:`, (error as Error).message)
      }
    } else if (cached) {
      // Not damaged, only made from other lists or by another engine version: normal after an update, told all the same.
      console.info(`[blocking] the compiled ${category} engine on disk was made from other lists or by another engine version, compiling again`)
    } else {
      console.info(`[blocking] no usable compiled ${category} engine on disk, compiling the lists`)
    }
    if (!engine) {
      engine = await this.buildEngine(backend, lists)
      if (!engine) return
      try {
        this.store.writeEngine(category, { key, bytes: engine.serialize() })
      } catch (error) {
        console.warn(`[blocking] cannot cache the ${category} engine:`, (error as Error).message)
      }
    }
    // The options may have gone off while this was built (the library loads on first use): an engine for lists nobody wants any more is not kept in memory.
    // A change of lists is another matter: the run it asked for compiles again, and this engine is the one that serves until then.
    if (this.disposed || this.wanted(category).length === 0) return
    this.engines.set(category, { engine, key, catalog: lists.some((l) => !isCustomListId(l.id)) })
    this.emit('engine')
  }

  /**
   * Compiles the installed texts of `lists`. The lists of the user's go in the same engine as ours, so one that breaks the compilation
   * must not take the others down: they are tried one by one on top of the catalog's, and the one that fails is left out with its failure
   * recorded (the settings print it under the list). Null when no text could be read.
   */
  private async buildEngine(backend: FilterEngineBackend, lists: readonly FilterListSpec[]): Promise<FilterEngine | null> {
    const textsOf = (some: readonly FilterListSpec[]): string[] => some.map((l) => this.store.read(l.id)).filter((t): t is string => t !== null)
    const texts = textsOf(lists)
    if (texts.length === 0) return null
    try {
      return await backend.build(texts)
    } catch (error) {
      const own = lists.filter((l) => isCustomListId(l.id))
      if (own.length === 0) throw error
      console.error('[blocking] the filter engine failed to compile with the custom lists, trying them one by one:', error instanceof Error ? error.message : error)
      const usable = lists.filter((l) => !isCustomListId(l.id))
      for (const list of own) {
        try {
          await backend.build(textsOf([...usable, list]))
          usable.push(list)
        } catch (failure) {
          console.error(`[blocking] the custom list ${list.id} cannot be compiled and is left out:`, failure instanceof Error ? failure.message : failure)
          this.store.fail(list.id, t('blocking-service.le-moteur-de-filtres-n-a-pas-pu-compiler-cette-liste'), this.now())
        }
      }
      const rest = textsOf(usable)
      return rest.length > 0 ? backend.build(rest) : null
    }
  }

  // ---------- the user's own lists ----------

  /** Reads the text of a list the user gave and keeps the rules that can be applied safely (see custom-filter-lists.ts). Installs nothing. */
  async reviewCustomText(text: string, maxChars?: number): Promise<CustomListVerdict> {
    const backend = (this.backend ??= await this.deps.backend())
    return reviewCustomList(text, backend.parses ?? (() => true), maxChars)
  }

  /** Puts the reviewed rules of a list on disk and brings them into the engine. The list is the one `filterlist/add` records in the settings. */
  async installCustomList(list: Pick<CustomFilterList, 'id'>, review: { text: string; rules: number; ignored: number; invalid: number; samples: ReviewSummary['samples'] }): Promise<void> {
    if (!isCustomListId(list.id)) throw new Error(`Invalid custom list id: ${String(list.id)}`)
    this.store.install(list.id, review.text, { checkedAt: this.now(), rules: review.rules, review: { ignored: review.ignored, invalid: review.invalid, samples: review.samples } })
    await this.run()
  }

  /** Deletes the rules of a list of the user's. */
  async removeCustomList(id: string): Promise<void> {
    if (!isCustomListId(id)) throw new Error(`Invalid custom list id: ${String(id)}`)
    this.store.remove(id)
    await this.run()
  }

  // ---------- answering ----------

  /**
   * Whether a request must be cancelled. The page the user opened is never blocked (and a new one starts a fresh counter).
   * A switched-on category with no compiled lists yet is covered by the short built-in list. `extraHosts` are ad networks
   * on top of it, belonging to the window that asks (only the engine test sets any, to block a local host).
   *
   * Standard mode (the default) judges a request by the document that makes it: a request to that document's own site
   * is left alone by the ad and tracker lists unless a rule names the first party, so a frame's own files are never cut because of
   * the site around it. Cookie-banner lists keep applying to it: banners are removed whoever serves them. Strict applies every
   * list to every request, judged against the page of the tab. The mode is the page's own site choice when it has one (`blockModeSites`).
   */
  filter(request: BlockedRequest, settings: BlockingSettings, extraHosts: readonly string[] = []): boolean {
    return this.judge(request, settings, extraHosts, false) === true
  }

  /**
   * The same judgement with the extended rules of the lists applied when the setting asks for them (`blockScriptlets`): a request a rule
   * redirects gets a stand-in resource of Lucium's own instead of being cancelled, and `$removeparam` cleans the address. Without the setting
   * this is `filter()`: cancel or let go.
   */
  verdict(request: BlockedRequest, settings: BlockingSettings, extraHosts: readonly string[] = []): RequestVerdict {
    return this.judge(request, settings, extraHosts, settings.blockScriptlets === true)
  }

  private judge(request: BlockedRequest, settings: BlockingSettings, extraHosts: readonly string[], extended: boolean): RequestVerdict {
    const ads = adsBlockingOn(settings)
    const banners = settings.blockCookieBanners
    if (request.resourceType === 'mainFrame') {
      if (request.pageId) {
        this.counts.delete(request.pageId)
        this.hosts.delete(request.pageId)
      }
      // The page the user opened is never blocked; with the extended rules on, its address may lose the parameters a rule names.
      return extended && (ads || banners) ? this.cleanedNavigation(request, settings) : false
    }
    if (!ads && !banners) return false
    if (isBlockingExempt(request.pageUrl, settings.blockExceptions)) return false
    // YouTube's own advertising paths, on a YouTube page only (the rule is about that page, not the request's document).
    if (ads && isYouTubePage(request.pageUrl) && isYouTubeAdRequest(request.url)) return this.applied(request, { action: 'block' }, 'ads')

    const standard = blockModeFor(settings, request.pageUrl) !== 'strict'
    // The document that makes the request; the tab's page when the session does not say (a request with neither is judged against nothing).
    const source = standard ? (request.documentUrl ?? request.pageUrl) : request.pageUrl
    let blocked = false
    let kind: 'ads' | 'banners' | null = null
    if (ads && extraHosts.length > 0 && blockedByHosts(request, source, extraHosts)) {
      blocked = true
      kind = 'ads'
    }
    const adsEngine = this.engines.get('ads')
    const cookieEngine = this.engines.get('cookies')
    if (!blocked) {
      // The short built-in list covers a category until a list of the catalog is compiled for it (lists of the user's alone are an addition, not a replacement).
      const builtIn = { ads: ads && !adsEngine?.catalog, cookieBanners: banners && !cookieEngine?.catalog }
      // The built-in list does not say which of its two categories a request belongs to: it is counted as an ad.
      if ((builtIn.ads || builtIn.cookieBanners) && shouldBlock(request, source, builtIn)) {
        blocked = true
        kind = 'ads'
      }
    }
    let answer: NetworkVerdict = blocked ? { action: 'block' } : { action: 'pass' }
    if (blocked) kind = kind ?? 'ads'
    if (!blocked && (adsEngine || cookieEngine)) {
      const engineRequest = { url: request.url, sourceUrl: source ?? '', kind: toRequestKind(request.resourceType) }
      const ownSite = standard && isOwnSite(request.url, source)
      // The ad lists first; the banner lists are only asked when the ad lists did not already stop the request.
      if (ads && adsEngine) {
        answer = this.ask(adsEngine.engine, { ...engineRequest, ownSite }, extended)
        if (answer.action === 'block') kind = 'ads'
      }
      if (banners && cookieEngine && answer.action !== 'block') {
        const next = this.ask(cookieEngine.engine, engineRequest, extended)
        if (rank(next) > rank(answer)) {
          answer = next
          if (next.action === 'block') kind = 'banners'
        }
      }
    }
    return this.applied(request, answer, kind)
  }

  private ask(engine: FilterEngine, request: EngineRequest, extended: boolean): NetworkVerdict {
    if (extended && engine.decide) return engine.decide(request)
    return engine.shouldBlock(request) ? { action: 'block' } : { action: 'pass' }
  }

  /** Turns what the engine said into what the session does, and counts what was stopped. A redirect to a resource Lucium does not have is a block. */
  private applied(request: BlockedRequest, answer: NetworkVerdict, kind: 'ads' | 'banners' | null = null): RequestVerdict {
    if (answer.action === 'pass') return false
    if (answer.action === 'rewrite') {
      // Only a request that can be repeated is sent elsewhere, and only to an address of the web.
      const method = request.method?.toUpperCase()
      if ((method !== undefined && method !== 'GET' && method !== 'HEAD') || !/^https?:\/\//i.test(answer.url) || answer.url === request.url) return false
      return { redirect: answer.url }
    }
    if (request.pageId) {
      this.count(request.pageId)
      this.noteHost(request.pageId, request.url)
      this.sessionTotal++
      if (kind !== null && answer.action === 'block') this.sessionByKind[kind]++
    }
    if (answer.action === 'redirect') {
      const target = redirectTargetOf(answer.resource)
      if (target !== null) return { redirect: target }
    }
    return true
  }

  /** A navigation's address after the `$removeparam` rules, as a verdict; false when nothing changes. Never a block: the page the user opened is theirs. */
  private cleanedNavigation(request: BlockedRequest, settings: BlockingSettings): RequestVerdict {
    if (isBlockingExempt(request.url, settings.blockExceptions)) return false
    const asked: Array<FilterEngine | undefined> = [adsBlockingOn(settings) ? this.engines.get('ads')?.engine : undefined, settings.blockCookieBanners ? this.engines.get('cookies')?.engine : undefined]
    for (const engine of asked) {
      const answer = engine?.decide?.({ url: request.url, sourceUrl: '', kind: 'main_frame' })
      if (answer?.action === 'rewrite') return this.applied(request, answer)
    }
    return false
  }

  // ---------- the extended rules that run in the page or on its document ----------

  /**
   * The scriptlets the lists name for a page, each checked against Lucium's library (a name it has, arguments of the right shape): a rule that
   * names anything else is dropped, whichever list it came from. The lists' scriptlets are empty unless the extended rules are on; the YouTube player
   * rules need only the ads switch, on a YouTube page. Nothing at all on a site with an exception.
   */
  scriptletCalls(pageUrl: string, settings: BlockingSettings): ScriptletCall[] {
    if (isBlockingExempt(pageUrl, settings.blockExceptions)) return []
    // The YouTube player rules are on by default on youtube.com (with the ads switch): they do not wait for `blockScriptlets`.
    const ads = adsBlockingOn(settings)
    const named: ScriptletCall[] = ads && isYouTubePage(pageUrl) ? [...YOUTUBE_SCRIPTLETS] : []
    if (settings.blockScriptlets !== true) return cleanScriptletCalls(named)
    for (const [on, category] of [[ads, 'ads'], [settings.blockCookieBanners, 'cookies']] as const) {
      const engine = on ? this.engines.get(category)?.engine : undefined
      for (const rule of engine?.scriptlets?.(pageUrl) ?? []) {
        const verdict = parseScriptletCall(rule.name, rule.args)
        if (verdict.ok) named.push(verdict.call)
      }
    }
    return cleanScriptletCalls(named)
  }

  /** The `$csp` policy the lists add to a main document (directives that are acceptable only; see shared/extended-rules.ts), or null. */
  cspFor(pageUrl: string, settings: BlockingSettings): string | null {
    if (settings.blockScriptlets !== true || isBlockingExempt(pageUrl, settings.blockExceptions)) return null
    const policies: string[] = []
    for (const [on, category] of [[adsBlockingOn(settings), 'ads'], [settings.blockCookieBanners, 'cookies']] as const) {
      const text = on ? this.engines.get(category)?.engine.cspFor?.(pageUrl) : undefined
      const clean = text === undefined ? null : cleanCspPolicy(text)
      if (clean !== null) policies.push(clean)
    }
    return policies.length === 0 ? null : [...new Set(policies)].join('; ')
  }

  /**
   * The stylesheet that hides ads and banners on a page. `dom` (the classes, ids and links found in the page) adds the
   * generic rules that need them. Empty on a site with an exception and when nothing is on.
   */
  cosmeticCss(pageUrl: string, settings: BlockingSettings, dom?: DomHints): string {
    if (isBlockingExempt(pageUrl, settings.blockExceptions)) return ''
    const parts: string[] = []
    if (settings.blockCookieBanners) {
      const engine = this.engines.get('cookies')
      // The lists answer many consent walls with scriptlets, which are not run here: the known containers stay hidden on top of them.
      parts.push(engine ? [engine.engine.cosmeticCss(pageUrl, dom), consentWallCss()].filter((part) => part !== '').join('\n\n') : cookieBannerCss())
    }
    // Hiding ads is the user's choice apart from cancelling their requests; hiding cookie banners is the point of that option.
    const adsOn = adsBlockingOn(settings)
    const ads = this.engines.get('ads')
    if (adsOn && settings.blockCosmetic && ads) parts.push(ads.engine.cosmeticCss(pageUrl, dom))
    // The YouTube advertising blocks: hidden with the ads switch, on a YouTube page only, whether or not the lists are compiled.
    if (adsOn && settings.blockCosmetic && isYouTubePage(pageUrl)) parts.push(YOUTUBE_COSMETIC_CSS)
    return parts.filter((part) => part !== '').join('\n\n')
  }

  /** Whether the compiled lists (not only the built-in short one) are in use for what is switched on. */
  hasCompiledLists(): boolean {
    return this.engines.size > 0
  }

  // ---------- the counter of one page ----------

  private count(pageId: string): void {
    const next = (this.counts.get(pageId) ?? 0) + 1
    this.counts.delete(pageId)
    this.counts.set(pageId, next)
    // Closed pages are never told to us: forget the oldest rather than grow without bound.
    if (this.counts.size > COUNTERS_MAX) this.counts.delete(this.counts.keys().next().value!)
  }

  /** A request the shell stopped for a protection of its own (a tracking ping, shell/browser-network.ts): it counts like a block of the lists, on its page and in the session. */
  noteStopped(pageId: string | null): void {
    if (!pageId) return
    this.count(pageId)
    this.sessionTotal++
  }

  /** A page navigated: its counter starts again. The request filter of the lists does it itself while they are on; the shell does it when only its own protections are. */
  resetPageCount(pageId: string): void {
    this.counts.delete(pageId)
  }

  /** The host of a cancelled request goes in the page's list, unless the list is full (the request is counted all the same). */
  private noteHost(pageId: string, url: string): void {
    if (!URL.canParse(url)) return
    const { hostname } = new URL(url)
    if (hostname === '') return
    const listed = this.hosts.get(pageId) ?? new Map<string, number>()
    if (!listed.has(hostname) && listed.size >= BLOCKED_HOSTS_PER_PAGE_MAX) return
    listed.set(hostname, (listed.get(hostname) ?? 0) + 1)
    this.hosts.delete(pageId)
    this.hosts.set(pageId, listed)
    // Closed pages are never told to us: forget the oldest rather than grow without bound.
    if (this.hosts.size > COUNTERS_MAX) this.hosts.delete(this.hosts.keys().next().value!)
  }

  /** The hosts blocked on a page since it last navigated, the most blocked first (a copy: the caller may keep it or cut it). */
  blockedHosts(pageId: string): BlockedHost[] {
    return [...(this.hosts.get(pageId) ?? [])].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
  }

  /** Requests blocked on a page since it last navigated. */
  blockedCount(pageId: string): number {
    return this.counts.get(pageId) ?? 0
  }

  /** Total requests blocked since the application started. */
  sessionBlockedCount(): number {
    return this.sessionTotal
  }

  /** The session's blocks split by what stopped them (the dashboard's split). */
  sessionBlockedByKind(): { ads: number; banners: number } {
    return { ...this.sessionByKind }
  }

  /** Reset the session counter. */
  resetSessionBlockedCount(): void {
    this.sessionTotal = 0
    this.sessionByKind = { ads: 0, banners: 0 }
  }

  // ---------- what the settings show ----------

  status(): BlockingStatus {
    const stateOf = (id: string) => {
      const meta = this.store.meta(id)
      const error = this.store.errorOf(id)
      return { id, installed: meta !== undefined, updatedAt: meta?.checkedAt ?? null, rules: meta?.rules ?? null, error: error ?? null, updating: this.updating.has(id) }
    }
    return {
      lists: [
        ...this.catalog.map((list) => stateOf(list.id)),
        ...(this.config?.customLists ?? []).map((list) => ({ ...stateOf(list.id), custom: true, ...(cleanReviewSummary(this.store.meta(list.id)?.review) ? { review: cleanReviewSummary(this.store.meta(list.id)?.review)! } : {}) }))
      ],
      engineReady: [...this.engines.values()].some((engine) => engine.catalog),
      updating: this.running !== null
    }
  }
}
