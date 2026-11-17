// The button « Annoter » in the strip of each pane of a split view, drawn for real. The strip of a pane is the <Toolbar> that SplitDividers renders for each
// pane: the flag must reach it, or the button is never there (two pages side by side showed no button in either strip).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeState, SplitView, TabItem } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { defaultTheme } from '@shared/theme'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'

// The window's own snapshot, and no sidebar: what is checked is the stage of the page card, which App draws beside it.
const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))
vi.mock('./Sidebar', () => ({ FLOATING: false, Sidebar: () => null }))

import { App, SplitDividers } from './App'
import { Toolbar } from './Toolbar'

beforeEach(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  setLanguage('fr')
})
afterEach(() => vi.unstubAllGlobals())

const tab = (id: string): TabItem => ({ id, spaceId: 's', url: `https://${id}.local/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 2 })
const space = { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never
const runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }
const split: SplitView = { id: 'v', spaceId: 's', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] }

/** The label of the button « Annoter » in the French catalogue. */
const ANNOTATE = 'aria-label="Annoter"'

/** How many buttons « Annoter » a markup holds. */
const buttons = (markup: string): number => markup.split(ANNOTATE).length - 1

/** The layer of the split view, as App draws it with the flag it is given. */
const layer = (annotate: boolean, activeId = 'a'): string =>
  renderToStaticMarkup(
    createElement(SplitDividers, {
      split,
      tabs: [tab('a'), tab('b')],
      activeId,
      space,
      runtime,
      sidebarVisible: true,
      fullUrl: false,
      draggable: false,
      stageLeft: null,
      zoom: { showZoomIndicator: false, siteZoom: {} },
      scrollSync: false,
      synced: false,
      annotate
    })
  )

/** One strip of a split view, as the layer gives it to a pane. */
const strip = (focused: boolean, annotate: boolean): string =>
  renderToStaticMarkup(
    createElement(Toolbar, { space, current: tab('a'), runtime, sidebarVisible: true, fullUrl: false, draggable: false, canSplit: false, annotate, pane: { style: {}, focused, onSelect: () => undefined, onClose: () => undefined } })
  )

describe('the button in the strip of a split pane', () => {
  // Guard: the strip of the focused pane has the button when the flag is on, and only then.
  it('the strip of the focused pane shows the button when the flag is on', () => {
    expect(buttons(strip(true, true))).toBe(1)
    expect(buttons(strip(true, false))).toBe(0)
  })

  // Guard: the page that has the focus is the one that is annotated, so the strip of the other pane never offers the button.
  it('the strip of a pane that is not focused has none', () => {
    expect(buttons(strip(false, true))).toBe(0)
  })

  // Guard: the split layer hands the flag to the strips it draws. Without it the strips never show the button, whatever the state of the window.
  it('the split layer gives the flag to its strips: one button, in the strip of the focused pane', () => {
    expect(buttons(layer(true))).toBe(1)
    expect(buttons(layer(false))).toBe(0)
  })

  it('follows the focus from one pane to the other, and is absent when neither pane is focused', () => {
    expect(buttons(layer(true, 'b'))).toBe(1)
    expect(layer(true, 'a')).not.toBe(layer(true, 'b'))
    expect(buttons(layer(true, 'elsewhere'))).toBe(0)
  })
})

describe('the window that draws the split view', () => {
  /** The window, its two tabs side by side in a split view, the first one on screen, with the flag of the annotation as the main process gives it. */
  const windowWith = (annotateEnabled: boolean | undefined): string => {
    const base = createInitialState({ now: 1, newId: () => 'id' })
    const spaceId = base.activeSpaceId
    const tabs = [{ ...tab('a'), spaceId }, { ...tab('b'), spaceId }]
    const state = { ...base, tabs, splits: [{ ...split, spaceId }], activeTabBySpace: { ...base.activeTabBySpace, [spaceId]: 'a' } }
    holder.snapshot = { state, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], ...(annotateEnabled === undefined ? {} : { annotateEnabled }) } as unknown as UiSnapshot
    return renderToStaticMarkup(createElement(App))
  }

  // Guard: the split layer receives the flag from the window's snapshot, as the normal bar does (`annotateEnabled`).
  it('hands the flag of its snapshot to the split layer: the strip of the focused pane has the button only while the flag is on', () => {
    expect(buttons(windowWith(true))).toBe(1)
    expect(buttons(windowWith(false))).toBe(0)
    expect(buttons(windowWith(undefined))).toBe(0)
  })
})
