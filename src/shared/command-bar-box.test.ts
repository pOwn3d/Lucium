// The size and the shape of the command bar's card, from S to XL, wider or taller:
// `barBox` turns the two settings into the three numbers the style sheet reads. The default (M, balanced) must be the card the bar always had.

import { describe, expect, it } from 'vitest'
import { BAR_LIST_HEIGHT, BAR_WIDTH, PREVIEW_WIDTH, barBox, barLayout, cleanBarShape, cleanBarSize } from './command-bar'
import { GUEST_INHERITED, createGuestState } from './guest-window'
import { COMMAND_BAR_SHAPES, COMMAND_BAR_SIZES, defaultSettings, type CommandBarShape, type CommandBarSize } from './model'
import { createInitialState } from './sidebar'

/** The numbers of the 12 combinations, written out: [width of the field alone, width with lines, height of the list, preview column]. */
const TABLE: Record<CommandBarShape, Record<CommandBarSize, [number, number, number, number]>> = {
  balanced: { s: [560, 630, 333, 219], m: [640, 720, 380, 250], l: [768, 864, 456, 300], xl: [928, 1044, 551, 363] },
  wide: { s: [672, 756, 266, 263], m: [768, 864, 304, 300], l: [922, 1037, 365, 360], xl: [1114, 1253, 441, 435] },
  tall: { s: [532, 599, 449, 208], m: [608, 684, 513, 238], l: [730, 821, 616, 285], xl: [882, 992, 744, 344] }
}

describe('barBox', () => {
  it('is, for the size M and the balanced shape, the card the bar always had: 640 px, 720 px with lines, a list of 380 px, a preview of 250 px', () => {
    expect(barBox('m', 'balanced', false)).toEqual({ width: 640, list: 380, previewWidth: 250 })
    expect(barBox('m', 'balanced', true)).toEqual({ width: 720, list: 380, previewWidth: 250 })
    // The numbers the layout and the style sheet had are the same ones.
    expect([BAR_WIDTH.field, BAR_WIDTH.results, BAR_LIST_HEIGHT, PREVIEW_WIDTH]).toEqual([640, 720, 380, 250])
    expect(barBox('m', 'balanced', false).width).toBe(barLayout(0, false).width)
    expect(barBox('m', 'balanced', true).width).toBe(barLayout(3, false).width)
  })

  it('is what a new profile gets: the defaults of the settings are M and balanced', () => {
    const settings = defaultSettings()
    expect([settings.commandBarSize, settings.commandBarShape]).toEqual(['m', 'balanced'])
    expect(barBox(settings.commandBarSize, settings.commandBarShape, true)).toEqual({ width: 720, list: 380, previewWidth: 250 })
  })

  it.each(COMMAND_BAR_SHAPES.flatMap((shape) => COMMAND_BAR_SIZES.map((size) => [shape, size] as const)))('gives the written-out numbers for %s, %s', (shape, size) => {
    const [field, results, list, preview] = TABLE[shape][size]
    expect(barBox(size, shape, false)).toEqual({ width: field, list, previewWidth: preview })
    expect(barBox(size, shape, true)).toEqual({ width: results, list, previewWidth: preview })
  })

  it('grows with the size, in every shape: the width, the list and the preview are each larger from S to M to L to XL', () => {
    for (const shape of COMMAND_BAR_SHAPES) {
      for (const preview of [false, true]) {
        const boxes = COMMAND_BAR_SIZES.map((size) => barBox(size, shape, preview))
        for (const key of ['width', 'list', 'previewWidth'] as const) {
          const values = boxes.map((box) => box[key])
          expect(values, `${shape} ${key}`).toEqual([...values].sort((a, b) => a - b))
          expect(new Set(values).size, `${shape} ${key}`).toBe(values.length)
        }
      }
    }
  })

  it('makes the card wider and its list shorter for "wide", and a little narrower and its list longer for "tall", at every size', () => {
    for (const size of COMMAND_BAR_SIZES) {
      for (const preview of [false, true]) {
        const balanced = barBox(size, 'balanced', preview)
        const wide = barBox(size, 'wide', preview)
        const tall = barBox(size, 'tall', preview)
        expect(wide.width, size).toBeGreaterThan(balanced.width)
        expect(wide.list, size).toBeLessThan(balanced.list)
        expect(tall.width, size).toBeLessThan(balanced.width)
        expect(tall.list, size).toBeGreaterThan(balanced.list)
        expect(wide.width / wide.list, size).toBeGreaterThan(tall.width / tall.list)
      }
    }
  })

  it('is wider with lines to choose from than for the field alone, and the preview is a part of that width', () => {
    for (const shape of COMMAND_BAR_SHAPES) {
      for (const size of COMMAND_BAR_SIZES) {
        const alone = barBox(size, shape, false)
        const withLines = barBox(size, shape, true)
        expect(withLines.width, `${shape} ${size}`).toBeGreaterThan(alone.width)
        expect(withLines.width - withLines.previewWidth, `${shape} ${size}`).toBeGreaterThan(withLines.previewWidth)
        expect(withLines.list).toBe(alone.list)
      }
    }
  })

  it('gives whole pixels only, and no combination is too small to hold the field and its row of buttons (500 px) or its list (240 px)', () => {
    for (const shape of COMMAND_BAR_SHAPES) {
      for (const size of COMMAND_BAR_SIZES) {
        for (const preview of [false, true]) {
          const box = barBox(size, shape, preview)
          for (const value of Object.values(box)) expect(Number.isInteger(value), `${shape} ${size}`).toBe(true)
          expect(box.width, `${shape} ${size}`).toBeGreaterThanOrEqual(500)
          expect(box.list, `${shape} ${size}`).toBeGreaterThanOrEqual(240)
        }
      }
    }
  })

  it('gives back the default card for a size or a shape it does not know (a damaged setting)', () => {
    const card = { width: 720, list: 380, previewWidth: 250 }
    for (const bad of ['xxl', 'XL', 'wide', '', 1, null, undefined, [], {}]) expect(barBox(bad as never, 'balanced', true), JSON.stringify(bad)).toEqual(card)
    for (const bad of ['round', 'Wide', 'xl', '', 1, null, undefined, [], {}]) expect(barBox('m', bad as never, true), JSON.stringify(bad)).toEqual(card)
  })
})

