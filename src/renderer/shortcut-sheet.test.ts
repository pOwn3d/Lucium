// The sheet « Créer un raccourci pour ce site » (ShortcutSheet.tsx), drawn with no window on a snapshot: what it says about a keyword it cannot
// take, in the language of the interface, and what it draws and saves around the first snapshot. It adds one search to the searches of the
// person, which it reads in the snapshot: until the first snapshot has come it knows none of them and draws nothing, so that nothing can be
// saved over a list it has not read.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguage, setLanguage } from '@shared/i18n'
import { frenchSpaces } from '@shared/french-typography'
import { siteSearchProblemText, type SiteSearchProblem } from '@shared/site-search'
import sheetSource from './ShortcutSheet.tsx?raw'
import helpCss from './shortcut-help.css?raw'
import settingsSource from './SearchSettings.tsx?raw'
import { defaultSettings, type Settings, type SidebarState, type SiteSearch } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { elementsOf } from './render.test-support'

// As the real `useSnapshot` does: the language of the settings is set while the view renders, long after the modules were loaded.
const holder = vi.hoisted(() => ({ snapshot: null as { state: { settings: { interfaceTranslated: boolean; language: 'auto' | 'fr' | 'en' } } } | null, sent: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({ dispatch: (action: unknown) => void holder.sent.push(action), closeOverlay: () => undefined }),
  useSnapshot: () => {
    if (holder.snapshot) applyLanguage(holder.snapshot.state.settings, 'en-US')
    return holder.snapshot
  }
}))

import { ShortcutSheet, withShortcut } from './ShortcutSheet'
import { ShortcutHelp } from './ShortcutHelp'

beforeEach(() => {
  setLanguage('fr')
  holder.snapshot = null
  holder.sent.length = 0
})
afterEach(() => setLanguage('fr'))

function snapshotWith(settings: Partial<Settings>): void {
  const state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), ...settings } }
  holder.snapshot = { state } as typeof holder.snapshot
}

function sheet(settings: Partial<Settings>, url: string, title = 'Twitch'): string {
  snapshotWith(settings)
  return renderToStaticMarkup(createElement(ShortcutSheet, { url, title }))
}

/** The text of the line under the fields (the help, or what is wrong). */
const helpLine = (markup: string): string | undefined => /<p [^>]*class="shortcut-help"[^>]*>([^<]*)<\/p>/.exec(markup)?.[1]

const taken = [{ keyword: 'twitch', name: 'Twitch', url: 'https://www.twitch.tv/' }]
const english = { interfaceTranslated: true, language: 'en' as const }
const kept: SiteSearch[] = [{ keyword: 'wiki', name: 'Wikipédia', url: 'https://fr.wikipedia.org/wiki/%s' }]

