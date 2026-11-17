// The sidebar of one window (« Barre de cette fenêtre »): its side over the setting, the column of icons, and what a file or the interface may hand over.

import { describe, expect, it } from 'vitest'
import { compactPatch, isCompact } from './compact'
import { defaultSettings } from './model'
import { changeWindowSidebar, cleanWindowSidebar, edgeOpensFloatingSidebar, NO_WINDOW_SIDEBAR, parseWindowSidebarChange, sidebarPlacement, type WindowSidebar } from './window-sidebar'

const left = { sidebarRight: false, sidebarVisible: true }
const right = { sidebarRight: true, sidebarVisible: true }
const hidden = { sidebarRight: false, sidebarVisible: false }

describe('sidebarPlacement', () => {
  it('follows the setting for a window that chose nothing, and keeps following it when it changes (the setting is the side of new windows)', () => {
    expect(sidebarPlacement(left, NO_WINDOW_SIDEBAR)).toEqual({ right: false, docked: false, own: null })
    expect(sidebarPlacement(right, NO_WINDOW_SIDEBAR)).toEqual({ right: true, docked: false, own: null })
    expect(sidebarPlacement(right, undefined)).toEqual({ right: true, docked: false, own: null })
  })

  it('puts the sidebar of a window that chose a side there, whatever the setting says', () => {
    expect(sidebarPlacement(left, { side: 'right' })).toEqual({ right: true, docked: false, own: 'right' })
    expect(sidebarPlacement(right, { side: 'left' })).toEqual({ right: false, docked: false, own: 'left' })
  })

  it('shows the column only while the sidebar is shown: hidden, neither shape is on screen', () => {
    expect(sidebarPlacement(left, { docked: true }).docked).toBe(true)
    expect(sidebarPlacement(hidden, { docked: true }).docked).toBe(false)
  })

  it('reads only the known values of a choice handed over from elsewhere', () => {
    expect(sidebarPlacement(right, { side: 'top' } as unknown as WindowSidebar)).toEqual({ right: true, docked: false, own: null })
    expect(sidebarPlacement(left, { docked: 'yes' } as unknown as WindowSidebar).docked).toBe(false)
  })
})

describe('edgeOpensFloatingSidebar', () => {
  const choices: WindowSidebar[] = [NO_WINDOW_SIDEBAR, { side: 'right' }, { docked: true }, { side: 'right', docked: true }]

  it('opens the floating sidebar at the edge of a hidden sidebar only, docked before it was hidden or not (⌘S keeps its edge)', () => {
    for (const own of choices) expect(edgeOpensFloatingSidebar(hidden, own)).toBe(true)
    expect(edgeOpensFloatingSidebar({ sidebarRight: true, sidebarVisible: false }, { docked: true })).toBe(true)
  })

  it('opens nothing while a sidebar is on screen, in either shape: the column of a docked sidebar is not a hidden sidebar', () => {
    for (const own of choices) for (const setting of [left, right]) expect(edgeOpensFloatingSidebar(setting, own)).toBe(false)
  })

  it('never opens it for a column on screen, whatever the way the column is told apart from a hidden sidebar', () => {
    for (const own of choices) for (const setting of [left, right, hidden]) if (sidebarPlacement(setting, own).docked) expect(edgeOpensFloatingSidebar(setting, own)).toBe(false)
  })
})

describe('a docked window and the compact mode', () => {
  // Compact mode has no state of its own (compact.ts): both bars away. The edge that opens the floating sidebar is the one of any hidden sidebar.
  const compactOn = { ...defaultSettings(), compactMode: true }
  const shown = { ...compactOn, sidebarVisible: true, showToolbar: true }
  const compact = { ...compactOn, sidebarVisible: false, showToolbar: false }

  it('is not compact while its column is on screen, and its edge opens nothing (the function on, the column shown, the toolbar shown or not)', () => {
    for (const settings of [shown, { ...shown, showToolbar: false }]) {
      expect(isCompact(settings)).toBe(false)
      expect(sidebarPlacement(settings, { docked: true }).docked).toBe(true)
      expect(edgeOpensFloatingSidebar(settings, { docked: true })).toBe(false)
    }
  })

  it('stays compact as before when both bars are away, docked before or not: the edge opens the floating sidebar', () => {
    for (const own of [NO_WINDOW_SIDEBAR, { docked: true } as WindowSidebar]) {
      expect(isCompact(compact)).toBe(true)
      expect(edgeOpensFloatingSidebar(compact, own)).toBe(true)
    }
  })

  it('goes compact with the command, from a window that is docked or not, and the column is what the command puts away', () => {
    const patch = compactPatch(shown)!
    expect(patch).toEqual({ sidebarVisible: false, showToolbar: false })
    const after = { ...shown, ...patch }
    expect(isCompact(after)).toBe(true)
    expect(sidebarPlacement(after, { docked: true }).docked).toBe(false)
    expect(edgeOpensFloatingSidebar(after, { docked: true })).toBe(true)
    // The command again brings both bars back, and the column with them: nothing opens at the edge any more.
    const back = { ...after, ...compactPatch(after)! }
    expect(isCompact(back)).toBe(false)
    expect(sidebarPlacement(back, { docked: true }).docked).toBe(true)
    expect(edgeOpensFloatingSidebar(back, { docked: true })).toBe(false)
  })

  it('shows the column of a window that is compact (⌃⌘S), which then is no more compact; unfolded, the full sidebar is shown and the edge opens nothing', () => {
    const docked = changeWindowSidebar({ docked: true }, { op: 'toggle-dock' }, compact)
    expect(docked).toEqual({ own: { docked: true }, show: true })
    const shownNow = { ...compact, sidebarVisible: true }
    expect(isCompact(shownNow)).toBe(false)
    expect(edgeOpensFloatingSidebar(shownNow, docked.own)).toBe(false)
    const unfolded = changeWindowSidebar(docked.own, { op: 'dock', docked: false }, shownNow)
    expect(unfolded.own).toEqual({})
    expect(edgeOpensFloatingSidebar(shownNow, unfolded.own)).toBe(false)
  })
})

