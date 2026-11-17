// Where things go in a frame, and what each scene puts there: the boxes of the text and of the images for each layout in the two formats, the
// size of a window, the largest the camera makes a capture (the captures are at 1×: past 1.15 pixel of film per pixel of capture, they blur),
// and the plan of a scene in a language — its images (capture, screen recording or neutral drawing), its rings, its pointer and its texts.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Lang, Theme } from '../site-captures/shots'
import type { CameraKey, Layout, Point, Rect, SceneSpec, Size, Spot, TransitionKind } from './scenes'

export type FormatName = 'wide' | 'square'
export interface Format {
  name: FormatName
  width: number
  height: number
}
export const FORMATS: Readonly<Record<FormatName, Format>> = {
  wide: { name: 'wide', width: 1920, height: 1080 },
  square: { name: 'square', width: 1080, height: 1080 }
}

/** `--formats wide,square` (both by default). */
export function parseFormats(raw: string | undefined): FormatName[] {
  if (raw === undefined || raw.trim() === '') return ['wide', 'square']
  const names = raw.split(',').map((value) => value.trim()).filter((value) => value !== '')
  for (const name of names) if (name !== 'wide' && name !== 'square') throw new Error(`--formats : valeur inconnue « ${name} » (wide, square)`)
  return [...new Set(names)] as FormatName[]
}

/** The most the camera may enlarge a capture: pixels of film per pixel of capture. */
export const MAX_SCALE = 1.15

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Geometry {
  /** The box of the text, its alignment, the size of its type in pixels, and whether its lines follow each other on one line or stack. */
  text: Box
  align: 'center' | 'left'
  size: number
  flow: 'inline' | 'stack'
  /** The area of the images. */
  media: Box
  /** In the panel layouts: the rounded tile that holds the images (the same box as `media`), and its corner radius. */
  tile?: Box & { radius: number }
}

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h })

/** The boxes of a layout in a format. The square version puts the text above the images in every layout but `center`. */
export function geometry(layout: Layout, format: Format): Geometry {
  const { width: W, height: H } = format
  const full = box(0, 0, W, H)
  if (layout === 'center') return { text: full, align: 'center', size: format.name === 'wide' ? 88 : 76, flow: 'inline', media: full }
  if (format.name === 'square') {
    if (layout === 'stack') return { text: box(70, 56, 940, 190), align: 'center', size: 54, flow: 'inline', media: box(0, 270, W, 780) }
    if (layout === 'stack-bottom') return { text: box(70, 800, 940, 220), align: 'center', size: 54, flow: 'inline', media: box(0, 40, W, 730) }
    const tile = { ...box(40, 300, 1000, 740), radius: 32 }
    return { text: box(84, 56, 912, 220), align: 'left', size: 52, flow: 'stack', media: tile, tile }
  }
  if (layout === 'stack') return { text: box(160, 64, 1600, 140), align: 'center', size: 64, flow: 'inline', media: box(0, 236, W, 820) }
  if (layout === 'stack-bottom') return { text: box(160, 896, 1600, 140), align: 'center', size: 60, flow: 'inline', media: box(0, 44, W, 820) }
  const tile = { ...box(layout === 'panel-left' ? 744 : 48, 48, 1128, 984), radius: 36 }
  return { text: box(layout === 'panel-left' ? 128 : 1236, 0, 560, H), align: 'left', size: 60, flow: 'stack', media: tile, tile }
}

export interface WindowBox extends Box {
  /** Pixels of film per pixel of capture, before the camera. */
  scale: number
}

/**
 * The base box of a window in its layout. `fit`: the share of the area it may take (0.9 by default), never larger than the capture itself; or
 * `native`, one pixel per pixel (the window is then cropped by its tile: the camera chooses the part). In `stack` the window hangs under the
 * text, in `stack-bottom` it sits on the text, elsewhere it is centred.
 */
export function windowBox(geo: Geometry, size: Size, layout: Layout, fit: number | 'native' = 0.9): WindowBox {
  const { media } = geo
  const scale =
    fit === 'native'
      ? 1
      : Math.min(1, (media.w * fit) / size.width, (media.h * (layout === 'stack' || layout === 'stack-bottom' ? 0.98 : fit)) / size.height)
  const w = size.width * scale
  const h = size.height * scale
  const x = media.x + (media.w - w) / 2
  const y = layout === 'stack' ? media.y : layout === 'stack-bottom' ? media.y + media.h - h : media.y + (media.h - h) / 2
  return { x, y, w, h, scale }
}

/** The largest the camera makes the capture of a window: its base scale times the largest zoom of its camera. */
export const largestScale = (win: WindowBox, camera: readonly CameraKey[] | undefined): number =>
  win.scale * Math.max(1, ...(camera ?? []).map((key) => key.zoom))

