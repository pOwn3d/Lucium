// The pair the panel « Traduire cette page » shows, and the sentence it says under it (shownPair, pairNote): opened from the menu of a page, it must start on a
// pair that can be translated, and say why when the person leaves it on one that cannot (0.2.14: French into French, the button greyed, and no word to say why).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { Detection, TranslateView } from '@shared/translate-local'

vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => null }))
import { pairNote, shownPair } from './TranslatePanel'
import { frenchSpaces } from '@shared/french-typography'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {} })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

type PairView = Pick<TranslateView, 'page' | 'proposed' | 'target'>
const view = (over: { detection?: Partial<Detection>; proposed?: { from: string; to: string } | null; target?: string } = {}): PairView => ({
  page: { host: 'exemple.org', detection: { language: 'fr', source: 'text', confidence: 1, ...over.detection } },
  proposed: over.proposed === undefined ? { from: 'fr', to: 'en' } : over.proposed,
  target: over.target ?? 'fr'
})

describe('the pair the panel shows', () => {
  it('starts from the pair the main process proposes for the page, not from the page language and the target, which can be the same', () => {
    expect(shownPair(view(), '', '')).toEqual({ source: 'fr', target: 'en' })
    expect(shownPair(view({ proposed: { from: 'en', to: 'fr' }, detection: { declared: 'en' } }), '', '')).toEqual({ source: 'en', target: 'fr' })
  })

  it('is what the person chose, each side on its own', () => {
    expect(shownPair(view(), 'de', '')).toEqual({ source: 'de', target: 'en' })
    expect(shownPair(view(), '', 'es')).toEqual({ source: 'fr', target: 'es' })
    expect(shownPair(view(), 'de', 'es')).toEqual({ source: 'de', target: 'es' })
  })

  it('falls back to what was recognised and to the language of the settings when nothing is proposed', () => {
    expect(shownPair(view({ proposed: null }), '', '')).toEqual({ source: 'fr', target: 'fr' })
    expect(shownPair(null, '', '')).toEqual({ source: '', target: '' })
  })
})

describe('the sentence under the pair', () => {
  it('says why the button cannot be pressed when both sides are the same language', () => {
    expect(pairNote(view(), 'fr', 'fr')).toBe(frenchSpaces('La page et la traduction sont dans la même langue (français) : choisissez-en une autre pour traduire.'))
    setLanguage('en')
    expect(pairNote(view(), 'fr', 'fr')).toBe('The page and the translation are in the same language (French): choose another one to translate.')
  })

  it('says where the proposal comes from when the page says it is in one language and its text is in another', () => {
    const declared = view({ proposed: { from: 'en', to: 'fr' }, detection: { declared: 'en' } })
    expect(pairNote(declared, 'en', 'fr')).toBe('La page se déclare en anglais, mais son texte semble être en français.')
    setLanguage('en')
    expect(pairNote(declared, 'en', 'fr')).toBe('The page says it is in English, but its text seems to be in French.')
  })

  it('says that a page already in the language of the settings is offered another target', () => {
    expect(pairNote(view(), 'fr', 'en')).toBe(frenchSpaces('Cette page semble déjà être en français : la traduction est proposée vers une autre langue.'))
  })

  it('says nothing when the pair speaks for itself, or when the person has chosen another one', () => {
    expect(pairNote(view({ proposed: { from: 'en', to: 'fr' }, detection: { language: 'en', source: 'text' } }), 'en', 'fr')).toBeNull()
    expect(pairNote(view(), 'fr', 'de')).toBeNull()
    expect(pairNote(view({ proposed: null }), '', '')).toBeNull()
    expect(pairNote(null, '', '')).toBeNull()
  })
})
