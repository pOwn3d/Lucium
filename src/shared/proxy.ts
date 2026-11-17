// HTTP / SOCKS proxy, global or per profile. Pure rules: what an address may be, what a saved setting may hold, and what the engine is
// asked to apply to each session (`session.setProxy`, see engine/electron-engine.ts). While `proxyEnabled` is off nothing is
// configured: the system's proxy settings stand. A proxy address never carries a login: a proxy that asks for one gets the
// sign-in prompt of the window (the `login` event, see http-auth.ts), and what is typed there is not kept anywhere.

import type { Settings } from './model'
import { parseSiteHost } from './site-data'
import { t } from './i18n'

/** System: the proxy of macOS. Direct: no proxy at all (whatever the system says). Manual: the server below. */
export const PROXY_MODES = ['system', 'direct', 'manual'] as const
export type ProxyMode = (typeof PROXY_MODES)[number]

export const PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5'] as const
export type ProxyScheme = (typeof PROXY_SCHEMES)[number]

export const PROXY_MODE_LABELS: Record<ProxyMode, string> = {
  get system() { return t('proxy.proxy-du-systeme') },
  get direct() { return t('proxy.aucun-proxy') },
  get manual() { return t('proxy.proxy-manuel') }
}

export interface ProxySetting {
  mode: ProxyMode
  /** With the manual mode: `scheme://host:port`, as `parseProxyAddress` writes it. Empty otherwise. */
  address: string
  /** Hosts that go direct, comma separated (Chromium's bypass rules: `*.exemple.org`, `192.168.0.0/16`). `<local>` is always added. */
  bypass: string
}

export const SYSTEM_PROXY: ProxySetting = { mode: 'system', address: '', bypass: '' }

export interface ProxyAddress {
  scheme: ProxyScheme
  host: string
  port: number
  /** `scheme://host:port`. */
  address: string
}

export const PROXY_ADDRESS_MAX = 300

/**
 * A proxy address as it may be typed: `[scheme://]host:port`, the scheme being http (the default), https, socks4 or socks5, the host a
 * name, an IPv4 address or an IPv6 address in brackets. A login (`user:pass@`), a path, a query, a space or a missing port is refused:
 * the answer is null and nothing is stored.
 */
export function parseProxyAddress(input: unknown): ProxyAddress | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text === '' || text.length > PROXY_ADDRESS_MAX) return null
  // A scheme, an authority and at most one closing slash: a path is not part of a proxy address. The authority is then held to the strict host
  // rules of parseSiteHost, which refuse a login (`user:pass@`), a query, a space and any control character.
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]+)\/?$/i.exec(text)
  if (!match) return null
  const scheme = (match[1] ?? 'http').toLowerCase()
  if (!(PROXY_SCHEMES as readonly string[]).includes(scheme)) return null
  const site = parseSiteHost(match[2])
  if (!site || site.port === null) return null
  return { scheme: scheme as ProxyScheme, host: site.hostname, port: site.port, address: `${scheme}://${site.host}` }
}

/**
 * Whether the address of a proxy is one the connection test may knock on. The test is a TCP connection from the application to an address the
 * interface hands over: it must not be a way to try any door. Unspecified, broadcast, multicast, reserved and link-local addresses are out
 * (the metadata service of a cloud machine lives at 169.254.169.254), and so are the well-known ports below 1024 other than 80 and 443,
 * where a service that is not a proxy listens (SSH, SMTP…). Loopback, private networks and names stay: that is where proxies are.
 */
export function isTestableProxy(address: Pick<ProxyAddress, 'host' | 'port'>): boolean {
  if (!(address.port === 80 || address.port === 443 || address.port >= 1024)) return false
  const host = address.host.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) {
    const [first, second] = [Number(v4[1]), Number(v4[2])]
    return !(first === 0 || first >= 224 || (first === 169 && second === 254))
  }
  if (host.includes(':')) return !(host === '::' || host.startsWith('::ffff:') || /^fe[89ab]/.test(host) || host.startsWith('ff'))
  return true
}

export const PROXY_BYPASS_MAX = 600
const BYPASS_RULES_MAX = 30
const BYPASS_RULE = /^[A-Za-z0-9.*:/\-_[\]]{1,100}$/

