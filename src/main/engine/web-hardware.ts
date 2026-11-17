// The web's hardware APIs (WebHID, WebUSB, Web Serial) for the profiles' sessions. Off, this owns nothing: no listener on any session, no handler,
// no grant, and every request is refused (the permission check says no, as it always did). On, three things are installed on each profile's session:
//   - the pickers (`select-hid-device`, `select-usb-device`, `select-serial-port`): Electron lets the browser choose the device, so the choice is
//     the user's, in a menu that names the site, and only for the main frame of a tab on a secure origin;
//   - the device permission handler: it answers from `DeviceGrants` and from nothing else, so a grant that was taken back is refused at once
//     (Electron keeps its own memory of what was picked and has no call to forget it; with a handler set it is not consulted). Switched off after a
//     device was picked, the profile keeps a handler that refuses everything: without one, Electron's memory would answer again.
//   - a watch on the tab that was given a device: the grant ends when the tab closes or leaves the origin.
// A private context never gets any of it (a serial number is a stable identifier that would tie a private visit to a normal one).
// Everything that touches Electron is handed in, so the order of the checks is tested without a device.

import { DeviceGrants, grantRows, isHardwareKind, deviceFacts, originLabel, pickerChoices, secureHardwareOrigin, sensitiveReason, SENSITIVE_WORDS, type HardwareGrantRow, type HardwareKind, type PickerChoice } from '@shared/web-hardware'

/** The part of a frame the rules read. */
export interface HardwareFrame {
  readonly parent: unknown
  readonly origin: string
}

/** The part of a tab's web contents the service reads and listens to. */
export interface HardwareContents {
  readonly id: number
  readonly mainFrame: HardwareFrame
  isDestroyed(): boolean
  getURL(): string
  on(event: 'did-navigate' | 'destroyed', listener: (...args: any[]) => void): unknown
  off(event: 'did-navigate' | 'destroyed', listener: (...args: any[]) => void): unknown
}

type SelectEvent = 'select-hid-device' | 'select-usb-device' | 'select-serial-port'

/** The part of a session the service uses. */
export interface HardwareSession {
  on(event: SelectEvent, listener: (...args: any[]) => void): unknown
  off(event: SelectEvent, listener: (...args: any[]) => void): unknown
  setDevicePermissionHandler(handler: ((details: { deviceType: string; origin: string; device: unknown }) => boolean) | null): void
}

export interface HardwareChoice {
  contents: HardwareContents
  /** The secure origin of the main frame that asked. */
  origin: string
  kind: HardwareKind
  choices: PickerChoice[]
  /** How many devices were left out as sensitive. */
  hidden: number
}

export interface WebHardwareDeps {
  /** The tab's contents a frame belongs to (undefined: none, or gone). */
  contentsOf(frame: HardwareFrame): HardwareContents | undefined
  /** Whether the contents is a tab of a normal window (not a popup, a sign-in flow, a panel of ours): the only asker. */
  isTab(contents: HardwareContents): boolean
  /** Whether the user clicked or pressed a key in this tab just now: a page cannot ask for a device on its own. */
  userActed(contents: HardwareContents): boolean
  /** Shows the list to the user; resolves with the id picked, or null when they gave up. */
  choose(request: HardwareChoice): Promise<string | null>
  warn(message: string, detail?: unknown): void
}

/** The check Electron makes before a page may ask (`setPermissionCheckHandler`): what the engine passes on from it. */
export interface HardwareCheck {
  permission: string
  /** The origin of the frame that asks (`details.securityOrigin`, else the requesting origin). */
  origin: string
  /** Set by Electron for a cross-origin sub-frame only. */
  embeddingOrigin?: string
  /** Electron could say which contents asks (it cannot for WebHID and WebUSB). */
  contentsKnown: boolean
  isMainFrame: boolean
}

interface Installed {
  profileId: string
  session: HardwareSession
  listeners: Array<[SelectEvent, (...args: any[]) => void]>
}

interface Watch {
  contents: HardwareContents
  navigated: (event: unknown, url: unknown) => void
  destroyed: () => void
}

/** What a profile answers to a device check once the service is off after a pick. */
const REFUSE_DEVICES = (): boolean => false

export class WebHardware {
  private on = false
  private readonly grants = new DeviceGrants()
  /** The sessions known (a profile's), with what is installed on them while the service is on. */
  private readonly sessions = new Map<string, { session: HardwareSession; installed: Installed | null }>()
  private readonly watches = new Map<string, Watch>()
  /** One list on screen at a time: a page cannot stack menus. */
  private picking = false
  /** The profiles where a device was picked since the start: Electron remembers the pick in its own memory, which only a handler overrides. */
  private readonly picked = new Set<string>()

  constructor(private readonly deps: WebHardwareDeps) {}

  get enabled(): boolean {
    return this.on
  }

  /** A profile's session exists. Nothing is installed unless the service is on. */
  attach(profileId: string, session: HardwareSession): void {
    const known = this.sessions.get(profileId)
    if (known?.session === session) return
    if (known?.installed) this.uninstall(known)
    const entry = { session, installed: null as Installed | null }
    this.sessions.set(profileId, entry)
    if (this.on) entry.installed = this.install(profileId, session)
  }

