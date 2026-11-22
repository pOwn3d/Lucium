import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings, type SidebarState } from '@shared/model'
import { dayOf, type ForgottenSite } from '@shared/unused-permissions'
import { setLanguage } from '@shared/i18n'
import { FeatureGates, runningGates, type GateStore } from './feature-gate'
import { FORGOTTEN_SITES_NAMED, UNUSED_PERMISSIONS_PERIOD_MS, forgottenNotice, gateUnusedPermissions } from './unused-permissions'

const DAY = 86_400_000
const A = 'https://a.example'

function harness(days: number) {
  let state = { settings: { ...defaultSettings(), forgetUnusedPermissionsDays: days }, sitePermissions: { [A]: { camera: 'allow' } }, siteVisits: { [A]: 10 } } as unknown as SidebarState
  const listeners = new Set<(s: SidebarState) => void>()
  const store: GateStore = { get: () => state, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }
  const clock = { now: 40 * DAY, timers: new Map<number, { run: () => void; ms: number }>(), next: 0 }
  const swept: number[] = []
  const told: ForgottenSite[][] = []
  const gates = new FeatureGates(store)
  gateUnusedPermissions(gates, {
    store,
    now: () => clock.now,
    setTimer: (run, ms) => {
      const id = ++clock.next
      clock.timers.set(id, { run: () => (clock.timers.delete(id), run()), ms })
      return id
    },
    clearTimer: (id) => void clock.timers.delete(id as number),
    dispatch: (action) => void swept.push(action.day),
    notify: (forgotten) => void told.push(forgotten)
  })
  return {
    clock,
    swept,
    told,
    timers: () => [...clock.timers.values()],
    setting(forgetUnusedPermissionsDays: number) {
      state = { ...state, settings: { ...state.settings, forgetUnusedPermissionsDays } } as SidebarState
      for (const l of [...listeners]) l(state)
    },
    dispose: () => gates.disposeAll()
  }
}

let active: ReturnType<typeof harness> | undefined
afterEach(() => active?.dispose())

describe('the daily pass of the unused permissions', () => {
  it('costs nothing while the setting is 0: no pass, no timer', () => {
    active = harness(0)
    expect(active.swept).toEqual([])
    expect(active.timers()).toEqual([])
    expect(runningGates()).not.toContain('forget-unused-permissions')
  })

  it('sweeps at once with today’s day, says what it takes, and sweeps again a day later', () => {
    active = harness(30)
    expect(active.swept).toEqual([dayOf(40 * DAY)])
    expect(active.told).toEqual([[{ origin: A, permissions: ['camera'] }]])
    expect(active.timers().map((t) => t.ms)).toEqual([UNUSED_PERMISSIONS_PERIOD_MS])
    active.clock.now += DAY
    active.timers()[0]!.run()
    expect(active.swept).toEqual([40, 41])
    // The timer is armed again for the next day, never stacked.
    expect(active.timers()).toHaveLength(1)
  })

  it('says nothing when nothing is forgotten', () => {
    active = harness(90)
    expect(active.swept).toEqual([40])
    expect(active.told).toEqual([])
  })

  it('stops with the setting and starts again when it comes back', () => {
    active = harness(30)
    active.setting(0)
    expect(active.timers()).toEqual([])
    active.setting(30)
    expect(runningGates()).toContain('forget-unused-permissions')
    expect(active.timers()).toHaveLength(1)
  })
})

describe('the notice', () => {
  const site = (n: number): ForgottenSite => ({ origin: `https://s${n}.example`, permissions: ['camera'] })
  afterEach(() => setLanguage('fr'))

  it('names the sites without their scheme and says the delay', () => {
    setLanguage('en')
    expect(forgottenNotice([site(1), site(2)], 90)).toBe('Lucium forgot the permissions of s1.example, s2.example, not visited for 90 days.')
  })

  it('names the first few and counts the others, in the singular and the plural, in both languages', () => {
    setLanguage('en')
    const some = Array.from({ length: FORGOTTEN_SITES_NAMED + 1 }, (_, i) => site(i))
    expect(forgottenNotice(some, 30)).toContain('and 1 other site,')
    expect(forgottenNotice([...some, site(9)], 30)).toContain('and 2 other sites')
    setLanguage('fr')
    expect(forgottenNotice(some, 30)).toContain('et 1 autre site,')
    expect(forgottenNotice([...some, site(9)], 30)).toContain('et de 2 autres sites')
    expect(forgottenNotice(some, 30)).not.toContain(`s${FORGOTTEN_SITES_NAMED}.example,`)
  })
})
