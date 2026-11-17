import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { APP_ICONS, DEFAULT_APP_ICON } from '@shared/icons'
import { FAN_THEMES, LOGO_CANVAS, LOGO_TILE, fanLogo, type FanTheme } from './fan-logo'

const repo = join(__dirname, '../..')

// ---------- reading the pictures the generator made (the files the application ships) ----------

interface Picture {
  width: number
  height: number
  /** RGBA, row after row. */
  pixels: Buffer
}

/** An 8-bit RGBA PNG without interlacing, the only kind scripts/logo/make-icons.mjs writes (it refuses any other), unfiltered. */
function decodePng(bytes: Buffer): Picture {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  expect({ depth: bytes[24], colour: bytes[25], interlaced: bytes[28] }).toEqual({ depth: 8, colour: 6, interlaced: 0 })
  const chunks: Buffer[] = []
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    if (bytes.subarray(at + 4, at + 8).toString('latin1') === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i]!
      const left = i >= 4 ? pixels[y * stride + i - 4]! : 0
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0
      const upLeft = y > 0 && i >= 4 ? pixels[(y - 1) * stride + i - 4]! : 0
      const paeth = (): number => {
        const p = left + up - upLeft
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth()
      pixels[y * stride + i] = (value + predictor) & 255
    }
  }
  return { width, height, pixels }
}

/** The pixel at a point of the 1024 canvas of the drawing, whatever the size of the picture. */
function pixelAt(picture: Picture, x: number, y: number): [number, number, number, number] {
  const px = Math.floor((x * picture.width) / LOGO_CANVAS)
  const py = Math.floor((y * picture.height) / LOGO_CANVAS)
  const at = (py * picture.width + px) * 4
  return [picture.pixels[at]!, picture.pixels[at + 1]!, picture.pixels[at + 2]!, picture.pixels[at + 3]!]
}

const rgb = (hex: string): [number, number, number] => {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join('') : hex.slice(1)
  return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)]
}

/** The colour of the gradient of the tile at a point of the canvas (the gradient runs from the top left to the bottom right corner of the tile). */
function backgroundAt(theme: FanTheme, x: number, y: number): [number, number, number] {
  const t = ((x - LOGO_TILE.x) / LOGO_TILE.size + (y - LOGO_TILE.y) / LOGO_TILE.size) / 2
  const [from, to] = [rgb(theme.background[0]), rgb(theme.background[1])]
  return [0, 1, 2].map((i) => Math.round(from[i]! + (to[i]! - from[i]!) * t)) as [number, number, number]
}

/** Two colours, within the few levels a renderer may move an antialiased or interpolated colour by. */
const close = (a: readonly number[], b: readonly number[]): boolean => [0, 1, 2].every((i) => Math.abs(a[i]! - b[i]!) <= 4)

// A point of the tile above the tabs (in the gradient only), and a point in the middle of the central tab (the third colour of the theme).
const BACKGROUND_POINT = { x: 300, y: 150 }
const CENTRE_TAB_POINT = { x: 512, y: 300 }

/** Checks that a picture is the logo of a theme: transparent outside the tile, the gradient of the theme above the tabs, its colour in the central tab. */
function expectTheme(picture: Picture, theme: FanTheme, what: string): void {
  expect(pixelAt(picture, 0, 0)[3], `${what}: the corner of the canvas is transparent`).toBe(0)
  expect(pixelAt(picture, LOGO_CANVAS - 1, LOGO_CANVAS - 1)[3], `${what}: the opposite corner is transparent`).toBe(0)
  expect(pixelAt(picture, 512, 0)[3], `${what}: the shadow stays inside the canvas (top)`).toBe(0)
  expect(pixelAt(picture, 512, LOGO_CANVAS - 1)[3], `${what}: the shadow stays inside the canvas (bottom)`).toBe(0)
  const background = pixelAt(picture, BACKGROUND_POINT.x, BACKGROUND_POINT.y)
  expect(background[3], `${what}: the tile is opaque`).toBe(255)
  expect(close(background, backgroundAt(theme, BACKGROUND_POINT.x, BACKGROUND_POINT.y)), `${what}: background ${background.slice(0, 3)}`).toBe(true)
  const tab = pixelAt(picture, CENTRE_TAB_POINT.x, CENTRE_TAB_POINT.y)
  expect(close(tab, rgb(theme.rays[2])), `${what}: central tab ${tab.slice(0, 3)}`).toBe(true)
}

