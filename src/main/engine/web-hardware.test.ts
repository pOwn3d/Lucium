import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { WebHardware, type HardwareChoice, type HardwareContents, type HardwareFrame, type HardwareSession } from './web-hardware'

// ---- fakes: a session that records what is installed on it, and tabs ----
class FakeSession extends EventEmitter {
  handler: ((details: { deviceType: string; origin: string; device: unknown }) => boolean) | null = null
  setDevicePermissionHandler(handler: FakeSession['handler']): void {
    this.handler = handler
  }
  total(): number {
    return ['select-hid-device', 'select-usb-device', 'select-serial-port'].reduce((sum, event) => sum + this.listenerCount(event), 0)
  }
}

class FakeTab extends EventEmitter {
  destroyed = false
  mainFrame: HardwareFrame
  constructor(
    readonly id: number,
    public url: string
  ) {
    super()
    this.mainFrame = { parent: null, origin: new URL(url).origin }
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return this.url
  }
  asContents(): HardwareContents {
    return this as unknown as HardwareContents
  }
}

const collection = (usagePage: number, usage: number) => ({ usagePage, usage, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] })
const pad = (over: Record<string, unknown> = {}) => ({ deviceId: 'h1', vendorId: 0x046d, productId: 0xc52b, name: 'Manette', serialNumber: 'SN1', collections: [collection(0x01, 0x05)], ...over })
const fidoKey = () => pad({ deviceId: 'k9', name: 'Clé', collections: [collection(0xf1d0, 1)] })
const usbDevice = (over: Record<string, unknown> = {}) => ({ deviceId: 'u1', vendorId: 0x2341, productId: 0x43, productName: 'Carte', serialNumber: 'AB', deviceClass: 0, configurations: [{ interfaces: [{ alternates: [{ interfaceClass: 0xff }] }] }], ...over })
const serialPort = (over: Record<string, unknown> = {}) => ({ portId: 'p1', portName: '/dev/tty.usbserial-1', displayName: 'Adaptateur', vendorId: '9025', productId: '67', serialNumber: '', ...over })

const SITE = 'https://exemple.org/app'

function setup(options: { on?: boolean; pick?: (request: HardwareChoice) => Promise<string | null> | string | null } = {}) {
  const session = new FakeSession()
  const tab = new FakeTab(7, SITE)
  const tabs = new Map<object, FakeTab>([[tab.mainFrame, tab]])
  const nonTabs = new Set<FakeTab>()
  const user = { acted: true }
  const warnings: string[] = []
  const requests: HardwareChoice[] = []
  const service = new WebHardware({
    contentsOf: (frame) => tabs.get(frame)?.asContents(),
    isTab: (contents) => !nonTabs.has(contents as unknown as FakeTab),
    userActed: () => user.acted,
    choose: async (request) => {
      requests.push(request)
      return options.pick ? options.pick(request) : (request.choices[0]?.id ?? null)
    },
    warn: (message) => void warnings.push(message)
  })
  service.attach('work', session as unknown as HardwareSession)
  if (options.on !== false) service.enable()

  /** Fires a select event the way Electron does and resolves with what the callback received (undefined for a cancelled request). */
  const select = (event: 'select-hid-device' | 'select-usb-device', devices: unknown[], frame: HardwareFrame | null = tab.mainFrame) =>
    new Promise<{ answer: unknown; prevented: boolean; calls: number }>((resolve) => {
      let calls = 0
      const prevent = vi.fn()
      session.emit(event, { preventDefault: prevent }, { deviceList: devices, frame }, (answer?: string | null) => {
        calls++
        // Wait a tick so that a second call, if there was one, is counted.
        setTimeout(() => resolve({ answer, prevented: prevent.mock.calls.length > 0, calls }), 0)
      })
    })
  const selectPort = (ports: unknown[], contents: FakeTab | null = tab) =>
    new Promise<{ answer: unknown; prevented: boolean }>((resolve) => {
      const prevent = vi.fn()
      session.emit('select-serial-port', { preventDefault: prevent }, ports, contents, (answer: string) => setTimeout(() => resolve({ answer, prevented: prevent.mock.calls.length > 0 }), 0))
    })
  const ask = (device: unknown, over: { deviceType?: string; origin?: string } = {}) => session.handler?.({ deviceType: over.deviceType ?? 'hid', origin: over.origin ?? 'https://exemple.org/', device }) ?? false
  return { service, session, tab, tabs, nonTabs, user, warnings, requests, select, selectPort, ask }
}

