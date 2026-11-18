// The addresses the iPhone may come back to (docs/synchronisation.md §4.2, §5): the `.local` name of the Mac first (the system resolves it by mDNS, so it follows the Mac
// when its address changes), then its IPv4 addresses, then its IPv6 ones, at most four, every one of them local (§6.2). Nothing else is written in a QR or a `hosts`.
//
// The name is `os.hostname()` when it is a `.local` name, written in lower case; when it is not (a Mac whose host name is a DNS name) only addresses are written.
// Whether Electron's `os.hostname()` gives a `.local` name on a real Mac is to be checked on a build (§17). A link-local IPv6 address (`fe80::…`) is left out: it
// cannot be dialled without the interface it belongs to, and a QR carries no zone.

import type { NetworkInterfaceInfo } from 'node:os'
import { isLocalAddress } from './address-policy'
import { MAX_HOSTS } from './limits'

export interface HostEnvironment {
  hostname: string
  interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>
}

const isLinkLocalV6 = (address: string): boolean => /^fe[89ab]/i.test(address)

export function ownHosts(env: HostEnvironment): string[] {
  const name = env.hostname.toLowerCase()
  const names = name.endsWith('.local') && isLocalAddress(name) ? [name] : []
  const addresses = Object.values(env.interfaces)
    .flatMap((list) => list ?? [])
    .filter((info) => !info.internal)
    .map((info) => info.address.toLowerCase())
    .filter((address) => isLocalAddress(address) && !isLinkLocalV6(address))
  const v4 = addresses.filter((address) => !address.includes(':'))
  const v6 = addresses.filter((address) => address.includes(':'))
  return [...new Set([...names, ...v4, ...v6])].slice(0, MAX_HOSTS)
}
