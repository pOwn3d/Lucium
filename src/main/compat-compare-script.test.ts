import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tempDir } from './temp-dir'

// scripts/compat-compare.mjs run for real, on reports and references written in a scratch folder: what it prints, the reference it chooses, the
// file it writes and its exit code. The rules of the comparison themselves are tested in src/shared/compat-report.test.ts.

const script = fileURLToPath(new URL('../../scripts/compat-compare.mjs', import.meta.url))

const reportOf = (version: string, checks: Array<{ name: string; ok: boolean }>, more: Record<string, unknown> = {}) => ({
  engine: { name: 'electron', version, chromium: '156.0.8078.48' },
  suites: { main: { code: checks.some((check) => !check.ok) ? 1 : 0, checks } },
  apiProbe: [{ present: 92, missing: ['bookmarks'], calls: { 'tabs.query({})': 'ok' } }],
  declarativeNetRequestEnforced: true,
  ...more
})

function setup(run: unknown, baselines: Record<string, unknown> = {}) {
  const dir = tempDir('lucium-compat-')
  const report = join(dir, 'report.json')
  if (run !== undefined) writeFileSync(report, JSON.stringify(run))
  for (const [name, content] of Object.entries(baselines)) writeFileSync(join(dir, name), JSON.stringify(content))
  const start = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--report', report, '--compat', dir, ...args], { encoding: 'utf8' })
    return { code: result.status, out: result.stdout, err: result.stderr }
  }
  return { dir, start }
}

const passing = [{ name: 'page loads', ok: true }, { name: 'find in page', ok: true }]

// Each run below is a Node that starts: half a second each on a quiet machine, several times that when every core is taken, and a test makes up to three.
const SCRIPT_RUNS = { timeout: 30_000 }

describe('pnpm compat:compare', SCRIPT_RUNS, () => {
  it('exits 0 and says so when the run lost nothing', () => {
    const { start } = setup(reportOf('45.2.1', passing), { 'baseline-electron-45.2.1.json': reportOf('45.2.1', passing) })
    const result = start()
    expect(result.err).toBe('')
    expect(result.out).toContain('Nothing lost: everything the reference proved, the run proves.')
    expect(result.code).toBe(0)
  })

  it('exits 1 and lists each loss when a check that passed now fails', () => {
    const run = reportOf('45.2.1', [{ name: 'page loads', ok: true }, { name: 'find in page', ok: false }], { declarativeNetRequestEnforced: false })
    const { start } = setup(run, { 'baseline-electron-45.2.1.json': reportOf('45.2.1', passing) })
    const result = start()
    expect(result.out).toContain('2 lost (the reference had it, the run does not):')
    expect(result.out).toContain('  - main: failed (passed in the reference): find in page')
    expect(result.out).toContain('  - declarativeNetRequest: the rule of an extension is not applied (applied in the reference)')
    expect(result.code).toBe(1)
  })

  it('takes the reference of the highest version, and says when it is of another version than the run', () => {
    const older = reportOf('45.0.0', [...passing, { name: 'only in the older one', ok: true }])
    const { dir, start } = setup(reportOf('45.10.0', passing), { 'baseline-electron-45.0.0.json': older, 'baseline-electron-45.2.1.json': reportOf('45.2.1', passing) })
    const result = start()
    expect(result.out).toContain(`reference: ${join(dir, 'baseline-electron-45.2.1.json')}`)
    expect(result.out).toContain('The reference is of another version of Electron')
    expect(result.out).toContain('pnpm compat:baseline writes the reference of 45.10.0')
    expect(result.code).toBe(0)
    // A reference that is named is the one compared with.
    const named = start('--baseline', join(dir, 'baseline-electron-45.0.0.json'))
    expect(named.out).toContain('  - main: no longer made: only in the older one')
    expect(named.code).toBe(1)
  })

  it('reads the first reference of the repository (the principal suite alone, written with Electron 45.0.0)', () => {
    const { start } = setup(reportOf('45.2.1', passing))
    const result = start('--baseline', fileURLToPath(new URL('../../compat/baseline-electron-45.0.0.json', import.meta.url)))
    expect(result.out).toContain('Electron 45.0.0 (Chromium 156.0.8078.48), 1 suite(s), 60 checks')
    expect(result.out).toContain('  - main: no longer made: engine reports a Chromium version')
    expect(result.code).toBe(1)
  })

  it('exits 2 with the reason when the report or the reference is missing or is not a report', () => {
    const noReport = setup(undefined, { 'baseline-electron-45.2.1.json': reportOf('45.2.1', passing) }).start()
    expect(noReport.err).toContain('compat-compare: the report not found:')
    expect(noReport.err).toContain('pnpm test:engine writes it')
    expect(noReport.code).toBe(2)

    const noReference = setup(reportOf('45.2.1', passing)).start()
    expect(noReference.err).toContain('no reference in')
    expect(noReference.code).toBe(2)

    const broken = setup({ checks: [] }, { 'baseline-electron-45.2.1.json': reportOf('45.2.1', passing) }).start()
    expect(broken.err).toContain('compat-compare: the report cannot be read:')
    expect(broken.err).toContain('no engine version')
    expect(broken.code).toBe(2)

    const unknownOption = setup(reportOf('45.2.1', passing)).start('--basline', 'x')
    expect(unknownOption.err).toContain('compat-compare:')
    expect(unknownOption.code).toBe(2)
  })
})

// A reference with a check removed on purpose since, and a check a suite names after the port of its local server.
const removed = 'the Extensions menu entry does the same for the page on screen'
const before = reportOf('45.2.1', [...passing, { name: removed, ok: true }, { name: '127.0.0.1:50697 was filled again', ok: true }])
const after = reportOf('45.2.1', [...passing, { name: '127.0.0.1:52649 was filled again', ok: true }])

