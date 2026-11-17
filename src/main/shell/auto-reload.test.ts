import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabItem } from '@shared/model'
import { AutoReloader, type AutoReloadHost, type AutoReloadTarget, type Clock } from './auto-reload'

/** Time that only moves when the test says so; a timer fires when the clock passes it, and the sweeps it starts are let to finish. */
class FakeClock implements Clock {
  time = 1_000_000
  readonly timers = new Map<number, { at: number; run: () => void }>()
  private counter = 0
  now(): number {
    return this.time
  }
  setTimeout(run: () => void, ms: number): NodeJS.Timeout {
    const id = ++this.counter
    this.timers.set(id, { at: this.time + ms, run })
    return id as unknown as NodeJS.Timeout
  }
  clearTimeout(timer: NodeJS.Timeout): void {
    this.timers.delete(timer as unknown as number)
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (let fired = 0; ; fired++) {
      // A countdown that never moves forward would fire again at once, for ever: that is a failure, not a test that never ends.
      if (fired > 500) throw new Error('the timer fires in a loop')
      const next = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.timers.delete(next[0])
      this.time = Math.max(this.time, next[1].at)
      next[1].run()
      await settle()
    }
    this.time = end
  }
}

const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve()
}

interface FakeTab {
  id: string
  url: string
  seconds?: number
  /** The live page; null = asleep. */
  page: object | null
  loading: boolean
  frozen: boolean
  /** What the page answers to "is a field being typed in?": a value, an error, or a promise the test settles. */
  editing: boolean | Error | Promise<boolean>
  reloads: number
  /** How many times the page was asked. */
  questions: number
  reloadFails?: Error
}

const tabOf = (id: string, over: Partial<FakeTab> = {}): FakeTab => ({ id, url: `https://${id}.example/`, seconds: 30, page: {}, loading: false, frozen: false, editing: false, reloads: 0, questions: 0, ...over })

function setup(tabs: FakeTab[]) {
  const clock = new FakeClock()
  const host: AutoReloadHost = {
    targets: () =>
      tabs
        .filter((t) => t.seconds !== undefined && t.page && !t.frozen)
        .map(
          (t): AutoReloadTarget => ({
            tab: { id: t.id, spaceId: 's', url: t.url, title: t.id, pinned: false, createdAt: 0, lastActiveAt: 0, autoReload: { seconds: t.seconds! } } satisfies TabItem,
            page: t.page!,
            loading: t.loading,
            reload: () => {
              if (t.reloadFails) throw t.reloadFails
              t.reloads++
            },
            isEditing: async () => {
              t.questions++
              if (t.editing instanceof Error) throw t.editing
              return t.editing
            }
          })
        )
  }
  const reloader = new AutoReloader(host, clock)
  return { clock, reloader, tabs }
}

afterEach(() => vi.restoreAllMocks())

