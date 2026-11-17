// The key of the password vault behind Touch ID (docs/gestionnaire-mots-de-passe.md).
//
// `systemPreferences.promptTouchID` answers yes or no and protects nothing. Here the key itself (the 64 bytes scrypt derived from the master
// phrase) is kept by macOS in the data protection keychain under the access control `.biometryCurrentSet`, and the system gives it back only
// after a fingerprint of the fingers enrolled when it was stored. Electron cannot reach that keychain: a small helper does, an XPC service of
// the application (native/vault-keychain/main.swift, Contents/XPCServices/LuciumKeychain.xpc) that launchd starts on demand. The main
// process talks to it through an addon (native/vault-xpc/, Contents/Resources/vault-xpc.node): the transport of this file
// (`KeychainTransport`, one JSON request, one JSON answer), which the tests replace.
//
// Rules this file keeps, each with its test (vault-keychain.test.ts, shell/password-touch-id.test.ts):
//  - a key is taken only from the answer of a `load` that says `ok: true`: the helper writes one only after the keychain released the item,
//    i.e. after the fingerprint. A key beside a failure is ignored;
//  - the key never goes in an argument of a program (other processes read command lines) and never in a log: it goes in the request handed to
//    the transport, and what is logged is a kind and an OSStatus;
//  - the master phrase stays the way in: every failure here (cancelled, refused, other fingers, no helper, no entitlement, a phrase that
//    changed) ends with the phrase being asked, never with a vault that cannot be opened;
//  - turning Touch ID off deletes the item from the keychain before the record that says it is on;
//  - the helper is reached only from the built application, with its helper and its addon in place and a team to require (an application
//    signed ad hoc, or run from the sources, has none: Touch ID is unavailable there). Each side requires the other's signature on every
//    message, through the system (xpc_connection_set_peer_code_signing_requirement): the helper only answers Lucium of its own team, the addon
//    only believes the helper of the application's team. The words of the fingerprint prompt are the helper's own: this side names the reason
//    and the language, never the text;
//  - a request still waiting when the application quits is cancelled (`stopKeychainHelpers`): the helper then takes its prompt off the screen.
//
// The record (`passwords.vault.touchid`, 0600, beside the vault) holds no secret: where the item is (service, account), the salt of the
// vault the key belongs to, and the system's opaque mark of the enrolled fingers at that time (to tell "other fingers" from "missing").

import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { readTextBounded } from './persist'
import { join, resolve } from 'node:path'
import { writePrivateFile } from './password-vault'
import { KEY_MATERIAL_BYTES } from './vault-crypto'
import { isRecord } from '@shared/record'
import { LANGUAGES, type Language } from '@shared/i18n'

/** The XPC service and its program the packaging puts in Contents/XPCServices/ (native/vault-keychain/build.sh). */
export const KEYCHAIN_HELPER_BUNDLE = 'LuciumKeychain.xpc'
export const KEYCHAIN_HELPER_EXECUTABLE = 'lucium-keychain'
/** The identifier its bundle is signed under (native/vault-keychain/Info.plist): the name it is reached by, and what the addon requires of it. */
export const KEYCHAIN_HELPER_IDENTIFIER = 'app.lucium.browser.keychain'
/** The addon the packaging puts in Contents/Resources/, outside app.asar (native/vault-xpc/build.sh). */
export const KEYCHAIN_ADDON = 'vault-xpc.node'
/** The one reason the helper knows: it shows its own words for it, in the language asked (native/vault-keychain/main.swift `prompts`). */
export const KEYCHAIN_PROMPT_REASON = 'open-vault'
/** Every item of the helper has a service of Lucium: the helper refuses any other. */
export const KEYCHAIN_SERVICE_PREFIX = 'app.lucium.browser.'
export const KEYCHAIN_ACCOUNT = 'vault-key'

