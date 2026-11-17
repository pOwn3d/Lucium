// The panel of the quick notes, rendered to markup (no window, as templates.test.ts does): what a person finds on screen, in its order
// (this page, this space, then the others), what the list shows (« Cette page », « Cet espace », « Toutes »), every action named, the editor's field (a rich text field) and choices labelled, a row showing its note as
// plain text, and the text of a note never read as HTML; the toolbar above the field (named buttons, one tab stop, their state), « Partager » and the
// menu « ⋯ » with its entries. What the field draws inside itself is note-editor-dom.test.ts's.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Note } from '@shared/notes'
import { menuKeyAction, NoteMoreMenu, noteMenuItems, NotesView, type NoteFileActions, type NotesViewProps } from './NotesPanel'
import { typedLinkAddress } from './NoteTextEditor'
import { frenchSpaces } from '@shared/french-typography'

const noop = (): void => undefined
const PAGE = 'https://example.org/article'
const NOTES: Note[] = [
  { id: 'p', text: '# Idée\nrelire **la fin**', createdAt: 1, updatedAt: 3, link: { kind: 'page', url: PAGE } },
  { id: 's', text: 'Ordre du jour', createdAt: 1, updatedAt: 2, link: { kind: 'space', spaceId: 's1' } },
  { id: 'o', text: 'Sans lieu', createdAt: 1, updatedAt: 1 }
]
const SPACES = [{ id: 's1', name: 'Travail', emoji: '💼' }]

const view = (props: Partial<NotesViewProps> = {}): string =>
  renderToStaticMarkup(
    createElement(NotesView, {
      notes: NOTES,
      context: { pageUrl: PAGE, spaceId: 's1' },
      onScope: noop,
      spaces: SPACES,
      query: '',
      onQuery: noop,
      hidden: new Set<string>(),
      draft: null,
      onDraft: noop,
      onSave: noop,
      onRemove: noop,
      onOpenPage: noop,
      message: '',
      busy: false,
      undo: null,
      onDone: noop,
      now: 10_000,
      ...props
    })
  )

/** Every button of a markup has a name: its text, or an aria-label. */
const unnamedButtons = (markup: string): string[] =>
  [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs!) && inner!.replace(/<[^>]*>/g, '').trim() === '').map(([whole]) => whole.slice(0, 80))

