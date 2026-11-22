// Touch ID for the vault, from the panel's requests down to the keychain. The helper is
// simulated as main.swift and macOS behave: it keeps what `store` gave it and gives it back to `load` only on a matching fingerprint.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { parsePasswordRequest, type PasswordReply, type PasswordRequest } from '@shared/passwords'
import { getLanguage, setLanguage, t } from '@shared/i18n'
import type { PowerEvent } from '../lock-service'
import { PasswordVault } from '../password-vault'
import { VaultKeychain, helperRunner, keychainServiceFor, type HelperRequest, type HelperRunner, type KeychainTransport } from '../vault-keychain'
import { PasswordService, type ClipboardPort, type PasswordFiles, type PasswordTarget, type PasswordWindow } from './password-service'

const PHRASE = 'une phrase maître assez longue'
const NEXT = 'une autre phrase maître bien longue'
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }
const SITE = 'https://example.com'

type Biometry = 'match' | 'cancel' | 'fail' | 'other-fingers' | 'unavailable' | 'not-entitled'

class SimulatedHelper {
  items = new Map<string, string>()
  biometry: Biometry = 'match'
  /** A careless helper that puts the key in its failure answers too: the service must not open the vault with it. */
  leak = false
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
    if (request.command === 'delete') return { ok: true, deleted: this.items.delete(name) }
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
  loads = () => this.requests.filter((r) => r.command === 'load').length
  /** The helper as the addon reaches it: the JSON of a request in, the JSON of its answer out (vault-keychain.ts `helperRunner` over it). */
  transport: KeychainTransport = async (request) => JSON.stringify(await this.run(JSON.parse(request) as HelperRequest, 0))
}

class FakeWindow implements PasswordWindow {
  toasts: string[] = []
  privateWindow = false
  current: PasswordTarget = { url: `${SITE}/login`, privateTab: false, fill: async () => ({ ok: true, username: true }) }
  isPrivate = () => this.privateWindow
  target = () => this.current
  toast = (message: string) => void this.toasts.push(message)
  openPanel = () => undefined
}

const power = { on: (_event: PowerEvent, _listener: () => void) => undefined, off: (_event: PowerEvent, _listener: () => void) => undefined }
const files: PasswordFiles = { chooseToRead: async () => null, chooseToWrite: async () => null, readText: async () => ({ ok: false, message: '' }), writePrivate: () => undefined }

