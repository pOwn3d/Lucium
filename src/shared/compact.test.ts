// Mode compact (Réglages › Fonctions › Mode compact): one command for both bars, and nothing at all while the function is off.

import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { compactAddress, compactLabel, compactPatch, isCompact } from './compact'
import { COMMANDS, effectiveAccelerator } from './keybindings'
import { actionToDispatch, rankCandidates } from './command-bar'
import { createInitialState, reduce, type Ctx } from './sidebar'
import { privateAction } from './private-window'
import { featureById, isFeatureOn } from './features'

const ctx: Ctx = { now: 1, newId: () => 'id' }
const look = (over: Partial<ReturnType<typeof defaultSettings>> = {}) => ({ ...defaultSettings(), ...over })
const state = (over: Partial<ReturnType<typeof defaultSettings>> = {}) => ({ ...createInitialState(ctx), settings: look(over) })

describe('the function', () => {
  it('is off by default, and registered as a feature that costs nothing', () => {
    expect(defaultSettings().compactMode).toBe(false)
    expect(isFeatureOn(look(), 'compact-mode')).toBe(false)
    expect(isFeatureOn(look({ compactMode: true }), 'compact-mode')).toBe(true)
    expect(featureById('compact-mode').cost).toEqual(['none'])
  })

  it('has a command with no default shortcut, that the user can give a key', () => {
    expect(COMMANDS.filter((c) => c.id === 'toggleCompact')).toHaveLength(1)
    expect(effectiveAccelerator('toggleCompact', {})).toBeUndefined()
    expect(effectiveAccelerator('toggleCompact', { toggleCompact: 'CmdOrCtrl+Alt+K' })).toBe('CmdOrCtrl+Alt+K')
  })
})

describe('whether a window is compact', () => {
  it('needs the function and both bars away', () => {
    expect(isCompact(look({ compactMode: true, sidebarVisible: false, showToolbar: false }))).toBe(true)
    expect(isCompact(look({ compactMode: false, sidebarVisible: false, showToolbar: false }))).toBe(false)
    expect(isCompact(look({ compactMode: true, sidebarVisible: true, showToolbar: false }))).toBe(false)
    expect(isCompact(look({ compactMode: true, sidebarVisible: false, showToolbar: true }))).toBe(false)
    expect(isCompact(look({ compactMode: true }))).toBe(false)
  })
})

describe('the command', () => {
  it('puts both bars away from any other layout, and brings both back from the compact one', () => {
    for (const [sidebarVisible, showToolbar] of [[true, true], [true, false], [false, true]] as const) {
      expect(compactPatch(look({ compactMode: true, sidebarVisible, showToolbar }))).toEqual({ sidebarVisible: false, showToolbar: false })
    }
    expect(compactPatch(look({ compactMode: true, sidebarVisible: false, showToolbar: false }))).toEqual({ sidebarVisible: true, showToolbar: true })
  })

  it('does nothing while the function is off', () => {
    expect(compactPatch(look({ compactMode: false }))).toBeNull()
    const off = state()
    expect(reduce(off, { type: 'compact/toggle' }, ctx)).toBe(off)
  })

  it('changes the two settings of the window and nothing else, there and back', () => {
    const on = state({ compactMode: true })
    const compact = reduce(on, { type: 'compact/toggle' }, ctx)
    expect(compact.settings).toEqual({ ...on.settings, sidebarVisible: false, showToolbar: false })
    expect(compact.tabs).toBe(on.tabs)
    const back = reduce(compact, { type: 'compact/toggle' }, ctx)
    expect(back.settings).toEqual(on.settings)
  })

  it('leaves the existing commands as they are: showing the sidebar ends the compact mode, and the command hides both again', () => {
    const compact = reduce(state({ compactMode: true }), { type: 'compact/toggle' }, ctx)
    const shown = reduce(compact, { type: 'settings/update', patch: { sidebarVisible: true } }, ctx)
    expect(isCompact(shown.settings)).toBe(false)
    expect(reduce(shown, { type: 'compact/toggle' }, ctx).settings).toMatchObject({ sidebarVisible: false, showToolbar: false })
  })

  it('says what it will do', () => {
    expect(compactLabel(false)).toBe('Passer en mode compact')
    expect(compactLabel(true)).toBe('Quitter le mode compact')
  })

  it('is accepted by a private window, which only has its own layout to change', () => {
    expect(privateAction({ type: 'compact/toggle' })).toEqual({ type: 'compact/toggle' })
  })
})

describe('the command bar', () => {
  const offers = (s: ReturnType<typeof state>) => rankCandidates('compact', s, []).filter((c) => c.kind === 'action' && c.action === 'toggle-compact')

  it('offers it when typed, only with the function on, in the wording of what it does', () => {
    expect(offers(state())).toHaveLength(0)
    const [on] = offers(state({ compactMode: true }))
    expect(on).toMatchObject({ kind: 'action', label: 'Passer en mode compact' })
    const [leave] = offers(state({ compactMode: true, sidebarVisible: false, showToolbar: false }))
    expect(leave).toMatchObject({ label: 'Quitter le mode compact' })
  })

  it('runs the reducer action, and nothing while the function is off', () => {
    expect(actionToDispatch('toggle-compact', state({ compactMode: true }))).toEqual({ type: 'compact/toggle' })
    expect(actionToDispatch('toggle-compact', state())).toBeNull()
  })
})

describe('the address shown in place of the tab', () => {
  it('is the site’s name, or the whole address when the toolbar shows it whole', () => {
    expect(compactAddress('https://www.exemple.fr/chemin/page?q=1#haut', false)).toBe('exemple.fr')
    expect(compactAddress('https://www.exemple.fr/chemin/page?q=1#haut', true)).toBe('exemple.fr/chemin/page?q=1#haut')
    expect(compactAddress('https://exemple.fr/', true)).toBe('exemple.fr')
  })

  it('falls back to the text itself for what is no web address', () => {
    expect(compactAddress('about:blank', false)).toBe('about:blank')
    expect(compactAddress('pas une adresse', true)).toBe('pas une adresse')
  })
})
