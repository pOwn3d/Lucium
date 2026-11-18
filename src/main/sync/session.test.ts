// A synchronisation session between two devices of this code (docs/synchronisation.md §8), over real sockets: the same function runs on both, each with its own state,
// marks and base. What is asserted is what a person would see: the two devices end up with the same spaces, folders, pinned tabs and favourites, and when a session fails
// nothing is written on either side.
import { describe, expect, it, vi } from 'vitest'
import { reduce } from '@shared/sidebar'
import { Channel } from './channel'
import { hashOfSnapshot } from './bases'
import { Device, MAC_ID, NOW, PHONE_ID, sync, synced } from './session-rig.test-support'
import { partsOf, type SessionResult } from './session'
import { mergeSnapshots } from '@shared/sync-merge'
import type { SyncSnapshot } from '@shared/sync-snapshot'
import { cleanSnapshot } from './inbound-filter'
import { snapshotOf } from './state-view'
import type { Message } from './messages'
import { socketPair } from './sync-net.test-support'
import { MAX_ENTITIES_PER_PART } from './limits'

const ctx = (): { now: number; newId: () => string } => ({ now: NOW, newId: () => 'id' })
const rename = (device: Device, spaceId: string, name: string): void =>
  device.edit((state) => reduce(state, { type: 'space/update', id: spaceId, patch: { name } } as never, ctx()))
const tabIds = (device: Device): string[] => device.state.tabs.filter((tab) => tab.pinned).map((tab) => tab.id)
const names = (device: Device): string[] => device.state.spaces.map((space) => `${space.id}:${space.name}`)

describe('a first session: nothing in common', () => {
  it('gives both devices the union of what each had: the spaces, the folders, the pinned tabs, the favourites', async () => {
    const mac = new Device(MAC_ID, 'mac', {
      spaces: [{ id: 'sp-work', name: 'Travail' }, { id: 'sp-home', name: 'Maison' }],
      folders: [{ id: 'fo-docs', spaceId: 'sp-work', name: 'Docs' }],
      tabs: [{ id: 'tab-a', spaceId: 'sp-work', folderId: 'fo-docs', anchorUrl: 'https://a.example/' }, { id: 'tab-b', spaceId: 'sp-home' }],
      favorites: [{ id: 'fav-1', title: 'Un favori' }]
    })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-phone', name: 'Téléphone' }], tabs: [{ id: 'tab-p', spaceId: 'sp-phone' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(result.phone).toMatchObject({ ok: true })
    expect(names(mac).sort()).toEqual(['sp-home:Maison', 'sp-phone:Téléphone', 'sp-work:Travail'])
    expect(synced(mac)).toEqual(synced(phone))
    expect(tabIds(mac).sort()).toEqual(['tab-a', 'tab-b', 'tab-p'])
    expect(tabIds(phone).sort()).toEqual(['tab-a', 'tab-b', 'tab-p'])
    expect(phone.state.folders.map((f) => f.id)).toEqual(['fo-docs'])
    expect(phone.state.favorites.map((f) => f.id)).toEqual(['fav-1'])
  })

  it('copies the page a pinned tab is on once, as a seed, and leaves what is local on its device', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }], tabs: [{ id: 'tab-a', spaceId: 'sp-main', url: 'https://now.example/page', title: 'Now', anchorUrl: 'https://a.example/', faviconUrl: 'https://now.example/i.png', lastActiveAt: 5 }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    const received = phone.state.tabs.find((tab) => tab.id === 'tab-a')
    expect(received).toMatchObject({ url: 'https://now.example/page', title: 'Now', anchorUrl: 'https://a.example/', pinned: true })
    expect(received?.faviconUrl).toBeUndefined()
    expect(received?.lastActiveAt).toBe(phone.clock)
  })

  it('does not send a tab that is not pinned or that is private, nor a locked space', async () => {
    const mac = new Device(MAC_ID, 'mac', {
      spaces: [{ id: 'sp-main' }, { id: 'sp-secret', name: 'Secret' }],
      tabs: [{ id: 'tab-today', spaceId: 'sp-main', pinned: false }, { id: 'tab-private', spaceId: 'sp-main', pinned: true, private: true }, { id: 'tab-ok', spaceId: 'sp-main' }, { id: 'tab-hidden', spaceId: 'sp-secret' }]
    })
    mac.locked.add('sp-secret')
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(tabIds(phone)).toEqual(['tab-ok'])
    expect(phone.state.spaces.map((s) => s.id)).toEqual(['sp-main'])
  })
})