describe('the drawing of the fan logo', () => {
  it('has one theme per choice of Settings › Icône, under the same id, and Clair is the default', () => {
    expect([...FAN_THEMES.map((theme) => theme.id)].sort()).toEqual(APP_ICONS.map((icon) => icon.id).sort())
    expect(new Set(FAN_THEMES.map((theme) => theme.id)).size).toBe(FAN_THEMES.length)
    expect(FAN_THEMES.find((theme) => theme.id === DEFAULT_APP_ICON)?.name).toBe('Clair')
    expect(FAN_THEMES.find((theme) => theme.name === 'Boréal')?.id).toBe('boreal')
  })

  it('draws the same shapes in every version: only the colours change', () => {
    const shapes = (theme: FanTheme): string => fanLogo(theme, 64, 'x').replace(/#[0-9a-f]{3,6}\b/g, '#')
    const first = shapes(FAN_THEMES[0]!)
    for (const theme of FAN_THEMES) expect(shapes(theme), theme.id).toBe(first)
  })

  it('is the validated geometry: a 1024 canvas, a tile of 824 with corners of 185 and its 100 of margin, five tabs in the colours of the theme', () => {
    for (const theme of FAN_THEMES) {
      const svg = fanLogo(theme, 64, 'x')
      expect(svg, theme.id).toContain('viewBox="0 0 1024 1024" width="64" height="64"')
      expect(svg, theme.id).toContain('<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bgx)" filter="url(#shx)"/>')
      expect([...svg.matchAll(/<rect x="-52" y="-(\d+)" width="104" height="(\d+)" rx="52" fill="(#[0-9a-f]+)" transform="rotate\((-?\d+)\)"/g)].map((m) => m.slice(1))).toEqual(
        [400, 430, 450, 430, 400].map((length, i) => [String(length), String(length - 40), theme.rays[i]!, String([-56, -28, 0, 28, 56][i]!)])
      )
      expect(svg, theme.id).toContain(`<circle r="112" fill="${theme.hub}"/>`)
      expect(svg, theme.id).toContain(`<stop offset="0" stop-color="${theme.background[0]}"/><stop offset="1" stop-color="${theme.background[1]}"/>`)
    }
  })

  it('keeps room for the shadow inside the canvas', () => {
    expect(LOGO_TILE.x).toBeGreaterThanOrEqual(100)
    expect(LOGO_TILE.x + LOGO_TILE.size).toBeLessThanOrEqual(LOGO_CANVAS - 100)
  })

  it('has ids of its own when several logos share a page', () => {
    const ids = (svg: string): string[] => [...svg.matchAll(/id="(\w+)"/g)].map((m) => m[1]!)
    const [a, b] = [ids(fanLogo(FAN_THEMES[0]!, 16, 1)), ids(fanLogo(FAN_THEMES[1]!, 16, 2))]
    expect(a).toHaveLength(3)
    expect(a.filter((id) => b.includes(id))).toEqual([])
  })

  it('crops to the tile, without shadow or with square corners, for a favicon or the icon of a home screen', () => {
    const favicon = fanLogo(FAN_THEMES[0]!, 32, 'f', { view: 'tile', shadow: false })
    expect(favicon).toContain('viewBox="100 100 824 824"')
    expect(favicon).not.toContain('<filter')
    expect(favicon).not.toContain('filter="')
    expect(fanLogo(FAN_THEMES[0]!, 180, 'a', { view: 'tile', shadow: false, corner: 0 })).toContain('width="824" height="824" rx="0"')
    // A standalone .svg file (the favicon of the site) needs its namespace.
    expect(favicon).toContain('xmlns="http://www.w3.org/2000/svg"')
  })
})

describe('the pictures made from the drawing', () => {
  it('are, for every choice of Settings › Icône, a 512 px picture of its own version: transparent outside the tile, its colours inside', () => {
    for (const icon of APP_ICONS) {
      const theme = FAN_THEMES.find((candidate) => candidate.id === icon.id)
      expect(theme, icon.id).toBeDefined()
      const picture = decodePng(readFileSync(join(repo, 'resources/app-icons', `${icon.id}.png`)))
      expect([picture.width, picture.height], icon.id).toEqual([512, 512])
      expectTheme(picture, theme!, icon.id)
    }
  })

  it('make the icon of the application the default version (Clair), with every size of an iconset', () => {
    const icns = readFileSync(join(repo, 'build/icon.icns'))
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const entries = new Map<string, Buffer>()
    for (let at = 8; at < icns.length; ) {
      const length = icns.readUInt32BE(at + 4)
      entries.set(icns.subarray(at, at + 4).toString('latin1'), icns.subarray(at + 8, at + length))
      at += length
    }
    // 128, 256 and 512 px at 1x and 2x, and the 1024 px one: PNG entries.
    const pngSizes = Object.fromEntries(['ic07', 'ic08', 'ic09', 'ic10', 'ic13', 'ic14'].map((type) => [type, entries.get(type)?.readUInt32BE(16)]))
    expect(pngSizes).toEqual({ ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic13: 256, ic14: 512 })
    expect(entries.has('ic11') && entries.has('ic12'), '32 px at 2x and 64 px at 2x').toBe(true)
    expectTheme(decodePng(entries.get('ic10')!), FAN_THEMES.find((theme) => theme.id === DEFAULT_APP_ICON)!, 'the 1024 px icon of the application')
  })
})
