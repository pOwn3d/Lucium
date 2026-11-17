import { describe, expect, it } from 'vitest'
import { LANGS, MAIN_SIZE, SHOTS } from '../site-captures/shots'
import { EXTRA_SHOTS, HOTSPOTS, SCENES, SHOT_PLACEHOLDERS, type SceneSpec, type Size } from './scenes'
import { FORMATS, MAX_SCALE, geometry, largestScale, missingReport, parseFormats, planScene, pointOf, rectOf, spotOf, windowBox, type Sources } from './layout'

const SIZES = new Map<string, Size>([...SHOTS.map((s) => [s.id, s.size] as const), ...EXTRA_SHOTS.map((s) => [s.id, s.size] as const)])

/** Sources where only the shots listed exist (as captures), and the recordings listed. */
const sources = (captures: readonly string[] = [], clips: readonly string[] = []): Sources => ({
  capture: (shot, theme) => (captures.includes(shot) ? `/captures/${theme}/${shot}-no-shadow.png` : undefined),
  clip: (id, theme) => (clips.includes(id) ? `/captures/${theme}/videos/${id}.mov` : undefined),
  size: (shot) => SIZES.get(shot) ?? MAIN_SIZE,
  placeholder: (shot) => SHOT_PLACEHOLDERS[shot] ?? 'main',
  tint: () => '#4f74f2'
})

const spec = (number: number) => SCENES.find((s) => s.number === number) as SceneSpec

describe('the layouts', () => {
  it('keeps every box inside the frame, in both formats', () => {
    for (const format of Object.values(FORMATS)) {
      for (const layout of ['center', 'stack', 'stack-bottom', 'panel-left', 'panel-right'] as const) {
        const geo = geometry(layout, format)
        for (const box of [geo.text, geo.media]) {
          expect(box.x, `${layout} ${format.name}`).toBeGreaterThanOrEqual(0)
          expect(box.y).toBeGreaterThanOrEqual(0)
          expect(box.x + box.w).toBeLessThanOrEqual(format.width)
          expect(box.y + box.h).toBeLessThanOrEqual(format.height)
        }
      }
    }
  })

  it('never enlarges a capture to fit, and keeps the window under the text in `stack`', () => {
    const geo = geometry('stack', FORMATS.wide)
    const win = windowBox(geo, { width: 780, height: 760 }, 'stack', 1)
    expect(win.scale).toBe(1)
    expect(win.y).toBe(geo.media.y)
    const main = windowBox(geo, MAIN_SIZE, 'stack')
    expect(main.scale).toBeLessThan(1)
    expect(main.y + main.h).toBeLessThanOrEqual(FORMATS.wide.height)
    expect(windowBox(geometry('panel-left', FORMATS.wide), MAIN_SIZE, 'panel-left', 'native').scale).toBe(1)
  })

  it('never makes the camera enlarge a 1× capture past 1.15, in any scene and format', () => {
    for (const format of Object.values(FORMATS)) {
      for (const lang of LANGS) {
        for (const scene of SCENES) {
          const plan = planScene(scene, lang, format, sources(), HOTSPOTS)
          if (!plan.window) continue
          expect(largestScale(plan.window, plan.camera), `scène ${scene.number} ${format.name}`).toBeLessThanOrEqual(MAX_SCALE)
        }
      }
    }
  })

  it('reads --formats', () => {
    expect(parseFormats(undefined)).toEqual(['wide', 'square'])
    expect(parseFormats('square')).toEqual(['square'])
    expect(() => parseFormats('vertical')).toThrow(/valeur inconnue/)
  })
})

describe('the places of the shots', () => {
  it('finds a place in the language of the film when the texts move it', () => {
    expect(spotOf(HOTSPOTS, 'main-window', 'peekLink', 'fr')).toEqual([0.752, 0.61])
    expect(spotOf(HOTSPOTS, 'main-window', 'peekLink', 'en')).toEqual([0.673, 0.609])
    expect(pointOf(HOTSPOTS, 'main-window', 'sidebar', 'fr')).toEqual([0.11215, 0.5])
  })

  it('refuses a place or a shot that is not written down, and a point where a rectangle is needed', () => {
    expect(() => spotOf(HOTSPOTS, 'main-window', 'nowhere', 'fr')).toThrow(/pas d’emplacement « nowhere »/)
    expect(() => spotOf(HOTSPOTS, 'no-such-shot', 'sidebar', 'fr')).toThrow(/no-such-shot/)
    expect(() => rectOf(HOTSPOTS, 'main-window', 'spaceHome', 'fr')).toThrow(/est un point/)
  })

  it('keeps every place inside its image', () => {
    for (const [shot, spots] of Object.entries(HOTSPOTS)) {
      for (const [name, spot] of Object.entries(spots)) {
        for (const value of 'fr' in spot ? [spot.fr, spot.en] : [spot]) {
          const [x, y, w = 0, h = 0] = value
          expect(x >= 0 && y >= 0 && x + w <= 1.0001 && y + h <= 1.0001, `${shot}.${name}`).toBe(true)
        }
      }
    }
  })
})

