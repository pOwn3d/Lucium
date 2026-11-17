import { describe, expect, it } from 'vitest'
import { TRANSFORM_CASE_SOURCE, formatScript, transformCase, transformScript } from './text-format'

describe('transformCase', () => {
  it('changes the case, accents included', () => {
    expect(transformCase('Été à Paris', 'upper')).toBe('ÉTÉ À PARIS')
    expect(transformCase('ÉTÉ À PARIS', 'lower')).toBe('été à paris')
  })

  it('capitalizes each word and lowers the rest, keeping apostrophes inside a word', () => {
    expect(transformCase('bONJOUR le monde', 'capitalize')).toBe('Bonjour Le Monde')
    expect(transformCase("l'été d’éric", 'capitalize')).toBe("L'été D’éric")
    expect(transformCase('', 'capitalize')).toBe('')
  })
})

describe('the page scripts', () => {
  it('run the very function that is tested, with the choice as data', () => {
    const script = transformScript('upper')
    expect(script).toContain(TRANSFORM_CASE_SOURCE)
    expect(() => new Function(script)).not.toThrow()
    expect(formatScript('bold')).toContain('"bold"')
    expect(() => new Function(formatScript('underline'))).not.toThrow()
  })
})
