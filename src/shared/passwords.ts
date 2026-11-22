// The password manager (docs/gestionnaire-mots-de-passe.md): pure rules shared by the main process, the page bridge and the panel. What an
// origin is and which may hold a password, which entry may be filled where, what the panel may ask, and what it is told. Nothing here
// reads a file or touches a page. The secrets themselves live in the main process only (src/main/password-vault.ts): no type of this
// file that reaches the interface carries a password.

import { generatorOptionsOf, type GeneratorOptions } from './password-generator'
import { t } from './i18n'
import type { PasswordHealth } from './password-health'
import { isRecord } from './record'
import { TOTP_LIMITS, type TotpCode, type TotpConfig } from './totp'

export const PASSWORD_LIMITS = {
  /** Entries in the vault (an import stops there). */
  entries: 5000,
  /** `scheme://host:port` as a URL gives it. */
  origin: 300,
  username: 256,
  password: 1024,
  /** The master phrase and the phrase of an export, in characters: longer than the lock's, because this one protects every password. */
  phraseMin: 12,
  phraseMax: 1024,
  /** How long a login seen on a page waits for the user's answer, in the main process only. */
  captureTtlMs: 3 * 60_000,
  /** The vault locks itself after this long without use. */
  autoLockMs: 10 * 60_000,
  /** A one-time code or a password copied to the clipboard is taken off it after this long, if it is still the text there. */
  clipboardClearMs: 30_000
} as const

/** A stored login. Only the main process ever holds one with its password. */
export interface PasswordEntry {
  id: string
  origin: string
  username: string
  password: string
  /** The key of its one-time codes (shared/totp.ts), sealed in the vault with the rest of the entry. Never in a row, a reply or a log. */
  totp?: TotpConfig
  createdAt: number
  updatedAt: number
}

/** What the panel is told of an entry: everything but the password. */
export interface PasswordRow {
  id: string
  origin: string
  host: string
  username: string
  /** The entry has a key for one-time codes (never the key). */
  totp: boolean
  /** Its password is easy to guess (shared/password-health.ts). Only the verdict leaves the main process, never the password. */
  weak: boolean
  /** Another entry holds the very same password. */
  reused: boolean
  updatedAt: number
}

/** The view of an entry for the interface. The one place a password could leak is here, and it is a copy of named fields. */
export function rowOf(entry: PasswordEntry, health: PasswordHealth = { weak: false, reused: false }): PasswordRow {
  return { id: entry.id, origin: entry.origin, host: hostLabel(entry.origin), username: entry.username, totp: entry.totp !== undefined, weak: health.weak, reused: health.reused, updatedAt: entry.updatedAt }
}

// ---------- origins ----------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** http is allowed for this machine only: a password never travels in the clear to another one. */
function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost')
}

/**
 * The origin (`scheme://host[:port]`, host in ASCII) a password may be kept for or filled on: https anywhere, http on this machine. Null
 * for anything else (`file:`, `data:`, `about:`, an extension page, http to a remote host, an address with a name and password in it
 * is read for its origin only). The comparison between an entry and a page is a comparison of these strings, nothing looser.
 */
/**
 * Whether a page came over a certificate that was let through. The exception is kept by host name, whatever the port and the scheme: a
 * page served over http has no certificate, and one let through for `https://localhost:8443` says nothing of `http://localhost:3000`.
 */
export function cameOverUntrustedCertificate(address: string | null | undefined, hostUntrusted: boolean | undefined): boolean {
  return hostUntrusted === true && typeof address === 'string' && URL.canParse(address) && new URL(address).protocol === 'https:'
}

export function eligibleOriginOf(address: unknown): string | null {
  if (typeof address !== 'string' || address.length === 0 || address.length > 4096 || !URL.canParse(address)) return null
  const url = new URL(address)
  const secure = url.protocol === 'https:'
  if (!secure && !(url.protocol === 'http:' && isLocalHost(url.hostname))) return null
  if (url.hostname === '') return null
  const origin = url.origin
  return origin.length <= PASSWORD_LIMITS.origin ? origin : null
}

/**
 * The address a user types or a file lists, as an eligible origin. A bare host (`exemple.com`) means https. Null when it is not
 * eligible, and `credentials` when it carries a name and a password (pasted from a bar: refused, not silently cut).
 */