// ---------- the places of a shot ----------

export type Hotspots = Readonly<Record<string, Readonly<Record<string, Spot>>>>

/** A place of a shot in a language. Throws when the shot or the place is not written in the hotspots. */
export function spotOf(hotspots: Hotspots, shot: string, name: string, lang: Lang): Rect | Point {
  const spot = hotspots[shot]?.[name]
  if (spot === undefined) throw new Error(`prise ${shot} : pas d’emplacement « ${name} » (scripts/site-film/scenes.ts, HOTSPOTS)`)
  return 'fr' in spot ? spot[lang] : spot
}

/** A rectangle place, for a ring or a reveal. */
export function rectOf(hotspots: Hotspots, shot: string, name: string, lang: Lang): Rect {
  const spot = spotOf(hotspots, shot, name, lang)
  if (spot.length !== 4) throw new Error(`prise ${shot} : « ${name} » est un point, il faut un rectangle`)
  return spot
}

/** A point place, for the pointer: the point itself, or the middle of a rectangle. */
export function pointOf(hotspots: Hotspots, shot: string, name: string, lang: Lang): Point {
  const spot = spotOf(hotspots, shot, name, lang)
  return spot.length === 2 ? spot : [spot[0] + spot[2] / 2, spot[1] + spot[3] / 2]
}

// ---------- the plan of a scene ----------

/** Where the images come from: the file of a capture or of a screen recording when it exists, and the facts the drawings need. */
export interface Sources {
  capture(shot: string, theme: Theme): string | undefined
  clip(id: string, theme: Theme): string | undefined
  size(shot: string): Size
  /** The neutral drawing of a shot. */
  placeholder(shot: string): string
  /** The colour of the space a shot shows (the tint of a drawing, the background of the spaces). */
  tint(shot: string): string
}

export interface Media {
  kind: 'capture' | 'clip' | 'placeholder'
  shot: string
  theme: Theme
  width: number
  height: number
  tint: string
  /** The file of the capture, or of the screen recording. */
  file?: string
  /** The name of the neutral drawing. */
  placeholder?: string
}

export interface PlannedStill {
  at: number
  fade: number
  media: Media
  reveal?: { rect: Rect; motion: 'rise' | 'pop' | 'fade' }
}

export interface MissingShot {
  scene: number
  shot: string
  theme: Theme
  /** What the film does meanwhile. */
  outcome: 'placeholder' | 'skipped'
}

export interface ScenePlan {
  number: number
  id: string
  kind: SceneSpec['kind']
  layout: Layout
  backdrop: SceneSpec['backdrop']
  theme: Theme
  duration: number
  geometry: Geometry
  /** The base box of the window (absent in the scenes without one: the icon, the mosaic, the closing). */
  window?: WindowBox
  stills: PlannedStill[]
  tiles: Array<{ media: Media; caption: string }>
  camera: CameraKey[]
  rings: Array<{ from: number; to: number; rect: Rect; veil: boolean }>
  cursor: Array<{ at: number; point: Point; click: boolean; key?: string }>
  marks: Array<{ from: number; to: number; line: readonly [number, number, number, number] }>
  keys: Array<{ at: number; keys: string[]; point: Point }>
  enter?: 'rise'
  lines: Array<{ at: number; text: string; style?: 'small' | 'accent' }>
  focusLines: boolean
  textMotion: 'rise' | 'fall'
  transition?: { kind: TransitionKind; duration: number }
  missing: MissingShot[]
  clips: string[]
}

export interface PlanOptions {
  /** Draw every shot as a placeholder, even when its capture exists (the film « d’attente »). */
  placeholders?: boolean
}

/**
 * The plan of a scene in a language and a format. A screen recording that exists takes the place of the stills it replaces. A missing capture is
 * drawn as a neutral window, or its step is left out when the scene says so; either way it is listed in `missing`, for the log of the render.
 */
