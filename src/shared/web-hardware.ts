// The web's hardware APIs (WebHID, WebUSB, Web Serial), as pure rules. The engine applies them (main/engine/web-hardware.ts); nothing here
// touches Electron. What a page may be given is decided on four things: the switch in the settings (off: nothing is ever offered), the
// origin and the frame that ask (a secure origin, the main frame), the device (some kinds are never offered: security keys, keyboards,
// mice), and the user's own pick in a list that names the site. What was picked is written down in `DeviceGrants`, which is the only thing
// the permission handler of the session reads: Electron keeps its own memory of grants and cannot be told to forget one.

import { t, tp } from './i18n'
import { isRecord } from './record'

export const HARDWARE_KINDS = ['hid', 'usb', 'serial'] as const
export type HardwareKind = (typeof HARDWARE_KINDS)[number]

export const isHardwareKind = (value: unknown): value is HardwareKind => typeof value === 'string' && (HARDWARE_KINDS as readonly string[]).includes(value)

/** The permission names Electron's checks use for these APIs: they are the kinds' own names. */
export const HARDWARE_PERMISSIONS: ReadonlySet<string> = new Set(HARDWARE_KINDS)

export const KIND_NAMES: Record<HardwareKind, string> = { hid: 'HID', usb: 'USB', get serial() { return t('web-hardware.port-serie') } }

// ---------- origins ----------

const isLoopbackHost = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)

/**
 * The origin of an address when a page of it may use these APIs: https, or http on this very machine (localhost, 127.0.0.0/8, ::1), which
 * Chromium also treats as secure. Anything else (http elsewhere, file:, data:, the string "null" of an opaque origin, an address with a
 * login) is null. Accepts the spelling Electron uses ("https://a.example/") and returns the one the URL parser prints.
 */
export function secureHardwareOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || !URL.canParse(value)) return null
  const url = new URL(value)
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null
  if (url.protocol === 'https:') return url.origin
  return url.protocol === 'http:' && isLoopbackHost(url.hostname) ? url.origin : null
}

/** The site as the picker and the settings name it: the host (and port), cut at the front when long, since the end of a host is what tells sites apart. */
export function originLabel(origin: string): string {
  if (!URL.canParse(origin)) return t('web-hardware.site-inconnu')
  const url = new URL(origin)
  const label = url.host.length > 64 ? `…${url.host.slice(-63)}` : url.host
  return url.protocol === 'http:' ? t('web-hardware.label-cet-ordinateur', { label }) : label
}

// ---------- text that comes from hardware ----------

// A device names itself: the name is data from the world, printed in a menu and in the settings.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** A name from a device, safe to print: no control, format or bidirectional characters, one line, cut at `max` characters. */
export function cleanLabel(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.slice(0, max * 4).replace(UNSAFE_TEXT, ' ').replace(/\s+/gu, ' ').trim()
  const characters = [...text]
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : text
}

/** A USB identifier as four hexadecimal digits: from a number (HID, USB) or from a decimal string (the serial ports of Electron); '' when it is neither. */
export function hex4(value: unknown): string {
  const number = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isInteger(number) && number >= 0 && number <= 0xffff ? number.toString(16).padStart(4, '0') : ''
}

// ---------- what a device is ----------

/** What identifies a device for the grants and the picker, read from the object Electron hands over (all of it is checked: nothing is trusted to be there). */
export interface DeviceFacts {
  kind: HardwareKind
  /** Four hexadecimal digits; '' for a serial port that has none (a Bluetooth port). */
  vendorId: string
  productId: string
  serial: string
  /** What the device calls itself, cleaned. */
  name: string
  /** What tells two devices of the same make apart: the top-level usages of a HID device, the port of a serial one. */
  shape: string
}

const SHAPE_ENTRIES_MAX = 8

/** The top-level usages of a HID device ("1:6,ff60:61"), sorted: the interface a device stands for. */
function hidShape(collections: unknown): string {
  if (!Array.isArray(collections)) return ''
  const usages = new Set<string>()
  for (const collection of collections.slice(0, SHAPE_ENTRIES_MAX)) {
    if (!isRecord(collection)) continue
    const { usagePage, usage } = collection
    if (Number.isInteger(usagePage) && Number.isInteger(usage)) usages.add(`${(usagePage as number).toString(16)}:${(usage as number).toString(16)}`)
  }
  return [...usages].sort().join(',')
}

