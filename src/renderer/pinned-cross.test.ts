// The cross of a pinned tab: an open one is only put to sleep; one that is already asleep has nothing left to close, so the cross removes it (to the
// archive). A tab opened from a favourite only closes: the favourite stays. Drawn with the real row (no window); the click is the handler the row hands its cross.

import { createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { RuntimeState, TabItem } from '@shared/model'
import { elementsOf } from './render.test-support'

const holder = vi.hoisted(() => ({ dispatched: [] as unknown[] }))
vi.mock('./api', () => ({ api: () => ({ dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()) }) }))

import { SidebarUiContext, TabRow, type SidebarUi } from './SidebarRows'

const noop = (): void => undefined
const ui: SidebarUi = { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop }
const underUi = (probe: ReactElement): ReactElement => createElement(SidebarUiContext.Provider, { value: ui }, probe)

/** The cross of the row of `tab`, awake or asleep: its name, and what a click on it dispatches. */
function cross(tab: Partial<TabItem>, awake: boolean): { label: unknown; dispatched: unknown[] } {
  const item: TabItem = { id: 't', spaceId: 's', url: 'https://exemple.fr/', title: 'Exemple', pinned: false, createdAt: 1, lastActiveAt: 2, ...tab }
  const runtime: RuntimeState = { tabs: { t: { loading: false, audible: false, muted: false, awake } }, canGoBack: false, canGoForward: false }
  const button = elementsOf(createElement(TabRow, { tab: item, active: false, inSplit: false, runtime }), undefined, underUi).find((element) => element.type === 'button' && String(element.props['className']).includes('tab-close'))
  expect(button, 'the row has a cross').toBeDefined()
  holder.dispatched.length = 0
  ;(button!.props['onClick'] as (event: { stopPropagation(): void }) => void)({ stopPropagation: noop })
  return { label: button!.props['aria-label'], dispatched: [...holder.dispatched] }
}

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {} })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

describe('the cross of a pinned tab', () => {
  it('removes a pinned tab only when it is asleep and not a favourite, and puts an open one to sleep', () => {
    expect(cross({ pinned: true }, false).dispatched).toEqual([{ type: 'tab/remove-pinned', id: 't' }])
    expect(cross({ pinned: true }, true).dispatched).toEqual([{ type: 'tab/close', id: 't' }])
    // The tab of a favourite only closes, asleep or not: the favourite stays.
    expect(cross({ pinned: true, favoriteId: 'f' }, false).dispatched).toEqual([{ type: 'tab/close', id: 't' }])
    // A tab of Today is archived.
    expect(cross({}, true).dispatched).toEqual([{ type: 'tab/archive', id: 't' }])
  })

  it('says what it does on a pinned tab that is asleep', () => {
    expect(cross({ pinned: true }, false).label).toBe(t('sidebar.retirer-cet-onglet-epingle'))
    expect(cross({ pinned: true }, true).label).toBe(t('sidebar.fermer-et-garder-epingle'))
    expect(cross({}, true).label).toBe(t('sidebar.archiver-cet-onglet'))
  })
})
