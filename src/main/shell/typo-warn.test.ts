import { describe, expect, it, vi } from 'vitest'
import { expectLookalikeWarning, knownHostsOf } from './typo-warn'

const empty: { favorites: Array<Record<string, unknown>>; bookmarks: Array<Record<string, unknown>>; tabs: Array<Record<string, unknown>> } = { favorites: [], bookmarks: [], tabs: [] }
const on = { typoGuard: true }

function run(state: Partial<typeof empty>, history: string[], address: string, settings = on) {
  const gate = { expect: vi.fn() }
  const historyHosts = vi.fn(() => history)
  expectLookalikeWarning(settings, { ...empty, ...state } as never, historyHosts, address, gate)
  return { gate, historyHosts }
}

describe('a typed address announced to the lookalike gate', () => {
  it('is announced with the site it looks like when the history holds it', () => {
    expect(run({}, ['google.com'], 'https://gogle.com/').gate.expect).toHaveBeenCalledWith('gogle.com', 'google.com')
  })

  it('is announced for a favourite, a bookmark, a pinned tab and the address a pinned tab returns to', () => {
    expect(run({ favorites: [{ url: 'https://www.paypal.com/' }] }, [], 'https://paypa1.com/').gate.expect).toHaveBeenCalledWith('paypa1.com', 'paypal.com')
    expect(run({ bookmarks: [{ url: 'https://github.com/me' }] }, [], 'https://githhub.com/').gate.expect).toHaveBeenCalledWith('githhub.com', 'github.com')
    expect(run({ tabs: [{ pinned: true, url: 'https://elsewhere.net/', anchorUrl: 'https://mybank.example/' }] }, [], 'https://mybanc.example/').gate.expect).toHaveBeenCalledWith('mybanc.example', 'mybank.example')
  })

  it('does not count a tab that is not pinned: it is a page that was opened, not a site the person keeps', () => {
    expect(run({ tabs: [{ pinned: false, url: 'https://google.com/' }] }, [], 'https://gogle.com/').gate.expect).not.toHaveBeenCalled()
  })

  it('is not announced when the guard is off, and the history is not even read', () => {
    const { gate, historyHosts } = run({}, ['google.com'], 'https://gogle.com/', { typoGuard: false })
    expect(gate.expect).not.toHaveBeenCalled()
    expect(historyHosts).not.toHaveBeenCalled()
  })

  it('is not announced for what is no web address: a search, a file, a page of Lucium', () => {
    for (const address of ['https://www.google.com/search?q=gogle.com', 'file:///Users/me/gogle.com', 'lucium://history', 'javascript:alert(1)', 'gogle.com', 'ftp://gogle.com/', 'lucium://gogle.com/']) {
      expect(run({}, ['google.com'], address).gate.expect, address).not.toHaveBeenCalled()
    }
  })

  it('is not announced when the typed site is itself a known one', () => {
    expect(run({}, ['google.com', 'gogle.com'], 'https://gogle.com/').gate.expect).not.toHaveBeenCalled()
  })

  it('reads the hosts of an address that cannot be read as none', () => {
    expect(knownHostsOf({ ...empty, favorites: [{ url: 'not an address' }] } as never, ['a.example'])).toEqual(['a.example'])
  })
})
