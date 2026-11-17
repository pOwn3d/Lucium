// The connection test of Ollama and the list of its models run in the main process, for a trusted sender, and only on an address of this Mac
// or on a private one of the local network (guard). The request goes out by Electron's net, never by the fetch of Node.
// The real handlers registered by registerIpc are called as Electron would call them; both ways out are stand-ins that record the requests.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(), netFetch: vi.fn() }))
// ipc.ts reaches Electron when it registers its handlers: ipcMain keeps them, net is the way out under test, the other names only need to exist.
vi.mock('electron', () => {
  const ipcMain = { on: (channel: string, handler: Handler) => void electron.handlers.set(channel, handler), handle: (channel: string, handler: Handler) => void electron.handlers.set(channel, handler) }
  const net = { fetch: (...args: unknown[]) => electron.netFetch(...args) }
  return new Proxy({ ipcMain, net, app: { getPath: () => '/nonexistent' }, clipboard: {}, dialog: {}, BrowserWindow: {}, ShareMenu: {} } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) })
})

const { registerIpc } = await import('./ipc')

const TRUSTED = { id: 7, mainFrame: {}, getURL: () => 'lucium://interface/' }
const UNTRUSTED = { id: 99, mainFrame: {}, getURL: () => 'https://evil.example/page?secret=1' }

const models = { models: [{ name: 'mistral:latest' }, { name: 'llama3:8b' }] }
const bareFetch = vi.fn()

// Electron keeps one handler per channel (see ipc-scope.ts): the window is registered once.
beforeAll(() => {
  const browser = new Proxy({}, { get: () => () => undefined })
  const store = { get: () => ({ spaces: [], settings: { ollamaConfig: { enabled: true, url: REMOTE, remoteConfirmed: REMOTE } } }), subscribe: () => () => undefined }
  registerIpc(browser as never, store as never, {} as never, new Set([TRUSTED.id]))
})

beforeEach(() => {
  vi.stubGlobal('fetch', bareFetch)
  bareFetch.mockReset()
  bareFetch.mockImplementation(async () => new Response(JSON.stringify(models), { status: 200 }))
  electron.netFetch.mockReset()
  electron.netFetch.mockImplementation(async () => new Response(JSON.stringify(models), { status: 200 }))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** What Electron hands a handler: the sender, and the frame that sent (the top frame of the sender). */
const ask = (channel: string, sender: { mainFrame: object }, url: unknown) => electron.handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, url)

const NOT_TEXT = [42, undefined, null, ['http://localhost:11434']]
const INVALID = ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:pass@localhost:11434']
/** A public host. The settings of the stand-in hold this very address, as a file written by hand could: it changes nothing. */
const REMOTE = 'https://ollama.exemple.fr'
const OTHERS = [REMOTE, 'http://8.8.8.8:11434', 'http://box.lan:11434', 'http://localhost.evil.com:11434', 'http://localhost@evil.com:11434']

describe('the Ollama connection test', () => {
  it('lists the models of a server at an http address, for a trusted sender, by Electron’s net and not by the fetch of Node', async () => {
    expect(await ask(Channel.ollamaTest, TRUSTED, 'http://localhost:11434/')).toEqual({ ok: true, models: ['mistral', 'llama3'] })
    expect(electron.netFetch).toHaveBeenCalledOnce()
    expect(electron.netFetch.mock.calls[0]![0]).toBe('http://localhost:11434/api/tags')
    // No cookie or HTTP credential of the application's session (net.fetch sends them by default).
    expect((electron.netFetch.mock.calls[0]![1] as RequestInit).credentials).toBe('omit')
    expect(bareFetch).not.toHaveBeenCalled()
  })

  it('refuses what is not an address of this Mac, without any request', async () => {
    for (const url of NOT_TEXT) expect(await ask(Channel.ollamaTest, TRUSTED, url), String(url)).toEqual({ ok: false, error: 'invalid address' })
    for (const url of [...INVALID, ...OTHERS]) expect(await ask(Channel.ollamaTest, TRUSTED, url), url).toEqual({ ok: false, error: t('summary.adresse-non-locale', { settingsPath: settingsPath('summary') }) })
    expect(electron.netFetch).not.toHaveBeenCalled()
    expect(bareFetch).not.toHaveBeenCalled()
  })

  it('refuses a sender the window does not trust, even for a good address, without any request (the scope of the window answers it nothing)', async () => {
    expect(await ask(Channel.ollamaTest, UNTRUSTED, 'http://localhost:11434')).toBeUndefined()
    expect(electron.netFetch).not.toHaveBeenCalled()
  })
})

describe('the list of the Ollama models', () => {
  it('is read by Electron’s net, never by the fetch of Node', async () => {
    expect(await ask(Channel.ollamaModels, TRUSTED, 'http://localhost:11434')).toEqual({ ok: true, models: ['llama3:8b', 'mistral:latest'] })
    expect(electron.netFetch).toHaveBeenCalledOnce()
    expect(electron.netFetch.mock.calls[0]![0]).toBe('http://localhost:11434/api/tags')
    expect((electron.netFetch.mock.calls[0]![1] as RequestInit).credentials).toBe('omit')
    expect(bareFetch).not.toHaveBeenCalled()
  })

  it('is read with the same checks: a trusted sender and an address of this Mac, or no request at all', async () => {
    for (const url of NOT_TEXT) expect(await ask(Channel.ollamaModels, TRUSTED, url), String(url)).toEqual({ ok: false, error: 'invalid address' })
    for (const url of [...INVALID, ...OTHERS]) expect(await ask(Channel.ollamaModels, TRUSTED, url), url).toEqual({ ok: false, error: t('summary.adresse-non-locale', { settingsPath: settingsPath('summary') }) })
    expect(await ask(Channel.ollamaModels, UNTRUSTED, 'http://localhost:11434')).toBeUndefined()
    expect(electron.netFetch).not.toHaveBeenCalled()
    expect(bareFetch).not.toHaveBeenCalled()
  })
})
