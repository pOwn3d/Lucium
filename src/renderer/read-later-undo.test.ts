// @vitest-environment happy-dom
// « Lire plus tard », what a click cannot lose any more: a page deleted and the list emptied can be taken back for eight seconds (they wait while the pointer
// or the focus is on the notice), as in the other lists (nothing else keeps a copy of this list); the second click of a double click on « Tout effacer » lands on « Annuler »; and with the
// folders, the field of a new folder has a name and the order of the pages can be changed without a pointer.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { ReadLaterItem, SidebarState } from '@shared/model'
import { moveReadLater, readLaterStep } from '@shared/read-later'
import { createInitialState } from '@shared/sidebar'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { click, mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, dispatched: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({ dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()), closeOverlay: () => undefined }),
  useSnapshot: () => holder.snapshot
}))

import { ReadLater } from './ReadLater'

const item = (id: string, folderId?: string): ReadLaterItem => ({ id, url: `https://exemple.fr/${id}`, title: `Page ${id}`, savedAt: 1, ...(folderId ? { folderId } : {}) })

let mounted: Mounted | null = null
function panel(change: (state: SidebarState) => SidebarState): HTMLElement {
  holder.snapshot = { state: change(createInitialState({ now: 1, newId: () => 'id' })), runtime: { tabs: {} }, extensions: [], platform: 'darwin' }
  mounted = mount(createElement(ReadLater))
  return mounted.container
}
const titles = (container: HTMLElement): string[] => [...container.querySelectorAll('.readlater-title')].map((node) => node.textContent ?? '')
const button = (container: HTMLElement, action: string, row?: string): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`${row ? `[data-id="${row}"] ` : ''}[data-action="${action}"]`)!
const wait = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))

