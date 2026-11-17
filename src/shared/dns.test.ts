import { describe, expect, it } from 'vitest'
import { DOH_PROVIDERS, DOH_TEMPLATE_MAX, secureWithoutServer, cleanDohSettings, dohServerOf, parseDohTemplate, planHostResolver, type DohSettings } from './dns'
import { defaultSettings } from './model'

const base: DohSettings = { dohCustom: true, dohMode: 'automatic', dohProvider: 'system', dohCustomUrl: '' }

describe('the address of a DNS-over-HTTPS server', () => {
  it('accepts an https address, with or without the RFC 8484 variable', () => {
    expect(parseDohTemplate('https://dns.example.org/dns-query')).toBe('https://dns.example.org/dns-query')
    expect(parseDohTemplate('  https://dns.example.org/dns-query{?dns} ')).toBe('https://dns.example.org/dns-query{?dns}')
    expect(parseDohTemplate('https://1.1.1.1/dns-query')).toBe('https://1.1.1.1/dns-query')
  })

  it.each([
    ['plain http: the network could read and change the answers', 'http://dns.example.org/dns-query'],
    ['a login in the address', 'https://user:pass@dns.example.org/dns-query'],
    ['a fragment', 'https://dns.example.org/dns-query#x'],
    ['a query string', 'https://dns.example.org/dns-query?dns=abc'],
    ['another scheme', 'tls://dns.example.org'],
    ['a space', 'https://dns.example.org/dns query'],
    ['another template variable', 'https://dns.example.org/{host}'],
    ['not an address', 'dns.example.org'],
    ['empty', ''],
    ['too long', `https://dns.example.org/${'a'.repeat(DOH_TEMPLATE_MAX)}`]
  ])('refuses %s', (_why, input) => {
    expect(parseDohTemplate(input)).toBeNull()
  })

  it('refuses what is not text', () => {
    expect(parseDohTemplate(42)).toBeNull()
    expect(parseDohTemplate(null)).toBeNull()
  })

  it('lists only https servers, each once', () => {
    for (const provider of DOH_PROVIDERS) expect(parseDohTemplate(provider.template)).toBe(provider.template)
    expect(new Set(DOH_PROVIDERS.map((p) => p.id)).size).toBe(DOH_PROVIDERS.length)
  })
})

describe('the settings', () => {
  it('start where Chromium is: nothing set, automatic, no server', () => {
    const settings = defaultSettings()
    expect(settings.dohCustom).toBe(false)
    expect(settings.dohMode).toBe('automatic')
    expect(settings.dohProvider).toBe('system')
    expect(planHostResolver(settings)).toEqual({ kind: 'default' })
  })

  it('repair a damaged file: only a real true switches it on, an unknown mode or provider goes back, a bad address is dropped', () => {
    expect(cleanDohSettings({ dohCustom: 'yes', dohMode: 'turbo', dohProvider: 'nobody', dohCustomUrl: 'http://x.example/' })).toEqual({ dohCustom: false, dohMode: 'automatic', dohProvider: 'system', dohCustomUrl: '' })
    expect(cleanDohSettings({ dohCustom: true, dohMode: 'secure', dohProvider: 'quad9', dohCustomUrl: 'https://dns.example.org/dns-query' })).toEqual({ dohCustom: true, dohMode: 'secure', dohProvider: 'quad9', dohCustomUrl: 'https://dns.example.org/dns-query' })
  })
})

describe('what the engine is asked to do', () => {
  it('nothing while the option is off, whatever the other settings say', () => {
    expect(planHostResolver({ ...base, dohCustom: false, dohMode: 'secure', dohProvider: 'quad9' })).toEqual({ kind: 'default' })
  })

  it('off: no encrypted lookup and no server', () => {
    expect(planHostResolver({ ...base, dohMode: 'off', dohProvider: 'quad9' })).toEqual({ kind: 'configure', config: { secureDnsMode: 'off', secureDnsServers: [] } })
  })

  it('automatic: the chosen server is a hint, none leaves Chromium to the network provider', () => {
    expect(planHostResolver(base)).toEqual({ kind: 'configure', config: { secureDnsMode: 'automatic', secureDnsServers: [] } })
    expect(planHostResolver({ ...base, dohProvider: 'cloudflare' })).toEqual({ kind: 'configure', config: { secureDnsMode: 'automatic', secureDnsServers: ['https://cloudflare-dns.com/dns-query'] } })
  })

  it('secure: needs a server, from the list or typed', () => {
    expect(planHostResolver({ ...base, dohMode: 'secure', dohProvider: 'google' })).toEqual({ kind: 'configure', config: { secureDnsMode: 'secure', secureDnsServers: ['https://dns.google/dns-query'] } })
    expect(planHostResolver({ ...base, dohMode: 'secure', dohProvider: 'custom', dohCustomUrl: 'https://dns.example.org/dns-query' })).toEqual({ kind: 'configure', config: { secureDnsMode: 'secure', secureDnsServers: ['https://dns.example.org/dns-query'] } })
  })

  it('secure without a usable server is refused, never applied: every site would stop opening', () => {
    expect(planHostResolver({ ...base, dohMode: 'secure' })).toEqual({ kind: 'refused', reason: secureWithoutServer() })
    expect(planHostResolver({ ...base, dohMode: 'secure', dohProvider: 'custom', dohCustomUrl: '' })).toEqual({ kind: 'refused', reason: secureWithoutServer() })
    expect(dohServerOf({ ...base, dohProvider: 'custom', dohCustomUrl: 'http://insecure.example/' })).toBeNull()
  })
})
