import { describe, expect, it } from 'vitest'
import { floatingNeedsSnapshot } from './snapshot-delivery'

describe('floatingNeedsSnapshot', () => {
  it('sends the snapshot while the floating sidebar shows', () => {
    expect(floatingNeedsSnapshot(true, false)).toBe(true)
    expect(floatingNeedsSnapshot(true, true)).toBe(true)
  })

  it('sends one more snapshot when the sidebar stops showing, so that it draws nothing', () => {
    expect(floatingNeedsSnapshot(false, true)).toBe(true)
  })

  it('sends nothing while the sidebar stays hidden', () => {
    expect(floatingNeedsSnapshot(false, false)).toBe(false)
  })
})
