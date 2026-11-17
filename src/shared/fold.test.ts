import { describe, expect, it } from 'vitest'
import { foldAccents, foldAccentsAndQuotes, foldMarks } from './fold'

describe('the folding of a text for a search', () => {
  it('takes the accents and the case off, in the three variants', () => {
    for (const fold of [foldAccents, foldAccentsAndQuotes, foldMarks]) {
      expect(fold('Été à Noël')).toBe('ete a noel')
      expect(fold('ÇA')).toBe('ca')
      expect(fold('')).toBe('')
    }
  })

  it('makes the typographic apostrophes straight only in foldAccentsAndQuotes', () => {
    expect(foldAccentsAndQuotes('L’été ‘ici’')).toBe("l'ete 'ici'")
    expect(foldAccents('L’été')).toBe('l’ete')
    expect(foldMarks('L’été')).toBe('l’ete')
  })

  it('takes every combining mark off only in foldMarks (the accents of U+0300–U+036F alone in the others)', () => {
    // U+0903 (devanagari visarga) and U+20DD (enclosing circle) are marks outside the accent block.
    expect(foldMarks('कः')).toBe('क')
    expect(foldMarks('a⃝')).toBe('a')
    expect(foldAccents('कः')).toBe('कः')
    expect(foldAccentsAndQuotes('a⃝')).toBe('a⃝')
  })

  it('folds a text that comes already decomposed as one that comes composed', () => {
    expect(foldAccents('été')).toBe(foldAccents('été'))
  })

  it('keeps what is not a mark: spaces, digits, dashes, emoji', () => {
    expect(foldMarks('  Mini-fenêtre 2 🎉 ')).toBe('  mini-fenetre 2 🎉 ')
  })
})
