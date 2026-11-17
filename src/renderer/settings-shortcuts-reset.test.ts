// @vitest-environment happy-dom
// The Shortcuts pane, mounted and used: « Tout réinitialiser » can be taken back (the shortcuts the user chose are kept nowhere else), each key
// is named by its command, and the menu « Plus d’actions » is driven with the keyboard.

import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/model'
import { formatAccelerator, type ExtensionShortcuts } from '@shared/keybindings'
import { commandLabel } from '@shared/shortcut-view'
import { actionName } from './action-name'
import { ShortcutsPane } from './SettingsShortcuts'
import { button, click, mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'
import { ACTION_NOTICE_MS } from '@shared/toast'

const CHOSEN = { newWindow: 'CmdOrCtrl+Alt+J', newTab: 'CmdOrCtrl+Alt+K' }

let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

function pane(bindings: Record<string, string>) {
  const update = vi.fn<(patch: Partial<Settings>) => void>()
  const element = (next: Record<string, string>, extensions: ExtensionShortcuts[] = []) => createElement(ShortcutsPane, { bindings: next, platform: 'darwin', keyboard: {}, extensions, update })
  mounted = mount(element(bindings))
  return { container: mounted.container, update, redraw: (next: Record<string, string>, extensions?: ExtensionShortcuts[]) => mounted!.rerender(element(next, extensions)) }
}

const press = (target: Element, key: string): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

describe('« Tout réinitialiser »', () => {
  it('puts every shortcut back to its default, says so, and gives back the ones the user had chosen', async () => {
    const { container, update, redraw } = pane(CHOSEN)
    await click(button(container, t('settings-shortcuts.tout-reinitialiser')))
    expect(update).toHaveBeenLastCalledWith({ keyBindings: {} })
    redraw({})
    const notice = container.querySelector('.shortcuts-notice')!
    expect(notice.textContent).toContain(t('settings-shortcuts.raccourcis-reinitialises'))

    await click(button(container, t('settings-shortcuts.annuler-la-reinitialisation')))
    expect(update).toHaveBeenLastCalledWith({ keyBindings: CHOSEN })
    // Taken back once: the offer goes.
    expect(container.querySelector('.shortcuts-notice')!.textContent).toBe('')
  })

  it('offers the same way back from the menu « Plus d’actions »', async () => {
    const { container, update, redraw } = pane(CHOSEN)
    await click(container.querySelector(`[aria-label="${t('settings-shortcuts.plus-d-actions')}"]`)!)
    await click(button(container, t('settings-shortcuts.reinitialiser-tous-les-raccourcis')))
    expect(update).toHaveBeenLastCalledWith({ keyBindings: {} })
    redraw({})
    await click(button(container, t('settings-shortcuts.annuler-la-reinitialisation')))
    expect(update).toHaveBeenLastCalledWith({ keyBindings: CHOSEN })
  })
})

describe('« Réinitialiser » on one row', () => {
  afterEach(() => vi.useRealTimers())

  /** The pane, and the reset of the row of « Nouvelle fenêtre » clicked: the shortcut the user had chosen goes at once. */
  async function resetNewWindow() {
    const shown = pane(CHOSEN)
    await click(shown.container.querySelector(`[aria-label="${actionName(t('settings-shortcuts.reinitialiser'), commandLabel('newWindow'))}"]`)!)
    expect(shown.update).toHaveBeenLastCalledWith({ keyBindings: { newTab: CHOSEN.newTab } })
    shown.redraw({ newTab: CHOSEN.newTab })
    const notice = shown.container.querySelector('.shortcuts-notice')!
    expect(notice.textContent).toContain(t('settings-shortcuts.command-retrouve-son-raccourci-par-defaut', { command: commandLabel('newWindow') }))
    return { ...shown, notice }
  }
  /** Taken back once, the notice no longer offers it (it may say that the shortcut given back is shared, as a typed one would). */
  const undone = (container: Element): boolean => {
    const notice = container.querySelector('.shortcuts-notice')!
    return !notice.textContent!.includes(t('settings-shortcuts.annuler-la-reinitialisation')) && !notice.textContent!.includes(t('settings-shortcuts.command-retrouve-son-raccourci-par-defaut', { command: commandLabel('newWindow') }))
  }
  const undoKey = (target: EventTarget = document.body): void =>
    act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })))

  it('puts the default back at once, and « Annuler la réinitialisation » gives back the shortcut the user had chosen', async () => {
    const { container, update, notice } = await resetNewWindow()
    await click(button(notice, t('settings-shortcuts.annuler-la-reinitialisation')))
    expect(update).toHaveBeenLastCalledWith({ keyBindings: { newTab: CHOSEN.newTab, newWindow: CHOSEN.newWindow } })
    expect(undone(container)).toBe(true)
  })

  it('is taken back with ⌘Z as well, but not from a field, where ⌘Z undoes the typing', async () => {
    const { container, update } = await resetNewWindow()
    const calls = update.mock.calls.length
    undoKey(container.querySelector('input[type="search"]')!)
    expect(update.mock.calls.length).toBe(calls)
    undoKey()
    expect(update).toHaveBeenLastCalledWith({ keyBindings: { newTab: CHOSEN.newTab, newWindow: CHOSEN.newWindow } })
    expect(undone(container)).toBe(true)
  })

  it('gives the shortcut back through the rule of a typed one: an extension that took it since keeps it, and the status line says so', async () => {
    const { container, update, redraw } = await resetNewWindow()
    redraw({ newTab: CHOSEN.newTab }, [{ id: 'ext', name: 'Clipper', commands: [{ name: 'clip', description: 'Clip the page', accelerator: 'Cmd+Alt+J' }] }])
    const calls = update.mock.calls.length
    await click(button(container.querySelector('.shortcuts-notice')!, t('settings-shortcuts.annuler-la-reinitialisation')))
    expect(update.mock.calls.length).toBe(calls)
    expect(container.querySelector('.shortcuts-notice')!.textContent).toContain('Clipper')
  })

  it('offers the way back for 8 seconds, as « Rétablir » of the Settings and a deletion in a list do: then the notice goes, and ⌘Z does nothing', async () => {
    expect(ACTION_NOTICE_MS).toBe(8000)
    vi.useFakeTimers()
    const { container, update } = await resetNewWindow()
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS - 1))
    expect(container.querySelector('.shortcuts-notice')!.textContent).not.toBe('')
    act(() => void vi.advanceTimersByTime(1))
    expect(container.querySelector('.shortcuts-notice')!.textContent).toBe('')
    const calls = update.mock.calls.length
    undoKey()
    expect(update.mock.calls.length).toBe(calls)
  })

  it('waits while the pointer is on the notice, and goes with what it had left when the pointer leaves', async () => {
    vi.useFakeTimers()
    const { container } = await resetNewWindow()
    const notice = container.querySelector('.shortcuts-notice')!
    act(() => void vi.advanceTimersByTime(2000))
    pointerOver(notice)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS * 3))
    expect(notice.textContent).not.toBe('')
    pointerOut(notice)
    act(() => void vi.advanceTimersByTime(ACTION_NOTICE_MS - 2000 - 1))
    expect(notice.textContent).not.toBe('')
    act(() => void vi.advanceTimersByTime(1))
    expect(notice.textContent).toBe('')
  })
})

