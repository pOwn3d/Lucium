import { describe, expect, it } from 'vitest'
import { BLACK_LEVEL, BLANK_ROUNDS, isBlackPicture, isBlankRun, nextBlankRun } from './window-share-picture'

/** An RGBA image of `pixels` pixels, each given as [red, green, blue] (alpha 255 unless given). */
const image = (...pixels: Array<[number, number, number, number?]>): Uint8ClampedArray => Uint8ClampedArray.from(pixels.flatMap(([r, g, b, a = 255]) => [r, g, b, a]))

describe('the black picture', () => {
  it('is black when every pixel is at or under the black level', () => {
    expect(isBlackPicture(image([0, 0, 0], [BLACK_LEVEL, 0, 0], [0, BLACK_LEVEL, BLACK_LEVEL]))).toBe(true)
  })

  it('is not black as soon as one channel of one pixel is above the level (a dark frame with some light is a picture)', () => {
    expect(isBlackPicture(image([0, 0, 0], [0, 0, 0], [0, 0, BLACK_LEVEL + 1]))).toBe(false)
    expect(isBlackPicture(image([0, 0, 0], [255, 255, 255]))).toBe(false)
  })

  it('does not read the alpha: a transparent pixel with colour is not black, an opaque black one is', () => {
    expect(isBlackPicture(image([200, 0, 0, 0]))).toBe(false)
    expect(isBlackPicture(image([0, 0, 0, 255]))).toBe(true)
  })

  it('is not black when nothing was sampled', () => {
    expect(isBlackPicture(new Uint8ClampedArray())).toBe(false)
  })
})

describe('the blank picture', () => {
  it('counts the black samples in a row, and starts again on a picture that is not black', () => {
    expect(nextBlankRun(0, true)).toBe(1)
    expect(nextBlankRun(2, true)).toBe(3)
    expect(nextBlankRun(3, false)).toBe(0)
  })

  it('is blank only after BLANK_ROUNDS black samples in a row: one black frame is not blank', () => {
    expect(isBlankRun(BLANK_ROUNDS - 1)).toBe(false)
    expect(isBlankRun(BLANK_ROUNDS)).toBe(true)
    expect(isBlankRun(1)).toBe(false)
  })
})
