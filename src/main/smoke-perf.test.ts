import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { pagePath, PAGE_TITLE_PREFIX, parseMarkerLine, scenarioById } from '@shared/perf-core'
import { perfFeaturePatch } from '@shared/perf-features'
import type { SidebarState } from '@shared/model'
import { FeatureGates } from './shell/feature-gate'
import { GATES_OF_FEATURES_ON, prepareScenario, runPerfDriver } from './smoke-perf'
import type { SmokeContext } from './smoke'

// The side of `pnpm perf` that runs inside the application, against a browser and a store that are stand-ins: what it asks for (settings, tabs),
// what it waits for (the title of each page), what it refuses to go on without. The real application is checked by runPerfSmoke (engine test).

interface FakeTab {
  id: string
  url: string
  title: string
  loading: boolean
}

/**
 * A browser that opens a tab on `tab/open`: it is not loading yet (a new tab is not), starts loading, gets its title after `loadMs` and stops
 * loading 150 ms later (a title comes before the end of the load; the wait polls every 100 ms). `stuck` urls never get further than loading.
 * `events` is the order and the time of what happened.
 */
function fakeContext(options: { loadMs?: number; stuck?: (url: string) => boolean; live?: (ids: string[]) => string[]; createsNothing?: boolean; noRuntime?: boolean } = {}) {
  const state = { tabs: [] as FakeTab[], settings: defaultSettings() }
  const dispatched: Array<{ type: string; [key: string]: unknown }> = []
  const events: Array<{ what: string; at: number }> = []
  const note = (what: string) => events.push({ what, at: Date.now() })
  const browser = {
    dispatch(action: { type: string; [key: string]: unknown }) {
      dispatched.push(action)
      if (action.type === 'settings/update') {
        Object.assign(state.settings, action['patch'])
        note('settings')
      }
      if (action.type === 'tab/open' && !options.createsNothing) {
        const url = String(action['url'])
        const tab: FakeTab = { id: `t${state.tabs.length + 1}`, url, title: url, loading: false }
        state.tabs = [...state.tabs, tab]
        note(`open ${tab.id}`)
        const loadMs = options.loadMs ?? 20
        setTimeout(() => {
          tab.loading = true
          note(`loading ${tab.id}`)
        }, Math.floor(loadMs / 2))
        if (!options.stuck?.(url)) {
          setTimeout(() => {
            tab.title = `${PAGE_TITLE_PREFIX}${url.split('/').at(-1)}`
            note(`title ${tab.id}`)
          }, loadMs)
          setTimeout(() => {
            tab.loading = false
            note(`done ${tab.id}`)
          }, loadMs + 150)
        }
      }
    },
    snapshot: () => ({ runtime: { tabs: options.noRuntime ? {} : Object.fromEntries(state.tabs.map((tab) => [tab.id, { loading: tab.loading }])) } }),
    livePageIds: () => (options.live ?? ((ids) => ids))(state.tabs.map((tab) => tab.id))
  }
  const store = { get: () => state }
  return { ctx: { browser, store } as unknown as SmokeContext, state, dispatched, events }
}

const BASE = 'http://127.0.0.1:4321'
const scenario = (id: string) => scenarioById(id)!

