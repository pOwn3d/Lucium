import { describe, expect, it } from 'vitest'
import { BUILTIN_BANGS, allBangs, bangSearchFor, bangSite, parseBang, siteOriginOf } from './bangs'
import { DEFAULT_SITE_SEARCHES, defaultSettings } from './model'
import { createInitialState } from './sidebar'
import { isSearchTemplate } from './url'

const stateWith = (settings: Partial<ReturnType<typeof defaultSettings>> = {}) => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { ...state, settings: { ...state.settings, ...settings } }
}

describe('the fixed list of engines', () => {
  it('has unique lower-case keywords of at most 12 letters or digits', () => {
    const keywords = BUILTIN_BANGS.map((b) => b.keyword)
    expect(new Set(keywords).size).toBe(keywords.length)
    for (const k of keywords) expect(k, k).toMatch(/^[a-z0-9]{1,12}$/)
  })

  it('has an https address with exactly one place for the search, and a name, for every engine', () => {
    for (const b of BUILTIN_BANGS) {
      expect(isSearchTemplate(b.url), b.keyword).toBe(true)
      expect(b.url.startsWith('https://'), b.keyword).toBe(true)
      expect(b.url.split('%s').length - 1, b.keyword).toBe(1)
      expect(b.name.trim(), b.keyword).not.toBe('')
      expect(new URL(b.url.replace('%s', 'a b')).host, b.keyword).not.toBe('')
    }
  })

  it('is the list of the searches the application starts with, in its order, so a bang never differs from the keyword', () => {
    for (const bang of BUILTIN_BANGS) expect(DEFAULT_SITE_SEARCHES, bang.keyword).toContain(bang)
    expect(BUILTIN_BANGS.map((b) => b.keyword)).toEqual(DEFAULT_SITE_SEARCHES.map((s) => s.keyword).filter((keyword) => keyword !== 'maps'))
    expect(BUILTIN_BANGS).toHaveLength(46)
  })

  it('has one bang for Google Maps, `!gm`: the second keyword of the starting list, `maps`, is none', () => {
    expect(BUILTIN_BANGS.filter((b) => b.name === 'Google Maps').map((b) => b.keyword)).toEqual(['gm'])
    expect(DEFAULT_SITE_SEARCHES.filter((s) => s.name === 'Google Maps').map((s) => s.keyword)).toEqual(['gm', 'maps'])
  })
})

describe('parseBang', () => {
  it('reads a keyword before or after the terms', () => {
    expect(parseBang('!w planète')).toEqual({ keyword: 'w', terms: 'planète' })
    expect(parseBang('  !W   planète  médiévale ')).toEqual({ keyword: 'w', terms: 'planète  médiévale' })
    expect(parseBang('planète !w')).toEqual({ keyword: 'w', terms: 'planète' })
    expect(parseBang('planète médiévale !gh')).toEqual({ keyword: 'gh', terms: 'planète médiévale' })
  })

  it('reads a keyword alone', () => {
    expect(parseBang('!w')).toEqual({ keyword: 'w', terms: '' })
    expect(parseBang('  !yt ')).toEqual({ keyword: 'yt', terms: '' })
  })

  it('leaves alone what is not written that way', () => {
    for (const text of ['', '   ', '!', '! w', 'w', 'yt lofi', 'a!w', 'hello!', '!!w x', 'foo !', 'foo!w', 'foo ! w', '!w!x y', `!${'a'.repeat(31)} x`, `x ${'a'.repeat(1001)} !w`]) {
      expect(parseBang(text), text).toBeNull()
    }
  })

  it('takes the first keyword when two are typed', () => {
    expect(parseBang('!w !g foo')).toEqual({ keyword: 'w', terms: '!g foo' })
  })

  it('is quick on a long text full of spaces', () => {
    const started = Date.now()
    for (let i = 0; i < 200; i++) parseBang(`${' a'.repeat(450)} !x y`)
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

describe('bangSite', () => {
  it('prefers the user\'s own search to the fixed list', () => {
    const state = stateWith({ siteSearches: [{ keyword: 'w', name: 'Mon wiki', url: 'https://wiki.example/?q=%s' }] })
    expect(bangSite('w', state)?.name).toBe('Mon wiki')
    expect(bangSite('W', state)?.name).toBe('Mon wiki')
    expect(bangSite('wen', state)?.name).toBe('Wikipedia (anglais)')
    expect(bangSite('nope', state)).toBeUndefined()
  })

  it('does not answer to a name that is no keyword (nor to Object.prototype)', () => {
    const state = stateWith()
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(bangSite(word, state), word).toBeUndefined()
  })
})

describe('allBangs', () => {
  it('lists the user\'s searches first, then the fixed ones they do not replace', () => {
    const state = stateWith({ siteSearches: [{ keyword: 'w', name: 'Mon wiki', url: 'https://wiki.example/?q=%s' }, { keyword: 'zz', name: 'Zed', url: 'https://zed.example/?q=%s' }] })
    const list = allBangs(state)
    expect(list.slice(0, 2).map((b) => b.keyword)).toEqual(['w', 'zz'])
    expect(list.filter((b) => b.keyword === 'w')).toHaveLength(1)
    expect(list).toHaveLength(BUILTIN_BANGS.length + 1)
  })
})

describe('bangSearchFor', () => {
  const state = stateWith()

  it('gives the search of the site, the terms encoded', () => {
    expect(bangSearchFor('!w planète & carreau', state)).toEqual({
      name: 'Wikipédia',
      keyword: 'w',
      terms: 'planète & carreau',
      url: 'https://fr.wikipedia.org/w/index.php?search=plan%C3%A8te%20%26%20carreau'
    })
    expect(bangSearchFor('lofi !yt', state)?.url).toBe('https://www.youtube.com/results?search_query=lofi')
  })

  it('opens the site itself when only the keyword is typed', () => {
    expect(bangSearchFor('!w', state)).toMatchObject({ url: 'https://fr.wikipedia.org/', terms: '' })
    expect(bangSearchFor('!hn', state)?.url).toBe('https://hn.algolia.com/')
  })

  it('is null for an unknown keyword, for plain text and when bangs are switched off', () => {
    expect(bangSearchFor('!nope foo', state)).toBeNull()
    expect(bangSearchFor('foo', state)).toBeNull()
    expect(bangSearchFor('!w foo', stateWith({ searchBangs: false }))).toBeNull()
  })

  it('never lets a keyword inject anything into the address: the terms are encoded, the template is the list\'s', () => {
    const hostile = bangSearchFor('!w "><script>alert(1)</script> %s #', state)
    expect(hostile?.url).toBe(`https://fr.wikipedia.org/w/index.php?search=${encodeURIComponent('"><script>alert(1)</script> %s #')}`)
    expect(new URL(hostile!.url).host).toBe('fr.wikipedia.org')
  })

  it('works with a search of the user\'s whose address has no path', () => {
    const own = stateWith({ siteSearches: [{ keyword: 'x', name: 'X', url: 'https://x.example/?q=%s' }] })
    expect(bangSearchFor('!x', own)?.url).toBe('https://x.example/')
  })
})

describe('siteOriginOf', () => {
  it('gives the site of a template, or null when it has none', () => {
    expect(siteOriginOf('https://fr.wikipedia.org/w/index.php?search=%s')).toBe('https://fr.wikipedia.org/')
    expect(siteOriginOf('http://127.0.0.1:8080/s?q=%s')).toBe('http://127.0.0.1:8080/')
    expect(siteOriginOf('not a url %s')).toBeNull()
  })
})