describe('later sessions: each side changes things', () => {
  async function synchronised(): Promise<{ mac: Device; phone: Device }> {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'Perso' }], folders: [{ id: 'fo-a', spaceId: 'sp-main', name: 'A' }], tabs: [{ id: 'tab-1', spaceId: 'sp-main', anchorUrl: 'https://tab-1.example/' }, { id: 'tab-2', spaceId: 'sp-main', anchorUrl: 'https://tab-2.example/' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'Perso' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    expect((await sync(mac, phone)).mac).toMatchObject({ ok: true })
    return { mac, phone }
  }

  it('takes a change made on one side, and a change on another field made on the other, and keeps both', async () => {
    const { mac, phone } = await synchronised()
    rename(mac, 'sp-main', 'Travail')
    phone.edit((s) => reduce(s, { type: 'folder/rename', id: 'fo-a', name: 'Archive' } as never, ctx()))
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true, conflicts: [] })
    expect(mac.state.spaces[0]?.name).toBe('Travail')
    expect(phone.state.spaces[0]?.name).toBe('Travail')
    expect(mac.state.folders[0]?.name).toBe('Archive')
    expect(synced(mac)).toEqual(synced(phone))
  })

  it('settles two changes of the same field by the later mark, on both devices alike, and says so on both sides', async () => {
    const { mac, phone } = await synchronised()
    rename(mac, 'sp-main', 'Mac name')
    // The later gesture: the clocks tie to the millisecond otherwise, and the greater device identifier would decide.
    phone.clock = mac.clock + 5000
    rename(phone, 'sp-main', 'Phone name')
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(mac.state.spaces[0]?.name).toBe('Phone name')
    expect(phone.state.spaces[0]?.name).toBe('Phone name')
    if (result.mac.ok && result.phone.ok) {
      expect(result.mac.conflicts).toHaveLength(1)
      expect(result.mac.conflicts[0]).toMatchObject({ kind: 'space', id: 'sp-main', field: 'name', winner: 'remote' })
      expect(result.phone.conflicts[0]).toMatchObject({ winner: 'local' })
    }
  })

  it('takes a deletion when the other side did not touch the thing, and keeps what was modified over a deletion', async () => {
    const { mac, phone } = await synchronised()
    mac.edit((s) => ({ ...s, tabs: s.tabs.filter((tab) => tab.id !== 'tab-1') }))
    phone.edit((s) => ({ ...s, tabs: s.tabs.map((tab) => (tab.id === 'tab-2' ? { ...tab, customTitle: 'Renamed' } : tab)) }))
    mac.edit((s) => ({ ...s, tabs: s.tabs.filter((tab) => tab.id !== 'tab-2') }))
    await sync(mac, phone)
    expect(tabIds(phone)).toEqual(['tab-2'])
    expect(tabIds(mac)).toEqual(['tab-2'])
    expect(phone.state.tabs.find((t) => t.id === 'tab-2')?.customTitle).toBe('Renamed')
    // Given back to the Mac without its seed fields, the tab opens at the page it returns to.
    expect(mac.state.tabs.find((t) => t.id === 'tab-2')).toMatchObject({ customTitle: 'Renamed', url: 'https://tab-2.example/' })
  })

  it('carries a deletion to a device whose base was lost, by the tombstone', async () => {
    const { mac, phone } = await synchronised()
    phone.bases.remove(MAC_ID)
    mac.edit((s) => ({ ...s, tabs: s.tabs.filter((tab) => tab.id !== 'tab-1') }))
    await sync(mac, phone)
    expect(tabIds(phone)).toEqual(['tab-2'])
  })

  it('reorders a list the same way on both devices', async () => {
    const { mac, phone } = await synchronised()
    mac.edit((s) => ({ ...s, tabs: [...s.tabs].reverse() }))
    await sync(mac, phone)
    expect(tabIds(phone)).toEqual(['tab-2', 'tab-1'])
    expect(synced(mac)).toEqual(synced(phone))
  })

  it('makes a second session with nothing changed write nothing', async () => {
    const { mac, phone } = await synchronised()
    mac.applied.length = 0
    phone.applied.length = 0
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true, applied: false })
    expect(mac.applied).toEqual([])
    expect(phone.applied).toEqual([])
  })

  it('keeps what the person changes while the session runs: that field is not overwritten, and the next session sends it', async () => {
    const { mac, phone } = await synchronised()
    rename(mac, 'sp-main', 'From the Mac')
    phone.duringSession = () => {
      phone.state = reduce(phone.state, { type: 'space/update', id: 'sp-main', patch: { name: 'Typed meanwhile' } } as never, ctx())
    }
    await sync(mac, phone)
    expect(phone.state.spaces[0]?.name).toBe('Typed meanwhile')
    phone.duringSession = undefined
    phone.edit((s) => s, 5000)
    await sync(mac, phone)
    expect(mac.state.spaces[0]?.name).toBe('Typed meanwhile')
    expect(phone.state.spaces[0]?.name).toBe('Typed meanwhile')
  })
})

