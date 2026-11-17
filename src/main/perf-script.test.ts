import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseBudget, parseReport, type Budget } from '@shared/perf-core'

// scripts/perf.mjs, run for real against a stand-in for Electron (--electron-path): a small program that prints the lines the application prints
// (src/main/smoke-perf.ts) and starts a few processes of its own with the --type= flags of Chromium's children. They sleep: only the test that reads
// the CPU asks one of them to burn half a core (PERF_FAKE_BUSY).
// What the stand-in cannot tell is what the real application does; what it does tell is that the script starts, follows, measures with the real
// `ps`, reports, writes its files, exits with the right code and leaves no process behind.

const script = fileURLToPath(new URL('../../scripts/perf.mjs', import.meta.url))
const realBudget = readFileSync(fileURLToPath(new URL('../../perf-budget.json', import.meta.url)), 'utf8')

let dir = ''
let fake = ''
let slowFake = ''
/** The budget these runs are judged by: the shape of the real file with figures of its own, so that calibrating perf-budget.json never changes a test. */
let budgetFile = ''
let budget: Budget
const logFiles: string[] = []

/** How often a process of the stand-in looks whether the process that started it is still there. */
const ORPHAN_POLL_MS = 500
/** How long a process of the stand-in lives at most, whatever happens to the test that started it. */
const STAND_IN_LIFE_MS = 90_000

/**
 * The stand-in. `PERF_FAKE_LOG` (not an LUCIUM_ variable, so the script keeps it) names a file where it writes the pids of its processes.
 * None of its processes can outlive the test: each one stops when the process that started it is gone (a killed parent runs no handler, so the
 * child has to look for itself) and after STAND_IN_LIFE_MS at the latest. Every command line carries the folder of the test, which is how
 * `stopLeftovers` tells a stand-in from another program that was given the same pid later.
 */
const standIn = (shownDelayMs: number) => `#!${process.execPath}
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const scenario = process.env.LUCIUM_PERF_SCENARIO
const log = (pid) => process.env.PERF_FAKE_LOG && appendFileSync(process.env.PERF_FAKE_LOG, pid + '\\n')
const children = []
const mortal = 'const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0) }, ${ORPHAN_POLL_MS}); setTimeout(() => process.exit(0), ${STAND_IN_LIFE_MS});'
const busy = 'setInterval(() => { const end = Date.now() + 100; while (Date.now() < end); }, 200);'
const start = (type, work = '') => {
  const child = spawn(process.execPath, ['-e', mortal + work, '--', '--type=' + type, ${JSON.stringify(`--stand-in-of=${dir}`)}], { stdio: 'ignore' })
  log(child.pid)
  children.push(child)
}
const stop = () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(0)
}
log(process.pid)
setTimeout(() => console.log('LUCIUM_PERF_SHOWN 250'), ${shownDelayMs})
setTimeout(() => {
  if (scenario === 'tabs-50') return console.log('LUCIUM_PERF_ERROR la page 3 (/p/3) ne s’est pas chargée en 20000 ms')
  start('gpu-process')
  start('utility')
  start('renderer', process.env.PERF_FAKE_BUSY ? busy : '')
  start('renderer')
  console.log('LUCIUM_PERF_READY ' + JSON.stringify({ scenario, tabs: 0, liveTabs: 0, featuresOn: [], featuresOff: [] }))
  // A crash during the measure: the application goes away, its processes with it.
  if (process.env.PERF_FAKE_DIE_MS) setTimeout(() => process.emit('SIGTERM'), Number(process.env.PERF_FAKE_DIE_MS))
}, ${shownDelayMs} + 250)
process.on('SIGTERM', stop)
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) stop() }, ${ORPHAN_POLL_MS})
// A guard for a test that was cut short: the real application has one too.
setTimeout(stop, ${STAND_IN_LIFE_MS})
`

interface Outcome {
  status: number | null
  stdout: string
  stderr: string
}

