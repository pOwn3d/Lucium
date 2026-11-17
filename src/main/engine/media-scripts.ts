import { randomBytes } from 'node:crypto'
import { autoFloatVerdict } from '@shared/auto-pip'

/** What PIP_ENTER answers: whether a video floats, and if not, why (the reason is told to the user and the journal). */
export type PictureInPictureResult = { entered: true } | { entered: false; reason: 'already' | 'no-video' | 'refused'; detail?: string }

// The scripts run in a page to find its media and to float its video (Picture in Picture). Text, because they run in the page: each is tested against a made-up document
// (media-scripts.test.ts), since the engine itself needs a real Electron.

// The media of a page: every <video> and <audio> of the document, and of its open shadow trees (a player is often inside a web component).
// Also check video elements that might be hidden (Google Meet) by not filtering on visibility.
export const MEDIA_WALK = `const all = []; const walk = (root) => { for (const el of root.querySelectorAll('video, audio')) all.push(el); for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot) }; walk(document);`

/**
 * A video "can float": it is playing (not paused, not ended) and has its frames.
 * Exception: Videos with valid dimensions might be usable for PIP even if paused (e.g., Google Meet remote video feeds).
 * What the page says about it does not count: Netflix, Disney+ and others set `disablePictureInPicture` on
 * theirs, so that the browser offers no button, and the user who asks for the picture gets it all the same.
 * Gives the test, as text, for the name of the element it is written for.
 */
export const VIDEO_CAN_FLOAT = (element: string): string => `${element} instanceof HTMLVideoElement && !${element}.ended && ${element}.readyState > 2 && (!${element}.paused || (${element}.videoWidth > 0 && ${element}.videoHeight > 0))`

export const MEDIA_PROBE = `(() => { ${MEDIA_WALK}
  return { playing: all.some((m) => !m.paused && !m.ended), media: all.length > 0, video: all.some((m) => ${VIDEO_CAN_FLOAT('m')}) } })()`

// Whether there is a video to float. Asked without a user gesture: a script run with one gives the page a user activation, which for autoplay is a click
// (see `setPictureInPicture`), so a page with nothing to float must never be given one.
// The walk is the probe's: a video inside an open shadow root (a player that is a web component) is one the media player offers the picture for, so it must be found here too.
export const PIP_CAN_ENTER = `(() => { ${MEDIA_WALK}
  return !document.pictureInPictureElement && all.some((v) => ${VIDEO_CAN_FLOAT('v')}) })()`

/**
 * Floats `video`, setting the page's wish aside while it floats (see PIP_ENTER for why each way of putting the attribute back is turned into nothing),
 * and gives it back once it no longer floats. `detail` is a page expression added to the reason of a refusal.
 * A refusal is answered, not written to the console: this runs with the page's own scripts, which can read what the console is given, and the
 * application writes it in its own journal (electron-page.ts).
 */
const FLOAT_SETTING_THE_PAGE_ASIDE = (detail: string): string => `  const attribute = 'disablepictureinpicture'
  const keep = () => video.removeAttribute(attribute)
  keep()
  const named = (value) => String(value).toLowerCase() === attribute
  const setAttribute = video.setAttribute
  const toggleAttribute = video.toggleAttribute
  video.setAttribute = function (name, value) { return named(name) ? undefined : setAttribute.call(this, name, value) }
  video.toggleAttribute = function (name, force) { return named(name) ? false : toggleAttribute.call(this, name, force) }
  Object.defineProperty(video, 'disablePictureInPicture', { configurable: true, get: () => false, set: () => undefined })
  const watch = new MutationObserver(keep)
  watch.observe(video, { attributes: true, attributeFilter: [attribute] })
  // What the video does by itself again once it no longer floats.
  const release = () => { watch.disconnect(); delete video.setAttribute; delete video.toggleAttribute; delete video.disablePictureInPicture }
  video.addEventListener('leavepictureinpicture', release, { once: true })
  return video.requestPictureInPicture().then(() => ({ entered: true }), (error) => { release(); return { entered: false, reason: 'refused', detail: String(error && error.message) + ${detail} } })`

/**
 * Floats the video that can float and plays (the largest of those when several play; a paused one only when none plays). Its rendered size does
 * not count: a feed can be drawn at 0 px and still be the page's main video (Google Meet). The result says why it did not float, for the journal
 * and the user: `already`, `no-video` (with what the page holds), or `refused` (with the browser's words).
 * A page that keeps its video from floating (the attribute `disablepictureinpicture`) is set aside, and kept aside for as long as the
 * video floats: the browser closes the picture the moment the attribute is put back, before anything that watches for it can answer. So the video itself, while it floats,
 * turns the three ways a page has of putting it back (`setAttribute`, `toggleAttribute`, the property) into nothing, and a watch takes off what comes by another way.
 */
export const PIP_ENTER = `(() => { ${MEDIA_WALK}
  if (document.pictureInPictureElement) return { entered: false, reason: 'already' }
  const videos = all.filter((v) => v instanceof HTMLVideoElement)
  const label = (v) => v.videoWidth + 'x' + v.videoHeight + ' ' + (v.paused ? 'paused' : 'playing') + ' readyState ' + v.readyState + (v.srcObject ? ' stream' : ' file') + (v.disablePictureInPicture ? ' kept-from-floating' : '')
  const video = videos
    .filter((v) => ${VIDEO_CAN_FLOAT('v')})
    .sort((a, b) => Number(a.paused) - Number(b.paused) || b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0]
  if (!video) return { entered: false, reason: 'no-video', detail: videos.length + ' video(s) in the document' + (videos.length > 0 ? ': ' + videos.map(label).join('; ') : '') + '; ' + document.querySelectorAll('iframe').length + ' iframe(s) not searched' }
  ${FLOAT_SETTING_THE_PAGE_ASIDE("' (video ' + label(video) + ')'")}
})()`

