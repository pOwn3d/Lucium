// The entries « Tout effacer… » and « Nouvelle identité… » of the menu Archive: present, with no shortcut by default, greyed out in a private window
// (which holds no profile data), and each one starts its own flow.
import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { COMMANDS } from '@shared/keybindings'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu } from './menu'

interface Item { label?: string; enabled?: boolean; accelerator?: string; click?: () => void; submenu?: Item[] }
const flat = (items: Item[]): Item[] => items.flatMap((item) => (item.submenu ? flat(item.submenu) : [item]))

function menu(options: { private?: boolean } = {}) {
  const clicks: string[] = []
  const browser = new Proxy({ menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => false)
  })
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}), clearEverything: () => void clicks.push('everything'), newIdentity: () => void clicks.push('identity') } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => {})
  })
  const store = { get: () => createInitialState({ now: 1, newId: () => 'home' }) } as never
  const items = flat(buildMenu(browser as never, store, actions as never, options) as unknown as Item[])
  const find = (label: string) => items.find((item) => item.label === label)
  return { clicks, everything: find('Tout effacer…'), identity: find('Nouvelle identité…') }
}

describe('Archive › Tout effacer… and Nouvelle identité…', () => {
  it('start the flow of their own kind', () => {
    const { clicks, everything, identity } = menu()
    expect(everything?.enabled).toBe(true)
    expect(identity?.enabled).toBe(true)
    everything!.click!()
    identity!.click!()
    expect(clicks).toEqual(['everything', 'identity'])
  })

  it('are greyed out in a private window', () => {
    const { everything, identity } = menu({ private: true })
    expect(everything?.enabled).toBe(false)
    expect(identity?.enabled).toBe(false)
  })

  it('carry no shortcut until the user gives one', () => {
    const { everything, identity } = menu()
    expect(everything?.accelerator).toBeUndefined()
    expect(identity?.accelerator).toBeUndefined()
    expect(COMMANDS.filter((c) => c.id === 'clearEverything' || c.id === 'newIdentity').map((c) => c.accelerator)).toEqual(['', ''])
  })
})