function perf(args: string[], env: Record<string, string> = {}): Outcome {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`)
  const judged = args.includes('--budget') ? [] : ['--budget', budgetFile]
  // Whatever a test of this file does, the program started is a stand-in: a guard that fails to stop the script must not reach the real Electron.
  const program = args.includes('--electron-path') ? [] : ['--electron-path', fake]
  // Every stand-in writes its pids down, whether the test reads them or not: `stopLeftovers` works from these files.
  const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--out', out, ...judged, ...program, ...args], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, PERF_FAKE_LOG: pidLog(), ...env } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const outDirOf = (outcome: Outcome): string => /rapport : (.*)\/perf-[^/]+\.json/.exec(outcome.stderr)![1]!

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pids file of the runs that do not name one of their own. */
function pidLog(name = 'pids.log'): string {
  const file = join(dir, name)
  if (!logFiles.includes(file)) logFiles.push(file)
  return file
}

const pidsIn = (file: string): number[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : [])

/** Whether this pid is still a process of a stand-in of this file, and not another program the system gave the same number to. */
const isStandIn = (pid: number): boolean => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes(dir)

/**
 * Stops every process of a stand-in that is still running, and says which. A test that fails, or passes its time limit, never reaches its own
 * last lines: this runs after each test and when the worker goes away, so that nothing is left to burn the processor behind a red run.
 */
function stopLeftovers(): number[] {
  if (dir === '') return []
  const stopped: number[] = []
  for (const pid of new Set(logFiles.flatMap(pidsIn))) {
    if (!alive(pid) || !isStandIn(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
      stopped.push(pid)
    } catch (error) {
      // Gone between the two lines: that is what was wanted. Anything else is a process this file started and cannot stop.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  return stopped
}

async function until(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
}

afterEach(() => {
  stopLeftovers()
})
process.once('exit', stopLeftovers)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-perf-test-'))
  fake = join(dir, 'fake-app.mjs')
  slowFake = join(dir, 'slow-app.mjs')
  writeFileSync(fake, standIn(150))
  writeFileSync(slowFake, standIn(900))
  chmodSync(fake, 0o755)
  chmodSync(slowFake, 0o755)
  budget = JSON.parse(realBudget) as Budget
  budget.provisional = true
  budget.scenarios['startup-cold'] = { readyMs: { baseline: 3000 } }
  // Half a core of CPU is far above 1 % + the noise of the measure.
  budget.scenarios['idle-empty'] = { rssTotalMb: { baseline: 5000 }, cpuMeanPct: { baseline: 1, marginPercent: 0 } }
  budgetFile = join(dir, 'budget.json')
  writeFileSync(budgetFile, JSON.stringify(budget))
})

afterAll(() => {
  // The files of pids go with the folder: what they name is stopped first.
  stopLeftovers()
  rmSync(dir, { recursive: true, force: true })
  dir = ''
})

// Each of these tests starts Node up to five times: about 1.5 s on a quiet machine, several times that when every core is taken.
describe('scripts/perf.mjs: the command line', { timeout: 30_000 }, () => {
  it('prints its usage and exits 0', () => {
    const outcome = perf(['--help'])
    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('Usage : pnpm perf')
    for (const flag of ['--only', '--compare', '--write-budget', '--max-regression', '--no-build']) expect(outcome.stdout).toContain(flag)
  })

  it('exits 2 with the reason for an option that does not exist, a scenario that does not exist and a number out of range', () => {
    expect(perf(['--bogus'])).toMatchObject({ status: 2, stderr: expect.stringContaining('option invalide') })
    expect(perf(['--only', 'tabs-9'])).toMatchObject({ status: 2, stderr: expect.stringContaining('scénario inconnu : tabs-9') })
    expect(perf(['--repeat', '99'])).toMatchObject({ status: 2, stderr: expect.stringContaining('--repeat') })
  })

  it('exits 2, naming the problems, for a budget file that is not valid or not JSON, and for a report to compare with that is not one', () => {
    const bad = join(dir, 'bad-budget.json')
    writeFileSync(bad, JSON.stringify({ version: 1, provisional: false, defaultMarginPercent: 25, reference: { machine: 'm', os: 'o', cpu: 'c', memoryGb: 1, electron: '1' }, scenarios: { 'tabs-500': {} } }))
    expect(perf(['--budget', bad])).toMatchObject({ status: 2, stderr: expect.stringContaining('scénario inconnu : tabs-500') })
    const notJson = join(dir, 'not-json.json')
    writeFileSync(notJson, '{')
    expect(perf(['--budget', notJson])).toMatchObject({ status: 2, stderr: expect.stringContaining('JSON invalide') })
    expect(perf(['--budget', join(dir, 'missing.json')])).toMatchObject({ status: 2, stderr: expect.stringContaining('lecture impossible') })
    const notReport = join(dir, 'not-a-report.json')
    writeFileSync(notReport, '{"version":3}')
    expect(perf(['--compare', notReport])).toMatchObject({ status: 2, stderr: expect.stringContaining('n’est pas un rapport de perf') })
    expect(perf(['--electron-path', join(dir, 'nowhere')])).toMatchObject({ status: 2, stderr: expect.stringContaining('n’existe pas') })
  })

  it('exits 2 for a budget file that leaves a required limit out', () => {
    const gappy = join(dir, 'gappy.json')
    const scenarios = { ...budget.scenarios }
    delete scenarios['tabs-50']
    writeFileSync(gappy, JSON.stringify({ ...budget, scenarios }))
    expect(perf(['--budget', gappy])).toMatchObject({ status: 2, stderr: expect.stringContaining('tabs-50.rssTotalMb') })
  })

  it('takes the double dash pnpm forwards', () => {
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--', '--help'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage : pnpm perf')
  })
})

describe.runIf(process.platform !== 'win32')('scripts/perf.mjs: a run against a stand-in for the application', { timeout: 90_000 }, () => {
  it('measures the start-up, checks the budget, writes the table and the JSON, and exits 0', () => {
    const outcome = perf(['--electron-path', fake, '--only', 'startup-cold', '--startup-runs', '2'])
    expect(outcome.status, outcome.stderr).toBe(0)
    expect(outcome.stdout).toContain('startup-cold — Démarrage à froid')
    expect(outcome.stdout).toContain('Aucun seuil dépassé.')
    const latest = JSON.parse(readFileSync(join(outDirOf(outcome), 'latest.json'), 'utf8'))
    expect(parseReport(latest).errors).toEqual([])
    expect(latest.results['startup-cold'].runs).toBe(2)
    expect(latest.results['startup-cold'].measures.readyMs).toBeGreaterThan(100)
    expect(latest.results['startup-cold'].measures.readyMs).toBeLessThan(3000)
    expect(existsSync(join(outDirOf(outcome), `perf-${latest.generatedAt.replace(/[:.]/g, '-')}.md`))).toBe(true)
  })

  // `ps` of macOS gives the CPU time in hundredths of a second; the one of Linux in whole seconds, too coarse for a 5 s window.
  it.runIf(process.platform === 'darwin')('reads the real process tree with ps: the processes below the application, their memory, and the CPU a busy one uses', () => {
    const log = pidLog('pids-steady.log')
    const outcome = perf(['--electron-path', fake, '--only', 'idle-empty', '--cpu-seconds', '5', '--settle-seconds', '0'], { PERF_FAKE_LOG: log, PERF_FAKE_BUSY: '1' })
    const latest = JSON.parse(readFileSync(join(outDirOf(outcome), 'latest.json'), 'utf8'))
    const measures = latest.results['idle-empty'].measures
    // The application and the four processes it started: one GPU, one utility, two renderers (one of them busy for half of the time).
    expect(measures.processCount).toBe(5)
    expect(measures.rssGpuMb).toBeGreaterThan(5)
    expect(measures.rssUtilityMb).toBeGreaterThan(5)
    expect(measures.rssRendererMb).toBeGreaterThan(10)
    expect(measures.rssTotalMb).toBeGreaterThan(measures.rssMainMb + measures.rssRendererMb)
    expect(measures.cpuMeanPct).toBeGreaterThan(10)
    expect(measures.cpuMeanPct).toBeLessThan(150)
    // …and the budget says so.
    expect(outcome.status).toBe(1)
    expect(outcome.stdout).toContain('DÉPASSÉ')
    // Everything it started is gone, and its throw-away data folder with it.
    const pids = pidsIn(log)
    expect(pids).toHaveLength(5)
    expect(pids.filter(alive)).toEqual([])
  })

  it('exits 1 when a limit is passed, and 0 when the same run is judged by a looser budget', () => {
    const tight = join(dir, 'tight.json')
    writeFileSync(tight, JSON.stringify({ ...budget, scenarios: { ...budget.scenarios, 'startup-cold': { readyMs: { baseline: 100, marginPercent: 0 } } } }))
    const over = perf(['--electron-path', slowFake, '--only', 'startup-cold', '--startup-runs', '1', '--budget', tight])
    expect(over.status).toBe(1)
    expect(over.stdout).toContain('DÉPASSÉ')
    expect(perf(['--electron-path', slowFake, '--only', 'startup-cold', '--startup-runs', '1']).status).toBe(0)
  })

  it('compares with an earlier report: a regression beyond the percentage and the noise exits 1, a stable run exits 0', () => {
    const first = perf(['--electron-path', fake, '--only', 'startup-cold', '--startup-runs', '1'])
    const earlier = join(outDirOf(first), 'latest.json')
    const slower = perf(['--electron-path', slowFake, '--only', 'startup-cold', '--startup-runs', '1', '--compare', earlier])
    expect(slower.stdout).toContain('RÉGRESSION')
    expect(slower.status).toBe(1)
    const stable = perf(['--electron-path', fake, '--only', 'startup-cold', '--startup-runs', '1', '--compare', earlier])
    expect(stable.stdout).toContain('Aucune régression.')
    expect(stable.status).toBe(0)
  })

  it('exits 2 and says so when the application goes away during the measure', () => {
    const log = pidLog('pids-crash.log')
    const outcome = perf(['--electron-path', fake, '--only', 'idle-empty', '--cpu-seconds', '5', '--settle-seconds', '1'], { PERF_FAKE_LOG: log, PERF_FAKE_DIE_MS: '1200' })
    expect(outcome.status).toBe(2)
    expect(outcome.stdout).toContain('s’est arrêtée pendant la mesure (code 0)')
    expect(pidsIn(log).filter(alive)).toEqual([])
  })

  it('exits 2 with the reason when the program cannot be started', () => {
    const notExecutable = join(dir, 'not-executable')
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 })
    const outcome = perf(['--electron-path', notExecutable, '--only', 'startup-cold', '--startup-runs', '1'])
    expect(outcome.status).toBe(2)
    expect(outcome.stdout).toContain('erreur de lancement')
  })

  it('exits 2 and lists the scenario when the application reports it cannot prepare it', () => {
    const outcome = perf(['--electron-path', fake, '--only', 'tabs-50'])
    expect(outcome.status).toBe(2)
    expect(outcome.stdout).toContain('## Scénarios en échec')
    expect(outcome.stdout).toContain('la page 3 (/p/3) ne s’est pas chargée')
  })

  it('writes the budget from the measures with --write-budget, only for the scenarios it ran, and not from a run that failed', () => {
    const file = join(dir, 'to-calibrate.json')
    writeFileSync(file, JSON.stringify(budget))
    const done = perf(['--electron-path', fake, '--only', 'startup-cold', '--startup-runs', '1', '--budget', file, '--write-budget'])
    expect(done.status, done.stderr).toBe(0)
    const written = parseBudget(JSON.parse(readFileSync(file, 'utf8')))
    expect(written.errors).toEqual([])
    expect(written.budget!.scenarios['startup-cold']!.readyMs!.baseline).not.toBe(budget.scenarios['startup-cold']!.readyMs!.baseline)
    expect(written.budget!.scenarios['startup-cold']!.readyMs!.baseline).toBeGreaterThan(100)
    expect(written.budget!.scenarios['tabs-10']).toEqual(budget.scenarios['tabs-10'])
    expect(written.budget!.provisional).toBe(true)
    expect(written.budget!.reference.cpu).not.toBe('')

    const kept = readFileSync(file, 'utf8')
    const failed = perf(['--electron-path', fake, '--only', 'tabs-50', '--budget', file, '--write-budget'])
    expect(failed.status).toBe(2)
    expect(failed.stderr).toContain('--write-budget ignoré')
    expect(readFileSync(file, 'utf8')).toBe(kept)
  })

  it('stops the application and everything below it when the script is interrupted', async () => {
    const log = pidLog('pids-interrupted.log')
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--out', join(dir, 'out-interrupted'), '--electron-path', fake, '--only', 'idle-empty', '--cpu-seconds', '5', '--settle-seconds', '30'], { env: { ...process.env, PERF_FAKE_LOG: log }, stdio: ['ignore', 'ignore', 'pipe'] })
    try {
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
      await until(() => stderr.includes('prêt'), 30_000)
      expect(stderr).toContain('prêt')
      child.kill('SIGINT')
      expect(await exited).toBe(130)
      const pids = pidsIn(log)
      expect(pids).toHaveLength(5)
      expect(pids.filter(alive)).toEqual([])
    } finally {
      // A script that never said it was ready, or never answered the signal, is not left to finish its 35 s alone.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })

  it('a stand-in stops by itself, with everything below it, when the process that started it is killed', async () => {
    const log = pidLog('pids-orphaned.log')
    // The holder stands for a script that is killed outright: it starts the stand-in and runs no handler when it goes.
    const holder = spawn(process.execPath, ['-e', `require('node:child_process').spawn(${JSON.stringify(fake)}, ['.'], { stdio: 'ignore' }); setTimeout(() => process.exit(0), ${STAND_IN_LIFE_MS})`], { env: { ...process.env, PERF_FAKE_LOG: log, LUCIUM_PERF_SCENARIO: 'idle-empty' }, stdio: 'ignore' })
    try {
      await until(() => pidsIn(log).length === 5, 30_000)
      const pids = pidsIn(log)
      expect(pids).toHaveLength(5)
      expect(pids.filter(alive)).toHaveLength(5)
      holder.kill('SIGKILL')
      await until(() => pids.filter(alive).length === 0, 30_000)
      expect(pids.filter(alive)).toEqual([])
    } finally {
      holder.kill('SIGKILL')
    }
  })

  // Two tests that follow each other: the first one ends like a test that failed half way, the second one looks at what is left of it.
  describe('a test that ends with its stand-in still running', () => {
    let left: number[] = []

    it('leaves five processes behind, written in its file of pids', async () => {
      const log = pidLog('pids-left.log')
      spawn(fake, ['.'], { env: { ...process.env, PERF_FAKE_LOG: log, LUCIUM_PERF_SCENARIO: 'idle-empty' }, stdio: 'ignore' })
      await until(() => pidsIn(log).length === 5, 30_000)
      left = pidsIn(log)
      expect(left).toHaveLength(5)
      expect(left.filter(alive)).toHaveLength(5)
      expect(process.listeners('exit')).toContain(stopLeftovers)
    })

    it('finds them all stopped when the next test starts', async () => {
      expect(left, 'this test reads what the one before it left: run the two together').toHaveLength(5)
      // A killed child of this very process stays in the table until Node has read its end.
      await until(() => left.filter(alive).length === 0, 10_000)
      expect(left.filter(alive)).toEqual([])
    })
  })
})
