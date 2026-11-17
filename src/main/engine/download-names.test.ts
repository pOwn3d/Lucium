import { resolve } from 'node:path'
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
    expect(chosenFilePath('/Users/x/Documents/a.pdf', 'darwin')).toBe('/Users/x/Documents/a.pdf')
    // The default is the system of the run, which writes a path its own way (a drive letter on Windows).
    expect(chosenFilePath(resolve('/Users/x/Documents/a.pdf'))).toBe(resolve('/Users/x/Documents/a.pdf'))
  })

  it('refuses what is not a place for a file', () => {
    for (const answer of [undefined, null, 5, '', 'relative/a.pdf', '/Users/x/', '/Users/../a', '/a\u0000b', `/${'x'.repeat(5000)}`, '/..']) expect(chosenFilePath(answer, 'darwin')).toBeNull()
  })

  it('accepts a Windows path written with backslashes or with slashes, and gives it back written the Windows way', () => {
    expect(chosenFilePath('C:\\Users\\x\\Documents\\a.pdf', 'win32')).toBe('C:\\Users\\x\\Documents\\a.pdf')
    expect(chosenFilePath('C:/Users/x/Documents/a.pdf', 'win32')).toBe('C:\\Users\\x\\Documents\\a.pdf')
  })

  it('refuses, on Windows too, a folder, a way up and what is not absolute, whichever separator is used', () => {
    for (const answer of ['C:\\Users\\x\\', 'C:/Users/x/', 'C:\\', 'C:\\Users\\..\\a.pdf', 'C:/Users/../a.pdf', 'C:\\Users/..\\a.pdf', 'C:\\..', 'C:a.pdf', 'Users\\x\\a.pdf', 'a.pdf', 'C:\\a\u0000b.pdf']) {
      expect(chosenFilePath(answer, 'win32'), answer).toBeNull()
    }
  })

  it('does not take a backslash for a separator where a file name may hold one', () => {
    expect(chosenFilePath('/Users/x/a\\..\\b.pdf', 'linux')).toBe('/Users/x/a\\..\\b.pdf')
  })
})
