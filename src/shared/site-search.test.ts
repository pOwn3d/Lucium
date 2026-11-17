import { describe, expect, it } from 'vitest'
import { cleanSiteSearches } from './state-clean'
import { DEFAULT_SITE_SEARCHES } from './model'
import { isSearchAddress, isSiteAddress, restoreDefaultSiteSearches, sameSiteSearches, siteSearchProblem, takesTerm } from './site-search'

const tw = { keyword: 'tw', name: 'Twitch', url: 'https://twitch.tv' }

describe('the address of a site search or shortcut', () => {
  it('may be a plain site (a shortcut that opens it) or take the search with %s', () => {
    expect(isSiteAddress('https://twitch.tv')).toBe(true)
    expect(isSiteAddress('https://www.twitch.tv/search?term=%s')).toBe(true)
    expect(takesTerm('https://twitch.tv')).toBe(false)
    expect(takesTerm('https://www.twitch.tv/search?term=%s')).toBe(true)
  })

  it('is a web address with no space: not http, not a script, not text', () => {
    for (const bad of ['http://twitch.tv', 'twitch.tv', 'javascript:alert(1)', 'https://twitch.tv/a b', 'https://', 42, undefined]) expect(isSiteAddress(bad), String(bad)).toBe(false)
  })
})

describe('what stops a shortcut from being added', () => {
  it('lets a plain address through (it did not: the button stayed grey without a word)', () => {
    expect(siteSearchProblem(tw, [])).toBeNull()
  })

  it('names the first thing to fix, in the order of the form', () => {
    expect(siteSearchProblem({ ...tw, keyword: '' }, [])).toBe('keyword')
    expect(siteSearchProblem({ ...tw, keyword: 'un mot long !' }, [])).toBe('keyword')
    expect(siteSearchProblem(tw, [tw])).toBe('taken')
    expect(siteSearchProblem({ ...tw, keyword: 'TW' }, [tw])).toBe('taken')
    expect(siteSearchProblem({ ...tw, name: '  ' }, [])).toBe('name')
    expect(siteSearchProblem({ ...tw, url: 'twitch.tv' }, [])).toBe('address')
  })
})

describe('what the saved state keeps', () => {
  it('keeps a shortcut without %s: it was dropped at the next start, as if it had never been added', () => {
    expect(cleanSiteSearches([tw, { keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' }])).toEqual([tw, { keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' }])
  })

  it('still drops an address that is not a web address', () => {
    expect(cleanSiteSearches([{ keyword: 'x', name: 'X', url: 'javascript:alert(1)' }, { keyword: 'y', name: 'Y', url: 'http://insecure.example/' }])).toEqual([])
  })

  // The discovery of searches offers the search of a site being built (plain http on this machine, docs/recherche.md): the list must keep it, or the notice
  // « Recherche ajoutée » is followed by nothing.
  it('keeps a search on this machine in plain http: a site being built', () => {
    const local = [
      { keyword: 'dev', name: 'Dev', url: 'http://localhost:3000/search?q=%s' },
      { keyword: 'ip', name: 'Ip', url: 'http://127.0.0.1:8123/q?term=%s' },
      { keyword: 'six', name: 'Six', url: 'http://[::1]:5173/?s=%s' },
      { keyword: 'bare', name: 'Bare', url: 'http://localhost' }
    ]
    expect(cleanSiteSearches(local)).toEqual(local)
  })

  it('drops plain http everywhere else, and any address with a login in it', () => {
    const elsewhere = [
      'http://insecure.example/?q=%s',
      'http://localhost.evil.example/?q=%s',
      'http://127.0.0.1.evil.example/?q=%s',
      'http://127.0.0.256/?q=%s',
      'http://user:secret@127.0.0.1/?q=%s',
      'http://192.168.1.10/?q=%s',
      'http://10.0.0.1/?q=%s',
      'http://0.0.0.0/?q=%s',
      'ftp://localhost/?q=%s',
      'http://127.0.0.1/ ?q=%s'
    ]
    for (const url of elsewhere) expect(cleanSiteSearches([{ keyword: 'x', name: 'X', url }]), url).toEqual([])
  })
})

describe('isSearchAddress', () => {
  it('is an https address, or plain http on this machine', () => {
    expect(isSearchAddress('https://www.twitch.tv/search?term=%s')).toBe(true)
    expect(isSearchAddress('http://127.0.0.1:8123/q?term=%s')).toBe(true)
    expect(isSearchAddress('http://localhost:3000/')).toBe(true)
    expect(isSearchAddress('http://example.org/')).toBe(false)
    expect(isSearchAddress('http://127.0.0.1@evil.example/')).toBe(false)
    expect(isSearchAddress(42)).toBe(false)
    expect(isSearchAddress(undefined)).toBe(false)
  })

  it('stays out of the address of a shortcut for a site (« Créer un raccourci »), which is https only', () => {
    expect(isSiteAddress('http://127.0.0.1:8123/')).toBe(false)
  })
})

describe('« Rétablir les recherches par défaut »', () => {
  const defaults = [
    { keyword: 'g', name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' },
    { keyword: 'w', name: 'Wikipédia', url: 'https://fr.wikipedia.org/w/index.php?search=%s' }
  ]

  it('fills an emptied list with every default search, in their order', () => {
    expect(restoreDefaultSiteSearches([], defaults)).toEqual({ list: defaults, added: 3 })
  })

  it('keeps the user’s own searches first and as they are, and adds only the missing defaults at the end', () => {
    const mine = { keyword: 'tw', name: 'Twitch', url: 'https://twitch.tv' }
    expect(restoreDefaultSiteSearches([mine, defaults[1]!], defaults)).toEqual({ list: [mine, defaults[1], defaults[0], defaults[2]], added: 2 })
  })

  it('never replaces a search of the user that took the keyword of a default one, whatever its case', () => {
    const own = { keyword: 'G', name: 'Ma recherche', url: 'https://example.org/?q=%s' }
    const { list, added } = restoreDefaultSiteSearches([own], defaults)
    expect(list.filter((search) => search.keyword.toLowerCase() === 'g')).toEqual([own])
    expect(added).toBe(2)
  })

  it('has nothing to do when every default is there (the button is grey), and gives copies, not the defaults themselves', () => {
    expect(restoreDefaultSiteSearches(defaults, defaults)).toEqual({ list: defaults, added: 0 })
    const { list } = restoreDefaultSiteSearches([], defaults)
    expect(list[0]).not.toBe(defaults[0])
  })

  it('uses the defaults of the application when none are given', () => {
    const { list, added } = restoreDefaultSiteSearches([])
    expect(list).toEqual(DEFAULT_SITE_SEARCHES)
    expect(added).toBe(DEFAULT_SITE_SEARCHES.length)
  })

  it('tells whether the list is still the one it made (the undo is offered only then)', () => {
    const { list } = restoreDefaultSiteSearches([], defaults)
    expect(sameSiteSearches(list, defaults)).toBe(true)
    expect(sameSiteSearches(list, defaults.slice(1))).toBe(false)
    expect(sameSiteSearches(list, [{ ...defaults[0]!, name: 'Autre' }, defaults[1]!, defaults[2]!])).toBe(false)
  })
})
