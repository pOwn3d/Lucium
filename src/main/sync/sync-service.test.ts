// The synchronisation as the Settings page drives it (docs/synchronisation.md §13.1): the switch, the listening, the pairing sheet, the question, the devices.
// The door is a stand-in for most tests (what matters is when it opens and closes); one test goes through the real listener with real TLS over the loopback.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { NetworkInterfaceInfo } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeQr } from '@shared/qr'
import { tempDir } from '../temp-dir'
import { Channel } from './channel'
import { IdentityStore } from './identity'
import type { ListenerDeps } from './listener'
import { IDENTITY_REPLACE_DELAY_MS, PAIRING_WINDOW_MS } from './limits'
import { readManualCode, readQr } from './pairing-code'
import { pairingCommitment } from './pairing-commit'
import { comparisonCode } from './pairing-compare'
import { acceptProof, requestProof } from './pairing-proof'
import { SafeClock } from './safe-clock'
import type { SecretBox } from './secret-box'
import { SyncService, SyncServiceError, readableAddress, readableName, type SyncDoor, type SyncServiceDeps } from './sync-service'
import { PORT_MAX, PORT_MIN, SyncStore, type PeerRecord } from './sync-store'
import { closedOrFailed, connectTls, sleep, testIdentity } from './sync-net.test-support'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

const box = (available = true): SecretBox => ({ available: () => available, seal: (plain) => Buffer.from(plain.map((b) => b ^ 5)), open: (sealed) => Buffer.from(sealed.map((b) => b ^ 5)) })
const iface = (address: string): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: address.includes(':') ? 'IPv6' : 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 0 }) as NetworkInterfaceInfo

interface Rig {
  service: SyncService
  store: SyncStore
  dir: string
  time: { t: number }
  door: { starts: number[]; stops: number; dropped: string[]; failStart: Array<Error | null>; deps: ListenerDeps | null; currentPort: number | null }
  changes: { count: number }
  locked: { on: boolean }
  hosts: { list: string[]; hostname: string }
}

function rig(over: Partial<SyncServiceDeps> = {}, available = true): Rig {
  const dir = tempDir('lucium-sync-service-')
  const time = { t: 0 }
  const store = new SyncStore(join(dir, 'sync.json'))
  const door: Rig['door'] = { starts: [], stops: 0, dropped: [], failStart: [], deps: null, currentPort: null }
  const changes = { count: 0 }
  const locked = { on: false }
  const hosts = { list: ['192.168.1.20'], hostname: 'macbook-de-test.local' }
  const service = new SyncService({
    store,
    identities: new IdentityStore(join(dir, 'sync-identity.json'), box(available)),
    box: box(available),
    clock: new SafeClock({ monotonic: () => time.t, wall: () => 1_790_000_000_000 + time.t }),
    hostEnv: () => ({ hostname: hosts.hostname, interfaces: { en0: hosts.list.map(iface) } }),
    deviceName: () => 'MacBook de test',
    now: () => 1_790_000_000_000 + time.t,
    isLocked: () => locked.on,
    onChange: () => void changes.count++,
    settleMs: 0,
    pickPort: (() => {
      let next = PORT_MIN + 1000
      return () => next++
    })(),
    makeDoor: (deps): SyncDoor => {
      door.deps = deps
      return {
        start: async (port) => {
          const failure = door.failStart.shift()
          if (failure) throw failure
          door.starts.push(port)
          door.currentPort = port
          return port
        },
        stop: async () => {
          door.stops++
          door.currentPort = null
        },
        port: () => door.currentPort,
        dropPeer: (fingerprint) => (door.dropped.push(fingerprint), 1)
      }
    },
    ...over
  })
  cleanup.push(() => service.dispose())
  return { service, store, dir, time, door, changes, locked, hosts }
}

const taken = (): NodeJS.ErrnoException => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
const iphone = (n: number, extra: Partial<PeerRecord> = {}): PeerRecord => ({ id: `iphone-${n}`, name: `iPhone ${n}`, platform: 'ios', fingerprint: n.toString(16).padStart(64, '0'), pairedAt: 1_790_000_000_000, lastSessionAt: null, ...extra })

/** The Mac listens when the switch is on, the application is unlocked and an iPhone is paired (§6.1): pair one if none is, and let the service settle the door. */
async function listen(r: Rig): Promise<void> {
  if (r.store.peers().length === 0) r.store.addPeer(iphone(1))
  await r.service.reconcileListening()
}

