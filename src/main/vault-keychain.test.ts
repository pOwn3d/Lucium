import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_ADDON,
  KEYCHAIN_SERVICE_PREFIX,
  KeychainError,
  VaultKeychain,
  helperRunner,
  keychainPaths,
  keychainServiceFor,
  keychainTransport,
  loadKeychainAddon,
  parseDeleteReply,
  stopKeychainHelpers,
  parseLoadReply,
  parseStoreReply,
  type HelperRequest,
  type HelperRunner,
  type KeychainAddon,
  type KeychainTransport
} from './vault-keychain'

// A key of the vault as the keychain keeps it: 64 bytes, recognisable in any encoding a leak could take.
const MATERIAL = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff))
const KEY_B64 = MATERIAL.toString('base64')
const KEY_HEX = MATERIAL.toString('hex')
const SALT = Buffer.alloc(16, 7)
const OTHER_SALT = Buffer.alloc(16, 8)
/** The language the prompt is asked in: the helper has its own words for it (main.swift `prompts`), this side never sends a text. */
const LANGUAGE = 'fr'

type Biometry = 'match' | 'cancel' | 'fail' | 'other-fingers' | 'unavailable' | 'not-entitled'

/** The helper and the keychain behind it, as main.swift and macOS behave: the item comes out only on a matching fingerprint. */
class SimulatedHelper {
  items = new Map<string, string>()
  biometry: Biometry = 'match'
  /** A careless helper that puts the key in its failure answers too: this side must not take it. */
  leak = false
  /** The keychain refuses to delete (an OSStatus of its own). */
  deleteFails = false
  requests: HelperRequest[] = []
  run: HelperRunner = async (request) => {
    this.requests.push(request)
    const name = `${request.service}/${request.account}`
    if (request.command === 'store') {
      if (this.biometry === 'unavailable') return { ok: false, error: 'unavailable' }
      if (this.biometry === 'not-entitled') return { ok: false, error: 'not-entitled', status: -34018 }
      this.items.set(name, request.key)
      return { ok: true, state: 'ZmluZ2Vycw==' }
    }
    if (request.command === 'delete') return this.deleteFails ? { ok: false, error: 'error', status: -50 } : { ok: true, deleted: this.items.delete(name) }
    const key = this.items.get(name)
    const leaked = this.leak && key ? { key } : {}
    if (this.biometry === 'unavailable') return { ok: false, error: 'unavailable', ...leaked }
    if (this.biometry === 'not-entitled') return { ok: false, error: 'not-entitled', status: -34018, ...leaked }
    if (!key) return { ok: false, error: 'not-found', status: -25300 }
    if (this.biometry === 'cancel') return { ok: false, error: 'cancelled', status: -128, ...leaked }
    if (this.biometry === 'fail') return { ok: false, error: 'failed', status: -25293, ...leaked }
    if (this.biometry === 'other-fingers') {
      this.items.delete(name)
      return { ok: false, error: 'biometry-changed', status: -25300, ...leaked }
    }
    return { ok: true, key }
  }
}

