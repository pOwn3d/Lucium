// The templates of the panels, rendered to markup (no window, as settings-r11.test.ts does): what a person would find on screen, and what each family
// promises every panel built on it: a name for every action, the safe answer first, Escape and "Terminé" in the same place, the accent of the space.

import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassphrasePrompt } from '../PassphrasePrompt'
import { QrPanel } from '../QrPanel'
import { ArchiveGlyph, Invite, ListEmpty, ListGroup, ListPanel, ListRow, Sheet, SheetField, activeSpaceHue, hueProps, type ListPanelProps } from '.'
import { TemplatesDemo, errorPageDemo } from './TemplatesDemo'
import { partHasFocus } from './useFocusScope'
import { ERROR_TONES } from '@shared/error-page-template'
import { defaultTheme, themeFromHue } from '@shared/theme'
import primitivesCss from './primitives.css?raw'

const noop = (): void => undefined
const html = (node: ReactNode): string => renderToStaticMarkup(node)
const list = (props: Partial<ListPanelProps> = {}, children?: ReactNode): string => html(createElement(ListPanel, { title: 'Archive', icon: createElement(ArchiveGlyph), onDone: noop, ...props }, children))

/** Every button of a markup has a name: its text, or an aria-label. */
function unnamedButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs!) && inner!.replace(/<[^>]*>/g, '').trim() === '')
    .map(([whole]) => whole.slice(0, 80))
}

afterEach(() => vi.unstubAllGlobals())

/**
 * The selectors of the rules of a sheet that give a `svg` of a panel a line (`stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`). Only the form
 * the sheet writes is understood, `.tk-panel svg` with `:not(...)` after it: any other form throws, so that a change of the rule is read here rather than missed.
 */
