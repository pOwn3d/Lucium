// The scripts of Lucium's floating video window (shell/floating-video.ts, shared/floating-video.ts), run in the page in a world of their own
// (FLOATING_WORLD): the page can neither see them nor undo them by its own means. They find the video, bring it to fill the page where it is,
// read it and drive it, and give the page back as it was. Text, because they run in the page: each is tested against a made-up document
// (floating-video-scripts.test.ts), since the engine itself needs a real Electron.
//
// Why the video is not moved: the tab's own view is lent to the floating window (Page.lendView), so the video stays in its document, in its player,
// with its protection (Widevine) and the page's scripts still driving it. It is brought to fill the view in place: its player (the video and the
// part of the page around it that is about its size, where the site draws its subtitles) is put in the top layer (a `popover` shown by the script),
// above everything else of the page, at the size of the view. Nothing of the document is moved, so a player that draws itself again (React) keeps
// its elements; a video it replaces is followed (a mutation observer).
//
// The site's own controls do not come along: the bar of Lucium's window is the only one (two bars, the site's over the video and Lucium's at the
// foot, was the report on Twitch). What is about the video in that player and holds something to press or drag is hidden (`CONTROLS`), by what it
// is (a button, a slider, a link) and not by a class of one site, which the site changes; subtitles and the text a page draws stay.

import type { VideoCommand } from '@shared/floating-video'
import { FLOATING_LIVE_LAG_SECONDS } from '@shared/floating-video'
import { MEDIA_WALK, VIDEO_CAN_FLOAT } from './media-scripts'

/** The isolated world of these scripts (the other worlds of Lucium: 4_200_017 to 4_200_097, see `*_WORLD`). */
export const FLOATING_WORLD = 4_200_053

/** A seekable range that starts later than this is a live stream's sliding window, not a recorded video's. */
export const LIVE_WINDOW_START_SECONDS = 2

/** Where the controller of the floating video is kept, in the script's world. */
const KEY = `Symbol.for('lucium.floating-video')`

/**
 * Whether the video is a live stream. Most players report an infinite duration; others (Twitch) report a finite one that keeps growing and play a
 * sliding window: what can be reached does not start at the beginning of the stream any more. A recorded video's range starts at 0.
 */
const IS_LIVE = `const isLive = (v) => {
    if (v.duration === Infinity) return true
    if (!Number.isFinite(v.duration) || !v.seekable || v.seekable.length === 0) return false
    return v.seekable.start(0) > ${LIVE_WINDOW_START_SECONDS}
  }`

/** The video that floats: the one PIP_ENTER would float (one that plays before a paused one, the largest first). */
const CHOOSE = `const choose = () => { ${MEDIA_WALK}
    return all.filter((v) => ${VIDEO_CAN_FLOAT('v')}).sort((a, b) => Number(a.paused) - Number(b.paused) || b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0] }`

/**
 * The video that takes the place of one the page replaced: one that can float as above, or else the largest video of the page, still loading (a
 * player that draws itself again puts in a video with nothing decoded yet, and nothing in the document changes once it has).
 */
const SUCCESSOR = `const successor = () => { const ready = choose(); if (ready) return ready; ${MEDIA_WALK}
    const area = (v) => { const box = v.getBoundingClientRect(); return box.width * box.height }
    return all.filter((v) => v instanceof HTMLVideoElement && v.isConnected).sort((a, b) => area(b) - area(a))[0] }`

/** Whether the page itself (its document and its open shadow trees, not its frames) has a video to float. Asked without a user gesture. */
export const FLOAT_FIND = `(() => { ${CHOOSE}
  return choose() !== undefined })()`

/**
 * A player is an ancestor of the video at most this much larger than the video, in each direction: the site's box around the video, which holds the
 * subtitles it draws as text (not the page around it, which is larger), and that holds nothing larger than that beside the video (content of the page
 * under or beside the player is not the player, even in a box about the video's size).
 */
export const STAGE_SLACK = 1.25

/**
 * What a control of a site's player is made of, whatever its classes: something to press, drag, choose or type in. A box of the player that is not
 * the video's own and holds one of these is the site's bar of controls (Twitch's, YouTube's), and is hidden while the video floats.
 */
export const CONTROLS = 'button, input, select, textarea, a[href], [role="button"], [role="slider"], [role="switch"], [role="menu"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="toolbar"], [role="tablist"]'

/**
 * Brings the video to fill the page: its player goes into the top layer at the size of the view, the video fills it (letterboxed). Answers
 * `{ staged: true, width, height, live, protected }` (the size of its frames, for the proportions of the window), or `{ staged: false, reason }`.
 * Staged again, it answers the same without doing anything twice.
 *
 * The styles are put on the elements themselves with `!important` (a page's own rule cannot win over them, and a player in a shadow tree is reached
 * too), and the page's own values are kept to be given back. A mutation observer watches the document: when the page puts its own styles back,
 * hides the player, or replaces the video (a player that draws itself again), the video is staged again; while it watches, it stops itself so that
 * what it does is not taken for the page.
 */
