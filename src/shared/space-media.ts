// Space Background Media: Images, GIFs, and Videos for beautiful space backgrounds
// All media stored locally, optimized for performance

import { isRecord } from './record'

export type SpaceBackgroundType = 'color' | 'image' | 'gif' | 'video'
/** How the tabs read over a picture or a video: automatic, lighter (a light veil), or darker (a dark veil). */
export type SpaceTone = 'auto' | 'light' | 'dark'
const SPACE_TONES: readonly SpaceTone[] = ['auto', 'light', 'dark']

export interface SpaceBackground {
  /** Type of background: color, image, gif, or video */
  type: SpaceBackgroundType
  /** For color: hex color string. For media: filename (stored in userData/media/) */
  value: string
  /** For GIFs and videos: auto-loop setting */
  loop?: boolean
  /** For videos: muted autoplay (always true for performance) */
  muted?: boolean
  /** For videos: the background stays paused (on its first frame) until the user plays it again (WCAG 2.2.2). */
  paused?: boolean
  /** For videos: « Toujours lire », it goes on playing while another window is in front, as long as Lucium's window can be seen (it stops otherwise). */
  playUnfocused?: boolean
  /** The veil over a media background, so the tabs stay readable: absent means automatic. */
  tone?: SpaceTone
  /** How strong the veil is, in percent (0 to 100); absent means the tone's default. */
  veil?: number
  /** The colour of the veil (a hex colour from VEIL_COLORS). */
  veilColor?: string
  /** The veil darkest under the text and fading towards the right edge, where the picture shows almost bare (« Côté texte »); absent = even. */
  veilShape?: 'text'
  /** The colour of the tab text (a hex colour from VEIL_COLORS); it wins over the light or dark choice. */
  textColor?: string
  /** A soft shadow behind the tab text, for legibility over a busy picture. */
  textHalo?: boolean
  /** The look above was measured from the user's file (auto-veil.ts), not set by hand: a change by hand takes it away, a new file is measured again. */
  veilAuto?: boolean
  /** For videos: the part of the video the sidebar shows when the video is wider or taller than it (`object-position`); absent means the centre. */
  position?: BackgroundPosition
}

/**
 * Where a video is framed: the point of the video, in percent of its width (`x`) and of its height (`y`), that sits at the same point of the sidebar. 0 shows
 * the left (top) edge, 100 the right (bottom) edge, 50 the centre. Whole percents, so that a drag does not write a new state for a fraction of a pixel.
 */
export interface BackgroundPosition {
  x: number
  y: number
}

/** The framing a video has when nothing was chosen. It is never stored: a position at the centre is the absence of one. */
export const CENTERED_POSITION: BackgroundPosition = { x: 50, y: 50 }

/** How far one press of an arrow key moves the frame, in percent. */
export const POSITION_STEP = 5

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)))

/** The veils the user can choose, in the order the picker shows them. The first is the darkest: the one the text side brings when no veil colour was chosen. */
export const VEIL_COLORS = ['#0b0c12', '#14213d', '#1e4fa3', '#5b6170', '#f4f4f6', '#f2ead8'] as const

/** The colours the tab text can take: only light or dark ones, far apart, so that the text always reads over the veil. */
export const TEXT_COLORS = ['#ffffff', '#f4f4f6', '#f2ead8', '#0b0c12', '#14213d'] as const

/** Whether a veil colour is dark enough to need light tab text (relative luminance under 0.4). */
export function veilIsDark(hex: string): boolean {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2) < 0.4
}

const SPACE_BACKGROUND_TYPES: readonly SpaceBackgroundType[] = ['color', 'image', 'gif', 'video']
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const MEDIA_NAME = /^[a-zA-Z0-9._-]{1,255}$/

/**
 * Validates and normalizes a space background loaded from UI/state files.
 * Invalid data is dropped rather than partially trusted.
 */
