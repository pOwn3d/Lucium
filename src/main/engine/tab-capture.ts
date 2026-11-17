// The sound of a tab, for the extensions of every profile (`chrome.tabCapture.getMediaStreamId`, then the page of the extension asks to listen). What the engine does
// about each step: who may ask (the extension, read from the origin of its frame and never from an argument), which tab (the person handed it over), what the page
// is given (the sound of that tab, never its picture), what the person sees (the tab is silent for them, a mark says who listens) and how it ends (the page, the tab,
// the extension, the person). The stream is never asked for by the page of the extension: Electron stops on a request for media made by an offscreen document. A
// helper page of Lucium's (ordinary, hidden, destroyed with the capture) asks for it, reads the samples of its sound and sends them to the main process, which judges
// each chunk and hands it to the page of the extension that holds the claim, and to no other (shared/tab-capture-pcm.ts: no link is made between the two pages, WebRTC
// does not work in an offscreen document). The page of the extension never holds the right to ask for a screen. The rules are pure (shared/tab-capture.ts,
// shared/tab-capture-pcm.ts); what touches Electron comes in through the host, so that all of this is tested without it.

import { NoticeThrottle, TAB_CAPTURE_ERRORS, TabCaptureRegistry, declaresTabCapture, isClaimId, readCaptureOptions, targetRefusal, type CaptureTarget, type Claim, type FrameRef } from '@shared/tab-capture'
import { PcmGate, readChunk, type PcmChunk } from '@shared/tab-capture-pcm'

/** Who is asking, as the main process read it from the frame or the worker: never from what the call said. */
export interface CaptureSender {
  extensionId: string
  profileId: string
  /** The page or the worker, as a line of the log. */
  context: string
  /** Set for a page of the extension: the document that asked (a worker has none, and claims nothing). */
  frame?: FrameRef & { contentsId: number }
}

/** The helper page of one capture: ordinary, hidden, made for this capture and destroyed with it (main/engine/tab-capture-helper.ts). */
export interface CaptureHelper {
  /** The web contents of the page: the one thing that tells it from every other page. */
  readonly contentsId: number
  /** Has the page ask for the stream and begin to read its samples (a fixed script, no parameter): resolves once the reading has begun, rejects when the page cannot. The chunks come by `pcm`. */
  start(): Promise<void>
  /** Destroys the page, and with it the stream. Safe to call again. */
  close(): void
}

/** What the page of the extension is told the sound is, once the first chunk came. */
export interface ListenFormat {
  sampleRate: number
  channels: number
}

export type TabCaptureEvent =
  /** An extension asked while it is not allowed: the person is told where to switch it on. */
  | { kind: 'refused'; profileId: string; extensionId: string; name: string }
  | { kind: 'started'; tabNumber: number; profileId: string; extensionId: string; name: string }
  /** `muted`: whether the tab is silent for the person now that the capture is over (what it was before it began). */
  | { kind: 'ended'; tabNumber: number; profileId: string; extensionId: string; name: string; muted: boolean }