describe('the categories, the settings, the archive and the open tabs', () => {
  it('exchanges only the categories both devices ticked', async () => {
    const mac = new Device(MAC_ID, 'mac', { settings: { httpsUpgrade: false } }, ['structure', 'settings'])
    const phone = new Device(PHONE_ID, 'ios', { settings: { httpsUpgrade: true } }, ['structure'])
    mac.edit((s) => s)
    phone.edit((s) => s)
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true, categories: ['structure'] })
    expect(phone.state.settings.httpsUpgrade).toBe(true)
    expect(mac.state.settings.httpsUpgrade).toBe(false)
  })

  it('exchanges a setting of the closed list when both ticked it, and never one outside it', async () => {
    const mac = new Device(MAC_ID, 'mac', { settings: { sendGpc: false, proxyEnabled: true, lockApp: true } }, ['settings'])
    const phone = new Device(PHONE_ID, 'ios', { settings: { sendGpc: true } }, ['settings'])
    mac.edit((s) => s)
    phone.edit((s) => s, 5000)
    await sync(mac, phone)
    expect(mac.state.settings.sendGpc).toBe(true)
    expect(phone.state.settings.proxyEnabled).not.toBe(true)
    expect(phone.state.settings.lockApp).not.toBe(true)
  })

  it('announces the open tabs only when both ticked them, and never writes them into the state', async () => {
    const mac = new Device(MAC_ID, 'mac', {}, ['openTabs'])
    mac.openTabs = [{ id: 't1', spaceId: 'sp-main', url: 'https://read.example/', title: 'Reading', lastActiveAt: 5 }]
    const phone = new Device(PHONE_ID, 'ios', {}, ['openTabs'])
    const off = new Device('other-phone-00000001', 'ios', {}, ['structure'])
    mac.edit((s) => s)
    await sync(mac, phone)
    expect(phone.received).toEqual([{ peer: MAC_ID, items: mac.openTabs }])
    expect(phone.state.tabs).toEqual([])
    await sync(mac, off)
    expect(off.received).toEqual([])
  })
})

describe('what a session refuses, and what it leaves untouched', () => {
  const before = (device: Device): string => JSON.stringify(device.state)

  it('writes nothing on either side when the merged snapshots differ: divergence', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'A' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'B' }, { id: 'sp-extra' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    // One device runs a merge that is not the same function: the digests cannot agree.
    mac.merge = (base, local, remote, withheld) => {
      const merged = jsonMerge(base, local, remote, withheld)
      merged.snapshot.entities['space'] = {}
      return merged
    }
    const [macBefore, phoneBefore] = [before(mac), before(phone)]
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: false, code: 'divergence' })
    expect(result.phone).toMatchObject({ ok: false })
    expect(before(mac)).toBe(macBefore)
    expect(before(phone)).toBe(phoneBefore)
    expect(mac.applied).toEqual([])
    expect(phone.applied).toEqual([])
    expect(mac.bases.get(PHONE_ID, mac.clock)).toBeNull()
  })

  it('refuses a session while the application is locked', async () => {
    const mac = new Device(MAC_ID, 'mac', {})
    const phone = new Device(PHONE_ID, 'ios', {})
    mac.appLocked = true
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: false, code: 'locked' })
  })

  it('refuses a device whose state is of a newer format: nothing is written', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'A' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'B' }] })
    phone.stateVersion = 2
    const macBefore = before(mac)
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: false, code: 'state-too-new' })
    expect(before(mac)).toBe(macBefore)
  })

  it('says the clocks differ by more than five minutes, and goes on', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'A' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'A' }, { id: 'sp-new', name: 'New' }] })
    phone.clock += 10 * 60_000
    mac.edit((s) => s)
    phone.edit((s) => s, 0)
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(mac.state.spaces.map((s) => s.id).sort()).toEqual(['sp-main', 'sp-new'])
    // Both sides are told, once, and neither ends the session.
    expect(mac.warnings).toEqual(['clock-skew'])
    expect(phone.warnings).toEqual(['clock-skew'])
  })

  it('does not send an entity of its own whose address is a script: it stays where it is, untouched, counted, and the session goes on', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }], favorites: [{ id: 'fav-bad', url: 'javascript:alert(1)' }, { id: 'fav-ok', url: 'https://ok.example/' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    // `normalize` of the phone would drop the script address; put it back, as a hostile device would send it.
    phone.state = { ...phone.state, favorites: [...phone.state.favorites, { id: 'fav-bad', url: 'javascript:alert(1)', title: 'x', profileId: 'default' }] }
    phone.marks.update((await import('./state-view')).trackedViewOf(phone.state), phone.clock)
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(mac.state.favorites.map((f) => f.id)).toEqual(['fav-ok'])
    expect(phone.refused[0]).toEqual([{ kind: 'favorite', id: 'fav-bad', reason: 'invalid-url' }])
    log.mockRestore()
  })

  it('refuses a snapshot with a mark more than a week ahead of the clock', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }, { id: 'sp-future', name: 'Future' }] })
    mac.edit((s) => s)
    phone.clock += 30 * 86_400_000
    phone.edit((s) => s, 0)
    phone.clock = NOW
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(mac.state.spaces.map((s) => s.id)).toEqual(['sp-main'])
  })
})

