// The sentences of the navigation area that were once written in French in the code: in English they must come from the catalogue,
// whatever the count, as every other sentence of the interface does. Each check reads the text in English and refuses any French word.

import { afterEach, describe, expect, it } from 'vitest'
import { zapDone, zapHint, zapScript, zapStopName } from './boost'

const STOP = zapStopName(() => new Uint8Array(12))
import { authRequestOf, authText } from './http-auth'
import { setLanguage } from './i18n'
import { readerDocument, readerUnavailableNotice } from './reader'
import { deadTabsNotice, reloadAllNotice } from './reload-all'
import { sleepToastAction, sleepToastMessage } from './sleep'

const FRENCH = /onglet|réveill|actualis|laiss|répond|saisie|chiffr|connexion|Échap|Terminé|Cliquez|éléments/i

afterEach(() => setLanguage('fr'))

describe('the notices and labels of navigation in English', () => {
  it('say how many tabs were put to sleep, and the button that wakes one', () => {
    setLanguage('en')
    expect(sleepToastMessage(1)).toBe('Tab put to sleep')
    expect(sleepToastMessage(3)).toBe('3 tabs put to sleep')
    expect(sleepToastAction()).toBe('Wake up')
    // A frozen tab is not asleep: it stays in memory, and what brings it back is thawing.
    expect(sleepToastMessage(1, true)).toBe('Tab frozen')
    expect(sleepToastMessage(3, true)).toBe('3 tabs frozen')
    expect(sleepToastAction(true)).toBe('Unfreeze')
  })

  it('say what "Actualiser tous les onglets" did, for one tab, several, those woken and those left alone', () => {
    setLanguage('en')
    const sentences = [reloadAllNotice(1, 0), reloadAllNotice(12, 0), reloadAllNotice(0, 0), reloadAllNotice(4, 0, 3), reloadAllNotice(2, 0, 1), reloadAllNotice(3, 1, 2), reloadAllNotice(5, 1), reloadAllNotice(0, 1), deadTabsNotice(1), deadTabsNotice(3)]
    for (const sentence of sentences) expect(sentence, sentence).not.toMatch(FRENCH)
    expect(reloadAllNotice(1, 0)).toBe('1 tab reloaded')
    expect(reloadAllNotice(2, 0, 1)).toBe('3 tabs reloaded, 1 of them woken up')
    expect(reloadAllNotice(5, 1)).toBe('5 tabs reloaded, 1 left as it is (typing in progress)')
    expect(deadTabsNotice(1)).toBe('1 site no longer responds')
  })

  it('keep their French wording in French', () => {
    expect(reloadAllNotice(2, 0, 1)).toBe('3 onglets actualisés, dont 1 réveillé')
    expect(reloadAllNotice(2, 0, 2)).toBe('4 onglets actualisés, dont 2 réveillés')
    expect(sleepToastAction()).toBe('Réveiller')
    expect(sleepToastMessage(1, true)).toBe('Onglet gelé')
    expect(sleepToastMessage(3, true)).toBe('3 onglets gelés')
    expect(sleepToastAction(true)).toBe('Dégeler')
  })

  it('tell reader mode has no article, and how to leave the article', () => {
    setLanguage('en')
    expect(readerUnavailableNotice()).toBe('This page has no article to show in reader mode.')
    const html = readerDocument({ title: 'T', content: '<p>x</p>', byline: null, siteName: null, lang: 'en', dir: null, textLength: 1200 } as never, 'https://example.com/a')
    expect(html).toContain('Esc to exit')
    expect(html).not.toContain('Échap')
  })

  it('warn that a password sent over http can be read, in the sheet of the sign-in', () => {
    setLanguage('en')
    const warning = authText(authRequestOf('1', { host: 'example.com', port: 80, scheme: 'basic', realm: '', isProxy: false, url: 'http://example.com/' })).warning
    expect(warning).toBeDefined()
    expect(warning).not.toMatch(FRENCH)
  })

  it('put the hint and the button of Eraser mode in the language of the interface, without breaking the script they sit in', () => {
    setLanguage('en')
    expect(zapHint()).not.toMatch(FRENCH)
    expect(zapDone()).toBe('Done')
    const script = zapScript(STOP)
    expect(script).toContain('<b>erase</b>')
    expect(script).not.toMatch(FRENCH)
    expect(() => new Function(`return ${script}`)).not.toThrow()
    // The verb of the hint is set in bold in French too.
    setLanguage('fr')
    expect(zapScript(STOP)).toContain('<b>gommer</b>')
  })
})
