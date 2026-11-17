// @vitest-environment happy-dom
// The tab search (⌘⇧A) offers « Annuler » after a tab was archived with ⌫: as long as every notice with an action (eight seconds), and not while the
// pointer is on it (it used to go after five, whatever the person was doing). Its bar of time reads the same duration.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { RuntimeState, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { mount, pointerOut, pointerOver, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, dispatched: [] as unknown[] }))
vi.mock('./api', () => ({
  api: () => ({ dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()), closeOverlay: () => undefined }),
  useSnapshot: () => holder.snapshot
}))

import { TabSearch } from './TabSearch'

let mounted: Mounted | null = null
const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))
const undoRow = (): HTMLElement | null => mounted!.container.querySelector<HTMLElement>('.ts-undo')

/** A space with three tabs, and the bar over it; ⌫ on the empty field archives the first row. */
function search(): void {
  let state: SidebarState = createInitialState({ now: 1, newId: ((n) => () => `id${++n}`)(0) })
  const space = state.spaces[0]!.id
  for (const [url, title] of [['https://a.example/', 'Alpha'], ['https://b.example/', 'Beta'], ['https://c.example/', 'Gamma']] as const) {
    state = reduce(state, { type: 'tab/open', url, background: true, spaceId: space }, { now: 2, newId: () => `tab-${title}` })
    state = { ...state, tabs: state.tabs.map((tab) => (tab.url === url ? { ...tab, title } : tab)) }
  }
  const runtime: RuntimeState = { tabs: Object.fromEntries(state.tabs.map((tab) => [tab.id, { loading: false, audible: false, muted: false, awake: true }])), canGoBack: false, canGoForward: false }
  holder.snapshot = { state, runtime, extensions: [], downloads: [], platform: 'darwin' }
  mounted = mount(createElement(TabSearch))
}
const archiveFirst = (): void => act(() => void mounted!.container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })))

beforeEach(() => {
  setLanguage('fr')
  holder.dispatched = []
  vi.useFakeTimers()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('« Annuler » of the tab search', () => {
  it('is offered for as long as every notice with an action, and its bar of time reads the same duration', () => {
    search()
    archiveFirst()
    expect(holder.dispatched).toEqual([expect.objectContaining({ type: 'tab/archive' })])
    expect(undoRow()?.style.getPropertyValue('--notice-ms')).toBe(`${ACTION_NOTICE_MS}ms`)
    advance(ACTION_NOTICE_MS - 1)
    expect(undoRow()).not.toBeNull()
    advance(1)
    expect(undoRow()).toBeNull()
  })

  it('waits while the pointer is on it, and goes on with what it had left', () => {
    search()
    archiveFirst()
    advance(6000)
    pointerOver(undoRow()!)
    advance(ACTION_NOTICE_MS * 3)
    expect(undoRow()).not.toBeNull()
    pointerOut(undoRow()!)
    advance(ACTION_NOTICE_MS - 6000 - 1)
    expect(undoRow()).not.toBeNull()
    advance(1)
    expect(undoRow()).toBeNull()
  })
})
