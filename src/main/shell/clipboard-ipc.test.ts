import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_TEXT_MAX, type ClipboardTextReply } from '@shared/clipboard-text'
import { Channel, type LuciumApi } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import type { ScopedIpc } from './ipc-scope'
import { registerClipboardIpc, type TextClipboard } from './clipboard-ipc'
import { fakeBrowser } from './browser-fake.test-support'
import { invokeFrom, ipcHost } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))
const { registerIpc } = await import('./ipc')

type Handler = (event: { sender: object }, ...args: unknown[]) => unknown

/** The two channels registered on a fake IPC, with a fake clipboard that holds a text and can be made to fail. */
function setup(options: { trusted?: boolean; holds?: string; readFails?: boolean; writeFails?: boolean; readsNonText?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = {
    on: (channel, listener) => void handlers.set(channel, listener as Handler),
    handle: (channel, listener) => void handlers.set(channel, listener as Handler)
  }
  const written: string[] = []
  const clipboard: TextClipboard = {
    readText: () => (options.readFails ? Promise.reject(new Error('no clipboard')) : Promise.resolve((options.readsNonText ? 42 : (options.holds ?? '')) as string)),
    writeText: (text) => {
      if (options.writeFails) return Promise.reject(new Error('the clipboard is busy'))
      written.push(text)
      return Promise.resolve()
    }
  }
  const guard = vi.fn(() => options.trusted !== false)
  registerClipboardIpc(ipc, guard, clipboard)
  return {
    read: () => handlers.get(Channel.clipboardRead)!({ sender: {} }) as Promise<ClipboardTextReply>,
    write: (text: unknown) => handlers.get(Channel.clipboardWrite)!({ sender: {} }, text) as Promise<boolean>,
    written,
    guard,
    registered: () => [...handlers.keys()].sort()
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('the clipboard IPC of the command bar', () => {
  it('registers a channel to read and a channel to write, and no other', () => {
    expect(Channel.clipboardRead).toBe('lucium:clipboard-read')
    expect(Channel.clipboardWrite).toBe('lucium:clipboard-write')
    expect(setup().registered()).toEqual([Channel.clipboardRead, Channel.clipboardWrite].sort())
  })

  describe('reading', () => {
    it('gives the text on the clipboard, as it is', async () => {
      expect(await setup({ holds: 'https://example.org/\nsuite' }).read()).toEqual({ ok: true, text: 'https://example.org/\nsuite' })
    })

    it('gives an empty text for an empty clipboard (or one that holds a picture, which has no text)', async () => {
      expect(await setup({ holds: '' }).read()).toEqual({ ok: true, text: '' })
    })

    it('gives a text of CLIPBOARD_TEXT_MAX characters, and says "too long" rather than cutting one that is longer', async () => {
      const longest = 'a'.repeat(CLIPBOARD_TEXT_MAX)
      expect(await setup({ holds: longest }).read()).toEqual({ ok: true, text: longest })
      expect(await setup({ holds: longest + 'a' }).read()).toEqual({ ok: false, reason: 'too-long' })
    })

    it('says it could not read, and logs why, when the clipboard throws', async () => {
      expect(await setup({ readFails: true }).read()).toEqual({ ok: false, reason: 'unreadable' })
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cannot read'), 'Error')
    })

    it('says it could not read when the clipboard gives something that is not a text', async () => {
      expect(await setup({ readsNonText: true }).read()).toEqual({ ok: false, reason: 'unreadable' })
    })

    it('reads nothing for a sender that is not one of the application’s own pages', async () => {
      const t = setup({ trusted: false, holds: 'secret' })
      expect(await t.read()).toEqual({ ok: false, reason: 'unreadable' })
      expect(t.guard).toHaveBeenCalledWith(expect.anything(), Channel.clipboardRead)
    })
  })

  describe('writing', () => {
    it('puts a text on the clipboard and says so', async () => {
      const t = setup()
      expect(await t.write('https://example.org/')).toBe(true)
      expect(t.written).toEqual(['https://example.org/'])
    })

    it('takes a text of CLIPBOARD_TEXT_MAX characters, and refuses one more', async () => {
      const t = setup()
      expect(await t.write('a'.repeat(CLIPBOARD_TEXT_MAX))).toBe(true)
      expect(await t.write('a'.repeat(CLIPBOARD_TEXT_MAX + 1))).toBe(false)
      expect(t.written).toHaveLength(1)
    })

    it('refuses an empty text (it would only clear the clipboard) and anything that is not a text, and writes nothing', async () => {
      const t = setup()
      for (const bad of ['', undefined, null, 0, 12, true, [], ['a'], {}, { toString: () => 'a' }]) expect(await t.write(bad), JSON.stringify(bad)).toBe(false)
      expect(t.written).toEqual([])
      expect(console.warn).toHaveBeenCalled()
    })

    it('says it was not written, and logs why, when the clipboard throws', async () => {
      const t = setup({ writeFails: true })
      expect(await t.write('a')).toBe(false)
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cannot write'), 'Error')
    })

    it('writes nothing for a sender that is not one of the application’s own pages', async () => {
      const t = setup({ trusted: false })
      expect(await t.write('a')).toBe(false)
      expect(t.written).toEqual([])
      expect(t.guard).toHaveBeenCalledWith(expect.anything(), Channel.clipboardWrite)
    })
  })
})

// The channels as a window registers them (registerIpc, with Electron's own clipboard and the guard of the window) and as the bridge of the interface
// sends them (the preload script), run against an Electron that keeps what is registered, exposed and sent (ipc-fake.test-support.ts).
describe('the wiring of the clipboard channels', () => {
  it('registers them for each window, with the clipboard of Electron and the guard of the window', async () => {
    const state = createInitialState({ now: 0, newId: () => 'x' })
    registerIpc(fakeBrowser().self as never, { get: () => state, subscribe: () => () => {} } as never, {} as never, new Set([1]))
    ipcHost.clipboardText = 'copié'
    expect(await invokeFrom(1, Channel.clipboardRead)).toEqual({ ok: true, text: 'copié' })
    expect(await invokeFrom(1, Channel.clipboardWrite, 'collé')).toBe(true)
    expect(ipcHost.clipboardText).toBe('collé')
    // A sender that is not one of the window's own pages is answered nothing by the scope of the window (the guard of the handlers is a second line).
    expect(await invokeFrom(99, Channel.clipboardRead)).toBeUndefined()
    expect(await invokeFrom(99, Channel.clipboardWrite, 'volé')).toBeUndefined()
    expect(ipcHost.clipboardText).toBe('collé')
  })

  it('exposes them to the interface as the two methods of the bridge, on their own channels', async () => {
    vi.stubGlobal('location', { search: '' })
    await import('../../preload/index')
    const api = ipcHost.exposed.get('lucium') as LuciumApi
    ipcHost.sent.length = 0
    void api.readClipboardText()
    void api.writeClipboardText('x')
    expect(ipcHost.sent).toEqual([
      { kind: 'invoke', channel: Channel.clipboardRead, args: [] },
      { kind: 'invoke', channel: Channel.clipboardWrite, args: ['x'] }
    ])
    vi.unstubAllGlobals()
  })
})
