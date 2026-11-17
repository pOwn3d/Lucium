// Onglets › Déplacer l’onglet vers le haut / le bas (⌥⇧⌘↑ / ⌥⇧⌘↓): the tab on screen goes one place in its group, as the entries of its own menu move it
// (tab-step.ts). The shortcut runs the entry, so pressing the entry is pressing the key. The menu is the real one, with Electron's `Menu` handing the template back.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

// The menu of macOS on any machine (a Linux runner included), and of Linux when a test asks: the shortcuts differ (shared/platform.ts, LINUX_DEFAULTS).
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu } from './menu'
import { played, resetPlayedPlatform } from '../platform/platform.test-support'

afterEach(resetPlayedPlatform)

interface Item {
  label?: string
  enabled?: boolean
  accelerator?: string
  click?: () => void
  submenu?: Item[]
}

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (s: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((acc, a) => reduce(acc, a, ctx), s)

/** Three Today tabs a, b, c and a pinned one p, in one space. */
function fixture() {
  let s = createInitialState(ctx)
  for (const host of ['a', 'b', 'c', 'p']) s = run(s, { type: 'tab/open', url: `https://${host}.example.org/`, background: true })
  const id = (host: string) => s.tabs.find((t) => t.url === `https://${host}.example.org/`)!.id
  s = run(s, { type: 'tab/pin', id: id('p') })
  return { state: s, id }
}

/** The Onglets menu built for `state`, and what its entries dispatched. */
function tabsMenu(state: SidebarState) {
  const dispatched: Action[] = []
  const browser = new Proxy(
    {
      menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }),
      dispatch: (action: Action) => void dispatched.push(action)
    } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const menu = buildMenu(browser as never, store, actions as never) as unknown as Item[]
  const items = menu.find((item) => item.label === 'Onglets')!.submenu!
  const entry = (label: string): Item => {
    const found = items.find((item) => item.label === label)
    if (!found) throw new Error(`no entry "${label}"`)
    return found
  }
  return { up: entry('Déplacer l’onglet vers le haut'), down: entry('Déplacer l’onglet vers le bas'), dispatched }
}

const todayOrder = (s: SidebarState): string[] => s.tabs.filter((t) => !t.pinned).map((t) => t.url.split('/')[2]!.split('.')[0]!)

describe('Onglets › Déplacer l’onglet vers le haut / le bas', () => {
  it('carry the shortcuts ⌥⇧⌘↑ and ⌥⇧⌘↓, or the user’s own', () => {
    const { state, id } = fixture()
    const shown = run(state, { type: 'tab/select', id: id('b') })
    expect(tabsMenu(shown).up.accelerator).toBe('CmdOrCtrl+Alt+Shift+Up')
    expect(tabsMenu(shown).down.accelerator).toBe('CmdOrCtrl+Alt+Shift+Down')
    const own = run(shown, { type: 'settings/update', patch: { keyBindings: { moveTabUp: 'Ctrl+Alt+Up', moveTabDown: '' } } })
    expect(tabsMenu(own).up.accelerator).toBe('Ctrl+Alt+Up')
    expect(tabsMenu(own).down.accelerator).toBeUndefined()
  })

  it('carry Ctrl+Shift+Page Up and Ctrl+Shift+Page Down on Linux, where GNOME keeps Ctrl+Alt+Shift+arrows for the workspaces', () => {
    const { state, id } = fixture()
    const shown = run(state, { type: 'tab/select', id: id('b') })
    played.id = 'linux'
    expect(tabsMenu(shown).up.accelerator).toBe('CmdOrCtrl+Shift+PageUp')
    expect(tabsMenu(shown).down.accelerator).toBe('CmdOrCtrl+Shift+PageDown')
    const own = run(shown, { type: 'settings/update', patch: { keyBindings: { moveTabUp: 'Ctrl+Alt+Up', moveTabDown: '' } } })
    expect(tabsMenu(own).up.accelerator).toBe('Ctrl+Alt+Up')
    expect(tabsMenu(own).down.accelerator).toBeUndefined()
  })

  it('move the tab on screen one place up or down its Today tabs', () => {
    const { state, id } = fixture()
    const shown = run(state, { type: 'tab/select', id: id('b') })
    const up = tabsMenu(shown)
    up.up.click!()
    expect(todayOrder(run(shown, ...up.dispatched))).toEqual(['b', 'a', 'c'])
    const down = tabsMenu(shown)
    down.down.click!()
    expect(todayOrder(run(shown, ...down.dispatched))).toEqual(['a', 'c', 'b'])
  })

  it('do nothing at the top or the bottom of the group: the first tab cannot go up, the last cannot go down', () => {
    const { state, id } = fixture()
    const first = tabsMenu(run(state, { type: 'tab/select', id: id('a') }))
    first.up.click!()
    expect(first.dispatched).toEqual([])
    const last = tabsMenu(run(state, { type: 'tab/select', id: id('c') }))
    last.down.click!()
    expect(last.dispatched).toEqual([])
    // A pinned tab alone in its group has nowhere to go either.
    const pinned = tabsMenu(run(state, { type: 'tab/select', id: id('p') }))
    pinned.up.click!()
    pinned.down.click!()
    expect(pinned.dispatched).toEqual([])
  })

  it('read the place when the key is pressed, not when the menu was built', () => {
    const { state, id } = fixture()
    const built = tabsMenu(run(state, { type: 'tab/select', id: id('a') }))
    // Built while a was the first tab; it is the last one by the time the key is pressed: up moves it.
    const moved = run(state, { type: 'tab/select', id: id('a') }, { type: 'tab/move', id: id('a'), toIndex: 2, pinned: false })
    const live = tabsMenu(moved)
    live.up.click!()
    expect(todayOrder(run(moved, ...live.dispatched))).toEqual(['b', 'a', 'c'])
    expect(built.up.enabled).not.toBe(false)
  })

  it('are greyed out, and their keys dead, without a tab on screen', () => {
    const empty = tabsMenu(createInitialState(ctx))
    expect(empty.up.enabled).toBe(false)
    expect(empty.down.enabled).toBe(false)
  })
})
