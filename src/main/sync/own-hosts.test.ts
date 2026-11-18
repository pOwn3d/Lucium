// The addresses written in a QR and in a `hosts` (docs/synchronisation.md §4.2, §5).
import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isLocalAddress } from './address-policy'
import { ownHosts } from './own-hosts'

const iface = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: address.includes(':') ? 'IPv6' : 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null, scopeid: 0 }) as NetworkInterfaceInfo

describe('ownHosts', () => {
  it('writes the .local name first, in lower case, then the IPv4 addresses, then the IPv6 ones', () => {
    const hosts = ownHosts({ hostname: 'MacBook-Pro-de-Test.local', interfaces: { en0: [iface('fd12:3456:789a::1'), iface('192.168.1.20')], en1: [iface('10.0.0.7')] } })
    expect(hosts).toEqual(['macbook-pro-de-test.local', '192.168.1.20', '10.0.0.7', 'fd12:3456:789a::1'])
  })

  it('writes only addresses when the host name is not a .local name', () => {
    expect(ownHosts({ hostname: 'mbp.example.com', interfaces: { en0: [iface('192.168.1.20')] } })).toEqual(['192.168.1.20'])
    expect(ownHosts({ hostname: 'MacBook', interfaces: { en0: [iface('192.168.1.20')] } })).toEqual(['192.168.1.20'])
  })

  it('leaves out the loopback, the public addresses and the link-local IPv6 ones (no zone in a QR)', () => {
    const hosts = ownHosts({ hostname: 'x', interfaces: { lo0: [iface('127.0.0.1', true), iface('::1', true)], en0: [iface('8.8.8.8'), iface('fe80::1'), iface('2001:4860:4860::8888'), iface('192.168.1.20')] } })
    expect(hosts).toEqual(['192.168.1.20'])
  })

  it('leaves out an interface the system flags as internal, whatever address it carries', () => {
    expect(ownHosts({ hostname: 'x', interfaces: { bridge0: [iface('192.168.64.1', true)], en0: [iface('192.168.1.20')] } })).toEqual(['192.168.1.20'])
  })

  it('writes at most four, each of them readable back by the filter of the iPhone', () => {
    const hosts = ownHosts({ hostname: 'a.local', interfaces: { en0: [iface('10.0.0.1'), iface('10.0.0.2'), iface('10.0.0.3'), iface('10.0.0.4'), iface('10.0.0.5')] } })
    expect(hosts).toHaveLength(4)
    expect(hosts.every(isLocalAddress)).toBe(true)
  })

  it('writes nothing twice, and nothing when there is nothing to write', () => {
    expect(ownHosts({ hostname: 'a.local', interfaces: { en0: [iface('10.0.0.1')], en1: [iface('10.0.0.1')] } })).toEqual(['a.local', '10.0.0.1'])
    expect(ownHosts({ hostname: 'x', interfaces: { en0: undefined } })).toEqual([])
  })
})