const NAME_MAX = 60
const SERIAL_MAX = 64
const PORT_MAX = 100

/** The facts of a device, or null when it cannot be told apart from another (a HID or USB device without both identifiers, a port without a name). */
export function deviceFacts(kind: HardwareKind, raw: unknown): DeviceFacts | null {
  if (!isRecord(raw)) return null
  if (kind === 'serial') {
    const port = cleanLabel(raw['portName'], PORT_MAX)
    if (port === '') return null
    return {
      kind,
      vendorId: hex4(raw['vendorId']),
      productId: hex4(raw['productId']),
      serial: cleanLabel(raw['serialNumber'], SERIAL_MAX),
      name: cleanLabel(raw['displayName'], NAME_MAX) || port,
      shape: port
    }
  }
  const vendorId = hex4(raw['vendorId'])
  const productId = hex4(raw['productId'])
  if (vendorId === '' || productId === '') return null
  return {
    kind,
    vendorId,
    productId,
    serial: cleanLabel(raw['serialNumber'], SERIAL_MAX),
    name: cleanLabel(kind === 'hid' ? raw['name'] : (raw['productName'] ?? raw['manufacturerName']), NAME_MAX),
    shape: kind === 'hid' ? hidShape(raw['collections']) : ''
  }
}

/** The key two grants share when they are for the same device. */
export const deviceKey = (facts: DeviceFacts): string => [facts.kind, facts.vendorId, facts.productId, facts.serial, facts.shape].join('|')

// ---------- the devices that are never offered ----------

/** The usage page the FIDO Alliance gave to security keys (CTAP over HID). */
export const FIDO_USAGE_PAGE = 0xf1d0
/** Generic Desktop page: pointer, mouse, keyboard and keypad are what a page could use to read what is typed or moved. */
const GENERIC_DESKTOP_PAGE = 0x01
const INPUT_USAGES: ReadonlyMap<number, 'mouse' | 'keyboard'> = new Map([
  [0x01, 'mouse'],
  [0x02, 'mouse'],
  [0x06, 'keyboard'],
  [0x07, 'keyboard']
])

// Makers whose devices are security keys: the usage page above is the rule, this list is a second net for keys that hide behind a vendor-specific interface.
const SECURITY_KEY_VENDORS: ReadonlySet<string> = new Set(['1050' /* Yubico */, '096e' /* Feitian */])

// USB interface classes Chromium's own WebUSB does not let a page claim, plus smart cards and content security, which are where a token keeps its secrets.
const USB_PROTECTED_CLASSES: ReadonlySet<number> = new Set([0x01, 0x03, 0x08, 0x0b, 0x0d, 0x0e, 0x10, 0xe0])
const USB_TOKEN_CLASSES: ReadonlySet<number> = new Set([0x0b, 0x0d])

export type SensitiveReason = 'fido' | 'keyboard' | 'mouse' | 'security-key' | 'smart-card' | 'protected-class' | 'unknown'

/** Why a device is never offered, in words for the log (the picker says it in a sentence of the catalogue, `pickerMenu`). */
export const SENSITIVE_WORDS: Record<SensitiveReason, string> = {
  fido: 'FIDO security key',
  keyboard: 'keyboard',
  mouse: 'mouse',
  'security-key': 'security key',
  'smart-card': 'smart card',
  'protected-class': 'protected class',
  unknown: 'unidentifiable device'
}

const COLLECTION_NODES_MAX = 256
const COLLECTION_DEPTH_MAX = 8

/**
 * Whether a usage page appears in the tree of collections of a HID device: 'yes', 'no', or 'unreadable' when the tree is deeper or larger than
 * any real device's (it comes from a device, so it is bounded, and a tree that is not read to the end is not trusted to hold no key).
 */
function findUsagePage(collections: unknown, page: number): 'yes' | 'no' | 'unreadable' {
  let seen = 0
  const walk = (list: unknown, depth: number): 'yes' | 'no' | 'unreadable' => {
    if (!Array.isArray(list)) return 'no'
    if (depth > COLLECTION_DEPTH_MAX) return list.length > 0 ? 'unreadable' : 'no'
    for (const collection of list) {
      if (++seen > COLLECTION_NODES_MAX) return 'unreadable'
      if (!isRecord(collection)) continue
      if (collection['usagePage'] === page) return 'yes'
      const inner = walk(collection['children'], depth + 1)
      if (inner !== 'no') return inner
    }
    return 'no'
  }
  return walk(collections, 0)
}

