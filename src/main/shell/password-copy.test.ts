// « Copier le mot de passe » (docs/gestionnaire-mots-de-passe.md §1 and §5): the password goes to the clipboard from the main process only, marked
// as concealed, and comes off it after 30 seconds and when the vault locks. The interface is never given it, and no log says it.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { PASSWORD_LIMITS, parsePasswordRequest, type PasswordReply, type PasswordRequest } from '@shared/passwords'
import { t } from '@shared/i18n'
import { PasswordVault, writePrivateFile } from '../password-vault'
import { PasswordService, type ClipboardPort, type PasswordFiles, type PasswordWindow } from './password-service'

const PHRASE = 'une phrase maître assez longue'
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }
const SITE = 'https://example.com'
const SECRET = 'the-password-9f2'

class FakeWindow implements PasswordWindow {
  privateWindow = false
  isPrivate = () => this.privateWindow
  target = () => null
  toast = () => undefined
  openPanel = () => undefined
}

class FakeClipboard implements ClipboardPort {
  text = 'something the user copied'
  /** What was written as concealed: the text, and only through `writeSecret`. */
  concealed: string[] = []
  failWrite = false
  gate: Promise<void> | null = null
  readText = vi.fn(async () => this.text)
  writeText = vi.fn(async (text: string) => {
    this.text = text
  })
  writeSecret = vi.fn(async (text: string) => {
    if (this.gate) await this.gate
    if (this.failWrite) throw new TypeError('write refused')
    this.concealed.push(text)
    this.text = text
  })
  clear = vi.fn(() => {
    this.text = ''
  })
}

const files: PasswordFiles = { chooseToRead: async () => null, chooseToWrite: async () => null, readText: async () => ({ ok: false, message: '' }), writePrivate: writePrivateFile }
const noPower = { on: () => undefined, off: () => undefined }

let dir: string
let clipboard: FakeClipboard
let vault: PasswordVault
let service: PasswordService
let window: FakeWindow
const logged: string[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-copy-'))
  logged.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
  }
  clipboard = new FakeClipboard()
  vault = new PasswordVault({ path: join(dir, 'passwords.vault'), params: PARAMS })
  window = new FakeWindow()
  service = new PasswordService({ settings: () => ({ ...defaultSettings(), passwordManager: true }), vault, power: noPower, files, clipboard })
  await vault.create(PHRASE)
  await vault.save({ origin: SITE, username: 'ana', password: SECRET })
})
afterEach(() => {
  service.stop()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const ask = (request: PasswordRequest): Promise<PasswordReply> => service.handle(request, window)
const id = (): string => vault.rows()[0]!.id

describe('copying a password', () => {
  it('puts it on the clipboard as concealed, from the main process, and tells the panel only how long it stays', async () => {
    const reply = await ask({ kind: 'copy-password', id: id() })
    expect(reply.ok).toBe(true)
    expect(clipboard.concealed).toEqual([SECRET])
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(reply.message).toBe(t('pwd.mdp-copie', { seconds: PASSWORD_LIMITS.clipboardClearMs / 1000 }))
    expect(JSON.stringify(reply)).not.toContain(SECRET)
  })

  it('takes it off after 30 seconds, and not a minute before', async () => {
    vi.useFakeTimers()
    await ask({ kind: 'copy-password', id: id() })
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.clipboardClearMs - 1000)
    expect(clipboard.text).toBe(SECRET)
    await vi.advanceTimersByTimeAsync(1500)
    expect(clipboard.text).toBe('')
  })

  it('leaves alone what the user copied since', async () => {
    vi.useFakeTimers()
    await ask({ kind: 'copy-password', id: id() })
    clipboard.text = 'a thing copied later'
    await vi.advanceTimersByTimeAsync(PASSWORD_LIMITS.clipboardClearMs + 1000)
    expect(clipboard.text).toBe('a thing copied later')
    expect(clipboard.clear).not.toHaveBeenCalled()
  })

  it('takes it off at once when the vault locks', async () => {
    await ask({ kind: 'copy-password', id: id() })
    await ask({ kind: 'lock' })
    await vi.waitFor(() => expect(clipboard.text).toBe(''))
  })

  it('takes it off when the vault locks while it is being written', async () => {
    let release: () => void = () => undefined
    clipboard.gate = new Promise<void>((resolve) => (release = resolve))
    const pending = ask({ kind: 'copy-password', id: id() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    service.lock()
    release()
    const reply = await pending
    expect(reply.ok).toBe(false)
    expect(clipboard.text).toBe('')
  })

  it('refuses a locked vault, an entry that is gone, a missing clipboard and a private window, and copies nothing', async () => {
    const known = id()
    const other = 'f'.repeat(32)
    expect((await ask({ kind: 'copy-password', id: other })).message).toBe(t('pwd.cet-identifiant-n-existe-plus'))
    const withoutClipboard = new PasswordService({ settings: () => ({ ...defaultSettings(), passwordManager: true }), vault, power: noPower, files })
    expect((await withoutClipboard.handle({ kind: 'copy-password', id: known }, window)).message).toBe(t('pwd.totp-presse-papiers-indisponible'))
    window.privateWindow = true
    expect((await ask({ kind: 'copy-password', id: known })).ok).toBe(false)
    window.privateWindow = false
    await ask({ kind: 'lock' })
    expect((await ask({ kind: 'copy-password', id: known })).message).toBe(t('pwd.le-coffre-est-verrouille'))
    expect(clipboard.concealed).toEqual([])
  })

  it('says it failed, logs a kind and never the password, and keeps no timer on a copy that did not happen', async () => {
    clipboard.failWrite = true
    const reply = await ask({ kind: 'copy-password', id: id() })
    expect(reply.ok).toBe(false)
    expect(reply.message).toBe(t('pwd.mdp-copie-impossible'))
    expect(logged.join('\n')).toContain('could not be copied')
    expect(logged.join('\n')).not.toContain(SECRET)
    clipboard.text = 'unrelated'
    service.lock()
    await Promise.resolve()
    expect(clipboard.text).toBe('unrelated')
  })

  it('replaces the code or the password copied before, and the first timer does not take the new one off', async () => {
    vi.useFakeTimers()
    await ask({ kind: 'copy-password', id: id() })
    await vi.advanceTimersByTimeAsync(20_000)
    await ask({ kind: 'copy-password', id: id() })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(clipboard.text).toBe(SECRET)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(clipboard.text).toBe('')
  })

  it('is read from the panel with exactly its id', () => {
    expect(parsePasswordRequest({ kind: 'copy-password', id: id() })).toEqual({ kind: 'copy-password', id: id() })
    expect(parsePasswordRequest({ kind: 'copy-password', id: 'x' })).toBeNull()
    expect(parsePasswordRequest({ kind: 'copy-password', id: id(), password: 'y' })).toBeNull()
  })
})
