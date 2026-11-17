// The sound of a tab in a page of an extension: `navigator.mediaDevices.getUserMedia` with `chromeMediaSource: 'tab'` and an identifier of Lucium's. The function the
// preload injects is run for real, against a made-up `navigator.mediaDevices`, a made-up track generator and a made-up bridge: the page asks the main process to listen, the
// chunks of sound the main process hands it are played into a track, and the end of the stream is told to the main process. Any other call of `getUserMedia` goes through as
// it was, but in an offscreen document, where Electron 45 stops on a request for media: it is refused with a message.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc-channels'

const contextBridge = { exposeInMainWorld: vi.fn(), executeInMainWorld: vi.fn() }
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const CLAIM = '0f8fad5b-d9cb-469f-a165-70867728950e'
const FORMAT = { sampleRate: 48_000, channels: 1 }
const UNAVAILABLE = 'Lucium: media capture is not available in an offscreen document (Electron 45 stops on it): use a popup or an options page'
const proc = process as unknown as { type?: string; contextIsolated?: boolean }
const before = { type: proc.type, isolated: proc.contextIsolated }
const g = globalThis as Record<string, any>

/** A chunk of sound as the main process hands it over (shared/tab-capture-pcm.ts): four integers, then the planes. 20 ms of mono at 48 kHz unless said. */
function chunk(seq: number, over: { rate?: number; channels?: number; frames?: number; value?: number } = {}): ArrayBuffer {
  const rate = over.rate ?? 48_000
  const channels = over.channels ?? 1
  const frames = over.frames ?? 960
  const buffer = new ArrayBuffer(16 + channels * frames * 4)
  const view = new DataView(buffer)
  for (const [at, value] of [seq, rate, channels, frames].entries()) view.setUint32(at * 4, value, true)
  new Float32Array(buffer, 16).fill(over.value ?? 0.25)
  return buffer
}

/** The track a page gets, as Chromium makes one: `stop` makes it end without an `ended` event, as the specification says. */
class FakeTrack extends EventTarget {
  stopped = false
  constructor(readonly kind: 'audio' | 'video') {
    super()
  }
  stop(): void {
    this.stopped = true
  }
  clone(): FakeTrack {
    return new FakeTrack(this.kind)
  }
  /** The browser ends it by itself (the tab closed). */
  end(): void {
    this.dispatchEvent(new Event('ended'))
  }
}

/** What is written into a generator: the samples of one chunk, as `AudioData` holds them. */
class FakeAudioData {
  static made: FakeAudioData[] = []
  closed = 0
  constructor(readonly init: { format: string; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array }) {
    FakeAudioData.made.push(this)
  }
  close(): void {
    this.closed++
  }
}

/** `MediaStreamTrackGenerator`: a track with a writable side. `failWrite` makes the next writes reject. */
class FakeGenerator extends FakeTrack {
  static made: FakeGenerator[] = []
  static failWrite: Error | null = null
  readonly written: FakeAudioData[] = []
  readonly writable = {
    getWriter: () => ({
      write: (audio: FakeAudioData): Promise<void> => {
        if (FakeGenerator.failWrite) return Promise.reject(FakeGenerator.failWrite)
        this.written.push(audio)
        return Promise.resolve()
      }
    })
  }
  constructor(readonly init: { kind: string }) {
    super('audio')
    FakeGenerator.made.push(this)
  }
  override clone(): FakeTrack {
    return new FakeTrack('audio')
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[] = []) {}
  getVideoTracks = (): FakeTrack[] => this.tracks.filter((track) => track.kind === 'video')
  getAudioTracks = (): FakeTrack[] => this.tracks.filter((track) => track.kind === 'audio')
}

/** The `navigator.mediaDevices` of a page, over a prototype as the real one: the wrapper replaces `getUserMedia` there. */
class FakeMediaDevices {
  native = vi.fn(async (_constraints?: unknown) => 'the native stream')
  nativeDisplay = vi.fn(async (_constraints?: unknown) => 'the native screen')
  getUserMedia(this: FakeMediaDevices, constraints?: unknown): Promise<unknown> {
    return this.native(constraints)
  }
  getDisplayMedia(this: FakeMediaDevices, constraints?: unknown): Promise<unknown> {
    return this.nativeDisplay(constraints)
  }
}

