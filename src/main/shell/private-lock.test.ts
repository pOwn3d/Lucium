import { describe, expect, it } from 'vitest'
import { LOOK_MS, PrivateWindowLock, type PrivateLockHost } from './private-lock'

const MIN = 60_000

/** A host with a clock and timers of its own: what the service does is read from what it armed and what it told. */
function setup(over: Partial<{ minutes: number; lockActive: boolean; focused: boolean; lastInputAt: number }> = {}) {
  const world = { now: 0, minutes: 5, lockActive: true, focused: true, lastInputAt: 0, changed: 0, logs: [] as string[], timers: [] as Array<{ run: () => void; at: number; live: boolean }>, ...over }
  const host: PrivateLockHost = {
    minutes: () => world.minutes,
    lockActive: () => world.lockActive,
    focused: () => world.focused,
    lastInputAt: () => world.lastInputAt,
    now: () => world.now,
    setTimer: (run, ms) => {
      const timer = { run, at: world.now + ms, live: true }
      world.timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void ((timer as { live: boolean }).live = false),
    changed: () => void (world.changed += 1),
    log: (line) => void world.logs.push(line)
  }
  const lock = new PrivateWindowLock(host)
  /** Moves the clock to `ms` and runs the timers that came due, as the real ones would. */
  const advance = (ms: number): void => {
    const target = world.now + ms
    for (;;) {
      const due = world.timers.filter((timer) => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.live = false
      world.now = due.at
      due.run()
    }
    world.now = target
  }
  const armed = (): number => world.timers.filter((timer) => timer.live).length
  return { lock, world, advance, armed }
}

describe('the lock of a private window', () => {
  it('locks a window left alone for the delay, tells the window, and says so in the log', () => {
    const { lock, world, advance } = setup()
    lock.follow()
    advance(5 * MIN - LOOK_MS)
    expect(lock.isLocked()).toBe(false)
    advance(2 * LOOK_MS)
    expect(lock.isLocked()).toBe(true)
    expect(world.changed).toBe(1)
    expect(world.logs).toHaveLength(1)
  })

  it('does not lock a window the person is using: a click or a key while it has the focus moves the delay up', () => {
    const { lock, world, advance } = setup()
    lock.follow()
    for (let minute = 1; minute <= 20; minute += 1) {
      advance(MIN)
      world.lastInputAt = world.now
    }
    expect(lock.isLocked()).toBe(false)
  })

  it('locks a window that is in the background even when the person works elsewhere in the application', () => {
    const { lock, world, advance } = setup({ focused: false })
    lock.follow()
    for (let minute = 1; minute <= 6; minute += 1) {
      advance(MIN)
      world.lastInputAt = world.now
    }
    expect(lock.isLocked()).toBe(true)
  })

  it('counts coming back to the window as a visit', () => {
    const { lock, world, advance } = setup({ focused: false })
    lock.follow()
    advance(4 * MIN)
    lock.focused()
    advance(4 * MIN)
    expect(lock.isLocked()).toBe(false)
    expect(world.changed).toBe(0)
  })

  it('arms nothing while the delay is « never » or the lock of the application is off, and lets go of the timer when either becomes so', () => {
    const never = setup({ minutes: 0 })
    never.lock.follow()
    expect(never.armed()).toBe(0)
    const noLock = setup({ lockActive: false })
    noLock.lock.follow()
    expect(noLock.armed()).toBe(0)
    const { lock, world, armed } = setup()
    lock.follow()
    expect(armed()).toBe(1)
    world.minutes = 0
    lock.follow()
    expect(armed()).toBe(0)
  })

  it('stays locked until it is unlocked, then starts over from that moment and arms its timer again', () => {
    const { lock, world, advance, armed } = setup()
    lock.follow()
    advance(6 * MIN)
    expect(lock.isLocked()).toBe(true)
    expect(armed()).toBe(0)
    advance(60 * MIN)
    expect(lock.isLocked()).toBe(true)
    const changed = world.changed
    lock.unlock()
    expect(lock.isLocked()).toBe(false)
    expect(world.changed).toBe(changed + 1)
    expect(armed()).toBe(1)
    advance(4 * MIN)
    expect(lock.isLocked()).toBe(false)
    advance(2 * MIN)
    expect(lock.isLocked()).toBe(true)
  })

  it('opens a locked window when the lock of the application is removed: nothing is left to ask the phrase of', () => {
    const { lock, world, advance } = setup()
    lock.follow()
    advance(6 * MIN)
    expect(lock.isLocked()).toBe(true)
    world.lockActive = false
    const changed = world.changed
    lock.follow()
    expect(lock.isLocked()).toBe(false)
    expect(world.changed).toBe(changed + 1)
  })

  it('locks at once on demand, only when a phrase exists to open the window with', () => {
    const open = setup()
    open.lock.lockNow()
    expect(open.lock.isLocked()).toBe(true)
    const noPhrase = setup({ lockActive: false })
    noPhrase.lock.lockNow()
    expect(noPhrase.lock.isLocked()).toBe(false)
  })

  it('lets go of its timer when the window is closed', () => {
    const { lock, armed } = setup()
    lock.follow()
    lock.dispose()
    expect(armed()).toBe(0)
  })
})
