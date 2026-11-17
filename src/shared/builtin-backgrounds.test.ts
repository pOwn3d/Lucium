// The videos Lucium comes with (builtin-backgrounds.ts, resources/backgrounds): each one is there with its picture, nothing else is shipped, they stay
// small, and a space keeps naming one after its state is read again.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_BACKGROUND_IDS, builtinBackground, builtinPosterFile, builtinVideoFile, isBuiltinBackgroundFile, type BuiltinBackgroundId } from './builtin-backgrounds'
import { TEXT_COLORS, VEIL_COLORS, cleanSpaceBackground } from './space-media'

const DIR = join(__dirname, '..', '..', 'resources', 'backgrounds')
const MiB = 1024 * 1024

describe('the videos Lucium comes with', () => {
  it('are all in the resources with their picture, and nothing else is', () => {
    const files = BUILTIN_BACKGROUND_IDS.flatMap((id) => [builtinVideoFile(id), builtinPosterFile(id)])
    expect(readdirSync(DIR).filter((name) => name !== 'README.md').sort()).toEqual([...files].sort())
    for (const id of BUILTIN_BACKGROUND_IDS) {
      // An MP4 has 'ftyp' at byte 4, a JPEG starts with FF D8.
      expect(readFileSync(join(DIR, builtinVideoFile(id))).subarray(4, 8).toString('latin1'), id).toBe('ftyp')
      expect([...readFileSync(join(DIR, builtinPosterFile(id))).subarray(0, 2)], id).toEqual([0xff, 0xd8])
    }
  })

  it('stay small: each one under 3 MiB, all of them under 14 MiB (they travel in every download of Lucium and of its updates)', () => {
    const sizes = BUILTIN_BACKGROUND_IDS.map((id) => statSync(join(DIR, builtinVideoFile(id))).size)
    for (const [i, size] of sizes.entries()) expect(size, BUILTIN_BACKGROUND_IDS[i]).toBeLessThan(3 * MiB)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(14 * MiB)
  })

  it('are shipped in the application', () => {
    const config = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')
    expect(config).toMatch(/- from: resources\/backgrounds\n\s+to: backgrounds\n/)
  })

  it('are known by their exact names only', () => {
    expect(isBuiltinBackgroundFile('lucium-village.mp4')).toBe(true)
    expect(isBuiltinBackgroundFile('lucium-village.jpg')).toBe(true)
    for (const other of ['lucium-ailleurs.mp4', 'lucium-village.MP4', '../lucium-village.mp4', 'README.md', '1730000000000-0a1b2c3d.mp4']) expect(isBuiltinBackgroundFile(other), other).toBe(false)
  })

  it('stay the background of a space when its state is read again', () => {
    const background = { type: 'video', value: builtinVideoFile('aurores-boreales'), loop: true, muted: true }
    expect(cleanSpaceBackground(background)).toEqual(background)
  })
})

describe('the look each video of Lucium comes with', () => {
  // The strength follows the mean luminance of the left 60 % of the picture, measured by hand (builtin-backgrounds.ts): pinned here, so a change of the
  // figures or of the straight line between them shows.
  const STRENGTH: Record<BuiltinBackgroundId, number> = {
    'aurores-boreales': 65,
    'temple-brume': 60,
    'serre-lucioles': 40,
    village: 60,
    foret: 55,
    montagnes: 55,
    'ville-cyberpunk': 55,
    'fonds-marins': 45,
    'hublot-spatial': 35
  }

  it('is the dark veil on the text side, white text and its shadow, with a strength each video needs, between 35 and 65 at the step of the slider', () => {
    for (const id of BUILTIN_BACKGROUND_IDS) {
      const background = builtinBackground(builtinVideoFile(id))
      expect(background, id).toEqual({ type: 'video', value: builtinVideoFile(id), muted: true, loop: true, veilColor: '#0b0c12', veilShape: 'text', veil: STRENGTH[id], textColor: '#ffffff', textHalo: true })
      expect(background!.veil! % 5, id).toBe(0)
      expect(background!.veil!, id).toBeGreaterThanOrEqual(35)
      expect(background!.veil!, id).toBeLessThanOrEqual(65)
    }
    // The video of the temple is the one the maintainer tried by hand at 60 %.
    expect(builtinBackground(builtinVideoFile('temple-brume'))?.veil).toBe(60)
  })

  it('is made of colours the Fond panel offers, so the panel shows them chosen, and the state keeps all of it when it is read again', () => {
    for (const id of BUILTIN_BACKGROUND_IDS) {
      const background = builtinBackground(builtinVideoFile(id))!
      expect(VEIL_COLORS as readonly string[]).toContain(background.veilColor)
      expect(TEXT_COLORS as readonly string[]).toContain(background.textColor)
      expect(cleanSpaceBackground(background), id).toEqual(background)
    }
  })

  it('is given to a video of Lucium only: a file of the user, a picture of a video or any other name has none', () => {
    for (const other of ['1730000000000-0a1b2c3d.mp4', 'lucium-village.jpg', 'lucium-ailleurs.mp4', 'lucium-village.MP4', '../lucium-village.mp4', '']) expect(builtinBackground(other), other).toBeUndefined()
  })
})