let dir: string
const logged: string[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-touch-id-'))
  logged.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function setup(options: { feature?: boolean; helper?: SimulatedHelper | null; canPrompt?: boolean; onFill?: boolean } = {}) {
  const settings = { ...defaultSettings(), passwordManager: options.feature ?? true, passwordTouchIdOnFill: options.onFill ?? false }
  const path = join(dir, 'passwords.vault')
  const helper = options.helper === undefined ? new SimulatedHelper() : options.helper
  const keychain = new VaultKeychain({ recordPath: `${path}.touchid`, service: keychainServiceFor(path), runner: () => (helper ? helperRunner(helper.transport) : null), canPrompt: () => options.canPrompt ?? true })
  const vault = new PasswordVault({ path, params: PARAMS })
  const secrets: string[] = []
  const clipboard: ClipboardPort = { readText: async () => '', writeText: async () => undefined, writeSecret: async (text) => void secrets.push(text), clear: () => undefined }
  const service = new PasswordService({ settings: () => settings, vault, power, files, keychain, clipboard })
  const window = new FakeWindow()
  const ask = (request: PasswordRequest): Promise<PasswordReply> => service.handle(request, window)
  return { service, vault, helper: helper!, keychain, window, ask, path, record: `${path}.touchid`, secrets }
}

/** A vault with Touch ID turned on, then locked: the state in which Touch ID is offered. */
async function lockedWithTouchId(s: ReturnType<typeof setup>): Promise<void> {
  expect((await s.ask({ kind: 'create', phrase: PHRASE })).ok).toBe(true)
  expect((await s.ask({ kind: 'touch-id-on', phrase: PHRASE })).ok).toBe(true)
  expect((await s.ask({ kind: 'lock' })).view.vault).toBe('locked')
}

describe('no key of the vault without Touch ID', () => {
  it('opens the vault with the key only after a matching fingerprint; a failure that carries the key anyway leaves it locked', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    s.helper.leak = true
    for (const biometry of ['cancel', 'fail', 'unavailable', 'not-entitled', 'other-fingers'] as const) {
      s.helper.biometry = biometry
      const reply = await s.ask({ kind: 'unlock-touch-id' })
      expect(reply.ok, biometry).toBe(false)
      expect(reply.view.vault, biometry).toBe('locked')
      expect(s.vault.isUnlocked(), biometry).toBe(false)
    }
  })

  it('keeps no key once locked: every Touch ID opening goes through the fingerprint again', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    expect((await s.ask({ kind: 'unlock-touch-id' })).view.vault).toBe('unlocked')
    expect(s.helper.loads()).toBe(1)
    s.service.lock()
    s.helper.biometry = 'cancel'
    expect((await s.ask({ kind: 'unlock-touch-id' })).view.vault).toBe('locked')
    expect(s.helper.loads()).toBe(2)
  })

  it('asks the helper for the prompt in the language of the interface, naming the reason and never a text of its own', async () => {
    const before = getLanguage()
    const s = setup()
    await lockedWithTouchId(s)
    try {
      for (const language of ['fr', 'en'] as const) {
        setLanguage(language)
        s.service.lock()
        expect((await s.ask({ kind: 'unlock-touch-id' })).view.vault).toBe('unlocked')
        const load = s.helper.requests.filter((r) => r.command === 'load').at(-1)
        expect(load).toMatchObject({ command: 'load', reason: 'open-vault', language })
        expect(Object.keys(load!)).not.toContain('text')
      }
    } finally {
      setLanguage(before)
    }
  })
})

describe('the master phrase stays the way in', () => {
  it('a cancelled or refused fingerprint asks for the phrase and keeps Touch ID on', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    for (const biometry of ['cancel', 'fail'] as const) {
      s.helper.biometry = biometry
      const reply = await s.ask({ kind: 'unlock-touch-id' })
      expect(reply.message).toBe(t('pwd-touch.n-a-pas-abouti'))
      expect(reply.view.touchId).toEqual({ available: true, enabled: true, installed: true })
    }
    expect((await s.ask({ kind: 'unlock', phrase: PHRASE })).view.vault).toBe('unlocked')
  })

  it('other fingers enrolled: Touch ID goes off (item and record), the phrase is asked, and it opens the vault', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    s.helper.biometry = 'other-fingers'
    const reply = await s.ask({ kind: 'unlock-touch-id' })
    expect(reply.message).toBe(t('pwd-touch.empreintes-changees'))
    expect(reply.view.touchId.enabled).toBe(false)
    expect(existsSync(s.record)).toBe(false)
    expect(s.helper.items.size).toBe(0)
    expect((await s.ask({ kind: 'unlock', phrase: PHRASE })).view.vault).toBe('unlocked')
  })

  it('no Touch ID at the moment (no fingerprint possible, unsigned build): the phrase is asked and Touch ID stays on for later', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    for (const biometry of ['unavailable', 'not-entitled'] as const) {
      s.helper.biometry = biometry
      const reply = await s.ask({ kind: 'unlock-touch-id' })
      expect(reply.message).toBe(t('pwd-touch.indisponible'))
      expect(reply.view.touchId.enabled).toBe(true)
    }
    expect((await s.ask({ kind: 'unlock', phrase: PHRASE })).view.vault).toBe('unlocked')
  })

  it('a key missing from the keychain, or of another phrase, turns Touch ID off and asks for the phrase', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    s.helper.items.clear()
    const missing = await s.ask({ kind: 'unlock-touch-id' })
    expect(missing.message).toBe(t('pwd-touch.cle-introuvable'))
    expect(missing.view.touchId.enabled).toBe(false)

    // The vault replaced by another one (its own salt): no prompt for a key that cannot open it.
    await s.ask({ kind: 'unlock', phrase: PHRASE })
    await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    s.service.lock()
    const other = new PasswordVault({ path: join(dir, 'other.vault'), params: PARAMS })
    await other.create(NEXT)
    copyFileSync(join(dir, 'other.vault'), s.path)
    const loads = s.helper.loads()
    const stale = await s.ask({ kind: 'unlock-touch-id' })
    expect(stale.message).toBe(t('pwd-touch.cle-perimee'))
    expect(stale.view.touchId.enabled).toBe(false)
    expect(s.helper.loads()).toBe(loads)
    expect((await s.ask({ kind: 'unlock', phrase: NEXT })).view.vault).toBe('unlocked')
  })

  it('a key from the keychain that does not open the file is not used and turns Touch ID off', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    const name = [...s.helper.items.keys()][0]!
    s.helper.items.set(name, Buffer.alloc(64, 1).toString('base64'))
    const reply = await s.ask({ kind: 'unlock-touch-id' })
    expect(reply.view.vault).toBe('locked')
    expect(reply.message).toBe(t('pwd-touch.cle-perimee'))
    expect(reply.view.touchId.enabled).toBe(false)
    expect(s.helper.items.size).toBe(0)
  })

  it('a failed fingerprint does not count as a wrong phrase', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    s.helper.biometry = 'fail'
    for (let i = 0; i < 5; i++) await s.ask({ kind: 'unlock-touch-id' })
    expect((await s.ask({ kind: 'status' })).view.retryInMs).toBe(0)
  })
})

