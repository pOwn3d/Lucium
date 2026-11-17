// The scripts that find the video of a page and float it, run against a made-up document: which video floats, and what is done about a page that keeps it from floating
// (Netflix does: the user asked for the picture, and gets it).

import { describe, expect, it, vi } from 'vitest'
import { MEDIA_PROBE, PIP_AUTO_CAN_ENTER, PIP_AUTO_ENTER, PIP_CAN_ENTER, PIP_ENTER, PIP_EXIT, VIDEO_CAN_FLOAT } from './media-scripts'

/** A video as the browser has it: the attribute and the property are one thing, and its methods are those of its prototype. */
class FakeVideoElement {
  attributes = new Set<string>()
  setAttribute(name: string, _value?: string) {
    this.attributes.add(name.toLowerCase())
  }
  removeAttribute(name: string) {
    this.attributes.delete(name.toLowerCase())
  }
  hasAttribute(name: string) {
    return this.attributes.has(name.toLowerCase())
  }
  // As in the browser, these reach the attributes themselves: they do not go through the `setAttribute` of the element, which a page (or the script) may have replaced.
  toggleAttribute(name: string, force?: boolean) {
    const on = force ?? !this.attributes.has(name.toLowerCase())
    if (on) this.attributes.add(name.toLowerCase())
    else this.attributes.delete(name.toLowerCase())
    return on
  }
  get disablePictureInPicture() {
    return this.attributes.has('disablepictureinpicture')
  }
  set disablePictureInPicture(value: boolean) {
    if (value) this.attributes.add('disablepictureinpicture')
    else this.attributes.delete('disablepictureinpicture')
  }
}

class FakeObserver {
  static all: FakeObserver[] = []
  disconnected = false
  watched: unknown[] = []
  constructor(private readonly callback: () => void) {
    FakeObserver.all.push(this)
  }
  observe(element: unknown, options: unknown) {
    this.watched.push([element, options])
  }
  disconnect() {
    this.disconnected = true
  }
  fire() {
    this.callback()
  }
}

interface VideoOptions {
  paused?: boolean
  ended?: boolean
  readyState?: number
  width?: number
  height?: number
  /** The page keeps the video from floating. */
  keptFromFloating?: boolean
  refuses?: string
  /** A live feed (a MediaStream), as Google Meet's remote videos are; `streamAudio` says whether it carries an audio track. */
  stream?: boolean
  streamAudio?: boolean
  muted?: boolean
  volume?: number
  /** Its box on the page, in CSS pixels (by default, that of its frames). */
  box?: { width: number; height: number }
  /** The seconds it has played (one range from 0); by default a minute. */
  played?: number
  /** The audio the browser decoded, in bytes; by default some. */
  audioBytes?: number
  /** A protected video (DRM). */
  protectedMedia?: boolean
}

function video(options: VideoOptions = {}) {
  const listeners: Record<string, () => void> = {}
  const element = Object.assign(new FakeVideoElement(), {
    paused: options.paused ?? false,
    ended: options.ended ?? false,
    readyState: options.readyState ?? 4,
    videoWidth: options.width ?? 1280,
    videoHeight: options.height ?? 720,
    muted: options.muted ?? false,
    volume: options.volume ?? 1,
    currentTime: options.played ?? 60,
    played: { length: 1, start: () => 0, end: () => options.played ?? 60 },
    webkitAudioDecodedByteCount: options.audioBytes ?? 48000,
    mediaKeys: options.protectedMedia ? {} : null,
    getBoundingClientRect: () => options.box ?? { width: options.width ?? 1280, height: options.height ?? 720 },
    requestPictureInPicture: vi.fn(() => (options.refuses ? Promise.reject(new Error(options.refuses)) : Promise.resolve({}))),
    addEventListener: (type: string, listener: () => void) => void (listeners[type] = listener),
    leave: () => listeners['leavepictureinpicture']?.()
  })
  if (options.stream) Object.assign(element, { srcObject: { getAudioTracks: () => (options.streamAudio ? [{}] : []) }, played: { length: 0, start: () => 0, end: () => 0 } })
  if (options.keptFromFloating) element.disablePictureInPicture = true
  return element
}

/** Runs one of the scripts in a document that holds these videos (and `floating`, the one that floats already, if any). */
function run(script: string, videos: ReturnType<typeof video>[], floating?: unknown, shadowVideos: ReturnType<typeof video>[] = []) {
  const exit = vi.fn(() => Promise.resolve())
  // `shadowVideos` sit inside the open shadow root of one element of the document (a player made as a web component).
  const host = { shadowRoot: { querySelectorAll: (selector: string) => (selector === '*' ? [] : shadowVideos) } }
  const document = {
    pictureInPictureElement: floating,
    exitPictureInPicture: exit,
    querySelectorAll: (selector: string) => (selector === '*' ? (shadowVideos.length > 0 ? [host] : []) : videos)
  }
  const warn = vi.fn()
  FakeObserver.all = []
  const result = new Function('document', 'HTMLVideoElement', 'MutationObserver', 'console', `return ${script}`)(document, FakeVideoElement, FakeObserver, { warn })
  return { result, warn, exit, observers: FakeObserver.all }
}

