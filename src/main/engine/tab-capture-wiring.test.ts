// How the engine wires the capture of the sound of a tab (tab-capture.ts): who asks is read from the frame or the worker that sent the call, the profile from
// its session, what the person allowed from the settings the shell hands the engine, and the screen is held by the helper page of a capture and by no other page.
// Run on the real engine, constructed over a stand-in of Electron (engine-constructed.test-support.ts) and a stand-in of the helper page, whose chunks of sound come in by the real
// gate of the engine (`ipcMain.on`); the engine checks replay what only Electron can do (smoke-tabcapture.ts).

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_HELPER_URL } from '@shared/capture-helper-page'
import { Channel } from '@shared/ipc-channels'
import { TAB_CAPTURE_ERRORS } from '@shared/tab-capture'
import { FakeProfileSession } from '../profile-made.test-support'
import { constructEngine, emitApp, world } from './engine-constructed.test-support'
import { captureHelperLoadHeader, installInternalPages } from './internal-pages'

const contents = new Map<number, Record<string, unknown>>()
/** The frames of the pages of extensions `webFrameMain.fromId` finds, by `${processId}.${routingId}`: the ones the engine asks to end their streams. */
const frames = new Map<string, { send: (channel: string, ...args: unknown[]) => void }>()
vi.mock('electron', async () =>
  (await import('./engine-constructed.test-support')).engineElectron({
    fromId: (id: number) => contents.get(id),
    // The frames of this test carry the web contents they belong to.
    fromFrame: (frame: unknown) => (frame as { contents?: unknown } | null)?.contents,
    webFrameMain: { fromId: (processId: number, routingId: number) => frames.get(`${processId}.${routingId}`) }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined, handleCRXProtocol: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

/** The helper pages the engine made, and what each was given: the stand-in of `openCaptureHelper` (the real one opens a window). */
interface MadeHelper {
  session: unknown
  loadHeader: string
  hooks: { gone(contentsId: number): void; warn(message: string, detail?: unknown): void }
  contentsId: number
  starts: number
  closed: number
}
const helpers: MadeHelper[] = []
/** What the helper page does when it is asked to begin: set by `engineWith` (it asks for the stream, then sends a chunk), or by a test (it hangs). */
let helperBehavior: ((made: MadeHelper) => Promise<void>) | undefined
vi.mock('./tab-capture-helper', () => ({
  openCaptureHelper: (session: unknown, hooks: MadeHelper['hooks'], loadHeader: string) => {
    const made: MadeHelper = { session, loadHeader, hooks, contentsId: 500 + helpers.length, starts: 0, closed: 0 }
    helpers.push(made)
    return {
      contentsId: made.contentsId,
      start: () => {
        made.starts++
        return helperBehavior ? helperBehavior(made) : Promise.reject(new Error('nobody drives the helper page'))
      },
      close: () => void made.closed++
    }
  }
}))

const EXT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const MANIFEST = { manifest_version: 3, permissions: ['activeTab', 'tabCapture'] }
const MEET = 'https://meet.example.com/abc'
const EXT_URL = `chrome-extension://${EXT}/offscreen.html`
/** A chunk of sound as the helper page packs it (shared/tab-capture-pcm.ts): the four integers, then the planes. */
function chunk(seq: number, frames = 960): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + frames * 4)
  const view = new DataView(buffer)
  for (const [at, value] of [seq, 48_000, 1, frames].entries()) view.setUint32(at * 4, value, true)
  new Float32Array(buffer, 16).fill(0.25)
  return buffer
}

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handler = (channel: string): Handler => world.ipcHandle.get(channel) as Handler

type Answer = { audio: unknown; video: unknown } | null
type Request = (contents: unknown, permission: string, answer: (granted: boolean) => void, details: Record<string, unknown>) => void
type DisplayHandler = (request: { frame: unknown; userGesture?: boolean; videoRequested?: boolean; audioRequested?: boolean }, callback: (streams: Answer) => void) => void

/** The main frame of a helper page as Chromium reports it to the main process: its origin, its address, no parent. */
const helperMainFrame = { origin: 'lucium-ui://capture-helper', url: CAPTURE_HELPER_URL, parent: null }
/** The main frame of a helper page, as Electron names it: its fixed address, no parent. */
const helperFrame = (contentsId: number) => ({ url: CAPTURE_HELPER_URL, parent: null, processId: 50, routingId: 1, contents: { id: contentsId } })
/** The frame of the page of the extension that asks: the one the stream is made for. */
const pageFrame = { url: EXT_URL, parent: null, processId: 11, routingId: 3, contents: { id: 40 } }

/**
 * An engine with a profile (`default`) that runs the two extensions, a tab (number 7) of it at `MEET`, the person's choices as given, and the handlers the engine
 * puts on the session of the profile (the permission and the display media). The helper page asks for the screen through them, as the real one does.
 */
async function engineWith(over: { allowed?: string[]; lent?: string[]; serves?: boolean } = {}) {
  const engine = (await constructEngine()) as unknown as Record<string, any>
  const ses = new FakeProfileSession('persist:profile-default')
  // A session of a profile serves the page of the helper (and carries the secret of the engine's load of it): the application does this when it makes the session.
  if (over.serves !== false) installInternalPages(ses as never, 'serve')
  engine['profiles'].set('default', { session: ses })
  for (const id of [EXT, OTHER]) {
    engine['loaded'].set(`default:${id}`, { id, name: id === EXT ? 'Captions' : 'Other' })
    engine['manifests'].set(`default:${id}`, MANIFEST)
    engine['known'].set(`default:${id}`, { info: { id, name: id === EXT ? 'Captions' : 'Other' }, path: '/x', manifest: MANIFEST })
  }
  engine['tabMeta'].set(7, { profileId: 'default', win: {} })
  contents.set(7, { id: 7, isDestroyed: () => false, getURL: () => MEET, isAudioMuted: () => false, setAudioMuted: vi.fn(), mainFrame: { tab: 7 } })
  engine['configureExtensions']({ webStoreInstall: false, webStoreUpdates: 'manual', disabled: {}, tabCapture: { default: over.allowed ?? [EXT] }, tabCaptureOn: true })
  for (const id of over.lent ?? [EXT]) engine['activeTabs'].grant(id, 7, MEET)
  // The web contents of the page: an emitter, as the engine listens to it (its destruction, its navigations).
  const frameEvent = (url: string, session: unknown = ses, ids = { id: 40, processId: 11, routingId: 3 }) => ({ sender: Object.assign(new EventEmitter(), { id: ids.id, session, isDestroyed: () => false }), senderFrame: { url, processId: ids.processId, routingId: ids.routingId } })
  const held: { request?: Request; check?: (...args: unknown[]) => boolean; display?: DisplayHandler; displayOptions?: unknown } = {}
  const sessionHandlers = ses as unknown as Record<string, unknown>
  sessionHandlers['setPermissionRequestHandler'] = (handle: Request) => void (held.request = handle)
  sessionHandlers['setPermissionCheckHandler'] = (handle: (...args: unknown[]) => boolean) => void (held.check = handle)
  sessionHandlers['setDisplayMediaRequestHandler'] = (handle: DisplayHandler, options: unknown) => void ((held.display = handle), (held.displayOptions = options))
  engine['installPermissions'](ses, () => null, 'default')
  engine['installDisplayMedia'](ses)
  /** Whether the session lets this web contents ask for the screen. */
  const asks = (web: { id: number }, requestingUrl = CAPTURE_HELPER_URL): Promise<boolean> => new Promise((resolve) => held.request!(web, 'display-capture', resolve, { requestingUrl, isMainFrame: true }))
  /** What the display handler of the session answers to a request made from this frame. */
  const streams = (requestFrame: unknown): Promise<Answer> => new Promise((resolve) => held.display!({ frame: requestFrame, userGesture: false, videoRequested: true, audioRequested: true }, resolve))
  // What the main process sent to the page of the extension (its frame is 11.3): the chunks of sound, and the call to end its stream.
  const inbox: unknown[][] = []
  frames.set('11.3', { send: (...args) => void inbox.push(args) })
  /** A chunk of sound as the one function of the helper page's preload sends it: through the gate of the engine, from this frame. */
  const sendFrom = (contentsId: number, data: unknown, frame: Record<string, unknown> | null | undefined = helperMainFrame): void => {
    const gate = world.ipcOn.get(Channel.capturePcm)!
    // The frame is the main frame of its web contents unless a test says otherwise below.
    gate({ sender: { id: contentsId, mainFrame: frame ?? helperMainFrame }, senderFrame: frame }, data)
  }
  // The helper page, as the real one does: it asks for the screen (the permission, then the stream) and sends the sound.
  helperBehavior = async (made) => {
    if (!(await asks({ id: made.contentsId }))) throw new Error('the screen was refused to the helper page')
    if (!(await streams(helperFrame(made.contentsId)))) throw new Error('no stream was given to the helper page')
    sendFrom(made.contentsId, chunk(0))
  }
  const page = frameEvent(EXT_URL)
  const idFor = async (tab = 7): Promise<string> => (await handler(Channel.extTabCaptureId)(page, { targetTabId: tab })) as string
  /** The whole way a page takes: an identifier, the request to listen, the first chunk of the helper page. */
  const capture = async () => {
    const id = await idFor()
    return { id, format: await handler(Channel.extTabCaptureListen)(page, id) }
  }
  /** A request to listen whose helper page never begins: the capture is asked for and not made. */
  const pendingListen = async () => {
    helperBehavior = () => new Promise<void>(() => undefined)
    const id = await idFor()
    const answered = handler(Channel.extTabCaptureListen)(page, id) as Promise<unknown>
    const settled = answered.then(() => 'answered', (error: Error) => error.message)
    return { id, made: helpers.at(-1)!, settled }
  }
  return { engine, ses, frameEvent, page, held, asks, streams, idFor, capture, pendingListen, inbox, sendFrom }
}

afterEach(() => {
  contents.clear()
  frames.clear()
  helpers.length = 0
  helperBehavior = undefined
  world.ipcHandle.clear()
  vi.restoreAllMocks()
})

describe('the channels of a page of an extension', () => {
  it('serve the four calls on the channels of the interface list, and no other', async () => {
    await engineWith()
    for (const channel of [Channel.extTabCaptureId, Channel.extTabCaptureListen, Channel.extTabCaptureEnd, Channel.extTabCaptureList]) expect(world.ipcHandle.has(channel), channel).toBe(true)
    // The one call of the helper page is a message, answered with nothing: it is no call that asks.
    expect(world.ipcOn.has(Channel.capturePcm)).toBe(true)
    expect(world.ipcHandle.has(Channel.capturePcm)).toBe(false)
    expect(world.ipcHandle.has(Channel.extTabCapturePcm)).toBe(false)
    // What goes from the main process to the page, and what the person sends, are not served by the engine here.
    expect(world.ipcHandle.has(Channel.extTabCaptureStop)).toBe(false)
    expect(world.ipcHandle.has(Channel.stopTabCapture)).toBe(false)
  })

  it('hand an identifier to a page of the extension, that the page then listens with, and is answered with the format of the sound of the helper page of the profile', async () => {
    const { capture, ses, inbox } = await engineWith()
    const { id, format } = await capture()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(format).toEqual({ sampleRate: 48_000, channels: 1 })
    // One helper page, in the session of the profile of the tab, begun once.
    expect(helpers).toHaveLength(1)
    expect(helpers[0]!.session).toBe(ses)
    expect(helpers[0]!.starts).toBe(1)
    // The first chunk was handed to the frame of the page that listens, with the identifier of its claim, as the helper page sent it.
    const sounds = inbox.filter((message) => message[0] === Channel.extTabCapturePcm)
    expect(sounds).toHaveLength(1)
    expect(sounds[0]![1]).toBe(id)
    expect(new Uint8Array(sounds[0]![2] as ArrayBuffer)).toEqual(new Uint8Array(chunk(0)))
  })

  it('make no helper page for a profile that has no session left: the offer is refused in the words of the platform, with nothing thrown inside', async () => {
    const { engine, idFor, page } = await engineWith()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const id = await idFor()
    // The profile is still the one the frame belongs to, and has no session to make a page in.
    engine['profiles'].get = () => undefined
    await expect(Promise.resolve(handler(Channel.extTabCaptureListen)(page, id))).rejects.toThrow(TAB_CAPTURE_ERRORS.noHelper)
    expect(helpers).toEqual([])
    expect(warned).not.toHaveBeenCalledWith(expect.stringContaining('could not be made'), expect.anything())
  })

  it('make the helper page in the session of the profile, loaded with the secret that session answers to: its own, and no other', async () => {
    const { capture, ses } = await engineWith()
    await capture()
    expect(helpers[0]!.loadHeader).toBe(captureHelperLoadHeader(ses))
    expect(helpers[0]!.loadHeader).toMatch(/^x-lucium-page-load: [0-9a-f]{32}$/)
  })

  it('make no helper page in a session that does not serve it (the secret is the session\'s): the offer is refused, and the log says why', async () => {
    const { idFor, page } = await engineWith({ serves: false })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const id = await idFor()
    await expect(Promise.resolve(handler(Channel.extTabCaptureListen)(page, id))).rejects.toThrow(TAB_CAPTURE_ERRORS.noHelper)
    expect(helpers).toEqual([])
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('does not serve the helper page'))
  })

  it('take an identifier once', async () => {
    const { capture, page } = await engineWith()
    const { id } = await capture()
    await expect(Promise.resolve(handler(Channel.extTabCaptureListen)(page, id))).rejects.toThrow(TAB_CAPTURE_ERRORS.badIdentifier)
    expect(helpers).toHaveLength(1)
  })

  it('let the page that holds an identifier say it is over, and nobody else', async () => {
    const { page, frameEvent, engine, capture } = await engineWith()
    const { id } = await capture()
    // Another page of the same extension does not end it.
    await handler(Channel.extTabCaptureEnd)(frameEvent(EXT_URL, page.sender.session, { id: 41, processId: 12, routingId: 4 }), id)
    expect(engine['tabCaptures'].capturedBy(7)).toMatchObject({ extensionId: EXT })
    await handler(Channel.extTabCaptureEnd)(page, id)
    expect(engine['tabCaptures'].capturedBy(7)).toBeUndefined()
    expect(helpers[0]!.closed).toBe(1)
  })

  it('read the extension from the address of the frame, never from what the call says', async () => {
    // Only OTHER is allowed: a page of EXT that says it is OTHER is EXT, and is refused.
    const { page } = await engineWith({ allowed: [OTHER], lent: [OTHER] })
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7, extensionId: OTHER })).toThrow(TAB_CAPTURE_ERRORS.switchedOff)
  })

  it('refuse a frame that is not a page of an extension: a web page, the application, a frame that is gone', async () => {
    const { frameEvent } = await engineWith()
    for (const url of ['https://meet.example.com/', 'lucium://settings', 'file:///Users/jane/a.html', '']) {
      expect(() => handler(Channel.extTabCaptureId)(frameEvent(url), { targetTabId: 7 }), url).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    }
    expect(() => handler(Channel.extTabCaptureId)({ sender: { session: {}, id: 1 }, senderFrame: null }, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
  })

  it('refuse a frame inside a page of an extension, which may go to another document: the sound is handed to the document that asked, never to another', async () => {
    const { frameEvent, idFor } = await engineWith()
    const id = await idFor()
    const inner = frameEvent(EXT_URL)
    ;(inner.senderFrame as Record<string, unknown>)['parent'] = { url: EXT_URL }
    expect(() => handler(Channel.extTabCaptureId)(inner, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    expect(() => handler(Channel.extTabCaptureListen)(inner, id)).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    expect(() => handler(Channel.extTabCaptureEnd)(inner, id)).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    expect(() => handler(Channel.extTabCaptureList)(inner)).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    expect(helpers).toEqual([])
  })

  it('refuse a page of an extension that is not in the session of a profile (a private window, the interface)', async () => {
    const { frameEvent } = await engineWith()
    expect(() => handler(Channel.extTabCaptureId)(frameEvent(EXT_URL, { name: 'a private session' }), { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
  })

  it('read the profile from the session of the frame: the extension has no manifest in another profile', async () => {
    const { frameEvent, engine } = await engineWith()
    const work = new FakeProfileSession('persist:profile-work')
    engine['profiles'].set('work', { session: work })
    expect(() => handler(Channel.extTabCaptureId)(frameEvent(EXT_URL, work), { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.noPermission)
  })

  it('refuse while the person did not allow the extension, and tell the shell', async () => {
    const { page, engine } = await engineWith({ allowed: [] })
    const events: unknown[] = []
    engine['onTabCapture']((event: unknown) => events.push(event))
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.switchedOff)
    expect(events).toEqual([{ kind: 'refused', profileId: 'default', extensionId: EXT, name: 'Captions' }])
  })

  it('follow what the person allows: the engine is told by configureExtensions, per profile', async () => {
    const { page, engine } = await engineWith({ allowed: [] })
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toThrow()
    engine['configureExtensions']({ webStoreInstall: false, webStoreUpdates: 'manual', disabled: {}, tabCapture: { work: [EXT] }, tabCaptureOn: true })
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.switchedOff)
    engine['configureExtensions']({ webStoreInstall: false, webStoreUpdates: 'manual', disabled: {}, tabCapture: { default: [EXT] }, tabCaptureOn: true })
    expect(handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toBeTruthy()
  })

  it('follow the switch of the whole function: off, nothing is handed out', async () => {
    const { page, engine } = await engineWith()
    const config = { webStoreInstall: false, webStoreUpdates: 'manual', disabled: {}, tabCapture: { default: [EXT] } }
    engine['configureExtensions']({ ...config, tabCaptureOn: false })
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.featureOff)
    engine['configureExtensions']({ ...config, tabCaptureOn: true })
    expect(handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toBeTruthy()
  })

  it('refuse a tab the person did not hand over, and read the hand-over from the engine\'s own record', async () => {
    const { page } = await engineWith({ lent: [] })
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('refuse an extension that does not run in the profile (switched off), whatever its manifest says', async () => {
    const { page, engine } = await engineWith()
    engine['loaded'].delete(`default:${EXT}`)
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.noPermission)
  })

  it('refuse a tab that is not a tab of the profile: a private page, a tab of another profile', async () => {
    const { page, engine } = await engineWith()
    contents.set(8, { id: 8, isDestroyed: () => false, getURL: () => MEET, isAudioMuted: () => false, setAudioMuted: vi.fn(), mainFrame: {} })
    contents.set(9, { id: 9, isDestroyed: () => false, getURL: () => MEET, isAudioMuted: () => false, setAudioMuted: vi.fn(), mainFrame: {} })
    // 8 is a page the engine does not count as a tab (a private one, a panel); 9 is a tab of the profile `work`.
    engine['tabMeta'].set(9, { profileId: 'work', win: {} })
    engine['activeTabs'].grant(EXT, 8, MEET)
    engine['activeTabs'].grant(EXT, 9, MEET)
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 8 })).toThrow('No tab with id: 8.')
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 9 })).toThrow('No tab with id: 9.')
  })

  it('refuse a tab the lock hides, as the shell says', async () => {
    const { page, engine } = await engineWith()
    engine['hooks'] = { tabLocked: (tab: number) => tab === 7 }
    expect(() => handler(Channel.extTabCaptureId)(page, { targetTabId: 7 })).toThrow(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('answer the list of what the extension captures, for a page', async () => {
    const { page } = await engineWith()
    expect(handler(Channel.extTabCaptureList)(page)).toEqual([])
  })

  it('refuse a page whose frame the engine cannot name (the frame was replaced)', async () => {
    const { frameEvent } = await engineWith()
    const event = frameEvent(EXT_URL)
    ;(event as { senderFrame: unknown }).senderFrame = null
    expect(() => handler(Channel.extTabCaptureListen)(event, '00000000-0000-4000-8000-000000000000')).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
  })

  it('refuse an offer from a frame that is not a page of an extension, before any helper page is made', async () => {
    const { frameEvent, idFor } = await engineWith()
    const id = await idFor()
    expect(() => handler(Channel.extTabCaptureListen)(frameEvent('https://meet.example.com/'), id)).toThrow(TAB_CAPTURE_ERRORS.notWorkerOrPage)
    expect(helpers).toEqual([])
  })
})

describe('a capture that runs', () => {
  it('is silent for the person on the web contents of the tab, and the stream is made from its main frame', async () => {
    const { capture } = await engineWith()
    await capture()
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('is stopped by the person: the sound comes back, the helper page goes, the page is asked to end its stream, the tab has to be handed over again', async () => {
    const { engine, capture, inbox } = await engineWith()
    const { id } = await capture()
    expect(engine['stopTabCapture'](7)).toBe(true)
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
    expect(inbox.filter((message) => message[0] === Channel.extTabCaptureStop)).toEqual([[Channel.extTabCaptureStop, id]])
    expect(helpers[0]!.closed).toBe(1)
    expect(engine['activeTabs'].has(EXT, 7, MEET)).toBe(false)
    expect(engine['stopTabCapture'](7)).toBe(false)
  })

  it('ends when the person takes the permission back: the sound comes back, the helper page goes', async () => {
    const { engine, capture } = await engineWith()
    await capture()
    engine['configureExtensions']({ webStoreInstall: false, webStoreUpdates: 'manual', disabled: {}, tabCapture: {}, tabCaptureOn: true })
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
    expect(helpers[0]!.closed).toBe(1)
    expect(engine['stopTabCapture'](7)).toBe(false)
  })

  it('ends when the application quits: the sound comes back, the helper page goes', async () => {
    const { capture } = await engineWith()
    await capture()
    emitApp('will-quit')
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
    expect(helpers[0]!.closed).toBe(1)
  })

  it('ends when the tab goes to another origin: the extension no longer holds it', async () => {
    const { engine, capture } = await engineWith()
    await capture()
    contents.get(7)!['getURL'] = () => 'https://elsewhere.example.com/'
    engine['activeTabs'].navigated(7, 'https://elsewhere.example.com/')
    engine['tabCaptures'].targetNavigated(7, 'https://elsewhere.example.com/')
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
    expect(helpers[0]!.closed).toBe(1)
  })

  it('ends when the person switches the whole function off: the sound comes back', async () => {
    const { engine, capture } = await engineWith()
    await capture()
    engine['configureExtensions']({ webStoreInstall: false, webStoreUpdates: 'manual', disabled: {}, tabCapture: { default: [EXT] }, tabCaptureOn: false })
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
  })

  it('ends when the helper page goes by itself (its window closed, its process died): the hook the engine gave it ends the capture', async () => {
    const { engine, capture } = await engineWith()
    await capture()
    helpers[0]!.hooks.gone(helpers[0]!.contentsId)
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
    expect(engine['tabCaptures'].capturedBy(7)).toBeUndefined()
  })

  it('tells the shell that it began and that it ended, with the name of the extension', async () => {
    const { engine, capture } = await engineWith()
    const events: unknown[] = []
    engine['onTabCapture']((event: unknown) => events.push(event))
    await capture()
    engine['stopTabCapture'](7)
    expect(events).toEqual([
      { kind: 'started', tabNumber: 7, profileId: 'default', extensionId: EXT, name: 'Captions' },
      { kind: 'ended', tabNumber: 7, profileId: 'default', extensionId: EXT, name: 'Captions', muted: false }
    ])
  })
})

describe('the sound the helper page sends', () => {
  it('is judged and handed to the page that holds the claim, when it comes from the main frame of the helper page', async () => {
    const { capture, inbox, sendFrom } = await engineWith()
    const { id } = await capture()
    inbox.length = 0
    sendFrom(helpers[0]!.contentsId, chunk(1))
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.slice(0, 2)).toEqual([Channel.extTabCapturePcm, id])
  })

  it('is refused, with the reason in the log and nothing handed on, when it comes from anything but the main frame of a helper page at its own origin and address', async () => {
    const { capture, inbox, sendFrom, engine } = await engineWith()
    await capture()
    inbox.length = 0
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const made = helpers[0]!.contentsId
    const refused: Array<[string, number, Record<string, unknown> | null | undefined, string]> = [
      ['a tab', 7, helperMainFrame, 'no helper page'],
      ['the page of the extension', 40, { origin: `chrome-extension://${EXT}`, url: EXT_URL, parent: null }, 'no helper page'],
      ['a web contents nobody knows', 99_999, helperMainFrame, 'no helper page'],
      ['another origin of the scheme, in the helper page', made, { ...helperMainFrame, origin: 'lucium-ui://extensions' }, 'origin'],
      ['a web origin in the helper page', made, { ...helperMainFrame, origin: 'https://evil.example' }, 'origin'],
      ['another address in the helper page', made, { ...helperMainFrame, url: `${CAPTURE_HELPER_URL}x` }, 'address'],
      ['a frame inside the helper page', made, { ...helperMainFrame, parent: {} }, 'main frame'],
      ['no frame', made, null, 'no sender frame']
    ]
    for (const [name, contentsId, frame, why] of refused) {
      warned.mockClear()
      sendFrom(contentsId, chunk(1), frame)
      expect(inbox, name).toEqual([])
      expect(warned, name).toHaveBeenCalledWith(expect.stringContaining(why))
    }
    // A message with no sender frame at all (Electron may hand none).
    warned.mockClear()
    world.ipcOn.get(Channel.capturePcm)!({ sender: { id: made, mainFrame: helperMainFrame }, senderFrame: undefined }, chunk(1))
    expect(inbox).toEqual([])
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('no sender frame'))
    // A frame that is not the main frame of its web contents, though it says it has no parent.
    warned.mockClear()
    const gate = world.ipcOn.get(Channel.capturePcm)!
    gate({ sender: { id: made, mainFrame: { ...helperMainFrame } }, senderFrame: helperMainFrame }, chunk(1))
    expect(inbox).toEqual([])
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('main frame'))
    // The capture itself was not touched by what was refused.
    expect(engine['tabCaptures'].capturedBy(7)).toMatchObject({ extensionId: EXT })
  })

  it('is refused when the frame is gone under the message, and says so', async () => {
    const { capture, inbox } = await engineWith()
    await capture()
    inbox.length = 0
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const gate = world.ipcOn.get(Channel.capturePcm)!
    const event = {
      sender: { id: helpers[0]!.contentsId, mainFrame: helperMainFrame },
      get senderFrame(): unknown {
        throw new Error('Render frame was disposed')
      }
    }
    gate(event, chunk(1))
    expect(inbox).toEqual([])
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('is gone'), 'Render frame was disposed')
  })

  it('is judged: a chunk that breaks a rule ends the capture, as the engine of the captures says', async () => {
    const { capture, inbox, sendFrom, engine } = await engineWith()
    await capture()
    inbox.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    sendFrom(helpers[0]!.contentsId, chunk(0))
    expect(engine['tabCaptures'].capturedBy(7)).toBeUndefined()
    expect(inbox.map((message) => message[0])).toEqual([Channel.extTabCaptureStop])
    expect(helpers[0]!.closed).toBe(1)
  })

  it('stops being taken the moment the capture ends: the destroyed helper page sends nothing that goes anywhere', async () => {
    const { capture, inbox, sendFrom, engine } = await engineWith()
    await capture()
    engine['stopTabCapture'](7)
    inbox.length = 0
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    sendFrom(helpers[0]!.contentsId, chunk(1))
    expect(inbox).toEqual([])
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('no helper page'))
  })

  it('ends the capture when the page that listens is gone: nobody is left to hand the sound to', async () => {
    const { capture, sendFrom, engine } = await engineWith()
    await capture()
    frames.delete('11.3')
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    sendFrom(helpers[0]!.contentsId, chunk(1))
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('could not be handed to the page'), expect.objectContaining({ message: 'the page that listens is gone' }))
    expect(engine['tabCaptures'].capturedBy(7)).toBeUndefined()
    expect(helpers[0]!.closed).toBe(1)
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
  })
})

