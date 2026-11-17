import { afterEach, describe, expect, it } from 'vitest'
import { blockedLabel, listStatusLine, validateFilterList, type FilterListState } from './filter-lists'
import { setLanguage } from './i18n'

// What the settings and the site panel say about the lists follows the language of the interface: a failed update is the message the user most needs to read.
afterEach(() => setLanguage('fr'))

const at = Date.UTC(2026, 9, 23, 12, 30)
const state = (patch: Partial<FilterListState> = {}): FilterListState => ({ id: 'easylist', installed: true, updatedAt: at, rules: 85268, error: null, updating: false, ...patch })

describe('the lines about the filter lists, in English', () => {
  it('say when the copy was updated, how many rules it holds, and that a failed update keeps the previous copy', () => {
    setLanguage('en')
    const line = listStatusLine(state({ error: { message: 'Timed out.', at } }), true, true)
    expect(line.text).toMatch(/^Checked .*2026.* · 85,268 rules$/)
    expect(line.error).toMatch(/^Last update failed \(.*2026.*\): Timed out\. The previous copy is still in use\.$/)
    expect(listStatusLine(state({ rules: 1 }), true, true).text).toMatch(/ · 1 rule$/)
  })

  it('count the requests blocked on a page in singular and plural', () => {
    setLanguage('en')
    expect(blockedLabel(1)).toBe('1 blocked request')
    expect(blockedLabel(1234)).toBe('1,234 blocked requests')
  })

  it('refuse a list that hands rules to other files with a sentence in the language of the interface', () => {
    setLanguage('en')
    const verdict = validateFilterList('! Title: x\n!#include other.txt\n||a.example^\n')
    expect(verdict).toMatchObject({ ok: false })
    expect(verdict.ok === false && verdict.reason).toMatch(/^The list points to other files \(!#include\)/)
  })
})

describe('the same lines, in French (the language of origin)', () => {
  it('keep their wording, with the singular where there is one', () => {
    expect(listStatusLine(state({ rules: 1 }), true, true).text).toMatch(/ · 1 règle$/)
    expect(blockedLabel(1)).toBe('1 requête bloquée')
  })
})
