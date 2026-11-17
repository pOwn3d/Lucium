import { describe, expect, it } from 'vitest'
import { SCENES, type SceneSpec } from './scenes'
import { buildTimeline, clock, findScene, frameState, frameStates, framesOf, fullRange, isFull, parseLangs, parseRange, sceneText, splitFrames, transcript, vttTime, webvtt } from './timeline'

const scene = (number: number, duration: number, extra: Partial<SceneSpec> = {}): SceneSpec => ({
  number,
  id: `s${number}`,
  description: '',
  duration,
  kind: 'window',
  layout: 'stack',
  backdrop: 'white',
  lines: [],
  ...extra
})

describe('the timeline of the film', () => {
  const timeline = buildTimeline(SCENES)

  it('lays the fifteen scenes of the storyboard end to end, 88 seconds, 2640 frames', () => {
    expect(timeline.scenes).toHaveLength(15)
    expect(timeline.duration).toBe(88)
    expect(framesOf(timeline.duration)).toBe(2640)
    expect(timeline.scenes.map((s) => s.start)).toEqual([0, 4, 9, 14, 19, 25, 31, 36, 41, 48, 55, 62, 68, 74, 80])
  })

  it('has a text for every scene, in both languages', () => {
    for (const spec of SCENES) {
      expect(spec.lines.length, `scène ${spec.number}`).toBeGreaterThan(0)
      for (const line of spec.lines) {
        expect(line.fr.trim(), `scène ${spec.number}`).not.toBe('')
        expect(line.en.trim(), `scène ${spec.number}`).not.toBe('')
      }
    }
  })

  it('leaves every line on screen long enough to be read before its scene gives way', () => {
    // Half a second to come in, then about 0.28 s a word; the scene keeps playing for half of the transition that follows it.
    SCENES.forEach((spec, i) => {
      const after = (SCENES[i + 1]?.transition?.duration ?? 0) / 2
      for (const line of spec.lines) {
        for (const text of [line.fr, line.en]) {
          const words = text.split(/\s+/).filter(Boolean).length
          expect(line.at + 0.5 + 0.28 * words, `scène ${spec.number} : « ${text} »`).toBeLessThanOrEqual(spec.duration + after + 1e-9)
        }
      }
    })
  })

  it('names no other browser in its texts', () => {
    const texts = SCENES.flatMap((spec) => [...spec.lines.flatMap((l) => [l.fr, l.en]), ...(spec.tiles ?? []).flatMap((t) => [t.fr, t.en])]).join(' ')
    expect(texts).not.toMatch(/\b(arc|chrome|safari|firefox|edge|brave|opera|vivaldi)\b/i)
  })

  it('refuses scenes whose numbers do not follow each other', () => {
    expect(() => buildTimeline([scene(1, 2), scene(3, 2)])).toThrow(/numéro 3, attendu 2/)
  })

  it('refuses an id used twice', () => {
    expect(() => buildTimeline([scene(1, 2), { ...scene(2, 2), id: 's1' }])).toThrow(/déjà pris/)
  })

  it('refuses a duration that is not positive', () => {
    expect(() => buildTimeline([scene(1, 0)])).toThrow(/durée invalide/)
    expect(() => buildTimeline([scene(1, Number.NaN)])).toThrow(/durée invalide/)
  })

  it('refuses a transition longer than one of the scenes it joins, or into the first scene', () => {
    expect(() => buildTimeline([scene(1, 1), scene(2, 4, { transition: { kind: 'fade', duration: 1.5 } })])).toThrow(/plus longue/)
    expect(() => buildTimeline([scene(1, 2, { transition: { kind: 'fade', duration: 0.5 } })])).toThrow(/première scène/)
  })

  it('refuses a line that appears outside its scene', () => {
    expect(() => buildTimeline([scene(1, 2, { lines: [{ at: 2, fr: 'x', en: 'x' }] })])).toThrow(/hors de la scène/)
  })
})

describe('what a frame shows', () => {
  const timeline = buildTimeline(SCENES)
  const at = (seconds: number, range = fullRange(timeline)) => frameState(timeline, framesOf(seconds), range)

  it('shows one scene, at its own time, away from the transitions', () => {
    expect(at(2)).toEqual({ frame: 60, time: 2, layers: [{ scene: 0, local: 2 }] })
    expect(at(6.5).layers).toEqual([{ scene: 1, local: 2.5 }])
  })

  it('centres a transition on the boundary: half before, half after', () => {
    // Into scene 2: a fade of 0.6 s, from 3.7 s to 4.3 s.
    expect(at(3.6).layers).toHaveLength(1)
    const start = at(3.7)
    expect(start.layers.map((l) => l.scene)).toEqual([0, 1])
    expect(start.transition).toMatchObject({ kind: 'fade', from: 0, to: 1 })
    expect(start.transition?.progress).toBeCloseTo(0)
    const middle = at(4)
    expect(middle.transition?.progress).toBeCloseTo(0.5)
    expect(middle.layers[0]?.local).toBeCloseTo(4)
    expect(middle.layers[1]?.local).toBeCloseTo(0)
    expect(at(4.3).layers).toEqual([{ scene: 1, local: expect.closeTo(0.3, 5) }])
  })

  it('lets the scene that comes start early: below 0 in its own time', () => {
    const state = at(3.9)
    expect(state.layers[1]?.scene).toBe(1)
    expect(state.layers[1]?.local).toBeCloseTo(-0.1)
  })

  it('makes a cut without any overlap', () => {
    const cut = buildTimeline([scene(1, 1), scene(2, 1, { transition: { kind: 'cut', duration: 0 } })])
    expect(frameState(cut, 29).layers).toEqual([{ scene: 0, local: 29 / 30 }])
    expect(frameState(cut, 30).layers).toEqual([{ scene: 1, local: 0 }])
  })

  it('leaves out, in a part of the film, the transitions towards scenes outside of it', () => {
    const part = parseRange(timeline, '1', '3')
    // The last frame of scene 3 would already show the start of scene 4 in the whole film.
    expect(frameState(timeline, part.endFrame - 1).layers.map((l) => l.scene)).toEqual([2, 3])
    expect(frameState(timeline, part.endFrame - 1, part).layers.map((l) => l.scene)).toEqual([2])
    const later = parseRange(timeline, '2', '2')
    expect(frameState(timeline, later.startFrame, later).layers).toEqual([{ scene: 1, local: 0 }])
  })

  it('gives one state per frame of a range, in order', () => {
    const part = parseRange(timeline, 'spaces', 'spaces')
    const states = frameStates(timeline, part)
    expect(states).toHaveLength(150)
    expect(states[0]?.frame).toBe(270)
    expect(states.at(-1)?.frame).toBe(419)
  })
})

