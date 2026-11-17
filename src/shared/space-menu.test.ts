// The menu of a space, opened from its header. What each row asks for, in what order, and when it can be chosen.

import { describe, expect, it } from 'vitest'
import { t } from './i18n'
import { SPACE_MENU_ENTRIES, spaceMenuEnabled, spaceMenuGroups, spaceMenuPlacement, spaceMenuRefusal, spaceMenuRun, spaceMenuShortcut, stepSpaceMenu, stepSpaceTab } from './space-menu'

describe('the rows', () => {
  it('are, in this order and these groups: rename, customise — new folder, empty Today, hide the header — manage', () => {
    expect(spaceMenuGroups().map((group) => group.map((entry) => entry.id))).toEqual([['rename', 'customize'], ['folder', 'clear', 'header'], ['manage']])
    expect(SPACE_MENU_ENTRIES().map((entry) => entry.label)).toEqual(['Renommer l’espace…', 'Personnaliser l’espace…', 'Nouveau dossier', 'Vider les onglets du jour', 'Masquer l’en-tête de l’espace', 'Gérer les espaces…'])
    expect(SPACE_MENU_ENTRIES().find((entry) => entry.id === 'customize')?.hint).toBe('icône · thème · profil')
  })

  it('shows the shortcut the user has bound, none when they removed it', () => {
    const clear = SPACE_MENU_ENTRIES().find((entry) => entry.id === 'clear')!
    expect(spaceMenuShortcut(clear, undefined)).toBe('⇧⌘K')
    expect(spaceMenuShortcut(clear, { clearToday: 'CmdOrCtrl+Alt+K' })).toBe('⌥⌘K')
    expect(spaceMenuShortcut(clear, { clearToday: '' })).toBe('')
    expect(spaceMenuShortcut(SPACE_MENU_ENTRIES().find((entry) => entry.id === 'rename')!, undefined)).toBe('')
  })
})

describe('what a row does', () => {
  it('opens the existing editor of the space for the two rows that edit it: the name in focus for "Renommer", the whole for "Personnaliser"', () => {
    expect(spaceMenuRun('rename', 's1')).toEqual({ kind: 'overlay', request: { panel: 'space', spaceId: 's1', focus: 'name' } })
    expect(spaceMenuRun('customize', 's1')).toEqual({ kind: 'overlay', request: { panel: 'space', spaceId: 's1' } })
  })

  it('opens the list of spaces for "Gérer les espaces…"', () => {
    expect(spaceMenuRun('manage', 's1')).toEqual({ kind: 'overlay', request: { panel: 'spaces' } })
  })

  it('runs an action of the store, on this space, for the other rows', () => {
    expect(spaceMenuRun('folder', 's1')).toEqual({ kind: 'dispatch', action: { type: 'folder/create', name: 'Nouveau dossier', spaceId: 's1' } })
    expect(spaceMenuRun('clear', 's1')).toEqual({ kind: 'dispatch', action: { type: 'today/clear', spaceId: 's1' } })
    expect(spaceMenuRun('header', 's1')).toEqual({ kind: 'dispatch', action: { type: 'space/header', id: 's1', visible: false } })
  })

  it('can empty Today only when it holds a tab; every other row is always there', () => {
    expect(spaceMenuEnabled('clear', { todayCount: 0 })).toBe(false)
    expect(spaceMenuEnabled('clear', { todayCount: 3 })).toBe(true)
    for (const id of ['rename', 'customize', 'folder', 'header', 'manage'] as const) expect(spaceMenuEnabled(id, { todayCount: 0 })).toBe(true)
  })
})

describe('placement and keys', () => {
  it('hangs under the button, 4 px below, pulled back inside the window', () => {
    expect(spaceMenuPlacement({ x: 8, y: 100, width: 300, height: 36 }, { width: 1360 }, 236)).toEqual({ left: 8, top: 140 })
    expect(spaceMenuPlacement({ x: 1300, y: 100, width: 40, height: 36 }, { width: 1360 }, 236)).toEqual({ left: 1360 - 236 - 8, top: 140 })
    expect(spaceMenuPlacement({ x: -20, y: 0, width: 40, height: 36 }, { width: 1360 }, 236).left).toBe(8)
  })

  it('moves over the enabled rows only, wrapping around, with Home and End', () => {
    const enabled = [true, true, false, true, true, true]
    expect(stepSpaceMenu(enabled, 1, 'ArrowDown')).toBe(3)
    expect(stepSpaceMenu(enabled, 3, 'ArrowUp')).toBe(1)
    expect(stepSpaceMenu(enabled, 5, 'ArrowDown')).toBe(0)
    expect(stepSpaceMenu(enabled, 0, 'ArrowUp')).toBe(5)
    expect(stepSpaceMenu(enabled, -1, 'ArrowDown')).toBe(0)
    expect(stepSpaceMenu(enabled, -1, 'ArrowUp')).toBe(5)
    expect(stepSpaceMenu([false, true, false], 1, 'Home')).toBe(1)
    expect(stepSpaceMenu([false, true, true], 1, 'End')).toBe(2)
    expect(stepSpaceMenu([false, false], 0, 'ArrowDown')).toBe(-1)
  })

  it('moves from one space of the footer to the next with the arrows, wrapping around', () => {
    expect(stepSpaceTab(3, 0, 'ArrowRight')).toBe(1)
    expect(stepSpaceTab(3, 2, 'ArrowRight')).toBe(0)
    expect(stepSpaceTab(3, 0, 'ArrowLeft')).toBe(2)
    expect(stepSpaceTab(0, 0, 'ArrowLeft')).toBe(-1)
  })
})

describe('the menu of a locked space', () => {
  it('greys out what changes its name, its look and its header, and a new folder, which would land in it; nothing else', () => {
    for (const id of ['rename', 'customize', 'folder', 'header'] as const) {
      expect(spaceMenuEnabled(id, { todayCount: 3, locked: true }), id).toBe(false)
      expect(spaceMenuEnabled(id, { todayCount: 3, locked: false }), id).toBe(true)
    }
    for (const id of ['clear', 'manage'] as const) expect(spaceMenuEnabled(id, { todayCount: 3, locked: true }), id).toBe(true)
  })

  it('says why a row is greyed out by the lock, with the sentence the refusal of the lock gives', () => {
    expect(spaceMenuRefusal('folder', { todayCount: 0, locked: true })).toBe(t('lock.deverrouillez-l-espace-d-abord'))
    expect(spaceMenuRefusal('rename', { todayCount: 0, locked: true })).toBe(t('lock.deverrouillez-l-espace-d-abord'))
    expect(spaceMenuRefusal('folder', { todayCount: 0, locked: false })).toBeNull()
    // « Vider » greyed out for want of a tab is not the lock's doing.
    expect(spaceMenuRefusal('clear', { todayCount: 0, locked: true })).toBeNull()
  })
})
