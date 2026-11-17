// @vitest-environment happy-dom
// « Rétablir » goes with what it did: on a row, the button leaves once the setting is back to its default; in « Réglages modifiés », the whole row.
// The focus was then on nothing, and the « Annuler » of the notice (8 s) out of reach of the keyboard. It is given to that « Annuler », the notice waits
// while it holds the focus (or the pointer is on it), and « Annuler » gives the focus back to the row, or to the content when the row is not shown.
// The rows are menus, not switches: the document of the tests hands a click inside a <label> to the first control it labels, which a browser does not.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState, type Action } from '@shared/sidebar'
import { click, installBridge, mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { SettingsView } from './SettingsWindow'

let mounted: Mounted | null = null
let dispatch: ReturnType<typeof vi.fn<(action: Action) => Promise<void>>>

function snapshotWith(patch: Partial<Settings> = {}): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'space' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' } as unknown as UiSnapshot
}

async function open(hash: string, snapshot: UiSnapshot, view: 'page' | 'modified' = 'page'): Promise<HTMLElement> {
  location.hash = hash
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
  mounted = mount(createElement(SettingsView, { snapshot, initialView: view }))
  return mounted.container
}

/** The settings arrive from the main process after the write: the window is drawn again with them. */
const arrive = (snapshot: UiSnapshot, view: 'page' | 'modified' = 'page'): void => mounted!.rerender(createElement(SettingsView, { snapshot, initialView: view }))

const rowOf = (window: HTMLElement, key: string): HTMLElement => window.querySelector<HTMLElement>(`main [data-setting~="${key}"]:not([data-mirror]):not(section)`)!
const undo = (window: HTMLElement): HTMLButtonElement | undefined => [...window.querySelectorAll<HTMLButtonElement>('.settings-toast button')].find((button) => button.textContent === t('settings.annuler'))

beforeEach(() => {
  setLanguage('fr')
  dispatch = vi.fn(async () => undefined)
  installBridge({ dispatch })
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the focus after « Rétablir »', () => {
  it('goes to « Annuler » of the notice when the button of a row leaves with its change', async () => {
    const window = await open('#appearance', snapshotWith({ interfaceAppearance: 'dark' }))
    // A row at the top of its page, not in « Plus de réglages », where a browser would give no focus.
    expect(rowOf(window, 'interfaceAppearance').closest('[hidden]')).toBeNull()
    const reset = rowOf(window, 'interfaceAppearance').querySelector<HTMLButtonElement>('.pref-reset')!
    reset.focus()
    await click(reset)
    arrive(snapshotWith())
    expect(rowOf(window, 'interfaceAppearance').querySelector('.pref-reset')).toBeNull()
    expect(document.activeElement).toBe(undo(window))
  })

  it('goes to « Annuler » in « Réglages modifiés », where the row put back leaves the list', async () => {
    const window = await open('#general', snapshotWith({ interfaceAppearance: 'dark', restoreWindows: false }), 'modified')
    const reset = rowOf(window, 'interfaceAppearance').querySelector<HTMLButtonElement>('.pref-reset')!
    reset.focus()
    await click(reset)
    arrive(snapshotWith({ restoreWindows: false }), 'modified')
    expect(rowOf(window, 'interfaceAppearance').closest('[hidden]')).not.toBeNull()
    expect(document.activeElement).toBe(undo(window))
  })

  it('goes to « Annuler » after « Rétablir » of a page (greyed then: a browser takes the focus off it) and « Tout rétablir »', async () => {
    const page = await open('#appearance', snapshotWith({ interfaceAppearance: 'dark' }))
    const pageReset = page.querySelector<HTMLButtonElement>('main .reset-bar button')!
    pageReset.focus()
    await click(pageReset)
    arrive(snapshotWith())
    expect(page.querySelector<HTMLButtonElement>('main .reset-bar button')?.disabled).toBe(true)
    expect(document.activeElement).toBe(undo(page))
    mounted!.unmount()

    const all = await open('#general', snapshotWith({ interfaceAppearance: 'dark', restoreWindows: false }), 'modified')
    const everything = [...all.querySelectorAll<HTMLButtonElement>('main .reset-bar button')].find((button) => button.textContent === t('settings.tout-retablir'))!
    everything.focus()
    await click(everything)
    arrive(snapshotWith(), 'modified')
    expect(document.activeElement).toBe(undo(all))
  })

  it('comes back to the row with « Annuler », or to the content when the row is hidden', async () => {
    const page = await open('#appearance', snapshotWith({ interfaceAppearance: 'dark' }))
    const reset = rowOf(page, 'interfaceAppearance').querySelector<HTMLButtonElement>('.pref-reset')!
    reset.focus()
    await click(reset)
    arrive(snapshotWith())
    await click(undo(page)!)
    expect(page.querySelector('.settings-toast')).toBeNull()
    expect(rowOf(page, 'interfaceAppearance').contains(document.activeElement)).toBe(true)
    mounted!.unmount()

    const changed = await open('#general', snapshotWith({ interfaceAppearance: 'dark', restoreWindows: false }), 'modified')
    const inList = rowOf(changed, 'interfaceAppearance').querySelector<HTMLButtonElement>('.pref-reset')!
    inList.focus()
    await click(inList)
    arrive(snapshotWith({ restoreWindows: false }), 'modified')
    await click(undo(changed)!)
    expect(document.activeElement).toBe(changed.querySelector('main.settings-content'))
  })

  it('waits while « Annuler » has the focus, and lets the notice go once the focus has left, with the time it had left', async () => {
    const window = await open('#appearance', snapshotWith({ interfaceAppearance: 'dark' }))
    vi.useFakeTimers()
    const reset = rowOf(window, 'interfaceAppearance').querySelector<HTMLButtonElement>('.pref-reset')!
    reset.focus()
    await click(reset)
    arrive(snapshotWith())
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS * 3 + 100))
    expect(undo(window)).toBeDefined()
    act(() => (window.querySelector<HTMLElement>('main.settings-content')!.focus()))
    // The notice was held from the first moment (the focus went to « Annuler » with it): it has all its time left.
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS - 1))
    expect(window.querySelector('.settings-toast')).not.toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    expect(window.querySelector('.settings-toast')).toBeNull()
  })

  it('waits while the pointer is on the notice', async () => {
    const window = await open('#appearance', snapshotWith({ interfaceAppearance: 'dark' }))
    vi.useFakeTimers()
    await click(rowOf(window, 'interfaceAppearance').querySelector<HTMLButtonElement>('.pref-reset')!)
    act(() => (window.querySelector<HTMLElement>('main.settings-content')!.focus()))
    pointerOver(window.querySelector('.settings-toast')!)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS * 3))
    expect(window.querySelector('.settings-toast')).not.toBeNull()
    pointerOut(window.querySelector('.settings-toast')!)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS))
    expect(window.querySelector('.settings-toast')).toBeNull()
  })

  it('still lets the notice go after its 8 s when the focus is elsewhere', async () => {
    const window = await open('#appearance', snapshotWith({ interfaceAppearance: 'dark' }))
    vi.useFakeTimers()
    await click(rowOf(window, 'interfaceAppearance').querySelector<HTMLButtonElement>('.pref-reset')!)
    act(() => (window.querySelector<HTMLElement>('main.settings-content')!.focus()))
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS + 100))
    expect(window.querySelector('.settings-toast')).toBeNull()
  })
})
