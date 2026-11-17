import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { OPEN_WHILE_LOCKED } from '@shared/lock'
import type { ExtensionsReply, ExtensionsRequest } from '@shared/extension-page'
import type { ScopedIpc } from './ipc-scope'
import { registerExtensionsIpc } from './extensions-ipc'
import { frenchSpaces } from '@shared/french-typography'

type Handler = (event: { sender: object }, ...args: unknown[]) => unknown

const ID = 'abcdefghijklmnopabcdefghijklmnop'

function setup(options: { trusted?: boolean; service?: (request: ExtensionsRequest) => Promise<ExtensionsReply> } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = {
    on: (channel, listener) => void handlers.set(channel, listener as Handler),
    handle: (channel, listener) => void handlers.set(channel, listener as Handler)
  }
  const handled: ExtensionsRequest[] = []
  const service = { handle: vi.fn(options.service ?? (async (request: ExtensionsRequest): Promise<ExtensionsReply> => (handled.push(request), { ok: true }))) }
  const guard = vi.fn(() => options.trusted !== false)
  registerExtensionsIpc(ipc, guard, service)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return { call: (raw: unknown) => handlers.get(Channel.extensionsPage)!({ sender: {} }, raw) as Promise<ExtensionsReply>, service, handled, guard, warn, error, handlers }
}

describe('the IPC of the Extensions page', () => {
  it('registers one channel, and runs a request it understands through the service, after the guard', async () => {
    const t = setup()
    expect([...t.handlers.keys()]).toEqual([Channel.extensionsPage])
    expect(await t.call({ op: 'reload', profileId: 'default', extensionId: ID })).toEqual({ ok: true })
    expect(t.handled).toEqual([{ op: 'reload', profileId: 'default', extensionId: ID }])
    expect(t.guard).toHaveBeenCalledWith(expect.anything(), Channel.extensionsPage)
  })

  it('is not among the channels a locked application answers: the page asks nothing while the lock holds', () => {
    expect(OPEN_WHILE_LOCKED.has(Channel.extensionsPage)).toBe(false)
  })

  it('answers a sender the window does not trust with a refusal, and the service never hears of it', async () => {
    const t = setup({ trusted: false })
    expect(await t.call({ op: 'reload', profileId: 'default', extensionId: ID })).toMatchObject({ ok: false })
    expect(t.service.handle).not.toHaveBeenCalled()
  })

  it('does not run a request that is not exactly one the page makes, and says so', async () => {
    const t = setup()
    for (const raw of [null, 'reload', { op: 'eval', code: '1' }, { op: 'load-unpacked', path: '/' }, { op: 'reload', profileId: 'default', extensionId: 'nope' }, { op: 'reload', profileId: '../x', extensionId: ID }]) {
      const reply = await t.call(raw)
      expect(reply.ok, JSON.stringify(raw)).toBe(false)
      expect(reply.message, JSON.stringify(raw)).toBeTruthy()
    }
    expect(t.service.handle).not.toHaveBeenCalled()
    expect(t.warn).toHaveBeenCalledTimes(6)
  })

  it('tells the person, and logs the cause, when the service itself fails', async () => {
    const t = setup({
      service: async () => {
        throw new Error('the disk went away')
      }
    })
    const reply = await t.call({ op: 'details' })
    expect(reply).toEqual({ ok: false, message: frenchSpaces('L’action a échoué : the disk went away') })
    expect(t.error).toHaveBeenCalledWith(expect.stringContaining('details'), expect.any(Error))
  })
})