let dir: string
const logged: string[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-keychain-'))
  logged.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const service = keychainServiceFor('/Users/ana/Library/Application Support/Lucium/passwords.vault')
function keychain(helper: SimulatedHelper | null = new SimulatedHelper(), canPrompt = true) {
  const recordPath = join(dir, 'passwords.vault.touchid')
  const runner = vi.fn(() => helper?.run ?? null)
  return { keychain: new VaultKeychain({ recordPath, service, runner, canPrompt: () => canPrompt }), recordPath, runner, helper }
}

describe('the answer of a load: no key without a biometric success', () => {
  it('takes the key from an answer that says ok', () => {
    const reply = parseLoadReply({ ok: true, key: KEY_B64 })
    expect(reply.ok).toBe(true)
    expect(reply.ok && reply.key.equals(MATERIAL)).toBe(true)
  })

  it('never takes a key from a failure, whatever else the answer carries', () => {
    for (const error of ['cancelled', 'failed', 'biometry-changed', 'unavailable', 'not-found', 'not-entitled', 'error']) {
      const reply = parseLoadReply({ ok: false, error, key: KEY_B64 })
      expect(reply, error).toEqual({ ok: false, error })
    }
    // Not `true`: a string, a number, a missing field.
    for (const raw of [{ ok: 'true', key: KEY_B64 }, { ok: 1, key: KEY_B64 }, { key: KEY_B64 }, null, 'ok', [KEY_B64]]) expect(parseLoadReply(raw).ok, JSON.stringify(raw)).toBe(false)
  })

  it('refuses a key that is not exactly 64 bytes of strict base64', () => {
    for (const key of [MATERIAL.subarray(0, 32).toString('base64'), `${KEY_B64.slice(0, -2)}!!`, `${KEY_B64}AAAA`, KEY_HEX, 42]) expect(parseLoadReply({ ok: true, key })).toEqual({ ok: false, error: 'helper' })
  })

  it('keeps the code and the OSStatus of a failure, and turns an unknown code into "helper"', () => {
    expect(parseLoadReply({ ok: false, error: 'cancelled', status: -128 })).toEqual({ ok: false, error: 'cancelled', status: -128 })
    expect(parseLoadReply({ ok: false, error: 'rm -rf' })).toEqual({ ok: false, error: 'helper' })
    expect(parseStoreReply({ ok: true, state: 'ZmluZ2Vycw==' })).toEqual({ ok: true, state: 'ZmluZ2Vycw==' })
    expect(parseStoreReply({ ok: true, state: '<script>' })).toEqual({ ok: true, state: null })
    expect(parseDeleteReply({ ok: false, error: 'not-entitled', status: -34018 })).toEqual({ ok: false, error: 'not-entitled', status: -34018 })
  })
})

/** A transport that answers `answer` (or fails as told), and keeps what it was given. */
function fakeTransport(answer: string | (() => Promise<string>)) {
  const calls: Array<{ request: string; timeoutMs: number }> = []
  const transport: KeychainTransport = async (request, timeoutMs) => {
    calls.push({ request, timeoutMs })
    return typeof answer === 'string' ? answer : answer()
  }
  return { calls, transport }
}

/** An error as the addon rejects with one: its kind in `code`. */
const addonError = (code: string): Error => Object.assign(new Error(`vault-xpc: ${code}`), { code })

/** The addon as a test wants it: trusted or not, and what its requests answer. */
function fakeAddon(trusted = true, answer: () => Promise<string> = async () => '{"ok":true}') {
  const addon = { sendRequest: vi.fn((_request: string, _timeoutMs: number) => answer()), cancelAll: vi.fn(), trusted: vi.fn(() => trusted) }
  return addon satisfies KeychainAddon
}

/** A built application as the packaging makes it: Contents/Resources/ (the addon) and Contents/XPCServices/ (the helper), each there or not. */
function builtApp(pieces: { helper: boolean; addon: boolean }): string {
  const resources = join(dir, 'Lucium.app', 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })
  if (pieces.helper) mkdirSync(join(dir, 'Lucium.app', 'Contents', 'XPCServices', 'LuciumKeychain.xpc', 'Contents'), { recursive: true })
  if (pieces.addon) writeFileSync(join(resources, 'vault-xpc.node'), 'addon')
  return resources
}

describe('the runner of the helper, over its transport', () => {
  it('hands the request, the key of a store included, to the transport as JSON and nowhere else, and parses the answer', async () => {
    const { calls, transport } = fakeTransport('{"ok":true,"state":null}')
    const answer = await helperRunner(transport)({ command: 'store', service, account: KEYCHAIN_ACCOUNT, key: KEY_B64 }, 1000)
    expect(answer).toEqual({ ok: true, state: null })
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.request)).toEqual({ command: 'store', service, account: KEYCHAIN_ACCOUNT, key: KEY_B64 })
    expect(calls[0]!.timeoutMs).toBe(1000)
  })

  it('says "timeout" and "untrusted" as the addon does, and "helper" for any other failure', async () => {
    const request: HelperRequest = { command: 'delete', service, account: KEYCHAIN_ACCOUNT }
    const failing = (error: unknown) => helperRunner(fakeTransport(() => Promise.reject(error)).transport)(request, 1000)
    await expect(failing(addonError('timeout'))).rejects.toMatchObject({ name: 'KeychainError', kind: 'timeout' })
    await expect(failing(addonError('untrusted'))).rejects.toMatchObject({ name: 'KeychainError', kind: 'untrusted' })
    for (const error of [addonError('no-reply'), addonError('interrupted'), addonError('invalid'), addonError('cancelled'), addonError('toString'), new Error('x'), 'timeout', null]) {
      await expect(failing(error), String(error)).rejects.toMatchObject({ name: 'KeychainError', kind: 'helper' })
    }
  })

  it('refuses an answer too long or not JSON', async () => {
    const request: HelperRequest = { command: 'delete', service, account: KEYCHAIN_ACCOUNT }
    await expect(helperRunner(fakeTransport(`{"ok":true,"pad":"${'a'.repeat(5000)}"}`).transport)(request, 1000)).rejects.toMatchObject({ kind: 'helper' })
    await expect(helperRunner(fakeTransport('not json').transport)(request, 1000)).rejects.toMatchObject({ kind: 'helper' })
    await expect(helperRunner(fakeTransport(async () => 42 as unknown as string).transport)(request, 1000)).rejects.toMatchObject({ kind: 'helper' })
  })
})

