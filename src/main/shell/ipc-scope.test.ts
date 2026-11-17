import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseIpcScope, scopedIpc, type IpcHost } from './ipc-scope'

/** A stand-in for ipcMain: one listener per channel for `on`, and a throw on a second `handle`, like Electron. */
function fakeHost() {
  const listeners = new Map<string, (event: any, ...args: any[]) => void>()
  const handlers = new Map<string, (event: any, ...args: any[]) => unknown>()
  const host: IpcHost = {
    on: (channel, listener) => {
      listeners.set(channel, listener)
    },
    handle: (channel, listener) => {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      handlers.set(channel, listener)
    }
  }
  // Every sender has a top frame; a message comes from it unless the test says otherwise.
  const event = (senderId: number, fromSubframe: boolean) => {
    const mainFrame = { top: true }
    return { sender: { id: senderId, mainFrame, getURL: () => 'https://evil.example/page?secret=1#frag' }, senderFrame: fromSubframe ? { top: false } : mainFrame }
  }
  return {
    host,
    send: (channel: string, senderId: number, ...args: unknown[]) => listeners.get(channel)?.(event(senderId, false), ...args),
    invoke: (channel: string, senderId: number, ...args: unknown[]) => handlers.get(channel)?.(event(senderId, false), ...args),
    sendFromSubframe: (channel: string, senderId: number, ...args: unknown[]) => listeners.get(channel)?.(event(senderId, true), ...args),
    invokeFromSubframe: (channel: string, senderId: number, ...args: unknown[]) => handlers.get(channel)?.(event(senderId, true), ...args)
  }
}

afterEach(() => vi.restoreAllMocks())

