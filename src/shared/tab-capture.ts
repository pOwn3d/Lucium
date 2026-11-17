// The sound of a tab, for an extension (`chrome.tabCapture.getMediaStreamId`, then `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', … } } })` in a page of the
// extension), as pure rules. The engine applies them (main/engine/tab-capture.ts). Only the sound of a tab is ever given, never its picture.
//
// An identifier handed out by `getMediaStreamId` is a claim: single use, valid for a few seconds, tied to the extension, the profile, the tab and the page that
// takes it. A page claims it just before it asks for the stream, and the stream is made for that page only; a made-up, stale, used or foreign identifier is
// refused. At most two tabs are captured at once, and one tab by one extension at a time.

import { accessOf } from './extension-access'
import { cleanText } from './extension-review'
import { t } from './i18n'
import { settingsPath } from './settings-path'
import type { ProfileOverrides } from './profiles'
import { isRecord } from './record'

/** How long an identifier can be claimed and used, from the moment `getMediaStreamId` made it. */
export const CLAIM_TTL_MS = 30_000
/** How long a page has, once it took an identifier, for the capture to begin (the helper page asks for the stream and sends its first chunk of sound): the clock of the identifier no longer runs. */
export const BOUND_TTL_MS = 20_000
/** Tabs captured at the same time, all extensions together. */
export const CAPTURES_MAX = 2
/** Identifiers made and not yet used, by extension: past it the oldest go (a worker that asks in a loop holds nothing for ever). */
export const PENDING_MAX = 8

/** The words of the errors an extension reads: the extension platform's where it has some, ours (marked "Lucium:") where it has none. */
export const TAB_CAPTURE_ERRORS = {
  notInvoked: 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.',
  busy: 'Cannot capture a tab with an active stream.',
  tooMany: `Lucium: at most ${CAPTURES_MAX} tabs can be captured at the same time.`,
  switchedOff: "Lucium: the capture of a tab's sound is switched off for this extension (Extensions › Details)",
  // The place is named as the interface shows it, in its language (the same way the data APIs say where they are switched on).
  get featureOff(): string {
    return `Lucium: the capture of a tab's sound is switched off in Lucium (${settingsPath('extensionTabCapture')}).`
  },
  noPermission: 'The extension has no permission to use chrome.tabCapture.',
  notWorkerOrPage: 'chrome.tabCapture is only available to an extension installed in a profile.',
  badIdentifier: 'Lucium: the identifier of this tab capture is not valid, has expired or was already used.',
  noTab: 'Lucium: no tab is shown in the profile of this extension, so none can be captured: name one with targetTabId.',
  gone: 'Lucium: the tab to capture is gone.',
  noHelper: 'Lucium: the page that carries the sound of the tab could not be made.',
  linkFailed: 'Lucium: the sound of the tab could not be carried to the page.',
  soundOnly: 'Lucium: only the sound of a tab can be captured, not its picture.'
} as const

/** The identifiers Lucium makes: a random UUID, nothing about the tab or the extension. */
const CLAIM_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

/** Whether a value has the shape of an identifier Lucium made (the page checks it before it asks for a stream; the main process decides if it is one). */
export const isClaimId = (value: unknown): value is string => typeof value === 'string' && CLAIM_ID.test(value)

/**
 * What a manifest lets an extension do, as one key: its permissions, its optional ones, the sites it asks for and its optional sites, each list in a fixed order. Two manifests
 * with the same key ask for the same things (a version, a name, a script that changed do not count); null for what is not a manifest. What the person allowed an extension
 * to capture is allowed to what it asked for: when an extension comes back asking for other things, it is not the one that was allowed.
 */
export function permissionsKey(manifest: unknown): string | null {
  if (!isRecord(manifest)) return null
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').sort() : [])
  return JSON.stringify([list(manifest['permissions']), list(manifest['optional_permissions']), list(manifest['host_permissions']), list(manifest['optional_host_permissions'])])
}

/** Whether the manifest of an extension declares `tabCapture` (the permissions the person was shown and granted, the optional ones they accepted included). */
export const declaresTabCapture = (manifest: unknown): boolean => accessOf(manifest).permissions.has('tabCapture')

export type OptionsCheck = { ok: true; targetTabId: number | undefined } | { ok: false; message: string }

