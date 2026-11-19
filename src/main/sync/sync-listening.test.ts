// The Mac's listening (docs/synchronisation.md §6.1): a door that is opened and closed on the service's decision, with no deadline of its own.
import { describe, expect, it } from 'vitest'
import { SyncListening, type Door, type ListeningCloseReason, type ListeningState } from './sync-listening'

function setup(over: Partial<Door> = {}): { listening: SyncListening; door: { starts: number; stops: number }; changes: Array<[ListeningState, ListeningCloseReason | undefined]> } {
  const door = { starts: 0, stops: 0 }
  const changes: Array<[ListeningState, ListeningCloseReason | undefined]> = []
  const listening = new SyncListening({
    door: {
      start: async () => void door.starts++,
      stop: async () => void door.stops++,
      ...over
    },
    onChange: (state, reason) => void changes.push([state, reason])
  })
  return { listening, door, changes }
}

describe('SyncListening', () => {
  it('is closed until it is told to open: nothing listens', () => {
    const { listening, door } = setup()
    expect(listening.state()).toEqual({ open: false })
    expect(door.starts).toBe(0)
  })

  it('opens the door once, and stays open with no deadline (no timer closes it)', async () => {
    const { listening, door, changes } = setup()
    await listening.open()
    await listening.open()
    expect(door.starts).toBe(1)
    expect(listening.state()).toEqual({ open: true })
    expect(changes).toEqual([[{ open: true }, undefined]])
    // Long after the ten minutes of the old window: still open, nothing stopped it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(door.stops).toBe(0)
  })

  it.each(['switch-off', 'locked', 'no-device', 'quit'] as const)('closes at once for %s, and says why', async (reason) => {
    const { listening, door, changes } = setup()
    await listening.open()
    await listening.close(reason)
    expect(listening.state().open).toBe(false)
    expect(door.stops).toBe(1)
    expect(changes.at(-1)).toEqual([{ open: false }, reason])
  })

  it('closing a closed door does nothing', async () => {
    const { listening, door } = setup()
    await listening.close('no-device')
    expect(door.stops).toBe(0)
  })

  it('stays closed, and rejects, when the door cannot open', async () => {
    const { listening } = setup({ start: () => Promise.reject(new Error('the port is taken')) })
    await expect(listening.open()).rejects.toThrow('the port is taken')
    expect(listening.state().open).toBe(false)
    await expect(listening.open()).rejects.toThrow('the port is taken')
  })

  it('opens the door once for two calls at once', async () => {
    const { listening, door } = setup()
    await Promise.all([listening.open(), listening.open()])
    expect(door.starts).toBe(1)
    expect(listening.state().open).toBe(true)
  })

  it('does not come up after a close that arrived while the door was opening', async () => {
    let release: () => void = () => undefined
    let started = 0
    const { listening, door } = setup({
      start: () => {
        started++
        return new Promise<void>((resolve) => void (release = resolve))
      }
    })
    const opening = listening.open()
    const closing = listening.close('switch-off')
    release()
    await opening
    await closing
    expect(listening.state().open).toBe(false)
    // The door that came up is stopped: no port stays open behind a listening that was cut.
    expect(started).toBe(1)
    expect(door.stops).toBe(1)
  })

  it('answers a close while the door fails to open without throwing: the opener has the error', async () => {
    let fail: (error: Error) => void = () => undefined
    const { listening } = setup({ start: () => new Promise<void>((_, reject) => void (fail = reject)) })
    const opening = listening.open()
    const closing = listening.close('locked')
    fail(new Error('refused'))
    await expect(opening).rejects.toThrow('refused')
    await expect(closing).resolves.toBeUndefined()
  })

  it('can be opened again after it closed (an unlock, a device paired again)', async () => {
    const { listening, door } = setup()
    await listening.open()
    await listening.close('locked')
    await listening.open()
    expect(door.starts).toBe(2)
    expect(listening.state().open).toBe(true)
  })
})
