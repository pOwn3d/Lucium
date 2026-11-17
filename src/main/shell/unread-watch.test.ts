// The unread messages of the tabs, as a window keeps them: what a title says is held through the titles that blink, taken away when the title stays silent
// or when the tab is looked at, and forgotten with the page. The rules are in shared/tab-messages.test.ts; this is their wiring (a memory and a timer per tab).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNREAD_HOLD_MS } from '@shared/tab-messages'
import { UnreadWatch } from './unread-watch'

const SLACK = 'https://app.slack.com/client/T1/D1'

function watch(attended = false) {
  const state = { attended }
  const changed = vi.fn<(id: string) => void>()
  const unread = new UnreadWatch({ now: () => Date.now(), attended: () => state.attended, changed })
  return { unread, changed, state }
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }))
afterEach(() => vi.useRealTimers())

describe('the unread of a tab whose title blinks', () => {
  it('shows what the title says', () => {
    const { unread } = watch()
    expect(unread.title('t1', '(3) Twitch', 'https://www.twitch.tv/')).toEqual({ count: 3 })
    expect(unread.title('t2', '* Loic - Slack', SLACK)).toEqual({ mark: '*' })
    expect(unread.title('t3', 'Loic - Slack', SLACK)).toBeUndefined()
  })

  it('holds the badge through titles that say nothing, as long as another one says it again within the hold', () => {
    const { unread, changed } = watch()
    unread.title('t1', '! Loic - Slack', SLACK)
    for (let round = 0; round < 6; round++) {
      vi.advanceTimersByTime(UNREAD_HOLD_MS - 1000)
      expect(unread.title('t1', 'Loic - Slack', SLACK)).toEqual({ mark: '!' })
      vi.advanceTimersByTime(500)
      expect(unread.title('t1', '! Loic - Slack', SLACK)).toEqual({ mark: '!' })
    }
    expect(changed).not.toHaveBeenCalled()
  })

  // THE GUARD of the hold: without it the badge goes with the first title that says nothing, and comes back with the next one.
  it('keeps the count through a title without it, and the badge is still there until the hold is over', () => {
    const { unread } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    expect(unread.title('t1', 'Slack', SLACK)).toEqual({ count: 2 })
    vi.advanceTimersByTime(UNREAD_HOLD_MS - 1)
    expect(unread.current('t1')).toEqual({ count: 2 })
  })

  it('takes the badge away by itself, and tells the window, when the title stays silent for the whole hold', () => {
    const { unread, changed } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    unread.title('t1', 'Slack', SLACK)
    vi.advanceTimersByTime(UNREAD_HOLD_MS)
    expect(unread.current('t1')).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith('t1')
  })

  it('counts the hold from the last title that said something, not from the first', () => {
    const { unread, changed } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    vi.advanceTimersByTime(UNREAD_HOLD_MS - 1000)
    unread.title('t1', '(2) Slack', SLACK)
    unread.title('t1', 'Slack', SLACK)
    vi.advanceTimersByTime(UNREAD_HOLD_MS - 1)
    expect(unread.current('t1')).toEqual({ count: 2 })
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(unread.current('t1')).toBeUndefined()
  })

  // THE GUARD of the reading: the badge of a tab someone is looking at goes with the title that says there is nothing to read.
  it('takes the badge away at once when the title says nothing and the tab is attended', () => {
    const { unread, state, changed } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    state.attended = true
    expect(unread.title('t1', 'Slack', SLACK)).toBeUndefined()
    vi.advanceTimersByTime(UNREAD_HOLD_MS * 2)
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps a count that the title still says, even in a tab that is attended', () => {
    const { unread, state } = watch()
    state.attended = true
    expect(unread.title('t1', '(2) Slack', SLACK)).toEqual({ count: 2 })
    expect(unread.title('t1', '(1) Slack', SLACK)).toEqual({ count: 1 })
  })

  it('keeps the memory of each tab apart', () => {
    const { unread } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    unread.title('t2', 'Notes', 'https://exemple.org/')
    expect(unread.current('t1')).toEqual({ count: 2 })
    expect(unread.current('t2')).toBeUndefined()
  })
})

describe('a badge that was only held, when the tab comes on screen', () => {
  it('goes: the site has already taken it back', () => {
    const { unread } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    unread.title('t1', 'Slack', SLACK)
    expect(unread.appeared('t1')).toBe(true)
    expect(unread.current('t1')).toBeUndefined()
  })

  // THE GUARD: a title that still says there is something to read is not a held badge, and the tab coming on screen does not take it.
  it('stays when the title still says it', () => {
    const { unread } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    expect(unread.appeared('t1')).toBe(false)
    expect(unread.current('t1')).toEqual({ count: 2 })
  })

  it('does not run a timer for it afterwards', () => {
    const { unread, changed } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    unread.title('t1', 'Slack', SLACK)
    unread.appeared('t1')
    vi.advanceTimersByTime(UNREAD_HOLD_MS * 2)
    expect(changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a page that goes', () => {
  // THE GUARD: a page that is gone leaves no memory and no timer that would publish for a tab it no longer has.
  it('leaves nothing: no badge, no timer, no call to the window', () => {
    const { unread, changed } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    unread.title('t1', 'Slack', SLACK)
    expect(vi.getTimerCount()).toBe(1)
    unread.forget('t1')
    expect(unread.current('t1')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(UNREAD_HOLD_MS * 2)
    expect(changed).not.toHaveBeenCalled()
  })

  it('does not hold more than one timer for a tab, whatever the number of titles', () => {
    const { unread } = watch()
    unread.title('t1', '(2) Slack', SLACK)
    for (let i = 0; i < 20; i++) unread.title('t1', i % 2 === 0 ? 'Slack' : '(2) Slack', SLACK)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  })
})
