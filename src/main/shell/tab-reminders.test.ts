import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings, type SidebarState, type TabReminder } from '@shared/model'
import { FeatureGates, runningGates, type GateStore } from './feature-gate'
import { REMINDER_MAX_WAIT_MS, gateTabReminders } from './tab-reminders'

const reminder = (n: number, dueAt: number): TabReminder => ({ id: `r${n}`, url: `https://s${n}.example/`, title: `Page ${n}`, spaceId: '', dueAt, createdAt: 0 })

function harness(initial: TabReminder[], settings: Partial<SidebarState['settings']> = {}) {
  let state = { settings: { ...defaultSettings(), ...settings }, tabReminders: initial } as unknown as SidebarState
  const listeners = new Set<(s: SidebarState) => void>()
  const store: GateStore = { get: () => state, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }
  const clock = { now: 1_000, timers: new Map<number, { run: () => void; ms: number }>(), next: 0 }
  const notified: string[] = []
  let fired = 0
  const gates = new FeatureGates(store)
  gateTabReminders(gates, {
    store,
    now: () => clock.now,
    setTimer: (run, ms) => {
      const id = ++clock.next
      // A timer is gone once it has fired, as a real one is.
      clock.timers.set(id, { run: () => (clock.timers.delete(id), run()), ms })
      return id
    },
    clearTimer: (id) => void clock.timers.delete(id as number),
    notify: (r) => void notified.push(r.title),
    // The reducer's part: what it brings back is removed from the list, which the store announces.
    fire: () => {
      fired++
      state = { ...state, tabReminders: state.tabReminders.filter((r) => r.dueAt > clock.now) } as SidebarState
      for (const l of [...listeners]) l(state)
    }
  })
  return {
    clock,
    notified,
    fired: () => fired,
    timers: () => [...clock.timers.values()],
    setList(tabReminders: TabReminder[]) {
      state = { ...state, tabReminders } as SidebarState
      for (const l of [...listeners]) l(state)
    },
    setting(patch: Partial<SidebarState['settings']>) {
      state = { ...state, settings: { ...state.settings, ...patch } } as SidebarState
      for (const l of [...listeners]) l(state)
    },
    dispose: () => gates.disposeAll()
  }
}

let active: ReturnType<typeof harness> | undefined
afterEach(() => active?.dispose())

describe('the timer of the tab reminders', () => {
  it('arms nothing while no reminder waits', () => {
    active = harness([])
    expect(active.timers()).toEqual([])
  })

  it('arms one timer for the earliest reminder, and notifies then brings the tab back when it fires', () => {
    active = harness([reminder(2, 3_000), reminder(1, 2_000)])
    expect(active.timers().map((t) => t.ms)).toEqual([1_000])
    active.clock.now = 2_000
    ;[...active.clock.timers.values()][0]!.run()
    expect(active.notified).toEqual(['Page 1'])
    expect(active.fired()).toBe(1)
    // The list changed: the timer now waits for the next one.
    expect(active.timers().map((t) => t.ms)).toEqual([1_000])
  })

  it('re-arms when a reminder is added, and never stacks timers', () => {
    active = harness([reminder(1, 100_000)])
    active.setList([reminder(2, 5_000), reminder(1, 100_000)])
    expect(active.timers().map((t) => t.ms)).toEqual([4_000])
  })

  it('never sleeps longer than the bound, and looks again without firing early', () => {
    active = harness([reminder(1, 1_000 + 3 * REMINDER_MAX_WAIT_MS)])
    expect(active.timers().map((t) => t.ms)).toEqual([REMINDER_MAX_WAIT_MS])
    active.clock.now += REMINDER_MAX_WAIT_MS
    ;[...active.clock.timers.values()][0]!.run()
    expect(active.fired()).toBe(0)
    expect(active.notified).toEqual([])
    expect(active.timers().map((t) => t.ms)).toEqual([REMINDER_MAX_WAIT_MS])
  })

  it('costs nothing with the setting off, and starts again when it comes back', () => {
    active = harness([reminder(1, 5_000)], { tabReminders: false })
        expect(active.timers()).toEqual([])
    active.setting({ tabReminders: true })
    expect(runningGates()).toContain('tab-reminders')
    expect(active.timers()).toHaveLength(1)
    active.setting({ tabReminders: false })
    expect(active.timers()).toEqual([])
  })
})