describe('SyncService: off by default, and when the Mac listens (§6.1)', () => {
  it('starts off, with nothing paired, not listening and no sheet', () => {
    const { service } = rig()
    expect(service.status()).toMatchObject({ available: true, enabled: false, categories: { structure: true, settings: false, archive: false, openTabs: false }, listening: false, pairing: null, confirm: null, devices: [], identityReplaced: false, justPaired: null, problem: null })
  })

  it('turns on with no iPhone paired without opening the door: nobody to wait for, no port', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    expect(r.service.status().enabled).toBe(true)
    expect(r.door.starts).toEqual([])
    expect(r.service.status().listening).toBe(false)
    expect(r.store.config().enabled).toBe(true)
  })

  it('listens as soon as it is turned on when an iPhone is paired (the devices are kept while it is off)', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    await r.service.setEnabled(true)
    expect(r.door.starts).toHaveLength(1)
    expect(r.service.status().listening).toBe(true)
  })

  it('refuses to turn on when the system cannot seal a key, says why, and stays off', async () => {
    const r = rig({}, false)
    await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'unavailable' })
    expect(r.service.status()).toMatchObject({ enabled: false, available: false, problem: 'unavailable' })
    expect(r.store.config().enabled).toBe(false)
  })

  it('does not listen while the switch is off, whatever is paired, and a pairing cannot be started', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    await r.service.reconcileListening()
    expect(r.door.starts).toEqual([])
    await expect(r.service.startPairing()).rejects.toBeInstanceOf(SyncServiceError)
    expect(r.door.starts).toEqual([])
  })

  it('closes the door, then turns off, when the switch is cut; the paired devices are kept', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    await r.service.setEnabled(true)
    expect(r.door.currentPort).not.toBeNull()
    await r.service.setEnabled(false)
    expect(r.door.stops).toBe(1)
    expect(r.door.currentPort).toBeNull()
    expect(r.service.status()).toMatchObject({ enabled: false, listening: false })
    expect(r.service.status().devices).toHaveLength(1)
  })

  it('listens from the launch when the switch is on and an iPhone is paired, with nobody having opened anything', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    r.store.setEnabled(true)
    r.service.start()
    await r.service.reconcileListening()
    expect(r.door.starts).toHaveLength(1)
    expect(r.service.status().listening).toBe(true)
  })

  it('does not listen at the launch when the switch is off, nor when no iPhone is paired', async () => {
    const off = rig()
    off.store.addPeer(iphone(1))
    off.service.start()
    await off.service.reconcileListening()
    expect(off.door.starts).toEqual([])
    const nobody = rig()
    nobody.store.setEnabled(true)
    nobody.service.start()
    await nobody.service.reconcileListening()
    expect(nobody.door.starts).toEqual([])
  })

  it('does not listen at the launch while the application is locked, and listens when it is unlocked', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    r.store.setEnabled(true)
    r.locked.on = true
    r.service.start()
    await r.service.reconcileListening()
    expect(r.door.starts).toEqual([])
    r.locked.on = false
    await r.service.lockChanged()
    expect(r.door.starts).toHaveLength(1)
    expect(r.service.status().listening).toBe(true)
  })

  it('stops listening when the last iPhone is forgotten, and keeps listening while another is paired', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    r.store.addPeer(iphone(2))
    await r.service.setEnabled(true)
    r.service.forget('iphone-1')
    await r.service.reconcileListening()
    expect(r.service.status().listening).toBe(true)
    expect(r.door.stops).toBe(0)
    r.service.forget('iphone-2')
    await r.service.reconcileListening()
    expect(r.service.status().listening).toBe(false)
    expect(r.door.stops).toBe(1)
  })

  it('listens with no deadline: a day later the door is the same one, still open', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await listen(r)
    r.time.t += 24 * 3_600_000
    expect(r.service.status().listening).toBe(true)
    expect(r.door.stops).toBe(0)
    expect(r.door.starts).toHaveLength(1)
  })

  it('keeps a category ticked or not, and refuses one that does not exist', async () => {
    const r = rig()
    r.service.setCategory('openTabs', true)
    expect(r.service.status().categories.openTabs).toBe(true)
    expect(() => r.service.setCategory('passwords' as never, true)).toThrow(SyncServiceError)
  })

  it('keeps the devices for a minute when the file is not an identity (a certificate Node stops reading after an update), then says that the identity was replaced and the devices forgotten (review n° 41)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    r.store.addPeer(iphone(1))
    new IdentityStore(join(r.dir, 'sync-identity.json'), { available: () => true, seal: (p) => Buffer.from(p), open: () => Buffer.alloc(0) }).loadOrCreate()
    await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'identity-unopenable' })
    expect(r.service.status()).toMatchObject({ identityReplaced: false })
    expect(r.store.peers()).toHaveLength(1)
    r.time.t += IDENTITY_REPLACE_DELAY_MS
    await r.service.setEnabled(true)
    expect(r.service.status()).toMatchObject({ identityReplaced: true, devices: [] })
    log.mockRestore()
  })

  // Review n° 22: the keychain that refuses for a moment does not take the paired devices with it.
  describe('a key the keychain does not open', () => {
    /** A box whose key opens only when `opens.now` is true, as a keychain that refuses and then answers does. */
    function flaky(opens: { now: boolean }): SecretBox {
      const mix = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 3))
      return { available: () => true, seal: (plain) => mix(plain), open: (sealed) => (opens.now ? mix(sealed) : ((): never => { throw new Error('the keychain refuses') })()) }
    }

    const withFlakyKey = (opens: { now: boolean }): { r: Rig; path: string } => {
      const path = join(tempDir('lucium-sync-flaky-'), 'sync-identity.json')
      return { path, r: rig({ identities: new IdentityStore(path, flaky(opens)), box: flaky(opens) }) }
    }

    it('keeps the devices paired and says so the first time, and finds the same identity when the keychain answers again', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const opens = { now: true }
      const { r, path } = withFlakyKey(opens)
      const first = new IdentityStore(path, flaky(opens)).loadOrCreate().identity
      r.store.addPeer(iphone(1))
      opens.now = false
      await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'identity-unopenable' })
      expect(r.service.status()).toMatchObject({ enabled: false, identityReplaced: false, problem: 'identity-unopenable' })
      expect(r.store.peers()).toHaveLength(1)
      opens.now = true
      await r.service.setEnabled(true)
      expect(r.service.status()).toMatchObject({ enabled: true, identityReplaced: false, problem: null })
      expect(r.store.peers()).toHaveLength(1)
      expect(new IdentityStore(path, flaky(opens)).loadOrCreate().identity.fingerprint.equals(first.fingerprint)).toBe(true)
      log.mockRestore()
    })

    it('does not make a new identity at a second try within the minute that follows the first refusal: the devices stay paired (review n° 41)', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const opens = { now: true }
      const { r, path } = withFlakyKey(opens)
      new IdentityStore(path, flaky(opens)).loadOrCreate()
      r.store.addPeer(iphone(1))
      opens.now = false
      await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'identity-unopenable' })
      r.time.t += IDENTITY_REPLACE_DELAY_MS - 1
      await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'identity-unopenable' })
      expect(r.service.status()).toMatchObject({ identityReplaced: false })
      expect(r.store.peers()).toHaveLength(1)
      log.mockRestore()
    })

    it('makes a new identity at the try that comes a minute after the first refusal, if the key still does not open, and tells the devices are forgotten', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const opens = { now: true }
      const { r, path } = withFlakyKey(opens)
      new IdentityStore(path, flaky(opens)).loadOrCreate()
      r.store.addPeer(iphone(1))
      opens.now = false
      await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'identity-unopenable' })
      r.time.t += IDENTITY_REPLACE_DELAY_MS
      await r.service.setEnabled(true)
      expect(r.service.status()).toMatchObject({ enabled: true, identityReplaced: true, devices: [] })
      log.mockRestore()
    })

    it('does not count the minute from a later refusal: the first one starts it, and a key that opened in between starts it over', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const opens = { now: true }
      const { r, path } = withFlakyKey(opens)
      new IdentityStore(path, flaky(opens)).loadOrCreate()
      r.store.addPeer(iphone(1))
      opens.now = false
      await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'identity-unopenable' })
      r.time.t += IDENTITY_REPLACE_DELAY_MS - 10
      await expect(r.service.setEnabled(true)).rejects.toMatchObject({ problem: 'identity-unopenable' })
      // The second refusal is not a new first one: ten more milliseconds are the minute since the first.
      r.time.t += 10
      await r.service.setEnabled(true)
      expect(r.service.status()).toMatchObject({ identityReplaced: true })
      log.mockRestore()
    })
  })
})

