import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOST_RESOLVER } from '@shared/dns'
import { appliedProxy, SYSTEM_PROXY } from '@shared/proxy'
import { CUT_OFF, OwnSessions, ProxyApplier, applyHostResolver, probeProxy, type Connect, type ProxySession } from './network'

afterEach(() => vi.restoreAllMocks())

const manual = appliedProxy({ mode: 'manual', address: 'socks5://127.0.0.1:1080', bypass: '' })

function session(fail = false) {
  const calls: string[] = []
  const ses: ProxySession = {
    async setProxy(config) {
      calls.push(`set ${JSON.stringify(config)}`)
      if (fail) throw new Error('refusé par Chromium')
    },
    async closeAllConnections() {
      calls.push('close')
    }
  }
  return { ses, calls }
}

describe('ProxyApplier', () => {
  it('puts the proxy on a session and drops the connections that used the old route', async () => {
    const { ses, calls } = session()
    expect(await new ProxyApplier().apply(ses, manual, 'profile work')).toBeNull()
    expect(calls).toEqual([`set ${JSON.stringify(manual)}`, 'close'])
  })

  it('touches nothing for a session that is on the system proxy and stays there (the option off costs nothing)', async () => {
    const { ses, calls } = session()
    const applier = new ProxyApplier()
    expect(await applier.apply(ses, null, 'profile work')).toBeNull()
    expect(await applier.apply(ses, appliedProxy(SYSTEM_PROXY), 'profile work')).toBeNull()
    expect(calls).toEqual([])
  })

  it('does not apply the same proxy twice, and puts the system proxy back after a manual one', async () => {
    const { ses, calls } = session()
    const applier = new ProxyApplier()
    await applier.apply(ses, manual, 'x')
    await applier.apply(ses, manual, 'x')
    expect(calls).toHaveLength(2)
    await applier.apply(ses, null, 'x')
    expect(calls.slice(2)).toEqual([`set ${JSON.stringify({ mode: 'system' })}`, 'close'])
  })

  it('reports a failure instead of taking it for a success, logs it with the session, and tries again at the next change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, calls } = session(true)
    const applier = new ProxyApplier()
    // This session refuses everything: the route, then the cut that would have followed. Both reasons are told.
    expect(await applier.apply(ses, manual, 'profile work')).toBe('refusé par Chromium ; refusé par Chromium')
    expect(error).toHaveBeenCalledWith('[engine] cannot set the proxy of profile work:', expect.any(Error))
    // Not recorded as applied: the same request is tried again.
    await applier.apply(ses, manual, 'profile work')
    expect(calls.filter((c) => c === `set ${JSON.stringify(manual)}`)).toHaveLength(2)
    expect(calls).not.toContain('close')
  })

  /** A session that refuses the routes for which `refuses` says so, and remembers the one it is on. */
  function picky(refuses: (config: { mode: string; proxyRules?: string }) => boolean, closes = true) {
    const state = { route: 'system', calls: [] as string[] }
    const ses: ProxySession = {
      async setProxy(config) {
        state.calls.push(`set ${JSON.stringify(config)}`)
        if (refuses(config)) throw new Error('refusé par Chromium')
        state.route = JSON.stringify(config)
      },
      async closeAllConnections() {
        state.calls.push('close')
        if (!closes) throw new Error('connexions non fermées')
      }
    }
    return { ses, state }
  }

  it('cuts the session off the network when its route is refused: nothing leaves by the route it had before', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const other = { mode: 'fixed_servers' as const, proxyRules: 'http://10.0.0.1:3128' }
    const { ses, state } = picky((config) => config.proxyRules === other.proxyRules)
    const applier = new ProxyApplier()
    expect(await applier.apply(ses, manual, 'profile work')).toBeNull()
    expect(await applier.apply(ses, other, 'profile work')).toBe('refusé par Chromium')
    // Not on the proxy of before, not on the system's route: on a proxy that leads nowhere, and the old connections are dropped.
    expect(state.route).toBe(JSON.stringify(CUT_OFF))
    expect(state.calls.slice(-3)).toEqual([`set ${JSON.stringify(other)}`, `set ${JSON.stringify(CUT_OFF)}`, 'close'])
    expect(CUT_OFF).toEqual({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' })
    // The route of before is not "already applied": asked again, it is set again.
    expect(await applier.apply(ses, manual, 'profile work')).toBeNull()
    expect(state.route).toBe(JSON.stringify(manual))
  })

  it('cuts a session that was never touched, too: it would otherwise stay on the route of the system', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, state } = picky((config) => config.proxyRules === manual.proxyRules)
    const applier = new ProxyApplier()
    expect(await applier.apply(ses, manual, 'profile work')).toBe('refusé par Chromium')
    expect(state.route).toBe(JSON.stringify(CUT_OFF))
    // The option goes off: the system route is set, although a session nobody touched would need nothing.
    expect(await applier.apply(ses, null, 'profile work')).toBeNull()
    expect(state.route).toBe(JSON.stringify({ mode: 'system' }))
  })

  it('gives the network back as soon as the route that was refused can be set', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let refusing = true
    const { ses, state } = picky((config) => refusing && config.proxyRules === manual.proxyRules)
    const applier = new ProxyApplier()
    await applier.apply(ses, manual, 'x')
    refusing = false
    expect(await applier.apply(ses, manual, 'x')).toBeNull()
    expect(state.route).toBe(JSON.stringify(manual))
  })

  it('says both reasons, and logs the session, when the session cannot be cut off either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, state } = picky(() => true)
    const applier = new ProxyApplier()
    expect(await applier.apply(ses, manual, 'profile work')).toBe('refusé par Chromium ; refusé par Chromium')
    expect(state.route).toBe('system')
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/cannot cut profile work off the network.*old route/), expect.any(Error))
  })

  it('leaves a session on the route it was given when only the old connections could not be dropped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, state } = picky(() => false, false)
    const applier = new ProxyApplier()
    expect(await applier.apply(ses, manual, 'profile work')).toBe('connexions non fermées')
    expect(state.route).toBe(JSON.stringify(manual))
    expect(state.calls).toEqual([`set ${JSON.stringify(manual)}`, 'close'])
  })

  it('runs the changes of one session in order, and tells when a session is settled', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const ses: ProxySession = {
      async setProxy(config) {
        order.push(`start ${config.mode}`)
        await gate
        order.push(`end ${config.mode}`)
      },
      async closeAllConnections() {}
    }
    const applier = new ProxyApplier()
    expect(applier.settled(ses)).toBeUndefined()
    const first = applier.apply(ses, manual, 'x')
    const second = applier.apply(ses, { mode: 'direct' }, 'x')
    const waiting = applier.settled(ses)!
    let settled = false
    void waiting.then(() => (settled = true))
    await Promise.resolve()
    expect(order).toEqual(['start fixed_servers'])
    expect(settled).toBe(false)
    release()
    await Promise.all([first, second, waiting])
    expect(order).toEqual(['start fixed_servers', 'end fixed_servers', 'start direct', 'end direct'])
    expect(settled).toBe(true)
  })
})

