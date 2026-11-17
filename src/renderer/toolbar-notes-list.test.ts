// The button « Toutes les notes » of the toolbar, drawn for real: the one button of the notes there (« Nouvelle note » has none: a note is made from the
// panel this button opens, from File › Nouvelle note and with ⌥⌘E); there while the notes and their button are on, never in a private window (nor a guest
// one, private underneath); on its own switch; in the strip of the focused pane of a split view; its tooltip with the shortcut of File › Notes as it is set; and a click that asks for the panel on « Toutes », not the request of File › Notes.

import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeState, Settings, SplitView, TabItem } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { defaultTheme } from '@shared/theme'
import type { UiSnapshot } from '@shared/ipc'
import { NEW_NOTE_REQUEST, NOTES_LIST_REQUEST, showsNotesListButton } from '@shared/notes'
import { sameToolbar, type ToolbarInputs } from '@shared/row-equality'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, opened: [] as unknown[], tips: [] as Array<[string, string[] | undefined]> }))
vi.mock('./api', () => ({ api: () => ({ openOverlay: (request: unknown) => void holder.opened.push(request) }), useSnapshot: () => holder.snapshot }))
vi.mock('./Sidebar', () => ({ FLOATING: false, Sidebar: () => null }))
vi.mock('./tooltip', () => ({
  hideTooltip: () => undefined,
  tipProps: (text: string, keys?: string[]) => {
    holder.tips.push([text, keys])
    return {}
  }
}))

import { App, SplitDividers } from './App'
import { NotesListButton, Toolbar } from './Toolbar'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.opened = []
  holder.tips = []
})
afterEach(() => vi.unstubAllGlobals())

const LIST = 'aria-label="Toutes les notes"'
const NEW = 'aria-label="Nouvelle note"'
const count = (markup: string, button = LIST): number => markup.split(button).length - 1
const TIP = 'Toutes les notes'

const tab = (id: string, spaceId = 's'): TabItem => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2 })
const space = { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }

/** The window with one tab on screen: its settings changed by `settings`, private or not. */
function windowWith(settings: Partial<Settings> = {}, flags: { private?: boolean; guest?: boolean; platform?: string } = {}): string {
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const spaceId = base.activeSpaceId
  const state = { ...base, tabs: [tab('a', spaceId)], activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' }, settings: { ...base.settings, ...settings } }
  holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: flags.platform ?? 'darwin', annotateEnabled: true, ...(flags.private ? { private: true } : {}), ...(flags.guest ? { guest: true } : {}) } as unknown as UiSnapshot
  return renderToStaticMarkup(createElement(App))
}

describe('the button in the toolbar of a window', () => {
  it('is there by default, the notes and their button being on', () => {
    expect(count(windowWith())).toBe(1)
  })

  it('is not there while the notes are off, nor while its own setting is off', () => {
    expect(count(windowWith({ notes: false }))).toBe(0)
    expect(count(windowWith({ notesListButton: false }))).toBe(0)
    expect(count(windowWith({ notes: false, notesListButton: true }))).toBe(0)
  })

  it('is never there in a private window, nor in a guest one', () => {
    expect(count(windowWith({}, { private: true }))).toBe(0)
    expect(count(windowWith({}, { private: true, guest: true }))).toBe(0)
  })

  it('is the only button of the notes: the toolbar draws no « Nouvelle note », whatever the settings', () => {
    for (const settings of [{}, { notesListButton: false }, { notes: false }]) expect(count(windowWith(settings), NEW)).toBe(0)
    expect(count(windowWith({}, { private: true }), NEW)).toBe(0)
  })

  it('stands after « Annoter » and before the controls of the site', () => {
    const markup = windowWith()
    const at = (label: string) => markup.indexOf(`aria-label="${label}"`)
    expect(at('Annoter')).toBeGreaterThan(-1)
    expect(at('Annoter')).toBeLessThan(at('Toutes les notes'))
    expect(at('Toutes les notes')).toBeLessThan(at('Infos et réglages du site'))
  })

  it('draws a line icon of the grid of the toolbar, and a target of 28 px at least', async () => {
    const markup = windowWith()
    const slice = (label: string): string => markup.slice(markup.lastIndexOf('<button', markup.indexOf(label)), markup.indexOf('</button>', markup.indexOf(label)))
    const button = slice(LIST)
    expect(button).toContain('viewBox="0 0 20 20"')
    expect(button).toContain('stroke-width="1.5"')
    expect(button).toContain('stroke-linecap="round"')
    expect(button).toContain('aria-hidden="true"')
    expect(button).toContain('class="tb-button tb-note tb-note-all"')
    const shapes = (html: string): string[] => [...html.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]!)
    expect(shapes(button).length).toBeGreaterThan(0)
    const css = (await import('./toolbar.css?raw')).default
    expect(css).toMatch(/\.tb-note::after \{ content: ''; position: absolute; inset: -2px 0; \}/)
  })

  it('says its shortcut in its tooltip, as Réglages › Raccourcis sets it for File › Notes, and none when it has none', () => {
    windowWith()
    expect(holder.tips.filter(([text]) => text === TIP)).toEqual([[TIP, ['⇧', '⌘', 'E']]])
    holder.tips = []
    windowWith({ keyBindings: { notes: 'CmdOrCtrl+Shift+Alt+N' } })
    expect(holder.tips.filter(([text]) => text === TIP)).toEqual([[TIP, ['⌥', '⇧', '⌘', 'N']]])
    holder.tips = []
    windowWith({ keyBindings: { notes: '' } })
    expect(holder.tips.filter(([text]) => text === TIP)).toEqual([[TIP, undefined]])
  })

  it('is told in English with the interface in English', () => {
    setLanguage('en')
    const markup = windowWith()
    expect(count(markup, 'aria-label="All Notes"')).toBe(1)
    expect(count(markup)).toBe(0)
  })
})

