import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ExtensionRelays, type RelayContents } from './extension-relays'

class FakeContents extends EventEmitter implements RelayContents {
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    // Electron says so after the call, not during it.
    queueMicrotask(() => this.emit('destroyed'))
  }
}

function setup() {
  const views: Array<{ webContents: FakeContents; profileId: string; extensionId: string }> = []
  const registered: string[] = []
  const relays = new ExtensionRelays<{ webContents: FakeContents }>({
    create: (profileId, extensionId) => {
      const view = { webContents: new FakeContents(), profileId, extensionId }
      views.push(view)
      return view
    },
    load: (view) => queueMicrotask(() => view.webContents.emit('did-finish-load')),
    register: (view, extensionId, name) => void registered.push(`${views.indexOf(view as (typeof views)[number])}:${extensionId}:${name}`)
  })
  return { relays, views, registered }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('ExtensionRelays', () => {
  it('makes one page per extension and profile, and has it listen to each event once it has loaded', async () => {
    const { relays, views, registered } = setup()
    relays.listen('p1', 'ext', 'alarms.onAlarm')
    relays.listen('p1', 'ext', 'alarms.onAlarm')
    relays.listen('p1', 'ext', 'storage.onChanged')
    expect(views).toHaveLength(1)
    expect(registered).toEqual([])
    await settle()
    expect(registered).toEqual(['0:ext:alarms.onAlarm', '0:ext:storage.onChanged'])
    relays.listen('p2', 'ext', 'alarms.onAlarm')
    expect(views).toHaveLength(2)
  })

  it('closes the page of an extension that leaves, so that the extension loaded again gets a relay that listens', async () => {
    const { relays, views, registered } = setup()
    relays.listen('p1', 'ext', 'alarms.onAlarm')
    await settle()
    // Switched off then on again: the worker starts over and asks for the same event.
    relays.close('p1', 'ext')
    expect(views[0]!.webContents.destroyed).toBe(true)
    relays.listen('p1', 'ext', 'alarms.onAlarm')
    await settle()
    expect(views).toHaveLength(2)
    expect(registered).toEqual(['0:ext:alarms.onAlarm', '1:ext:alarms.onAlarm'])
    // The old page reported its end after the new relay was made: the new one stays.
    expect(relays.size).toBe(1)
    relays.listen('p1', 'ext', 'storage.onChanged')
    expect(views).toHaveLength(2)
    expect(registered).toContain('1:ext:storage.onChanged')
  })

  it('forgets a page that went by itself, and makes nothing for a profile that is gone', async () => {
    const { relays, views } = setup()
    relays.listen('p1', 'ext', 'alarms.onAlarm')
    views[0]!.webContents.close()
    await settle()
    expect(relays.size).toBe(0)
    expect(() => relays.close('p1', 'ext')).not.toThrow()
    const none = new ExtensionRelays<{ webContents: FakeContents }>({ create: () => null, load: () => {}, register: () => {} })
    none.listen('gone', 'ext', 'alarms.onAlarm')
    expect(none.size).toBe(0)
  })
})
