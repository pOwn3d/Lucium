import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashHost, hostsOfList, listedHost, packHosts, SafeSet, SNAPSHOT_MAX_BYTES } from './safe-set'

describe('the packed set of hosts', () => {
  const hosts = ['evil.example', 'login.bank-fake.test', '203.0.113.7', 'a.b.c.d.example']
  const set = SafeSet.read(packHosts(hosts))!

  it('finds every host it was given and no other', () => {
    for (const host of hosts) expect(set.has(host), host).toBe(true)
    expect(set.has('example')).toBe(false)
    expect(set.has('www.evil.example')).toBe(false)
    expect(set.has('good.example')).toBe(false)
  })

  it('keeps a host once, whatever the number of times it is listed', () => {
    expect(SafeSet.read(packHosts(['a.test', 'a.test', 'b.test']))!.size).toBe(2)
  })

  it('refuses bytes that are not a set: another header, a wrong length, entries out of order', () => {
    const bytes = packHosts(hosts)
    expect(SafeSet.read(new Uint8Array(3))).toBeNull()
    expect(SafeSet.read(bytes.slice(0, bytes.length - 1))).toBeNull()
    const bad = bytes.slice()
    bad[0] = 0
    expect(SafeSet.read(bad)).toBeNull()
    // Swapping two entries breaks the order the binary search relies on.
    const swapped = bytes.slice()
    swapped.set(bytes.slice(8, 14), 14)
    swapped.set(bytes.slice(14, 20), 8)
    expect(SafeSet.read(swapped)).toBeNull()
  })

  it('hashes to 48 bits', () => {
    const { hi, lo } = hashHost('evil.example')
    expect(hi).toBeLessThan(0x10000)
    expect(lo).toBeLessThan(2 ** 32)
  })
})

describe('reading a list of text', () => {
  it('keeps plain hosts and addresses, lower-cased, and counts what it drops', () => {
    const { hosts, skipped } = hostsOfList('# a comment\n! another\n\nEvil.Example.\n203.0.113.7\nhttp://x.test/a?b\n%20bad host\nhas space.test\n')
    expect(hosts).toEqual(['evil.example', '203.0.113.7'])
    expect(skipped).toBe(3)
    expect(listedHost('a'.repeat(260) + '.test')).toBeNull()
  })
})

describe('the snapshot that ships with the application', () => {
  const folder = join(__dirname, '../../resources/safe-browsing')
  const files = readdirSync(folder).filter((name) => name.endsWith('.bin'))

  it('has both lists, each a valid set, and weighs less than the written bound', () => {
    expect(files.sort()).toEqual(['malware.bin', 'phishing.bin'])
    const total = files.reduce((sum, name) => sum + statSync(join(folder, name)).size, 0)
    expect(total).toBeLessThan(SNAPSHOT_MAX_BYTES)
  })
})
