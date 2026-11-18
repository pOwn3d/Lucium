// The filter of local addresses (docs/synchronisation.md §6.2) against the shared vectors, and the source-address variant the listener uses before a handshake.
import { describe, expect, it } from 'vitest'
import { isLocalAddress, isLocalSource } from './address-policy'
import { pairingVectors } from './sync-vectors.test-support'

describe('isLocalAddress: the vectors of the specification', () => {
  it.each(pairingVectors.addressPolicy.map((v) => [JSON.stringify(v.host), v] as const))('%s', (_label, v) => {
    expect(isLocalAddress(v.host)).toBe(v.allowed)
  })

  it('has both answers for each family, so that a filter that always says yes (or always no) fails', () => {
    for (const family of [(h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h), (h: string) => h.includes(':'), (h: string) => h.endsWith('.local')]) {
      const group = pairingVectors.addressPolicy.filter((v) => family(v.host))
      expect(group.some((v) => v.allowed)).toBe(true)
      expect(group.some((v) => !v.allowed)).toBe(true)
    }
  })

  it('refuses a host longer than a DNS name can be', () => {
    expect(isLocalAddress(`${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.local`)).toBe(false)
    expect(isLocalAddress(`${Array.from({ length: 3 }, () => 'a'.repeat(60)).join('.')}.local`)).toBe(true)
  })

  it('refuses an IPv6 address that carries a zone: a host of a QR never names an interface', () => {
    expect(isLocalAddress('fe80::1%en0')).toBe(false)
    expect(isLocalAddress('fe80::1%1')).toBe(false)
  })

  it('reads an IPv4 address written in IPv6 in hexadecimal like the one in dots', () => {
    for (const spelling of ['::ffff:c0a8:105', '::FFFF:C0A8:105', '0:0:0:0:0:ffff:c0a8:105', '::ffff:192.168.1.5']) expect(isLocalAddress(spelling), spelling).toBe(true)
    for (const spelling of ['::ffff:808:808', '0:0:0:0:0:ffff:808:808', '::ffff:7f00:1', '::ffff:8.8.8.8']) expect(isLocalAddress(spelling), spelling).toBe(false)
  })
})

describe('isLocalSource: the address a connection comes from', () => {
  it('lets in the addresses of the local network, as a dual-stack socket reports them', () => {
    for (const address of ['192.168.1.20', '10.1.2.3', '::ffff:192.168.1.20', '::ffff:c0a8:114', 'fe80::1', 'fd12:3456:789a::1', '100.64.3.4']) expect(isLocalSource(address), address).toBe(true)
  })

  it('cuts the zone of a link-local address before it asks', () => {
    expect(isLocalSource('fe80::1%en0')).toBe(true)
    expect(isLocalSource('2001:4860:4860::8888%en0')).toBe(false)
  })

  it('refuses a public address, the loopback and the unspecified ones', () => {
    for (const address of ['8.8.8.8', '127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', '::', '2001:4860:4860::8888', '::ffff:8.8.8.8', '1.1.1.1']) expect(isLocalSource(address), address).toBe(false)
  })

  it('refuses a name, an empty address and a missing one: a source is an address, nothing else', () => {
    for (const address of ['mac.local', 'example.com', '', undefined]) expect(isLocalSource(address), String(address)).toBe(false)
  })
})
