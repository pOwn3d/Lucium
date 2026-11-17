import { afterEach, describe, expect, it } from 'vitest'
import { frenchSpaces } from './french-typography'
import { setLanguage } from './i18n'
import { categoryOfKey } from './settings-catalog'
import { answerMenu, answerText, SETTINGS_ANSWERS, settingsAnswer } from './settings-answers'
import { foldText } from './settings-search'

afterEach(() => setLanguage('fr'))

describe('the answers of the search for what is not a setting', () => {
  it('answer what Lucium does not have, and the commands of the menus, in French and in English', () => {
    const id = (query: string) => settingsAnswer(query)?.id ?? null
    expect(id('page d’accueil')).toBe('homepage')
    expect(id('homepage')).toBe('homepage')
    expect(id('nouvel onglet')).toBe('new-tab')
    expect(id('new tab')).toBe('new-tab')
    expect(id('police')).toBe('font')
    expect(id('font')).toBe('font')
    expect(id('importer')).toBe('import')
    expect(id('importer mes favoris')).toBe('import')
    expect(id('navigateur par défaut')).toBe('default-browser')
    expect(id('rouvrir un onglet fermé')).toBe('reopen-closed')
    expect(id('imprimer')).toBe('print')
    expect(id('caméra')).toBe('camera')
  })

  it('stay silent for what is a setting, and for what means something else', () => {
    for (const query of ['mode sombre', 'cookies', 'proxy', 'langue', 'raccourci', 'rouvrir les onglets', 'onglets', 'page', 'veille']) expect(settingsAnswer(query), query).toBeNull()
    // « Importer une Retouche » is a row of the Settings, not the import from another browser.
    expect(settingsAnswer('importer une retouche')).toBeNull()
    expect(settingsAnswer('import a tweak')).toBeNull()
  })

  it('wait for four letters of the word being typed: « imp » names nothing yet, « impr » the printing', () => {
    expect(settingsAnswer('imp')).toBeNull()
    expect(settingsAnswer('impr')?.id).toBe('print')
    expect(settingsAnswer('   ')).toBeNull()
  })

  it('say the menu in the language of the interface, and the shortcut as the person has set it', () => {
    const answer = (id: string) => SETTINGS_ANSWERS.find((one) => one.id === id)!
    expect(answerText(answer('import'), {})).toBe(frenchSpaces('L’import depuis un autre navigateur est une commande, pas un réglage : « Lucium › Importer depuis un autre navigateur… ».'))
    expect(answerText(answer('homepage'), {})).toContain('la barre de commandes (⌘T), pour')
    // A shortcut changed in the Settings is the one said; a shortcut taken away leaves nothing behind.
    expect(answerText(answer('homepage'), { newTab: 'CmdOrCtrl+Shift+Y' })).toContain('la barre de commandes (⇧⌘Y), pour')
    expect(answerText(answer('homepage'), { newTab: '' })).toContain('la barre de commandes, pour')
    setLanguage('en')
    expect(answerMenu(answer('import'))).toBe('Lucium › Import from Another Browser…')
    expect(answerText(answer('print'), {})).toBe('Printing is a command: “File › Print…” (⌘P).')
  })

  it('are written folded, name a menu when their sentence does, and open a setting that has a place', () => {
    for (const answer of SETTINGS_ANSWERS) {
      for (const phrase of answer.phrases) expect(foldText(phrase), `${answer.id}: ${phrase}`).toBe(phrase)
      const sentence = answerText(answer, {})
      expect(sentence, answer.id).not.toContain('{')
      expect(answer.menu !== undefined, `${answer.id} names a menu in its sentence`).toBe(answerMenu(answer) !== '' && sentence.includes(answerMenu(answer)))
      if (answer.open) expect(categoryOfKey(answer.open), answer.id).not.toBeNull()
    }
    expect(new Set(SETTINGS_ANSWERS.map((answer) => answer.id)).size).toBe(SETTINGS_ANSWERS.length)
  })
})