describe('SyncService: the door', () => {
  it('opens on a stored port in the dynamic range', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await listen(r)
    expect(r.door.starts).toHaveLength(1)
    expect(r.door.starts[0]).toBeGreaterThanOrEqual(PORT_MIN)
    expect(r.door.starts[0]).toBeLessThanOrEqual(PORT_MAX)
    expect(r.store.config().port).toBe(r.door.starts[0])
    expect(r.service.status().listening).toBe(true)
  })

  it('opens again on the same port next time', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await listen(r)
    r.locked.on = true
    await r.service.lockChanged()
    r.locked.on = false
    await r.service.lockChanged()
    expect(r.door.starts[1]).toBe(r.door.starts[0])
  })

  it('draws another port, and keeps it, when the stored one is taken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = rig()
    r.door.failStart.push(taken(), taken())
    await r.service.setEnabled(true)
    await listen(r)
    expect(r.door.starts).toHaveLength(1)
    expect(r.store.config().port).toBe(r.door.starts[0])
    expect(r.service.status().listening).toBe(true)
    warn.mockRestore()
  })

  it('draws another port when the system refuses the one it drew (EACCES: Windows keeps ranges of the dynamic ports for itself, and a port of the dynamic range is never one a person needs rights for)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = rig()
    const refused = (): NodeJS.ErrnoException => Object.assign(new Error('listen EACCES: permission denied'), { code: 'EACCES' })
    r.door.failStart.push(refused(), refused())
    await r.service.setEnabled(true)
    await listen(r)
    expect(r.door.starts).toHaveLength(1)
    expect(r.store.config().port).toBe(r.door.starts[0])
    expect(r.service.status().listening).toBe(true)
    warn.mockRestore()
  })

  it('says `port`, not `internal`, when every port it tries is refused by the system', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    for (let n = 0; n < 6; n++) r.door.failStart.push(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }))
    await r.service.setEnabled(true)
    await expect(listen(r)).rejects.toMatchObject({ problem: 'port' })
    warn.mockRestore()
    log.mockRestore()
  })

  it('gives up after five ports that are taken, and says `port`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    for (let n = 0; n < 6; n++) r.door.failStart.push(taken())
    await r.service.setEnabled(true)
    await expect(listen(r)).rejects.toMatchObject({ problem: 'port' })
    expect(r.service.status()).toMatchObject({ listening: false, problem: 'port' })
    warn.mockRestore()
    log.mockRestore()
  })

  it('keeps the problem while the page only asks the state, and forgets it at the next request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    for (let n = 0; n < 6; n++) r.door.failStart.push(taken())
    await r.service.setEnabled(true)
    await expect(listen(r)).rejects.toMatchObject({ problem: 'port' })
    expect(r.service.status().problem).toBe('port')
    expect(r.service.status().problem).toBe('port')
    r.service.setCategory('archive', true)
    expect(r.service.status().problem).toBeNull()
    warn.mockRestore()
    log.mockRestore()
  })

  it('says `internal` for a door that fails for another reason, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    r.door.failStart.push(Object.assign(new Error('EMFILE'), { code: 'EMFILE' }))
    await r.service.setEnabled(true)
    await expect(listen(r)).rejects.toMatchObject({ problem: 'internal' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be opened'), expect.anything())
    log.mockRestore()
  })

  it('does not open while the application is locked, whatever is paired', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    r.locked.on = true
    await listen(r)
    expect(r.door.starts).toEqual([])
    await expect(r.service.startPairing()).rejects.toMatchObject({ problem: 'locked' })
    expect(r.door.starts).toEqual([])
  })

  it('closes when the application locks, and opens again when it is unlocked', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await listen(r)
    await r.service.lockChanged()
    expect(r.service.status().listening).toBe(true)
    r.locked.on = true
    await r.service.lockChanged()
    expect(r.service.status().listening).toBe(false)
    expect(r.door.stops).toBe(1)
    r.locked.on = false
    await r.service.lockChanged()
    expect(r.service.status().listening).toBe(true)
    expect(r.door.starts).toHaveLength(2)
  })

  it('is not closed by the page being left: the listening does not depend on the page', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await listen(r)
    await r.service.leave()
    expect(r.service.status().listening).toBe(true)
    expect(r.door.stops).toBe(0)
  })

  it('tells the page at every change', async () => {
    const r = rig()
    const before = r.changes.count
    await r.service.setEnabled(true)
    await listen(r)
    expect(r.changes.count).toBeGreaterThan(before + 1)
  })
})

