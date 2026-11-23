// What the bar of Lucium's floating video window shows and does (shared/floating-video.ts): a live stream against a recorded video, the keys, the
// sound (the tab's, which the sidebar shows), what a message of the bar may ask, where the window opens, and when the bar hides.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BarVisibility,
  FLOATING_BAR_HIDE_MS,
  FLOATING_COMPACT_WIDTH,
  FLOATING_DEFAULT_WIDTH,
  FLOATING_EDGE,
  FLOATING_MIN_WIDTH,
  canSeek,
  clockText,
  compactBar,
  dragTarget,
  floatingBounds,
  floatingKeyCommand,
  muteSteps,
  parseFacts,
  parseFloatingCommand,
  soundCut,
  takesSitePip,
  timeText,
  type FloatingVideoFacts
} from './floating-video'

const recorded = (over: Partial<FloatingVideoFacts> = {}): FloatingVideoFacts => ({
  paused: false,
  ended: false,
  muted: false,
  volume: 0.8,
  currentTime: 125,
  duration: 2470,
  live: false,
  behindLive: false,
  protected: false,
  width: 1920,
  height: 1080,
  ...over
})
const live = (over: Partial<FloatingVideoFacts> = {}): FloatingVideoFacts => recorded({ duration: null, live: true, currentTime: 8000, ...over })