function strokeRulesOfPanelSvgs(sheet: string): string[] {
  const rules = [...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  return rules.filter(([, , body]) => /(?:^|[;\s])stroke(?:-\w+)?\s*:/.test(body!)).flatMap(([, selector]) => selector!.split(',').map((part) => part.trim().replace(/\s+/g, ' '))).filter((part) => part.startsWith('.tk-panel svg'))
}

/** Whether `selector` (a rule of strokeRulesOfPanelSvgs) reaches a `svg` with these classes, inside a panel. */
function reachesSvg(selector: string, classes: readonly string[]): boolean {
  const rest = selector.slice('.tk-panel svg'.length)
  const exclusions = [...rest.matchAll(/:not\((?::where\()?\.([\w-]+)\)?\)/g)]
  if (exclusions.map(([whole]) => whole).join('') !== rest) throw new Error(`a form of selector this test does not read: ${selector}`)
  return !exclusions.some(([, excluded]) => classes.includes(excluded!))
}

describe('ListPanel', () => {
  it('is a dialog named by its title, with the count beside it', () => {
    const markup = list({ count: 12 })
    expect(markup).toMatch(/<div class="lp tk-panel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="([^"]+)"/)
    const id = /aria-labelledby="([^"]+)"/.exec(markup)![1]
    expect(markup).toContain(`<h2 id="${id}">Archive<span class="lp-count">12</span></h2>`)
  })

  it('puts "Terminé" last in the foot, after the destructive action: the same place in every list', () => {
    const markup = list({ footStart: createElement('button', { className: 'tk-btn quiet danger' }, 'Vider l’archive'), footOption: createElement('span', null, 'option') })
    const foot = markup.slice(markup.indexOf('<footer'))
    expect(foot.indexOf('Vider l’archive')).toBeLessThan(foot.indexOf('option'))
    expect(foot.indexOf('option')).toBeLessThan(foot.indexOf('Terminé'))
    expect(foot).toContain('<button type="button" class="tk-btn primary">Terminé</button>')
  })

  it('writes the label of the done button it is given, and reads "Done" in English', async () => {
    expect(list({ doneLabel: 'Fermer' })).toContain('>Fermer</button></footer>')
    const { setLanguage } = await import('@shared/i18n')
    setLanguage('en')
    try {
      expect(list()).toContain('>Done</button></footer>')
    } finally {
      setLanguage('fr')
    }
  })

  it('has a search field with its full name, and a short placeholder', () => {
    const markup = list({ search: { value: 'sé', onChange: noop, label: 'Rechercher dans l’historique', placeholder: 'Titre ou adresse' } })
    expect(markup).toContain('type="search"')
    expect(markup).toContain('aria-label="Rechercher dans l’historique"')
    expect(markup).toContain('placeholder="Titre ou adresse"')
    expect(markup).toContain('value="sé"')
    expect(list({ search: { value: '', onChange: noop, label: 'x' } })).toContain('placeholder="Rechercher"')
    expect(list()).not.toContain('type="search"')
  })

  it('shows the notice of a deletion that can be taken back, with ⌘Z, and only then', () => {
    const markup = list({ undo: { message: 'Page oubliée', onUndo: noop } })
    expect(markup).toContain('<div class="lp-undo" role="status"><span>Page oubliée</span>')
    expect(markup).toContain('Annuler <kbd class="tk-kbd">⌘Z</kbd>')
    expect(list({ undo: null })).not.toContain('lp-undo')
  })

  it('says it is loading, with a still skeleton and no rows, and flags itself busy', () => {
    const markup = list({ state: 'loading' }, createElement('p', null, 'LES-RANGEES'))
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('role="status">Chargement…</p>')
    expect(markup).toContain('lp-skeleton')
    expect(markup).not.toContain('LES-RANGEES')
    expect(list()).not.toContain('aria-busy')
  })

  it('says what went wrong as an alert, and offers a retry only when there is one', () => {
    const failed = list({ state: 'error', statusText: 'Lecture impossible.', onRetry: noop })
    expect(failed).toContain('role="alert">Lecture impossible.')
    expect(failed).toContain('>Réessayer</button>')
    expect(list({ state: 'error', statusText: 'Lecture impossible.' })).not.toContain('Réessayer')
  })

  it('takes the hue of the space as its accent', () => {
    expect(list({ hue: 140 })).toMatch(/class="lp tk-panel tk-hue"[^>]*style="--hue:140"/)
    expect(list()).not.toContain('tk-hue')
  })

  it('names its filters as a group, and its rows with a main button each', () => {
    const markup = list({ filters: createElement('button', { className: 'tk-chip', 'aria-pressed': true }, 'Tout'), filtersLabel: 'Origine' }, createElement(ListGroup, { title: 'Hier', children: createElement(ListRow, { title: 'Page', onOpen: noop }) }))
    expect(markup).toContain('role="group" aria-label="Origine"')
    expect(markup).toContain('<section class="lp-group"><h3>Hier</h3><ul class="lp-list">')
    expect(markup).toContain('<button type="button" class="lp-main">')
  })

  it('makes its filters a group of radios when one is chosen at a time, the chosen one drawn as a pressed chip', () => {
    const markup = list({ filters: createElement('button', { className: 'tk-chip', role: 'radio', 'aria-checked': true }, 'Toutes'), filtersLabel: 'Notes affichées', filtersRole: 'radiogroup' })
    expect(markup).toContain('<div class="lp-filters" role="radiogroup" aria-label="Notes affichées">')
    // Without the accent, the chosen chip would look like the others.
    const checked = /([^{}]*\.tk-chip\[aria-checked='true'\][^{}]*)\{([^}]*)\}/.exec(primitivesCss)
    expect(checked?.[2]).toContain('background: var(--accent)')
  })
})

describe('ListRow', () => {
  it('is a button when it opens something and plain text when it does not', () => {
    expect(html(createElement(ListRow, { title: 'A', onOpen: noop }))).toContain('<button type="button" class="lp-main">')
    expect(html(createElement(ListRow, { title: 'A' }))).toContain('<div class="lp-main">')
  })

  it('shows the title and its line, then what stands at the right, then the actions that show on hover', () => {
    const markup = html(createElement(ListRow, { title: 'Titre', subtitle: 'adresse · 09:41', meta: '3 Mo', actions: createElement('button', { 'aria-label': 'Oublier' }), icon: 'T', hint: 'Titre complet' }))
    expect(markup).toContain('<span class="lp-title">Titre</span><span class="lp-sub">adresse · 09:41</span>')
    expect(markup.indexOf('lp-meta')).toBeLessThan(markup.indexOf('lp-actions'))
    expect(markup).toContain('<span class="lp-ico" aria-hidden="true">T</span>')
    expect(markup).toContain('title="Titre complet"')
  })

  it('keeps the actions of a pinned row visible', () => {
    expect(html(createElement(ListRow, { title: 'A', pinned: true }))).toContain('class="lp-row pinned"')
  })
})

