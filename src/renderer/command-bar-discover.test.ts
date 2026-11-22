// @vitest-environment happy-dom
// « Découvrir Lucium » from the command bar, drawn and used in a document: typing « découvrir » and validating asks for the panel `discover` (the line of the
// command `discover` in CommandBar.tsx), and in a private window, which does not open the panel, the bar does not offer the line at all.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISCOVER_REQUEST } from '@shared/discover'
import { setLanguage } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => {
  // Every call is written down and answers with a resolved promise, as the calls of the bar that are waited on (the history) expect.
  const act = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => (holder.asked.push([name, args]), Promise.resolve([])) })
  return { api: () => act, useSnapshot: () => holder.snapshot }
})

import { CommandBar } from './CommandBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeAll(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  setLanguage('fr')
  holder.asked = []
  const base = createInitialState({ now: 1, newId: () => 'id' })
  holder.snapshot = { state: base, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin' }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setLanguage('fr')
})

const field = (): HTMLInputElement => host.querySelector<HTMLInputElement>('input[role="combobox"]')!
const type = (value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const down = (): void => void act(() => void field().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
const enter = (): void => void act(() => void field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
const lines = (): string[] => [...host.querySelectorAll('[role="option"]')].map((line) => line.textContent ?? '')
const opened = (): unknown[] => holder.asked.filter(([name]) => name === 'openOverlay').map(([, args]) => args[0])

describe('« Découvrir Lucium » from the command bar', () => {
  it('opens the panel when « découvrir » is typed and validated', () => {
    act(() => root.render(createElement(CommandBar, { mode: 'new', initial: '' })))
    type('découvrir')
    // The first line is the search for the text typed; the command is the next one.
    expect(lines()[1]).toContain('Découvrir Lucium')
    down()
    enter()
    expect(opened()).toEqual([DISCOVER_REQUEST])
    expect(opened()).toEqual([{ panel: 'discover' }])
  })

  it('opens it as well from the English words when the interface is in English', () => {
    setLanguage('en')
    act(() => root.render(createElement(CommandBar, { mode: 'new', initial: '' })))
    type('discover')
    expect(lines()[1]).toContain('Discover Lucium')
    down()
    enter()
    expect(opened()).toEqual([{ panel: 'discover' }])
  })

  it('offers no line for it in a private window, which would refuse it without a word', () => {
    holder.snapshot = { ...(holder.snapshot as object), private: true }
    act(() => root.render(createElement(CommandBar, { mode: 'new', initial: '' })))
    type('découvrir')
    expect(lines().some((line) => line.includes('Découvrir Lucium'))).toBe(false)
    down()
    enter()
    expect(opened()).not.toContainEqual({ panel: 'discover' })
  })
})
