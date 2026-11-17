// The "Aller à l’élément n de la barre latérale" entries of the Tabs menu (⌘1 … ⌘9) select the nth row the sidebar shows, not the nth tab of the state
// (the rule and its cases are in shared/sidebar-items.test.ts: this one checks that the menu uses it).

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'

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

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Five tabs made in the order a, b, c, d, e, shown as d, b, F[e], a, c (d and b pinned, e in the folder F). */
function sidebar(): { state: SidebarState; id: (host: string) => string } {
  let state = createInitialState(ctx)
  for (const host of ['a', 'b', 'c', 'd', 'e']) state = run(state, { type: 'tab/open', url: `https://${host}.fr/`, background: true })
  const id = (host: string) => state.tabs.find((t) => t.url === `https://${host}.fr/`)!.id
  state = run(state, { type: 'tab/pin', id: id('d') }, { type: 'folder/create', name: 'F' })
  state = run(state, { type: 'tab/move', id: id('e'), toIndex: 0, pinned: true, folderId: state.folders[0]!.id }, { type: 'tab/pin', id: id('b') })
  return { state, id }
}

/** The tab the entry for ⌘n selects when it is clicked, or null when it selects nothing. */
function clickItem(state: SidebarState, n: number): string | null {
  const dispatched: Action[] = []
  const browser = new Proxy({ dispatch: (action: Action) => void dispatched.push(action), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => false)
  })
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const entry = leaves(buildMenu(browser as never, store, actions as never) as unknown as Item[]).find((item) => item.label === `Aller à l’élément ${n} de la barre latérale`)
  expect(entry?.click).toBeTypeOf('function')
  entry!.click!()
  const selected = dispatched.filter((a): a is Extract<Action, { type: 'tab/select' }> => a.type === 'tab/select')
  return selected.length === 1 ? selected[0]!.id : null
}

describe('the Tabs menu entries for ⌘1 … ⌘9', () => {
  it('select the rows in the order the sidebar draws them: pinned tabs, the folder’s, then Today', () => {
    const { state, id } = sidebar()
    expect([1, 2, 3, 4, 5].map((n) => clickItem(state, n))).toEqual([id('d'), id('b'), id('e'), id('a'), id('c')])
  })

  it('select nothing for a row the sidebar does not have, nor for a tab in a collapsed folder', () => {
    const { state, id } = sidebar()
    expect(clickItem(state, 6)).toBeNull()
    const closed = run(state, { type: 'folder/toggle', id: state.folders[0]!.id })
    expect([1, 2, 3, 4, 5].map((n) => clickItem(closed, n))).toEqual([id('d'), id('b'), id('a'), id('c'), null])
  })
})
