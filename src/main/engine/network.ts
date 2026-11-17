// The network settings the engine applies to its sessions: the proxy of each one, and the process-wide encrypted DNS. Typed against the few
// methods of Electron they use, so that the rules (one change at a time per session, a failure reported and never taken for a success,
// nothing sent before the proxy is set) are testable without Electron.

import { lookup } from 'node:dns/promises'
import { connect, isIP, type Socket } from 'node:net'
import { DEFAULT_HOST_RESOLVER, type HostResolverConfig } from '@shared/dns'
import { t } from '@shared/i18n'
import { PROXY_TEST_TIMEOUT_MS, SYSTEM_APPLIED, isTestableProxy, parseProxyAddress, type AppliedProxy, type ProxyTestResult } from '@shared/proxy'

/** The part of an Electron `Session` the proxy needs. */
export interface ProxySession {
  setProxy(config: AppliedProxy): Promise<void>
  closeAllConnections(): Promise<void>
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * What a session is put on when the route asked for it was refused: a proxy on this machine's discard port, where nothing listens. Chromium
 * never falls back to a direct connection from a fixed proxy, so every request of the session fails (the page says the proxy cannot be
 * reached) instead of leaving by the route the session had before.
 */
export const CUT_OFF: AppliedProxy = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' }
/** What `applied` holds for a session that was cut off: no request for a route equals it, so the next one is always tried. */
const CUT_OFF_KEY = 'cut off'

/**
 * Sets the proxy of sessions. A session nobody touched is on the system's proxy, so putting that back on such a session is a no-op:
 * with the option off, nothing is ever called. A session's changes run one after the other, and a page created meanwhile waits for them
 * (`settled`) before it navigates. A route that cannot be set leaves the session without network (`CUT_OFF`) until the next change of the
 * settings: no request leaves by a route the user did not choose.
 */
export class ProxyApplier {
  private readonly applied = new WeakMap<object, string>()
  private readonly running = new WeakMap<object, Promise<void>>()

  /**
   * Resolves to null once the session uses `wanted` (null = the system's proxy), or to the reason it could not be set. Never rejects: the
   * caller reports the text, and the failure is logged here with the session it concerns. After a failure the session is cut off the
   * network, and the same request is tried again the next time it is made.
   */
  apply(ses: ProxySession, wanted: AppliedProxy | null, what: string): Promise<string | null> {
    const config = wanted ?? SYSTEM_APPLIED
    const key = JSON.stringify(config)
    let outcome: string | null = null
    const previous = this.running.get(ses) ?? Promise.resolve()
    const next = previous.then(async () => {
      if ((this.applied.get(ses) ?? JSON.stringify(SYSTEM_APPLIED)) === key) return
      try {
        await ses.setProxy(config)
        this.applied.set(ses, key)
        // A connection kept alive from before would go on using the old route.
        await ses.closeAllConnections()
      } catch (error) {
        outcome = errorText(error)
        console.error(`[engine] cannot set the proxy of ${what}:`, error)
        // The route was set and only the old connections could not be dropped: the session is on the route asked, and stays there.
        if (this.applied.get(ses) === key) return
        const uncut = await this.cutOff(ses, what)
        if (uncut !== null) outcome = `${outcome} ; ${uncut}`
      }
    })
    this.running.set(ses, next)
    return next.then(() => outcome)
  }

  /** Leaves the session without network. Answers null, or the reason it could not be done (logged with the session): it may then still use its old route. */
  private async cutOff(ses: ProxySession, what: string): Promise<string | null> {
    try {
      await ses.setProxy(CUT_OFF)
      this.applied.set(ses, CUT_OFF_KEY)
      await ses.closeAllConnections()
      return null
    } catch (error) {
      console.error(`[engine] cannot cut ${what} off the network after its proxy was refused; it may still use its old route:`, error)
      return errorText(error)
    }
  }

  /** The changes of this session still under way, or undefined when it is settled. */
  settled(ses: object): Promise<void> | undefined {
    const running = this.running.get(ses)
    if (!running) return undefined
    const mark = running.then(() => undefined)
    return mark
  }
}

/** What `OwnSessions.follow` gives back to the service that asked. */
export interface ProxyFollow {
  /** The change of the session still under way, or undefined when it is settled: a request waits for it, as a page does. */
  settled(): Promise<void> | undefined
  /** Stops following: the session is no longer touched at the next change of the plan. */
  release(): void
}

/**
 * The sessions the shell makes requests with on its own (favicon lookups, live folders). They follow the global proxy of the plan, like the
 * application's own session: left alone they would reach the sites by the system's route while the user chose another.
 */
export class OwnSessions {
  private readonly followed = new Map<ProxySession, { what: string; token: object }>()

