import { describe, expect, it } from 'vitest'
import { chosenFilePath, isInside } from './download-names'

describe('isInside', () => {
  it('accepts the folder and what is below it', () => {
    expect(isInside('/tmp/a', '/tmp/a')).toBe(true)
    expect(isInside('/tmp/a', '/tmp/a/b/c.txt')).toBe(true)
    expect(isInside('/tmp/a', '/tmp/a/..data/x')).toBe(true)
  })

  it('refuses a way out, a sibling that shares the prefix and a relative path', () => {
    expect(isInside('/tmp/a', '/tmp/a/../b')).toBe(false)
    expect(isInside('/tmp/a', '/tmp/ab/c')).toBe(false)
    expect(isInside('/tmp/a', 'b/c')).toBe(false)
    expect(isInside('tmp/a', '/tmp/a/b')).toBe(false)
  })
})

describe('chosenFilePath', () => {
  it('accepts an absolute file path', () => {
    expect(chosenFilePath('/Users/x/Documents/a.pdf')).toBe('/Users/x/Documents/a.pdf')
  })

  it('refuses what is not a place for a file', () => {
    for (const answer of [undefined, null, 5, '', 'relative/a.pdf', '/Users/x/', '/Users/../a', '/a\u0000b', `/${'x'.repeat(5000)}`, '/..']) expect(chosenFilePath(answer)).toBeNull()
  })
})
