// The one-time codes of the password service (docs/gestionnaire-mots-de-passe.md, « Codes à usage unique »): the key stays in the main process, the
// interface is given the digits it asked for, a copied code is taken off the clipboard, and nothing of the key or of a code reaches a log.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { PASSWORD_LIMITS, type PasswordReply, type PasswordRequest } from '@shared/passwords'
import { t } from '@shared/i18n'
import { PasswordVault, writePrivateFile } from '../password-vault'
import { PasswordService, type ClipboardPort, type PasswordFiles, type PasswordWindow } from './password-service'

const PHRASE = 'une phrase maître assez longue'
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }
const SITE = 'https://example.com'
// The key of the examples of RFC 6238 (the ASCII "12345678901234567890"), typed the way a site shows it: lower case, in groups.
const TYPED = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq'
const KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const URI = `otpauth://totp/Example:ana?secret=${KEY}&issuer=Example&digits=8`

class FakeWindow implements PasswordWindow {
  privateWindow = false
  isPrivate = () => this.privateWindow
  target = () => null
  toast = () => undefined
  openPanel = () => undefined
}

class FakeClipboard implements ClipboardPort {
  text = 'something the user copied'
  writes = 0
  failWrite = false
  failRead = false
  /** When set, a write waits for this to be called: the vault can lock meanwhile. */
  gate: Promise<void> | null = null
  readText = vi.fn(async () => {
    if (this.failRead) throw new TypeError('read refused')
    return this.text
  })
  writeText = vi.fn(async (text: string) => {
    if (this.gate) await this.gate
    if (this.failWrite) throw new TypeError('write refused')
    this.writes++
    this.text = text
  })
  clear = vi.fn(() => {
    this.text = ''
  })
}

const files: PasswordFiles = { chooseToRead: async () => null, chooseToWrite: async () => null, readText: async () => ({ ok: false, message: '' }), writePrivate: writePrivateFile }
const noPower = { on: () => undefined, off: () => undefined }

