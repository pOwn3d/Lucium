import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import type { OmniboxRequest } from '@shared/omnibox'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import { registerKeyExtIpc } from './key-ext-ipc'

type Handler = (event: { sender: object }, ...args: unknown[]) => unknown

const ID = 'abcdefghijklmnopabcdefghijklmnop'

function setup(options: { on?: boolean; trusted?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = {
    on: (channel, listener) => void handlers.set(channel, listener as Handler),
    handle: (channel, listener) => void handlers.set(channel, listener as Handler)
  }
  const sent: OmniboxRequest[] = []
  const browser = { omniboxEnter: (request: OmniboxRequest) => void sent.push(request) } as unknown as Browser
  const store = { get: () => ({ settings: { ...defaultSettings(), omniboxKeywords: options.on !== false } }) }
  const guard = vi.fn(() => options.trusted !== false)
  registerKeyExtIpc(ipc, guard, browser, store as never)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  return { call: (raw: unknown) => handlers.get(Channel.omniboxEnter)!({ sender: {} }, raw), sent, warn, guard }
}

describe('the extension keyword IPC', () => {
  it('hands a well-formed request to the browser', () => {
    const t = setup()
    t.call({ extensionId: ID, text: 'react', disposition: 'currentTab' })
    expect(t.sent).toEqual([{ extensionId: ID, text: 'react', disposition: 'currentTab' }])
    expect(t.guard).toHaveBeenCalledWith(expect.anything(), Channel.omniboxEnter)
  })

  it('refuses a sender the window does not trust, and says nothing to the browser', () => {
    const t = setup({ trusted: false })
    t.call({ extensionId: ID, text: 'react', disposition: 'currentTab' })
    expect(t.sent).toEqual([])
  })

  it('refuses everything, and logs why, while the function is off', () => {
    const t = setup({ on: false })
    t.call({ extensionId: ID, text: 'react', disposition: 'currentTab' })
    expect(t.sent).toEqual([])
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('off'))
  })

  it('ignores, and logs, a request that is not exactly an id, a text and a place', () => {
    const t = setup()
    for (const raw of [null, 'gh', { extensionId: 'nope', text: 'x', disposition: 'currentTab' }, { extensionId: ID, text: 'x', disposition: 'popup' }, { extensionId: ID, text: 'x', disposition: 'currentTab', extra: 1 }, { extensionId: ID, text: 7, disposition: 'currentTab' }]) t.call(raw)
    expect(t.sent).toEqual([])
    expect(t.warn).toHaveBeenCalledTimes(6)
  })
})