describe('what a session checks before it writes', () => {
  /**
   * A peer written by hand that does everything right: it sends `remote` as its snapshot, works out the merge the Mac must reach (the same functions, the same gates) and
   * sends that digest, so that the Mac's own checks are what is tried. `options` makes it deviate on one point.
   */
  async function honest(mac: Device, remote: SyncSnapshot, options: { categories?: string[]; commit?: boolean; openTabs?: boolean; tabs?: unknown[] } = {}): Promise<{ result: SessionResult; mac: Device; seen: Message['t'][] }> {
    const sockets = await socketPair()
    const macChannel = new Channel(sockets.server, { phase: 'session', role: 'mac' })
    const phoneChannel = new Channel(sockets.client, { phase: 'session', role: 'ios' })
    mac.edit((state) => state, 0)
    const categories = options.categories ?? ['structure']
    const running = mac.run(macChannel, PHONE_ID)
    const seen: Message['t'][] = []
    const first = await phoneChannel.receive()
    seen.push(first.t)
    await phoneChannel.send({ t: 'hello', device: { id: PHONE_ID, name: 'x', platform: 'ios' }, nonce: 'ABEiM0RVZneImaq7zN3u_w', categories, baseHash: null, stateVersion: 1, appVersion: '1', now: mac.clock } as never)
    const common = new Set(categories.filter((c) => mac.categories.has(c as never))) as Set<never>
    const local = cleanSnapshot(snapshotOf(mac.state, mac.marks, { categories: common, withheld: new Set(), base: null }), mac.clock).snapshot
    const merged = mergeSnapshots(null, local, cleanSnapshot(remote, mac.clock).snapshot, [])
    const wire = Object.entries(remote.entities).flatMap(([kind, byId]) => Object.entries(byId).map(([id, entity]) => ({ kind, id, fields: entity.fields, stamps: entity.stamps })))
    const tombstones = Object.entries(remote.tombstones).flatMap(([kind, byId]) => Object.entries(byId).map(([id, stamp]) => ({ kind, id, stamp })))
    const lists = Object.keys(remote.order).length > 0 || Object.keys(remote.orderStamps).length > 0 ? { order: remote.order, orderStamps: remote.orderStamps } : {}
    await phoneChannel.send({ t: 'snapshot.part', part: 0, parts: 1, entities: wire, ...(tombstones.length > 0 ? { tombstones } : {}), ...lists, withheld: [] } as never)
    if (options.openTabs === true) await phoneChannel.send({ t: 'open-tabs', items: options.tabs ?? [{ id: 'p1', spaceId: 's', url: 'https://p.example/', title: 'P', lastActiveAt: 1 }] } as never)
    await phoneChannel.send({ t: 'snapshot.end', entityCount: wire.length, digest: hashOfSnapshot(remote) })
    for (;;) {
      const message = await phoneChannel.receive().catch(() => null)
      if (message === null) break
      seen.push(message.t)
      if (message.t === 'result') {
        await phoneChannel.send({ t: 'result', digest: hashOfSnapshot(merged.snapshot) })
        const commit = await phoneChannel.receive().catch(() => null)
        if (commit !== null) seen.push(commit.t)
        if (options.commit !== false) await phoneChannel.send({ t: 'commit', digest: hashOfSnapshot(merged.snapshot) }).catch(() => undefined)
        break
      }
      if (message.t === 'error') break
    }
    const left = setTimeout(() => phoneChannel.destroy(), 400)
    const result = await running
    clearTimeout(left)
    sockets.close()
    return { result, mac, seen }
  }
  const mark = (name: string): Record<string, string> => ({ [name]: '1790000000000-0000-iphone-device-0000001' })
  const space = (name: string): SyncSnapshot => ({ entities: { space: { 'sp-remote': { fields: { name }, stamps: mark('name') } } }, tombstones: {}, order: {}, orderStamps: {} })

  it('goes through with a peer that does everything right (the rig of the next checks)', async () => {
    const out = await honest(new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }), space('Remote'))
    expect(out.result).toMatchObject({ ok: true })
    expect(out.mac.state.spaces.map((s) => s.id).sort()).toEqual(['sp-main', 'sp-remote'])
  })

  it('refuses a tombstone and the mark of a list that are more than a week ahead, and the clock of the marks of this device does not follow them', async () => {
    const far = '9999999999999-0000-iphone-device-0000001'
    const remote: SyncSnapshot = { entities: {}, tombstones: { tab: { ghost: far } }, order: { spaces: ['sp-main'] }, orderStamps: { spaces: far } }
    const out = await honest(new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }), remote)
    expect(out.result).toMatchObject({ ok: true, refused: 2 })
    expect(out.mac.marks.clock.state().ms).toBeLessThan(NOW + 8 * 86_400_000)
    expect(Object.values(out.mac.marks.tombstonesOf()).flatMap((byId) => Object.values(byId))).not.toContain(far)
  })

  it('does not take into the merge what the gate for incoming entities refuses: it is counted, and the two merges still agree', async () => {
    const remote = space('Remote')
    remote.entities['favorite'] = { 'fav-bad': { fields: { url: 'javascript:alert(1)', title: 'x' }, stamps: { url: mark('url')['url'] as string, title: mark('title')['title'] as string } } }
    const out = await honest(new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }), remote)
    expect(out.result).toMatchObject({ ok: true, refused: 1 })
    expect(out.mac.refused[0]).toEqual([{ kind: 'favorite', id: 'fav-bad', reason: 'invalid-url' }])
  })

  it('refuses a snapshot whose form is not right even when its count and digest are: a field name longer than the bound', async () => {
    const remote = space('Remote')
    remote.entities['space']!['sp-remote']!.fields['f'.repeat(200)] = 1
    remote.entities['space']!['sp-remote']!.stamps['f'.repeat(200)] = mark('f')['f'] as string
    const out = await honest(new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }), remote)
    expect(out.result).toMatchObject({ ok: false, code: 'bad-message' })
  })

  it('waits for the commit of the other device: one that never comes leaves the session interrupted, not done', async () => {
    const out = await honest(new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }), space('Remote'), { commit: false })
    expect(out.result).toMatchObject({ ok: false, code: 'interrupted' })
    expect(out.mac.done).toEqual([])
  })

  it('does not send its open tabs to a device that did not tick them, and does not keep the ones it is sent', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }, ['structure', 'openTabs'])
    mac.openTabs = [{ id: 't', spaceId: 'sp-main', url: 'https://t.example/', title: 'T', lastActiveAt: 1 }]
    const out = await honest(mac, space('Remote'), { categories: ['structure'], openTabs: true })
    expect(out.seen).not.toContain('open-tabs')
    expect(out.mac.received).toEqual([])
  })

  it('keeps of the open tabs another device announces only the web pages: a script, a local file, a data address and a name that is not an address are counted and left out', async () => {
    const tab = (id: string, url: string): Record<string, unknown> => ({ id, spaceId: 's', url, title: id, lastActiveAt: 1 })
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }, ['structure', 'openTabs'])
    const out = await honest(mac, space('Remote'), {
      categories: ['structure', 'openTabs'],
      openTabs: true,
      tabs: [tab('web', 'https://p.example/a'), tab('script', 'javascript:alert(1)'), tab('file', 'file:///etc/passwd'), tab('data', 'data:text/html,<b>x</b>'), tab('text', 'not an address'), tab('long', `https://p.example/${'x'.repeat(10)}`), { ...tab('big', 'https://p.example/'), id: 'i'.repeat(129) }]
    })
    expect(out.result).toMatchObject({ ok: true })
    expect(out.mac.received).toEqual([{ peer: PHONE_ID, items: [expect.objectContaining({ id: 'web' }), expect.objectContaining({ id: 'long' })] }])
    expect(out.mac.refused.flat().filter((one) => one.kind === 'open-tab').map((one) => one.id.slice(0, 6))).toEqual(['script', 'file', 'data', 'text', 'iiiiii'])
  })

  it('takes the open tabs of a device that ticked them, and sends its own', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }] }, ['structure', 'openTabs'])
    const out = await honest(mac, space('Remote'), { categories: ['structure', 'openTabs'], openTabs: true })
    expect(out.seen).toContain('open-tabs')
    expect(out.mac.received).toHaveLength(1)
  })

  it('ends at once when the other device ends with an error that is fatal, with its code', async () => {
    const out = await hostileError('timeout', true)
    expect(out).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('goes on when the error is only a warning', async () => {
    const out = await hostileError('clock-skew', false)
    expect(out).not.toMatchObject({ code: 'clock-skew' })
  })

  async function hostileError(code: string, fatal: boolean): Promise<SessionResult> {
    const mac = new Device(MAC_ID, 'mac', {})
    const sockets = await socketPair()
    const macChannel = new Channel(sockets.server, { phase: 'session', role: 'mac' })
    const phoneChannel = new Channel(sockets.client, { phase: 'session', role: 'ios' })
    const running = mac.run(macChannel, PHONE_ID)
    await phoneChannel.receive()
    await phoneChannel.send({ t: 'hello', device: { id: PHONE_ID, name: 'x', platform: 'ios' }, nonce: 'ABEiM0RVZneImaq7zN3u_w', categories: [], baseHash: null, stateVersion: 1, appVersion: '1', now: mac.clock } as never)
    await phoneChannel.send({ t: 'error', code, fatal } as never)
    const left = setTimeout(() => phoneChannel.destroy(), 400)
    const result = await running
    clearTimeout(left)
    sockets.close()
    return result
  }

  it('says nothing, and sends not even its hello, while the application is locked', async () => {
    const mac = new Device(MAC_ID, 'mac', {})
    mac.appLocked = true
    const sockets = await socketPair()
    const macChannel = new Channel(sockets.server, { phase: 'session', role: 'mac' })
    const phoneChannel = new Channel(sockets.client, { phase: 'session', role: 'ios' })
    const running = mac.run(macChannel, PHONE_ID)
    expect(await phoneChannel.receive()).toMatchObject({ t: 'error', code: 'locked' })
    expect(await running).toMatchObject({ ok: false, code: 'locked' })
    sockets.close()
  })

  it('does not write when the application locks after the exchange and before the write', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'A' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'A' }, { id: 'sp-new', name: 'New' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    mac.merge = (base, local, remote, withheld) => {
      mac.appLocked = true
      return mergeSnapshots(base, local, remote, withheld)
    }
    const before = JSON.stringify(mac.state)
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: false, code: 'locked' })
    expect(JSON.stringify(mac.state)).toBe(before)
    expect(mac.applied).toEqual([])
  })

  it('takes the marks of the merge: a field that came from the other device carries the other device\'s mark, not a new one', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'A' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'A' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    rename(phone, 'sp-main', 'Renamed on the phone')
    await sync(mac, phone)
    expect(mac.marks.stampsOf('space', 'sp-main')['name']).toBe(phone.marks.stampsOf('space', 'sp-main')['name'])
    expect(mac.marks.stampsOf('space', 'sp-main')['name']).toMatch(/-iphone-device-0000001$/)
  })

  it('brings its marks up to the state before it freezes the snapshot: a change nobody told the book of still goes', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'A' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'A' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    mac.clock += 5000
    mac.state = reduce(mac.state, { type: 'space/update', id: 'sp-main', patch: { name: 'Changed without the tracker' } } as never, ctx())
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(phone.state.spaces[0]?.name).toBe('Changed without the tracker')
  })

  it('marks a change nobody told the book of with the time it is seen at: it wins against an earlier gesture of the other device', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'A' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main', name: 'A' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    phone.clock = NOW + 20_000
    rename(phone, 'sp-main', 'Phone, earlier')
    mac.clock = NOW + 60_000
    mac.state = reduce(mac.state, { type: 'space/update', id: 'sp-main', patch: { name: 'Mac, later, untracked' } } as never, ctx())
    await sync(mac, phone)
    expect(mac.state.spaces[0]?.name).toBe('Mac, later, untracked')
    expect(phone.state.spaces[0]?.name).toBe('Mac, later, untracked')
  })

  it('does not take for deleted what the other device set aside: a space it locked since the last session stays where it is', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }, { id: 'sp-secret', name: 'Secret' }], tabs: [{ id: 't-secret', spaceId: 'sp-secret' }] })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(phone.state.spaces.map((s) => s.id).sort()).toEqual(['sp-main', 'sp-secret'])
    phone.locked.add('sp-secret')
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(mac.state.spaces.map((s) => s.id).sort()).toEqual(['sp-main', 'sp-secret'])
    expect(tabIds(mac)).toEqual(['t-secret'])
  })
})

