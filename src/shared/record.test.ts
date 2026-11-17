import { describe, expect, it } from 'vitest'
import { isRecord } from './record'

describe('isRecord', () => {
  it('takes a plain object, empty or not, and one without a prototype', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
  })

  it('refuses null, an array and every value that is not an object', () => {
    for (const value of [null, undefined, [], [1, 2], 0, 1, '', 'text', true, Symbol('s'), () => undefined, 10n]) expect(isRecord(value), String(value)).toBe(false)
  })

  it('takes any other object: it does not look at the prototype (a Date is a record here; safari.ts has its own check that refuses it)', () => {
    expect(isRecord(new Date(0))).toBe(true)
    expect(isRecord(new Map())).toBe(true)
  })
})
