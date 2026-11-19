// A session by differences (docs/synchronisation.md §31), between two devices of this code over real sockets: when both hold the same base, only what differs from it
// goes; the other rebuilds the snapshot and says so (`snapshot.check`); a rebuild that fails asks for the whole snapshot, and the session goes through all the same.
import { describe, expect, it, vi } from 'vitest'
import { reduce } from '@shared/sidebar'
import { Channel } from './channel'
import { Device, MAC_ID, NOW, PHONE_ID, synced } from './session-rig.test-support'
import type { SessionResult, SnapshotMode } from './session'
import { socketPair } from './sync-net.test-support'
import type { Outgoing } from './channel'

const ctx = (): { now: number; newId: () => string } => ({ now: NOW, newId: () => 'id' })
const rename = (device: Device, spaceId: string, name: string): void => device.edit((state) => reduce(state, { type: 'space/update', id: spaceId, patch: { name } } as never, ctx()))
const tabs = (count: number): Array<{ id: string; spaceId: string }> => Array.from({ length: count }, (_, n) => ({ id: `tab-${String(n).padStart(4, '0')}`, spaceId: 'sp-main' }))

type Tamper = (body: Outgoing) => Outgoing[]

/** One session over real sockets, with what each side writes passed through `tamper` (a device that deviates), and the bytes each side wrote counted. */
async function run(mac: Device, phone: Device, tampers: { mac?: Tamper; phone?: Tamper } = {}): Promise<{ mac: SessionResult; phone: SessionResult; macBytes: number; phoneBytes: number }> {
  const sockets = await socketPair()
  try {
    const macChannel = new Channel(sockets.server, { phase: 'session', role: 'mac' })
    const phoneChannel = new Channel(sockets.client, { phase: 'session', role: 'ios' })
    const wrap = (channel: Channel, tamper: Tamper | undefined): void => {
      if (tamper === undefined) return
      const send = channel.send.bind(channel)
      channel.send = async (body) => {
        for (const one of tamper(body)) await send(one)
      }
    }
    wrap(macChannel, tampers.mac)
    wrap(phoneChannel, tampers.phone)
    const [a, b] = await Promise.all([mac.run(macChannel, phone.id), phone.run(phoneChannel, mac.id)])
    return { mac: a, phone: b, macBytes: sockets.server.bytesWritten, phoneBytes: sockets.client.bytesWritten }
  } finally {
    sockets.close()
  }
}

const modeOf = (result: SessionResult): SnapshotMode | 'failed' => (result.ok ? result.snapshots : 'failed')

/** Two devices with 60 pinned tabs, merged once (the first session has no base: whole), ready for the sessions this file is about. */
async function paired(options: { differences?: boolean } = {}): Promise<{ mac: Device; phone: Device }> {
  const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'Main' }], tabs: tabs(60) })
  const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'Main' }] })
  mac.differences = options.differences ?? true
  phone.differences = options.differences ?? true
  mac.edit((s) => s)
  phone.edit((s) => s)
  const first = await run(mac, phone)
  expect([modeOf(first.mac), modeOf(first.phone)]).toEqual(['whole', 'whole'])
  return { mac, phone }
}

