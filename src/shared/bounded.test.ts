import { describe, expect, it } from 'vitest'
import { addBounded, setBounded } from './bounded'

describe('setBounded', () => {
  it('keeps everything up to the ceiling and drops the oldest past it', () => {
    const map = new Map<string, number>()
    for (let i = 0; i < 5; i++) setBounded(map, `k${i}`, i, 3)
    expect([...map]).toEqual([['k2', 2], ['k3', 3], ['k4', 4]])
  })

  it('counts a key that is set again as the newest, and replaces its value', () => {
    const map = new Map<string, number>()
    for (const key of ['a', 'b', 'c']) setBounded(map, key, 1, 3)
    setBounded(map, 'a', 2, 3)
    setBounded(map, 'd', 1, 3)
    expect([...map]).toEqual([['c', 1], ['a', 2], ['d', 1]])
  })

  it('never holds more than the ceiling however many are added', () => {
    const map = new Map<number, number>()
    for (let i = 0; i < 10_000; i++) setBounded(map, i, i, 100)
    expect(map.size).toBe(100)
    expect(map.has(9_999)).toBe(true)
    expect(map.has(9_899)).toBe(false)
  })
})

describe('addBounded', () => {
  it('drops the oldest past the ceiling and renews a value that is added again', () => {
    const set = new Set<string>()
    for (const value of ['a', 'b', 'c']) addBounded(set, value, 3)
    addBounded(set, 'a', 3)
    addBounded(set, 'd', 3)
    expect([...set]).toEqual(['c', 'a', 'd'])
  })
})
