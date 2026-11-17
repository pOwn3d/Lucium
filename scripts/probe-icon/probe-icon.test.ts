import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PROBE_ICON_SIZE, pngOf, probeIconFault, probeIconPixels, probeIconPng } from './probe-icon'

const repo = join(__dirname, '../..')
const PROBE = join(repo, 'compat/surface-probe')

/** What a PNG file says of itself: the size of its header, and its pixels (8 bits, RGBA, rows without a filter, as the drawing writes them). */
function readPng(file: Buffer): { width: number; height: number; pixels: Uint8Array } {
  expect([...file.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const width = file.readUInt32BE(16)
  const height = file.readUInt32BE(20)
  expect([...file.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0])
  const data: Buffer[] = []
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at)
    if (file.toString('latin1', at + 4, at + 8) === 'IDAT') data.push(file.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const rows = inflateSync(Buffer.concat(data))
  const pixels = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    expect(rows[row * (width * 4 + 1)]).toBe(0)
    pixels.set(rows.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)), row * width * 4)
  }
  return { width, height, pixels }
}

describe('the icon of the probe extension', () => {
  const manifest = JSON.parse(readFileSync(join(PROBE, 'manifest.json'), 'utf8')) as { name: string; icons: Record<string, string> }

  // Guard: the picture has the size the manifest declares it at. A picture of 32 px declared as the one of 128 px is stretched four times wherever
  // the extension is shown.
  it('has, for each size the manifest declares, a picture of exactly that size', () => {
    expect(Object.keys(manifest.icons)).toEqual([String(PROBE_ICON_SIZE)])
    for (const [size, path] of Object.entries(manifest.icons)) {
      const { width, height } = readPng(readFileSync(join(PROBE, path)))
      expect([width, height], path).toEqual([Number(size), Number(size)])
    }
  })

  // Guard: the file of the repository is the drawing of this module, pixel for pixel, and nothing else rides along in it: a picture put there by hand, or
  // taken from elsewhere, fails here. Not byte for byte: the zlib of another machine (a Linux runner) may write other bytes for the same picture.
  it('is the file scripts/make-probe-icon.mjs writes from the drawing', () => {
    expect(probeIconFault(readFileSync(join(PROBE, 'icon.png')))).toBeNull()
    const script = readFileSync(join(repo, 'scripts/make-probe-icon.mjs'), 'utf8')
    expect(script).toContain("join(root, 'compat/surface-probe/icon.png')")
    expect(script).toContain('probeIconPng(PROBE_ICON_SIZE)')
    expect((JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['icons:probe']).toContain('scripts/make-probe-icon.mjs')
  })

  // Guard: the script itself answers for the file: `--check` passes on the repository as it is (it only reads).
  it('is accepted by the check of the script', () => {
    const out = execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(repo, 'scripts/make-probe-icon.mjs'), '--check'], { encoding: 'utf8' })
    expect(out).toContain('is the drawing of scripts/probe-icon/probe-icon.ts')
  })

  // Guard: a probe is a tool of the tests and wears the colours of no product: greys only, a tile with a lighter mark, transparent corners.
  it('is drawn in greys only: a tile with a lighter ring and point, and nothing outside the tile', () => {
    const { pixels } = readPng(probeIconPng())
    const at = (x: number, y: number): number[] => [...pixels.subarray((y * PROBE_ICON_SIZE + x) * 4, (y * PROBE_ICON_SIZE + x) * 4 + 4)]
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] !== pixels[i + 1] || pixels[i] !== pixels[i + 2]) throw new Error(`pixel ${i / 4} has a colour: ${[...pixels.subarray(i, i + 4)].join(' ')}`)
    }
    const half = PROBE_ICON_SIZE / 2
    expect(at(0, 0)).toEqual([0, 0, 0, 0])
    expect(at(PROBE_ICON_SIZE - 1, PROBE_ICON_SIZE - 1)).toEqual([0, 0, 0, 0])
    const [tile] = at(half, 10)
    const [point] = at(half, half)
    const [ring] = at(half + 36, half)
    const [between] = at(half + 20, half)
    expect(at(half, 10)[3]).toBe(255)
    expect(point).toBe(ring)
    expect(between).toBe(tile)
    expect(point! - tile!).toBeGreaterThan(100)
    // More than two greys: the edges of the mark are smoothed, not cut.
    expect(new Set(pixels.filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(8)
  })

  // Guard: the reading of the file says the picture is the drawing whatever zlib compressed it, and still refuses anything else. Without the first half the test
  // fails on a runner whose zlib writes other bytes than the Mac the file was made on; without the second it would accept any picture.
  it('is read for its picture, not for the bytes of its compression', () => {
    const own = probeIconPng()
    expect(probeIconFault(own)).toBeNull()
    // Another level of compression plays another zlib: the same pixels in a valid stream of other bytes.
    for (const level of [0, 1]) {
      const other = pngOf(PROBE_ICON_SIZE, probeIconPixels(), level)
      expect(other.equals(own), `level ${level} writes the same bytes: it does not play another zlib`).toBe(false)
      expect(probeIconFault(other), `level ${level}`).toBeNull()
    }
  })

  it('is refused when it is another picture, or more than a picture, or not a PNG that can be read', () => {
    const own = probeIconPng()
    const chunkOf = (type: string, data: Buffer): Buffer => {
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
      const length = Buffer.alloc(4)
      length.writeUInt32BE(data.length)
      const sum = Buffer.alloc(4)
      sum.writeUInt32BE(crc32(body))
      return Buffer.concat([length, body, sum])
    }
    // The first IDAT starts after the 8 bytes of the signature and the 25 of the header chunk; the last 12 bytes are IEND.
    const beforeData = own.subarray(0, 33)
    const end = own.subarray(own.length - 12)

    // The point at the centre, one grey lighter.
    const tweaked = probeIconPixels()
    const centre = (PROBE_ICON_SIZE / 2) * PROBE_ICON_SIZE * 4 + (PROBE_ICON_SIZE / 2) * 4
    tweaked[centre] = tweaked[centre]! - 1
    expect(probeIconFault(pngOf(PROBE_ICON_SIZE, tweaked))).toBe('its pixels are not the drawing')
    expect(probeIconFault(pngOf(32, probeIconPixels(32)))).toMatch(/^its header is not the one of a 128 px picture/)
    expect(probeIconFault(Buffer.from('GIF89a, not a PNG'))).toBe('it is not a PNG file')
    expect(probeIconFault(own.subarray(0, own.length - 20))).toBe('it ends in the middle of a chunk')
    const damaged = Buffer.from(own)
    // A byte inside the data of IDAT: the checksum of the chunk no longer fits.
    damaged[own.length - 30] = ~damaged[own.length - 30]! & 0xff
    expect(probeIconFault(damaged)).toBe('the checksum of its chunk IDAT is wrong')
    const withText = Buffer.concat([own.subarray(0, own.length - 12), chunkOf('tEXt', Buffer.from('Software\0elsewhere')), end])
    expect(probeIconFault(withText)).toBe('it has the chunks IHDR IDAT tEXt IEND, not IHDR IDAT IEND')
    const notZlib = Buffer.concat([beforeData, chunkOf('IDAT', Buffer.from('not a zlib stream')), end])
    expect(probeIconFault(notZlib)).toMatch(/^its pixels cannot be read \(/)
  })

  it('is the same drawing at another size, and refuses a size that is not one', () => {
    expect(readPng(probeIconPng(32))).toMatchObject({ width: 32, height: 32 })
    expect(probeIconPixels(64)).toHaveLength(64 * 64 * 4)
    for (const odd of [0, 8, 127.5, 4096, Number.NaN]) expect(() => probeIconPixels(odd), String(odd)).toThrow(/is not a size it is drawn at/)
  })
})