describe('ListEmpty', () => {
  it('says what the list is for and what to do, not a blank', () => {
    const markup = html(createElement(ListEmpty, { icon: createElement(ArchiveGlyph), title: 'Rien d’archivé', hint: 'Les onglets inactifs arrivent ici.', action: createElement('button', { className: 'tk-btn' }, 'Ouvrir') }))
    expect(markup).toContain('<b>Rien d’archivé</b><p>Les onglets inactifs arrivent ici.</p>')
    expect(markup).toContain('>Ouvrir</button>')
  })
})

describe('Sheet', () => {
  const sheet = (props: Record<string, unknown> = {}, children?: ReactNode): string => html(createElement(Sheet, { title: 'Modifier le favori', onCancel: noop, ...props }, children))

  it('is a modal form named by its title, with what is edited in grey beside it', () => {
    const markup = sheet({ context: 'agenda.local' })
    expect(markup).toMatch(/<form class="sh tk-panel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="([^"]+)"/)
    expect(markup).toContain('<span class="sh-ctx" title="agenda.local">agenda.local</span>')
  })

  it('orders the foot as the design says: the destructive action, "Annuler", then the main action as the submit button', () => {
    const markup = sheet({ footStart: createElement('button', { type: 'button' }, 'Retirer'), primary: { label: 'Enregistrer' } })
    const foot = markup.slice(markup.indexOf('<footer'))
    expect(foot.indexOf('Retirer')).toBeLessThan(foot.indexOf('Annuler'))
    expect(foot.indexOf('Annuler')).toBeLessThan(foot.indexOf('Enregistrer'))
    expect(foot).toContain('<button type="submit" class="tk-btn primary">Enregistrer</button>')
    expect(foot).toContain('<button type="button" class="tk-btn">Annuler</button>')
  })

  it('has no "Annuler" when it only shows something, and greys the main action while it cannot be used', () => {
    expect(sheet({ cancelLabel: null, primary: { label: 'Fermer' } })).not.toContain('Annuler')
    expect(sheet({ primary: { label: 'Enregistrer', disabled: true } })).toContain('class="tk-btn primary" disabled=""')
    expect(sheet({ primary: { label: 'Enregistrer', busy: true } })).toContain('aria-busy="true"')
    expect(sheet({ primary: { label: 'Supprimer', danger: true } })).toContain('tk-btn primary danger')
  })

  it('ties a field to its label, and says the error before the person submits, read with the field', () => {
    const markup = sheet({}, createElement(SheetField, { label: 'Adresse', error: 'Adresse non valide.', children: (field) => createElement('input', { className: 'tk-field', ...field }) }))
    const id = /<label for="([^"]+)">Adresse<\/label>/.exec(markup)![1]
    expect(markup).toContain(`id="${id}"`)
    expect(markup).toContain(`aria-describedby="${id}-note"`)
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain(`<p id="${id}-note" class="sh-error" role="alert">Adresse non valide.</p>`)
  })

  it('writes a help line instead when nothing is wrong, and nothing at all when there is neither', () => {
    const field = (props: object): string => sheet({}, createElement(SheetField, { label: 'Nom', ...props, children: (f) => createElement('input', { ...f }) }))
    expect(field({ help: 'Le nom du favori.' })).toContain('class="sh-help">Le nom du favori.</p>')
    expect(field({ help: 'x' })).not.toContain('aria-invalid')
    const bare = field({})
    expect(bare).not.toContain('aria-describedby')
    expect(bare).not.toContain('sh-help')
  })
})

