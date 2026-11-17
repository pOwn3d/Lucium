// The answers of the search of the Settings (shared/settings-answers.ts) send people to the menu bar: each way through the menus they name is checked
// here against the real menu, in French and in English, with the shortcut of its command on the entry. An answer never names an entry that does not
// exist, nor a key that the entry does not answer.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { COMMANDS } from '@shared/keybindings'
import { SETTINGS_ANSWERS } from '@shared/settings-answers'
import { createInitialState } from '@shared/sidebar'

// The menu is the real one, with Electron's `Menu` replaced by a function that hands the template back (menu.ts only describes entries).
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
  accelerator?: string
  visible?: boolean
  submenu?: Item[]
}

/** The menu bar of a fresh profile, in the language of the moment. */
function menuBar(): Item[] {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const browser = new Proxy({} as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  return buildMenu(browser as never, { get: () => state } as never, actions as never) as unknown as Item[]
}

/** The entry at the end of a way through the menus, by their names. */
function find(items: readonly Item[], path: readonly string[]): Item | undefined {
  const [first, ...rest] = path
  const item = items.find((one) => one.label === first && one.visible !== false)
  return rest.length === 0 ? item : find(item?.submenu ?? [], rest)
}

const leaves = (items: readonly Item[]): Item[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))

afterEach(() => setLanguage('fr'))

describe('the menus the answers of the search name', () => {
  it.each(['fr', 'en'] as const)('exist in the menu bar, in %s, with the shortcut of their command', (language) => {
    setLanguage(language)
    const bar = menuBar()
    for (const answer of SETTINGS_ANSWERS.filter((one) => one.menu)) {
      const entry = find(bar, answer.menu!.map((key) => t(key)))
      expect(entry, `${answer.id}: ${answer.menu!.map((key) => t(key)).join(' › ')}`).toBeDefined()
      if (!answer.command) continue
      const standard = COMMANDS.find((command) => command.id === answer.command)
      expect(standard, answer.command).toBeDefined()
      if (!standard!.accelerator) continue
      // The entry itself, or, for a menu named whole (the one that shows or hides the sidebar), one of its entries.
      const carriers = entry!.submenu ? leaves(entry!.submenu) : [entry!]
      expect(carriers.some((item) => item.accelerator === standard!.accelerator), `${answer.id}: ${standard!.accelerator}`).toBe(true)
    }
  })

  it('would see a menu that does not exist', () => {
    expect(find(menuBar(), ['Fichier', 'Importer depuis un autre navigateur…'])).toBeUndefined()
    expect(find(menuBar(), ['Lucium', 'Importer depuis un autre navigateur…'])).toBeDefined()
  })
})