describe('SyncService: the sheet of « Ajouter un iPhone »', () => {
  async function withSheet(over: Partial<Rig['hosts']> = {}): Promise<Rig> {
    const r = rig()
    Object.assign(r.hosts, over)
    await r.service.setEnabled(true)
    await r.service.startPairing()
    return r
  }

  it('opens the door if it is closed (nobody is paired yet), and gives the QR, the code and the address', async () => {
    const r = await withSheet()
    const { pairing, listening } = r.service.status()
    expect(listening).toBe(true)
    expect(pairing).not.toBeNull()
    const reading = readQr(pairing?.qr ?? '')
    expect(reading.ok).toBe(true)
    if (!reading.ok) return
    expect(reading.port).toBe(r.door.currentPort)
    expect(reading.hosts).toEqual(['macbook-de-test.local', '192.168.1.20'])
    expect(pairing?.address).toBe(`macbook-de-test.local:${r.door.currentPort}`)
    expect(pairing?.code).toMatch(/^([A-Z2-7]{5}-){5}[A-Z2-7]$/)
    expect(pairing?.remainingMs).toBe(PAIRING_WINDOW_MS)
    // The typed code and the QR carry the same secret.
    const typed = readManualCode(pairing?.code ?? '')
    expect(typed.ok && typed.secret.equals(reading.secret)).toBe(true)
  })

  it('writes in the QR the fingerprint of THIS Mac, the one the iPhone will pin', async () => {
    const r = await withSheet()
    const reading = readQr(r.service.status().pairing?.qr ?? '')
    const identity = new IdentityStore(join(r.dir, 'sync-identity.json'), box()).load()
    expect(reading.ok && identity !== null && reading.fingerprint.equals(identity.fingerprint)).toBe(true)
  })

  it('counts the two minutes down, and the sheet closes by itself when they are over', async () => {
    const r = await withSheet()
    r.time.t += 100_000
    expect(r.service.status().pairing?.remainingMs).toBe(20_000)
    r.time.t += 20_000
    expect(r.service.status().pairing).toBeNull()
  })

  it('draws a new secret each time, and the old one is closed', async () => {
    const r = await withSheet()
    const first = r.door.deps?.openPairing(Buffer.alloc(32))?.secret
    const firstQr = r.service.status().pairing?.qr
    await r.service.startPairing()
    expect(r.service.status().pairing?.qr).not.toBe(firstQr)
    expect(first?.attempt(() => true)).toBe('pairing-closed')
  })

  it('fits a QR in what the encoder takes, dropping the last addresses and never the first', async () => {
    const long = ['fd12:3456:789a:bcde:f012:3456:789a:1', 'fd12:3456:789a:bcde:f012:3456:789a:2', 'fd12:3456:789a:bcde:f012:3456:789a:3', 'fd12:3456:789a:bcde:f012:3456:789a:4']
    const r = await withSheet({ hostname: 'a-very-long-name-for-a-mac-of-a-person-who-likes-long-names.local', list: ['192.168.100.200', ...long] })
    const qr = r.service.status().pairing?.qr ?? ''
    expect('error' in encodeQr(qr)).toBe(false)
    const reading = readQr(qr)
    expect(reading.ok && reading.hosts[0]).toBe('a-very-long-name-for-a-mac-of-a-person-who-likes-long-names.local')
    expect(reading.ok && reading.hosts.length).toBeLessThan(5)
  })

  it('says `network`, and shows no sheet, when this Mac has no address of the local network', async () => {
    const r = rig()
    r.hosts.list = []
    r.hosts.hostname = 'x'
    await r.service.setEnabled(true)
    await expect(r.service.startPairing()).rejects.toMatchObject({ problem: 'network' })
    expect(r.service.status().pairing).toBeNull()
  })

  it('closes with the sheet: the secret no longer pairs', async () => {
    const r = await withSheet()
    const secret = r.door.deps?.openPairing(Buffer.alloc(32))?.secret
    r.service.closePairing()
    expect(r.service.status().pairing).toBeNull()
    expect(secret?.attempt(() => true)).toBe('pairing-closed')
    expect(r.door.deps?.openPairing(Buffer.alloc(32))).toBeNull()
  })

  it('closes with the door (the application locks)', async () => {
    const r = await withSheet()
    const secret = r.door.deps?.openPairing(Buffer.alloc(32))?.secret
    r.locked.on = true
    await r.service.lockChanged()
    expect(r.service.status().pairing).toBeNull()
    expect(secret?.attempt(() => true)).toBe('pairing-closed')
  })

  it('offers no pairing to the door when no sheet is open: a stranger is refused', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await listen(r)
    expect(r.door.deps?.openPairing(Buffer.alloc(32))).toBeNull()
  })
})