describe('AutoReloader', () => {
  it('reloads a tab once its interval has passed, not before, and goes on at that interval', async () => {
    const a = tabOf('a', { seconds: 30 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(29_999)
    expect(a.reloads).toBe(0)
    await clock.advance(1)
    expect(a.reloads).toBe(1)
    await clock.advance(30_000)
    expect(a.reloads).toBe(2)
  })

  it('serves every tab with one single timer, armed for the soonest', async () => {
    const a = tabOf('a', { seconds: 30 })
    const b = tabOf('b', { seconds: 5 })
    const c = tabOf('c', { seconds: 600 })
    const { clock, reloader } = setup([a, b, c])
    reloader.refresh()
    expect(clock.timers.size).toBe(1)
    expect([...clock.timers.values()][0]!.at - clock.time).toBe(5000)
    await clock.advance(5000)
    expect(clock.timers.size).toBe(1)
    expect([a.reloads, b.reloads, c.reloads]).toEqual([0, 1, 0])
    await clock.advance(25_000)
    expect([a.reloads, b.reloads, c.reloads]).toEqual([1, 6, 0])
    expect(clock.timers.size).toBe(1)
  })

  it('arms nothing when no tab has the setting, and nothing runs again after stop()', async () => {
    const a = tabOf('a', { seconds: undefined })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    expect(clock.timers.size).toBe(0)
    a.seconds = 5
    reloader.refresh()
    expect(clock.timers.size).toBe(1)
    reloader.stop()
    expect(clock.timers.size).toBe(0)
    await clock.advance(60_000)
    reloader.refresh()
    reloader.loaded('a')
    expect(a.reloads).toBe(0)
    expect(clock.timers.size).toBe(0)
    expect(reloader.countdownOf('a')).toBeUndefined()
  })

  it('keeps one single timer however often it is refreshed or told that a page loaded', () => {
    const a = tabOf('a', { seconds: 30 })
    const b = tabOf('b', { seconds: 10 })
    const { clock, reloader } = setup([a, b])
    for (let i = 0; i < 5; i++) {
      reloader.refresh()
      reloader.loaded('a')
      reloader.loaded('b')
    }
    expect(clock.timers.size).toBe(1)
    expect(reloader.armed()).toBe(true)
  })

  it('drops the countdown of a tab whose page went away at the next refresh', () => {
    const a = tabOf('a', { seconds: 30 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    expect(reloader.countdownOf('a')).toBeDefined()
    a.page = null
    reloader.refresh()
    expect(reloader.countdownOf('a')).toBeUndefined()
    expect(clock.timers.size).toBe(0)
  })

  it('lets go of a tab whose page went away without being told, and does not spin on its ended countdown', async () => {
    const a = tabOf('a', { seconds: 5 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    a.page = null
    await clock.advance(60_000)
    expect(a.reloads).toBe(0)
    expect(reloader.countdownOf('a')).toBeUndefined()
    expect(clock.timers.size).toBe(0)
  })

  it('stops at once when the setting is turned off', async () => {
    const a = tabOf('a', { seconds: 5 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(5000)
    expect(a.reloads).toBe(1)
    a.seconds = undefined
    reloader.refresh()
    await clock.advance(60_000)
    expect(a.reloads).toBe(1)
    expect(reloader.countdownOf('a')).toBeUndefined()
  })

  it('starts the countdown again when the page finishes loading, from that moment', async () => {
    const a = tabOf('a', { seconds: 30 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(20_000)
    reloader.loaded('a')
    await clock.advance(29_999)
    expect(a.reloads).toBe(0)
    await clock.advance(1)
    expect(a.reloads).toBe(1)
  })

  it('starts over when the interval changes, and keeps its countdown when it does not', async () => {
    const a = tabOf('a', { seconds: 30 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(10_000)
    reloader.refresh()
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(20_000)
    a.seconds = 60
    reloader.refresh()
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(60_000)
  })

  it('does not reload a tab whose page is asleep or frozen, and does not wake it', async () => {
    const asleep = tabOf('asleep', { seconds: 5, page: null })
    const frozen = tabOf('frozen', { seconds: 5, frozen: true })
    const { clock, reloader } = setup([asleep, frozen])
    reloader.refresh()
    expect(clock.timers.size).toBe(0)
    await clock.advance(60_000)
    expect(asleep.reloads + frozen.reloads).toBe(0)
  })

  it('gives a tab that wakes a whole interval from the moment it is live again', async () => {
    const a = tabOf('a', { seconds: 30, page: null })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(100_000)
    a.page = {}
    reloader.refresh()
    await clock.advance(29_999)
    expect(a.reloads).toBe(0)
    await clock.advance(1)
    expect(a.reloads).toBe(1)
  })

  it('forgets a tab whose page went away, so that it is not reloaded at once when it wakes', async () => {
    const a = tabOf('a', { seconds: 30 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(25_000)
    reloader.forget('a')
    a.page = null
    await clock.advance(10_000)
    a.page = {}
    reloader.refresh()
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(30_000)
    await clock.advance(5_000)
    expect(a.reloads).toBe(0)
  })

  it('waits while the page is still loading, looks again a few seconds later, and reloads when it is done', async () => {
    const a = tabOf('a', { seconds: 10, loading: true })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(10_000)
    expect(a.reloads).toBe(0)
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(5000)
    await clock.advance(5000)
    expect(a.reloads).toBe(0)
    a.loading = false
    await clock.advance(5000)
    expect(a.reloads).toBe(1)
  })

  it('never has two reloads of a tab in flight: sweeps that overlap share one run', async () => {
    let release: (value: boolean) => void = () => {}
    const slow = new Promise<boolean>((resolve) => (release = resolve))
    const a = tabOf('a', { seconds: 5, editing: slow })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    clock.time += 5000
    const first = reloader.sweep()
    const second = reloader.sweep()
    expect(second).toBe(first)
    release(false)
    expect(await first).toEqual(['a'])
    expect(a.reloads).toBe(1)
  })

  it('does not reload while a field is being typed in, and looks again 5 seconds later', async () => {
    const a = tabOf('a', { seconds: 10, editing: true })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(10_000)
    expect(a.reloads).toBe(0)
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(5000)
    await clock.advance(15_000)
    expect(a.reloads).toBe(0)
    a.editing = false
    await clock.advance(5000)
    expect(a.reloads).toBe(1)
    // The next one is a whole interval later again.
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(10_000)
  })

  it('asks the page only for a tab whose countdown has ended', async () => {
    const a = tabOf('a', { seconds: 30 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(29_000)
    expect(a.questions).toBe(0)
    await clock.advance(1000)
    expect(a.questions).toBe(1)
    expect(a.reloads).toBe(1)
  })

  it('reloads a page that cannot answer (and says so) rather than leaving it, since a reload is what a hung page needs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = tabOf('a', { seconds: 5, editing: new Error('Script failed to execute') })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(5000)
    expect(a.reloads).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page a could not be asked'), 'Script failed to execute')
  })

  it('does not let a page that never answers hold the others: after 3 seconds it is reloaded (and the failure said), and the other tabs go on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung = tabOf('hung', { seconds: 5, editing: new Promise<boolean>(() => {}) })
    const fine = tabOf('fine', { seconds: 5 })
    const { clock, reloader } = setup([hung, fine])
    reloader.refresh()
    await clock.advance(5000)
    expect(hung.reloads).toBe(0)
    await clock.advance(3000)
    expect(hung.reloads).toBe(1)
    expect(fine.reloads).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page hung could not be asked'), 'no answer within 3000 ms')
    // The hung page costs the next sweep its 3 seconds again, once; the other tab is reloaded after them, not never.
    await clock.advance(8000)
    expect(fine.reloads).toBe(2)
    expect(hung.reloads).toBe(2)
  })

  it('does not wait for the timeout once a page has answered', async () => {
    const a = tabOf('a', { seconds: 5, editing: false })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(5000)
    expect(a.reloads).toBe(1)
    expect(clock.timers.size).toBe(1)
    expect([...clock.timers.values()][0]!.at - clock.time).toBe(5000)
  })

  it('drops the reload when the page was replaced while it was being asked (the tab slept and woke)', async () => {
    let answer: (value: boolean) => void = () => {}
    const a = tabOf('a', { seconds: 5, editing: new Promise<boolean>((resolve) => (answer = resolve)) })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    clock.time += 5000
    const sweep = reloader.sweep()
    a.page = {}
    answer(false)
    expect(await sweep).toEqual([])
    expect(a.reloads).toBe(0)
  })

  it('drops the reload when the interval was changed while the page was being asked', async () => {
    let answer: (value: boolean) => void = () => {}
    const a = tabOf('a', { seconds: 5, editing: new Promise<boolean>((resolve) => (answer = resolve)) })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    clock.time += 5000
    const sweep = reloader.sweep()
    a.seconds = 60
    reloader.refresh()
    answer(false)
    expect(await sweep).toEqual([])
    expect(a.reloads).toBe(0)
    expect(reloader.countdownOf('a')!.seconds).toBe(60)
  })

  it('leaves a page that cannot be reloaded alone, and looks at it again a whole interval later', async () => {
    const a = tabOf('a', { seconds: 10, url: 'about:blank' })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(10_000)
    expect(a.reloads).toBe(0)
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(10_000)
    a.url = 'https://a.example/'
    await clock.advance(10_000)
    expect(a.reloads).toBe(1)
  })

  it('a page that refuses the reload is logged and tried again a whole interval later, not in a loop', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = tabOf('a', { seconds: 10, reloadFails: new Error('Object has been destroyed') })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    await clock.advance(10_000)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot reload page a'), expect.any(Error))
    expect(reloader.countdownOf('a')!.at - clock.time).toBe(10_000)
    await clock.advance(9_999)
    expect(error).toHaveBeenCalledTimes(1)
    a.reloadFails = undefined
    await clock.advance(1)
    expect(a.reloads).toBe(1)
  })

  it('never reloads faster than the interval, whatever the loads that follow: an error page that loads over and over only pushes the countdown back', async () => {
    const a = tabOf('a', { seconds: 10 })
    const { clock, reloader } = setup([a])
    reloader.refresh()
    for (let i = 0; i < 6; i++) {
      await clock.advance(4_000)
      reloader.loaded('a')
    }
    expect(a.reloads).toBe(0)
    await clock.advance(10_000)
    expect(a.reloads).toBe(1)
  })

  it('leaves a countdown that has not ended alone, even while its page is loading or a field is in focus: it is not pushed back to a few seconds', async () => {
    const due = tabOf('due', { seconds: 5, editing: true })
    const loading = tabOf('loading', { seconds: 60, loading: true })
    const typing = tabOf('typing', { seconds: 60, editing: true })
    const { clock, reloader } = setup([due, loading, typing])
    reloader.refresh()
    await clock.advance(5000)
    expect(reloader.countdownOf('due')!.at - clock.time).toBe(5000)
    expect(reloader.countdownOf('loading')!.at - clock.time).toBe(55_000)
    expect(reloader.countdownOf('typing')!.at - clock.time).toBe(55_000)
    expect(typing.questions).toBe(0)
  })

  it('leaves the countdowns of the other tabs alone when one is blocked', async () => {
    const typing = tabOf('typing', { seconds: 10, editing: true })
    const fine = tabOf('fine', { seconds: 20 })
    const { clock, reloader } = setup([typing, fine])
    reloader.refresh()
    await clock.advance(10_000)
    expect([typing.reloads, fine.reloads]).toEqual([0, 0])
    expect(reloader.countdownOf('fine')!.at - clock.time).toBe(10_000)
    await clock.advance(10_000)
    expect([typing.reloads, fine.reloads]).toEqual([0, 1])
  })
})