/** Every interface class a USB device declares, in any configuration and alternate, and its own class. */
function usbClasses(raw: Record<string, unknown>): { device: number | null; interfaces: number[] } {
  const interfaces: number[] = []
  const take = (alternate: unknown) => {
    if (isRecord(alternate) && Number.isInteger(alternate['interfaceClass'])) interfaces.push(alternate['interfaceClass'] as number)
  }
  const configurations: unknown[] = Array.isArray(raw['configurations']) ? raw['configurations'].slice(0, 16) : []
  if (isRecord(raw['configuration'])) configurations.push(raw['configuration'])
  for (const configuration of configurations) {
    if (!isRecord(configuration) || !Array.isArray(configuration['interfaces'])) continue
    for (const entry of configuration['interfaces'].slice(0, 64)) {
      if (!isRecord(entry)) continue
      for (const alternate of Array.isArray(entry['alternates']) ? entry['alternates'].slice(0, 16) : []) take(alternate)
    }
  }
  return { device: Number.isInteger(raw['deviceClass']) ? (raw['deviceClass'] as number) : null, interfaces }
}

/**
 * Why a device must not be offered to a page, or null when it may. A security key (FIDO usage page, smart card or content-security
 * interface, a maker of keys) holds a credential that a page could use or probe; a keyboard or a mouse lets a page read what is typed
 * or moved in every other application. Chromium refuses some of these itself (not assumed to hold in Electron's picker): this is Lucium's own lock, and it is applied to what the
 * permission handler is asked as well as to what the picker lists, so that nothing excluded is granted even if it were listed.
 */
export function sensitiveReason(kind: HardwareKind, raw: unknown): SensitiveReason | null {
  if (!isRecord(raw)) return 'unknown'
  if (SECURITY_KEY_VENDORS.has(hex4(raw['vendorId']))) return 'security-key'
  if (kind === 'hid') {
    const collections = raw['collections']
    if (!Array.isArray(collections) || collections.length === 0) return 'unknown'
    const fido = findUsagePage(collections, FIDO_USAGE_PAGE)
    if (fido === 'yes') return 'fido'
    if (fido === 'unreadable') return 'unknown'
    for (const collection of collections) {
      if (!isRecord(collection) || collection['usagePage'] !== GENERIC_DESKTOP_PAGE) continue
      const input = INPUT_USAGES.get(collection['usage'] as number)
      if (input) return input
    }
    return null
  }
  if (kind === 'usb') {
    const { device, interfaces } = usbClasses(raw)
    // Class 0 (and 0xEF, "miscellaneous") says the interfaces tell what the device is: without them nothing is known.
    if (interfaces.length === 0 && (device === null || device === 0 || device === 0xef)) return 'unknown'
    if (interfaces.some((c) => USB_TOKEN_CLASSES.has(c)) || (device !== null && USB_TOKEN_CLASSES.has(device))) return 'smart-card'
    if (device !== null && USB_PROTECTED_CLASSES.has(device)) return 'protected-class'
    if (interfaces.length > 0 && interfaces.every((c) => USB_PROTECTED_CLASSES.has(c))) return 'protected-class'
  }
  return null
}

// ---------- the picker ----------

export interface PickerChoice {
  /** The identifier Electron gave the device (`deviceId`, `portId`): what the answer carries back. Never printed. */
  id: string
  label: string
  facts: DeviceFacts
}

/** A menu is not a list one scrolls. */
export const PICKER_CHOICES_MAX = 30
const PICKER_SCAN_MAX = 256
const PICKER_ID_MAX = 256
const LABEL_MAX = 90

const DEFAULT_NAMES: Record<HardwareKind, string> = { get hid() { return t('web-hardware.appareil-hid') }, get usb() { return t('web-hardware.appareil-usb') }, get serial() { return t('web-hardware.port-serie') } }

function choiceLabel(facts: DeviceFacts): string {
  const ids = facts.vendorId !== '' && facts.productId !== '' ? ` (${facts.vendorId}:${facts.productId})` : ''
  // Two identical devices must not read alike: the end of the serial number tells them apart without printing all of it.
  const tail = facts.serial !== '' ? ` · ${t('web-hardware.n-serial', { serial: facts.serial.slice(-4) })}` : ''
  return cleanLabel(`${facts.name || DEFAULT_NAMES[facts.kind]}${ids}${tail}`, LABEL_MAX)
}