describe('a session by differences', () => {
  it('is used from the second session, when both devices hold the same base, and sends much less than the whole snapshot', async () => {
    const whole = await paired({ differences: false })
    const wholeSecond = await run(whole.mac, whole.phone)
    expect([modeOf(wholeSecond.mac), modeOf(wholeSecond.phone)]).toEqual(['whole', 'whole'])

    const diff = await paired()
    const second = await run(diff.mac, diff.phone)
    expect([modeOf(second.mac), modeOf(second.phone)]).toEqual(['differences', 'differences'])
    expect(second.mac).toMatchObject({ ok: true, applied: false })
    // 60 tabs and a space, nothing changed: the difference is empty, whatever the weight of the whole.
    expect(second.macBytes).toBeLessThan(wholeSecond.macBytes / 5)
    expect(second.phoneBytes).toBeLessThan(wholeSecond.phoneBytes / 5)
  })

  it('ends in the same states and the same bases as a session of whole snapshots, after changes on both sides', async () => {
    const outcome = async (differences: boolean): Promise<{ state: unknown; macBase: string | undefined; phoneBase: string | undefined; mode: string }> => {
      const { mac, phone } = await paired({ differences })
      mac.edit((state) => reduce(state, { type: 'space/update', id: 'sp-main', patch: { name: 'Renamed on the Mac' } } as never, ctx()))
      phone.edit((state) => ({ ...state, tabs: state.tabs.filter((tab) => tab.id !== 'tab-0003') }))
      mac.edit((state) => ({ ...state, tabs: state.tabs.filter((tab) => tab.id !== 'tab-0010') }))
      const result = await run(mac, phone)
      expect(result.mac).toMatchObject({ ok: true })
      expect(result.phone).toMatchObject({ ok: true })
      expect(synced(mac)).toEqual(synced(phone))
      const macBase = mac.bases.get(PHONE_ID, mac.clock)
      const phoneBase = phone.bases.get(MAC_ID, phone.clock)
      expect(macBase?.hash).toBe(phoneBase?.hash)
      return { state: synced(mac), macBase: macBase?.hash, phoneBase: phoneBase?.hash, mode: modeOf(result.mac) }
    }
    const whole = await outcome(false)
    const diff = await outcome(true)
    expect(whole.mode).toBe('whole')
    expect(diff.mode).toBe('differences')
    expect(diff.state).toEqual(whole.state)
    expect(diff.macBase).toBe(whole.macBase)
  })

  it('does not use differences when a device does not say it reads them, or when the bases differ: the session is the whole one, as before', async () => {
    const { mac, phone } = await paired()
    phone.differences = false
    const old = await run(mac, phone)
    expect([modeOf(old.mac), modeOf(old.phone)]).toEqual(['whole', 'whole'])
    expect(old.mac).toMatchObject({ ok: true })

    phone.differences = true
    phone.bases.remove(MAC_ID)
    const noBase = await run(mac, phone)
    expect([modeOf(noBase.mac), modeOf(noBase.phone)]).toEqual(['whole', 'whole'])
    expect(noBase.phone).toMatchObject({ ok: true })
  })

  it('never takes for removed what a device does not understand: an entity of a kind of a later version stays in the base, and the session goes by differences', async () => {
    const { mac, phone } = await paired()
    const unknown = { entities: { gadget: { g1: { fields: { size: 3 }, stamps: { size: '1790000000000-0000-iphone-device-0000001' } } } } }
    for (const [device, peer] of [[mac, PHONE_ID], [phone, MAC_ID]] as const) {
      const stored = device.bases.get(peer, device.clock)!
      device.bases.save(peer, { ...stored.snapshot, entities: { ...stored.snapshot.entities, ...unknown.entities } }, device.clock)
    }
    rename(mac, 'sp-main', 'Renamed')
    const result = await run(mac, phone)
    expect([modeOf(result.mac), modeOf(result.phone)]).toEqual(['differences', 'differences'])
    for (const [device, peer] of [[mac, PHONE_ID], [phone, MAC_ID]] as const) {
      const base = device.bases.get(peer, device.clock)!.snapshot
      expect(base.entities['gadget']?.['g1']).toBeDefined()
    }
  })
})

describe('a difference that does not rebuild', () => {
  const deviate = (change: (body: Record<string, unknown>) => Record<string, unknown>, when: (body: Outgoing) => boolean = (body) => body.t === 'snapshot.part' && body['base'] !== undefined): Tamper => (body) => [when(body) ? (change(body) as Outgoing) : body]

  async function withChanges(): Promise<{ mac: Device; phone: Device }> {
    const { mac, phone } = await paired()
    rename(phone, 'sp-main', 'Renamed on the phone')
    mac.edit((state) => ({ ...state, tabs: state.tabs.filter((tab) => tab.id !== 'tab-0010') }))
    return { mac, phone }
  }

  it('asks for the whole snapshot when the digest of the rebuilt one is not the announced one, and the session goes through to the same state', async () => {
    const { mac, phone } = await withChanges()
    // The phone's difference loses its one changed entity on the way: the Mac rebuilds the base, whose digest is not the phone's.
    const result = await run(mac, phone, { phone: deviate((body) => ({ ...body, entities: [] })) })
    expect(result.mac).toMatchObject({ ok: true, snapshots: 'fallback' })
    expect(result.phone).toMatchObject({ ok: true, snapshots: 'fallback' })
    expect(mac.fallbacks).toHaveLength(1)
    expect(mac.fallbacks[0]).toMatch(/digest/)
    expect(phone.fallbacks).toEqual([])
    expect(mac.state.spaces[0]?.name).toBe('Renamed on the phone')
    expect(phone.state.tabs.some((tab) => tab.id === 'tab-0010')).toBe(false)
    expect(synced(mac)).toEqual(synced(phone))
    expect(mac.bases.get(PHONE_ID, mac.clock)?.hash).toBe(phone.bases.get(MAC_ID, phone.clock)?.hash)
  })

  it('does the same in the other direction, and when both differences fail', async () => {
    const { mac, phone } = await withChanges()
    const result = await run(mac, phone, { mac: deviate((body) => ({ ...body, removedEntities: undefined })), phone: deviate((body) => ({ ...body, entities: [] })) })
    expect(result.mac).toMatchObject({ ok: true, snapshots: 'fallback' })
    expect(result.phone).toMatchObject({ ok: true, snapshots: 'fallback' })
    expect(mac.fallbacks).toHaveLength(1)
    expect(phone.fallbacks).toHaveLength(1)
    expect(synced(mac)).toEqual(synced(phone))
  })

  it('asks for the whole snapshot when the base named is not the one this device holds, or a removal names what the base does not hold', async () => {
    for (const [change, reason] of [
      [(body: Record<string, unknown>) => ({ ...body, base: 'a'.repeat(64) }), /base/],
      [(body: Record<string, unknown>) => ({ ...body, removedEntities: [{ kind: 'space', id: 'never-in-the-base' }] }), /removed entity/],
      [(body: Record<string, unknown>) => ({ ...body, removedLists: ['spaces:never'] }), /removed list/]
    ] as const) {
      const { mac, phone } = await withChanges()
      const result = await run(mac, phone, { phone: deviate(change) })
      expect(result.mac).toMatchObject({ ok: true, snapshots: 'fallback' })
      expect(mac.fallbacks[0]).toMatch(reason)
      expect(synced(mac)).toEqual(synced(phone))
    }
  })

  it('is `truncated` and writes nothing when the whole snapshot that was asked for is wrong too: there is no second fallback', async () => {
    const { mac, phone } = await withChanges()
    const wrongEnd = (body: Outgoing): Outgoing[] => (body.t === 'snapshot.end' && body['entityCount'] !== undefined ? [{ ...body, digest: 'e'.repeat(64) }] : [body])
    // Every snapshot the phone ends says a digest that is nobody's: the difference does not rebuild, and neither does the whole one that follows.
    const result = await run(mac, phone, { phone: wrongEnd })
    expect(result.mac).toMatchObject({ ok: false, code: 'truncated' })
    expect(mac.applied).toEqual([])
    expect(mac.fallbacks).toHaveLength(1)
  })

  it('does not hide an error that is not a failed rebuild: a difference that names an entity twice is a bad message', async () => {
    const { mac, phone } = await withChanges()
    const twice: Tamper = (body) => (body.t === 'snapshot.part' && body['base'] !== undefined ? [{ ...body, entities: [...(body['entities'] as unknown[]), ...(body['entities'] as unknown[])] } as Outgoing] : [body])
    const result = await run(mac, phone, { phone: twice })
    expect(result.mac).toMatchObject({ ok: false, code: 'bad-message' })
    expect(mac.applied).toEqual([])
  })
})

