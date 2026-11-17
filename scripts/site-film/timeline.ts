// The timing of the film: where each scene starts and ends, which scenes are on screen at a given frame and how far their transition is, the part
// of the film a command line asks for (`--from`, `--to`), and the texts with their times (the transcript and the WebVTT track of the site).
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Lang } from '../site-captures/shots'
import type { SceneSpec, TransitionKind } from './scenes'

/** Images per second of the film. */
export const FPS = 30

export interface TimedScene {
  spec: SceneSpec
  /** Its place in the film, from 0. */
  index: number
  /** Seconds from the start of the film. */
  start: number
  end: number
}

export interface Timeline {
  scenes: TimedScene[]
  duration: number
}

/**
 * The scenes laid end to end, in the order of their numbers. Throws on what would make a broken film: numbers that do not follow 1, 2, 3…, an id
 * used twice, a duration that is not positive, a transition longer than one of the two scenes it joins, or a line that appears outside its scene.
 */
export function buildTimeline(specs: readonly SceneSpec[]): Timeline {
  if (specs.length === 0) throw new Error('le film n’a aucune scène')
  const ids = new Set<string>()
  const scenes: TimedScene[] = []
  let start = 0
  specs.forEach((spec, index) => {
    if (spec.number !== index + 1) throw new Error(`scène ${spec.id} : numéro ${spec.number}, attendu ${index + 1}`)
    if (ids.has(spec.id)) throw new Error(`scène ${spec.number} : identifiant « ${spec.id} » déjà pris`)
    ids.add(spec.id)
    if (!(spec.duration > 0) || !Number.isFinite(spec.duration)) throw new Error(`scène ${spec.number} : durée invalide (${spec.duration})`)
    const transition = spec.transition
    if (transition !== undefined) {
      if (index === 0) throw new Error('la première scène n’a pas de transition d’entrée')
      const previous = specs[index - 1] as SceneSpec
      if (transition.duration < 0 || transition.duration > Math.min(previous.duration, spec.duration)) {
        throw new Error(`scène ${spec.number} : transition de ${transition.duration} s, plus longue qu’une des deux scènes qu’elle relie`)
      }
    }
    for (const line of spec.lines) {
      if (line.at < 0 || line.at >= spec.duration) throw new Error(`scène ${spec.number} : le texte « ${line.fr} » apparaît à ${line.at} s, hors de la scène`)
    }
    scenes.push({ spec, index, start, end: start + spec.duration })
    start += spec.duration
  })
  return { scenes, duration: start }
}

/** The number of frames of a stretch of film: whole frames, rounded to the nearest (88 s at 30 images per second: 2640). */
export const framesOf = (seconds: number, fps = FPS): number => Math.round(seconds * fps)

/** The time of a frame: its start (frame 0 is at 0 s). */
export const timeOf = (frame: number, fps = FPS): number => frame / fps

/** The part of the film to render: from the first to the last scene (indexes, inclusive), and its frames, the last one excluded. */
export interface Range {
  first: number
  last: number
  startFrame: number
  endFrame: number
}

/** The whole film. */
export const fullRange = (timeline: Timeline, fps = FPS): Range => ({ first: 0, last: timeline.scenes.length - 1, startFrame: 0, endFrame: framesOf(timeline.duration, fps) })

/** Whether a range is the whole film (the names of the files and the poster depend on it). */
export const isFull = (timeline: Timeline, range: Range, fps = FPS): boolean =>
  range.first === 0 && range.last === timeline.scenes.length - 1 && range.startFrame === 0 && range.endFrame === framesOf(timeline.duration, fps)

/** A scene named on the command line: its number (`3`) or its id (`spaces`). Throws with the list of scenes when it does not exist. */
export function findScene(timeline: Timeline, raw: string): TimedScene {
  const value = raw.trim()
  const found = /^\d+$/.test(value) ? timeline.scenes.find((s) => s.spec.number === Number(value)) : timeline.scenes.find((s) => s.spec.id === value)
  if (!found) throw new Error(`scène inconnue « ${raw} » (de 1 à ${timeline.scenes.length}, ou : ${timeline.scenes.map((s) => s.spec.id).join(', ')})`)
  return found
}

const SECONDS = /^(\d+(?:\.\d+)?)s$/

/**
 * The range of `--from` and `--to`: each is a scene (number or id: from its start, to its end) or a time in seconds (`12.5s`). Absent: the start
 * and the end of the film. Throws when the range is empty or outside the film.
 */
export function parseRange(timeline: Timeline, from: string | undefined, to: string | undefined, fps = FPS): Range {
  const total = framesOf(timeline.duration, fps)
  const edge = (raw: string | undefined, side: 'from' | 'to'): number => {
    if (raw === undefined || raw.trim() === '') return side === 'from' ? 0 : total
    const seconds = SECONDS.exec(raw.trim())
    if (seconds) return framesOf(Number(seconds[1]), fps)
    const scene = findScene(timeline, raw)
    return framesOf(side === 'from' ? scene.start : scene.end, fps)
  }
  const startFrame = edge(from, 'from')
  const endFrame = edge(to, 'to')
  if (startFrame < 0 || endFrame > total || endFrame <= startFrame) throw new Error(`partie vide ou hors du film : --from ${from ?? 'début'} --to ${to ?? 'fin'} (le film dure ${timeline.duration} s)`)
  const sceneAt = (frame: number) => timeline.scenes.findIndex((s) => frame < framesOf(s.end, fps))
  return { first: sceneAt(startFrame), last: sceneAt(endFrame - 1), startFrame, endFrame }
}

/** A scene on screen in a frame, and its own time (seconds from its start: below 0 or past its duration during a transition). */
export interface Layer {
  scene: number
  local: number
}