/**
 * What the picker lists for the devices Electron found: the ones that may be offered, with a line each, and how many were left out for
 * being sensitive (the picker says so, so that a missing security key is explained rather than mysterious).
 */
export function pickerChoices(kind: HardwareKind, devices: unknown): { choices: PickerChoice[]; hidden: number } {
  const choices: PickerChoice[] = []
  let hidden = 0
  for (const raw of Array.isArray(devices) ? devices.slice(0, PICKER_SCAN_MAX) : []) {
    if (!isRecord(raw)) continue
    const id = kind === 'serial' ? raw['portId'] : raw['deviceId']
    if (typeof id !== 'string' || id === '' || id.length > PICKER_ID_MAX) continue
    if (sensitiveReason(kind, raw)) {
      hidden++
      continue
    }
    const facts = deviceFacts(kind, raw)
    if (!facts || choices.length >= PICKER_CHOICES_MAX) continue
    choices.push({ id, label: choiceLabel(facts), facts })
  }
  return { choices, hidden }
}

/** A line of the picker's menu. The first two are text for the user and never a device: a pointer that lands on the menu where it opened selects nothing. */
export interface PickerMenuItem {
  label?: string
  separator?: true
  enabled: boolean
  /** The device this line stands for (`PickerChoice.id`); absent on text and on "Annuler". */
  choice?: string
}

/** The first line of the picker: one sentence per kind, so that each language words the device its own way. */
function askLine(kind: HardwareKind, site: string): string {
  if (kind === 'hid') return t('web-hardware.site-veut-se-connecter-a-un-appareil-hid', { site })
  if (kind === 'usb') return t('web-hardware.site-veut-se-connecter-a-un-appareil-usb', { site })
  return t('web-hardware.site-veut-se-connecter-a-un-port-serie', { site })
}

/** The menu that names the site and lists the devices. */
export function pickerMenu(request: { origin: string; kind: HardwareKind; choices: readonly PickerChoice[]; hidden: number }): PickerMenuItem[] {
  const items: PickerMenuItem[] = [
    { label: askLine(request.kind, originLabel(request.origin)), enabled: false },
    { label: request.choices.length > 0 ? t('web-hardware.choisissez-l-appareil-a-lui-confier') : t('web-hardware.aucun-appareil-compatible-n-est-branche'), enabled: false },
    { separator: true, enabled: false },
    ...request.choices.map((choice): PickerMenuItem => ({ label: choice.label, enabled: true, choice: choice.id }))
  ]
  if (request.hidden > 0) {
    items.push({ separator: true, enabled: false }, { label: tp('web-hardware.count-appareils-proteges-jamais-proposes', request.hidden), enabled: false })
  }
  items.push({ separator: true, enabled: false }, { label: t('confirm-box.annuler'), enabled: true })
  return items
}

// ---------- the register of what was granted ----------

export interface Grant {
  /** Opaque, "hw-<n>": what the settings name to take a grant back. */
  id: string
  /** The profile whose session was asked. */
  session: string
  /** The secure origin the grant is for. */
  origin: string
  facts: DeviceFacts
  /** The tabs that hold it: it ends with the last of them. */
  tabs: Set<string>
  at: number
}

/** The most grants kept at once. The oldest goes first. */
export const GRANTS_MAX = 64

/**
 * The devices pages were let use. This is the only memory the permission handler reads, so taking a grant out here takes the access away at
 * the next check, which Electron's own memory of grants could not do. A grant is for one origin, one device and the tabs that showed it:
 * when the last of them closes or leaves the origin, the grant ends. Nothing is written to disk.
 */
export class DeviceGrants {
  private readonly grants = new Map<string, Grant>()
  private counter = 0

  constructor(
    private readonly max: number = GRANTS_MAX,
    private readonly now: () => number = Date.now
  ) {}

