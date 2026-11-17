// Looks up the icon of a site from the site itself: the first 64 KB of its home page, the `<link rel="icon">` it declares (rules in
// shared/favicon.ts), then a check that the icon answers and is a picture. No tab is loaded, no third-party icon service is asked
// (that would tell it which sites the user keeps), and a site is asked once: the answer, found or not, is remembered.
//
// The network is a function handed in (`fetch`), so that the rules here are tested against a fake one; favicon-service.ts gives it
// the real one. That function must send no cookie and no Referer, and hand a redirect back as a 3xx answer instead of following it:
// every hop is judged here, so that a site cannot send the lookup to another scheme, to this machine or to the local network.

import { FAVICON_FILE_MAX, FAVICON_HTML_MAX, FAVICON_URL_MAX, acceptIcon, iconCandidates, iconTarget, isPublicHost, type IconJob, type IconTarget } from '@shared/favicon'
import { siteOf } from '@shared/party'

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>

export interface ResolverLimits {
  /** Sites looked up at the same time. */
  concurrency: number
  /** Sites asked in one session, found or not: a long list of tabs must not turn into a crawl. */
  hosts: number
  /** A site that gave nothing is asked again after this long (the session lasting that long). */
  retryAfterMs: number
  /** Each request. */
  timeoutMs: number
  /** One site, all its requests. */
  budgetMs: number
  /** Redirects followed for one request. */
  redirects: number
}

export const DEFAULT_LIMITS: ResolverLimits = { concurrency: 3, hosts: 400, retryAfterMs: 24 * 3_600_000, timeoutMs: 5000, budgetMs: 15_000, redirects: 4 }

/** Pages waiting for their turn: tens of tabs at a time are normal, this only stops a runaway caller. */
const PENDING_MAX = 2000

export interface ResolverDeps {
  fetch: FetchLike
  /** Read again before each site is started: switching the setting off stops the lookups at once. */
  enabled(): boolean
  /** The icon found for a site, for every item that waits for it. */
  deliver(jobIds: string[], origin: string, iconUrl: string): void
  /**
   * The bytes of the icon that was just found, before it is delivered: whoever draws the icon can draw these, and the site is not asked a second
   * time. Absent, the bytes are dropped once checked.
   */
  keep?(iconUrl: string, bytes: Uint8Array, contentType: string | null): void
  /** The request blocker, when it is on: an icon it would cancel in a page is not asked for here either (the home page is a navigation, which it never cancels). */
  blocked?(iconUrl: string, pageUrl: string): boolean
  /** `host[:port]` that may be asked although it is not on the public Internet. Only the engine test says yes: nothing in the application does. */
  allowHost?(host: string): boolean
  now?(): number
  limits?: Partial<ResolverLimits>
}

export interface ResolverStats {
  /** Sites started this session. */
  attempted: number
  found: number
  failed: number
  /** Requests sent. */
  requests: number
  /** Why the sites that gave nothing gave nothing: a rule refused them, they were too slow, they could not be reached, or they declare no icon that answers. */
  reasons: Record<FailureReason, number>
  /** Where the lookup stopped for the sites that answered but gave no icon, in words that name no site ("page 2xx, html, 2 to try"). */
  causes: Record<string, number>
  pending: number
  active: number
}

/** A request the rules refuse (`reason` says which rule), as opposed to a site that does not answer. */
class Refusal extends Error {
  constructor(readonly reason: 'address' | 'blocked' | 'redirect') {
    super(`refused: ${reason}`)
  }
}

export type FailureReason = 'refused' | 'timeout' | 'network' | 'no-icon'

interface Fetched {
  status: number
  /** The address that answered, after the redirects. */
  url: string
  contentType: string | null
  /** The body, cut at the limit asked for: an icon one byte over `FAVICON_FILE_MAX` is refused by `acceptIcon`. */
  bytes: Uint8Array
}

interface Waiting {
  rank: number
  order: number
  ids: Set<string>
}

const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)$/i

