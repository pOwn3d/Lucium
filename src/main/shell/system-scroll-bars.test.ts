// The scroll bars setting of the system (shell/system-scroll-bars.ts): read at launch, followed through macOS's notification, read again when the
// application becomes active, and said as it is when it cannot be read.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCROLL_BARS_NOTIFICATION, SystemScrollBars, scrollBarsOfSnapshot, systemScrollBars, systemScrollBarsSource, type ScrollBarsSource } from './system-scroll-bars'

/** A source whose value and notification the test drives. */
function aSource(first: unknown) {
  let value = first
  let refresh: (() => void) | null = null
  const stop = vi.fn()
  const source: ScrollBarsSource = {
    read: () => {
      if (value instanceof Error) throw value
      return value
    },
    watch: (callback) => {
      refresh = callback
      return stop
    }
  }
  return { source, stop, set: (next: unknown) => void (value = next), notify: () => refresh?.() }
}

afterEach(() => {
  systemScrollBars().stop()
  vi.restoreAllMocks()
})

describe('the setting of the system', () => {
  it('is read at the start: always only for « Always », and not before it is started', () => {
    const bars = new SystemScrollBars()
    expect(bars.isAlways()).toBe(false)
    bars.start(aSource('Always').source)
    expect(bars.isAlways()).toBe(true)
    const other = new SystemScrollBars()
    other.start(aSource('Automatic').source)
    expect(other.isAlways()).toBe(false)
  })

  // Guard: the windows are told when the answer changes, and only then. Without the comparison every notification of macOS would publish every window.
  it('tells its listeners when the answer changes through the notification, and only then', () => {
    const { source, set, notify } = aSource('Automatic')
    const bars = new SystemScrollBars()
    const heard = vi.fn()
    bars.onChange(heard)
    bars.start(source)
    expect(heard).not.toHaveBeenCalled()
    set('Always')
    notify()
    expect(bars.isAlways()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    notify()
    expect(heard).toHaveBeenCalledTimes(1)
    set('WhenScrolling')
    notify()
    expect(bars.isAlways()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  // Guard: the application reads the setting again when it becomes active, in case the notification did not come (`refresh`, called by main/index.ts).
  it('is read again on demand, so that a change the notification missed is found when the application becomes active', () => {
    const { source, set } = aSource('Automatic')
    const bars = new SystemScrollBars()
    const heard = vi.fn()
    bars.onChange(heard)
    bars.start(source)
    set('Always')
    bars.refresh()
    expect(bars.isAlways()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  // Guard: a setting that cannot be read is said with its cause, and the bars stay as they were (a consequence the person can see in the console, not a silent false).
  it('says why when it cannot be read, and keeps the answer it had', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { source, set, notify } = aSource('Always')
    const bars = new SystemScrollBars()
    const heard = vi.fn()
    bars.onChange(heard)
    bars.start(source)
    heard.mockClear()
    const failure = new Error('no defaults')
    set(failure)
    notify()
    expect(bars.isAlways()).toBe(true)
    expect(heard).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[scroll bars] the system setting could not be read; the bars stay as they were:', failure)
  })

  it('stops listening to the system when it stops, and a source started again replaces the one before', () => {
    const first = aSource('Always')
    const bars = new SystemScrollBars()
    bars.start(first.source)
    const second = aSource('Automatic')
    bars.start(second.source)
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(bars.isAlways()).toBe(false)
    bars.stop()
    expect(second.stop).toHaveBeenCalledTimes(1)
    expect(bars.isAlways()).toBe(false)
    // A late notification of a source that was stopped changes nothing.
    first.set('Always')
    first.notify()
    expect(bars.isAlways()).toBe(false)
  })

  // Guard: a source started in place of another tells the windows when its answer differs; the answer of the first is not forgotten without a word.
  it('tells its listeners when a source started in place of another answers otherwise, and only then', () => {
    const bars = new SystemScrollBars()
    const heard = vi.fn()
    bars.onChange(heard)
    bars.start(aSource('Always').source)
    expect(heard).toHaveBeenCalledTimes(1)
    bars.start(aSource('Automatic').source)
    expect(bars.isAlways()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
    bars.start(aSource('WhenScrolling').source)
    expect(heard).toHaveBeenCalledTimes(2)
    bars.start(aSource('Always').source)
    expect(heard).toHaveBeenCalledTimes(3)
  })

  it('stops telling a listener that left', () => {
    const { source, set, notify } = aSource('Automatic')
    const bars = new SystemScrollBars()
    const heard = vi.fn()
    const leave = bars.onChange(heard)
    bars.start(source)
    leave()
    set('Always')
    notify()
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('the source of the real system', () => {
  it('reads AppleShowScrollBars as a string, listens to the notification macOS posts, and takes the listener off when it stops', () => {
    let callback: (() => void) | null = null
    const preferences = {
      getUserDefault: vi.fn(() => 'Always'),
      subscribeNotification: vi.fn((_event: string, listener: () => void) => {
        callback = listener
        return 42
      }),
      unsubscribeNotification: vi.fn()
    }
    const bars = new SystemScrollBars()
    bars.start(systemScrollBarsSource(preferences))
    expect(preferences.getUserDefault).toHaveBeenCalledWith('AppleShowScrollBars', 'string')
    expect(SCROLL_BARS_NOTIFICATION).toBe('AppleShowScrollBarsSettingChanged')
    expect(preferences.subscribeNotification).toHaveBeenCalledWith('AppleShowScrollBarsSettingChanged', expect.any(Function))
    expect(bars.isAlways()).toBe(true)
    preferences.getUserDefault.mockReturnValue('Automatic')
    callback!()
    expect(bars.isAlways()).toBe(false)
    bars.stop()
    expect(preferences.unsubscribeNotification).toHaveBeenCalledWith(42)
  })
})

describe('what the snapshot says', () => {
  it('is that the bars are always shown while they are, and nothing otherwise', () => {
    expect(scrollBarsOfSnapshot()).toEqual({})
    const { source, set, notify } = aSource('Always')
    systemScrollBars().start(source)
    expect(scrollBarsOfSnapshot()).toEqual({ scrollBarsAlways: true })
    set('Automatic')
    notify()
    expect(scrollBarsOfSnapshot()).toEqual({})
  })
})
