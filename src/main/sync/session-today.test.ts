// The shared Today tabs between two devices (docs/synchronisation.md §27, card 508): real sessions over real sockets with the rig of session-rig.test-support.ts, the same
// function on both sides, the actions of the reducer as the person triggers them. What a test asserts is what a person would see on each device: which tabs it has, the page
// they are on, what is in the archive, which tab is shown.
import { describe, expect, it } from 'vitest'
import { reduce } from '@shared/sidebar'
import type { Action } from '@shared/sidebar-actions'
import { roundActiveAt } from '@shared/sync-today'
import { Device, MAC_ID, NOW, PHONE_ID, sync } from './session-rig.test-support'

const ctx = (device: Device): { now: number; newId: () => string } => ({ now: device.clock, newId: () => 'made' })
const act = (device: Device, action: Action): void => device.edit((state) => reduce(state, action, ctx(device)))

/** A tab that has been open for two minutes: past the 20 s a tab must have been open to be shared (§27.3). */
const OLD = NOW - 120_000
const today = (id: string, extra: Record<string, unknown> = {}): { id: string; spaceId: string; pinned: false; createdAt: number; lastActiveAt: number } & Record<string, unknown> => ({ id, spaceId: 'sp-main', pinned: false, createdAt: OLD, lastActiveAt: OLD, ...extra })
const CATEGORIES = ['structure', 'todayTabs'] as const

/** The ids of the Today tabs of a device, in the order of its list. */
const todayOf = (device: Device, spaceId = 'sp-main'): string[] => device.state.tabs.filter((tab) => tab.spaceId === spaceId && !tab.pinned).map((tab) => tab.id)

/** Two devices that went through a first session (the Mac had the tabs): both hold them, and the base of each is the one the session wrote. */
async function synchronised(macTabs: ReturnType<typeof today>[] = [today('t-a'), today('t-b'), today('t-c')]): Promise<{ mac: Device; phone: Device }> {
  const mac = new Device(MAC_ID, 'mac', { tabs: macTabs }, [...CATEGORIES])
  const phone = new Device(PHONE_ID, 'ios', {}, [...CATEGORIES])
  mac.edit((s) => s)
  phone.edit((s) => s)
  expect(await sync(mac, phone)).toMatchObject({ mac: { ok: true }, phone: { ok: true } })
  return { mac, phone }
}

