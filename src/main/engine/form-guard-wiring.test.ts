// The form guard in the real engine, over a stand-in of Electron (engine-constructed.test-support.ts): the preload is in the sessions of the profiles and of
// the private contexts only while the setting is on, the channel has its listener only then, and the listener answers every message: a yes lets the form go,
// every other answer stops it. The page side: src/preload/form-guard.test.ts; the rule: engine/form-guard.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FORM_GUARD } from '@shared/form-guard-wire'
import { constructEngine, world } from './engine-constructed.test-support'

vi.mock('electron', async () => (await import('./engine-constructed.test-support')).engineElectron())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined, handleCRXProtocol: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

afterEach(() => vi.restoreAllMocks())

const session = () => ({ registerPreloadScript: vi.fn(), unregisterPreloadScript: vi.fn() })

async function engineWith() {
  const engine = await constructEngine()
  const inside = engine as unknown as { profiles: Map<string, unknown>; scopes: Map<string, unknown>; pageByContents: Map<number, string>; setInsecureFormGuard(ask: unknown): void }
  const profile = session()
  const scope = session()
  inside.profiles.set('p', { session: profile })
  inside.scopes.set('private', { session: scope })
  return { engine, inside, profile, scope }
}

/** A message of the preload: its frame is the main frame of the contents unless `frame` says another. */
function message(frameUrl: string, options: { main?: boolean } = {}) {
  const main = { url: frameUrl }
  const event = { sender: { id: 7, mainFrame: main }, senderFrame: options.main === false ? { url: frameUrl } : main, returnValue: undefined as unknown }
  return event
}
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the form guard in the engine', () => {
  it('registers the preload in the sessions of the profiles and the private contexts, and hears the channel, only while it is on', async () => {
    const { inside, profile, scope } = await engineWith()
    expect(world.ipcOn.has(FORM_GUARD.ask)).toBe(false)
    inside.setInsecureFormGuard(async () => true)
    expect(world.ipcOn.has(FORM_GUARD.ask)).toBe(true)
    for (const ses of [profile, scope]) expect(ses.registerPreloadScript).toHaveBeenCalledWith(expect.objectContaining({ id: 'lucium-form-guard', type: 'frame', filePath: expect.stringContaining('form-guard.js') }))
    inside.setInsecureFormGuard(async () => false)
    for (const ses of [profile, scope]) expect(ses.registerPreloadScript).toHaveBeenCalledTimes(1)
    inside.setInsecureFormGuard(null)
    expect(world.ipcOn.has(FORM_GUARD.ask)).toBe(false)
    for (const ses of [profile, scope]) expect(ses.unregisterPreloadScript).toHaveBeenCalledWith('lucium-form-guard')
    // The first test loads the whole engine, which a busy machine makes slow.
  }, 60_000)

  it('asks the shell with the host and the page, and lets the form go on a yes', async () => {
    const { inside } = await engineWith()
    const ask = vi.fn(async () => true)
    inside.pageByContents.set(7, 'tab-1')
    inside.setInsecureFormGuard(ask)
    const event = message('https://shop.example.com/cart')
    world.ipcOn.get(FORM_GUARD.ask)!(event, { action: 'http://pay.example.net/in' })
    await flush()
    expect(ask).toHaveBeenCalledWith({ host: 'pay.example.net', pageId: 'tab-1' })
    expect(event.returnValue).toBe(true)
  })

  it('stops the form on a no', async () => {
    const { inside } = await engineWith()
    inside.setInsecureFormGuard(async () => false)
    const event = message('https://shop.example.com/cart')
    world.ipcOn.get(FORM_GUARD.ask)!(event, { action: 'http://pay.example.net/in' })
    await flush()
    expect(event.returnValue).toBe(false)
  })

  it('stops the form, with a line in the log, when the box could not be shown', async () => {
    const { inside } = await engineWith()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    inside.setInsecureFormGuard(async () => Promise.reject(new Error('no window')))
    const event = message('https://shop.example.com/cart')
    world.ipcOn.get(FORM_GUARD.ask)!(event, { action: 'http://pay.example.net/in' })
    await flush()
    expect(event.returnValue).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('does not ask for what is no question (https, the local network), and answers yes', async () => {
    const { inside } = await engineWith()
    const ask = vi.fn(async () => false)
    inside.setInsecureFormGuard(ask)
    for (const action of ['https://pay.example.net/in', 'http://192.168.1.1/login']) {
      const event = message('https://shop.example.com/cart')
      world.ipcOn.get(FORM_GUARD.ask)!(event, { action })
      expect(event.returnValue, action).toBe(true)
    }
    expect(ask).not.toHaveBeenCalled()
  })

  it('stops the form of a frame that is not the main frame, and of a message that is not the preload’s, and does not ask', async () => {
    const { inside } = await engineWith()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ask = vi.fn(async () => true)
    inside.setInsecureFormGuard(ask)
    const frame = message('https://shop.example.com/cart', { main: false })
    world.ipcOn.get(FORM_GUARD.ask)!(frame, { action: 'http://pay.example.net/in' })
    const shape = message('https://shop.example.com/cart')
    world.ipcOn.get(FORM_GUARD.ask)!(shape, { action: 'http://pay.example.net/in', password: 'x' })
    expect([frame.returnValue, shape.returnValue]).toEqual([false, false])
    expect(ask).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