describe('OwnSessions', () => {
  function own(plan: () => typeof manual | null) {
    const applier = new ProxyApplier()
    return new OwnSessions(applier, plan)
  }

  it('puts a session the shell requests with on the proxy at once, and again at every change of the plan', async () => {
    let wanted: typeof manual | null = manual
    const { ses, calls } = session()
    const sessions = own(() => wanted)
    const follow = sessions.follow(ses, 'the favicon lookups')
    await follow.settled()
    expect(calls).toEqual([`set ${JSON.stringify(manual)}`, 'close'])
    wanted = { mode: 'direct' }
    expect(await Promise.all(sessions.reapply().map(([what, job]) => job.then((failure) => [what, failure])))).toEqual([['the favicon lookups', null]])
    expect(calls.slice(2)).toEqual([`set ${JSON.stringify({ mode: 'direct' })}`, 'close'])
  })

  it('touches nothing while the option is off, and a request can wait for the change under way', async () => {
    const { ses, calls } = session()
    const sessions = own(() => null)
    const follow = sessions.follow(ses, 'the live folders')
    await Promise.all(sessions.reapply().map(([, job]) => job))
    await follow.settled()
    expect(calls).toEqual([])
    const other = session()
    const later = own(() => manual).follow(other.ses, 'x')
    expect(later.settled()).toBeInstanceOf(Promise)
    await later.settled()
    expect(other.calls[0]).toBe(`set ${JSON.stringify(manual)}`)
  })

  it('stops following a session that was released, and reports a failure with the session it concerns', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, calls } = session()
    const sessions = own(() => manual)
    const first = sessions.follow(ses, 'a')
    await first.settled()
    // A second follower of the same session replaces the first: the first one letting go must not drop it.
    const second = sessions.follow(ses, 'b')
    first.release()
    expect(sessions.reapply().map(([what]) => what)).toEqual(['b'])
    second.release()
    expect(sessions.reapply()).toEqual([])
    expect(calls).toHaveLength(2)
    const failing = session(true)
    const jobs = own(() => manual)
    jobs.follow(failing.ses, 'the live folders')
    expect(await jobs.reapply()[0]?.[1]).toBe('refusé par Chromium ; refusé par Chromium')
    expect(error).toHaveBeenCalledWith('[engine] cannot set the proxy of the live folders:', expect.any(Error))
  })
})