  enable(): void {
    if (this.on) return
    this.on = true
    for (const [profileId, entry] of this.sessions) entry.installed ??= this.install(profileId, entry.session)
  }

  /** Switches off: nothing stays installed, every grant is taken back. Returns how many tabs held one (their open connections stay until they reload). */
  disable(): number {
    if (!this.on) return 0
    this.on = false
    const holders = this.grants.tabs().size
    for (const entry of this.sessions.values()) this.uninstall(entry)
    this.grants.revokeAll()
    this.unwatchAll()
    return holders
  }

  // ---------- what the interface shows and does ----------

  list(): HardwareGrantRow[] {
    return grantRows(this.grants.list())
  }

  /** Takes one grant back (`id`), or all of them. Returns how many tabs still hold a connection they may have opened. */
  revoke(id?: string): number {
    const holders = new Set<string>()
    for (const grant of this.grants.list()) if (id === undefined || grant.id === id) for (const tab of grant.tabs) holders.add(tab)
    if (id === undefined) this.grants.revokeAll()
    else this.grants.revoke(id)
    this.sweepWatches()
    return holders.size
  }

  // ---------- the permission check ----------

  /**
   * Whether a page may ask at all, before any list is shown. The check is session-wide and Electron gives it little: for WebHID and WebUSB no
   * contents, so the frame is judged later, in the picker's event; for Web Serial the contents and whether the frame is the main one.
   */
  mayRequest(check: HardwareCheck): boolean {
    if (!this.on || !isHardwareKind(check.permission)) return false
    if (secureHardwareOrigin(check.origin) === null) return false
    if (check.embeddingOrigin !== undefined) return false
    return !check.contentsKnown || check.isMainFrame
  }

  // ---------- the device permission handler ----------

  /** Whether `device` may be used by `origin` in this profile: it was picked by the user for that origin, and is not a device that is never offered. */
  deviceAllowed(profileId: string, details: { deviceType: unknown; origin: unknown; device: unknown }): boolean {
    if (!this.on || !isHardwareKind(details.deviceType)) return false
    if (sensitiveReason(details.deviceType, details.device)) return false
    const facts = deviceFacts(details.deviceType, details.device)
    return facts !== null && this.grants.allows(profileId, details.origin, facts)
  }

  // ---------- installing ----------

  private install(profileId: string, session: HardwareSession): Installed {
    const listeners: Installed['listeners'] = [
      ['select-hid-device', (event: { preventDefault(): void }, details: { deviceList?: unknown; frame?: HardwareFrame | null }, callback: (id?: string | null) => void) => {
        // The answer is ours to give from now on: Electron cancels the request when nobody claims the event.
        event.preventDefault()
        this.offer({ kind: 'hid', profileId, frame: details?.frame ?? null, list: details?.deviceList, answer: (id) => callback(id ?? undefined) })
      }],
      ['select-usb-device', (event: { preventDefault(): void }, details: { deviceList?: unknown; frame?: HardwareFrame | null }, callback: (id?: string) => void) => {
        event.preventDefault()
        this.offer({ kind: 'usb', profileId, frame: details?.frame ?? null, list: details?.deviceList, answer: (id) => callback(id ?? undefined) })
      }],
      ['select-serial-port', (event: { preventDefault(): void }, portList: unknown, contents: HardwareContents | null, callback: (id: string) => void) => {
        event.preventDefault()
        this.offer({ kind: 'serial', profileId, contents: contents ?? undefined, list: portList, answer: (id) => callback(id ?? '') })
      }]
    ]
    for (const [event, listener] of listeners) session.on(event, listener)
    session.setDevicePermissionHandler((details) => {
      try {
        return this.deviceAllowed(profileId, details)
      } catch (error) {
        // Whatever went wrong, the answer is no.
        this.deps.warn(`[web-hardware] the device check failed for ${originForLog(details?.origin)}; refused:`, error)
        return false
      }
    })
    return { profileId, session, listeners }
  }

  private uninstall(entry: { session: HardwareSession; installed: Installed | null }): void {
    const installed = entry.installed
    if (!installed) return
    entry.installed = null
    for (const [event, listener] of installed.listeners) installed.session.off(event, listener)
    // Nothing was ever picked in this profile: nothing of Electron's memory to override, and nothing stays installed.
    installed.session.setDevicePermissionHandler(this.picked.has(installed.profileId) ? REFUSE_DEVICES : null)
  }

  // ---------- the picker ----------

