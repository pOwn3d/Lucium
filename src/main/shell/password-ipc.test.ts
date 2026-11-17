// The channel of the password manager, as `registerIpc` registers it for a window: who gets an answer, what reaches the service, and where
// the files it reads and writes come from. The reader of the requests is tested alone (shared/passwords.test.ts) and the service too
// (password-service.test.ts); here it is the handler that is run, with the guard of the window in its real place.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() }
}))
vi.mock('electron', () => electron)

import { Channel } from '@shared/ipc'
import { NO_PASSWORDS_VIEW, type PasswordReply } from '@shared/passwords'
import { t } from '@shared/i18n'
import type { ScopedIpc } from './ipc-scope'
import { PASSWORD_EXPORT_EXTENSION, passwordFiles, registerPasswordIpc } from './password-ipc'
import { setPasswordService, type PasswordFiles } from './password-service'

type Handler = (event: { sender: object }, raw: unknown) => Promise<PasswordReply>

const PASSWORD_WINDOW = { the: 'window of the passwords' }

/** The channel of one window: the guard answers `trusted`. */
function windowPasswords(options: { trusted?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = { on: () => undefined, handle: (channel, listener) => void handlers.set(channel, listener as unknown as Handler) }
  const guard = vi.fn(() => options.trusted ?? true)
  registerPasswordIpc(ipc, guard, { passwordWindow: () => PASSWORD_WINDOW } as never)
  const sender = { the: 'sender' }
  return { guard, sender, ask: (raw: unknown) => handlers.get(Channel.passwords)!({ sender }, raw) }
}

/** A service that answers what it was asked. */
function service() {
  const answer: PasswordReply = { ok: true, view: NO_PASSWORDS_VIEW }
  const passwords = { handle: vi.fn(async (_request: unknown, _window: unknown, _files: PasswordFiles) => answer) }
  setPasswordService(passwords as never)
  return { passwords, answer }
}

const REFUSED = { ok: false, message: t('feature.demande-refusee'), view: NO_PASSWORDS_VIEW }
const INVALID = { ok: false, message: t('feature.demande-invalide'), view: NO_PASSWORDS_VIEW }

beforeEach(() => {
  electron.dialog.showOpenDialog.mockReset()
  electron.dialog.showSaveDialog.mockReset()
  electron.BrowserWindow.fromWebContents.mockReset()
})

afterEach(() => setPasswordService(null))

describe('the channel of the passwords', () => {
  it('hands the service the request as its reader understood it, the window of the passwords and the files of the window that asked', async () => {
    const { passwords, answer } = service()
    const owner = { the: 'window that asked' }
    electron.BrowserWindow.fromWebContents.mockReturnValue(owner)
    const window = windowPasswords()
    expect(await window.ask({ kind: 'unlock', phrase: 'a phrase long enough' })).toBe(answer)
    expect(window.guard).toHaveBeenCalledWith(window.sender, Channel.passwords)
    expect(passwords.handle).toHaveBeenCalledTimes(1)
    const [request, target, files] = passwords.handle.mock.calls[0]!
    expect(request).toEqual({ kind: 'unlock', phrase: 'a phrase long enough' })
    expect(target).toBe(PASSWORD_WINDOW)
    // The dialogs of these files open on the window the request came from.
    expect(electron.BrowserWindow.fromWebContents).toHaveBeenCalledWith(window.sender)
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true })
    await files.chooseToWrite()
    expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toBe(owner)
  })

  it('is refused when the guard of the window says no (an untrusted sender, a locked application): the service hears nothing', async () => {
    const { passwords } = service()
    expect(await windowPasswords({ trusted: false }).ask({ kind: 'status' })).toEqual(REFUSED)
    expect(passwords.handle).not.toHaveBeenCalled()
    expect(electron.BrowserWindow.fromWebContents).not.toHaveBeenCalled()
  })

  it('never hands the service a request that is not one, nor a path chosen by the interface', async () => {
    const { passwords } = service()
    const window = windowPasswords()
    for (const request of [null, 'status', [], {}, { kind: 'unknown' }, { kind: 'unlock' }, { kind: 'status', more: 1 }, { kind: 'import-csv', path: '/etc/passwd' }, { kind: 'export', phrase: 'a phrase long enough', path: '/tmp/out' }]) {
      expect(await window.ask(request), JSON.stringify(request)).toEqual(INVALID)
    }
    expect(passwords.handle).not.toHaveBeenCalled()
  })

  it('answers that the request is invalid while there is no password service', async () => {
    expect(await windowPasswords().ask({ kind: 'status' })).toEqual(INVALID)
  })
})

describe('the files of the passwords', () => {
  let folder = ''
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'lucium-password-ipc-'))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('asks for a CSV or for an encrypted export, and answers the file picked or nothing', async () => {
    const files = passwordFiles(null)
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/me/logins.csv'] })
    expect(await files.chooseToRead('csv')).toBe('/Users/me/logins.csv')
    const csv = electron.dialog.showOpenDialog.mock.calls[0]![0] as { properties: string[]; filters: { extensions: string[] }[] }
    expect(csv.properties).toEqual(['openFile'])
    expect(csv.filters[0]!.extensions).toEqual(['csv'])

    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/Users/me/ignored'] })
    expect(await files.chooseToRead('export')).toBeNull()
    const sealed = electron.dialog.showOpenDialog.mock.calls[1]![0] as { filters: { extensions: string[] }[] }
    expect(sealed.filters[0]!.extensions).toEqual([PASSWORD_EXPORT_EXTENSION, 'json'])

    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect(await files.chooseToRead('csv')).toBeNull()
  })

  it('proposes a name with the extension of the export, and answers nothing when the dialog is cancelled or gives no path', async () => {
    const files = passwordFiles(null)
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/Users/me/out.lucium-passwords' })
    expect(await files.chooseToWrite()).toBe('/Users/me/out.lucium-passwords')
    const options = electron.dialog.showSaveDialog.mock.calls[0]![0] as { defaultPath: string; filters: { extensions: string[] }[] }
    expect(options.defaultPath.endsWith(`.${PASSWORD_EXPORT_EXTENSION}`)).toBe(true)
    expect(options.filters[0]!.extensions).toEqual([PASSWORD_EXPORT_EXTENSION])
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '/Users/me/ignored' })
    expect(await files.chooseToWrite()).toBeNull()
    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '' })
    expect(await files.chooseToWrite()).toBeNull()
  })

  it('reads a file within the size it is given, and says why it did not when the file is too large or missing', async () => {
    const files = passwordFiles(null)
    const path = join(folder, 'logins.csv')
    writeFileSync(path, 'url,username,password\n')
    expect(await files.readText(path, 1024)).toEqual({ ok: true, text: 'url,username,password\n' })
    const large = await files.readText(path, 4)
    expect(large.ok).toBe(false)
    expect(large).toHaveProperty('message')
    const missing = await files.readText(join(folder, 'absent.csv'), 1024)
    expect(missing.ok).toBe(false)
    expect((missing as { message: string }).message).not.toBe('')
    expect((missing as { message: string }).message).not.toBe((large as { message: string }).message)
  })
})
