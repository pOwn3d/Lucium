// The hosts held to strict transport security outlive the run (strict-transport-store.ts): written to the folder of the session, read back at
// the next launch, erased with the data of the session. Against real files, in a throw-away folder.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictTransportHosts } from './strict-transport'
import { STRICT_TRANSPORT_FILE, StrictTransportStore } from './strict-transport-store'

let folder: string
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'lucium-strict-'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  chmodSync(folder, 0o700)
  rmSync(folder, { recursive: true, force: true })
})

/** One run of the application: its own record, its own store and a new session object on the same folder (null: a private window). */
function run(now: () => number = Date.now, at: string | null = folder) {
  const hosts = new StrictTransportHosts(now)
  const store = new StrictTransportStore(hosts, 1000)
  const session = { getStoragePath: () => at }
  store.attach(session)
  return { hosts, store, session }
}

const file = (): string => join(folder, STRICT_TRANSPORT_FILE)

describe('the hosts held to strict transport security, from one run to the next', () => {
  it('holds after a restart a host that asked in an earlier run, with its subdomains when it asked for them, until the time it asked is over', () => {
    let now = 1_000_000
    const first = run(() => now)
    first.hosts.note(first.session, 'https://banque.exemple.fr/compte', 'max-age=31536000')
    first.hosts.note(first.session, 'https://exemple.org/', 'max-age=86400; includeSubDomains')
    first.store.flush(first.session)

    const second = run(() => now)
    expect(second.hosts.isStrict(second.session, 'banque.exemple.fr')).toBe(true)
    expect(second.hosts.isStrict(second.session, 'www.banque.exemple.fr')).toBe(false)
    expect(second.hosts.isStrict(second.session, 'courriel.exemple.org')).toBe(true)
    expect(second.hosts.isStrict(second.session, 'autre.exemple.fr')).toBe(false)

    // A day later, the one that asked for a day is no longer held; the other still is.
    now += DAY
    const third = run(() => now)
    expect(third.hosts.isStrict(third.session, 'courriel.exemple.org')).toBe(false)
    expect(third.hosts.isStrict(third.session, 'banque.exemple.fr')).toBe(true)
  })

  it('writes by itself a moment after a host asked, once for several answers, and not again for the same header of the same site', () => {
    vi.useFakeTimers()
    const { hosts, session } = run()
    hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
    hosts.note(session, 'https://exemple.org/', 'max-age=600')
    expect(existsSync(file())).toBe(false)
    vi.advanceTimersByTime(1000)
    expect((JSON.parse(readFileSync(file(), 'utf8')) as { hosts: unknown[] }).hosts).toHaveLength(2)
    // The same header with the next document changes nothing worth a write.
    rmSync(file())
    hosts.note(session, 'https://banque.exemple.fr/autre', 'max-age=600')
    vi.advanceTimersByTime(5000)
    expect(existsSync(file())).toBe(false)
    // A host that withdraws is written out.
    hosts.note(session, 'https://exemple.org/', 'max-age=0')
    vi.advanceTimersByTime(1000)
    expect((JSON.parse(readFileSync(file(), 'utf8')) as { hosts: unknown[] }).hosts).toHaveLength(1)
  })

  it('writes at once, when the application quits, the host that asked in the last second, and it is held at the next launch', () => {
    vi.useFakeTimers()
    const first = run()
    first.hosts.note(first.session, 'https://banque.exemple.fr/', 'max-age=600')
    // The write waits on a timer that does not keep the process alive: a quit now would lose the host.
    expect(existsSync(file())).toBe(false)
    expect(first.store.flushPending()).toBe(1)
    expect((JSON.parse(readFileSync(file(), 'utf8')) as { hosts: unknown[] }).hosts).toHaveLength(1)
    const second = run()
    expect(second.hosts.isStrict(second.session, 'banque.exemple.fr')).toBe(true)
    // Nothing waits any more: the timer was dropped with the write, and a second quit writes nothing.
    rmSync(file())
    expect(first.store.flushPending()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(existsSync(file())).toBe(false)
  })

  it('writes at the quit every session whose write waited, and only those: not a private window, not a session whose data was just erased', () => {
    vi.useFakeTimers()
    const hosts = new StrictTransportHosts()
    const store = new StrictTransportStore(hosts, 1000)
    const other = mkdtempSync(join(tmpdir(), 'lucium-strict-other-'))
    const erased = mkdtempSync(join(tmpdir(), 'lucium-strict-erased-'))
    try {
      const sessions = [folder, other, erased, null].map((at) => ({ getStoragePath: () => at }))
      for (const session of sessions) {
        store.attach(session)
        hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
      }
      store.forget(sessions[2]!)
      expect(store.flushPending()).toBe(2)
      expect([folder, other, erased].map((at) => existsSync(join(at, STRICT_TRANSPORT_FILE)))).toEqual([true, true, false])
    } finally {
      rmSync(other, { recursive: true, force: true })
      rmSync(erased, { recursive: true, force: true })
    }
  })

  it('says in the journal, at the quit, the session whose file cannot be written, and still writes the others', () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const hosts = new StrictTransportHosts()
    const store = new StrictTransportStore(hosts, 1000)
    const other = mkdtempSync(join(tmpdir(), 'lucium-strict-other-'))
    try {
      const locked = { getStoragePath: () => folder }
      const fine = { getStoragePath: () => other }
      for (const session of [locked, fine]) {
        store.attach(session)
        hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
      }
      chmodSync(folder, 0o500)
      expect(store.flushPending()).toBe(2)
      expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`cannot write the hosts held to strict transport security (${file()})`), expect.any(String))
      expect(existsSync(join(other, STRICT_TRANSPORT_FILE))).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('names no site in its file, which only its owner reads', () => {
    const { hosts, store, session } = run()
    hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
    store.flush(session)
    const text = readFileSync(file(), 'utf8')
    expect(text).not.toContain('banque')
    expect(text).not.toContain('exemple')
    expect((JSON.parse(text) as { hosts: Array<{ host: string }> }).hosts[0]!.host).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(readdirSync(folder)).toEqual([STRICT_TRANSPORT_FILE])
  })

  it('writes nothing for a session that lives in memory (a private window)', () => {
    vi.useFakeTimers()
    const { hosts, store, session } = run(Date.now, null)
    hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
    vi.advanceTimersByTime(5000)
    store.flush(session)
    expect(readdirSync(folder)).toEqual([])
    expect(hosts.isStrict(session, 'banque.exemple.fr')).toBe(true)
  })

  it('forgets everything with the data of the session: in memory, on disk, and the write that waited', () => {
    vi.useFakeTimers()
    const { hosts, store, session } = run()
    hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
    store.flush(session)
    hosts.note(session, 'https://exemple.org/', 'max-age=600')
    store.forget(session)
    vi.advanceTimersByTime(5000)
    expect(existsSync(file())).toBe(false)
    expect(hosts.isStrict(session, 'banque.exemple.fr')).toBe(false)
    expect(run().hosts.isStrict(session, 'banque.exemple.fr')).toBe(false)
  })

  it('removes the file of a session nothing was read for in this run: a container erased while it is closed', () => {
    const earlier = run()
    earlier.hosts.note(earlier.session, 'https://banque.exemple.fr/', 'max-age=600')
    earlier.store.flush(earlier.session)
    new StrictTransportStore(new StrictTransportHosts()).forget({ getStoragePath: () => folder })
    expect(existsSync(file())).toBe(false)
  })

  it('throws when the file cannot be removed, so that the erasure is not said done', () => {
    const { hosts, store, session } = run()
    hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
    store.flush(session)
    chmodSync(folder, 0o500)
    expect(() => store.forget(session)).toThrow(/EACCES|EPERM/)
  })
})

describe('a file of strict hosts that cannot be used', () => {
  it('says in the journal that the file is damaged, with its path, and holds nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const text of ['{ not json', '[]', JSON.stringify({ version: 2, hosts: [] }), JSON.stringify({ version: 1, hosts: 'all' })]) {
      writeFileSync(file(), text)
      error.mockClear()
      const { hosts, session } = run()
      expect(hosts.records(session), text).toEqual([])
      expect(error, text).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`is damaged (${file()})`), expect.any(String))
    }
  })

  it('says in the journal that the file cannot be read, with its path; a file that is not there yet is the first run and says nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    run()
    expect(error).not.toHaveBeenCalled()
    mkdirSync(file())
    run()
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`cannot read the hosts held to strict transport security (${file()})`), expect.stringContaining('EISDIR'))
  })

  it('says in the journal that the file cannot be written, with its path, leaves no half-written copy, and writes at the next change', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { hosts, store, session } = run()
    hosts.note(session, 'https://banque.exemple.fr/', 'max-age=600')
    chmodSync(folder, 0o500)
    store.flush(session)
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`cannot write the hosts held to strict transport security (${file()})`), expect.any(String))
    chmodSync(folder, 0o700)
    expect(readdirSync(folder)).toEqual([])
    hosts.note(session, 'https://exemple.org/', 'max-age=600')
    store.flush(session)
    expect((JSON.parse(readFileSync(file(), 'utf8')) as { hosts: unknown[] }).hosts).toHaveLength(2)
  })

  it('takes from a file only what is a host still held: no other shape, no time that is over, no time further than a header may ask', () => {
    const now = 5_000_000
    const digest = 'a'.repeat(64)
    const good = { host: digest, until: now + 1000, includeSubDomains: false }
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        hosts: [good, { host: 'banque.exemple.fr', until: now + 1000, includeSubDomains: false }, { host: 'b'.repeat(64), until: now, includeSubDomains: false }, { host: 'c'.repeat(64), until: '9', includeSubDomains: false }, { host: 'd'.repeat(64), until: now + 1000 }, null, 'x', { host: 'e'.repeat(64), until: now + 1000 * 366 * DAY, includeSubDomains: true }]
      })
    )
    const { hosts, session } = run(() => now)
    expect(hosts.records(session)).toEqual([good, { host: 'e'.repeat(64), until: now + 366 * DAY, includeSubDomains: true }])
  })
})
