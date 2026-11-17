// The small editors and the permission prompt as bubbles hung from the element that opened them, and the history in two columns:
// rendered to markup, with the interface's snapshot replaced by a small one (no window). What is measured is what a person finds on screen.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, PermissionRequest } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { historyColumns } from '@shared/history-days'
import { PERMISSION_ARM_MS } from '@shared/permissions'
import { setLanguage } from '@shared/i18n'

const ctx = { now: 1, newId: ((n = 0) => () => `id${++n}`)() }
const state = [{ type: 'tab/open', url: 'https://a.example.org/page' }, { type: 'favorite/add', url: 'https://fav.example.org/', title: 'Fav' }].reduce((acc, action) => reduce(acc, action as Action, ctx), createInitialState(ctx))

vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => ({ state, windowName: 'Revue', runtime: { tabs: {} } }) }))

const { Sheet, AnchoredBubble } = await import('./templates')
const { HistoryPanel, HistoryView, TabEditor } = await import('./ManagePanels')
const { FavoriteEditor } = await import('./FavoriteEditor')
const { WindowName } = await import('./WindowName')
const { AutoReloadPanel } = await import('./AutoReloadPanel')
const { PermissionPrompt } = await import('./Panels')

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node)
const row = { x: 12, y: 300, width: 220, height: 32 }

