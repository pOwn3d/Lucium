// A category that is not ticked on this device is not applied from the other one, whatever the other one sends (security review, second pass). An honest device sends
// nothing of a category that is not common, so what these tests make is a device that does not keep to the categories it said it had.
import { describe, expect, it } from 'vitest'
import { Device, MAC_ID, PHONE_ID, sync } from './session-rig.test-support'

const space = (id: string) => ({ id, name: id })

/** A set that says it holds `claimed` (what `hello` lists) but answers `has` for the categories that are really ticked: the other device then thinks they are common. */
class Claiming extends Set<string> {
  constructor(
    claimed: string[],
    private readonly ticked: string[]
  ) {
    super(claimed)
  }
  override has(value: string): boolean {
    return this.ticked.includes(value)
  }
}

describe('a category that is not ticked here is not applied', () => {
  it('leaves the settings and the archive as they are when a device sends them without the category being common', async () => {
    const seed = { spaces: [space('sp-main')], settings: { httpsUpgrade: true, sendGpc: true } }
    const mac = new Device(MAC_ID, 'mac', seed, ['structure'] as never)
    // This Mac ticked the structure only; its `hello` says so, and this device ticks all three and answers as if the others were common too.
    const phone = new Device(PHONE_ID, 'ios', seed, ['structure'] as never)
    phone.categories = new Claiming(['structure', 'settings', 'archive'], ['structure', 'settings', 'archive']) as never
    mac.edit((state) => state)
    phone.edit((state) => ({ ...state, settings: { ...state.settings, httpsUpgrade: false, sendGpc: false }, archive: [{ id: 'a1', spaceId: 'sp-main', url: 'https://planted.example/', title: 'planted', archivedAt: 1 }] as never }))
    // The phone's own view of what is common comes from the Mac's `hello` (structure only), so to make it send, the Mac is made to claim the categories in its `hello` too.
    mac.categories = new Claiming(['structure', 'settings', 'archive'], ['structure']) as never
    // The two devices do not reach the same merged snapshot (the other one merged what this one left out): `divergence`, and nothing is written. What matters is the state.
    await sync(mac, phone)
    expect(mac.state.settings.httpsUpgrade).toBe(true)
    expect(mac.state.settings.sendGpc).toBe(true)
    expect(mac.state.archive).toEqual([])
  })

  it('still takes the settings and the archive of a device when the categories are common', async () => {
    const seed = { spaces: [space('sp-main')], settings: { httpsUpgrade: true } }
    const mac = new Device(MAC_ID, 'mac', seed, ['structure', 'settings', 'archive'] as never)
    const phone = new Device(PHONE_ID, 'ios', seed, ['structure', 'settings', 'archive'] as never)
    mac.edit((state) => state)
    phone.edit((state) => ({ ...state, settings: { ...state.settings, httpsUpgrade: false }, archive: [{ id: 'a1', spaceId: 'sp-main', url: 'https://kept.example/', title: 'kept', archivedAt: 1 }] as never }))
    await sync(mac, phone)
    expect(mac.state.settings.httpsUpgrade).toBe(false)
    expect(mac.state.archive.map((entry) => entry.id)).toEqual(['a1'])
  })

  it('leaves the spaces as they are when the structure is not common', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [space('sp-main')], settings: { httpsUpgrade: true } }, ['settings'] as never)
    const phone = new Device(PHONE_ID, 'ios', { spaces: [space('sp-main'), space('sp-extra')] }, ['structure'] as never)
    phone.categories = new Claiming(['structure', 'settings'], ['structure', 'settings']) as never
    mac.categories = new Claiming(['settings', 'structure'], ['settings']) as never
    mac.edit((state) => state)
    phone.edit((state) => state)
    await sync(mac, phone)
    expect(mac.state.spaces.map((one) => one.id)).toEqual(['sp-main'])
  })
})