// These tests wait on real timers, as the driver does: the half second the gates are given, and a look at each tab every 200 ms (two seconds for the ten
// tabs of a scenario). A busy machine fires the timers late.
describe('prepareScenario', { timeout: 20_000 }, () => {
  it('opens the tabs of the scenario in order, from the pages of the server, and waits for each one to show its title', async () => {
    const { ctx, state, dispatched, events } = fakeContext({ loadMs: 30 })
    const { info, tabIds } = await prepareScenario(ctx, scenario('tabs-10'), { pagesBase: BASE, tabs: 3 })
    expect(state.tabs.map((tab) => tab.url)).toEqual([1, 2, 3].map((index) => `${BASE}${pagePath(index)}`))
    expect(tabIds).toEqual(['t1', 't2', 't3'])
    expect(state.tabs.every((tab) => tab.title.startsWith(PAGE_TITLE_PREFIX))).toBe(true)
    expect(info).toEqual({ scenario: 'tabs-10', tabs: 3, liveTabs: 3, featuresOn: [], featuresOff: [] })
    expect(dispatched.map((action) => action.type)).toEqual(['tab/open', 'tab/open', 'tab/open'])
    // The next tab is not opened before the previous one has its title and has stopped loading.
    expect(events.map((event) => event.what)).toEqual(['open t1', 'loading t1', 'title t1', 'done t1', 'open t2', 'loading t2', 'title t2', 'done t2', 'open t3', 'loading t3', 'title t3', 'done t3'])
  })

  it('does not wait forever for the state of a tab the browser has none of: its title says the page is there', async () => {
    const { ctx, state } = fakeContext({ loadMs: 10, noRuntime: true })
    await prepareScenario(ctx, scenario('tabs-10'), { pagesBase: BASE, tabs: 2, tabTimeoutMs: 3000 })
    expect(state.tabs.every((tab) => tab.title.startsWith(PAGE_TITLE_PREFIX))).toBe(true)
  })

  it('takes the number of tabs from the scenario', async () => {
    const { ctx, state } = fakeContext({ loadMs: 1 })
    await prepareScenario(ctx, scenario('tabs-10'), { pagesBase: BASE })
    expect(state.tabs).toHaveLength(10)
  })

  it('touches no setting for a scenario of default settings', async () => {
    const { ctx, dispatched } = fakeContext({ loadMs: 1 })
    await prepareScenario(ctx, scenario('idle-empty'), { pagesBase: BASE })
    expect(dispatched).toEqual([])
  })

  it('switches the features before any tab is opened, and says which', async () => {
    for (const mode of ['on', 'off'] as const) {
      const { ctx, dispatched, state, events } = fakeContext({ loadMs: 1 })
      const { info } = await prepareScenario(ctx, scenario(`features-${mode}`), { pagesBase: BASE, tabs: 1 })
      const plan = perfFeaturePatch(mode)
      expect(dispatched.map((action) => action.type)).toEqual(['settings/update', 'tab/open'])
      // The gates get a moment to start or stop what they own before the first page exists.
      expect(events[1]!.at - events[0]!.at).toBeGreaterThanOrEqual(450)
      expect(dispatched[0]!['patch']).toEqual(plan.patch)
      expect(info).toMatchObject({ scenario: `features-${mode}`, featuresOn: plan.on, featuresOff: plan.off })
      expect(state.tabs).toHaveLength(1)
    }
  })

  it('stops, naming the page, when a tab does not load', async () => {
    const { ctx } = fakeContext({ loadMs: 1, stuck: (url) => url.endsWith('/p/2') })
    await expect(prepareScenario(ctx, scenario('tabs-10'), { pagesBase: BASE, tabs: 3, tabTimeoutMs: 300 })).rejects.toThrow(/la page 2 \(\/p\/2\) ne s’est pas chargée en 300 ms/)
  })

  it('stops when the browser creates no tab', async () => {
    const { ctx } = fakeContext({ createsNothing: true })
    await expect(prepareScenario(ctx, scenario('tabs-10'), { pagesBase: BASE, tabs: 1 })).rejects.toThrow(/l’onglet 1 n’a pas été créé/)
  })

  it('stops when some of the tabs have no live page, saying how many do', async () => {
    const { ctx } = fakeContext({ loadMs: 1, live: (ids) => ids.slice(0, 2) })
    await expect(prepareScenario(ctx, scenario('tabs-10'), { pagesBase: BASE, tabs: 3 })).rejects.toThrow(/3 onglets ouverts mais 2 seulement ont une page vivante/)
  })

  it('lets the checks of the engine test replace what opens a tab and what tells the live pages', async () => {
    const { ctx, dispatched } = fakeContext({ loadMs: 1 })
    await expect(prepareScenario(ctx, scenario('tabs-10'), { pagesBase: BASE, tabs: 1, open: () => undefined })).rejects.toThrow(/n’a pas été créé/)
    expect(dispatched).toEqual([])
  })
})