describe('AnchoredBubble', () => {
  it('draws the panel with an arrow facing the element, transparent until it has been measured, on the side asked for', () => {
    const markup = html(createElement(AnchoredBubble, { anchor: row, side: 'right', children: createElement('p', null, 'panneau') }))
    expect(markup).toMatch(/^<div class="ab ab-right" style="left:0;top:0;opacity:0"><p>panneau<\/p><span class="ab-arrow"[^>]*aria-hidden="true"><\/span><\/div>$/)
  })

  it('is what a sheet becomes when it is given the element, and is not there without one (the centred sheet)', () => {
    const sheet = (props: object): string => html(createElement(Sheet, { title: 'Modifier', onCancel: () => undefined, ...props }))
    expect(sheet({ anchor: row, side: 'bottom' })).toMatch(/^<div class="ab ab-bottom"[^>]*><form class="sh tk-panel/)
    expect(sheet({})).toMatch(/^<form class="sh tk-panel/)
  })
})

describe('the small editors', () => {
  const tabId = state.tabs[0]!.id
  const favoriteId = state.favorites[0]!.id

  it('the tab editor is a sheet with "Enregistrer" as its main action, the name focused, and a bubble beside the row when it has one', () => {
    const markup = html(createElement(TabEditor, { tabId, anchor: row }))
    expect(markup).toMatch(/^<div class="ab ab-right"/)
    expect(markup).toMatch(/class="sh tk-panel[^"]* tab-editor"/)
    expect(markup).toMatch(/<button type="submit" class="tk-btn primary">Enregistrer<\/button>/)
    expect(markup).toMatch(/<input class="tk-field"[^>]*data-autofocus=""/)
    expect(markup).toContain('role="radiogroup"')
    expect(html(createElement(TabEditor, { tabId }))).toMatch(/^<form class="sh tk-panel[^"]* tab-editor"/)
  })

  it('opened on the icon, the focus starts on the icon and not on the name', () => {
    const markup = html(createElement(TabEditor, { tabId, focus: 'icon' }))
    expect(markup).toMatch(/<button[^>]*role="radio"[^>]*data-autofocus=""/)
    expect(markup).not.toMatch(/<input class="tk-field"[^>]*data-autofocus/)
  })

  it('the favourite, the window name and the automatic reload are sheets too, under the element that opened them or beside it', () => {
    expect(html(createElement(FavoriteEditor, { favoriteId, anchor: row }))).toMatch(/^<div class="ab ab-bottom".*Renommer le favori/)
    expect(html(createElement(WindowName, { anchor: row }))).toMatch(/^<div class="ab ab-bottom".*Nommer la fenêtre/)
    expect(html(createElement(AutoReloadPanel, { tabId, anchor: row }))).toMatch(/^<div class="ab ab-right".*Recharger automatiquement/)
    expect(html(createElement(WindowName, {}))).toMatch(/^<form class="sh tk-panel/)
  })

  it('the automatic reload keeps its "Désactiver" on the left, greyed out while nothing is on', () => {
    const markup = html(createElement(AutoReloadPanel, { tabId }))
    expect(markup).toMatch(/<button type="button" class="tk-btn quiet danger" disabled="">Désactiver<\/button>/)
    expect(markup).toContain('>Activer</button>')
  })
})

describe('the permission bubble', () => {
  const ask = (props: Partial<PermissionRequest> = {}): string => html(createElement(PermissionPrompt, { request: { id: 'perm-1', origin: 'https://exemple.org', permission: 'geolocation', ...props } }))

  it('is a bubble under the toolbar that names the site in bold, with "Refuser" before "Autoriser" and the page left undimmed', () => {
    const markup = ask()
    expect(markup).toMatch(/^<div class="ab ab-bottom"/)
    expect(markup).not.toContain('iv-scrim')
    expect(markup).toContain('<strong>exemple.org</strong> souhaite connaître votre position')
    expect(markup.indexOf('Refuser')).toBeLessThan(markup.indexOf('Autoriser'))
    expect(markup).toContain('Tant que l’onglet reste ouvert.')
  })

  it('says one whole sentence of the catalogue, the site alone in bold wherever the language puts it', () => {
    expect(ask()).toContain('<strong>exemple.org</strong> souhaite connaître votre position.<')
    setLanguage('en')
    try {
      expect(ask()).toContain('<strong>exemple.org</strong> would like to know your location.<')
    } finally {
      setLanguage('fr')
    }
  })

  // The bubble comes where a page can foresee, when the page chooses: a click that lands on « Autoriser » as it is drawn must not answer.
  it('does not let "Autoriser" answer as it appears: the button is off until the question has been on screen for a moment, "Refuser" is not', () => {
    const markup = ask()
    expect(markup).toMatch(/<button type="submit" class="tk-btn primary" disabled="">Autoriser/)
    expect(markup).toMatch(/<button type="button" class="tk-btn" data-dismiss="">Refuser/)
    expect(PERMISSION_ARM_MS).toBeGreaterThanOrEqual(400)
    const source = readFileSync(new URL('./Panels.tsx', import.meta.url), 'utf8')
    // The wait is one timer per question, and the answer itself is refused before it ends (Return in the bubble goes the same way as the button).
    expect(source).toContain('const timer = setTimeout(() => setArmedFor(request.id), PERMISSION_ARM_MS)')
    expect(source).toContain('const armed = armedFor === request.id')
    expect(source).toContain('if (allow && !armed) return')
  })

  it('offers "Se souvenir pour ce site" never ticked in advance', () => {
    const markup = ask()
    expect(markup).toContain('<label class="iv-remember"><input type="checkbox"/>Se souvenir pour ce site</label>')
    expect(markup).not.toContain('checked')
  })

  // « Ouvrir dans <application> ? »: the box keeps the yes for the links of this type from this site, and is never ticked in advance.
  it('offers "Toujours ouvrir les liens de ce type depuis ce site" for a link to another application that a click explains, in both languages', () => {
    const markup = ask({ permission: 'openExternal:zoommtg:', detail: 'zoommtg:' })
    expect(markup).toContain('<strong>exemple.org</strong> souhaite ouvrir une application externe (zoommtg:)')
    expect(markup).toContain('<label class="iv-remember"><input type="checkbox"/>Toujours ouvrir les liens de ce type depuis ce site</label>')
    expect(markup).not.toContain('Se souvenir pour ce site')
    expect(markup).not.toContain('checked')
    setLanguage('en')
    expect(ask({ permission: 'openExternal:zoommtg:', detail: 'zoommtg:' })).toContain('Always open links of this type from this site</label>')
    setLanguage('fr')
  })

  it('does not offer it for a private tab, nor for a scheme that never leaves the browser', () => {
    expect(ask({ permission: 'openExternal:zoommtg:', detail: 'zoommtg:', ephemeral: true })).not.toContain('iv-remember')
    expect(ask({ permission: 'openExternal:file:', detail: 'file:' })).not.toContain('iv-remember')
  })

  it('does not offer to remember what cannot be kept: a private tab, a scheme asked each time, an origin that is no website', () => {
    expect(ask({ ephemeral: true })).not.toContain('iv-remember')
    expect(ask({ permission: 'openExternal', detail: 'mailto:' })).not.toContain('iv-remember')
    expect(ask({ origin: 'file://' })).not.toContain('iv-remember')
  })

  it('gives each kind of request its colour, and the others the plain one', () => {
    expect(ask({ permission: 'geolocation' })).toContain('tk-glyph info')
    expect(ask({ permission: 'notifications' })).toContain('tk-glyph warn')
    expect(ask({ permission: 'media' })).toMatch(/class="tk-glyph"/)
    expect(ask({ permission: 'midi' })).not.toContain('iv-lead')
  })
})

describe('the history in two columns', () => {
  const at = (day: number, hour: number): number => new Date(2026, 9, day, hour, 30).getTime()
  const page = (url: string, title: string, time: number): HistoryEntry => ({ url, title, visitCount: 1, lastVisitAt: time })
  const found = [page('https://a.example.org/', 'Tableau de bord', at(28, 15)), page('https://b.example.org/', 'Notes', at(28, 9)), page('https://c.example.org/', 'Météo', at(27, 18))]
  const view = (hidden: string[] = [], query = '', chosen: string | null = null): string =>
    html(createElement(HistoryView, { columns: historyColumns(found, new Set(hidden), chosen, query !== '', at(28, 16)), query, onPick: () => undefined, onOpen: () => undefined, onForget: () => undefined }))

  it('lists the days with their count on the left and the pages of the newest day on the right, with their time', () => {
    const markup = view()
    expect(markup).toMatch(/<nav class="hist-days"[^>]*><button type="button" aria-current="true">Aujourd’hui <span>2<\/span><\/button><button type="button" aria-current="false">Hier <span>1<\/span><\/button><button type="button" aria-current="false">Tout <span>3<\/span><\/button><\/nav>/)
    expect(markup).toContain('Tableau de bord')
    expect(markup).toContain('15:30')
    expect(markup).not.toContain('Météo')
  })

  it('shows every page, with its date, while a search is under way; and names each page\'s "Oublier"', () => {
    const markup = view([], 'a')
    expect(markup).toContain('Météo')
    expect(markup).toContain('27 oct. 18:30')
    // Each « Oublier » says which page it forgets (row-button-names.test.ts): the visible word, then the title of the page.
    expect(markup).toMatch(/<button type="button" class="tk-btn quiet small" aria-label="Oublier[^"]*Météo">Oublier<\/button>/)
  })

  it('does not draw a page or a day that is waiting to be forgotten, and says so when nothing is left', () => {
    expect(view(['https://b.example.org/'])).not.toContain('Notes')
    expect(view(['day:2026-10-28'])).not.toContain('Tableau de bord')
    const none = html(createElement(HistoryView, { columns: historyColumns([], new Set(), null, false, at(28, 16)), query: '', onPick: () => undefined, onOpen: () => undefined, onForget: () => undefined }))
    expect(none).toContain('Aucune page visitée.')
    expect(html(createElement(HistoryView, { columns: historyColumns([], new Set(), null, true, at(28, 16)), query: 'zzz', onPick: () => undefined, onOpen: () => undefined, onForget: () => undefined }))).toContain('Aucun résultat.')
  })

  it('draws a skeleton and no day until the search has answered', () => {
    const markup = html(createElement(HistoryPanel))
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('Chargement…')
    expect(markup).not.toContain('hist-days')
  })
})