describe('Invite', () => {
  const invite = (props: Record<string, unknown> = {}, children?: ReactNode): string =>
    html(createElement(Invite, { glyph: 'g', title: createElement('strong', null, 'exemple.org'), dismiss: { label: 'Refuser' }, accept: { label: 'Autoriser' }, ...props }, children))

  it('is an alert dialog named by its title, over a dimmed layer unless it is told not to dim', () => {
    const markup = invite()
    expect(markup).toMatch(/<div class="iv-scrim"><form class="iv tk-panel"[^>]*role="alertdialog"[^>]*aria-modal="true"/)
    expect(invite({ scrim: false })).not.toContain('iv-scrim')
  })

  it('puts the safe answer before the main one, and marks it to take the focus on opening', () => {
    const markup = invite({ dismiss: { label: 'Refuser', kbd: 'ESC' }, accept: { label: 'Autoriser', kbd: '↩' } })
    expect(markup.indexOf('Refuser')).toBeLessThan(markup.indexOf('Autoriser'))
    expect(markup).toContain('<button type="button" class="tk-btn" data-dismiss="">Refuser<kbd class="tk-kbd">ESC</kbd></button>')
    expect(markup).toContain('<button type="submit" class="tk-btn primary">Autoriser<kbd class="tk-kbd">↩</kbd></button>')
  })

  it('names who asks above the title, and says the risk with an icon and a role, not a colour alone', () => {
    const markup = invite({ kicker: 'Message de exemple.org', banner: { text: 'La connexion n’est pas chiffrée.', tone: 'danger', alert: true } })
    expect(markup).toContain('<span class="iv-kicker">Message de exemple.org</span>')
    expect(markup).toMatch(/<p class="tk-banner iv-banner danger" role="alert"><svg[^>]*aria-hidden="true"/)
    expect(invite({ banner: { text: 'x' } })).toContain('role="note"')
  })

  it('offers "remember" as the caller gives it: unticked is the caller\'s to keep, and the box has a visible label', () => {
    const markup = invite({ remember: { label: 'Se souvenir pour ce site', checked: false, onChange: noop } })
    expect(markup).toContain('<label class="iv-remember"><input type="checkbox"/>Se souvenir pour ce site</label>')
    expect(markup).not.toContain('checked')
    expect(invite()).not.toContain('iv-remember')
  })

  it('disables the main answer while it cannot be given', () => {
    expect(invite({ accept: { label: 'Ouvrir', disabled: true } })).toContain('class="tk-btn primary" disabled=""')
  })

  it('colours its pastille by the kind of request, the accent by default', () => {
    expect(invite()).toContain('class="tk-glyph"')
    expect(invite({ tone: 'warn' })).toContain('class="tk-glyph warn"')
  })
})

describe('the hue of a space', () => {
  it('is the hue of the first colour of its theme, found among the spaces by id', () => {
    const spaces = [
      { id: 'a', theme: defaultTheme() },
      { id: 'b', theme: themeFromHue(140) }
    ]
    expect(activeSpaceHue(spaces, 'b')).toBe(Math.round(activeSpaceHue(spaces, 'b')!))
    expect(Math.abs(activeSpaceHue(spaces, 'b')! - 140)).toBeLessThan(2)
    expect(activeSpaceHue(spaces, 'missing')).toBeUndefined()
    expect(activeSpaceHue(spaces, null)).toBeUndefined()
  })

  it('becomes a class and a style on a root, and nothing without a hue: a panel with no space adds no rule', () => {
    expect(hueProps(222)).toEqual({ className: 'tk-hue', style: { '--hue': 222 } })
    expect(hueProps(-30).style).toEqual({ '--hue': 330 })
    expect(hueProps(395.4).style).toEqual({ '--hue': 35 })
    expect(hueProps(undefined)).toEqual({ className: '' })
    expect(hueProps(Number.NaN)).toEqual({ className: '' })
  })
})