export function cleanSpaceBackground(raw: unknown): SpaceBackground | undefined {
  if (!isRecord(raw)) return undefined
  const type = SPACE_BACKGROUND_TYPES.find((entry) => entry === raw['type'])
  if (!type) return undefined
  const value = raw['value']
  if (typeof value !== 'string') return undefined

  if (type === 'color') {
    if (!HEX_COLOR.test(value)) return undefined
    return { type, value: value.toLowerCase() }
  }

  if (!MEDIA_NAME.test(value)) return undefined
  // The extension must be one the type can show: a text file named as a video is not a background.
  const extension = value.split('.').pop()?.toLowerCase() ?? ''
  const allowed = type === 'video' ? ['mp4', 'webm'] : ['webp', 'png', 'jpg', 'jpeg', 'gif']
  if (!allowed.includes(extension)) return undefined
  const cleaned: SpaceBackground = { type, value }
  if ((type === 'gif' || type === 'video') && typeof raw['loop'] === 'boolean') cleaned.loop = raw['loop']
  if (type === 'video' && typeof raw['muted'] === 'boolean') cleaned.muted = raw['muted']
  if (type === 'video' && typeof raw['paused'] === 'boolean') cleaned.paused = raw['paused']
  if (type === 'video' && raw['playUnfocused'] === true) cleaned.playUnfocused = true
  if (type === 'video') {
    const position = cleanBackgroundPosition(raw['position'])
    if (position) cleaned.position = position
  }
  const tone = SPACE_TONES.find((entry) => entry === raw['tone'])
  if (tone && tone !== 'auto') cleaned.tone = tone
  const veilColor = raw['veilColor']
  if (typeof veilColor === 'string' && HEX_COLOR.test(veilColor)) cleaned.veilColor = veilColor.toLowerCase()
  if (raw['veilShape'] === 'text') cleaned.veilShape = 'text'
  const textColor = raw['textColor']
  if (typeof textColor === 'string' && HEX_COLOR.test(textColor)) cleaned.textColor = textColor.toLowerCase()
  if (raw['textHalo'] === true) cleaned.textHalo = true
  if (raw['veilAuto'] === true) cleaned.veilAuto = true
  const veil = raw['veil']
  if (Number.isInteger(veil) && (veil as number) >= 0 && (veil as number) <= 100) cleaned.veil = veil as number
  return cleaned
}

/**
 * A position read from a state file: two numbers between 0 and 100, kept as whole percents. Anything else is dropped (the video is then centred), and so is
 * the centre itself, which is the absence of a position.
 */
export function cleanBackgroundPosition(raw: unknown): BackgroundPosition | undefined {
  if (!isRecord(raw)) return undefined
  const x = raw['x']
  const y = raw['y']
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  if (x < 0 || x > 100 || y < 0 || y > 100) return undefined
  const position = { x: Math.round(x), y: Math.round(y) }
  return position.x === CENTERED_POSITION.x && position.y === CENTERED_POSITION.y ? undefined : position
}

/**
 * The background with its video framed at `x` and `y` (percent, kept between 0 and 100): the choice of the space, written by the frame of the Fond panel.
 * Only a video has a framing, and a value that is not a number changes nothing. The centre removes the position instead of writing it.
 */
export function withBackgroundPosition(background: SpaceBackground, x: number, y: number): SpaceBackground {
  if (background.type !== 'video' || !Number.isFinite(x) || !Number.isFinite(y)) return background
  const { position: _old, ...rest } = background
  const position = { x: clampPercent(x), y: clampPercent(y) }
  return position.x === CENTERED_POSITION.x && position.y === CENTERED_POSITION.y ? rest : { ...rest, position }
}

/** The CSS `object-position` of a video background, or undefined at the centre (the stylesheet's own). */
export function backgroundObjectPosition(background: Pick<SpaceBackground, 'type' | 'position'>): string | undefined {
  return background.type === 'video' && background.position ? `${background.position.x}% ${background.position.y}%` : undefined
}

/**
 * The share of a video's width (`x`) and height (`y`) that a box shows when the video covers it (`object-fit: cover`): 1 on the axis that is not cropped, less
 * on the other one. It is the size of the frame over the whole video, and what is left (1 - share) is the room the frame can move in. A size that is
 * not known (a video whose metadata is not loaded yet) shows everything.
 */
export function coverShare(video: { width: number; height: number }, box: { width: number; height: number }): { x: number; y: number } {
  if (!(video.width > 0 && video.height > 0 && box.width > 0 && box.height > 0)) return { x: 1, y: 1 }
  const scale = Math.max(box.width / video.width, box.height / video.height)
  // Rounded to four decimals: the axis that is not cropped is 1 up to the rounding of the division, and must read as 1 (no room to move on it).
  const share = (shown: number, whole: number): number => Math.min(1, Math.round((shown / (whole * scale)) * 10_000) / 10_000)
  return { x: share(box.width, video.width), y: share(box.height, video.height) }
}

/**
 * The position after a drag of the frame: the frame moved by `delta` pixels over a picture of the video shown `shown` pixels big, from the position it
 * had at the start of the drag. An axis with no room (the video fills the box on it) keeps its value.
 */
export function draggedPosition(
  start: BackgroundPosition,
  delta: { x: number; y: number },
  share: { x: number; y: number },
  shown: { width: number; height: number }
): BackgroundPosition {
  const axis = (from: number, move: number, visible: number, length: number): number => {
    const room = (1 - visible) * length
    return room > 0.5 && Number.isFinite(move) ? clampPercent(from + (move / room) * 100) : from
  }
  return { x: axis(start.x, delta.x, share.x, shown.width), y: axis(start.y, delta.y, share.y, shown.height) }
}

/** The position after a press of an arrow key (the frame goes the way of the arrow), or null for any other key. An axis with no room keeps its value. */
export function steppedPosition(position: BackgroundPosition, key: string, share: { x: number; y: number }, step: number = POSITION_STEP): BackgroundPosition | null {
  const move = key === 'ArrowLeft' ? { x: -step, y: 0 } : key === 'ArrowRight' ? { x: step, y: 0 } : key === 'ArrowUp' ? { x: 0, y: -step } : key === 'ArrowDown' ? { x: 0, y: step } : null
  if (!move) return null
  return { x: share.x < 1 ? clampPercent(position.x + move.x) : position.x, y: share.y < 1 ? clampPercent(position.y + move.y) : position.y }
}