/** The rules of a bypass list that are acceptable, comma separated: letters, digits and `. * : / - _ [ ]` only, so no rule can carry another instruction. */
export function cleanBypass(input: unknown): string {
  if (typeof input !== 'string' || input.length > PROXY_BYPASS_MAX * 4) return ''
  const rules = input
    .split(/[\s,;]+/)
    .filter((rule) => BYPASS_RULE.test(rule))
    .slice(0, BYPASS_RULES_MAX)
  return [...new Set(rules)].join(',').slice(0, PROXY_BYPASS_MAX)
}

const isMode = (value: unknown): value is ProxyMode => (PROXY_MODES as readonly unknown[]).includes(value)

/**
 * A saved proxy setting, repaired. A manual proxy whose address is not usable falls back to the system's: a damaged file never sends
 * the traffic anywhere the user did not choose.
 */
export function cleanProxySetting(raw: unknown): ProxySetting {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...SYSTEM_PROXY }
  const value = raw as Record<string, unknown>
  const mode = isMode(value['mode']) ? value['mode'] : 'system'
  const parsed = parseProxyAddress(value['address'])
  if (mode === 'manual' && !parsed) return { ...SYSTEM_PROXY }
  return { mode, address: mode === 'manual' && parsed ? parsed.address : '', bypass: mode === 'manual' ? cleanBypass(value['bypass']) : '' }
}

/** What `session.setProxy` takes (the fields of Electron's ProxyConfig that are used). */
export interface AppliedProxy {
  mode: 'system' | 'direct' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

export const SYSTEM_APPLIED: AppliedProxy = { mode: 'system' }

export function appliedProxy(setting: ProxySetting): AppliedProxy {
  const clean = cleanProxySetting(setting)
  if (clean.mode === 'direct') return { mode: 'direct' }
  if (clean.mode === 'system') return SYSTEM_APPLIED
  return { mode: 'fixed_servers', proxyRules: clean.address, proxyBypassRules: ['<local>', ...(clean.bypass === '' ? [] : clean.bypass.split(','))].join(',') }
}

/** The proxy a profile uses: its own when it has one, else the global one. */
export function proxyOfProfile(settings: Pick<Settings, 'proxy' | 'profiles'>, profileId: string): ProxySetting {
  return settings.profiles[profileId]?.proxy ?? settings.proxy
}

export interface ProxyPlan {
  /** For the profiles that have none of their own, the private context of a window and the application itself. */
  global: AppliedProxy
  /** The profiles that have a proxy of their own. */
  profiles: Record<string, AppliedProxy>
}

/** What the engine applies for these settings; null while the option is off (nothing is configured then). */
export function planProxies(settings: Pick<Settings, 'proxyEnabled' | 'proxy' | 'profiles'>): ProxyPlan | null {
  if (settings.proxyEnabled !== true) return null
  const profiles: Record<string, AppliedProxy> = {}
  for (const [id, own] of Object.entries(settings.profiles)) if (own.proxy) profiles[id] = appliedProxy(own.proxy)
  return { global: appliedProxy(settings.proxy), profiles }
}

/** The applied proxy of one session of the plan: a profile's own, else the global one. */
export function appliedFor(plan: ProxyPlan, profileId: string | null): AppliedProxy {
  return (profileId !== null && Object.hasOwn(plan.profiles, profileId) ? plan.profiles[profileId] : undefined) ?? plan.global
}

/** A short wording of a setting for the settings window. */
export function describeProxy(setting: ProxySetting): string {
  const clean = cleanProxySetting(setting)
  return clean.mode === 'manual' ? clean.address : PROXY_MODE_LABELS[clean.mode]
}

export const PROXY_TEST_TIMEOUT_MS = 4000

/** The answer of the facultative test: the proxy server accepted a connection (it does not prove it forwards, nor that its login works). */
export type ProxyTestResult = { ok: true; ms: number } | { ok: false; error: string }

export function describeProxyTest(result: ProxyTestResult): string {
  return result.ok ? t('proxy.le-serveur-repond-ms-ms', { ms: result.ms }) : t('proxy.le-serveur-ne-repond-pas-error', { error: result.error })
}