describe('the probe extension of the agent-style surface', () => {
  // Guard: the folder and the extension are named for what they do, not after a product: the chain of engine checks loads it under that name, and
  // the suite that needs it asks for it by the name of its manifest.
  it('is compat/surface-probe, named « Lucium Surface Probe », and that is what the engine checks load and ask for', () => {
    expect(readdirSync(join(repo, 'compat')).filter((name) => name.endsWith('surface-probe'))).toEqual(['surface-probe'])
    const manifest = JSON.parse(readFileSync(join(PROBE, 'manifest.json'), 'utf8')) as { name: string }
    expect(manifest.name).toBe('Lucium Surface Probe')
    const scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    const chains = Object.entries(scripts).filter(([, script]) => script.includes('surface-probe') && script.includes('LUCIUM_EXTENSIONS'))
    expect(chains.length).toBeGreaterThan(0)
    for (const [name, script] of chains) {
      for (const cited of script.match(/\$PWD\/compat\/[a-z-]*surface-probe/g) ?? []) expect(existsSync(join(repo, cited.replace('$PWD/', ''))), `${name}: ${cited}`).toBe(true)
    }
    const suite = readFileSync(join(repo, 'src/main/smoke-extensions.ts'), 'utf8')
    expect(suite).toContain(`requireProbes(engine.listExtensions(), ['${manifest.name}'], check)`)
    expect(suite).toContain(`engine.listExtensions().find((e) => e.name === '${manifest.name}')`)
    expect(suite).toContain("p.endsWith('/surface-probe')")
    // The reference of the engine names the checks of this probe as a run writes them.
    const baseline = readFileSync(join(repo, 'compat/baseline-electron-45.2.1.json'), 'utf8')
    expect(baseline).toContain('"extension loaded: surface-probe"')
    expect(baseline).toContain(`the probe extension \\"${manifest.name}\\" is loaded`)
  })
})
