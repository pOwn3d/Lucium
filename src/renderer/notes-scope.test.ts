// @vitest-environment happy-dom
// What the list of the notes panel shows, the panel mounted for real (the rich text field replaced by a plain one, as notes-give-up.test.ts does):
// the choice it opens on, the arrows of the group of choices and the count of the header, a note of another page opened in the editor without the tab
// changing, « Nouvelle note » making way when the person asks to see the notes, and a choice that stays when a note is saved.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import type { SidebarState, TabItem } from '@shared/model'
import type { Note, NotesRequest } from '@shared/notes'
import { createInitialState } from '@shared/sidebar'
import { button, click, mount, type, type Mounted } from './dom.test-support'

const PAGE = 'https://example.org/article'
const ON_PAGE: Note = { id: 'p', text: 'Sur la page', createdAt: 1, updatedAt: 3, link: { kind: 'page', url: PAGE } }
const IN_SPACE: Note = { id: 's', text: 'Dans l’espace', createdAt: 1, updatedAt: 2, link: { kind: 'space', spaceId: 'sp' } }
const ELSEWHERE: Note = { id: 'o', text: 'Autre page', createdAt: 1, updatedAt: 1, link: { kind: 'page', url: 'https://example.net/ailleurs' } }

const holder = vi.hoisted(() => ({ snapshot: null as unknown, notes: [] as Note[], dispatched: [] as unknown[], closed: 0 }))
vi.mock('./api', () => ({
  api: () => ({
    notes: (request: NotesRequest) => {
      if (request.kind === 'create') holder.notes = [{ id: `n${holder.notes.length + 1}`, text: request.text, createdAt: 100, updatedAt: 100, ...(request.link ? { link: request.link } : {}) }, ...holder.notes]
      return Promise.resolve({ ok: true, notes: holder.notes })
    },
    closeOverlay: () => void holder.closed++,
    dispatch: (action: unknown) => {
      holder.dispatched.push(action)
      return Promise.resolve()
    }
  }),
  useSnapshot: () => holder.snapshot
}))
vi.mock('./NoteTextEditor', async () => {
  const react = await import('react')
  return { NoteTextEditor: (props: { value: string; onChange: (text: string) => void }) => react.createElement('textarea', { 'data-field': 'note', value: props.value, onChange: (event: { target: { value: string } }) => props.onChange(event.target.value) }) }
})

import { NotesPanel } from './NotesPanel'

/** The window: one space (`sp`), its tab on `url`. */
function stateOn(url: string): SidebarState {
  const state = createInitialState({ now: 1, newId: () => 'sp' })
  const tab = { id: 't1', spaceId: 'sp', url, title: 'Article', pinned: false, lastActiveAt: 1 } as unknown as TabItem
  return { ...state, tabs: [tab], activeTabBySpace: { sp: 't1' } }
}

let mounted: Mounted | null = null
async function panel(url: string, notes: Note[], compose = false, scope?: 'all'): Promise<HTMLElement> {
  holder.snapshot = { state: stateOn(url), runtime: { tabs: {} }, extensions: [], platform: 'darwin' }
  holder.notes = notes
  mounted = mount(createElement(NotesPanel, { compose, ...(scope ? { scope } : {}) }))
  await act(async () => {})
  return mounted.container
}

