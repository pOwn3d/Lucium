// The idle time a tab reports to the sleep rules: read from a single reading of the clock.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
vi.mock('./sleep-pressure', () => ({ memoryPressure: () => Promise.resolve('normal') }))
vi.mock('./battery-saver', () => ({ batterySaver: () => ({ active: () => false }) }))

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

afterEach(() => vi.restoreAllMocks())

describe('the idle time of a tab in its sleep facts', () => {
  it('is never negative when the millisecond changes while it is computed', () => {
    const fake = fakeBrowser({ runtime: { tabs: {} }, group: new Set(), pages: new Map(), idleSince: new Map(), leader: { downloadSources: new Map() } })
    // A clock that moves on by one millisecond at every reading.
    let clock = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => clock++)
    const facts = shell['sleepFacts']!.call(fake.self, 'tab') as { idleMs: number }
    expect(facts.idleMs).toBe(0)
  })

  it('counts the time since the tab was last seen', () => {
    const fake = fakeBrowser({ runtime: { tabs: {} }, group: new Set(), pages: new Map(), idleSince: new Map([['tab', 400]]), leader: { downloadSources: new Map() } })
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const facts = shell['sleepFacts']!.call(fake.self, 'tab') as { idleMs: number }
    expect(facts.idleMs).toBe(600)
  })
})
