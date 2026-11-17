// @vitest-environment happy-dom
// « Changer l'icône… » of a folder, mounted in a document as a panel is: the picker of the spaces with its emoji tab alone, an emoji kept only at
// « Enregistrer », and the way back to the folder drawing.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { Folder } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { setLanguage, t } from '@shared/i18n'
import { FolderIconSheet } from './FolderIconSheet'
import { button, click, mount, settle, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn>
let closeOverlay: ReturnType<typeof vi.fn>

/** A state with one folder, wearing `icon` when it is given. */
function snapshot(icon?: string): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const folder: Folder = { id: 'dossier', name: 'Clients', spaceId: state.activeSpaceId, collapsed: false, ...(icon !== undefined ? { icon } : {}) }
  return { state: { ...state, folders: [folder] }, extensions: [], downloads: [] } as unknown as UiSnapshot
}

async function sheet(icon?: string, folderId = 'dossier'): Promise<HTMLElement> {
  dispatch = vi.fn(async () => undefined)
  closeOverlay = vi.fn()
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
    getSnapshot: async () => snapshot(icon),
    onSnapshot: () => () => undefined,
    dispatch: dispatch as never,
    closeOverlay: closeOverlay as never
  }
  window.localStorage.clear()
  mounted = mount(createElement(FolderIconSheet, { folderId }))
  await settle()
  return mounted.container
}

/** The emoji cell of the grid that shows this emoji. */
const cell = (container: Element, emoji: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('.ip-grid button')].find((one) => one.textContent === emoji)
  if (!found) throw new Error(`no cell ${emoji} in the grid`)
  return found
}

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the icon sheet of a folder', () => {
  it('draws nothing for a folder that does not exist', async () => {
    const container = await sheet(undefined, 'gone')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('offers the emoji alone: no letter, no picture, no switch between them', async () => {
    const container = await sheet()
    expect(container.querySelector('.ip-grid')).not.toBeNull()
    expect(container.querySelector('.ip-seg')).toBeNull()
    expect(container.querySelector('.ip-keys')).toBeNull()
    expect(container.querySelector('.ip-letter')).toBeNull()
    expect(container.querySelector('.ip-drop')).toBeNull()
  })

  it('does not switch to letters or to a picture with ⌘2 and ⌘3, the keys of the picker of a space', async () => {
    const container = await sheet()
    const picker = container.querySelector('.ip')!
    for (const key of ['1', '2', '3']) {
      await settle(() => void picker.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })))
      expect(container.querySelector('.ip-letter'), key).toBeNull()
      expect(container.querySelector('.ip-drop'), key).toBeNull()
      expect(container.querySelector('.ip-grid'), key).not.toBeNull()
    }
  })

  it('names the folder it is about, and says what an emoji does', async () => {
    const container = await sheet()
    expect(container.querySelector('h2')?.textContent).toBe(t('folder-icon.icone-du-dossier'))
    expect(container.textContent).toContain('Clients')
    expect(container.textContent).toContain(t('folder-icon.aide'))
  })

  it('keeps nothing until an emoji is picked, then saves it with one action and closes', async () => {
    const container = await sheet()
    expect(button(container, t('templates.enregistrer')).disabled).toBe(true)
    await click(cell(container, '📚'))
    expect(dispatch).not.toHaveBeenCalled()
    expect(cell(container, '📚').getAttribute('aria-pressed')).toBe('true')
    await click(button(container, t('templates.enregistrer')))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({ type: 'folder/icon', id: 'dossier', icon: '📚' })
    expect(closeOverlay).toHaveBeenCalled()
  })

  it('leaves the folder as it was on « Annuler »', async () => {
    const container = await sheet()
    await click(cell(container, '📚'))
    await click(button(container, t('templates.annuler')))
    expect(dispatch).not.toHaveBeenCalled()
    expect(closeOverlay).toHaveBeenCalled()
  })

  it('has nothing to take away on a folder without an icon', async () => {
    const container = await sheet()
    expect([...container.querySelectorAll('button')].some((one) => one.textContent === t('folder-icon.retirer-l-icone'))).toBe(false)
  })

  it('opens on the emoji of the folder and takes it away with « Retirer l’icône »', async () => {
    const container = await sheet('🚀')
    expect(cell(container, '🚀').getAttribute('aria-pressed')).toBe('true')
    // Nothing was changed yet: the folder can only be saved once another emoji is picked.
    expect(button(container, t('templates.enregistrer')).disabled).toBe(true)
    await click(button(container, t('folder-icon.retirer-l-icone')))
    expect(dispatch).toHaveBeenCalledWith({ type: 'folder/icon', id: 'dossier', icon: null })
    expect(closeOverlay).toHaveBeenCalled()
  })

  it('lists no letter or digit among the recent ones, which the spaces share: a folder wears an emoji only', async () => {
    window.localStorage.setItem('lucium.recent-emoji', JSON.stringify(['A', '7', '🎧']))
    dispatch = vi.fn(async () => undefined)
    closeOverlay = vi.fn()
    ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { getSnapshot: async () => snapshot(), onSnapshot: () => () => undefined, dispatch: dispatch as never, closeOverlay: closeOverlay as never }
    mounted = mount(createElement(FolderIconSheet, { folderId: 'dossier' }))
    await settle()
    const recents = [...mounted.container.querySelectorAll('.ip-recents button')].map((one) => one.textContent)
    expect(recents).toEqual(['🎧'])
  })
})
