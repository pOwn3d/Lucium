import { describe, expect, it } from 'vitest'
import type { PageWatch } from '@shared/model'
import { fingerprint } from '@shared/page-watch'
import { PAGE_WATCH_GAP_MS, PageWatcher, type WatchHost } from './page-watch'

const MIN = 60_000
/** Where the clock starts: ten hours in, so that a watch last looked at "long ago" is due. */
const START = 36_000_000
const watch = (id: string, over: Partial<PageWatch> = {}): PageWatch => ({ id, url: `https://example.org/${id}`, title: `Page ${id}`, profileId: 'default', minutes: 60, ...over })

/** A host with a clock, timers run by hand, and pages that answer what the test says. */
function fakeHost(initial: PageWatch[], over: { enabled?: boolean; paused?: boolean } = {}) {
  let now = START
  let enabled = over.enabled ?? true
  let paused = over.paused ?? false
  let watches = initial
  const timers = new Map<number, { run: () => void; ms: number }>()
  let nextTimer = 1
  const saved: PageWatch[][] = []
  const notices: Array<{ title: string; body: string }> = []
  const reads: Array<{ profileId: string; url: string; selector?: string }> = []
  const logs: string[] = []
  const answers = new Map<string, { ok: true; text: string } | { ok: false; error: string }>()
  const host: WatchHost = {
    state: () => ({ enabled, watches }),
    paused: () => paused,
    save: (next) => {
      saved.push(next)
      watches = next
    },
    profileLive: (id) => id !== 'gone',
    read: async (profileId, url, options) => {
      reads.push({ profileId, url, ...(options.selector ? { selector: options.selector } : {}) })
      return answers.get(url) ?? { ok: true, text: 'texte' }
    },
    notify: (notice) => {
      notices.push(notice)
      return true
    },
    now: () => now,
    setTimer: (run, ms) => {
      const id = nextTimer++
      timers.set(id, { run, ms })
      return id
    },
    clearTimer: (timer) => timers.delete(timer as number),
    log: (level, message) => logs.push(`${level}: ${message}`)
  }
  return {
    host,
    saved,
    notices,
    reads,
    logs,
    answers,
    timers,
    advance: (ms: number) => (now += ms),
    now: () => now,
    set: (next: { enabled?: boolean; paused?: boolean; watches?: PageWatch[] }) => {
      if (next.enabled !== undefined) enabled = next.enabled
      if (next.paused !== undefined) paused = next.paused
      if (next.watches !== undefined) watches = next.watches
    },
    watches: () => watches
  }
}

