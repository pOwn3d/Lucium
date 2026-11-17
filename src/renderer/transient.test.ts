// @vitest-environment happy-dom
// A value shown for a moment (transient.ts), mounted in a document: its timer, and what it leaves when the component goes.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type Mounted } from './dom.test-support'
import { COPIED_MS, useTransient } from './transient'

let show: (value: string) => void = () => undefined
let mounted: Mounted | null = null

function Probe({ ms }: { ms: number }) {
  const [value, set] = useTransient('', ms)
  show = set
  return createElement('output', null, value === '' ? 'idle' : value)
}

const shown = (): string => mounted!.container.textContent ?? ''
const wait = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))
const say = (value: string): void => act(() => show(value))

beforeEach(() => {
  vi.useFakeTimers()
  mounted = mount(createElement(Probe, { ms: 3000 }))
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
})

describe('a value shown for a moment', () => {
  it('is the idle one until something is shown, then the shown one for the time given, not longer', () => {
    expect(shown()).toBe('idle')
    say('Modifications annulées')
    expect(shown()).toBe('Modifications annulées')
    wait(2999)
    expect(shown()).toBe('Modifications annulées')
    wait(1)
    expect(shown()).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts its time from the last showing: a second one is not cut short by the timer of the first', () => {
    say('un')
    wait(2000)
    say('deux')
    expect(vi.getTimerCount()).toBe(1)
    wait(2000)
    expect(shown()).toBe('deux')
    wait(1000)
    expect(shown()).toBe('idle')
  })

  it('leaves no timer behind when the component goes while the value is shown', () => {
    say('copié')
    expect(vi.getTimerCount()).toBe(1)
    mounted!.unmount()
    mounted = null
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the tick of a copied address a little over a second', () => {
    expect(COPIED_MS).toBe(1200)
  })
})