describe('SyncService: the question (Autoriser / Refuser)', () => {
  async function asked(name = 'iPhone de Camille'): Promise<{ r: Rig; answer: Promise<'allow' | 'refuse'> }> {
    const r = rig()
    await r.service.setEnabled(true)
    await r.service.startPairing()
    const offer = r.door.deps?.openPairing(Buffer.alloc(32))
    if (!offer) throw new Error('no offer')
    return { r, answer: offer.confirm({ name, code: 'ABC234', address: '192.168.1.40' }) }
  }

  it('shows the name, counts the minute down, and returns what the person answered', async () => {
    const { r, answer } = await asked()
    // The sheet carries what lets the person tell their iPhone from another: the code the iPhone shows too (review n° 9) and where the request comes from (n° 21).
    expect(r.service.status().confirm).toEqual({ name: 'iPhone de Camille', code: 'ABC234', address: '192.168.1.40', waiting: false, remainingMs: 60_000 })
    r.time.t += 15_000
    expect(r.service.status().confirm?.remainingMs).toBe(45_000)
    r.service.answer(true)
    expect(await answer).toBe('allow')
    // Allowed is not paired: the sheet stays, with the code, while the iPhone's person compares it (§4.6).
    expect(r.service.status().confirm).toEqual({ name: 'iPhone de Camille', code: 'ABC234', address: '192.168.1.40', waiting: true, remainingMs: 60_000 })
  })

  it('keeps the sheet while the iPhone is asked, and ends the wait when the person gives up, or when the sheet or the door closes', async () => {
    for (const giveUp of [(r: Rig) => r.service.answer(false), (r: Rig) => r.service.closePairing(), (r: Rig) => void ((r.locked.on = true), r.service.lockChanged())]) {
      const { r, answer } = await asked()
      r.service.answer(true)
      await answer
      const waiting = r.door.deps?.openPairing(Buffer.alloc(32))?.waiting?.({ name: 'x', code: 'ABC234', address: '' })
      let ended = false
      void waiting?.then(() => void (ended = true))
      await sleep(10)
      expect(ended).toBe(false)
      // « Autoriser » again does nothing: only giving up counts while the iPhone is asked.
      r.service.answer(true)
      expect(r.service.status().confirm?.waiting).toBe(true)
      giveUp(r)
      await sleep(10)
      expect(ended).toBe(true)
      expect(r.service.status().confirm).toBeNull()
    }
  })

  it('does not wait for an iPhone when the sheet is already gone: it counts as the person giving up', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await r.service.startPairing()
    const waiting = r.door.deps?.openPairing(Buffer.alloc(32))?.waiting?.({ name: 'x', code: 'ABC234', address: '' })
    expect(await Promise.race([waiting, sleep(100).then(() => 'still waiting')])).toBeUndefined()
  })

  it('returns a refusal when the person refuses', async () => {
    const { r, answer } = await asked()
    r.service.answer(false)
    expect(await answer).toBe('refuse')
  })

  it('does nothing for an answer when no question is open (a late click)', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    expect(() => r.service.answer(true)).not.toThrow()
  })

  it('refuses when the sheet is closed, and when the door is closed', async () => {
    const first = await asked()
    first.r.service.closePairing()
    expect(await first.answer).toBe('refuse')
    const second = await asked()
    second.r.locked.on = true
    await second.r.service.lockChanged()
    expect(await second.answer).toBe('refuse')
    expect(second.r.service.status().confirm).toBeNull()
  })

  it('refuses the question it replaces: two iPhones never share one answer', async () => {
    const { r, answer } = await asked('first')
    const offer = r.door.deps?.openPairing(Buffer.alloc(32))
    const second = offer?.confirm({ name: 'second', code: 'ABC234', address: '' })
    expect(await answer).toBe('refuse')
    expect(r.service.status().confirm?.name).toBe('second')
    r.service.answer(true)
    expect(await second).toBe('allow')
  })

  it('shows a name as a person reads it: no control character, no mark that turns the text round', async () => {
    const { r } = await asked('Camille‮gpj.exe\u0007 ')
    expect(r.service.status().confirm?.name).toBe('Camille gpj.exe')
    expect(readableName('⁦hidden⁩')).toBe('hidden')
  })

  it('shows the address as the system gave it, without what makes it hard to read: no IPv4 written in IPv6, no zone, nothing that is not an address', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await r.service.startPairing()
    const offer = r.door.deps?.openPairing(Buffer.alloc(32))
    void offer?.confirm({ name: 'iPhone', code: 'ABC234', address: '::ffff:192.168.1.40' })
    expect(r.service.status().confirm?.address).toBe('192.168.1.40')
    void offer?.confirm({ name: 'iPhone', code: 'ABC234', address: 'fe80::1%en0' })
    expect(r.service.status().confirm?.address).toBe('fe80::1')
    expect(readableAddress('10.0.0.5 <>/\n')).toBe('10.0.0.5')
    expect(readableAddress('1'.repeat(80))).toHaveLength(45)
  })
})

