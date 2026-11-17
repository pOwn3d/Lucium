// The runtime of a script an extension injects into a tab the user lent it with a click (activeTab, no host permission): the main-process side of what shared/lent-tab-runtime.ts
// describes. The preload of the tab (src/preload/lent-tab.ts) makes `chrome.runtime` and `chrome.storage` in the isolated world of the extension and carries the calls of the script
// here; the worker of the extension answers them (src/preload/lent-tab-agent.ts), and a message the worker sends to the tab is handed to the script from here. Nothing is given to the
// page: every call is read again (who sends, whose world it is, whether the tab is still lent), and each answer is a text. The wiring with the engine is in electron-engine-bridge.ts.

import { randomUUID } from 'node:crypto'
import { Channel } from '@shared/ipc-channels'
import {
  answerText,
  CONTEXT_INVALIDATED,
  isLentOp,
  isLentWorld,
  LENT_AREAS,
  LENT_CALL_MAX,
  LENT_PAYLOAD_MAX,
  LENT_RUNTIME_KEY,
  NO_RECEIVER,
  PORT_CLOSED,
  readLentAnswer,
  readLentCall,
  senderOfExtension,
  senderOfScript,
  TOO_LONG,
  type LentAnswer,
  type LentArea
} from '@shared/lent-tab-runtime'
import { isMainFrameSender, type FrameEvent } from '@shared/surface-guard'
import { ANSWER_WAIT_MS } from './lent-asks'