describe('a video that can float', () => {
  it('is one that plays and has its frames, whatever the page says about floating it', () => {
    expect(run(PIP_CAN_ENTER, [video()]).result).toBe(true)
    expect(run(PIP_CAN_ENTER, [video({ keptFromFloating: true })]).result).toBe(true)
  })

  it('is not one without frames, ended, invalid, or paused without dimensions', () => {
    // Paused videos with valid dimensions (like Google Meet) CAN float
    expect(run(PIP_CAN_ENTER, [video({ paused: true, width: 0, height: 0 })]).result, JSON.stringify({ paused: true, noDims: true })).toBe(false)
    for (const options of [{ ended: true }, { readyState: 2 }, { readyState: 0 }]) expect(run(PIP_CAN_ENTER, [video(options)]).result, JSON.stringify(options)).toBe(false)
    expect(run(PIP_CAN_ENTER, []).result).toBe(false)
  })

  it('finds a video inside an open shadow root, as the page probe does (the media player offers the picture for it)', async () => {
    const inside = video()
    expect(run(PIP_CAN_ENTER, [], undefined, [inside]).result).toBe(true)
    await expect(run(PIP_ENTER, [], undefined, [inside]).result).resolves.toEqual({ entered: true })
    expect(inside.requestPictureInPicture).toHaveBeenCalledTimes(1)
    // The largest of all of them floats, whichever tree it is in.
    const outside = video({ width: 320, height: 180 })
    const large = video({ width: 1920, height: 1080 })
    await run(PIP_ENTER, [outside], undefined, [large]).result
    expect(large.requestPictureInPicture).toHaveBeenCalled()
    expect(outside.requestPictureInPicture).not.toHaveBeenCalled()
  })

  it('is not asked about again once a video floats', () => {
    expect(run(PIP_CAN_ENTER, [video()], {}).result).toBe(false)
  })

  it('gives the test that the page probe and the script of the picture share', () => {
    expect(VIDEO_CAN_FLOAT('m')).toContain('m.readyState > 2')
    expect(MEDIA_PROBE).toContain(VIDEO_CAN_FLOAT('m'))
    expect(PIP_ENTER).toContain(VIDEO_CAN_FLOAT('v'))
    expect(PIP_CAN_ENTER).toContain(VIDEO_CAN_FLOAT('v'))
  })

  it('is told to the media player as one that floats even when the page keeps it from floating (the player is for what cannot)', () => {
    const document = { querySelectorAll: (selector: string) => (selector === '*' ? [] : [video({ keptFromFloating: true })]) }
    const probe = new Function('document', 'HTMLVideoElement', `return ${MEDIA_PROBE}`)(document, FakeVideoElement)
    expect(probe).toEqual({ playing: true, media: true, video: true })
  })
})