describe('the sheet of a shortcut for a site', () => {
  it('says what is wrong with the keyword in English when the interface is in English', () => {
    const markup = sheet({ ...english, siteSearches: taken }, 'https://www.twitch.tv/directory')
    expect(helpLine(markup)).toBe('This keyword is already used: pick another one.')
    expect(markup).not.toContain('Ce mot-clé existe déjà')
  })

  it('says them in French when the interface is in French, and the help when nothing is wrong', () => {
    const french = { interfaceTranslated: false }
    expect(helpLine(sheet({ ...french, siteSearches: taken }, 'https://www.twitch.tv/'))).toBe(frenchSpaces('Ce mot-clé existe déjà : choisissez-en un autre.'))
    expect(sheet({ ...english, siteSearches: [] }, 'https://---.example/')).toContain('The keyword must be 1 to 12 letters or digits, with no space.')
    expect(sheet({ ...english, siteSearches: [] }, 'https://www.twitch.tv/')).toContain('Type the keyword in the command bar to open the site directly.')
  })

  it('states a rule the way the Settings do: both forms check a draft with one rule and read its message in one place', () => {
    // The sheet said « des lettres et des chiffres (12 au plus) » and « un site web (https://) » where the Settings said « 1 à 12 lettres ou
    // chiffres, sans espace » and « commencer par https:// et ne pas contenir d’espace », for the same refusal.
    const problems: SiteSearchProblem[] = ['keyword', 'taken', 'name', 'address']
    expect(problems.map(siteSearchProblemText)).toEqual([
      frenchSpaces('Le mot-clé doit faire 1 à 12 lettres ou chiffres, sans espace.'),
      frenchSpaces('Ce mot-clé existe déjà : choisissez-en un autre.'),
      frenchSpaces('Donnez un nom à ce raccourci.'),
      frenchSpaces('L’adresse doit commencer par https:// et ne pas contenir d’espace.')
    ])
    for (const source of [sheetSource, settingsSource]) {
      expect(source).toContain('siteSearchProblemText(problem)')
      expect(source).not.toMatch(/Record<SiteSearchProblem/)
    }
  })

  it('draws nothing before the first snapshot: the shortcuts already there are not known, and saving would replace them all', () => {
    holder.snapshot = null
    expect(renderToStaticMarkup(createElement(ShortcutSheet, { url: 'https://www.twitch.tv/', title: 'Twitch' }))).toBe('')
  })

  // The host puts the focus in a `role="dialog"` and a screen reader says its name: a bare form was neither announced nor named.
  it('is a dialog named by its title', () => {
    const markup = sheet({ interfaceTranslated: false }, 'https://www.twitch.tv/')
    const id = /<form class="shortcut-sheet" role="dialog" aria-labelledby="([^"]+)"/.exec(markup)?.[1]
    expect(id).toBeDefined()
    expect(markup).toContain(`<h3 id="${id}">Raccourci pour ce site</h3>`)
  })

  it('draws its form once the searches are known, and saves the new search after the ones the person has', () => {
    const exemple = () => createElement(ShortcutSheet, { url: 'https://www.exemple.fr/page', title: 'Exemple' })
    snapshotWith({ interfaceTranslated: false, siteSearches: kept })
    expect(renderToStaticMarkup(exemple())).toContain('<form class="shortcut-sheet"')
    const form = elementsOf(exemple()).find((element) => element.type === 'form')!
    ;(form.props['onSubmit'] as (event: unknown) => void)({ preventDefault: () => undefined })
    expect(holder.sent).toEqual([{ type: 'settings/update', patch: { siteSearches: [...kept, { keyword: 'exemple', name: 'Exemple', url: 'https://www.exemple.fr/' }] } }])
  })
})

const draft = { keyword: 'Twitch', name: ' Twitch ', url: 'https://twitch.tv/' }

describe('the list saved by the shortcut sheet', () => {
  it('is the list the user has, with the shortcut at the end', () => {
    const existing = [{ keyword: 'w', name: 'Wikipédia', url: 'https://fr.wikipedia.org/wiki/%s' }]
    expect(withShortcut(existing, draft)).toEqual([...existing, { keyword: 'twitch', name: 'Twitch', url: 'https://twitch.tv/' }])
  })

  it('is not made before the first state: a list of one would replace every search of the user', () => {
    expect(withShortcut(undefined, draft)).toBeNull()
    // An empty list is a known list: the first shortcut of a new profile is saved.
    expect(withShortcut([], draft)).toHaveLength(1)
  })
})