describe('the notes panel', () => {
  it('is a dialog named "Notes", with a labelled search and the count of the notes it shows', () => {
    const markup = view({ scope: 'all' })
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain('>Notes<span class="lp-count">3</span></h2>')
    expect(view()).toContain('>Notes<span class="lp-count">1</span></h2>')
    expect(markup).toContain('aria-label="Rechercher dans les notes"')
  })

  it('shows this page first, then this space, then the others under « Toutes », each named as a group', () => {
    const markup = view({ scope: 'all' })
    const at = (text: string) => markup.indexOf(text)
    expect(at('>Cette page</h3>')).toBeGreaterThan(-1)
    expect(at('>Cette page</h3>')).toBeLessThan(at('>Cet espace</h3>'))
    expect(at('>Cet espace</h3>')).toBeLessThan(at('>Autres notes</h3>'))
    expect(at('Idée')).toBeLessThan(at('Ordre du jour'))
    expect(at('Ordre du jour')).toBeLessThan(at('Sans lieu'))
    // Where each note belongs is said under its title.
    expect(markup).toContain(frenchSpaces('Page : example.org'))
    expect(markup).toContain(frenchSpaces('Espace : Travail'))
    expect(markup).toContain('Sans lien')
  })

  it('calls the third group "Toutes les notes" when nothing belongs to the page or the space on screen', () => {
    expect(view({ context: { pageUrl: null, spaceId: null } })).toContain('>Toutes les notes</h3>')
  })

  it('names every action, with the note it acts on', () => {
    const markup = view({ scope: 'all' })
    expect(unnamedButtons(markup)).toEqual([])
    expect(markup).toContain(frenchSpaces('aria-label="Supprimer la note « Idée »"'))
    expect(markup).toContain(frenchSpaces('aria-label="Ouvrir la page de « Idée »"'))
    // A note of no page has nothing to open.
    expect(markup).not.toContain('Ouvrir la page de « Sans lieu »')
  })

  it('leaves out a note being deleted, and offers to take the deletion back', () => {
    const markup = view({ scope: 'all', hidden: new Set(['s']), undo: { message: frenchSpaces('Note supprimée : Ordre du jour'), onUndo: noop } })
    expect(markup).not.toContain('>Ordre du jour<')
    expect(markup).toContain('<span class="lp-count">2</span>')
    expect(markup).toMatch(/class="lp-undo" role="status"><span>Note supprimée\u00a0: Ordre du jour<\/span>/)
  })

  it('writes a note in a labelled rich text field, with its hint and its count, and the link as a group of choices', () => {
    const markup = view({ draft: { id: null, text: '# Titre\n- **un**', link: { kind: 'page', url: PAGE } } })
    expect(markup).toMatch(/<form class="notes-editor" aria-label="Nouvelle note">/)
    const label = /<span class="notes-label" id="([^"]+)">Texte de la note<\/span>/.exec(markup)
    expect(label).not.toBeNull()
    // A text field of several lines, named by its label and described by the hint (the Markdown it reads, the keys) and the count.
    const field = /<div id="[^"]+" class="tk-field notes-text nm-editor"([^>]*)><\/div>/.exec(markup)
    expect(field).not.toBeNull()
    const attributes = field![1]!
    expect(attributes).toContain('role="textbox"')
    expect(attributes).toContain('aria-multiline="true"')
    expect(attributes).toContain(`aria-labelledby="${label![1]}"`)
    // Text only: the browser itself never puts HTML in it (React writes the attribute in camel case; HTML reads it whatever its case).
    expect(attributes).toContain('contentEditable="plaintext-only"')
    expect(attributes).toContain('aria-placeholder="Écrire une note…"')
    const described = /aria-describedby="([^"]+)"/.exec(attributes)![1]!.split(' ')
    expect(described).toHaveLength(2)
    expect(markup).toContain(frenchSpaces(`<span id="${described[0]}">Le texte se met en forme pendant la frappe, et s’écrit aussi en Markdown : # titre`))
    expect(markup).toContain(`<span id="${described[1]}">16 / 4000 caractères</span>`)
    expect(markup).not.toContain('<textarea')
    expect(markup).toContain('<legend>Liée à</legend>')
    expect([...markup.matchAll(/type="radio"/g)]).toHaveLength(3)
    expect(markup).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span>Page\u00a0: example.org<\/span>/)
    // The field is the look of the note: there is no preview beside it any more.
    expect(markup).not.toContain('aria-label="Aperçu"')
    expect(unnamedButtons(markup)).toEqual([])
  })

  it('edits a note in the editor only: its row is not shown twice', () => {
    const markup = view({ draft: { id: 's', text: 'Ordre du jour', link: { kind: 'space', spaceId: 's1' } } })
    expect(markup).toContain('aria-label="Modifier la note"')
    expect(markup).not.toContain('aria-label="Supprimer la note « Ordre du jour »"')
  })

  it('says what it is for when there is no note, with the way to write one', () => {
    const markup = view({ notes: [] })
    expect(markup).toContain('Aucune note')
    expect(markup).toContain('Une note reste sur ce Mac')
    expect(view({ notes: null })).toContain('aria-busy="true"')
  })

  it('puts the focus on writing the first note rather than in the search when there is none, and leaves it in the search otherwise', () => {
    // The search is drawn first (and focused as the panel opens); the button that comes with the empty list takes the focus after it.
    expect(view({ notes: [] })).toMatch(/<button type="button" class="tk-btn primary" autofocus="">Nouvelle note<\/button>/)
    expect(view()).not.toMatch(/<button[^>]*autofocus/)
    // A note being deleted still counts as gone: the list is empty, the button is there.
    expect(view({ notes: [NOTES[2]!], hidden: new Set(['o']) })).toMatch(/<button[^>]*autofocus="">Nouvelle note/)
  })

  it('opens "Nouvelle note" on an empty note tied to the page on screen, the cursor in its field', () => {
    const markup = view({ notes: [], draft: { id: null, text: '', link: { kind: 'page', url: PAGE } } })
    expect(markup).toMatch(/<form class="notes-editor" aria-label="Nouvelle note">/)
    expect(markup).toMatch(/<div id="[^"]+" class="tk-field notes-text nm-editor" role="textbox"/)
    expect(markup).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span>Page\u00a0: example.org<\/span>/)
    // Nothing to save yet, and the empty list is not drawn under the editor.
    expect(markup).toMatch(/<button type="submit" class="tk-btn primary" disabled="">/)
    expect(markup).not.toContain('Aucune note')
  })

  it('says when no note answers the search', () => {
    expect(view({ query: 'introuvable' })).toContain('Aucune note ne correspond à la recherche.')
  })

  it('shows a note in its row as plain text: its title and its tooltip without the marks of Markdown', () => {
    const markup = view({ notes: [{ id: 'm', text: '# **Courses** du *samedi*\n- [ ] pain\n- [x] lait\nvoir [la liste](https://example.org/l)', createdAt: 1, updatedAt: 1 }] })
    expect(markup).toContain('title="Courses du samedi\n☐ pain\n☑ lait\nvoir la liste"')
    expect(markup).toContain('Courses du samedi</')
    expect(markup).not.toContain('**')
  })

  it('never reads the text of a note as HTML, in its row as in the field', () => {
    const hostile = '<img src=x onerror=alert(1)> **<script>alert(2)</script>**'
    const markup = view({ notes: [{ id: 'h', text: hostile, createdAt: 1, updatedAt: 1 }], draft: { id: null, text: hostile, link: null } })
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('<script')
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // The field draws its text itself, from text nodes (note-editor-dom.ts): the markup holds none of it.
    expect(markup).toMatch(/<div id="[^"]+" class="tk-field notes-text nm-editor"[^>]*><\/div>/)
  })
})