describe('floating the video', () => {
  it('floats a video the page keeps from floating (Netflix), and sets the page\'s wish aside', async () => {
    const netflix = video({ keptFromFloating: true })
    const { result } = run(PIP_ENTER, [netflix])
    await expect(result).resolves.toEqual({ entered: true })
    expect(netflix.requestPictureInPicture).toHaveBeenCalledTimes(1)
    expect(netflix.hasAttribute('disablepictureinpicture')).toBe(false)
  })

  it('floats the largest of the videos that can', async () => {
    const small = video({ width: 320, height: 180 })
    const large = video({ width: 1920, height: 1080 })
    const bigger = video({ width: 3840, height: 2160 })
    await run(PIP_ENTER, [small, large, bigger]).result
    expect(bigger.requestPictureInPicture).toHaveBeenCalled()
    expect(large.requestPictureInPicture).not.toHaveBeenCalled()
    expect(small.requestPictureInPicture).not.toHaveBeenCalled()
  })

  it("floats the video that plays, the page's main one (a Meet stream at 1280), not a paused source of width 0", async () => {
    const source = video({ width: 0, height: 0, paused: true })
    const feed = video({ width: 1280, height: 720, stream: true })
    const { result } = run(PIP_ENTER, [source, feed])
    await expect(result).resolves.toEqual({ entered: true })
    expect(feed.requestPictureInPicture).toHaveBeenCalledTimes(1)
    expect(source.requestPictureInPicture).not.toHaveBeenCalled()
  })

  it('prefers a video that plays to a bigger one that is paused, and takes a paused one only when none plays', async () => {
    const paused = video({ width: 3840, height: 2160, paused: true })
    const playing = video({ width: 1280, height: 720 })
    await run(PIP_ENTER, [paused, playing]).result
    expect(playing.requestPictureInPicture).toHaveBeenCalled()
    expect(paused.requestPictureInPicture).not.toHaveBeenCalled()
    const alone = video({ width: 3840, height: 2160, paused: true })
    await expect(run(PIP_ENTER, [alone]).result).resolves.toEqual({ entered: true })
    expect(alone.requestPictureInPicture).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is nothing to float, or one floats already, and says why', () => {
    expect(run(PIP_ENTER, []).result).toMatchObject({ entered: false, reason: 'no-video', detail: '0 video(s) in the document; 0 iframe(s) not searched' })
    // A video without dimensions (like a placeholder) should not float even if it has frames
    expect(run(PIP_ENTER, [video({ paused: true, width: 0, height: 0 })]).result).toMatchObject({ entered: false, reason: 'no-video' })
    const other = video()
    expect(run(PIP_ENTER, [other], {}).result).toEqual({ entered: false, reason: 'already' })
    expect(other.requestPictureInPicture).not.toHaveBeenCalled()
  })

  it('keeps the page from taking the picture back while it floats, by any of the three ways it has, and leaves it its other attributes', async () => {
    const netflix = video({ keptFromFloating: true })
    await run(PIP_ENTER, [netflix]).result
    netflix.setAttribute('disablePictureInPicture', '')
    expect(netflix.hasAttribute('disablepictureinpicture')).toBe(false)
    netflix.toggleAttribute('disablepictureinpicture')
    expect(netflix.hasAttribute('disablepictureinpicture')).toBe(false)
    netflix.disablePictureInPicture = true
    expect(netflix.hasAttribute('disablepictureinpicture')).toBe(false)
    expect(netflix.disablePictureInPicture).toBe(false)
    // What is not about the picture goes through as it did.
    netflix.setAttribute('class', 'player')
    expect(netflix.hasAttribute('class')).toBe(true)
    expect(netflix.toggleAttribute('muted')).toBe(true)
    expect(netflix.hasAttribute('muted')).toBe(true)
  })

  it('takes off the attribute that comes by another way, with a watch on the video that ends with the picture', async () => {
    const netflix = video({ keptFromFloating: true })
    const { result, observers } = run(PIP_ENTER, [netflix])
    await result
    expect(observers).toHaveLength(1)
    expect(observers[0]!.watched).toEqual([[netflix, { attributes: true, attributeFilter: ['disablepictureinpicture'] }]])
    // A way the video does not answer (the attributes of an element built again): the watch takes it off.
    netflix.attributes.add('disablepictureinpicture')
    observers[0]!.fire()
    expect(netflix.hasAttribute('disablepictureinpicture')).toBe(false)
    netflix.leave()
    expect(observers[0]!.disconnected).toBe(true)
  })

  it('gives the page its video back as it was once the picture is closed: its wish counts again', async () => {
    const netflix = video({ keptFromFloating: true })
    await run(PIP_ENTER, [netflix]).result
    netflix.leave()
    netflix.setAttribute('disablepictureinpicture', '')
    expect(netflix.hasAttribute('disablepictureinpicture')).toBe(true)
    expect(netflix.disablePictureInPicture).toBe(true)
    netflix.removeAttribute('disablepictureinpicture')
    netflix.toggleAttribute('disablepictureinpicture')
    expect(netflix.disablePictureInPicture).toBe(true)
  })

  it("says why when the picture is refused, with the browser's words, and stops watching", async () => {
    const refusing = video({ refuses: 'Internal error: no window' })
    const { result, warn, observers } = run(PIP_ENTER, [refusing])
    await expect(result).resolves.toMatchObject({ entered: false, reason: 'refused', detail: expect.stringContaining('Internal error: no window') })
    // Nothing goes to the console of the page, which its scripts can read: the answer carries the reason.
    expect(warn).not.toHaveBeenCalled()
    expect(observers[0]!.disconnected).toBe(true)
    // The video is the page's again at once: nothing floats.
    refusing.setAttribute('disablepictureinpicture', '')
    expect(refusing.hasAttribute('disablepictureinpicture')).toBe(true)
  })

  it('leaves the picture when asked, and says whether there was one', async () => {
    const floating = run(PIP_EXIT, [], {})
    await expect(floating.result).resolves.toBe(true)
    expect(floating.exit).toHaveBeenCalledTimes(1)
    const none = run(PIP_EXIT, [])
    expect(none.result).toBe(false)
    expect(none.exit).not.toHaveBeenCalled()
  })
})