/** How long the user has to answer the fingerprint prompt, and how long a store or a delete may take (no prompt). */
export const KEYCHAIN_PROMPT_TIMEOUT_MS = 90_000
export const KEYCHAIN_QUICK_TIMEOUT_MS = 15_000
/** An answer is one short line of JSON: anything longer is not one. */
const OUTPUT_LIMIT = 4096
const RECORD_LIMIT = 4096

const SERVICE_PATTERN = /^app\.lucium\.browser\.[A-Za-z0-9.-]{1,120}$/
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
/** The mark of the enrolled fingers: opaque base64, a few dozen bytes. */
const STATE_PATTERN = /^[A-Za-z0-9+/]{1,1020}={0,2}$/

/** What the helper answers (native/vault-keychain/main.swift), and what this side adds: a stale record, a helper that did not answer or is not signed as expected. */
export type KeychainFailure =
  | 'cancelled'
  | 'failed'
  | 'biometry-changed'
  | 'unavailable'
  | 'not-found'
  | 'not-entitled'
  | 'invalid'
  | 'error'
  | 'stale'
  | 'timeout'
  | 'helper'
  | 'untrusted'

const HELPER_CODES: ReadonlySet<string> = new Set(['cancelled', 'failed', 'biometry-changed', 'unavailable', 'not-found', 'not-entitled', 'invalid', 'error'])

/** A failure of the keychain with its kind. Its message holds the kind and the OSStatus, never a key. */
export class KeychainError extends Error {
  constructor(
    readonly kind: KeychainFailure,
    readonly status?: number
  ) {
    super(`keychain: ${kind}${status === undefined ? '' : ` (${status})`}`)
    this.name = 'KeychainError'
  }
}

export type HelperRequest =
  | { command: 'store'; service: string; account: string; key: string }
  | { command: 'load'; service: string; account: string; reason: typeof KEYCHAIN_PROMPT_REASON; language: Language; state?: string }
  | { command: 'delete'; service: string; account: string }

/** Asks the helper once and answers the JSON it answered, parsed. Rejects with a KeychainError ('timeout', 'untrusted', 'helper'). */
export type HelperRunner = (request: HelperRequest, timeoutMs: number) => Promise<unknown>

type Failed = { ok: false; error: KeychainFailure; status?: number }

/** Base64 that is exactly the encoding of `bytes` bytes (Node's decoder skips what it does not read: that is not accepted). */
function strictBase64(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes / 3) * 4) return null
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    decoded.fill(0)
    return null
  }
  return decoded
}

function failureOf(raw: Record<string, unknown>): Failed {
  const code = raw['error']
  const status = raw['status']
  return { ok: false, error: typeof code === 'string' && HELPER_CODES.has(code) ? (code as KeychainFailure) : 'helper', ...(typeof status === 'number' && Number.isInteger(status) ? { status } : {}) }
}

/**
 * The answer of a `load`. THE GUARD of "no key without Touch ID" on this side: a key is read only from an answer that says `ok: true`,
 * which the helper writes only after the keychain released the item (after the fingerprint its access control asks for). Anything else
 * is a failure, whatever else the answer carries.
 */
export function parseLoadReply(raw: unknown): { ok: true; key: Buffer } | Failed {
  if (!isRecord(raw)) return { ok: false, error: 'helper' }
  if (raw['ok'] !== true) return failureOf(raw)
  const key = strictBase64(raw['key'], KEY_MATERIAL_BYTES)
  return key ? { ok: true, key } : { ok: false, error: 'helper' }
}

/** The answer of a `store`: the mark of the enrolled fingers, when the system gave one. */
export function parseStoreReply(raw: unknown): { ok: true; state: string | null } | Failed {
  if (!isRecord(raw)) return { ok: false, error: 'helper' }
  if (raw['ok'] !== true) return failureOf(raw)
  const state = raw['state']
  return { ok: true, state: typeof state === 'string' && STATE_PATTERN.test(state) ? state : null }
}

