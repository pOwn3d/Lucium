import { describe, expect, it } from 'vitest'
import { clearHistoryPrompt, eraseFailureText, historyOwnerLine } from './history-scope'
import { setLanguage } from './i18n'
import { createInitialState, reduce, type Action } from './sidebar'
import { frenchSpaces } from './french-typography'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

describe('whose history it is', () => {
  const single = createInitialState(ctx)
  const several = run(single, { type: 'space/create', name: 'Pro', emoji: '💼', hue: 10, profileName: 'Travail' })

  it('says nothing while there is one profile, and names the profile once there are several', () => {
    expect(historyOwnerLine(single, 'default')).toBeNull()
    expect(historyOwnerLine(several, 'default')).toBe(frenchSpaces('Profil « Profil par défaut »'))
    expect(historyOwnerLine(several, 'travail')).toBe(frenchSpaces('Profil « Travail »'))
  })

  it('keeps the usual question with one profile, in the singular and the plural', () => {
    expect(clearHistoryPrompt(single, 'default', 12)).toEqual({ message: frenchSpaces('Effacer tout l’historique de navigation ?'), detail: '12 pages seront oubliées. Les onglets ouverts ne changent pas.' })
    expect(clearHistoryPrompt(single, 'default', 1).detail).toBe('1 page sera oubliée. Les onglets ouverts ne changent pas.')
    expect(clearHistoryPrompt(single, 'default', 0).detail).toBe('0 page sera oubliée. Les onglets ouverts ne changent pas.')
  })

  it('asks about the profile alone once there are several, and says the others stay', () => {
    const prompt = clearHistoryPrompt(several, 'travail', 3)
    expect(prompt.message).toBe(frenchSpaces('Effacer l’historique du profil « Travail » ?'))
    expect(prompt.detail).toBe('3 pages seront oubliées. L’historique des autres profils ne change pas, et les onglets ouverts non plus.')
  })

  it('asks in English with the English plural: no page is "0 pages", one is "1 page"', () => {
    try {
      setLanguage('en')
      expect(clearHistoryPrompt(single, 'default', 0).detail).toBe('0 pages will be forgotten. Open tabs don’t change.')
      expect(clearHistoryPrompt(single, 'default', 1).detail).toBe('1 page will be forgotten. Open tabs don’t change.')
      expect(clearHistoryPrompt(several, 'travail', 3)).toEqual({
        message: 'Clear the history of the profile “Travail”?',
        detail: '3 pages will be forgotten. The history of the other profiles doesn’t change, and neither do open tabs.'
      })
      expect(historyOwnerLine(several, 'travail')).toBe('Profile “Travail”')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('the failure of an erasure, as the Profiles pane tells it', () => {
  it('keeps the sentence of the main process and drops what IPC put in front of it', () => {
    const error = new Error("Error invoking remote method 'lucium:clear-profile': Error: Impossible d’effacer l’historique de ce profil.")
    expect(eraseFailureText(error)).toBe('Impossible d’effacer l’historique de ce profil.')
    expect(eraseFailureText('déjà une phrase')).toBe('déjà une phrase')
  })

  it('never answers an empty or endless message', () => {
    expect(eraseFailureText(new Error(''))).toBe('L’effacement a échoué.')
    expect(eraseFailureText(new Error('x'.repeat(1000)))).toHaveLength(300)
  })
})