describe('a Today tab opened on a device is opened on the other one', () => {
  it('makes it there with the page it is on, asleep, without changing the tab or the space on screen', async () => {
    const mac = new Device(MAC_ID, 'mac', { tabs: [today('t-a', { url: 'https://a.example/page', title: 'Page A', customTitle: 'Mon A', icon: '🦊' })] }, [...CATEGORIES])
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }, { id: 'sp-two' }] }, [...CATEGORIES])
    const shown = { activeSpaceId: phone.state.activeSpaceId, activeTabBySpace: phone.state.activeTabBySpace }
    mac.edit((s) => s)
    phone.edit((s) => s)
    expect(await sync(mac, phone)).toMatchObject({ mac: { ok: true }, phone: { ok: true } })
    const made = phone.state.tabs.find((tab) => tab.id === 't-a')
    // Only what a Today tab is made of: no container, no window, no automatic reload (the page of a tab that is not on screen is made when it is shown, never by this).
    expect(made).toEqual({ id: 't-a', spaceId: 'sp-main', url: 'https://a.example/page', title: 'Page A', customTitle: 'Mon A', icon: '🦊', pinned: false, createdAt: roundActiveAt(OLD), lastActiveAt: roundActiveAt(OLD) })
    expect({ activeSpaceId: phone.state.activeSpaceId, activeTabBySpace: phone.state.activeTabBySpace }).toEqual(shown)
    // The book holds the admission, with the marks of the tab, and no tombstone: the next session sees the tab as there.
    expect(mac.marks.knows('todayTab', 't-a')).toBe(true)
    expect(Object.keys(mac.marks.stampsOf('todayTab', 't-a')).sort()).toEqual(['activeAt', 'spaceId'].concat('customTitle', 'icon').sort())
    expect(mac.marks.tombstonesOf()['todayTab']).toBeUndefined()
  })

  it('does not send a tab that has been open for less than twenty seconds, and sends it at the session after', async () => {
    const mac = new Device(MAC_ID, 'mac', { tabs: [today('t-young', { createdAt: NOW - 5000 })] }, [...CATEGORIES])
    const phone = new Device(PHONE_ID, 'ios', {}, [...CATEGORIES])
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual([])
    mac.clock += 30_000
    phone.clock += 30_000
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-young'])
  })

  it('sends nothing while the category is not ticked on both devices', async () => {
    const mac = new Device(MAC_ID, 'mac', { tabs: [today('t-a')] }, [...CATEGORIES])
    const phone = new Device(PHONE_ID, 'ios', {}, ['structure'])
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual([])
    // Nothing is admitted while the category is not common: the book does not hold the tab.
    expect(mac.marks.knows('todayTab', 't-a')).toBe(false)
    phone.categories.add('todayTabs')
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-a'])
  })

  it('does not send a private tab or a tab of a locked space', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }, { id: 'sp-locked' }], tabs: [today('t-ok'), today('t-private', { private: true }), today('t-locked', { spaceId: 'sp-locked' })] }, [...CATEGORIES])
    mac.locked.add('sp-locked')
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }, { id: 'sp-locked' }] }, [...CATEGORIES])
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(phone.state.tabs.map((tab) => tab.id)).toEqual(['t-ok'])
  })

  it('keeps the order of the list, and the tabs that are not shared keep their places', async () => {
    const { mac, phone } = await synchronised()
    // A tab of the phone that is not shared (a private one) sits between two shared ones: it does not move when the others are put in order.
    phone.edit((s) => ({ ...s, tabs: [...s.tabs.slice(0, 1), { id: 't-own', spaceId: 'sp-main', url: 'https://own.example/', title: 'own', pinned: false, private: true, createdAt: OLD, lastActiveAt: OLD }, ...s.tabs.slice(1)] }))
    expect(todayOf(phone)).toEqual(['t-a', 't-own', 't-b', 't-c'])
    act(mac, { type: 'tab/move', id: 't-c', toIndex: 0, pinned: false })
    expect(todayOf(mac)).toEqual(['t-c', 't-a', 't-b'])
    await sync(mac, phone)
    expect(todayOf(mac)).toEqual(['t-c', 't-a', 't-b'])
    expect(todayOf(phone).filter((id) => id !== 't-own')).toEqual(['t-c', 't-a', 't-b'])
    expect(todayOf(phone).indexOf('t-own')).toBe(1)
  })
})

describe('the marks of the Today tabs in a session', () => {
  it('are brought up to the admitted tabs at the freeze: a tab that is there has its marks and no tombstone while the merge is applied', async () => {
    const { mac, phone } = await synchronised()
    act(mac, { type: 'tab/rename', id: 't-a', title: 'Nouveau nom' })
    let held: { knows: boolean; marks: string[]; tombstones: unknown } | undefined
    mac.duringSession = () => {
      held = { knows: mac.marks.knows('todayTab', 't-a'), marks: Object.keys(mac.marks.stampsOf('todayTab', 't-a')), tombstones: mac.marks.tombstonesOf()['todayTab'] }
    }
    act(phone, { type: 'tab/archive', id: 't-c' })
    await sync(mac, phone)
    expect(held).toEqual({ knows: true, marks: expect.arrayContaining(['spaceId', 'activeAt']), tombstones: undefined })
  })
})