  /** Records that `tab`, shown at `origin`, was given the device. The same device for the same origin is one grant, held by more tabs. */
  grant(input: { session: string; tab: string; origin: string; facts: DeviceFacts }): Grant | null {
    const origin = secureHardwareOrigin(input.origin)
    if (origin === null || input.session === '' || input.tab === '') return null
    const key = deviceKey(input.facts)
    const existing = [...this.grants.values()].find((g) => g.session === input.session && g.origin === origin && deviceKey(g.facts) === key)
    if (existing) {
      existing.tabs.add(input.tab)
      return existing
    }
    const grant: Grant = { id: `hw-${++this.counter}`, session: input.session, origin, facts: input.facts, tabs: new Set([input.tab]), at: this.now() }
    this.grants.set(grant.id, grant)
    while (this.grants.size > this.max) this.grants.delete(this.grants.keys().next().value as string)
    return grant
  }

  /** Whether a grant covers this device for this origin in this profile. */
  allows(session: string, origin: unknown, facts: DeviceFacts): boolean {
    const wanted = secureHardwareOrigin(origin)
    if (wanted === null) return false
    const key = deviceKey(facts)
    for (const grant of this.grants.values()) if (grant.session === session && grant.origin === wanted && deviceKey(grant.facts) === key) return true
    return false
  }

  list(): Grant[] {
    return [...this.grants.values()]
  }

  get size(): number {
    return this.grants.size
  }

  /** Takes one grant back. */
  revoke(id: string): boolean {
    return this.grants.delete(id)
  }

  /** Takes every grant back; the number of grants that were there. */
  revokeAll(): number {
    const count = this.grants.size
    this.grants.clear()
    return count
  }

  /** The tab is gone: the grants only it held end. Returns how many. */
  releaseTab(tab: string): number {
    return this.dropTab(tab, () => true)
  }

  /** The tab now shows `origin`: the grants it held for any other origin end with it (it no longer shows the site that was given the device). */
  keepTabAt(tab: string, origin: unknown): number {
    const here = secureHardwareOrigin(origin)
    return this.dropTab(tab, (grant) => grant.origin !== here)
  }

  /** The tabs that hold at least one grant. */
  tabs(): Set<string> {
    const tabs = new Set<string>()
    for (const grant of this.grants.values()) for (const tab of grant.tabs) tabs.add(tab)
    return tabs
  }

  private dropTab(tab: string, applies: (grant: Grant) => boolean): number {
    let ended = 0
    for (const [id, grant] of [...this.grants]) {
      if (!grant.tabs.has(tab) || !applies(grant)) continue
      grant.tabs.delete(tab)
      if (grant.tabs.size === 0) {
        this.grants.delete(id)
        ended++
      }
    }
    return ended
  }
}

// ---------- the list in the settings ----------

export interface HardwareGrantRow {
  id: string
  origin: string
  /** The site as the list prints it. */
  site: string
  kind: HardwareKind
  kindName: string
  /** The device's line: its name, its identifiers. */
  device: string
}

export function grantRows(grants: readonly Grant[]): HardwareGrantRow[] {
  return grants.map((grant) => ({ id: grant.id, origin: grant.origin, site: originLabel(grant.origin), kind: grant.facts.kind, kindName: KIND_NAMES[grant.facts.kind], device: choiceLabel(grant.facts) }))
}

/** What the interface may ask: the list, one grant taken back, every grant taken back. */
export type HardwareRequest = { kind: 'list' } | { kind: 'revoke'; id: string } | { kind: 'revoke-all' }

export interface HardwareReply {
  ok: boolean
  /** A sentence for the user ('' when there is nothing to say). */
  message: string
  grants: HardwareGrantRow[]
}

const GRANT_ID = /^hw-\d{1,9}$/

/** The request as the interface sent it, or null when it is not exactly one of the three. */
export function parseHardwareRequest(raw: unknown): HardwareRequest | null {
  if (!isRecord(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null
  const keys = Object.keys(raw).sort().join()
  if (raw['kind'] === 'list' && keys === 'kind') return { kind: 'list' }
  if (raw['kind'] === 'revoke-all' && keys === 'kind') return { kind: 'revoke-all' }
  if (raw['kind'] === 'revoke' && keys === 'id,kind' && typeof raw['id'] === 'string' && GRANT_ID.test(raw['id'])) return { kind: 'revoke', id: raw['id'] }
  return null
}

/** Said when a grant is taken back or the switch goes off while a page may hold a connection: Electron cannot close it from outside. */
export const openConnectionNotice = (): string => t('web-hardware.une-connexion-deja-ouverte-a-l-appareil-reste')