  constructor(
    private readonly applier: ProxyApplier,
    /** The global proxy of the plan now: null while the option is off. */
    private readonly global: () => AppliedProxy | null
  ) {}

  /** Puts the session on the proxy now (nothing at all while the option is off) and keeps it there at every change of the plan. */
  follow(ses: ProxySession, what: string): ProxyFollow {
    const token = {}
    this.followed.set(ses, { what, token })
    void this.applier.apply(ses, this.global(), what)
    return {
      settled: () => this.applier.settled(ses),
      release: () => {
        if (this.followed.get(ses)?.token === token) this.followed.delete(ses)
      }
    }
  }

  /** The jobs of a change of the plan (call it once the new plan is recorded). */
  reapply(): Array<[string, Promise<string | null>]> {
    return [...this.followed].map(([ses, { what }]) => [what, this.applier.apply(ses, this.global(), what)])
  }
}

/** The part of Electron's `app` the encrypted DNS needs. */
export type ConfigureHostResolver = (options: HostResolverConfig) => void

/** Applies the encrypted-DNS settings (null puts Chromium's defaults back). Answers null, or the reason it failed (after logging it). */
export function applyHostResolver(configure: ConfigureHostResolver, config: HostResolverConfig | null): string | null {
  try {
    configure(config ?? DEFAULT_HOST_RESOLVER)
    return null
  } catch (error) {
    console.error('[engine] cannot configure encrypted DNS:', error)
    return errorText(error)
  }
}

/** What `probeProxy` needs of the network: `net.connect`'s shape. */
export type Connect = (options: { host: string; port: number }) => Pick<Socket, 'once' | 'destroy' | 'setTimeout'>

/** The address a host name stands for, as the system resolves it. */
export type ResolveHost = (host: string) => Promise<string>

const systemResolve: ResolveHost = async (host) => (await lookup(host)).address

let probing = false

/**
 * The facultative test of a proxy: does its server accept a connection? It reaches only the proxy itself, never a third party, and sends
 * nothing: it does not prove the proxy forwards, nor that a login would be accepted.
 * A name is resolved first, and the address it stands for passes the same filter as one typed in figures: a name can point anywhere (the
 * metadata service of a cloud machine, at 169.254.169.254). The connection then goes to that very address, not to the name again.
 */
export async function probeProxy(address: string, options: { timeoutMs?: number; connect?: Connect; now?: () => number; resolve?: ResolveHost } = {}): Promise<ProxyTestResult> {
  const parsed = parseProxyAddress(address)
  if (!parsed) return { ok: false, error: t('network.adresse-non-valide') }
  if (!isTestableProxy(parsed)) return { ok: false, error: t('network.adresse-ou-port-non-prevus-pour-un-proxy') }
  // One test at a time: a surface that asks again and again is not testing a proxy, it is scanning.
  if (probing) return { ok: false, error: t('network.un-test-est-deja-en-cours') }
  probing = true
  const { timeoutMs = PROXY_TEST_TIMEOUT_MS, connect: open = connect as unknown as Connect, now = Date.now, resolve: resolveHost = systemResolve } = options
  const started = now()
  let host = parsed.host.replace(/^\[|\]$/g, '')
  if (isIP(host) === 0) {
    let late: ReturnType<typeof setTimeout> | undefined
    try {
      // The resolution gets the time of the test and no more: a name server that does not answer must not hold the one test allowed.
      const timeout = new Promise<never>((_resolve, reject) => {
        late = setTimeout(() => reject(new Error(t('network.delai-depasse'))), timeoutMs)
      })
      host = await Promise.race([resolveHost(host), timeout])
    } catch (error) {
      probing = false
      console.warn(`[network] the name of the proxy to test could not be resolved (${parsed.host}):`, errorText(error))
      return { ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOTFOUND' ? t('network.nom-d-hote-introuvable') : errorText(error) }
    } finally {
      clearTimeout(late)
    }
    if (isIP(host) === 0 || !isTestableProxy({ host, port: parsed.port })) {
      probing = false
      return { ok: false, error: t('network.adresse-ou-port-non-prevus-pour-un-proxy') }
    }
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (result: ProxyTestResult) => {
      if (done) return
      done = true
      probing = false
      socket?.destroy()
      resolve(result)
    }
    let socket: ReturnType<Connect> | undefined
    try {
      socket = open({ host, port: parsed.port })
    } catch (error) {
      console.error('[network] cannot open the connection of the proxy test:', error)
      return finish({ ok: false, error: errorText(error) })
    }
    socket.once('connect', () => finish({ ok: true, ms: Math.max(0, now() - started) }))
    socket.once('error', (error: Error) => finish({ ok: false, error: (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? t('network.connexion-refusee') : error.message }))
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: t('network.delai-depasse') }))
  })
}