  private offer(request: { kind: HardwareKind; profileId: string; frame?: HardwareFrame | null; contents?: HardwareContents; list: unknown; answer: (id: string | null) => void }): void {
    const { kind } = request
    // The request is answered exactly once on every path below; an answer that cannot be delivered (the page is gone) is told in the log.
    const reply = (id: string | null, origin = 'unknown'): void => {
      try {
        request.answer(id)
      } catch (error) {
        this.deps.warn(`[web-hardware] the answer could not be delivered to ${origin}:`, error)
      }
    }
    const refuse = (reason: string, origin = 'unknown'): void => {
      this.deps.warn(`[web-hardware] ${kind} refused for ${origin}: ${reason}`)
      reply(null, origin)
    }

    let contents: HardwareContents | undefined
    let origin: string
    try {
      if (!this.on) return reply(null)
      if (request.frame) {
        // WebHID and WebUSB name the frame that asks: only the main frame of a tab may. An iframe, even one the page lets use the API, is not asked.
        if (request.frame.parent !== null) return refuse('the request comes from a sub-frame')
        contents = this.deps.contentsOf(request.frame)
      } else {
        contents = request.contents
      }
      if (!contents || contents.isDestroyed()) return refuse('the page is gone')
      const secure = secureHardwareOrigin(contents.mainFrame.origin)
      if (secure === null) return refuse(`the origin is not secure (${originForLog(contents.mainFrame.origin)})`)
      origin = secure
      // Web Serial does not name the frame: the address of the tab's own page is the only site the user can be shown, and it must be the frame's too.
      if (request.frame && secureHardwareOrigin(request.frame.origin) !== origin) return refuse('the frame is not on the tab’s origin', origin)
      if (!this.deps.isTab(contents)) return refuse('the page is not a tab', origin)
      if (!this.deps.userActed(contents)) return refuse('no click or key in the tab explains the request', origin)
    } catch (error) {
      this.deps.warn('[web-hardware] a request could not be read; refused:', error)
      return reply(null)
    }

    if (this.picking) return refuse('a list is already on screen', origin)
    const { choices, hidden } = pickerChoices(kind, request.list)
    if (hidden > 0) this.deps.warn(`[web-hardware] ${hidden} ${kind} device(s) not offered to ${origin} (${[...new Set(describeHidden(kind, request.list))].join(', ')})`)
    this.picking = true
    const tab = contents
    this.deps
      .choose({ contents: tab, origin, kind, choices, hidden })
      .then((id) => {
        // The page may have been closed or have moved on while the list was up; the switch may have been turned off.
        if (!this.on || tab.isDestroyed() || secureHardwareOrigin(tab.getURL()) !== origin) return refuse('the page changed while the list was open', origin)
        const picked = id === null ? undefined : choices.find((choice) => choice.id === id)
        if (!picked) return reply(null, origin)
        const grant = this.grants.grant({ session: request.profileId, tab: String(tab.id), origin, facts: picked.facts })
        if (!grant) return refuse('the choice could not be recorded', origin)
        try {
          this.watch(tab)
        } catch (error) {
          // A grant that ends with nothing to tell it when its tab leaves would last for ever: the device is not given.
          this.grants.revoke(grant.id)
          this.sweepWatches()
          this.deps.warn(`[web-hardware] the tab of ${origin} cannot be watched:`, error)
          return reply(null, origin)
        }
        this.picked.add(request.profileId)
        reply(picked.id, origin)
      })
      .catch((error: unknown) => {
        this.deps.warn(`[web-hardware] the list for ${originLabel(origin)} failed; cancelled:`, error)
        reply(null, origin)
      })
      .finally(() => {
        this.picking = false
      })
  }

  // ---------- a grant lasts as long as its tab stays on the site ----------

  private watch(contents: HardwareContents): void {
    const tab = String(contents.id)
    if (this.watches.has(tab)) return
    const watch: Watch = {
      contents,
      navigated: (_event, url) => {
        if (this.grants.keepTabAt(tab, url) > 0) this.sweepWatches()
      },
      destroyed: () => {
        this.grants.releaseTab(tab)
        this.sweepWatches()
      }
    }
    this.watches.set(tab, watch)
    contents.on('did-navigate', watch.navigated)
    contents.on('destroyed', watch.destroyed)
  }

  /** Stops watching the tabs that hold no grant any more, so that nothing stays attached to a page for a grant that is gone. */
  private sweepWatches(): void {
    const holding = this.grants.tabs()
    for (const [tab, watch] of [...this.watches]) {
      if (holding.has(tab)) continue
      this.watches.delete(tab)
      this.unlisten(watch)
    }
  }

  private unwatchAll(): void {
    for (const watch of this.watches.values()) this.unlisten(watch)
    this.watches.clear()
  }

  private unlisten(watch: Watch): void {
    try {
      watch.contents.off('did-navigate', watch.navigated)
      watch.contents.off('destroyed', watch.destroyed)
    } catch (error) {
      // A destroyed contents may refuse; there is nothing left to listen to on it.
      this.deps.warn('[web-hardware] a watch could not be removed:', error)
    }
  }
}

/** An origin as the log prints it: never an address with a path or a query, which can carry what the user reads. */
function originForLog(value: unknown): string {
  return typeof value === 'string' && URL.canParse(value) ? new URL(value).origin : 'an unknown origin'
}

function describeHidden(kind: HardwareKind, list: unknown): string[] {
  const words: string[] = []
  for (const raw of Array.isArray(list) ? list.slice(0, 256) : []) {
    const reason = sensitiveReason(kind, raw)
    if (reason) words.push(SENSITIVE_WORDS[reason])
  }
  return words
}