export interface TabCaptureHost {
  /** The manifest of the extension as it runs in the profile, what the person granted it included; undefined when it does not run there (not installed, switched off). */
  manifestOf(profileId: string, extensionId: string): unknown
  nameOf(profileId: string, extensionId: string): string
  /** The whole function is on (Réglages › Extensions et outils): off, nothing is captured, and nobody is told that an extension asked. */
  featureOn(): boolean
  /** The person let this extension capture the sound of a tab, in this profile. */
  allowed(profileId: string, extensionId: string): boolean
  /** The profile and the address of a tab; undefined for a number that is not a live tab of a profile (a private tab, a panel, a page that is gone). */
  tab(tabNumber: number): { profileId: string; url: string } | undefined
  /** The tab the profile is on, when an extension names none. */
  shownTab(profileId: string): number | undefined
  /** The space of the tab is locked, or the application is. */
  locked(tabNumber: number): boolean
  /** The person handed this tab, at this address, to the extension. */
  lent(extensionId: string, tabNumber: number, url: string): boolean
  /** Takes the tab back from the extension: it has to be invoked again. */
  revoke(extensionId: string, tabNumber: number): void
  /** Whether the tab is silent for the person; undefined when it is gone. */
  muted(tabNumber: number): boolean | undefined
  setMuted(tabNumber: number, muted: boolean): void
  /** The frame a stream of the sound of the tab is made from; null when the tab is gone. */
  targetFrame(tabNumber: number): unknown
  /** Makes the helper page for a capture of this tab, in the session of the profile; null when it cannot be made. */
  openHelper(profileId: string, targetTab: number): CaptureHelper | null
  /** Hands a chunk of the sound (as the helper page sent it, judged) to the page that holds the claim: this frame, and no other. Throws when the frame is gone. */
  deliver(frame: FrameRef, claimId: string, chunk: ArrayBuffer): void
  /** Asks the page to end the stream it holds. */
  tellStop(frame: FrameRef, claimId: string): void
  /** The page did not end its stream when asked: its document is replaced, which ends every stream it holds. */
  forceEnd(contentsId: number): void
  warn(message: string, detail?: unknown): void
}

/** What the page has to end its stream when the person or the browser asks, before its document is replaced. */
export const STOP_GRACE_MS = 2_000
/** One notice about the same extension in this long. */
const NOTICE_EVERY_MS = 30_000
/** How long the helper page has to be made, load its page, ask for the stream and begin to read it. */
export const START_TIMEOUT_MS = 15_000
/** How long the page of the extension waits for the first chunk of sound, once the helper page reads: after it, the capture ends with a message. */
export const FIRST_SOUND_MS = 3_000

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/

/** The extension a frame belongs to, by its address; null for a page of the web, of the application or a frame that is gone. */
export const extensionOfUrl = (url: unknown): string | null => (typeof url === 'string' ? (EXTENSION_URL.exec(url)?.[1] ?? null) : null)

const sameFrame = (a: FrameRef | undefined, b: FrameRef | undefined): boolean => a !== undefined && b !== undefined && a.processId === b.processId && a.routingId === b.routingId

export class TabCaptures {
  private readonly listeners: Array<(event: TabCaptureEvent) => void> = []
  /** The helper pages that exist, by web contents: one for each capture that has begun to begin, and no longer than it. */
  private readonly helpers = new Map<number, CaptureHelper>()
  /** The calls that wait for the sound of a helper page, by its web contents: the page that goes ends the wait at once, whatever it does. */
  private readonly waiting = new Map<number, (error: Error) => void>()
  /** What judges the chunks of each capture that runs, and what waits for its first one. */
  private readonly gates = new Map<string, PcmGate>()
  private readonly firsts = new Map<string, (format: ListenFormat) => void>()
  /** The pages asked to end their stream, by claim: the one that does not is made to (`forceEnd`). */
  private readonly stopping = new Map<string, { frame: FrameRef; contentsId: number; timer: ReturnType<typeof setTimeout> }>()
  private readonly notices = new NoticeThrottle(NOTICE_EVERY_MS)

  constructor(
    private readonly host: TabCaptureHost,
    private readonly registry: TabCaptureRegistry = new TabCaptureRegistry(),
    private readonly clock: () => number = Date.now
  ) {}

  onChange(listener: (event: TabCaptureEvent) => void): void {
    this.listeners.push(listener)
  }

