// The command bar's entries for the sidebar of this window (« Barre de cette fenêtre »): offered when typed, worded by what is on screen, and asked of the
// main process (no reducer action: the choice is the window's, not the shared state's). Labels in French and in English.

import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { actionShortcut, actionToDispatch, rankCandidates, windowSidebarActions, windowSidebarChangeOf, type Candidate } from './command-bar'
import { createInitialState, type Ctx } from './sidebar'
import { setLanguage } from './i18n'
import type { WindowSidebar } from './window-sidebar'

const ctx: Ctx = { now: 1, newId: () => 'id' }
const state = (over: Partial<ReturnType<typeof defaultSettings>> = {}) => ({ ...createInitialState(ctx), settings: { ...defaultSettings(), ...over } })
const actions = (list: Candidate[]) => list.flatMap((c) => (c.kind === 'action' ? [[c.action, c.label]] : []))

afterEach(() => setLanguage('fr'))

describe('the entries of the sidebar of this window', () => {
  it('dock the sidebar, put it on the other side; « comme les nouvelles fenêtres » only for a window that chose a side', () => {
    expect(actions(windowSidebarActions(state(), undefined))).toEqual([
      ['toggle-dock', 'Replier la barre latérale (icônes seules)'],
      ['sidebar-right', 'Barre latérale à droite dans cette fenêtre']
    ])
    const own: WindowSidebar = { side: 'right', docked: true }
    expect(actions(windowSidebarActions(state(), own))).toEqual([
      ['toggle-dock', 'Déplier la barre latérale'],
      ['sidebar-left', 'Barre latérale à gauche dans cette fenêtre'],
      ['sidebar-follow', 'Barre latérale comme les nouvelles fenêtres']
    ])
    // At the right by the setting: the other side is the left, and there is no choice to give up.
    expect(actions(windowSidebarActions(state({ sidebarRight: true }), {})).map(([action]) => action)).toEqual(['toggle-dock', 'sidebar-left'])
  })

  it('are worded in English too', () => {
    setLanguage('en')
    expect(actions(windowSidebarActions(state(), { side: 'left', docked: true })).map(([, label]) => label)).toEqual(['Expand the sidebar', 'Sidebar on the right in this window', 'Sidebar like new windows'])
  })

  it('are offered when typed (never on an empty bar), with the window’s own choice', () => {
    const found = (query: string, own?: WindowSidebar) => actions(rankCandidates(query, state(), [], [], [], own ? { windowSidebar: own } : {})).map(([action]) => action)
    expect(found('replier')).toContain('toggle-dock')
    expect(found('barre latérale à droite')).toContain('sidebar-right')
    expect(found('déplier', { docked: true })).toContain('toggle-dock')
    expect(found('nouvelles fenêtres', { side: 'right' })).toContain('sidebar-follow')
    expect(found('nouvelles fenêtres')).not.toContain('sidebar-follow')
    expect(found('').filter((action) => ['toggle-dock', 'sidebar-left', 'sidebar-right', 'sidebar-follow'].includes(action!))).toEqual([])
  })

  it('dispatch nothing to the shared state: the bar asks the main process for the change of this window', () => {
    expect((['toggle-dock', 'sidebar-left', 'sidebar-right', 'sidebar-follow'] as const).map(windowSidebarChangeOf)).toEqual([
      { op: 'toggle-dock' },
      { op: 'side', side: 'left' },
      { op: 'side', side: 'right' },
      { op: 'side', side: null }
    ])
    expect(windowSidebarChangeOf('toggle-sidebar')).toBeNull()
    expect(windowSidebarChangeOf('name-window')).toBeNull()
  })

  it('show the keys of ⌃⌘S', () => {
    for (const action of ['toggle-dock', 'sidebar-left', 'sidebar-right', 'sidebar-follow'] as const) expect(actionToDispatch(action, state())).toBeNull()
    expect(actionShortcut('toggle-dock', state(), 'darwin')).toBe('⌃⌘S')
    expect(actionShortcut('toggle-dock', state({ keyBindings: { dockSidebar: '' } }), 'darwin')).toBeNull()
  })
})
