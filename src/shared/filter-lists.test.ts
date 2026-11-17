import { describe, expect, it } from 'vitest'
import { FILTER_ADDRESS_MAX, FILTER_LISTS, FILTER_STEP_BUDGET, SHRINK_LIMIT, activeLists, addressForFilters, blockedLabel, filterRuleHazard, listStatusLine, validateFilterList, type FilterListState } from './filter-lists'

const lines = (n: number, prefix = '||ads') => Array.from({ length: n }, (_, i) => `${prefix}${i}.example^`).join('\n')

describe('the catalogue', () => {
  it('has unique ids that are safe file names, and only https addresses', () => {
    const ids = FILTER_LISTS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const list of FILTER_LISTS) {
      expect(list.id).toMatch(/^[a-z0-9-]{1,40}$/)
      expect(list.url.startsWith('https://')).toBe(true)
      // A licence and an author for each: they are shown in the settings and listed in docs/licences-tierces.md.
      expect(list.license).not.toBe('')
      expect(list.author).not.toBe('')
    }
  })

  it('asks for more rules than the root file of uBlock filters holds, which is what loses three quarters of the list', () => {
    // filters.txt has 6,078 rules and points to the rest with "!#include"; filters.min.txt, the whole list, has about 24,000.
    const main = FILTER_LISTS.find((l) => l.id === 'ublock-filters')!
    expect(main.url.endsWith('/filters.min.txt')).toBe(true)
    expect(validateFilterList(lines(6078), { minRules: main.minRules })).toMatchObject({ ok: false })
    expect(validateFilterList(lines(23939), { minRules: main.minRules })).toMatchObject({ ok: true })
  })

  it('has the French list for a French browser, among the ad lists', () => {
    const french = FILTER_LISTS.find((l) => l.id === 'adguard-fr')
    expect(french?.category).toBe('ads')
    expect(french?.url).toBe('https://filters.adtidy.org/extension/ublock/filters/16.txt')
  })

  it('follows the two options, and the lists switched off one by one', () => {
    const all = { ads: true, cookieBanners: true, disabledLists: [] }
    expect(activeLists(FILTER_LISTS, all)).toHaveLength(FILTER_LISTS.length)
    expect(activeLists(FILTER_LISTS, { ...all, cookieBanners: false }).every((l) => l.category === 'ads')).toBe(true)
    expect(activeLists(FILTER_LISTS, { ...all, ads: false }).every((l) => l.category === 'cookies')).toBe(true)
    expect(activeLists(FILTER_LISTS, { ads: false, cookieBanners: false, disabledLists: [] })).toEqual([])
    expect(activeLists(FILTER_LISTS, { ...all, disabledLists: ['easylist'] }).some((l) => l.id === 'easylist')).toBe(false)
  })
})

describe('validateFilterList', () => {
  it('accepts a list and counts its rules, not its comments or header', () => {
    const verdict = validateFilterList(`[Adblock Plus 2.0]\n! Title: Ma liste\n! Expires: 4 days\n${lines(3)}\n\n! fin\n`)
    expect(verdict).toEqual({ ok: true, rules: 3, title: 'Ma liste' })
  })

  it('refuses an HTML page, however the server answered', () => {
    for (const html of ['<!DOCTYPE html><html><body>Connexion</body></html>', '  \n<html lang="fr">', '<?xml version="1.0"?><error/>']) {
      expect(validateFilterList(html)).toMatchObject({ ok: false })
    }
  })

  it('refuses an empty answer, binary data, and text with no rule', () => {
    expect(validateFilterList('')).toMatchObject({ ok: false })
    expect(validateFilterList(`${lines(5)}\u0000\u0001`)).toMatchObject({ ok: false })
    expect(validateFilterList('[Adblock Plus 2.0]\n! Title: Vide\n! rien\n')).toMatchObject({ ok: false })
  })

  it('refuses a list with fewer rules than the real one has', () => {
    expect(validateFilterList(lines(10), { minRules: 100 })).toMatchObject({ ok: false })
    expect(validateFilterList(lines(100), { minRules: 100 })).toMatchObject({ ok: true })
  })

  it('refuses a copy that lost half the rules of the one it would replace (a cut download)', () => {
    expect(validateFilterList(lines(40), { previousRules: 100 })).toMatchObject({ ok: false })
    expect(validateFilterList(lines(Math.ceil(100 * SHRINK_LIMIT)), { previousRules: 100 })).toMatchObject({ ok: true })
    expect(validateFilterList(lines(300), { previousRules: 100 })).toMatchObject({ ok: true })
    expect(validateFilterList(lines(40), { previousRules: null })).toMatchObject({ ok: true })
  })

  it('refuses a list that includes other files, which the engine does not follow', () => {
    const root = `[Adblock Plus 2.0]\n! Title: uBlock filters\n${lines(20)}\n!#include filters-general.txt\n!#include filters-2026.txt\n`
    expect(validateFilterList(root)).toMatchObject({ ok: false, reason: expect.stringContaining('!#include') })
    // The same list once the includes are resolved is fine, and a comment that only mentions the word is not an include.
    expect(validateFilterList(`[Adblock Plus 2.0]\n! Title: uBlock filters\n${lines(40)}\n`)).toMatchObject({ ok: true })
    expect(validateFilterList(`! the !#include lines were resolved\n${lines(2)}`)).toMatchObject({ ok: true, rules: 2 })
  })

  it('ignores a byte order mark', () => {
    expect(validateFilterList(`﻿[Adblock Plus 2.0]\n${lines(2)}`)).toMatchObject({ ok: true, rules: 2 })
  })
})

