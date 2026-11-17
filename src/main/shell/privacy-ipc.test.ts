import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import { registerPrivacyIpc } from './privacy-ipc'

type Handler = (event: { sender: object }, ...args: unknown[]) => unknown

function setup(options: { private?: boolean; cookieManager?: boolean; trusted?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = {
    on: (channel, listener) => void handlers.set(channel, listener as Handler),
    handle: (channel, listener) => void handlers.set(channel, listener as Handler)
  }
  const calls: string[] = []
  const browser = {
    isPrivate: () => options.private === true,
    cookieSites: async () => (calls.push('sites'), []),
    cookieNames: async (host: string) => (calls.push(`names ${host}`), []),
    removeCookieSite: async (host: string) => (calls.push(`remove ${host}`), { removed: 1, failed: 0 }),
    cleanCookies: async () => (calls.push('clean'), { removed: 2, failed: 0 }),
    openPrivateTab: () => void calls.push('private tab')
  } as unknown as Browser
  const store = { get: () => ({ settings: { ...defaultSettings(), cookieManager: options.cookieManager !== false } }) }
  const guard = vi.fn(() => options.trusted !== false)
  registerPrivacyIpc(ipc, guard, browser, store as never)
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {} }, ...args)
  return { call, calls, guard }
}

describe('the cookies IPC', () => {
  it('lists, names, removes and cleans for a normal window with the view on', async () => {
    const { call, calls } = setup()
    await call(Channel.cookieSites)
    await call(Channel.cookieNames, 'Exemple.ORG')
    await call(Channel.cookieRemoveSite, 'exemple.org')
    await call(Channel.cookieClean)
    expect(calls).toEqual(['sites', 'names exemple.org', 'remove exemple.org', 'clean'])
  })

  it('refuses everything in a private window, which has no profile to manage', async () => {
    const { call, calls } = setup({ private: true })
    await expect(call(Channel.cookieSites)).rejects.toThrow()
    expect(await call(Channel.cookieNames, 'exemple.org')).toEqual([])
    await expect(call(Channel.cookieRemoveSite, 'exemple.org')).rejects.toThrow()
    await expect(call(Channel.cookieClean)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('refuses everything while the view is switched off', async () => {
    const { call, calls } = setup({ cookieManager: false })
    await expect(call(Channel.cookieSites)).rejects.toThrow()
    await expect(call(Channel.cookieClean)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('refuses a sender the window does not trust', async () => {
    const { call, calls } = setup({ trusted: false })
    await expect(call(Channel.cookieSites)).rejects.toThrow()
    expect(await call(Channel.cookieNames, 'exemple.org')).toEqual([])
    await expect(call(Channel.cookieRemoveSite, 'exemple.org')).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('removes nothing for a site that is not a plain host: a port, an address, a path, not even text', async () => {
    const { call, calls } = setup()
    for (const bad of ['exemple.org:8080', 'https://exemple.org', '../etc', '', 42, null, { host: 'exemple.org' }]) {
      await expect(call(Channel.cookieRemoveSite, bad)).rejects.toThrow('aucun cookie n’a été retiré')
      expect(await call(Channel.cookieNames, bad)).toEqual([])
    }
    expect(calls).toEqual([])
  })
})

describe('the proxy test and the private tab', () => {
  it('never connects for an address that is not a proxy address, nor for a sender that is not trusted', async () => {
    const trusted = setup()
    expect(await trusted.call(Channel.testProxy, 'http://user:secret@127.0.0.1:1')).toEqual({ ok: false, error: 'adresse non valide' })
    expect(await trusted.call(Channel.testProxy, 42)).toEqual({ ok: false, error: 'demande refusée' })
    expect(await setup({ trusted: false }).call(Channel.testProxy, '127.0.0.1:1')).toEqual({ ok: false, error: 'demande refusée' })
  })

  it('opens a private tab only for a trusted sender', () => {
    const ok = setup()
    ok.call(Channel.newPrivateTab)
    expect(ok.calls).toEqual(['private tab'])
    const refused = setup({ trusted: false })
    refused.call(Channel.newPrivateTab)
    expect(refused.calls).toEqual([])
  })
})
