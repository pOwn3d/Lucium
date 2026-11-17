// @vitest-environment happy-dom
// A note given up with words in it that were not saved (Escape by reflex, « Annuler », leaving the panel) can be taken back for eight seconds (while the pointer or the focus is on the notice, it waits), as a
// deleted note can: it used to be gone at once, whatever had been typed. The panel is mounted for real; the rich text field is replaced by a plain
// one (what it draws is note-editor-dom.test.ts's).

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { givingUpLosesText, type Note } from '@shared/notes'
import { createInitialState } from '@shared/sidebar'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { click, mount, pointerOut, pointerOver, type, type Mounted } from './dom.test-support'

const NOTE: Note = { id: 'n1', text: 'Texte enregistré', createdAt: 1, updatedAt: 1 }
const holder = vi.hoisted(() => ({ snapshot: null as unknown, closed: 0 }))
vi.mock('./api', () => ({
  api: () => ({ notes: () => Promise.resolve({ ok: true, notes: [NOTE] }), closeOverlay: () => void holder.closed++, dispatch: () => Promise.resolve() }),
  useSnapshot: () => holder.snapshot
}))
vi.mock('./NoteTextEditor', async () => {
  const react = await import('react')
  return { NoteTextEditor: (props: { value: string; onChange: (text: string) => void }) => react.createElement('textarea', { 'data-field': 'note', value: props.value, onChange: (event: { target: { value: string } }) => props.onChange(event.target.value) }) }
})

import { NotesPanel } from './NotesPanel'

let mounted: Mounted | null = null
async function panel(): Promise<HTMLElement> {
  holder.snapshot = { state: createInitialState({ now: 1, newId: () => 'id' }), runtime: { tabs: {} }, extensions: [], platform: 'darwin' }
  mounted = mount(createElement(NotesPanel))
  await act(async () => {})
  return mounted.container
}
const field = (container: HTMLElement): HTMLTextAreaElement | null => container.querySelector('[data-field="note"]')
const escape = (target: Element): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
const notice = (container: HTMLElement): HTMLElement | null => container.querySelector('.lp-undo')
const done = (container: HTMLElement): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('.lp-foot button')].at(-1)!
/** Opens the saved note and types `text` in place of its own. */
async function edit(container: HTMLElement, text: string): Promise<void> {
  await click(container.querySelector('.lp-main')!)
  type(field(container) as unknown as HTMLInputElement, text)
}

beforeEach(() => {
  setLanguage('fr')
  holder.closed = 0
  vi.useFakeTimers()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('a note given up while it holds words that were not saved', () => {
  it('can be taken back after Escape: the editor comes back with what was typed', async () => {
    const container = await panel()
    await edit(container, 'Un long texte tapé')
    escape(field(container)!)
    expect(field(container)).toBeNull()
    expect(notice(container)?.textContent).toContain('Note non enregistrée abandonnée')
    await click(notice(container)!.querySelector('button')!)
    expect(field(container)?.value).toBe('Un long texte tapé')
    expect(notice(container)).toBeNull()
  })

  it('is kept as long as a notice with an action (eight seconds), no more', async () => {
    const container = await panel()
    await edit(container, 'Un long texte tapé')
    escape(field(container)!)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS))
    expect(notice(container)).toBeNull()
    expect(field(container)).toBeNull()
  })

  it('waits while the pointer is on its notice, then goes with the time it had left', async () => {
    const container = await panel()
    await edit(container, 'Un long texte tapé')
    escape(field(container)!)
    act(() => void vi.advanceTimersByTime(3000))
    pointerOver(notice(container)!)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS * 3))
    expect(notice(container)).not.toBeNull()
    pointerOut(notice(container)!)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS - 3000 - 1))
    expect(notice(container)).not.toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    expect(notice(container)).toBeNull()
  })

  it('is given up first when the panel is left, which stays open the time to take it back; leaving again closes it', async () => {
    const container = await panel()
    await edit(container, 'Un long texte tapé')
    await click(done(container))
    expect(holder.closed).toBe(0)
    expect(notice(container)?.textContent).toContain('Note non enregistrée abandonnée')
    await click(done(container))
    expect(holder.closed).toBe(1)
  })

  it('says nothing for a note left as it was saved', async () => {
    const container = await panel()
    await click(container.querySelector('.lp-main')!)
    escape(field(container)!)
    expect(field(container)).toBeNull()
    expect(notice(container)).toBeNull()
    await click(done(container))
    expect(holder.closed).toBe(1)
  })
})

describe('whether giving up a note loses words', () => {
  it('does when the note holds a text that is not the one saved', () => {
    expect(givingUpLosesText({ text: 'Nouveau' }, undefined)).toBe(true)
    expect(givingUpLosesText({ text: 'Changé' }, 'Enregistré')).toBe(true)
  })

  it('does not for an empty note, a note as it was saved, or no note', () => {
    expect(givingUpLosesText({ text: '  \n' }, undefined)).toBe(false)
    expect(givingUpLosesText({ text: 'Enregistré' }, 'Enregistré')).toBe(false)
    expect(givingUpLosesText(null, 'Enregistré')).toBe(false)
  })
})