describe('pnpm compat:compare --explained', SCRIPT_RUNS, () => {
  it('exits 0 when every check the run no longer makes is explained, and lists each one with its reason', () => {
    const { dir, start } = setup(after, { 'baseline-electron-45.2.1.json': before })
    writeFileSync(join(dir, 'explained.json'), JSON.stringify({ [removed]: 'the entry is removed from the Extensions menu' }))
    const result = start('--explained', join(dir, 'explained.json'))
    expect(result.err).toBe('')
    expect(result.out).toContain(`explained: ${join(dir, 'explained.json')}, 1 check(s)`)
    expect(result.out).toContain(`1 no longer made, and explained:\n  ~ main: no longer made: ${removed}: the entry is removed from the Extensions menu`)
    expect(result.out).toContain('Nothing lost but the 1 check(s) explained')
    // The port of the local server changed between the two runs: the check is the same.
    expect(result.out).not.toContain('was filled again')
    expect(result.code).toBe(0)
  })

  it('exits 1 for a loss the file does not explain, and names the explanations that matched nothing', () => {
    const { dir, start } = setup(after, { 'baseline-electron-45.2.1.json': before })
    writeFileSync(join(dir, 'explained.json'), JSON.stringify({ 'a check renamed long ago': 'renamed' }))
    const result = start('--explained', join(dir, 'explained.json'))
    expect(result.out).toContain(`1 lost (the reference had it, the run does not):\n  - main: no longer made: ${removed}`)
    expect(result.out).toContain('1 explanation(s) match nothing the run lost')
    expect(result.out).toContain('  ? a check renamed long ago')
    expect(result.code).toBe(1)
  })

  it('exits 2 with the reason when the file of explanations is missing or cannot be read', () => {
    const { dir, start } = setup(after, { 'baseline-electron-45.2.1.json': before })
    const missing = start('--explained', join(dir, 'nowhere.json'))
    expect(missing.err).toContain(`compat-compare: the explanations not found: ${join(dir, 'nowhere.json')}`)
    expect(missing.code).toBe(2)

    writeFileSync(join(dir, 'broken.json'), '{ "Cast": ')
    const broken = start('--explained', join(dir, 'broken.json'))
    expect(broken.err).toContain('compat-compare: the explanations cannot be read:')
    expect(broken.code).toBe(2)

    writeFileSync(join(dir, 'reasonless.json'), JSON.stringify({ [removed]: '' }))
    const reasonless = start('--explained', join(dir, 'reasonless.json'))
    expect(reasonless.err).toContain(`compat-compare: the explanations cannot be read: ${join(dir, 'reasonless.json')}: "${removed}" has no reason`)
    expect(reasonless.code).toBe(2)
  })
})

describe('pnpm compat:baseline', SCRIPT_RUNS, () => {
  it('keeps nothing of the reference before that the run did not make, and writes the names without the port', () => {
    const { dir, start } = setup(after, { 'baseline-electron-45.2.1.json': before })
    expect(start('--write').code).toBe(0)
    const written = readFileSync(join(dir, 'baseline-electron-45.2.1.json'), 'utf8')
    expect(written).not.toContain(removed)
    expect(written).toContain('"127.0.0.1:<port> was filled again"')
    expect(written).not.toContain('52649')
  })

  it('with --explained, writes nothing while the run lost a check the file does not explain, and writes the reference once every loss is', () => {
    const run = reportOf('45.2.1', [{ name: 'page loads', ok: true }, { name: '127.0.0.1:52649 was filled again', ok: true }])
    const { dir, start } = setup(run, { 'baseline-electron-45.2.1.json': before })
    const file = join(dir, 'baseline-electron-45.2.1.json')
    const kept = readFileSync(file, 'utf8')
    writeFileSync(join(dir, 'explained.json'), JSON.stringify({ [removed]: 'the entry is removed from the Extensions menu' }))
    const refused = start('--write', '--explained', join(dir, 'explained.json'))
    expect(refused.out).toContain('  - main: no longer made: find in page')
    expect(refused.out).toContain(`Reference not written: the run lost checks that ${join(dir, 'explained.json')} does not explain.`)
    expect(refused.code).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(kept)

    writeFileSync(join(dir, 'explained.json'), JSON.stringify({ [removed]: 'the entry is removed from the Extensions menu', 'find in page': 'moved to its own suite' }))
    const accepted = start('--write', '--explained', join(dir, 'explained.json'))
    expect(accepted.out).toContain('2 no longer made, and explained:')
    expect(accepted.out).toContain(`reference written: ${file}`)
    expect(accepted.code).toBe(0)
    expect(readFileSync(file, 'utf8')).not.toContain('find in page')
  })

  it('writes the reference of the version of the run, without the details, lists the known failures, and the next comparison passes against it', () => {
    const run = reportOf('45.2.1', [{ name: 'page loads', ok: true }, { name: 'dnr.modifyHeaders', ok: false }])
    ;(run.suites.main.checks[0] as Record<string, unknown>)['detail'] = 'http://127.0.0.1:54038/one'
    const { dir, start } = setup(run)
    const written = start('--write')
    expect(written.code).toBe(0)
    expect(written.out).toContain(`reference written: ${join(dir, 'baseline-electron-45.2.1.json')}`)
    expect(written.out).toContain('1 check(s) failed in this run and are recorded as known failures:\n    main: dnr.modifyHeaders')
    const file = join(dir, 'baseline-electron-45.2.1.json')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('54038')
    const again = start()
    expect(again.out).toContain('Nothing lost')
    expect(again.code).toBe(0)
  })
})