export function siteAddress(text: unknown): { origin: string } | { error: 'invalid' | 'unsupported' | 'credentials' } {
  if (typeof text !== 'string') return { error: 'invalid' }
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 2048 || /\p{Cc}|\s/u.test(trimmed)) return { error: 'invalid' }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const full = hasScheme ? trimmed : /^[^/?#:@]+(:\d{1,5})?([/?#].*)?$/.test(trimmed) ? `https://${trimmed}` : null
  if (full === null || !URL.canParse(full)) return { error: hasScheme ? 'unsupported' : 'invalid' }
  const url = new URL(full)
  if (url.username !== '' || url.password !== '') return { error: 'credentials' }
  // No site has a comma in its name: this is two addresses written as one, and its origin would be a site that does not exist.
  if (url.hostname.includes(',')) return { error: 'invalid' }
  const origin = eligibleOriginOf(full)
  return origin === null ? { error: 'unsupported' } : { origin }
}

/** `host[:port]` of an origin, to show. A host with letters outside ASCII is shown as punycode, so a look-alike stays visible as one. */
export function hostLabel(origin: string): string {
  return URL.canParse(origin) ? new URL(origin).host : origin
}

// ---------- the fields of an entry ----------

/** A username: text without control characters, up to the limit. Empty is allowed (a site that asks for a password alone). */
export function cleanUsername(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > PASSWORD_LIMITS.username || /\p{Cc}/u.test(value)) return null
  return value.trim()
}

/** A password: not trimmed (it is the user's), not empty, no control character, up to the limit. */
export function cleanPassword(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > PASSWORD_LIMITS.password || /\p{Cc}/u.test(value)) return null
  return value
}

export type NewLoginProblem = 'address' | 'unsupported' | 'credentials' | 'username' | 'password'

/** A login as the user or an import gives it, checked. */
export function checkedLogin(input: { address: unknown; username: unknown; password: unknown }): { ok: true; origin: string; username: string; password: string } | { ok: false; problem: NewLoginProblem } {
  const site = siteAddress(input.address)
  if ('error' in site) return { ok: false, problem: site.error === 'invalid' ? 'address' : site.error }
  const username = cleanUsername(input.username)
  if (username === null) return { ok: false, problem: 'username' }
  const password = cleanPassword(input.password)
  if (password === null) return { ok: false, problem: 'password' }
  return { ok: true, origin: site.origin, username, password }
}

export const NEW_LOGIN_MESSAGES: Record<NewLoginProblem, string> = {
  get address() { return t('passwords.l-adresse-du-site-n-est-pas-valide') },
  get unsupported() { return t('passwords.seuls-les-sites-en-https-ou-en-http-sur-cet') },
  get credentials() { return t('passwords.l-adresse-ne-doit-pas-contenir-de-nom-ni-de-mot') },
  get username() { return t('passwords.l-identifiant-est-invalide-256-caracteres-au') },
  get password() { return t('passwords.le-mot-de-passe-est-invalide-1-a-1-024') }
}

/** Whether two logins are the same one: the same origin and the same username. */
export const sameLogin = (a: { origin: string; username: string }, b: { origin: string; username: string }): boolean => a.origin === b.origin && a.username === b.username

/** What a login seen on a page would do to the vault: add it, change the password of the entry with that username, or nothing. */
export function captureKind(entries: readonly PasswordEntry[], login: { origin: string; username: string; password: string }): 'new' | 'update' | 'same' {
  const known = entries.find((entry) => sameLogin(entry, login))
  if (!known) return 'new'
  return known.password === login.password ? 'same' : 'update'
}

// ---------- which entry may be filled where ----------

/**
 * Whether two origins are the same, or differ only by a leading `www.` on the host (an entry saved on `example.com` fills `www.example.com` and the
 * other way round). Nothing wider: the scheme and the port must be equal, only ONE `www.` is taken off, and what is left must be a name with a dot
 * (`www.localhost` is not `localhost`). No "same site", no "parent domain", no other subdomain: a neighbour is not the site.
 */
export function sameSiteOrigin(entryOrigin: string, pageOrigin: string): boolean {
  if (entryOrigin === pageOrigin) return true
  if (!URL.canParse(entryOrigin) || !URL.canParse(pageOrigin)) return false
  const [a, b] = [new URL(entryOrigin), new URL(pageOrigin)]
  if (a.protocol !== b.protocol || a.port !== b.port) return false
  const bare = (host: string): string => (host.startsWith('www.') ? host.slice(4) : host)
  const [hostA, hostB] = [bare(a.hostname), bare(b.hostname)]
  return hostA === hostB && hostA.includes('.') && a.hostname !== b.hostname
}

