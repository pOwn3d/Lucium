import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { cleanProfileOverrides } from './profiles'
import { PROXY_BYPASS_MAX, SYSTEM_PROXY, appliedFor, appliedProxy, cleanBypass, cleanProxySetting, describeProxy, describeProxyTest, parseProxyAddress, planProxies, proxyOfProfile } from './proxy'
import { normalize } from './sidebar'
import type { SidebarState } from './model'
import { frenchSpaces } from './french-typography'

describe('a proxy address', () => {
  it('reads host:port as an HTTP proxy, and the four schemes', () => {
    expect(parseProxyAddress('127.0.0.1:8080')).toMatchObject({ scheme: 'http', host: '127.0.0.1', port: 8080, address: 'http://127.0.0.1:8080' })
    expect(parseProxyAddress('socks5://proxy.example.org:1080/')?.address).toBe('socks5://proxy.example.org:1080')
    expect(parseProxyAddress('SOCKS4://10.0.0.2:9050')?.address).toBe('socks4://10.0.0.2:9050')
    expect(parseProxyAddress('https://secure-proxy.example.org:443')?.address).toBe('https://secure-proxy.example.org:443')
    expect(parseProxyAddress('socks5://[::1]:1080')?.address).toBe('socks5://[::1]:1080')
  })

  it.each([
    ['a login in the address: it would end up in the saved state', 'http://user:secret@proxy.example.org:8080'],
    ['a login without scheme', 'user:secret@proxy.example.org:8080'],
    ['no port', 'proxy.example.org'],
    ['a port out of range', 'proxy.example.org:70000'],
    ['a scheme that is not a proxy one', 'ftp://proxy.example.org:21'],
    ['a path', 'http://proxy.example.org:8080/pac.js'],
    ['a query', 'http://proxy.example.org:8080?x=1'],
    ['a space', 'proxy.example.org :8080'],
    ['a control character', 'proxy.example.org:8080\u0007'],
    ['empty', ''],
    ['not a host', 'not a host:80']
  ])('refuses %s', (_why, input) => {
    expect(parseProxyAddress(input)).toBeNull()
  })

  it('refuses what is not text and what is too long', () => {
    expect(parseProxyAddress(8080)).toBeNull()
    expect(parseProxyAddress(`http://${'a'.repeat(300)}.example.org:80`)).toBeNull()
  })
})

describe('a saved proxy setting', () => {
  it('is the system proxy by default and for anything unreadable', () => {
    expect(defaultSettings().proxyEnabled).toBe(false)
    expect(defaultSettings().proxy).toEqual(SYSTEM_PROXY)
    for (const bad of [null, 3, 'x', [], {}, { mode: 'turbo' }]) expect(cleanProxySetting(bad)).toEqual(SYSTEM_PROXY)
  })

  it('falls back to the system proxy when a manual one has no usable address: a damaged file never sends traffic anywhere unchosen', () => {
    expect(cleanProxySetting({ mode: 'manual', address: '' })).toEqual(SYSTEM_PROXY)
    expect(cleanProxySetting({ mode: 'manual', address: 'http://u:p@evil.example:80' })).toEqual(SYSTEM_PROXY)
    expect(cleanProxySetting({ mode: 'manual', address: 'proxy.example.org:3128', bypass: '*.exemple.org, 192.168.0.0/16' })).toEqual({ mode: 'manual', address: 'http://proxy.example.org:3128', bypass: '*.exemple.org,192.168.0.0/16' })
  })

  it('keeps no address under another mode, and never a login', () => {
    expect(cleanProxySetting({ mode: 'direct', address: 'http://p.example:80', bypass: 'x.example' })).toEqual({ mode: 'direct', address: '', bypass: '' })
    const state = normalize({ settings: { proxyEnabled: true, proxy: { mode: 'manual', address: 'http://user:hunter2@p.example:80' } } } as unknown as SidebarState)
    expect(JSON.stringify(state)).not.toContain('hunter2')
    expect(state.settings.proxy).toEqual(SYSTEM_PROXY)
  })

  it('keeps only bypass rules that are plain host patterns', () => {
    expect(cleanBypass('a.example.org; b.example.org  *.c.example, <local>, $(x), `y`, ok.example')).toBe('a.example.org,b.example.org,*.c.example,ok.example')
    expect(cleanBypass('x'.repeat(PROXY_BYPASS_MAX * 5))).toBe('')
    expect(cleanBypass(12)).toBe('')
  })

  it('is described in a few words', () => {
    expect(describeProxy(SYSTEM_PROXY)).toBe('Proxy du système')
    expect(describeProxy({ mode: 'direct', address: '', bypass: '' })).toBe('Aucun proxy')
    expect(describeProxy({ mode: 'manual', address: 'socks5://127.0.0.1:1080', bypass: '' })).toBe('socks5://127.0.0.1:1080')
  })
})

describe('what the engine applies', () => {
  const manual = { mode: 'manual' as const, address: 'socks5://127.0.0.1:1080', bypass: '*.local.example' }

  it('system and direct are plain, manual is a fixed server with the local names bypassed', () => {
    expect(appliedProxy(SYSTEM_PROXY)).toEqual({ mode: 'system' })
    expect(appliedProxy({ mode: 'direct', address: '', bypass: '' })).toEqual({ mode: 'direct' })
    expect(appliedProxy(manual)).toEqual({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080', proxyBypassRules: '<local>,*.local.example' })
    expect(appliedProxy({ ...manual, bypass: '' }).proxyBypassRules).toBe('<local>')
  })

  it('nothing is planned while the option is off, whatever the proxy says', () => {
    expect(planProxies({ ...defaultSettings(), proxyEnabled: false, proxy: manual })).toBeNull()
  })

  it('a profile has its own proxy or the global one', () => {
    const settings = { ...defaultSettings(), proxyEnabled: true, proxy: manual, profiles: cleanProfileOverrides({ work: { proxy: { mode: 'direct' } }, calm: { proxy: { mode: 'system' } }, plain: { historyOff: true } }) }
    const plan = planProxies(settings)!
    expect(plan.global.proxyRules).toBe('socks5://127.0.0.1:1080')
    expect(appliedFor(plan, 'work')).toEqual({ mode: 'direct' })
    expect(appliedFor(plan, 'calm')).toEqual({ mode: 'system' })
    expect(appliedFor(plan, 'plain')).toEqual(plan.global)
    expect(appliedFor(plan, 'default')).toEqual(plan.global)
    expect(appliedFor(plan, null)).toEqual(plan.global)
    expect(appliedFor(plan, '__proto__')).toEqual(plan.global)
    expect(proxyOfProfile(settings, 'work').mode).toBe('direct')
    expect(proxyOfProfile(settings, 'plain')).toEqual(manual)
  })

  it('a profile override with a login in its address is dropped by the cleaner', () => {
    expect(cleanProfileOverrides({ work: { proxy: { mode: 'manual', address: 'http://a:b@p.example:80' } } })).toEqual({ work: { proxy: SYSTEM_PROXY } })
  })
})

describe('the test of a proxy', () => {
  it('words both answers', () => {
    expect(describeProxyTest({ ok: true, ms: 12 })).toBe(frenchSpaces('Le serveur répond (12 ms).'))
    expect(describeProxyTest({ ok: false, error: 'connexion refusée' })).toBe(frenchSpaces('Le serveur ne répond pas : connexion refusée'))
  })
})
