// The language of a window is said on its root (`lang`), not only set for its texts: every page is written with `lang="fr"`, and a screen reader
// reads an English interface with the French voice when the attribute stays. The small windows used to set their language without saying it.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getLanguage, setLanguage } from '@shared/i18n'
import { followLanguage, languageFromAddress, sayLanguage, type LanguageRoot } from './document-language'

const rootOf = (lang: string, attributes: string[] = []): LanguageRoot => ({ lang, hasAttribute: (name) => attributes.includes(name) })

afterEach(() => setLanguage('fr'))

describe('the language said on the root of a window', () => {
  it('follows the settings of the snapshot: the texts and the attribute change together', () => {
    const root = rootOf('fr')
    expect(followLanguage(root, { interfaceTranslated: true, language: 'en' }, 'fr-FR')).toBe('en')
    expect(root.lang).toBe('en')
    expect(getLanguage()).toBe('en')
    followLanguage(root, { interfaceTranslated: true, language: 'fr' }, 'en-US')
    expect(root.lang).toBe('fr')
  })

  it('is read from the address of a small window, and an unknown language is the language of origin', () => {
    const root = rootOf('fr')
    expect(languageFromAddress(root, '?lang=en')).toBe('en')
    expect(root.lang).toBe('en')
    expect(getLanguage()).toBe('en')
    expect(languageFromAddress(root, '?lang=xx')).toBe('fr')
    expect(root.lang).toBe('fr')
    expect(languageFromAddress(root, '')).toBe('fr')
  })

  it('leaves the root of the Settings window alone: its translated parts say their own language', () => {
    const root = rootOf('fr', ['data-lang-parts'])
    sayLanguage(root, 'en')
    expect(root.lang).toBe('fr')
  })

  // Guard: a window that sets its language by itself forgets the attribute. This module is the one place of the renderer that sets it.
  it('is set nowhere else in the renderer', () => {
    const folder = __dirname
    const elsewhere = readdirSync(folder)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'document-language.ts')
      .filter((name) => /\b(?:setLanguage|applyLanguage)\(/.test(readFileSync(join(folder, name), 'utf8')))
    expect(elsewhere).toEqual([])
  })

  it('starts from a page written in French: each page of the renderer says so, and its script corrects it', () => {
    const pages = readdirSync(__dirname).filter((name) => name.endsWith('.html'))
    expect(pages.length).toBeGreaterThan(5)
    for (const page of pages) expect(readFileSync(join(__dirname, page), 'utf8'), page).toMatch(/<html[^>]*\blang="fr"/)
  })
})