export interface FrameState {
  frame: number
  time: number
  /** From the bottom to the top: one scene, or two during a transition (the one that leaves, then the one that comes). */
  layers: Layer[]
  transition?: { kind: TransitionKind; progress: number; from: number; to: number }
}

/**
 * What a frame shows. A transition is centred on the boundary between two scenes: the scene that leaves keeps playing for half of it, the scene
 * that comes has started half of it early. Inside a range, the transitions towards scenes outside of it are left out: the first scene starts alone,
 * and the last one ends alone.
 */
export function frameState(timeline: Timeline, frame: number, range: Range = fullRange(timeline), fps = FPS): FrameState {
  const time = timeOf(frame, fps)
  const { scenes } = timeline
  let index = scenes.findIndex((s) => time < s.end)
  if (index === -1) index = scenes.length - 1
  index = Math.min(Math.max(index, range.first), range.last)
  const current = scenes[index] as TimedScene
  const layer = (scene: TimedScene): Layer => ({ scene: scene.index, local: time - scene.start })

  const incoming = current.spec.transition
  if (incoming && incoming.duration > 0 && index > range.first) {
    const begin = current.start - incoming.duration / 2
    if (time < current.start + incoming.duration / 2 && time >= begin) {
      const previous = scenes[index - 1] as TimedScene
      return { frame, time, layers: [layer(previous), layer(current)], transition: { kind: incoming.kind, progress: (time - begin) / incoming.duration, from: previous.index, to: current.index } }
    }
  }
  const next = scenes[index + 1]
  const outgoing = next?.spec.transition
  if (next && outgoing && outgoing.duration > 0 && index < range.last) {
    const begin = current.end - outgoing.duration / 2
    if (time >= begin) {
      return { frame, time, layers: [layer(current), layer(next)], transition: { kind: outgoing.kind, progress: (time - begin) / outgoing.duration, from: current.index, to: next.index } }
    }
  }
  return { frame, time, layers: [layer(current)] }
}

/** The frame states of a range, in order: what the page is asked to draw, one after the other. */
export function frameStates(timeline: Timeline, range: Range, fps = FPS): FrameState[] {
  const states: FrameState[] = []
  for (let frame = range.startFrame; frame < range.endFrame; frame++) states.push(frameState(timeline, frame, range, fps))
  return states
}

/** Splits the frames of a range into `count` runs of nearly equal length, for pages that render side by side (fewer when the range is short). */
export function splitFrames(range: Range, count: number): Array<{ startFrame: number; endFrame: number }> {
  const total = range.endFrame - range.startFrame
  const parts = Math.max(1, Math.min(Math.floor(count), total))
  const runs: Array<{ startFrame: number; endFrame: number }> = []
  for (let i = 0; i < parts; i++) {
    runs.push({ startFrame: range.startFrame + Math.floor((total * i) / parts), endFrame: range.startFrame + Math.floor((total * (i + 1)) / parts) })
  }
  return runs
}

/** `--lang fr`, `en` or `all` (both, French first). */
export function parseLangs(raw: string | undefined): Lang[] {
  const value = (raw ?? 'all').trim()
  if (value === 'all' || value === '') return ['fr', 'en']
  if (value === 'fr' || value === 'en') return [value]
  throw new Error(`--lang : valeur inconnue « ${raw} » (fr, en ou all)`)
}

// ---------- the texts and their times ----------

/** `01:23` (minutes and seconds) for the transcript. */
export function clock(seconds: number): string {
  const whole = Math.floor(seconds + 1e-6)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

/** `00:01:23.400` for WebVTT. */
export function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

/** The text of a scene in a language: its lines joined as they read on screen. */
export const sceneText = (spec: SceneSpec, lang: Lang): string => spec.lines.map((line) => line[lang]).join(' ')

const TRANSCRIPT_HEAD: Readonly<Record<Lang, (duration: string) => string>> = {
  fr: (d) => `Lucium — textes du film de présentation\nDurée : ${d}, sans voix. Les textes apparaissent à l’écran aux moments indiqués.\n`,
  en: (d) => `Lucium — on-screen text of the introduction film\nLength: ${d}, no voice-over. The text appears on screen at the times shown.\n`
}

/** `1 min 28 s`: the same in both languages. */
const durationLabel = (seconds: number): string => {
  const m = Math.floor(seconds / 60)
  return `${m} min ${Math.round(seconds - m * 60)} s`
}

/** The transcript for the site: every text of the film, by scene, with the time it appears; the captions of the mosaic under its line. */
export function transcript(timeline: Timeline, lang: Lang): string {
  const out = [TRANSCRIPT_HEAD[lang](durationLabel(timeline.duration))]
  for (const scene of timeline.scenes) {
    const first = scene.spec.lines[0]
    out.push(`${clock(scene.start + (first?.at ?? 0))}  ${sceneText(scene.spec, lang)}`)
    if (scene.spec.tiles?.length) out.push(`       ${scene.spec.tiles.map((tile) => tile[lang]).join(' · ')}`)
  }
  return `${out.join('\n')}\n`
}

/**
 * The WebVTT track of the site (`lucium-<lang>.vtt`): one cue per scene, from its first text to the end of the scene, so that a screen reader or
 * the captions of the player give the words that are on screen.
 */
export function webvtt(timeline: Timeline, lang: Lang): string {
  const cues = ['WEBVTT', '']
  for (const scene of timeline.scenes) {
    const first = scene.spec.lines[0]
    if (!first) continue
    let text = sceneText(scene.spec, lang)
    if (scene.spec.tiles?.length) text += `\n${scene.spec.tiles.map((tile) => tile[lang]).join(' · ')}`
    cues.push(String(scene.spec.number), `${vttTime(scene.start + first.at)} --> ${vttTime(scene.end)}`, text, '')
  }
  return cues.join('\n')
}