/** The entries that may be filled into the page: its exact origin, or its `www.` twin (`sameSiteOrigin`). */
export function entriesForPage<T extends { origin: string }>(entries: readonly T[], pageUrl: string | null | undefined): T[] {
  const origin = eligibleOriginOf(pageUrl)
  return origin === null ? [] : entries.filter((entry) => sameSiteOrigin(entry.origin, origin))
}

export type FillRefusal = 'off' | 'private' | 'untrusted' | 'locked' | 'no-page' | 'not-eligible' | 'origin-differs'

export interface FillContext {
  featureOn: boolean
  /** A private window, or a private tab of a normal one. */
  privateTab: boolean
  /**
   * The page came over a certificate that is not valid and was let through (« Continuer quand même », or Developer Mode): whoever answers may not
   * be the site, so nothing of the vault goes there. The address alone cannot tell: it is the site's own.
   */
  untrustedCertificate?: boolean
  vaultUnlocked: boolean
  /** The address the main process holds for the main frame of the tab. A fill only ever runs in that frame (the engine's `fillLogin`), and the page checks it again (`fillAgent`). */
  pageUrl: string | null | undefined
  entryOrigin: string
}

export type FillVerdict = { ok: true; origin: string } | { ok: false; reason: FillRefusal; message: string }

const REFUSALS: Record<FillRefusal, string> = {
  get off() { return t('pwd.le-gestionnaire-de-mots-de-passe-est-desactive') },
  get private() { return t('pwd.aucun-mot-de-passe-n-est-rempli-dans-une') },
  get untrusted() { return t('pwd.aucun-mot-de-passe-sur-une-page-au-certificat-non-valide') },
  get locked() { return t('pwd.le-coffre-est-verrouille') },
  get 'no-page'() { return t('pwd.aucune-page-a-remplir') },
  get 'not-eligible'() { return t('pwd.cette-page-n-accepte-pas-de-mot-de-passe') },
  get 'origin-differs'() { return t('pwd.l-adresse-de-la-page-n-est-pas-celle-de-cet') }
}

/** The single decision that lets a password reach a page. Every refusal is final; the order is the order of the checks. */
export function fillVerdict(context: FillContext): FillVerdict {
  const refuse = (reason: FillRefusal): FillVerdict => ({ ok: false, reason, message: REFUSALS[reason] })
  if (!context.featureOn) return refuse('off')
  if (context.privateTab) return refuse('private')
  if (cameOverUntrustedCertificate(context.pageUrl, context.untrustedCertificate)) return refuse('untrusted')
  if (!context.vaultUnlocked) return refuse('locked')
  if (!context.pageUrl) return refuse('no-page')
  const pageOrigin = eligibleOriginOf(context.pageUrl)
  if (pageOrigin === null) return refuse('not-eligible')
  if (!sameSiteOrigin(context.entryOrigin, pageOrigin)) return refuse('origin-differs')
  return { ok: true, origin: pageOrigin }
}

// ---------- what a page sends, what the panel sends ----------

/** The channel of the page bridge (src/preload/password-bridge.ts): one message, from the main frame of a tab, when a form was submitted. */
export const PASSWORD_BRIDGE = { submitted: 'lucium-password-submitted' } as const

/**
 * Whether a `submit` event of a page counts for an offer to save (the page bridge asks): the browser itself made the event (a script cannot set
 * `isTrusted`), and the user touched the page a moment before (transient user activation, when the engine has the notion): a page that
 * calls `requestSubmit()` from a timer is not heard.
 */
export function mayReportSubmit(event: { isTrusted?: unknown }, navigator: { userActivation?: { isActive?: unknown } } | undefined): boolean {
  if (event.isTrusted !== true) return false
  const activation = navigator?.userActivation
  return activation === undefined || activation.isActive === true
}

/** A login seen in a form the user submitted. The origin is not here: the main process reads it from the frame, never from the page. */
export interface Submission {
  username: string
  password: string
}