describe('SyncService: the door and the pairing of a Mac with nobody paired (two minutes, then it closes)', () => {
  it('closes the door when the secret runs out and nobody was paired, and says so to the page', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await r.service.startPairing()
    expect(r.service.status().listening).toBe(true)
    r.time.t += PAIRING_WINDOW_MS + 1
    // The page asks its state: the expired secret is dropped there, and the door is looked at again.
    expect(r.service.status().pairing).toBeNull()
    await r.service.reconcileListening()
    expect(r.service.status().listening).toBe(false)
    expect(r.door.stops).toBe(1)
  })

  it('closes the door by itself when the secret runs out, with nobody asking the page for its state', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      await r.service.setEnabled(true)
      await r.service.startPairing()
      r.time.t += PAIRING_WINDOW_MS + 1
      await vi.advanceTimersByTimeAsync(PAIRING_WINDOW_MS + 100)
      await r.service.reconcileListening()
      expect(r.door.stops).toBe(1)
      expect(r.service.status().listening).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the door open after the secret runs out when an iPhone is paired', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    await r.service.setEnabled(true)
    await r.service.startPairing()
    r.time.t += PAIRING_WINDOW_MS + 1
    expect(r.service.status().pairing).toBeNull()
    await r.service.reconcileListening()
    expect(r.service.status().listening).toBe(true)
    expect(r.door.stops).toBe(0)
  })

  it('closes the door with the sheet when nobody is paired, and keeps it when an iPhone is', async () => {
    const alone = rig()
    await alone.service.setEnabled(true)
    await alone.service.startPairing()
    alone.service.closePairing()
    await alone.service.reconcileListening()
    expect(alone.service.status().listening).toBe(false)
    const withPhone = rig()
    withPhone.store.addPeer(iphone(1))
    await withPhone.service.setEnabled(true)
    await withPhone.service.startPairing()
    withPhone.service.closePairing()
    await withPhone.service.reconcileListening()
    expect(withPhone.service.status().listening).toBe(true)
  })

  it('leaves no door open when the sheet cannot be shown (no address of the local network)', async () => {
    const r = rig()
    r.hosts.list = []
    r.hosts.hostname = 'x'
    await r.service.setEnabled(true)
    await expect(r.service.startPairing()).rejects.toMatchObject({ problem: 'network' })
    await r.service.reconcileListening()
    expect(r.service.status()).toMatchObject({ listening: false, pairing: null })
    expect(r.door.deps?.openPairing(Buffer.alloc(32)) ?? null).toBeNull()
  })

  it('keeps listening after an iPhone was paired: the door is the one of the pairing, and it stays', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await r.service.startPairing()
    r.store.addPeer(iphone(1))
    r.door.deps?.onPairingEnded?.({ outcome: 'paired', peer: iphone(1) })
    await r.service.reconcileListening()
    expect(r.service.status()).toMatchObject({ listening: true, pairing: null })
    expect(r.door.stops).toBe(0)
  })

  it('waits a moment after a refused pairing before closing the door: the refusal the iPhone is owed must leave first', async () => {
    const r = rig({ settleMs: 80 })
    await r.service.setEnabled(true)
    await r.service.startPairing()
    r.door.deps?.onPairingEnded?.({ outcome: 'failed', code: 'pairing-refused', detail: 'x' })
    await sleep(30)
    expect(r.door.stops).toBe(0)
    expect(r.service.status().listening).toBe(true)
    await sleep(200)
    expect(r.door.stops).toBe(1)
    expect(r.service.status().listening).toBe(false)
  })

  it('waits a moment too when an iPhone says, in its own session, that it forgot this Mac', async () => {
    const r = rig({ settleMs: 80 })
    r.store.addPeer(iphone(1))
    await r.service.setEnabled(true)
    r.service.forget('iphone-1', 80)
    await sleep(30)
    expect(r.door.stops).toBe(0)
    await sleep(200)
    expect(r.door.stops).toBe(1)
  })
})

