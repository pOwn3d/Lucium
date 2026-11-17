// The start of Widevine on the castLabs build of Electron, and nothing on the Electron of the project.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WIDEVINE_TIMEOUT_MS, componentsOf, installWidevine, widevineLateNotice, widevineNotice, type Components } from './widevine'

const READY = { oimompecagnajdejgnnjijobebaeigek: { status: 'updated', title: 'Widevine Content Decryption Module', version: '4.10.3112.0' } }
const components = (over: Partial<Components> = {}): Components => ({ whenReady: async () => undefined, status: () => READY, ...over })

describe('componentsOf', () => {
  it('finds the module of the castLabs build', () => {
    const module = components()
    expect(componentsOf({ components: module })).toBe(module)
  })

  it('answers null on the Electron of the project, which has none, and on anything that is not the module', () => {
    for (const electron of [{}, {}, null, undefined, { components: undefined }, { components: null }, { components: {} }, { components: { whenReady: () => undefined } }, { components: 'x' }]) expect(componentsOf(electron), JSON.stringify(electron)).toBeNull()
  })
})

describe('installWidevine', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does nothing, and says nothing, where there is no module: nothing is contacted', async () => {
    const log = vi.fn()
    await expect(installWidevine(null, { log })).resolves.toEqual({ state: 'absent' })
    expect(log).not.toHaveBeenCalled()
  })

  it('waits for the module and says which version is there', async () => {
    const log = vi.fn()
    await expect(installWidevine(components(), { log })).resolves.toEqual({ state: 'ready', version: '4.10.3112.0' })
    expect(log).toHaveBeenCalledWith('[widevine] ready (version 4.10.3112.0)')
  })

  it('says in the log, before anything, that it asks Google’s component updater (the one connection of the DRM build nobody asked for)', async () => {
    const log = vi.fn()
    await installWidevine(components(), { log })
    expect(log.mock.calls[0]).toEqual(['[widevine] asking Google’s component updater for the module (DRM build only)'])
  })

  it('is ready without a version when the status does not list it', async () => {
    await expect(installWidevine(components({ status: () => ({}) }))).resolves.toEqual({ state: 'ready', version: undefined })
  })

  it('says why when the module cannot be installed (no network, a refusal), and does not throw', async () => {
    const log = vi.fn()
    const failing = components({
      whenReady: async () => {
        throw new Error('network down')
      }
    })
    await expect(installWidevine(failing, { log })).resolves.toEqual({ state: 'failed', reason: 'network down' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('network down'))
  })

  it('gives up after the time given, rather than waiting for ever', async () => {
    const log = vi.fn()
    const never = components({ whenReady: () => new Promise(() => undefined) })
    const outcome = installWidevine(never, { timeoutMs: 5000, log })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(outcome).resolves.toEqual({ state: 'failed', reason: 'not ready after 5 s' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not ready after 5 s'))
  })

  it('waits two minutes by default, and leaves no timer behind once it is ready', async () => {
    expect(WIDEVINE_TIMEOUT_MS).toBe(120_000)
    await installWidevine(components())
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('telling the user that protected videos will not play', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says it once when the module cannot be installed: the log is for the maintainer, the person who opens Netflix would only see its own error', async () => {
    const notify = vi.fn()
    const failing = components({
      whenReady: async () => {
        throw new Error('network down')
      }
    })
    await installWidevine(failing, { notify })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(widevineNotice('network down'))
    const notice = notify.mock.calls[0]![0] as { title: string; body: string }
    expect(notice.title).toContain('protégés')
    expect(notice.body).toContain('network down')
    expect(notice.body).toContain('Netflix')
  })

  it('says it too when the module does not answer in time', async () => {
    const notify = vi.fn()
    const outcome = installWidevine(components({ whenReady: () => new Promise(() => undefined) }), { timeoutMs: 5000, notify })
    await vi.advanceTimersByTimeAsync(5000)
    await outcome
    expect(notify).toHaveBeenCalledWith(widevineNotice('not ready after 5 s'))
  })

  // On a slow line the module arrives after the two minutes: the person was told the videos would not play, and they do at the next launch for no visible reason.
  it('says it once more when the module arrives after the wait: the videos play from then on', async () => {
    const notify = vi.fn()
    const log = vi.fn()
    let arrive: () => void = () => undefined
    const slow = components({ whenReady: () => new Promise<void>((resolve) => (arrive = resolve)) })
    const outcome = installWidevine(slow, { timeoutMs: 5000, notify, log })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(outcome).resolves.toEqual({ state: 'failed', reason: 'not ready after 5 s' })
    expect(notify).toHaveBeenCalledTimes(1)
    arrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(notify.mock.calls.map(([notice]) => notice)).toEqual([widevineNotice('not ready after 5 s'), widevineLateNotice()])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ready after the wait'))
  })

  it('says in the log, and to nobody, when the installation fails after the wait too', async () => {
    const notify = vi.fn()
    const log = vi.fn()
    let fail: (error: Error) => void = () => undefined
    const slow = components({ whenReady: () => new Promise<void>((_, reject) => (fail = reject)) })
    const outcome = installWidevine(slow, { timeoutMs: 5000, notify, log })
    await vi.advanceTimersByTimeAsync(5000)
    await outcome
    fail(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await vi.advanceTimersByTimeAsync(0)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed after the wait too: net::ERR_INTERNET_DISCONNECTED'))
  })

  it('does not say it for a module that failed at once: there was no wait to outlast', async () => {
    const notify = vi.fn()
    await installWidevine(components({ whenReady: async () => Promise.reject(new Error('refused')) }), { notify })
    await vi.advanceTimersByTimeAsync(0)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the module is ready, nor on the Electron of the project (no module, nothing wrong)', async () => {
    const notify = vi.fn()
    await installWidevine(components(), { notify })
    await installWidevine(null, { notify })
    expect(notify).not.toHaveBeenCalled()
  })
})