describe('a service that is off', () => {
  it('installs nothing on a session, holds no grant and refuses every check', () => {
    const t = setup({ on: false })
    expect(t.service.enabled).toBe(false)
    expect(t.session.total()).toBe(0)
    expect(t.session.handler).toBeNull()
    expect(t.service.mayRequest({ permission: 'hid', origin: 'https://exemple.org', contentsKnown: false, isMainFrame: true })).toBe(false)
    expect(t.service.deviceAllowed('work', { deviceType: 'hid', origin: 'https://exemple.org/', device: pad() })).toBe(false)
    expect(t.service.list()).toEqual([])
  })

  it('stays that way for a session that appears later', () => {
    const t = setup({ on: false })
    const later = new FakeSession()
    t.service.attach('home', later as unknown as HardwareSession)
    expect(later.total()).toBe(0)
    expect(later.handler).toBeNull()
  })

  it('does not install twice when switched on twice, nor on a session attached twice', () => {
    const t = setup()
    t.service.enable()
    t.service.attach('work', t.session as unknown as HardwareSession)
    expect(t.session.total()).toBe(3)
  })
})

describe('switching on and off', () => {
  it('installs the three pickers and the device handler on every profile, the ones that appear later included', () => {
    const t = setup()
    expect(t.session.total()).toBe(3)
    expect(t.session.handler).toBeTypeOf('function')
    const later = new FakeSession()
    t.service.attach('home', later as unknown as HardwareSession)
    expect(later.total()).toBe(3)
  })

  it('removes everything when switched off: listeners, handler, grants, watches on tabs', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    expect(t.service.list()).toHaveLength(1)
    expect(t.tab.listenerCount('did-navigate')).toBe(1)
    expect(t.service.disable()).toBe(1)
    expect(t.session.total()).toBe(0)
    expect(t.service.list()).toEqual([])
    expect(t.tab.listenerCount('did-navigate') + t.tab.listenerCount('destroyed')).toBe(0)
    expect(t.service.mayRequest({ permission: 'hid', origin: 'https://exemple.org', contentsKnown: false, isMainFrame: true })).toBe(false)
    expect(t.service.disable()).toBe(0)
  })

  it('leaves no handler at all when it is switched off without anything having been picked', () => {
    const t = setup()
    expect(t.session.handler).toBeTypeOf('function')
    t.service.disable()
    expect(t.session.total()).toBe(0)
    expect(t.session.handler).toBeNull()
  })

  it('keeps a handler that refuses everything on a profile where a device was picked: Electron’s own memory of the pick must not answer again', async () => {
    const t = setup()
    const other = new FakeSession()
    t.service.attach('home', other as unknown as HardwareSession)
    await t.select('select-hid-device', [pad()])
    t.service.disable()
    expect(t.session.handler).toBeTypeOf('function')
    expect(t.ask(pad())).toBe(false)
    expect(t.ask(pad(), { origin: 'https://autre.example/' })).toBe(false)
    // …and nothing at all where nothing was picked.
    expect(other.handler).toBeNull()
    // Switched on again, the register answers once more (it is empty: the grants went with the switch).
    t.service.enable()
    expect(t.ask(pad())).toBe(false)
    expect(t.session.total()).toBe(3)
  })

  it('refuses a list that was open when the switch went off, and records nothing', async () => {
    let release: (id: string | null) => void = () => undefined
    const t = setup({ pick: () => new Promise((resolve) => (release = resolve)) })
    const outcome = t.select('select-hid-device', [pad()])
    await vi.waitFor(() => expect(t.requests).toHaveLength(1))
    t.service.disable()
    release('h1')
    expect((await outcome).answer).toBeUndefined()
    expect(t.service.list()).toEqual([])
    expect(t.warnings.join('\n')).toContain('the page changed while the list was open')
  })
})

describe('the permission check', () => {
  const base = { permission: 'serial', origin: 'https://exemple.org', contentsKnown: true, isMainFrame: true }

  it('lets a main frame on a secure origin ask', () => {
    const t = setup()
    expect(t.service.mayRequest(base)).toBe(true)
    expect(t.service.mayRequest({ ...base, permission: 'hid', contentsKnown: false, isMainFrame: false })).toBe(true)
    expect(t.service.mayRequest({ ...base, origin: 'http://localhost:3000' })).toBe(true)
  })

  it('refuses an insecure origin, a cross-origin sub-frame, a sub-frame of a known contents, and a permission that is not a hardware one', () => {
    const t = setup()
    expect(t.service.mayRequest({ ...base, origin: 'http://exemple.org' })).toBe(false)
    expect(t.service.mayRequest({ ...base, origin: 'null' })).toBe(false)
    expect(t.service.mayRequest({ ...base, embeddingOrigin: 'https://page.example' })).toBe(false)
    expect(t.service.mayRequest({ ...base, isMainFrame: false })).toBe(false)
    expect(t.service.mayRequest({ ...base, permission: 'geolocation' })).toBe(false)
  })
})