/** The choices under the header: their name, whether checked, and whether Tab stops on them. */
const scopes = (markup: string): Array<{ label: string; checked: boolean; tab: string }> =>
  [...markup.matchAll(/<button type="button" class="tk-chip" role="radio" aria-checked="(true|false)" tabindex="(-?\d)" data-scope="\w+">([^<]+)<\/button>/g)].map(([, checked, tab, label]) => ({ label: label!, checked: checked === 'true', tab: tab! }))
/** The titles of the rows, in their order. */
const rowTitles = (markup: string): string[] => [...markup.matchAll(/<span class="lp-title">([^<]*)<\/span>/g)].map(([, title]) => title!)

describe('what the list of the notes panel shows', () => {
  it('is chosen under the header in a named group of radios, one stop of Tab, the page checked when it has notes', () => {
    const markup = view()
    expect(markup).toContain('<div class="lp-filters" role="radiogroup" aria-label="Notes affichées">')
    expect(scopes(markup)).toEqual([
      { label: 'Cette page', checked: true, tab: '0' },
      { label: 'Cet espace', checked: false, tab: '-1' },
      { label: 'Toutes', checked: false, tab: '-1' }
    ])
    // The notes of the page only, under no title of their own: the choice names the list.
    expect(rowTitles(markup)).toEqual(['Idée'])
    expect(markup).not.toContain('<h3>')
  })

  it('opens on every note when the page on screen has none, each row saying what its note is tied to', () => {
    const markup = view({ context: { pageUrl: 'https://example.org/vide', spaceId: 's1' } })
    expect(scopes(markup).filter((scope) => scope.checked).map((scope) => scope.label)).toEqual(['Toutes'])
    expect(markup).toContain('>Notes<span class="lp-count">3</span></h2>')
    // The space first, then the others: the note of another page, the note of no place.
    expect(rowTitles(markup)).toEqual(['Ordre du jour', 'Idée', 'Sans lieu'])
    expect(markup).toContain(frenchSpaces('Page : example.org · '))
    expect(markup).toContain(frenchSpaces('Espace : Travail · '))
    expect(markup).toContain('Sans lien · ')
  })

  it('shows the notes of the space under « Cet espace », and counts them', () => {
    const markup = view({ scope: 'space' })
    expect(scopes(markup).filter((scope) => scope.checked).map((scope) => scope.label)).toEqual(['Cet espace'])
    expect(rowTitles(markup)).toEqual(['Ordre du jour'])
    expect(markup).toContain('>Notes<span class="lp-count">1</span></h2>')
  })

  it('offers every note rather than an empty list when the page or the space chosen has none', () => {
    const page = view({ scope: 'page', notes: [NOTES[1]!, NOTES[2]!] })
    expect(page).toContain('Aucune note sur cette page. <button type="button" class="tk-btn small">Voir toutes les notes</button>')
    expect(page).toContain('>Notes<span class="lp-count">0</span></h2>')
    expect(view({ scope: 'space', notes: [NOTES[0]!, NOTES[2]!] })).toContain('Aucune note dans cet espace. <button type="button" class="tk-btn small">Voir toutes les notes</button>')
    // Every note shown: nothing to offer.
    expect(view({ scope: 'all' })).not.toContain('Voir toutes les notes')
  })

  it('searches the notes chosen, and offers the others when the search finds nothing here but something elsewhere', () => {
    expect(view({ scope: 'page', query: 'lieu' })).toContain('Aucune note ne correspond à la recherche. <button type="button" class="tk-btn small">Voir toutes les notes</button>')
    expect(view({ scope: 'page', query: 'introuvable' })).not.toContain('Voir toutes les notes')
    expect(rowTitles(view({ scope: 'all', query: 'lieu' }))).toEqual(['Sans lieu'])
  })

  it('offers no page when the tab shows no web page, and shows every note when the page chosen is gone', () => {
    expect(scopes(view({ context: { pageUrl: null, spaceId: 's1' } })).map((scope) => scope.label)).toEqual(['Cet espace', 'Toutes'])
    expect(scopes(view({ scope: 'page', context: { pageUrl: null, spaceId: 's1' } })).filter((scope) => scope.checked).map((scope) => scope.label)).toEqual(['Toutes'])
  })

  it('offers no choice while the notes are read, nor when there is none', () => {
    expect(view({ notes: null })).not.toContain('role="radiogroup"')
    expect(view({ notes: [] })).not.toContain('role="radiogroup"')
    expect(view({ notes: [NOTES[0]!], hidden: new Set(['p']) })).not.toContain('role="radiogroup"')
  })
})