describe('the schedule', () => {
  it('has no timer while the tool is off, nothing is watched, or looking is paused (zero cost)', () => {
    for (const setup of [{ enabled: false, list: [watch('a')] }, { enabled: true, list: [] as PageWatch[] }]) {
      const f = fakeHost(setup.list, { enabled: setup.enabled })
      const watcher = new PageWatcher(f.host)
      watcher.refresh()
      expect(watcher.armed()).toBe(false)
      expect(f.timers.size).toBe(0)
    }
    const paused = fakeHost([watch('a')], { paused: true })
    const watcher = new PageWatcher(paused.host)
    watcher.refresh()
    expect(watcher.armed()).toBe(false)
  })

  it('arms one timer for the moment the next look is due, and no sooner', () => {
    const f = fakeHost([watch('a', { checkedAt: START - 10 * MIN, minutes: 30 }), watch('b', { checkedAt: START - 1 * MIN, minutes: 5 })])
    const watcher = new PageWatcher(f.host)
    watcher.refresh()
    expect(f.timers.size).toBe(1)
    // a is due in 20 minutes, b in 4: the timer is for b.
    expect([...f.timers.values()][0]!.ms).toBe(4 * MIN)
  })

  it('arms the timer again, not a second one, when the watches change; and does nothing when they did not', () => {
    const f = fakeHost([watch('a', { checkedAt: START, minutes: 30 })])
    const watcher = new PageWatcher(f.host)
    watcher.refresh()
    const first = [...f.timers.keys()]
    watcher.refresh()
    expect([...f.timers.keys()]).toEqual(first)
    f.set({ watches: [watch('a', { checkedAt: START, minutes: 10 })] })
    watcher.refresh()
    expect(f.timers.size).toBe(1)
    expect([...f.timers.values()][0]!.ms).toBe(10 * MIN)
  })

  it('drops its timer when the tool is switched off or the last watch is removed', () => {
    const f = fakeHost([watch('a', { checkedAt: START, minutes: 30 })])
    const watcher = new PageWatcher(f.host)
    watcher.refresh()
    f.set({ enabled: false })
    watcher.refresh()
    expect(f.timers.size).toBe(0)
    f.set({ enabled: true })
    watcher.refresh()
    expect(f.timers.size).toBe(1)
    f.set({ watches: [] })
    watcher.refresh()
    expect(f.timers.size).toBe(0)
  })

  it('waits at least a second, even for a look that was due long ago', () => {
    const f = fakeHost([watch('a')])
    const watcher = new PageWatcher(f.host)
    watcher.refresh()
    expect([...f.timers.values()][0]!.ms).toBe(1000)
  })

  it('stops for good', () => {
    const f = fakeHost([watch('a')])
    const watcher = new PageWatcher(f.host)
    watcher.refresh()
    watcher.stop()
    expect(f.timers.size).toBe(0)
    f.set({ watches: [watch('b')] })
    watcher.refresh()
    expect(f.timers.size).toBe(0)
  })
})

