// The service with the real exchange (docs/synchronisation.md §8): a paired iPhone, written in the test with the same session function, connects over real TLS to the door
// the service opened, and the two end up with the same spaces. What the service adds to the session is what is asserted here: the marks follow the state while the switch is on
// and only then, one session at a time, the device that says `unpair` is forgotten, the open tabs are kept in memory only, and what the last session was is told.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reduce } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import type { SyncPatch } from '@shared/sidebar-sync'
import { tempDir } from '../temp-dir'
import { handleSyncResume } from '../shell/sync-ipc'
import { Channel } from './channel'
import { IdentityStore } from './identity'
import { SafeClock } from './safe-clock'
import { Device, PHONE_ID, stateOf } from './session-rig.test-support'
import type { SecretBox } from './secret-box'
import { SyncService, type SessionPorts } from './sync-service'
import { SyncStore } from './sync-store'
import { closedOrFailed, connectTls, sleep, testIdentity } from './sync-net.test-support'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

const box: SecretBox = { available: () => true, seal: (plain) => Buffer.from(plain.map((b) => b ^ 5)), open: (sealed) => Buffer.from(sealed.map((b) => b ^ 5)) }

interface Rig {
  service: SyncService
  dir: string
  store: SyncStore
  mac: { state: SidebarState; listeners: Array<() => void>; applied: SyncPatch[] }
  phone: Device
  phoneTls: ReturnType<typeof testIdentity>
  time: { t: number }
  locked: { v: boolean }
  port: () => number
}

function rig(macSeed: Parameters<typeof stateOf>[0], phoneSeed: Parameters<typeof stateOf>[0], over: { runSession?: boolean } = {}): Rig {
  const dir = tempDir('lucium-sync-exchange-')
  const time = { t: 0 }
  const locked = { v: false }
  const mac: Rig['mac'] = { state: stateOf(macSeed), listeners: [], applied: [] }
  const store = new SyncStore(join(dir, 'sync.json'))
  const ports: SessionPorts = {
    host: {
      state: () => mac.state,
      apply: (patch) => {
        mac.applied.push(patch)
        mac.state = reduce(mac.state, { type: 'sync/apply', patch }, { now: 1_790_000_000_000 + time.t, newId: () => 'made' })
      },
      isSpaceLocked: () => false,
      isAppLocked: () => false
    },
    subscribe: (listener) => (mac.listeners.push(listener), () => void mac.listeners.splice(mac.listeners.indexOf(listener), 1)),
    marksFile: join(dir, 'sync-marks.json'),
    basesDir: dir,
    appVersion: '1.2.0',
    stateVersion: 1,
    openTabs: () => [{ id: 'open-1', spaceId: 'sp-main', url: 'https://reading.example/', title: 'Reading', lastActiveAt: 7 }]
  }
  const service = new SyncService({
    store,
    identities: new IdentityStore(join(dir, 'sync-identity.json'), box),
    box,
    clock: new SafeClock({ monotonic: () => time.t, wall: () => 1_790_000_000_000 + time.t }),
    hostEnv: () => ({ hostname: 'mac.local', interfaces: {} }),
    deviceName: () => 'Mac de test',
    now: () => 1_790_000_000_000 + time.t,
    isLocked: () => locked.v,
    session: ports,
    allowSource: () => true,
    ...(over.runSession === true ? { runSession: async () => undefined } : {})
  })
  cleanup.push(() => service.dispose())
  const phoneTls = testIdentity(PHONE_ID)
  store.addPeer({ id: PHONE_ID, name: 'iPhone de test', platform: 'ios', fingerprint: phoneTls.fingerprint.toString('hex'), pairedAt: 1, lastSessionAt: null })
  const phone = new Device(PHONE_ID, 'ios', phoneSeed)
  return { service, dir, store, mac, phone, phoneTls, time, locked, port: () => store.config().port as number }
}

/** The iPhone connects and runs one session, as the client of the door. */
async function phoneSession(r: Rig, macDeviceId: string): ReturnType<Device['run']> {
  const { socket } = await connectTls(r.port(), r.phoneTls)
  const channel = new Channel(socket, { phase: 'session', role: 'ios' })
  const result = await r.phone.run(channel, macDeviceId)
  socket.destroy()
  return result
}

