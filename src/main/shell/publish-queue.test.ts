import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { PUBLISH_SOON_MS, PublishQueue } from './publish-queue'
import { browserSource } from './browser-source.test-support'
import { fakeBrowser, methodsOf, overlayHost } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs: its methods run here on a stand-in (browser-fake.test-support.ts).
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** A queue whose "end of the turn" is run by hand, so that a test decides where a turn ends. */
function turns() {
  const tasks: Array<() => void> = []
  const send = vi.fn()
  const queue = new PublishQueue(send, (task) => tasks.push(task))
  return { queue, send, endTurn: () => tasks.splice(0).forEach((task) => task()), waiting: () => tasks.length }
}

describe('PublishQueue', () => {
  it('sends once at the end of the turn however many publications were asked for', () => {
    const { queue, send, endTurn, waiting } = turns()
    queue.request()
    queue.request()
    queue.request()
    expect(send).not.toHaveBeenCalled()
    expect(waiting()).toBe(1)
    endTurn()
    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.stats).toEqual({ sent: 1, requested: 3 })
  })

  it('counts a page update as it ran before (the store publishes, then the page handler does) and as it runs now', () => {
    // Before: each of the two publications of a title change sent the whole state. Now the two ask, one sends.
    const { queue, send, endTurn } = turns()
    const pageUpdates = 100
    for (let i = 0; i < pageUpdates; i++) {
      queue.request() // the store's subscriber (sync)
      queue.request() // the end of the page handler
      endTurn()
    }
    expect(queue.stats.requested).toBe(2 * pageUpdates)
    expect(send).toHaveBeenCalledTimes(pageUpdates)
  })

  it('asks again for what is requested after the send', () => {
    const { queue, send, endTurn } = turns()
    queue.request()
    endTurn()
    queue.request()
    endTurn()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends at once, and only once, when a message must follow the state (flush), and does nothing when nothing waits', () => {
    const { queue, send, endTurn } = turns()
    queue.flush()
    expect(send).not.toHaveBeenCalled()
    queue.request()
    queue.flush()
    expect(send).toHaveBeenCalledTimes(1)
    endTurn()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the order of the messages: what was published before a message reaches the interface first', () => {
    const order: string[] = []
    const tasks: Array<() => void> = []
    const queue = new PublishQueue(() => order.push('state'), (task) => tasks.push(task))
    queue.request()
    queue.flush()
    order.push('message')
    queue.request()
    tasks.splice(0).forEach((task) => task())
    expect(order).toEqual(['state', 'message', 'state'])
  })

  it('sends now whether or not something waited, and the publication that waited is part of it', () => {
    const { queue, send, endTurn } = turns()
    queue.now()
    expect(send).toHaveBeenCalledTimes(1)
    queue.request()
    queue.now()
    expect(send).toHaveBeenCalledTimes(2)
    endTurn()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends nothing for a window that went away', () => {
    const { queue, send, endTurn } = turns()
    queue.request()
    queue.cancel()
    endTurn()
    expect(send).not.toHaveBeenCalled()
    queue.request()
    endTurn()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('tells when a send fails and goes on with the next one', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const tasks: Array<() => void> = []
    let fail = true
    const send = vi.fn(() => {
      if (fail) throw new Error('the window is gone')
    })
    const queue = new PublishQueue(send, (task) => tasks.push(task))
    queue.request()
    expect(() => tasks.splice(0).forEach((task) => task())).not.toThrow()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[publish]'), expect.objectContaining({ message: 'the window is gone' }))
    fail = false
    queue.request()
    tasks.splice(0).forEach((task) => task())
    expect(send).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('runs at the end of the turn with the real microtask queue', async () => {
    const send = vi.fn()
    const queue = new PublishQueue(send)
    queue.request()
    queue.request()
    expect(send).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('PublishQueue: what a page in the background changed waits a moment', () => {
  it('sends once, PUBLISH_SOON_MS after the first ask, however many came meanwhile', () => {
    vi.useFakeTimers()
    try {
      const { queue, send } = turns()
      queue.soon()
      vi.advanceTimersByTime(PUBLISH_SOON_MS / 2)
      queue.soon()
      queue.soon()
      expect(send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(PUBLISH_SOON_MS / 2)
      expect(send).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(PUBLISH_SOON_MS * 5)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is carried by a publication that comes before (the user acts, the page on screen changes): nothing is sent twice', () => {
    vi.useFakeTimers()
    try {
      const { queue, send, endTurn } = turns()
      queue.soon()
      queue.request()
      endTurn()
      expect(send).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(PUBLISH_SOON_MS * 2)
      expect(send).toHaveBeenCalledTimes(1)
      // A publication already due at the end of the turn takes the later ask with it.
      queue.request()
      queue.soon()
      endTurn()
      vi.advanceTimersByTime(PUBLISH_SOON_MS * 2)
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes out at once when a message must follow the state (flush), and not at all when the window goes (cancel)', () => {
    vi.useFakeTimers()
    try {
      const { queue, send } = turns()
      queue.soon()
      queue.flush()
      expect(send).toHaveBeenCalledTimes(1)
      queue.soon()
      queue.cancel()
      vi.advanceTimersByTime(PUBLISH_SOON_MS * 2)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the browser publishes through the queue', () => {
  it('asks the queue of every window of the group, never the interface itself', () => {
    const request = vi.fn()
    const other = vi.fn()
    const fake = fakeBrowser({ group: new Set([{ publishQueue: { request } }, { publishQueue: { request: other } }]), leader: { backgroundEvents: 0 } })
    shell['publish']!.call(fake.self)
    expect(request).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
    expect(fake.calls).toEqual([])
  })

  it('asks every window for a publication a moment later while an event of a page in the background is handled', () => {
    const request = vi.fn()
    const soon = vi.fn()
    const fake = fakeBrowser({ group: new Set([{ publishQueue: { request, soon } }, { publishQueue: { request, soon } }]), leader: { backgroundEvents: 1 } })
    shell['publish']!.call(fake.self)
    expect([request.mock.calls.length, soon.mock.calls.length]).toEqual([0, 2])
  })

  it('handles the events of a page off screen as background events, and those of the page on screen as they come', () => {
    const leader = { backgroundEvents: 0 }
    const seen: number[] = []
    const fake = fakeBrowser({ leader, visible: new Set(['shown']), handlePageUpdate: () => void seen.push(leader.backgroundEvents) })
    shell['onPageUpdate']!.call(fake.self, 'hidden', { title: 'x' })
    shell['onPageUpdate']!.call(fake.self, 'shown', { title: 'x' })
    expect(seen).toEqual([1, 0])
    expect(leader.backgroundEvents).toBe(0)
    // A handler that throws does not leave every later publication waiting.
    const throwing = fakeBrowser({ leader, visible: new Set(), handlePageUpdate: () => { throw new Error('boom') } })
    expect(() => shell['onPageUpdate']!.call(throwing.self, 'hidden', {})).toThrow('boom')
    expect(leader.backgroundEvents).toBe(0)
  })

  it('sends the state that was waiting before the panel that opens over it', () => {
    const fake = overlayHost()
    shell['openOverlay']!.call(fake.self, { panel: 'shortcuts' })
    const names = fake.names()
    expect(names.indexOf('publishQueue.flush')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('publishQueue.flush')).toBeLessThan(names.indexOf('overlay.webContents.send'))
  })

  it('sends the state that was waiting before the step of the panel of ⌃Tab', () => {
    const fake = fakeBrowser({ cycle: { cards: ['a', 'b'], index: 0, hold: 'Control' } })
    expect(shell['stepCycle']!.call(fake.self, 1)).toBe(true)
    expect(fake.calls.map((call) => [call.name, ...call.args])).toEqual([['publishQueue.flush'], ['overlay.webContents.isDestroyed'], ['overlay.webContents.send', Channel.cycleIndex, 1]])
  })

  it('drops what waited when the browser stops', () => {
    const maps = ['scopeGuards', 'pages', 'privatePages', 'pageContainer', 'permissionAnswers', 'permissionPages', 'authAnswers', 'reviewAnswers', 'dialogAnswers', 'leaveAnswers', 'passphraseAnswers']
    const fake = fakeBrowser({
      ...Object.fromEntries(maps.map((name) => [name, new Map()])),
      ...Object.fromEntries(['passwordView', 'floatTimer', 'splitDrag', 'tabDragExpiry'].map((name) => [name, null])),
      group: new Set(),
      dialogQueue: []
    })
    shell['stop']!.call(fake.self)
    expect(fake.names()[0]).toBe('publishQueue.cancel')
  })

  // Contract: that nothing reaches the interface around the queue is the absence of a caller, which no run of the code can show.
  it('has no way to the interface that skips the queue', () => {
    // The definition of `publishHere` and the queue's own send are the two places it appears (its abstract declaration in browser-base.ts aside).
    expect(browserSource().match(/(?<!abstract )publishHere\(\)/g)).toHaveLength(2)
  })
})