/**
 * What `getMediaStreamId` was called with: nothing, or `{ targetTabId?, consumerTabId? }`. `consumerTabId` says which page will use the stream; here the
 * identifier is claimed by the page that uses it, so it is accepted and left unread. A tab id that is not a whole number is refused in the platform's words.
 */
export function readCaptureOptions(raw: unknown): OptionsCheck {
  if (raw === undefined || raw === null) return { ok: true, targetTabId: undefined }
  if (!isRecord(raw)) return { ok: false, message: "Error in invocation of tabCapture.getMediaStreamId(optional object options, optional function callback): Error at parameter 'options': Invalid type: expected object, found " + typeof raw + '.' }
  const target = raw['targetTabId']
  if (target === undefined || target === null) return { ok: true, targetTabId: undefined }
  if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) return { ok: false, message: "Error in invocation of tabCapture.getMediaStreamId(optional object options, optional function callback): Error at property 'targetTabId': Invalid type: expected integer." }
  return { ok: true, targetTabId: target }
}

/** What the engine knows of the tab an extension wants to capture. */
export interface CaptureTarget {
  /** The tab is one of the profile of the extension (a tab of another profile, a private tab or a page that is not a tab does not exist for it). */
  inProfile: boolean
  /** The address of the page now. */
  url: string
  /** The space of the tab is locked, or the application is. */
  locked: boolean
  /** The person handed this tab to the extension (a click on its icon, its shortcut) and the tab is still on the origin it was handed on. */
  lent: boolean
}

/** A web page: not a page of the application, of an extension, of the browser, a local file or an empty page. */
const isWebPage = (url: string): boolean => URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)

/**
 * Why the tab may not be captured by this extension, in the words of the extension platform; null when it may. A page that is not an ordinary web page, a
 * locked one and one that was not handed over all get the platform's sentence about the invocation: nothing says which of them it is.
 */
export function targetRefusal(tabId: number, target: CaptureTarget | undefined): string | null {
  if (!target || !target.inProfile) return `No tab with id: ${tabId}.`
  if (!isWebPage(target.url) || target.locked || !target.lent) return TAB_CAPTURE_ERRORS.notInvoked
  return null
}

// ---- what the person reads and switches ----

/** The extension's name where the person reads it (a sentence, the mark of a tab): a name is any text its author wrote, so it is cleaned and cut. */
export const nameShown = (name: string): string => cleanText(name, 80) || '?'

/** The notice when an extension asks to capture the sound of a tab while the person has not allowed it; its button opens the details of the extension. */
export const refusedNotice = (name: string): string => t('tab-capture.name-a-voulu-capter-le-son-d-un-onglet-c-est-desactive', { name: nameShown(name) })
export const openDetailsLabel = (): string => t('tab-capture.ouvrir-les-details')

/** The line under the switch of an extension's details when the whole function is off in the settings: the switch is there, and does nothing until it is on. Null while it is on. */
export const captureOffLine = (featureOn: boolean): string | null => (featureOn ? null : t('extpage.la-capture-du-son-est-coupee-name', { settingsPath: settingsPath('extensionTabCapture') }))

/** The notice when a capture begins: who listens, to which tab (its title is any text a site wrote, cleaned and cut), and below it the way to stop. */
export function startedNotice(name: string, tabTitle: string): string {
  const title = cleanText(tabTitle, 60)
  return title === '' ? t('tab-capture.name-capte-maintenant-le-son-d-un-onglet', { name: nameShown(name) }) : t('tab-capture.name-capte-maintenant-le-son-de-l-onglet-title', { name: nameShown(name), title })
}
export const stopLabel = (): string => t('tab-capture.arreter-la-capture-du-son')

/**
 * The line of the details of an extension that switches the capture on or off in a profile: there only when the manifest asks for `tabCapture` (the
 * permission the person was shown), and on only when the person allowed it in that profile.
 */
export function captureSwitch(facts: { permissions: ReadonlyArray<{ id: string }> } | null | undefined, profiles: ProfileOverrides, profileId: string, extensionId: string): { shown: boolean; on: boolean } {
  return { shown: facts?.permissions.some((permission) => permission.id === 'tabCapture') === true, on: profiles[profileId]?.tabCaptureExtensions?.includes(extensionId) === true }
}

// ---- the claims ----

/** A page of an extension: the process and the frame of the document, which end with the document, and the web contents that holds it. */
export interface FrameRef {
  processId: number
  routingId: number
}