export function planScene(spec: SceneSpec, lang: Lang, format: Format, sources: Sources, hotspots: Hotspots, options: PlanOptions = {}): ScenePlan {
  const theme: Theme = spec.theme ?? 'light'
  const missing: MissingShot[] = []
  const clips: string[] = []
  const media = (shot: string, shotTheme: Theme): Media | undefined => {
    const size = sources.size(shot)
    const file = options.placeholders ? undefined : sources.capture(shot, shotTheme)
    const base = { shot, theme: shotTheme, width: size.width, height: size.height, tint: sources.tint(shot) }
    return file === undefined ? undefined : { ...base, kind: 'capture', file }
  }
  const drawing = (shot: string, shotTheme: Theme): Media => {
    const size = sources.size(shot)
    return { kind: 'placeholder', shot, theme: shotTheme, width: size.width, height: size.height, tint: sources.tint(shot), placeholder: sources.placeholder(shot) }
  }

  let wanted = [...(spec.stills ?? [])]
  const recorded: PlannedStill[] = []
  for (const clip of spec.clips ?? []) {
    const clipTheme = clip.theme ?? theme
    const file = options.placeholders ? undefined : sources.clip(clip.id, clipTheme)
    if (file === undefined) continue
    clips.push(clip.id)
    wanted = wanted.filter((still) => !clip.replaces.includes(still.shot))
    const first = spec.stills?.[0]?.shot ?? clip.id
    const size = sources.size(first)
    recorded.push({ at: clip.at, fade: 0.3, media: { kind: 'clip', shot: clip.id, theme: clipTheme, width: size.width, height: size.height, tint: sources.tint(first), file } })
  }

  const stills: PlannedStill[] = [...recorded]
  for (const still of wanted) {
    const stillTheme = still.theme ?? theme
    let found = media(still.shot, stillTheme)
    if (found === undefined) {
      const skip = still.ifMissing === 'skip'
      missing.push({ scene: spec.number, shot: still.shot, theme: stillTheme, outcome: skip ? 'skipped' : 'placeholder' })
      if (skip) continue
      found = drawing(still.shot, stillTheme)
    }
    stills.push({
      at: still.at,
      fade: still.fade ?? 0.45,
      media: found,
      ...(still.reveal ? { reveal: { rect: rectOf(hotspots, still.shot, still.reveal.spot, lang), motion: still.reveal.motion } } : {})
    })
  }
  stills.sort((a, b) => a.at - b.at)
  // The first image is on screen from the start of the scene, and comes in without a reveal (a recording still starts at its own time).
  const head = stills[0]
  if (head) stills[0] = { at: head.media.kind === 'clip' ? head.at : 0, fade: 0, media: head.media }

  const tiles = (spec.tiles ?? []).map((tile) => {
    const found = media(tile.shot, theme)
    if (found === undefined) missing.push({ scene: spec.number, shot: tile.shot, theme, outcome: 'placeholder' })
    return { media: found ?? drawing(tile.shot, theme), caption: tile[lang] }
  })

  const geo = geometry(spec.layout, format)
  const firstShot = spec.stills?.[0]?.shot
  const sized = stills[0]?.media
  const hasWindow = spec.kind === 'window' || spec.kind === 'spaces' || spec.kind === 'little'
  const shotOf = (shot: string | undefined): string => {
    const name = shot ?? firstShot
    if (name === undefined) throw new Error(`scène ${spec.number} : un anneau ou un pointeur sans prise`)
    return name
  }

  return {
    number: spec.number,
    id: spec.id,
    kind: spec.kind,
    layout: spec.layout,
    backdrop: spec.backdrop,
    theme,
    duration: spec.duration,
    geometry: geo,
    ...(hasWindow && sized ? { window: windowBox(geo, { width: sized.width, height: sized.height }, spec.layout, spec.fit) } : {}),
    stills,
    tiles,
    camera: [...(spec.camera ?? [])],
    rings: (spec.rings ?? []).map((ring) => ({ from: ring.from, to: ring.to, rect: rectOf(hotspots, shotOf(ring.shot), ring.spot, lang), veil: ring.veil === true })),
    cursor: (spec.cursor ?? []).map((key) => ({
      at: key.at,
      point: pointOf(hotspots, shotOf(key.shot), key.spot, lang),
      click: key.click === true,
      ...(key.key !== undefined ? { key: key.key } : {})
    })),
    marks: [...(spec.marks ?? [])],
    keys: (spec.keys ?? []).map((key) => ({ at: key.at, keys: [...key.keys], point: pointOf(hotspots, shotOf(key.shot), key.spot, lang) })),
    ...(spec.enter ? { enter: spec.enter } : {}),
    lines: spec.lines.map((line) => ({ at: line.at, text: line[lang], ...(line.style ? { style: line.style } : {}) })),
    focusLines: spec.focusLines === true,
    textMotion: spec.textMotion ?? 'rise',
    ...(spec.transition ? { transition: { ...spec.transition } } : {}),
    missing,
    clips
  }
}

/** The lines of the log for the missing captures of a render: one per shot and theme, with the scenes that wait for it and what they do. */
export function missingReport(missing: readonly MissingShot[], lang: Lang): string[] {
  const byShot = new Map<string, MissingShot[]>()
  for (const item of missing) {
    const key = `${lang}/${item.theme}/${item.shot}`
    byShot.set(key, [...(byShot.get(key) ?? []), item])
  }
  return [...byShot.entries()].map(([key, items]) => {
    const scenes = items.map((item) => `${item.scene} (${item.outcome === 'skipped' ? 'étape sautée' : 'image d’attente'})`).join(', ')
    return `capture manquante : ${key} — scène ${scenes}`
  })
}
