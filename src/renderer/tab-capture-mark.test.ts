// @vitest-environment happy-dom
// The mark of a tab an extension captures the sound of (shared/tab-capture.ts): on its row in the sidebar and in the bar above the page when it is the one on
// screen, with the name of the extension in its tooltip, and a click that stops the capture. Mounted in a document: the click and the words are what is read.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { RuntimeState, TabItem, TabRuntime } from '@shared/model'
import { defaultTheme } from '@shared/theme'
import { Toolbar } from './Toolbar'
import { SidebarUiContext, TabRow, type SidebarUi } from './SidebarRows'
import { click, installBridge, mount, pointerOver, type Mounted } from './dom.test-support'

const noop = (): void => undefined
const tab: TabItem = { id: 'a', spaceId: 's', url: 'https://meet.example.com/abc', title: 'Réunion', pinned: false, createdAt: 1, lastActiveAt: 2 }
const awake: TabRuntime = { loading: false, audible: true, muted: false, awake: true }
const runtimeOf = (info: TabRuntime): RuntimeState => ({ tabs: { a: info }, canGoBack: false, canGoForward: false })

const ui: SidebarUi = { selected: new Set(), dragging: new Set(), mark: null, developerHosts: [], containers: [], badges: false, clickRow: noop, menuRow: noop, dragStartRow: noop, dragStartFolder: noop, dragEnd: noop, clearSelection: noop, hoverStart: noop, hoverEnd: noop }

let mounted: Mounted | null = null
beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  setLanguage('fr')
})

function row(info: TabRuntime, calls: { stopTabCapture: ReturnType<typeof vi.fn> } = { stopTabCapture: vi.fn() }) {
  installBridge({ stopTabCapture: calls.stopTabCapture, toggleMute: vi.fn() })
  const selected = vi.fn()
  mounted = mount(createElement(SidebarUiContext.Provider, { value: { ...ui, clickRow: selected } }, createElement(TabRow, { tab, active: false, inSplit: false, runtime: runtimeOf(info) })))
  return { container: mounted.container, stop: calls.stopTabCapture, selected, mark: mounted.container.querySelector<HTMLButtonElement>('.tab-captured') }
}

function bar(info: TabRuntime, calls: { stopTabCapture: ReturnType<typeof vi.fn>; tooltip?: ReturnType<typeof vi.fn> } = { stopTabCapture: vi.fn() }) {
  installBridge({ stopTabCapture: calls.stopTabCapture, ...(calls.tooltip ? { tooltip: calls.tooltip } : {}) })
  mounted = mount(createElement(Toolbar, { space: { id: 's', name: 'Travail', emoji: '💼', theme: defaultTheme(), profileId: 'default' } as never, current: tab, runtime: runtimeOf(info), sidebarVisible: true, fullUrl: false, draggable: false, canSplit: true }))
  return { container: mounted.container, stop: calls.stopTabCapture, mark: mounted.container.querySelector<HTMLButtonElement>('.tb-capture') }
}

describe('the row of a tab an extension captures the sound of', () => {
  it('has the mark, with who listens in its tooltip, and a name that says what a click does', () => {
    const { mark } = row({ ...awake, capturedBy: 'Sous-titres' })
    expect(mark).not.toBeNull()
    expect(mark!.getAttribute('title')).toBe('Sous-titres capte le son de cet onglet')
    expect(mark!.getAttribute('aria-label')).toBe('Arrêter la capture du son par Sous-titres')
  })

  it('has no mark for a tab nobody captures, whether or not it makes a sound', () => {
    expect(row(awake).mark).toBeNull()
    mounted?.unmount()
    expect(row({ ...awake, audible: false, muted: true }).mark).toBeNull()
  })

  it('stops the capture of this tab with a click, and does not select the row', async () => {
    const { mark, stop, selected } = row({ ...awake, capturedBy: 'Sous-titres' })
    await click(mark!)
    expect(stop).toHaveBeenCalledExactlyOnceWith('a')
    expect(selected).not.toHaveBeenCalled()
  })

  it('keeps the place of the close button, as every mark of the row does (nothing moves under the pointer)', () => {
    const { container } = row({ ...awake, audible: false, capturedBy: 'Sous-titres' })
    expect(container.querySelector('.tab')!.className).toContain('has-aux')
  })

  it('keeps the speaker of the row: the sound of the tab is its own mark', () => {
    const { container } = row({ ...awake, capturedBy: 'Sous-titres' })
    expect(container.querySelector('.tab-sound')).not.toBeNull()
  })

  it('is written in English when the language is English', () => {
    setLanguage('en')
    const { mark } = row({ ...awake, capturedBy: 'Captions' })
    expect(mark!.getAttribute('title')).toBe('Captions is capturing this tab’s sound')
    expect(mark!.getAttribute('aria-label')).toBe('Stop Captions from capturing the sound')
  })
})

describe('the bar above the page of a tab an extension captures the sound of', () => {
  it('has the mark, with who listens in its tooltip', () => {
    const { mark } = bar({ ...awake, capturedBy: 'Sous-titres' })
    expect(mark).not.toBeNull()
    expect(mark!.getAttribute('aria-label')).toBe('Arrêter la capture du son par Sous-titres')
  })

  it('has no mark for a page nobody captures', () => {
    expect(bar(awake).mark).toBeNull()
  })

  it('says who listens in its tooltip, once the pointer rests on it', () => {
    vi.useFakeTimers()
    try {
      const tooltip = vi.fn()
      const { mark } = bar({ ...awake, capturedBy: 'Sous-titres' }, { stopTabCapture: vi.fn(), tooltip })
      pointerOver(mark!)
      vi.advanceTimersByTime(3000)
      expect(tooltip).toHaveBeenCalledWith(expect.objectContaining({ text: 'Sous-titres capte le son de cet onglet' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the capture of the page on screen with a click', async () => {
    const { mark, stop } = bar({ ...awake, capturedBy: 'Sous-titres' })
    await click(mark!)
    expect(stop).toHaveBeenCalledExactlyOnceWith('a')
  })
})
