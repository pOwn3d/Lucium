// The deletion that can be taken back for eight seconds, as long as the pointer or the focus is not on its notice: what the panels of list rely on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_NOTICE_MS } from './toast'
import { createUndoQueue } from './undo-queue'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the undoable deletion', () => {
  it('waits as long as every notice with an action (eight seconds), hides the row at once, and then deletes', () => {
    const commit = vi.fn()
    const queue = createUndoQueue()
    queue.remove('a', 'Page retirée', commit)
    expect(ACTION_NOTICE_MS).toBe(8000)
    expect(queue.pending()).toEqual(['a'])
    vi.advanceTimersByTime(ACTION_NOTICE_MS - 1)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(queue.pending()).toEqual([])
  })

  it('deletes nothing when it is undone in time, and brings the row back', () => {
    const commit = vi.fn()
    const queue = createUndoQueue()
    queue.remove('a', 'Page retirée', commit)
    vi.advanceTimersByTime(3000)
    expect(queue.undo()).toBe(true)
    expect(queue.pending()).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(commit).not.toHaveBeenCalled()
  })

  it('undoes the last removal first, each with its own eight seconds', () => {
    const [first, second] = [vi.fn(), vi.fn()]
    const queue = createUndoQueue()
    queue.remove('a', 'Un', first)
    vi.advanceTimersByTime(2000)
    queue.remove('b', 'Deux', second)
    expect(queue.last()).toEqual({ id: 'b', message: 'Deux' })
    expect(queue.undo()).toBe(true)
    expect(queue.pending()).toEqual(['a'])
    vi.advanceTimersByTime(ACTION_NOTICE_MS - 2000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('says there is nothing to undo when nothing waits', () => {
    const queue = createUndoQueue()
    expect(queue.undo()).toBe(false)
    expect(queue.last()).toBeNull()
  })

  it('keeps the first removal of a row removed twice, and deletes it once', () => {
    const commit = vi.fn()
    const queue = createUndoQueue()
    queue.remove('a', 'Un', commit)
    queue.remove('a', 'Un encore', commit)
    expect(queue.pending()).toEqual(['a'])
    vi.advanceTimersByTime(ACTION_NOTICE_MS)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('makes every waiting deletion when the panel is left: what the person saw go does not come back', () => {
    const [first, second] = [vi.fn(), vi.fn()]
    const queue = createUndoQueue()
    queue.remove('a', 'Un', first)
    queue.remove('b', 'Deux', second)
    queue.flush()
    expect([first, second].map((commit) => commit.mock.calls.length)).toEqual([1, 1])
    expect(queue.pending()).toEqual([])
    // ...and the timers are gone: they do not delete a second time.
    vi.advanceTimersByTime(ACTION_NOTICE_MS * 2)
    expect([first, second].map((commit) => commit.mock.calls.length)).toEqual([1, 1])
  })

  it('tells its listeners when the list of hidden rows changes, and stops when they leave', () => {
    const queue = createUndoQueue()
    const listener = vi.fn()
    const leave = queue.subscribe(listener)
    queue.remove('a', 'Un', () => undefined)
    queue.undo()
    expect(listener).toHaveBeenCalledTimes(2)
    leave()
    queue.remove('b', 'Deux', () => undefined)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('takes the delay and the clock it is given', () => {
    const commit = vi.fn()
    const queue = createUndoQueue(50)
    queue.remove('a', 'Un', commit)
    vi.advanceTimersByTime(50)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  describe('while the pointer or the focus is on the notice', () => {
    it('waits, and goes on with what it had left when the notice is let go', () => {
      const commit = vi.fn()
      const queue = createUndoQueue()
      queue.remove('a', 'Un', commit)
      vi.advanceTimersByTime(5000)
      queue.hold(true)
      vi.advanceTimersByTime(ACTION_NOTICE_MS * 10)
      expect(commit).not.toHaveBeenCalled()
      expect(queue.pending()).toEqual(['a'])
      queue.hold(false)
      vi.advanceTimersByTime(ACTION_NOTICE_MS - 5000 - 1)
      expect(commit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(commit).toHaveBeenCalledTimes(1)
    })

    it('still takes the deletion back after a long wait', () => {
      const commit = vi.fn()
      const queue = createUndoQueue()
      queue.remove('a', 'Un', commit)
      queue.hold(true)
      vi.advanceTimersByTime(ACTION_NOTICE_MS * 5)
      expect(queue.undo()).toBe(true)
      queue.hold(false)
      vi.advanceTimersByTime(ACTION_NOTICE_MS * 5)
      expect(commit).not.toHaveBeenCalled()
    })

    it('holds a deletion made while the notice is held, each with the time it had left', () => {
      const [first, second] = [vi.fn(), vi.fn()]
      const queue = createUndoQueue()
      queue.remove('a', 'Un', first)
      vi.advanceTimersByTime(3000)
      queue.hold(true)
      queue.remove('b', 'Deux', second)
      vi.advanceTimersByTime(ACTION_NOTICE_MS * 3)
      expect([first, second].map((commit) => commit.mock.calls.length)).toEqual([0, 0])
      queue.hold(false)
      vi.advanceTimersByTime(ACTION_NOTICE_MS - 3000)
      expect([first, second].map((commit) => commit.mock.calls.length)).toEqual([1, 0])
      vi.advanceTimersByTime(3000)
      expect([first, second].map((commit) => commit.mock.calls.length)).toEqual([1, 1])
    })

    it('is not held for the next notice once nothing waits: its element left without telling', () => {
      const commit = vi.fn()
      const queue = createUndoQueue()
      queue.remove('a', 'Un', () => undefined)
      queue.hold(true)
      queue.undo()
      queue.remove('b', 'Deux', commit)
      vi.advanceTimersByTime(ACTION_NOTICE_MS)
      expect(commit).toHaveBeenCalledTimes(1)
    })

    it('holds nothing when nothing waits, so that a hold before the first removal does not stop it', () => {
      const commit = vi.fn()
      const queue = createUndoQueue()
      queue.hold(true)
      queue.remove('a', 'Un', commit)
      vi.advanceTimersByTime(ACTION_NOTICE_MS)
      expect(commit).toHaveBeenCalledTimes(1)
    })

    it('makes the deletions of a held queue when the panel is left', () => {
      const commit = vi.fn()
      const queue = createUndoQueue()
      queue.remove('a', 'Un', commit)
      queue.hold(true)
      queue.flush()
      expect(commit).toHaveBeenCalledTimes(1)
    })
  })
})