describe('the list of devices', () => {
  it('claims the event, shows the site and the device, and gives the page the one the user picked', async () => {
    const t = setup()
    const outcome = await t.select('select-hid-device', [pad()])
    expect(outcome).toMatchObject({ answer: 'h1', prevented: true, calls: 1 })
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0]).toMatchObject({ origin: 'https://exemple.org', kind: 'hid', hidden: 0 })
    expect(t.requests[0]!.choices.map((c) => c.id)).toEqual(['h1'])
    expect(t.service.list()).toEqual([expect.objectContaining({ site: 'exemple.org', kind: 'hid', device: 'Manette (046d:c52b) · n° …SN1' })])
  })

  it('works for a USB device the same way, and for a serial port, whose cancel is an empty string', async () => {
    const t = setup()
    expect((await t.select('select-usb-device', [usbDevice()])).answer).toBe('u1')
    expect((await t.selectPort([serialPort()])).answer).toBe('p1')
    expect(t.service.list().map((g) => g.kind)).toEqual(['usb', 'serial'])
    const cancelled = setup({ pick: () => null })
    expect((await cancelled.selectPort([serialPort()])).answer).toBe('')
    expect((await cancelled.select('select-usb-device', [usbDevice()])).answer).toBeUndefined()
  })

  it('records nothing when the user gives up, or when the list holds a device nobody offered', async () => {
    const gaveUp = setup({ pick: () => null })
    expect((await gaveUp.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect(gaveUp.service.list()).toEqual([])
    const forged = setup({ pick: () => 'not-in-the-list' })
    expect((await forged.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect(forged.service.list()).toEqual([])
  })

  it('refuses a request from a sub-frame, even on a secure origin, and says why', async () => {
    const t = setup()
    const iframe: HardwareFrame = { parent: t.tab.mainFrame, origin: 'https://exemple.org' }
    t.tabs.set(iframe, t.tab)
    const outcome = await t.select('select-hid-device', [pad()], iframe)
    expect(outcome).toMatchObject({ answer: undefined, prevented: true, calls: 1 })
    expect(t.requests).toEqual([])
    expect(t.service.list()).toEqual([])
    expect(t.warnings.join('\n')).toContain('the request comes from a sub-frame')
  })

  it('refuses a frame that has gone, and a tab that is gone', async () => {
    const t = setup()
    expect((await t.select('select-hid-device', [pad()], null)).answer).toBeUndefined()
    t.tab.destroyed = true
    expect((await t.select('select-usb-device', [usbDevice()])).answer).toBeUndefined()
    expect(t.requests).toEqual([])
  })

  it('refuses a page whose origin is not secure, or opaque, and a page that is not a tab', async () => {
    const insecure = setup()
    insecure.tab.mainFrame = { parent: null, origin: 'http://exemple.org' }
    insecure.tabs.set(insecure.tab.mainFrame, insecure.tab)
    expect((await insecure.select('select-hid-device', [pad()], insecure.tab.mainFrame)).answer).toBeUndefined()
    const opaque = setup()
    opaque.tab.mainFrame = { parent: null, origin: 'null' }
    opaque.tabs.set(opaque.tab.mainFrame, opaque.tab)
    expect((await opaque.select('select-hid-device', [pad()], opaque.tab.mainFrame)).answer).toBeUndefined()
    const popup = setup()
    popup.nonTabs.add(popup.tab)
    expect((await popup.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect(popup.warnings.join('\n')).toContain('the page is not a tab')
    for (const t of [insecure, opaque, popup]) expect(t.requests).toEqual([])
  })

  it('refuses a Web Serial request from a page that is not on a secure origin, before any list is shown', async () => {
    const t = setup()
    t.tab.mainFrame = { parent: null, origin: 'http://exemple.org' }
    t.tab.url = 'http://exemple.org/'
    expect((await t.selectPort([serialPort()])).answer).toBe('')
    expect(t.requests).toEqual([])
    expect(t.warnings.join('\n')).toContain('the origin is not secure')
    expect(t.service.list()).toEqual([])
  })

  it('does not give the device when the tab cannot be watched: the grant would never end', async () => {
    const t = setup()
    t.tab.on = () => {
      throw new Error('contents destroyed')
    }
    expect((await t.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect(t.service.list()).toEqual([])
    expect(t.ask(pad())).toBe(false)
    expect(t.warnings.join('\n')).toContain('cannot be watched')
    // The failed watch leaves nothing behind: the next pick on the same tab is watched again.
    delete (t.tab as { on?: unknown }).on
    expect((await t.select('select-hid-device', [pad()])).answer).toBe('h1')
    expect(t.tab.listenerCount('did-navigate')).toBe(1)
  })

  it('refuses a request that no click or key of the user explains, and shows no list', async () => {
    const t = setup()
    t.user.acted = false
    expect((await t.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect((await t.selectPort([serialPort()])).answer).toBe('')
    expect(t.requests).toEqual([])
    expect(t.service.list()).toEqual([])
    expect(t.warnings.join('\n')).toContain('no click or key in the tab explains the request')
    t.user.acted = true
    expect((await t.select('select-hid-device', [pad()])).answer).toBe('h1')
  })

  it('accepts a page on this computer over http', async () => {
    const t = setup()
    t.tab.mainFrame = { parent: null, origin: 'http://localhost:5173' }
    t.tabs.set(t.tab.mainFrame, t.tab)
    t.tab.url = 'http://localhost:5173/'
    expect((await t.select('select-hid-device', [pad()], t.tab.mainFrame)).answer).toBe('h1')
  })

  it('shows one list at a time: a second request while one is open is refused, a third after it closes is not', async () => {
    let release: (id: string | null) => void = () => undefined
    const t = setup({ pick: () => new Promise((resolve) => (release = resolve)) })
    const first = t.select('select-hid-device', [pad()])
    await vi.waitFor(() => expect(t.requests).toHaveLength(1))
    expect((await t.select('select-usb-device', [usbDevice()])).answer).toBeUndefined()
    expect(t.warnings.join('\n')).toContain('a list is already on screen')
    release('h1')
    expect((await first).answer).toBe('h1')
    const third = t.select('select-usb-device', [usbDevice()])
    await vi.waitFor(() => expect(t.requests).toHaveLength(2))
    release('u1')
    expect((await third).answer).toBe('u1')
  })

  it('never offers a security key, a keyboard or a mouse, and says that it left some out', async () => {
    const t = setup()
    await t.select('select-hid-device', [fidoKey(), pad({ deviceId: 'k', collections: [collection(0x01, 0x06)] }), pad()])
    expect(t.requests[0]!.choices.map((c) => c.id)).toEqual(['h1'])
    expect(t.requests[0]!.hidden).toBe(2)
    expect(t.warnings.join('\n')).toContain('2 hid device(s) not offered')
  })

  it('refuses the choice when the page moved to another site while the list was open', async () => {
    const t = setup({ pick: async () => { t.tab.url = 'https://pirate.example/'; return 'h1' } })
    expect((await t.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect(t.service.list()).toEqual([])
    expect(t.warnings.join('\n')).toContain('the page changed while the list was open')
  })

  it('refuses the choice when the tab closed while the list was open', async () => {
    const t = setup({ pick: async () => { t.tab.destroyed = true; return 'h1' } })
    expect((await t.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect(t.service.list()).toEqual([])
  })

  it('cancels, with the failure in the log, when the list itself fails', async () => {
    const t = setup({ pick: () => Promise.reject(new Error('menu broke')) })
    expect((await t.select('select-hid-device', [pad()])).answer).toBeUndefined()
    expect(t.warnings.join('\n')).toContain('failed; cancelled')
    // The next request is not blocked by the failure.
    const next = setup()
    expect((await next.select('select-hid-device', [pad()])).answer).toBe('h1')
  })

  it('tells the log, once, when the answer cannot be delivered because the page is gone', async () => {
    const t = setup()
    const warnings = t.warnings
    await new Promise<void>((resolve) => {
      t.session.emit('select-hid-device', { preventDefault() {} }, { deviceList: [pad()], frame: t.tab.mainFrame }, () => {
        setTimeout(resolve, 0)
        throw new Error('Render frame was disposed')
      })
    })
    expect(warnings.join('\n')).toContain('the answer could not be delivered to https://exemple.org')
  })
})

describe('the device handler', () => {
  it('lets through the device picked, for its site, and nothing else', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    expect(t.ask(pad())).toBe(true)
    // A new connection of the same device (a new identifier) is the same device.
    expect(t.ask(pad({ deviceId: 'h2' }))).toBe(true)
    expect(t.ask(pad(), { origin: 'https://autre.example/' })).toBe(false)
    expect(t.ask(pad({ serialNumber: 'SN2' }))).toBe(false)
    expect(t.ask(pad({ productId: 1 }))).toBe(false)
    expect(t.ask(pad(), { deviceType: 'usb' })).toBe(false)
    expect(t.ask(pad(), { deviceType: 'bluetooth' })).toBe(false)
    expect(t.service.deviceAllowed('home', { deviceType: 'hid', origin: 'https://exemple.org/', device: pad() })).toBe(false)
  })

  it('refuses a device that is never offered even if it looks like one that was picked', async () => {
    const t = setup()
    const vendorSpecific = { ...collection(0xff00, 1), children: [] as unknown[] }
    await t.select('select-hid-device', [pad({ collections: [vendorSpecific] })])
    expect(t.ask(pad({ collections: [vendorSpecific] }))).toBe(true)
    // Same maker, model, serial number and top-level usage, with a security key’s collection inside: the register would say yes, the exclusion says no.
    expect(t.ask(pad({ collections: [{ ...vendorSpecific, children: [collection(0xf1d0, 1)] }] }))).toBe(false)
    // A security key or a keyboard of the same maker is another device anyway.
    expect(t.ask(pad({ collections: [collection(0xf1d0, 1)] }))).toBe(false)
    expect(t.ask(pad({ collections: [collection(0x01, 0x06)] }))).toBe(false)
  })

  it('answers no, with the failure in the log, when it cannot read the request', () => {
    const t = setup()
    const hostile = {
      deviceType: 'hid',
      origin: 'https://exemple.org/',
      get device(): unknown {
        throw new Error('boom')
      }
    }
    expect(t.session.handler!(hostile)).toBe(false)
    expect(t.warnings.join('\n')).toContain('the device check failed for https://exemple.org')
  })

  it('stops letting the device through the moment the grant is taken back, and says if a connection may stay open', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    const [grant] = t.service.list()
    expect(t.service.revoke(grant!.id)).toBe(1)
    expect(t.ask(pad())).toBe(false)
    expect(t.service.list()).toEqual([])
    expect(t.tab.listenerCount('did-navigate') + t.tab.listenerCount('destroyed')).toBe(0)
    expect(t.service.revoke('hw-99')).toBe(0)
  })

  it('takes every grant back at once', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    await t.select('select-usb-device', [usbDevice()])
    expect(t.service.list()).toHaveLength(2)
    expect(t.service.revoke()).toBe(1)
    expect(t.ask(pad())).toBe(false)
    expect(t.ask(usbDevice(), { deviceType: 'usb' })).toBe(false)
  })
})

describe('a grant lasts as long as its tab stays on the site', () => {
  it('survives a reload and a move inside the site, and ends when the tab goes to another site', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    t.tab.emit('did-navigate', {}, 'https://exemple.org/autre')
    expect(t.ask(pad())).toBe(true)
    t.tab.emit('did-navigate', {}, 'https://pirate.example/')
    expect(t.ask(pad())).toBe(false)
    expect(t.service.list()).toEqual([])
    expect(t.tab.listenerCount('did-navigate') + t.tab.listenerCount('destroyed')).toBe(0)
  })

  it('ends when the tab closes', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    t.tab.emit('destroyed')
    expect(t.ask(pad())).toBe(false)
    expect(t.service.list()).toEqual([])
  })

  it('holds while another tab that was given the same device is still open', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    const other = new FakeTab(8, SITE)
    t.tabs.set(other.mainFrame, other)
    await t.select('select-hid-device', [pad()], other.mainFrame)
    expect(t.service.list()).toHaveLength(1)
    t.tab.emit('destroyed')
    expect(t.ask(pad())).toBe(true)
    other.emit('destroyed')
    expect(t.ask(pad())).toBe(false)
  })

  it('watches a tab once, however many devices it was given', async () => {
    const t = setup()
    await t.select('select-hid-device', [pad()])
    await t.select('select-usb-device', [usbDevice()])
    expect(t.tab.listenerCount('did-navigate')).toBe(1)
    expect(t.tab.listenerCount('destroyed')).toBe(1)
  })
})
