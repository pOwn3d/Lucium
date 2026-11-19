// Deletions in both directions (docs/synchronisation.md §11.5, card 505 « Synchro automatique »): what a person deletes on one device is deleted on the other at the
// next session, whichever device it is, for each thing that is synchronised: a space, a folder, a favourite, a pinned tab. Real sessions over real sockets (the rig of
// session-rig.test-support.ts), the same function on both sides, the actions of the reducer as the person triggers them. The base of each pair is the one a first
// session wrote, so these are the « later sessions » of an automatic synchronisation, where a missing entity is a deletion and not something the other side lacks.
import { describe, expect, it } from 'vitest'
import { reduce } from '@shared/sidebar'
import type { Action } from '@shared/sidebar-actions'
import { Device, MAC_ID, NOW, PHONE_ID, sync } from './session-rig.test-support'

const ctx = (): { now: number; newId: () => string } => ({ now: NOW, newId: () => 'made' })
const act = (device: Device, action: Action): void => device.edit((state) => reduce(state, action, ctx()))

const SEED = {
  spaces: [{ id: 'sp-main', name: 'Perso' }, { id: 'sp-two', name: 'Travail' }],
  folders: [{ id: 'fo-a', spaceId: 'sp-main', name: 'A' }, { id: 'fo-b', spaceId: 'sp-main', name: 'B' }],
  tabs: [
    { id: 'tab-1', spaceId: 'sp-main', anchorUrl: 'https://tab-1.example/' },
    { id: 'tab-2', spaceId: 'sp-main', anchorUrl: 'https://tab-2.example/' }
  ],
  favorites: [{ id: 'fav-1' }, { id: 'fav-2' }]
}

/** Two devices that went through a first session: both hold everything, and the base of each is the one the session wrote. */
async function synchronised(): Promise<{ mac: Device; phone: Device }> {
  const mac = new Device(MAC_ID, 'mac', SEED)
  const phone = new Device(PHONE_ID, 'ios', SEED)
  mac.edit((s) => s)
  phone.edit((s) => s)
  expect((await sync(mac, phone)).mac).toMatchObject({ ok: true })
  return { mac, phone }
}

interface Case {
  what: string
  delete: Action
  gone: (device: Device) => boolean
  kept: (device: Device) => boolean
}

const CASES: Case[] = [
  { what: 'a space', delete: { type: 'space/delete', id: 'sp-two' }, gone: (d) => !d.state.spaces.some((s) => s.id === 'sp-two'), kept: (d) => d.state.spaces.some((s) => s.id === 'sp-main') },
  { what: 'a folder', delete: { type: 'folder/delete', id: 'fo-a' }, gone: (d) => !d.state.folders.some((f) => f.id === 'fo-a'), kept: (d) => d.state.folders.some((f) => f.id === 'fo-b') },
  { what: 'a favourite', delete: { type: 'favorite/remove', id: 'fav-1' }, gone: (d) => !d.state.favorites.some((f) => f.id === 'fav-1'), kept: (d) => d.state.favorites.some((f) => f.id === 'fav-2') },
  { what: 'a pinned tab (unpinned: it leaves the synchronised set)', delete: { type: 'tab/unpin', id: 'tab-1' }, gone: (d) => !d.state.tabs.some((t) => t.id === 'tab-1' && t.pinned), kept: (d) => d.state.tabs.some((t) => t.id === 'tab-2' && t.pinned) }
]

describe('a deletion crosses in both directions at the next session', () => {
  for (const one of CASES) {
    it(`${one.what} deleted on the Mac is deleted on the iPhone, and the rest stays`, async () => {
      const { mac, phone } = await synchronised()
      expect(one.gone(phone), 'before').toBe(false)
      act(mac, one.delete)
      expect(one.gone(mac)).toBe(true)
      expect((await sync(mac, phone)).phone).toMatchObject({ ok: true })
      expect(one.gone(phone)).toBe(true)
      expect(one.kept(phone)).toBe(true)
      expect(one.kept(mac)).toBe(true)
    })

    it(`${one.what} deleted on the iPhone is deleted on the Mac, and the rest stays`, async () => {
      const { mac, phone } = await synchronised()
      expect(one.gone(mac), 'before').toBe(false)
      act(phone, one.delete)
      expect(one.gone(phone)).toBe(true)
      expect((await sync(mac, phone)).mac).toMatchObject({ ok: true })
      expect(one.gone(mac)).toBe(true)
      expect(one.kept(mac)).toBe(true)
      expect(one.kept(phone)).toBe(true)
    })

    it(`${one.what} stays deleted on both devices at the sessions that follow (it does not come back)`, async () => {
      const { mac, phone } = await synchronised()
      act(mac, one.delete)
      await sync(mac, phone)
      await sync(mac, phone)
      expect(one.gone(mac)).toBe(true)
      expect(one.gone(phone)).toBe(true)
    })
  }

  it('carries deletions made on both sides in the same interval, each to the other', async () => {
    const { mac, phone } = await synchronised()
    act(mac, { type: 'favorite/remove', id: 'fav-1' })
    act(phone, { type: 'folder/delete', id: 'fo-a' })
    expect((await sync(mac, phone)).mac).toMatchObject({ ok: true })
    for (const device of [mac, phone]) {
      expect(device.state.favorites.some((f) => f.id === 'fav-1')).toBe(false)
      expect(device.state.folders.some((f) => f.id === 'fo-a')).toBe(false)
      expect(device.state.favorites.some((f) => f.id === 'fav-2')).toBe(true)
    }
  })

  it('carries a deletion made in a series of short sessions, as an automatic synchronisation makes them', async () => {
    const { mac, phone } = await synchronised()
    for (let round = 0; round < 3; round++) {
      await sync(mac, phone)
      phone.clock += 30_000
      mac.clock += 30_000
    }
    act(phone, { type: 'space/delete', id: 'sp-two' })
    await sync(mac, phone)
    expect(mac.state.spaces.some((s) => s.id === 'sp-two')).toBe(false)
    act(mac, { type: 'favorite/remove', id: 'fav-2' })
    await sync(mac, phone)
    expect(phone.state.favorites.some((f) => f.id === 'fav-2')).toBe(false)
  })
})