export const FLOAT_STAGE = `(() => {
  const key = ${KEY}
  if (self[key]) return self[key].info()
  ${CHOOSE}
  ${SUCCESSOR}
  ${IS_LIVE}
  const first = choose()
  if (!first) return { staged: false, reason: 'no-video' }
  const STAGE = { position: 'fixed', top: '0px', right: '0px', bottom: '0px', left: '0px', width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none', 'min-width': '0px', 'min-height': '0px', margin: '0px', padding: '0px', 'border-style': 'none', transform: 'none', overflow: 'hidden', 'box-sizing': 'border-box', 'background-color': 'black', 'z-index': '2147483647' }
  const VIDEO = { position: 'fixed', top: '0px', left: '0px', width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none', margin: '0px', transform: 'none', 'object-fit': 'contain' }
  const parentOf = (el) => {
    if (el.parentElement) return el.parentElement
    const root = el.getRootNode ? el.getRootNode() : null
    return root && root !== document && root.host ? root.host : null
  }
  const stageOf = (video) => {
    const box = video.getBoundingClientRect()
    let stage = video
    for (let el = parentOf(video); el && el !== document.body && el !== document.documentElement; el = parentOf(el)) {
      const around = el.getBoundingClientRect()
      if (around.width > box.width * ${STAGE_SLACK} + 2 || around.height > box.height * ${STAGE_SLACK} + 2) break
      // A box that also holds content of the page beside the player (a child much larger than the video: the channel under it, the page's column) is
      // the page, even when the video nearly fills the window and the box is about its size: the player stops below it.
      if (Array.from(el.children || []).some((child) => {
        if (child === stage) return false
        const own = child.getBoundingClientRect()
        return own.width > box.width * ${STAGE_SLACK} + 2 || own.height > box.height * ${STAGE_SLACK} + 2
      })) break
      // An element the page already uses as a popover is the page's: the player stops below it.
      if (el.hasAttribute('popover')) break
      stage = el
    }
    return stage
  }
  const HIDDEN = { display: 'none' }
  const CONTROLS = ${JSON.stringify(CONTROLS)}
  // The boxes of the player (below it, not the ones the video is in) that hold a control of the site: its bar, its click catcher, its gradients.
  const controlsOf = (el, video, found) => {
    for (const child of Array.from(el.children || [])) {
      if (child === video) continue
      if (child.contains(video)) controlsOf(child, video, found)
      else if (child.matches(CONTROLS) || child.querySelector(CONTROLS)) found.push(child)
    }
    return found
  }
  // The page's own values of what is set, kept to be given back: [property, value, priority].
  const put = (el, styles, saved) => {
    for (const name of Object.keys(styles)) {
      if (saved && !saved.some((entry) => entry[0] === name)) saved.push([name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)])
      el.style.setProperty(name, styles[name], 'important')
    }
  }
  const giveBack = (el, saved) => {
    for (const [name, value, priority] of saved) {
      if (value === '') el.style.removeProperty(name)
      else el.style.setProperty(name, value, priority)
    }
  }
  let current = null
  const observer = new MutationObserver((records) => reconcile(records))
  const watch = () => {
    observer.observe(document, { childList: true, subtree: true })
    if (!current) return
    for (const el of [current.stage, current.video]) observer.observe(el, { attributes: true, attributeFilter: ['style', 'popover', 'hidden'] })
    for (const hidden of current.hidden) observer.observe(hidden.el, { attributes: true, attributeFilter: ['style'] })
    const root = current.video.getRootNode ? current.video.getRootNode() : null
    if (root && root !== document) observer.observe(root, { childList: true, subtree: true })
  }
  // Hides the site's controls found now (a bar the player draws again is found again), and puts back the hiding the page took off.
  const sweep = () => {
    if (!current) return
    for (const el of controlsOf(current.stage, current.video, [])) {
      let entry = current.hidden.find((hidden) => hidden.el === el)
      if (!entry) {
        entry = { el, saved: [] }
        current.hidden.push(entry)
      }
      put(el, HIDDEN, entry.saved)
    }
  }
  const show = () => {
    if (!current) return
    try {
      if (!current.stage.matches(':popover-open')) current.stage.showPopover()
    } catch (error) {
      console.warn('[lucium] the floating player could not be put above the page: ' + (error && error.message))
    }
  }
  const onToggle = (event) => {
    // The page closed the player's top layer (hidePopover): it is opened again once the event is over.
    if (current && event && event.newState === 'closed') queueMicrotask(() => { if (current) show() })
  }
  const stage = (video) => {
    const el = stageOf(video)
    const added = !el.hasAttribute('popover')
    const entry = { video, stage: el, added, stageSaved: [], videoSaved: [], hidden: [] }
    current = entry
    // No attribute marks the player or the video: the page reads its own elements, and a mark of ours would name the browser to it.
    if (added) el.setAttribute('popover', 'manual')
    put(el, STAGE, entry.stageSaved)
    if (el !== video) put(video, VIDEO, entry.videoSaved)
    el.addEventListener('toggle', onToggle)
    sweep()
    show()
  }
  const unstage = () => {
    const entry = current
    if (!entry) return
    current = null
    entry.stage.removeEventListener('toggle', onToggle)
    try {
      if (entry.stage.matches(':popover-open')) entry.stage.hidePopover()
    } catch (error) {
      console.warn('[lucium] the floating player could not leave the top layer: ' + (error && error.message))
    }
    if (entry.added) entry.stage.removeAttribute('popover')
    giveBack(entry.stage, entry.stageSaved)
    if (entry.stage !== entry.video) giveBack(entry.video, entry.videoSaved)
    for (const hidden of entry.hidden) giveBack(hidden.el, hidden.saved)
  }
  const reconcile = (records) => {
    observer.disconnect()
    try {
      if (!current) {
        const next = successor()
        if (next) stage(next)
      } else if (!current.video.isConnected) {
        // The player drew itself again: the video that took the old one's place floats; with none yet, the observer waits for it.
        unstage()
        const next = successor()
        if (next) stage(next)
      } else if (!current.stage.isConnected || (current.stage !== current.video && !current.stage.contains(current.video))) {
        const video = current.video
        unstage()
        stage(video)
      } else if (records.some((record) => record.type === 'attributes')) {
        put(current.stage, STAGE, null)
        if (current.stage !== current.video) put(current.video, VIDEO, null)
        if (current.added && !current.stage.hasAttribute('popover')) current.stage.setAttribute('popover', 'manual')
        show()
      }
      // What changed in the player (a bar drawn again, a style the page put back) is looked at again; the chat of a page changing is not.
      if (current && records.some((record) => !record.target || current.stage.contains(record.target))) sweep()
    } finally {
      if (self[key]) watch()
    }
  }
  stage(first)
  const controller = {
    video: () => (current ? current.video : null),
    /** Looks again for a video when there is none (the window reads it while its bar is on screen). */
    retry: () => reconcile([]),
    info: () => {
      const v = current ? current.video : null
      return v ? { staged: true, width: v.videoWidth, height: v.videoHeight, live: isLive(v), protected: !!v.mediaKeys } : { staged: false, reason: 'no-video' }
    },
    end: () => {
      observer.disconnect()
      unstage()
    }
  }
  self[key] = controller
  watch()
  return controller.info()
})()`

