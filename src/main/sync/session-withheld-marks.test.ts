// The marks of what a session set aside (a locked space) are kept, not forgotten with the merged snapshot that does not hold them (security review, second pass): when the
// space opens, the changes made on the other device meanwhile must still be older than the ones made here, or newer, as they were.
import { describe, expect, it } from 'vitest'
import { reduce } from '@shared/sidebar'
import { Device, MAC_ID, NOW, PHONE_ID, sync } from './session-rig.test-support'

const ctx = { now: NOW, newId: () => 'unused' }
const space = (id: string) => ({ id, name: id })

describe('the marks of a space that a session sets aside', () => {
  async function lockedSession() {
    const seed = { spaces: [space('sp-main'), space('sp-lock')], folders: [{ id: 'F', spaceId: 'sp-lock', name: 'orig' }], tabs: [{ id: 'T', spaceId: 'sp-lock', pinned: true }] }
    const mac = new Device(MAC_ID, 'mac', seed)
    const phone = new Device(PHONE_ID, 'ios', seed)
    mac.edit((state) => state)
    phone.edit((state) => state)
    await sync(mac, phone)
    return { mac, phone, before: { folder: mac.marks.stampsOf('folder', 'F'), tab: mac.marks.stampsOf('tab', 'T'), space: mac.marks.stampsOf('space', 'sp-lock'), order: mac.marks.orderStampOf('tabs:sp-lock:-') } }
  }

  it('are kept through a session in which the space is locked', async () => {
    const { mac, phone, before } = await lockedSession()
    expect(Object.keys(before.folder).length).toBeGreaterThan(0)
    mac.locked.add('sp-lock')
    phone.edit((state) => reduce(state, { type: 'folder/rename', id: 'F', name: 'phone-edit' } as never, ctx), 5000)
    await sync(mac, phone)
    expect(mac.marks.stampsOf('folder', 'F')).toEqual(before.folder)
    expect(mac.marks.stampsOf('tab', 'T')).toEqual(before.tab)
    expect(mac.marks.stampsOf('space', 'sp-lock')).toEqual(before.space)
    expect(mac.marks.orderStampOf('tabs:sp-lock:-')).toBe(before.order)
  })

  it('keep what the other device changed while the space was locked newer than what this one had: opened, it takes the change', async () => {
    const { mac, phone } = await lockedSession()
    mac.locked.add('sp-lock')
    phone.edit((state) => reduce(state, { type: 'folder/rename', id: 'F', name: 'phone-edit' } as never, ctx), 5000)
    await sync(mac, phone)
    mac.locked.clear()
    mac.edit((state) => state, 60_000)
    await sync(mac, phone)
    expect(mac.state.folders.find((folder) => folder.id === 'F')?.name).toBe('phone-edit')
    expect(phone.state.folders.find((folder) => folder.id === 'F')?.name).toBe('phone-edit')
  })
})
