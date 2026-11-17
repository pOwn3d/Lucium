import { describe, expect, it } from 'vitest'
import { LanguageReads } from './language-reads'

describe('LanguageReads', () => {
  it('reads the language once per document: the frames that end their loading afterwards read nothing', () => {
    const reads = new LanguageReads()
    reads.navigated()
    expect(reads.take()).toBe(true)
    for (let frame = 0; frame < 5; frame++) expect(reads.take()).toBe(false)
  })

  it('reads it again for the next document of the page', () => {
    const reads = new LanguageReads()
    expect(reads.take()).toBe(true)
    reads.navigated()
    expect(reads.take()).toBe(true)
    expect(reads.take()).toBe(false)
  })

  // Switched off, the translation reads no page at all (no script in the page, no layout of its text).
  it('reads nothing while the translation is off, and reads the document once it is on', () => {
    const reads = new LanguageReads()
    reads.navigated()
    for (let frame = 0; frame < 3; frame++) expect(reads.take(false)).toBe(false)
    expect(reads.take(true)).toBe(true)
    expect(reads.take(true)).toBe(false)
  })

  // The answer of a reading comes after the page may have gone to another document: it is that document's no more.
  it('tells whether the document a reading began with is still the one on show', () => {
    const reads = new LanguageReads()
    const first = reads.document()
    expect(reads.current(first)).toBe(true)
    reads.navigated()
    expect(reads.current(first)).toBe(false)
    expect(reads.current(reads.document())).toBe(true)
  })

  it('tries again at the next end of loading after a failure', () => {
    const reads = new LanguageReads()
    expect(reads.take()).toBe(true)
    reads.failed()
    expect(reads.take()).toBe(true)
    expect(reads.take()).toBe(false)
  })
})
