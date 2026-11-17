import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FillPlan } from '@shared/login-form'
import { defaultSettings } from '@shared/model'
import { generatorOptionsOf } from '@shared/password-generator'
import { PASSWORD_LIMITS, type PasswordReply, type PasswordRequest } from '@shared/passwords'
import { PasswordVault, writePrivateFile } from '../password-vault'
import { VAULT_FORMAT, newSealKeys, seal } from '../vault-crypto'
import { t, tp } from '@shared/i18n'
import type { PowerEvent } from '../lock-service'
import { PasswordService, type PasswordFiles, type PasswordTarget, type PasswordWindow } from './password-service'
import { frenchSpaces } from '@shared/french-typography'

const PHRASE = 'une phrase maître assez longue'
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }
const USER = 'ana-the-user@example.com'
const SECRET = 'S3CRET-p4ss-VALUE-9f2'
const SITE = 'https://example.com'

class FakeWindow implements PasswordWindow {
  toasts: Array<{ message: string; action?: { label: string; run: () => void }; durationMs?: number }> = []
  panels = 0
  privateWindow = false
  current: PasswordTarget | null
  fills: FillPlan[] = []
  answer: unknown = { ok: true, username: true }
  constructor(url: string | null = `${SITE}/login`, privateTab = false) {
    this.current = url === null ? null : { url, privateTab, fill: async (plan) => (this.fills.push(plan), this.answer) }
  }
  isPrivate = () => this.privateWindow
  target = () => this.current
  /** The id of the notice showing, as a browser window numbers them (0: none), and the ids taken away. */
  showing = 0
  dismissed: number[] = []
  toast = (message: string, action?: { label: string; run: () => void }, durationMs?: number) => {
    this.toasts.push({ message, action, durationMs })
    return (this.showing = this.toasts.length)
  }
  dismissToast = (id: number) => {
    if (this.showing === id) {
      this.showing = 0
      this.dismissed.push(id)
    }
  }
  openPanel = () => void this.panels++
  at(url: string) {
    this.current = { ...this.current!, url }
    return this
  }
}

class FakePower {
  listeners = new Map<PowerEvent, Set<() => void>>()
  on(event: PowerEvent, listener: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
  }
  off(event: PowerEvent, listener: () => void) {
    this.listeners.get(event)?.delete(listener)
  }
  count = () => [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0)
  emit = (event: PowerEvent) => [...(this.listeners.get(event) ?? [])].forEach((listener) => listener())
}