/** A page of its own: the wrapper replaces functions on the prototype, which a page of another test must not inherit. */
const freshDevices = (): FakeMediaDevices => new (class extends FakeMediaDevices {})()

/** `navigator`, over a prototype of its own for the old names. */
const navigatorOf = (devices: FakeMediaDevices) => {
  const old = vi.fn()
  const Navigator = class {
    mediaDevices = devices
    getUserMedia(...args: unknown[]): void {
      old('getUserMedia', ...args)
    }
    webkitGetUserMedia(...args: unknown[]): void {
      old('webkitGetUserMedia', ...args)
    }
  }
  return { navigator: new Navigator(), old }
}

interface Bridge {
  listen: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  onStop: ReturnType<typeof vi.fn>
  onPcm: ReturnType<typeof vi.fn>
  stopWith: (id: string) => void
  /** The main process hands a chunk to this page. */
  sound: (id: string, data: unknown) => void
}

function makeBridge(over: { listen?: (id: string) => Promise<unknown>; end?: () => Promise<void> } = {}): Bridge {
  let stop: (id: string) => void = () => undefined
  let pcm: (id: string, data: unknown) => void = () => undefined
  return {
    listen: vi.fn(over.listen ?? (async () => FORMAT)),
    end: vi.fn(over.end ?? (async () => undefined)),
    onStop: vi.fn((listener: (id: string) => void) => void (stop = listener)),
    onPcm: vi.fn((listener: (id: string, data: unknown) => void) => void (pcm = listener)),
    stopWith: (id) => stop(id),
    sound: (id, data) => pcm(id, data)
  }
}

function stubWeb(devices: FakeMediaDevices, insertable: boolean | 'without AudioData' = true): ReturnType<typeof navigatorOf> {
  const made = navigatorOf(devices)
  vi.stubGlobal('navigator', made.navigator)
  vi.stubGlobal('MediaStream', FakeStream)
  if (insertable) {
    vi.stubGlobal('MediaStreamTrackGenerator', FakeGenerator)
    if (insertable === true) vi.stubGlobal('AudioData', FakeAudioData)
  }
  return made
}

/** The page of an extension, isolated (a popup, an options page): the function the preload injects, run for real in its first pass. */
async function pageWith(devices: FakeMediaDevices, bridge: Bridge | null, manifest: Record<string, unknown> = { manifest_version: 3, permissions: ['tabCapture'] }, insertable: boolean | 'without AudioData' = true) {
  vi.resetModules()
  g['__luciumBridged'] = undefined
  g['__luciumTabAudio'] = undefined
  contextBridge.executeInMainWorld.mockReset()
  contextBridge.executeInMainWorld.mockImplementation((script: { args?: unknown[] }) => (script.args === undefined ? true : undefined))
  proc.type = undefined
  proc.contextIsolated = true
  vi.stubGlobal('location', { href: `chrome-extension://${ID}/popup.html` })
  const made = stubWeb(devices, insertable)
  await import('./extension-shims')
  const call = contextBridge.executeInMainWorld.mock.calls.map(([script]) => script).find((script) => script.args !== undefined)
  g['chrome'] = { runtime: { id: ID, getManifest: () => manifest, onConnect: { addListener: vi.fn() } }, tabs: {}, storage: {} }
  g['__luciumShim'] = { call: vi.fn(async () => undefined), onEvent: vi.fn(), ...(bridge ? { tabCapture: bridge } : {}) }
  call.func(...call.args)
  return { devices, ...made }
}

