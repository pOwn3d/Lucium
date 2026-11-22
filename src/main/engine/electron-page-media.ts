// A layer of ElectronPage (electron-page.ts): the in-page tools (autoscroll, mouse gestures, synchronized scrolling, keyboard navigation),
// reading aloud, and the media of the page (picture in picture, the floating video, the volume, the player's commands). Cut out of
// electron-page.ts as it was.

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { MEDIA_BRIDGE, mergeProbes, parseSessionActions, type MediaProbe } from '@shared/media-player'
import { MEDIA_PAUSE, MEDIA_PLAY, MEDIA_PROBE, PIP_AUTO_CAN_ENTER, PIP_AUTO_ENTER, PIP_CAN_ENTER, PIP_ENTER, PIP_EXIT, frameVolumeScript, type PictureInPictureResult } from './media-scripts'
import type { FloatingStage, PictureInPictureAsker, PictureInPictureOutcome } from './types'
import { FLOATING_WORLD, FLOAT_FACTS, FLOAT_FIND, FLOAT_STAGE, FLOAT_UNSTAGE, floatCommandScript } from './floating-video-scripts'
import { parseFacts, type FloatingVideoFacts, type VideoCommand } from '@shared/floating-video'
import { FLOAT_FRAMES_MAX } from './sleep-probe'
import { scrollSyncApplyScript } from '@shared/scroll-sync'
import { TOOLS_WORLD, TOOL_NAMES, anyPageTool, parseToolMessage, samePageTools, type PageTools, type ToolCommand, type ToolMessage } from '@shared/page-tools'
import { speakScript, speechChunks, speechLang, speechText, stopSpeakingScript } from '@shared/read-aloud'
import { t } from '@shared/i18n'
import { MEDIA_SCRIPT_TIMEOUT_MS, TOOL_SCRIPTS, PIP_TIMEOUT_MS, withTimeout } from './electron-page-scripts'
import { ElectronPageContent } from './electron-page-content'

/** How long after its own request for the system's Picture in Picture a page still counts the `enterpictureinpicture` it hears as its own (the event and the answer of the script travel on different pipes). */
const OWN_PIP_GRACE_MS = 1500

export abstract class ElectronPageMedia extends ElectronPageContent {
  /** Requests of the system's Picture in Picture made by Lucium itself that are not over yet: the site's button is told apart from them. */
  private ownPip = 0

  /** Runs a request of Lucium for the system's Picture in Picture: the event it causes is not the site's button, and is not taken into Lucium's window. */
  private async ownPictureInPicture<T>(request: () => Promise<T>): Promise<T> {
    this.ownPip++
    try {
      return await request()
    } finally {
      setTimeout(() => void this.ownPip--, OWN_PIP_GRACE_MS).unref?.()
    }
  }

  /** A video of the page entered the system's Picture in Picture (heard by the media bridge): unless Lucium asked for it, it is the site's own button. */
  sitePictureInPicture(): void {
    if (this.gone || this.ownPip > 0) return
    this.events.sitePictureInPicture?.()
  }

  /** Whether a video being watched floats as the tab is left (shared/auto-pip.ts), asked in a world of our own and without a gesture. */
  async watchedVideoCanFloat(): Promise<boolean> {
    if (this.gone) return false
    try {
      return (await this.webContents.executeJavaScriptInIsolatedWorld(FLOATING_WORLD, [{ code: PIP_AUTO_CAN_ENTER }])) === true
    } catch (error) {
      if (!this.gone && !/disposed/i.test(String(error))) console.warn(`[pip] page ${this.id}: its watched video could not be looked for:`, error instanceof Error ? error.message : String(error))
      return false
    }
  }
  /** Ends the hold on the menu of a right click (the last layer: electron-page.ts), which the mouse gestures of the tools decide. */
  protected abstract releaseHeld(show: boolean): void

  // ---- in-page tools (autoscroll, mouse gestures, synchronized scrolling) and reading aloud ----

  setPageTools(next: PageTools): void {
    if (this.gone || samePageTools(next, this.tools)) return
    this.tools = { ...next }
    this.syncTools()
  }

