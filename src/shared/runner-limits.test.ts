import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { SUITES } from '../main/smoke-suites'
import type { CompatReport } from './compat-report'
import { isPart, judgeRun, readRunnerLimits, suiteFailed, withoutLimitedSuites } from './runner-limits'

const engine = { name: 'electron', version: '45.2.1', chromium: '156.0.8078.120' }
const report = (suites: CompatReport['suites']): CompatReport => ({ engine, suites, apiProbe: null, declarativeNetRequestEnforced: null, extensionNetworkRules: null })
const pass = (name: string) => ({ name, ok: true })
const fail = (name: string) => ({ name, ok: false })
const skip = (name: string) => ({ name, ok: true, skipped: true as const })

const limits = { guard: 'the screen of the runner is 1024 x 768', fullscreen: 'no window takes the full screen on the runner', 'main:iso-sidebar': 'the window is shorter than the rows of the list' }

describe('the list of the limits of the runner', () => {
  it('is read as names with reasons', () => {
    expect(readRunnerLimits({ guard: ' the screen ', fullscreen: 'no full screen' }, 'file')).toEqual({ guard: 'the screen', fullscreen: 'no full screen' })
    expect(readRunnerLimits({}, 'file')).toEqual({})
  })

  it('refuses what is not a list, and a suite without a reason: it would let a failure pass unread', () => {
    for (const raw of [null, [], 'guard', 3]) expect(() => readRunnerLimits(raw, 'file'), String(raw)).toThrow('not a list of limits')
    for (const reason of ['', '   ', 3, null, undefined]) expect(() => readRunnerLimits({ guard: reason }, 'file'), String(reason)).toThrow('the suite "guard" has no reason')
  })

  // The file of the repository: every name is a suite of the chain (a renamed suite would be excused under its old name, and fail under the new one), each with its reason.
  it('compat/runner-limits.json names suites of the chain, each with a reason', () => {
    const file = fileURLToPath(new URL('../../compat/runner-limits.json', import.meta.url))
    const read = readRunnerLimits(JSON.parse(readFileSync(file, 'utf8')), file)
    const chain = new Set(SUITES.filter((suite) => suite.chain).map((suite) => suite.name))
    expect(Object.keys(read).filter((name) => !isPart(name) && !chain.has(name))).toEqual([])
    // A part is a part of the principal suite, and a part that is not one is refused when the run starts (smoke.ts).
    expect(Object.keys(read).filter((name) => isPart(name) && !/^main:[a-z0-9-]+$/.test(name))).toEqual([])
    // A reason says what the runner lacks, in a sentence: not a word.
    for (const [name, reason] of Object.entries(read)) expect(reason.split(/\s+/).length, name).toBeGreaterThan(4)
  })
})

describe('a suite that failed', () => {
  it('has a code, or a check that did not pass; a check skipped did not fail', () => {
    expect(suiteFailed({ code: 0, checks: [pass('a'), skip('b')] })).toBe(false)
    expect(suiteFailed({ code: 1, checks: [pass('a')] })).toBe(true)
    expect(suiteFailed({ code: 0, checks: [pass('a'), fail('b')] })).toBe(true)
    expect(suiteFailed({ code: 0, checks: [] })).toBe(false)
  })
})

describe('the verdict of a run on a runner', () => {
  it('excuses the suites of the list that failed, and no other', () => {
    const run = report({
      main: { code: 0, checks: [pass('page loads')] },
      guard: { code: 1, checks: [fail('the screen is a common size')] },
      sitedata: { code: 1, checks: [fail('Effacer shows one result line')] }
    })
    expect(judgeRun(run, limits)).toEqual({
      unexpected: ['sitedata'],
      tolerated: [{ suite: 'guard', reason: limits.guard }],
      stale: [],
      notRun: ['fullscreen']
    })
  })

  it('does not excuse a suite for what it was listed for: a check of a listed suite that fails is the suite failing, and a suite not listed is judged whole', () => {
    const run = report({ guard: { code: 0, checks: [fail('one more check')] }, markdown: { code: 0, checks: [fail('a check')] }, windows: { code: 1, checks: [] } })
    expect(judgeRun(run, limits).unexpected).toEqual(['markdown', 'windows'])
  })

  it('says which listed suites passed (the limit may be gone) and which were not run, and fails neither: a part of the principal suite is not a suite', () => {
    const run = report({ guard: { code: 0, checks: [pass('a')] }, main: { code: 0, checks: [pass('b')] } })
    expect(judgeRun(run, limits)).toEqual({ unexpected: [], tolerated: [], stale: ['guard'], notRun: ['fullscreen'] })
    expect(isPart('main:iso-sidebar')).toBe(true)
    expect(isPart('main')).toBe(false)
  })

  it('does not take the name of an Object for a listed suite', () => {
    const run = report({ constructor: { code: 1, checks: [fail('a')] }, toString: { code: 1, checks: [fail('b')] } })
    expect(judgeRun(run, limits).unexpected).toEqual(['constructor', 'toString'])
  })

  it('leaves the listed suites out of the report that is set against the reference of the Mac', () => {
    const run = report({ main: { code: 0, checks: [pass('a')] }, guard: { code: 1, checks: [fail('b')] } })
    expect(Object.keys(withoutLimitedSuites(run, limits).suites)).toEqual(['main'])
    expect(Object.keys(run.suites)).toEqual(['main', 'guard'])
  })
})