export interface CaptureCaller {
  extensionId: string
  profileId: string
}

export type ClaimState = 'issued' | 'bound' | 'active'

export interface Claim extends CaptureCaller {
  readonly id: string
  readonly targetTab: number
  /** Who asked for the identifier (the worker or the page, as a line of the log). */
  readonly issuer: string
  readonly expiresAt: number
  readonly state: ClaimState
  /** The page the claim is tied to, once it claimed it. */
  readonly frame?: FrameRef
  readonly contentsId?: number
  /** The web contents of the helper page that asks for the stream of this claim (main/engine/tab-capture-helper.ts): the only page that may be given it. */
  readonly helperId?: number
  /** Whether the tab was silent for the person before the capture: what the sound goes back to afterwards. */
  readonly wasMuted?: boolean
}

export type IssueResult = { ok: true; id: string } | { ok: false; error: string }
export type BindRefusal = 'unknown' | 'expired' | 'foreign' | 'used' | 'frame-busy' | 'busy' | 'too-many'
export type BindResult = { ok: true; claim: Claim } | { ok: false; reason: BindRefusal }
export type StartRefusal = 'no-claim'
export type StartResult = { ok: true; claim: Claim } | { ok: false; reason: StartRefusal }

/** Which claims an event reaches: every field given must match. */
export interface ClaimFilter {
  targetTab?: number
  contentsId?: number
  extensionId?: string
  profileId?: string
  frame?: FrameRef
  helperId?: number
}

type Held = { -readonly [K in keyof Claim]: Claim[K] }

const sameFrame = (a: FrameRef | undefined, b: FrameRef): boolean => a !== undefined && a.processId === b.processId && a.routingId === b.routingId

export class TabCaptureRegistry {
  private readonly claims = new Map<string, Held>()

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {}

  /** A claim for the tab; refused where the tab or the application already holds the most captures it may. */
  issue(input: CaptureCaller & { targetTab: number; issuer: string }): IssueResult {
    this.sweep()
    const active = this.actives()
    if (active.some((claim) => claim.targetTab === input.targetTab)) return { ok: false, error: TAB_CAPTURE_ERRORS.busy }
    if (active.length >= CAPTURES_MAX) return { ok: false, error: TAB_CAPTURE_ERRORS.tooMany }
    // The oldest of this extension's identifiers that nobody took go when it asks for more than it can hold. One a page took is never among them: a capture is about to begin
    // for it, and a helper page waits for it.
    const pending = [...this.claims.values()].filter((claim) => claim.state === 'issued' && claim.extensionId === input.extensionId && claim.profileId === input.profileId)
    for (const stale of pending.slice(0, Math.max(0, pending.length - PENDING_MAX + 1))) this.claims.delete(stale.id)
    const id = this.newId()
    this.claims.set(id, { id, extensionId: input.extensionId, profileId: input.profileId, targetTab: input.targetTab, issuer: input.issuer, expiresAt: this.clock() + CLAIM_TTL_MS, state: 'issued' })
    return { ok: true, id }
  }

  /**
   * The page takes an identifier when it asks to listen. Only the extension (in the profile) it was made for, once, and while it is valid; the claim is tied to
   * that page from then on, and a page holds one claim that has not begun at a time. A claim a page took holds a hidden helper page from now on: the caps (the same tab, and
   * the number of captures) count it, as they count one that runs, so that no window is made for a capture that would be refused when it begins. The identifier that is refused
   * here is not used up: it may be taken again, while it is valid, once a capture ended.
   */
  bind(id: string, caller: CaptureCaller & { frame: FrameRef; contentsId: number }): BindResult {
    const held = this.claims.get(id)
    if (!held) return { ok: false, reason: 'unknown' }
    // Said apart from an identifier nobody made: the log of an extension that waited too long reads differently from the one of a page that invents them.
    if (held.state !== 'active' && held.expiresAt <= this.clock()) {
      this.claims.delete(held.id)
      return { ok: false, reason: 'expired' }
    }
    if (held.extensionId !== caller.extensionId || held.profileId !== caller.profileId) return { ok: false, reason: 'foreign' }
    if (held.state !== 'issued') return { ok: false, reason: 'used' }
    this.sweep()
    if ([...this.claims.values()].some((claim) => claim.state === 'bound' && sameFrame(claim.frame, caller.frame))) return { ok: false, reason: 'frame-busy' }
    const holding = [...this.claims.values()].filter((claim) => claim.state === 'bound' || claim.state === 'active')
    if (holding.some((claim) => claim.targetTab === held.targetTab)) return { ok: false, reason: 'busy' }
    if (holding.length >= CAPTURES_MAX) return { ok: false, reason: 'too-many' }
    held.state = 'bound'
    held.frame = { processId: caller.frame.processId, routingId: caller.frame.routingId }
    held.contentsId = caller.contentsId
    // The page has the time the capture takes to begin, not what was left of the identifier's.
    held.expiresAt = this.clock() + BOUND_TTL_MS
    return { ok: true, claim: { ...held } }
  }