const FILES: NoteFileActions = { share: noop, download: noop, copy: noop, importFile: noop, dropFile: noop }

describe('the toolbar of the editor', () => {
  const toolbar = (text: string): string => {
    const markup = view({ draft: { id: null, text, link: null }, files: FILES })
    return /<div class="nm-toolbar"[\s\S]*?<\/div>/.exec(markup)![0]
  }
  const buttons = (markup: string): Array<{ label: string; pressed: string | null; tab: string }> =>
    [...markup.matchAll(/<button type="button" class="nm-tool"([^>]*)>/g)].map(([, attributes]) => ({
      label: /aria-label="([^"]+)"/.exec(attributes!)![1]!,
      pressed: /aria-pressed="(\w+)"/.exec(attributes!)?.[1] ?? null,
      tab: /tabindex="(-?\d)"/.exec(attributes!)![1]!
    }))

  it('is a toolbar named for what it does, that controls the field', () => {
    const markup = view({ draft: { id: null, text: '', link: null }, files: FILES })
    const controls = /<div class="nm-toolbar" role="toolbar" aria-label="Mise en forme" aria-controls="([^"]+)"/.exec(markup)
    expect(controls).not.toBeNull()
    expect(markup).toContain(`<div id="${controls![1]}" class="tk-field notes-text nm-editor"`)
  })

  it('names every button, in the order of the mockup, with one stop of Tab and the state of each toggle', () => {
    const list = buttons(toolbar('du texte'))
    expect(list.map((button) => button.label)).toEqual([
      'Gras (⌘B)',
      'Italique (⌘I)',
      'Barré',
      'Titre 1',
      'Titre 2',
      'Liste à puces',
      'Liste numérotée',
      'Cases à cocher (⇧⌘U coche la case de la ligne)',
      'Citation',
      'Code (dans une ligne, ou un bloc pour plusieurs lignes)',
      'Lien (⌘K)',
      'Voir le Markdown'
    ])
    expect(list.filter((button) => button.tab === '0')).toHaveLength(1)
    // The link button opens a field: it is no toggle.
    expect(list.filter((button) => button.pressed === null).map((button) => button.label)).toEqual(['Lien (⌘K)'])
    expect(list.every((button) => button.label === 'Lien (⌘K)' || button.pressed === 'false')).toBe(true)
  })

  it('shows pressed what the caret is in: a title, a list, a box, a quote', () => {
    const pressed = (text: string): string[] => buttons(toolbar(text)).filter((button) => button.pressed === 'true').map((button) => button.label)
    expect(pressed('# Titre')).toEqual(['Titre 1'])
    expect(pressed('## Titre')).toEqual(['Titre 2'])
    expect(pressed('- item')).toEqual(['Liste à puces'])
    expect(pressed('1. item')).toEqual(['Liste numérotée'])
    expect(pressed('- [ ] item')).toEqual(['Cases à cocher (⇧⌘U coche la case de la ligne)'])
    expect(pressed('> cité')).toEqual(['Citation'])
    expect(pressed('```\ncode\n```')).toEqual(['Code (dans une ligne, ou un bloc pour plusieurs lignes)'])
  })

  it('reads the address typed for a link: a bare domain is a web page, a bare mail address a mail link, anything else refused', () => {
    expect(typedLinkAddress('lucium.app/nouveautes')).toBe('https://lucium.app/nouveautes')
    expect(typedLinkAddress('loic@example.org')).toBe('mailto:loic@example.org')
    expect(typedLinkAddress('https://example.org/a(b)')).toBe('https://example.org/a%28b%29')
    for (const bad of ['', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings']) expect(typedLinkAddress(bad), bad).toBeNull()
  })
})