describe('turning Touch ID on and off', () => {
  it('asks for the phrase again, and stores nothing on a wrong one or a locked vault', async () => {
    const s = setup()
    expect((await s.ask({ kind: 'touch-id-on', phrase: PHRASE })).ok).toBe(false)
    await s.ask({ kind: 'create', phrase: PHRASE })
    const wrong = await s.ask({ kind: 'touch-id-on', phrase: 'pas la bonne phrase du tout' })
    expect(wrong.message).toBe(t('pwd-touch.activation-phrase-incorrecte'))
    await s.ask({ kind: 'lock' })
    expect((await s.ask({ kind: 'touch-id-on', phrase: PHRASE })).message).toBe(t('pwd.le-coffre-est-verrouille'))
    expect(s.helper.requests.filter((r) => r.command === 'store')).toEqual([])
    expect(existsSync(s.record)).toBe(false)
  })

  it('counts the wrong phrases of its setup with the others: after three, the right one waits, and no key is stored', async () => {
    const s = setup()
    await s.ask({ kind: 'create', phrase: PHRASE })
    for (let n = 1; n <= 3; n++) expect((await s.ask({ kind: 'touch-id-on', phrase: `pas la bonne phrase numero ${n}` })).message).toBe(t('pwd-touch.activation-phrase-incorrecte'))
    const held = await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    expect(held.ok).toBe(false)
    expect(held.message).toMatch(/Réessayez dans/)
    expect(s.helper.requests.filter((r) => r.command === 'store')).toEqual([])
    expect(existsSync(s.record)).toBe(false)
  })

  it('stores the vault key once the phrase is confirmed, and the panel is told it is on', async () => {
    const s = setup()
    await s.ask({ kind: 'create', phrase: PHRASE })
    const reply = await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    expect(reply.ok).toBe(true)
    expect(reply.message).toBe(t('pwd-touch.active'))
    expect(reply.view.touchId).toEqual({ available: true, enabled: true, installed: true })
    expect(s.helper.items.size).toBe(1)
  })

  it('says why when the keychain refuses (an unsigned build), and stays off', async () => {
    const s = setup()
    await s.ask({ kind: 'create', phrase: PHRASE })
    s.helper.biometry = 'not-entitled'
    const reply = await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    expect(reply.message).toBe(t('pwd-touch.activation-impossible'))
    expect(reply.view.touchId.enabled).toBe(false)
  })

  it('turning it off deletes the item from the keychain, even with the vault locked', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    const reply = await s.ask({ kind: 'touch-id-off' })
    expect(reply.ok).toBe(true)
    expect(reply.message).toBe(t('pwd-touch.desactive'))
    expect(s.helper.requests.at(-1)?.command).toBe('delete')
    expect(s.helper.items.size).toBe(0)
    expect(existsSync(s.record)).toBe(false)
    expect((await s.ask({ kind: 'unlock-touch-id' })).message).toBe(t('pwd-touch.pas-active'))
  })

  it('follows a change of phrase: the new key replaces the old one, which no longer opens anything', async () => {
    const s = setup()
    await s.ask({ kind: 'create', phrase: PHRASE })
    await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    const before = [...s.helper.items.values()][0]
    expect((await s.ask({ kind: 'change-phrase', current: PHRASE, next: NEXT })).message).toBe(t('pwd.phrase-changee'))
    expect([...s.helper.items.values()]).toHaveLength(1)
    expect([...s.helper.items.values()][0]).not.toBe(before)
    await s.ask({ kind: 'lock' })
    expect((await s.ask({ kind: 'unlock-touch-id' })).view.vault).toBe('unlocked')
  })

  it('a change of phrase the keychain cannot follow turns Touch ID off and says so', async () => {
    const s = setup()
    await s.ask({ kind: 'create', phrase: PHRASE })
    await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    s.helper.biometry = 'unavailable'
    expect((await s.ask({ kind: 'change-phrase', current: PHRASE, next: NEXT })).message).toBe(t('pwd-touch.phrase-changee-touch-id-desactive'))
    expect(existsSync(s.record)).toBe(false)
    expect(s.helper.items.size).toBe(0)
  })

  it('deleting the vault deletes its key from the keychain; a new vault does not inherit a record left behind', async () => {
    const s = setup()
    await s.ask({ kind: 'create', phrase: PHRASE })
    await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    expect((await s.ask({ kind: 'destroy', phrase: PHRASE })).ok).toBe(true)
    expect(s.helper.items.size).toBe(0)
    expect(existsSync(s.record)).toBe(false)

    await s.ask({ kind: 'create', phrase: PHRASE })
    await s.ask({ kind: 'touch-id-on', phrase: PHRASE })
    // The vault's file goes by hand; the record stays. A new vault starts without Touch ID.
    rmSync(s.path)
    s.service.lock()
    expect((await s.ask({ kind: 'create', phrase: NEXT })).view.touchId.enabled).toBe(false)
    expect(s.helper.items.size).toBe(0)
  })
})

