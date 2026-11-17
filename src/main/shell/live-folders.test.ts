import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SidebarState } from '@shared/model'
import { LIVE_GAP_MS, LIVE_INTERVAL_MS, LIVE_RETRY_MS, type LiveSource } from '@shared/live-folders'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { FeatureGates } from './feature-gate'
import type { LookResult } from './live-fetch'
import { LiveFolderService, type LiveHost } from './live-folders'

const FEED = (n: number): LiveSource => ({ kind: 'feed', url: `https://a.example/${n}` })
let ids = 0
const ctx = () => ({ now: Date.now(), newId: () => `id${++ids}` })

/** A store over the real reducer, as the service and its gate see one. */
function liveStore(settings: Partial<Settings> = { liveFolders: true }) {
  let state: SidebarState = createInitialState(ctx())
  state = { ...state, settings: { ...state.settings, ...settings } }
  const listeners = new Set<(state: SidebarState) => void>()
  const notify = () => [...listeners].forEach((l) => l(state))
  return {
    get: () => state,
    subscribe: (listener: (state: SidebarState) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    listeners: () => listeners.size,
    dispatch(action: Action) {
      state = reduce(state, action, ctx())
      notify()
    },
    set(patch: Partial<Settings>) {
      this.dispatch({ type: 'settings/update', patch })
    }
  }
}
type Store = ReturnType<typeof liveStore>

interface Fake {
  host: LiveHost
  looked: LiveSource[]
  logs: Array<[string, string]>
  answer: (source: LiveSource) => LookResult | Promise<LookResult>
  paused: boolean
  signals: AbortSignal[]
}

function fakeHost(store: Store, over: Partial<LiveHost> = {}): Fake {
  const fake: Fake = {
    looked: [],
    logs: [],
    paused: false,
    signals: [],
    answer: () => ({ ok: true, items: [{ title: 'Un', url: 'https://a.example/item' }], title: '' }),
    host: undefined as unknown as LiveHost
  }
  fake.host = {
    state: () => ({ enabled: store.get().settings.liveFolders, folders: store.get().folders }),
    paused: () => fake.paused,
    look: async (source, signal) => {
      fake.looked.push(source)
      fake.signals.push(signal)
      return fake.answer(source)
    },
    dispatch: (action) => store.dispatch(action),
    now: () => Date.now(),
    startDelayMs: () => 0,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    log: (level, message) => fake.logs.push([level, message]),
    ...over
  }
  return fake
}

/** Makes a live folder in the store, and returns its id. */
function addLive(store: Store, source: LiveSource): string {
  store.dispatch({ type: 'livefolder/create', source })
  return store.get().folders.at(-1)!.id
}
const liveOf = (store: Store, id: string) => store.get().folders.find((f) => f.id === id)!.live!

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 24, 10, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the schedule of the live folders', () => {
  it('owns no timer and sends nothing while the function is off, even for a live folder the state holds', async () => {
    const store = liveStore({ liveFolders: true })
    addLive(store, FEED(1))
    store.set({ liveFolders: false })
    const fake = fakeHost(store)
    const service = new LiveFolderService(fake.host)
    service.start()
    expect(service.armed()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(fake.looked).toEqual([])
    expect(await service.look()).toBe(false)
  })

  it('owns no timer and sends nothing while no folder is live (the function on, ordinary folders, nothing at all)', async () => {
    const store = liveStore()
    store.dispatch({ type: 'folder/create', name: 'Ordinaire' })
    const fake = fakeHost(store)
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    store.dispatch({ type: 'folder/create', name: 'Autre' })
    expect(service.armed()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(fake.looked).toEqual([])
  })

  it('looks at a new folder at once and arms the single timer for it, then again an interval later', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    const id = addLive(store, FEED(1))
    expect(service.armed()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(fake.looked).toEqual([FEED(1)])
    expect(liveOf(store, id)).toMatchObject({ items: [{ title: 'Un', url: 'https://a.example/item' }], checkedAt: Date.now() - (1500 - 1000) })
    expect(liveOf(store, id).failure).toBeUndefined()
    // Next: one timer, due an interval after the look.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS - 2000)
    expect(fake.looked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.looked).toHaveLength(2)
  })

  it('never has more than one timer, and spaces two looks by the gap even when both folders are due', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    const times: number[] = []
    fake.answer = () => {
      times.push(Date.now())
      return { ok: true, items: [], title: '' }
    }
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    for (let i = 1; i <= 4; i++) addLive(store, FEED(i))
    let most = 0
    for (let step = 0; step < 100; step++) {
      await vi.advanceTimersByTimeAsync(1000)
      most = Math.max(most, vi.getTimerCount())
    }
    expect(most).toBeLessThanOrEqual(1)
    expect(times).toHaveLength(4)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(LIVE_GAP_MS)
  })

  it('waits for the launch delay before the first look', async () => {
    const store = liveStore()
    addLive(store, FEED(1))
    const fake = fakeHost(store, { startDelayMs: () => 30_000 })
    const service = new LiveFolderService(fake.host)
    service.start()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(fake.looked).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(fake.looked).toEqual([FEED(1)])
  })

  it('looks again after a failure only after the longer delay, keeps the last items and says why', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    const id = addLive(store, FEED(1))
    await vi.advanceTimersByTimeAsync(1500)
    fake.answer = () => ({ ok: false, error: 'Le serveur a répondu HTTP 500.' })
    store.dispatch({ type: 'livefolder/refresh', id })
    await vi.advanceTimersByTimeAsync(LIVE_GAP_MS + 1500)
    expect(liveOf(store, id)).toMatchObject({ failure: 'Le serveur a répondu HTTP 500.', items: [{ title: 'Un', url: 'https://a.example/item' }] })
    expect(fake.logs.some(([level, text]) => level === 'warn' && text.includes('https://a.example/1') && text.includes('HTTP 500'))).toBe(true)
    const looks = fake.looked.length
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS + 60_000)
    expect(fake.looked).toHaveLength(looks)
    fake.answer = () => ({ ok: true, items: [{ title: 'Neuf', url: 'https://a.example/new' }], title: '' })
    // The failure was recorded when the look ended; the retry falls due LIVE_RETRY_MS after it.
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MS - LIVE_INTERVAL_MS - 60_000 + 5000)
    expect(fake.looked).toHaveLength(looks + 1)
    expect(liveOf(store, id).failure).toBeUndefined()
    expect(liveOf(store, id).items.map((i) => i.title)).toEqual(['Neuf'])
  })

  it('records a look that throws as a failure of that folder, logs it, and goes on', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    fake.answer = () => {
      throw new Error('boom')
    }
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    const id = addLive(store, FEED(1))
    await vi.advanceTimersByTimeAsync(1500)
    expect(liveOf(store, id).failure).toBe('Lecture impossible.')
    expect(fake.logs.some(([level, text]) => level === 'error' && text.includes('boom'))).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not record the answer of a source that was changed, or a folder deleted, while the look was under way', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    let release: (r: LookResult) => void = () => {}
    fake.answer = () => new Promise<LookResult>((resolve) => (release = resolve))
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    const id = addLive(store, FEED(1))
    await vi.advanceTimersByTimeAsync(1500)
    store.dispatch({ type: 'livefolder/edit', id, source: FEED(2) })
    release({ ok: true, items: [{ title: 'Vieux', url: 'https://a.example/vieux' }], title: '' })
    await vi.advanceTimersByTimeAsync(10)
    expect(liveOf(store, id)).toEqual({ source: FEED(2), items: [] })
    store.dispatch({ type: 'folder/delete', id })
    await vi.advanceTimersByTimeAsync(LIVE_GAP_MS * 3)
    expect(store.get().folders).toEqual([])
    expect(service.armed()).toBe(false)
  })

  it('stop() cancels the look under way, drops its answer and leaves no timer', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    let release: (r: LookResult) => void = () => {}
    fake.answer = () => new Promise<LookResult>((resolve) => (release = resolve))
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    const id = addLive(store, FEED(1))
    await vi.advanceTimersByTimeAsync(1500)
    service.stop()
    expect(fake.signals[0]!.aborted).toBe(true)
    release({ ok: true, items: [{ title: 'Tard', url: 'https://a.example/tard' }], title: '' })
    await vi.advanceTimersByTimeAsync(10)
    expect(liveOf(store, id).items).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(service.armed()).toBe(false)
  })

  it('looks at nothing while the battery saver asks to pause, and goes on when it does not', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    fake.paused = true
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    addLive(store, FEED(1))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.looked).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    fake.paused = false
    service.schedule()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fake.looked).toHaveLength(1)
  })

  it('a refresh asked for makes the folder due again, at the pace of the gap', async () => {
    const store = liveStore()
    const fake = fakeHost(store)
    const service = new LiveFolderService(fake.host)
    service.start()
    store.subscribe(() => service.refresh())
    const id = addLive(store, FEED(1))
    await vi.advanceTimersByTimeAsync(1500)
    expect(fake.looked).toHaveLength(1)
    store.dispatch({ type: 'livefolder/refresh', id })
    await vi.advanceTimersByTimeAsync(LIVE_GAP_MS - 2000)
    expect(fake.looked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(fake.looked).toHaveLength(2)
  })
})

