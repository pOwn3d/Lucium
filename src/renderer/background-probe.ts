// Reads a few frames of a file of the user's, in the panel that adds it, and works out its veil (shared/auto-veil.ts): an <img>, the frames of a GIF
// (ImageDecoder) or a <video>, on a blob: URL of the bytes the panel already holds, each frame drawn small on a canvas. Once per file added or replaced,
// or at « Revenir au réglage automatique »: nothing listens or waits otherwise. Nothing goes over the network or to the main process, and nothing is
// kept once it is done (the URL is revoked, the video emptied). What only a real window shows (decoding, seeking) is checked by smoke-auto-veil.ts.

import { AUTO_VEIL_FALLBACK, MEASURE_TIMEOUT_MS, SAMPLE_HEIGHT, SAMPLE_WIDTH, autoVeil, backgroundTypeOf, frameIndices, frameTimes, measureFrames, measuredRegion, type AutoVeilLook, type FramePixels } from '@shared/auto-veil'
import type { SpaceBackgroundMediaReply } from '@shared/space-background-media'

/** The look of a file, and whether it was measured (else it is the safe look, AUTO_VEIL_FALLBACK). */
export interface MeasuredLook {
  look: AutoVeilLook
  measured: boolean
}

/** Reads the frames of a file from its blob URL; stops (and lets go of what it holds) when `signal` is aborted. */
export type FrameReader = (url: string, bytes: Uint8Array<ArrayBuffer>, mimeType: string, signal: AbortSignal) => Promise<FramePixels[]>

/** What a measure takes in: the reader of the frames and the longest it may take (a test gives its own). */
export interface ProbeOptions {
  read?: FrameReader
  timeoutMs?: number
}

/**
 * The look of a file the user gave, from its bytes. Whatever goes wrong (a codec Chromium does not read, a cut file, no frame within MEASURE_TIMEOUT_MS,
 * frames that came out black), the safe look, with a line in the console that says why.
 */
export async function measureBackground(bytes: Uint8Array<ArrayBuffer>, mimeType: string, options: ProbeOptions = {}): Promise<MeasuredLook> {
  const { read = readFrames, timeoutMs = MEASURE_TIMEOUT_MS } = options
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(new Error(`no frame after ${timeoutMs} ms`)), timeoutMs)
  try {
    const frames = await Promise.race([read(url, bytes, mimeType, stop.signal), abortion(stop.signal)])
    const result = autoVeil(measureFrames(frames))
    if (!result.measured) console.warn(`[space media] the ${mimeType} background gave no frame to measure (${frames.length} read, black or transparent): the safe veil is used`)
    return result
  } catch (error) {
    console.warn(`[space media] the ${mimeType} background could not be measured, the safe veil is used:`, error)
    return { look: AUTO_VEIL_FALLBACK, measured: false }
  } finally {
    // A reader that ran out of time was stopped by the abort; one that answered holds nothing more.
    clearTimeout(timer)
    URL.revokeObjectURL(url)
  }
}

/** The look of the file a space's background names, read again from the media folder (« Revenir au réglage automatique »). */
export async function measureBackgroundFile(filename: string, options: ProbeOptions = {}): Promise<MeasuredLook> {
  try {
    const reply = (await window.lucium.spaceBackgroundMedia({ op: 'read', filename })) as SpaceBackgroundMediaReply
    if (!reply.ok || !reply.data || !reply.mimeType) throw new Error(reply.ok ? 'no bytes' : reply.message)
    return await measureBackground(reply.data, reply.mimeType, options)
  } catch (error) {
    console.warn(`[space media] the background ${filename} could not be read to measure it, the safe veil is used:`, error)
    return { look: AUTO_VEIL_FALLBACK, measured: false }
  }
}