  /** Makes the document on screen carry exactly the tools this page is to carry; a document that is not ready yet gets them at its `dom-ready`. */
  protected syncTools(): void {
    const wc = this.liveContents()
    if (!wc) return
    this.listenForTools(wc, anyPageTool(this.tools) || this.speaking)
    if (!anyPageTool(this.tools) && this.installedTools.size === 0) return
    this.toolNonce ??= randomUUID()
    // No document yet (the page was just made): the tools go in at its `dom-ready`.
    if (wc.getURL() === '') return
    for (const name of TOOL_NAMES) {
      const wanted = this.tools[name]
      if (wanted === this.installedTools.has(name)) continue
      const code = wanted ? TOOL_SCRIPTS[name].install(this.toolNonce) : TOOL_SCRIPTS[name].uninstall
      if (wanted) this.installedTools.add(name)
      else this.installedTools.delete(name)
      wc.executeJavaScriptInIsolatedWorld(TOOLS_WORLD, [{ code }]).catch((error: unknown) => {
        // The page went away (or is not a document yet) before the script ran: the next document gets the tools at its dom-ready.
        this.installedTools.delete(name)
        if (!this.gone) console.warn(`[page-tools] cannot ${wanted ? 'install' : 'remove'} ${name} on page ${this.id}:`, error instanceof Error ? error.message : String(error))
      })
    }
    if (!this.tools.mouseGestures) this.releaseHeld(true)
  }

  /** Listens to the console of the page while a tool is on (or the voice is speaking): the lines of the tools are the only way they speak. */
  private listenForTools(wc: WebContents, on: boolean): void {
    if (on === this.listeningForTools) return
    this.listeningForTools = on
    if (on) wc.on('console-message', this.onToolLine)
    else wc.off('console-message', this.onToolLine)
  }

