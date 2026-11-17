// Lucium's floating video window (« Image dans l'image »): the live view of a tab, moved into a small window that stays above the others, its video
// brought to fill it in place, with a bar of controls over it (shell/floating-video.ts, engine/floating-video-scripts.ts). What the bar shows, what its
// keys do, what a message of the bar may ask, and where the window goes, as functions of what they read, for the window and its tests.

import type { Rect } from './window-layout'

/** The bar hides this long after the last movement of the pointer (or the last key) over the window. */
export const FLOATING_BAR_HIDE_MS = 2000
/** Narrower than this, the bar keeps only pause, sound and « Revenir à l'onglet » (and the top, the live pill and the close button). */
export const FLOATING_COMPACT_WIDTH = 360
/** A jump of ←, →, −10 s and +10 s. */
export const FLOATING_SEEK_SECONDS = 10
/** A step of ↑ and ↓ on the volume. */
export const FLOATING_VOLUME_STEP = 0.1
/** The width the window opens at the first time; afterwards, the size it was given last (in this session). */
export const FLOATING_DEFAULT_WIDTH = 480
export const FLOATING_MIN_WIDTH = 240
/** The window keeps this far from the edges of the screen's work area. */
export const FLOATING_EDGE = 16
/** A live stream played further behind its live edge than this can go back to it (the pill « EN DIRECT » becomes a button). */
export const FLOATING_LIVE_LAG_SECONDS = 10
/** How often the window reads its video while the bar is on screen (and only then). */
export const FLOATING_WATCH_MS = 500

/** What the window reads of its video (engine/floating-video-scripts.ts, FLOAT_FACTS). */
export interface FloatingVideoFacts {
  paused: boolean
  ended: boolean
  /** The video's own `muted` (the site's), not the tab's sound. */
  muted: boolean
  volume: number
  currentTime: number
  /** Seconds; null when it is not known yet, and for a live stream. */
  duration: number | null
  /** A live stream: its duration is infinite. */
  live: boolean
  /** A live stream played behind its live edge (one that can be rewound): « EN DIRECT » takes it back there. */
  behindLive: boolean
  /** Protected by a DRM (Widevine): it is never moved in time from outside (see `canSeek`). */
  protected: boolean
  width: number
  height: number
}

/** What the bar is sent: the window, the tab and, when it was found, the video. */
export interface FloatingVideoState {
  /** The site of the tab (its host), shown at the top. */
  site: string
  /** « Garder au premier plan »: the window stays above the others. */
  pinned: boolean
  /** The tab's sound is cut (the speaker of its row in the sidebar). */
  tabMuted: boolean
  /** Null while the video cannot be read (the page replaces its player, or is loading). */
  facts: FloatingVideoFacts | null
}

/** What the bar asks of the window. `watch` says whether the bar is on screen: the video is read only while it is. */
export type FloatingVideoCommand =
  | { kind: 'toggle' }
  | { kind: 'mute' }
  | { kind: 'volume'; value: number }
  | { kind: 'seek'; seconds: number }
  | { kind: 'live' }
  | { kind: 'back' }
  | { kind: 'close' }
  | { kind: 'pin' }
  | { kind: 'watch'; on: boolean }

/** What the window asks of the video, in the page (engine/floating-video-scripts.ts, `floatCommandScript`). */
export type VideoCommand =
  | { kind: 'toggle' }
  | { kind: 'pause' }
  | { kind: 'unmute' }
  | { kind: 'volume'; value: number }
  | { kind: 'seek'; seconds: number }
  | { kind: 'live' }

const SIMPLE = new Set(['toggle', 'mute', 'live', 'back', 'close', 'pin'])

/**
 * A message of the bar, as the window may act on it, or null. The bar is a surface of ours, but what crosses the channel is checked like anything a
 * renderer sends: a volume is a number from 0 to 1, a jump is exactly −10 s or +10 s, and nothing else is passed on.
 */