describe('scopedIpc', () => {
  it('answers a message with the handler of the window that sent it, on one real handler per channel', () => {
    const { host, send, invoke } = fakeHost()
    const main = new Set([1, 2])
    const priv = new Set([10, 11])
    const seen: string[] = []
    for (const [name, trusted] of [['main', main], ['private', priv]] as const) {
      const ipc = scopedIpc(host, trusted)
      ipc.on('nav', (_e, command: string) => seen.push(`${name}:${command}`))
      ipc.handle('snapshot', () => `${name} snapshot`)
    }
    send('nav', 2, 'back')
    send('nav', 11, 'reload')
    expect(seen).toEqual(['main:back', 'private:reload'])
    expect(invoke('snapshot', 1)).toBe('main snapshot')
    expect(invoke('snapshot', 10)).toBe('private snapshot')
  })

  it('answers a sender no scope trusts with nothing, before any handler runs, on a message and on a request alike', () => {
    const { host, send, invoke } = fakeHost()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reached: string[] = []
    // Handlers that never ask who is calling: the scope alone has to keep a stranger out.
    for (const trusted of [new Set([1]), new Set([10])]) {
      const ipc = scopedIpc(host, trusted)
      ipc.on('nav', () => reached.push('on'))
      ipc.handle('snapshot', () => {
        reached.push('handle')
        return 'secret snapshot'
      })
    }
    send('nav', 99)
    expect(invoke('snapshot', 99)).toBeUndefined()
    expect(reached).toEqual([])
    // The line names the channel and the page without its query or its fragment (the guard of a handler logs the same way).
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[ipc] ignored nav from untrusted sender https://evil.example/page',
      '[ipc] ignored snapshot from untrusted sender https://evil.example/page'
    ])
    // The windows it does trust are still answered.
    send('nav', 10)
    expect(invoke('snapshot', 1)).toBe('secret snapshot')
    expect(reached).toEqual(['on', 'handle'])
  })

  it('refuses a stranger whose address cannot be read (a web contents destroyed under the message) without throwing', () => {
    const listeners = new Map<string, (event: any, ...args: any[]) => unknown>()
    const host: IpcHost = { on: (channel, listener) => void listeners.set(channel, listener), handle: (channel, listener) => void listeners.set(channel, listener) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const calls: string[] = []
    const ipc = scopedIpc(host, new Set([1]))
    ipc.on('nav', () => calls.push('on'))
    ipc.handle('snapshot', () => calls.push('handle'))
    const mainFrame = {}
    const gone = { sender: { id: 99, mainFrame, getURL: () => { throw new Error('Object has been destroyed') } }, senderFrame: mainFrame }
    const blank = { sender: { id: 99, mainFrame }, senderFrame: mainFrame }
    for (const event of [gone, blank]) {
      expect(() => listeners.get('nav')!(event)).not.toThrow()
      expect(listeners.get('snapshot')!(event)).toBeUndefined()
    }
    expect(calls).toEqual([])
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it('reads who is trusted at the time of the message: a surface that joins its scope later is answered, one that leaves is not', () => {
    const { host, send, invoke } = fakeHost()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const trusted = new Set([1])
    const ipc = scopedIpc(host, trusted)
    const calls: number[] = []
    ipc.on('nav', (e) => calls.push(e.sender.id))
    ipc.handle('snapshot', (e) => e.sender.id)
    // The Settings window or a mini window opens after the handlers were registered, and trusts itself then.
    expect(invoke('snapshot', 5)).toBeUndefined()
    trusted.add(5)
    send('nav', 5)
    expect(invoke('snapshot', 5)).toBe(5)
    trusted.delete(5)
    send('nav', 5)
    expect(invoke('snapshot', 5)).toBeUndefined()
    expect(calls).toEqual([5])
  })

  it('stops answering for a released scope and no longer keeps its handlers', () => {
    const { host, send, invoke } = fakeHost()
    const priv = new Set([10])
    const calls: string[] = []
    scopedIpc(host, new Set([1])).on('nav', () => calls.push('main'))
    scopedIpc(host, priv).on('nav', () => calls.push('private'))
    scopedIpc(host, new Set([1])).handle('snapshot', () => 'main snapshot')
    scopedIpc(host, priv).handle('snapshot', () => 'private snapshot')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    releaseIpcScope(host, priv)
    send('nav', 10)
    expect(calls).toEqual([])
    send('nav', 1)
    expect(calls).toEqual(['main'])
    // A message of a closed window is a stranger's: it reaches no handler, neither the released one nor the main window's.
    expect(invoke('snapshot', 10)).toBeUndefined()
  })

  it('does not answer a message that comes from a subframe of a trusted surface', () => {
    const { host, send, invoke, sendFromSubframe, invokeFromSubframe } = fakeHost()
    const calls: string[] = []
    const ipc = scopedIpc(host, new Set([1]))
    ipc.on('nav', (_e, command: string) => calls.push(command))
    ipc.handle('snapshot', () => 'snapshot')
    sendFromSubframe('nav', 1, 'from-subframe')
    send('nav', 1, 'from-top')
    expect(calls).toEqual(['from-top'])
    expect(invokeFromSubframe('snapshot', 1)).toBeUndefined()
    expect(invoke('snapshot', 1)).toBe('snapshot')
  })

  it('keeps each registry apart per host', () => {
    const a = fakeHost()
    const b = fakeHost()
    const calls: string[] = []
    scopedIpc(a.host, new Set([1])).on('nav', () => calls.push('a'))
    scopedIpc(b.host, new Set([1])).on('nav', () => calls.push('b'))
    a.send('nav', 1)
    expect(calls).toEqual(['a'])
  })

  it('answers the web contents a live rule names, as the Extensions page in a tab is: whatever is a page of the window when the message comes, and no other', () => {
    const { host, send, invoke } = fakeHost()
    const pages = new Set<number>()
    const live = { has: (id: number) => pages.has(id) }
    const ipc = scopedIpc(host, live)
    const calls: string[] = []
    ipc.on('lucium-ui:open-web-store', () => calls.push('store'))
    ipc.handle('lucium-ui:get-snapshot', () => 'snapshot')
    // No tab shows the page yet: a message from any web contents is a stranger's.
    send('lucium-ui:open-web-store', 5)
    expect(invoke('lucium-ui:get-snapshot', 5)).toBeUndefined()
    pages.add(5)
    send('lucium-ui:open-web-store', 5)
    expect(invoke('lucium-ui:get-snapshot', 5)).toBe('snapshot')
    // The tab goes elsewhere or closes: the same web contents is a stranger again, with no registration to undo.
    pages.delete(5)
    send('lucium-ui:open-web-store', 5)
    expect(calls).toEqual(['store'])
    expect(invoke('lucium-ui:get-snapshot', 5)).toBeUndefined()
    // A window that is gone lets go of the rule it registered.
    pages.add(5)
    releaseIpcScope(host, live)
    send('lucium-ui:open-web-store', 5)
    expect(calls).toEqual(['store'])
  })
})
