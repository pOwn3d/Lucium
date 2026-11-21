// The lines "Capturer la partie visible" and "Capturer la page entière" of the command bar: they ask the main process for the capture, the way the File
// menu does (it closes the bar itself), and never only close the bar. The real component, drawn with no window; Enter is sent to the handler of its field.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, calls: [] as string[] }))
vi.mock('./api', () => ({
  api: () => new Proxy({}, { get: (_target, name) => () => { holder.calls.push(String(name)); return Promise.resolve(undefined) } }),
  useSnapshot: () => holder.snapshot
}))

import { CommandBar } from './CommandBar'

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {}, matchMedia: () => ({ matches: false }) })
  vi.stubGlobal('requestAnimationFrame', () => 0)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  setLanguage('fr')
  holder.calls = []
})

const elementsOf = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elementsOf(element.props['children'] as ReactNode)]
}

/** Types `text` in the bar over a window with one tab, moves down to the line that says `line`, and presses Enter on it. */
function choose(text: string, line: string): string[] {
  const base = createInitialState({ now: 1, newId: () => 'id' })
  const tab = { id: 't1', spaceId: base.activeSpaceId, url: 'https://exemple.org/', title: 'Exemple', pinned: false, createdAt: 1, lastActiveAt: 1 } as never
  holder.snapshot = { state: { ...base, tabs: [tab], activeTabBySpace: { ...base.activeTabBySpace, [base.activeSpaceId]: 't1' } }, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [] } as unknown as UiSnapshot
  const textOf = (node: ReactNode): string => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : isValidElement(node) ? textOf((node as ReactElement<Record<string, unknown>>).props['children'] as ReactNode) : '')
  let sent = 0
  let index = -1
  const Probe = () => {
    const tree = elementsOf(CommandBar({ mode: 'current', initial: text }))
    if (index < 0) {
      index = tree.filter((element) => element.props['role'] === 'option').findIndex((element) => textOf(element).toLowerCase().includes(line))
      expect(index, `a line that says "${line}"`).toBeGreaterThanOrEqual(0)
    }
    const field = tree.find((element) => element.props['role'] === 'combobox')!
    if (sent <= index) {
      const value = field.props['value'] as string
      const key = sent < index ? 'ArrowDown' : 'Enter'
      sent++
      ;(field.props['onKeyDown'] as (event: unknown) => void)({ key, shiftKey: false, metaKey: false, altKey: false, ctrlKey: false, currentTarget: { value, selectionStart: value.length, selectionEnd: value.length }, preventDefault: vi.fn() })
    }
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return holder.calls
}

describe('the capture lines of the command bar', () => {
  it('ask for the capture of the whole page', () => {
    expect(choose('capturer', 'page entière')).toContain('captureFullPage')
  })

  it('ask for the capture of the visible part', () => {
    const calls = choose('capturer', 'partie visible')
    expect(calls).toContain('captureVisible')
    expect(calls).not.toContain('captureFullPage')
  })
})
