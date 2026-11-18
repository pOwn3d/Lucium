// Which addresses the synchronisation talks to and hears from (docs/synchronisation.md §6.2): a network, not the Internet. An address is local when it is
// private, link-local or shared (the range VPN meshes use), or when it is a name that ends in `.local`. Everything else is refused: a public address, the
// loopback, the unspecified and broadcast addresses, and any other name (a DNS name can point at any machine).
//
// The same filter is applied to the source address of every connection the Mac hears (before the handshake: `isLocalSource`) and to every host a QR, a
// typed address or a `hosts` list names (`isLocalAddress`). The vectors of ios/Contracts/sync-pairing-vectors.json (`addressPolicy`) are played against it.

import { BlockList, isIPv4, isIPv6 } from 'node:net'

const LOCAL = new BlockList()
for (const [network, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]] as const) LOCAL.addSubnet(network, bits, 'ipv4')
LOCAL.addSubnet('fc00::', 7, 'ipv6')
LOCAL.addSubnet('fe80::', 10, 'ipv6')

/** A name of the local network: at least one label before `.local`, each label a lower-case DNS label. */
const LOCAL_NAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+local$/
const HOST_MAX = 253

/**
 * Whether a host written in a QR, a typed address or a `hosts` list is local. Strict: an IPv6 address carries no zone (`fe80::1%en0` is refused), a name
 * is lower-case, and anything that is not exactly an address or a `.local` name is refused.
 */
export function isLocalAddress(host: string): boolean {
  if (host.length === 0 || host.length > HOST_MAX) return false
  if (isIPv4(host)) return LOCAL.check(host, 'ipv4')
  // An IPv4 address written in IPv6 (`::ffff:192.168.1.5`, `::ffff:c0a8:105`, in any spelling) is matched by `BlockList` against the IPv4 ranges: the vectors and
  // the tests below pin that behaviour of Node, so that a runtime that changed it would fail loudly instead of letting a public address through.
  if (isIPv6(host) && !host.includes('%')) return LOCAL.check(host, 'ipv6')
  return LOCAL_NAME.test(host)
}

/**
 * Whether the source address of a connection (`socket.remoteAddress`) is local. A link-local IPv6 peer may be reported with the interface it came in on
 * (`fe80::1%en0`): the zone is cut off before the check. A name is never a source address: an unknown or missing address is refused.
 */
export function isLocalSource(address: string | undefined): boolean {
  if (address === undefined || address === '') return false
  const zone = address.indexOf('%')
  const bare = zone < 0 ? address : address.slice(0, zone)
  return isIPv4(bare) || isIPv6(bare) ? isLocalAddress(bare) : false
}