/**
 * What the rule of automatic Picture in Picture reads of a video (WatchedVideoFacts, auto-pip.ts), as the text of a function of the page script.
 * Whether it carries sound: a live feed (a MediaStream) says it by its audio tracks; a file, by the audio tracks the browser lists when it lists them,
 * or else by the audio it decoded once the video has played a second (none: no audio track); a protected video (DRM, `mediaKeys`) is not asked, its
 * count is not to be trusted. A feed has no ranges played to add up: its time is how long it has played.
 */
const WATCHED_VIDEO = `const verdict = ${autoFloatVerdict.toString()};
  const facts = (v) => {
    const box = v.getBoundingClientRect()
    let played = 0
    for (let i = 0; i < v.played.length; i++) played += v.played.end(i) - v.played.start(i)
    const stream = v.srcObject && typeof v.srcObject.getAudioTracks === 'function' ? v.srcObject : null
    const audio = stream ? stream.getAudioTracks().length > 0 : v.audioTracks ? v.audioTracks.length > 0 : typeof v.webkitAudioDecodedByteCount === 'number' && !v.mediaKeys && played >= 1 ? v.webkitAudioDecodedByteCount > 0 : null
    // A page just left is hidden before this runs, and its box is 0 × 0: the size of the frames stands for it (a call's feed is drawn at 0 px then).
    const width = box.width > 0 ? box.width : v.videoWidth
    const height = box.height > 0 ? box.height : v.videoHeight
    return { playing: !v.paused && !v.ended && v.readyState > 2 && v.videoWidth > 0 && v.videoHeight > 0, muted: v.muted, volume: v.volume, audio, width, height, playedSeconds: stream ? Math.max(played, v.currentTime) : played, live: stream !== null }
  };
  const watched = (v) => v instanceof HTMLVideoElement && verdict(facts(v)) === 'float';`

/** Whether leaving the tab floats a video: one being watched (auto-pip.ts). Asked without a user gesture, as PIP_CAN_ENTER is, and for the same reason. */
export const PIP_AUTO_CAN_ENTER = `(() => { ${MEDIA_WALK} ${WATCHED_VIDEO}
  return !document.pictureInPictureElement && all.some(watched) })()`

/**
 * Floats the video being watched that takes the most room on the page, as its tab is left, setting the page's wish aside as PIP_ENTER does
 * (Netflix and Disney+ keep their videos from floating; the rule of auto-pip.ts already keeps ads and backgrounds out).
 */
export const PIP_AUTO_ENTER = `(() => { ${MEDIA_WALK} ${WATCHED_VIDEO}
  if (document.pictureInPictureElement) return { entered: false, reason: 'already' }
  const area = (v) => { const box = v.getBoundingClientRect(); return (box.width > 0 ? box.width : v.videoWidth) * (box.height > 0 ? box.height : v.videoHeight) }
  const video = all.filter(watched).sort((a, b) => area(b) - area(a))[0]
  if (!video) return { entered: false, reason: 'no-video' }
  ${FLOAT_SETTING_THE_PAGE_ASIDE("''")}
})()`

export const PIP_EXIT = `document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true, () => false) : false`

/**
 * The name of a mark left on a media element of the page. These scripts run with the page's own (a frame has no isolated world to run them
 * in), so the page can list the marks its elements carry and read their names: a name of ours would tell it which browser this is, and that
 * the user paused it or moved its level from the player. So the names are drawn when the application starts, and say nothing.
 */
const markName = (): string => JSON.stringify(randomBytes(12).toString('base64url'))
const PAUSED_MARK = markName()
const OWN_VOLUME_MARK = markName()
const PUT_VOLUME_MARK = markName()

// What a pause leaves a mark on, so that a play resumes those and not whatever else the page holds.
export const MEDIA_PAUSE = `(() => { ${MEDIA_WALK}
  const playing = all.filter((m) => !m.paused && !m.ended)
  for (const m of playing) { m[Symbol.for(${PAUSED_MARK})] = true; m.pause() }
  return playing.length > 0 })()`
export const MEDIA_PLAY = `(() => { ${MEDIA_WALK}
  const mark = Symbol.for(${PAUSED_MARK})
  let targets = all.filter((m) => m[mark] && m.paused)
  if (targets.length === 0) { const first = all.find((m) => m.paused && (m.currentSrc || m.srcObject)); targets = first ? [first] : [] }
  for (const m of targets) delete m[mark]
  return Promise.all(targets.map((m) => m.play().then(() => true, () => false))).then((done) => done.some(Boolean)) })()`
/**
 * The media of a frame (an embedded player) turned to `volume` times what the page set: once, when the slider moves. The page's own level is
 * remembered on the element; a level the page changed since is taken as the new own level. Media the frame starts later are not reached.
 */
export function frameVolumeScript(volume: number): string {
  return `(() => { ${MEDIA_WALK}
    const own = Symbol.for(${OWN_VOLUME_MARK}), put = Symbol.for(${PUT_VOLUME_MARK})
    for (const m of all) {
      if (m[own] === undefined || Math.abs(m.volume - m[put]) > 1e-6) m[own] = m.volume
      m[put] = Math.min(1, Math.max(0, m[own] * ${volume}))
      m.volume = m[put]
    }
    return all.length })()`
}