describe('a look', () => {
  it('records the first look without calling it a change', async () => {
    const f = fakeHost([watch('a')])
    const watcher = new PageWatcher(f.host)
    expect(await watcher.look()).toBe(true)
    expect(f.notices).toEqual([])
    expect(f.watches()[0]).toMatchObject({ hash: fingerprint('texte'), checkedAt: f.now() })
    expect(f.watches()[0]!.changedAt).toBeUndefined()
  })

  it('reads the page with the session of its profile, and the zone it watches', async () => {
    const f = fakeHost([watch('a', { profileId: 'work', selector: '#price' })])
    await new PageWatcher(f.host).look()
    expect(f.reads).toEqual([{ profileId: 'work', url: 'https://example.org/a', selector: '#price' }])
  })

  it('tells the system when the text is no longer the one seen last, with the name of the page', async () => {
    const f = fakeHost([watch('a', { hash: fingerprint('avant'), checkedAt: 1 })])
    f.answers.set('https://example.org/a', { ok: true, text: 'après' })
    await new PageWatcher(f.host).look()
    expect(f.notices).toEqual([{ title: 'Page modifiée', body: 'Page a' }])
    expect(f.watches()[0]).toMatchObject({ hash: fingerprint('après'), changedAt: f.now() })
  })

  it('says nothing when the text did not change', async () => {
    const f = fakeHost([watch('a', { hash: fingerprint('texte'), checkedAt: 1 })])
    await new PageWatcher(f.host).look()
    expect(f.notices).toEqual([])
    expect(f.watches()[0]!.changedAt).toBeUndefined()
  })

  it('looks at one page at a time: a second request while a page loads does nothing', async () => {
    const f = fakeHost([watch('a'), watch('b')])
    const watcher = new PageWatcher(f.host)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const read = f.host.read
    f.host.read = async (...args) => {
      await gate
      return read(...args)
    }
    const first = watcher.look()
    expect(await watcher.look()).toBe(false)
    expect(f.reads).toEqual([])
    release!()
    expect(await first).toBe(true)
    expect(f.reads).toHaveLength(1)
  })

  it('looks at nothing when nothing is due, the tool is off, or looking is paused', async () => {
    const quiet = fakeHost([watch('a', { checkedAt: START, minutes: 60 })])
    expect(await new PageWatcher(quiet.host).look()).toBe(false)
    const off = fakeHost([watch('a')], { enabled: false })
    expect(await new PageWatcher(off.host).look()).toBe(false)
    const paused = fakeHost([watch('a')], { paused: true })
    expect(await new PageWatcher(paused.host).look()).toBe(false)
    expect(quiet.reads.length + off.reads.length + paused.reads.length).toBe(0)
  })

  it('marks a page that cannot be read, logs why, keeps what was seen, and tries again a whole interval later', async () => {
    const f = fakeHost([watch('a', { hash: fingerprint('avant'), checkedAt: 1 })])
    f.answers.set('https://example.org/a', { ok: false, error: 'La page n’a pas répondu à temps.' })
    const watcher = new PageWatcher(f.host)
    await watcher.look()
    expect(f.notices).toEqual([])
    expect(f.watches()[0]).toMatchObject({ hash: fingerprint('avant'), failure: 'La page n’a pas répondu à temps.', checkedAt: f.now() })
    expect(f.logs.some((line) => line.startsWith('warn:') && line.includes('https://example.org/a') && line.includes('pas répondu'))).toBe(true)
    // The next look is an interval away, not at once.
    expect(await watcher.look()).toBe(false)
  })

  it('marks a page whose profile is gone, without loading anything', async () => {
    const f = fakeHost([watch('a', { profileId: 'gone' })])
    await new PageWatcher(f.host).look()
    expect(f.reads).toEqual([])
    expect(f.watches()[0]!.failure).toBe('Le profil de cette page n’existe plus.')
  })

  it('forgets a failure once a look goes well', async () => {
    const f = fakeHost([watch('a', { failure: 'La page a planté.', hash: fingerprint('texte'), checkedAt: 1 })])
    await new PageWatcher(f.host).look()
    expect(f.watches()[0]!.failure).toBeUndefined()
    expect('failure' in f.watches()[0]!).toBe(false)
  })

  it('leaves the other watches alone, and drops the result of a watch removed while its page loaded', async () => {
    const f = fakeHost([watch('a'), watch('b', { checkedAt: START, minutes: 60 })])
    const read = f.host.read
    f.host.read = async (...args) => {
      f.set({ watches: [watch('b', { checkedAt: START, minutes: 60 })] })
      return read(...args)
    }
    await new PageWatcher(f.host).look()
    expect(f.saved).toEqual([])
    expect(f.watches().map((w) => w.id)).toEqual(['b'])
  })

  it('waits between two looks, so that many due watches do not load many pages at once', async () => {
    const f = fakeHost([watch('a'), watch('b')])
    const watcher = new PageWatcher(f.host)
    await watcher.look()
    expect(watcher.armed()).toBe(true)
    expect([...f.timers.values()].at(-1)!.ms).toBeGreaterThanOrEqual(PAGE_WATCH_GAP_MS - 1000)
  })

  it('logs and goes on when the look itself throws', async () => {
    const f = fakeHost([watch('a')])
    f.host.read = () => Promise.reject(new Error('boom'))
    const watcher = new PageWatcher(f.host)
    watcher.refresh()
    const [timer] = [...f.timers.values()]
    timer!.run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.logs.some((line) => line.startsWith('error:') && line.includes('boom'))).toBe(true)
    // The look is not left "running" for ever.
    f.set({ watches: [watch('a')] })
    f.host.read = async () => ({ ok: true, text: 'x' })
    expect(await watcher.look()).toBe(true)
  })

  it('logs when the system did not show the notice', async () => {
    const f = fakeHost([watch('a', { hash: fingerprint('avant'), checkedAt: 1 })])
    f.host.notify = () => false
    f.answers.set('https://example.org/a', { ok: true, text: 'après' })
    await new PageWatcher(f.host).look()
    expect(f.logs.some((line) => line.includes('the system did not show the notice'))).toBe(true)
    // The change is recorded all the same: it is not announced a second time.
    expect(f.watches()[0]!.hash).toBe(fingerprint('après'))
  })
})