export function parseDeleteReply(raw: unknown): { ok: true } | Failed {
  if (!isRecord(raw)) return { ok: false, error: 'helper' }
  return raw['ok'] === true ? { ok: true } : failureOf(raw)
}

/**
 * Sends one request (its JSON) to the keychain helper and answers the JSON of its answer, or rejects with an Error whose `code` is a kind of
 * the addon (native/vault-xpc/vault_xpc.c): untrusted, no-reply, interrupted, invalid, timeout, cancelled. A test hands in its own.
 */
export type KeychainTransport = (request: string, timeoutMs: number) => Promise<string>

/** The addon as the main process loads it (native/vault-xpc/vault_xpc.c). */
export interface KeychainAddon {
  sendRequest(request: string, timeoutMs: number): Promise<string>
  /** Every request still waiting is rejected as 'cancelled', and its connections are closed (the helper takes its prompt away). */
  cancelAll(): void
  /** Whether this application has a team to require of the helper (signed ad hoc, or unsigned, it has none and sends nothing). */
  trusted(): boolean
}

/** The kinds of the addon that keep a meaning here; any other (no answer, an interruption, a cancellation) is a helper that did not answer. */
const TRANSPORT_KINDS: ReadonlyMap<unknown, KeychainFailure> = new Map([
  ['timeout', 'timeout'],
  ['untrusted', 'untrusted']
])

/**
 * The runner over a transport. The request (with the key of a `store`) is handed to the transport as JSON and goes nowhere else; the answer
 * is parsed once it is known to be short. The strings of JavaScript (the request, the answer) cannot be wiped: they live until they are collected.
 */
export function helperRunner(transport: KeychainTransport): HelperRunner {
  return async (request, timeoutMs) => {
    let answer: string
    try {
      answer = await transport(JSON.stringify(request), timeoutMs)
    } catch (error) {
      throw new KeychainError(TRANSPORT_KINDS.get(isRecord(error) ? error['code'] : undefined) ?? 'helper')
    }
    if (typeof answer !== 'string' || answer.length > OUTPUT_LIMIT) throw new KeychainError('helper')
    try {
      return JSON.parse(answer) as unknown
    } catch {
      throw new KeychainError('helper')
    }
  }
}

/** The addons loaded (one in practice): their requests are cancelled when the application quits. */
const addons = new Set<KeychainAddon>()

/** Cancels every request still waiting (at quit): it then fails as 'helper', nothing waits for it, and the helper takes its prompt away. */
export function stopKeychainHelpers(): void {
  for (const addon of addons) addon.cancelAll()
}

/** Where the built application carries the helper (Contents/XPCServices/) and the addon (Contents/Resources/, outside app.asar). */
export function keychainPaths(resourcesPath: string): { helper: string; addon: string } {
  return { helper: join(resourcesPath, '..', 'XPCServices', KEYCHAIN_HELPER_BUNDLE), addon: join(resourcesPath, KEYCHAIN_ADDON) }
}

/** Loads the addon at `path` (a .node file outside app.asar, through `process.dlopen`). Throws when it is not the addon. */
export function loadKeychainAddon(path: string, open: (module: { exports: unknown }, path: string) => void = (module, file) => process.dlopen(module, file)): KeychainAddon {
  const module: { exports: unknown } = { exports: {} }
  open(module, path)
  const addon = module.exports
  if (!isRecord(addon) || typeof addon['sendRequest'] !== 'function' || typeof addon['cancelAll'] !== 'function' || typeof addon['trusted'] !== 'function') throw new Error('not the keychain addon')
  return addon as unknown as KeychainAddon
}

/**
 * THE GUARD of "Touch ID only in a signed application": the transport of the built application (`resourcesPath` of process.resourcesPath),
 * or null when Touch ID cannot be offered: the helper or the addon is missing, the addon does not load, or this application has no team (an
 * ad hoc build: the addon would send nothing, and the helper would admit nothing either). Called at the first use only.
 */