  private readonly onToolLine = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (this.toolNonce === null) return
    const message = parseToolMessage(event.message, this.toolNonce)
    if (message === null) return
    if (message === 'invalid') {
      console.warn(`[page-tools] page ${this.id} sent a line the tools do not write: ignored`)
      return
    }
    this.onToolMessage(message)
  }

  private onToolMessage(message: ToolMessage): void {
    if (message.tool === 'speech') {
      this.speaking = false
      this.syncTools()
      return
    }
    if (message.tool === 'gesture') {
      // The release of the right button: a plain click opens the menu that was held, a gesture drops it.
      this.verdict = { plain: message.path === '', at: Date.now() }
      this.releaseHeld(message.path === '')
      if (message.path === '') return
    }
    this.events.toolMessage?.(message)
  }

  toolCommand(command: ToolCommand): void {
    const wc = this.liveContents()
    if (!wc || !this.installedTools.has(command.tool)) return
    wc.executeJavaScriptInIsolatedWorld(TOOLS_WORLD, [{ code: scrollSyncApplyScript(command.x, command.y) }]).catch((error: unknown) => {
      if (!this.gone) console.warn(`[page-tools] page ${this.id} did not take the scroll position:`, error instanceof Error ? error.message : String(error))
    })
  }

  speak(text: string, lang: string | null): void {
    const wc = this.liveContents()
    const chunks = speechChunks(speechText(text), 220)
    if (!wc || chunks.length === 0) return
    this.toolNonce ??= randomUUID()
    this.speaking = true
    this.listenForTools(wc, true)
    // A click on a menu entry is the user's: the voice may speak.
    wc.executeJavaScriptInIsolatedWorld(TOOLS_WORLD, [{ code: speakScript(chunks, speechLang(lang), this.toolNonce) }], true).catch((error: unknown) => {
      this.speaking = false
      this.syncTools()
      if (!this.gone) console.error(`[read-aloud] page ${this.id} cannot speak:`, error instanceof Error ? error.message : String(error))
    })
  }

  stopSpeaking(): void {
    const wc = this.liveContents()
    this.speaking = false
    if (!wc) return
    wc.executeJavaScriptInIsolatedWorld(TOOLS_WORLD, [{ code: stopSpeakingScript() }]).catch((error: unknown) => {
      if (!this.gone) console.warn(`[read-aloud] page ${this.id} cannot stop its voice:`, error instanceof Error ? error.message : String(error))
    })
    this.syncTools()
  }
  async setPictureInPicture(on: boolean, by: PictureInPictureAsker = 'user'): Promise<boolean> {
    if (this.gone) return false
    try {
      // Leaving the picture needs no gesture, and neither does finding out whether there is a video to float. Only entering it does
      // (requestPictureInPicture() is refused without one) and a script run with a gesture gives the page a user activation, which is
      // enough for autoplay: running every tab switch with one let any page you looked at start its sounds by itself afterwards.
      if (!on) return (await this.webContents.executeJavaScript(PIP_EXIT)) === true
      // A tab left floats only a video being watched (shared/auto-pip.ts); the user's own request floats whatever can. A tab left is asked in a
      // world of our own: in the page's world, a page that replaced a builtin could answer the question itself, and be given a gesture, which it
      // would keep, at every tab switch.
      const canEnter = by === 'tab-switch' ? this.webContents.executeJavaScriptInIsolatedWorld(FLOATING_WORLD, [{ code: PIP_AUTO_CAN_ENTER }]) : this.webContents.executeJavaScript(PIP_CAN_ENTER)
      if ((await canEnter) !== true) return false
      const result = (await this.ownPictureInPicture(() => this.webContents.executeJavaScript(by === 'tab-switch' ? PIP_AUTO_ENTER : PIP_ENTER, true))) as PictureInPictureResult
      // The script says a refusal to us only (the page reads its own console): the journal is where it is written.
      if (!result.entered && result.reason === 'refused') console.warn(`[pip] page ${this.id}: the video did not float (${by}): ${result.detail ?? ''}`)
      return result.entered
    } catch (error) {
      // The page was closed while the script ran: there is nothing left to float, which is not a failure.
      if (this.gone || /disposed/i.test(String(error))) return false
      throw error
    }
  }
  /** "Image dans l'image" asked by the user (the menu): the video that floats is the page's main one, and what keeps it from floating is said. */
  async floatMainVideo(): Promise<PictureInPictureOutcome> {
    if (this.gone) return { ok: false, reason: 'gone' }
    try {
      // The user asked for it (a click in the menu): the script runs with a gesture, which requestPictureInPicture() needs.
      // The page can leave the request pending (a stream that never settles): a limit turns the wait into a reason, so the user is told.
      const result = (await this.ownPictureInPicture(() => withTimeout(this.webContents.executeJavaScript(PIP_ENTER, true), PIP_TIMEOUT_MS))) as PictureInPictureResult | 'timeout'
      if (result === 'timeout') return { ok: false, reason: 'refused', detail: t('engine.la-page-n-a-pas-repondu-a-temps') }
      if (result.entered) return { ok: true }
      if (result.reason !== 'already') console.warn(`[pip] page ${this.id}: nothing floated (${result.reason}): ${result.detail ?? ''}`)
      return { ok: false, reason: result.reason, detail: result.detail }
    } catch (error) {
      if (this.gone || /disposed/i.test(String(error))) return { ok: false, reason: 'gone' }
      return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  setVolume(volume: number): void {
    this.volume = volume
    for (const frame of this.liveFrames()) {
      try {
        // The bridge lives in the main frame: it keeps the level for the media that start later. A frame has no bridge (Electron loads a
        // preload into the main frame only): its media are turned down once, now.
        if (frame.parent === null) frame.send(MEDIA_BRIDGE.command, { kind: 'volume', value: volume })
        else void frame.executeJavaScript(frameVolumeScript(volume)).catch((error: unknown) => console.debug(`[media] a frame of page ${this.id} did not take the volume:`, error instanceof Error ? error.message : String(error)))
      } catch (error) {
        // A frame that went away between the list and the message has no media left to turn down.
        console.debug(`[media] a frame of page ${this.id} did not take the volume:`, (error as Error).message)
      }
    }
  }
  /** The level a document of this tab starts at (the bridge asks when it loads). */
  tabVolume(): number {
    return this.volume
  }
  /** The main frame of the page told which MediaSession handlers the site registered. Anything but a list of names is ignored. */
  reportTrackActions(raw: unknown): void {
    const actions = parseSessionActions(raw)
    if (!actions) return console.warn(`[media] page ${this.id} reported something that is not a list of actions`)
    this.trackActions = actions
    this.events.update({ trackActions: actions })
  }
  async controlMedia(command: 'play' | 'pause' | 'previous' | 'next'): Promise<boolean> {
    if (this.gone) return false
    if (command === 'previous' || command === 'next') {
      const known = command === 'previous' ? this.trackActions.previous : this.trackActions.next
      if (!known) return false
      this.webContents.mainFrame.send(MEDIA_BRIDGE.command, { kind: 'action', name: command === 'previous' ? 'previoustrack' : 'nexttrack' })
      return true
    }
    // With a user gesture: a page may refuse to start a media element it has not been touched about.
    return (await this.inFrames(command === 'play' ? MEDIA_PLAY : MEDIA_PAUSE, true)).some((answer) => answer === true)
  }
  async probeMedia(): Promise<MediaProbe | null> {
    if (this.gone || this.frozen) return null
    const answers = await this.inFrames(MEDIA_PROBE, false)
    // No frame answered at all: the page could not tell (gone, or hung), which is not the same as "nothing is playing".
    return answers.every((answer) => answer === null) ? null : mergeProbes(answers as Array<Partial<MediaProbe> | null>)
  }

  async findFloatingVideo(): Promise<'page' | 'frame' | 'none'> {
    if (this.gone) return 'none'
    try {
      if ((await this.webContents.executeJavaScriptInIsolatedWorld(FLOATING_WORLD, [{ code: FLOAT_FIND }])) === true) return 'page'
    } catch (error) {
      if (this.gone || /disposed/i.test(String(error))) return 'none'
      console.warn(`[pip] page ${this.id}: its video could not be looked for:`, error instanceof Error ? error.message : String(error))
      return 'none'
    }
    // An embedded player (the video of another site, in a frame): asked in its own frame, without a gesture, as the main frame was.
    const frames = this.liveFrames().slice(1, 1 + FLOAT_FRAMES_MAX)
    const answers = await Promise.all(
      frames.map((frame) =>
        withTimeout(frame.executeJavaScript(PIP_CAN_ENTER), MEDIA_SCRIPT_TIMEOUT_MS).then(
          (answer) => answer === true,
          (error: unknown) => {
            console.debug(`[pip] a frame of page ${this.id} did not say whether it has a video:`, error instanceof Error ? error.message : String(error))
            return false
          }
        )
      )
    )
    return answers.some(Boolean) ? 'frame' : 'none'
  }

  async floatFrameVideo(): Promise<PictureInPictureOutcome> {
    if (this.gone) return { ok: false, reason: 'gone' }
    let refused: string | undefined
    for (const frame of this.liveFrames().slice(1, 1 + FLOAT_FRAMES_MAX)) {
      try {
        // The user asked (a click in the menu): the script runs with a gesture in that frame, which requestPictureInPicture() needs there.
        const result = (await this.ownPictureInPicture(() => withTimeout(frame.executeJavaScript(PIP_ENTER, true), PIP_TIMEOUT_MS))) as PictureInPictureResult | 'timeout'
        if (result === 'timeout') refused = t('engine.la-page-n-a-pas-repondu-a-temps')
        else if (result.entered) return { ok: true }
        else if (result.reason === 'refused') refused = result.detail
      } catch (error) {
        console.debug(`[pip] a frame of page ${this.id} could not float its video:`, error instanceof Error ? error.message : String(error))
      }
    }
    return refused !== undefined ? { ok: false, reason: 'refused', detail: refused } : { ok: false, reason: 'no-video' }
  }

  async stageFloatingVideo(): Promise<FloatingStage> {
    if (this.gone) return { staged: false, reason: 'gone' }
    try {
      const answer = (await this.webContents.executeJavaScriptInIsolatedWorld(FLOATING_WORLD, [{ code: FLOAT_STAGE }])) as Partial<{ staged: boolean; width: number; height: number; live: boolean; protected: boolean; reason: string }> | null
      if (answer?.staged !== true) return { staged: false, reason: 'no-video' }
      const size = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
      return { staged: true, width: size(answer.width), height: size(answer.height), live: answer.live === true, protected: answer.protected === true }
    } catch (error) {
      if (this.gone || /disposed/i.test(String(error))) return { staged: false, reason: 'gone' }
      return { staged: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async unstageFloatingVideo(): Promise<void> {
    if (this.gone) return
    try {
      await this.webContents.executeJavaScriptInIsolatedWorld(FLOATING_WORLD, [{ code: FLOAT_UNSTAGE }])
    } catch (error) {
      if (this.gone || /disposed/i.test(String(error))) return
      console.warn(`[pip] page ${this.id} could not be given back as it was:`, error instanceof Error ? error.message : String(error))
    }
  }

  async floatingVideoFacts(): Promise<FloatingVideoFacts | null> {
    if (this.gone || this.frozen) return null
    try {
      return parseFacts(await withTimeout(this.webContents.executeJavaScriptInIsolatedWorld(FLOATING_WORLD, [{ code: FLOAT_FACTS }]), MEDIA_SCRIPT_TIMEOUT_MS))
    } catch (error) {
      if (!this.gone && !/disposed/i.test(String(error))) console.debug(`[pip] the floating video of page ${this.id} could not be read:`, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async floatingVideoCommand(command: VideoCommand): Promise<boolean> {
    if (this.gone) return false
    try {
      // With a user gesture: the user clicked the bar (a site may refuse to start a video it has not been touched about).
      const done = await withTimeout(this.webContents.executeJavaScriptInIsolatedWorld(FLOATING_WORLD, [{ code: floatCommandScript(command) }], true), MEDIA_SCRIPT_TIMEOUT_MS)
      return done === true
    } catch (error) {
      if (!this.gone && !/disposed/i.test(String(error))) console.warn(`[pip] the floating video of page ${this.id} did not take "${command.kind}":`, error instanceof Error ? error.message : String(error))
      return false
    }
  }
}
