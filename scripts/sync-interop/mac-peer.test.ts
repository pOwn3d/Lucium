// What the Mac of the interoperability check promises its driver (scripts/sync-interop/README.md), without a phone: the address it chooses, what it reports of its state, and what
// its control server does. The check itself (the phone on the other end) is run by scripts/sync-interop/run.sh and is not part of `pnpm test`.
import type { NetworkInterfaceInfo } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { chooseHost, ControlServer, MacPeer, summaryOf } from './mac-peer'

const info = (address: string, internal = false, family: 'IPv4' | 'IPv6' = 'IPv4'): NetworkInterfaceInfo =>
  family === 'IPv4'
    ? { address, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }
    : { address, family, internal, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: `${address}/64`, scopeid: 0 }

describe('the address the Mac of the check listens on', () => {
  it('is a private IPv4 address of a physical interface, before a bridge, never the loopback', () => {
    const chosen = chooseHost({}, { lo0: [info('127.0.0.1', true)], bridge100: [info('192.168.139.3')], en0: [info('fe80::1', false, 'IPv6'), info('192.168.1.6')] })
    expect(chosen).toEqual({ name: 'en0', address: '192.168.1.6' })
  })

  it('refuses a machine with no private address, and says how to choose the interface', () => {
    expect(() => chooseHost({}, { lo0: [info('127.0.0.1', true)], en0: [info('8.8.8.8')] })).toThrow(/LUCIUM_INTEROP_INTERFACE/)
  })

  it('takes only the interface it is told to', () => {
    expect(chooseHost({ LUCIUM_INTEROP_INTERFACE: 'en7' }, { en0: [info('192.168.1.6')], en7: [info('10.0.0.9')] })).toEqual({ name: 'en7', address: '10.0.0.9' })
    expect(() => chooseHost({ LUCIUM_INTEROP_INTERFACE: 'en9' }, { en0: [info('192.168.1.6')] })).toThrow()
  })
})

const servers: ControlServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop()
})

async function control(): Promise<{ call: (method: string, path: string, body?: unknown) => Promise<unknown>; server: ControlServer }> {
  const server = new ControlServer(() => new MacPeer({ host: { name: 'test', address: '192.168.1.2' } }))
  servers.push(server)
  const port = await server.serve()
  return {
    server,
    call: async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      return response.json()
    }
  }
}

describe('the control server of the Mac of the check', () => {
  it('seeds Today tabs older than the 20 seconds an admission asks, and reports them', async () => {
    const { call, server } = await control()
    await call('POST', '/seed-today', { count: 200, spaceId: 'sp-mac', prefix: 'mac-t' })
    const state = (await call('GET', '/state')) as ReturnType<typeof summaryOf>
    expect(state.tabs.filter((tab) => tab.id.startsWith('mac-t') && !tab.pinned)).toHaveLength(200)
    const youngest = Math.max(...server.peer.state.tabs.map((tab) => tab.lastActiveAt ?? 0))
    expect(Date.now() - youngest).toBeGreaterThan(20_000)
  })

  it('applies an action of the reducer as a person would, and tells the marks', async () => {
    const { call, server } = await control()
    let told = 0
    server.peer.service.status()
    // The subscribers of the state are the marks of the service: a change must reach them.
    ;(server.peer as unknown as { listeners: Array<() => void> }).listeners.push(() => void told++)
    await call('POST', '/dispatch', { action: { type: 'tab/open', url: 'https://a.example/', spaceId: 'sp-mac', background: true } })
    expect(told).toBe(1)
    const state = (await call('GET', '/state')) as ReturnType<typeof summaryOf>
    expect(state.tabs.some((tab) => tab.url === 'https://a.example/')).toBe(true)
  })

  it('refuses a route it does not have, and a reset gives a Mac with nothing of the last one', async () => {
    const { call, server } = await control()
    await expect(call('GET', '/nothing')).rejects.toThrow(/404/)
    await call('POST', '/seed-today', { count: 3, spaceId: 'sp-mac', prefix: 'x' })
    const before = server.peer
    await call('POST', '/reset')
    expect(server.peer).not.toBe(before)
    expect(server.peer.dir).not.toBe(before.dir)
    expect(server.peer.state.tabs.filter((tab) => tab.id.startsWith('x'))).toHaveLength(0)
  })

  it('does not listen before the phone has asked for a pairing: no door is open on a Mac that was only started', async () => {
    const { call } = await control()
    const status = (await call('GET', '/status')) as { listening: boolean; enabled: boolean }
    expect(status).toMatchObject({ listening: false, enabled: false })
  })
})
