// The Shortcuts pane tells a clash in words, not only in a colour, and names the command it clashes with; its search box offers an example that finds
// something. The pane is rendered to markup (no window): what is checked is what a person, or a screen reader, would get.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { commandLabel } from '@shared/shortcut-view'
import { ShortcutNotice, ShortcutsPane } from './SettingsShortcuts'
import { frenchSpaces } from '@shared/french-typography'

afterEach(() => setLanguage('fr'))

const pane = (bindings: Record<string, string>): string => renderToStaticMarkup(createElement(ShortcutsPane, { bindings, platform: 'darwin', update: () => undefined }))

/** The markup of the row of a command (the rows are `<div class="shortcut-row …">…</div>` with no row inside a row). */
const rowOf = (markup: string, label: string): string => {
  const row = markup.split('<div class="shortcut-row').find((part) => part.includes(`>${label}<`))
  if (!row) throw new Error(`no row for ${label}`)
  return row
}

describe('a shortcut that two commands share', () => {
  it('shows nothing about a clash when there is none (the default shortcuts do not clash)', () => {
    const markup = pane({})
    expect(markup).not.toContain('shortcut-clash-note')
    expect(markup).not.toContain('has-clash')
    // The only notes a key names are about what sites or macOS do with the same press, which are not clashes (the rows of the settings
    // above the list have descriptions of their own: their hints).
    for (const [, described] of markup.matchAll(/<button class="shortcut-key[^>]*aria-describedby="([^"]+)"/g)) expect(described).toMatch(/^shortcut-use-/)
  })

  it('writes under each of the two commands the name of the other', () => {
    // "Nouvelle fenêtre" has been given ⌘T, which "Nouvel onglet…" has by default.
    const markup = pane({ newWindow: 'CmdOrCtrl+T' })
    expect(rowOf(markup, commandLabel('newWindow'))).toContain(frenchSpaces(`En conflit avec « ${commandLabel('newTab')} »`))
    expect(rowOf(markup, commandLabel('newTab'))).toContain(frenchSpaces(`En conflit avec « ${commandLabel('newWindow')} »`))
    expect(markup.match(/class="shortcut-clash-note"/g)).toHaveLength(2)
    // The row grows to hold the line (the other rows keep their 48 px).
    expect(markup.match(/class="shortcut-row has-clash"/g)).toHaveLength(2)
  })

  it('gives the key a description a screen reader reads: the note, linked by its id', () => {
    const markup = pane({ newWindow: 'CmdOrCtrl+T' })
    for (const id of ['newWindow', 'newTab']) {
      const row = rowOf(markup, commandLabel(id))
      const described = /aria-describedby="([^"]+)"/.exec(row)?.[1]
      expect(described, `the key of ${id} has no description`).toBeDefined()
      expect(row).toContain(`id="${described}"`)
      expect(new RegExp(`id="${described}">En conflit avec`).test(row)).toBe(true)
    }
    // The ids are those of a row, so that the same command shown twice would not share one.
    const ids = [...markup.matchAll(/id="(shortcut-clash-[^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('names every other command when three share the shortcut', () => {
    const markup = pane({ newWindow: 'CmdOrCtrl+T', privateWindow: 'CmdOrCtrl+T' })
    const row = rowOf(markup, commandLabel('newTab'))
    expect(row).toContain(frenchSpaces(`« ${commandLabel('newWindow')} », « ${commandLabel('privateWindow')} »`))
    expect(markup.match(/class="shortcut-clash-note"/g)).toHaveLength(3)
  })

  it('writes the note in English with English quotes', () => {
    setLanguage('en')
    const markup = pane({ newWindow: 'CmdOrCtrl+T' })
    expect(rowOf(markup, commandLabel('newWindow'))).toContain(`Conflicts with “${commandLabel('newTab')}”`)
  })

  it('keeps the colour and the "clash" state on the key, which is what the sighted see first', () => {
    expect(pane({ newWindow: 'CmdOrCtrl+T' }).match(/shortcut-key [^"]*clash/g)).toHaveLength(2)
  })
})

describe('a shortcut that something else than a command holds', () => {
  it('writes under the row who holds it too, linked to the key for a screen reader', () => {
    // Saved before the Settings refused it.
    const markup = pane({ newWindow: 'CmdOrCtrl+Q' })
    const row = rowOf(markup, commandLabel('newWindow'))
    expect(row).toContain(frenchSpaces('Aussi le raccourci de « Quitter Lucium » : l’un des deux peut ne pas répondre.'))
    const described = /aria-describedby="([^"]+)"/.exec(row)?.[1]
    expect(described).toMatch(/^shortcut-held-/)
    expect(row).toContain(`id="${described}"`)
    expect(markup.match(/class="shortcut-row has-clash"/g)).toHaveLength(1)
  })

  it('knows the shortcuts the menu gives the commands of the extensions', () => {
    const extensions = [{ id: 'ext', name: 'Lecteur', commands: [{ name: 'save', description: 'Enregistrer l’article', accelerator: 'Shift+Cmd+Y' }] }]
    const markup = renderToStaticMarkup(createElement(ShortcutsPane, { bindings: { newWindow: 'CmdOrCtrl+Shift+Y' }, platform: 'darwin', extensions, update: () => undefined }))
    // The menu leaves the key to the command of Lucium: the note says the extension is the silent one, not that either may be.
    expect(rowOf(markup, commandLabel('newWindow'))).toContain(frenchSpaces('Aussi le raccourci de « Enregistrer l’article (Lecteur) » : cette commande le garde, celle de l’extension ne répond pas.'))
    expect(rowOf(markup, commandLabel('newWindow'))).not.toContain('l’un des deux peut ne pas répondre')
    expect(pane({ newWindow: 'CmdOrCtrl+Shift+Y' })).not.toContain('shortcut-clash-note')
  })
})

describe('a default shortcut that sites, macOS or the keyboard use otherwise', () => {
  const noteOf = (row: string): string => />([^<]*)<\/span>/.exec(row.slice(row.indexOf('class="shortcut-use-note"')))?.[1] ?? ''

  it('says under the row that editors and sites use the same press, and the menus answer first', () => {
    const markup = pane({})
    for (const id of ['clearSiteData', 'downloads', 'notes', 'copyUrl', 'inspectElement', 'shortcutHelp', 'back', 'forward', 'history', 'pin', 'clearToday', 'jumpToSelection', 'findNext']) {
      expect(rowOf(markup, commandLabel(id)), id).toContain('Des éditeurs et des sites utilisent aussi ce raccourci')
    }
  })

  it('says which shortcuts macOS gives another command, and which it keeps for Mission Control', () => {
    const markup = pane({})
    for (const id of ['toggleSidebar', 'stop', 'developerMode']) expect(rowOf(markup, commandLabel(id)), id).toContain('macOS donne d’habitude ce raccourci à une autre commande.')
    for (const id of ['space1', 'space9']) expect(rowOf(markup, commandLabel(id)), id).toContain(frenchSpaces('macOS garde ce raccourci quand « Basculer vers le bureau » est activé'))
  })

  it('says nothing under a shortcut that is the application’s alone, and nothing once the shortcut is changed', () => {
    expect(rowOf(pane({}), commandLabel('newTab'))).not.toContain('shortcut-use-note')
    const changed = pane({ history: 'CmdOrCtrl+Alt+Shift+K' })
    expect(rowOf(changed, commandLabel('history'))).not.toContain('shortcut-use-note')
    expect(rowOf(pane({ history: '' }), commandLabel('history'))).not.toContain('shortcut-use-note')
    expect(rowOf(pane({ clearSiteData: '' }), commandLabel('clearSiteData'))).not.toContain('shortcut-use-note')
  })

  it('says under the row of a command that has a second shortcut which one it is, as long as that one is in force', () => {
    const sentence = (keys: string): string => frenchSpaces(`Cette commande répond aussi à ${keys}, que ce réglage ne déplace pas`)
    const markup = pane({})
    for (const [id, keys] of [['clearSiteData', '⌃⌘X'], ['shortcutHelp', '⌥⌘K'], ['back', '⌃⌘←'], ['forward', '⌃⌘→'], ['space1', '⌃⌘1'], ['space9', '⌃⌘9']] as const) {
      expect(rowOf(markup, commandLabel(id)), id).toContain(sentence(keys))
    }
    expect(rowOf(markup, commandLabel('newTab'))).not.toContain('répond aussi')
    // It stays when the first shortcut is changed, and goes with a command that is switched off or when another command is given that press.
    expect(rowOf(pane({ back: 'CmdOrCtrl+Alt+Shift+K' }), commandLabel('back'))).toContain(sentence('⌃⌘←'))
    expect(rowOf(pane({ back: '' }), commandLabel('back'))).not.toContain('répond aussi')
    expect(rowOf(pane({ history: 'Ctrl+CmdOrCtrl+Left' }), commandLabel('back'))).not.toContain('répond aussi')
  })

  it('links the note to the key for a screen reader, without the colour or the state of a clash', () => {
    const row = rowOf(pane({}), commandLabel('clearSiteData'))
    const described = /aria-describedby="([^"]+)"/.exec(row)?.[1]
    expect(described).toMatch(/^shortcut-use-/)
    expect(row).toContain(`class="shortcut-use-note" id="${described}"`)
    // The note is not part of the name of the command: the label reads the name alone.
    expect(row).toContain(`>${commandLabel('clearSiteData')}</span>`)
    expect(row).not.toContain('has-clash')
    expect(row).not.toMatch(/shortcut-key [^"]*clash/)
  })

  it('says the mini window’s shortcut is held in every application, only while the setting is on', () => {
    const withSetting = renderToStaticMarkup(createElement(ShortcutsPane, { bindings: {}, platform: 'darwin', littleEverywhere: true, update: () => undefined }))
    expect(noteOf(rowOf(withSetting, commandLabel('newLittleArc')))).toContain(frenchSpaces('Tenu dans toutes les applications tant que « Raccourci de la'))
    expect(rowOf(pane({}), commandLabel('newLittleArc'))).not.toContain('shortcut-use-note')
  })

  it('says which shortcuts ask for a key a French keyboard does not give alone', () => {
    // What a French Mac keyboard gives without a modifier, for its punctuation keys.
    const french = { Backquote: '@', Minus: ')', Equal: '-', BracketLeft: '^', BracketRight: '$', Semicolon: 'm', Quote: 'ù', Backslash: '`', IntlBackslash: '<', KeyM: ',', Comma: ';', Period: ':', Slash: '=' }
    const markup = renderToStaticMarkup(createElement(ShortcutsPane, { bindings: {}, platform: 'darwin', keyboard: french, update: () => undefined }))
    expect(noteOf(rowOf(markup, commandLabel('back')))).toContain(frenchSpaces('Sur ce clavier, « [ » ne se tape pas seule'))
    expect(noteOf(rowOf(markup, commandLabel('forward')))).toContain(frenchSpaces('« ] »'))
    expect(noteOf(rowOf(markup, commandLabel('shortcutHelp')))).toContain(frenchSpaces('« / »'))
    // « ; », « , » and « - » are keys of that keyboard: ⌘; ⌘, and ⌘- are as they read.
    for (const id of ['stop', 'settings', 'zoomOut']) expect(rowOf(markup, commandLabel(id)), id).not.toContain('Sur ce clavier')
    // A US keyboard gives them all.
    const us = { BracketLeft: '[', BracketRight: ']', Slash: '/', Semicolon: ';', Comma: ',', Period: '.', Minus: '-', Equal: '=', Quote: "'", Backquote: '`', Backslash: '\\' }
    expect(renderToStaticMarkup(createElement(ShortcutsPane, { bindings: {}, platform: 'darwin', keyboard: us, update: () => undefined }))).not.toContain('Sur ce clavier')
    // Nothing is said while the layout is not known.
    expect(pane({})).not.toContain('Sur ce clavier')
  })

  it('names in the note at the foot the shortcut of the annotation, which takes a key of macOS and cannot be changed', () => {
    expect(pane({})).toContain('⌥⌘M annote la page au lieu de réduire toutes les fenêtres, et ne se change pas.')
    setLanguage('en')
    expect(pane({})).toContain('⌥⌘M annotates the page instead of minimizing all windows, and cannot be changed.')
  })
})

describe('the status line of the pane', () => {
  const content = (notice: Parameters<typeof ShortcutNotice>[0]['notice']): string => renderToStaticMarkup(createElement(ShortcutNotice, { notice, onRemove: () => undefined, onUndo: () => undefined }))

  it('is always there, empty, as a polite live region: a screen reader announces what arrives in it', () => {
    const markup = content(null)
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).not.toContain('<button')
  })

  it('says which commands share the shortcut just assigned, and offers to remove the clash', () => {
    const markup = content({ kind: 'clash', text: '⌘T est utilisé par plusieurs commandes : « A », « B ».' })
    expect(markup).toContain('⌘T est utilisé par plusieurs commandes')
    expect(markup).toContain('Retirer les raccourcis en conflit')
    expect(markup).not.toContain('Annuler le retrait')
  })

  it('says what was removed, and offers to give it back', () => {
    const markup = content({ kind: 'removed', text: '⌘T reste à « A ». Raccourci retiré de « B ».', removed: [] })
    expect(markup).toContain('Raccourci retiré de')
    expect(markup).toContain('Annuler le retrait')
    expect(markup).not.toContain('Retirer les raccourcis en conflit')
  })

  it('says whose a refused shortcut is, with nothing to press: nothing was saved', () => {
    const markup = content({ kind: 'refused', text: '⌘Q est déjà le raccourci de « Quitter Lucium », qui ne se change pas ici.' })
    expect(markup).toContain('⌘Q est déjà le raccourci de « Quitter Lucium »')
    expect(markup).not.toContain('<button')
  })

  it('is in the pane, under the text of the aside', () => {
    const markup = pane({})
    expect(markup.indexOf('role="status"')).toBeGreaterThan(markup.indexOf('Modifiez les raccourcis'))
    expect(markup.indexOf('role="status"')).toBeLessThan(markup.indexOf('Tout réinitialiser'))
  })
})

describe('the search box', () => {
  it('offers an example that finds something, in French and in English', () => {
    expect(pane({})).toContain(frenchSpaces('placeholder="Saisissez une commande ou un raccourci (comme « Commande T »)"'))
    setLanguage('en')
    expect(pane({})).toContain('placeholder="Enter a command or a shortcut (like “Command T”)"')
  })
})