let dir: string
const logged: string[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-passwords-'))
  skew = 0
  logged.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}:${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

let skew = 0
interface Setup {
  service: PasswordService
  vault: PasswordVault
  power: FakePower
  files: FakeFiles
  settings: ReturnType<typeof defaultSettings>
  path: string
}
class FakeFiles implements PasswordFiles {
  read: string | null = null
  readOutcome: { ok: true; text: string } | { ok: false; message: string } = { ok: true, text: '' }
  written: Array<{ path: string; text: string }> = []
  toRead = vi.fn(async (_kind: 'csv' | 'export'): Promise<string | null> => this.read)
  writeTo: string | null = null
  chooseToRead = (kind: 'csv' | 'export') => this.toRead(kind)
  chooseToWrite = async () => this.writeTo
  readText = vi.fn(async (_path: string, _max: number) => this.readOutcome)
  writePrivate = (path: string, text: string) => {
    this.written.push({ path, text })
    writePrivateFile(path, text)
  }
}

function setup(patch: Partial<ReturnType<typeof defaultSettings>> = { passwordManager: true }, file = 'passwords.vault'): Setup {
  const settings = { ...defaultSettings(), ...patch }
  const path = join(dir, file)
  const vault = new PasswordVault({ path, params: PARAMS })
  const power = new FakePower()
  const files = new FakeFiles()
  const service = new PasswordService({ settings: () => settings, vault, power, files, randomInt: () => 0, now: () => Date.now() + skew })
  return { service, vault, power, files, settings, path }
}

/** The application relaunched: a new vault object and a new service on the same file (what is kept in memory is gone, what is on the disk is not). */
function relaunch(s: Setup): Setup {
  const vault = new PasswordVault({ path: s.path, params: PARAMS })
  const power = new FakePower()
  const files = new FakeFiles()
  const service = new PasswordService({ settings: () => s.settings, vault, power, files, randomInt: () => 0, now: () => Date.now() + skew })
  return { ...s, service, vault, power, files }
}

const ask = (s: Setup, window: FakeWindow, request: PasswordRequest): Promise<PasswordReply> => s.service.handle(request, window)
/** The answer of the panel to the offer it shows now (an offer that is gone has no number: the panel would send the one it last drew). */
const answerTo = (s: Setup, window: FakeWindow, op: 'confirm' | 'dismiss'): PasswordRequest => ({ kind: 'capture', op, offer: s.service.view(window).capture?.offer ?? 1 })
async function withVault(s: Setup, logins: Array<[string, string, string]> = [[SITE, USER, SECRET]]): Promise<void> {
  await s.vault.create(PHRASE)
  for (const [origin, username, password] of logins) await s.vault.save({ origin, username, password })
}
const everything = (...values: unknown[]): string => JSON.stringify(values)
const idOf = (s: Setup, origin: string): string => s.vault.rows().find((row) => row.origin === origin)!.id

describe('with the feature off', () => {
  it('refuses every request, offers nothing, fills nothing and touches no file', async () => {
    const s = setup({ passwordManager: false })
    const window = new FakeWindow()
    for (const request of [{ kind: 'status' }, { kind: 'create', phrase: PHRASE }, { kind: 'unlock', phrase: PHRASE }, { kind: 'generate', options: generatorOptionsOf({}) }, { kind: 'fill-active' }, { kind: 'import-csv' }] as PasswordRequest[]) {
      const reply = await ask(s, window, request)
      expect(reply.ok, request.kind).toBe(false)
      expect(reply.view.enabled).toBe(false)
      expect(reply.password).toBeUndefined()
    }
    expect((await s.service.fillActive(window)).ok).toBe(false)
    expect((await s.service.fillEntry(window, 'a'.repeat(32), true)).ok).toBe(false)
    s.service.submitted(window, { privateTab: false, frameUrl: `${SITE}/login` }, { username: USER, password: SECRET })
    expect(window.toasts.map((t) => t.message)).not.toContain(expect.stringContaining('Enregistrer'))
    expect(window.fills).toEqual([])
    expect(window.panels).toBe(0)
    expect(existsSync(s.path)).toBe(false)
    expect(s.files.toRead).not.toHaveBeenCalled()
  })

  it('owns no timer and no listener', async () => {
    vi.useFakeTimers()
    const s = setup({ passwordManager: false })
    s.service.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(s.power.count()).toBe(0)
  })
})

describe('in a private window or a private tab', () => {
  it('refuses the requests of the panel and tells nothing about the vault', async () => {
    const s = setup()
    await withVault(s)
    const window = new FakeWindow()
    window.privateWindow = true
    for (const request of [{ kind: 'status' }, { kind: 'unlock', phrase: PHRASE }, { kind: 'fill', id: idOf(s, SITE) }, { kind: 'add', address: SITE, username: 'a', password: 'b' }] as PasswordRequest[]) {
      const reply = await ask(s, window, request)
      expect(reply.ok, request.kind).toBe(false)
      expect(reply.view.entries).toEqual([])
      expect(reply.view.vault).toBe('none')
    }
    expect(window.fills).toEqual([])
    expect(s.vault.count()).toBe(1)
  })

  it('fills nothing, in a private window or in a private tab, and says why', async () => {
    const s = setup()
    await withVault(s)
    const id = idOf(s, SITE)
    const inWindow = new FakeWindow()
    inWindow.privateWindow = true
    const inTab = new FakeWindow(`${SITE}/login`, true)
    for (const window of [inWindow, inTab]) {
      expect((await s.service.fillEntry(window, id, true)).ok).toBe(false)
      expect((await s.service.fillActive(window)).ok).toBe(false)
      expect(window.fills).toEqual([])
      expect(window.toasts.at(-1)?.message).toMatch(/privé/)
    }
  })

  it('does not even look at a form submitted there: no notice, nothing kept', async () => {
    const s = setup()
    await withVault(s, [])
    vi.useFakeTimers()
    const inWindow = new FakeWindow()
    inWindow.privateWindow = true
    const inTab = new FakeWindow()
    s.service.submitted(inWindow, { privateTab: false, frameUrl: `${SITE}/login` }, { username: USER, password: SECRET })
    s.service.submitted(inTab, { privateTab: true, frameUrl: `${SITE}/login` }, { username: USER, password: SECRET })
    expect(inWindow.toasts).toEqual([])
    expect(inTab.toasts).toEqual([])
    expect(s.service.view(inTab).capture).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a page whose certificate is not valid and was let through', () => {
  const untrusted = (): FakeWindow => {
    const window = new FakeWindow()
    window.current = { ...window.current!, untrustedCertificate: true }
    return window
  }

  it('is filled with nothing, by the panel as by the shortcut, and says why', async () => {
    const s = setup()
    await withVault(s)
    const window = untrusted()
    const id = idOf(s, SITE)
    const byPanel = await s.service.fillEntry(window, id, true)
    expect(byPanel.ok).toBe(false)
    expect(byPanel.message).toMatch(/certificat n’est pas valide/)
    const byShortcut = await s.service.fillActive(window)
    expect(byShortcut.ok).toBe(false)
    expect(byShortcut.message).toMatch(/certificat n’est pas valide/)
    expect(window.fills).toEqual([])
    // The same entry on the same address, over a valid certificate, is filled.
    const trusted = new FakeWindow()
    expect((await s.service.fillEntry(trusted, id, true)).ok).toBe(true)
    expect(trusted.fills).toHaveLength(1)
  })

  it('is shown as a page that takes no password in the panel', async () => {
    const s = setup()
    await withVault(s)
    const page = s.service.view(untrusted()).page
    expect(page?.fillable).toBe(false)
    expect(page?.reason).toMatch(/certificat n’est pas valide/)
  })

  it('has no form offered to the vault: no notice, nothing kept', async () => {
    const s = setup()
    await withVault(s, [])
    vi.useFakeTimers()
    const window = new FakeWindow()
    s.service.submitted(window, { privateTab: false, frameUrl: `${SITE}/login`, untrustedCertificate: true }, { username: USER, password: SECRET })
    expect(window.toasts).toEqual([])
    expect(s.service.view(window).capture).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still offers the form of a page served over http on a host whose certificate was let through on another port: that page came over none', async () => {
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    s.service.submitted(window, { privateTab: false, frameUrl: 'http://localhost:3000/login', untrustedCertificate: true }, { username: USER, password: SECRET })
    expect(window.toasts).toHaveLength(1)
    expect(s.service.view(window).capture).not.toBeNull()
  })
})

describe('filling', () => {
  it('writes the entry into the page of exactly its origin, with the plan the entry gives', async () => {
    const s = setup()
    await withVault(s)
    const window = new FakeWindow()
    const reply = await ask(s, window, { kind: 'fill', id: idOf(s, SITE) })
    expect(reply.ok).toBe(true)
    expect(window.fills).toEqual([{ origin: SITE, username: USER, password: SECRET }])
  })

  it('never fills a page whose origin is not the entry’s, in any way an address can differ', async () => {
    const s = setup()
    await withVault(s)
    const id = idOf(s, SITE)
    const near = [
      'http://example.com/login',
      'https://example.com:8443/login',
      'https://www.example.com/login',
      'https://example.com.evil.test/login',
      'https://evil-example.com/login',
      'https://sub.example.com/login',
      'https://exаmple.com/login',
      'https://example.org/login',
      'http://localhost:3000/',
      'file:///etc/hosts',
      'about:blank',
      'data:text/html,<form>',
      'javascript:alert(1)',
      'https://evil.test/?https://example.com/',
      'https://example.com@evil.test/login'
    ]
    for (const url of near) {
      const window = new FakeWindow(url)
      const reply = await ask(s, window, { kind: 'fill', id })
      expect(reply.ok, url).toBe(false)
      expect(window.fills, url).toEqual([])
    }
  })

  it('warns, naming both addresses, when the page differs from the entry', async () => {
    const s = setup()
    await withVault(s)
    const window = new FakeWindow('https://example.com.evil.test/login')
    const reply = await ask(s, window, { kind: 'fill', id: idOf(s, SITE) })
    expect(reply.message).toMatch(/rien n’a été rempli/)
    expect(reply.message).toContain('example.com')
    expect(reply.message).toContain('example.com.evil.test')
    expect(reply.message).not.toContain(SECRET)
  })

  it('does not fill while the vault is locked, whoever asks', async () => {
    const s = setup()
    await withVault(s)
    const id = idOf(s, SITE)
    s.service.lock()
    const window = new FakeWindow()
    expect((await ask(s, window, { kind: 'fill', id })).ok).toBe(false)
    expect((await s.service.fillEntry(window, id, true)).ok).toBe(false)
    expect(window.fills).toEqual([])
  })

  it('fills nothing for an id that is not in the vault', async () => {
    const s = setup()
    await withVault(s)
    const window = new FakeWindow()
    const reply = await ask(s, window, { kind: 'fill', id: 'f'.repeat(32) })
    expect(reply.ok).toBe(false)
    expect(window.fills).toEqual([])
  })

  it('says what the page said when it did not fill (a frame, a changed page, a registration form), and when it did not answer', async () => {
    const s = setup()
    await withVault(s)
    const id = idOf(s, SITE)
    const window = new FakeWindow()
    for (const answer of [{ ok: false, reason: 'frame' }, { ok: false, reason: 'origin' }, { ok: false, reason: 'not-login' }, { ok: false, reason: 'action' }, { ok: false, reason: 'no-form' }]) {
      window.answer = answer
      const reply = await s.service.fillEntry(window, id, true)
      expect(reply.ok, JSON.stringify(answer)).toBe(false)
      expect(window.toasts.at(-1)?.message).toBe(reply.message)
    }
    window.answer = 'whatever'
    expect((await s.service.fillEntry(window, id, true)).message).toMatch(/rien n’a été rempli/)
    window.current = { url: `${SITE}/login`, privateTab: false, fill: async () => Promise.reject(new Error(`boom ${SECRET}`)) }
    expect((await s.service.fillEntry(window, id, true)).ok).toBe(false)
    expect(logged.join('\n')).not.toContain(SECRET)
    expect(logged.some((line) => line.includes('the page could not be filled'))).toBe(true)
  })

  it('fills at once when the page has one entry, asks in the panel when it has several or when the vault is locked, and says so when it has none', async () => {
    const s = setup()
    await withVault(s, [[SITE, USER, SECRET], [SITE, 'second', 'pw2'], ['https://other.example', 'x', 'y']])
    const window = new FakeWindow()
    await s.service.fillActive(window)
    expect(window.fills).toEqual([])
    expect(window.panels).toBe(1)
    const one = new FakeWindow('https://other.example/')
    await s.service.fillActive(one)
    expect(one.fills).toEqual([{ origin: 'https://other.example', username: 'x', password: 'y' }])
    const none = new FakeWindow('https://nothing.example/')
    await s.service.fillActive(none)
    expect(none.fills).toEqual([])
    expect(none.toasts.at(-1)?.message).toBe('Aucun mot de passe enregistré pour nothing.example.')
    s.service.lock()
    const locked = new FakeWindow()
    await s.service.fillActive(locked)
    expect(locked.panels).toBe(1)
    expect(locked.fills).toEqual([])
  })

  it('warns when an entry exists for a neighbouring address and fills nothing', async () => {
    const s = setup()
    await withVault(s)
    for (const url of ['http://example.com/login', 'https://example.com:8443/', 'https://login.example.com/']) {
      const window = new FakeWindow(url)
      await s.service.fillActive(window)
      expect(window.fills, url).toEqual([])
      expect(window.toasts.at(-1)?.message, url).toMatch(/Un identifiant existe pour example\.com\u00a0: l’adresse diffère/)
      expect(window.toasts.at(-1)?.message, url).toMatch(/rien n’a été rempli/)
    }
  })

  it('refuses a page that cannot hold a password at all', async () => {
    const s = setup()
    await withVault(s)
    for (const url of ['http://remote.test/', 'about:blank', 'file:///x']) {
      const window = new FakeWindow(url)
      await s.service.fillActive(window)
      expect(window.fills).toEqual([])
      expect(window.toasts.at(-1)?.message).toMatch(/n’accepte pas/)
    }
    const empty = new FakeWindow(null)
    await s.service.fillActive(empty)
    expect(empty.toasts.at(-1)?.message).toBe('Aucune page à remplir.')
  })
})

describe('what the interface is told', () => {
  it('holds no password and no phrase, in any reply of any request', async () => {
    const s = setup()
    const window = new FakeWindow()
    const replies: PasswordReply[] = []
    replies.push(await ask(s, window, { kind: 'create', phrase: PHRASE }))
    replies.push(await ask(s, window, { kind: 'add', address: SITE, username: USER, password: SECRET }))
    replies.push(await ask(s, window, { kind: 'status' }))
    replies.push(await ask(s, window, { kind: 'fill', id: idOf(s, SITE) }))
    s.service.submitted(window, { privateTab: false, frameUrl: `${SITE}/login` }, { username: 'other', password: 'CAPTURED-SECRET' })
    replies.push(await ask(s, window, { kind: 'status' }))
    replies.push(await ask(s, window, { kind: 'change-phrase', current: PHRASE, next: 'a brand new long phrase' }))
    replies.push(await ask(s, window, { kind: 'lock' }))
    replies.push(await ask(s, window, { kind: 'unlock', phrase: 'a wrong phrase of length' }))
    replies.push(await ask(s, window, { kind: 'unlock', phrase: 'a brand new long phrase' }))
    skew += 5000
    s.service.submitted(window, { privateTab: false, frameUrl: `${SITE}/login` }, { username: 'other', password: 'CAPTURED-SECRET-2' })
    replies.push(await ask(s, window, { kind: 'status' }))
    replies.push(await ask(s, window, answerTo(s, window, 'confirm')))
    const text = everything(replies, window.toasts.map((t) => t.message))
    for (const secret of [SECRET, 'CAPTURED-SECRET', 'CAPTURED-SECRET-2', PHRASE, 'a brand new long phrase', 'a wrong phrase of length']) expect(text, secret).not.toContain(secret)
    expect(replies.at(-1)!.view.entries.map((row) => row.username).sort()).toEqual(['ana-the-user@example.com', 'other'])
  })

  it('has the entries only while the vault is open', async () => {
    const s = setup()
    await withVault(s)
    const window = new FakeWindow()
    expect(s.service.view(window)).toMatchObject({ enabled: true, vault: 'unlocked' })
    expect(s.service.view(window).entries).toHaveLength(1)
    s.service.lock()
    expect(s.service.view(window)).toMatchObject({ vault: 'locked', entries: [], page: { matching: [] } })
  })

  it('says which entries match the page on screen, exactly', async () => {
    const s = setup()
    await withVault(s, [[SITE, USER, SECRET], ['https://example.com:8443', 'port', 'pw']])
    const view = s.service.view(new FakeWindow(`${SITE}/login`))
    expect(view.page).toMatchObject({ host: 'example.com', fillable: true, matching: [idOf(s, SITE)] })
    expect(s.service.view(new FakeWindow('http://example.com/')).page).toMatchObject({ host: null, fillable: false, matching: [] })
    expect(s.service.view(new FakeWindow(`${SITE}/`, true)).page?.fillable).toBe(false)
  })
})

describe('logs', () => {
  it('never hold an identifier, a password, a phrase or an address, whatever failed', async () => {
    const s = setup()
    const window = new FakeWindow()
    await ask(s, window, { kind: 'create', phrase: PHRASE })
    await ask(s, window, { kind: 'add', address: SITE, username: USER, password: SECRET })
    await ask(s, window, { kind: 'unlock', phrase: 'WRONG-PHRASE-TRIED-1' })
    await ask(s, window, { kind: 'lock' })
    await ask(s, window, { kind: 'unlock', phrase: 'WRONG-PHRASE-TRIED-2' })
    await ask(s, window, { kind: 'unlock', phrase: PHRASE })
    // A failed write, a CSV that is refused, an export with a bad phrase, a file that does not open.
    s.files.read = join(dir, 'x.csv')
    s.files.readOutcome = { ok: true, text: `url,username,password\n${SITE},${USER},${SECRET}\n"unclosed` }
    await ask(s, window, { kind: 'import-csv' })
    s.files.readOutcome = { ok: true, text: JSON.stringify({ format: 'lucium-passwords-export', version: 1 }) }
    await ask(s, window, { kind: 'import-export', phrase: 'WRONG-EXPORT-PHRASE' })
    rmSync(dir, { recursive: true, force: true })
    await ask(s, window, { kind: 'add', address: 'https://second.example', username: 'LOGGED-USER', password: 'LOGGED-PASSWORD' })
    const text = logged.join('\n')
    for (const value of [USER, SECRET, PHRASE, 'WRONG-PHRASE', 'WRONG-EXPORT', 'LOGGED-USER', 'LOGGED-PASSWORD', 'example.com', 'second.example']) expect(text, value).not.toContain(value)
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('the phrase', () => {
  it('slows the answers down after three wrong ones, and then does not try the vault at all', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s)
    s.service.lock()
    const window = new FakeWindow()
    const spy = vi.spyOn(s.vault, 'unlock')
    for (let n = 1; n <= 3; n++) expect((await ask(s, window, { kind: 'unlock', phrase: `wrong phrase number ${n}` })).message).toMatch(/incorrecte/)
    const blocked = await ask(s, window, { kind: 'unlock', phrase: PHRASE })
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toMatch(/Réessayez dans/)
    expect(blocked.view.retryInMs).toBeGreaterThan(0)
    expect(spy).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2000)
    expect((await ask(s, window, { kind: 'unlock', phrase: PHRASE })).ok).toBe(true)
    expect(spy).toHaveBeenCalledTimes(4)
  })

  it('keeps its wait when the feature is switched off and on again: that is not another round of tries', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s)
    s.service.lock()
    const window = new FakeWindow()
    for (let n = 1; n <= 3; n++) await ask(s, window, { kind: 'unlock', phrase: `wrong phrase number ${n}` })
    // The gate of the feature goes off and on (a settings/update): the service is stopped, the wait stays.
    s.service.stop()
    const spy = vi.spyOn(s.vault, 'unlock')
    const blocked = await ask(s, window, { kind: 'unlock', phrase: PHRASE })
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toMatch(/Réessayez dans/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not give three fresh tries to a relaunched application: the wait is on the disk, and the panel shows it', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s)
    s.service.lock()
    const window = new FakeWindow()
    for (let n = 1; n <= 3; n++) await ask(s, window, { kind: 'unlock', phrase: `wrong phrase number ${n}` })
    const again = relaunch(s)
    const spy = vi.spyOn(again.vault, 'unlock')
    const blocked = await ask(again, window, { kind: 'unlock', phrase: PHRASE })
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toMatch(/Réessayez dans/)
    expect(blocked.view.retryInMs).toBeGreaterThan(0)
    expect((await ask(again, window, { kind: 'status' })).view.retryInMs).toBeGreaterThan(0)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect((await ask(again, window, { kind: 'unlock', phrase: PHRASE })).ok).toBe(true)
  })

  it('holds back the change of phrase and the deletion of the vault after wrong phrases, the right one included, and says when to retry', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s)
    const window = new FakeWindow()
    for (let n = 1; n <= 3; n++) expect((await ask(s, window, { kind: 'change-phrase', current: `wrong phrase number ${n}`, next: 'a brand new long phrase' })).message).toMatch(/actuelle est incorrecte/)
    for (const request of [{ kind: 'change-phrase', current: PHRASE, next: 'a brand new long phrase' }, { kind: 'destroy', phrase: PHRASE }] as PasswordRequest[]) {
      const reply = await ask(s, window, request)
      expect(reply.ok, request.kind).toBe(false)
      expect(reply.message, request.kind).toMatch(/Réessayez dans/)
    }
    expect(existsSync(s.path)).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect((await ask(s, window, { kind: 'change-phrase', current: PHRASE, next: 'a brand new long phrase' })).ok).toBe(true)
  })

  it('says how many logins the opening left out, and that the file was kept', async () => {
    const s = setup()
    const keys = await newSealKeys(PHRASE, { params: PARAMS })
    const good = { id: 'a'.repeat(32), origin: SITE, username: USER, password: SECRET, createdAt: 1, updatedAt: 1 }
    const refused = { ...good, id: 'b'.repeat(32), origin: 'http://remote.test' }
    writeFileSync(s.path, seal(VAULT_FORMAT, JSON.stringify({ v: 1, entries: [good, refused] }), keys))
    const reply = await ask(s, new FakeWindow(), { kind: 'unlock', phrase: PHRASE })
    expect(reply.ok).toBe(true)
    expect(reply.message).toBe(tp('pwd.coffre-deverrouille-identifiants-ecartes', 1))
    expect(reply.view.vault).toBe('unlocked')
    // Once the vault is written again, its file holds only what this version keeps: the next opening says only that it is open.
    await s.vault.save({ origin: SITE, username: 'other', password: 'x' })
    s.service.lock()
    expect((await ask(s, new FakeWindow(), { kind: 'unlock', phrase: PHRASE })).message).toBe(t('pwd.coffre-deverrouille'))
  })

  it('has to be long enough for a vault and for a change, and is asked for again to change it or to delete the vault', async () => {
    const s = setup()
    const window = new FakeWindow()
    expect((await ask(s, window, { kind: 'create', phrase: 'too short' })).message).toMatch(/au moins 12/)
    expect(existsSync(s.path)).toBe(false)
    await ask(s, window, { kind: 'create', phrase: PHRASE })
    expect((await ask(s, window, { kind: 'change-phrase', current: 'not the one at all', next: 'a brand new long phrase' })).message).toMatch(/actuelle est incorrecte/)
    expect((await ask(s, window, { kind: 'change-phrase', current: PHRASE, next: 'short' })).ok).toBe(false)
    expect((await ask(s, window, { kind: 'destroy', phrase: 'not the one at all' })).ok).toBe(false)
    expect(existsSync(s.path)).toBe(true)
    expect((await ask(s, window, { kind: 'destroy', phrase: PHRASE })).view.vault).toBe('none')
    expect(existsSync(s.path)).toBe(false)
  })
})

describe('time and power', () => {
  it('locks after ten minutes of no use, and every use starts the ten minutes again', async () => {
    vi.useFakeTimers()
    const s = setup()
    const window = new FakeWindow()
    await ask(s, window, { kind: 'create', phrase: PHRASE })
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.autoLockMs - 1000)
    expect(s.vault.isUnlocked()).toBe(true)
    await ask(s, window, { kind: 'add', address: SITE, username: USER, password: SECRET })
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.autoLockMs - 1000)
    expect(s.vault.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(s.vault.isUnlocked()).toBe(false)
  })

  it('locks when the Mac sleeps or locks its screen, and listens only while the vault is open', async () => {
    vi.useFakeTimers()
    const s = setup()
    const window = new FakeWindow()
    expect(s.power.count()).toBe(0)
    await ask(s, window, { kind: 'create', phrase: PHRASE })
    expect(s.power.count()).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(1)
    s.power.emit('suspend')
    expect(s.vault.isUnlocked()).toBe(false)
    expect(s.power.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await ask(s, window, { kind: 'unlock', phrase: PHRASE })
    s.power.emit('lock-screen')
    expect(s.vault.isUnlocked()).toBe(false)
  })

  it('locks and forgets the waiting logins when the feature goes off', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    s.service.submitted(window, { privateTab: false, frameUrl: `${SITE}/login` }, { username: USER, password: SECRET })
    expect(s.service.view(window).capture).not.toBeNull()
    s.service.stop()
    expect(s.vault.isUnlocked()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(s.power.count()).toBe(0)
  })
})

describe('a login seen on a page', () => {
  const submit = (s: Setup, window: FakeWindow, patch: Partial<{ username: string; password: string; frameUrl: string; privateTab: boolean }> = {}) =>
    s.service.submitted(window, { privateTab: patch.privateTab ?? false, frameUrl: patch.frameUrl ?? `${SITE}/login` }, { username: patch.username ?? USER, password: patch.password ?? SECRET })

  it('is forgotten with the window that was offered it, not three minutes later', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    const other = new FakeWindow()
    submit(s, window)
    submit(s, other, { username: 'someone-else' })
    s.service.forgetWindow(window)
    expect(s.service.view(window).capture).toBeNull()
    expect(s.service.view(other).capture).not.toBeNull()
    expect((await ask(s, window, answerTo(s, window, 'confirm'))).ok).toBe(false)
  })

  it('is offered by a notice that names the site and nothing of the login, and is written only when the user says so', async () => {
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    submit(s, window)
    expect(window.toasts).toHaveLength(1)
    expect(window.toasts[0]!.message).toBe(frenchSpaces('Enregistrer le mot de passe pour example.com ?'))
    expect(window.toasts[0]!.message).not.toContain(USER)
    // Whatever would write it would have done so by now.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(s.vault.count()).toBe(0)
    expect(s.service.view(window).capture).toEqual({ kind: 'new', host: 'example.com', username: USER, offer: 1 })
    expect(everything(s.service.view(window))).not.toContain(SECRET)
    window.toasts[0]!.action!.run()
    expect(window.panels).toBe(1)
    expect(s.vault.count()).toBe(0)
    const saved = await ask(s, window, answerTo(s, window, 'confirm'))
    expect(saved.ok).toBe(true)
    expect(s.vault.count()).toBe(1)
    expect(s.vault.secret(idOf(s, SITE))?.password).toBe(SECRET)
    expect(saved.view.capture).toBeNull()
  })

  it('takes its origin from the frame the browser knows, and only if a password may be kept there', async () => {
    const s = setup()
    await withVault(s, [])
    for (const frameUrl of ['http://example.com/login', 'about:blank', 'file:///x', 'chrome-extension://abc/x.html', '', 'javascript:1']) {
      const window = new FakeWindow()
      submit(s, window, { frameUrl })
      expect(window.toasts, frameUrl).toEqual([])
      expect(s.service.view(window).capture, frameUrl).toBeNull()
    }
    const window = new FakeWindow()
    submit(s, window, { frameUrl: 'http://localhost:3000/login' })
    expect(s.service.view(window).capture?.host).toBe('localhost:3000')
  })

  it('offers an update for a known username with another password, and nothing for one it has', async () => {
    const s = setup()
    await withVault(s)
    const same = new FakeWindow()
    submit(s, same)
    expect(same.toasts).toEqual([])
    const changed = new FakeWindow()
    submit(s, changed, { password: 'a new password' })
    expect(s.service.view(changed).capture).toMatchObject({ kind: 'update' })
    await ask(s, changed, answerTo(s, changed, 'confirm'))
    expect(s.vault.secret(idOf(s, SITE))?.password).toBe('a new password')
    expect(s.vault.count()).toBe(1)
  })

  it('waits for the phrase when the vault is locked, and keeps the login for it', async () => {
    const s = setup()
    await withVault(s, [])
    s.service.lock()
    const window = new FakeWindow()
    submit(s, window)
    expect(window.toasts).toHaveLength(1)
    const refused = await ask(s, window, answerTo(s, window, 'confirm'))
    expect(refused.ok).toBe(false)
    await ask(s, window, { kind: 'unlock', phrase: PHRASE })
    expect((await ask(s, window, answerTo(s, window, 'confirm'))).ok).toBe(true)
    expect(s.vault.count()).toBe(1)
  })

  it('is forgotten after three minutes, when refused, and when the vault locks', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    submit(s, window)
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.captureTtlMs + 1)
    expect(s.service.view(window).capture).toBeNull()
    expect((await ask(s, window, answerTo(s, window, 'confirm'))).ok).toBe(false)
    await vi.advanceTimersByTimeAsync(1600)
    submit(s, window)
    await ask(s, window, answerTo(s, window, 'dismiss'))
    expect(s.service.view(window).capture).toBeNull()
    expect(s.vault.count()).toBe(0)
    await vi.advanceTimersByTimeAsync(1600)
    submit(s, window)
    s.service.lock()
    expect(s.service.view(window).capture).toBeNull()
  })

  it('saves nothing when the login on offer changed between what the panel showed and the click', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    submit(s, window)
    // What the panel drew, and what its buttons will send.
    const shown = s.service.view(window).capture!
    await vi.advanceTimersByTimeAsync(1600)
    // A form submitted in another tab of the window takes the place of the offer.
    submit(s, window, { frameUrl: 'https://autre.example/login', username: 'intrus', password: 'autre-secret' })
    const refused = await ask(s, window, { kind: 'capture', op: 'confirm', offer: shown.offer })
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe(frenchSpaces('Un autre identifiant vient d’être proposé à la place : vérifiez-le avant de l’enregistrer.'))
    expect(s.vault.count()).toBe(0)
    // The reply shows the login that is on offer now, under its own number; « Ignorer » sent for the first one leaves it there.
    expect(refused.view.capture).toMatchObject({ host: 'autre.example', username: 'intrus' })
    expect(refused.view.capture!.offer).not.toBe(shown.offer)
    expect((await ask(s, window, { kind: 'capture', op: 'dismiss', offer: shown.offer })).view.capture).toMatchObject({ host: 'autre.example' })
    // Answered for what it is, it is saved.
    expect((await ask(s, window, answerTo(s, window, 'confirm'))).ok).toBe(true)
    expect(s.vault.rows().map((row) => row.origin)).toEqual(['https://autre.example'])
  })

  it('keeps one login per window and does not offer again within a moment', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    submit(s, window, { username: 'first' })
    submit(s, window, { username: 'burst' })
    expect(window.toasts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1600)
    submit(s, window, { username: 'second' })
    expect(window.toasts).toHaveLength(2)
    expect(s.service.view(window).capture?.username).toBe('second')
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2)
  })

  it('takes its notice away with it: once answered, refused, expired or forgotten, nothing on screen offers what no longer exists', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s, [])
    const answered = new FakeWindow()
    submit(s, answered)
    expect(answered.showing).toBe(1)
    await ask(s, answered, answerTo(s, answered, 'confirm'))
    expect(answered.showing).toBe(0)
    await vi.advanceTimersByTimeAsync(1600)
    const refused = new FakeWindow()
    submit(s, refused, { password: 'another' })
    await ask(s, refused, answerTo(s, refused, 'dismiss'))
    expect(refused.showing).toBe(0)
    await vi.advanceTimersByTimeAsync(1600)
    const locked = new FakeWindow()
    submit(s, locked, { username: 'third' })
    s.service.lock()
    expect(locked.showing).toBe(0)
    await vi.advanceTimersByTimeAsync(1600)
    const expired = new FakeWindow()
    submit(s, expired, { username: 'fourth' })
    expect(expired.showing).toBe(1)
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.captureTtlMs + 1)
    expect(expired.showing).toBe(0)
  })

  it('leaves a later notice alone when its login is forgotten', async () => {
    vi.useFakeTimers()
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    submit(s, window)
    window.toast('Another notice, from another feature')
    expect(window.showing).toBe(2)
    await ask(s, window, answerTo(s, window, 'dismiss'))
    expect(window.showing).toBe(2)
    expect(window.dismissed).toEqual([])
  })

  it('is the login of its own window: another window sees nothing of it', async () => {
    const s = setup()
    await withVault(s, [])
    const one = new FakeWindow()
    const two = new FakeWindow()
    submit(s, one)
    expect(s.service.view(two).capture).toBeNull()
    expect((await ask(s, two, answerTo(s, two, 'confirm'))).ok).toBe(false)
    expect(s.vault.count()).toBe(0)
  })
})