let dir: string
let clock: number
let clipboard: FakeClipboard
let vault: PasswordVault
let service: PasswordService
let window: FakeWindow
let settings: ReturnType<typeof defaultSettings>
const logged: string[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-totp-'))
  logged.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}:${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
  }
  clock = 59_000
  clipboard = new FakeClipboard()
  settings = { ...defaultSettings(), passwordManager: true }
  vault = new PasswordVault({ path: join(dir, 'passwords.vault'), params: PARAMS })
  window = new FakeWindow()
  service = new PasswordService({ settings: () => settings, vault, power: noPower, files, now: () => clock, clipboard })
  await vault.create(PHRASE)
  await vault.save({ origin: SITE, username: 'ana', password: 'the-password-9f2' })
})
afterEach(() => {
  service.stop()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const ask = (request: PasswordRequest, w: PasswordWindow = window): Promise<PasswordReply> => service.handle(request, w)
const id = (): string => vault.rows()[0]!.id
/** The key of the example, set on the entry through the panel's request. */
const withKey = async (secret = URI): Promise<void> => void (await ask({ kind: 'totp-set', id: id(), secret }))
const everything = (...values: unknown[]): string => JSON.stringify(values)

describe('adding the key of the one-time codes', () => {
  it('takes the key as a site shows it, or the address of its QR code, and says only that the entry has one', async () => {
    const reply = await ask({ kind: 'totp-set', id: id(), secret: TYPED })
    expect(reply.ok).toBe(true)
    expect(reply.view.entries[0]!.totp).toBe(true)
    expect(vault.totpOf(id())).toEqual({ secret: KEY, algorithm: 'SHA1', digits: 6, period: 30 })
    const again = await ask({ kind: 'totp-set', id: id(), secret: URI })
    expect(again.ok).toBe(true)
    expect(vault.totpOf(id())).toMatchObject({ digits: 8 })
    expect(everything(reply, again)).not.toContain(KEY)
  })

  it('refuses what is not a key, says what is wrong without repeating what was typed, and changes nothing', async () => {
    for (const typed of ['not a key at all!', 'SUPERSECRETTYPO1!', `otpauth://totp/x?secret=${KEY}&digits=12`]) {
      const reply = await ask({ kind: 'totp-set', id: id(), secret: typed })
      expect(reply.ok, typed).toBe(false)
      expect(reply.message).toBe(t('pwd.totp-cle-invalide'))
      expect(everything(reply)).not.toContain(typed)
      expect(everything(reply)).not.toContain('SUPERSECRETTYPO1')
    }
    expect(vault.totpOf(id())).toBeNull()
    expect(logged.join('\n')).not.toContain('SUPERSECRETTYPO1')
  })

  it('refuses a counter-based key by name', async () => {
    const reply = await ask({ kind: 'totp-set', id: id(), secret: `otpauth://hotp/x?secret=${KEY}&counter=1` })
    expect(reply.ok).toBe(false)
    expect(reply.message).toBe(t('pwd.totp-non-pris-en-charge'))
  })

  it('is for an entry that exists, in a vault that is open', async () => {
    expect(await ask({ kind: 'totp-set', id: 'f'.repeat(32), secret: TYPED })).toMatchObject({ ok: false, message: t('pwd.cet-identifiant-n-existe-plus') })
    const known = id()
    service.lock()
    expect(await ask({ kind: 'totp-set', id: known, secret: TYPED })).toMatchObject({ ok: false, message: t('pwd.le-coffre-est-verrouille') })
  })

  it('is refused in a private window and when the manager is off, like every request of the panel', async () => {
    window.privateWindow = true
    expect((await ask({ kind: 'totp-set', id: id(), secret: TYPED })).ok).toBe(false)
    expect(vault.totpOf(id())).toBeNull()
    window.privateWindow = false
    settings.passwordManager = false
    expect((await ask({ kind: 'totp-set', id: id(), secret: TYPED })).ok).toBe(false)
    expect(vault.totpOf(id())).toBeNull()
  })
})

describe('the code', () => {
  it('is the one of RFC 6238 at the time of the clock, with the seconds it lasts, and nothing of the key', async () => {
    await withKey()
    // Appendix B: the key of SHA-1 at 59 s, 8 digits, gives 94287082; one second is left in its 30 s.
    const reply = await ask({ kind: 'totp-code', id: id() })
    expect(reply).toMatchObject({ ok: true, totp: { id: id(), code: '94287082', secondsLeft: 1, period: 30 } })
    expect(everything(reply)).not.toContain(KEY)
    clock = 1111111109_000
    expect((await ask({ kind: 'totp-code', id: id() })).totp).toMatchObject({ code: '07081804', secondsLeft: 1 })
  })

  it('is not made for an entry without a key, an entry that is gone, or a vault that is locked', async () => {
    expect(await ask({ kind: 'totp-code', id: id() })).toMatchObject({ ok: false, message: t('pwd.totp-absent') })
    expect((await ask({ kind: 'totp-code', id: id() })).totp).toBeUndefined()
    await withKey()
    expect((await ask({ kind: 'totp-code', id: 'f'.repeat(32) })).totp).toBeUndefined()
    const known = id()
    service.lock()
    expect(await ask({ kind: 'totp-code', id: known })).toMatchObject({ ok: false, message: t('pwd.le-coffre-est-verrouille') })
  })

  it('is not made in a private window', async () => {
    await withKey()
    window.privateWindow = true
    const reply = await ask({ kind: 'totp-code', id: id() })
    expect(reply.ok).toBe(false)
    expect(reply.totp).toBeUndefined()
  })

  it('gives the milliseconds left with the seconds', async () => {
    await withKey()
    clock = 59_900
    expect((await ask({ kind: 'totp-code', id: id() })).totp).toMatchObject({ secondsLeft: 1, msLeft: 100 })
  })

  it('is told by a sentence, and a kind in the log, when it cannot be made; the log says nothing of the key', async () => {
    await withKey()
    vi.spyOn(vault, 'totpOf').mockReturnValue({ secret: '1!', algorithm: 'SHA1', digits: 6, period: 30 })
    const reply = await ask({ kind: 'totp-code', id: id() })
    expect(reply).toMatchObject({ ok: false, message: t('pwd.l-operation-a-echoue') })
    expect(logged.some((line) => line.includes('computing a one-time code failed'))).toBe(true)
    expect(logged.join('\n')).not.toContain('1!')
  })
})

describe('the idle lock while a code is on screen', () => {
  const LOCK_MS = 10 * 60_000

  const open = async (): Promise<void> => {
    service.stop()
    service = new PasswordService({ settings: () => settings, vault, power: noPower, files, now: () => clock, clipboard, autoLockMs: LOCK_MS })
    await ask({ kind: 'lock' })
    expect((await ask({ kind: 'unlock', phrase: PHRASE })).ok).toBe(true)
    await withKey()
  }

  it('is not pushed back by the panel asking again by itself, so a code left on screen does not keep the vault open', async () => {
    vi.useFakeTimers()
    await open()
    for (let minute = 0; minute < 9; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await ask({ kind: 'totp-code', id: id(), auto: true })).ok).toBe(true)
    }
    await vi.advanceTimersByTimeAsync(61_000)
    expect(vault.isUnlocked()).toBe(false)
  })

  it('is pushed back by a person asking for the code', async () => {
    vi.useFakeTimers()
    await open()
    await vi.advanceTimersByTimeAsync(LOCK_MS - 1000)
    expect((await ask({ kind: 'totp-code', id: id() })).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(LOCK_MS - 1000)
    expect(vault.isUnlocked()).toBe(true)
  })
})

describe('removing the key', () => {
  it('takes it off the entry and says so; an entry without a key says that it has none', async () => {
    await withKey()
    const reply = await ask({ kind: 'totp-remove', id: id() })
    expect(reply).toMatchObject({ ok: true, message: t('pwd.totp-retire') })
    expect(reply.view.entries[0]!.totp).toBe(false)
    expect(vault.totpOf(id())).toBeNull()
    expect(await ask({ kind: 'totp-remove', id: id() })).toMatchObject({ ok: false, message: t('pwd.totp-absent') })
    const known = id()
    service.lock()
    expect(await ask({ kind: 'totp-remove', id: known })).toMatchObject({ ok: false, message: t('pwd.le-coffre-est-verrouille') })
  })
})

describe('copying the code', () => {
  it('puts it on the clipboard from the main process, tells the panel only that it did, and takes it off after the delay', async () => {
    await withKey()
    vi.useFakeTimers()
    const reply = await ask({ kind: 'totp-copy', id: id() })
    expect(reply).toMatchObject({ ok: true, message: t('pwd.totp-copie', { seconds: PASSWORD_LIMITS.clipboardClearMs / 1000 }) })
    expect(clipboard.text).toBe('94287082')
    expect(everything(reply)).not.toContain('94287082')
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.clipboardClearMs - 1)
    expect(clipboard.text).toBe('94287082')
    await vi.advanceTimersByTimeAsync(2)
    expect(clipboard.text).toBe('')
    expect(clipboard.clear).toHaveBeenCalledTimes(1)
  })

  it('leaves what the user copied since: only the code itself is taken off', async () => {
    await withKey()
    vi.useFakeTimers()
    await ask({ kind: 'totp-copy', id: id() })
    clipboard.text = 'a paragraph the user copied meanwhile'
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.clipboardClearMs + 1)
    expect(clipboard.clear).not.toHaveBeenCalled()
    expect(clipboard.text).toBe('a paragraph the user copied meanwhile')
  })

  it('takes it off at once when the vault locks, the idle lock included', async () => {
    await withKey()
    await ask({ kind: 'totp-copy', id: id() })
    service.lock()
    await vi.waitFor(() => expect(clipboard.text).toBe(''))
  })

  it('takes it off when the vault is deleted', async () => {
    await withKey()
    await ask({ kind: 'totp-copy', id: id() })
    await ask({ kind: 'destroy', phrase: PHRASE })
    await vi.waitFor(() => expect(clipboard.text).toBe(''))
  })

  it('is replaced by the next copy without the first delay wiping the second', async () => {
    await withKey()
    vi.useFakeTimers()
    await ask({ kind: 'totp-copy', id: id() })
    await vi.advanceTimersByTimeAsync(20_000)
    clock = 1111111109_000
    await ask({ kind: 'totp-copy', id: id() })
    expect(clipboard.text).toBe('07081804')
    // 30 s after the first copy: its delay is over, the second code stays for its own.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(clipboard.text).toBe('07081804')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(clipboard.text).toBe('')
  })

  it('takes it off at once when the vault locks while the clipboard is still being written, and says the vault is locked', async () => {
    await withKey()
    let release!: () => void
    clipboard.gate = new Promise<void>((resolve) => (release = resolve))
    const pending = ask({ kind: 'totp-copy', id: id() })
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalled())
    service.lock()
    release()
    const reply = await pending
    expect(reply).toMatchObject({ ok: false, message: t('pwd.le-coffre-est-verrouille') })
    await vi.waitFor(() => expect(clipboard.text).toBe(''))
  })

  it('does not copy without a clipboard, without a key or from a locked vault', async () => {
    const bare = new PasswordService({ settings: () => settings, vault, power: noPower, files, now: () => clock })
    await withKey()
    expect(await bare.handle({ kind: 'totp-copy', id: id() }, window)).toMatchObject({ ok: false, message: t('pwd.totp-presse-papiers-indisponible') })
    await ask({ kind: 'totp-remove', id: id() })
    expect(await ask({ kind: 'totp-copy', id: id() })).toMatchObject({ ok: false, message: t('pwd.totp-absent') })
    expect(clipboard.writes).toBe(0)
    const known = id()
    service.lock()
    expect(await ask({ kind: 'totp-copy', id: known })).toMatchObject({ ok: false, message: t('pwd.le-coffre-est-verrouille') })
  })

  it('says so, and logs a kind, when the clipboard refuses the code; no delay is left running for a code that is not there', async () => {
    await withKey()
    vi.useFakeTimers()
    clipboard.failWrite = true
    const reply = await ask({ kind: 'totp-copy', id: id() })
    expect(reply).toMatchObject({ ok: false, message: t('pwd.totp-copie-impossible') })
    expect(logged.some((line) => line.includes('a one-time code could not be copied') && line.includes('TypeError'))).toBe(true)
    expect(logged.join('\n')).not.toContain('94287082')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs a kind, and never the code, when the clipboard cannot be read to take the code off it', async () => {
    await withKey()
    vi.useFakeTimers()
    await ask({ kind: 'totp-copy', id: id() })
    clipboard.failRead = true
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.clipboardClearMs + 1)
    expect(logged.some((line) => line.includes('could not be taken off the clipboard') && line.includes('TypeError'))).toBe(true)
    expect(logged.join('\n')).not.toContain('94287082')
    expect(clipboard.clear).not.toHaveBeenCalled()
  })

  it('is not done in a private window', async () => {
    await withKey()
    window.privateWindow = true
    expect((await ask({ kind: 'totp-copy', id: id() })).ok).toBe(false)
    expect(clipboard.writes).toBe(0)
  })
})

describe('what is logged', () => {
  it('holds no key and no code, whatever was asked', async () => {
    await withKey(TYPED)
    await ask({ kind: 'totp-code', id: id() })
    await ask({ kind: 'totp-copy', id: id() })
    await ask({ kind: 'totp-set', id: id(), secret: 'nope nope nope nope!' })
    await ask({ kind: 'totp-remove', id: id() })
    service.lock()
    const all = logged.join('\n')
    for (const value of [KEY, TYPED, '287082', '94287082']) expect(all).not.toContain(value)
  })
})