describe('a Today tab closed on a device is closed on the other one, and goes to its archive', () => {
  it('archives it with the source « sync » and the id of the tab, with the page it is on there', async () => {
    const { mac, phone } = await synchronised()
    // The person navigated there: the address is not what the other device was told (§27.10, [Q14]), and it is the one the archive keeps.
    act(phone, { type: 'tab/update', id: 't-a', patch: { url: 'https://moved.example/elsewhere', title: 'Elsewhere' } })
    act(mac, { type: 'tab/archive', id: 't-a' })
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-b', 't-c'])
    expect(phone.state.archive.find((entry) => entry.id === 't-a')).toMatchObject({ id: 't-a', source: 'sync', url: 'https://moved.example/elsewhere', title: 'Elsewhere', spaceId: 'sp-main' })
    // Nothing comes back at the sessions that follow.
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-b', 't-c'])
    expect(todayOf(mac)).toEqual(['t-b', 't-c'])
  })

  it('works the other way round: a tab closed on the phone is archived on the Mac', async () => {
    const { mac, phone } = await synchronised()
    act(phone, { type: 'tab/archive', id: 't-b' })
    await sync(mac, phone)
    expect(todayOf(mac)).toEqual(['t-a', 't-c'])
    expect(mac.state.archive.find((entry) => entry.id === 't-b')).toMatchObject({ source: 'sync', url: 'https://t-b.example/' })
  })

  it('closes the tab that is on screen, shows its neighbour and tells it (§27.5, [Q11])', async () => {
    const { mac, phone } = await synchronised()
    act(phone, { type: 'tab/select', id: 't-b' })
    expect(phone.state.activeTabBySpace['sp-main']).toBe('t-b')
    act(mac, { type: 'tab/archive', id: 't-b' })
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-a', 't-c'])
    expect(['t-a', 't-c']).toContain(phone.state.activeTabBySpace['sp-main'])
    expect(phone.shownClosed).toEqual([[{ id: 't-b', spaceId: 'sp-main', onScreen: true }]])
    expect(mac.shownClosed).toEqual([])
  })

  it('does not say a tab was closed on screen when it was not the selected one', async () => {
    const { mac, phone } = await synchronised()
    act(phone, { type: 'tab/select', id: 't-a' })
    act(mac, { type: 'tab/archive', id: 't-c' })
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-a', 't-b'])
    expect(phone.shownClosed).toEqual([])
  })

  it('keeps the tab on both devices when it was read on the other one after the base (a use wins over a closing, §27.9), with the page the archive held', async () => {
    const { mac, phone } = await synchronised()
    act(mac, { type: 'tab/archive', id: 't-a' })
    // Read on the phone a quarter of an hour later: its `activeAt` moves to the next step of ten minutes.
    phone.clock += 15 * 60_000
    act(phone, { type: 'tab/select', id: 't-a' })
    await sync(mac, phone)
    expect(todayOf(phone)).toContain('t-a')
    // The Mac gets it back: the page is the one its archive kept when it closed it, and the entry is used up, as when a closed tab is reopened.
    expect(todayOf(mac)).toContain('t-a')
    expect(mac.state.tabs.find((tab) => tab.id === 't-a')?.url).toBe('https://t-a.example/')
    expect(mac.state.archive.some((entry) => entry.id === 't-a')).toBe(false)
  })
})

describe('the admission is sticky', () => {
  it('keeps a tab in the shared set whatever page it goes to, so that the other device does not read a navigation as a closing', async () => {
    const { mac, phone } = await synchronised()
    act(mac, { type: 'tab/update', id: 't-a', patch: { url: 'lucium-ui://extensions/' }, allowInternalPages: true })
    expect(mac.state.tabs.find((tab) => tab.id === 't-a')?.url).toBe('lucium-ui://extensions/')
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-a', 't-b', 't-c'])
    expect(todayOf(mac)).toEqual(['t-a', 't-b', 't-c'])
  })

  it('takes a tab out when it becomes private: the other device closes it', async () => {
    const { mac, phone } = await synchronised()
    mac.edit((s) => ({ ...s, tabs: s.tabs.map((tab) => (tab.id === 't-a' ? { ...tab, private: true } : tab)) }))
    await sync(mac, phone)
    expect(todayOf(phone)).toEqual(['t-b', 't-c'])
  })
})

describe('the sweep of the inactive tabs reads the later of the two uses', () => {
  it('does not archive a tab that was read on the other device, and archives one that was not', async () => {
    const { mac, phone } = await synchronised()
    mac.state = { ...mac.state, settings: { ...mac.state.settings, autoArchiveHours: 12 } }
    // Twenty hours later: the phone read t-a an hour ago, nobody read t-b.
    const later = 20 * 3_600_000
    mac.clock += later
    phone.clock += later
    phone.state = { ...phone.state, tabs: phone.state.tabs.map((tab) => (tab.id === 't-a' ? { ...tab, lastActiveAt: phone.clock - 3_600_000 } : tab)) }
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(mac.state.tabs.find((tab) => tab.id === 't-a')?.lastActiveAt).toBe(roundActiveAt(phone.clock - 3_600_000))
    const swept = reduce(mac.state, { type: 'archive/sweep' }, ctx(mac))
    expect(todayOf({ state: swept } as Device)).toEqual(['t-a'])
    expect(swept.archive.filter((entry) => entry.source === 'auto').map((entry) => entry.id).sort()).toEqual(['t-b', 't-c'])
  })
})