beforeEach(() => {
  ipcRenderer.invoke.mockReset()
  ipcRenderer.on.mockReset()
  FakeGenerator.made.length = 0
  FakeGenerator.failWrite = null
  FakeAudioData.made.length = 0
})
afterEach(() => {
  proc.type = before.type
  proc.contextIsolated = before.isolated
  delete g['chrome']
  delete g['__luciumShim']
  delete g['__luciumTabAudio']
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const tabAudio = (id: string = CLAIM) => ({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } } })

describe('getUserMedia with the sound of a tab', () => {
  it('asks the main process to listen with the identifier, and hands the page a stream of one audio track, made of what is played into a generator', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    const stream = (await devices.getUserMedia(tabAudio())) as FakeStream
    expect(bridge.listen).toHaveBeenCalledExactlyOnceWith(CLAIM)
    expect(FakeGenerator.made).toHaveLength(1)
    expect(FakeGenerator.made[0]!.init).toEqual({ kind: 'audio' })
    expect(stream.tracks).toEqual([FakeGenerator.made[0]])
    expect(stream.getVideoTracks()).toEqual([])
    expect(stream.getAudioTracks()).toHaveLength(1)
  })

  it('never asks the browser for a stream itself: not for the screen, not for a device', async () => {
    const { devices } = await pageWith(freshDevices(), makeBridge())
    await devices.getUserMedia(tabAudio())
    expect(devices.native).not.toHaveBeenCalled()
    expect(devices.nativeDisplay).not.toHaveBeenCalled()
  })

  it('plays what the main process hands it into the track, planar, with the time of each piece counted from the start, after a jitter buffer of 40 ms', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    await devices.getUserMedia(tabAudio())
    const generator = FakeGenerator.made[0]!
    bridge.sound(CLAIM, chunk(0))
    // 20 ms are kept: the buffer is smoothing the jitter of the messages.
    expect(generator.written).toEqual([])
    bridge.sound(CLAIM, chunk(1, { value: 0.5 }))
    expect(generator.written).toHaveLength(2)
    bridge.sound(CLAIM, chunk(2, { value: 0.75 }))
    expect(generator.written).toHaveLength(3)
    expect(generator.written.map((audio) => audio.init.timestamp)).toEqual([0, 20_000, 40_000])
    expect(generator.written[0]!.init).toMatchObject({ format: 'f32-planar', sampleRate: 48_000, numberOfFrames: 960, numberOfChannels: 1 })
    expect([...generator.written[1]!.init.data.slice(0, 3)]).toEqual([0.5, 0.5, 0.5])
    expect(generator.written[2]!.init.data).toHaveLength(960)
    // Each is closed once it is played.
    await Promise.resolve()
    await Promise.resolve()
    expect(generator.written.map((audio) => audio.closed)).toEqual([1, 1, 1])
    expect(FakeAudioData.made).toHaveLength(3)
  })

  it('keeps the chunks that come before its question is answered: the first ones may arrive first', async () => {
    const bridge = makeBridge({
      listen: async (id) => {
        bridge.sound(id, chunk(0))
        bridge.sound(id, chunk(1))
        return FORMAT
      }
    })
    const { devices } = await pageWith(freshDevices(), bridge)
    await devices.getUserMedia(tabAudio())
    expect(FakeGenerator.made[0]!.written.map((audio) => audio.init.timestamp)).toEqual([0, 20_000])
  })

  it('reads stereo, and a rate that is not 48 kHz, as the chunk says', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    await devices.getUserMedia(tabAudio())
    bridge.sound(CLAIM, chunk(0, { rate: 44_100, channels: 2, frames: 2205 }))
    const generator = FakeGenerator.made[0]!
    expect(generator.written).toHaveLength(1)
    expect(generator.written[0]!.init).toMatchObject({ sampleRate: 44_100, numberOfChannels: 2, numberOfFrames: 2205 })
    expect(generator.written[0]!.init.data).toHaveLength(4410)
  })

  it('ignores a chunk that is not what the main process sends: not bytes, shorter than its header, a rate or channels out of range, a length that is not its header\'s', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    await devices.getUserMedia(tabAudio())
    const generator = FakeGenerator.made[0]!
    const tooLong = chunk(0, { frames: 10 }).slice(0, 16 + 39)
    for (const wrong of [undefined, null, 'abc', {}, new Uint8Array(chunk(0)), new ArrayBuffer(8), chunk(0, { rate: 1_000 }), chunk(0, { rate: 200_000 }), chunk(0, { channels: 3 }), chunk(0, { channels: 0 }), chunk(0, { frames: 0 }), tooLong]) bridge.sound(CLAIM, wrong)
    // Enough good ones to leave the buffer: not one of the above was kept.
    bridge.sound(CLAIM, chunk(1))
    bridge.sound(CLAIM, chunk(2))
    expect(generator.written).toHaveLength(2)
  })

  it('ignores the sound of a capture it does not hold: another identifier, one that ended', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    await devices.getUserMedia(tabAudio())
    const generator = FakeGenerator.made[0]!
    for (const id of ['another-identifier', '', '1f8fad5b-d9cb-469f-a165-70867728950e']) {
      bridge.sound(id, chunk(0))
      bridge.sound(id, chunk(1))
    }
    expect(generator.written).toEqual([])
    generator.stop()
    bridge.sound(CLAIM, chunk(2))
    bridge.sound(CLAIM, chunk(3))
    expect(generator.written).toEqual([])
  })

  it('does not play after its stream is over: the chunks that are on the way are dropped', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    const stream = (await devices.getUserMedia(tabAudio())) as FakeStream
    bridge.sound(CLAIM, chunk(0))
    stream.getAudioTracks()[0]!.stop()
    const queued = FakeGenerator.made[0]!
    bridge.sound(CLAIM, chunk(1))
    bridge.sound(CLAIM, chunk(2))
    expect(queued.written).toEqual([])
    // What was kept for the buffer when the stream ended is let go, not played: the first chunk was kept, and closed.
    expect(FakeAudioData.made).toHaveLength(1)
    expect(FakeAudioData.made[0]!.closed).toBe(1)
  })

  it('does not ask for the picture: a request for it, with the sound or alone, is refused and nothing is asked', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    const ours = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: CLAIM } }
    for (const constraints of [{ video: ours }, { audio: ours, video: ours }, { audio: ours, video: true }, { audio: ours, video: {} }]) {
      await expect(devices.getUserMedia(constraints)).rejects.toThrow('Lucium: only the sound of a tab can be captured, not its picture.')
    }
    expect(bridge.listen).not.toHaveBeenCalled()
    expect(FakeGenerator.made).toEqual([])
    expect(devices.native).not.toHaveBeenCalled()
  })

  it('takes `video: false` for what it is: no picture asked for', async () => {
    const { devices } = await pageWith(freshDevices(), makeBridge())
    await expect(devices.getUserMedia({ ...tabAudio(), video: false })).resolves.toBeInstanceOf(FakeStream)
  })

  it('fails with the reason the main process gave when it refuses, stops the track it made, plays nothing, and tells the main process nothing: it ended the claim itself', async () => {
    const bridge = makeBridge({
      listen: async () => {
        throw new Error("Error invoking remote method 'lucium:ext-tab-capture-listen': Error: Lucium: the identifier of this tab capture is not valid, has expired or was already used. (expired)")
      }
    })
    const { devices } = await pageWith(freshDevices(), bridge)
    await expect(devices.getUserMedia(tabAudio())).rejects.toThrow(/^Lucium: the identifier of this tab capture is not valid, has expired or was already used\. \(expired\)$/)
    expect(FakeGenerator.made[0]!.stopped).toBe(true)
    expect(bridge.end).not.toHaveBeenCalled()
    // What comes for it afterwards is nobody's.
    bridge.sound(CLAIM, chunk(0))
    bridge.sound(CLAIM, chunk(1))
    expect(FakeGenerator.made[0]!.written).toEqual([])
  })

  it('lets go of the chunks it kept when the main process refuses after they came: nothing is left held', async () => {
    const bridge = makeBridge({
      listen: async (id) => {
        bridge.sound(id, chunk(0))
        throw new Error('Lucium: the tab gave no sound within 3 seconds')
      }
    })
    const { devices } = await pageWith(freshDevices(), bridge)
    await expect(devices.getUserMedia(tabAudio())).rejects.toThrow('no sound within 3 seconds')
    expect(FakeAudioData.made).toHaveLength(1)
    expect(FakeAudioData.made[0]!.closed).toBe(1)
    expect(FakeGenerator.made[0]!.written).toEqual([])
  })

  it('fails when the capture is stopped while the main process is still being waited for: the track goes, the page is told why', async () => {
    let answer: (format: unknown) => void = () => undefined
    const bridge = makeBridge({ listen: () => new Promise((resolve) => (answer = resolve)) })
    const { devices } = await pageWith(freshDevices(), bridge)
    const asked = devices.getUserMedia(tabAudio())
    await vi.waitFor(() => expect(bridge.listen).toHaveBeenCalled())
    bridge.stopWith(CLAIM)
    // What is still on its way for a capture that was stopped is not played.
    bridge.sound(CLAIM, chunk(0))
    bridge.sound(CLAIM, chunk(1))
    bridge.sound(CLAIM, chunk(2))
    answer(FORMAT)
    await expect(asked).rejects.toThrow('Lucium: the capture of the sound of this tab was stopped.')
    expect(FakeGenerator.made[0]!.stopped).toBe(true)
    expect(FakeGenerator.made[0]!.written).toEqual([])
  })

  it('does not stop what another identifier is waiting for', async () => {
    let answer: (format: unknown) => void = () => undefined
    const bridge = makeBridge({ listen: () => new Promise((resolve) => (answer = resolve)) })
    const { devices } = await pageWith(freshDevices(), bridge)
    const asked = devices.getUserMedia(tabAudio())
    await vi.waitFor(() => expect(bridge.listen).toHaveBeenCalled())
    bridge.stopWith('another-identifier')
    answer(FORMAT)
    await expect(asked).resolves.toBeInstanceOf(FakeStream)
    expect(FakeGenerator.made[0]!.stopped).toBe(false)
  })

  it('says in the console when the end cannot be told, and goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bridge = makeBridge({
      end: async () => {
        throw new Error('the browser is gone')
      }
    })
    const { devices } = await pageWith(freshDevices(), bridge)
    const stream = (await devices.getUserMedia(tabAudio())) as FakeStream
    stream.getAudioTracks()[0]!.stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be told to the browser'), 'the browser is gone')
    warn.mockRestore()
  })

  it('says in the console when a chunk cannot be played, and goes on with the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    await devices.getUserMedia(tabAudio())
    FakeGenerator.failWrite = new DOMException('The stream is closed', 'InvalidStateError')
    bridge.sound(CLAIM, chunk(0))
    bridge.sound(CLAIM, chunk(1))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be played'), 'The stream is closed')
    // What could not be played is let go all the same.
    expect(FakeAudioData.made.map((audio) => audio.closed)).toEqual([1, 1])
    warn.mockRestore()
  })

  it('fails with a message when the page cannot play samples at all, or has no AudioData, and asks for nothing', async () => {
    for (const missing of [false, 'without AudioData'] as const) {
      const bridge = makeBridge()
      const { devices } = await pageWith(freshDevices(), bridge, undefined, missing)
      await expect(devices.getUserMedia(tabAudio()), String(missing)).rejects.toMatchObject({ name: 'NotSupportedError', message: expect.stringContaining('cannot play the samples') })
      expect(bridge.listen).not.toHaveBeenCalled()
    }
  })
})

