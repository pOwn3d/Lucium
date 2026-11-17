// The sound of a tab, carried as samples from the helper page of a capture to the page of the extension (main/engine/tab-capture.ts). The helper page reads the samples of the
// track the browser gave it (a `MediaStreamTrackProcessor`), cuts them in chunks of 20 ms and sends each to the main process on one channel; the main process judges every chunk,
// and hands it to the page of the extension that holds the claim, which plays them into a `MediaStreamTrackGenerator`. No link is made between the two pages: WebRTC does not work in
// an offscreen document of Electron 45.2.1 (measured on 13 November 2026: two connections face to face in that document stay at `new`).
//
// What a chunk is: one message of at most 64 kB, a header of four unsigned 32-bit integers (little endian) and the samples, `f32-planar` (all of a channel, then the next):
//   [0] sequence number, [4] sample rate, [8] channels (1 or 2), [12] frames in each channel, [16…] channels × frames float samples.
// The main process trusts nothing of it (the helper page is a page, however plain): the shape, the limits, the order and the pace are judged here, one violation ends the capture.
// An empty message says the helper page has no more sound to send. Nothing of the sound is ever written down: not in a log, not in a file, and it leaves nowhere but the page that asked.

/** The header of a chunk, in bytes. */
export const PCM_HEADER_BYTES = 16
/** The most a message may weigh. */
export const PCM_MESSAGE_MAX = 64 * 1024
/** A chunk lasts this long: a tab's sound is cut in pieces small enough for the page to play without a gap, and big enough to cost little. */
export const PCM_CHUNK_MS = 20
export const PCM_CHANNELS_MAX = 2
export const PCM_RATE_MIN = 8_000
export const PCM_RATE_MAX = 96_000
/** The most sound that may come, in seconds of sound for each second that passed: a tab's sound arrives in real time, and a burst at the start is allowed. */
export const PCM_REALTIME_FACTOR = 4
/** What the pace may be ahead of real time, in seconds of sound, before the factor counts. */
export const PCM_HEAD_START_S = 0.5

export interface PcmChunk {
  seq: number
  sampleRate: number
  channels: number
  frames: number
  /** The whole message, as it came (a copy of its bytes, so that what is passed on is what was judged). */
  bytes: ArrayBuffer
}

export type PcmRead = { kind: 'chunk'; chunk: PcmChunk } | { kind: 'end' } | { kind: 'refused'; message: string }

const isBuffer = (value: unknown): value is ArrayBuffer => Object.prototype.toString.call(value) === '[object ArrayBuffer]'

/** Where the bytes of what the page sent are, and how many: an `ArrayBuffer`, or a view of one (how IPC may deliver it). Nothing is copied. Null for anything else. */
function locate(raw: unknown): { buffer: ArrayBuffer; start: number; length: number } | null {
  if (isBuffer(raw)) return { buffer: raw, start: 0, length: raw.byteLength }
  if (ArrayBuffer.isView(raw)) return { buffer: raw.buffer as ArrayBuffer, start: raw.byteOffset, length: raw.byteLength }
  return null
}

/** What a message from the helper page is: a chunk of sound judged by its shape, the end of the sound, or a refusal that says why. */
export function readChunk(raw: unknown): PcmRead {
  const sent = locate(raw)
  if (sent === null) return { kind: 'refused', message: 'the message is not bytes' }
  if (sent.length === 0) return { kind: 'end' }
  // The size is judged before a byte is copied: a page that sends a message the size of its memory costs a refusal, not a copy.
  if (sent.length > PCM_MESSAGE_MAX) return { kind: 'refused', message: `the message is longer than ${PCM_MESSAGE_MAX} bytes` }
  if (sent.length < PCM_HEADER_BYTES) return { kind: 'refused', message: 'the message is shorter than a header' }
  const bytes = sent.buffer.slice(sent.start, sent.start + sent.length)
  const view = new DataView(bytes)
  const seq = view.getUint32(0, true)
  const sampleRate = view.getUint32(4, true)
  const channels = view.getUint32(8, true)
  const frames = view.getUint32(12, true)
  if (sampleRate < PCM_RATE_MIN || sampleRate > PCM_RATE_MAX) return { kind: 'refused', message: `the sample rate ${sampleRate} is out of range` }
  if (channels < 1 || channels > PCM_CHANNELS_MAX) return { kind: 'refused', message: `${channels} channels is out of range` }
  if (frames < 1) return { kind: 'refused', message: 'the chunk holds no frame' }
  if (bytes.byteLength !== PCM_HEADER_BYTES + channels * frames * 4) return { kind: 'refused', message: 'the length of the message is not that of its header' }
  return { kind: 'chunk', chunk: { seq, sampleRate, channels, frames, bytes } }
}