describe('cleanBarSize and cleanBarShape', () => {
  it('keep the words of the menus and give the default for anything else', () => {
    for (const size of COMMAND_BAR_SIZES) expect(cleanBarSize(size)).toBe(size)
    for (const shape of COMMAND_BAR_SHAPES) expect(cleanBarShape(shape)).toBe(shape)
    for (const bad of ['', 'XL', 'huge', 'wide', 0, true, null, undefined, ['s'], { size: 's' }]) expect(cleanBarSize(bad), JSON.stringify(bad)).toBe('m')
    for (const bad of ['', 'Wide', 'round', 'xl', 0, true, null, undefined, ['tall'], { shape: 'tall' }]) expect(cleanBarShape(bad), JSON.stringify(bad)).toBe('balanced')
  })
})

describe('the guest window', () => {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
  const owner = (patch: object) => {
    const state = createInitialState(ctx)
    return { ...state, settings: { ...state.settings, ...patch } }
  }

  it('follows the owner for the size and the shape of the command bar: they are part of the look (a large card is often a need of the eyes), not something the owner built', () => {
    expect(GUEST_INHERITED).toContain('commandBarSize')
    expect(GUEST_INHERITED).toContain('commandBarShape')
    const guest = createGuestState(owner({ commandBarSize: 'xl', commandBarShape: 'tall' }), ctx)
    expect([guest.settings.commandBarSize, guest.settings.commandBarShape]).toEqual(['xl', 'tall'])
  })

  it('starts from the default card when the owner kept the default', () => {
    const guest = createGuestState(owner({}), ctx)
    expect([guest.settings.commandBarSize, guest.settings.commandBarShape]).toEqual(['m', 'balanced'])
  })
})
