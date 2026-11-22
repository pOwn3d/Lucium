import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashHost, hostsOfList, listedHost, packHosts, SafeSet, SHARED_HOSTS, SNAPSHOT_MAX_BYTES, withoutSharedHosts } from './safe-set'

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

  it('hashes to 64 bits, 8 bytes a host after the 8 of the header', () => {
    const { hi, lo } = hashHost('evil.example')
    expect(hi).toBeLessThan(2 ** 32)
    expect(lo).toBeLessThan(2 ** 32)
    // Both halves spread over their whole range: a half held to 16 bits would give 48 bits, the 6-byte entry of the first version.
    const many = Array.from({ length: 200 }, (_, i) => hashHost(`host-${i}.example`))
    expect(many.some((h) => h.hi > 0xffff)).toBe(true)
    expect(packHosts(hosts).length).toBe(8 + hosts.length * 8)
  })

  it('refuses a set packed with 6 bytes a host (version 1): it is read as nothing, not as garbage', () => {
    const old = new Uint8Array(8 + 6)
    old.set([0x4c, 0x53, 0x42, 0x31, 0, 0, 0, 1], 0)
    expect(SafeSet.read(old)).toBeNull()
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
    for (const name of files) expect(SafeSet.read(new Uint8Array(readFileSync(join(folder, name)))), name).not.toBeNull()
  })

  it('keeps the written bound at 4 MB: the packed lists travel in every download, so a larger one is decided here, not by editing the constant', () => {
    expect(SNAPSHOT_MAX_BYTES).toBe(4_000_000)
  })

  it('holds none of the shared hosts that every user meets (shorteners, paste sites, storage, page builders, IPFS gateways)', () => {
    const sets = files.map((name) => SafeSet.read(new Uint8Array(readFileSync(join(folder, name))))!)
    for (const host of SHARED_HOSTS) for (const set of sets) expect(set.has(host), host).toBe(false)
    // The ones a person met in practice, spelled out so that shortening the control list does not hide a regression.
    for (const host of ['sites.google.com', 'bit.ly', 'pastebin.com', 'telegra.ph', 'bio.link', 'firebasestorage.googleapis.com', 'storage.cloud.google.com', 'dweb.link', 'cloudflare-ipfs.com', 'gateway.pinata.cloud']) {
      expect(SHARED_HOSTS, host).toContain(host)
    }
  })
})

describe('the shared hosts left out of the snapshot', () => {
  it('are taken out of a list, exact names only: a host under a shared one stays', () => {
    expect(withoutSharedHosts(['sites.google.com', 'phish.example', 'bit.ly', 'evil.sites.google.com', 'pastebin.com'])).toEqual(['phish.example', 'evil.sites.google.com'])
  })
})
