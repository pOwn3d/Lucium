// The sheet « Reprendre où vous en étiez ? » (RestoreSheet.tsx), drawn with no window on a snapshot (as dead-tabs-sheet.test.ts does): a row for each tab of the day, ticked
// at first; what « Garder les onglets cochés » and « Tout garder » ask of the main process. Which tabs are offered: shared/session-restore.test.ts.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { elementsOf } from './render.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) }), useSnapshot: () => holder.snapshot }))

import { RestoreSheet } from './RestoreSheet'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
  holder.asked = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

/** Three tabs of the day, and a pinned one that is not offered. */
function fixture(): { state: SidebarState; ids: string[] } {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  let state = createInitialState(ctx)
  for (const url of ['https://pinned.example/', 'https://one.example/', 'https://two.example/', 'https://three.example/']) state = reduce(state, { type: 'tab/open', url, background: true }, ctx)
  state = { ...state, tabs: state.tabs.map((tab, i) => ({ ...tab, title: ['Épinglé', 'Un', 'Deux', 'Trois'][i]!, ...(i === 0 ? { pinned: true } : {}) })) }
  return { state, ids: state.tabs.map((tab) => tab.id) }
}

function sheet(state: SidebarState, off?: ReadonlySet<string>) {
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false } }
  const props = off ? { initialOff: off } : {}
  const markup = renderToStaticMarkup(createElement(RestoreSheet, props))
  const elements = elementsOf(createElement(RestoreSheet, props))
  const submit = (): void => (elements.find((element) => element.type === 'form')!.props['onSubmit'] as (event: { preventDefault(): void }) => void)({ preventDefault: () => undefined })
  const dispatched = (): Action[] => holder.asked.filter(([name]) => name === 'dispatch').map(([, args]) => args[0] as Action)
  return { markup, elements, submit, dispatched, asked: () => holder.asked.map(([name]) => name) }
}

describe('the sheet to pick up where Lucium left off', () => {
  it('is a dialog with a row for each tab of the day, ticked, and none for a pinned tab', () => {
    const { state } = fixture()
    const { markup } = sheet(state)
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain(`>${frenchSpaces('Reprendre où vous en étiez ?')}</h2>`)
    expect(markup).toContain('3 onglets')
    for (const words of ['Un', 'one.example', 'Deux', 'Trois']) expect(markup, words).toContain(words)
    expect(markup).not.toContain('Épinglé')
    expect(markup.match(/<input type="checkbox"[^>]*\bchecked=""/g)).toHaveLength(3)
    expect(markup).toContain('>Garder les onglets cochés</button>')
    expect(markup).toContain('>Tout garder</button>')
    expect(markup).toContain('3 onglets cochés')
  })

  it('sends the unticked tabs to the archive in one go, keeps the others, and goes', () => {
    const { state, ids } = fixture()
    const view = sheet(state, new Set([ids[2]!]))
    expect(view.markup).toContain('2 onglets cochés')
    view.submit()
    expect(view.dispatched()).toEqual([{ type: 'tabs/archive-many', ids: [ids[2]] }])
    expect(view.asked()).toContain('closeOverlay')
  })

  it('archives nothing when every row is ticked, and goes', () => {
    const { state } = fixture()
    const view = sheet(state)
    view.submit()
    expect(view.dispatched()).toEqual([])
    expect(view.asked()).toContain('closeOverlay')
  })

  it('keeps them all with « Tout garder » without asking the main process for anything', () => {
    const { state, ids } = fixture()
    const view = sheet(state, new Set([ids[1]!]))
    const keepAll = view.elements.find((element) => element.type === 'button' && element.props['children'] === 'Tout garder')!
    ;(keepAll.props['onClick'] as () => void)()
    expect(view.dispatched()).toEqual([])
    expect(view.asked()).toEqual(['closeOverlay'])
  })
})
