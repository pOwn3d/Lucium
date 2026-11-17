import { describe, expect, it } from 'vitest'
import { parseTooltip, TOOLTIP_KEYS_MAX, TOOLTIP_TEXT_MAX } from './tooltip'

describe('parseTooltip', () => {
  it('accepts a label with its keycaps at a point', () => {
    expect(parseTooltip({ text: 'Actualiser la page', keys: ['⌘', 'R'], x: 418, y: 26 })).toEqual({ text: 'Actualiser la page', keys: ['⌘', 'R'], x: 418, y: 26 })
    expect(parseTooltip({ text: 'Sans raccourci', x: 1, y: 2 })).toEqual({ text: 'Sans raccourci', x: 1, y: 2 })
  })

  it('refuses what is not a short label at a real point: a page must not be able to draw a paragraph, or aim off the screen', () => {
    expect(parseTooltip(null)).toBeNull()
    expect(parseTooltip({ text: '', x: 0, y: 0 })).toBeNull()
    expect(parseTooltip({ text: 'x'.repeat(TOOLTIP_TEXT_MAX + 1), x: 0, y: 0 })).toBeNull()
    expect(parseTooltip({ text: 'ok', x: Number.NaN, y: 0 })).toBeNull()
    expect(parseTooltip({ text: 'ok', x: 0, y: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseTooltip({ text: 'ok', x: '0', y: 0 })).toBeNull()
  })

  it('opens to the left when asked (a tile of a column docked at the right of the window), and refuses any other side', () => {
    expect(parseTooltip({ text: 'Mail', x: 1180, y: 60, side: 'left' })).toEqual({ text: 'Mail', x: 1180, y: 60, side: 'left' })
    expect(parseTooltip({ text: 'Mail', x: 1180, y: 60, side: 'right' })).toBeNull()
    expect(parseTooltip({ text: 'Mail', x: 1180, y: 60, side: 1 })).toBeNull()
    expect(parseTooltip({ text: 'Mail', x: 1180, y: 60 })).toEqual({ text: 'Mail', x: 1180, y: 60 })
  })

  it('keeps the look of the media player\'s bubble, and refuses any other look', () => {
    expect(parseTooltip({ text: 'Piste suivante', x: 1, y: 2, variant: 'media' })).toEqual({ text: 'Piste suivante', x: 1, y: 2, variant: 'media' })
    expect(parseTooltip({ text: 'Piste suivante', x: 1, y: 2, variant: 'huge' })).toBeNull()
  })

  it('refuses too many keycaps, empty ones, or long ones', () => {
    expect(parseTooltip({ text: 'ok', keys: Array.from({ length: TOOLTIP_KEYS_MAX + 1 }, () => 'a'), x: 0, y: 0 })).toBeNull()
    expect(parseTooltip({ text: 'ok', keys: [''], x: 0, y: 0 })).toBeNull()
    expect(parseTooltip({ text: 'ok', keys: ['abcd'], x: 0, y: 0 })).toBeNull()
    expect(parseTooltip({ text: 'ok', keys: 'R', x: 0, y: 0 })).toBeNull()
  })
})