describe('blockedLabel', () => {
  it('counts in French, in the singular for one', () => {
    expect(blockedLabel(0)).toBe('Aucune requête bloquée')
    expect(blockedLabel(1)).toBe('1 requête bloquée')
    expect(blockedLabel(12)).toBe('12 requêtes bloquées')
    expect(blockedLabel(1234)).toMatch(/^1\s?234 requêtes bloquées$/)
  })
})

describe('listStatusLine', () => {
  const at = Date.UTC(2026, 9, 23, 12, 30)
  const state = (patch: Partial<FilterListState> = {}): FilterListState => ({ id: 'easylist', installed: true, updatedAt: at, rules: 85268, error: null, updating: false, ...patch })

  it('says when the copy was last checked and how many rules it holds', () => {
    const line = listStatusLine(state(), true, true)
    expect(line.text).toMatch(/^Vérifiée le .*2026.* · 85\s?268 règles$/)
    expect(line.error).toBeUndefined()
  })

  it('shows the failure beside the copy that stays in use', () => {
    const line = listStatusLine(state({ error: { message: 'Délai dépassé.', at } }), true, true)
    expect(line.text).toContain('Vérifiée le')
    expect(line.error).toMatch(/^Échec de la dernière mise à jour \(.*2026.*\)\u00a0: Délai dépassé\. La copie précédente reste utilisée\.$/)
  })

  it('does not promise a previous copy when there is none', () => {
    const line = listStatusLine(state({ installed: false, updatedAt: null, rules: null, error: { message: 'Réponse du serveur : 500.', at } }), true, true)
    expect(line.text).toBe('Pas encore téléchargée.')
    expect(line.error).not.toContain('copie précédente')
    expect(line.error).toContain('500')
  })

  it('tells a list that is downloading, one never fetched, one switched off, and an option that is off', () => {
    expect(listStatusLine(state({ updating: true }), true, true).text).toBe('Téléchargement en cours…')
    expect(listStatusLine(undefined, true, true).text).toBe('Pas encore téléchargée.')
    expect(listStatusLine(state(), true, false).text).toBe('Désactivée.')
    expect(listStatusLine(state(), false, true).text).toContain('option')
  })
})

describe('what matching a rule may cost', () => {
  it('gives the engine the start of a long address, and a short one whole', () => {
    const short = 'https://exemple.fr/a.js'
    expect(addressForFilters(short)).toBe(short)
    const edge = `https://exemple.fr/${'a'.repeat(FILTER_ADDRESS_MAX)}`.slice(0, FILTER_ADDRESS_MAX)
    expect(addressForFilters(edge)).toBe(edge)
    const long = `https://exemple.fr/${'a'.repeat(100_000)}`
    expect(addressForFilters(long)).toBe(long.slice(0, FILTER_ADDRESS_MAX))
  })

  it('lets through the expression of a rule with one wildcard, or two that follow a fixed start', () => {
    expect(filterRuleHazard('\\/ads\\/.*\\.js')).toBeNull()
    expect(filterRuleHazard('^\\/.*\\/ads\\/.*\\.js')).toBeNull()
    expect(filterRuleHazard('^(?:[^\\w\\d_.%-]|$).*\\/images\\/pub\\/.*_banniere')).toBeNull()
    expect(filterRuleHazard('^https:\\/\\/[a-z]+\\.exemple\\.fr\\/[0-9]+\\.js$')).toBeNull()
  })

  it('refuses the expression of a rule whose wildcards are tried in every combination of places', () => {
    // Two wildcards in a rule that can start anywhere: three places to choose, the cube of the length.
    expect(filterRuleHazard('\\/banner\\/.*\\/ads\\/.*\\.js')).toBe('too many repetitions for a long address')
    expect(filterRuleHazard('^\\/ptracking\\?html5=1&video_id=.*&cpn=.*&ei=.*&ptk=youtube_.*&pltype=content')).toBe('too many repetitions for a long address')
  })

  it('refuses an expression whose time doubles with each character', () => {
    expect(filterRuleHazard('(a+)+b')).toBe('a repetition inside a repetition')
    expect(filterRuleHazard('^(?=a)b')).toBe('a look-around')
  })

  it('keeps the work of what it lets through under the budget on the longest address the engine is given', () => {
    // The places a rule of two open runs can make the engine try on `n` characters: one pair of places in two.
    expect(FILTER_ADDRESS_MAX ** 2 / 2).toBeLessThanOrEqual(FILTER_STEP_BUDGET)
    // Three open runs are over it by two orders of magnitude: no address of this length lets them through.
    expect(FILTER_ADDRESS_MAX ** 3 / 6).toBeGreaterThan(100 * FILTER_STEP_BUDGET)
  })
})
