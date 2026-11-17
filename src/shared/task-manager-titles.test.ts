// The titles the task manager does not show (withoutHiddenTitles), and the order of its rows grouped by space (rowsBySpace). The handler that
// uses the first with the lock of a window is run in main/shell/ipc-task-manager.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from './i18n'
import type { ProcessRow } from './ipc'
import { rowsBySpace, withoutHiddenTitles, type RendererHost, type TaskManagerTabs } from './processes'

afterEach(() => {
  setLanguage('fr')
  vi.restoreAllMocks()
})

const sources = (): TaskManagerTabs => ({
  pages: new Map([[1, 'Ouvert'], [2, 'Secret'], [3, 'Privé à moi'], [4, 'Une fenêtre surgie']]),
  pageTabs: new Map([[1, { tabId: 'a', space: 'Perso' }], [2, { tabId: 'b', space: 'Coffre' }], [3, { tabId: 'c', space: 'Perso' }]]),
  group: new Map<number, RendererHost[]>([[9, [{ kind: 'surface', surface: 'window', window: 'Fenêtre' }, { kind: 'subframe', tabId: 'b', tabName: 'Secret' }, { kind: 'subframe', tabId: 'c', tabName: 'Privé à moi' }]]]),
  sleeping: [{ tabId: 'd', name: 'Secret endormi', space: 'Coffre' }, { tabId: 'e', name: 'Endormi', space: 'Perso' }]
})

describe('the sources of the task manager without the titles it must not show', () => {
  it('are the same object when nothing is locked and no tab is private', () => {
    const given = sources()
    expect(withoutHiddenTitles(given, { locked: new Set(), private: new Set() })).toBe(given)
  })

  it('drop the sleeping tabs of a locked space, and call a live one a locked tab with no tab to act on', () => {
    const shown = withoutHiddenTitles(sources(), { locked: new Set(['b', 'd']), private: new Set() })
    expect(shown.sleeping).toEqual([{ tabId: 'e', name: 'Endormi', space: 'Perso' }])
    expect(shown.pages.get(2)).toBe('Onglet d’un espace verrouillé')
    expect(shown.pageTabs.has(2)).toBe(false)
    expect(shown.group.get(9)).toEqual([{ kind: 'surface', surface: 'window', window: 'Fenêtre' }, { kind: 'subframe', tabId: 'c', tabName: 'Privé à moi' }])
    // What is not a tab of the locked space is untouched: another tab, the popup of a page.
    expect(shown.pages.get(1)).toBe('Ouvert')
    expect(shown.pages.get(4)).toBe('Une fenêtre surgie')
    expect(shown.pageTabs.get(1)).toEqual({ tabId: 'a', space: 'Perso' })
  })

  it('keep the row of a private tab, under a name that says nothing of its page, in the language of the interface', () => {
    setLanguage('en')
    const shown = withoutHiddenTitles(sources(), { locked: new Set(), private: new Set(['c']) })
    expect(shown.pages.get(3)).toBe('Private tab')
    expect(shown.pageTabs.get(3)).toEqual({ tabId: 'c', space: 'Perso' })
    expect(shown.group.get(9)?.[2]).toEqual({ kind: 'subframe', tabId: 'c', tabName: 'Private tab' })
  })
})

describe('the rows grouped by space', () => {
  const row = (pid: number, space?: string): ProcessRow => ({ pid, kind: 'tab', name: `p${pid}`, cpu: 0, memoryMb: 1, ...(space ? { space } : {}) })

  it('keep the order of the column inside a space, and put the rows without a space last', () => {
    expect(rowsBySpace([row(1), row(2, 'Travail'), row(3, 'Perso'), row(4, 'Travail'), row(5, 'Perso')]).map((r) => r.pid)).toEqual([3, 5, 2, 4, 1])
  })

  it('compare the names of the spaces in the language of the interface, not always in French', () => {
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    setLanguage('en')
    rowsBySpace([row(1, 'B'), row(2, 'A')])
    expect(compare.mock.calls.map((call) => call[1])).toEqual(['en'])
  })
})