describe('what Touch ID costs and shows', () => {
  it('with the feature off: refused, the helper never runs', async () => {
    const s = setup({ feature: false })
    for (const request of [{ kind: 'unlock-touch-id' }, { kind: 'touch-id-on', phrase: PHRASE }, { kind: 'touch-id-off' }] as PasswordRequest[]) expect((await s.ask(request)).ok).toBe(false)
    expect(s.helper.requests).toEqual([])
  })

  it('without a helper, or a system that cannot ask: not offered, and the phrase is the way in', async () => {
    for (const s of [setup({ helper: null }), setup({ canPrompt: false })]) {
      const reply = await s.ask({ kind: 'create', phrase: PHRASE })
      expect(reply.view.touchId.available).toBe(false)
    }
  })

  it('tells "not in this build" (no helper) from "not now" (the helper is there, the lid of the Mac closed or no sensor)', async () => {
    const missing = setup({ helper: null })
    expect((await missing.ask({ kind: 'create', phrase: PHRASE })).view.touchId).toMatchObject({ available: false, installed: false })
    expect((await missing.ask({ kind: 'touch-id-on', phrase: PHRASE })).message).toBe(t('pwd-touch.indisponible'))
    expect((await missing.ask({ kind: 'unlock-touch-id' })).message).toBe(t('pwd-touch.indisponible'))
    const notNow = setup({ canPrompt: false })
    expect((await notNow.ask({ kind: 'create', phrase: PHRASE })).view.touchId).toMatchObject({ available: false, installed: true })
    expect((await notNow.ask({ kind: 'touch-id-on', phrase: PHRASE })).message).toBe(t('pwd-touch.pas-maintenant'))
    expect((await notNow.ask({ kind: 'unlock-touch-id' })).message).toBe(t('pwd-touch.pas-maintenant'))
    expect(notNow.helper.requests).toEqual([])
  })

  it('never puts the key in a log, a reply, or any request but the store; nor the phrase anywhere', async () => {
    const s = setup()
    await lockedWithTouchId(s)
    await s.ask({ kind: 'unlock-touch-id' })
    const { material } = await s.vault.keyMaterial(PHRASE)
    const forms = [material.toString('base64'), material.toString('hex'), material.subarray(0, 32).toString('base64'), material.subarray(0, 32).toString('hex')]
    s.service.lock()
    s.helper.leak = true
    for (const biometry of ['cancel', 'other-fingers'] as const) {
      s.helper.biometry = biometry
      await s.ask({ kind: 'unlock-touch-id' })
    }
    const replies = JSON.stringify(await s.ask({ kind: 'status' }))
    for (const form of forms) {
      expect(logged.join('\n')).not.toContain(form)
      expect(replies).not.toContain(form)
    }
    expect(logged.join('\n')).not.toContain(PHRASE)
    for (const request of s.helper.requests) if (request.command !== 'store') expect(JSON.stringify(request)).not.toContain(forms[0]!)
    expect(JSON.stringify(s.helper.requests)).not.toContain(PHRASE)
  })

  it('reads only the requests it knows, with exactly their fields', () => {
    expect(parsePasswordRequest({ kind: 'unlock-touch-id' })).toEqual({ kind: 'unlock-touch-id' })
    expect(parsePasswordRequest({ kind: 'touch-id-off' })).toEqual({ kind: 'touch-id-off' })
    expect(parsePasswordRequest({ kind: 'touch-id-on', phrase: PHRASE })).toEqual({ kind: 'touch-id-on', phrase: PHRASE })
    expect(parsePasswordRequest({ kind: 'touch-id-on' })).toBeNull()
    expect(parsePasswordRequest({ kind: 'unlock-touch-id', key: 'AAAA' })).toBeNull()
    expect(parsePasswordRequest({ kind: 'touch-id-off', service: 'com.apple.account' })).toBeNull()
  })
})