describe('a message of the bar', () => {
  it('is passed on when it is one of the commands, as it was sent', () => {
    for (const command of [{ kind: 'toggle' }, { kind: 'mute' }, { kind: 'live' }, { kind: 'back' }, { kind: 'close' }, { kind: 'pin' }, { kind: 'volume', value: 0 }, { kind: 'volume', value: 1 }, { kind: 'seek', seconds: -10 }, { kind: 'seek', seconds: 10 }, { kind: 'watch', on: true }, { kind: 'drag', phase: 'start', x: 812, y: 430 }, { kind: 'drag', phase: 'move', x: -40, y: 0 }, { kind: 'drag', phase: 'end', x: 0, y: 1200 }]) {
      expect(parseFloatingCommand(command), JSON.stringify(command)).toEqual(command)
    }
  })

  it('is refused otherwise: another kind, a volume out of 0 to 1 or not a number, a jump other than 10 s, a watch that is not a yes or a no', () => {
    for (const raw of [null, 'toggle', 42, {}, { kind: 'eval' }, { kind: 'volume', value: 1.5 }, { kind: 'volume', value: -0.1 }, { kind: 'volume', value: Number.NaN }, { kind: 'volume', value: '0.5' }, { kind: 'seek', seconds: 600 }, { kind: 'seek', seconds: '10' }, { kind: 'watch', on: 1 }, { kind: 'drag', phase: 'sideways', x: 1, y: 1 }, { kind: 'drag', phase: 'move', x: '12', y: 1 }, { kind: 'drag', phase: 'move', x: Number.NaN, y: 1 }, { kind: 'drag', phase: 'move', x: 1, y: Number.POSITIVE_INFINITY }, { kind: 'drag', phase: 'move', x: 1e9, y: 1 }, { kind: 'drag', x: 1, y: 1 }, { kind: 'drag', phase: 'move', x: 1 }]) {
      expect(parseFloatingCommand(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('carries nothing but the command: an extra field of the sender is left behind', () => {
    expect(parseFloatingCommand({ kind: 'toggle', script: 'alert(1)' })).toEqual({ kind: 'toggle' })
    expect(parseFloatingCommand({ kind: 'volume', value: 0.5, extra: true })).toEqual({ kind: 'volume', value: 0.5 })
    expect(parseFloatingCommand({ kind: 'drag', phase: 'move', x: 5, y: 6, extra: true })).toEqual({ kind: 'drag', phase: 'move', x: 5, y: 6 })
  })

  it('rounds the position of a drag to whole points of the screen', () => {
    expect(parseFloatingCommand({ kind: 'drag', phase: 'move', x: 10.6, y: -3.4 })).toEqual({ kind: 'drag', phase: 'move', x: 11, y: -3 })
  })
})

describe('moving the window by the video', () => {
  it('follows the pointer: the window goes where it was, by the distance the pointer went since the drag began', () => {
    expect(dragTarget({ x: 1000, y: 600 }, { x: 1200, y: 700 }, { x: 1150, y: 760 })).toEqual({ x: 950, y: 660 })
    expect(dragTarget({ x: 1000, y: 600 }, { x: 1200, y: 700 }, { x: 1200, y: 700 })).toEqual({ x: 1000, y: 600 })
  })
})

describe('what the page answers about its video', () => {
  it('is kept when it is what the script returns, a live stream having no length', () => {
    expect(parseFacts({ ...recorded() })).toEqual(recorded())
    expect(parseFacts({ ...live(), duration: 12 })).toEqual(live())
  })

  it('is refused when a value is not of its kind, and clamped where a page could lend odd values', () => {
    expect(parseFacts(null)).toBeNull()
    expect(parseFacts({ ...recorded(), paused: 'no' })).toBeNull()
    expect(parseFacts({ ...recorded(), volume: Number.NaN })).toBeNull()
    expect(parseFacts({ ...recorded(), volume: 3 })?.volume).toBe(1)
    expect(parseFacts({ ...recorded(), duration: Number.NaN })?.duration).toBeNull()
    // Behind the live edge means nothing for a recorded video.
    expect(parseFacts({ ...recorded(), behindLive: true })?.behindLive).toBe(false)
  })
})

describe('−10 s and +10 s', () => {
  it('are offered for a recorded video whose length is known', () => {
    expect(canSeek(recorded())).toBe(true)
  })

  it('are not for a live stream, a protected video, a video whose length is not known yet, or no video', () => {
    expect(canSeek(live())).toBe(false)
    // A live stream whose player reports a length (the part that can be rewound) is still live.
    expect(canSeek(recorded({ live: true }))).toBe(false)
    expect(canSeek(recorded({ protected: true }))).toBe(false)
    expect(canSeek(recorded({ duration: null }))).toBe(false)
    expect(canSeek(null)).toBe(false)
  })
})

describe('the time of the bar', () => {
  it('says where a recorded video is and how long it is, in minutes or in hours', () => {
    expect(timeText(recorded())).toBe('2:05 / 41:10')
    expect(timeText(recorded({ currentTime: 3723, duration: 7200 }))).toBe('1:02:03 / 2:00:00')
    expect(timeText(recorded({ duration: null, currentTime: 9 }))).toBe('0:09')
  })

  it('is nothing for a live stream: the bar says « En direct » instead', () => {
    expect(timeText(live())).toBeNull()
  })

  it('reads an odd time as zero', () => {
    expect(clockText(Number.NaN)).toBe('0:00')
    expect(clockText(-4)).toBe('0:00')
  })
})

describe('the keys of the window', () => {
  it('play or pause with Space, cut the sound with M, move the volume with ↑ and ↓ and jump with ← and →', () => {
    const facts = recorded()
    expect(floatingKeyCommand({ key: ' ' }, facts)).toEqual({ kind: 'toggle' })
    // On a button Space is the button's: « Fermer » must close, not pause.
    expect(floatingKeyCommand({ key: ' ', onButton: true }, facts)).toBeNull()
    expect(floatingKeyCommand({ key: 'm', onButton: true }, facts)).toEqual({ kind: 'mute' })
    expect(floatingKeyCommand({ key: 'm' }, facts)).toEqual({ kind: 'mute' })
    expect(floatingKeyCommand({ key: 'M' }, facts)).toEqual({ kind: 'mute' })
    expect(floatingKeyCommand({ key: 'ArrowUp' }, facts)).toEqual({ kind: 'volume', value: 0.9 })
    expect(floatingKeyCommand({ key: 'ArrowDown' }, facts)).toEqual({ kind: 'volume', value: 0.7 })
    expect(floatingKeyCommand({ key: 'ArrowLeft' }, facts)).toEqual({ kind: 'seek', seconds: -10 })
    expect(floatingKeyCommand({ key: 'ArrowRight' }, facts)).toEqual({ kind: 'seek', seconds: 10 })
  })

  it('keep the volume within 0 and 1', () => {
    expect(floatingKeyCommand({ key: 'ArrowUp' }, recorded({ volume: 0.95 }))).toEqual({ kind: 'volume', value: 1 })
    expect(floatingKeyCommand({ key: 'ArrowDown' }, recorded({ volume: 0.05 }))).toEqual({ kind: 'volume', value: 0 })
  })

  it('do not jump in a live stream or a protected video', () => {
    expect(floatingKeyCommand({ key: 'ArrowLeft' }, live())).toBeNull()
    expect(floatingKeyCommand({ key: 'ArrowRight' }, recorded({ protected: true }))).toBeNull()
  })

  it('leave a key with ⌘, ⌃ or ⌥ to the application, and the arrows to the volume slider when it has the focus', () => {
    expect(floatingKeyCommand({ key: 'w', meta: true }, recorded())).toBeNull()
    expect(floatingKeyCommand({ key: ' ', ctrl: true }, recorded())).toBeNull()
    expect(floatingKeyCommand({ key: 'm', alt: true }, recorded())).toBeNull()
    expect(floatingKeyCommand({ key: 'ArrowUp', onSlider: true }, recorded())).toBeNull()
    expect(floatingKeyCommand({ key: 'ArrowLeft', onSlider: true }, recorded())).toBeNull()
    // Space and M still do what they do on the slider.
    expect(floatingKeyCommand({ key: ' ', onSlider: true }, recorded())).toEqual({ kind: 'toggle' })
  })

  it('do nothing with the volume before the video is read', () => {
    expect(floatingKeyCommand({ key: 'ArrowUp' }, null)).toBeNull()
    expect(floatingKeyCommand({ key: 'Enter' }, recorded())).toBeNull()
  })
})

describe('the sound', () => {
  it('shows as cut when the tab is muted, or the video itself is silent', () => {
    expect(soundCut({ tabMuted: false, facts: recorded() })).toBe(false)
    expect(soundCut({ tabMuted: true, facts: recorded() })).toBe(true)
    expect(soundCut({ tabMuted: false, facts: recorded({ muted: true }) })).toBe(true)
    expect(soundCut({ tabMuted: false, facts: recorded({ volume: 0 }) })).toBe(true)
  })

  it('is cut by cutting the tab’s, which the sidebar shows', () => {
    expect(muteSteps({ tabMuted: false, facts: recorded() })).toEqual({ tabMuted: true, unmuteVideo: false })
  })

  it('is given back to the tab, and to the video when the video itself was silent', () => {
    expect(muteSteps({ tabMuted: true, facts: recorded() })).toEqual({ tabMuted: false, unmuteVideo: false })
    expect(muteSteps({ tabMuted: false, facts: live({ muted: true }) })).toEqual({ tabMuted: false, unmuteVideo: true })
    expect(muteSteps({ tabMuted: true, facts: recorded({ volume: 0 }) })).toEqual({ tabMuted: false, unmuteVideo: true })
  })
})

describe('the small window', () => {
  it('has the small bar under FLOATING_COMPACT_WIDTH', () => {
    expect(compactBar(FLOATING_COMPACT_WIDTH - 1)).toBe(true)
    expect(compactBar(FLOATING_COMPACT_WIDTH)).toBe(false)
  })
})

describe('where the window opens', () => {
  const area = { x: 0, y: 25, width: 1512, height: 920 }

  it('opens the first time at the bottom right of the screen, FLOATING_DEFAULT_WIDTH wide, in the proportions of the video', () => {
    expect(floatingBounds(area, 16 / 9, null)).toEqual({ x: 1512 - FLOATING_DEFAULT_WIDTH - FLOATING_EDGE, y: 25 + 920 - 270 - FLOATING_EDGE, width: FLOATING_DEFAULT_WIDTH, height: 270 })
    expect(floatingBounds(area, 4 / 3, null).height).toBe(360)
  })

  it('opens where it was last and at its last size, in the proportions of the new video', () => {
    expect(floatingBounds(area, 16 / 9, { x: 40, y: 80, width: 640, height: 360 })).toEqual({ x: 40, y: 80, width: 640, height: 360 })
    expect(floatingBounds(area, 2, { x: 40, y: 80, width: 640, height: 360 })).toEqual({ x: 40, y: 80, width: 640, height: 320 })
  })

  it('stays on the screen and within it: a place off the screen is brought back, a size larger than the screen made smaller, a tiny one larger', () => {
    const off = floatingBounds(area, 16 / 9, { x: 5000, y: -400, width: 640, height: 360 })
    expect(off).toEqual({ x: 1512 - 640, y: 25, width: 640, height: 360 })
    const huge = floatingBounds(area, 16 / 9, { x: 0, y: 0, width: 4000, height: 2250 })
    expect(huge).toEqual({ x: 0, y: 25, width: area.width - FLOATING_EDGE * 2, height: 833 })
    // A video taller than wide is held by the height of the screen, and keeps its proportions (888 = 920 - 2 × 16).
    expect(floatingBounds(area, 0.5, null)).toEqual({ x: 1052, y: 41, width: 444, height: 888 })
    expect(floatingBounds(area, 9 / 16, { x: 0, y: 0, width: 640, height: 1138 })).toEqual({ x: 0, y: 25, width: 500, height: 888 })
    expect(floatingBounds(area, 16 / 9, { x: 0, y: 0, width: 20, height: 10 }).width).toBe(FLOATING_MIN_WIDTH)
  })

  it('opens as 16:9 for a video whose proportions are not known', () => {
    expect(floatingBounds(area, Number.NaN, null).height).toBe(270)
  })
})

describe('the bar', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const watch = () => {
    const seen: boolean[] = []
    const bar = new BarVisibility((visible) => seen.push(visible))
    return { bar, seen }
  }

  it('shows as the pointer moves, and hides FLOATING_BAR_HIDE_MS after it stops', () => {
    const { bar, seen } = watch()
    bar.moved()
    expect(bar.visible).toBe(true)
    vi.advanceTimersByTime(FLOATING_BAR_HIDE_MS - 1)
    expect(bar.visible).toBe(true)
    vi.advanceTimersByTime(1)
    expect(bar.visible).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('waits FLOATING_BAR_HIDE_MS from the last movement, and is told once of each change', () => {
    const { bar, seen } = watch()
    bar.moved()
    vi.advanceTimersByTime(1500)
    bar.moved()
    vi.advanceTimersByTime(1500)
    expect(bar.visible).toBe(true)
    vi.advanceTimersByTime(500)
    expect(bar.visible).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('hides at once when the pointer leaves the window', () => {
    const { bar } = watch()
    bar.moved()
    bar.left()
    expect(bar.visible).toBe(false)
  })

  it('stays while the keyboard is in it, and starts its delay again when the keyboard leaves', () => {
    const { bar } = watch()
    bar.hold(true)
    vi.advanceTimersByTime(FLOATING_BAR_HIDE_MS * 5)
    bar.left()
    expect(bar.visible).toBe(true)
    bar.hold(false)
    vi.advanceTimersByTime(FLOATING_BAR_HIDE_MS - 1)
    expect(bar.visible).toBe(true)
    vi.advanceTimersByTime(1)
    expect(bar.visible).toBe(false)
  })

  it('arms no timer once disposed', () => {
    const { bar } = watch()
    bar.moved()
    bar.dispose()
    vi.advanceTimersByTime(FLOATING_BAR_HIDE_MS * 2)
    expect(bar.visible).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the site’s own Picture in Picture button', () => {
  const asked = { setting: true, privateWindow: false, floatingTab: null, tabId: 'tab' }
  it('is taken into Lucium’s window', () => {
    expect(takesSitePip(asked)).toBe(true)
  })
  it('is left to the system when the setting is off, in a private window, or when the tab already floats in Lucium’s window', () => {
    expect(takesSitePip({ ...asked, setting: false })).toBe(false)
    expect(takesSitePip({ ...asked, privateWindow: true })).toBe(false)
    expect(takesSitePip({ ...asked, floatingTab: 'tab' })).toBe(false)
    expect(takesSitePip({ ...asked, floatingTab: 'other' })).toBe(true)
  })
})
