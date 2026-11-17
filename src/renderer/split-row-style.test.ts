// Only the row of the current pane of a split view is greyed: every split row was grey, so the grey said nothing.
// The row is drawn to markup with the real component (its classes, its handlers read from the elements it returns); what the sheets do with those classes
// is read from the sheets themselves (style contracts, as in stylesheets.test.ts).

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeState, TabItem } from '@shared/model'
import { chipView, noStatus } from '@shared/download-status'
import { DownloadChip } from './DownloadStatus'
import { SidebarUiContext, SplitRow, unsplitOrder, type SidebarUi } from './SidebarRows'
import interactions from './sidebar-interactions.css?raw'
import sidebar from './sidebar.css?raw'
import styles from './styles.css?raw'
import toolbar from './toolbar.css?raw'

const dispatch = vi.fn(() => Promise.resolve())
beforeEach(() => vi.stubGlobal('window', { lucium: { dispatch } }))
afterEach(() => {
  vi.unstubAllGlobals()
  dispatch.mockClear()
})

const noop = (): void => undefined
const ui = (patch: Partial<SidebarUi> = {}): SidebarUi => ({ selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop, ...patch })
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }
const tab = (id: string): TabItem => ({ id, spaceId: 's', url: `https://${id}.local/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2 })
const tabsOf = (...ids: string[]): TabItem[] => ids.map(tab)

/** The row drawn to markup, the tab on screen being `activeId` (the first of its tabs unless said). */
const render = (tabs: TabItem[], activeId: string = tabs[0]!.id, context: Partial<SidebarUi> = {}): string =>
  renderToStaticMarkup(createElement(SidebarUiContext.Provider, { value: ui(context) }, createElement(SplitRow, { tabs, anchor: tabs[0]!.id, activeId, runtime })))

/** Every element of a tree, depth first. */
function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elementsOf(element.props['children'] as ReactNode)]
}

/** The elements the row returns, with their handlers. The row is called inside the render of a probe, where its hooks are allowed. */
function elementsOfRow(tabs: TabItem[], context: Partial<SidebarUi> = {}): ReactElement<Record<string, unknown>>[] {
  let tree: ReactNode = null
  const Probe = (): null => {
    tree = SplitRow.type({ tabs, anchor: tabs[0]!.id, activeId: tabs[0]!.id, runtime })
    return null
  }
  renderToStaticMarkup(createElement(SidebarUiContext.Provider, { value: ui(context) }, createElement(Probe)))
  return elementsOf(tree)
}

/** The grips of a row (the handles between two panes), in order. */
const gripsOf = (tabs: TabItem[]): ReactElement<Record<string, unknown>>[] => elementsOfRow(tabs).filter((element) => element.props['className'] === 'split-grip')

const rule = (selector: string): string => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(sidebar)?.[1] ?? ''

/** The classes of the element that opens with this attribute in the markup. */
const classesBefore = (markup: string, attribute: string): string[] => (new RegExp(`<div class="([^"]*)" ${attribute}`).exec(markup)?.[1] ?? '').split(/\s+/).filter(Boolean)

describe('the rows of split views in the sidebar', () => {
  it('are marked current only when the tab on screen is one of them', () => {
    expect(classesBefore(render(tabsOf('a', 'b'), 'b'), 'data-drop="tab"')).toContain('current')
    expect(classesBefore(render(tabsOf('a', 'b'), 'elsewhere'), 'data-drop="tab"')).not.toContain('current')
  })

  it('mark the pill of the tab on screen, and no other', () => {
    const pills = render(tabsOf('a', 'b'), 'b').match(/<button[^>]*class="split-pill[^"]*"[^>]*>/g) ?? []
    expect(pills.map((pill) => /class="[^"]*\bactive\b/.test(pill))).toEqual([false, true])
  })

  it('dim while all their tabs are dragged, as a tab does, and not for the drag of only one', () => {
    const tabs = tabsOf('a', 'b')
    expect(classesBefore(render(tabs, 'a', { dragging: new Set(['a', 'b']) }), 'data-drop="tab"')).toContain('dragging')
    expect(classesBefore(render(tabs, 'a', { dragging: new Set(['a']) }), 'data-drop="tab"')).not.toContain('dragging')
  })

  it('are not grey in the sheet, neither the row nor its pills, unless the tab on screen is one of them', () => {
    expect(rule('.sidebar .split-row')).toMatch(/background:\s*transparent/)
    expect(rule('.sidebar .split-pill')).toMatch(/background:\s*transparent/)
  })

  it('are grey in the sheet when the tab on screen is one of them, as the row of a single tab is', () => {
    expect(rule('.sidebar .split-row.current')).toMatch(/background:\s*var\(--row-active\)/)
    expect(rule('.sidebar .split-row.current .split-pill')).toMatch(/background:\s*color-mix/)
  })

  it('light up under the pointer', () => {
    expect(rule('.sidebar .split-pill:hover')).toMatch(/background:\s*var\(--tile-hover\)/)
  })
})