/** The part of a tab this needs: its page's main frame, and its events. */
export interface LentContents {
  id: number
  isDestroyed(): boolean
  mainFrame: { send(channel: string, ...args: unknown[]): void }
  executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>): Promise<unknown>
  /** Emitted when the main frame has gone to a new document (committed): not when a navigation only starts, which may never commit (a 204, a download, an error). */
  on(event: 'did-navigate', listener: () => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

export interface LentTabsHost {
  contents(tabNumber: number): LentContents | undefined
  /** The profile of the tab when the extension holds it now (the loan, the permissions, the site it was lent on) and is loaded in that profile; else undefined. */
  lentProfile(extensionId: string, tabNumber: number): string | undefined
  extensionOfWorld(world: number): string | undefined
  worldOf(extensionId: string): number
  /** What the extension declares in this profile: the permissions it holds now, and its manifest as the worker reads it. */
  details(profileId: string, extensionId: string): { permissions: ReadonlySet<string>; manifest: unknown } | undefined
  /**
   * Asks the worker of the extension (started when it is stopped) to do something for a script of this tab, and answers with what it says, or with the words of a port that closed when the ask is
   * not kept (too many at once, too much text: engine/lent-asks.ts). `characters` is the length of the JSON the script sent. Never rejects for a reason of the worker: it answers with it.
   */
  askWorker(profileId: string, extensionId: string, tabNumber: number, op: 'message' | 'storage', payload: unknown, characters: number): Promise<unknown>
  /** Whether an ask of this many characters would be kept now (engine/lent-asks.ts): asked before the text is parsed, so that what would be refused costs nothing to read. */
  mayAsk(profileId: string, extensionId: string, characters: number): boolean
  /** What was asked of workers for the script of this tab can no longer be answered to anyone: the tab went to another document or closed. */
  dropAsks(tabNumber: number): void
  warn(message: string, detail?: unknown): void
}

/** How long the page has to take the runtime: it answers at once, or its preload is not there (a page loaded before the extension was). */
export const ATTACH_WAIT_MS = 2000
/** The most JSON of a manifest handed to a script. A manifest is a few kilobytes; one that is not gets an empty one rather than a slow page. */
const MANIFEST_MAX = 256 * 1024

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The frame that sent a call, or an empty address. */
function frameUrlOf(event: { senderFrame?: unknown }): string {
  const frame = event.senderFrame as { url?: unknown } | null | undefined
  return typeof frame?.url === 'string' ? frame.url : ''
}

export class LentTabs {
  /** The page that was asked to take the runtime and has not answered yet, by what it was asked with. */
  private readonly acks = new Map<string, { tab: number; done: (ok: boolean, reason?: string) => void }>()
  /** The extensions whose script runs in the document of each tab now: the runtime is there until the tab goes to another document. */
  private readonly attached = new Map<number, Set<string>>()
  /** The tabs whose page did not answer: no preload, so no waiting for it again until the tab goes to another document. */
  private readonly unreachable = new Set<number>()
  private readonly watched = new Set<number>()
  /**
   * What a call must carry to be heard, by tab and world: given to the preload of the document with the runtime, kept there out of the world of the script, and made again for each document. A call
   * names its world, and the main process cannot see which one it comes from; the token is what ties a call to the document that was given the bridge, and to nothing else in the page.
   */
  private readonly tokens = new Map<number, Map<number, string>>()

  constructor(
    private readonly host: LentTabsHost,
    private readonly attachWaitMs: number = ATTACH_WAIT_MS,
    private readonly answerWaitMs: number = ANSWER_WAIT_MS
  ) {}

  /**
   * Makes sure the isolated world of the extension in this tab has `chrome.runtime` and `chrome.storage`, before a script runs there. False, with the reason in the journal, when the page does not
   * take them: the script then runs with the page and nothing more, as it did before.
   */
  async ensure(tabNumber: number, extensionId: string, profileId: string): Promise<boolean> {
    const wc = this.host.contents(tabNumber)
    const details = this.host.details(profileId, extensionId)
    if (!wc || !details || this.unreachable.has(tabNumber)) return false
    // The loan is read again here, not taken from the caller: a tab that is not lent to the extension (or has left the site it was lent on) is sent nothing.
    if (this.host.lentProfile(extensionId, tabNumber) !== profileId) return false
    this.watch(wc, tabNumber)
    const world = this.host.worldOf(extensionId)
    const manifest = details.manifest ?? {}
    const tooLong = JSON.stringify(manifest).length > MANIFEST_MAX
    if (tooLong) this.host.warn(`[lent-tab] the manifest of ${extensionId} is too long to hand to a script of a tab: it gets an empty one`)
    const nonce = randomUUID()
    const answered = new Promise<{ ok: boolean; silent?: boolean; reason?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(nonce)
        resolve({ ok: false, silent: true, reason: `the page did not answer in ${this.attachWaitMs} ms (its preload is not there: it was loaded before the extension)` })
      }, this.attachWaitMs)
      this.acks.set(nonce, {
        tab: tabNumber,
        done: (ok, reason) => {
          clearTimeout(timer)
          resolve({ ok, ...(reason === undefined ? {} : { reason }) })
        }
      })
    })
    try {
      wc.mainFrame.send(Channel.lentTabAttach, nonce, world, { extensionId, manifest: tooLong ? {} : manifest, permissions: [...details.permissions], token: this.tokenOf(tabNumber, world) })
    } catch (error) {
      this.acks.delete(nonce)
      this.host.warn(`[lent-tab] the page of tab ${tabNumber} could not be asked to take the runtime of ${extensionId}:`, error)
      return false
    }
    const result = await answered
    if (!result.ok) {
      // A page with no preload is never going to answer: it is not waited for again at this document (a navigation clears it).
      if (result.silent) this.unreachable.add(tabNumber)
      this.host.warn(`[lent-tab] tab ${tabNumber} has no runtime for ${extensionId}, so its script runs with the page only: ${result.reason ?? 'no reason given'}`)
      return false
    }
    // The tab may have left its site while the page answered: nothing is made of a runtime that is no one's.
    if (this.host.lentProfile(extensionId, tabNumber) !== profileId) return false
    const here = this.attached.get(tabNumber) ?? new Set<string>()
    here.add(extensionId)
    this.attached.set(tabNumber, here)
    return true
  }

  /** The page says it took the runtime (or why it could not). Only the main frame of the tab that was asked is heard. */
  attachedBy(event: FrameEvent & { sender: { id: number; mainFrame?: unknown } }, nonce: unknown, ok: unknown, reason: unknown): void {
    if (!isMainFrameSender(event) || typeof nonce !== 'string') return
    const waiting = this.acks.get(nonce)
    if (!waiting || waiting.tab !== event.sender.id) return
    this.acks.delete(nonce)
    waiting.done(ok === true, typeof reason === 'string' ? reason.slice(0, 300) : undefined)
  }

  /**
   * A call of the script of a tab, over the bridge (src/preload/lent-tab.ts): a message for the worker of its extension, or a call of its storage. The extension is the one the world belongs
   * to, never one the call names; the tab must still be lent to it; the call must carry the token this document was given with the bridge. What the extension says comes back as a text, an error too.
   */
  async call(event: FrameEvent & { sender: { id: number; mainFrame?: unknown } }, world: unknown, token: unknown, op: unknown, payload: unknown): Promise<string> {
    if (!isMainFrameSender(event)) throw new Error(CONTEXT_INVALIDATED)
    const tabNumber = event.sender.id
    const known = isLentWorld(world) ? world : undefined
    const extensionId = known === undefined ? undefined : this.host.extensionOfWorld(known)
    const profileId = extensionId === undefined ? undefined : this.host.lentProfile(extensionId, tabNumber)
    if (known === undefined || extensionId === undefined || profileId === undefined || typeof token !== 'string' || this.tokens.get(tabNumber)?.get(known) !== token) throw new Error(CONTEXT_INVALIDATED)
    // What is too long is refused as it is, and what would be refused for want of room is refused before it is parsed: the cost of reading a text is what is kept from the script that sends many.
    if (typeof payload !== 'string') return answerText({ ok: false, error: 'The call carries no text.' })
    if (payload.length > LENT_CALL_MAX) return answerText({ ok: false, error: TOO_LONG })
    if (!isLentOp(op)) return answerText({ ok: false, error: 'This call is not offered to a script of a tab.' })
    if (!this.host.mayAsk(profileId, extensionId, payload.length)) return answerText({ ok: false, error: PORT_CLOSED })
    let call
    try {
      call = readLentCall(op, payload)
    } catch (error) {
      return answerText({ ok: false, error: reasonOf(error) })
    }
    // What the script sent, in characters: the budget of the asks counts them (the text itself has been received by now, and is let go of when the ask is answered or refused).
    const characters = (payload as string).length
    if (call.op === 'storage' && this.host.details(profileId, extensionId)?.permissions.has('storage') !== true) return answerText({ ok: false, error: 'The extension has no permission to use chrome.storage.' })
    try {
      const raw =
        call.op === 'send'
          ? await this.host.askWorker(profileId, extensionId, tabNumber, 'message', { tabId: tabNumber, sender: senderOfScript(extensionId, frameUrlOf(event)), message: call.message }, characters)
          : await this.host.askWorker(profileId, extensionId, tabNumber, 'storage', { area: call.area, method: call.method, args: call.args }, characters)
      // The worker was held to the size of what it hands over before this was written out of it (engine/lent-asks.ts); what is written is read once more.
      const text = answerText(readLentAnswer(raw))
      return text.length > LENT_PAYLOAD_MAX ? answerText({ ok: false, error: TOO_LONG }) : text
    } catch (error) {
      return answerText({ ok: false, error: reasonOf(error) })
    }
  }

  /**
   * A message the extension sent to a tab (`chrome.tabs.sendMessage`, which Chromium refused for want of a content script): handed to the script that runs there, and what the script answers is
   * what comes back. Throws, in the words of the extension platform, when nothing in the tab listens.
   */
  async toTab(profileId: string, extensionId: string, tabNumber: number, message: unknown, senderUrl: unknown, frameId: unknown): Promise<unknown> {
    if (frameId !== undefined && frameId !== 0) throw new Error(NO_RECEIVER)
    const wc = this.host.contents(tabNumber)
    if (!wc || this.host.lentProfile(extensionId, tabNumber) !== profileId || this.attached.get(tabNumber)?.has(extensionId) !== true) throw new Error(NO_RECEIVER)
    const answer = await this.deliver(wc, this.host.worldOf(extensionId), { kind: 'message', message, sender: senderOfExtension(extensionId, senderUrl) })
    if (answer === undefined) throw new Error(NO_RECEIVER)
    if (!answer.ok) throw new Error(answer.error)
    return answer.value
  }

  /** The storage of an extension changed (the worker says so): the scripts it runs in lent tabs are told, as a content script is. */
  changed(profileId: string, extensionId: string, area: unknown, changes: unknown): void {
    if (!LENT_AREAS.some((name) => name === area) || typeof changes !== 'object' || changes === null) return
    for (const [tabNumber, extensions] of [...this.attached]) {
      if (!extensions.has(extensionId) || this.host.lentProfile(extensionId, tabNumber) !== profileId) continue
      const wc = this.host.contents(tabNumber)
      if (!wc) continue
      this.deliver(wc, this.host.worldOf(extensionId), { kind: 'changed', area: area as LentArea, changes }).catch((error: unknown) => this.host.warn(`[lent-tab] a change of the storage of ${extensionId} could not be handed to tab ${tabNumber}:`, error))
    }
  }

  /** The tab is gone: nothing is kept of it. */
  tabGone(tabNumber: number): void {
    this.documentGone(tabNumber)
    this.watched.delete(tabNumber)
    for (const [nonce, waiting] of [...this.acks]) {
      if (waiting.tab !== tabNumber) continue
      this.acks.delete(nonce)
      waiting.done(false, 'the tab is gone')
    }
  }

  /** What the script of the extension answers to something handed over, or undefined where no runtime was made (the tab is at another document since). */
  private async deliver(wc: LentContents, world: number, payload: unknown): Promise<LentAnswer | undefined> {
    const text = JSON.stringify(payload)
    if (text.length > LENT_PAYLOAD_MAX) return { ok: false, error: 'The text handed over is too long.' }
    // The text is written as a string of the page's language, so that nothing in it can end the call and run as code.
    const code = `(() => { const runtime = globalThis[${JSON.stringify(LENT_RUNTIME_KEY)}]; return runtime ? runtime.deliver(${JSON.stringify(text)}) : undefined })()`
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(world, [{ code }]),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(answerText({ ok: false, error: PORT_CLOSED })), this.answerWaitMs)
        })
      ])
      // What the script answered is text already, and is read only if it is not longer than is handed over.
      if (typeof result === 'string' && result.length > LENT_PAYLOAD_MAX) return { ok: false, error: TOO_LONG }
      return typeof result === 'string' ? readLentAnswer(JSON.parse(result)) : undefined
    } catch (error) {
      // A tab that goes to another document ends what was handed to the old one, as the extension platform ends a port.
      if (/disposed|destroyed/i.test(reasonOf(error))) return { ok: false, error: PORT_CLOSED }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** The document of the tab is gone (it went to another one, or closed): the runtime made in it, its token and what its script asked of the workers go with it. */
  private documentGone(tabNumber: number): void {
    this.attached.delete(tabNumber)
    this.unreachable.delete(tabNumber)
    this.tokens.delete(tabNumber)
    this.host.dropAsks(tabNumber)
  }

  private tokenOf(tabNumber: number, world: number): string {
    let worlds = this.tokens.get(tabNumber)
    if (!worlds) this.tokens.set(tabNumber, (worlds = new Map<number, string>()))
    let token = worlds.get(world)
    if (token === undefined) worlds.set(world, (token = randomUUID()))
    return token
  }

  /**
   * What is kept of a tab ends with its document and with the tab. The document ends when the main frame has gone to a new one: not when a navigation starts, which a page can make and never
   * commit (a 204 answer), and the script it injected is still there.
   */
  private watch(wc: LentContents, tabNumber: number): void {
    if (this.watched.has(tabNumber)) return
    this.watched.add(tabNumber)
    wc.on('did-navigate', () => this.documentGone(tabNumber))
    wc.once('destroyed', () => this.tabGone(tabNumber))
  }
}