describe('the transport of the built application', () => {
  it('is there with the helper, the addon and a team: the requests go to the addon', async () => {
    const addon = fakeAddon(true, async () => '{"ok":true,"deleted":false}')
    const load = vi.fn(() => addon)
    const resources = builtApp({ helper: true, addon: true })
    const transport = keychainTransport(resources, load)
    expect(load).toHaveBeenCalledWith(join(resources, KEYCHAIN_ADDON))
    expect(await transport!('{"command":"delete"}', 1500)).toBe('{"ok":true,"deleted":false}')
    expect(addon.sendRequest).toHaveBeenCalledWith('{"command":"delete"}', 1500)
  })

  it('is not there without the helper or the addon (nothing is loaded), when the addon does not load, or without a team', () => {
    const load = vi.fn(() => fakeAddon())
    expect(keychainTransport(builtApp({ helper: false, addon: true }), load)).toBeNull()
    rmSync(join(dir, 'Lucium.app'), { recursive: true })
    expect(keychainTransport(builtApp({ helper: true, addon: false }), load)).toBeNull()
    expect(load).not.toHaveBeenCalled()
    rmSync(join(dir, 'Lucium.app'), { recursive: true })
    const resources = builtApp({ helper: true, addon: true })
    expect(keychainTransport(resources, () => { throw new Error('dlopen failed') })).toBeNull()
    expect(logged.join('\n')).toContain('the keychain addon could not be loaded')
    // An application signed ad hoc has no team: the addon would send nothing, Touch ID is said unavailable.
    const adHoc = fakeAddon(false)
    expect(keychainTransport(resources, () => adHoc)).toBeNull()
    expect(adHoc.sendRequest).not.toHaveBeenCalled()
  })

  it('cancels the requests still waiting when the application quits: they fail as "helper", nothing waits for the time limit', async () => {
    let cancel: (error: Error) => void = () => undefined
    const addon = fakeAddon(true, () => new Promise<string>((_resolve, reject) => void (cancel = reject)))
    addon.cancelAll.mockImplementation(() => cancel(addonError('cancelled')))
    const transport = keychainTransport(builtApp({ helper: true, addon: true }), () => addon)
    const pending = helperRunner(transport!)({ command: 'delete', service, account: KEYCHAIN_ACCOUNT }, 60_000)
    stopKeychainHelpers()
    await expect(pending).rejects.toMatchObject({ kind: 'helper' })
    expect(addon.cancelAll).toHaveBeenCalled()
  })

  // That the main process asks for it only in the built application, outside the engine test, and cancels its requests at quit: shell/password-wiring.test.ts.

  it('finds the helper in Contents/XPCServices of the built application and the addon in its Contents/Resources, outside app.asar', () => {
    expect(keychainPaths('/Applications/Lucium.app/Contents/Resources')).toEqual({
      helper: '/Applications/Lucium.app/Contents/XPCServices/LuciumKeychain.xpc',
      addon: '/Applications/Lucium.app/Contents/Resources/vault-xpc.node'
    })
  })

  it('loads only a file that is the addon: a library of something else is refused', () => {
    writeFileSync(join(dir, 'not-an-addon.node'), 'text')
    expect(() => loadKeychainAddon(join(dir, 'not-an-addon.node'))).toThrow()
    const exporting = (exports: unknown) => (module: { exports: unknown }) => void (module.exports = exports)
    const fn = () => undefined
    for (const exports of [{}, { sendRequest: fn, cancelAll: fn }, { sendRequest: fn, cancelAll: fn, trusted: true }, null]) {
      expect(() => loadKeychainAddon('/x/vault-xpc.node', exporting(exports)), JSON.stringify(exports)).toThrow('not the keychain addon')
    }
    const addon = { sendRequest: fn, cancelAll: fn, trusted: fn }
    expect(loadKeychainAddon('/x/vault-xpc.node', exporting(addon))).toBe(addon)
  })

  // The real addon, once `native/vault-xpc/build.sh` has built it: it refuses what is not a request, and sends nothing for a process without a
  // team (this Node, signed ad hoc), or finds no helper in a process that carries none (a Node signed by a team).
  const built = fileURLToPath(new URL('../../out-native/vault-xpc.node', import.meta.url))
  it.runIf(process.platform === 'darwin' && process.arch === 'arm64' && existsSync(built))('is the real addon: it checks what it is given, and sends nothing without a team', async () => {
    const addon = loadKeychainAddon(built)
    for (const [request, timeout] of [['', 1000], ['x'.repeat(16 * 1024 + 1), 1000], ['{}', 0], ['{}', 11 * 60_000], [42, 1000]] as const) {
      await expect(addon.sendRequest(request as string, timeout), `${String(request).slice(0, 10)} ${timeout}`).rejects.toMatchObject({ code: 'invalid' })
    }
    await expect(addon.sendRequest('{}', 1000)).rejects.toMatchObject({ code: addon.trusted() ? 'no-reply' : 'untrusted' })
    expect(() => addon.cancelAll()).not.toThrow()
  })
})

