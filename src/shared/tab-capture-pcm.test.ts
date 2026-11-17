// The sound of a tab as chunks of samples (tab-capture-pcm.ts): what a chunk is, what the main process judges of each, and the one text the helper page runs, here run for real
// against a made-up page (the track, the screen request and the preload's one function are stand-ins), and its chunks read back by the judge.

import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { HELPER_SCRIPT, PCM_CHANNELS_MAX, PCM_CHUNK_MS, PCM_HEAD_START_S, PCM_HEADER_BYTES, PCM_MESSAGE_MAX, PCM_RATE_MAX, PCM_RATE_MIN, PCM_REALTIME_FACTOR, PcmGate, readChunk } from './tab-capture-pcm'

/** A chunk as the helper page packs it: the four integers, then the planes. */
function pack(seq: number, rate: number, planes: number[][]): ArrayBuffer {
  const frames = planes[0]!.length
  const buffer = new ArrayBuffer(PCM_HEADER_BYTES + planes.length * frames * 4)
  const view = new DataView(buffer)
  for (const [at, value] of [seq, rate, planes.length, frames].entries()) view.setUint32(at * 4, value, true)
  const samples = new Float32Array(buffer, PCM_HEADER_BYTES)
  planes.forEach((plane, c) => samples.set(plane, c * frames))
  return buffer
}

/** A header with what it says, over `length` bytes: for a message that lies. */
function header(fields: { seq?: number; rate?: number; channels?: number; frames?: number }, length: number): ArrayBuffer {
  const buffer = new ArrayBuffer(length)
  const view = new DataView(buffer)
  view.setUint32(0, fields.seq ?? 0, true)
  view.setUint32(4, fields.rate ?? 48_000, true)
  view.setUint32(8, fields.channels ?? 1, true)
  view.setUint32(12, fields.frames ?? 1, true)
  return buffer
}

