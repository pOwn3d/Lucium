// The summary is asked for in the language of the interface, at the length chosen.
import { describe, expect, it } from 'vitest'
import { summaryPrompt } from './summary-prompt'
import { getLanguage, setLanguage } from './i18n'

describe('the language of the summary', () => {
  it('is the language of the interface, length included', () => {
    expect(summaryPrompt('texte', 'https://exemple.fr/a', 'short', 'fr')).toMatch(/^Résume en français en deux ou trois phrases /)
    expect(summaryPrompt('text', 'https://example.org/a', 'long', 'en')).toMatch(/^Summarize in English in detail, with subheadings /)
  })

  it('follows the language the process is set to when none is given', () => {
    const before = getLanguage()
    try {
      setLanguage('en')
      expect(summaryPrompt('text', 'https://example.org/a')).toMatch(/^Summarize in English in five sentences at most /)
      setLanguage('fr')
      expect(summaryPrompt('texte', 'https://exemple.fr/a')).toMatch(/^Résume en français en cinq phrases au plus /)
    } finally {
      setLanguage(before)
    }
  })
})