describe('what goes through unchanged', () => {
  it('lets every other call of getUserMedia go through with its arguments, and answers what the browser answers', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    const calls: unknown[] = [
      undefined,
      {},
      { audio: true },
      { video: true },
      { audio: true, video: true },
      { audio: { deviceId: 'x' } },
      { audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:1:0' } } },
      // The screen is not the sound of a tab, whatever the identifier looks like.
      { audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: CLAIM } } },
      { video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: CLAIM } } },
      { video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:1:0' } } },
      // A tab source with an identifier Lucium did not make, or none: not Lucium's to answer.
      tabAudio('a-real-chrome-stream-id'),
      tabAudio(`${CLAIM}x`),
      { audio: { mandatory: { chromeMediaSource: 'tab' } } },
      { audio: { chromeMediaSource: 'tab', chromeMediaSourceId: CLAIM } }
    ]
    for (const constraints of calls) await expect(devices.getUserMedia(constraints)).resolves.toBe('the native stream')
    expect(devices.native.mock.calls.map(([constraints]) => constraints)).toEqual(calls)
    expect(bridge.listen).not.toHaveBeenCalled()
    expect(FakeGenerator.made).toEqual([])
  })

  it('keeps `this` for the browser\'s own call', async () => {
    const { devices } = await pageWith(freshDevices(), makeBridge())
    let seen: unknown
    devices.native.mockImplementation(async function (this: unknown) {
      seen = this
      return 'x'
    })
    await devices.getUserMedia({ audio: true })
    expect(seen).toBe(devices)
  })

  it('leaves the screen and the old names alone in a page that is not an offscreen document: a popup, an options page', async () => {
    const devices = freshDevices()
    const { navigator, old } = await pageWith(devices, makeBridge())
    await expect(devices.getDisplayMedia({ video: true })).resolves.toBe('the native screen')
    navigator.getUserMedia({ audio: true }, () => undefined, () => undefined)
    navigator.webkitGetUserMedia({ audio: true }, () => undefined, () => undefined)
    expect(old.mock.calls.map(([name]) => name)).toEqual(['getUserMedia', 'webkitGetUserMedia'])
  })

  it('leaves getUserMedia alone where there is no channel for the sound of a tab', async () => {
    const { devices } = await pageWith(freshDevices(), null)
    await expect(devices.getUserMedia(tabAudio())).resolves.toBe('the native stream')
  })

  it('is set up once, however many times the preload runs: one listener for the stop, one for the sound', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    const wrapped = Object.getPrototypeOf(devices).getUserMedia
    const call = contextBridge.executeInMainWorld.mock.calls.map(([script]) => script).find((script) => script.args !== undefined)
    call.func(...call.args)
    expect(Object.getPrototypeOf(devices).getUserMedia).toBe(wrapped)
    await devices.getUserMedia({ audio: true })
    expect(devices.native).toHaveBeenCalledTimes(1)
    expect(bridge.onStop).toHaveBeenCalledTimes(1)
    expect(bridge.onPcm).toHaveBeenCalledTimes(1)
  })
})

