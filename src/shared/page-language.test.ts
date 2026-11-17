import { describe, expect, it } from 'vitest'
import { pageLanguageOf } from './page-language'

describe('the language of a page', () => {
  it('judges a page by its lang attribute when it declares one', () => {
    expect(pageLanguageOf('fr', 'The quick brown fox jumps over the lazy dog and the cat is in the garden with a friend.')).toBe('fr')
  })

  it('judges a page without lang attribute by its visible text, when the words are clear', () => {
    expect(pageLanguageOf('', 'The quick brown fox jumps over the lazy dog and the cat is in the garden with a friend of the family.')).toBe('en')
  })

  it('names no language for a page without lang attribute and without clear text', () => {
    expect(pageLanguageOf('', '')).toBe('')
  })
})
