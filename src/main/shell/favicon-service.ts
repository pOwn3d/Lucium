// Gives their site's icon to the favourites, pinned tabs and tabs of Today that have none (an imported tab never loaded, so it never
// received one). It watches the state, asks the resolver (favicon-resolver.ts) about the items that want an icon, and hands the answers
// back to the reducer as `favicon/fill`. The one network code of the feature lives here: a request that carries nothing of the user.
//
// What leaves the machine, and why it is acceptable: one GET of the home page of each site (the first 64 KB are read) and one GET of the
// icon, from the engine, without cookies, without Referer, in a session of its own that keeps nothing on disk. The sites are the ones the
// user pinned or opened, so the site learns what visiting it would have told it anyway; nothing goes to a third party. The request
// blocker still has its say about the icon (see `blocked`). The session says what the pages say (the standard user agent, see shared/user-agent.ts):
// the lookup is a page load made on behalf of the user, and a site must not treat it differently.

import { net, type Session, session } from 'electron'
import { iconsWanted, type IconFill } from '@shared/favicon'
import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import type { StateStore } from '../store'
import type { ProxyFollow } from '../engine/network'
import { FaviconResolver, type FetchLike, type ResolverStats } from './favicon-resolver'

/** No "persist:" prefix: the session lives in memory, so no cache or cookie of a looked-up site reaches the disk. */
const PARTITION = 'lucium-favicons'
/** Changes of the state come in bursts (an import adds hundreds of tabs): the lookup waits for the burst to end. */
const SETTLE_MS = 800
/** The first lookup waits for the window to settle, so that it never competes with the pages being restored. */
const START_DELAY_MS = 1500

const NO_BODY_STATUSES = new Set([204, 205, 304])

/**
 * A `fetch` over Electron's network stack that gives a redirect back as a 3xx answer. `net.fetch` cannot: its manual mode throws, and
 * its followed redirects hide the address they ended on. Cookies are neither sent nor stored (`credentials: 'omit'`), no Referer is sent,
 * and nothing is cached. `settled` is the session's pending proxy change (see ProxyFollow): a request waits for it, so that none leaves by
 * the system's route while the user chose another.
 */
export function requestFetch(ses: Session, settled: () => Promise<void> | undefined = () => undefined): FetchLike {
  const send: FetchLike = (url, { signal, headers }) =>
    new Promise<Response>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      const request = net.request({ url, session: ses, method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', priority: 'low', headers })
      let answered = false
      let finished = false
      let body: ReadableStreamDefaultController<Uint8Array> | null = null
      const finish = (): void => {
        finished = true
        signal.removeEventListener('abort', onAbort)
      }
      /** An error before the answer rejects the call; after it, it ends the body that is being read. */
      const fail = (reason: unknown): void => {
        if (finished && answered) return
        finish()
        if (!answered) {
          answered = true
          reject(reason)
        } else {
          try {
            body?.error(reason)
          } catch (error) {
            console.debug('[favicon] the body had already ended:', error instanceof Error ? error.message : String(error))
          }
        }
      }
      const onAbort = (): void => {
        request.abort()
        fail(signal.reason ?? new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      request.on('redirect', (status, _method, location) => {
        if (answered) return
        answered = true
        finish()
        // Nothing follows on its own in manual mode: the caller judges the destination.
        resolve(new Response(null, { status, headers: { location } }))
        request.abort()
      })
      request.on('response', (res) => {
        if (answered) return
        answered = true
        const answerHeaders = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          try {
            answerHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
          } catch (error) {
            // A header Chromium accepted and the Fetch standard does not (a stray control character): it is not one we read.
            console.debug(`[favicon] skipped the header ${name.slice(0, 40)}:`, error instanceof Error ? error.message : String(error))
          }
        }
        if (NO_BODY_STATUSES.has(res.statusCode)) {
          finish()
          resolve(new Response(null, { status: res.statusCode, headers: answerHeaders }))
          request.abort()
          return
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller
            res.on('data', (chunk: Buffer) => {
              if (!finished) controller.enqueue(new Uint8Array(chunk))
            })
            res.on('end', () => {
              if (finished) return
              finish()
              controller.close()
            })
            res.on('error', fail)
            res.on('aborted', () => fail(new Error('the answer was cut')))
          },
          cancel() {
            finish()
            request.abort()
          }
        })
        resolve(new Response(stream, { status: res.statusCode, headers: answerHeaders }))
      })
      request.on('error', fail)
      request.end()
    })
  return (url, init) => {
    const pending = settled()
    return pending ? pending.then(() => send(url, init)) : send(url, init)
  }
}