describe('the end of the stream', () => {
  /** A stream made, and what the main process was told about it. */
  async function running() {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    const stream = (await devices.getUserMedia(tabAudio())) as FakeStream
    const generator = FakeGenerator.made.at(-1)!
    return { bridge, devices, stream, track: stream.getAudioTracks()[0]!, generator }
  }

  it('is told to the main process when the page stops its track (which fires no event), once, and what was kept for the buffer is closed', async () => {
    const { bridge, track, generator } = await running()
    expect(bridge.end).not.toHaveBeenCalled()
    bridge.sound(CLAIM, chunk(0))
    track.stop()
    track.stop()
    expect(track.stopped).toBe(true)
    expect(bridge.end).toHaveBeenCalledExactlyOnceWith(CLAIM)
    expect(generator.written).toEqual([])
  })

  it('is told to the main process when the browser ends the track by itself', async () => {
    const { bridge, track } = await running()
    track.end()
    track.end()
    expect(bridge.end).toHaveBeenCalledExactlyOnceWith(CLAIM)
  })

  it('lasts as long as a clone of the track does: it ends with the last of them', async () => {
    const { bridge, track } = await running()
    const copy = track.clone()
    const another = copy.clone()
    track.stop()
    copy.stop()
    expect(bridge.end).not.toHaveBeenCalled()
    another.stop()
    expect(bridge.end).toHaveBeenCalledExactlyOnceWith(CLAIM)
  })

  it('is ended when the main process asks the page to, for this identifier only', async () => {
    const { bridge, track } = await running()
    bridge.stopWith('another-identifier')
    expect(track.stopped).toBe(false)
    bridge.stopWith(CLAIM)
    expect(track.stopped).toBe(true)
    expect(bridge.end).toHaveBeenCalledExactlyOnceWith(CLAIM)
  })

  it('is asked of the main process once for the page, however many streams it makes', async () => {
    const { bridge } = await running()
    expect(bridge.onStop).toHaveBeenCalledTimes(1)
    expect(bridge.onPcm).toHaveBeenCalledTimes(1)
  })

  it('keeps the streams apart: the sound of one does not reach the other, and ending one does not end the other', async () => {
    const bridge = makeBridge()
    const { devices } = await pageWith(freshDevices(), bridge)
    const other = '1f8fad5b-d9cb-469f-a165-70867728950e'
    const first = ((await devices.getUserMedia(tabAudio())) as FakeStream).getAudioTracks()[0]!
    const second = ((await devices.getUserMedia(tabAudio(other))) as FakeStream).getAudioTracks()[0]!
    const [one, two] = FakeGenerator.made
    bridge.sound(CLAIM, chunk(0))
    bridge.sound(CLAIM, chunk(1))
    expect(one!.written).toHaveLength(2)
    expect(two!.written).toEqual([])
    first.stop()
    expect(bridge.end.mock.calls).toEqual([[CLAIM]])
    expect(second.stopped).toBe(false)
    bridge.stopWith(other)
    expect(bridge.end.mock.calls).toEqual([[CLAIM], [other]])
  })
})