describe('the panels moved onto the templates', () => {
  it('QrPanel is a small editor with its own class, "Fermer" as the only action, and the code drawn from the encoder', () => {
    vi.stubGlobal('window', { lucium: {} })
    const markup = html(createElement(QrPanel, { text: 'https://exemple.org/' }))
    expect(markup).toMatch(/<form class="sh tk-panel qr-panel"[^>]*role="dialog"/)
    expect(markup).toContain('<h2')
    expect(markup).toContain('Code QR')
    expect(markup).toMatch(/<svg class="qr-code"[^>]*role="img"[^>]*><rect[^>]*><\/rect><path d="M/)
    expect(markup).toContain('class="muted qr-text" title="https://exemple.org/">https://exemple.org/</p>')
    expect(markup).toContain('>Fermer</button>')
    expect(markup).not.toContain('Annuler')
  })

  it('QrPanel draws its code with the stroke of no icon rule: the modules stay crisp filled squares, while the icons of the panel keep their line', () => {
    vi.stubGlobal('window', { lucium: {} })
    const svgs = [...html(createElement(QrPanel, { text: 'https://exemple.org/' })).matchAll(/<svg\b([^>]*)>/g)].map(([, attrs]) => /\bclass="([^"]*)"/.exec(attrs!)?.[1]?.split(/\s+/) ?? [])
    const code = svgs.filter((classes) => classes.includes('qr-code'))
    const icons = svgs.filter((classes) => !classes.includes('qr-code'))
    expect(code).toHaveLength(1)
    expect(icons.length).toBeGreaterThan(0)
    const lineRules = strokeRulesOfPanelSvgs(primitivesCss)
    expect(lineRules.length).toBeGreaterThan(0)
    for (const rule of lineRules) {
      expect(reachesSvg(rule, code[0]!), `${rule} must not reach the QR code`).toBe(false)
      for (const classes of icons) expect(reachesSvg(rule, classes), `${rule} must reach an icon`).toBe(true)
    }
  })

  it('QrPanel says so, as an alert, when the text is too long for a code', () => {
    vi.stubGlobal('window', { lucium: {} })
    const markup = html(createElement(QrPanel, { text: 'x'.repeat(5000) }))
    expect(markup).toContain('role="alert"')
    expect(markup).not.toContain('qr-code')
  })

  it('PassphrasePrompt is an invite with one password field, "Annuler ESC" before "Ouvrir ↩", and the main answer off while the field is empty', () => {
    vi.stubGlobal('window', { lucium: {} })
    const markup = html(createElement(PassphrasePrompt, { request: { id: 'r1', title: 'Phrase secrète', message: 'Cette sauvegarde est chiffrée.' } }))
    expect(markup).toMatch(/<form class="iv tk-panel passphrase-prompt"[^>]*role="alertdialog"/)
    expect(markup).toContain('<h2')
    expect(markup).toContain('Phrase secrète')
    expect(markup).toContain('Cette sauvegarde est chiffrée.')
    expect(markup).toMatch(/<input class="tk-field" type="password"[^>]*name="passphrase"/)
    expect(markup.indexOf('Annuler')).toBeLessThan(markup.indexOf('Ouvrir'))
    expect(markup).toContain('<kbd class="tk-kbd">ESC</kbd>')
    expect(markup).toContain('<kbd class="tk-kbd">↩</kbd>')
    expect(markup).toMatch(/class="tk-btn primary" disabled=""/)
    expect(markup).not.toContain('role="alert"')
  })

  it('PassphrasePrompt says that the phrase was wrong, as an alert, when the main process says so', () => {
    vi.stubGlobal('window', { lucium: {} })
    const markup = html(createElement(PassphrasePrompt, { request: { id: 'r1', title: 'Phrase secrète', message: 'Cette sauvegarde est chiffrée.', problem: 'Phrase incorrecte.' } }))
    expect(markup).toMatch(/<p class="tk-banner iv-banner warn" role="alert"><svg[^>]*>.*<\/svg><span>Phrase incorrecte\.<\/span><\/p>/)
  })
})

describe('the demonstration page', () => {
  const demo = html(createElement(TemplatesDemo, { scheme: 'dark', hue: 140 }))

  it('shows each family: the list, the editor, the invites and the five tones of error page', () => {
    for (const marker of ['class="lp tk-panel', 'class="sh tk-panel', 'class="iv tk-panel']) expect(demo, marker).toContain(marker)
    expect(demo.match(/<iframe/g)).toHaveLength(ERROR_TONES.length)
  })

  it('takes the scheme and the hue it is given', () => {
    expect(demo).toMatch(/^<div class="tk-demo" data-theme="dark"/)
    expect(demo).toContain('--hue:140')
    expect(html(createElement(TemplatesDemo))).toMatch(/^<div class="tk-demo" style=/)
  })

  it('names every action of every family: no button without a text or a label', () => {
    expect(unnamedButtons(demo)).toEqual([])
  })

  it('writes each error page as a complete document that follows the system', () => {
    for (const tone of ERROR_TONES) {
      const page = errorPageDemo(tone)
      expect(page).toContain(`class="ep-icon ${tone}"`)
      expect(page).toContain('<meta name="color-scheme" content="light dark">')
    }
  })
})

describe('the focus a panel finds when it opens (useFocusScope)', () => {
  // A panel and what it holds, as `contains` sees them: the panel contains itself and its field, not the page behind it.
  const panel = { contains: (node: unknown) => node === panel || node === field } as unknown as Element
  const field = {} as Element
  const outside = {} as Element

  it('leaves the focus on a part of the panel that already has it', () => {
    expect(partHasFocus(panel, field)).toBe(true)
  })

  it('takes it when the focus is outside the panel or nowhere', () => {
    expect(partHasFocus(panel, outside)).toBe(false)
    expect(partHasFocus(panel, null)).toBe(false)
  })

  it('takes it from the panel itself, which the host focuses when the panel is drawn after the first snapshot: its field still gets the keys', () => {
    expect(partHasFocus(panel, panel)).toBe(false)
  })
})