// The tip of the second button of the foot ("Téléchargements (⇧⌘J)") was centred on it and cut by the edge of the window.
describe('the tips of the foot of the sidebar', () => {
  it('start at the button for the first three (archive, Lire plus tard, downloads), whose centred tip would leave the window on the left', () => {
    expect(sidebar).toMatch(/\.sidebar \.footer > \[data-tip\]:nth-child\(-n\+3\)::after,\s*\.sidebar \.footer > :nth-child\(-n\+3\) \[data-tip\]::after\s*\{\s*left:\s*0;\s*transform:\s*none/)
  })

  it('does the same for the button of the downloads when it sits in the group of the chip, as it does with the chip on', () => {
    // The second rule above reaches a tip one level down: the chip's group is the child of the foot, its button carries the tip.
    const download = { id: 'd1', filename: 'a.pdf', url: 'https://exemple.fr/a.pdf', path: '/tmp/a.pdf', state: 'progressing' as const, receivedBytes: 1, totalBytes: 10, startedAt: 0 }
    for (const view of [chipView([], noStatus()), chipView([download], noStatus())]) {
      const markup = renderToStaticMarkup(createElement(DownloadChip, { view, onOpenPanel: noop, onCancel: noop }))
      expect(markup, view.state).toMatch(/^<div class="dlc-group[^"]*"><button[^>]*class="footer-side footer-downloads[^"]*"[^>]*data-tip="[^"]+"/)
    }
  })

  it('end at the button for the last, whose centred tip would leave it on the right', () => {
    expect(rule('.sidebar .footer > [data-tip]:last-child::after')).toMatch(/right:\s*0/)
  })
})

// The icons of the extensions touched one another.
describe('the icons of the extensions', () => {
  it('have room between them, in the sidebar and in the toolbar of the page', () => {
    expect(/browser-action-list\s*\{[^}]*gap:\s*6px/.exec(styles)).not.toBeNull()
    expect(/\.page-toolbar browser-action-list\s*\{[^}]*gap:\s*6px/.exec(toolbar)).not.toBeNull()
  })
})

// A split row could not be moved: it had no handle for a drag.
describe('the drag of the row of a split view', () => {
  it('starts from the row, takes both tabs, and ends with the drag like any other row', () => {
    const dragStartRow = vi.fn()
    const dragEnd = vi.fn()
    const tabs = tabsOf('a', 'b')
    const row = elementsOfRow(tabs, { dragStartRow, dragEnd }).find((element) => element.props['data-drop'] === 'tab')
    expect(row?.props['draggable']).toBe(true)
    const event = { type: 'dragstart' }
    ;(row?.props['onDragStart'] as (e: unknown) => void)(event)
    expect(dragStartRow).toHaveBeenCalledWith(tabs[0], event, ['a', 'b'])
    expect(row?.props['onDragEnd']).toBe(dragEnd)
  })

  // Which tabs go (both of the view, or the selection) is draggedIds's answer, measured in shared/dnd.test.ts.
  it('dims while it lasts, as a tab does', () => {
    expect(interactions).toMatch(/\.sidebar \.split-row\.dragging/)
  })
})

// A quick way to undo a split view: a handle always there between the panes,
// a click undoes the view, ← → trade the panes.
describe('the handle of the row of a split view', () => {
  it('takes every tab out but the last, which is left alone in a view of one', () => {
    expect(unsplitOrder(['a', 'b'])).toEqual(['a'])
    expect(unsplitOrder(['a', 'b', 'c'])).toEqual(['a', 'b'])
    expect(unsplitOrder(['a'])).toEqual([])
    expect(unsplitOrder([])).toEqual([])
  })

  it('is between two panes, one more for each pane after the second, and not before the first', () => {
    const grips = (ids: string[]): number => (render(tabsOf(...ids)).match(/class="split-grip"/g) ?? []).length
    expect([grips(['a']), grips(['a', 'b']), grips(['a', 'b', 'c'])]).toEqual([0, 1, 2])
    expect(render(tabsOf('a', 'b'))).toMatch(/<button[^>]*class="split-pill[^"]*"[\s\S]*<button[^>]*class="split-grip"[\s\S]*<button[^>]*class="split-pill/)
  })

  it('undoes the view on a click (asked as "un bouton rapide pour des-splitter"), without the click reaching the row', () => {
    const [grip] = gripsOf(tabsOf('a', 'b', 'c'))
    const event = { stopPropagation: vi.fn() }
    ;(grip?.props['onClick'] as (e: typeof event) => void)(event)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls).toEqual([[{ type: 'split/remove', tabId: 'a' }], [{ type: 'split/remove', tabId: 'b' }]])
    // A double click is two clicks: the handle has no handler of its own for it.
    expect(grip?.props['onDoubleClick']).toBeUndefined()
  })

  it('undoes the view on Enter as well, and keeps the key from doing anything else', () => {
    const [grip] = gripsOf(tabsOf('a', 'b'))
    const event = { key: 'Enter', preventDefault: vi.fn() }
    ;(grip?.props['onKeyDown'] as (e: typeof event) => void)(event)
    expect(dispatch.mock.calls).toEqual([[{ type: 'split/remove', tabId: 'a' }]])
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('trades the pane with its neighbour on ← and →, by split/move', () => {
    const grip = gripsOf(tabsOf('a', 'b'))[0]
    const press = (key: string) => (grip?.props['onKeyDown'] as (e: { key: string; preventDefault: () => void }) => void)({ key, preventDefault: noop })
    press('ArrowLeft')
    press('ArrowRight')
    // The handle sits before the second pane: ← moves that pane toward the first, → moves the first toward the second.
    expect(dispatch.mock.calls).toEqual([[{ type: 'split/move', tabId: 'b', direction: -1 }], [{ type: 'split/move', tabId: 'a', direction: 1 }]])
  })

  it('leaves the other keys alone', () => {
    const [grip] = gripsOf(tabsOf('a', 'b'))
    const event = { key: 'x', preventDefault: vi.fn() }
    ;(grip?.props['onKeyDown'] as (e: typeof event) => void)(event)
    expect(dispatch).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('is drawn at rest (24 x 28 px, the glyph colour), not only under the pointer', () => {
    expect(rule('.sidebar .split-grip')).toMatch(/width:\s*24px;\s*height:\s*28px/)
    expect(rule('.sidebar .split-grip')).not.toMatch(/display:\s*none/)
    expect(sidebar).not.toContain('split-unsplit')
  })
})
