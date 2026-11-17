import { describe, expect, it } from 'vitest'
import { cleanBlockExceptions, normalizeBlockHost } from './blocker'
import { cleanHostEntries, normalizeHostEntry } from './host-entry'
import { cleanSleepHosts, normalizeSleepHost } from './sleep'

describe('a site as the lists of sites keep it', () => {
  const READ: Array<[unknown, string | null]> = [
    ['Exemple.org', 'exemple.org'],
    ['  https://www.exemple.org:8443/page?x=1#y  ', 'exemple.org'],
    ['*.exemple.org', 'exemple.org'],
    ['exemple.org.', 'exemple.org'],
    ['localhost', 'localhost'],
    ['ftp://exemple.org', null],
    ['exemple .org', null],
    ['-exemple.org', null],
    [`${'a'.repeat(64)}.org`, null],
    ['', null],
    [12, null],
    [null, null]
  ]

  it('is read one way: lower case, no scheme, port, path, final dot or leading www.', () => {
    for (const [typed, host] of READ) expect(normalizeHostEntry(typed, 300), String(typed)).toBe(host)
  })

  it('is read the same way by the list of sites never put to sleep and by the list of sites where nothing is blocked', () => {
    for (const [typed, host] of READ) {
      expect(normalizeSleepHost(typed), String(typed)).toBe(host)
      expect(normalizeBlockHost(typed), String(typed)).toBe(host)
    }
  })

  it('refuses a text longer than the bound it is given, which is the one thing the two lists do not share', () => {
    const pasted = `https://exemple.org/${'a'.repeat(400)}`
    expect(normalizeHostEntry(pasted, 2048)).toBe('exemple.org')
    expect(normalizeHostEntry(pasted, 300)).toBeNull()
    expect(normalizeHostEntry('exemple.org', 11)).toBe('exemple.org')
    expect(normalizeHostEntry('exemple.org', 10)).toBeNull()
    // A pasted address with its query: kept by the first list, too long for the second.
    expect(normalizeSleepHost(pasted)).toBe('exemple.org')
    expect(normalizeBlockHost(pasted)).toBeNull()
  })

  it('refuses a host longer than the DNS allows (253 characters), whatever bound the text has', () => {
    // Three labels of 63 characters and a last one of `last`: each label is valid, so only the length of the whole name decides.
    const host = (last: number) => `${`${'a'.repeat(63)}.`.repeat(3)}${'b'.repeat(last)}`
    expect(host(61)).toHaveLength(253)
    expect(normalizeHostEntry(host(61), 2048)).toBe(host(61))
    expect(normalizeHostEntry(host(62), 2048)).toBeNull()
  })
})

describe('a saved list of sites', () => {
  it('keeps valid hosts only, each once, in order, and no more than its bound', () => {
    const read = (entry: unknown): string | null => normalizeHostEntry(entry, 300)
    expect(cleanHostEntries(['b.org', 'https://www.a.org/x', 3, 'B.ORG', 'pas un hôte', 'c.org'], read, 10)).toEqual(['b.org', 'a.org', 'c.org'])
    expect(cleanHostEntries(['a.org', 'b.org', 'c.org'], read, 2)).toEqual(['a.org', 'b.org'])
    for (const notAList of [null, undefined, 'a.org', { 0: 'a.org' }]) expect(cleanHostEntries(notAList, read, 10)).toEqual([])
  })

  it('is cleaned the same way for both lists, 200 sites at most', () => {
    const many = Array.from({ length: 250 }, (_, i) => `site-${i}.org`)
    expect(cleanSleepHosts(many)).toEqual(many.slice(0, 200))
    expect(cleanBlockExceptions(many)).toEqual(many.slice(0, 200))
    expect(cleanSleepHosts(['www.a.org', 'a.org', 7])).toEqual(['a.org'])
    expect(cleanBlockExceptions(['www.a.org', 'a.org', 7])).toEqual(['a.org'])
  })
})