describe('scripts/smoke-runner-verdict.mjs', () => {
  const script = fileURLToPath(new URL('../../scripts/smoke-runner-verdict.mjs', import.meta.url))
  const folder = mkdtempSync(join(tmpdir(), 'runner-verdict-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  const run = (suites: CompatReport['suites'] | null, listed: unknown = limits, ...more: string[]) => {
    const reportFile = join(folder, 'report.json')
    const limitsFile = join(folder, 'limits.json')
    if (suites !== null) writeFileSync(reportFile, JSON.stringify({ engine, suites }))
    else rmSync(reportFile, { force: true })
    writeFileSync(limitsFile, JSON.stringify(listed))
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--report', reportFile, '--limits', limitsFile, ...more], { encoding: 'utf8' })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }

  it('passes a run whose failures are all in the list, and says why each is excused', () => {
    const result = run({ main: { code: 0, checks: [pass('a')] }, guard: { code: 1, checks: [fail('b')] } }, limits, '--chain-code', '1')
    expect(result.status).toBe(0)
    expect(result.out).toContain(`~ guard: ${limits.guard}`)
    expect(result.out).toContain('Every suite that failed is a limit of the runner')
  })

  it('lists the suites it did not run, with the reason of each, and passes a run where they are the only ones missing', () => {
    const result = run({ main: { code: 0, checks: [pass('a')] } }, limits)
    expect(result.status).toBe(0)
    expect(result.out).toContain('2 named in the limits and not run')
    expect(result.out).toContain(`- fullscreen: ${limits.fullscreen}`)
    expect(result.out).not.toContain('main:iso-sidebar:')
  })

  it('fails a run with a suite that failed outside the list, and names it', () => {
    const result = run({ main: { code: 1, checks: [fail('a')] }, guard: { code: 1, checks: [fail('b')] } }, limits, '--chain-code', '1')
    expect(result.status).toBe(1)
    expect(result.out).toContain('1 failed and not excused:\n  - main')
  })

  it('fails a chain that ended badly with no suite to show for it: it crashed, and that is not excused', () => {
    expect(run({ main: { code: 0, checks: [pass('a')] } }, limits, '--chain-code', '1').status).toBe(1)
    expect(run({ main: { code: 0, checks: [pass('a')] } }, limits, '--chain-code', '0').status).toBe(0)
  })

  it('stops with 2 when the report is missing or a file cannot be read', () => {
    expect(run(null).status).toBe(2)
    expect(run({ main: { code: 0, checks: [] } }, { guard: '' }).status).toBe(2)
    for (const code of ['x', '', '-1', '1.5']) expect(run({ main: { code: 0, checks: [] } }, limits, '--chain-code', code).status, code).toBe(2)
  })
})

describe('scripts/compat-compare.mjs --limits', () => {
  const script = fileURLToPath(new URL('../../scripts/compat-compare.mjs', import.meta.url))
  const folder = mkdtempSync(join(tmpdir(), 'runner-compare-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  const reference = { main: { code: 0, checks: [pass('page loads')] }, guard: { code: 0, checks: [pass('the screen is a common size')] } }
  const compare = (suites: CompatReport['suites'], ...more: string[]) => {
    writeFileSync(join(folder, 'reference.json'), JSON.stringify({ engine, suites: reference }))
    writeFileSync(join(folder, 'report.json'), JSON.stringify({ engine, suites }))
    writeFileSync(join(folder, 'limits.json'), JSON.stringify(limits))
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--baseline', join(folder, 'reference.json'), '--report', join(folder, 'report.json'), ...more], { encoding: 'utf8' })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }
  const limited = ['--limits', join(folder, 'limits.json')]
  const guardFails = { main: reference.main, guard: { code: 1, checks: [fail('the screen is a common size')] } }

  it('loses a suite that fails on a runner unless the limits name it: the Mac passes no limits and judges everything', () => {
    expect(compare(guardFails).status).toBe(1)
    expect(compare(guardFails, ...limited).status).toBe(0)
    expect(compare(guardFails, ...limited).out).toContain('left out:  guard, fullscreen')
  })

  it('still loses what the suites that are not named lose', () => {
    const result = compare({ main: { code: 1, checks: [fail('page loads')] }, guard: guardFails.guard }, ...limited)
    expect(result.status).toBe(1)
    expect(result.out).toContain('- main: failed (passed in the reference): page loads')
  })

  it('does not write a reference from a run that did not judge every suite', () => {
    expect(compare(guardFails, ...limited, '--write').status).toBe(2)
    expect(compare(guardFails, '--informational', '--write').status).toBe(2)
  })

  it('prints what the run lost and exits 0 when it is only informational (the runner: the reference was recorded on a Retina Mac)', () => {
    const lostOne = { main: { code: 0, checks: [] as Array<{ name: string; ok: boolean }> }, guard: reference.guard }
    expect(compare(lostOne).status).toBe(1)
    const informational = compare(lostOne, '--informational')
    expect(informational.status).toBe(0)
    expect(informational.out).toContain('- main: no longer made: page loads')
    expect(informational.out).toContain('this comparison is informational')
    // A report that is missing still stops it: informational is not blind.
    rmSync(join(folder, 'report.json'), { force: true })
    const missing = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--baseline', join(folder, 'reference.json'), '--report', join(folder, 'report.json'), '--informational'], { encoding: 'utf8' })
    expect(missing.status).toBe(2)
  })
})