/**
 * Whether the video background of a space is held still (WCAG 2.2.2): the user's choice for that space when
 * there is one (`paused`, written by the control of the background panel and kept in the state), else the wish for less motion of the system
 * (prefers-reduced-motion) or of Lucium (`forceReduceMotion`), which pauses it by default.
 */
export function videoBackgroundPaused(background: Pick<SpaceBackground, 'paused'> | undefined, reduceMotion: boolean): boolean {
  return background?.paused ?? reduceMotion
}

/** The background after a click on its Pause / Lire control: the opposite of what is shown now, written as the choice of the space. */
export function toggledVideoPause(background: SpaceBackground, reduceMotion: boolean): SpaceBackground {
  return { ...background, paused: !videoBackgroundPaused(background, reduceMotion) }
}

/**
 * The file of a space's background to read for a layer of the sidebar: a picture, a GIF or a video, and only for a layer that is drawn. A colour has no
 * file, and a layer that is not drawn (the footer's buttons) reads nothing: up to ~13 MB of video would be read for a picture nobody sees.
 */
export function backgroundFileToRead(background: Pick<SpaceBackground, 'type' | 'value'> | undefined, drawn: boolean): string | null {
  if (!drawn || !background || !background.value || background.type === 'color') return null
  return background.value
}

/** What the video behind a space does when the choice of its space changes: held still at the pause, played again at once after « Lire » (made in a
 *  panel, so the sidebar has not the focus then) unless the window is hidden or the battery saver is on (`saving`: it holds the video still, see below). */
export function backgroundVideoOnChoice(paused: boolean, view: { hidden: boolean; videoPaused: boolean; saving?: boolean }): 'pause' | 'play' | 'keep' {
  if (paused) return 'pause'
  return !view.hidden && !view.saving && view.videoPaused ? 'play' : 'keep'
}

/** What the video behind a space does when the window is shown, hidden, or gains or loses the focus (the window's, not the sidebar's: a page of the
 *  window takes the keyboard without the window losing the focus), or when the battery saver comes on or goes off (`saving`): it stops while another
 *  window is in front or the window is hidden, and resumes only when its space does not hold it still. Its space may keep it playing behind other
 *  windows (« Toujours lire », `playUnfocused`); a hidden window still stops it, and so does the battery saver, whatever the space says. */
export function backgroundVideoOnView(view: { hidden: boolean; focused: boolean; saving?: boolean }, paused: boolean, playUnfocused = false): 'pause' | 'play' | 'keep' {
  if (view.hidden || view.saving || (!view.focused && !playUnfocused)) return 'pause'
  return paused ? 'keep' : 'play'
}

/** Whether the video behind a space plays all the time (« Toujours lire »): its space keeps it playing behind other windows, and it is not paused. */
export function videoAlwaysPlays(background: Pick<SpaceBackground, 'paused' | 'playUnfocused'>, reduceMotion: boolean): boolean {
  return background.playUnfocused === true && !videoBackgroundPaused(background, reduceMotion)
}

/** The background after a click on « Toujours lire »: on, the video plays now (a pause is lifted) and goes on behind other windows; off, it stops again
 *  while another window is in front. The rest of the background is kept. */
export function toggledAlwaysPlay(background: SpaceBackground, reduceMotion: boolean): SpaceBackground {
  const { playUnfocused, ...rest } = background
  return videoAlwaysPlays(background, reduceMotion) ? rest : { ...rest, paused: false, playUnfocused: true }
}

/** The strength a veil on the text side starts from when it is chosen: weaker, its gradient would not be seen under the text. */
export const TEXT_SIDE_VEIL_MIN = 60

/**
 * The background after a choice of « Forme du voile »: on the text side, the veil is the chosen strength under the text and fades to a sixth of it at the
 * right edge (sidebar.css), so the strength is raised to TEXT_SIDE_VEIL_MIN when it was lower; even, the strength stays as it is. Without a veil colour
 * there is no veil to shape: the text side then brings the darkest veil, at TEXT_SIDE_VEIL_MIN (the strength left from an earlier veil is not read back,
 * the slider is hidden while there is no colour).
 */
export function withVeilShape(background: SpaceBackground, shape: 'even' | 'text'): SpaceBackground {
  const { veilShape: _shape, ...rest } = background
  if (shape === 'even') return rest
  if (background.veilColor === undefined) return { ...rest, veilShape: 'text', veilColor: VEIL_COLORS[0], veil: TEXT_SIDE_VEIL_MIN }
  return { ...rest, veilShape: 'text', ...(background.veil !== undefined && background.veil < TEXT_SIDE_VEIL_MIN ? { veil: TEXT_SIDE_VEIL_MIN } : {}) }
}