describe('SyncService: a pairing that ends, and the devices', () => {
  it('shows the iPhone that was paired once, closes the sheet, and the next request forgets it', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await r.service.startPairing()
    r.door.deps?.onPairingEnded?.({ outcome: 'paired', peer: iphone(1, { name: 'iPhone de Camille' }) })
    expect(r.service.status()).toMatchObject({ justPaired: 'iPhone de Camille', pairing: null })
    r.service.setCategory('archive', true)
    expect(r.service.status().justPaired).toBeNull()
  })

  it('closes the sheet after a refusal (the secret is spent), and keeps it after a wrong proof (it is not)', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await r.service.startPairing()
    r.door.deps?.onPairingEnded?.({ outcome: 'failed', code: 'bad-proof', detail: 'x' })
    expect(r.service.status().pairing).not.toBeNull()
    r.door.deps?.onPairingEnded?.({ outcome: 'failed', code: 'pairing-refused', detail: 'x' })
    expect(r.service.status().pairing).toBeNull()
  })

  it('lists the devices with their names, and forgets one: removed, cut at once, and the others stay', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    r.store.addPeer(iphone(2))
    await r.service.setEnabled(true)
    expect(r.service.status().devices.map((d) => d.id)).toEqual(['iphone-1', 'iphone-2'])
    r.service.forget('iphone-1')
    expect(r.service.status().devices.map((d) => d.id)).toEqual(['iphone-2'])
    expect(r.door.dropped).toEqual([iphone(1).fingerprint])
    r.service.forget('nobody')
    expect(r.door.dropped).toHaveLength(1)
  })

  it('finds a paired device by the fingerprint it presents, as the door asks', async () => {
    const r = rig()
    r.store.addPeer(iphone(1))
    await r.service.setEnabled(true)
    expect(r.door.deps?.findPeer(iphone(1).fingerprint)?.id).toBe('iphone-1')
    r.service.forget('iphone-1')
    expect(r.door.deps?.findPeer(iphone(1).fingerprint)).toBeUndefined()
  })

  it('hands the door, for a connection, a session that says the exchange is not there yet (it is not, and it does not pretend)', async () => {
    const r = rig()
    await r.service.setEnabled(true)
    await listen(r)
    const failed: Array<[string, string]> = []
    await r.door.deps?.runSession({ fail: (code: string, detail: string) => void failed.push([code, detail]) } as unknown as Channel, iphone(1))
    expect(failed).toEqual([['internal', expect.stringContaining('not available yet')]])
  })
})