describe('the keychain of the vault', () => {
  it('stores the key behind Touch ID and writes a record (0600) that holds no secret', async () => {
    const { keychain: k, recordPath, helper } = keychain()
    expect(k.enabled()).toBe(false)
    await k.enable(MATERIAL, SALT)
    expect(k.enabled()).toBe(true)
    expect(helper!.items.get(`${service}/${KEYCHAIN_ACCOUNT}`)).toBe(KEY_B64)
    const record = readFileSync(recordPath, 'utf8')
    expect(statSync(recordPath).mode & 0o777).toBe(0o600)
    expect(record).not.toContain(KEY_B64)
    expect(record).not.toContain(KEY_HEX)
    expect(JSON.parse(record)).toEqual({ v: 1, service, account: KEYCHAIN_ACCOUNT, salt: SALT.toString('base64'), state: 'ZmluZ2Vycw==' })
  })

  it('gives the key back only after a matching fingerprint, naming the reason and the language (never a text) and the mark of the fingers', async () => {
    const { keychain: k, helper } = keychain()
    await k.enable(MATERIAL, SALT)
    expect((await k.load(LANGUAGE, SALT)).equals(MATERIAL)).toBe(true)
    expect(helper!.requests.at(-1)).toEqual({ command: 'load', service, account: KEYCHAIN_ACCOUNT, reason: 'open-vault', language: LANGUAGE, state: 'ZmluZ2Vycw==' })
    expect((await k.load('en', SALT)).equals(MATERIAL)).toBe(true)
    expect(helper!.requests.at(-1)).toMatchObject({ reason: 'open-vault', language: 'en' })
    helper!.leak = true
    for (const [biometry, kind] of [['cancel', 'cancelled'], ['fail', 'failed'], ['unavailable', 'unavailable'], ['not-entitled', 'not-entitled'], ['other-fingers', 'biometry-changed']] as const) {
      helper!.biometry = biometry
      await expect(k.load(LANGUAGE, SALT), biometry).rejects.toMatchObject({ name: 'KeychainError', kind })
    }
  })

  it('does not ask for a fingerprint for a key of another salt, nor in a language the helper has no words for, nor with Touch ID off', async () => {
    const { keychain: k, helper } = keychain()
    await expect(k.load(LANGUAGE, SALT)).rejects.toMatchObject({ kind: 'not-found' })
    await k.enable(MATERIAL, SALT)
    const before = helper!.requests.length
    await expect(k.load(LANGUAGE, OTHER_SALT)).rejects.toMatchObject({ kind: 'stale' })
    for (const text of ['ouvrir le coffre de mots de passe', '  ', 'de']) await expect(k.load(text as never, SALT), text).rejects.toMatchObject({ kind: 'invalid' })
    expect(helper!.requests.length).toBe(before)
  })

  it('turning it off deletes the item from the keychain, then the record', async () => {
    const { keychain: k, recordPath, helper } = keychain()
    await k.enable(MATERIAL, SALT)
    await k.disable()
    expect(helper!.requests.at(-1)).toEqual({ command: 'delete', service, account: KEYCHAIN_ACCOUNT })
    expect(helper!.items.size).toBe(0)
    expect(existsSync(recordPath)).toBe(false)
    expect(k.enabled()).toBe(false)
  })

  it('keeps Touch ID on when the keychain cannot delete the item; `forget` takes the record away all the same and says why', async () => {
    const { keychain: k, recordPath, helper } = keychain()
    await k.enable(MATERIAL, SALT)
    helper!.deleteFails = true
    await expect(k.disable()).rejects.toMatchObject({ kind: 'error', status: -50 })
    expect(existsSync(recordPath)).toBe(true)
    const failure = await k.forget()
    expect(failure).toBeInstanceOf(KeychainError)
    expect(failure?.kind).toBe('error')
    expect(existsSync(recordPath)).toBe(false)
  })

  it('refuses to turn on without a helper or with a key of another size, and writes no record when the keychain refuses', async () => {
    await expect(keychain(null).keychain.enable(MATERIAL, SALT)).rejects.toMatchObject({ kind: 'unavailable' })
    const { keychain: k, recordPath, helper } = keychain()
    await expect(k.enable(MATERIAL.subarray(0, 32), SALT)).rejects.toMatchObject({ kind: 'invalid' })
    helper!.biometry = 'not-entitled'
    await expect(k.enable(MATERIAL, SALT)).rejects.toMatchObject({ kind: 'not-entitled', status: -34018 })
    expect(existsSync(recordPath)).toBe(false)
  })

  it('looks for the helper at its first use only, and is available only with a helper and a system that can ask', () => {
    const { keychain: k, runner } = keychain()
    expect(runner).not.toHaveBeenCalled()
    expect(k.available()).toBe(true)
    expect(k.available()).toBe(true)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(keychain(null).keychain.available()).toBe(false)
    expect(keychain(null).keychain.installed()).toBe(false)
    // A system that cannot ask now (the lid closed, no sensor): the helper is there all the same.
    const notNow = keychain(new SimulatedHelper(), false).keychain
    expect(notNow.available()).toBe(false)
    expect(notNow.installed()).toBe(true)
  })

  it('counts a damaged or hand-made record as off', () => {
    const { keychain: k, recordPath } = keychain()
    for (const text of ['{', JSON.stringify({ v: 1, service: 'com.other.app', account: KEYCHAIN_ACCOUNT, salt: SALT.toString('base64'), state: null }), JSON.stringify({ v: 2 }), 'x'.repeat(5000)]) {
      writeFileSync(recordPath, text)
      expect(k.enabled(), text.slice(0, 40)).toBe(false)
    }
  })

  it('never logs the key', async () => {
    const { keychain: k, helper } = keychain()
    await k.enable(MATERIAL, SALT)
    await k.load(LANGUAGE, SALT)
    helper!.leak = true
    helper!.biometry = 'cancel'
    await k.load(LANGUAGE, SALT).catch(() => undefined)
    await k.disable()
    writeFileSync(join(dir, 'passwords.vault.touchid'), '{')
    k.enabled()
    expect(logged.join('\n')).not.toContain(KEY_B64)
    expect(logged.join('\n')).not.toContain(KEY_HEX)
  })
})

describe('where the item is', () => {
  it('names one service per data folder, under the prefix the helper accepts', () => {
    const a = keychainServiceFor('/Users/ana/Library/Application Support/Lucium/passwords.vault')
    const b = keychainServiceFor('/Users/ana/Library/Application Support/Lucium DRM/passwords.vault')
    expect(a).not.toBe(b)
    expect(a).toBe(keychainServiceFor('/Users/ana/Library/Application Support/Lucium/../Lucium/passwords.vault'))
    for (const name of [a, b]) {
      expect(name.startsWith(KEYCHAIN_SERVICE_PREFIX)).toBe(true)
      expect(name).toMatch(/^app\.lucium\.browser\.[A-Za-z0-9.-]{1,120}$/)
    }
    expect(() => new VaultKeychain({ recordPath: join(dir, 'r'), service: 'com.apple.account', runner: () => null, canPrompt: () => true })).toThrow()
  })
})