describe('a hostile device', () => {
  /** The other end, written by hand: it answers the hello of the Mac with what `script` says. */
  async function hostile(script: (phone: Channel, send: (body: Record<string, unknown>) => Promise<void>) => Promise<void>, mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main', name: 'Mine' }] })) {
    const sockets = await socketPair()
    const macChannel = new Channel(sockets.server, { phase: 'session', role: 'mac' })
    const phoneChannel = new Channel(sockets.client, { phase: 'session', role: 'ios' })
    mac.edit((s) => s)
    const running = mac.run(macChannel, PHONE_ID)
    await phoneChannel.receive()
    const hello = { t: 'hello', device: { id: PHONE_ID, name: 'x', platform: 'ios' }, nonce: 'ABEiM0RVZneImaq7zN3u_w', categories: ['structure'], baseHash: null, stateVersion: 1, appVersion: '1', now: mac.clock }
    await phoneChannel.send(hello as never)
    await script(phoneChannel, (body) => phoneChannel.send(body as never))
    // A hostile device that has said what it had to say leaves, if the Mac has not already ended: the Mac does not wait a minute for it.
    const left = setTimeout(() => phoneChannel.destroy(), 400)
    const result = await running
    clearTimeout(left)
    sockets.close()
    return { result, mac }
  }
  const emptyPart = { t: 'snapshot.part', part: 0, parts: 1, entities: [] }
  const emptyDigest = hashOfSnapshot({ entities: {}, tombstones: {}, order: {}, orderStamps: {} })

  it('is told `truncated`, and nothing is written, when the digest it announced is not the one of what it sent', async () => {
    const { result, mac } = await hostile(async (_phone, send) => {
      await send(emptyPart)
      await send({ t: 'snapshot.end', entityCount: 0, digest: 'f'.repeat(64) })
    })
    expect(result).toMatchObject({ ok: false, code: 'truncated' })
    expect(mac.applied).toEqual([])
  })

  it('is told `truncated` when the count of entities is not the one announced', async () => {
    const { result } = await hostile(async (_phone, send) => {
      await send(emptyPart)
      await send({ t: 'snapshot.end', entityCount: 3, digest: emptyDigest })
    })
    expect(result).toMatchObject({ ok: false, code: 'truncated' })
  })

  it('is told `truncated` when a part is missing', async () => {
    const { result } = await hostile(async (_phone, send) => {
      await send({ t: 'snapshot.part', part: 0, parts: 2, entities: [] })
      await send({ t: 'snapshot.end', entityCount: 0, digest: emptyDigest })
    })
    expect(result).toMatchObject({ ok: false, code: 'truncated' })
  })

  it('is reported, and the Mac is told to forget it, when it says `unpair`', async () => {
    const { result, mac } = await hostile(async (_phone, send) => void (await send({ t: 'unpair' })))
    expect(result).toMatchObject({ ok: false, code: 'unpaired' })
    expect(mac.unpaired).toEqual([PHONE_ID])
  })

  it('is refused when its parts do not follow one another, or an entity is twice in its snapshot', async () => {
    const out = await hostile(async (_phone, send) => void (await send({ t: 'snapshot.part', part: 1, parts: 2, entities: [] })))
    expect(out.result).toMatchObject({ ok: false, code: 'bad-message' })
    const entity = { kind: 'space', id: 's9', fields: { name: 'x' }, stamps: { name: '1790000000000-0000-iphone-device-0000001' } }
    const twice = await hostile(async (_phone, send) => void (await send({ t: 'snapshot.part', part: 0, parts: 1, entities: [entity, entity] })))
    expect(twice.result).toMatchObject({ ok: false, code: 'bad-message' })
  })

  it('cannot write into the prototype of the process by naming a kind or a tombstone `__proto__` (or `constructor`): the session ends, and Object.prototype and Object are as they were', async () => {
    const stamp = '1790000000000-0000-iphone-device-0000001'
    const proto = Object.prototype as unknown as Record<string, unknown>
    const statics = Object as unknown as Record<string, unknown>
    const attempts: Array<Record<string, unknown>> = [
      { t: 'snapshot.part', part: 0, parts: 1, entities: [{ kind: '__proto__', id: 'lucium_polluted_entity', fields: { a: 1 }, stamps: { a: stamp } }] },
      { t: 'snapshot.part', part: 0, parts: 1, entities: [], tombstones: [{ kind: '__proto__', id: 'lucium_polluted_tombstone', stamp }] },
      { t: 'snapshot.part', part: 0, parts: 1, entities: [{ kind: 'constructor', id: 'lucium_polluted_static', fields: { a: 1 }, stamps: { a: stamp } }] }
    ]
    for (const part of attempts) {
      const { result } = await hostile(async (_phone, send) => {
        await send(part)
        await send({ t: 'snapshot.end', entityCount: 1, digest: 'f'.repeat(64) })
      })
      expect(result).toMatchObject({ ok: false, code: 'bad-message' })
    }
    expect(proto['lucium_polluted_entity']).toBeUndefined()
    expect(proto['lucium_polluted_tombstone']).toBeUndefined()
    expect(statics['lucium_polluted_static']).toBeUndefined()
  })

  it('is refused when its identifier is not the one paired with its certificate', async () => {
    const mac = new Device(MAC_ID, 'mac', {})
    const sockets = await socketPair()
    const macChannel = new Channel(sockets.server, { phase: 'session', role: 'mac' })
    const phoneChannel = new Channel(sockets.client, { phase: 'session', role: 'ios' })
    const running = mac.run(macChannel, PHONE_ID)
    await phoneChannel.receive()
    await phoneChannel.send({ t: 'hello', device: { id: 'someone-else-0000001', name: 'x', platform: 'ios' }, nonce: 'ABEiM0RVZneImaq7zN3u_w', categories: [], baseHash: null, stateVersion: 1, appVersion: '1', now: NOW })
    expect(await running).toMatchObject({ ok: false, code: 'fingerprint-mismatch' })
    sockets.close()
  })

  it('cannot make the Mac write anything by a state of its own that it could not write itself: a field the reducer cleans stays cleaned', async () => {
    const entity = { kind: 'space', id: 'sp-evil', fields: { name: 'x'.repeat(5000), emoji: '<img src=x onerror=1>', theme: { primary: 'javascript:1' } }, stamps: { name: '1790000000000-0000-iphone-device-0000001', emoji: '1790000000000-0000-iphone-device-0000001', theme: '1790000000000-0000-iphone-device-0000001' } }
    const { mac } = await hostile(async (_phone, send) => {
      await send({ t: 'snapshot.part', part: 0, parts: 1, entities: [entity] })
      const snapshot = { entities: { space: { 'sp-evil': { fields: entity.fields, stamps: entity.stamps } } }, tombstones: {}, order: {}, orderStamps: {} }
      await send({ t: 'snapshot.end', entityCount: 1, digest: hashOfSnapshot(snapshot as never) })
    })
    const made = mac.state.spaces.find((space) => space.id === 'sp-evil')
    if (made !== undefined) expect(made.name.length).toBeLessThanOrEqual(200)
  })
})