describe('the rule of the button', () => {
  it('asks for the notes, their button, and a window that is not private', () => {
    expect(showsNotesListButton({ notes: true, notesListButton: true }, false)).toBe(true)
    expect(showsNotesListButton({ notes: false, notesListButton: true }, false)).toBe(false)
    expect(showsNotesListButton({ notes: true, notesListButton: false }, false)).toBe(false)
    expect(showsNotesListButton({ notes: true, notesListButton: true }, true)).toBe(false)
  })

  it('draws the bar again when the button comes or goes, or its shortcut changes', () => {
    const inputs: ToolbarInputs = { space: { profileId: 'default' }, current: undefined, runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true }
    expect(sameToolbar({ ...inputs, notesList: ['⇧', '⌘', 'E'] }, { ...inputs, notesList: ['⇧', '⌘', 'E'] })).toBe(true)
    expect(sameToolbar({ ...inputs, notesList: ['⇧', '⌘', 'E'] }, inputs)).toBe(false)
    expect(sameToolbar({ ...inputs, notesList: ['⇧', '⌘', 'E'] }, { ...inputs, notesList: [] })).toBe(false)
    expect(sameToolbar({ ...inputs, notesList: ['⇧', '⌘', 'E'] }, { ...inputs, notesList: ['⌥', '⌘', 'E'] })).toBe(false)
  })
})

describe('the button in a split view', () => {
  const split: SplitView = { id: 'v', spaceId: 's', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] }
  const strip = (focused: boolean, notesList?: readonly string[]): string =>
    renderToStaticMarkup(createElement(Toolbar, { space, current: tab('a'), runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false, notesList, pane: { style: {}, focused, onSelect: () => undefined, onClose: () => undefined } }))
  const layer = (notesList: readonly string[] | undefined, activeId = 'a'): string =>
    renderToStaticMarkup(
      createElement(SplitDividers, { split, tabs: [tab('a'), tab('b')], activeId, space, runtime, sidebarVisible: true, fullUrl: false, draggable: false, stageLeft: null, zoom: { showZoomIndicator: false, siteZoom: {} }, scrollSync: false, synced: false, annotate: false, notesList })
    )

  it('belongs to the strip of the focused pane only: one button for the window', () => {
    expect(count(strip(true, []))).toBe(1)
    expect(count(strip(false, []))).toBe(0)
    expect(count(strip(true))).toBe(0)
  })

  it('is handed by the split layer to its strips: one button, over the focused pane', () => {
    expect(count(layer([]))).toBe(1)
    expect(count(layer(undefined))).toBe(0)
    expect(count(layer([], 'elsewhere'))).toBe(0)
  })
})

describe('a click on the button', () => {
  it('asks for the panel on the list of the notes, on « Toutes » (NOTES_LIST_REQUEST), not on a new note', () => {
    const button = NotesListButton({ keys: ['⇧', '⌘', 'E'] }) as ReactElement<{ onClick: () => void; 'aria-label': string }>
    expect(isValidElement(button)).toBe(true)
    expect(button.props['aria-label']).toBe('Toutes les notes')
    button.props.onClick()
    expect(holder.opened).toEqual([{ panel: 'notes', scope: 'all' }])
    expect(holder.opened[0]).toBe(NOTES_LIST_REQUEST)
    expect(holder.opened[0]).not.toBe(NEW_NOTE_REQUEST)
    expect(holder.opened[0]).not.toHaveProperty('compose')
    expect(holder.opened[0]).toHaveProperty('scope', 'all')
  })
})