describe('a fingerprint before every fill (passwordTouchIdOnFill)', () => {
  /** An open vault with Touch ID on and one login for the page the window shows; `fills` counts what reached the page. */
  async function withLogin(options: Parameters<typeof setup>[0] = {}) {
    const s = setup(options)
    expect((await s.ask({ kind: 'create', phrase: PHRASE })).ok).toBe(true)
    if (options.helper !== null) expect((await s.ask({ kind: 'touch-id-on', phrase: PHRASE })).ok).toBe(true)
    expect((await s.ask({ kind: 'add', address: SITE, username: 'ana', password: 'k7#Vq2!mZp9x' })).ok).toBe(true)
    const fills: unknown[] = []
    s.window.current = { url: `${SITE}/login`, privateTab: false, fill: async (plan) => (fills.push(plan), { ok: true, username: true }) }
    const id = s.vault.rows()[0]!.id
    return { ...s, fills, id }
  }

  it('is off by default: a fill asks for nothing, as before', async () => {
    const s = await withLogin()
    expect((await s.ask({ kind: 'fill', id: s.id })).ok).toBe(true)
    expect(s.fills).toHaveLength(1)
    expect(s.helper.loads()).toBe(0)
  })

  it('asks the keychain for the fingerprint before the page is touched, every time, and fills after a match', async () => {
    const s = await withLogin({ onFill: true })
    expect((await s.ask({ kind: 'fill', id: s.id })).ok).toBe(true)
    expect((await s.ask({ kind: 'fill', id: s.id })).ok).toBe(true)
    expect(s.helper.loads()).toBe(2)
    expect(s.fills).toHaveLength(2)
  })

  it('fills nothing when the fingerprint is refused, whatever the way it fails, and says so', async () => {
    const s = await withLogin({ onFill: true })
    for (const biometry of ['cancel', 'fail', 'unavailable'] as const) {
      s.helper.biometry = biometry
      const reply = await s.ask({ kind: 'fill', id: s.id })
      expect(reply.ok, biometry).toBe(false)
      expect(reply.message, biometry).toBeTruthy()
    }
    expect(s.fills).toHaveLength(0)
    expect(s.vault.isUnlocked()).toBe(true)
  })

  it('does not ask for a fingerprint for a fill that would be refused anyway (another origin)', async () => {
    const s = await withLogin({ onFill: true })
    s.window.current = { ...s.window.current!, url: 'https://elsewhere.example/' }
    expect((await s.ask({ kind: 'fill', id: s.id })).ok).toBe(false)
    expect(s.helper.loads()).toBe(0)
  })

  it('refuses to fill, rather than fill without it, when Touch ID is not on for the vault', async () => {
    const s = setup({ onFill: true })
    await s.ask({ kind: 'create', phrase: PHRASE })
    await s.ask({ kind: 'add', address: SITE, username: 'ana', password: 'k7#Vq2!mZp9x' })
    const fills: unknown[] = []
    s.window.current = { url: `${SITE}/login`, privateTab: false, fill: async (plan) => (fills.push(plan), { ok: true }) }
    const reply = await s.ask({ kind: 'fill', id: s.vault.rows()[0]!.id })
    expect(reply.ok).toBe(false)
    expect(reply.message).toBe(t('pwd-touch.remplissage-sans-touch-id'))
    expect(fills).toHaveLength(0)
  })

  it('turns Touch ID off when the key is gone, as an opening does, and keeps refusing', async () => {
    const s = await withLogin({ onFill: true })
    s.helper.biometry = 'other-fingers'
    expect((await s.ask({ kind: 'fill', id: s.id })).message).toBe(t('pwd-touch.empreintes-changees'))
    expect(s.keychain.enabled()).toBe(false)
    s.helper.biometry = 'match'
    expect((await s.ask({ kind: 'fill', id: s.id })).message).toBe(t('pwd-touch.remplissage-sans-touch-id'))
    expect(s.fills).toHaveLength(0)
  })

  it('fills nothing when the vault locked while the fingerprint was awaited', async () => {
    const s = await withLogin({ onFill: true })
    let release: () => void = () => undefined
    const original = s.helper.run
    s.helper.run = async (request, ms) => (request.command === 'load' ? (await new Promise<void>((resolve) => (release = resolve)), original(request, ms)) : original(request, ms))
    const pending = s.ask({ kind: 'fill', id: s.id })
    await new Promise((resolve) => setTimeout(resolve, 0))
    s.service.lock()
    release()
    const reply = await pending
    expect(reply.ok).toBe(false)
    expect(reply.message).toBe(t('pwd.le-coffre-est-verrouille'))
    expect(s.fills).toHaveLength(0)
  })

  it('asks the same fingerprint before a password is copied, and copies nothing without it', async () => {
    const s = await withLogin({ onFill: true })
    s.helper.biometry = 'cancel'
    expect((await s.ask({ kind: 'copy-password', id: s.id })).ok).toBe(false)
    expect(s.secrets).toEqual([])
    s.helper.biometry = 'match'
    expect((await s.ask({ kind: 'copy-password', id: s.id })).ok).toBe(true)
    expect(s.secrets).toEqual(['k7#Vq2!mZp9x'])
    expect(s.helper.loads()).toBe(2)
  })

  it('asks one fingerprint at a time', async () => {
    const s = await withLogin({ onFill: true })
    let release: () => void = () => undefined
    const original = s.helper.run
    s.helper.run = async (request, ms) => (request.command === 'load' ? (await new Promise<void>((resolve) => (release = resolve)), original(request, ms)) : original(request, ms))
    const first = s.ask({ kind: 'fill', id: s.id })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await s.ask({ kind: 'fill', id: s.id })
    expect(second.ok).toBe(false)
    expect(second.message).toBe(t('pwd-touch.deja-en-cours'))
    release()
    expect((await first).ok).toBe(true)
    expect(s.fills).toHaveLength(1)
  })
})
