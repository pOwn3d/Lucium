// A line of the command bar says the shortcut of its command as it is set now. The key used to be part of the text: « Capturer une zone » read
// ⌥⌘Z, a key that never was its shortcut (⇧⌘2 is), and every other one stayed after a change in Réglages › Raccourcis.

import { describe, expect, it } from 'vitest'
import { actionDetail, rankCandidates, type CommandAction } from './command-bar'
import { COMMANDS, effectiveAccelerator, formatAccelerator } from './keybindings'
import { en } from './i18n-en'
import { fr } from './i18n-fr'
import { createInitialState, reduce, type Ctx } from './sidebar'
import type { SidebarState } from './model'
import type { PlatformId } from './platform'
import source from './command-bar-shortcuts.ts?raw'

let n = 0
const ctx: Ctx = { now: 1, newId: () => `id${++n}` }
const withTab = (): SidebarState => reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://exemple.org/' }, ctx)
const bound = (state: SidebarState, keyBindings: Record<string, string>): SidebarState => reduce(state, { type: 'settings/update', patch: { keyBindings } }, ctx)
const detailOf = (state: SidebarState, query: string, action: CommandAction, platform: PlatformId | null = 'darwin'): string | undefined =>
  rankCandidates(query, state, [], [], [], platform ? { platform } : {}).find((c) => c.kind === 'action' && c.action === action)?.detail

describe('the shortcut a line of the command bar shows', () => {
  // The keys follow the system the bar is drawn for: the Command key and its symbols do not exist away from macOS, where the main modifier is Ctrl.
  it('is drawn with Ctrl and words away from macOS, and with no key at all when the system is not known', () => {
    expect(detailOf(withTab(), 'rechercher dans la page', 'find', 'linux')).toBe('Action · Ctrl+F')
    expect(detailOf(withTab(), 'capturer une zone', 'capture-region', 'win32')).toBe('Action · Ctrl+Maj+2')
    expect(detailOf(withTab(), 'rechercher dans la page', 'find', null)).toBe('Action')
    for (const platform of ['linux', 'win32'] as const) {
      for (const action of ['find', 'capture', 'capture-region', 'capture-full', 'archive', 'site-info', 'settings'] as const) {
        expect(detailOf(withTab(), action === 'settings' ? 'réglages' : action === 'site-info' ? 'infos et réglages du site' : action === 'archive' ? 'ouvrir l’archive' : action === 'capture' ? 'capturer la partie visible' : action === 'capture-region' ? 'capturer une zone' : action === 'capture-full' ? 'capturer la page entière' : 'rechercher dans la page', action, platform) ?? '', `${action} on ${platform}`).not.toMatch(/[⌘⌥⌃⇧]/)
      }
    }
  })

  it('is the real one of « Capturer une zone », ⇧⌘2', () => {
    expect(effectiveAccelerator('captureRegion', {})).toBe('CmdOrCtrl+Shift+2')
    expect(detailOf(withTab(), 'capturer une zone', 'capture-region')).toBe('Action · ⇧⌘2')
  })

  it('is the default one of each command that shows a key', () => {
    const state = withTab()
    expect(detailOf(state, 'rechercher dans la page', 'find')).toBe('Action · ⌘F')
    expect(detailOf(state, 'capturer la partie visible', 'capture')).toBe('Action · ⌥⌘S')
    expect(detailOf(state, 'capturer la page entière', 'capture-full')).toBe('Action · ⌥⇧⌘S')
    expect(detailOf(state, 'ouvrir l’archive', 'archive')).toBe('Action · ⌥⌘A')
    expect(detailOf(state, 'infos et réglages du site', 'site-info')).toBe('Action · ⇧⌘I')
    expect(detailOf(state, 'réglages', 'settings')).toBe('Action · ⌘,')
    expect(detailOf(state, 'effacer les données du site', 'clear-site-data')).toBe('Action · ⇧⌘X')
  })

  it('follows a shortcut changed in the Settings', () => {
    const state = bound(withTab(), { find: 'CmdOrCtrl+Alt+K', captureRegion: 'CmdOrCtrl+Shift+7', clearSiteData: 'CmdOrCtrl+Alt+Shift+K' })
    expect(detailOf(state, 'rechercher dans la page', 'find')).toBe('Action · ⌥⌘K')
    expect(detailOf(state, 'capturer une zone', 'capture-region')).toBe('Action · ⇧⌘7')
    expect(detailOf(state, 'effacer les données du site', 'clear-site-data')).toBe('Action · ⌥⇧⌘K')
  })

  it('is left out for a command the user left without a shortcut', () => {
    const state = bound(withTab(), { find: '', settings: '' })
    expect(detailOf(state, 'rechercher dans la page', 'find')).toBe('Action')
    expect(detailOf(state, 'réglages', 'settings')).toBe('Action')
    expect(actionDetail('edit-space', state, 'darwin')).toBe('Action')
  })
})

describe('the texts of the command bar', () => {
  const symbols = /[⌘⌥⌃⇧]/

  it('carry no key of a command that can be changed: the key comes from the shortcuts in force', () => {
    for (const catalogue of [fr, en]) {
      const written = Object.entries(catalogue).filter(([key, text]) => key.startsWith('cmd.action') && symbols.test(String(text)))
      expect(written).toEqual([])
    }
    expect(source.match(/t\('cmd\.action-[a-z0-9-]+'\)/g)?.filter((call) => call !== "t('cmd.action-raccourci')") ?? []).toEqual([])
  })

  it('name a shortcut that exists, for every command of the bar that has one', () => {
    // Every id of ACTION_SHORTCUT is a command of the table (a renamed command would leave its line without its key).
    const ids = [...source.slice(source.indexOf('const ACTION_SHORTCUT'), source.indexOf('export function actionShortcut')).matchAll(/: '([A-Za-z0-9]+)'/g)].map((match) => match[1]!)
    expect(ids.length).toBeGreaterThan(30)
    const known = new Set(COMMANDS.map((command) => command.id))
    expect(ids.filter((id) => !known.has(id))).toEqual([])
    expect(formatAccelerator('CmdOrCtrl+Shift+2', 'darwin')).toBe('⇧⌘2')
  })
})
