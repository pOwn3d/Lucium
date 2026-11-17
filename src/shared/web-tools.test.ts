import { describe, expect, it } from 'vitest'
import { COMMANDS, effectiveAccelerator, findConflicts } from './keybindings'
import { menuKey, NO_FACTS } from './menu-state'
import { defaultSettings } from './model'
import { canOpenInPrivate, inheritedSettings, privateAction } from './private-window'
import { createInitialState, reduce, type Action } from './sidebar'
import { WEB_TOOL_SWITCHES, cleanWebToolsSettings } from './web-tools'

const ctx = { now: 1, newId: () => 'id' }
const initial = () => createInitialState({ now: 1, newId: () => 'x' })
const update = (patch: Record<string, unknown>): Action => ({ type: 'settings/update', patch: patch as never })

describe('the optional web tools', () => {
  it('are all off by default: the default appearance and behaviour do not change', () => {
    const settings = defaultSettings()
    for (const key of WEB_TOOL_SWITCHES) expect(settings[key], key).toBe(false)
    expect(settings.mouseGestureExcludedHosts).toEqual([])
    expect(settings.pageWatches).toEqual([])
    expect(initial().settings).toMatchObject(Object.fromEntries(WEB_TOOL_SWITCHES.map((key) => [key, false])))
  })

  it('list the seven switches, each a setting of the model', () => {
    expect([...WEB_TOOL_SWITCHES].sort()).toEqual(['autoScroll', 'batterySaver', 'mouseGestures', 'pageWatch', 'qrCode', 'readAloud', 'scrollSync'])
  })

  it('are on only when the file holds exactly true: a string, a number or nothing is off', () => {
    for (const bad of ['true', 'yes', 1, 'on', {}, [], null, undefined, 0]) {
      const cleaned = cleanWebToolsSettings({ ...defaultSettings(), ...Object.fromEntries(WEB_TOOL_SWITCHES.map((key) => [key, bad])) } as never)
      for (const key of WEB_TOOL_SWITCHES) expect(cleaned[key], `${key}: ${String(bad)}`).toBe(false)
    }
    const on = cleanWebToolsSettings({ ...defaultSettings(), ...Object.fromEntries(WEB_TOOL_SWITCHES.map((key) => [key, true])) } as never)
    for (const key of WEB_TOOL_SWITCHES) expect(on[key]).toBe(true)
  })

  it('clean the lists they keep: sites left out are hosts, watches are well formed pages', () => {
    const cleaned = cleanWebToolsSettings({
      ...defaultSettings(),
      mouseGestureExcludedHosts: ['Maps.Example.org', 'https://www.draw.io/x', 'not a host', 42, 'maps.example.org'] as never,
      pageWatches: [{ id: 'a', url: 'https://example.org/', title: 'A', profileId: 'default', minutes: 1 }, { id: 'b', url: 'file:///etc/passwd', title: 'B', profileId: 'default', minutes: 60 }] as never
    })
    expect(cleaned.mouseGestureExcludedHosts).toEqual(['maps.example.org', 'draw.io'])
    expect(cleaned.pageWatches).toEqual([{ id: 'a', url: 'https://example.org/', title: 'A', profileId: 'default', minutes: 5 }])
  })

  it('go through the reducer\'s repair of the settings, whatever the interface sends', () => {
    const state = reduce(initial(), update({ qrCode: 'oui', autoScroll: true, mouseGestureExcludedHosts: 'x', pageWatches: [{ id: 'a', url: 'javascript:1' }] }), ctx)
    expect(state.settings.qrCode).toBe(false)
    expect(state.settings.autoScroll).toBe(true)
    expect(state.settings.mouseGestureExcludedHosts).toEqual([])
    expect(state.settings.pageWatches).toEqual([])
  })
})

describe('a private window', () => {
  it('cannot switch a web tool, nor add a watch, from its own interface (these settings are the main window\'s)', () => {
    for (const patch of [{ qrCode: true }, { pageWatch: true }, { pageWatches: [{ id: 'a', url: 'https://example.org/', title: 'A', profileId: 'default', minutes: 60 }] }, { mouseGestureExcludedHosts: ['example.org'] }, { batterySaver: true }]) {
      expect(privateAction(update(patch)), JSON.stringify(patch)).toBeNull()
    }
  })

  it('follows the main window\'s tools (they are not the layout of one window)', () => {
    const main = { ...defaultSettings(), qrCode: true, autoScroll: true }
    expect(inheritedSettings(main)).toMatchObject({ qrCode: true, autoScroll: true })
  })

  it('may show the QR code of its page: it keeps nothing', () => {
    expect(canOpenInPrivate('qr')).toBe(true)
  })
})

describe('the menus', () => {
  it('are rebuilt when a web tool that adds an entry is switched', () => {
    const state = initial()
    const base = menuKey(state, [], NO_FACTS)
    for (const key of ['qrCode', 'pageWatch', 'scrollSync', 'batterySaver'] as const) {
      expect(menuKey({ ...state, settings: { ...state.settings, [key]: true } }, [], NO_FACTS), key).not.toBe(base)
    }
    expect(menuKey({ ...state, settings: { ...state.settings, autoScroll: true } }, [], NO_FACTS)).toBe(base)
  })

  it('are rebuilt when the split view starts or stops scrolling together, and when the mode is asked for', () => {
    const state = initial()
    expect(menuKey(state, [], { ...NO_FACTS, scrollSynced: true })).not.toBe(menuKey(state, [], NO_FACTS))
    expect(menuKey(state, [], { ...NO_FACTS, saverAsked: true })).not.toBe(menuKey(state, [], NO_FACTS))
  })

  it('give their shortcuts to the user: no accelerator by default, and none in conflict', () => {
    for (const id of ['qrCode', 'watchPage', 'scrollSync', 'batterySaver']) {
      expect(COMMANDS.filter((c) => c.id === id), id).toHaveLength(1)
      expect(effectiveAccelerator(id, {}), id).toBeUndefined()
    }
    expect(findConflicts({ qrCode: 'CmdOrCtrl+Alt+Q', watchPage: 'CmdOrCtrl+Alt+Q' })).toEqual({ 'CmdOrCtrl+Alt+Q': ['qrCode', 'watchPage'] })
  })
})