  /** The claim of this identifier ties itself to its helper page: the page that asks for the stream, and the only one that is given it. Once, for a claim a page took. */
  attachHelper(id: string, helperId: number): boolean {
    this.sweep()
    const held = this.claims.get(id)
    if (!held || held.state !== 'bound' || held.helperId !== undefined) return false
    held.helperId = helperId
    return true
  }

  /** The claim a helper page is for (in any state), or undefined for a page that is none. */
  byHelper(helperId: number): Claim | undefined {
    this.sweep()
    const held = [...this.claims.values()].find((claim) => claim.helperId === helperId)
    return held ? { ...held } : undefined
  }

  /**
   * The helper page gets its stream: the claim becomes the capture of its tab, and is used up. The caps are not judged here: `bind` counts a claim a page took with the captures
   * that run, so that the ones that begin are never more than the caps allow, nor two for one tab.
   */
  start(id: string, wasMuted: boolean): StartResult {
    this.sweep()
    const held = this.claims.get(id)
    if (!held || held.state !== 'bound') return { ok: false, reason: 'no-claim' }
    held.state = 'active'
    held.wasMuted = wasMuted
    return { ok: true, claim: { ...held } }
  }

  /** The claim with this identifier, in any state. */
  get(id: string): Claim | undefined {
    const held = this.claims.get(id)
    return held ? { ...held } : undefined
  }

  /** Ends one claim, whatever its state; the claim as it was, or undefined when there was none. */
  end(id: string): Claim | undefined {
    const held = this.claims.get(id)
    this.claims.delete(id)
    return held ? { ...held } : undefined
  }

  /** Ends every claim the filter reaches (a page that goes, a tab that closes, an extension that is switched off); the claims as they were. */
  endWhere(filter: ClaimFilter): Claim[] {
    const reached = [...this.claims.values()].filter(
      (claim) =>
        (filter.targetTab === undefined || claim.targetTab === filter.targetTab) &&
        (filter.contentsId === undefined || claim.contentsId === filter.contentsId) &&
        (filter.extensionId === undefined || claim.extensionId === filter.extensionId) &&
        (filter.profileId === undefined || claim.profileId === filter.profileId) &&
        (filter.frame === undefined || sameFrame(claim.frame, filter.frame)) &&
        (filter.helperId === undefined || claim.helperId === filter.helperId)
    )
    for (const claim of reached) this.claims.delete(claim.id)
    return reached.map((claim) => ({ ...claim }))
  }

  /** The captures that are running. */
  actives(): Claim[] {
    return [...this.claims.values()].filter((claim) => claim.state === 'active').map((claim) => ({ ...claim }))
  }

  /** What was made and nobody used, once it is stale, is forgotten (a capture that runs never expires). */
  private sweep(): void {
    const now = this.clock()
    for (const claim of [...this.claims.values()]) if (claim.state !== 'active' && claim.expiresAt <= now) this.claims.delete(claim.id)
  }
}

/**
 * Whether a notice about an extension may be shown now: one per extension and profile in a while, so that an extension that asks in a loop does not fill the
 * window with the same sentence. The table is bounded.
 */
export class NoticeThrottle {
  private readonly last = new Map<string, number>()

  constructor(
    private readonly everyMs: number,
    private readonly clock: () => number = Date.now,
    private readonly max = 64
  ) {}

  allow(key: string): boolean {
    const now = this.clock()
    const before = this.last.get(key)
    if (before !== undefined && now - before < this.everyMs) return false
    this.last.delete(key)
    this.last.set(key, now)
    while (this.last.size > this.max) {
      const oldest = this.last.keys().next()
      if (oldest.done) break
      this.last.delete(oldest.value)
    }
    return true
  }
}