describe('the part of the film to render', () => {
  const timeline = buildTimeline(SCENES)

  it('is the whole film by default', () => {
    const range = parseRange(timeline, undefined, undefined)
    expect(range).toEqual({ first: 0, last: 14, startFrame: 0, endFrame: 2640 })
    expect(isFull(timeline, range)).toBe(true)
  })

  it('goes from the start of a scene to the end of another, by number or by name', () => {
    expect(parseRange(timeline, '1', '3')).toEqual({ first: 0, last: 2, startFrame: 0, endFrame: 420 })
    expect(parseRange(timeline, 'privacy', 'mosaic')).toEqual({ first: 9, last: 10, startFrame: 1440, endFrame: 1860 })
    expect(isFull(timeline, parseRange(timeline, '1', '3'))).toBe(false)
  })

  it('takes times in seconds too', () => {
    expect(parseRange(timeline, '12.5s', '20s')).toEqual({ first: 2, last: 4, startFrame: 375, endFrame: 600 })
  })

  it('refuses an unknown scene, and an empty or reversed range', () => {
    expect(() => findScene(timeline, '16')).toThrow(/scène inconnue/)
    expect(() => parseRange(timeline, 'nowhere', undefined)).toThrow(/scène inconnue/)
    expect(() => parseRange(timeline, '3', '2')).toThrow(/partie vide/)
    expect(() => parseRange(timeline, '90s', undefined)).toThrow(/partie vide/)
  })

  it('shares the frames between pages in runs that touch, without a gap', () => {
    const range = parseRange(timeline, '1', '3')
    const runs = splitFrames(range, 4)
    expect(runs).toHaveLength(4)
    expect(runs[0]?.startFrame).toBe(0)
    expect(runs.at(-1)?.endFrame).toBe(420)
    runs.slice(1).forEach((run, i) => expect(run.startFrame).toBe(runs[i]?.endFrame))
    expect(splitFrames({ first: 0, last: 0, startFrame: 10, endFrame: 12 }, 8)).toHaveLength(2)
  })

  it('reads --lang', () => {
    expect(parseLangs(undefined)).toEqual(['fr', 'en'])
    expect(parseLangs('all')).toEqual(['fr', 'en'])
    expect(parseLangs('en')).toEqual(['en'])
    expect(() => parseLangs('de')).toThrow(/valeur inconnue/)
  })
})

describe('the texts and their times', () => {
  const timeline = buildTimeline(SCENES)

  it('writes the times of the transcript and of WebVTT', () => {
    expect(clock(61.9)).toBe('01:01')
    expect(vttTime(83.4)).toBe('00:01:23.400')
    expect(vttTime(3661.0055)).toBe('01:01:01.006')
  })

  it('joins the lines of a scene as they read on screen', () => {
    expect(sceneText(SCENES[1] as SceneSpec, 'fr')).toBe('Vos onglets à gauche. Le web à droite.')
    expect(sceneText(SCENES[1] as SceneSpec, 'en')).toBe('Your tabs on the left. The web on the right.')
  })

  it('makes a transcript per language, with the time of each text and the captions of the mosaic', () => {
    const fr = transcript(timeline, 'fr')
    expect(fr).toContain('Durée : 1 min 28 s, sans voix.')
    expect(fr).toContain('00:04  Vos onglets à gauche. Le web à droite.')
    expect(fr).toContain('Mode lecture · PDF · Traduction sur ce Mac')
    const en = transcript(timeline, 'en')
    expect(en).toContain('Length: 1 min 28 s, no voice-over.')
    expect(en).toContain('01:20  Free. Open. For Mac. lucium.app Mac with Apple silicon')
  })

  it('makes a WebVTT track with one cue per scene, from its first text to its end', () => {
    const vtt = webvtt(timeline, 'en')
    expect(vtt.startsWith('WEBVTT\n\n1\n00:00:01.700 --> 00:00:04.000\nLucium\n')).toBe(true)
    expect(vtt).toContain('2\n00:00:04.500 --> 00:00:09.000\nYour tabs on the left. The web on the right.\n')
    expect(vtt.match(/-->/g)).toHaveLength(15)
  })
})
