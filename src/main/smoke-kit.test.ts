import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLanguage } from '@shared/i18n'
import { defaultSettings } from '@shared/model'
import {
  answerWithin,
  beginLedger,
  checkExtensionFolder,
  chooseSuite,
  closeLeftoverPanels,
  DEFAULT_SUITE_TIMEOUT_MS,
  exitCodeOf,
  keepClipboard,
  PINNED_SETTINGS,
  pollUntil,
  quitCallerOf,
  readSkips,
  recorderOf,
  reportFact,
  requireProbes,
  runChain,
  runReportOf,
  RunStop,
  runSuite,
  saveReport,
  skippedBecause,
  sleep,
  STALL_LIMIT_MS,
  stallWatch,
  suiteTimeoutMs,
  summaryOf,
  waiterOf,
  watchRun,
  type CheckRecord,
  type SuiteOutcome
} from './smoke-kit'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the waits of the engine checks', () => {
  it('sleep resolves after the time it is given, not before', async () => {
    let done = false
    void sleep(100).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(99)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('pollUntil answers true as soon as the condition holds, looking at it every step', async () => {
    let looks = 0
    const result = pollUntil(() => ++looks === 3, 1000, 50)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBe(true)
    expect(looks).toBe(3)
  })

  it('pollUntil waits for a condition that answers with a promise', async () => {
    let ready = false
    setTimeout(() => (ready = true), 120)
    const result = pollUntil(async () => ready, 1000, 50)
    await vi.advanceTimersByTimeAsync(150)
    expect(await result).toBe(true)
  })

  it('pollUntil gives the answer of one last look once the time is up', async () => {
    let looks = 0
    const never = pollUntil(() => (++looks, false), 200, 50)
    await vi.advanceTimersByTimeAsync(300)
    expect(await never).toBe(false)
    // Looks at 0, 50, 100, 150, then the last one after the deadline.
    expect(looks).toBe(5)

    let late = false
    const lastLook = pollUntil(() => late, 100, 100)
    setTimeout(() => (late = true), 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await lastLook).toBe(true)
  })

  it('answerWithin gives the answer of a question that comes in time, and leaves no timer behind', async () => {
    const answer = answerWithin(new Promise<string>((resolve) => setTimeout(() => resolve('done'), 50)), 1000)
    await vi.advanceTimersByTimeAsync(50)
    expect(await answer).toEqual({ answered: true, value: 'done' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answerWithin says that nothing came when the question is never answered, once the time is up and not before', async () => {
    let settled = false
    const never = answerWithin(new Promise<string>(() => undefined), 8000)
    void never.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(7999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await never).toEqual({ answered: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answerWithin hands a rejected question on: it is an error, not a missing answer', async () => {
    const failed = answerWithin(Promise.reject(new Error('Object has been destroyed')), 1000)
    await expect(failed).rejects.toThrow('Object has been destroyed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the full screen suite asks the page to leave only through answerWithin: a window that never leaves must not hold the run', () => {
    const source = readFileSync(join(__dirname, 'smoke-fullscreen.ts'), 'utf8')
    const calls = source.split('document.exitFullscreen()').length - 1
    expect(calls).toBe(1)
    const leave = /const leave = [\s\S]*?\n  }\n/.exec(source)?.[0] ?? ''
    expect(leave).toContain('answerWithin(')
    expect(leave).toContain('document.exitFullscreen()')
  })

  it('waiterOf keeps the default time and the step of a suite, and takes another time when one is given', async () => {
    const waitFor = waiterOf(300, 100)
    let looks = 0
    const byDefault = waitFor(() => (++looks, false))
    await vi.advanceTimersByTimeAsync(400)
    expect(await byDefault).toBe(false)
    expect(looks).toBe(4)

    looks = 0
    const shorter = waitFor(() => (++looks, false), 100)
    await vi.advanceTimersByTimeAsync(200)
    expect(await shorter).toBe(false)
    expect(looks).toBe(2)
  })
})

describe('what an earlier suite left over the window', () => {
  /** A window whose panel shows the next question of its queue when it closes, as the overlay of the shell does. */
  const windowWith = (panels: string[]) => ({
    shown: panels as Array<string>,
    currentPanel(): string | null {
      return this.shown[0] ?? null
    },
    closeOverlay(): void {
      this.shown = this.shown.slice(1)
    }
  })

  it('closes the open panel and each question queued behind it, and names them', () => {
    const win = windowWith(['downloads', 'auth', 'auth'])
    expect(closeLeftoverPanels(win)).toEqual(['downloads', 'auth', 'auth'])
    expect(win.currentPanel()).toBeNull()
  })

  it('leaves a window with nothing over it as it is', () => {
    const win = windowWith([])
    const close = vi.spyOn(win, 'closeOverlay')
    expect(closeLeftoverPanels(win)).toEqual([])
    expect(close).not.toHaveBeenCalled()
  })

  it('names the host and the realm of a question, when the window tells it, so that the suite that left it can be found', () => {
    const overlays = [{ panel: 'auth', request: { host: '127.0.0.1:4100', realm: 'Smoke' } }, { panel: 'downloads' }]
    const win = {
      currentPanel: () => overlays[0]?.panel ?? null,
      currentOverlay: () => overlays[0] ?? null,
      closeOverlay: () => void overlays.shift()
    }
    expect(closeLeftoverPanels(win)).toEqual(['auth 127.0.0.1:4100 Smoke', 'downloads'])
  })

  it('stops after a bound: a panel that keeps coming back does not hold the run', () => {
    const stubborn = { currentPanel: () => 'auth', closeOverlay: vi.fn() }
    expect(closeLeftoverPanels(stubborn, 3)).toEqual(['auth', 'auth', 'auth'])
    expect(stubborn.closeOverlay).toHaveBeenCalledTimes(3)
  })
})

describe('the checks of a suite', () => {
  it('keeps each check, counts it and writes it to the log at once', () => {
    const ledger = beginLedger()
    const checks: CheckRecord[] = []
    const lines: string[] = []
    const check = recorderOf(checks, (line) => lines.push(line))
    check('the page loads', true, 'detail of a pass is not printed')
    expect(lines).toEqual(['[smoke] ok   the page loads'])
    check('the menu opens', false, 'no menu')
    expect(lines.at(-1)).toBe('[smoke] FAIL the menu opens -- no menu')
    expect(checks).toEqual([
      { name: 'the page loads', ok: true, detail: 'detail of a pass is not printed' },
      { name: 'the menu opens', ok: false, detail: 'no menu' }
    ])
    expect(ledger.tally).toEqual({ checks: 2, failed: 1, skipped: 0 })
    expect(ledger.records).toEqual(checks)
  })

  it('counts a check that was not made as skipped, never as a pass, and says why', () => {
    const ledger = beginLedger()
    const checks: CheckRecord[] = []
    const lines: string[] = []
    recorderOf(checks, (line) => lines.push(line))('the voice reads the article', true, skippedBecause('no system voice'))
    expect(checks).toEqual([{ name: 'the voice reads the article', ok: true, detail: 'skipped: no system voice', skipped: true }])
    expect(lines).toEqual(['[smoke] skip the voice reads the article -- skipped: no system voice'])
    expect(ledger.tally).toEqual({ checks: 1, failed: 0, skipped: 1 })
  })

  it('a failed check is a failure whatever its detail says', () => {
    const ledger = beginLedger()
    const checks: CheckRecord[] = []
    recorderOf(checks, () => {})('the voice reads the article', false, skippedBecause('no system voice'))
    expect(checks[0]?.skipped).toBeUndefined()
    expect(ledger.tally).toEqual({ checks: 1, failed: 1, skipped: 0 })
  })

  it('a recorder keeps writing to the ledger of the suite that made it, after another suite has started', () => {
    const first = beginLedger()
    const late = recorderOf([], () => {})
    const second = beginLedger()
    late('a check of the suite that was left running', true)
    expect(first.tally.checks).toBe(1)
    expect(second.tally.checks).toBe(0)
  })
})

describe('the probe extensions a suite needs', () => {
  const loaded = [{ name: 'Sec2 Driver Probe' }, { name: 'Lucium API Probe' }]

  it('a probe that is not loaded is one failed check that names it and what is loaded', () => {
    const checks: CheckRecord[] = []
    const all = requireProbes(loaded, ['Sec2 Driver Probe', 'Sec2 Active Tab Probe'], recorderOf(checks, () => {}))
    expect(all).toBe(false)
    expect(checks).toEqual([
      { name: 'the probe extension "Sec2 Driver Probe" is loaded', ok: true, detail: undefined },
      { name: 'the probe extension "Sec2 Active Tab Probe" is loaded', ok: false, detail: 'loaded: Sec2 Driver Probe, Lucium API Probe (LUCIUM_EXTENSIONS must name its folder of compat/)' }
    ])
  })

  it('answers true when they are all there', () => {
    expect(requireProbes(loaded, ['Sec2 Driver Probe', 'Lucium API Probe'], () => {})).toBe(true)
  })

  it('a suite that returns because its probe is missing is a failed suite, not a pass with nothing verified', async () => {
    // The shape of the suites of the extensions: the probes are asked for first, and the suite returns without them.
    const suite = async (): Promise<number> => {
      const checks: CheckRecord[] = []
      const check = recorderOf(checks, () => {})
      if (requireProbes([], ['Lucium Surface Probe'], check)) check('the probe page loads in a tab', true)
      return checks.some((c) => !c.ok) ? 1 : 0
    }
    const outcome = await runSuite('surface', suite, 1000, () => {})
    expect(outcome.code).toBe(1)
    expect(outcome.tally).toEqual({ checks: 1, failed: 1, skipped: 0 })
  })
})

describe('a folder of LUCIUM_EXTENSIONS', () => {
  const loaded = [{ name: 'Sec2 Driver Probe', version: '1.0.0' }]
  const manifests: Record<string, string> = {
    '/repo/compat/sec-driver-probe/manifest.json': JSON.stringify({ name: 'Sec2 Driver Probe' }),
    '/repo/compat/api-probe/manifest.json': JSON.stringify({ name: 'Lucium API Probe' }),
    '/repo/compat/broken/manifest.json': '{ not json'
  }
  const read = (file: string): string => {
    const text = manifests[file]
    if (text === undefined) throw new Error(`ENOENT: ${file}`)
    return text
  }
  const checked = (path: string): CheckRecord[] => {
    const checks: CheckRecord[] = []
    checkExtensionFolder(path, loaded, recorderOf(checks, () => {}), read)
    return checks
  }

  it('passes for the folder whose own extension is loaded', () => {
    expect(checked('/repo/compat/sec-driver-probe')).toEqual([{ name: 'extension loaded: sec-driver-probe', ok: true, detail: '"Sec2 Driver Probe" among Sec2 Driver Probe@1.0.0' }])
    expect(checked('/repo/compat/sec-driver-probe/')[0]).toMatchObject({ name: 'extension loaded: sec-driver-probe', ok: true })
  })

  it('fails for a folder whose extension is not loaded, although another one is', () => {
    expect(checked('/repo/compat/api-probe')).toEqual([{ name: 'extension loaded: api-probe', ok: false, detail: '"Lucium API Probe" among Sec2 Driver Probe@1.0.0' }])
  })

  it('fails, with the reason, for a folder whose manifest is missing or is not JSON', () => {
    expect(checked('/repo/compat/gone')).toEqual([{ name: 'extension loaded: gone', ok: false, detail: 'its manifest cannot be read: ENOENT: /repo/compat/gone/manifest.json' }])
    expect(checked('/repo/compat/broken')[0]).toMatchObject({ name: 'extension loaded: broken', ok: false })
    expect(checked('/repo/compat/broken')[0]?.detail).toContain('its manifest cannot be read: ')
  })
})

describe('the run of one suite', () => {
  const quiet = (): void => {}

  it('a suite that says 0 without a single check is a failed suite: it verified nothing', async () => {
    const lines: string[] = []
    const outcome = await runSuite('sec2', async () => 0, 1000, (line) => lines.push(line))
    expect(outcome.code).toBe(1)
    expect(outcome.note).toBe('ended without a single check: nothing was verified')
    expect(lines.at(-1)).toBe('[smoke] == FAIL: sec2 -- 0 checks, 0 failed, 0 skipped, 0 s -- ended without a single check: nothing was verified')
  })

  it('a suite that passes keeps its code, its count and its checks', async () => {
    const outcome = await runSuite('windows', async () => (recorderOf([], quiet)('a window opens', true), 0), 1000, quiet)
    expect(outcome).toMatchObject({ name: 'windows', code: 0, tally: { checks: 1, failed: 0, skipped: 0 }, records: [{ name: 'a window opens', ok: true }] })
    expect(outcome.note).toBeUndefined()
  })

  it('a suite that says 0 with a failed check is a failed suite', async () => {
    const outcome = await runSuite('windows', async () => (recorderOf([], quiet)('a window opens', false), 0), 1000, quiet)
    expect(outcome.code).toBe(1)
  })

  it('a suite that throws is one failed suite, with its error', async () => {
    const outcome = await runSuite('market', async () => Promise.reject(new Error('no window')), 1000, quiet)
    expect(outcome.code).toBe(1)
    expect(outcome.note).toContain('threw: Error: no window')
  })

  it('a suite that never returns is counted as failed when its time is up, and the log names it', async () => {
    const lines: string[] = []
    const never = new Promise<number>(() => {})
    const running = runSuite('iso-panels', () => never, 90_000, (line) => lines.push(line))
    await vi.advanceTimersByTimeAsync(89_999)
    expect(lines).toEqual(['[smoke] == suite: iso-panels (at most 90 s)'])
    await vi.advanceTimersByTimeAsync(1)
    const outcome = await running
    expect(outcome).toMatchObject({ name: 'iso-panels', code: 1, timedOut: true })
    expect(outcome.note).toContain('the suite "iso-panels" did not return within 90 s')
    expect(lines.at(-1)).toContain('[smoke] == FAIL: iso-panels')
    expect(lines.at(-1)).toContain('the suite "iso-panels" did not return within 90 s')
  })

  it('leaves no timer behind when the suite returns in time', async () => {
    await runSuite('windows', async () => (recorderOf([], quiet)('a window opens', true), 0), 60_000, quiet)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a suite under way when the run is stopped is cut short at once, failed, with the reason, and leaves no timer behind', async () => {
    const lines: string[] = []
    const stop = new RunStop()
    const never = new Promise<number>(() => {})
    const running = runSuite('iso-panels', async () => (recorderOf([], quiet)('the panel opens', true), never), 1_200_000, (line) => lines.push(line), stop)
    await vi.advanceTimersByTimeAsync(5000)
    stop.stop('the screen of the Mac was locked')
    // A second reason changes nothing: the first one is the cause.
    stop.stop('the Mac went to sleep')
    const outcome = await running
    expect(outcome).toMatchObject({ name: 'iso-panels', code: 1, cutShort: true, tally: { checks: 1, failed: 0 } })
    expect(outcome.timedOut).toBeUndefined()
    expect(outcome.note).toBe('cut short: the screen of the Mac was locked (1 checks made)')
    expect(stop.reason()).toBe('the screen of the Mac was locked')
    expect(lines.at(-1)).toBe('[smoke] == FAIL: iso-panels -- 1 checks, 0 failed, 0 skipped, 5 s -- cut short: the screen of the Mac was locked (1 checks made)')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a suite that ends before any stop keeps its own outcome', async () => {
    const stop = new RunStop()
    const outcome = await runSuite('windows', async () => (recorderOf([], quiet)('a window opens', true), 0), 1000, quiet, stop)
    expect(outcome).toMatchObject({ code: 0 })
    expect(outcome.cutShort).toBeUndefined()
    expect(stop.reason()).toBeNull()
  })

  it('gives a suite the time of its entry, the default without one, and the time of the environment before both', () => {
    expect(suiteTimeoutMs(undefined, undefined)).toBe(DEFAULT_SUITE_TIMEOUT_MS)
    expect(suiteTimeoutMs(1_200_000, undefined)).toBe(1_200_000)
    expect(suiteTimeoutMs(1_200_000, '5000')).toBe(5000)
    for (const useless of ['', 'soon', '0', '-3']) expect(suiteTimeoutMs(1_200_000, useless)).toBe(1_200_000)
  })
})

describe('what stops a run before its end', () => {
  it('the clock of the main process: a tick that comes long after the one before is a Mac that slept, or a process that did not run', () => {
    const stalled = stallWatch(0)
    expect(stalled(5000)).toBeNull()
    expect(stalled(5000 + STALL_LIMIT_MS)).toBeNull()
    // The run of 12 November: the time limit of « markdown » fired 511 s late, at the wake of the Mac.
    expect(stalled(5000 + STALL_LIMIT_MS + 511_000)).toBe('the main process did not run for 511 s: the Mac slept, or the process was stopped or blocked')
    expect(stalled(5000 + STALL_LIMIT_MS + 516_000)).toBeNull()
  })

  /** Stand-ins of `systemPreferences`, `app` and the timer of the watch, which record what was subscribed and let a test send what macOS would. */
  const macOf = (platform = 'darwin') => {
    const subscribed = new Map<string, () => void>()
    const ids = new Map<number, string>()
    let next = 1
    const subscribe = (event: string, callback: () => void): number => {
      subscribed.set(event, callback)
      ids.set(next, event)
      return next++
    }
    const unsubscribe = (id: number): void => void subscribed.delete(ids.get(id) ?? '')
    const quitListeners = new Set<(event: { preventDefault(): void }) => void>()
    let clock = 0
    let tick: (() => void) | null = null
    const ports = {
      platform,
      preferences: { subscribeWorkspaceNotification: subscribe, unsubscribeWorkspaceNotification: unsubscribe, subscribeNotification: subscribe, unsubscribeNotification: unsubscribe },
      app: { on: (_event: 'before-quit', listener: (event: { preventDefault(): void }) => void) => quitListeners.add(listener), off: (_event: 'before-quit', listener: (event: { preventDefault(): void }) => void) => quitListeners.delete(listener) },
      now: () => clock,
      every: (_ms: number, each: () => void) => {
        tick = each
        return () => {
          tick = null
        }
      }
    }
    return {
      ports,
      subscribed,
      quitListeners,
      send: (event: string) => subscribed.get(event)?.(),
      /** Moves the clock and lets the timer of the watch fire once, as it does after a wake. */
      after: (ms: number) => {
        clock += ms
        tick?.()
      },
      ticking: () => tick !== null,
      /** Asks the application to quit: answers whether a listener held the quit. */
      quit: () => {
        let held = false
        for (const listener of quitListeners) listener({ preventDefault: () => (held = true) })
        return held
      }
    }
  }

  it('stops the run when macOS says the displays sleep, the screen is locked or the Mac goes to sleep, with the reason', () => {
    for (const [event, reason] of [
      ['NSWorkspaceScreensDidSleepNotification', 'the displays of the Mac went to sleep'],
      ['com.apple.screenIsLocked', 'the screen of the Mac was locked'],
      ['NSWorkspaceWillSleepNotification', 'the Mac went to sleep']
    ] as const) {
      const mac = macOf()
      const stop = new RunStop()
      watchRun(stop, mac.ports)
      expect(stop.reason()).toBeNull()
      mac.send(event)
      expect(stop.reason()).toMatch(new RegExp(`^${reason}: the checks need the screen on and unlocked`))
    }
  })

  it('stops the run when its own clock jumps (the timer of the watch fired at the wake), not while it ticks on time', () => {
    const mac = macOf()
    const stop = new RunStop()
    watchRun(stop, mac.ports)
    mac.after(5000)
    mac.after(5000)
    expect(stop.reason()).toBeNull()
    mac.after(816_000)
    expect(stop.reason()).toBe('the main process did not run for 816 s: the Mac slept, or the process was stopped or blocked')
  })

  it('holds a quit asked during the run and stops the run instead: the run ends itself, with its report and a failure', () => {
    const mac = macOf()
    const stop = new RunStop()
    watchRun(stop, mac.ports)
    expect(mac.quit()).toBe(true)
    expect(stop.reason()).toMatch(/^the application was asked to quit \(asked /)
  })

  it('lets go of every notification, the timer and the quit once the run is over', () => {
    const mac = macOf()
    const unwatch = watchRun(new RunStop(), mac.ports)
    expect([...mac.subscribed.keys()].sort()).toEqual(['NSWorkspaceScreensDidSleepNotification', 'NSWorkspaceWillSleepNotification', 'com.apple.screenIsLocked'])
    unwatch()
    expect(mac.subscribed.size).toBe(0)
    expect(mac.ticking()).toBe(false)
    expect(mac.quit()).toBe(false)
  })

  it('subscribes to no notification of macOS elsewhere, and still watches its clock and the quit', () => {
    const mac = macOf('linux')
    const stop = new RunStop()
    watchRun(stop, mac.ports)
    expect(mac.subscribed.size).toBe(0)
    expect(mac.quit()).toBe(true)
  })

  it('starts no suite once the run is stopped, and keeps the outcomes of those made', async () => {
    const stop = new RunStop()
    const ran: string[] = []
    const outcomes = await runChain(
      ['surface', 'iso-panels', 'sessions'],
      async (name) => {
        ran.push(name)
        if (name === 'iso-panels') stop.stop('the screen of the Mac was locked')
        return { name, code: name === 'iso-panels' ? 1 : 0, tally: { checks: 1, failed: 0, skipped: 0 }, records: [], facts: {}, ms: 1 }
      },
      stop
    )
    expect(ran).toEqual(['surface', 'iso-panels'])
    expect(outcomes.map((outcome) => outcome.name)).toEqual(['surface', 'iso-panels'])
  })

  it('names the scripts that asked the application to quit, without the frames of the listener and of Node', () => {
    const stack = [
      'Error',
      '    at onQuit (/app/out/main/smoke-run-x.js:1:200)',
      '    at App.emit (node:events:518:28)',
      '    at SystemQuit.request (/app/out/main/index.js:4:100)',
      '    at process.<anonymous> (/app/out/main/index.js:4:300)'
    ].join('\n')
    expect(quitCallerOf(stack, /onQuit/)).toBe('asked by at SystemQuit.request (/app/out/main/index.js:4:100) < at process.<anonymous> (/app/out/main/index.js:4:300)')
  })

  it('says that no script asked when the stack holds only the listener (the system, the Dock, ⌘Q)', () => {
    expect(quitCallerOf('Error\n    at onQuit (/app/out/main/smoke-run-x.js:1:200)\n    at App.emit (node:events:518:28)', /onQuit/)).toBe('asked from outside the scripts: the system, the Dock, ⌘Q or another application (a Quit Apple Event)')
    expect(quitCallerOf(undefined, /onQuit/)).toBe('asked from outside the scripts: the system, the Dock, ⌘Q or another application (a Quit Apple Event)')
  })
})

describe('the suite LUCIUM_SMOKE_ONLY names', () => {
  const names = ['main', 'windows', 'sec2', 'parts']

  it('is the whole chain when nothing is asked', () => {
    expect(chooseSuite(undefined, names)).toEqual({ kind: 'chain' })
    expect(chooseSuite('', names)).toEqual({ kind: 'chain' })
  })

  it('is the suite of that name', () => {
    expect(chooseSuite('sec2', names)).toEqual({ kind: 'only', name: 'sec2' })
  })

  it('refuses a name that no suite has, instead of starting the whole chain, and lists the names', () => {
    for (const wrong of ['windws', 'sidebar', 'Main', 'toString', '__proto__']) {
      const choice = chooseSuite(wrong, names)
      expect(choice.kind).toBe('unknown')
      if (choice.kind === 'unknown') expect(choice.message).toBe(`LUCIUM_SMOKE_ONLY="${wrong}" names no suite. Suites: main, parts, sec2, windows. A part of the principal suite is run with LUCIUM_SMOKE_ONLY=parts LUCIUM_SMOKE_PARTS=<part>.`)
    }
  })
})

describe('the end of a run', () => {
  const outcome = (name: string, code: number, tally: SuiteOutcome['tally'], note?: string): SuiteOutcome => ({ name, code, tally, records: [], facts: {}, ms: 2400, ...(note === undefined ? {} : { note }) })
  const outcomes = [
    outcome('main', 0, { checks: 160, failed: 0, skipped: 2 }),
    outcome('sec2', 1, { checks: 3, failed: 3, skipped: 0 }),
    outcome('iso-panels', 1, { checks: 12, failed: 0, skipped: 0 }, 'the suite "iso-panels" did not return within 1200 s\nat somewhere'),
    outcome('webstore', 0, { checks: 1, failed: 0, skipped: 1 })
  ]

  it('fails as soon as one suite failed', () => {
    expect(exitCodeOf(outcomes)).toBe(1)
    expect(exitCodeOf([outcomes[0]!, outcomes[3]!])).toBe(0)
    expect(exitCodeOf([])).toBe(0)
  })

  it('fails when the run was stopped, even if every suite made before passed', () => {
    expect(exitCodeOf([outcomes[0]!], true)).toBe(1)
    expect(exitCodeOf([], true)).toBe(1)
  })

  it('says in its summary that the run was stopped, why, and how many suites were not made', () => {
    expect(summaryOf([outcomes[0]!], { reason: 'the screen of the Mac was locked', suites: 59 }).at(-1)).toBe('[smoke] the run was stopped after 1 of its 59 suites, the others were not made: the screen of the Mac was locked')
    expect(summaryOf(outcomes).at(-1)).toBe('[smoke] suites that verified nothing (every check skipped): webstore')
  })

  it('names in its summary the suites that failed and those that verified nothing', () => {
    expect(summaryOf(outcomes)).toEqual([
      '[smoke] PASS main -- 160 checks, 0 failed, 2 skipped, 2 s',
      '[smoke] FAIL sec2 -- 3 checks, 3 failed, 0 skipped, 2 s',
      '[smoke] FAIL iso-panels -- 12 checks, 0 failed, 0 skipped, 2 s -- the suite "iso-panels" did not return within 1200 s',
      '[smoke] SKIP webstore -- 1 checks, 0 failed, 1 skipped, 2 s',
      '[smoke] total: 4 suites, 176 checks, 3 failed, 3 skipped',
      '[smoke] failed suites: sec2, iso-panels',
      '[smoke] suites that verified nothing (every check skipped): webstore'
    ])
  })

  it('writes the report of the run with the checks of each suite, without their details, and the facts the suites reported', async () => {
    const suite = await runSuite(
      'main',
      async () => {
        const check = recorderOf([], () => {})
        check('the page loads', true, 'http://127.0.0.1:54038/one')
        check('the voice reads', true, skippedBecause('no voice'))
        check('the rule is applied', false, 'hits=1')
        reportFact('declarativeNetRequestEnforced', false)
        return 1
      },
      1000,
      () => {}
    )
    expect(runReportOf({ name: 'electron', version: '45.2.1', chromium: '156.0.1.2' }, [suite])).toEqual({
      engine: { name: 'electron', version: '45.2.1', chromium: '156.0.1.2' },
      suites: { main: { code: 1, checks: [{ name: 'the page loads', ok: true }, { name: 'the voice reads', ok: true, skipped: true }, { name: 'the rule is applied', ok: false }] } },
      declarativeNetRequestEnforced: false
    })
  })

  it('a report that cannot be written is said in the log and fails the run', () => {
    const lines: string[] = []
    const refuse = (): void => {
      throw new Error('EACCES: permission denied')
    }
    expect(saveReport('/nowhere/report.json', { engine: {} }, refuse, (line) => lines.push(line))).toBe(false)
    expect(lines).toEqual(['[smoke] the report of the run could not be written to /nowhere/report.json: EACCES: permission denied'])
  })

  it('writes the report where it is asked, and nothing when no file is asked', () => {
    const files: Array<[string, string]> = []
    const write = (file: string, text: string): void => void files.push([file, text])
    expect(saveReport(undefined, { a: 1 }, write)).toBe(true)
    expect(saveReport('', { a: 1 }, write)).toBe(true)
    expect(files).toEqual([])
    expect(saveReport('/tmp/r.json', { a: 1 }, write)).toBe(true)
    expect(files).toEqual([['/tmp/r.json', '{\n  "a": 1\n}\n']])
  })
})

describe('the clipboard of the machine around a run', () => {
  const clipboardWith = (entries: Array<Record<string, string>>) => {
    const port = {
      now: entries,
      cleared: 0,
      read: async () => port.now.map((forms) => ({ types: Object.keys(forms), getType: async (type: string) => forms[type] as string })),
      write: async (kept: Array<Record<string, string>>) => void (port.now = kept),
      clear: () => {
        port.cleared++
        port.now = []
      }
    }
    return port
  }

  it('puts back every form of what was there before the suites wrote over it', async () => {
    const port = clipboardWith([{ 'text/plain': 'a sentence being written', 'text/html': '<b>a sentence</b>' }])
    const putBack = await keepClipboard(port)
    port.now = [{ 'text/plain': 'http://127.0.0.1:4100/one' }]
    await putBack()
    expect(port.now).toEqual([{ 'text/plain': 'a sentence being written', 'text/html': '<b>a sentence</b>' }])
  })

  it('empties a clipboard that was empty', async () => {
    const port = clipboardWith([])
    const putBack = await keepClipboard(port)
    port.now = [{ 'text/plain': 'luc1_ff8800' }]
    await putBack()
    expect(port.now).toEqual([])
    expect(port.cleared).toBe(1)
  })

  it('a clipboard that cannot be read is said in the log and left alone: an unknown content is not replaced by nothing', async () => {
    const lines: string[] = []
    const port = clipboardWith([{ 'text/plain': 'kept by the system' }])
    port.read = async () => Promise.reject(new Error('clipboard busy'))
    const putBack = await keepClipboard(port, (line) => lines.push(line))
    expect(lines).toEqual(['[smoke] the clipboard could not be read before the run, so it is left as the suites leave it: clipboard busy'])
    await putBack()
    expect(port.cleared).toBe(0)
    expect(port.now).toEqual([{ 'text/plain': 'kept by the system' }])
  })

  it('a clipboard that cannot be written back is said in the log and does not stop the run', async () => {
    const lines: string[] = []
    const port = clipboardWith([{ 'text/plain': 'mine' }])
    const putBack = await keepClipboard(port, (line) => lines.push(line))
    port.write = async () => Promise.reject(new Error('denied'))
    await expect(putBack()).resolves.toBeUndefined()
    expect(lines).toEqual(['[smoke] the clipboard could not be put back as it was before the run: denied'])
  })
})

describe('what the checks pin in the settings', () => {
  it('makes the interface French whatever the language of the Mac: the checks read French menus and titles', () => {
    for (const locale of ['en-US', 'en-GB', 'de-DE', 'fr-FR']) expect(resolveLanguage({ ...defaultSettings(), ...PINNED_SETTINGS }, locale)).toBe('fr')
    // The control: without the pin, the default follows an English system.
    expect(resolveLanguage(defaultSettings(), 'en-US')).toBe('en')
  })

  it('pins the dark appearance, and no longer the level of the Settings window, which is gone', () => {
    expect(PINNED_SETTINGS).toMatchObject({ interfaceAppearance: 'dark' })
    expect(PINNED_SETTINGS).not.toHaveProperty('showAdvancedSettings')
  })

  it('turns the warning before a file that can run off for the run, while it stays on by default (a .bin of a suite would wait for a box nobody answers)', () => {
    expect(PINNED_SETTINGS).toMatchObject({ warnExecutableDownload: false })
    expect(defaultSettings().warnExecutableDownload).toBe(true)
    expect({ ...defaultSettings(), ...PINNED_SETTINGS }.warnExecutableDownload).toBe(false)
  })
})

describe('a pattern written with ordinary spaces', () => {
  it('matches the text with its non-breaking spaces, and still the one typed with ordinary ones', async () => {
    const { anySpace } = await import('./smoke-kit')
    const { frenchSpaces } = await import('@shared/french-typography')
    const pattern = anySpace(/^Copie restaurée : \d+ onglets, « (.+) » \?$/)
    expect(pattern.test(frenchSpaces('Copie restaurée : 4 onglets, « Perso » ?'))).toBe(true)
    expect(pattern.test('Copie restaurée : 4 onglets, « Perso » ?')).toBe(true)
    expect(/^Copie restaurée : \d+ onglets, « (.+) » \?$/.test(frenchSpaces('Copie restaurée : 4 onglets, « Perso » ?'))).toBe(false)
  })

  it('keeps the flags, the escapes and the classes as they are written', async () => {
    const { anySpace } = await import('./smoke-kit')
    expect(anySpace(/le journal/i).flags).toBe('i')
    expect(anySpace(/a\ b[ x]c/).source).toBe('a\\ b[ x]c')
    expect(anySpace(/a b/).test('a b')).toBe(true)
    expect(anySpace(/a b/).test('ab')).toBe(false)
  })
})

describe('LUCIUM_SMOKE_SKIP, the suites and the parts a run leaves out', () => {
  const names = ['main', 'sitedata', 'fullscreen', 'guard']

  it('leaves nothing out when it is not set, or empty: the Mac runs the whole chain', () => {
    for (const value of [undefined, '', '  ', ',,']) expect(readSkips(value, names), String(value)).toEqual({ suites: new Set(), parts: new Set(), unknown: [] })
  })

  it('reads suites, and parts of the principal suite as main:<part>, with the spaces and the empty entries ignored', () => {
    const choice = readSkips(' sitedata, main:iso-sidebar ,,fullscreen,main:iso-media', names)
    expect([...choice.suites]).toEqual(['sitedata', 'fullscreen'])
    expect([...choice.parts]).toEqual(['iso-sidebar', 'iso-media'])
    expect(choice.unknown).toEqual([])
  })

  it('refuses a name that is no suite, and a part with no name: a typing mistake must not run what it was meant to leave out', () => {
    expect(readSkips('sitedatta,guard,main:,other:iso-sidebar', names).unknown).toEqual(['sitedatta', 'main:', 'other:iso-sidebar'])
    expect([...readSkips('sitedatta,guard', names).suites]).toEqual(['guard'])
  })
})