/** What one capture may send, judged chunk by chunk: the order, the format that does not change, and the pace. */
export class PcmGate {
  private last = -1
  private format: { sampleRate: number; channels: number } | null = null
  private startedAt = 0
  private seconds = 0

  constructor(private readonly clock: () => number = Date.now) {}

  /** The format of the sound, once a chunk came. */
  get started(): { sampleRate: number; channels: number } | null {
    return this.format
  }

  /** Null when the chunk may go on; else what is wrong with it. */
  accept(chunk: Pick<PcmChunk, 'seq' | 'sampleRate' | 'channels' | 'frames'>): string | null {
    if (chunk.seq <= this.last) return 'the sequence does not grow'
    const now = this.clock()
    if (this.format === null) {
      this.format = { sampleRate: chunk.sampleRate, channels: chunk.channels }
      this.startedAt = now
    } else if (this.format.sampleRate !== chunk.sampleRate || this.format.channels !== chunk.channels) {
      return 'the format of the sound changed'
    }
    this.seconds += chunk.frames / chunk.sampleRate
    if (this.seconds > ((now - this.startedAt) / 1000) * PCM_REALTIME_FACTOR + PCM_HEAD_START_S) return 'the sound comes faster than real time allows'
    this.last = chunk.seq
    return null
  }
}

/**
 * What the helper page runs, as one text with no parameter: it asks for the screen with the sound of the tab (the engine answers with that sound and the picture of the helper page
 * itself, which it takes off at once), reads the samples of the one audio track and sends them, chunk by chunk, with the one function its preload gives it
 * (`window.luciumCapture.send`, preload/capture-helper.ts). It returns once the reading has begun; when the sound ends, or cannot be read, it sends an empty message.
 */
export const HELPER_SCRIPT = `(async () => {
  const bridge = window.luciumCapture
  if (!bridge || typeof bridge.send !== 'function') throw new Error('the helper page has no way to send the sound')
  if (typeof MediaStreamTrackProcessor !== 'function') throw new Error('this browser cannot read the samples of a track (MediaStreamTrackProcessor)')
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  const stop = () => {
    for (const track of stream.getTracks()) track.stop()
  }
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  const sound = stream.getAudioTracks()
  if (sound.length !== 1) {
    stop()
    throw new Error('the tab gave no sound')
  }
  const reader = new MediaStreamTrackProcessor({ track: sound[0] }).readable.getReader()
  const HEADER = ${PCM_HEADER_BYTES}
  const CHUNK_MS = ${PCM_CHUNK_MS}
  let seq = 0
  const emit = (frame) => {
    const rate = frame.sampleRate
    const total = frame.numberOfFrames
    const channels = frame.numberOfChannels
    let planes = []
    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(total)
      frame.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
      planes.push(plane)
    }
    if (channels > ${PCM_CHANNELS_MAX}) {
      const mono = new Float32Array(total)
      for (const plane of planes) for (let i = 0; i < total; i++) mono[i] += plane[i] / channels
      planes = [mono]
    }
    const per = Math.max(1, Math.floor((rate * CHUNK_MS) / 1000))
    for (let start = 0; start < total; start += per) {
      const frames = Math.min(per, total - start)
      const buffer = new ArrayBuffer(HEADER + planes.length * frames * 4)
      const view = new DataView(buffer)
      view.setUint32(0, seq++, true)
      view.setUint32(4, rate, true)
      view.setUint32(8, planes.length, true)
      view.setUint32(12, frames, true)
      const samples = new Float32Array(buffer, HEADER, planes.length * frames)
      planes.forEach((plane, c) => samples.set(plane.subarray(start, start + frames), c * frames))
      bridge.send(buffer)
    }
  }
  const pump = async () => {
    try {
      for (;;) {
        const read = await reader.read()
        if (read.done) break
        try {
          emit(read.value)
        } finally {
          read.value.close()
        }
      }
    } catch (error) {
      console.error('[capture-helper] the sound could not be read:', error)
    }
    stop()
    bridge.send(new ArrayBuffer(0))
  }
  window.__luciumSound = { stream, reader }
  pump()
  return true
})()`