describe('the plan of a scene', () => {
  it('resolves every ring, pointer and reveal of every scene, in both languages', () => {
    for (const lang of LANGS) for (const scene of SCENES) expect(() => planScene(scene, lang, FORMATS.wide, sources(), HOTSPOTS), `scène ${scene.number}`).not.toThrow()
  })

  it('knows every shot it uses: in shots.ts, or listed as one to add', () => {
    const known = new Set([...SHOTS.map((s) => s.id), ...EXTRA_SHOTS.map((s) => s.id)])
    for (const scene of SCENES) for (const shot of [...(scene.stills ?? []), ...(scene.tiles ?? [])].map((s) => s.shot)) expect(known.has(shot), shot).toBe(true)
  })

  it('uses the capture when it exists, and draws a neutral window when it does not', () => {
    const plan = planScene(spec(5), 'fr', FORMATS.wide, sources(['main-window', 'command-bar-calc']), HOTSPOTS)
    expect(plan.stills.map((s) => [s.media.shot, s.media.kind])).toEqual([
      ['main-window', 'capture'],
      ['command-bar-calc', 'capture'],
      ['command-bar-tab', 'placeholder']
    ])
    expect(plan.stills[1]?.reveal).toEqual({ rect: [0.25, 0.14, 0.5, 0.3733], motion: 'pop' })
    expect(plan.missing).toEqual([{ scene: 5, shot: 'command-bar-tab', theme: 'light', outcome: 'placeholder' }])
  })

  it('leaves out a missing step the scene says it can do without, and still shows the first image from the start', () => {
    const plan = planScene(spec(10), 'fr', FORMATS.wide, sources(['settings-privacy']), HOTSPOTS)
    expect(plan.stills).toHaveLength(1)
    expect(plan.stills[0]).toMatchObject({ at: 0, fade: 0, media: { shot: 'settings-privacy', theme: 'dark', kind: 'capture' } })
    expect(plan.missing).toEqual([{ scene: 10, shot: 'settings-privacy-off', theme: 'dark', outcome: 'skipped' }])
  })

  it('lets a screen recording take the place of the stills it replaces', () => {
    const plan = planScene(spec(5), 'fr', FORMATS.wide, sources(['main-window'], ['command-bar-typing']), HOTSPOTS)
    expect(plan.stills.map((s) => [s.media.shot, s.media.kind, s.at])).toEqual([
      ['main-window', 'capture', 0],
      ['command-bar-typing', 'clip', 0.9]
    ])
    expect(plan.clips).toEqual(['command-bar-typing'])
    expect(plan.missing).toEqual([])
  })

  it('draws everything with --placeholders, captures or not', () => {
    const plan = planScene(spec(2), 'en', FORMATS.square, sources(['main-window']), HOTSPOTS, { placeholders: true })
    expect(plan.stills[0]?.media).toMatchObject({ kind: 'placeholder', placeholder: 'main', width: 1440, height: 900 })
  })

  it('puts the texts of its language in the plan', () => {
    expect(planScene(spec(7), 'en', FORMATS.wide, sources(), HOTSPOTS).lines.map((l) => l.text)).toEqual(['A quick look,', 'without leaving your page.'])
  })

  it('reports each missing capture once, with the scenes that wait for it', () => {
    const report = missingReport(
      [
        { scene: 12, shot: 'settings-guide-recap', theme: 'light', outcome: 'skipped' },
        { scene: 13, shot: 'import', theme: 'light', outcome: 'placeholder' }
      ],
      'fr'
    )
    expect(report).toEqual(['capture manquante : fr/light/settings-guide-recap — scène 12 (étape sautée)', 'capture manquante : fr/light/import — scène 13 (image d’attente)'])
  })

  it('takes the shots of the application from shots.ts: only what lies outside it is an extra shot, and every shot has its drawing', () => {
    const ids = new Set(SHOTS.map((s) => s.id))
    expect(EXTRA_SHOTS.map((s) => s.id)).toEqual(['other-app'])
    for (const extra of EXTRA_SHOTS) expect(ids.has(extra.id), extra.id).toBe(false)
    for (const shot of SHOTS) expect(SHOT_PLACEHOLDERS[shot.id], shot.id).toBeDefined()
    // The site calls the sheet of the import `import` (data-shot="import" in lucium-website).
    expect(ids.has('import')).toBe(true)
    expect(ids.has('import-arc')).toBe(false)
  })
})

// « Régler en quelques questions » has one entry, its card at the top of « Pour commencer » (the cards at the head of the other pages are gone): the scene of
// the guide starts from a shot of that page, and only a shot of that page has a place for the card.
describe('the scene of the guide (12)', () => {
  const shotOf = (id: string) => SHOTS.find((shot) => shot.id === id)
  const onHome = (id: string): boolean => shotOf(id)?.scene.settings?.pane === 'home' && shotOf(id)?.scene.settings?.guide === undefined

  it('opens the guide from « Pour commencer »: its first image is that page, and the card it rings and the button it clicks are on it', () => {
    const scene = SCENES.find((one) => one.number === 12)!
    expect(scene.id).toBe('guide')
    expect(onHome(scene.stills![0]!.shot), scene.stills![0]!.shot).toBe(true)
    const pointed = [...(scene.rings ?? []), ...(scene.cursor ?? [])].filter((mark) => mark.spot === 'guideCard' || mark.spot === 'start')
    expect(pointed.length).toBeGreaterThan(1)
    for (const mark of pointed) expect(onHome(mark.shot ?? ''), `${mark.spot} on ${mark.shot ?? 'the image on screen'}`).toBe(true)
  })

  it('finds the card of the guide on no other page', () => {
    for (const [shot, spots] of Object.entries(HOTSPOTS)) if ('guideCard' in spots || 'start' in spots) expect(onHome(shot), shot).toBe(true)
  })
})
