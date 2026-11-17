// The lookup of an icon reads the picture to check it. The service hands those bytes on to whoever keeps the copy the interface draws (the
// engine, engine/site-icons.ts): without that the icon is asked a second time, by the session of the profile, a moment after it was found.
// The resolver is replaced by a recorder of what the service gives it: its own rules are favicon-resolver.test.ts.

import { describe, expect, it, vi } from 'vitest'

const given: Array<Record<string, (...args: unknown[]) => unknown>> = []
vi.mock('electron', () => ({ net: {}, session: { fromPartition: () => ({}) } }))
vi.mock('./favicon-resolver', () => ({
  FaviconResolver: class {
    constructor(deps: Record<string, (...args: unknown[]) => unknown>) {
      given.push(deps)
    }
  }
}))

const { FaviconService } = await import('./favicon-service')

const base = { store: { get: () => ({ settings: { resolveFavicons: true } }) as never, subscribe: () => () => undefined }, views: () => [], hasPage: () => false, dispatch: () => undefined, blocked: () => false }

describe('the bytes of an icon the lookup found', () => {
  it('are handed on with the address and the type, as they came', () => {
    given.length = 0
    const kept: unknown[][] = []
    new FaviconService({ ...base, keepIcon: (...args) => void kept.push(args) })
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    given[0]!['keep']!('https://exemple.fr/logo.png', bytes, 'image/png')
    expect(kept).toEqual([['https://exemple.fr/logo.png', bytes, 'image/png']])
  })

  it('are dropped without a word when nobody keeps them (an engine check that has no copies)', () => {
    given.length = 0
    new FaviconService(base)
    expect(() => given[0]!['keep']!('https://exemple.fr/logo.png', Uint8Array.from([1]), null)).not.toThrow()
  })
})