describe('the picture that floats by itself when the tab is left', () => {
  // A tab just left is hidden before its video is measured: the box is 0 × 0, and the video of a call (a live feed) would not float. Its own size
  // (the frames it carries) stands for the box then.
  it('floats a video of a tab just left, measured at 0 × 0 once hidden, by the size of its frames', async () => {
    const hidden = video({ box: { width: 0, height: 0 }, width: 1280, height: 720, stream: true, streamAudio: true })
    expect(run(PIP_AUTO_CAN_ENTER, [hidden]).result).toBe(true)
    await expect(run(PIP_AUTO_ENTER, [hidden]).result).resolves.toEqual({ entered: true })
  })

  it('floats a video watched with sound', async () => {
    const film = video()
    expect(run(PIP_AUTO_CAN_ENTER, [film]).result).toBe(true)
    await expect(run(PIP_AUTO_ENTER, [film]).result).resolves.toEqual({ entered: true })
    expect(film.requestPictureInPicture).toHaveBeenCalledTimes(1)
  })

  it('leaves alone the muted loop at the back of the page, and a loop that has no sound at all', () => {
    expect(run(PIP_AUTO_CAN_ENTER, [video({ muted: true, box: { width: 1440, height: 810 } })]).result).toBe(false)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ audioBytes: 0, box: { width: 1440, height: 810 } })]).result).toBe(false)
  })

  it('leaves alone a short ad that plays muted in its box, and the same ad with its sound on', () => {
    expect(run(PIP_AUTO_CAN_ENTER, [video({ muted: true, box: { width: 300, height: 250 }, played: 8 })]).result).toBe(false)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ box: { width: 300, height: 250 }, played: 8 })]).result).toBe(false)
  })

  it('leaves alone a tiny video, a paused one, one turned down to nothing, and one that has only just started', () => {
    expect(run(PIP_AUTO_CAN_ENTER, [video({ box: { width: 160, height: 90 } })]).result).toBe(false)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ paused: true })]).result).toBe(false)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ volume: 0 })]).result).toBe(false)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ played: 1 })]).result).toBe(false)
  })

  it("sets the page's wish aside, as the picture asked for by hand does: a film watched on a site that keeps it from floating (Netflix) floats", async () => {
    const netflix = video({ keptFromFloating: true })
    expect(run(PIP_AUTO_CAN_ENTER, [netflix]).result).toBe(true)
    await expect(run(PIP_AUTO_ENTER, [netflix]).result).resolves.toEqual({ entered: true })
    expect(netflix.requestPictureInPicture).toHaveBeenCalledTimes(1)
    expect(netflix.hasAttribute('disablepictureinpicture')).toBe(false)
  })

  it('gives a video the benefit of the doubt when the browser cannot tell its sound: a protected one (DRM) is not judged by the audio it decoded', () => {
    expect(run(PIP_AUTO_CAN_ENTER, [video({ protectedMedia: true, audioBytes: 0 })]).result).toBe(true)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ audioBytes: 0 })]).result).toBe(false)
  })

  it('floats the feed of a video call (Google Meet) though its element is muted and carries no audio track, once it has played a while', () => {
    expect(run(PIP_AUTO_CAN_ENTER, [video({ stream: true, streamAudio: true })]).result).toBe(true)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ stream: true, streamAudio: false })]).result).toBe(true)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ stream: true, streamAudio: false, muted: true })]).result).toBe(true)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ stream: true, streamAudio: false, muted: true, box: { width: 120, height: 68 } })]).result).toBe(false)
    expect(run(PIP_AUTO_CAN_ENTER, [video({ stream: true, streamAudio: true, played: 1 })]).result).toBe(false)
  })

  it('floats the watched video that takes the most room on the page, not a bigger one that is muted', async () => {
    const backdrop = video({ muted: true, box: { width: 1920, height: 1080 } })
    const small = video({ box: { width: 480, height: 270 } })
    const player = video({ width: 640, height: 360, box: { width: 960, height: 540 } })
    await expect(run(PIP_AUTO_ENTER, [backdrop, small, player]).result).resolves.toEqual({ entered: true })
    expect(player.requestPictureInPicture).toHaveBeenCalledTimes(1)
    expect(small.requestPictureInPicture).not.toHaveBeenCalled()
    expect(backdrop.requestPictureInPicture).not.toHaveBeenCalled()
  })

  it('does nothing once a video floats, and says why when the picture is refused', async () => {
    expect(run(PIP_AUTO_CAN_ENTER, [video()], {}).result).toBe(false)
    expect(run(PIP_AUTO_ENTER, [video()], {}).result).toEqual({ entered: false, reason: 'already' })
    await expect(run(PIP_AUTO_ENTER, [video({ refuses: 'no window' })]).result).resolves.toMatchObject({ entered: false, reason: 'refused', detail: 'no window' })
  })
})
