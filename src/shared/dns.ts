// Encrypted DNS (DNS over HTTPS), set by the user. Pure rules: what the settings may hold, which servers the list offers, and what the
// engine is asked to configure (`app.configureHostResolver`, see engine/electron-engine.ts). While `dohCustom` is off nothing is
// configured at all: Chromium's own behaviour stands.

/** Automatic: encrypted when the network's DNS provider supports it, else the usual lookup. Secure: encrypted only. Off: never encrypted. */
import { t } from './i18n'

export const DOH_MODES = ['automatic', 'secure', 'off'] as const
export type DohMode = (typeof DOH_MODES)[number]

export const DOH_MODE_LABELS: Record<DohMode, string> = {
  get automatic() { return t('menu.automatique') },
  get secure() { return t('site-panel.active') },
  get off() { return t('menu.desactive') }
}

export const DOH_MODE_HINTS: Record<DohMode, string> = {
  get automatic() { return t('dns.le-moteur-chiffre-la-resolution') },
  get secure() { return t('dns.seules-les-requetes-chiffrees-sont-faites') },
  get off() { return t('dns.le-dns-n-est-jamais-chiffre') }
}

export interface DohProvider {
  id: string
  name: string
  /** The RFC 8484 template (`https://…/dns-query`). Every request the provider answers carries the domain names you visit. */
  template: string
}

/**
 * The fixed list of servers on offer. Each is the public address its operator documents; none is contacted unless the user chooses it
 * here. Add to this list only with the operator's own documentation at hand.
 */
export const DOH_PROVIDERS: readonly DohProvider[] = [
  { id: 'cloudflare', name: 'Cloudflare (1.1.1.1)', template: 'https://cloudflare-dns.com/dns-query' },
  { id: 'google', name: 'Google Public DNS', template: 'https://dns.google/dns-query' },
  { id: 'quad9', name: 'Quad9', template: 'https://dns.quad9.net/dns-query' },
  { id: 'mullvad', name: 'Mullvad', template: 'https://dns.mullvad.net/dns-query' },
  { id: 'opendns', name: 'OpenDNS', template: 'https://doh.opendns.com/dns-query' }
]

/** No server of our own: the network's provider (automatic mode only). */
export const DOH_SYSTEM = 'system'
/** The address the user typed (`dohCustomUrl`). */
export const DOH_CUSTOM = 'custom'

export const DOH_TEMPLATE_MAX = 512

/**
 * A DNS-over-HTTPS server address as the user may type it: `https://` only (an unencrypted address would defeat the purpose and let the
 * network read or change the answers), no login in it, no fragment, no space or control character, and a host. RFC 8484's `{?dns}` suffix
 * is accepted and kept. Returns the address as it will be passed to Chromium, or null.
 */
export function parseDohTemplate(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text === '' || text.length > DOH_TEMPLATE_MAX || /[\s\p{Cc}]/u.test(text)) return null
  const variable = text.endsWith('{?dns}') ? '{?dns}' : ''
  const address = variable ? text.slice(0, -variable.length) : text
  // No other brace: the only template variable of RFC 8484 is `dns`.
  if (/[{}]/.test(address) || !URL.canParse(address)) return null
  const url = new URL(address)
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') return null
  return `${url.href}${variable}`
}

export interface DohSettings {
  dohCustom: boolean
  dohMode: DohMode
  dohProvider: string
  dohCustomUrl: string
}

const isMode = (value: unknown): value is DohMode => (DOH_MODES as readonly unknown[]).includes(value)

/** The encrypted-DNS settings of a saved file: anything unusable goes back to what Chromium does by itself. */
export function cleanDohSettings(settings: Partial<Record<keyof DohSettings, unknown>>): DohSettings {
  const customUrl = parseDohTemplate(settings.dohCustomUrl) ?? ''
  const provider = settings.dohProvider
  const known = typeof provider === 'string' && (provider === DOH_SYSTEM || provider === DOH_CUSTOM || DOH_PROVIDERS.some((p) => p.id === provider))
  return {
    dohCustom: settings.dohCustom === true,
    dohMode: isMode(settings.dohMode) ? settings.dohMode : 'automatic',
    dohProvider: known ? provider : DOH_SYSTEM,
    dohCustomUrl: customUrl
  }
}

/** What `app.configureHostResolver` takes. */
export interface HostResolverConfig {
  secureDnsMode: DohMode
  secureDnsServers: string[]
}

export type HostResolverPlan =
  /** Nothing to configure: the user did not ask. */
  | { kind: 'default' }
  | { kind: 'configure'; config: HostResolverConfig }
  /** The settings cannot be applied (secure mode without a usable server): nothing is changed, and the settings window says why. */
  | { kind: 'refused'; reason: string }

/** The server the settings choose, as a template: a listed provider, the typed address, or none. */
export function dohServerOf(settings: DohSettings): string | null {
  if (settings.dohProvider === DOH_CUSTOM) return parseDohTemplate(settings.dohCustomUrl)
  return DOH_PROVIDERS.find((p) => p.id === settings.dohProvider)?.template ?? null
}

/** Why secure mode without a server is refused; it names the mode by its label, so that both say the same word. */
export const secureWithoutServer = (): string => t('dns.le-mode-mode-exige-un-serveur', { mode: DOH_MODE_LABELS.secure })

/** What the engine is asked to do for these settings. */
export function planHostResolver(settings: DohSettings): HostResolverPlan {
  if (!settings.dohCustom) return { kind: 'default' }
  if (settings.dohMode === 'off') return { kind: 'configure', config: { secureDnsMode: 'off', secureDnsServers: [] } }
  const server = dohServerOf(settings)
  if (settings.dohMode === 'secure' && server === null) return { kind: 'refused', reason: secureWithoutServer() }
  return { kind: 'configure', config: { secureDnsMode: settings.dohMode, secureDnsServers: server ? [server] : [] } }
}

/** What Chromium does when nothing is configured: used to put the defaults back after the user turns the option off again. */
export const DEFAULT_HOST_RESOLVER: HostResolverConfig = { secureDnsMode: 'automatic', secureDnsServers: [] }
