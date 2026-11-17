// @vitest-environment happy-dom
// « Source du dossier en direct », mounted in a document as a panel is: the first render has no snapshot, which arrives a moment later. The fields
// must start from the source and the name of the folder once it is there, not from the nothing of the first render.

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { t } from '@shared/i18n'
import { LiveFolderSheet } from './LiveFolderSheet'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn>

/** A state with one live folder that follows the pull requests of a repository. */
function snapshot(): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const folder = { id: 'live', name: 'Mes revues', spaceId: state.activeSpaceId, live: { source: { kind: 'github', repo: 'owner/name', what: 'pulls' }, items: [] } }
  return { state: { ...state, settings: { ...state.settings, liveFolders: true }, folders: [folder] }, extensions: [], downloads: [] } as unknown as UiSnapshot
}

/** Mounts the sheet; the snapshot is answered only when `arrive` is called, as the main process answers after the first draw. */
function sheet(folderId?: string): { container: HTMLElement; arrive: () => Promise<void> } {
  let answer: (value: UiSnapshot) => void = () => undefined
  dispatch = vi.fn(async () => undefined)
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
    getSnapshot: () => new Promise<UiSnapshot>((resolve) => (answer = resolve)),
    onSnapshot: () => () => undefined,
    dispatch: dispatch as never,
    closeOverlay: (() => undefined) as never
  }
  mounted = mount(createElement(LiveFolderSheet, folderId ? { folderId } : {}))
  return { container: mounted.container, arrive: () => settle(() => answer(snapshot())) }
}

const field = (container: Element, name: string): HTMLInputElement | HTMLSelectElement | null => container.querySelector(`[data-field="${name}"]`)

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the sheet of a live folder opened on a folder', () => {
  it('draws nothing before the first snapshot, then the source, what is followed and the name of the folder', async () => {
    const { container, arrive } = sheet('live')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await arrive()
    expect(field(container, 'source')!.value).toBe('owner/name')
    expect(field(container, 'what')!.value).toBe('pulls')
    expect(field(container, 'name')!.value).toBe('Mes revues')
    // Nothing has to be typed again: the folder can be saved as it is, or after one change.
    expect(button(container, t('templates.enregistrer')).disabled).toBe(false)
  })

  it('sends the change of the name alone with the source the folder had', async () => {
    const { container, arrive } = sheet('live')
    await arrive()
    type(field(container, 'name') as HTMLInputElement, 'Revues')
    await click(button(container, t('templates.enregistrer')))
    expect(dispatch).toHaveBeenCalledWith({ type: 'livefolder/edit', id: 'live', source: { kind: 'github', repo: 'owner/name', what: 'pulls' }, name: 'Revues' })
  })

  it('opens empty for a new folder', async () => {
    const { container, arrive } = sheet()
    await arrive()
    expect(field(container, 'source')!.value).toBe('')
    expect(field(container, 'name')!.value).toBe('')
    expect(button(container, t('live-folder-sheet.creer-le-dossier')).disabled).toBe(true)
  })
})
