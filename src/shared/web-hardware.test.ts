import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import {
  DeviceGrants,
  GRANTS_MAX,
  PICKER_CHOICES_MAX,
  cleanLabel,
  deviceFacts,
  deviceKey,
  grantRows,
  hex4,
  originLabel,
  parseHardwareRequest,
  pickerChoices,
  pickerMenu,
  secureHardwareOrigin,
  sensitiveReason,
  type DeviceFacts
} from './web-hardware'
import { frenchSpaces } from './french-typography'

// ---- devices as Electron describes them (only the fields the rules read) ----
const collection = (usagePage: number, usage: number, children: unknown[] = []) => ({ usagePage, usage, type: 1, children, inputReports: [], outputReports: [], featureReports: [] })
const hid = (over: Record<string, unknown> = {}) => ({ deviceId: 'h1', vendorId: 0x046d, productId: 0xc52b, name: 'Manette', serialNumber: 'SN123456', collections: [collection(0x01, 0x05)], ...over })
const keyboard = () => hid({ deviceId: 'k1', name: 'Clavier', collections: [collection(0x01, 0x06)] })
const usbInterface = (interfaceClass: number) => ({ interfaceNumber: 0, alternates: [{ interfaceClass }] })
const usb = (classes: number[], over: Record<string, unknown> = {}) => ({ deviceId: 'u1', vendorId: 0x2341, productId: 0x0043, productName: 'Carte', serialNumber: 'AB12', deviceClass: 0, configurations: [{ interfaces: classes.map(usbInterface) }], ...over })
const port = (over: Record<string, unknown> = {}) => ({ portId: 'p1', portName: '/dev/tty.usbserial-1410', displayName: 'Adaptateur', vendorId: '9025', productId: '67', serialNumber: '', ...over })

describe('secureHardwareOrigin', () => {
  it('accepts https and, on this machine only, http, in the spelling Electron uses and in the parser’s', () => {
    expect(secureHardwareOrigin('https://exemple.org/')).toBe('https://exemple.org')
    expect(secureHardwareOrigin('https://exemple.org:8443')).toBe('https://exemple.org:8443')
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://127.1.2.3:8080', 'http://[::1]:5173/', 'http://app.localhost/']) {
      expect(secureHardwareOrigin(url), url).not.toBeNull()
    }
  })

  it('refuses http elsewhere, local files, opaque origins and anything with a login', () => {
    for (const url of ['http://exemple.org/', 'http://192.168.1.10/', 'http://localhost.exemple.org/', 'file:///x.html', 'data:text/html,x', 'about:blank', 'blob:https://a.example/1', 'null', '', 'https://user:pass@exemple.org/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/']) {
      expect(secureHardwareOrigin(url), url).toBeNull()
    }
    for (const value of [null, undefined, 42, {}, ['https://a.example/']]) expect(secureHardwareOrigin(value)).toBeNull()
    expect(secureHardwareOrigin(`https://a.example/${'x'.repeat(3000)}`)).toBeNull()
  })
})

