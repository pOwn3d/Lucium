// Play and pause have one drawing in Lucium, the media player's (media-glyphs.tsx). The interface once drew three plays and three pauses of its own
// (the media player, the floating video, the video behind a space), and a download and the card of a setting drew theirs too: here every source file
// is read, and a second drawing of play or pause is refused wherever it is: a component of that name, an SVG that holds only a play triangle or
// only two pause bars, or a stylesheet that draws one.

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PauseGlyph, PlayGlyph } from './media-glyphs'
import { posix } from '../main/windows.test-support'

const SRC = fileURLToPath(new URL('../', import.meta.url))
const GLYPHS = 'renderer/media-glyphs.tsx'
/** Every file of the application that can draw something: components, pages built as text, stylesheets. Tests and their fixtures are not drawn. */
const sources = (): Array<{ file: string; text: string }> =>
  (readdirSync(SRC, { recursive: true }) as string[])
    .filter((file) => /\.(tsx|ts|css|html)$/.test(file) && !/\.test(-support)?\.|lint-witness/.test(file))
    .map((file) => ({ file: posix(relative(SRC, join(SRC, file))), text: readFileSync(join(SRC, file), 'utf8') }))

type Point = [number, number]
const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.01

/** The polygons of a path made of straight lines (M L H V Z), one a subpath, with whether it is closed; null for a path with a curve. */
function polygonsOf(d: string): Array<{ points: Point[]; closed: boolean }> | null {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []
  const shapes: Array<{ points: Point[]; closed: boolean }> = []
  let at: Point = [0, 0]
  let command = ''
  let index = 0
  const number = (): number => Number(tokens[index++])
  const add = (point: Point) => {
    at = point
    const current = shapes.at(-1)
    const last = current?.points.at(-1)
    if (current && !(last && close(last[0], point[0]) && close(last[1], point[1]))) current.points.push(point)
  }
  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index] as string)) command = tokens[index++] as string
    const relative = command === command.toLowerCase()
    switch (command.toUpperCase()) {
      case 'M': {
        const x = number()
        const y = number()
        at = relative ? [at[0] + x, at[1] + y] : [x, y]
        shapes.push({ points: [at], closed: false })
        // Pairs after a moveto are linetos.
        command = relative ? 'l' : 'L'
        break
      }
      case 'L': {
        const x = number()
        const y = number()
        add(relative ? [at[0] + x, at[1] + y] : [x, y])
        break
      }
      case 'H': {
        const x = number()
        add([relative ? at[0] + x : x, at[1]])
        break
      }
      case 'V': {
        const y = number()
        add([at[0], relative ? at[1] + y : y])
        break
      }
      case 'Z': {
        const current = shapes.at(-1)
        if (current) {
          current.closed = true
          const [first] = current.points
          const last = current.points.at(-1)
          if (first && last && current.points.length > 1 && close(first[0], last[0]) && close(first[1], last[1])) current.points.pop()
          if (first) at = first
        }
        break
      }
      default:
        return null
    }
  }
  return shapes
}

/** A closed triangle with an upright side on the left and its tip to the right, about half way down: the play sign. */
const isPlayTriangle = ({ points, closed }: { points: Point[]; closed: boolean }): boolean => {
  if (!closed || points.length !== 3) return false
  return points.some((tip, at) => {
    const [a, b] = points.filter((_, other) => other !== at) as [Point, Point]
    const [top, bottom] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
    return close(a[0], b[0]) && tip[0] > a[0] + 0.5 && tip[1] > top + (bottom - top) / 4 && tip[1] < bottom - (bottom - top) / 4
  })
}

/** Two upright strokes of the same length side by side: the pause sign drawn as lines. */
const isPauseStrokes = (shapes: Array<{ points: Point[] }>): boolean => {
  if (shapes.length !== 2 || shapes.some((shape) => shape.points.length !== 2)) return false
  const [one, two] = shapes.map(({ points: [a, b] }) => ({ x: (a as Point)[0], upright: close((a as Point)[0], (b as Point)[0]), length: Math.abs((a as Point)[1] - (b as Point)[1]) }))
  return !!one && !!two && one.upright && two.upright && close(one.length, two.length) && one.length > 0 && !close(one.x, two.x)
}

const attribute = (tag: string, name: string): string | null => {
  const found = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|\\{'([^']*)'\\}|\\{"([^"]*)"\\}|\\{(-?[\\d.]+)\\}|\\\\"([^\\\\]*)\\\\")`).exec(tag)
  return found ? (found.slice(1).find((value) => value !== undefined) ?? null) : null
}