describe('changeWindowSidebar', () => {
  it('docks the sidebar and gives the full one back, without touching the side', () => {
    const docked = changeWindowSidebar({ side: 'right' }, { op: 'dock', docked: true }, left)
    expect(docked).toEqual({ own: { side: 'right', docked: true }, show: false })
    expect(changeWindowSidebar(docked.own, { op: 'dock', docked: false }, left)).toEqual({ own: { side: 'right' }, show: false })
  })

  it('shows a hidden sidebar that is docked (its column), and only then', () => {
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'dock', docked: true }, hidden).show).toBe(true)
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'dock', docked: true }, left).show).toBe(false)
    expect(changeWindowSidebar({ docked: true }, { op: 'dock', docked: false }, hidden).show).toBe(false)
  })

  it('toggles what is on screen with ⌃⌘S: a hidden sidebar that was docked comes back docked', () => {
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'toggle-dock' }, left)).toEqual({ own: { docked: true }, show: false })
    expect(changeWindowSidebar({ docked: true }, { op: 'toggle-dock' }, left)).toEqual({ own: {}, show: false })
    const own: WindowSidebar = { docked: true }
    const back = changeWindowSidebar(own, { op: 'toggle-dock' }, hidden)
    expect(back.own).toBe(own)
    expect(back.show).toBe(true)
  })

  it('chooses a side for this window, and goes back to the side of the new windows', () => {
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'side', side: 'right' }, left).own).toEqual({ side: 'right' })
    // The same side as the setting is a choice of its own all the same: the window keeps it when the setting changes.
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'side', side: 'left' }, left).own).toEqual({ side: 'left' })
    expect(changeWindowSidebar({ side: 'right', docked: true }, { op: 'side', side: null }, left).own).toEqual({ docked: true })
  })

  it('puts the sidebar on the other side than the one on screen (« Barre à droite dans cette fenêtre »)', () => {
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'toggle-side' }, left).own).toEqual({ side: 'right' })
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'toggle-side' }, right).own).toEqual({ side: 'left' })
    expect(changeWindowSidebar({ side: 'right' }, { op: 'toggle-side' }, left).own).toEqual({ side: 'left' })
  })

  it('answers the same object when nothing changes (no layout, no publication, no save)', () => {
    const own: WindowSidebar = { side: 'left', docked: true }
    expect(changeWindowSidebar(own, { op: 'dock', docked: true }, left).own).toBe(own)
    expect(changeWindowSidebar(own, { op: 'side', side: 'left' }, left).own).toBe(own)
    expect(changeWindowSidebar(NO_WINDOW_SIDEBAR, { op: 'side', side: null }, left).own).toBe(NO_WINDOW_SIDEBAR)
  })
})

describe('cleanWindowSidebar', () => {
  it('keeps the known values', () => {
    expect(cleanWindowSidebar({ side: 'right', docked: true })).toEqual({ side: 'right', docked: true })
    expect(cleanWindowSidebar({ side: 'left' })).toEqual({ side: 'left' })
    expect(cleanWindowSidebar({ docked: true })).toEqual({ docked: true })
  })

  it('drops what it does not know, and is nothing when nothing is left (the window chose nothing)', () => {
    expect(cleanWindowSidebar({ side: 'top', docked: 'true', extra: 1 })).toBeUndefined()
    expect(cleanWindowSidebar({ side: 'right', docked: false })).toEqual({ side: 'right' })
    expect(cleanWindowSidebar({})).toBeUndefined()
    for (const raw of [null, undefined, 'right', 1, true, ['right'], [{ side: 'right' }]]) expect(cleanWindowSidebar(raw), JSON.stringify(raw)).toBeUndefined()
  })
})

describe('parseWindowSidebarChange (what the interface sends)', () => {
  it('takes the four changes with values of the right kind', () => {
    expect(parseWindowSidebarChange({ op: 'dock', docked: true })).toEqual({ op: 'dock', docked: true })
    expect(parseWindowSidebarChange({ op: 'dock', docked: false })).toEqual({ op: 'dock', docked: false })
    expect(parseWindowSidebarChange({ op: 'toggle-dock' })).toEqual({ op: 'toggle-dock' })
    expect(parseWindowSidebarChange({ op: 'side', side: 'left' })).toEqual({ op: 'side', side: 'left' })
    expect(parseWindowSidebarChange({ op: 'side', side: null })).toEqual({ op: 'side', side: null })
    expect(parseWindowSidebarChange({ op: 'toggle-side' })).toEqual({ op: 'toggle-side' })
  })

  it('refuses any other shape whole', () => {
    for (const raw of [
      null,
      undefined,
      'dock',
      ['dock'],
      { op: 'dock' },
      { op: 'dock', docked: 'true' },
      { op: 'side' },
      { op: 'side', side: 'top' },
      { op: 'side', side: 1 },
      { op: 'settings/update', patch: { sidebarRight: true } },
      { op: 'hide' }
    ])
      expect(parseWindowSidebarChange(raw), JSON.stringify(raw)).toBeNull()
  })
})
