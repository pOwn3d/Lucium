// Who gets the pages of a reopened tab: the tab made by the reopening, once, and not by a dispatch that happens to be made while the state changes.

import { describe, expect, it } from 'vitest'
import type { ClosedHistory } from '@shared/model'
import { ReopenLedger } from './reopen-ledger'

const history = (name: string): ClosedHistory => ({ entries: [{ url: `https://a.example/${name}-1`, title: '1' }, { url: `https://a.example/${name}`, title: '2' }], index: 1 })
const entry = (name: string) => ({ url: `https://a.example/${name}`, history: history(name) })

describe('ReopenLedger', () => {
  it('gives the pages to the new tab that is made during the reopening, once', () => {
    const ledger = new ReopenLedger()
    const reopening = ledger.begin(['old'], [entry('p')])
    expect(ledger.take({ id: 'new', url: 'https://a.example/p' })).toEqual(history('p'))
    expect(ledger.take({ id: 'new', url: 'https://a.example/p' })).toBeUndefined()
    ledger.end(reopening, () => [])
  })

  it('gives nothing to a tab that existed before, to another address, or when nothing is being reopened', () => {
    const ledger = new ReopenLedger()
    expect(ledger.take({ id: 'x', url: 'https://a.example/p' })).toBeUndefined()
    const reopening = ledger.begin(['old'], [entry('p')])
    expect(ledger.take({ id: 'old', url: 'https://a.example/p' })).toBeUndefined()
    expect(ledger.take({ id: 'new', url: 'https://a.example/other' })).toBeUndefined()
    ledger.end(reopening, () => [])
    expect(ledger.take({ id: 'late', url: 'https://a.example/p' })).toBeUndefined()
  })

  it('starts nothing for no entry, and ending nothing ends nothing', () => {
    const ledger = new ReopenLedger()
    expect(ledger.begin([], [])).toBeNull()
    expect(() => ledger.end(null, () => [])).not.toThrow()
  })

  it('is not ended by a dispatch made from inside the one that began it (this fails if any end clears the reopening)', () => {
    const ledger = new ReopenLedger()
    const outer = ledger.begin(['old'], [entry('p')])
    // The shell dispatches from a listener while the state is applied: that call began no reopening, and ends none.
    ledger.end(null, () => [{ id: 'new', url: 'https://a.example/p' }])
    expect(ledger.take({ id: 'new', url: 'https://a.example/p' })).toEqual(history('p'))
    ledger.end(outer, () => [])
  })

  it('leaves the reopening to the call that began it: another reopening token ends nothing', () => {
    const ledger = new ReopenLedger()
    const outer = ledger.begin(['old'], [entry('p')])
    ledger.end({ before: new Set(), entries: [] }, () => [])
    expect(ledger.take({ id: 'new', url: 'https://a.example/p' })).toBeDefined()
    ledger.end(outer, () => [])
  })

  it('keeps the pages of a tab opened in the background for its page, matched by address, once each', () => {
    const ledger = new ReopenLedger()
    const reopening = ledger.begin(['old'], [entry('p'), entry('q'), entry('p')])
    ledger.end(reopening, () => [
      { id: 'old', url: 'https://a.example/p' },
      { id: 'n1', url: 'https://a.example/p' },
      { id: 'n2', url: 'https://a.example/q' },
      { id: 'n3', url: 'https://a.example/p' },
      { id: 'n4', url: 'https://a.example/p' }
    ])
    expect(ledger.take({ id: 'old', url: 'https://a.example/p' })).toBeUndefined()
    expect(ledger.take({ id: 'n1', url: 'https://a.example/p' })).toEqual(history('p'))
    expect(ledger.take({ id: 'n2', url: 'https://a.example/q' })).toEqual(history('q'))
    expect(ledger.take({ id: 'n3', url: 'https://a.example/p' })).toEqual(history('p'))
    expect(ledger.take({ id: 'n4', url: 'https://a.example/p' })).toBeUndefined()
    expect(ledger.take({ id: 'n1', url: 'https://a.example/p' })).toBeUndefined()
  })

  it('does not keep what a page already took, and forgets the tabs that are gone', () => {
    const ledger = new ReopenLedger()
    const reopening = ledger.begin([], [entry('p'), entry('q')])
    expect(ledger.take({ id: 'n1', url: 'https://a.example/p' })).toBeDefined()
    ledger.end(reopening, () => [{ id: 'n1', url: 'https://a.example/p' }, { id: 'n2', url: 'https://a.example/q' }])
    expect(ledger.take({ id: 'n1', url: 'https://a.example/p' })).toBeUndefined()
    ledger.forget(new Set(['n1']))
    expect(ledger.take({ id: 'n2', url: 'https://a.example/q' })).toBeUndefined()
  })
})