describe('a chunk of sound', () => {
  it('is taken when it is a header and as many samples as the header says', () => {
    const read = readChunk(pack(7, 48_000, [[0.25, -0.5, 1]]))
    expect(read).toMatchObject({ kind: 'chunk', chunk: { seq: 7, sampleRate: 48_000, channels: 1, frames: 3 } })
    const stereo = readChunk(pack(0, 44_100, [[0.1, 0.2], [0.3, 0.4]]))
    expect(stereo).toMatchObject({ kind: 'chunk', chunk: { channels: 2, frames: 2, sampleRate: 44_100 } })
  })

  it('is given back as a copy: what is passed on is what was judged, whatever the sender does to its buffer after', () => {
    const sent = pack(1, 48_000, [[0.5, 0.5]])
    const read = readChunk(sent)
    new Uint8Array(sent).fill(255)
    expect(read.kind === 'chunk' && new Uint8Array(read.chunk.bytes)[0]).toBe(1)
    expect(read.kind === 'chunk' && read.chunk.bytes).not.toBe(sent)
  })

  it('is taken as a view of a buffer too, which is how IPC may deliver it: the bytes of the view only', () => {
    const inside = new Uint8Array(pack(3, 48_000, [[1, 2, 3, 4]]))
    const padded = new Uint8Array(inside.length + 10)
    padded.set(inside, 5)
    const read = readChunk(padded.subarray(5, 5 + inside.length))
    expect(read).toMatchObject({ kind: 'chunk', chunk: { seq: 3, frames: 4 } })
    expect(read.kind === 'chunk' && read.chunk.bytes.byteLength).toBe(inside.length)
  })

  it('is the end of the sound when the message is empty', () => {
    expect(readChunk(new ArrayBuffer(0))).toEqual({ kind: 'end' })
    expect(readChunk(new Uint8Array(0))).toEqual({ kind: 'end' })
  })

  it('is refused when it is not bytes', () => {
    for (const wrong of [undefined, null, 12, 'abc', {}, [1, 2], { byteLength: 20 }, new Blob(['x'])]) expect(readChunk(wrong), String(wrong)).toMatchObject({ kind: 'refused', message: 'the message is not bytes' })
  })

  it('is refused beyond 64 kB, and taken at the limit', () => {
    expect(PCM_MESSAGE_MAX).toBe(65_536)
    const frames = (PCM_MESSAGE_MAX - PCM_HEADER_BYTES) / 8
    expect(readChunk(header({ channels: 2, frames }, PCM_MESSAGE_MAX))).toMatchObject({ kind: 'chunk' })
    expect(readChunk(header({ channels: 2, frames }, PCM_MESSAGE_MAX + 8))).toMatchObject({ kind: 'refused', message: expect.stringContaining('longer than 65536') })
    expect(readChunk(header({ channels: 1, frames: 1 }, PCM_MESSAGE_MAX * 100))).toMatchObject({ kind: 'refused' })
  })

  it('is judged by its size before a byte of it is copied: a message that is empty, too long or too short costs nothing to refuse', () => {
    const copies = (size: number, view: boolean): number => {
      const buffer = new ArrayBuffer(size)
      const slice = vi.spyOn(buffer, 'slice')
      readChunk(view ? new Uint8Array(buffer) : buffer)
      return slice.mock.calls.length
    }
    for (const view of [false, true]) {
      for (const size of [0, 1, PCM_HEADER_BYTES - 1, PCM_MESSAGE_MAX + 1, PCM_MESSAGE_MAX * 1000]) expect(copies(size, view), `${size} bytes${view ? ' as a view' : ''}`).toBe(0)
      // A message that passes the size is copied once: what is passed on is what was judged.
      expect(copies(PCM_HEADER_BYTES + 4, view), `a chunk${view ? ' as a view' : ''}`).toBe(1)
    }
  })

  it('is refused when it is shorter than a header', () => {
    for (const length of [1, 4, 15]) expect(readChunk(new ArrayBuffer(length)), String(length)).toMatchObject({ kind: 'refused', message: 'the message is shorter than a header' })
  })

  it('is refused when its sample rate is out of range, and taken at both limits', () => {
    expect([PCM_RATE_MIN, PCM_RATE_MAX]).toEqual([8_000, 96_000])
    for (const rate of [0, 1, 7_999, 96_001, 192_000, 2 ** 32 - 1]) expect(readChunk(header({ rate }, PCM_HEADER_BYTES + 4)), String(rate)).toMatchObject({ kind: 'refused', message: expect.stringContaining('sample rate') })
    for (const rate of [8_000, 96_000]) expect(readChunk(header({ rate }, PCM_HEADER_BYTES + 4)), String(rate)).toMatchObject({ kind: 'chunk' })
  })

  it('is refused when it has no channel or more than two, and taken with one or two', () => {
    expect(PCM_CHANNELS_MAX).toBe(2)
    for (const channels of [0, 3, 6, 2 ** 32 - 1]) expect(readChunk(header({ channels }, PCM_HEADER_BYTES + 4)), String(channels)).toMatchObject({ kind: 'refused', message: expect.stringContaining('channels') })
    for (const channels of [1, 2]) expect(readChunk(header({ channels, frames: 1 }, PCM_HEADER_BYTES + 4 * channels)), String(channels)).toMatchObject({ kind: 'chunk' })
  })

  it('is refused when it holds no frame', () => {
    expect(readChunk(header({ frames: 0 }, PCM_HEADER_BYTES))).toMatchObject({ kind: 'refused', message: 'the chunk holds no frame' })
  })

  it('is refused when its length is not what its header says: a missing sample, an extra one, a count that cannot fit', () => {
    expect(readChunk(header({ frames: 10 }, PCM_HEADER_BYTES + 39))).toMatchObject({ kind: 'refused', message: expect.stringContaining('length') })
    expect(readChunk(header({ frames: 10 }, PCM_HEADER_BYTES + 41))).toMatchObject({ kind: 'refused', message: expect.stringContaining('length') })
    expect(readChunk(header({ channels: 2, frames: 10 }, PCM_HEADER_BYTES + 40))).toMatchObject({ kind: 'refused' })
    // A count so large that the product leaves the 32-bit range must not wrap around to what the message is.
    expect(readChunk(header({ frames: 2 ** 32 - 1 }, PCM_HEADER_BYTES + 4))).toMatchObject({ kind: 'refused' })
    expect(readChunk(header({ channels: 2, frames: 2 ** 31 }, PCM_HEADER_BYTES + 4))).toMatchObject({ kind: 'refused' })
  })

  it('is read little endian, as the helper page writes it', () => {
    const buffer = new ArrayBuffer(PCM_HEADER_BYTES + 4)
    new Uint8Array(buffer).set([1, 0, 0, 0, 0x80, 0xbb, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
    expect(readChunk(buffer)).toMatchObject({ kind: 'chunk', chunk: { seq: 1, sampleRate: 48_000, channels: 1, frames: 1 } })
  })
})

describe('what a capture may send, chunk by chunk', () => {
  const chunk = (seq: number, over: Partial<{ sampleRate: number; channels: number; frames: number }> = {}) => ({ seq, sampleRate: 48_000, channels: 1, frames: 960, ...over })
  const gate = () => {
    let now = 1_000
    return { gate: new PcmGate(() => now), wait: (ms: number) => (now += ms) }
  }

  it('takes a sound that grows in order, at the pace of real time', () => {
    const { gate: g, wait } = gate()
    for (let seq = 0; seq < 100; seq++) {
      expect(g.accept(chunk(seq))).toBeNull()
      wait(20)
    }
    expect(g.started).toEqual({ sampleRate: 48_000, channels: 1 })
  })

  it('refuses a sequence that does not grow: the same number, an older one', () => {
    const { gate: g } = gate()
    expect(g.accept(chunk(5))).toBeNull()
    expect(g.accept(chunk(5))).toBe('the sequence does not grow')
    expect(g.accept(chunk(4))).toBe('the sequence does not grow')
    expect(g.accept(chunk(6))).toBeNull()
  })

  it('takes a sequence that begins anywhere and skips: only the order counts', () => {
    const { gate: g } = gate()
    expect(g.accept(chunk(1000))).toBeNull()
    expect(g.accept(chunk(1010))).toBeNull()
  })

  it('refuses a format that changes: the rate, or the channels', () => {
    const { gate: g } = gate()
    expect(g.accept(chunk(0))).toBeNull()
    expect(g.accept(chunk(1, { sampleRate: 44_100 }))).toBe('the format of the sound changed')
    expect(g.accept(chunk(2, { channels: 2 }))).toBe('the format of the sound changed')
    expect(g.accept(chunk(3))).toBeNull()
  })

  it('refuses sound that comes faster than four times real time, with a head start, and takes it up to the limit', () => {
    expect([PCM_REALTIME_FACTOR, PCM_HEAD_START_S]).toEqual([4, 0.5])
    const { gate: g } = gate()
    // One second of sound in one instant: half a second of head start and no time passed.
    expect(g.accept(chunk(0, { frames: 24_000 }))).toBeNull()
    expect(g.accept(chunk(1, { frames: 1 }))).toBe('the sound comes faster than real time allows')
  })

  it('counts the pace from the first chunk: a burst after a pause is judged against the time that really passed', () => {
    const { gate: g, wait } = gate()
    expect(g.accept(chunk(0))).toBeNull()
    wait(1000)
    // 1 s passed: 4 s + 0.5 s of sound may have come in all. 20 ms was taken; 4.4 s more is the most.
    expect(g.accept(chunk(1, { frames: 48_000 * 4 }))).toBeNull()
    expect(g.accept(chunk(2, { frames: 48_000 * 0.5 }))).toBe('the sound comes faster than real time allows')
    wait(1000)
    expect(g.accept(chunk(3, { frames: 48_000 }))).toBeNull()
  })

  it('does not count a chunk it refused: the next good one is judged as if the refused one never came', () => {
    const { gate: g } = gate()
    expect(g.accept(chunk(0, { frames: 24_000 }))).toBeNull()
    expect(g.accept(chunk(1, { frames: 48_000 }))).not.toBeNull()
    expect(g.accept(chunk(1, { frames: 1 }))).toBe('the sound comes faster than real time allows')
    expect(g.accept(chunk(0, { frames: 1 }))).toBe('the sequence does not grow')
  })

  it('knows nothing of the format before its first chunk', () => {
    expect(gate().gate.started).toBeNull()
  })
})

/** The helper page, made up: a track whose frames are read, the call that asks for the screen, the one function of the preload. Run in a context of its own, as a page is. */
function page(over: { frames?: Array<{ rate: number; planes: number[][] }>; tracks?: Array<'audio' | 'video'>; processor?: boolean; bridge?: boolean; readFails?: boolean } = {}) {
  const sent: ArrayBuffer[] = []
  const asked: unknown[] = []
  const errors: unknown[][] = []
  const closed: boolean[] = []
  const tracks = (over.tracks ?? ['video', 'audio']).map((kind) => ({ kind, stopped: false, stop() { this.stopped = true } }))
  const frames = (over.frames ?? []).map((one, i) => ({
    sampleRate: one.rate,
    numberOfChannels: one.planes.length,
    numberOfFrames: one.planes[0]!.length,
    copyTo(destination: Float32Array, options: { planeIndex: number; format: string }) {
      if (options.format !== 'f32-planar') throw new Error(`the format ${options.format} was asked`)
      destination.set(one.planes[options.planeIndex]!)
    },
    close: () => void (closed[i] = true)
  }))
  let at = 0
  const reader = {
    read: async () => {
      if (over.readFails) throw new Error('the track broke')
      return at < frames.length ? { done: false, value: frames[at++] } : { done: true }
    }
  }
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    removeTrack: (track: unknown) => void tracks.splice(tracks.indexOf(track as never), 1)
  }
  const context: Record<string, unknown> = {
    navigator: { mediaDevices: { getDisplayMedia: async (constraints: unknown) => (asked.push(constraints), stream) } },
    console: { error: (...args: unknown[]) => void errors.push(args) }
  }
  if (over.processor !== false) context['MediaStreamTrackProcessor'] = class { readable = { getReader: () => reader } }
  context['window'] = context
  if (over.bridge !== false) context['luciumCapture'] = { send: (buffer: ArrayBuffer) => void sent.push(buffer) }
  const run = (): Promise<unknown> => runInNewContext(HELPER_SCRIPT, context) as Promise<unknown>
  return { run, sent, asked, errors, closed, tracks, stream }
}

/** Every chunk the page sent, read back by the judge. */
const chunksOf = (sent: ArrayBuffer[]) => sent.filter((buffer) => buffer.byteLength > 0).map((buffer) => {
  const read = readChunk(buffer)
  if (read.kind !== 'chunk') throw new Error(`a chunk of the page was refused: ${JSON.stringify(read)}`)
  return { ...read.chunk, samples: [...new Float32Array(read.chunk.bytes, PCM_HEADER_BYTES)] }
})

describe('what the helper page runs', () => {
  const ramp = (length: number, from = 0): number[] => Array.from({ length }, (_, i) => (from + i) / 4096)

  it('asks for the screen with the sound, takes the picture off and stops it, and is done once the reading has begun', async () => {
    const world = page({ frames: [] })
    const picture = world.tracks.find((track) => track.kind === 'video')!
    expect(await world.run()).toBe(true)
    expect(world.asked).toEqual([{ audio: true, video: true }])
    expect(world.stream.getVideoTracks()).toEqual([])
    expect(world.stream.getAudioTracks()).toHaveLength(1)
    // The picture track was stopped, and is no longer in the stream.
    expect(picture.stopped).toBe(true)
    expect(world.tracks).not.toContain(picture)
  })

  it('cuts the sound in chunks of 20 ms, planar, in order, and every one is a chunk the judge takes', async () => {
    const left = ramp(1920)
    const right = ramp(1920, 5000)
    const world = page({ frames: [{ rate: 48_000, planes: [left, right] }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    const chunks = chunksOf(world.sent)
    expect(PCM_CHUNK_MS).toBe(20)
    expect(chunks.map((chunk) => [chunk.seq, chunk.sampleRate, chunk.channels, chunk.frames])).toEqual([[0, 48_000, 2, 960], [1, 48_000, 2, 960]])
    // The samples are the track's own, plane after plane.
    expect(chunks[0]!.samples).toEqual([...left.slice(0, 960), ...right.slice(0, 960)].map((value) => Math.fround(value)))
    expect(chunks[1]!.samples).toEqual([...left.slice(960), ...right.slice(960)].map((value) => Math.fround(value)))
  })

  it('numbers the chunks across frames, and keeps the rate of each', async () => {
    const world = page({ frames: [{ rate: 48_000, planes: [ramp(480)] }, { rate: 48_000, planes: [ramp(480)] }, { rate: 48_000, planes: [ramp(100)] }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    expect(chunksOf(world.sent).map((chunk) => [chunk.seq, chunk.frames])).toEqual([[0, 480], [1, 480], [2, 100]])
  })

  it('cuts a small last piece, and a rate that is not a multiple of 50: the chunk is 20 ms or what is left', async () => {
    const world = page({ frames: [{ rate: 44_100, planes: [ramp(882 + 100)] }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    expect(chunksOf(world.sent).map((chunk) => [chunk.frames, chunk.sampleRate])).toEqual([[882, 44_100], [100, 44_100]])
  })

  it('mixes more than two channels to one, as the mean of them', async () => {
    const planes = [[0.6, 0.6], [0.3, 0.3], [0, 0], [0, 0], [0, 0], [-0.3, -0.3]]
    const world = page({ frames: [{ rate: 48_000, planes }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    const chunks = chunksOf(world.sent)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.channels).toBe(1)
    expect(chunks[0]!.samples[0]).toBeCloseTo(0.1, 5)
  })

  it('keeps a mono or stereo sound as it is', async () => {
    const world = page({ frames: [{ rate: 48_000, planes: [[0.5]] }, { rate: 48_000, planes: [[0.1], [0.2]] }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    expect(chunksOf(world.sent).map((chunk) => chunk.channels)).toEqual([1, 2])
  })

  it('never sends a message the judge would refuse for its size, at the highest rate with two channels', async () => {
    const world = page({ frames: [{ rate: 96_000, planes: [ramp(96_000), ramp(96_000)] }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    for (const buffer of world.sent) expect(buffer.byteLength).toBeLessThanOrEqual(PCM_MESSAGE_MAX)
    expect(chunksOf(world.sent)).toHaveLength(50)
  })

  it('closes each frame it read, after it was sent', async () => {
    const world = page({ frames: [{ rate: 48_000, planes: [ramp(10)] }, { rate: 48_000, planes: [ramp(10)] }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    expect(world.closed).toEqual([true, true])
  })

  it('says the sound is over with an empty message, and stops the track, when the track ends', async () => {
    const world = page({ frames: [{ rate: 48_000, planes: [ramp(10)] }] })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    expect(world.tracks.every((track) => track.stopped)).toBe(true)
    expect(world.errors).toEqual([])
  })

  it('says it too, and what went wrong in its console, when the track cannot be read', async () => {
    const world = page({ frames: [], readFails: true })
    await world.run()
    await vi.waitFor(() => expect(world.sent.at(-1)?.byteLength).toBe(0))
    expect(world.errors[0]?.[0]).toContain('the sound could not be read')
    expect((world.errors[0]?.[1] as Error).message).toBe('the track broke')
    expect(world.tracks.every((track) => track.stopped)).toBe(true)
  })

  it('fails, with every track stopped, when the tab gave no sound or more than one track of it', async () => {
    for (const kinds of [['video'], ['video', 'audio', 'audio'], []] as const) {
      const world = page({ tracks: [...kinds] })
      await expect(world.run()).rejects.toThrow('the tab gave no sound')
      expect(world.tracks.every((track) => track.stopped), kinds.join()).toBe(true)
      expect(world.sent).toEqual([])
    }
  })

  it('fails before it asks for the screen when it has no way to read samples or no way to send them', async () => {
    const noReader = page({ processor: false })
    await expect(noReader.run()).rejects.toThrow('MediaStreamTrackProcessor')
    expect(noReader.asked).toEqual([])
    const noBridge = page({ bridge: false })
    await expect(noBridge.run()).rejects.toThrow('no way to send the sound')
    expect(noBridge.asked).toEqual([])
  })

  it('has no parameter: the same text for every capture, and nothing of anyone is written in it', () => {
    expect(HELPER_SCRIPT).not.toMatch(/__\w+__/)
    expect(HELPER_SCRIPT.startsWith('(async () => {')).toBe(true)
    expect(HELPER_SCRIPT.endsWith('})()')).toBe(true)
  })
})