  private emit(event: TabCaptureEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        // A listener that fails must not keep the sound from coming back or the capture from ending.
        this.host.warn('[tab-capture] a listener of the captures failed:', error)
      }
    }
  }

  /** Says why a call is refused, in the log with who asked, and to the extension in the words of the extension platform. */
  private refuse(where: string, sender: Pick<CaptureSender, 'extensionId' | 'profileId' | 'context'>, message: string): never {
    this.host.warn(`[tab-capture] ${where} refused for ${sender.extensionId} (profile ${sender.profileId}, ${sender.context}): ${message}`)
    throw new Error(message)
  }

  /** The extension runs in the profile and declared `tabCapture`. */
  private requirePermission(where: string, sender: CaptureSender): void {
    if (!declaresTabCapture(this.host.manifestOf(sender.profileId, sender.extensionId))) this.refuse(where, sender, TAB_CAPTURE_ERRORS.noPermission)
  }

  /** The whole function is on, and the person switched the capture on for this extension; if not, they are told where to (once in a while), and the extension reads why. */
  private requireAllowed(where: string, sender: CaptureSender): void {
    // The person took the whole function away: they are not told each time an extension asks, and the extension reads where it is switched on.
    if (!this.host.featureOn()) this.refuse(where, sender, TAB_CAPTURE_ERRORS.featureOff)
    if (this.host.allowed(sender.profileId, sender.extensionId)) return
    this.tellRefused(sender.profileId, sender.extensionId)
    this.refuse(where, sender, TAB_CAPTURE_ERRORS.switchedOff)
  }

  private tellRefused(profileId: string, extensionId: string): void {
    if (this.notices.allow(`${profileId}:${extensionId}`)) this.emit({ kind: 'refused', profileId, extensionId, name: this.host.nameOf(profileId, extensionId) })
  }

  /** `chrome.tabCapture.getMediaStreamId`: the identifier of a capture of the sound of a tab, for the page of the extension that will use it. */
  id(sender: CaptureSender, rawOptions: unknown): string {
    this.requirePermission('getMediaStreamId', sender)
    const options = readCaptureOptions(rawOptions)
    if (!options.ok) return this.refuse('getMediaStreamId', sender, options.message)
    this.requireAllowed('getMediaStreamId', sender)
    const tabId = options.targetTabId ?? this.host.shownTab(sender.profileId)
    if (tabId === undefined) return this.refuse('getMediaStreamId', sender, TAB_CAPTURE_ERRORS.noTab)
    const refusal = targetRefusal(tabId, this.targetOf(sender.profileId, sender.extensionId, tabId))
    if (refusal !== null) return this.refuse('getMediaStreamId', sender, refusal)
    const made = this.registry.issue({ extensionId: sender.extensionId, profileId: sender.profileId, targetTab: tabId, issuer: sender.context })
    if (!made.ok) return this.refuse('getMediaStreamId', sender, made.error)
    return made.id
  }

  /** What is known of the tab now, for the rules: asked again each time a step is taken, since the page can have gone elsewhere. */
  private targetOf(profileId: string, extensionId: string, tabId: number): CaptureTarget | undefined {
    const tab = this.host.tab(tabId)
    if (!tab || tab.profileId !== profileId) return undefined
    return { inProfile: true, url: tab.url, locked: this.host.locked(tabId), lent: this.host.lent(extensionId, tabId, tab.url) }
  }

  /**
   * A page of the extension asks to listen to a tab, with the identifier it took from `getMediaStreamId`: the format of the sound, once the first chunk came. Every condition
   * that held when the identifier was made is read again, the identifier is tied to this page and used up, and the helper page is made; it asks for the stream (answered
   * by `answerHelper`) and its chunks come by `pcm`, which hands them to this page. Whatever goes wrong ends the capture, and the page is told why.
   */
  async listen(sender: CaptureSender, rawId: unknown): Promise<ListenFormat> {
    if (!sender.frame) return this.refuse('listen', sender, TAB_CAPTURE_ERRORS.badIdentifier)
    this.requirePermission('listen', sender)
    this.requireAllowed('listen', sender)
    // What a page sends is judged first by its shape: nothing the size of a document is looked up, or logged.
    if (!isClaimId(rawId)) return this.refuse('listen', sender, `${TAB_CAPTURE_ERRORS.badIdentifier} (malformed)`)
    const bound = this.registry.bind(rawId, { extensionId: sender.extensionId, profileId: sender.profileId, frame: sender.frame, contentsId: sender.frame.contentsId })
    // Refused before any helper page is made: the caps count what is about to begin as what runs.
    if (!bound.ok) return this.refuse('listen', sender, bound.reason === 'busy' ? TAB_CAPTURE_ERRORS.busy : bound.reason === 'too-many' ? TAB_CAPTURE_ERRORS.tooMany : `${TAB_CAPTURE_ERRORS.badIdentifier} (${bound.reason})`)
    const claim = bound.claim
    const drop = (message: string): never => {
      this.registry.end(claim.id)
      return this.refuse('listen', sender, message)
    }
    const refusal = targetRefusal(claim.targetTab, this.targetOf(sender.profileId, sender.extensionId, claim.targetTab))
    if (refusal !== null) return drop(refusal)
    let helper: CaptureHelper | null = null
    try {
      helper = this.host.openHelper(sender.profileId, claim.targetTab)
    } catch (error) {
      this.host.warn(`[tab-capture] the helper page for ${sender.extensionId} could not be made:`, error)
    }
    if (!helper) return drop(TAB_CAPTURE_ERRORS.noHelper)
    this.helpers.set(helper.contentsId, helper)
    if (!this.registry.attachHelper(claim.id, helper.contentsId)) {
      helper.close()
      this.helpers.delete(helper.contentsId)
      return drop(TAB_CAPTURE_ERRORS.badIdentifier)
    }
    const helperId = helper.contentsId
    const ended = new Promise<never>((_resolve, reject) => void this.waiting.set(helperId, reject))
    const first = new Promise<ListenFormat>((resolve) => void this.firsts.set(claim.id, resolve))
    const limits: Array<ReturnType<typeof setTimeout>> = []
    const within = (ms: number, message: string): Promise<never> =>
      new Promise<never>((_resolve, reject) => {
        limits.push(setTimeout(() => reject(new Error(message)), ms))
      })
    try {
      await Promise.race([helper.start(), ended, within(START_TIMEOUT_MS, 'the helper page did not start in time')])
      // The capture may have ended meanwhile (the tab went, the person switched it off), or the helper page never asked for the stream.
      if (this.registry.get(claim.id)?.state !== 'active') throw new Error('the capture ended before the sound came')
      return await Promise.race([first, ended, within(FIRST_SOUND_MS, 'the tab gave no sound within 3 seconds')])
    } catch (error) {
      const why = String((error as Error)?.message ?? error).slice(0, 160)
      this.host.warn(`[tab-capture] listen refused for ${sender.extensionId} (profile ${sender.profileId}, tab ${claim.targetTab}): ${why}`)
      // `finish` destroys the helper page with the claim it served (a capture that ended meanwhile has done it already)...
      this.finish(this.registry.end(claim.id), false)
      // ...and the page goes by its own number all the same: the claim may be gone from the registry without a word, and nothing else would find the window.
      this.closeHelper(helperId)
      throw new Error(`${TAB_CAPTURE_ERRORS.linkFailed} (${why})`)
    } finally {
      for (const limit of limits) clearTimeout(limit)
      this.waiting.delete(helperId)
      this.firsts.delete(claim.id)
    }
  }

  /**
   * A chunk of the sound from a helper page (shared/tab-capture-pcm.ts), already known to come from the main frame of a helper page that exists. It is judged: its shape, its
   * order, its format and its pace, and one violation ends the capture. A good one goes to the page that holds the claim, and to no other. The sound is neither logged nor kept.
   */
  pcm(helperContentsId: number, raw: unknown): void {
    const claim = this.registry.byHelper(helperContentsId)
    // A page that goes, or a capture that ended, may leave a few chunks on the way: they are dropped without a word.
    if (!claim || claim.state !== 'active' || !claim.frame) return
    const read = readChunk(raw)
    if (read.kind === 'end') {
      // The helper page has no more sound (the tab's sound ended, or could not be read): the capture is over, and the page of the extension is asked to end its stream.
      this.finish(this.registry.end(claim.id), true)
      return
    }
    if (read.kind === 'refused') return this.violation(claim, read.message)
    const gate = this.gates.get(claim.id) ?? this.gates.set(claim.id, new PcmGate(this.clock)).get(claim.id)!
    const why = gate.accept(read.chunk)
    if (why !== null) return this.violation(claim, why)
    try {
      this.host.deliver(claim.frame, claim.id, read.chunk.bytes)
    } catch (error) {
      this.host.warn(`[tab-capture] the sound could not be handed to the page of ${claim.extensionId}, so the capture ends:`, error)
      this.finish(this.registry.end(claim.id), true)
      return
    }
    this.firsts.get(claim.id)?.(this.formatOf(read.chunk))
  }

  private formatOf(chunk: PcmChunk): ListenFormat {
    return { sampleRate: chunk.sampleRate, channels: chunk.channels }
  }

  /** The helper page sent what it must not: the capture ends, and the log says what was wrong (never the sound). */
  private violation(claim: Claim, message: string): void {
    this.host.warn(`[tab-capture] the helper page of ${claim.extensionId} (profile ${claim.profileId}, tab ${claim.targetTab}) sent a chunk of sound it must not (${message}): the capture ends`)
    this.finish(this.registry.end(claim.id), true)
  }

  /** The page says its stream is over (its tracks were stopped or ended, or the link closed), or that it could not be made. Idempotent: what is not this page's is left alone. */
  end(sender: CaptureSender, rawId: unknown): void {
    if (!isClaimId(rawId)) return
    const id = rawId
    const waiting = this.stopping.get(id)
    if (waiting) {
      if (sameFrame(waiting.frame, sender.frame)) this.clearStopping(id)
      return
    }
    const claim = this.registry.get(id)
    if (!claim || claim.extensionId !== sender.extensionId || claim.profileId !== sender.profileId || !sameFrame(claim.frame, sender.frame)) return
    this.finish(this.registry.end(id), false)
  }

  /** `chrome.tabCapture.getCapturedTabs`: what the extension captures now, in this profile. */
  list(sender: CaptureSender): Array<{ tabId: number; status: 'active'; fullscreen: false }> {
    this.requirePermission('getCapturedTabs', sender)
    return this.registry
      .actives()
      .filter((claim) => claim.extensionId === sender.extensionId && claim.profileId === sender.profileId)
      .map((claim) => ({ tabId: claim.targetTab, status: 'active' as const, fullscreen: false as const }))
  }

  /** Whether these web contents are a helper page (the display handler answers that page, and no other, with a stream). */
  isHelper(contentsId: number): boolean {
    return this.helpers.has(contentsId)
  }

  /**
   * The permission to ask for a screen (`display-capture`), for a web contents: held by a helper page made for a capture whose claim has not begun, for an extension that
   * still declares `tabCapture` and is still allowed, in the profile of the session it asks in. A page of an extension never holds it; nor does any other page.
   */
  mayShare(contentsId: number, profileId: string): boolean {
    const claim = this.registry.byHelper(contentsId)
    return claim !== undefined && claim.state === 'bound' && claim.profileId === profileId && declaresTabCapture(this.host.manifestOf(profileId, claim.extensionId)) && this.host.featureOn() && this.host.allowed(profileId, claim.extensionId)
  }

  /**
   * The answer to the stream the helper page asks for: the sound of the tab its claim names, and the picture of the helper page itself, which that page takes off its
   * stream (nothing of the tab is ever in a picture). Null refuses the request. Every condition that held when the identifier was made is read again: the person may
   * have switched the capture off, or the tab gone elsewhere, since. The frame must be the main frame of the helper page.
   */
  answerHelper<F>(request: { frame: F | null }, contentsId: number, profileId: string): { audio: unknown; video: F; claim: Claim } | null {
    const claim = this.registry.byHelper(contentsId)
    if (!request.frame || !claim || claim.state !== 'bound' || claim.profileId !== profileId) {
      this.host.warn(`[tab-capture] a stream was asked for by a page that holds no claim it may use (web contents ${contentsId}): refused`)
      return null
    }
    const { extensionId } = claim
    const drop = (why: string): null => {
      this.finish(this.registry.end(claim.id), false)
      this.host.warn(`[tab-capture] stream refused for ${extensionId} (profile ${profileId}, tab ${claim.targetTab}): ${why}`)
      return null
    }
    if (!declaresTabCapture(this.host.manifestOf(profileId, extensionId))) return drop(TAB_CAPTURE_ERRORS.noPermission)
    if (!this.host.featureOn()) return drop(TAB_CAPTURE_ERRORS.featureOff)
    if (!this.host.allowed(profileId, extensionId)) {
      this.tellRefused(profileId, extensionId)
      return drop(TAB_CAPTURE_ERRORS.switchedOff)
    }
    const refusal = targetRefusal(claim.targetTab, this.targetOf(profileId, extensionId, claim.targetTab))
    if (refusal !== null) return drop(refusal)
    const muted = this.host.muted(claim.targetTab)
    // Read before the capture begins: a tab with no frame to take the sound from is refused with nothing made silent and nobody told.
    const audio = this.host.targetFrame(claim.targetTab)
    if (muted === undefined || !audio) return drop(TAB_CAPTURE_ERRORS.gone)
    const started = this.registry.start(claim.id, muted)
    if (!started.ok) {
      // The registry may have dropped the claim already (it was not taken in time): the helper page goes all the same.
      this.finish(this.registry.end(claim.id) ?? claim, false)
      this.host.warn(`[tab-capture] stream refused for ${extensionId} (profile ${profileId}, tab ${claim.targetTab}): ${started.reason}`)
      return null
    }
    // Silent for the person while the extension listens, as the extension platform does: the extension plays the sound back itself if it wants it heard.
    this.host.setMuted(claim.targetTab, true)
    this.emit({ kind: 'started', tabNumber: claim.targetTab, profileId, extensionId, name: this.host.nameOf(profileId, extensionId) })
    return { audio, video: request.frame, claim: started.claim }
  }

  /** The stream could not be handed to the helper page (it went away between the question and the answer): the capture that was about to begin ends. */
  abort(claimId: string): void {
    this.finish(this.registry.end(claimId), false)
  }

  /** The helper page is gone (closed, crashed): the capture it carried ends, and the page of the extension is asked to end its stream. */
  helperGone(contentsId: number): void {
    // `finish` destroys the page: one whose process died still has its window (a destroyed page is left alone).
    for (const claim of this.registry.endWhere({ helperId: contentsId })) this.finish(claim, true)
  }

  /** The person stops the capture of a tab: the pages are asked to end their streams, the sound comes back, and the tab has to be handed over again. True when a capture ran. */
  stop(tabNumber: number): boolean {
    const ended = this.registry.endWhere({ targetTab: tabNumber })
    for (const claim of ended) {
      this.host.revoke(claim.extensionId, tabNumber)
      this.finish(claim, true)
    }
    return ended.some((claim) => claim.state === 'active')
  }

  /** The tab is gone: what its capture made is over with it. */
  tabGone(tabNumber: number): void {
    for (const claim of this.registry.endWhere({ targetTab: tabNumber })) this.finish(claim, true)
  }

  /**
   * The tab is on another address. A capture lasts while the extension still holds the tab (the person handed it over on an origin, and the tab left it): the
   * stream a page made from the page that was there is not carried on to another site.
   */
  targetNavigated(tabNumber: number, url: string): void {
    for (const claim of this.registry.actives()) {
      if (claim.targetTab === tabNumber && !this.host.lent(claim.extensionId, tabNumber, url)) this.finish(this.registry.end(claim.id), true)
    }
  }

  /** The document of the asking page is gone (closed, reloaded, gone elsewhere): its stream and its claims end with it. */
  contentsGone(contentsId: number): void {
    for (const claim of this.registry.endWhere({ contentsId })) this.finish(claim, false)
    // A page that was asked to end its stream and is gone needs no document replaced: what it held is over.
    for (const [id, waiting] of [...this.stopping]) if (waiting.contentsId === contentsId) this.clearStopping(id)
  }

  /** The extension is switched off or removed in the profile: nothing it captured goes on. */
  extensionGone(profileId: string, extensionId: string): void {
    for (const claim of this.registry.endWhere({ extensionId, profileId })) this.finish(claim, true)
  }

  /**
   * What lets an extension capture changed (the person's choices, a lock, an optional permission taken back): a capture that is no longer allowed, whose extension no longer
   * holds `tabCapture`, or whose tab the lock now hides, ends.
   */
  reconsider(): void {
    for (const claim of this.registry.actives()) {
      const holds = declaresTabCapture(this.host.manifestOf(claim.profileId, claim.extensionId))
      if (!holds || !this.host.featureOn() || !this.host.allowed(claim.profileId, claim.extensionId) || this.host.locked(claim.targetTab)) this.finish(this.registry.end(claim.id), true)
    }
  }

  /** The application quits: the sound of every tab comes back, and every helper page goes, with its claim or without one. */
  shutdown(): void {
    for (const claim of this.registry.endWhere({})) this.finish(claim, false)
    for (const id of [...this.helpers.keys()]) this.closeHelper(id)
    for (const id of [...this.stopping.keys()]) this.clearStopping(id)
  }

  /** The extension that listens to a tab, when one does (the mark of the tab says who). */
  capturedBy(tabNumber: number): { profileId: string; extensionId: string; name: string } | undefined {
    const claim = this.registry.actives().find((each) => each.targetTab === tabNumber)
    return claim ? { profileId: claim.profileId, extensionId: claim.extensionId, name: this.host.nameOf(claim.profileId, claim.extensionId) } : undefined
  }

  private closeHelper(contentsId: number | undefined): void {
    if (contentsId === undefined) return
    const helper = this.helpers.get(contentsId)
    this.helpers.delete(contentsId)
    if (!helper) return
    // The page of the extension that waits for the answer is not left waiting for a page that is gone.
    this.waiting.get(contentsId)?.(new Error('the capture ended before the sound came'))
    try {
      helper.close()
    } catch (error) {
      this.host.warn(`[tab-capture] the helper page ${contentsId} could not be destroyed:`, error)
    }
  }

  private clearStopping(id: string): void {
    const waiting = this.stopping.get(id)
    if (!waiting) return
    clearTimeout(waiting.timer)
    this.stopping.delete(id)
  }

  /**
   * One claim is over (already out of the registry). The sound goes back first, to the state it was in before the capture, so that nothing after it can keep
   * it from coming back; then the person is told; then, when the page still holds a stream, it is asked to end it, and its document is replaced if it does not.
   */
  private finish(claim: Claim | undefined, tellPage: boolean): void {
    if (!claim) return
    // The helper page goes first: with it the stream, whatever else fails below.
    this.closeHelper(claim.helperId)
    this.gates.delete(claim.id)
    if (claim.state === 'active') {
      const before = claim.wasMuted ?? false
      try {
        if (this.host.muted(claim.targetTab) !== undefined) this.host.setMuted(claim.targetTab, before)
      } catch (error) {
        this.host.warn(`[tab-capture] the sound of tab ${claim.targetTab} could not be put back:`, error)
      }
      this.emit({ kind: 'ended', tabNumber: claim.targetTab, profileId: claim.profileId, extensionId: claim.extensionId, name: this.host.nameOf(claim.profileId, claim.extensionId), muted: before })
    }
    if (!tellPage || claim.state !== 'active' || !claim.frame || claim.contentsId === undefined) return
    const { frame, contentsId, id } = claim
    try {
      this.host.tellStop(frame, id)
    } catch (error) {
      this.host.warn(`[tab-capture] the page of ${claim.extensionId} could not be asked to end its stream:`, error)
    }
    const timer = setTimeout(() => {
      this.stopping.delete(id)
      this.host.warn(`[tab-capture] the page of ${claim.extensionId} did not end its stream when asked: its document is reloaded`)
      try {
        this.host.forceEnd(contentsId)
      } catch (error) {
        this.host.warn(`[tab-capture] the page of ${claim.extensionId} could not be reloaded:`, error)
      }
    }, STOP_GRACE_MS)
    // The application may quit while a page is being waited for.
    ;(timer as { unref?: () => void }).unref?.()
    this.stopping.set(id, { frame, contentsId, timer })
  }
}
