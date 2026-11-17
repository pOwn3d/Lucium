import { describe, expect, it } from 'vitest'
import { REPLACE_IN_TEXT_SOURCE, REPLACE_TEXT_MAX, buildReplaceScript, parseReplaceRequest, replaceInText, replaceMessage } from './find-replace'
import { setLanguage } from './i18n'

describe('replaceInText', () => {
  it('replaces every occurrence, ignoring case unless asked, and counts them', () => {
    expect(replaceInText('Chat chat CHAT', 'chat', 'chien', false, Infinity)).toEqual({ text: 'chien chien chien', count: 3, total: 3 })
    expect(replaceInText('Chat chat CHAT', 'chat', 'chien', true, Infinity)).toEqual({ text: 'Chat chien CHAT', count: 1, total: 1 })
  })

  it('stops at the limit but still counts what it left', () => {
    expect(replaceInText('a a a a', 'a', 'b', false, 2)).toEqual({ text: 'b b a a', count: 2, total: 4 })
    expect(replaceInText('a a', 'a', 'b', false, 0)).toEqual({ text: 'a a', count: 0, total: 2 })
  })

  it('takes the query as plain text, not as a pattern', () => {
    expect(replaceInText('1+1=2 (ok) [x] a.b a-b', '1+1', 'deux', false, Infinity).text).toBe('deux=2 (ok) [x] a.b a-b')
    expect(replaceInText('(ok) [x] a.b axb', '.', '!', false, Infinity).text).toBe('(ok) [x] a!b axb')
    expect(replaceInText('(ok) [x]', '[x]', 'y', false, Infinity).text).toBe('(ok) y')
    expect(replaceInText('a\\b', '\\', '/', false, Infinity).text).toBe('a/b')
  })

  it('inserts the replacement literally ($& and $1 are not substitutions)', () => {
    expect(replaceInText('abc', 'b', '$&$&', false, Infinity).text).toBe('a$&$&c')
  })

  it('does nothing without a query', () => {
    expect(replaceInText('abc', '', 'x', false, Infinity)).toEqual({ text: 'abc', count: 0, total: 0 })
  })

  it('is the very function the page runs', () => {
    expect(buildReplaceScript({ query: 'a', replacement: 'b', all: true, matchCase: false })).toContain(REPLACE_IN_TEXT_SOURCE)
  })
})

describe('buildReplaceScript', () => {
  it('embeds the request as data, so a quote in the text cannot break out of the script', () => {
    const script = buildReplaceScript({ query: `a"');alert(1);('`, replacement: 'x\ny', all: false, matchCase: true })
    expect(script).toContain(JSON.stringify(`a"');alert(1);('`))
    expect(script).toContain('all = false')
    expect(script).toContain('matchCase = true')
    expect(() => new Function(script)).not.toThrow()
  })
})

describe('replaceMessage', () => {
  it('counts what changed, and says why nothing did', () => {
    expect(replaceMessage({ replaced: 1, editable: 1 }, 1)).toBe('1 occurrence remplacée')
    expect(replaceMessage({ replaced: 3, editable: 3 }, 3)).toBe('3 occurrences remplacées')
    expect(replaceMessage({ replaced: 0, editable: 0 }, 2)).toBe('Le texte trouvé se trouve dans une zone en lecture seule')
    expect(replaceMessage({ replaced: 0, editable: 0 }, 0)).toBe('Aucune occurrence')
  })

  it('counts in English too, one match or several', () => {
    setLanguage('en')
    try {
      expect(replaceMessage({ replaced: 1, editable: 1 }, 1)).toBe('1 match replaced')
      expect(replaceMessage({ replaced: 3, editable: 3 }, 3)).toBe('3 matches replaced')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('parseReplaceRequest', () => {
  it('takes a well-formed request, and only a real true for the flags', () => {
    expect(parseReplaceRequest({ query: 'a', replacement: '', all: true, matchCase: 'yes' })).toEqual({ query: 'a', replacement: '', all: true, matchCase: false })
    // Both flags are written into the script the page runs: anything but a real true is false, never text.
    expect(parseReplaceRequest({ query: 'a', replacement: '', all: '0;alert(1)', matchCase: true })).toEqual({ query: 'a', replacement: '', all: false, matchCase: true })
  })

  it('writes the flags into the script as true or false only, whatever the request it is given says', () => {
    const script = buildReplaceScript({ query: 'a', replacement: '', all: '0;alert(1)' as never, matchCase: '1;alert(2)' as never })
    expect(script).toContain('matchCase = false, all = false')
    expect(script).not.toContain('alert')
  })

  it('refuses an empty query, a wrong type and a text longer than a person types', () => {
    for (const bad of [null, 'x', {}, { query: '', replacement: 'b' }, { query: 'a' }, { query: 1, replacement: 'b' }, { query: 'a', replacement: 2 }, { query: 'a'.repeat(REPLACE_TEXT_MAX + 1), replacement: '' }, { query: 'a', replacement: 'b'.repeat(REPLACE_TEXT_MAX + 1) }]) {
      expect(parseReplaceRequest(bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull()
    }
  })
})