describe('the order of a session by differences', () => {
  async function ready(): Promise<{ mac: Device; phone: Device }> {
    const { mac, phone } = await paired()
    rename(phone, 'sp-main', 'Changed')
    return { mac, phone }
  }

  it('refuses a second `snapshot.check`, a whole snapshot nobody asked for, and a difference in a session that agreed none', async () => {
    const twice: Tamper = (body) => (body.t === 'snapshot.check' ? [body, body] : [body])
    const first = await ready()
    expect((await run(first.mac, first.phone, { phone: twice })).mac).toMatchObject({ ok: false, code: 'bad-message' })

    const unasked: Tamper = (body) => (body.t === 'snapshot.check' ? [body, { t: 'snapshot.part', part: 0, parts: 1, entities: [] } as Outgoing, { t: 'snapshot.end', entityCount: 0, digest: '0'.repeat(64) } as Outgoing] : [body])
    const second = await ready()
    expect((await run(second.mac, second.phone, { phone: unasked })).mac).toMatchObject({ ok: false, code: 'bad-message' })

    // The phone does not say `diff`: the Mac does not read differences, so a first part that says `base` is not agreed.
    const third = await ready()
    third.phone.differences = false
    const claims: Tamper = (body) => (body.t === 'snapshot.part' ? [{ ...body, base: 'b'.repeat(64) } as Outgoing] : [body])
    expect((await run(third.mac, third.phone, { phone: claims })).mac).toMatchObject({ ok: false, code: 'bad-message' })
  })

  it('refuses a removal in a whole snapshot: a snapshot that does not say it is a difference has nothing to take out of a base', async () => {
    const { mac, phone } = await ready()
    phone.differences = false
    const removes: Tamper = (body) => (body.t === 'snapshot.part' ? [{ ...body, removedLists: ['spaces'] } as Outgoing] : [body])
    expect((await run(mac, phone, { phone: removes })).mac).toMatchObject({ ok: false, code: 'bad-message' })
    expect(mac.applied).toEqual([])
  })

  it('refuses a `snapshot.check` in a session of whole snapshots', async () => {
    const { mac, phone } = await ready()
    phone.differences = false
    const extra: Tamper = (body) => (body.t === 'snapshot.end' ? [body, { t: 'snapshot.check', ok: true } as Outgoing] : [body])
    expect((await run(mac, phone, { phone: extra })).mac).toMatchObject({ ok: false, code: 'bad-message' })
  })

  it('logs the fallback and shows the person nothing: both sessions say ok', async () => {
    const { mac, phone } = await ready()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await run(mac, phone, { phone: (body) => (body.t === 'snapshot.part' && body['base'] !== undefined ? [{ ...body, entities: [] } as Outgoing] : [body]) })
    expect(result.mac.ok && result.phone.ok).toBe(true)
    expect(mac.done).toHaveLength(2)
    warn.mockRestore()
  })
})