describe('a document made without context isolation (an offscreen one)', () => {
  /** The preload as such a document runs it: the page's own world, `chrome.runtime` without `getManifest`, the manifest read by address after. */
  async function offscreen(manifest: Record<string, unknown>, over: { devtools?: boolean } = {}) {
    vi.resetModules()
    for (const name of ['__luciumBridged', '__luciumTabAudio', '__luciumShim', '__luciumManifest', '__luciumDevToolsSpared']) g[name] = undefined
    proc.type = undefined
    proc.contextIsolated = false
    vi.stubGlobal('location', { href: `chrome-extension://${ID}/offscreen.html`, ancestorOrigins: over.devtools ? ['devtools://devtools'] : [] })
    const devices = freshDevices()
    const made = stubWeb(devices)
    let manifestRead: (value: unknown) => void = () => undefined
    vi.stubGlobal('fetch', () => new Promise((resolve) => (manifestRead = () => resolve({ json: async () => manifest }))))
    g['chrome'] = { runtime: { id: ID } }
    // The main process: it answers to listen, and takes the end.
    ipcRenderer.invoke.mockImplementation(async (channel: string) => (channel === Channel.extTabCaptureListen ? FORMAT : undefined))
    await import('./extension-shims')
    return { devices, ...made, readManifest: () => manifestRead(undefined) }
  }

  /** What the main process sends to this page on a channel: the listener the preload registered for it. */
  const arrives = (channel: string, ...args: unknown[]): void => {
    const registered = ipcRenderer.on.mock.calls.find(([name]) => name === channel)
    expect(registered, channel).toBeDefined()
    registered![1]({}, ...args)
  }

  it('has the sound of a tab at once, before its manifest is read: its first script may ask as it starts', async () => {
    const { devices } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] })
    expect(typeof g['__luciumShim'].tabCapture.listen).toBe('function')
    const stream = (await devices.getUserMedia(tabAudio())) as FakeStream
    expect(stream.getVideoTracks()).toEqual([])
    expect(stream.tracks).toEqual([FakeGenerator.made[0]])
    expect(devices.native).not.toHaveBeenCalled()
    expect(devices.nativeDisplay).not.toHaveBeenCalled()
  })

  it('talks to the main process on the channels of its own, for the question, the end, and what it hears of the sound', async () => {
    const { devices } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] })
    const stream = (await devices.getUserMedia(tabAudio())) as FakeStream
    // What the main process sends is read on the channels of its own, for this identifier and nothing else.
    arrives(Channel.extTabCapturePcm, CLAIM, chunk(0))
    arrives(Channel.extTabCapturePcm, 12, chunk(1))
    arrives(Channel.extTabCapturePcm, CLAIM, chunk(1))
    expect(FakeGenerator.made[0]!.written).toHaveLength(2)
    stream.getAudioTracks()[0]!.stop()
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ['lucium:ext-tab-capture-listen', CLAIM],
      ['lucium:ext-tab-capture-end', CLAIM]
    ])
  })

  it('ends its stream when the main process asks the page to', async () => {
    const { devices } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] })
    const stream = (await devices.getUserMedia(tabAudio())) as FakeStream
    arrives(Channel.extTabCaptureStop, CLAIM)
    expect(stream.getAudioTracks()[0]!.stopped).toBe(true)
  })

  it('refuses every other request for a device with a message, instead of letting Electron stop on it: a microphone, a camera, both, none, a screen, a tab of Chrome\'s', async () => {
    const { devices } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] })
    const calls: unknown[] = [
      undefined,
      {},
      { audio: true },
      { video: true },
      { audio: true, video: true },
      { audio: { deviceId: 'x' } },
      { audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:1:0' } } },
      tabAudio('a-real-chrome-stream-id'),
      { audio: { mandatory: { chromeMediaSource: 'tab' } } }
    ]
    for (const constraints of calls) {
      await expect(devices.getUserMedia(constraints), JSON.stringify(constraints)).rejects.toMatchObject({ name: 'NotSupportedError', message: UNAVAILABLE })
    }
    expect(devices.native).not.toHaveBeenCalled()
  })

  it('refuses the request for a screen the same way, whatever it is given', async () => {
    const { devices } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] })
    for (const constraints of [undefined, {}, { video: true }, { audio: true, video: true }]) {
      await expect(devices.getDisplayMedia(constraints)).rejects.toMatchObject({ name: 'NotSupportedError', message: UNAVAILABLE })
    }
    expect(devices.nativeDisplay).not.toHaveBeenCalled()
  })

  it('refuses the old names of getUserMedia the same way: by the failure callback, and by a throw where there is none', async () => {
    const { navigator, old } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] })
    for (const name of ['getUserMedia', 'webkitGetUserMedia'] as const) {
      const failed = await new Promise<DOMException>((resolve) => navigator[name]({ audio: true }, () => undefined, resolve as never))
      expect(failed).toMatchObject({ name: 'NotSupportedError', message: UNAVAILABLE })
      expect(() => navigator[name]({ audio: true })).toThrow(UNAVAILABLE)
    }
    expect(old).not.toHaveBeenCalled()
  })

  it('still gives the sound of a tab after refusing the others: they do not share anything', async () => {
    const { devices } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] })
    await expect(devices.getUserMedia({ audio: true })).rejects.toMatchObject({ name: 'NotSupportedError' })
    await expect(devices.getUserMedia(tabAudio())).resolves.toBeInstanceOf(FakeStream)
  })

  it('leaves the pages of the DevTools as they are: nothing is refused there', async () => {
    const { devices, navigator, old } = await offscreen({ manifest_version: 3, permissions: ['tabCapture'] }, { devtools: true })
    await expect(devices.getUserMedia({ audio: true })).resolves.toBe('the native stream')
    await expect(devices.getDisplayMedia({ video: true })).resolves.toBe('the native screen')
    navigator.getUserMedia({ audio: true }, () => undefined, () => undefined)
    expect(old).toHaveBeenCalledTimes(1)
    // And the sound of a tab is still theirs to ask for.
    await expect(devices.getUserMedia(tabAudio())).resolves.toBeInstanceOf(FakeStream)
  })
})