export function parseFloatingCommand(raw: unknown): FloatingVideoCommand | null {
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  if (typeof kind !== 'string') return null
  if (SIMPLE.has(kind)) return { kind } as FloatingVideoCommand
  if (kind === 'volume') {
    const value = (raw as { value?: unknown }).value
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? { kind, value } : null
  }
  if (kind === 'seek') {
    const seconds = (raw as { seconds?: unknown }).seconds
    return seconds === FLOATING_SEEK_SECONDS || seconds === -FLOATING_SEEK_SECONDS ? { kind, seconds } : null
  }
  if (kind === 'watch') {
    const on = (raw as { on?: unknown }).on
    return typeof on === 'boolean' ? { kind, on } : null
  }
  return null
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** What the page answered about its video, kept only when it is what the script returns (a page can lend its video odd values). */
export function parseFacts(raw: unknown): FloatingVideoFacts | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const flags = ['paused', 'ended', 'muted', 'live', 'behindLive', 'protected'] as const
  if (flags.some((flag) => typeof r[flag] !== 'boolean')) return null
  if (!finite(r['volume']) || !finite(r['currentTime']) || !finite(r['width']) || !finite(r['height'])) return null
  const duration = finite(r['duration']) && (r['duration'] as number) > 0 ? (r['duration'] as number) : null
  return {
    paused: r['paused'] as boolean,
    ended: r['ended'] as boolean,
    muted: r['muted'] as boolean,
    volume: Math.min(1, Math.max(0, r['volume'] as number)),
    currentTime: Math.max(0, r['currentTime'] as number),
    duration: r['live'] === true ? null : duration,
    live: r['live'] as boolean,
    behindLive: r['live'] === true && r['behindLive'] === true,
    protected: r['protected'] as boolean,
    width: Math.max(0, r['width'] as number),
    height: Math.max(0, r['height'] as number)
  }
}

/**
 * Whether −10 s and +10 s are offered: a recorded video whose length is known. Not for a live stream (there is no time to move in, only the live
 * edge), and not for a protected one: the players of the protected services keep their own clock, and a jump made from outside the site is one
 * they may refuse (it is offered again in the tab, by the site's own controls).
 */
export function canSeek(facts: FloatingVideoFacts | null): boolean {
  return facts !== null && !facts.live && !facts.protected && facts.duration !== null
}

/** Whether the bar shows the sound as cut: the tab's sound is cut, or the video itself is silent (muted by the site, or at zero). */
export function soundCut(state: Pick<FloatingVideoState, 'tabMuted' | 'facts'>): boolean {
  return state.tabMuted || state.facts?.muted === true || state.facts?.volume === 0
}

/**
 * What the sound button does. Cutting the sound cuts the tab's (the sidebar's speaker follows, as with its own button). Giving it back gives the
 * tab its sound and, when the video itself was silent (a stream that starts muted, a volume at zero), the video its sound too.
 */
export function muteSteps(state: Pick<FloatingVideoState, 'tabMuted' | 'facts'>): { tabMuted: boolean; unmuteVideo: boolean } {
  if (!soundCut(state)) return { tabMuted: true, unmuteVideo: false }
  return { tabMuted: false, unmuteVideo: state.facts?.muted === true || state.facts?.volume === 0 }
}

/** A key pressed over the window, as the bar reads it. */
export interface FloatingKey {
  key: string
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  /** The focus is on the volume slider: its arrows move it (the slider answers them itself). */
  onSlider?: boolean
  /** The focus is on a button: Space presses it (« Fermer » closes, the play button plays), as it does on any button. */
  onButton?: boolean
}

/**
 * The command of a key: Space plays or pauses (on a button it presses the button instead), M cuts or gives back the sound, ↑ and ↓ move the volume by a tenth, ← and → jump 10 s (a recorded
 * video only, see `canSeek`). A key with ⌘, ⌃ or ⌥ is the application's (⌘W closes the window, from the main process).
 */
export function floatingKeyCommand(input: FloatingKey, facts: FloatingVideoFacts | null): FloatingVideoCommand | null {
  if (input.meta || input.ctrl || input.alt) return null
  const key = input.key
  if (key === ' ' || key === 'Spacebar') return input.onButton ? null : { kind: 'toggle' }
  if (key === 'm' || key === 'M') return { kind: 'mute' }
  if (input.onSlider) return null
  if ((key === 'ArrowUp' || key === 'ArrowDown') && facts) {
    const step = key === 'ArrowUp' ? FLOATING_VOLUME_STEP : -FLOATING_VOLUME_STEP
    return { kind: 'volume', value: Math.round(Math.min(1, Math.max(0, facts.volume + step)) * 100) / 100 }
  }
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && canSeek(facts)) return { kind: 'seek', seconds: key === 'ArrowLeft' ? -FLOATING_SEEK_SECONDS : FLOATING_SEEK_SECONDS }
  return null
}

