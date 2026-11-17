import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOST_FONTS, type BoostFont } from '@shared/boost'

const repo = join(__dirname, '../../..')

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => repo } }))

const { fontScript, fontsFolder } = await import('./boost-fonts')

const inter = BOOST_FONTS.find((f) => f.id === 'inter') as BoostFont
const system = BOOST_FONTS.find((f) => f.id === 'menlo') as BoostFont

describe('the fonts Lucium carries', () => {
  it('reads them in the repository while developing', () => {
    expect(fontsFolder()).toBe(join(repo, 'resources/fonts'))
  })

  it('has a real woff2 file and a licence line for every bundled font of the grid', () => {
    const licences = readFileSync(join(fontsFolder(), 'LICENSES.md'), 'utf8')
    for (const font of BOOST_FONTS.filter((f) => f.file)) {
      const bytes = readFileSync(join(fontsFolder(), `${font.file}.woff2`))
      expect(bytes.subarray(0, 4).toString('latin1'), font.id).toBe('wOF2')
      expect(bytes.length, font.id).toBeGreaterThan(5_000)
      expect(licences, font.id).toContain(`\`${font.file}.woff2\``)
    }
  })
})

describe('fontScript', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('makes the script of a bundled font from the bytes of its file', async () => {
    const script = await fontScript(inter)
    const base64 = readFileSync(join(fontsFolder(), 'inter.woff2')).toString('base64')
    expect(script).toContain('new FontFace("Lucium Inter"')
    expect(script).toContain(`atob("${base64}")`)
  })

  it('makes it once: the same promise comes back', () => {
    expect(fontScript(inter)).toBe(fontScript(inter))
  })

  it('refuses a system font: it has no file', async () => {
    await expect(fontScript(system)).rejects.toThrow(/not a bundled font/)
  })

  it('refuses a file name that could leave the folder', async () => {
    for (const file of ['../../etc/passwd', 'a/b', 'Inter', 'inter.woff2', '']) {
      await expect(fontScript({ id: 'x', label: 'X', family: '"Lucium X", sans-serif', file }), file).rejects.toThrow(/not a bundled font/)
    }
  })

  it('does not remember a file that could not be read: the next request tries again', async () => {
    const missing: BoostFont = { id: 'gone', label: 'Gone', family: '"Lucium Gone", sans-serif', file: 'does-not-exist' }
    const first = fontScript(missing)
    await expect(first).rejects.toThrow()
    const second = fontScript(missing)
    expect(second).not.toBe(first)
    await expect(second).rejects.toThrow()
  })
})
