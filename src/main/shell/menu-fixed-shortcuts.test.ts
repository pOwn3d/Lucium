// The shortcuts of the menus that the Settings do not move (shared/keybindings.ts, FIXED_SHORTCUTS) are read from the real menu: an entry with a
// role the system gives a key to, or with an accelerator of its own, has to be in the list, or the Settings would let a command take its key
// without a word. And one shortcut is carried by one entry: of two commands left on the same one, the one chosen last.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { DEVTOOLS_EXTRA_ACCELERATOR } from '@shared/devtools-request'
import { COMMANDS, FIXED_SHORTCUTS, effectiveAccelerator, samePress, secondAccelerator, takenBy } from '@shared/keybindings'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

// The menu bar of macOS on every runner: these checks read its roles and its shortcuts (the ones the application is published with). Another system has its
// own (shared/platform.ts, NON_MAC_DEFAULTS; platform/menu.test.ts adapts the template), which the tests of the platform layer play on their own.
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu } from './menu'

interface Item {
  label?: string
  role?: string
  accelerator?: string
  registerAccelerator?: boolean
  submenu?: Item[]
}

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (s: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((acc, a) => reduce(acc, a, ctx), s)

interface Extension {
  id: string
  name: string
  commands: Array<{ name: string; description: string; accelerator: string | null; label: string }>
}

/** Every entry of the menu bar built for `state`, submenus flattened. */
function entries(state: SidebarState, extensions: Extension[] = []): Item[] {
  const browser = new Proxy({ menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => false)
  })
  const actions = new Proxy({ windows: () => [], extensions: () => extensions, sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const menu = buildMenu(browser as never, { get: () => state } as never, actions as never) as unknown as Item[]
  const flat = (items: Item[]): Item[] => items.flatMap((item) => [item, ...flat(Array.isArray(item.submenu) ? item.submenu : [])])
  return flat(menu)
}

/** Both shapes of the Window menu: the role (which holds « Réduire », ⌘M) and the entries written out when the windows have names. */
const states = (): SidebarState[] => {
  const base = createInitialState(ctx)
  return [base, run(base, { type: 'settings/update', patch: { nameWindows: !base.settings.nameWindows } })]
}

/** The roles the system gives no key to, and the ones whose key comes from the table of commands or from another role of the list. */
const ROLES_WITHOUT_A_KEY_OF_THEIR_OWN = new Set(['services', 'unhide', 'zoom', 'front', 'delete', 'help', 'showSubstitutions', 'startSpeaking', 'stopSpeaking', 'togglefullscreen', 'windowMenu', 'editMenu'])

describe('the fixed shortcuts of the menus', () => {
  it('cover every role of the menu bar that comes with a key', () => {
    const roles = new Set(states().flatMap((state) => entries(state)).flatMap((item) => (item.role ? [item.role] : [])))
    expect(roles.size).toBeGreaterThan(8)
    const fixed = new Set(FIXED_SHORTCUTS.flatMap((shortcut) => (shortcut.role ? [shortcut.role] : [])))
    for (const role of roles) expect(fixed.has(role) || ROLES_WITHOUT_A_KEY_OF_THEIR_OWN.has(role), `the role « ${role} » is neither a fixed shortcut nor known to have no key`).toBe(true)
    // « Réduire » is in both shapes of the Window menu: written out, or inside the role of the whole menu.
    expect(fixed.has('minimize')).toBe(true)
  })

  it('name no role the menu bar does not have', () => {
    const roles = new Set(states().flatMap((state) => entries(state)).flatMap((item) => (item.role ? [item.role] : [])))
    for (const shortcut of FIXED_SHORTCUTS) if (shortcut.role) expect(roles.has(shortcut.role), shortcut.role).toBe(true)
  })

  // F12 is left out: it opens the tools only as long as no command has it (shared/devtools-request.ts), so a command may take it. The second
  // press of a command is one of its shortcuts, and gives way the same way.
  it('cover every accelerator an entry holds that is not the shortcut of a command', () => {
    for (const state of states()) {
      const ofCommands = COMMANDS.flatMap((command) => [effectiveAccelerator(command.id, state.settings.keyBindings) ?? [], secondAccelerator(command.id, state.settings.keyBindings) ?? []].flat())
      const own = entries(state).filter((item) => typeof item.accelerator === 'string' && item.registerAccelerator !== false && item.accelerator !== DEVTOOLS_EXTRA_ACCELERATOR && !ofCommands.some((accelerator) => samePress(accelerator, item.accelerator!)))
      for (const item of own) expect(takenBy(item.accelerator, FIXED_SHORTCUTS), `« ${item.label} » holds ${item.accelerator}, which the Settings would give to a command`).toBeDefined()
      expect(own.map((item) => item.accelerator)).toContain('CmdOrCtrl+Z')
    }
  })
})

describe('two commands left on one shortcut', () => {
  const labelled = (items: Item[], label: string): Item[] => items.filter((item) => item.label === label)

  it('leave it to a single entry: the command the user chose, not the one that had it by default', () => {
    const state = run(createInitialState(ctx), { type: 'settings/update', patch: { keyBindings: { newWindow: 'CmdOrCtrl+T' } } })
    const items = entries(state)
    expect(labelled(items, 'Nouvelle fenêtre').map((item) => item.accelerator)).toEqual(['CmdOrCtrl+T'])
    // « Nouvel onglet » is in two menus; neither keeps ⌘T.
    expect(labelled(items, 'Nouvel onglet…').length + labelled(items, 'Nouvel onglet').length).toBeGreaterThan(0)
    expect(items.filter((item) => item.accelerator === 'CmdOrCtrl+T')).toHaveLength(1)
  })

  it('leave it to the one saved last when the user chose both', () => {
    const state = run(createInitialState(ctx), { type: 'settings/update', patch: { keyBindings: { newWindow: 'CmdOrCtrl+Alt+K', print: 'CmdOrCtrl+Alt+K' } } })
    const holders = entries(state).filter((item) => item.accelerator === 'CmdOrCtrl+Alt+K')
    expect(holders.map((item) => item.label)).toEqual(['Imprimer…'])
  })
})

describe('the commands of an extension in the Extensions menu', () => {
  it('get their key from the list the Settings read', () => {
    const extension = { id: 'ext', name: 'Lecteur', commands: [{ name: 'save', description: 'Enregistrer l’article', accelerator: 'Shift+Cmd+Y', label: '⇧⌘Y' }, { name: '_execute_action', description: '', accelerator: 'Alt+Shift+A', label: '⌥⇧A' }] }
    const items = entries(createInitialState(ctx), [extension])
    expect(items.filter((item) => item.label === 'Enregistrer l’article (Lecteur)').map((item) => item.accelerator)).toEqual(['Shift+Cmd+Y'])
    expect(items.some((item) => item.accelerator === 'Alt+Shift+A')).toBe(false)
  })
})