describe('a manual login', () => {
  it('is checked like any other, and the vault refuses what it cannot hold', async () => {
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    expect((await ask(s, window, { kind: 'add', address: 'http://remote.example', username: 'a', password: 'b' })).message).toMatch(/https/)
    expect((await ask(s, window, { kind: 'add', address: 'https://u:p@example.com', username: 'a', password: 'b' })).message).toMatch(/ne doit pas contenir/)
    expect((await ask(s, window, { kind: 'add', address: SITE, username: 'a', password: '' })).ok).toBe(false)
    expect((await ask(s, window, { kind: 'add', address: 'example.com', username: 'a', password: 'b' })).ok).toBe(true)
    expect(s.vault.rows()[0]!.origin).toBe(SITE)
    expect((await ask(s, window, { kind: 'remove', id: idOf(s, SITE) })).ok).toBe(true)
    expect(s.vault.count()).toBe(0)
  })

  it('says it when the vault could not be written, and leaves it as it was', async () => {
    const s = setup()
    await withVault(s)
    const window = new FakeWindow()
    rmSync(dir, { recursive: true, force: true })
    const reply = await ask(s, window, { kind: 'add', address: 'https://second.example', username: 'a', password: 'b' })
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(/n’a pas pu être écrit/)
    expect(reply.view.entries).toHaveLength(1)
  })
})