/** What an SVG draws, when it is only play or only pause; null when it draws anything else or something that cannot be read as text. */
function signOf(svg: string): 'play' | 'pause' | null {
  const shapes = [...svg.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon|text|use|image|g)\b([^>]*)>/g)].filter(([, name]) => name !== 'g')
  const paths = shapes.filter(([, name]) => name === 'path' || name === 'polygon')
  const rects = shapes.filter(([, name]) => name === 'rect')
  if (shapes.length === 1 && paths.length === 1) {
    const [, name, tag] = paths[0] as RegExpMatchArray
    const d = name === 'polygon' ? (attribute(tag as string, 'points') === null ? null : `M${attribute(tag as string, 'points')}z`) : attribute(tag as string, 'd')
    const polygons = d === null ? null : polygonsOf(d)
    if (!polygons) return null
    if (polygons.length === 1 && isPlayTriangle(polygons[0] as { points: Point[]; closed: boolean })) return 'play'
    if (isPauseStrokes(polygons)) return 'pause'
    return null
  }
  if (shapes.length === 2 && rects.length === 2) {
    const [a, b] = rects.map(([, , tag]) => ['x', 'y', 'width', 'height'].map((name) => Number(attribute(tag as string, name)))) as [number[], number[]]
    const [ax, ay, aw, ah] = a as [number, number, number, number]
    const [bx, by, bw, bh] = b as [number, number, number, number]
    if ([ax, ay, aw, ah, bx, by, bw, bh].some(Number.isNaN)) return null
    if (close(aw, bw) && close(ah, bh) && close(ay, by) && ah > aw && !close(ax, bx)) return 'pause'
  }
  return null
}

const svgsOf = (text: string): string[] => text.match(/<svg\b[\s\S]*?<\/svg>/g) ?? []

/** A stylesheet that draws play or pause itself: a clipped triangle pointing right, or a pseudo-element on a control of that name. */
function cssSignsOf(css: string): string[] {
  const found: string[] = []
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const [, list] of (body as string).matchAll(/clip-path:\s*polygon\(([^)]*)\)/g)) {
      const points = (list as string).split(',').map((pair) => pair.trim().split(/\s+/).map((value) => Number.parseFloat(value)) as Point)
      if (isPlayTriangle({ points, closed: true })) found.push(`${(selector as string).trim()}: a play triangle in clip-path`)
    }
    if (/\.(?:[\w-]*-)?(?:play|pause|resume)\b[^,]*::?(?:before|after)/.test(selector as string) && /\bcontent\s*:/.test(body as string)) {
      found.push(`${(selector as string).trim()}: play or pause drawn by a pseudo-element`)
    }
  }
  return found
}

/** Components of that name: a second play or pause, whatever it draws. */
const namedGlyphsOf = (text: string): string[] => [...text.matchAll(/\b(?:function|const|let|var|class)\s+(\w*(?:Play|Pause|Resume)\w*(?:Glyph|Icon|Svg|Picto\w*))\b/g)].map(([, name]) => name as string)

