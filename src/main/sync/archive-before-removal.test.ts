// A space another device deleted does not take the open tabs of this one with it, without a trace (review n° 13 of the synchronisation, docs/synchronisation.md §8.5): the
// tabs of Today, which are not synchronised, go to the archive first, as `sync`. Played on the real session between two devices, and on the reducer alone.
import { describe, expect, it } from 'vitest'
import { reduce } from '@shared/sidebar'
import { applySyncPatch, type SyncPatch } from '@shared/sidebar-sync'
import { Device, MAC_ID, NOW, PHONE_ID, stateOf, sync } from './session-rig.test-support'

const ctx = { now: NOW, newId: () => 'unused' }

const spaceOf = (id: string): { id: string; name: string } => ({ id, name: id })
const removal = (id: string, name = id): SyncPatch['removals'][number] => ({ kind: 'space', id, expect: { name } })
const patchOf = (...removals: SyncPatch['removals']): SyncPatch => ({ upserts: [], removals, order: {}, settings: {} })

describe('the open tabs of a space another device deleted', () => {
  async function twoSpaces(): Promise<{ mac: Device; phone: Device }> {
    const tabs = [
      { id: 'today-1', spaceId: 'sp-work', pinned: false, url: 'https://read.example/a', title: 'A page being read' },
      { id: 'today-2', spaceId: 'sp-work', pinned: false, url: 'https://read.example/b', title: 'Another one' },
      { id: 'today-private', spaceId: 'sp-work', pinned: false, private: true, url: 'https://secret.example/' },
      { id: 'today-internal', spaceId: 'sp-work', pinned: false, url: 'lucium://settings/', title: 'Settings' },
      { id: 'today-home', spaceId: 'sp-main', pinned: false, url: 'https://home.example/' },
      { id: 'pinned-work', spaceId: 'sp-work', pinned: true, anchorUrl: 'https://pinned.example/' }
    ]
    const mac = new Device(MAC_ID, 'mac', { spaces: [spaceOf('sp-main'), spaceOf('sp-work')], tabs: tabs as never })
    const phone = new Device(PHONE_ID, 'ios', { spaces: [spaceOf('sp-main'), spaceOf('sp-work')] })
    mac.edit((s) => s)
    phone.edit((s) => s)
    expect((await sync(mac, phone)).mac).toMatchObject({ ok: true })
    return { mac, phone }
  }

  it('go to the archive of the space the person is in, as `sync`, when the session removes their space', async () => {
    const { mac, phone } = await twoSpaces()
    phone.edit((s) => reduce(s, { type: 'space/delete', id: 'sp-work' }, ctx))
    const result = await sync(mac, phone)
    expect(result.mac).toMatchObject({ ok: true })
    expect(result.phone).toMatchObject({ ok: true })
    expect(mac.state.spaces.map((space) => space.id)).toEqual(['sp-main'])
    const kept = mac.state.archive.filter((entry) => entry.source === 'sync')
    expect(kept.map((entry) => entry.id).sort()).toEqual(['today-1', 'today-2'])
    expect(kept.every((entry) => entry.spaceId === 'sp-main' && entry.archivedAt === mac.clock)).toBe(true)
    expect(kept.find((entry) => entry.id === 'today-1')).toMatchObject({ url: 'https://read.example/a', title: 'A page being read' })
    // A private tab and an internal page are not kept by the archive (it never hears of them), and what is not in the deleted space stays where it is.
    expect(mac.state.archive.some((entry) => entry.id === 'today-private' || entry.id === 'today-internal')).toBe(false)
    expect(mac.state.tabs.map((tab) => tab.id)).toEqual(['today-home'])
  })

  it('stays kept, and is not sent back as a change: the next session writes nothing', async () => {
    const { mac, phone } = await twoSpaces()
    phone.edit((s) => reduce(s, { type: 'space/delete', id: 'sp-work' }, ctx))
    await sync(mac, phone)
    mac.applied.length = 0
    const again = await sync(mac, phone)
    expect(again.mac).toMatchObject({ ok: true })
    expect(mac.state.archive.filter((entry) => entry.source === 'sync')).toHaveLength(2)
  })
})

describe('the reducer alone', () => {
  const state = (): ReturnType<typeof stateOf> =>
    stateOf({
      spaces: [spaceOf('sp-a'), spaceOf('sp-b'), spaceOf('sp-c')],
      tabs: [
        { id: 't-a', spaceId: 'sp-a', pinned: false },
        { id: 't-b', spaceId: 'sp-b', pinned: false },
        { id: 't-c', spaceId: 'sp-c', pinned: false }
      ]
    })

  it('keeps them in the active space, or in the first one left when the active space is the one removed', () => {
    const inB = applySyncPatch({ ...state(), activeSpaceId: 'sp-b' }, patchOf(removal('sp-a')), ctx)
    expect(inB.archive.map((entry) => [entry.id, entry.spaceId, entry.source])).toEqual([['t-a', 'sp-b', 'sync']])
    const inA = applySyncPatch({ ...state(), activeSpaceId: 'sp-a' }, patchOf(removal('sp-a')), ctx)
    expect(inA.archive.map((entry) => [entry.id, entry.spaceId])).toEqual([['t-a', 'sp-b']])
  })

  it('archives the tabs of every space it removes, newest first, before what the archive already held', () => {
    const base = state()
    const held = { id: 'old', spaceId: 'sp-c', url: 'https://old.example/', title: 'Old', archivedAt: 5, source: 'manual' as const }
    const result = applySyncPatch({ ...base, activeSpaceId: 'sp-c', archive: [held] }, patchOf(removal('sp-a'), removal('sp-b')), ctx)
    expect(result.spaces.map((space) => space.id)).toEqual(['sp-c'])
    expect(result.archive.map((entry) => entry.id)).toEqual(['t-a', 't-b', 'old'])
  })

  it('leaves a space alone, and its tabs, when the person changed it since the session froze it', () => {
    const base = state()
    const result = applySyncPatch({ ...base, spaces: base.spaces.map((space) => (space.id === 'sp-a' ? { ...space, name: 'Renamed meanwhile' } : space)) }, patchOf(removal('sp-a', 'sp-a')), ctx)
    expect(result.spaces.map((space) => space.id)).toContain('sp-a')
    expect(result.tabs.map((tab) => tab.id)).toContain('t-a')
    expect(result.archive).toEqual([])
  })

  it('keeps them in the space `normalize` makes when the patch removes every space', () => {
    const result = applySyncPatch(state(), patchOf(removal('sp-a'), removal('sp-b'), removal('sp-c')), ctx)
    expect(result.spaces.map((space) => space.id)).toEqual(['espace'])
    expect(result.archive.map((entry) => [entry.id, entry.spaceId, entry.source]).sort()).toEqual([['t-a', 'espace', 'sync'], ['t-b', 'espace', 'sync'], ['t-c', 'espace', 'sync']])
  })

  it('changes nothing for a patch that removes no space', () => {
    expect(applySyncPatch(state(), patchOf({ kind: 'tab', id: 'nothing', expect: {} }), ctx).archive).toEqual([])
  })
})