/** A time as a clock: 2:05, 1:02:03. */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/**
 * The time of the bar: where the video is and how long it is (« 2:05 / 41:10 »), where it is alone while its length is not known, and null for a
 * live stream, which says « En direct » instead (how long the stream has been live is not something the video knows).
 */
export function timeText(facts: FloatingVideoFacts): string | null {
  if (facts.live) return null
  return facts.duration === null ? clockText(facts.currentTime) : `${clockText(facts.currentTime)} / ${clockText(facts.duration)}`
}

/** Whether the bar is the small one: pause, sound and « Revenir à l'onglet » only. */
export function compactBar(width: number): boolean {
  return width < FLOATING_COMPACT_WIDTH
}

/** The proportions of a video, kept within reason (a video not yet decoded, or a strip, opens as 16:9). */
export function aspectOf(width: number, height: number): number {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9
  return Math.min(4, Math.max(0.25, aspect))
}

/**
 * Where the window opens on `area` (the work area of the screen of the window the tab is in): the size it had last (this session), or
 * FLOATING_DEFAULT_WIDTH wide, in the proportions of the video, never larger than the area; where it was last, kept on the area, or else at the
 * bottom right corner, FLOATING_EDGE from the edges.
 */
export function floatingBounds(area: Rect, aspect: number, remembered: Rect | null): Rect {
  const ratio = aspectOf(aspect, 1)
  const maxWidth = Math.max(FLOATING_MIN_WIDTH, area.width - FLOATING_EDGE * 2)
  const maxHeight = Math.max(Math.round(FLOATING_MIN_WIDTH / ratio), area.height - FLOATING_EDGE * 2)
  let width = Math.min(maxWidth, Math.max(FLOATING_MIN_WIDTH, Math.round(remembered?.width ?? FLOATING_DEFAULT_WIDTH)))
  let height = Math.round(width / ratio)
  if (height > maxHeight) {
    height = maxHeight
    width = Math.max(FLOATING_MIN_WIDTH, Math.round(height * ratio))
  }
  const clampX = (x: number): number => Math.min(area.x + area.width - width, Math.max(area.x, x))
  const clampY = (y: number): number => Math.min(area.y + area.height - height, Math.max(area.y, y))
  if (remembered) return { x: clampX(Math.round(remembered.x)), y: clampY(Math.round(remembered.y)), width, height }
  return { x: clampX(area.x + area.width - width - FLOATING_EDGE), y: clampY(area.y + area.height - height - FLOATING_EDGE), width, height }
}

/** The timers the bar's visibility uses (the window's own; a test gives fake ones). */
export interface BarTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: BarTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * When the bar shows: as the pointer moves over the window (or a key is pressed), and until FLOATING_BAR_HIDE_MS without movement; at once when the
 * pointer leaves. While it is held (the keyboard focus is in the bar, the volume slider is dragged) it stays, and the delay starts again when it is let go.
 * Told by `onChange` only when it changes.
 */
export class BarVisibility {
  private shown = false
  private held = false
  private timer: unknown = null

  constructor(
    private readonly onChange: (visible: boolean) => void,
    private readonly delayMs: number = FLOATING_BAR_HIDE_MS,
    private readonly timers: BarTimers = realTimers
  ) {}

  get visible(): boolean {
    return this.shown
  }

  /** The pointer moved over the window, or a key was pressed. */
  moved(): void {
    this.set(true)
    this.arm()
  }

  /** The pointer left the window. */
  left(): void {
    if (this.held) return
    this.disarm()
    this.set(false)
  }

  /** The focus came into the bar (true) or left it (false), or a drag of the slider started or ended. */
  hold(on: boolean): void {
    this.held = on
    if (on) {
      this.disarm()
      this.set(true)
    } else this.arm()
  }

  dispose(): void {
    this.disarm()
  }

  private arm(): void {
    this.disarm()
    if (this.held) return
    this.timer = this.timers.set(() => {
      this.timer = null
      this.set(false)
    }, this.delayMs)
  }

  private disarm(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private set(visible: boolean): void {
    if (visible === this.shown) return
    this.shown = visible
    this.onChange(visible)
  }
}
