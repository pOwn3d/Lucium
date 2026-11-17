import { describe, expect, it, vi } from 'vitest'
import type { SmokeContext } from './smoke'
import { beginLedger, recorderOf, runSuite, type CheckRecord } from './smoke-kit'

// The suites import Electron for what they do after their probes are found; a stand-in is enough here (the real package starts by fetching its binary).
vi.mock('electron', async () => (await import('./engine/electron-page.test-support')).electronStub())

// The two suites of what an extension may do, started for real on an engine that loaded none of their probes. They used to return without a
// word, and the run stayed green with nothing verified. Electron itself is never reached: both suites ask for their probes before anything else.

/** A run where the probes did not load: the engine lists `loaded`, and anything else a suite would touch is absent. */
const contextWith = (loaded: Array<{ id: string; name: string }>): SmokeContext => ({ engine: { listExtensions: () => loaded } }) as unknown as SmokeContext

// The first test that imports a suite pays for the reading of the suite and of the hundreds of modules it imports: under a second on a quiet
// machine, ten when every core is taken.
describe('a suite of the extensions whose probe is not loaded', { timeout: 30_000 }, () => {
  it('sec2: each of its three probes that is missing is a failed check', async () => {
    const { smokeSec2 } = await import('./smoke-sec2')
    beginLedger()
    const checks: CheckRecord[] = []
    await smokeSec2(contextWith([{ id: 'a'.repeat(32), name: 'Sec2 Driver Probe' }]), recorderOf(checks, () => {}))
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ['the probe extension "Sec2 No Permission Probe" is loaded', false],
      ['the probe extension "Sec2 Driver Probe" is loaded', true],
      ['the probe extension "Sec2 Active Tab Probe" is loaded', false]
    ])
  })

  it('sec2 run alone without its probes is a failed suite', async () => {
    const { runSec2Smoke } = await import('./smoke-sec2')
    const outcome = await runSuite('sec2', () => runSec2Smoke(contextWith([])), 5000, () => {})
    expect(outcome.code).toBe(1)
    expect(outcome.tally.failed).toBe(3)
  })

  it('the agent-style probe: without it the suite fails instead of passing with no check', async () => {
    const { smokeSurface, runSurfaceSmoke } = await import('./smoke-extensions')
    beginLedger()
    const checks: CheckRecord[] = []
    await smokeSurface(contextWith([{ id: 'b'.repeat(32), name: 'Lucium API Probe' }]), recorderOf(checks, () => {}))
    expect(checks).toEqual([{ name: 'the probe extension "Lucium Surface Probe" is loaded', ok: false, detail: 'loaded: Lucium API Probe (LUCIUM_EXTENSIONS must name its folder of compat/)' }])
    const outcome = await runSuite('surface', () => runSurfaceSmoke(contextWith([])), 5000, () => {})
    expect(outcome.code).toBe(1)
    expect(outcome.tally).toEqual({ checks: 1, failed: 1, skipped: 0 })
  })
})