const macDeviceId = (r: Rig): string => new IdentityStore(join(r.dir, 'sync-identity.json'), box).load()?.deviceId ?? ''

describe('the service with the exchange of the data', () => {
  it('runs a session with a paired iPhone through the real door: the two devices end with the same spaces, and the Mac says so', async () => {
    const r = rig({ spaces: [{ id: 'sp-work', name: 'Travail' }], tabs: [{ id: 'tab-a', spaceId: 'sp-work', anchorUrl: 'https://a.example/' }] }, { spaces: [{ id: 'sp-phone', name: 'Téléphone' }] })
    await r.service.setEnabled(true)
    await r.service.openWindow()
    r.phone.edit((s) => s)
    const result = await phoneSession(r, macDeviceId(r))
    expect(result).toMatchObject({ ok: true })
    await sleep(50)
    expect(r.mac.state.spaces.map((s) => s.id).sort()).toEqual(['sp-phone', 'sp-work'])
    expect(r.phone.state.spaces.map((s) => s.id).sort()).toEqual(['sp-phone', 'sp-work'])
    expect(r.phone.state.tabs.map((t) => t.id)).toEqual(['tab-a'])
    expect(r.service.status().lastExchange).toMatchObject({ ok: true, code: null })
    expect(r.service.status().devices[0]?.lastSessionAt).not.toBeNull()
    expect(existsSync(join(r.dir, `sync-base-${PHONE_ID}.json`))).toBe(true)
    expect(existsSync(join(r.dir, 'sync-marks.json'))).toBe(true)
  })

  it('writes the marks and the base next to the state, and nothing of them in the state', async () => {
    const r = rig({ spaces: [{ id: 'sp-work', name: 'Secret title' }] }, {})
    await r.service.setEnabled(true)
    await r.service.openWindow()
    r.phone.edit((s) => s)
    await phoneSession(r, macDeviceId(r))
    await sleep(30)
    expect(JSON.stringify(r.mac.state)).not.toContain('hash')
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(r.dir, 'sync-marks.json'), 'utf8')).not.toContain('Secret title')
  })

  it('keeps the open tabs of the iPhone in memory only, once the category is ticked on both sides, and keeps them after the window closes', async () => {
    const r = rig({}, {})
    r.store.setCategory('openTabs', true)
    r.phone.categories.add('openTabs')
    r.phone.openTabs = [{ id: 'p1', spaceId: 'sp-main', url: 'https://phone.example/', title: 'Phone page', lastActiveAt: 5 }]
    await r.service.setEnabled(true)
    await r.service.openWindow()
    r.phone.edit((s) => s)
    await phoneSession(r, macDeviceId(r))
    await sleep(30)
    expect(r.service.openTabsFrom(PHONE_ID)).toEqual(r.phone.openTabs)
    expect(r.phone.received[0]?.items).toEqual([{ id: 'open-1', spaceId: 'sp-main', url: 'https://reading.example/', title: 'Reading', lastActiveAt: 7 }])
    expect(r.mac.state.tabs).toEqual([])
    await r.service.closeWindow()
    expect(r.service.openTabsFrom(PHONE_ID)).toEqual(r.phone.openTabs)
  })

  describe('the list « Sur l\'iPhone » of the command bar', () => {
    /** A Mac with the category ticked on both sides, and one session through. */
    async function withList() {
      const r = rig({}, {})
      r.store.setCategory('openTabs', true)
      r.phone.categories.add('openTabs')
      r.phone.openTabs = [{ id: 'p1', spaceId: 'sp-main', url: 'https://phone.example/', title: 'Phone page', lastActiveAt: 5 }]
      await r.service.setEnabled(true)
      await r.service.openWindow()
      r.phone.edit((s) => s)
      await phoneSession(r, macDeviceId(r))
      await sleep(30)
      return r
    }

    it('shows the rows once a session announced them, the iPhone named in the identifier', async () => {
      const r = await withList()
      const source = r.service.resumeSource()
      expect(source).toMatchObject({ paired: true, categoryOnHere: true, listAnnounced: true, sessionHappened: true })
      expect(source.announcedAt).toBe(1_790_000_000_000 + r.time.t)
      expect(source.rows).toEqual([{ id: `${PHONE_ID}:p1:${createHash('sha256').update('https://phone.example/').digest('hex').slice(0, 12)}`, url: 'https://phone.example/', title: 'Phone page', host: 'phone.example', spaceId: 'sp-main', lastActiveAt: 5 }])
    })

    /** The bar's way of opening a line: what `handleSyncResume` does with the service, and what it dispatched. */
    function click(r: Awaited<ReturnType<typeof withList>>, id: string): unknown[] {
      const dispatched: unknown[] = []
      handleSyncResume(r.service, { state: () => ({ spaces: [{ id: 'sp-main' }], activeSpaceId: 'sp-main' }) as never, isSpaceLocked: () => false, dispatch: (action) => void dispatched.push(action) }, { kind: 'open', id })
      return dispatched
    }

    it('opens the page of the line that was clicked when an iPhone gives two lines the same tab identifier (review, second pass)', async () => {
      const r = rig({}, {})
      r.store.setCategory('openTabs', true)
      r.phone.categories.add('openTabs')
      r.phone.openTabs = [
        { id: 'x', spaceId: 'sp-main', url: 'https://evil.example/', title: 'Bank', lastActiveAt: 9 },
        { id: 'x', spaceId: 'sp-main', url: 'https://good.example/', title: 'Bank', lastActiveAt: 5 }
      ]
      await r.service.setEnabled(true)
      await r.service.openWindow()
      r.phone.edit((s) => s)
      await phoneSession(r, macDeviceId(r))
      await sleep(30)
      const lines = handleSyncResume(r.service, { state: () => ({ spaces: [], activeSpaceId: 'sp-main' }) as never, isSpaceLocked: () => false, dispatch: () => undefined }, { kind: 'list' })
      const shown = lines.ok ? lines.view.lines : []
      expect(shown.map((line) => line.host).sort()).toEqual(['evil.example', 'good.example'])
      for (const line of shown) expect(click(r, line.id)).toEqual([{ type: 'tab/open', url: `https://${line.host}/`, spaceId: 'sp-main' }])
    })

    it('opens nothing for a line whose page was replaced by another session: the line the person saw is not the one that opens (review, second pass)', async () => {
      const r = await withList()
      const before = r.service.resumeSource().rows[0]!
      expect(click(r, before.id)).toHaveLength(1)
      r.phone.openTabs = [{ id: 'p1', spaceId: 'sp-main', url: 'https://evil.example/phish', title: 'Phone page', lastActiveAt: 6 }]
      r.phone.edit((s) => s)
      await phoneSession(r, macDeviceId(r))
      await sleep(30)
      expect(r.service.resumeSource().rows.map((row) => row.url)).toEqual(['https://evil.example/phish'])
      expect(click(r, before.id)).toEqual([])
    })

    it('says nothing before any session, and tells « the iPhone sent nothing » only after one without a list', async () => {
      const r = rig({}, {})
      r.store.setCategory('openTabs', true)
      await r.service.setEnabled(true)
      expect(r.service.resumeSource()).toMatchObject({ paired: true, announcedAt: null, sessionHappened: false, rows: [] })
      await r.service.openWindow()
      r.phone.edit((s) => s)
      await phoneSession(r, macDeviceId(r))
      await sleep(30)
      expect(r.service.resumeSource()).toMatchObject({ announcedAt: null, listAnnounced: false, sessionHappened: true, rows: [] })
    })

    it('is not paired while the switch is off', async () => {
      const r = rig({}, {})
      expect(r.service.resumeSource()).toMatchObject({ paired: false })
    })

    it('forgets the list when the category is unticked, and keeps it when another one is', async () => {
      const r = await withList()
      r.service.setCategory('settings', true)
      expect(r.service.resumeSource().rows).toHaveLength(1)
      r.service.setCategory('openTabs', false)
      expect(r.service.resumeSource()).toMatchObject({ categoryOnHere: false, announcedAt: null, rows: [] })
      expect(r.service.openTabsFrom(PHONE_ID)).toEqual([])
    })

    it('forgets the list when the application locks', async () => {
      const r = await withList()
      r.locked.v = true
      await r.service.lockChanged()
      expect(r.service.resumeSource()).toMatchObject({ announcedAt: null, rows: [] })
    })

    it('forgets the list when the synchronisation is stopped', async () => {
      const r = await withList()
      await r.service.setEnabled(false)
      expect(r.service.resumeSource()).toMatchObject({ paired: false, announcedAt: null, rows: [] })
    })

    it('forgets the list with the iPhone: paired again, the old list does not come back', async () => {
      const r = await withList()
      const peer = r.store.peers()[0]!
      r.service.forget(PHONE_ID)
      expect(r.service.resumeSource()).toMatchObject({ paired: false, announcedAt: null, rows: [] })
      r.store.addPeer(peer)
      expect(r.service.resumeSource()).toMatchObject({ paired: true, announcedAt: null, listAnnounced: false, sessionHappened: false, rows: [] })
    })

    it('counts the iPhones only: another kind of device is no iPhone paired', async () => {
      const r = rig({}, {})
      await r.service.setEnabled(true)
      const peer = r.store.peers()[0]!
      r.store.forgetPeer(PHONE_ID)
      r.store.addPeer({ ...peer, platform: 'mac' })
      expect(r.service.resumeSource().paired).toBe(false)
    })

    it('keeps the list, with its age, after the window closes (and still after it closes for another reason than the person)', async () => {
      const r = await withList()
      const before = r.service.resumeSource()
      expect(before.announcedAt).not.toBeNull()
      await r.service.closeWindow()
      expect(r.service.resumeSource()).toEqual(before)
      await r.service.closeWindow('timeout')
      expect(r.service.resumeSource().rows).toHaveLength(1)
    })

    it('forgets the list when Lucium quits', async () => {
      const r = await withList()
      await r.service.dispose()
      expect(r.service.resumeSource()).toMatchObject({ announcedAt: null, sessionHappened: false, rows: [] })
    })
  })

  it('forgets the iPhone, and its base, when it says it forgets the Mac', async () => {
    const r = rig({ spaces: [{ id: 'sp-work' }] }, {})
    await r.service.setEnabled(true)
    await r.service.openWindow()
    r.phone.edit((s) => s)
    await phoneSession(r, macDeviceId(r))
    await sleep(30)
    expect(existsSync(join(r.dir, `sync-base-${PHONE_ID}.json`))).toBe(true)
    const { socket } = await connectTls(r.port(), r.phoneTls)
    const channel = new Channel(socket, { phase: 'session', role: 'ios' })
    await channel.receive()
    await channel.send({ t: 'hello', device: { id: PHONE_ID, name: 'x', platform: 'ios' }, nonce: 'ABEiM0RVZneImaq7zN3u_w', categories: [], baseHash: null, stateVersion: 1, appVersion: '1', now: 1_790_000_000_000 })
    await channel.send({ t: 'unpair' })
    await closedOrFailed(socket)
    await sleep(30)
    expect(r.service.status().devices).toEqual([])
    expect(existsSync(join(r.dir, `sync-base-${PHONE_ID}.json`))).toBe(false)
  })

  it('removes the base of a device when it is forgotten from the page', async () => {
    const r = rig({ spaces: [{ id: 'sp-work' }] }, {})
    await r.service.setEnabled(true)
    await r.service.openWindow()
    r.phone.edit((s) => s)
    await phoneSession(r, macDeviceId(r))
    await sleep(30)
    r.service.forget(PHONE_ID)
    expect(existsSync(join(r.dir, `sync-base-${PHONE_ID}.json`))).toBe(false)
  })

  it('tells the iPhone `busy` for a second session at the same time', async () => {
    const r = rig({ spaces: [{ id: 'sp-work' }] }, {})
    await r.service.setEnabled(true)
    await r.service.openWindow()
    const first = await connectTls(r.port(), r.phoneTls)
    const firstChannel = new Channel(first.socket, { phase: 'session', role: 'ios' })
    await firstChannel.receive()
    // The first session now waits for the iPhone's hello: a second connection finds the exchange taken.
    const second = await connectTls(r.port(), r.phoneTls)
    const secondChannel = new Channel(second.socket, { phase: 'session', role: 'ios' })
    expect(await secondChannel.receive()).toMatchObject({ t: 'error', code: 'busy' })
    first.socket.destroy()
    second.socket.destroy()
  })

  it('tells how a session that failed ended: the clocks of the divergence, the format of a newer state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = rig({ spaces: [{ id: 'sp-work' }] }, {})
    await r.service.setEnabled(true)
    await r.service.openWindow()
    r.phone.edit((s) => s)
    r.phone.stateVersion = 2
    const result = await phoneSession(r, macDeviceId(r))
    expect(result).toMatchObject({ ok: false })
    await sleep(50)
    expect(r.service.status().lastExchange).toMatchObject({ ok: false, code: 'state-too-new' })
    warn.mockRestore()
  })
})