describe('originLabel', () => {
  it('names the site without the scheme, and says when it is this computer', () => {
    expect(originLabel('https://exemple.org')).toBe('exemple.org')
    expect(originLabel('http://localhost:3000')).toBe('localhost:3000 (cet ordinateur)')
    expect(originLabel('pas une adresse')).toBe('site inconnu')
  })

  it('cuts a long host at the front: the end is what tells sites apart', () => {
    const host = `${'a'.repeat(100)}.banque-vraie.example`
    const label = originLabel(`https://${host}`)
    expect(label.startsWith('…')).toBe(true)
    expect(label.endsWith('banque-vraie.example')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(64)
  })

  it('shows an internationalized host in punycode, so that a look-alike is not passed for the real site', () => {
    expect(originLabel('https://аpple.example')).toContain('xn--')
  })
})

describe('what a device calls itself', () => {
  it('is cleaned: control, format and bidirectional characters are gone, one line, cut', () => {
    expect(cleanLabel('Clé‮gpj.exe\u0000\n\tX', 40)).toBe('Clé gpj.exe X')
    expect(cleanLabel('a'.repeat(200), 10)).toHaveLength(10)
    expect(cleanLabel('a'.repeat(200), 10).endsWith('…')).toBe(true)
    expect(cleanLabel(42, 10)).toBe('')
    expect(cleanLabel('😀'.repeat(50), 5)).toBe('😀😀😀😀…')
  })

  it('reads USB identifiers as four hexadecimal digits, from a number or from the decimal string of a serial port', () => {
    expect([hex4(0x46d), hex4(1), hex4('9025'), hex4(65535)]).toEqual(['046d', '0001', '2341', 'ffff'])
    for (const bad of [-1, 65536, 1.5, 'abc', '', '123456', null, undefined, {}, NaN]) expect(hex4(bad), String(bad)).toBe('')
  })
})

describe('deviceFacts', () => {
  it('reads a HID device, with the top-level usages that tell its interfaces apart', () => {
    const facts = deviceFacts('hid', hid({ collections: [collection(0xff60, 0x61), collection(0x01, 0x05)] }))
    expect(facts).toEqual({ kind: 'hid', vendorId: '046d', productId: 'c52b', serial: 'SN123456', name: 'Manette', shape: '1:5,ff60:61' })
  })

  it('reads a USB device and a serial port, a Bluetooth port included', () => {
    expect(deviceFacts('usb', usb([0xff]))).toMatchObject({ kind: 'usb', vendorId: '2341', productId: '0043', name: 'Carte', serial: 'AB12', shape: '' })
    expect(deviceFacts('serial', port())).toMatchObject({ kind: 'serial', vendorId: '2341', productId: '0043', name: 'Adaptateur', shape: '/dev/tty.usbserial-1410' })
    expect(deviceFacts('serial', port({ vendorId: undefined, productId: undefined, displayName: undefined, portName: '/dev/cu.Bluetooth-Incoming-Port' }))).toMatchObject({ vendorId: '', name: '/dev/cu.Bluetooth-Incoming-Port' })
  })

  it('refuses what cannot be told apart from another device', () => {
    expect(deviceFacts('hid', hid({ vendorId: undefined }))).toBeNull()
    expect(deviceFacts('usb', usb([0xff], { productId: 'x' }))).toBeNull()
    expect(deviceFacts('serial', port({ portName: '' }))).toBeNull()
    for (const raw of [null, undefined, 'x', 3, []]) expect(deviceFacts('hid', raw)).toBeNull()
  })

  it('makes one key per device: two interfaces or two ports of one make do not share it', () => {
    const a = deviceFacts('hid', hid())!
    expect(deviceKey(a)).toBe(deviceKey(deviceFacts('hid', hid({ deviceId: 'another-connection' }))!))
    expect(deviceKey(a)).not.toBe(deviceKey(deviceFacts('hid', hid({ collections: [collection(0xff60, 0x61)] }))!))
    expect(deviceKey(deviceFacts('serial', port())!)).not.toBe(deviceKey(deviceFacts('serial', port({ portName: '/dev/tty.other' }))!))
  })
})

describe('the devices that are never offered', () => {
  it('excludes a FIDO security key, wherever its usage page sits in the collections', () => {
    expect(sensitiveReason('hid', hid({ collections: [collection(0xf1d0, 0x01)] }))).toBe('fido')
    expect(sensitiveReason('hid', hid({ collections: [collection(0xff00, 0x01, [collection(0xff00, 0x02, [collection(0xf1d0, 0x01)])])] }))).toBe('fido')
  })

  it('excludes the makers of security keys even behind a vendor-specific interface', () => {
    expect(sensitiveReason('hid', hid({ vendorId: 0x1050, collections: [collection(0xff00, 0x01)] }))).toBe('security-key')
    expect(sensitiveReason('usb', usb([0xff], { vendorId: 0x096e }))).toBe('security-key')
    expect(sensitiveReason('serial', port({ vendorId: String(0x1050) }))).toBe('security-key')
  })

  it('excludes keyboards, keypads, mice and pointers, which would let a page read what is typed or moved elsewhere', () => {
    expect(sensitiveReason('hid', keyboard())).toBe('keyboard')
    expect(sensitiveReason('hid', hid({ collections: [collection(0x01, 0x07)] }))).toBe('keyboard')
    expect(sensitiveReason('hid', hid({ collections: [collection(0x01, 0x02)] }))).toBe('mouse')
    expect(sensitiveReason('hid', hid({ collections: [collection(0x01, 0x01)] }))).toBe('mouse')
    // A keyboard that also has a configuration interface: the interface that types is excluded, the configuration one is not.
    expect(sensitiveReason('hid', hid({ collections: [collection(0xff60, 0x61)] }))).toBeNull()
  })

  it('offers the devices the APIs are for: a game controller, a vendor-specific HID interface', () => {
    expect(sensitiveReason('hid', hid())).toBeNull()
    expect(sensitiveReason('hid', hid({ collections: [collection(0xff60, 0x61)] }))).toBeNull()
  })

  it('does not offer a HID device whose collections are missing: it cannot be classified', () => {
    expect(sensitiveReason('hid', hid({ collections: [] }))).toBe('unknown')
    expect(sensitiveReason('hid', hid({ collections: undefined }))).toBe('unknown')
    expect(sensitiveReason('hid', 'x')).toBe('unknown')
  })

  it('excludes the USB devices that are tokens or have nothing a page may use', () => {
    expect(sensitiveReason('usb', usb([0x03]))).toBe('protected-class')
    expect(sensitiveReason('usb', usb([0x0b, 0xff]))).toBe('smart-card')
    expect(sensitiveReason('usb', usb([0x0d]))).toBe('smart-card')
    expect(sensitiveReason('usb', usb([0xff], { deviceClass: 0x08 }))).toBe('protected-class')
    expect(sensitiveReason('usb', usb([0x03, 0x08]))).toBe('protected-class')
    expect(sensitiveReason('usb', usb([], { configurations: [], deviceClass: undefined }))).toBe('unknown')
  })

  it('offers a USB device that has an interface a page may claim, a composite one included', () => {
    expect(sensitiveReason('usb', usb([0xff]))).toBeNull()
    expect(sensitiveReason('usb', usb([0x02, 0x0a]))).toBeNull()
    expect(sensitiveReason('usb', usb([0x03, 0xff]))).toBeNull()
  })

  it('offers an ordinary serial port', () => {
    expect(sensitiveReason('serial', port())).toBeNull()
  })

  it('stands against a hostile device object: cycles, huge trees and wrong types', () => {
    const deep: Record<string, unknown> = collection(0xff00, 1)
    let node = deep
    for (let i = 0; i < 5000; i++) {
      const child: Record<string, unknown> = collection(0xff00, 1)
      node['children'] = [child]
      node = child
    }
    // Too deep to be read to the end: it is not trusted, whatever is at the bottom, and the call still returns.
    expect(sensitiveReason('hid', hid({ collections: [deep] }))).toBe('unknown')
    // Too many to be read to the end, a key's usage page last: the same.
    const wide = Array.from({ length: 1000 }, () => collection(0xff00, 1))
    expect(sensitiveReason('hid', hid({ collections: [...wide, collection(0xf1d0, 1)] }))).toBe('unknown')
    expect(sensitiveReason('hid', hid({ collections: [collection(0xff00, 1, [collection(0xff00, 2)])] }))).toBeNull()
    expect(sensitiveReason('usb', usb([0xff], { configurations: 'x' }))).toBe('unknown')
    // A vendor-specific device class says enough on its own.
    expect(sensitiveReason('usb', usb([], { configurations: [], deviceClass: 0xff }))).toBeNull()
  })
})

describe('the picker', () => {
  it('lists what may be offered, leaves out and counts the sensitive devices, and never prints the identifier it answers with', () => {
    const { choices, hidden } = pickerChoices('hid', [hid({ deviceId: 'secret-guid-1' }), keyboard(), hid({ deviceId: 'fido', collections: [collection(0xf1d0, 1)] })])
    expect(hidden).toBe(2)
    expect(choices).toHaveLength(1)
    expect(choices[0]!.id).toBe('secret-guid-1')
    expect(choices[0]!.label).toBe('Manette (046d:c52b) · n° …3456')
    expect(choices[0]!.label).not.toContain('secret-guid-1')
  })

  it('tells two identical devices apart by the end of their serial number', () => {
    const { choices } = pickerChoices('hid', [hid({ deviceId: 'a', serialNumber: 'AAAA1111' }), hid({ deviceId: 'b', serialNumber: 'BBBB2222' })])
    expect(new Set(choices.map((c) => c.label)).size).toBe(2)
  })

  it('prints a hostile name safely', () => {
    const { choices } = pickerChoices('usb', [usb([0xff], { productName: 'Carte‮\u0000 « vérifiée »\n'.repeat(20) })])
    expect(choices[0]!.label).not.toMatch(/[\u0000-\u001f‮]/)
    expect(choices[0]!.label.length).toBeLessThanOrEqual(90)
  })

  it('skips a device with no usable identifier, and stops at the limit of a menu', () => {
    const many = Array.from({ length: PICKER_CHOICES_MAX + 10 }, (_, i) => port({ portId: `p${i}`, portName: `/dev/tty.${i}` }))
    expect(pickerChoices('serial', [port({ portId: '' }), port({ portId: 42 }), port({ portId: 'x'.repeat(300) }), 'x', null, ...many]).choices).toHaveLength(PICKER_CHOICES_MAX)
    expect(pickerChoices('hid', 'not a list')).toEqual({ choices: [], hidden: 0 })
  })

  it('builds a menu that names the site first and puts no device under the pointer', () => {
    const { choices } = pickerChoices('usb', [usb([0xff])])
    const menu = pickerMenu({ origin: 'https://exemple.org', kind: 'usb', choices, hidden: 0 })
    expect(menu[0]).toEqual({ label: frenchSpaces('« exemple.org » veut se connecter à un appareil USB'), enabled: false })
    expect(menu[1]!.enabled).toBe(false)
    expect(menu[2]).toMatchObject({ separator: true })
    expect(menu[3]).toMatchObject({ enabled: true, choice: 'u1' })
    expect(menu.at(-1)).toEqual({ label: 'Annuler', enabled: true })
    expect(menu.filter((item) => item.choice !== undefined)).toHaveLength(1)
  })

  it('says so when nothing may be offered, and explains the devices that were held back', () => {
    const none = pickerMenu({ origin: 'https://exemple.org', kind: 'serial', choices: [], hidden: 2 })
    expect(none[0]!.label).toBe(frenchSpaces('« exemple.org » veut se connecter à un port série'))
    expect(none[1]!.label).toBe('Aucun appareil compatible n’est branché.')
    expect(none.some((item) => item.label?.includes('2 appareils protégés ne sont jamais proposés'))).toBe(true)
    expect(none.every((item) => item.choice === undefined)).toBe(true)
    expect(pickerMenu({ origin: 'https://exemple.org', kind: 'hid', choices: [], hidden: 1 }).some((item) => item.label?.startsWith('1 appareil protégé n’est jamais proposé'))).toBe(true)
  })

  it('words the request, the site of this computer and the devices held back in the language of the interface', () => {
    setLanguage('en')
    try {
      const menu = pickerMenu({ origin: 'http://localhost:3000', kind: 'hid', choices: [], hidden: 1 })
      expect(menu[0]!.label).toBe('“localhost:3000 (this computer)” wants to connect to a HID device')
      // The last line gives up: “Cancel”, not the “Undo” of the Edit menu.
      expect(menu.at(-1)).toEqual({ label: 'Cancel', enabled: true })
      expect(menu.some((item) => item.label === '1 protected device is never offered (security key, keyboard, mouse).')).toBe(true)
      expect(pickerMenu({ origin: 'https://exemple.org', kind: 'serial', choices: [], hidden: 3 }).some((item) => item.label === '3 protected devices are never offered (security key, keyboard, mouse).')).toBe(true)
    } finally {
      setLanguage('fr')
    }
  })
})

describe('DeviceGrants', () => {
  const facts = (over: Partial<DeviceFacts> = {}): DeviceFacts => ({ kind: 'hid', vendorId: '046d', productId: 'c52b', serial: 'S1', name: 'Manette', shape: '1:5', ...over })
  const give = (grants: DeviceGrants, over: Partial<{ session: string; tab: string; origin: string; facts: DeviceFacts }> = {}) => grants.grant({ session: 'work', tab: '7', origin: 'https://exemple.org', facts: facts(), ...over })

  it('lets through the device picked, for its origin, in its profile, and nothing else', () => {
    const grants = new DeviceGrants()
    give(grants)
    expect(grants.allows('work', 'https://exemple.org/', facts())).toBe(true)
    expect(grants.allows('work', 'https://autre.example/', facts())).toBe(false)
    expect(grants.allows('home', 'https://exemple.org/', facts())).toBe(false)
    expect(grants.allows('work', 'https://exemple.org/', facts({ serial: 'S2' }))).toBe(false)
    expect(grants.allows('work', 'https://exemple.org/', facts({ productId: '0001' }))).toBe(false)
    expect(grants.allows('work', 'https://exemple.org/', facts({ shape: 'ff60:61' }))).toBe(false)
    expect(grants.allows('work', 'https://exemple.org/', facts({ kind: 'usb', shape: '1:5' }))).toBe(false)
    expect(grants.allows('work', 'http://exemple.org/', facts())).toBe(false)
    expect(grants.allows('work', 'null', facts())).toBe(false)
  })

  it('never records an insecure origin', () => {
    const grants = new DeviceGrants()
    expect(give(grants, { origin: 'http://exemple.org' })).toBeNull()
    expect(give(grants, { origin: 'null' })).toBeNull()
    expect(give(grants, { tab: '' })).toBeNull()
    expect(grants.size).toBe(0)
  })

  it('takes a grant back at once: the next check says no', () => {
    const grants = new DeviceGrants()
    const grant = give(grants)!
    expect(grants.revoke(grant.id)).toBe(true)
    expect(grants.allows('work', 'https://exemple.org/', facts())).toBe(false)
    expect(grants.revoke(grant.id)).toBe(false)
  })

  it('takes every grant back, and says how many there were', () => {
    const grants = new DeviceGrants()
    give(grants)
    give(grants, { origin: 'https://b.example' })
    expect(grants.revokeAll()).toBe(2)
    expect(grants.list()).toEqual([])
  })

  it('holds one grant for the same device and origin, shared by the tabs that picked it, and ends it with the last tab', () => {
    const grants = new DeviceGrants()
    const first = give(grants, { tab: '7' })!
    const second = give(grants, { tab: '8' })!
    expect(second.id).toBe(first.id)
    expect(grants.list()).toHaveLength(1)
    expect(grants.releaseTab('7')).toBe(0)
    expect(grants.allows('work', 'https://exemple.org/', facts())).toBe(true)
    expect(grants.releaseTab('8')).toBe(1)
    expect(grants.allows('work', 'https://exemple.org/', facts())).toBe(false)
  })

  it('ends the grants of a tab that left the origin, and keeps those of a tab that stayed on it', () => {
    const grants = new DeviceGrants()
    give(grants)
    expect(grants.keepTabAt('7', 'https://exemple.org/autre-page')).toBe(0)
    expect(grants.allows('work', 'https://exemple.org/', facts())).toBe(true)
    expect(grants.keepTabAt('7', 'https://pirate.example/')).toBe(1)
    expect(grants.allows('work', 'https://exemple.org/', facts())).toBe(false)
    give(grants)
    expect(grants.keepTabAt('7', 'about:blank')).toBe(1)
    expect(grants.keepTabAt('7', 'https://pirate.example/')).toBe(0)
  })

  it('tells which tabs hold a grant', () => {
    const grants = new DeviceGrants()
    give(grants, { tab: '7' })
    give(grants, { tab: '9', origin: 'https://b.example' })
    expect([...grants.tabs()].sort()).toEqual(['7', '9'])
  })

  it('keeps no more than its limit, the oldest going first', () => {
    const grants = new DeviceGrants(GRANTS_MAX)
    for (let i = 0; i < GRANTS_MAX + 5; i++) give(grants, { facts: facts({ serial: `S${i}` }) })
    expect(grants.size).toBe(GRANTS_MAX)
    expect(grants.allows('work', 'https://exemple.org/', facts({ serial: 'S0' }))).toBe(false)
    expect(grants.allows('work', 'https://exemple.org/', facts({ serial: `S${GRANTS_MAX + 4}` }))).toBe(true)
  })

  it('lists its grants for the settings, with the site and the device spelled for a person', () => {
    const grants = new DeviceGrants()
    give(grants)
    expect(grantRows(grants.list())).toEqual([{ id: 'hw-1', origin: 'https://exemple.org', site: 'exemple.org', kind: 'hid', kindName: 'HID', device: 'Manette (046d:c52b) · n° …S1' }])
  })
})

describe('parseHardwareRequest', () => {
  it('accepts the three requests of the interface, exactly', () => {
    expect(parseHardwareRequest({ kind: 'list' })).toEqual({ kind: 'list' })
    expect(parseHardwareRequest({ kind: 'revoke-all' })).toEqual({ kind: 'revoke-all' })
    expect(parseHardwareRequest({ kind: 'revoke', id: 'hw-12' })).toEqual({ kind: 'revoke', id: 'hw-12' })
  })

  it('refuses anything else: other kinds, extra keys, ids that are not ours, other shapes', () => {
    for (const bad of [null, undefined, 'list', 4, [], { kind: 'list', extra: 1 }, { kind: 'revoke' }, { kind: 'revoke', id: 'hw-' }, { kind: 'revoke', id: '12' }, { kind: 'revoke', id: 'hw-1; drop' }, { kind: 'revoke', id: 12 }, { kind: 'revoke', id: 'hw-1', extra: 1 }, { kind: 'grant' }, { kind: 'revoke-all', id: 'hw-1' }, Object.create({ kind: 'list' })]) {
      expect(parseHardwareRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