export interface FaviconServiceDeps {
  /** The state of the window that owns the lookup: settings, favourites. */
  store: Pick<StateStore, 'get' | 'subscribe'>
  /** The state as each window shows it (the current space differs by window). */
  views(): SidebarState[]
  /** Whether a tab has a page in memory, which then tells its own icon. */
  hasPage(tabId: string): boolean
  dispatch(action: Action): void
  /** The request blocker, when it is on. */
  blocked(iconUrl: string, pageUrl: string): boolean
  /** Puts the lookup's session on the proxy the settings give it (the engine's `followProxy`); absent in the engine test that has no proxy. */
  followProxy?(ses: Session, what: string): ProxyFollow
  /** The bytes of an icon the lookup just checked: the engine keeps them as the copy the interface draws (engine/site-icons.ts). */
  keepIcon?(iconUrl: string, bytes: Uint8Array, contentType: string | null): void
}

export class FaviconService {
  private readonly ses: Session
  private readonly proxy: ProxyFollow | null
  private readonly resolver: FaviconResolver
  private readonly testHosts = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private stopped = false

  constructor(private readonly deps: FaviconServiceDeps) {
    this.ses = session.fromPartition(PARTITION)
    this.proxy = this.deps.followProxy?.(this.ses, 'the favicon lookups') ?? null
    this.resolver = new FaviconResolver({
      fetch: requestFetch(this.ses, () => this.proxy?.settled()),
      enabled: () => this.deps.store.get().settings.resolveFavicons,
      deliver: (ids, origin, faviconUrl) => this.deps.dispatch({ type: 'favicon/fill', entries: ids.map((id): IconFill => fillOf(id, origin, faviconUrl)) }),
      blocked: (iconUrl, pageUrl) => this.deps.blocked(iconUrl, pageUrl),
      keep: (iconUrl, bytes, contentType) => this.deps.keepIcon?.(iconUrl, bytes, contentType),
      allowHost: (host) => this.testHosts.has(host)
    })
  }

  /** Starts watching the state: a first pass once the window has settled, then one after every burst of changes. */
  start(): void {
    this.unsubscribe = this.deps.store.subscribe(() => this.schedule())
    this.schedule(START_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.resolver.stop()
    this.proxy?.release()
  }

  /** Looks at the state again soon (once, however many changes come in meanwhile). */
  schedule(delayMs = SETTLE_MS): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.scan()
    }, delayMs)
  }

  /** Puts the items that want an icon in the queue, or empties the queue when the setting is off. */
  scan(): void {
    if (this.stopped) return
    if (!this.deps.store.get().settings.resolveFavicons) return this.resolver.clear()
    const jobs = iconsWanted(this.deps.views(), this.deps.hasPage)
    if (jobs.length > 0) this.resolver.enqueue(jobs)
  }

  stats(): ResolverStats {
    return this.resolver.stats()
  }

  /** Resolves when nothing waits and nothing runs. */
  idle(): Promise<void> {
    return this.resolver.idle()
  }

  /** The session the requests go through: the engine test reads its cookies to prove none is sent. */
  requestSession(): Session {
    return this.ses
  }

  /**
   * Engine test only: lets the lookup go to these `host:port` although they are on this machine, and trust the self-signed
   * certificate they present. Nothing in the application calls it, and outside an engine test run (`--smoke`, as blocking/index.ts
   * reads it) it refuses: any code of the main process could otherwise turn off the check of the certificates of this session.
   */
  allowHostsForTest(hosts: readonly string[], argv: readonly string[] = process.argv): void {
    if (!argv.includes('--smoke')) throw new Error('allowHostsForTest is for the engine test only')
    this.testHosts.clear()
    for (const host of hosts) this.testHosts.add(host)
    const names = new Set(hosts.map((host) => host.replace(/:\d+$/, '')))
    this.ses.setCertificateVerifyProc((request, callback) => callback(names.has(request.hostname) ? 0 : -3))
  }
}

function fillOf(id: string, origin: string, faviconUrl: string): IconFill {
  const kind = id.startsWith('favorite:') ? 'favorite' : 'tab'
  return { kind, id: id.slice(id.indexOf(':') + 1), origin, faviconUrl }
}
