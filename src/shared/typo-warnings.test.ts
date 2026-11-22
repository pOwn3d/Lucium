import { describe, expect, it } from 'vitest'
import { TYPO_MEMORY_MAX, TYPO_PENDING_MS, TypoWarnings } from './typo-warnings'

function warnings() {
  const clock = { at: 1000 }
  return { clock, book: new TypoWarnings(() => clock.at) }
}

describe('the lookalike warnings', () => {
  it('hold the first main-frame request to a host that was typed, once, and the page of the warning then names the site it looks like', () => {
    const { book } = warnings()
    book.expect('gogle.com', 'google.com')
    expect(book.warning('https://gogle.com/')).toBeNull()
    expect(book.holds('https://gogle.com/')).toBe(true)
    expect(book.warning('https://gogle.com/')).toEqual({ similar: 'google.com' })
    expect(book.holds('https://gogle.com/')).toBe(false)
  })

  it('hold nothing for a host that was not typed', () => {
    const { book } = warnings()
    book.expect('gogle.com', 'google.com')
    expect(book.holds('https://example.org/')).toBe(false)
    expect(book.holds('not an address')).toBe(false)
    expect(book.warning('https://example.org/')).toBeNull()
  })

  it('forget a typed address whose load did not start in time: a later navigation to the host is not the typed one', () => {
    const { book, clock } = warnings()
    book.expect('gogle.com', 'google.com')
    clock.at += TYPO_PENDING_MS + 1
    expect(book.holds('https://gogle.com/')).toBe(false)
  })

  it('let a host through on « Continuer », and do not warn about it again', () => {
    const { book } = warnings()
    book.expect('gogle.com', 'google.com')
    book.holds('https://gogle.com/')
    book.allow('https://gogle.com/')
    expect(book.holds('https://gogle.com/')).toBe(false)
    book.expect('gogle.com', 'google.com')
    expect(book.holds('https://gogle.com/')).toBe(false)
  })

  it('let nothing through by a click that comes before the warning was shown (a page cannot allow what was never held)', () => {
    const { book } = warnings()
    book.expect('gogle.com', 'google.com')
    book.allow('https://gogle.com/')
    expect(book.holds('https://gogle.com/')).toBe(true)
  })

  it('keep a host apart from its subdomains and from the other hosts of the site', () => {
    const { book } = warnings()
    book.expect('gogle.com', 'google.com')
    expect(book.holds('https://www.gogle.com/')).toBe(false)
  })

  it('remember a bounded number of hosts', () => {
    const { book } = warnings()
    for (let n = 0; n < TYPO_MEMORY_MAX + 10; n++) book.expect(`site${n}.example.com`, 'example.com')
    expect(book.holds('https://site0.example.com/')).toBe(false)
    expect(book.holds(`https://site${TYPO_MEMORY_MAX + 9}.example.com/`)).toBe(true)
  })
})