describe('runPerfDriver', () => {
  const lines: string[] = []
  const errors: unknown[][] = []
  const saved = { ...process.env }

  beforeEach(() => {
    lines.length = 0
    errors.length = 0
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const key of Object.keys(process.env)) if (key.startsWith('LUCIUM_PERF_')) delete process.env[key]
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const key of Object.keys(process.env)) if (key.startsWith('LUCIUM_PERF_')) delete process.env[key]
    Object.assign(process.env, saved)
  })

  it('says the scenario is ready, then stays still until the guard delay, and no sooner', async () => {
    process.env['LUCIUM_PERF_SCENARIO'] = 'idle-empty'
    process.env['LUCIUM_PERF_PAGES'] = BASE
    const { ctx } = fakeContext()
    let code: number | undefined
    void runPerfDriver(ctx).then((value) => (code = value))
    await vi.advanceTimersByTimeAsync(1_799_000)
    expect(code).toBeUndefined()
    expect(parseMarkerLine(lines[0]!)).toMatchObject({ kind: 'ready', info: { scenario: 'idle-empty', tabs: 0, liveTabs: 0 } })
    expect(lines).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(code).toBe(0)
  })

  it('takes the guard delay from LUCIUM_PERF_MAX_SECONDS when it is a sensible number, and ignores anything else', async () => {
    process.env['LUCIUM_PERF_SCENARIO'] = 'idle-empty'
    process.env['LUCIUM_PERF_PAGES'] = BASE
    const waits: Array<string | undefined> = []
    for (const [value, expectedSeconds] of [['60', 60], ['2', 1800], ['abc', 1800], ['9999999', 1800]] as const) {
      process.env['LUCIUM_PERF_MAX_SECONDS'] = value
      let code: number | undefined
      void runPerfDriver(fakeContext().ctx).then((result) => (code = result))
      await vi.advanceTimersByTimeAsync(expectedSeconds * 1000 - 1000)
      expect(code, `${value} must not end before ${expectedSeconds} s`).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2000)
      expect(code, `${value} must end at ${expectedSeconds} s`).toBe(0)
      waits.push(value)
    }
    expect(waits).toHaveLength(4)
  })

  it('says why on the standard output, and in the log, when it cannot prepare the scenario, and returns 2', async () => {
    process.env['LUCIUM_PERF_SCENARIO'] = 'tabs-10'
    process.env['LUCIUM_PERF_PAGES'] = BASE
    const { ctx } = fakeContext({ createsNothing: true })
    const done = runPerfDriver(ctx)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await done).toBe(2)
    expect(parseMarkerLine(lines[0]!)).toMatchObject({ kind: 'error', message: expect.stringContaining('n’a pas été créé') })
    expect(String(errors[0]![0])).toContain('[perf]')
  })

  describe('“toutes allumées” and the gates', () => {
    /** Starts, for these features, gates that follow the settings the fake browser holds, as the application's own do. */
    const withGates = (ctx: SmokeContext, ids: readonly string[]) => {
      const state = (ctx as unknown as { store: { get: () => { settings: unknown } } }).store
      const gates = new FeatureGates({ get: () => state.get() as SidebarState, subscribe: () => () => undefined })
      for (const id of ids) gates.gate(id as never, { start: () => undefined })
      return gates
    }

    it('names the features whose gate does not run, and returns 2: a figure that lacks them would be taken for a good one', async () => {
      process.env['LUCIUM_PERF_SCENARIO'] = 'features-on'
      process.env['LUCIUM_PERF_PAGES'] = BASE
      const { ctx } = fakeContext({ loadMs: 1 })
      const gates = withGates(ctx, GATES_OF_FEATURES_ON.filter((id) => id !== 'auto-backup' && id !== 'restore-windows'))
      const done = runPerfDriver(ctx)
      await vi.advanceTimersByTimeAsync(5000)
      expect(await done).toBe(2)
      gates.disposeAll()
      expect(parseMarkerLine(lines.at(-1)!)).toMatchObject({ kind: 'error', message: expect.stringMatching(/portails de auto-backup, restore-windows ne tournent pas/) })
    })

    it('says the scenario is ready when all of them run', async () => {
      process.env['LUCIUM_PERF_SCENARIO'] = 'features-on'
      process.env['LUCIUM_PERF_PAGES'] = BASE
      const { ctx } = fakeContext({ loadMs: 1 })
      // The gates look at the settings when they are made: the fake browser applies the patch first, so the gates are made on a second look.
      let code: number | undefined
      void runPerfDriver(ctx).then((value) => (code = value))
      await vi.advanceTimersByTimeAsync(600)
      const gates = withGates(ctx, GATES_OF_FEATURES_ON)
      await vi.advanceTimersByTimeAsync(5000)
      expect(parseMarkerLine(lines.at(-1)!)).toMatchObject({ kind: 'ready', info: { scenario: 'features-on' } })
      expect(code).toBeUndefined()
      gates.disposeAll()
    })
  })

  it('refuses a scenario it does not know and a pages address that is not the loopback one', async () => {
    const attempt = async (scenarioId: string | undefined, pages: string | undefined): Promise<string> => {
      lines.length = 0
      if (scenarioId === undefined) delete process.env['LUCIUM_PERF_SCENARIO']
      else process.env['LUCIUM_PERF_SCENARIO'] = scenarioId
      if (pages === undefined) delete process.env['LUCIUM_PERF_PAGES']
      else process.env['LUCIUM_PERF_PAGES'] = pages
      const done = runPerfDriver(fakeContext().ctx)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await done).toBe(2)
      const marker = parseMarkerLine(lines[0]!)
      return marker?.kind === 'error' ? marker.message : 'no error marker'
    }
    expect(await attempt('tabs-9', BASE)).toContain('scénario inconnu')
    expect(await attempt(undefined, BASE)).toContain('scénario inconnu')
    expect(await attempt('idle-empty', 'http://evil.example:80')).toContain('LUCIUM_PERF_PAGES')
    expect(await attempt('idle-empty', undefined)).toContain('LUCIUM_PERF_PAGES')
  })
})