export function keychainTransport(resourcesPath: string, load: (path: string) => KeychainAddon = loadKeychainAddon): KeychainTransport | null {
  const where = keychainPaths(resourcesPath)
  if (!existsSync(where.helper) || !existsSync(where.addon)) return null
  let addon: KeychainAddon
  try {
    addon = load(where.addon)
  } catch (error) {
    console.error('[passwords] the keychain addon could not be loaded, Touch ID is unavailable:', error instanceof Error ? error.name : typeof error)
    return null
  }
  if (!addon.trusted()) {
    console.warn('[passwords] this application has no team to require of the keychain helper: Touch ID is unavailable')
    return null
  }
  addons.add(addon)
  // The one place a request leaves for the helper, which launchd starts if it is not running (listed in zero-cost-inventory.test.ts: only on a
  // request of the panel).
  return (request, timeoutMs) => addon.sendRequest(request, timeoutMs)
}

/** The service of a vault's item: Lucium's, and this data folder's (the DRM variant, a copy of the profile, never share a key). */
export function keychainServiceFor(vaultPath: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}password-vault.${createHash('sha256').update(resolve(vaultPath)).digest('hex').slice(0, 24)}`
}

interface TouchIdRecord {
  v: 1
  service: string
  account: string
  /** The salt of the vault the key was derived with (base64). */
  salt: string
  /** The system's mark of the enrolled fingers at the store (base64), or null. */
  state: string | null
}

/** The keychain as the password service uses it (shell/password-service.ts). */
export interface VaultKeychainPort {
  /** Touch ID can be offered here: the helper exists and the system can ask for a fingerprint now. */
  available(): boolean
  /** The helper exists and may be started, whether or not the system can ask for a fingerprint now (the lid of the Mac closed, no sensor). */
  installed(): boolean
  /** Touch ID is on for this vault (its record is there). */
  enabled(): boolean
  /** Puts the key in the keychain behind the enrolled fingers, then writes the record. The caller wipes `material`. */
  enable(material: Buffer, salt: Buffer): Promise<void>
  /** The key, after the fingerprint (the prompt in `language`, in the helper's own words). Throws KeychainError. The caller wipes what it gets. */
  load(language: Language, salt: Buffer): Promise<Buffer>
  /** Deletes the item, then the record; the record stays when the keychain could not be asked (it throws). */
  disable(): Promise<void>
  /** Like `disable`, but the record goes whatever the keychain answered (the key no longer opens anything); answers that failure, for the log. */
  forget(): Promise<KeychainError | null>
}

export interface VaultKeychainOptions {
  /** The record that says Touch ID is on: beside the vault, 0600. */
  recordPath: string
  service: string
  /** The helper, made at its first use (null: this system or this build has none). Nothing is looked at before. */
  runner: () => HelperRunner | null
  /** Whether the system can ask for a fingerprint now (`systemPreferences.canPromptTouchID`). */
  canPrompt: () => boolean
  promptTimeoutMs?: number
  quickTimeoutMs?: number
}

export class VaultKeychain implements VaultKeychainPort {
  private resolved: HelperRunner | null | undefined

  constructor(private readonly options: VaultKeychainOptions) {
    if (!SERVICE_PATTERN.test(options.service)) throw new Error('not a keychain service of Lucium')
  }

  private run(): HelperRunner | null {
    if (this.resolved === undefined) this.resolved = this.options.runner()
    return this.resolved
  }

  private get quick(): number {
    return this.options.quickTimeoutMs ?? KEYCHAIN_QUICK_TIMEOUT_MS
  }

  available(): boolean {
    return this.installed() && this.options.canPrompt()
  }

  installed(): boolean {
    return this.run() !== null
  }

  enabled(): boolean {
    return this.record() !== null
  }

  /** The record, or null when there is none or it is not one (a hand-made or damaged file counts as "off"; the item is deleted at the next `disable`). */
  private record(): TouchIdRecord | null {
    const path = this.options.recordPath
    if (!existsSync(path)) return null
    let raw: unknown
    try {
      raw = JSON.parse(readTextBounded(path, RECORD_LIMIT))
    } catch (error) {
      console.error('[passwords] the Touch ID record cannot be read:', error instanceof Error ? error.name : typeof error)
      return null
    }
    if (!isRecord(raw) || raw['v'] !== 1) return null
    const { service, account, salt, state } = raw
    if (typeof service !== 'string' || !SERVICE_PATTERN.test(service) || typeof account !== 'string' || !ACCOUNT_PATTERN.test(account)) return null
    if (typeof salt !== 'string' || strictBase64(salt, 16) === null) return null
    if (state !== null && (typeof state !== 'string' || !STATE_PATTERN.test(state))) return null
    return { v: 1, service, account, salt, state }
  }

  async enable(material: Buffer, salt: Buffer): Promise<void> {
    const run = this.run()
    if (!run) throw new KeychainError('unavailable')
    if (material.length !== KEY_MATERIAL_BYTES) throw new KeychainError('invalid')
    const reply = parseStoreReply(await run({ command: 'store', service: this.options.service, account: KEYCHAIN_ACCOUNT, key: material.toString('base64') }, this.quick))
    if (!reply.ok) throw new KeychainError(reply.error, reply.status)
    const record: TouchIdRecord = { v: 1, service: this.options.service, account: KEYCHAIN_ACCOUNT, salt: salt.toString('base64'), state: reply.state }
    try {
      writePrivateFile(this.options.recordPath, `${JSON.stringify(record)}\n`)
    } catch (error) {
      // An item without its record would be a key nobody turns off: it goes too.
      await this.forget()
      throw error
    }
  }

  async load(language: Language, salt: Buffer): Promise<Buffer> {
    const record = this.record()
    if (!record) throw new KeychainError('not-found')
    // A key stored for another salt cannot open this vault (the phrase changed, the vault was made again): no prompt for nothing.
    if (record.salt !== salt.toString('base64')) throw new KeychainError('stale')
    const run = this.run()
    if (!run) throw new KeychainError('unavailable')
    // The helper has words for each language of the application (vault-keychain-native.test.ts compares them with the catalogues).
    if (!(LANGUAGES as readonly string[]).includes(language)) throw new KeychainError('invalid')
    const reply = parseLoadReply(
      await run(
        { command: 'load', service: record.service, account: record.account, reason: KEYCHAIN_PROMPT_REASON, language, ...(record.state === null ? {} : { state: record.state }) },
        this.options.promptTimeoutMs ?? KEYCHAIN_PROMPT_TIMEOUT_MS
      )
    )
    if (!reply.ok) throw new KeychainError(reply.error, reply.status)
    return reply.key
  }

  /** Asks the helper to delete the item (the record's, else this vault's own name, so that an item whose record was lost goes too). */
  private async deleteItem(record: TouchIdRecord | null): Promise<KeychainError | null> {
    const run = this.run()
    if (!run) return record ? new KeychainError('unavailable') : null
    try {
      const reply = parseDeleteReply(await run({ command: 'delete', service: record?.service ?? this.options.service, account: record?.account ?? KEYCHAIN_ACCOUNT }, this.quick))
      return reply.ok ? null : new KeychainError(reply.error, reply.status)
    } catch (error) {
      return error instanceof KeychainError ? error : new KeychainError('helper')
    }
  }

  async disable(): Promise<void> {
    const failure = await this.deleteItem(this.record())
    if (failure) throw failure
    rmSync(this.options.recordPath, { force: true })
  }

  async forget(): Promise<KeychainError | null> {
    const failure = await this.deleteItem(this.record())
    rmSync(this.options.recordPath, { force: true })
    return failure
  }
}
