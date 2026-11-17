// When what is typed in the command bar may go to the default search engine for suggestions, and which addresses stay private when they are
// asked for in a new place. The bar of the interface asks the first rule before each request (the last test reads that it does).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { knownOnlyPrivately, suggestionQuery } from './command-bar'
import type { TabItem } from './model'

const anywhere = { staysPrivate: false, genre: null, siteSearch: false } as const

describe('suggestionQuery', () => {
  it('lets a plain search of two characters or more go to the search engine', () => {
    expect(suggestionQuery('recette de crêpes', anywhere)).toBe('recette de crêpes')
    expect(suggestionQuery('  ab  ', anywhere)).toBe('ab')
  })

  it('sends nothing while the text is the search of a site (the pill): it is a question for that site, not for the default engine', () => {
    expect(suggestionQuery('symptômes grippe', { ...anywhere, siteSearch: true })).toBeNull()
  })

  it('sends nothing from a private window or over a private tab, nor inside a genre of the bar', () => {
    expect(suggestionQuery('recette de crêpes', { ...anywhere, staysPrivate: true })).toBeNull()
    expect(suggestionQuery('recette de crêpes', { ...anywhere, genre: 'tabs' })).toBeNull()
  })

  it('sends neither a text too short, nor one with a run of spaces, nor an address', () => {
    for (const typed of ['', 'a', ' a ', 'deux  espaces', 'https://exemple.fr/page', 'exemple.fr']) expect(suggestionQuery(typed, anywhere), JSON.stringify(typed)).toBeNull()
  })

  it('is what the bar of the interface asks before each request, with the pill of a site search', () => {
    const source = readFileSync(fileURLToPath(new URL('../renderer/CommandBar.tsx', import.meta.url)), 'utf8')
    const effect = source.slice(source.indexOf('// Web suggestions come from the search engine'), source.indexOf('.suggest(text)'))
    expect(effect).toContain('const text = suggestionQuery(query, { staysPrivate, genre: barScope, siteSearch: scope !== null })')
    expect(effect).toContain('if (text === null) {')
    expect(effect.length).toBeLessThan(700)
  })
})

describe('knownOnlyPrivately', () => {
  const tab = (url: string, isPrivate: boolean): TabItem => ({ id: url + String(isPrivate), spaceId: 's', url, title: '', pinned: false, createdAt: 1, lastActiveAt: 1, ...(isPrivate ? { private: true } : {}) }) as TabItem

  it('is true for an address a private tab is at and no ordinary tab is', () => {
    expect(knownOnlyPrivately({ tabs: [tab('https://a.example/', true), tab('https://b.example/', false)] }, 'https://a.example/')).toBe(true)
  })

  it('is false when an ordinary tab is at it too, when only ordinary tabs are, and when no tab is', () => {
    expect(knownOnlyPrivately({ tabs: [tab('https://a.example/', true), tab('https://a.example/', false)] }, 'https://a.example/')).toBe(false)
    expect(knownOnlyPrivately({ tabs: [tab('https://b.example/', false)] }, 'https://b.example/')).toBe(false)
    expect(knownOnlyPrivately({ tabs: [] }, 'https://a.example/')).toBe(false)
  })
})