describe('SyncService: through the real door, over the loopback', () => {
  it('pairs an iPhone end to end: the QR is read, the proof is made, the person answers, and the device is listed', async () => {
    const r = rig({ makeDoor: undefined, allowSource: () => true })
    await r.service.setEnabled(true)
    await r.service.startPairing()
    const reading = readQr(r.service.status().pairing?.qr ?? '')
    if (!reading.ok) throw new Error('the QR cannot be read')
    const phone = testIdentity('iphone-0000000009')
    const { socket, serverFingerprint } = await connectTls(reading.port, phone)
    // What the iPhone does before it sends anything: the fingerprint presented is the one of the QR.
    expect(serverFingerprint.equals(reading.fingerprint)).toBe(true)
    const channel = new Channel(socket, { phase: 'pairing', role: 'ios' })
    const challenge = await channel.receive()
    if (challenge.t !== 'pair.challenge') throw new Error('no challenge')
    const nonce = randomBytes(16)
    const nonceCodePhone = randomBytes(16)
    await channel.send({
      t: 'pair.request',
      device: { id: phone.deviceId, name: 'iPhone de Camille', platform: 'ios' },
      nonce: nonce.toString('base64url'),
      proof: requestProof({ secret: reading.secret, fingerprintMac: serverFingerprint, fingerprintPhone: phone.fingerprint, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone: nonce, idMac: '', idPhone: phone.deviceId }),
      commit: pairingCommitment(phone.fingerprint, nonceCodePhone)
    })
    // The commitment of §4.7: the Mac's code nonce comes after the commitment, the iPhone's is revealed after it.
    const codeNonce = await channel.receive()
    if (codeNonce.t !== 'pair.nonce') throw new Error(`expected the Mac's code nonce, got ${codeNonce.t}`)
    await channel.send({ t: 'pair.reveal', nonce: nonceCodePhone.toString('base64url') })
    // The person is asked, by name, before anything is written.
    for (let tries = 0; tries < 100 && r.service.status().confirm === null; tries++) await sleep(10)
    expect(r.service.status().confirm?.name).toBe('iPhone de Camille')
    expect(r.service.status().devices).toEqual([])
    // The code on the sheet is the one the iPhone computes from the two fingerprints it saw and the two code nonces, and the address is the one it connected from.
    expect(r.service.status().confirm?.code).toBe(comparisonCode(serverFingerprint, phone.fingerprint, Buffer.from(codeNonce.nonce, 'base64url'), nonceCodePhone))
    expect(r.service.status().confirm?.address).toMatch(/^127\.0\.0\.1$|^::1$/)
    r.service.answer(true)
    const accept = await channel.receive()
    if (accept.t !== 'pair.accept') throw new Error(`expected an accept, got ${accept.t}`)
    // The iPhone checks the Mac's proof, which names the identifier the Mac gives only now.
    expect(accept.proof).toBe(acceptProof({ secret: reading.secret, fingerprintMac: serverFingerprint, fingerprintPhone: phone.fingerprint, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone: nonce, idMac: accept.device.id, idPhone: phone.deviceId }))
    // Allowed on the Mac is not paired: the sheet waits for the iPhone's person, and nothing is kept yet.
    await sleep(40)
    expect(r.service.status().confirm?.waiting).toBe(true)
    expect(r.service.status().devices).toEqual([])
    await channel.send({ t: 'bye' })
    expect(await channel.receive()).toMatchObject({ t: 'bye' })
    await sleep(40)
    expect(r.service.status()).toMatchObject({ justPaired: 'iPhone de Camille', pairing: null, confirm: null, devices: [expect.objectContaining({ id: 'iphone-0000000009', name: 'iPhone de Camille' })] })
    expect(r.store.findByFingerprint(phone.fingerprint.toString('hex'))?.id).toBe('iphone-0000000009')
    socket.destroy()
  })

  it('does not pair when the person refuses: nothing is written, the iPhone is told', async () => {
    const r = rig({ makeDoor: undefined, allowSource: () => true })
    await r.service.setEnabled(true)
    await r.service.startPairing()
    const reading = readQr(r.service.status().pairing?.qr ?? '')
    if (!reading.ok) throw new Error('the QR cannot be read')
    const phone = testIdentity('iphone-0000000008')
    const { socket, serverFingerprint } = await connectTls(reading.port, phone)
    const channel = new Channel(socket, { phase: 'pairing', role: 'ios' })
    const challenge = await channel.receive()
    if (challenge.t !== 'pair.challenge') throw new Error('no challenge')
    const nonce = randomBytes(16)
    const nonceCodePhone = randomBytes(16)
    await channel.send({ t: 'pair.request', device: { id: phone.deviceId, name: 'iPhone', platform: 'ios' }, nonce: nonce.toString('base64url'), proof: requestProof({ secret: reading.secret, fingerprintMac: serverFingerprint, fingerprintPhone: phone.fingerprint, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone: nonce, idMac: '', idPhone: phone.deviceId }), commit: pairingCommitment(phone.fingerprint, nonceCodePhone) })
    await channel.receive()
    await channel.send({ t: 'pair.reveal', nonce: nonceCodePhone.toString('base64url') })
    for (let tries = 0; tries < 100 && r.service.status().confirm === null; tries++) await sleep(10)
    r.service.answer(false)
    expect(await channel.receive()).toMatchObject({ t: 'error', code: 'pairing-refused' })
    expect(r.service.status().devices).toEqual([])
    expect(r.service.status().pairing).toBeNull()
    socket.destroy()
  })

  it('refuses a stranger, and a device that is not paired, while no sheet is open', async () => {
    const r = rig({ makeDoor: undefined, allowSource: () => true })
    await r.service.setEnabled(true)
    await listen(r)
    const port = r.store.config().port as number
    const { socket } = await connectTls(port, testIdentity('stranger-0000000001'))
    const first = await new Promise<string>((resolve) => void socket.once('data', (d: Buffer) => resolve(d.subarray(4).toString())))
    expect(first).toContain('not-paired')
    socket.destroy()
    r.service.forget('iphone-1')
    await r.service.reconcileListening()
    await sleep(30)
    await expect(connectTls(port, testIdentity('stranger-0000000002'))).rejects.toBeDefined()
  })

  it('tells a paired device that the exchange of data is not there yet, and cuts it when it is forgotten', async () => {
    const r = rig({ makeDoor: undefined, allowSource: () => true })
    const phone = testIdentity('iphone-0000000007')
    r.store.addPeer({ id: phone.deviceId, name: 'iPhone', platform: 'ios', fingerprint: phone.fingerprint.toString('hex'), pairedAt: 1, lastSessionAt: null })
    await r.service.setEnabled(true)
    const { socket } = await connectTls(r.store.config().port as number, phone)
    const text = await new Promise<string>((resolve) => void socket.once('data', (d: Buffer) => resolve(d.subarray(4).toString())))
    expect(text).toContain('internal')
    const closed = closedOrFailed(socket)
    r.service.forget(phone.deviceId)
    expect(await closed).toMatch(/closed|error/)
  })
})
