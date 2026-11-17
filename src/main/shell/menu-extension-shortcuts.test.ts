// The entries of the Extensions menu for the commands of extensions (chrome.commands): each gets the key its extension suggests, unless a command
// of Lucium or another extension already holds that key. On macOS the first menu item that holds a key receives it: an extension entry with a key
// that is taken would show a shortcut that never reaches it. The rule alone is in shared/keybindings.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { ExtensionInfo } from '@shared/ipc'

// The menu is the real one, with Electron's `Menu` replaced by a function that hands the template back (menu.ts only describes entries).
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

import { buildMenu } from './menu'

interface Item {
  label?: string
  accelerator?: string
  click?: () => void
  submenu?: Item[]
}

const leaves = (items: Item[]): Item[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))

const extension = (id: string, name: string, commands: Array<[string, string | null]>): ExtensionInfo => ({
  id,
  name,
  version: '1.0',
  profileId: 'default',
  source: 'store',
  enabled: true,
  commands: commands.map(([command, accelerator]) => ({ name: command, description: `${command} of ${name}`, accelerator, label: accelerator ?? '' }))
})

function menuWith(extensions: ExtensionInfo[], keyBindings: Record<string, string> = {}) {
  const ran: string[] = []
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const browser = new Proxy({ runExtensionCommand: (id: string, name: string) => void ran.push(`${id}:${name}`), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => false)
  })
  const actions = new Proxy({ windows: () => [], extensions: () => extensions, sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const store = { get: () => ({ ...state, settings: { ...state.settings, keyBindings } }) } as unknown as Parameters<typeof buildMenu>[1]
  const items = leaves(buildMenu(browser as never, store, actions as never) as unknown as Item[])
  return { item: (label: string) => items.find((each) => each.label === label), ran }
}

describe('the commands of extensions in the Extensions menu', () => {
  it('get the key their extension suggests when nothing else holds it', () => {
    const { item } = menuWith([extension('aaa', 'Clipper', [['clip', 'Alt+Shift+9']])])
    expect(item('clip of Clipper (Clipper)')?.accelerator).toBe('Alt+Shift+9')
  })

  it('get no key when a command of Lucium holds it, and the entry still runs the command when clicked', () => {
    const { item, ran } = menuWith([extension('aaa', 'Clipper', [['clip', 'Cmd+T'], ['other', 'Alt+Shift+9']])])
    const taken = item('clip of Clipper (Clipper)')
    expect(taken).toBeDefined()
    expect(taken?.accelerator).toBeUndefined()
    taken!.click!()
    expect(ran).toEqual(['aaa:clip'])
    expect(item('other of Clipper (Clipper)')?.accelerator).toBe('Alt+Shift+9')
  })

  it('get the key back once the user has moved the command of Lucium to another key', () => {
    const { item } = menuWith([extension('aaa', 'Clipper', [['clip', 'Cmd+T']])], { newTab: 'CmdOrCtrl+Alt+T' })
    expect(item('clip of Clipper (Clipper)')?.accelerator).toBe('Cmd+T')
  })

  it('share no key between two extensions: the first by its id keeps it', () => {
    const { item } = menuWith([extension('bbb', 'Second', [['go', 'Alt+Shift+9']]), extension('aaa', 'First', [['go', 'Shift+Alt+9']])])
    expect(item('go of First (First)')?.accelerator).toBe('Shift+Alt+9')
    expect(item('go of Second (Second)')?.accelerator).toBeUndefined()
  })
})