describe('the generator', () => {
  it('answers the text asked for, from the source it was given', async () => {
    const s = setup()
    const reply = await ask(s, new FakeWindow(), { kind: 'generate', options: { length: 12, lower: true, upper: false, digits: false, symbols: false, noAmbiguous: false } })
    expect(reply.password).toBe('aaaaaaaaaaaa')
  })
})

describe('files', () => {
  const CSV = `name,url,username,password\nEx,${SITE}/login,${USER},${SECRET}\nBad,http://remote.example,a,b\n`

  it('imports a CSV through the dialog of the main process, adds without replacing and reports counts only', async () => {
    const s = setup()
    await withVault(s, [[SITE, USER, 'ALREADY-THERE']])
    s.files.read = '/chosen/file.csv'
    s.files.readOutcome = { ok: true, text: CSV }
    const reply = await ask(s, new FakeWindow(), { kind: 'import-csv' })
    expect(reply.ok).toBe(true)
    expect(reply.report).toMatchObject({ format: 'chrome', added: 0, duplicates: 1, unsupported: 1 })
    expect(reply.message).toMatch(/Supprimez maintenant le fichier CSV/)
    expect(s.vault.secret(idOf(s, SITE))?.password).toBe('ALREADY-THERE')
    expect(s.files.readText).toHaveBeenCalledWith('/chosen/file.csv', 4 * 1024 * 1024)
    expect(everything(reply)).not.toContain(SECRET)
  })

  it('does nothing when the dialog is cancelled, refuses a file that cannot be read, and a CSV that is not one', async () => {
    const s = setup()
    await withVault(s, [])
    const window = new FakeWindow()
    s.files.read = null
    expect((await ask(s, window, { kind: 'import-csv' })).ok).toBe(true)
    expect(s.files.readText).not.toHaveBeenCalled()
    s.files.read = '/chosen/file.csv'
    s.files.readOutcome = { ok: false, message: 'Ce fichier est trop volumineux.' }
    expect((await ask(s, window, { kind: 'import-csv' })).message).toBe('Ce fichier est trop volumineux.')
    s.files.readOutcome = { ok: true, text: 'a,b\n1,2\n' }
    expect((await ask(s, window, { kind: 'import-csv' })).message).toMatch(/colonnes d’un export/)
    s.files.readOutcome = { ok: true, text: 'url,password\n"https://x.example,pw\n' }
    expect((await ask(s, window, { kind: 'import-csv' })).message).toMatch(/guillemet/)
    expect(s.vault.count()).toBe(0)
  })

  it('imports nothing while the vault is locked', async () => {
    const s = setup()
    await withVault(s, [])
    s.service.lock()
    s.files.read = '/chosen/file.csv'
    s.files.readOutcome = { ok: true, text: CSV }
    expect((await ask(s, new FakeWindow(), { kind: 'import-csv' })).ok).toBe(false)
    expect(s.files.toRead).not.toHaveBeenCalled()
  })

  it('exports an encrypted file in 0600 that opens with its own phrase and brings the logins back', async () => {
    const s = setup()
    await withVault(s)
    const window = new FakeWindow()
    s.files.writeTo = join(dir, 'export.lucium-passwords')
    const bad = await ask(s, window, { kind: 'export', phrase: 'short' })
    expect(bad.ok).toBe(false)
    expect(existsSync(s.files.writeTo)).toBe(false)
    const reply = await ask(s, window, { kind: 'export', phrase: 'a phrase for the export' })
    expect(reply.ok).toBe(true)
    expect(statSync(s.files.writeTo).mode & 0o777).toBe(0o600)
    const text = readFileSync(s.files.writeTo, 'utf8')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(USER)
    const other = setup({ passwordManager: true }, 'other.vault')
    await other.vault.create(PHRASE)
    other.files.read = s.files.writeTo
    other.files.readOutcome = { ok: true, text }
    expect((await ask(other, window, { kind: 'import-export', phrase: PHRASE })).message).toMatch(/phrase secrète est incorrecte/)
    const back = await ask(other, window, { kind: 'import-export', phrase: 'a phrase for the export' })
    expect(back.report).toMatchObject({ format: 'lucium', added: 1 })
    expect(other.vault.secret(other.vault.rows()[0]!.id)?.password).toBe(SECRET)
  })

  it('exports nothing while the vault is locked', async () => {
    const s = setup()
    await withVault(s)
    s.service.lock()
    s.files.writeTo = join(dir, 'export.lucium-passwords')
    expect((await ask(s, new FakeWindow(), { kind: 'export', phrase: 'a phrase for the export' })).ok).toBe(false)
    expect(existsSync(s.files.writeTo)).toBe(false)
  })

  it('leaves a file it could not write unwritten, and says so', async () => {
    const s = setup()
    await withVault(s)
    s.files.writeTo = join(dir, 'missing-folder', 'export.lucium-passwords')
    const reply = await ask(s, new FakeWindow(), { kind: 'export', phrase: 'a phrase for the export' })
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(/n’a pas pu être écrit/)
    writeFileSync(join(dir, 'ok'), '')
  })
})