export class FaviconResolver {
  private readonly limits: ResolverLimits
  private readonly now: () => number
  private readonly pending = new Map<string, Waiting>()
  private readonly running = new Map<string, Set<string>>()
  private readonly controllers = new Set<AbortController>()
  private readonly found = new Map<string, string>()
  private readonly failed = new Map<string, number>()
  private readonly attempted = new Set<string>()
  private readonly reasons: Record<FailureReason, number> = { refused: 0, timeout: 0, network: 0, 'no-icon': 0 }
  private readonly causes = new Map<string, number>()
  private requests = 0
  private order = 0
  private stopped = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly deps: ResolverDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
  }

  /** Adds the items to look up. An item whose site was already found gets its icon at once; one whose site failed lately waits for the retry delay. */
  enqueue(jobs: readonly IconJob[]): void {
    if (this.stopped || !this.deps.enabled()) return
    const ready = new Map<string, string[]>()
    for (const job of jobs) {
      const target = iconTarget(job.url)
      if (!target || !this.mayAsk(target)) continue
      const known = this.found.get(target.origin)
      if (known !== undefined) {
        ready.set(target.origin, [...(ready.get(target.origin) ?? []), job.id])
        continue
      }
      const running = this.running.get(target.origin)
      if (running) {
        running.add(job.id)
        continue
      }
      const failedAt = this.failed.get(target.origin)
      if (failedAt !== undefined) {
        if (this.now() - failedAt < this.limits.retryAfterMs) continue
        this.failed.delete(target.origin)
      }
      const waiting = this.pending.get(target.origin)
      if (waiting) {
        waiting.ids.add(job.id)
        waiting.rank = Math.min(waiting.rank, job.rank)
      } else if (this.pending.size < PENDING_MAX) {
        this.pending.set(target.origin, { rank: job.rank, order: this.order++, ids: new Set([job.id]) })
      }
    }
    for (const [origin, ids] of ready) this.deps.deliver(ids, origin, this.found.get(origin)!)
    this.pump()
  }

  /** Forgets what waits for its turn (a lookup already started runs to its end). */
  clear(): void {
    this.pending.clear()
    this.wake()
  }

  /** Ends everything: nothing is started again and what is under way is cut. */
  stop(): void {
    this.stopped = true
    this.pending.clear()
    for (const controller of this.controllers) controller.abort()
    this.wake()
  }

  stats(): ResolverStats {
    return { attempted: this.attempted.size, found: this.found.size, failed: this.failed.size, requests: this.requests, reasons: { ...this.reasons }, causes: Object.fromEntries(this.causes), pending: this.pending.size, active: this.running.size }
  }

  /** The icon already found for the site of an address. */
  known(address: string): string | undefined {
    const target = iconTarget(address)
    return target ? this.found.get(target.origin) : undefined
  }

  /** Resolves when nothing waits and nothing runs. */
  idle(): Promise<void> {
    if (this.running.size === 0 && this.pending.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  // ---------- the queue ----------

  /** Where a request may go at all: the public Internet (or, for the engine test only, a host it names). */
  private hostAllowed(url: URL): boolean {
    return isPublicHost(url.hostname) || this.deps.allowHost?.(url.host) === true
  }

  private mayAsk(target: IconTarget): boolean {
    return isPublicHost(target.hostname) || this.deps.allowHost?.(target.host) === true
  }

  private pump(): void {
    while (this.running.size < this.limits.concurrency) {
      if (!this.deps.enabled()) this.pending.clear()
      const next = this.nextWaiting()
      if (!next) break
      const [origin, waiting] = next
      this.pending.delete(origin)
      // The cap counts sites, not items: a site that is asked again after a day is not a new one.
      if (!this.attempted.has(origin) && this.attempted.size >= this.limits.hosts) continue
      this.attempted.add(origin)
      this.running.set(origin, waiting.ids)
      void this.run(origin)
    }
    if (this.running.size === 0 && this.pending.size === 0) this.wake()
  }

  private nextWaiting(): [string, Waiting] | undefined {
    let best: [string, Waiting] | undefined
    for (const entry of this.pending) {
      if (!best || entry[1].rank < best[1].rank || (entry[1].rank === best[1].rank && entry[1].order < best[1].order)) best = entry
    }
    return best
  }

  private wake(): void {
    if (this.running.size > 0 || this.pending.size > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private async run(origin: string): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), this.limits.budgetMs)
    let icon: string | null = null
    let reason: FailureReason = 'no-icon'
    const trace: string[] = []
    try {
      icon = await this.lookup(iconTarget(`${origin}/`)!, controller.signal, trace)
    } catch (error) {
      // A site that is slow, refuses, redirects somewhere it should not or answers with garbage simply has no icon here (the letter
      // stays); the reason is counted so that the numbers say what happened.
      reason = error instanceof Refusal ? 'refused' : controller.signal.aborted || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) ? 'timeout' : 'network'
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
    }
    const ids = [...(this.running.get(origin) ?? [])]
    this.running.delete(origin)
    if (icon !== null) this.found.set(origin, icon)
    else {
      this.failed.set(origin, this.now())
      this.reasons[reason]++
      if (reason === 'no-icon') this.causes.set(trace.join(', '), (this.causes.get(trace.join(', ')) ?? 0) + 1)
    }
    if (icon !== null && !this.stopped && this.deps.enabled() && ids.length > 0) this.deps.deliver(ids, origin, icon)
    this.pump()
  }

  // ---------- one site ----------

  /** The address of the icon of a site, or null. Throws only when the home page could not be read at all (the site is not worth more requests). */
  private async lookup(target: IconTarget, signal: AbortSignal, trace: string[]): Promise<string | null> {
    const page = await this.get(target.root, 'page', target.secure, signal, FAVICON_HTML_MAX, target.root)
    // A home page that sends the visitor to another site (a sign-in service) describes that site, not this one: only /favicon.ico is tried.
    const mine = siteOf(target.root)
    const own = mine !== null && siteOf(page.url) === mine
    const pageUrl = own ? page.url : target.root
    const html = own && page.status < 500 && HTML_TYPE.test((page.contentType ?? '').split(';')[0]!.trim()) ? new TextDecoder('utf-8').decode(page.bytes) : ''
    const secure = new URL(pageUrl).protocol === 'https:'
    const candidates = iconCandidates(html, pageUrl, (address) => this.hostAllowed(new URL(address)))
    trace.push(`page ${Math.floor(page.status / 100)}xx`, own ? (html === '' ? 'no html' : 'html') : 'left the site', `${candidates.length} to try`)
    for (const candidate of candidates) {
      let answer: Fetched
      try {
        answer = await this.get(candidate, 'icon', secure, signal, FAVICON_FILE_MAX + 1, pageUrl)
      } catch (error) {
        // The time of the site is spent: the other addresses would only wait too.
        if (signal.aborted) throw error
        // This address is refused or does not answer: the next one may.
        continue
      }
      if (answer.status >= 200 && answer.status < 300 && acceptIcon(answer.contentType, answer.bytes)) {
        // Outside the `try` above: a keeper that fails is a failure of the lookup, counted as one, not an address to skip.
        this.deps.keep?.(candidate, answer.bytes, answer.contentType)
        return candidate
      }
    }
    return null
  }

  /** One address, with its redirects judged one by one, and a body read up to `max` bytes. */
  private async get(start: string, kind: 'page' | 'icon', secure: boolean, signal: AbortSignal, max: number, pageUrl: string): Promise<Fetched> {
    let url = new URL(start)
    for (let hop = 0; ; hop++) {
      this.check(url, secure)
      if (kind === 'icon' && this.deps.blocked?.(url.href, pageUrl) === true) throw new Refusal('blocked')
      this.requests++
      const response = await this.deps.fetch(url.href, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.limits.timeoutMs)]),
        headers: { accept: kind === 'page' ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' : 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' }
      })
      if (response.status >= 300 && response.status < 400) {
        dropBody(response)
        const location = response.headers.get('location')
        if (!location || hop >= this.limits.redirects || !URL.canParse(location, url)) throw new Refusal('redirect')
        url = new URL(location, url)
        continue
      }
      return { status: response.status, url: url.href, contentType: response.headers.get('content-type'), bytes: await readBody(response, max) }
    }
  }

  /** What a request may be, at every step: a web address that is not a downgrade, has no login, is not too long, and goes to a host that is allowed. */
  private check(url: URL, secure: boolean): void {
    const ok =
      (url.protocol === 'https:' || (url.protocol === 'http:' && !secure)) && url.username === '' && url.password === '' && url.href.length <= FAVICON_URL_MAX && this.hostAllowed(url)
    if (!ok) throw new Refusal('address')
  }
}

const noteCancelFailure = (error: unknown): void => console.debug('[favicon] cannot cancel the rest of a body:', error instanceof Error ? error.message : String(error))

/** Gives up the body of an answer that is not read (a redirect). */
function dropBody(response: Response): void {
  void response.body?.cancel().catch(noteCancelFailure)
}

/** Reads a body up to `max` bytes and drops the rest: a server that streams for ever costs nothing more than `max`. */
async function readBody(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.length > max) {
        chunks.push(value.subarray(0, max - size))
        size = max
        break
      }
      chunks.push(value)
      size += value.length
    }
  } finally {
    await reader.cancel().catch(noteCancelFailure)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}