describe('the sheet of the shortcuts (⌘/)', () => {
  // Each of its thirty rows was a stop of Tab that did nothing, before « Modifier » and « Fermer » could be reached again.
  it('stops Tab once on its list, which the arrows scroll, and on none of its rows', () => {
    snapshotWith({ interfaceTranslated: false })
    const markup = renderToStaticMarkup(createElement(ShortcutHelp))
    const title = /<h2 id="([^"]+)">Raccourcis clavier<\/h2>/.exec(markup)?.[1]
    expect(title).toBeDefined()
    expect(markup).toContain(`<div class="sk-cols" tabindex="0" role="group" aria-labelledby="${title}">`)
    expect(markup.match(/<li class="sk-row[^"]*"/g)!.length).toBeGreaterThan(20)
    expect(markup).not.toMatch(/<li class="sk-row[^"]*" tabindex/)
  })
  it('draws the second shortcut of a command after the first, the word « ou » between them, in both languages', () => {
    const rowOf = (markup: string, label: string): string => markup.split('<li class="sk-row').find((row) => row.includes(`>${label}<`)) ?? ''
    snapshotWith({ interfaceTranslated: false })
    const french = renderToStaticMarkup(createElement(ShortcutHelp))
    expect(rowOf(french, 'Page précédente')).toContain('<span class="sk-keys"><kbd class="tk-kbd">⌘[</kbd></span><span class="sk-or">ou</span><span class="sk-keys sk-also"><kbd class="tk-kbd">⌃⌘←</kbd></span>')
    expect(rowOf(french, 'Aller à l’espace 1 à 9')).toContain('<span class="sk-or">ou</span><span class="sk-keys sk-also"><kbd class="tk-kbd">⌃⌘1</kbd><span class="sk-gap">…</span><kbd class="tk-kbd">⌃⌘9</kbd></span>')
    expect(french.match(/class="sk-or"/g)).toHaveLength(5)
    // A command with one shortcut has no second group of keys.
    expect(rowOf(french, 'Afficher l’historique')).not.toContain('sk-also')
    snapshotWith(english)
    expect(renderToStaticMarkup(createElement(ShortcutHelp))).toContain('<span class="sk-or">or</span>')
    // The second keys of a row the user changed are not drawn as changed: only the first ones are.
    snapshotWith({ interfaceTranslated: false, keyBindings: { back: 'CmdOrCtrl+Alt+Shift+K' } })
    expect(rowOf(renderToStaticMarkup(createElement(ShortcutHelp)), 'Page précédente')).toContain('<span class="sk-keys sk-also"><kbd class="tk-kbd">⌃⌘←</kbd></span>')
    expect(helpCss).toMatch(/\.sk-row\.custom \.sk-keys:not\(\.sk-also\) \.tk-kbd \{/)
  })
})

describe('what is wrong with a shortcut, for a screen reader', () => {
  const part = (markup: string, pattern: RegExp): string => pattern.exec(markup)?.[0] ?? ''
  const fields = (markup: string): string[] => [...markup.matchAll(/<input [^>]*>/g)].map((match) => match[0])

  it('is an alert tied to the field it is about and to the button it switches off', () => {
    const markup = sheet({ siteSearches: taken }, 'https://www.twitch.tv/')
    const line = part(markup, /<p [^>]*class="shortcut-help"[^>]*>/)
    const id = /id="([^"]+)"/.exec(line)?.[1]
    expect(id).toBeTruthy()
    expect(line).toContain('role="alert"')
    const [keyword, name, address] = fields(markup)
    expect(keyword).toContain('aria-invalid="true"')
    expect(keyword).toContain(`aria-describedby="${id}"`)
    expect(name).not.toContain('aria-invalid')
    expect(address).not.toContain('aria-describedby')
    expect(part(markup, /<button type="submit"[^>]*>/)).toContain(`aria-describedby="${id}"`)
  })

  it('marks the address when the address is what is wrong', () => {
    const [keyword, , address] = fields(sheet({ siteSearches: [] }, 'ftp://twitch.tv/'))
    expect(keyword).not.toContain('aria-invalid')
    expect(address).toContain('aria-invalid="true"')
  })

  it('is not an alert, and marks nothing, while the line is the help', () => {
    const markup = sheet({ siteSearches: [] }, 'https://www.twitch.tv/')
    expect(part(markup, /<p [^>]*class="shortcut-help"[^>]*>/)).not.toContain('role=')
    expect(markup).not.toContain('aria-invalid')
    expect(part(markup, /<button type="submit"[^>]*>/)).not.toContain('aria-describedby')
  })
})