describe('sharing, downloading, copying and importing a note', () => {
  it('offers « Partager » and the menu « ⋯ » beside the note’s buttons, named, the share off while the note is empty', () => {
    const markup = view({ draft: { id: null, text: 'une note', link: null }, files: FILES })
    expect(markup).toMatch(/<button type="button" class="tk-btn quiet" title="Partager la note \(Mail, Messages, AirDrop…\)">.*Partager<\/button>/)
    expect(markup).toMatch(/<button type="button" class="tk-btn quiet icon" aria-label="Autres actions sur la note" title="Autres actions sur la note" aria-haspopup="menu" aria-expanded="false">/)
    expect(view({ draft: { id: null, text: '  ', link: null }, files: FILES })).toMatch(/<button type="button" class="tk-btn quiet" title="Partager la note[^"]*" disabled="">/)
    expect(unnamedButtons(markup)).toEqual([])
  })

  it('offers none of them when the panel cannot (no way to reach the main process for them)', () => {
    const markup = view({ draft: { id: null, text: 'une note', link: null } })
    expect(markup).not.toContain('Partager')
    expect(markup).not.toContain('aria-haspopup="menu"')
  })

  it('lists the entries of « ⋯ » in their order, nothing to download, copy or share in an empty note, « Voir le Markdown » checked while it is shown', () => {
    expect(noteMenuItems('texte', false).map((item) => [item.id, item.label, item.disabled])).toEqual([
      ['download', 'Télécharger en .md', false],
      ['copy-markdown', 'Copier en Markdown', false],
      ['copy-rich', 'Copier le texte mis en forme', false],
      ['share', 'Partager… (Mail, Messages, AirDrop)', false],
      ['import', 'Importer un fichier .md…', false],
      ['raw', 'Voir le Markdown', false]
    ])
    expect(noteMenuItems('', false).filter((item) => item.disabled).map((item) => item.id)).toEqual(['download', 'copy-markdown', 'copy-rich', 'share'])
    expect(noteMenuItems('x', true).find((item) => item.id === 'raw')!.checked).toBe(true)
    expect(noteMenuItems('x', false).find((item) => item.id === 'raw')!.checked).toBe(false)
  })

  it('draws the open menu as a menu of named entries, a checkbox for the Markdown, the disabled ones said so, its groups apart', () => {
    const markup = renderToStaticMarkup(createElement(NoteMoreMenu, { items: noteMenuItems('', true), onPick: noop, defaultOpen: true }))
    expect(markup).toMatch(/aria-haspopup="menu" aria-expanded="true" aria-controls="([^"]+)"/)
    const id = /aria-controls="([^"]+)"/.exec(markup)![1]
    expect(markup).toContain(`<div id="${id}" class="notes-menu" role="menu" aria-label="Autres actions sur la note">`)
    const entries = [...markup.matchAll(/<button type="button" class="notes-menu-item" role="(\w+)"([^>]*)>([^<]+)<\/button>/g)].map(([, role, attributes, label]) => `${role}${/aria-checked="true"/.test(attributes!) ? ' ✓' : ''}${/aria-disabled="true"/.test(attributes!) ? ' (off)' : ''}: ${label}`)
    expect(entries).toEqual([
      'menuitem (off): Télécharger en .md',
      'menuitem (off): Copier en Markdown',
      'menuitem (off): Copier le texte mis en forme',
      'menuitem (off): Partager… (Mail, Messages, AirDrop)',
      'menuitem: Importer un fichier .md…',
      'menuitemcheckbox ✓: Voir le Markdown'
    ])
    expect([...markup.matchAll(/role="separator"/g)]).toHaveLength(2)
  })

  it('goes round its entries with the arrows, and closes on Escape (the focus back on its button) and on Tab, keeping those keys from the note', () => {
    expect(menuKeyAction('ArrowDown', 1, 3)).toEqual({ focus: 2 })
    expect(menuKeyAction('ArrowDown', 2, 3)).toEqual({ focus: 0 })
    expect(menuKeyAction('ArrowUp', 0, 3)).toEqual({ focus: 2 })
    expect(menuKeyAction('ArrowDown', -1, 3)).toEqual({ focus: 0 })
    expect(menuKeyAction('Home', 2, 3)).toEqual({ focus: 0 })
    expect(menuKeyAction('End', 0, 3)).toEqual({ focus: 2 })
    // Escape is the menu's: the note around never takes it as « give the note up ».
    expect(menuKeyAction('Escape', 0, 3)).toEqual({ close: true, refocus: true })
    expect(menuKeyAction('Escape', -1, 0)).toEqual({ close: true, refocus: true })
    expect(menuKeyAction('Tab', 0, 3)).toEqual({ close: true, refocus: false })
    expect(menuKeyAction('a', 0, 3)).toBeNull()
  })
})