/** The page's message, or null when it is anything but exactly this. Bounds are the ones of the vault. */
export function parseSubmission(raw: unknown): Submission | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== 2 || !keys.includes('username') || !keys.includes('password')) return null
  const { username, password } = raw as { username: unknown; password: unknown }
  // A page may send anything: a username with a control character is not cleaned, it is refused.
  const cleanedUser = typeof username === 'string' ? cleanUsername(username) : null
  const cleanedPassword = cleanPassword(password)
  return cleanedUser === null || cleanedPassword === null ? null : { username: cleanedUser, password: cleanedPassword }
}

export interface ImportReport {
  format: 'chrome' | 'bitwarden' | '1password' | 'lucium'
  /** Rows read. */
  read: number
  added: number
  /** Already in the vault (same origin and username): left as they are. */
  duplicates: number
  /** An address that cannot hold a password (http to a remote site, an app, a bad address). */
  unsupported: number
  /** No password, or no address. */
  empty: number
  /** A field too long or with a control character. */
  invalid: number
  /** Not added because the vault is full. */
  overCapacity: number
}

export type PasswordRequest =
  | { kind: 'status' }
  | { kind: 'create'; phrase: string }
  | { kind: 'unlock'; phrase: string }
  | { kind: 'lock' }
  | { kind: 'change-phrase'; current: string; next: string }
  | { kind: 'destroy'; phrase: string }
  | { kind: 'add'; address: string; username: string; password: string }
  | { kind: 'remove'; id: string }
  | { kind: 'fill'; id: string }
  | { kind: 'fill-active' }
  /** `never`: do not offer this site again (its host goes to the list of the settings), and forget the login. */
  | { kind: 'capture'; op: 'confirm' | 'dismiss' | 'never'; offer: number }
  | { kind: 'generate'; options: GeneratorOptions }
  | { kind: 'import-csv' }
  | { kind: 'export'; phrase: string }
  | { kind: 'import-export'; phrase: string }
  /** Opens the vault with the key the keychain gives back after Touch ID (main/vault-keychain.ts). */
  | { kind: 'unlock-touch-id' }
  /** Puts the key in the keychain behind Touch ID: the phrase is asked again. */
  | { kind: 'touch-id-on'; phrase: string }
  /** Deletes the key from the keychain. */
  | { kind: 'touch-id-off' }
  /** Adds (or replaces) the key of the one-time codes of an entry: a base32 key or an `otpauth://totp/…` address, as typed. */
  | { kind: 'totp-set'; id: string; secret: string }
  | { kind: 'totp-remove'; id: string }
  /** The code of now for an entry, to show with its countdown. */
  | { kind: 'totp-code'; id: string; auto?: true }
  /** Puts the code of now on the clipboard (from the main process: the page is not told), and takes it off after `clipboardClearMs`. */
  | { kind: 'totp-copy'; id: string }
  /** Puts the password of an entry on the clipboard, marked concealed, from the main process (the panel is not told it), and takes it off after `clipboardClearMs` and when the vault locks. */
  | { kind: 'copy-password'; id: string }

/** Touch ID for the vault: whether this Mac and this build can offer it, and whether it is on. */
export interface TouchIdView {
  /** Touch ID can be asked for now: the helper is there and the system can show a prompt. */
  available: boolean
  enabled: boolean
  /** The helper is there and may be started (a signed build, on macOS), whether or not the system can show a prompt now: with `available` false,
   *  it tells "not now" (the lid of the Mac closed, no sensor) from "not in this build". */
  installed: boolean
}

/** What the panel is told about the tab on screen. */
export interface PagePasswords {
  host: string | null
  /** Passwords may be filled here at all (an eligible address, a normal tab). */
  fillable: boolean
  /** Why not, when it is not. */
  reason?: string
  /** The entries that match this page exactly. */
  matching: string[]
}

/** A login seen on a page, waiting for the user's answer: never the password. */
export interface CaptureView {
  kind: 'new' | 'update'
  host: string
  username: string
  /**
   * Which offer this is. The panel sends it back with its answer: a window has one offer at a time and a form submitted in another tab replaces
   * it, so « Enregistrer » says which login was on screen when it was clicked, and an answer to an offer that is gone saves nothing.
   */
  offer: number
}

/** Everything the panel shows. No password is in it, in any field. */
export interface PasswordsView {
  enabled: boolean
  vault: 'none' | 'locked' | 'unlocked'
  entries: PasswordRow[]
  page: PagePasswords | null
  capture: CaptureView | null
  /** Milliseconds before another phrase is tried; 0 when one can be tried now. */
  retryInMs: number
  touchId: TouchIdView
}