describe('the screen, and who may ask for it', () => {
  it('is never given to a page of an extension, whether or not it holds an identifier: not even while its capture is being made', async () => {
    const { asks, idFor, pendingListen } = await engineWith()
    expect(await asks({ id: 40 }, EXT_URL)).toBe(false)
    await idFor()
    expect(await asks({ id: 40 }, EXT_URL)).toBe(false)
    const { made } = await pendingListen()
    expect(await asks({ id: 40 }, EXT_URL)).toBe(false)
    // The one page that holds it is the helper page made for the capture.
    expect(await asks({ id: made.contentsId })).toBe(true)
  })

  it('is given to the helper page, for the one request that its capture is made for: then the identifier is used up', async () => {
    const { asks, streams, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    expect(await asks({ id: made.contentsId })).toBe(true)
    const given = await streams(helperFrame(made.contentsId))
    // The sound of the tab, and a picture that is the helper page's own: nothing of the tab is ever a picture.
    expect(given?.audio).toBe(contents.get(7)!['mainFrame'])
    expect(given?.video).toEqual(expect.objectContaining({ url: CAPTURE_HELPER_URL, contents: { id: made.contentsId } }))
    expect(contents.get(7)!['mainFrame']).not.toBe(given?.video)
    expect(await asks({ id: made.contentsId })).toBe(false)
    expect(await streams(helperFrame(made.contentsId))).toBeNull()
  })

  it('is not given to a page that is not the helper page: the page of the extension, another extension\'s, a page of the web, a page nobody knows', async () => {
    const { asks, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    for (const web of [{ id: 40 }, { id: 41 }, { id: 7 }, { id: made.contentsId + 1 }, { id: 99999 }]) expect(await asks(web, CAPTURE_HELPER_URL), String(web.id)).toBe(false)
    expect(await asks({ id: 40 }, `chrome-extension://${OTHER}/offscreen.html`)).toBe(false)
    expect(await asks({ id: 7 }, MEET)).toBe(false)
    expect(await asks({ id: made.contentsId })).toBe(true)
  })

  it('is not given to a page that asks without a web contents (a request that names none)', async () => {
    const { held, pendingListen } = await engineWith()
    await pendingListen()
    expect(await new Promise<boolean>((resolve) => held.request!(null, 'display-capture', resolve, { requestingUrl: CAPTURE_HELPER_URL, isMainFrame: true }))).toBe(false)
  })

  it('is not given to the helper page of the profile when it asks through the session of another: a private window, a container', async () => {
    const { engine, pendingListen, held } = await engineWith()
    const { made } = await pendingListen()
    // The same contents, asking through the handlers of a session the engine does not know as a profile's.
    const other: { request?: Request; display?: DisplayHandler } = {}
    const stranger = { extensions: { getExtension: () => undefined }, setPermissionRequestHandler: (handle: Request) => void (other.request = handle), setPermissionCheckHandler: () => undefined, setDisplayMediaRequestHandler: (handle: DisplayHandler) => void (other.display = handle), on: () => undefined }
    engine['installPermissions'](stranger, () => null, 'default')
    engine['installDisplayMedia'](stranger)
    expect(await new Promise<boolean>((resolve) => other.request!({ id: made.contentsId }, 'display-capture', resolve, { requestingUrl: CAPTURE_HELPER_URL, isMainFrame: true }))).toBe(false)
    expect(await new Promise<Answer>((resolve) => other.display!({ frame: helperFrame(made.contentsId) }, resolve))).toBeNull()
    // The helper page of the profile still holds what it was made for.
    expect(await new Promise<boolean>((resolve) => held.request!({ id: made.contentsId }, 'display-capture', resolve, { requestingUrl: CAPTURE_HELPER_URL, isMainFrame: true }))).toBe(true)
  })

  it('is not held by the check of a permission: for no page', async () => {
    const { held, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    expect(held.check!({ id: made.contentsId }, 'display-capture', CAPTURE_HELPER_URL, { requestingUrl: CAPTURE_HELPER_URL, isMainFrame: true })).toBe(false)
    expect(held.check!({ id: 40 }, 'display-capture', EXT_URL, { requestingUrl: EXT_URL, isMainFrame: true })).toBe(false)
  })

  it('gives the helper page nothing but the screen: the camera, the microphone and the rest are refused it', async () => {
    const { held, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'captured-surface-control', 'openExternal']) {
      const granted = await new Promise<boolean>((resolve) => held.request!({ id: made.contentsId }, permission, resolve, { requestingUrl: CAPTURE_HELPER_URL, isMainFrame: true }))
      expect(granted, permission).toBe(false)
    }
  })

  it('stops being held the moment the capture ends: the helper page asks for nothing more', async () => {
    const { asks, engine, pendingListen } = await engineWith()
    const { made, settled } = await pendingListen()
    expect(await asks({ id: made.contentsId })).toBe(true)
    engine['tabCaptures'].tabGone(7)
    expect(await asks({ id: made.contentsId })).toBe(false)
    expect(await settled).toContain('ended before the sound came')
  })

  it('refuses without a trace of a stream when the person switched the capture off after the helper page was made', async () => {
    const { streams, asks, engine, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    engine['configureExtensions']({ webStoreInstall: false, webStoreUpdates: 'manual', disabled: {}, tabCapture: {}, tabCaptureOn: true })
    expect(await asks({ id: made.contentsId })).toBe(false)
    expect(await streams(helperFrame(made.contentsId))).toBeNull()
    expect(contents.get(7)!['setAudioMuted']).not.toHaveBeenCalled()
  })
})

describe('the stream the display handler gives', () => {
  it('is given to the main frame of the helper page, and to no other frame of it', async () => {
    const { streams, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    expect(await streams({ ...helperFrame(made.contentsId), parent: { url: CAPTURE_HELPER_URL } })).toBeNull()
    // The refusal of a frame inside the page did not use up what the main frame holds.
    expect((await streams(helperFrame(made.contentsId)))?.audio).toBe(contents.get(7)!['mainFrame'])
  })

  it('is given to no page of an extension, not even the list of the screens: the ordinary handler is never asked', async () => {
    const { streams, pendingListen } = await engineWith()
    await pendingListen()
    expect(await streams(pageFrame)).toBeNull()
    expect(await streams({ ...pageFrame, url: `chrome-extension://${OTHER}/x.html`, contents: { id: 41 } })).toBeNull()
    // Not even a page of an extension that is a helper page by its web contents: the address decides first.
    expect(await streams({ ...pageFrame, contents: { id: 500 } })).toBeNull()
    expect(contents.get(7)!['setAudioMuted']).not.toHaveBeenCalled()
  })

  it('is given to no frame of a web page, whatever claim an extension holds: the ordinary handler answers them, and the captures are not even asked', async () => {
    const { streams, pendingListen } = await engineWith()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await pendingListen()
    expect(await streams({ url: 'https://meet.example.com/', parent: null, contents: { id: 41 } })).toBeNull()
    expect(contents.get(7)!['setAudioMuted']).not.toHaveBeenCalled()
    // A page that is no helper page is none of the captures' business: nothing was asked of them, so nothing was said of a claim.
    expect(warned).not.toHaveBeenCalledWith(expect.stringContaining('holds no claim it may use'))
  })

  it('is given to no frame that is gone (null), or that cannot be read, without answering as a page of the web', async () => {
    const { streams } = await engineWith()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unreadable = {
      get url(): string {
        throw new Error('Render frame was disposed')
      },
      processId: 1,
      routingId: 1
    }
    await expect(streams(null)).resolves.toBeNull()
    await expect(streams(unreadable)).resolves.toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read, so it is refused'), 'Render frame was disposed')
  })

  it('keeps the system picker off, as before', async () => {
    const { held } = await engineWith()
    expect(held.displayOptions).toEqual({ useSystemPicker: false })
  })

  it('ends the capture when the stream cannot be handed to the helper page: the sound comes back, the helper page goes', async () => {
    const { held, pendingListen } = await engineWith()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { made, settled } = await pendingListen()
    held.display!({ frame: helperFrame(made.contentsId), userGesture: false, videoRequested: true, audioRequested: true }, () => {
      throw new Error('the frame is gone')
    })
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenNthCalledWith(1, true)
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenNthCalledWith(2, false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be handed to the helper page'), 'the frame is gone')
    expect(made.closed).toBe(1)
    expect(await settled).toContain('ended before the sound came')
  })
})

describe('the calls of a service worker of an extension', () => {
  /** A worker of the extension, started in the session of its profile. */
  function workerOf(scope: string, ses: FakeProfileSession, engine: Record<string, any>) {
    const handlers = new Map<string, Handler>()
    const worker = { scope, isDestroyed: () => false, ipc: { handle: (channel: string, listener: Handler) => void handlers.set(channel, listener) }, send: vi.fn() }
    ;(ses.serviceWorkers as unknown as { getWorkerFromVersionID: (id: number) => unknown }).getWorkerFromVersionID = () => worker
    engine['installShims'](ses, 'default')
    ses.serviceWorkers.emit('running-status-changed', { runningStatus: 'starting', versionId: 5 })
    return handlers
  }

  it('are served on the two channels a worker may use, as the extension the worker belongs to', async () => {
    const { engine, ses } = await engineWith()
    const handlers = workerOf(`chrome-extension://${EXT}/`, ses, engine)
    // No offer, no end: a worker has no page to give a stream to.
    expect([...handlers.keys()].filter((channel) => channel.includes('tab-capture')).sort()).toEqual([Channel.extTabCaptureId, Channel.extTabCaptureList].sort())
    expect(handlers.get(Channel.extTabCaptureId)!({}, { targetTabId: 7 })).toMatch(/^[0-9a-f-]{36}$/)
    expect(handlers.get(Channel.extTabCaptureList)!({})).toEqual([])
  })

  it('cannot say it is another extension: the worker of EXT, allowed nowhere, is refused whatever the call names', async () => {
    const { engine, ses } = await engineWith({ allowed: [OTHER], lent: [OTHER] })
    const handlers = workerOf(`chrome-extension://${EXT}/`, ses, engine)
    expect(() => handlers.get(Channel.extTabCaptureId)!({}, { targetTabId: 7, extensionId: OTHER })).toThrow(TAB_CAPTURE_ERRORS.switchedOff)
  })

  it('ends what its page holds when the page is gone: the helper page goes with it', async () => {
    const { engine, pendingListen } = await engineWith()
    const { made, settled } = await pendingListen()
    expect(engine['tabCaptures'].isHelper(made.contentsId)).toBe(true)
    engine['contextGone']({ context: 'frame:40' })
    expect(engine['tabCaptures'].isHelper(made.contentsId)).toBe(false)
    expect(made.closed).toBe(1)
    expect(await settled).toContain('ended before the sound came')
  })

  it('ends what its page holds when its web contents is destroyed, reloaded or gone elsewhere: the engine listens to the page that called', async () => {
    for (const end of [(sender: EventEmitter) => sender.emit('destroyed'), (sender: EventEmitter) => sender.emit('render-process-gone'), (sender: EventEmitter) => sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })]) {
      const { engine, pendingListen, page } = await engineWith()
      const { made } = await pendingListen()
      expect(engine['tabCaptures'].isHelper(made.contentsId)).toBe(true)
      end(page.sender)
      expect(engine['tabCaptures'].isHelper(made.contentsId)).toBe(false)
      expect(made.closed).toBe(1)
    }
  })

  it('ends what its extension holds when the extension is unloaded from the profile', async () => {
    const { engine, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    engine['contextGone']({ extensionId: EXT, profileId: 'default' })
    expect(engine['tabCaptures'].isHelper(made.contentsId)).toBe(false)
    expect(made.closed).toBe(1)
  })

  it('ends what is captured from a tab when the tab is closed', async () => {
    const { engine, pendingListen } = await engineWith()
    const { made } = await pendingListen()
    for (const listener of engine['tabClosedListeners']) listener(7)
    expect(engine['tabCaptures'].isHelper(made.contentsId)).toBe(false)
    expect(made.closed).toBe(1)
  })
})

// ---- the lock: the real methods of the window of the shell (Browser), over a real state and the real reducer, wired to the real engine ----

const { Browser } = await import('../shell/browser')
const { setLockService } = await import('../lock-service')
const { fakeBrowser, methodsOf } = await import('../shell/browser-fake.test-support')
const { createInitialState, reduce } = await import('@shared/sidebar')
const shell = methodsOf(Browser.prototype)

afterEach(() => setLockService(null))

describe('the lock of a space or of the application', () => {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

  /** A window of the shell with two spaces and a tab in the second one (the tab the extension captures, number 7), wired to the engine the way `Browser.start` wires it. */
  async function lockedWorld() {
    const world = await engineWith()
    let state = reduce(createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
    const [home, work] = state.spaces.map((space) => space.id) as [string, string]
    state = reduce(state, { type: 'tab/open', url: MEET, spaceId: work, background: true } as never, ctx)
    const tab = state.tabs.find((item) => item.spaceId === work)!
    // The engine knows the page of the tab by its number.
    world.engine['pages'].set(tab.id, { liveContents: () => contents.get(7) })
    const locked: string[] = []
    let app = false
    let changed: () => void = () => undefined
    setLockService({
      isAppLocked: () => app,
      isSpaceLocked: (spaceId: string) => locked.includes(spaceId),
      lockedSpaces: () => locked,
      view: () => ({ appLocked: app, lockedSpaces: locked }),
      subscribe: (listener: () => void) => {
        changed = listener
        return () => undefined
      }
    } as never)
    const group = new Set<unknown>()
    const pages = new Map<string, unknown>([[tab.id, {}]])
    // Only what the shell hands the engine is real: the rest of the engine is not asked here.
    const real = new Set(['setExtensionTabHooks', 'reconsiderTabCaptures', 'pageIdOfTabNumber'])
    const engine = new Proxy(world.engine, { get: (target, prop) => (real.has(String(prop)) ? (target[prop as string] as (...args: unknown[]) => unknown).bind(target) : () => undefined) })
    const fake = fakeBrowser({
      engine,
      store: { get: () => state, subscribe: () => () => undefined, root: () => ({ get: () => state }) },
      group,
      pages,
      ownsPage: (id: string) => pages.has(id),
      ownerOf: (id: string) => shell['ownerOf']!.call(fake.self, id),
      isTabLocked: (item: unknown) => shell['isTabLocked']!.call(fake.self, item),
      onLockChange: () => shell['onLockChange']!.call(fake.self),
      isPrivate: () => false,
      isSecondary: () => false,
      gates: { gate: () => undefined }
    })
    group.add(fake.self)
    shell['start']!.call(fake.self)
    return {
      ...world,
      home,
      work,
      /** The page of the tab is no window's any more (being made, or put away): no window can say what space it is in. */
      orphan: () => pages.clear(),
      lockSpace: (spaceId: string) => {
        locked.push(spaceId)
        changed()
      },
      lockApp: () => {
        app = true
        changed()
      },
      unlock: () => {
        app = false
        locked.length = 0
        changed()
      }
    }
  }

  it('refuses a tab of a locked space, and every tab while the application is locked, with the words of the extension platform: the shell tells the engine', async () => {
    const world = await lockedWorld()
    const ask = () => handler(Channel.extTabCaptureId)(world.page, { targetTabId: 7 })
    expect(typeof ask()).toBe('string')
    world.lockSpace(world.work)
    expect(() => ask()).toThrow(TAB_CAPTURE_ERRORS.notInvoked)
    world.unlock()
    expect(typeof ask()).toBe('string')
    world.lockApp()
    expect(() => ask()).toThrow(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('refuses a tab no window can place while the application is locked, and not otherwise: the lock of the application is the one that is certain', async () => {
    const world = await lockedWorld()
    world.orphan()
    const ask = () => handler(Channel.extTabCaptureId)(world.page, { targetTabId: 7 })
    expect(typeof ask()).toBe('string')
    world.lockSpace(world.work)
    expect(typeof ask()).toBe('string')
    world.lockApp()
    expect(() => ask()).toThrow(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('does not refuse a tab for the lock of another space', async () => {
    const world = await lockedWorld()
    world.lockSpace(world.home)
    expect(typeof handler(Channel.extTabCaptureId)(world.page, { targetTabId: 7 })).toBe('string')
  })

  it('ends a capture that runs when its space is locked: the sound comes back, the page is asked to end its stream, the helper page goes, the tab has to be handed over again', async () => {
    const world = await lockedWorld()
    await world.capture()
    world.inbox.length = 0
    world.lockSpace(world.work)
    expect(world.engine['tabCaptures'].capturedBy(7)).toBeUndefined()
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
    expect(world.inbox.map((message) => message[0])).toEqual([Channel.extTabCaptureStop])
    expect(helpers[0]!.closed).toBe(1)
  })

  it('ends a capture that runs when the application is locked, whichever tab it is', async () => {
    const world = await lockedWorld()
    await world.capture()
    world.lockApp()
    expect(world.engine['tabCaptures'].capturedBy(7)).toBeUndefined()
    expect(contents.get(7)!['setAudioMuted']).toHaveBeenLastCalledWith(false)
    expect(helpers[0]!.closed).toBe(1)
  })

  it('leaves a capture that runs alone when the lock is another space\'s', async () => {
    const world = await lockedWorld()
    await world.capture()
    world.lockSpace(world.home)
    expect(world.engine['tabCaptures'].capturedBy(7)).toMatchObject({ extensionId: EXT })
    expect(helpers[0]!.closed).toBe(0)
  })
})
