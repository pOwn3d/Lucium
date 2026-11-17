// @vitest-environment happy-dom
// The appearance of the system (system-dark.ts), mounted in a document: a surface that stays open follows a change of macOS, and listens to
// nothing once it is gone. The card of a peek is mounted for real, as one of the surfaces that used to read the appearance once per drawing.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { mount, type Mounted } from './dom.test-support'
import { useSystemDark } from './system-dark'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({ peekAction: () => undefined, dispatch: () => Promise.resolve() }), useSnapshot: () => holder.snapshot }))

const { PeekHeader } = await import('./Panels')

/** The system's appearance, as `matchMedia` gives it: it says how many listen, and tells them when it changes. */
function system(dark: boolean) {
  const listeners = new Set<() => void>()
  const media = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener)
  }
  return {
    media,
    listening: () => listeners.size,
    turn(next: boolean) {
      media.matches = next
      act(() => {
        for (const listener of listeners) listener()
      })
    }
  }
}

let mounted: Mounted | null = null
let now = system(false)
const asked: string[] = []

beforeEach(() => {
  setLanguage('fr')
  now = system(false)
  asked.length = 0
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => (asked.push(query), now.media as unknown as MediaQueryList))
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

function Probe() {
  return createElement('output', null, useSystemDark() ? 'dark' : 'light')
}

describe('the appearance of the system', () => {
  it('is read when the surface opens, and followed while it stays open', () => {
    now = system(true)
    mounted = mount(createElement(Probe))
    expect(mounted.container.textContent).toBe('dark')
    expect(new Set(asked)).toEqual(new Set(['(prefers-color-scheme: dark)']))
    now.turn(false)
    expect(mounted.container.textContent).toBe('light')
    now.turn(true)
    expect(mounted.container.textContent).toBe('dark')
  })

  it('listens once, and no longer when the surface is gone', () => {
    mounted = mount(createElement(Probe))
    expect(now.listening()).toBe(1)
    mounted.unmount()
    mounted = null
    expect(now.listening()).toBe(0)
  })
})

describe('the card of a peek over a space whose appearance is automatic', () => {
  const card = (): string => mounted!.container.querySelector('.pk-card')?.className ?? ''

  it('turns dark, then light again, when macOS does, without anything else drawing it again', () => {
    const state = createInitialState({ now: 1, newId: () => 'id' })
    expect(state.spaces[0]?.theme.appearance ?? 'auto').toBe('auto')
    holder.snapshot = { state, peek: { url: 'https://exemple.org/page', title: 'Page' } } as unknown as UiSnapshot
    mounted = mount(createElement(PeekHeader, { rect: { x: 0, y: 0, width: 800, height: 600 } }))
    expect(card()).toBe('pk-card light')
    now.turn(true)
    expect(card()).toBe('pk-card dark')
    now.turn(false)
    expect(card()).toBe('pk-card light')
  })
})