/** A promise that fails when the signal is aborted. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** A small canvas that a frame is drawn on, the measured part only, and read back. */
function sampler(): (source: CanvasImageSource, width: number, height: number) => FramePixels {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_WIDTH
  canvas.height = SAMPLE_HEIGHT
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('no 2d canvas')
  context.imageSmoothingQuality = 'high'
  return (source, width, height) => {
    const region = measuredRegion(width, height)
    if (!region) throw new Error(`a frame of ${width} × ${height}`)
    context.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
    context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
    return { data: context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data, width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT }
  }
}

/** The frames of a file, by its kind. */
const readFrames: FrameReader = async (url, bytes, mimeType, signal) => {
  const sample = sampler()
  const kind = backgroundTypeOf(mimeType)
  if (kind === 'video') return readVideo(url, signal, sample)
  if (kind === 'gif') {
    // Where Chromium has no ImageDecoder, the first frame, as the <img> shows it. A GIF it cannot decode fails the measure (the safe veil).
    const frames = await readAnimation(bytes, mimeType, signal, sample)
    if (frames) return frames
  }
  const image = new Image()
  image.src = url
  await image.decode()
  return [sample(image, image.naturalWidth, image.naturalHeight)]
}

/** What this file uses of ImageDecoder (WebCodecs), which the DOM types may not have. */
interface DecodedFrame {
  displayWidth: number
  displayHeight: number
  close(): void
}
interface AnimationDecoder {
  completed: Promise<void>
  tracks: { selectedTrack: { frameCount: number } | null }
  decode(options: { frameIndex: number }): Promise<{ image: DecodedFrame }>
  close(): void
}
type AnimationDecoderClass = new (init: { data: Uint8Array<ArrayBuffer>; type: string }) => AnimationDecoder

/** Up to five frames of an animation (frameIndices), or null where Chromium has no ImageDecoder. */
async function readAnimation(bytes: Uint8Array<ArrayBuffer>, mimeType: string, signal: AbortSignal, sample: ReturnType<typeof sampler>): Promise<FramePixels[] | null> {
  const Decoder = (globalThis as { ImageDecoder?: AnimationDecoderClass }).ImageDecoder
  if (!Decoder) return null
  const decoder = new Decoder({ data: bytes, type: mimeType })
  try {
    await decoder.completed
    const frames: FramePixels[] = []
    for (const frameIndex of frameIndices(decoder.tracks.selectedTrack?.frameCount ?? 1)) {
      signal.throwIfAborted()
      const { image } = await decoder.decode({ frameIndex })
      try {
        frames.push(sample(image as unknown as CanvasImageSource, image.displayWidth, image.displayHeight))
      } finally {
        image.close()
      }
    }
    return frames
  } finally {
    decoder.close()
  }
}

/** Five frames of a video (frameTimes), each after its seek; the video is emptied at the end, whatever happened. */
async function readVideo(url: string, signal: AbortSignal, sample: ReturnType<typeof sampler>): Promise<FramePixels[]> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  const reached = (event: 'loadeddata' | 'seeked') =>
    new Promise<void>((resolve, reject) => {
      const done = () => {
        forget()
        resolve()
      }
      const failed = () => {
        forget()
        reject(new Error(`the video did not decode (${video.error ? `${video.error.code} ${video.error.message}` : 'no detail'})`))
      }
      const stopped = () => {
        forget()
        reject(signal.reason)
      }
      const forget = () => {
        video.removeEventListener(event, done)
        video.removeEventListener('error', failed)
        signal.removeEventListener('abort', stopped)
      }
      video.addEventListener(event, done)
      video.addEventListener('error', failed)
      signal.addEventListener('abort', stopped)
    })
  try {
    const loaded = reached('loadeddata')
    video.src = url
    await loaded
    const frames: FramePixels[] = []
    for (const time of frameTimes(video.duration)) {
      signal.throwIfAborted()
      if (time !== video.currentTime) {
        const seeked = reached('seeked')
        video.currentTime = time
        await seeked
      }
      frames.push(sample(video, video.videoWidth, video.videoHeight))
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