describe('the marks follow the state only while the switch is on', () => {
  it('subscribes when it is turned on, and lets go when it is turned off: nothing listens while it is off', async () => {
    const r = rig({}, {})
    expect(r.mac.listeners).toHaveLength(0)
    await r.service.setEnabled(true)
    expect(r.mac.listeners).toHaveLength(1)
    await r.service.setEnabled(false)
    expect(r.mac.listeners).toHaveLength(0)
  })

  it('does not subscribe at the launch while the switch is off, and does at the launch when it was left on', async () => {
    const r = rig({}, {})
    r.service.start()
    expect(r.mac.listeners).toHaveLength(0)
    await r.service.setEnabled(true)
    await r.service.dispose()
    expect(r.mac.listeners).toHaveLength(0)
    const again = new SyncService({
      store: r.store,
      identities: new IdentityStore(join(r.dir, 'sync-identity.json'), box),
      box,
      clock: new SafeClock(),
      hostEnv: () => ({ hostname: 'x', interfaces: {} }),
      deviceName: () => 'Mac',
      now: () => 1_790_000_000_000,
      isLocked: () => false,
      session: { host: { state: () => r.mac.state, apply: () => undefined, isSpaceLocked: () => false, isAppLocked: () => false }, subscribe: (l) => (r.mac.listeners.push(l), () => void r.mac.listeners.splice(r.mac.listeners.indexOf(l), 1)), marksFile: join(r.dir, 'sync-marks.json'), basesDir: r.dir, appVersion: '1', stateVersion: 1 }
    })
    again.start()
    expect(r.mac.listeners).toHaveLength(1)
    await again.dispose()
  })

  it('does not subscribe at the launch when an identity exists but the switch was turned off', async () => {
    const r = rig({}, {})
    await r.service.setEnabled(true)
    await r.service.setEnabled(false)
    await r.service.dispose()
    expect(r.store.config().enabled).toBe(false)
    const again = new SyncService({
      store: r.store,
      identities: new IdentityStore(join(r.dir, 'sync-identity.json'), box),
      box,
      clock: new SafeClock(),
      hostEnv: () => ({ hostname: 'x', interfaces: {} }),
      deviceName: () => 'Mac',
      now: () => 1_790_000_000_000,
      isLocked: () => false,
      session: { host: { state: () => r.mac.state, apply: () => undefined, isSpaceLocked: () => false, isAppLocked: () => false }, subscribe: (l) => (r.mac.listeners.push(l), () => void r.mac.listeners.splice(r.mac.listeners.indexOf(l), 1)), marksFile: join(r.dir, 'sync-marks.json'), basesDir: r.dir, appVersion: '1', stateVersion: 1 }
    })
    again.start()
    expect(r.mac.listeners).toHaveLength(0)
  })

  it('reads the identifier at the launch without opening the key (the keychain is not asked)', async () => {
    const r = rig({}, {})
    await r.service.setEnabled(true)
    await r.service.dispose()
    const opened = vi.fn(box.open)
    const spying: SecretBox = { ...box, open: opened }
    const identities = new IdentityStore(join(r.dir, 'sync-identity.json'), spying)
    expect(identities.peekDeviceId()).toBe(macDeviceId(r))
    expect(opened).not.toHaveBeenCalled()
  })
})