describe('applyHostResolver', () => {
  it('passes the settings to Chromium, and the defaults when there are none', () => {
    const configure = vi.fn()
    expect(applyHostResolver(configure, { secureDnsMode: 'secure', secureDnsServers: ['https://dns.example.org/dns-query'] })).toBeNull()
    expect(configure).toHaveBeenLastCalledWith({ secureDnsMode: 'secure', secureDnsServers: ['https://dns.example.org/dns-query'] })
    expect(applyHostResolver(configure, null)).toBeNull()
    expect(configure).toHaveBeenLastCalledWith(DEFAULT_HOST_RESOLVER)
  })

  it('logs a refusal with its context and hands the reason back', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reason = applyHostResolver(() => {
      throw new Error('invalid server template')
    }, { secureDnsMode: 'secure', secureDnsServers: ['x'] })
    expect(reason).toBe('invalid server template')
    expect(error).toHaveBeenCalledWith('[engine] cannot configure encrypted DNS:', expect.any(Error))
  })
})

describe('probeProxy', () => {
  function fakeConnect(behaviour: 'connect' | 'refuse' | 'silent') {
    const opened: Array<{ host: string; port: number }> = []
    const connect: Connect = (options) => {
      opened.push(options)
      const socket = new EventEmitter() as EventEmitter & { destroy: () => void; setTimeout: (ms: number, cb: () => void) => void; destroyed?: boolean }
      socket.destroy = () => {
        socket.destroyed = true
      }
      socket.setTimeout = (_ms, cb) => {
        if (behaviour === 'silent') setTimeout(cb, 0)
      }
      if (behaviour === 'connect') queueMicrotask(() => socket.emit('connect'))
      if (behaviour === 'refuse') queueMicrotask(() => socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))
      return socket as never
    }
    return { connect, opened }
  }

  it('says a server that accepts the connection answers, and connects to the proxy only', async () => {
    const { connect, opened } = fakeConnect('connect')
    let t = 100
    const result = await probeProxy('socks5://[::1]:1080', { connect, now: () => (t += 7) })
    expect(result).toEqual({ ok: true, ms: 7 })
    expect(opened).toEqual([{ host: '::1', port: 1080 }])
  })

  it('says it refused, or did not answer in time', async () => {
    expect(await probeProxy('127.0.0.1:10090', { connect: fakeConnect('refuse').connect })).toEqual({ ok: false, error: 'connexion refusée' })
    expect(await probeProxy('127.0.0.1:10090', { connect: fakeConnect('silent').connect, timeoutMs: 5 })).toEqual({ ok: false, error: 'délai dépassé' })
  })

  it('never knocks on a door a proxy does not live at: unspecified, link-local, multicast, and the well-known ports', async () => {
    const { connect, opened } = fakeConnect('connect')
    for (const address of ['169.254.169.254:80', '0.0.0.0:8080', '224.0.0.1:3128', '255.255.255.255:8080', '[fe80::1]:8080', '[ff02::1]:8080', '[::]:8080', 'proxy.example:22', '127.0.0.1:25', '10.0.0.5:23', 'socks5://127.0.0.1:1023', '[::ffff:a9fe:a9fe]:8080']) {
      expect(await probeProxy(address, { connect }), address).toEqual({ ok: false, error: 'adresse ou port non prévus pour un proxy' })
    }
    expect(opened).toEqual([])
    // Where proxies live: loopback, private networks, names, 80 and 443, and the ports above 1023.
    for (const address of ['127.0.0.1:1080', '192.168.1.10:3128', 'proxy.example:8080', 'proxy.example:80', 'https://proxy.example:443', '[::1]:8118', '10.0.0.1:1024']) {
      expect((await probeProxy(address, { connect, resolve: async () => '192.0.2.10' }) as { ok: boolean }).ok, address).toBe(true)
    }
    expect(opened).toHaveLength(7)
  })

  it('judges a name by the address it stands for, and connects to that address: a name is not a way round the filter', async () => {
    const { connect, opened } = fakeConnect('connect')
    const asked: string[] = []
    const pointingAt = (address: string) => async (host: string) => (asked.push(host), address)
    for (const address of ['169.254.169.254', '0.0.0.0', '224.0.0.1', 'fe80::1', '::ffff:a9fe:a9fe', 'encore-un-nom.example']) {
      expect(await probeProxy('metadata.example:80', { connect, resolve: pointingAt(address) }), address).toEqual({ ok: false, error: 'adresse ou port non prévus pour un proxy' })
    }
    expect(opened).toEqual([])
    expect(asked).toHaveLength(6)
    expect(await probeProxy('proxy.example:3128', { connect, resolve: pointingAt('10.0.0.7') })).toMatchObject({ ok: true })
    expect(await probeProxy('socks5://proxy6.example:1080', { connect, resolve: pointingAt('2001:db8::7') })).toMatchObject({ ok: true })
    expect(opened).toEqual([{ host: '10.0.0.7', port: 3128 }, { host: '2001:db8::7', port: 1080 }])
    // An address typed in figures is asked of no name server.
    asked.length = 0
    await probeProxy('127.0.0.1:1080', { connect, resolve: pointingAt('169.254.169.254') })
    expect(asked).toEqual([])
  })

  it('says so when the name cannot be resolved or the name server does not answer, writes it in the log, and lets the next test in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { connect, opened } = fakeConnect('connect')
    const unknown = async () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND absent.example'), { code: 'ENOTFOUND' }))
    expect(await probeProxy('absent.example:8080', { connect, resolve: unknown })).toEqual({ ok: false, error: 'nom d’hôte introuvable' })
    expect(await probeProxy('lent.example:8080', { connect, resolve: () => new Promise(() => {}), timeoutMs: 5 })).toEqual({ ok: false, error: 'délai dépassé' })
    expect(await probeProxy('casse.example:8080', { connect, resolve: async () => Promise.reject(new Error('EAI_FAIL')) })).toEqual({ ok: false, error: 'EAI_FAIL' })
    expect(opened).toEqual([])
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('absent.example'), expect.stringContaining('ENOTFOUND'))
    expect(await probeProxy('127.0.0.1:1080', { connect })).toMatchObject({ ok: true })
    warn.mockRestore()
  })

  it('runs one test at a time, and lets the next one in once the first is over, even when it could not open the connection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let release!: () => void
    const held: Connect = () => {
      const socket = new EventEmitter() as EventEmitter & { destroy: () => void; setTimeout: (ms: number, cb: () => void) => void }
      socket.destroy = () => {}
      socket.setTimeout = (_ms, cb) => void (release = cb)
      return socket as never
    }
    const first = probeProxy('127.0.0.1:1080', { connect: held })
    expect(await probeProxy('127.0.0.1:1081', { connect: held })).toEqual({ ok: false, error: 'un test est déjà en cours' })
    release()
    expect(await first).toEqual({ ok: false, error: 'délai dépassé' })
    const throwing: Connect = () => {
      throw new Error('EMFILE')
    }
    expect(await probeProxy('127.0.0.1:1080', { connect: throwing })).toEqual({ ok: false, error: 'EMFILE' })
    expect(error).toHaveBeenCalledWith('[network] cannot open the connection of the proxy test:', expect.any(Error))
    const { connect } = fakeConnect('connect')
    expect((await probeProxy('127.0.0.1:1080', { connect }) as { ok: boolean }).ok).toBe(true)
  })

  it('never connects for an address that is not a proxy address', async () => {
    const { connect, opened } = fakeConnect('connect')
    expect(await probeProxy('http://user:secret@proxy.example:80', { connect })).toEqual({ ok: false, error: 'adresse non valide' })
    expect(await probeProxy('', { connect })).toEqual({ ok: false, error: 'adresse non valide' })
    expect(opened).toEqual([])
  })
})
