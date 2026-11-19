// Every combination of categories two devices can tick (docs/synchronisation.md §10.1, card 516): a category whose entities depend on a space (the archive, the Today tabs)
// only travels with the structure, because the spaces travel with it. Without it the merge finds no space, takes every one of those entities for dangling (§11.7.1) and removes
// it, the ones of the device that kept to the rules first. What these tests hold is that no combination makes a session delete anything that is on a device.
import { describe, expect, it } from 'vitest'
import { SYNC_CATEGORIES, type SyncCategory } from '@shared/sync-ipc'
import { announcedCategories, commonCategories } from './session'
import { Device, MAC_ID, NOW, PHONE_ID, sync } from './session-rig.test-support'

const OLD = NOW - 120_000
const subsets = (names: readonly SyncCategory[]): SyncCategory[][] => names.reduce<SyncCategory[][]>((all, name) => [...all, ...all.map((one) => [...one, name])], [[]])
/** The categories that depend on a space for what they carry. */
const DEPENDENT: readonly SyncCategory[] = ['archive', 'todayTabs']

const entry = (id: string, spaceId = 'sp-main') => ({ id, spaceId, url: `https://${id}.example/`, title: id, archivedAt: OLD })
const today = (id: string) => ({ id, spaceId: 'sp-main', pinned: false, createdAt: OLD, lastActiveAt: OLD })

/** A device that has a space, a folder, a pinned tab, a Today tab and two archived tabs of its own. */
function deviceOf(id: string, platform: 'mac' | 'ios', own: string, categories: SyncCategory[]): Device {
  const device = new Device(id, platform, { spaces: [{ id: 'sp-main' }], folders: [{ id: `f-${own}`, spaceId: 'sp-main' }], tabs: [{ id: `p-${own}`, spaceId: 'sp-main' }, today(`t-${own}`)], settings: { httpsUpgrade: own === 'mac' } }, categories)
  device.edit((state) => ({ ...state, archive: [entry(`a1-${own}`), entry(`a2-${own}`)] as never }))
  return device
}

/** What a device holds that a session must never take from it. */
const held = (device: Device): string[] => [...device.state.spaces.map((one) => `space:${one.id}`), ...device.state.folders.map((one) => `folder:${one.id}`), ...device.state.tabs.map((one) => `tab:${one.id}`), ...device.state.archive.map((one) => `archive:${one.id}`)].sort()

describe('the categories announced and taken as common (§10.1)', () => {
  it('never announces a category that depends on a space without the structure', () => {
    for (const ticked of subsets(SYNC_CATEGORIES)) {
      const announced = announcedCategories(new Set(ticked))
      if (!announced.has('structure')) for (const category of DEPENDENT) expect(announced.has(category), `[${ticked}] announces ${category} without the structure`).toBe(false)
      // Whatever does not depend on a space is announced as ticked.
      for (const category of ticked.filter((one) => !DEPENDENT.includes(one))) expect(announced.has(category), `[${ticked}] drops ${category}`).toBe(true)
    }
  })

  it('never takes a category that depends on a space as common without the structure, whatever the other device announces', () => {
    for (const mine of subsets(SYNC_CATEGORIES)) {
      for (const theirs of subsets(SYNC_CATEGORIES)) {
        const common = commonCategories(announcedCategories(new Set(mine)), theirs)
        if (!common.has('structure')) for (const category of DEPENDENT) expect(common.has(category), `[${mine}] with [${theirs}] takes ${category} without the structure`).toBe(false)
      }
    }
  })

  it('keeps taking as common what both ticked and does not depend on a space', () => {
    expect([...commonCategories(new Set<SyncCategory>(['settings', 'openTabs']), ['settings', 'openTabs', 'archive'])].sort()).toEqual(['openTabs', 'settings'])
    expect([...commonCategories(new Set<SyncCategory>(['structure', 'archive', 'todayTabs']), ['structure', 'archive', 'todayTabs'])].sort()).toEqual(['archive', 'structure', 'todayTabs'])
  })
})

describe('no combination of categories makes a session delete anything that is on a device', () => {
  it('holds for the archive alone: the archive of the Mac is not emptied (card 516)', async () => {
    const mac = deviceOf(MAC_ID, 'mac', 'mac', ['archive'])
    const phone = deviceOf(PHONE_ID, 'ios', 'phone', ['archive'])
    const before = { mac: held(mac), phone: held(phone) }
    expect(await sync(mac, phone)).toMatchObject({ mac: { ok: true }, phone: { ok: true } })
    expect(held(mac)).toEqual(before.mac)
    expect(held(phone)).toEqual(before.phone)
  })

  it('holds for the archive of a device that ticked the structure with a device that did not', async () => {
    const mac = deviceOf(MAC_ID, 'mac', 'mac', ['structure', 'archive'])
    const phone = deviceOf(PHONE_ID, 'ios', 'phone', ['archive'])
    const before = { mac: held(mac), phone: held(phone) }
    expect(await sync(mac, phone)).toMatchObject({ mac: { ok: true }, phone: { ok: true } })
    expect(held(mac)).toEqual(before.mac)
    expect(held(phone)).toEqual(before.phone)
  })

  it('holds for every pair of sets of categories', async () => {
    const sets = subsets(SYNC_CATEGORIES)
    const failures: string[] = []
    for (const macTicked of sets) {
      for (const phoneTicked of sets) {
        const mac = deviceOf(MAC_ID, 'mac', 'mac', macTicked)
        const phone = deviceOf(PHONE_ID, 'ios', 'phone', phoneTicked)
        const before = { mac: held(mac), phone: held(phone) }
        const result = await sync(mac, phone)
        const label = `mac [${macTicked}] phone [${phoneTicked}]`
        if (!result.mac.ok || !result.phone.ok) failures.push(`${label}: the session did not go through (${JSON.stringify(result)})`)
        for (const [side, device] of [['mac', mac], ['phone', phone]] as const) {
          const lost = before[side].filter((one) => !held(device).includes(one))
          if (lost.length > 0) failures.push(`${label}: ${side} lost ${lost.join(', ')}`)
        }
      }
    }
    expect(failures).toEqual([])
  }, 120_000)
})