beforeEach(() => {
  setLanguage('fr')
  holder.dispatched = []
  vi.useFakeTimers()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('a page deleted from « Lire plus tard »', () => {
  const three = (state: SidebarState): SidebarState => ({ ...state, readLater: [item('a'), item('b'), item('c')] })

  it('leaves the list at once, with a notice that takes it back: nothing is deleted yet', async () => {
    const container = panel(three)
    await click(button(container, 'remove', 'b'))
    expect(titles(container)).toEqual(['Page a', 'Page c'])
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Page b')
    expect(holder.dispatched).toEqual([])
    await click(button(container, 'undo'))
    expect(titles(container)).toEqual(['Page a', 'Page b', 'Page c'])
    wait(ACTION_NOTICE_MS * 2)
    expect(holder.dispatched).toEqual([])
  })

  it('waits while the pointer or the focus is on its notice, and goes on with what it had left', async () => {
    const container = panel(three)
    await click(button(container, 'remove', 'b'))
    wait(5000)
    const notice = container.querySelector<HTMLElement>('.readlater-undo')!
    pointerOver(notice)
    wait(ACTION_NOTICE_MS * 3)
    expect(holder.dispatched).toEqual([])
    expect(titles(container)).toEqual(['Page a', 'Page c'])
    act(() => button(container, 'undo').focus())
    pointerOut(notice)
    wait(ACTION_NOTICE_MS * 3)
    expect(holder.dispatched).toEqual([])
    act(() => button(container, 'remove', 'a').focus())
    wait(ACTION_NOTICE_MS - 5000 - 1)
    expect(holder.dispatched).toEqual([])
    wait(1)
    expect(holder.dispatched).toEqual([{ type: 'readlater/remove', id: 'b' }])
  })

  it('is deleted for good once the delay has passed, or when the panel is left', async () => {
    const container = panel(three)
    await click(button(container, 'remove', 'b'))
    wait(ACTION_NOTICE_MS)
    expect(holder.dispatched).toEqual([{ type: 'readlater/remove', id: 'b' }])
    await click(button(container, 'remove', 'a'))
    mounted!.unmount()
    mounted = null
    expect(holder.dispatched).toEqual([{ type: 'readlater/remove', id: 'b' }, { type: 'readlater/remove', id: 'a' }])
  })
})

describe('« Tout effacer »', () => {
  const two = (state: SidebarState): SidebarState => ({ ...state, readLater: [item('a'), item('b')] })

  it('puts « Annuler » where the first click was: a double click empties nothing', async () => {
    const container = panel(two)
    const foot = button(container, 'clear').parentElement!
    expect(foot.querySelector('button')).toBe(button(container, 'clear'))
    await click(button(container, 'clear'))
    const first = container.querySelector('.row.between button')!
    expect(first.getAttribute('data-action')).toBe('clear-cancel')
    await click(first)
    expect(titles(container)).toEqual(['Page a', 'Page b'])
    expect(holder.dispatched).toEqual([])
  })

  it('empties the list once confirmed, and can be taken back for eight seconds', async () => {
    const container = panel(two)
    await click(button(container, 'clear'))
    await click(button(container, 'clear-confirm'))
    expect(titles(container)).toEqual([])
    expect(container.querySelector('[role="status"]')?.textContent).toContain('La liste a été vidée.')
    expect(holder.dispatched).toEqual([])
    await click(button(container, 'undo'))
    expect(titles(container)).toEqual(['Page a', 'Page b'])
    await click(button(container, 'clear'))
    await click(button(container, 'clear-confirm'))
    wait(ACTION_NOTICE_MS)
    expect(holder.dispatched).toEqual([{ type: 'readlater/clear' }])
  })
})

describe('« Lire plus tard » with its folders', () => {
  const filed = (state: SidebarState): SidebarState => ({
    ...state,
    settings: { ...state.settings, useReadLaterFolders: true },
    readLaterFolders: [{ id: 'f1', name: 'À lire' }],
    readLater: [item('a', 'f1'), item('b', 'f1'), item('c', 'f1'), item('loose')]
  })

  it('names the field of a new folder: a placeholder is no name', async () => {
    const container = panel(filed)
    await click(button(container, 'new-folder'))
    expect(container.querySelector('[data-field="new-folder"]')?.getAttribute('aria-label')).toBe('Nom du nouveau dossier')
  })

  it('moves a page up and down in its folder with two named buttons, off at the ends', async () => {
    const container = panel(filed)
    expect(button(container, 'move-up', 'b').getAttribute('aria-label')).toBe('Monter Page b')
    expect(button(container, 'move-up', 'a').disabled).toBe(true)
    expect(button(container, 'move-down', 'c').disabled).toBe(true)
    expect(button(container, 'move-down', 'loose').disabled).toBe(true)
    await click(button(container, 'move-up', 'b'))
    await click(button(container, 'move-down', 'a'))
    await click(button(container, 'move-down', 'b'))
    expect(holder.dispatched).toEqual([
      { type: 'readlater/move', id: 'b', folderId: 'f1', beforeId: 'a' },
      { type: 'readlater/move', id: 'a', folderId: 'f1', beforeId: 'c' },
      { type: 'readlater/move', id: 'b', folderId: 'f1', beforeId: null }
    ])
  })

  it('has no such buttons without the folders, where the list has one order: the newest first', () => {
    const container = panel((state) => ({ ...state, readLater: [item('a'), item('b')] }))
    expect(container.querySelector('[data-action="move-up"]')).toBeNull()
  })
})

describe('the step of a page among those of its group', () => {
  const group = [item('a', 'f1'), item('b', 'f1'), item('c', 'f1')]
  const folders = [{ id: 'f1', name: 'À lire' }]
  const after = (id: string, direction: 'up' | 'down'): string[] => {
    const step = readLaterStep(group, id, direction)
    return step ? moveReadLater(group, folders, id, 'f1', step.beforeId).map((each) => each.id) : group.map((each) => each.id)
  }

  it('is one place, as the reducer reads it', () => {
    expect(after('b', 'up')).toEqual(['b', 'a', 'c'])
    expect(after('b', 'down')).toEqual(['a', 'c', 'b'])
    expect(after('a', 'down')).toEqual(['b', 'a', 'c'])
    expect(after('c', 'up')).toEqual(['a', 'c', 'b'])
  })

  it('is none at the ends, or for a page that is not of the group', () => {
    expect(readLaterStep(group, 'a', 'up')).toBeNull()
    expect(readLaterStep(group, 'c', 'down')).toBeNull()
    expect(readLaterStep(group, 'x', 'down')).toBeNull()
  })
})
