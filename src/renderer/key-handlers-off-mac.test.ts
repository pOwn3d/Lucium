// @vitest-environment happy-dom
// The key a hint draws is the key that works: where the hint says « Ctrl+Entrée » (Linux, Windows) the sheet answers Ctrl and Return, not the Windows or Super
// key that « ⌘↩ » asked for; on macOS it is still ⌘↩. The tab search opens a line beside the page, the sheet « Quitter ce site ? » leaves, with that key.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { PlatformId } from '@shared/platform'
import type { RuntimeState, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { mount, type Mounted } from './dom.test-support'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, dispatched: [] as unknown[], answers: [] as unknown[][] }))
vi.mock('./api', () => ({
  api: () => ({
    dispatch: (action: unknown) => (holder.dispatched.push(action), Promise.resolve()),
    closeOverlay: () => undefined,
    answerLeave: (...args: unknown[]) => void holder.answers.push(args)
  }),
  useSnapshot: () => holder.snapshot
}))

import { LeaveSheet } from './LeaveSheet'
import { TabSearch } from './TabSearch'

let mounted: Mounted | null = null

/** A window with two tabs of one space, the second (Beta) on screen and the first (Alpha) the first line of the list, and a snapshot that says the system. */
function windowOn(platform: PlatformId): void {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  let state: SidebarState = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://a.example/' }, ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://b.example/' }, ctx)
  state = { ...state, tabs: state.tabs.map((tab, i) => ({ ...tab, title: ['Alpha', 'Beta'][i] ?? tab.title })) }
  const runtime: RuntimeState = { tabs: Object.fromEntries(state.tabs.map((tab) => [tab.id, { loading: false, audible: false, muted: false, awake: true }])), canGoBack: false, canGoForward: false }
  holder.snapshot = { state, runtime, extensions: [], downloads: [], platform }
}

const press = (target: EventTarget, init: KeyboardEventInit): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))

beforeEach(() => {
  setLanguage('fr')
  holder.dispatched = []
  holder.answers = []
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('« Ouvrir à côté » of the tab search', () => {
  const choose = (platform: PlatformId, init: KeyboardEventInit): unknown[] => {
    windowOn(platform)
    mounted = mount(createElement(TabSearch))
    press(mounted.container.querySelector('input')!, { key: 'Enter', ...init })
    return holder.dispatched
  }

  it('is Ctrl+Entrée away from macOS: a split view, and the Windows or Super key does nothing more than Enter', () => {
    expect(choose('linux', { ctrlKey: true })).toEqual([expect.objectContaining({ type: 'split/create' })])
    mounted!.unmount()
    holder.dispatched = []
    expect(choose('linux', { metaKey: true })).toEqual([expect.objectContaining({ type: 'tab/select' })])
  })

  it('is still ⌘↩ on macOS, and Control does nothing more than Enter', () => {
    expect(choose('darwin', { metaKey: true })).toEqual([expect.objectContaining({ type: 'split/create' })])
    mounted!.unmount()
    holder.dispatched = []
    expect(choose('darwin', { ctrlKey: true })).toEqual([expect.objectContaining({ type: 'tab/select' })])
  })
})

describe('« Quitter » of the sheet « Quitter ce site ? »', () => {
  const answer = (platform: PlatformId, init: KeyboardEventInit): unknown[][] => {
    windowOn(platform)
    mounted = mount(createElement(LeaveSheet, { request: { id: 'leave-1', site: 'exemple.fr' } }))
    press(window, { key: 'Enter', ...init })
    return holder.answers
  }

  it('is Ctrl+Entrée away from macOS', () => {
    expect(answer('win32', { ctrlKey: true })).toEqual([['leave-1', true]])
    mounted!.unmount()
    holder.answers = []
    expect(answer('win32', { metaKey: true })).toEqual([])
  })

  it('is still ⌘↩ on macOS', () => {
    expect(answer('darwin', { metaKey: true })).toEqual([['leave-1', true]])
    mounted!.unmount()
    holder.answers = []
    expect(answer('darwin', { ctrlKey: true })).toEqual([])
  })
})