/** Gives the page back as it was: the player leaves the top layer and the elements get their own styles again. True when something was staged. */
export const FLOAT_UNSTAGE = `(() => {
  const key = ${KEY}
  const controller = self[key]
  if (!controller) return false
  delete self[key]
  controller.end()
  return true
})()`

/** What the bar shows of the video (shared/floating-video.ts, FloatingVideoFacts), or null when there is none to read. */
export const FLOAT_FACTS = `(() => {
  ${IS_LIVE}
  const controller = self[${KEY}]
  if (controller && !(controller.video() && controller.video().isConnected)) controller.retry()
  const v = controller ? controller.video() : null
  if (!v || !v.isConnected) return null
  const live = isLive(v)
  let behindLive = false
  if (live && v.seekable && v.seekable.length > 0) behindLive = v.seekable.end(v.seekable.length - 1) - v.currentTime > ${FLOATING_LIVE_LAG_SECONDS}
  return { paused: v.paused, ended: v.ended, muted: v.muted, volume: v.volume, currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, live, behindLive, protected: !!v.mediaKeys, width: v.videoWidth, height: v.videoHeight }
})()`

/**
 * Does `command` to the floating video, as the bar asked: true when it was done. A jump in time is refused for a live stream or a protected video
 * (see `canSeek`), whatever was asked. The command is one the window built (`VideoCommand`): it is written into the script as data.
 */
export function floatCommandScript(command: VideoCommand): string {
  return `(() => {
  const controller = self[${KEY}]
  const v = controller ? controller.video() : null
  if (!v) return false
  ${IS_LIVE}
  const command = ${JSON.stringify(command)}
  switch (command.kind) {
    case 'toggle':
      if (v.paused || v.ended) return Promise.resolve(v.play()).then(() => true, () => false)
      v.pause()
      return true
    case 'pause':
      v.pause()
      return true
    case 'unmute':
      v.muted = false
      if (v.volume === 0) v.volume = 0.5
      return true
    case 'volume':
      v.volume = Math.min(1, Math.max(0, command.value))
      if (command.value > 0) v.muted = false
      return true
    case 'seek':
      if (!Number.isFinite(v.duration) || isLive(v) || v.mediaKeys) return false
      v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + command.seconds))
      return true
    case 'live':
      if (!v.seekable || v.seekable.length === 0) return false
      v.currentTime = v.seekable.end(v.seekable.length - 1)
      return true
  }
  return false
})()`
}