describe('the name a screen reader gets for the buttons of a row', () => {
  it('is the command, then its shortcut, for the key; and says which command « Réinitialiser » resets', () => {
    const { container } = pane({ newWindow: CHOSEN.newWindow })
    const keys = [...container.querySelectorAll<HTMLButtonElement>('button.shortcut-key')]
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) {
      const parts = (key.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => container.querySelector(`[id="${id}"]`))
      expect(parts, key.outerHTML).toHaveLength(2)
      // The name of the command, in the same row, then the key itself (what it shows).
      expect(parts[0]?.closest('.shortcut-row')).toBe(key.closest('.shortcut-row'))
      expect(parts[0]?.textContent).not.toBe('')
      expect(parts[1]).toBe(key)
    }
    const row = keys.find((key) => key.textContent === formatAccelerator(CHOSEN.newWindow, 'darwin'))!.closest('.shortcut-row')!
    const named = row.querySelector(`[id="${row.querySelector('button.shortcut-key')!.getAttribute('aria-labelledby')!.split(' ')[0]}"]`)!
    expect(named.textContent).toBe(commandLabel('newWindow'))
    expect(row.querySelector('button.shortcut-reset')!.getAttribute('aria-label')).toBe(actionName(t('settings-shortcuts.reinitialiser'), commandLabel('newWindow')))
    // No two keys share an id (the same command can show in two sections).
    const ids = keys.map((key) => key.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('the menu « Plus d’actions », with the keyboard', () => {
  it('takes the focus on its first entry, moves it with the arrows, and Escape closes it and gives the focus back to its button', async () => {
    // Two commands share a shortcut: both entries of the menu can be chosen.
    const { container } = pane({ newWindow: 'CmdOrCtrl+T' })
    const opener = container.querySelector<HTMLButtonElement>(`[aria-label="${t('settings-shortcuts.plus-d-actions')}"]`)!
    await click(opener)
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!
    const entries = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(entries).toHaveLength(2)
    expect(document.activeElement).toBe(entries[0])
    press(entries[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(entries[1])
    press(entries[1]!, 'ArrowDown')
    expect(document.activeElement).toBe(entries[0])

    press(entries[0]!, 'Escape')
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
