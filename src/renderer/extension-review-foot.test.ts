// The foot of the sheet that reviews an extension holds up to two sentences: the profile it goes to, and the facultative permissions it may
// ask for later. The space between them was the last character of the first text in the catalogues, so a translation that dropped it glued the two
// sentences. The sheet joins them itself; drawn here for real, with its channel replaced.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'
import type { ExtensionReviewRequest } from '@shared/extension-review'

vi.mock('./api', () => ({ api: () => ({ answerExtensionReview: () => undefined }) }))

import { ExtensionReview } from './ExtensionReview'

afterEach(() => setLanguage('fr'))

const request = (mode: 'install' | 'update' | 'optional', optionalCount: number): ExtensionReviewRequest => ({
  id: 'r1',
  mode,
  extensionId: 'a'.repeat(32),
  profile: 'Perso',
  review: { name: 'Exemple', version: '1.0', description: '', permissions: [], sites: { scope: 'none' } as ExtensionReviewRequest['review']['sites'], optionalCount, broad: false, warning: '' }
})

/** The text of the foot, with ordinary spaces in place of the non-breaking ones the French typography puts in. */
function foot(mode: 'install' | 'update' | 'optional', optionalCount: number): string {
  const markup = renderToStaticMarkup(createElement(ExtensionReview, { request: request(mode, optionalCount) }))
  const found = /<p class="ext-foot">([\s\S]*?)<\/p>/.exec(markup)
  expect(found, markup).not.toBeNull()
  return found![1]!.replaceAll(' ', ' ').replaceAll(' ', ' ')
}

describe('the foot of the extension review', () => {
  it('puts one space between its two sentences, and none after the last', () => {
    expect(foot('install', 2)).toBe('Elle sera installée dans le profil « Perso » seulement : elle ne s’exécutera pas dans vos autres profils. 2 autorisations facultatives : l’extension pourra les demander plus tard, et Lucium vous posera la question.')
    expect(foot('install', 0)).toBe('Elle sera installée dans le profil « Perso » seulement : elle ne s’exécutera pas dans vos autres profils.')
    expect(foot('update', 1)).toBe('1 autorisation facultative : l’extension pourra la demander plus tard, et Lucium vous posera la question.')
    expect(foot('update', 0)).toBe('')
    setLanguage('en')
    expect(foot('install', 1)).toBe('It will be installed in the profile “Perso” only: it won’t run in your other profiles. 1 optional permission: the extension may ask for it later, and Lucium will ask you.')
  })

  it('says, for a permission an installed extension asks for, the profile it will hold for and where it is taken back, and never the store nor an installation', () => {
    expect(foot('optional', 0)).toBe('L’autorisation vaudra pour le profil « Perso » seulement. Vous pourrez la retirer dans la page Extensions.')
    const markup = renderToStaticMarkup(createElement(ExtensionReview, { request: request('optional', 0) })).replaceAll('\u00a0', ' ').replaceAll('\u202f', ' ')
    expect(markup).toContain('Accorder ce que « Exemple » demande ?')
    expect(markup).toContain('Cette extension demande, en plus de ce qu’elle a déjà :')
    expect(markup).toContain('<p class="ext-sub">Version 1.0</p>')
    expect(markup).toMatch(/<button[^>]*adlg-confirm[^>]*>Autoriser<\/button>/)
    expect(markup).not.toContain('Chrome Web Store')
    expect(markup).not.toContain('Ajouter')
    setLanguage('en')
    expect(foot('optional', 0)).toBe('The permission will apply to the profile “Perso” only. You can take it back on the Extensions page.')
  })

  it('reads no joining space from the catalogues: the text of the profile ends with its full stop', () => {
    for (const catalogue of [fr, en]) expect(catalogue['extension-review.elle-sera-installee-dans-le-profil-profile']).toMatch(/\.$/)
  })
})
