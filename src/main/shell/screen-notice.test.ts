import { describe, expect, it } from 'vitest'
import { screenOf, withNoticed, withPanelSize, type PanelSizes, type ScreenInfo, type ScreenKind } from '@shared/panel-scale'
import { SETTLE_DELAY_MS, SHOWN_DELAY_MS, ScreenWatch } from './screen-notice'

// The notice about the size of the panels, offered once per very wide or very small screen: the rule is in shared/panel-scale.ts (screenNotice), the look at the
// screen is here, with stand-ins for the window and the clock.

const screenAt = (width: number, height: number, label = '', internal = false): ScreenInfo => screenOf({ label, internal, scaleFactor: 1, size: { width, height } })!
const ULTRAWIDE = screenAt(3440, 1440, 'LG UltraWide')
const LAPTOP = screenAt(1512, 982, '', true)
const SMALL = screenAt(1280, 800, '', true)

function watch(first: ScreenInfo | null) {
  let screen = first
  let sizes: PanelSizes = {}
  let busy = false
  const shown: Array<[ScreenKind, string]> = []
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = []
  const watcher = new ScreenWatch({
    screen: () => screen,
    sizes: () => sizes,
    busy: () => busy,
    // What the window does: remembers that the notice was shown, then shows it.
    show: (kind, info) => {
      sizes = withNoticed(sizes, info, 1)
      shown.push([kind, info.key])
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, live: true }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => void ((timer as { live: boolean }).live = false)
  })
  return {
    watcher,
    shown,
    timers,
    use: (next: ScreenInfo | null) => void (screen = next),
    busy: (next: boolean) => void (busy = next),
    choose: (next: PanelSizes) => void (sizes = next),
    rest: () => {
      for (const timer of timers.splice(0)) if (timer.live) timer.run()
    }
  }
}

describe('the notice about the size of the panels', () => {
  it('is shown the first time a very wide screen is used: « trop petits »', () => {
    const t = watch(ULTRAWIDE)
    expect(t.watcher.look()).toBe('wide')
    expect(t.shown).toEqual([['wide', ULTRAWIDE.key]])
  })

  it('is « trop grands » for a very small screen', () => {
    const t = watch(SMALL)
    expect(t.watcher.look()).toBe('small')
    expect(t.shown).toEqual([['small', SMALL.key]])
  })

  it('is shown once per screen: the second look at the same screen says nothing, whatever the window does next', () => {
    const t = watch(ULTRAWIDE)
    t.watcher.look()
    expect(t.watcher.look()).toBeNull()
    t.watcher.soon(0)
    t.rest()
    expect(t.shown).toHaveLength(1)
  })

  it('is shown for each screen in its turn: the window moved to another very wide or very small screen, then back', () => {
    const t = watch(ULTRAWIDE)
    t.watcher.look()
    t.use(SMALL)
    t.watcher.look()
    t.use(ULTRAWIDE)
    t.watcher.look()
    expect(t.shown.map(([kind]) => kind)).toEqual(['wide', 'small'])
  })

  it('is not shown for an ordinary screen', () => {
    const t = watch(LAPTOP)
    expect(t.watcher.look()).toBeNull()
    expect(t.shown).toEqual([])
  })

  it('is not shown for a screen its owner has already chosen a size for', () => {
    const t = watch(ULTRAWIDE)
    t.choose(withPanelSize({}, ULTRAWIDE, 140, 1))
    expect(t.watcher.look()).toBeNull()
  })

  it('waits while the window is busy (a panel open, the application locked, the window hidden) and is not lost: it comes at the next look', () => {
    const t = watch(ULTRAWIDE)
    t.busy(true)
    expect(t.watcher.look()).toBeNull()
    expect(t.shown).toEqual([])
    t.busy(false)
    expect(t.watcher.look()).toBe('wide')
  })

  it('says nothing when the window’s screen cannot be told', () => {
    const t = watch(null)
    expect(t.watcher.look()).toBeNull()
  })

  it('looks after a delay, and a second call before it starts the wait again: a window being dragged is looked at where the drag ends', () => {
    const t = watch(ULTRAWIDE)
    t.watcher.soon(SHOWN_DELAY_MS)
    t.watcher.soon()
    t.watcher.soon()
    expect(t.timers.filter((timer) => timer.live)).toHaveLength(1)
    expect(t.timers.find((timer) => timer.live)!.ms).toBe(SETTLE_DELAY_MS)
    expect(t.shown).toEqual([])
    t.rest()
    expect(t.shown).toHaveLength(1)
  })

  it('looks a moment after the window is shown, longer than after a move (the first sheets have had their turn)', () => {
    expect(SHOWN_DELAY_MS).toBeGreaterThan(SETTLE_DELAY_MS)
  })

  it('has no look left waiting once it is stopped (the window was closed)', () => {
    const t = watch(ULTRAWIDE)
    t.watcher.soon()
    t.watcher.stop()
    t.rest()
    expect(t.shown).toEqual([])
    // Stopping twice, or with nothing waiting, is harmless.
    expect(() => t.watcher.stop()).not.toThrow()
  })
})
