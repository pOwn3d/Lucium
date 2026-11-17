// The interface follows the language of the system by default: on for a new profile, language auto.
import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { resolveLanguage } from './i18n'

describe('the interface language by default', () => {
  it('is translated and follows the system', () => {
    const settings = defaultSettings()
    expect(settings.interfaceTranslated).toBe(true)
    expect(settings.language).toBe('auto')
  })

  it('shows English on an English system and French on a French one', () => {
    const settings = defaultSettings()
    expect(resolveLanguage(settings, 'en-US')).toBe('en')
    expect(resolveLanguage(settings, 'fr-FR')).toBe('fr')
  })
})
