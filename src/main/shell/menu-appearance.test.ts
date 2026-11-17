// View › Appearance: two groups of radio items that do not drive the same thing, each under a title that says which (« Apparence de Lucium » is the interface,
// « Apparence demandée aux sites » is what the websites read). Same harness as menu-readable.test.ts: the real menu, `Menu` replaced by a function that hands the
// template back.

import { describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

import { buildMenu } from './menu'
import { frenchSpaces } from '@shared/french-typography'

interface Item {
  label?: string
  type?: string
  checked?: boolean
  enabled?: boolean
  click?: () => void
  submenu?: Item[]
}

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

function appearanceMenu(state: SidebarState, names: { view: string; appearance: string } = { view: 'Affichage', appearance: 'Apparence' }) {
  const dispatched: Action[] = []
  const browser = new Proxy(
    { dispatch: (action: Action) => void dispatched.push(action), showToast: () => undefined, menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const template = buildMenu(browser as never, store, actions as never, {}) as unknown as Item[]
  const view = template.find((item) => item.label === names.view)!
  const items = view.submenu!.find((item) => item.label === names.appearance)!.submenu!
  // The groups: the items between two separators, each led by the title (a greyed entry).
  const groups: Item[][] = [[]]
  for (const item of items) {
    if (item.type === 'separator') groups.push([])
    else groups.at(-1)!.push(item)
  }
  return { groups, dispatched }
}

describe('View › Appearance', () => {
  it('has a group for Lucium and a group for the websites, each with its title, then the readable mode of the site', () => {
    const { groups } = appearanceMenu(createInitialState(ctx))
    expect(groups.map((group) => group.map((item) => item.label))).toEqual([
      [frenchSpaces('Apparence de Lucium'), 'Automatique', 'Clair', 'Sombre'],
      [frenchSpaces('Apparence demandée aux sites :'), 'Automatique', 'Clair', 'Sombre'],
      ['Contraste de la page pour ce site']
    ])
    expect(groups[0]![0]!.enabled).toBe(false)
    expect(groups[1]![0]!.enabled).toBe(false)
    expect(groups[0]!.slice(1).every((item) => item.type === 'radio')).toBe(true)
    expect(groups[1]!.slice(1).every((item) => item.type === 'radio')).toBe(true)
  })

  it('says it in English too, with the same two titles', () => {
    setLanguage('en')
    try {
      const { groups } = appearanceMenu(createInitialState(ctx), { view: 'View', appearance: 'Appearance' })
      expect(groups.map((group) => group[0]!.label)).toEqual(['Lucium appearance', 'Appearance asked of websites:', 'Page Contrast for This Site'])
      expect(groups[0]!.slice(1).map((item) => item.label)).toEqual(['Automatic', 'Light', 'Dark'])
    } finally {
      setLanguage('fr')
    }
  })

  // THE GUARD of the bug of 0.2.14: the entries of the first group write Lucium's setting, those of the second the websites', and neither the other's.
  it('writes Lucium’s setting from the first group, and the websites’ setting from the second', () => {
    const { groups, dispatched } = appearanceMenu(createInitialState(ctx))
    const choose = (group: number, label: string): void => groups[group]!.find((item) => item.label === label)!.click!()
    choose(0, 'Sombre')
    choose(1, 'Clair')
    choose(0, 'Automatique')
    choose(1, 'Sombre')
    expect(dispatched).toEqual([
      { type: 'settings/update', patch: { interfaceAppearance: 'dark' } },
      { type: 'settings/update', patch: { websiteAppearance: 'light' } },
      { type: 'settings/update', patch: { interfaceAppearance: 'auto' } },
      { type: 'settings/update', patch: { websiteAppearance: 'dark' } }
    ])
  })

  it('checks the current choice of each group, apart from the other', () => {
    const state = run(createInitialState(ctx), { type: 'settings/update', patch: { interfaceAppearance: 'auto', websiteAppearance: 'dark' } })
    const { groups } = appearanceMenu(state)
    expect(groups[0]!.filter((item) => item.checked).map((item) => item.label)).toEqual(['Automatique'])
    expect(groups[1]!.filter((item) => item.checked).map((item) => item.label)).toEqual(['Sombre'])
    const other = run(createInitialState(ctx), { type: 'settings/update', patch: { interfaceAppearance: 'light', websiteAppearance: 'auto' } })
    expect(appearanceMenu(other).groups[0]!.filter((item) => item.checked).map((item) => item.label)).toEqual(['Clair'])
    expect(appearanceMenu(other).groups[1]!.filter((item) => item.checked).map((item) => item.label)).toEqual(['Automatique'])
  })
})