describe('a tab that changes list is the same tab', () => {
  it('pinning it on one device pins it on the other, with its page, and archives nothing', async () => {
    const mac = new Device(MAC_ID, 'mac', { tabs: [today('t-a', { url: 'https://a.example/deep' })] }, ['structure', 'todayTabs'])
    const phone = new Device(PHONE_ID, 'ios', {}, ['structure', 'todayTabs'])
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    act(phone, { type: 'tab/update', id: 't-a', patch: { url: 'https://a.example/deeper' } })
    act(mac, { type: 'tab/pin', id: 't-a' })
    await sync(mac, phone)
    const tab = phone.state.tabs.find((one) => one.id === 't-a')
    expect(tab).toMatchObject({ pinned: true, anchorUrl: 'https://a.example/deep', url: 'https://a.example/deeper' })
    expect(phone.state.archive).toEqual([])
    expect(phone.state.tabs.filter((one) => one.id === 't-a')).toHaveLength(1)
  })

  it('detaching it does the same the other way round', async () => {
    const mac = new Device(MAC_ID, 'mac', { tabs: [{ id: 't-a', spaceId: 'sp-main', anchorUrl: 'https://t-a.example/', createdAt: OLD, lastActiveAt: OLD }] }, [...CATEGORIES])
    const phone = new Device(PHONE_ID, 'ios', {}, [...CATEGORIES])
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(phone.state.tabs.find((one) => one.id === 't-a')?.pinned).toBe(true)
    act(mac, { type: 'tab/unpin', id: 't-a' })
    await sync(mac, phone)
    expect(phone.state.tabs.find((one) => one.id === 't-a')).toMatchObject({ pinned: false })
    expect(phone.state.tabs.find((one) => one.id === 't-a')?.anchorUrl).toBeUndefined()
    expect(phone.state.archive).toEqual([])
  })

  it('shares no Today tab while the structure is not ticked, and does not remove the ones the Mac has: a tab depends on its space (§27.2)', async () => {
    const mac = new Device(MAC_ID, 'mac', { tabs: [today('t-a')] }, ['todayTabs'])
    const phone = new Device(PHONE_ID, 'ios', {}, ['todayTabs'])
    mac.edit((s) => s)
    phone.edit((s) => s)
    expect(await sync(mac, phone)).toMatchObject({ mac: { ok: true }, phone: { ok: true } })
    expect(todayOf(phone)).toEqual([])
    expect(todayOf(mac)).toEqual(['t-a'])
    expect(mac.state.archive).toEqual([])
  })
})

describe('a space that is deleted', () => {
  it('archives its shared Today tabs once, in the space the person is in, and nothing is archived twice', async () => {
    const mac = new Device(MAC_ID, 'mac', { spaces: [{ id: 'sp-main' }, { id: 'sp-two' }], tabs: [today('t-a'), today('t-x', { spaceId: 'sp-two' })] }, [...CATEGORIES])
    const phone = new Device(PHONE_ID, 'ios', { spaces: [{ id: 'sp-main' }, { id: 'sp-two' }] }, [...CATEGORIES])
    mac.edit((s) => s)
    phone.edit((s) => s)
    await sync(mac, phone)
    expect(phone.state.tabs.map((tab) => tab.id).sort()).toEqual(['t-a', 't-x'])
    act(mac, { type: 'space/delete', id: 'sp-two' })
    await sync(mac, phone)
    expect(phone.state.tabs.map((tab) => tab.id)).toEqual(['t-a'])
    const entries = phone.state.archive.filter((entry) => entry.id === 't-x')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ source: 'sync', spaceId: 'sp-main' })
  })
})