describe('partsOf', () => {
  const entity = (n: number) => ({ fields: { name: `space ${n}`, pad: 'x'.repeat(2000) }, stamps: { name: '1790000000000-0000-mac', pad: '1790000000000-0000-mac' } })

  it('cuts a large snapshot in parts that each fit a frame and 500 entities, and names the spaces set aside in the first', () => {
    const snapshot = { entities: { space: Object.fromEntries(Array.from({ length: 1200 }, (_, n) => [`s${n}`, entity(n)])) }, tombstones: { tab: { t1: '1790000000000-0000-mac' } }, order: { spaces: ['s0', 's1'] }, orderStamps: { spaces: '1790000000000-0000-mac' } }
    const parts = partsOf(snapshot as never, ['locked-1'])
    expect(parts.length).toBeGreaterThan(3)
    for (const part of parts) {
      expect(part.entities.length).toBeLessThanOrEqual(MAX_ENTITIES_PER_PART)
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(1_000_000)
    }
    expect(parts.flatMap((part) => part.entities)).toHaveLength(1200)
    expect(parts[0]?.withheld).toEqual(['locked-1'])
    expect(parts.slice(1).every((part) => part.withheld === undefined)).toBe(true)
    expect(parts.flatMap((part) => part.tombstones ?? [])).toEqual([{ kind: 'tab', id: 't1', stamp: '1790000000000-0000-mac' }])
    expect(parts.flatMap((part) => Object.keys(part.order ?? {}))).toEqual(['spaces'])
  })

  it('gives one part, with no empty list, for an empty snapshot', () => {
    expect(partsOf({ entities: {}, tombstones: {}, order: {}, orderStamps: {} }, [])).toEqual([{ entities: [], withheld: [] }])
  })

  it('moves a large state through a real session, in several parts, to the same state', async () => {
    const tabs = Array.from({ length: 1300 }, (_, n) => ({ id: `tab-${String(n).padStart(4, '0')}`, spaceId: 'sp-main' }))
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }], tabs })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    const result = await sync(mac, phone)
    expect(result.phone).toMatchObject({ ok: true })
    expect(tabIds(phone)).toHaveLength(1300)
    expect(synced(mac)).toEqual(synced(phone))
  }, 30_000)
})

// A merge that is not the shipped one, for the divergence test: the real one, then one thing taken away.
import { mergeSnapshots as jsonMerge } from '@shared/sync-merge'