describe('the live folders, through their gate', () => {
  function gated(store: Store, fake: Fake) {
    const gates = new FeatureGates(store)
    let service: LiveFolderService | null = null
    gates.gate('live-folders', {
      start: () => {
        const made = new LiveFolderService(fake.host)
        service = made
        const unsubscribe = store.subscribe(() => made.refresh())
        made.start()
        return () => {
          unsubscribe()
          made.stop()
          service = null
        }
      }
    })
    return { gates, service: () => service }
  }

  it('owns nothing while the setting is off (only the gate listens), starts with the setting and stops with it', async () => {
    const store = liveStore({ liveFolders: false })
    const fake = fakeHost(store)
    const g = gated(store, fake)
    expect(g.service()).toBeNull()
    expect(store.listeners()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    store.set({ liveFolders: true })
    expect(g.service()).not.toBeNull()
    expect(store.listeners()).toBe(2)
    addLive(store, FEED(1))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(fake.looked).toHaveLength(1)
    store.set({ liveFolders: false })
    expect(g.service()).toBeNull()
    expect(store.listeners()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(fake.looked).toHaveLength(1)
    g.gates.disposeAll()
  })

  it('arms no timer when the function is on with no live folder', () => {
    const store = liveStore({ liveFolders: true })
    const g = gated(store, fakeHost(store))
    expect(g.service()).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    g.gates.disposeAll()
  })

  // That only the main window makes the gate (never a private or a second window) is run in browser-start.test.ts.
})
