import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENU_ICON_PNG, MENU_ICON_RED_PNG } from './menu-icons-data'

// Electron's nativeImage is replaced by a record of what was asked of it.
interface FakeImage {
  bytes: Buffer
  scaleFactor: number | undefined
  template: boolean
  empty: boolean
  isEmpty(): boolean
  setTemplateImage(value: boolean): void
}
const made: FakeImage[] = []
let mode: 'ok' | 'throw' | 'empty' = 'ok'
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (bytes: Buffer, options?: { scaleFactor?: number }): FakeImage => {
      if (mode === 'throw') throw new Error('no decoder')
      const image: FakeImage = { bytes, scaleFactor: options?.scaleFactor, template: false, empty: mode === 'empty', isEmpty: () => image.empty, setTemplateImage: (value) => void (image.template = value) }
      made.push(image)
      return image
    }
  }
}))

const loaded = async () => (await import('./menu-icons')) as { menuIcon: (name: keyof typeof MENU_ICON_PNG, danger?: boolean) => FakeImage | undefined }

beforeEach(() => {
  made.length = 0
  mode = 'ok'
  vi.resetModules()
})
afterEach(() => vi.restoreAllMocks())

describe('the picture of every icon', () => {
  const PNG_SIGNATURE = '89504e470d0a1a0a'
  const all = [...Object.entries(MENU_ICON_PNG), ...Object.entries(MENU_ICON_RED_PNG).map(([name, data]) => [`${name} (red)`, data] as const)]

  it.each(all)('%s is a 32 x 32 PNG with an alpha channel (the @2x of 16 pt)', (_name, base64) => {
    const bytes = Buffer.from(base64, 'base64')
    expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
    expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
    expect(bytes.readUInt32BE(16)).toBe(32)
    expect(bytes.readUInt32BE(20)).toBe(32)
    // 8 bits per channel, colour type 6 (RGBA), no interlacing.
    expect([bytes[24], bytes[25], bytes[28]]).toEqual([8, 6, 0])
    expect(bytes.subarray(-12, -8).toString('hex')).toBe('00000000')
    expect(bytes.subarray(-8, -4).toString('latin1')).toBe('IEND')
  })

  it('weigh little together: they are in the source and read when a menu opens', () => {
    const total = all.reduce((sum, [, base64]) => sum + base64.length, 0)
    expect(total).toBeLessThan(60 * 1024)
  })

  it('give a red version to the icons an entry that erases or closes wears, and only to those', () => {
    expect(Object.keys(MENU_ICON_RED_PNG).sort()).toEqual(['broom', 'close', 'star', 'trash'])
    for (const name of Object.keys(MENU_ICON_RED_PNG)) expect(MENU_ICON_PNG, name).toHaveProperty(name)
  })
})

describe('menuIcon', () => {
  it('makes a template image at twice the size from the plain picture', async () => {
    const { menuIcon } = await loaded()
    const icon = menuIcon('copy')!
    expect(icon.bytes.toString('base64')).toBe(MENU_ICON_PNG.copy)
    expect(icon.scaleFactor).toBe(2)
    expect(icon.template).toBe(true)
  })

  it('makes the red picture of a destructive entry, and not a template, so that it keeps its colour', async () => {
    const { menuIcon } = await loaded()
    const icon = menuIcon('trash', true)!
    expect(icon.bytes.toString('base64')).toBe(MENU_ICON_RED_PNG.trash)
    expect(icon.template).toBe(false)
  })

  it('gives the plain template for a red icon that does not exist', async () => {
    const { menuIcon } = await loaded()
    const icon = menuIcon('copy', true)!
    expect(icon.bytes.toString('base64')).toBe(MENU_ICON_PNG.copy)
    expect(icon.template).toBe(true)
  })

  it('makes each picture once', async () => {
    const { menuIcon } = await loaded()
    expect(menuIcon('copy')).toBe(menuIcon('copy'))
    // An icon without a red version is the plain one, not a second picture.
    expect(menuIcon('copy')).toBe(menuIcon('copy', true))
    expect(menuIcon('trash')).not.toBe(menuIcon('trash', true))
    expect(made).toHaveLength(3)
  })

  it('leaves the entry without an icon, and says so once, when the picture cannot be made', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { menuIcon } = await loaded()
    mode = 'throw'
    expect(menuIcon('copy')).toBeUndefined()
    expect(menuIcon('copy')).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('"copy"')
  })

  it('does not take a picture that decodes to nothing for an icon', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { menuIcon } = await loaded()
    mode = 'empty'
    expect(menuIcon('copy')).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
  })
})