describe('the play and pause of Lucium', () => {
  it('are the media player’s drawing: a rounded triangle 11 x 12 and two bars 9 x 12, at the height a button asks', () => {
    const play = renderToStaticMarkup(createElement(PlayGlyph))
    const pause = renderToStaticMarkup(createElement(PauseGlyph))
    expect(play).toContain('viewBox="0 0 11 12" width="11" height="12"')
    expect(play).toContain('<path d="M1.6 1.5v9L9.6 6z"></path>')
    expect(pause).toContain('viewBox="0 0 9 12" width="9" height="12"')
    expect(pause.match(/<rect /g)).toHaveLength(2)
    expect(renderToStaticMarkup(createElement(PlayGlyph, { height: 24 }))).toContain('width="22" height="24"')
    expect(renderToStaticMarkup(createElement(PauseGlyph, { height: 24 }))).toContain('width="18" height="24"')
  })

  it('are recognised by the checks below, so that a copy of them would be', () => {
    expect(signOf(renderToStaticMarkup(createElement(PlayGlyph)))).toBe('play')
    expect(signOf(renderToStaticMarkup(createElement(PauseGlyph)))).toBe('pause')
    // The drawings the interface had before, each in its own place.
    const before: Array<[string, 'play' | 'pause']> = [
      ['<svg {...GLYPH}><path d="M6.5 4.5v11l9-5.5z" fill="currentColor" /></svg>', 'play'],
      ['<svg {...GLYPH}><path d="M7 4.5v11M13 4.5v11" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" /></svg>', 'pause'],
      ['<svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M2.6 1.4v9.2l7.6-4.6z" /></svg>', 'play'],
      ['<svg viewBox="0 0 12 12"><rect x="2" y="1.5" width="2.8" height="9" rx="0.8" /><rect x="7.2" y="1.5" width="2.8" height="9" rx="0.8" /></svg>', 'pause'],
      ['<svg {...ICON_PROPS}><path d="M7.500 5.500v9l6.500-4.500z" /></svg>', 'play'],
      ['<svg {...ICON_PROPS}><path d="M7.500 5.500v9M12.500 5.500v9" /></svg>', 'pause'],
      ['<svg viewBox="0 0 10 10"><polygon points="1 1 9 5 1 9" /></svg>', 'play']
    ]
    for (const [svg, sign] of before) expect(signOf(svg), svg).toBe(sign)
    // What is not play nor pause: next and previous (a triangle and a bar), a chevron (open), a cross, a speaker with its curves.
    for (const svg of [
      '<svg viewBox="0 0 14 11"><rect x="11.7" y="0.6" width="1.7" height="9.8" rx="0.5" /><path d="M1.1 1.4v8.2l8.3-4.1z" /></svg>',
      '<svg viewBox="0 0 14 11"><rect x="0.6" y="0.6" width="1.7" height="9.8" rx="0.5" /><path d="M12.9 1.4v8.2L4.6 5.5z" /></svg>',
      '<svg viewBox="0 0 10 10"><path d="M3.4 1.8 6.6 5 3.4 8.2" /></svg>',
      '<svg viewBox="0 0 11 11"><path d="M1 1l9 9M10 1 1 10" /></svg>',
      '<svg viewBox="0 0 13 13"><path d="M.4 4.2h2.4L6.2 1.1c.5-.4 1.1-.1 1.1.5v9.8z" /></svg>',
      '<svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12" /></svg>'
    ]) {
      expect(signOf(svg), svg).toBeNull()
    }
    expect(cssSignsOf('.illu.paused .play::before { width: 10px; clip-path: polygon(0 0, 100% 50%, 0 100%); }')).toHaveLength(1)
    expect(cssSignsOf('.illu .play::before { content: \'\'; width: 3px; box-shadow: 5px 0 0 currentColor; }')).toHaveLength(1)
    expect(cssSignsOf('.illu .cur::before { content: \'\'; clip-path: polygon(9% 7%, 9% 87%, 36% 67%, 55% 93%, 73% 87%, 55% 60%); }')).toEqual([])
    expect(namedGlyphsOf('const PlayGlyph = () => (\nfunction PauseGlyph() {\nconst ResumeIcon = 1\nconst playing = true')).toEqual(['PlayGlyph', 'PauseGlyph', 'ResumeIcon'])
  })

  const files = sources()

  it('are drawn nowhere else: no other component of that name, no other SVG of play or pause, no stylesheet that draws one', () => {
    expect(files.length).toBeGreaterThan(100)
    const found: string[] = []
    for (const { file, text } of files) {
      if (file === GLYPHS) continue
      for (const name of namedGlyphsOf(text)) found.push(`${file}: ${name}`)
      for (const svg of svgsOf(text)) {
        const sign = signOf(svg)
        if (sign) found.push(`${file}: a ${sign} drawn in ${svg.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
      if (file.endsWith('.css')) for (const sign of cssSignsOf(text)) found.push(`${file}: ${sign}`)
    }
    expect(found, 'take PlayGlyph and PauseGlyph from renderer/media-glyphs.tsx').toEqual([])
  })

  it('are taken from media-glyphs.tsx by every control that plays or pauses: the media player, the floating video, the video behind a space, a download, the card of a setting', () => {
    const users = files.filter(({ text }) => /<(?:Play|Pause)Glyph\b/.test(text)).map(({ file }) => file)
    expect(users.sort()).toEqual(['renderer/BackgroundVideoControls.tsx', 'renderer/FloatingVideoBar.tsx', 'renderer/MediaPlayer.tsx', 'renderer/Panels.tsx', 'renderer/SettingIllustration.tsx'])
    for (const file of users) {
      const text = files.find((source) => source.file === file)?.text ?? ''
      expect(text, file).toMatch(/import \{ PauseGlyph, PlayGlyph \} from '\.\/media-glyphs'/)
    }
  })
})