const checked = (container: HTMLElement): string | undefined => container.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? undefined
const radio = (container: HTMLElement, label: string): HTMLElement => [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((one) => one.textContent === label)!
const count = (container: HTMLElement): string | undefined => container.querySelector('.lp-count')?.textContent ?? undefined
const titles = (container: HTMLElement): string[] => [...container.querySelectorAll('.lp-title')].map((title) => title.textContent ?? '')
const field = (container: HTMLElement): HTMLTextAreaElement | null => container.querySelector('[data-field="note"]')
const press = (target: Element, key: string): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

beforeEach(() => {
  setLanguage('fr')
  holder.dispatched = []
  holder.closed = 0
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('what the notes panel shows', () => {
  it('opens on « Cette page » when the page on screen has notes, and counts them', async () => {
    const container = await panel(PAGE, [ON_PAGE, IN_SPACE, ELSEWHERE])
    expect(checked(container)).toBe('Cette page')
    expect(count(container)).toBe('1')
    expect(titles(container)).toEqual(['Sur la page'])
  })

  it('opens on « Toutes » when the request forces it (the toolbar’s « Toutes les notes »), even when the page on screen has notes', async () => {
    const container = await panel(PAGE, [ON_PAGE, IN_SPACE, ELSEWHERE], false, 'all')
    expect(checked(container)).toBe('Toutes')
    expect(count(container)).toBe('3')
    expect(titles(container)).toEqual(['Sur la page', 'Dans l’espace', 'Autre page'])
    // The choices stay there: the person may still narrow the list to the page.
    await click(radio(container, 'Cette page'))
    expect([checked(container), count(container)]).toEqual(['Cette page', '1'])
  })

  it('opens on « Toutes » when the page has none, the notes of the space first', async () => {
    const container = await panel('https://example.org/vide', [ON_PAGE, IN_SPACE, ELSEWHERE])
    expect(checked(container)).toBe('Toutes')
    expect(count(container)).toBe('3')
    expect(titles(container)).toEqual(['Dans l’espace', 'Sur la page', 'Autre page'])
  })

  it('moves and chooses with the arrows, round the ends, the count of the header following the choice', async () => {
    const container = await panel(PAGE, [ON_PAGE, IN_SPACE, ELSEWHERE])
    radio(container, 'Cette page').focus()
    press(radio(container, 'Cette page'), 'ArrowRight')
    expect(checked(container)).toBe('Cet espace')
    expect(document.activeElement).toBe(radio(container, 'Cet espace'))
    expect([count(container), titles(container)]).toEqual(['1', ['Dans l’espace']])
    press(radio(container, 'Cet espace'), 'ArrowDown')
    expect([checked(container), count(container)]).toEqual(['Toutes', '3'])
    press(radio(container, 'Toutes'), 'ArrowRight')
    expect([checked(container), count(container)]).toEqual(['Cette page', '1'])
    press(radio(container, 'Cette page'), 'End')
    expect(checked(container)).toBe('Toutes')
    press(radio(container, 'Toutes'), 'ArrowLeft')
    expect(checked(container)).toBe('Cet espace')
    // One stop of Tab: the chosen one.
    expect([...container.querySelectorAll('[role="radio"]')].map((one) => one.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })

  it('opens a note of another page in the editor, tied to its page, and the tab stays where it is', async () => {
    const container = await panel(PAGE, [ON_PAGE, IN_SPACE, ELSEWHERE])
    await click(radio(container, 'Toutes'))
    await click([...container.querySelectorAll('.lp-main')].find((row) => row.textContent?.includes('Autre page'))!)
    expect(field(container)?.value).toBe('Autre page')
    const tiedTo = [...container.querySelectorAll<HTMLInputElement>('.notes-choice input')].find((input) => input.checked)
    expect(tiedTo?.nextElementSibling?.textContent).toBe(frenchSpaces('Page : example.net'))
    expect(holder.dispatched).toEqual([])
    expect(holder.closed).toBe(0)
  })

  it('offers every note when the page chosen has none, and leaves the focus in the search once they are shown', async () => {
    const container = await panel(PAGE, [IN_SPACE, ELSEWHERE])
    expect(checked(container)).toBe('Toutes')
    await click(radio(container, 'Cette page'))
    expect(container.querySelector('.lp-body')?.textContent).toContain('Aucune note sur cette page.')
    expect(count(container)).toBe('0')
    const seeAll = button(container, 'Voir toutes les notes')
    seeAll.focus()
    await click(seeAll)
    expect(checked(container)).toBe('Toutes')
    expect(titles(container)).toEqual(['Dans l’espace', 'Autre page'])
    expect(document.activeElement).toBe(container.querySelector('.lp-head input[type="search"]'))
  })
})

describe('« Nouvelle note » and the choice of what the list shows', () => {
  it('puts the new note away when the person asks to see the notes while it holds nothing, and the panel stays', async () => {
    const container = await panel(PAGE, [ON_PAGE, IN_SPACE, ELSEWHERE], true)
    expect(field(container)).not.toBeNull()
    await click(radio(container, 'Toutes'))
    expect(field(container)).toBeNull()
    expect(holder.closed).toBe(0)
    expect(titles(container)).toEqual(['Sur la page', 'Dans l’espace', 'Autre page'])
  })

  it('keeps a note with words not saved, the list under it', async () => {
    const container = await panel(PAGE, [ON_PAGE, IN_SPACE, ELSEWHERE], true)
    type(field(container) as unknown as HTMLInputElement, 'Une idée')
    await click(radio(container, 'Toutes'))
    expect(field(container)?.value).toBe('Une idée')
    expect(checked(container)).toBe('Toutes')
    expect(titles(container)).toEqual(['Sur la page', 'Dans l’espace', 'Autre page'])
  })

  it('keeps the choice it opened on when a note is saved: the list does not change under the pointer', async () => {
    const container = await panel(PAGE, [IN_SPACE, ELSEWHERE])
    expect(checked(container)).toBe('Toutes')
    await click(button(container, 'Nouvelle note'))
    type(field(container) as unknown as HTMLInputElement, 'Pour la page')
    await act(async () => void container.querySelector('form.notes-editor')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await act(async () => {})
    expect(field(container)).toBeNull()
    // The new note is tied to the page: the page has notes now, and the list still shows them all.
    expect(holder.notes[0]).toMatchObject({ text: 'Pour la page', link: { kind: 'page', url: PAGE } })
    expect([checked(container), count(container)]).toEqual(['Toutes', '3'])
  })
})
