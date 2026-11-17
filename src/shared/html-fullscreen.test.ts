import { describe, expect, it } from 'vitest'
import { LEAVE_FULLSCREEN, fullscreenAfterSync, fullscreenReported } from './html-fullscreen'

const shown = (...ids: string[]) => new Set(ids)

describe('fullscreenReported', () => {
  it('gives the window to the tab on show that went full screen', () => {
    expect(fullscreenReported(null, 'a', true, shown('a'))).toEqual({ tab: 'a', leave: null })
  })

  it('sends a page that is not on show out of full screen at once, and keeps the one that holds the window', () => {
    expect(fullscreenReported(null, 'b', true, shown('a'))).toEqual({ tab: null, leave: 'b' })
    expect(fullscreenReported('a', 'b', true, shown('a'))).toEqual({ tab: 'a', leave: 'b' })
  })

  it('hands the window over to another tab on show, and tells the first to leave', () => {
    expect(fullscreenReported('a', 'b', true, shown('a', 'b'))).toEqual({ tab: 'b', leave: 'a' })
    // The same tab twice is nothing to leave.
    expect(fullscreenReported('a', 'a', true, shown('a'))).toEqual({ tab: 'a', leave: null })
  })

  it('gives the window back when the page that holds it leaves, and ignores the one that does not', () => {
    expect(fullscreenReported('a', 'a', false, shown('a'))).toEqual({ tab: null, leave: null })
    expect(fullscreenReported('a', 'b', false, shown('a'))).toEqual({ tab: 'a', leave: null })
    expect(fullscreenReported(null, 'b', false, shown())).toEqual({ tab: null, leave: null })
  })
})

describe('fullscreenAfterSync', () => {
  it('keeps a page that is still on show, and does nothing when none is in full screen', () => {
    expect(fullscreenAfterSync('a', shown('a', 'b'))).toEqual({ tab: 'a', leave: null })
    expect(fullscreenAfterSync(null, shown('a'))).toEqual({ tab: null, leave: null })
  })

  it('makes a page that is no longer on show (tab switched, space left, tab closed) give the window back', () => {
    expect(fullscreenAfterSync('a', shown('b'))).toEqual({ tab: null, leave: 'a' })
    expect(fullscreenAfterSync('a', shown())).toEqual({ tab: null, leave: 'a' })
  })
})

describe('LEAVE_FULLSCREEN', () => {
  it('leaves through the page, only when it is in full screen', () => {
    const exit = () => Promise.resolve()
    const inside = new Function('document', `return ${LEAVE_FULLSCREEN}`)({ fullscreenElement: {}, exitFullscreen: exit })
    expect(inside).toBeInstanceOf(Promise)
    expect(new Function('document', `return ${LEAVE_FULLSCREEN}`)({ fullscreenElement: null, exitFullscreen: exit })).toBe(false)
  })
})