export interface PasswordReply {
  ok: boolean
  message?: string
  view: PasswordsView
  /** Only for a `generate` request: the text the user asked to see in the field they are filling. */
  password?: string
  /** Only for a `totp-code` request: the digits the user asked to see, with the seconds they last. */
  totp?: TotpCode
  report?: ImportReport
}

export const NO_PASSWORDS_VIEW: PasswordsView = Object.freeze({ enabled: false, vault: 'none', entries: [], page: null, capture: null, retryInMs: 0, touchId: Object.freeze({ available: false, enabled: false, installed: false }) }) as PasswordsView

const phrase = (value: unknown): value is string => typeof value === 'string' && value.length <= PASSWORD_LIMITS.phraseMax
const idOf = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

/** The panel's request, or null for anything that is not exactly one of the kinds, with exactly its fields. */
export function parsePasswordRequest(raw: unknown): PasswordRequest | null {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string') return null
  const only = (...keys: string[]): boolean => Object.keys(raw).every((key) => key === 'kind' || keys.includes(key))
  switch (raw['kind']) {
    case 'status':
    case 'lock':
    case 'fill-active':
    case 'import-csv':
    case 'unlock-touch-id':
    case 'touch-id-off':
      return only() ? ({ kind: raw['kind'] } as PasswordRequest) : null
    case 'create':
    case 'unlock':
    case 'destroy':
    case 'export':
    case 'import-export':
    case 'touch-id-on':
      return only('phrase') && phrase(raw['phrase']) ? ({ kind: raw['kind'], phrase: raw['phrase'] } as PasswordRequest) : null
    case 'change-phrase':
      return only('current', 'next') && phrase(raw['current']) && phrase(raw['next']) ? { kind: 'change-phrase', current: raw['current'], next: raw['next'] } : null
    case 'add':
      // The fields are checked as a login (checkedLogin) by the service; here only that they are strings of a bounded size.
      return only('address', 'username', 'password') && typeof raw['address'] === 'string' && raw['address'].length <= 2048 && typeof raw['username'] === 'string' && raw['username'].length <= PASSWORD_LIMITS.username * 2 && typeof raw['password'] === 'string' && raw['password'].length <= PASSWORD_LIMITS.password * 2
        ? { kind: 'add', address: raw['address'], username: raw['username'], password: raw['password'] }
        : null
    case 'totp-code':
      // `auto` is the panel's own refresh when a code ends; it does not count as the person's activity (the idle lock keeps running).
      if (raw['auto'] !== undefined) return only('id', 'auto') && idOf(raw['id']) && raw['auto'] === true ? { kind: 'totp-code', id: raw['id'], auto: true } : null
      return only('id') && idOf(raw['id']) ? { kind: 'totp-code', id: raw['id'] } : null
    case 'remove':
    case 'fill':
    case 'totp-remove':
    case 'totp-copy':
    case 'copy-password':
      return only('id') && idOf(raw['id']) ? ({ kind: raw['kind'], id: raw['id'] } as PasswordRequest) : null
    case 'totp-set':
      return only('id', 'secret') && idOf(raw['id']) && typeof raw['secret'] === 'string' && raw['secret'].length <= TOTP_LIMITS.inputMax ? { kind: 'totp-set', id: raw['id'], secret: raw['secret'] } : null
    case 'capture':
      return only('op', 'offer') && (raw['op'] === 'confirm' || raw['op'] === 'dismiss' || raw['op'] === 'never') && Number.isSafeInteger(raw['offer']) && (raw['offer'] as number) > 0 ? { kind: 'capture', op: raw['op'], offer: raw['offer'] as number } : null
    case 'generate':
      return only('options') ? { kind: 'generate', options: generatorOptionsOf(raw['options']) } : null
    default:
      return null
  }
}

/** The master phrase, or the sentence about why it is not one. */
export function phraseProblem(value: unknown): string | null {
  if (typeof value !== 'string') return t('passwords.la-phrase-est-invalide')
  if ([...value.normalize('NFKC')].length < PASSWORD_LIMITS.phraseMin) return t('passwords.la-phrase-doit-faire-au-moins-phrasemin', { phraseMin: PASSWORD_LIMITS.phraseMin })
  if (value.length > PASSWORD_LIMITS.phraseMax) return t('passwords.la-phrase-est-trop-longue')
  return null
}
